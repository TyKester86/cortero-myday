/**
 * Hana reads a forwarded email and suggests what to add to MyDay: bills,
 * calendar events and tasks. Claude when ANTHROPIC_KEY is set; otherwise (and
 * as a fallback when the model fails) simple rules that look for amounts,
 * due dates, dates and times. Nothing is added until a grown-up taps Add.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DateStr } from '@myday/shared';

export type Suggestion =
  | { kind: 'bill'; summary: string; data: { name: string; amount: number; due_day: number | null } }
  | { kind: 'event'; summary: string; data: { title: string; date: DateStr; start_time: string | null } }
  | { kind: 'task'; summary: string; data: { task: string } };

export interface MailIn {
  from: string;
  subject: string;
  text: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** HTML mail → readable text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** "October 12" / "Oct 12, 2026" / "10/12/2026" / "2026-10-12" → a date on or after today. */
function findDate(text: string, today: DateStr): DateStr | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (us) {
    const y = us[3]!.length === 2 ? `20${us[3]}` : us[3]!;
    return `${y}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  }
  const named = text.match(new RegExp(`\\b(${MONTHS.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i'));
  if (named) {
    const m = MONTHS.findIndex((x) => x.startsWith(named[1]!.toLowerCase())) + 1;
    let y = named[3] ? Number(named[3]) : Number(today.slice(0, 4));
    let d = `${y}-${String(m).padStart(2, '0')}-${named[2]!.padStart(2, '0')}`;
    if (!named[3] && d < today) {
      y += 1;
      d = `${y}-${String(m).padStart(2, '0')}-${named[2]!.padStart(2, '0')}`;
    }
    return d;
  }
  return null;
}

function findTime(text: string): string | null {
  const t = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  if (!t) return null;
  let h = Number(t[1]) % 12;
  if (/p/i.test(t[3]!)) h += 12;
  return `${String(h).padStart(2, '0')}:${t[2] ?? '00'}`;
}

const senderName = (from: string): string => (from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? from.split('@')[0] ?? 'Bill').trim();

/** The no-AI reading: good enough for clear bills, appointments and "to do" mail. */
export function ruleSuggestions(m: MailIn, today: DateStr): Suggestion[] {
  const all = `${m.subject}\n${m.text}`;
  const out: Suggestion[] = [];
  const amount = all.match(/\$\s?([\d,]+\.\d{2})/);
  if (amount && /\b(bill|statement|amount due|payment due|balance due|invoice|autopay)\b/i.test(all)) {
    // The first "due …" that has a date ("Amount due: $142" doesn't; "Payment due on Oct 21" does).
    let dueDate: DateStr | null = null;
    for (const d of all.matchAll(/\bdue(?: date)?(?: on| by|:)?\s+([^\n]{3,40})/gi)) {
      dueDate = findDate(d[1] ?? '', today);
      if (dueDate) break;
    }
    const name = senderName(m.from);
    const value = Number(amount[1]!.replace(/,/g, ''));
    out.push({ kind: 'bill', summary: `Track ${name}: $${value.toFixed(2)}${dueDate ? ` due ${dueDate}` : ''}`, data: { name, amount: value, due_day: dueDate ? Number(dueDate.slice(8)) : null } });
    return out;
  }
  const date = findDate(all, today);
  if (date && /\b(appointment|scheduled|reminder|game|practice|conference|meeting|recital|party|event|visit|reservation|confirmed)\b/i.test(all)) {
    const start = findTime(all);
    const title = m.subject.replace(/^(re|fwd?):\s*/gi, '').slice(0, 120) || 'Event';
    out.push({ kind: 'event', summary: `Add “${title}” to the calendar on ${date}${start ? ` at ${start}` : ''}`, data: { title, date, start_time: start } });
    return out;
  }
  const subject = m.subject.replace(/^(re|fwd?):\s*/gi, '').trim() || 'a forwarded email';
  out.push({ kind: 'task', summary: `Add a task: Look at “${subject}”`, data: { task: `Look at: ${subject}`.slice(0, 200) } });
  return out;
}

const PROMPT = (today: DateStr): string => `You read an email that someone in a family forwarded to their assistant. Today is ${today}.
Suggest what to add to their family app. Return JSON only:
{"items":[{"kind":"bill","name":"...","amount":12.34,"due_day":15|null}
 |{"kind":"event","title":"...","date":"YYYY-MM-DD","start_time":"HH:MM"|null}
 |{"kind":"task","task":"..."}]}
Rules: a bill = something to pay (amount and day of month due). An event = something happening at a date (appointment, game, conference, party). A task = something they need to do. At most 5 items. If nothing is useful, return {"items":[]}. Never invent amounts or dates that are not in the email.`;

let client: Anthropic | null | undefined;
function claude(): Anthropic | null {
  if (client !== undefined) return client;
  const k = process.env.ANTHROPIC_KEY ?? '';
  client = k ? new Anthropic({ apiKey: k, maxRetries: 2, timeout: 45_000 }) : null;
  return client;
}

function validate(raw: unknown): Suggestion[] {
  const items = (raw as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: Suggestion[] = [];
  for (const it of items.slice(0, 5) as Array<Record<string, unknown>>) {
    if (it.kind === 'bill' && typeof it.name === 'string' && typeof it.amount === 'number' && it.amount >= 0) {
      const due = typeof it.due_day === 'number' && it.due_day >= 1 && it.due_day <= 31 ? Math.round(it.due_day) : null;
      out.push({ kind: 'bill', summary: `Track ${it.name}: $${it.amount.toFixed(2)}${due ? ` due on the ${due}` : ''}`, data: { name: it.name.slice(0, 60), amount: it.amount, due_day: due } });
    } else if (it.kind === 'event' && typeof it.title === 'string' && typeof it.date === 'string' && DATE.test(it.date)) {
      const st = typeof it.start_time === 'string' && TIME.test(it.start_time) ? it.start_time : null;
      out.push({ kind: 'event', summary: `Add “${it.title}” to the calendar on ${it.date}${st ? ` at ${st}` : ''}`, data: { title: it.title.slice(0, 120), date: it.date, start_time: st } });
    } else if (it.kind === 'task' && typeof it.task === 'string' && it.task.trim()) {
      out.push({ kind: 'task', summary: `Add a task: ${it.task.slice(0, 160)}`, data: { task: it.task.slice(0, 200) } });
    }
  }
  return out;
}

export async function suggestFromEmail(m: MailIn, today: DateStr): Promise<Suggestion[]> {
  const c = claude();
  if (!c) return ruleSuggestions(m, today);
  try {
    const res = await c.beta.messages.create({
      model: process.env.SCREEN_MODEL || process.env.CHAT_MODEL || 'claude-opus-5-5',
      max_tokens: 800,
      system: PROMPT(today),
      messages: [{ role: 'user', content: `From: ${m.from}\nSubject: ${m.subject}\n\n${m.text.slice(0, 12_000)}` }],
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const items = validate(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
    return items.length ? items : ruleSuggestions(m, today);
  } catch (e) {
    console.error('email reading: model unavailable', e instanceof Error ? e.message : e);
    return ruleSuggestions(m, today);
  }
}
