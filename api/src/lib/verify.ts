/**
 * Trusted Answers, layers 2 and 4: Hana checks a post's claim, and answers
 * questions, grounded in what MyDay can actually point to:
 *   1. the book "Conquer ADHD Everyday" (lib/library.ts),
 *   2. the curated medical reference (CDC, NIMH, AAP, NICE, peer-reviewed),
 *   3. the Around the Web publisher articles (web_items),
 *   - and established research, named plainly (no made-up links).
 * Sources shown to people are only ones from that list (or a named body like
 * "American Academy of Pediatrics guidance" with no link).
 *
 * Stub (CHAT_STUB, never production): simple rules, so it's testable offline.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { CheckVerdict, PostCheck, SourceRef, TrustedAnswer } from '@myday/shared';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { HttpError } from './http.js';
import { citeBook, searchLibrary } from './library.js';

interface Source {
  label: string;
  url: string | null;
  text: string;
  kind: 'publisher' | 'book' | 'medical';
}

const STOP = new Set('about after again also because been before being could does doing every from have having into just like make more most much need only other over really same should some still such than that their them then there these they this those through very want were what when where which while will with would your yours ours mine adhd kids kid child children parent parents'.split(' '));
const words = (s: string): string[] => [...new Set(s.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [])].filter((w) => !STOP.has(w));

/** The best few things MyDay can point to for this text: the book first, then the medical reference, then publishers. */
export async function sourcesFor(text: string, max = 6): Promise<Source[]> {
  const w = words(text);
  if (!w.length) return [];
  const score = (hay: string): number => {
    const h = hay.toLowerCase();
    return w.reduce((n, x) => n + (h.includes(x) ? 1 : 0), 0);
  };
  const { rows } = await asSystem(() =>
    pool.query<{ publisher: string; title: string; summary: string; url: string }>(
      "SELECT publisher, title, summary, url FROM web_items WHERE status = 'visible' ORDER BY published_at DESC LIMIT 400",
    ),
  );
  const pubs = rows
    .map((r) => ({ s: score(`${r.title} ${r.title} ${r.summary}`), src: { label: `${r.publisher}: ${r.title}`, url: r.url, text: `${r.title}. ${r.summary}`, kind: 'publisher' as const } }))
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.src);
  const lib = searchLibrary(text, { book: 2, medical: 2 });
  const books: Source[] = lib.book.map((p) => ({ label: citeBook(p), url: null, text: p.text.slice(0, 1200), kind: 'book' }));
  const medical: Source[] = lib.medical.map((e) => ({ label: e.source, url: e.url, text: `${e.topic}. ${e.summary}`, kind: 'medical' }));
  return [...books, ...medical, ...pubs].slice(0, max);
}

const listSources = (s: Source[]): string => (s.length ? s.map((x, i) => `[${i}] ${x.label}\n${x.text}`).join('\n\n') : '(none found)');
const pick = (s: Source[], ids: number[]): SourceRef[] => [...new Set(ids)].filter((i) => s[i]).map((i) => ({ label: s[i]!.label, url: s[i]!.url }));

let client: Anthropic | null = null;
function claude(): Anthropic | null {
  const key = process.env.ANTHROPIC_KEY ?? '';
  if (!key) return null;
  client ??= new Anthropic({ apiKey: key, maxRetries: 2, timeout: 60_000 });
  return client;
}
const stubOk = (): boolean => process.env.CHAT_STUB === '1' && !config.production;

const CheckSchema = z.object({
  verdict: z.enum(['supported', 'mixed', 'unsupported', 'personal', 'no_claim']),
  headline: z.string(),
  explanation: z.string(),
  sourceIds: z.array(z.number().int()),
  research: z.string().nullable(),
});

const CHECK_SYSTEM =
  'You are Hana, the assistant inside MyDay, a community of parents with ADHD raising kids with ADHD. A member tapped "Verify with Hana" on a post. ' +
  'Fact-check its claim(s) calmly and kindly, in plain words for a tired parent. Verdicts: supported (matches established evidence), mixed (partly true or depends), ' +
  'unsupported (not backed by evidence, or risky), personal (a personal experience — nothing to fact-check, say that it is valid as one family’s story), no_claim. ' +
  'headline: under 12 words. explanation: 2–4 sentences; if medication is involved, say decisions belong with their prescriber. ' +
  'Ground yourself in the numbered sources when they are relevant and list their numbers in sourceIds; never invent sources or links. ' +
  'If you rely on established research that is not in the list, name it in "research" (e.g. "American Academy of Pediatrics ADHD guideline"), else null.';

/** "Verify with Hana": one fact-check of a post's text. */
export async function verifyClaim(text: string): Promise<PostCheck> {
  const src = await sourcesFor(text);
  const at = new Date().toISOString();
  const c = claude();
  if (!c) {
    if (!stubOk()) throw new HttpError(503, 'Hana needs the AI key to check posts');
    const personal = /\b(I|my|we|our|me)\b/.test(text) && !/\b(you should|everyone should|you need to)\b/i.test(text);
    const meds = /\b(meds?|medication|dose|mg|adderall|ritalin|stimulant)\b/i.test(text);
    const verdict: CheckVerdict = meds && !personal ? 'unsupported' : personal ? 'personal' : src.length ? 'supported' : 'no_claim';
    return {
      verdict,
      headline: { supported: 'This lines up with trusted sources', mixed: 'Partly right', unsupported: 'Not backed by evidence', personal: 'One family’s experience', no_claim: 'Nothing to fact-check here' }[verdict],
      explanation: meds ? 'Medication changes belong with a prescriber — every child responds differently.' : personal ? 'This is someone’s own experience, which is valid. What works for one family may not work for another.' : 'Hana compared this with trusted ADHD sources.',
      sources: src.slice(0, 2).map((s) => ({ label: s.label, url: s.url })),
      checkedAt: at,
    };
  }
  try {
    const res = await c.messages.parse({
      model: process.env.CHAT_MODEL || 'claude-opus-5-5',
      max_tokens: 2000,
      system: CHECK_SYSTEM,
      messages: [{ role: 'user', content: `Sources:\n${listSources(src)}\n\nPost to check:\n<post>\n${text.slice(0, 4000)}\n</post>` }],
      output_config: { effort: 'low', format: zodOutputFormat(CheckSchema) },
    });
    const o = res.parsed_output;
    if (res.stop_reason === 'refusal' || !o) throw new HttpError(502, 'Hana couldn’t check this one — try again later');
    const sources = pick(src, o.sourceIds);
    if (o.research) sources.push({ label: o.research.slice(0, 120), url: null });
    return { verdict: o.verdict, headline: o.headline.slice(0, 120), explanation: o.explanation.slice(0, 900), sources, checkedAt: at };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error('verify: API error', e instanceof Anthropic.APIError ? e.status : e);
    throw new HttpError(502, 'Hana couldn’t check this one right now — try again later');
  }
}

/** Is this post asking something? */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.length >= 12 && (/\?\s*($|\n)/.test(t) || /\?\s+\S/.test(t)) && !/^(lol|haha)\b/i.test(t);
}

const AnswerSchema = z.object({
  answer: z.string(),
  sourceIds: z.array(z.number().int()),
  primaryArticle: z.number().int().nullable(),
  research: z.string().nullable(),
  answerable: z.boolean(),
});

const ANSWER_SYSTEM =
  'You are Hana, the assistant inside MyDay, a community of parents with ADHD raising kids with ADHD. A member asked the community a question. ' +
  'Write the trusted answer that will be pinned above the replies: warm, practical, 3–6 short sentences, ADHD-friendly (one clear next step first). ' +
  'Never give medication or dosing instructions — say that belongs with their prescriber, and what to ask them. ' +
  'Use the numbered sources when relevant (list numbers in sourceIds). If one publisher article answers it best, set primaryArticle to its number. ' +
  'Name any established research you rely on that is not in the list in "research", else null. ' +
  'If it is not really a question that a trusted answer can help (venting, a poll, chit-chat), set answerable to false.';

/** A question's trusted answer (Hana's, or a publisher article's). Null when it isn't really answerable. */
export async function answerQuestion(text: string): Promise<Omit<TrustedAnswer, 'at' | 'replyPostId' | 'by'> | null> {
  const src = await sourcesFor(text);
  const c = claude();
  if (!c) {
    if (!stubOk()) return null;
    const art = src.find((s) => s.kind === 'publisher');
    return art
      ? { source: 'publisher', body: `${art.label.split(':')[0]} covers this well — start here. Every family is different, so take what fits yours.`, sources: [{ label: art.label, url: art.url }] }
      : {
          source: 'hana',
          body: 'Start small: pick one thing to try this week and keep it the same every day. If medication is part of the question, bring it to your child’s prescriber with what you’ve noticed.',
          sources: [],
        };
  }
  try {
    const res = await c.messages.parse({
      model: process.env.CHAT_MODEL || 'claude-opus-5-5',
      max_tokens: 2000,
      system: ANSWER_SYSTEM,
      messages: [{ role: 'user', content: `Sources:\n${listSources(src)}\n\nQuestion:\n<question>\n${text.slice(0, 4000)}\n</question>` }],
      output_config: { effort: 'low', format: zodOutputFormat(AnswerSchema) },
    });
    const o = res.parsed_output;
    if (res.stop_reason === 'refusal' || !o || !o.answerable) return null;
    const sources = pick(src, o.primaryArticle !== null ? [o.primaryArticle, ...o.sourceIds] : o.sourceIds);
    if (o.research) sources.push({ label: o.research.slice(0, 120), url: null });
    const primary = o.primaryArticle !== null ? src[o.primaryArticle] : undefined;
    return { source: primary?.kind === 'publisher' ? 'publisher' : 'hana', body: o.answer.slice(0, 1500), sources };
  } catch (e) {
    console.error('trusted answer: API error', e instanceof Anthropic.APIError ? e.status : e);
    return null;
  }
}
