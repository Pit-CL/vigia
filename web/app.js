/* Sinóptica — pronóstico multi-modelo para Chile central.
   Datos: Open-Meteo (CC BY 4.0). Observaciones: DMC + red OMM (NOAA).
   Sin claves, sin tracking, sin CDNs. */
'use strict';

// ── Configuración ──────────────────────────────────────────────

const API = 'https://api.open-meteo.com/v1/forecast';
const API_ENS = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const API_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const API_AIRE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TZ = 'America/Santiago';

// ── ICAP: índice de calidad del aire chileno (D.S. 12/2011 MMA) ──
// La concentración de MP2,5 (promedio móvil 24 h) se mapea a un índice por
// tramos lineales; los puntos de quiebre 50/80/110/170 µg/m³ son los umbrales
// oficiales de norma, alerta, preemergencia y emergencia.
const ICAP_BP = [
  [0, 50, 0, 100], [50, 80, 100, 200], [80, 110, 200, 300], [110, 170, 300, 500],
];
function mp25ToIcap(c) {
  if (c == null) return null;
  for (const [cl, ch, il, ih] of ICAP_BP) {
    if (c <= ch) return Math.round(il + ((c - cl) / (ch - cl)) * (ih - il));
  }
  return Math.min(999, Math.round(500 + (c - 170) * 1.5));
}
const ICAP_NIVELES = [
  { max: 100, n: 'Buena',         c: '#2eae00', cls: 'icap-0', consejo: 'Aire limpio. Ideal para actividades al aire libre.' },
  { max: 200, n: 'Regular',       c: '#d6c200', cls: 'icap-1', consejo: 'Aceptable. Personas muy sensibles podrían reducir el esfuerzo prolongado al aire libre.' },
  { max: 300, n: 'Alerta',        c: '#ff7e00', cls: 'icap-2', consejo: 'Grupos sensibles (niños, adultos mayores, enfermos respiratorios) deben evitar el esfuerzo al aire libre.' },
  { max: 500, n: 'Preemergencia', c: '#e3000f', cls: 'icap-3', consejo: 'Evita la actividad física al aire libre. Los grupos sensibles deben permanecer en interiores.' },
  { max: Infinity, n: 'Emergencia', c: '#7e0023', cls: 'icap-4', consejo: 'Toda la población debe evitar actividad al aire libre y mantener puertas y ventanas cerradas.' },
];
const icapNivel = (icap) => ICAP_NIVELES.find((x) => icap < x.max) || ICAP_NIVELES[ICAP_NIVELES.length - 1];

const MODELS = [
  { id: 'ecmwf_ifs025',         name: 'IFS',    org: 'ECMWF · Europa' },
  { id: 'gfs_seamless',         name: 'GFS',    org: 'NOAA · EE.UU.' },
  { id: 'icon_seamless',        name: 'ICON',   org: 'DWD · Alemania' },
  { id: 'gem_seamless',         name: 'GEM',    org: 'ECCC · Canadá' },
  { id: 'meteofrance_seamless', name: 'ARPEGE', org: 'Météo-France' },
];

const MODEL_COLORS = {
  light: ['#2456c9', '#0e9888', '#b07d10', '#8b4ac2', '#c8451f'],
  dark:  ['#6f9bff', '#3fc4b1', '#d9a83a', '#b685e0', '#ff7a4d'],
};

const PLACES = [
  { region: 'V Región', items: [
    { name: 'Valparaíso',   lat: -33.046, lon: -71.620 },
    { name: 'Viña del Mar', lat: -33.024, lon: -71.552 },
    { name: 'Quilpué',      lat: -33.047, lon: -71.443 },
    { name: 'Quillota',     lat: -32.883, lon: -71.249 },
    { name: 'San Antonio',  lat: -33.593, lon: -71.607 },
    { name: 'Los Andes',    lat: -32.834, lon: -70.598 },
  ]},
  { region: 'RM', items: [
    { name: 'Santiago',     lat: -33.456, lon: -70.648 },
    { name: 'Pudahuel',     lat: -33.393, lon: -70.785 },
    { name: 'Las Condes',   lat: -33.408, lon: -70.567 },
    { name: 'Puente Alto',  lat: -33.610, lon: -70.575 },
    { name: 'Melipilla',    lat: -33.689, lon: -71.213 },
    { name: 'Colina',       lat: -33.202, lon: -70.674 },
  ]},
];

// WMO weather_code → [descripción, icono]
const WMO = {
  0: ['Despejado', '☀️'], 1: ['Mayormente despejado', '🌤️'], 2: ['Parcialmente nublado', '⛅'],
  3: ['Nublado', '☁️'], 45: ['Niebla', '🌫️'], 48: ['Niebla con escarcha', '🌫️'],
  51: ['Llovizna débil', '🌦️'], 53: ['Llovizna', '🌦️'], 55: ['Llovizna intensa', '🌧️'],
  56: ['Llovizna helada', '🌧️'], 57: ['Llovizna helada intensa', '🌧️'],
  61: ['Lluvia débil', '🌧️'], 63: ['Lluvia', '🌧️'], 65: ['Lluvia intensa', '🌧️'],
  66: ['Lluvia helada', '🌧️'], 67: ['Lluvia helada intensa', '🌧️'],
  71: ['Nieve débil', '🌨️'], 73: ['Nieve', '🌨️'], 75: ['Nieve intensa', '❄️'],
  77: ['Cinarra', '🌨️'], 80: ['Chubascos débiles', '🌦️'], 81: ['Chubascos', '🌧️'],
  82: ['Chubascos violentos', '⛈️'], 85: ['Chubascos de nieve', '🌨️'],
  86: ['Chubascos de nieve intensos', '❄️'], 95: ['Tormenta eléctrica', '⛈️'],
  96: ['Tormenta con granizo', '⛈️'], 99: ['Tormenta con granizo intenso', '⛈️'],
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DAYS_FULL = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const OBS_LABELS = {
  temperature_2m: ['Temperatura', '°C'],
  dew_point_2m: ['Punto de rocío', '°C'],
  relative_humidity_2m: ['Humedad relativa', '%'],
  pressure_msl: ['Presión (nivel del mar)', 'hPa'],
  wind_speed_10m: ['Viento (prom. 10 min)', 'km/h'],
  wind_direction_10m: ['Dirección del viento', '°'],
  visibility: ['Visibilidad', 'm'],
  cloud_cover: ['Nubosidad', '%'],
  precipitation_6h: ['Precipitación últimas 6 h', 'mm'],
};

// ── Explicaciones (simple primero, ciencia después) ────────────

const INFO = {
  actual: {
    title: '¿Qué significa cada dato?',
    html: `
<p><strong>Temperatura y sensación.</strong> La temperatura es la del aire a 2 metros del suelo. La «sensación» corrige ese número por el viento y la humedad: el viento le roba calor a tu piel (te enfría) y la humedad alta impide que el sudor evapore (te acalora). Por eso un día de 5 °C con viento fuerte se siente bajo cero.</p>
<p><strong>Humedad relativa.</strong> Cuánto vapor de agua tiene el aire respecto del máximo que podría tener a esa temperatura. 100 % = aire saturado (niebla o rocío probables); bajo 30 % = aire muy seco.</p>
<p><strong>Viento.</strong> Velocidad y <em>de dónde viene</em> (un viento SO viene desde el suroeste). En la costa de la V Región el viento SO de la tarde es la clásica brisa marina.</p>
<p><strong>Presión al nivel del mar.</strong> El peso de la atmósfera, normalizado al nivel del mar para poder comparar ciudades a distinta altura. Sobre ~1020 hPa suele dominar el buen tiempo (anticiclón); si cae rápido, se acerca un sistema frontal.</p>
<p class="info-fine">Este panel muestra la <em>síntesis de modelo</em> para el punto elegido (la mejor estimación interpolada). El mapa de observaciones, en cambio, muestra lo que los sensores físicos están midiendo de verdad.</p>`,
  },
  aire: {
    title: 'Calidad del aire: MP2,5 y el índice ICAP',
    html: `
<p><strong>En simple:</strong> el número grande es el <strong>ICAP</strong>, el índice oficial chileno de calidad del aire. Mientras más alto, peor el aire. Bajo 100 es bueno; sobre 300 es preemergencia. El color y el consejo siguen la norma del Ministerio del Medio Ambiente.</p>
<p><strong>¿Qué es el MP2,5?</strong> Material particulado fino: partículas de 2,5 micrones o menos —30 veces más delgadas que un cabello—. Son tan pequeñas que esquivan las defensas de la nariz, llegan al fondo del pulmón y pasan a la sangre. Es el contaminante más dañino para la salud y el que dispara las emergencias ambientales.</p>
<p><strong>Por qué importa tanto en Chile central:</strong> en invierno, el aire frío queda atrapado bajo una capa de aire más cálido (inversión térmica) y el humo de la calefacción a leña y los vehículos no logra dispersarse. Por eso Santiago y el valle central tienen episodios críticos de mayo a agosto.</p>
<p><strong>Los niveles oficiales</strong> (según el ICAP, sobre el promedio de 24 horas de MP2,5):</p>
<p class="info-fine">Buena 0–99 · Regular 100–199 · Alerta 200–299 · Preemergencia 300–499 · Emergencia 500+. Concentraciones de quiebre: 50 µg/m³ (norma diaria), 80 (alerta), 110 (preemergencia), 170 (emergencia).</p>
<p class="info-fine"><strong>El dato grande es real, no pronóstico:</strong> cuando hay una estación de la red oficial <strong>SINCA</strong> (Ministerio del Medio Ambiente) cerca de tu ubicación, mostramos su medición y su ICAP oficial. El gráfico de 48 h es el pronóstico del modelo CAMS de Copernicus (vía Open-Meteo). Si no hay estación cercana, todo el panel usa CAMS.</p>`,
  },
  mapa: {
    title: '¿De dónde salen estas mediciones?',
    html: `
<p>Cada punto es una <strong>estación meteorológica real</strong> midiendo ahora mismo, no un pronóstico:</p>
<p><strong>Aeropuertos (METAR).</strong> Observaciones oficiales que los aeródromos publican cada hora a la red mundial de la Organización Meteorológica Mundial, con estándares de aviación: Pudahuel, Tobalaba, Torquemada, Rodelillo y Santo Domingo.</p>
<p><strong>Estaciones automáticas (EMA) de la Dirección Meteorológica de Chile.</strong> Sensores que reportan minuto a minuto: Quinta Normal (la estación de referencia histórica de Santiago), Jardín Botánico de Viña, Quillota, San Felipe, Quintero, Colina, Talagante, La Florida, San José de Maipo y Los Libertadores a 2.955 m en plena cordillera.</p>
<p class="info-fine">¿Por qué una estación puede diferir del «ahora» del panel superior? Porque el panel es un modelo interpolado a tu punto exacto y la estación es un sensor físico en SU punto exacto — comparar ambos es justamente cómo medimos la calidad del pronóstico (ver «¿Cuánto acierta cada modelo?»).</p>`,
  },
  ensamble: {
    title: 'La banda de incertidumbre (ensamble)',
    html: `
<p><strong>En simple:</strong> el futuro de la atmósfera no se puede conocer con exactitud, así que el centro europeo ECMWF corre su modelo <strong>51 veces</strong>, cada vez partiendo de condiciones iniciales levemente distintas. La banda muestra dónde cae el 80 % de esos 51 futuros posibles. Banda angosta = los escenarios coinciden, alta confianza. Banda ancha = la atmósfera está «difícil», cualquier número exacto sería una falsa promesa.</p>
<p><strong>La ciencia:</strong> la atmósfera es un sistema caótico — errores diminutos en el estado inicial crecen exponencialmente (el famoso «efecto mariposa» que describió Edward Lorenz en 1963). El pronóstico por ensambles es la respuesta operativa de la meteorología moderna a ese caos: en vez de fingir certeza, se cuantifica la incertidumbre. La línea segmentada es la mediana (la mitad de los escenarios está arriba y la mitad abajo).</p>
<p class="info-fine">Las líneas finas de colores son los modelos <em>deterministas</em> de 5 centros mundiales — si además de la banda los modelos discrepan entre sí, la incertidumbre es doble.</p>`,
  },
  precipitacion: {
    title: '¿Qué significa «70 % de probabilidad de lluvia»?',
    html: `
<p><strong>Lo que SÍ significa:</strong> de 10 situaciones atmosféricas como la pronosticada, en 7 cae al menos 0,1 mm de agua en esa hora y en ese punto. Es una frecuencia esperada, igual que «este dado tiene 1/6 de probabilidad de salir 6».</p>
<p><strong>Lo que NO significa:</strong> ni que lloverá el 70 % del tiempo, ni que lloverá en el 70 % de la ciudad, ni que la lluvia será «fuerte al 70 %».</p>
<p><strong>¿De dónde sale el número?</strong> Principalmente de contar miembros del ensamble: si 36 de los 51 escenarios dan lluvia a esa hora, la probabilidad ronda el 70 %. Por eso probabilidad e intensidad son cosas distintas: puede haber 90 % de probabilidad de una llovizna de 0,2 mm, o 20 % de un chubasco de 15 mm.</p>
<p class="info-fine">Las barras muestran la intensidad esperada (mm por hora); la línea segmentada, la probabilidad. Para decidir si llevar paraguas, mira la probabilidad; para saber si se inunda el patio, mira los milímetros.</p>`,
  },
  diario: {
    title: 'Cómo leer la franja semanal',
    html: `
<p>Cada tarjeta resume un día: ícono del tiempo predominante, temperatura <strong>máxima</strong> (grande) y <strong>mínima</strong> (gris), y abajo la lluvia: milímetros acumulados esperados y la probabilidad más alta del día.</p>
<p><strong>Toca cualquier día</strong> para abrir su detalle hora a hora, con la comparación entre modelos cuando está disponible.</p>
<p class="info-fine">Ten presente que la confianza decae con el plazo: el pronóstico para mañana es mucho más firme que el del día 7. Es física, no defecto: el caos atmosférico pone un límite duro de ~10-14 días a cualquier pronóstico determinista, por mucho computador que se le ponga.</p>`,
  },
  modelos: {
    title: '¿Qué es un modelo meteorológico y por qué difieren?',
    html: `
<p><strong>En simple:</strong> un modelo numérico divide la atmósfera del planeta en una grilla 3D de celdas (de ~10 a 25 km de lado según el modelo) y resuelve las ecuaciones de la física — movimiento, calor, humedad — hacia adelante en el tiempo, en algunos de los supercomputadores más grandes del mundo.</p>
<p><strong>Los cinco que mostramos:</strong> IFS del centro europeo ECMWF (el de mayor prestigio mundial en verificaciones), GFS de la NOAA estadounidense, ICON del servicio alemán DWD, GEM del canadiense ECCC y ARPEGE de Météo-France.</p>
<p><strong>¿Por qué no dicen lo mismo?</strong> Difieren en la resolución de su grilla, en cómo representan procesos más pequeños que una celda (una nube, una quebrada de la cordillera) y en cómo digieren las observaciones iniciales. Chile es terreno difícil: el salto del Pacífico a los Andes en ~150 km es más angosto que una celda de algunos modelos.</p>
<p class="info-fine">La fila «dispersión» es información valiosa: si los 5 modelos coinciden, puedes confiar; si difieren en 6 °C o en 10 mm de lluvia, la atmósfera está genuinamente impredecible y quien te dé un solo número te está simplificando de más.</p>`,
  },
  verificacion: {
    title: '¿Cómo medimos el acierto?',
    html: `
<p><strong>El método:</strong> guardamos cada pronóstico en el momento en que se emite. Cuando llega la hora pronosticada, lo comparamos con lo que <em>realmente midieron</em> las 15 estaciones (aeropuertos + DMC). Nadie puede retocar el pronóstico después: queda archivado.</p>
<p><strong>MAE (error absoluto medio):</strong> el tamaño típico del error, en grados. «MAE 1,5 °C a 1 día» significa que, en promedio, la temperatura pronosticada para el día siguiente difirió 1,5 °C de la observada. Mientras más chico, mejor.</p>
<p><strong>Sesgo:</strong> el error <em>con signo</em>. Un sesgo de +1 °C significa que el modelo tiende a pronosticar más calor del que llega; −1 °C, más frío. Conocer el sesgo de cada modelo en cada lugar es la base para corregirlo — exactamente lo que hará nuestro modelo de calibración local.</p>
<p><strong>Los plazos:</strong> «a 1 día» evalúa pronósticos emitidos 24 h antes; «a 4 días», 96 h antes. El error crece con el plazo — eso también lo puedes ver aquí, transparente.</p>
<p class="info-fine">Ventana móvil: últimos 14 días, todas las estaciones, todas las horas. El número «n» son los pares pronóstico-observación evaluados: con n chico las cifras bailan; con miles, se estabilizan. Este archivo partió el 9 de junio de 2026 y mejora solo con cada hora que pasa.</p>`,
  },
};

// ── Estado ─────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const charts = {};            // canvasId → instancia Chart
let lastData = null;          // { best, multi, ens } para redibujar
let verifData = null;
let verifBucket = '24';
let estacionesData = null;
let aireStations = [];   // estaciones SINCA oficiales (calidad del aire)
let mapMode = 'temp';    // 'temp' | 'aire'
let map = null;
let tileLayer = null;

function savedPlace() {
  try {
    const raw = localStorage.getItem('sinoptica.place');
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.lat === 'number' && typeof p.lon === 'number' && p.name) return p;
    }
  } catch (_) { /* localStorage puede no estar disponible */ }
  return PLACES[1].items[0]; // Santiago
}

let place = savedPlace();

// ── Utilidades ─────────────────────────────────────────────────

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const modelColors = () => MODEL_COLORS[isDark() ? 'dark' : 'light'];
const wmo = (code) => WMO[code] || ['—', '·'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function fetchJSON(url) {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url, location.href).hostname}`);
    return res.json();
  });
}

function weekday(iso, full = false) {
  const [y, m, d] = iso.split('-').map(Number);
  return (full ? DAYS_FULL : DAYS)[new Date(y, m - 1, d, 12).getDay()];
}

function percentile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function tempClass(t) {
  if (t == null) return 'tcx';
  const limits = [0, 5, 10, 15, 20, 25, 30];
  for (let i = 0; i < limits.length; i++) if (t < limits[i]) return `tc${i}`;
  return 'tc7';
}

function horaLocal(isoUtc) {
  try {
    return new Date(isoUtc).toLocaleTimeString('es-CL', {
      hour: '2-digit', minute: '2-digit', timeZone: TZ,
    });
  } catch (_) { return isoUtc; }
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

// ── Carga de datos ─────────────────────────────────────────────

function urlBase(extra) {
  return new URLSearchParams({
    latitude: place.lat.toFixed(4),
    longitude: place.lon.toFixed(4),
    timezone: TZ,
    ...extra,
  }).toString();
}

async function loadAll() {
  const app = $('#app');
  app.dataset.state = 'loading';
  $('#error').hidden = true;

  const qBest = urlBase({
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,precipitation',
    hourly: 'temperature_2m,precipitation,precipitation_probability,wind_speed_10m,relative_humidity_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max',
    forecast_days: '7',
  });
  const qModels = urlBase({
    hourly: 'temperature_2m,precipitation',
    models: MODELS.map((m) => m.id).join(','),
    forecast_days: '3',
  });
  const qEns = urlBase({
    hourly: 'temperature_2m',
    models: 'ecmwf_ifs025',
    forecast_days: '3',
  });

  const qAire = urlBase({
    current: 'pm10,pm2_5,nitrogen_dioxide,ozone',
    hourly: 'pm2_5',
    past_days: '1',       // necesario para el promedio móvil 24 h del ICAP
    forecast_days: '2',
  });

  // Ensamble y aire son opcionales: si fallan, la app sigue sin ellos.
  const [best, multi, ens, aire] = await Promise.all([
    fetchJSON(`${API}?${qBest}`),
    fetchJSON(`${API}?${qModels}`),
    fetchJSON(`${API_ENS}?${qEns}`).catch(() => null),
    fetchJSON(`${API_AIRE}?${qAire}`).catch(() => null),
  ]);

  lastData = { best, multi, ens, aire };
  render();
  app.dataset.state = 'ready';
}

// ── Render principal ───────────────────────────────────────────

function render() {
  if (!lastData) return;
  renderNow(lastData.best);
  renderAire(lastData.aire);
  renderCharts(lastData.best, lastData.multi, lastData.ens);
  renderDaily(lastData.best);
  renderModelTable(lastData.multi);
  renderChips();
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function estacionAireCercana() {
  let best = null;
  for (const e of aireStations) {
    if (e.pm2_5 == null) continue;
    const d = haversineKm(place.lat, place.lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { ...e, dist: d };
  }
  return best && best.dist <= 60 ? best : null;   // dentro de la zona
}

function renderAire(aire) {
  const panel = $('.panel-aire');
  if (!aire || !aire.current) { if (panel) panel.hidden = true; return; }
  panel.hidden = false;
  const c = aire.current;

  // Serie horaria CAMS (siempre disponible para el gráfico de pronóstico).
  const h = aire.hourly || {};
  const serie = h.pm2_5 || [];
  const nowIdx = (h.time || []).indexOf((c.time || '').slice(0, 13) + ':00');

  // Dato principal: estación oficial SINCA más cercana (medición real).
  // Si no hay una cerca, el pronóstico CAMS sobre el promedio móvil 24 h.
  const oficial = estacionAireCercana();
  let icap, fuenteTxt;
  if (oficial && oficial.icap != null) {
    icap = oficial.icap;
    fuenteTxt = `estación oficial ${oficial.nombre} · ${Math.round(oficial.dist)} km`;
  } else {
    const lo = nowIdx >= 23 ? nowIdx - 23 : 0;
    const ventana = serie.slice(lo, (nowIdx >= 0 ? nowIdx : serie.length - 1) + 1).filter((v) => v != null);
    const pm25_24h = ventana.length ? ventana.reduce((a, b) => a + b, 0) / ventana.length : c.pm2_5;
    icap = mp25ToIcap(pm25_24h);
    fuenteTxt = 'pronóstico CAMS (sin estación cercana)';
  }
  const nivel = icapNivel(icap);

  $('#aire-icap').textContent = icap ?? '—';
  $('#aire-icap').style.color = nivel.c;
  const nv = $('#aire-nivel');
  nv.textContent = nivel.n;
  nv.style.color = nivel.c;
  $('#aire-consejo').textContent = nivel.consejo;
  $('.aire-gauge').style.borderColor = nivel.c;
  $('#aire-place').textContent = fuenteTxt;

  // Concentraciones: las de la estación oficial si existe; si no, CAMS actual.
  const set = (id, v, u) => { $(id).textContent = v == null ? '—' : `${Math.round(v)} ${u}`; };
  set('#aire-pm25', oficial ? oficial.pm2_5 : c.pm2_5, 'µg/m³');
  set('#aire-pm10', oficial ? oficial.pm10 : c.pm10, 'µg/m³');
  set('#aire-no2', c.nitrogen_dioxide, 'µg/m³');
  set('#aire-o3', c.ozone, 'µg/m³');

  // pronóstico MP2,5 próximas 48 h
  if (serie.length && h.time) {
    const start = nowIdx >= 0 ? nowIdx : 0;
    const win = Math.min(48, h.time.length - start);
    const labels = h.time.slice(start, start + win).map((t) => {
      const hh = t.slice(11, 13);
      return hh === '00' ? `${weekday(t.slice(0, 10))} ${hh}h` : `${hh}h`;
    });
    const th = chartTheme();
    destroyChart('chart-aire');
    charts['chart-aire'] = new Chart($('#chart-aire'), {
      data: {
        labels,
        datasets: [{
          type: 'line', label: 'MP2,5 µg/m³ (pronóstico)',
          data: serie.slice(start, start + win),
          borderColor: nivel.c, backgroundColor: nivel.c + '22',
          borderWidth: 1.6, pointRadius: 0, fill: true, tension: 0.3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } },
        scales: {
          x: { grid: { color: th.grid }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
          y: { grid: { color: th.grid }, beginAtZero: true, title: { display: true, text: 'µg/m³' } },
        },
      },
    });
  }
}

function renderNow(best) {
  const c = best.current;
  const [desc, icon] = wmo(c.weather_code);
  $('#now-place').textContent = `${place.name}${place.admin1 ? ' · ' + place.admin1 : ''}`;
  $('#now-icon').textContent = icon;
  $('#now-temp').textContent = Math.round(c.temperature_2m);
  $('#now-desc').textContent = desc;
  $('#now-feels').textContent = `${Math.round(c.apparent_temperature)} °C`;
  $('#now-rh').textContent = `${c.relative_humidity_2m} %`;
  $('#now-wind').textContent = `${Math.round(c.wind_speed_10m)} km/h ${compass(c.wind_direction_10m)}`;
  $('#now-pres').textContent = `${Math.round(c.pressure_msl)} hPa`;
  document.title = `${Math.round(c.temperature_2m)}°C ${place.name} — Sinóptica`;
}

// ── Constructores de gráficos (página y modal comparten) ───────

function chartTheme() {
  Chart.defaults.font.family = getComputedStyle(document.body).getPropertyValue('--font-mono');
  Chart.defaults.font.size = 10.5;
  Chart.defaults.color = css('--ink-soft');
  return { ink: css('--ink'), grid: css('--grid-line'), band: css('--band'),
           accent: css('--accent'), accent2: css('--accent2') };
}

function ensembleSeries(ens, times) {
  if (!ens || !ens.hourly) return null;
  const h = ens.hourly;
  const members = Object.keys(h).filter((k) => k.startsWith('temperature_2m'));
  if (members.length < 10) return null;
  const idx0 = h.time.indexOf(times[0]);
  if (idx0 < 0) return null;
  const p10 = [], p50 = [], p90 = [];
  for (let i = 0; i < times.length; i++) {
    const vals = members.map((m) => h[m][idx0 + i]).filter((v) => v != null).sort((a, b) => a - b);
    if (vals.length < 10) { p10.push(null); p50.push(null); p90.push(null); continue; }
    p10.push(percentile(vals, 0.1));
    p50.push(percentile(vals, 0.5));
    p90.push(percentile(vals, 0.9));
  }
  return { p10, p50, p90, n: members.length };
}

function buildTempChart(canvasId, labels, { ensS, modelSeries, bestSeries }) {
  const th = chartTheme();
  const colors = modelColors();
  const ds = [];
  if (ensS) {
    ds.push(
      { label: 'p90', data: ensS.p90, borderWidth: 0, pointRadius: 0, fill: false, tension: 0.35 },
      { label: `banda 10–90 % (${ensS.n} miembros)`, data: ensS.p10, borderWidth: 0, pointRadius: 0,
        fill: '-1', backgroundColor: th.band, tension: 0.35 },
      { label: 'mediana ensamble', data: ensS.p50, borderColor: th.ink, borderDash: [5, 4],
        borderWidth: 1.6, pointRadius: 0, fill: false, tension: 0.35 },
    );
  }
  (modelSeries || []).forEach((s, i) => {
    ds.push({ label: s.name, data: s.data, borderColor: colors[s.colorIdx ?? i],
              borderWidth: 1.3, pointRadius: 0, fill: false, tension: 0.35 });
  });
  if (bestSeries) {
    ds.push({ label: 'síntesis', data: bestSeries, borderColor: th.accent,
              borderWidth: 2, pointRadius: 0, fill: false, tension: 0.35 });
  }
  destroyChart(canvasId);
  charts[canvasId] = new Chart($(`#${canvasId}`), {
    type: 'line',
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 14, boxHeight: 2, filter: (it) => it.text !== 'p90' } },
        tooltip: {
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${r1(ctx.parsed.y)} °C` },
          filter: (it) => it.dataset.label !== 'p90',
        },
      },
      scales: {
        x: { grid: { color: th.grid }, ticks: { maxTicksLimit: 9, maxRotation: 0 } },
        y: { grid: { color: th.grid }, ticks: { callback: (v) => `${v}°` } },
      },
    },
  });
}

function buildPrecipChart(canvasId, labels, mm, prob) {
  const th = chartTheme();
  const ds = [{ type: 'bar', label: 'mm/h', data: mm, backgroundColor: th.accent2, yAxisID: 'y' }];
  if (prob) {
    ds.push({ type: 'line', label: 'probabilidad %', data: prob, borderColor: th.accent,
              borderWidth: 1.4, pointRadius: 0, borderDash: [4, 3], yAxisID: 'y1', tension: 0.3 });
  }
  destroyChart(canvasId);
  charts[canvasId] = new Chart($(`#${canvasId}`), {
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } },
      scales: {
        x: { grid: { color: th.grid }, ticks: { maxTicksLimit: 9, maxRotation: 0 } },
        y: { grid: { color: th.grid }, beginAtZero: true, title: { display: true, text: 'mm/h' } },
        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false },
              ticks: { callback: (v) => `${v}%` } },
      },
    },
  });
}

function renderCharts(best, multi, ens) {
  const h = multi.hourly;
  const nowIso = best.current.time.slice(0, 13);
  let start = h.time.findIndex((t) => t.slice(0, 13) === nowIso);
  if (start < 0) start = 0;
  const window = Math.min(48, h.time.length - start);
  const times = h.time.slice(start, start + window);
  const labels = times.map((t) => {
    const hour = t.slice(11, 13);
    return hour === '00' ? `${weekday(t.slice(0, 10))} ${hour}h` : `${hour}h`;
  });

  buildTempChart('chart-temp', labels, {
    ensS: ensembleSeries(ens, times),
    modelSeries: MODELS.map((m, i) => {
      const arr = h[`temperature_2m_${m.id}`];
      return arr ? { name: m.name, data: arr.slice(start, start + window), colorIdx: i } : null;
    }).filter(Boolean),
  });

  const hb = best.hourly;
  let bStart = hb.time.findIndex((t) => t.slice(0, 13) === nowIso);
  if (bStart < 0) bStart = 0;
  buildPrecipChart('chart-precip', labels,
    hb.precipitation.slice(bStart, bStart + window),
    hb.precipitation_probability ? hb.precipitation_probability.slice(bStart, bStart + window) : null);
}

// ── Franja diaria + detalle por día ────────────────────────────

function renderDaily(best) {
  const d = best.daily;
  const ol = $('#daily');
  ol.innerHTML = '';
  d.time.forEach((iso, i) => {
    const [desc, icon] = wmo(d.weather_code[i]);
    const li = document.createElement('li');
    li.className = 'day';
    li.title = `${desc} — toca para el detalle hora a hora`;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const name = i === 0 ? 'hoy' : i === 1 ? 'mañana' : weekday(iso);
    const pp = d.precipitation_sum[i];
    const prob = d.precipitation_probability_max[i];
    li.innerHTML = `
      <span class="day-name">${name}</span>
      <span class="day-icon" aria-hidden="true">${icon}</span>
      <span class="day-max">${Math.round(d.temperature_2m_max[i])}°</span>
      <span class="day-min">${Math.round(d.temperature_2m_min[i])}°</span>
      <span class="day-pp">${pp >= 0.1 ? `${r1(pp)} mm · ` : ''}${prob != null ? prob + ' %' : ''}</span>`;
    li.addEventListener('click', () => openDay(i));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDay(i); }
    });
    ol.appendChild(li);
  });
}

function openDay(i) {
  if (!lastData) return;
  const { best, multi, ens } = lastData;
  const d = best.daily;
  const iso = d.time[i];
  const [desc, icon] = wmo(d.weather_code[i]);

  const fecha = `${weekday(iso, true)} ${Number(iso.slice(8, 10))}`;
  $('#day-dialog-title').textContent =
    `${icon} ${i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : fecha} · ${place.name}`;
  $('#day-dialog-sub').textContent =
    `${desc} · máxima ${Math.round(d.temperature_2m_max[i])}° · mínima ${Math.round(d.temperature_2m_min[i])}°`;

  // estadísticas del día (desde best_match)
  const hb = best.hourly;
  const idxDay = hb.time.map((t, j) => [t, j]).filter(([t]) => t.slice(0, 10) === iso).map(([, j]) => j);
  const windMax = Math.max(...idxDay.map((j) => hb.wind_speed_10m[j] ?? 0));
  const rhMean = idxDay.length
    ? Math.round(idxDay.reduce((a, j) => a + (hb.relative_humidity_2m[j] ?? 0), 0) / idxDay.length) : null;
  const stats = [
    ['☀️ UV máx', d.uv_index_max?.[i] != null ? r1(d.uv_index_max[i]) : '—'],
    ['🌅 Sale el sol', d.sunrise?.[i] ? d.sunrise[i].slice(11, 16) : '—'],
    ['🌇 Se pone', d.sunset?.[i] ? d.sunset[i].slice(11, 16) : '—'],
    ['💨 Viento máx', `${Math.round(windMax)} km/h`],
    ['💧 Humedad prom.', rhMean != null ? `${rhMean} %` : '—'],
    ['🌧️ Lluvia total', `${r1(d.precipitation_sum[i]) ?? 0} mm`],
  ];
  const ul = $('#day-stats');
  ul.innerHTML = '';
  stats.forEach(([k, v]) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${k}</span><strong>${v}</strong>`;
    ul.appendChild(li);
  });

  const labels = idxDay.map((j) => hb.time[j].slice(11, 13) + 'h');

  // multi-modelo y ensamble cubren 3 días; más allá, solo síntesis
  const hm = multi.hourly;
  const idxMulti = hm.time.map((t, j) => [t, j]).filter(([t]) => t.slice(0, 10) === iso).map(([, j]) => j);
  const timesDay = idxMulti.map((j) => hm.time[j]);
  const modelSeries = idxMulti.length ? MODELS.map((m, k) => {
    const arr = hm[`temperature_2m_${m.id}`];
    return arr ? { name: m.name, data: idxMulti.map((j) => arr[j]), colorIdx: k } : null;
  }).filter(Boolean) : [];

  buildTempChart('chart-day-temp', labels, {
    ensS: timesDay.length ? ensembleSeries(ens, timesDay) : null,
    modelSeries,
    bestSeries: idxDay.map((j) => hb.temperature_2m[j]),
  });
  buildPrecipChart('chart-day-precip', labels,
    idxDay.map((j) => hb.precipitation[j]),
    hb.precipitation_probability ? idxDay.map((j) => hb.precipitation_probability[j]) : null);

  $('#day-dialog-note').textContent = idxMulti.length
    ? 'Líneas de colores: los 5 modelos. Línea gruesa: síntesis best-match. Si se separan, la atmósfera está difícil de pronosticar.'
    : 'Para días más allá de 72 h mostramos solo la síntesis: la dispersión entre modelos crece y el detalle hora a hora pierde precisión — es el límite físico del caos atmosférico, no un defecto.';

  $('#day-dialog').showModal();
}

// ── Tabla de modelos ───────────────────────────────────────────

function renderModelTable(multi) {
  const h = multi.hourly;
  // mañana = segundo día presente en la serie
  const day0 = h.time[0].slice(0, 10);
  const dayTomorrow = h.time.find((t) => t.slice(0, 10) !== day0)?.slice(0, 10);
  if (!dayTomorrow) return;

  const idx = h.time.map((t, i) => [t, i]).filter(([t]) => t.slice(0, 10) === dayTomorrow).map(([, i]) => i);
  const tbody = $('#model-table tbody');
  const tfoot = $('#model-table tfoot');
  tbody.innerHTML = '';
  tfoot.innerHTML = '';

  const colors = modelColors();
  const rows = [];
  MODELS.forEach((m, i) => {
    const temps = h[`temperature_2m_${m.id}`];
    const precs = h[`precipitation_${m.id}`];
    if (!temps) return;
    const dayT = idx.map((j) => temps[j]).filter((v) => v != null);
    const dayP = idx.map((j) => (precs ? precs[j] : null)).filter((v) => v != null);
    if (!dayT.length) return;
    const row = {
      name: m.name, org: m.org, color: colors[i],
      max: Math.max(...dayT), min: Math.min(...dayT),
      pp: dayP.length ? dayP.reduce((a, b) => a + b, 0) : null,
    };
    rows.push(row);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="m-name">${row.name}</td>
      <td class="m-org">${row.org}</td>
      <td>${r1(row.max)} °C</td>
      <td>${r1(row.min)} °C</td>
      <td>${row.pp == null ? '—' : r1(row.pp) + ' mm'}</td>`;
    tr.firstElementChild.style.borderLeft = `3px solid ${row.color}`;
    tbody.appendChild(tr);
  });

  if (rows.length > 1) {
    const spread = (sel) => r1(Math.max(...rows.map(sel)) - Math.min(...rows.map(sel)));
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td colspan="2">Dispersión entre modelos</td>
      <td>Δ ${spread((r) => r.max)} °C</td>
      <td>Δ ${spread((r) => r.min)} °C</td>
      <td>Δ ${spread((r) => r.pp ?? 0)} mm</td>`;
    tfoot.appendChild(tr);
  }
}

// ── Verificación: ¿cuánto acierta cada modelo? ─────────────────

async function loadVerif() {
  try {
    const res = await fetch('verificacion.json', { cache: 'no-store' });
    if (!res.ok) return;
    verifData = await res.json();
    renderVerif();
  } catch (_) { /* sin archivo aún */ }
}

function renderVerif() {
  const list = $('#verif-list');
  const caveat = $('#verif-caveat');
  if (!verifData || !list) return;
  list.innerHTML = '';

  const entries = MODELS.map((m, i) => {
    const b = verifData.models?.[m.id]?.['temperature_2m']?.[verifBucket];
    return b ? { ...m, ...b, colorIdx: i } : { ...m, mae: null, colorIdx: i };
  });
  const withData = entries.filter((e) => e.mae != null).sort((a, b) => a.mae - b.mae);
  const totalN = withData.reduce((a, e) => a + e.n, 0);

  marcarTabsVerif();

  if (!withData.length) {
    caveat.hidden = false;
    const dias = Math.round(Number(verifBucket) / 24);
    caveat.textContent = `Todavía no se puede medir el acierto a ${dias} día${dias > 1 ? 's' : ''}: ` +
      `un pronóstico a ${verifBucket} h solo se compara con lo observado ${verifBucket} h después. ` +
      `El archivo empezó el 9 de junio de 2026, así que este plazo se habilita ${fechaDisponible(verifBucket)}.`;
    return;
  }

  caveat.hidden = totalN >= 500;
  if (totalN < 500) {
    caveat.textContent = `⚠ Cifras preliminares: recién ${totalN} pares evaluados (el archivo partió el 9 de junio de 2026). Con ~2 semanas de datos los números se estabilizan; mientras tanto, tómalos como tendencia.`;
  }

  const colors = modelColors();
  const maxMae = Math.max(...withData.map((e) => e.mae), 0.1);
  withData.forEach((e, rank) => {
    const li = document.createElement('li');
    li.className = 'verif-row';
    const biasTxt = Math.abs(e.bias) < 0.15 ? 'sin sesgo claro'
      : e.bias > 0 ? `tiende +${r1(e.bias)}° cálido` : `tiende ${r1(e.bias)}° frío`;
    li.innerHTML = `
      <span class="verif-rank">${rank === 0 ? '★' : rank + 1}</span>
      <span class="verif-name">${e.name}<small>${e.org}</small></span>
      <span class="verif-bar-wrap"><span class="verif-bar"></span></span>
      <span class="verif-mae">${e.mae.toFixed(2)} °C</span>
      <span class="verif-bias">${biasTxt} · n=${e.n}</span>`;
    const bar = li.querySelector('.verif-bar');
    bar.style.width = `${Math.max(6, (e.mae / maxMae) * 100)}%`;
    bar.style.backgroundColor = colors[e.colorIdx];
    list.appendChild(li);
  });
}

const ARCHIVE_START = new Date('2026-06-09T22:00:00Z');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fechaDisponible(bucketHoras) {
  const d = new Date(ARCHIVE_START.getTime() + Number(bucketHoras) * 3600 * 1000);
  return `alrededor del ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
}

function marcarTabsVerif() {
  document.querySelectorAll('.verif-tab').forEach((btn) => {
    const hayDatos = verifData && Object.values(verifData.models || {})
      .some((m) => m['temperature_2m'] && m['temperature_2m'][btn.dataset.bucket]);
    btn.classList.toggle('sin-datos', !hayDatos);
    btn.title = hayDatos ? '' : `Se habilita ${fechaDisponible(btn.dataset.bucket)}`;
  });
}

function setupVerifTabs() {
  document.querySelectorAll('.verif-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      verifBucket = btn.dataset.bucket;
      document.querySelectorAll('.verif-tab').forEach((b) =>
        b.setAttribute('aria-selected', String(b === btn)));
      renderVerif();
    });
  });
}

// ── Mapa de observaciones en vivo ──────────────────────────────

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const TILES_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" rel="noopener">CARTO</a>';

async function loadMapa() {
  try {
    const res = await fetch('estaciones.json', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    estacionesData = await res.json();
  } catch (_) {
    $('#map').closest('.panel').hidden = true;
    return;
  }
  renderMapa();
}

function ensureMap() {
  if (map || typeof L === 'undefined' || !estacionesData) return map;
  // Interacción completa: arrastrar, pinch-zoom y botones +/− en todos los
  // dispositivos (scrollWheelZoom off para no capturar el scroll de rueda).
  map = L.map('map', {
    scrollWheelZoom: false,
    zoomSnap: 0.5,
    zoomControl: true,
    tap: true,
  });
  const bounds = L.latLngBounds(estacionesData.estaciones.map((e) => [e.lat, e.lon]));
  map.fitBounds(bounds.pad(0.12), { maxZoom: 9 });
  // Leaflet calcula mal los tiles si el contenedor aún estaba animándose al
  // crearse (queda fondo sin tiles); recalcular asegura que se llenen.
  setTimeout(() => map.invalidateSize(), 200);
  return map;
}

function popupRows(pairs) {
  const dl = document.createElement('dl');
  pairs.forEach(([label, value]) => {
    if (value == null) return;
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    dl.append(dt, dd);
  });
  return dl;
}

function renderMapa() {
  if (!ensureMap()) return;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILES[isDark() ? 'dark' : 'light'], {
    attribution: TILES_ATTR, maxZoom: 13, subdomains: 'abcd',
  }).addTo(map);
  map.eachLayer((layer) => { if (layer instanceof L.Marker) map.removeLayer(layer); });

  const aire = mapMode === 'aire';
  document.getElementById('map-legend-temp').hidden = aire;
  document.getElementById('map-legend-aire').hidden = !aire;
  document.getElementById('map-note-temp').hidden = aire;
  document.getElementById('map-note-aire').hidden = !aire;
  document.querySelectorAll('.map-mode').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.mode === mapMode)));

  if (aire) paintAire(); else paintTemp();
  map.invalidateSize();   // por si el panel cambió de tamaño desde el último render
}

function paintTemp() {
  const est = estacionesData.estaciones.filter((e) => e.obs && e.obs.temperature_2m != null);
  est.forEach((e) => {
    const t = e.obs.temperature_2m;
    const icon = L.divIcon({
      className: 'stn-icon',
      html: `<span class="stn-label ${tempClass(t)}">${Math.round(t)}°</span>`,
      iconSize: [44, 26], iconAnchor: [22, 13],
    });
    const marker = L.marker([e.lat, e.lon], { icon, title: e.nombre }).addTo(map);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong'); h.textContent = e.nombre; box.appendChild(h);
    const meta = document.createElement('small');
    meta.textContent = `${e.fuente === 'metar' ? 'Aeropuerto · red OMM' : 'EMA · Dirección Meteorológica de Chile'} · ${horaLocal(e.obs_time)} h`;
    box.appendChild(meta);
    box.appendChild(popupRows(Object.entries(OBS_LABELS).map(([key, [label, unit]]) =>
      e.obs[key] == null ? [label, null]
        : [label, key === 'wind_direction_10m'
            ? `${Math.round(e.obs[key])}° (${compass(e.obs[key])})`
            : `${r1(e.obs[key])} ${unit}`])));
    marker.bindPopup(box, { maxWidth: 280 });
  });
  $('#map-meta').textContent = estacionesData.updated
    ? `${est.length} estaciones · ${horaLocal(estacionesData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${est.length} estaciones`;
}

function paintAire() {
  const est = aireStations.filter((e) => e.icap != null);
  if (!est.length) { $('#map-meta').textContent = 'sin datos SINCA'; return; }
  est.forEach((e) => {
    const nivel = icapNivel(e.icap);
    const icon = L.divIcon({
      className: 'stn-icon',
      html: `<span class="stn-label ${nivel.cls}">${e.icap}</span>`,
      iconSize: [40, 26], iconAnchor: [20, 13],
    });
    const marker = L.marker([e.lat, e.lon], { icon, title: e.nombre }).addTo(map);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong'); h.textContent = e.nombre; box.appendChild(h);
    const meta = document.createElement('small');
    meta.textContent = `${e.comuna || ''} · SINCA · ICAP ${e.icap} (${nivel.n})`;
    box.appendChild(meta);
    box.appendChild(popupRows([
      ['MP2,5', e.pm2_5 != null ? `${Math.round(e.pm2_5)} µg/m³` : null],
      ['MP10', e.pm10 != null ? `${Math.round(e.pm10)} µg/m³` : null],
    ]));
    marker.bindPopup(box, { maxWidth: 260 });
  });
  $('#map-meta').textContent = `${est.length} estaciones SINCA · MP2,5`;
}

function setupMapModes() {
  document.querySelectorAll('.map-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (mapMode === btn.dataset.mode) return;
      mapMode = btn.dataset.mode;
      renderMapa();
    });
  });
}

// ── Ubicaciones: chips y búsqueda ──────────────────────────────

function setPlace(p) {
  place = p;
  try { localStorage.setItem('sinoptica.place', JSON.stringify(p)); } catch (_) { /* opcional */ }
  loadAll().catch(showError);
}

function renderChips() {
  const wrap = $('#chips');
  wrap.innerHTML = '';
  PLACES.forEach((group) => {
    const tag = document.createElement('span');
    tag.className = 'chip-region';
    tag.textContent = group.region;
    wrap.appendChild(tag);
    group.items.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = p.name;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(p.name === place.name));
      b.addEventListener('click', () => setPlace(p));
      wrap.appendChild(b);
    });
  });
}

function setupSearch() {
  const input = $('#search');
  const list = $('#search-results');
  let timer = null;
  let items = [];
  let sel = -1;

  const hide = () => { list.hidden = true; sel = -1; };

  const show = (results) => {
    items = results;
    list.innerHTML = '';
    if (!results.length) { hide(); return; }
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.append(`${r.name} `);
      const small = document.createElement('small');
      small.textContent = [r.admin2, r.admin1].filter(Boolean).join(' · ');
      li.appendChild(small);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      list.appendChild(li);
    });
    list.hidden = false;
  };

  const pick = (i) => {
    const r = items[i];
    if (!r) return;
    input.value = '';
    hide();
    setPlace({ name: r.name, admin1: r.admin1, lat: r.latitude, lon: r.longitude });
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(async () => {
      try {
        const data = await fetchJSON(`${API_GEO}?name=${encodeURIComponent(q)}&count=6&language=es&format=json`);
        show((data.results || []).filter((r) => r.country_code === 'CL'));
      } catch (_) { hide(); }
    }, 280);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const lis = [...list.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = e.key === 'ArrowDown' ? Math.min(sel + 1, lis.length - 1) : Math.max(sel - 1, 0);
      lis.forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));
    } else if (e.key === 'Enter' && sel >= 0) {
      e.preventDefault();
      pick(sel);
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  input.addEventListener('blur', () => setTimeout(hide, 150));
}

// ── Diálogos (info + día) ──────────────────────────────────────

function setupDialogs() {
  document.querySelectorAll('.info-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const info = INFO[btn.dataset.info];
      if (!info) return;
      $('#info-dialog-title').textContent = info.title;
      $('#info-dialog-body').innerHTML = info.html; // contenido estático propio
      $('#info-dialog').showModal();
    });
  });
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.querySelector('[data-close]')?.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => {
      // clic fuera del contenido = cerrar
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    dlg.addEventListener('close', () => {
      if (dlg.id === 'day-dialog') { destroyChart('chart-day-temp'); destroyChart('chart-day-precip'); }
    });
  });
}

// ── Estado del archivo científico ──────────────────────────────

async function loadArchiveStatus() {
  try {
    const res = await fetch('status.json', { cache: 'no-store' });
    if (!res.ok) return;
    const s = await res.json();
    const el = $('#archive-status');
    el.textContent = `archivo científico: ${s.forecast_rows.toLocaleString('es-CL')} pronósticos · ` +
      `${s.obs_rows.toLocaleString('es-CL')} observaciones · ${s.stations} estaciones · desde ${s.since} · ` +
      `última ingesta ${s.last_run}`;
    el.hidden = false;
  } catch (_) { /* aún sin archivo: silencio */ }
}

// ── Errores y arranque ─────────────────────────────────────────

function showError(err) {
  const el = $('#error');
  el.textContent = `No se pudieron cargar los datos (${err.message}). Reintenta en unos segundos.`;
  el.hidden = false;
  $('#app').dataset.state = 'error';
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  render();
  renderVerif();
  renderMapa();
});

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

async function loadAireSinca() {
  try {
    const res = await fetch('aire.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    aireStations = data.estaciones || [];
    if (lastData) renderAire(lastData.aire);   // re-render con dato oficial
    if (mapMode === 'aire') renderMapa();       // repinta el mapa de aire
  } catch (_) { /* sin SINCA: el panel usa el pronóstico CAMS */ }
}

setupSearch();
setupDialogs();
setupVerifTabs();
setupMapModes();
renderChips();
loadAll().catch(showError);
loadArchiveStatus();
loadVerif();
loadMapa();
loadAireSinca();
