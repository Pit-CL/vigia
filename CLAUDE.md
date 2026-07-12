# CLAUDE.md — Vigía

Reglas vinculantes para trabajar este repo. Contexto: `README.md` (arquitectura), `docs/DEPLOY.md` (producción), `docs/CALIBRACION.md` (calibración).

## Reglas duras

1. **Solo librería estándar de Python — cero dependencias.** La ingesta usa `urllib` + `sqlite3`; no hay `requirements.txt` y así debe seguir. NO agregues instalaciones pip (tampoco scipy: EMOS se implementa a mano, ver `docs/CALIBRACION.md`). Única excepción: el contenedor `push/` usa `pywebpush` (criptografía VAPID/aes128gcm imposible en stdlib); ningún otro componente puede agregar dependencias.
2. **Cache-busting obligatorio.** Si tocas `web/app.js` **o** `web/app.css`, sube el sufijo `?v=N` de **AMBOS** (comparten el mismo número aunque solo hayas tocado uno — el smoke test y `deploy.sh` exigen `app.js?v=N == app.css?v=N`) en `web/index.html` **y** en el array SHELL de `web/sw.js`, además de la versión del cache (`vigia-shell-vN`, contador independiente del ?v=N). Sin ese bump triple, Cloudflare y el service worker siguen sirviendo la versión anterior — y el deploy corta.
3. **CSP estricta** (`deploy/nginx.conf`): cualquier host o API nueva debe agregarse a `connect-src`/`img-src` o el navegador la bloquea. Nada de CDNs de terceros — Chart.js, Leaflet y las fuentes van vendorizados en `web/`.
4. **Los JSON de `web/` son generados, no editarlos a mano** (`status`, `verificacion`, `estaciones`, `aire`, `bias`, `avisos`, `sismos`, `incendios`, `alertas`, `volcanes`, `emergencia`, `remociones`, `tsunami_vias`, `tsunami_areas`, `marea`, `tsunami`, `cortes`, `farmacias`, `combustible` — diecinueve en total). Los produce la ingesta: en dev se escriben en `web/` (defaults de `ingesta/config.py`); en prod van a `/data` (envs del compose) y nginx los sirve por `alias`. Excepción: `web/comunas.json` (catastro INE de comunas) está versionado en el repo, no lo genera la ingesta. `cortes.json` y `farmacias.json` son casos especiales: la ingesta no fetchea la red, lee un crudo subido por un satélite fuera del VPS (ver `satelite/README.md`). `combustible.json` queda dormido (0 estaciones) hasta registrar `CNE_EMAIL`/`CNE_PASSWORD`.
5. **Calibración con disciplina científica** (`ingesta/calibrate.py`): nunca aplicar bias sin gate de muestra mínima + shrinkage; nunca corregir `precipitation` ni `wind_direction`; ground truth = observaciones de estación (METAR/DMC), nunca reanálisis; descartar `lead <= 0` en verificación (es nowcast, infla la exactitud). Validación temporal (walk-forward), jamás k-fold aleatorio.
6. **Todo punto del archivo histórico ES una estación con observaciones** (invariante de `ingesta/config.py`) — no agregues puntos de pronóstico sin observación pareada.

## Comandos

```bash
python3 ingesta/run.py --all         # corrida completa local (obs + pronósticos + verificación + calibración)
python3 ingesta/run.py --hazards     # sismos + incendios + alertas + volcanes + tsunami + cortes
python3 ingesta/run.py --emergencia  # infraestructura de emergencia (semanal)
python3 -m http.server 8123 -d web   # frontend local
docker compose up -d                 # prod: nginx + contenedor cron de ingesta
```

No hay suite de tests: la validación es empírica — verificación MAE/RMSE/bias contra observaciones y holdout temporal en `ingesta/bootstrap_hist.py`.
