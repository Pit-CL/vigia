"""Resumen diario de tráfico del sitio a Slack, vía la API GraphQL de
Cloudflare (el tráfico ya pasa por el Cloudflare Tunnel de este VPS).

Patrón "dormido" (igual que watchdog.py y combustible.py): sin
CF_ANALYTICS_TOKEN, CF_ZONE_ID o SLACK_WEBHOOK_URL, exit 0 silencioso — no
es un error, es que el operador no configuró el resumen.

No es un paso de la ingesta (no toca la BD ni los JSON del frontend): se
invoca directo desde cron, igual que watchdog.py.

Dataset elegido: httpRequests1dGroups (plan free lo permite; verificado a
mano contra la API real desde este VPS el 2026-07-15). Agrupa por día
calendario UTC, no por America/Santiago — el desfase de hasta 4 h se acepta
como aproximación para un resumen informal (no es un dato de calibración
científica; ver docs/CALIBRACION.md para lo que sí exige exactitud horaria).

Nunca debe filtrar el token: urllib incluye la URL completa en sus
excepciones y el token va en el header Authorization, así que el manejo de
errores solo reporta "HTTP <código>" o "error de red", jamás el error crudo.
"""
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import config

API_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"
CL_TZ = ZoneInfo("America/Santiago")

QUERY = """
query ($zoneTag: String!, $since: Date!, $until: Date!) {
  viewer {
    zones(filter: {zoneTag: $zoneTag}) {
      httpRequests1dGroups(limit: 1, filter: {date_geq: $since, date_leq: $until}) {
        sum {
          requests
          pageViews
          cachedRequests
          threats
          countryMap { clientCountryName requests }
        }
        uniq { uniques }
      }
    }
  }
}
"""


def _consultar_cloudflare(fecha: str) -> dict | None:
    """POST a la API GraphQL de Cloudflare. Nunca propaga el token en el
    error (viaja solo por header, nunca en la URL)."""
    body = json.dumps({
        "query": QUERY,
        "variables": {"zoneTag": config.CF_ZONE_ID, "since": fecha, "until": fecha},
    }).encode("utf-8")
    req = urllib.request.Request(
        API_GRAPHQL, data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.CF_ANALYTICS_TOKEN}",
        })
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        print(f"[error] cloudflare: HTTP {err.code}", file=sys.stderr)
        return None
    except Exception:
        print("[error] cloudflare: error de red", file=sys.stderr)
        return None

    if data.get("errors"):
        print(f"[error] cloudflare: {data['errors']}", file=sys.stderr)
        return None

    try:
        grupos = data["data"]["viewer"]["zones"][0]["httpRequests1dGroups"]
    except (KeyError, IndexError, TypeError):
        return None
    return grupos[0] if grupos else None


def _miles(n: int) -> str:
    """Separador de miles chileno (punto)."""
    return f"{n:,}".replace(",", ".")


def _armar_mensaje(fecha_legible: str, grupo: dict) -> str:
    suma = grupo["sum"]
    requests = suma["requests"]
    page_views = suma["pageViews"]
    cached = suma["cachedRequests"]
    threats = suma["threats"]
    uniques = grupo["uniq"]["uniques"]
    cache_pct = round(100 * cached / requests) if requests else 0

    paises = sorted(suma.get("countryMap", []), key=lambda p: -p["requests"])[:3]
    top = ", ".join(
        f"{p['clientCountryName']} {round(100 * p['requests'] / requests)}%"
        for p in paises if requests
    ) or "sin datos"

    amenaza = "amenaza bloqueada" if threats == 1 else "amenazas bloqueadas"

    return (
        f"📊 *Vigía* — tráfico {fecha_legible}: "
        f"{_miles(uniques)} visitas únicas · {_miles(page_views)} páginas vistas · "
        f"{_miles(requests)} requests ({cache_pct}% cache) · "
        f"top: {top} · {_miles(threats)} {amenaza}"
    )


def _post_slack(texto: str) -> bool:
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


def main() -> int:
    if not (config.CF_ANALYTICS_TOKEN and config.CF_ZONE_ID and config.SLACK_WEBHOOK_URL):
        print("[analytics_diario] falta CF_ANALYTICS_TOKEN, CF_ZONE_ID o SLACK_WEBHOOK_URL, nada que hacer")
        return 0

    ayer = datetime.now(CL_TZ).date() - timedelta(days=1)
    grupo = _consultar_cloudflare(ayer.isoformat())
    if grupo is None:
        print("[analytics_diario] sin datos de Cloudflare para ayer", file=sys.stderr)
        return 1

    fecha_legible = ayer.strftime("%d-%m")
    texto = _armar_mensaje(fecha_legible, grupo)
    if not _post_slack(texto):
        return 1

    print(f"[analytics_diario] enviado: {texto}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
