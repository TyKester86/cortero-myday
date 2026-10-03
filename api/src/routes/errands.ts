/**
 * Hana step 5: saved website logins and browser errands (lib/robot.ts).
 * Everything here is per grown-up: nobody else in the household — not even
 * another parent — sees someone's saved logins or errands.
 */
import { Router } from 'express';
import type { Errand, ErrandStatus, ErrandsState, SavedLogin } from '@myday/shared';
import { currentHousehold, pool } from '../db.js';
import { HttpError } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';
import { publicUrl, robotAvailable, sealLogin, startErrand } from '../lib/robot.js';
import { currentKeyId, openBytes, sealText } from '../lib/seal.js';

export const errandsRouter = Router();

/** "tykester@gmail.com" → "ty•••@gmail.com"; "tykester" → "ty•••". */
export function hint(username: string): string {
  const [user, domain] = username.split('@');
  return `${(user ?? '').slice(0, 2)}•••${domain ? `@${domain}` : ''}`;
}

function originOf(raw: string): string {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, 'Enter the website, like walmart.com');
  }
  const local = process.env.ROBOT_ALLOW_LOCAL === '1' && process.env.NODE_ENV !== 'production';
  if (u.protocol !== 'https:' && !local) throw new HttpError(400, 'Only https websites');
  if (u.username || u.password) throw new HttpError(400, 'Enter just the website');
  return u.origin;
}

async function state(memberId: number): Promise<ErrandsState> {
  const { rows: l } = await pool.query<{ id: number; site: string; origin: string; username_hint: string; updated_at: Date }>(
    'SELECT id, site, origin, username_hint, updated_at FROM saved_logins WHERE member_id = $1 ORDER BY site',
    [memberId],
  );
  const { rows: e } = await pool.query<{ id: number; goal: string; start_url: string; status: ErrandStatus; ask: string; result: string; steps: Array<{ at: string; say: string }>; has_shot: boolean; created_at: Date; finished_at: Date | null }>(
    'SELECT id, goal, start_url, status, ask, result, steps, shot_enc IS NOT NULL AS has_shot, created_at, finished_at FROM robot_errands WHERE member_id = $1 ORDER BY id DESC LIMIT 20',
    [memberId],
  );
  const logins: SavedLogin[] = l.map((r) => ({ id: r.id, site: r.site, origin: r.origin, usernameHint: r.username_hint, updatedAt: r.updated_at.toISOString() }));
  const errands: Errand[] = e.map((r) => ({
    id: r.id,
    goal: r.goal,
    site: new URL(r.start_url).hostname,
    status: r.status,
    ask: r.ask,
    result: r.result,
    steps: r.steps.slice(-40),
    hasShot: r.has_shot,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  }));
  return { available: robotAvailable(), logins, errands };
}

errandsRouter.get('/api/errands', async (req, res) => {
  const me = requireAdult(req);
  res.json(await state(me.id));
});

/* ---------- saved logins ---------- */

errandsRouter.post('/api/errands/logins', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as { site?: unknown; url?: unknown; username?: unknown; password?: unknown };
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!username || username.length > 200) throw new HttpError(400, 'Enter the username or email you sign in with');
  if (!password || password.length > 500) throw new HttpError(400, 'Enter the password');
  const origin = originOf(typeof b.url === 'string' ? b.url.trim() : '');
  const site = (typeof b.site === 'string' && b.site.trim() ? b.site.trim() : new URL(origin).hostname.replace(/^www\./, '')).slice(0, 60);
  const sealed = sealLogin(username, password);
  await pool.query(
    `INSERT INTO saved_logins (member_id, site, origin, username_enc, password_enc, key_id, username_hint)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (member_id, origin) DO UPDATE SET site = EXCLUDED.site, username_enc = EXCLUDED.username_enc, password_enc = EXCLUDED.password_enc,
       key_id = EXCLUDED.key_id, username_hint = EXCLUDED.username_hint, updated_at = now()`,
    [me.id, site, origin, sealed.username_enc, sealed.password_enc, sealed.key_id, hint(username)],
  );
  res.status(201).json(await state(me.id));
});

errandsRouter.delete('/api/errands/logins/:id', async (req, res) => {
  const me = requireAdult(req);
  const { rowCount } = await pool.query('DELETE FROM saved_logins WHERE id = $1 AND member_id = $2', [Number(req.params.id) || 0, me.id]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json(await state(me.id));
});

/* ---------- errands ---------- */

/** Create + queue an errand. `site` is a saved login's id, or a website. */
export async function createErrand(memberId: number, goal: string, site: { loginId: number } | { url: string } | { name: string }): Promise<number> {
  const g = goal.trim().slice(0, 500);
  if (g.length < 4) throw new HttpError(400, 'Say what Hana should do');
  let loginId: number | null = null;
  let start: string;
  if ('url' in site) {
    start = originOf(site.url);
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM saved_logins WHERE member_id = $1 AND origin = $2', [memberId, start]);
    loginId = rows[0]?.id ?? null;
    if (/^https?:\/\//i.test(site.url)) start = new URL(site.url).href;
  } else {
    const { rows } = await pool.query<{ id: number; origin: string }>(
      'loginId' in site
        ? 'SELECT id, origin FROM saved_logins WHERE member_id = $1 AND id = $2'
        : "SELECT id, origin FROM saved_logins WHERE member_id = $1 AND (lower(site) = lower($2) OR origin ILIKE '%' || $2 || '%') ORDER BY (lower(site) = lower($2)) DESC LIMIT 1",
      [memberId, 'loginId' in site ? site.loginId : site.name.trim()],
    );
    if (!rows[0]) {
      if ('name' in site && /\.[a-z]{2,}$/i.test(site.name.trim())) return createErrand(memberId, goal, { url: site.name.trim() });
      throw new HttpError(404, 'I don’t have a saved login for that site — add it in Hana’s errands first, or give me the website');
    }
    loginId = rows[0].id;
    start = rows[0].origin;
  }
  if (!(await publicUrl(start))) throw new HttpError(400, 'That website isn’t reachable from here');
  const { rows: busy } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM robot_errands WHERE member_id = $1 AND status IN ('queued', 'running', 'needs_ok', 'needs_input')", [memberId]);
  if ((busy[0]?.n ?? 0) >= 2) throw new HttpError(409, 'Hana is already running two errands for you — let one finish first');
  if (!robotAvailable()) throw new HttpError(503, 'Errands aren’t set up on this server yet');
  const { rows } = await pool.query<{ id: number }>('INSERT INTO robot_errands (member_id, goal, start_url, login_id, key_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [memberId, g, start, loginId, currentKeyId()]);
  const id = rows[0]?.id ?? 0;
  startErrand(id, currentHousehold() ?? 0);
  return id;
}

errandsRouter.post('/api/errands', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as { goal?: unknown; loginId?: unknown; url?: unknown };
  const goal = typeof b.goal === 'string' ? b.goal : '';
  const site = typeof b.loginId === 'number' ? { loginId: b.loginId } : typeof b.url === 'string' && b.url.trim() ? { url: b.url.trim() } : null;
  if (!site) throw new HttpError(400, 'Pick a saved login or enter a website');
  await createErrand(me.id, goal, site);
  res.status(201).json(await state(me.id));
});

async function mine(memberId: number, id: number): Promise<{ status: ErrandStatus }> {
  const { rows } = await pool.query<{ status: ErrandStatus }>('SELECT status FROM robot_errands WHERE id = $1 AND member_id = $2', [id, memberId]);
  if (!rows[0]) throw new HttpError(404, 'Not found');
  return rows[0];
}

errandsRouter.post('/api/errands/:id/approve', async (req, res) => {
  const me = requireAdult(req);
  const id = Number(req.params.id) || 0;
  if ((await mine(me.id, id)).status !== 'needs_ok') throw new HttpError(409, 'Hana isn’t waiting for an OK on this one');
  await pool.query("UPDATE robot_errands SET approved = true, updated_at = now() WHERE id = $1 AND status = 'needs_ok'", [id]);
  res.json(await state(me.id));
});

errandsRouter.post('/api/errands/:id/answer', async (req, res) => {
  const me = requireAdult(req);
  const id = Number(req.params.id) || 0;
  const text = typeof (req.body as { text?: unknown }).text === 'string' ? ((req.body as { text: string }).text.trim()).slice(0, 200) : '';
  if (!text) throw new HttpError(400, 'Type your answer');
  if ((await mine(me.id, id)).status !== 'needs_input') throw new HttpError(409, 'Hana isn’t waiting for an answer on this one');
  const { rows } = await pool.query<{ key_id: string | null }>('SELECT key_id FROM robot_errands WHERE id = $1', [id]);
  await pool.query('UPDATE robot_errands SET answer_enc = $2, updated_at = now() WHERE id = $1', [id, sealText(text, rows[0]?.key_id ?? currentKeyId())]);
  res.json(await state(me.id));
});

errandsRouter.post('/api/errands/:id/cancel', async (req, res) => {
  const me = requireAdult(req);
  const id = Number(req.params.id) || 0;
  const { status } = await mine(me.id, id);
  if (['done', 'failed', 'cancelled'].includes(status)) throw new HttpError(409, 'That errand already finished');
  await pool.query("UPDATE robot_errands SET status = 'cancelled', result = 'Cancelled — nothing more was done.', approved = false, ask = '', finished_at = now(), updated_at = now() WHERE id = $1", [id]);
  res.json(await state(me.id));
});

errandsRouter.delete('/api/errands/:id', async (req, res) => {
  const me = requireAdult(req);
  const id = Number(req.params.id) || 0;
  const { status } = await mine(me.id, id);
  if (!['done', 'failed', 'cancelled'].includes(status)) throw new HttpError(409, 'Cancel it first');
  await pool.query('DELETE FROM robot_errands WHERE id = $1', [id]);
  res.json(await state(me.id));
});

/** The latest browser screenshot (decrypted, only to its owner, never cached). */
errandsRouter.get('/api/errands/:id/shot', async (req, res) => {
  const me = requireAdult(req);
  const { rows } = await pool.query<{ shot_enc: Buffer | null; key_id: string | null }>('SELECT shot_enc, key_id FROM robot_errands WHERE id = $1 AND member_id = $2', [Number(req.params.id) || 0, me.id]);
  if (!rows[0]?.shot_enc) throw new HttpError(404, 'Not found');
  res.set('Cache-Control', 'no-store').type('image/jpeg').send(openBytes(rows[0].shot_enc, rows[0].key_id ?? currentKeyId()));
});
