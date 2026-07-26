"""Phase 6: per-aircraft detail export for the "find an aircraft" feature.

Output (viz/public/data/):
    aircraft_index.json    search/autocomplete index, no paths (~1-2 MB)
    aircraft/<hex>.json    full leg list + downsampled path for ONE airframe,
                            covering its entire 11-day window (including local
                            pattern flights during the show, not just the
                            KOSH arrival/departure captured in journeys.parquet)

Uses the same window_start as manifest.json (05_export_viz.py) so the front
end can share one clock. Paths are downsampled per leg (capped, adaptive)
since a single-aircraft detail view can afford more points than the
all-aircraft timelapse. Each path point is [t_rel, lon, lat, alt_ft] — the
altitude field (unused by the main timelapse, which stays 2D) powers the
optional 3D tilt view when a single aircraft is selected.
"""

import json
import time

import duckdb
import numpy as np

from config import INTERIM_DIR, PROCESSED_DIR, PROJECT_ROOT
from viz_common import downsample_capped, split_segments

OUT_DIR = PROJECT_ROOT / "viz" / "public" / "data"
AIRCRAFT_DIR = OUT_DIR / "aircraft"
MAX_PTS_PER_LEG = 400


def main() -> None:
    t0 = time.monotonic()
    AIRCRAFT_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    flights = (PROCESSED_DIR / "flights.parquet").as_posix()
    aircraft = (PROCESSED_DIR / "aircraft.parquet").as_posix()
    traces_glob = f"{INTERIM_DIR.as_posix()}/traces/day=*/part.parquet"

    # reuse the same window_start the timelapse manifest uses, if present
    manifest_path = OUT_DIR / "manifest.json"
    if manifest_path.exists():
        with open(manifest_path, encoding="utf-8") as f:
            window_start = json.load(f)["window_start"]
    else:
        window_start = int(con.execute(f"select min(t_start) from read_parquet('{flights}')").fetchone()[0])

    legs = con.execute(
        f"""
        select hex, leg_idx, t_start, t_end, from_apt, to_apt, path_nm
        from read_parquet('{flights}')
        order by hex, leg_idx
        """
    ).fetchall()
    ac_rows = con.execute(f"select hex, r, t, \"desc\", dbFlags from read_parquet('{aircraft}')").fetchall()
    ac_meta = {row[0]: row[1:] for row in ac_rows}

    con.execute(
        f"""
        create temp table pts as
        select hex, ts, lat, lon, track, cast(alt_ft as double) as alt_ft
        from read_parquet('{traces_glob}')
        order by hex, ts
        """
    )

    legs_by_hex: dict[str, list] = {}
    for hexid, leg_idx, t_start, t_end, from_apt, to_apt, path_nm in legs:
        legs_by_hex.setdefault(hexid, []).append(
            (leg_idx, t_start, t_end, from_apt, to_apt, path_nm)
        )

    index = []
    n = 0
    for hexid, hex_legs in legs_by_hex.items():
        df = con.execute(
            "select ts, lat, lon, track, alt_ft from pts where hex = ? order by ts", [hexid]
        ).df()
        ts_all = df["ts"].to_numpy()
        lat_all = df["lat"].to_numpy()
        lon_all = df["lon"].to_numpy()
        trk_all = df["track"].to_numpy(dtype=np.float64)
        alt_all = df["alt_ft"].to_numpy(dtype=np.float64)

        leg_out = []
        for leg_idx, t_start, t_end, from_apt, to_apt, path_nm in hex_legs:
            m = (ts_all >= t_start - 1) & (ts_all <= t_end + 1)
            if m.sum() < 2:
                continue
            jts, jlat, jlon, jtrk = ts_all[m], lat_all[m], lon_all[m], trk_all[m]
            jalt = alt_all[m]
            bounds = split_segments(jts, jlat, jlon)
            # Coverage gaps/teleports inside a leg must stay visible as breaks
            # in `path` (via `segs`) rather than silently concatenated — the
            # frontend previously drew a straight interpolated line across
            # them since this loop just appended every sub-run into one list.
            path = []
            segs = []
            for s, e in zip(bounds[:-1], bounds[1:]):
                if e - s < 2:
                    continue
                i = downsample_capped(jts[s:e], jlat[s:e], jlon[s:e], jtrk[s:e], MAX_PTS_PER_LEG)
                seg_start = len(path)
                for k in i:
                    a = jalt[s:e][k]
                    alt_ft = 0.0 if np.isnan(a) or a < 0 else float(a)
                    path.append(
                        [
                            round(float(jts[s:e][k]) - window_start, 1),
                            round(float(jlon[s:e][k]), 5),
                            round(float(jlat[s:e][k]), 5),
                            round(alt_ft),
                        ]
                    )
                segs.append([seg_start, len(path) - seg_start])
            leg_out.append(
                {
                    "idx": leg_idx,
                    "t_start": float(t_start),
                    "t_end": float(t_end),
                    "duration_s": float(t_end - t_start),
                    "from": from_apt,
                    "to": to_apt,
                    "nm": path_nm,
                    "path": path,
                    "segs": segs,
                }
            )
        if not leg_out:
            continue

        reg, typ, desc, dbflags = ac_meta.get(hexid, (None, None, None, None))
        first_ts = min(l["t_start"] for l in leg_out)
        last_ts = max(l["t_end"] for l in leg_out)
        time_aloft_s = sum(l["duration_s"] for l in leg_out)
        kosh_arrivals = [l["t_end"] for l in leg_out if l["to"] == "KOSH"]
        kosh_departures = [l["t_start"] for l in leg_out if l["from"] == "KOSH"]

        detail = {
            "hex": hexid,
            "reg": reg,
            "type": typ,
            "desc": desc,
            "mil": bool(dbflags and (int(dbflags) & 1)),
            "legs": leg_out,
        }
        with open(AIRCRAFT_DIR / f"{hexid}.json", "w", encoding="utf-8") as f:
            json.dump(detail, f, separators=(",", ":"))

        index.append(
            {
                "hex": hexid,
                "reg": reg,
                "type": typ,
                "desc": desc,
                "mil": detail["mil"],
                "n_legs": len(leg_out),
                "first_ts": float(first_ts),
                "last_ts": float(last_ts),
                "time_aloft_s": time_aloft_s,
                "kosh_arrival_ts": min(kosh_arrivals) if kosh_arrivals else None,
                "kosh_departure_ts": max(kosh_departures) if kosh_departures else None,
            }
        )
        n += 1
        if n % 1000 == 0:
            print(f"  {n} aircraft written ({time.monotonic() - t0:.0f}s)")

    with open(OUT_DIR / "aircraft_index.json", "w", encoding="utf-8") as f:
        json.dump({"window_start": window_start, "aircraft": index}, f, separators=(",", ":"))

    print(f"{n} aircraft detail files written ({(time.monotonic() - t0) / 60:.1f} min)")


if __name__ == "__main__":
    main()
