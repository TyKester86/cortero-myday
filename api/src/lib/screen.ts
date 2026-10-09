/**
 * The community pre-screen: every Village post/reply and every Feed post (and
 * photo) goes through it before anyone else can see it.
 *
 * Three outcomes (Trusted Answers, layer 1 + 3):
 *   - allow: most posts. Personal experience ("this worked for me") is fine.
 *   - block: telling OTHER people to start, stop or change medication or
 *     treatment ("you should stop Adderall"), or dangerous advice. Never saved;
 *     the writer gets a plain-language explanation and a way to rephrase.
 *   - hold for a person: everything else that needs a look (gray areas, and
 *     anything the AI isn't confident about). AI flags, people decide.
 *
 * Two layers, either one can hold (or block) a post:
 *   1. Rules (always on, deterministic): phone numbers, emails, street
 *      addresses, a kid's name or school, dosages, cure claims, diagnosing
 *      someone else's child, insults, spam — and crisis words.
 *   2. Claude, when ANTHROPIC_KEY is set: the same policy, judged in context.
 *
 * Held = status 'pending' ("under review"), never a silent delete. Crisis =
 * held too, with 988 shown to the writer and the item at the top of the queue.
 * If the model can't be asked (production without a key, or an API error),
 * the post is held: the screen fails closed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

export const SCREEN_REASONS = {
  crisis: 'Someone may be in danger',
  personal_info: 'Personal details (phone, address, a child’s name or school)',
  dosage: 'Dosage or medication instructions',
  prescribing: 'Telling others to start, stop or change medication or treatment',
  dangerous_advice: 'Advice that could hurt someone',
  low_confidence: 'Our checker wasn’t sure — a person will look',
  medical_diagnosis: 'Diagnosing someone (or their child)',
  supplement_cure: 'Cure or supplement claims',
  personal_attack: 'A personal attack',
  spam: 'Spam or selling',
  image: 'Photo needs a look (a child, or personal details)',
  screen_unavailable: 'Our checker was unavailable — a person will look',
} as const;
export type ScreenReason = keyof typeof SCREEN_REASONS;

export interface ScreenResult {
  hold: boolean;
  crisis: boolean;
  reasons: ScreenReason[];
  /** Not posted at all: the writer sees why and how to say it instead. */
  block?: boolean;
  explain?: string | null;
  rephrase?: string | null;
}

/** Why a post was blocked, in plain words, and how to say it instead (rules' wording; the AI may give its own). */
export const BLOCK_HELP: Partial<Record<ScreenReason, { explain: string; rephrase: string }>> = {
  prescribing: {
    explain: 'This tells someone else to start, stop or change a medication or treatment. Only their prescriber can safely make that call, so we don’t post it.',
    rephrase: 'Share what happened for you instead — for example: “When our doctor changed my son’s dose, mornings got easier. Worth asking yours about.”',
  },
  dangerous_advice: {
    explain: 'This advice could hurt someone if they followed it, so we don’t post it.',
    rephrase: 'Tell your own story and what you learned — and point people to their doctor for the medical part.',
  },
};

/** Words for medicines and treatments (for spotting advice about them). */
const MEDS = '(meds?|medications?|medicines?|adderall|ritalin|vyvanse|concerta|focalin|strattera|qelbree|intuniv|guanfacine|clonidine|stimulants?|dose|dosage|pills?|prescription|therapy|melatonin)';

const RULES: Array<[ScreenReason, RegExp]> = [
  [
    'crisis',
    /\b(kill(ing)? myself|suicid\w*|end (it all|my life)|want(ed)? to die|don'?t want to (live|be here)|self[- ]?harm\w*|cut(ting)? (myself|herself|himself)|hurt(ing)? myself|(hits|beats|chokes) (me|my (kids?|son|daughter))|being abused|abus(e|ing) (me|him|her|them|my))\b/i,
  ],
  ['personal_info', /(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/],
  ['personal_info', /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/],
  // A street address: number + Capitalized name + street type ("12 Oak Street"), not "2 kids and no way".
  ['personal_info', /\b\d{1,5}\s+([A-Z][a-z]+\s){1,3}(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Ct|Court|Way|Pl|Place|Cir|Circle)\b/],
  ['personal_info', /\b[A-Z][a-z]+(\s[A-Z][a-z]+)?\s(Elementary|Middle|High|Primary|Academy|Montessori)(\sSchool)?\b/],
  ['personal_info', /\bmy (son|daughter|kid|child|boy|girl|stepson|stepdaughter)(,| named| called)?\s+[A-Z][a-z]{2,}\b/],
  // Prescribing to others: "you should stop his meds", "just double the dose", "parents need to quit stimulants".
  ['prescribing', new RegExp(`\\b(you|y'?all|everyone|everybody|parents|people|moms|dads|you guys)\\s+(should|must|need to|have to|ought to|gotta|better)\\s+(just\\s+)?(stop|quit|start|skip|double|triple|increase|up|raise|lower|cut|ditch|drop|try|take|give|switch)\\b[^.!?]{0,60}\\b${MEDS}\\b`, 'i')],
  ['prescribing', new RegExp(`(^|[.!?]\\s+)(just\\s+|simply\\s+|definitely\\s+)?(stop|quit|skip|double|triple|increase|up|raise|lower|cut|ditch|drop|try upping|try lowering|try stopping|don'?t (give|take)|never (give|take)|throw out|flush)\\s+(the |your |his |her |their |all )?[^.!?]{0,40}\\b${MEDS}\\b`, 'i')],
  ['dosage', /\b\d+(\.\d+)?\s?(mg|mcg|milligrams?|micrograms?)\b/i],
  ['dosage', /\b(up|double|increase|lower|cut|skip|stop)\s+(his|her|their|your|the)\s+(dose|dosage|meds|medication)\b/i],
  ['medical_diagnosis', /\b(your|her|his|their) (kid|son|daughter|child|boy|girl) (definitely |probably |clearly |obviously )?(has|is) (adhd|autism|autistic|odd|bipolar|add|odd)\b/i],
  ['medical_diagnosis', /\bsounds like (he|she|they|your (kid|son|daughter|child)) (has|have|is) (adhd|autism|autistic|odd|bipolar)\b/i],
  ['supplement_cure', /\b(cure[sd]?|curing|heal(s|ed)?|reverse[sd]?|get rid of)\b.{0,40}\badhd\b|\badhd\b.{0,40}\b(cured|cure|is gone)\b|\b(miracle|natural cure|detox)\b/i],
  ['personal_attack', /\b(you('re| are) (an? )?(idiot|moron|stupid|pathetic|terrible (mom|dad|parent)|bad (mom|dad|parent))|shut up|stfu|loser|go to hell)\b/i],
  ['spam', /\b(buy now|promo code|discount code|use my code|dm me (for|to)|limited time offer|click (here|the link)|earn \$\d+|work from home and)\b/i],
];

export function ruleScreen(text: string): ScreenReason[] {
  const out = new Set<ScreenReason>();
  for (const [reason, re] of RULES) if (re.test(text)) out.add(reason);
  if ((text.match(/https?:\/\//g) ?? []).length > 2) out.add('spam');
  return [...out];
}

const POLICY = `You screen posts for MyDay's adults-only community for parents with ADHD who are raising kids with ADHD.
BLOCK a post (decision "block") only if it tells OTHER people to start, stop, skip or change a medication, dose or treatment
("you should stop Adderall", "just double his dose", "don't give your kid meds"), or gives advice that could clearly hurt someone.
Personal experience is NOT prescribing: "this worked for me", "my doctor adjusted my meds and it helped" are fine.
For a block, also give "explain" (one or two plain, kind sentences on why) and "rephrase" (how to say it as personal experience).
HOLD a post for human review (decision "hold") if it contains any of:
- crisis: anyone at risk of self-harm or suicide, or a child or adult being abused or in danger
- personal_info: phone numbers, emails, addresses, a child's name, a school's name, or other identifying household details
- dosage: medication doses or advice to change, start or stop someone's medication
- medical_diagnosis: diagnosing another person or their child
- supplement_cure: claims that a supplement, diet or product cures or reverses ADHD
- personal_attack: insults or attacks on another member
- spam: selling, affiliate links, promotion
Sharing your own experience ("my doctor adjusted my meds and it helped") is fine. Venting about a hard day is fine. Be generous: most posts are fine.
Use reasons "prescribing" or "dangerous_advice" for blocks. Say how confident you are (0 to 1); if you are unsure about a medical gray area, hold it.
Reply with JSON only: {"decision": "allow"|"hold"|"block", "reasons": [...], "crisis": true|false, "confidence": 0.0-1.0, "explain": "...", "rephrase": "..."}`;

let client: Anthropic | null | undefined;
function claude(): Anthropic | null {
  if (client !== undefined) return client;
  const k = process.env.ANTHROPIC_KEY ?? '';
  client = k ? new Anthropic({ apiKey: k, maxRetries: 2, timeout: 30_000 }) : null;
  return client;
}

type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } };

async function askClaude(content: Block[]): Promise<ScreenResult | 'unavailable' | 'skip'> {
  const c = claude();
  if (!c) return config.production ? 'unavailable' : 'skip';
  try {
    const res = await c.beta.messages.create({
      model: process.env.SCREEN_MODEL || process.env.CHAT_MODEL || 'claude-opus-5-5',
      max_tokens: 200,
      system: POLICY,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (res.stop_reason === 'refusal') return { hold: true, crisis: false, reasons: ['screen_unavailable'] };
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const v = JSON.parse(json) as { hold?: unknown; decision?: unknown; reasons?: unknown; crisis?: unknown; confidence?: unknown; explain?: unknown; rephrase?: unknown };
    const reasons = (Array.isArray(v.reasons) ? v.reasons : []).filter((r): r is ScreenReason => typeof r === 'string' && r in SCREEN_REASONS);
    const crisis = v.crisis === true || reasons.includes('crisis');
    const decision = v.decision === 'block' || v.decision === 'hold' || v.decision === 'allow' ? v.decision : v.hold === true ? 'hold' : 'allow';
    // Layer 3: a call the model isn't sure about goes to a person.
    const unsure = typeof v.confidence === 'number' && v.confidence < 0.6 && decision !== 'allow';
    if (unsure) reasons.push('low_confidence');
    const block = decision === 'block' && !crisis && !unsure;
    if (block && !reasons.some((r) => r === 'prescribing' || r === 'dangerous_advice')) reasons.push('prescribing');
    return {
      hold: decision !== 'allow' || crisis,
      crisis,
      reasons,
      block,
      explain: block && typeof v.explain === 'string' && v.explain.trim() ? v.explain.trim().slice(0, 400) : null,
      rephrase: block && typeof v.rephrase === 'string' && v.rephrase.trim() ? v.rephrase.trim().slice(0, 400) : null,
    };
  } catch (e) {
    console.error('screen: model unavailable', e instanceof Error ? e.message : e);
    return 'unavailable';
  }
}

function merge(rules: ScreenReason[], ai: ScreenResult | 'unavailable' | 'skip'): ScreenResult {
  const reasons = new Set(rules);
  let crisis = rules.includes('crisis');
  let hold = rules.length > 0;
  let block = rules.includes('prescribing');
  let explain: string | null = null;
  let rephrase: string | null = null;
  if (ai === 'unavailable') {
    reasons.add('screen_unavailable');
    hold = true;
  } else if (ai !== 'skip') {
    for (const r of ai.reasons) reasons.add(r);
    crisis ||= ai.crisis;
    hold ||= ai.hold;
    if (ai.block) {
      block = true;
      explain = ai.explain ?? null;
      rephrase = ai.rephrase ?? null;
    }
  }
  // Someone may be in danger: never just refuse — hold it, show resources, escalate.
  if (crisis) block = false;
  if (block) {
    const why = [...reasons].find((r) => BLOCK_HELP[r]) ?? 'prescribing';
    explain ??= BLOCK_HELP[why]?.explain ?? null;
    rephrase ??= BLOCK_HELP[why]?.rephrase ?? null;
  }
  return { hold: hold || block, crisis, reasons: [...reasons], block, explain, rephrase };
}

export async function screenText(text: string): Promise<ScreenResult> {
  return merge(ruleScreen(text), await askClaude([{ type: 'text', text: `Post to screen:\n<post>\n${text}\n</post>` }]));
}

/** Photos: held if they show a child, or personal details (documents, addresses, school names). */
export async function screenImage(data: Buffer, mime: 'image/jpeg' | 'image/png' | 'image/webp'): Promise<ScreenResult> {
  const ai = await askClaude([
    { type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } },
    {
      type: 'text',
      text: 'Screen this photo for the community. Hold it (reason "image") if it shows a child or teen, a face that looks under 18, or personal details such as documents, addresses, license plates or school names; hold it for "crisis" if it shows self-harm or abuse. Otherwise allow it.',
    },
  ]);
  if (ai === 'skip') return { hold: false, crisis: false, reasons: [] };
  if (ai === 'unavailable') return { hold: true, crisis: false, reasons: ['screen_unavailable'] };
  return { hold: ai.hold, crisis: ai.crisis, reasons: ai.hold && !ai.reasons.length ? ['image'] : ai.reasons };
}

/* ---------- ads (the Provider Business Suite): no medical claims, ever ---------- */

/** Medical claims an ad may never make. Describing a service ("ADHD evaluations", "parent coaching") is fine. */
const AD_CLAIMS: Array<[string, string, RegExp]> = [
  ['cure_claim', 'Promises to cure, heal or reverse a condition', /\b(cure[sd]?|curing|heal(s|ed|ing)?|reverse[sd]?|eliminate[sd]?|get rid of)\b[^.!?]{0,40}\b(adhd|add|autism|anxiety|depression|symptoms?)\b|\b(adhd|add)\b[^.!?]{0,30}\b(cured|gone for good)\b/i],
  ['guarantee', 'Guaranteed or permanent results', /\b(guarantee[ds]?|100%|risk[- ]free|permanent(ly)?)\b/i],
  ['proven_claim', '“Clinically proven” / “FDA approved” style claims', /\b(clinically|scientifically|medically|doctor)[- ](proven|tested|approved|recommended)\b|\bfda[- ]?(approved|cleared)\b/i],
  ['medication_advice', 'Telling people to stop, cut or replace medication', /\b(stop|quit|replace|ditch|skip|reduce|wean off|get off|no (more )?need for|instead of)\b[^.!?]{0,30}\b(meds?|medications?|adderall|ritalin|vyvanse|concerta|stimulants?|prescriptions?)\b/i],
  ['miracle_claim', 'Miracle, detox or “natural cure” claims', /\b(miracle|natural cure|detox|secret (cure|remedy))\b/i],
  ['dosage', 'Doses or dosage instructions', /\b\d+(\.\d+)?\s?(mg|mcg|milligrams?|micrograms?)\b/i],
];

const AD_POLICY = `You review ad copy that licensed clinicians run in MyDay's adults-only community for people with ADHD.
REJECT the ad if it makes a medical claim: promising to cure, heal, reverse or eliminate ADHD or another condition; guaranteed or permanent results;
"clinically proven", "FDA approved" or similar claims; telling people to stop, cut, replace or change medication; miracle, detox or natural-cure claims;
before/after promises; dosage instructions; or anything aimed at children. Describing a service is fine ("ADHD evaluations for adults",
"parent coaching", "accepting new patients", "telehealth in Ohio"). Be strict about claims and generous about plain service descriptions.
Reply with JSON only: {"decision": "allow"|"reject", "reasons": ["short reason", ...]}`;

export interface AdScreen {
  /** Empty = the ad may run. */
  reasons: string[];
  /** Plain-language labels for the person writing the ad. */
  labels: string[];
  explain: string;
}

async function askAdReview(text: string): Promise<{ reject: boolean; reasons: string[] } | 'unavailable' | 'skip'> {
  const c = claude();
  if (!c) return config.production ? 'unavailable' : 'skip';
  try {
    const res = await c.beta.messages.create({
      model: process.env.SCREEN_MODEL || process.env.CHAT_MODEL || 'claude-opus-5-5',
      max_tokens: 200,
      system: AD_POLICY,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Ad to review:\n<ad>\n${text}\n</ad>` }] }],
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (res.stop_reason === 'refusal') return { reject: true, reasons: ['Our reviewer couldn’t approve this ad'] };
    const out = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const v = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { decision?: unknown; reasons?: unknown };
    const reasons = (Array.isArray(v.reasons) ? v.reasons : []).filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => r.trim().slice(0, 120)).slice(0, 4);
    return { reject: v.decision === 'reject', reasons };
  } catch (e) {
    console.error('ad screen: model unavailable', e instanceof Error ? e.message : e);
    return 'unavailable';
  }
}

/**
 * Ad copy: refused (never held) if it makes a medical claim — rules first (always on), then Claude in
 * context when ANTHROPIC_KEY is set. Personal details and crisis words are refused too. Fails closed:
 * if the reviewer can't be asked in production, the ad doesn't run yet.
 */
export async function screenAd(text: string): Promise<AdScreen> {
  const reasons: string[] = [];
  const labels: string[] = [];
  for (const [key, label, re] of AD_CLAIMS) {
    if (re.test(text)) {
      reasons.push(key);
      labels.push(label);
    }
  }
  for (const r of ruleScreen(text)) {
    if (r === 'crisis' || r === 'personal_info' || r === 'personal_attack') {
      reasons.push(r);
      labels.push(SCREEN_REASONS[r]);
    }
  }
  if (!reasons.length) {
    const ai = await askAdReview(text);
    if (ai === 'unavailable') {
      reasons.push('screen_unavailable');
      labels.push('Our ad reviewer is unavailable right now — try again in a few minutes');
    } else if (ai !== 'skip' && ai.reject) {
      reasons.push('medical_claim');
      labels.push(...(ai.reasons.length ? ai.reasons : ['Makes a medical claim']));
    }
  }
  const explain = labels.length ? `${labels.join('; ')}. Ads can describe your services, but they can’t promise medical results.` : '';
  return { reasons, labels, explain };
}
