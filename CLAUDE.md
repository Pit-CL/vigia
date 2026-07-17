# CLAUDE.md — Vigía

Reglas vinculantes para trabajar este repo. Contexto: `README.md` (arquitectura), `docs/DEPLOY.md` (producción), `docs/CALIBRACION.md` (calibración).

## Reglas duras

1. **Solo librería estándar de Python — cero dependencias.** La ingesta usa `urllib` + `sqlite3`; no hay `requirements.txt` y así debe seguir. NO agregues instalaciones pip (tampoco scipy: EMOS se implementa a mano, ver `docs/CALIBRACION.md`). Única excepción: el contenedor `push/` usa `pywebpush` (criptografía VAPID/aes128gcm imposible en stdlib); ningún otro componente puede agregar dependencias.
2. **Cache-busting obligatorio.** Si tocas `web/app.js` **o** `web/app.css`, sube el sufijo `?v=N` de **AMBOS** (comparten el mismo número aunque solo hayas tocado uno — el smoke test y `deploy.sh` exigen `app.js?v=N == app.css?v=N`) en `web/index.html` **y** en el array SHELL de `web/sw.js`, además de la versión del cache (`vigia-shell-vN`, contador independiente del ?v=N). Sin ese bump triple, Cloudflare y el service worker siguen sirviendo la versión anterior — y el deploy corta.
3. **CSP estricta** (`deploy/nginx.conf`): cualquier host o API nueva debe agregarse a `connect-src`/`img-src` o el navegador la bloquea. Nada de CDNs de terceros — Chart.js, Leaflet y las fuentes van vendorizados en `web/`.
4. **Los JSON de `web/` son generados, no editarlos a mano** (`status`, `verificacion`, `estaciones`, `aire`, `bias`, `avisos`, `sismos`, `incendios`, `alertas`, `volcanes`, `emergencia`, `remociones`, `tsunami_vias`, `tsunami_areas`, `marea`, `tsunami`, `cortes`, `farmacias`, `combustible`, `crecidas` — veinte en total). Los produce la ingesta: en dev se escriben en `web/` (defaults de `ingesta/config.py`); en prod van a `/data` (envs del compose) y nginx los sirve por `alias`. Excepción: `web/comunas.json` (catastro INE de comunas) está versionado en el repo, no lo genera la ingesta. `cortes.json` y `farmacias.json` son casos especiales: la ingesta no fetchea la red, lee un crudo subido por un satélite fuera del VPS (ver `satelite/README.md`). `combustible.json` está activo en producción con credenciales `CNE_EMAIL`/`CNE_PASSWORD` configuradas por env; queda dormido (0 estaciones) solo si faltan.
5. **Calibración con disciplina científica** (`ingesta/calibrate.py`): nunca aplicar bias sin gate de muestra mínima + shrinkage; nunca corregir `precipitation` ni `wind_direction`; ground truth = observaciones de estación (METAR/DMC), nunca reanálisis; descartar `lead <= 0` en verificación (es nowcast, infla la exactitud). Validación temporal (walk-forward), jamás k-fold aleatorio.
6. **Todo punto del archivo histórico ES una estación con observaciones** (invariante de `ingesta/config.py`) — no agregues puntos de pronóstico sin observación pareada.
7. **Cero secretos en el repo, en logs y en errores — el repo es PÚBLICO.** Nunca commitear credenciales, API keys, tokens, ni el usuario/IP de origen del VPS (el Cloudflare Tunnel existe para ocultarla; ya se filtró una vez y quedó en el historial). Los secretos van SOLO al `.env` de prod (chmod 600) y se leen por env. En código: un mensaje de error o `raw_payloads` jamás puede contener la URL con key/token (urllib incluye la URL completa en sus excepciones — descartar la query string antes de propagar), el enmascarado por `str.replace` de la key cruda NO sirve (urlencode la percent-codifica), y toda credencial viaja solo por https. Antes de commitear código que use un secreto: `git diff | grep -i "<fragmentos del secreto>"` debe dar vacío.
8. **Todo dato mostrado lleva su fecha visible.** Cada JSON generado incluye `"updated"` y cada capa/panel del frontend muestra "actualizado hace X" (helper `metaConFecha` en `app.js`); si la fuente entrega fecha por ítem (ej. precios CNE), se conserva y se muestra por ítem, con marca de "dato antiguo" cuando corresponde. Si el dato depende del satélite y está viejo, el JSON lleva `"stale": true` y la UI lo dice explícito. Honestidad de frescura = requisito, no adorno.
9. **Deploy SOLO con `bash deploy/deploy.sh`** — valida el export (versiones js/css sincronizadas) ANTES de copiar y corre los smoke tests después. Prohibido rsync/copy manual a `/opt/vigia` o reiniciar contenedores a mano como método de deploy.

## Comandos

```bash
python3 ingesta/run.py --all         # corrida completa local (obs + pronósticos + verificación + calibración)
python3 ingesta/run.py --hazards     # sismos + incendios + alertas + volcanes + tsunami + cortes
python3 ingesta/run.py --emergencia  # infraestructura de emergencia (semanal)
python3 -m http.server 8123 -d web   # frontend local
docker compose up -d                 # prod: nginx + contenedor cron de ingesta
```

No hay suite de tests: la validación es empírica — verificación MAE/RMSE/bias contra observaciones y holdout temporal en `ingesta/bootstrap_hist.py`.
