/**
 * H9 — the family needle, measured from Hana's own log (hana_items) and the family's
 * records, and the monthly report: parents only, and it says where Hana was wrong in
 * the same document as her wins.
 */
import type { DateStr, HanaFamilyReport } from '@myday/shared';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import { logEvent } from '../events.js';
import { scheduleFor } from './tools.js';
import { requireParent, type Viewer } from './scope.js';

export type FamilyReport = HanaFamilyReport;

const pct = (n: number, d: number): number | null => (d ? Math.round((100 * n) / d) : null);

export async function familyReport(v: Viewer, month: string): Promise<FamilyReport> {
  requireParent(v, 'The family report');
  const start = `${month}-01` as DateStr;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01` as DateStr;
  const t = today();
  const until = (next <= t ? addDays(next, -1) : addDays(t, -1)) as DateStr;

  const { rows: hw } = await pool.query<{ due: number; ontime: number }>(
    `SELECT count(*)::int AS due, count(*) FILTER (WHERE done AND done_on <= due)::int AS ontime
       FROM homework h JOIN household_members m ON m.id = h.member_id
      WHERE m.kind = 'kid' AND h.due >= $1 AND h.due <= $2`,
    [start, until],
  );
  const pickups = until >= start ? (await scheduleFor(v, start, until)).data.filter((e) => e.pickup) : [];
  const unowned = pickups.filter((e) => !e.pickupBy).length;
  const { rows: watch } = await pool.query<{ n: number }>(
    `SELECT count(DISTINCT item_key)::int AS n FROM hana_items WHERE surface IN ('watch', 'escalation') AND shown_on >= $1 AND shown_on < $2 AND outcome IS NULL AND shown_on < $3`,
    [start, next, t],
  );
  const { rows: br } = await pool.query<{ shown: number; acted: number }>(
    `SELECT count(*)::int AS shown, count(*) FILTER (WHERE outcome = 'acted')::int AS acted FROM hana_items WHERE surface LIKE 'brief_%' AND shown_on >= $1 AND shown_on < $2`,
    [start, next],
  );
  const { rows: nd } = await pool.query<{ category: string; shown: number; dismissed: number }>(
    `SELECT category, count(*)::int AS shown, count(*) FILTER (WHERE outcome = 'dismissed')::int AS dismissed
       FROM hana_items WHERE surface = 'nudge' AND shown_on >= $1 AND shown_on < $2 GROUP BY category ORDER BY category`,
    [start, next],
  );
  const { rows: wrong } = await pool.query<{ shown_on: DateStr; surface: string; text: string; source: string }>(
    `SELECT shown_on::text AS shown_on, surface, text, source FROM hana_items WHERE outcome = 'wrong' AND shown_on >= $1 AND shown_on < $2 ORDER BY shown_on, id`,
    [start, next],
  );
  const h = hw[0] ?? { due: 0, ontime: 0 };
  const b = br[0] ?? { shown: 0, acted: 0 };
  const nShown = nd.reduce((s, r) => s + r.shown, 0);
  const nDismissed = nd.reduce((s, r) => s + r.dismissed, 0);
  const missed = unowned + (watch[0]?.n ?? 0);
  const wins: string[] = [];
  if (h.due) wins.push(`${h.ontime} of ${h.due} homework assignments were done on time (${pct(h.ontime, h.due)}%).`);
  if (pickups.length) wins.push(`${pickups.length - unowned} of ${pickups.length} pickups had someone on them.`);
  if (b.shown) wins.push(`${b.acted} brief item${b.acted === 1 ? ' was' : 's were'} acted on.`);
  await logEvent('hana_report', { month, wrong: wrong.length }, v.me.id);
  return {
    month,
    homework: { due: h.due, onTime: h.ontime, rate: pct(h.ontime, h.due) },
    logistics: { unownedPickups: unowned, watchUnhandled: watch[0]?.n ?? 0, missed },
    briefs: { shown: b.shown, acted: b.acted, rate: pct(b.acted, b.shown) },
    nudges: { shown: nShown, dismissed: nDismissed, byCategory: nd },
    wins,
    wrong: wrong.map((w) => ({ date: w.shown_on, surface: w.surface, text: w.text, source: w.source })),
  };
}
