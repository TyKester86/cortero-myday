/**
 * Hana step 3: send the grocery list to a store through its official API
 * (migrations/025_grocers.sql). MyDay fills the cart or builds the list; the
 * person always checks out and pays on the store's own site.
 *
 *   - Instacart (INSTACART_API_KEY): a shopping-list link with the household's
 *     open grocery items; they pick a store and check out on Instacart.
 *   - Kroger (KROGER_CLIENT_ID / KROGER_CLIENT_SECRET): each grown-up connects
 *     their own Kroger account (OAuth, so MyDay never sees the password),
 *     picks a store by ZIP, and MyDay adds the items to their Kroger cart.
 *   - GROCERY_STUB=1 (never in production): deterministic stand-ins for tests.
 */
import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import type { GroceryOrdering, GrocerySendResult, KrogerStore } from '@myday/shared';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../lib/http.js';
import { parseIngredient } from '../lib/ingredients.js';
import { requireAdult } from '../lib/members.js';
import { currentKeyId, openText, sealText } from '../lib/seal.js';

export const grocersRouter = Router();

const stub = (): boolean => process.env.GROCERY_STUB === '1' && !config.production;
const instacartOn = (): boolean => stub() || !!process.env.INSTACART_API_KEY;
const krogerOn = (): boolean => stub() || (!!process.env.KROGER_CLIENT_ID && !!process.env.KROGER_CLIENT_SECRET);
const KROGER = 'https://api.kroger.com/v1';
const KROGER_SCOPES = 'cart.basic:write product.compact profile.compact';
const krogerRedirect = (): string => `${config.publicUrl}/api/grocery/kroger/callback`;


async function openItems(): Promise<Array<{ name: string; qty: number; unit: string; text: string }>> {
  const { rows } = await pool.query<{ item: string; qty: string }>('SELECT item, qty FROM grocery_items WHERE NOT done ORDER BY id');
  return rows.map((r) => {
    const p = parseIngredient(r.item);
    return { name: p.name || r.item, qty: p.qty ?? (Number(r.qty) || 1), unit: p.unit, text: r.item };
  });
}

/* ---------- Instacart ---------- */

export async function sendToInstacart(title: string): Promise<GrocerySendResult> {
  if (!instacartOn()) throw new HttpError(503, 'Instacart isn’t set up on this server yet');
  const items = await openItems();
  if (!items.length) throw new HttpError(409, 'The grocery list is empty');
  if (stub()) return { provider: 'instacart', url: `https://www.instacart.com/store/shopping_lists/stub-${items.length}`, added: items.map((i) => i.text), notFound: [] };
  const base = process.env.INSTACART_BASE_URL || 'https://connect.instacart.com';
  const res = await fetch(`${base}/idp/v1/products/products_link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.INSTACART_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      title,
      link_type: 'shopping_list',
      line_items: items.map((i) => ({ name: i.name, quantity: i.qty, unit: i.unit || 'each', display_text: i.text })),
    }),
  });
  const out = (await res.json().catch(() => null)) as { products_link_url?: string } | null;
  if (!res.ok || !out?.products_link_url) throw new HttpError(502, 'Instacart didn’t take the list — try again in a minute');
  return { provider: 'instacart', url: out.products_link_url, added: items.map((i) => i.text), notFound: [] };
}

/* ---------- Kroger ---------- */

interface LinkRow {
  id: number;
  access_enc: Buffer;
  refresh_enc: Buffer | null;
  key_id: string;
  expires_at: Date;
  location_id: string | null;
  store_name: string;
}

async function krogerLink(memberId: number): Promise<LinkRow | null> {
  const { rows } = await pool.query<LinkRow>("SELECT id, access_enc, refresh_enc, key_id, expires_at, location_id, store_name FROM grocer_links WHERE member_id = $1 AND provider = 'kroger'", [memberId]);
  return rows[0] ?? null;
}

const basic = (): string => `Basic ${Buffer.from(`${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`).toString('base64')}`;

async function krogerToken(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  if (stub()) return { access_token: `stub-access-${randomBytes(4).toString('hex')}`, refresh_token: 'stub-refresh', expires_in: 1800 };
  const res = await fetch(`${KROGER}/connect/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const t = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
  if (!res.ok || !t?.access_token) throw new HttpError(502, 'Kroger sign-in didn’t finish — try connecting again');
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_in: t.expires_in ?? 1800 };
}

async function saveTokens(memberId: number, t: { access_token: string; refresh_token?: string; expires_in: number }): Promise<void> {
  const keyId = currentKeyId();
  await pool.query(
    `INSERT INTO grocer_links (member_id, provider, access_enc, refresh_enc, key_id, expires_at)
     VALUES ($1, 'kroger', $2, $3, $4, now() + make_interval(secs => $5))
     ON CONFLICT (member_id, provider) DO UPDATE SET access_enc = EXCLUDED.access_enc,
       refresh_enc = COALESCE(EXCLUDED.refresh_enc, grocer_links.refresh_enc), key_id = EXCLUDED.key_id, expires_at = EXCLUDED.expires_at`,
    [memberId, sealText(t.access_token, keyId), t.refresh_token ? sealText(t.refresh_token, keyId) : null, keyId, Math.max(60, t.expires_in - 60)],
  );
}

/** A working access token, refreshed when it's about to expire. */
async function accessToken(memberId: number): Promise<{ token: string; link: LinkRow }> {
  const link = await krogerLink(memberId);
  if (!link) throw new HttpError(409, 'Connect your Kroger account first (Grocery list → Order it)', 'kroger_not_connected');
  if (link.expires_at.getTime() > Date.now()) return { token: openText(link.access_enc, link.key_id), link };
  if (!link.refresh_enc) throw new HttpError(409, 'Reconnect your Kroger account', 'kroger_not_connected');
  await saveTokens(memberId, await krogerToken({ grant_type: 'refresh_token', refresh_token: openText(link.refresh_enc, link.key_id) }));
  const fresh = (await krogerLink(memberId)) as LinkRow;
  return { token: openText(fresh.access_enc, fresh.key_id), link: fresh };
}

async function krogerGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${KROGER}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new HttpError(502, 'Kroger didn’t answer — try again in a minute');
  return (await res.json()) as T;
}

export async function fillKrogerCart(memberId: number): Promise<GrocerySendResult> {
  if (!krogerOn()) throw new HttpError(503, 'Kroger isn’t set up on this server yet');
  const { token, link } = await accessToken(memberId);
  if (!link.location_id) throw new HttpError(409, 'Pick your Kroger store first', 'kroger_no_store');
  const items = await openItems();
  if (!items.length) throw new HttpError(409, 'The grocery list is empty');
  const added: string[] = [];
  const notFound: string[] = [];
  const cart: Array<{ upc: string; quantity: number; modality: 'PICKUP' }> = [];
  for (const i of items) {
    let upc: string | null = null;
    if (stub()) upc = /zzz|unobtainium/i.test(i.name) ? null : `00${Buffer.from(i.name).toString('hex').slice(0, 10)}`;
    else {
      const r = await krogerGet<{ data?: Array<{ upc?: string }> }>(`/products?filter.term=${encodeURIComponent(i.name.slice(0, 60))}&filter.locationId=${encodeURIComponent(link.location_id)}&filter.limit=1`, token);
      upc = r.data?.[0]?.upc ?? null;
    }
    if (upc) {
      cart.push({ upc, quantity: Math.max(1, Math.min(10, Math.round(i.unit ? 1 : i.qty))), modality: 'PICKUP' });
      added.push(i.text);
    } else notFound.push(i.text);
  }
  if (cart.length && !stub()) {
    const res = await fetch(`${KROGER}/cart/add`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cart }),
    });
    if (!res.ok) throw new HttpError(502, 'Kroger didn’t take the cart — try again in a minute');
  }
  return { provider: 'kroger', url: 'https://www.kroger.com/cart', added, notFound };
}

/* ---------- routes ---------- */

grocersRouter.get('/api/grocery/ordering', async (req, res) => {
  const me = requireAdult(req);
  const link = await krogerLink(me.id);
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM grocery_items WHERE NOT done');
  const out: GroceryOrdering = { instacart: instacartOn(), kroger: { available: krogerOn(), connected: !!link, store: link?.store_name || null }, openItems: rows[0]?.n ?? 0 };
  res.json(out);
});

grocersRouter.post('/api/grocery/send/instacart', async (req, res) => {
  requireAdult(req);
  res.json(await sendToInstacart('Our grocery list (MyDay)'));
});

grocersRouter.post('/api/grocery/send/kroger', async (req, res) => {
  const me = requireAdult(req);
  res.json(await fillKrogerCart(me.id));
});

/** Start connecting Kroger: where to send the browser. */
grocersRouter.get('/api/grocery/kroger/connect', async (req: Request, res) => {
  requireAdult(req);
  if (!krogerOn()) throw new HttpError(503, 'Kroger isn’t set up on this server yet');
  const state = randomBytes(16).toString('hex');
  req.session.krogerState = state;
  const url = stub()
    ? `/api/grocery/kroger/callback?code=stub-code&state=${state}`
    : `${KROGER}/connect/oauth2/authorize?${new URLSearchParams({ scope: KROGER_SCOPES, response_type: 'code', client_id: process.env.KROGER_CLIENT_ID ?? '', redirect_uri: krogerRedirect(), state }).toString()}`;
  req.session.save(() => res.json({ url }));
});

grocersRouter.get('/api/grocery/kroger/callback', async (req, res) => {
  const me = requireAdult(req);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!state || state !== req.session.krogerState || !code) {
    res.redirect('/meals/grocery?kroger=failed');
    return;
  }
  delete req.session.krogerState;
  await saveTokens(me.id, await krogerToken({ grant_type: 'authorization_code', code, redirect_uri: krogerRedirect() }));
  res.redirect('/meals/grocery?kroger=connected');
});

grocersRouter.get('/api/grocery/kroger/stores', async (req, res) => {
  const me = requireAdult(req);
  const zip = typeof req.query.zip === 'string' && /^\d{5}$/.test(req.query.zip) ? req.query.zip : null;
  if (!zip) throw new HttpError(400, 'Enter a 5-digit ZIP');
  if (stub()) {
    res.json({ stores: [{ id: '01400943', name: 'Kroger', address: '123 Main St' }, { id: '01400944', name: 'Kroger Marketplace', address: '9 Oak Ave' }] });
    return;
  }
  const { token } = await accessToken(me.id);
  const r = await krogerGet<{ data?: Array<{ locationId: string; name: string; address?: { addressLine1?: string; city?: string } }> }>(`/locations?filter.zipCode.near=${zip}&filter.limit=6`, token);
  res.json({ stores: (r.data ?? []).map((l): KrogerStore => ({ id: l.locationId, name: l.name, address: [l.address?.addressLine1, l.address?.city].filter(Boolean).join(', ') })) });
});

grocersRouter.put('/api/grocery/kroger/store', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as { id?: unknown; name?: unknown };
  const id = typeof b.id === 'string' && /^[0-9A-Za-z]{4,20}$/.test(b.id) ? b.id : null;
  if (!id) throw new HttpError(400, 'Pick a store');
  const { rowCount } = await pool.query("UPDATE grocer_links SET location_id = $2, store_name = $3 WHERE member_id = $1 AND provider = 'kroger'", [me.id, id, typeof b.name === 'string' ? b.name.slice(0, 80) : 'Kroger']);
  if (!rowCount) throw new HttpError(409, 'Connect your Kroger account first', 'kroger_not_connected');
  res.json({ ok: true });
});

grocersRouter.delete('/api/grocery/kroger', async (req, res) => {
  const me = requireAdult(req);
  await pool.query("DELETE FROM grocer_links WHERE member_id = $1 AND provider = 'kroger'", [me.id]);
  res.json({ ok: true });
});
