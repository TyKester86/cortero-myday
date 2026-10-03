/* MyDay service worker: offline reads + push notifications.
 *
 * - App shell (index.html, hashed /assets, icons, meal pictures) is cached so
 *   the app opens with no connection (re-cached on every page load).
 * - Lecture recordings never pass through here: they wait in IndexedDB and
 *   the page uploads them when there's signal (see src/recordings.ts).
 * - API reads are network-first; the last good answer is served offline.
 * - Writes are NOT handled here: the page queues them and replays them with
 *   an Idempotency-Key when the connection returns (see src/api.ts).
 * - Signing out clears the cached API data on this device.
 */
const VERSION = 'myday-v1';
const SHELL = `${VERSION}-shell`;
const API = `${VERSION}-api`;
const SHELL_FILES = ['/', '/index.html', '/manifest.webmanifest', '/icons/myday-icon-192.png', '/icons/myday-mark.svg'];

/**
 * Cache the page and every script/style it loads, so the app (and the lecture
 * recorder) opens with no signal — even right after a deploy.
 */
async function cacheShell(res) {
  const cache = await caches.open(SHELL);
  const page = res ?? (await fetch('/index.html', { cache: 'no-store' }));
  if (!page.ok || !(page.headers.get('content-type') || '').includes('text/html')) return;
  const html = await page.clone().text();
  await cache.put('/index.html', page.clone());
  await cache.put('/', page.clone());
  const assets = [...new Set(html.match(/\/assets\/[^"'\s)]+/g) || [])];
  await Promise.all(
    assets.map(async (a) => {
      if (await cache.match(a)) return;
      const r = await fetch(a);
      if (r.ok) await cache.put(a, r);
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => cacheShell().catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-api') event.waitUntil(caches.delete(API));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw new Error('offline');
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    // Progress photos are never stored on the device (shared family phones).
    if (p.startsWith('/api/auth/') || p.endsWith('.csv') || p.startsWith('/api/progress-photos')) return;
    event.respondWith(
      networkFirst(req, API).catch(
        () => new Response(JSON.stringify({ error: 'You’re offline and this hasn’t been opened on this device yet.' }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    return;
  }
  if (req.mode === 'navigate') {
    if (p.startsWith('/dev-login') || p === '/install' || p.startsWith('/install/')) return;
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Every page is the app shell: keep the cached copy current.
          if (res.ok) event.waitUntil(cacheShell(res.clone()).catch(() => undefined));
          return res;
        })
        .catch(async () => (await caches.match('/index.html')) || (await caches.match('/'))),
    );
    return;
  }
  if (p.startsWith('/assets/') || p.startsWith('/icons/') || p.startsWith('/meals/') || p.startsWith('/exercises/') || p.startsWith('/roles/')) {
    event.respondWith(cacheFirst(req));
  }
});

self.addEventListener('push', (event) => {
  let data = { title: 'MyDay', body: '', url: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* plain text or empty */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, { body: data.body, icon: '/icons/myday-icon-192.png', badge: '/icons/myday-icon-192.png', data: { url: data.url }, tag: 'myday-daily' }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        open.navigate(url);
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
