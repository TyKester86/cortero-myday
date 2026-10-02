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
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { config } from '../config.js';
import { HttpError } from './http.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Runs one tool call; the returned text goes back to the model as the tool result. */
export type ToolExec = (name: string, input: unknown) => Promise<string>;

export interface ToolKit {
  tools: BetaTool[];
  exec: ToolExec;
  /** Stub only: the deterministic tool calls for a message (real Claude decides itself). */
  stubPlan: (message: string) => Array<{ name: string; input: unknown }>;
}

export interface ChatModel {
  readonly kind: 'claude' | 'stub';
  reply(system: string, messages: ChatTurn[], maxTokens: number): Promise<string>;
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
    console.error('chat: API error', e.status);
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

  async reply(system: string, messages: ChatTurn[], maxTokens: number): Promise<string> {
    try {
      const res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages,
        // Short, warm chat replies: low effort is plenty and keeps it snappy.
        output_config: { effort: 'low' },
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

/** Local proof only: echoes what it was given so tests can check the wiring. */
class StubModel implements ChatModel {
  readonly kind = 'stub' as const;

  async reply(system: string, messages: ChatTurn[], maxTokens: number): Promise<string> {
    const last = messages[messages.length - 1]?.content ?? '';
    const facts = [
      `turns=${messages.length}`,
      `max_tokens=${maxTokens}`,
      system.includes('never give the final answer') ? 'rule=no-answers' : '',
      system.includes('Socratic tutor') ? 'rule=socratic' : '',
      system.startsWith('You are Hana') ? 'persona=hana' : '',
      system.includes('Their open homework:') ? `ctx=${system.split('Their open homework: ')[1]?.split('.')[0] ?? ''}` : '',
      system.includes('What you can see of their day:') ? 'ctx=day' : '',
      system.includes('QUIZ MODE') ? 'quiz=lecture' : '',
    ].filter(Boolean);
    return `[stub reply] You said: "${last.slice(0, 80)}" (${facts.join(', ')})`;
  }

  async act(system: string, messages: ChatTurn[], kit: ToolKit, maxTokens: number): Promise<string> {
    const last = messages[messages.length - 1]?.content ?? '';
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
