/**
 * JP4, live world context — consent first (migrations/065_location.sql).
 *
 * Location sharing is per member and OFF until someone turns it on: a grown-up for themselves,
 * the parents for a kid. It names exactly who may see it. The kid always sees who sees them, and
 * is told (once) when that changes. Only the member's own device reports where it is.
 *
 * What Hana says is coarse: "home" (within ~250 m of the family's place) or "about 3 km from
 * home", with when — and only to someone on that member's list. Location history is memory (C9):
 * kept a few days, inspectable and deletable by the member, and by the parents for a kid.
 */
import type { HouseholdMember, LocationSeen, LocationSettings } from '@myday/shared';
import { pool } from '../../db.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';
import { place } from './house.js';

const HOME_M = 250;
const MIN_GAP_MS = 60_000;

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const r = (d: number): number => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};
const ago = (d: Date, now = new Date()): string => {
  const m = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

interface Row {
  member_id: number;
  sharing: boolean;
  viewers: number[];
  keep_days: number;
  set_by: number | null;
  updated_at: Date;
}

async function settingsRow(memberId: number): Promise<Row> {
  const { rows } = await pool.query<Row>('SELECT member_id, sharing, viewers, keep_days, set_by, updated_at FROM location_sharing WHERE member_id = $1', [memberId]);
  return rows[0] ?? { member_id: memberId, sharing: false, viewers: [], keep_days: 7, set_by: null, updated_at: new Date(0) };
}

/** Who may change a member's sharing: a grown-up for themselves; the parents for a kid. */
async function canManage(me: HouseholdMember, memberId: number): Promise<HouseholdMember> {
  const target = (await listMembers()).find((m) => m.id === memberId);
  if (!target) throw new HttpError(404, 'Not found');
  if (me.id === target.id && me.kind === 'adult') return target;
  if (me.kind === 'adult' && target.kind === 'kid') return target;
  throw new HttpError(403, me.kind === 'kid' ? 'Your grown-ups set location sharing for you — you can always see who sees you' : 'Each grown-up sets their own location sharing');
}

export async function settingsFor(memberId: number): Promise<LocationSettings> {
  const r = await settingsRow(memberId);
  const names = new Map((await listMembers()).map((m) => [m.id, m.name]));
  const { rows } = await pool.query<{ n: number; last: Date | null }>('SELECT count(*)::int AS n, max(at) AS last FROM location_points WHERE member_id = $1', [memberId]);
  return {
    memberId,
    member: names.get(memberId) ?? '?',
    sharing: r.sharing,
    viewers: r.viewers.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) as string })),
    keepDays: r.keep_days,
    setBy: r.set_by === null ? null : (names.get(r.set_by) ?? null),
    updatedAt: r.set_by === null ? null : r.updated_at.toISOString(),
    historyPoints: rows[0]?.n ?? 0,
    lastAt: rows[0]?.last?.toISOString() ?? null,
  };
}

export async function setSharing(me: HouseholdMember, memberId: number, sharing: boolean, viewers: number[], keepDays: number): Promise<LocationSettings> {
  await canManage(me, memberId);
  const members = await listMembers();
  if (viewers.some((id) => id === memberId || !members.some((m) => m.id === id))) throw new HttpError(400, 'Pick people in this household (not themselves)');
  if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 30) throw new HttpError(400, 'Keep history 1 to 30 days');
  if (sharing && !viewers.length) throw new HttpError(400, 'Pick who can see it');
  await pool.query(
    `INSERT INTO location_sharing (member_id, sharing, viewers, keep_days, set_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (member_id) DO UPDATE SET sharing = $2, viewers = $3, keep_days = $4, set_by = $5, updated_at = $6`,
    [memberId, sharing, sharing ? [...new Set(viewers)] : [], keepDays, me.id, new Date()],
  );
  // Off means off: nothing more is kept, and what's older than the window goes.
  await purge(memberId);
  return settingsFor(memberId);
}

async function purge(memberId: number): Promise<void> {
  const r = await settingsRow(memberId);
  // The app's clock, not the database's (they can differ; the app's is the one the family lives on).
  await pool.query('DELETE FROM location_points WHERE member_id = $1 AND at < $2', [memberId, new Date(Date.now() - r.keep_days * 86_400_000)]);
}

/** The member's own device reports in. Only while sharing is on; at most once a minute. */
export async function ping(me: HouseholdMember, lat: number, lon: number, accuracy: number | null): Promise<{ kept: boolean }> {
  const r = await settingsRow(me.id);
  if (!r.sharing) throw new HttpError(409, 'Location sharing is off — nothing was kept');
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new HttpError(400, 'That isn’t a place on the map');
  const { rows } = await pool.query<{ at: Date }>('SELECT at FROM location_points WHERE member_id = $1 ORDER BY at DESC LIMIT 1', [me.id]);
  if (rows[0] && Date.now() - rows[0].at.getTime() < MIN_GAP_MS) return { kept: false };
  await pool.query('INSERT INTO location_points (member_id, lat, lon, accuracy_m, at) VALUES ($1, round($2::numeric, 5), round($3::numeric, 5), $4, $5)', [me.id, lat, lon, accuracy === null ? null : Math.round(accuracy), new Date()]);
  await purge(me.id);
  return { kept: true };
}

/** Where the people this viewer may see are — coarse, with when. Nobody else. */
export async function seenBy(me: HouseholdMember, now = new Date()): Promise<LocationSeen[]> {
  const { rows } = await pool.query<{ member_id: number }>('SELECT member_id FROM location_sharing WHERE sharing AND $1 = ANY(viewers)', [me.id]);
  if (!rows.length) return [];
  const names = new Map((await listMembers()).map((m) => [m.id, m.name]));
  const home = await place();
  const out: LocationSeen[] = [];
  for (const r of rows) {
    const { rows: pts } = await pool.query<{ lat: string; lon: string; at: Date }>('SELECT lat, lon, at FROM location_points WHERE member_id = $1 ORDER BY at DESC LIMIT 1', [r.member_id]);
    const p = pts[0];
    const name = names.get(r.member_id);
    if (!name) continue;
    if (!p) {
      out.push({ memberId: r.member_id, member: name, where: 'no location yet', home: null, kmFromHome: null, lat: null, lon: null, at: null, ago: null });
      continue;
    }
    const pt = { lat: Number(p.lat), lon: Number(p.lon) };
    const d = home ? km(pt, home) : null;
    const atHome = d === null ? null : d * 1000 <= HOME_M;
    out.push({
      memberId: r.member_id,
      member: name,
      where: atHome === null ? 'location shared (set the family’s place to say “home”)' : atHome ? 'home' : `about ${d !== null && d < 10 ? d.toFixed(1) : Math.round(d as number)} km from home`,
      home: atHome,
      kmFromHome: d === null ? null : Math.round(d * 10) / 10,
      lat: pt.lat,
      lon: pt.lon,
      at: p.at.toISOString(),
      ago: ago(p.at, now),
    });
  }
  return out;
}

/** A member's history: theirs to see, and the parents' for a kid. */
async function canSeeHistory(me: HouseholdMember, memberId: number): Promise<void> {
  if (me.id === memberId) return;
  const target = (await listMembers()).find((m) => m.id === memberId);
  if (!target) throw new HttpError(404, 'Not found');
  if (me.kind === 'adult' && target.kind === 'kid') return;
  throw new HttpError(403, 'Only they can see their own location history');
}

export async function history(me: HouseholdMember, memberId: number): Promise<Array<{ id: number; lat: number; lon: number; at: string }>> {
  await canSeeHistory(me, memberId);
  await purge(memberId);
  const { rows } = await pool.query<{ id: number; lat: string; lon: string; at: Date }>('SELECT id, lat, lon, at FROM location_points WHERE member_id = $1 ORDER BY at DESC LIMIT 500', [memberId]);
  return rows.map((r) => ({ id: r.id, lat: Number(r.lat), lon: Number(r.lon), at: r.at.toISOString() }));
}

export async function forgetHistory(me: HouseholdMember, memberId: number, pointId: number | null): Promise<number> {
  await canSeeHistory(me, memberId);
  const { rowCount } = await pool.query(pointId === null ? 'DELETE FROM location_points WHERE member_id = $1' : 'DELETE FROM location_points WHERE member_id = $1 AND id = $2', pointId === null ? [memberId] : [memberId, pointId]);
  return rowCount ?? 0;
}

/** Told once, to the kid, whenever their sharing changes: who can see them now. */
export async function disclosures(): Promise<Array<{ key: string; to: number; text: string }>> {
  const members = await listMembers();
  const names = new Map(members.map((m) => [m.id, m.name]));
  const { rows } = await pool.query<Row>('SELECT member_id, sharing, viewers, keep_days, set_by, updated_at FROM location_sharing WHERE set_by IS NOT NULL AND set_by <> member_id');
  return rows
    .filter((r) => members.some((m) => m.id === r.member_id && m.kind === 'kid'))
    .map((r) => ({
      key: `location:told:${r.member_id}:${r.updated_at.toISOString()}`,
      to: r.member_id,
      text: r.sharing
        ? `${names.get(r.set_by as number) ?? 'A grown-up'} turned on location sharing for you. ${r.viewers.map((id) => names.get(id)).filter(Boolean).join(' and ')} can see about where you are. You can check this any time in Settings.`
        : `${names.get(r.set_by as number) ?? 'A grown-up'} turned off location sharing for you — nobody can see where you are.`,
    }));
}
