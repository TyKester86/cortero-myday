/**
 * Read-only bank data. One interface, two implementations:
 *   - PlaidProvider: the real Plaid API (PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV).
 *   - FakeProvider: deterministic local data (MONEY_PROVIDER=fake, never in production).
 * Selection: Plaid when its keys are set; otherwise the fake if explicitly
 * asked for outside production; otherwise Money is "not set up".
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { DateStr } from '@myday/shared';
import { config } from '../../config.js';
import { HttpError } from '../http.js';
import { FakeProvider } from './fake.js';
import { PlaidProvider } from './plaid.js';

export interface ProviderAccount {
  accountId: string;
  name: string;
  mask: string;
  type: string;
  subtype: string;
  current: number | null;
  available: number | null;
  currency: string;
}

/** amount: Plaid convention — positive = money out, negative = money in. */
export interface ProviderTxn {
  txnId: string;
  accountId: string;
  date: DateStr;
  name: string;
  merchant: string;
  amount: number;
  category: string;
  pending: boolean;
}

export interface MoneyProvider {
  readonly kind: 'plaid' | 'fake';
  createLinkToken(clientUserId: string): Promise<string>;
  exchange(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  accounts(accessToken: string): Promise<ProviderAccount[]>;
  transactions(accessToken: string, start: DateStr, end: DateStr): Promise<ProviderTxn[]>;
  remove(accessToken: string): Promise<void>;
}

let cached: MoneyProvider | null | undefined;

export function moneyProvider(): MoneyProvider | null {
  if (cached !== undefined) return cached;
  const id = process.env.PLAID_CLIENT_ID ?? '';
  const secret = process.env.PLAID_SECRET ?? '';
  if (id && secret) {
    const env = process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox';
    cached = new PlaidProvider(id, secret, env);
  } else if (process.env.MONEY_PROVIDER === 'fake' && !config.production) {
    cached = new FakeProvider();
  } else {
    cached = null;
  }
  return cached;
}

/* ---------- access tokens are encrypted at rest (AES-256-GCM) ---------- */

function tokenKey(): Buffer {
  const hex = process.env.MONEY_TOKEN_KEY ?? '';
  if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  if (config.production) throw new HttpError(503, 'Money needs MONEY_TOKEN_KEY (64 hex chars) on the server');
  // Local/dev only: derive a key from the session secret.
  return Buffer.from(hkdfSync('sha256', config.sessionSecret, 'myday', 'money-token-key', 32));
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', tokenKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptToken(stored: string): string {
  const [v, iv, tag, data] = stored.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('bad token format');
  const d = createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
