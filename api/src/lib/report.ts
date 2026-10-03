/**
 * Error reporting: every unexpected server error (a 500, an unhandled
 * rejection) is logged and — when configured — sent to Sentry (SENTRY_DSN)
 * and/or a chat webhook (ERROR_WEBHOOK_URL, e.g. a Slack/Discord channel).
 * No SDK; throttled so a bad deploy can't flood anyone. Personal data stays
 * out: only the error, the route and the request id.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

let sentInWindow = 0;
let windowStart = Date.now();
const MAX_PER_MINUTE = 20;

function allowed(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  return ++sentInWindow <= MAX_PER_MINUTE;
}

interface Ctx {
  route?: string;
  method?: string;
}

async function toSentry(dsn: string, e: Error, ctx: Ctx): Promise<void> {
  const m = /^https:\/\/([^@]+)@([^/]+)\/(\d+)$/.exec(dsn);
  if (!m) return;
  const [, key, host, project] = m;
  const eventId = randomUUID().replace(/-/g, '');
  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    environment: config.production ? 'production' : 'staging',
    server_name: 'myday-api',
    transaction: ctx.route ? `${ctx.method ?? ''} ${ctx.route}`.trim() : undefined,
    exception: { values: [{ type: e.name, value: e.message, stacktrace: { frames: (e.stack ?? '').split('\n').slice(1, 20).reverse().map((l) => ({ function: l.trim() })) } }] },
  };
  const envelope = `${JSON.stringify({ event_id: eventId, sent_at: event.timestamp })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
  await fetch(`https://${host}/api/${project}/envelope/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=myday/1.0` },
    body: envelope,
  });
}

async function toWebhook(url: string, e: Error, ctx: Ctx): Promise<void> {
  const where = ctx.route ? ` (${ctx.method ?? ''} ${ctx.route})` : '';
  const text = `MyDay ${config.production ? 'production' : 'staging'} error${where}: ${e.name}: ${e.message}`.slice(0, 1500);
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
}

/** Never throws, never blocks the response. */
export function reportError(err: unknown, ctx: Ctx = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(e);
  if (!allowed()) return;
  const dsn = process.env.SENTRY_DSN;
  const hook = process.env.ERROR_WEBHOOK_URL;
  if (dsn) void toSentry(dsn, e, ctx).catch(() => undefined);
  if (hook) void toWebhook(hook, e, ctx).catch(() => undefined);
}
