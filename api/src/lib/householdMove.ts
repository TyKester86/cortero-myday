/**
 * Moving people and households, without ever orphaning anyone's data.
 *
 *   absorbMember(src, dst)        every row that points at member `src` now
 *                                 points at member `dst`; `src` is removed.
 *   mergeHouseholds(src, dst, map) everything in household `src` (members,
 *                                 kids, chores, history…) moves into `dst`;
 *                                 people in `map` are folded into the matching
 *                                 member of `dst`; `src` is then deleted.
 *
 * Tables and member references are discovered from the database (every
 * household_id column, every foreign key to household_members), so new
 * features are covered automatically. Where a row can't move because the
 * target already has its own version (e.g. both people logged a check-in on
 * the same day), the target's row is kept and the duplicate dropped — and the
 * report says so. Runs in one transaction, system scope.
 */
import type pg from 'pg';
import type { MergePreview } from '@myday/shared';
import { asSystem, pool, tx } from '../db.js';
import { HttpError } from './http.js';

const rawQuery = <R extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<pg.QueryResult<R>> => pool.query<R>(sql, params);

export interface MoveReport {
  moved: Record<string, number>;
  /** Rows dropped because the target already had the same record. */
  dropped: Record<string, number>;
  membersMoved: string[];
  membersMerged: Array<{ from: string; into: string }>;
}

const emptyReport = (): MoveReport => ({ moved: {}, dropped: {}, membersMoved: [], membersMerged: [] });

async function memberRefs(c: pg.PoolClient): Promise<Array<{ tbl: string; col: string }>> {
  const { rows } = await c.query<{ tbl: string; col: string }>(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'household_members'::regclass`,
  );
  return rows;
}

async function householdTables(c: pg.PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'household_id' AND table_name <> 'households'
      ORDER BY (table_name = 'household_members') DESC, table_name`,
  );
  return rows.map((r) => r.t);
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/** UPDATE tbl SET col = to WHERE col = from — row by row on conflict, dropping the duplicate. */
async function repoint(c: pg.PoolClient, tbl: string, col: string, from: number, to: number, report: MoveReport): Promise<void> {
  await c.query('SAVEPOINT repoint');
  try {
    const r = await c.query(`UPDATE ${q(tbl)} SET ${q(col)} = $2 WHERE ${q(col)} = $1`, [from, to]);
    await c.query('RELEASE SAVEPOINT repoint');
    if (r.rowCount) report.moved[tbl] = (report.moved[tbl] ?? 0) + r.rowCount;
    return;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT repoint');
    if ((e as { code?: string }).code !== '23505') throw e;
  }
  const { rows } = await c.query<{ ctid: string }>(`SELECT ctid::text AS ctid FROM ${q(tbl)} WHERE ${q(col)} = $1`, [from]);
  for (const { ctid } of rows) {
    await c.query('SAVEPOINT one');
    try {
      await c.query(`UPDATE ${q(tbl)} SET ${q(col)} = $2 WHERE ctid = $1::tid`, [ctid, to]);
      await c.query('RELEASE SAVEPOINT one');
      report.moved[tbl] = (report.moved[tbl] ?? 0) + 1;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT one');
      if ((e as { code?: string }).code !== '23505') throw e;
      await c.query(`DELETE FROM ${q(tbl)} WHERE ctid = $1::tid`, [ctid]);
      report.dropped[tbl] = (report.dropped[tbl] ?? 0) + 1;
    }
  }
}

async function absorbIn(c: pg.PoolClient, src: number, dst: number, report: MoveReport): Promise<void> {
  if (src === dst) return;
  const { rows } = await c.query<{ id: number; name: string; household_id: number }>('SELECT id, name, household_id FROM household_members WHERE id = ANY($1)', [[src, dst]]);
  const s = rows.find((r) => r.id === src);
  const d = rows.find((r) => r.id === dst);
  if (!s || !d) throw new Error('absorbMember: member not found');
  for (const { tbl, col } of await memberRefs(c)) {
    if (tbl === 'household_members') continue;
    await repoint(c, tbl, col, src, dst, report);
  }
  // Rows that belonged to the person now live in the target household.
  for (const t of await householdTables(c)) {
    if (t === 'household_members') continue;
    const refs = (await memberRefs(c)).filter((r) => r.tbl === t).map((r) => r.col);
    for (const col of refs) await c.query(`UPDATE ${q(t)} SET household_id = $2 WHERE ${q(col)} = $1 AND household_id <> $2`, [dst, d.household_id]);
  }
  // Keep the person's email (sign-in) and PIN if the target row has none.
  const { rows: srcRow } = await c.query<{ email: string | null; pin_hash: string | null; age: number | null }>('SELECT email, pin_hash, age FROM household_members WHERE id = $1', [src]);
  await c.query('UPDATE household_members SET email = NULL WHERE id = $1', [src]);
  await c.query('UPDATE household_members SET email = COALESCE(email, $2), pin_hash = COALESCE(pin_hash, $3), age = COALESCE(age, $4) WHERE id = $1', [
    dst, srcRow[0]?.email ?? null, srcRow[0]?.pin_hash ?? null, srcRow[0]?.age ?? null,
  ]);
  await c.query('DELETE FROM household_members WHERE id = $1', [src]);
  report.membersMerged.push({ from: s.name, into: d.name });
}

async function begin(c: pg.PoolClient): Promise<void> {
  await c.query("SELECT set_config('app.merging', 'on', true)");
}

export function absorbMember(src: number, dst: number): Promise<MoveReport> {
  return asSystem(() =>
    tx(async (c) => {
      await begin(c);
      const report = emptyReport();
      await absorbIn(c, src, dst, report);
      return report;
    }),
  );
}

/** Move a household into another; `map` folds source members into existing target members. */
export function mergeHouseholds(src: number, dst: number, map: Map<number, number> = new Map()): Promise<MoveReport> {
  if (src === dst) throw new Error('mergeHouseholds: same household');
  return asSystem(() =>
    tx(async (c) => {
      await begin(c);
      const report = emptyReport();
      for (const [from, to] of map) await absorbIn(c, from, to, report);
      // Remaining people move as they are; a clashing key (e.g. two "kayla"s) gets a suffix.
      const { rows: people } = await c.query<{ id: number; key: string; name: string }>('SELECT id, key, name FROM household_members WHERE household_id = $1', [src]);
      for (const p of people) {
        let key = p.key;
        for (let n = 2; (await c.query('SELECT 1 FROM household_members WHERE household_id = $1 AND key = $2', [dst, key])).rowCount; n++) key = `${p.key}${n}`;
        await c.query('UPDATE household_members SET household_id = $2, key = $3 WHERE id = $1', [p.id, dst, key]);
        report.membersMoved.push(p.name);
        report.moved.household_members = (report.moved.household_members ?? 0) + 1;
      }
      for (const t of await householdTables(c)) {
        if (t === 'household_members') continue;
        await repoint(c, t, 'household_id', src, dst, report);
      }
      await c.query('DELETE FROM households WHERE id = $1', [src]);
      return report;
    }),
  );
}

/** What's in a household (for previews and the "no real data" check). */
export async function householdContents(id: number): Promise<{ members: Array<{ id: number; name: string; kind: string }>; rows: Record<string, number> }> {
  return asSystem(() =>
    tx(async (c) => {
      const { rows: members } = await c.query<{ id: number; name: string; kind: string }>(
        'SELECT id, name, kind FROM household_members WHERE household_id = $1 AND archived_at IS NULL ORDER BY kind, id',
        [id],
      );
      const out: Record<string, number> = {};
      for (const t of await householdTables(c)) {
        if (t === 'household_members') continue;
        const { rows } = await c.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${q(t)} WHERE household_id = $1`, [id]);
        if (rows[0]?.n) out[t] = rows[0].n;
      }
      return { members, rows: out };
    }),
  );
}

/** Bookkeeping tables that don't count as "real data" in a fresh, unused household. */
const NOT_DATA = new Set(['events', 'idempotency_keys', 'invites', 'app_settings', 'notification_prefs', 'notification_log', 'kid_devices', 'kid_device_members', 'kid_signins']);

export function hasRealData(rows: Record<string, number>): boolean {
  return Object.entries(rows).some(([t, n]) => n > 0 && !NOT_DATA.has(t));
}

/** Same name + same kind = the same person (e.g. Kayla added by Ty, and Kayla who signed up alone). */
export async function planMerge(from: number, into: number): Promise<{ preview: MergePreview; map: Map<number, number> }> {
  if (from === into) throw new HttpError(400, 'Pick a different household');
  const hh = await asSystem(() => rawQuery<{ id: number; name: string }>('SELECT id, name FROM households WHERE id = ANY($1)', [[from, into]]));
  const f = hh.rows.find((h) => h.id === from);
  const t = hh.rows.find((h) => h.id === into);
  if (!f || !t) throw new HttpError(404, 'No such household');
  const src = await householdContents(from);
  const dst = await householdContents(into);
  const map = new Map<number, number>();
  const folding: MergePreview['folding'] = [];
  const moving: MergePreview['moving'] = [];
  for (const m of src.members) {
    const same = dst.members.find((d) => d.kind === m.kind && d.name.trim().toLowerCase() === m.name.trim().toLowerCase());
    if (same) {
      map.set(m.id, same.id);
      folding.push({ name: m.name, into: same.name });
    } else moving.push({ name: m.name, kind: m.kind });
  }
  return { preview: { from: { id: f.id, name: f.name }, into: { id: t.id, name: t.name }, moving, folding, rows: src.rows }, map };
}

