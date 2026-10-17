#!/usr/bin/env bash
# RETIRED: release artifacts are produced by the canonical Origin workflow.
# Keep the legacy entrypoint inert for old installations; never discover a
# publisher's personal checkout or output directory.
set -euo pipefail
printf '%s\n' 'RETIRED: the Origin build-publish-scli workflow is the only SCLI release publisher.' >&2
exit 0
