"""Precios de combustible en línea — CNE (Comisión Nacional de Energía),
datastream Junar v2 "BENCI-EN-LINEA".

Capa dormida sin token (mismo patrón que incendios.py/FIRMS): CNE_API_KEY
se registra gratis en api.cne.cl; sin ella el módulo no hace nada. A
diferencia de SEC/MINSAL, la API de la CNE es accesible directo desde el
VPS — no requiere el satélite en omen.

TODO: verificar formato real de la respuesta con el token real. La URL
histórica documentada del datastream es la de config.CNE_API_URL (Junar
v2, "BENCI-EN-LINEA-V2-80280"); nadie la ha probado todavía con una key
válida. El parser de abajo es DEFENSIVO — si la estructura real difiere de
lo esperado, reporta un [aviso] y no rompe la ingesta. El payload crudo
queda en raw_payloads para depurar apenas llegue el token.
"""
import json
from datetime import datetime, timezone

import config
import sources

# Nombres candidatos por campo: no sabemos cómo vienen realmente hasta tener
# el token, así que se prueban varias variantes plausibles (snake_case,
# concatenado, con/sin acento) — mismo criterio defensivo que _campo() en
# cortes.py/farmacias.py.
_CAMPOS_PRECIO = {
    "gasolina_93": ("precio_93", "gasolina93", "gasolina_93", "93"),
    "gasolina_95": ("precio_95", "gasolina95", "gasolina_95", "95"),
    "gasolina_97": ("precio_97", "gasolina97", "gasolina_97", "97"),
    "diesel": ("precio_diesel", "diesel", "petroleo_diesel"),
    "glp": ("precio_glp", "glp"),
}


def _campo(row: dict, *nombres):
    lower = {str(k).lower(): v for k, v in row.items()}
    for n in nombres:
        v = lower.get(n.lower())
        if v not in (None, ""):
            return v
    return None


def _num(raw):
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _mapear_estacion(row) -> dict | None:
    """Una fila cruda -> {nombre?, marca?, comuna?, lat, lon, precios{}}.
    Sin lat/lon utilizable la fila se descarta (no se puede pintar en el mapa)."""
    if not isinstance(row, dict):
        return None
    lat = _num(_campo(row, "latitud", "lat"))
    lon = _num(_campo(row, "longitud", "lon", "lng"))
    if lat is None or lon is None:
        return None
    item = {"lat": lat, "lon": lon}
    nombre = _campo(row, "nombre", "razon_social")
    if nombre:
        item["nombre"] = str(nombre)
    marca = _campo(row, "marca", "distribuidor")
    if marca:
        item["marca"] = str(marca)
    comuna = _campo(row, "comuna")
    if comuna:
        item["comuna"] = str(comuna)
    precios = {}
    for campo_out, candidatos in _CAMPOS_PRECIO.items():
        v = _num(_campo(row, *candidatos))
        if v is not None:
            precios[campo_out] = v
    if precios:
        item["precios"] = precios
    return item


def _parsear(data) -> tuple[list, str | None]:
    """Devuelve (estaciones, aviso). Estructura Junar v2 esperada: un dict
    con la lista de filas bajo 'result' (o alguna variante habitual: 'data',
    'items', 'rows') o directamente una lista. Sin token real no hay forma
    de confirmar cuál es — ante cualquier estructura no reconocida, aviso y
    lista vacía en vez de reventar la ingesta completa."""
    filas = None
    if isinstance(data, dict):
        for clave in ("result", "data", "items", "rows"):
            if isinstance(data.get(clave), list):
                filas = data[clave]
                break
    elif isinstance(data, list):
        filas = data
    if filas is None:
        claves = list(data.keys()) if isinstance(data, dict) else type(data).__name__
        return [], f"estructura inesperada en la respuesta CNE (claves/tipo: {claves})"
    estaciones = [e for e in (_mapear_estacion(f) for f in filas) if e]
    if filas and not estaciones:
        return [], "la respuesta CNE trajo filas pero ninguna con lat/lon utilizable"
    return estaciones, None


def update(con, fetched_at: str) -> int:
    if not config.CNE_API_KEY:
        return 0

    data, url = sources.http_get_json(config.CNE_API_URL, {"auth_key": config.CNE_API_KEY})
    # La auth_key va en la URL: jamás persistirla, ni en raw_payloads.
    masked_url = url.replace(config.CNE_API_KEY, "***")
    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "combustible", masked_url, json.dumps(data, ensure_ascii=False)))
    con.commit()

    estaciones, aviso = _parsear(data)
    if aviso:
        print(f"[aviso] combustible CNE: {aviso}")

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "CNE Bencina en Línea",
        "n": len(estaciones),
        "estaciones": estaciones,
    }
    config.COMBUSTIBLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.COMBUSTIBLE_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(estaciones)
