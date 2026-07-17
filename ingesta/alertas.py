"""Alertas naturales vigentes (SENAPRED, dashboard ArcGIS público).

Estado volátil, sin tabla propia: cada corrida reemplaza alertas.json por
completo. El payload crudo de cada servicio consultado sí se conserva en
raw_payloads (source 'senapred') para trazabilidad.

Servicios: {BASE}/{CATEGORIA}_{NIVEL}/FeatureServer/0/query, categorías
METEOROLOGICAS/FORESTALES/VOLCANICAS/BIOLOGICAS x niveles VERDE/AMARILLA/ROJA.
No todas las combinaciones existen (p.ej. hoy no hay VOLCANICAS_ROJA): un
400/404 en una combinación puntual no es un error, se salta.
"""
import json
import statistics
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import config

UA = "vigia-ingesta/1.0 (proyecto open source; vigia.cavara.cl)"
PAGE_SIZE = 2000

CATEGORIAS = {
    "METEOROLOGICAS": "meteorologica",
    "FORESTALES": "forestal",
    "VOLCANICAS": "volcanica",
    "BIOLOGICAS": "biologica",
}
NIVELES_SERVICIO = ["VERDE", "AMARILLA", "ROJA"]

# El servicio *_VERDE publica la "Alerta Temprana Preventiva".
NIVEL_FALLBACK = {"VERDE": "temprana_preventiva", "AMARILLA": "amarilla", "ROJA": "roja"}
NIVEL_PRIORIDAD = {"roja": 0, "amarilla": 1, "temprana_preventiva": 2}

# Umbral de antigüedad por nivel (verificado 2026-07-10: BIOLOGICAS_VERDE trae
# residuos con FECHA_INI desde 2023-05 que SENAPRED nunca depuró de su propio
# servicio — su dashboard tampoco los filtra). Roja y amarilla son urgentes y
# se depuran rápido; temprana_preventiva es informativa y dura más.
UMBRAL_DIAS_ANTIGUEDAD = {"roja": 60, "amarilla": 120, "temprana_preventiva": 365}


def _antigua(fecha_ini: str | None, nivel: str, hoy: datetime) -> bool:
    """True si FECHA_INI (DD-MM-AAAA) es más vieja que el umbral del nivel.
    Sin fecha parseable se conserva: mejor mostrar de más que botar una
    alerta real por un formato inesperado."""
    if not fecha_ini:
        return False
    try:
        fecha = datetime.strptime(fecha_ini, "%d-%m-%Y")
    except ValueError:
        return False
    return (hoy - fecha).days > UMBRAL_DIAS_ANTIGUEDAD[nivel]


def _normalizar_nivel(tipo_alert: str | None, nivel_servicio: str) -> str:
    """TIPO_ALERT es la fuente de verdad; el nivel del nombre del servicio
    es solo el respaldo si TIPO_ALERT viene vacío o con un texto no reconocido."""
    t = (tipo_alert or "").strip().lower()
    if "roja" in t:
        return "roja"
    if "amarilla" in t:
        return "amarilla"
    if "preventiva" in t or "temprana" in t:
        return "temprana_preventiva"
    return NIVEL_FALLBACK[nivel_servicio]


def _centroide(geometry: dict | None) -> tuple[float, float] | None:
    """Centroide simple (promedio de vértices) del primer ring de un
    esriGeometryPolygon en outSR=4326 (rings de [lon, lat])."""
    if not geometry:
        return None
    rings = geometry.get("rings")
    if not rings or not rings[0]:
        return None
    ring = rings[0]
    lat = sum(p[1] for p in ring) / len(ring)
    lon = sum(p[0] for p in ring) / len(ring)
    return lat, lon


def _fetch_pagina(categoria: str, nivel: str, offset: int) -> tuple[dict | None, str, str | None]:
    """Una página. Devuelve (data, url, error). data=None y error=None => la
    combinación no existe hoy (400/404, HTTP o vía error JSON de ArcGIS): no
    es un fallo."""
    url = f"{config.ALERTAS_ARCGIS_BASE}/{categoria}_{nivel}/FeatureServer/0/query"
    params = {
        "where": "1=1", "outFields": "*", "f": "json",
        "returnGeometry": "true", "outSR": "4326",
        "resultRecordCount": str(PAGE_SIZE), "resultOffset": str(offset),
    }
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(full_url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        if err.code in (400, 404):
            return None, full_url, None
        return None, full_url, f"{categoria}_{nivel}: HTTP {err.code}"
    except Exception as err:
        return None, full_url, f"{categoria}_{nivel}: {err}"
    if isinstance(data, dict) and "error" in data:
        code = data["error"].get("code")
        if code in (400, 404):
            return None, full_url, None
        return None, full_url, f"{categoria}_{nivel}: {data['error']}"
    return data, full_url, None


def _fetch_capa(categoria: str, nivel: str) -> tuple[dict | None, str, str | None]:
    """Pagina con resultOffset mientras exceededTransferLimit sea true (mismo
    patrón que emergencia.py/remociones.py: un solo resultRecordCount=2000
    truncaba en silencio las categorías con más features que eso, ej. las
    alertas amarillas con miles de comunas). Devuelve (data, url, error) con
    "features" ya agregadas de todas las páginas; data=None y error=None =>
    la combinación no existe hoy (400/404 en la primera página). Si una
    página posterior a la primera falla, se descartan las features ya
    traídas de ESA combinación (mezclar una página parcial subrepresentaría
    la alerta) y se reporta como error, igual que si hubiera fallado desde
    el inicio."""
    data, full_url, err = _fetch_pagina(categoria, nivel, 0)
    if data is None or err:
        return data, full_url, err
    features = list(data.get("features", []))
    offset = PAGE_SIZE
    while data.get("exceededTransferLimit"):
        data, full_url, err = _fetch_pagina(categoria, nivel, offset)
        if data is None or err:
            return None, full_url, err or f"{categoria}_{nivel}: paginación incompleta en offset {offset}"
        features.extend(data.get("features", []))
        offset += PAGE_SIZE
    return {"features": features}, full_url, None


def update(con, fetched_at: str) -> int:
    raw_por_servicio = {}
    features = []   # (categoria_label, nivel_servicio, feature)
    errores = []
    ok_alguna = False

    for categoria, categoria_label in CATEGORIAS.items():
        for nivel_servicio in NIVELES_SERVICIO:
            data, _url, err = _fetch_capa(categoria, nivel_servicio)
            if err:
                errores.append(err)
                continue
            if data is None:
                continue   # combinación inexistente hoy: no es error
            ok_alguna = True
            raw_por_servicio[f"{categoria}_{nivel_servicio}"] = data
            for feat in data.get("features", []):
                features.append((categoria_label, nivel_servicio, feat))

    if not ok_alguna and errores:
        raise RuntimeError(f"SENAPRED: todas las categorías fallaron: {'; '.join(errores)}")
    if errores:
        print(f"[aviso] alertas SENAPRED parcial: {'; '.join(errores)}")

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "senapred", config.ALERTAS_ARCGIS_BASE,
         json.dumps(raw_por_servicio, ensure_ascii=False)))
    con.commit()

    # Agregación: una alerta por (categoría, causalidad, nivel, región) — sin
    # esto, una alerta regional aparecería repetida como un polígono por comuna.
    hoy = datetime.now()
    descartadas_antiguas = 0
    grupos: dict = {}
    for categoria_label, nivel_servicio, feat in features:
        attrs = feat.get("attributes") or {}
        nivel = _normalizar_nivel(attrs.get("TIPO_ALERT"), nivel_servicio)
        if _antigua(attrs.get("FECHA_INI"), nivel, hoy):
            descartadas_antiguas += 1
            continue
        region = attrs.get("REGION")
        comuna = attrs.get("COMUNA")
        causalidad = attrs.get("CAUSALIDAD")
        centro = _centroide(feat.get("geometry"))
        key = (categoria_label, causalidad, nivel, region)
        g = grupos.setdefault(key, {"comunas": set(), "centros": [], "desde": None})
        if comuna:
            g["comunas"].add(comuna)
        if centro:
            g["centros"].append(centro)
        if attrs.get("FECHA_INI") and not g["desde"]:
            g["desde"] = attrs.get("FECHA_INI")

    alertas = []
    for (categoria_label, causalidad, nivel, region), g in grupos.items():
        comunas = sorted(g["comunas"])
        lat = lon = None
        if g["centros"]:
            # Mediana, no promedio: en alertas regionales las comunas insulares
            # (Rapa Nui, Juan Fernández, Antártica) son outliers de longitud y
            # el promedio deja el pin en medio del mar; la mediana cae en el
            # continente, donde está el grueso de las comunas alertadas.
            lat = round(statistics.median(c[0] for c in g["centros"]), 3)
            lon = round(statistics.median(c[1] for c in g["centros"]), 3)
        alertas.append({
            "nivel": nivel, "categoria": categoria_label, "evento": causalidad,
            "region": region, "comunas": comunas, "n_comunas": len(comunas),
            "desde": g["desde"], "lat": lat, "lon": lon,
        })
    alertas.sort(key=lambda a: (NIVEL_PRIORIDAD.get(a["nivel"], 9), a["categoria"], a["region"] or ""))

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SENAPRED (dashboard ArcGIS)",
        "alertas": alertas,
        "descartadas_antiguas": descartadas_antiguas,
    }
    # Alguna categoría/nivel falló (o quedó truncada a mitad de paginación):
    # lo que se publica es honesto (no hay fallback a datos viejos, cada
    # combinación exitosa es fresca), pero puede faltar alguna alerta real.
    if errores:
        payload["parcial"] = True
    config.ALERTAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.ALERTAS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(alertas)
