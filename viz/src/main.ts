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

type ColorMode = "dir" | "region";

function colorFor(meta: JourneyMeta, mode: ColorMode): RGB {
  if (mode === "dir") return DIR_COLORS[meta.dir];
  return REGION_COLORS[meta.region] ?? REGION_COLORS.Unknown;
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

interface Stats {
  totals: { aircraft: number; inbound: number; outbound: number };
  daily: { day: string; inbound: number; outbound: number }[];
  regions: { region: string; inbound: number; outbound: number }[];
  top_origins: { ident: string; name: string | null; city: string | null; n: number }[];
  top_dests: { ident: string; name: string | null; city: string | null; n: number }[];
  top_types: { label: string; n: number }[];
}

function barRow(label: string, value: number, max: number, color: string, sub = ""): string {
  const w = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return `<div class="bar-row" title="${label}${sub ? " — " + sub : ""}">
    <span class="bar-label">${label}</span>
    <span class="bar-track"><i style="width:${w}%;background:${color}"></i></span>
    <span class="bar-val">${value.toLocaleString()}</span>
  </div>`;
}

async function renderStats() {
  const s: Stats = await fetch("data/stats.json").then((r) => r.json());
  const body = document.getElementById("stats-body")!;
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

async function main() {
  const { manifest, segments } = await loadData();
  const T0 = 0;
  const T1 = manifest.window_end - manifest.window_start;
  const journeys = manifest.journeys;

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
  let speed = 1800;
  let colorMode: ColorMode = "dir";
  let lastFrame = performance.now();

  const playBtn = document.getElementById("play") as HTMLButtonElement;
  const scrub = document.getElementById("scrub") as HTMLInputElement;
  const speedSel = document.getElementById("speed") as HTMLSelectElement;
  const colorSel = document.getElementById("colorby") as HTMLSelectElement;
  const clock = document.getElementById("clock")!;
  const counts = document.getElementById("counts")!;
  scrub.max = String(Math.floor(T1));
  renderLegend(colorMode);

  function activeCount(t: number): number {
    let n = 0;
    for (const s of segments) if (s.t0 <= t && t <= s.t1) n++;
    return n;
  }

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
    return [
      new TripsLayer<Segment>({
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
      }),
      new TripsLayer<Segment>({
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
      }),
      ...koshLayers,
    ];
  }

  function render(t: number) {
    overlay.setProps({ layers: makeLayers(t) });
    clock.textContent = fmtClock(manifest.window_start + t) + " CDT";
    counts.textContent = `${activeCount(t)} aircraft in motion · ${journeys.length} journeys total`;
    scrub.value = String(Math.floor(t));
  }

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
    current = Number(scrub.value);
    render(current);
  });
  speedSel.addEventListener("change", () => (speed = Number(speedSel.value)));
  colorSel.addEventListener("change", () => {
    colorMode = colorSel.value as ColorMode;
    renderLegend(colorMode);
    render(current);
  });

  const statsPanel = document.getElementById("stats-panel") as HTMLElement;
  let statsLoaded = false;
  document.getElementById("stats-toggle")!.addEventListener("click", async () => {
    statsPanel.hidden = !statsPanel.hidden;
    if (!statsPanel.hidden && !statsLoaded) {
      statsLoaded = true;
      await renderStats();
    }
  });
  document.getElementById("stats-close")!.addEventListener("click", () => (statsPanel.hidden = true));

  render(current);
  requestAnimationFrame(frame);
}

main().catch((e) => {
  document.getElementById("counts")!.textContent = `failed to load data: ${e}`;
  console.error(e);
});
