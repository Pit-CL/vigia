"""Infraestructura de emergencia comunitaria (SENAPRED, visor "Chile Preparado").

Datos cuasi-estáticos (postas y hospitales, cuarteles de bomberos, comisarías,
puntos de encuentro ante tsunami y volcán): sin tabla propia, cada corrida
reemplaza emergencia.json por completo. Solo se archiva un resumen de
conteos en raw_payloads (source 'emergencia'): los payloads completos son
~9.000 features y no aportan trazabilidad proporcional a su peso.

Servicios: {BASE}/Servicios_2024/FeatureServer/{0,1,3} (salud, bomberos,
carabineros) + {BASE}/Amenaza_por_Tsunami_2024/FeatureServer/{0,1,3} (puntos
de encuentro, vías de evacuación y área a evacuar) + {BASE}/AMENAZA_VOLCÁNICA_2024
(Á URL-encoded %C3%81 porque el nombre del servicio la trae literal)
/FeatureServer/{0,1} (puntos de encuentro y vías de evacuación volcánica).
Paginado con resultRecordCount=2000 + resultOffset hasta que
exceededTransferLimit sea falso.

Vías de evacuación (esriGeometryPolyline, ~2.940 features entre tsunami y
volcán): se publican aparte en tsunami_vias.json, no en emergencia.json,
porque el mapa solo las pinta con el zoom acercado — mezclarlas con los
puntos obligaría a cargar y filtrar miles de líneas en cada refresco de la
capa. Cada vía lleva "t": "tsunami"|"volcan" (mismo archivo para no romper
la URL ya desplegada, solo se le agregó el campo).

Área a evacuar (FeatureServer/3, esriGeometryPolygon, 350 features): se
publica aparte en tsunami_areas.json por el mismo motivo que las vías. Solo
se usa el ring exterior de cada polígono, con decimación fuerte de vértices
(ver AREAS_MIN_DIST_DEG): son polígonos de relleno visual, no líneas de
navegación que exijan precisión.

Nota de campos (verificado contra el servicio real, no contra el metadata
"aparente"): en SALUD el campo obvio para el nombre del establecimiento
(nombre_ofi) viene vacío en el 100% de los 5.181 registros, así que se usa
simbologia (categoría del recinto, siempre poblado) como nombre.
"""
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import config

UA = "vigia-ingesta/1.0 (proyecto open source; vigia.cavara.cl)"
PAGE_SIZE = 2000

# categoría -> (path del FeatureServer, campo OID real, campos a pedir).
CAPAS = {
    "salud": ("Servicios_2024/FeatureServer/0", "objectid",
              ["simbologia", "tipo_de_ur", "comuna"]),
    "bomberos": ("Servicios_2024/FeatureServer/1", "objectid_1",
                 ["nombre", "nombre_del", "tipo", "comuna"]),
    "carabineros": ("Servicios_2024/FeatureServer/3", "objectid",
                    ["nombre_uni", "tipo_de_un", "comuna"]),
    "encuentro_tsunami": ("Amenaza_por_Tsunami_2024/FeatureServer/0", "OBJECTID",
                          ["nombre_pe", "sector", "nom_com"]),
    # %C3%81 = "Á" URL-encoded: el nombre real del servicio en ArcGIS es
    # "AMENAZA_VOLCÁNICA_2024" (verificado con ?f=json contra /arcgis/rest/services).
    "encuentro_volcan": ("AMENAZA_VOLC%C3%81NICA_2024/FeatureServer/0", "objectid",
                         ["nombre", "tipo", "volcan"]),
}

# Vías de evacuación (esriGeometryPolyline, no punto) — no calzan en
# CAPAS/ITEM_BUILDERS, que asumen geometría {x,y}. Se publican en un JSON
# propio (tsunami_vias.json) para no engordar emergencia.json con miles de
# líneas que el mapa solo pinta acercado (zoom ≥ 11).
VIAS_LAYER_TSUNAMI = "Amenaza_por_Tsunami_2024/FeatureServer/1"
VIAS_OID_TSUNAMI = "OBJECTID"
VIAS_CAMPO_TSUNAMI = "nom_com"  # nom_reg/sector verificados en el servicio pero sin uso: el popup solo muestra comuna

VIAS_LAYER_VOLCAN = "AMENAZA_VOLC%C3%81NICA_2024/FeatureServer/1"
VIAS_OID_VOLCAN = "objectid"
VIAS_CAMPO_VOLCAN = "volcan"

VIAS_MIN_DIST_DEG = 0.00025  # ~25 m: umbral de decimación de vértices

# Área a evacuar (esriGeometryPolygon): mismo motivo que las vías, JSON propio.
AREAS_LAYER = "Amenaza_por_Tsunami_2024/FeatureServer/3"
AREAS_OID = "OBJECTID"
AREAS_CAMPOS = ["comuna", "sector"]
# ~80 m (0.0005° = ~50 m dio 2,1 MB con las 350 áreas; medido y descartado).
AREAS_MIN_DIST_DEG = 0.0008


def _fetch_pagina(path: str, oid: str, campos: list, offset: int) -> dict:
    params = {
        "where": "1=1", "outFields": ",".join(campos), "f": "json",
        "returnGeometry": "true", "outSR": "4326",
        "resultRecordCount": str(PAGE_SIZE), "resultOffset": str(offset),
        "orderByFields": oid,
    }
    url = f"{config.EMERGENCIA_ARCGIS_BASE}/{path}/query?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def _fetch_capa(path: str, oid: str, campos: list) -> list:
    """Pagina hasta agotar la capa. Devuelve la lista cruda de features."""
    features = []
    offset = 0
    while True:
        data = _fetch_pagina(path, oid, campos, offset)
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(str(data["error"]))
        features.extend(data.get("features", []))
        if not data.get("exceededTransferLimit"):
            break
        offset += PAGE_SIZE
    return features


def _texto(attrs: dict, campo: str) -> str:
    v = attrs.get(campo)
    if v is None:
        return ""
    return str(v).strip()


def _item_salud(attrs: dict) -> tuple:
    n = _texto(attrs, "simbologia") or "Establecimiento de salud"
    d = " · ".join(p for p in (_texto(attrs, "tipo_de_ur"), _texto(attrs, "comuna")) if p)
    return n, d


def _item_bomberos(attrs: dict) -> tuple:
    n = _texto(attrs, "nombre") or _texto(attrs, "nombre_del") or "Bomberos"
    d = " · ".join(p for p in (_texto(attrs, "tipo"), _texto(attrs, "comuna")) if p)
    return n, d


def _item_carabineros(attrs: dict) -> tuple:
    n = _texto(attrs, "nombre_uni") or "Carabineros"
    d = _texto(attrs, "tipo_de_un")
    return n, d


def _item_tsunami(attrs: dict) -> tuple:
    # nombre_pe viene en blanco en ~88% de los puntos: se cae a sector.
    n = _texto(attrs, "nombre_pe") or _texto(attrs, "sector") or "Punto de encuentro"
    d = _texto(attrs, "nom_com")
    return n, d


def _item_volcan(attrs: dict) -> tuple:
    n = _texto(attrs, "nombre") or "Punto de encuentro"
    d = _texto(attrs, "volcan")  # no hay campo comuna en esta capa; volcán da el contexto
    return n, d


ITEM_BUILDERS = {
    "salud": _item_salud,
    "bomberos": _item_bomberos,
    "carabineros": _item_carabineros,
    "encuentro_tsunami": _item_tsunami,
    "encuentro_volcan": _item_volcan,
}


def _decimar(puntos: list, min_dist: float = VIAS_MIN_DIST_DEG) -> list:
    """Reduce vértices de un path: conserva uno cada vez que se aleja al
    menos min_dist (en grados) del último conservado. Primer y último punto
    del path siempre se conservan, aunque el path completo sea muy corto."""
    if len(puntos) <= 2:
        return puntos
    out = [puntos[0]]
    for lat, lon in puntos[1:-1]:
        ult_lat, ult_lon = out[-1]
        if ((lat - ult_lat) ** 2 + (lon - ult_lon) ** 2) ** 0.5 >= min_dist:
            out.append((lat, lon))
    out.append(puntos[-1])
    return out


def _procesar_vias(features: list, tipo: str, campo_etiqueta: str) -> list:
    """Cada feature (esriGeometryPolyline) trae "paths": [[[lon,lat],...], ...];
    una feature puede traer varios paths → una entrada "p" por path. "t"
    distingue tsunami/volcán: mismo archivo, el mapa las pinta con color e
    ícono distinto."""
    vias = []
    for feat in features:
        etiqueta = _texto(feat.get("attributes") or {}, campo_etiqueta)
        for path in (feat.get("geometry") or {}).get("paths") or []:
            if len(path) < 2:
                continue
            puntos = _decimar([(lat, lon) for lon, lat in path])
            if len(puntos) < 2:
                continue
            vias.append({"c": etiqueta, "t": tipo, "p": [[round(lat, 4), round(lon, 4)] for lat, lon in puntos]})
    return vias


def _fetch_vias_tipo(tipo: str, layer: str, oid: str, campo: str, previo_tipo: list) -> tuple[list, bool]:
    """Devuelve (vías, parcial). Si falla el fetch, cae a las vías previas de
    ESE tipo (no arrastra las del otro tipo si uno de los dos servicios cae)."""
    try:
        features = _fetch_capa(layer, oid, [campo])
        return _procesar_vias(features, tipo, campo), False
    except Exception as err:
        print(f"[aviso] tsunami_vias ({tipo}): {err}")
        return previo_tipo, True


def _update_vias(con, fetched_at: str) -> int:
    previo = []
    if config.TSUNAMI_VIAS_PATH.exists():
        try:
            previo = json.loads(config.TSUNAMI_VIAS_PATH.read_text()).get("vias", [])
        except Exception:
            previo = []
    # Corridas antes de F14 no traían "t": esas vías previas eran todas de tsunami.
    previo_tsunami = [v for v in previo if v.get("t", "tsunami") == "tsunami"]
    previo_volcan = [v for v in previo if v.get("t") == "volcan"]

    vias_tsunami, parcial_t = _fetch_vias_tipo(
        "tsunami", VIAS_LAYER_TSUNAMI, VIAS_OID_TSUNAMI, VIAS_CAMPO_TSUNAMI, previo_tsunami)
    vias_volcan, parcial_v = _fetch_vias_tipo(
        "volcan", VIAS_LAYER_VOLCAN, VIAS_OID_VOLCAN, VIAS_CAMPO_VOLCAN, previo_volcan)
    vias = vias_tsunami + vias_volcan
    parcial = parcial_t or parcial_v
    if not vias:
        return 0

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "tsunami_vias", config.EMERGENCIA_ARCGIS_BASE,
         json.dumps({"vias_tsunami": len(vias_tsunami), "vias_volcan": len(vias_volcan)})))
    con.commit()

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SENAPRED · Visor Chile Preparado",
        "vias": vias,
    }
    if parcial:
        payload["parcial"] = True
    config.TSUNAMI_VIAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.TSUNAMI_VIAS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(vias)


def _procesar_areas(features: list) -> list:
    """Cada feature (esriGeometryPolygon) trae "rings": [[[lon,lat],...], ...].
    Solo se usa el ring exterior (rings[0]): son polígonos de relleno visual
    (zona a abandonar), no capas con huecos relevantes para el mapa."""
    areas = []
    for feat in features:
        attrs = feat.get("attributes") or {}
        etiqueta = " · ".join(p for p in (_texto(attrs, "sector"), _texto(attrs, "comuna")) if p)
        rings = (feat.get("geometry") or {}).get("rings") or []
        if not rings or len(rings[0]) < 2:
            continue
        puntos = _decimar([(lat, lon) for lon, lat in rings[0]], AREAS_MIN_DIST_DEG)
        if len(puntos) < 3:
            continue
        areas.append({"c": etiqueta, "p": [[round(lat, 4), round(lon, 4)] for lat, lon in puntos]})
    return areas


def _update_areas(con, fetched_at: str) -> int:
    previo = []
    if config.TSUNAMI_AREAS_PATH.exists():
        try:
            previo = json.loads(config.TSUNAMI_AREAS_PATH.read_text()).get("areas", [])
        except Exception:
            previo = []

    parcial = False
    try:
        features = _fetch_capa(AREAS_LAYER, AREAS_OID, AREAS_CAMPOS)
        areas = _procesar_areas(features)
    except Exception as err:
        print(f"[aviso] tsunami_areas: {err}")
        if not previo:
            return 0
        areas, parcial = previo, True

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "tsunami_areas", config.EMERGENCIA_ARCGIS_BASE,
         json.dumps({"areas": len(areas)})))
    con.commit()

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SENAPRED · Visor Chile Preparado",
        "areas": areas,
    }
    if parcial:
        payload["parcial"] = True
    config.TSUNAMI_AREAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.TSUNAMI_AREAS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(areas)


def _procesar(categoria: str, features: list) -> list:
    build = ITEM_BUILDERS[categoria]
    items = []
    for feat in features:
        geom = feat.get("geometry")
        if not geom or geom.get("y") is None or geom.get("x") is None:
            continue
        n, d = build(feat.get("attributes") or {})
        item = {"n": n, "lat": round(geom["y"], 4), "lon": round(geom["x"], 4)}
        if d:
            item["d"] = d
        items.append(item)
    return items


def update(con, fetched_at: str) -> int:
    previo = {}
    if config.EMERGENCIA_PATH.exists():
        try:
            previo = json.loads(config.EMERGENCIA_PATH.read_text()).get("categorias", {})
        except Exception:
            previo = {}

    categorias = {}
    conteos = {}
    errores = []
    parcial = False
    for nombre, (path, oid, campos) in CAPAS.items():
        try:
            features = _fetch_capa(path, oid, campos)
            categorias[nombre] = _procesar(nombre, features)
            conteos[nombre] = len(categorias[nombre])
        except Exception as err:
            errores.append(f"{nombre}: {err}")
            if nombre in previo:
                categorias[nombre] = previo[nombre]
                conteos[nombre] = len(previo[nombre])
                parcial = True

    if not categorias:
        raise RuntimeError(f"emergencia SENAPRED: todas las categorías fallaron: {'; '.join(errores)}")
    if errores:
        print(f"[aviso] emergencia parcial: {'; '.join(errores)}")

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "emergencia", config.EMERGENCIA_ARCGIS_BASE,
         json.dumps(conteos, ensure_ascii=False)))
    con.commit()

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SENAPRED · Visor Chile Preparado",
        "categorias": categorias,
    }
    if parcial:
        payload["parcial"] = True
    config.EMERGENCIA_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.EMERGENCIA_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")

    n_vias = _update_vias(con, fetched_at)
    n_areas = _update_areas(con, fetched_at)
    return sum(conteos.values()) + n_vias + n_areas
