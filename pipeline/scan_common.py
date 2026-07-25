"""Shared helpers for streaming adsb.lol split-tar archives."""

import gzip
import io
import tarfile
from pathlib import Path
from typing import BinaryIO, Iterator


class MultiFileReader(io.RawIOBase):
    """Read a sequence of files as one continuous stream (for split tars)."""

    def __init__(self, paths: list[Path]):
        self.paths = paths
        self.idx = 0
        self.fh: BinaryIO | None = open(paths[0], "rb") if paths else None

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        while self.fh is not None:
            n = self.fh.readinto(b)
            if n:
                return n
            self.fh.close()
            self.idx += 1
            if self.idx < len(self.paths):
                self.fh = open(self.paths[self.idx], "rb")
            else:
                self.fh = None
        return 0

    def close(self) -> None:
        if self.fh is not None:
            self.fh.close()
            self.fh = None
        super().close()


def tar_parts(day_dir: Path) -> list[Path]:
    parts = sorted(day_dir.glob("*.tar.a?"))
    if not parts:
        raise FileNotFoundError(f"no tar parts in {day_dir}")
    return parts


def iter_trace_members(day_dir: Path) -> Iterator[tuple[str, bytes]]:
    """Yield (hex, decompressed_json_bytes) for every trace_full member."""
    reader = io.BufferedReader(MultiFileReader(tar_parts(day_dir)), buffer_size=1 << 22)
    with tarfile.open(fileobj=reader, mode="r|") as tar:
        for member in tar:
            name = member.name
            if "trace_full_" not in name or not member.isfile():
                continue
            hexid = name.rsplit("trace_full_", 1)[1].removesuffix(".json")
            fh = tar.extractfile(member)
            if fh is None:
                continue
            raw = fh.read()
            # files are gzip despite the .json name; tolerate plain json too
            if raw[:2] == b"\x1f\x8b":
                try:
                    raw = gzip.decompress(raw)
                except OSError:
                    continue
            yield hexid, raw
