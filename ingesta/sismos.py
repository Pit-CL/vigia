"""Peligros sísmicos: catálogo CSN + USGS y estimación de réplicas (ley de Omori).

Ground truth de eventos: CSN (api.xor.cl, respaldo del catálogo de sismología.cl)
como fuente primaria para Chile; USGS FDSN como respaldo/complemento (si CSN
falla o para eventos que CSN aún no publicó). Dedup por tiempo+distancia: un
mismo sismo reportado por ambas redes no debe aparecer dos veces.
"""
import json
import math
from datetime import datetime, timedelta, timezone

import config
import sources

SCHEMA = """
CREATE TABLE IF NOT EXISTS quakes (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- 'csn' | 'usgs'
  utc_time TEXT NOT NULL,         -- 'YYYY-MM-DDTHH:MM:SSZ'
  lat REAL, lon REAL, depth_km REAL,
  mag REAL, mag_type TEXT,
  ref TEXT,
  inserted TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quakes_time ON quakes(utc_time);
"""

RETENTION_DIAS = 90
VENTANA_JSON_H = 72
MAG_MIN_JSON = 2.5
MAX_EVENTOS_JSON = 100

# Dedup CSN/USGS: mismo evento si coincide en tiempo (< 90 s) y distancia (< 100 km).
DEDUP_SEGUNDOS = 90
DEDUP_KM = 100.0
DEDUP_VENTANA_DIAS = 7   # ventana de eventos CSN considerada para el dedup con USGS

# Omori-Utsu (subducción; valores canónicos, fijos — sin ajuste MLE).
OMORI_P = 1.0
OMORI_C = 0.05          # días
MAINSHOCK_MAG_MIN = 6.0
MAINSHOCK_DIAS = 30
REPLICA_MAG_MIN = 3.0
REPLICA_RADIO_KM = 150.0
REPLICA_N_MIN = 10
REPLICA_T_MIN = 0.25    # días


def ensure_schema(con):
    con.executescript(SCHEMA)


def _dist_km(lat1, lon1, lat2, lon2) -> float:
    """Distancia entre dos puntos (haversine, radio terrestre 6371 km)."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _parse_csn_time(utc_date: str) -> str:
    # "2026-07-09 22:12:45" (ya en UTC) -> "2026-07-09T22:12:45Z"
    return utc_date.replace(" ", "T") + "Z"


# ── CSN (api.xor.cl / sismología.cl): fuente primaria para Chile ───

def _ingest_csn(con, fetched_at: str) -> tuple[int, str | None]:
    """Devuelve (filas, error). Nunca levanta: el caller decide si abortar
    según si la otra fuente (USGS) sí funcionó."""
    try:
        data, url = sources.http_get_json(config.API_SISMOS_CSN)
    except RuntimeError as err:
        return 0, str(err)
    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "csn_sismos", url, json.dumps(data, ensure_ascii=False)))
    rows = []
    for ev in data.get("events", []):
        try:
            depth = ev.get("depth")
            mag = ev["magnitude"]
            rows.append((
                f"csn:{ev['id']}", "csn", _parse_csn_time(ev["utc_date"]),
                float(ev["latitude"]), float(ev["longitude"]),
                float(depth) if depth is not None else None,
                float(mag["value"]), mag.get("measure_unit"),
                ev.get("geo_reference"), fetched_at,
            ))
        except (KeyError, TypeError, ValueError):
            continue
    con.executemany(
        "INSERT OR IGNORE INTO quakes(id, source, utc_time, lat, lon, depth_km, mag, mag_type, ref, inserted)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    return len(rows), None


# ── USGS FDSN: respaldo/complemento, deduplicado contra CSN ────────

def _ingest_usgs(con, fetched_at: str) -> tuple[int, str | None]:
    west, south, east, north = config.CHILE_BBOX
    start = (datetime.now(timezone.utc) - timedelta(days=DEDUP_VENTANA_DIAS)).strftime("%Y-%m-%dT%H:%M:%S")
    try:
        data, url = sources.http_get_json(config.API_SISMOS_USGS, {
            "format": "geojson",
            "minlatitude": south, "maxlatitude": north,
            "minlongitude": west, "maxlongitude": east,
            "starttime": start,
            "minmagnitude": 3,
        })
    except RuntimeError as err:
        return 0, str(err)
    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "usgs_sismos", url, json.dumps(data, ensure_ascii=False)))

    cutoff = (datetime.now(timezone.utc) - timedelta(days=DEDUP_VENTANA_DIAS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    csn_ref = [
        (datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc), lat, lon)
        for t, lat, lon in con.execute(
            "SELECT utc_time, lat, lon FROM quakes WHERE source='csn' AND utc_time >= ?", (cutoff,))
    ]

    rows = []
    for feat in data.get("features", []):
        try:
            props, geom = feat["properties"], feat["geometry"]
            lon, lat, depth = geom["coordinates"][:3]
            t = datetime.fromtimestamp(props["time"] / 1000, tz=timezone.utc)
            mag = float(props["mag"])
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        if any(abs((t - ct).total_seconds()) < DEDUP_SEGUNDOS and _dist_km(lat, lon, clat, clon) < DEDUP_KM
               for ct, clat, clon in csn_ref):
            continue
        rows.append((
            f"usgs:{feat['id']}", "usgs", t.strftime("%Y-%m-%dT%H:%M:%SZ"),
            float(lat), float(lon), float(depth) if depth is not None else None,
            mag, props.get("magType"), props.get("place"), fetched_at,
        ))
    con.executemany(
        "INSERT OR IGNORE INTO quakes(id, source, utc_time, lat, lon, depth_km, mag, mag_type, ref, inserted)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    return len(rows), None


def _prune(con, keep_id: str | None) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DIAS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    if keep_id:
        con.execute("DELETE FROM quakes WHERE utc_time < ? AND id != ?", (cutoff, keep_id))
    else:
        con.execute("DELETE FROM quakes WHERE utc_time < ?", (cutoff,))
    con.commit()


# ── Réplicas: ley de Omori-Utsu (p=1, forma clásica de Omori) ───────

def _omori_stats(n: int, dias: float) -> tuple[float, float, float]:
    """K (ajustado a la muestra), tasa_hoy (réplicas/día en T) y esperadas_24h.
    c y p quedan fijos en valores canónicos de subducción; K se resuelve para
    que el modelo reproduzca las N réplicas observadas en T días:
      K = N / ln((T + c) / c)
      tasa_hoy = K / (T + c)
      esperadas_24h = K * ln((T + 1 + c) / (T + c))
    """
    c = OMORI_C
    k = n / math.log((dias + c) / c)
    tasa_hoy = k / (dias + c)
    esperadas_24h = k * math.log((dias + 1 + c) / (dias + c))
    return k, tasa_hoy, esperadas_24h


def _omori(con) -> tuple[str | None, dict | None]:
    """mainshock: mayor magnitud con mag >= 6.0 en los últimos 30 días.
    Sin mainshock vigente -> replicas=None. Réplicas: eventos posteriores a t0,
    mag >= 3.0, a <= 150 km del epicentro. Gates: solo se publica con
    N >= 10 y T >= 0.25 días (si no, la estimación es puro ruido)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=MAINSHOCK_DIAS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    main = con.execute(
        "SELECT id, utc_time, lat, lon, mag, ref FROM quakes"
        " WHERE mag >= ? AND utc_time >= ? ORDER BY mag DESC, utc_time DESC LIMIT 1",
        (MAINSHOCK_MAG_MIN, cutoff)).fetchone()
    if not main:
        return None, None
    mid, t0_str, lat0, lon0, mag0, ref0 = main
    t0 = datetime.strptime(t0_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    dias = (datetime.now(timezone.utc) - t0).total_seconds() / 86400.0

    n = sum(
        1 for _, lat, lon, mag in con.execute(
            "SELECT id, lat, lon, mag FROM quakes WHERE utc_time > ? AND mag >= ?",
            (t0_str, REPLICA_MAG_MIN))
        if _dist_km(lat0, lon0, lat, lon) <= REPLICA_RADIO_KM
    )

    if n < REPLICA_N_MIN or dias < REPLICA_T_MIN:
        return mid, None

    _, tasa_hoy, esperadas_24h = _omori_stats(n, dias)
    replicas = {
        "mainshock_id": mid,
        "mag": round(mag0, 1),
        "t0_utc": t0_str,
        "ref": ref0,
        "dias": round(dias, 1),
        "n_observadas_m3": n,
        "modelo": "Omori p=1, c=0.05 d",
        "tasa_hoy": round(tasa_hoy, 1),
        "esperadas_24h": round(esperadas_24h, 1),
        "nota": "Estimación estadística de réplicas (ley de Omori); no es un pronóstico determinista.",
    }
    return mid, replicas


def _export_json(con, replicas: dict | None) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=VENTANA_JSON_H)).strftime("%Y-%m-%dT%H:%M:%SZ")
    eventos = [{
        "id": id_, "utc_time": utc_time,
        "lat": round(lat, 3), "lon": round(lon, 3),
        "prof_km": round(depth_km, 1) if depth_km is not None else None,
        "mag": round(mag, 1), "mag_tipo": mag_type,
        "ref": ref, "fuente": source,
    } for id_, source, utc_time, lat, lon, depth_km, mag, mag_type, ref in con.execute(
        "SELECT id, source, utc_time, lat, lon, depth_km, mag, mag_type, ref FROM quakes"
        " WHERE utc_time >= ? AND mag >= ? ORDER BY utc_time DESC LIMIT ?",
        (cutoff, MAG_MIN_JSON, MAX_EVENTOS_JSON))]
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "CSN (api.xor.cl) + USGS FDSN",
        "eventos": eventos,
        "replicas": replicas,
    }
    config.SISMOS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.SISMOS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(eventos)


def update(con, fetched_at: str) -> int:
    ensure_schema(con)
    n_csn, err_csn = _ingest_csn(con, fetched_at)
    n_usgs, err_usgs = _ingest_usgs(con, fetched_at)
    if err_csn and err_usgs:
        raise RuntimeError(f"CSN y USGS fallaron: csn={err_csn} | usgs={err_usgs}")
    if err_csn:
        print(f"[aviso] CSN falló, sigue con USGS: {err_csn}")
    if err_usgs:
        print(f"[aviso] USGS falló, sigue con CSN: {err_usgs}")

    mainshock_id, replicas = _omori(con)
    _prune(con, mainshock_id)
    _export_json(con, replicas)
    return n_csn + n_usgs
