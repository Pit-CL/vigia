/* Sinóptica — pronóstico multi-modelo para Chile central.
   Datos: Open-Meteo (CC BY 4.0). Sin claves, sin tracking. */
'use strict';

// ── Configuración ──────────────────────────────────────────────

const API = 'https://api.open-meteo.com/v1/forecast';
const API_ENS = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const API_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const TZ = 'America/Santiago';

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

// ── Estado ─────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
let charts = { temp: null, precip: null };
let lastData = null; // para redibujar al cambiar de tema

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
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url).hostname}`);
    return res.json();
  });
}

function weekdayShort(iso) {
  // iso "YYYY-MM-DD" → día de semana sin trampas de timezone (mediodía local)
  const [y, m, d] = iso.split('-').map(Number);
  return DAYS[new Date(y, m - 1, d, 12).getDay()];
}

function percentile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── Carga de datos ─────────────────────────────────────────────

function urlBase(extra) {
  const q = new URLSearchParams({
    latitude: place.lat.toFixed(4),
    longitude: place.lon.toFixed(4),
    timezone: TZ,
    ...extra,
  });
  return q.toString();
}

async function loadAll() {
  const app = $('#app');
  app.dataset.state = 'loading';
  $('#error').hidden = true;

  const qBest = urlBase({
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,precipitation',
    hourly: 'precipitation,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
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

  // El ensamble es opcional: si falla, la app sigue sin banda.
  const [best, multi, ens] = await Promise.all([
    fetchJSON(`${API}?${qBest}`),
    fetchJSON(`${API}?${qModels}`),
    fetchJSON(`${API_ENS}?${qEns}`).catch(() => null),
  ]);

  lastData = { best, multi, ens };
  render();
  app.dataset.state = 'ready';
}

// ── Render ─────────────────────────────────────────────────────

function render() {
  if (!lastData) return;
  renderNow(lastData.best);
  renderCharts(lastData.best, lastData.multi, lastData.ens);
  renderDaily(lastData.best);
  renderModelTable(lastData.multi);
  renderChips();
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

function renderCharts(best, multi, ens) {
  const h = multi.hourly;
  // ventana: desde la hora actual, 48 h
  const nowIso = best.current.time.slice(0, 13); // "YYYY-MM-DDTHH"
  let start = h.time.findIndex((t) => t.slice(0, 13) === nowIso);
  if (start < 0) start = 0;
  const window = Math.min(48, h.time.length - start);
  const times = h.time.slice(start, start + window);

  const labels = times.map((t) => {
    const hour = t.slice(11, 13);
    return hour === '00' ? `${weekdayShort(t.slice(0, 10))} ${hour}h` : `${hour}h`;
  });

  const colors = modelColors();
  const ink = css('--ink');
  const inkSoft = css('--ink-soft');
  const grid = css('--grid-line');
  const band = css('--band');

  Chart.defaults.font.family = getComputedStyle(document.body).getPropertyValue('--font-mono');
  Chart.defaults.font.size = 10.5;
  Chart.defaults.color = inkSoft;

  // ── Temperatura: banda de ensamble + modelos ──
  const dsTemp = [];
  const ensS = ensembleSeries(ens, times);
  if (ensS) {
    dsTemp.push(
      { label: 'p90', data: ensS.p90, borderWidth: 0, pointRadius: 0, fill: false, tension: 0.35 },
      { label: `banda 10–90 % (${ensS.n} miembros)`, data: ensS.p10, borderWidth: 0, pointRadius: 0,
        fill: '-1', backgroundColor: band, tension: 0.35 },
      { label: 'mediana ensamble', data: ensS.p50, borderColor: ink, borderDash: [5, 4],
        borderWidth: 1.6, pointRadius: 0, fill: false, tension: 0.35 },
    );
  }
  MODELS.forEach((m, i) => {
    const arr = h[`temperature_2m_${m.id}`];
    if (!arr) return;
    dsTemp.push({
      label: m.name, data: arr.slice(start, start + window),
      borderColor: colors[i], borderWidth: 1.3, pointRadius: 0, fill: false, tension: 0.35,
    });
  });

  charts.temp?.destroy();
  charts.temp = new Chart($('#chart-temp'), {
    type: 'line',
    data: { labels, datasets: dsTemp },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            boxWidth: 14, boxHeight: 2,
            filter: (item) => !['p90'].includes(item.text),
          },
        },
        tooltip: {
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${r1(ctx.parsed.y)} °C` },
          filter: (item) => item.dataset.label !== 'p90',
        },
      },
      scales: {
        x: { grid: { color: grid }, ticks: { maxTicksLimit: 9, maxRotation: 0 } },
        y: { grid: { color: grid }, ticks: { callback: (v) => `${v}°` } },
      },
    },
  });

  // ── Precipitación: mm best_match + probabilidad ──
  const hb = best.hourly;
  let bStart = hb.time.findIndex((t) => t.slice(0, 13) === nowIso);
  if (bStart < 0) bStart = 0;
  const mm = hb.precipitation.slice(bStart, bStart + window);
  const prob = hb.precipitation_probability
    ? hb.precipitation_probability.slice(bStart, bStart + window) : null;

  const dsP = [{
    type: 'bar', label: 'mm/h', data: mm,
    backgroundColor: css('--accent2'), yAxisID: 'y',
  }];
  if (prob) {
    dsP.push({
      type: 'line', label: 'probabilidad %', data: prob,
      borderColor: css('--accent'), borderWidth: 1.4, pointRadius: 0,
      borderDash: [4, 3], yAxisID: 'y1', tension: 0.3,
    });
  }

  charts.precip?.destroy();
  charts.precip = new Chart($('#chart-precip'), {
    data: { labels, datasets: dsP },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } },
      scales: {
        x: { grid: { color: grid }, ticks: { maxTicksLimit: 9, maxRotation: 0 } },
        y: { grid: { color: grid }, beginAtZero: true, title: { display: true, text: 'mm/h' } },
        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false },
              ticks: { callback: (v) => `${v}%` } },
      },
    },
  });
}

function renderDaily(best) {
  const d = best.daily;
  const ol = $('#daily');
  ol.innerHTML = '';
  d.time.forEach((iso, i) => {
    const [desc, icon] = wmo(d.weather_code[i]);
    const li = document.createElement('li');
    li.className = 'day';
    li.title = desc;
    const name = i === 0 ? 'hoy' : i === 1 ? 'mañana' : weekdayShort(iso);
    const pp = d.precipitation_sum[i];
    const prob = d.precipitation_probability_max[i];
    li.innerHTML = `
      <span class="day-name">${name}</span>
      <span class="day-icon" aria-hidden="true">${icon}</span>
      <span class="day-max">${Math.round(d.temperature_2m_max[i])}°</span>
      <span class="day-min">${Math.round(d.temperature_2m_min[i])}°</span>
      <span class="day-pp">${pp >= 0.1 ? `${r1(pp)} mm · ` : ''}${prob != null ? prob + ' %' : ''}</span>`;
    ol.appendChild(li);
  });
}

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

// ── Estado del archivo científico (fase 1) ─────────────────────

async function loadArchiveStatus() {
  try {
    const res = await fetch('status.json', { cache: 'no-store' });
    if (!res.ok) return;
    const s = await res.json();
    const el = $('#archive-status');
    el.textContent = `archivo científico: ${s.forecast_rows.toLocaleString('es-CL')} pronósticos · ` +
      `${s.obs_rows.toLocaleString('es-CL')} observaciones · desde ${s.since} · ` +
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

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

setupSearch();
renderChips();
loadAll().catch(showError);
loadArchiveStatus();
