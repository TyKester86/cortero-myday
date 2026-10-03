/**
 * Progress photos: front, back and both sides, about once a month.
 *
 *   - opt-in, adults only (never in teen mode)
 *   - visible to their owner ONLY: no grown-up acting for someone else, no
 *     coach / care-team page and no staff page can read them
 *   - encrypted at rest (AES-256-GCM) inside the database, so backups and
 *     household merges carry them and row-level security guards them
 *   - the browser re-encodes each photo before upload, which drops location
 *     and camera data (EXIF)
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import express, { Router, type Request } from 'express';
import { PROGRESS_POSES, type DateStr, type ProgressPhotos, type ProgressPose } from '@myday/shared';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { daysBetween, today } from '../lib/dates.js';
import { HttpError, bool, idParam } from '../lib/http.js';
import { isTeen } from '../lib/planload.js';

export const photosRouter = Router();
export const photoUploadRouter = Router();

const MAX_PHOTO = 8 * 1024 * 1024;

/** PHOTO_KEY (64 hex) when set; otherwise a key derived from SESSION_SECRET. */
function photoKey(id: string): Buffer {
  const hex = process.env.PHOTO_KEY ?? '';
  if (id === 'p') {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new HttpError(503, 'This photo was saved with PHOTO_KEY, which is not set on the server');
    return Buffer.from(hex, 'hex');
  }
  return Buffer.from(hkdfSync('sha256', config.sessionSecret, 'myday', 'progress-photo-key', 32));
}
const currentKeyId = (): string => (/^[0-9a-f]{64}$/i.test(process.env.PHOTO_KEY ?? '') ? 'p' : 's');

function seal(plain: Buffer, keyId: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', photoKey(keyId), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

function open(stored: Buffer, keyId: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', photoKey(keyId), stored.subarray(0, 12));
  d.setAuthTag(stored.subarray(12, 28));
  return Buffer.concat([d.update(stored.subarray(28)), d.final()]);
}

/** Sniff the real type from the bytes (never trust the header). */
function imageType(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The signed-in member themself — photos are never available "acting for" someone else. */
async function owner(req: Request): Promise<number> {
  const me = req.member;
  if (!req.user || !me) throw new HttpError(401, 'Not signed in');
  if (me.kind === 'kid' || (await isTeen(me.id))) throw new HttpError(403, 'Progress photos aren’t part of teen mode', 'teen');
  if (typeof req.query.member === 'string' && req.query.member !== me.key) throw new HttpError(403, 'Progress photos are private to their owner');
  return me.id;
}

async function enabled(memberId: number): Promise<boolean> {
  const { rows } = await pool.query<{ photos: boolean }>('SELECT photos FROM health_profiles WHERE member_id = $1', [memberId]);
  return rows[0]?.photos ?? false;
}

async function summary(memberId: number): Promise<ProgressPhotos> {
  const { rows } = await pool.query<{ id: number; taken_on: DateStr; pose: ProgressPose }>(
    'SELECT id, taken_on::text AS taken_on, pose FROM progress_photos WHERE member_id = $1 ORDER BY taken_on DESC, pose',
    [memberId],
  );
  const by = new Map<DateStr, ProgressPhotos['sets'][number]>();
  for (const r of rows) {
    const set = by.get(r.taken_on) ?? { takenOn: r.taken_on, photos: { front: null, back: null, left: null, right: null } };
    set.photos[r.pose] = r.id;
    by.set(r.taken_on, set);
  }
  const sets = [...by.values()];
  const lastOn = sets[0]?.takenOn ?? null;
  return { enabled: await enabled(memberId), sets, lastOn, due: !lastOn || daysBetween(lastOn, today()) >= 28 };
}

photosRouter.get('/api/progress-photos', async (req, res) => {
  res.json(await summary(await owner(req)));
});

/** Turn progress photos on or off (off by default). Turning off keeps the photos; delete them separately. */
photosRouter.put('/api/progress-photos', async (req, res) => {
  const id = await owner(req);
  const on = bool((req.body as { enabled?: unknown }).enabled, 'enabled');
  await pool.query(
    `INSERT INTO health_profiles (member_id, plan_start, photos) VALUES ($1, $2, $3)
     ON CONFLICT (member_id) DO UPDATE SET photos = EXCLUDED.photos`,
    [id, today(), on],
  );
  res.json(await summary(id));
});

/** The picture itself (decrypted), never cached by the browser or a proxy. */
photosRouter.get('/api/progress-photos/:id/image', async (req, res) => {
  const me = await owner(req);
  const { rows } = await pool.query<{ mime: string; data: Buffer; key_id: string }>(
    'SELECT mime, data, key_id FROM progress_photos WHERE id = $1 AND member_id = $2',
    [idParam(req.params.id), me],
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'No such photo');
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(open(p.data, p.key_id));
});

photosRouter.delete('/api/progress-photos/:id', async (req, res) => {
  const me = await owner(req);
  const { rowCount } = await pool.query('DELETE FROM progress_photos WHERE id = $1 AND member_id = $2', [idParam(req.params.id), me]);
  if (!rowCount) throw new HttpError(404, 'No such photo');
  res.json(await summary(me));
});

/** Delete every progress photo (needs ?confirm=DELETE). */
photosRouter.delete('/api/progress-photos', async (req, res) => {
  const me = await owner(req);
  if (req.query.confirm !== 'DELETE') throw new HttpError(409, 'Confirm with ?confirm=DELETE');
  await pool.query('DELETE FROM progress_photos WHERE member_id = $1', [me]);
  res.json(await summary(me));
});

/** Upload one pose for today (replaces today's photo of that pose). Raw image body, mounted before the JSON parser. */
photoUploadRouter.post(
  '/api/progress-photos/:pose',
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_PHOTO }),
  async (req: Request, res) => {
    if (req.headers['x-myday-upload'] !== '1') throw new HttpError(400, 'Missing upload header');
    const me = await owner(req);
    const pose = PROGRESS_POSES.find((p) => p.key === req.params.pose)?.key;
    if (!pose) throw new HttpError(400, 'Pose must be front, back, left or right');
    if (!(await enabled(me))) throw new HttpError(409, 'Turn progress photos on first', 'photos_off');
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length < 100) throw new HttpError(400, 'The photo was empty');
    const mime = imageType(body);
    if (!mime) throw new HttpError(415, 'Send a JPEG, PNG or WebP photo');
    const keyId = currentKeyId();
    const t = today();
    // A retake gets a NEW id, so its URL changes and no browser shows the old picture.
    await tx(async (c) => {
      await c.query('DELETE FROM progress_photos WHERE member_id = $1 AND taken_on = $2 AND pose = $3', [me, t, pose]);
      await c.query(
        'INSERT INTO progress_photos (member_id, taken_on, pose, mime, data, key_id, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [me, t, pose, mime, seal(body, keyId), keyId, body.length],
      );
    });
    res.status(201).json(await summary(me));
  },
);
