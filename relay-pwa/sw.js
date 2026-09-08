// relay-pwa/sw.js
//
// CACHE STRATEGY - read this before changing it.
//
// The previous version was cache-first for everything:
//     caches.match(req).then(r => r || fetch(req))
// If a file was in the cache it was served from there and the network was never
// consulted. Combined with a hardcoded cache name that nobody remembered to
// bump, that meant a returning user kept running whatever app.js they first
// cached - potentially for weeks. Deploys went out and were invisible. A user
// reporting "that feature isn't there" while the server was serving it
// correctly is the exact symptom.
//
// Now:
//   - Code (HTML, JS, CSS) is NETWORK-FIRST. Always ask the network, fall back
//     to cache only when offline. A deploy is picked up on the next load.
//   - Static assets (icons, images, fonts) stay CACHE-FIRST. They are content
//     that rarely changes and is expensive to refetch.
//
// Bump CACHE whenever the cached asset list changes. It is no longer the
// mechanism that ships code updates - network-first is - but activate() still
// uses it to purge older caches.
const CACHE = 'relay-v4-network-first';

const PRECACHE = [
  '/index.html', '/css/app.css', '/js/app.js', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

// Cache-first is safe for these: they are versioned by content, not by deploy.
const STATIC_RE = /\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|mp4)$/i;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Firebase and Google need the live network.
  if (e.request.url.includes('firebase') || e.request.url.includes('googleapis')) return;

  const url = new URL(e.request.url);

  // Never intercept cross-origin requests.
  if (url.origin !== self.location.origin) return;

  // Let Netlify's redirect serve landing.html at the root.
  if (url.pathname === '/' || url.pathname === '') return;

  // Never cache the Netlify Functions endpoints.
  if (url.pathname.startsWith('/.netlify/')) return;

  // ── Static assets: cache-first ────────────────────────────────────────────
  if (STATIC_RE.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }))
    );
    return;
  }

  // ── Everything else (the app itself): network-first ───────────────────────
  // The cache is a fallback for being offline, never the default source. This
  // is what makes a deploy actually reach the user.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('/index.html')))
  );
});
