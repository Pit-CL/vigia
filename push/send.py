#!/usr/bin/env python3
"""Envío de notificaciones Web Push de emergencia (Vigía). Corre por cron
cada 5 min dentro del contenedor `push` — única pieza del proyecto que usa
`pywebpush` (ver excepción a la regla de cero-dependencias en CLAUDE.md).

Lee los JSON de peligros ya publicados por la ingesta (sismos, alertas,
volcanes, tsunami), decide qué eventos disparan notificación y evita
reenviar el mismo evento dos veces a la misma suscripción (tabla `sent`).

Umbrales: nacionales para subs sin ubicación (comportamiento original).
Subs con ubicación (opt-in "solo mi zona") agregan un criterio de cercanía
con umbral más bajo — ver `_cumple()`.
"""
import json
import math
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pywebpush import WebPushException, webpush

DB_PATH = Path(os.environ.get("PUSH_DB", Path(__file__).resolve().parent.parent / "data" / "push.db"))
SISMOS_PATH = Path(os.environ.get("PUSH_SISMOS", "/data/sismos.json"))
ALERTAS_PATH = Path(os.environ.get("PUSH_ALERTAS", "/data/alertas.json"))
VOLCANES_PATH = Path(os.environ.get("PUSH_VOLCANES", "/data/volcanes.json"))
TSUNAMI_PATH = Path(os.environ.get("PUSH_TSUNAMI", "/data/tsunami.json"))

SITE_URL = "https://vigia.cavara.cl/"
KIT_URL = "https://vigia.cavara.cl/emergencia.html#kit"
ACCION = "Revisa el mapa y tus vías de evacuación"

VENTANA_SISMO_H = 2
MAG_ALTA = 6.5
MAG_PAGER = 6.0
# USGS PAGER: "alert" es el color agregado del evento (green/yellow/orange/red);
# la API nunca lo traduce a español.
PAGER_NIVELES = {"yellow", "orange", "red"}
VOLCAN_NIVELES = {"naranja", "roja"}

# Modo "solo mi zona" (opt-in, columnas subs.lat/lon/radio_km/mag_min):
# umbral de magnitud y radio por defecto cuando la sub no fija los suyos.
MAG_MIN_ZONA = 5.5
RADIO_KM_ZONA = 200
# Piso absoluto de mag_min aceptado por el servidor (push/server.py): el pool
# de sismos candidatos a "zona" no puede ser más estricto que esto o
# descartaría eventos que sí calificarían para alguna sub.
MAG_MIN_ZONA_PISO = 4.5


def _dist_km(lat1, lon1, lat2, lon2) -> float:
    """Distancia entre dos puntos (haversine, radio terrestre 6371 km).
    Misma fórmula que ingesta/sismos.py:_dist_km."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _eventos_sismos() -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=VENTANA_SISMO_H)
    eventos = []
    for ev in _load_json(SISMOS_PATH).get("eventos", []):
        mag = ev.get("mag")
        lat, lon = ev.get("lat"), ev.get("lon")
        if mag is None or lat is None or lon is None:
            continue
        try:
            t = datetime.strptime(ev["utc_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        if t < cutoff:
            continue
        pager = (ev.get("pager") or "").lower()
        nacional = mag >= MAG_ALTA or (mag >= MAG_PAGER and pager in PAGER_NIVELES)
        if not nacional and mag < MAG_MIN_ZONA_PISO:
            continue  # ni nacional ni candidato a ninguna sub de zona
        titulo = f"🌊 Sismo M{mag:.1f} — {ev.get('ref') or 'Chile'}"
        eventos.append({
            "id": f"sismo:{ev['id']}", "titulo": titulo, "body": ACCION, "url": SITE_URL,
            "tipo": "sismo", "mag": mag, "lat": lat, "lon": lon, "nacional": nacional,
        })
    return eventos


def _eventos_alertas() -> list[dict]:
    eventos = []
    for al in _load_json(ALERTAS_PATH).get("alertas", []):
        if al.get("nivel") != "roja":
            continue
        categoria = al.get("categoria", "")
        region = al.get("region") or "Chile"
        desde = al.get("desde") or ""
        event_id = f"alerta:{categoria}:{region}:{desde}"
        titulo = f"🔴 Alerta Roja — {al.get('evento') or categoria} en {region}"
        eventos.append({
            "id": event_id, "titulo": titulo, "body": ACCION, "url": SITE_URL,
            "tipo": "regional", "lat": al.get("lat"), "lon": al.get("lon"),
        })
    return eventos


def _eventos_volcanes() -> list[dict]:
    eventos = []
    for v in _load_json(VOLCANES_PATH).get("volcanes", []):
        nivel = v.get("nivel")
        if nivel not in VOLCAN_NIVELES:
            continue
        nombre = v.get("nombre") or "?"
        eventos.append({
            "id": f"volcan:{nombre}:{nivel}", "titulo": f"🌋 Volcán {nombre} en alerta {nivel}",
            "body": ACCION, "url": SITE_URL, "tipo": "regional", "lat": v.get("lat"), "lon": v.get("lon"),
        })
    return eventos


def _eventos_tsunami() -> list[dict]:
    data = _load_json(TSUNAMI_PATH)
    if data.get("estado") != "amenaza":
        return []
    b = data.get("boletin") or {}
    event_id = f"tsunami:{b.get('evento')}:{b.get('area')}:{b.get('emitido')}"
    titulo = "🌊 AMENAZA DE TSUNAMI — evacúa la costa"
    body = "Sigue las instrucciones oficiales (SHOA/SENAPRED) y aléjate de la costa"
    # Amenaza de tsunami: siempre a todos, nunca se filtra por zona/distancia.
    return [{"id": event_id, "titulo": titulo, "body": body, "url": SITE_URL, "tipo": "tsunami"}]


def _evento_kit(ahora: datetime) -> dict:
    """Recordatorio semestral opcional (kit_reminder=1). id sintético
    kit:{YYYY}-{H1|H2} — cambia solo dos veces al año, así que `sent`
    lo dedup-ea de forma natural igual que cualquier otro evento."""
    semestre = "H1" if ahora.month <= 6 else "H2"
    return {
        "id": f"kit:{ahora.year}-{semestre}",
        "titulo": "¿Tu kit de emergencia sigue al día?",
        "body": "Revisa vencimientos de agua, pilas, medicamentos y comida (72 h por persona).",
        "url": KIT_URL, "tipo": "kit",
    }


def _cumple(ev: dict, sub: dict) -> bool:
    """Decide si una suscripción concreta debe recibir el evento."""
    tipo = ev["tipo"]
    if tipo == "tsunami":
        return True

    lat, lon = sub.get("lat"), sub.get("lon")
    con_ubicacion = lat is not None and lon is not None

    if tipo == "sismo":
        if not con_ubicacion:
            return ev["nacional"]
        if ev["nacional"]:
            return True
        radio = sub.get("radio_km") or RADIO_KM_ZONA
        umbral = sub.get("mag_min") or MAG_MIN_ZONA
        return ev["mag"] >= umbral and _dist_km(lat, lon, ev["lat"], ev["lon"]) <= radio

    # "regional": alertas rojas y volcanes naranja+. Sin ubicación en la sub
    # -> broadcast (comportamiento original). Con ubicación -> filtrar por
    # distancia, salvo que el propio evento no traiga coords (centroide no
    # calculable): ahí tampoco se puede filtrar, así que va a todos.
    if not con_ubicacion:
        return True
    if ev.get("lat") is None or ev.get("lon") is None:
        return True
    radio = sub.get("radio_km") or RADIO_KM_ZONA
    return _dist_km(lat, lon, ev["lat"], ev["lon"]) <= radio


def _ensure_schema(con: sqlite3.Connection) -> None:
    con.execute(
        "CREATE TABLE IF NOT EXISTS subs("
        "endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created TEXT)"
    )
    for ddl in (
        "ALTER TABLE subs ADD COLUMN lat REAL",
        "ALTER TABLE subs ADD COLUMN lon REAL",
        "ALTER TABLE subs ADD COLUMN radio_km INTEGER",
        "ALTER TABLE subs ADD COLUMN mag_min REAL",
        "ALTER TABLE subs ADD COLUMN kit_reminder INTEGER DEFAULT 0",
    ):
        try:
            con.execute(ddl)
        except sqlite3.OperationalError:
            pass

    # Migración: `sent` dedup-eaba por event_id global (un solo envío por
    # evento, a todas las subs). Ahora el envío se filtra por sub, así que el
    # dedup debe ser por (event_id, endpoint). Si existe el esquema viejo
    # (sin columna endpoint) se recrea: se pierde el historial de envíos ya
    # hechos, es decir en el peor caso se re-notifica una vez algo que ya se
    # había mandado antes de esta migración — aceptado, documentado aquí.
    cols = [r[1] for r in con.execute("PRAGMA table_info(sent)")]
    if cols and "endpoint" not in cols:
        con.execute("DROP TABLE sent")
    con.execute(
        "CREATE TABLE IF NOT EXISTS sent("
        "event_id TEXT, endpoint TEXT, sent_at TEXT, PRIMARY KEY(event_id, endpoint))"
    )
    con.commit()


def _enviar_evento(con: sqlite3.Connection, subs: list[tuple[str, str, str]], titulo: str, body: str, url: str) -> set[str]:
    """Envía a la lista de suscripciones ya filtrada para este evento.
    Devuelve los endpoints que resultaron caducados (404/410) para que el
    caller los descarte."""
    payload = json.dumps({"title": titulo, "body": body, "url": url})
    vapid_private_key = os.environ["VAPID_PRIVATE_KEY"]
    contacto = os.environ.get("VAPID_CONTACT", "rafaelfariaspoblete@gmail.com")
    caducados = set()

    for endpoint, p256dh, auth in subs:
        sub_info = {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}
        try:
            webpush(
                subscription_info=sub_info,
                data=payload,
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": "mailto:" + contacto},
            )
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status in (404, 410):
                con.execute("DELETE FROM subs WHERE endpoint = ?", (endpoint,))
                con.commit()
                caducados.add(endpoint)
                print(f"[push] suscripción caducada ({status}), eliminada: {endpoint[:48]}...")
            else:
                print(f"[push] error enviando a {endpoint[:48]}...: {exc}")
        except Exception as exc:  # red/DNS/cifrado: nunca debe tumbar el cron
            print(f"[push] error inesperado enviando a {endpoint[:48]}...: {exc}")

    return caducados


def seleccionar(eventos: list[dict], subs: list[tuple], ya_enviados: set[tuple[str, str]]) -> list[tuple[dict, list[tuple[str, str, str]]]]:
    """Para cada evento, arma la lista de (endpoint,p256dh,auth) que debe
    recibirlo: cumple su criterio (`_cumple`, o kit_reminder=1 para el
    recordatorio de kit) y no está ya en `sent`. Separado de `main()` para
    poder probarlo sin enviar de verdad (ver push/send.py bajo test)."""
    resultado = []
    for ev in eventos:
        destinatarios = []
        for endpoint, p256dh, auth, lat, lon, radio_km, mag_min, kit_reminder in subs:
            if (ev["id"], endpoint) in ya_enviados:
                continue
            if ev["tipo"] == "kit":
                if kit_reminder != 1:
                    continue
            else:
                sub = {"lat": lat, "lon": lon, "radio_km": radio_km, "mag_min": mag_min}
                if not _cumple(ev, sub):
                    continue
            destinatarios.append((endpoint, p256dh, auth))
        if destinatarios:
            resultado.append((ev, destinatarios))
    return resultado


def main() -> None:
    ahora = datetime.now(timezone.utc)
    eventos = _eventos_sismos() + _eventos_alertas() + _eventos_volcanes() + _eventos_tsunami()
    eventos.append(_evento_kit(ahora))

    con = sqlite3.connect(DB_PATH)
    _ensure_schema(con)

    subs = con.execute(
        "SELECT endpoint, p256dh, auth, lat, lon, radio_km, mag_min, kit_reminder FROM subs"
    ).fetchall()
    if not subs:
        con.close()
        return

    ya_enviados = {(r[0], r[1]) for r in con.execute("SELECT event_id, endpoint FROM sent").fetchall()}

    for ev, destinatarios in seleccionar(eventos, subs, ya_enviados):
        caducados = _enviar_evento(con, destinatarios, ev["titulo"], ev["body"], ev["url"])
        for endpoint, _, _ in destinatarios:
            con.execute(
                "INSERT OR IGNORE INTO sent(event_id, endpoint, sent_at) VALUES (?, ?, datetime('now'))",
                (ev["id"], endpoint),
            )
        con.commit()
        if caducados:
            subs = [s for s in subs if s[0] not in caducados]

    con.close()


if __name__ == "__main__":
    main()
