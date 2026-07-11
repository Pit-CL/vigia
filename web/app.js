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
  [/volc[aá]n/i, 'El volcán muestra actividad sobre lo normal y está bajo vigilancia reforzada de SERNAGEOMIN. Infórmate de tus vías de evacuación (capa 🏃 Evacuación del mapa) y respeta los perímetros.'],
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
<p><strong>Más capas sobre el mismo mapa.</strong> Además de temperatura y aire puedes activar sismos, incendios, alertas, volcanes y avisos meteorológicos derivados, la capa ⛰️ Remociones (catastro histórico SENAPRED de flujos, deslizamientos y caídas de rocas ya ocurridos — no es un pronóstico, pero el terreno con historial es terreno que puede repetir; ante lluvia intensa, aléjate de quebradas y laderas marcadas), y —para una emergencia— la capa 🏃 Evacuación (vías de evacuación y zona de inundación ante tsunami y volcán) y la capa 🚑 Emergencia (infraestructura como salud, bomberos y carabineros). Cada capa declara su fuente (u origen, si es propia) justo debajo del mapa.</p>
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
<p><strong>Avisos meteorológicos (Vigía, no oficiales).</strong> A diferencia de las tres fuentes anteriores, estos avisos de viento, helada, lluvia, calor y riesgo aluvional NO vienen de un organismo oficial: los calculamos nosotros aplicando umbrales propios —inspirados en los criterios públicos de la DMC, pero sin relación operativa con ella— a la mediana de nuestro propio pronóstico multi-modelo. El aviso aluvional combina lluvia intensa con una isoterma 0° alta: cuando la nieve que normalmente retendría el agua en la cordillera cae como lluvia, las cuencas reciben agua líquida de golpe y crece el riesgo de crecidas repentinas y aluviones en quebradas y laderas. Trátalos como una señal de alerta temprana, no como un aviso oficial.</p>
<p><strong>Cortes de luz (SEC, best effort).</strong> El listado de interrupciones en línea de la Superintendencia de Electricidad y Combustibles no es una API pública documentada: la leemos igual porque es el dato más cercano a tiempo real que existe, pero puede fallar o quedar desactualizada sin aviso previo de la SEC. Se obtiene desde un equipo fuera del VPS (bloqueos de IP de datacenter) y se refresca cada 15 minutos cuando todo funciona.</p>
<p class="info-fine">Los sismos no se pueden predecir: mostramos lo ya ocurrido y, tras un sismo mayor, la tasa estadística esperada de réplicas (ley de Omori) — nunca una proyección de cuándo o dónde ocurrirá el próximo.</p>
<p><strong>Los tres niveles de alerta SENAPRED:</strong></p>
<p class="info-fine">${EXPLICA_NIVEL.temprana_preventiva}<br>${EXPLICA_NIVEL.amarilla}<br>${EXPLICA_NIVEL.roja}</p>`,
  },
  costa: {
    title: 'Marea, oleaje y alerta de tsunami: ¿qué mostramos y qué no?',
    html: `
<p><strong>La marea que ves</strong> viene de un modelo global (Open-Meteo Marine, ~8 km de resolución) que estima el nivel del mar, el oleaje y la temperatura superficial en 32 puntos de la costa chilena.</p>
<p><strong>Lo que NO es:</strong> una tabla de marea oficial. Para navegación, pesca o cualquier decisión que dependa de la hora exacta de pleamar o bajamar, la referencia es el <strong>SHOA</strong> (shoa.cl), que mide con mareógrafos reales en cada puerto.</p>
<p><strong>El estado de tsunami</strong> de arriba de la página combina los boletines del <strong>PTWC</strong> (Centro de Alerta de Tsunamis del Pacífico, NOAA) con nuestro propio catálogo sísmico. La autoridad oficial en Chile es el <strong>SHOA</strong> a través del <strong>SNAM</strong> (Sistema Nacional de Alarma de Maremotos).</p>
<p><strong>El aviso de marejadas</strong> también es propio (no oficial): lo calculamos cuando el modelo proyecta olas de 3,5 m o más en las próximas 48 h. Las marejadas oficiales las declara el <strong>SHOA</strong>/Armada de Chile.</p>
<p class="info-fine">Regla de autoprotección: si sientes un sismo fuerte y prolongado estando en la costa, evacúa a terreno alto de inmediato — no esperes ninguna alerta oficial, puede llegar después de que la ola toque tierra.</p>`,
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
let mareaData = null;    // marea, oleaje y temperatura del mar por punto costero (Open-Meteo Marine, no oficial)
let tsunamiData = null;  // estado de amenaza de tsunami (PTWC + catálogo sísmico propio)
let emergenciaData = null; // infraestructura de emergencia (SENAPRED), carga lazy
let emergenciaPromise = null; // promesa del fetch en vuelo, para que llamadas concurrentes la esperen en vez de perderla
let tsunamiViasData = null; // vías de evacuación tsunami+volcán (SENAPRED), capa 'evacuacion', carga lazy junto con emergenciaData
let tsunamiAreasData = null; // áreas de evacuación ante tsunami (SENAPRED), capa 'evacuacion', carga lazy junto con emergenciaData
let remocionesData = null; // catastro de remociones en masa (SENAPRED), capa 'remociones', carga lazy propia
let cortesData = null;   // cortes de luz SEC (best effort, vía satélite en omen)
let biasData = null;     // correcciones de sesgo por estación/modelo/lead
let biasStation = null;  // estación de calibración más cercana a `place` (o null)
let map = null;
let tileLayer = null;
// Capa satelital GOES-East: tileLayers persistentes fuera de layerGroups
// (ver nota crítica junto a renderMapa) para sobrevivir al clearLayers() de
// cada render sin parpadeo. sateliteFrames es la ventana de los últimos
// timestamps disponibles (ascendente, el más reciente al final).
let sateliteFrames = [];
let sateliteLayers = new Map(); // timestamp ISO (o 'default') → L.tileLayer
let sateliteFrameIdx = -1;
let sateliteTimer = null;
// Capa de solo-etiquetas de CARTO sobre el satélite: sus tiles horneados
// tapan el rotulado del mapa base. Vive fuera de layerGroups por la misma
// razón que sateliteLayers (sobrevivir al clearLayers() de cada render).
let sateliteLabelsLayer = null;
let sateliteLabelsTema = null; // 'light'/'dark' con el que se creó/actualizó sateliteLabelsLayer

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
const isDark = () => document.documentElement.dataset.tema === 'dark' ||
  (document.documentElement.dataset.tema !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
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

// Fecha y hora local sin ambigüedad, para eventos que pueden ser de hoy,
// ayer, mañana o de varios días atrás/adelante ("hoy 14:32", "ayer 09:15",
// "mañana 06:00", "8 jul 14:32"). Compara fechas calendario en TZ Chile.
function fechaHora(isoUtc) {
  try {
    const d = new Date(isoUtc);
    const hora = horaLocal(isoUtc);
    const soloFecha = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const [ey, em, ed] = soloFecha.format(d).split('-').map(Number);
    const [hy, hm, hd] = soloFecha.format(new Date()).split('-').map(Number);
    const diffDias = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(hy, hm - 1, hd)) / 86400000);
    if (diffDias === 0) return `hoy ${hora}`;
    if (diffDias === -1) return `ayer ${hora}`;
    if (diffDias === 1) return `mañana ${hora}`;
    const dia = d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short', timeZone: TZ }).replace('.', '');
    return `${dia} ${hora}`;
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
    forecast_days: '14',
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
// Solo el rotulado (nombres de ciudades) de CARTO, sin el resto del mapa base:
// se usa por encima del satélite, que de otro modo tapa las etiquetas horneadas.
const TILES_LABELS = {
  light: 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
};

// Capa satelital: NASA GIBS, GOES-East ABI GeoColor (WMTS RESTful, sin API key).
// Ojo con el orden del path: es {z}/{y}/{x} (TileMatrix/TileRow/TileCol), no
// el {z}/{x}/{y} habitual de Leaflet — el template solo cambia DÓNDE va cada
// token, Leaflet igual sustituye {x}/{y} por columna/fila respectivamente.
const SATELITE_TILE_TMPL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/{time}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png';
const SATELITE_DOMAINS_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/GOES-East_ABI_GeoColor/default/GoogleMapsCompatible_Level7/all/all.xml';
const SATELITE_ATTR = 'NASA GIBS · NOAA GOES-East';
const SATELITE_MAX_FRAMES = 6;
const SATELITE_PLAY_MS = 800;
const sateliteTileUrl = (t) => SATELITE_TILE_TMPL.replace('{time}', t);

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

async function loadCortes() {
  try {
    const res = await fetch('cortes.json', { cache: 'no-store' });
    if (!res.ok) return;
    cortesData = await res.json();
    if (capasActivas.has('cortes')) renderMapa();
    renderRiesgos();
  } catch (_) { /* sin cortes: la capa queda vacía */ }
}

async function loadMarea() {
  try {
    const res = await fetch('marea.json', { cache: 'no-store' });
    if (!res.ok) return;
    mareaData = await res.json();
    if (capasActivas.has('marea')) renderMapa();
    renderCosta();
  } catch (_) { /* sin marea: la capa y la tarjeta Costa quedan sin datos */ }
}

async function loadTsunami() {
  try {
    const res = await fetch('tsunami.json', { cache: 'no-store' });
    if (!res.ok) return;
    tsunamiData = await res.json();
    renderTsunamiBanner();
    renderCosta();
  } catch (_) { /* sin tsunami.json: el banner queda oculto */ }
}

// emergencia.json es cuasi-estático (~9.000 puntos, se refresca 1x/semana):
// un solo fetch por sesión, disparado por toggleCapa al encender la capa
// emergencia O la capa evacuacion (ambas comparten este loader), no en la
// carga inicial ni en el refresco periódico de 10 min. tsunami_vias.json y
// tsunami_areas.json (capa evacuacion) se cargan junto en el mismo
// Promise.all: distinta capa, mismo gatillo. farmacias.json (MINSAL, vía
// satélite en omen) NO es infraestructura SENAPRED — es una fuente propia
// que se fusiona como categoría 'farmacia' dentro de emergenciaData.categorias
// porque es infraestructura de emergencia, no porque comparta origen.
async function loadEmergencia() {
  if (emergenciaData) return;
  if (emergenciaPromise) { await emergenciaPromise; return; }
  emergenciaPromise = Promise.all([
    fetch('emergencia.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('tsunami_vias.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('tsunami_areas.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('farmacias.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const [emg, vias, areas, farm] = await emergenciaPromise;
  if (emg) emergenciaData = emg;
  if (farm && Array.isArray(farm.farmacias) && farm.farmacias.length) {
    if (!emergenciaData) emergenciaData = { categorias: {} };
    if (!emergenciaData.categorias) emergenciaData.categorias = {};
    emergenciaData.categorias.farmacia = farm.farmacias
      .filter((f) => typeof f.lat === 'number' && typeof f.lon === 'number')
      .map((f) => ({
        n: f.nombre,
        d: [f.direccion, f.comuna].filter(Boolean).join(', '),
        h: (f.abre && f.cierra) ? `${f.abre} – ${f.cierra}` : null,
        lat: f.lat,
        lon: f.lon,
      }));
  }
  tsunamiViasData = vias;
  tsunamiAreasData = areas;
  emergenciaPromise = null;
  if (capasActivas.has('emergencia') || capasActivas.has('evacuacion')) renderMapa();
}

// remociones.json es el catastro histórico de remociones en masa (~1.218
// puntos, cuasi-estático, se refresca 1x/semana): loader propio, no
// comparte disparador con loadEmergencia (es una fuente distinta, sin
// relación con la infraestructura de emergencia).
let remocionesCargando = false;
async function loadRemociones() {
  if (remocionesData || remocionesCargando) return;
  remocionesCargando = true;
  try {
    const res = await fetch('remociones.json', { cache: 'no-store' });
    if (res.ok) remocionesData = await res.json();
  } catch (_) { /* sin catastro: la capa queda vacía */ }
  remocionesCargando = false;
  if (capasActivas.has('remociones')) renderMapa();
}

// Satélite GOES-East: DescribeDomains devuelve el historial completo de
// disponibilidad (~5 años) como UN solo <Domain>rango1,rango2,...</Domain>,
// cada rango "inicio/fin/PT10M" (huecos entre rangos, y rangos de un solo
// instante cuando inicio == fin). Se recorren los rangos desde el final
// (los más recientes) expandiendo cada uno en pasos de 10 min hasta juntar
// SATELITE_MAX_FRAMES timestamps. Si el fetch o el parseo fallan, cae a un
// solo frame con TIME=default (la imagen más reciente) sin romper la capa.
async function loadSatelite() {
  let frames;
  try {
    const res = await fetch(SATELITE_DOMAINS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const dominio = xml.match(/<Domain>([^<]+)<\/Domain>/);
    if (!dominio) throw new Error('sin dominio de tiempo GIBS');
    const rangos = dominio[1].split(',');
    frames = [];
    for (let i = rangos.length - 1; i >= 0 && frames.length < SATELITE_MAX_FRAMES; i--) {
      const [inicio, fin] = rangos[i].split('/');
      for (let t = new Date(fin); t >= new Date(inicio) && frames.length < SATELITE_MAX_FRAMES; t = new Date(t - 10 * 60000)) {
        frames.unshift(t.toISOString().replace(/\.\d{3}Z$/, 'Z'));
      }
    }
    if (!frames.length) throw new Error('rango de tiempo vacío');
  } catch (_) {
    frames = ['default'];
  }
  sateliteFrames = frames;
  sateliteFrameIdx = frames.length - 1;
  // Descarta del mapa y de la caché los frames que salieron de la ventana
  // vigente: si no, cada refresco de 10 min deja un tileLayer invisible más
  // acumulado indefinidamente mientras la capa siga activa.
  sateliteLayers.forEach((layer, t) => {
    if (!frames.includes(t)) {
      if (map && map.hasLayer(layer)) map.removeLayer(layer);
      sateliteLayers.delete(t);
    }
  });
  if (capasActivas.has('satelite')) renderMapa();
}

function getOrCreateSateliteLayer(t) {
  let layer = sateliteLayers.get(t);
  if (!layer) {
    layer = L.tileLayer(sateliteTileUrl(t), {
      maxNativeZoom: 7, maxZoom: 18, opacity: 0, zIndex: 5, attribution: SATELITE_ATTR,
    });
    sateliteLayers.set(t, layer);
  }
  if (!map.hasLayer(layer)) layer.addTo(map);
  return layer;
}

function getOrCreateSateliteLabelsLayer() {
  const tema = isDark() ? 'dark' : 'light';
  if (!sateliteLabelsLayer) {
    sateliteLabelsLayer = L.tileLayer(TILES_LABELS[tema], { maxZoom: 18, zIndex: 6, subdomains: 'abcd' });
  } else if (sateliteLabelsTema !== tema) {
    sateliteLabelsLayer.setUrl(TILES_LABELS[tema]);
  }
  sateliteLabelsTema = tema;
  if (!map.hasLayer(sateliteLabelsLayer)) sateliteLabelsLayer.addTo(map);
  return sateliteLabelsLayer;
}

function actualizarBotonPlaySatelite() {
  const btn = document.getElementById('satelite-play');
  if (!btn) return;
  const activo = !!sateliteTimer;
  btn.disabled = sateliteFrames.length < 2;
  btn.textContent = activo ? '⏸' : '▶';
  btn.setAttribute('aria-pressed', String(activo));
}

function actualizarEtiquetaSatelite() {
  const label = document.getElementById('satelite-hora');
  if (!label) return;
  const t = sateliteFrames[sateliteFrameIdx];
  label.textContent = !t || t === 'default' ? 'imagen más reciente' : horaLocal(t);
}

function mostrarFrameSatelite(idx) {
  sateliteFrameIdx = idx;
  const actual = getOrCreateSateliteLayer(sateliteFrames[idx]);
  sateliteLayers.forEach((layer) => layer.setOpacity(layer === actual ? 0.7 : 0));
  actualizarEtiquetaSatelite();
}

function detenerReproduccionSatelite() {
  if (sateliteTimer) { clearInterval(sateliteTimer); sateliteTimer = null; }
  actualizarBotonPlaySatelite();
}

function toggleReproduccionSatelite() {
  if (sateliteTimer) { detenerReproduccionSatelite(); return; }
  if (sateliteFrames.length < 2) return;
  sateliteTimer = setInterval(() => {
    mostrarFrameSatelite((sateliteFrameIdx + 1) % sateliteFrames.length);
  }, SATELITE_PLAY_MS);
  actualizarBotonPlaySatelite();
}

// Retira del mapa los tileLayers persistentes del satélite y detiene la
// reproducción; se llama al apagar la capa (renderMapa no lo hace solo
// porque estos tileLayers viven fuera de layerGroups['satelite']).
function limpiarSatelite() {
  detenerReproduccionSatelite();
  sateliteLayers.forEach((layer) => { if (map.hasLayer(layer)) map.removeLayer(layer); });
  if (sateliteLabelsLayer && map.hasLayer(sateliteLabelsLayer)) map.removeLayer(sateliteLabelsLayer);
}

function paintSatelite() {
  if (!sateliteFrames.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = 'cargando imagen satelital…';
    return;
  }
  if (sateliteFrameIdx < 0 || sateliteFrameIdx >= sateliteFrames.length) sateliteFrameIdx = sateliteFrames.length - 1;
  mostrarFrameSatelite(sateliteFrameIdx);
  getOrCreateSateliteLabelsLayer();
  actualizarBotonPlaySatelite();
  $('#map-meta').textContent = 'Satélite GOES-East · retraso típico 20–60 min';
}

// Capas del mapa: 'temp' y 'aire' son excluyentes entre sí (misma medición,
// una a la vez); 'sismos', 'incendios', 'alertas', 'volcanes', 'remociones',
// 'evacuacion' y 'emergencia' son independientes y se pueden combinar con
// cualquiera. 'evacuacion' y 'emergencia' son lazy: ~9.000 puntos + vías/áreas
// cuasi-estáticos que no se cargan salvo que el usuario encienda alguna de
// las dos (ni en la carga inicial ni en el refresco). 'remociones' es lazy
// por su propia cuenta: ~1.200 puntos igual de cuasi-estáticos, pero es un
// catastro propio sin relación con emergenciaData.
const CAPAS = {
  temp:          { grupo: 'medicion', paint: paintTemp },
  aire:          { grupo: 'medicion', paint: paintAire },
  precipitacion: { grupo: 'medicion', paint: paintPrecip },
  sismos:        { paint: paintSismos },
  incendios:     { paint: paintIncendios },
  alertas:       { paint: paintAlertas },
  volcanes:      { paint: paintVolcanes },
  avisos:        { paint: paintAvisos },
  remociones:    { paint: paintRemociones, lazy: loadRemociones, tieneData: () => remocionesData !== null },
  cortes:        { paint: paintCortes },
  marea:         { paint: paintMarea },
  evacuacion:    { paint: paintEvacuacion, lazy: loadEmergencia, tieneData: () => tsunamiViasData !== null || tsunamiAreasData !== null },
  emergencia:    { paint: paintEmergencia, lazy: loadEmergencia, tieneData: () => emergenciaData !== null },
  satelite:      { paint: paintSatelite, lazy: loadSatelite, tieneData: () => sateliteFrames.length > 0 },
};
// Orden de pintado (no el de declaración de CAPAS): la capa de medición se
// pinta al final para que su texto en #map-meta prevalezca sobre las demás.
// Los puntos de alerta van encima de los focos/eventos que resumen.
// 'remociones' va junto a las demás capas de peligro, antes de 'avisos'.
// 'emergencia' y 'evacuacion' van al final de todo: en una emergencia real
// son lo que se busca, así que su texto y sus íconos deben quedar encima de
// cualquier otra capa. 'evacuacion' cierra la lista porque sus vías son la
// acción más urgente (hacia dónde ir), por sobre el resto. 'satelite' va
// primero: es la capa menos accionable, su texto en #map-meta no debe pisar
// el de ninguna otra.
const ORDEN_PINTADO = ['satelite', 'volcanes', 'sismos', 'incendios', 'alertas', 'remociones', 'cortes', 'avisos', 'temp', 'aire', 'precipitacion', 'marea', 'emergencia', 'evacuacion'];

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
// Las capas lazy restauradas desde localStorage también necesitan su carga:
// toggleCapa no corre al restaurar, y sin esto una capa lazy que quedó
// activa reaparece vacía tras recargar (bug real: satélite «no carga nada»).
capasActivas.forEach((k) => {
  const c = CAPAS[k];
  if (c.lazy && !(c.tieneData && c.tieneData())) c.lazy();
});
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
    if (['temp', 'aire', 'precipitacion', 'incendios', 'remociones', 'emergencia', 'evacuacion'].some((k) => capasActivas.has(k))) renderMapa();
  });
  // Las vías de evacuación se filtran por el viewport visible (2.740 vías en
  // todo el país): al desplazar el mapa sin cambiar el zoom, también hay que
  // re-pintar para que aparezcan las vías que entraron al encuadre.
  map.on('moveend', () => {
    if (capasActivas.has('emergencia') || capasActivas.has('evacuacion')) renderMapa();
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
    attribution: TILES_ATTR, maxZoom: 18, subdomains: 'abcd',
  }).addTo(map);
  // Este tileLayer base se recrea en cada render (igual que layerGroups[k]
  // más abajo se vacía con clearLayers): por eso los tileLayers del satélite
  // NO viven en layerGroups['satelite'] sino en la variable de módulo
  // sateliteLayers, con zIndex 5 para quedar sobre este base recreado.

  for (const k of ORDEN_PINTADO) {
    layerGroups[k].clearLayers();
    if (capasActivas.has(k)) CAPAS[k].paint(layerGroups[k]);
  }

  const medicion = ['temp', 'aire', 'precipitacion'].find((k) => capasActivas.has(k));
  document.getElementById('map-legend-temp').hidden = medicion !== 'temp';
  document.getElementById('map-legend-aire').hidden = medicion !== 'aire';
  document.getElementById('map-legend-precipitacion').hidden = medicion !== 'precipitacion';
  document.getElementById('map-legend-sismos').hidden = !capasActivas.has('sismos');
  document.getElementById('map-legend-incendios').hidden = !capasActivas.has('incendios');
  document.getElementById('map-legend-alertas').hidden = !capasActivas.has('alertas');
  document.getElementById('map-legend-volcanes').hidden = !capasActivas.has('volcanes');
  document.getElementById('map-legend-avisos').hidden = !capasActivas.has('avisos');
  document.getElementById('map-legend-remociones').hidden = !capasActivas.has('remociones');
  document.getElementById('map-legend-marea').hidden = !capasActivas.has('marea');
  document.getElementById('map-legend-evacuacion').hidden = !capasActivas.has('evacuacion');
  document.getElementById('map-legend-emergencia').hidden = !capasActivas.has('emergencia');
  document.getElementById('map-note-temp').hidden = medicion !== 'temp';
  document.getElementById('map-note-aire').hidden = medicion !== 'aire';
  document.getElementById('map-note-precipitacion').hidden = medicion !== 'precipitacion';
  document.getElementById('map-note-sismos').hidden = !capasActivas.has('sismos');
  document.getElementById('map-note-incendios').hidden = !capasActivas.has('incendios');
  document.getElementById('map-note-alertas').hidden = !capasActivas.has('alertas');
  document.getElementById('map-note-volcanes').hidden = !capasActivas.has('volcanes');
  document.getElementById('map-note-avisos').hidden = !capasActivas.has('avisos');
  document.getElementById('map-note-remociones').hidden = !capasActivas.has('remociones');
  document.getElementById('map-note-cortes').hidden = !capasActivas.has('cortes');
  document.getElementById('map-note-marea').hidden = !capasActivas.has('marea');
  document.getElementById('map-note-evacuacion').hidden = !capasActivas.has('evacuacion');
  document.getElementById('map-note-emergencia').hidden = !capasActivas.has('emergencia');
  document.getElementById('map-note-satelite').hidden = !capasActivas.has('satelite');
  document.getElementById('satelite-control').hidden = !capasActivas.has('satelite');
  // Los tileLayers del satélite viven fuera de layerGroups['satelite'] (ver
  // nota crítica arriba): al apagar la capa hay que retirarlos a mano.
  if (!capasActivas.has('satelite')) limpiarSatelite();
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

// Formato del acumulado: 1 decimal bajo 10 (precisión útil en valores chicos),
// entero desde 10 (a esa magnitud el decimal ya no aporta).
function fmtAcum(v) {
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

// Clase de color por magnitud: se clasifica el valor que se muestra en la
// etiqueta (nieve si se está mostrando nieve, lluvia si no), salvo el piso de
// severidad propio de la nieve (>= 5 cm es severo aunque el mm de lluvia no lo sea).
function precipClass(lluvia48, nieve48) {
  if (nieve48 != null && nieve48 >= 5) return 'pp-severo';
  const v = nieve48 != null && nieve48 >= 1 ? nieve48 : (lluvia48 || 0);
  if (v <= 1) return 'pp-0';
  if (v <= 10) return 'pp-bajo';
  if (v <= 30) return 'pp-medio';
  if (v <= 60) return 'pp-alto';
  return 'pp-severo';
}

function paintPrecip(group) {
  // Solo estaciones con precipitación prevista de verdad: los 0,0 mm son ruido
  // visual (la mayoría del país en un día seco) y no aportan al mapa.
  const todas = (avisosData && avisosData.acumulados || [])
    .filter((a) => a.lluvia_48h != null)
    .filter((a) => a.lluvia_48h >= 0.1 || (a.nieve_48h != null && a.nieve_48h >= 0.5));
  if (!todas.length) { $('#map-meta').textContent = 'sin precipitación prevista en las próximas 48 h'; return; }
  const est = map.getZoom() < 9 ? agruparPorCelda(todas, 56).map((celda) => celda[0]) : todas;
  est.forEach((a) => {
    const nieve = a.nieve_48h != null && a.nieve_48h >= 1;
    const cls = precipClass(a.lluvia_48h, a.nieve_48h);
    const label = nieve ? `❄ ${fmtAcum(a.nieve_48h)} cm` : `${fmtAcum(a.lluvia_48h)} mm`;
    const icon = L.divIcon({
      className: 'stn-icon',
      html: `<span class="stn-label ${cls}">${label}</span>`,
      iconSize: [50, 26], iconAnchor: [25, 13],
    });
    const marker = L.marker([a.lat, a.lon], { icon, title: a.nombre }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong'); h.textContent = a.nombre; box.appendChild(h);
    box.appendChild(popupRows([
      ['Lluvia 24 h', `${r1(a.lluvia_24h)} mm`],
      ['Lluvia 48 h', `${r1(a.lluvia_48h)} mm`],
      ['Nieve 24 h', a.nieve_24h != null ? `${r1(a.nieve_24h)} cm` : null],
      ['Nieve 48 h', a.nieve_48h != null ? `${r1(a.nieve_48h)} cm` : null],
    ]));
    const small = document.createElement('small');
    small.textContent = (avisosData && avisosData.fuente) || 'Derivado del pronóstico multi-modelo';
    box.appendChild(small);
    marker.bindPopup(box, { maxWidth: 280 });
  });
  const resumen = est.length < todas.length ? `${est.length} de ${todas.length} estaciones` : `${est.length} estaciones`;
  const acerca = est.length < todas.length ? ' (acerca el mapa para ver más)' : '';
  $('#map-meta').textContent = avisosData.updated
    ? `${resumen} · acumulado 48 h · ${horaLocal(avisosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${acerca}`
    : `${resumen} · acumulado 48 h${acerca}`;
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
      ['Fecha y hora', fechaHora(e.utc_time)],
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

// Estación con viento medido más cercana a un foco (<60 km): base para
// estimar la dirección de avance del fuego. wind_direction_10m es la
// convención meteorológica (de dónde viene el viento), así que el fuego
// avanza hacia el lado opuesto: (dir + 180) % 360.
function vientoEnFoco(lat, lon) {
  if (!estacionesData) return null;
  let best = null;
  for (const e of estacionesData.estaciones) {
    if (!e.obs || e.obs.wind_speed_10m == null || e.obs.wind_direction_10m == null) continue;
    const d = haversineKm(lat, lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { e, dist: d };
  }
  if (!best || best.dist > 60) return null;
  return { v: best.e.obs.wind_speed_10m, dir: best.e.obs.wind_direction_10m, nombre: best.e.nombre, km: best.dist };
}

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
      const viento = vientoEnFoco(f.lat, f.lon);
      const avance = viento && viento.v >= 15 ? (viento.dir + 180) % 360 : null;
      // Flecha discreta al costado del punto (no lo tapa); solo la rotación
      // indica el rumbo de avance. rotate(avance - 90) porque el glifo ➤
      // apunta al Este (90°) por defecto: rotarlo (avance - 90)° alinea su
      // punta con el rumbo compás (0°=N arriba, 90°=E derecha, sentido horario).
      const flecha = avance != null
        ? `<span class="foco-flecha" style="transform: rotate(${avance - 90}deg)">➤</span>`
        : '';
      const icon = L.divIcon({
        className: `foco foco-${f.conf || 'n'}`,
        html: flecha,
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
      if (viento) {
        if (viento.v >= 15) {
          const chip = document.createElement('div');
          chip.className = `viento-avance${viento.v >= 30 ? ' viento-avance-fuerte' : ''}`;
          chip.textContent = `Viento ${Math.round(viento.v)} km/h desde el ${compass(viento.dir)} ` +
            `(${viento.nombre}, a ${Math.round(viento.km)} km) → avance probable hacia el ${compass(avance)}`;
          box.appendChild(chip);
        } else {
          const debil = document.createElement('div');
          debil.className = 'viento-debil';
          debil.textContent = `Viento débil (${Math.round(viento.v)} km/h) — propagación lenta o errática`;
          box.appendChild(debil);
        }
        const nota = document.createElement('small');
        nota.textContent = 'Aproximación con el viento de la estación más cercana; el viento local en el ' +
          'foco puede diferir. Ante fuego cercano evacúa temprano, no esperes confirmación.';
        box.appendChild(nota);
      }
      marker.bindPopup(box, { maxWidth: 260 });
    } else {
      const lat = grupo.reduce((s, f) => s + f.lat, 0) / grupo.length;
      const lon = grupo.reduce((s, f) => s + f.lon, 0) / grupo.length;
      const icon = L.divIcon({
        className: 'stn-icon',
        html: `<span class="stn-label foco-grupo">🔥<b>${grupo.length}</b></span>`,
        iconSize: [40, 26], iconAnchor: [20, 13],
      });
      const marker = L.marker([lat, lon], {
        icon, title: `${grupo.length} focos de calor — toca para ver`,
      }).addTo(group);
      const box = document.createElement('div');
      box.className = 'stn-popup';
      const h = document.createElement('strong');
      h.textContent = `${grupo.length} focos de calor`;
      box.appendChild(h);
      const ul = document.createElement('ul');
      ul.className = 'grupo-lista';
      const MAX_LISTA = 12;
      [...grupo].sort((a, b) => (b.frp || 0) - (a.frp || 0)).slice(0, MAX_LISTA).forEach((f) => {
        const li = document.createElement('li');
        li.textContent = `FRP ${f.frp != null ? f.frp + ' MW' : '—'} · confianza ${CONF_LABEL[f.conf] || f.conf} · ${fechaHora(f.utc)}`;
        ul.appendChild(li);
      });
      if (grupo.length > MAX_LISTA) {
        const li = document.createElement('li');
        li.textContent = `y ${grupo.length - MAX_LISTA} más`;
        ul.appendChild(li);
      }
      box.appendChild(ul);
      const popup = L.popup({ maxWidth: 280 }).setLatLng([lat, lon]).setContent(box);
      // Bajo zoom 16, el clic acerca el mapa (zoom+2) y normalmente el grupo
      // se separa en focos individuales. Desde zoom 16 el +2 ya llega al
      // techo (tileLayer con maxZoom 18) y dos focos a <20 m siguen cayendo
      // en la misma celda de 48 px: el grupo nunca se desagrega, así que el
      // clic abre el detalle en un popup en vez de ser un botón muerto.
      // (No se usa bindPopup para no duplicar el toggle automático de Leaflet
      // con este handler de clic.)
      marker.on('click', () => {
        if (map.getZoom() < 16) map.setView([lat, lon], map.getZoom() + 2);
        else popup.openOn(map);
      });
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

const AVISO_EMOJI = { viento: '💨', helada: '❄️', lluvia: '🌧️', calor: '🌡️', aluvional: '⛰️💧' };
const AVISO_TIPO_LABEL = { viento: 'Viento fuerte', helada: 'Helada', lluvia: 'Lluvia intensa', calor: 'Calor extremo', aluvional: 'Riesgo aluvional' };
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
    const filas = [
      ['Nivel', AVISO_NIVEL_LABEL[a.nivel] || a.nivel],
      ['Valor pico', `${r1(a.valor)} ${a.unidad}`],
      ['Hora del pico', fechaHora(a.hora_peak)],
    ];
    if (a.tipo === 'aluvional' && a.isoterma_m != null) filas.push(['Isoterma 0°', `~${a.isoterma_m} m`]);
    box.appendChild(popupRows(filas));
    if (a.tipo === 'aluvional') {
      const riesgo = document.createElement('p');
      riesgo.textContent = `${r1(a.valor)} mm en 24 h con isoterma ~${a.isoterma_m} m — riesgo de aluvión en quebradas y laderas; aléjate de cauces`;
      box.appendChild(riesgo);
    }
    const small = document.createElement('small');
    small.textContent = (avisosData && avisosData.nota) || 'Aviso derivado de modelos, no es un aviso oficial de la DMC';
    box.appendChild(small);
    marker.bindPopup(box, { maxWidth: 280 });
  });
  $('#map-meta').textContent = avisosData.updated
    ? `${avisos.length} avisos meteo · ${horaLocal(avisosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${avisos.length} avisos meteo`;
}

// ── Marea, oleaje y temperatura del mar (Open-Meteo Marine, no oficial) ──

function paintMarea(group) {
  const puntos = (mareaData && mareaData.puntos) || [];
  if (!puntos.length) { if (capasActivas.size === 1) $('#map-meta').textContent = 'sin datos de marea'; return; }
  puntos.forEach((p) => {
    const cls = p.tendencia === 'bajando' ? 'marea-baja' : 'marea-sube';
    const flecha = p.tendencia === 'bajando' ? '▼' : p.tendencia === 'subiendo' ? '▲' : '—';
    const anillo = p.marejada ? ` marejada-${p.marejada.nivel}` : '';
    const icon = L.divIcon({
      className: 'stn-icon',
      html: `<span class="stn-label ${cls}${anillo}">${flecha}</span>`,
      iconSize: [30, 26], iconAnchor: [15, 13],
    });
    const marker = L.marker([p.lat, p.lon], { icon, title: p.nombre }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong'); h.textContent = p.nombre; box.appendChild(h);
    const meta = document.createElement('small');
    meta.textContent = `Marea ${r1(p.nivel)} m (${p.tendencia || 'estable'})`;
    box.appendChild(meta);
    const filas = (p.extremos || []).slice(0, 2).map((e) =>
      [e.tipo === 'pleamar' ? 'Pleamar' : 'Bajamar', `${fechaHora(e.t)} · ${r1(e.h)} m`]);
    if (p.ola) filas.push(['Ola', `${r1(p.ola.altura)} m · ${r1(p.ola.periodo)} s`]);
    if (p.sst != null) filas.push(['Mar', `${r1(p.sst)} °C`]);
    box.appendChild(popupRows(filas));
    if (p.marejada) {
      const aviso = document.createElement('p');
      aviso.className = `marejada-${p.marejada.nivel}`;
      aviso.textContent = `🌊 Marejadas: olas de hasta ${r1(p.marejada.altura)} m ${fechaHora(p.marejada.t)}`;
      box.appendChild(aviso);
    }
    const small = document.createElement('small');
    small.textContent = (mareaData && mareaData.nota) || '';
    box.appendChild(small);
    marker.bindPopup(box, { maxWidth: 280 });
  });
  $('#map-meta').textContent = mareaData.updated
    ? `${puntos.length} puntos costeros · marea de modelo (no oficial) · ${horaLocal(mareaData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${puntos.length} puntos costeros · marea de modelo (no oficial)`;
}

const EMG_EMOJI = { salud: '🏥', bomberos: '🚒', carabineros: '🚓', farmacia: '💊', encuentro_tsunami: '🟢', encuentro_volcan: '🔶' };

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
  // ~9.000 puntos en todo el país: pintarlos todos satura el DOM (9.292
  // divIcons medidos a zoom 13 en Valparaíso). Se filtra primero al
  // viewport actual (con margen, para no recortar en el borde) y recién
  // sobre eso se agrupa/pinta — igual que ya se hace con vías y áreas.
  const boundsPuntos = map.getBounds().pad(0.3);
  const visibles = todos.filter((it) => boundsPuntos.contains([it.lat, it.lon]));
  // Con ~9.000 puntos el clustering es obligatorio salvo con el mapa muy
  // acercado (zoom ≥ 13), donde cada punto se pinta individual.
  const grupos = map.getZoom() >= 13
    ? visibles.map((it) => [it])
    : agruparPorCelda(visibles, 44).sort((a, b) => a.length - b.length);
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
      if (it.h) { const smallH = document.createElement('small'); smallH.textContent = `Horario: ${it.h}`; box.appendChild(smallH); }
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
      const marker = L.marker([lat, lon], {
        icon, title: `${grupo.length} servicios de emergencia — toca para ver`,
      }).addTo(group);
      const box = document.createElement('div');
      box.className = 'stn-popup';
      const h = document.createElement('strong');
      h.textContent = `${grupo.length} en este punto`;
      box.appendChild(h);
      const ul = document.createElement('ul');
      ul.className = 'grupo-lista';
      const MAX_LISTA = 12;
      grupo.slice(0, MAX_LISTA).forEach((it) => {
        const li = document.createElement('li');
        li.textContent = `${it.emoji} ${it.n}${it.d ? ` — ${it.d}` : ''}`;
        ul.appendChild(li);
      });
      if (grupo.length > MAX_LISTA) {
        const li = document.createElement('li');
        li.textContent = `y ${grupo.length - MAX_LISTA} más`;
        ul.appendChild(li);
      }
      box.appendChild(ul);
      const popup = L.popup({ maxWidth: 280 }).setLatLng([lat, lon]).setContent(box);
      // Mismo criterio que en incendios (paintIncendios): bajo zoom 16 el
      // clic acerca el mapa y el grupo suele separarse; desde zoom 16 el +2
      // ya llega al techo (maxZoom 18) y el grupo nunca se desagrega, así
      // que el clic abre el detalle en un popup.
      marker.on('click', () => {
        if (map.getZoom() < 16) map.setView([lat, lon], map.getZoom() + 2);
        else popup.openOn(map);
      });
    }
  });
  $('#map-meta').textContent = emergenciaData.updated
    ? `${todos.length} puntos de emergencia · ${horaLocal(emergenciaData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${todos.length} puntos de emergencia`;
}

// Bounding box de una geometría (área o vía), cacheado en el propio objeto
// tras el primer cálculo: con ~2.940 vías y un repintado en cada moveend/
// zoomend, recorrer todos los vértices de todas las geometrías en cada
// pintado sería costoso — el bounding box no cambia entre repintados.
function geomBounds(geom) {
  if (!geom._bb) geom._bb = L.latLngBounds(geom.p);
  return geom._bb;
}

// Vías y áreas de evacuación ante tsunami/volcán: comparten loader con
// 'emergencia' (loadEmergencia) pero son su propia capa — el usuario no las
// encontraba mezcladas con los ~9.000 puntos de infraestructura.
function paintEvacuacion(group) {
  if (!tsunamiViasData && !tsunamiAreasData) {
    if (capasActivas.size === 1) $('#map-meta').textContent = 'cargando vías de evacuación…';
    return;
  }
  // Área de evacuación ante tsunami: solo con el mapa acercado (zoom ≥ 12) y
  // filtrada por viewport, igual que las vías. Va ANTES que las vías para
  // quedar debajo (relleno de fondo, no un trazo que compita con la ruta a
  // seguir).
  if (tsunamiAreasData && map.getZoom() >= 12) {
    const bounds = map.getBounds();
    const color = css('--alerta-roja');
    for (const area of tsunamiAreasData.areas || []) {
      if (!bounds.intersects(geomBounds(area))) continue;
      L.polygon(area.p, { color, weight: 1, opacity: 0.3, fillColor: color, fillOpacity: 0.12 })
        .bindPopup('Zona de evacuación ante tsunami — si sientes un sismo fuerte, abandona esta zona hacia terreno alto')
        .addTo(group);
    }
  }

  // Vías de evacuación (tsunami + volcán): solo con el mapa acercado (zoom ≥
  // 11) y filtradas por el viewport actual — con ~2.940 vías en todo el
  // país, pintar sin filtro de bounds haría el mapa ilegible y lento en
  // cualquier zoom país.
  let pintadas = 0;
  if (tsunamiViasData && map.getZoom() >= 11) {
    const bounds = map.getBounds();
    const colorTsunami = css('--evac');
    const colorVolcan = css('--evac-volcan');
    for (const via of tsunamiViasData.vias || []) {
      if (!bounds.intersects(geomBounds(via))) continue;
      const esVolcan = via.t === 'volcan';
      L.polyline(via.p, { color: esVolcan ? colorVolcan : colorTsunami, weight: 3, opacity: 0.85, dashArray: '6 4' })
        .bindPopup(esVolcan ? `Vía de evacuación volcánica · ${via.c}` : `Vía de evacuación · ${via.c}`)
        .addTo(group);
      pintadas++;
    }
  }

  // Con el mapa en zoom país, las vías (zoom ≥ 11) y el área de inundación
  // (zoom ≥ 12) no se pintan y no hay ninguna pista visual de que existen:
  // el usuario reportó "no las veo". El aviso solo aparece cuando falta el
  // requisito de zoom para las vías (el más bajo de los dos).
  $('#map-meta').textContent = map.getZoom() < 11
    ? 'vías de evacuación: acerca el mapa a una zona costera o volcánica'
    : `${pintadas} vías de evacuación en el encuadre`;
}

// ── Remociones en masa: catastro histórico (SENAPRED) ───────────

// Los subtipos 'Propagación' y 'Deformaciones de ladera' son marginales
// (8 y 3 puntos de 1.218) y no justifican un color propio: se pintan con el
// mismo glifo/color que 'Deslizamiento'.
const REM_CLASE = {
  Flujo: 'rem-flujo',
  Deslizamiento: 'rem-desliza',
  'Caída': 'rem-caida',
  'Propagación': 'rem-desliza',
  'Deformaciones de ladera': 'rem-desliza',
};

function paintRemociones(group) {
  const puntos = (remocionesData && remocionesData.puntos) || [];
  if (!puntos.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = 'cargando catastro de remociones…';
    return;
  }
  const zoom = map.getZoom();
  if (zoom < 9) {
    // Bajo zoom 9: mismo patrón que paintIncendios, grupos con contador
    // circular en vez de 1.218 puntos individuales ilegibles a escala país.
    const grupos = agruparPorCelda(puntos, 48).sort((a, b) => a.length - b.length);
    grupos.forEach((grupo) => {
      const lat = grupo.reduce((s, p) => s + p.lat, 0) / grupo.length;
      const lon = grupo.reduce((s, p) => s + p.lon, 0) / grupo.length;
      const icon = L.divIcon({
        className: 'stn-icon',
        html: `<span class="stn-label rem-grupo">⛰️<b>${grupo.length}</b></span>`,
        iconSize: [40, 26], iconAnchor: [20, 13],
      });
      const marker = L.marker([lat, lon], {
        icon, title: `${grupo.length} remociones registradas — toca para acercar`,
      }).addTo(group);
      marker.on('click', () => map.setView([lat, lon], zoom + 2));
    });
  } else {
    puntos.forEach((p) => {
      const clase = REM_CLASE[p.t] || 'rem-desliza';
      const icon = L.divIcon({ className: `rem-icon ${clase}`, iconSize: [12, 12], iconAnchor: [6, 6] });
      const marker = L.marker([p.lat, p.lon], { icon, title: p.t }).addTo(group);
      const box = document.createElement('div');
      box.className = 'stn-popup';
      const h = document.createElement('strong');
      h.textContent = `${p.t} — remoción en masa registrada`;
      box.appendChild(h);
      const small = document.createElement('small');
      small.textContent = 'Si vives cerca: ante lluvia intensa aléjate de quebradas y laderas';
      box.appendChild(small);
      marker.bindPopup(box, { maxWidth: 260 });
      // Zona de influencia aproximada: solo con el mapa bien acercado, igual
      // que el criterio de zoom de paintEvacuacion para no saturar el mapa.
      if (zoom >= 12) {
        const color = css(`--${clase}`);
        L.circle([p.lat, p.lon], { radius: 150, color, weight: 0, fillColor: color, fillOpacity: 0.12 }).addTo(group);
      }
    });
  }
  $('#map-meta').textContent = `${puntos.length} remociones registradas · catastro SENAPRED`;
}

// Círculo escalado por clientes afectados (mismo patrón que paintSismos con
// la magnitud): raíz cuadrada para que comunas con miles de clientes no
// tapen el mapa completo, tope de radio para que sigan siendo comparables.
function paintCortes(group) {
  const cortes = (cortesData && cortesData.cortes) || [];
  if (!cortes.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = 'sin cortes de luz reportados';
    return;
  }
  const color = css('--alerta-amarilla');
  cortes.forEach((c) => {
    if (c.lat == null || c.lon == null) return;
    const radius = Math.min(6 + Math.sqrt(c.clientes) * 0.9, 40);
    const marker = L.circleMarker([c.lat, c.lon], {
      radius, color, fillColor: color, fillOpacity: 0.45, weight: 1.5,
    }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong');
    h.textContent = `${c.comuna} — ${c.clientes.toLocaleString('es-CL')} clientes afectados`;
    box.appendChild(h);
    if (c.empresas.length) {
      const small = document.createElement('small');
      small.textContent = c.empresas.join(' · ');
      box.appendChild(small);
    }
    marker.bindPopup(box, { maxWidth: 260 });
  });
  const stale = cortesData.stale ? ' · datos antiguos (satélite sin actualizar)' : '';
  $('#map-meta').textContent = cortesData.updated
    ? `${cortesData.n_comunas} comunas con cortes · SEC best effort · ${horaLocal(cortesData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${stale}`
    : `${cortesData.n_comunas} comunas con cortes · SEC best effort${stale}`;
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
  const playBtn = document.getElementById('satelite-play');
  if (playBtn) playBtn.addEventListener('click', toggleReproduccionSatelite);
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
  const alertaRoja = alertas.find((a) => a.nivel === 'roja' && a.lat != null && a.lon != null) || null;
  const volcanesAlerta = volcanesData ? volcanesData.volcanes.filter((v) => v.nivel !== 'verde' && enAmbito(v, ambito)) : [];
  const volPeor = volcanesAlerta.reduce((peor, v) => (VOL_RANK[v.nivel] > (VOL_RANK[peor] || 0) ? v.nivel : peor), null);
  const volcanPeor = volPeor ? volcanesAlerta.find((v) => v.nivel === volPeor) || null : null;
  const incendiosN = incendiosData
    ? (ambito === 'cerca' ? (incendiosData.focos || []).filter((f) => enAmbito(f, ambito)).length : incendiosData.n)
    : 0;
  // Avisos meteo: conteo aparte (5.º tile), nunca mezclado con las 4 fuentes
  // oficiales de arriba — son una derivación propia, no un aviso oficial.
  const avisos = avisosData ? avisosData.avisos.filter((a) => enAmbito(a, ambito)) : [];
  const avisoAlto = avisos.some((a) => a.nivel === 'naranja');
  // Cortes SEC: conteo de comunas afectadas (no de clientes, para que el
  // número calce con "toca para ver el detalle" del tile). Alto si alguna
  // comuna del ámbito supera 10.000 clientes afectados.
  const cortes = cortesData ? cortesData.cortes.filter((c) => enAmbito(c, ambito)) : [];
  const cortesAlto = cortes.some((c) => c.clientes > 10000);
  return {
    sismos24, sismoMax6, rojas, amarillas, alertaRoja, volcanesAlerta, volPeor, volcanPeor,
    incendiosN, avisosN: avisos.length, avisoAlto, cortesN: cortes.length, cortesAlto,
  };
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
  set('#rt-cortes', c.cortesN, c.cortesAlto ? 'rt-alto' : c.cortesN > 0 ? 'rt-medio' : 'rt-cero');
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
  let texto = null, aria = null, capa = null, evento = null;
  if (c.rojas > 0) {
    texto = `⚠ ${c.rojas} alerta${c.rojas > 1 ? 's' : ''} roja${c.rojas > 1 ? 's' : ''}`;
    aria = `${c.rojas} alerta(s) roja(s) de SENAPRED vigentes`;
    capa = 'alertas';
    evento = c.alertaRoja;
  } else if (c.volPeor === 'naranja' || c.volPeor === 'roja') {
    texto = `🌋 volcán en ${c.volPeor}`;
    aria = `Volcán en alerta técnica ${c.volPeor}`;
    capa = 'volcanes';
    evento = c.volcanPeor;
  } else if (c.sismoMax6) {
    texto = `〰️ sismo M${c.sismoMax6.mag} hoy`;
    aria = `Sismo de magnitud ${c.sismoMax6.mag} en las últimas 24 horas`;
    capa = 'sismos';
    evento = c.sismoMax6;
  }
  badge.hidden = !texto;
  if (texto) {
    badge.textContent = texto; badge.setAttribute('aria-label', aria); badge.dataset.capa = capa;
    if (evento && evento.lat != null && evento.lon != null) {
      badge.dataset.lat = String(evento.lat);
      badge.dataset.lon = String(evento.lon);
    } else {
      delete badge.dataset.lat;
      delete badge.dataset.lon;
    }
  }
}

function renderRiesgos() {
  const panel = document.querySelector('.panel-riesgos');
  if (!panel) return;
  const hayAlgo = !!(sismosData || incendiosData || alertasData || volcanesData || avisosData || cortesData);
  panel.hidden = !hayAlgo;
  if (!hayAlgo) { $('#risk-badge').hidden = true; return; }

  panel.querySelector('[data-capa="sismos"]').hidden = !sismosData;
  panel.querySelector('[data-capa="incendios"]').hidden = !incendiosData;
  panel.querySelector('[data-capa="alertas"]').hidden = !alertasData;
  panel.querySelector('[data-capa="volcanes"]').hidden = !volcanesData;
  panel.querySelector('[data-capa="avisos"]').hidden = !avisosData;
  panel.querySelector('[data-capa="cortes"]').hidden = !cortesData;

  $('#riesgos-meta').textContent = [
    ['CSN', sismosData], ['SENAPRED', alertasData], ['SERNAGEOMIN', volcanesData], ['NASA FIRMS', incendiosData],
    ['Vigía (no oficial)', avisosData], ['SEC (best effort)', cortesData],
  ].filter(([, ok]) => ok).map(([nombre]) => nombre).join(' · ');

  renderRiesgoTiles(riesgoCounts());
  renderRiesgoEventos();
  // El badge respeta el ámbito elegido por el usuario: si el panel está
  // filtrado a "cerca de <ciudad>", el badge no debe anunciar una alerta de
  // otra región que después no aparezca al hacer clic en él.
  renderRiskBadge(riesgoCounts());
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
    const badge = $('#risk-badge');
    const capa = badge.dataset.capa;
    if (capa && !capasActivas.has(capa)) toggleCapa(capa);
    if (badge.dataset.lat !== undefined && badge.dataset.lon !== undefined && ensureMap()) {
      map.setView([Number(badge.dataset.lat), Number(badge.dataset.lon)], 8);
    }
    document.querySelector('#map').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelectorAll('#riesgo-filtro-ambito .rf-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.ambito === riesgoAmbito));
    btn.addEventListener('click', () => {
      riesgoAmbito = btn.dataset.ambito;
      try { localStorage.setItem('sinoptica.riesgoAmbito', riesgoAmbito); } catch (_) { /* opcional */ }
      document.querySelectorAll('#riesgo-filtro-ambito .rf-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderRiesgos();
    });
  });
  actualizarLabelCerca();
}

// Punto de encuentro más cercano a la posición real del usuario, ante tsunami
// o ante erupción volcánica según el tipo elegido en el selector. Siempre se
// muestra el punto más cercano con su distancia (nunca se oculta por estar
// lejos): lejos solo agrega una nota aclaratoria. La geolocalización se pide
// solo con este gesto explícito (nunca automática) y se usa una única vez
// para calcular la distancia: no se guarda en localStorage ni en ninguna otra
// parte, por privacidad.
function setupPuntoCercano() {
  const btn = $('#btn-punto-cercano');
  const out = $('#punto-cercano-resultado');
  if (!btn || !out) return;
  let tipo = 'tsunami';

  document.querySelectorAll('#punto-tipo-filtro .rf-btn').forEach((b) => {
    b.addEventListener('click', () => {
      tipo = b.dataset.tipo;
      document.querySelectorAll('#punto-tipo-filtro .rf-btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  });

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
        const categoria = tipo === 'volcan' ? 'encuentro_volcan' : 'encuentro_tsunami';
        const puntos = (emergenciaData && emergenciaData.categorias && emergenciaData.categorias[categoria]) || [];
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
        const texto = document.createElement('span');
        texto.textContent = `Tu punto de encuentro más cercano: ${cercano.n}${cercano.d ? ' · ' + cercano.d : ''} — a ${dist.toFixed(1)} km. `;
        out.appendChild(texto);
        if (tipo === 'tsunami' && dist > 30) {
          const nota = document.createElement('p');
          nota.textContent = `Estás a ~${Math.round(dist)} km de la costa: sin riesgo directo de tsunami en tu ubicación.`;
          out.appendChild(nota);
        } else if (tipo === 'volcan' && dist > 100) {
          const nota = document.createElement('p');
          nota.textContent = 'No estás cerca de una zona con rutas de evacuación volcánica.';
          out.appendChild(nota);
        }
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
        if (err.code === err.PERMISSION_DENIED) {
          // Guía por plataforma, la del usuario primero (Android + Chrome es
          // por lejos lo más común en Chile). Rutas según la ayuda oficial
          // de Google Chrome y Apple, verificadas 2026-07.
          const ua = navigator.userAgent;
          const esAndroid = /android/i.test(ua);
          const esIOS = /iphone|ipad|ipod/i.test(ua);
          const guias = [];
          if (esAndroid) {
            guias.push(
              'En Chrome: toca el ícono junto a la dirección del sitio (arriba, el candado o los controles) → Permisos → Ubicación → Permitir, y vuelve a tocar el botón.',
              'Si no aparece la opción: menú ⋮ (arriba a la derecha) → Configuración → Configuración de sitios → Ubicación → busca vigia.cavara.cl y permítelo.',
              'Revisa también que la Ubicación del teléfono esté encendida (desliza desde arriba y busca el ícono 📍 Ubicación).',
              'En Samsung Internet: menú ☰ → Ajustes → Sitios y descargas → Permisos de sitios → Ubicación.',
            );
          } else if (esIOS) {
            guias.push(
              'En Safari: toca "AA" o el ícono junto a la dirección → Configuración del sitio web → Ubicación → Permitir.',
              'Si no aparece: Ajustes del iPhone → Apps → Safari → Ubicación → «Preguntar» o «Permitir».',
              'Revisa también: Ajustes → Privacidad y seguridad → Localización (debe estar activada).',
            );
          } else {
            guias.push(
              'En Chrome: haz clic en el candado (o el ícono de controles) a la izquierda de la dirección → Configuración del sitio → Ubicación → Permitir, y recarga la página.',
              'En Firefox: clic en el candado → Permisos → Ubicación → quita el bloqueo, y recarga.',
            );
          }
          out.textContent = '';
          const p = document.createElement('p');
          p.textContent = 'Sin permiso de ubicación. Actívalo así:';
          const ul = document.createElement('ul');
          guias.forEach((t) => {
            const li = document.createElement('li');
            li.textContent = t;
            ul.appendChild(li);
          });
          out.append(p, ul);
        } else {
          out.textContent = 'No se pudo obtener tu ubicación (sin señal de GPS o tardó demasiado). '
            + 'Revisa que la Ubicación del equipo esté encendida e inténtalo de nuevo.';
        }
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  });
}

// ── Banner global de amenaza de tsunami ────────────────────────
// Sin botón de cierre a propósito: es seguridad vital y dura lo que dure el
// estado real informado por tsunami.json, no lo que el usuario quiera ver.

function renderTsunamiBanner() {
  const el = $('#tsunami-banner');
  if (!el || !tsunamiData) return;
  const estado = tsunamiData.estado;
  if (estado === 'amenaza') {
    el.textContent = `🌊 AMENAZA DE TSUNAMI — ${tsunamiData.mensaje} · Sigue al SHOA/SENAPRED y evacúa la costa`;
    el.className = 'tsunami-amenaza';
    el.hidden = false;
  } else if (estado === 'precaucion') {
    el.textContent = tsunamiData.mensaje;
    el.className = 'tsunami-precaucion';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ── Costa: marea, oleaje y estado de tsunami del punto más cercano ─────
// Reutiliza haversineKm (mismo patrón que estacionAireCercana/estacionObsCercana).

function puntoCosteroActivo() {
  if (!mareaData || !mareaData.puntos) return null;
  let best = null;
  for (const p of mareaData.puntos) {
    const d = haversineKm(place.lat, place.lon, p.lat, p.lon);
    if (!best || d < best.dist) best = { ...p, dist: d };
  }
  return best && best.dist <= 40 ? best : null;
}

function renderCosta() {
  const panel = $('.panel-costa');
  if (!panel) return;
  const p = puntoCosteroActivo();
  panel.hidden = !p;
  if (!p) return;

  $('#costa-nombre').textContent = p.nombre;
  const cls = p.tendencia === 'bajando' ? 'marea-baja' : 'marea-sube';
  $('#costa-marea-icono').textContent = p.tendencia === 'bajando' ? '▼' : p.tendencia === 'subiendo' ? '▲' : '—';
  $('#costa-marea-icono').className = `costa-marea-icono ${cls}`;
  $('#costa-marea-nivel').textContent = `${r1(p.nivel)} m`;
  $('#costa-marea-tendencia').textContent = p.tendencia || 'estable';

  const proxPleamar = (p.extremos || []).find((e) => e.tipo === 'pleamar');
  const proxBajamar = (p.extremos || []).find((e) => e.tipo === 'bajamar');
  $('#costa-pleamar').textContent = proxPleamar ? `${fechaHora(proxPleamar.t)} · ${r1(proxPleamar.h)} m` : '—';
  $('#costa-bajamar').textContent = proxBajamar ? `${fechaHora(proxBajamar.t)} · ${r1(proxBajamar.h)} m` : '—';
  $('#costa-ola').textContent = p.ola ? `${r1(p.ola.altura)} m · ${r1(p.ola.periodo)} s` : '—';
  $('#costa-sst').textContent = p.sst != null ? `${r1(p.sst)} °C` : '—';

  const marejada = $('#costa-marejada');
  if (p.marejada) {
    marejada.textContent = `🌊 Marejadas: olas de hasta ${r1(p.marejada.altura)} m ${fechaHora(p.marejada.t)}`;
    marejada.className = `costa-marejada costa-marejada-${p.marejada.nivel}`;
    marejada.hidden = false;
  } else {
    marejada.hidden = true;
  }

  const tsu = $('#costa-tsunami');
  if (tsunamiData) {
    tsu.textContent = tsunamiData.mensaje;
    tsu.className = `costa-tsunami ${tsunamiData.estado === 'amenaza' ? 'tsunami-amenaza' : tsunamiData.estado === 'precaucion' ? 'tsunami-precaucion' : ''}`;
  } else {
    tsu.textContent = '—';
    tsu.className = 'costa-tsunami';
  }
  $('#costa-nota').textContent = (mareaData && mareaData.nota) || '';
}

// ── Ubicaciones: chips y búsqueda ──────────────────────────────

function setPlace(p) {
  place = p;
  try { localStorage.setItem('sinoptica.place', JSON.stringify(p)); } catch (_) { /* opcional */ }
  // Zoom 11 ≈ la comuna y su entorno inmediato: elegir una ciudad debe
  // enfocarla, no mostrar media región. Si el usuario ya estaba más adentro
  // (p. ej. nivel calle), se respeta su zoom.
  if (map) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 11));
  updateBiasStation();   // recalcular la estación de calibración cercana
  actualizarLabelCerca();
  if (riesgoAmbito === 'cerca') renderRiesgos();
  renderCosta();   // recalcular el punto costero más cercano
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
  if (document.documentElement.dataset.tema) return; // tema manual: ignora al sistema
  syncThemeColorMeta();
  render();
  renderVerif();
  renderMapa();
});

// ── Selector de tema (auto → claro → oscuro → auto) ────────────

const THEME_LABEL = { auto: 'automático', light: 'claro', dark: 'oscuro' };
const THEME_ICON = { auto: '🌓', light: '☀️', dark: '🌙' };

function themeState() {
  const t = document.documentElement.dataset.tema;
  return t === 'light' || t === 'dark' ? t : 'auto';
}

// Actualiza los <meta name="theme-color"> (uno por media claro/oscuro) para
// que coincidan con el tema efectivo, incluso si fue elegido a mano.
function syncThemeColorMeta() {
  const bg = css('--bg');
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = bg; });
}

function updateThemeBtn() {
  const btn = $('#theme-btn');
  if (!btn) return;
  const t = themeState();
  btn.textContent = THEME_ICON[t];
  btn.title = `Tema: ${THEME_LABEL[t]}`;
}

function setupThemeBtn() {
  const btn = $('#theme-btn');
  if (!btn) return;
  updateThemeBtn();
  syncThemeColorMeta();
  btn.addEventListener('click', () => {
    const next = { auto: 'light', light: 'dark', dark: 'auto' }[themeState()];
    if (next === 'auto') {
      delete document.documentElement.dataset.tema;
      try { localStorage.removeItem('sinoptica.tema'); } catch (_) { /* opcional */ }
    } else {
      document.documentElement.dataset.tema = next;
      try { localStorage.setItem('sinoptica.tema', next); } catch (_) { /* opcional */ }
    }
    updateThemeBtn();
    syncThemeColorMeta();
    render();
    renderVerif();
    renderMapa();
  });
}

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
setupThemeBtn();
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

// Preferencias del opt-in "solo mi zona" + recordatorio de kit, solo para
// pintar la UI: la fuente de verdad de a quién se le envía vive en push/send.py.
function savedPushPrefs() {
  try {
    const raw = localStorage.getItem('sinoptica.pushPrefs');
    if (raw) return { zona: false, radio: 200, mag: 5.5, kit: false, ...JSON.parse(raw) };
  } catch (_) { /* localStorage puede no estar disponible */ }
  return { zona: false, radio: 200, mag: 5.5, kit: false };
}

function savePushPrefs(prefs) {
  try { localStorage.setItem('sinoptica.pushPrefs', JSON.stringify(prefs)); } catch (_) { /* opcional */ }
}

async function setupPush() {
  const btn = $('#push-btn');
  const info = $('#push-info');
  const zonaBox = $('#push-zona');
  const zonaToggle = $('#push-zona-toggle');
  const zonaRadio = $('#push-zona-radio');
  const zonaMag = $('#push-zona-mag');
  const kitToggle = $('#push-kit-reminder');
  if (!btn || !info) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  btn.hidden = false;
  info.hidden = false;

  const prefs = savedPushPrefs();
  if (zonaToggle) zonaToggle.checked = prefs.zona;
  if (zonaRadio) zonaRadio.value = String(prefs.radio);
  if (zonaMag) zonaMag.value = String(prefs.mag);
  if (kitToggle) kitToggle.checked = prefs.kit;

  function pintar(suscrito) {
    btn.textContent = suscrito ? '🔕 Desactivar avisos de emergencia' : '🔔 Recibir avisos de emergencia';
    btn.setAttribute('aria-pressed', String(suscrito));
    if (zonaBox) zonaBox.hidden = !suscrito;
  }

  // Campos opcionales de zona/kit para el body de /api/push/subscribe.
  // Ubicación: `place` (comuna elegida), NUNCA GPS, redondeada a 0.1° (~11 km)
  // con el mismo `r1` que ya usa el resto de la app.
  function camposZona() {
    const p = {
      zona: !!(zonaToggle && zonaToggle.checked),
      radio: zonaRadio ? Number(zonaRadio.value) : 200,
      mag: zonaMag ? Number(zonaMag.value) : 5.5,
      kit: !!(kitToggle && kitToggle.checked),
    };
    savePushPrefs(p);
    // `zona` va siempre explícito (true/false): así el servidor distingue
    // "el usuario apagó la zona" (borra lat/lon) de "esta petición no dice
    // nada de zona" (preserva lo ya guardado) — ver push/server.py.
    const campos = { zona: p.zona, kit_reminder: p.kit ? 1 : 0 };
    if (p.zona) {
      campos.lat = r1(place.lat);
      campos.lon = r1(place.lon);
      campos.radio_km = p.radio;
      campos.mag_min = p.mag;
    }
    return campos;
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (_) {
    return; // sin service worker activo: el botón queda oculto de más arriba
  }

  async function resubscribe() {
    const actual = await reg.pushManager.getSubscription();
    if (!actual) return; // los controles de zona están ocultos si no hay suscripción
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...actual.toJSON(), ...camposZona() }),
    }).catch(() => {});
  }

  [zonaToggle, zonaRadio, zonaMag, kitToggle].forEach((el) => {
    if (el) el.addEventListener('change', resubscribe);
  });

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
        body: JSON.stringify({ ...sub.toJSON(), ...camposZona() }),
      });
      pintar(true);
    } catch (_) {
      alert('No se pudo activar los avisos de emergencia. Intenta de nuevo más tarde.');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── "Preparar mi zona": pack offline de emergencia + tiles ─────
// Los 4 JSON de emergencia (nacionales), comunas, y los "vivos" (sismos,
// alertas, avisos, estaciones, status) pasan por fetch normal (sin
// cache:'no-store') para que el fetch handler de sw.js los persista en
// DATA_CACHE tal como ya hace con el resto de la app (ver sw.js:129-142;
// comunas.json se agregó al regex isData ahí mismo). Los tiles van aparte,
// fijados a mano en PACK_CACHE vía postMessage (sin límite LRU).
const PACK_JSON = [
  'emergencia.json', 'tsunami_vias.json', 'tsunami_areas.json', 'remociones.json',
  'comunas.json', 'sismos.json', 'alertas.json', 'avisos.json', 'cortes.json', 'estaciones.json', 'status.json',
];
// Incluye 8-10 porque ensureMap() abre en zoom 8: sin esos niveles, offline
// la vista inicial saldría con tiles rotos (a esa escala son 1-2 tiles por zoom).
const PACK_ZOOMS = [8, 9, 10, 11, 12, 13, 14];
// 0.15° (el radio "natural" para cubrir una comuna) da ~370 tiles en los zooms
// altos: muy por sobre el presupuesto. 0.08° da ~110-120, dentro del rango
// buscado y ya cubre holgadamente el radio urbano de una comuna.
const PACK_RADIO_DEG = 0.08;
const PACK_MAX_DIAS = 30;

function lonATileX(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
function latATileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}
// Misma fórmula que Leaflet (_getSubdomain) para que la URL fijada coincida
// exacto con la que el tileLayer en vivo va a pedir — si no coinciden, el
// cache-first de PACK_CACHE en sw.js nunca hace match y el pack no sirve de nada.
function tileSubdomain(x, y) {
  const subs = 'abcd';
  return subs[Math.abs(x + y) % subs.length];
}

function packTileUrls(lat, lon) {
  const tmpl = TILES[isDark() ? 'dark' : 'light'];
  const r = (window.devicePixelRatio || 1) > 1 ? '@2x' : ''; // igual que b.retina en Leaflet
  const urls = [];
  for (const z of PACK_ZOOMS) {
    const [x1, x2] = [lonATileX(lon - PACK_RADIO_DEG, z), lonATileX(lon + PACK_RADIO_DEG, z)].sort((a, b) => a - b);
    const [y1, y2] = [latATileY(lat + PACK_RADIO_DEG, z), latATileY(lat - PACK_RADIO_DEG, z)].sort((a, b) => a - b);
    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        urls.push(tmpl.replace('{s}', tileSubdomain(x, y)).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', r));
      }
    }
  }
  return urls;
}

function savedPack() {
  try {
    const raw = localStorage.getItem('sinoptica.pack');
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.fecha === 'string' && typeof p.name === 'string') return p;
    }
  } catch (_) { /* localStorage puede no estar disponible */ }
  return null;
}

function pintarPackStatus() {
  const btn = $('#pack-btn');
  const status = $('#pack-status');
  if (!btn || !status) return;
  const pack = savedPack();
  if (!pack) {
    status.hidden = true;
    btn.textContent = '📦 Preparar mi zona (offline)';
    return;
  }
  const dias = Math.floor((Date.now() - new Date(pack.fecha).getTime()) / 86400000);
  status.hidden = false;
  status.textContent = dias > PACK_MAX_DIAS
    ? `Tu zona (${pack.name}) se preparó hace ${dias} días — prepárala de nuevo.`
    : `Tu zona (${pack.name}) quedó lista para usarse sin conexión (preparada el ${new Date(pack.fecha).toLocaleDateString('es-CL')}). El pronóstico offline es el último visto; los datos en vivo requieren conexión.`;
  btn.textContent = '📦 Preparar de nuevo';
}

async function prepararZona() {
  const btn = $('#pack-btn');
  const status = $('#pack-status');
  if (!btn || !status || !('serviceWorker' in navigator)) return;
  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (_) {
    return;
  }
  if (!reg.active) return;

  btn.disabled = true;
  status.hidden = false;
  status.textContent = 'Preparando tu zona…';

  if (savedPack()) {
    // "Preparar de nuevo": espera la confirmación del borrado antes de
    // repoblar, para no repoblar en la caché que está por desaparecer.
    await new Promise((resolve) => {
      const onClear = (e) => {
        if (e.data && e.data.type === 'pin-cleared') listo();
      };
      const listo = () => {
        navigator.serviceWorker.removeEventListener('message', onClear);
        resolve();
      };
      navigator.serviceWorker.addEventListener('message', onClear);
      reg.active.postMessage({ type: 'pin-clear' });
      setTimeout(listo, 3000); // no bloquear indefinidamente si el SW no respondió
    });
  }

  await Promise.allSettled(PACK_JSON.map((f) => fetch(f)));

  const urls = packTileUrls(place.lat, place.lon);
  await new Promise((resolve) => {
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.type === 'pin-progress') {
        status.textContent = `Preparando tu zona… ${d.done}/${d.total}`;
      } else if (d.type === 'pin-done') {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        try {
          localStorage.setItem('sinoptica.pack', JSON.stringify({ fecha: new Date().toISOString(), name: place.name }));
        } catch (_) { /* opcional */ }
        pintarPackStatus();
        if (d.fallidos > 0) status.textContent += ` (${d.fallidos} tiles no se pudieron guardar)`;
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    reg.active.postMessage({ type: 'pin-tiles', urls });
  });

  btn.disabled = false;
}

function setupPack() {
  const btn = $('#pack-btn');
  if (!btn || !('serviceWorker' in navigator)) { if (btn) btn.hidden = true; return; }
  pintarPackStatus();
  btn.addEventListener('click', () => {
    prepararZona().catch(() => { btn.disabled = false; });
  });
}

setupPack();

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
loadMarea();
loadTsunami();
loadCortes();

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
  const updates = [estacionesData, sismosData, incendiosData, alertasData, volcanesData, avisosData, biasData, mareaData, tsunamiData, cortesData]
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
  loadMarea();         // marea.json (Open-Meteo Marine, no oficial)
  loadTsunami();       // tsunami.json (PTWC + catálogo sísmico propio)
  loadCortes();        // cortes.json (SEC, best effort vía satélite en omen)
  // El satélite no tiene JSON propio (fetch cross-origin a GIBS) y solo se
  // recarga si la capa está activa: sin esto no habría forma de ver frames
  // nuevos sin apagar y prender la capa a mano.
  if (capasActivas.has('satelite')) loadSatelite();
  refreshing = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAll();
  else detenerReproduccionSatelite(); // pestaña oculta: no seguir animando en segundo plano
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
