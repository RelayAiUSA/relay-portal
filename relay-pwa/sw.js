const CACHE = 'relay-v3';
const ASSETS = ['/index.html', '/css/app.css', '/js/app.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Don't intercept Firebase or Google requests — they need live network
  if (e.request.url.includes('firebase') || e.request.url.includes('googleapis')) return;
  // Don't intercept root URL — let Netlify serve landing.html via redirect
  const url = new URL(e.request.url);
  if (url.pathname === '/' || url.pathname === '') return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
