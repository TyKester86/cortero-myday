/**
 * Ask Hana attachments (migrations/032_chat_attachments.sql): photos (from the
 * camera or the photo library — re-encoded on the phone, so location data is
 * dropped), PDFs and small text files. Sealed at rest, served only to the
 * person who attached them, and sent to Hana with the message they belong to.
 */
import express, { Router, type Request } from 'express';
import type { ChatAttachment } from '@myday/shared';
import { pool } from '../db.js';
import { HttpError, idParam } from '../lib/http.js';
import { currentKeyId, openBytes, sealBytes } from '../lib/seal.js';

export const chatUploadRouter = Router();
export const chatFilesRouter = Router();

const LIMIT: Record<'image' | 'pdf' | 'text', number> = { image: 5 * 1024 * 1024, pdf: 10 * 1024 * 1024, text: 1024 * 1024 };
const PER_DAY = (): number => Number(process.env.CHAT_FILES_PER_DAY) || 40;

/** What the bytes actually are (never trust the declared type alone). */
export function kindOf(b: Buffer, declared: string): { kind: 'image' | 'pdf' | 'text'; mime: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg' };
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png' };
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (b.length > 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')) return { kind: 'image', mime: 'image/gif' };
  if (b.length > 5 && b.toString('ascii', 0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  if (/^text\/(plain|csv|markdown)$/.test(declared) && !b.subarray(0, 4096).includes(0)) return { kind: 'text', mime: declared };
  return null;
}

export const attachmentUrl = (id: number): string => `/api/chat/attachments/${id}`;

chatUploadRouter.post('/api/chat/attachments', express.raw({ type: () => true, limit: LIMIT.pdf }), async (req: Request, res) => {
  if (req.headers['x-myday-upload'] !== '1') throw new HttpError(400, 'Missing upload header');
  if (!req.user || !req.member || !req.householdId) throw new HttpError(401, 'Not signed in');
  if (req.member.kind !== 'adult') throw new HttpError(403, 'Attachments are for grown-ups');
  const me = req.member;
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (data.length < 10) throw new HttpError(400, 'That file was empty');
  const declared = String(req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
  const k = kindOf(data, declared);
  if (!k) throw new HttpError(415, 'Hana can read photos (JPEG, PNG, WebP, GIF), PDFs and plain text files');
  if (data.length > LIMIT[k.kind]) throw new HttpError(413, k.kind === 'image' ? 'That photo is too big (5 MB max)' : k.kind === 'pdf' ? 'That PDF is too big (10 MB max)' : 'That text file is too big (1 MB max)');
  const { rows: n } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM chat_attachments WHERE member_id = $1 AND created_at > now() - interval '1 day'", [me.id]);
  if ((n[0]?.n ?? 0) >= PER_DAY()) throw new HttpError(429, 'That’s a lot of files today — more tomorrow.', 'daily_limit');
  const raw = typeof req.query.name === 'string' ? req.query.name : '';
  const name = raw.replace(/[\u0000-\u001f\\/]+/g, ' ').trim().slice(0, 120) || (k.kind === 'image' ? 'Photo' : k.kind === 'pdf' ? 'Document.pdf' : 'Notes.txt');
  const keyId = currentKeyId();
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO chat_attachments (member_id, name, mime, size, data_enc, key_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [me.id, name, k.mime, data.length, sealBytes(data, keyId), keyId],
  );
  const id = rows[0]?.id ?? 0;
  const out: ChatAttachment = { id, name, mime: k.mime, size: data.length, url: attachmentUrl(id) };
  res.status(201).json(out);
});

/** Only the person who attached it can open it. */
chatFilesRouter.get('/api/chat/attachments/:id', async (req, res) => {
  if (!req.member) throw new HttpError(401, 'Not signed in');
  const { rows } = await pool.query<{ name: string; mime: string; data_enc: Buffer; key_id: string }>(
    'SELECT name, mime, data_enc, key_id FROM chat_attachments WHERE id = $1 AND member_id = $2',
    [idParam(req.params.id), req.member.id],
  );
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Not found');
  res
    .set('Content-Type', a.mime)
    .set('Cache-Control', 'private, no-store')
    .set('Content-Disposition', `${a.mime.startsWith('image/') ? 'inline' : 'attachment'}; filename="${encodeURIComponent(a.name)}"`)
    .send(openBytes(a.data_enc, a.key_id));
});

export interface LoadedAttachment {
  id: number;
  name: string;
  mime: string;
  size: number;
  data: Buffer;
}

/** The person's own attachments by id (others are silently ignored). */
export async function loadAttachments(memberId: number, ids: number[]): Promise<LoadedAttachment[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<{ id: number; name: string; mime: string; size: number; data_enc: Buffer; key_id: string }>(
    'SELECT id, name, mime, size, data_enc, key_id FROM chat_attachments WHERE member_id = $1 AND id = ANY($2::int[]) ORDER BY id',
    [memberId, ids],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, data: openBytes(r.data_enc, r.key_id) }));
}

export async function attachmentInfo(memberId: number, ids: number[]): Promise<Map<number, ChatAttachment>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query<{ id: number; name: string; mime: string; size: number }>(
    'SELECT id, name, mime, size FROM chat_attachments WHERE member_id = $1 AND id = ANY($2::int[])',
    [memberId, ids],
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, mime: r.mime, size: r.size, url: attachmentUrl(r.id) }]));
}
