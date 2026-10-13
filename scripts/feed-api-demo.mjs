#!/usr/bin/env node
/**
 * The Feed Publishing API: an end-to-end demo, written the way a third-party app would (plain fetch, no
 * SDK). It runs the whole contract in docs/feed-api.md: authorize (PKCE) -> tokens -> /me -> publish a
 * text post -> upload a photo -> publish it -> read status -> refresh (rotation) -> delete -> revoke.
 *
 * Two ways to run it:
 *
 *   Real app (any server, a person clicks Allow):
 *     FEED_API_BASE=https://app.thefeedsocial.com \
 *     FEED_CLIENT_ID=feedapp_... FEED_CLIENT_SECRET=fds_... \
 *     FEED_REDIRECT_URI=http://localhost:8765/callback \
 *     node scripts/feed-api-demo.mjs
 *       Register the app at /feed/developers with that exact redirect URI first. The script prints the
 *       consent link, listens on the redirect URI for the code, and carries on once you click Allow.
 *
 *   Local / test servers only (no person needed):
 *     FEED_API_BASE=http://localhost:3000 FEED_DEMO_DEV_TOKEN=<the server's DEV_LOGIN_TOKEN> node scripts/feed-api-demo.mjs
 *       Signs in a throwaway grown-up through the dev-only sign-in, gives them a Feed profile, registers
 *       the app and answers the consent screen through the same two calls the consent page makes. Dev
 *       sign-in doesn't exist in production, so this mode can't run there.
 *
 * Exits 0 and prints "DEMO PASSED" only if every step returned what the contract says.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const BASE = (process.env.FEED_API_BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const DEV = process.env.FEED_DEMO_DEV_TOKEN ?? '';
const KEEP = process.env.FEED_DEMO_KEEP === '1'; // leave the posts and the connection in place (for a UI look)

let step = 0;
const ok = (what, detail = '') => console.log(`  ✓ ${String(++step).padStart(2)}. ${what}${detail ? `  — ${detail}` : ''}`);
function expect(cond, what, got) {
  if (!cond) {
    console.error(`  ✗ ${String(++step).padStart(2)}. ${what}\n      got: ${JSON.stringify(got)}`);
    console.error('\nDEMO FAILED');
    process.exit(1);
  }
}

async function call(method, path, { body, headers = {}, form, token, basic } = {}) {
  const h = { ...headers };
  let payload;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (Buffer.isBuffer(body)) payload = body;
  else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) h.Authorization = `Bearer ${token}`;
  if (basic) h.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`).toString('base64')}`;
  const r = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, data, headers: r.headers, setCookie: r.headers.getSetCookie?.() ?? [] };
}

/* ---------- 0. an app and a person (dev mode sets both up; real mode uses yours) ---------- */

let client = { id: process.env.FEED_CLIENT_ID ?? '', secret: process.env.FEED_CLIENT_SECRET ?? '' };
let redirectUri = process.env.FEED_REDIRECT_URI ?? 'http://localhost:8765/callback';
let cookie = '';
const session = (method, path, body) => call(method, path, { body: body ?? (method === 'GET' ? undefined : {}), headers: { Cookie: cookie } });

console.log(`The Feed Publishing API demo → ${BASE}\n`);
if (DEV) {
  const tag = randomBytes(3).toString('hex');
  const login = await call('GET', `/dev-login?token=${DEV}&email=feed-api-demo-${tag}@example.test`);
  cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
  expect(login.status === 302 && cookie, 'dev sign-in (local/test servers only)', login.status);
  const prof = await session('PUT', '/api/community/profile', { displayName: 'Demo', username: `demo_${tag}`, adult: true, guidelines: true, dob: '1988-03-14' });
  expect(prof.status === 200, 'Feed profile', prof.data);
  ok('a grown-up Feed member signed in', `@demo_${tag}`);
  redirectUri = 'http://localhost:8765/callback';
  const reg = await session('POST', '/api/developer/apps', { name: 'Feed API Demo', description: 'The runnable demo in scripts/feed-api-demo.mjs', website: 'https://example.test', redirectUris: [redirectUri], scopes: ['profile.read', 'posts.write'] });
  expect(reg.status === 201 && reg.data.clientSecret, 'register an app', reg.data);
  client = { id: reg.data.app.clientId, secret: reg.data.clientSecret };
  ok('registered an app (the secret is shown this once)', client.id);
} else if (!client.id || !client.secret) {
  console.error('Set FEED_CLIENT_ID, FEED_CLIENT_SECRET and FEED_REDIRECT_URI (see the top of this file), or FEED_DEMO_DEV_TOKEN on a local server.');
  process.exit(2);
}

/* ---------- 1. authorize (authorization code + PKCE S256) ---------- */

const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(12).toString('base64url');
const authorize = {
  response_type: 'code',
  client_id: client.id,
  redirect_uri: redirectUri,
  scope: 'profile.read posts.write',
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
};
let code;
if (DEV) {
  // Exactly what the consent page does: show the request, then Allow with the boxes the person ticked.
  const info = await session('GET', `/api/oauth/authorize/info?${new URLSearchParams(authorize)}`);
  expect(info.status === 200, 'consent page info', info.data);
  ok('consent page shows the app, the scopes in plain words and the account', `${info.data.app.name} · ${info.data.scopes.length} scopes · as @${info.data.account.username}`);
  const d = await session('POST', '/api/oauth/authorize/decision', { ...authorize, approve: true, grant: ['profile.read', 'posts.write'] });
  expect(d.status === 200, 'Allow', d.data);
  const back = new URL(d.data.redirect);
  expect(back.searchParams.get('state') === state, 'state comes back unchanged', back.toString());
  code = back.searchParams.get('code');
} else {
  const u = new URL(redirectUri);
  console.log(`Open this link, sign in to The Feed, tick the boxes and press Allow:\n\n  ${BASE}/oauth/authorize?${new URLSearchParams(authorize)}\n`);
  code = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const q = new URL(req.url ?? '/', redirectUri);
      if (q.pathname !== u.pathname) return void res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Done — you can close this tab.');
      srv.close();
      if (q.searchParams.get('state') !== state) reject(new Error('state mismatch'));
      else if (q.searchParams.get('error')) reject(new Error(`authorization refused: ${q.searchParams.get('error')}`));
      else resolve(q.searchParams.get('code'));
    }).listen(Number(u.port || 80), u.hostname);
  });
}
expect(/^fdc_/.test(code ?? ''), 'authorization code', code);
ok('authorization code received (one-time, 10 minutes)');

/* ---------- 2. tokens ---------- */

const tok = await call('POST', '/api/oauth/token', { basic: client, form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier } });
expect(tok.status === 200 && tok.data.token_type === 'Bearer', 'token exchange', tok.data);
let access = tok.data.access_token;
let refresh = tok.data.refresh_token;
ok('code → access token (1 h) + refresh token (30 d)', `scope "${tok.data.scope}", expires_in ${tok.data.expires_in}s`);

const me = await call('GET', '/api/v1/me', { token: access });
expect(me.status === 200 && me.data.username, 'GET /api/v1/me', me.data);
ok('GET /api/v1/me', `${me.data.displayName} (@${me.data.username})`);

/* ---------- 3. publish ---------- */

const text = await call('POST', '/api/v1/posts', { token: access, body: { text: 'Hello from the Feed API demo — scheduled, screened and posted via an app.' } });
expect(text.status === 201 && text.data.post.status === 'published', 'publish a text post', text.data);
ok('POST /api/v1/posts (text)', `#${text.data.post.id} ${text.data.post.status} via “${text.data.post.via.name}” · quota ${text.headers.get('x-ratelimit-remaining')}/${text.headers.get('x-ratelimit-limit')} left`);

// A real 1×1 JPEG.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const media = await call('POST', '/api/v1/media', { token: access, body: jpeg, headers: { 'Content-Type': 'image/jpeg' } });
expect(media.status === 201 && media.data.id, 'upload a photo', media.data);
ok('POST /api/v1/media (photo, screened on upload)', `media #${media.data.id} ${media.data.status}`);

const photo = await call('POST', '/api/v1/posts', { token: access, body: { text: 'And one with a photo.', mediaIds: [media.data.id] } });
expect(photo.status === 201 && photo.data.post.mediaIds[0] === media.data.id, 'publish the photo post', photo.data);
ok('POST /api/v1/posts (with the photo)', `#${photo.data.post.id} ${photo.data.post.status}`);

const kids = await call('POST', '/api/v1/posts', { token: access, body: { text: 'Into a kids’ space?', villageId: 1 } });
expect(kids.status === 403 && kids.data.code === 'surface_not_allowed', 'no other surfaces', kids.data);
ok('anywhere but the main Feed is refused', `${kids.status} ${kids.data.code}`);

const status = await call('GET', `/api/v1/posts/${text.data.post.id}`, { token: access });
expect(status.status === 200 && status.data.post.status === 'published', 'read status', status.data);
ok('GET /api/v1/posts/:id', `#${status.data.post.id} is ${status.data.post.status}`);

/* ---------- 4. refresh (rotation) ---------- */

const r1 = await call('POST', '/api/oauth/token', { basic: client, form: { grant_type: 'refresh_token', refresh_token: refresh } });
expect(r1.status === 200 && r1.data.refresh_token !== refresh, 'refresh', r1.data);
const oldRefresh = refresh;
access = r1.data.access_token;
refresh = r1.data.refresh_token;
ok('refresh → a new access token and a new refresh token (the old one is spent)');

/* ---------- 5. delete, then disconnect ---------- */

if (!KEEP) {
  const del = await call('DELETE', `/api/v1/posts/${text.data.post.id}`, { token: access });
  expect(del.status === 200, 'delete', del.data);
  const after = await call('GET', `/api/v1/posts/${text.data.post.id}`, { token: access });
  expect(after.data.post?.status === 'removed', 'status after delete', after.data);
  ok('DELETE /api/v1/posts/:id', `#${text.data.post.id} is now ${after.data.post.status}`);

  const reuse = await call('POST', '/api/oauth/token', { basic: client, form: { grant_type: 'refresh_token', refresh_token: oldRefresh } });
  expect(reuse.status === 400 && reuse.data.error === 'invalid_grant', 'reusing a spent refresh token', reuse.data);
  const dead = await call('GET', '/api/v1/me', { token: access });
  expect(dead.status === 401, 'grant revoked after reuse', dead.status);
  ok('reusing the spent refresh token is refused — and ends the whole grant', `${reuse.data.error}; the newer access token now gets ${dead.status}`);
} else {
  ok('FEED_DEMO_KEEP=1: posts and the connection left in place', `access token for a UI check: ${access.slice(0, 8)}…`);
  console.log(`\nACCESS_TOKEN=${access}`);
}

console.log('\nDEMO PASSED');
