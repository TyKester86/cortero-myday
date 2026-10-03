/**
 * Kid PINs: parent-set (or server-generated) 6-digit codes, stored only as
 * salted scrypt hashes. Brute force is stopped by a per-kid lockout plus a
 * per-IP rate limit (see auth.ts).
 */
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { KID_PIN_LENGTH, weakPinReason } from '@myday/shared';
import { HttpError } from './http.js';

/** The same weak-PIN rules the browser checks (shared). */
export { weakPinReason };

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** Wrong PINs before a kid's sign-in locks. */
export const PIN_MAX_FAILS = 5;
export const PIN_LOCK_MINUTES = 15;

export function generatePin(): string {
  for (;;) {
    let pin = '';
    for (let i = 0; i < KID_PIN_LENGTH; i++) pin += String(randomInt(10));
    if (!weakPinReason(pin)) return pin;
  }
}

export function assertStrongPin(pin: string): void {
  const reason = weakPinReason(pin);
  if (reason) throw new HttpError(400, reason);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = await scrypt(pin, Buffer.from(saltHex, 'hex'), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Tiny in-memory sliding-window limiter (one API process). */
export function rateLimiter(max: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    return recent.length <= max;
  };
}
