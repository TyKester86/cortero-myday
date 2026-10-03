/**
 * Hana step 2: "Forward to Hana" (migrations/024_hana_inbox.sql).
 *
 *   - A grown-up makes the household's private address, h-<secret>@INBOUND_DOMAIN,
 *     and sets their email to forward bills, school mail and receipts to it.
 *   - An inbound-email service (Postmark, Resend, a Cloudflare Email Worker…)
 *     posts each message to /inbound/email?key=INBOUND_SECRET. Unknown
 *     addresses are ignored; without INBOUND_SECRET the webhook is off.
 *   - Hana reads it (lib/extract.ts) and suggests bills, calendar events and
 *     tasks; a grown-up taps Add or Dismiss. Nothing is added on its own.
 *   - Subjects and bodies are sealed at rest; only grown-ups see the inbox.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request } from 'express';
import { asSystem, inHousehold, pool } from '../db.js';
import { today } from '../lib/dates.js';
import { htmlToText, suggestFromEmail, type Suggestion } from '../lib/extract.js';
import { HttpError, idParam } from '../lib/http.js';
import { listMembers, requireAdult } from '../lib/members.js';
import { rateLimiter } from '../lib/pin.js';
import { pushConfigured, sendTo } from '../lib/push.js';
import { currentKeyId, openText, sealText } from '../lib/seal.js';

export const inboxRouter = Router();
/** The inbound-email webhook: public (the shared secret is in the URL), outside /api. */
export const inboundRouter = Router();

const DOMAIN = (): string => (process.env.INBOUND_DOMAIN || 'in.conquermyday.app').toLowerCase();
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');
const addressOf = (token: string): string => `h-${token}@${DOMAIN()}`;
const MAX_PER_DAY = 200;

export interface InboxItem {
  id: number;
  kind: 'bill' | 'event' | 'task';
  summary: string;
  status: 'suggested' | 'added' | 'dismissed';
}
export interface InboxEmail {
  id: number;
  from: string;
  subject: string;
  preview: string;
  at: string;
  items: InboxItem[];
}
export interface InboxResponse {
  address: string | null;
  /** The webhook is configured on this server (mail can actually arrive). */
  receiving: boolean;
  emails: InboxEmail[];
}

async function currentAddress(): Promise<string | null> {
  const { rows } = await pool.query<{ token_enc: Buffer; key_id: string }>('SELECT token_enc, key_id FROM inbox_addresses ORDER BY created_at DESC LIMIT 1');
  const r = rows[0];
  return r ? addressOf(openText(r.token_enc, r.key_id)) : null;
}

async function inbox(): Promise<InboxResponse> {
  const { rows } = await pool.query<{ id: number; from_addr: string; subject_enc: Buffer; body_enc: Buffer; key_id: string; received_at: Date }>(
    'SELECT id, from_addr, subject_enc, body_enc, key_id, received_at FROM inbox_emails ORDER BY received_at DESC, id DESC LIMIT 50',
  );
  const ids = rows.map((r) => r.id);
  const { rows: items } = await pool.query<InboxItem & { email_id: number }>(
    'SELECT id, email_id, kind, summary, status FROM inbox_items WHERE email_id = ANY($1) ORDER BY id',
    [ids],
  );
  return {
    address: await currentAddress(),
    receiving: !!process.env.INBOUND_SECRET,
    emails: rows.map((r) => ({
      id: r.id,
      from: r.from_addr,
      subject: openText(r.subject_enc, r.key_id),
      preview: openText(r.body_enc, r.key_id).slice(0, 240),
      at: r.received_at.toISOString(),
      items: items.filter((i) => i.email_id === r.id).map(({ id, kind, summary, status }) => ({ id, kind, summary, status })),
    })),
  };
}

inboxRouter.get('/api/inbox', async (req, res) => {
  requireAdult(req);
  res.json(await inbox());
});

/** Make (or replace) the household's forwarding address. The old one stops working. */
inboxRouter.post('/api/inbox/address', async (req, res) => {
  const me = requireAdult(req);
  const token = randomBytes(10).toString('hex');
  const keyId = currentKeyId();
  await pool.query('DELETE FROM inbox_addresses');
  await pool.query('INSERT INTO inbox_addresses (token_hash, token_enc, key_id, created_by) VALUES ($1, $2, $3, $4)', [hash(token), sealText(token, keyId), keyId, me.id]);
  res.status(201).json(await inbox());
});

inboxRouter.delete('/api/inbox/address', async (req, res) => {
  requireAdult(req);
  await pool.query('DELETE FROM inbox_addresses');
  res.json(await inbox());
});

/** Add a suggestion to MyDay (as the grown-up who tapped Add), or dismiss it. */
inboxRouter.post('/api/inbox/items/:id/:action', async (req, res) => {
  const me = requireAdult(req);
  const action = req.params.action === 'add' ? 'add' : req.params.action === 'dismiss' ? 'dismiss' : null;
  if (!action) throw new HttpError(404, 'Not found');
  const { rows } = await pool.query<{ kind: Suggestion['kind']; data: Suggestion['data']; status: string }>('SELECT kind, data, status FROM inbox_items WHERE id = $1', [idParam(req.params.id)]);
  const it = rows[0];
  if (!it) throw new HttpError(404, 'Not found');
  if (it.status !== 'suggested') throw new HttpError(409, `Already ${it.status}`);
  if (action === 'add') {
    if (it.kind === 'bill') {
      const d = it.data as Extract<Suggestion, { kind: 'bill' }>['data'];
      await pool.query('INSERT INTO bills (member_id, name, amount, due_day, autopay) VALUES ($1, $2, $3, $4, false)', [me.id, d.name, d.amount, d.due_day]);
    } else if (it.kind === 'event') {
      const d = it.data as Extract<Suggestion, { kind: 'event' }>['data'];
      await pool.query('INSERT INTO calendar_events (title, starts_on, start_time, created_by) VALUES ($1, $2, $3, $4)', [d.title, d.date, d.start_time, me.id]);
    } else {
      const d = it.data as Extract<Suggestion, { kind: 'task' }>['data'];
      await pool.query("INSERT INTO tasks (member_id, day, task, priority, energy) VALUES ($1, $2, $3, 'Important', 'Low Brain')", [me.id, today(), d.task]);
    }
  }
  await pool.query('UPDATE inbox_items SET status = $2, decided_by = $3 WHERE id = $1', [idParam(req.params.id), action === 'add' ? 'added' : 'dismissed', me.id]);
  res.json(await inbox());
});

/* ---------- the webhook ---------- */

/** Pull from / to / subject / text out of the common inbound-email JSON shapes. */
export function normalizeInbound(b: Record<string, unknown>): { to: string[]; from: string; subject: string; text: string } {
  const d = (b.type === 'email.received' && typeof b.data === 'object' && b.data ? b.data : b) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
      .map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x && 'Email' in x ? String((x as { Email: unknown }).Email) : typeof x === 'object' && x && 'address' in x ? String((x as { address: unknown }).address) : ''))
      .map((x) => (x.match(/<([^>]+)>/)?.[1] ?? x).trim().toLowerCase())
      .filter(Boolean);
  const to = [...list(d.ToFull ?? d.To ?? d.to), ...list(d.OriginalRecipient ?? d.envelope_to ?? d.recipient)];
  const from = String(d.From ?? d.from ?? '');
  const subject = String(d.Subject ?? d.subject ?? '').slice(0, 300);
  const text = String(d.TextBody ?? d.text ?? d.StrippedTextReply ?? '') || htmlToText(String(d.HtmlBody ?? d.html ?? ''));
  return { to: [...new Set(to)], from: from.slice(0, 200), subject, text: text.slice(0, 50_000) };
}

const inboundLimit = rateLimiter(600, 60 * 60_000);

function keyOk(req: Request): boolean {
  const want = process.env.INBOUND_SECRET ?? '';
  const got = typeof req.query.key === 'string' ? req.query.key : '';
  return want.length >= 16 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

inboundRouter.post('/inbound/email', express.json({ limit: '2mb' }), async (req, res) => {
  if (!process.env.INBOUND_SECRET) throw new HttpError(404, 'Not found');
  if (!keyOk(req)) throw new HttpError(401, 'Bad key');
  if (!inboundLimit('all')) throw new HttpError(429, 'Too many');
  const mail = normalizeInbound((req.body ?? {}) as Record<string, unknown>);
  const domain = DOMAIN();
  const token = mail.to.map((a) => a.match(new RegExp(`^h-([0-9a-f]{20})@${domain.replace(/\./g, '\\.')}$`))?.[1]).find(Boolean);
  // Unknown or replaced addresses are accepted and dropped (so senders can't probe which exist).
  const hh = token
    ? await asSystem(async () => (await pool.query<{ household_id: number }>('SELECT household_id FROM inbox_addresses WHERE token_hash = $1', [hash(token)])).rows[0]?.household_id ?? null)
    : null;
  if (hh === null) {
    res.json({ ok: true, delivered: false });
    return;
  }
  const n = await inHousehold(hh, async () => {
    const { rows: cnt } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM inbox_emails WHERE received_at > now() - interval '1 day'");
    if ((cnt[0]?.n ?? 0) >= MAX_PER_DAY) return -1;
    const keyId = currentKeyId();
    const { rows } = await pool.query<{ id: number }>('INSERT INTO inbox_emails (from_addr, subject_enc, body_enc, key_id) VALUES ($1, $2, $3, $4) RETURNING id', [
      mail.from,
      sealText(mail.subject || '(no subject)', keyId),
      sealText(mail.text, keyId),
      keyId,
    ]);
    const emailId = rows[0]?.id ?? 0;
    const items = await suggestFromEmail(mail, today());
    for (const s of items) await pool.query('INSERT INTO inbox_items (email_id, kind, data, summary) VALUES ($1, $2, $3, $4)', [emailId, s.kind, JSON.stringify(s.data), s.summary]);
    if (items.length && pushConfigured()) {
      for (const m of (await listMembers()).filter((x) => x.kind === 'adult')) {
        await sendTo(m.id, { title: 'Hana read an email', body: `${items.length} suggestion${items.length === 1 ? '' : 's'} to look at when you have a minute.`, url: '/inbox' }).catch(() => undefined);
      }
    }
    return items.length;
  });
  res.json({ ok: true, delivered: n >= 0, suggestions: Math.max(n, 0) });
});

