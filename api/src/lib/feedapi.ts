import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { FeedApiScope } from '@myday/shared';
import { FEED_API_SCOPES } from '@myday/shared';
import { HttpError } from './http.js';

/*
 * The Feed Publishing API (v1) -- shared bits: how secrets and tokens are minted and stored, and the scopes.
 * Every secret/token is random (32 bytes, base64url) with a short readable prefix so a leaked one is
 * recognizable; only its SHA-256 hash is ever stored.
 */

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const rand = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const newClientId = (): string => `feedapp_${randomBytes(12).toString('hex')}`;
export const newClientSecret = (): string => `fds_${rand()}`;
export const newCode = (): string => `fdc_${rand()}`;
export const newAccessToken = (): string => `fda_${rand()}`;
export const newRefreshToken = (): string => `fdr_${rand()}`;

/** Constant-time compare of a presented secret against a stored hash. */
export function secretMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Token lifetimes (seconds). Published in docs/feed-api.md -- change them there too. */
export const LIFETIMES = { code: 10 * 60, access: 60 * 60, refresh: 30 * 24 * 60 * 60 } as const;

export const isScope = (s: string): s is FeedApiScope => (FEED_API_SCOPES as readonly string[]).includes(s);

/** Space-separated scope list (OAuth style) or array -> validated, de-duplicated scopes. */
export function parseScopes(v: unknown, field = 'scope'): FeedApiScope[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  const out = [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
  const bad = out.filter((x) => !isScope(x));
  if (bad.length) throw new HttpError(400, `Unknown ${field}: ${bad.join(', ')}`, 'invalid_scope');
  return out as FeedApiScope[];
}

/**
 * A redirect URI an app may register: absolute https, or http only on the local machine (for
 * development). No fragments. Matching at authorize time is exact string equality.
 */
export function checkRedirectUri(u: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new HttpError(400, `Redirect URI isn’t a full URL: ${u}`, 'invalid_redirect_uri');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new HttpError(400, `Redirect URIs must use https (http only for localhost): ${u}`, 'invalid_redirect_uri');
  }
  if (url.hash) throw new HttpError(400, `Redirect URIs can’t have a #fragment: ${u}`, 'invalid_redirect_uri');
  return u;
}
