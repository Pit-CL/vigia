# Satélite omen — fuentes que bloquean IPs de datacenter

SEC (cortes de luz) y MINSAL (farmacias de turno) responden solo desde IPs
residenciales chilenas: fallan desde el VPS (Hostinger, datacenter) y
funcionan desde `omen` (verificado). Este directorio corre **en omen**, no
en el VPS — sube JSON crudos al VPS, que los procesa (`ingesta/cortes.py`,
`ingesta/farmacias.py`).

## Instalar en omen

1. Copiar el script (no hace falta el resto del repo, es stdlib puro):
   ```
   scp satelite/fetch_cl.py omen:~/vigia-satelite/fetch_cl.py
   ```
2. Editar `SSH_DEST` en `fetch_cl.py` con la IP pública real del VPS
   (`vigia.cavara.cl` NO sirve: solo resuelve al Cloudflare Tunnel, sin SSH).
3. Generar una clave ssh dedicada (sin passphrase, para cron) y restringirla
   en el VPS a solo `scp` sobre `data/incoming/`:
   ```
   ssh-keygen -t ed25519 -f ~/.ssh/vigia_satelite -N ""
   ```
   En el VPS, agregar la pública a `~vigia/.ssh/authorized_keys` con
   `command=` restringido (solo permite `scp -t` hacia `incoming/`, bloquea
   cualquier otro comando):
   ```
   command="scp -t /opt/vigia/data/incoming/",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... vigia-satelite
   ```
4. Confirmar que `/opt/vigia/data/incoming/` existe en el VPS y es escribible
   por el usuario `vigia` (uid del contenedor `ingesta`, ver
   `docker-compose.yml` — el volumen `./data:/data` hereda el uid del host).
5. Crontab en omen (`crontab -e`):
   ```
   */15 * * * * ssh-agent bash -c 'ssh-add ~/.ssh/vigia_satelite 2>/dev/null; python3 ~/vigia-satelite/fetch_cl.py' >> ~/vigia-satelite.log 2>&1
   ```
   MINSAL (farmacias) solo se usa 1x/día en la ingesta, pero viajar junto con
   SEC cada 15 min no cuesta nada (una fila de cron, un solo script).

## Degradación aceptada

Si omen cae, `incoming/sec.json` y `incoming/farmacias_raw.json` dejan de
refrescarse: `ingesta/cortes.py` y `ingesta/farmacias.py` detectan que el
crudo tiene más de 30 min y conservan el JSON publicado previo marcándolo
`"stale": true`. El resto de Vigía no se afecta.
