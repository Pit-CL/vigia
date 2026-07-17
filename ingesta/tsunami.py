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
2026-07-14): el feed del PTWC normalmente trae la entry del último evento
registrado — aunque haya expirado hace días y ya no sea una amenaza vigente
(eso lo maneja `_clasificar` con el chequeo de `expires`, y cuenta como
lectura exitosa: `"ptwc": "ok"`). Que la entry no traiga link a CAP es
entonces un feed malformado/excepcional, no "sin boletines recientes" —
por eso también cuenta como `"ptwc": "sin_datos"`.

Esa semántica quedó FALSIFICADA el 2026-07-17: durante un evento activo
(sismo M7.4 en Chiapas, México, con boletines del PTWC en curso) el feed
vino sin ninguna `<entry>` — solo metadatos a nivel de feed (`<title>`
"TSUNAMI MESSAGE NUMBER N", `<updated>` reciente). No es un feed corrupto:
es una ventana real en la que el PTWC todavía no publica la entry
individual. Ese caso se distingue mirando el título/fecha del feed
(`_evento_activo_sin_cap`) y se reporta como `"ptwc": "parcial"` con
estado `"informativo"` — nunca como amenaza, porque no pudimos leer el CAP
y no sabemos si declara a Chile.
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
MSG_SIN_DATOS = "Sin amenaza conocida para Chile (sin datos del PTWC en este momento)"
MSG_EVENTO_ACTIVO_GENERICO = (
    "El PTWC emitió boletines por un evento en el Pacífico — no hay amenaza"
    " declarada para Chile")
# Feed sin entries: evento activo si el título contiene "TSUNAMI" y el feed
# se actualizó dentro de esta ventana (ver semántica en el docstring).
VENTANA_EVENTO_ACTIVO_H = 12
# Contexto del sismo (USGS, sin bbox) para el mensaje del estado "informativo".
MAG_MIN_CONTEXTO_USGS = 6.5


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


def _evento_activo_sin_cap(atom_xml: str, ahora) -> bool:
    """Feed sin entries (ver semántica en el docstring del módulo): mira el
    <title>/<updated> a nivel de feed para distinguir "evento activo cuyo
    boletín individual aún no se publica como entry" de "feed vacío sin
    novedad". Observado 2026-07-17 (sismo M7.4 México): título "TSUNAMI
    MESSAGE NUMBER 4" con <updated> reciente, cero <entry>."""
    root = ET.fromstring(atom_xml)
    titulo = _findtext(root, "title")
    actualizado = _parse_dt(_findtext(root, "updated"))
    if not titulo or "TSUNAMI" not in titulo.upper():
        return False
    return actualizado is not None and (ahora - actualizado) <= timedelta(hours=VENTANA_EVENTO_ACTIVO_H)


def _sismo_reciente_usgs(ahora) -> dict | None:
    """Sismo M>=6.5 más reciente en cualquier parte (sin bbox de Chile) en
    las últimas 24 h — solo contexto para el mensaje del estado
    "informativo" cuando el feed del PTWC no trae entries; nunca se inserta
    en la tabla quakes. Best-effort: cualquier falla (red, forma inesperada
    del payload) devuelve None, nunca propaga."""
    start = (ahora - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S")
    try:
        data, _ = sources.http_get_json(config.API_SISMOS_USGS, {
            "format": "geojson",
            "starttime": start,
            "minmagnitude": MAG_MIN_CONTEXTO_USGS,
            "orderby": "magnitude",
            "limit": 1,
        })
        feats = data.get("features") or []
        if not feats:
            return None
        props = feats[0].get("properties") or {}
        place, mag = props.get("place"), props.get("mag")
        if place is None or mag is None:
            return None
        return {"place": place, "mag": float(mag)}
    except (RuntimeError, AttributeError, TypeError, ValueError):
        return None


def _mensaje_evento_activo(ahora) -> str:
    sismo = _sismo_reciente_usgs(ahora)
    if sismo:
        return (f"Sismo M{sismo['mag']:.1f} en {sismo['place']}: el PTWC emitió"
                 " boletines por este evento — no hay amenaza declarada para Chile")
    return MSG_EVENTO_ACTIVO_GENERICO


def _clasificar(cap: dict, ahora) -> tuple[str, str, bool]:
    """(estado, mensaje, vigente). vigente = boletín con status Actual y no
    expirado (independiente de si clasifica como amenaza/informativo)."""
    expira = _parse_dt(cap.get("expires"))
    vigente = cap.get("status") == "Actual" and not (expira and expira < ahora)
    if not vigente:
        return "sin_amenaza", "Sin amenaza de tsunami vigente para Chile", False

    evento = cap.get("event") or ""
    evento_upper = evento.upper()
    area_desc = cap.get("areaDesc") or ""
    area_texto = f"{evento_upper} {area_desc.upper()}"
    es_alerta = any(k in evento_upper for k in ("WARNING", "WATCH", "ADVISORY"))
    if es_alerta and "CHILE" in area_texto:
        return "amenaza", cap.get("headline") or evento, True
    if es_alerta:
        # Warning/Watch/Advisory real, pero Chile no figura en el área: antes
        # un severity Extreme/Severe exclusivo para otra zona (p.ej. México)
        # encendía "amenaza" para Chile igual — falsa alarma latente.
        mensaje = (
            f"El PTWC emitió {evento} para otras zonas del Pacífico"
            f" ({area_desc}) — Chile no está incluido")
        return "informativo", mensaje, True
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
    ptwc_estado = "sin_datos"
    estado, mensaje, vigente = "sin_amenaza", MSG_SIN_DATOS, False
    try:
        atom_xml = _fetch(API_ATOM)
        cap_url = _ultima_cap_url(atom_xml)
        if cap_url is not None:
            cap = _parse_cap(_fetch(cap_url))
            estado, mensaje, vigente = _clasificar(cap, ahora)
            ptwc_estado = "ok"
        elif _evento_activo_sin_cap(atom_xml, ahora):
            # Feed sin entries pero con evento activo detectable a nivel de
            # feed (ver semántica documentada arriba): leímos el feed, no el
            # CAP — "parcial", nunca "amenaza" (no sabemos si declara Chile).
            estado, mensaje, vigente = "informativo", _mensaje_evento_activo(ahora), True
            ptwc_estado = "parcial"
        # feed sin entries y sin evento activo detectable: se conserva el
        # comportamiento anterior ("sin_datos").
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
        "ptwc": ptwc_estado,
        "fuente": "PTWC (NOAA) + catálogo sísmico propio",
        "nota": ("La autoridad oficial de alerta de tsunami en Chile es el SHOA (SNAM);"
                 " ante un sismo fuerte en la costa no esperes confirmación: evacúa"),
    }
    config.TSUNAMI_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.TSUNAMI_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return 1 if vigente else 0
