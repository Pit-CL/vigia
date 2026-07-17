#!/usr/bin/env python3
"""Smoke test post-deploy para Vigía. Solo librería estándar — cero dependencias.

Uso:
    python3 deploy/smoke.py [url_base]

Por defecto revisa https://vigia.cavara.cl. Sale con código 0 si todos los
checks pasan, 1 si alguno falla (imprime el detalle de cada FALLA).
"""
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# Cloudflare devuelve 403 al User-Agent por defecto de urllib.
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

fallas = []


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, resp.headers, resp.read()


def ok(msg):
    print(f"OK    {msg}")


def falla(msg):
    print(f"FALLA {msg}")
    fallas.append(msg)


def parse_csp(csp):
    directivas = {}
    for parte in csp.split(";"):
        parte = parte.strip()
        if not parte:
            continue
        nombre, _, valor = parte.partition(" ")
        directivas[nombre] = valor
    return directivas


def check_headers(headers):
    if headers is None:
        falla("no hay headers de / para verificar (falló el GET anterior)")
        return

    csp = headers.get("Content-Security-Policy")
    if not csp:
        falla("falta el header Content-Security-Policy en /")
    else:
        directivas = parse_csp(csp)
        connect_src = directivas.get("connect-src", "")
        img_src = directivas.get("img-src", "")

        faltan_connect = [
            h
            for h in ("basemaps.cartocdn.com", "gibs.earthdata.nasa.gov", "api.open-meteo.com")
            if h not in connect_src
        ]
        if faltan_connect:
            falla(f"connect-src de la CSP no incluye: {', '.join(faltan_connect)}")
        else:
            ok("CSP connect-src incluye cartocdn, GIBS y open-meteo")

        faltan_img = [h for h in ("basemaps.cartocdn.com", "gibs.earthdata.nasa.gov") if h not in img_src]
        if faltan_img:
            falla(f"img-src de la CSP no incluye: {', '.join(faltan_img)}")
        else:
            ok("CSP img-src incluye cartocdn y GIBS")

    pp = headers.get("Permissions-Policy")
    if not pp:
        falla("falta el header Permissions-Policy en /")
    elif "geolocation=(self)" not in pp:
        falla(f"Permissions-Policy no contiene geolocation=(self): {pp}")
    else:
        ok("Permissions-Policy contiene geolocation=(self)")


def check_sw(base, n_index):
    try:
        status, _headers, body = get(base + "/sw.js")
    except Exception as e:
        falla(f"GET /sw.js -> excepción: {e}")
        return
    if status != 200:
        falla(f"GET /sw.js -> status {status} (esperado 200)")
        return
    ok("GET /sw.js -> 200")

    texto = body.decode("utf-8", errors="replace")
    m_js = re.search(r"app\.js\?v=(\d+)", texto)
    m_css = re.search(r"app\.css\?v=(\d+)", texto)
    m_shell = re.search(r"vigia-shell-v(\d+)", texto)

    if not m_js or not m_css:
        falla("no se encontraron app.js?v=M / app.css?v=M en el array SHELL de sw.js")
        return

    m_js_v, m_css_v = m_js.group(1), m_css.group(1)
    if m_js_v != m_css_v:
        falla(f"sw.js: SHELL tiene versiones distintas para app.js (v={m_js_v}) y app.css (v={m_css_v})")
    elif n_index is not None and m_js_v != n_index:
        falla(f"sw.js SHELL usa v={m_js_v} pero index.html usa v={n_index} — desincronizados")
    else:
        ok(f"sw.js SHELL usa la misma versión v={m_js_v} que index.html")

    if m_shell:
        print(f"INFO  cache del shell: vigia-shell-v{m_shell.group(1)}")


def check_json_fresco(base, archivo, maximo):
    try:
        status, _headers, body = get(f"{base}/{archivo}")
    except Exception as e:
        falla(f"GET /{archivo} -> excepción: {e}")
        return
    if status != 200:
        falla(f"GET /{archivo} -> status {status} (esperado 200)")
        return
    try:
        data = json.loads(body)
        updated = datetime.strptime(data["updated"], "%Y-%m-%d %H:%M UTC").replace(tzinfo=timezone.utc)
    except Exception as e:
        falla(f"/{archivo}: no se pudo parsear el campo 'updated' ({e})")
        return
    edad = datetime.now(timezone.utc) - updated
    if edad > maximo:
        falla(f"/{archivo}: 'updated' tiene {edad} de antigüedad (máximo {maximo})")
    else:
        ok(f"/{archivo}: actualizado hace {edad} (máximo {maximo})")


def check_json_fresco_laxo(base, archivo, maximo):
    """Como check_json_fresco pero tolerante con cortes.json: depende de un
    satélite fuera del VPS (ver satelite/README.md) que puede no estar
    instalado todavía o llevar rato caído — eso es un aviso, no una falla
    del deploy. `stale: true` (o el archivo directamente ausente, 404) caen
    en aviso; cualquier otro error HTTP o un JSON fresco vencido sí fallan."""
    try:
        status, _headers, body = get(f"{base}/{archivo}")
    except urllib.error.HTTPError as e:
        # urllib lanza HTTPError ANTES de que podamos mirar status: el 404
        # (capa aún sin datos: satélite sin instalar o API key pendiente)
        # debe caer en aviso, no en falla.
        if e.code == 404:
            print(f"AVISO {archivo}: no existe todavía (fuente externa pendiente) — no bloquea el deploy")
        else:
            falla(f"GET /{archivo} -> status {e.code} (esperado 200)")
        return
    except Exception as e:
        falla(f"GET /{archivo} -> excepción: {e}")
        return
    if status == 404:
        print(f"AVISO {archivo}: no existe todavía (fuente externa pendiente) — no bloquea el deploy")
        return
    if status != 200:
        falla(f"GET /{archivo} -> status {status} (esperado 200)")
        return
    try:
        data = json.loads(body)
        updated = datetime.strptime(data["updated"], "%Y-%m-%d %H:%M UTC").replace(tzinfo=timezone.utc)
    except Exception as e:
        falla(f"/{archivo}: no se pudo parsear el campo 'updated' ({e})")
        return
    edad = datetime.now(timezone.utc) - updated
    if edad > maximo:
        if data.get("stale"):
            print(f"AVISO {archivo}: stale (satélite sin refrescar) hace {edad} (máximo {maximo}) — no bloquea el deploy")
        else:
            falla(f"/{archivo}: 'updated' tiene {edad} de antigüedad (máximo {maximo})")
    else:
        ok(f"/{archivo}: actualizado hace {edad} (máximo {maximo})")


def check_emergencia(base, n_index):
    try:
        status, _headers, body = get(base + "/emergencia.html")
    except Exception as e:
        falla(f"GET /emergencia.html -> excepción: {e}")
        return
    if status != 200:
        falla(f"GET /emergencia.html -> status {status} (esperado 200)")
        return
    ok("GET /emergencia.html -> 200")

    texto = body.decode("utf-8", errors="replace")
    m_css = re.search(r"app\.css\?v=(\d+)", texto)
    if not m_css:
        falla("no se encontró app.css?v=N en emergencia.html")
    elif n_index and m_css.group(1) != n_index:
        falla(f"emergencia.html usa app.css?v={m_css.group(1)} pero index.html usa v={n_index} — desincronizados")
    else:
        ok(f"emergencia.html: app.css comparte versión v={m_css.group(1)} con index.html")


def main():
    base = (sys.argv[1] if len(sys.argv) > 1 else "https://vigia.cavara.cl").rstrip("/")
    print(f"Smoke test contra {base}\n")

    n_index = None
    headers = None
    try:
        status, headers, body = get(base + "/")
    except Exception as e:
        falla(f"GET / -> excepción: {e}")
    else:
        if status != 200:
            falla(f"GET / -> status {status} (esperado 200)")
        else:
            ok("GET / -> 200")

        texto = body.decode("utf-8", errors="replace")
        m_js = re.search(r"app\.js\?v=(\d+)", texto)
        m_css = re.search(r"app\.css\?v=(\d+)", texto)
        if not m_js or not m_css:
            falla("no se encontró app.js?v=N o app.css?v=N en index.html")
        else:
            n_js, n_css = m_js.group(1), m_css.group(1)
            if n_js != n_css:
                falla(f"versiones desincronizadas en index.html: app.js?v={n_js} vs app.css?v={n_css}")
            else:
                n_index = n_js
                ok(f"index.html: app.js y app.css comparten versión v={n_index}")

    check_headers(headers)
    check_sw(base, n_index)
    check_json_fresco(base, "estaciones.json", timedelta(hours=4))
    check_json_fresco(base, "sismos.json", timedelta(hours=2))
    check_json_fresco_laxo(base, "cortes.json", timedelta(hours=24))
    check_json_fresco_laxo(base, "farmacias.json", timedelta(hours=26))
    check_json_fresco_laxo(base, "esval.json", timedelta(hours=24))
    check_json_fresco_laxo(base, "combustible.json", timedelta(hours=26))
    check_json_fresco_laxo(base, "crecidas.json", timedelta(hours=26))
    check_emergencia(base, n_index)

    print()
    if fallas:
        print(f"DEPLOY CON FALLAS EN SMOKE TEST ({len(fallas)} problema(s)):")
        for f in fallas:
            print(f" - {f}")
        sys.exit(1)

    print("Todos los checks pasaron.")
    sys.exit(0)


if __name__ == "__main__":
    main()
