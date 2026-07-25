"""Pass 2: extract full traces for all KOSH-visiting aircraft, all 11 days.

Reads the hex set produced by pass 1, then streams every day's tar (including
the 7/14-7/15 lead-in days) pulling the complete daily trace for those hexes.
Membership is decided from the tar member filename, so non-matching traces are
skipped without decompression.

Usage:
    uv run python pipeline/03_extract_traces.py             # all days with data
    uv run python pipeline/03_extract_traces.py 2026-07-14  # specific day(s)
"""

import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import duckdb
import orjson
import pyarrow as pa
import pyarrow.parquet as pq

from config import DATA_DIR, INTERIM_DIR, RAW_DIR, all_days
from scan_common import MultiFileReader, tar_parts

import gzip
import io
import tarfile

SCHEMA = pa.schema(
    [
        ("hex", pa.string()),
        ("ts", pa.float64()),
        ("lat", pa.float64()),
        ("lon", pa.float64()),
        ("alt_ft", pa.int32()),  # -1 = on ground, null = unknown
        ("gs", pa.float32()),
        ("track", pa.float32()),
        ("flags", pa.int32()),
        ("geom_alt", pa.int32()),
    ]
)

FLUSH_ROWS = 2_000_000


def load_kosh_hexes() -> set[str]:
    con = duckdb.connect()
    rows = con.execute(
        f"select distinct hex from read_parquet('{INTERIM_DIR.as_posix()}/kosh_hexes/day=*/part.parquet')"
    ).fetchall()
    return {r[0] for r in rows}


class DayWriter:
    def __init__(self, out_dir: Path):
        out_dir.mkdir(parents=True, exist_ok=True)
        self.writer = pq.ParquetWriter(out_dir / "part.parquet", SCHEMA, compression="zstd")
        self.cols: dict[str, list] = {name: [] for name in SCHEMA.names}
        self.n = 0

    def add(self, hexid: str, doc: dict) -> None:
        base_ts = doc["timestamp"]
        c = self.cols
        for p in doc["trace"]:
            alt = p[3]
            if alt == "ground":
                alt_ft = -1
            elif isinstance(alt, (int, float)):
                alt_ft = int(alt)
            else:
                alt_ft = None
            c["hex"].append(hexid)
            c["ts"].append(base_ts + p[0])
            c["lat"].append(p[1])
            c["lon"].append(p[2])
            c["alt_ft"].append(alt_ft)
            c["gs"].append(p[4])
            c["track"].append(p[5])
            c["flags"].append(p[6] or 0)
            c["geom_alt"].append(int(p[10]) if len(p) > 10 and isinstance(p[10], (int, float)) else None)
            self.n += 1
        if self.n >= FLUSH_ROWS:
            self.flush()

    def flush(self) -> None:
        if self.n:
            self.writer.write_table(pa.table(self.cols, schema=SCHEMA))
            self.cols = {name: [] for name in SCHEMA.names}
            self.n = 0

    def close(self) -> None:
        self.flush()
        self.writer.close()


def extract_day(day_iso: str) -> tuple[str, int, int, float]:
    kosh_hexes = load_kosh_hexes()
    day = date.fromisoformat(day_iso)
    day_dir = RAW_DIR / f"{day:%Y.%m.%d}"
    writer = DayWriter(INTERIM_DIR / "traces" / f"day={day_iso}")
    meta: dict[str, dict] = {}
    n_members = 0
    t0 = time.monotonic()
    reader = io.BufferedReader(MultiFileReader(tar_parts(day_dir)), buffer_size=1 << 22)
    with tarfile.open(fileobj=reader, mode="r|") as tar:
        for member in tar:
            name = member.name
            if "trace_full_" not in name or not member.isfile():
                continue
            hexid = name.rsplit("trace_full_", 1)[1].removesuffix(".json")
            if hexid not in kosh_hexes:
                continue
            fh = tar.extractfile(member)
            if fh is None:
                continue
            raw = fh.read()
            if raw[:2] == b"\x1f\x8b":
                try:
                    raw = gzip.decompress(raw)
                except OSError:
                    continue
            try:
                doc = orjson.loads(raw)
            except orjson.JSONDecodeError:
                continue
            n_members += 1
            writer.add(hexid, doc)
            meta[hexid] = {
                "hex": hexid,
                "r": doc.get("r"),
                "t": doc.get("t"),
                "desc": doc.get("desc"),
                "dbFlags": doc.get("dbFlags"),
                "day": day_iso,
            }
    writer.close()
    meta_dir = INTERIM_DIR / "aircraft_meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(list(meta.values())), meta_dir / f"{day_iso}.parquet")
    return day_iso, n_members, 0, time.monotonic() - t0


def merge_aircraft() -> None:
    """Combine per-day metadata into one row per hex (latest day wins)."""
    con = duckdb.connect()
    out = (DATA_DIR / "processed" / "aircraft.parquet").as_posix()
    (DATA_DIR / "processed").mkdir(parents=True, exist_ok=True)
    con.execute(
        f"""
        copy (
            select hex, r, t, "desc", dbFlags
            from (
                select *, row_number() over (partition by hex order by day desc) rn
                from read_parquet('{INTERIM_DIR.as_posix()}/aircraft_meta/*.parquet')
            ) where rn = 1
        ) to '{out}' (format parquet)
        """
    )
    n = con.execute(f"select count(*) from read_parquet('{out}')").fetchone()[0]
    print(f"aircraft.parquet: {n} unique airframes")


def main() -> None:
    if len(sys.argv) > 1:
        days = sys.argv[1:]
    else:
        days = [d.isoformat() for d in all_days() if (RAW_DIR / f"{d:%Y.%m.%d}").exists()]
    print(f"extracting days: {days} ({len(load_kosh_hexes())} KOSH hexes)")
    with ProcessPoolExecutor(max_workers=min(4, len(days))) as ex:
        for day_iso, n_aircraft, _, dt in ex.map(extract_day, days):
            print(f"[{day_iso}] {n_aircraft} aircraft extracted ({dt / 60:.1f} min)")
    merge_aircraft()


if __name__ == "__main__":
    main()
