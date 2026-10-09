/**
 * Stripe, without an SDK: a few REST calls (form-encoded) and webhook
 * signature checks. Live only when BILLING_PROVIDER=stripe and
 * STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are set on the server (never in
 * the repo). STRIPE_API_BASE points tests at a local fake.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

const base = (): string => (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');

function key(): string {
  const k = process.env.STRIPE_SECRET_KEY ?? '';
  if (!k) throw new HttpError(503, 'Payments need STRIPE_SECRET_KEY on the server');
  return k;
}

/** Nested params → Stripe's form encoding (a[b][0][c]=…). */
export function formEncode(params: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => out.push(...(typeof item === 'object' && item !== null ? formEncode(item as Record<string, unknown>, `${name}[${i}]`) : [`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`])));
    else if (typeof v === 'object') out.push(...formEncode(v as Record<string, unknown>, name));
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export async function stripe<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${base()}/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode(params).join('&'),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    console.error('stripe error', path, res.status, body.error?.message);
    throw new HttpError(502, 'The payment service didn’t answer — try again in a minute');
  }
  return body;
}

/** Read an object back from Stripe (e.g. a Checkout session, to confirm it's paid). */
export async function stripeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${base()}/v1/${path}`, { headers: { Authorization: `Bearer ${key()}` } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    console.error('stripe error', path, res.status, body.error?.message);
    throw new HttpError(502, 'The payment service didn’t answer — try again in a minute');
  }
  return body;
}

/** Verify a Stripe-Signature header (t=…,v1=…) over the raw body; 5-minute tolerance. */
export function verifyWebhook(payload: Buffer, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = header
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  if (!Number.isFinite(t) || !v1.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${payload.toString('utf8')}`).digest('hex');
  return v1.some((sig) => sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}

/** Stripe subscription status → ours. */
export function statusFrom(stripeStatus: string): 'active' | 'past_due' | 'canceled' {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  if (stripeStatus === 'past_due' || stripeStatus === 'incomplete') return 'past_due';
  return 'canceled';
}
