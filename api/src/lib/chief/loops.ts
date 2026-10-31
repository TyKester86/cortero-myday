/**
 * C4: open loops. Every commitment — ours or theirs — with what, who owes it, by when, and where
 * it came from. Sources: a grown-up's chat (Hana proposes, they confirm), added by hand, MyDay's
 * calendar ("permission slip due", "bring the check"), and mail (what a message commits us to).
 *
 * A loop closes only on evidence — a parent marks it, or a reply from the one who owed it
 * arrives (said plainly, and a parent can reopen it) — never on Hana's assumption. Past its date it stays open and ages,
 * visibly; the brief leads with the ones about to break, and the monthly report keeps the ledger.
 *
 * Who sees what: parents see the family's loops and their own private ones (opened from their own
 * chat, theirs until shared); a child sees only loops they owe or that are about them.
 */
import type { DateStr, HanaLoop, HanaLoopLedger, HouseholdMember } from '@myday/shared';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';
import { scheduleFor } from './tools.js';
import type { Viewer } from './scope.js';

export type LoopSource = HanaLoop['source'];

interface Row {
  id: number;
  what: string;
  owed_by_member: number | null;
  owed_by_name: string | null;
  ours: boolean;
  about_member: number | null;
  due: DateStr | null;
  source: LoopSource;
  source_ref: string | null;
  opened_by: number | null;
  private: boolean;
  closed_at: Date | null;
  closed_by: number | null;
  closed_evidence: string | null;
  created_at: Date;
}
const COLS = 'id, what, owed_by_member, owed_by_name, ours, about_member, due::text AS due, source, source_ref, opened_by, private, closed_at, closed_by, closed_evidence, created_at';

const SOURCE_LABEL: Record<LoopSource, string> = { chat: 'From a chat with Hana', manual: 'Added by hand', calendar: 'MyDay calendar', email: 'Forwarded mail', document: 'Papers' };
const daysBetween = (a: DateStr, b: DateStr): number => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const weekday = (d: DateStr): string => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });

function toLoop(r: Row, members: HouseholdMember[], me: HouseholdMember): HanaLoop {
  const name = (id: number | null): string | null => (id === null ? null : (members.find((m) => m.id === id)?.name ?? null));
  const t = today();
  const open = r.closed_at === null;
  const past = open && r.due !== null && r.due < t ? daysBetween(r.due, t) : 0;
  return {
    id: r.id,
    what: r.what,
    owedBy: name(r.owed_by_member) ?? r.owed_by_name ?? 'Someone',
    owedByUs: r.ours,
    mine: r.owed_by_member === me.id,
    about: name(r.about_member),
    due: r.due,
    source: r.source,
    sourceLabel: SOURCE_LABEL[r.source],
    private: r.private,
    open,
    breaking: !open || r.due === null ? null : r.due < t ? 'past' : r.due === t ? 'today' : r.due === addDays(t, 1) ? 'tomorrow' : null,
    daysPast: past,
    openedAt: r.created_at.toISOString(),
    closedAt: r.closed_at?.toISOString() ?? null,
    closedBy: name(r.closed_by),
    evidence: r.closed_evidence,
  };
}

/** What this viewer may see, as SQL (parents: family + their own private; a child: theirs, never private). */
function scopeSql(v: Viewer, first: number): { where: string; args: unknown[] } {
  return v.parent
    ? { where: `(NOT private OR opened_by = $${first})`, args: [v.me.id] }
    : { where: `NOT private AND (owed_by_member = $${first} OR about_member = $${first})`, args: [v.me.id] };
}

export async function loopsFor(v: Viewer, opts: { closedSince?: DateStr } = {}): Promise<HanaLoop[]> {
  const s = scopeSql(v, 1);
  const closed = opts.closedSince ? ` OR (closed_at IS NOT NULL AND closed_at >= $2::date)` : '';
  const { rows } = await pool.query<Row>(
    `SELECT ${COLS} FROM open_loops WHERE ${s.where} AND (closed_at IS NULL${closed}) ORDER BY closed_at IS NOT NULL, due NULLS LAST, id`,
    opts.closedSince ? [...s.args, opts.closedSince] : s.args,
  );
  const members = await listMembers();
  return rows.map((r) => toLoop(r, members, v.me));
}

export interface LoopInput {
  what: string;
  /** "me", a household member's name, or anyone else ("the school"). */
  owedBy: string;
  about?: string | null;
  due?: DateStr | null;
  source: LoopSource;
  sourceRef?: string | null;
  private?: boolean;
}

/** Open a loop (or, for a detected source item already tracked, return the existing one). */
export async function openLoop(opener: HouseholdMember | null, i: LoopInput): Promise<HanaLoop | null> {
  const what = i.what.trim().slice(0, 200);
  if (!what) throw new HttpError(400, 'Say what the loop is');
  const members = await listMembers();
  const owner = /^(me|i|myself)$/i.test(i.owedBy.trim()) ? opener : (members.find((m) => m.name.toLowerCase() === i.owedBy.trim().toLowerCase()) ?? null);
  const about = i.about ? (members.find((m) => m.name.toLowerCase() === i.about?.trim().toLowerCase()) ?? null) : null;
  const ownerName = owner ? null : i.owedBy.trim().slice(0, 80) || 'Someone';
  const { rows } = await pool.query<Row>(
    `INSERT INTO open_loops (what, owed_by_member, owed_by_name, ours, about_member, due, source, source_ref, opened_by, private, created_at)
     VALUES ($1, $2, $3, $10, $4, $5, $6, $7, $8, $9, $11)
     ON CONFLICT (household_id, source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
     RETURNING ${COLS}`,
    [what, owner?.id ?? null, ownerName, about?.id ?? null, i.due ?? null, i.source, i.sourceRef ?? null, opener?.id ?? null, !!i.private, !!owner || /^(the family|us|we|our family)$/i.test(i.owedBy.trim()), new Date()],
  );
  if (!rows[0]) return null;
  return opener ? toLoop(rows[0], members, opener) : null;
}

async function visibleRow(v: Viewer, id: number): Promise<Row> {
  const s = scopeSql(v, 2);
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM open_loops WHERE id = $1 AND ${s.where}`, [id, ...s.args]);
  if (!rows[0]) throw new HttpError(404, 'Not found');
  return rows[0];
}

/** A parent closes a loop — the evidence is that they said so, in their name. */
export async function closeLoop(v: Viewer, id: number, note: unknown): Promise<HanaLoop> {
  if (!v.parent) throw new HttpError(403, 'A grown-up closes loops');
  const r = await visibleRow(v, id);
  if (r.closed_at) throw new HttpError(409, 'That one is already closed');
  const why = typeof note === 'string' && note.trim() ? `: ${note.trim().slice(0, 140)}` : '';
  const { rows } = await pool.query<Row>(
    `UPDATE open_loops SET closed_at = $2, closed_by = $3, closed_evidence = $4 WHERE id = $1 AND closed_at IS NULL RETURNING ${COLS}`,
    [id, new Date(), v.me.id, `Marked done by ${v.me.name}${why}`],
  );
  if (!rows[0]) throw new HttpError(409, 'That one is already closed');
  return toLoop(rows[0], await listMembers(), v.me);
}

/** A loop from a source item (a document) closes on that item's own evidence — in the parent's name. */
export async function closeLoopByRef(sourceRef: string, by: HouseholdMember, evidence: string): Promise<void> {
  await pool.query('UPDATE open_loops SET closed_at = $2, closed_by = $3, closed_evidence = $4 WHERE source_ref = $1 AND closed_at IS NULL', [sourceRef, new Date(), by.id, evidence]);
}

/** Closed on the wrong evidence (a reply that wasn't the form): open again. */
export async function reopenLoop(v: Viewer, id: number): Promise<HanaLoop> {
  if (!v.parent) throw new HttpError(403, 'A grown-up reopens loops');
  await visibleRow(v, id);
  const { rows } = await pool.query<Row>(`UPDATE open_loops SET closed_at = NULL, closed_by = NULL, closed_evidence = NULL WHERE id = $1 RETURNING ${COLS}`, [id]);
  return toLoop(rows[0] as Row, await listMembers(), v.me);
}

/** Share a private loop with the other parent (or take it back). */
export async function shareLoop(v: Viewer, id: number, shared: boolean): Promise<HanaLoop> {
  const r = await visibleRow(v, id);
  if (r.opened_by !== v.me.id) throw new HttpError(403, 'Only the one who opened it chooses who sees it');
  const { rows } = await pool.query<Row>(`UPDATE open_loops SET private = $2 WHERE id = $1 RETURNING ${COLS}`, [id, !shared]);
  return toLoop(rows[0] as Row, await listMembers(), v.me);
}

/* ---------- detection: app sources ---------- */

/** Calendar titles that are commitments, not just plans. */
const COMMITMENT = /\b(bring|turn in|hand in|sign(?:ed)?|return|pay|rsvp|due|deadline|deposit|permission slip|form|register|sign[- ]up|order)\b/i;

/** MyDay calendar items in the next two weeks that commit someone to something become loops (once each). */
export async function detectCalendarLoops(v: Viewer): Promise<number> {
  const t = today();
  const f = await scheduleFor(v, t, addDays(t, 14));
  let n = 0;
  for (const e of f.data) {
    if (e.eventId < 0 || !COMMITMENT.test(e.title)) continue; // connected calendars stay theirs; MyDay's own only
    const who = e.people[0] ?? null;
    const made = await openLoop(v.me, {
      what: e.title,
      owedBy: who ?? 'the family',
      about: who,
      due: e.date,
      source: 'calendar',
      sourceRef: `cal:${e.eventId}:${e.date}`,
    });
    if (made) n++;
  }
  return n;
}

/** Evidence from mail: a reply from the one who owed it closes their loop (and says so — a parent can reopen it). */
export async function closeOnReply(fromAddr: string, at: Date): Promise<number> {
  const domain = fromAddr.match(/@([\w.-]+)/)?.[1]?.toLowerCase();
  if (!domain) return 0;
  const { rowCount } = await pool.query(
    `UPDATE open_loops SET closed_at = $2, closed_evidence = $3
      WHERE closed_at IS NULL AND source = 'email' AND source_ref LIKE $1`,
    [`mail:${domain}:them:%`, at, `A reply from ${domain} arrived ${at.toISOString().slice(0, 10)} — reopen it if that wasn’t it`],
  );
  return rowCount ?? 0;
}

/* ---------- the brief, the watch, the report ---------- */

/** "Avery’s permission slip — due tomorrow". Gentle words: a date and how long, never a scolding. */
export function loopLine(l: HanaLoop, forKid: boolean): string {
  const who = forKid ? '' : l.owedByUs ? `${l.owedBy}: ` : `Waiting on ${l.owedBy}: `;
  const when =
    l.breaking === 'past'
      ? `was due ${weekday(l.due as DateStr)}, still open (${l.daysPast} day${l.daysPast === 1 ? '' : 's'})`
      : l.breaking === 'today'
        ? 'due today'
        : l.breaking === 'tomorrow'
          ? 'due tomorrow'
          : l.due
            ? `due ${weekday(l.due)}`
            : 'no date yet';
  return `${who}${l.what} — ${when}`;
}

/** The month's ledger: opened, closed on time, broken (closed after its date, or still open past it). */
export async function loopLedger(v: Viewer, month: string): Promise<HanaLoopLedger> {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  const s = scopeSql(v, 3);
  const { rows } = await pool.query<Row>(
    `SELECT ${COLS} FROM open_loops WHERE ${s.where} AND ((created_at >= $1::date AND created_at < $2::date) OR (due >= $1::date AND due < $2::date)) ORDER BY due NULLS LAST, id`,
    [start, next, ...s.args],
  );
  const members = await listMembers();
  const t = today();
  const loops = rows.map((r) => ({ r, l: toLoop(r, members, v.me) }));
  const closedOnTime = loops.filter(({ r }) => r.closed_at && (!r.due || r.closed_at.toISOString().slice(0, 10) <= r.due)).length;
  const broken = loops.filter(({ r }) => r.due && r.due < t && (!r.closed_at || r.closed_at.toISOString().slice(0, 10) > r.due));
  return {
    opened: loops.filter(({ r }) => r.created_at.toISOString().slice(0, 10) >= start && r.created_at.toISOString().slice(0, 10) < next).length,
    closedOnTime,
    broken: broken.map(({ r, l }) => ({
      what: `${l.owedByUs ? `${l.owedBy}: ` : `${l.owedBy} (theirs): `}${l.what}`,
      due: r.due as DateStr,
      // What the break cost, as a fact: how long it went past its date.
      cost: r.closed_at
        ? `closed ${daysBetween(r.due as DateStr, r.closed_at.toISOString().slice(0, 10) as DateStr)} day(s) after its date`
        : `still open ${daysBetween(r.due as DateStr, t)} day(s) after its date`,
    })),
  };
}
