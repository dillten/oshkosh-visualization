"""Pass 1: find every aircraft seen low near KOSH on each show day.

Streams each day's split tar without extracting to disk. A cheap byte-level
substring prefilter rejects ~99% of traces before JSON parsing.

Usage:
    uv run python pipeline/02_scan_kosh.py             # all show days with data
    uv run python pipeline/02_scan_kosh.py 2026-07-20  # specific day(s)
"""

import math
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import orjson
import pyarrow as pa
import pyarrow.parquet as pq

from config import (
    INTERIM_DIR,
    KOSH_ALT_CEILING_FT,
    KOSH_LAT,
    KOSH_LON,
    KOSH_RADIUS_NM,
    RAW_DIR,
    show_days,
)
from scan_common import iter_trace_members

# Bounding box comfortably containing the KOSH radius (8 nm ≈ 0.133° lat)
LAT_MIN, LAT_MAX = KOSH_LAT - 0.16, KOSH_LAT + 0.16
LON_MIN, LON_MAX = KOSH_LON - 0.23, KOSH_LON + 0.23

# Substring prefilter: any point inside the box must serialize a lat starting
# 43.8/43.9/44.0/44.1 and a lon starting -88.3..-88.7. False positives are
# re-checked by the real parse; false negatives are impossible for in-box points.
LAT_TOKENS = (b"43.8", b"43.9", b"44.0", b"44.1")
LON_TOKENS = (b"-88.3", b"-88.4", b"-88.5", b"-88.6", b"-88.7")

NM_PER_DEG_LAT = 60.0
COS_LAT = math.cos(math.radians(KOSH_LAT))


def kosh_hits(doc: dict) -> dict | None:
    base_ts = doc["timestamp"]
    first_ts = last_ts = None
    min_dist = 1e9
    min_alt = None
    saw_ground = False
    n_hits = 0
    for p in doc["trace"]:
        lat, lon = p[1], p[2]
        if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
            continue
        alt = p[3]
        on_ground = alt == "ground"
        if not on_ground:
            # altitude must be KNOWN and low — unknown-alt points are how
            # cruising overflights sneak in (baro alt with geom fallback)
            alt_val = alt if isinstance(alt, (int, float)) else (
                p[10] if len(p) > 10 and isinstance(p[10], (int, float)) else None
            )
            if alt_val is None or alt_val > KOSH_ALT_CEILING_FT:
                continue
            min_alt = alt_val if min_alt is None else min(min_alt, alt_val)
        dlat = (lat - KOSH_LAT) * NM_PER_DEG_LAT
        dlon = (lon - KOSH_LON) * NM_PER_DEG_LAT * COS_LAT
        dist = math.hypot(dlat, dlon)
        if dist > KOSH_RADIUS_NM:
            continue
        ts = base_ts + p[0]
        if first_ts is None:
            first_ts = ts
        last_ts = ts
        min_dist = min(min_dist, dist)
        saw_ground = saw_ground or on_ground
        n_hits += 1
    # a single qualifying point is more likely a glitch than a visit
    if first_ts is None or n_hits < 2:
        return None
    return {
        "first_ts": first_ts,
        "last_ts": last_ts,
        "min_dist_nm": round(min_dist, 2),
        "min_alt_ft": -1 if saw_ground else int(min_alt) if min_alt is not None else None,
        "saw_ground": saw_ground,
        "n_hits": n_hits,
    }


def scan_day(day_iso: str) -> tuple[str, int, int, float]:
    day = date.fromisoformat(day_iso)
    day_dir = RAW_DIR / f"{day:%Y.%m.%d}"
    out_path = INTERIM_DIR / "kosh_hexes" / f"day={day_iso}" / "part.parquet"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    n_total = 0
    t0 = time.monotonic()
    for hexid, raw in iter_trace_members(day_dir):
        n_total += 1
        if not (any(t in raw for t in LON_TOKENS) and any(t in raw for t in LAT_TOKENS)):
            continue
        try:
            doc = orjson.loads(raw)
        except orjson.JSONDecodeError:
            continue
        hit = kosh_hits(doc)
        if hit is None:
            continue
        rows.append(
            {
                "day": day_iso,
                "hex": hexid,
                "r": doc.get("r"),
                "t": doc.get("t"),
                "desc": doc.get("desc"),
                "dbFlags": doc.get("dbFlags"),
                **hit,
            }
        )
    table = pa.Table.from_pylist(rows)
    pq.write_table(table, out_path)
    dt = time.monotonic() - t0
    return day_iso, n_total, len(rows), dt


def main() -> None:
    if len(sys.argv) > 1:
        days = sys.argv[1:]
    else:
        days = [d.isoformat() for d in show_days() if (RAW_DIR / f"{d:%Y.%m.%d}").exists()]
    print(f"scanning days: {days}")
    with ProcessPoolExecutor(max_workers=min(4, len(days))) as ex:
        for day_iso, n_total, n_kosh, dt in ex.map(scan_day, days):
            print(f"[{day_iso}] {n_total} traces scanned, {n_kosh} KOSH visitors ({dt / 60:.1f} min)")


if __name__ == "__main__":
    main()
