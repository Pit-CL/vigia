"""Verificación de avisos_emitidos contra observaciones: ¿los avisos que
emitimos coinciden con lo que realmente pasó en la estación?

Producto binario clásico de verificación meteorológica (POD/FAR/CSI), pero
aplicado al umbral AMARILLO de cada tipo de aviso (el umbral base, no
naranja/rojo — mismo criterio que "hubo aviso" o no):
  - hit:    el aviso se emitió Y la observación cruzó el umbral cerca de esa hora.
  - falsa alarma: el aviso se emitió Y la observación NUNCA cruzó el umbral cerca.
  - miss:   la observación cruzó el umbral Y no había ningún aviso de ese
            tipo/estación cubriendo esa hora.

Solo se evalúan los tipos de aviso cuya variable subyacente tiene observación
pareada en la red (METAR/DMC, ver db.py y sources.py). TIPOS_NO_VERIFICABLES
documenta el resto y por qué, para que verificacion.json sea honesto sobre lo
que no se puede medir.

Umbrales importados de avisos.py (nunca duplicados, regla de reuso del
workspace); esta verificación NUNCA modifica avisos.py ni su lógica de
emisión, solo la observa desde afuera.
"""
from datetime import datetime, timedelta, timezone

import avisos

TOLERANCIA_H = 3          # ventana de tolerancia alrededor de valid_time / evento
WINDOW_DIAS = 14          # horizonte de verificación (mismo orden que verify.py)
MIN_MUESTRA = 10          # bajo este n, la métrica se marca "muestra_insuficiente"

# tipo -> {variable observada, forma de calcular la métrica desde obs, umbral
# amarillo (importado de avisos.py), sentido de "cruce"}.
#
# "punto": el aviso se dispara por un valor instantáneo (pico horario de la
#   mediana); se compara contra cada observación individual.
# "caida": el aviso se dispara por la caída de la variable en una ventana
#   móvil (presión); se recalcula la caída sobre observaciones consecutivas
#   separadas ~ventana_h (con tolerancia).
# "suma": el aviso se dispara por la suma acumulada en una ventana móvil
#   (lluvia); se suman las observaciones dentro de la ventana.
#
# Simplificación documentada para ola_calor/ola_frio: avisos.py exige 3 días
# LOCALES consecutivos sobre el umbral (OLA_CALOR_DIAS_MIN); duplicar esa
# agrupación por día local aquí sería reinventar lógica de avisos.py sin
# importarla (es privada). Se verifica el cruce puntual del mismo umbral
# amarillo — más generoso con los hits que la definición real de emisión,
# documentado en el output vía "nota".
TIPOS_VERIFICABLES = {
    "viento": dict(variable="wind_speed_10m", kind="punto", mayor_es_peor=True,
                   amarillo=avisos.VIENTO_AMARILLO),
    "helada": dict(variable="temperature_2m", kind="punto", mayor_es_peor=False,
                   amarillo=avisos.HELADA_AMARILLO),
    "calor": dict(variable="temperature_2m", kind="punto", mayor_es_peor=True,
                  amarillo=avisos.CALOR_AMARILLO),
    "ola_calor": dict(variable="temperature_2m", kind="punto", mayor_es_peor=True,
                      amarillo=avisos.OLA_CALOR_AMARILLO),
    "ola_frio": dict(variable="temperature_2m", kind="punto", mayor_es_peor=False,
                     amarillo=avisos.OLA_FRIO_AMARILLO),
    "presion": dict(variable="pressure_msl", kind="caida", ventana_h=24,
                    mayor_es_peor=True, amarillo=avisos.PRESION_AMARILLO),
    "lluvia": dict(variable="precipitation_6h", kind="suma", ventana_h=24,
                   mayor_es_peor=True, amarillo=avisos.LLUVIA_AMARILLO),
    "lluvia_persistente": dict(variable="precipitation_6h", kind="suma", ventana_h=48,
                               mayor_es_peor=True, amarillo=avisos.LLUVIA48_AMARILLO),
}

TIPOS_NO_VERIFICABLES = {
    "nieve": "snowfall sin observación pareada (METAR/DMC no reportan nieve)",
    "nieve_cota_baja": "compuesto lluvia+isoterma; freezing_level_height sin observación pareada",
    "rafagas": "wind_gusts_10m sin observación pareada (sin red de ráfagas, ver avisos.py)",
    "tormenta": "cape sin observación pareada (no es magnitud observable directamente)",
    "uv": "uv_index sin observación pareada",
    "aluvional": "compuesto lluvia+isoterma; freezing_level_height sin observación pareada",
    "incendio": "compuesto de 3 variables simultáneas sin un único valor mapeado (ver _TIPO_VARIABLE en avisos.py)",
}


def _dt(s: str) -> datetime:
    d = datetime.fromisoformat(s)
    return d.replace(tzinfo=None) if d.tzinfo else d


def _metric_serie(obs_rows: list, spec: dict) -> list:
    """[(datetime, valor_metrica)] a partir de observaciones crudas (obs_time,
    value), según spec['kind']. Para 'punto' es la observación misma; para
    'caida'/'suma' se recalcula sobre pares de observaciones separadas por
    spec['ventana_h'] (con tolerancia), igual de aproximado que los rolling_*
    de avisos.py cuando faltan puntos."""
    parsed = sorted((_dt(t), v) for t, v in obs_rows if v is not None)
    if spec["kind"] == "punto":
        return parsed
    ventana = timedelta(hours=spec["ventana_h"])
    tol = timedelta(hours=TOLERANCIA_H)
    out = []
    if spec["kind"] == "caida":
        for t, v in parsed:
            objetivo = t - ventana
            candidatos = [(abs(t2 - objetivo), v2) for t2, v2 in parsed if abs(t2 - objetivo) <= tol]
            if not candidatos:
                continue
            _, v_inicio = min(candidatos)
            out.append((t, v_inicio - v))
    elif spec["kind"] == "suma":
        n_esperado = max(1, spec["ventana_h"] // 6 - 1)  # tolera 1 punto sinóptico faltante
        for t, v in parsed:
            en_ventana = [v2 for t2, v2 in parsed if t - ventana < t2 <= t]
            if len(en_ventana) < n_esperado:
                continue
            out.append((t, sum(en_ventana)))
    return out


def _eventos(metric_serie: list, spec: dict) -> list:
    """Agrupa exceedances contiguas (gap <= TOLERANCIA_H) del umbral amarillo
    en un solo evento [(inicio, fin), ...] — un temporal de 5 h contiguas es
    1 evento, no 5."""
    amarillo = spec["amarillo"]
    mayor_es_peor = spec["mayor_es_peor"]
    tol = timedelta(hours=TOLERANCIA_H)
    eventos, actual = [], None
    for t, v in metric_serie:
        cruza = v >= amarillo if mayor_es_peor else v <= amarillo
        if not cruza:
            continue
        if actual and (t - actual[1]) <= tol:
            actual = (actual[0], t)
        else:
            if actual:
                eventos.append(actual)
            actual = (t, t)
    if actual:
        eventos.append(actual)
    return eventos


def _evaluar_tipo(con, tipo: str, spec: dict, ahora: datetime,
                  cobertura_desde: datetime | None) -> dict:
    desde_dt = ahora - timedelta(days=WINDOW_DIAS)
    margen_h = spec.get("ventana_h", 0) + TOLERANCIA_H
    desde_obs = (desde_dt - timedelta(hours=margen_h)).isoformat()
    ahora_s = ahora.strftime("%Y-%m-%dT%H:%M:%S")

    avisos_rows = con.execute(
        "SELECT DISTINCT station_id, valid_time FROM avisos_emitidos"
        " WHERE tipo=? AND valid_time >= ? AND valid_time <= ?",
        (tipo, desde_dt.strftime("%Y-%m-%dT%H:%M"), ahora_s),
    ).fetchall()
    # Solo avisos cuyo valid_time + margen ya pasó: si no, la observación
    # todavía no puede existir y no es ni hit ni falsa alarma, es "pendiente".
    avisos_validos = [(st, _dt(vt)) for st, vt in avisos_rows
                       if _dt(vt) + timedelta(hours=TOLERANCIA_H) <= ahora]

    estaciones_obs = {r[0] for r in con.execute(
        "SELECT DISTINCT station FROM observations WHERE variable=? AND obs_time>=?",
        (spec["variable"], desde_obs))}
    estaciones = estaciones_obs | {st for st, _ in avisos_validos}

    hits = falsas = misses = 0
    for station_id in estaciones:
        obs_rows = con.execute(
            "SELECT obs_time, value FROM observations"
            " WHERE station=? AND variable=? AND obs_time>=? AND obs_time<=?"
            " ORDER BY obs_time",
            (station_id, spec["variable"], desde_obs, ahora_s),
        ).fetchall()
        metric = _metric_serie(obs_rows, spec)
        eventos = _eventos(metric, spec)
        cubierto = [False] * len(eventos)

        for st, vt in avisos_validos:
            if st != station_id:
                continue
            tocado = False
            for i, (ini, fin) in enumerate(eventos):
                if ini - timedelta(hours=TOLERANCIA_H) <= vt <= fin + timedelta(hours=TOLERANCIA_H):
                    tocado = True
                    cubierto[i] = True
            if tocado:
                hits += 1
            else:
                falsas += 1

        # Un exceedance observado solo cuenta como miss si OCURRIÓ cuando ya
        # existía cobertura de avisos (la tabla avisos_emitidos partió el
        # 14-07-2026): cruces anteriores no podían tener aviso y contarlos
        # inflaría los misses con un POD=0 falso durante los primeros 14 días.
        misses += sum(
            1 for (ini, _fin), c in zip(eventos, cubierto)
            if not c and (cobertura_desde is not None and ini >= cobertura_desde)
        )

    n = hits + falsas + misses
    pod = round(hits / (hits + misses), 3) if (hits + misses) else None
    far = round(falsas / (hits + falsas), 3) if (hits + falsas) else None
    csi = round(hits / n, 3) if n else None
    return {
        "hits": hits, "falsas": falsas, "misses": misses, "n": n,
        "pod": pod, "far": far, "csi": csi,
        "muestra_insuficiente": n < MIN_MUESTRA,
    }


def compute(con, ahora: datetime | None = None) -> dict:
    ahora = ahora or datetime.now(timezone.utc).replace(tzinfo=None)
    # Inicio de la cobertura del histórico de avisos: antes de esto no puede
    # haber misses (no existía registro contra el cual fallar).
    row = con.execute("SELECT MIN(run_ts) FROM avisos_emitidos").fetchone()
    cobertura_desde = _dt(row[0][:16]) if row and row[0] else None
    tipos = {tipo: _evaluar_tipo(con, tipo, spec, ahora, cobertura_desde)
             for tipo, spec in TIPOS_VERIFICABLES.items()}
    n_avisos_evaluados = sum(r["hits"] + r["falsas"] for r in tipos.values())
    return {
        "ventana_dias": WINDOW_DIAS,
        "tolerancia_horas": TOLERANCIA_H,
        "cobertura_desde": row[0] if row else None,
        "n_avisos_evaluados": n_avisos_evaluados,
        "nota": "ola_calor/ola_frio verifican el cruce puntual del umbral amarillo,"
                " sin exigir el sostenido de 3 días que exige la emisión (simplificación v1)",
        "tipos": tipos,
        "no_verificables": TIPOS_NO_VERIFICABLES,
    }


def _persistir(con, run_ts: str, tipos: dict) -> None:
    for tipo, r in tipos.items():
        con.execute(
            "INSERT INTO avisos_verif(run_ts, tipo, ventana_dias, hits, falsas, misses, pod, far, csi)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (run_ts, tipo, WINDOW_DIAS, r["hits"], r["falsas"], r["misses"], r["pod"], r["far"], r["csi"]),
        )
    con.execute("DELETE FROM avisos_verif WHERE run_ts < datetime('now', '-365 days')")
    con.commit()


def compute_and_persist(con, run_ts: str | None = None) -> dict:
    ahora = datetime.now(timezone.utc).replace(tzinfo=None)
    run_ts = run_ts or ahora.strftime("%Y-%m-%dT%H:%M:%SZ")
    data = compute(con, ahora)
    _persistir(con, run_ts, data["tipos"])
    return data
