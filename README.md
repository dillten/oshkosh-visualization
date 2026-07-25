# AirVenture Oshkosh 2026 — ADS-B Timelapse

Web-based timelapse of every aircraft arriving at and departing EAA AirVenture
Oshkosh 2026 (KOSH, Wittman Regional), built from [adsb.lol](https://adsb.lol)
open historical data (ODbL/CC0). Aircraft are tracked by ICAO hex across the
whole window (2026-07-14 → 2026-07-24, incl. 2 lead-in days) so multi-stop,
multi-day journeys resolve to their true initial origin and final destination.

## Pipeline (Python, uv)

```
uv run python pipeline/01_download.py       # ~41 GB of daily split-tar archives
uv run python pipeline/02_scan_kosh.py      # pass 1: find aircraft seen low near KOSH
uv run python pipeline/03_extract_traces.py # pass 2: full traces for those hexes -> Parquet
uv run python pipeline/04_flights.py        # legs, airport snapping, journeys
uv run python pipeline/05_export_viz.py     # compact binary for the web app
```

Data layout (all gitignored):

- `data/raw/YYYY.MM.DD/` — adsb.lol split tars (kept; passes re-run without re-download)
- `data/interim/` — `kosh_hexes/`, `traces/` (Hive-partitioned Parquet), `aircraft_meta/`
- `data/processed/` — `flights.parquet`, `journeys.parquet`, `aircraft.parquet`
- `data/reference/airports.csv` — [OurAirports](https://ourairports.com/data/) (public domain)

Explore ad hoc with DuckDB: `duckdb -c "select * from read_parquet('data/processed/journeys.parquet') limit 10"`.

## Viz (Vite + TypeScript + deck.gl + MapLibre)

```
cd viz && npm install && npm run dev
```

TripsLayer renders bright fading trails behind moving aircraft plus a faint
persistent breadcrumb layer of everything flown so far. Blue = inbound to KOSH,
orange = outbound. Play/pause (space), speed control, scrubber.

`npm run build` emits a fully static site (`viz/dist/`) — host anywhere.

## Data notes

- "Visited KOSH" = any trace point within 8 nm of the field below 3,500 ft MSL
  or on ground (catches the Fisk/Ripon arrival, excludes en-route overflights).
- Flight legs split on readsb's new-leg flag or >15 min gaps; endpoints snap to
  the nearest OurAirports field within 3 nm (and below field elev + 2,000 ft).
- Journeys chain consecutive legs (ground stops < 48 h) ending at the first KOSH
  arrival / starting at the last KOSH departure per airframe.
