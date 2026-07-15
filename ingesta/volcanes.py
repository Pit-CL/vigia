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
import ssl
import unicodedata
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

import config
from volcanes_cl import VOLCANES

UA = "vigia-ingesta/1.0 (proyecto open source; vigia.cavara.cl)"
NIVELES_VALIDOS = {"verde", "amarilla", "naranja", "roja"}
VENTANA_BUSQUEDA = 200   # caracteres tras el nombre del volcán donde se busca el nivel
MIN_VOLCANES_OK = 15

# El fallback (www.sernageomin.cl/alertas-volcanicas/) no es un semáforo
# completo: solo lista los volcanes con alerta sobre verde bajo este título
# de sección (verificado en el HTML real). Si el marcador está, 0 volcanes es
# un dato válido ("nadie sobre verde"); si no está, la página vino rota.
MARCADOR_PARCIAL = "informacion de volcanes en alertas"
NOTA_PARCIAL = ("Fuente parcial (SERNAGEOMIN web): solo volcanes con alerta sobre "
                "nivel verde; el semáforo completo (RNVV) no está disponible.")

# sernageomin.cl sirve solo el certificado hoja en su cadena TLS (falta el
# intermedio); se vendoriza para poder verificar sin desactivar la validación.
CERT_INTERMEDIO_SERNAGEOMIN = Path(__file__).parent / "certs" / "globalsign-alphassl-2025.pem"
_SSL_CONTEXT_SERNAGEOMIN = ssl.create_default_context()
_SSL_CONTEXT_SERNAGEOMIN.load_verify_locations(cafile=str(CERT_INTERMEDIO_SERNAGEOMIN))


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


def _texto_normalizado(html_text: str) -> str:
    extractor = _TextExtractor()
    extractor.feed(html_text)
    return _normalizar(extractor.texto())


def _find_nombre(texto_norm: str, nombre_norm: str) -> int:
    """Busca nombre_norm como palabra completa, no como substring de un
    nombre compuesto más largo (ej. "san pedro" no debe matchear dentro de
    "san pedro-pellado", otro volcán real y distinto en VOLCANES)."""
    m = re.search(rf"(?<![a-z0-9-]){re.escape(nombre_norm)}(?![a-z0-9-])", texto_norm)
    return m.start() if m else -1


class _TextExtractorConAlt(_TextExtractor):
    """Como _TextExtractor, pero suma el atributo alt de <img> como texto:
    en el fallback de SERNAGEOMIN el nivel de alerta solo aparece ahí (ej.
    alt="Alerta Amarilla Complejo Volcánico Nevados de Chillán"), no en el
    texto plano fluido de la página."""

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        if tag == "img":
            alt = dict(attrs).get("alt")
            if alt:
                self._chunks.append(alt)


def _parse_parcial(html_text: str) -> dict[str, str]:
    """Variante de _parse para el fallback: el nivel de alerta va ANTES del
    nombre del volcán (alt de imagen "Alerta {nivel} {nombre}"), al revés que
    en la ruta primaria. Se busca en una ventana antes y después del nombre."""
    extractor = _TextExtractorConAlt()
    extractor.feed(html_text)
    texto_norm = _normalizar(extractor.texto())

    detectados = {}
    for nombre in VOLCANES:
        nombre_norm = _normalizar(nombre)
        pos = _find_nombre(texto_norm, nombre_norm)
        if pos < 0:
            continue
        antes = texto_norm[max(0, pos - VENTANA_BUSQUEDA):pos]
        despues = texto_norm[pos + len(nombre_norm): pos + len(nombre_norm) + VENTANA_BUSQUEDA]
        m = re.search(r"verde|amarilla|naranja|roja", antes) or re.search(r"verde|amarilla|naranja|roja", despues)
        if not m or m.group(0) not in NIVELES_VALIDOS:
            continue
        detectados[nombre] = m.group(0)
    return detectados


def _parse(html_text: str) -> dict[str, str]:
    """nombre de volcán (clave de VOLCANES) -> nivel detectado. Testeable sin
    red: para cada volcán conocido busca su nombre normalizado en el texto
    plano y, en una ventana de VENTANA_BUSQUEDA caracteres después, la
    primera palabra de nivel (verde/amarilla/naranja/roja)."""
    texto_norm = _texto_normalizado(html_text)

    detectados = {}
    for nombre in VOLCANES:
        nombre_norm = _normalizar(nombre)
        pos = _find_nombre(texto_norm, nombre_norm)
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
    ctx = _SSL_CONTEXT_SERNAGEOMIN if "sernageomin.cl" in url else None
    with urllib.request.urlopen(req, timeout=30, context=ctx) as res:
        return res.read().decode("utf-8", errors="replace")


def _fetch_y_parsear(url: str) -> tuple[str | None, dict[str, str], str | None]:
    """Devuelve (html, detectados, error). error=None solo si el fetch y el
    parseo dieron >= MIN_VOLCANES_OK volcanes con nivel (ruta primaria RNVV,
    que expone el semáforo completo)."""
    try:
        html_text = _fetch(url)
    except Exception as err:
        return None, {}, f"fetch {url} falló: {err}"
    detectados = _parse(html_text)
    if len(detectados) < MIN_VOLCANES_OK:
        return html_text, detectados, f"parseo de {url} solo detectó {len(detectados)} volcanes (< {MIN_VOLCANES_OK})"
    return html_text, detectados, None


def _fetch_y_parsear_parcial(url: str) -> tuple[str | None, dict[str, str], str | None]:
    """Ruta de fallback: la página solo lista volcanes con alerta sobre
    verde, así que 0 detectados es un dato válido. Solo se valida que el
    marcador estructural de la sección esté presente (si no, la página vino
    rota/vacía y se trata como error)."""
    try:
        html_text = _fetch(url)
    except Exception as err:
        return None, {}, f"fetch {url} falló: {err}"
    texto_norm = _texto_normalizado(html_text)
    if MARCADOR_PARCIAL not in texto_norm:
        return html_text, {}, f"parseo de {url}: no se encontró el marcador de la sección de alertas"
    return html_text, _parse_parcial(html_text), None


def update(con, fetched_at: str) -> int:
    url = config.API_RNVV
    html_text, detectados, err = _fetch_y_parsear(url)
    parcial = False
    if err:
        print(f"[aviso] RNVV primaria falló, intento fallback: {err}")
        url = config.API_RNVV_FALLBACK
        html_text, detectados, err = _fetch_y_parsear_parcial(url)
        parcial = err is None
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
    if parcial:
        payload["parcial"] = True
        payload["nota"] = NOTA_PARCIAL
    config.VOLCANES_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.VOLCANES_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(volcanes)
