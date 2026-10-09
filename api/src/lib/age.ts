/**
 * The Feed is 18+, and no Feed account exists until age is checked: the sign-up's date-of-birth step returns a
 * signed, short-lived proof (this date of birth, 18+, checked by us) that the sign-in then carries — through an
 * email link, or through Google on the other domain. Stateless, so it works across MyDay's and the Feed's domains.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const TTL_MS = 60 * 60_000;

/** Whole years old today, or null for a date that isn't one. */
export function ageFrom(dob: string, now = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const born = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(born.getTime()) || born.getUTCMonth() !== m - 1 || born > now) return null;
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age;
}

const sign = (payload: string): string => createHmac('sha256', config.sessionSecret).update(`feed-age:${payload}`).digest('base64url');

/** A proof that this (18+) date of birth was checked, good for an hour. */
export function ageToken(dob: string, now = Date.now()): string {
  const payload = `${dob}.${now + TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/** The date of birth a proof vouches for (still valid, still 18+), or null. */
export function verifyAgeToken(token: unknown, now = Date.now()): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = /^(\d{4}-\d{2}-\d{2})\.(\d+)\.([\w-]+)$/.exec(token);
  if (!m) return null;
  const [, dob, exp, sig] = m as unknown as [string, string, string, string];
  const want = Buffer.from(sign(`${dob}.${exp}`));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (Number(exp) < now) return null;
  const age = ageFrom(dob, new Date(now));
  return age !== null && age >= 18 && age <= 120 ? dob : null;
}
