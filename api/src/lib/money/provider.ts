/**
 * Read-only bank data. One interface, two implementations:
 *   - PlaidProvider: the real Plaid API in PRODUCTION (PLAID_CLIENT_ID / PLAID_SECRET; PLAID_ENV must
 *     be production or unset; PLAID_REDIRECT_URI for banks that sign in on their own site).
 *   - FakeProvider: deterministic local test data (MONEY_PROVIDER=fake) — never on a production
 *     server, and always labeled as demo data where it shows.
 * There is no sandbox: MyDay runs real finances. Keys for any other Plaid environment are refused
 * (Money stays "not set up" and says why in the log) rather than showing play-money as real.
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
  const env = (process.env.PLAID_ENV?.trim() || 'production').toLowerCase();
  if (id && secret && env !== 'production') {
    console.error(`money: PLAID_ENV is “${env}” — MyDay runs real finances only (production); Money stays off until production keys are installed`);
    cached = null;
  } else if (id && secret) {
    cached = new PlaidProvider(id, secret, process.env.PLAID_REDIRECT_URI?.trim() || null);
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
