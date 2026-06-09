"""Orquestador de ingesta.

Uso:
  python3 ingesta/run.py            # observaciones + status (cada hora)
  python3 ingesta/run.py --forecasts  # además archiva pronósticos (cada 6 h)
  python3 ingesta/run.py --all
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone

import config
import db
import sources
import verify


def write_status(con) -> None:
    q = lambda sql: con.execute(sql).fetchone()[0]
    forecast_rows = q("SELECT COALESCE(MAX(rowid), 0) FROM forecasts")
    obs_rows = q("SELECT COALESCE(MAX(rowid), 0) FROM observations")
    since_f = q("SELECT MIN(run_tag) FROM forecasts")
    since_o = q("SELECT MIN(obs_time) FROM observations")
    since = min(s for s in [since_f, since_o, "9999"] if s) if (since_f or since_o) else None
    status = {
        "forecast_rows": forecast_rows,
        "obs_rows": obs_rows,
        "since": (since or "")[:10] or None,
        "last_run": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "stations": len(config.STATIONS),
    }
    config.STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.STATUS_PATH.write_text(json.dumps(status, ensure_ascii=False) + "\n")
    print(f"status → {config.STATUS_PATH}: {status}")


def write_estaciones(con) -> int:
    """Última observación por estación (mapa en vivo de la PWA)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
    latest: dict = {}
    for station, variable, value, obs_time in con.execute(
        "SELECT station, variable, value, obs_time FROM observations"
        " WHERE obs_time >= ? ORDER BY obs_time", (cutoff,)):
        d = latest.setdefault(station, {"obs": {}, "obs_time": obs_time})
        d["obs"][variable] = value
        if obs_time > d["obs_time"]:
            d["obs_time"] = obs_time
    estaciones = [{
        "id": s["id"], "nombre": s["nombre"], "lat": s["lat"], "lon": s["lon"],
        "fuente": "metar" if s.get("metar") else "dmc",
        "obs_time": latest[s["id"]]["obs_time"] if s["id"] in latest else None,
        "obs": latest[s["id"]]["obs"] if s["id"] in latest else {},
    } for s in config.STATIONS]
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "estaciones": estaciones,
    }
    config.ESTACIONES_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.ESTACIONES_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    con_datos = sum(1 for e in estaciones if e["obs"])
    print(f"estaciones → {config.ESTACIONES_PATH}: {con_datos}/{len(estaciones)} con datos")
    return con_datos


def step(con, run_at: str, kind: str, fn) -> bool:
    try:
        n = fn()
        db.log(con, run_at, kind, True, n)
        print(f"[ok] {kind}: {n} filas")
        return True
    except Exception as err:
        db.log(con, run_at, kind, False, 0, str(err))
        print(f"[ERROR] {kind}: {err}", file=sys.stderr)
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--forecasts", action="store_true", help="archiva pronósticos (det + ensamble)")
    ap.add_argument("--obs", action="store_true", help="archiva observaciones (METAR, DMC)")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    do_forecasts = args.forecasts or args.all
    do_obs = args.obs or args.all or not (args.forecasts or args.all)

    now = datetime.now(timezone.utc)
    run_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    run_tag = now.strftime("%Y-%m-%dT%H")

    con = db.connect()
    ok = True
    if do_obs:
        ok &= step(con, run_at, "metar", lambda: sources.ingest_metar(con, run_at))
        ok &= step(con, run_at, "dmc", lambda: sources.ingest_dmc(con, run_at))
    if do_forecasts:
        ok &= step(con, run_at, "openmeteo_det", lambda: sources.ingest_openmeteo_det(con, run_tag))
        ok &= step(con, run_at, "openmeteo_ens", lambda: sources.ingest_openmeteo_ens(con, run_tag))
    ok &= step(con, run_at, "verificacion", lambda: verify.write(con))
    ok &= step(con, run_at, "estaciones", lambda: write_estaciones(con))
    write_status(con)
    con.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
