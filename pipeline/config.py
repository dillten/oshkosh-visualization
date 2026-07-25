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
LAST_COMPLETE_DAY = date(2026, 7, 24)


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
