"""Peligro de incendios: focos de calor satelitales NASA FIRMS (VIIRS 375 m).

Ground truth: detecciones VIIRS de los productos NRT de NOAA-20 y Suomi NPP
(API FIRMS area/csv). Requiere una MAP_KEY personal y gratuita
(firms.modaps.eosdis.nasa.gov/api/area/csv.html); sin ella el módulo no hace
nada (silencioso, mismo patrón que ingest_dmc sin credenciales en sources.py).

Un foco de calor NO es necesariamente un incendio (puede ser quema agrícola,
flare industrial, etc.) — el frontend debe dejarlo explícito.
"""
import csv
import io
import json
from datetime import datetime, timedelta, timezone

import config
import sources

SCHEMA = """
CREATE TABLE IF NOT EXISTS fires (
  lat REAL NOT NULL, lon REAL NOT NULL,
  acq_utc TEXT NOT NULL,      -- 'YYYY-MM-DDTHH:MMZ'
  sat TEXT NOT NULL,          -- 'SNPP' | 'N20'
  frp REAL, confidence TEXT, daynight TEXT,
  UNIQUE(lat, lon, acq_utc, sat) ON CONFLICT IGNORE
);
CREATE INDEX IF NOT EXISTS idx_fires_time ON fires(acq_utc);
"""

RETENTION_DIAS = 7
VENTANA_JSON_H = 48
MAX_FOCOS_JSON = 5000

# Producto FIRMS -> etiqueta de satélite. No confiar en la columna 'satellite'
# del CSV: VIIRS_SNPP_NRT a veces la reporta como 'N' en vez de 'SNPP'.
PRODUCTOS = {"VIIRS_SNPP_NRT": "SNPP", "VIIRS_NOAA20_NRT": "N20"}


def ensure_schema(con):
    con.executescript(SCHEMA)


def _parse_csv(text: str, sat: str | None = None) -> list[tuple]:
    """Filas (lat, lon, acq_utc, sat, frp, confidence, daynight) desde un CSV
    de FIRMS. `sat` fuerza la etiqueta (producto conocido); si se omite, cae
    a la columna 'satellite' del CSV (solo para pruebas del parser)."""
    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat, lon = float(row["latitude"]), float(row["longitude"])
            hhmm = row["acq_time"].strip().zfill(4)
            acq_utc = f"{row['acq_date']}T{hhmm[:2]}:{hhmm[2:]}Z"
        except (KeyError, TypeError, ValueError):
            continue
        frp = row.get("frp")
        rows.append((
            lat, lon, acq_utc, sat or row.get("satellite", ""),
            float(frp) if frp not in (None, "") else None,
            row.get("confidence"), row.get("daynight"),
        ))
    return rows


def _fetch_producto(con, fetched_at: str, producto: str, sat: str) -> tuple[list[tuple], str | None]:
    west, south, east, north = config.CHILE_BBOX
    url = f"{config.API_FIRMS}/{config.FIRMS_MAP_KEY}/{producto}/{west},{south},{east},{north}/2"
    try:
        text, fetched_url = sources.http_get_text(url)
    except RuntimeError as err:
        return [], str(err)
    if text.strip().startswith("Invalid"):
        return [], f"FIRMS rechazó la solicitud ({producto}): {text.strip()[:120]}"
    # La MAP_KEY va en el path: jamás persistirla, ni en raw_payloads.
    masked_url = fetched_url.replace(config.FIRMS_MAP_KEY, "***")
    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, f"firms_{producto.lower()}", masked_url, text))
    return _parse_csv(text, sat=sat), None


def _prune(con) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DIAS)).strftime("%Y-%m-%dT%H:%MZ")
    con.execute("DELETE FROM fires WHERE acq_utc < ?", (cutoff,))
    con.commit()


def _export_json(con) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=VENTANA_JSON_H)).strftime("%Y-%m-%dT%H:%MZ")
    total = con.execute("SELECT COUNT(*) FROM fires WHERE acq_utc >= ?", (cutoff,)).fetchone()[0]
    focos = [{
        "lat": round(lat, 3), "lon": round(lon, 3),
        "frp": round(frp, 1) if frp is not None else None,
        "conf": confidence, "sat": sat, "utc": acq_utc,
    } for lat, lon, acq_utc, sat, frp, confidence in con.execute(
        "SELECT lat, lon, acq_utc, sat, frp, confidence FROM fires"
        " WHERE acq_utc >= ? ORDER BY frp DESC LIMIT ?", (cutoff, MAX_FOCOS_JSON))]
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "NASA FIRMS · VIIRS 375 m",
        "ventana_h": VENTANA_JSON_H,
        "n": total,
        "focos": focos,
    }
    if total > MAX_FOCOS_JSON:
        payload["nota"] = "se muestran los 5000 focos de mayor intensidad"
    config.INCENDIOS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.INCENDIOS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return total


def update(con, fetched_at: str) -> int:
    ensure_schema(con)
    if not config.FIRMS_MAP_KEY:
        return 0

    rows, errores = [], []
    for producto, sat in PRODUCTOS.items():
        prod_rows, err = _fetch_producto(con, fetched_at, producto, sat)
        rows.extend(prod_rows)
        if err:
            errores.append(err)
    con.commit()
    if len(errores) == len(PRODUCTOS):
        raise RuntimeError(f"FIRMS falló para todos los productos: {'; '.join(errores)}")
    if errores:
        print(f"[aviso] FIRMS parcial ({len(errores)} producto(s) sin datos): {'; '.join(errores)}")

    con.executemany(
        "INSERT OR IGNORE INTO fires(lat, lon, acq_utc, sat, frp, confidence, daynight)"
        " VALUES (?,?,?,?,?,?,?)", rows)
    con.commit()
    _prune(con)
    return _export_json(con)
