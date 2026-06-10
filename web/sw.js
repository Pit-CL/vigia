/* Service worker: shell en caché, datos red-primero con respaldo. */
const SHELL_CACHE = 'sinoptica-shell-v2';
const DATA_CACHE = 'sinoptica-data-v2';
const SHELL = [
  './',
  'index.html',
  'app.css?v=9',
  'app.js?v=9',
  'manifest.webmanifest',
  'vendor/chart.umd.min.js',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'fonts/fonts.css',
  'fonts/BricolageGrotesque-300-800-0.woff2',
  'fonts/IBMPlexMono-400-1.woff2',
  'fonts/IBMPlexMono-500-2.woff2',
  'fonts/IBMPlexMono-600-3.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // APIs de datos: red primero, respaldo en caché (último pronóstico visto offline).
  // Los tiles del mapa quedan fuera (los maneja el navegador).
  const isData = url.hostname.endsWith('open-meteo.com') ||
    /\/(status|verificacion|estaciones|aire)\.json$/.test(url.pathname);
  if (isData) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Shell y fuentes: caché primero, actualiza en segundo plano
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
