"""Shared configuration for the Oshkosh ADS-B pipeline."""

from datetime import date, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim"
PROCESSED_DIR = DATA_DIR / "processed"
REFERENCE_DIR = DATA_DIR / "reference"

# AirVenture 2026 window. Lead-in days let us walk journeys back to their
# true origin for aircraft that arrived at KOSH on the first show days.
LEAD_IN_START = date(2026, 7, 14)
SHOW_START = date(2026, 7, 16)
LAST_COMPLETE_DAY = date(2026, 7, 25)


def all_days() -> list[date]:
    d, out = LEAD_IN_START, []
    while d <= LAST_COMPLETE_DAY:
        out.append(d)
        d += timedelta(days=1)
    return out


def show_days() -> list[date]:
    return [d for d in all_days() if d >= SHOW_START]


GITHUB_REPO = "adsblol/globe_history_2026"
RELEASE_TAG_FMT = "v{d:%Y.%m.%d}-planes-readsb-prod-0"

# KOSH / Wittman Regional
KOSH_LAT = 43.9844
KOSH_LON = -88.5570
KOSH_ELEV_FT = 808

# "Visited KOSH" test: within this radius AND (below altitude ceiling or on ground).
# 8 nm covers the field + Fisk arrival funnel; 3500 ft MSL keeps pattern and
# arrival altitudes (1800/2300 ft) while excluding en-route overflights.
KOSH_RADIUS_NM = 8.0
KOSH_ALT_CEILING_FT = 3500

# Fisk VFR arrival corridor: published EAA AirVenture NOTAM VFR arrival route,
# Endeavor Bridge -> Puckaway Lake -> Green Lake -> Ripon -> Fisk (single-file
# railroad-track approach; nominal 1800 ft MSL / 90 KIAS, faster traffic 2300
# ft / 135 kt, >=0.5 nm in-trail spacing). Coordinates from published VFR
# waypoints; the procedure ends at Fisk (the runway approach beyond it is out
# of scope for this analysis).
CORRIDOR_WAYPOINTS = [
    ("Endeavor Bridge", 43.7508, -89.4822),
    ("Puckaway Lake", 43.7403, -89.2247),
    ("Green Lake", 43.7689, -89.0472),
    ("Ripon", 43.8381, -88.8444),
    ("Fisk", 43.9558, -88.6781),
]
CORRIDOR_BUFFER_NM = 5.0  # max perpendicular deviation from centerline to keep
CORRIDOR_MIN_GS = 40  # exclude ground/taxi noise
CORRIDOR_ALT_CEILING_FT = 4000
CORRIDOR_TARGETS = {"low": {"alt_ft": 1800, "gs": 90}, "high": {"alt_ft": 2300, "gs": 135}}
