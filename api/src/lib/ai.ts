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
import { config } from '../config.js';
import { HttpError } from './http.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatModel {
  readonly kind: 'claude' | 'stub';
  reply(system: string, messages: ChatTurn[], maxTokens: number): Promise<string>;
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
      if (res.stop_reason === 'refusal') {
        return "I can't help with that one. Want to try asking a different way, or ask a grown-up?";
      }
      const text = res.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      if (!text) throw new HttpError(502, 'Hana had nothing to say — try again');
      return text;
    } catch (e) {
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
    ].filter(Boolean);
    return `[stub reply] You said: "${last.slice(0, 80)}" (${facts.join(', ')})`;
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
