/* Service worker: shell en caché, datos red-primero con respaldo. */
const SHELL_CACHE = 'vigia-shell-v7';
const DATA_CACHE = 'vigia-data-v7';
// Tiles del mapa base (CARTO): caché propia con límite LRU aproximado, para
// que el mapa siga siendo usable sin conexión (ver fetch handler abajo).
const TILES_CACHE = 'vigia-tiles-v1';
const TILES_MAX = 400;
const TILES_TRIM = 50;
const SHELL = [
  './',
  'index.html',
  'emergencia.html',
  'app.css?v=37',
  'app.js?v=37',
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
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE && k !== TILES_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// LRU aproximado: keys() conserva el orden de inserción razonablemente, así
// que borrar las primeras N es un FIFO suficiente para no crecer sin límite
// (no es un LRU real por fecha de acceso, pero para tiles de mapa alcanza).
function trimTilesCache(cache) {
  cache.keys().then((keys) => {
    if (keys.length <= TILES_MAX) return;
    Promise.all(keys.slice(0, TILES_TRIM).map((k) => cache.delete(k)));
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Tiles del mapa base (CARTO): red primero, con respaldo en caché para que
  // el mapa siga usable offline. Las respuestas son opacas (Leaflet no pone
  // crossOrigin en las <img> de tiles) pero SÍ se pueden cachear y servir —
  // lo que antes rompía el mapa era manejar mal el respaldo, no el cacheo en
  // sí. Sin red y sin tile cacheado, se deja fallar el fetch tal cual: se ve
  // un tile roto, aceptable en modo offline (mejor que romper todo el mapa).
  if (url.hostname.endsWith('.basemaps.cartocdn.com')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(TILES_CACHE).then((c) => { c.put(e.request, copy); trimTilesCache(c); });
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Solo gestionamos lo nuestro: same-origin y las APIs de Open-Meteo.
  // Cualquier otro recurso cross-origin el navegador lo maneja directo.
  const isOpenMeteo = url.hostname.endsWith('open-meteo.com');
  if (url.origin !== location.origin && !isOpenMeteo) return;

  // APIs de datos: red primero, respaldo en caché (último pronóstico visto offline).
  const isData = isOpenMeteo ||
    /\/(status|verificacion|estaciones|aire|bias|avisos|sismos|incendios|alertas|volcanes|emergencia|tsunami_vias|tsunami_areas)\.json$/.test(url.pathname);
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

// Avisos de emergencia (Web Push): el payload trae { title, body }. Si no
// llega JSON válido, se arma una notificación mínima con el texto crudo.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: 'Vigía — aviso de emergencia', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Vigía', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    lang: 'es', tag: 'vigia-emergencia', renotify: true,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return clients.openWindow('./');
  }));
});
