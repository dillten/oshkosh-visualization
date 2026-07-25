"""Download adsb.lol daily globe_history archives for the AirVenture window.

Fetches release asset lists from the GitHub API, then downloads each split-tar
part with resume support. Safe to re-run: completed files are skipped, partial
files resume via HTTP Range.
"""

import sys
import time
from pathlib import Path

import requests

from config import GITHUB_REPO, RAW_DIR, RELEASE_TAG_FMT, all_days

API = f"https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{{tag}}"
CHUNK = 1 << 20  # 1 MiB


def get_assets(session: requests.Session, tag: str) -> list[dict]:
    r = session.get(API.format(tag=tag), timeout=30)
    r.raise_for_status()
    return r.json()["assets"]


def download_asset(session: requests.Session, url: str, dest: Path, size: int) -> None:
    if dest.exists() and dest.stat().st_size == size:
        print(f"  ok      {dest.name} ({size / 1e9:.2f} GB)")
        return
    tmp = dest.with_suffix(dest.suffix + ".part")
    start = tmp.stat().st_size if tmp.exists() else 0
    headers = {"Range": f"bytes={start}-"} if start else {}
    mode = "ab" if start else "wb"
    print(f"  get     {dest.name} ({size / 1e9:.2f} GB, from {start / 1e9:.2f} GB)")
    with session.get(url, headers=headers, stream=True, timeout=60) as r:
        if start and r.status_code != 206:
            # server ignored the Range header; start over
            start, mode = 0, "wb"
        r.raise_for_status()
        done = start
        t0 = time.monotonic()
        with open(tmp, mode) as f:
            for chunk in r.iter_content(CHUNK):
                f.write(chunk)
                done += len(chunk)
        dt = time.monotonic() - t0
        rate = (done - start) / 1e6 / dt if dt > 0 else 0
        print(f"  done    {dest.name} ({rate:.0f} MB/s)")
    if tmp.stat().st_size != size:
        raise RuntimeError(f"{dest.name}: got {tmp.stat().st_size} bytes, expected {size}")
    tmp.replace(dest)


def main() -> None:
    session = requests.Session()
    session.headers["User-Agent"] = "oshkosh-airventure-viz"
    failures = []
    for day in all_days():
        tag = RELEASE_TAG_FMT.format(d=day)
        day_dir = RAW_DIR / f"{day:%Y.%m.%d}"
        day_dir.mkdir(parents=True, exist_ok=True)
        print(f"[{day}] {tag}")
        try:
            assets = get_assets(session, tag)
        except Exception as e:
            print(f"  ERROR listing release: {e}")
            failures.append(tag)
            continue
        tar_parts = [a for a in assets if ".tar." in a["name"]]
        for a in sorted(tar_parts, key=lambda a: a["name"]):
            for attempt in range(1, 4):
                try:
                    download_asset(session, a["browser_download_url"], day_dir / a["name"], a["size"])
                    break
                except Exception as e:
                    print(f"  retry {attempt} {a['name']}: {e}")
                    time.sleep(10 * attempt)
            else:
                failures.append(a["name"])
    if failures:
        print(f"FAILED: {failures}")
        sys.exit(1)
    print("ALL DOWNLOADS COMPLETE")


if __name__ == "__main__":
    main()
