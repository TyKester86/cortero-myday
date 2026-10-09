import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { HealthCheck, HouseholdResponse } from '@myday/shared';
import { config } from './config.js';
import { rawPool, requestScope, sessionPool } from './db.js';
import { authRouter, kidAccessRouter, loadUser, meHandler, requireAuth, requireHousehold } from './auth.js';
import { errorHandler, HttpError } from './lib/http.js';
import { reportError } from './lib/report.js';
import { securityHeaders } from './lib/security.js';
import { listMembers } from './lib/members.js';
import { idempotency, moduleUsed } from './lib/requestlog.js';
import { homeworkRouter } from './routes/homework.js';
import { rewardsRouter } from './routes/rewards.js';
import { choresRouter } from './routes/chores.js';
import { scoreRouter } from './routes/score.js';
import { healthRouter } from './routes/health.js';
import { mealsRouter } from './routes/meals.js';
import { weeklyRouter } from './routes/weekly.js';
import { dayRouter } from './routes/day.js';
import { dumpRouter } from './routes/dump.js';
import { battlesRouter } from './routes/battles.js';
import { familyRouter } from './routes/family.js';
import { householdRouter } from './routes/household.js';
import { householdsRouter } from './routes/households.js';
import { chatRouter } from './routes/chat.js';
import { moneyRouter } from './routes/money.js';
import { extraRouters, preHouseholdRouters, publicRoutes, uploadRoutes } from './routes/index.js';
import { signinRouter } from './routes/signin.js';
import { startSchedulers } from './lib/schedulers.js';
import { readFileSync } from 'node:fs';

if (!config.sessionSecret || config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be set (32+ chars)');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Caddy
app.use(securityHeaders(config.production));

app.get('/api/health', (_req, res: Response<HealthCheck>) => {
  res.json({ ok: true });
});

/** For uptime monitors: also proves the database answers (503 if not). */
app.get('/api/health/deep', async (_req, res) => {
  const started = Date.now();
  try {
    await Promise.race([rawPool.query('SELECT 1'), new Promise((_r, reject) => setTimeout(() => reject(new Error('db timeout')), 3000))]);
    res.set('Cache-Control', 'no-store').json({ ok: true, db: 'ok', ms: Date.now() - started, uptimeS: Math.round(process.uptime()) });
  } catch (e) {
    reportError(e, { route: '/api/health/deep', method: 'GET' });
    res.status(503).set('Cache-Control', 'no-store').json({ ok: false, db: 'down' });
  }
});

/** Local/tests only: a deliberate 500, to prove error reporting works. */
app.get('/api/dev/boom', (req) => {
  if (config.production || !config.devLoginToken || req.query.token !== config.devLoginToken) throw new HttpError(404, 'Not found');
  throw new Error('Deliberate test error (dev only)');
});

process.on('unhandledRejection', (e) => reportError(e, { route: 'unhandledRejection' }));
process.on('uncaughtException', (e) => {
  // State may be broken: report, then let Docker restart a clean process.
  reportError(e, { route: 'uncaughtException' });
  setTimeout(() => process.exit(1), 1000);
});

// Every API request runs on its own connection, pinned to the caller's household.
app.use(['/api', '/dev-login'], requestScope);

const PgStore = connectPgSimple(session);
app.use(
  session({
    name: 'myday.sid',
    store: new PgStore({ pool: sessionPool, tableName: 'session', createTableIfMissing: false }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.production,
      sameSite: 'lax',
      maxAge: 180 * 24 * 60 * 60 * 1000, // stay signed in on the family phones
    },
  }),
);

app.use('/api', loadUser);

// Binary uploads (lecture audio) come before the JSON body parser and the
// JSON-only CSRF rule; they require a custom header a cross-site form can't send.
for (const r of uploadRoutes) app.use(r);
// Public, no sign-in (the calendar .ics feed: calendar apps fetch it with the secret link).
for (const r of publicRoutes) app.use(r);

app.use(express.json({ limit: '200kb' }));

// CSRF: state-changing API calls must declare JSON (a cross-site form can't).
// Checks the header itself: req.is() returns null for bodyless DELETEs.
app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
  const json = (req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !json) {
    throw new HttpError(415, 'Send JSON');
  }
  next();
});

app.use(authRouter);
app.use(signinRouter);

app.get('/api/me', requireAuth, meHandler);

app.use('/api', requireAuth);
app.use('/api', idempotency);
// Signup + onboarding work before you belong to a household.
app.use(householdsRouter);
// Staff/admin routes work without a household of your own.
for (const r of preHouseholdRouters) app.use(r);
app.use('/api', requireHousehold);
app.use('/api', moduleUsed);

app.get('/api/household', async (_req, res: Response<HouseholdResponse>) => {
  res.json({ members: await listMembers() });
});
app.use(kidAccessRouter);
app.use(choresRouter);
app.use(homeworkRouter);
app.use(rewardsRouter);
app.use(scoreRouter);
app.use(healthRouter);
app.use(mealsRouter);
app.use(weeklyRouter);
app.use(dayRouter);
app.use(dumpRouter);
app.use(battlesRouter);
app.use(familyRouter);
app.use(householdRouter);
app.use(chatRouter);
app.use(moneyRouter);
for (const r of extraRouters) app.use(r);

app.use('/api', (_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'Not found')));

// The web app (built by Vite), with SPA fallback for client routes.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
// The service worker must never be cached by the browser's HTTP cache.
app.get('/sw.js', (_req, res) => {
  res.sendFile(path.join(webDist, 'sw.js'), { headers: { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' } });
});
// Hashed build files never change under the same name: cache them for a year.
app.use('/assets', express.static(path.join(webDist, 'assets'), { index: false, maxAge: '365d', immutable: true }));
// redirect: false — /meals and /exercises are both app pages and picture folders; never bounce to "/meals/".
app.use(express.static(webDist, { index: false, maxAge: '1h', redirect: false }));
// The Feed's public landing page (/feed): real title, description and Open Graph tags in the HTML itself, so
// search engines and link previews see them; indexable. Everything else in the app stays out of search.
const FEED_META = {
  title: 'The Feed — a calm community for ADHD adults · MyDay',
  description: 'A calm, supportive community for ADHD adults: share, connect, and build routines that actually stick. Free to join, 18+.',
};
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
let indexHtml: string | null = null;
/** conquermyday.app (and www) serve this page too, routed here by Caddy: its links and previews say so. */
const FEED_HOSTS = /^(www\.)?conquermyday\.app$/;
app.get('/feed', (req, res, next) => {
  try {
    indexHtml ??= readFileSync(path.join(webDist, 'index.html'), 'utf8');
  } catch {
    next();
    return;
  }
  const appUrl = config.publicUrl.replace(/\/$/, '');
  const origin = FEED_HOSTS.test(req.hostname) ? `https://${req.hostname}` : appUrl;
  const url = `${origin}/feed`;
  const head = [
    // Where the app itself lives: on another domain, "Join the Feed" continues there (sign-in is per domain).
    `<meta name="myday-app-url" content="${esc(appUrl)}" />`,
    `<title>${esc(FEED_META.title)}</title>`,
    `<meta name="description" content="${esc(FEED_META.description)}" />`,
    '<meta name="robots" content="index, follow" />',
    `<link rel="canonical" href="${esc(url)}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="MyDay" />',
    `<meta property="og:title" content="${esc(FEED_META.title)}" />`,
    `<meta property="og:description" content="${esc(FEED_META.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(`${origin}/icons/feed-og.png`)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta property="og:image:alt" content="The Feed: the amber bulb horn on dark" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    // The Feed's own mark (the bulb horn), never the MyDay mark.
    '<link rel="icon" type="image/svg+xml" href="/icons/feed-horn.svg" />',
    '<link rel="icon" type="image/png" sizes="32x32" href="/icons/feed-favicon-32.png" />',
    '<link rel="apple-touch-icon" sizes="180x180" href="/icons/feed-icon-180.png" />',
  ].join('\n    ');
  const html = (indexHtml ?? '')
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/<meta name="description"[^>]*>/, '')
    .replace(/\s*<link rel="(icon|apple-touch-icon)"[^>]*>/g, '')
    .replace('</head>', `    ${head}\n  </head>`);
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } });
});

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`myday api listening on :${config.port} (tz ${config.tz})`);
  if (config.devLoginToken) console.warn('WARNING: DEV_LOGIN_TOKEN is set — /dev-login is ENABLED (temporary).');
  startSchedulers();
});
