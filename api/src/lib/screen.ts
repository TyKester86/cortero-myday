/**
 * The community pre-screen: every Village post/reply and every Feed post (and
 * photo) goes through it before anyone else can see it.
 *
 * Two layers, either one can hold a post for human review:
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
}

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
Hold a post for human review if it contains any of:
- crisis: anyone at risk of self-harm or suicide, or a child or adult being abused or in danger
- personal_info: phone numbers, emails, addresses, a child's name, a school's name, or other identifying household details
- dosage: medication doses or advice to change, start or stop someone's medication
- medical_diagnosis: diagnosing another person or their child
- supplement_cure: claims that a supplement, diet or product cures or reverses ADHD
- personal_attack: insults or attacks on another member
- spam: selling, affiliate links, promotion
Sharing your own experience ("my doctor adjusted my meds and it helped") is fine. Venting about a hard day is fine. Be generous: most posts are fine.
Reply with JSON only: {"hold": true|false, "reasons": [...], "crisis": true|false}`;

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
    const v = JSON.parse(json) as { hold?: unknown; reasons?: unknown; crisis?: unknown };
    const reasons = (Array.isArray(v.reasons) ? v.reasons : []).filter((r): r is ScreenReason => typeof r === 'string' && r in SCREEN_REASONS);
    const crisis = v.crisis === true || reasons.includes('crisis');
    return { hold: v.hold === true || crisis, crisis, reasons };
  } catch (e) {
    console.error('screen: model unavailable', e instanceof Error ? e.message : e);
    return 'unavailable';
  }
}

function merge(rules: ScreenReason[], ai: ScreenResult | 'unavailable' | 'skip'): ScreenResult {
  const reasons = new Set(rules);
  let crisis = rules.includes('crisis');
  let hold = rules.length > 0;
  if (ai === 'unavailable') {
    reasons.add('screen_unavailable');
    hold = true;
  } else if (ai !== 'skip') {
    for (const r of ai.reasons) reasons.add(r);
    crisis ||= ai.crisis;
    hold ||= ai.hold;
  }
  return { hold, crisis, reasons: [...reasons] };
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
