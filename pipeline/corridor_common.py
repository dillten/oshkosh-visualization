"""Fisk VFR arrival corridor geometry: projecting trace points onto the
published Endeavor Bridge -> Puckaway Lake -> Green Lake -> Ripon -> Fisk
route and detecting individual aircraft transits along it. Used by
08_export_corridor.py.
"""

import math

import numpy as np

from config import CORRIDOR_BUFFER_NM, CORRIDOR_WAYPOINTS
from viz_common import NM_PER_DEG_LAT, split_segments

# Short codes for each waypoint, same order as CORRIDOR_WAYPOINTS, used as
# JSON keys in the export (shorter + safer than the display names).
CODES = ["ENDV", "PPLK", "GRN", "RIPON", "FISK"]

MIN_TRANSIT_SPAN_NM = 15.0  # a run must cover at least this much of the ~39nm
                            # corridor to count as a real transit, not a clip
MIN_TRANSIT_POINTS = 5

_REF_LAT = sum(w[1] for w in CORRIDOR_WAYPOINTS) / len(CORRIDOR_WAYPOINTS)
_COS_REF = math.cos(math.radians(_REF_LAT))


def to_xy(lat, lon):
    """Local tangent-plane nm coordinates, same flat-earth approximation
    style as viz_common's KOSH-referenced helpers, just re-centered on the
    corridor's own reference latitude."""
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    return lon * NM_PER_DEG_LAT * _COS_REF, lat * NM_PER_DEG_LAT


class Corridor:
    """Precomputed waypoint chain for along/cross-track projection."""

    def __init__(self):
        self.names = [w[0] for w in CORRIDOR_WAYPOINTS]
        self.lats = np.array([w[1] for w in CORRIDOR_WAYPOINTS])
        self.lons = np.array([w[2] for w in CORRIDOR_WAYPOINTS])
        xs, ys = to_xy(self.lats, self.lons)
        self.seg_a = np.column_stack([xs[:-1], ys[:-1]])
        self.seg_vec = np.column_stack([xs[1:], ys[1:]]) - self.seg_a
        self.seg_len = np.linalg.norm(self.seg_vec, axis=1)
        self.cum = np.concatenate([[0.0], np.cumsum(self.seg_len)])
        self.total_nm = float(self.cum[-1])
        self.waypoint_along = self.cum.copy()

    def project(self, lat, lon):
        """Vectorized point-to-polyline projection. Returns (along_nm,
        cross_nm) per point, picking whichever of the 4 segments it's
        closest to. cross_nm is signed (which side of the direction of
        travel the point falls on), so left/right deviation (S-turns) is
        distinguishable, not just magnitude."""
        x, y = to_xy(lat, lon)
        n = len(x)
        best_along = np.zeros(n)
        best_cross = np.zeros(n)
        best_dist = np.full(n, np.inf)
        for i in range(len(self.seg_len)):
            ax, ay = self.seg_a[i]
            vx, vy = self.seg_vec[i]
            seglen = self.seg_len[i]
            apx, apy = x - ax, y - ay
            t = np.clip((apx * vx + apy * vy) / (seglen * seglen), 0.0, 1.0)
            projx, projy = ax + t * vx, ay + t * vy
            dx, dy = x - projx, y - projy
            dist = np.hypot(dx, dy)
            sign = np.where((vx * apy - vy * apx) >= 0, 1.0, -1.0)
            along = self.cum[i] + t * seglen
            better = dist < best_dist
            best_along = np.where(better, along, best_along)
            best_cross = np.where(better, sign * dist, best_cross)
            best_dist = np.where(better, dist, best_dist)
        return best_along, best_cross


def corridor_bbox(margin_nm: float = CORRIDOR_BUFFER_NM) -> tuple[float, float, float, float]:
    """Rough (lat_min, lat_max, lon_min, lon_max) box around the corridor,
    padded by the cross-track buffer, for a cheap SQL pre-filter before the
    precise polyline projection."""
    lats = [w[1] for w in CORRIDOR_WAYPOINTS]
    lons = [w[2] for w in CORRIDOR_WAYPOINTS]
    dlat = margin_nm / NM_PER_DEG_LAT
    dlon = margin_nm / (NM_PER_DEG_LAT * _COS_REF)
    return min(lats) - dlat, max(lats) + dlat, min(lons) - dlon, max(lons) + dlon


def find_transits(ts: np.ndarray, lat: np.ndarray, lon: np.ndarray, along: np.ndarray):
    """Split one hex's corridor-filtered, time-sorted point stream into
    contiguous runs (reusing viz_common's coverage-gap/teleport splitter on
    real lat/lon), then keep only runs that plausibly represent one
    directional pass through the corridor: enough along-track span, and net
    positive progress (Endeavor -> Fisk, the arrival direction). Returns a
    list of (start, end) index pairs into the input arrays."""
    bounds = split_segments(ts, lat, lon)
    transits = []
    for s, e in zip(bounds[:-1], bounds[1:]):
        if e - s < MIN_TRANSIT_POINTS:
            continue
        run_along = along[s:e]
        if run_along.max() - run_along.min() < MIN_TRANSIT_SPAN_NM:
            continue
        run_ts = ts[s:e]
        slope = np.polyfit(run_ts - run_ts[0], run_along, 1)[0]
        if slope <= 0:
            continue
        transits.append((s, e))
    return transits


def interp_waypoints(ts: np.ndarray, along: np.ndarray, alt_ft: np.ndarray, gs: np.ndarray, corridor: Corridor):
    """Linearly interpolate ts/alt_ft/gs at each waypoint's fixed along-track
    distance. `along` is forced non-decreasing first (a transit's progress
    "so far", tolerant of small backward noise/S-turns) so np.interp has a
    monotonic x-axis to work against."""
    along_mono = np.maximum.accumulate(along)
    # break exact ties so np.interp's monotonic-x requirement always holds
    along_mono = along_mono + np.arange(len(along_mono)) * 1e-9
    out = {}
    for code, target in zip(CODES, corridor.waypoint_along):
        if target < along_mono[0] or target > along_mono[-1]:
            continue
        out[code] = {
            "t": float(np.interp(target, along_mono, ts)),
            "alt_ft": float(np.interp(target, along_mono, alt_ft)),
            "gs": float(np.interp(target, along_mono, gs)),
        }
    return out
