"""Cortes de luz SEC (interrupciones en línea) — vía satélite en omen.

No fetchea la red: SEC bloquea IPs de datacenter (verificado desde el VPS,
funciona desde omen). Lee el JSON crudo que `satelite/fetch_cl.py` sube por
scp a `INCOMING_DIR/sec.json` y lo agrega por comuna.

Endpoint no documentado (`apps.sec.cl/INTONLINEv1/ClientesAfectados/
GetPorFecha`): igual que la RNVV, se etiqueta best-effort. Estructura
verificada desde omen: lista de registros por comuna/empresa con el campo
`CLIENTES_AFECTADOS` (mayúsculas — convención típica de estas APIs
gubernamentales chilenas); `_campo()` busca case-insensitive por si la
respuesta real varía.

Frescura: si `INCOMING_DIR/sec.json` no existe o su `fetched_utc` tiene más
de STALE_MIN, se conserva el cortes.json previo marcándolo `"stale": true`
(mismo patrón que el "parcial" de emergencia.py, aplicado a "todo el
archivo es viejo" en vez de "una categoría falló").
"""
import json
import unicodedata
from datetime import datetime, timedelta, timezone

import config

STALE_MIN = 30


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
    """nombre normalizado -> {lat, lon, region}."""
    data = json.loads(config.COMUNAS_PATH.read_text())
    return {_norm(c["n"]): {"lat": c["lat"], "lon": c["lon"], "region": c["r"]} for c in data["comunas"]}


def _incoming_fresco() -> dict | None:
    path = config.INCOMING_DIR / "sec.json"
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


def _agregar(filas: list, comunas: dict) -> tuple[list, list]:
    """Agrupa por comuna: suma clientes afectados, junta empresas. Devuelve
    (cortes, sin_georef); comunas sin match en comunas.json van igual, con
    lat/lon null."""
    por_comuna: dict = {}
    for fila in filas:
        if not isinstance(fila, dict):
            continue
        comuna = _campo(fila, "COMUNA", "NOMBRE_COMUNA", "COMUNA_NOMBRE")
        if not comuna:
            continue
        empresa = _campo(fila, "EMPRESA", "NOMBRE_EMPRESA", "EMPRESA_NOMBRE")
        clientes_raw = _campo(fila, "CLIENTES_AFECTADOS", "CLIENTES", "N_CLIENTES_AFECTADOS")
        try:
            clientes = int(float(clientes_raw)) if clientes_raw is not None else 0
        except (TypeError, ValueError):
            clientes = 0
        d = por_comuna.setdefault(comuna, {"clientes": 0, "empresas": set()})
        d["clientes"] += clientes
        if empresa:
            d["empresas"].add(str(empresa))

    cortes, sin_georef = [], []
    for comuna, d in por_comuna.items():
        geo = comunas.get(_norm(comuna))
        cortes.append({
            "comuna": comuna,
            "region": geo["region"] if geo else None,
            "lat": geo["lat"] if geo else None,
            "lon": geo["lon"] if geo else None,
            "clientes": d["clientes"],
            "empresas": sorted(d["empresas"]),
        })
        if not geo:
            sin_georef.append(comuna)
    cortes.sort(key=lambda c: -c["clientes"])
    return cortes, sin_georef


def update(con, fetched_at: str) -> int:
    crudo = _incoming_fresco()
    if crudo is None:
        # Sin incoming fresco (satélite caído o nunca instalado): conserva el
        # cortes.json previo marcado stale, no lo borra ni lo deja a 0.
        if not config.CORTES_PATH.exists():
            return 0
        try:
            previo = json.loads(config.CORTES_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            return 0
        previo["stale"] = True
        config.CORTES_PATH.write_text(json.dumps(previo, ensure_ascii=False) + "\n")
        return 0

    filas = crudo.get("data")
    if not isinstance(filas, list):
        raise RuntimeError("cortes SEC: incoming/sec.json sin campo 'data' de tipo lista")
    comunas = _cargar_comunas()
    cortes, sin_georef = _agregar(filas, comunas)

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "cortes", "apps.sec.cl/INTONLINEv1/ClientesAfectados/GetPorFecha",
         json.dumps({"n_comunas": len(cortes), "sin_georef": len(sin_georef)})))
    con.commit()

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SEC (interrupciones en línea) · best effort",
        "stale": False,
        "n_comunas": len(cortes),
        "total_clientes": sum(c["clientes"] for c in cortes),
        "cortes": cortes,
    }
    if sin_georef:
        payload["sin_georef"] = sin_georef
    config.CORTES_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.CORTES_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(cortes)
