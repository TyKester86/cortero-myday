/**
 * C9: memory that compounds (migrations/061_household_memory.sql). Hana keeps two kinds of memory:
 * a person's own (what they told her — theirs alone) and the household memory — sizes, preferences,
 * teachers and contacts, school facts, medical basics the family entered, what worked last time.
 *
 * Parents inspect, correct and forget all of the household memory and their kids' own memories;
 * another grown-up's own memory stays theirs. A kid's Hana sees only what is about that kid —
 * siblings never inherit each other's. Nothing carries across households (RLS), and it dies with
 * the household and with the member it is about. Secrets are refused at the door, whoever writes.
 */
import type { FamilyMemory, FamilyMemoryKind, FamilyMemoryView, HouseholdMember } from '@myday/shared';
import { FAMILY_MEMORY_KINDS } from '@myday/shared';
import { pool } from '../../db.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';

export const MEMORY_KINDS = FAMILY_MEMORY_KINDS.map((k) => k.kind) as [FamilyMemoryKind, ...FamilyMemoryKind[]];
const HOUSEHOLD_CAP = 400;

const SECRETS: Array<[RegExp, string]> = [
  [/\b\d{3}-\d{2}-\d{4}\b/, 'a Social Security number'],
  [/(?:\d[ -]?){12,19}/, 'a card or account number'],
  [/\b(?:password|passcode|pin|cvv|security code|routing number|account number|ssn|social security number)\b\s*(?:is|:|=|#)\s*\S/i, 'a password or account detail'],
];

/** Hana never keeps secrets — a number or password that looks like one is refused, said plainly. */
export function checkFact(fact: string): void {
  for (const [re, what] of SECRETS) if (re.test(fact)) throw new HttpError(400, `That looks like ${what} — Hana doesn’t keep those. Leave it out and save the rest.`);
}

interface Row {
  id: number;
  member_id: number;
  fact: string;
  kind: FamilyMemoryKind;
  shared: boolean;
  about_member_id: number | null;
  via: 'typed' | 'hana';
  created_at: Date;
  updated_at: Date | null;
  updated_by: number | null;
}
const COLS = 'id, member_id, fact, kind, shared, about_member_id, via, created_at, updated_at, updated_by';

function toMemory(r: Row, names: Map<number, string>): FamilyMemory {
  const about = r.shared ? r.about_member_id : r.member_id;
  return {
    id: r.id,
    fact: r.fact,
    kind: r.kind,
    shared: r.shared,
    aboutId: about,
    aboutName: about === null ? null : (names.get(about) ?? null),
    addedBy: names.get(r.member_id) ?? null,
    via: r.via,
    at: r.created_at.toISOString(),
    correctedBy: r.updated_by === null ? null : (names.get(r.updated_by) ?? null),
    correctedAt: r.updated_at?.toISOString() ?? null,
  };
}

async function nameMap(): Promise<Map<number, string>> {
  const { rows } = await pool.query<{ id: number; name: string }>('SELECT id, name FROM household_members');
  return new Map(rows.map((r) => [r.id, r.name]));
}

export const requireParent = (me: HouseholdMember): void => {
  if (me.kind !== 'adult') throw new HttpError(403, 'The family memory is for grown-ups to keep');
};

/** Who a fact is about, by id (the HQ form) — a member of this household, or null for everyone. */
async function aboutMember(id: number | null): Promise<HouseholdMember | null> {
  if (id === null) return null;
  const m = (await listMembers()).find((x) => x.id === id);
  if (!m) throw new HttpError(400, 'That person isn’t in this household');
  return m;
}

/** …or by name (Hana's tools). */
export async function aboutByName(name: string | null): Promise<number | null> {
  if (name === null || !name.trim() || /^(?:the )?(?:whole )?(?:family|household|everyone|us)$/i.test(name.trim())) return null;
  const m = (await listMembers()).find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!m) throw new HttpError(400, `There’s nobody called ${name} in the household`);
  return m.id;
}

/** The parents' view: the whole household memory, and each kid's own. Never another grown-up's own. */
export async function familyMemoryView(): Promise<FamilyMemoryView> {
  const names = await nameMap();
  const { rows } = await pool.query<Row>(
    `SELECT ${COLS} FROM hana_memories m WHERE shared
        OR member_id IN (SELECT id FROM household_members WHERE kind = 'kid' AND archived_at IS NULL)
      ORDER BY shared DESC, about_member_id NULLS FIRST, kind, id`,
  );
  const kids = (await listMembers()).filter((m) => m.kind === 'kid');
  return {
    household: rows.filter((r) => r.shared).map((r) => toMemory(r, names)),
    kids: kids.map((k) => ({ id: k.id, name: k.name, memories: rows.filter((r) => !r.shared && r.member_id === k.id).map((r) => toMemory(r, names)) })),
  };
}

/** What the household memory says about one person (a kid sees this about themselves, read-only). */
export async function sharedAbout(memberId: number): Promise<FamilyMemory[]> {
  const names = await nameMap();
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM hana_memories WHERE shared AND about_member_id = $1 ORDER BY kind, id`, [memberId]);
  return rows.map((r) => toMemory(r, names));
}

export async function addFamilyMemory(me: HouseholdMember, fact: string, kind: FamilyMemoryKind, aboutId: number | null, via: 'typed' | 'hana'): Promise<FamilyMemory> {
  requireParent(me);
  checkFact(fact);
  await aboutMember(aboutId);
  const { rows: n } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM hana_memories WHERE shared');
  if ((n[0]?.n ?? 0) >= HOUSEHOLD_CAP) throw new HttpError(409, 'The family memory is full — forget a few things first');
  const dupe = await pool.query('SELECT 1 FROM hana_memories WHERE shared AND about_member_id IS NOT DISTINCT FROM $1 AND lower(fact) = lower($2)', [aboutId, fact]);
  if (dupe.rowCount) throw new HttpError(409, 'The family memory already has that');
  const { rows } = await pool.query<Row>(
    `INSERT INTO hana_memories (member_id, fact, kind, shared, about_member_id, via) VALUES ($1, $2, $3, true, $4, $5) RETURNING ${COLS}`,
    [me.id, fact, kind, aboutId, via],
  );
  return toMemory(rows[0] as Row, await nameMap());
}

/** A memory a parent may change: anything in the household memory, or a kid's own. */
export async function editable(me: HouseholdMember, id: number): Promise<Row> {
  requireParent(me);
  const { rows } = await pool.query<Row>(
    `SELECT ${COLS} FROM hana_memories WHERE id = $1
        AND (shared OR member_id IN (SELECT id FROM household_members WHERE kind = 'kid'))`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, `There is no family memory #${id}`);
  return rows[0];
}

export async function correctMemory(
  me: HouseholdMember,
  id: number,
  change: { fact?: string; kind?: FamilyMemoryKind; aboutId?: number | null },
): Promise<{ before: string; after: FamilyMemory }> {
  const r = await editable(me, id);
  if (change.fact !== undefined) checkFact(change.fact);
  if (change.aboutId !== undefined) {
    if (!r.shared) throw new HttpError(400, 'A kid’s own memory stays about them');
    await aboutMember(change.aboutId);
  }
  const { rows } = await pool.query<Row>(
    `UPDATE hana_memories SET fact = COALESCE($2, fact), kind = COALESCE($3, kind),
            about_member_id = CASE WHEN $4 THEN $5 ELSE about_member_id END, updated_at = now(), updated_by = $6
      WHERE id = $1 RETURNING ${COLS}`,
    [id, change.fact ?? null, change.kind ?? null, change.aboutId !== undefined, change.aboutId ?? null, me.id],
  );
  return { before: r.fact, after: toMemory(rows[0] as Row, await nameMap()) };
}

export async function forgetMemory(me: HouseholdMember, id: number): Promise<string> {
  const r = await editable(me, id);
  await pool.query('DELETE FROM hana_memories WHERE id = $1', [id]);
  return r.fact;
}

/** "Forget everything about Avery": the household memory about them, and their own if they're a kid. */
export async function forgetAbout(me: HouseholdMember, memberId: number): Promise<number> {
  requireParent(me);
  const m = await aboutMember(memberId);
  const own = m?.kind === 'kid';
  const { rowCount } = await pool.query(`DELETE FROM hana_memories WHERE (shared AND about_member_id = $1) OR ($2 AND NOT shared AND member_id = $1)`, [memberId, own]);
  return rowCount ?? 0;
}

/** What a kid's tutor is given about them: what helps teaching — never sizes or medical basics. */
const TUTOR_KINDS: FamilyMemoryKind[] = ['preference', 'school', 'contact', 'worked', 'note'];

/**
 * The household memory as Hana's chat context sees it: a parent gets all of it (h-ids, so she can
 * correct or forget one by id); a kid's tutor only what is about that kid and helps the teaching.
 */
export async function memoryContext(me: HouseholdMember): Promise<string> {
  const names = await nameMap();
  const { rows } = await pool.query<Row>(
    me.kind === 'adult'
      ? `SELECT ${COLS} FROM hana_memories WHERE shared ORDER BY about_member_id NULLS FIRST, kind, id LIMIT ${HOUSEHOLD_CAP}`
      : `SELECT ${COLS} FROM hana_memories WHERE shared AND about_member_id = $1 AND kind = ANY($2) ORDER BY kind, id LIMIT 100`,
    me.kind === 'adult' ? [] : [me.id, TUTOR_KINDS],
  );
  if (!rows.length) return '';
  const label = new Map(FAMILY_MEMORY_KINDS.map((k) => [k.kind, k.label.toLowerCase()]));
  const line = (r: Row): string => `#h${r.id} [${r.about_member_id === null ? 'family' : (names.get(r.about_member_id) ?? '?')} · ${label.get(r.kind)}] ${r.fact}`;
  return me.kind === 'adult'
    ? `The family memory (kept by the parents; ids #h): ${rows.map(line).join('; ')}`
    : `What the family memory says about ${me.name}: ${rows.map(line).join('; ')}`;
}
