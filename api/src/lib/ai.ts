/**
 * The chat model behind Ask Hana and the homework tutor.
 *
 * - Real: Claude via the official Anthropic SDK, key from ANTHROPIC_KEY (never
 *   in the repo). Model from CHAT_MODEL (default claude-opus-5-5). Server-side
 *   refusal fallbacks are on ("default" routing).
 * - Stub: CHAT_STUB=1 outside production — a deterministic local reply used to
 *   prove the wiring end to end without a key. Refused in production.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { config } from '../config.js';
import { HttpError } from './http.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  /** Text, or (for a message with photos/files) content blocks: images, PDFs, text. */
  content: string | BetaContentBlockParam[];
}

/** The words of a turn (attachments left out). */
export const turnText = (t: ChatTurn): string =>
  typeof t.content === 'string' ? t.content : t.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim();

/** Runs one tool call; the returned text goes back to the model as the tool result. */
export type ToolExec = (name: string, input: unknown) => Promise<string>;

export interface ToolKit {
  tools: BetaTool[];
  exec: ToolExec;
  /** Stub only: the deterministic tool calls for a message (real Claude decides itself). */
  stubPlan: (message: string) => Array<{ name: string; input: unknown }>;
}

export interface ReplyOptions {
  /** low (default) for quick chat; medium where getting it right matters more (homework help). */
  effort?: 'low' | 'medium' | 'high';
}

export interface ChatModel {
  readonly kind: 'claude' | 'stub';
  reply(system: string, messages: ChatTurn[], maxTokens: number, opts?: ReplyOptions): Promise<string>;
  /** A reply that may use tools (Hana actions). */
  act(system: string, messages: ChatTurn[], kit: ToolKit, maxTokens: number): Promise<string>;
}

/**
 * One clean answer. A response can carry the same text more than once (e.g. a
 * fallback model's answer alongside the first attempt's, or text re-emitted
 * around tool calls); show it once. Drops repeated text blocks, a paragraph
 * repeated back-to-back, and an answer that is the same text twice.
 */
export function cleanReply(blocks: string[]): string {
  const seen = new Set<string>();
  const uniq = blocks.map((b) => b.trim()).filter((b) => b && !seen.has(b) && seen.add(b));
  const paras: string[] = [];
  for (const p of uniq.join('\n\n').split(/\n{2,}/)) {
    const t = p.trim();
    if (t && t !== paras[paras.length - 1]) paras.push(t);
  }
  let text = paras.join('\n\n');
  const half = Math.floor(text.length / 2);
  for (const cut of [half, half + 1, half - 1]) {
    const a = text.slice(0, cut).trim();
    if (a && a === text.slice(cut).trim()) {
      text = a;
      break;
    }
  }
  return text;
}

const REFUSAL = "I can't help with that one. Want to try asking a different way, or ask a grown-up?";
const MAX_TOOL_ROUNDS = 5;

function apiError(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof Anthropic.AuthenticationError) {
    console.error('chat: ANTHROPIC_KEY was rejected');
    throw new HttpError(503, 'Ask Hana is not set up correctly yet');
  }
  if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'Hana is busy — try again in a minute');
  if (e instanceof Anthropic.APIError) {
    // The API's own words (never the key): a bad tool schema, a low credit balance, a bad model name...
    const body = e.error as { error?: { type?: string; message?: string } } | undefined;
    console.error('chat: API error', e.status, body?.error?.type ?? '', '-', (body?.error?.message ?? e.message).slice(0, 300), e.requestID ? `(request ${e.requestID})` : '');
    if (e.status === 400 && /credit balance/i.test(body?.error?.message ?? '')) throw new HttpError(503, 'Hana’s AI account is out of credit — the person who runs MyDay needs to top it up');
    throw new HttpError(502, 'Hana could not answer right now — try again');
  }
  throw e;
}

class ClaudeModel implements ChatModel {
  readonly kind = 'claude' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async reply(system: string, messages: ChatTurn[], maxTokens: number, opts: ReplyOptions = {}): Promise<string> {
    try {
      const res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages,
        // Short, warm chat replies: low effort is plenty and keeps it snappy (homework help asks for more care).
        output_config: { effort: opts.effort ?? 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      if (res.stop_reason === 'refusal') return REFUSAL;
      const text = cleanReply(res.content.map((b) => (b.type === 'text' ? b.text : '')));
      if (!text) throw new HttpError(502, 'Hana had nothing to say — try again');
      return text;
    } catch (e) {
      return apiError(e);
    }
  }

  /** Manual tool loop: Claude calls MyDay tools until it has a final answer. */
  async act(system: string, messages: ChatTurn[], kit: ToolKit, maxTokens: number): Promise<string> {
    const msgs: BetaMessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await this.client.beta.messages.create({
          model: this.model,
          max_tokens: maxTokens,
          system,
          messages: msgs,
          tools: kit.tools,
          output_config: { effort: 'low' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        if (res.stop_reason === 'refusal') return REFUSAL;
        const text = cleanReply(res.content.map((b) => (b.type === 'text' ? b.text : '')));
        const uses = res.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || uses.length === 0) {
          if (!text) throw new HttpError(502, 'Hana had nothing to say — try again');
          return text;
        }
        msgs.push({ role: 'assistant', content: res.content });
        const results: BetaToolResultBlockParam[] = [];
        for (const u of uses) {
          try {
            results.push({ type: 'tool_result', tool_use_id: u.id, content: await kit.exec(u.name, u.input) });
          } catch (e) {
            const msg = e instanceof HttpError ? e.message : 'That action failed';
            if (!(e instanceof HttpError)) console.error('hana tool failed', u.name, e);
            results.push({ type: 'tool_result', tool_use_id: u.id, content: msg, is_error: true });
          }
        }
        msgs.push({ role: 'user', content: results });
      }
      return 'I took care of what I could — check the actions below.';
    } catch (e) {
      return apiError(e);
    }
  }
}

/** Tests: a message containing this fails the first time it's sent (like a rejected API call), then works. */
const STUB_FAIL = '__stub_fail__';
const stubFailedOnce = new Set<string>();

/** Local proof only: echoes what it was given so tests can check the wiring. */
class StubModel implements ChatModel {
  readonly kind = 'stub' as const;

  async reply(system: string, messages: ChatTurn[], maxTokens: number, opts: ReplyOptions = {}): Promise<string> {
    const lastTurn = messages[messages.length - 1];
    const last = lastTurn ? turnText(lastTurn) : '';
    const blocks = lastTurn && typeof lastTurn.content !== 'string' ? lastTurn.content : [];
    // Tests: a model that makes up the person's numbers, and (rewrite pass) fails to fix them.
    if (system.startsWith('You correct one message')) return last;
    if (last.includes('__stub_fabricate__')) return 'Great work today! Your score is 99 and you’re on a 12-day streak. You have 5000 XP. Want to plan tomorrow?';
    if (last.includes('__stub_markdown__')) return ['Here is a plan:', '', '**Tonight:** lay out clothes.', '', '- Pack the bag', '- Shoes by the door', '', '1. Wake up', '2. *Breakfast*', '', 'That’s it.'].join('\n');
    if (last.includes('__stub_slow__')) await new Promise((r) => setTimeout(r, 1500));
    if (last.includes(STUB_FAIL) && !stubFailedOnce.has(last)) {
      stubFailedOnce.add(last);
      throw new HttpError(502, 'Hana could not answer right now — try again');
    }
    const facts = [
      `turns=${messages.length}`,
      `max_tokens=${maxTokens}`,
      system.includes('HINTS FIRST:') ? 'rule=hints-first' : '',
      system.includes('DIRECT ANSWERS (turned on by their parent)') ? 'rule=direct' : '',
      system.includes('SUBJECT MASTERY:') && system.includes('ACCURACY:') && system.includes('PHOTOS:') ? 'teach=expert' : '',
      ((m) => (m ? `level=${m[1]}` : ''))(system.match(/AGE (\d+):/)),
      opts.effort ? `effort=${opts.effort}` : '',
      system.includes('Socratic tutor') ? 'rule=socratic' : '',
      system.startsWith('You are Hana') ? 'persona=hana' : '',
      ((m) => (m ? `ctx=${m[1]}` : ''))(system.match(/Their open homework, soonest due first: (.+?) — /)),
      system.includes('Their open homework, soonest due first:') ? `due=${system.match(/ — (overdue|due today|due tomorrow|due [A-Z][a-z]{2} \d+|no due date)/)?.[1] ?? ''}` : '',
      system.includes('What you can see of their day:') ? 'ctx=day' : '',
      system.includes('QUIZ MODE') ? 'quiz=lecture' : '',
      system.includes('FROM THE BOOK') ? 'library=book' : '',
      system.includes('FROM THE MEDICAL REFERENCE') ? 'library=medical' : '',
      system.includes('No library passages matched') ? 'library=none' : '',
      system.includes('VERIFIED STATS (live from MyDay') && system.includes('PERSONAL NUMBERS:') ? 'stats=verified' : '',
      blocks.some((b) => b.type === 'image') ? `images=${blocks.filter((b) => b.type === 'image').length}` : '',
      blocks.some((b) => b.type === 'document') ? `pdfs=${blocks.filter((b) => b.type === 'document').length}` : '',
      blocks.some((b) => b.type === 'text' && b.text.startsWith('Attached file')) ? 'textfile' : '',
      ((m) => (m ? `remembers=${(m.match(/#\d+/g) ?? []).length}` : ''))(system.match(/Things you remember about [^(]+\(memory ids\): ([^.]*)/)?.[1] ?? ''),
    ].filter(Boolean);
    return `[stub reply] You said: "${last.slice(0, 80)}" (${facts.join(', ')})`;
  }

  async act(system: string, messages: ChatTurn[], kit: ToolKit, maxTokens: number): Promise<string> {
    const lastTurn = messages[messages.length - 1];
    const last = lastTurn ? turnText(lastTurn) : '';
    const calls = kit.stubPlan(last);
    if (!calls.length) return this.reply(system, messages, maxTokens);
    const out: string[] = [];
    for (const c of calls) {
      try {
        out.push(await kit.exec(c.name, c.input));
      } catch (e) {
        out.push(e instanceof HttpError ? e.message : 'That action failed');
      }
    }
    return `[stub reply] ${out.join(' ')}`;
  }
}

let cached: ChatModel | null | undefined;

/** The configured model, or null when chat isn't set up (no key, no stub). */
export function chatModel(): ChatModel | null {
  if (cached !== undefined) return cached;
  const key = process.env.ANTHROPIC_KEY ?? '';
  if (key) cached = new ClaudeModel(key, process.env.CHAT_MODEL || 'claude-opus-5-5');
  else if (process.env.CHAT_STUB === '1' && !config.production) cached = new StubModel();
  else cached = null;
  return cached;
}
