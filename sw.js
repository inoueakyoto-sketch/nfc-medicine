const CACHE_NAME = 'okusuri-medal-plus-v1.4';
const CORE = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './assets/brand/logo.png', './assets/brand/icon-64.png', './assets/brand/icon-192.png',
  './assets/brand/icon-512.png', './assets/brand/icon-maskable-512.png', './assets/brand/apple-touch-icon.png',
  './games/manifest.js',
  './games/janken/index.html', './games/marubatsu/index.html', './games/block-break/index.html',
  './games/rhythm/index.html', './games/smartball/index.html', './games/stopwatch/index.html',
  './games/minigolf/index.html', './games/memory/index.html', './games/block-puzzle/index.html',
  './games/slide-run/index.html'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)); return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
    return;
  }
  event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)); }
    return res;
  })));
});
