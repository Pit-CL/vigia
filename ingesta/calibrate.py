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
WINDOW_DAYS = 90         # ventana de pares considerada (acota cómputo)
BUCKETS = [(0, 24, "24"), (24, 48, "48"), (48, 72, "72"), (72, 96, "96")]
ADDITIVE_VARS = config.CALIBRABLE_VARS
CLIP = {"relative_humidity_2m": (0.0, 100.0), "wind_speed_10m": (0.0, None)}

SCHEMA = """
CREATE TABLE IF NOT EXISTS bias (
  station  TEXT NOT NULL,
  model    TEXT NOT NULL,
  variable TEXT NOT NULL,
  lead     TEXT NOT NULL,          -- bucket "24"/"48"/"72"/"96"
  b        REAL NOT NULL,          -- bias EWMA (fc - obs)
  n        INTEGER NOT NULL,       -- pares vistos (gate y shrinkage)
  source   TEXT NOT NULL DEFAULT 'online',   -- 'online' | 'bootstrap'
  updated  TEXT NOT NULL,
  PRIMARY KEY (station, model, variable, lead)
);
"""


def bucket(lead):
    for lo, hi, key in BUCKETS:
        if lo < lead <= hi:
            return key
    return None


def ensure_schema(con):
    con.executescript(SCHEMA)


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
        b, n = cur.get(cell, (None, 0))
        err = fc - ob
        b = err if b is None else (1 - W) * b + W * err
        cur[cell] = (b, n + 1)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
    written = 0
    for (st, mdl, var, key), (b, n) in cur.items():
        # No pisar un bootstrap con más muestra que el online recién calculado.
        row = con.execute(
            "SELECT n, source FROM bias WHERE station=? AND model=? AND variable=? AND lead=?",
            (st, mdl, var, key)).fetchone()
        if row and row[1] == "bootstrap" and row[0] > n:
            continue
        con.execute(
            "INSERT OR REPLACE INTO bias VALUES (?,?,?,?,?,?,?,?)",
            (st, mdl, var, key, round(b, 3), n, "online", now))
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
    out = fc_value - b_eff
    lo, hi = CLIP.get(variable, (None, None))
    if lo is not None:
        out = max(lo, out)
    if hi is not None:
        out = min(hi, out)
    return round(out, 2)


def export_json(con) -> int:
    """Publica web/bias.json con las correcciones que PASAN el gate, con el
    shrinkage ya aplicado (b_eff), para que el frontend solo reste. Incluye las
    coords de las estaciones para mapear la ubicación del usuario a la cercana."""
    import json
    estaciones = {s["id"]: {"nombre": s["nombre"], "lat": s["lat"], "lon": s["lon"]}
                  for s in config.STATIONS}
    bias = {}
    for st, mdl, var, lead, b, n in con.execute(
            "SELECT station, model, variable, lead, b, n FROM bias WHERE n >= ?", (N_MIN,)):
        b_eff = round(b * n / (n + K_SHRINK), 3)
        bias.setdefault(st, {}).setdefault(mdl, {}).setdefault(var, {})[lead] = b_eff
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
