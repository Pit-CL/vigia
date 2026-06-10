# Despliegue y operación

Sinóptica corre con dos contenedores (ver [`docker-compose.yml`](../docker-compose.yml)):

- **`web`** — nginx Alpine sirviendo `web/` como sitio estático, endurecido, escuchando solo en `127.0.0.1`.
- **`ingesta`** — Python + cron que archiva datos en `data/clima.db` y publica los JSON que lee la PWA.

## Puesta en marcha

```bash
git clone <repo> && cd clima
cp .env.example .env        # opcional: añade tu token de la DMC
docker compose up -d
```

Eso deja el sitio en `http://127.0.0.1:8100`. La ingesta corre su primer ciclo en el siguiente tick de cron; para forzarlo:

```bash
docker compose exec ingesta python3 /app/ingesta/run.py --all
```

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
- Secretos (token DMC) solo en `.env`, con permisos `600`, **nunca** en el repo.

## Ciclo de ingesta

| Tarea | Frecuencia | Qué archiva |
|---|---|---|
| Observaciones | cada hora | METAR (NOAA) + estaciones DMC |
| Pronósticos | cada 6 h | 5 modelos deterministas + ensamble (51 miembros) |
| Verificación + estaciones | cada corrida | recomputa `verificacion.json` y `estaciones.json` |

Definición en [`deploy/crontab`](../deploy/crontab).

## Actualizar

Sube los archivos al servidor y reinicia el contenedor web:

```bash
rsync -a --delete \
  --exclude data/ --exclude .git/ --exclude .env \
  --exclude 'web/status.json' --exclude 'web/verificacion.json' --exclude 'web/estaciones.json' \
  ./ servidor:/ruta/clima/
docker compose restart web
```

> **Importante:** si cambiaste `app.js` o `app.css`, sube el sufijo `?v=N` en `index.html` (y en `sw.js`). Cloudflare cachea JS/CSS por extensión; sin el bump seguiría sirviendo la versión anterior. Los JSON de datos y `sw.js` se sirven con `no-cache` para evitar justamente eso.

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
