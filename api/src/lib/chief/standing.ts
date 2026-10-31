/**
 * Q10, C3 Tier 3: standing authority (migrations/068_standing.sql) — the last rung, and earned.
 *
 * A parent may grant a narrow, NAMED class; each is granted and revoked on its own, and every
 * exercise is logged (hana_actions, origin 'standing') and counted in the parents' report.
 * A class is grantable only when THIS household's own record for it is proven boring: at least
 * RECORD_MIN approved-as-drafted uses in the last 90 days, no failures in the last 30, and few
 * discards. Until then the grant button says exactly what's missing.
 *
 * Never a class (no override): moving or spending money (Universal Capability amendment), and
 * anything that sends outside the family. Nothing here widens a child's reach — only a
 * grown-up's own request or the house at night (on the granting parent's authority).
 */
import type { HouseholdMember, StandingClass, StandingClassView, StandingRecord } from '@myday/shared';
import { pool } from '../../db.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';

export const RECORD_MIN = 10;
const MAX_DISCARD = 0.2;

interface ClassDef {
  key: StandingClass;
  label: string;
  detail: string;
  /** The T1/T2 tools whose approved record earns it (and, for a grown-up's request, that it runs without asking). */
  tools: string[];
  /** For house_control: only these actions count toward — and are covered by — the class. */
  actions?: string[];
}

export const CLASSES: ClassDef[] = [
  {
    key: 'groceries_to_list',
    label: 'Add groceries to the shared list when a grown-up asks',
    detail: 'Only the household grocery list — nothing is bought or sent to a store.',
    tools: ['add_grocery_items'],
  },
  {
    key: 'lock_up_at_night',
    label: 'Lock up at night',
    detail: 'After quiet hours begin: lock a door left unlocked and close a garage left open. Never unlocks, opens or disarms.',
    tools: ['house_control'],
    actions: ['lock', 'close'],
  },
];

/** The rail no tier overrides: these never become standing authority. */
export const NEVER_STANDING = ['send_groceries', 'run_errand', 'hold_want', 'draft_email', 'draft_invite', 'draft_message_reply', 'draft_note', 'log_refill'];
const MONEY = /pay|transfer|purchase|checkout|money|buy|spend|order/i;

export const classDef = (key: string): ClassDef => {
  const c = CLASSES.find((x) => x.key === key);
  if (!c || MONEY.test(key)) throw new HttpError(400, MONEY.test(key) ? 'Moving or spending money is never standing authority — it always takes your OK that time' : 'That isn’t a class Hana can be given');
  return c;
};

/** This household's record for a class: approved-as-drafted uses, edits, discards, failures. */
export async function recordFor(c: ClassDef, now = new Date()): Promise<StandingRecord> {
  const since90 = new Date(now.getTime() - 90 * 86_400_000);
  const since30 = new Date(now.getTime() - 30 * 86_400_000);
  const actionOk = c.actions ? "AND input->>'action' = ANY($3)" : '';
  const args: unknown[] = [c.tools, since90, ...(c.actions ? [c.actions] : [])];
  const { rows } = await pool.query<{ status: string; edited: boolean; created_at: Date; origin: string }>(
    `SELECT status, edited, created_at, origin FROM hana_actions WHERE tool = ANY($1) AND created_at >= $2 AND origin <> 'standing' ${actionOk}`,
    args,
  );
  const decided = rows.filter((r) => r.status !== 'pending');
  const approvedAsIs = decided.filter((r) => r.status === 'done' && !r.edited).length;
  const edited = decided.filter((r) => r.status === 'done' && r.edited).length;
  const discarded = decided.filter((r) => r.status === 'cancelled').length;
  const failedRecent = decided.filter((r) => r.status === 'failed' && r.created_at >= since30).length;
  const discardRate = decided.length ? discarded / decided.length : 0;
  const missing: string[] = [];
  if (approvedAsIs < RECORD_MIN) missing.push(`${RECORD_MIN - approvedAsIs} more approved as she drafted them`);
  if (failedRecent) missing.push(`no failures for 30 days (there ${failedRecent === 1 ? 'was 1' : `were ${failedRecent}`})`);
  if (discardRate > MAX_DISCARD) missing.push(`fewer discards (${Math.round(discardRate * 100)}% now; at most ${MAX_DISCARD * 100}%)`);
  return { approvedAsIs, edited, discarded, failedRecent, eligible: !missing.length, missing };
}

async function activeGrant(key: StandingClass): Promise<{ id: number; granted_by: number | null } | null> {
  const { rows } = await pool.query<{ id: number; granted_by: number | null }>('SELECT id, granted_by FROM standing_grants WHERE class = $1 AND revoked_at IS NULL', [key]);
  return rows[0] ?? null;
}

export async function standingView(): Promise<StandingClassView[]> {
  const names = new Map((await listMembers()).map((m) => [m.id, m.name]));
  const out: StandingClassView[] = [];
  for (const c of CLASSES) {
    const { rows } = await pool.query<{ id: number; granted_by: number | null; granted_at: Date }>('SELECT id, granted_by, granted_at FROM standing_grants WHERE class = $1 AND revoked_at IS NULL', [c.key]);
    const g = rows[0];
    const { rows: used } = await pool.query<{ n: number; last: Date | null }>("SELECT count(*)::int AS n, max(created_at) AS last FROM hana_actions WHERE origin = 'standing' AND tool = ANY($1) AND input->>'class' = $2", [c.tools, c.key]);
    out.push({
      key: c.key,
      label: c.label,
      detail: c.detail,
      record: await recordFor(c),
      granted: g ? { by: g.granted_by === null ? null : (names.get(g.granted_by) ?? null), at: g.granted_at.toISOString() } : null,
      used: used[0]?.n ?? 0,
      lastUsed: used[0]?.last?.toISOString() ?? null,
    });
  }
  return out;
}

export async function grant(me: HouseholdMember, key: string): Promise<StandingClassView[]> {
  if (me.kind !== 'adult') throw new HttpError(403, 'Only a grown-up grants standing authority');
  const c = classDef(key);
  const r = await recordFor(c);
  if (!r.eligible) throw new HttpError(409, `Not yet — “${c.label}” is earned by this family’s own record: ${r.missing.join('; ')}.`);
  await pool.query('INSERT INTO standing_grants (class, granted_by, granted_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [c.key, me.id, new Date()]);
  return standingView();
}

/** Either parent revokes, at once. */
export async function revoke(me: HouseholdMember, key: string): Promise<StandingClassView[]> {
  if (me.kind !== 'adult') throw new HttpError(403, 'Only a grown-up changes standing authority');
  const c = classDef(key);
  await pool.query('UPDATE standing_grants SET revoked_by = $2, revoked_at = $3 WHERE class = $1 AND revoked_at IS NULL', [c.key, me.id, new Date()]);
  return standingView();
}

/** May this exact action run under standing authority? (A grown-up's own request, or the house at night.) */
export async function covers(tool: string, input: Record<string, unknown>, actor: HouseholdMember | null): Promise<StandingClass | null> {
  if (NEVER_STANDING.includes(tool)) return null;
  for (const c of CLASSES) {
    if (!c.tools.includes(tool)) continue;
    if (c.actions && !c.actions.includes(String(input.action ?? ''))) continue;
    if (c.key === 'groceries_to_list' && actor?.kind !== 'adult') continue;
    if (await activeGrant(c.key)) return c.key;
  }
  return null;
}

/** Log one exercise in the parents' log (forever), as T3. */
export async function logExercise(memberId: number, tool: string, input: Record<string, unknown>, cls: StandingClass, summary: string, status: 'done' | 'failed', result: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO hana_actions (member_id, tool, input, summary, status, result, origin, decided_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'standing', $7, $7) RETURNING id",
    [memberId, tool, JSON.stringify({ ...input, class: cls }), summary, status, result, new Date()],
  );
  return rows[0]?.id ?? 0;
}

/** The parents' report: every use of standing authority this month. */
export async function standingReport(from: Date, to: Date): Promise<Array<{ class: string; summary: string; result: string; at: string }>> {
  const { rows } = await pool.query<{ input: Record<string, unknown>; summary: string; result: string; created_at: Date }>(
    "SELECT input, summary, result, created_at FROM hana_actions WHERE origin = 'standing' AND created_at >= $1 AND created_at < $2 ORDER BY created_at",
    [from, to],
  );
  return rows.map((r) => ({ class: String(r.input.class ?? ''), summary: r.summary, result: r.result, at: r.created_at.toISOString() }));
}

export { activeGrant };
