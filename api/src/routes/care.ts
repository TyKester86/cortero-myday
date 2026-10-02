/**
 * Care Team: tutors, coaches and mental-health providers a family lets in.
 *
 *   - Access is explicit: a grown-up creates a grant for ONE person, picks the
 *     scopes (homework / school / health / day / check-ins), and shares a
 *     one-time invite link. The professional accepts it with a pro profile.
 *   - Revocable at any moment; a revoked grant stops working on the next call.
 *   - Every access (each read of a scope, every note, accept, revoke) is
 *     written to care_access_log, which is append-only in the database.
 *   - Mental-health variant: only an adult can grant it, only for themselves,
 *     check-ins/day only; it's invisible to the rest of the household, and its
 *     notes + log are visible only to that adult and the provider.
 *
 * Professionals need no household: pro routes mount before the household gate
 * and read family data only through an active grant, in that household's scope.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import {
  CARE_KINDS,
  CARE_SCOPES,
  MH_SCOPES,
  type CareGrant,
  type CareGrantDetail,
  type CareKind,
  type CareLogEntry,
  type CareNote,
  type CareScope,
  type HouseholdMember,
  type ProClient,
  type ProProfile,
  type ProScopeData,
} from '@myday/shared';
import { config } from '../config.js';
import { asSystem, inHousehold, pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { memberByKey, requireAdult } from '../lib/members.js';

export const careRouter = Router();
export const proRouter = Router();

const INVITE_DAYS = 7;
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

interface GrantRow {
  id: number;
  household_id: number;
  kind: CareKind;
  subject_member_id: number;
  subject: string;
  subject_key: string;
  scopes: CareScope[];
  status: CareGrant['status'];
  pro: string | null;
  pro_user_id: number | null;
  label: string;
  created_at: Date;
}

const GRANT_SELECT = `SELECT g.id, g.household_id, g.kind, g.subject_member_id, m.name AS subject, m.key AS subject_key, g.scopes, g.status,
    p.display_name AS pro, g.pro_user_id, g.label, g.created_at
  FROM care_grants g JOIN household_members m ON m.id = g.subject_member_id LEFT JOIN pro_profiles p ON p.user_id = g.pro_user_id`;

/** Mental-health grants belong to the consenting adult alone. */
const canSee = (g: GrantRow, me: HouseholdMember): boolean => (g.kind === 'mental_health' ? g.subject_member_id === me.id : me.kind === 'adult');

const toGrant = (g: GrantRow, me: HouseholdMember): CareGrant => ({
  id: g.id,
  kind: g.kind,
  subject: g.subject,
  subjectKey: g.subject_key,
  scopes: g.scopes,
  status: g.status,
  pro: g.pro,
  label: g.label,
  createdAt: g.created_at.toISOString(),
  canSeeNotes: canSee(g, me),
});

async function log(grantId: number, actor: 'pro' | 'family', action: string, who: { proUserId?: number | null; memberId?: number | null }, scope = ''): Promise<void> {
  await pool.query('INSERT INTO care_access_log (grant_id, pro_user_id, member_id, actor, action, scope) VALUES ($1, $2, $3, $4, $5, $6)', [
    grantId, who.proUserId ?? null, who.memberId ?? null, actor, action, scope,
  ]);
}

async function detail(g: GrantRow, viewerPro: boolean): Promise<Omit<CareGrantDetail, 'grant'>> {
  const { rows: notes } = await pool.query<{ id: number; author: string; from_pro: boolean; body: string; created_at: Date }>(
    `SELECT n.id, CASE WHEN n.author = 'pro' THEN COALESCE(p.display_name, 'Provider') ELSE COALESCE(m.name, 'Family') END AS author,
            n.author = 'pro' AS from_pro, n.body, n.created_at
       FROM care_notes n LEFT JOIN care_grants g ON g.id = n.grant_id LEFT JOIN pro_profiles p ON p.user_id = g.pro_user_id
       LEFT JOIN household_members m ON m.id = n.member_id
      WHERE n.grant_id = $1 ORDER BY n.id`,
    [g.id],
  );
  const { rows: lg } = viewerPro
    ? { rows: [] as Array<{ at: Date; actor: 'pro' | 'family'; who: string; action: string; scope: string }> }
    : await pool.query<{ at: Date; actor: 'pro' | 'family'; who: string; action: string; scope: string }>(
        `SELECT l.at, l.actor, COALESCE(p.display_name, m.name, '—') AS who, l.action, l.scope
           FROM care_access_log l LEFT JOIN pro_profiles p ON p.user_id = l.pro_user_id LEFT JOIN household_members m ON m.id = l.member_id
          WHERE l.grant_id = $1 ORDER BY l.id DESC LIMIT 200`,
        [g.id],
      );
  return {
    notes: notes.map((n): CareNote => ({ id: n.id, author: n.author, fromPro: n.from_pro, body: n.body, at: n.created_at.toISOString() })),
    log: lg.map((l): CareLogEntry => ({ at: l.at.toISOString(), actor: l.actor, who: l.who, action: l.action, scope: l.scope })),
  };
}

/* ---------- the family side ---------- */

async function grantsFor(me: HouseholdMember): Promise<CareGrant[]> {
  const { rows } = await pool.query<GrantRow>(`${GRANT_SELECT} ORDER BY g.id DESC`);
  return rows.filter((g) => canSee(g, me)).map((g) => toGrant(g, me));
}

async function ownGrant(me: HouseholdMember, id: number): Promise<GrantRow> {
  const { rows } = await pool.query<GrantRow>(`${GRANT_SELECT} WHERE g.id = $1`, [id]);
  const g = rows[0];
  // Someone else's mental-health grant doesn't exist as far as you can tell.
  if (!g || !canSee(g, me)) throw new HttpError(404, 'No such grant');
  return g;
}

careRouter.get('/api/care', async (req, res) => {
  res.json({ grants: await grantsFor(requireAdult(req)) });
});

careRouter.post('/api/care/grants', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const kind = CARE_KINDS.find((k) => k === b.kind);
  if (!kind) throw new HttpError(400, 'Pick tutor, coach or mental-health provider');
  const subject = typeof b.subject === 'string' ? await memberByKey(b.subject) : null;
  if (!subject) throw new HttpError(404, 'Pick who this is for');
  const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes.filter((s): s is CareScope => CARE_SCOPES.includes(s as CareScope)))] : [];
  if (!scopes.length) throw new HttpError(400, 'Pick at least one thing they may see');
  if (kind === 'mental_health') {
    if (subject.id !== me.id) throw new HttpError(403, 'A mental-health provider can only be added by the adult they’ll work with, for themselves');
    if (scopes.some((s) => !MH_SCOPES.includes(s))) throw new HttpError(400, 'Mental-health access is limited to check-ins and daily tasks');
  }
  const token = randomBytes(24).toString('base64url');
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO care_grants (kind, subject_member_id, granted_by, scopes, invite_hash, invite_expires_at, label)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6::int), $7) RETURNING id`,
    [kind, subject.id, me.id, scopes, hash(token), INVITE_DAYS, str(b.label, 'label', 80)],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('grant insert returned nothing');
  await log(id, 'family', 'granted', { memberId: me.id }, scopes.join(','));
  const g = await ownGrant(me, id);
  res.status(201).json({ ...toGrant(g, me), inviteLink: `${config.publicUrl}/pro?invite=${token}` });
});

careRouter.post('/api/care/grants/:id/revoke', async (req, res) => {
  const me = requireAdult(req);
  const g = await ownGrant(me, idParam(req.params.id));
  if (g.status === 'revoked') throw new HttpError(409, 'Already revoked');
  await pool.query("UPDATE care_grants SET status = 'revoked', revoked_at = now(), invite_hash = NULL WHERE id = $1", [g.id]);
  await log(g.id, 'family', 'revoked', { memberId: me.id });
  res.json({ grants: await grantsFor(me) });
});

careRouter.get('/api/care/grants/:id', async (req, res) => {
  const me = requireAdult(req);
  const g = await ownGrant(me, idParam(req.params.id));
  const out: CareGrantDetail = { grant: toGrant(g, me), ...(await detail(g, false)) };
  res.json(out);
});

careRouter.post('/api/care/grants/:id/notes', async (req, res) => {
  const me = requireAdult(req);
  const g = await ownGrant(me, idParam(req.params.id));
  await pool.query("INSERT INTO care_notes (grant_id, author, member_id, body) VALUES ($1, 'family', $2, $3)", [g.id, me.id, str((req.body as { body?: unknown }).body, 'body', 4000, true)]);
  await log(g.id, 'family', 'note', { memberId: me.id });
  const out: CareGrantDetail = { grant: toGrant(g, me), ...(await detail(g, false)) };
  res.status(201).json(out);
});

/* ---------- the professional side (no household needed) ---------- */

function proUser(req: Request): number {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  return req.user.id;
}

async function profileOf(userId: number): Promise<ProProfile | null> {
  const { rows } = await asSystem(() => pool.query<{ display_name: string; kind: CareKind; credentials: string }>('SELECT display_name, kind, credentials FROM pro_profiles WHERE user_id = $1', [userId]));
  const p = rows[0];
  return p ? { displayName: p.display_name, kind: p.kind, credentials: p.credentials } : null;
}

proRouter.get('/api/pro/me', async (req, res) => {
  res.json({ profile: await profileOf(proUser(req)) });
});

proRouter.put('/api/pro/profile', async (req, res) => {
  const uid = proUser(req);
  const b = req.body as Record<string, unknown>;
  const kind = CARE_KINDS.find((k) => k === b.kind);
  if (!kind) throw new HttpError(400, 'Pick tutor, coach or mental-health provider');
  await asSystem(() =>
    pool.query(
      `INSERT INTO pro_profiles (user_id, display_name, kind, credentials) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, kind = EXCLUDED.kind, credentials = EXCLUDED.credentials`,
      [uid, str(b.displayName, 'displayName', 80, true), kind, str(b.credentials, 'credentials', 200)],
    ),
  );
  res.json({ profile: await profileOf(uid) });
});

async function clientsOf(uid: number): Promise<ProClient[]> {
  const { rows } = await asSystem(() =>
    pool.query<{ id: number; kind: CareKind; household: string; subject: string; scopes: CareScope[] }>(
      `SELECT g.id, g.kind, h.name AS household, m.name AS subject, g.scopes
         FROM care_grants g JOIN households h ON h.id = g.household_id JOIN household_members m ON m.id = g.subject_member_id
        WHERE g.pro_user_id = $1 AND g.status = 'active' ORDER BY g.id`,
      [uid],
    ),
  );
  return rows.map((r) => ({ grantId: r.id, kind: r.kind, household: r.household, subject: r.subject, scopes: r.scopes }));
}

proRouter.post('/api/pro/accept', async (req, res) => {
  const uid = proUser(req);
  const profile = await profileOf(uid);
  if (!profile) throw new HttpError(409, 'Set up your professional profile first');
  const token = str((req.body as { token?: unknown }).token, 'token', 100, true);
  await asSystem(async () => {
    const { rows } = await pool.query<{ id: number; household_id: number; kind: CareKind; expired: boolean }>(
      "SELECT id, household_id, kind, invite_expires_at < now() AS expired FROM care_grants WHERE invite_hash = $1 AND status = 'invited'",
      [hash(token)],
    );
    const g = rows[0];
    if (!g || g.expired) throw new HttpError(404, 'That invite link is used, revoked or expired — ask the family for a new one');
    if (g.kind !== profile.kind) throw new HttpError(409, `This invite is for a ${g.kind.replace('_', '-')} — your profile says ${profile.kind.replace('_', '-')}`);
    await pool.query("UPDATE care_grants SET status = 'active', pro_user_id = $2, accepted_at = now(), invite_hash = NULL WHERE id = $1", [g.id, uid]);
    await inHousehold(g.household_id, () => log(g.id, 'pro', 'accepted', { proUserId: uid }));
  });
  res.json({ clients: await clientsOf(uid) });
});

proRouter.get('/api/pro/clients', async (req, res) => {
  res.json({ clients: await clientsOf(proUser(req)) });
});

/** The pro's active grant, or 403 (revoked/never granted). */
async function activeGrant(uid: number, id: number): Promise<GrantRow> {
  const { rows } = await asSystem(() => pool.query<GrantRow>(`${GRANT_SELECT} WHERE g.id = $1 AND g.pro_user_id = $2`, [id, uid]));
  const g = rows[0];
  if (!g || g.status !== 'active') throw new HttpError(403, 'You don’t have access to this family');
  return g;
}

proRouter.get('/api/pro/clients/:id/notes', async (req, res) => {
  const uid = proUser(req);
  const g = await activeGrant(uid, idParam(req.params.id));
  res.json(
    await inHousehold(g.household_id, async () => {
      await log(g.id, 'pro', 'read', { proUserId: uid }, 'notes');
      return detail(g, true);
    }),
  );
});

proRouter.post('/api/pro/clients/:id/notes', async (req, res) => {
  const uid = proUser(req);
  const g = await activeGrant(uid, idParam(req.params.id));
  const body = str((req.body as { body?: unknown }).body, 'body', 4000, true);
  res.status(201).json(
    await inHousehold(g.household_id, async () => {
      await pool.query("INSERT INTO care_notes (grant_id, author, body) VALUES ($1, 'pro', $2)", [g.id, body]);
      await log(g.id, 'pro', 'note', { proUserId: uid });
      return detail(g, true);
    }),
  );
});

/** One scope of the person's data — only scopes in the grant, every read logged. */
proRouter.get('/api/pro/clients/:id/data/:scope', async (req, res) => {
  const uid = proUser(req);
  const g = await activeGrant(uid, idParam(req.params.id));
  const scope = CARE_SCOPES.find((s) => s === req.params.scope);
  if (!scope || !g.scopes.includes(scope)) throw new HttpError(403, 'That isn’t part of what the family shared');
  const m = g.subject_member_id;
  const t = today();
  const out = await inHousehold(g.household_id, async (): Promise<ProScopeData> => {
    let items: ProScopeData['items'] = [];
    if (scope === 'homework') {
      const { rows } = await pool.query<{ assignment: string; subject: string; due: string | null; done: boolean }>(
        'SELECT assignment, subject, due::text AS due, done FROM homework WHERE member_id = $1 ORDER BY done, due NULLS LAST, id LIMIT 50', [m]);
      items = rows.map((r) => ({ title: r.assignment, detail: [r.subject, r.done ? 'done' : 'open'].filter(Boolean).join(' · '), date: r.due }));
    } else if (scope === 'school') {
      const { rows } = await pool.query<{ title: string; detail: string; date: string | null }>(
        `SELECT name AS title, 'class' || CASE WHEN teacher <> '' THEN ' · ' || teacher ELSE '' END AS detail, NULL::text AS date FROM classes WHERE member_id = $1 AND NOT archived
         UNION ALL SELECT name, 'assignment · ' || CASE WHEN done THEN 'done' ELSE 'open' END, due::text FROM assignments WHERE member_id = $1`, [m]);
      items = rows;
    } else if (scope === 'health') {
      const { rows } = await pool.query<{ title: string; detail: string; date: string }>(
        `SELECT CASE kind WHEN 'session' THEN activity WHEN 'day_complete' THEN 'Workout: ' || day_name ELSE exercise END AS title,
                CASE kind WHEN 'session' THEN minutes || ' min' ELSE '' END AS detail, logged_on::text AS date
           FROM workout_logs WHERE member_id = $1 AND logged_on >= $2 AND kind <> 'exercise' ORDER BY logged_on DESC LIMIT 60`, [m, addDays(t, -30)]);
      items = rows;
    } else if (scope === 'day') {
      const { rows } = await pool.query<{ title: string; detail: string; date: string }>(
        `SELECT task AS title, priority || ' · ' || energy || CASE WHEN done THEN ' · done' ELSE '' END AS detail, day::text AS date
           FROM tasks WHERE member_id = $1 AND day >= $2 ORDER BY day DESC, id LIMIT 80`, [m, addDays(t, -7)]);
      items = rows;
    } else {
      const { rows } = await pool.query<{ title: string; detail: string; date: string }>(
        `SELECT 'Check-in' AS title, concat_ws(' · ', nullif('nervous system ' || nervous, 'nervous system '), nullif('sleep ' || sleep, 'sleep '), nullif('fuel ' || fuel, 'fuel ')) AS detail, day::text AS date
           FROM checkins WHERE member_id = $1 AND day >= $2 ORDER BY day DESC`, [m, addDays(t, -14)]);
      items = rows;
    }
    await log(g.id, 'pro', 'read', { proUserId: uid }, scope);
    return { scope, items };
  });
  res.json(out);
});
