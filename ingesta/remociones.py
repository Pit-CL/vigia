"""Catastro de remociones en masa (SENAPRED).

Capa vista con ~1.218 eventos históricos de remociones en masa (aluviones,
deslizamientos, caídas de rocas) catastrados en todo Chile: no es un
pronóstico, es dónde YA ocurrieron — el historial marca las quebradas y
laderas activas.

Mismo host/org de las alertas SENAPRED (config.ALERTAS_ARCGIS_BASE), otro
servicio: Remocionesenmasa_Capavista/FeatureServer/0. Paginado con
resultOffset igual que emergencia.py, pero maxRecordCount de este servicio es
1.000 (no 2.000): PAGE_SIZE debe calzar con ese tope o la paginación saltaría
registros (el server jamás devuelve más de maxRecordCount por página aunque
se pida más).

Campos AREA_m2/VOLUMEN_m3/TIPO_MATER/NOMBRE_RM verificados contra el servicio
real: vienen vacíos o son códigos internos sin valor para el mapa, así que
solo se pide SUBTIPO_DE (el campo que sí viene poblado y es legible).

Cuasi-estático (catastro histórico, no cambia entre corridas semanales): sin
tabla propia, cada corrida reemplaza remociones.json por completo, igual que
emergencia.json.
"""
import json
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

import config

UA = "vigia-ingesta/1.0 (proyecto open source; vigia.cavara.cl)"
PAGE_SIZE = 1000  # = maxRecordCount real del servicio (verificado con ?f=json)

SERVICIO = "Remocionesenmasa_Capavista/FeatureServer/0"
OID = "OBJECTID_1"
CAMPOS = ["SUBTIPO_DE"]


def _fetch_pagina(offset: int) -> dict:
    params = {
        "where": "1=1", "outFields": ",".join(CAMPOS), "f": "json",
        "returnGeometry": "true", "outSR": "4326",
        "resultRecordCount": str(PAGE_SIZE), "resultOffset": str(offset),
        "orderByFields": OID,
    }
    url = f"{config.ALERTAS_ARCGIS_BASE}/{SERVICIO}/query?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def _fetch_todo() -> list:
    features = []
    offset = 0
    while True:
        data = _fetch_pagina(offset)
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(str(data["error"]))
        pagina = data.get("features", [])
        features.extend(pagina)
        if not data.get("exceededTransferLimit"):
            break
        offset += PAGE_SIZE
    return features


def _procesar(features: list) -> list:
    puntos = []
    for feat in features:
        geom = feat.get("geometry")
        if not geom or geom.get("y") is None or geom.get("x") is None:
            continue
        subtipo = (feat.get("attributes") or {}).get("SUBTIPO_DE")
        if not subtipo:
            continue
        puntos.append({"lat": round(geom["y"], 4), "lon": round(geom["x"], 4), "t": subtipo})
    return puntos


def update(con, fetched_at: str) -> int:
    features = _fetch_todo()
    puntos = _procesar(features)
    if not puntos:
        raise RuntimeError("remociones SENAPRED: 0 puntos con geometría y subtipo válidos")

    # Resumen de conteos por subtipo, no el payload completo (mismo criterio
    # que emergencia.py: 1.218 features no aportan trazabilidad proporcional a
    # su peso).
    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "remociones", config.ALERTAS_ARCGIS_BASE,
         json.dumps(dict(Counter(p["t"] for p in puntos)), ensure_ascii=False)))
    con.commit()

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "Catastro de remociones en masa · SENAPRED",
        "puntos": puntos,
    }
    config.REMOCIONES_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.REMOCIONES_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(puntos)
