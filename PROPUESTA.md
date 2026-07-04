# App de clima para Chile — propuesta técnica

> Investigación verificada el 2026-06-09. Objetivo: la app de clima científicamente más sólida posible para Chile (foco V Región + RM), 100% gratis y open source, con modelo de predicción propio.

> **⚠️ Documento histórico (propuesta, no estado actual).** La implementación real difiere en varios puntos: stack Python stdlib + SQLite (no FastAPI/PostgreSQL), 15 estaciones (5 METAR + 10 DMC, no 50-100), frontend que consulta Open-Meteo directo desde el navegador, y sin Agromet/RedMeteo. El estado vigente está en `README.md` y `docs/CALIBRACION.md`.

## 1. ¿V Región + RM o todo Chile?

Las dos cosas, en capas distintas — y la restricción regional **sí tiene una ventaja real, pero no donde parece**:

- **Pronóstico base**: los modelos numéricos que alimentan Open-Meteo son globales (ECMWF IFS ~9 km, GFS, ICON). Cubrir todo Chile cuesta exactamente lo mismo que cubrir dos regiones. No hay ventaja en restringir aquí.
- **Capa científica (calibración + verificación)**: aquí la restricción a V + RM es una ventaja enorme. Calibrar un modelo propio exige observaciones reales por estación, conocimiento de microclimas y verificación continua. Con ~50-100 estaciones entre DMC y Agromet en esas dos regiones, el problema es tratable para un solo desarrollador; con todo Chile (de Visviri a Tierra del Fuego, con regímenes climáticos opuestos) no lo es.

**Estrategia recomendada**: la app muestra todo Chile con pronóstico multi-modelo de calidad, y la V Región + RM reciben la capa diferenciadora — pronóstico calibrado localmente con verificación publicada. Si funciona, se extiende región por región.

## 2. Fuentes de datos verificadas (todas gratuitas)

| Fuente | Qué entrega | Acceso | Condiciones |
|---|---|---|---|
| [Open-Meteo](https://open-meteo.com/) | Pronóstico de 30+ modelos (ECMWF, GFS, ICON, etc.), **Ensemble API** (hasta 51 miembros), histórico ERA5 desde 1940, calidad del aire CAMS | JSON sin API key | Gratis no comercial, 10.000 calls/día; datos CC BY 4.0, servidor AGPLv3 |
| [DMC — Servicios Climáticos](https://climatologia.meteochile.gob.cl/) | Observaciones oficiales de estaciones automáticas chilenas, web services JSON | Público citando la fuente | Confirmar al implementar si el web service pide registro gratuito |
| [Agromet INIA](https://agromet.inia.cl/) | ~400 estaciones en Chile, datos cada 15 min (temperatura, humedad, viento, precipitación, radiación, presión) | Descarga sin restricciones | Muchas estaciones en zonas agrícolas de V y RM |
| [SINCA — MMA](https://sinca.mma.gob.cl/) | Calidad del aire oficial (MP2.5, MP10, O₃, SO₂, CO), actualización horaria | Portal público, sin API formal documentada | Riesgo medio: usar los endpoints JSON del mapa interactivo o [aqicn](https://aqicn.org/network/cl-mma/es/) como fallback |
| [RedMeteo](https://redmeteo.cl/api.html) | Red de estaciones aficionadas chilenas con API | API pública | Densifica cobertura urbana; calidad heterogénea (usar solo para visualización, no calibración) |

## 3. Por qué puede ser más sólida que las apps comerciales

La mayoría de las apps (incluidas las grandes) muestran **un solo modelo determinista, crudo, sin calibración local y sin verificación publicada**. Los tres pilares que te ponen por encima:

1. **Pronóstico probabilístico real**: usar el ensamble (51 miembros de ECMWF IFS ENS vía Open-Meteo) para mostrar incertidumbre honesta — "70% de probabilidad de que la máxima esté entre 24 y 27 °C", no un número mágico.
2. **Calibración local**: los modelos globales a 9-11 km no resuelven la vaguada costera del litoral de Valparaíso, la inversión térmica del valle de Santiago ni las brisas valle-montaña. Corregir contra estaciones reales sí los captura.
3. **Verificación continua y pública**: la app archiva cada pronóstico, lo compara con lo observado y publica sus métricas (MAE, CRPS, skill score vs modelo crudo) por estación. Casi nadie en el mundo comercial hace esto. Es el sello de seriedad científica.

Honestidad por delante: **no vas a superar a ECMWF en la escala sinóptica** — nadie lo hace con recursos de una persona. Donde sí puedes ganarle a las apps es en el último kilómetro: sesgo local de temperatura, viento y niebla en ubicaciones específicas de V y RM, más transparencia total de aciertos y errores.

## 4. El modelo propio: post-procesamiento estadístico

**Qué NO hacer** (sobre-ingeniería para un solo dev): correr WRF propio o entrenar un modelo neural de circulación (GraphCast/NeuralGCM). Costo de cómputo y mantenimiento altísimo, ganancia marginal frente a ECMWF.

**Qué SÍ hacer**: post-procesamiento estadístico de los modelos globales contra observaciones locales — la técnica que usan operativamente los servicios meteorológicos nacionales (Météo-France usa quantile regression forests). Escalera incremental, cada nivel ya es publicable:

1. **Baseline**: Open-Meteo crudo (`best_match`) — lo que muestran las demás apps. Es tu vara de comparación.
2. **Nivel 1 — corrección de sesgo por estación**: media de errores recientes por hora del día y variable (temperatura, viento). Con 4-8 semanas de datos archivados ya mejora el pronóstico. Trivial de implementar.
3. **Nivel 2 — EMOS** (Ensemble Model Output Statistics, [Gneiting et al.](https://www.researchgate.net/publication/228930829_Calibrated_Probabilistic_Forecasting_Using_Ensemble_Model_Output_Statistics_and_Minimum_CRPS_Estimation)): regresión sobre los miembros del ensamble minimizando CRPS → distribución predictiva calibrada. El estándar operativo mundial.
4. **Nivel 3 — ML**: gradient boosting o [quantile regression forests](https://npg.copernicus.org/articles/30/503/2023/) con covariables (modelo de origen, hora, estación del año, dirección del viento, geografía). Estado del arte operativo; las redes cuantílicas (QRNN/BQN) son la frontera académica si quieres llegar ahí.

**Datos de entrenamiento**: Open-Meteo ofrece API de pronósticos históricos (lo que el modelo dijo ayer sobre hoy) + ERA5; el ground truth son las observaciones DMC/Agromet. Regla de oro: **archivar pronósticos y observaciones desde el día 1** — ese archivo es el activo que ninguna API te regala completo.

## 5. Arquitectura (KISS)

```
[cron horario: Python] → ingesta Open-Meteo (multi-modelo + ensamble)
                       → ingesta observaciones DMC + Agromet (+ SINCA)
                       → PostgreSQL (o SQLite al inicio)

[job diario: Python]   → calibración por estación (scikit-learn)
                       → métricas de verificación (MAE, CRPS, skill)

[FastAPI]              → API propia: pronóstico calibrado + bandas + métricas
[PWA]                  → frontend instalable en celular sin app stores
```

- Un solo VPS chico (o el que ya tienes) lo corre todo; los volúmenes son mínimos.
- Stack 100% open source; la app misma liberable bajo MIT o AGPL.
- PWA antes que app nativa: multiplataforma, cero fricción de stores, instalable en iPhone/Android.

## 6. Fases (estimaciones a mi velocidad de ejecución)

| Fase | Qué | Esfuerzo |
|---|---|---|
| 0 | PWA mínima: pronóstico Open-Meteo multi-modelo para ubicaciones de V/RM (+ buscador todo Chile) | 1 sesión |
| 1 | Ingesta y archivo de pronósticos + observaciones (DMC, Agromet) | 1-2 sesiones |
| 2 | Panel de verificación: error real por modelo y estación, visible en la app | 1 sesión |
| 3 | Calibración: sesgo → EMOS → ML (incremental, requiere semanas de datos acumulados de la fase 1) | iterativo |
| 4 | Calidad del aire SINCA, índice UV, alertas configurables | 1-2 sesiones |

El cuello de botella real no es código: es el **tiempo calendario acumulando datos** para calibrar. Por eso la fase 1 debe partir cuanto antes, aunque la UI esté a medias.

## 7. Referencias del ecosistema

- [Breezy Weather](https://github.com/breezy-weather/breezy-weather) — la mejor app open source actual (Android, 50+ fuentes). Buena inspiración de UI; su límite es justamente que agrega fuentes pero **no calibra ni verifica localmente** — ese es tu diferenciador.
- [open-meteo/open-meteo](https://github.com/open-meteo/open-meteo) — el servidor es open source (AGPLv3); si el proyecto crece, puedes self-hostear la ingesta de modelos.
- [Listado de APIs públicas en Chile](https://github.com/juanbrujo/listado-apis-publicas-en-chile) — catálogo útil de fuentes nacionales.

## 8. Riesgos y condiciones

- **Licencia Open-Meteo**: el tier gratis es solo uso no comercial — perfecto para app personal/open source. Si algún día quieres monetizar: plan pagado (desde ~1M calls/mes) o self-hosting AGPLv3.
- **DMC**: el detalle exacto de registro/límites del web service JSON hay que confirmarlo al implementar la fase 1.
- **SINCA**: sin API formal; los endpoints internos pueden cambiar sin aviso. Mitigación: aqicn como fallback.
- **Atribución obligatoria**: Open-Meteo (CC BY 4.0) y DMC exigen citar la fuente — va en el footer de la app desde el día 1.
