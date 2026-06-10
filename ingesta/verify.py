"""Verificación continua: ¿cuánto se equivoca cada modelo?

Compara cada pronóstico determinista archivado con la observación real de la
misma estación y hora (METAR + DMC), por variable y por plazo. Métricas:
  MAE  = error absoluto medio (magnitud típica del error)
  RMSE = raíz del error cuadrático medio (penaliza errores grandes/outliers)
  bias = error medio con signo (tendencia a pronosticar de más o de menos)

Estructura del JSON: models[modelo][variable][bucket] = {mae, rmse, bias, n}.
"""
import json
import math
from datetime import datetime, timezone

import config

WINDOW_DAYS = 14
BUCKETS = [(0, 24, "24"), (24, 48, "48"), (48, 72, "72"), (72, 96, "96")]
# Variables continuas con observación comparable directa (mismas que se calibran)
VARIABLES = config.CALIBRABLE_VARS


def compute(con) -> dict:
    placeholders = ",".join("?" * len(VARIABLES))
    sql = f"""
    SELECT f.model, f.variable,
           CAST((julianday(f.valid_time) - julianday(f.run_tag || ':00')) * 24 AS INTEGER),
           f.value, o.value
    FROM forecasts f
    JOIN observations o
      ON o.station = f.station
     AND o.variable = f.variable
     AND o.obs_time = f.valid_time || ':00Z'
    WHERE f.member = -1 AND f.variable IN ({placeholders})
      AND f.valid_time >= strftime('%Y-%m-%dT%H:%M', 'now', ?)
    """
    # acc[model][variable][bucket] = [sum|e|, sum e, sum e², n]
    acc: dict = {}
    for model, variable, lead, fc, ob in con.execute(sql, (*VARIABLES, f"-{WINDOW_DAYS} days")):
        if fc is None or ob is None or lead is None or lead <= 0:
            continue
        for lo, hi, key in BUCKETS:
            if lo < lead <= hi:
                a = acc.setdefault(model, {}).setdefault(variable, {}).setdefault(key, [0.0, 0.0, 0.0, 0])
                e = fc - ob
                a[0] += abs(e)
                a[1] += e
                a[2] += e * e
                a[3] += 1
                break

    def stats(s):
        n = s[3]
        return {"mae": round(s[0] / n, 2), "rmse": round(math.sqrt(s[2] / n), 2),
                "bias": round(s[1] / n, 2), "n": n}

    models = {
        model: {
            variable: {key: stats(s) for key, s in buckets.items() if s[3] > 0}
            for variable, buckets in varmap.items()
        }
        for model, varmap in acc.items()
    }
    return {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "window_days": WINDOW_DAYS,
        "variables": VARIABLES,
        "stations_n": len(config.STATIONS),
        "models": models,
    }


def write(con) -> int:
    data = compute(con)
    config.VERIF_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.VERIF_PATH.write_text(json.dumps(data, ensure_ascii=False) + "\n")
    pares = sum(b["n"] for m in data["models"].values()
                for v in m.values() for b in v.values())
    print(f"verificación → {config.VERIF_PATH}: {len(data['models'])} modelos, "
          f"{len(VARIABLES)} variables, {pares} pares")
    return pares
