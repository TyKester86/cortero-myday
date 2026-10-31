/**
 * JP6, the shield: a scam and safety watch over what reaches the family — forwarded mail and the
 * bank. Deterministic rules (an instruction inside a message can't talk them out of it), said to
 * the parents in plain words, once. She WARNS; she never blocks, hides or deletes anything — the
 * message stays in the inbox. A flagged scam's demands are never turned into the family's to-dos.
 */
import type { DateStr, HouseholdMember, ShieldAlert, ShieldKind } from '@myday/shared';
import { pool } from '../../db.js';
import type { MailIn } from '../extract.js';
import { addDays, today } from '../dates.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';
import { normalizeMerchant } from '../money/analyze.js';
import { dayLabel, usd } from '../money/mind.js';
import { SOURCE } from './facts.js';

export const SHIELD_SOURCE = SOURCE.shield;
export const NOTHING_BLOCKED = 'Nothing was blocked — the message is still in the inbox.';

const BRANDS: Array<[string, string]> = [
  ['paypal', 'paypal.com'], ['apple', 'apple.com'], ['icloud', 'apple.com'], ['amazon', 'amazon.com'], ['google', 'google.com'], ['gmail', 'google.com'],
  ['microsoft', 'microsoft.com'], ['outlook', 'microsoft.com'], ['netflix', 'netflix.com'], ['chase', 'chase.com'], ['bank of america', 'bankofamerica.com'],
  ['wells fargo', 'wellsfargo.com'], ['venmo', 'venmo.com'], ['irs', 'irs.gov'], ['usps', 'usps.com'], ['fedex', 'fedex.com'], ['roblox', 'roblox.com'],
  ['epic games', 'epicgames.com'], ['fortnite', 'epicgames.com'], ['instagram', 'instagram.com'], ['tiktok', 'tiktok.com'], ['snapchat', 'snapchat.com'],
];
const MONEY_ASK = /\b(gift ?cards?|wire (?:the )?(?:money|transfer|it)|western union|moneygram|bitcoin|crypto(?:currency)?|zelle|cash ?app|bail(?: money)?|itunes cards?|google play cards?)\b/i;
const URGENT = /\b(urgent(?:ly)?|right away|immediately|asap|as soon as possible|today only|within 24 hours|act now|before it['’]s too late)\b/i;
const SECRET = /\b(don['’]?t tell (?:mom|dad|anyone|your (?:mom|dad|parents))|keep (?:this|it) (?:a )?secret|between (?:us|you and me))\b/i;
const KIN_TROUBLE = /\b(grand(?:ma|pa|mother|father)|it['’]?s me,|i['’]?m in (?:jail|trouble|the hospital)|arrested|car accident|lost my (?:wallet|phone)|this is my new number)\b/i;
const CRED = /\b(verify your (?:account|identity|information)|confirm your (?:password|account|details|identity)|(?:re-?)?enter your password|log ?in (?:here|now|below)|sign ?in (?:here|now|below)|account (?:will be|has been) (?:suspended|locked|closed|limited)|update your (?:payment|billing) (?:info|information|details))\b/i;
const KID_LURE = /\b(free (?:robux|v-?bucks|skins?|gems|coins)|robux|v-?bucks|you(?:['’]ve| have) won|claim (?:your|the) (?:prize|reward|gift)|gift ?card)\b/i;
const SECURITY = /\b(new sign-?in|signed in (?:on|from|to)|password (?:was|has been) changed|security alert|unusual (?:activity|sign-?in)|2-step verification|two-factor|recovery (?:email|phone) (?:was |has been )?changed)\b/i;

const domainOf = (addr: string): string => addr.match(/@([\w.-]+)/)?.[1]?.toLowerCase() ?? '';
const owns = (host: string, brandDomain: string): boolean => host === brandDomain || host.endsWith(`.${brandDomain}`);

export interface Screen {
  kind: ShieldKind;
  text: string;
  signals: string[];
  aboutMember: number | null;
  /** A scam: don't turn its requests into loops, papers or suggestions. */
  scam: boolean;
}

/** Screen one message. Returns the strongest finding, or null. */
export function screenMail(m: MailIn, kids: Array<{ id: number; name: string }>): Screen | null {
  const all = `${m.subject}\n${m.text}`;
  const display = m.from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim() ?? '';
  const sender = domainOf(m.from);
  const hosts = [...all.matchAll(/https?:\/\/([^\s/"'<>?#]+)/gi)].map((x) => (x[1] ?? '').toLowerCase().replace(/^www\./, ''));
  const subject = m.subject.trim() || 'A message';
  const brand = BRANDS.find(([b]) => new RegExp(`\\b${b}\\b`, 'i').test(`${display}\n${m.subject}`)) ?? BRANDS.find(([b]) => new RegExp(`\\b${b}\\b`, 'i').test(m.text) && CRED.test(m.text));
  const brandName = brand ? brand[0].replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Irs$/, 'IRS').replace(/^Usps$/, 'USPS') : '';

  // 1. A family-emergency ("grandparent") scam: kin in trouble + money in an untraceable form, or money + secrecy.
  const ask = all.match(MONEY_ASK)?.[0];
  if (ask && (KIN_TROUBLE.test(all) || SECRET.test(all))) {
    const signals = ['money:' + ask.toLowerCase(), ...(KIN_TROUBLE.test(all) ? ['kin-in-trouble'] : []), ...(URGENT.test(all) ? ['urgent'] : []), ...(SECRET.test(all) ? ['secrecy'] : [])];
    return {
      kind: 'impersonation',
      scam: true,
      aboutMember: null,
      signals,
      text:
        `“${subject}” looks like a family-emergency scam: it asks for ${ask.toLowerCase()}${URGENT.test(all) ? ' in a hurry' : ''}${SECRET.test(all) ? ' and to keep it secret' : ''}. ` +
        'Before anyone sends anything, call the person it claims to be on a number you already have.',
    };
  }

  // 2. Lures aimed at the kids: a kid named, a prize or game currency, and a link or a secret.
  const kid = kids.find((k) => new RegExp(`\\b${k.name}\\b`, 'i').test(all));
  // The most telling phrase first: game currency, then prizes.
  const lure = all.match(/free (?:robux|v-?bucks|skins?|gems|coins)/i)?.[0] ?? all.match(KID_LURE)?.[0];
  if (kid && lure && (hosts.length || SECRET.test(all))) {
    return {
      kind: 'kid_target',
      scam: true,
      aboutMember: kid.id,
      signals: ['kid:' + kid.name, 'lure:' + lure.toLowerCase(), ...(hosts.length ? ['link'] : []), ...(SECRET.test(all) ? ['secrecy'] : [])],
      text: `A message mentioning ${kid.name} offers “${lure}”${SECRET.test(all) ? ' and asks to keep it secret' : ''}. It looks aimed at a kid — worth a word with ${kid.name} before they click anything.`,
    };
  }

  // 3. Phishing: a brand named, a sign-in or payment ask, and the sender or the link isn't the brand.
  if (brand) {
    const fromOther = !!sender && !owns(sender, brand[1]);
    const linkOther = hosts.find((h) => !owns(h, brand[1]));
    const ip = hosts.find((h) => /^\d+\.\d+\.\d+\.\d+(?::\d+)?$/.test(h));
    if (CRED.test(all) && (fromOther || linkOther || ip)) {
      return {
        kind: 'phishing',
        scam: true,
        aboutMember: null,
        signals: ['brand:' + brand[0], ...(fromOther ? ['sender:' + sender] : []), ...(linkOther ? ['link:' + linkOther] : []), 'credential-ask'],
        text:
          `“${subject}” claims to be from ${brandName} but ${fromOther ? `comes from ${sender}` : 'isn’t from them'}${linkOther && linkOther !== sender ? ` and its link goes to ${linkOther}` : ''}. ` +
          `Don’t sign in from it — open ${brandName}’s app or type the address yourself.`,
      };
    }
    // 4. A real account-security alert (from the brand itself): said plainly, with the safe way to act.
    // Quote the alert itself (the body), not just the subject line.
    const sec = m.text.match(SECURITY)?.[0] ?? all.match(SECURITY)?.[0];
    if (sec && !fromOther) {
      return {
        kind: 'account_security',
        scam: false,
        aboutMember: null,
        signals: ['brand:' + brand[0], 'security:' + sec.toLowerCase()],
        text: `${brandName} sent a security alert (“${sec}”). If that wasn’t someone in the family, change the password from the ${brandName} app or website directly — not from a link in the email.`,
      };
    }
  }
  return null;
}

/** Store a mail finding (once per message). */
export async function recordMail(emailId: number, s: Screen): Promise<void> {
  await pool.query(
    `INSERT INTO shield_alerts (kind, ref, email_id, about_member, text, signals) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (household_id, ref) DO NOTHING`,
    [s.kind, `mail:${emailId}`, emailId, s.aboutMember, s.text, s.signals],
  );
}

/** C6 × JP6: a large first-time charge — a merchant the bank hasn't seen in six months. */
export async function bankScan(): Promise<void> {
  const t = today();
  const { rows } = await pool.query<{ id: number; day: DateStr; name: string; merchant: string; amount: string; account: string }>(
    `SELECT t.id, t.day::text AS day, t.name, t.merchant, t.amount, a.name AS account FROM money_transactions t JOIN money_accounts a ON a.id = t.account_id
      WHERE t.day >= $1 AND t.amount >= 200 AND NOT t.pending AND COALESCE(t.category, '') NOT IN ('INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS')`,
    [addDays(t, -3)],
  );
  for (const r of rows) {
    const key = normalizeMerchant({ merchant: r.merchant, name: r.name });
    const { rows: prior } = await pool.query<{ merchant: string; name: string }>('SELECT merchant, name FROM money_transactions WHERE day >= $1 AND day < $2 AND id <> $3', [addDays(r.day, -180), r.day, r.id]);
    if (prior.some((p) => normalizeMerchant(p) === key)) continue;
    const text = `A ${usd(Number(r.amount))} charge from ${r.merchant || r.name} on ${dayLabel(r.day)} (${r.account}) — the first from them in six months. If nobody in the family made it, call the number on the back of the card, not one from an email or text.`;
    await pool.query("INSERT INTO shield_alerts (kind, ref, text, signals) VALUES ('money', $1, $2, $3) ON CONFLICT (household_id, ref) DO NOTHING", [`bank:${r.id}`, text, ['first-time-merchant', `amount:${Number(r.amount)}`]]);
  }
}

export const requireParentShield = (me: HouseholdMember): void => {
  if (me.kind !== 'adult') throw new HttpError(403, 'The shield is for grown-ups');
};

/** A grown-up's warnings: the household's, and those about their own connected messages (JP2) — never another's. */
export async function listAlerts(me: HouseholdMember, all = false): Promise<ShieldAlert[]> {
  const { rows } = await pool.query<{ id: number; kind: ShieldKind; email_id: number | null; about_member: number | null; text: string; signals: string[]; verdict: 'fine' | 'scam' | null; decided_by: number | null; created_at: Date }>(
    `SELECT id, kind, email_id, about_member, text, signals, verdict, decided_by, created_at FROM shield_alerts
      WHERE (for_member IS NULL OR for_member = $1) ${all ? '' : 'AND verdict IS NULL'} ORDER BY created_at DESC, id DESC LIMIT 100`,
    [me.id],
  );
  const names = new Map((await listMembers()).map((m) => [m.id, m.name]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    emailId: r.email_id,
    about: r.about_member === null ? null : (names.get(r.about_member) ?? null),
    text: r.text,
    signals: r.signals,
    verdict: r.verdict,
    decidedBy: r.decided_by === null ? null : (names.get(r.decided_by) ?? null),
    at: r.created_at.toISOString(),
  }));
}

export async function decideAlert(me: HouseholdMember, id: number, verdict: 'fine' | 'scam'): Promise<ShieldAlert> {
  requireParentShield(me);
  const { rowCount } = await pool.query('UPDATE shield_alerts SET verdict = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND (for_member IS NULL OR for_member = $3)', [id, verdict, me.id]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  return (await listAlerts(me, true)).find((a) => a.id === id) as ShieldAlert;
}

/** The watch: each open alert said once to the parents, the same day. */
export async function shieldWatch(parents: HouseholdMember[]): Promise<Array<{ key: string; category: 'shield'; text: string; to?: number[]; sameDay: boolean; subjectId: number | null; source: string; asOf: string; once: true }>> {
  if (!parents.length) return [];
  await bankScan();
  const { rows } = await pool.query<{ id: number; text: string; kind: ShieldKind; about_member: number | null; created_at: Date; for_member: number | null }>(
    'SELECT id, text, kind, about_member, created_at, for_member FROM shield_alerts WHERE verdict IS NULL AND created_at > $1 ORDER BY id',
    [new Date(Date.now() - 3 * 86_400_000)],
  );
  return rows.map((r) => ({
    // A warning about one grown-up's own messages goes to them only.
    ...(r.for_member !== null ? { to: [r.for_member] } : {}),
    key: `shield:${r.id}`,
    category: 'shield' as const,
    text: r.kind === 'money' || r.kind === 'account_security' ? r.text : `${r.text} ${NOTHING_BLOCKED}`,
    // Only a family-emergency ask may break quiet hours (someone may be about to send money).
    sameDay: r.kind === 'impersonation',
    subjectId: r.about_member,
    source: SHIELD_SOURCE,
    asOf: r.created_at.toISOString(),
    once: true as const,
  }));
}
