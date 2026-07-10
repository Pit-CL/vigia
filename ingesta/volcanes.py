"""Alerta técnica volcánica (SERNAGEOMIN, Red Nacional de Vigilancia
Volcánica — RNVV). Best effort: rnvv.sernageomin.cl puede no responder desde
ciertas redes (dev); si ambas URLs fallan, el step falla limpio y el
volcanes.json anterior queda vigente — en el VPS de producción puede andar
aunque falle en este entorno.

Sin API estructurada: se scrapea el HTML con html.parser (stdlib) y se
matchea cada volcán conocido (`volcanes_cl.VOLCANES`) contra el texto plano,
buscando la palabra de nivel más cercana después de su nombre.
"""
import json
import re
import unicodedata
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser

import config
from volcanes_cl import VOLCANES

UA = "vigia-ingesta/1.0 (proyecto open source; clima.cavara.cl)"
NIVELES_VALIDOS = {"verde", "amarilla", "naranja", "roja"}
VENTANA_BUSQUEDA = 200   # caracteres tras el nombre del volcán donde se busca el nivel
MIN_VOLCANES_OK = 15


class _TextExtractor(HTMLParser):
    """Recolecta el texto plano de una página HTML (ignora <script>/<style>)."""

    def __init__(self):
        super().__init__()
        self._skip = 0
        self._chunks: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self._chunks.append(data)

    def texto(self) -> str:
        return " ".join(self._chunks)


def _normalizar(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return s.lower()


def _parse(html_text: str) -> dict[str, str]:
    """nombre de volcán (clave de VOLCANES) -> nivel detectado. Testeable sin
    red: para cada volcán conocido busca su nombre normalizado en el texto
    plano y, en una ventana de VENTANA_BUSQUEDA caracteres después, la
    primera palabra de nivel (verde/amarilla/naranja/roja)."""
    extractor = _TextExtractor()
    extractor.feed(html_text)
    texto_norm = _normalizar(extractor.texto())

    detectados = {}
    for nombre in VOLCANES:
        nombre_norm = _normalizar(nombre)
        pos = texto_norm.find(nombre_norm)
        if pos < 0:
            continue
        ventana = texto_norm[pos + len(nombre_norm): pos + len(nombre_norm) + VENTANA_BUSQUEDA]
        m = re.search(r"verde|amarilla|naranja|roja", ventana)
        if not m or m.group(0) not in NIVELES_VALIDOS:
            continue
        detectados[nombre] = m.group(0)
    return detectados


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read().decode("utf-8", errors="replace")


def _fetch_y_parsear(url: str) -> tuple[str | None, dict[str, str], str | None]:
    """Devuelve (html, detectados, error). error=None solo si el fetch y el
    parseo dieron >= MIN_VOLCANES_OK volcanes con nivel."""
    try:
        html_text = _fetch(url)
    except Exception as err:
        return None, {}, f"fetch {url} falló: {err}"
    detectados = _parse(html_text)
    if len(detectados) < MIN_VOLCANES_OK:
        return html_text, detectados, f"parseo de {url} solo detectó {len(detectados)} volcanes (< {MIN_VOLCANES_OK})"
    return html_text, detectados, None


def update(con, fetched_at: str) -> int:
    url = config.API_RNVV
    html_text, detectados, err = _fetch_y_parsear(url)
    if err:
        print(f"[aviso] RNVV primaria falló, intento fallback: {err}")
        url = config.API_RNVV_FALLBACK
        html_text, detectados, err = _fetch_y_parsear(url)
    if err:
        raise RuntimeError(f"RNVV inaccesible (primaria y fallback fallaron): {err}")

    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "rnvv", url, html_text))
    con.commit()

    volcanes = []
    for nombre, nivel in detectados.items():
        lat, lon, region, peligrosidad = VOLCANES[nombre]
        volcanes.append({
            "nombre": nombre, "nivel": nivel, "lat": lat, "lon": lon,
            "region": region, "peligrosidad": peligrosidad,
        })

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SERNAGEOMIN · RNVV",
        "volcanes": volcanes,
    }
    config.VOLCANES_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.VOLCANES_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(volcanes)
