import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { TripsLayer } from "@deck.gl/geo-layers";

const INBOUND: [number, number, number] = [57, 135, 229]; // #3987e5
const OUTBOUND: [number, number, number] = [217, 89, 38]; // #d95926

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
  off: number;
  n: number;
}

interface Manifest {
  window_start: number;
  window_end: number;
  n_points: number;
  kosh: [number, number];
  journeys: JourneyMeta[];
}

interface Journey {
  meta: JourneyMeta;
  path: [number, number][];
  timestamps: number[];
  t0: number;
  t1: number;
}

async function loadData(): Promise<{ manifest: Manifest; journeys: Journey[] }> {
  const [manifest, bin] = await Promise.all([
    fetch("data/manifest.json").then((r) => r.json() as Promise<Manifest>),
    fetch("data/points.bin").then((r) => r.arrayBuffer()),
  ]);
  const f = new Float32Array(bin);
  const journeys: Journey[] = manifest.journeys.map((meta) => {
    const path: [number, number][] = new Array(meta.n);
    const timestamps: number[] = new Array(meta.n);
    for (let i = 0; i < meta.n; i++) {
      const base = (meta.off + i) * 4;
      timestamps[i] = f[base];
      path[i] = [f[base + 1], f[base + 2]];
    }
    return { meta, path, timestamps, t0: timestamps[0], t1: timestamps[meta.n - 1] };
  });
  return { manifest, journeys };
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

async function main() {
  const { manifest, journeys } = await loadData();
  const T0 = 0;
  const T1 = manifest.window_end - manifest.window_start;

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
  let speed = 1800; // sim seconds per real second
  let lastFrame = performance.now();

  const playBtn = document.getElementById("play") as HTMLButtonElement;
  const scrub = document.getElementById("scrub") as HTMLInputElement;
  const speedSel = document.getElementById("speed") as HTMLSelectElement;
  const clock = document.getElementById("clock")!;
  const counts = document.getElementById("counts")!;
  scrub.max = String(Math.floor(T1));

  function activeCount(t: number): number {
    let n = 0;
    for (const j of journeys) if (j.t0 <= t && t <= j.t1) n++;
    return n;
  }

  function makeLayers(t: number) {
    return [
      // persistent faint breadcrumbs of everything flown so far
      new TripsLayer<Journey>({
        id: "breadcrumbs",
        data: journeys,
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: (d) => (d.meta.dir === "inbound" ? INBOUND : OUTBOUND),
        currentTime: t,
        trailLength: T1, // effectively "everything so far"
        fadeTrail: false,
        widthMinPixels: 1,
        opacity: 0.05,
        parameters: { depthTest: false },
      }),
      // bright fading trails behind currently-moving aircraft
      new TripsLayer<Journey>({
        id: "trails",
        data: journeys,
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: (d) => (d.meta.dir === "inbound" ? INBOUND : OUTBOUND),
        currentTime: t,
        trailLength: 1200,
        fadeTrail: true,
        widthMinPixels: 2,
        opacity: 0.9,
        parameters: { depthTest: false },
      }),
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

  render(current);
  requestAnimationFrame(frame);
}

main().catch((e) => {
  document.getElementById("counts")!.textContent = `failed to load data: ${e}`;
  console.error(e);
});
