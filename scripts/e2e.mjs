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
import { existsSync, readFileSync } from 'node:fs';
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
const dbUrl = (() => {
  const u = new URL(adminUrl);
  u.pathname = '/myday_e2e';
  return u.toString();
})();
const SECRET = randomBytes(32).toString('hex');
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
  constructor(name) {
    this.name = name;
    this.cookie = '';
  }
  async req(method, p, body, { json = true, headers = {} } = {}) {
    const h = { ...headers };
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
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = set.match(/myday\.sid=([^;]*)/);
      if (m) this.cookie = m[1] ? `myday.sid=${m[1]}` : '';
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, location: res.headers.get('location') };
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
  await admin.query('CREATE DATABASE myday_e2e');
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
  runNode(['dist/cli.js', 'import:meals', path.join(fixtures, 'sample-meals.csv')]);
  runNode(['dist/cli.js', 'profile:set', '--member', 'ty', '--start', '2026-09-28', '--days', '1,2,4,5', '--calories', '2700', '--protein', '190', '--carbs', '300', '--fat', '85']);
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  // Chores "exist" from the start of the test week.
  await db.query("UPDATE chores SET created_on = '2026-09-28'");
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
  const db = new pg.Client({ connectionString: dbUrl });
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
  eq('daily totals', [plan.days[0].calories, plan.days[0].protein], [650, 52]);
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
  for (const p of ['/', '/homework', '/rewards', '/score', '/health', '/meals', '/meals/plan', '/meals/grocery', '/weekly', '/kids', '/manifest.webmanifest', '/icons/myday-icon-512.png']) {
    const r = await fetch(BASE + p);
    check(`GET ${p}`, r.status === 200, `${r.status} ${r.headers.get('content-type')}`);
  }
  await ty.post('/api/auth/logout');
  eq('logout ends the session', (await ty.get('/api/me')).status, 401);
}

try {
  await setup();
  await monday();
  await midweek();
  await sunday();
  await mealsAndGrocery();
  await pinRotation();
} catch (e) {
  failures.push(`CRASH: ${e instanceof Error ? e.stack : e}`);
  console.error(e);
} finally {
  await stopServer();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  const log = serverLog.split('\n').filter((l) => l.trim() && !l.includes('DEV_LOGIN')).slice(-40);
  if (log.length) console.log(`\nserver stderr (last ${log.length} lines):\n${log.join('\n')}`);
  process.exit(1);
}
