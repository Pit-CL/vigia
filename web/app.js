/* Vigía — pronóstico multi-modelo para todo Chile (Arica a la Antártica).
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
  { id: 'ecmwf_aifs025_single', name: 'AIFS',   org: 'ECMWF · IA' },
];

const MODEL_COLORS = {
  light: ['#2456c9', '#0e9888', '#b07d10', '#8b4ac2', '#c8451f', '#c2317e'],
  dark:  ['#6f9bff', '#3fc4b1', '#d9a83a', '#b685e0', '#ff7a4d', '#ff6fb0'],
};

const PLACES = [
  { region: 'Chile', items: [
    { name: 'Arica',        lat: -18.478, lon: -70.321 },
    { name: 'Iquique',      lat: -20.214, lon: -70.152 },
    { name: 'Antofagasta',  lat: -23.650, lon: -70.400 },
    { name: 'Calama',       lat: -22.456, lon: -68.924 },
    { name: 'Copiapó',      lat: -27.366, lon: -70.332 },
    { name: 'La Serena',    lat: -29.904, lon: -71.249 },
    { name: 'Valparaíso',   lat: -33.046, lon: -71.620 },
    { name: 'Viña del Mar', lat: -33.024, lon: -71.552 },
    { name: 'Santiago',     lat: -33.437, lon: -70.650 },
    { name: 'Rancagua',     lat: -34.171, lon: -70.744 },
    { name: 'Talca',        lat: -35.427, lon: -71.655 },
    { name: 'Chillán',      lat: -36.606, lon: -72.104 },
    { name: 'Concepción',   lat: -36.827, lon: -73.050 },
    { name: 'Temuco',       lat: -38.736, lon: -72.590 },
    { name: 'Valdivia',     lat: -39.814, lon: -73.246 },
    { name: 'Puerto Montt', lat: -41.469, lon: -72.943 },
    { name: 'Coyhaique',    lat: -45.571, lon: -72.068 },
    { name: 'Punta Arenas', lat: -53.163, lon: -70.917 },
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

// Explicación en lenguaje claro por texto del evento SENAPRED (primer match gana).
// Los específicos van antes que "evento meteorológico", que es el genérico.
const EXPLICA_EVENTO = [
  [/zoosanitario/i, 'Vigilancia del SAG por una enfermedad animal (por ejemplo influenza aviar) detectada en la zona. No es un riesgo directo para las personas: evita tocar aves o animales muertos o enfermos y repórtalos al SAG (2 2345 1100).'],
  [/alteraci[oó]n sanitaria/i, 'Situación sanitaria bajo vigilancia de la autoridad (agua, plagas o brotes). Sigue las indicaciones de la SEREMI de Salud de tu región.'],
  [/crecida/i, 'Ríos o esteros de la zona vienen creciendo por lluvia o deshielo. No cruces cauces ni te acerques a las riberas; si vives cerca de un río, prepara una salida.'],
  [/remoci[oó]n|aluvi[oó]n|deslizamiento/i, 'Riesgo de deslizamientos de tierra o aluviones por lluvia en laderas. Aléjate de quebradas y cauces; si escuchas ruido de piedras o agua creciendo, sube a terreno firme y alto.'],
  [/altas temperaturas|ola de calor/i, 'Calor inusual para la zona. Hidrátate, evita el sol del mediodía y vigila a personas mayores, niños y mascotas. Sube el riesgo de incendios: evita cualquier fuego.'],
  [/helada/i, 'Temperaturas bajo cero esperadas. Protege cañerías, cultivos, mascotas y personas en situación de calle (llama al 800 104 777 — Código Azul).'],
  [/viento/i, 'Viento fuerte esperado. Asegura techumbres, toldos y objetos sueltos; precaución al conducir vehículos altos y aléjate de árboles y tendido eléctrico.'],
  [/volc[aá]n/i, 'El volcán muestra actividad sobre lo normal y está bajo vigilancia reforzada de SERNAGEOMIN. Infórmate de tus vías de evacuación (capa 🚑 del mapa) y respeta los perímetros.'],
  [/incendio|forestal/i, 'Condiciones favorables para incendios forestales o fuego activo en la zona. No enciendas fuego, reporta humo al 130 (CONAF) y prepárate para evacuar temprano si estás cerca.'],
  [/meteorol[oó]gico/i, 'Sistema frontal u otro evento del tiempo significativo para la zona (lluvia, viento o nieve). Revisa el pronóstico de tu comuna aquí mismo y evita desplazamientos innecesarios en lo peor del evento.'],
];
const EXPLICA_EVENTO_DEFAULT = 'Alerta oficial de SENAPRED para la zona. Revisa senapred.cl para el detalle del evento.';

function explicaEvento(evento) {
  const hit = EXPLICA_EVENTO.find(([re]) => re.test(evento || ''));
  return hit ? hit[1] : EXPLICA_EVENTO_DEFAULT;
}

// Explicación en lenguaje claro por nivel de alerta SENAPRED.
const EXPLICA_NIVEL = {
  temprana_preventiva: 'Temprana Preventiva: la autoridad vigila de cerca una amenaza que PODRÍA escalar; no exige acción inmediata de tu parte, solo mantenerte informado.',
  amarilla: 'Amarilla: la amenaza crece y los equipos de emergencia se alistan; ten a mano lo esencial y revisa tus rutas.',
  roja: 'Roja: la amenaza está en desarrollo y puede requerir evacuación u otra acción inmediata; sigue YA las instrucciones oficiales.',
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
<p class="info-fine">Cuando hay una <strong>central de monitoreo cerca</strong> de tu ubicación (≤25 km), este panel muestra su <strong>medición real</strong> —no un pronóstico—: lo indica con "medido en …". Son las mismas estaciones del mapa (aeropuertos de la red OMM y estaciones de la Dirección Meteorológica de Chile). Si no hay ninguna cerca, cae a la estimación interpolada del modelo y lo señala como "estimación de modelo".</p>`,
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
<p>Cada punto es una <strong>estación meteorológica real</strong> midiendo ahora mismo, no un pronóstico: cerca de 150 estaciones que cubren las 16 regiones de Chile, de Arica a la Antártica, más Isla de Pascua y Juan Fernández.</p>
<p><strong>Aeropuertos (METAR).</strong> Observaciones oficiales que los aeródromos publican cada hora a la red mundial de la Organización Meteorológica Mundial, con estándares de aviación.</p>
<p><strong>Estaciones automáticas (EMA) de la Dirección Meteorológica de Chile.</strong> Sensores que reportan minuto a minuto a lo largo de todo el país, de cordillera a costa.</p>
<p><strong>Más capas sobre el mismo mapa.</strong> Además de temperatura y aire puedes activar sismos, incendios, alertas, volcanes y avisos meteorológicos derivados, y —para una emergencia— infraestructura de emergencia y vías de evacuación. Cada capa declara su fuente (u origen, si es propia) justo debajo del mapa.</p>
<p class="info-fine">¿Por qué una estación puede diferir del «ahora» del panel superior? Porque el panel es un modelo interpolado a tu punto exacto y la estación es un sensor físico en SU punto exacto — comparar ambos es justamente cómo medimos la calidad del pronóstico (ver «¿Cuánto acierta cada modelo?»).</p>`,
  },
  ensamble: {
    title: 'La banda de incertidumbre (ensamble)',
    html: `
<p><strong>En simple:</strong> el futuro de la atmósfera no se puede conocer con exactitud, así que el centro europeo ECMWF corre su modelo <strong>51 veces</strong>, cada vez partiendo de condiciones iniciales levemente distintas. La banda muestra dónde cae el 80 % de esos 51 futuros posibles. Banda angosta = los escenarios coinciden, alta confianza. Banda ancha = la atmósfera está «difícil», cualquier número exacto sería una falsa promesa.</p>
<p><strong>La ciencia:</strong> la atmósfera es un sistema caótico — errores diminutos en el estado inicial crecen exponencialmente (el famoso «efecto mariposa» que describió Edward Lorenz en 1963). El pronóstico por ensambles es la respuesta operativa de la meteorología moderna a ese caos: en vez de fingir certeza, se cuantifica la incertidumbre. La línea segmentada es la mediana (la mitad de los escenarios está arriba y la mitad abajo).</p>
<p class="info-fine">Las líneas finas de colores son los 6 modelos <em>deterministas</em> (5 centros mundiales — IFS y AIFS son ambos de ECMWF) — si además de la banda los modelos discrepan entre sí, la incertidumbre es doble.</p>`,
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
<p><strong>Los seis que mostramos:</strong> IFS del centro europeo ECMWF (el de mayor prestigio mundial en verificaciones), GFS de la NOAA estadounidense, ICON del servicio alemán DWD, GEM del canadiense ECCC, ARPEGE de Météo-France y AIFS —el modelo de <strong>inteligencia artificial</strong> del propio ECMWF, que aprendió de décadas de datos en vez de resolver a mano las ecuaciones de la física—.</p>
<p><strong>¿Por qué no dicen lo mismo?</strong> Difieren en la resolución de su grilla, en cómo representan procesos más pequeños que una celda (una nube, una quebrada de la cordillera) y en cómo digieren las observaciones iniciales. Chile es terreno difícil: el salto del Pacífico a los Andes en ~150 km es más angosto que una celda de algunos modelos.</p>
<p class="info-fine">La fila «dispersión» es información valiosa: si los 6 modelos coinciden, puedes confiar; si difieren en 6 °C o en 10 mm de lluvia, la atmósfera está genuinamente impredecible y quien te dé un solo número te está simplificando de más.</p>`,
  },
  verificacion: {
    title: '¿Cómo medimos el acierto?',
    html: `
<p><strong>El método:</strong> guardamos cada pronóstico en el momento en que se emite. Cuando llega la hora pronosticada, lo comparamos con lo que <em>realmente midieron</em> las cerca de 150 estaciones de la red nacional (aeropuertos + DMC). Nadie puede retocar el pronóstico después: queda archivado.</p>
<p>Comparamos <strong>6 modelos</strong>, incluido el modelo de inteligencia artificial de ECMWF (AIFS): la tabla de abajo muestra con datos cuál acierta más en Chile, no cuál promete más.</p>
<p><strong>MAE (error absoluto medio):</strong> el tamaño típico del error, en grados. «MAE 1,5 °C a 1 día» significa que, en promedio, la temperatura pronosticada para el día siguiente difirió 1,5 °C de la observada. Mientras más chico, mejor.</p>
<p><strong>Sesgo:</strong> el error <em>con signo</em>. Un sesgo de +1 °C significa que el modelo tiende a pronosticar más calor del que llega; −1 °C, más frío. Conocer el sesgo de cada modelo en cada lugar es la base para corregirlo — exactamente lo que hará nuestro modelo de calibración local.</p>
<p><strong>Los plazos:</strong> «a 1 día» evalúa pronósticos emitidos 24 h antes; «a 4 días», 96 h antes. El error crece con el plazo — eso también lo puedes ver aquí, transparente.</p>
<p class="info-fine">Ventana móvil: últimos 14 días, todas las estaciones, todas las horas. El número «n» son los pares pronóstico-observación evaluados: con n chico las cifras bailan; con miles, se estabilizan. Este archivo partió el 9 de junio de 2026 y mejora solo con cada hora que pasa.</p>`,
  },
  riesgos: {
    title: '¿De dónde salen estos datos?',
    html: `
<p><strong>Sismos (CSN).</strong> El Centro Sismológico Nacional de la Universidad de Chile es la autoridad oficial en sismología del país: publica cada evento con magnitud, profundidad y ubicación apenas queda procesado. Se complementa con el catálogo de USGS para eventos recientes que el CSN todavía no ha revisado.</p>
<p><strong>Alertas (SENAPRED).</strong> El Servicio Nacional de Prevención y Respuesta ante Desastres declara las alertas oficiales —roja, amarilla o temprana preventiva— por evento meteorológico, aluvión, incendio forestal u otro riesgo, con las comunas exactas bajo alerta.</p>
<p><strong>Volcanes (SERNAGEOMIN).</strong> El Servicio Nacional de Geología y Minería opera la Red Nacional de Vigilancia Volcánica (RNVV) y publica el semáforo técnico de cada volcán activo: verde, amarilla, naranja o roja.</p>
<p><strong>Incendios (NASA FIRMS).</strong> Focos de calor detectados por satélite (sensor VIIRS, 375 m de resolución) en las últimas 48 horas — no todo foco es un incendio confirmado en terreno.</p>
<p><strong>Avisos meteorológicos (Vigía, no oficiales).</strong> A diferencia de las tres fuentes anteriores, estos avisos de viento, helada, lluvia y calor NO vienen de un organismo oficial: los calculamos nosotros aplicando umbrales propios —inspirados en los criterios públicos de la DMC, pero sin relación operativa con ella— a la mediana de nuestro propio pronóstico multi-modelo. Trátalos como una señal de alerta temprana, no como un aviso oficial.</p>
<p class="info-fine">Los sismos no se pueden predecir: mostramos lo ya ocurrido y, tras un sismo mayor, la tasa estadística esperada de réplicas (ley de Omori) — nunca una proyección de cuándo o dónde ocurrirá el próximo.</p>
<p><strong>Los tres niveles de alerta SENAPRED:</strong></p>
<p class="info-fine">${EXPLICA_NIVEL.temprana_preventiva}<br>${EXPLICA_NIVEL.amarilla}<br>${EXPLICA_NIVEL.roja}</p>`,
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
let sismosData = null;   // catálogo sísmico CSN + USGS
let incendiosData = null; // focos de calor VIIRS (NASA FIRMS)
let alertasData = null;   // alertas naturales vigentes (SENAPRED)
let volcanesData = null;  // alerta técnica volcánica (SERNAGEOMIN RNVV)
let avisosData = null;   // avisos meteo derivados del pronóstico propio (NO oficiales)
let emergenciaData = null; // infraestructura de emergencia (SENAPRED), carga lazy
let emergenciaCargando = false;
let tsunamiViasData = null; // vías de evacuación tsunami+volcán (SENAPRED), carga lazy junto con emergenciaData
let tsunamiAreasData = null; // áreas de evacuación ante tsunami (SENAPRED), carga lazy junto con emergenciaData
let biasData = null;     // correcciones de sesgo por estación/modelo/lead
let biasStation = null;  // estación de calibración más cercana a `place` (o null)
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
  return PLACES[0].items.find((p) => p.name === 'Santiago') || PLACES[0].items[0]; // Santiago
}

let place = savedPlace();

// ── Utilidades ─────────────────────────────────────────────────

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const modelColors = () => MODEL_COLORS[isDark() ? 'dark' : 'light'];
const wmo = (code) => WMO[code] || ['—', '·'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
// Normaliza para comparar texto sin tildes ni mayúsculas ("Ñuñoa" ~ "nunoa").
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

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
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
    });
  } catch (_) { return isoUtc; }
}

// Hora relativa compacta para eventos de riesgo ("ahora" / "hace 2 h" / "hace 3 d").
function haceCuanto(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const ms = Date.now() - d.getTime();
  if (ms < 5 * 60000) return 'ahora';
  const horas = ms / 3600000;
  if (horas < 1) return `hace ${Math.round(ms / 60000)} min`;
  if (horas < 24) return `hace ${Math.round(horas)} h`;
  return `hace ${Math.round(horas / 24)} d`;
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

async function loadAll({ silent = false } = {}) {
  const app = $('#app');
  if (!silent) app.dataset.state = 'loading';
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
  if (!silent) app.dataset.state = 'ready';
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

// Fenómeno METAR observado (wxString) → [descripción, ícono], o null.
function wxToDesc(wx) {
  if (!wx) return null;
  const w = wx.toUpperCase();
  if (w.includes('TS')) return ['Tormenta eléctrica', '⛈️'];
  if (w.includes('SN')) return ['Nieve', '🌨️'];
  if (w.includes('RA')) {
    if (w.includes('+')) return ['Lluvia fuerte', '🌧️'];
    if (w.includes('SH')) return ['Chubascos', '🌧️'];
    if (w.includes('-')) return ['Lluvia débil', '🌦️'];
    return ['Lluvia', '🌧️'];
  }
  if (w.includes('DZ')) return ['Llovizna', '🌦️'];
  if (w.includes('FG')) return ['Niebla', '🌫️'];
  if (w.includes('BR')) return ['Neblina', '🌫️'];
  if (w.includes('HZ') || w.includes('FU')) return ['Calima', '🌫️'];
  return null;
}

// Estación de observación más cercana con dato de temperatura reciente.
// Para "Condiciones actuales": preferimos la medición REAL sobre el modelo.
function estacionObsCercana(maxKm) {
  if (!estacionesData) return null;
  let best = null;
  for (const e of estacionesData.estaciones) {
    if (!e.obs || e.obs.temperature_2m == null) continue;
    const d = haversineKm(place.lat, place.lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { ...e, dist: d };
  }
  return best && best.dist <= maxKm ? best : null;
}

// Estación METAR más cercana (<35 km) con fenómeno presente reciente.
function estacionWxCercana() {
  if (!estacionesData) return null;
  let best = null;
  for (const e of estacionesData.estaciones) {
    if (!e.wx) continue;
    const d = haversineKm(place.lat, place.lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { ...e, dist: d };
  }
  return best && best.dist <= 35 ? best : null;
}

// Sensación térmica: wind chill cuando hace frío y hay viento; si no, la temp.
function sensacion(t, vKmh) {
  if (t == null) return null;
  if (t <= 10 && vKmh != null && vKmh > 4.8) {
    const w = Math.pow(vKmh, 0.16);
    return 13.12 + 0.6215 * t - 11.37 * w + 0.3965 * t * w;
  }
  return t;
}

function renderNow(best) {
  const c = best.current;
  // Si hay una central de monitoreo cerca, "Condiciones actuales" son su
  // MEDICIÓN REAL (no el modelo). El modelo solo cuando no hay estación cerca.
  const est = estacionObsCercana(25);
  const o = est ? est.obs : null;
  let [desc, icon] = wmo(c.weather_code);

  // fenómeno: el observado (de la propia estación o de una METAR cercana) manda
  const ew = (est && est.wx) ? est : estacionWxCercana();
  const obsWx = ew ? wxToDesc(ew.wx) : null;
  if (obsWx) { [desc, icon] = obsWx; }

  const temp = o ? o.temperature_2m : c.temperature_2m;
  const rh = o && o.relative_humidity_2m != null ? o.relative_humidity_2m : c.relative_humidity_2m;
  const wsp = o && o.wind_speed_10m != null ? o.wind_speed_10m : c.wind_speed_10m;
  const wdir = o && o.wind_direction_10m != null ? o.wind_direction_10m : c.wind_direction_10m;
  const pres = o && o.pressure_msl != null ? o.pressure_msl : c.pressure_msl;
  const feels = o ? sensacion(temp, wsp) : c.apparent_temperature;

  const lugar = `${place.name}${place.admin1 ? ' · ' + place.admin1 : ''}`;
  const nombreCorto = est ? est.nombre.split('·').pop().trim().replace(/\s*\(.*\)/, '') : '';
  const horaObs = est && est.obs_time ? horaLocal(est.obs_time) : null;
  $('#now-place').textContent = est
    ? `${lugar} · medido en ${nombreCorto}${horaObs ? ' · ' + horaObs + ' h' : ''}`
    : `${lugar} · estimación de modelo`;
  $('#now-icon').textContent = icon;
  $('#now-temp').textContent = Math.round(temp);
  $('#now-desc').textContent = desc;
  $('#now-feels').textContent = feels == null ? '—' : `${Math.round(feels)} °C`;
  $('#now-rh').textContent = rh == null ? '—' : `${Math.round(rh)} %`;
  $('#now-wind').textContent = wsp == null ? '—' : `${Math.round(wsp)} km/h ${compass(wdir)}`;
  $('#now-pres').textContent = pres == null ? '—' : `${Math.round(pres)} hPa`;
  document.title = `${Math.round(temp)}°C ${place.name} — Vigía`;
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

function buildTempChart(canvasId, labels, { ensS, modelSeries, bestSeries, bestLabel }) {
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
    const dest = bestLabel === 'Vigía';   // el blend va más destacado
    ds.push({ label: bestLabel || 'síntesis', data: bestSeries, borderColor: th.accent,
              borderWidth: dest ? 3 : 2, pointRadius: 0, fill: false, tension: 0.35,
              order: dest ? -1 : 0 });
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

// ── Calibración: corrección de sesgo local validada (bias.json) ──

function leadBucketH(h) {
  if (h <= 0) return null;
  if (h <= 24) return '24';
  if (h <= 48) return '48';
  if (h <= 72) return '72';
  if (h <= 96) return '96';
  return null;
}

function updateBiasStation() {
  biasStation = null;
  if (!biasData || !biasData.estaciones) return;
  let best = null;
  for (const [id, e] of Object.entries(biasData.estaciones)) {
    const d = haversineKm(place.lat, place.lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { id, ...e, dist: d };
  }
  if (best && best.dist <= 35) biasStation = best;   // solo si la estación es local
}

// [b_eff, mae] de temperatura para un modelo a cierto lead, o null.
function biasInfo(modelId, leadH) {
  if (!biasStation) return null;
  const bk = leadBucketH(leadH);
  if (!bk) return null;
  return biasData?.bias?.[biasStation.id]?.[modelId]?.['temperature_2m']?.[bk] || null;
}
function biasFor(modelId, leadH) { const x = biasInfo(modelId, leadH); return x ? x[0] : 0; }

// Blend de los DOS mejores modelos por celda (verificado en holdout: bate al
// blend de los 5 y a cualquier modelo individual). Cada modelo se corrige por
// su sesgo y se pondera por 1/mae²; se promedian solo los 2 de menor error.
function blendTemp(h, start, window, times) {
  if (!biasStation) return null;
  const t0 = new Date(times[0]).getTime();
  const out = [];
  for (let j = 0; j < window; j++) {
    const leadH = Math.round((new Date(times[j]).getTime() - t0) / 3600000);
    const cand = [];
    for (const m of MODELS) {
      const arr = h[`temperature_2m_${m.id}`];
      const v = arr ? arr[start + j] : null;
      if (v == null) continue;
      const info = biasInfo(m.id, leadH);
      if (!info || info[1] == null) continue;          // sin mae no participa
      cand.push({ vc: v - info[0], mae: info[1] });
    }
    cand.sort((a, b) => a.mae - b.mae);
    const top = cand.slice(0, 2);                        // los 2 mejores
    let num = 0, den = 0;
    for (const c of top) { const w = 1 / (c.mae * c.mae + 0.25); num += w * c.vc; den += w; }
    out.push(den > 0 ? Math.round((num / den) * 10) / 10 : null);
  }
  return out.some((v) => v != null) ? out : null;
}

// Corrige una serie de temperatura de un modelo restando el bias por lead.
// times[0] ≈ ahora; el lead de cada punto es su distancia horaria a times[0].
function corregirTemp(modelId, arr, times) {
  if (!biasStation || !arr.length) return arr;
  const t0 = new Date(times[0]).getTime();
  return arr.map((v, j) => {
    if (v == null) return v;
    const leadH = Math.round((new Date(times[j]).getTime() - t0) / 3600000);
    const b = biasFor(modelId, leadH);
    return b ? Math.round((v - b) * 10) / 10 : v;
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
      if (!arr) return null;
      const raw = arr.slice(start, start + window);
      return { name: m.name, data: corregirTemp(m.id, raw, times), colorIdx: i };
    }).filter(Boolean),
    bestSeries: blendTemp(h, start, window, times),   // pronóstico Vigía (blend calibrado)
    bestLabel: 'Vigía',
  });
  // indicador de calibración en el panel
  const meta = document.querySelector('#ens-title')?.closest('.panel-head')?.querySelector('.panel-meta');
  if (meta) {
    const base = 'banda 10–90 % · ensamble ECMWF (51 miembros) + 6 modelos';
    meta.textContent = biasStation ? `${base} · ✓ calibrado` : base;
    meta.title = biasStation
      ? `Modelos corregidos por sesgo local validado (estación ${biasStation.nombre}, holdout skill +0.21)`
      : '';
  }

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
    ? 'Líneas de colores: los 6 modelos. Línea gruesa: síntesis best-match. Si se separan, la atmósfera está difícil de pronosticar.'
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

  // 'ahora' real para calcular el lead de cada hora de mañana (corrección de sesgo)
  const t0 = lastData?.best?.current?.time
    ? new Date(lastData.best.current.time).getTime() : new Date(h.time[0]).getTime();
  const colors = modelColors();
  const rows = [];
  MODELS.forEach((m, i) => {
    const temps = h[`temperature_2m_${m.id}`];
    const precs = h[`precipitation_${m.id}`];
    if (!temps) return;
    const dayT = idx.map((j) => {
      const v = temps[j];
      if (v == null) return null;
      const leadH = Math.round((new Date(h.time[j]).getTime() - t0) / 3600000);
      const b = biasFor(m.id, leadH);
      return b ? v - b : v;
    }).filter((v) => v != null);
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
  if (lastData) renderNow(lastData.best);   // re-pintar el "ahora" con fenómeno observado
}

async function loadSismos() {
  try {
    const res = await fetch('sismos.json', { cache: 'no-store' });
    if (!res.ok) return;
    sismosData = await res.json();
    if (capasActivas.has('sismos')) renderMapa();
    renderRiesgos();
  } catch (_) { /* sin catálogo sísmico: la capa queda vacía */ }
}

async function loadIncendios() {
  try {
    const res = await fetch('incendios.json', { cache: 'no-store' });
    if (!res.ok) return;
    incendiosData = await res.json();
    if (capasActivas.has('incendios')) renderMapa();
    renderRiesgos();
  } catch (_) { /* sin foco de calor: la capa queda vacía */ }
}

async function loadAlertas() {
  try {
    const res = await fetch('alertas.json', { cache: 'no-store' });
    if (!res.ok) return;
    alertasData = await res.json();
    if (capasActivas.has('alertas')) renderMapa();
    renderRiesgos();
  } catch (_) { /* sin alertas: la capa queda vacía */ }
}

async function loadVolcanes() {
  try {
    const res = await fetch('volcanes.json', { cache: 'no-store' });
    if (!res.ok) return;
    volcanesData = await res.json();
    if (capasActivas.has('volcanes')) renderMapa();
    renderRiesgos();
  } catch (_) { /* sin RNVV: la capa queda vacía */ }
}

async function loadAvisos() {
  try {
    const res = await fetch('avisos.json', { cache: 'no-store' });
    if (!res.ok) return;
    avisosData = await res.json();
    if (capasActivas.has('avisos')) renderMapa();
    renderRiesgos();
  } catch (_) { /* sin avisos: la capa queda vacía */ }
}

// emergencia.json es cuasi-estático (~9.000 puntos, se refresca 1x/semana):
// un solo fetch por sesión, disparado por toggleCapa al encender la capa, no
// en la carga inicial ni en el refresco periódico de 10 min. tsunami_vias.json
// y tsunami_areas.json se cargan junto en el mismo Promise.all: misma capa,
// mismo gatillo.
async function loadEmergencia() {
  if (emergenciaData || emergenciaCargando) return;
  emergenciaCargando = true;
  const [emg, vias, areas] = await Promise.all([
    fetch('emergencia.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('tsunami_vias.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('tsunami_areas.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (emg) emergenciaData = emg;
  tsunamiViasData = vias;
  tsunamiAreasData = areas;
  emergenciaCargando = false;
  if (capasActivas.has('emergencia')) renderMapa();
}

// Capas del mapa: 'temp' y 'aire' son excluyentes entre sí (misma medición,
// una a la vez); 'sismos', 'incendios', 'alertas', 'volcanes' y 'emergencia'
// son independientes y se pueden combinar con cualquiera.
// 'emergencia' es lazy: ~9.000 puntos cuasi-estáticos que no se cargan salvo
// que el usuario encienda la capa (ni en la carga inicial ni en el refresco).
const CAPAS = {
  temp:       { grupo: 'medicion', paint: paintTemp },
  aire:       { grupo: 'medicion', paint: paintAire },
  sismos:     { paint: paintSismos },
  incendios:  { paint: paintIncendios },
  alertas:    { paint: paintAlertas },
  volcanes:   { paint: paintVolcanes },
  avisos:     { paint: paintAvisos },
  emergencia: { paint: paintEmergencia, lazy: loadEmergencia, tieneData: () => emergenciaData !== null },
};
// Orden de pintado (no el de declaración de CAPAS): la capa de medición se
// pinta al final para que su texto en #map-meta prevalezca sobre las demás.
// Los puntos de alerta van encima de los focos/eventos que resumen.
// 'emergencia' va al final de todo: en una emergencia real es lo que se
// busca, así que su texto y sus íconos deben quedar encima de cualquier otra capa.
const ORDEN_PINTADO = ['volcanes', 'sismos', 'incendios', 'alertas', 'avisos', 'temp', 'aire', 'emergencia'];

function capasGuardadas() {
  try {
    const raw = localStorage.getItem('sinoptica.capas');
    if (raw) {
      const arr = JSON.parse(raw).filter((k) => Object.keys(CAPAS).includes(k));
      if (arr.length) return new Set(arr);
    }
  } catch (_) { /* localStorage puede no estar disponible */ }
  return new Set(['temp']);
}

let capasActivas = capasGuardadas();
const layerGroups = {};

function toggleCapa(k) {
  if (capasActivas.has(k)) {
    capasActivas.delete(k);
  } else {
    if (CAPAS[k].grupo === 'medicion') {
      for (const otra of Object.keys(CAPAS)) {
        if (otra !== k && CAPAS[otra].grupo === 'medicion') capasActivas.delete(otra);
      }
    }
    capasActivas.add(k);
    // Mecanismo lazy genérico: si la capa recién encendida declara `lazy` y
    // todavía no tiene datos, dispara la carga (async, re-pinta sola al terminar).
    const capa = CAPAS[k];
    if (capa.lazy && !(capa.tieneData && capa.tieneData())) capa.lazy();
  }
  try { localStorage.setItem('sinoptica.capas', JSON.stringify([...capasActivas])); } catch (_) { /* opcional */ }
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
  // Con red nacional (Arica a la Antártica) un fitBounds a todas las
  // estaciones da un zoom país ilegible; se parte centrado en el lugar
  // elegido y el botón "Chile" ofrece la vista país bajo demanda.
  map.setView([place.lat, place.lon], 8);
  // Leaflet calcula mal los tiles si el contenedor aún estaba animándose al
  // crearse (queda fondo sin tiles); recalcular asegura que se llenen.
  setTimeout(() => map.invalidateSize(), 200);
  for (const k of Object.keys(CAPAS)) layerGroups[k] = L.layerGroup().addTo(map);
  // Al cambiar de zoom, el dedup/agrupado por celda de paintTemp/paintAire/
  // paintIncendios depende del zoom actual: hay que re-pintar la capa activa.
  map.on('zoomend', () => {
    if (['temp', 'aire', 'incendios', 'emergencia'].some((k) => capasActivas.has(k))) renderMapa();
  });
  // Las vías de evacuación se filtran por el viewport visible (2.740 vías en
  // todo el país): al desplazar el mapa sin cambiar el zoom, también hay que
  // re-pintar para que aparezcan las vías que entraron al encuadre.
  map.on('moveend', () => {
    if (capasActivas.has('emergencia')) renderMapa();
  });
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

  for (const k of ORDEN_PINTADO) {
    layerGroups[k].clearLayers();
    if (capasActivas.has(k)) CAPAS[k].paint(layerGroups[k]);
  }

  const medicion = ['temp', 'aire'].find((k) => capasActivas.has(k));
  document.getElementById('map-legend-temp').hidden = medicion !== 'temp';
  document.getElementById('map-legend-aire').hidden = medicion !== 'aire';
  document.getElementById('map-legend-sismos').hidden = !capasActivas.has('sismos');
  document.getElementById('map-legend-incendios').hidden = !capasActivas.has('incendios');
  document.getElementById('map-legend-alertas').hidden = !capasActivas.has('alertas');
  document.getElementById('map-legend-volcanes').hidden = !capasActivas.has('volcanes');
  document.getElementById('map-legend-avisos').hidden = !capasActivas.has('avisos');
  document.getElementById('map-legend-emergencia').hidden = !capasActivas.has('emergencia');
  document.getElementById('map-note-temp').hidden = medicion !== 'temp';
  document.getElementById('map-note-aire').hidden = medicion !== 'aire';
  document.getElementById('map-note-sismos').hidden = !capasActivas.has('sismos');
  document.getElementById('map-note-incendios').hidden = !capasActivas.has('incendios');
  document.getElementById('map-note-alertas').hidden = !capasActivas.has('alertas');
  document.getElementById('map-note-volcanes').hidden = !capasActivas.has('volcanes');
  document.getElementById('map-note-avisos').hidden = !capasActivas.has('avisos');
  document.getElementById('map-note-emergencia').hidden = !capasActivas.has('emergencia');
  document.querySelectorAll('.map-mode[data-capa]').forEach((b) =>
    b.setAttribute('aria-pressed', String(capasActivas.has(b.dataset.capa))));

  map.invalidateSize();   // por si el panel cambió de tamaño desde el último render
}

// Agrupa items {lat, lon} por celdas de pantalla de `px` píxeles al zoom
// actual, para no apilar decenas de estaciones en el mismo punto cuando el
// mapa está alejado (red nacional de ~150 estaciones).
function agruparPorCelda(items, px) {
  const z = map.getZoom();
  const celdas = new Map();
  for (const it of items) {
    const p = map.project([it.lat, it.lon], z);
    const k = `${Math.floor(p.x / px)}:${Math.floor(p.y / px)}`;
    if (!celdas.has(k)) celdas.set(k, []);
    celdas.get(k).push(it);
  }
  return [...celdas.values()];
}

function paintTemp(group) {
  const todas = estacionesData.estaciones.filter((e) => e.obs && e.obs.temperature_2m != null);
  const est = map.getZoom() < 9
    ? agruparPorCelda(todas, 56).map((celda) => celda.find((e) => e.fuente === 'metar') || celda[0])
    : todas;
  est.forEach((e) => {
    const t = e.obs.temperature_2m;
    const icon = L.divIcon({
      className: 'stn-icon',
      html: `<span class="stn-label ${tempClass(t)}">${Math.round(t)}°</span>`,
      iconSize: [44, 26], iconAnchor: [22, 13],
    });
    const marker = L.marker([e.lat, e.lon], { icon, title: e.nombre }).addTo(group);
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
  const resumen = est.length < todas.length ? `${est.length} de ${todas.length} estaciones` : `${est.length} estaciones`;
  const acerca = est.length < todas.length ? ' (acerca el mapa para ver más)' : '';
  $('#map-meta').textContent = estacionesData.updated
    ? `${resumen} · ${horaLocal(estacionesData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${acerca}`
    : `${resumen}${acerca}`;
}

function paintAire(group) {
  const todas = aireStations.filter((e) => e.icap != null);
  if (!todas.length) { $('#map-meta').textContent = 'sin datos SINCA'; return; }
  const est = map.getZoom() < 9
    ? agruparPorCelda(todas, 56).map((celda) => celda.find((e) => e.fuente === 'metar') || celda[0])
    : todas;
  est.forEach((e) => {
    const nivel = icapNivel(e.icap);
    const icon = L.divIcon({
      className: 'stn-icon',
      html: `<span class="stn-label ${nivel.cls}">${e.icap}</span>`,
      iconSize: [40, 26], iconAnchor: [20, 13],
    });
    const marker = L.marker([e.lat, e.lon], { icon, title: e.nombre }).addTo(group);
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
  const resumen = est.length < todas.length ? `${est.length} de ${todas.length} estaciones SINCA` : `${est.length} estaciones SINCA`;
  const acerca = est.length < todas.length ? ' (acerca el mapa para ver más)' : '';
  $('#map-meta').textContent = `${resumen} · MP2,5${acerca}`;
}

// Chip de impacto estimado PAGER (USGS) — mismo semáforo verde/amarillo/
// naranja/rojo que las alertas volcánicas, reutilizando esas variables CSS.
const PAGER_LABEL = { green: 'verde', yellow: 'amarillo', orange: 'naranja', red: 'rojo' };
function pagerChip(alert) {
  const span = document.createElement('span');
  span.className = `pager-chip pager-${alert}`;
  span.textContent = `Impacto estimado: ${PAGER_LABEL[alert] || alert} (USGS PAGER)`;
  return span;
}

// Color por antigüedad del evento (valores en --sismo-* de app.css, ya
// ajustados para verse bien en claro y oscuro); "old" reutiliza --ink-soft.
function colorSismo(edadMs) {
  if (edadMs < 3600e3) return css('--sismo-h1');
  if (edadMs < 6 * 3600e3) return css('--sismo-h6');
  if (edadMs < 24 * 3600e3) return css('--sismo-h24');
  return css('--ink-soft');
}

function paintSismos(group) {
  const eventos = (sismosData && sismosData.eventos) || [];
  if (!eventos.length) { $('#map-meta').textContent = 'sin datos sísmicos'; return; }
  const ahora = Date.now();
  const replicas = sismosData.replicas;
  // El JSON viene del más reciente al más antiguo; pintamos al revés para
  // que los eventos recientes queden por encima en el mapa.
  [...eventos].reverse().forEach((e) => {
    const color = colorSismo(ahora - new Date(e.utc_time).getTime());
    const marker = L.circleMarker([e.lat, e.lon], {
      radius: 4 + e.mag * 1.8, color, fillColor: color, fillOpacity: 0.55, weight: 1.5,
    }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong'); h.textContent = `M ${e.mag} · ${e.ref}`; box.appendChild(h);
    const filas = [
      ['Profundidad', e.prof_km != null ? `${e.prof_km} km` : null],
      ['Magnitud', `${e.mag} ${e.mag_tipo}`],
      ['Hora local', `${horaLocal(e.utc_time)} h`],
      ['Fuente', e.fuente === 'csn' ? 'CSN' : 'USGS'],
    ];
    if (replicas && replicas.mainshock_id === e.id) {
      filas.push(['Réplicas esperadas 24 h', String(replicas.esperadas_24h)]);
    }
    box.appendChild(popupRows(filas));
    if (replicas && replicas.mainshock_id === e.id) {
      const small = document.createElement('small');
      small.textContent = replicas.nota;
      box.appendChild(small);
    }
    if (e.pager) box.appendChild(pagerChip(e.pager));
    marker.bindPopup(box, { maxWidth: 280 });
  });
  $('#map-meta').textContent = sismosData.updated
    ? `${eventos.length} sismos · ${horaLocal(sismosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${eventos.length} sismos`;
}

const CONF_LABEL = { h: 'Alta', n: 'Nominal', l: 'Baja' };

function paintIncendios(group) {
  const focos = (incendiosData && incendiosData.focos) || [];
  if (!focos.length) {
    // Solo pisa #map-meta si incendios es la única capa activa: si hay otra
    // capa pintada antes o después en ORDEN_PINTADO, su texto debe prevalecer.
    if (capasActivas.size === 1) $('#map-meta').textContent = 'sin focos activos';
    return;
  }
  // Grupos con menos focos primero: los grupos grandes quedan pintados
  // encima cuando varias celdas se superponen visualmente.
  const grupos = agruparPorCelda(focos, 48).sort((a, b) => a.length - b.length);
  grupos.forEach((grupo) => {
    if (grupo.length === 1) {
      const f = grupo[0];
      const icon = L.divIcon({
        className: `foco foco-${f.conf || 'n'}`,
        iconSize: [10, 10], iconAnchor: [5, 5],
      });
      const marker = L.marker([f.lat, f.lon], { icon }).addTo(group);
      const box = document.createElement('div');
      box.className = 'stn-popup';
      const h = document.createElement('strong'); h.textContent = 'Foco de calor'; box.appendChild(h);
      box.appendChild(popupRows([
        ['FRP', f.frp != null ? `${f.frp} MW` : null],
        ['Confianza', CONF_LABEL[f.conf] || f.conf],
        ['Satélite', f.sat],
        ['Hora local', `${horaLocal(f.utc)} h`],
      ]));
      marker.bindPopup(box, { maxWidth: 260 });
    } else {
      const lat = grupo.reduce((s, f) => s + f.lat, 0) / grupo.length;
      const lon = grupo.reduce((s, f) => s + f.lon, 0) / grupo.length;
      const icon = L.divIcon({
        className: 'stn-icon',
        html: `<span class="stn-label foco-grupo">🔥<b>${grupo.length}</b></span>`,
        iconSize: [40, 26], iconAnchor: [20, 13],
      });
      // Sin popup: el clic acerca el mapa al grupo en vez de mostrar detalle.
      L.marker([lat, lon], { icon })
        .on('click', () => map.setView([lat, lon], map.getZoom() + 2))
        .addTo(group);
    }
  });
  $('#map-meta').textContent = incendiosData.updated
    ? `${focos.length} focos · ${horaLocal(incendiosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${focos.length} focos`;
}

const NIVEL_ALERTA_LABEL = {
  roja: 'Alerta Roja', amarilla: 'Alerta Amarilla', temprana_preventiva: 'Alerta Temprana Preventiva',
};

// Emoji por texto del evento (case-insensitive); ⚠️ si no matchea ninguno.
function emojiEvento(evento) {
  const e = (evento || '').toLowerCase();
  if (/aluvi|remoci|lahar/.test(e)) return '🌊';
  if (/meteo|frontal|lluvia|viento|nieve/.test(e)) return '🌧️';
  if (/incendio|forestal/.test(e)) return '🔥';
  if (/volc/.test(e)) return '🌋';
  if (/marea|biol/.test(e)) return '🦠';
  return '⚠️';
}


function paintAlertas(group) {
  const todas = (alertasData && alertasData.alertas) || [];
  const conCoords = todas.filter((a) => a.lat != null && a.lon != null);
  if (!conCoords.length) { $('#map-meta').textContent = 'sin alertas vigentes'; return; }
  conCoords.forEach((a) => {
    const icon = L.divIcon({
      className: 'stn-icon',
      html: `<span class="alerta alerta-${a.nivel}">${emojiEvento(a.evento)}</span>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
    const marker = L.marker([a.lat, a.lon], { icon, title: a.evento }).addTo(group);
    const comunas = a.comunas.slice(0, 5).join(', ') + (a.comunas.length > 5 ? ` y ${a.comunas.length - 5} más` : '');
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong'); h.textContent = a.evento; box.appendChild(h);
    box.appendChild(popupRows([
      ['Nivel', NIVEL_ALERTA_LABEL[a.nivel] || a.nivel],
      ['Región', a.region],
      ['Comunas', `${a.n_comunas} (${comunas})`],
      ['Vigente desde', a.desde],
    ]));
    const pEvento = document.createElement('p');
    pEvento.className = 'alerta-explica';
    pEvento.textContent = explicaEvento(a.evento);
    box.appendChild(pEvento);
    const pNivel = document.createElement('p');
    pNivel.className = 'alerta-nivel-explica';
    pNivel.textContent = EXPLICA_NIVEL[a.nivel] || '';
    box.appendChild(pNivel);
    marker.bindPopup(box, { maxWidth: 280 });
  });
  $('#map-meta').textContent = alertasData.updated
    ? `${conCoords.length} alertas · ${horaLocal(alertasData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${conCoords.length} alertas`;
}

function paintVolcanes(group) {
  const volcanes = (volcanesData && volcanesData.volcanes) || [];
  if (!volcanes.length) { if (capasActivas.size === 1) $('#map-meta').textContent = 'sin datos RNVV'; return; }
  const TAMANO = { verde: 12, amarilla: 16, naranja: 18, roja: 20 };
  volcanes.forEach((v) => {
    const size = TAMANO[v.nivel] || 12;
    const icon = L.divIcon({
      className: 'volcan-icon',
      html: `<span class="volcan vol-${v.nivel}"></span>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
    const marker = L.marker([v.lat, v.lon], { icon, title: v.nombre }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong'); h.textContent = v.nombre; box.appendChild(h);
    box.appendChild(popupRows([
      ['Alerta técnica', v.nivel],
      ['Región', v.region],
      ['Peligrosidad geológica', v.peligrosidad],
    ]));
    marker.bindPopup(box, { maxWidth: 260 });
  });
  $('#map-meta').textContent = volcanesData.updated
    ? `${volcanes.length} volcanes · ${horaLocal(volcanesData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${volcanes.length} volcanes`;
}

// ── Avisos meteorológicos (derivados del pronóstico propio, NO oficiales) ──

const AVISO_EMOJI = { viento: '💨', helada: '❄️', lluvia: '🌧️', calor: '🌡️' };
const AVISO_TIPO_LABEL = { viento: 'Viento fuerte', helada: 'Helada', lluvia: 'Lluvia intensa', calor: 'Calor extremo' };
const AVISO_NIVEL_LABEL = { amarillo: 'Amarillo', naranja: 'Naranja' };

function paintAvisos(group) {
  const avisos = (avisosData && avisosData.avisos) || [];
  if (!avisos.length) { if (capasActivas.size === 1) $('#map-meta').textContent = 'sin avisos meteo'; return; }
  avisos.forEach((a) => {
    const icon = L.divIcon({
      className: 'stn-icon',
      html: `<span class="alerta aviso-${a.nivel}">${AVISO_EMOJI[a.tipo] || '⚠️'}</span>`,
      iconSize: [30, 30], iconAnchor: [15, 15],
    });
    const marker = L.marker([a.lat, a.lon], { icon, title: a.nombre }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong');
    h.textContent = `${AVISO_TIPO_LABEL[a.tipo] || a.tipo} · ${a.nombre}`;
    box.appendChild(h);
    box.appendChild(popupRows([
      ['Nivel', AVISO_NIVEL_LABEL[a.nivel] || a.nivel],
      ['Valor pico', `${r1(a.valor)} ${a.unidad}`],
      ['Hora del pico', `${horaLocal(a.hora_peak)} h`],
    ]));
    const small = document.createElement('small');
    small.textContent = (avisosData && avisosData.nota) || 'Aviso derivado de modelos, no es un aviso oficial de la DMC';
    box.appendChild(small);
    marker.bindPopup(box, { maxWidth: 280 });
  });
  $('#map-meta').textContent = avisosData.updated
    ? `${avisos.length} avisos meteo · ${horaLocal(avisosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${avisos.length} avisos meteo`;
}

const EMG_EMOJI = { salud: '🏥', bomberos: '🚒', carabineros: '🚓', encuentro_tsunami: '🟢', encuentro_volcan: '🔶' };

function paintEmergencia(group) {
  if (!emergenciaData) {
    if (capasActivas.size === 1) $('#map-meta').textContent = 'cargando infraestructura de emergencia…';
    return;
  }
  const categorias = emergenciaData.categorias || {};
  const todos = [];
  for (const [cat, emoji] of Object.entries(EMG_EMOJI)) {
    for (const it of (categorias[cat] || [])) todos.push({ ...it, cat, emoji });
  }
  if (!todos.length) { if (capasActivas.size === 1) $('#map-meta').textContent = 'sin datos de emergencia'; return; }
  // Con ~9.000 puntos el clustering es obligatorio salvo con el mapa muy
  // acercado (zoom ≥ 13), donde cada punto se pinta individual.
  const grupos = map.getZoom() >= 13
    ? todos.map((it) => [it])
    : agruparPorCelda(todos, 44).sort((a, b) => a.length - b.length);
  grupos.forEach((grupo) => {
    if (grupo.length === 1) {
      const it = grupo[0];
      const icon = L.divIcon({
        className: 'stn-icon',
        html: `<span class="emg">${it.emoji}</span>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      });
      const marker = L.marker([it.lat, it.lon], { icon, title: it.n }).addTo(group);
      const box = document.createElement('div');
      box.className = 'stn-popup';
      const h = document.createElement('strong'); h.textContent = it.n; box.appendChild(h);
      if (it.d) { const small = document.createElement('small'); small.textContent = it.d; box.appendChild(small); }
      if (it.cat === 'encuentro_tsunami') {
        const a = document.createElement('a');
        a.href = 'https://senapred.cl/visor-chile-preparado/';
        a.rel = 'noopener'; a.target = '_blank';
        a.textContent = 'ver vías de evacuación oficiales';
        box.appendChild(a);
      }
      marker.bindPopup(box, { maxWidth: 260 });
    } else {
      const lat = grupo.reduce((s, it) => s + it.lat, 0) / grupo.length;
      const lon = grupo.reduce((s, it) => s + it.lon, 0) / grupo.length;
      const icon = L.divIcon({
        className: 'stn-icon',
        html: `<span class="stn-label emg-grupo">🚑<b>${grupo.length}</b></span>`,
        iconSize: [40, 26], iconAnchor: [20, 13],
      });
      // Sin popup: el clic acerca el mapa al grupo en vez de mostrar detalle.
      L.marker([lat, lon], { icon })
        .on('click', () => map.setView([lat, lon], map.getZoom() + 2))
        .addTo(group);
    }
  });
  // Área de evacuación ante tsunami: solo con el mapa acercado (zoom ≥ 12) y
  // filtrada por viewport, igual que las vías. Va ANTES que las vías para
  // quedar debajo (relleno de fondo, no un trazo que compita con la ruta a
  // seguir); los marcadores de puntos siempre quedan por encima de ambas
  // (Leaflet los pinta en un pane distinto al de polígonos/polilíneas).
  if (tsunamiAreasData && map.getZoom() >= 12) {
    const bounds = map.getBounds();
    const color = css('--alerta-roja');
    for (const area of tsunamiAreasData.areas || []) {
      if (!bounds.contains(area.p[0])) continue;
      L.polygon(area.p, { color, weight: 1, opacity: 0.3, fillColor: color, fillOpacity: 0.12 })
        .bindPopup('Zona de evacuación ante tsunami — si sientes un sismo fuerte, abandona esta zona hacia terreno alto')
        .addTo(group);
    }
  }

  // Vías de evacuación (tsunami + volcán): solo con el mapa acercado (zoom ≥
  // 11) y filtradas por el viewport actual — con ~2.940 vías en todo el
  // país, pintar sin filtro de bounds haría el mapa ilegible y lento en
  // cualquier zoom país.
  if (tsunamiViasData && map.getZoom() >= 11) {
    const bounds = map.getBounds();
    const colorTsunami = css('--evac');
    const colorVolcan = css('--evac-volcan');
    for (const via of tsunamiViasData.vias || []) {
      if (!bounds.contains(via.p[0])) continue;
      const esVolcan = via.t === 'volcan';
      L.polyline(via.p, { color: esVolcan ? colorVolcan : colorTsunami, weight: 3, opacity: 0.85, dashArray: '6 4' })
        .bindPopup(esVolcan ? `Vía de evacuación volcánica · ${via.c}` : `Vía de evacuación · ${via.c}`)
        .addTo(group);
    }
  }

  $('#map-meta').textContent = emergenciaData.updated
    ? `${todos.length} puntos de emergencia · ${horaLocal(emergenciaData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${todos.length} puntos de emergencia`;
}

function setupCapas() {
  document.querySelectorAll('.map-mode[data-capa]').forEach((btn) => {
    btn.addEventListener('click', () => toggleCapa(btn.dataset.capa));
  });
  // "Chile": no es una capa que se prende/apaga, es una acción de encuadre —
  // ajusta el zoom a las estaciones continentales y no toca capasActivas.
  const chileBtn = document.querySelector('.map-chile');
  if (chileBtn) {
    chileBtn.addEventListener('click', () => {
      if (!ensureMap() || !estacionesData) return;
      const continental = estacionesData.estaciones.filter((e) => e.lon > -80 && e.lat > -57);
      if (!continental.length) return;
      const bounds = L.latLngBounds(continental.map((e) => [e.lat, e.lon]));
      map.fitBounds(bounds.pad(0.12), { maxZoom: 9 });
    });
  }
}

// Pantalla completa: sobre el panel entero (no solo #map) para que la
// leyenda y los toggles de capas sigan visibles y usables. Fullscreen API
// nativa con fallback a una clase fija (.map-max) cuando no está disponible
// (p.ej. Safari iOS en modo PWA instalada).
function setupMapaFullscreen() {
  const btn = document.getElementById('map-fullscreen-btn');
  const panel = document.getElementById('map-panel');
  if (!btn || !panel) return;

  const activo = () => document.fullscreenElement === panel || panel.classList.contains('map-max');

  function actualizarBoton() {
    const on = activo();
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Mapa a pantalla completa');
    btn.textContent = on ? '✕' : '⛶';
  }

  function onEsc(e) {
    if (e.key === 'Escape') salirFallback();
  }

  function salirFallback() {
    panel.classList.remove('map-max');
    document.removeEventListener('keydown', onEsc);
    actualizarBoton();
    if (map) map.invalidateSize();
  }

  function entrarFallback() {
    panel.classList.add('map-max');
    document.addEventListener('keydown', onEsc);
    actualizarBoton();
    if (map) map.invalidateSize();
  }

  btn.addEventListener('click', () => {
    if (activo()) {
      if (document.fullscreenElement) document.exitFullscreen();
      else salirFallback();
      return;
    }
    if (panel.requestFullscreen) {
      panel.requestFullscreen().catch(entrarFallback);
    } else {
      entrarFallback();
    }
  });

  // fullscreenchange cubre tanto la entrada como la salida nativa (incluido
  // el Esc que el navegador maneja solo): siempre se re-sincroniza el botón
  // y se recalcula el tamaño del mapa.
  document.addEventListener('fullscreenchange', () => {
    actualizarBoton();
    if (map) map.invalidateSize();
  });
}

// ── Centro de riesgos: badge + panel resumen ───────────────────
// Junta en un solo lugar lo que ya cargan loadSismos/loadIncendios/
// loadAlertas/loadVolcanes; no vuelve a pedir datos, solo los resume.

const VOL_RANK = { amarilla: 1, naranja: 2, roja: 3 };

// Distancia entre dos puntos (haversine, radio terrestre 6371 km).
// Misma fórmula que ingesta/sismos.py _dist_km.
function distKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// Radio que cubre la región típica alrededor de una ciudad (p.ej. la RM completa).
const RADIO_CERCA_KM = 200;

function savedRiesgoAmbito() {
  try {
    const v = localStorage.getItem('sinoptica.riesgoAmbito');
    if (v === 'chile' || v === 'cerca') return v;
  } catch (_) { /* localStorage puede no estar disponible */ }
  return 'chile';
}

let riesgoAmbito = savedRiesgoAmbito();

// Ítems sin lat/lon (algunas alertas futuras) se excluyen en modo 'cerca':
// sin coordenadas no se puede saber si están cerca del lugar seleccionado.
function enAmbito(it, ambito = riesgoAmbito) {
  if (ambito === 'chile') return true;
  if (it.lat == null || it.lon == null) return false;
  return distKm(place.lat, place.lon, it.lat, it.lon) <= RADIO_CERCA_KM;
}

// ambito es parámetro (no siempre el global) porque el badge nacional necesita
// las cuentas SIN filtrar por cercanía aunque el panel esté en modo 'cerca'.
function riesgoCounts(ambito = riesgoAmbito) {
  const ahora = Date.now();
  const sismos24 = sismosData
    ? sismosData.eventos.filter((e) => e.mag >= 4 && ahora - new Date(e.utc_time).getTime() <= 24 * 3600e3 && enAmbito(e, ambito))
    : [];
  const sismoMax6 = sismos24.filter((e) => e.mag >= 6).sort((a, b) => b.mag - a.mag)[0] || null;
  const alertas = alertasData ? alertasData.alertas.filter((a) => enAmbito(a, ambito)) : [];
  const rojas = alertas.filter((a) => a.nivel === 'roja').length;
  const amarillas = alertas.filter((a) => a.nivel === 'amarilla').length;
  const volcanesAlerta = volcanesData ? volcanesData.volcanes.filter((v) => v.nivel !== 'verde' && enAmbito(v, ambito)) : [];
  const volPeor = volcanesAlerta.reduce((peor, v) => (VOL_RANK[v.nivel] > (VOL_RANK[peor] || 0) ? v.nivel : peor), null);
  const incendiosN = incendiosData
    ? (ambito === 'cerca' ? (incendiosData.focos || []).filter((f) => enAmbito(f, ambito)).length : incendiosData.n)
    : 0;
  // Avisos meteo: conteo aparte (5.º tile), nunca mezclado con las 4 fuentes
  // oficiales de arriba — son una derivación propia, no un aviso oficial.
  const avisos = avisosData ? avisosData.avisos.filter((a) => enAmbito(a, ambito)) : [];
  const avisoAlto = avisos.some((a) => a.nivel === 'naranja');
  return { sismos24, sismoMax6, rojas, amarillas, volcanesAlerta, volPeor, incendiosN, avisosN: avisos.length, avisoAlto };
}

function renderRiesgoTiles(c) {
  const set = (id, val, cls) => {
    const el = $(id);
    el.textContent = val;
    el.classList.remove('rt-alto', 'rt-medio', 'rt-cero');
    el.classList.add(cls);
  };
  const sismoAlto = c.sismos24.some((e) => e.mag >= 5);
  set('#rt-sismos', c.sismos24.length, sismoAlto ? 'rt-alto' : c.sismos24.length > 0 ? 'rt-medio' : 'rt-cero');
  set('#rt-incendios', c.incendiosN, c.incendiosN > 0 ? 'rt-medio' : 'rt-cero');
  const alertasTxt = c.rojas > 0 ? `${c.rojas}R ${c.amarillas}A` : c.amarillas > 0 ? `${c.amarillas}A` : '0';
  set('#rt-alertas', alertasTxt, c.rojas > 0 ? 'rt-alto' : c.amarillas > 0 ? 'rt-medio' : 'rt-cero');
  const volAlto = c.volPeor === 'naranja' || c.volPeor === 'roja';
  set('#rt-volcanes', c.volcanesAlerta.length, volAlto ? 'rt-alto' : c.volPeor === 'amarilla' ? 'rt-medio' : 'rt-cero');
  set('#rt-avisos', c.avisosN, c.avisoAlto ? 'rt-alto' : c.avisosN > 0 ? 'rt-medio' : 'rt-cero');
}

// DD-MM-AAAA (formato de SENAPRED) → Date; null si no calza.
function parseFechaAlerta(desde) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(desde || '');
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

// Top de eventos por severidad: alertas SENAPRED, volcanes fuera de verde y
// sismos M≥4.5 de las últimas 48 h. Cada rama ya produce solo scores ≥ 30.
function riesgoEventos() {
  const ahora = Date.now();
  const items = [];

  for (const a of alertasData ? alertasData.alertas : []) {
    const score = a.nivel === 'roja' ? 100 : a.nivel === 'amarilla' ? 60 : a.nivel === 'temprana_preventiva' ? 30 : 0;
    if (!score) continue;
    items.push({
      score, fecha: parseFechaAlerta(a.desde), capa: 'alertas', lat: a.lat, lon: a.lon,
      emoji: emojiEvento(a.evento),
      texto: `${NIVEL_ALERTA_LABEL[a.nivel] || a.nivel} · ${a.evento} · ${a.region} (${a.n_comunas} comuna${a.n_comunas === 1 ? '' : 's'})`,
    });
  }

  for (const v of volcanesData ? volcanesData.volcanes : []) {
    if (v.nivel === 'verde') continue;
    const score = v.nivel === 'roja' ? 95 : v.nivel === 'naranja' ? 80 : v.nivel === 'amarilla' ? 55 : 0;
    if (!score) continue;
    items.push({
      score, fecha: null, capa: 'volcanes', lat: v.lat, lon: v.lon,
      emoji: '🌋', texto: `Volcán ${v.nombre} · alerta ${v.nivel}`,
    });
  }

  for (const e of sismosData ? sismosData.eventos : []) {
    if (e.mag < 4.5) continue;
    const edadMs = ahora - new Date(e.utc_time).getTime();
    if (edadMs > 48 * 3600e3) continue;
    let score = 20 + e.mag * 5 + (edadMs < 6 * 3600e3 ? 20 : 0);
    if (e.pager === 'orange') score += 30;
    else if (e.pager === 'red') score += 50;
    items.push({
      score, fecha: new Date(e.utc_time), capa: 'sismos', lat: e.lat, lon: e.lon,
      emoji: '〰️', texto: `M ${e.mag} · ${e.ref}`, pager: e.pager,
    });
  }

  // Avisos meteo: entran al top-10 con menos score que un evento oficial
  // (45 naranja / 25 amarillo) — son una derivación propia, no oficial.
  for (const a of avisosData ? avisosData.avisos : []) {
    items.push({
      score: a.nivel === 'naranja' ? 45 : 25,
      fecha: null, capa: 'avisos', lat: a.lat, lon: a.lon,
      emoji: AVISO_EMOJI[a.tipo] || '⚠️',
      texto: `${AVISO_TIPO_LABEL[a.tipo] || a.tipo} ${a.nivel} · ${a.nombre} · ${r1(a.valor)} ${a.unidad}`,
    });
  }

  const filtrados = items.filter((it) => enAmbito(it));
  filtrados.sort((a, b) => b.score - a.score || (b.fecha?.getTime() || 0) - (a.fecha?.getTime() || 0));
  return filtrados.slice(0, 10);
}

function renderRiesgoEventos() {
  const ol = $('#riesgo-eventos');
  ol.innerHTML = '';
  const items = riesgoEventos();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'riesgo-vacio';
    li.textContent = riesgoAmbito === 'cerca'
      ? `Sin alertas ni eventos significativos cerca de ${place.name}. 🟢`
      : 'Sin alertas ni eventos significativos ahora. 🟢';
    ol.appendChild(li);
    return;
  }
  items.forEach((it) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'riesgo-item';
    const texto = document.createElement('span');
    texto.className = 'ri-text';
    texto.textContent = `${it.emoji} ${it.texto}`;
    btn.appendChild(texto);
    if (it.fecha) {
      const time = document.createElement('time');
      time.textContent = haceCuanto(it.fecha);
      btn.appendChild(time);
    }
    btn.addEventListener('click', () => {
      if (!capasActivas.has(it.capa)) toggleCapa(it.capa);
      if (it.lat != null && it.lon != null && ensureMap()) map.setView([it.lat, it.lon], 8);
      document.querySelector('#map').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.appendChild(btn);
    if (it.pager) li.appendChild(pagerChip(it.pager));
    ol.appendChild(li);
  });
}

function renderRiskBadge(c) {
  const badge = $('#risk-badge');
  let texto = null, aria = null;
  if (c.rojas > 0) {
    texto = `⚠ ${c.rojas} alerta${c.rojas > 1 ? 's' : ''} roja${c.rojas > 1 ? 's' : ''}`;
    aria = `${c.rojas} alerta(s) roja(s) de SENAPRED vigentes`;
  } else if (c.volPeor === 'naranja' || c.volPeor === 'roja') {
    texto = `🌋 volcán en ${c.volPeor}`;
    aria = `Volcán en alerta técnica ${c.volPeor}`;
  } else if (c.sismoMax6) {
    texto = `〰️ sismo M${c.sismoMax6.mag} hoy`;
    aria = `Sismo de magnitud ${c.sismoMax6.mag} en las últimas 24 horas`;
  }
  badge.hidden = !texto;
  if (texto) { badge.textContent = texto; badge.setAttribute('aria-label', aria); }
}

function renderRiesgos() {
  const panel = document.querySelector('.panel-riesgos');
  if (!panel) return;
  const hayAlgo = !!(sismosData || incendiosData || alertasData || volcanesData || avisosData);
  panel.hidden = !hayAlgo;
  if (!hayAlgo) { $('#risk-badge').hidden = true; return; }

  panel.querySelector('[data-capa="sismos"]').hidden = !sismosData;
  panel.querySelector('[data-capa="incendios"]').hidden = !incendiosData;
  panel.querySelector('[data-capa="alertas"]').hidden = !alertasData;
  panel.querySelector('[data-capa="volcanes"]').hidden = !volcanesData;
  panel.querySelector('[data-capa="avisos"]').hidden = !avisosData;

  $('#riesgos-meta').textContent = [
    ['CSN', sismosData], ['SENAPRED', alertasData], ['SERNAGEOMIN', volcanesData], ['NASA FIRMS', incendiosData],
    ['Vigía (no oficial)', avisosData],
  ].filter(([, ok]) => ok).map(([nombre]) => nombre).join(' · ');

  renderRiesgoTiles(riesgoCounts());
  renderRiesgoEventos();
  // El badge es siempre nacional: una alerta roja en otra región igual merece
  // el aviso, aunque el panel esté filtrado a "cerca de <ciudad>".
  renderRiskBadge(riesgoCounts('chile'));
}

function actualizarLabelCerca() {
  const btn = $('#rf-cerca');
  if (btn) btn.textContent = `Cerca de ${place.name}`;
}

function setupRiesgos() {
  document.querySelectorAll('.riesgo-tile[data-capa]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!capasActivas.has(btn.dataset.capa)) toggleCapa(btn.dataset.capa);
      document.querySelector('#map').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  $('#risk-badge').addEventListener('click', () => {
    document.querySelector('.panel-riesgos')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelectorAll('.rf-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.ambito === riesgoAmbito));
    btn.addEventListener('click', () => {
      riesgoAmbito = btn.dataset.ambito;
      try { localStorage.setItem('sinoptica.riesgoAmbito', riesgoAmbito); } catch (_) { /* opcional */ }
      document.querySelectorAll('.rf-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderRiesgos();
    });
  });
  actualizarLabelCerca();
}

// Punto de encuentro ante tsunami más cercano a la posición real del usuario.
// La geolocalización se pide solo con este gesto explícito (nunca automática)
// y se usa una única vez para calcular la distancia: no se guarda en
// localStorage ni en ninguna otra parte, por privacidad.
function setupPuntoCercano() {
  const btn = $('#btn-punto-cercano');
  const out = $('#punto-cercano-resultado');
  if (!btn || !out) return;

  btn.addEventListener('click', () => {
    out.hidden = false;
    out.innerHTML = '';
    if (!('geolocation' in navigator)) {
      out.textContent = 'Tu navegador no permite geolocalización.';
      return;
    }
    out.textContent = 'Buscando tu ubicación…';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        if (!emergenciaData) {
          out.textContent = 'Cargando puntos de encuentro…';
          await loadEmergencia();
        }
        const puntos = (emergenciaData && emergenciaData.categorias && emergenciaData.categorias.encuentro_tsunami) || [];
        if (!puntos.length) {
          out.textContent = 'No hay datos de puntos de encuentro disponibles ahora mismo.';
          return;
        }
        let cercano = null, dist = Infinity;
        for (const p of puntos) {
          const d = distKm(latitude, longitude, p.lat, p.lon);
          if (d < dist) { dist = d; cercano = p; }
        }
        out.innerHTML = '';
        if (dist > 30) {
          out.textContent = 'Estás lejos de la costa: sin riesgo directo de tsunami en tu ubicación.';
          return;
        }
        const texto = document.createElement('span');
        texto.textContent = `Tu punto de encuentro más cercano: ${cercano.n}${cercano.d ? ' · ' + cercano.d : ''} — a ${dist.toFixed(1)} km. `;
        out.appendChild(texto);
        const verBtn = document.createElement('button');
        verBtn.className = 'chip';
        verBtn.textContent = 'ver en el mapa';
        verBtn.addEventListener('click', () => {
          if (!capasActivas.has('emergencia')) toggleCapa('emergencia');
          if (ensureMap()) map.setView([cercano.lat, cercano.lon], 15);
          document.querySelector('#map').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        out.appendChild(verBtn);
      },
      (err) => {
        out.textContent = err.code === err.PERMISSION_DENIED
          ? 'Sin permiso de ubicación: actívalo en tu navegador para usar esta función.'
          : 'No se pudo obtener tu ubicación.';
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  });
}

// ── Ubicaciones: chips y búsqueda ──────────────────────────────

function setPlace(p) {
  place = p;
  try { localStorage.setItem('sinoptica.place', JSON.stringify(p)); } catch (_) { /* opcional */ }
  if (map) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 7));
  updateBiasStation();   // recalcular la estación de calibración cercana
  actualizarLabelCerca();
  if (riesgoAmbito === 'cerca') renderRiesgos();
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

// Catastro de comunas (INE, web/comunas.json): fuente local instantánea, sin
// red. Se carga una sola vez, al primer foco del buscador — no hace falta
// antes porque nadie escribe sin haber tocado el input primero.
let comunasData = null;
let comunasCargando = false;
async function cargarComunas() {
  if (comunasData || comunasCargando) return;
  comunasCargando = true;
  try {
    const res = await fetch('comunas.json');
    if (res.ok) comunasData = await res.json();
  } catch (_) { /* sin comunas.json: el buscador cae solo al geocoding remoto */ }
  comunasCargando = false;
}

// Coincidencias por prefijo primero (más relevantes), luego por infijo.
function buscarComunas(q) {
  if (!comunasData) return [];
  const nq = norm(q);
  const prefijo = [], infijo = [];
  for (const c of comunasData.comunas) {
    const nn = norm(c.n);
    if (nn.startsWith(nq)) prefijo.push(c);
    else if (nn.includes(nq)) infijo.push(c);
  }
  return [...prefijo, ...infijo].slice(0, 8).map((c) => ({ ...c, tipo: 'comuna' }));
}

function setupSearch() {
  const input = $('#search');
  const list = $('#search-results');
  let timer = null;
  let items = [];   // comunas locales + resultados de geocoding, en ese orden
  let sel = -1;

  const hide = () => { list.hidden = true; sel = -1; };

  // `nComunas` marca dónde termina el tramo de comunas dentro de `items`,
  // para pintar el separador visual solo cuando ambos tramos coexisten.
  const render = (comunas, geo) => {
    items = [...comunas, ...geo];
    list.innerHTML = '';
    if (!items.length) { hide(); return; }
    items.forEach((r, i) => {
      const li = document.createElement('li');
      const small = document.createElement('small');
      if (r.tipo === 'comuna') {
        li.append(`${r.n} `);
        small.textContent = r.r;
      } else {
        li.append(`${r.name} `);
        small.textContent = [r.admin2, r.admin1].filter(Boolean).join(' · ');
      }
      li.appendChild(small);
      if (i === comunas.length && comunas.length && geo.length) li.classList.add('search-sep');
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
    if (r.tipo === 'comuna') setPlace({ name: r.n, admin1: r.r, lat: r.lat, lon: r.lon });
    else setPlace({ name: r.name, admin1: r.admin1, lat: r.latitude, lon: r.longitude });
  };

  input.addEventListener('focus', () => { cargarComunas(); }, { once: true });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    const comunas = buscarComunas(q);
    render(comunas, []);   // comunas locales: instantáneo, no espera el debounce
    timer = setTimeout(async () => {
      try {
        const data = await fetchJSON(`${API_GEO}?name=${encodeURIComponent(q)}&count=6&language=es&format=json`);
        const geo = (data.results || []).filter((r) => r.country_code === 'CL').map((r) => ({ ...r, tipo: 'geo' }));
        render(comunas, geo);
      } catch (_) { render(comunas, []); }
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
    if (capasActivas.has('aire')) renderMapa(); // repinta el mapa de aire
  } catch (_) { /* sin SINCA: el panel usa el pronóstico CAMS */ }
}

async function loadBias() {
  try {
    const res = await fetch('bias.json', { cache: 'no-store' });
    if (!res.ok) return;
    biasData = await res.json();
    updateBiasStation();
    if (lastData) render();   // re-pintar con modelos calibrados
  } catch (_) { /* sin calibración: pronóstico crudo */ }
}

setupSearch();
setupDialogs();
setupVerifTabs();
setupCapas();
setupMapaFullscreen();
setupRiesgos();
setupPuntoCercano();
setupPush();

// ── Avisos de emergencia (Web Push) ────────────────────────────
// Sin registro: la suscripción vive en el navegador (endpoint + claves) y el
// servidor solo la usa para reenviar sismos/alertas/volcanes graves.

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function setupPush() {
  const btn = $('#push-btn');
  const info = $('#push-info');
  if (!btn || !info) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  btn.hidden = false;
  info.hidden = false;

  function pintar(suscrito) {
    btn.textContent = suscrito ? '🔕 Desactivar avisos de emergencia' : '🔔 Recibir avisos de emergencia';
    btn.setAttribute('aria-pressed', String(suscrito));
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (_) {
    return; // sin service worker activo: el botón queda oculto de más arriba
  }
  const subInicial = await reg.pushManager.getSubscription().catch(() => null);
  pintar(!!subInicial);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const actual = await reg.pushManager.getSubscription();
      if (actual) {
        await actual.unsubscribe();
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: actual.endpoint }),
        }).catch(() => {});
        pintar(false);
        return;
      }

      const res = await fetch('/api/push/vapid');
      const { publicKey } = await res.json();
      if (!publicKey) {
        alert('Las notificaciones aún no están habilitadas en el servidor.');
        return;
      }

      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') return;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      pintar(true);
    } catch (_) {
      alert('No se pudo activar los avisos de emergencia. Intenta de nuevo más tarde.');
    } finally {
      btn.disabled = false;
    }
  });
}
renderChips();
loadAll().catch(showError);
loadArchiveStatus();
loadVerif();
loadMapa();
loadAireSinca();
loadBias();
loadSismos();
loadIncendios();
loadAlertas();
loadVolcanes();
loadAvisos();

// ── Refresco en vivo ───────────────────────────────────────────
// Una pestaña dejada abierta mostraba datos congelados hasta recargar. Al
// volver a la pestaña y cada ~10 min volvemos a traer los datos en segundo
// plano (sin parpadeo de "cargando"): así "Condiciones actuales" refleja la
// última medición sin que el usuario recargue. El backend ingesta cada hora,
// así que refrescar más seguido solo adelanta la aparición del dato nuevo.
const REFRESH_MS = 10 * 60 * 1000;     // refresco periódico con pestaña visible
const REFRESH_MIN_GAP_MS = 60 * 1000;  // ignora rebotes de foco < 60 s
let lastRefreshAt = Date.now();
let refreshing = false;

// ── Modo offline: barra visible cuando no hay red ──────────────
// El "última actualización" es el más reciente `updated` entre los JSON ya
// cargados (mejor esfuerzo: no todos llegaron a existir necesariamente).
function ultimaActualizacionLocal() {
  const updates = [estacionesData, sismosData, incendiosData, alertasData, volcanesData, avisosData, biasData]
    .filter((d) => d && d.updated).map((d) => d.updated);
  if (!updates.length) return null;
  const masReciente = updates.sort().pop();   // "YYYY-MM-DD HH:MM UTC" ordena bien como texto
  return horaLocal(masReciente.replace(' UTC', 'Z').replace(' ', 'T'));
}

function mostrarOffline(mostrar) {
  const bar = $('#offline-bar');
  if (!bar) return;
  if (!mostrar) { bar.hidden = true; return; }
  const hora = ultimaActualizacionLocal();
  bar.textContent = `⚠ Sin conexión — mostrando los últimos datos guardados${hora ? ` (actualizados ${hora} h)` : ''}`;
  bar.hidden = false;
}

window.addEventListener('online', () => { mostrarOffline(false); refreshAll(); });
window.addEventListener('offline', () => { mostrarOffline(true); });

async function refreshAll() {
  if (refreshing || Date.now() - lastRefreshAt < REFRESH_MIN_GAP_MS) return;
  refreshing = true;
  lastRefreshAt = Date.now();
  try {
    await loadAll({ silent: true });   // Open-Meteo (current + modelos)
    mostrarOffline(false);
  } catch (_) { mostrarOffline(true); }   // sin red: la pantalla conserva el último dato bueno
  loadMapa();          // estaciones.json → medición real de la central cercana
  loadAireSinca();     // aire.json (SINCA)
  loadBias();          // bias.json (calibración)
  loadVerif();         // verificacion.json
  loadArchiveStatus(); // status.json
  loadSismos();        // sismos.json (CSN + USGS)
  loadIncendios();     // incendios.json (NASA FIRMS)
  loadAlertas();       // alertas.json (SENAPRED)
  loadVolcanes();      // volcanes.json (SERNAGEOMIN RNVV)
  loadAvisos();        // avisos.json (derivado propio)
  refreshing = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAll();
});
setInterval(() => {
  if (document.visibilityState === 'visible') refreshAll();
}, REFRESH_MS);

// Carril rápido para sismos: un evento nuevo importa apenas ocurre, no en
// 10 min. Refresca solo esta capa cada 5 min mientras el panel del mapa
// exista (siempre que haya estaciones.json) o la capa sismos esté encendida.
const SISMOS_REFRESH_MS = 5 * 60 * 1000;
setInterval(() => {
  const panelMapaVisible = !$('#map').closest('.panel').hidden;
  if (document.visibilityState === 'visible' && (capasActivas.has('sismos') || panelMapaVisible)) {
    loadSismos();
  }
}, SISMOS_REFRESH_MS);
