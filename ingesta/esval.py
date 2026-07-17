"""Cortes de agua Esval (zonas de interrupción, V Región) — vía satélite en omen.

No fetchea la red: Esval bloquea IPs de datacenter (verificado desde el VPS,
funciona desde omen). Lee el JSON crudo que `satelite/fetch_cl.py` sube por
scp a `INCOMING_DIR/esval.json` — a diferencia de sec.json/farmacias_raw.json,
el campo "data" del envoltorio no es JSON: es el texto crudo de un KML 2.0
(XML) que se parsea acá con `xml.etree.ElementTree` (stdlib, regla dura 1).

Endpoint no documentado (`tupuntodeagua.esval.cl/script/generaKmlZonasCorte.
aspx?region=5`): igual que SEC, se etiqueta best effort. Sin cortes activos
el KML solo trae los 6 `<Style>` de color, cero `<Placemark>` — se trata
como "0 zonas", no como error (verificado en vivo 2026-07-17).

Como no hay un `<Placemark>` real de ejemplo (nunca hubo un corte activo
durante el desarrollo), el parseo es defensivo y tolerante por diseño: busca
tags por nombre local (ignora el namespace exacto, por si Esval cambia entre
`earth.google.com/kml/2.0` y `opengis.net/kml/2.2`), y un Placemark sin
`<Polygon>` o sin coordenadas válidas se descarta individualmente — nunca
aborta el archivo completo — dejando rastro en el log (nada de fallas
silenciosas, ver PR #147).

Frescura: mismo patrón que `cortes.py` (STALE_MIN=30, el satélite fetchea
cada 15 min junto con SEC). Si `INCOMING_DIR/esval.json` no existe o su
`fetched_utc` tiene más de STALE_MIN, se conserva el esval.json previo
marcándolo `"stale": true`.
"""
import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import config

STALE_MIN = 30

ESVAL_URL_DOC = "tupuntodeagua.esval.cl/script/generaKmlZonasCorte.aspx"


def _local(tag: str) -> str:
    """Tag local sin namespace: '{http://...}Placemark' -> 'Placemark'."""
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _find_local(elem, name: str):
    """Primer descendiente (incluido elem mismo) cuyo tag local sea `name`."""
    for child in elem.iter():
        if _local(child.tag) == name:
            return child
    return None


def _findall_local(elem, name: str) -> list:
    return [child for child in elem.iter() if _local(child.tag) == name]


def _texto(elem) -> str | None:
    if elem is None or elem.text is None:
        return None
    t = elem.text.strip()
    return t or None


def _estilo(placemark) -> str | None:
    """'#My_Style_Zona_Corte_ROJO' -> 'ROJO' (último segmento tras el
    último '_' del styleUrl). None si no hay styleUrl o no calza el patrón."""
    su = _texto(_find_local(placemark, "styleUrl"))
    if not su:
        return None
    ref = su.lstrip("#").strip()
    return ref.rsplit("_", 1)[-1].upper() if ref else None


def _extended_data(placemark) -> dict:
    """ExtendedData genérico -> dict plano. Tolera dos formas KML:
    <Data name="X"><value>Y</value></Data> y <SimpleData name="X">Y</SimpleData>."""
    atributos: dict = {}
    ext = _find_local(placemark, "ExtendedData")
    if ext is None:
        return atributos
    for data in _findall_local(ext, "Data"):
        nombre = data.get("name")
        if not nombre:
            continue
        valor = _texto(_find_local(data, "value"))
        atributos[nombre] = valor if valor is not None else (_texto(data) or "")
    for sd in _findall_local(ext, "SimpleData"):
        nombre = sd.get("name")
        if nombre:
            atributos[nombre] = _texto(sd) or ""
    return atributos


def _coords_poligono(polygon_el) -> list | None:
    """<Polygon>/<outerBoundaryIs>/<LinearRing>/<coordinates> ("lon,lat[,alt]
    lon,lat[,alt] …") -> [[lat, lon], ...]. None si no hay coordenadas
    parseables o quedan menos de 3 puntos (no cierra un polígono)."""
    outer = _find_local(polygon_el, "outerBoundaryIs")
    ring = _find_local(outer, "LinearRing") if outer is not None else None
    coords_el = _find_local(ring, "coordinates") if ring is not None else None
    texto = _texto(coords_el)
    if not texto:
        return None
    puntos = []
    for tupla in texto.split():
        partes = tupla.split(",")
        if len(partes) < 2:
            continue
        try:
            lon, lat = float(partes[0]), float(partes[1])
        except ValueError:
            continue
        puntos.append([lat, lon])
    return puntos if len(puntos) >= 3 else None


def _parsear_zonas(kml_texto: str) -> tuple[list, int]:
    """Devuelve (zonas, descartados). Un Placemark o Polygon raro se
    descarta individualmente (con aviso en log), nunca aborta el resto."""
    try:
        root = ET.fromstring(kml_texto)
    except ET.ParseError as err:
        raise RuntimeError(f"cortes de agua Esval: KML crudo no parseable: {err}")

    zonas, descartados = [], 0
    for placemark in _findall_local(root, "Placemark"):
        nombre = _texto(_find_local(placemark, "name"))
        descripcion = _texto(_find_local(placemark, "description"))
        estilo = _estilo(placemark)
        atributos = _extended_data(placemark)
        polygons = _findall_local(placemark, "Polygon")
        if not polygons:
            print(f"[aviso] esval: Placemark sin <Polygon> descartado (nombre={nombre!r})", file=sys.stderr)
            descartados += 1
            continue
        for poly in polygons:
            puntos = _coords_poligono(poly)
            if not puntos:
                print(f"[aviso] esval: Polygon sin coordenadas válidas descartado (nombre={nombre!r})", file=sys.stderr)
                descartados += 1
                continue
            zonas.append({
                "nombre": nombre,
                "descripcion": descripcion,
                "atributos": atributos,
                "estilo": estilo,
                "poligono": puntos,
            })
    return zonas, descartados


def _incoming_fresco() -> dict | None:
    path = config.INCOMING_DIR / "esval.json"
    if not path.exists():
        return None
    try:
        crudo = json.loads(path.read_text())
        fetched = datetime.strptime(crudo["fetched_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (OSError, json.JSONDecodeError, KeyError, ValueError):
        return None
    if datetime.now(timezone.utc) - fetched > timedelta(minutes=STALE_MIN):
        return None
    return crudo


def update(con, fetched_at: str) -> int:
    crudo = _incoming_fresco()
    if crudo is None:
        # Sin incoming fresco (satélite caído o nunca instalado): conserva el
        # esval.json previo marcado stale, no lo borra ni lo deja a 0.
        if not config.ESVAL_PATH.exists():
            return 0
        try:
            previo = json.loads(config.ESVAL_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            return 0
        previo["stale"] = True
        config.ESVAL_PATH.write_text(json.dumps(previo, ensure_ascii=False) + "\n")
        return 0

    kml_texto = crudo.get("data")
    if not isinstance(kml_texto, str) or not kml_texto.strip():
        raise RuntimeError("cortes de agua Esval: incoming/esval.json sin campo 'data' de tipo texto KML")
    zonas, descartados = _parsear_zonas(kml_texto)
    if descartados:
        print(f"[aviso] esval: {descartados} elemento(s) del KML descartado(s) (ver detalle arriba)", file=sys.stderr)

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "esval", ESVAL_URL_DOC,
         json.dumps({"n_zonas": len(zonas), "descartados": descartados})))
    con.commit()

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "Esval (Zonas de Corte de Agua Potable, V Región) · best effort",
        "stale": False,
        "n_zonas": len(zonas),
        "zonas": zonas,
    }
    config.ESVAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.ESVAL_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(zonas)
