"""Estado de amenaza de tsunami: feed Atom del PTWC (NOAA) + cruce con el
catálogo sísmico propio (tabla `quakes` de sismos.py).

El PTWC no es la autoridad oficial para Chile (lo es el SHOA/SNAM), pero es la
única fuente pública en tiempo real de boletines de tsunami del Pacífico.
Por eso el cruce con sismos propios: ante un sismo mayor y costero, Vigía
recomienda evacuar sin esperar el boletín (que puede tardar minutos u horas
en publicarse o nunca mencionar Chile explícitamente) — y ese cruce se
evalúa SIEMPRE, incluso si el PTWC no responde.

Sin tabla propia (como avisos.py/marea.py): se recalcula entero en cada
corrida. Si el fetch o el parseo del PTWC fallan, la excepción NO se
propaga: se sigue con `cap=None` (equivalente a "sin amenaza vigente") y el
payload queda con `"ptwc": "sin_datos"` (vs `"ok"`) para que el frontend
pueda distinguir "no hay amenaza" de "no sabemos" — pero tsunami.json se
reescribe igual, porque el respaldo sísmico de abajo es justo para ese
escenario.

Semántica de `cap_url is None` (verificado con curl real a PHEBAtom.xml,
2026-07-14): el feed del PTWC siempre trae la entry del último evento
registrado — aunque haya expirado hace días y ya no sea una amenaza vigente
(eso lo maneja `_clasificar` con el chequeo de `expires`, y cuenta como
lectura exitosa: `"ptwc": "ok"`). Que la entry no traiga link a CAP es
entonces un feed malformado/excepcional, no "sin boletines recientes" —
por eso también cuenta como `"ptwc": "sin_datos"`.
"""
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET

import config
import sources

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
    """Reintenta 2× con backoff corto (mismo patrón que sources.http_get_json);
    tras agotar los intentos levanta RuntimeError con la URL sin query string."""
    text, _ = sources.http_get_text(url)
    return text


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
    evento_upper = evento.upper()
    area_texto = f"{evento_upper} {(cap.get('areaDesc') or '').upper()}"
    es_alerta = any(k in evento_upper for k in ("WARNING", "WATCH", "ADVISORY"))
    if es_alerta and ("CHILE" in area_texto or cap.get("severity") in ("Extreme", "Severe")):
        return "amenaza", cap.get("headline") or evento, True
    if "INFORMATION" in evento_upper:
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

    cap = None
    ptwc_ok = False
    estado, mensaje, vigente = "sin_amenaza", "Sin amenaza de tsunami vigente para Chile", False
    try:
        atom_xml = _fetch(API_ATOM)
        cap_url = _ultima_cap_url(atom_xml)
        if cap_url is not None:
            cap = _parse_cap(_fetch(cap_url))
            estado, mensaje, vigente = _clasificar(cap, ahora)
            ptwc_ok = True
        # cap_url is None con fetch exitoso: feed malformado (ver semántica
        # documentada arriba) — no se sube ptwc_ok, cae a "sin_datos".
    except (RuntimeError, ET.ParseError):
        # PTWC caído o feed corrupto: no propagamos la excepción. El cruce
        # sísmico de abajo se evalúa igual — es el respaldo para este caso.
        pass

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
        "ptwc": "ok" if ptwc_ok else "sin_datos",
        "fuente": "PTWC (NOAA) + catálogo sísmico propio",
        "nota": ("La autoridad oficial de alerta de tsunami en Chile es el SHOA (SNAM);"
                 " ante un sismo fuerte en la costa no esperes confirmación: evacúa"),
    }
    config.TSUNAMI_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.TSUNAMI_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return 1 if vigente else 0
