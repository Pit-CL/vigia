"""Infraestructura de emergencia comunitaria (SENAPRED, visor "Chile Preparado").

Datos cuasi-estáticos (postas y hospitales, cuarteles de bomberos, comisarías,
puntos de encuentro ante tsunami): sin tabla propia, cada corrida reemplaza
emergencia.json por completo. Solo se archiva un resumen de conteos en
raw_payloads (source 'emergencia'): los payloads completos son ~9.000
features y no aportan trazabilidad proporcional a su peso.

Servicios: {BASE}/Servicios_2024/FeatureServer/{0,1,3} (salud, bomberos,
carabineros) + {BASE}/Amenaza_por_Tsunami_2024/FeatureServer/{0,1} (puntos de
encuentro y vías de evacuación). Paginado con resultRecordCount=2000 +
resultOffset hasta que exceededTransferLimit sea falso.

Vías de evacuación (FeatureServer/1, esriGeometryPolyline, 2.740 features):
se publican aparte en tsunami_vias.json, no en emergencia.json, porque el
mapa solo las pinta con el zoom acercado — mezclarlas con los puntos
obligaría a cargar y filtrar 2.740 líneas en cada refresco de la capa.

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

UA = "sinoptica-ingesta/1.0 (proyecto open source; clima.cavara.cl)"
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
}

# Vías de evacuación ante tsunami: capa aparte (esriGeometryPolyline, no punto)
# — no calza en CAPAS/ITEM_BUILDERS, que asumen geometría {x,y}. Se publica en
# un JSON propio (tsunami_vias.json) para no engordar emergencia.json con
# 2.740 líneas que el mapa solo pinta acercado (zoom ≥ 11).
VIAS_LAYER = "Amenaza_por_Tsunami_2024/FeatureServer/1"
VIAS_OID = "OBJECTID"
VIAS_CAMPOS = ["nom_com"]  # nom_reg/sector verificados en el servicio pero sin uso: el popup solo muestra comuna
VIAS_MIN_DIST_DEG = 0.00025  # ~25 m: umbral de decimación de vértices


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


ITEM_BUILDERS = {
    "salud": _item_salud,
    "bomberos": _item_bomberos,
    "carabineros": _item_carabineros,
    "encuentro_tsunami": _item_tsunami,
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


def _procesar_vias(features: list) -> list:
    """Cada feature (esriGeometryPolyline) trae "paths": [[[lon,lat],...], ...];
    una feature puede traer varios paths → una entrada "p" por path."""
    vias = []
    for feat in features:
        comuna = _texto(feat.get("attributes") or {}, "nom_com")
        for path in (feat.get("geometry") or {}).get("paths") or []:
            if len(path) < 2:
                continue
            puntos = _decimar([(lat, lon) for lon, lat in path])
            if len(puntos) < 2:
                continue
            vias.append({"c": comuna, "p": [[round(lat, 4), round(lon, 4)] for lat, lon in puntos]})
    return vias


def _update_vias(con, fetched_at: str) -> int:
    previo = []
    if config.TSUNAMI_VIAS_PATH.exists():
        try:
            previo = json.loads(config.TSUNAMI_VIAS_PATH.read_text()).get("vias", [])
        except Exception:
            previo = []

    parcial = False
    try:
        features = _fetch_capa(VIAS_LAYER, VIAS_OID, VIAS_CAMPOS)
        vias = _procesar_vias(features)
    except Exception as err:
        print(f"[aviso] tsunami_vias: {err}")
        if not previo:
            return 0
        vias, parcial = previo, True

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "tsunami_vias", config.EMERGENCIA_ARCGIS_BASE,
         json.dumps({"vias": len(vias)})))
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
    return sum(conteos.values()) + n_vias
