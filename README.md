<div align="center">

# 🌤️ Sinóptica

**Pronóstico del tiempo multi-modelo, con incertidumbre honesta y verificación pública, para Chile central.**

[![Ver en vivo](https://img.shields.io/badge/▞_ver_en_vivo-clima.cavara.cl-c8451f?style=for-the-badge)](https://clima.cavara.cl)
[![Licencia MIT](https://img.shields.io/badge/licencia-MIT-2456c9?style=for-the-badge)](LICENSE)
[![PWA](https://img.shields.io/badge/PWA-instalable-0e9888?style=for-the-badge)](https://clima.cavara.cl)

![Sinóptica en escritorio](docs/hero-desktop.png)

</div>

## Por qué existe

Casi todas las apps de clima muestran **un solo número**, de **un solo modelo**, **sin decir cuánto aciertan**. Sinóptica hace lo contrario, sobre tres pilares:

1. **Incertidumbre real.** Usa el ensamble del ECMWF (51 escenarios) para mostrar una banda de confianza, no una falsa certeza. Banda angosta = alta confianza; banda ancha = la atmósfera está difícil y cualquier número exacto sería mentira.
2. **Cinco modelos, no uno.** ECMWF, NOAA GFS, DWD ICON, ECCC GEM y Météo-France ARPEGE, lado a lado. Cuando discrepan, lo verás: el desacuerdo *es* información.
3. **Verificación pública.** Cada pronóstico se archiva y luego se compara con lo que **realmente midieron** las estaciones. La app publica su propio error (MAE y sesgo) por modelo y por plazo. Casi nadie en el mundo lo hace.

Todo con APIs **gratuitas y abiertas**, sin claves para el usuario, sin tracking, sin CDNs de terceros, sin costo de operación.

> **Foco geográfico:** V Región y Región Metropolitana. El pronóstico funciona para todo Chile (los modelos son globales), pero la capa científica —observaciones reales y verificación— se concentra en las 15 estaciones de esas dos regiones, donde calibrar es tratable para un proyecto pequeño.

## Capturas

| Detalle por día (móvil) | Escritorio (claro) |
|---|---|
| ![Detalle por día](docs/mobile-day.png) | ![Modo claro](docs/desktop-light.png) |

## Características

- 📈 **Banda de ensamble** (10–90 %, 51 miembros) + 5 modelos deterministas superpuestos.
- 🌫️ **Calidad del aire** con el índice **ICAP oficial chileno** (D.S. 12/2011 MMA): nivel, color y consejo de salud, más el pronóstico de MP2,5 — el contaminante crítico del invierno en Chile central.
- 🗺️ **Mapa de observaciones en vivo** con la temperatura medida por 15 estaciones reales.
- 🔍 **Detalle hora a hora** al tocar cualquier día: temperatura multi-modelo, precipitación, UV, sol, viento.
- 🎯 **Panel de verificación** con el acierto de cada modelo por plazo (1 a 4 días), actualizado solo.
- ℹ️ **Explicaciones en cada panel**, en doble registro: simple para cualquiera, riguroso para curiosos (qué significa de verdad «70 % de lluvia», qué es el ensamble, por qué los modelos difieren…).
- 📱 **PWA instalable**, responsive, con modo claro/oscuro automático y funcionamiento offline del último pronóstico visto.

## Cómo funciona

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  web/  (PWA estática)        │         │  ingesta/  (Python stdlib)   │
│  habla directo con Open-Meteo│         │  cron horario en contenedor  │
│  Chart.js · Leaflet · vanilla│         │                              │
└─────────────────────────────┘         │  • pronósticos (5 modelos +  │
            │                            │    ensamble de 51 miembros)  │
            │ lee JSON                   │  • observaciones (METAR+DMC) │
            ▼                            │  • verificación (MAE/sesgo)  │
   status / verificacion /  ◄────────────│  → SQLite + JSON públicos    │
   estaciones .json                      └──────────────────────────────┘
```

- **Frontend** (`web/`): HTML/CSS/JS sin framework. Pinta el pronóstico consumiendo Open-Meteo desde el navegador, y enriquece con los JSON que genera la ingesta.
- **Ingesta** (`ingesta/`): Python 3.12 **solo librería estándar** (`urllib` + `sqlite3`, cero dependencias). Archiva pronósticos y observaciones, y computa la verificación. Ese archivo histórico es el activo que habilitará la calibración local (MOS/EMOS).
- **Deploy** (`deploy/` + `docker-compose.yml`): nginx endurecido + contenedor de cron. Pensado para correr detrás de un Cloudflare Tunnel, sin abrir puertos.

## Correr en local

```bash
# 1. Un ciclo de ingesta (crea data/clima.db y los JSON en web/)
python3 ingesta/run.py --all

# 2. Servir la PWA
python3 -m http.server 8123 -d web   # → http://localhost:8123
```

No necesitas claves: las observaciones llegan por METAR (NOAA, abierto). Para añadir las 10 estaciones automáticas de la DMC, copia `.env.example` a `.env` con tu token del [registro gratuito](https://climatologia.meteochile.gob.cl).

## Desplegar

```bash
docker compose up -d        # web (nginx) + ingesta (cron)
```

El cron archiva observaciones cada hora y pronósticos cada 6 h. Detalle de operación, seguridad y el flujo exacto de actualización en [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Fuentes de datos

| Fuente | Aporta | Licencia |
|---|---|---|
| [Open-Meteo](https://open-meteo.com/) | Pronóstico de 5 modelos + ensamble ECMWF | CC BY 4.0 |
| [Dirección Meteorológica de Chile](https://climatologia.meteochile.gob.cl/) | Observaciones de estaciones automáticas (EMA) | Uso público con atribución |
| Red OMM / METAR vía [NOAA AWC](https://aviationweather.gov/) | Observaciones horarias de aeropuertos | Dominio público |

## Hoja de ruta

- [x] PWA multi-modelo con banda de ensamble
- [x] Ingesta y archivo histórico (SQLite)
- [x] Mapa de observaciones en vivo
- [x] Verificación pública (MAE/sesgo por modelo y plazo)
- [x] Calidad del aire con índice ICAP chileno
- [ ] **Calibración local**: corrección de sesgo → EMOS → ML cuantílico (requiere ~2 semanas de archivo)
- [ ] Mediciones oficiales SINCA en el mapa (ground truth de calidad del aire)
- [ ] Modelo regional chileno WRF de la DMC (4 km) como 6.º modelo
- [ ] Índice UV y alertas configurables

La visión técnica completa está en [`PROPUESTA.md`](PROPUESTA.md).

## Stack

Vanilla JS · [Chart.js](https://www.chartjs.org/) · [Leaflet](https://leafletjs.com/) · Python (stdlib) · SQLite · nginx · Docker. Fuentes [Bricolage Grotesque](https://fonts.google.com/specimen/Bricolage+Grotesque) e [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono), todo vendorizado (sin CDNs).

## Licencia

Código bajo [MIT](LICENSE). Los datos meteorológicos mantienen sus licencias de origen y exigen atribución, presente en la interfaz. Proyecto open source **sin fines comerciales**, hecho en Chile. 🇨🇱
