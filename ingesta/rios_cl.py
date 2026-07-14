"""Puntos de río curados para el pronóstico de crecidas (GloFAS/Copernicus,
ver crecidas.py). Coordenadas sobre el cauce principal, cerca de zonas
pobladas, de Arica a la Antártica.

Invariante distinto al de stations_cl.py: estos puntos NO son estaciones con
observaciones propias (regla 6 de CLAUDE.md) — son celdas de un modelo global
de caudal, sin ground truth local. Viven en su propio módulo y tabla, nunca
entran a `forecasts`/`observations`.

Coordenadas ajustadas empíricamente donde la celda de río más cercana de
GloFAS (resolución ~5 km) caía en un tributario menor con caudal casi nulo:
verificado contra la API real 2026-07-14 (ver commit de este módulo).
"""

RIOS = [
    {"id": "mapocho_santiago", "rio": "Mapocho", "comuna": "Santiago", "region": "Metropolitana", "lat": -33.4372, "lon": -70.6506},
    {"id": "maipo_talagante", "rio": "Maipo", "comuna": "Talagante", "region": "Metropolitana", "lat": -33.6667, "lon": -70.9783},
    {"id": "aconcagua_sanfelipe", "rio": "Aconcagua", "comuna": "San Felipe", "region": "Valparaíso", "lat": -32.75, "lon": -70.72},
    {"id": "aconcagua_quillota", "rio": "Aconcagua", "comuna": "Quillota", "region": "Valparaíso", "lat": -32.88, "lon": -71.25},
    {"id": "elqui_laserena", "rio": "Elqui", "comuna": "La Serena", "region": "Coquimbo", "lat": -29.855, "lon": -71.25},
    {"id": "limari_ovalle", "rio": "Limarí", "comuna": "Ovalle", "region": "Coquimbo", "lat": -30.60, "lon": -71.20},
    {"id": "choapa_illapel", "rio": "Choapa", "comuna": "Illapel", "region": "Coquimbo", "lat": -31.72, "lon": -71.17},
    {"id": "copiapo_ciudad", "rio": "Copiapó", "comuna": "Copiapó", "region": "Atacama", "lat": -27.325, "lon": -70.42},
    {"id": "cachapoal_rancagua", "rio": "Cachapoal", "comuna": "Rancagua", "region": "O'Higgins", "lat": -34.17, "lon": -70.74},
    {"id": "tinguiririca_sanfernando", "rio": "Tinguiririca", "comuna": "San Fernando", "region": "O'Higgins", "lat": -34.585, "lon": -70.99},
    {"id": "mataquito_licanten", "rio": "Mataquito", "comuna": "Licantén", "region": "Maule", "lat": -34.98, "lon": -72.0},
    {"id": "maule_talca", "rio": "Maule", "comuna": "Talca", "region": "Maule", "lat": -35.43, "lon": -71.65},
    {"id": "maule_constitucion", "rio": "Maule", "comuna": "Constitución", "region": "Maule", "lat": -35.33, "lon": -72.40},
    {"id": "itata_coelemu", "rio": "Itata", "comuna": "Coelemu", "region": "Ñuble", "lat": -36.49, "lon": -72.70},
    {"id": "nuble_chillan", "rio": "Ñuble", "comuna": "Chillán", "region": "Ñuble", "lat": -36.61, "lon": -72.10},
    {"id": "biobio_concepcion", "rio": "Biobío", "comuna": "Concepción", "region": "Biobío", "lat": -36.82, "lon": -73.05},
    {"id": "biobio_losangeles", "rio": "Biobío", "comuna": "Los Ángeles", "region": "Biobío", "lat": -37.47, "lon": -72.35},
    {"id": "laja_nacimiento", "rio": "Laja", "comuna": "Nacimiento", "region": "Biobío", "lat": -37.50, "lon": -72.68},
    {"id": "cautin_temuco", "rio": "Cautín", "comuna": "Temuco", "region": "Araucanía", "lat": -38.74, "lon": -72.60},
    {"id": "tolten_ciudad", "rio": "Toltén", "comuna": "Toltén", "region": "Araucanía", "lat": -39.23, "lon": -73.22},
    {"id": "callecalle_valdivia", "rio": "Calle-Calle", "comuna": "Valdivia", "region": "Los Ríos", "lat": -39.815, "lon": -73.245},
    {"id": "bueno_riobueno", "rio": "Bueno", "comuna": "Río Bueno", "region": "Los Ríos", "lat": -40.33, "lon": -73.08},
    {"id": "rahue_osorno", "rio": "Rahue", "comuna": "Osorno", "region": "Los Lagos", "lat": -40.575, "lon": -73.13},
    {"id": "maullin_ciudad", "rio": "Maullín", "comuna": "Maullín", "region": "Los Lagos", "lat": -41.645, "lon": -73.69},
    {"id": "puelo_ciudad", "rio": "Puelo", "comuna": "Cochamó", "region": "Los Lagos", "lat": -41.645, "lon": -72.39},
    {"id": "aysen_puertoaysen", "rio": "Aysén", "comuna": "Puerto Aysén", "region": "Aysén", "lat": -45.40, "lon": -72.70},
    {"id": "simpson_coyhaique", "rio": "Simpson", "comuna": "Coyhaique", "region": "Aysén", "lat": -45.57, "lon": -72.07},
    {"id": "baker_cochrane", "rio": "Baker", "comuna": "Cochrane", "region": "Aysén", "lat": -47.16, "lon": -72.66},
    {"id": "loa_calama", "rio": "Loa", "comuna": "Calama", "region": "Antofagasta", "lat": -22.425, "lon": -68.84},
]
