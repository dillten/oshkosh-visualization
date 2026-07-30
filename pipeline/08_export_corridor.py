"""Phase 8: Fisk VFR arrival corridor analytics export.

Projects raw ADS-B trace points onto the published Endeavor Bridge -> Puckaway
Lake -> Green Lake -> Ripon -> Fisk VFR arrival route, detects each aircraft's
corridor transit(s), and computes per-transit speed/altitude at each waypoint
plus in-trail spacing to the preceding aircraft at Ripon and Fisk (the
"rubber banding" signal: does a slow lead aircraft compress the gap behind
it). Reads the raw (full-resolution) trace parquet directly, since
flights.parquet/journeys.parquet discard altitude/speed/track entirely, and
the timelapse/aircraft-detail exports either zero out (points.bin) or
downsample (aircraft/<hex>.json) altitude and drop ground speed.

Output (viz/public/data/corridor/):
    meta.json         waypoints, targets, corridor length, available days
    transits.json     one record per corridor transit, whole event
    points/<day>.json per-transit dense point series for that day
    summary.json      precomputed story-page aggregates (histograms, along-
                       track speed/altitude profiles, gap-vs-lead-speed
                       scatter, type ranking, daily/hourly traffic, peak
                       concurrency) so the frontend never has to crunch raw
                       points client-side
"""

import json
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import duckdb
import numpy as np

from config import (
    CORRIDOR_ALT_CEILING_FT,
    CORRIDOR_MIN_GS,
    CORRIDOR_TARGETS,
    INTERIM_DIR,
    PROCESSED_DIR,
    PROJECT_ROOT,
)
from corridor_common import CODES, Corridor, corridor_bbox, find_transits, interp_waypoints

OUT_DIR = PROJECT_ROOT / "viz" / "public" / "data" / "corridor"
POINTS_DIR = OUT_DIR / "points"
LOCAL_TZ = ZoneInfo("America/Chicago")
ALT_TOL_FT = 200  # within this of a target altitude counts as "on profile"

# Which waypoint-pair gaps double as the in-trail spacing check (the
# published 0.5nm rule and the "rubber banding" question both center on the
# Ripon->Fisk railroad-track leg where traffic is most compressed).
GAP_CHECKPOINTS = ["RIPON", "FISK"]


def format_local(epoch_s: float | None) -> str | None:
    """'%-d'/'%-I' aren't portable across platforms; format by hand instead."""
    if epoch_s is None:
        return None
    dt = datetime.fromtimestamp(epoch_s, tz=LOCAL_TZ)
    hour12 = dt.hour % 12 or 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{dt.strftime('%a %b')} {dt.day}, {hour12}:{dt.minute:02d} {ampm}"


def quantiles(values: np.ndarray, qs=(0.25, 0.5, 0.75)):
    return [float(np.quantile(values, q)) for q in qs] if len(values) else [None] * len(qs)


def build_along_profile(along: np.ndarray, gs: np.ndarray, alt_ft: np.ndarray, total_nm: float, bin_nm: float = 1.0):
    n_bins = max(1, int(np.ceil(total_nm / bin_nm)))
    idx = np.clip((along / bin_nm).astype(int), 0, n_bins - 1)
    centers, gs_p25, gs_med, gs_p75, alt_p25, alt_med, alt_p75 = [], [], [], [], [], [], []
    for i in range(n_bins):
        m = idx == i
        centers.append(round((i + 0.5) * bin_nm, 2))
        if m.sum() < 3:
            gs_p25.append(None); gs_med.append(None); gs_p75.append(None)
            alt_p25.append(None); alt_med.append(None); alt_p75.append(None)
            continue
        gq = quantiles(gs[m])
        aq = quantiles(alt_ft[m])
        gs_p25.append(round(gq[0], 1)); gs_med.append(round(gq[1], 1)); gs_p75.append(round(gq[2], 1))
        alt_p25.append(round(aq[0])); alt_med.append(round(aq[1])); alt_p75.append(round(aq[2]))
    return {
        "centers": centers,
        "gs": {"p25": gs_p25, "median": gs_med, "p75": gs_p75},
        "alt_ft": {"p25": alt_p25, "median": alt_med, "p75": alt_p75},
    }


def build_summary(all_transits: list[dict], along_cat, gs_cat, alt_cat, corridor: Corridor):
    fisk = [t for t in all_transits if "FISK" in t["waypoints"]]
    fisk_gs = np.array([t["waypoints"]["FISK"]["gs"] for t in fisk])
    fisk_alt = np.array([t["waypoints"]["FISK"]["alt_ft"] for t in fisk])

    on_low = np.abs(fisk_alt - CORRIDOR_TARGETS["low"]["alt_ft"]) <= ALT_TOL_FT
    on_high = np.abs(fisk_alt - CORRIDOR_TARGETS["high"]["alt_ft"]) <= ALT_TOL_FT

    gaps = [t for t in all_transits if t.get("gap_prev_nm_fisk") is not None and t["gap_prev_nm_fisk"] < 15]
    gap_nm = np.array([t["gap_prev_nm_fisk"] for t in gaps])
    gap_s = np.array([t["gap_prev_s_fisk"] for t in gaps])

    # The scatter chart is for visually reading the ahead/lead-speed trend, not
    # for capturing every last outlier -- a handful of freak gaps (a straggler
    # that got separated by many minutes) stretch the axis and flatten the
    # trend everyone actually cares about, so clip to the 98th percentile on
    # top of the <15nm sanity filter above.
    gap_p98 = float(np.percentile(gap_nm, 98)) if len(gap_nm) else 15.0
    gap_scatter = [
        {
            "lead_gs": t["lead_gs_fisk"],
            "gap_nm": t["gap_prev_nm_fisk"],
            "reg": t["reg"],
            "type": t["type"],
            "hex": t["hex"],
        }
        for t in gaps
        if t["gap_prev_nm_fisk"] <= gap_p98
    ]

    by_day: dict[str, int] = {}
    for t in all_transits:
        by_day[t["day"]] = by_day.get(t["day"], 0) + 1
    busiest_day = max(by_day.items(), key=lambda kv: kv[1]) if by_day else (None, 0)

    # Peak concurrency: max aircraft simultaneously in the tight Ripon->Fisk
    # "conga line" segment (not the whole 39nm corridor, which would count
    # aircraft strung out far apart as if they were bunched together), via a
    # sweep line over each transit's [t at Ripon, t at Fisk].
    events = []
    for t in all_transits:
        wp = t["waypoints"]
        if "RIPON" in wp and "FISK" in wp:
            events.append((wp["RIPON"]["t"], 1))
            events.append((wp["FISK"]["t"], -1))
    events.sort(key=lambda e: (e[0], -e[1]))
    cur = best = 0
    best_t = events[0][0] if events else None
    for ts, delta in events:
        cur += delta
        if cur > best:
            best, best_t = cur, ts

    # Speed by type at each of the three checkpoints where the corridor is
    # most legible (Green Lake -> Ripon -> Fisk, the railroad-track run-in) --
    # lets you see whether a type's speed is already set well before Fisk or
    # only settles late, not just its one number at the very end.
    TYPE_CHECKPOINTS = [("GRN", "green_lake"), ("RIPON", "ripon"), ("FISK", "fisk")]
    type_values: dict[str, dict[str, list[float]]] = {}
    for t in all_transits:
        key = t["type"] or t["desc"] or "Unknown"
        bucket = type_values.setdefault(key, {label: [] for _, label in TYPE_CHECKPOINTS})
        for code, label in TYPE_CHECKPOINTS:
            if code in t["waypoints"]:
                bucket[label].append(t["waypoints"][code]["gs"])

    type_stats = []
    for key, by_wp in type_values.items():
        if len(by_wp["fisk"]) < 5:
            continue
        row: dict = {"type": key}
        for _, label in TYPE_CHECKPOINTS:
            vals = by_wp[label]
            row[label] = (
                {"avg": round(float(np.mean(vals)), 1), "min": round(float(np.min(vals)), 1), "max": round(float(np.max(vals)), 1), "n": len(vals)}
                if vals
                else None
            )
        type_stats.append(row)
    type_stats.sort(key=lambda r: -(r["fisk"]["avg"] if r["fisk"] else 0))

    speed_hist_counts, _ = np.histogram(fisk_gs, bins=30, range=(40, 190))
    alt_hist_counts, _ = np.histogram(fisk_alt, bins=40, range=(0, 4000))
    profile = build_along_profile(along_cat, gs_cat, alt_cat, corridor.total_nm)

    return {
        "totals": {
            "transits": len(all_transits),
            "fisk_crossings": len(fisk),
            "median_gs_fisk": round(float(np.median(fisk_gs)), 1) if len(fisk_gs) else None,
            "median_alt_fisk": round(float(np.median(fisk_alt))) if len(fisk_alt) else None,
            "pct_low_profile": round(100 * float(on_low.mean())) if len(fisk_alt) else None,
            "pct_high_profile": round(100 * float(on_high.mean())) if len(fisk_alt) else None,
            "pct_on_altitude": round(100 * float((on_low | on_high).mean())) if len(fisk_alt) else None,
            "median_gap_s_fisk": round(float(np.median(gap_s)), 1) if len(gap_s) else None,
            "median_gap_nm_fisk": round(float(np.median(gap_nm)), 2) if len(gap_nm) else None,
            "pct_gap_under_half_nm": round(100 * float((gap_nm < 0.5).mean())) if len(gap_nm) else None,
            "busiest_day": {"day": busiest_day[0], "count": busiest_day[1]},
            "max_concurrent": {"n": best, "t_local": format_local(best_t)},
        },
        "speed_hist": {"bin_size": 5, "min": 40, "counts": speed_hist_counts.tolist()},
        "alt_hist": {"bin_size": 100, "min": 0, "counts": alt_hist_counts.tolist()},
        "speed_profile": {"centers": profile["centers"], **profile["gs"]},
        "alt_profile": {"centers": profile["centers"], **profile["alt_ft"]},
        "gap_scatter": gap_scatter,
        "type_stats": type_stats,
    }


def main() -> None:
    t0 = time.monotonic()
    POINTS_DIR.mkdir(parents=True, exist_ok=True)

    corridor = Corridor()
    lat_min, lat_max, lon_min, lon_max = corridor_bbox()

    con = duckdb.connect()
    ac_rows = con.execute(
        f"select hex, r, t, \"desc\" from read_parquet('{(PROCESSED_DIR / 'aircraft.parquet').as_posix()}')"
    ).fetchall()
    ac_meta = {row[0]: row[1:] for row in ac_rows}

    traces_glob = f"{INTERIM_DIR.as_posix()}/traces/day=*/part.parquet"
    days = [r[0] for r in con.execute(f"select distinct day from read_parquet('{traces_glob}') order by day").fetchall()]

    all_transits = []
    all_along, all_gs, all_alt = [], [], []
    transit_id = 0
    for day in days:
        df = con.execute(
            f"""
            select hex, ts, lat, lon, cast(alt_ft as double) alt_ft, gs
            from read_parquet('{traces_glob}')
            where day = ?
              and lat between ? and ? and lon between ? and ?
              and gs is not null and gs >= ?
              and alt_ft is not null and alt_ft >= 0 and alt_ft <= ?
            order by hex, ts
            """,
            [day, lat_min, lat_max, lon_min, lon_max, CORRIDOR_MIN_GS, CORRIDOR_ALT_CEILING_FT],
        ).df()

        day_points = []
        day_str = str(day)
        for hexid, g in df.groupby("hex", sort=False):
            ts = g["ts"].to_numpy(dtype=np.float64)
            lat = g["lat"].to_numpy(dtype=np.float64)
            lon = g["lon"].to_numpy(dtype=np.float64)
            alt_ft = g["alt_ft"].to_numpy(dtype=np.float64)
            gs = g["gs"].to_numpy(dtype=np.float64)
            along, cross = corridor.project(lat, lon)

            for s, e in find_transits(ts, lat, lon, along):
                t_ts, t_along, t_cross = ts[s:e], along[s:e], cross[s:e]
                t_lat, t_lon = lat[s:e], lon[s:e]
                t_alt, t_gs = alt_ft[s:e], gs[s:e]
                waypoints = interp_waypoints(t_ts, t_along, t_alt, t_gs, corridor)
                if not waypoints:
                    continue
                all_along.append(t_along)
                all_gs.append(t_gs)
                all_alt.append(t_alt)

                seg_gs = {}
                for i in range(len(CODES) - 1):
                    a, b = CODES[i], CODES[i + 1]
                    if a in waypoints and b in waypoints:
                        dt = waypoints[b]["t"] - waypoints[a]["t"]
                        if dt > 0:
                            dnm = corridor.waypoint_along[i + 1] - corridor.waypoint_along[i]
                            seg_gs[f"{a}_{b}"] = round(dnm / dt * 3600, 1)

                reg, typ, desc = ac_meta.get(hexid, (None, None, None))
                all_transits.append(
                    {
                        "hex": hexid,
                        "reg": reg,
                        "type": typ,
                        "desc": desc,
                        "day": day_str,
                        "transit_id": transit_id,
                        "t_enter": float(t_ts[0]),
                        "t_exit": float(t_ts[-1]),
                        "waypoints": {
                            code: {
                                "t": round(v["t"], 1),
                                "alt_ft": round(v["alt_ft"]),
                                "gs": round(v["gs"], 1),
                            }
                            for code, v in waypoints.items()
                        },
                        "seg_gs": seg_gs,
                    }
                )
                day_points.append(
                    {
                        "hex": hexid,
                        "transit_id": transit_id,
                        # [t_rel(s since transit start), lon, lat, along_nm, cross_nm, alt_ft, gs]
                        "pts": [
                            [round(tt - t_ts[0], 1), round(lo, 5), round(la, 5), round(al, 2), round(cr, 2), round(af), round(g, 1)]
                            for tt, lo, la, al, cr, af, g in zip(t_ts, t_lon, t_lat, t_along, t_cross, t_alt, t_gs)
                        ],
                    }
                )
                transit_id += 1

        with open(POINTS_DIR / f"{day_str}.json", "w", encoding="utf-8") as f:
            json.dump(day_points, f, separators=(",", ":"))
        print(f"  {day_str}: {len(day_points)} transits ({time.monotonic() - t0:.0f}s)")

    # In-trail spacing: at each checkpoint waypoint, sort same-day transits by
    # crossing time and diff against the immediately preceding one. A slow
    # lead aircraft (low lead_gs) with a small gap_prev_nm is the rubber-band
    # signature this whole export exists to surface.
    for wp in GAP_CHECKPOINTS:
        by_day: dict[str, list[dict]] = {}
        for t in all_transits:
            if wp in t["waypoints"]:
                by_day.setdefault(t["day"], []).append(t)
        for day_transits in by_day.values():
            day_transits.sort(key=lambda t: t["waypoints"][wp]["t"])
            for i, t in enumerate(day_transits):
                if i == 0:
                    continue
                prev = day_transits[i - 1]
                gap_s = t["waypoints"][wp]["t"] - prev["waypoints"][wp]["t"]
                lead_gs = prev["waypoints"][wp]["gs"]
                gap_nm = round(gap_s * (t["waypoints"][wp]["gs"] + lead_gs) / 2 / 3600, 3)
                t[f"gap_prev_s_{wp.lower()}"] = round(gap_s, 1)
                t[f"gap_prev_nm_{wp.lower()}"] = gap_nm
                t[f"lead_hex_{wp.lower()}"] = prev["hex"]
                t[f"lead_gs_{wp.lower()}"] = lead_gs

    with open(OUT_DIR / "transits.json", "w", encoding="utf-8") as f:
        json.dump(all_transits, f, separators=(",", ":"))

    meta = {
        "waypoints": [
            {"code": code, "name": name, "lat": lat, "lon": lon, "along_nm": round(along, 2)}
            for code, name, lat, lon, along in zip(
                CODES, corridor.names, corridor.lats.tolist(), corridor.lons.tolist(), corridor.waypoint_along.tolist()
            )
        ],
        "targets": CORRIDOR_TARGETS,
        "corridor_len_nm": round(corridor.total_nm, 2),
        "days": [str(d) for d in days],
        "gap_checkpoints": GAP_CHECKPOINTS,
    }
    with open(OUT_DIR / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, separators=(",", ":"))

    along_cat = np.concatenate(all_along) if all_along else np.array([])
    gs_cat = np.concatenate(all_gs) if all_gs else np.array([])
    alt_cat = np.concatenate(all_alt) if all_alt else np.array([])
    summary = build_summary(all_transits, along_cat, gs_cat, alt_cat, corridor)
    with open(OUT_DIR / "summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, separators=(",", ":"))

    print(f"{len(all_transits)} transits across {len(days)} days ({(time.monotonic() - t0) / 60:.1f} min)")


if __name__ == "__main__":
    main()
