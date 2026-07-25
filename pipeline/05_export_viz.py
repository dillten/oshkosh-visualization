"""Phase 5: export journeys as compact binary for the web timelapse.

Output (viz/public/data/):
    manifest.json  window metadata + per-journey index into the binary
    points.bin     interleaved Float32 records [t_rel, lon, lat, alt_ft]
                   (t_rel = seconds since window start)

Downsampling: per-leg adaptive — dense near KOSH (the interesting part),
sparse en route; always keeps leg endpoints and big heading changes.
"""

import json
import math
import time

import duckdb
import numpy as np

from config import (
    INTERIM_DIR,
    KOSH_LAT,
    KOSH_LON,
    LEAD_IN_START,
    PROCESSED_DIR,
    PROJECT_ROOT,
)

OUT_DIR = PROJECT_ROOT / "viz" / "public" / "data"
NEAR_KOSH_NM = 20.0
INTERVAL_NEAR_S = 15.0
INTERVAL_FAR_S = 60.0
HEADING_KEEP_DEG = 12.0
MAX_PTS_PER_JOURNEY = 700

NM_PER_DEG_LAT = 60.0
COS_KOSH = math.cos(math.radians(KOSH_LAT))


def downsample(ts, lat, lon, alt, trk):
    """Keep a point if enough time passed since the last kept point (interval
    depends on distance to KOSH) or the heading changed significantly."""
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
    idx = np.array(keep)
    if len(idx) > MAX_PTS_PER_JOURNEY:
        idx = idx[np.linspace(0, len(idx) - 1, MAX_PTS_PER_JOURNEY).astype(int)]
    return idx


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
                  j.n_legs, j.total_nm, ac.r, ac.t, ac."desc", ac.dbFlags
           from j left join ac using (hex) order by j.jid"""
    ).fetchall()
    window_start = int(min(row[5] for row in journeys))
    window_end = int(max(row[6] for row in journeys))
    print(f"{len(journeys)} journeys, window {window_start}..{window_end}")

    # load all trace points for journeys hex set once, grouped by hex
    con.execute(
        f"""
        create temp table pts as
        select p.hex, p.ts, p.lat, p.lon, p.alt_ft, p.track
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
                "select ts, lat, lon, alt_ft, track from pts where hex = ? order by ts", [h]
            ).df()
            arrs = (
                df["ts"].to_numpy(),
                df["lat"].to_numpy(),
                df["lon"].to_numpy(),
                df["alt_ft"].to_numpy(dtype=np.float64),
                df["track"].to_numpy(dtype=np.float64),
            )
            cur_hex = h
        return arrs

    for jid, hexid, direction, origin, dest, t_start, t_end, n_legs, total_nm, reg, typ, desc, dbflags in journeys:
        ts, lat, lon, alt, trk = hex_points(hexid)
        m = (ts >= t_start - 1) & (ts <= t_end + 1)
        if m.sum() < 2:
            continue
        i = downsample(ts[m], lat[m], lon[m], alt[m], trk[m])
        jts, jlat, jlon, jalt = ts[m][i], lat[m][i], lon[m][i], alt[m][i]
        jalt = np.where(np.isnan(jalt) | (jalt < 0), 0, jalt)
        rec = np.empty((len(i), 4), dtype=np.float32)
        rec[:, 0] = jts - window_start
        rec[:, 1] = jlon
        rec[:, 2] = jlat
        rec[:, 3] = jalt
        bufs.append(rec.tobytes())
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
                "mil": bool(dbflags and (dbflags & 1)),
                "nm": total_nm,
                "legs": n_legs,
                "off": offset,
                "n": len(i),
            }
        )
        offset += len(i)

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
    size_mb = (OUT_DIR / "points.bin").stat().st_size / 1e6
    print(f"wrote {offset} points ({size_mb:.1f} MB) + manifest for {len(manifest)} journeys "
          f"({(time.monotonic() - t0) / 60:.1f} min)")


if __name__ == "__main__":
    main()
