"""Corrección de sesgo por media decreciente (EWMA) por celda.

Cimiento del post-procesamiento. Estima un bias por
(estación, modelo, variable, bucket_de_lead) y lo persiste para que el
pronóstico servido lo reste. Un solo parámetro por celda; el decay (W) es la
regularización -> no puede memorizar ruido, no overfittea por construcción.

Seguridad ante archivo joven:
  - gate de muestra mínima (N_MIN): con pocos pares, NO corrige (devuelve crudo).
  - shrinkage hacia 0 con n bajo: b_aplicado = b * n/(n+K_SHRINK).
Así, encenderlo pronto nunca degrada el pronóstico.

La tabla `bias` la pueden poblar dos fuentes:
  - update(): EWMA causal sobre el archivo propio (cron).
  - bootstrap_hist.py: bias inicial estimado del histórico (Previous Runs + ASOS).
"""
import math
from datetime import datetime, timezone

import config

W = 0.15                 # decay (peso de aprendizaje); bajar a ~0.05 al madurar
N_MIN = 7                # gate: por debajo, pronóstico crudo
K_SHRINK = 8             # shrinkage: b_aplicado = b * n/(n+K)
WINDOW_DAYS = 45         # ventana de pares considerada (la memoria efectiva del EWMA no llega a 90 días)
BUCKETS = [(0, 24, "24"), (24, 48, "48"), (48, 72, "72"), (72, 96, "96")]
ADDITIVE_VARS = config.CALIBRABLE_VARS
CLIP = {"relative_humidity_2m": (0.0, 100.0), "wind_speed_10m": (0.0, None)}

# Tope de plausibilidad del bias EWMA: por encima de esto ya no es sesgo de
# terreno/altitud (legítimo, la función de la calibración), es un sensor roto
# contaminando la celda (ej. estación con presión constante 501.6 hPa). Topes
# generosos — no bloquean sesgo real, solo basura de sensor.
TOPE_PLAUSIBILIDAD = {
    "pressure_msl": 15,           # reducción a nivel del mar: un sesgo real es chico
    "temperature_2m": 15,
    "dew_point_2m": 15,
    "relative_humidity_2m": 60,
    "wind_speed_10m": 60,
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS bias (
  station  TEXT NOT NULL,
  model    TEXT NOT NULL,
  variable TEXT NOT NULL,
  lead     TEXT NOT NULL,          -- bucket "24"/"48"/"72"/"96"
  b        REAL NOT NULL,          -- bias EWMA (fc - obs)
  mae      REAL,                   -- MAE EWMA (|fc_corr - obs|) para pesos de blending
  n        INTEGER NOT NULL,       -- pares vistos (gate y shrinkage)
  source   TEXT NOT NULL DEFAULT 'online',   -- 'online' | 'bootstrap'
  updated  TEXT NOT NULL,
  PRIMARY KEY (station, model, variable, lead)
);
"""


def _migrate(con):
    cols = [r[1] for r in con.execute("PRAGMA table_info(bias)")]
    if "bias" in [t[0] for t in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")] and "mae" not in cols:
        con.execute("ALTER TABLE bias ADD COLUMN mae REAL")


def bucket(lead):
    for lo, hi, key in BUCKETS:
        if lo < lead <= hi:
            return key
    return None


def ensure_schema(con):
    con.executescript(SCHEMA)
    _migrate(con)


def update(con) -> int:
    """EWMA causal por celda sobre los pares fc/obs del archivo propio.

    Mismo JOIN que verify.py (resuelve el desfase de formato valid_time vs
    obs_time). ORDER BY run_tag para que el EWMA respete el orden temporal
    (causal). No sobreescribe celdas de bootstrap con n mayor salvo que el
    online ya tenga suficiente señal propia."""
    ensure_schema(con)
    placeholders = ",".join("?" * len(ADDITIVE_VARS))
    sql = f"""
    SELECT f.station, f.model, f.variable,
           CAST((julianday(f.valid_time) - julianday(f.run_tag || ':00')) * 24 AS INTEGER),
           f.value, o.value
    FROM forecasts f
    JOIN observations o
      ON o.station = f.station
     AND o.variable = f.variable
     AND o.obs_time = f.valid_time || ':00Z'
    WHERE f.member = -1 AND f.variable IN ({placeholders})
      AND f.valid_time >= strftime('%Y-%m-%dT%H:%M', 'now', ?)
    ORDER BY f.run_tag, f.valid_time
    """
    cur = {}
    for st, mdl, var, lead, fc, ob in con.execute(sql, (*ADDITIVE_VARS, f"-{WINDOW_DAYS} days")):
        if fc is None or ob is None or lead is None or lead <= 0:
            continue
        key = bucket(lead)
        if key is None:
            continue
        cell = (st, mdl, var, key)
        b, m, n = cur.get(cell, (None, None, 0))
        err = fc - ob
        resid = abs(err - (b if b is not None else 0.0))   # error TRAS corregir el bias (causal)
        b = err if b is None else (1 - W) * b + W * err
        m = resid if m is None else (1 - W) * m + W * resid
        cur[cell] = (b, m, n + 1)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
    written = 0
    for (st, mdl, var, key), (b, m, n) in cur.items():
        # No pisar un bootstrap con más muestra que el online recién calculado.
        row = con.execute(
            "SELECT n, source FROM bias WHERE station=? AND model=? AND variable=? AND lead=?",
            (st, mdl, var, key)).fetchone()
        if row and row[1] == "bootstrap" and row[0] > n:
            continue
        con.execute(
            "INSERT OR REPLACE INTO bias(station,model,variable,lead,b,mae,n,source,updated) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (st, mdl, var, key, round(b, 3), round(m, 3), n, "online", now))
        written += 1
    con.commit()
    return written


def correct(con, station, model, variable, lead_hours, fc_value):
    """Aplica el bias persistido al pronóstico crudo. Gate + shrinkage:
    con n < N_MIN devuelve crudo; con n medio corrige atenuado."""
    if variable not in ADDITIVE_VARS or fc_value is None:
        return fc_value
    key = bucket(lead_hours)
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
    tope = TOPE_PLAUSIBILIDAD.get(variable)
    if tope is not None and abs(b_eff) > tope:
        return fc_value  # bias implausible: probable sensor roto, no aplicar
    out = fc_value - b_eff
    lo, hi = CLIP.get(variable, (None, None))
    if lo is not None:
        out = max(lo, out)
    if hi is not None:
        out = min(hi, out)
    return round(out, 2)


# Umbral de exportación a producción: más estricto que el gate interno.
# Solo servimos correcciones CONFIABLES: las del bootstrap (validadas con
# holdout, skill +0.21) o las online ya maduras (n alto). Las celdas online
# jóvenes (DMC con pocos días) esperan: corregir con bias ruidoso degradaría.
N_EXPORT = 40

def export_json(con) -> int:
    """Publica web/bias.json con las correcciones CONFIABLES (bootstrap o n>=N_EXPORT),
    con el shrinkage ya aplicado (b_eff), para que el frontend solo reste. Incluye
    las coords de las estaciones para mapear la ubicación del usuario a la cercana."""
    import json
    estaciones = {s["id"]: {"nombre": s["nombre"], "lat": s["lat"], "lon": s["lon"]}
                  for s in config.STATIONS}
    # bias[est][modelo][variable][lead] = [b_eff, mae]
    #   b_eff = sesgo a restar (shrinkage aplicado); mae = error residual para
    #   ponderar el blending (peso ∝ 1/mae²).
    bias = {}
    for st, mdl, var, lead, b, mae, n, source in con.execute(
            "SELECT station, model, variable, lead, b, mae, n, source FROM bias "
            "WHERE source='bootstrap' OR n >= ?", (N_EXPORT,)):
        b_eff = round(b * n / (n + K_SHRINK), 3)
        tope = TOPE_PLAUSIBILIDAD.get(var)
        if tope is not None and abs(b_eff) > tope:
            continue  # bias implausible: mismo guard que correct(), no exportar al frontend
        mae_v = round(mae, 3) if mae is not None else None
        bias.setdefault(st, {}).setdefault(mdl, {}).setdefault(var, {})[lead] = [b_eff, mae_v]
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "n_min": N_MIN,
        "estaciones": {k: v for k, v in estaciones.items() if k in bias},
        "bias": bias,
    }
    config.BIAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.BIAS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(bias)


if __name__ == "__main__":
    import db
    con = db.connect()
    print("celdas de bias actualizadas:", update(con))
    print("estaciones en bias.json:", export_json(con))
    rows = con.execute(
        "SELECT source, COUNT(*), MIN(n), MAX(n) FROM bias GROUP BY source").fetchall()
    for s, c, mn, mx in rows:
        print(f"  {s}: {c} celdas (n {mn}-{mx})")
