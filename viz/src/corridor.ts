import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";

interface Waypoint {
  code: string;
  name: string;
  lat: number;
  lon: number;
  along_nm: number;
}
interface Meta {
  waypoints: Waypoint[];
  targets: { low: { alt_ft: number; gs: number }; high: { alt_ft: number; gs: number } };
  corridor_len_nm: number;
  days: string[];
}
interface Totals {
  transits: number;
  fisk_crossings: number;
  median_gs_fisk: number;
  median_alt_fisk: number;
  pct_low_profile: number;
  pct_high_profile: number;
  pct_on_altitude: number;
  median_gap_s_fisk: number;
  median_gap_nm_fisk: number;
  pct_gap_under_half_nm: number;
  busiest_day: { day: string; count: number };
  max_concurrent: { n: number; t_local: string | null };
}
interface Profile {
  centers: number[];
  p25: (number | null)[];
  median: (number | null)[];
  p75: (number | null)[];
}
interface TypeCheckpointStat {
  avg: number;
  min: number;
  max: number;
  n: number;
}
interface TypeStatsRow {
  type: string;
  green_lake: TypeCheckpointStat | null;
  ripon: TypeCheckpointStat | null;
  fisk: TypeCheckpointStat | null;
}
interface Summary {
  totals: Totals;
  speed_hist: { bin_size: number; min: number; counts: number[] };
  alt_hist: { bin_size: number; min: number; counts: number[] };
  speed_profile: Profile;
  alt_profile: Profile;
  gap_scatter: GapPoint[];
  type_stats: TypeStatsRow[];
}
interface TransitRecord {
  hex: string;
  reg: string | null;
  type: string | null;
  desc: string | null;
  day: string;
  transit_id: number;
  t_enter: number;
  t_exit: number;
  waypoints: Record<string, { t: number; alt_ft: number; gs: number }>;
  gap_prev_nm_fisk?: number;
  lead_gs_fisk?: number;
}
// [t_rel(s since transit start), lon, lat, along_nm, cross_nm, alt_ft, gs]
type RawPt = [number, number, number, number, number, number, number];
interface DayPointsEntry {
  hex: string;
  transit_id: number;
  pts: RawPt[];
}
interface FollowSeries {
  tRel: number[];
  lon: number[];
  lat: number[];
  alt: number[];
  gs: number[];
  along: number[];
  gapAhead: (number | null)[];
  gapBehind: (number | null)[];
  aheadInfo: (string | null)[];
  behindInfo: (string | null)[];
  duration: number;
}
interface NeighborTrack {
  tr: TransitRecord;
  tAbs: number[];
  lon: number[];
  lat: number[];
  alt: number[];
  gs: number[];
  along: number[];
}
interface AircraftPoint {
  lon: number;
  lat: number;
  hex: string;
  reg: string | null;
  type: string | null;
  alt_ft: number | null;
  gs: number | null;
}

async function fetchJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function fmtDay(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function barRow(label: string, sub: string, value: number, max: number, color: string, valLabel: string): string {
  const w = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  const title = `${label}${sub ? " (" + sub + ")" : ""}: ${valLabel || value.toLocaleString()}`;
  return `<div class="bar-list-row" title="${escapeHtml(title)}">
    <div class="bar-list-label"><span class="bar-list-main">${escapeHtml(label)}</span>${sub ? `<span class="bar-list-sub">${escapeHtml(sub)}</span>` : ""}</div>
    <span class="bar-list-track"><i style="width:${w}%;background:${color}"></i></span>
    <span class="bar-list-val">${escapeHtml(valLabel)}</span>
  </div>`;
}

const ROUTE_PAD_X = 24;
const ROUTE_Y = 40;

function renderRouteDiagram(container: HTMLElement, waypoints: Waypoint[], totalNm: number) {
  const width = Math.max(280, container.clientWidth || 600);
  const height = 90;
  const x = (nm: number) => ROUTE_PAD_X + (nm / totalNm) * (width - ROUTE_PAD_X * 2);
  const dots = waypoints
    .map((w, i) => {
      const anchor = i === 0 ? "start" : i === waypoints.length - 1 ? "end" : "middle";
      const labelX = i === 0 ? x(w.along_nm) - 5 : i === waypoints.length - 1 ? x(w.along_nm) + 5 : x(w.along_nm);
      return `
    <circle cx="${x(w.along_nm)}" cy="${ROUTE_Y}" r="5" fill="#ffffff" />
    <text x="${labelX}" y="${ROUTE_Y - 14}" text-anchor="${anchor}" fill="var(--text-primary)" font-size="12" font-weight="600">${escapeHtml(w.name)}</text>
    <text x="${labelX}" y="${ROUTE_Y + 24}" text-anchor="${anchor}" fill="var(--muted)" font-size="10">${w.along_nm.toFixed(1)}nm</text>
  `;
    })
    .join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
    <line x1="${ROUTE_PAD_X}" y1="${ROUTE_Y}" x2="${width - ROUTE_PAD_X}" y2="${ROUTE_Y}" stroke="var(--border)" stroke-width="3" stroke-dasharray="2,5" stroke-linecap="round" />
    ${dots}
  </svg>`;
}

function renderHistogram(container: HTMLElement, counts: number[], binSize: number, min: number, refs: { val: number; label: string; color: string }[]) {
  const maxCount = Math.max(1, ...counts);
  const rows = counts
    .map((c, i) => {
      const binStart = min + i * binSize;
      const isRef = refs.some((r) => r.val >= binStart && r.val < binStart + binSize);
      const color = isRef ? "var(--inbound)" : "rgba(255,255,255,0.28)";
      return barRow(`${Math.round(binStart)}`, "", c, maxCount, color, c ? String(c) : "");
    })
    .join("");
  const refNote = refs.map((r) => `<span style="color:${r.color}">${escapeHtml(r.label)}</span>`).join(" &middot; ");
  container.innerHTML = `<div class="chart">${rows}</div><div class="ref-line-note">Reference: ${refNote}</div>`;
}

const uplotInstances: uPlot[] = [];
function destroyCharts() {
  for (const u of uplotInstances) u.destroy();
  uplotInstances.length = 0;
}

function waypointHooks(waypoints: Waypoint[]): uPlot.Options["hooks"] {
  return {
    draw: [
      (u: uPlot) => {
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.fillStyle = "#898781";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center";
        for (const w of waypoints) {
          const px = u.valToPos(w.along_nm, "x", true);
          if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;
          ctx.beginPath();
          ctx.moveTo(px, u.bbox.top);
          ctx.lineTo(px, u.bbox.top + u.bbox.height);
          ctx.stroke();
          ctx.fillText(w.code, px, u.bbox.top + u.bbox.height + 14);
        }
        ctx.restore();
      },
    ],
  };
}

function createTooltipEl(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "uplot-tooltip";
  el.style.display = "none";
  return el;
}

function positionTooltip(u: uPlot, tip: HTMLDivElement): number | null {
  const idx = u.cursor.idx ?? null;
  if (idx == null) {
    tip.style.display = "none";
    return null;
  }
  const left = u.cursor.left ?? 0;
  const top = u.cursor.top ?? 0;
  const maxLeft = u.over.clientWidth - (tip.offsetWidth || 140) - 6;
  tip.style.left = `${Math.max(0, Math.min(left + 12, maxLeft))}px`;
  tip.style.top = `${Math.max(0, top - 8)}px`;
  return idx;
}

function mountProfileChart(container: HTMLElement, profile: Profile, targetVal: number, yLabel: string, color: string, waypoints: Waypoint[]) {
  const width = Math.max(260, container.clientWidth || 600);
  const data: uPlot.AlignedData = [
    profile.centers,
    profile.p25.map((v) => (v == null ? NaN : v)),
    profile.median.map((v) => (v == null ? NaN : v)),
    profile.p75.map((v) => (v == null ? NaN : v)),
    profile.centers.map(() => targetVal),
  ];
  const tip = createTooltipEl();
  const opts: uPlot.Options = {
    width,
    height: 220,
    padding: [10, 10, 24, 10],
    scales: { x: { time: false } },
    axes: [
      { label: "nm from Endeavor Bridge", stroke: "#898781", grid: { stroke: "rgba(255,255,255,0.06)" } },
      { label: yLabel, stroke: "#898781", grid: { stroke: "rgba(255,255,255,0.06)" } },
    ],
    legend: { show: false },
    cursor: { show: true },
    hooks: {
      draw: waypointHooks(waypoints)!.draw,
      setCursor: [
        (u: uPlot) => {
          const idx = positionTooltip(u, tip);
          if (idx == null) return;
          const med = profile.median[idx];
          if (med == null) {
            tip.style.display = "none";
            return;
          }
          const p25 = profile.p25[idx];
          const p75 = profile.p75[idx];
          tip.innerHTML =
            `<b>${profile.centers[idx].toFixed(1)}nm</b> from Endeavor Bridge<br>` +
            `median ${med}${yLabel}${p25 != null && p75 != null ? ` &middot; middle 50%: ${p25}&ndash;${p75}${yLabel}` : ""}`;
          tip.style.display = "block";
        },
      ],
    },
    series: [
      {},
      { label: "p25", stroke: "rgba(255,255,255,0.2)", width: 1, points: { show: false } },
      { label: "median", stroke: color, width: 2.5, points: { show: false } },
      { label: "p75", stroke: "rgba(255,255,255,0.2)", width: 1, points: { show: false } },
      { label: "target", stroke: "rgba(255,255,255,0.35)", width: 1, dash: [4, 3], points: { show: false } },
    ],
  };
  const u = new uPlot(opts, data, container);
  u.over.appendChild(tip);
  uplotInstances.push(u);
}

interface GapPoint {
  lead_gs: number;
  gap_nm: number;
  reg: string | null;
  type: string | null;
  hex: string;
}

const GAP_SCATTER_Y_MAX = 2;

function mountGapScatter(container: HTMLElement, rows: GapPoint[]) {
  const width = Math.max(260, container.clientWidth || 600);
  const sorted = rows
    .filter((r) => r.gap_nm <= GAP_SCATTER_Y_MAX)
    .slice()
    .sort((a, b) => a.lead_gs - b.lead_gs);
  if (!sorted.length) {
    container.innerHTML = '<div class="chart-note">no spacing data</div>';
    return;
  }
  const xs = sorted.map((r) => r.lead_gs);
  const ys = sorted.map((r) => r.gap_nm);
  const tip = createTooltipEl();
  const opts: uPlot.Options = {
    width,
    height: 280,
    padding: [10, 10, 0, 10],
    scales: { x: { time: false }, y: { range: [0, GAP_SCATTER_Y_MAX] } },
    axes: [
      { label: "lead aircraft speed at Fisk (kt)", stroke: "#898781", grid: { stroke: "rgba(255,255,255,0.06)" } },
      { label: "gap to lead (nm)", stroke: "#898781", grid: { stroke: "rgba(255,255,255,0.06)" } },
    ],
    legend: { show: false },
    series: [
      {},
      {
        label: "gap",
        stroke: "#3987e5",
        paths: () => null,
        points: { show: true, size: 4, fill: "rgba(57,135,229,0.5)", stroke: "rgba(57,135,229,0.75)" },
      },
    ],
    hooks: {
      draw: [
        (u: uPlot) => {
          const ctx = u.ctx;
          ctx.save();
          ctx.strokeStyle = "rgba(217,89,38,0.5)";
          ctx.setLineDash([4, 3]);
          const py = u.valToPos(0.5, "y", true);
          ctx.beginPath();
          ctx.moveTo(u.bbox.left, py);
          ctx.lineTo(u.bbox.left + u.bbox.width, py);
          ctx.stroke();
          const px = u.valToPos(90, "x", true);
          ctx.beginPath();
          ctx.moveTo(px, u.bbox.top);
          ctx.lineTo(px, u.bbox.top + u.bbox.height);
          ctx.stroke();
          ctx.restore();
        },
      ],
      setCursor: [
        (u: uPlot) => {
          const idx = positionTooltip(u, tip);
          if (idx == null) return;
          const p = sorted[idx];
          tip.innerHTML =
            `<b>${escapeHtml(p.reg ?? p.hex)}</b>${p.type ? ` (${escapeHtml(p.type)})` : ""}<br>` +
            `gap ${p.gap_nm.toFixed(2)}nm behind a ${Math.round(p.lead_gs)}kt lead`;
          tip.style.display = "block";
        },
      ],
    },
  };
  const u = new uPlot(opts, [xs, ys], container);
  u.over.appendChild(tip);
  uplotInstances.push(u);
}

function interpAt(xs: number[], ys: (number | null)[], x: number): number | null {
  if (xs.length === 0 || x < xs[0] || x > xs[xs.length - 1]) return null;
  let lo = 0,
    hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const y0 = ys[lo],
    y1 = ys[hi];
  if (y0 == null || y1 == null) return null;
  const span = xs[hi] - xs[lo];
  const frac = span > 0 ? (x - xs[lo]) / span : 0;
  return y0 + (y1 - y0) * frac;
}

function fmtMMSS(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function buildNeighborTracks(selected: TransitRecord, dayPoints: DayPointsEntry[], dayTransits: TransitRecord[]): NeighborTrack[] {
  const pointsByTransitId = new Map(dayPoints.map((dp) => [dp.transit_id, dp]));
  return dayTransits
    .filter((tr) => tr.transit_id !== selected.transit_id && tr.t_enter < selected.t_exit && tr.t_exit > selected.t_enter)
    .map((tr) => {
      const dp = pointsByTransitId.get(tr.transit_id);
      if (!dp) return null;
      const tAbs = dp.pts.map((p) => tr.t_enter + p[0]);
      const lon = dp.pts.map((p) => p[1]);
      const lat = dp.pts.map((p) => p[2]);
      const along = dp.pts.map((p) => p[3]);
      const alt = dp.pts.map((p) => p[5]);
      const gs = dp.pts.map((p) => p[6]);
      return { tr, tAbs, lon, lat, alt, gs, along };
    })
    .filter((v): v is NeighborTrack => v !== null);
}

function neighborsAt(neighbors: NeighborTrack[], tEnter: number, t: number): AircraftPoint[] {
  const tAbs = tEnter + t;
  const out: AircraftPoint[] = [];
  for (const nb of neighbors) {
    if (tAbs < nb.tr.t_enter || tAbs > nb.tr.t_exit) continue;
    const lon = interpAt(nb.tAbs, nb.lon, tAbs);
    const lat = interpAt(nb.tAbs, nb.lat, tAbs);
    if (lon == null || lat == null) continue;
    out.push({
      lon,
      lat,
      hex: nb.tr.hex,
      reg: nb.tr.reg,
      type: nb.tr.type,
      alt_ft: interpAt(nb.tAbs, nb.alt, tAbs),
      gs: interpAt(nb.tAbs, nb.gs, tAbs),
    });
  }
  return out;
}

function computeFollowSeries(selected: TransitRecord, selfPts: RawPt[], neighbors: NeighborTrack[]): FollowSeries {
  const selfT = selfPts.map((p) => p[0]);
  const selfLon = selfPts.map((p) => p[1]);
  const selfLat = selfPts.map((p) => p[2]);
  const selfAlong = selfPts.map((p) => p[3]);
  const selfAlt = selfPts.map((p) => p[5]);
  const selfGs = selfPts.map((p) => p[6]);
  const n = selfT.length;

  const gapAhead: (number | null)[] = new Array(n).fill(null);
  const gapBehind: (number | null)[] = new Array(n).fill(null);
  const aheadInfo: (string | null)[] = new Array(n).fill(null);
  const behindInfo: (string | null)[] = new Array(n).fill(null);

  const label = (tr: TransitRecord) => (tr.reg ?? tr.hex) + (tr.type ? ` (${tr.type})` : "");

  for (let i = 0; i < n; i++) {
    const tAbs = selected.t_enter + selfT[i];
    const myAlong = selfAlong[i];
    let bestAhead = Infinity,
      bestAheadTr: TransitRecord | null = null;
    let bestBehind = Infinity,
      bestBehindTr: TransitRecord | null = null;
    for (const nb of neighbors) {
      if (tAbs < nb.tr.t_enter || tAbs > nb.tr.t_exit) continue;
      const theirAlong = interpAt(nb.tAbs, nb.along, tAbs);
      if (theirAlong == null) continue;
      const diff = theirAlong - myAlong;
      if (diff > 0 && diff < bestAhead) {
        bestAhead = diff;
        bestAheadTr = nb.tr;
      } else if (diff < 0 && -diff < bestBehind) {
        bestBehind = -diff;
        bestBehindTr = nb.tr;
      }
    }
    gapAhead[i] = bestAheadTr ? bestAhead : null;
    gapBehind[i] = bestBehindTr ? bestBehind : null;
    aheadInfo[i] = bestAheadTr ? label(bestAheadTr) : null;
    behindInfo[i] = bestBehindTr ? label(bestBehindTr) : null;
  }

  return {
    tRel: selfT,
    lon: selfLon,
    lat: selfLat,
    alt: selfAlt,
    gs: selfGs,
    along: selfAlong,
    gapAhead,
    gapBehind,
    aheadInfo,
    behindInfo,
    duration: selfT[n - 1] ?? 0,
  };
}

interface FollowMap {
  map: maplibregl.Map;
  overlay: MapboxOverlay;
  tooltip: HTMLDivElement;
  callouts: CalloutManager;
}

function makeMapTooltip(container: HTMLElement): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "map-tooltip";
  el.style.display = "none";
  container.appendChild(el);
  return el;
}

function mapOnHover(tooltip: HTMLDivElement) {
  return (info: { object?: AircraftPoint; x: number; y: number }) => {
    const d = info.object;
    if (!d) {
      tooltip.style.display = "none";
      return;
    }
    const name = escapeHtml(d.reg ?? d.hex) + (d.type ? ` (${escapeHtml(d.type)})` : "");
    const readouts = [
      d.alt_ft != null ? `${Math.round(d.alt_ft).toLocaleString()}ft` : null,
      d.gs != null ? `${Math.round(d.gs)}kt` : null,
    ]
      .filter(Boolean)
      .join(" &middot; ");
    tooltip.innerHTML = `<b>${name}</b>${readouts ? `<br>${readouts}` : ""}`;
    tooltip.style.left = `${info.x + 12}px`;
    tooltip.style.top = `${info.y + 12}px`;
    tooltip.style.display = "block";
  };
}

function ensureFollowMap(container: HTMLElement): Promise<FollowMap> {
  const map = new maplibregl.Map({
    container,
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [-88.9, 43.85],
    zoom: 8,
    attributionControl: { compact: true },
  });
  const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
  map.addControl(overlay as unknown as maplibregl.IControl);
  const tooltip = makeMapTooltip(container);
  const callouts = createCalloutManager(container);
  return new Promise((resolve) => map.on("load", () => resolve({ map, overlay, tooltip, callouts })));
}

function fitFollowMap(map: maplibregl.Map, lons: number[], lats: number[]) {
  const bounds = new maplibregl.LngLatBounds();
  for (let i = 0; i < lons.length; i++) bounds.extend([lons[i], lats[i]]);
  map.fitBounds(bounds, { padding: 60, duration: 0, maxZoom: 11 });
}

interface CalloutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesOverlap(a: CalloutBox, b: CalloutBox, pad = 4): boolean {
  return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
}

// Candidate offsets around a dot, tried nearest-first: fine-grained compass
// directions at increasing radii, so a label prefers a clean spot close to
// its own dot before displacing further out to dodge a crowded cluster.
const CALLOUT_ANGLE_STEP_DEG = 11.25; // 32 directions
const CALLOUT_RADII = [16, 26, 40, 58, 80, 106, 136];
const DOT_OBSTACLE_SIZE = 10;

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

interface CalloutManager {
  update: (map: maplibregl.Map, aircraft: (AircraftPoint & { isSelf: boolean })[]) => void;
}

// Stateful label placer: reuses one DOM node per aircraft (keyed by hex) so
// CSS transitions can animate between successive positions instead of
// snapping, and remembers each aircraft's last chosen angle/radius so a
// re-solve prefers a small nudge from its previous spot over jumping to a
// wherever a fresh search happens to look first -- the two things that made
// callouts feel like they were jumping around frame to frame.
function createCalloutManager(container: HTMLElement): CalloutManager {
  const layer = document.createElement("div");
  layer.className = "callout-layer";
  container.appendChild(layer);

  const boxPool = new Map<string, HTMLDivElement>();
  const linePool = new Map<string, HTMLDivElement>();
  const sticky = new Map<string, { deg: number; radius: number }>();

  function update(map: maplibregl.Map, aircraft: (AircraftPoint & { isSelf: boolean })[]) {
    const w = map.getContainer().clientWidth;
    const h = map.getContainer().clientHeight;
    const margin = 40;

    const items = aircraft
      .map((a) => {
        const p = map.project([a.lon, a.lat]);
        return { a, x: p.x, y: p.y };
      })
      .filter((it) => it.x >= -margin && it.x <= w + margin && it.y >= -margin && it.y <= h + margin);

    const dotObstacles: CalloutBox[] = items.map((it) => ({
      x: it.x - DOT_OBSTACLE_SIZE / 2,
      y: it.y - DOT_OBSTACLE_SIZE / 2,
      w: DOT_OBSTACLE_SIZE,
      h: DOT_OBSTACLE_SIZE,
    }));
    const placed: CalloutBox[] = [];
    const seen = new Set<string>();

    for (const it of items) {
      const { a, x, y } = it;
      seen.add(a.hex);

      let box = boxPool.get(a.hex);
      if (!box) {
        box = document.createElement("div");
        box.className = "callout-box";
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        layer.appendChild(box);
        boxPool.set(a.hex, box);
      }
      box.classList.toggle("callout-self", a.isSelf);
      const readouts = [a.gs != null ? `${Math.round(a.gs)}kt` : null, a.alt_ft != null ? `${Math.round(a.alt_ft).toLocaleString()}ft` : null]
        .filter(Boolean)
        .join(" &middot; ");
      box.innerHTML = `<span class="callout-type">${escapeHtml(a.type ?? a.reg ?? a.hex)}</span>${readouts ? `<span class="callout-vals">${readouts}</span>` : ""}`;

      const bw = box.offsetWidth;
      const bh = box.offsetHeight;

      const tryCandidate = (deg: number, r: number): CalloutBox | null => {
        const rad = (deg * Math.PI) / 180;
        const cx = x + Math.cos(rad) * r;
        const cy = y + Math.sin(rad) * r;
        const cand: CalloutBox = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
        const collides = dotObstacles.some((o) => boxesOverlap(cand, o)) || placed.some((p) => boxesOverlap(cand, p));
        return collides ? null : cand;
      };

      let chosen: CalloutBox | null = null;
      let chosenDeg = 0;
      let chosenRadius = CALLOUT_RADII[0];

      const prev = sticky.get(a.hex);
      if (prev) {
        // small nudges around the previous angle before a full re-search
        for (const dd of [0, -1, 1, -2, 2, -3, 3]) {
          const c = tryCandidate(normalizeDeg(prev.deg + dd * CALLOUT_ANGLE_STEP_DEG), prev.radius);
          if (c) {
            chosen = c;
            chosenDeg = normalizeDeg(prev.deg + dd * CALLOUT_ANGLE_STEP_DEG);
            chosenRadius = prev.radius;
            break;
          }
        }
      }
      if (!chosen) {
        outer: for (const r of CALLOUT_RADII) {
          for (let deg = -90; deg < 270; deg += CALLOUT_ANGLE_STEP_DEG) {
            const c = tryCandidate(deg, r);
            if (c) {
              chosen = c;
              chosenDeg = deg;
              chosenRadius = r;
              break outer;
            }
          }
        }
      }
      if (!chosen) {
        // nothing clear -- fall back to the previous (or default "up") spot
        // rather than hide the callout entirely.
        chosenDeg = prev?.deg ?? -90;
        chosenRadius = CALLOUT_RADII[CALLOUT_RADII.length - 1];
        const rad = (chosenDeg * Math.PI) / 180;
        chosen = { x: x + Math.cos(rad) * chosenRadius - bw / 2, y: y + Math.sin(rad) * chosenRadius - bh / 2, w: bw, h: bh };
      }

      sticky.set(a.hex, { deg: chosenDeg, radius: chosenRadius });
      placed.push(chosen);

      box.style.left = `${chosen.x}px`;
      box.style.top = `${chosen.y}px`;

      let line = linePool.get(a.hex);
      if (!line) {
        line = document.createElement("div");
        line.className = "callout-leader-line";
        layer.appendChild(line);
        linePool.set(a.hex, line);
      }
      line.classList.toggle("callout-leader-self", a.isSelf);
      const boxCx = chosen.x + bw / 2;
      const boxCy = chosen.y + bh / 2;
      const dist = Math.hypot(boxCx - x, boxCy - y);
      if (dist > 6) {
        const angleDeg = (Math.atan2(boxCy - y, boxCx - x) * 180) / Math.PI;
        line.style.opacity = "1";
        line.style.left = `${x}px`;
        line.style.top = `${y}px`;
        line.style.width = `${dist}px`;
        line.style.transform = `rotate(${angleDeg}deg)`;
      } else {
        line.style.opacity = "0";
      }
    }

    for (const [hex, el] of boxPool) {
      if (!seen.has(hex)) {
        el.remove();
        boxPool.delete(hex);
        linePool.get(hex)?.remove();
        linePool.delete(hex);
        sticky.delete(hex);
      }
    }
  }

  return { update };
}

function renderFollowMapLayers(
  overlay: MapboxOverlay,
  tooltip: HTMLDivElement,
  series: FollowSeries,
  self: AircraftPoint | null,
  nearby: AircraftPoint[],
  visibleCallouts: Set<string>,
  onDotClick: (hex: string) => void
) {
  const onHover = mapOnHover(tooltip);
  const onClick = (info: { object?: AircraftPoint }) => {
    if (info.object) onDotClick(info.object.hex);
  };
  overlay.setProps({
    layers: [
      new PathLayer({
        id: "follow-path",
        data: [{ path: series.lon.map((lon, i) => [lon, series.lat[i]]) }],
        getPath: (d: any) => d.path,
        getColor: [57, 135, 229, 120],
        getWidth: 2.5,
        widthUnits: "pixels",
      }),
      new ScatterplotLayer<AircraftPoint>({
        id: "follow-nearby",
        data: nearby,
        getPosition: (d) => [d.lon, d.lat],
        getFillColor: [201, 200, 193, 220],
        getLineColor: (d) => (visibleCallouts.has(d.hex) ? [237, 161, 0, 255] : [10, 10, 10, 200]),
        lineWidthUnits: "pixels",
        getLineWidth: (d) => (visibleCallouts.has(d.hex) ? 2.5 : 1),
        stroked: true,
        getRadius: (d) => (visibleCallouts.has(d.hex) ? 7 : 5),
        radiusUnits: "pixels",
        pickable: true,
        onHover,
        onClick,
      }),
      ...(self
        ? [
            new ScatterplotLayer<AircraftPoint>({
              id: "follow-self",
              data: [self],
              getPosition: (d) => [d.lon, d.lat],
              getFillColor: [57, 135, 229, 255],
              getLineColor: (d) => (visibleCallouts.has(d.hex) ? [237, 161, 0, 255] : [255, 255, 255, 255]),
              lineWidthUnits: "pixels",
              getLineWidth: (d) => (visibleCallouts.has(d.hex) ? 3.5 : 2),
              stroked: true,
              getRadius: (d) => (visibleCallouts.has(d.hex) ? 10 : 8),
              radiusUnits: "pixels",
              pickable: true,
              onHover,
              onClick,
            }),
          ]
        : []),
    ],
  });
}

// Fixed scale shared by every checkpoint sparkline (not auto-fit per cell) so
// types -- and checkpoints -- can be compared to each other at a glance: the
// bar is always the same physical length, grey outside the observed
// min-max range, blue across it, with the average marked as a dot.
const SPARK_MIN_KT = 60;
const SPARK_MAX_KT = 130;

function sparkPct(v: number): number {
  const clamped = Math.max(SPARK_MIN_KT, Math.min(SPARK_MAX_KT, v));
  return ((clamped - SPARK_MIN_KT) / (SPARK_MAX_KT - SPARK_MIN_KT)) * 100;
}

function renderCheckpointSpark(c: TypeCheckpointStat | null): string {
  if (!c) return '<div class="spark-cell"><span class="type-grid-empty">&mdash;</span></div>';
  const minPct = sparkPct(c.min);
  const maxPct = sparkPct(c.max);
  const avgPct = sparkPct(c.avg);
  return `<div class="spark-cell">
    <span class="spark-n-bubble" title="${c.n} observed">${c.n}</span>
    <div class="spark-body">
      <div class="spark-track">
        <div class="spark-range" style="left:${minPct.toFixed(1)}%;width:${Math.max(0, maxPct - minPct).toFixed(1)}%"></div>
        <div class="spark-dot" style="left:${avgPct.toFixed(1)}%"></div>
      </div>
      <div class="spark-labels">
        <span class="spark-label-min" style="left:${minPct.toFixed(1)}%">${Math.round(c.min)}</span>
        <span class="spark-label-avg" style="left:${avgPct.toFixed(1)}%">${Math.round(c.avg)}kt</span>
        <span class="spark-label-max" style="left:${maxPct.toFixed(1)}%">${Math.round(c.max)}</span>
      </div>
    </div>
  </div>`;
}

function renderTypeGrid(container: HTMLElement, rows: TypeStatsRow[]) {
  if (!rows.length) {
    container.innerHTML = '<div class="chart-note">not enough data</div>';
    return;
  }
  const body = rows
    .map(
      (r) => `<tr>
        <td class="type-grid-type">${escapeHtml(r.type)}</td>
        <td>${renderCheckpointSpark(r.green_lake)}</td>
        <td>${renderCheckpointSpark(r.ripon)}</td>
        <td>${renderCheckpointSpark(r.fisk)}</td>
      </tr>`
    )
    .join("");
  container.innerHTML = `<div class="type-grid-wrap"><table class="type-grid">
    <thead><tr><th>Type</th><th>Green Lake</th><th>Ripon</th><th>Fisk</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

const TYPE_PAGE_SIZE = 15;

function initTypeGrid(allRows: TypeStatsRow[]) {
  const gridEl = document.getElementById("type-grid")!;
  const searchInput = document.getElementById("type-search-input") as HTMLInputElement;
  const prevBtn = document.getElementById("type-page-prev") as HTMLButtonElement;
  const nextBtn = document.getElementById("type-page-next") as HTMLButtonElement;
  const pageLabel = document.getElementById("type-page-label")!;

  let query = "";
  let page = 0;

  function render() {
    const q = query.trim().toUpperCase();
    const filtered = q ? allRows.filter((r) => r.type.toUpperCase().includes(q)) : allRows;
    const pageCount = Math.max(1, Math.ceil(filtered.length / TYPE_PAGE_SIZE));
    page = Math.min(page, pageCount - 1);
    const start = page * TYPE_PAGE_SIZE;
    renderTypeGrid(gridEl, filtered.slice(start, start + TYPE_PAGE_SIZE));
    pageLabel.textContent = filtered.length ? `${start + 1}–${Math.min(start + TYPE_PAGE_SIZE, filtered.length)} of ${filtered.length}` : "0 of 0";
    prevBtn.disabled = page <= 0;
    nextBtn.disabled = page >= pageCount - 1;
  }

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    page = 0;
    render();
  });
  prevBtn.addEventListener("click", () => {
    page = Math.max(0, page - 1);
    render();
  });
  nextBtn.addEventListener("click", () => {
    page = page + 1;
    render();
  });

  render();
}

let transitsCache: TransitRecord[] | null = null;
let transitsPromise: Promise<TransitRecord[]> | null = null;
function loadTransits(): Promise<TransitRecord[]> {
  if (!transitsPromise) {
    transitsPromise = fetchJSON<TransitRecord[]>("data/corridor/transits.json").then((rows) => {
      transitsCache = rows;
      return rows;
    });
  }
  return transitsPromise;
}

const dayPointsPromises = new Map<string, Promise<DayPointsEntry[]>>();
function loadDayPoints(day: string): Promise<DayPointsEntry[]> {
  if (!dayPointsPromises.has(day)) {
    dayPointsPromises.set(day, fetchJSON<DayPointsEntry[]>(`data/corridor/points/${day}.json`));
  }
  return dayPointsPromises.get(day)!;
}

function initFollowFeature(meta: Meta) {
  const searchInput = document.getElementById("follow-search-input") as HTMLInputElement;
  const resultsEl = document.getElementById("follow-search-results")!;
  const examplesEl = document.getElementById("follow-examples")!;
  const panelEl = document.getElementById("follow-panel")!;
  const emptyEl = document.getElementById("follow-empty")!;
  const titleEl = document.getElementById("follow-title")!;
  const subEl = document.getElementById("follow-sub")!;
  const mapEl = document.getElementById("follow-map")!;
  const slider = document.getElementById("follow-slider") as HTMLInputElement;
  const readoutsEl = document.getElementById("follow-readouts")!;

  let followMapPromise: Promise<FollowMap> | null = null;
  let moveHandlerAttached = false;
  let currentSeries: FollowSeries | null = null;
  let currentNeighbors: NeighborTrack[] = [];
  let currentTEnter = 0;
  let currentRecord: TransitRecord | null = null;
  let lastAircraft: (AircraftPoint & { isSelf: boolean })[] = [];
  let lastSliderValue = 0;
  const visibleCallouts = new Set<string>();

  function toggleCallout(hex: string) {
    if (visibleCallouts.has(hex)) visibleCallouts.delete(hex);
    else visibleCallouts.add(hex);
    updateAt(lastSliderValue);
  }

  function updateAt(tRaw: number) {
    if (!currentSeries) return;
    lastSliderValue = tRaw;
    const t = Math.min(Math.max(tRaw, currentSeries.tRel[0] ?? 0), currentSeries.duration);
    const along = interpAt(currentSeries.tRel, currentSeries.along, t);
    const myLon = interpAt(currentSeries.tRel, currentSeries.lon, t);
    const myLat = interpAt(currentSeries.tRel, currentSeries.lat, t);
    const myAlt = interpAt(currentSeries.tRel, currentSeries.alt, t);
    const myGs = interpAt(currentSeries.tRel, currentSeries.gs, t);
    const nearby = neighborsAt(currentNeighbors, currentTEnter, t);
    const self: AircraftPoint | null =
      myLon != null && myLat != null && currentRecord
        ? { lon: myLon, lat: myLat, hex: currentRecord.hex, reg: currentRecord.reg, type: currentRecord.type, alt_ft: myAlt, gs: myGs }
        : null;
    lastAircraft = [...(self ? [{ ...self, isSelf: true }] : []), ...nearby.map((n) => ({ ...n, isSelf: false }))];
    followMapPromise?.then(({ map, overlay, tooltip, callouts }) => {
      renderFollowMapLayers(overlay, tooltip, currentSeries!, self, nearby, visibleCallouts, toggleCallout);
      callouts.update(
        map,
        lastAircraft.filter((a) => visibleCallouts.has(a.hex))
      );
    });
    const ga = interpAt(currentSeries.tRel, currentSeries.gapAhead, t);
    const gb = interpAt(currentSeries.tRel, currentSeries.gapBehind, t);
    const rawIdx = currentSeries.tRel.findIndex((tt) => tt >= t);
    const idx = rawIdx < 0 ? currentSeries.tRel.length - 1 : rawIdx;
    const aheadLabel = currentSeries.aheadInfo[idx];
    const behindLabel = currentSeries.behindInfo[idx];
    const targetName = currentRecord ? currentRecord.reg ?? currentRecord.hex : "target";
    readoutsEl.innerHTML = `
      <div class="follow-readout"><span class="follow-readout-num">${fmtMMSS(t)}</span><span class="follow-readout-cap">elapsed</span></div>
      <div class="follow-readout"><span class="follow-readout-num">${along != null ? along.toFixed(1) : "—"}nm</span><span class="follow-readout-cap">along route</span></div>
      <div class="follow-readout"><span class="follow-readout-num">${myGs != null ? Math.round(myGs) + "kt" : "—"}</span><span class="follow-readout-cap">${escapeHtml(targetName)} speed</span></div>
      <div class="follow-readout"><span class="follow-readout-num">${myAlt != null ? Math.round(myAlt).toLocaleString() + "ft" : "—"}</span><span class="follow-readout-cap">${escapeHtml(targetName)} altitude</span></div>
      <div class="follow-readout"><span class="follow-readout-num" style="color:#3987e5">${ga != null ? ga.toFixed(2) + "nm" : "—"}</span><span class="follow-readout-cap">ahead${aheadLabel ? " &middot; " + escapeHtml(aheadLabel) : ""}</span></div>
      <div class="follow-readout"><span class="follow-readout-num" style="color:#d95926">${gb != null ? gb.toFixed(2) + "nm" : "—"}</span><span class="follow-readout-cap">behind${behindLabel ? " &middot; " + escapeHtml(behindLabel) : ""}</span></div>
    `;
  }

  async function selectTransit(record: TransitRecord) {
    resultsEl.setAttribute("hidden", "");
    searchInput.value = record.reg ?? record.hex;
    panelEl.setAttribute("hidden", "");
    emptyEl.removeAttribute("hidden");
    emptyEl.textContent = "Loading track…";
    visibleCallouts.clear();

    const dayPoints = await loadDayPoints(record.day);
    const dayTransits = (transitsCache ?? []).filter((tr) => tr.day === record.day);
    const selfEntry = dayPoints.find((dp) => dp.transit_id === record.transit_id);
    if (!selfEntry) {
      emptyEl.textContent = "No detailed track available for this aircraft.";
      return;
    }

    currentNeighbors = buildNeighborTracks(record, dayPoints, dayTransits);
    currentTEnter = record.t_enter;
    currentRecord = record;
    currentSeries = computeFollowSeries(record, selfEntry.pts, currentNeighbors);

    emptyEl.setAttribute("hidden", "");
    panelEl.removeAttribute("hidden");
    titleEl.textContent = record.reg ?? record.hex;
    const entryAlong = currentSeries.along[0];
    const exitAlong = currentSeries.along[currentSeries.along.length - 1];
    subEl.textContent =
      `${record.desc ?? record.type ?? "unknown type"} · ${fmtDay(record.day)} · ${fmtMMSS(currentSeries.duration)} tracked ` +
      `(${entryAlong.toFixed(1)}–${exitAlong.toFixed(1)}nm of ${Math.round(meta.corridor_len_nm)}nm route)`;

    if (!followMapPromise) followMapPromise = ensureFollowMap(mapEl);
    const { map, callouts } = await followMapPromise;
    fitFollowMap(map, currentSeries.lon, currentSeries.lat);
    if (!moveHandlerAttached) {
      moveHandlerAttached = true;
      map.on("move", () => callouts.update(map, lastAircraft.filter((a) => visibleCallouts.has(a.hex))));
    }

    slider.min = "0";
    slider.max = String(Math.max(1, Math.round(currentSeries.duration)));
    slider.value = "0";
    updateAt(0);
  }

  slider.addEventListener("input", () => updateAt(Number(slider.value)));

  function renderResults(matches: TransitRecord[]) {
    if (!matches.length) {
      resultsEl.setAttribute("hidden", "");
      return;
    }
    resultsEl.innerHTML = matches
      .slice(0, 8)
      .map(
        (m, i) => `<div class="follow-result-row" data-idx="${i}">
          <span class="follow-result-main">${escapeHtml(m.reg ?? m.hex)}</span>
          <span class="follow-result-sub">${escapeHtml(m.type ?? "?")} &middot; ${fmtDay(m.day)}</span>
        </div>`
      )
      .join("");
    resultsEl.removeAttribute("hidden");
    resultsEl.querySelectorAll(".follow-result-row").forEach((row) => {
      row.addEventListener("click", () => {
        const idx = Number((row as HTMLElement).dataset.idx);
        void selectTransit(matches[idx]);
      });
    });
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toUpperCase();
    if (!transitsCache || q.length < 2) {
      resultsEl.setAttribute("hidden", "");
      return;
    }
    const matches = transitsCache.filter((tr) => (tr.reg ?? "").toUpperCase().includes(q) || tr.hex.toUpperCase().includes(q));
    renderResults(matches);
  });
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Node)) return;
    if (!resultsEl.contains(e.target) && e.target !== searchInput) resultsEl.setAttribute("hidden", "");
  });

  loadTransits().then((rows) => {
    searchInput.disabled = false;
    searchInput.placeholder = "Search tail number (e.g. N123AB)…";

    const candidates = rows
      .filter((r) => r.gap_prev_nm_fisk != null && r.lead_gs_fisk != null && r.lead_gs_fisk < 90 && r.gap_prev_nm_fisk < 1)
      .sort((a, b) => (a.gap_prev_nm_fisk ?? 0) - (b.gap_prev_nm_fisk ?? 0));
    const seen = new Set<string>();
    const examples: TransitRecord[] = [];
    for (const c of candidates) {
      if (seen.has(c.hex)) continue;
      seen.add(c.hex);
      examples.push(c);
      if (examples.length >= 3) break;
    }
    examplesEl.innerHTML = examples
      .map(
        (ex, i) =>
          `<button class="follow-example" data-idx="${i}">${escapeHtml(ex.reg ?? ex.hex)} &mdash; ${(ex.gap_prev_nm_fisk ?? 0).toFixed(2)}nm behind a ${Math.round(ex.lead_gs_fisk ?? 0)}kt lead</button>`
      )
      .join("");
    examplesEl.querySelectorAll(".follow-example").forEach((btn) => {
      btn.addEventListener("click", () => void selectTransit(examples[Number((btn as HTMLElement).dataset.idx)]));
    });
  });
}

async function main() {
  const [meta, summary] = await Promise.all([
    fetchJSON<Meta>("data/corridor/meta.json"),
    fetchJSON<Summary>("data/corridor/summary.json"),
  ]);
  const t = summary.totals;

  const heroStat = (num: string, cap: string) => `<div class="stat"><div class="stat-num">${num}</div><div class="stat-cap">${cap}</div></div>`;
  document.getElementById("hero-stats")!.innerHTML = [
    heroStat(t.transits.toLocaleString(), "corridor transits reconstructed"),
    heroStat(`${Math.round(t.median_gs_fisk)}kt`, "median speed at Fisk"),
    heroStat(`${t.pct_on_altitude}%`, "held an assigned altitude"),
    heroStat(`${t.pct_gap_under_half_nm}%`, "gaps under 0.5nm"),
  ].join("");

  renderRouteDiagram(document.getElementById("route-diagram")!, meta.waypoints, meta.corridor_len_nm);

  document.getElementById("numbers-lede")!.innerHTML =
    `The Fisk arrival funnels inbound traffic onto a single visual track: 90 knots at 1,800 feet, or 135 at 2,300 for ` +
    `faster traffic. Here's how closely <b>${t.transits.toLocaleString()}</b> corridor transits across the show actually held it.`;

  const numbersGrid = document.getElementById("numbers-grid")!;
  const tile = (num: string, cap: string, sub = "") =>
    `<div class="tile"><div class="tile-num">${num}</div><div class="tile-cap">${cap}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ""}</div>`;
  numbersGrid.innerHTML = [
    tile(`${Math.round(t.median_gs_fisk)}kt`, "median speed at Fisk"),
    tile(`${Math.round(t.median_alt_fisk)}ft`, "median altitude at Fisk"),
    tile(`${t.pct_on_altitude}%`, "held an assigned altitude band", "&plusmn;200ft of 1,800 or 2,300"),
    tile(`${t.pct_low_profile}%`, "flew the 1,800ft / 90kt lane"),
    tile(`${t.pct_high_profile}%`, "flew the 2,300ft / 135kt lane"),
    tile(t.busiest_day.count.toLocaleString(), "arrivals, busiest day", fmtDay(t.busiest_day.day)),
    tile(String(t.max_concurrent.n), "aircraft in the Ripon&ndash;Fisk line at once", t.max_concurrent.t_local ?? ""),
    tile(`${Math.round(t.median_gap_s_fisk)}s`, "typical spacing between aircraft", `${t.median_gap_nm_fisk}nm median &middot; ${t.pct_gap_under_half_nm}% under 0.5nm`),
  ].join("");

  document.getElementById("dist-lede")!.innerHTML =
    `Across ${t.fisk_crossings.toLocaleString()} recorded Fisk crossings, the median ground speed was <b>${Math.round(t.median_gs_fisk)} knots</b> ` +
    `at a median altitude of <b>${Math.round(t.median_alt_fisk)}ft</b> &mdash; both landing right where the published 90kt / 1,800ft profile ` +
    `would put them, with smaller clusters flying the faster 135kt / 2,300ft lane.`;
  renderHistogram(document.getElementById("chart-speed-hist")!, summary.speed_hist.counts, summary.speed_hist.bin_size, summary.speed_hist.min, [
    { val: meta.targets.low.gs, label: "90kt", color: "#3987e5" },
    { val: meta.targets.high.gs, label: "135kt", color: "#d95926" },
  ]);
  renderHistogram(document.getElementById("chart-alt-hist")!, summary.alt_hist.counts, summary.alt_hist.bin_size, summary.alt_hist.min, [
    { val: meta.targets.low.alt_ft, label: "1800ft", color: "#3987e5" },
    { val: meta.targets.high.alt_ft, label: "2300ft", color: "#d95926" },
  ]);

  destroyCharts();
  mountProfileChart(document.getElementById("chart-speed-profile")!, summary.speed_profile, meta.targets.low.gs, "kt", "#3987e5", meta.waypoints);
  mountProfileChart(document.getElementById("chart-alt-profile")!, summary.alt_profile, meta.targets.low.alt_ft, "ft", "#d95926", meta.waypoints);

  document.getElementById("gap-lede")!.innerHTML =
    `The published rule is simple: stay at least 0.5nm behind the aircraft ahead, no overtaking, no S-turns. ` +
    `<b>${t.pct_gap_under_half_nm}%</b> of gaps came in tighter than that &mdash; and as the chart below shows, tight gaps cluster ` +
    `behind slower lead aircraft, the signature of a slow airplane compressing the line behind it.`;
  mountGapScatter(document.getElementById("chart-gap-scatter")!, summary.gap_scatter);

  initTypeGrid(summary.type_stats);

  initFollowFeature(meta);

  window.addEventListener("resize", () => {
    destroyCharts();
    mountProfileChart(document.getElementById("chart-speed-profile")!, summary.speed_profile, meta.targets.low.gs, "kt", "#3987e5", meta.waypoints);
    mountProfileChart(document.getElementById("chart-alt-profile")!, summary.alt_profile, meta.targets.low.alt_ft, "ft", "#d95926", meta.waypoints);
    mountGapScatter(document.getElementById("chart-gap-scatter")!, summary.gap_scatter);
  });
}

main();
