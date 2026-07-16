"""Vigilancia de frescura de los JSON críticos, con aviso a Slack.

Hoy nadie se entera si la ingesta muere o una fuente de peligro lleva horas
caída (cero monitoreo; el smoke test solo corre al deployar). Este script,
pensado para correr cada 10 min por cron, compara el campo "updated" de
cada JSON crítico contra un umbral propio y avisa por Slack solo en las
transiciones (anti-spam pedido explícito): al ENTRAR en falla, cada 6 h de
recordatorio mientras siga caído, y al recuperarse.

No es un paso de la ingesta (no fetchea nada externo ni escribe en la BD):
es un monitor independiente, igual que push/send.py — se invoca directo
desde cron, no se integra a run.py.

Patrón "dormido" (igual que combustible.py): sin SLACK_WEBHOOK_URL, exit 0
silencioso — no es un error, es que el operador no configuró avisos.

Nunca debe filtrar el webhook: urllib incluye la URL completa en sus
excepciones, así que el manejo de errores solo reporta "HTTP <código>" o
"error de red", jamás el error crudo (que trae la URL).
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config

RECORDATORIO_HORAS = 6

# (clave, path, umbral_min, nombre legible, qué implica para el usuario)
CHECKS = [
    ("tsunami", config.TSUNAMI_PATH, 30,
     "estado de amenaza de tsunami",
     "los usuarios están viendo el estado de tsunami de hace rato sin saberlo"),
    ("sismos", config.SISMOS_PATH, 30,
     "catálogo sísmico",
     "los usuarios están viendo sismos de hace rato sin saberlo"),
    ("alertas", config.ALERTAS_PATH, 180,
     "alertas SENAPRED vigentes",
     "el mapa de alertas puede estar mostrando información vencida"),
    ("incendios", config.INCENDIOS_PATH, 180,
     "focos de incendio activo (NASA FIRMS)",
     "la capa de incendios puede mostrar focos ya apagados o le pueden faltar focos nuevos"),
    ("estaciones", config.ESTACIONES_PATH, 240,
     "observaciones de estaciones (mapa en vivo)",
     "el mapa de estaciones puede estar mostrando datos viejos"),
    ("avisos", config.AVISOS_PATH, 240,
     "avisos meteorológicos",
     "los avisos meteorológicos pueden no reflejar el pronóstico actual"),
    # A diferencia de los anteriores (JSON publicados con campo "updated"),
    # este es el crudo que sube satelite/fetch_cl.py por scp — ver
    # ingesta/cortes.py y ingesta/farmacias.py. Si se congela, cortes.json y
    # farmacias.json quedan sirviendo el último dato bueno marcado "stale"
    # sin que nadie se entere (incidente 2026-07-16: 22 h ciego hasta que
    # avisó la prensa, no el sistema).
    ("satelite", config.INCOMING_DIR / "sec.json", 60,
     "crudo del satélite (SEC cortes / MINSAL farmacias)",
     "cortes de luz y farmacias de turno quedan congelados sin que nadie se entere"),
]


def _leer_updated(path: Path):
    """Datetime UTC de frescura del archivo: campo "updated" (JSON
    publicados) o "fetched_utc" (crudo del satélite, ver satelite/fetch_cl.py).
    None si el archivo falta o no se puede parsear (ambos cuentan como falla)."""
    try:
        data = json.loads(path.read_text())
        if "updated" in data:
            return datetime.strptime(data["updated"], "%Y-%m-%d %H:%M UTC").replace(tzinfo=timezone.utc)
        return datetime.strptime(data["fetched_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _cargar_estado() -> dict:
    try:
        return json.loads(config.WATCHDOG_STATE_PATH.read_text())
    except Exception:
        return {}


def _guardar_estado(estado: dict) -> None:
    config.WATCHDOG_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.WATCHDOG_STATE_PATH.write_text(json.dumps(estado, ensure_ascii=False) + "\n")


def _post_slack(texto: str) -> bool:
    """POST {"text": ...} al webhook. Nunca propaga la URL en el error."""
    body = json.dumps({"text": texto}).encode("utf-8")
    req = urllib.request.Request(
        config.SLACK_WEBHOOK_URL, data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        print(f"[error] slack: HTTP {err.code}", file=sys.stderr)
        return False
    except Exception:
        print("[error] slack: error de red", file=sys.stderr)
        return False


def _fmt_min(minutos: float) -> str:
    return f"{minutos:.0f} min" if minutos < 120 else f"{minutos / 60:.1f} h"


def run(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    estado = _cargar_estado()
    cambios = False

    for clave, path, umbral_min, nombre, impacto in CHECKS:
        updated = _leer_updated(path)
        atraso_min = (now - updated).total_seconds() / 60 if updated else None
        fallando = atraso_min is None or atraso_min > umbral_min
        prev = estado.get(clave)

        if fallando and prev is None:
            # transición sano -> caído: notifica y arranca el conteo
            detalle = (f"hace {_fmt_min(atraso_min)}" if atraso_min is not None
                        else "el archivo no existe o no se pudo leer")
            texto = (
                f":red_circle: *Vigía* — {nombre} sin actualizar\n"
                f"Archivo: `{path.name}` — última actualización {detalle} (umbral: {umbral_min} min)\n"
                f"Implica: {impacto}\n"
                f"Revisa: `docker logs clima-ingesta` y el `ingesta.log`")
            if _post_slack(texto):
                estado[clave] = {"since": now.isoformat(), "last_notified": now.isoformat()}
                cambios = True
        elif fallando and prev is not None:
            last_notified = datetime.fromisoformat(prev["last_notified"])
            if now - last_notified >= timedelta(hours=RECORDATORIO_HORAS):
                since = datetime.fromisoformat(prev["since"])
                caido_desde = _fmt_min((now - since).total_seconds() / 60)
                texto = (
                    f":red_circle: *Vigía* (recordatorio) — {nombre} sigue sin actualizar\n"
                    f"Archivo: `{path.name}` — caído desde hace {caido_desde}\n"
                    f"Revisa: `docker logs clima-ingesta` y el `ingesta.log`")
                if _post_slack(texto):
                    prev["last_notified"] = now.isoformat()
                    cambios = True
        elif not fallando and prev is not None:
            texto = f":large_green_circle: *Vigía* — {nombre} se recuperó (`{path.name}`)"
            if _post_slack(texto):
                del estado[clave]
                cambios = True

    if cambios:
        _guardar_estado(estado)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true",
                     help="manda un único mensaje de prueba al webhook real y termina")
    args = ap.parse_args()

    if not config.SLACK_WEBHOOK_URL:
        return 0

    if args.test:
        return 0 if _post_slack("✅ Vigía watchdog operativo — mensaje de prueba") else 1

    return run()


if __name__ == "__main__":
    sys.exit(main())
