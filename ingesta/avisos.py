"""Avisos meteorológicos derivados del propio pronóstico multi-modelo.

No es un aviso oficial: son umbrales propios (inspirados en los criterios
públicos de avisos de la Dirección Meteorológica de Chile, y en la regla
30-30-30 de manejo del fuego para el aviso de incendio, pero sin ninguna
relación operativa con la DMC ni con CONAF/SENAPRED) aplicados a la MEDIANA
horaria entre modelos del archivo de pronósticos, en la ventana de 120 h desde
ahora (el archivo llega a 168 h; 120 anticipa temporales largos con margen de
datos incluso con el run más viejo del ciclo, y el campo "acuerdo" transparenta
la confianza del ensamble a ese plazo). Las variables calibrables (temperatura, viento, humedad relativa) se
corrigen por sesgo (calibrate.py) antes de la mediana, para ser consistentes
con el pronóstico que ve el usuario; precipitación y nieve quedan crudas.
avisos.json lo declara explícitamente para que nadie lo confunda con un aviso
oficial.

Sin tabla propia: es barato de recalcular (SQL local + mediana, sin red), así
que se recalcula entero en cada corrida en vez de persistir estado.
"""
import json
import statistics
from datetime import datetime, timedelta, timezone

import calibrate
import config

# Umbrales (derivación propia; ver docstring). máx/mín = pico de la mediana
# horaria entre modelos en la ventana de VENTANA_H; lluvia/nieve = pico de la suma
# móvil de 24 h de esa misma mediana horaria. Viento y calor son umbrales
# FIJOS nacionales — ver _umbral_climatologico para el ajuste por estación.
VIENTO_AMARILLO, VIENTO_NARANJA = 60.0, 90.0     # km/h, máx mediana horaria
HELADA_AMARILLO, HELADA_NARANJA = 0.0, -4.0      # °C, mín mediana horaria
LLUVIA_AMARILLO, LLUVIA_NARANJA = 30.0, 60.0     # mm, máx suma móvil 24 h
CALOR_AMARILLO, CALOR_NARANJA = 34.0, 37.0       # °C, máx mediana horaria
NIEVE_AMARILLO, NIEVE_NARANJA = 10.0, 30.0       # cm, máx suma móvil 24 h

# Umbrales rojos: escalón reservado a eventos extremos (derivación propia,
# ver docstring del módulo). Viento y calor se desplazan por el mismo offset
# aditivo que aplica _umbral_climatologico al amarillo/naranja, para no
# perder la coherencia del ajuste por estación.
VIENTO_ROJO = 120.0    # km/h, máx mediana horaria
CALOR_ROJO = 40.0      # °C, máx mediana horaria
HELADA_ROJO = -8.0     # °C, mín mediana horaria
NIEVE_ROJO = 60.0      # cm, máx suma móvil 24 h

# Aviso lluvia persistente: temporales largos que acumulan agua sin cruzar
# nunca el umbral de 24 h (p.ej. 25 mm/día dos días seguidos) igual saturan el
# suelo y elevan el riesgo de crecidas — exactamente el caso que el aviso de
# lluvia de 24 h no ve. Se emite ADEMÁS del aviso de 24 h si ambos cruzan
# (productos distintos, sin dedupe). Derivación propia, sin relación operativa
# con la DMC, igual que el resto del módulo.
LLUVIA48_AMARILLO, LLUVIA48_NARANJA = 50.0, 90.0  # mm, máx suma móvil 48 h

# Rojo de lluvia por MACROZONA: a diferencia de amarillo/naranja (nacionales),
# el rojo es el escalón de impacto extremo y ahí la geografía pesa — 120 mm/48h
# es un temporal devastador en Valparaíso y un invierno normal en Valdivia.
# Umbral de impacto según climatología regional (referencia real: temporal de
# junio 2023 en la zona central, ~100-150 mm/48 h con daño severo). Derivación
# propia, sin relación operativa con la DMC. Estación sin región reconocida
# usa el umbral del sur (el más exigente = conservador, sin falsos rojos).
LLUVIA_ROJO = {"norte": 50.0, "centro": 80.0, "sur": 120.0}          # mm/24h
LLUVIA48_ROJO = {"norte": 80.0, "centro": 120.0, "sur": 180.0}       # mm/48h

MACROZONA_NORTE = {"XV", "I", "II", "III", "IV"}
MACROZONA_CENTRO = {"V", "RM", "VI", "VII"}
MACROZONA_SUR = {"VIII", "XVI", "IX", "XIV", "X", "XI", "XII"}


def _macrozona(region: str | None) -> str:
    if region in MACROZONA_NORTE:
        return "norte"
    if region in MACROZONA_CENTRO:
        return "centro"
    return "sur"  # incluye MACROZONA_SUR y región desconocida (conservador)

# Aviso aluvional: lluvia intensa + isoterma 0° alta significa que la cuenca
# recibe agua líquida en vez de nieve, con riesgo de crecidas repentinas y
# aluviones en quebradas y laderas. Requiere AMBAS condiciones a la vez sobre
# la misma ventana de 24 h del pico de lluvia (derivación propia, sin
# relación operativa con la DMC, igual que el resto del módulo).
ALUVION_LLUVIA_AMARILLO, ALUVION_LLUVIA_NARANJA = 20.0, 40.0     # mm, suma móvil 24 h
ALUVION_ISOTERMA_AMARILLO, ALUVION_ISOTERMA_NARANJA = 2900.0, 3400.0  # m, mediana en la ventana
# Sin escalón rojo: el aviso ya es compuesto y estricto (requiere AMBAS
# condiciones a la vez), y no hay un tercer punto de corte propio para el
# par lluvia+isoterma que no sea arbitrario — se prefiere no inventarlo.

# Aviso incendio: regla 30-30-30 (criterio establecido en manejo del fuego).
# Temperatura, humedad relativa y viento deben cumplirse en la MISMA hora de
# la mediana multi-modelo. Derivación propia, sin relación operativa con
# CONAF/SENAPRED.
INCENDIO_TEMP_AMARILLO, INCENDIO_TEMP_NARANJA = 30.0, 35.0        # °C
INCENDIO_HR_AMARILLO, INCENDIO_HR_NARANJA = 30.0, 25.0            # %, menor es peor
INCENDIO_VIENTO_AMARILLO, INCENDIO_VIENTO_NARANJA = 30.0, 40.0    # km/h
# Sin escalón rojo: la regla 30-30-30 es un criterio establecido de dos
# niveles; no define un tercer umbral, y estirarla a un "60-60-60" propio
# sería inventar un criterio sin respaldo, no derivarlo del existente.

# Umbral climatológico (viento y calor SOLAMENTE): en zonas donde el umbral
# fijo nacional es habitual (p.ej. viento en Patagonia), un umbral fijo deja
# la estación en aviso permanente. Se sube el umbral a percentil 98 de sus
# propias observaciones cuando ese percentil supera al fijo, con gate de
# muestra mínima — sin muestra suficiente, el ajuste NO se aplica (se
# prefiere un umbral fijo conservador a un percentil poco confiable).
MIN_OBS_CLIMATOLOGICO = 1000
PERCENTIL_CLIMATOLOGICO = 98

# Frescura del pronóstico BASE (regla 8): los pronósticos corren 2x/día, así
# que más de un ciclo de margen (>24 h) significa que se perdió al menos una
# corrida — p.ej. por un 429 de Open-Meteo. avisos.json ya siempre queda con
# "updated" fresco (se recalcula cada corrida), pero si el run_tag que lo
# alimenta es viejo, el aviso está calculado sobre un pronóstico desactualizado
# y hay que decirlo explícito, no solo la fecha de cálculo.
STALE_HORAS = 24

VENTANA_H = 120
VARS = ["wind_speed_10m", "temperature_2m", "precipitation", "snowfall",
        "freezing_level_height", "relative_humidity_2m"]

# Variables de VARS que además son calibrables (config.CALIBRABLE_VARS): se
# corrige cada valor por modelo con el bias de calibrate.py ANTES de la
# mediana, para que el aviso sea consistente con el pronóstico que ve el
# usuario. precipitation/snowfall/freezing_level_height quedan crudas
# (regla 5: nunca se calibra precipitation, y snowfall/isoterma no están en
# CALIBRABLE_VARS).
VARS_CALIBRABLES = [v for v in VARS if v in config.CALIBRABLE_VARS]


def _series_estacion(con, station_id: str, run_tag: str, desde: str, hasta: str) -> tuple[dict, dict]:
    """(series, por_modelo):
    - series: {variable: [(valid_time, mediana_entre_modelos)]}, ordenado, sin None.
    - por_modelo: {variable: {model: [(valid_time, value)]}}, ordenado, sin None.
      Base del acuerdo de ensamble (B1): cada model=... es un modelo determinista
      distinto archivado con member=-1 (ver forecasts en db.py); la mediana entre
      todas esas filas por hora es lo que arma `series`.

    Para las variables en VARS_CALIBRABLES, cada valor se corrige por sesgo
    (calibrate.correct, gate + shrinkage incluidos) antes de entrar a la
    mediana y al desglose por modelo — misma base que el pronóstico servido.
    """
    placeholders = ",".join("?" * len(VARS))
    rows = con.execute(
        f"SELECT variable, model, valid_time, value FROM forecasts"
        f" WHERE station=? AND run_tag=? AND member=-1 AND variable IN ({placeholders})"
        f" AND valid_time >= ? AND valid_time <= ?",
        (station_id, run_tag, *VARS, desde, hasta))
    run_dt = datetime.fromisoformat(run_tag + ":00")
    por_hora: dict = {}
    por_modelo_raw: dict = {}
    for var, model, vt, val in rows:
        if val is None:
            continue
        if var in VARS_CALIBRABLES:
            lead_hours = (datetime.fromisoformat(vt) - run_dt).total_seconds() / 3600
            val = calibrate.correct(con, station_id, model, var, lead_hours, val)
        por_hora.setdefault(var, {}).setdefault(vt, []).append(val)
        por_modelo_raw.setdefault(var, {}).setdefault(model, []).append((vt, val))
    series = {var: [(vt, statistics.median(horas[vt])) for vt in sorted(horas)]
              for var, horas in por_hora.items()}
    por_modelo = {var: {m: sorted(vals) for m, vals in modelos.items()}
                  for var, modelos in por_modelo_raw.items()}
    return series, por_modelo


def _rolling_sum(serie: list, n_horas: int) -> list:
    """[(valid_time_de_fin_de_ventana, suma)], solo ventanas de n_horas puntos
    completas. Aproximado: si falta la mediana de alguna hora (todos los
    modelos None), esa hora no cuenta como punto y la ventana de "n_horas
    puntos" puede cubrir algo más de n_horas de reloj — aceptable para un
    aviso derivado, no oficial."""
    return [
        (serie[i][0], sum(v for _, v in serie[i - (n_horas - 1):i + 1]))
        for i in range(n_horas - 1, len(serie))
    ]


def _nivel(valor: float, amarillo: float, naranja: float, mayor_es_peor: bool,
           rojo: float | None = None) -> str | None:
    if mayor_es_peor:
        if rojo is not None and valor >= rojo:
            return "rojo"
        if valor >= naranja:
            return "naranja"
        if valor >= amarillo:
            return "amarillo"
    else:
        if rojo is not None and valor <= rojo:
            return "rojo"
        if valor <= naranja:
            return "naranja"
        if valor <= amarillo:
            return "amarillo"
    return None


def _percentil(valores_ordenados: list, p: float) -> float:
    """Percentil por índice (nearest-rank, sin scipy). `valores_ordenados` YA
    ordenado ascendente."""
    n = len(valores_ordenados)
    idx = min(n - 1, max(0, round(p / 100 * (n - 1))))
    return valores_ordenados[idx]


def _umbral_climatologico(con, station_id: str, variable: str,
                           amarillo_fijo: float, naranja_fijo: float,
                           rojo_fijo: float | None = None) -> tuple[float, float, float | None]:
    """Umbral efectivo = max(fijo, percentil 98 de las OBSERVACIONES de esa
    estación para esa variable), con gate de muestra mínima. `naranja` conserva
    la separación ABSOLUTA amarillo/naranja del umbral fijo (offset, no razón:
    temperatura es escala de intervalo, no de razón — escalar por cociente
    depende de si se mide en °C o K, lo que es un error de unidades). `rojo`,
    si se entrega, se desplaza con el mismo offset aditivo que naranja, para
    mantener coherente el mecanismo de ajuste."""
    rows = con.execute(
        "SELECT value FROM observations WHERE station=? AND variable=? AND value IS NOT NULL",
        (station_id, variable)).fetchall()
    if len(rows) < MIN_OBS_CLIMATOLOGICO:
        return amarillo_fijo, naranja_fijo, rojo_fijo
    valores = sorted(v for (v,) in rows)
    p98 = _percentil(valores, PERCENTIL_CLIMATOLOGICO)
    amarillo_efectivo = max(amarillo_fijo, p98)
    naranja_efectivo = amarillo_efectivo + (naranja_fijo - amarillo_fijo)
    rojo_efectivo = (amarillo_efectivo + (rojo_fijo - amarillo_fijo)
                     if rojo_fijo is not None else None)
    return amarillo_efectivo, naranja_efectivo, rojo_efectivo


def _acuerdo_pico(por_modelo: dict, var: str, amarillo: float, naranja: float,
                   mayor_es_peor: bool) -> str:
    """'n_superan/n_modelos_con_datos': cuántos modelos, por sí solos (su propio
    pico horario en la ventana), superan el umbral amarillo de este aviso.
    Información de confianza del ensamble — NUNCA un gate: un aviso con
    acuerdo 1/6 igual se emite si la mediana lo cruza."""
    modelos = por_modelo.get(var, {})
    n_supera = sum(
        1 for serie in modelos.values()
        if _nivel(max(v for _, v in serie) if mayor_es_peor else min(v for _, v in serie),
                  amarillo, naranja, mayor_es_peor) is not None
    )
    return f"{n_supera}/{len(modelos)}"


def _acuerdo_rolling(por_modelo: dict, var: str, amarillo: float, naranja: float,
                      n_horas: int = 24) -> str:
    """Ídem _acuerdo_pico para lluvia/nieve/aluvional/lluvia persistente: la
    suma móvil de n_horas de cada modelo por sí solo. El denominador son los
    modelos con ventana de n_horas puntos completa (los demás no tienen forma
    de opinar)."""
    modelos = por_modelo.get(var, {})
    n_con_ventana = n_supera = 0
    for serie in modelos.values():
        rolling = _rolling_sum(serie, n_horas)
        if not rolling:
            continue
        n_con_ventana += 1
        if _nivel(max(v for _, v in rolling), amarillo, naranja, mayor_es_peor=True) is not None:
            n_supera += 1
    return f"{n_supera}/{n_con_ventana}"


def _acuerdo_incendio(por_modelo: dict) -> str:
    """Ídem para incendio: cuántos modelos, con su propia temperatura/HR/viento
    (sin pasar por la mediana), cumplen 30-30-30 en alguna hora común."""
    temp_m = por_modelo.get("temperature_2m", {})
    hr_m = por_modelo.get("relative_humidity_2m", {})
    viento_m = por_modelo.get("wind_speed_10m", {})
    modelos = set(temp_m) & set(hr_m) & set(viento_m)
    n_supera = 0
    for m in modelos:
        temp_h, hr_h, viento_h = dict(temp_m[m]), dict(hr_m[m]), dict(viento_m[m])
        horas = set(temp_h) & set(hr_h) & set(viento_h)
        if any(temp_h[h] >= INCENDIO_TEMP_AMARILLO and hr_h[h] <= INCENDIO_HR_AMARILLO
               and viento_h[h] >= INCENDIO_VIENTO_AMARILLO for h in horas):
            n_supera += 1
    return f"{n_supera}/{len(modelos)}"


def _aviso(st: dict, tipo: str, nivel: str, valor: float, unidad: str, valid_time: str,
           **extra) -> dict:
    d = {
        "estacion_id": st["id"], "nombre": st["nombre"], "region": st.get("region"),
        "lat": st["lat"], "lon": st["lon"],
        "tipo": tipo, "nivel": nivel,
        "valor": round(valor, 1), "unidad": unidad,
        "hora_peak": valid_time + ":00Z",   # valid_time siempre "YYYY-MM-DDTHH:MM"
    }
    d.update(extra)
    return d


def _suma_ventana(serie: list, n_horas: int) -> float | None:
    """Suma de los primeros n_horas puntos horarios de la serie (mediana entre
    modelos), o None si la variable no tiene ningún dato en la ventana (p.ej.
    snowfall recién agregado, sin filas hasta la próxima corrida de forecasts).
    0.0 es información válida (no llueve/no nieva), por eso no se confunde con
    la ausencia de datos."""
    if not serie:
        return None
    return round(sum(v for _, v in serie[:n_horas]), 1)


def _acumulado_estacion(st: dict, series: dict) -> dict:
    precip = series.get("precipitation") or []
    nieve = series.get("snowfall") or []
    return {
        "id": st["id"], "nombre": st["nombre"], "region": st.get("region"),
        "lat": st["lat"], "lon": st["lon"],
        "lluvia_24h": _suma_ventana(precip, 24),
        "lluvia_48h": _suma_ventana(precip, 48),
        "nieve_24h": _suma_ventana(nieve, 24),
        "nieve_48h": _suma_ventana(nieve, 48),
    }


def _aviso_incendio(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """Regla 30-30-30: temperatura ≥30 °C, humedad relativa ≤30 % y viento
    ≥30 km/h EN LA MISMA HORA de la mediana multi-modelo (≥35°/≤25 %/≥40 km/h
    = naranja). hora_peak = la primera hora que alcanza el nivel más alto
    alcanzado en toda la ventana."""
    temp = dict(series.get("temperature_2m") or [])
    hr = dict(series.get("relative_humidity_2m") or [])
    viento = dict(series.get("wind_speed_10m") or [])
    horas = sorted(set(temp) & set(hr) & set(viento))

    def nivel_hora(h: str) -> str | None:
        t, r, v = temp[h], hr[h], viento[h]
        if t >= INCENDIO_TEMP_NARANJA and r <= INCENDIO_HR_NARANJA and v >= INCENDIO_VIENTO_NARANJA:
            return "naranja"
        if t >= INCENDIO_TEMP_AMARILLO and r <= INCENDIO_HR_AMARILLO and v >= INCENDIO_VIENTO_AMARILLO:
            return "amarillo"
        return None

    niveles = {h: nivel_hora(h) for h in horas}
    if "naranja" in niveles.values():
        nivel_top = "naranja"
    elif "amarillo" in niveles.values():
        nivel_top = "amarillo"
    else:
        return None
    h = next(h for h in horas if niveles[h] == nivel_top)  # horas ordenadas asc.
    t, r, v = temp[h], hr[h], viento[h]
    acuerdo = _acuerdo_incendio(por_modelo)
    return _aviso(st, "incendio", nivel_top, t, "°C", h, acuerdo=acuerdo,
                  hr=round(r, 1), viento=round(v, 1))


def _avisos_estacion(series: dict, por_modelo: dict, st: dict,
                      viento_umbral: tuple, calor_umbral: tuple) -> list:
    avisos = []
    viento_amarillo, viento_naranja, viento_rojo = viento_umbral
    calor_amarillo, calor_naranja, calor_rojo = calor_umbral
    macrozona = _macrozona(st.get("region"))
    lluvia_rojo = LLUVIA_ROJO[macrozona]
    lluvia48_rojo = LLUVIA48_ROJO[macrozona]

    viento = series.get("wind_speed_10m") or []
    if viento:
        vt, val = max(viento, key=lambda p: p[1])
        nivel = _nivel(val, viento_amarillo, viento_naranja, mayor_es_peor=True, rojo=viento_rojo)
        if nivel:
            acuerdo = _acuerdo_pico(por_modelo, "wind_speed_10m", viento_amarillo, viento_naranja, True)
            avisos.append(_aviso(st, "viento", nivel, val, "km/h", vt,
                                  acuerdo=acuerdo, umbral=round(viento_amarillo, 1)))

    temp = series.get("temperature_2m") or []
    if temp:
        vt_min, val_min = min(temp, key=lambda p: p[1])
        nivel = _nivel(val_min, HELADA_AMARILLO, HELADA_NARANJA, mayor_es_peor=False, rojo=HELADA_ROJO)
        if nivel:
            acuerdo = _acuerdo_pico(por_modelo, "temperature_2m", HELADA_AMARILLO, HELADA_NARANJA, False)
            avisos.append(_aviso(st, "helada", nivel, val_min, "°C", vt_min, acuerdo=acuerdo))

        vt_max, val_max = max(temp, key=lambda p: p[1])
        nivel = _nivel(val_max, calor_amarillo, calor_naranja, mayor_es_peor=True, rojo=calor_rojo)
        if nivel:
            acuerdo = _acuerdo_pico(por_modelo, "temperature_2m", calor_amarillo, calor_naranja, True)
            avisos.append(_aviso(st, "calor", nivel, val_max, "°C", vt_max,
                                  acuerdo=acuerdo, umbral=round(calor_amarillo, 1)))

    precip = series.get("precipitation") or []
    rolling = _rolling_sum(precip, 24)
    if rolling:
        vt, val = max(rolling, key=lambda p: p[1])
        nivel = _nivel(val, LLUVIA_AMARILLO, LLUVIA_NARANJA, mayor_es_peor=True, rojo=lluvia_rojo)
        if nivel:
            acuerdo = _acuerdo_rolling(por_modelo, "precipitation", LLUVIA_AMARILLO, LLUVIA_NARANJA)
            avisos.append(_aviso(st, "lluvia", nivel, val, "mm", vt, acuerdo=acuerdo))

    # Lluvia persistente: pico de la suma móvil de 48 h (ventana propia,
    # independiente del pico de 24 h de arriba). Se emite ADEMÁS del aviso de
    # 24 h si ambos cruzan (productos distintos, sin dedupe) — ver docstring
    # de LLUVIA48_AMARILLO/NARANJA.
    rolling48 = _rolling_sum(precip, 48)
    if rolling48:
        vt48, val48 = max(rolling48, key=lambda p: p[1])
        nivel48 = _nivel(val48, LLUVIA48_AMARILLO, LLUVIA48_NARANJA, mayor_es_peor=True, rojo=lluvia48_rojo)
        if nivel48:
            acuerdo48 = _acuerdo_rolling(por_modelo, "precipitation",
                                          LLUVIA48_AMARILLO, LLUVIA48_NARANJA, n_horas=48)
            avisos.append(_aviso(st, "lluvia_persistente", nivel48, val48, "mm/48h", vt48,
                                  acuerdo=acuerdo48))

        # Isoterma 0° mediana durante la misma ventana de 24 h del pico de
        # lluvia. Null-safe: si freezing_level_height aún no tiene filas
        # (primera corrida antes del próximo --forecasts), no evalúa.
        iso_serie = series.get("freezing_level_height") or []
        if iso_serie:
            idx = next(i for i, (t, _) in enumerate(precip) if t == vt)
            ventana_times = [t for t, _ in precip[idx - 23:idx + 1]]
            iso_por_hora = dict(iso_serie)
            iso_vals = [iso_por_hora[t] for t in ventana_times if t in iso_por_hora]
            if iso_vals:
                iso_mediana = statistics.median(iso_vals)
                if val >= ALUVION_LLUVIA_NARANJA and iso_mediana >= ALUVION_ISOTERMA_NARANJA:
                    nivel_aluv = "naranja"
                elif val >= ALUVION_LLUVIA_AMARILLO and iso_mediana >= ALUVION_ISOTERMA_AMARILLO:
                    nivel_aluv = "amarillo"
                else:
                    nivel_aluv = None
                if nivel_aluv:
                    # Acuerdo del componente lluvia (el más variable entre
                    # modelos); la isoterma es más homogénea regionalmente y
                    # no se desglosa por modelo aquí.
                    acuerdo = _acuerdo_rolling(por_modelo, "precipitation",
                                               ALUVION_LLUVIA_AMARILLO, ALUVION_LLUVIA_NARANJA)
                    aviso_aluv = _aviso(st, "aluvional", nivel_aluv, val, "mm", vt, acuerdo=acuerdo)
                    aviso_aluv["isoterma_m"] = round(iso_mediana / 100) * 100
                    avisos.append(aviso_aluv)

    nieve = series.get("snowfall") or []
    rolling_nieve = _rolling_sum(nieve, 24)
    if rolling_nieve:
        vt, val = max(rolling_nieve, key=lambda p: p[1])
        nivel = _nivel(val, NIEVE_AMARILLO, NIEVE_NARANJA, mayor_es_peor=True, rojo=NIEVE_ROJO)
        if nivel:
            acuerdo = _acuerdo_rolling(por_modelo, "snowfall", NIEVE_AMARILLO, NIEVE_NARANJA)
            avisos.append(_aviso(st, "nieve", nivel, val, "cm", vt, acuerdo=acuerdo))

    aviso_incendio = _aviso_incendio(series, por_modelo, st)
    if aviso_incendio:
        avisos.append(aviso_incendio)

    return avisos


def update(con, fetched_at: str) -> int:
    ahora = datetime.now(timezone.utc)
    desde = ahora.strftime("%Y-%m-%dT%H:%M")
    hasta = (ahora + timedelta(hours=VENTANA_H)).strftime("%Y-%m-%dT%H:%M")

    avisos = []
    acumulados = []
    run_tags_usados = []
    for st in config.STATIONS:
        run_tag = con.execute(
            "SELECT MAX(run_tag) FROM forecasts WHERE station=? AND member=-1",
            (st["id"],)).fetchone()[0]
        if not run_tag:
            continue
        run_tags_usados.append(run_tag)
        # Una sola consulta de series por estación: avisos y acumulados
        # comparten la misma mediana horaria multi-modelo.
        series, por_modelo = _series_estacion(con, st["id"], run_tag, desde, hasta)
        viento_umbral = _umbral_climatologico(con, st["id"], "wind_speed_10m",
                                               VIENTO_AMARILLO, VIENTO_NARANJA, VIENTO_ROJO)
        calor_umbral = _umbral_climatologico(con, st["id"], "temperature_2m",
                                              CALOR_AMARILLO, CALOR_NARANJA, CALOR_ROJO)
        avisos.extend(_avisos_estacion(series, por_modelo, st, viento_umbral, calor_umbral))
        acumulados.append(_acumulado_estacion(st, series))

    payload = {
        "updated": ahora.strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "Derivado del pronóstico multi-modelo calibrado de Vigía"
                  " (mediana de 6 modelos con corrección de sesgo, 120 h)",
        "nota": "Aviso derivado de modelos, no es un aviso oficial de la DMC",
        "avisos": avisos,
        "acumulados": acumulados,
    }
    if run_tags_usados:
        pronostico_run = max(run_tags_usados)
        pronostico_horas = round((ahora - datetime.fromisoformat(pronostico_run + ":00")
                                   .replace(tzinfo=timezone.utc)).total_seconds() / 3600)
        payload["pronostico_run"] = pronostico_run
        payload["pronostico_horas"] = pronostico_horas
        if pronostico_horas > STALE_HORAS:
            payload["stale"] = True
    config.AVISOS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.AVISOS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(avisos)
