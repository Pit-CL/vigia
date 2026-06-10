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

# ── Estaciones (V Región + RM) ──────────────────────────────────
# id: ICAO si la observación llega por METAR (NOAA AWC, sin clave),
#     código nacional DMC si llega por la API de climatología (EMA).
# En TODAS se archivan pronósticos (det + ensamble) para calibración.
STATIONS = [
    # METAR — aeropuertos (observaciones oficiales vía red WMO). alt en metros.
    {"id": "SCEL", "metar": True, "nombre": "Santiago · Pudahuel (A. Merino Benítez)", "lat": -33.393, "lon": -70.785, "alt": 476},
    {"id": "SCTB", "metar": True, "nombre": "Santiago · Tobalaba (E. Sánchez)",        "lat": -33.456, "lon": -70.547, "alt": 649},
    {"id": "SCVM", "metar": True, "nombre": "Viña del Mar · Torquemada",               "lat": -32.949, "lon": -71.474, "alt": 141},
    {"id": "SCRD", "metar": True, "nombre": "Valparaíso · Rodelillo",                  "lat": -33.068, "lon": -71.557, "alt": 336},
    {"id": "SCSN", "metar": True, "nombre": "San Antonio · Santo Domingo",             "lat": -33.656, "lon": -71.615, "alt": 75},
    # DMC EMA — lugares sin METAR (coords y altitud del catálogo getEstacionesRedEma)
    {"id": "330020", "dmc": True, "nombre": "Santiago · Quinta Normal",      "lat": -33.44500, "lon": -70.68278, "alt": 520},
    {"id": "330006", "dmc": True, "nombre": "Viña del Mar · Jardín Botánico","lat": -33.04500, "lon": -71.50194, "alt": 50},
    {"id": "320124", "dmc": True, "nombre": "Quillota · Liceo Agrícola",     "lat": -32.90722, "lon": -71.27139, "alt": 123},
    {"id": "320019", "dmc": True, "nombre": "San Felipe · Escuela Agrícola", "lat": -32.75528, "lon": -70.70694, "alt": 662},
    {"id": "320056", "dmc": True, "nombre": "Quintero · Climatológica",      "lat": -32.78417, "lon": -71.52278, "alt": 5},
    {"id": "330162", "dmc": True, "nombre": "Colina",                        "lat": -33.16222, "lon": -70.64306, "alt": 755},
    {"id": "330071", "dmc": True, "nombre": "Talagante",                     "lat": -33.67028, "lon": -70.84944, "alt": 390},
    {"id": "330122", "dmc": True, "nombre": "Santiago · La Florida",         "lat": -33.54500, "lon": -70.54833, "alt": 670},
    {"id": "330112", "dmc": True, "nombre": "San José de Maipo · Guayacán",  "lat": -33.61528, "lon": -70.35055, "alt": 928},
    {"id": "320051", "dmc": True, "nombre": "Los Libertadores",              "lat": -32.84555, "lon": -70.11917, "alt": 2955},
]

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
