"""Avisos meteorológicos derivados del propio pronóstico multi-modelo.

No es un aviso oficial: son umbrales propios (inspirados en los criterios
públicos de avisos de la Dirección Meteorológica de Chile, pero sin ninguna
relación operativa con la DMC) aplicados a la MEDIANA horaria entre modelos
del archivo de pronósticos, en la ventana de 48 h desde ahora. avisos.json lo
declara explícitamente para que nadie lo confunda con un aviso oficial.

Sin tabla propia: es barato de recalcular (SQL local + mediana, sin red), así
que se recalcula entero en cada corrida en vez de persistir estado.
"""
import json
import statistics
from datetime import datetime, timedelta, timezone

import config

# Umbrales (derivación propia; ver docstring). máx/mín = pico de la mediana
# horaria entre modelos en la ventana de 48 h; lluvia = pico de la suma móvil
# de 24 h de esa misma mediana horaria.
VIENTO_AMARILLO, VIENTO_NARANJA = 60.0, 90.0     # km/h, máx mediana horaria
HELADA_AMARILLO, HELADA_NARANJA = 0.0, -4.0      # °C, mín mediana horaria
LLUVIA_AMARILLO, LLUVIA_NARANJA = 30.0, 60.0     # mm, máx suma móvil 24 h
CALOR_AMARILLO, CALOR_NARANJA = 34.0, 37.0       # °C, máx mediana horaria

VENTANA_H = 48
VARS = ["wind_speed_10m", "temperature_2m", "precipitation", "snowfall"]


def _hourly_medians(con, station_id: str, run_tag: str, desde: str, hasta: str) -> dict:
    """{variable: [(valid_time, mediana_entre_modelos)]}, ordenado, ignorando None."""
    placeholders = ",".join("?" * len(VARS))
    rows = con.execute(
        f"SELECT variable, valid_time, value FROM forecasts"
        f" WHERE station=? AND run_tag=? AND member=-1 AND variable IN ({placeholders})"
        f" AND valid_time >= ? AND valid_time <= ?",
        (station_id, run_tag, *VARS, desde, hasta))
    por_hora: dict = {}
    for var, vt, val in rows:
        por_hora.setdefault(var, {}).setdefault(vt, []).append(val)
    series = {}
    for var, horas in por_hora.items():
        serie = []
        for vt in sorted(horas):
            vals = [v for v in horas[vt] if v is not None]
            if vals:
                serie.append((vt, statistics.median(vals)))
        series[var] = serie
    return series


def _rolling_sum_24h(serie: list) -> list:
    """[(valid_time_de_fin_de_ventana, suma)], solo ventanas de 24 puntos completas.
    Aproximado: si falta la mediana de alguna hora (todos los modelos None), esa
    hora no cuenta como punto y la ventana de "24 puntos" puede cubrir algo más
    de 24 horas de reloj — aceptable para un aviso derivado, no oficial."""
    return [
        (serie[i][0], sum(v for _, v in serie[i - 23:i + 1]))
        for i in range(23, len(serie))
    ]


def _nivel(valor: float, amarillo: float, naranja: float, mayor_es_peor: bool) -> str | None:
    if mayor_es_peor:
        if valor >= naranja:
            return "naranja"
        if valor >= amarillo:
            return "amarillo"
    else:
        if valor <= naranja:
            return "naranja"
        if valor <= amarillo:
            return "amarillo"
    return None


def _aviso(st: dict, tipo: str, nivel: str, valor: float, unidad: str, valid_time: str) -> dict:
    return {
        "estacion_id": st["id"], "nombre": st["nombre"], "region": st.get("region"),
        "lat": st["lat"], "lon": st["lon"],
        "tipo": tipo, "nivel": nivel,
        "valor": round(valor, 1), "unidad": unidad,
        "hora_peak": valid_time + ":00Z",   # valid_time siempre "YYYY-MM-DDTHH:MM"
    }


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


def _avisos_estacion(series: dict, st: dict) -> list:
    avisos = []

    viento = series.get("wind_speed_10m") or []
    if viento:
        vt, val = max(viento, key=lambda p: p[1])
        nivel = _nivel(val, VIENTO_AMARILLO, VIENTO_NARANJA, mayor_es_peor=True)
        if nivel:
            avisos.append(_aviso(st, "viento", nivel, val, "km/h", vt))

    temp = series.get("temperature_2m") or []
    if temp:
        vt_min, val_min = min(temp, key=lambda p: p[1])
        nivel = _nivel(val_min, HELADA_AMARILLO, HELADA_NARANJA, mayor_es_peor=False)
        if nivel:
            avisos.append(_aviso(st, "helada", nivel, val_min, "°C", vt_min))

        vt_max, val_max = max(temp, key=lambda p: p[1])
        nivel = _nivel(val_max, CALOR_AMARILLO, CALOR_NARANJA, mayor_es_peor=True)
        if nivel:
            avisos.append(_aviso(st, "calor", nivel, val_max, "°C", vt_max))

    precip = series.get("precipitation") or []
    rolling = _rolling_sum_24h(precip)
    if rolling:
        vt, val = max(rolling, key=lambda p: p[1])
        nivel = _nivel(val, LLUVIA_AMARILLO, LLUVIA_NARANJA, mayor_es_peor=True)
        if nivel:
            avisos.append(_aviso(st, "lluvia", nivel, val, "mm", vt))

    return avisos


def update(con, fetched_at: str) -> int:
    ahora = datetime.now(timezone.utc)
    desde = ahora.strftime("%Y-%m-%dT%H:%M")
    hasta = (ahora + timedelta(hours=VENTANA_H)).strftime("%Y-%m-%dT%H:%M")

    avisos = []
    acumulados = []
    for st in config.STATIONS:
        run_tag = con.execute(
            "SELECT MAX(run_tag) FROM forecasts WHERE station=? AND member=-1",
            (st["id"],)).fetchone()[0]
        if not run_tag:
            continue
        # Una sola consulta de series por estación: avisos y acumulados
        # comparten la misma mediana horaria multi-modelo.
        series = _hourly_medians(con, st["id"], run_tag, desde, hasta)
        avisos.extend(_avisos_estacion(series, st))
        acumulados.append(_acumulado_estacion(st, series))

    payload = {
        "updated": ahora.strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "Derivado del pronóstico multi-modelo de Vigía (mediana de 6 modelos, 48 h)",
        "nota": "Aviso derivado de modelos, no es un aviso oficial de la DMC",
        "avisos": avisos,
        "acumulados": acumulados,
    }
    config.AVISOS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.AVISOS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(avisos)
