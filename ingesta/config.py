"""Configuración de la ingesta de Sinóptica.

Todo punto de archivo de pronóstico ES una estación con observaciones:
calibrar donde no hay ground truth no aporta ciencia.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("CLIMA_DB", ROOT / "data" / "clima.db"))
STATUS_PATH = Path(os.environ.get("CLIMA_STATUS", ROOT / "web" / "status.json"))

# ── Estaciones METAR (aeropuertos V Región + RM) ────────────────
# Observaciones oficiales DMC distribuidas vía red WMO (NOAA AWC, sin clave).
STATIONS = [
    {"icao": "SCEL", "nombre": "Santiago · Pudahuel (A. Merino Benítez)", "lat": -33.393, "lon": -70.785},
    {"icao": "SCTB", "nombre": "Santiago · Tobalaba (E. Sánchez)",        "lat": -33.456, "lon": -70.547},
    {"icao": "SCVM", "nombre": "Viña del Mar · Torquemada",               "lat": -32.949, "lon": -71.474},
    {"icao": "SCRD", "nombre": "Valparaíso · Rodelillo",                  "lat": -33.068, "lon": -71.557},
    {"icao": "SCSN", "nombre": "San Antonio · Santo Domingo",             "lat": -33.656, "lon": -71.615},
]

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

# ── DMC (requiere registro gratuito en climatologia.meteochile.gob.cl) ──
# Cuando existan credenciales, se archivan los payloads crudos de las EMA.
DMC_USUARIO = os.environ.get("DMC_USUARIO", "")
DMC_TOKEN = os.environ.get("DMC_TOKEN", "")
DMC_STATIONS = [s for s in os.environ.get("DMC_STATIONS", "").split(",") if s.strip()]
API_DMC = "https://climatologia.meteochile.gob.cl/application/servicios/getDatosRecientesEma"
