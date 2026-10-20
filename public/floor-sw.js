// Worker app helper: keeps the screens (not the data) on the phone so the app still opens when the
// factory Wi-Fi drops. Stock numbers always come live from the office PC — /api is never cached.
// Logins (v3): the log in page, the office app, /api and photos are never kept; a page that came back as a
// redirect (to /login) is never kept; logging out clears everything kept here (floor.js).
const CACHE = 'stallion-floor-v3';
const SHELL = ['/floor.css', '/floor.js', '/wording.js', '/factorymap.js', '/fonts/fonts.css',
  '/assets/brand/mark-limestone.png', '/assets/app/icon-192.png'];
const NEVER = /^\/(api\/|photos\/|login|index\.html$|$)/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || NEVER.test(url.pathname)) return;
  // Network first, so updates on the office PC show straight away; the saved copy only when offline.
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && !res.redirected && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
