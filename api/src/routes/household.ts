/**
 * Household admin (grown-ups only): roster add / edit / remove (archive) /
 * restore, roles (kid or adult + XP level table), invites for other adults,
 * and the kid devices that remember kids for PIN sign-in. Kid PIN management
 * itself lives in auth.ts and is wired into this page's UI.
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type {
  HouseholdAdminResponse,
  InviteCreated,
  KidDevice,
  MemberKind,
  RosterMember,
  XpTrack,
} from '@myday/shared';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { HttpError, idParam, int, str } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';
import { currentDevice, deviceLabel, hashToken, rememberKidOnDevice } from '../auth.js';
import { logEvent } from '../lib/events.js';

export const householdRouter = Router();

const TRACKS: readonly XpTrack[] = ['leader', 'woman', 'student', 'kid'];
const INVITE_DAYS = 14;

interface RosterRow {
  id: number;
  key: string;
  name: string;
  kind: MemberKind;
  age: number | null;
  xp_track: XpTrack;
  email: string | null;
  archived: boolean;
  has_pin: boolean;
  inv_created: Date | null;
  inv_accepted: Date | null;
  inv_expires: Date | null;
}

async function adminView(
  meId: number,
  req: Parameters<typeof currentDevice>[0],
  thisDeviceId: number | null = null,
): Promise<HouseholdAdminResponse> {
  const { rows } = await pool.query<RosterRow>(
    `SELECT m.id, m.key, m.name, m.kind, m.age, m.xp_track, m.email, (m.archived_at IS NOT NULL) AS archived,
            (m.pin_hash IS NOT NULL) AS has_pin, i.created_at AS inv_created, i.accepted_at AS inv_accepted,
            i.expires_at AS inv_expires
       FROM household_members m
       LEFT JOIN LATERAL (SELECT created_at, accepted_at, expires_at FROM invites
                           WHERE member_id = m.id AND revoked_at IS NULL ORDER BY id DESC LIMIT 1) i ON true
      ORDER BY (m.archived_at IS NOT NULL), m.sort_order, m.id`,
  );
  const members = rows.map(
    (r): RosterMember => ({
      id: r.id,
      key: r.key,
      name: r.name,
      kind: r.kind,
      age: r.age,
      xpTrack: r.xp_track,
      email: r.email,
      archived: r.archived,
      hasPin: r.has_pin,
      isYou: r.id === meId,
      invite: r.inv_created
        ? {
            status: r.inv_accepted ? 'accepted' : r.inv_expires && r.inv_expires < new Date() ? 'expired' : 'pending',
            sentAt: r.inv_created.toISOString(),
          }
        : null,
    }),
  );
  const thisDevice = thisDeviceId ?? (await currentDevice(req));
  const { rows: devs } = await pool.query<{ id: number; label: string; last_seen_at: Date; kids: string[] | null }>(
    `SELECT d.id, d.label, d.last_seen_at, array_agg(m.name ORDER BY m.sort_order) FILTER (WHERE m.id IS NOT NULL) AS kids
       FROM kid_devices d
       LEFT JOIN kid_device_members dm ON dm.device_id = d.id
       LEFT JOIN household_members m ON m.id = dm.member_id
      WHERE d.revoked_at IS NULL GROUP BY d.id ORDER BY d.last_seen_at DESC`,
  );
  const devices = devs.map(
    (d): KidDevice => ({
      id: d.id,
      label: d.label,
      kids: d.kids ?? [],
      lastSeenAt: d.last_seen_at.toISOString(),
      isThisDevice: d.id === thisDevice,
    }),
  );
  return { members, devices };
}

householdRouter.get('/api/household/admin', async (req, res) => {
  const me = requireAdult(req);
  res.json(await adminView(me.id, req));
});

function parseEmail(v: unknown): string | null {
  const s = str(v, 'email', 120).toLowerCase();
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, 'That email address looks wrong');
  return s;
}

function parseTrack(v: unknown, kind: MemberKind): XpTrack {
  if (v === undefined || v === null || v === '') return kind === 'kid' ? 'kid' : 'leader';
  const t = TRACKS.find((x) => x === v);
  if (!t) throw new HttpError(400, `xpTrack must be one of ${TRACKS.join(', ')}`);
  return t;
}

/** Same key rule as the script's apiHouseholdAdd (lowercase, no spaces), made unique. */
async function freeKey(name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'member';
  for (let i = 1; ; i++) {
    const key = i === 1 ? base : `${base}${i}`;
    const { rows } = await pool.query('SELECT 1 FROM household_members WHERE key = $1', [key]);
    if (!rows.length) return key;
  }
}

/** Emails are unique across ALL households: an email decides which household you sign into. */
async function emailTaken(email: string, exceptId: number | null): Promise<boolean> {
  const { rows } = await asSystem(() =>
    pool.query('SELECT 1 FROM household_members WHERE lower(email) = $1 AND id IS DISTINCT FROM $2', [email, exceptId]),
  );
  return rows.length > 0;
}

householdRouter.post('/api/household/members', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const name = str(b.name, 'name', 40, true);
  const kind: MemberKind = b.kind === 'kid' ? 'kid' : 'adult';
  const email = parseEmail(b.email);
  if (email && (await emailTaken(email, null))) throw new HttpError(409, 'Someone already uses that email');
  await pool.query(
    `INSERT INTO household_members (key, name, kind, age, email, xp_track, school, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM household_members))`,
    [await freeKey(name), name, kind, b.age === null || b.age === undefined || b.age === '' ? null : int(b.age, 'age', 0, 120), email, parseTrack(b.xpTrack, kind), str(b.school, 'school', 120) || null],
  );
  res.status(201).json(await adminView(me.id, req));
});

householdRouter.patch('/api/household/members/:id', async (req, res) => {
  const me = requireAdult(req);
  const id = idParam(req.params.id);
  const b = req.body as Record<string, unknown>;
  const { rows } = await pool.query<{ name: string; kind: MemberKind; age: number | null; email: string | null; xp_track: XpTrack }>(
    'SELECT name, kind, age, email, xp_track FROM household_members WHERE id = $1',
    [id],
  );
  const cur = rows[0];
  if (!cur) throw new HttpError(404, 'No such member');
  const kind: MemberKind = b.kind === undefined ? cur.kind : b.kind === 'kid' ? 'kid' : 'adult';
  if (id === me.id && kind !== 'adult') throw new HttpError(409, "You can't make yourself a kid (you'd lock yourself out)");
  const email = b.email === undefined ? cur.email : parseEmail(b.email);
  if (email && (await emailTaken(email, id))) throw new HttpError(409, 'Someone already uses that email');
  const track = b.xpTrack === undefined ? (kind !== cur.kind ? parseTrack(undefined, kind) : cur.xp_track) : parseTrack(b.xpTrack, kind);
  await pool.query(
    `UPDATE household_members SET name = $2, kind = $3, age = $4, email = $5, xp_track = $6,
       -- a kid PIN means nothing for a grown-up: drop it (and its sessions)
       pin_hash = CASE WHEN $3 = 'adult' THEN NULL ELSE pin_hash END,
       pin_version = CASE WHEN $3 = 'adult' AND pin_hash IS NOT NULL THEN pin_version + 1 ELSE pin_version END,
       school = CASE WHEN $7::text IS NULL THEN school ELSE NULLIF($7, '') END
     WHERE id = $1`,
    [
      id,
      b.name === undefined ? cur.name : str(b.name, 'name', 40, true),
      kind,
      b.age === undefined ? cur.age : b.age === null || b.age === '' ? null : int(b.age, 'age', 0, 120),
      email,
      track,
      b.school === undefined ? null : str(b.school, 'school', 120),
    ],
  );
  res.json(await adminView(me.id, req));
});

/** Remove = archive: their history and points stay, they can't sign in, they vanish from lists. */
householdRouter.post('/api/household/members/:id/archive', async (req, res) => {
  const me = requireAdult(req);
  const id = idParam(req.params.id);
  if (id === me.id) throw new HttpError(409, "You can't remove yourself");
  const { rows } = await pool.query<{ kind: MemberKind }>('SELECT kind FROM household_members WHERE id = $1 AND archived_at IS NULL', [id]);
  if (!rows[0]) throw new HttpError(404, 'No such member');
  await pool.query('UPDATE household_members SET archived_at = now() WHERE id = $1', [id]);
  await pool.query('UPDATE invites SET revoked_at = now() WHERE member_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [id]);
  res.json(await adminView(me.id, req));
});

householdRouter.post('/api/household/members/:id/restore', async (req, res) => {
  const me = requireAdult(req);
  await pool.query('UPDATE household_members SET archived_at = NULL WHERE id = $1', [idParam(req.params.id)]);
  res.json(await adminView(me.id, req));
});

/**
 * Invite another grown-up: puts them on the roster with their email (which
 * is what lets their Google account in) and returns a link to send them.
 * The link is shown once; only its hash is stored. Re-inviting the same
 * email issues a fresh link and revokes the old one.
 */
householdRouter.post('/api/household/invites', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  // Inviting someone already on the roster (e.g. added by name) links them, no duplicate.
  const rosterId = b.memberId === undefined || b.memberId === null || b.memberId === '' ? null : idParam(b.memberId);
  const rosterName = rosterId ? (await pool.query<{ name: string }>('SELECT name FROM household_members WHERE id = $1', [rosterId])).rows[0]?.name : undefined;
  if (rosterId && !rosterName) throw new HttpError(404, 'No such household member');
  const name = rosterName ?? str(b.name, 'name', 40, true);
  const email = parseEmail(b.email);
  if (!email) throw new HttpError(400, 'An email is required to invite someone');
  const track = parseTrack(b.xpTrack, 'adult');
  if (track === 'kid') throw new HttpError(400, 'Invites are for grown-ups; kids use a PIN');

  const { rows: existing } = await pool.query<{ id: number; kind: MemberKind; archived: boolean }>(
    rosterId
      ? 'SELECT id, kind, (archived_at IS NOT NULL) AS archived FROM household_members WHERE id = $2 AND ($1::text IS NOT NULL)'
      : 'SELECT id, kind, (archived_at IS NOT NULL) AS archived FROM household_members WHERE lower(email) = $1',
    rosterId ? [email, rosterId] : [email],
  );
  let memberId: number;
  const ex = existing[0];
  // Someone who already belongs to another household can still be invited: accepting asks
  // them to confirm leaving theirs. Their email stays on the invite (not on a second member
  // row) so signing in normally can't land them in the wrong household.
  const elsewhere = !ex && (await emailTaken(email, null));
  if (ex) {
    if (ex.kind !== 'adult' || ex.archived) throw new HttpError(409, 'That email belongs to someone who can’t be invited');
    memberId = ex.id;
    await pool.query('UPDATE invites SET revoked_at = now() WHERE member_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [memberId]);
  } else {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO household_members (key, name, kind, email, xp_track, sort_order)
       VALUES ($1, $2, 'adult', $3, $4, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM household_members)) RETURNING id`,
      [await freeKey(name), name, elsewhere ? null : email, track],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('member insert returned nothing');
    memberId = id;
  }
  const token = randomBytes(24).toString('base64url');
  await pool.query(
    `INSERT INTO invites (member_id, email, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int))`,
    [memberId, email, hashToken(token), req.user?.id ?? null, INVITE_DAYS],
  );
  await logEvent('invite_sent', { track }, me.id);
  const view = await adminView(me.id, req);
  const member = view.members.find((m) => m.id === memberId);
  if (!member) throw new Error('invited member missing');
  const out: InviteCreated = { link: `${config.publicUrl}/join/${token}`, member };
  res.status(201).json(out);
});

householdRouter.delete('/api/household/invites/:memberId', async (req, res) => {
  const me = requireAdult(req);
  await pool.query('UPDATE invites SET revoked_at = now() WHERE member_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [
    idParam(req.params.memberId),
  ]);
  res.json(await adminView(me.id, req));
});

/* ---------- kid devices ---------- */

/** Set up THIS browser as a kid sign-in device for the chosen kids. */
householdRouter.post('/api/household/devices/this', async (req, res) => {
  const me = requireAdult(req);
  const ids = (req.body as { memberIds?: unknown }).memberIds;
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Pick at least one kid');
  let deviceId: number | null = null;
  for (const raw of ids) {
    const id = idParam(raw);
    const { rows } = await pool.query("SELECT 1 FROM household_members WHERE id = $1 AND kind = 'kid' AND archived_at IS NULL", [id]);
    if (!rows.length) throw new HttpError(400, 'Only kids can be added to a device');
    deviceId = await rememberKidOnDevice(req, res, id, deviceLabel(req.headers['user-agent']), deviceId);
  }
  res.json(await adminView(me.id, req, deviceId));
});

householdRouter.delete('/api/household/devices/:id', async (req, res) => {
  const me = requireAdult(req);
  await pool.query('UPDATE kid_devices SET revoked_at = now() WHERE id = $1', [idParam(req.params.id)]);
  res.json(await adminView(me.id, req));
});
