#!/usr/bin/env python3
"""Envío de notificaciones Web Push de emergencia (Vigía). Corre por cron
cada 5 min dentro del contenedor `push` — única pieza del proyecto que usa
`pywebpush` (ver excepción a la regla de cero-dependencias en CLAUDE.md).

Lee los JSON de peligros ya publicados por la ingesta (sismos, alertas,
volcanes), decide qué eventos disparan notificación y evita reenviar el
mismo evento dos veces (tabla `sent`).
"""
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pywebpush import WebPushException, webpush

DB_PATH = Path(os.environ.get("PUSH_DB", Path(__file__).resolve().parent.parent / "data" / "push.db"))
SISMOS_PATH = Path(os.environ.get("PUSH_SISMOS", "/data/sismos.json"))
ALERTAS_PATH = Path(os.environ.get("PUSH_ALERTAS", "/data/alertas.json"))
VOLCANES_PATH = Path(os.environ.get("PUSH_VOLCANES", "/data/volcanes.json"))

SITE_URL = "https://clima.cavara.cl/"
ACCION = "Revisa el mapa y tus vías de evacuación"

VENTANA_SISMO_H = 2
MAG_ALTA = 6.5
MAG_PAGER = 6.0
# USGS PAGER: "alert" es el color agregado del evento (green/yellow/orange/red);
# la API nunca lo traduce a español.
PAGER_NIVELES = {"yellow", "orange", "red"}
VOLCAN_NIVELES = {"naranja", "roja"}


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _eventos_sismos() -> list[tuple[str, str, str]]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=VENTANA_SISMO_H)
    eventos = []
    for ev in _load_json(SISMOS_PATH).get("eventos", []):
        mag = ev.get("mag")
        if mag is None:
            continue
        try:
            t = datetime.strptime(ev["utc_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        if t < cutoff:
            continue
        pager = (ev.get("pager") or "").lower()
        if mag >= MAG_ALTA or (mag >= MAG_PAGER and pager in PAGER_NIVELES):
            titulo = f"🌊 Sismo M{mag:.1f} — {ev.get('ref') or 'Chile'}"
            eventos.append((f"sismo:{ev['id']}", titulo, ACCION))
    return eventos


def _eventos_alertas() -> list[tuple[str, str, str]]:
    eventos = []
    for al in _load_json(ALERTAS_PATH).get("alertas", []):
        if al.get("nivel") != "roja":
            continue
        categoria = al.get("categoria", "")
        region = al.get("region") or "Chile"
        desde = al.get("desde") or ""
        event_id = f"alerta:{categoria}:{region}:{desde}"
        titulo = f"🔴 Alerta Roja — {al.get('evento') or categoria} en {region}"
        eventos.append((event_id, titulo, ACCION))
    return eventos


def _eventos_volcanes() -> list[tuple[str, str, str]]:
    eventos = []
    for v in _load_json(VOLCANES_PATH).get("volcanes", []):
        nivel = v.get("nivel")
        if nivel not in VOLCAN_NIVELES:
            continue
        nombre = v.get("nombre") or "?"
        eventos.append((f"volcan:{nombre}:{nivel}", f"🌋 Volcán {nombre} en alerta {nivel}", ACCION))
    return eventos


def _ensure_schema(con: sqlite3.Connection) -> None:
    con.execute(
        "CREATE TABLE IF NOT EXISTS subs("
        "endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created TEXT)"
    )
    con.execute("CREATE TABLE IF NOT EXISTS sent(event_id TEXT PRIMARY KEY, sent_at TEXT)")


def _enviar_evento(con: sqlite3.Connection, subs: list[tuple[str, str, str]], titulo: str, body: str) -> set[str]:
    """Envía a todas las suscripciones vigentes. Devuelve los endpoints
    que resultaron caducados (404/410) para que el caller los descarte."""
    payload = json.dumps({"title": titulo, "body": body, "url": SITE_URL})
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


def main() -> None:
    eventos = _eventos_sismos() + _eventos_alertas() + _eventos_volcanes()
    if not eventos:
        return

    con = sqlite3.connect(DB_PATH)
    _ensure_schema(con)

    subs = con.execute("SELECT endpoint, p256dh, auth FROM subs").fetchall()
    if not subs:
        con.close()
        return

    ya_enviados = {row[0] for row in con.execute("SELECT event_id FROM sent").fetchall()}
    nuevos = [ev for ev in eventos if ev[0] not in ya_enviados]
    if not nuevos:
        con.close()
        return

    for event_id, titulo, body in nuevos:
        caducados = _enviar_evento(con, subs, titulo, body)
        if caducados:
            subs = [s for s in subs if s[0] not in caducados]
        con.execute("INSERT OR IGNORE INTO sent(event_id, sent_at) VALUES (?, datetime('now'))", (event_id,))
        con.commit()

    con.close()


if __name__ == "__main__":
    main()
