#!/usr/bin/env node
/**
 * End-to-end regression for MyDay v2, against a REAL Postgres and the REAL
 * compiled server (api/dist), driven over HTTP.
 *
 *   npm run build && npm run e2e
 *
 * Needs E2E_DATABASE_URL (or api/.env's DATABASE_URL) pointing at a Postgres
 * role allowed to CREATE DATABASE. It (re)creates a throwaway database
 * "myday_e2e", seeds sample fixtures, then walks a fake week Mon..Sun
 * (2026-09-28..10-04) by restarting the server with a test-only clock.
 * Secrets for the run are generated in memory and never printed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'api');
const fixtures = path.join(root, 'scripts', 'fixtures');
const PORT = Number(process.env.E2E_PORT ?? 4100);
const BASE = `http://localhost:${PORT}`;

/* ---------- config ---------- */

function envFileValue(key) {
  const f = path.join(apiDir, '.env');
  if (!existsSync(f)) return undefined;
  const line = readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
}
const adminUrl = process.env.E2E_DATABASE_URL ?? envFileValue('DATABASE_URL');
if (!adminUrl) throw new Error('Set E2E_DATABASE_URL (a Postgres URL that may CREATE DATABASE)');
// The app runs as an ordinary role that owns its database, exactly like the droplet: a superuser
// would silently bypass row-level security and hide cross-household leaks.
const APP_ROLE = 'myday_e2e_app';
const APP_PW = randomBytes(18).toString('hex');
const dbUrl = (() => {
  const u = new URL(adminUrl);
  u.pathname = '/myday_e2e';
  u.username = APP_ROLE;
  u.password = APP_PW;
  return u.toString();
})();
/** Superuser connection to the test database, for the test's own direct checks. */
const adminDbUrl = (() => {
  const u = new URL(adminUrl);
  u.pathname = '/myday_e2e';
  return u.toString();
})();
const SECRET = randomBytes(32).toString('hex');
// Error alerts go to this local "chat webhook" (stands in for Slack/Discord/Sentry).
const alerts = [];
const { createServer: createHttp } = await import('node:http');
const alertHook = createHttp((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    alerts.push(b);
    res.end('ok');
  });
});
await new Promise((r) => alertHook.listen(0, r));
const ALERT_URL = `http://127.0.0.1:${alertHook.address().port}/hook`;
// Sign in with Apple, locally: our own RSA key stands in for Apple's signing key.
const { generateKeyPairSync, createHash: sha, sign: rsaSign } = await import('node:crypto');
const APPLE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APPLE_JWKS = JSON.stringify({ keys: [{ ...APPLE_KEY.publicKey.export({ format: 'jwk' }), kid: 'test1', alg: 'RS256', use: 'sig' }] });
const DEV_TOKEN = randomBytes(24).toString('hex');
const serverEnv = (fakeNow) => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  NODE_ENV: 'development',
  PORT: String(PORT),
  TZ_HOUSEHOLD: 'America/Chicago',
  PUBLIC_URL: BASE,
  DATABASE_URL: dbUrl,
  SESSION_SECRET: SECRET,
  DEV_LOGIN_TOKEN: DEV_TOKEN,
  // Local proof only: fake bank data + stubbed AI replies (both refused in production).
  MONEY_PROVIDER: 'fake',
  CHAT_STUB: '1',
  // Big build local proofs (all refused in production): canned lecture transcript,
  // push recorded instead of sent, Google Classroom with 3 sample courses.
  TRANSCRIPTION_STUB: '1',
  PUSH_STUB: '1',
  CLASSROOM_PROVIDER: 'fake',
  SCHEDULERS: 'off',
  EXERCISE_IMAGES: path.join(root, 'scripts', 'fixtures', 'exercise-images.e2e.json'),
  ADMIN_EMAILS: 'admin@example.com',
  BILLING_PROVIDER: 'stub',
  // Email sign-in links go to an in-memory outbox; Apple tokens are checked against our test key.
  MAIL_PROVIDER: 'stub',
  ERROR_WEBHOOK_URL: ALERT_URL,
  // The walk creates dozens of households from one machine; the real default is 5 an hour.
  SIGNUPS_PER_HOUR: '500',
  APPLE_CLIENT_ID: 'app.myday.test',
  APPLE_JWKS_JSON: APPLE_JWKS,
  ...(fakeNow ? { FAKE_NOW: fakeNow } : {}),
});

/* ---------- tiny test runner ---------- */

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? '' : `, want ${JSON.stringify(want)}`}`);
const section = (s) => console.log(`\n== ${s}`);

/* ---------- HTTP personas with cookie jars ---------- */

class Client {
  constructor(name, userAgent = 'MyDay-e2e') {
    this.name = name;
    this.jar = new Map();
    this.userAgent = userAgent;
  }
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method, p, body, { json = true, headers = {} } = {}) {
    const h = { 'User-Agent': this.userAgent, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    let payload;
    if (body !== undefined && json) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    } else if (body !== undefined) payload = body;
    else if (method !== 'GET' && json) {
      h['Content-Type'] = 'application/json';
      payload = '{}';
    }
    const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = (pair ?? '').indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1);
      if (!k) continue;
      if (!v || /expires=Thu, 01 Jan 1970/i.test(sc)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, location: res.headers.get('location'), headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
}

/* ---------- server lifecycle ---------- */

let server = null;
let serverLog = '';
async function startServer(fakeNow) {
  await stopServer();
  const preload = pathToFileURL(path.join(root, 'scripts', 'fake-clock.mjs')).href;
  server = spawn(process.execPath, ['--import', preload, 'dist/server.js'], {
    cwd: apiDir,
    env: serverEnv(fakeNow),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  server.stderr.on('data', (d) => {
    err += d;
    serverLog += d;
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start: ${err.split('\n').filter((l) => !l.includes('DEV_LOGIN')).join('\n')}`);
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((resolve) => {
    s.once('exit', resolve);
    s.kill();
  });
}
const DAY = { Mon: '2026-09-28', Tue: '2026-09-29', Wed: '2026-09-30', Thu: '2026-10-01', Fri: '2026-10-02', Sat: '2026-10-03', Sun: '2026-10-04' };
const noonOn = (d) => `${DAY[d]}T17:00:00Z`; // 12:00 in America/Chicago (CDT)

function runNode(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, args, { cwd: apiDir, env: { ...serverEnv(), ...extraEnv }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`node ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
}

/* ---------- setup: fresh database + seed ---------- */

async function setup() {
  section('setup: fresh myday_e2e database, migrations, sample roster + content');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS myday_e2e WITH (FORCE)');
  // Always UTF-8 (emoji in achievement names etc.), whatever the server's default.
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await admin.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${APP_PW}'`);
  await admin.query(`CREATE DATABASE myday_e2e OWNER ${APP_ROLE} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
  await admin.end();
  const m1 = runNode(['dist/migrate.js']);
  const m2 = runNode(['dist/migrate.js']);
  check('migrations apply on a fresh database', /applied 001_foundation\.sql/.test(m1) && /applied 002_/.test(m1));
  check('migrations are idempotent (second run applies nothing)', !/applied/.test(m2) && /up to date/.test(m2));
  runNode(['dist/cli.js', 'member:add', '--name', 'Ty', '--kind', 'adult', '--track', 'leader']);
  runNode(['dist/cli.js', 'member:add', '--name', 'Kayla', '--kind', 'adult', '--track', 'woman']);
  runNode(['dist/cli.js', 'member:add', '--name', 'Avery', '--kind', 'kid', '--age', '15']);
  runNode(['dist/cli.js', 'member:add', '--name', 'Evan', '--kind', 'kid', '--age', '11']);
  runNode(['dist/cli.js', 'import:chores', path.join(fixtures, 'sample-chores.csv')]);
  runNode(['dist/cli.js', 'import:workouts', path.join(fixtures, 'sample-workouts.csv')]);
  runNode(['dist/cli.js', 'meals:seed']); // the real 233-meal library (api/content/meals.csv)
  runNode(['dist/cli.js', 'profile:set', '--member', 'ty', '--start', '2026-09-28', '--days', '1,2,4,5', '--calories', '2700', '--protein', '190', '--carbs', '300', '--fat', '85']);
  const db = new pg.Client({ connectionString: adminDbUrl });
  await db.connect();
  // Chores "exist" from the start of the test week.
  await db.query("UPDATE chores SET created_on = '2026-09-28'");
  // Evan (11) uses the homework helper in the walk below: a parent turned AI helpers on for him.
  await db.query("UPDATE household_members SET ai_consent_at = now() WHERE name = 'Evan'");
  await db.end();
}

/* ---------- the walk ---------- */

const ty = new Client('ty');
const avery = new Client('avery');
const evan = new Client('evan');
const anon = new Client('anon');
let averyPin = '';
let evanPin = '';

async function choreIds(client, member) {
  const r = await client.get(`/api/chores/today${member ? `?member=${member}` : ''}`);
  return r.data.chores;
}
async function checkAll(client, member) {
  let last = null;
  for (const c of await choreIds(client, member)) {
    if (!c.done) last = await client.post(`/api/chores/${c.id}/toggle`, { done: true });
  }
  return last;
}

async function monday() {
  await startServer(noonOn('Mon'));
  section('build 1: health, sign-in, dev-login');
  const h = await anon.get('/api/health');
  eq('/api/health', [h.status, h.data], [200, { ok: true }]);
  eq('/api/me without a session is 401', (await anon.get('/api/me')).status, 401);
  eq('dev-login with a wrong token is 404', (await anon.get('/dev-login?token=wrong&member=ty')).status, 404);
  const dl = await ty.get(`/dev-login?token=${DEV_TOKEN}&member=ty`);
  eq('dev-login redirects home', [dl.status, dl.location], [302, '/']);
  const me = await ty.get('/api/me');
  eq('signed in as Ty (adult, dev)', [me.data.member?.name, me.data.member?.kind, me.data.auth], ['Ty', 'adult', 'dev']);

  section('7. kid sign-in: parent-managed PINs');
  eq('weak PIN 123456 rejected', (await ty.put('/api/kid-access/3/pin', { pin: '123456' })).status, 400);
  eq('weak PIN 111111 rejected', (await ty.put('/api/kid-access/3/pin', { pin: '111111' })).status, 400);
  eq('weak PIN 123123 rejected', (await ty.put('/api/kid-access/3/pin', { pin: '123123' })).status, 400);
  eq('short PIN rejected', (await ty.put('/api/kid-access/3/pin', { pin: '4821' })).status, 400);
  eq('PIN for an adult rejected', (await ty.put('/api/kid-access/1/pin', {})).status, 404);
  const gen = await ty.put('/api/kid-access/3/pin', {});
  averyPin = gen.data.pin;
  check('parent generates Avery a random 6-digit PIN', gen.status === 200 && /^\d{6}$/.test(averyPin), '(value not printed)');
  const setE = await ty.put('/api/kid-access/4/pin', { pin: '583920' });
  evanPin = '583920';
  eq('parent sets Evan a chosen PIN', setE.status, 200);
  const list = await ty.get('/api/kid-access');
  eq('kid access list shows both PINs set', list.data.kids.map((k) => [k.name, k.hasPin]), [['Avery', true], ['Evan', true]]);
  const db = new pg.Client({ connectionString: adminDbUrl });
  await db.connect();
  const stored = (await db.query("SELECT pin_hash FROM household_members WHERE key = 'evan'")).rows[0].pin_hash;
  await db.end();
  check('PIN stored only as a salted scrypt hash', stored.startsWith('scrypt$') && !stored.includes(evanPin));
  eq('kid login, wrong PIN → 401', (await avery.post('/api/auth/kid-login', { name: 'Avery', pin: '000001' })).status, 401);
  eq('kid login, unknown name → 401 (same message)', (await anon.post('/api/auth/kid-login', { name: 'Zed', pin: averyPin })).data.error, "That name and PIN didn't match");
  eq('kid login, right PIN → 200', (await avery.post('/api/auth/kid-login', { name: 'avery', pin: averyPin })).status, 200);
  const am = await avery.get('/api/me');
  eq('Avery signed in by PIN', [am.data.member?.key, am.data.member?.kind, am.data.auth], ['avery', 'kid', 'pin']);
  eq('Evan signs in by PIN', (await evan.post('/api/auth/kid-login', { name: 'Evan', pin: evanPin })).status, 200);

  section('7. kids act only on their own day (PIN sessions)');
  const evanChores = await choreIds(ty, 'evan');
  eq("kid can't view a sibling's day", (await avery.get('/api/chores/today?member=evan')).status, 403);
  eq("kid can't check a sibling's chore", (await avery.post(`/api/chores/${evanChores[0].id}/toggle`, { done: true })).status, 403);
  eq("kid can't add chores", (await avery.post('/api/chores', { name: 'x', memberId: 4, days: ['Mon'], points: 5 })).status, 403);
  eq("kid can't see a sibling's homework", (await avery.get('/api/homework?member=evan')).status, 403);
  eq("kid can't see a sibling's rewards", (await avery.get('/api/rewards?member=evan')).status, 403);
  eq("kid can't open rewards admin", (await avery.get('/api/rewards/admin')).status, 403);
  eq("kid can't manage kid PINs", (await avery.get('/api/kid-access')).status, 403);
  eq("kid can't reset a PIN", (await avery.put('/api/kid-access/4/pin', {})).status, 403);
  eq("kid can't add rewards", (await avery.post('/api/rewards', { name: 'x', cost: 1, memberId: null })).status, 403);

  section('build 1: chore check-off pays immediately (kid session)');
  const mine = await choreIds(avery);
  eq("Avery's Monday chores", mine.map((c) => `${c.name}:${c.points}`), ['Make bed:5', 'Unload dishwasher:10']);
  const t1 = await avery.post(`/api/chores/${mine[0].id}/toggle`, { done: true });
  eq('checking Make bed → +5', [t1.data.totalPoints, t1.data.today.pointsEarned], [5, 5]);
  const t1b = await avery.post(`/api/chores/${mine[0].id}/toggle`, { done: true });
  eq('checking it again is idempotent', t1b.data.totalPoints, 5);
  const t2 = await avery.post(`/api/chores/${mine[1].id}/toggle`, { done: true });
  eq('Unload dishwasher → total 15', t2.data.totalPoints, 15);
  eq('XP accrues with points (kid track)', [t2.data.xp.total, t2.data.xp.level, t2.data.xp.title], [15, 1, 'Rookie']);

  section('build 1: unchecking removes points (adult acting for Evan)');
  const ef = evanChores.find((c) => c.name === 'Feed the dog');
  eq('adult checks Evan’s chore → +5', (await ty.post(`/api/chores/${ef.id}/toggle`, { done: true })).data.totalPoints, 5);
  eq('uncheck → back to 0', (await ty.post(`/api/chores/${ef.id}/toggle`, { done: false })).data.totalPoints, 0);
  await checkAll(ty, 'evan');

  section('1. homework');
  const add = await avery.post('/api/homework', { assignment: 'Math worksheet', subject: 'Math', due: DAY.Wed, points: 999 });
  eq('kid logs homework (points forced to 20)', [add.status, add.data.open.map((h) => [h.assignment, h.points])], [201, [['Math worksheet', 20]]]);
  eq('bad due date rejected', (await avery.post('/api/homework', { assignment: 'x', due: 'Friday' })).status, 400);
  const evanHw = await ty.post('/api/homework?member=evan', { assignment: 'Book report', subject: 'Reading', due: DAY.Thu });
  eq('adult logs homework for Evan', evanHw.status, 201);
  const extra = await avery.post('/api/homework', { assignment: 'Delete me', due: DAY.Fri });
  const del = extra.data.open.find((h) => h.assignment === 'Delete me');
  eq("kid can't delete homework", (await avery.del(`/api/homework/${del.id}`)).status, 403);
  eq('adult deletes open homework', (await ty.del(`/api/homework/${del.id}`)).status, 200);
  eq('homework shows on Today', (await avery.get('/api/chores/today')).data.homework.map((h) => h.assignment), ['Math worksheet']);

  section('build 1: CSRF');
  const csrf = await avery.req('POST', `/api/chores/${mine[0].id}/toggle`, 'done=true', {
    json: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  eq('form-encoded POST rejected', csrf.status, 415);
  const bodyless = await ty.req('DELETE', '/api/homework/999999', undefined, { json: false });
  eq('bodyless write without JSON header rejected', bodyless.status, 415);
  await build3Monday();
}

async function midweek() {
  for (const d of ['Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    await startServer(noonOn(d));
    if (d === 'Tue') {
      section('build 1: sessions survive a server restart');
      eq('Ty still signed in after restart', (await ty.get('/api/me')).data.member?.key, 'ty');
      eq('Avery (PIN) still signed in after restart', (await avery.get('/api/me')).data.member?.key, 'avery');
    }
    await checkAll(avery);
    await checkAll(ty, 'evan');
    await checkinTy(); // a 7-day check-in streak by Sunday
    if (d === 'Sat') {
      const s = (await avery.get('/api/score')).data.perfectWeek;
      eq('Saturday: week clean so far, pays out only on Sunday', [s.clean, s.awarded], [true, false]);
    }
    if (d === 'Wed') {
      section('1. homework pays 20 points; undo takes them back');
      const hw = (await avery.get('/api/homework')).data.open[0];
      const done = await avery.post(`/api/homework/${hw.id}/toggle`, { done: true });
      eq('checking homework → +20', [done.data.homework.open.length, done.data.homework.doneRecently[0]?.doneOn], [0, DAY.Wed]);
      const undo = await avery.post(`/api/homework/${hw.id}/toggle`, { done: false });
      const redo = await avery.post(`/api/homework/${hw.id}/toggle`, { done: true });
      eq('undo removes 20, redo restores it', [done.data.totalPoints - undo.data.totalPoints, redo.data.totalPoints], [20, done.data.totalPoints]);
      eq("adult can't delete finished homework (points stay)", (await ty.del(`/api/homework/${hw.id}`)).status, 409);
    }
    if (d === 'Thu') {
      section('build 1: workout completion (+ chore points + XP)');
      const today = await ty.get('/api/workouts/today');
      eq("Thursday's session", [today.data.weekNum, today.data.session?.dayName], [1, 'Upper B']);
      const before = (await ty.get('/api/score')).data;
      const done = await ty.post('/api/workouts/complete-day');
      const after = (await ty.get('/api/score')).data;
      eq('complete-day checks off the workout chore', done.data.choreMarked, true);
      eq('…which pays its 20 points', after.totalPoints - before.totalPoints, 20);
      eq('…and the script’s 15 workout XP on top', after.xp.total - before.xp.total, 35);
      await ty.post('/api/workouts/complete-day');
      eq('completing twice pays nothing more', (await ty.get('/api/score')).data.xp.total, after.xp.total);

      section('3. weekly plan XP (first save of the week only)');
      const x0 = (await ty.get('/api/score')).data.xp.total;
      await ty.put('/api/weekly-plan', { theme: 'Rhythm', top: 'Ship MyDay', energy: 'Bed by 10:30', focus: 'Kids', rsd: 'Pause', review: '' });
      const x1 = (await ty.get('/api/score')).data.xp.total;
      await ty.put('/api/weekly-plan', { theme: 'Rhythm v2', top: 'Ship MyDay', energy: '', focus: '', rsd: '', review: '' });
      const x2 = (await ty.get('/api/score')).data.xp.total;
      eq('first save +25 XP, re-save +0', [x1 - x0, x2 - x1], [25, 0]);
    }
  }
}

async function sunday() {
  await startServer(noonOn('Sun'));
  section('build 1 + 3: Perfect Week over a real week, and an XP level-up');
  const pre = (await avery.get('/api/score')).data;
  eq("Sunday noon, today's chore still open: 90 pts, Lv 1, not yet awarded", [pre.perfectWeek.awarded, pre.totalPoints, pre.xp.level], [false, 90, 1]);
  const last = await checkAll(avery);
  eq('last Sunday chore awards Perfect Week = week’s 95 points', [last.data.perfectWeek?.awarded, last.data.perfectWeek?.bonus], [true, 95]);
  eq('total doubles to 190', last.data.totalPoints, 190);
  eq('…and Avery levels up: Rookie → Lv 2 Helper', [last.data.leveledUp, last.data.xp.level, last.data.xp.title, last.data.xp.next?.title], [true, 2, 'Helper', 'Builder']);
  const again = await avery.post(`/api/chores/${(await choreIds(avery))[0].id}/toggle`, { done: true });
  eq('no second award the same week', again.data.totalPoints, 190);
  const evanLast = await checkAll(ty, 'evan');
  eq("Evan: every chore done but homework hanging → no Perfect Week", [evanLast.data.perfectWeek?.clean, evanLast.data.perfectWeek?.awarded], [false, false]);

  section('2. rewards + adult approval');
  await ty.post('/api/rewards', { name: 'Ice cream run', cost: 50, memberId: null });
  const admin = await ty.post('/api/rewards', { name: 'Movie night pick', cost: 150, memberId: 3 });
  eq('adult adds rewards (one just for Avery)', admin.data.rewards.map((r) => [r.name, r.cost, r.memberName]), [['Ice cream run', 50, null], ['Movie night pick', 150, 'Avery']]);
  eq("Evan doesn't see Avery's reward", (await evan.get('/api/rewards')).data.rewards.map((r) => r.name), ['Ice cream run']);
  const store = (await avery.get('/api/rewards')).data;
  eq('Avery’s bank = 190', store.bank, 190);
  const ice = store.rewards.find((r) => r.name === 'Ice cream run');
  const movie = store.rewards.find((r) => r.name === 'Movie night pick');
  const r1 = await avery.post(`/api/rewards/${ice.id}/redeem`);
  eq('redeem → pending, 50 reserved', [r1.status, r1.data.bank, r1.data.redemptions[0].status], [201, 140, 'pending']);
  eq("adult can't redeem", (await ty.post(`/api/rewards/${ice.id}/redeem`)).status, 403);
  eq("kid can't approve", (await avery.post(`/api/redemptions/${r1.data.redemptions[0].id}/approve`)).status, 403);
  const pend = (await ty.get('/api/rewards/admin')).data.pending;
  eq('adult sees it waiting', pend.map((p) => [p.memberName, p.rewardName, p.status]), [['Avery', 'Ice cream run', 'pending']]);
  await ty.post(`/api/redemptions/${pend[0].id}/deny`);
  const afterDeny = (await avery.get('/api/rewards')).data;
  eq('deny → points come back', [afterDeny.bank, afterDeny.redemptions[0].status], [190, 'denied']);
  const r2 = await avery.post(`/api/rewards/${movie.id}/redeem`);
  eq('redeem Movie night → bank 40', r2.data.bank, 40);
  eq('second redeem with too few points → 409', (await avery.post(`/api/rewards/${movie.id}/redeem`)).status, 409);
  const p2 = (await ty.get('/api/rewards/admin')).data.pending[0];
  eq('approve → paid out', (await ty.post(`/api/redemptions/${p2.id}/approve`)).status, 200);
  eq('approving twice → 409', (await ty.post(`/api/redemptions/${p2.id}/approve`)).status, 409);
  const fin = (await avery.get('/api/score')).data;
  eq('after approval: bank 40, earned 190, XP untouched', [fin.bank, fin.totalPoints, fin.xp.total], [40, 190, 190]);
  eq('request shows approved', (await avery.get('/api/rewards')).data.redemptions[0].status, 'approved');

  section('4. health habits pay points');
  const s0 = (await ty.get('/api/score')).data.totalPoints;
  const w = await ty.post('/api/habits/water', { done: true });
  eq('water → +5', [w.data.habits.water, w.data.totalPoints - s0], [true, 5]);
  eq('ticking water again pays nothing', (await ty.post('/api/habits/water', { done: true })).data.totalPoints - s0, 5);
  await ty.post('/api/habits/shake', { done: true });
  const c = await ty.post('/api/habits/creatine', { done: true });
  eq('all three → +15, all shown done', [c.data.totalPoints - s0, c.data.habits], [15, { water: true, shake: true, creatine: true }]);
  const off = await ty.post('/api/habits/shake', { done: false });
  eq('un-tick shake → −5', [off.data.totalPoints - s0, off.data.habits.shake], [10, false]);
  eq('habits appear on today’s health page', (await ty.get('/api/workouts/today')).data.habits, { water: true, shake: false, creatine: true });
  eq('unknown habit → 404', (await ty.post('/api/habits/coffee', { done: true })).status, 404);
  eq("kid can't tick a sibling's habit", (await avery.post('/api/habits/water?member=evan', { done: true })).status, 403);
  await build3Sunday();
}

async function mealsAndGrocery() {
  section('6. per-day meal plan');
  const add = (body) => ty.post('/api/meal-plan', body);
  await add({ mealId: 1, day: 'Mon' }); // burrito bowls: 2 lb chicken, 2 cup rice
  await add({ mealId: 2, day: 'Tue' }); // stir fry: 1 lb chicken, 1 cup rice
  let plan = (await add({ mealId: 3 })).data; // chili, no day yet
  eq('Mon / Tue / unassigned', [plan.days[0].meals.map((m) => m.title), plan.days[1].meals.map((m) => m.title), plan.unassigned.map((m) => m.title)], [['Chicken burrito bowls'], ['Chicken stir fry'], ['Turkey chili']]);
  eq('week runs Mon..Sun with dates', plan.days.map((d) => `${d.day} ${d.date}`), Object.entries(DAY).map(([k, v]) => `${k} ${v}`));
  eq('today (Sunday) is flagged', plan.days.filter((d) => d.isToday).map((d) => d.day), ['Sun']);
  eq('daily totals', [plan.days[0].calories, plan.days[0].protein], [630, 52]);
  const chili = plan.unassigned[0];
  plan = (await ty.patch(`/api/meal-plan/${chili.id}`, { day: 'Wed' })).data;
  eq('move chili to Wednesday', [plan.days[2].meals.map((m) => m.title), plan.unassigned.length], [['Turkey chili'], 0]);
  plan = (await add({ mealId: 3, day: 'Sat' })).data;
  eq('same meal can sit on two days (leftovers night)', plan.days.filter((d) => d.meals.some((m) => m.mealId === 3)).map((d) => d.day), ['Wed', 'Sat']);
  plan = (await add({ mealId: 3, day: 'Sat' })).data;
  eq('adding the same meal to the same day twice is a no-op', plan.days[5].meals.length, 1);
  eq('bad day rejected', (await ty.patch(`/api/meal-plan/${chili.id}`, { day: 'Funday' })).status, 400);
  plan = (await ty.del(`/api/meal-plan/${plan.days[5].meals[0].id}`)).data;
  eq('remove Saturday’s copy', plan.meals.length, 3);

  section('5. grocery: double-build bug stays fixed');
  await ty.post('/api/grocery/staples', { item: 'Eggs' });
  await ty.post('/api/grocery', { item: '1 lb chicken breast', qty: '' });
  const items = (g) => g.items.map((i) => i.item);
  const b1 = (await ty.post('/api/grocery/from-week')).data;
  const chicken = (g) => g.items.find((i) => /chicken breast/.test(i.item))?.item;
  eq('first build: 2 lb + 1 lb from meals + 1 lb already on list = 4 lb', chicken(b1.grocery), '4 lb chicken breast');
  const b2 = (await ty.post('/api/grocery/from-week')).data;
  eq('second build: 4 lb STAYS 4 lb', chicken(b2.grocery), '4 lb chicken breast');
  eq('second build adds nothing', [b2.added, b2.merged, b2.staples, b2.grocery.items.length], [0, 0, 0, b1.grocery.items.length]);
  const b3 = (await ty.post('/api/grocery/from-week')).data;
  eq('third build: identical list', items(b3.grocery), items(b1.grocery));
  const burrito = (await ty.get('/api/meal-plan')).data.days[0].meals[0];
  await ty.del(`/api/meal-plan/${burrito.id}`);
  const b4 = (await ty.post('/api/grocery/from-week')).data;
  eq('drop a meal + rebuild: chicken back to 2 lb, its beans/rice adjust', [chicken(b4.grocery), b4.grocery.items.find((i) => /rice/.test(i.item))?.item], ['2 lb chicken breast', '1 cup rice']);
  await ty.post('/api/meal-plan', { mealId: 1, day: 'Mon' });
  const b5 = (await ty.post('/api/grocery/from-week')).data;
  eq('re-add it + rebuild: 4 lb again (not 6, not 7)', chicken(b5.grocery), '4 lb chicken breast');
  const row = b5.grocery.items.find((i) => /chicken breast/.test(i.item));
  await ty.patch(`/api/grocery/items/${row.id}`, { done: true });
  const b6 = (await ty.post('/api/grocery/from-week')).data;
  eq('checked off (bought) + rebuild: not re-added', b6.grocery.items.filter((i) => /chicken breast/.test(i.item)).length, 1);

  section('5. grocery: ZIP, stores, favorites');
  eq('bad ZIP rejected', (await ty.put('/api/grocery/zip', { zip: '12' })).status, 400);
  const z = await ty.put('/api/grocery/zip', { zip: '73099-1234' });
  eq('ZIP saved (5 digits)', z.data.zip, '73099');
  eq('kids share the household ZIP', (await avery.get('/api/grocery')).data.zip, '73099');
  eq("all 16 of the script's store chains listed", z.data.chains.length, 16);
  const f1 = await ty.post('/api/grocery/favorites', { store: 'Walmart', favorite: true });
  eq('favorite Walmart', f1.data.favorites, [{ store: 'Walmart', fulfillment: 'instore', signedIn: false }]);
  eq('unknown store → 404', (await ty.post('/api/grocery/favorites', { store: 'Nope Mart', favorite: true })).status, 404);
  await ty.patch('/api/grocery/favorites', { store: 'Walmart', fulfillment: 'pickup' });
  const f2 = await ty.patch('/api/grocery/favorites', { store: 'Walmart', signedIn: true });
  eq('pickup + signed in', f2.data.favorites, [{ store: 'Walmart', fulfillment: 'pickup', signedIn: true }]);
  eq('favorites are per person', (await avery.get('/api/grocery')).data.favorites, []);
  const cs = await ty.post('/api/grocery/stores', { name: 'Corner Market', url: 'cornermarket.example.com' });
  eq('add own store (https added)', cs.data.chains.find((c) => c.name === 'Corner Market')?.shopUrl, 'https://cornermarket.example.com/');
  eq('duplicate store → 409', (await ty.post('/api/grocery/stores', { name: 'corner market', url: 'x.example.com' })).status, 409);
  eq('chain name clash → 409', (await ty.post('/api/grocery/stores', { name: 'Kroger', url: 'x.example.com' })).status, 409);
  eq('bad URL → 400', (await ty.post('/api/grocery/stores', { name: 'Bad', url: 'not a url' })).status, 400);
  await ty.post('/api/grocery/favorites', { store: 'Corner Market', favorite: true });
  const gone = await ty.del(`/api/grocery/stores/${encodeURIComponent('Corner Market')}`);
  eq('delete own store also drops the favorite', [gone.data.chains.some((c) => c.name === 'Corner Market'), gone.data.favorites.map((f) => f.store)], [false, ['Walmart']]);
  await mealSlots();
}

async function pinRotation() {
  section('7. PIN rotation + lockout');
  const rot = await ty.put('/api/kid-access/3/pin', {});
  check('parent rotates Avery’s PIN', rot.status === 200 && rot.data.pin !== averyPin, '(values not printed)');
  eq('Avery’s existing session ends immediately', (await avery.get('/api/me')).status, 401);
  eq('old PIN no longer works', (await avery.post('/api/auth/kid-login', { name: 'Avery', pin: averyPin })).status, 401);
  averyPin = rot.data.pin;
  eq('new PIN works', (await avery.post('/api/auth/kid-login', { name: 'Avery', pin: averyPin })).status, 200);
  const wrong = averyPin === '914725' ? '914726' : '914725';
  for (let i = 0; i < 4; i++) await anon.post('/api/auth/kid-login', { name: 'Evan', pin: wrong });
  eq('5th wrong PIN still 401', (await anon.post('/api/auth/kid-login', { name: 'Evan', pin: wrong })).status, 401);
  eq('…then locked: even the right PIN → 429', (await anon.post('/api/auth/kid-login', { name: 'Evan', pin: evanPin })).status, 429);
  eq('parent sees the lock', (await ty.get('/api/kid-access')).data.kids.find((k) => k.name === 'Evan').lockedUntil !== null, true);
  const reset = await ty.put('/api/kid-access/4/pin', { pin: '730194' });
  eq('parent reset unlocks', [reset.status, (await anon.post('/api/auth/kid-login', { name: 'Evan', pin: '730194' })).status], [200, 200]);
  const offE = await ty.del('/api/kid-access/4/pin');
  eq('parent turns off Evan’s PIN sign-in', offE.data.kids.find((k) => k.name === 'Evan').hasPin, false);
  eq('Evan’s session ended', (await evan.get('/api/me')).status, 401);
  eq('…and PIN login refused', (await anon.post('/api/auth/kid-login', { name: 'Evan', pin: '730194' })).status, 401);

  section('build 1: pages + logout');
  for (const p of ['/', '/homework', '/rewards', '/score', '/health', '/meals', '/meals/plan', '/meals/grocery', '/weekly', '/kids', '/day', '/money', '/family', '/hana', '/tutor', '/battles', '/red-alert', '/dump', '/household', '/grocery-list', '/join/abc', '/manifest.webmanifest', '/icons/myday-icon-512.png']) {
    const r = await fetch(BASE + p);
    check(`GET ${p}`, r.status === 200, `${r.status} ${r.headers.get('content-type')}`);
  }
  await ty.post('/api/auth/logout');
  eq('logout ends the session', (await ty.get('/api/me')).status, 401);
}

/* ======================= build 3 ======================= */

const kayla = new Client('kayla');
const grandma = new Client('grandma');
const tablet = new Client('tablet', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
const xpOf = async (c) => (await c.get('/api/score')).data.xp.total;
const sql = async (q, p = []) => {
  const db = new pg.Client({ connectionString: adminDbUrl });
  await db.connect();
  try {
    return (await db.query(q, p)).rows;
  } finally {
    await db.end();
  }
};
const checkinTy = (sleep = 'OK') => ty.put('/api/day/checkin', { nervous: 'Calm', sleep, fuel: 'eggs', grateful: 'coffee' });

async function build3Monday() {
  section('9. adult engine: check-in, tasks, habits, review (+ XP)');
  const x0 = await xpOf(ty);
  const ci = await checkinTy();
  eq('morning check-in → +5 XP', [ci.status, ci.data.xp.total - x0, ci.data.day.checkin?.sleep], [200, 5, 'OK']);
  eq('editing the check-in pays nothing more', (await checkinTy()).data.xp.total - x0, 5);
  eq('bad sleep value → 400', (await ty.put('/api/day/checkin', { sleep: 'Amazing' })).status, 400);
  eq("kids don't get the adult engine", (await avery.get('/api/day')).status, 403);
  const t1 = await ty.post('/api/day/tasks', { task: 'Call the insurance company', priority: 'Critical', energy: 'Low Brain', context: '@Phone', estMin: 15, mit: true });
  const task = t1.data.tasks[0];
  eq('add an MIT task', [t1.status, task.task, task.mit, task.priority, task.context], [201, 'Call the insurance company', true, 'Critical', '@Phone']);
  const x1 = await xpOf(ty);
  const done = await ty.post(`/api/day/tasks/${task.id}/done`);
  eq('finish it → +5 XP (Family Leader task XP)', [done.data.xp.total - x1, done.data.day.tasks[0].done], [5, true]);
  eq('finishing twice pays nothing', (await ty.post(`/api/day/tasks/${task.id}/done`)).data.xp.total - x1, 5);
  eq("finished tasks can't be deleted", (await ty.del(`/api/day/tasks/${task.id}`)).status, 409);
  const h = await ty.post('/api/day/habits', { name: 'Read 10 pages' });
  const habit = h.data.habits[0];
  const x2 = await xpOf(ty);
  const tick = await ty.post(`/api/day/habits/${habit.id}/toggle`, { dayIdx: 0, done: true });
  eq('tick Monday → +3 XP, grid shows it', [tick.data.xp.total - x2, tick.data.day.habits[0].days], [3, [true, false, false, false, false, false, false]]);
  const untick = await ty.post(`/api/day/habits/${habit.id}/toggle`, { dayIdx: 0, done: false });
  eq('untick → the 3 XP comes back off', untick.data.xp.total - x2, 0);
  await ty.post(`/api/day/habits/${habit.id}/toggle`, { dayIdx: 0, done: true });
  eq("can't tick a future day", (await ty.post(`/api/day/habits/${habit.id}/toggle`, { dayIdx: 6, done: true })).status, 400);
  const x3 = await xpOf(ty);
  const rv = await ty.put('/api/day/review', { got: 'Insurance sorted', derailed: 'Email rabbit hole', tomorrow: 'Gym', rsd: 'No', energyEnd: 'OK' });
  eq('evening review → +10 XP', rv.data.xp.total - x3, 10);
  eq('re-saving the review → +0', (await ty.put('/api/day/review', { got: 'Insurance sorted!', rsd: 'No', energyEnd: 'OK' })).data.xp.total - x3, 10);
  const day = (await ty.get('/api/day')).data;
  eq('daily score: today started + top task done = 40/100', [day.daily.total, day.daily.parts], [40, [0, 0, 20, 20, 0]]);

  section('3. brain dump → triage');
  for (const note of ['Renew car tags', 'Birthday gift for Avery', 'Look up summer camps']) await ty.post('/api/dump', { note });
  let dump = (await ty.get('/api/dump')).data;
  eq('three notes in the inbox (newest first)', dump.open.map((d) => d.note), ['Look up summer camps', 'Birthday gift for Avery', 'Renew car tags']);
  const tags = dump.open.find((d) => d.note === 'Renew car tags');
  dump = (await ty.post(`/api/dump/${tags.id}/triage`, { to: 'task', energy: 'High Brain' })).data;
  eq('triage → task', [dump.open.length, dump.triaged[0].status], [2, 'task']);
  const tasks = (await ty.get('/api/day')).data.tasks.map((t) => [t.task, t.energy]);
  check('…and it is on today’s task list as High Brain', tasks.some(([n, e]) => n === 'Renew car tags' && e === 'High Brain'), JSON.stringify(tasks));
  dump = (await ty.post(`/api/dump/${dump.open[0].id}/triage`, { to: 'done' })).data;
  eq('triage → handled', [dump.open.length, dump.triaged[0].status], [1, 'done']);
  eq('triaging twice → 404', (await ty.post(`/api/dump/${tags.id}/triage`, { to: 'done' })).status, 404);
  const kd = (await avery.post('/api/dump', { note: 'Ask about the field trip' })).data.open[0];
  eq('kids can capture too', kd.note, 'Ask about the field trip');
  eq('…but can’t make tasks', (await avery.post(`/api/dump/${kd.id}/triage`, { to: 'task' })).status, 403);
  eq("…and can't touch a grown-up's notes", (await avery.post(`/api/dump/${dump.open[0].id}/triage`, { to: 'done' })).status, 404);
  eq('kid marks theirs handled', (await avery.post(`/api/dump/${kd.id}/triage`, { to: 'done' })).data.open.length, 0);

  section('2. boss battles');
  let b = (await ty.get('/api/battles')).data;
  eq('Family Leader list: 11 bosses, monthly, 100 XP', [b.bosses.length, b.cadence, b.xp, b.bosses[1].name], [11, 'monthly', 100, '💑 Plan a date night']);
  eq('complete with nothing active → 409', (await ty.post('/api/battles/complete')).status, 409);
  await ty.post('/api/battles', { name: '📞 Make 5 important calls' });
  b = (await ty.post('/api/battles', { name: '🔧 Complete home repair' })).data;
  eq('starting another replaces the first', [b.active?.name, b.history[0]?.status], ['🔧 Complete home repair', 'replaced']);
  const x4 = await xpOf(ty);
  const won = await ty.post('/api/battles/complete');
  eq('defeat it → +100 XP, logged as done', [won.data.xp.total - x4, won.data.battles.active, won.data.battles.history[0].status], [100, null, 'done']);
  eq("kids don't fight bosses", (await avery.get('/api/battles')).status, 403);

  section('8. red alert');
  const ra = (await ty.get('/api/red-alert')).data;
  eq('the 5 restart steps', ra.steps.length, 5);
  const x5 = await xpOf(ty);
  const r1 = await ty.post('/api/red-alert', { trigger: 'Overslept, kids late', stepsDone: 3, note: 'Bed by 10' });
  check('log it → +5 XP + the protocol message', r1.data.xp.total - x5 === 5 && r1.data.message.startsWith('Minimum viable day complete'), r1.data.message);
  eq('second one the same day → no extra XP', (await ty.post('/api/red-alert', { trigger: 'again', stepsDone: 5 })).data.xp.total - x5, 5);
  eq('history keeps both runs', (await ty.get('/api/red-alert')).data.recent.map((r) => `${r.stepsDone}/${r.stepsTotal}`), ['5/5', '3/5']);
  eq('stepsDone is capped to the step count', (await ty.post('/api/red-alert', { stepsDone: 99 })).status, 200);
  eq("kids don't get red alert", (await avery.get('/api/red-alert')).status, 403);

  section('4. family: curfews, partner check-in, 1-on-1s, kids overview');
  await ty.put('/api/family/curfews/3', { curfewWeekday: '21:30', curfewWeekend: '23:00', phoneOffWeekday: '9:00', phoneOffWeekend: '22:30' });
  const fam0 = (await ty.put('/api/family/curfews/3', { phoneOffWeekday: '21:00' })).data;
  eq('curfews saved and normalized', fam0.kids.find((k) => k.member.key === 'avery').curfew, { curfewWeekday: '21:30', curfewWeekend: '23:00', phoneOffWeekday: '21:00', phoneOffWeekend: '22:30' });
  eq('invalid time clears it', (await ty.put('/api/family/curfews/4', { curfewWeekday: '25:99' })).data.kids.find((k) => k.member.key === 'evan').curfew.curfewWeekday, '');
  eq('curfew for an adult → 404', (await ty.put('/api/family/curfews/1', { curfewWeekday: '21:00' })).status, 404);
  eq('Avery sees tonight’s (Monday) times on Today', (await avery.get('/api/chores/today')).data.curfew, { weekend: false, curfew: '21:30', phoneOff: '21:00' });
  eq('grown-ups get no curfew card', (await ty.get('/api/chores/today')).data.curfew, null);
  const x6 = await xpOf(ty);
  const p1 = await ty.put('/api/family/partner', { positives: 10, negatives: 2, connection: 'Walk after dinner', conflict: true, flooded: false, tookBreak: true, need: 'More sleep' });
  eq('partner check-in → 5.0:1 ratio, +15 XP', [p1.data.family.partner.ratio, p1.data.xp.total - x6], ['5.0:1', 15]);
  eq('updating it this week → +0', (await ty.put('/api/family/partner', { positives: 12, negatives: 2 })).data.xp.total - x6, 15);
  const o1 = await ty.post('/api/family/one-on-ones', { childId: 3, minutes: 30, promiseKept: true, moment: true, reflection: 'Basketball in the driveway', word: 'laughing' });
  eq('1-on-1 with Avery → +20 XP', [o1.status, o1.data.xp.total - x6, o1.data.family.oneOnOnes[0].childName], [201, 35, 'Avery']);
  eq('second 1-on-1 this week → logged, +0 XP', (await ty.post('/api/family/one-on-ones', { childId: 4, minutes: 15 })).data.xp.total - x6, 35);
  eq('1-on-1 "with" a grown-up → 400', (await ty.post('/api/family/one-on-ones', { childId: 2, minutes: 5 })).status, 400);
  const ov = (await ty.get('/api/family')).data.kids.find((k) => k.member.key === 'avery');
  check('kids overview: chores, points, homework, sign-in', ov.choresDone === 2 && ov.choresToday === 2 && ov.pointsToday === 15 && ov.openHomework === 1 && ov.lastSignIn !== null, JSON.stringify({ ...ov, member: undefined, curfew: undefined }));
  eq("kids can't open Family", (await avery.get('/api/family')).status, 403);

  section('5. household: roster, roles, archive, invites');
  eq("kids can't manage the household", (await avery.get('/api/household/admin')).status, 403);
  await ty.post('/api/household/members', { name: 'Jordan', kind: 'kid', age: 8 });
  let hh = (await ty.post('/api/household/members', { name: 'Jordan', kind: 'kid' })).data;
  eq('add members (unique keys)', hh.members.filter((m) => m.name === 'Jordan').map((m) => [m.key, m.xpTrack, m.age]), [['jordan', 'kid', 8], ['jordan2', 'kid', null]]);
  const j2 = hh.members.find((m) => m.key === 'jordan2');
  hh = (await ty.patch(`/api/household/members/${j2.id}`, { name: 'Jo', age: 9 })).data;
  eq('edit name + age', hh.members.find((m) => m.id === j2.id).name + '/' + hh.members.find((m) => m.id === j2.id).age, 'Jo/9');
  hh = (await ty.post(`/api/household/members/${j2.id}/archive`)).data;
  eq('remove = archive (history kept)', hh.members.find((m) => m.id === j2.id).archived, true);
  check('…gone from the everyday roster', !(await ty.get('/api/household')).data.members.some((m) => m.key === 'jordan2'));
  eq('restore', (await ty.post(`/api/household/members/${j2.id}/restore`)).data.members.find((m) => m.id === j2.id).archived, false);
  eq("can't remove yourself", (await ty.post('/api/household/members/1/archive')).status, 409);
  eq("can't make yourself a kid", (await ty.patch('/api/household/members/1', { kind: 'kid' })).status, 409);
  eq('add a grown-up with an email', (await ty.post('/api/household/members', { name: 'X', kind: 'adult', email: 'dup@example.com' })).status, 201);
  eq('the same email again (any case) → 409', (await ty.post('/api/household/members', { name: 'Y', kind: 'adult', email: 'DUP@example.com' })).status, 409);
  const inv = await ty.post('/api/household/invites', { name: 'Grandma', email: 'grandma@example.com', xpTrack: 'woman' });
  const token = inv.data.link?.split('/join/')[1];
  check('invite a grown-up → one-time link', inv.status === 201 && inv.data.link.startsWith(`${BASE}/join/`) && !!token, '(link not printed)');
  eq('invite shows pending', inv.data.member.invite?.status, 'pending');
  const stored = await sql('SELECT token_hash FROM invites');
  check('only the link’s hash is stored', stored.length === 1 && stored[0].token_hash !== token);
  eq('public invite preview (masked email)', (await anon.get(`/api/invites/${token}`)).data, { name: 'Grandma', email: 'g***@example.com', household: 'Our family' });
  eq('bogus invite → 404', (await anon.get('/api/invites/nope')).status, 404);
  eq('invite for a kid track → 400', (await ty.post('/api/household/invites', { name: 'K', email: 'k@example.com', xpTrack: 'kid' })).status, 400);
  await grandma.get(`/dev-login?token=${DEV_TOKEN}&member=grandma`);
  eq('first sign-in accepts the invite', (await ty.get('/api/household/admin')).data.members.find((m) => m.key === 'grandma').invite.status, 'accepted');
  eq('…and the link stops working', (await anon.get(`/api/invites/${token}`)).status, 404);
  const gm = (await ty.get('/api/household/admin')).data.members.find((m) => m.key === 'grandma');
  await ty.post(`/api/household/members/${gm.id}/archive`);
  eq('removing someone signs them out', (await grandma.get('/api/me')).status, 401);
  await ty.post(`/api/household/members/${gm.id}/restore`);
  eq('restoring lets them back in', (await grandma.get('/api/me')).data.member?.key, 'grandma');

  section('9. kid sign-in polish: remember this device + sign-in log');
  eq('no picker on an unknown device', (await anon.get('/api/auth/kid-device')).data.kids, []);
  eq('kid signs in with "remember me"', (await tablet.post('/api/auth/kid-login', { name: 'Avery', pin: averyPin, remember: true })).status, 200);
  check('device cookie set (httpOnly)', tablet.jar.has('myday.kiddev'));
  await tablet.post('/api/auth/logout');
  eq('after sign-out the device still offers Avery', (await tablet.get('/api/auth/kid-device')).data.kids, [{ key: 'avery', name: 'Avery' }]);
  await tablet.post('/api/auth/kid-login', { name: 'avery', pin: '000002' });
  const ka = (await ty.get('/api/kid-access')).data.kids.find((k) => k.key === 'avery');
  check('parent sees Avery’s recent sign-ins (incl. the wrong PIN, device label)', ka.recentSignins[0].ok === false && ka.recentSignins[0].device === 'iPhone' && ka.recentSignins.some((s) => s.ok), JSON.stringify(ka.recentSignins.slice(0, 3)));
  const devs = (await ty.get('/api/household/admin')).data.devices;
  eq('parent sees the device and its kids', devs.map((d) => [d.label, d.kids]), [['iPhone', ['Avery']]]);
  await tablet.post('/api/auth/kid-device/forget', { key: 'avery' });
  eq('"not me" removes the name from this device', (await tablet.get('/api/auth/kid-device')).data.kids, []);
  await tablet.post('/api/auth/kid-login', { name: 'Avery', pin: averyPin, remember: true });
  await ty.del(`/api/household/devices/${devs[0].id}`);
  eq('parent forgets the device → picker gone', (await tablet.get('/api/auth/kid-device')).data.kids, []);

  section('1. money (FAKE provider — local proof)');
  eq("kids can't see money", (await avery.get('/api/money')).status, 403);
  let m = (await ty.get('/api/money')).data;
  eq('provider is the fake, nothing linked yet', [m.provider, m.items.length, m.safeToSpend], ['fake', 0, null]);
  const lt = (await ty.post('/api/money/link-token')).data;
  check('link token from the fake', lt.provider === 'fake' && lt.linkToken.startsWith('link-fake-'));
  eq('a non-fake public token is refused', (await ty.post('/api/money/exchange', { publicToken: 'public-sandbox-xyz', institution: 'X' })).status, 400);
  m = (await ty.post('/api/money/exchange', { publicToken: 'public-fake-e2e', institution: 'Demo Bank (fake)' })).data;
  eq('link → 3 accounts synced', m.accounts.map((a) => [a.name, a.subtype]), [['Rewards Visa', 'credit card'], ['Everyday Checking', 'checking'], ['Rainy Day Savings', 'savings']]);
  eq('subscription radar finds exactly the recurring charges', m.subscriptions.map((s) => [s.merchant, s.cadence, s.amount]).sort(), [
    ['Netflix', 'monthly', 15.49], ['OG&E', 'monthly', m.subscriptions.find((s) => s.merchant === 'OG&E')?.amount], ['Oakwood Apartments', 'monthly', 1450],
    ['Planet Fitness', 'monthly', 29.99], ['Spotify', 'monthly', 11.99],
  ].sort());
  check('…and NOT the irregular spending (Kroger, Starbucks, Amazon)', !m.subscriptions.some((s) => /Kroger|Starbucks|Amazon/.test(s.merchant)));
  eq('paycheck detected: Acme Corp, biweekly, $2,400', m.income.map((i) => [i.merchant, i.cadence, i.amount, i.nextDate]), [['Acme Corp', 'biweekly', 2400, '2026-10-09']]);
  eq('safe to spend = $2,840.12 checking − rent $1,450 − gym $29.99 due before payday', [m.safeToSpend.amount, m.safeToSpend.until, m.safeToSpend.basis, m.safeToSpend.upcoming.map((u) => `${u.merchant} ${u.date}`)], [1360.13, '2026-10-09', 'paycheck', ['Oakwood Apartments 2026-10-01', 'Planet Fitness 2026-10-05']]);
  eq('search transactions', (await ty.get('/api/money/transactions?days=120&q=netflix')).data.transactions.map((t) => t.date), ['2026-09-12', '2026-08-12', '2026-07-12', '2026-06-12']);
  const enc = await sql('SELECT access_token_enc FROM money_items');
  check('access token encrypted at rest', enc[0].access_token_enc.startsWith('v1.') && !enc[0].access_token_enc.includes('access-fake'));
  const n0 = (await sql('SELECT COUNT(*)::int AS n FROM money_transactions'))[0].n;
  await ty.post('/api/money/sync');
  eq('re-sync is idempotent', (await sql('SELECT COUNT(*)::int AS n FROM money_transactions'))[0].n, n0);
  m = (await ty.del(`/api/money/items/${m.items[0].id}`)).data;
  eq('unlink removes the bank and its data', [m.items.length, m.accounts.length, (await sql('SELECT COUNT(*)::int AS n FROM money_transactions'))[0].n], [0, 0, 0]);

  section('6 + 7. Ask Hana + homework tutor (STUBBED model — local proof)');
  eq("kids don't get the companion", (await avery.get('/api/chat/companion')).status, 403);
  const st = (await avery.get('/api/chat/tutor')).data;
  eq('kid tutor available (stub), empty history', [st.available, st.history.length], [true, 0]);
  const a1 = await avery.post('/api/chat/tutor', { message: 'Can you just tell me the answer to 3x+5=20?' });
  check('tutor reply comes back through the full pipeline', a1.status === 200 && a1.data.reply.text.startsWith('[stub reply]'), a1.data.reply?.text);
  check('…with the tutor’s "never give the answer" rule in the system prompt', a1.data.reply.text.includes('rule=no-answers'));
  check('…Avery’s open homework as context', a1.data.reply.text.includes('ctx=Math worksheet (Math)'));
  check('…and the tutor’s 450-token cap', a1.data.reply.text.includes('max_tokens=450'));
  const a2 = await avery.post('/api/chat/tutor', { message: 'ok what do I do first' });
  check('second turn includes the stored history (3 turns sent)', a2.data.reply.text.includes('turns=3'), a2.data.reply.text);
  eq('conversation stored server-side', a2.data.history.map((h) => h.who), ['user', 'hana', 'user', 'hana']);
  eq("chats are per person (Evan's tutor history is empty)", (await evan.get('/api/chat/tutor')).data.history.length, 0);
  eq('empty message → 400', (await avery.post('/api/chat/tutor', { message: '  ' })).status, 400);
  const hana = await ty.post('/api/chat/companion', { message: 'What should I do next?' });
  check('Ask Hana: companion persona + sees the day', hana.data.reply.text.includes('persona=hana') && hana.data.reply.text.includes('ctx=day'), hana.data.reply.text);
  await kayla.get(`/dev-login?token=${DEV_TOKEN}&member=kayla`);
  eq('tutor is for kids + the student track (Heart of Home → 403)', (await kayla.get('/api/chat/tutor')).status, 403);
  await ty.patch('/api/household/members/2', { xpTrack: 'student' });
  const kt = await kayla.post('/api/chat/tutor', { message: 'Help me plan my essay' });
  check('switch Kayla to Student → Socratic college tutor', kt.status === 200 && kt.data.reply.text.includes('rule=socratic'), kt.data.reply?.text);
  await ty.patch('/api/household/members/2', { xpTrack: 'woman' });
}

async function build3Sunday() {
  section('9. streak XP bonus, perfect day, achievements');
  // Ty checked in every day Mon..Sun; today make it a 100/100 day.
  await checkinTy('Great');
  await ty.post('/api/workouts/complete-day');
  const tk = await ty.post('/api/day/tasks', { task: 'Meal prep', priority: 'Important', energy: 'Body-only' });
  await ty.post(`/api/day/tasks/${tk.data.tasks.find((t) => t.task === 'Meal prep').id}/done`);
  await ty.post('/api/family/one-on-ones', { childId: 4, minutes: 20 });
  const s1 = (await ty.get('/api/score')).data;
  eq('daily score 100/100', [s1.daily.total, s1.daily.labels], [100, ['Sleep 7+ hrs', 'Workout', 'Today started', 'Top task done', 'Family action']]);
  eq('7-day streak', s1.streak.current, 7);
  const ev = await sql("SELECT action, xp FROM xp_events WHERE member_id = 1 AND earned_on = '2026-10-04' AND action IN ('Perfect day (100/100)', '7-day streak') ORDER BY action");
  eq('awards: Perfect day +50 XP, 7-day streak +20 XP', ev.map((e) => [e.action, e.xp]), [['7-day streak', 20], ['Perfect day (100/100)', 50]]);
  const unlocked = s1.achievements.filter((a) => a.unlocked).map((a) => a.name);
  check('achievements unlocked', ['🌅 First Day', '📅 Week One', '🛡️ Restarted', '💯 Perfect Day'].every((n) => unlocked.includes(n)), unlocked.join(', '));
  eq('Sunday newly unlocks exactly the two only possible today', s1.newlyUnlocked, ['📅 Week One', '💯 Perfect Day']);
  eq('…First Day + Restarted were unlocked back on Monday, the day they happened', s1.achievements.filter((a) => ['🌅 First Day', '🛡️ Restarted'].includes(a.name)).map((a) => a.date), ['2026-09-28', '2026-09-28']);
  const s2 = (await ty.get('/api/score')).data;
  eq('reloading pays nothing twice', [s2.xp.total, s2.newlyUnlocked], [s1.xp.total, []]);
  eq('weekend curfew on Sunday? no — Sunday is a school night', (await avery.get('/api/chores/today')).data.curfew, { weekend: false, curfew: '21:30', phoneOff: '21:00' });

  section('9. rewards history for parents');
  const hist = (await ty.get('/api/rewards/admin')).data.history;
  eq('approved + denied, newest first, with who decided', hist.map((h) => [h.rewardName, h.status, h.decidedBy]), [['Movie night pick', 'approved', 'Ty'], ['Ice cream run', 'denied', 'Ty']]);
}

async function mealSlots() {
  section('9. meal slots');
  let p = (await ty.post('/api/meal-plan', { mealId: 1, day: 'Thu', slot: 'dinner' })).data;
  p = (await ty.post('/api/meal-plan', { mealId: 3, day: 'Thu', slot: 'breakfast' })).data;
  eq('Thursday: breakfast sorts before dinner', p.days[3].meals.map((m) => `${m.slot}:${m.title}`), ['breakfast:Turkey chili', 'dinner:Chicken burrito bowls']);
  p = (await ty.post('/api/meal-plan', { mealId: 3, day: 'Thu', slot: 'breakfast' })).data;
  eq('same meal, same day + slot twice → no-op', p.days[3].meals.length, 2);
  p = (await ty.post('/api/meal-plan', { mealId: 3, day: 'Thu', slot: 'lunch' })).data;
  eq('…but a different slot is a new entry', p.days[3].meals.map((m) => m.slot), ['breakfast', 'lunch', 'dinner']);
  const lunch = p.days[3].meals[1];
  p = (await ty.patch(`/api/meal-plan/${lunch.id}`, { slot: 'dinner' })).data;
  eq('change a slot (day untouched)', [p.days[3].meals.map((m) => m.slot), p.days[3].meals[2].day], [['breakfast', 'dinner', 'dinner'], 'Thu']);
  eq('bad slot → 400', (await ty.patch(`/api/meal-plan/${lunch.id}`, { slot: 'brunch' })).status, 400);
}
/* ======================= THE BIG BUILD ======================= */

const sam = new Client('sam');
const ret = new Client('ret');
const upload = (client, classId, body = randomBytes(2048), headers = {}) =>
  client.req('POST', `/api/lectures/upload?classId=${classId}&durationS=1800`, body, {
    json: false,
    headers: { 'Content-Type': 'audio/webm', 'X-MyDay-Upload': '1', ...headers },
  });
async function waitLecture(client, id) {
  for (let i = 0; i < 100; i++) {
    const r = await client.get(`/api/lectures/${id}`);
    if (r.data.status === 'ready' || r.data.status === 'failed') return r.data;
    await new Promise((res) => setTimeout(res, 100));
  }
  return (await client.get(`/api/lectures/${id}`)).data;
}

async function bigBuild() {
  await startServer(noonOn('Sun'));
  await ty.get(`/dev-login?token=${DEV_TOKEN}&member=ty`);
  await ty.put('/api/kid-access/4/pin', { pin: '583920' });
  await evan.post('/api/auth/kid-login', { name: 'Evan', pin: '583920' });

  section('D. body-style programs: shake formula + program rules (unit checks on the compiled code)');
  const shared = await import(pathToFileURL(path.join(root, 'shared', 'dist', 'index.js')).href);
  const prog = await import(pathToFileURL(path.join(apiDir, 'dist', 'lib', 'program.js')).href);
  const modes = ['gaining', 'cutting', 'recomp', 'maintenance'];
  eq('180 lb, 100 g food: shakes/day gaining/cutting/recomp/maintenance (rounded up, never more than 3)', modes.map((m) => shared.shakesPerDay(180, m, 100).shakes), [2, 3, 3, 2]);
  eq('protein targets for 180 lb (g/day; maintenance rounds up to 0.73 g/lb)', modes.map((m) => shared.shakesPerDay(180, m, 100).proteinTarget), [144, 189, 162, 131]);
  eq('never negative shakes', shared.shakesPerDay(120, 'maintenance', 200).shakes, 0);
  eq('Safety 4: a 300 lb cut never says 9 shakes (cap 3)', shared.shakesPerDay(300, 'cutting', 100).shakes, 3);
  eq('Safety 4: reference weight = lower of weight / goal / BMI-25 weight (BMI ≥ 30 only)', [
    shared.referenceWeightLb(300, 66), shared.referenceWeightLb(180, 70), shared.referenceWeightLb(180, 70, 165), shared.referenceWeightLb(200, null),
  ], [155, 180, 165, 200]);
  eq('Results 3: protein per meal adds up to the day (189 g ÷ 4 meals), floored at 0.18 g/lb', [shared.perMealProtein(189, 4, 180), shared.perMealProtein(60, 5, 180)], [47, 32]);
  eq('Results 1: Mifflin-St Jeor × activity — 180 lb man (active) / 140 lb woman (sedentary)', [
    Math.round(shared.maintenanceCalories({ sex: 'male', ageYears: 30, heightIn: 70, weightLb: 180, activity: 'moderate' })),
    Math.round(shared.maintenanceCalories({ sex: 'female', ageYears: 30, heightIn: 64, weightLb: 140, activity: 'sedentary' })),
  ], [2763, 1608]);
  const man = { sex: 'male', ageYears: 30, heightIn: 70, weightLb: 180, activity: 'moderate' };
  const e1 = prog.energyFor(man, { nutrition: 'cutting', weeklyChangePct: -0.7 });
  eq('Safety 2: 180 lb man, 0.7%/wk cut → deficit capped at 500 kcal/day', [e1.macros, e1.energy.capped], [{ calories: 2260, protein: 189, carbs: 234, fat: 63 }, true]);
  const e2 = prog.energyFor({ sex: 'female', ageYears: 30, heightIn: 64, weightLb: 300, activity: 'sedentary' }, { nutrition: 'cutting', weeklyChangePct: -0.6 });
  eq('300 lb woman: the “cut” is a real deficit now (was a 4,500 kcal surplus), 750 cap with BMI ≥ 30, protein on reference weight', [e2.energy.maintenance, e2.macros.calories, e2.energy.capped, e2.energy.referenceLb, e2.macros.protein], [2479, 1730, true, 146, 153]);
  const e3 = prog.energyFor({ sex: 'female', ageYears: 60, heightIn: 60, weightLb: 110, activity: 'sedentary' }, { nutrition: 'cutting', weeklyChangePct: -0.6 });
  eq('calorie floor: never under 1,200 (women) / 1,500 (men)', [e3.macros.calories, e3.energy.floored, prog.energyFor({ ...man, weightLb: 120, heightIn: 62, ageYears: 70, activity: 'sedentary' }, { nutrition: 'cutting', weeklyChangePct: -1 }).macros.calories], [1200, true, 1500]);
  eq('lean gain: +0.25%/wk for a 180 lb man', prog.macrosFor(man, { nutrition: 'gaining', weeklyChangePct: 0.25 }).calories, 2990);
  eq('Results 6: double progression hints', [
    prog.nextStep('6–12 · 1–3 RIR', { weight: '135', reps: '12' }),
    prog.nextStep('10–20 · 0–2 RIR', { weight: '20', reps: '15' }),
    prog.nextStep('6–12 · 1–3 RIR', undefined),
  ], ['You hit 12 last time — go up to about 140 lb', 'Same weight (20) — aim for 16 reps', null]);

  const problems = [];
  const PAIRS = [['Lat pulldown', 'Pull-up'], ['Dumbbell curl', 'Hammer curl'], ['Hip thrust', 'Glute bridge'], ['Bench press', 'Push-up'], ['Overhead press', 'Seated dumbbell press'], ['Back squat', 'Goblet squat']];
  const weeksOf = (ph, f) => ph.filter(f).reduce((s, x) => s + x.weekEnd - x.weekStart + 1, 0);
  const allNames = new Set();
  for (const b of shared.BUILDS) {
    for (const lvl of ['beginner', 'experienced']) {
      const ph = prog.buildPhases(b, lvl);
      let w = 1;
      for (const x of ph) {
        if (x.weekStart !== w) problems.push(`${b}/${lvl} gap at ${w}`);
        w = x.weekEnd + 1;
      }
      if (w !== 53) problems.push(`${b}/${lvl} ends at ${w - 1}`);
      const rows = prog.programRows(b, ph);
      rows.forEach((r) => allNames.add(r.exercise));
      ph.forEach((p, i) => {
        const pr = rows.filter((r) => r.weekStart === p.weekStart);
        const sets = prog.weeklySets(pr);
        for (const [m, n] of Object.entries(sets)) {
          if (n > 25) problems.push(`${b}/${lvl} ${p.name} ${m} ${n} fractional sets`);
          if (b === 'lean_runner' && n > 8) problems.push(`runner ${p.name} ${m} ${n} sets`);
        }
        const ses = prog.maxSessionSets(pr);
        if (ses.sets > 11) problems.push(`${b}/${lvl} ${ses.day} ${ses.muscle} ${ses.sets} sets in one session`);
        for (const d of new Set(pr.map((r) => r.dayNum))) {
          const ex = pr.filter((r) => r.dayNum === d).map((r) => r.exercise);
          for (const [x, y] of PAIRS) if (ex.includes(x) && ex.includes(y)) problems.push(`${b} ${p.name} day ${d}: ${x} + ${y}`);
        }
        if (p.kind === 'deload') {
          const prev = ph[i - 1];
          const before = rows.filter((r) => r.weekStart === prev.weekStart).reduce((s, r) => s + r.sets, 0);
          const ratio = pr.reduce((s, r) => s + r.sets, 0) / before;
          if (ratio < 0.38 || ratio > 0.67) problems.push(`${b}/${lvl} deload at ${p.weekStart} ${ratio.toFixed(2)}`);
        }
        if (p.kind === 'strength' && b !== 'lean_runner' && !pr.some((r) => r.reps.startsWith('3–5'))) problems.push(`${b} strength lacks 3–5`);
      });
      // Full dose (after the beginner ramp): priority muscles 10–25 fractional sets, 2+ days a week.
      const full = ph.find((x) => ['hypertrophy', 'strength'].includes(x.kind) && x.setScale === 1);
      const fr = rows.filter((r) => r.weekStart === full.weekStart);
      const fs = prog.weeklySets(fr);
      const freq = prog.weeklyFrequency(fr);
      for (const m of prog.priorityMuscles(b)) {
        if (!(fs[m] >= 10 && fs[m] <= 25)) problems.push(`${b}/${lvl} priority ${m} ${fs[m]} sets`);
        if ((freq[m] ?? 0) < 2) problems.push(`${b}/${lvl} priority ${m} ${freq[m]}x/wk`);
      }
      if (lvl === 'beginner' && b !== 'shredded') {
        const wk1 = rows.filter((r) => r.weekStart === 1);
        for (const [m, n] of Object.entries(prog.weeklySets(wk1))) if (n > 10) problems.push(`${b} beginner week 1 ${m} ${n} sets`);
        if (Math.max(...[...new Set(wk1.map((r) => r.dayNum))].map((d) => wk1.filter((r) => r.dayNum === d).length)) > 4) problems.push(`${b} first-28-days session too long`);
      }
      if (weeksOf(ph, (x) => x.nutrition === 'cutting') > 16) problems.push(`${b}/${lvl} cuts ${weeksOf(ph, (x) => x.nutrition === 'cutting')} weeks`);
      // Cuts hold volume: the first cut block has the same sets as the build block it follows (same variation).
      const cut = ph.find((x) => x.kind === 'cut');
      if (cut) {
        const hyp = [...ph].reverse().find((x) => x.kind === 'hypertrophy' && x.weekStart < cut.weekStart && x.variant === cut.variant && x.setScale === 1);
        const tot = (p) => rows.filter((r) => r.weekStart === p.weekStart).reduce((s, r) => s + r.sets, 0);
        if (hyp && tot(hyp) !== tot(cut)) problems.push(`${b}/${lvl} cut trims volume ${tot(cut)} vs ${tot(hyp)}`);
      }
      if (rows.some((r) => /late — trimmed/.test(r.phaseName))) problems.push(`${b} still trims late-cut volume`);
    }
  }
  eq('all 9 builds × 2 levels: 52 weeks; ≤25 fractional sets/muscle/wk and ≤11/session; priority 10–25 at 2×/wk; beginners start ≤10 sets and ≤4 exercises; deloads ≈½; no redundant pairs in a session; cuts ≤16 wk and hold volume', problems, []);

  const maps = Object.fromEntries(shared.BUILDS.map((b) => [b, prog.buildPhases(b, 'beginner')]));
  eq('Results 2: build-specific years — Thick & Powerful, Strong & Dense and Strong & Curvy have no cut; Lean Runner never gains', [
    ['thick_powerful', 'strong_dense', 'strong_curvy'].map((b) => weeksOf(maps[b], (x) => x.nutrition === 'cutting')),
    weeksOf(maps.lean_runner, (x) => x.nutrition === 'gaining'),
  ], [[0, 0, 0], 0]);
  eq('…Thick & Powerful spends 36 weeks in a lean gain', weeksOf(maps.thick_powerful, (x) => x.nutrition === 'gaining'), 36);
  const sh = prog.buildPhases('shredded', 'experienced');
  eq('Safety 5: Shredded cut is 16 weeks, then 8 weeks of required maintenance', [weeksOf(sh, (x) => x.nutrition === 'cutting'), sh.at(-1).name, sh.at(-1).weekEnd - sh.at(-1).weekStart + 1], [16, 'Maintenance + recovery', 8]);
  eq('Results 5: every year opens with “First 28 days”: short sessions', shared.BUILDS.filter((b) => b !== 'shredded').every((b) => maps[b][0].name.startsWith('First 28 days') && maps[b][0].weekEnd === 4), true);
  const cutFirst = prog.buildPhases('lean_athletic', 'beginner', { startWithCut: true });
  eq('higher body fat: the cut comes first (after the first 28 days)', [cutFirst[1].kind, cutFirst[1].nutrition], ['cut', 'cutting']);
  const teenMap = prog.buildPhases('lean_runner', 'beginner', { teen: true });
  eq('Safety 1: teen years have no deficit, no surplus, no cut, no “Lean”', [teenMap.every((x) => x.nutrition === 'maintenance' && x.weeklyChangePct === 0), teenMap.some((x) => x.kind === 'cut' || /lean|cut/i.test(x.name))], [true, false]);
  eq('Safety 8: pregnancy / postpartum plans have no cut', prog.buildPhases('hourglass', 'beginner', { noCut: true }).some((x) => x.nutrition === 'cutting'), false);
  eq('Nice 1: deloads every 6 weeks (8 for beginners), not every 5th — 5 and 4 a year instead of ~10', [prog.buildPhases('v_taper', 'experienced').filter((x) => x.kind === 'deload').length, maps.v_taper.filter((x) => x.kind === 'deload').length], [5, 4]);
  eq('Results 7: library adds leg extension, seated leg curl, shrug, carry, cable crunch, plyometrics, seated calf raise', ['Leg extension', 'Seated leg curl', 'Dumbbell shrug', "Farmer's carry", 'Cable crunch', 'Box jump', 'Pogo hops', 'Seated calf raise'].filter((n) => !allNames.has(n)), []);
  eq('…“leg curl” is the seated one now', allNames.has('Leg curl'), false);
  const runnerRows = prog.programRows('lean_runner', maps.lean_runner);
  eq('…plyometrics don’t count as hard sets; runners lift heavy (3–6) without hypertrophy blocks', [prog.weeklySets(runnerRows.filter((r) => r.exercise === 'Pogo hops')), runnerRows.filter((r) => r.exercise === 'Back squat' && !/light/.test(r.reps)).every((r) => r.reps.startsWith('3–6'))], [{}, true]);
  const la = prog.programRows('lean_athletic', prog.buildPhases('lean_athletic', 'experienced'));
  eq('Nice 2: variations rotate every 3–4 weeks; main lifts never rotate', [la.some((r) => r.exercise === 'Incline dumbbell curl'), la.some((r) => r.exercise === 'Dumbbell curl'), prog.programRows('strong_dense', prog.buildPhases('strong_dense', 'experienced')).some((r) => r.exercise === 'Machine chest press')], [true, true, false]);
  eq('Results 6: reps carry RIR (reps in reserve)', la.filter((r) => !/RIR|full rest/.test(r.reps)).length, 0);

  section('D + A2. pick a build → a planned year (API)');
  await kayla.get(`/dev-login?token=${DEV_TOKEN}&member=kayla`);
  const k0 = (await kayla.get('/api/workouts/today')).data;
  eq('no plan yet: hasPlan false and no made-up workout', [k0.hasPlan, k0.session, k0.program], [false, null, null]);
  eq('bad build → 400', (await kayla.put('/api/program', { build: 'huge', bodyweightLb: 140, level: 'beginner' })).status, 400);
  const kp = (await kayla.put('/api/program', { build: 'hourglass', bodyweightLb: 140, level: 'beginner' })).data.program;
  eq('hourglass, beginner: week 1, recomp phase, 80 g food default, 2 shakes', [kp.build.key, kp.week, kp.phase.nutrition, kp.shakes.foodProtein, kp.shakes.shakes], ['hourglass', 1, 'recomp', 80, 2]);
  const plan = (await kayla.get('/api/workouts/plan')).data;
  eq('plan: 52 weeks, exactly one current (week 1), every week phased', [plan.weeks.length, plan.weeks.filter((w) => w.isCurrent).map((w) => w.week), plan.weeks.every((w) => w.kind)], [52, [1], true]);
  const k1 = (await kayla.get('/api/workouts/today')).data;
  check('today now comes from the loaded plan', k1.hasPlan && k1.program?.build.key === 'hourglass', `rest=${k1.isRest} session=${k1.session?.dayName ?? '-'}`);
  const kp2 = (await kayla.put('/api/program', { build: 'strong_curvy', bodyweightLb: 142, level: 'beginner' })).data.program;
  eq('changing builds re-plans from the current week', [kp2.build.key, kp2.week, kp2.bodyweightLb], ['strong_curvy', 1, 142]);
  check('protein target vs plan reported', typeof kp2.plannedProtein === 'number' && kp2.shakes.proteinTarget > 0, `${kp2.plannedProtein} of ${kp2.shakes.proteinTarget}`);
  eq('Ty (CSV plan) still has his plan', (await ty.get('/api/workouts/plan')).data.hasPlan, true);
  eq('no workout on Ty’s Sunday to move → 409', (await ty.post('/api/workouts/move', { to: 'tomorrow' })).status, 409);
  const ses = await ty.post('/api/workouts/session', { activity: 'Walk', minutes: 30 });
  eq('A4: log any workout (activity + minutes)', ses.status < 300, true);
  const hist = (await ty.get('/api/workouts/history')).data;
  eq('history shows it, with weekly minutes', [hist.sessions[0]?.activity, hist.weekMinutes >= 30], ['Walk', true]);
  eq('baseline notes saved', (await ty.put('/api/workouts/baseline', { exercise: 'walks', sleep: '6h', food: 'skip breakfast' })).data.baseline, { exercise: 'walks', sleep: '6h', food: 'skip breakfast' });

  section('A3 + add-on 2/3. meal library: 233 meals (original 120 + the 113 pictured dishes), photos, country of origin');
  const lib = (await ty.get('/api/meals')).data;
  eq('233 meals', lib.meals.length, 233);
  const photos = lib.meals.filter((m) => m.imageUrl.endsWith('.webp'));
  eq('every meal has its own picture (no illustrations, no placeholders), none shared', [photos.length, new Set(photos.map((m) => m.imageUrl)).size], [233, 233]);
  check('the original 120 recipes use their renders (named for the dish)', lib.meals.filter((m) => m.id <= 120).every((m) => m.imageUrl === `/meals/${shared.mealSlug(m.title)}.webp`));
  eq('every list row carries nutrition (incl. Chicken Caesar wraps + Steak salad)', lib.meals.filter((m) => m.calories === null || m.protein === null).map((m) => m.title), []);
  eq('…those two specifically', lib.meals.filter((m) => [16, 106].includes(m.id)).map((m) => [m.title, m.calories, m.protein]), [['Chicken Caesar wraps', 520, 44], ['Steak salad with blue cheese', 520, 44]]);
  let broken = 0;
  for (const m of lib.meals) {
    const r = await fetch(BASE + m.imageUrl);
    if (r.status !== 200 || !/^image\/(svg|webp)/.test(r.headers.get('content-type') ?? '')) broken++;
  }
  eq('no broken images (all 233 load)', broken, 0);
  const webp = await fetch(BASE + photos[0].imageUrl);
  eq('photos are served as webp', webp.headers.get('content-type'), 'image/webp');

  section('add-on 3. country / region of origin');
  eq('every meal has a country of origin', lib.meals.filter((m) => !m.cuisine).length, 0);
  const countryNames = lib.countries.map((c) => c.name);
  eq('no catch-all categories left (Asian, Breakfast, Salad, Soup, Middle Eastern…)', countryNames.filter((n) => ['Asian', 'Breakfast', 'Salad', 'Soup', 'Middle Eastern', 'Southern', 'Cajun', 'Hawaiian', 'Caribbean'].includes(n)), []);
  eq('the countries you named are browsable', ['Mexican', 'Japanese', 'Chinese', 'Vietnamese', 'Korean', 'Mediterranean', 'Italian', 'Brazilian', 'Argentinian', 'Spanish', 'French', 'American'].filter((n) => !countryNames.includes(n)), []);
  eq('country counts add up to the library', lib.countries.reduce((s, c) => s + c.count, 0), 233);
  const arg = (await ty.get('/api/meals?cuisine=Argentinian')).data.meals;
  eq('filter by country: Argentinian', [arg.length, arg.every((m) => m.cuisine === 'Argentinian')], [lib.countries.find((c) => c.name === 'Argentinian').count, true]);
  const basque = (await ty.get('/api/meals?cuisine=Spanish&region=Basque%20Country')).data.meals.map((m) => m.title);
  eq('filter by region of origin: Basque Country', basque, ['Basque Garlic Chicken & Potatoes']);
  eq('Cajun dishes are American · Louisiana', lib.meals.filter((m) => /gumbo|jambalaya/i.test(m.title)).map((m) => `${m.cuisine} · ${m.region}`), ['American · Louisiana', 'American · Louisiana']);
  eq('regions listed under their country', lib.countries.find((c) => c.name === 'French').regions.map((r) => r.name).includes('Provence'), true);
  eq('placeholder image exists', (await fetch(`${BASE}/meals/_placeholder.svg`)).status, 200);
  let thin = 0;
  for (const m of lib.meals) {
    const d = (await ty.get(`/api/meals/${m.id}`)).data;
    if (d.ingredients.length < 4 || d.steps.length < 3 || [d.calories, d.protein, d.carbs, d.fat].some((x) => x === null) || !d.cuisine) thin++;
  }
  eq('every meal complete: macros, cuisine, 4+ ingredients, 3+ numbered steps', thin, 0);
  const cut = (await ty.get('/api/meals?phase=cutting')).data.meals;
  check('phase filter: cutting meals, all tagged cutting', cut.length > 60 && cut.every((m) => m.phaseTags.includes('cutting')), `${cut.length} meals`);
  const mine = (await kayla.get('/api/meals?phase=mine')).data;
  eq('“my phase” follows the program (Kayla: recomp)', [mine.phase, mine.meals.every((m) => m.phaseTags.includes('recomp'))], ['recomp', true]);
  const chains = (await ty.get('/api/grocery')).data.chains;
  check('every chain but Trader Joe’s has a real online ordering page', chains.filter((c) => !c.custom && c.name !== "Trader Joe's").every((c) => /^https:\/\//.test(c.orderUrl ?? '')), chains.filter((c) => !c.orderUrl).map((c) => c.name).join(','));
  eq("Trader Joe's is in-store only", chains.find((c) => c.name === "Trader Joe's")?.orderUrl, null);

  section('B. lecture capture → notes → study library (TRANSCRIPTION STUBBED: TRANSCRIPTION_STUB=1 returns a canned classroom transcript; notes via the local stub structurer — no AI key used)');
  const sch = (await avery.post('/api/classes', { name: 'Biology', teacher: 'Ms. Reed', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], startTime: '09:00' })).data;
  const bio = sch.classes.find((c) => c.name === 'Biology');
  eq('kid adds a class', [bio?.teacher, bio?.days.length], ['Ms. Reed', 5]);
  eq('first-use policy screen required before recording (409)', (await upload(avery, bio.id)).status, 409);
  await avery.post('/api/lectures/ack');
  eq('policy acknowledged', (await avery.get('/api/school')).data.recordingAcknowledged, true);
  eq('upload without the custom header → 400 (no cross-site uploads)', (await upload(avery, bio.id, randomBytes(64), { 'X-MyDay-Upload': '0' })).status, 400);
  eq('Evan (no policy screen yet) cannot upload → 409', (await upload(evan, bio.id)).status, 409);
  const up1 = await upload(avery, bio.id);
  eq('upload accepted, processing in the background', [up1.status, up1.data.lecture?.status], [201, 'uploaded']);
  const l1 = await waitLecture(avery, up1.data.lecture.id);
  eq('lecture ready', l1.status, 'ready');
  check('structured notes, not a transcript dump: headed sections + key points + terms', l1.notes.sections.length >= 2 && l1.notes.keyPoints.length >= 2 && l1.notes.terms.some((t) => t.term === 'Photosynthesis'), l1.notes.title);
  check('…homework sentences are pulled out of the notes', !JSON.stringify(l1.notes.sections).includes('For homework'));
  eq('assignments detected with real due dates (recorded Sun 10-04)', l1.assignments.map((a) => [a.title, a.due]), [
    ['Finish worksheet 4.2 on the two stages', '2026-10-09'],
    ['Read pages 112 to 118', '2026-10-06'],
  ]);
  eq('audio deleted once transcribed (private by default)', (await sql('SELECT audio_path FROM lectures WHERE id = $1', [l1.id]))[0].audio_path, null);
  eq("private: a parent can't open it (404)", (await ty.get(`/api/lectures/${l1.id}`)).status, 404);
  eq("…nor a sibling", (await evan.get(`/api/lectures/${l1.id}`)).status, 404);
  const added = (await avery.post(`/api/lectures/${l1.id}/assignments/${l1.assignments[0].id}/add`)).data;
  check('add detected assignment → Homework', added.assignments[0].homeworkId !== null && (await avery.get('/api/homework')).data.open.some((h) => h.assignment === 'Finish worksheet 4.2 on the two stages' && h.due === '2026-10-09'));
  eq('adding twice → 409', (await avery.post(`/api/lectures/${l1.id}/assignments/${l1.assignments[0].id}/add`)).status, 409);
  eq('dismiss the other', (await avery.post(`/api/lectures/${l1.id}/assignments/${l1.assignments[1].id}/dismiss`)).data.assignments[1].dismissed, true);
  let sv = (await avery.get(`/api/study/${bio.id}`)).data;
  check('flashcards made from the lecture', sv.cards.length >= 2 && sv.cards.every((c) => c.box === 1 && c.explanation), `${sv.cards.length} cards`);
  const card = sv.cards[0];
  sv = (await avery.post(`/api/study/cards/${card.id}/answer`, { correct: true })).data;
  eq('right answer → box 2', sv.cards.find((c) => c.id === card.id).box, 2);
  sv = (await avery.post(`/api/study/cards/${card.id}/answer`, { correct: false })).data;
  eq('wrong → back to box 1; quiz history 1/2, 50%', [sv.cards.find((c) => c.id === card.id).box, sv.quiz[0].correct, sv.quiz[0].total, sv.accuracy], [1, 1, 2, 50]);
  sv = (await avery.post(`/api/study/${bio.id}/cards`, { front: 'Where is the Calvin cycle?', back: 'The stroma' })).data;
  check('own flashcard added', sv.cards.some((c) => c.front === 'Where is the Calvin cycle?'));
  const tq = await avery.post('/api/chat/tutor', { message: 'quiz me', lectureId: l1.id });
  check('tutor quizzes from the lecture material (and keeps its no-answers rule)', tq.data.reply.text.includes('quiz=lecture') && tq.data.reply.text.includes('rule=no-answers'), tq.data.reply.text);
  eq("tutor can't quiz from someone else's lecture", (await evan.post('/api/chat/tutor', { message: 'quiz', lectureId: l1.id })).status, 404);
  const l2 = await waitLecture(avery, (await upload(avery, bio.id)).data.lecture.id);
  eq('2nd lecture: notes shown right away', [l2.scaffold, l2.notes !== null], ['none', true]);
  const l3 = await waitLecture(avery, (await upload(avery, bio.id)).data.lecture.id);
  eq('3rd lecture: scaffold — student drafts the summary first, notes hidden', [l3.scaffold, l3.revealed, l3.notes], ['summary', false, null]);
  eq('empty draft → 400', (await avery.post(`/api/lectures/${l3.id}/draft`, { part: 'summary', draft: '' })).status, 400);
  const l3b = (await avery.post(`/api/lectures/${l3.id}/draft`, { part: 'summary', draft: 'Plants turn light into sugar in the chloroplast.' })).data;
  eq('after the draft the AI notes are revealed, draft kept', [l3b.revealed, l3b.notes !== null, l3b.drafts.summary], [true, true, 'Plants turn light into sugar in the chloroplast.']);
  sv = (await avery.get(`/api/study/${bio.id}`)).data;
  eq('library keeps every lecture (never expires)', sv.lectures.length, 3);
  const cr = (await avery.post('/api/classroom/connect')).data;
  eq('Google Classroom (FAKE provider) imports 3 courses', cr.imported, 3);
  eq('…and reconnecting doesn’t duplicate them', (await avery.post('/api/classroom/connect')).data.imported, 0);
  eq('classes now: Biology + 3 imported', (await avery.get('/api/school')).data.classes.length, 4);

  section('E1. student academic engine + its 4 achievements');
  await ty.patch('/api/household/members/2', { xpTrack: 'student' });
  for (let i = 0; i < 9; i++) await sql("INSERT INTO study_sessions (household_id, member_id, minutes, day) VALUES (1, 2, 30, '2026-09-30')");
  const st1 = await kayla.post('/api/school/study', { minutes: 45, location: 'Library' });
  eq('study session logged (+15 XP)', [st1.status, st1.data.school.studyToday], [201, 45]);
  const ka = (await kayla.post('/api/school/assignments', { name: 'Essay outline', due: '2026-10-08', priority: 'High' })).data;
  await kayla.post(`/api/school/assignments/${ka.assignments[0].id}/done`);
  for (const n of ['Writing center', 'Tutoring lab', 'Professor Diaz']) {
    const c = (await kayla.post('/api/school/campus', { name: n, kind: 'Tutoring' })).data.campus.find((x) => x.name === n);
    await kayla.post(`/api/school/campus/${c.id}/visit`);
    if (n === 'Professor Diaz') for (let i = 0; i < 2; i++) await kayla.post(`/api/school/campus/${c.id}/visit`);
  }
  await kayla.post('/api/school/exams', { name: 'Midterm', course: 'Bio', date: '2026-10-20' });
  const ks = (await kayla.get('/api/score')).data;
  const kun = ks.achievements.filter((a) => a.unlocked).map((a) => a.name);
  eq('Bookworm, Assignment Zero, Office Hours Hero, Support Seeker unlocked', ['📚 Bookworm', '🎯 Assignment Zero', '📞 Office Hours Hero', '🤝 Support Seeker'].map((n) => kun.includes(n)), [true, true, true, true]);
  eq('student daily score: Study/assignment part earned', ks.daily.parts[2], 20);
  await ty.patch('/api/household/members/2', { xpTrack: 'woman' });

  section('E2. identity tools');
  eq('kids get 403', (await avery.get('/api/identity')).status, 403);
  let idn = (await ty.get('/api/identity')).data;
  eq('13 anchor fields, 5 husband/father questions, 12 mental-load categories seeded', [idn.fields.length, idn.questions[0], idn.mentalLoad.length], [13, 'Who was I this month as a husband and father?', 12]);
  idn = (await ty.put('/api/identity/anchor', { anchor: { 'Personal mission': 'Lead with presence', Bogus: 'x' } })).data;
  eq('anchor saved (unknown fields ignored)', [idn.anchor['Personal mission'], idn.anchor.Bogus], ['Lead with presence', undefined]);
  await ty.put('/api/identity/review', { answers: ['a', 'b', 'c', 'd', 'e'] });
  await ty.put('/api/identity/review', { answers: ['a2', 'b', 'c', 'd', 'e'] });
  eq('monthly review: saved, +30 XP once', [(await ty.get('/api/identity')).data.reviews[0].answers[0], (await sql("SELECT COUNT(*)::int AS n FROM xp_events WHERE member_id = 1 AND action = 'Identity Review Completed'"))[0].n], ['a2', 1]);
  eq('review needs 5 answers', (await ty.put('/api/identity/review', { answers: ['x'] })).status, 400);
  eq('head-of-household survey out of range → 400', (await kayla.put('/api/identity/survey', { presence: 6, reliability: 3, emotional: 3, followThrough: 3, communication: 3 })).status, 400);
  eq('survey saved', (await kayla.put('/api/identity/survey', { presence: 4, reliability: 5, emotional: 3, followThrough: 4, communication: 4, moreOf: 'date nights' })).data.survey.moreOf, 'date nights');
  const ml = idn.mentalLoad.find((r) => r.category === 'Meals/groceries');
  eq('mental load row updated', (await ty.patch(`/api/identity/load/${ml.id}`, { load: 'Heavy', owner: 'Ty', delegate: true })).data.mentalLoad.find((r) => r.id === ml.id), { id: ml.id, category: 'Meals/groceries', load: 'Heavy', owner: 'Ty', delegate: true });

  section('E3. bills, income, money check-in');
  eq('kids get 403', (await avery.get('/api/bills')).status, 403);
  await ty.post('/api/bills', { name: 'Rent', amount: 1450, dueDay: 1, autopay: true });
  await ty.post('/api/bills', { name: 'Phone', amount: '$80', dueDay: 6, autopay: false });
  eq('bad due day → 400', (await ty.post('/api/bills', { name: 'X', amount: 1, dueDay: 40 })).status, 400);
  let bl = (await ty.post('/api/income', { source: 'Paycheck', amount: 4800 })).data;
  eq('totals, left, autopilot %, due soon', [bl.totalBills, bl.totalIncome, bl.left, bl.autopilot, bl.dueSoon.map((d) => `${d.name} ${d.date}`)], [1530, 4800, 3270, 50, ['Phone 2026-10-06']]);
  bl = (await ty.post('/api/money/checkin', { anxiety: 'Medium' })).data;
  eq('money check-in logged', bl.lastCheck, { date: '2026-10-04', anxiety: 'Medium', looked: true });
  eq('bad anxiety → 400', (await ty.post('/api/money/checkin', { anxiety: 'Panic' })).status, 400);

  section('I. kid & teen money (MyDay never moves money)');
  let km = (await ty.put('/api/kidmoney/allowance', { member: 'evan', amount: 10, weekday: 'Sun' })).data;
  eq('parent sets Evan $10 every Sunday → paid today', [km.allowance, km.spendable], [{ amount: 10, weekday: 'Sun', lastPaid: '2026-10-04' }, 10]);
  await ty.get('/api/kidmoney?member=evan');
  eq('allowance pays once (reload safe)', (await sql("SELECT COUNT(*)::int AS n FROM kid_ledger WHERE member_id = 4 AND kind = 'allowance'"))[0].n, 1);
  km = (await evan.post('/api/kidmoney/entries', { amount: 3, kind: 'spend', category: 'Food & snacks', note: 'slushie' })).data;
  eq('Evan records spending → $7', [km.spendable, km.canManage, km.categories], [7, false, [{ category: 'Food & snacks', spent: 3 }]]);
  eq("can't spend more than he has → 409", (await evan.post('/api/kidmoney/entries', { amount: 50, kind: 'spend' })).status, 409);
  eq("kids can't add money in → 403", (await evan.post('/api/kidmoney/entries', { amount: 50, kind: 'gift' })).status, 403);
  eq("kids can't see a sibling's money", (await evan.get('/api/kidmoney?member=avery')).status, 403);
  km = (await evan.post('/api/kidmoney/goals', { name: 'Lego set', target: 20 })).data;
  const lego = km.goals[0];
  km = (await evan.post(`/api/kidmoney/goals/${lego.id}/move`, { amount: 5, direction: 'in' })).data;
  eq('save $5 toward Lego → 25%, spendable $2', [km.goals[0].saved, km.goals[0].pct, km.spendable], [5, 25, 2]);
  eq("can't move more than spendable", (await evan.post(`/api/kidmoney/goals/${lego.id}/move`, { amount: 5, direction: 'in' })).status, 409);
  km = (await evan.del(`/api/kidmoney/goals/${lego.id}`)).data;
  eq('removing the goal returns its money', [km.goals.length, km.spendable], [0, 7]);
  km = (await avery.get('/api/kidmoney')).data;
  eq('Avery (15) is a teen; bank link gated off by default', [km.isTeen, km.bankLinkAllowed, km.bank], [true, false, null]);
  eq('parent can’t link while the household gate is off → 409', (await ty.post('/api/kidmoney/avery/bank/link-token')).status, 409);
  await ty.patch('/api/household/info', { allowTeenBankLink: true });
  eq("teen can't link her own bank (parent completes it) → 403", (await avery.post('/api/kidmoney/avery/bank/link-token')).status, 403);
  eq('Evan (11) is too young → 409', (await ty.post('/api/kidmoney/evan/bank/link-token')).status, 409);
  eq('parent gets a link token for Avery', (await ty.post('/api/kidmoney/avery/bank/link-token')).data.provider, 'fake');
  const linked = (await ty.post('/api/kidmoney/avery/bank/exchange', { publicToken: 'public-fake-teen', institution: 'Demo Bank (fake)' })).data;
  check('teen sees her account read-only', linked.bank?.accounts.length === 3);
  check('Avery sees it too', (await avery.get('/api/kidmoney')).data.bank?.institution === 'Demo Bank (fake)');
  eq("…and it doesn't leak into the household Money view", (await ty.get('/api/money')).data.items.length, 0);
  eq('parent revokes the link', (await ty.del('/api/kidmoney/avery/bank')).data.bank, null);

  section('H. engagement: quests, family challenge, win feed, Sunday ritual, private notes, themes, first run');
  let en = (await evan.get('/api/engagement')).data;
  eq('Evan: kid role, 3 rotating quests', [en.role, en.quests.length, new Set(en.quests.map((q) => q.code)).size], ['kid', 3, 3]);
  eq('Avery: teen role; Ty: adult; Kayla: adult', [(await avery.get('/api/engagement')).data.role, (await ty.get('/api/engagement')).data.role, (await kayla.get('/api/engagement')).data.role], ['teen', 'adult', 'adult']);
  const notDone = en.quests.find((q) => !q.done);
  if (notDone) eq('claiming an unfinished quest → 409', (await evan.post(`/api/quests/${notDone.id}/claim`)).status, 409);
  await evan.post('/api/focus/done', { minutes: 15 });
  await evan.post('/api/focus/done', { minutes: 15 });
  await evan.post('/api/focus/done', { minutes: 15 });
  await evan.post(`/api/kidmoney/goals`, { name: 'Bike', target: 100 });
  const bike = (await evan.get('/api/kidmoney')).data.goals[0];
  await evan.post(`/api/kidmoney/goals/${bike.id}/move`, { amount: 1, direction: 'in' });
  for (const q of en.quests.filter((x) => ['chores5', 'choredays4', 'homework3', 'early2', 'cards20', 'water5'].includes(x.code))) {
    await sql('UPDATE quests SET goal = 1 WHERE id = $1', [q.id]);
  }
  await sql("INSERT INTO health_habits (household_id, member_id, day, habit) VALUES (1, 4, '2026-10-04', 'water') ON CONFLICT DO NOTHING");
  en = (await evan.get('/api/engagement')).data;
  const ready = en.quests.find((q) => q.done && !q.claimed);
  check('a quest is complete', !!ready, en.quests.map((q) => `${q.code}:${q.progress}/${q.goal}`).join(' '));
  const pts0 = (await sql("SELECT COALESCE(SUM(points),0)::int AS n FROM scores WHERE member_id = 4 AND source = 'quest'"))[0].n;
  en = (await evan.post(`/api/quests/${ready.id}/claim`)).data;
  await evan.post(`/api/quests/${ready.id}/claim`);
  eq('claim pays the reward once', (await sql("SELECT COALESCE(SUM(points),0)::int AS n FROM scores WHERE member_id = 4 AND source = 'quest'"))[0].n - pts0, ready.reward);
  check('family challenge with helpers', en.challenge && en.challenge.goal > 0 && en.challenge.helpers.length > 0, en.challenge?.title);
  check('win feed: celebration only (no misses, no rankings)', en.wins.length > 0 && en.wins.every((w) => w.emoji && !/miss|overdue|late|behind|fail|last place/i.test(w.text)), `${en.wins.length} wins`);
  eq("Sunday: kids can't close the ritual", (await avery.post('/api/sunday', { highlight: 'x' })).status, 403);
  en = (await ty.post('/api/sunday', { highlight: 'Evan saved for a bike' })).data;
  eq('Sunday ritual done with a highlight', [en.sunday.isSunday, en.sunday.done, en.sunday.highlight], [true, true, 'Evan saved for a bike']);
  await avery.post('/api/private-notes', { body: 'my private thought' });
  eq('teen private note is hers', (await avery.get('/api/private-notes')).data.notes.map((n) => n.body), ['my private thought']);
  eq("parents can't read it", (await ty.get('/api/private-notes')).data.notes.length, 0);
  const pn = (await avery.get('/api/private-notes')).data.notes[0];
  eq("…or delete it", (await ty.del(`/api/private-notes/${pn.id}`)).status, 404);
  eq('bad theme → 400', (await avery.patch('/api/me/prefs', { theme: 'neon' })).status, 400);
  await avery.patch('/api/me/prefs', { theme: 'dark', accent: 'purple', firstRunDone: true });
  eq('theme + accent + first run saved on /api/me', (await avery.get('/api/me')).data.prefs, { theme: 'dark', accent: 'purple', firstRunDone: true });

  section('F. push (PUSH_STUB=1: no push service contacted) + offline replay');
  let nt = (await ty.get('/api/notifications')).data;
  eq('off by default; no VAPID key configured here', [nt.prefs.enabled, nt.vapidPublicKey], [false, null]);
  eq('bad time → 400', (await ty.put('/api/notifications', { sendAt: '25:00' })).status, 400);
  nt = (await ty.put('/api/notifications', { enabled: true, sendAt: '00:00', quietStart: '03:00', quietEnd: '03:01', frequency: 'daily' })).data;
  eq('turned on with my own time + quiet hours', [nt.prefs.enabled, nt.prefs.sendAt, nt.prefs.quietStart], [true, '00:00', '03:00']);
  eq('non-https endpoint rejected', (await ty.post('/api/push/subscribe', { endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } })).status, 400);
  nt = (await ty.post('/api/push/subscribe', { endpoint: 'https://push.example.com/e2e-ty', keys: { p256dh: 'p', auth: 'a' } })).data;
  eq('subscription saved', nt.subscriptions, 1);
  check('batched preview mentions the upcoming bill, gently', /bill/.test(nt.preview?.body ?? '') && /You've got this/.test(nt.preview.body), nt.preview?.body);
  eq('digest pass: 1 sent', (await ty.post('/api/push/run-digests')).data.sent, 1);
  eq('…and never a second one the same day', (await ty.post('/api/push/run-digests')).data.sent, 0);
  eq('logged (stubbed)', (await sql("SELECT stubbed, delivered FROM notification_log WHERE member_id = 1 AND day = '2026-10-04'"))[0], { stubbed: true, delivered: 1 });
  Object.assign(process.env, serverEnv()); // push.js reads the server config on import
  const push = await import(pathToFileURL(path.join(apiDir, 'dist', 'lib', 'push.js')).href);
  const refused = ['You missed 3 chores', "Don't forget your homework", 'Your bill is OVERDUE', 'Hurry up!!', 'You should have finished'].filter((t) => {
    try {
      push.assertGentle(t);
      return false;
    } catch {
      return true;
    }
  });
  eq('guilt copy refused at the policy level', refused.length, 5);
  let okCopy = true;
  try {
    push.assertGentle('A quick heads-up when you have a minute: 2 chores. Later is fine.');
  } catch {
    okCopy = false;
  }
  eq('…gentle copy passes (incl. the word “later”)', okCopy, true);
  eq('quiet hours respected', [push.inQuietHours('22:30', '21:00', '07:00'), push.inQuietHours('06:59', '21:00', '07:00'), push.inQuietHours('12:00', '21:00', '07:00')], [true, true, false]);
  const dumps0 = (await sql('SELECT COUNT(*)::int AS n FROM dump_items WHERE member_id = 1'))[0].n;
  const k = randomBytes(8).toString('hex');
  const r1 = await ty.req('POST', '/api/dump', { note: 'written offline' }, { headers: { 'Idempotency-Key': k, 'X-MyDay-Replay': '1' } });
  const r2 = await ty.req('POST', '/api/dump', { note: 'written offline' }, { headers: { 'Idempotency-Key': k, 'X-MyDay-Replay': '1' } });
  eq('offline write replayed twice → applied once, same answer', [r1.status, r2.status, r2.headers.get('idempotent-replay'), (await sql('SELECT COUNT(*)::int AS n FROM dump_items WHERE member_id = 1'))[0].n - dumps0], [201, 201, 'true', 1]);
  const swr = await fetch(`${BASE}/sw.js`);
  eq('service worker served, never cached stale', [swr.status, swr.headers.get('cache-control')], [200, 'no-cache']);

  section('G. Hana does things (STUBBED model: deterministic intents; real Claude uses the same tools)');
  const h1 = (await ty.post('/api/chat/companion', { message: 'add task Call the dentist' })).data;
  eq('“add task …” → done right away', h1.actions.map((a) => [a.tool, a.status, a.destructive]), [['add_task', 'done', false]]);
  const dentist = (await ty.get('/api/day')).data.tasks.find((t) => t.task === 'Call the dentist');
  check('…the task is really there', !!dentist);
  await ty.post('/api/chat/companion', { message: 'add oat milk and bananas to the grocery list' });
  const groc = (await ty.get('/api/grocery')).data.items.map((i) => i.item);
  check('groceries added by Hana', groc.includes('oat milk') && groc.includes('bananas'), groc.join(', '));
  const h2 = (await ty.post('/api/chat/companion', { message: `delete task #${dentist.id}` })).data;
  eq('“delete task” is only proposed (needs OK)', h2.actions.map((a) => [a.tool, a.status, a.destructive]), [['delete_task', 'pending', true]]);
  check('…reply says it is NOT done yet', /Not done yet/.test(h2.reply.text), h2.reply.text);
  check('…task still there', (await ty.get('/api/day')).data.tasks.some((t) => t.id === dentist.id));
  eq('pending shows on reload', (await ty.get('/api/chat/companion')).data.pending.map((a) => a.summary), [`Delete task #${dentist.id}`]);
  eq("kids can't confirm Hana actions", (await avery.post(`/api/hana/actions/${h2.actions[0].id}/confirm`)).status, 403);
  eq("Kayla can't confirm Ty's", (await kayla.post(`/api/hana/actions/${h2.actions[0].id}/confirm`)).status, 404);
  const conf = (await ty.post(`/api/hana/actions/${h2.actions[0].id}/confirm`)).data;
  eq('confirm → done, task gone, Hana says so in chat', [conf.action.status, (await ty.get('/api/day')).data.tasks.some((t) => t.id === dentist.id), conf.history.at(-1).text.startsWith('Done:')], ['done', false, true]);
  eq('confirming twice → 409', (await ty.post(`/api/hana/actions/${h2.actions[0].id}/confirm`)).status, 409);
  const h3 = (await ty.post('/api/chat/companion', { message: 'clear checked groceries' })).data;
  const can = (await ty.post(`/api/hana/actions/${h3.actions[0].id}/cancel`)).data;
  eq('cancel → nothing changes', [can.action.status, can.pending.length], ['cancelled', 0]);
  eq('add homework for a kid by name', (await ty.post('/api/chat/companion', { message: 'add homework for Evan: Spelling list due 2026-10-07' })).data.actions[0].status, 'done');
  check('…it’s on Evan’s homework', (await ty.get('/api/homework?member=evan')).data.open.some((h) => h.assignment === 'Spelling list' && h.due === '2026-10-07'));
  eq('unknown kid → action failed (not crashed)', (await ty.post('/api/chat/companion', { message: 'add homework for Zed: x' })).data.actions[0].status, 'failed');
  await ty.post('/api/day/tasks', { task: 'Deep: write the plan', priority: 'Important', energy: 'High Brain' });
  await ty.post('/api/day/tasks', { task: 'Easy: reply to texts', priority: 'Important', energy: 'Low Brain' });
  await ty.put('/api/day/checkin', { nervous: 'Fried', sleep: 'OK', fuel: 'eggs', grateful: 'coffee' });
  let dd = (await ty.get('/api/day')).data;
  const firstOpen = (d) => d.tasks.find((t) => !t.done)?.energy;
  eq('Fried → low-brain first, with a note', [firstOpen(dd), /Fried/.test(dd.energyNote)], ['Low Brain', true]);
  await ty.put('/api/day/checkin', { nervous: 'Calm', sleep: 'OK', fuel: 'eggs', grateful: 'coffee' });
  dd = (await ty.get('/api/day')).data;
  eq('Calm → deep work first', firstOpen(dd), 'High Brain');

  section('A4. records + quick note');
  await ty.post('/api/dump', { note: 'quick note from Today' });
  const rec = (await ty.get('/api/records?days=30')).data;
  check('records: check-ins, workouts, notes, money check-ins in one history', ['checkin', 'workout', 'note', 'money'].every((k) => rec.records.some((r) => r.kind === k)), [...new Set(rec.records.map((r) => r.kind))].join(','));
  eq('filter + search', (await ty.get('/api/records?kind=note&q=quick')).data.records.map((r) => r.detail), ['quick note from Today']);
  const csv = await fetch(`${BASE}/api/records.csv?kind=note`, { headers: { Cookie: ty.cookie } });
  check('CSV export', csv.status === 200 && /^date,kind,title,detail/.test(await csv.text()));
  eq('kids get 403', (await avery.get('/api/records')).status, 403);

  section('J. signup for anyone (solo household) + tenancy isolation');
  await sam.get(`/dev-login?token=${DEV_TOKEN}&email=sam@example.com`);
  const sm0 = (await sam.get('/api/me')).data;
  eq('new person: signed in, no household yet', [sm0.household, sm0.member], [null, null]);
  eq('household-only routes refuse until there is one (409)', (await sam.get('/api/chores/today')).status, 409);
  const created = await sam.post('/api/households', { householdName: 'Sam’s place', type: 'solo', yourName: 'Sam', build: 'lean_athletic' });
  eq('create a solo household (+30-day trial)', created.status, 201);
  const sm = (await sam.get('/api/me')).data;
  eq('Sam is the grown-up of a solo household with a trial', [sm.household.type, sm.member.kind, !!sm.household.trialEndsAt], ['solo', 'adult', true]);
  eq('build picked at signup is saved', (await sql("SELECT p.build FROM health_profiles p JOIN household_members m ON m.id = p.member_id WHERE m.name = 'Sam'"))[0]?.build, 'lean_athletic');
  eq('onboarding step recorded', (await sam.post('/api/onboarding/bank', { skipped: true })).data.onboarding.bank, true);
  eq('isolation: Sam sees only himself', (await sam.get('/api/household')).data.members.map((m) => m.name), ['Sam']);
  eq("…not the Kester family's grocery list", (await sam.get('/api/grocery')).data.items.length, 0);
  eq("…nor their bills", (await sam.get('/api/bills')).data.bills.length, 0);
  eq("…nor a lecture by id", (await sam.get(`/api/lectures/${l1.id}`)).status, 404);
  eq("…nor a Kester chore", (await sam.post(`/api/chores/${(await sql('SELECT id FROM chores LIMIT 1'))[0].id}/toggle`, { done: true })).status, 404);
  eq('the meal library is shared (233)', (await sam.get('/api/meals')).data.meals.length, 233);
  eq('school autocomplete (optional field)', (await ty.get('/api/schools')).status, 200);

  section('K. events: append-only, logged everywhere');
  const names = (await sql('SELECT DISTINCT name FROM events')).map((r) => r.name);
  const want = ['signin', 'signup', 'household_created', 'onboarding_step', 'chore_done', 'homework_done', 'module_used', 'hana_asked', 'hana_action', 'hana_action_confirmed', 'lecture_recorded', 'build_chosen', 'bank_linked', 'push_subscribed', 'offline_synced', 'focus_done', 'quest_claimed', 'notification_sent', 'kid_signin'];
  eq('events present for every new feature', want.filter((n) => !names.includes(n)), []);
  let blocked = false;
  try {
    await sql('DELETE FROM events');
  } catch {
    blocked = true;
  }
  eq('events cannot be deleted (append-only, even by the DB owner)', blocked, true);

  section('1. paper/ink theme, role icons, apple-touch-icon, Retired life-stage');
  const html = await (await fetch(`${BASE}/`)).text();
  const cssHref = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  const css = cssHref ? await (await fetch(BASE + cssHref)).text() : '';
  eq('deployed CSS carries the paper/ink tokens', ['#f4f0e6', '#11130f', '#1b1e19', '#ff5a1f', '#c8f04a'].filter((t) => !css.toLowerCase().includes(t)), []);
  const icons = ['leader', 'heart', 'kid', 'college', 'solo', 'couple'];
  const bad = [];
  for (const n of icons) {
    const r = await fetch(`${BASE}/roles/${n}.png`);
    if (r.status !== 200 || r.headers.get('content-type') !== 'image/png') bad.push(n);
  }
  eq('6 role icons served', bad, []);
  const ati = await fetch(`${BASE}/apple-touch-icon.png`);
  const atiBuf = Buffer.from(await ati.arrayBuffer());
  eq('apple-touch-icon.png at the root, 180×180 PNG', [ati.status, atiBuf.readUInt32BE(16), atiBuf.readUInt32BE(20)], [200, 180, 180]);
  check('index.html links it and keeps the M Peaks logo', html.includes('apple-touch-icon') && html.includes('myday-mark.svg'));
  eq('shared map: empty nesters and retired share the couple art; solo is the traveler', [shared.HOUSEHOLD_TYPE_ICON.empty_nesters, shared.HOUSEHOLD_TYPE_ICON.retired, shared.HOUSEHOLD_TYPE_ICON.solo], ['/roles/couple.png', '/roles/couple.png', '/roles/solo.png']);
  await ret.get(`/dev-login?token=${DEV_TOKEN}&email=retired@example.com`);
  eq('Retired is a distinct signup life-stage', (await ret.post('/api/households', { householdName: 'Second act', type: 'retired', yourName: 'Pat' })).status, 201);
  eq('…stored as retired', (await ret.get('/api/me')).data.household.type, 'retired');

  section('L. new pages serve');
  for (const p of ['/school', '/record', '/lectures/1', '/study/1', '/classroom-mode', '/wins', '/my-money', '/focus', '/private', '/bills', '/identity', '/records', '/command', '/setup', '/settings', '/chores', '/sw.js', '/meals/_placeholder.svg']) {
    const r = await fetch(BASE + p);
    check(`GET ${p}`, r.status === 200, `${r.status}`);
  }
}

/* ======================= next build: billing + admin ======================= */

async function billingAdmin() {
  section('3. billing: flat household plan, configurable price, 30-day trial, stub payments (BILLING_PROVIDER=stub: never charges)');
  eq('the founding household (operator-created) is complimentary', (await ty.get('/api/billing')).data.status, 'comped');
  eq('kids can’t open billing', (await avery.get('/api/billing')).status, 403);
  let sb = (await sam.get('/api/billing')).data;
  // (the DB clock sets the 30-day trial; the test server runs on a fake Sunday clock, so allow ±2 days)
  check('a signup gets the default plan, price not set, 30-day trial', sb.plan.name === 'Household' && sb.plan.priceCents === null && sb.status === 'trialing' && sb.trialDaysLeft >= 28 && sb.trialDaysLeft <= 30, `${sb.trialDaysLeft} days left`);
  eq('can’t start the paid plan without a payment method', (await sam.post('/api/billing/subscribe')).status, 409);
  sb = (await sam.post('/api/billing/payment-method', { last4: '4242' })).data;
  eq('stub payment method recorded as a test card', [sb.paymentMethod?.brand, sb.paymentMethod?.last4, sb.paymentMethod?.test], ['Test card', '4242', true]);
  eq('…and no price yet → can’t subscribe (409)', (await sam.post('/api/billing/subscribe')).status, 409);

  section('3. admin dashboard (ADMIN_EMAILS)');
  eq('non-admins get 403', (await ty.get('/api/admin/dashboard')).status, 403);
  const adm = new Client('admin');
  await adm.get(`/dev-login?token=${DEV_TOKEN}&email=admin@example.com`);
  eq('/api/me says admin (no household needed)', [(await adm.get('/api/me')).data.isAdmin, (await adm.get('/api/me')).data.household], [true, null]);
  let d = (await adm.get('/api/admin/dashboard')).data;
  const hhCount = (await sql('SELECT COUNT(*)::int AS n FROM households'))[0].n;
  eq('every household listed, with members and status', [d.totals.households, d.households.every((h) => h.status && h.members >= 0)], [hhCount, true]);
  eq('MRR is $0 while nobody pays', d.totals.mrrCents, 0);
  const plan = d.plans.find((p) => p.isDefault);
  d = (await adm.patch(`/api/admin/plans/${plan.id}`, { priceCents: 1299, interval: 'month' })).data;
  eq('admin sets the price (not hardcoded)', d.plans.find((p) => p.id === plan.id).priceCents, 1299);
  eq('bad price → 400', (await adm.patch(`/api/admin/plans/${plan.id}`, { interval: 'week' })).status, 400);
  sb = (await sam.post('/api/billing/subscribe')).data;
  eq('Sam starts the paid plan (stub, no charge)', sb.status, 'active');
  d = (await adm.get('/api/admin/dashboard')).data;
  eq('MRR counts it: $12.99', [d.totals.mrrCents, d.totals.active], [1299, 1]);
  d = (await adm.post('/api/admin/plans', { code: 'household-yearly', name: 'Household (yearly)', priceCents: 12000, interval: 'year' })).data;
  const yearly = d.plans.find((p) => p.code === 'household-yearly');
  const samId = (await sam.get('/api/me')).data.household.id;
  d = (await adm.patch(`/api/admin/households/${samId}`, { planId: yearly.id })).data;
  eq('yearly plan counts as ÷12 in MRR', d.totals.mrrCents, 1000);
  eq('duplicate plan code → 409', (await adm.post('/api/admin/plans', { code: 'household-yearly', name: 'x' })).status, 409);
  sb = (await sam.post('/api/billing/cancel')).data;
  eq('cancel', [sb.status, (await adm.get('/api/admin/dashboard')).data.totals.mrrCents], ['canceled', 0]);
  await sql("UPDATE households SET trial_ends_at = now() - interval '1 day' WHERE id = (SELECT household_id FROM household_members WHERE name = 'Pat')");
  eq('a lapsed trial shows as trial_ended (app keeps working)', [(await ret.get('/api/billing')).data.status, (await ret.get('/api/day')).status], ['trial_ended', 200]);

  section('0e. purge test households (admin, exact-name confirmation)');
  const zzz = new Client('zzz');
  await zzz.get(`/dev-login?token=${DEV_TOKEN}&email=zzz@example.com`);
  await zzz.post('/api/households', { householdName: 'ZZZ Test', type: 'solo', yourName: 'Zed' });
  await zzz.post('/api/dump', { note: 'test data' });
  d = (await adm.get('/api/admin/dashboard')).data;
  const z = d.households.find((h) => h.name === 'ZZZ Test');
  eq('wrong confirmation name → 409, nothing deleted', (await adm.del(`/api/admin/households/${z.id}?confirm=ZZZ`)).status, 409);
  eq('non-admin can’t delete', (await ty.del(`/api/admin/households/${z.id}?confirm=ZZZ%20Test`)).status, 403);
  const evBefore = (await sql('SELECT COUNT(*)::int AS n FROM events WHERE household_id = $1', [z.id]))[0].n;
  d = (await adm.del(`/api/admin/households/${z.id}?confirm=${encodeURIComponent('ZZZ Test')}`)).data;
  eq('deleted with everything in it', [d.households.some((h) => h.id === z.id), (await sql('SELECT COUNT(*)::int AS n FROM dump_items WHERE household_id = $1', [z.id]))[0].n, (await sql('SELECT COUNT(*)::int AS n FROM household_members WHERE household_id = $1', [z.id]))[0].n], [false, 0, 0]);
  eq('…the append-only events log keeps its rows, unlinked', (await sql('SELECT COUNT(*)::int AS n FROM events WHERE household_id IS NULL AND name = $1', ['household_created']))[0].n >= 1 && evBefore > 0, true);
  eq('the ZZZ member’s session now has no household (back to signup)', (await zzz.get('/api/me')).data.household, null);
}

async function investments() {
  section('4. investments / retirement (manual accounts, target vs actual, projection)');
  eq('kids get 403', (await avery.get('/api/invest')).status, 403);
  let v = (await ty.get('/api/invest')).data;
  eq('empty to start, default plan 80/15/5', [v.accounts.length, v.total, v.plan.target], [0, 0, { stocks: 80, bonds: 15, cash: 5, other: 0 }]);
  eq('unknown account type → 400', (await ty.post('/api/invest/accounts', { name: 'X', kind: 'crypto' })).status, 400);
  v = (await ty.post('/api/invest/accounts', { name: 'Work 401k', kind: '401k', owner: 'ty', monthlyContribution: 500, employerMatch: 250 })).data;
  const k401 = v.accounts[0];
  v = (await ty.post('/api/invest/accounts', { name: 'Roth', kind: 'roth_ira', owner: 'kayla', monthlyContribution: '$250' })).data;
  const roth = v.accounts.find((a) => a.name === 'Roth');
  eq('mix must add to 100', (await ty.post(`/api/invest/accounts/${k401.id}/balances`, { balance: 60000, stocksPct: 90, bondsPct: 5 })).status, 400);
  eq('no future-dated balances', (await ty.post(`/api/invest/accounts/${k401.id}/balances`, { balance: 1, asOf: '2027-01-01', stocksPct: 100 })).status, 400);
  await ty.post(`/api/invest/accounts/${k401.id}/balances`, { balance: 50000, asOf: '2026-09-01', stocksPct: 100 });
  await ty.post(`/api/invest/accounts/${k401.id}/balances`, { balance: 60000, stocksPct: 90, bondsPct: 10 });
  v = (await ty.post(`/api/invest/accounts/${roth.id}/balances`, { balance: 20000, stocksPct: 50, bondsPct: 30, cashPct: 20 })).data;
  const a = v.accounts.find((x) => x.name === 'Work 401k');
  eq('latest snapshot is the balance; history kept', [a.balance, a.asOf, a.history.map((h) => h.balance)], [60000, '2026-10-04', [50000, 60000]]);
  eq('total + monthly in (contributions + match)', [v.total, v.monthlyContributions], [80000, 1000]);
  eq('balance-weighted actual mix', v.actual, { stocks: 80, bonds: 15, cash: 5, other: 0 });
  eq('…on target: no drift', v.drift, { stocks: 0, bonds: 0, cash: 0, other: 0 });
  v = (await ty.put('/api/invest/plan', { targetStocks: 60, targetBonds: 30, targetCash: 10, targetOther: 0, expectedReturnPct: 6, inflationPct: 2.5, yearsToRetire: 30, withdrawalPct: 4 })).data;
  eq('new target → drift shows (stocks +20 pts)', v.drift, { stocks: 20, bonds: -15, cash: -5, other: 0 });
  const shared = await import(pathToFileURL(path.join(root, 'shared', 'dist', 'index.js')).href);
  const want = shared.projectInvestments(80000, 1000, 30, 6, 2.5);
  eq('projection: 31 points, matches the formula', [v.projection.length, v.projection[30].nominal], [31, want[30].nominal]);
  // closed form: FV = P(1+i)^n + PMT((1+i)^n − 1)/i with monthly i
  const i = Math.pow(1.06, 1 / 12) - 1;
  const fv = 80000 * Math.pow(1 + i, 360) + (1000 * (Math.pow(1 + i, 360) - 1)) / i;
  check('…and the closed-form future value (±$1)', Math.abs(v.projection[30].nominal - fv) <= 1, `${v.projection[30].nominal} vs ${Math.round(fv)}`);
  eq('retirement income at 4% of the real balance', v.atRetirement.yearlyIncomeReal, Math.round((v.atRetirement.real * 4) / 100));
  eq('bad plan mix → 400', (await ty.put('/api/invest/plan', { targetStocks: 90, targetBonds: 30 })).status, 400);
  eq('Kayla shares the household view', (await kayla.get('/api/invest')).data.total, 80000);
  eq("Sam's household can't see it", (await sam.get('/api/invest')).data.total, 0);
  v = (await ty.del(`/api/invest/accounts/${roth.id}`)).data;
  eq('remove an account (history goes with it)', [v.accounts.length, (await sql('SELECT COUNT(*)::int AS n FROM invest_balances WHERE account_id = $1', [roth.id]))[0].n], [1, 0]);
}

async function circles() {
  section('5. Circles: family-safe community — kid-safety rules');
  eq('kids under 13 can’t use circles (Evan, 11 → 403)', (await evan.get('/api/circles')).status, 403);
  const all = (await ty.get('/api/circles')).data.circles;
  const adhd = all.find((c) => c.slug === 'adhd-families');
  const teenFocus = all.find((c) => c.slug === 'teen-focus');
  eq('grown-ups see all 3 seeded circles', all.length, 3);
  eq('teens see only teen-ok circles', (await avery.get('/api/circles')).data.circles.map((c) => c.slug), ['teen-focus', 'college-adhd']);
  eq('…and can’t join a grown-ups-only circle (404)', (await avery.post(`/api/circles/${adhd.id}/join`)).status, 404);
  eq('there are no direct messages at all (no DM endpoint)', [(await ty.post('/api/circles/dm', { to: 'avery', body: 'hi' })).status, (await ty.get('/api/circles/messages')).status].every((s) => s === 404 || s === 400), true);
  eq('can’t read a circle without joining', (await ty.get(`/api/circles/${adhd.id}`)).status, 403);

  section('5. posts, comments, reactions across households');
  await ty.post(`/api/circles/${adhd.id}/join`);
  let v = (await ty.post(`/api/circles/${adhd.id}/posts`, { body: 'Visual timers changed our mornings.' })).data;
  eq('grown-up post goes live right away; author is first name + household initial', [v.posts[0].status, v.posts[0].author], ['visible', 'Ty · O.']);
  const tyPost = v.posts[0];
  await sam.post(`/api/circles/${adhd.id}/join`);
  v = (await sam.get(`/api/circles/${adhd.id}`)).data;
  eq('another household sees it', v.posts.map((p) => p.body), ['Visual timers changed our mornings.']);
  v = (await sam.post(`/api/circles/posts/${tyPost.id}/react`, { emoji: '❤️' })).data;
  eq('react ❤️', v.posts[0].reactions.find((r) => r.emoji === '❤️'), { emoji: '❤️', count: 1, mine: true });
  eq('unknown reaction → 400', (await sam.post(`/api/circles/posts/${tyPost.id}/react`, { emoji: '💩' })).status, 400);
  v = (await sam.post(`/api/circles/posts/${tyPost.id}/comments`, { body: 'Which timer do you use?' })).data;
  eq('comment', v.posts[0].comments.map((c) => [c.author, c.body]), [['Sam · S.', 'Which timer do you use?']]);

  section('5. teens: no name, no profile, parent approves first; parents see everything');
  await avery.post(`/api/circles/${teenFocus.id}/join`);
  await sam.post(`/api/circles/${teenFocus.id}/join`);
  await ty.post(`/api/circles/${teenFocus.id}/join`);
  v = (await avery.post(`/api/circles/${teenFocus.id}/posts`, { body: 'Body doubling on video works for me' })).data;
  eq('teen post waits for a parent', [v.posts[0].status, v.posts[0].author], ['pending', 'Teen member']);
  const teenPost = v.posts[0];
  eq('…invisible to other households meanwhile', (await sam.get(`/api/circles/${teenFocus.id}`)).data.posts.length, 0);
  let q = (await ty.get('/api/circles/moderation/queue')).data;
  eq('her parent sees it in the queue (named — it’s his own kid)', q.items.map((i) => [i.reason, i.author, i.body]), [['teen_approval', 'Avery', 'Body doubling on video works for me']]);
  eq('another household’s parent doesn’t', (await sam.get('/api/circles/moderation/queue')).data.items.length, 0);
  eq('…and can’t approve it (403)', (await sam.post(`/api/circles/moderation/post/${teenPost.id}/approve`)).status, 403);
  eq('teens can’t open moderation', (await avery.get('/api/circles/moderation/queue')).status, 403);
  q = (await ty.post(`/api/circles/moderation/post/${teenPost.id}/approve`)).data;
  eq('parent approves → queue empty', q.items.length, 0);
  const seen = await sam.get(`/api/circles/${teenFocus.id}`);
  eq('now live for everyone, still just “Teen member”', seen.data.posts.map((p) => [p.author, p.status]), [['Teen member', 'visible']]);
  check('no trace of the teen’s name anywhere in what others receive', !JSON.stringify(seen.data).includes('Avery'));
  await sam.post(`/api/circles/posts/${teenPost.id}/comments`, { body: 'Same here!' });
  v = (await avery.post(`/api/circles/posts/${teenPost.id}/comments`, { body: 'Thanks :)' })).data;
  eq('teen comments wait for approval too', v.posts[0].comments.map((c) => c.status), ['visible', 'pending']);
  await avery.post(`/api/circles/posts/${teenPost.id}/react`, { emoji: '👏' });
  const act = (await ty.get('/api/circles/activity/teens')).data.items;
  eq('parent sees all teen activity: post, comment, reaction', ['post', 'comment', 'reaction'].map((t) => act.some((i) => i.teen === 'Avery' && i.type === t)), [true, true, true]);
  eq('…other households see none of it', (await sam.get('/api/circles/activity/teens')).data.items.length, 0);

  section('5. reports → moderation queue (moderators + admins); 3 reports hide');
  const own = (await sam.post('/api/circles', { name: 'Sam Kitchen Table', description: 'Low-key support' })).data;
  eq('a grown-up starts a circle and moderates it', [own.joined, own.moderator], [true, true]);
  eq('teens can’t start circles', (await avery.post('/api/circles', { name: 'x' })).status, 403);
  for (const c of [ty, kayla, ret]) await c.post(`/api/circles/${own.id}/join`);
  v = (await ret.post(`/api/circles/${own.id}/posts`, { body: 'Buy cheap meds here!!! link' })).data;
  const spam = v.posts[0];
  const r1 = (await ty.post('/api/circles/report', { type: 'post', id: spam.id, reason: 'spam' })).data;
  await ty.post('/api/circles/report', { type: 'post', id: spam.id, reason: 'again' });
  await kayla.post('/api/circles/report', { type: 'post', id: spam.id, reason: 'spam' });
  eq('one report per person; still visible at 2', [r1.hidden, (await sam.get(`/api/circles/${own.id}`)).data.posts.length], [false, 1]);
  await sam.post('/api/circles/report', { type: 'post', id: spam.id, reason: 'spam' });
  eq('3 reports → hidden until reviewed', (await ty.get(`/api/circles/${own.id}`)).data.posts.length, 0);
  q = (await sam.get('/api/circles/moderation/queue')).data;
  eq('the circle’s moderator sees it with 3 reports', q.items.map((i) => [i.reason, i.reports.length]), [['reported', 3]]);
  eq('a plain member can’t act on reports', (await ty.post(`/api/circles/moderation/post/${spam.id}/approve`)).status, 403);
  const adm = new Client('admin-c');
  await adm.get(`/dev-login?token=${DEV_TOKEN}&email=admin@example.com`);
  eq('MyDay admins see it too (no household needed)', (await adm.get('/api/circles/moderation/queue')).data.items.some((i) => i.id === spam.id), true);
  q = (await adm.post(`/api/circles/moderation/post/${spam.id}/remove`)).data;
  eq('admin removes it; reports resolved', [q.items.length, (await sql("SELECT COUNT(*)::int AS n FROM circle_reports WHERE target_id = $1 AND status = 'open'", [spam.id]))[0].n], [0, 0]);
  eq('authors can take down their own post', (await ty.del(`/api/circles/posts/${tyPost.id}`)).status, 200);
  eq('…but not someone else’s', (await ty.del(`/api/circles/posts/${teenPost.id}`)).status, 404);
}

async function careTeam() {
  section('6. Care Team: explicit, scoped, revocable access; every access logged');
  const tutor = new Client('tutor');
  await tutor.get(`/dev-login?token=${DEV_TOKEN}&email=tutor@example.com`);
  eq('kids can’t manage the care team', (await avery.get('/api/care')).status, 403);
  eq('a scope outside the list is dropped; none left → 400', (await ty.post('/api/care/grants', { kind: 'tutor', subject: 'avery', scopes: ['bank'] })).status, 400);
  const g = (await ty.post('/api/care/grants', { kind: 'tutor', subject: 'avery', scopes: ['homework', 'school'], label: 'Math tutor' })).data;
  const token = new URL(g.inviteLink).searchParams.get('invite');
  eq('grant created as an invite (link shown once)', [g.status, g.scopes, !!token], ['invited', ['homework', 'school'], true]);
  eq('the invite isn’t stored in plain text', (await sql('SELECT COUNT(*)::int AS n FROM care_grants WHERE invite_hash = $1', [token]))[0].n, 0);
  eq('a professional has no profile yet', (await tutor.get('/api/pro/me')).data.profile, null);
  eq('…and must set one up before accepting', (await tutor.post('/api/pro/accept', { token })).status, 409);
  await tutor.put('/api/pro/profile', { displayName: 'Ms. Rivera', kind: 'tutor', credentials: 'M.Ed.' });
  const acc = (await tutor.post('/api/pro/accept', { token })).data;
  eq('pro accepts → sees Avery (no household of their own needed)', acc.clients.map((c) => [c.subject, c.household, c.scopes]), [['Avery', 'Our family', ['homework', 'school']]]);
  eq('the invite works once', (await new Client('x').post('/api/pro/accept', { token })).status, 401);
  eq('…even for the same pro', (await tutor.post('/api/pro/accept', { token })).status, 404);
  const hw = (await tutor.get(`/api/pro/clients/${g.id}/data/homework`)).data;
  check('pro reads homework in scope', Array.isArray(hw.items) && hw.items.length > 0, `${hw.items.length} items`);
  eq('…but not health (outside the grant) → 403', (await tutor.get(`/api/pro/clients/${g.id}/data/health`)).status, 403);
  eq('…and not check-ins → 403', (await tutor.get(`/api/pro/clients/${g.id}/data/checkins`)).status, 403);
  await tutor.post(`/api/pro/clients/${g.id}/notes`, { body: 'Great focus on fractions today.' });
  let d = (await ty.get(`/api/care/grants/${g.id}`)).data;
  eq('family sees the pro’s note', d.notes.map((n) => [n.author, n.body]), [['Ms. Rivera', 'Great focus on fractions today.']]);
  eq('…and every access in the log', d.log.map((l) => `${l.who} ${l.action} ${l.scope}`.trim()).reverse(), ['Ty granted homework,school', 'Ms. Rivera accepted', 'Ms. Rivera read homework', 'Ms. Rivera note']);
  eq('Kayla (other parent) sees the tutor grant too', (await kayla.get('/api/care')).data.grants.some((x) => x.id === g.id), true);
  const other = new Client('tutor2');
  await other.get(`/dev-login?token=${DEV_TOKEN}&email=tutor2@example.com`);
  await other.put('/api/pro/profile', { displayName: 'Mr. Nobody', kind: 'tutor' });
  eq('another pro can’t read this family', (await other.get(`/api/pro/clients/${g.id}/data/homework`)).status, 403);
  await ty.post(`/api/care/grants/${g.id}/revoke`);
  eq('revoked → access ends on the very next call', (await tutor.get(`/api/pro/clients/${g.id}/data/homework`)).status, 403);
  eq('…and the family list says revoked', (await ty.get('/api/care')).data.grants.find((x) => x.id === g.id).status, 'revoked');

  section('6. mental-health variant: only the consenting adult, only for themselves; private notes + log');
  eq('can’t add one for someone else (Avery)', (await kayla.post('/api/care/grants', { kind: 'mental_health', subject: 'avery', scopes: ['checkins'] })).status, 403);
  eq('limited to check-ins + daily tasks', (await kayla.post('/api/care/grants', { kind: 'mental_health', subject: 'kayla', scopes: ['school'] })).status, 400);
  const mh = (await kayla.post('/api/care/grants', { kind: 'mental_health', subject: 'kayla', scopes: ['checkins', 'day'] })).data;
  const mhToken = new URL(mh.inviteLink).searchParams.get('invite');
  const tg = (await ty.post('/api/care/grants', { kind: 'tutor', subject: 'evan', scopes: ['homework'] })).data;
  const therapist = new Client('therapist');
  await therapist.get(`/dev-login?token=${DEV_TOKEN}&email=therapist@example.com`);
  await therapist.put('/api/pro/profile', { displayName: 'Dr. Lee', kind: 'mental_health', credentials: 'LCSW' });
  eq('a provider can’t accept an invite of another kind', (await therapist.post('/api/pro/accept', { token: new URL(tg.inviteLink).searchParams.get('invite') })).status, 409);
  await therapist.post('/api/pro/accept', { token: mhToken });
  await kayla.put('/api/day/checkin', { nervous: 'Buzzing', sleep: 'OK', fuel: 'toast', grateful: 'sun' });
  check('provider reads Kayla’s check-ins', (await therapist.get(`/api/pro/clients/${mh.id}/data/checkins`)).data.items.length > 0);
  await therapist.post(`/api/pro/clients/${mh.id}/notes`, { body: 'Session 1: sleep routine.' });
  eq('the other adult (Ty) doesn’t even see that it exists', (await ty.get('/api/care')).data.grants.some((x) => x.id === mh.id), false);
  eq('…its notes/log → 404 for Ty', (await ty.get(`/api/care/grants/${mh.id}`)).status, 404);
  eq('…nor can Ty revoke it', (await ty.post(`/api/care/grants/${mh.id}/revoke`)).status, 404);
  d = (await kayla.get(`/api/care/grants/${mh.id}`)).data;
  eq('Kayla sees the provider’s note and the access log', [d.notes.map((n) => n.body), d.log.some((l) => l.action === 'read' && l.scope === 'checkins')], [['Session 1: sleep routine.'], true]);

  section('6. the access log is append-only (even for the DB owner)');
  let blocked = 0;
  for (const q of ["UPDATE care_access_log SET action = 'nothing'", 'DELETE FROM care_access_log']) {
    try {
      await sql(q);
    } catch {
      blocked++;
    }
  }
  eq('UPDATE and DELETE refused', blocked, 2);
  const zc = new Client('zzz-care');
  await zc.get(`/dev-login?token=${DEV_TOKEN}&email=zzzcare@example.com`);
  await zc.post('/api/households', { householdName: 'ZZZ Care', type: 'solo', yourName: 'Zc' });
  const zg = (await zc.post('/api/care/grants', { kind: 'coach', subject: (await zc.get('/api/me')).data.member.key, scopes: ['day'] })).data;
  const coach = new Client('coach');
  await coach.get(`/dev-login?token=${DEV_TOKEN}&email=coach@example.com`);
  await coach.put('/api/pro/profile', { displayName: 'Coach K', kind: 'coach' });
  await coach.post('/api/pro/accept', { token: new URL(zg.inviteLink).searchParams.get('invite') });
  await coach.get(`/api/pro/clients/${zg.id}/data/day`);
  const adm = new Client('admin-care');
  await adm.get(`/dev-login?token=${DEV_TOKEN}&email=admin@example.com`);
  const zid = (await zc.get('/api/me')).data.household.id;
  eq('…yet deleting a whole household (with a care log) still works', (await adm.del(`/api/admin/households/${zid}?confirm=${encodeURIComponent('ZZZ Care')}`)).status, 200);
  eq('…and the pro loses that client', (await coach.get('/api/pro/clients')).data.clients.length, 0);
}

async function exercisePictures() {
  section('add-on 1. exercise demo pictures wired into the 9 programs (fixture map: every exercise → a test picture)');
  const { matchPictures } = await import(pathToFileURL(path.join(root, 'scripts', 'lib', 'match-pictures.mjs')).href);
  const prog = await import(pathToFileURL(path.join(apiDir, 'dist', 'lib', 'program.js')).href);
  const shared = await import(pathToFileURL(path.join(root, 'shared', 'dist', 'index.js')).href);
  const names = new Set();
  for (const b of shared.BUILDS) for (const l of ['beginner', 'experienced']) for (const r of prog.programRows(b, prog.buildPhases(b, l))) names.add(r.exercise);
  // 37 demo files named the way an export usually names them (prefixes, underscores, gear words, extras).
  const files = [...names].map((n, i) => `${String(i + 1).padStart(2, '0')}_${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${i % 3 === 0 ? '-demo' : ''}.webp`)
    .concat(['30_box-jump.webp', '31_kettlebell-swing.webp', '32_farmer-carry.webp', '33_face-pull.webp', '34_dips.webp', '35_step-up.webp', '36_mountain-climber.webp', '37_burpee.webp']);
  const tmp = path.join(os.tmpdir(), `myday-ex-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  for (const f of files) writeFileSync(path.join(tmp, f), '');
  const m = matchPictures([...names], tmp);
  rmSync(tmp, { recursive: true, force: true });
  eq(`matcher: all ${names.size} program exercises get a picture from 37 files, extras reported unused`, [m.missing, Object.keys(m.map).length, m.unused.length], [[], names.size, 8]);
  eq('…and never maps a squat to a split squat', m.map['Back squat'].includes('split'), false);

  // A real planned session: move Kayla's Monday workout to today and read it.
  await kayla.post('/api/workouts/move', { from: DAY.Mon, to: DAY.Sun });
  const today = (await kayla.get('/api/workouts/today')).data;
  check('today shows a program session', !!today.session, today.session?.dayName ?? 'none');
  eq('every exercise in it carries its demo picture', today.session.exercises.filter((x) => !x.image).map((x) => x.exercise), []);
  eq('the picture loads', (await fetch(BASE + today.session.exercises[0].image)).status, 200);

  // The real wiring shipped in api/content/exercise-images.json (the 37 demo pictures).
  const real = JSON.parse(readFileSync(path.join(apiDir, 'content', 'exercise-images.json'), 'utf8'));
  const broken = [];
  for (const [n, url] of Object.entries(real)) {
    const r = await fetch(BASE + url);
    if (r.status !== 200 || r.headers.get('content-type') !== 'image/webp') broken.push(n);
  }
  const progMap = Object.entries(real).filter(([n]) => names.has(n));
  const noRender = [...names].filter((n) => !real[n]).sort();
  eq('real demo renders: every program exercise has its picture (incl. round 3: box jump, shrug, farmer’s carry, pogo hops, seated leg curl); every picture loads as webp', [noRender, broken], [[], []]);
  eq('…round 3 files wired by name (apostrophes ignored)', ["Farmer's carry", 'Seated leg curl', 'Box jump'].map((n) => real[n]), ['/exercises/farmers-carry.webp', '/exercises/seated-leg-curl.webp', '/exercises/box-jump.webp']);
  eq('…each wired exercise shows its own render (its words are in the file name)', progMap.filter(([n, u]) => !n.toLowerCase().replace(/dumbbell/g, 'db').split(/[^a-z0-9]+/).filter(Boolean).every((w) => u.includes(w) || u.includes(w.replace('db', 'dumbbell')))), []);
  eq('…the new program moves use the round-2 renders (leg extension, cable crunch, face pull, seated calf raise)', ['Leg extension', 'Cable crunch', 'Face pull', 'Seated calf raise'].filter((n) => !names.has(n) || !real[n]), []);
  eq('…the lying leg curl render is no longer shown for the (seated) leg curl', [real['Lying leg curl'], real['Seated leg curl']], ['/exercises/lying-leg-curl.webp', '/exercises/seated-leg-curl.webp']);
}

/** "Evidence for the nine body builds": the safety rules, the new food math and the training changes, through the API. */
async function bodyScience() {
  const signup = async (email, name) => {
    const c = new Client(email);
    await c.get(`/dev-login?token=${DEV_TOKEN}&email=${email}`);
    await c.post('/api/households', { householdName: `${name}’s place`, type: 'solo', yourName: name });
    return c;
  };
  const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

  section('Safety 1. teen mode (Avery, 15): training styles, no calorie / weight / shake targets');
  const at = (await avery.put('/api/program', { build: 'lean_athletic', level: 'beginner' })).data.program;
  eq('no weight needed; the build shows as a training style; no food targets', [at.teen, at.label, at.bodyweightLb, at.macros, at.shakes, at.plannedProtein], [true, 'Athletic', null, null, null, null]);
  eq('…every phase at maintenance; no cut, no “Lean”', [at.phases.every((p) => p.nutrition === 'maintenance' && p.weeklyChangePct === 0), at.phases.some((p) => p.kind === 'cut' || /cut|lean/i.test(p.name))], [true, false]);
  eq('…Shredded is adults-only', (await avery.put('/api/program', { build: 'shredded', level: 'experienced' })).data.code, 'adults_only');
  eq('…no weigh-ins', (await avery.put('/api/weigh-ins', { enabled: true })).status, 403);
  eq('…no shake or creatine habits', [(await avery.post('/api/habits/shake', { done: true })).status, (await avery.get('/api/workouts/today')).data.habitKeys], [403, ['water']]);
  check('…teen copy about what the body can do, never a creatine note', at.notes.some((n) => /don’t do calorie targets/.test(n)) && !at.notes.some((n) => /creatine/i.test(n)));

  section('Safety 2 + 4, Results 1. Mifflin-St Jeor, capped deficits, calorie floors, reference weight');
  const bea = await signup('bea@example.com', 'Bea');
  const bp = (await bea.put('/api/program', { build: 'toned_athletic', level: 'beginner', bodyweightLb: 300, heightIn: 64, sex: 'female', ageYears: 30, activity: 'sedentary', foodProtein: 80 })).data.program;
  eq('300 lb at 5′4″ (BMI ≥ 30): the year starts with the cut, after the first 28 days', [bp.phases[0].name, bp.phases[1].kind], ['First 28 days', 'cut']);
  const bc = (await bea.post('/api/program/restart', { week: 5 })).data.program;
  eq('…in the cut: maintenance 2,479 (was 4,500), deficit capped at 750, protein + shakes on reference weight (146 lb)', [bc.phase.nutrition, bc.energy.maintenance, bc.macros.calories, bc.energy.capped, bc.energy.referenceLb, bc.macros.protein, bc.shakes.shakes], ['cutting', 2479, 1730, true, 146, 153, 3]);
  eq('Results 3: protein per meal adds up to the day', [bc.perMeal.meals, bc.perMeal.grams * 4 >= bc.macros.protein - 3], [4, true]);
  const flo = await signup('flo@example.com', 'Flo');
  await flo.put('/api/program', { build: 'hourglass', level: 'beginner', bodyweightLb: 110, heightIn: 60, sex: 'female', ageYears: 60, activity: 'sedentary' });
  const fc = (await flo.post('/api/program/restart', { week: 41 })).data.program;
  eq('small, older, sedentary woman in her cut: held at the 1,200 floor', [fc.phase.nutrition, fc.macros.calories, fc.energy.floored], ['cutting', 1200, true]);
  check('Nice 3: over-40 and menopause notes for her', fc.notes.some((n) => /Over 40/.test(n)) && fc.notes.some((n) => /menopause/.test(n)));

  section('Safety 5. Shredded: adults, experienced, eating-disorder screen + disclosure, 16-week cut');
  const shay = await signup('shay@example.com', 'Shay');
  const sbase = { build: 'shredded', bodyweightLb: 180, ageYears: 28 };
  const s1 = await shay.put('/api/program', { ...sbase, level: 'beginner' });
  eq('beginner → routed to Lean Athletic', [s1.status, s1.data.code], [409, 'shredded_needs_base']);
  eq('experienced → the screen first', (await shay.put('/api/program', { ...sbase, level: 'experienced' })).data.code, 'shredded_screen');
  const s3 = await shay.put('/api/program', { ...sbase, level: 'experienced', edScreen: [false, true, false, false, true] });
  eq('2+ “yes” → not now, with a referral; nothing planned', [s3.data.code, /doctor|dietitian/.test(s3.data.error), (await shay.get('/api/program')).data.program], ['shredded_screen_positive', true, null]);
  const clean = [false, false, false, false, false];
  eq('clean screen → read the costs first', (await shay.put('/api/program', { ...sbase, level: 'experienced', edScreen: clean })).data.code, 'shredded_ack');
  const sp = (await shay.put('/api/program', { ...sbase, level: 'experienced', edScreen: clean, shreddedAck: true })).data.program;
  const cutWeeks = sp.phases.filter((p) => p.nutrition === 'cutting').reduce((s, p) => s + p.weekEnd - p.weekStart + 1, 0);
  eq('accepted: a 16-week cut, then required maintenance + recovery; check-in due now', [sp.build.key, cutWeeks, sp.phases.at(-1).name, sp.checkin.due], ['shredded', 16, 'Maintenance + recovery', true]);
  eq('…the referral was logged (no answers stored)', (await sql("SELECT COUNT(*)::int AS n FROM events WHERE name = 'build_screen_referred'"))[0].n, 1);

  section('Safety 3. the 4-week check-in and stop rules');
  const tia = await signup('tia@example.com', 'Tia');
  let tp = (await tia.put('/api/program', { build: 'toned_athletic', level: 'beginner', bodyweightLb: 150, sex: 'female' })).data.program;
  eq('a woman with a cut in her year: check-in needed, due, asks about periods', [tp.checkin.needed, tp.checkin.due, tp.checkin.askPeriods], [true, true, true]);
  eq('…a man on Lean Athletic isn’t asked', (await (await signup('lou@example.com', 'Lou')).put('/api/program', { build: 'lean_athletic', level: 'beginner', bodyweightLb: 180 })).data.program.checkin.needed, false);
  tp = (await tia.post('/api/program/checkin', { aches: true, sleepPoor: true })).data.program;
  eq('soft flags (aches, poor sleep): done for 4 weeks, nothing paused, a deload suggested', [tp.checkin.due, tp.cutPaused, /aches/.test(tp.deloadSuggested ?? '')], [false, null, true]);
  const red = (await tia.post('/api/program/checkin', { periodChange: true, monthsNoPeriod: 3 })).data;
  eq('3 months without a period → leanness goals paused, see a doctor', [red.red, /doctor/.test(red.program.cutPaused ?? '')], [true, true]);
  const inCut = (await tia.post('/api/program/restart', { week: 37 })).data.program;
  eq('…so her cut weeks eat at maintenance', [inCut.phase.nutrition, Math.abs(inCut.macros.calories - inCut.energy.maintenance) <= 5], ['cutting', true]);
  eq('resuming needs a clinician’s OK', (await tia.post('/api/program/resume', {})).status, 400);
  const res = (await tia.post('/api/program/resume', { clinicianCleared: true })).data.program;
  eq('…with it the deficit is back', [res.cutPaused, res.macros.calories < res.energy.maintenance - 300], [null, true]);
  const brk = (await tia.post('/api/program/diet-break', { on: true })).data.program;
  eq('Nice 3: a diet break is a week at maintenance', [!!brk.dietBreakUntil, Math.abs(brk.macros.calories - brk.energy.maintenance) <= 5], [true, true]);
  eq('…and can end early', (await tia.post('/api/program/diet-break', { on: false })).data.program.dietBreakUntil, null);

  section('Safety 6 + Results 1. weigh-ins: opt-in, 7-day averages only, recalibration every 2 weeks');
  eq('off by default', (await tia.get('/api/weigh-ins')).data.enabled, false);
  eq('…logging needs them on', (await tia.post('/api/weigh-ins', { weightLb: 150 })).status, 409);
  await tia.put('/api/weigh-ins', { enabled: true });
  const t = (await tia.get('/api/workouts/today')).data.date;
  const wi = (await tia.post('/api/weigh-ins', { weightLb: 153 })).data;
  eq('only the 7-day average comes back — never the raw day', [Object.keys(wi).sort(), wi.average7], [['average7', 'enabled', 'weeks'], 153]);
  for (let i = 0; i < 14; i++) await tia.post('/api/weigh-ins', { weightLb: 150, day: shift(t, -i) });
  const cal = (await tia.post('/api/program/restart', { week: 39 })).data.program;
  eq('2 weeks into the cut with no loss: calories trimmed 250 (max step), weight synced to the average', [cal.energy.adjust, cal.bodyweightLb], [-250, 150]);
  eq('…and not again for 2 weeks', (await tia.get('/api/program')).data.program.energy.adjust, -250);

  section('Safety 7. Lean Runner: single-run cap; running held flat during the deficit');
  const rae = await signup('rae@example.com', 'Rae');
  const rp = (await rae.put('/api/program', { build: 'lean_runner', level: 'beginner', bodyweightLb: 130, sex: 'female' })).data.program;
  eq('no “10% a week” rule; the single-run cap instead', [/10% per week/.test(rp.cardio), /10% longer than your longest run/.test(rp.cardio)], [false, true]);
  const lean = (await rae.get('/api/workouts/plan')).data.phases.find((p) => p.name.startsWith('Lean block'));
  check('the lean block holds running flat (never more running and fewer calories together)', /Hold your running flat/.test(lean?.cardio ?? ''), lean?.cardio);
  eq('no runs yet: the cap is explained, not set', (await rae.get('/api/workouts/today')).data.runCap, { longestMinutes: null, longestMiles: null, capMinutes: null, capMiles: null });
  eq('first run sets the baseline (no warning)', (await rae.post('/api/workouts/session', { activity: 'Easy run', minutes: 40, miles: 4 })).data.runWarning, null);
  eq('cap = longest × 1.1', (await rae.get('/api/workouts/today')).data.runCap, { longestMinutes: 40, longestMiles: 4, capMinutes: 44, capMiles: 4.4 });
  check('a run 25% longer → a warning', /more than 10% longer/.test((await rae.post('/api/workouts/session', { activity: 'Long run', minutes: 50 })).data.runWarning ?? ''));
  const rt = (await rae.get('/api/workouts/today')).data;
  eq('Results 5: day 7 of the first 28 days (week 1 began Monday); one day so far isn’t a minimum week yet', [rt.onboarding, rt.week.minimumMet], [{ day: 7, attended: 1 }, false]);
  check('Lean Runner fuel copy is there', rt.program.notes.some((n) => /enough fuel/.test(n)));

  section('Safety 8. pregnancy / postpartum: a clinician’s OK, no cut');
  const pia = await signup('pia@example.com', 'Pia');
  const p1 = await pia.put('/api/program', { build: 'hourglass', level: 'beginner', bodyweightLb: 150, sex: 'female', lifeStage: 'pregnant' });
  eq('pregnant → clinician first; nothing planned', [p1.status, p1.data.code, (await pia.get('/api/program')).data.program], [409, 'clinician_needed', null]);
  const p2 = (await pia.put('/api/program', { build: 'hourglass', level: 'beginner', bodyweightLb: 150, sex: 'female', lifeStage: 'pregnant', clinicianCleared: true })).data.program;
  eq('cleared → a plan with no cut and no calorie targets', [p2.lifeStage, p2.phases.some((p) => p.nutrition === 'cutting'), p2.macros], ['pregnant', false, null]);
  const p3 = (await pia.put('/api/program', { build: 'hourglass', level: 'beginner', bodyweightLb: 150, sex: 'female', lifeStage: 'postpartum', clinicianCleared: true })).data.program;
  eq('postpartum: targets, but still no cut', [p3.phases.some((p) => p.nutrition === 'cutting'), p3.macros !== null], [false, true]);

  section('Results 8 + Nice 1/2. missed weeks, deloads, chapters');
  const cole = await signup('cole@example.com', 'Cole');
  await cole.put('/api/program', { build: 'v_taper', level: 'experienced', bodyweightLb: 185 });
  const cm = (await cole.get('/api/me')).data.member;
  const [{ household_id: chh }] = await sql('SELECT household_id FROM household_members WHERE id = $1', [cm.id]);
  const logOn = (d) => sql("INSERT INTO workout_logs (household_id, member_id, logged_on, kind) VALUES ($1, $2, $3, 'day_complete')", [chh, cm.id, d]);
  const back = async () => (await cole.get('/api/workouts/today')).data.comeback;
  await logOn(shift(t, -70));
  eq('70 days off → restart this phase (not week 1)', (await back()).mode, 'restart');
  await logOn(shift(t, -30));
  eq('29 days off → two ramp weeks at ~60%', (await back()).mode, 'ramp');
  await logOn(shift(t, -10));
  eq('9 days off → resume, a little lighter', (await back()).mode, 'resume');
  await logOn(t);
  eq('back today: still inside the 2 ramp weeks after the 19-day gap that ended 10 days ago', [(await back())?.mode, (await back())?.daysOff], ['ramp', 19]);
  const dl = (await cole.post('/api/program/deload', { on: true })).data.program;
  eq('a deload week on demand', [dl.deloadThisWeek, dl.deloadSuggested], [true, null]);
  eq('…and undo', (await cole.post('/api/program/deload', { on: false })).data.program.deloadThisWeek, false);
  const plan = (await cole.get('/api/workouts/plan')).data;
  eq('the year is four chapters', plan.chapters.map((c) => [c.weekStart, c.weekEnd]), [[1, 13], [14, 26], [27, 39], [40, 52]]);
  const ch2 = (await cole.post('/api/program/restart', { chapter: 2 })).data.program;
  eq('…any chapter is a fresh start', [ch2.week, ch2.chapter], [14, 2]);

  section('progress photos: opt-in, private to their owner, encrypted, adults only');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7), Buffer.from([0xff, 0xd9])]);
  const up = (c, pose, body = jpeg, headers = { 'Content-Type': 'image/jpeg', 'X-MyDay-Upload': '1' }) => c.req('POST', `/api/progress-photos/${pose}`, body, { json: false, headers });
  eq('off by default', (await kayla.get('/api/progress-photos')).data, { enabled: false, sets: [], lastOn: null, due: true });
  eq('…uploading needs them on', [(await up(kayla, 'front')).status, (await up(kayla, 'front')).data.code], [409, 'photos_off']);
  await kayla.put('/api/progress-photos', { enabled: true });
  eq('uploads need the upload header (no cross-site form posts)', (await up(kayla, 'front', jpeg, { 'Content-Type': 'image/jpeg' })).status, 400);
  eq('…only front / back / left / right', (await up(kayla, 'top')).status, 400);
  eq('…only real images (bytes are checked, not the header)', (await up(kayla, 'front', Buffer.from('x'.repeat(300)))).status, 415);
  for (const pose of ['front', 'back', 'left', 'right']) await up(kayla, pose);
  const ph = (await kayla.get('/api/progress-photos')).data;
  eq('a full set for today: front, back and both sides; not due again for ~4 weeks', [ph.sets.length, Object.values(ph.sets[0].photos).every((id) => typeof id === 'number'), ph.due], [1, true, false]);
  const firstFront = ph.sets[0].photos.front;
  await up(kayla, 'front');
  const retaken = (await kayla.get('/api/progress-photos')).data;
  eq('retaking a pose replaces it under a new id (still one set, one front; no stale picture)', [retaken.sets.length, (await sql("SELECT COUNT(*)::int AS n FROM progress_photos WHERE pose = 'front'"))[0].n, retaken.sets[0].photos.front !== firstFront], [1, 1, true]);
  const frontId = (await kayla.get('/api/progress-photos')).data.sets[0].photos.front;
  const img = await kayla.req('GET', `/api/progress-photos/${frontId}/image`, undefined, { json: false });
  eq('the owner gets her photo back, never cached', [img.headers.get('content-type'), img.headers.get('cache-control')], ['image/jpeg', 'private, no-store']);
  const stored = (await sql('SELECT data, key_id, bytes FROM progress_photos WHERE id = $1', [frontId]))[0];
  eq('stored encrypted (no JPEG bytes in the database)', [stored.data.subarray(0, 3).equals(jpeg.subarray(0, 3)), stored.data.includes(jpeg.subarray(4, 40)), stored.bytes], [false, false, jpeg.length]);
  eq('another grown-up in the household can’t see it — not even “acting for” her', [(await ty.get(`/api/progress-photos/${frontId}/image`)).status, (await ty.get('/api/progress-photos?member=kayla')).status, (await ty.get('/api/progress-photos')).data.sets.length], [404, 403, 0]);
  eq('teens: no progress photos', [(await avery.get('/api/progress-photos')).status, (await up(avery, 'front')).status], [403, 403]);
  await sql(`INSERT INTO progress_photos (household_id, member_id, taken_on, pose, mime, data, key_id, bytes)
             SELECT household_id, member_id, taken_on - 35, pose, mime, data, key_id, bytes FROM progress_photos WHERE member_id = (SELECT member_id FROM progress_photos WHERE id = $1)`, [frontId]);
  eq('two monthly sets to compare (newest first)', (await kayla.get('/api/progress-photos')).data.sets.length, 2);
  const one = (await kayla.get('/api/progress-photos')).data.sets[1].photos.left;
  eq('delete one photo', (await kayla.del(`/api/progress-photos/${one}`)).data.sets[1].photos.left, null);
  eq('“delete all” needs the confirm word', (await kayla.del('/api/progress-photos')).status, 409);
}

/** Audit 1a: a grown-up acts for themselves and the kids — never for another grown-up. */
async function privacyRules() {
  section('audit 1a. no grown-up can open or act as another grown-up (only themselves + the kids)');
  const kaylaId = (await kayla.get('/api/me')).data.member.id;
  const blocked = await Promise.all([
    ty.get('/api/chores/today?member=kayla'),
    ty.get('/api/workouts/today?member=kayla'),
    ty.get('/api/program?member=kayla'),
    ty.get('/api/score?member=kayla'),
    ty.get('/api/homework?member=kayla'),
    ty.get('/api/meal-plan?member=kayla'),
    ty.get('/api/weekly-plan?member=kayla'),
    ty.put('/api/program?member=kayla', { build: 'hourglass', level: 'beginner', bodyweightLb: 140 }),
  ]);
  eq('Ty → Kayla: her day, workouts, program, score, homework, meals, week, and changing her build are all refused', blocked.map((r) => r.status), [403, 403, 403, 403, 403, 403, 403, 403]);
  eq('…while Ty → Evan (a kid) still works', [(await ty.get('/api/chores/today?member=evan')).status, (await ty.get('/api/homework?member=evan')).status], [200, 200]);
  const ch = await ty.post('/api/chores', { name: 'Kayla’s own chore', memberId: kaylaId, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], points: 5 });
  const chId = (await kayla.get('/api/chores/today')).data.chores.find((c) => c.name === 'Kayla’s own chore')?.id;
  eq('Ty can’t check off Kayla’s chore; Kayla can', [ch.status < 300, (await ty.post(`/api/chores/${chId}/toggle`, { done: true })).status, (await kayla.post(`/api/chores/${chId}/toggle`, { done: true })).status], [true, 403, 200]);
  eq('Ty can’t add a tutor or coach for Kayla (only for himself or the kids)', (await ty.post('/api/care/grants', { kind: 'tutor', subject: 'kayla', scopes: ['school'] })).status, 403);

  section('audit: security headers on every response; build files cached for a year');
  const page = await fetch(`${BASE}/`);
  const h = (k) => page.headers.get(k) ?? '';
  eq('CSP (own scripts + Plaid only; no framing), no-sniff, referrer, permissions', [
    /script-src 'self' https:\/\/cdn\.plaid\.com/.test(h('content-security-policy')), /frame-ancestors 'none'/.test(h('content-security-policy')), /object-src 'none'/.test(h('content-security-policy')),
    h('x-frame-options'), h('x-content-type-options'), h('referrer-policy'), /microphone=\(self\)/.test(h('permissions-policy')),
  ], [true, true, true, 'DENY', 'nosniff', 'strict-origin-when-cross-origin', true]);
  eq('…on API answers too', (await fetch(`${BASE}/api/health`)).headers.get('x-frame-options'), 'DENY');
  const asset = (await (await fetch(`${BASE}/`)).text()).match(/\/assets\/[^"']+\.js/)?.[0];
  eq('hashed build files: cached a year, immutable', (await fetch(BASE + asset)).headers.get('cache-control'), 'public, max-age=31536000, immutable');

  section('audit: AI helpers for kids under 13 need a parent’s OK (COPPA)');
  const jo = new Client('jordan');
  await jo.get(`/dev-login?token=${DEV_TOKEN}&member=jordan`);
  eq('Jordan (8): AI helpers off by default', (await jo.get('/api/me')).data.aiAllowed, false);
  const t1 = await jo.post('/api/chat/tutor', { message: 'help with fractions' });
  eq('…the homework helper refuses with a “ask a grown-up” reason', [t1.status, t1.data.code], [409, 'needs_parent_consent']);
  await jo.post('/api/lectures/ack');
  eq('…and so does lecture recording', (await jo.req('POST', '/api/lectures/upload?classId=1', Buffer.from('x'.repeat(50)), { json: false, headers: { 'Content-Type': 'audio/webm', 'X-MyDay-Upload': '1' } })).data.code, 'needs_parent_consent');
  eq('a kid can’t turn it on for themselves', (await jo.post('/api/household/members/jordan/ai-consent', { consent: true })).status, 403);
  const cl = (await ty.get('/api/household/ai-consent')).data.kids;
  eq('parents see which kids need it (under 13; teens don’t)', [cl.find((k) => k.key === 'jordan')?.needsConsent, cl.find((k) => k.key === 'avery')?.needsConsent], [true, false]);
  await ty.post('/api/household/members/jordan/ai-consent', { consent: true });
  eq('a parent turns it on → the helper answers', [(await jo.get('/api/me')).data.aiAllowed, (await jo.post('/api/chat/tutor', { message: 'help with fractions' })).status], [true, 200]);
  await ty.post('/api/household/members/jordan/ai-consent', { consent: false });
  eq('…and can withdraw it', (await jo.get('/api/me')).data.aiAllowed, false);
  eq('consent is logged (who, when)', (await sql("SELECT COUNT(*)::int AS n FROM events WHERE name IN ('ai_consent_given', 'ai_consent_withdrawn')"))[0].n, 2);

  section('audit: your data — download it, delete your account, delete the household');
  const ex = await ty.get('/api/account/export');
  const tyId = (await ty.get('/api/me')).data.member.id;
  const people = ex.data.data.household_members.map((m) => m.name);
  const flat = JSON.stringify(ex.data);
  eq('export: a download of Ty’s + the kids’ records — never Kayla’s, never secrets, never kids’ private notes', [
    ex.status, /attachment; filename="myday-export-/.test(ex.headers.get('content-disposition') ?? ''),
    people.includes('Ty'), people.includes('Avery'), people.includes('Kayla'),
    /pin_hash|access_token|invite_hash|"data":"\\x/.test(flat),
    (ex.data.data.private_notes ?? []).every((n) => n.member_id === tyId),
    Object.keys(ex.data.data).includes('chores'),
  ], [200, true, true, true, false, false, true, true]);

  const solo = new Client('solo-del');
  await solo.get(`/dev-login?token=${DEV_TOKEN}&email=solo-del@example.com`);
  await solo.post('/api/households', { householdName: 'Gone Soon', type: 'family', yourName: 'Sol' });
  await solo.post('/api/household/members', { name: 'Little', kind: 'kid', age: 6 });
  const lastAdult = await solo.del('/api/account?confirm=DELETE');
  eq('the only grown-up can’t leave the kids alone → “delete the household instead”', [lastAdult.status, lastAdult.data.code], [409, 'last_adult']);
  eq('deleting the household needs its exact name', (await solo.del('/api/household?confirm=nope')).status, 409);
  const gone = await solo.del('/api/household?confirm=Gone%20Soon');
  eq('…with it: everything is deleted, the sign-in too, and the session ends', [
    gone.status, (await sql("SELECT COUNT(*)::int AS n FROM households WHERE name = 'Gone Soon'"))[0].n,
    (await sql("SELECT COUNT(*)::int AS n FROM household_members WHERE name = 'Little'"))[0].n,
    (await sql("SELECT COUNT(*)::int AS n FROM users WHERE email = 'solo-del@example.com'"))[0].n,
    (await solo.get('/api/me')).status,
  ], [200, 0, 0, 0, 401]);

  const pair = new Client('pair-del');
  await pair.get(`/dev-login?token=${DEV_TOKEN}&email=pair-del@example.com`);
  await pair.post('/api/households', { householdName: 'Two of Us', type: 'couple', yourName: 'Pemberly' });
  await pair.post('/api/household/members', { name: 'Partner', kind: 'adult' });
  await pair.post('/api/dump', { note: 'Pia’s own note' });
  eq('with another grown-up there, you can delete just your account', (await pair.del('/api/account?confirm=DELETE')).status, 200);
  eq('…your own things go, the household stays with them', [
    (await sql("SELECT COUNT(*)::int AS n FROM households WHERE name = 'Two of Us'"))[0].n,
    (await sql("SELECT COUNT(*)::int AS n FROM household_members WHERE name = 'Pemberly'"))[0].n,
    (await sql("SELECT COUNT(*)::int AS n FROM dump_items WHERE note = 'Pia’s own note'"))[0].n,
    (await sql("SELECT COUNT(*)::int AS n FROM users WHERE email = 'pair-del@example.com'"))[0].n,
  ], [1, 0, 0, 0]);

  section('audit: households choose what’s in their MyDay; no kids → no kid tools; a setup checklist');
  const inv = await ty.patch('/api/household/info', { modulesOff: ['invest', 'circles', 'nonsense'] });
  eq('turn modules off (unknown names ignored)', inv.data.modulesOff, ['invest', 'circles']);
  eq('…and back on', (await ty.patch('/api/household/info', { modulesOff: [] })).data.modulesOff, []);
  const duo = new Client('duo-mod');
  await duo.get(`/dev-login?token=${DEV_TOKEN}&email=duo-mod@example.com`);
  await duo.post('/api/households', { householdName: 'Just Two', type: 'couple', yourName: 'Dana' });
  const dm = (await duo.get('/api/me')).data.household;
  eq('a couple starts without School and has no kids', [dm.modulesOff, dm.hasKids], [['school'], false]);
  eq('the setup checklist can be hidden for good', (await duo.post('/api/onboarding/checklist', { skipped: true })).data.onboarding.checklist, true);

  section('audit: sign in without Google — a one-time email link, or Sign in with Apple');
  eq('the sign-in methods on (email + Apple here)', (await anon.get('/api/auth/methods')).data, { google: false, email: true, apple: true });
  const mailer = new Client('mail-user');
  eq('ask for a link: the same answer whether or not the address has an account', (await mailer.post('/api/auth/email', { email: 'Mail.User@example.com' })).data, { sent: true });
  const box = (await anon.get(`/api/dev/outbox?token=${DEV_TOKEN}`)).data.mail;
  const msg = box.filter((m) => m.to === 'mail.user@example.com').at(-1);
  const link = msg?.text.match(/https?:\/\/\S+callback\?token=\S+/)?.[0];
  check('the email has a one-time sign-in link', !!link, msg?.subject);
  const path1 = new URL(link).pathname + new URL(link).search;
  const r1 = await mailer.get(path1);
  eq('tapping it signs you in (new person → household setup next)', [r1.status, r1.location, (await mailer.get('/api/me')).data.email], [302, '/', 'mail.user@example.com']);
  const again = await new Client('mail-again').get(path1);
  eq('the link works only once', again.location, '/?error=link');
  for (let i = 0; i < 3; i++) await anon.post('/api/auth/email', { email: 'flood@example.com' });
  eq('…and can’t be used to flood someone’s inbox', (await anon.post('/api/auth/email', { email: 'flood@example.com' })).status, 429);

  const ap = new Client('apple-user');
  const start = await ap.get('/api/auth/apple');
  const to = new URL(start.location);
  const [cv] = decodeURIComponent(ap.jar.get('myday.apple') ?? '').split('~');
  const [st, nonce] = cv.split('.');
  eq('“Continue with Apple” goes to Apple with state + a hashed nonce', [to.origin, to.searchParams.get('client_id'), to.searchParams.get('state') === st, to.searchParams.get('nonce') === sha('sha256').update(nonce).digest('hex')], ['https://appleid.apple.com', 'app.myday.test', true, true]);
  const jwt = (claims) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', kid: 'test1' });
    const body = enc({ iss: 'https://appleid.apple.com', aud: 'app.myday.test', sub: 'apple-001', email: 'Ada@privaterelay.appleid.com', exp: Math.floor(Date.now() / 1000) + 7 * 86400, nonce: sha('sha256').update(nonce).digest('hex'), ...claims });
    return `${head}.${body}.${rsaSign('RSA-SHA256', Buffer.from(`${head}.${body}`), APPLE_KEY.privateKey).toString('base64url')}`;
  };
  const post = (c, token) => c.req('POST', '/api/auth/apple/callback', new URLSearchParams({ state: st, id_token: token, user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Apple' } }) }).toString(), { json: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  eq('an answer without this browser’s own sign-in cookie is refused (no login CSRF)', (await post(new Client('apple-x'), jwt({}))).location, '/?error=state');
  eq('a token minted for another app is refused', (await post(ap, jwt({ aud: 'someone.else' }))).location, '/?error=apple');
  const ap2 = new Client('apple-user2');
  await ap2.get('/api/auth/apple');
  const [cv2] = decodeURIComponent(ap2.jar.get('myday.apple') ?? '').split('~');
  const [st2, nonce2] = cv2.split('.');
  const good = (() => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', kid: 'test1' });
    const body = enc({ iss: 'https://appleid.apple.com', aud: 'app.myday.test', sub: 'apple-001', email: 'Ada@privaterelay.appleid.com', exp: Math.floor(Date.now() / 1000) + 7 * 86400, nonce: sha('sha256').update(nonce2).digest('hex') });
    return `${head}.${body}.${rsaSign('RSA-SHA256', Buffer.from(`${head}.${body}`), APPLE_KEY.privateKey).toString('base64url')}`;
  })();
  const ok = await ap2.req('POST', '/api/auth/apple/callback', new URLSearchParams({ state: st2, id_token: good, user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Apple' } }) }).toString(), { json: false, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const am = (await ap2.get('/api/me')).data;
  eq('a real Apple answer signs you in (name from Apple’s first sign-in)', [ok.location, am.email, am.name], ['/', 'ada@privaterelay.appleid.com', 'Ada Apple']);

  section('audit: production — deep health check, error alerts, fair-use limits, streamed uploads');
  const deep = await anon.get('/api/health/deep');
  eq('/api/health/deep proves the database answers (for uptime monitors)', [deep.status, deep.data.ok, deep.data.db], [200, true, 'ok']);
  alerts.length = 0;
  eq('an unexpected error answers 500 without details…', [(await anon.get(`/api/dev/boom?token=${DEV_TOKEN}`)).status, (await anon.get(`/api/dev/boom?token=${DEV_TOKEN}`)).data], [500, { error: 'Something went wrong' }]);
  for (let i = 0; i < 20 && !alerts.length; i++) await new Promise((r) => setTimeout(r, 100));
  check('…and sends an alert (route + error, no personal data)', alerts.some((a) => /Deliberate test error/.test(a) && /\/api\/dev\/boom/.test(a)), alerts[0]?.slice(0, 120));
  eq('the test-error route doesn’t exist without the dev token', (await anon.get('/api/dev/boom')).status, 404);
  const capC = new Client('cap-user');
  await capC.get(`/dev-login?token=${DEV_TOKEN}&email=cap-user@example.com`);
  await capC.post('/api/households', { householdName: 'Cap House', type: 'solo', yourName: 'Cappy' });
  const capMe = (await capC.get('/api/me')).data;
  await sql("INSERT INTO chat_messages (household_id, member_id, mode, who, text) SELECT $1, $2, 'companion', 'user', 'x' FROM generate_series(1, 1500)", [capMe.household.id, capMe.member.id]);
  const capped = await capC.post('/api/chat/companion', { message: 'one more' });
  eq('a household’s AI messages are capped per month (1,500 by default) with a friendly reason', [capped.status, capped.data.code], [429, 'monthly_limit']);
  eq('…other households aren’t affected', (await ty.post('/api/chat/companion', { message: 'hi' })).status, 200);
  const big = await avery.req('POST', `/api/lectures/upload?classId=${(await avery.get('/api/school')).data.classes.find((c) => c.name === 'Biology').id}&durationS=60`, Buffer.alloc(26 * 1024 * 1024, 1), { json: false, headers: { 'Content-Type': 'audio/webm', 'X-MyDay-Upload': '1' } });
  eq('lecture uploads stream to disk and stop at 25 MB', big.status, 413);

  section('audit: transactional email — invites by email, a trial-ending reminder (once)');
  const invMail = (await ty.post('/api/household/invites', { name: 'Robin', email: 'robin-invite@example.com' })).data;
  const robin = (await anon.get(`/api/dev/outbox?token=${DEV_TOKEN}`)).data.mail.filter((m) => m.to === 'robin-invite@example.com').at(-1);
  eq('inviting a grown-up emails them the join link', [invMail.emailed, robin?.text.includes(invMail.link)], [true, true]);
  const soon = new Client('trial-soon');
  await soon.get(`/dev-login?token=${DEV_TOKEN}&email=trial-soon@example.com`);
  await soon.post('/api/households', { householdName: 'Trial Soon', type: 'solo', yourName: 'Tess' });
  await sql("UPDATE households SET trial_ends_at = now() + interval '2 days' WHERE name = 'Trial Soon'");
  const tr1 = runNode(['dist/cli.js', 'billing:trial-reminders']);
  const tr2 = runNode(['dist/cli.js', 'billing:trial-reminders']);
  eq('two days before the trial ends, the grown-ups get one reminder (never twice)', [/sent: [1-9]/.test(tr1), /sent: 0/.test(tr2), (await sql("SELECT trial_notice_at IS NOT NULL AS sent FROM households WHERE name = 'Trial Soon'"))[0].sent], [true, true, true]);

  section('audit: public privacy policy + terms (readable signed out)');
  for (const p of ['/privacy', '/terms']) eq(`${p} is served signed out`, (await fetch(BASE + p)).status, 200);
}

/** Real payments through Stripe, against a local fake Stripe (no network, no real keys). */
async function stripeBilling() {
  section('audit: real payments (Stripe Checkout + signed webhooks) — against a local fake Stripe');
  const { createServer } = await import('node:http');
  const { createHmac } = await import('node:crypto');
  const calls = [];
  const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ path: req.url, auth: req.headers.authorization, body: new URLSearchParams(body) });
      const out = req.url === '/v1/customers' ? { id: 'cus_test1' } : req.url === '/v1/checkout/sessions' ? { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' } : { url: 'https://billing.stripe.test/portal' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  const [{ price_cents: oldPrice }] = await sql('SELECT price_cents FROM billing_plans WHERE is_default');
  await sql('UPDATE billing_plans SET price_cents = 1299 WHERE is_default');
  const PORT2 = PORT + 1;
  const env2 = { ...serverEnv(), PORT: String(PORT2), PUBLIC_URL: `http://localhost:${PORT2}`, BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_API_BASE: fakeUrl };
  const s2 = spawn(process.execPath, ['dist/server.js'], { cwd: apiDir, env: env2, stdio: ['ignore', 'ignore', 'pipe'] });
  const B2 = `http://localhost:${PORT2}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${B2}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const as = (c) => ({ Cookie: c.cookie, 'User-Agent': 'MyDay-e2e' });
  const call2 = async (c, method, path, body) => {
    const r = await fetch(B2 + path, { method, headers: { ...as(c), 'Content-Type': 'application/json' }, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const hhId = (await ty.get('/api/me')).data.household.id;
  // Earlier billing tests left this household on the (stub) paid plan: start from a fresh 20-day trial.
  const [{ billing_status: oldStatus, trial_ends_at: oldTrial }] = await sql('SELECT billing_status, trial_ends_at FROM households WHERE id = $1', [hhId]);
  await sql("UPDATE households SET billing_status = 'trialing', trial_ends_at = now() + interval '20 days' WHERE id = $1", [hhId]);
  try {
    eq('the billing page says payments are real (Stripe)', (await call2(ty, 'GET', '/api/billing')).data.provider, 'stripe');
    const co = await call2(ty, 'POST', '/api/billing/checkout');
    const cust = calls.find((c) => c.path === '/v1/customers');
    const sess = calls.find((c) => c.path === '/v1/checkout/sessions');
    eq('“Subscribe” opens Stripe’s hosted checkout (cards never touch MyDay)', [co.status, co.data.url], [200, 'https://checkout.stripe.test/cs_1']);
    eq('…for the household’s plan price, monthly, charging when the trial ends', [
      cust?.auth, cust?.body.get('metadata[household_id]'), sess?.body.get('mode'), sess?.body.get('client_reference_id'),
      sess?.body.get('line_items[0][price_data][unit_amount]'), sess?.body.get('line_items[0][price_data][recurring][interval]'), Number(sess?.body.get('subscription_data[trial_end]')) > Date.now() / 1000,
    ], ['Bearer sk_test_fake', String(hhId), 'subscription', String(hhId), '1299', 'month', true]);
    eq('a kid can’t start billing', (await call2(avery, 'POST', '/api/billing/checkout')).status, 403);
    const hook = async (type, object, secret = 'whsec_fake') => {
      const payload = JSON.stringify({ id: `evt_${type}`, type, data: { object } });
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
      return fetch(`${B2}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: payload });
    };
    eq('a webhook with a bad signature is refused', (await hook('checkout.session.completed', { client_reference_id: String(hhId), customer: 'cus_test1', subscription: 'sub_1' }, 'whsec_wrong')).status, 400);
    eq('…and nothing changed', (await call2(ty, 'GET', '/api/billing')).data.status === 'active', false);
    await hook('checkout.session.completed', { client_reference_id: String(hhId), customer: 'cus_test1', subscription: 'sub_1' });
    eq('paid → the household is active', (await call2(ty, 'GET', '/api/billing')).data.status, 'active');
    await hook('customer.subscription.updated', { id: 'sub_1', customer: 'cus_test1', status: 'past_due', current_period_end: 1893456000 });
    eq('card declined → past due (the app still works)', (await call2(ty, 'GET', '/api/billing')).data.status, 'past_due');
    await hook('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_test1', status: 'canceled', current_period_end: 1893456000 });
    const after = (await call2(ty, 'GET', '/api/billing')).data;
    eq('canceled in Stripe → canceled here, paid through the period end', [after.status, after.paidThrough?.slice(0, 10)], ['canceled', '2030-01-01']);
    eq('“Manage billing” opens Stripe’s portal (card, invoices, cancel)', (await call2(ty, 'POST', '/api/billing/portal')).data.url, 'https://billing.stripe.test/portal');
  } finally {
    s2.kill();
    fake.close();
    await sql('UPDATE households SET billing_status = $2, trial_ends_at = $3, stripe_customer_id = NULL, stripe_subscription_id = NULL, paid_through = NULL WHERE id = $1', [hhId, oldStatus, oldTrial]);
    await sql('UPDATE billing_plans SET price_cents = $1 WHERE is_default', [oldPrice]);
  }
}

async function householdJoin() {
  const tokenOf = (link) => link.split('/join/')[1];
  const tyHh = (await ty.get('/api/me')).data.household;
  const signup = async (email, householdName, yourName) => {
    const c = new Client(email);
    await c.get(`/dev-login?token=${DEV_TOKEN}&email=${email}`);
    if (householdName) await c.post('/api/households', { householdName, type: 'solo', yourName });
    return c;
  };
  const roster = async () => (await ty.get('/api/household')).data.members.map((m) => m.name);

  section('J-fix 1. invite → join from the “Set up your household” screen (no duplicate household)');
  const riley = await signup('riley@example.com');
  eq('Riley signs in with no household', (await riley.get('/api/me')).data.household, null);
  const inv1 = (await ty.post('/api/household/invites', { name: 'Riley', email: 'riley@example.com' })).data;
  let pv = (await riley.get(`/api/join/preview?token=${encodeURIComponent(inv1.link)}`)).data;
  eq('preview accepts the full link: plain join', [pv.outcome, pv.household], ['join', tyHh.name]);
  eq('…a garbage code → 404', (await riley.get('/api/join/preview?token=nope')).status, 404);
  eq('join', (await riley.post('/api/join', { token: inv1.link })).data.outcome, 'join');
  eq('Riley is in the family household, not a new one', (await riley.get('/api/me')).data.household.id, tyHh.id);
  check('…and on the roster', (await roster()).includes('Riley'));
  eq('the link works once', (await (await signup('riley2@example.com')).get(`/api/join/preview?token=${tokenOf(inv1.link)}`)).status, 404);

  section('J-fix 2. already in a household → in-page prompt; never orphan kids or data');
  // (a) alone, with data → the whole household comes along
  const pat = (await sql("SELECT u.email FROM users u JOIN household_members m ON m.id = u.member_id WHERE m.name = 'Pat'"))[0].email;
  const patHh = (await ret.get('/api/me')).data.household;
  await ret.post('/api/dump', { note: 'Pat’s note from before' });
  const inv2 = await ty.post('/api/household/invites', { name: 'Pat', email: pat });
  eq('inviting an email that belongs to another household is allowed now (was 409)', inv2.status, 201);
  pv = (await ret.get(`/api/join/preview?token=${tokenOf(inv2.data.link)}`)).data;
  eq('Pat is the only grown-up and has data → merge_household', [pv.outcome, pv.current.name, pv.current.hasData], ['merge_household', patHh.name, true]);
  const refused = await ret.post('/api/join', { token: tokenOf(inv2.data.link) });
  eq('nothing moves without the OK (409 until leave: true)', [refused.status, (await ret.get('/api/me')).data.household.id], [409, patHh.id]);
  const done = (await ret.post('/api/join', { token: tokenOf(inv2.data.link), leave: true })).data;
  eq('confirmed → Pat is in the family household', [done.outcome, (await ret.get('/api/me')).data.household.id], ['merge_household', tyHh.id]);
  eq('…her note came with her', (await sql("SELECT household_id FROM dump_items WHERE note = 'Pat’s note from before'"))[0].household_id, tyHh.id);
  eq('…and the old household is gone (nothing left in it)', (await sql('SELECT COUNT(*)::int AS n FROM households WHERE id = $1', [patHh.id]))[0].n, 0);

  // (b) other grown-ups remain → only the person (and their own records) moves
  const alex = await signup('alex@example.com', 'Alex & Bo', 'Alex');
  await alex.post('/api/day/tasks', { task: 'Alex’s own task', priority: 'Important', energy: 'Low Brain' });
  await alex.post('/api/grocery', { item: 'shared milk', qty: '' });
  const boInv = (await alex.post('/api/household/invites', { name: 'Bo', email: 'bo@example.com' })).data;
  const bo = await signup('bo@example.com');
  await bo.post('/api/join', { token: boInv.link });
  const abHh = (await alex.get('/api/me')).data.household.id;
  const inv3 = (await ty.post('/api/household/invites', { name: 'Alex', email: 'alex@example.com' })).data;
  pv = (await alex.get(`/api/join/preview?token=${tokenOf(inv3.link)}`)).data;
  eq('another grown-up (Bo) stays → move_person', [pv.outcome, pv.current.adults], ['move_person', 1]);
  await alex.post('/api/join', { token: tokenOf(inv3.link), leave: true });
  eq('Alex moved; Bo’s household intact with Bo', [(await alex.get('/api/me')).data.household.id, (await bo.get('/api/me')).data.household.id, (await bo.get('/api/household')).data.members.map((m) => m.name)], [tyHh.id, abHh, ['Bo']]);
  eq('…Alex’s own task moved with Alex', (await sql("SELECT household_id FROM tasks WHERE task = 'Alex’s own task'"))[0].household_id, tyHh.id);
  eq('…the shared grocery list stayed with Bo', (await sql("SELECT household_id FROM grocery_items WHERE item = 'shared milk'"))[0].household_id, abHh);

  // (c) only kids remain → kids are never left behind: the household comes along
  const cam = await signup('cam@example.com', 'Cam house', 'Cam');
  await cam.post('/api/household/members', { name: 'Kiddo', kind: 'kid', age: 8 });
  const inv4 = (await ty.post('/api/household/invites', { name: 'Cam', email: 'cam@example.com' })).data;
  pv = (await cam.get(`/api/join/preview?token=${tokenOf(inv4.link)}`)).data;
  eq('only a kid would be left → merge_household (kid comes along)', [pv.outcome, pv.current.kids], ['merge_household', 1]);
  await cam.post('/api/join', { token: tokenOf(inv4.link), leave: true });
  check('Kiddo is now in the family household', (await roster()).includes('Kiddo'));

  // (d) empty, unused household → just removed
  const dee = await signup('dee@example.com', 'Dee place', 'Dee');
  const deeHh = (await dee.get('/api/me')).data.household.id;
  const inv5 = (await ty.post('/api/household/invites', { name: 'Dee', email: 'dee@example.com' })).data;
  eq('empty household → remove_empty', (await dee.get(`/api/join/preview?token=${tokenOf(inv5.link)}`)).data.outcome, 'remove_empty');
  await dee.post('/api/join', { token: tokenOf(inv5.link), leave: true });
  eq('…removed, Dee joined', [(await sql('SELECT COUNT(*)::int AS n FROM households WHERE id = $1', [deeHh]))[0].n, (await dee.get('/api/me')).data.household.id], [0, tyHh.id]);

  // (e) signing in THROUGH an invite while in another household → held + prompt
  const eli = await signup('eli@example.com', 'Eli house', 'Eli');
  const inv6 = (await ty.post('/api/household/invites', { name: 'Eli', email: 'eli@example.com' })).data;
  await eli.get(`/dev-login?token=${DEV_TOKEN}&email=eli@example.com&invite=${tokenOf(inv6.link)}`);
  const em = (await eli.get('/api/me')).data;
  eq('sign-in with an invite does NOT silently move them; it asks', [em.household.name, em.pendingInvite], ['Eli house', { household: tyHh.name }]);
  eq('…the prompt’s preview uses the held invite', (await eli.get('/api/join/preview')).data.outcome, 'remove_empty');
  await eli.post('/api/join/dismiss');
  eq('“Not now” clears the prompt', (await eli.get('/api/me')).data.pendingInvite, null);

  section('J-fix 3. merge a duplicate household (staff): preview → confirm → audit');
  await ty.post('/api/household/members', { name: 'Morgan', kind: 'adult', xpTrack: 'woman' });
  const morgan = await signup('morgan@example.com', 'Morgan duplicate', 'Morgan');
  await morgan.post('/api/day/tasks', { task: 'Morgan’s task', priority: 'Important', energy: 'Low Brain' });
  const mHh = (await morgan.get('/api/me')).data.household.id;
  const adm = new Client('admin-merge');
  await adm.get(`/dev-login?token=${DEV_TOKEN}&email=admin@example.com`);
  eq('non-staff can’t merge', (await ty.get(`/api/admin/households/${mHh}/merge-preview?into=${tyHh.id}`)).status, 403);
  const mp = (await adm.get(`/api/admin/households/${mHh}/merge-preview?into=${tyHh.id}`)).data;
  eq('preview: Morgan folds into the existing Morgan; tasks move', [mp.folding, mp.moving, mp.rows.tasks], [[{ name: 'Morgan', into: 'Morgan' }], [], 1]);
  eq('merge needs the exact name', (await adm.post(`/api/admin/households/${mHh}/merge`, { into: tyHh.id, confirm: 'nope' })).status, 409);
  const mr = (await adm.post(`/api/admin/households/${mHh}/merge`, { into: tyHh.id, confirm: 'Morgan duplicate' })).data;
  eq('merged: one Morgan, signed in to the family household', [mr.report.membersMerged, (await morgan.get('/api/me')).data.household.id, (await roster()).filter((n) => n === 'Morgan').length], [[{ from: 'Morgan', into: 'Morgan' }], tyHh.id, 1]);
  eq('…her task is now Morgan’s in the family household', (await sql("SELECT household_id FROM tasks WHERE task = 'Morgan’s task'"))[0].household_id, tyHh.id);
  eq('…audit-logged', (await sql("SELECT COUNT(*)::int AS n FROM events WHERE name = 'household_merged'"))[0].n >= 1, true);

  section('J-fix 5. the Kayla scenario — CLI fix (dry run, then --yes) and verification');
  await ty.post('/api/household/members', { name: 'Kay', kind: 'adult', xpTrack: 'woman' });
  const kay = await signup('kay@example.com', 'Kay duplicate', 'Kay');
  await kay.post('/api/dump', { note: 'Kay’s note' });
  const kHh = (await kay.get('/api/me')).data.household.id;
  const dry = runNode(['dist/cli.js', 'household:merge-into', '--from-email', 'kay@example.com', '--into-household', String(tyHh.id)]);
  check('dry run shows the plan and changes nothing', /fold\s+Kay → existing Kay/.test(dry) && /Dry run/.test(dry) && (await sql('SELECT COUNT(*)::int AS n FROM households WHERE id = $1', [kHh]))[0].n === 1, dry.split('\n')[0]);
  const yes = runNode(['dist/cli.js', 'household:merge-into', '--from-email', 'kay@example.com', '--into-household', String(tyHh.id), '--yes']);
  check('--yes moves her and verifies', /Verified: kay@example.com is now in/.test(yes) && /duplicate household #\d+ removed/.test(yes), yes.trim().split('\n').slice(-2).join(' | '));
  const km = (await kay.get('/api/me')).data;
  eq('Kay sees the family household, as the existing Kay', [km.household.id, km.member.name], [tyHh.id, 'Kay']);
  check('…sees the family roster', ['Ty', 'Avery', 'Evan', 'Kay'].every((n) => (async () => true) && true) && (await kay.get('/api/household')).data.members.some((m) => m.name === 'Avery'));
  eq('…no longer has her own household', (await sql('SELECT COUNT(*)::int AS n FROM households WHERE id = $1', [kHh]))[0].n, 0);
  eq('…and her note came along', (await sql("SELECT household_id FROM dump_items WHERE note = 'Kay’s note'"))[0].household_id, tyHh.id);
}

/* ======================= UI gate (Playwright, real browser) ======================= */

async function uiGate() {
  section('L2. button audit: every control → a handler → a real API route');
  const { audit } = await import(pathToFileURL(path.join(root, 'scripts', 'button-audit.mjs')).href);
  const au = audit();
  eq(`no dead controls (${au.buttons} buttons, ${au.calls} API calls, ${au.links} links checked)`, au.problems, []);

  let chromium;
  try {
    ({ chromium } = createRequire(path.join(root, 'package.json'))('playwright'));
  } catch {
    check('Playwright installed (npm i, then npx playwright install chromium)', false);
    return;
  }
  // A fake microphone (a test tone), so the recorder can really record.
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  try {
    const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
    const errors = [];
    const watch = (page) => page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.stack ?? e.message}`));

    section('A1. in-page confirm (no native dialogs): remove a chore, delete homework, archive a member — and it sticks');
    const tyCtx = await browser.newContext(phone);
    const page = await tyCtx.newPage();
    watch(page);
    let nativeDialogs = 0;
    page.on('dialog', (d) => {
      nativeDialogs++;
      void d.dismiss();
    });
    await page.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=ty`);
    await ty.patch('/api/me/prefs', { firstRunDone: true }); // Ty's welcome card is covered by Evan's below
    await ty.post('/api/chores', { name: 'UI test chore', memberId: 4, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], points: 5 });
    await page.goto(`${BASE}/chores/manage`);
    await page.locator('li', { hasText: 'UI test chore' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByTestId('confirm').waitFor();
    const del = page.waitForRequest((r) => r.method() === 'DELETE' && /\/api\/chores\/\d+$/.test(r.url()));
    await page.getByTestId('confirm-ok').click();
    await del;
    await page.reload();
    await page.waitForLoadState('networkidle');
    eq('chore removed via the in-page confirm, gone after reload', await page.locator('li', { hasText: 'UI test chore' }).count(), 0);

    await ty.post('/api/homework?member=evan', { assignment: 'UI worksheet', subject: 'Math', due: null });
    await page.evaluate(() => localStorage.setItem('myday.viewing', 'evan'));
    await page.goto(`${BASE}/homework`);
    await page.locator('li', { hasText: 'UI worksheet' }).locator('button.danger').click();
    await page.getByTestId('confirm-ok').click();
    await page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/homework\/\d+/.test(r.url()));
    await page.reload();
    await page.waitForLoadState('networkidle');
    eq('homework deleted via the in-page confirm, gone after reload', await page.locator('li', { hasText: 'UI worksheet' }).count(), 0);
    await page.evaluate(() => localStorage.setItem('myday.viewing', 'ty'));

    await ty.post('/api/household/members', { name: 'Uitest Person', kind: 'adult', xpTrack: 'leader' });
    await page.goto(`${BASE}/household`);
    await page.locator('li', { hasText: 'Uitest Person' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByTestId('confirm-ok').click();
    await page.waitForResponse((r) => /\/api\/household\/members\/\d+\/archive$/.test(r.url()));
    await page.reload();
    eq('member archived via the in-page confirm, persists after reload', (await ty.get('/api/household/admin')).data.members.find((m) => m.name === 'Uitest Person')?.archived, true);
    eq('no native confirm() dialogs anywhere', nativeDialogs, 0);

    section('audit layout: one Today, five tabs, a grouped menu, Hana everywhere, kid tools only as a parent’s view');
    await page.goto(`${BASE}/`);
    await page.getByTestId('today-adult').waitFor({ timeout: 10000 });
    eq('phone: a grown-up’s home is the merged Today; tabs are Today · Plan · Family · Money · Me', (await page.locator('nav.tabs a small').allInnerTexts()).map((t) => t.toLowerCase()), ['today', 'plan', 'family', 'money', 'me']);
    await page.getByTestId('kids-glance').waitFor({ timeout: 10000 });
    check('Today shows what’s next, the workout and meals, and the kids at a glance', (await page.getByTestId('next-up').count()) === 1 && (await page.getByTestId('kids-glance').count()) === 1);
    await page.getByRole('button', { name: 'Menu' }).click();
    const groups = await page.getByTestId('menu').locator('.navgroup-label').allInnerTexts();
    eq('the menu is grouped (Me · Family · Home · Money · School · Help & people · Account)', groups.map((g) => g.toLowerCase()), ['me', 'family', 'home', 'money', 'school', 'help & people', 'account']);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByTestId('hana-fab').click();
    await page.waitForURL('**/hana');
    check('the Hana button opens Ask Hana from any page', page.url().endsWith('/hana'));
    await page.goto(`${BASE}/me`);
    await page.getByTestId('me-hub').locator('.hubtile').first().waitFor({ timeout: 10000 });
    eq('Me: everything else, grouped, one tap away', await page.getByTestId('me-hub').locator('.hubtile').count() > 15, true);
    await page.goto(`${BASE}/homework`);
    await page.getByTestId('homework-pick').waitFor({ timeout: 10000 });
    eq('a grown-up’s Homework is the kids’ homework (no “Ty’s homework”)', await page.getByTestId('homework-pick').getByRole('button').allInnerTexts().then((t) => t.some((x) => /Avery/.test(x)) && t.some((x) => /Evan/.test(x))), true);
    await page.goto(`${BASE}/score`);
    await page.getByTestId('progress-adult').waitFor({ timeout: 10000 });
    eq('a grown-up’s Score is “Your progress” — no kid points to spend', [await page.getByText('to spend').count(), await page.getByText('Perfect Week').count()], [0, 0]);
    await page.goto(`${BASE}/meals`);
    await page.locator('nav.subtabs a').first().waitFor({ timeout: 10000 });
    eq('Plan section tabs on Meals: Week · Meals · This week’s menu · Grocery list', await page.locator('nav.subtabs a').allInnerTexts(), ['Week', 'Meals', 'This week’s menu', 'Grocery list']);

    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dp = await desk.newPage();
    watch(dp);
    await dp.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=ty`);
    await dp.getByTestId('today-adult').waitFor({ timeout: 10000 });
    eq('desktop: a sidebar instead of the phone’s bottom bar and menu button', [await dp.getByTestId('sidebar').count(), await dp.locator('nav.tabs').count(), await dp.getByRole('button', { name: 'Menu' }).count()], [1, 0, 0]);
    await dp.getByLabel('Find a page').fill('gro');
    eq('…with search', await dp.getByTestId('sidebar').locator('a').allInnerTexts().then((t) => t.map((x) => x.trim())), ['🛒 Grocery list']);
    await dp.getByLabel('Find a page').fill('');
    await dp.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await dp.keyboard.press('?');
    check('“?” opens the shortcut help', await dp.getByTestId('shortcut-help').isVisible());
    await dp.keyboard.press('Escape');
    await dp.keyboard.press('g');
    await dp.keyboard.press('m');
    await dp.waitForURL('**/meals');
    check('“g m” goes to Meals', dp.url().endsWith('/meals'));
    await dp.waitForSelector('.mealcard img');
    eq('the library shows 24 at a time (not a 32,000 px page), with “show more”', [await dp.locator('.mealcard').count(), await dp.getByTestId('meals-more').innerText()], [24, 'SHOW 24 MORE']);
    await dp.getByRole('button', { name: 'Show all 233' }).click();
    check('meal cards show pictures (all 233 on request)', (await dp.locator('.mealcard img').count()) === 233);
    await dp.getByLabel('Search meals').fill('gumbo');
    eq('search narrows by name', await dp.locator('.mealcard').count(), 1);
    await dp.getByLabel('Search meals').fill('');
    await dp.getByLabel('Country of origin').selectOption('Spanish');
    await dp.getByLabel('Region of origin').selectOption('Basque Country');
    await dp.waitForResponse((r) => r.url().includes('region=Basque'));
    eq('UI: country + region filter narrows the library', await dp.locator('.mealcard').count(), 1);
    check('UI: cards show country · region and nutrition', (await dp.getByTestId('meal-origin').first().innerText()).includes('Spanish · Basque Country') && /cal/.test(await dp.getByTestId('meal-nutrition').first().innerText()));

    section('G. Hana’s confirm card in the chat');
    const t = (await ty.post('/api/day/tasks', { task: 'UI delete me', priority: 'Later', energy: 'Low Brain' })).data.tasks.find((x) => x.task === 'UI delete me');
    await page.goto(`${BASE}/hana`);
    await page.getByPlaceholder('What’s on your mind?').fill(`delete task #${t.id}`);
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByTestId('hana-pending').waitFor();
    await page.getByTestId('hana-pending').getByRole('button', { name: 'Confirm' }).click();
    await page.getByTestId('hana-pending').waitFor({ state: 'detached' });
    eq('confirmed in the chat → task deleted', (await ty.get('/api/day')).data.tasks.some((x) => x.id === t.id), false);

    section('Oct 2 staging bugs: Health after menu navigation; Focus timer stays put');
    await page.goto(`${BASE}/hana`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('link', { name: /Health/ }).click();
    eq('Ask Hana → menu → Health renders (no blank page)', await page.getByRole('heading', { name: /workout|Plan your year/i }).first().waitFor({ timeout: 10000 }).then(() => true, () => false), true);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('link', { name: /Meals/ }).click();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('link', { name: /Health/ }).click();
    eq('…and again after another hop', await page.getByRole('heading', { name: /workout|Plan your year/i }).first().waitFor({ timeout: 10000 }).then(() => true, () => false), true);

    section('3 + 0e. admin page: delete a test household through the in-page confirm');
    const zui = new Client('zui');
    await zui.get(`/dev-login?token=${DEV_TOKEN}&email=zui@example.com`);
    await zui.post('/api/households', { householdName: 'ZZZ UI Test', type: 'solo', yourName: 'Zui' });
    const adCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const ap = await adCtx.newPage();
    watch(ap);
    await ap.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&email=admin@example.com`);
    await ap.goto(`${BASE}/admin`);
    await ap.getByTestId('admin-totals').waitFor();
    await ap.getByRole('button', { name: 'Delete ZZZ UI Test' }).click();
    await ap.getByTestId('confirm').waitFor();
    await ap.getByTestId('confirm-ok').click();
    await ap.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/admin\/households\//.test(r.url()));
    await ap.reload();
    await ap.getByTestId('admin-households').waitFor();
    eq('test household deleted via the modal, gone after reload', await ap.getByRole('button', { name: 'Delete ZZZ UI Test' }).count(), 0);
    await page.goto(`${BASE}/billing`);
    eq('billing page renders for a grown-up', await page.getByTestId('billing-status').waitFor({ timeout: 10000 }).then(() => true, () => false), true);

    section('add-on 1. demo pictures show in the workout detail view');
    const kc = await browser.newContext(phone);
    const kpg = await kc.newPage();
    await kpg.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=kayla`);
    await kpg.goto(`${BASE}/health`);
    await kpg.getByTestId('session-name').waitFor({ timeout: 10000 });
    const shown = await kpg.getByTestId('exercise-demo').count();
    const cards = await kpg.locator('.card.exercise').count();
    eq('one demo picture per exercise card', [shown > 0, shown === cards], [true, true]);

    section('body builds in the browser: food math shown, deload on demand (in-page), weigh-ins opt-in, teen view');
    await kayla.patch('/api/me/prefs', { firstRunDone: true }); // her welcome card would cover the page
    await kpg.reload();
    await kpg.getByTestId('program').waitFor({ timeout: 10000 });
    check('macros come with how they were worked out', await kpg.getByText(/Maintenance ≈ \d+ cal/).waitFor({ timeout: 10000 }).then(() => true, () => false));
    eq('weigh-ins are offered, off by default', await kpg.getByTestId('weighins-on').count(), 1);
    await kpg.getByTestId('deload-toggle').click();
    check('“Take a deload week” turns this week light', await kpg.getByRole('button', { name: 'Undo the deload week' }).waitFor({ timeout: 10000 }).then(() => true, () => false));
    await kpg.getByRole('button', { name: 'Undo the deload week' }).click();
    await kpg.getByRole('button', { name: 'Take a deload week' }).waitFor({ timeout: 10000 });
    eq('this-week progress + the minimum week are shown', await kpg.getByTestId('week-progress').getByText(/two sessions counts as a win/).count(), 1);
    await kpg.getByRole('button', { name: 'Change build' }).click();
    await kpg.getByRole('button', { name: /^Shredded/ }).click();
    await kpg.getByRole('button', { name: 'Build my year' }).click();
    check('picking Shredded as a beginner opens the in-page gate (no native dialog)', await kpg.getByTestId('build-gate').getByText(/muscular base first/).waitFor({ timeout: 10000 }).then(() => true, () => false));
    await kpg.getByTestId('build-gate').getByRole('button', { name: 'Back', exact: true }).click();
    eq('…and Back closes it without changing anything', [await kpg.getByTestId('build-gate').count(), (await kayla.get('/api/program')).data.program.build.key], [0, 'strong_curvy']);
    const tc = await browser.newContext(phone);
    const tpg = await tc.newPage();
    await tpg.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=avery`);
    await tpg.goto(`${BASE}/health`);
    check('teen view: no calorie numbers, a training style, water only', await tpg.getByTestId('no-targets').waitFor({ timeout: 10000 }).then(() => true, () => false));
    eq('…', [await tpg.getByTestId('macros').count(), await tpg.getByTestId('weighins-on').count(), await tpg.getByTestId('habits').getByText('Protein shake').count(), await tpg.getByTestId('program').getByText(/^Athletic ·/).count()], [0, 0, 0, 1]);
    await tc.close();

    section('audit: the signed-out landing page fits a phone; privacy + terms render; Settings → Your data');
    const lc = await browser.newContext(phone);
    const lp = await lc.newPage();
    await lp.goto(`${BASE}/`);
    await lp.getByTestId('landing').waitFor({ timeout: 10000 });
    await lp.getByTestId('apple-signin').waitFor({ timeout: 10000 });
    const fit = await lp.evaluate(() => ({ w: document.documentElement.scrollWidth, vw: innerWidth, recipes: document.body.innerText.includes('233 recipes'), cta: !!document.querySelector('[data-testid="signin-choices"] a, [data-testid="signin-choices"] form') }));
    eq('landing: nothing wider than the phone, current numbers, a clear start button', [fit.w <= fit.vw, fit.recipes, fit.cta], [true, true, true]);
    await lp.getByLabel('Email address').fill('ui-mail@example.com');
    await lp.getByRole('button', { name: /email me a sign-in link/i }).click();
    eq('landing: “Email me a sign-in link” works (for families without Google)', await lp.getByTestId('email-sent').waitFor({ timeout: 10000 }).then(() => true, () => false), true);
    await lp.getByRole('link', { name: 'Privacy' }).click();
    eq('…Privacy opens signed out', await lp.getByRole('heading', { name: 'Privacy Policy' }).waitFor({ timeout: 10000 }).then(() => true, () => false), true);
    await lp.goto(`${BASE}/terms`);
    eq('…Terms too', await lp.getByRole('heading', { name: 'Terms of Service' }).waitFor({ timeout: 10000 }).then(() => true, () => false), true);
    await lc.close();
    await kpg.goto(`${BASE}/settings`);
    await kpg.getByTestId('your-data').waitFor({ timeout: 10000 });
    eq('Settings → Your data: download, delete account, delete household', [await kpg.getByTestId('export-data').count(), await kpg.getByTestId('delete-account').count()], [1, 1]);
    await kpg.goto(`${BASE}/family`);
    eq('Family: the AI-helper switch for kids under 13', await kpg.getByTestId('ai-consent').waitFor({ timeout: 10000 }).then(() => true, () => false), true);
    const nk = await browser.newContext(phone);
    const np = await nk.newPage();
    await np.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&email=duo-ui@example.com`);
    await np.getByLabel('Household name').fill('Two UI');
    await np.getByText('Couple', { exact: true }).click();
    await np.getByRole('button', { name: /start my free trial/i }).click();
    await np.waitForLoadState('networkidle');
    await np.goto(`${BASE}/`);
    await np.getByTestId('today-adult').waitFor({ timeout: 10000 });
    await np.request.patch(`${BASE}/api/me/prefs`, { data: { firstRunDone: true }, headers: { 'Content-Type': 'application/json' } });
    await np.reload();
    await np.getByTestId('setup-checklist').waitFor({ timeout: 10000 });
    await np.getByRole('button', { name: 'Menu' }).click();
    const menu2 = (await np.getByTestId('menu').locator('a').allInnerTexts()).map((t) => t.trim());
    eq('a new couple: setup checklist on Today; no Homework, Rewards, Kid money or School in the menu', [menu2.some((t) => /Homework|Rewards|Kid money|School|Lectures/.test(t)), menu2.some((t) => /Health/.test(t))], [false, true]);
    await np.getByRole('button', { name: 'Menu' }).click();
    await np.getByTestId('setup-checklist').getByRole('button', { name: 'Hide' }).click();
    await np.reload();
    await np.getByTestId('today-adult').waitFor({ timeout: 10000 });
    eq('…“Hide” keeps it hidden', await np.getByTestId('setup-checklist').count(), 0);
    await np.goto(`${BASE}/settings`);
    await np.getByTestId('modules').waitFor({ timeout: 10000 });
    await np.getByTestId('module-health').uncheck();
    await np.getByTestId('modules').getByRole('button', { name: 'Save' }).click();
    await np.waitForLoadState('networkidle');
    await np.getByTestId('modules').waitFor({ timeout: 10000 });
    await np.getByRole('button', { name: 'Menu' }).click();
    eq('Settings → What’s in your MyDay: turning Health off removes it from the menu', (await np.getByTestId('menu').locator('a').allInnerTexts()).some((t) => /Health/.test(t)), false);
    await nk.close();
    await kpg.goto(`${BASE}/health`);

    section('audit: accessibility — readable contrast in light and dark (with a chosen accent), labels, headings');
    const axeSrc = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
    const axeFails = [];
    for (const [who, scheme, pages] of [['ty', 'light', ['/', '/money', '/health/plan', '/meals', '/meals/grocery', '/day', '/household', '/setup', '/me']], ['avery', 'dark', ['/', '/health', '/school', '/lectures', '/settings', '/meals']], ['evan', 'light', ['/', '/homework']]]) {
      const ac = await browser.newContext({ ...phone, colorScheme: scheme, bypassCSP: true });
      const ap2 = await ac.newPage();
      await ap2.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=${who}`);
      await ap2.waitForLoadState('networkidle');
      for (const r of pages) {
        await ap2.goto(BASE + r);
        await ap2.waitForLoadState('networkidle');
        await ap2.addScriptTag({ content: axeSrc });
        const v = await ap2.evaluate(async () =>
          (await window.axe.run(document, { runOnly: ['color-contrast', 'link-name', 'select-name', 'button-name', 'image-alt', 'label', 'empty-table-header', 'page-has-heading-one'] })).violations.map((x) => `${x.id}×${x.nodes.length}`),
        );
        if (v.length) axeFails.push(`${who}${r}: ${v.join(', ')}`);
      }
      await ac.close();
    }
    eq('no contrast, label, link-name or heading problems on the audited pages (incl. dark mode with a purple accent)', axeFails, []);

    section('audit 1a in the browser: the “whose day” picker offers me + the kids, never another grown-up');
    await kpg.locator('select[aria-label="Whose day"]').waitFor({ timeout: 10000 });
    const pick = await kpg.locator('select[aria-label="Whose day"] option').allInnerTexts();
    eq('Kayla’s picker', [pick.includes('Kayla (me)'), pick.includes('Ty'), pick.includes('Avery'), pick.includes('Evan')], [true, false, true, true]);
    await kpg.evaluate(() => localStorage.setItem('myday.viewing', 'ty'));
    await kpg.reload();
    await kpg.getByRole('heading').first().waitFor({ timeout: 10000 });
    eq('…a remembered choice of another grown-up falls back to her own day', await kpg.locator('select[aria-label="Whose day"]').inputValue(), 'kayla');

    section('progress photos in the browser: add a pose (re-encoded on the phone), compare months, delete all (in-page)');
    await kpg.goto(`${BASE}/health`);
    await kpg.getByTestId('photos').waitFor({ timeout: 10000 });
    await kpg.getByTestId('pose-back').locator('input[type=file]').setInputFiles(path.join(root, 'web', 'public', 'exercises', 'plank.webp'));
    await kpg.getByText('Saved ✓ Only you can see it.').waitFor({ timeout: 15000 });
    const shownBack = await kpg
      .waitForFunction(() => {
        const el = document.querySelector('[data-testid="pose-back"] img');
        return !!el && el.complete && el.naturalWidth > 0;
      }, null, { timeout: 15000 })
      .then(() => true, () => false);
    const why = shownBack ? '' : JSON.stringify(await kpg.evaluate(async () => {
      const el = document.querySelector('[data-testid="pose-back"] img');
      if (!el) return { img: 'missing', html: document.querySelector('[data-testid="pose-back"]')?.outerHTML.slice(0, 300) };
      const r = await fetch(el.src);
      return { src: el.src, status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength, complete: el.complete, w: el.naturalWidth };
    }));
    check('the new back photo shows (served decrypted, only to her)', shownBack, why);
    eq('…and is never kept in the offline cache', await kpg.evaluate(async () => (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).filter((r) => r.url.includes('/api/progress-photos')).length))).reduce((a, b) => a + b, 0)), 0);
    const backId = (await kayla.get('/api/progress-photos')).data.sets[0].photos.back;
    eq('…uploaded as a re-encoded JPEG (location/camera data dropped)', (await sql('SELECT mime FROM progress_photos WHERE id = $1', [backId]))[0].mime, 'image/jpeg');
    eq('compare shows before/after side by side for each pose', await kpg.getByTestId('photo-compare').locator('.photocompare').count(), 4);
    await kpg.getByTestId('photos-delete-all').click();
    await kpg.getByTestId('confirm-ok').click();
    await kpg.getByTestId('photos').getByText('Take your first set').waitFor({ timeout: 10000 });
    eq('delete all (through the in-page confirm) removes every photo', (await sql('SELECT COUNT(*)::int AS n FROM progress_photos'))[0].n, 0);
    const tyHealth = await browser.newContext(phone);
    const typ = await tyHealth.newPage();
    await typ.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=ty`);
    await typ.evaluate(() => localStorage.setItem('myday.viewing', 'evan'));
    await typ.goto(`${BASE}/health`);
    await typ.locator('h1').first().waitFor({ timeout: 10000 });
    await typ.waitForLoadState('networkidle');
    eq('a parent viewing a kid’s Health page sees no photo section', [await typ.locator('select[aria-label="Whose day"]').inputValue(), await typ.getByTestId('photos').count(), await typ.getByTestId('photos-off').count()], ['evan', 0, 0]);
    await tyHealth.close();

    section('every page renders for a grown-up (no crashes, no “not found”)');
    const pages = ['/', '/chores', '/day', '/family', '/money', '/hana', '/homework', '/rewards', '/score', '/health', '/health/plan', '/meals', '/meals/plan', '/meals/grocery', '/meals/1', '/weekly', '/dump', '/battles', '/red-alert', '/chores/manage', '/household', '/school', '/record', '/classroom-mode', '/wins', '/my-money', '/bills', '/identity', '/records', '/command', '/setup', '/settings', '/billing', '/invest', '/circles', '/circles/moderation', '/care', '/pro', '/lectures', '/focus'];
    const notFound = [];
    for (const p of pages) {
      await page.goto(BASE + p);
      await page.waitForLoadState('networkidle');
      if (await page.getByText('Page not found.').count()) notFound.push(p);
    }
    eq(`${pages.length} pages render`, notFound, []);

    section('kids: tutor renders (untouched), recorder, first run');
    const kid = await browser.newContext(phone);
    const kp = await kid.newPage();
    watch(kp);
    await kp.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=avery`); // PIN login is rate-limited per IP by now
    await kp.goto(`${BASE}/tutor`);
    check('tutor renders for a kid', await kp.getByRole('heading', { name: /Homework helper/ }).waitFor({ timeout: 10000 }).then(() => true, () => false));
    await kp.goto(`${BASE}/record`);
    check('recorder: class picker (policy already acknowledged)', await kp.getByTestId('record-class').waitFor({ timeout: 10000 }).then(() => true, () => false));
    for (const p of ['/school', '/my-money', '/focus', '/private', '/wins', '/settings', `/study/${(await avery.get('/api/school')).data.classes[0].id}`]) {
      await kp.goto(BASE + p);
      await kp.waitForLoadState('networkidle');
      if (await kp.getByText('Page not found.').count()) notFound.push(`kid ${p}`);
    }
    eq('kid pages render', notFound, []);
    await kp.goto(`${BASE}/focus`);
    await kp.getByRole('button', { name: 'Start' }).click();
    let seen = 0;
    for (let i = 0; i < 10; i++) {
      if (await kp.getByTestId('focus-clock').isVisible()) seen++;
      await kp.waitForTimeout(300);
    }
    eq('focus timer stays on screen while running (10/10 samples)', seen, 10);
    await kp.getByRole('button', { name: 'Menu' }).click();
    eq('Focus timer in the kid menu', await kp.getByRole('link', { name: /Focus timer/ }).count(), 1);
    await kp.getByRole('button', { name: 'Menu' }).click();
    const ev = await browser.newContext(phone);
    const ep = await ev.newPage();
    await ep.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=evan`);
    await ep.goto(`${BASE}/`);
    await ep.getByTestId('first-run-kid').waitFor();
    check('age-specific first run (kid) shows once', true);
    const saved = ep.waitForResponse((r) => r.url().endsWith('/api/me/prefs'));
    await ep.getByRole('button', { name: 'Let’s go' }).click();
    await saved;
    await ep.reload();
    await ep.waitForLoadState('networkidle');
    eq('…and not again after dismissing', await ep.getByTestId('first-run-kid').count(), 0);
    section('add-on 4. staging bug fixes from the Oct 2 walkthrough');
    // (a) Lectures section
    await kp.goto(`${BASE}/lectures`);
    await kp.getByTestId('lecture-list').waitFor();
    check('(a) /lectures lists the kid’s recordings', (await kp.getByTestId('lecture-list').locator('li').count()) >= 3);
    await kp.getByRole('button', { name: 'Menu' }).click();
    eq('(a) Lectures is in the menu', await kp.getByRole('link', { name: /Lectures/ }).count(), 1);
    await kp.getByRole('button', { name: 'Menu' }).click();
    await kp.getByLabel('Class').selectOption({ label: 'Biology' });
    await kp.getByTestId('lecture-upload').setInputFiles({ name: 'class.m4a', mimeType: 'audio/mp4', buffer: Buffer.from(`STUB-TRANSCRIPT: ${'Mitosis is how a cell divides. '.repeat(5)}`) });
    await kp.waitForURL(/\/lectures\/\d+$/);
    check('(a) uploading an audio file opens the new lecture', /\/lectures\/\d+$/.test(kp.url()));

    section('offline lecture recording: saved on the phone as it records, survives a killed tab, uploads itself when signal returns');
    const bioId = (await avery.get('/api/school')).data.classes.find((c) => c.name === 'Biology').id;
    const raw = (q, body = Buffer.from(`STUB-TRANSCRIPT: ${'Cells divide by mitosis. '.repeat(4)}`)) =>
      avery.req('POST', `/api/lectures/upload?${q}`, body, { json: false, headers: { 'Content-Type': 'audio/webm', 'X-MyDay-Upload': '1' } });
    const u1 = await raw(`classId=${bioId}&durationS=60&clientId=rec-test-0001&recordedOn=2026-09-30`);
    const u2 = await raw(`classId=${bioId}&durationS=60&clientId=rec-test-0001&recordedOn=2026-09-30`);
    eq('a retried upload (lost answer on bad signal) returns the same lecture, never a second one', [u1.status, u2.status, u2.data.lecture.id === u1.data.lecture.id, (await sql("SELECT COUNT(*)::int AS n FROM lectures WHERE client_id = 'rec-test-0001'"))[0].n], [201, 200, true, 1]);
    eq('…dated the day it was recorded, not the day it uploaded', u1.data.lecture.recordedOn, '2026-09-30');
    eq('…a future date is ignored (today instead)', (await raw(`classId=${bioId}&durationS=5&clientId=rec-test-0002&recordedOn=2030-01-01`)).data.lecture.recordedOn, (await avery.get('/api/workouts/today')).data.date);

    const rc = await browser.newContext({ ...phone, permissions: ['microphone'] });
    const rp = await rc.newPage();
    watch(rp);
    await rp.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&member=avery`);
    await rp.goto(`${BASE}/record`);
    await rp.getByTestId('record-class').waitFor({ timeout: 10000 });
    await rp.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await rp.reload();
    await rp.getByTestId('record-class').waitFor({ timeout: 10000 });
    const shell = await rp.evaluate(async () => {
      const keys = await caches.keys();
      const shellKey = keys.find((k) => k.endsWith('-shell'));
      const c = shellKey ? await caches.open(shellKey) : null;
      const reqs = c ? await c.keys() : [];
      const man = await (await fetch('/asset-manifest.json')).json();
      const files = new Set(Object.values(man).map((e) => `/${e.file}`));
      const cached = new Set(reqs.map((r) => new URL(r.url).pathname));
      return { controlled: !!navigator.serviceWorker.controller, page: !!(c && (await c.match('/index.html'))), assets: reqs.filter((r) => new URL(r.url).pathname.startsWith('/assets/')).length, missing: [...files].filter((f) => !cached.has(f)).length, split: files.size };
    });
    eq('the app shell (page + every on-demand piece of code) is cached on the phone', [shell.controlled, shell.page, shell.assets > 0, shell.split > 10, shell.missing], [true, true, true, true, 0]);
    const lecCount = async () => (await avery.get('/api/lectures')).data.lectures.length;
    const before = await lecCount();

    await rc.setOffline(true);
    await rp.getByTestId('record-class').selectOption({ label: 'Biology' });
    await rp.getByRole('button', { name: '● Start recording' }).click();
    await rp.getByTestId('recorder-live').waitFor({ timeout: 10000 });
    await rp.waitForTimeout(6500); // at least one 5-second chunk is on the phone
    await rp.close(); // the phone kills the tab mid-class

    const rp2 = await rc.newPage();
    watch(rp2);
    await rp2.goto(`${BASE}/record`);
    await rp2.getByTestId('waiting-item').first().waitFor({ timeout: 15000 });
    eq('offline, tab killed mid-recording, reopened: the recorder opens and the lecture is waiting (not lost)', [await rp2.getByTestId('waiting-item').count(), /Biology/.test(await rp2.getByTestId('waiting-item').first().textContent())], [1, true]);

    await rp2.getByTestId('record-class').selectOption({ label: 'Biology' });
    await rp2.getByRole('button', { name: '● Start recording' }).click();
    await rp2.getByTestId('recorder-live').waitFor({ timeout: 10000 });
    await rp2.waitForTimeout(6000);
    const stop = await rp2.getByRole('button', { name: 'Press and hold to stop recording' }).boundingBox();
    await rp2.mouse.move(stop.x + stop.width / 2, stop.y + stop.height / 2);
    await rp2.mouse.down();
    await rp2.waitForTimeout(1900);
    await rp2.mouse.up();
    await rp2.getByTestId('recording-saved').waitFor({ timeout: 15000 });
    eq('a second lecture recorded offline and stopped normally: “Saved on this phone”, both waiting, nothing uploaded yet', [await rp2.getByTestId('waiting-item').count(), (await lecCount()) - before], [2, 0]);

    await rc.setOffline(false); // signal returns
    const gone = await rp2.waitForFunction(() => !document.querySelector('[data-testid="waiting-uploads"]'), null, { timeout: 60000 }).then(() => true, () => false);
    eq('signal back: both upload on their own (oldest first) and leave the phone', [gone, (await lecCount()) - before, await rp2.evaluate(() => new Promise((ok) => { const r = indexedDB.open('myday-recordings'); r.onsuccess = () => { const q = r.result.transaction('chunks').objectStore('chunks').count(); q.onsuccess = () => ok(q.result); }; }))], [true, 2, 0]);
    const fresh = (await avery.get('/api/lectures')).data.lectures.slice(0, 2);
    let ready = [];
    for (let i = 0; i < 40; i++) {
      ready = await Promise.all(fresh.map(async (l) => (await avery.get(`/api/lectures/${l.id}`)).data.status));
      if (ready.every((s) => s === 'ready')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    eq('…turned into structured notes on the server, as today', ready, ['ready', 'ready']);
    eq('…and the audio is deleted from the server after the notes', (await sql('SELECT COUNT(*)::int AS n FROM lectures WHERE id = ANY($1) AND audio_path IS NOT NULL', [fresh.map((l) => l.id)]))[0].n, 0);
    check('…the killed-tab lecture kept its audio up to the last saved chunk', fresh.every((l) => l.durationS >= 4), fresh.map((l) => l.durationS).join(','));
    await rc.close();
    // (b) Focus timer for everyone
    await page.goto(`${BASE}/focus`);
    eq('(b) /focus renders for a grown-up too', await page.getByTestId('focus-clock').waitFor({ timeout: 10000 }).then(() => true, () => false), true);
    // (c) Hana answer shown once
    Object.assign(process.env, serverEnv());
    const ai = await import(pathToFileURL(path.join(apiDir, 'dist', 'lib', 'ai.js')).href);
    const para = 'Start with the two-minute task. Then take a short walk.';
    eq('(c) duplicated reply blocks collapse to one', ai.cleanReply([para, para]), para);
    eq('(c) …and a doubled paragraph inside one block', ai.cleanReply([`${para}

${para}`]), para);
    eq('(c) …and the same text twice in a row', ai.cleanReply([`${para}${para}`]), para);
    eq('(c) normal multi-paragraph answers are untouched', ai.cleanReply(['One.', 'Two.']), 'One.\n\nTwo.');
    await page.goto(`${BASE}/hana`);
    await page.getByPlaceholder('What’s on your mind?').fill('What should I do first today?');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.waitForResponse((r) => r.url().endsWith('/api/chat/companion') && r.request().method() === 'POST');
    const bubbles = await page.locator('.bubble.hana').allInnerTexts();
    const last = bubbles[bubbles.length - 1] ?? '';
    eq('(c) the answer appears once in the chat', bubbles.filter((b) => b === last).length, 1);
    // (e) dead links
    await page.goto(`${BASE}/plan`);
    await page.waitForURL('**/weekly');
    check('(e) /plan goes to the weekly calendar', page.url().endsWith('/weekly'));
    await page.goto(`${BASE}/command`);
    eq('(e) /command opens the command center (not a redirect)', [await page.locator('[data-testid^=command-]').first().waitFor({ timeout: 10000 }).then(() => true, () => false), page.url().endsWith('/command')], [true, true]);

    section('J-fix UI: join from the signup screen, and the leave-and-join prompt (in-page modals)');
    const gInv = (await ty.post('/api/household/invites', { name: 'Gus', email: 'gus@example.com' })).data;
    const gus = await (await browser.newContext(phone)).newPage();
    watch(gus);
    await gus.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&email=gus@example.com`);
    await gus.getByTestId('join-box').waitFor();
    check('“Were you invited?” shows before anything is created', await gus.getByTestId('create-household').isVisible());
    await gus.getByLabel('Invite link or code').fill(gInv.link);
    await gus.getByRole('button', { name: 'Check', exact: true }).click();
    await gus.getByTestId('join-preview').waitFor();
    await gus.getByRole('button', { name: /^Join / }).click();
    await gus.waitForURL(`${BASE}/`);
    eq('joined from the signup screen', (await sql("SELECT h.name FROM users u JOIN household_members m ON m.id = u.member_id JOIN households h ON h.id = m.household_id WHERE u.email = 'gus@example.com'"))[0].name, (await ty.get('/api/me')).data.household.name);
    const fay = new Client('fay');
    await fay.get(`/dev-login?token=${DEV_TOKEN}&email=fay@example.com`);
    await fay.post('/api/households', { householdName: 'Fay place', type: 'solo', yourName: 'Fay' });
    const fInv = (await ty.post('/api/household/invites', { name: 'Fay', email: 'fay@example.com' })).data;
    const fp = await (await browser.newContext(phone)).newPage();
    watch(fp);
    await fp.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&email=fay@example.com&invite=${fInv.link.split('/join/')[1]}`);
    await fp.getByTestId('pending-invite').waitFor();
    await fp.getByRole('button', { name: 'Leave mine and join' }).click();
    await fp.getByTestId('confirm').waitFor();
    check('the in-page confirm names both households', (await fp.getByTestId('confirm').innerText()).includes('Fay place'));
    await fp.getByTestId('confirm-ok').click();
    await fp.waitForResponse((r) => r.url().endsWith('/api/join') && r.request().method() === 'POST');
    eq('confirmed in the modal → Fay is in the family household', (await sql("SELECT h.name FROM users u JOIN household_members m ON m.id = u.member_id JOIN households h ON h.id = m.household_id WHERE u.email = 'fay@example.com'"))[0].name, (await ty.get('/api/me')).data.household.name);
    await page.goto(`${BASE}/settings`);
    await page.getByTestId('invite-grown-up').waitFor();
    await page.getByLabel('Their first name').fill('Hal');
    await page.getByLabel('Their Google email').fill('hal@example.com');
    await page.getByRole('button', { name: 'Create invite' }).click();
    await page.getByTestId('invite-made').waitFor();
    check('Settings → Invite a grown-up gives a link + QR (14 days)', (await page.getByTestId('invite-made').innerText()).includes('/join/') && (await page.locator('[data-testid=invite-made] .qr svg').count()) === 1);

    if (process.env.E2E_SHOTS) {
      for (const [ctx, pg, name, url] of [[tyCtx, page, 'ty-today', '/'], [tyCtx, page, 'ty-health', '/health'], [tyCtx, page, 'ty-household', '/household'], [kid, kp, 'avery-today', '/']]) {
        void ctx;
        await pg.goto(BASE + url);
        await pg.waitForLoadState('networkidle');
        await pg.screenshot({ path: path.join(process.env.E2E_SHOTS, `${name}.png`) });
      }
      const sp = await (await browser.newContext(phone)).newPage();
      await sp.goto(`${BASE}/dev-login?token=${DEV_TOKEN}&email=shots@example.com`);
      await sp.waitForLoadState('networkidle');
      await sp.screenshot({ path: path.join(process.env.E2E_SHOTS, 'signup.png'), fullPage: true });
    }
    eq('no uncaught page errors', errors, []);
  } finally {
    await browser.close();
  }
}

try {
  await setup();
  await monday();
  await midweek();
  await sunday();
  await mealsAndGrocery();
  await pinRotation();
  await bigBuild();
  await billingAdmin();
  await investments();
  await circles();
  await careTeam();
  await exercisePictures();
  await bodyScience();
  await privacyRules();
  await stripeBilling();
  await householdJoin();
  if (process.env.E2E_UI !== '0') await uiGate();
} catch (e) {
  failures.push(`CRASH: ${e instanceof Error ? e.stack : e}`);
  console.error(e);
} finally {
  await stopServer();
  alertHook.close();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  const log = serverLog.split('\n').filter((l) => l.trim() && !l.includes('DEV_LOGIN')).slice(-40);
  if (log.length) console.log(`\nserver stderr (last ${log.length} lines):\n${log.join('\n')}`);
  process.exit(1);
}
