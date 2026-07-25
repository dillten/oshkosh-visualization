"""Shared geometry helpers for viz export scripts (05/06/07) and flight
analysis (04, 08)."""

import csv
import math

import numpy as np
from scipy.spatial import cKDTree

from config import KOSH_ALT_CEILING_FT, KOSH_LAT, KOSH_LON, KOSH_RADIUS_NM, REFERENCE_DIR

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


# ---------------------------------------------------------------------------
# Leg segmentation, airport snapping, and journey chaining.
# Shared by 04_flights.py (the automated KOSH-anchored pipeline) and any
# one-off manual addition (e.g. 08_add_special_aircraft.py) that needs the
# exact same logic anchored on a different airport.
# ---------------------------------------------------------------------------

LEG_GAP_SPLIT_S = 900      # time gap that forces a new leg
MIN_LEG_POINTS = 15
MIN_LEG_DURATION_S = 120
SNAP_RADIUS_NM = 3.0       # endpoint-to-airport max distance
SNAP_AGL_FT = 2000         # endpoint must be below airport elev + this
EARTH_NM = 3440.065

AIRPORT_TYPES = {"small_airport", "medium_airport", "large_airport", "seaplane_base"}


def latlon_to_xyz(lat_deg, lon_deg):
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    return np.column_stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])


def chord_to_nm(chord):
    return 2.0 * EARTH_NM * np.arcsin(np.clip(chord / 2.0, 0, 1))


def load_airports():
    idents, lats, lons, elevs, names = [], [], [], [], []
    with open(REFERENCE_DIR / "airports.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["type"] not in AIRPORT_TYPES:
                continue
            try:
                lat, lon = float(row["latitude_deg"]), float(row["longitude_deg"])
            except ValueError:
                continue
            ident = row["icao_code"] or row["gps_code"] or row["ident"]
            idents.append(ident)
            lats.append(lat)
            lons.append(lon)
            elevs.append(float(row["elevation_ft"]) if row["elevation_ft"] else 0.0)
            names.append(row["name"])
    lats, lons = np.array(lats), np.array(lons)
    xyz = latlon_to_xyz(lats, lons)
    return cKDTree(xyz), idents, lats, lons, np.array(elevs), names


class AirportSnapper:
    def __init__(self):
        self.tree, self.idents, self.lats, self.lons, self.elevs, self.names = load_airports()

    def snap(self, lat: float, lon: float, alt_ft: float | None) -> str | None:
        """Return airport ident if (lat, lon, alt) plausibly sits at one."""
        d, i = self.tree.query(latlon_to_xyz(np.array([lat]), np.array([lon]))[0])
        dist_nm = float(chord_to_nm(np.array([d]))[0])
        if dist_nm > SNAP_RADIUS_NM:
            return None
        if alt_ft is not None and alt_ft >= 0 and alt_ft > self.elevs[i] + SNAP_AGL_FT:
            return None
        return self.idents[i]


def dist_nm(lat1, lon1, lat2, lon2) -> float:
    a = latlon_to_xyz(np.array([lat1]), np.array([lon1]))
    b = latlon_to_xyz(np.array([lat2]), np.array([lon2]))
    return float(chord_to_nm(np.linalg.norm(a - b, axis=1))[0])


def near_kosh(lat, lon, alt_ft) -> bool:
    d = dist_nm(lat, lon, KOSH_LAT, KOSH_LON)
    low = alt_ft is None or alt_ft < 0 or alt_ft <= KOSH_ALT_CEILING_FT
    return d <= KOSH_RADIUS_NM and low


def path_length_nm(lats, lons) -> float:
    if len(lats) < 2:
        return 0.0
    xyz = latlon_to_xyz(lats, lons)
    seg = np.linalg.norm(np.diff(xyz, axis=0), axis=1)
    return float(chord_to_nm(seg).sum())


def segment_hex(ts, lat, lon, alt, flags, snapper: AirportSnapper) -> list[dict]:
    """Split one aircraft's whole point stream into flight legs. Endpoints
    within KOSH_RADIUS_NM/KOSH_ALT_CEILING_FT are labeled "KOSH" regardless
    of the nearest-airport snap (KOSH itself is always in the airport index
    too, so this mainly matters for the Fisk/Ripon arrival corridor where the
    nearest snapped field might not be Wittman itself)."""
    order = np.argsort(ts)
    ts, lat, lon, alt, flags = ts[order], lat[order], lon[order], alt[order], flags[order]
    # dedupe identical timestamps (possible at day-file boundaries)
    keep = np.concatenate([[True], np.diff(ts) > 0.5])
    ts, lat, lon, alt, flags = ts[keep], lat[keep], lon[keep], alt[keep], flags[keep]

    new_leg = (flags.astype(np.int64) & 2) != 0
    gap = np.concatenate([[False], np.diff(ts) > LEG_GAP_SPLIT_S])
    starts = np.flatnonzero(new_leg | gap)
    bounds = np.concatenate([[0], starts, [len(ts)]])
    bounds = np.unique(bounds)

    legs = []
    for i in range(len(bounds) - 1):
        s, e = int(bounds[i]), int(bounds[i + 1])
        if e - s < MIN_LEG_POINTS or ts[e - 1] - ts[s] < MIN_LEG_DURATION_S:
            continue
        # ignore legs that never leave the ground (taxi-only)
        leg_alt = alt[s:e]
        airborne = leg_alt[~np.isnan(leg_alt)]
        if len(airborne) and (airborne <= 0).all():
            continue
        a_start = None if np.isnan(alt[s]) else float(alt[s])
        a_end = None if np.isnan(alt[e - 1]) else float(alt[e - 1])
        from_apt = snapper.snap(float(lat[s]), float(lon[s]), a_start)
        to_apt = snapper.snap(float(lat[e - 1]), float(lon[e - 1]), a_end)
        if near_kosh(float(lat[s]), float(lon[s]), a_start):
            from_apt = "KOSH"
        if near_kosh(float(lat[e - 1]), float(lon[e - 1]), a_end):
            to_apt = "KOSH"
        legs.append(
            {
                "t_start": float(ts[s]),
                "t_end": float(ts[e - 1]),
                "from_apt": from_apt,
                "to_apt": to_apt,
                "from_lat": float(lat[s]),
                "from_lon": float(lon[s]),
                "to_lat": float(lat[e - 1]),
                "to_lon": float(lon[e - 1]),
                "n_points": e - s,
                "path_nm": round(path_length_nm(lat[s:e], lon[s:e]), 1),
            }
        )
    return legs


def journeys_for_hex(hexid: str, legs: list[dict], anchor: str = "KOSH") -> list[dict]:
    """Inbound journey = legs up to the first arrival at `anchor`; outbound =
    legs from the last departure from `anchor` onward. `anchor` defaults to
    KOSH (the automated pipeline); a manually-added exception can chain on
    a different airport it actually touched instead."""
    out = []
    arr = [i for i, l in enumerate(legs) if l["to_apt"] == anchor and l["from_apt"] != anchor]
    dep = [i for i, l in enumerate(legs) if l["from_apt"] == anchor and l["to_apt"] != anchor]
    if arr:
        i = arr[0]
        chain = legs[: i + 1]
        # trim leading legs that are clearly a different trip (>48h ground stop)
        trimmed = [chain[-1]]
        for prev in reversed(chain[:-1]):
            if trimmed[0]["t_start"] - prev["t_end"] > 48 * 3600:
                break
            trimmed.insert(0, prev)
        out.append(
            {
                "hex": hexid,
                "direction": "inbound",
                "origin": trimmed[0]["from_apt"],
                "destination": anchor,
                "origin_lat": trimmed[0]["from_lat"],
                "origin_lon": trimmed[0]["from_lon"],
                "dest_lat": trimmed[-1]["to_lat"],
                "dest_lon": trimmed[-1]["to_lon"],
                "t_start": trimmed[0]["t_start"],
                "t_end": trimmed[-1]["t_end"],
                "n_legs": len(trimmed),
                "total_nm": round(sum(l["path_nm"] for l in trimmed), 1),
                "leg_t_starts": [l["t_start"] for l in trimmed],
            }
        )
    if dep:
        i = dep[-1]
        chain = legs[i:]
        trimmed = [chain[0]]
        for nxt in chain[1:]:
            if nxt["t_start"] - trimmed[-1]["t_end"] > 48 * 3600:
                break
            trimmed.append(nxt)
        out.append(
            {
                "hex": hexid,
                "direction": "outbound",
                "origin": anchor,
                "destination": trimmed[-1]["to_apt"],
                "origin_lat": trimmed[0]["from_lat"],
                "origin_lon": trimmed[0]["from_lon"],
                "dest_lat": trimmed[-1]["to_lat"],
                "dest_lon": trimmed[-1]["to_lon"],
                "t_start": trimmed[0]["t_start"],
                "t_end": trimmed[-1]["t_end"],
                "n_legs": len(trimmed),
                "total_nm": round(sum(l["path_nm"] for l in trimmed), 1),
                "leg_t_starts": [l["t_start"] for l in trimmed],
            }
        )
    return out
