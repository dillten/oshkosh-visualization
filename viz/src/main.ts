import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { TripsLayer } from "@deck.gl/geo-layers";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";

type RGB = [number, number, number];

const DIR_COLORS: Record<string, RGB> = {
  inbound: [57, 135, 229], // #3987e5
  outbound: [217, 89, 38], // #d95926
};
const REGION_COLORS: Record<string, RGB> = {
  Local: [213, 81, 129], // #d55181
  Northeast: [57, 135, 229], // #3987e5
  Southeast: [217, 89, 38], // #d95926
  Southwest: [25, 158, 112], // #199e70
  Northwest: [201, 133, 0], // #c98500
  Unknown: [137, 135, 129], // #898781
};
const HIGHLIGHT_LEG: RGB = [255, 255, 255];
const KOSH_LEG: RGB = [57, 135, 229];
const DEP_LEG: RGB = [217, 89, 38];
const SELECT_MARKER: RGB = [237, 161, 0]; // #eda100

// IEM NEXRAD CONUS composite (n0r): 5-min cadence PNG archive, CORS-open,
// fixed bounds/size for the whole archive (EPSG:4326, 0.01 deg/px).
const RADAR_BUCKET_S = 300;
const RADAR_BOUNDS: [[number, number], [number, number], [number, number], [number, number]] = [
  [-126, 50], // NW
  [-66, 50], // NE
  [-66, 24], // SE
  [-126, 24], // SW
];
function radarUrl(epochS: number): string {
  const d = new Date(Math.floor(epochS / RADAR_BUCKET_S) * RADAR_BUCKET_S * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear(), m = pad(d.getUTCMonth() + 1), day = pad(d.getUTCDate());
  const hm = pad(d.getUTCHours()) + pad(d.getUTCMinutes());
  return `https://mesonet.agron.iastate.edu/archive/data/${y}/${m}/${day}/GIS/uscomp/n0r_${y}${m}${day}${hm}.png`;
}

// ---------- data shapes ----------

interface JourneyMeta {
  id: number;
  hex: string;
  dir: "inbound" | "outbound";
  origin: string | null;
  dest: string | null;
  reg: string | null;
  type: string | null;
  desc: string | null;
  mil: boolean;
  nm: number;
  legs: number;
  region: string;
  t_start: number;
  t_end: number;
  segs: [number, number][];
}

interface Manifest {
  window_start: number;
  window_end: number;
  n_points: number;
  kosh: [number, number];
  journeys: JourneyMeta[];
}

interface Segment {
  meta: JourneyMeta;
  path: [number, number][];
  timestamps: number[];
  t0: number;
  t1: number;
}

interface LegSegment {
  leg: AircraftLeg;
  path: [number, number][];
  timestamps: number[];
  t0: number;
  t1: number;
}

interface AircraftIndexRow {
  hex: string;
  reg: string | null;
  type: string | null;
  desc: string | null;
  mil: boolean;
  n_legs: number;
  first_ts: number;
  last_ts: number;
  time_aloft_s: number;
  kosh_arrival_ts: number | null;
  kosh_departure_ts: number | null;
}

interface AircraftLeg {
  idx: number;
  t_start: number;
  t_end: number;
  duration_s: number;
  from: string | null;
  to: string | null;
  nm: number;
  path: [number, number, number][]; // t_rel, lon, lat
}

interface AircraftDetail {
  hex: string;
  reg: string | null;
  type: string | null;
  desc: string | null;
  mil: boolean;
  legs: AircraftLeg[];
}

interface AirportIndexRow {
  ident: string;
  name: string | null;
  city: string | null;
  iso_region: string | null;
  lat: number | null;
  lon: number | null;
  arrivals: number;
  departures: number;
}

interface AirportTouch {
  hex: string;
  reg: string | null;
  type: string | null;
  desc: string | null;
  dir: "arrival" | "departure";
  other: string | null;
  t_start: number;
  t_end: number;
}

interface AirportDetail extends AirportIndexRow {
  touches: AirportTouch[];
}

interface Stats {
  totals: { aircraft: number; inbound: number; outbound: number };
  daily: { day: string; inbound: number; outbound: number }[];
  regions: { region: string; inbound: number; outbound: number }[];
  top_origins: { ident: string; name: string | null; city: string | null; n: number }[];
  top_dests: { ident: string; name: string | null; city: string | null; n: number }[];
  top_types: { label: string; n: number }[];
}

// ---------- selection state ----------

type Selection =
  | { kind: "aircraft"; hex: string; detail: AircraftDetail }
  | { kind: "airport"; ident: string; detail: AirportDetail }
  | { kind: "type"; label: string; matches: JourneyMeta[] };

// ---------- helpers ----------

async function loadData() {
  const [manifest, bin] = await Promise.all([
    fetch("data/manifest.json").then((r) => r.json() as Promise<Manifest>),
    fetch("data/points.bin").then((r) => r.arrayBuffer()),
  ]);
  const f = new Float32Array(bin);
  const segments: Segment[] = [];
  for (const meta of manifest.journeys) {
    for (const [off, n] of meta.segs) {
      const path: [number, number][] = new Array(n);
      const timestamps: number[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const base = (off + i) * 4;
        timestamps[i] = f[base];
        path[i] = [f[base + 1], f[base + 2]];
      }
      segments.push({ meta, path, timestamps, t0: timestamps[0], t1: timestamps[n - 1] });
    }
  }
  return { manifest, segments };
}

function fmtClock(epochS: number): string {
  return new Date(epochS * 1000).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDateShort(epochS: number): string {
  return new Date(epochS * 1000).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

type ColorMode = "dir" | "region";

function colorFor(meta: JourneyMeta, mode: ColorMode): RGB {
  if (mode === "dir") return DIR_COLORS[meta.dir];
  return REGION_COLORS[meta.region] ?? REGION_COLORS.Unknown;
}

interface TimeLayerStyle {
  breadcrumbOpacity?: number;
  trailOpacity?: number;
  trailWidth?: number;
  trailLength?: number;
}

/**
 * Renders a (sub)set of trips either as a single fully-revealed static path
 * (frozen — the "here's the whole route" entry view for a fresh selection)
 * or as the usual dim-breadcrumb + fading-trail pair driven by the live
 * playhead (once the user hits play or drags the slider). `windowEnd` is the
 * global T1 — used as the "reveal" currentTime since every timestamp in any
 * subset is expressed relative to the same window start.
 */
function timeLayers<T>(
  idPrefix: string,
  data: T[],
  getPath: (d: T) => [number, number][],
  getTimestamps: (d: T) => number[],
  getColor: (d: T) => RGB,
  frozen: boolean,
  t: number,
  windowEnd: number,
  style: TimeLayerStyle = {}
) {
  if (frozen) {
    return [
      new TripsLayer<T>({
        id: `${idPrefix}-reveal`,
        data,
        getPath,
        getTimestamps,
        getColor,
        currentTime: windowEnd,
        trailLength: windowEnd,
        fadeTrail: false,
        widthMinPixels: style.trailWidth ?? 2,
        opacity: style.trailOpacity ?? 0.85,
      }),
    ];
  }
  return [
    new TripsLayer<T>({
      id: `${idPrefix}-breadcrumb`,
      data,
      getPath,
      getTimestamps,
      getColor,
      currentTime: t,
      trailLength: windowEnd,
      fadeTrail: false,
      widthMinPixels: 1,
      opacity: style.breadcrumbOpacity ?? 0.15,
    }),
    new TripsLayer<T>({
      id: `${idPrefix}-trail`,
      data,
      getPath,
      getTimestamps,
      getColor,
      currentTime: t,
      trailLength: style.trailLength ?? 1200,
      fadeTrail: true,
      widthMinPixels: style.trailWidth ?? 2,
      opacity: style.trailOpacity ?? 0.9,
    }),
  ];
}

function renderLegend(mode: ColorMode) {
  const el = document.getElementById("legend")!;
  const entries =
    mode === "dir"
      ? [
          ["Inbound to KOSH", "#3987e5"],
          ["Outbound from KOSH", "#d95926"],
        ]
      : [
          ["Local (<100 nm)", "#d55181"],
          ["Northeast", "#3987e5"],
          ["Southeast", "#d95926"],
          ["Southwest", "#199e70"],
          ["Northwest", "#c98500"],
          ["Unknown", "#898781"],
        ];
  el.innerHTML = entries
    .map(
      ([label, color]) =>
        `<span class="key"><i class="swatch" style="background:${color}"></i>${label}</span>`
    )
    .join("");
}

function barRow(label: string, value: number, max: number, color: string, sub = ""): string {
  const w = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return `<div class="bar-row" title="${escapeHtml(label)}${sub ? " — " + escapeHtml(sub) : ""}">
    <span class="bar-label">${escapeHtml(label)}</span>
    <span class="bar-track"><i style="width:${w}%;background:${color}"></i></span>
    <span class="bar-val">${value.toLocaleString()}</span>
  </div>`;
}

async function renderOverview(body: HTMLElement) {
  const s: Stats = await fetch("data/stats.json").then((r) => r.json());
  const dayMax = Math.max(...s.daily.map((d) => Math.max(d.inbound, d.outbound)));
  const originMax = Math.max(...s.top_origins.map((o) => o.n), 1);
  const destMax = Math.max(...s.top_dests.map((o) => o.n), 1);
  const typeMax = Math.max(...s.top_types.map((t) => t.n), 1);
  const regionMax = Math.max(...s.regions.map((r) => Math.max(r.inbound, r.outbound)), 1);
  const fmtDay = (d: string) =>
    new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });

  body.innerHTML = `
    <div class="stat-tiles">
      <div class="tile"><div class="tile-num">${s.totals.aircraft.toLocaleString()}</div><div class="tile-cap">aircraft</div></div>
      <div class="tile"><div class="tile-num">${s.totals.inbound.toLocaleString()}</div><div class="tile-cap">arrivals</div></div>
      <div class="tile"><div class="tile-num">${s.totals.outbound.toLocaleString()}</div><div class="tile-cap">departures</div></div>
    </div>
    <h3>Arrivals &amp; departures by day</h3>
    <div class="chart">${s.daily
      .map(
        (d) => `
      <div class="day-group">
        <span class="bar-label">${fmtDay(d.day)}</span>
        <span class="day-bars">
          <span class="bar-track"><i style="width:${(d.inbound / dayMax) * 100}%;background:#3987e5"></i></span>
          <span class="bar-track"><i style="width:${(d.outbound / dayMax) * 100}%;background:#d95926"></i></span>
        </span>
        <span class="bar-val">${d.inbound} / ${d.outbound}</span>
      </div>`
      )
      .join("")}</div>
    <div class="chart-note"><i class="swatch" style="background:#3987e5"></i> arrivals&ensp;<i class="swatch" style="background:#d95926"></i> departures</div>
    <h3>Origin region of arrivals</h3>
    <div class="chart">${s.regions
      .map((r) => barRow(r.region, r.inbound, regionMax, REGION_COLORS[r.region] ? `rgb(${REGION_COLORS[r.region].join(",")})` : "#898781"))
      .join("")}</div>
    <h3>Top origins (arrivals)</h3>
    <div class="chart">${s.top_origins
      .map((o) => barRow(o.ident, o.n, originMax, "#3987e5", o.name ?? ""))
      .join("")}</div>
    <h3>Top destinations (departures)</h3>
    <div class="chart">${s.top_dests
      .map((o) => barRow(o.ident, o.n, destMax, "#d95926", o.name ?? ""))
      .join("")}</div>
    <h3>Top aircraft types</h3>
    <div class="chart">${s.top_types
      .map((t) => barRow(t.label ?? "?", t.n, typeMax, "#199e70"))
      .join("")}</div>
  `;
}

// ---------- main ----------

async function main() {
  const { manifest, segments } = await loadData();
  const T0 = 0;
  const T1 = manifest.window_end - manifest.window_start;
  const journeys = manifest.journeys;

  const [aircraftIndexRaw, airportIndexRaw] = await Promise.all([
    fetch("data/aircraft_index.json").then((r) => r.json()),
    fetch("data/airport_index.json").then((r) => r.json()),
  ]);
  const aircraftIndex: AircraftIndexRow[] = aircraftIndexRaw.aircraft;
  const airportIndex: AirportIndexRow[] = airportIndexRaw.airports;
  const distinctTypes = Array.from(
    new Map(
      aircraftIndex
        .filter((a) => a.type || a.desc)
        .map((a) => [a.desc ?? a.type ?? "", { label: a.desc ?? a.type ?? "", type: a.type }])
    ).values()
  ).sort((a, b) => a.label.localeCompare(b.label));

  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [-90.5, 41.5],
    zoom: 4.6,
    attributionControl: { compact: true },
  });

  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay as unknown as maplibregl.IControl);

  let current = T0;
  let playing = true;
  let wasPlayingBeforeSelection = true;
  let speed = 1800;
  let colorMode: ColorMode = "dir";
  let selection: Selection | null = null;
  // A fresh selection starts "frozen" (full route revealed, clock paused).
  // Pressing play or dragging the slider unfreezes it so play/scrub animate
  // within the filtered subset instead of clearing the selection.
  let selectionFrozen = true;
  let lastFrame = performance.now();

  // ----- radar overlay (opt-in; NEXRAD CONUS composite via IEM Mesonet) -----
  let radarEnabled = false;
  let radarReady = false;
  let lastRadarBucket = -1;
  map.on("load", () => {
    map.addSource("radar", {
      type: "image",
      url: radarUrl(manifest.window_start),
      coordinates: RADAR_BOUNDS,
    });
    map.addLayer({
      id: "radar-layer",
      type: "raster",
      source: "radar",
      paint: { "raster-opacity": 0.55, "raster-fade-duration": 200 },
      layout: { visibility: "none" },
    });
    radarReady = true;
  });

  function updateRadar(t: number) {
    if (!radarReady || !radarEnabled || selection) return;
    const epoch = manifest.window_start + t;
    const bucket = Math.floor(epoch / RADAR_BUCKET_S);
    if (bucket === lastRadarBucket) return;
    lastRadarBucket = bucket;
    const src = map.getSource("radar") as maplibregl.ImageSource | undefined;
    src?.updateImage({ url: radarUrl(epoch) });
  }

  const playBtn = document.getElementById("play") as HTMLButtonElement;
  const scrub = document.getElementById("scrub") as HTMLInputElement;
  const speedSel = document.getElementById("speed") as HTMLSelectElement;
  const colorSel = document.getElementById("colorby") as HTMLSelectElement;
  const radarToggle = document.getElementById("radar-toggle") as HTMLInputElement;
  const clock = document.getElementById("clock")!;
  const counts = document.getElementById("counts")!;
  const explorePanel = document.getElementById("explore-panel") as HTMLElement;
  const exploreBody = document.getElementById("explore-body")!;
  const selectionBar = document.getElementById("selection-bar") as HTMLElement;
  const selectionLabel = document.getElementById("selection-label")!;
  scrub.max = String(Math.floor(T1));
  renderLegend(colorMode);

  function activeCount(t: number): number {
    let n = 0;
    for (const s of segments) if (s.t0 <= t && t <= s.t1) n++;
    return n;
  }

  function flyToBounds(points: [number, number][], padding = 60) {
    if (points.length === 0) return;
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of points) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding, duration: 900, maxZoom: 9 }
    );
  }

  // ----- selection lifecycle -----

  function enterSelection(sel: Selection, label: string) {
    if (!selection) {
      wasPlayingBeforeSelection = playing;
      playing = false;
      playBtn.textContent = "▶";
    }
    selection = sel;
    selectionFrozen = true;
    selectionBar.hidden = false;
    selectionLabel.textContent = label;
    render(current);
  }

  function selectionMatchHexes(): Set<string> | null {
    if (!selection) return null;
    if (selection.kind === "aircraft") return new Set([selection.hex]);
    if (selection.kind === "airport") return new Set(selection.detail.touches.map((tt) => tt.hex));
    return new Set(selection.matches.map((m) => m.hex));
  }

  function selectionTotalCount(): number {
    if (!selection) return 0;
    if (selection.kind === "aircraft") return selection.detail.legs.length;
    if (selection.kind === "airport") return selection.detail.touches.length;
    return selection.matches.length;
  }

  function selectionActiveCount(t: number): number {
    if (!selection) return 0;
    if (selection.kind === "aircraft") {
      return selection.detail.legs.filter((l) => {
        const t0 = l.path[0]?.[0];
        const t1 = l.path[l.path.length - 1]?.[0];
        return t0 !== undefined && t0 <= t && t <= t1;
      }).length;
    }
    const hexes = selectionMatchHexes()!;
    let n = 0;
    for (const s of segments) if (hexes.has(s.meta.hex) && s.t0 <= t && t <= s.t1) n++;
    return n;
  }

  function clearSelection() {
    selection = null;
    selectionFrozen = true;
    selectionBar.hidden = true;
    playing = wasPlayingBeforeSelection;
    playBtn.textContent = playing ? "⏸" : "▶";
    render(current);
  }

  document.getElementById("selection-clear")!.addEventListener("click", clearSelection);

  const koshLayers = [
    new ScatterplotLayer({
      id: "kosh-dot",
      data: [{ pos: manifest.kosh }],
      getPosition: (d: { pos: [number, number] }) => d.pos,
      getFillColor: [255, 255, 255, 230],
      getLineColor: [11, 11, 11, 200],
      lineWidthMinPixels: 2,
      stroked: true,
      radiusMinPixels: 5,
      radiusMaxPixels: 8,
    }),
    new TextLayer({
      id: "kosh-label",
      data: [{ pos: manifest.kosh }],
      getPosition: (d: { pos: [number, number] }) => d.pos,
      getText: () => "KOSH",
      getColor: [255, 255, 255, 240],
      getSize: 13,
      fontFamily: "system-ui, sans-serif",
      fontWeight: 700,
      getPixelOffset: [0, -16],
      outlineWidth: 2,
      outlineColor: [13, 13, 13, 220],
      fontSettings: { sdf: true },
    }),
  ];

  function makeLayers(t: number) {
    // No selection: normal animated timelapse (all 8040 journeys).
    if (!selection) {
      const breadcrumbs = new TripsLayer<Segment>({
        id: "breadcrumbs",
        data: segments,
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: (d) => colorFor(d.meta, colorMode),
        currentTime: t,
        trailLength: T1,
        fadeTrail: false,
        widthMinPixels: 1,
        opacity: 0.05,
        updateTriggers: { getColor: colorMode },
      });
      const trails = new TripsLayer<Segment>({
        id: "trails",
        data: segments,
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: (d) => colorFor(d.meta, colorMode),
        currentTime: t,
        trailLength: 1200,
        fadeTrail: true,
        widthMinPixels: 2,
        opacity: 0.9,
        updateTriggers: { getColor: colorMode },
      });
      return [breadcrumbs, trails, ...koshLayers];
    }

    // Selection active: isolate — background layers are replaced entirely by
    // just the matching content. (Dimming the full 8040-journey layer in
    // place doesn't work: thousands of overlapping semi-transparent lines
    // alpha-stack back up to looking nearly full-brightness, so we drop the
    // background layers instead.) A fresh selection starts frozen (whole
    // route revealed at once); once play/scrub is used it switches to the
    // normal breadcrumb+fading-trail animation, scoped to just this subset.
    const extraLayers: any[] = [];

    if (selection.kind === "aircraft") {
      const det = selection.detail;
      const legSegments: LegSegment[] = det.legs.map((leg) => {
        const path = leg.path.map((p) => [p[1], p[2]] as [number, number]);
        const timestamps = leg.path.map((p) => p[0]);
        return { leg, path, timestamps, t0: timestamps[0], t1: timestamps[timestamps.length - 1] };
      });
      extraLayers.push(
        ...timeLayers<LegSegment>(
          "aircraft",
          legSegments,
          (d) => d.path,
          (d) => d.timestamps,
          (d) => (d.leg.to === "KOSH" ? KOSH_LEG : d.leg.from === "KOSH" ? DEP_LEG : HIGHLIGHT_LEG),
          selectionFrozen,
          t,
          T1,
          { breadcrumbOpacity: 0.25, trailOpacity: 0.95, trailWidth: 3, trailLength: 1800 }
        ),
        new ScatterplotLayer({
          id: "aircraft-stops",
          data: legSegments.flatMap((d) => [d.path[0], d.path[d.path.length - 1]]),
          getPosition: (d: [number, number]) => d,
          getFillColor: [255, 255, 255, 230],
          getLineColor: [11, 11, 11, 200],
          lineWidthMinPixels: 1.5,
          stroked: true,
          radiusMinPixels: 3,
          radiusMaxPixels: 5,
        })
      );
    } else {
      const hexes = new Set(
        selection.kind === "airport"
          ? selection.detail.touches.map((tt) => tt.hex)
          : selection.matches.map((m) => m.hex)
      );
      const matched = segments.filter((s) => hexes.has(s.meta.hex));
      extraLayers.push(
        ...timeLayers<Segment>(
          "matched",
          matched,
          (d) => d.path,
          (d) => d.timestamps,
          (d) => colorFor(d.meta, colorMode),
          selectionFrozen,
          t,
          T1,
          { breadcrumbOpacity: 0.15, trailOpacity: 0.9, trailWidth: 2, trailLength: 1200 }
        )
      );
      if (selection.kind === "airport" && selection.detail.lat != null) {
        extraLayers.push(
          new ScatterplotLayer({
            id: "airport-marker",
            data: [{ pos: [selection.detail.lon!, selection.detail.lat!] }],
            getPosition: (d: { pos: [number, number] }) => d.pos,
            getFillColor: SELECT_MARKER,
            getLineColor: [11, 11, 11, 220],
            lineWidthMinPixels: 2,
            stroked: true,
            radiusMinPixels: 6,
            radiusMaxPixels: 10,
          })
        );
      }
    }

    return [...extraLayers, ...koshLayers];
  }

  function setRadarVisible(visible: boolean) {
    if (!radarReady) return;
    map.setLayoutProperty("radar-layer", "visibility", visible ? "visible" : "none");
  }

  function render(t: number) {
    overlay.setProps({ layers: makeLayers(t) });
    updateRadar(t);
    setRadarVisible(radarEnabled && !selection);
    clock.textContent = fmtClock(manifest.window_start + t) + " CDT";
    if (selection) {
      counts.textContent = selectionFrozen
        ? "Showing the full route — press play or drag the slider to animate it"
        : `${selectionActiveCount(t)} active of ${selectionTotalCount()} matching`;
    } else {
      counts.textContent = `${activeCount(t)} aircraft in motion · ${journeys.length} journeys total`;
    }
    scrub.value = String(Math.floor(t));
  }

  radarToggle.addEventListener("change", () => {
    radarEnabled = radarToggle.checked;
    document.getElementById("radar-credit")!.hidden = !radarEnabled;
    if (radarEnabled) lastRadarBucket = -1; // force a fetch for the current bucket
    render(current);
  });

  function frame(now: number) {
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (playing) {
      current += dt * speed;
      if (current > T1) current = T0;
      render(current);
    }
    requestAnimationFrame(frame);
  }

  playBtn.addEventListener("click", () => {
    if (selection) selectionFrozen = false;
    playing = !playing;
    playBtn.textContent = playing ? "⏸" : "▶";
  });
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      playBtn.click();
    }
  });
  scrub.addEventListener("input", () => {
    if (selection) selectionFrozen = false;
    current = Number(scrub.value);
    render(current);
  });
  speedSel.addEventListener("change", () => (speed = Number(speedSel.value)));
  colorSel.addEventListener("change", () => {
    colorMode = colorSel.value as ColorMode;
    renderLegend(colorMode);
    render(current);
  });

  // ----- aircraft selection -----

  async function selectAircraft(hex: string) {
    const detail: AircraftDetail = await fetch(`data/aircraft/${hex}.json`).then((r) => r.json());
    const label = `${detail.reg ?? hex} — ${detail.desc ?? detail.type ?? "unknown type"}`;
    enterSelection({ kind: "aircraft", hex, detail }, label);
    const allPts = detail.legs.flatMap((l) => l.path.map((p) => [p[1], p[2]] as [number, number]));
    flyToBounds(allPts);
    renderAircraftTab(document.getElementById("tab-aircraft")!, detail);
  }

  async function selectAirport(ident: string) {
    const detail: AirportDetail = await fetch(`data/airports/${ident}.json`).then((r) => r.json());
    const label = `${detail.ident}${detail.name ? " — " + detail.name : ""}`;
    enterSelection({ kind: "airport", ident, detail }, label);
    const hexes = new Set(detail.touches.map((t) => t.hex));
    const pts = segments.filter((s) => hexes.has(s.meta.hex)).flatMap((s) => s.path);
    if (detail.lat != null && detail.lon != null) pts.push([detail.lon, detail.lat]);
    flyToBounds(pts);
    renderAirportTab(document.getElementById("tab-airport")!, detail);
  }

  function selectType(label: string) {
    const matches = journeys.filter((j) => (j.desc ?? j.type ?? "") === label);
    enterSelection({ kind: "type", label, matches }, `${label} (${matches.length} journeys)`);
    const hexes = new Set(matches.map((m) => m.hex));
    const pts = segments.filter((s) => hexes.has(s.meta.hex)).flatMap((s) => s.path);
    flyToBounds(pts);
    renderTypeTab(document.getElementById("tab-type")!, label, matches);
  }

  // ----- tab renderers -----

  function renderAircraftTab(container: HTMLElement, preselected?: AircraftDetail) {
    if (preselected) {
      const d = preselected;
      const legs = d.legs;
      const first = legs[0], last = legs[legs.length - 1];
      const timeAloft = legs.reduce((sum, l) => sum + l.duration_s, 0);
      container.innerHTML = `
        <div class="detail-card">
          <div class="detail-title">${escapeHtml(d.reg ?? d.hex)}${d.mil ? " ✈ MIL" : ""}</div>
          <div class="detail-sub">${escapeHtml(d.desc ?? d.type ?? "unknown type")} · hex ${d.hex}</div>
          <div class="detail-tiles">
            <div class="tile"><div class="tile-num">${legs.length}</div><div class="tile-cap">flight legs</div></div>
            <div class="tile"><div class="tile-num">${fmtDuration(timeAloft)}</div><div class="tile-cap">time aloft</div></div>
          </div>
          <div class="detail-sub">First seen ${fmtDateShort(first.t_start)} · Last seen ${fmtDateShort(last.t_end)}</div>
          <h3>Flight legs</h3>
          <div>${legs
            .map(
              (l) => `
            <div class="leg-row">
              <span class="leg-date">${fmtDateShort(l.t_start)}</span>
              <span class="leg-route"><span class="apt">${l.from ?? "?"}</span> → <span class="apt">${l.to ?? "?"}</span></span>
              <span class="leg-dur">${fmtDuration(l.duration_s)}${l.nm ? " · " + Math.round(l.nm) + " nm" : ""}</span>
            </div>`
            )
            .join("")}</div>
        </div>
      `;
      return;
    }
    container.innerHTML = `
      <input class="search-box" id="aircraft-search" placeholder="N-number or hex (e.g. N123AB, a1e9ed)" />
      <div class="search-hint">${aircraftIndex.length.toLocaleString()} aircraft indexed</div>
      <div class="result-list" id="aircraft-results"></div>
    `;
    const input = document.getElementById("aircraft-search") as HTMLInputElement;
    const results = document.getElementById("aircraft-results")!;
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) {
        results.innerHTML = "";
        return;
      }
      const matches = aircraftIndex
        .filter((a) => (a.reg && a.reg.toLowerCase().includes(q)) || a.hex.toLowerCase().includes(q))
        .slice(0, 40);
      results.innerHTML = matches.length
        ? matches
            .map(
              (a) => `
          <div class="result-row" data-hex="${a.hex}">
            <div>
              <div class="result-main">${escapeHtml(a.reg ?? a.hex)}</div>
              <div class="result-sub">${escapeHtml(a.desc ?? a.type ?? "unknown")} · ${a.n_legs} legs</div>
            </div>
          </div>`
            )
            .join("")
        : `<div class="no-results">No matches</div>`;
      results.querySelectorAll<HTMLElement>(".result-row").forEach((row) => {
        row.addEventListener("click", () => selectAircraft(row.dataset.hex!));
      });
    });
    input.focus();
  }

  function renderAirportTab(container: HTMLElement, preselected?: AirportDetail) {
    if (preselected) {
      const d = preselected;
      container.innerHTML = `
        <div class="detail-card">
          <div class="detail-title">${escapeHtml(d.ident)}</div>
          <div class="detail-sub">${escapeHtml(d.name ?? "")}${d.city ? " · " + escapeHtml(d.city) : ""}</div>
          <div class="detail-tiles">
            <div class="tile"><div class="tile-num">${d.arrivals}</div><div class="tile-cap">arrivals</div></div>
            <div class="tile"><div class="tile-num">${d.departures}</div><div class="tile-cap">departures</div></div>
          </div>
          <h3>Aircraft (${d.touches.length})</h3>
          <div class="result-list" id="airport-aircraft-list">${d.touches
            .map(
              (t) => `
            <div class="result-row" data-hex="${t.hex}">
              <div>
                <div class="result-main">${escapeHtml(t.reg ?? t.hex)}</div>
                <div class="result-sub">${escapeHtml(t.desc ?? t.type ?? "unknown")} · ${t.dir === "arrival" ? "from " + (t.other ?? "?") : "to " + (t.other ?? "?")} · ${fmtDateShort(t.dir === "arrival" ? t.t_end : t.t_start)}</div>
              </div>
              <span class="result-badge ${t.dir}">${t.dir === "arrival" ? "ARR" : "DEP"}</span>
            </div>`
            )
            .join("")}</div>
        </div>
      `;
      container.querySelectorAll<HTMLElement>("#airport-aircraft-list .result-row").forEach((row) => {
        row.addEventListener("click", () => selectAircraft(row.dataset.hex!));
      });
      return;
    }
    container.innerHTML = `
      <input class="search-box" id="airport-search" placeholder="ICAO ident or airport name (e.g. KATW, Appleton)" />
      <div class="search-hint">${airportIndex.length.toLocaleString()} airports indexed</div>
      <div class="result-list" id="airport-results"></div>
    `;
    const input = document.getElementById("airport-search") as HTMLInputElement;
    const results = document.getElementById("airport-results")!;
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) {
        results.innerHTML = "";
        return;
      }
      const matches = airportIndex
        .filter(
          (a) =>
            a.ident.toLowerCase().includes(q) ||
            (a.name && a.name.toLowerCase().includes(q)) ||
            (a.city && a.city.toLowerCase().includes(q))
        )
        .slice(0, 40);
      results.innerHTML = matches.length
        ? matches
            .map(
              (a) => `
          <div class="result-row" data-ident="${a.ident}">
            <div>
              <div class="result-main">${escapeHtml(a.ident)}</div>
              <div class="result-sub">${escapeHtml(a.name ?? "")}${a.city ? " · " + escapeHtml(a.city) : ""}</div>
            </div>
            <span class="result-badge">${a.arrivals + a.departures}</span>
          </div>`
            )
            .join("")
        : `<div class="no-results">No matches</div>`;
      results.querySelectorAll<HTMLElement>(".result-row").forEach((row) => {
        row.addEventListener("click", () => selectAirport(row.dataset.ident!));
      });
    });
    input.focus();
  }

  function renderTypeTab(container: HTMLElement, label?: string, matches?: JourneyMeta[]) {
    if (label && matches) {
      const uniqueHexes = new Set(matches.map((m) => m.hex));
      container.innerHTML = `
        <div class="detail-card">
          <div class="detail-title">${escapeHtml(label)}</div>
          <div class="detail-sub">${uniqueHexes.size} aircraft · ${matches.length} journeys shown</div>
          <h3>Aircraft</h3>
          <div class="result-list" id="type-aircraft-list">${matches
            .map(
              (m) => `
            <div class="result-row" data-hex="${m.hex}">
              <div>
                <div class="result-main">${escapeHtml(m.reg ?? m.hex)}</div>
                <div class="result-sub">${m.dir === "inbound" ? "from " + (m.origin ?? "?") : "to " + (m.dest ?? "?")} · ${m.region}</div>
              </div>
              <span class="result-badge ${m.dir === "inbound" ? "arrival" : "departure"}">${m.dir === "inbound" ? "ARR" : "DEP"}</span>
            </div>`
            )
            .join("")}</div>
        </div>
      `;
      container.querySelectorAll<HTMLElement>("#type-aircraft-list .result-row").forEach((row) => {
        row.addEventListener("click", () => selectAircraft(row.dataset.hex!));
      });
      return;
    }
    container.innerHTML = `
      <input class="search-box" id="type-search" placeholder="Aircraft type (e.g. RV10, Cessna 172)" />
      <div class="search-hint">${distinctTypes.length.toLocaleString()} distinct types</div>
      <div class="result-list" id="type-results"></div>
    `;
    const input = document.getElementById("type-search") as HTMLInputElement;
    const results = document.getElementById("type-results")!;
    const journeyCountByLabel = new Map<string, number>();
    for (const j of journeys) {
      const l = j.desc ?? j.type ?? "";
      if (l) journeyCountByLabel.set(l, (journeyCountByLabel.get(l) ?? 0) + 1);
    }
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) {
        results.innerHTML = "";
        return;
      }
      const matched = distinctTypes.filter((t) => t.label.toLowerCase().includes(q)).slice(0, 40);
      results.innerHTML = matched.length
        ? matched
            .map(
              (t) => `
          <div class="result-row" data-label="${escapeHtml(t.label)}">
            <div class="result-main">${escapeHtml(t.label)}</div>
            <span class="result-badge">${journeyCountByLabel.get(t.label) ?? 0}</span>
          </div>`
            )
            .join("")
        : `<div class="no-results">No matches</div>`;
      results.querySelectorAll<HTMLElement>(".result-row").forEach((row) => {
        row.addEventListener("click", () => selectType(row.dataset.label!));
      });
    });
    input.focus();
  }

  // ----- explore panel: tabs -----

  const tabIds = ["overview", "aircraft", "airport", "type"] as const;
  type TabId = (typeof tabIds)[number];
  let activeTab: TabId = "overview";
  const loadedTabs = new Set<TabId>();

  function tabContainer(id: TabId): HTMLElement {
    let el = document.getElementById(`tab-${id}`);
    if (!el) {
      el = document.createElement("div");
      el.id = `tab-${id}`;
      exploreBody.appendChild(el);
    }
    return el;
  }

  async function showTab(id: TabId) {
    activeTab = id;
    document.querySelectorAll<HTMLElement>(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === id);
    });
    for (const t of tabIds) {
      const el = document.getElementById(`tab-${t}`);
      if (el) el.style.display = t === id ? "" : "none";
    }
    const el = tabContainer(id);
    if (!loadedTabs.has(id)) {
      loadedTabs.add(id);
      if (id === "overview") await renderOverview(el);
      else if (id === "aircraft") renderAircraftTab(el);
      else if (id === "airport") renderAirportTab(el);
      else if (id === "type") renderTypeTab(el);
    }
  }

  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.dataset.tab as TabId));
  });

  const explorePanelEl = explorePanel;
  let exploreOpened = false;
  document.getElementById("explore-toggle")!.addEventListener("click", async () => {
    explorePanelEl.hidden = !explorePanelEl.hidden;
    if (!explorePanelEl.hidden && !exploreOpened) {
      exploreOpened = true;
      exploreBody.innerHTML = "";
      await showTab(activeTab);
    }
  });
  document.getElementById("explore-close")!.addEventListener("click", () => (explorePanelEl.hidden = true));

  render(current);
  requestAnimationFrame(frame);
}

main().catch((e) => {
  document.getElementById("counts")!.textContent = `failed to load data: ${e}`;
  console.error(e);
});
