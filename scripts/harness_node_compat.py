#!/usr/bin/env python3
"""Harness engine-compatibility selector (PLAT-8128).

The agent-runtime image base is Node <base-major> (ENV NODE_MAJOR in
Dockerfile.agent-runtime). npm harness releases may declare an engines.node
range above the base (openclaw 2026.9.3 requires >=24.16.0 <25 || >=26.1.0);
installing such a release hard-fails the npm RUN after minutes of expensive
parent layers and reds every push build until the base bumps.

Subcommands:
  check --engines-file F --base-major N     -> exit 0 if the engines range in
                                               file F accepts some Node N.x
  pick-newest --doc-file F --base-major N   -> print the newest PUBLISHED
                                               version in the npm packagedoc F
                                               whose engines accepts Node N.x
                                               (document/publish order, so
                                               dist-stamp rebuilds like
                                               2026.7.1-2 sort correctly)

Semver grammar supported (superset of what npm engines uses in practice):
comparators = > >= < <= = ^ ~, OR-alternatives via ||, bare major/minor as
x-ranges, partial versions padded with zeros. An empty/absent engines range
accepts everything (fail-open: the install itself remains the authority).
"""
from __future__ import annotations

import argparse
import json
import re
import sys

INF = (10**6, 0, 0)
_CMP = r"(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?"


def _alt_interval(alt: str) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    lo: tuple[int, int, int] = (0, 0, 0)
    hi: tuple[int, int, int] = INF
    for m in re.finditer(_CMP, alt):
        op = m.group(1) or "="
        ver = (int(m.group(2)), int(m.group(3) or 0), int(m.group(4) or 0))
        if op == "^":
            lo = max(lo, ver); hi = min(hi, (ver[0] + 1, 0, 0))
        elif op == "~":
            lo = max(lo, ver); hi = min(hi, (ver[0], ver[1] + 1, 0))
        elif op == ">":
            lo = max(lo, (ver[0], ver[1], ver[2] + 1))
        elif op == ">=":
            lo = max(lo, ver)
        elif op == "<":
            hi = min(hi, ver)
        elif op == "<=":
            hi = min(hi, (ver[0], ver[1], ver[2] + 1))
        else:  # bare version = x-range (node-semver semantics)
            lo = max(lo, ver); hi = min(hi, (ver[0], ver[1], ver[2] + 1))
    return lo, hi


def engines_accept(engines: str | None, base_major: int) -> bool:
    """True if some Node base_major.x satisfies the engines.node range."""
    if not (engines or "").strip():
        return True
    for alt in engines.split("||"):
        lo, hi = _alt_interval(alt)
        if lo < (base_major + 1, 0, 0) and hi > (base_major, 0, 0):
            return True
    return False


def _engines_of(pkg: dict) -> str:
    e = pkg.get("engines") or {}
    return e.get("node", "") if isinstance(e, dict) else ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_check = sub.add_parser("check", help="engines file accepts base major?")
    p_check.add_argument("--engines-file", required=True)
    p_check.add_argument("--base-major", type=int, required=True)

    p_pick = sub.add_parser("pick-newest", help="newest published compatible version")
    p_pick.add_argument("--doc-file", required=True)
    p_pick.add_argument("--base-major", type=int, required=True)

    a = ap.parse_args()
    with open(a.engines_file if a.cmd == "check" else a.doc_file, encoding="utf-8") as f:
        doc = json.load(f)

    if a.cmd == "check":
        engines = doc.get("engines", {}).get("node", "") if isinstance(doc.get("engines"), dict) else ""
        return 0 if engines_accept(engines, a.base_major) else 1

    for version in reversed(list(doc.get("versions", {}))):  # newest-published first
        if engines_accept(_engines_of(doc["versions"][version]), a.base_major):
            print(version)
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
