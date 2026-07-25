"""Shared geometry helpers for viz export scripts (05/06/07)."""

import math

import numpy as np

from config import KOSH_LAT, KOSH_LON

NEAR_KOSH_NM = 20.0
INTERVAL_NEAR_S = 15.0
INTERVAL_FAR_S = 60.0
HEADING_KEEP_DEG = 12.0
GAP_SPLIT_S = 900.0
TELEPORT_KT = 700.0
LOCAL_NM = 100.0

NM_PER_DEG_LAT = 60.0
COS_KOSH = math.cos(math.radians(KOSH_LAT))


def dist_bearing_from_kosh(lat: float, lon: float) -> tuple[float, float]:
    dlat = (lat - KOSH_LAT) * NM_PER_DEG_LAT
    dlon = (lon - KOSH_LON) * NM_PER_DEG_LAT * COS_KOSH
    return math.hypot(dlat, dlon), (math.degrees(math.atan2(dlon, dlat)) + 360) % 360


def region_of(lat: float | None, lon: float | None) -> str:
    if lat is None or lon is None or (isinstance(lat, float) and math.isnan(lat)):
        return "Unknown"
    d, brg = dist_bearing_from_kosh(lat, lon)
    if d <= LOCAL_NM:
        return "Local"
    return ["Northeast", "Southeast", "Southwest", "Northwest"][int(brg // 90)]


def split_segments(ts, lat, lon):
    """Indices where a new segment must start (coverage gaps and teleports)."""
    if len(ts) < 2:
        return [0, len(ts)]
    dt = np.diff(ts)
    dlat = (lat[1:] - lat[:-1]) * NM_PER_DEG_LAT
    dlon = (lon[1:] - lon[:-1]) * NM_PER_DEG_LAT * COS_KOSH
    dnm = np.hypot(dlat, dlon)
    speed = np.divide(dnm * 3600, dt, out=np.zeros_like(dnm), where=dt > 0)
    breaks = np.flatnonzero((dt > GAP_SPLIT_S) | ((speed > TELEPORT_KT) & (dnm > 5))) + 1
    return [0, *breaks.tolist(), len(ts)]


def downsample(ts, lat, lon, trk):
    """Keep a point if enough time passed (interval depends on distance to
    KOSH) or the heading changed significantly since the last kept point."""
    n = len(ts)
    if n <= 2:
        return np.arange(n)
    dlat = (lat - KOSH_LAT) * NM_PER_DEG_LAT
    dlon = (lon - KOSH_LON) * NM_PER_DEG_LAT * COS_KOSH
    near = np.hypot(dlat, dlon) <= NEAR_KOSH_NM
    interval = np.where(near, INTERVAL_NEAR_S, INTERVAL_FAR_S)
    keep = [0]
    last_t = ts[0]
    last_trk = trk[0]
    for i in range(1, n - 1):
        dtrk = trk[i] - last_trk
        if not np.isnan(dtrk):
            dtrk = (dtrk + 180) % 360 - 180
        if ts[i] - last_t >= interval[i] or (not np.isnan(dtrk) and abs(dtrk) >= HEADING_KEEP_DEG):
            keep.append(i)
            last_t = ts[i]
            if not np.isnan(trk[i]):
                last_trk = trk[i]
    keep.append(n - 1)
    return np.array(keep)


def downsample_capped(ts, lat, lon, trk, max_pts: int):
    """downsample() but enforce a hard cap by evenly thinning the kept set."""
    i = downsample(ts, lat, lon, trk)
    if len(i) > max_pts:
        i = i[np.linspace(0, len(i) - 1, max_pts).astype(int)]
    return i
