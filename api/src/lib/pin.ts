/**
 * Kid PINs: parent-set (or server-generated) 6-digit codes, stored only as
 * salted scrypt hashes. Brute force is stopped by a per-kid lockout plus a
 * per-IP rate limit (see auth.ts).
 */
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { KID_PIN_LENGTH } from '@myday/shared';
import { HttpError } from './http.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** Wrong PINs before a kid's sign-in locks. */
export const PIN_MAX_FAILS = 5;
export const PIN_LOCK_MINUTES = 15;

/** Easy-to-guess PINs a parent may not pick. */
export function weakPinReason(pin: string): string | null {
  if (!new RegExp(`^\\d{${KID_PIN_LENGTH}}$`).test(pin)) return `PIN must be exactly ${KID_PIN_LENGTH} digits`;
  const d = [...pin].map(Number);
  if (new Set(d).size <= 2) return 'PIN uses too few different digits';
  const steps = d.slice(1).map((v, i) => v - (d[i] ?? 0));
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'PIN is a straight run (like 123456)';
  const half = KID_PIN_LENGTH / 2;
  if (pin.slice(0, half) === pin.slice(half)) return 'PIN repeats itself (like 123123)';
  if (/^(\d)\1(\d)\2(\d)\3$/.test(pin)) return 'PIN is doubled digits (like 112233)';
  return null;
}

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
