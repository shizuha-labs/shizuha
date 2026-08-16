#!/usr/bin/env bash
# Use the repository's bounded full-CI recipe instead of the generic hook's
# unbounded `npm test`. Pre-push runs on the same node as k3s image extraction
# and fleet reconciliation, so serialize test files by default: concurrent
# SQLite fsync workloads can otherwise hit Vitest timeouts while the host still
# has ample CPU. Operators may raise the explicit pre-push worker cap on an
# isolated machine.
set -euo pipefail

export SHIZUHA_CI_MAX_WORKERS="${SHIZUHA_PREPUSH_MAX_WORKERS:-1}"
scratch_root="${SHIZUHA_AGENT_SCRATCH:-/mnt/ramdisk/agent-scratch}"
if [ -d "$scratch_root" ]; then
  mkdir -p "$scratch_root/scli-prepush-tmp"
  export TMPDIR="$scratch_root/scli-prepush-tmp"
fi

# The shared pre-push hook deliberately materializes the exact pushed commit in
# a fresh clone.  node_modules is never part of that clone, so make this runner
# self-contained instead of accidentally borrowing dependencies from the dirty
# coordinator checkout (or failing with a misleading `tsc: not found`).
if [ ! -x node_modules/.bin/tsc ]; then
  # Lifecycle scripts are required here: better-sqlite3 installs its pinned
  # native binding during npm ci and the full suite exercises that store.
  npm ci --no-audit --no-fund
fi

exec npm run ci
