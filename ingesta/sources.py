"""Fetchers: Open-Meteo (pronósticos), METAR/NOAA y DMC (observaciones)."""
import json
import math
import time
import urllib.parse
import urllib.request

import config

UA = "sinoptica-ingesta/1.0 (proyecto open source; clima.cavara.cl)"


def http_get_json(url: str, params: dict | None = None, retries: int = 2):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as res:
                return json.loads(res.read().decode("utf-8")), url
        except Exception as err:  # red o JSON inválido: reintentar con pausa
            last_err = err
            if attempt < retries:
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"GET {url} falló tras {retries + 1} intentos: {last_err}")


# ── Open-Meteo: pronósticos deterministas multi-modelo ──────────

def ingest_openmeteo_det(con, run_tag: str) -> int:
    rows = []
    for st in config.STATIONS:
        data, _ = http_get_json(config.API_FORECAST, {
            "latitude": f"{st['lat']:.4f}",
            "longitude": f"{st['lon']:.4f}",
            "hourly": ",".join(config.HOURLY_VARS),
            "models": ",".join(config.MODELS),
            "forecast_days": math.ceil(config.HORIZON_HOURS / 24),
            "timezone": "UTC",
        })
        hourly = data.get("hourly", {})
        times = hourly.get("time", [])[: config.HORIZON_HOURS]
        for var in config.HOURLY_VARS:
            for model in config.MODELS:
                series = hourly.get(f"{var}_{model}")
                if series is None:
                    continue
                for t, v in zip(times, series):
                    rows.append((st["icao"], model, run_tag, t, var, -1, v))
    con.executemany(
        "INSERT INTO forecasts(station, model, run_tag, valid_time, variable, member, value)"
        " VALUES (?,?,?,?,?,?,?)", rows)
    con.commit()
    return len(rows)


# ── Open-Meteo: ensamble ECMWF (51 miembros) ────────────────────

def ingest_openmeteo_ens(con, run_tag: str) -> int:
    rows = []
    for st in config.STATIONS:
        data, _ = http_get_json(config.API_ENSEMBLE, {
            "latitude": f"{st['lat']:.4f}",
            "longitude": f"{st['lon']:.4f}",
            "hourly": ",".join(config.ENSEMBLE_VARS),
            "models": config.ENSEMBLE_MODEL,
            "forecast_days": math.ceil(config.HORIZON_HOURS / 24),
            "timezone": "UTC",
        })
        hourly = data.get("hourly", {})
        times = hourly.get("time", [])[: config.HORIZON_HOURS]
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
                    rows.append((st["icao"], config.ENSEMBLE_MODEL, run_tag, t, var, member, v))
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
    icaos = ",".join(s["icao"] for s in config.STATIONS)
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
    con.executemany(
        "INSERT INTO observations(station, obs_time, variable, value, source) VALUES (?,?,?,?,?)",
        rows)
    con.commit()
    return len(rows)


# ── DMC: archivo crudo hasta tener credenciales y parser ────────

def ingest_dmc(con, fetched_at: str) -> int:
    if not (config.DMC_USUARIO and config.DMC_TOKEN and config.DMC_STATIONS):
        return 0
    count = 0
    for code in config.DMC_STATIONS:
        data, url = http_get_json(
            f"{config.API_DMC}/{code}",
            {"usuario": config.DMC_USUARIO, "token": config.DMC_TOKEN},
        )
        con.execute(
            "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
            (fetched_at, "dmc", url.split("?")[0], json.dumps(data, ensure_ascii=False)),
        )
        count += 1
    con.commit()
    return count
