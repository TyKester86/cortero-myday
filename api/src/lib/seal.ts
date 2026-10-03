/**
 * Encryption at rest for community content (Village + Feed): AES-256-GCM,
 * stored as iv(12) | tag(16) | ciphertext in a bytea column next to a key id.
 *
 *   key id 'k': CONTENT_KEY (64 hex) when set — keep a copy in the password
 *               manager, like PHOTO_KEY
 *   key id 's': derived from SESSION_SECRET (HKDF), the default
 *
 * Backups carry the sealed bytes, so they stay unreadable without the key.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from './http.js';

const HEX64 = /^[0-9a-f]{64}$/i;

function key(id: string): Buffer {
  if (id === 'k') {
    const hex = process.env.CONTENT_KEY ?? '';
    if (!HEX64.test(hex)) throw new HttpError(503, 'This was saved with CONTENT_KEY, which is not set on the server');
    return Buffer.from(hex, 'hex');
  }
  return Buffer.from(hkdfSync('sha256', config.sessionSecret, 'myday', 'community-content-key', 32));
}

export const currentKeyId = (): string => (HEX64.test(process.env.CONTENT_KEY ?? '') ? 'k' : 's');

export function sealBytes(plain: Buffer, keyId = currentKeyId()): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(keyId), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function openBytes(stored: Buffer, keyId: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key(keyId), stored.subarray(0, 12));
  d.setAuthTag(stored.subarray(12, 28));
  return Buffer.concat([d.update(stored.subarray(28)), d.final()]);
}

export const sealText = (t: string, keyId = currentKeyId()): Buffer => sealBytes(Buffer.from(t, 'utf8'), keyId);
export const openText = (b: Buffer | null, keyId: string): string => (b ? openBytes(b, keyId).toString('utf8') : '');
