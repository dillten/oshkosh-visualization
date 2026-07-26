# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A two-part project that reconstructs and visualizes every aircraft that flew to/from EAA AirVenture
Oshkosh 2026 (KOSH, Wittman Regional): a Python pipeline that turns raw ADS-B archives into per-aircraft
journeys, and a Vite/TypeScript/deck.gl web app that animates them as a timelapse.

- `pipeline/` — Python 3.13, managed by `uv`. Numbered scripts run in order; each stage reads the
  previous stage's Parquet/JSON output.
- `viz/` — Vite + TypeScript + deck.gl + MapLibre static site. Reads pre-computed JSON/binary from
  `viz/public/data/`, produced by `pipeline/05_export_viz.py`, `06_export_aircraft.py`, `07_export_airports.py`.
- `data/` — gitignored. Raw archives, intermediate Parquet, and processed outputs all live here.

## Commands

### Pipeline (run from repo root)

```bash
uv run python pipeline/01_download.py          # ~41 GB of adsb.lol daily split-tar archives
uv run python pipeline/02_scan_kosh.py         # pass 1: find aircraft seen low near KOSH (per-day, parallelizable)
uv run python pipeline/03_extract_traces.py    # pass 2: full traces for those hexes -> Hive-partitioned Parquet
uv run python pipeline/04_flights.py           # leg segmentation, airport snapping, journey chaining
uv run python pipeline/05_export_viz.py        # main timelapse binary (manifest.json + points.bin + stats.json)
uv run python pipeline/06_export_aircraft.py   # per-aircraft detail JSON + search index
uv run python pipeline/07_export_airports.py   # per-airport traffic JSON + search index
```

`02_scan_kosh.py` and `03_extract_traces.py` accept specific ISO dates as CLI args (e.g.
`uv run python pipeline/02_scan_kosh.py 2026-07-20`); with no args they process every day found under
`data/raw/`. Both use `ProcessPoolExecutor` — safe to re-run, each day's output is written independently.

Whenever `04_flights.py` runs, it does a **full overwrite** of `flights.parquet`/`journeys.parquet`.

Explore intermediate/processed Parquet ad hoc with DuckDB, e.g.:
```bash
duckdb -c "select * from read_parquet('data/processed/journeys.parquet') limit 10"
```

### Viz (run from `viz/`)

```bash
npm install
npm run dev       # Vite dev server
npm run build     # tsc typecheck + production build -> viz/dist/ (fully static, host anywhere)
npm run preview   # preview the production build
```

There is no test suite or linter configured in either half of the project. `npm run build` (which runs
`tsc` before `vite build`) is the closest thing to a check for the frontend — always run it after editing
`viz/src/main.ts` before considering a change done.

## Pipeline architecture

Each numbered script is a standalone entry point, but several share logic via two modules that are
**not** part of the numbered sequence:

- `pipeline/config.py` — paths (`RAW_DIR`/`INTERIM_DIR`/`PROCESSED_DIR`/`REFERENCE_DIR`), the show-window
  dates (`LEAD_IN_START`/`SHOW_START`/`LAST_COMPLETE_DAY`, `all_days()`/`show_days()`), and the KOSH
  detection constants (`KOSH_LAT`/`KOSH_LON`/`KOSH_RADIUS_NM`/`KOSH_ALT_CEILING_FT`).
- `pipeline/scan_common.py` — `MultiFileReader` (concatenates a split tar's `.tar.aa`/`.tar.ab`/... parts
  into one stream so `tarfile` can read across them), `tar_parts()`, `iter_trace_members()`. Used by the
  raw-archive-scanning scripts (`02`, `03`).
- `pipeline/viz_common.py` — the shared geometry/segmentation core, used by `04`, `05`, and `06`:
  - `split_segments()`/`downsample()`/`downsample_capped()` — adaptive downsampling and gap/teleport-based
    path splitting for the *rendered* tracks (dense near KOSH, sparse en route; never draws a straight
    line across a coverage gap or an implausible speed jump).
  - `AirportSnapper` (KD-tree over OurAirports data) + `segment_hex()` — splits one aircraft's raw point
    stream into flight legs (on the readsb new-leg flag, a >15 min gap, **or** an implausible-speed jump —
    the last of these was added after a real bug where a single bad GPS point inflated a leg's distance
    into the tens of thousands of nm) and snaps each leg's endpoints to the nearest airport.
  - `journeys_for_hex(hexid, legs, anchor="KOSH")` — chains legs into an inbound/outbound journey pair
    anchored on a given airport (default KOSH).
  - `region_of()` — buckets a lat/lon into Local/Northeast/Southeast/Southwest/Northwest relative to KOSH,
    used for the region color mode and stats.

**Data flow**: `01` downloads → `02` finds candidate hexes (cheap byte-prefilter before JSON parse, so it
doesn't decompress every aircraft) → `03` extracts full traces for only those hexes into
`data/interim/traces/day=YYYY-MM-DD/part.parquet` (Hive-partitioned, read via `read_parquet('.../day=*/part.parquet')`)
→ `04` segments legs and chains journeys into `data/processed/{flights,journeys,aircraft}.parquet` → `05`/`06`/`07`
read those processed Parquet files and the interim traces to produce the static JSON/binary the frontend fetches.

## Viz architecture (`viz/src/main.ts`)

Single-file TypeScript app (no framework, no bundler config beyond Vite defaults). Everything lives in one
`main()` closure; there's no module boundary between subsystems, so read the whole file when making
non-trivial changes rather than assuming one feature is isolated from another.

**Rendering model**: MapLibre GL renders the basemap; a `MapboxOverlay` (deck.gl, non-interleaved) renders
everything else — `TripsLayer` for the animated fading trails/breadcrumbs, `ScatterplotLayer`/`TextLayer`
for markers, `PolygonLayer` for the day/night terminator. `makeLayers(t)` rebuilds the full layer array
every render call; there's no persistent layer state to mutate.

**Two render modes, chosen by whether `selection` is set**:
- No selection: the normal animated timelapse over all ~8,000 journeys (`segments`, loaded once from
  `points.bin` + `manifest.json`).
- A selection active (aircraft/airport/type, via the Explore panel's search tabs): the background layers
  are **replaced entirely**, not dimmed — thousands of overlapping semi-transparent lines alpha-stack back
  up to near-full brightness, so dimming in place doesn't read as "isolated." A fresh selection starts
  "frozen" (whole route revealed at once, clock paused); pressing play or dragging the slider drops the
  freeze and animates just that filtered subset via the shared `timeLayers()` helper, rather than clearing
  the selection back to the full dataset.

**Feature toggles** (radar, night terminator, tour mode) all follow the same shape: a boolean state
variable, a checkbox/button wired to it, and a branch in `makeLayers`/`render`.

Note: `06_export_aircraft.py` still writes `alt_ft` as a 4th element in each per-aircraft leg point
(`data/aircraft/<hex>.json`), added for a 3D altitude-tilt view of a selected aircraft's descent. The
frontend view was later removed (`ed415b3`) as not worth the complexity; the field is otherwise unused
but harmless to leave in place if that view gets revisited.

**Shareable URL state**: current time/speed/color-mode/radar/night/selection encode into `location.hash`
(`history.replaceState`, throttled during playback via `lastUrlSync`, immediate on discrete actions like
selecting something). Parsed back out via `parseInitialState()` at the top of `main()` and re-applied
(including re-running the selection) at the end of `main()`, after the Explore panel's data is loaded.

## Data notes (detection thresholds, worth knowing before changing them)

- "Visited KOSH" = any trace point within 8 nm of the field below 3,500 ft MSL or on ground (catches the
  Fisk/Ripon VFR arrival corridor, excludes en-route overflights).
- Flight legs split on readsb's new-leg flag, a >15 min gap, **or** an implied speed >700 kt over >5 nm
  (teleport/glitch detection — see `viz_common.py` notes above).
- Airport snapping: nearest OurAirports field within 3 nm and below field elevation + 2,000 ft.
- Journeys chain consecutive legs (ground stops <48 h) ending at the first KOSH arrival / starting at the
  last KOSH departure per airframe — this is what resolves a multi-stop, multi-day trip to its true
  origin/destination rather than just the last leg before/after touching KOSH.
