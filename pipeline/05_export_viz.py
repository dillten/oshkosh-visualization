"""Phase 5: export journeys as compact binary for the web timelapse.

Output (viz/public/data/):
    manifest.json  window metadata + per-journey index into the binary
    points.bin     interleaved Float32 records [t_rel, lon, lat, alt_ft]
    stats.json     daily arrivals/departures, top origins, regions, types

Each journey is exported as one or more SEGMENTS, split wherever the trace has
a coverage gap (> 15 min) or a teleport jump (implied speed > 700 kt), so the
renderer never draws straight interpolation lines across missing data.

Downsampling: adaptive — dense near KOSH, sparse en route; always keeps
segment endpoints and big heading changes.
"""

import json
import math
import time
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

import duckdb
import numpy as np

from config import (
    INTERIM_DIR,
    KOSH_LAT,
    KOSH_LON,
    PROCESSED_DIR,
    PROJECT_ROOT,
    REFERENCE_DIR,
)

OUT_DIR = PROJECT_ROOT / "viz" / "public" / "data"
NEAR_KOSH_NM = 20.0
INTERVAL_NEAR_S = 15.0
INTERVAL_FAR_S = 60.0
HEADING_KEEP_DEG = 12.0
MAX_PTS_PER_JOURNEY = 700
GAP_SPLIT_S = 900.0
TELEPORT_KT = 700.0
LOCAL_NM = 100.0
CENTRAL = ZoneInfo("America/Chicago")

NM_PER_DEG_LAT = 60.0
COS_KOSH = math.cos(math.radians(KOSH_LAT))


def dist_bearing_from_kosh(lat: float, lon: float) -> tuple[float, float]:
    dlat = (lat - KOSH_LAT) * NM_PER_DEG_LAT
    dlon = (lon - KOSH_LON) * NM_PER_DEG_LAT * COS_KOSH
    return math.hypot(dlat, dlon), (math.degrees(math.atan2(dlon, dlat)) + 360) % 360


def region_of(lat: float | None, lon: float | None) -> str:
    if lat is None or lon is None or (isinstance(lat, float) and math.isnan(lat)):
        return "Unknown"
    d, brg = dist_bearing_from_kosh(lat, lon)
    if d <= LOCAL_NM:
        return "Local"
    return ["Northeast", "Southeast", "Southwest", "Northwest"][int(brg // 90)]


def split_segments(ts, lat, lon):
    """Indices where a new segment must start (gaps and teleports)."""
    if len(ts) < 2:
        return [0, len(ts)]
    dt = np.diff(ts)
    dlat = (lat[1:] - lat[:-1]) * NM_PER_DEG_LAT
    dlon = (lon[1:] - lon[:-1]) * NM_PER_DEG_LAT * COS_KOSH
    dnm = np.hypot(dlat, dlon)
    speed = np.divide(dnm * 3600, dt, out=np.zeros_like(dnm), where=dt > 0)
    breaks = np.flatnonzero((dt > GAP_SPLIT_S) | ((speed > TELEPORT_KT) & (dnm > 5))) + 1
    return [0, *breaks.tolist(), len(ts)]


def downsample(ts, lat, lon, trk):
    n = len(ts)
    if n <= 2:
        return np.arange(n)
    dlat = (lat - KOSH_LAT) * NM_PER_DEG_LAT
    dlon = (lon - KOSH_LON) * NM_PER_DEG_LAT * COS_KOSH
    near = np.hypot(dlat, dlon) <= NEAR_KOSH_NM
    interval = np.where(near, INTERVAL_NEAR_S, INTERVAL_FAR_S)
    keep = [0]
    last_t = ts[0]
    last_trk = trk[0]
    for i in range(1, n - 1):
        dtrk = trk[i] - last_trk
        if not np.isnan(dtrk):
            dtrk = (dtrk + 180) % 360 - 180
        if ts[i] - last_t >= interval[i] or (not np.isnan(dtrk) and abs(dtrk) >= HEADING_KEEP_DEG):
            keep.append(i)
            last_t = ts[i]
            if not np.isnan(trk[i]):
                last_trk = trk[i]
    keep.append(n - 1)
    return np.array(keep)


def build_stats(con: duckdb.DuckDBPyConnection, journeys: list) -> dict:
    daily_in: dict[str, int] = defaultdict(int)
    daily_out: dict[str, int] = defaultdict(int)
    regions_in: dict[str, int] = defaultdict(int)
    regions_out: dict[str, int] = defaultdict(int)
    for row in journeys:
        direction, t_start, t_end, region = row["dir"], row["t_start"], row["t_end"], row["region"]
        if direction == "inbound":
            day = datetime.fromtimestamp(t_end, tz=CENTRAL).date().isoformat()
            daily_in[day] += 1
            regions_in[region] += 1
        else:
            day = datetime.fromtimestamp(t_start, tz=CENTRAL).date().isoformat()
            daily_out[day] += 1
            regions_out[region] += 1
    days = sorted(set(daily_in) | set(daily_out))

    apt_names = f"""
        select coalesce(nullif(icao_code,''), nullif(gps_code,''), ident) as ident,
               any_value(name) as apt_name, any_value(municipality) as city,
               any_value(iso_region) as iso_region
        from read_csv('{(REFERENCE_DIR / "airports.csv").as_posix()}', header=true)
        group by 1
    """
    j = (PROCESSED_DIR / "journeys.parquet").as_posix()
    ac = (PROCESSED_DIR / "aircraft.parquet").as_posix()
    top_origins = con.execute(
        f"""
        select jj.origin as ident, a.apt_name, a.city, a.iso_region, count(*) as n
        from read_parquet('{j}') jj left join ({apt_names}) a on jj.origin = a.ident
        where direction='inbound' and jj.origin is not null and jj.origin != 'KOSH'
        group by 1,2,3,4 order by n desc limit 12
        """
    ).fetchall()
    top_dests = con.execute(
        f"""
        select jj.destination as ident, a.apt_name, a.city, a.iso_region, count(*) as n
        from read_parquet('{j}') jj left join ({apt_names}) a on jj.destination = a.ident
        where direction='outbound' and jj.destination is not null and jj.destination != 'KOSH'
        group by 1,2,3,4 order by n desc limit 12
        """
    ).fetchall()
    top_types = con.execute(
        f"""
        select coalesce("desc", t) as label, count(distinct hex) as n
        from read_parquet('{ac}')
        where hex in (select distinct hex from read_parquet('{j}')) and coalesce("desc", t) is not null
        group by 1 order by n desc limit 12
        """
    ).fetchall()
    n_aircraft = con.execute(f"select count(distinct hex) from read_parquet('{j}')").fetchone()[0]
    return {
        "totals": {
            "aircraft": n_aircraft,
            "inbound": sum(daily_in.values()),
            "outbound": sum(daily_out.values()),
        },
        "daily": [
            {"day": d, "inbound": daily_in.get(d, 0), "outbound": daily_out.get(d, 0)} for d in days
        ],
        "regions": [
            {"region": r, "inbound": regions_in.get(r, 0), "outbound": regions_out.get(r, 0)}
            for r in ["Local", "Northeast", "Southeast", "Southwest", "Northwest", "Unknown"]
        ],
        "top_origins": [
            {"ident": i, "name": nm, "city": c, "iso_region": s, "n": n}
            for i, nm, c, s, n in top_origins
        ],
        "top_dests": [
            {"ident": i, "name": nm, "city": c, "iso_region": s, "n": n}
            for i, nm, c, s, n in top_dests
        ],
        "top_types": [{"label": l, "n": n} for l, n in top_types],
    }


def main() -> None:
    t0 = time.monotonic()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    traces_glob = f"{INTERIM_DIR.as_posix()}/traces/day=*/part.parquet"
    con.execute(
        f"""
        create temp table j as
        select row_number() over (order by t_start) - 1 jid, *
        from read_parquet('{(PROCESSED_DIR / 'journeys.parquet').as_posix()}')
        """
    )
    con.execute(
        f"create temp table ac as select * from read_parquet('{(PROCESSED_DIR / 'aircraft.parquet').as_posix()}')"
    )
    journeys = con.execute(
        """select j.jid, j.hex, j.direction, j.origin, j.destination, j.t_start, j.t_end,
                  j.n_legs, j.total_nm, j.origin_lat, j.origin_lon, j.dest_lat, j.dest_lon,
                  ac.r, ac.t, ac."desc", ac.dbFlags
           from j left join ac using (hex) order by j.jid"""
    ).fetchall()
    window_start = int(min(row[5] for row in journeys))
    window_end = int(max(row[6] for row in journeys))
    print(f"{len(journeys)} journeys, window {window_start}..{window_end}")

    con.execute(
        f"""
        create temp table pts as
        select p.hex, p.ts, p.lat, p.lon, p.track
        from read_parquet('{traces_glob}') p
        where p.hex in (select distinct hex from j)
        order by p.hex, p.ts
        """
    )

    manifest = []
    bufs = []
    offset = 0
    cur_hex = None
    arrs = None

    def hex_points(h):
        nonlocal cur_hex, arrs
        if h != cur_hex:
            df = con.execute(
                "select ts, lat, lon, track from pts where hex = ? order by ts", [h]
            ).df()
            arrs = (
                df["ts"].to_numpy(),
                df["lat"].to_numpy(),
                df["lon"].to_numpy(),
                df["track"].to_numpy(dtype=np.float64),
            )
            cur_hex = h
        return arrs

    for (jid, hexid, direction, origin, dest, t_start, t_end, n_legs, total_nm,
         o_lat, o_lon, d_lat, d_lon, reg, typ, desc, dbflags) in journeys:
        ts, lat, lon, trk = hex_points(hexid)
        m = (ts >= t_start - 1) & (ts <= t_end + 1)
        if m.sum() < 2:
            continue
        jts, jlat, jlon, jtrk = ts[m], lat[m], lon[m], trk[m]
        far_lat, far_lon = (o_lat, o_lon) if direction == "inbound" else (d_lat, d_lon)
        segs = []
        bounds = split_segments(jts, jlat, jlon)
        budget_scale = 1.0
        total_kept = sum(
            len(downsample(jts[s:e], jlat[s:e], jlon[s:e], jtrk[s:e]))
            for s, e in zip(bounds[:-1], bounds[1:]) if e - s >= 2
        )
        if total_kept > MAX_PTS_PER_JOURNEY:
            budget_scale = MAX_PTS_PER_JOURNEY / total_kept
        for s, e in zip(bounds[:-1], bounds[1:]):
            if e - s < 2:
                continue
            i = downsample(jts[s:e], jlat[s:e], jlon[s:e], jtrk[s:e])
            if budget_scale < 1.0 and len(i) > 4:
                i = i[np.linspace(0, len(i) - 1, max(4, int(len(i) * budget_scale))).astype(int)]
            rec = np.empty((len(i), 4), dtype=np.float32)
            rec[:, 0] = jts[s:e][i] - window_start
            rec[:, 1] = jlon[s:e][i]
            rec[:, 2] = jlat[s:e][i]
            rec[:, 3] = 0
            bufs.append(rec.tobytes())
            segs.append([offset, len(i)])
            offset += len(i)
        if not segs:
            continue
        manifest.append(
            {
                "id": int(jid),
                "hex": hexid,
                "dir": direction,
                "origin": origin,
                "dest": dest,
                "reg": reg,
                "type": typ,
                "desc": desc,
                "mil": bool(dbflags and (int(dbflags) & 1)),
                "nm": total_nm,
                "legs": n_legs,
                "region": region_of(far_lat, far_lon),
                "t_start": float(t_start),
                "t_end": float(t_end),
                "segs": segs,
            }
        )

    with open(OUT_DIR / "points.bin", "wb") as f:
        for b in bufs:
            f.write(b)
    meta = {
        "window_start": window_start,
        "window_end": window_end,
        "n_points": offset,
        "kosh": [KOSH_LON, KOSH_LAT],
        "journeys": manifest,
    }
    with open(OUT_DIR / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, separators=(",", ":"))

    stats = build_stats(con, manifest)
    with open(OUT_DIR / "stats.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, separators=(",", ":"))

    size_mb = (OUT_DIR / "points.bin").stat().st_size / 1e6
    print(f"wrote {offset} points ({size_mb:.1f} MB), {len(manifest)} journeys, stats.json "
          f"({(time.monotonic() - t0) / 60:.1f} min)")


if __name__ == "__main__":
    main()
