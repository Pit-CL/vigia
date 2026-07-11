"""Farmacias de turno MINSAL — vía satélite en omen.

No fetchea la red: igual que `cortes.py`, MINSAL bloquea IPs de datacenter
(verificado desde el VPS, funciona desde omen). Lee el JSON crudo que
`satelite/fetch_cl.py` sube por scp a `INCOMING_DIR/farmacias_raw.json` y lo
normaliza al formato Vigía.

Endpoint `midas.minsal.cl/farmacia_v2/WS/getLocalesTurnos.php`: el nombre
mismo ("locales en turno") indica que el feed ya viene filtrado por el día
vigente — no se aplica un filtro de fecha propio encima, solo se toman las
filas tal cual llegan. `_campo()` busca case-insensitive entre varios
nombres candidatos por si la respuesta real usa una variante distinta de la
documentada (`local_nombre`, `local_direccion`, `comuna_nombre`,
`funcionamiento_hora_apertura/cierre`, `local_lat/local_lng`).

Georreferencia: si el registro no trae lat/lon (o vienen vacíos/0,0), se
ubica por comuna contra `web/comunas.json` — mismo criterio que `cortes.py`.

Frescura: el satélite fetchea 1x/día (08:00); el cron del VPS procesa 2x/día
(08:33 y 20:33) por si el satélite llega tarde. Si `farmacias_raw.json` no
existe o su `fetched_utc` tiene más de STALE_MIN, se conserva el
farmacias.json previo marcándolo `"stale": true` (mismo patrón que cortes).
"""
import json
import unicodedata
from datetime import datetime, timedelta, timezone

import config

STALE_MIN = 26 * 60  # el satélite trae el feed 1x/día


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.lower().strip()


def _campo(row: dict, *nombres):
    lower = {k.lower(): v for k, v in row.items()}
    for n in nombres:
        v = lower.get(n.lower())
        if v not in (None, ""):
            return v
    return None


def _cargar_comunas() -> dict:
    """nombre normalizado -> {lat, lon}."""
    data = json.loads(config.COMUNAS_PATH.read_text())
    return {_norm(c["n"]): {"lat": c["lat"], "lon": c["lon"]} for c in data["comunas"]}


def _incoming_fresco() -> dict | None:
    path = config.INCOMING_DIR / "farmacias_raw.json"
    if not path.exists():
        return None
    try:
        crudo = json.loads(path.read_text())
        fetched = datetime.strptime(crudo["fetched_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (OSError, json.JSONDecodeError, KeyError, ValueError):
        return None
    if datetime.now(timezone.utc) - fetched > timedelta(minutes=STALE_MIN):
        return None
    return crudo


def _coord(row: dict, *nombres) -> float | None:
    raw = _campo(row, *nombres)
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    return v if v != 0 else None


def _procesar(filas: list, comunas: dict) -> tuple[list, int, int]:
    """Devuelve (farmacias, sin_georef, duplicados)."""
    vistos: set = set()
    farmacias, sin_georef, duplicados = [], 0, 0
    for fila in filas:
        if not isinstance(fila, dict):
            continue
        nombre = _campo(fila, "local_nombre", "nombre_local", "nombre")
        direccion = _campo(fila, "local_direccion", "direccion_local", "direccion")
        if not nombre or not direccion:
            continue
        clave = (_norm(str(nombre)), _norm(str(direccion)))
        if clave in vistos:
            duplicados += 1
            continue
        vistos.add(clave)

        comuna = _campo(fila, "comuna_nombre", "nombre_comuna", "comuna")
        lat = _coord(fila, "local_lat", "lat", "latitud")
        lon = _coord(fila, "local_lng", "local_lon", "lng", "lon", "longitud")
        if lat is None or lon is None:
            geo = comunas.get(_norm(comuna)) if comuna else None
            if geo:
                lat, lon = geo["lat"], geo["lon"]
            else:
                lat = lon = None
                sin_georef += 1

        item = {
            "nombre": str(nombre),
            "direccion": str(direccion),
            "comuna": str(comuna) if comuna else None,
            "lat": lat,
            "lon": lon,
            "abre": _campo(fila, "funcionamiento_hora_apertura", "hora_apertura", "apertura"),
            "cierra": _campo(fila, "funcionamiento_hora_cierre", "hora_cierre", "cierre"),
        }
        telefono = _campo(fila, "local_telefono", "telefono")
        if telefono:
            item["telefono"] = str(telefono)
        farmacias.append(item)
    return farmacias, sin_georef, duplicados


def update(con, fetched_at: str) -> int:
    crudo = _incoming_fresco()
    if crudo is None:
        # Sin incoming fresco (satélite caído o nunca instalado): conserva el
        # farmacias.json previo marcado stale, no lo borra ni lo deja a 0.
        if not config.FARMACIAS_PATH.exists():
            return 0
        try:
            previo = json.loads(config.FARMACIAS_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            return 0
        previo["stale"] = True
        config.FARMACIAS_PATH.write_text(json.dumps(previo, ensure_ascii=False) + "\n")
        return 0

    filas = crudo.get("data")
    if not isinstance(filas, list):
        raise RuntimeError("farmacias MINSAL: incoming/farmacias_raw.json sin campo 'data' de tipo lista")
    comunas = _cargar_comunas()
    farmacias, sin_georef, duplicados = _procesar(filas, comunas)

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "farmacias", "midas.minsal.cl/farmacia_v2/WS/getLocalesTurnos.php",
         json.dumps({"n": len(farmacias), "sin_georef": sin_georef, "duplicados": duplicados})))
    con.commit()

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "MINSAL / Farmanet",
        "stale": False,
        "n": len(farmacias),
        "farmacias": farmacias,
    }
    config.FARMACIAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.FARMACIAS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(farmacias)
