"""Phase 7: per-airport traffic export for the "airport traffic" feature.

Output (viz/public/data/):
    airport_index.json      search/autocomplete index (ident, name, city, counts)
    airports/<IDENT>.json   every flight leg touching that airport (as either
                             endpoint), with the aircraft and the OTHER endpoint

This uses flights.parquet directly (every leg, not just the KOSH-bound
journey chains), so an airport that only appears as a mid-trip fuel stop is
still found here even though it wouldn't be a journey's origin/destination.
"""

import json
import re
import time

import duckdb

from config import PROCESSED_DIR, PROJECT_ROOT, REFERENCE_DIR

OUT_DIR = PROJECT_ROOT / "viz" / "public" / "data"
AIRPORTS_DIR = OUT_DIR / "airports"
SAFE_IDENT = re.compile(r"^[A-Za-z0-9_-]+$")


def main() -> None:
    t0 = time.monotonic()
    AIRPORTS_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    flights = (PROCESSED_DIR / "flights.parquet").as_posix()
    aircraft = (PROCESSED_DIR / "aircraft.parquet").as_posix()
    airports_csv = (REFERENCE_DIR / "airports.csv").as_posix()

    con.execute(f"create temp table fl as select * from read_parquet('{flights}')")
    con.execute(f"create temp table ac as select * from read_parquet('{aircraft}')")
    con.execute(
        f"""
        create temp table apt as
        select coalesce(nullif(icao_code,''), nullif(gps_code,''), ident) as ident,
               any_value(name) as apt_name, any_value(municipality) as city,
               any_value(iso_region) as iso_region, any_value(latitude_deg) as lat,
               any_value(longitude_deg) as lon
        from read_csv('{airports_csv}', header=true)
        group by 1
        """
    )

    touches = con.execute(
        """
        select to_apt as ident, hex, 'arrival' as direction, from_apt as other, t_start, t_end
        from fl where to_apt is not null
        union all
        select from_apt as ident, hex, 'departure' as direction, to_apt as other, t_start, t_end
        from fl where from_apt is not null
        order by ident, t_start
        """
    ).fetchall()

    ac_rows = con.execute('select hex, r, t, "desc" from ac').fetchall()
    ac_meta = {row[0]: row[1:] for row in ac_rows}

    by_ident: dict[str, list] = {}
    for ident, hexid, direction, other, t_start, t_end in touches:
        by_ident.setdefault(ident, []).append((hexid, direction, other, t_start, t_end))

    apt_meta = {
        row[0]: {"name": row[1], "city": row[2], "iso_region": row[3], "lat": row[4], "lon": row[5]}
        for row in con.execute("select ident, apt_name, city, iso_region, lat, lon from apt").fetchall()
    }

    index = []
    n = 0
    for ident, rows in by_ident.items():
        if not ident or not SAFE_IDENT.match(ident):
            continue
        n_arr = sum(1 for r in rows if r[1] == "arrival")
        n_dep = sum(1 for r in rows if r[1] == "departure")
        meta = apt_meta.get(ident, {})
        detail_rows = []
        for hexid, direction, other, t_start, t_end in sorted(rows, key=lambda r: r[3]):
            reg, typ, desc = ac_meta.get(hexid, (None, None, None))
            detail_rows.append(
                {
                    "hex": hexid,
                    "reg": reg,
                    "type": typ,
                    "desc": desc,
                    "dir": direction,
                    "other": other,
                    "t_start": float(t_start),
                    "t_end": float(t_end),
                }
            )
        with open(AIRPORTS_DIR / f"{ident}.json", "w", encoding="utf-8") as f:
            json.dump(
                {"ident": ident, **meta, "arrivals": n_arr, "departures": n_dep, "touches": detail_rows},
                f,
                separators=(",", ":"),
            )
        index.append(
            {
                "ident": ident,
                "name": meta.get("name"),
                "city": meta.get("city"),
                "iso_region": meta.get("iso_region"),
                "lat": meta.get("lat"),
                "lon": meta.get("lon"),
                "arrivals": n_arr,
                "departures": n_dep,
            }
        )
        n += 1

    index.sort(key=lambda a: -(a["arrivals"] + a["departures"]))
    with open(OUT_DIR / "airport_index.json", "w", encoding="utf-8") as f:
        json.dump({"airports": index}, f, separators=(",", ":"))

    print(f"{n} airport traffic files written ({(time.monotonic() - t0) / 60:.1f} min)")


if __name__ == "__main__":
    main()
