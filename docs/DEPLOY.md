# Despliegue y operación

Vigía corre con tres contenedores (ver [`docker-compose.yml`](../docker-compose.yml)):

- **`web`** — nginx Alpine sirviendo `web/` como sitio estático, endurecido, escuchando solo en `127.0.0.1`.
- **`ingesta`** — Python + cron que archiva datos en `data/clima.db` y publica los 15 JSON que lee la PWA.
- **`push`** — servidor de suscripciones (`server.py`, foreground) + cron de envío (`send.py`, cada 5 min) para las notificaciones Web Push de emergencias mayores. Es la única dependencia externa del proyecto (`pywebpush`); todo lo demás es librería estándar de Python.

## Puesta en marcha

```bash
git clone <repo> && cd clima
cp .env.example .env        # opcional: DMC, FIRMS; obligatorio si vas a usar push
docker compose run --rm push python3 /app/push/genkeys.py   # solo la primera vez
# copia las dos líneas VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY que imprime al .env
docker compose up -d
```

Eso deja el sitio en `http://127.0.0.1:8100`. La ingesta corre su primer ciclo en el siguiente tick de cron; para forzarlo:

```bash
docker compose exec ingesta python3 /app/ingesta/run.py --all
```

Si no vas a usar notificaciones Web Push, `VAPID_PRIVATE_KEY` igual debe existir en `.env` (el compose lo exige con `:?`) — basta con generarlo una vez como arriba; el contenedor `push` puede quedar recibiendo suscripciones sin que nadie las use.

## Exposición segura (Cloudflare Tunnel)

El sitio se publica **sin abrir puertos** al exterior, vía [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). En la configuración del túnel se enruta el hostname al servicio local:

```yaml
ingress:
  - hostname: clima.tu-dominio.cl
    service: http://localhost:8100
```

Cloudflare aporta el TLS y la CDN del borde; el origen nunca queda expuesto directamente a internet.

## Seguridad

- nginx **solo** en `127.0.0.1` — el único camino de entrada es el túnel.
- Imágenes con versión fija, `no-new-privileges`, código montado en **solo lectura**; la ingesta no expone puertos y solo escribe en `data/`.
- **CSP estricta** sin `unsafe-inline`: Chart.js, Leaflet y las fuentes están vendorizados (sin CDNs de terceros). Solo se permiten los tiles del mapa y las APIs de Open-Meteo.
- Secretos (token DMC, `FIRMS_MAP_KEY`, claves VAPID) solo en `.env`, con permisos `600`, **nunca** en el repo.

## Ciclo de ingesta

| Tarea | Frecuencia | Qué archiva |
|---|---|---|
| Observaciones + calidad del aire | cada hora | METAR (NOAA) + DMC → `estaciones.json`, SINCA → `aire.json` |
| Pronósticos | 2 veces al día | 6 modelos deterministas + ensamble (51 miembros) |
| Verificación + calibración | con cada corrida de observaciones/pronósticos | recomputa `verificacion.json` y recalcula bias → `bias.json` |
| Avisos meteorológicos propios | con cada corrida (sin red, barato) | mediana multi-modelo → `avisos.json` |
| Sismos (CSN + USGS) + estado de tsunami (PTWC) | cada 10 min | `sismos.json`, `tsunami.json` |
| Incendios (NASA FIRMS) + alertas (SENAPRED) | cada hora | `incendios.json`, `alertas.json` |
| Volcanes (RNVV SERNAGEOMIN) | 2 veces al día | `volcanes.json` |
| Marea, oleaje y temperatura del mar (Open-Meteo Marine) | 4 veces al día | `marea.json` |
| Infraestructura de emergencia (Chile Preparado) | 1 vez por semana (cuasi-estática) | `emergencia.json`, `tsunami_vias.json`, `tsunami_areas.json` |
| Envío de Web Push (contenedor `push`) | cada 5 min | notifica sismos/alertas/volcanes/tsunami nuevos a los suscriptores |

Definición en [`deploy/crontab`](../deploy/crontab) y [`push/crontab`](../push/crontab).

## Actualizar

Sube los archivos al servidor y reinicia el contenedor web:

```bash
rsync -a --delete \
  --exclude data/ --exclude .git/ --exclude .env \
  --exclude 'web/status.json' --exclude 'web/verificacion.json' --exclude 'web/estaciones.json' \
  --exclude 'web/aire.json' --exclude 'web/bias.json' --exclude 'web/avisos.json' \
  --exclude 'web/sismos.json' --exclude 'web/incendios.json' --exclude 'web/alertas.json' \
  --exclude 'web/volcanes.json' --exclude 'web/emergencia.json' \
  --exclude 'web/tsunami_vias.json' --exclude 'web/tsunami_areas.json' \
  --exclude 'web/marea.json' --exclude 'web/tsunami.json' \
  ./ servidor:/ruta/clima/
docker compose restart web
```

> **Importante:** si cambiaste `app.js` o `app.css`, sube el sufijo `?v=N` en `index.html` (y en `sw.js`). Cloudflare cachea JS/CSS por extensión; sin el bump seguiría sirviendo la versión anterior. Los JSON de datos y `sw.js` se sirven con `no-cache` para evitar justamente eso.

> Los quince JSON de arriba se excluyen porque son **generados**: en dev la ingesta los escribe en `web/` (defaults de `ingesta/config.py`); en prod van a `/data` (envs del compose) y nginx los sirve por `alias`. Antes de correr el `rsync --delete`, verifica que la ruta de destino sea la correcta — `--delete` borra en el servidor cualquier archivo que no exista en el origen.

## Verificar estado

```bash
# últimas corridas de ingesta
docker compose exec ingesta python3 -c "import sqlite3; \
  [print(r) for r in sqlite3.connect('/data/clima.db').execute( \
  'SELECT run_at,kind,ok,rows FROM ingest_log ORDER BY rowid DESC LIMIT 8')]"

# tamaño del archivo histórico
docker compose exec ingesta sh -c 'du -h /data/clima.db'
```

El footer de la propia app muestra en vivo cuántos pronósticos y observaciones lleva acumulados el archivo.
