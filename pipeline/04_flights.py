"""Phase 4: segment traces into flight legs, snap endpoints to airports,
chain legs into journeys, and compute each aircraft's initial origin and
final destination relative to its KOSH visit.

Outputs:
    data/processed/flights.parquet   one row per flight leg
    data/processed/journeys.parquet  one row per hex+direction (in/out)
"""

import csv
import math
import time
from datetime import date

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from scipy.spatial import cKDTree

from config import (
    INTERIM_DIR,
    KOSH_ALT_CEILING_FT,
    KOSH_LAT,
    KOSH_LON,
    KOSH_RADIUS_NM,
    PROCESSED_DIR,
    REFERENCE_DIR,
)

GAP_SPLIT_S = 900          # time gap that forces a new leg
MIN_LEG_POINTS = 15
MIN_LEG_DURATION_S = 120
SNAP_RADIUS_NM = 3.0       # endpoint-to-airport max distance
SNAP_AGL_FT = 2000         # endpoint must be below airport elev + this
EARTH_NM = 3440.065

AIRPORT_TYPES = {"small_airport", "medium_airport", "large_airport", "seaplane_base"}


def load_airports():
    idents, lats, lons, elevs, names = [], [], [], [], []
    with open(REFERENCE_DIR / "airports.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["type"] not in AIRPORT_TYPES:
                continue
            try:
                lat, lon = float(row["latitude_deg"]), float(row["longitude_deg"])
            except ValueError:
                continue
            ident = row["icao_code"] or row["gps_code"] or row["ident"]
            idents.append(ident)
            lats.append(lat)
            lons.append(lon)
            elevs.append(float(row["elevation_ft"]) if row["elevation_ft"] else 0.0)
            names.append(row["name"])
    lats, lons = np.array(lats), np.array(lons)
    xyz = latlon_to_xyz(lats, lons)
    return cKDTree(xyz), idents, lats, lons, np.array(elevs), names


def latlon_to_xyz(lat_deg, lon_deg):
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def chord_to_nm(chord):
    return 2.0 * EARTH_NM * np.arcsin(np.clip(chord / 2.0, 0, 1))


class AirportSnapper:
    def __init__(self):
        self.tree, self.idents, self.lats, self.lons, self.elevs, self.names = load_airports()

    def snap(self, lat: float, lon: float, alt_ft: float | None) -> str | None:
        """Return airport ident if (lat, lon, alt) plausibly sits at one."""
        d, i = self.tree.query(latlon_to_xyz(np.array([lat]), np.array([lon]))[0])
        dist_nm = float(chord_to_nm(np.array([d]))[0])
        if dist_nm > SNAP_RADIUS_NM:
            return None
        if alt_ft is not None and alt_ft >= 0 and alt_ft > self.elevs[i] + SNAP_AGL_FT:
            return None
        return self.idents[i]


def dist_nm(lat1, lon1, lat2, lon2) -> float:
    a = latlon_to_xyz(np.array([lat1]), np.array([lon1]))
    b = latlon_to_xyz(np.array([lat2]), np.array([lon2]))
    return float(chord_to_nm(np.linalg.norm(a - b, axis=1))[0])


def near_kosh(lat, lon, alt_ft) -> bool:
    d = dist_nm(lat, lon, KOSH_LAT, KOSH_LON)
    low = alt_ft is None or alt_ft < 0 or alt_ft <= KOSH_ALT_CEILING_FT
    return d <= KOSH_RADIUS_NM and low


def path_length_nm(lats, lons) -> float:
    if len(lats) < 2:
        return 0.0
    xyz = latlon_to_xyz(lats, lons)
    seg = np.linalg.norm(np.diff(xyz, axis=0), axis=1)
    return float(chord_to_nm(seg).sum())


def segment_hex(ts, lat, lon, alt, flags, snapper: AirportSnapper) -> list[dict]:
    """Split one aircraft's 11-day point stream into flight legs."""
    order = np.argsort(ts)
    ts, lat, lon, alt, flags = ts[order], lat[order], lon[order], alt[order], flags[order]
    # dedupe identical timestamps (possible at day-file boundaries)
    keep = np.concatenate([[True], np.diff(ts) > 0.5])
    ts, lat, lon, alt, flags = ts[keep], lat[keep], lon[keep], alt[keep], flags[keep]

    new_leg = (flags.astype(np.int64) & 2) != 0
    gap = np.concatenate([[False], np.diff(ts) > GAP_SPLIT_S])
    starts = np.flatnonzero(new_leg | gap)
    bounds = np.concatenate([[0], starts, [len(ts)]])
    bounds = np.unique(bounds)

    legs = []
    for i in range(len(bounds) - 1):
        s, e = int(bounds[i]), int(bounds[i + 1])
        if e - s < MIN_LEG_POINTS or ts[e - 1] - ts[s] < MIN_LEG_DURATION_S:
            continue
        # ignore legs that never leave the ground (taxi-only)
        leg_alt = alt[s:e]
        airborne = leg_alt[~np.isnan(leg_alt)]
        if len(airborne) and (airborne <= 0).all():
            continue
        a_start = None if np.isnan(alt[s]) else float(alt[s])
        a_end = None if np.isnan(alt[e - 1]) else float(alt[e - 1])
        from_apt = snapper.snap(float(lat[s]), float(lon[s]), a_start)
        to_apt = snapper.snap(float(lat[e - 1]), float(lon[e - 1]), a_end)
        if near_kosh(float(lat[s]), float(lon[s]), a_start):
            from_apt = "KOSH"
        if near_kosh(float(lat[e - 1]), float(lon[e - 1]), a_end):
            to_apt = "KOSH"
        legs.append(
            {
                "t_start": float(ts[s]),
                "t_end": float(ts[e - 1]),
                "from_apt": from_apt,
                "to_apt": to_apt,
                "from_lat": float(lat[s]),
                "from_lon": float(lon[s]),
                "to_lat": float(lat[e - 1]),
                "to_lon": float(lon[e - 1]),
                "n_points": e - s,
                "path_nm": round(path_length_nm(lat[s:e], lon[s:e]), 1),
            }
        )
    return legs


def journeys_for_hex(hexid: str, legs: list[dict]) -> list[dict]:
    """Inbound journey = legs up to the first KOSH arrival; outbound = legs
    from the last KOSH departure onward."""
    out = []
    kosh_arr = [i for i, l in enumerate(legs) if l["to_apt"] == "KOSH" and l["from_apt"] != "KOSH"]
    kosh_dep = [i for i, l in enumerate(legs) if l["from_apt"] == "KOSH" and l["to_apt"] != "KOSH"]
    if kosh_arr:
        i = kosh_arr[0]
        chain = legs[: i + 1]
        # trim leading legs that are clearly a different trip (>48h ground stop)
        trimmed = [chain[-1]]
        for prev in reversed(chain[:-1]):
            if trimmed[0]["t_start"] - prev["t_end"] > 48 * 3600:
                break
            trimmed.insert(0, prev)
        out.append(
            {
                "hex": hexid,
                "direction": "inbound",
                "origin": trimmed[0]["from_apt"],
                "destination": "KOSH",
                "t_start": trimmed[0]["t_start"],
                "t_end": trimmed[-1]["t_end"],
                "n_legs": len(trimmed),
                "total_nm": round(sum(l["path_nm"] for l in trimmed), 1),
                "leg_t_starts": [l["t_start"] for l in trimmed],
            }
        )
    if kosh_dep:
        i = kosh_dep[-1]
        chain = legs[i:]
        trimmed = [chain[0]]
        for nxt in chain[1:]:
            if nxt["t_start"] - trimmed[-1]["t_end"] > 48 * 3600:
                break
            trimmed.append(nxt)
        out.append(
            {
                "hex": hexid,
                "direction": "outbound",
                "origin": "KOSH",
                "destination": trimmed[-1]["to_apt"],
                "t_start": trimmed[0]["t_start"],
                "t_end": trimmed[-1]["t_end"],
                "n_legs": len(trimmed),
                "total_nm": round(sum(l["path_nm"] for l in trimmed), 1),
                "leg_t_starts": [l["t_start"] for l in trimmed],
            }
        )
    return out


def main() -> None:
    t0 = time.monotonic()
    snapper = AirportSnapper()
    print(f"airport index: {len(snapper.idents)} airports")
    con = duckdb.connect()
    traces_glob = f"{INTERIM_DIR.as_posix()}/traces/day=*/part.parquet"
    reader = con.execute(
        f"""
        select hex, ts, lat, lon,
               cast(alt_ft as double) alt_ft,
               coalesce(flags, 0) flags
        from read_parquet('{traces_glob}')
        order by hex, ts
        """
    ).fetch_record_batch(1_000_000)

    flights, journeys = [], []
    cur_hex = None
    buf: dict[str, list[np.ndarray]] = {k: [] for k in ("ts", "lat", "lon", "alt", "flags")}
    n_hex = 0

    def process_current():
        nonlocal n_hex
        if cur_hex is None:
            return
        arrs = {k: np.concatenate(v) for k, v in buf.items()}
        legs = segment_hex(arrs["ts"], arrs["lat"], arrs["lon"], arrs["alt"], arrs["flags"], snapper)
        for idx, leg in enumerate(legs):
            flights.append({"hex": cur_hex, "leg_idx": idx, **leg})
        journeys.extend(journeys_for_hex(cur_hex, legs))
        n_hex += 1
        if n_hex % 2000 == 0:
            print(f"  {n_hex} aircraft processed ({time.monotonic() - t0:.0f}s)")

    for batch in reader:
        hexes = batch.column("hex").to_numpy(zero_copy_only=False)
        ts = batch.column("ts").to_numpy(zero_copy_only=False)
        lat = batch.column("lat").to_numpy(zero_copy_only=False)
        lon = batch.column("lon").to_numpy(zero_copy_only=False)
        alt = batch.column("alt_ft").to_numpy(zero_copy_only=False).astype(np.float64)
        flags = batch.column("flags").to_numpy(zero_copy_only=False)
        # split batch at hex boundaries
        change = np.flatnonzero(hexes[1:] != hexes[:-1]) + 1
        pieces = np.split(np.arange(len(hexes)), change)
        for piece in pieces:
            h = hexes[piece[0]]
            if h != cur_hex:
                process_current()
                cur_hex = h
                for v in buf.values():
                    v.clear()
            buf["ts"].append(ts[piece])
            buf["lat"].append(lat[piece])
            buf["lon"].append(lon[piece])
            buf["alt"].append(alt[piece])
            buf["flags"].append(flags[piece])
    process_current()

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(flights), PROCESSED_DIR / "flights.parquet")
    pq.write_table(pa.Table.from_pylist(journeys), PROCESSED_DIR / "journeys.parquet")
    print(f"{n_hex} aircraft -> {len(flights)} legs, {len(journeys)} journeys "
          f"({(time.monotonic() - t0) / 60:.1f} min)")

    # quick sanity stats
    con2 = duckdb.connect()
    fj = (PROCESSED_DIR / "journeys.parquet").as_posix()
    print(con2.execute(
        f"""select direction, count(*) n, round(avg(n_legs),2) avg_legs,
            round(avg(total_nm)) avg_nm from read_parquet('{fj}') group by 1"""
    ).df().to_string(index=False))


if __name__ == "__main__":
    main()
