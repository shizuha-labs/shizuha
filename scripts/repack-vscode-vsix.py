#!/usr/bin/env python3
"""Repack an extracted VSIX with deterministic ZIP metadata."""

from __future__ import annotations

import os
import stat
import sys
import time
import zipfile
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: repack-vscode-vsix.py <tree> <output.vsix> <source-date-epoch>")
    root = Path(sys.argv[1]).resolve(strict=True)
    output = Path(sys.argv[2]).resolve()
    epoch = int(sys.argv[3])
    # ZIP timestamps cannot predate 1980. Git source commits are newer, but the
    # clamp keeps the repacker deterministic for synthetic verification trees.
    date_time = time.gmtime(max(epoch, 315532800))[:6]
    entries: list[tuple[str, Path]] = []
    for current, dirs, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in dirs:
            candidate = current_path / name
            if candidate.is_symlink():
                raise SystemExit(f"refusing symlink directory: {candidate.relative_to(root)}")
        for name in files:
            candidate = current_path / name
            mode = candidate.lstat().st_mode
            if not stat.S_ISREG(mode):
                raise SystemExit(f"refusing non-regular entry: {candidate.relative_to(root)}")
            entries.append((candidate.relative_to(root).as_posix(), candidate))

    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, source in sorted(entries):
            info = zipfile.ZipInfo(name, date_time=date_time)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


if __name__ == "__main__":
    main()
