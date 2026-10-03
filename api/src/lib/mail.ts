/**
 * Transactional email: sign-in links, invites, trial reminders.
 *
 * MAIL_PROVIDER=resend sends through Resend (RESEND_API_KEY, MAIL_FROM — set
 * on the server, never in the repo). =stub (local/tests only) keeps messages
 * in memory, readable at /api/dev/outbox. Unset = email is off: features that
 * need it say so instead of failing silently.
 */
import { config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

const outbox: Array<Mail & { at: string }> = [];

export const mailProvider = (): 'resend' | 'stub' | 'none' => {
  const p = process.env.MAIL_PROVIDER ?? '';
  if (p === 'resend' && process.env.RESEND_API_KEY) return 'resend';
  if (p === 'stub' && !config.production) return 'stub';
  return 'none';
};

export const mailOn = (): boolean => mailProvider() !== 'none';

/** Send one email. Returns false (and logs) instead of throwing — callers decide what to tell the person. */
export async function sendMail(m: Mail): Promise<boolean> {
  const p = mailProvider();
  if (p === 'stub') {
    outbox.push({ ...m, at: new Date().toISOString() });
    if (outbox.length > 50) outbox.shift();
    return true;
  }
  if (p === 'none') return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'MyDay <hello@conquermyday.app>', to: [m.to], subject: m.subject, text: m.text }),
    });
    if (!res.ok) console.error('mail: send failed', res.status);
    return res.ok;
  } catch (e) {
    console.error('mail: send failed', e instanceof Error ? e.message : e);
    return false;
  }
}

/** Local/tests only. */
export const stubOutbox = (): ReadonlyArray<Mail & { at: string }> => outbox;
