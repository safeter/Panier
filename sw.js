// Service worker : réseau d'abord pour l'app (mises à jour immédiates), cache pour le hors ligne.
const VERSION = 'panier-v2.8.0';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/calc.js', './js/db.js', './js/util.js', './js/charts.js',
  './js/categories.js', './js/importer.js', './js/sync.js', './js/pdfparse.js', './js/pdfimport.js', './js/similar.js', './js/catalogue.js', './js/excel.js',
  './data/seed.json', './data/ipc-quebec.json', './data/patches/recus-mai-2026.json', './data/patches/catalogue-2026-10.json', './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' contourne le cache HTTP du navigateur : la nouvelle version met en cache les nouveaux fichiers.
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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

  // Fichiers de l'app : réseau d'abord (toujours la dernière version en ligne), cache si hors ligne.
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }

  // Polices et bibliothèques externes : cache d'abord.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok && /fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.hostname)) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
    }
    return res;
  })));
});
