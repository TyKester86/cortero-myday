import type { Request } from 'express';
import type { HouseholdMember, MemberKind } from '@myday/shared';
import { pool, type Db } from '../db.js';
import { HttpError } from './http.js';

interface MemberRow {
  id: number;
  key: string;
  name: string;
  kind: MemberKind;
  age: number | null;
}

const COLS = 'id, key, name, kind, age';

function toMember(r: MemberRow): HouseholdMember {
  return { id: r.id, key: r.key, name: r.name, kind: r.kind, age: r.age };
}

export async function listMembers(db: Db = pool): Promise<HouseholdMember[]> {
  const { rows } = await db.query<MemberRow>(
    `SELECT ${COLS} FROM household_members WHERE archived_at IS NULL ORDER BY sort_order, id`,
  );
  return rows.map(toMember);
}

export async function memberById(id: number, db: Db = pool): Promise<HouseholdMember | null> {
  const { rows } = await db.query<MemberRow>(`SELECT ${COLS} FROM household_members WHERE id = $1`, [id]);
  return rows[0] ? toMember(rows[0]) : null;
}

export async function memberByKey(key: string, db: Db = pool): Promise<HouseholdMember | null> {
  const { rows } = await db.query<MemberRow>(`SELECT ${COLS} FROM household_members WHERE key = $1 AND archived_at IS NULL`, [
    key.trim().toLowerCase(),
  ]);
  return rows[0] ? toMember(rows[0]) : null;
}

/** The household member the signed-in user is (set by requireAuth). */
export function self(req: Request): HouseholdMember {
  const m = req.member;
  if (!m) throw new HttpError(403, 'Your account is not linked to a household member yet');
  return m;
}

export function requireAdult(req: Request): HouseholdMember {
  const m = self(req);
  if (m.kind !== 'adult') throw new HttpError(403, 'Only grown-ups can do that');
  return m;
}

/**
 * Who may act for whom: yourself, and a grown-up for the household's kids.
 * Never one grown-up for another — partners' days, health and scores are
 * their own.
 */
export function canActFor(me: HouseholdMember, target: HouseholdMember): boolean {
  return target.id === me.id || (me.kind === 'adult' && target.kind === 'kid');
}

/** Which member a request is about: `?member=<key>` or yourself (see canActFor). */
export async function targetMember(req: Request): Promise<HouseholdMember> {
  const me = self(req);
  const key = typeof req.query.member === 'string' ? req.query.member : '';
  if (!key || key === me.key) return me;
  if (me.kind !== 'adult') throw new HttpError(403, 'Kids can only see their own day');
  const m = await memberByKey(key);
  if (!m) throw new HttpError(404, 'No such household member');
  if (!canActFor(me, m)) throw new HttpError(403, 'You can open your own day and your kids’ — not another grown-up’s');
  return m;
}
