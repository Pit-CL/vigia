"""Configuración de la ingesta de Vigía.

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
AVISOS_PATH = Path(os.environ.get("CLIMA_AVISOS", ROOT / "web" / "avisos.json"))

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
    # Modelo de IA de ECMWF (AIFS Single v2): la verificación pública
    # MAE/RMSE dirá si supera a IFS en Chile.
    "ecmwf_aifs025_single",
]

HOURLY_VARS = [
    "temperature_2m",
    "relative_humidity_2m",
    "dew_point_2m",
    "precipitation",
    "snowfall",
    "wind_speed_10m",
    "wind_direction_10m",
    "cloud_cover",
    "pressure_msl",
    "freezing_level_height",
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

INCENDIOS_PATH = Path(os.environ.get("CLIMA_INCENDIOS", ROOT / "web" / "incendios.json"))
FIRMS_MAP_KEY = os.environ.get("FIRMS_MAP_KEY", "")
API_FIRMS = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

# Precios de combustible en línea (CNE, datastream Junar v2 "BENCI-EN-LINEA").
# Mismo patrón que FIRMS: sin token registrado la capa queda dormida (0
# estaciones, sin error) — ver ingesta/combustible.py. Accesible directo
# desde el VPS (a diferencia de SEC/MINSAL, no requiere el satélite en omen).
COMBUSTIBLE_PATH = Path(os.environ.get("CLIMA_COMBUSTIBLE", ROOT / "web" / "combustible.json"))
CNE_API_KEY = os.environ.get("CNE_API_KEY", "")
CNE_API_URL = os.environ.get(
    "CNE_API_URL",
    # https obligatorio: la auth_key viaja en la query string.
    "https://cne.cloudapi.junar.com/api/v2/datastreams/BENCI-EN-LINEA-V2-80280/data.json/")

ALERTAS_PATH = Path(os.environ.get("CLIMA_ALERTAS", ROOT / "web" / "alertas.json"))
VOLCANES_PATH = Path(os.environ.get("CLIMA_VOLCANES", ROOT / "web" / "volcanes.json"))
# FeatureServers del dashboard oficial de alertas SENAPRED (ArcGIS).
# Si SENAPRED mueve el servicio, se corrige por env sin tocar código.
ALERTAS_ARCGIS_BASE = os.environ.get(
    "ALERTAS_ARCGIS_BASE",
    "https://services3.arcgis.com/CNzkI2T3GmfwkaAR/arcgis/rest/services")
API_RNVV = "https://rnvv.sernageomin.cl/"
API_RNVV_FALLBACK = "https://www.sernageomin.cl/alertas-volcanicas/"

EMERGENCIA_PATH = Path(os.environ.get("CLIMA_EMERGENCIA", ROOT / "web" / "emergencia.json"))
REMOCIONES_PATH = Path(os.environ.get("CLIMA_REMOCIONES", ROOT / "web" / "remociones.json"))
# FeatureServers del visor oficial "Chile Preparado" (SENAPRED).
EMERGENCIA_ARCGIS_BASE = os.environ.get(
    "EMERGENCIA_ARCGIS_BASE",
    "https://services5.arcgis.com/i7S5PSnIJAUcWvSE/arcgis/rest/services")
TSUNAMI_VIAS_PATH = Path(os.environ.get("CLIMA_TSUNAMI_VIAS", ROOT / "web" / "tsunami_vias.json"))
TSUNAMI_AREAS_PATH = Path(os.environ.get("CLIMA_TSUNAMI_AREAS", ROOT / "web" / "tsunami_areas.json"))

MAREA_PATH = Path(os.environ.get("CLIMA_MAREA", ROOT / "web" / "marea.json"))
TSUNAMI_PATH = Path(os.environ.get("CLIMA_TSUNAMI", ROOT / "web" / "tsunami.json"))

# ── Satélite (omen): fuentes que bloquean IPs de datacenter ─────
# INCOMING_DIR es donde satelite/fetch_cl.py sube los JSON crudos por scp
# (sec.json, farmacias_raw.json); ingesta/cortes.py solo los lee, nunca
# fetchea la red (ver satelite/README.md).
INCOMING_DIR = Path(os.environ.get("CLIMA_INCOMING", ROOT / "data" / "incoming"))
CORTES_PATH = Path(os.environ.get("CLIMA_CORTES", ROOT / "web" / "cortes.json"))
FARMACIAS_PATH = Path(os.environ.get("CLIMA_FARMACIAS", ROOT / "web" / "farmacias.json"))
COMUNAS_PATH = ROOT / "web" / "comunas.json"  # catastro INE versionado, no lo genera la ingesta
