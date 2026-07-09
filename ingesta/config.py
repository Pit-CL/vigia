"""Configuración de la ingesta de Sinóptica.

Todo punto de archivo de pronóstico ES una estación con observaciones:
calibrar donde no hay ground truth no aporta ciencia.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("CLIMA_DB", ROOT / "data" / "clima.db"))
STATUS_PATH = Path(os.environ.get("CLIMA_STATUS", ROOT / "web" / "status.json"))
VERIF_PATH = Path(os.environ.get("CLIMA_VERIF", ROOT / "web" / "verificacion.json"))
ESTACIONES_PATH = Path(os.environ.get("CLIMA_ESTACIONES", ROOT / "web" / "estaciones.json"))
AIRE_PATH = Path(os.environ.get("CLIMA_AIRE", ROOT / "web" / "aire.json"))
BIAS_PATH = Path(os.environ.get("CLIMA_BIAS", ROOT / "web" / "bias.json"))

# ── Estaciones: red curada nacional (ver stations_cl.py) ────────
from stations_cl import STATIONS

# Variables continuas calibrables (sesgo aditivo). Excluidas a propósito:
# precipitation (resta da negativos), wind_direction_10m (circular, grados),
# cloud_cover (categórica acotada, pocos pares de obs).
CALIBRABLE_VARS = ["temperature_2m", "dew_point_2m", "pressure_msl",
                   "relative_humidity_2m", "wind_speed_10m"]

# ── Pronósticos a archivar (en las coordenadas de las estaciones) ──
MODELS = [
    "ecmwf_ifs025",
    "gfs_seamless",
    "icon_seamless",
    "gem_seamless",
    "meteofrance_seamless",
]

HOURLY_VARS = [
    "temperature_2m",
    "relative_humidity_2m",
    "dew_point_2m",
    "precipitation",
    "wind_speed_10m",
    "wind_direction_10m",
    "cloud_cover",
    "pressure_msl",
]

HORIZON_HOURS = 96          # 4 días: el rango útil para calibración
ENSEMBLE_MODEL = "ecmwf_ifs025"
ENSEMBLE_VARS = ["temperature_2m"]

API_FORECAST = "https://api.open-meteo.com/v1/forecast"
API_ENSEMBLE = "https://ensemble-api.open-meteo.com/v1/ensemble"
API_METAR = "https://aviationweather.gov/api/data/metar"

# ── DMC (credenciales del registro gratuito; nunca en git) ──────
DMC_USUARIO = os.environ.get("DMC_USUARIO", "")
DMC_TOKEN = os.environ.get("DMC_TOKEN", "")
API_DMC = "https://climatologia.meteochile.gob.cl/application/servicios/getDatosRecientesEma"

# ── Peligros naturales ──────────────────────────────────────────
SISMOS_PATH = Path(os.environ.get("CLIMA_SISMOS", ROOT / "web" / "sismos.json"))
API_SISMOS_CSN = "https://api.xor.cl/sismo/recent"
API_SISMOS_USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"
CHILE_BBOX = (-76.0, -56.5, -66.0, -17.0)   # O, S, E, N (continental)
