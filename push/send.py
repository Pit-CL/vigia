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

Además del Web Push, en el mismo ciclo se procesa un suscriptor Slack fijo
(la zona del operador, vía SLACK_WEBHOOK_URL/SLACK_ZONA_*) con su propio
criterio anti-spam y textos accionables — ver `_procesar_slack()`. Dormido
si SLACK_WEBHOOK_URL no está configurado (mismo patrón que
ingesta/watchdog.py, que usa el mismo webhook para otro fin).
"""
import argparse
import json
import math
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

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

# ── Suscriptor Slack (zona fija del operador) ───────────────────
# Todas con default vacío → funcionalidad dormida (mismo patrón que
# ingesta/watchdog.py y combustible.py).
SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
SLACK_ZONA_REGION = os.environ.get("SLACK_ZONA_REGION", "")


def _float_env(nombre: str):
    valor = os.environ.get(nombre, "")
    try:
        return float(valor) if valor else None
    except ValueError:
        return None


SLACK_ZONA_LAT = _float_env("SLACK_ZONA_LAT")
SLACK_ZONA_LON = _float_env("SLACK_ZONA_LON")

# Endpoint sintético estable: reusa la tabla `sent` (event_id, endpoint) para
# el dedup del suscriptor Slack, igual que cualquier sub de Web Push.
SLACK_ENDPOINT = "slack:zona"
SENAPRED_URL = "https://senapred.cl/alertas/"
FRASE_CIERRE = "— Vigía · esto NO reemplaza a los canales oficiales (SHOA/SENAPRED)."
MENSAJE_PRUEBA_ZONA = (
    "✅ Vigía: alertas de tu zona (Viña del Mar) activas en este canal — "
    "tsunami, sismos cercanos, alertas SENAPRED de Valparaíso y volcanes. "
    "Prueba de tubería, no es una emergencia.")

# Port a Python de EXPLICA_EVENTO/EXPLICA_NIVEL (web/app.js): mismo texto en
# lenguaje claro que usa el frontend, para que la alerta de Slack no invente
# un segundo tono. Si se edita uno, editar el otro (no hay build step común
# entre el JS del frontend y este contenedor Python).
EXPLICA_EVENTO = [
    (re.compile(r"zoosanitario", re.I),
     "Vigilancia del SAG por una enfermedad animal (por ejemplo influenza aviar) detectada en la zona. "
     "No es un riesgo directo para las personas: evita tocar aves o animales muertos o enfermos y "
     "repórtalos al SAG (2 2345 1100)."),
    (re.compile(r"alteraci[oó]n sanitaria", re.I),
     "Situación sanitaria bajo vigilancia de la autoridad (agua, plagas o brotes). Sigue las indicaciones "
     "de la SEREMI de Salud de tu región."),
    (re.compile(r"crecida", re.I),
     "Ríos o esteros de la zona vienen creciendo por lluvia o deshielo. No cruces cauces ni te acerques a "
     "las riberas; si vives cerca de un río, prepara una salida."),
    (re.compile(r"remoci[oó]n|aluvi[oó]n|deslizamiento", re.I),
     "Riesgo de deslizamientos de tierra o aluviones por lluvia en laderas. Aléjate de quebradas y cauces; "
     "si escuchas ruido de piedras o agua creciendo, sube a terreno firme y alto."),
    (re.compile(r"altas temperaturas|ola de calor", re.I),
     "Calor inusual para la zona. Hidrátate, evita el sol del mediodía y vigila a personas mayores, niños "
     "y mascotas. Sube el riesgo de incendios: evita cualquier fuego."),
    (re.compile(r"helada", re.I),
     "Temperaturas bajo cero esperadas. Protege cañerías, cultivos, mascotas y personas en situación de "
     "calle (llama al 800 104 777 — Código Azul)."),
    (re.compile(r"viento", re.I),
     "Viento fuerte esperado. Asegura techumbres, toldos y objetos sueltos; precaución al conducir "
     "vehículos altos y aléjate de árboles y tendido eléctrico."),
    (re.compile(r"volc[aá]n", re.I),
     "El volcán muestra actividad sobre lo normal y está bajo vigilancia reforzada de SERNAGEOMIN. "
     "Infórmate de tus vías de evacuación (capa 🏃 Evacuación del mapa) y respeta los perímetros."),
    (re.compile(r"incendio|forestal", re.I),
     "Condiciones favorables para incendios forestales o fuego activo en la zona. No enciendas fuego, "
     "reporta humo al 130 (CONAF) y prepárate para evacuar temprano si estás cerca."),
    (re.compile(r"meteorol[oó]gico", re.I),
     "Sistema frontal u otro evento del tiempo significativo para la zona (lluvia, viento o nieve). Revisa "
     "el pronóstico de tu comuna y evita desplazamientos innecesarios en lo peor del evento."),
]
EXPLICA_EVENTO_DEFAULT = "Alerta oficial de SENAPRED para la zona. Revisa senapred.cl para el detalle del evento."
EXPLICA_NIVEL = {
    "amarilla": "la amenaza crece y los equipos de emergencia se alistan; ten a mano lo esencial y revisa tus rutas.",
    "roja": "la amenaza está en desarrollo y puede requerir evacuación u otra acción inmediata; sigue YA las instrucciones oficiales.",
}


def _explica_evento(evento: str) -> str:
    evento = evento or ""
    for patron, texto in EXPLICA_EVENTO:
        if patron.search(evento):
            return texto
    return EXPLICA_EVENTO_DEFAULT


def _dist_km(lat1, lon1, lat2, lon2) -> float:
    """Distancia entre dos puntos (haversine, radio terrestre 6371 km).
    Misma fórmula que ingesta/sismos.py:_dist_km."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _post_slack(texto: str) -> bool:
    """POST {"text": ...} al webhook de Slack. Nunca propaga la URL en el
    error (urllib la incluye en sus excepciones) — mismo patrón que
    ingesta/watchdog.py._post_slack, duplicado aquí porque push/ e ingesta/
    son contenedores separados sin módulo compartido."""
    body = json.dumps({"text": texto}).encode("utf-8")
    req = urllib.request.Request(
        SLACK_WEBHOOK_URL, data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        print(f"[slack] error: HTTP {err.code}")
        return False
    except Exception:
        print("[slack] error: error de red")
        return False


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
        ref = ev.get("ref") or "Chile"
        titulo = f"🌊 Sismo M{mag:.1f} — {ref}"
        eventos.append({
            "id": f"sismo:{ev['id']}", "titulo": titulo, "body": ACCION, "url": SITE_URL,
            "tipo": "sismo", "mag": mag, "lat": lat, "lon": lon, "nacional": nacional,
            "ref": ref, "utc_time": t,
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


def _eventos_tsunami_slack(con: sqlite3.Connection) -> list[dict]:
    """Tsunami amenaza y precaución (a diferencia del push, que solo manda
    amenaza). El id de precaución no tiene un boletín estable como amenaza
    (puede depender solo del cruce sísmico interno de tsunami.py), así que
    se rastrea la transición de estado en `slack_estado`: mientras el
    estado no cambie, el id es estable (dedup real); al salir del estado
    (o cambiar a otro), se genera un id nuevo — igual que watchdog.py hace
    con su propio archivo de estado, pero aquí vive en push.db."""
    data = _load_json(TSUNAMI_PATH)
    estado = data.get("estado")
    if estado not in ("amenaza", "precaucion"):
        con.execute("DELETE FROM slack_estado WHERE clave = 'tsunami'")
        con.commit()
        return []

    row = con.execute("SELECT valor, since FROM slack_estado WHERE clave = 'tsunami'").fetchone()
    if row and row[0] == estado:
        since = row[1]
    else:
        since = datetime.now(timezone.utc).isoformat()
        con.execute(
            "INSERT INTO slack_estado(clave, valor, since) VALUES ('tsunami', ?, ?) "
            "ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, since = excluded.since",
            (estado, since))
        con.commit()

    if estado == "amenaza":
        mensaje = data.get("mensaje") or "Amenaza de tsunami vigente para Chile"
        texto = (
            f"🌊 *AMENAZA DE TSUNAMI* — {mensaje}. EVACÚA la costa AHORA, a pie (nunca en auto): sube a 30 "
            "metros sobre el nivel del mar o aléjate 2 km del mar. No esperes sirenas ni confirmación. "
            "Autoridad oficial: SHOA/SENAPRED. Radio local: Bío-Bío 94.5 FM (Gran Valparaíso — dato "
            "verificado 2026; Cooperativa YA NO transmite en el dial de Valparaíso). Vías de evacuación: "
            "https://vigia.cavara.cl (capa Evacuación).")
    else:
        texto = (
            "🌊 *Precaución de tsunami* — sismo mayor costero reciente. Aléjate de la playa y mantente "
            "atento; si el sismo te impidió mantenerte en pie o duró más de 1 minuto, evacúa sin esperar "
            "confirmación.")
    return [{"id": f"tsunami:{estado}:{since}", "texto": f"{texto}\n{FRASE_CIERRE}"}]


def _eventos_sismos_slack(sismos_base: list[dict]) -> list[dict]:
    """Mismo criterio que el push de zona (M≥5.5 en el radio de zona) más
    los nacionales — reusa la lista y el flag `nacional` ya calculados por
    `_eventos_sismos()` (que ya incorpora el criterio PAGER, no solo
    M≥6.5, para no duplicar esa lógica con una regla más angosta)."""
    con_ubicacion = SLACK_ZONA_LAT is not None and SLACK_ZONA_LON is not None
    sub = {"lat": SLACK_ZONA_LAT, "lon": SLACK_ZONA_LON, "radio_km": None, "mag_min": None}
    tz = ZoneInfo("America/Santiago")
    eventos = []
    for ev in sismos_base:
        if not _cumple(ev, sub):
            continue
        hora = ev["utc_time"].astimezone(tz).strftime("%H:%M")
        cerca = con_ubicacion and _dist_km(SLACK_ZONA_LAT, SLACK_ZONA_LON, ev["lat"], ev["lon"]) <= RADIO_KM_ZONA
        base = f"🌎 *Sismo M{ev['mag']:.1f}* — {ev['ref']}, {hora} hora local."
        if cerca:
            texto = (f"{base} Si el sismo te impidió mantenerte en pie o duró más de un minuto, aléjate de "
                      "la playa y evacúa sin esperar confirmación oficial.")
        else:
            texto = f"{base} Sismo de registro nacional; no requiere acción en tu zona."
        eventos.append({"id": ev["id"], "texto": f"{texto}\n{FRASE_CIERRE}"})
    return eventos


def _eventos_alertas_slack() -> list[dict]:
    """Rojas de cualquier región + rojas y amarillas de SLACK_ZONA_REGION.
    Nunca temprana_preventiva (spam) — a diferencia de `_eventos_alertas()`,
    que solo manda rojas, aquí se necesita también la amarilla local."""
    eventos = []
    for al in _load_json(ALERTAS_PATH).get("alertas", []):
        nivel = al.get("nivel")
        if nivel not in ("roja", "amarilla"):
            continue
        region = al.get("region") or "Chile"
        if nivel == "amarilla" and region != SLACK_ZONA_REGION:
            continue
        categoria = al.get("categoria", "")
        evento = al.get("evento") or categoria
        desde = al.get("desde") or ""
        comunas = al.get("comunas") or []
        resumen_comunas = ", ".join(comunas[:3]) + (f" y {len(comunas) - 3} más" if len(comunas) > 3 else "")
        emoji = "🔴" if nivel == "roja" else "🟡"
        lugar = f"{region} ({resumen_comunas})" if resumen_comunas else region
        texto = (
            f"{emoji} *Alerta {nivel.capitalize()} SENAPRED* — {evento} en {lugar}.\n"
            f"{EXPLICA_NIVEL.get(nivel, '')}\n{_explica_evento(evento)}\n"
            f"Detalle oficial: {SENAPRED_URL}")
        eventos.append({"id": f"alerta:{categoria}:{region}:{desde}", "texto": f"{texto}\n{FRASE_CIERRE}"})
    return eventos


def _eventos_volcanes_slack() -> list[dict]:
    eventos = []
    for ev in _eventos_volcanes():
        nombre = ev["id"].split(":")[1]
        nivel = ev["id"].split(":")[2]
        texto = (
            f"🌋 *Volcán {nombre}* en alerta {nivel}. Si estás en zona de peligro del volcán, revisa la "
            "capa Volcanes y los puntos de encuentro en Vigía.")
        eventos.append({"id": ev["id"], "texto": f"{texto}\n{FRASE_CIERRE}"})
    return eventos


def _eventos_slack(con: sqlite3.Connection, sismos_base: list[dict]) -> list[dict]:
    return (
        _eventos_tsunami_slack(con)
        + _eventos_sismos_slack(sismos_base)
        + _eventos_alertas_slack()
        + _eventos_volcanes_slack()
    )


def _procesar_slack(con: sqlite3.Connection, sismos_base: list[dict], ya_enviados: set[tuple[str, str]]) -> None:
    """Suscriptor Slack de la zona fija del operador: independiente de si
    hay suscripciones Web Push (no depende de la tabla `subs`)."""
    if not SLACK_WEBHOOK_URL:
        return
    for ev in _eventos_slack(con, sismos_base):
        if (ev["id"], SLACK_ENDPOINT) in ya_enviados:
            continue
        if _post_slack(ev["texto"]):
            con.execute(
                "INSERT OR IGNORE INTO sent(event_id, endpoint, sent_at) VALUES (?, ?, datetime('now'))",
                (ev["id"], SLACK_ENDPOINT))
            con.commit()
            ya_enviados.add((ev["id"], SLACK_ENDPOINT))


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
    # Estado de transición para el suscriptor Slack (ver _eventos_tsunami_slack):
    # solo lo usa "tsunami" hoy, pero se deja genérico por clave.
    con.execute(
        "CREATE TABLE IF NOT EXISTS slack_estado("
        "clave TEXT PRIMARY KEY, valor TEXT, since TEXT)"
    )
    con.commit()


def _enviar_evento(con: sqlite3.Connection, subs: list[tuple[str, str, str]], titulo: str, body: str, url: str) -> set[str]:
    """Envía a la lista de suscripciones ya filtrada para este evento.
    Devuelve los endpoints que resultaron caducados (404/410) para que el
    caller los descarte."""
    payload = json.dumps({"title": titulo, "body": body, "url": url})
    vapid_private_key = os.environ["VAPID_PRIVATE_KEY"]
    # docker-compose.yml define VAPID_CONTACT: ${VAPID_CONTACT:-}, así que si no
    # se configuró en el .env de prod la var llega como string vacío (presente,
    # no ausente) y os.environ.get(k, default) NO cae al default en ese caso —
    # solo lo hace si la key falta. Con "or" se cubre además ausencia real.
    contacto = os.environ.get("VAPID_CONTACT") or "rafaelfariaspoblete@gmail.com"
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
    sismos_base = _eventos_sismos()
    eventos = sismos_base + _eventos_alertas() + _eventos_volcanes() + _eventos_tsunami()
    eventos.append(_evento_kit(ahora))

    con = sqlite3.connect(DB_PATH)
    _ensure_schema(con)

    ya_enviados = {(r[0], r[1]) for r in con.execute("SELECT event_id, endpoint FROM sent").fetchall()}

    # El suscriptor Slack no depende de que existan subs de Web Push.
    _procesar_slack(con, sismos_base, ya_enviados)

    subs = con.execute(
        "SELECT endpoint, p256dh, auth, lat, lon, radio_km, mag_min, kit_reminder FROM subs"
    ).fetchall()
    if not subs:
        con.close()
        return

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


def _cli() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-zona", action="store_true",
                     help="manda un único mensaje de prueba al webhook real y termina (no toca `sent`)")
    args = ap.parse_args()

    if args.test_zona:
        if not SLACK_WEBHOOK_URL:
            print("[slack] SLACK_WEBHOOK_URL no configurado, nada que probar")
            return 1
        return 0 if _post_slack(MENSAJE_PRUEBA_ZONA) else 1

    main()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
