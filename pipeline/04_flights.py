"""Phase 4: segment traces into flight legs, snap endpoints to airports,
chain legs into journeys, and compute each aircraft's initial origin and
final destination relative to its KOSH visit.

Outputs:
    data/processed/flights.parquet   one row per flight leg
    data/processed/journeys.parquet  one row per hex+direction (in/out)
"""

import time

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from config import INTERIM_DIR, PROCESSED_DIR
from viz_common import AirportSnapper, journeys_for_hex, segment_hex


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
