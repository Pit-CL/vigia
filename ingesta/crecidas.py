"""Pronóstico de crecidas de ríos (GloFAS/Copernicus vía Open-Meteo Flood API).

Modelo global ~5 km, pensado para ríos grandes: no reemplaza a la DGA
(Dirección General de Aguas) ni a las alertas oficiales de SENAPRED, y así
lo declara el JSON publicado (regla 8 de CLAUDE.md).

Umbrales por percentiles de máximas anuales (convención de períodos de
retorno, versión empírica sin scipy): amarillo = mediana (~2 años), naranja
= percentil 80 (~5 años), rojo = percentil 95 (~20 años) de las máximas
anuales del reanálisis histórico 1984-hoy. Se calculan una sola vez por
punto (bootstrap, barato) y se persisten en `crecidas_umbral`.
"""
import json
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import config
import sources
from rios_cl import RIOS

API_FLOOD = "https://flood-api.open-meteo.com/v1/flood"
HIST_START = "1984-01-01"
FORECAST_DAYS = 7
MIN_DIAS_ANIO = 300   # año con menos días de dato no cuenta como máxima anual confiable
MIN_ANIOS = 10        # bajo esto, el umbral no es estadísticamente serio

NIVELES = (("rojo", "rp20"), ("naranja", "rp5"), ("amarillo", "rp2"))


def _percentil(valores: list, p: float):
    """Percentil por interpolación lineal (método por defecto de numpy),
    sin scipy — ver regla 1 de CLAUDE.md."""
    s = sorted(valores)
    n = len(s)
    if n == 0:
        return None
    if n == 1:
        return s[0]
    idx = p / 100 * (n - 1)
    lo = int(idx)
    hi = min(lo + 1, n - 1)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)


def _maximas_anuales(times: list, valores: list) -> list:
    por_anio = defaultdict(list)
    for t, v in zip(times, valores):
        if v is not None:
            por_anio[t[:4]].append(v)
    return [max(vals) for vals in por_anio.values() if len(vals) >= MIN_DIAS_ANIO]


def bootstrap_umbrales(con, puntos=None) -> int:
    """Calcula umbrales para los puntos de RIOS que aún no tengan fila en
    crecidas_umbral. Una llamada histórica por punto (barato: se ejecuta
    una sola vez por punto en la vida del proyecto)."""
    puntos = puntos if puntos is not None else RIOS
    existentes = {r[0] for r in con.execute("SELECT punto FROM crecidas_umbral")}
    faltantes = [p for p in puntos if p["id"] not in existentes]
    if not faltantes:
        return 0
    ayer = (date.today() - timedelta(days=1)).isoformat()
    calculados = 0
    for i, p in enumerate(faltantes):
        if i > 0:
            time.sleep(5)  # cortesía: cada llamada histórica pesa ~42 años de diario, más que un pronóstico
        data, _ = sources.http_get_json(API_FLOOD, {
            "latitude": f"{p['lat']:.4f}", "longitude": f"{p['lon']:.4f}",
            "daily": "river_discharge", "start_date": HIST_START, "end_date": ayer,
        }, retries=4)
        daily = data.get("daily", {})
        maximas = _maximas_anuales(daily.get("time", []), daily.get("river_discharge", []))
        if len(maximas) < MIN_ANIOS:
            print(f"[aviso] crecidas: {p['id']} sin umbral, solo {len(maximas)} años de máximas anuales (mínimo {MIN_ANIOS})")
            continue
        rp2, rp5, rp20 = _percentil(maximas, 50), _percentil(maximas, 80), _percentil(maximas, 95)
        con.execute(
            "INSERT INTO crecidas_umbral(punto, rp2, rp5, rp20, n_anios, updated) VALUES (?,?,?,?,?,?)",
            (p["id"], rp2, rp5, rp20, len(maximas), datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")))
        con.commit()
        calculados += 1
    return calculados


def _nivel(peak: float, umbral: dict | None) -> str | None:
    if umbral is None or peak is None:
        return None
    for nombre, campo in NIVELES:
        if peak >= umbral[campo]:
            return nombre
    return None


def update(con, fetched_at: str) -> int:
    bootstrap_umbrales(con)
    umbrales = {r[0]: {"rp2": r[1], "rp5": r[2], "rp20": r[3], "n_anios": r[4]}
                for r in con.execute("SELECT punto, rp2, rp5, rp20, n_anios FROM crecidas_umbral")}

    data, _ = sources.http_get_json(API_FLOOD, {
        "latitude": ",".join(f"{p['lat']:.4f}" for p in RIOS),
        "longitude": ",".join(f"{p['lon']:.4f}" for p in RIOS),
        "daily": "river_discharge,river_discharge_max",
        "forecast_days": FORECAST_DAYS,
    })
    results = data if isinstance(data, list) else [data]

    puntos = []
    for p, res in zip(RIOS, results):
        daily = res.get("daily", {})
        tiempos = daily.get("time", [])
        caudal = daily.get("river_discharge", [])
        caudal_max = daily.get("river_discharge_max", [])
        umbral = umbrales.get(p["id"])

        serie_peak = [v for v in caudal_max if v is not None] or [v for v in caudal if v is not None]
        peak = max(serie_peak) if serie_peak else None
        dia_peak = None
        if peak is not None:
            fuente = caudal_max if any(v is not None for v in caudal_max) else caudal
            for t, v in zip(tiempos, fuente):
                if v == peak:
                    dia_peak = t
                    break

        puntos.append({
            "id": p["id"], "rio": p["rio"], "comuna": p["comuna"], "region": p["region"],
            "lat": p["lat"], "lon": p["lon"],
            "caudal": caudal, "caudal_max": caudal_max,
            "nivel": _nivel(peak, umbral), "dia_peak": dia_peak,
            "umbral_rp2": umbral["rp2"] if umbral else None,
            "umbral_rp5": umbral["rp5"] if umbral else None,
            "umbral_rp20": umbral["rp20"] if umbral else None,
        })

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "GloFAS/Copernicus vía Open-Meteo — modelo global ~5 km, ríos grandes; no reemplaza a DGA/SENAPRED",
        "nota": "Pronóstico de referencia, no oficial. Ante alerta, sigue los canales de SENAPRED y la DGA (dga.mop.gob.cl).",
        "puntos": puntos,
    }
    config.CRECIDAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.CRECIDAS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(puntos)
