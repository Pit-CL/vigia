/* Service worker: shell en caché, datos red-primero con respaldo. */
const SHELL_CACHE = 'sinoptica-shell-v4';
const DATA_CACHE = 'sinoptica-data-v4';
const SHELL = [
  './',
  'index.html',
  'app.css?v=21',
  'app.js?v=21',
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

  // Solo gestionamos lo nuestro: same-origin y las APIs de Open-Meteo.
  // Los tiles del mapa (cartocdn) y cualquier otro recurso cross-origin NO
  // se interceptan — el navegador los maneja directo. Interceptarlos como
  // respuestas opacas rompía el mapa en algunos navegadores (fondo en blanco).
  const isOpenMeteo = url.hostname.endsWith('open-meteo.com');
  if (url.origin !== location.origin && !isOpenMeteo) return;

  // APIs de datos: red primero, respaldo en caché (último pronóstico visto offline).
  const isData = isOpenMeteo ||
    /\/(status|verificacion|estaciones|aire|bias)\.json$/.test(url.pathname);
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

  // El documento HTML: RED primero. Así el index.html siempre referencia los
  // assets versionados actuales y nunca queda un HTML viejo cacheado que no
  // calce con un app.js nuevo (eso rompía el render). Respaldo a caché offline.
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('index.html')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }

  // Assets versionados (?v=N) y fuentes: caché primero, refresco en segundo plano.
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
