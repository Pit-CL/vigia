"""Precios de combustible en línea — CNE (Comisión Nacional de Energía), API v4
(api.cne.cl) con login dinámico.

Capa dormida sin credenciales (mismo patrón que FIRMS/DMC): CNE_EMAIL/
CNE_PASSWORD se registran gratis en api.cne.cl; sin ambas el módulo no hace
nada. Flujo verificado: POST a CNE_LOGIN_URL (form-urlencoded email+password)
-> token efímero -> GET a CNE_ESTACIONES_URL con Authorization: Bearer
<token>. El login se repite en cada corrida (el token es dinámico, la ingesta
corre 2x/día). Accesible directo desde el VPS — no requiere el satélite en
omen.

Seguridad: el email/password/token nunca se loguean ni viajan en un mensaje
de excepción; si el login falla solo se reporta el status HTTP (el cuerpo de
la respuesta podría ecoar las credenciales enviadas). El GET de estaciones no
persiste las ~1.800 filas crudas en raw_payloads (pesan varios MB): guarda un
resumen (conteo de estaciones por región).
"""
import gzip
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import config
from sources import UA

# Precios en $/L (93/95/97/diésel) y $/m3 (GLP): la API entrega el número ya
# en pesos ("1480.000" = 1.480 CLP, el ".000" son decimales siempre nulos,
# NO un separador de miles — verificado contra la muestra real: 93 ronda
# 1.480, diésel 1.246, GLP 586 y GNC 399, todos coherentes con precios de
# mercado publicados; una lectura "miles" (1.480.000) sería absurda para
# bencina por litro). Claves reales presentes en la muestra: 93, 95, 97, DI
# (diésel), GLP, KE (kerosene), GNC y las variantes A93/A95/A97/ADI/AKE de
# autoservicio — el frontend (paintCombustible en app.js) solo pinta las 5
# de mayor demanda, así que solo esas se mapean.
_PRECIO_CAMPOS = {
    "gasolina_93": "93",
    "gasolina_95": "95",
    "gasolina_97": "97",
    "diesel": "DI",
    "glp": "GLP",
}


def _login() -> str | None:
    """POST email+password -> token. None si falla; el aviso reporta SOLO el
    status HTTP o la clase del error, nunca el cuerpo de la respuesta (podría
    ecoar las credenciales enviadas)."""
    body = urllib.parse.urlencode({
        "email": config.CNE_EMAIL, "password": config.CNE_PASSWORD,
    }).encode()
    req = urllib.request.Request(
        config.CNE_LOGIN_URL, data=body, method="POST",
        headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        print(f"[aviso] combustible CNE: login falló (HTTP {err.code})")
        return None
    except Exception as err:
        print(f"[aviso] combustible CNE: login falló ({type(err).__name__})")
        return None
    token = data.get("token") if isinstance(data, dict) else None
    return token if isinstance(token, str) and token else None


def _get_estaciones(token: str) -> list | None:
    req = urllib.request.Request(
        config.CNE_ESTACIONES_URL, method="GET",
        headers={
            "User-Agent": UA,
            "Authorization": f"Bearer {token}",
            "Accept-Encoding": "identity",
        })
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            raw = res.read()
            if res.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            data = json.loads(raw.decode("utf-8"))
    except Exception as err:
        print(f"[aviso] combustible CNE: GET estaciones falló ({type(err).__name__})")
        return None
    return data if isinstance(data, list) else None


def _num_precio(raw):
    try:
        return round(float(raw))
    except (TypeError, ValueError):
        return None


def _mapear_estacion(row) -> dict | None:
    """Una fila cruda de /api/v4/estaciones -> {lat, lon, nombre?, marca?,
    comuna?, precios{}}. Se descartan estaciones en mantención o sin
    lat/lon utilizable (no se pueden pintar en el mapa)."""
    if not isinstance(row, dict) or row.get("en_mantenimiento") == 1:
        return None
    ubicacion = row.get("ubicacion") or {}
    try:
        lat = float(ubicacion.get("latitud"))
        lon = float(ubicacion.get("longitud"))
    except (TypeError, ValueError):
        return None
    item = {"lat": lat, "lon": lon}
    nombre = row.get("razon_social")
    if nombre:
        item["nombre"] = str(nombre)
    marca = (row.get("distribuidor") or {}).get("marca")
    if marca:
        item["marca"] = str(marca)
    comuna = ubicacion.get("nombre_comuna")
    if comuna:
        item["comuna"] = str(comuna)
    # Cada combustible trae su propia fecha_actualizacion ("YYYY-MM-DD"): en
    # una misma estación el 93 puede venir de hoy y el diésel de hace meses
    # (verificado contra la API real), así que la fecha va por precio, no
    # una sola por estación. El frontend (paintCombustible) usa esa fecha
    # para mostrarla en el popup y marcar como "antiguo" lo desactualizado.
    precios_raw = row.get("precios") or {}
    precios = {}
    for campo_out, clave_cne in _PRECIO_CAMPOS.items():
        entry = precios_raw.get(clave_cne)
        if isinstance(entry, dict):
            v = _num_precio(entry.get("precio"))
            if v is not None:
                dato = {"precio": v}
                fecha = entry.get("fecha_actualizacion")
                if isinstance(fecha, str) and fecha:
                    dato["fecha"] = fecha
                precios[campo_out] = dato
    if precios:
        item["precios"] = precios
    return item


def update(con, fetched_at: str) -> int:
    if not (config.CNE_EMAIL and config.CNE_PASSWORD):
        return 0

    token = _login()
    if not token:
        return 0

    data = _get_estaciones(token)
    if data is None:
        return 0

    # Resumen liviano en vez de las ~1.800 filas crudas (pesan varios MB):
    # conteo de estaciones por región, suficiente para depurar sin ensuciar
    # raw_payloads.
    por_region = {}
    for row in data:
        region = ((row.get("ubicacion") or {}).get("nombre_region")) or "?"
        por_region[region] = por_region.get(region, 0) + 1
    resumen = {"n_estaciones": len(data), "por_region": por_region}
    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "combustible", config.CNE_ESTACIONES_URL, json.dumps(resumen, ensure_ascii=False)))
    con.commit()

    estaciones = [e for e in (_mapear_estacion(row) for row in data) if e]

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "CNE Bencina en Línea",
        "n": len(estaciones),
        "estaciones": estaciones,
    }
    config.COMBUSTIBLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.COMBUSTIBLE_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(estaciones)
