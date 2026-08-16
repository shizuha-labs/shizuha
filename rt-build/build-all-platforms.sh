#!/usr/bin/env bash
# RETIRED: SCLI releases are built and promoted only by the canonical Origin
# build-publish-scli workflow. Keeping this inert entrypoint makes already
# installed legacy systemd units fail safe during rolling source updates.
set -euo pipefail

echo "RETIRED: the Origin build-publish-scli workflow is the only SCLI release publisher." >&2
exit 0
