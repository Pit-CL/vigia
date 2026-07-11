"""Estado de amenaza de tsunami: feed Atom del PTWC (NOAA) + cruce con el
catálogo sísmico propio (tabla `quakes` de sismos.py).

El PTWC no es la autoridad oficial para Chile (lo es el SHOA/SNAM), pero es la
única fuente pública en tiempo real de boletines de tsunami del Pacífico.
Por eso el cruce con sismos propios: ante un sismo mayor y costero, Vigía
recomienda evacuar sin esperar el boletín (que puede tardar minutos u horas
en publicarse o nunca mencionar Chile explícitamente).

Sin tabla propia (como avisos.py/marea.py): se recalcula entero en cada
corrida. Si la red falla, se propaga la excepción y el tsunami.json anterior
queda vigente — nunca se escribe un JSON corrupto o vacío.
"""
import json
import sqlite3
import urllib.request
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

import config

UA = "vigia-ingesta/1.0 (proyecto open source; vigia.cavara.cl)"
API_ATOM = "https://www.tsunami.gov/events/xml/PHEBAtom.xml"

VENTANA_SISMO_H = 1
MAG_MIN_PRECAUCION = 7.0
# Costa/mar de Chile: bbox amplio (continental + Drake), lon acotada al oeste
# de la cordillera para no capturar sismos cordilleranos/trasandinos.
LAT_MIN, LAT_MAX = -56.0, -17.0
LON_MAX = -68.0

MSG_PRECAUCION = (
    "Sismo mayor en la costa: si te costó mantenerte en pie, evacúa la costa"
    " de inmediato hacia terreno alto sin esperar confirmación oficial")


def _tag(el) -> str:
    return el.tag.split("}")[-1]


def _find(el, name):
    for child in el:
        if _tag(child) == name:
            return child
    return None


def _findtext(el, name) -> str | None:
    child = _find(el, name) if el is not None else None
    return child.text.strip() if child is not None and child.text else None


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read().decode("utf-8", errors="replace")


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except ValueError:
        return None


def _ultima_cap_url(atom_xml: str) -> str | None:
    """El feed del PTWC trae la entry más reciente primero."""
    root = ET.fromstring(atom_xml)
    entry = next((e for e in root if _tag(e) == "entry"), None)
    if entry is None:
        return None
    for link in entry:
        if _tag(link) == "link" and link.get("type") == "application/cap+xml":
            return link.get("href")
    return None


def _parse_cap(cap_xml: str) -> dict:
    root = ET.fromstring(cap_xml)
    info = _find(root, "info")
    area = _find(info, "area") if info is not None else None
    return {
        "status": _findtext(root, "status"),
        "sent": _findtext(root, "sent"),
        "event": _findtext(info, "event"),
        "severity": _findtext(info, "severity"),
        "certainty": _findtext(info, "certainty"),
        "headline": _findtext(info, "headline"),
        "onset": _findtext(info, "onset"),
        "expires": _findtext(info, "expires"),
        "areaDesc": _findtext(area, "areaDesc"),
    }


def _clasificar(cap: dict, ahora) -> tuple[str, str, bool]:
    """(estado, mensaje, vigente). vigente = boletín con status Actual y no
    expirado (independiente de si clasifica como amenaza/informativo)."""
    expira = _parse_dt(cap.get("expires"))
    vigente = cap.get("status") == "Actual" and not (expira and expira < ahora)
    if not vigente:
        return "sin_amenaza", "Sin amenaza de tsunami vigente para Chile", False

    evento = cap.get("event") or ""
    area_texto = f"{evento} {cap.get('areaDesc') or ''}".upper()
    es_alerta = any(k in evento for k in ("Warning", "Watch", "Advisory"))
    if es_alerta and ("CHILE" in area_texto or cap.get("severity") in ("Extreme", "Severe")):
        return "amenaza", cap.get("headline") or evento, True
    if "Information" in evento:
        mensaje = f"Último boletín del PTWC ({evento}): no es una amenaza para Chile"
        return "informativo", mensaje, True
    return "sin_amenaza", "Sin amenaza de tsunami vigente para Chile", True


def _hay_sismo_mayor_costero(con, ahora) -> bool:
    cutoff = (ahora - timedelta(hours=VENTANA_SISMO_H)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        row = con.execute(
            "SELECT 1 FROM quakes WHERE utc_time >= ? AND mag >= ?"
            " AND lat BETWEEN ? AND ? AND lon <= ? LIMIT 1",
            (cutoff, MAG_MIN_PRECAUCION, LAT_MIN, LAT_MAX, LON_MAX)).fetchone()
        return row is not None
    except sqlite3.OperationalError:
        # tsunami.py puede correr sin que sismos.py haya creado la tabla aún
        # (p.ej. primera corrida con --tsunami solo, sin --sismos).
        return False


def update(con, fetched_at: str) -> int:
    ahora = datetime.now(timezone.utc)
    atom_xml = _fetch(API_ATOM)
    cap_url = _ultima_cap_url(atom_xml)

    if cap_url is None:
        cap, estado, mensaje, vigente = None, "sin_amenaza", "Sin amenaza de tsunami vigente para Chile", False
    else:
        cap = _parse_cap(_fetch(cap_url))
        estado, mensaje, vigente = _clasificar(cap, ahora)

    if estado != "amenaza" and _hay_sismo_mayor_costero(con, ahora):
        estado, mensaje = "precaucion", MSG_PRECAUCION

    boletin = None
    if cap is not None:
        boletin = {
            "evento": cap.get("event"), "severidad": cap.get("severity"),
            "titular": cap.get("headline"), "area": cap.get("areaDesc"),
            "emitido": cap.get("sent"), "expira": cap.get("expires"),
        }

    payload = {
        "updated": ahora.strftime("%Y-%m-%d %H:%M UTC"),
        "estado": estado,
        "mensaje": mensaje,
        "boletin": boletin,
        "fuente": "PTWC (NOAA) + catálogo sísmico propio",
        "nota": ("La autoridad oficial de alerta de tsunami en Chile es el SHOA (SNAM);"
                 " ante un sismo fuerte en la costa no esperes confirmación: evacúa"),
    }
    config.TSUNAMI_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.TSUNAMI_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return 1 if vigente else 0
