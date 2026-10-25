// Service worker : l'app se lance hors ligne ; la série officielle est rafraîchie dès que possible.
const VERSION = 'panier-v2.5.1';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/calc.js', './js/db.js', './js/util.js', './js/charts.js',
  './js/categories.js', './js/importer.js', './js/sync.js', './js/pdfparse.js', './js/pdfimport.js', './js/excel.js',
  './data/seed.json', './data/ipc-quebec.json', './data/patches/recus-mai-2026.json', './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // Série officielle : réseau d'abord, cache en secours.
  if (url.pathname.endsWith('/data/ipc-quebec.json')) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }

  // Reste (app, polices, SheetJS) : cache d'abord, puis réseau mis en cache.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.hostname))) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
    }
    return res;
  })));
});
