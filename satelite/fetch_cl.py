"""Satélite de fuentes que bloquean IPs de datacenter (SEC, MINSAL, Esval).

Corre en omen (IP residencial chilena), NO en el VPS: se verificó que los
tres endpoints responden desde omen y fallan desde el VPS. Este script solo
fetchea y sube JSON crudos por scp a `data/incoming/` en el VPS — el
procesamiento (georreferencia, agregación, parseo KML) vive en
`ingesta/cortes.py`, `ingesta/farmacias.py` e `ingesta/esval.py`, que corren
en el VPS y solo leen esos crudos.

Uso (cron en omen, ver satelite/README.md):
    python3 satelite/fetch_cl.py

Tolerante: si una fuente falla, las demás suben igual. Sale 0 si al menos
una fuente se subió con éxito, 1 si las tres fallaron.
"""
import json
import os
import random
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

SEC_URL = "https://apps.sec.cl/INTONLINEv1/ClientesAfectados/GetPorFecha"
# Endpoint hermano: serie horaria de ~7 días (sin body). GetPorFecha exige
# anho/mes/dia/hora exactos — si falta "hora" (o llega hora=0) devuelve el
# snapshot de MEDIANOCHE, no el vigente (ver _fetch_sec). Igual que el
# dashboard oficial (scripts/actions-page.js), se pide esta serie primero y
# se usa el último registro publicado como referencia de fecha/hora.
SEC_SERIE_URL = "https://apps.sec.cl/INTONLINEv1/ClientesAfectados/Get"
MINSAL_URL = "https://midas.minsal.cl/farmacia_v2/WS/getLocalesTurnos.php"
# Zonas de corte de agua potable, V Región (Valparaíso) — la única región que
# Esval opera. Devuelve KML 2.0 (XML), no JSON: a diferencia de SEC/MINSAL,
# _fetch_esval() no hace json.loads, sube el texto crudo tal cual (ver
# _escribir_y_subir: envuelve cualquier `data`, no solo dict/list).
# Random=<float> replica el cache-busting del JS oficial del sitio.
ESVAL_URL = "https://tupuntodeagua.esval.cl/script/generaKmlZonasCorte.aspx"

# Destino en el VPS vía env VIGIA_SSH_DEST (se fija en la línea del crontab de
# omen, ver satelite/README.md). NUNCA hardcodear usuario@IP aquí: el repo es
# público y la IP de origen del VPS debe permanecer oculta — el Cloudflare
# Tunnel existe precisamente para eso (vigia.cavara.cl no expone SSH).
# Clave ssh dedicada, restringida por command= a solo scp sobre incoming/.
SSH_DEST = os.environ.get("VIGIA_SSH_DEST", "")
INCOMING_DIR = "/opt/vigia/data/incoming"

TIMEOUT_S = 30


def _fetch_sec() -> dict:
    # Incidente 2026-07-16: sin "hora" (u hora=0) GetPorFecha respondió el
    # snapshot de medianoche — Vigía mostró 13.643 clientes a nivel
    # nacional cuando la SEC ya reportaba ~520.000. Por eso el primer paso
    # es siempre pedir la serie horaria vigente.
    req_serie = urllib.request.Request(SEC_SERIE_URL, method="POST", headers={
        "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json",
    })
    with urllib.request.urlopen(req_serie, timeout=TIMEOUT_S) as res:
        serie = json.loads(res.read().decode("utf-8"))

    if not isinstance(serie, list) or not serie:
        raise ValueError("ClientesAfectados/Get: serie horaria vacía o con formato inesperado")
    ultimo = serie[-1]
    try:
        body = json.dumps({
            "anho": ultimo["anho"], "mes": ultimo["mes"],
            "dia": ultimo["dia"], "hora": ultimo["hora"],
        }).encode("utf-8")
    except (KeyError, TypeError) as err:
        raise ValueError(f"ClientesAfectados/Get: último registro sin anho/mes/dia/hora: {err}")

    req = urllib.request.Request(SEC_URL, data=body, method="POST", headers={
        "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        return json.loads(res.read().decode("utf-8"))


def _fetch_minsal() -> dict:
    req = urllib.request.Request(MINSAL_URL, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        return json.loads(res.read().decode("utf-8"))


def _fetch_esval() -> str:
    # Geo-bloqueado igual que SEC/MINSAL (verificado: timeout desde el VPS,
    # 200 OK desde omen). Sin cortes activos el KML solo trae los 6 <Style>
    # de color, cero <Placemark> — ingesta/esval.py lo trata como "0 zonas",
    # no como error.
    url = f"{ESVAL_URL}?region=5&Random={random.random()}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        return res.read().decode("utf-8")


def _escribir_y_subir(nombre: str, fetch_fn, tmpdir: str) -> bool:
    try:
        data = fetch_fn()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as err:
        print(f"[aviso] {nombre}: fetch falló: {err}", file=sys.stderr)
        return False

    envoltorio = {"fetched_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "data": data}
    path = Path(tmpdir) / nombre
    path.write_text(json.dumps(envoltorio, ensure_ascii=False))

    try:
        # -O fuerza el protocolo scp legado: OpenSSH >= 9.0 usa SFTP por
        # defecto, que NO calza con la restricción `command="scp -t ..."`
        # del authorized_keys en el VPS (esa forced command solo intercepta
        # el protocolo scp clásico, no la subsystem request de sftp).
        # Verificado en omen (OpenSSH 9.6p1): sin -O el scp cuelga.
        # ControlMaster=no + ControlPath=none: omen es la laptop personal de
        # operación diaria, cuyo ~/.ssh/config trae bloques `Host *` con
        # multiplexado (ControlMaster/ControlPath) puestos por otras
        # herramientas ajenas a Vigía. Si ese ControlPath apunta a un
        # directorio que no existe, el scp pierde la conexión sin subir
        # nada (incidente 2026-07-16: 22 h sin datos de cortes/farmacias).
        # Estas opciones fuerzan una conexión propia, sin depender de nada
        # que otro script en omen pueda romper.
        subprocess.run(
            ["scp", "-O", "-o", "ConnectTimeout=15",
             "-o", "ControlMaster=no", "-o", "ControlPath=none",
             str(path), f"{SSH_DEST}:{INCOMING_DIR}/{nombre}"],
            check=True, capture_output=True, text=True, timeout=60,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as err:
        detalle = err.stderr if isinstance(err, subprocess.CalledProcessError) else str(err)
        print(f"[aviso] {nombre}: scp falló: {detalle}", file=sys.stderr)
        return False

    print(f"[ok] {nombre} subido a {SSH_DEST}:{INCOMING_DIR}/")
    return True


def main() -> int:
    if not SSH_DEST:
        print("[error] falta VIGIA_SSH_DEST (usuario@ip del VPS); ver satelite/README.md")
        return 1
    with tempfile.TemporaryDirectory() as tmpdir:
        ok_sec = _escribir_y_subir("sec.json", _fetch_sec, tmpdir)
        ok_minsal = _escribir_y_subir("farmacias_raw.json", _fetch_minsal, tmpdir)
        ok_esval = _escribir_y_subir("esval.json", _fetch_esval, tmpdir)
    return 0 if (ok_sec or ok_minsal or ok_esval) else 1


if __name__ == "__main__":
    sys.exit(main())
