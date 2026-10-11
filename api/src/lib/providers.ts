/**
 * Provider Knowledge Base v1: providers verified for free earn "Verified provider background" and contribute
 * knowledge to the Feed. Not therapy — not listed, not bookable, no clinical relationship implied.
 *
 *   Gate 1 — NPPES (the public NPI Registry): the NPI exists, the name matches (fuzzy; a weak match goes to a
 *            person, never an automatic no), and at least one taxonomy is a mental-health one.
 *   Gate 2 — OIG LEIE exclusions, mirrored monthly: an NPI on the list is rejected; a name-only match goes to a
 *            person. Every badged provider is re-checked after each refresh; a new NPI hit revokes the badge.
 *
 * Stored: the NPI, the gates' results and timestamps, the badge state. Never an SSN or a date of birth.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { asSystem, pool, tx } from '../db.js';
import { logEvent } from './events.js';
import { notify } from './feednotify.js';
import { HttpError } from './http.js';
import { registerJob } from './schedulers.js';

/* ---------- NPI format (10 digits, Luhn with the 80840 prefix) ---------- */

export function npiValid(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

/* ---------- mental-health taxonomies (NUCC codes) ---------- */

export const MH_TAXONOMIES: Array<{ code: string; label: string }> = [
  { code: '2084P0800X', label: 'Psychiatry' },
  { code: '2084P0804X', label: 'Child & Adolescent Psychiatry' },
  { code: '2084A0401X', label: 'Addiction Psychiatry' },
  { code: '363LP0808X', label: 'Psychiatric/Mental Health Nurse Practitioner' },
  { code: '364SP0808X', label: 'Psychiatric/Mental Health Clinical Nurse Specialist' },
  { code: '103T00000X', label: 'Psychologist' },
  { code: '103TC0700X', label: 'Clinical Psychologist' },
  { code: '103TC2200X', label: 'Clinical Child & Adolescent Psychologist' },
  { code: '103G00000X', label: 'Clinical Neuropsychologist' },
  { code: '1041C0700X', label: 'Clinical Social Worker' },
  { code: '104100000X', label: 'Social Worker' },
  { code: '101YP2500X', label: 'Professional Counselor' },
  { code: '101YM0800X', label: 'Mental Health Counselor' },
  { code: '101YA0400X', label: 'Addiction (Substance Use Disorder) Counselor' },
  { code: '101Y00000X', label: 'Counselor' },
  { code: '106H00000X', label: 'Marriage & Family Therapist' },
  { code: '103K00000X', label: 'Behavior Analyst' },
  { code: '2080P0006X', label: 'Developmental–Behavioral Pediatrics' },
  { code: '225XM0800X', label: 'Occupational Therapist, Mental Health' },
];
/** Anything in these families counts (e.g. every psychiatry or counselor sub-specialty). */
const MH_PREFIXES = ['2084P', '2084A', '2084B0040X', '2084F', '363LP08', '364SP08', '103T', '103G', '102L', '1041', '101Y', '106H', '103K', '106E', '106S', '2080P0006X', '2080P0008X', '225XM0800X', '1835P1300X'];
export const isMentalHealth = (code: string): boolean => MH_PREFIXES.some((p) => code.toUpperCase().startsWith(p));
export const taxonomyLabel = (code: string): string => MH_TAXONOMIES.find((t) => t.code === code)?.label ?? code;

/* ---------- names ---------- */

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'md', 'do', 'phd', 'psyd', 'lcsw', 'lpc', 'lmft', 'np', 'pmhnp', 'rn', 'jr', 'sr', 'ii', 'iii', 'iv']);
export function nameTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.replace(/'/g, ''))
    .filter((t) => t && !TITLES.has(t));
}

/** Jaro–Winkler similarity, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** How well the name they gave matches a registry name (first + last), 0..1. */
export function nameScore(given: string, first: string, last: string): number {
  const g = nameTokens(given);
  const f = nameTokens(first);
  const l = nameTokens(last);
  if (!g.length || !l.length) return 0;
  const gFirst = g[0] ?? '';
  const gLast = g[g.length - 1] ?? '';
  const lastBest = Math.max(...l.map((x) => jaroWinkler(gLast, x)), jaroWinkler(g.slice(1).join(''), l.join('')));
  const firstBest = f.length ? Math.max(...f.map((x) => jaroWinkler(gFirst, x))) : 0;
  return Math.round(((lastBest * 0.6 + firstBest * 0.4) * 1000)) / 1000;
}
export const NAME_MATCH = 0.93;

/* ---------- Gate 1: NPPES ---------- */

export interface NppesRecord {
  npi: string;
  individual: boolean;
  first: string;
  last: string;
  otherNames: Array<{ first: string; last: string }>;
  taxonomies: Array<{ code: string; desc: string; primary: boolean }>;
}

export async function nppesLookup(npi: string): Promise<NppesRecord | null> {
  const url = `${config.nppesUrl}?version=2.1&number=${encodeURIComponent(npi)}`;
  let body: { result_count?: number; results?: Array<Record<string, unknown>>; Errors?: unknown };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`NPPES ${r.status}`);
    body = (await r.json()) as typeof body;
  } catch {
    throw new HttpError(503, 'We couldn’t reach the NPI Registry. Try again in a few minutes.', 'nppes_unavailable');
  }
  const res = body.results?.[0];
  if (!body.result_count || !res) return null;
  const basic = (res.basic ?? {}) as Record<string, string>;
  const others = Array.isArray(res.other_names) ? (res.other_names as Array<Record<string, string>>) : [];
  const tax = Array.isArray(res.taxonomies) ? (res.taxonomies as Array<Record<string, unknown>>) : [];
  return {
    npi: String(res.number ?? npi),
    individual: res.enumeration_type === 'NPI-1',
    first: basic.first_name ?? '',
    last: basic.last_name ?? '',
    otherNames: others.map((o) => ({ first: o.first_name ?? '', last: o.last_name ?? '' })),
    taxonomies: tax.map((t) => ({ code: String(t.code ?? ''), desc: String(t.desc ?? ''), primary: t.primary === true })),
  };
}

/* ---------- Gate 2: OIG exclusions ---------- */

export type OigHit = 'npi' | 'name' | null;

export async function oigCheck(npi: string, first: string, last: string): Promise<{ hit: OigHit; mirrored: boolean }> {
  return asSystem(async () => {
    const { rows: m } = await pool.query<{ rows: number }>('SELECT rows FROM oig_mirror WHERE id = 1');
    if (!m[0]) return { hit: null, mirrored: false };
    const { rowCount: byNpi } = await pool.query('SELECT 1 FROM oig_exclusions WHERE npi = $1 LIMIT 1', [npi]);
    if (byNpi) return { hit: 'npi' as const, mirrored: true };
    const f = nameTokens(first)[0] ?? '';
    const l = nameTokens(last).join(' ');
    if (!f || !l) return { hit: null, mirrored: true };
    const { rowCount: byName } = await pool.query(
      "SELECT 1 FROM oig_exclusions WHERE lower(lastname) = $1 AND split_part(lower(firstname), ' ', 1) = $2 AND (npi IS NULL OR npi = '0000000000' OR npi = '') LIMIT 1",
      [l, f],
    );
    return { hit: byName ? ('name' as const) : null, mirrored: true };
  });
}

/** Parse the LEIE CSV (quoted fields, a header row). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x !== '')) out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    if (row.some((x) => x !== '')) out.push(row);
  }
  return out;
}

/** Download the LEIE file and replace the mirror (names, NPI, state, type, date — no dates of birth). */
export async function refreshOig(url = config.oigCsvUrl): Promise<number> {
  const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`OIG download ${r.status}`);
  const rows = parseCsv(await r.text());
  const head = (rows.shift() ?? []).map((h) => h.trim().toUpperCase());
  const col = (name: string): number => head.indexOf(name);
  const idx = { last: col('LASTNAME'), first: col('FIRSTNAME'), mid: col('MIDNAME'), bus: col('BUSNAME'), npi: col('NPI'), state: col('STATE'), type: col('EXCLTYPE'), date: col('EXCLDATE') };
  if (idx.last < 0 || idx.npi < 0) throw new Error('OIG file: unexpected columns');
  const get = (r2: string[], i: number): string => (i >= 0 ? (r2[i] ?? '').trim() : '');
  await asSystem(() =>
    tx(async (c) => {
      await c.query('DELETE FROM oig_exclusions');
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const vals: string[] = [];
        const tuples = chunk.map((r2, j) => {
          const npi = get(r2, idx.npi);
          vals.push(get(r2, idx.last), get(r2, idx.first), get(r2, idx.mid), get(r2, idx.bus), /^\d{10}$/.test(npi) && npi !== '0000000000' ? npi : '', get(r2, idx.state), get(r2, idx.type), get(r2, idx.date));
          const b = j * 8;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},NULLIF($${b + 5},''),$${b + 6},$${b + 7},$${b + 8})`;
        });
        await c.query(`INSERT INTO oig_exclusions (lastname, firstname, midname, busname, npi, state, excltype, excldate) VALUES ${tuples.join(',')}`, vals);
      }
      await c.query(
        'INSERT INTO oig_mirror (id, source, rows, fetched_at) VALUES (1, $1, $2, now()) ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, rows = EXCLUDED.rows, fetched_at = now()',
        [url, rows.length],
      );
    }),
  );
  return rows.length;
}

/* ---------- the gates, together ---------- */

export interface GateInput {
  legalName: string;
  npi: string;
  taxonomy: string;
}
export type GateResult =
  | { status: 'rejected'; reason: string }
  | { status: 'verified' | 'needs_review'; reason: string | null; nppesName: string; nameScore: number; taxonomies: NppesRecord['taxonomies'] };

export async function runGates(g: GateInput): Promise<GateResult> {
  if (!npiValid(g.npi)) return { status: 'rejected', reason: 'NPI not found' };
  const rec = await nppesLookup(g.npi);
  if (!rec) return { status: 'rejected', reason: 'NPI not found' };
  if (!rec.individual) return { status: 'rejected', reason: 'NPI not found' }; // an organization's NPI, not a person's
  if (!rec.taxonomies.some((t) => isMentalHealth(t.code))) return { status: 'rejected', reason: 'Not a mental-health provider on the NPI record' };
  const names = [{ first: rec.first, last: rec.last }, ...rec.otherNames];
  const score = Math.max(...names.map((n) => nameScore(g.legalName, n.first, n.last)));
  const oig = await oigCheck(g.npi, rec.first, rec.last);
  if (oig.hit === 'npi') return { status: 'rejected', reason: 'Excluded (OIG exclusion list)' };
  const base = { nppesName: `${rec.first} ${rec.last}`.trim(), nameScore: score, taxonomies: rec.taxonomies };
  if (oig.hit === 'name') return { status: 'needs_review', reason: 'Name appears on the OIG exclusion list', ...base };
  if (!oig.mirrored) return { status: 'needs_review', reason: 'Exclusion check pending', ...base };
  if (score < NAME_MATCH) return { status: 'needs_review', reason: 'Name doesn’t match the NPI record closely enough', ...base };
  return { status: 'verified', reason: null, ...base };
}

/* ---------- the provider pass (through sign-in, like the Feed's age proof) ---------- */

const PASS_TTL_MS = 60 * 60_000;
const passSig = (payload: string): string => createHmac('sha256', config.sessionSecret).update(`provider-pass:${payload}`).digest('base64url');

export function providerPass(appId: string, now = Date.now()): string {
  const payload = `prov.${appId}.${now + PASS_TTL_MS}`;
  return `${payload}.${passSig(payload)}`;
}

/** The application a pass vouches for (still valid), or null. */
export function verifyProviderPass(token: unknown, now = Date.now()): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = /^prov\.([0-9a-f-]{36})\.(\d+)\.([\w-]+)$/.exec(token);
  if (!m) return null;
  const [, id, exp, sig] = m as unknown as [string, string, string, string];
  const want = Buffer.from(passSig(`prov.${id}.${exp}`));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want) || Number(exp) < now) return null;
  return id;
}

/* ---------- badge changes ---------- */

const words = {
  verified: 'Your provider background is verified — the badge is on your profile, posts and comments.',
  suspended: 'Your “Verified provider background” badge is paused: providers don’t offer services or steer people to bookings here. A second time removes it.',
  revoked: 'Your “Verified provider background” badge was removed.',
  revokedOig: 'Your “Verified provider background” badge was removed: the NPI appears on the OIG exclusion list.',
  reviewOig: 'Your “Verified provider background” badge is paused while we review a possible match on the OIG exclusion list.',
  rejected: 'We couldn’t verify your provider background.',
};

export async function noticeProvider(userId: number, key: keyof typeof words, extra = ''): Promise<void> {
  await notify({ to: userId, kind: 'provider', actor: null, group: `provider:${key}:${Date.now()}`, url: '/feed/settings/provider', snippet: `${words[key]}${extra}` });
}

export async function setBadge(userId: number, state: 'active' | 'suspended' | 'revoked' | 'none'): Promise<void> {
  await pool.query('UPDATE provider_verifications SET badge_state = $2, badge_changed_at = now() WHERE user_id = $1', [userId, state]);
}

/** A solicitation strike: the first pauses the badge (a warning), the second removes it. */
export async function solicitationStrike(userId: number): Promise<'warned' | 'revoked' | null> {
  const { rows } = await pool.query<{ strikes: number }>(
    "UPDATE provider_verifications SET solicitation_strikes = solicitation_strikes + 1 WHERE user_id = $1 AND badge_state IN ('active', 'suspended') RETURNING solicitation_strikes AS strikes",
    [userId],
  );
  const n = rows[0]?.strikes;
  if (n === undefined) return null;
  if (n >= 2) {
    await setBadge(userId, 'revoked');
    await noticeProvider(userId, 'revoked', ' Offering services or steering people to bookings isn’t allowed here.');
    await logEvent('provider_badge_revoked', { why: 'solicitation' }, null, null);
    return 'revoked';
  }
  await setBadge(userId, 'suspended');
  await noticeProvider(userId, 'suspended');
  await logEvent('provider_badge_suspended', { why: 'solicitation' }, null, null);
  return 'warned';
}

/* ---------- guardrails: patterns (providers only; regular screening still runs for everyone) ---------- */

const CONDITIONS = '(adhd|add|autism|autistic|asd|bipolar|bpd|depression|depressed|anxiety disorder|gad|ocd|ptsd|cptsd|dyslexia|schizophrenia|a personality disorder|an eating disorder|a mood disorder)';
const DIAGNOSIS: RegExp[] = [
  new RegExp(`\\byou(?:'re| are)? (?:clearly |definitely |probably |obviously |likely )?(?:have|has|got|suffer from|are showing signs of)\\s+${CONDITIONS}`, 'i'),
  new RegExp(`\\b(?:sounds|seems|looks) like (?:you(?:'ve| have)?|your (?:son|daughter|kid|child|partner|husband|wife))\\s*(?:got|have|has)?\\s*${CONDITIONS}`, 'i'),
  new RegExp(`\\b(?:you|your (?:son|daughter|kid|child|partner|husband|wife))(?:'re| are| is) (?:clearly |definitely |probably |obviously )?${CONDITIONS}\\b`, 'i'),
  /\b(?:my|this is (?:my|a)) (?:diagnosis|assessment) (?:for|of) you\b/i,
  /\bI(?:'d| would| can) (?:diagnose|assess) you\b/i,
  /\byou (?:meet|fit) (?:the )?(?:criteria|dsm)\b/i,
];
const SOLICIT: RegExp[] = [
  /\b(?:book|schedule|set up) (?:a|an|your)? ?(?:session|appointment|consult(?:ation)?|intake|call) with me\b/i,
  /\b(?:book|schedule) (?:a|an) (?:session|appointment|consult(?:ation)?|intake)\b/i,
  /\bI(?:'m| am)? (?:offer(?:ing)?|provid(?:e|ing)|tak(?:e|ing) (?:on )?new) (?:therapy|counseling|counselling|sessions|clients|patients|coaching|telehealth)\b/i,
  /\b(?:my|our) (?:practice|office|clinic|calendar|booking (?:page|link)|rates?|fees?|sliding scale)\b/i,
  /\b(?:i|we) (?:take|accept) (?:your )?insurance\b/i,
  /\b(?:accept(?:ing)?|tak(?:e|ing)|welcom(?:e|ing)) (?:on )?new (?:patients|clients)\b/i,
  /\b(?:dm|message|email|call|text) me (?:to|for) (?:book|schedule|a session|an appointment|a consult)/i,
  /\b(?:calendly|psychologytoday|simplepractice|zocdoc|headway|alma|growtherapy)\.(?:com|co|io)\b/i,
];
export const looksLikeDiagnosis = (text: string): boolean => DIAGNOSIS.some((r) => r.test(text));
export const looksLikeSolicitation = (text: string): boolean => SOLICIT.some((r) => r.test(text));

/** Is this person a provider in the program (any badge state but rejected)? */
export async function providerState(userId: number): Promise<{ badge: string; status: string } | null> {
  const { rows } = await pool.query<{ badge_state: string; status: string }>("SELECT badge_state, status FROM provider_verifications WHERE user_id = $1 AND status <> 'rejected'", [userId]);
  return rows[0] ? { badge: rows[0].badge_state, status: rows[0].status } : null;
}

/**
 * Provider guardrails on something they're about to post publicly or send: diagnosing in public → held for a
 * moderator; offering services / steering to bookings → held, and a strike. null = nothing to add.
 */
export async function providerGuard(userId: number, text: string, where: 'post' | 'comment' | 'message'): Promise<{ flag: string; reason: string } | null> {
  const p = await providerState(userId);
  if (!p) return null;
  if (looksLikeSolicitation(text)) {
    await solicitationStrike(userId);
    return { flag: 'provider_solicitation', reason: 'Providers don’t offer services or steer people to bookings here' };
  }
  if (where !== 'message' && looksLikeDiagnosis(text)) return { flag: 'provider_diagnosis', reason: 'Providers don’t diagnose, assess or treat in posts or comments' };
  return null;
}

/* ---------- the monthly OIG re-check ---------- */

/** After a refresh: every badged (or pending) provider against the list. A new NPI hit revokes the badge. */
export async function recheckProviders(): Promise<{ checked: number; revoked: number; paused: number; verified: number }> {
  return asSystem(async () => {
    const { rows } = await pool.query<{ user_id: number; npi: string; nppes_name: string | null; legal_name: string; status: string; badge_state: string; reason: string | null; name_score: string | null }>(
      "SELECT user_id, npi, nppes_name, legal_name, status, badge_state, reason, name_score FROM provider_verifications WHERE status <> 'rejected' AND badge_state <> 'revoked'",
    );
    let revoked = 0;
    let paused = 0;
    let verified = 0;
    for (const r of rows) {
      const [first, ...rest] = (r.nppes_name ?? r.legal_name).split(' ');
      const hit = (await oigCheck(r.npi, first ?? '', rest.join(' '))).hit;
      await pool.query('UPDATE provider_verifications SET oig_checked_at = now() WHERE user_id = $1', [r.user_id]);
      if (hit === 'npi') {
        await pool.query("UPDATE provider_verifications SET status = 'rejected', reason = 'Excluded (OIG exclusion list)', badge_state = 'revoked', badge_changed_at = now() WHERE user_id = $1", [r.user_id]);
        await noticeProvider(r.user_id, 'revokedOig');
        await logEvent('provider_badge_revoked', { why: 'oig' }, null, null);
        revoked++;
      } else if (hit === 'name' && r.badge_state === 'active') {
        await pool.query("UPDATE provider_verifications SET status = 'needs_review', reason = 'Name appears on the OIG exclusion list', badge_state = 'suspended', badge_changed_at = now() WHERE user_id = $1", [r.user_id]);
        await noticeProvider(r.user_id, 'reviewOig');
        paused++;
      } else if (!hit && r.status === 'needs_review' && r.reason === 'Exclusion check pending' && Number(r.name_score ?? 0) >= NAME_MATCH) {
        await pool.query("UPDATE provider_verifications SET status = 'verified', reason = NULL, verified_at = now(), badge_state = 'active', badge_changed_at = now() WHERE user_id = $1", [r.user_id]);
        await noticeProvider(r.user_id, 'verified');
        verified++;
      }
    }
    return { checked: rows.length, revoked, paused, verified };
  });
}

/** Monthly: refresh the mirror (or the first time), then re-check everyone. */
export async function monthlyOig(force = false): Promise<{ refreshed: boolean; rows?: number; recheck?: Awaited<ReturnType<typeof recheckProviders>> }> {
  const { rows } = await asSystem(() => pool.query<{ fetched_at: Date }>('SELECT fetched_at FROM oig_mirror WHERE id = 1'));
  const last = rows[0]?.fetched_at;
  if (!force && last && Date.now() - last.getTime() < 30 * 86_400_000) return { refreshed: false };
  const n = await refreshOig();
  const recheck = await recheckProviders();
  await asSystem(() => logEvent('oig_refreshed', { rows: n, revoked: recheck.revoked }, null, null));
  return { refreshed: true, rows: n, recheck };
}

registerJob({ name: 'oig-monthly', everyMs: 24 * 60 * 60 * 1000, run: async () => void (await monthlyOig()) });
