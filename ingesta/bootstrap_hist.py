"""Bootstrap histórico de la calibración (el acelerador).

En vez de esperar semanas a que el archivo propio madure, estima el bias y los
pesos de blending HOY con años de pares (pronóstico-de-cada-modelo, observación
real) descargados de:
  - Open-Meteo Previous Runs API  -> pronóstico histórico por modelo y plazo.
  - Iowa State ASOS archive        -> observación real de los 5 aeropuertos.

Ground truth = la estación real (ASOS), NO ERA5 (reanálisis a escala gruesa que
no captura el sesgo de microescala). Valida con holdout temporal (entrena con lo
viejo, mide en lo reciente) y reporta skill score vs modelo crudo, sin leakage.
Puebla la tabla `bias` (source='bootstrap') que consume calibrate.correct().

Uso:
  python3 bootstrap_hist.py --report        # solo medir skill (no escribe)
  python3 bootstrap_hist.py --write         # estima y puebla la tabla bias
"""
import argparse
import csv
import io
import json
import math
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import config
import calibrate

UA = "sinoptica-bootstrap/1.0 (proyecto open source; clima.cavara.cl)"
ASOS = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
PREV = "https://previous-runs-api.open-meteo.com/v1/forecast"

# Estaciones con ground truth histórico ASOS (las 5 METAR)
METAR = [s for s in config.STATIONS if s.get("metar")]
# Mapeo bucket de lead -> campo previous_dayN de la API
LEAD_FIELD = {"24": "previous_day1", "48": "previous_day2",
              "72": "previous_day3", "96": "previous_day4"}
VARIABLE = "temperature_2m"          # variable estrella del bootstrap
ASOS_VAR = "tmpc"                     # temperatura en °C en ASOS
W_BOOT = 0.05                        # decay del EWMA (vida media ~14 muestras)

# Método verificado en holdout (ene-jun 2026, 95 celdas): el EWMA causal bate a
# la media global (skill +0.21 vs -0.00) y al bias-por-hora (+0.02), con 94% de
# celdas mejorando. La media global falla por la no-estacionariedad del sesgo
# (cambia entre estaciones del año); el EWMA la sigue dando peso a lo reciente.


def _get(url, params):
    full = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(full, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8")


def fetch_asos(station, start, end):
    """Observación horaria real (°C) -> {valid_time 'YYYY-MM-DDTHH:00': temp}."""
    y1, m1, d1 = start.split("-")
    y2, m2, d2 = end.split("-")
    txt = _get(ASOS, {
        "station": station, "data": ASOS_VAR,
        "year1": y1, "month1": m1, "day1": d1,
        "year2": y2, "month2": m2, "day2": d2,
        "tz": "Etc/UTC", "format": "onlycomma", "missing": "M", "report_type": "3",
    })
    obs = {}
    for row in csv.DictReader(io.StringIO(txt)):
        v = row.get(ASOS_VAR)
        ts = row.get("valid", "")
        if not v or v == "M" or len(ts) < 16:
            continue
        # ASOS reporta a veces a HH:50; quedarnos con la lectura más cercana
        # a la hora redonda por hora (último gana, suficiente para media de sesgo)
        key = ts[:13].replace(" ", "T") + ":00"
        try:
            obs[key] = float(v)
        except ValueError:
            continue
    return obs


def fetch_prevruns(lat, lon, model, start, end):
    """Pronóstico histórico por lead -> {bucket: {valid_time: fc}}."""
    fields = [f"{VARIABLE}_{f}" for f in LEAD_FIELD.values()]
    data = json.loads(_get(PREV, {
        "latitude": f"{lat:.4f}", "longitude": f"{lon:.4f}",
        "hourly": ",".join(fields), "models": model,
        "start_date": start, "end_date": end, "timezone": "UTC",
    }))
    h = data.get("hourly", {})
    times = h.get("time", [])
    out = {}
    for bucket, field in LEAD_FIELD.items():
        serie = h.get(f"{VARIABLE}_{field}")
        if not serie:
            continue
        out[bucket] = {t: v for t, v in zip(times, serie) if v is not None}
    return out


def pairs_for(station, lat, lon, model, start, end):
    """Lista de (valid_time, bucket, fc, obs) emparejados por hora UTC."""
    obs = fetch_asos(station, start, end)
    fc_by_lead = fetch_prevruns(lat, lon, model, start, end)
    out = []
    for bucket, serie in fc_by_lead.items():
        for t, fc in serie.items():
            ob = obs.get(t)
            if ob is not None:
                out.append((t, bucket, fc, ob))
    return out


def _mae(errs):
    return sum(abs(e) for e in errs) / len(errs) if errs else None


def _ewma_final(errs, w=W_BOOT):
    """EWMA causal sobre errores en orden temporal -> valor reciente."""
    b = None
    for e in errs:
        b = e if b is None else (1 - w) * b + w * e
    return b


def evaluate(station, lat, lon, model, start, end, split=0.8):
    """Holdout temporal con EWMA causal (el método verificado): mantiene el
    EWMA recorriendo train y, en el tramo de test, corrige cada caso con el
    bias acumulado HASTA el caso anterior (causal, sin leakage)."""
    pr = sorted(pairs_for(station, lat, lon, model, start, end))
    by_bucket = {}
    for t, b, fc, ob in pr:
        by_bucket.setdefault(b, []).append((t, fc, ob))
    res = {}
    for b, rows in by_bucket.items():
        rows.sort()                         # orden temporal
        k = int(len(rows) * split)
        train, test = rows[:k], rows[k:]
        if len(train) < 10 or len(test) < 5:
            continue
        bias = None
        for _, fc, ob in train:
            err = fc - ob
            bias = err if bias is None else (1 - W_BOOT) * bias + W_BOOT * err
        err_crudo, err_corr = [], []
        for _, fc, ob in test:
            err_crudo.append(fc - ob)
            err_corr.append((fc - (bias or 0.0)) - ob)
            e = fc - ob
            bias = e if bias is None else (1 - W_BOOT) * bias + W_BOOT * e
        mae_c, mae_k = _mae(err_crudo), _mae(err_corr)
        skill = 1 - mae_k / mae_c if mae_c else None
        res[b] = {"n_train": len(train), "n_test": len(test),
                  "bias": round(bias, 2), "mae_crudo": round(mae_c, 2),
                  "mae_corr": round(mae_k, 2),
                  "skill": round(skill, 3) if skill is not None else None}
    return res


def estimate_full(station, lat, lon, model, start, end):
    """Bias EWMA reciente por bucket sobre TODO el rango (para poblar la tabla).
    Guarda el EWMA FINAL (el sesgo más reciente), que es lo que mejor predice
    el futuro inmediato; n = pares históricos (alto -> pasa el gate)."""
    pr = sorted(pairs_for(station, lat, lon, model, start, end))
    by_bucket = {}
    for t, b, fc, ob in pr:
        by_bucket.setdefault(b, []).append((t, fc - ob))
    out = {}
    for b, rows in by_bucket.items():
        rows.sort()                         # orden temporal por valid_time
        errs = [e for _, e in rows]
        bf = _ewma_final(errs)
        if bf is not None:
            out[b] = (round(bf, 3), len(errs))
    return out


def _eval_and_estimate(pr, split=0.8):
    """De un conjunto de pares (descargado una vez): skill holdout (EWMA causal)
    y bias EWMA final por bucket. Evita descargar dos veces."""
    by_bucket = {}
    for t, b, fc, ob in pr:
        by_bucket.setdefault(b, []).append((t, fc, ob))
    skill, est = {}, {}
    for b, rows in by_bucket.items():
        rows.sort()
        errs = [fc - ob for _, fc, ob in rows]
        bf = _ewma_final(errs)
        if bf is not None:
            est[b] = (round(bf, 3), len(errs))
        k = int(len(rows) * split)
        train, test = rows[:k], rows[k:]
        if len(train) < 10 or len(test) < 5:
            continue
        bias = _ewma_final([fc - ob for _, fc, ob in train])
        err_crudo, err_corr = [], []
        for _, fc, ob in test:
            err_crudo.append(fc - ob)
            err_corr.append((fc - (bias or 0.0)) - ob)
            e = fc - ob
            bias = e if bias is None else (1 - W_BOOT) * bias + W_BOOT * e
        mc, mk = _mae(err_crudo), _mae(err_corr)
        if mc:
            skill[b] = {"bias": round(bias, 2), "mae_crudo": round(mc, 2),
                        "mae_corr": round(mk, 2), "skill": round(1 - mk / mc, 3),
                        "n_test": len(test)}
    return skill, est


def run(start, end, write=False):
    print(f"Bootstrap histórico {start} → {end} · variable {VARIABLE} · método EWMA\n")
    skills, rows_to_write = [], []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
    for st in METAR:
        for model in config.MODELS:
            try:
                pr = pairs_for(st["id"], st["lat"], st["lon"], model, start, end)
            except Exception as e:
                print(f"  [error] {st['id']} {model}: {str(e)[:70]}")
                continue
            sk, est = _eval_and_estimate(pr)
            for b, r in sorted(sk.items()):
                print(f"  {st['id']:5} {model:22} lead {b}h: "
                      f"bias {r['bias']:+5.2f}  MAE {r['mae_crudo']:.2f}→{r['mae_corr']:.2f}  "
                      f"skill {r['skill']:+.3f}  (n_test {r['n_test']})")
                skills.append(r["skill"])
            for b, (bias, n) in est.items():
                rows_to_write.append((st["id"], model, VARIABLE, b, bias, n, "bootstrap", now))
    if skills:
        pos = sum(1 for s in skills if s > 0)
        print(f"\nResumen holdout (EWMA): {len(skills)} celdas · "
              f"skill medio {statistics.fmean(skills):+.3f} · "
              f"{pos}/{len(skills)} con skill>0 ({100*pos//len(skills)}%)")
    if write and rows_to_write:
        import db
        con = db.connect()
        calibrate.ensure_schema(con)
        con.executemany("INSERT OR REPLACE INTO bias VALUES (?,?,?,?,?,?,?,?)", rows_to_write)
        con.commit()
        print(f"\nTabla bias poblada: {len(rows_to_write)} celdas (source=bootstrap)")
    return skills


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", default="2026-06-01")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    run(a.start, a.end, write=a.write)
