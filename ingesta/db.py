"""Esquema y acceso SQLite del archivo científico."""
import sqlite3

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
  icao    TEXT PRIMARY KEY,
  nombre  TEXT NOT NULL,
  lat     REAL NOT NULL,
  lon     REAL NOT NULL
);

-- Pronósticos archivados en formato largo.
-- run_tag = hora UTC de la ingesta (YYYY-MM-DDTHH): re-ejecutar dentro de la
-- misma hora es idempotente. member = -1 para deterministas, 0..N ensamble.
CREATE TABLE IF NOT EXISTS forecasts (
  station    TEXT NOT NULL,
  model      TEXT NOT NULL,
  run_tag    TEXT NOT NULL,
  valid_time TEXT NOT NULL,
  variable   TEXT NOT NULL,
  member     INTEGER NOT NULL DEFAULT -1,
  value      REAL,
  UNIQUE(station, model, run_tag, valid_time, variable, member) ON CONFLICT IGNORE
);

-- Observaciones (ground truth). Variables con nombres Open-Meteo
-- para que la comparación pronóstico/observación sea directa.
CREATE TABLE IF NOT EXISTS observations (
  station  TEXT NOT NULL,
  obs_time TEXT NOT NULL,          -- ISO UTC
  variable TEXT NOT NULL,
  value    REAL,
  source   TEXT NOT NULL,          -- 'metar' | 'dmc'
  UNIQUE(station, obs_time, variable, source) ON CONFLICT IGNORE
);

-- Payloads crudos: nunca perder datos aunque aún no exista parser (DMC).
CREATE TABLE IF NOT EXISTS raw_payloads (
  fetched_at TEXT NOT NULL,
  source     TEXT NOT NULL,
  url        TEXT NOT NULL,
  payload    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_log (
  run_at TEXT NOT NULL,
  kind   TEXT NOT NULL,
  ok     INTEGER NOT NULL,
  rows   INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_forecasts_lookup
  ON forecasts(station, variable, valid_time);
CREATE INDEX IF NOT EXISTS idx_observations_lookup
  ON observations(station, variable, obs_time);
"""


def connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(config.DB_PATH, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(SCHEMA)
    for s in config.STATIONS:
        con.execute(
            "INSERT OR IGNORE INTO stations(icao, nombre, lat, lon) VALUES (?,?,?,?)",
            (s["icao"], s["nombre"], s["lat"], s["lon"]),
        )
    con.commit()
    return con


def log(con: sqlite3.Connection, run_at: str, kind: str, ok: bool, rows: int, detail: str = "") -> None:
    con.execute(
        "INSERT INTO ingest_log(run_at, kind, ok, rows, detail) VALUES (?,?,?,?,?)",
        (run_at, kind, int(ok), rows, detail[:500]),
    )
    con.commit()
