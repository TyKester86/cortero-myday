/**
 * Subscription radar + safe-to-spend, computed from stored transactions.
 *
 * Recurring detection: group by normalized merchant; at least 3 charges
 * (2 for yearly); 80%+ of the gaps fit one cadence window; amounts within
 * 25% of the median; and still active (last seen within 1.5 cadences).
 */
import type { Cadence, DateStr, Recurring, SafeToSpend } from '@myday/shared';
import { addDays, daysBetween } from '../dates.js';

export interface TxnLite {
  date: DateStr;
  name: string;
  merchant: string;
  amount: number;
  pending: boolean;
}

const WINDOWS: Array<{ cadence: Cadence; min: number; max: number; days: number; perMonth: number }> = [
  { cadence: 'weekly', min: 6, max: 8, days: 7, perMonth: 52 / 12 },
  { cadence: 'biweekly', min: 13, max: 16, days: 14, perMonth: 26 / 12 },
  { cadence: 'monthly', min: 27, max: 33, days: 30, perMonth: 1 },
  { cadence: 'yearly', min: 355, max: 375, days: 365, perMonth: 1 / 12 },
];

export function normalizeMerchant(t: Pick<TxnLite, 'merchant' | 'name'>): string {
  return (t.merchant || t.name)
    .toLowerCase()
    .replace(/[#*][\w-]*/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z&.' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Recurring flows in one direction: 'out' = charges (amount > 0), 'in' = deposits (amount < 0). */
export function detectRecurring(txns: TxnLite[], direction: 'out' | 'in', today: DateStr): Recurring[] {
  const groups = new Map<string, { label: string; items: TxnLite[] }>();
  for (const t of txns) {
    if (t.pending) continue;
    if (direction === 'out' ? t.amount <= 0 : t.amount >= 0) continue;
    const key = normalizeMerchant(t);
    if (!key) continue;
    const g = groups.get(key) ?? { label: t.merchant || t.name, items: [] };
    g.items.push(t);
    groups.set(key, g);
  }

  const out: Recurring[] = [];
  for (const { label, items } of groups.values()) {
    const sorted = [...items].sort((a, b) => (a.date < b.date ? -1 : 1));
    const gaps = sorted.slice(1).map((t, i) => daysBetween(sorted[i]?.date ?? t.date, t.date));
    if (!gaps.length) continue;
    const win = WINDOWS.find((w) => {
      const fit = gaps.filter((g) => g >= w.min && g <= w.max).length;
      return fit / gaps.length >= 0.8 && sorted.length >= (w.cadence === 'yearly' ? 2 : 3);
    });
    if (!win) continue;
    const amounts = sorted.map((t) => Math.abs(t.amount));
    const med = median(amounts);
    if (!amounts.every((a) => Math.abs(a - med) <= med * 0.25)) continue;
    const last = sorted[sorted.length - 1];
    if (!last) continue;
    const typical = win.cadence === 'monthly' || win.cadence === 'yearly' ? win.days : Math.round(median(gaps));
    if (daysBetween(last.date, today) > typical * 1.5) continue; // stopped
    const next = win.cadence === 'monthly' ? sameDayNextMonth(last.date) : addDays(last.date, typical);
    out.push({
      merchant: label,
      amount: round2(med),
      cadence: win.cadence,
      lastDate: last.date,
      nextDate: next,
      monthly: round2(med * win.perMonth),
      count: sorted.length,
    });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}

function sameDayNextMonth(d: DateStr): DateStr {
  const [y, m, day] = d.split('-').map(Number);
  const year = (y ?? 0) + ((m ?? 1) === 12 ? 1 : 0);
  const month = ((m ?? 1) % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day ?? 1, last)).padStart(2, '0')}`;
}

/** Step a recurring item forward from its next date through `until` (exclusive). */
function occurrences(r: Recurring, from: DateStr, until: DateStr): DateStr[] {
  const out: DateStr[] = [];
  let d = r.nextDate;
  for (let guard = 0; guard < 60 && d < until; guard++) {
    if (d >= from) out.push(d);
    d = r.cadence === 'monthly' ? sameDayNextMonth(d) : addDays(d, r.cadence === 'weekly' ? 7 : r.cadence === 'biweekly' ? 14 : 365);
  }
  return out;
}

/**
 * Safe to spend = checking balance − recurring charges due before the next
 * paycheck (or the next 14 days when no paycheck is detected).
 */
export function safeToSpend(checking: number, subs: Recurring[], income: Recurring[], today: DateStr): SafeToSpend {
  const nextPay = income
    .flatMap((i) => occurrences(i, addDays(today, 1), addDays(today, 60)))
    .sort()[0];
  const until = nextPay ?? addDays(today, 14);
  const upcoming = subs
    .flatMap((s) => occurrences(s, today, until).map((date) => ({ merchant: s.merchant, amount: s.amount, date })))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const due = upcoming.reduce((sum, u) => sum + u.amount, 0);
  return {
    amount: round2(checking - due),
    checking: round2(checking),
    upcoming,
    until,
    basis: nextPay ? 'paycheck' : '14-days',
  };
}
