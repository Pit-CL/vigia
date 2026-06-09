# Sinóptica

Pronóstico del tiempo **multi-modelo y con incertidumbre honesta** para la V Región y la Región Metropolitana (Chile), con un archivo científico propio de pronósticos y observaciones que alimentará la calibración local (MOS/EMOS). Producción: **https://clima.cavara.cl**.

Visión completa, fuentes verificadas y fases del proyecto: [`PROPUESTA.md`](PROPUESTA.md).

## Estructura

```
web/        PWA estática (fase 0): multi-modelo + banda de ensamble ECMWF.
            Habla directo con Open-Meteo desde el navegador; sin backend.
ingesta/    Fase 1, Python 3.12 SOLO stdlib (urllib + sqlite3, cero deps).
            Archiva pronósticos (5 modelos + 51 miembros de ensamble) y
            observaciones (METAR oficial vía NOAA; DMC al tener token).
deploy/     nginx endurecido + crontab del contenedor de ingesta.
data/       SQLite local (no va a git). El activo científico del proyecto.
```

## Correr local

```bash
python3 ingesta/run.py --all        # un ciclo de ingesta completo
python3 -m http.server 8123 -d web  # servir la PWA → http://localhost:8123
```

## Producción (omen)

Vive en `/opt/clima`, servido por el Cloudflare Tunnel existente (`clima.cavara.cl → 127.0.0.1:8100`). Sin puertos abiertos al exterior ni a la LAN.

```bash
ssh omen
cd /opt/clima && sudo docker compose up -d     # web + cron de ingesta
sudo docker exec clima-ingesta python3 /app/ingesta/run.py --all  # ingesta manual
sqlite3 data/clima.db 'SELECT kind, ok, rows, run_at FROM ingest_log ORDER BY rowid DESC LIMIT 8'
```

Actualizar: `rsync` desde el Mac y `docker compose restart web` (la ingesta toma el código nuevo en el siguiente tick de cron). **Importante**: si cambiaste `app.js` o `app.css`, sube el `?v=N` en `index.html` — Cloudflare cachea js/css por extensión y sin el bump seguiría sirviendo la versión vieja:

```bash
rsync -av --delete --exclude data/ --exclude .git/ \
  ~/Documents/Recursos/Proyectos.nosync/clima/ omen:/opt/clima/
```

## Seguridad

- nginx solo en `127.0.0.1:8100`; el único camino público es el tunnel de Cloudflare.
- Contenedores con imágenes fijadas, `no-new-privileges`, mounts de código en solo lectura; la ingesta no tiene puertos y solo escribe en `/data`.
- CSP estricta sin `unsafe-inline` (Chart.js y fuentes vendorizadas, sin CDNs).
- Secretos (token DMC) solo vía `.env` en el servidor — nunca en git.

## Observaciones DMC (activas)

Credenciales en `/opt/clima/.env` (chmod 600, fuera de git): `DMC_USUARIO` + `DMC_TOKEN` del registro gratuito en https://climatologia.meteochile.gob.cl. La ingesta parsea 10 EMA de V/RM sin METAR cercano (Quinta Normal, Jardín Botánico, Quillota, San Felipe, Quintero, Colina, Talagante, La Florida, San José/Guayacán y Los Libertadores a 2.955 m): temperatura, rocío, humedad, presión QNH, viento promedio 10 min y precipitación acumulada 6 h en horas sinópticas. Cada fetch trae 12 h minuto a minuto; se guardan los instantes horarios y el `UNIQUE` deduplica/backfillea cortes.

## Fases

- [x] **Fase 0** — PWA multi-modelo con banda de ensamble.
- [x] **Fase 1** — Ingesta y archivo en SQLite (el cuello de botella es tiempo calendario: ya corre).
- [ ] **Fase 2** — Panel de verificación pública (MAE/CRPS por modelo y estación) cuando haya ~2 semanas de datos.
- [ ] **Fase 3** — Calibración: sesgo por estación → EMOS → ML cuantílico.
- [ ] **Fase 4** — Calidad del aire SINCA + UV + alertas.

Datos: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0) · observaciones METAR de la red OMM/[NOAA AWC](https://aviationweather.gov/) · [Dirección Meteorológica de Chile](https://www.meteochile.gob.cl/). Proyecto open source sin fines comerciales.
