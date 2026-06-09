"""Orquestador de ingesta.

Uso:
  python3 ingesta/run.py            # observaciones + status (cada hora)
  python3 ingesta/run.py --forecasts  # además archiva pronósticos (cada 6 h)
  python3 ingesta/run.py --all
"""
import argparse
import json
import sys
from datetime import datetime, timezone

import config
import db
import sources


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
    write_status(con)
    con.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
