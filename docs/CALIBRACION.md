# Vigía — Plan definitivo de calibración científica

> Escrito el 2026-06-10. Combina (a) el análisis multi-agente verificado contra `ingesta/*.py` y el estado real de `data/clima.db`, y (b) la verificación empírica de las fuentes de datos históricos. Objetivo: meter más ciencia y maximizar la exactitud del pronóstico, para 1 dev sin GPU, sin sobre-ingeniería y sin prometer mejoras que los datos no sostienen.

## TL;DR — el cambio de paradigma

El error dominante y atacable **no** es la física de los modelos globales (a ECMWF no se le gana), sino el **sesgo local sistemático**: a 9-25 km de resolución, ningún modelo resuelve la inversión térmica del valle de Santiago, la vaguada costera de Valparaíso ni el gradiente de Los Libertadores (2.955 m). En esos puntos el modelo tiene un *offset casi constante*, estimable y restable. **Corregir ese offset y combinar los modelos = el 80 % de la ganancia con el 10 % del esfuerzo.**

El análisis inicial concluía "hay que esperar 4-8 semanas a que el archivo propio madure". **Eso es falso**, y es la corrección clave de este plan: existe **data histórica abundante y verificada** que permite entrenar la calibración **hoy**, no en meses.

---

## 0. Realidad verificada del archivo propio (no asumida)

Estado real de `data/clima.db` consultado en vivo:

| Hecho | Valor real |
|---|---|
| `run_tag` distintos archivados | 2 corridas consecutivas (arranque reciente) |
| Filas de pronóstico | 174.720 (ECMWF lleva el ensamble) |
| Ensamble | **solo `temperature_2m`**, 51 miembros |
| Observaciones | ~12 h de rango |
| Pares fc/obs con `lead>0` | 210, todos en lead 1-2 h; **0 con lead>24 h** |
| Estaciones con par útil | 3 METAR; las 10 DMC aún sin pares |

**Conclusión:** el archivo propio aún no tiene señal estadística. El JOIN fc/obs y el cálculo de bias ya funcionan en `verify.py` (snapshot de esa fecha: el bias no se aplicaba aún; hoy lo aplica `calibrate.py`, ver §9). Si dependiéramos solo de este archivo, habría que esperar. Por eso entra el acelerador histórico (§2).

---

## 1. Diagnóstico: dónde está la oportunidad

- **No se le gana a ECMWF en la escala sinóptica** con recursos de 1 persona. Descartado.
- **El offset local sistemático es el objetivo.** Evidencia coherente del propio archivo (n=6, ilustrativo): en lead 1-2 h, GFS sobreestima +1,07 °C (MAE 1,60) mientras ICON va casi perfecto (bias +0,08, MAE 0,35). Es la firma exacta del sesgo por modelo que una corrección de media decreciente neutraliza.
- **La jugada:** corregir el offset de modelos buenos y combinarlos. EMOS y ML son refinamiento incremental sobre ese cimiento.

---

## 2. El acelerador histórico (la pieza que rompe el cuello de botella)

**Verificado empíricamente el 2026-06-10** (no asumido):

| Pieza | Fuente | Cobertura | Estado |
|---|---|---|---|
| Pronóstico histórico **por modelo** | Open-Meteo Historical Forecast API (`historical-forecast-api.open-meteo.com`) | desde ~2021-2022 | ✅ probado: devuelve `temperature_2m_ecmwf_ifs025`, `_gfs_seamless`, etc. por separado |
| Pronóstico histórico **por plazo (lead)** | Open-Meteo Previous Runs API | mayoría desde ene-2024; GFS desde mar-2021 | ✅ confirmado |
| Observación real **de la estación** (ground truth) | Iowa State ASOS archive | décadas (SCEL 1972, SCTB 1937, SCVM 2003…) | ✅ probado: CSV horario de los 5 aeropuertos |
| Reanálisis de respaldo / predictores | ERA5 (`archive-api.open-meteo.com`) | desde 1940 | ✅ probado |

**Qué desbloquea:** se puede construir un dataset de entrenamiento con **1-5 años de pares (pronóstico-de-cada-modelo-a-lead-L, observación-real)** y ajustar los parámetros de calibración **ahora**, en vez de arrancar de cero y esperar.

**Matiz honesto del ground truth (decisivo):**
- **Usar la observación real de la estación, no ERA5, para entrenar.** ERA5 es reanálisis a la misma escala gruesa que los modelos → corrige errores de modelo pero **no** el sesgo de microescala (que es justo lo que más vale en Chile central). Iowa ASOS es la observación puntual real → ground truth correcto.
- **Cobertura asimétrica:** las **5 estaciones METAR** (Pudahuel, Tobalaba, Torquemada, Rodelillo, Santo Domingo) tienen ground truth histórico real → **bootstrap completo posible hoy**. Las **10 estaciones DMC** (Quinta Normal, Quillota, etc.) no tienen histórico trivial vía ASOS → siguen el camino online (archivo propio) o usan el histórico DMC (producto RE3017, a confirmar) / ERA5 como proxy parcial.

**Estrategia de dos caminos que reconcilia todo:**
- **Bootstrap (batch, histórico):** entrena los parámetros (bias inicial por celda, pesos de blending, coeficientes EMOS, modelo ML) con años de datos históricos. Disponible ya para las 5 METAR.
- **Mantenimiento (online, archivo propio):** el EWMA causal sigue actualizando los parámetros con cada corrida nueva, para las 15 estaciones, adaptándose a cambios.

El bootstrap **pre-calienta** el sistema: en vez de inicializar el bias en 0 y esperar semanas, se inicializa con el valor histórico ya estimado.

**Caveat del ensamble:** el EMOS (peldaño 3) necesita los 51 miembros. El histórico de *ensamble* de Open-Meteo es más corto que el de deterministas, así que EMOS se bootstrappea parcialmente; el bias y el blending (deterministas) se bootstrappean por completo.

---

## 3. La escalera de calibración (por ROI), con el "cuándo" reconciliado

| # | Técnica | Ganancia esperada | Complejidad | Bootstrap histórico | Cuándo (con histórico) |
|---|---|---|---|---|---|
| 1 | **Bias EWMA por celda** | −10/−30 % MAE temp | Baja | ✅ completo (METAR) | **Ya** (METAR); online el resto |
| 2 | **Blending multi-modelo** | −5/−15 % MAE extra | Baja | ✅ completo (METAR) | **Ya** (METAR) |
| 3 | **EMOS/NGR** (probabilístico) | CRPS −10/−20 %, cobertura→~90 % | Media | ⚠️ parcial (ensamble corto) | Semanas (mejor que meses) |
| 4 | Kalman bias | −2/−8 % RMSE vs EWMA | Media | n/a (online) | Solo si hay no-estacionariedad probada |
| 5 | **ML (GBM/QRF)** | −5/−15 % extra (mejor caso) | Alta | ✅ con histórico (METAR, 1,5+ años cubre invierno y verano) | **Ya factible** (METAR); antes era "6-12 meses" |

### Peldaño 1 — Corrección de sesgo por media decreciente (EWMA)
Por cada celda `(estación, modelo, variable, bucket_lead)`, un único número: el sesgo medio reciente, restado al pronosticar.
```
bₜ = (1 − w)·bₜ₋₁ + w·(fcₜ − obₜ)        # error con signo
fc_corregido = fc_crudo − b
```
`w` (decay) **es la regularización**: un EWMA de un parámetro no memoriza ruido. Ganancia honesta: **−10 a −30 % MAE** en temperatura (extremo alto en microclimas de sesgo grande y estable), −5/−20 % en humedad/rocío/presión/viento. **No −70 %** (esa cifra es de literatura Kalman en sitios patológicos).
**Trampas por variable:** `precipitation` NO (da negativos; además obs cada 6 h vs fc horario → excluir); `wind_direction` en componentes u/v (no restar grados, bug 350°/10°); `cloud_cover` clip [0,100]. Aplicar limpio solo a `temperature_2m`, `dew_point_2m`, `pressure_msl`, `relative_humidity_2m` (clip 0-100), `wind_speed_10m` (clip ≥0).
**Con histórico:** inicializar `b` por celda con el bias estimado de 1-2 años (METAR). Arranca corrigiendo desde el día 1.

### Peldaño 2 — Blending multi-modelo ponderado por skill inverso
```
wᵢ = 1 / (MAEᵢ² + ε)
fc_blend = Σᵢ wᵢ·fc_corr,ᵢ / Σᵢ wᵢ
```
Combina los 5 deterministas ya de-sesgados, pesando menos al que más falla en esa celda. La media de modelos buenos casi siempre bate al mejor individual. **−5/−15 % MAE adicional**, ROI alto, overfitting bajo. Pesos derivables del skill histórico (METAR) → disponible ya.

### Peldaño 3 — EMOS / NGR para temperatura (probabilístico calibrado)
Convierte los 51 miembros del ensamble en una distribución calibrada:
```
N( a + b·ens_mean , c + d·ens_var )    c,d ≥ 0
ĵ = argmin Σ CRPS(N(μ,σ), obs)         # scipy L-BFGS-B, forma cerrada para Normal
```
Da bandas honestas ("70 % de probabilidad de que la mínima esté entre X e Y") y P(T<0 °C) creíbles. **CRPS −10/−20 %** y **cobertura de ~30-50 % real → ~90 % nominal** (eso es lo valioso). El MAE central casi no mejora sobre un buen EWMA: EMOS aporta *incertidumbre calibrada*, no exactitud puntual.

> **VERIFICADO 2026-06-10 — EMOS NO es bootstrappeable; debe esperar al archivo propio.** A diferencia del bias y el blending (entrenados HOY con histórico determinista Previous Runs + ASOS), EMOS necesita los 51 miembros del ensamble, y Open-Meteo los entrega **solo en el pronóstico en vivo**: en el histórico vienen todos en `None`. Medido: los miembros existen apenas desde ~2 días atrás (no los ~90 que se asumían). Por tanto EMOS depende exclusivamente del **archivo propio del ensamble** (iniciado 2026-06-09) y requiere ~6-8 semanas de acumulación. El método queda especificado (NGR + min CRPS; **se puede sin scipy** con un optimizador Nelder-Mead en stdlib, evitando la dependencia pesada en Alpine); solo falta el dato. No se implementa ahora: sería código muerto entrenando sobre ruido.

### Peldaño 4 — Kalman adaptativo (solo si hay no-estacionariedad probada)
Filtro escalar que deja evolucionar el bias cuando no es constante (inversión térmica estacional). **−2/−8 % RMSE sobre el EWMA ya hecho** — incremental. El EWMA con `w` ajustable ya da el 90 %. Hacer solo si se *mide* no-estacionariedad en celdas concretas (SCEL, valle, costa). ROI bajo.

### Peldaño 5 — ML (gradient boosting / quantile regression forests)
Aprende correcciones no lineales con covariables (modelo, hora, mes, dirección de viento, gradiente costa-valle-cordillera). sklearn/lightgbm en CPU bastan. **−5/−15 % adicional en el mejor caso**, riesgo de overfitting el más alto. **El histórico lo desbloquea ahora** para las METAR: 1,5+ años cubren invierno y verano, evitando el sobreajuste a un único régimen estacional que antes lo relegaba a "6-12 meses".

---

## 4. Verificación: probar que cada peldaño mejora (sin trampa)

Regla de oro: **una técnica sube a producción solo si bate a su baseline en validación temporal honesta.**

Métricas a añadir a `verify.py` (hoy solo MAE/bias de temperatura):
1. **MAE y bias por las 7 variables continuas** (parametrizar el `VARIABLE` actual).
2. **RMSE** además de MAE (revela reducción de outliers).
3. **CRPS** para ensamble/EMOS: `CRPS(F,y)=∫(F(x)−1{x≥y})²dx`, forma cerrada Normal.
4. **Reliability / cobertura:** del intervalo nominal 90 %, ¿qué fracción real cae dentro? Debe tender a 90 %. Es la prueba de que EMOS sirve.
5. **Skill score vs baseline:** `Skill = 1 − MAE_técnica / MAE_baseline`, baseline = Open-Meteo `best_match` crudo. **Esta es la métrica que decide**: >0 sube, ≤0 no.

**Evitar data leakage:**
- **Rolling-origin / walk-forward:** entrena con `[inicio, t)`, evalúa en `t`, avanza. El k-fold aleatorio mete futuro en el pasado → prohibido en series temporales. **Esto vale también para el bootstrap histórico:** el holdout debe ser temporal (entrenar con años previos, validar en el periodo más reciente).
- **Gate de muestra mínima:** no corregir si `n < 7-10`; caer a crudo. Con `n` bajo, **shrinkage** `b_aplicado = b·n/(n+k)` (k≈5-10).
- Mantener el descarte de `lead≤0` (en `verify.py`): es nowcast/asimilación, infla la exactitud artificialmente (los "4940 pares" eran 96 % lead≤0; solo 210 son pronóstico real).

---

## 5. Cambios de ingesta necesarios

1. **[YA, irrecuperable si se posterga] Ampliar el ensamble a más variables.** Hoy `ENSEMBLE_VARS=["temperature_2m"]` (`config.py:62`). Sin ensamble de viento/precipitación **nunca** habrá EMOS para ellas, y el dato no se recupera. Añadir `wind_speed_10m` y `precipitation` (verificar cuota 10.000 llamadas/día y que `ensemble-api` las ofrezca). **Es el cambio de mayor valor a largo plazo y el más barato ahora.** Nota: aunque el bootstrap histórico cubre deterministas, el *ensamble* propio sí hay que acumularlo desde ya.
2. **[Pronto] Columna `altitude` en `stations`** (hoy solo id/nombre/lat/lon, `db.py:7-12`). Habilita corrección adiabática (lapse-rate) y ponderar estaciones por similitud topográfica. ALTER TABLE + poblar las 15.
3. **[Pronto] Derivar predictores** (hora, mes/estación) de `valid_time` para el ML. No requiere esquema nuevo.
4. **[Nuevo, por el acelerador] Tabla/pipeline de bootstrap histórico:** un script batch que descarga Previous Runs (pronóstico por modelo y lead) + Iowa ASOS (obs) y puebla la tabla `bias` y los parámetros de calibración inicial. Se corre una vez (y se re-corre al ampliar cobertura).

---

## 6. Plan de ejecución reordenado (con el acelerador)

**Quick wins inmediatos (hoy, sin esperar):**
1. Ampliar `ENSEMBLE_VARS` a viento y precipitación — activo irrecuperable del ensamble propio.
2. Añadir columna `altitude` y poblarla.
3. Extender `verify.py` a las 7 variables + RMSE + skill score vs `best_match`.
4. Escribir `ingesta/calibrate.py` (bias EWMA + tabla + gate + shrinkage).
5. **Escribir el bootstrap histórico** (`ingesta/bootstrap_hist.py`): descarga Previous Runs + Iowa ASOS para las 5 METAR, estima el bias inicial y los pesos de blending, puebla la tabla `bias`. **Esto enciende la corrección para las METAR de inmediato**, validada con holdout temporal.
6. Encender bias + blending en producción **para las estaciones con bootstrap** (METAR), tras validar skill>0 con holdout histórico.

**Lo que aún espera (pero menos que antes):**
- EMOS/NGR: semanas (no meses), limitado por histórico de ensamble.
- Calibración de las 10 estaciones DMC: camino online (archivo propio) o conseguir su histórico (RE3017).
- Kalman: solo si se mide no-estacionariedad.
- ML: factible ya para METAR con histórico; para todas, al madurar.

---

## 7. Qué NO hacer (anti-sobre-ingeniería)

- **NO** correr WRF propio ni GraphCast/NeuralGCM: cómputo alto, ganancia marginal para 1 dev sin GPU.
- **NO** empezar por Kalman o ML "porque son más avanzados": saltarse el EWMA barato que da el 90 % es el anti-patrón exacto.
- **NO** entrenar contra ERA5 creyendo que corrige el sesgo local: ERA5 es la escala gruesa del modelo. Ground truth = observación de estación.
- **NO** aplicar corrección con `n` bajo sin gate+shrinkage: degradaría el pronóstico.
- **NO** restar bias a `precipitation` (negativos) ni a `wind_direction` en grados.
- **NO** afirmar mejora sin holdout temporal: in-sample es leakage.
- **NO** confiar en el conteo bruto de pares (96 % son lead≤0 nowcast).
- **NO** migrar a PostgreSQL: SQLite sobra para estos volúmenes.

---

## 8. Código de arranque — módulo de bias-correction

`ingesta/calibrate.py`. Reusa el JOIN exacto de `verify.py:19-30`. Gate + shrinkage integrados para no corregir ruido. El bootstrap histórico puebla la misma tabla `bias`.

```python
"""Corrección de sesgo por media decreciente (EWMA) por celda.

Estima un bias por (estación, modelo, variable, bucket_lead) y lo persiste
para que el pronóstico servido lo reste. Un parámetro por celda; el decay (w)
es la regularización -> no overfittea. NO corrige si n < N_MIN (gate) y aplica
shrinkage hacia 0 con n bajo. El bootstrap histórico inicializa esta tabla.
"""
import math
import config

W = 0.15                 # decay alto al inicio; bajar a ~0.05 al madurar
N_MIN = 7                # gate: por debajo, fc crudo
K_SHRINK = 8             # shrinkage: b_aplicado = b * n/(n+K)
BUCKETS = [(0, 24, "24"), (24, 48, "48"), (48, 72, "72"), (72, 96, "96")]
ADDITIVE_VARS = ["temperature_2m", "dew_point_2m", "pressure_msl",
                 "relative_humidity_2m", "wind_speed_10m"]
CLIP = {"relative_humidity_2m": (0, 100), "wind_speed_10m": (0, None),
        "cloud_cover": (0, 100)}

SCHEMA = """
CREATE TABLE IF NOT EXISTS bias (
  station  TEXT NOT NULL, model TEXT NOT NULL, variable TEXT NOT NULL,
  lead     TEXT NOT NULL,           -- bucket "24"/"48"/"72"/"96"
  b        REAL NOT NULL,           -- bias EWMA (fc - obs)
  n        INTEGER NOT NULL,        -- pares vistos (gate y shrinkage)
  updated  TEXT NOT NULL,
  PRIMARY KEY (station, model, variable, lead)
);
"""

def _bucket(lead):
    for lo, hi, key in BUCKETS:
        if lo < lead <= hi:
            return key
    return None

def update(con):
    """EWMA causal por celda sobre los pares fc/obs. Mismo JOIN que verify.py."""
    con.executescript(SCHEMA)
    sql = """
    SELECT f.station, f.model, f.variable,
           CAST((julianday(f.valid_time) - julianday(f.run_tag||':00')) * 24 AS INTEGER),
           f.value, o.value
    FROM forecasts f
    JOIN observations o
      ON o.station = f.station AND o.variable = f.variable
     AND o.obs_time = f.valid_time || ':00Z'
    WHERE f.member = -1 AND f.variable IN ({})
    ORDER BY f.run_tag
    """.format(",".join("?" * len(ADDITIVE_VARS)))
    cur = {}
    for st, mdl, var, lead, fc, ob in con.execute(sql, ADDITIVE_VARS):
        if fc is None or ob is None or lead is None or lead <= 0:
            continue
        key = _bucket(lead)
        if key is None:
            continue
        cell = (st, mdl, var, key)
        b, n = cur.get(cell, (None, 0))
        err = fc - ob
        b = err if b is None else (1 - W) * b + W * err
        cur[cell] = (b, n + 1)
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
    for (st, mdl, var, key), (b, n) in cur.items():
        con.execute("INSERT OR REPLACE INTO bias VALUES (?,?,?,?,?,?,?)",
                    (st, mdl, var, key, round(b, 3), n, now))
    con.commit()
    return len(cur)

def correct(con, station, model, variable, lead_hours, fc_value):
    """Aplica el bias persistido. Gate + shrinkage: con n bajo, fc crudo."""
    if variable not in ADDITIVE_VARS or fc_value is None:
        return fc_value
    key = _bucket(lead_hours)
    if key is None:
        return fc_value
    row = con.execute(
        "SELECT b, n FROM bias WHERE station=? AND model=? AND variable=? AND lead=?",
        (station, model, variable, key)).fetchone()
    if not row:
        return fc_value
    b, n = row
    if n < N_MIN:
        return fc_value
    b_eff = b * n / (n + K_SHRINK)
    out = fc_value - b_eff
    lo, hi = CLIP.get(variable, (None, None))
    if lo is not None: out = max(lo, out)
    if hi is not None: out = min(hi, out)
    return out
```

**Boceto de la pipeline de bootstrap histórico** (`ingesta/bootstrap_hist.py`, el acelerador):
```
para cada estación METAR (SCEL, SCTB, SCVM, SCRD, SCSN):
    obs   = descargar Iowa ASOS (mesonet.agron.iastate.edu) -> serie horaria real
    para cada modelo (ecmwf_ifs025, gfs_seamless, icon_seamless, gem_seamless, meteofrance_seamless):
        fc = Open-Meteo Previous Runs API -> pronóstico por lead time
        emparejar (fc[lead], obs[valid_time]) sobre el histórico común
        por bucket de lead: bias inicial = media(fc - obs);  MAE = media|fc - obs|
    escribir en tabla bias (b inicial, n = nº pares históricos)
    derivar pesos de blending = 1/(MAE²+ε)
validar con holdout temporal (últimos ~2 meses) -> skill score vs best_match
```
Notas: usar **Previous Runs** (no Historical Forecast "stitched") para tener leads largos reales; alinear timezones (todo UTC); respetar el holdout temporal (entrenar con lo viejo, validar con lo reciente); el ground truth es Iowa ASOS, **no** ERA5.

---

## 9. Estado de implementación (2026-06-10) — IMPLEMENTADO y EN PRODUCCIÓN

Los peldaños 1-2 (bias + base de blending) están implementados, verificados y en vivo:

- **`ingesta/calibrate.py`** — bias EWMA por celda con gate (N_MIN=7) + shrinkage. Integrado en el cron (`run.py`); publica `bias.json`.
- **`ingesta/bootstrap_hist.py`** — descarga histórico real (Open-Meteo Previous Runs + Iowa ASOS) y estima el bias HOY para las 5 estaciones METAR.
- **`verify.py`** extendido a 5 variables continuas + RMSE.
- **Frontend** — aplica la corrección a las series de los modelos y a la tabla cuando hay estación validada a <35 km; badge "✓ calibrado". Fallback seguro a crudo.

**Resultado verificado en holdout temporal (ene→jun 2026, 95 celdas, sin leakage):**

| Método | Skill medio (↓MAE) | Celdas que mejoran |
|---|---|---|
| Media global (naive) | −0.002 | 49% |
| Bias por hora del día | +0.018 | 52% |
| **EWMA (implementado)** | **+0.210** | **94%** |

El EWMA gana porque sigue la no-estacionariedad del sesgo. Caso extremo: SCSN/GFS a 96 h pasó de MAE 4.41 a **2.15 (−51%)**. Decisión de método tomada comparando los 3 approaches empíricamente, no por intuición.

**Blending "Vigía" (peldaño 2) — IMPLEMENTADO, con corrección de rumbo verificada.** Comparé 5 approaches por MAE en holdout antes de elegir:

| Approach | MAE (test) |
|---|---|
| **Blend top-2** (implementado) | **2.222** |
| ECMWF corregido | 2.238 |
| Selección del mejor | 2.263 |
| Blend de los 5 | 2.364 |

El blend ingenuo de los 5 modelos **degradaba** (peor que ECMWF solo): incluir los modelos malos contamina al dominante. El ganador es el **blend de los 2 mejores por celda**, ponderados por 1/mae². Se muestra como la serie destacada "Vigía" en el gráfico. Lección: la intuición "promediar todo mejora" es falsa cuando un modelo domina — había que medir.

**Alcance actual:** calibración activa para las 5 estaciones METAR (validadas con holdout). Las 10 EMA de la DMC usan el mismo método EWMA pero esperan a acumular muestra propia (N_EXPORT=40) antes de servirse, porque no tienen histórico ASOS para validar. **Pendiente** (peldaños siguientes): EMOS para incertidumbre calibrada, blending ponderado servido como pronóstico principal, y calibrar el `best_match` diario.

## Resumen ejecutivo

1. **El sesgo local es la oportunidad**, no la física del modelo.
2. **El histórico (Previous Runs + Iowa ASOS) rompe el cuello de botella de calendario**: bias y blending se pueden encender **ya** para las 5 estaciones METAR, con holdout histórico que prueba la mejora.
3. **Escribir ya:** ampliar `ENSEMBLE_VARS`, `altitude`, `verify.py` extendido, `calibrate.py`, `bootstrap_hist.py`.
4. **Las 10 estaciones DMC** maduran online (o con su histórico RE3017).
5. **EMOS** en semanas; **ML** factible ya para METAR; **Kalman** solo si se mide no-estacionariedad.
6. **Nada sube a producción sin skill score >0 en holdout temporal.** La honestidad de la verificación es la marca del proyecto.

---

*Análisis multi-agente (88 agentes) + verificación empírica de fuentes históricas. Archivos: `ingesta/verify.py`, `ingesta/db.py`, `ingesta/config.py`, `PROPUESTA.md`. Nuevos a crear: `ingesta/calibrate.py`, `ingesta/bootstrap_hist.py`.*
