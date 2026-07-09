"""Infraestructura de emergencia comunitaria (SENAPRED, visor "Chile Preparado").

Datos cuasi-estáticos (postas y hospitales, cuarteles de bomberos, comisarías,
puntos de encuentro ante tsunami): sin tabla propia, cada corrida reemplaza
emergencia.json por completo. Solo se archiva un resumen de conteos en
raw_payloads (source 'emergencia'): los payloads completos son ~9.000
features y no aportan trazabilidad proporcional a su peso.

Servicios: {BASE}/Servicios_2024/FeatureServer/{0,1,3} (salud, bomberos,
carabineros) + {BASE}/Amenaza_por_Tsunami_2024/FeatureServer/0 (puntos de
encuentro). Paginado con resultRecordCount=2000 + resultOffset hasta que
exceededTransferLimit sea falso.

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
    return sum(conteos.values())
