"""Fetchers: Open-Meteo (pronósticos), METAR/NOAA y DMC (observaciones)."""
import json
import math
import re
import time
import urllib.parse
import urllib.request

import config
import db

UA = "vigia-ingesta/1.0 (proyecto open source; vigia.cavara.cl)"


def _get(url: str, params: dict | None, retries: int, parse_json: bool):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as res:
                text = res.read().decode("utf-8")
                return (json.loads(text) if parse_json else text), url
        except urllib.error.HTTPError as err:  # 429: respeta Retry-After, si no hay, backoff exponencial
            last_err = err
            if attempt < retries:
                retry_after = err.headers.get("Retry-After") if err.code == 429 else None
                espera = float(retry_after) if retry_after and retry_after.isdigit() else min(60, 5 * 2 ** attempt)
                time.sleep(espera)
        except Exception as err:  # red o JSON inválido: reintentar con pausa
            last_err = err
            if attempt < retries:
                time.sleep(5 * (attempt + 1))
    # Sin query string en el mensaje: puede llevar credenciales (auth_key CNE)
    # y este error termina en ingest_log y en el log de la ingesta.
    url_sin_query = urllib.parse.urlsplit(url)._replace(query="").geturl()
    raise RuntimeError(f"GET {url_sin_query} falló tras {retries + 1} intentos: {last_err}")


def http_get_json(url: str, params: dict | None = None, retries: int = 2):
    return _get(url, params, retries, parse_json=True)


def http_get_text(url: str, params: dict | None = None, retries: int = 2) -> tuple[str, str]:
    """Calco de http_get_json pero sin parsear: para fuentes que devuelven CSV."""
    return _get(url, params, retries, parse_json=False)


# ── Open-Meteo: batching de coordenadas (hasta 50 por llamada) ──

def _om_chunks(stations, size=50):
    for i in range(0, len(stations), size):
        yield stations[i:i + size]


# Open-Meteo pondera cada llamada por (variables/10) × (días/14) × ubicaciones,
# con un mínimo de 1 por ubicación, y limita ~600 unidades/minuto (tier gratis).
# Medido empíricamente el 2026-07-13 contra la API real con los parámetros de
# producción (6 modelos × 10 variables horarias, forecast_days=4): 2 chunks de
# 50 estaciones seguidos (100 ubicaciones) agotan el cupo del minuto y el 3er
# chunk recibe 429 "Minutely API request limit exceeded" de inmediato. Un solo
# chunk de 50 sí cabe, así que 60 s de pausa entre chunks (reinicio del cupo
# por minuto) alcanza sin recortar variables/modelos/horizonte.
_OM_THROTTLE_S = 60


# ── Open-Meteo: pronósticos deterministas multi-modelo ──────────

def ingest_openmeteo_det(con, run_tag: str) -> int:
    rows = []
    for i, chunk in enumerate(_om_chunks(config.STATIONS)):
        if i > 0:
            time.sleep(_OM_THROTTLE_S)
        data, _ = http_get_json(config.API_FORECAST, {
            "latitude": ",".join(f"{s['lat']:.4f}" for s in chunk),
            "longitude": ",".join(f"{s['lon']:.4f}" for s in chunk),
            "hourly": ",".join(config.HOURLY_VARS),
            "models": ",".join(config.MODELS),
            "forecast_days": math.ceil(config.HORIZON_HOURS / 24),
            "timezone": "UTC",
        })
        results = data if isinstance(data, list) else [data]
        for st, res in zip(chunk, results):
            hourly = res.get("hourly", {})
            times = hourly.get("time", [])[: config.HORIZON_HOURS]
            for var in config.HOURLY_VARS:
                for model in config.MODELS:
                    series = hourly.get(f"{var}_{model}")
                    if series is None:
                        continue
                    for t, v in zip(times, series):
                        rows.append((st["id"], model, run_tag, t, var, -1, v))
    con.executemany(
        "INSERT INTO forecasts(station, model, run_tag, valid_time, variable, member, value)"
        " VALUES (?,?,?,?,?,?,?)", rows)
    con.commit()
    return len(rows)


# ── Open-Meteo: ensamble ECMWF (51 miembros) ────────────────────

def ingest_openmeteo_ens(con, run_tag: str) -> int:
    rows = []
    ens_stations = [s for s in config.STATIONS if s.get("ens")]
    # El límite de Open-Meteo es por IP, no por subdominio: si esta función corre
    # justo después de ingest_openmeteo_det (caso de producción), el cupo del
    # minuto ya viene consumido — se respeta la misma pausa antes del 1er chunk.
    for chunk in _om_chunks(ens_stations):
        time.sleep(_OM_THROTTLE_S)
        data, _ = http_get_json(config.API_ENSEMBLE, {
            "latitude": ",".join(f"{s['lat']:.4f}" for s in chunk),
            "longitude": ",".join(f"{s['lon']:.4f}" for s in chunk),
            "hourly": ",".join(config.ENSEMBLE_VARS),
            "models": config.ENSEMBLE_MODEL,
            "forecast_days": math.ceil(config.ENSEMBLE_HORIZON_HOURS / 24),
            "timezone": "UTC",
        })
        results = data if isinstance(data, list) else [data]
        for st, res in zip(chunk, results):
            hourly = res.get("hourly", {})
            times = hourly.get("time", [])[: config.ENSEMBLE_HORIZON_HOURS]
            for var in config.ENSEMBLE_VARS:
                for key, series in hourly.items():
                    if not key.startswith(var) or key == "time":
                        continue
                    # 'temperature_2m' = control (miembro 0); 'temperature_2m_memberNN'
                    suffix = key[len(var):]
                    if suffix == "":
                        member = 0
                    elif suffix.startswith("_member"):
                        member = int(suffix[len("_member"):])
                    else:
                        continue
                    for t, v in zip(times, series):
                        rows.append((st["id"], config.ENSEMBLE_MODEL, run_tag, t, var, member, v))
    con.executemany(
        "INSERT INTO forecasts(station, model, run_tag, valid_time, variable, member, value)"
        " VALUES (?,?,?,?,?,?,?)", rows)
    con.commit()
    return len(rows)


# ── METAR (NOAA AWC): observaciones oficiales de aeropuertos ────

_CLOUD_PCT = {"CLR": 0, "SKC": 0, "CAVOK": 0, "NSC": 0, "FEW": 19, "SCT": 44, "BKN": 75, "OVC": 100, "OVX": 100}


def _rh_from_dewpoint(t: float, td: float) -> float:
    """Humedad relativa por fórmula de Magnus (estándar OMM)."""
    gamma_t = (17.625 * t) / (243.04 + t)
    gamma_td = (17.625 * td) / (243.04 + td)
    return round(100.0 * math.exp(gamma_td - gamma_t), 1)


def ingest_metar(con, fetched_at: str) -> int:
    icaos = ",".join(s["id"] for s in config.STATIONS if s.get("metar"))
    data, url = http_get_json(config.API_METAR, {"ids": icaos, "format": "json", "hours": 3})
    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "metar", url, json.dumps(data, ensure_ascii=False)),
    )
    rows = []
    for ob in data:
        st = ob.get("icaoId")
        t_iso = (ob.get("reportTime") or "").replace(".000Z", "Z").replace(" ", "T")
        if not st or not t_iso:
            continue

        def num(x):
            return x if isinstance(x, (int, float)) else None

        temp, dewp = num(ob.get("temp")), num(ob.get("dewp"))
        pairs = [
            ("temperature_2m", temp),
            ("dew_point_2m", dewp),
            ("wind_direction_10m", num(ob.get("wdir"))),          # 'VRB' queda fuera
            ("wind_speed_10m", None if num(ob.get("wspd")) is None else round(ob["wspd"] * 1.852, 1)),
            ("pressure_msl", num(ob.get("altim"))),
            ("visibility", None if num(ob.get("visib")) is None else round(ob["visib"] * 1609.34)),
            ("cloud_cover", _CLOUD_PCT.get(ob.get("cover"))),
        ]
        if temp is not None and dewp is not None:
            pairs.append(("relative_humidity_2m", _rh_from_dewpoint(temp, dewp)))
        for var, val in pairs:
            if val is not None:
                rows.append((st, t_iso, var, val, "metar"))
        # Fenómeno presente observado (RA, DZ, TSRA, FG…): el tiempo REAL.
        wx = (ob.get("wxString") or "").strip()
        if wx:
            con.execute(
                "INSERT INTO obs_wx(station, obs_time, wx, updated) VALUES (?,?,?,?) "
                "ON CONFLICT(station) DO UPDATE SET obs_time=excluded.obs_time, "
                "wx=excluded.wx, updated=excluded.updated WHERE excluded.obs_time >= obs_wx.obs_time",
                (st, t_iso, wx, fetched_at))
    rows, descartadas = db.qc_filtrar_observaciones(rows)
    db.qc_reportar(descartadas)
    con.executemany(
        "INSERT INTO observations(station, obs_time, variable, value, source) VALUES (?,?,?,?,?)",
        rows)
    con.commit()
    return len(rows)


# ── DMC: estaciones EMA (API de climatología, registro gratuito) ──
# Valores como strings con unidad ("9.4 °C", "0.1 kt"); momento en UTC.
# Cada fetch trae 12 h minuto a minuto → guardamos solo instantes horarios
# (calibramos contra pronósticos horarios) y el cron horario backfillea
# cortes de hasta 12 h gracias al UNIQUE.

_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")

_DMC_FIELDS = [
    ("temperatura", "temperature_2m", 1.0),
    ("puntoDeRocio", "dew_point_2m", 1.0),
    ("humedadRelativa", "relative_humidity_2m", 1.0),
    ("presionNivelDelMar", "pressure_msl", 1.0),
    ("fuerzaDelVientoPromedio10Minutos", "wind_speed_10m", 1.852),   # kt → km/h (promedio 10 min, estándar OMM)
    ("direccionDelVientoPromedio10Minutos", "wind_direction_10m", 1.0),
]


def _dmc_num(raw):
    if raw is None:
        return None
    m = _NUM_RE.search(str(raw))
    return float(m.group()) if m else None


# ── SINCA: calidad del aire oficial (Ministerio del Medio Ambiente) ──
# JSON público con las estaciones de la red nacional. El valor crudo de cada
# fila viene con offset +10 (para evitar negativos); el tooltip trae la
# concentración real y el ICAP oficial (promedio móvil 24 h).

import html as _html

_SINCA_CONTAM = {"PM25": "pm2_5", "PM10": "pm10"}
_TIP_CONC = re.compile(r"<strong>\s*([\d.]+)")
_TIP_ICAP = re.compile(r"(\d+)\s*ICAP", re.I)


def _sinca_parse_medicion(m: dict):
    rows = (m.get("info") or {}).get("rows") or []
    # La última hora suele venir "no disponible" (aún sin validar); buscamos
    # hacia atrás la lectura más reciente con dato real.
    for row in reversed(rows):
        c = row.get("c") or []
        if len(c) < 4:
            continue
        tip = _html.unescape(str(c[3].get("v") or ""))
        if "no disponible" in tip.lower():
            continue
        conc = _TIP_CONC.search(tip)
        if not conc:
            continue
        icap = _TIP_ICAP.search(tip)
        return {
            "momento": c[0].get("v"),
            "valor": float(conc.group(1)),
            "icap": int(icap.group(1)) if icap else None,
        }
    return None


def ingest_sinca(con, fetched_at: str):
    """Archiva observaciones SINCA y devuelve la lista de estaciones de la red
    nacional con su última lectura de MP2,5/MP10 (para aire.json)."""
    data, _ = http_get_json("https://sinca.mma.gob.cl/index.php/json/listadomapa2k19/")
    rows, estaciones = [], []
    for st in data:
        region = (st.get("region") or "").strip()
        try:
            lat, lon = float(st["latitud"]), float(st["longitud"])
        except (KeyError, TypeError, ValueError):
            continue
        medidas = {}
        for m in st.get("realtime", []):
            var = _SINCA_CONTAM.get(m.get("code"))
            if not var:
                continue
            parsed = _sinca_parse_medicion(m)
            if not parsed:
                continue
            medidas[var] = parsed
            t = (parsed["momento"] or "").replace(" ", "T")
            if len(t) >= 16:
                rows.append((f"sinca:{st['key']}", t + ":00", var, parsed["valor"], "sinca"))
        if "pm2_5" in medidas or "pm10" in medidas:
            estaciones.append({
                "key": st["key"], "nombre": st.get("nombre"), "comuna": st.get("comuna"),
                "region": region, "lat": lat, "lon": lon,
                "pm2_5": medidas.get("pm2_5", {}).get("valor"),
                "pm10": medidas.get("pm10", {}).get("valor"),
                "icap": (medidas.get("pm2_5") or medidas.get("pm10") or {}).get("icap"),
                "momento": (medidas.get("pm2_5") or medidas.get("pm10") or {}).get("momento"),
            })
    con.executemany(
        "INSERT INTO observations(station, obs_time, variable, value, source) VALUES (?,?,?,?,?)",
        rows)
    con.commit()
    return rows, estaciones


# ── DMC: estaciones EMA (API de climatología, registro gratuito) ──

def ingest_dmc(con, fetched_at: str) -> int:
    if not (config.DMC_USUARIO and config.DMC_TOKEN):
        return 0
    rows, errores = [], []
    for st in [s for s in config.STATIONS if s.get("dmc")]:
        try:
            data, _ = http_get_json(
                f"{config.API_DMC}/{st['id']}",
                {"usuario": config.DMC_USUARIO, "token": config.DMC_TOKEN},
            )
        except RuntimeError as err:
            errores.append(f"{st['id']}: {err}")
            continue
        time.sleep(0.3)  # cortesía: no saturar la API de DMC (~124 estaciones/hora)
        registros = ((data.get("datosEstaciones") or {}).get("datos")) or []
        for reg in registros:
            momento = reg.get("momento") or ""        # "YYYY-MM-DD HH:MM:SS" UTC
            if len(momento) < 19 or momento[14:16] != "00":
                continue
            t_iso = momento.replace(" ", "T") + "Z"
            for src_key, var, factor in _DMC_FIELDS:
                val = _dmc_num(reg.get(src_key))
                if val is not None:
                    rows.append((st["id"], t_iso, var, round(val * factor, 2), "dmc"))
            # acumulado 6 h en horas sinópticas: ground truth de precipitación
            if momento[11:13] in ("00", "06", "12", "18"):
                val = _dmc_num(reg.get("aguaCaida6Horas"))
                if val is not None:
                    rows.append((st["id"], t_iso, "precipitation_6h", val, "dmc"))
    rows, descartadas = db.qc_filtrar_observaciones(rows)
    db.qc_reportar(descartadas)
    con.executemany(
        "INSERT INTO observations(station, obs_time, variable, value, source) VALUES (?,?,?,?,?)",
        rows)
    con.commit()
    if errores:
        msg = "; ".join(errores)
        if not rows:
            raise RuntimeError(f"todas las estaciones DMC fallaron: {msg}")
        print(f"[aviso] DMC parcial ({len(errores)} estaciones sin datos): {msg}")
    return len(rows)
