#!/usr/bin/env python3
"""Smoke test post-deploy con navegador real (Playwright). Requiere el
intérprete de un venv con playwright instalado — este script no lo asume,
quien lo invoca decide con qué intérprete correrlo (ver deploy/deploy.sh).

Uso:
    python3 deploy/smoke_browser.py [url_base]

Por defecto revisa https://vigia.cavara.cl. Sale con código 0 si todos los
checks pasan, 1 si alguno falla (imprime el detalle de cada FALLA).
"""
import json
import sys

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("FALLA no se encontró playwright — corre este script con un intérprete que lo tenga instalado")
    sys.exit(1)

fallas = []


def ok(msg):
    print(f"OK    {msg}")


def falla(msg):
    print(f"FALLA {msg}")
    fallas.append(msg)


def check_mapa_bajo_service_worker(page, base):
    page.goto(base + "/", wait_until="load")
    page.wait_for_timeout(3000)  # tiempo para que el SW tome control
    page.reload(wait_until="load")
    page.wait_for_timeout(2500)
    tiles = page.locator("img.leaflet-tile-loaded").count()
    if tiles > 0:
        ok(f"mapa con {tiles} tiles cargados tras recargar bajo service worker")
    else:
        falla("mapa en blanco tras recargar bajo service worker (0 tiles cargados)")


def check_capa_satelite(page):
    page.locator('.map-mode[data-capa="satelite"]').click()

    def hay_tile_gibs():
        for img in page.locator("img.leaflet-tile-loaded").all():
            src = img.get_attribute("src") or ""
            if "gibs" in src and img.evaluate("el => el.naturalWidth") > 0:
                return True
        return False

    def hay_tile_labels():
        for img in page.locator("img.leaflet-tile-loaded").all():
            src = img.get_attribute("src") or ""
            if "only_labels" in src and img.evaluate("el => el.naturalWidth") > 0:
                return True
        return False

    deadline_ms = 15000
    paso_ms = 500
    esperado = 0
    while esperado < deadline_ms:
        if hay_tile_gibs() and hay_tile_labels():
            break
        page.wait_for_timeout(paso_ms)
        esperado += paso_ms

    if hay_tile_gibs():
        ok("capa satelital: tiles GIBS cargados")
    else:
        falla("capa satelital: no cargó ningún tile GIBS en 15 s")

    if hay_tile_labels():
        ok("capa satelital: tiles de etiquetas (only_labels) cargados")
    else:
        falla("capa satelital: no cargó ningún tile only_labels en 15 s")


def check_punto_cercano(page):
    page.locator("#btn-punto-cercano").click()
    resultado = page.locator("#punto-cercano-resultado")
    try:
        page.wait_for_function(
            "el => el.textContent.toLowerCase().includes('punto de encuentro más cercano')",
            arg=resultado.element_handle(),
            timeout=8000,
        )
    except Exception:
        pass

    texto = resultado.text_content() or ""
    if "sin permiso" in texto.lower():
        falla(f"punto de encuentro: mostró 'Sin permiso' pese al permiso de geolocalización otorgado ({texto!r})")
    elif "punto de encuentro más cercano" in texto.lower():
        ok("punto de encuentro más cercano: resultado mostrado correctamente")
    else:
        falla(f"punto de encuentro: no mostró el resultado esperado en 8 s ({texto!r})")


def check_capas_restauradas(browser, base):
    # Incidente 2026-07-14 (PR #94): CAPAS.alertas.tieneData() leía comunasData,
    # variable declarada más abajo en web/app.js. La restauración de capas
    # guardadas en localStorage (sinoptica.capas) se evalúa apenas carga el
    # script, así que cualquier usuario con la capa 'alertas' activa disparaba
    # un ReferenceError (TDZ) fatal y la página quedaba en blanco. Un perfil
    # limpio (sin localStorage previo) nunca restaura capas y no lo detecta —
    # de ahí este check con perfil sembrado.
    #
    # Lista de capas: debe mantenerse en sync con el objeto CAPAS de
    # web/app.js. Se incluyen TODAS excepto que del grupo exclusivo
    # 'medicion' (temp/aire/precipitacion) solo puede quedar una activa.
    capas = [
        "temp",  # única capa de 'medicion' activa (grupo exclusivo)
        "sismos", "incendios", "alertas", "volcanes", "avisos", "remociones",
        "crecidas", "cortes", "combustible", "marea", "evacuacion",
        "farmacias", "emergencia", "satelite",
    ]

    context = browser.new_context()
    errores_pagina = []
    try:
        context.add_init_script(
            "localStorage.setItem('sinoptica.capas', " + json.dumps(json.dumps(capas)) + ");"
        )
        page = context.new_page()
        page.on("pageerror", lambda exc: errores_pagina.append(str(exc)))

        page.goto(base + "/", wait_until="load")
        page.wait_for_timeout(5000)

        if errores_pagina:
            falla(
                f"arranque con capas restauradas: {len(errores_pagina)} error(es) JS -> {errores_pagina}"
            )
        else:
            ok("arranque con capas restauradas: sin errores de JavaScript")

        temp_text = (page.locator("#now-temp").text_content() or "").strip()
        boton_activo = page.locator('.map-mode[data-capa="temp"]').get_attribute("aria-pressed")
        if temp_text not in ("", "—") or boton_activo == "true":
            ok("arranque con capas restauradas: señal de vida presente (#now-temp o botón de capa)")
        else:
            falla(
                f"arranque con capas restauradas: sin señal de vida "
                f"(#now-temp={temp_text!r}, aria-pressed={boton_activo!r})"
            )
    finally:
        context.close()


def main():
    base = (sys.argv[1] if len(sys.argv) > 1 else "https://vigia.cavara.cl").rstrip("/")
    print(f"Smoke test (navegador) contra {base}\n")

    errores_pagina = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            geolocation={"latitude": -33.45, "longitude": -70.66},
            permissions=["geolocation"],
        )
        page = context.new_page()
        page.on("pageerror", lambda exc: errores_pagina.append(str(exc)))

        try:
            check_mapa_bajo_service_worker(page, base)
        except Exception as e:
            falla(f"chequeo de mapa bajo service worker -> excepción: {e}")

        try:
            check_capa_satelite(page)
        except Exception as e:
            falla(f"chequeo de capa satelital -> excepción: {e}")

        try:
            check_punto_cercano(page)
        except Exception as e:
            falla(f"chequeo de punto de encuentro -> excepción: {e}")

        try:
            check_capas_restauradas(browser, base)
        except Exception as e:
            falla(f"chequeo de arranque con capas restauradas -> excepción: {e}")

        browser.close()

    if errores_pagina:
        falla(f"se registraron {len(errores_pagina)} error(es) de página: {errores_pagina}")
    else:
        ok("sin errores de JavaScript durante el test")

    print()
    if fallas:
        print(f"DEPLOY CON FALLAS EN SMOKE TEST — NAVEGADOR ({len(fallas)} problema(s)):")
        for f in fallas:
            print(f" - {f}")
        sys.exit(1)

    print("Todos los checks pasaron.")
    sys.exit(0)


if __name__ == "__main__":
    main()
