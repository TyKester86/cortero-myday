import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { HealthCheck, HouseholdResponse } from '@myday/shared';
import { config } from './config.js';
import { pool } from './db.js';
import { authRouter, kidAccessRouter, loadUser, meHandler, requireAuth } from './auth.js';
import { homeworkRouter } from './routes/homework.js';
import { rewardsRouter } from './routes/rewards.js';
import { errorHandler, HttpError } from './lib/http.js';
import { listMembers } from './lib/members.js';
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
import { chatRouter } from './routes/chat.js';
import { moneyRouter } from './routes/money.js';

if (!config.sessionSecret || config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be set (32+ chars)');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Caddy

app.get('/api/health', (_req, res: Response<HealthCheck>) => {
  res.json({ ok: true });
});

app.use(express.json({ limit: '100kb' }));

const PgStore = connectPgSimple(session);
app.use(
  session({
    name: 'myday.sid',
    store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
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

// CSRF: state-changing API calls must declare JSON (a cross-site form can't).
// Checks the header itself: req.is() returns null for bodyless DELETEs.
app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
  const json = (req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !json) {
    throw new HttpError(415, 'Send JSON');
  }
  next();
});

app.use('/api', loadUser);
app.use(authRouter);

app.get('/api/me', requireAuth, meHandler);

app.use('/api', requireAuth);
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

app.use('/api', (_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'Not found')));

// The web app (built by Vite), with SPA fallback for client routes.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
app.use(express.static(webDist, { index: false, maxAge: '1h' }));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } });
});

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`myday api listening on :${config.port} (tz ${config.tz})`);
  if (config.devLoginToken) console.warn('WARNING: DEV_LOGIN_TOKEN is set — /dev-login is ENABLED (temporary).');
});
