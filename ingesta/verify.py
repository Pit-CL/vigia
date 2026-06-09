"""Verificación continua: ¿cuánto se equivocó cada modelo?

Compara cada pronóstico archivado con la observación real de la misma
estación y hora (METAR + DMC), por plazo de pronóstico. Métricas:
  MAE  = error absoluto medio (magnitud típica del error)
  bias = error medio con signo (tendencia a pronosticar de más o de menos)
"""
import json
from datetime import datetime, timezone

import config

WINDOW_DAYS = 14
BUCKETS = [(0, 24, "24"), (24, 48, "48"), (48, 72, "72"), (72, 96, "96")]
VARIABLE = "temperature_2m"


def compute(con) -> dict:
    sql = """
    SELECT f.model,
           CAST((julianday(f.valid_time) - julianday(f.run_tag || ':00')) * 24 AS INTEGER),
           f.value, o.value
    FROM forecasts f
    JOIN observations o
      ON o.station = f.station
     AND o.variable = f.variable
     AND o.obs_time = f.valid_time || ':00Z'
    WHERE f.variable = ? AND f.member = -1
      AND f.valid_time >= strftime('%Y-%m-%dT%H:%M', 'now', ?)
    """
    acc: dict = {}
    for model, lead, fc, ob in con.execute(sql, (VARIABLE, f"-{WINDOW_DAYS} days")):
        if fc is None or ob is None or lead is None or lead <= 0:
            continue
        for lo, hi, key in BUCKETS:
            if lo < lead <= hi:
                a = acc.setdefault(model, {}).setdefault(key, [0.0, 0.0, 0])
                a[0] += abs(fc - ob)
                a[1] += fc - ob
                a[2] += 1
                break
    models = {
        model: {
            key: {"mae": round(s[0] / s[2], 2), "bias": round(s[1] / s[2], 2), "n": s[2]}
            for key, s in buckets.items() if s[2] > 0
        }
        for model, buckets in acc.items()
    }
    return {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "window_days": WINDOW_DAYS,
        "variable": VARIABLE,
        "stations_n": len(config.STATIONS),
        "models": models,
    }


def write(con) -> int:
    data = compute(con)
    config.VERIF_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.VERIF_PATH.write_text(json.dumps(data, ensure_ascii=False) + "\n")
    pares = sum(b["n"] for m in data["models"].values() for b in m.values())
    print(f"verificación → {config.VERIF_PATH}: {len(data['models'])} modelos, {pares} pares")
    return pares
