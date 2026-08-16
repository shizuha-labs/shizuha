#!/usr/bin/env python3
"""PLAT-4740: emit a static-script smoke Job as JSON.

Versions are passed as argv and placed only in container env values.
The nested shell script expands "$CC_VER" etc at runtime and never embeds
untrusted tokens into shell source.
"""
from __future__ import annotations

import json
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 11:
        print(
            'usage: render-agent-runtime-smoke-job.py '
            'ARCH TAG IMG CC_VER CODEX_VER ANTIGRAVITY_VER OPENCLAW_VER SCLI_VER SKILLS_SHA DIGEST',
            file=sys.stderr,
        )
        return 2
    arch, tag, img, cc, codex, antigravity, openclaw, scli, skills, digest = argv[1:]
    script = """set -euo pipefail
assert_version() {
  local executable="$1" expected="$2" output
  output="$("$executable" --version 2>&1)"
  case "$output" in
    *"$expected"*) ;;
    *) echo "$executable reports '$output', expected $expected" >&2; exit 1 ;;
  esac
}
assert_version claude "$CC_VER"
assert_version codex "$CODEX_VER"
assert_version agy "$ANTIGRAVITY_VER"
assert_version antigravity "$ANTIGRAVITY_VER"
assert_version openclaw "$OPENCLAW_VER"
# Gemini CLI must never be present in the agent-runtime image.
if command -v gemini >/dev/null 2>&1; then
  echo "FATAL: gemini CLI is present; permanently replaced by agy" >&2
  exit 1
fi
# PLAT-5873: tmux is baked into the image — mandatory for the TUI live-QA
# harness. Per-pod apt installs are mutable and lost on reprovision, so a
# fresh image must carry tmux with no network/package mutation here.
if ! command -v tmux >/dev/null 2>&1; then
  echo "FATAL: tmux is absent from the agent-runtime image" >&2
  exit 1
fi
tmux -V >/dev/null
# Isolated 120x40 smoke: create → send-keys → capture → kill, and prove zero
# scoped sessions afterward (dedicated -L socket; never touches the default
# server, so this cannot disturb a live agent).
_sock="smoke$$"
tmux -L "$_sock" new-session -d -x 120 -y 40 -s s "$SHELL"
tmux -L "$_sock" send-keys -t s "echo plat5873-ok" Enter
sleep 1
tmux -L "$_sock" capture-pane -t s -p | grep -q "plat5873-ok"
tmux -L "$_sock" kill-session -t s
if tmux -L "$_sock" list-sessions 2>/dev/null | grep -q .; then
  echo "FATAL: tmux smoke left scoped sessions behind" >&2
  exit 1
fi
jq -e \\
  --arg cc "$CC_VER" --arg codex "$CODEX_VER" \\
  --arg antigravity "$ANTIGRAVITY_VER" --arg openclaw "$OPENCLAW_VER" \\
  --arg scli "$SCLI_VER" \\
  '.claude_code == $cc and .codex == $codex and .antigravity == $antigravity and .openclaw == $openclaw and .scli == $scli' \\
  /opt/shizuha/harness-versions.json
test "$(cat /opt/skills/.source-revision)" = "$SKILLS_SHA"
"""
    job = {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": f"ci-smoke-agentrt-{tag}-{arch}",
            "namespace": "build",
            "labels": {"app": "ci-smoke", "service": "agent-runtime"},
        },
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 300,
            "template": {
                "spec": {
                    "restartPolicy": "Never",
                    "nodeSelector": {"kubernetes.io/arch": arch},
                    "tolerations": [
                        {
                            "key": "node.shizuha/workstation",
                            "operator": "Exists",
                            "effect": "NoSchedule",
                        },
                        {
                            "key": "shizuha.com/inference-paused",
                            "operator": "Exists",
                            "effect": "NoSchedule",
                        },
                    ],
                    "affinity": {
                        "nodeAffinity": {
                            "requiredDuringSchedulingIgnoredDuringExecution": {
                                "nodeSelectorTerms": [
                                    {
                                        "matchExpressions": [
                                            {
                                                "key": "node-role.kubernetes.io/control-plane",
                                                "operator": "DoesNotExist",
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    },
                    "containers": [
                        {
                            "name": "smoke",
                            # Pull the resolved ARCH-SPECIFIC digest, not the combined
                            # manifest: the promotable ${TAG} index is now built
                            # only AFTER this gate passes (fleet outage
                            # 2026-07-25), so it does not exist yet. These are
                            # the exact two manifests crane later appends into
                            # that index. A mutable candidate tag is resolved
                            # once before smoke and is never trusted again.
                            "image": f"localhost:30500/{img}@{digest}",
                            "imagePullPolicy": "Always",
                            "env": [
                                {"name": "CC_VER", "value": cc},
                                {"name": "CODEX_VER", "value": codex},
                                {"name": "ANTIGRAVITY_VER", "value": antigravity},
                                {"name": "OPENCLAW_VER", "value": openclaw},
                                {"name": "SCLI_VER", "value": scli},
                                {"name": "SKILLS_SHA", "value": skills},
                            ],
                            "command": ["/bin/bash", "-lc"],
                            "args": [script],
                        }
                    ],
                }
            },
        },
    }
    json.dump(job, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
