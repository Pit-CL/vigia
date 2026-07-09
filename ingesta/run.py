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
import incendios
import sismos
import sources
import verify
import calibrate


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
    # fenómeno presente reciente (METAR wxString), solo si es de las últimas 2 h
    wx_cut = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    wx = {st: w for st, w in con.execute(
        "SELECT station, wx FROM obs_wx WHERE obs_time >= ?", (wx_cut,))}
    estaciones = [{
        "id": s["id"], "nombre": s["nombre"], "lat": s["lat"], "lon": s["lon"],
        "region": s.get("region"),
        "fuente": "metar" if s.get("metar") else "dmc",
        "obs_time": latest[s["id"]]["obs_time"] if s["id"] in latest else None,
        "obs": latest[s["id"]]["obs"] if s["id"] in latest else {},
        "wx": wx.get(s["id"]),
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


def write_aire(con, run_at: str) -> int:
    """Archiva SINCA y publica aire.json (estaciones oficiales de V/RM)."""
    _, estaciones = sources.ingest_sinca(con, run_at)
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SINCA · Ministerio del Medio Ambiente de Chile",
        "estaciones": estaciones,
    }
    config.AIRE_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.AIRE_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    con_pm = sum(1 for e in estaciones if e.get("pm2_5") is not None)
    print(f"aire → {config.AIRE_PATH}: {len(estaciones)} estaciones SINCA ({con_pm} con MP2,5)")
    return len(estaciones)


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
    ap.add_argument("--sismos", action="store_true", help="archiva catálogo sísmico (CSN + USGS)")
    ap.add_argument("--incendios", action="store_true", help="archiva focos de calor (NASA FIRMS)")
    ap.add_argument("--hazards", action="store_true", help="peligros naturales (sismos + incendios)")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    do_forecasts = args.forecasts or args.all
    do_obs = args.obs or args.all or not (
        args.forecasts or args.all or args.sismos or args.incendios or args.hazards)
    do_sismos = args.sismos or args.hazards or args.all
    do_incendios = args.incendios or args.hazards or args.all

    now = datetime.now(timezone.utc)
    run_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    run_tag = now.strftime("%Y-%m-%dT%H")

    con = db.connect()
    ok = True
    if do_obs:
        ok &= step(con, run_at, "metar", lambda: sources.ingest_metar(con, run_at))
        ok &= step(con, run_at, "dmc", lambda: sources.ingest_dmc(con, run_at))
        ok &= step(con, run_at, "sinca", lambda: write_aire(con, run_at))
    if do_forecasts:
        ok &= step(con, run_at, "openmeteo_det", lambda: sources.ingest_openmeteo_det(con, run_tag))
        ok &= step(con, run_at, "openmeteo_ens", lambda: sources.ingest_openmeteo_ens(con, run_tag))
        ok &= step(con, run_at, "prune", lambda: db.prune(con))
    if do_sismos:
        ok &= step(con, run_at, "sismos", lambda: sismos.update(con, run_at))
    if do_incendios:
        ok &= step(con, run_at, "incendios", lambda: incendios.update(con, run_at))
    if do_obs or do_forecasts:
        ok &= step(con, run_at, "verificacion", lambda: verify.write(con))
        ok &= step(con, run_at, "calibracion", lambda: calibrate.update(con))
        ok &= step(con, run_at, "bias_json", lambda: calibrate.export_json(con))
        ok &= step(con, run_at, "estaciones", lambda: write_estaciones(con))
    write_status(con)
    con.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
