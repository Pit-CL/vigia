"""Marea, oleaje y temperatura del mar en la costa chilena.

Fuente: Open-Meteo Marine (modelo global ~8 km), gratis y sin key. No es un
reemplazo de las tablas de marea oficiales del SHOA (shoa.cl) — marea.json lo
declara explícitamente para que nadie navegue con esto.

Sin tabla propia: como avisos.py, es barato de recalcular (un solo request
batch a 32 puntos), así que se publica entero en cada corrida.
"""
import json
from datetime import datetime, timezone

import config
import sources

API_MARINE = "https://marine-api.open-meteo.com/v1/marine"
HOURLY_VARS = [
    "sea_level_height_msl", "wave_height", "wave_direction",
    "wave_period", "sea_surface_temperature",
]
FORECAST_DAYS = 3
N_EXTREMOS = 4

# Puntos costeros curados norte a sur (continental + insular). Coordenadas
# aproximadas del borde costero; puerto_chacabuco y puerto_williams caían en
# celda terrestre del modelo (sea_level_height_msl siempre null) y se
# desplazaron al oeste hasta obtener datos reales (validado empíricamente).
COSTA = [
    {"id": "arica", "nombre": "Arica", "region": "Arica y Parinacota", "lat": -18.47, "lon": -70.34},
    {"id": "iquique", "nombre": "Iquique", "region": "Tarapacá", "lat": -20.21, "lon": -70.16},
    {"id": "tocopilla", "nombre": "Tocopilla", "region": "Antofagasta", "lat": -22.09, "lon": -70.22},
    {"id": "mejillones", "nombre": "Mejillones", "region": "Antofagasta", "lat": -23.10, "lon": -70.46},
    {"id": "antofagasta", "nombre": "Antofagasta", "region": "Antofagasta", "lat": -23.65, "lon": -70.42},
    {"id": "taltal", "nombre": "Taltal", "region": "Antofagasta", "lat": -25.40, "lon": -70.50},
    {"id": "chanaral", "nombre": "Chañaral", "region": "Atacama", "lat": -26.35, "lon": -70.65},
    {"id": "caldera", "nombre": "Caldera", "region": "Atacama", "lat": -27.07, "lon": -70.83},
    {"id": "huasco", "nombre": "Huasco", "region": "Atacama", "lat": -28.46, "lon": -71.24},
    {"id": "coquimbo", "nombre": "Coquimbo", "region": "Coquimbo", "lat": -29.95, "lon": -71.35},
    {"id": "los_vilos", "nombre": "Los Vilos", "region": "Coquimbo", "lat": -31.91, "lon": -71.52},
    {"id": "papudo", "nombre": "Papudo", "region": "Valparaíso", "lat": -32.51, "lon": -71.47},
    {"id": "quintero", "nombre": "Quintero", "region": "Valparaíso", "lat": -32.77, "lon": -71.53},
    {"id": "valparaiso", "nombre": "Valparaíso", "region": "Valparaíso", "lat": -33.02, "lon": -71.63},
    {"id": "san_antonio", "nombre": "San Antonio", "region": "Valparaíso", "lat": -33.58, "lon": -71.63},
    {"id": "pichilemu", "nombre": "Pichilemu", "region": "O'Higgins", "lat": -34.39, "lon": -72.02},
    {"id": "constitucion", "nombre": "Constitución", "region": "Maule", "lat": -35.33, "lon": -72.43},
    {"id": "talcahuano", "nombre": "Talcahuano", "region": "Biobío", "lat": -36.69, "lon": -73.11},
    {"id": "lebu", "nombre": "Lebu", "region": "Biobío", "lat": -37.61, "lon": -73.66},
    {"id": "puerto_saavedra", "nombre": "Puerto Saavedra", "region": "Araucanía", "lat": -38.79, "lon": -73.40},
    {"id": "corral", "nombre": "Corral", "region": "Los Ríos", "lat": -39.87, "lon": -73.43},
    {"id": "bahia_mansa", "nombre": "Bahía Mansa", "region": "Los Ríos", "lat": -40.57, "lon": -73.74},
    {"id": "puerto_montt", "nombre": "Puerto Montt", "region": "Los Lagos", "lat": -41.49, "lon": -72.96},
    {"id": "ancud", "nombre": "Ancud", "region": "Los Lagos", "lat": -41.85, "lon": -73.83},
    {"id": "castro", "nombre": "Castro", "region": "Los Lagos", "lat": -42.48, "lon": -73.76},
    {"id": "quellon", "nombre": "Quellón", "region": "Los Lagos", "lat": -43.12, "lon": -73.62},
    {"id": "chaiten", "nombre": "Chaitén", "region": "Los Lagos", "lat": -42.92, "lon": -72.71},
    {"id": "puerto_chacabuco", "nombre": "Puerto Chacabuco", "region": "Aysén", "lat": -45.46, "lon": -73.12},
    {"id": "punta_arenas", "nombre": "Punta Arenas", "region": "Magallanes", "lat": -53.17, "lon": -70.90},
    {"id": "puerto_williams", "nombre": "Puerto Williams", "region": "Magallanes", "lat": -54.93, "lon": -68.01},
    {"id": "hanga_roa", "nombre": "Hanga Roa (Rapa Nui)", "region": "Valparaíso", "lat": -27.15, "lon": -109.43},
    {"id": "bahia_cumberland", "nombre": "Bahía Cumberland (Juan Fernández)", "region": "Valparaíso", "lat": -33.64, "lon": -78.83},
]


def _dt(valid_time: str) -> datetime:
    return datetime.strptime(valid_time, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)


def _idx_ahora(times: list, ahora) -> int | None:
    """Índice de la hora horaria más cercana a ahora (puede ser antes o después)."""
    if not times:
        return None
    return min(range(len(times)), key=lambda i: abs((_dt(times[i]) - ahora).total_seconds()))


def _extremos(times: list, nivel: list, ahora) -> list:
    """Próximos N_EXTREMOS extremos locales (cambio de signo de la pendiente)
    de la serie horaria, a partir de ahora."""
    pares = [(t, v) for t, v in zip(times, nivel) if v is not None]
    # Colapsa mesetas de valores iguales consecutivos (el redondeo a 2
    # decimales del modelo deja tramos planos justo en los extremos reales;
    # sin esto, la desigualdad estricta se salta la meseta y pierde el
    # extremo, rompiendo la alternancia pleamar/bajamar).
    pares = [p for i, p in enumerate(pares) if i == 0 or p[1] != pares[i - 1][1]]
    extremos = []
    for i in range(1, len(pares) - 1):
        t, v = pares[i]
        v_prev, v_next = pares[i - 1][1], pares[i + 1][1]
        if v > v_prev and v > v_next:
            tipo = "pleamar"
        elif v < v_prev and v < v_next:
            tipo = "bajamar"
        else:
            continue
        if _dt(t) < ahora:
            continue
        extremos.append({"t": t + ":00Z", "tipo": tipo, "h": round(v, 2)})
        if len(extremos) == N_EXTREMOS:
            break
    return extremos


def _valor(hourly: dict, var: str, idx: int | None, decimales: int):
    if idx is None:
        return None
    serie = hourly.get(var) or []
    if idx >= len(serie) or serie[idx] is None:
        return None
    return round(serie[idx], decimales)


def _punto(st: dict, hourly: dict, ahora) -> dict:
    times = hourly.get("time") or []
    nivel_serie = hourly.get("sea_level_height_msl") or []
    idx = _idx_ahora(times, ahora)

    nivel = _valor(hourly, "sea_level_height_msl", idx, 2)
    tendencia = None
    if idx is not None and nivel is not None and idx + 1 < len(nivel_serie) and nivel_serie[idx + 1] is not None:
        tendencia = "subiendo" if nivel_serie[idx + 1] > nivel_serie[idx] else "bajando"

    direccion = _valor(hourly, "wave_direction", idx, 0)
    ola = {
        "altura": _valor(hourly, "wave_height", idx, 2),
        "direccion": int(direccion) if direccion is not None else None,
        "periodo": _valor(hourly, "wave_period", idx, 1),
    }

    return {
        "id": st["id"], "nombre": st["nombre"], "region": st["region"],
        "lat": st["lat"], "lon": st["lon"],
        "nivel": nivel, "tendencia": tendencia,
        "extremos": _extremos(times, nivel_serie, ahora),
        "ola": ola,
        "sst": _valor(hourly, "sea_surface_temperature", idx, 1),
    }


def update(con, fetched_at: str) -> int:
    ahora = datetime.now(timezone.utc)
    data, _ = sources.http_get_json(API_MARINE, {
        "latitude": ",".join(f"{p['lat']:.4f}" for p in COSTA),
        "longitude": ",".join(f"{p['lon']:.4f}" for p in COSTA),
        "hourly": ",".join(HOURLY_VARS),
        "timezone": "UTC",
        "forecast_days": FORECAST_DAYS,
    })
    results = data if isinstance(data, list) else [data]
    puntos = [_punto(st, res.get("hourly", {}), ahora) for st, res in zip(COSTA, results)]

    payload = {
        "updated": ahora.strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "Open-Meteo Marine (modelo global ~8 km)",
        "nota": "Marea de modelo global, no apta para navegación: las tablas oficiales son del SHOA (shoa.cl)",
        "puntos": puntos,
    }
    config.MAREA_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.MAREA_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(puntos)
