"""Satélite de fuentes que bloquean IPs de datacenter (SEC, MINSAL).

Corre en omen (IP residencial chilena), NO en el VPS: se verificó que ambos
endpoints responden desde omen y fallan desde el VPS. Este script solo
fetchea y sube JSON crudos por scp a `data/incoming/` en el VPS — el
procesamiento (georreferencia, agregación) vive en `ingesta/cortes.py` y
`ingesta/farmacias.py`, que corren en el VPS y solo leen esos crudos.

Uso (cron en omen, ver satelite/README.md):
    python3 satelite/fetch_cl.py

Tolerante: si una fuente falla, sube la otra igual. Sale 0 si al menos una
fuente se subió con éxito, 1 si las dos fallaron.
"""
import json
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

SEC_URL = "https://apps.sec.cl/INTONLINEv1/ClientesAfectados/GetPorFecha"
MINSAL_URL = "https://midas.minsal.cl/farmacia_v2/WS/getLocalesTurnos.php"

# Destino en el VPS: usuario/host y ruta son constantes para no depender de
# config externa en un script que corre en otra máquina. Clave ssh dedicada
# (ver satelite/README.md), restringida por command= a solo scp sobre incoming/.
# OJO: vigia.cavara.cl solo resuelve al Cloudflare Tunnel (HTTP, sin SSH) —
# aquí va la IP pública real del VPS Hostinger, no el dominio del sitio.
SSH_DEST = "rafael@76.13.237.200"
INCOMING_DIR = "/opt/vigia/data/incoming"

TIMEOUT_S = 30


def _fetch_sec() -> dict:
    hoy = datetime.now(ZoneInfo("America/Santiago"))
    body = json.dumps({"anho": hoy.year, "mes": hoy.month, "dia": hoy.day}).encode("utf-8")
    req = urllib.request.Request(SEC_URL, data=body, method="POST", headers={
        "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        return json.loads(res.read().decode("utf-8"))


def _fetch_minsal() -> dict:
    req = urllib.request.Request(MINSAL_URL, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        return json.loads(res.read().decode("utf-8"))


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
        subprocess.run(
            ["scp", "-o", "ConnectTimeout=15", str(path), f"{SSH_DEST}:{INCOMING_DIR}/{nombre}"],
            check=True, capture_output=True, text=True, timeout=60,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as err:
        detalle = err.stderr if isinstance(err, subprocess.CalledProcessError) else str(err)
        print(f"[aviso] {nombre}: scp falló: {detalle}", file=sys.stderr)
        return False

    print(f"[ok] {nombre} subido a {SSH_DEST}:{INCOMING_DIR}/")
    return True


def main() -> int:
    with tempfile.TemporaryDirectory() as tmpdir:
        ok_sec = _escribir_y_subir("sec.json", _fetch_sec, tmpdir)
        ok_minsal = _escribir_y_subir("farmacias_raw.json", _fetch_minsal, tmpdir)
    return 0 if (ok_sec or ok_minsal) else 1


if __name__ == "__main__":
    sys.exit(main())
