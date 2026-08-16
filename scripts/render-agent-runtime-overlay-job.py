#!/usr/bin/env python3
"""Render the finite CI Job that derives both source-overlay candidates."""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path


CRANE_IMAGE = (
    "gcr.io/go-containerregistry/crane:debug@"
    "sha256:ba318977330d2a41fdd4af7536d35567a4ceb204252b7dfcd19b01dad2567793"
)
NPM_REGISTRY = "http://npm-cache.registry.svc.cluster.local:4873"
REGISTRY_REF = "registry.registry.svc.cluster.local:5000"
REGISTRY_V2 = f"http://{REGISTRY_REF}/v2"


def _embedded_runner() -> str:
    module = Path(__file__).with_name("agent_runtime_overlay.py").read_bytes()
    encoded = base64.b64encode(module).decode()
    return f"""import base64, os
namespace = {{"__name__": "agent_runtime_overlay"}}
exec(base64.b64decode({encoded!r}), namespace)
argv = [
    "publish",
    "--source-root", "/workspace/src",
    "--output-dir", "/workspace/overlay",
    "--registry-v2", os.environ["REGISTRY_V2"],
    "--registry-ref", os.environ["REGISTRY_REF"],
    "--repo", os.environ["IMAGE_REPO"],
    "--base-index-digest", os.environ["BASE_INDEX_DIGEST"],
    "--base-source-sha", os.environ["BASE_SOURCE_SHA"],
    "--source-sha", os.environ["SOURCE_SHA"],
    "--candidate-tag", os.environ["CANDIDATE_TAG"],
    "--claude-code", os.environ["CLAUDE_CODE_VERSION"],
    "--codex", os.environ["CODEX_VERSION"],
    "--antigravity", os.environ["ANTIGRAVITY_VERSION"],
    "--openclaw", os.environ["OPENCLAW_VERSION"],
    "--scli", os.environ["SCLI_VERSION"],
    "--skills-sha", os.environ["SKILLS_SHA"],
    "--crane", "/workspace/tools/crane",
]
raise SystemExit(namespace["main"](argv))
"""


def render(args: argparse.Namespace) -> dict:
    job_name = f"ci-overlay-agentrt-{args.candidate_tag}"
    # The exact qualified runtime base is already the overlay's trust anchor,
    # contains Git, Python, and the pinned Node 22 toolchain, and is pre-pulled
    # fleet-wide by every successful runtime release. Reuse it for every viable
    # execution stage so this authoritative path never depends on Docker Hub.
    runtime_image = (
        f"localhost:30500/{args.image_repo}@{args.base_index_digest}"
    )
    clone_script = f"""set -eu
git init /workspace/src
git -C /workspace/src remote add origin http://forgejo-http.origin.svc.cluster.local/shizuha-labs/shizuha-beta.git
AUTH="$(printf 'x-token-auth:%s' "$GIT_PASSWORD" | base64 | tr -d '\n')"
git -C /workspace/src -c http.extraHeader="Authorization: Basic ${{AUTH}}" fetch --depth=1 origin "$SOURCE_SHA"
git -C /workspace/src checkout --detach FETCH_HEAD
test "$(git -C /workspace/src rev-parse HEAD)" = "$SOURCE_SHA"
git -C /workspace/src remote remove origin
git init /workspace/src/.runtime-skills
git -C /workspace/src/.runtime-skills remote add origin http://forgejo-http.origin.svc.cluster.local/shizuha-labs/skills.git
git -C /workspace/src/.runtime-skills -c http.extraHeader="Authorization: Basic ${{AUTH}}" fetch --depth=1 origin "$SKILLS_SHA"
git -C /workspace/src/.runtime-skills checkout --detach FETCH_HEAD
test "$(git -C /workspace/src/.runtime-skills rev-parse HEAD)" = "$SKILLS_SHA"
git -C /workspace/src/.runtime-skills remote remove origin
rm -rf /workspace/src/.runtime-skills/.git
test "$(find /workspace/src/.runtime-skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l)" -ge 50
"""
    build_script = f"""set -euo pipefail
cd /workspace/src
npm ci --ignore-scripts --registry={NPM_REGISTRY} --no-audit --no-fund
npm run build:public
test -f dist/shizuha.js
"""
    common_env = [
        {"name": "SOURCE_SHA", "value": args.source_sha},
        {"name": "SKILLS_SHA", "value": args.skills_sha},
    ]
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": "build",
            "labels": {"app": "ci-overlay", "service": "agent-runtime"},
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 1200,
            "ttlSecondsAfterFinished": 300,
            "template": {
                "spec": {
                    "restartPolicy": "Never",
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
                    "initContainers": [
                        {
                            "name": "git-clone",
                            "image": runtime_image,
                            "securityContext": {"runAsUser": 0},
                            "command": ["/bin/bash", "-c"],
                            "args": [clone_script],
                            "env": common_env
                            + [
                                {
                                    "name": "GIT_PASSWORD",
                                    "valueFrom": {
                                        "secretKeyRef": {
                                            "name": "forgejo-token",
                                            "key": "password",
                                        }
                                    },
                                }
                            ],
                            "volumeMounts": [{"mountPath": "/workspace", "name": "workspace"}],
                        },
                        {
                            "name": "dist-build",
                            "image": runtime_image,
                            # Match the former Node builder's root user for the
                            # root-owned source tree produced by git-clone.
                            "securityContext": {"runAsUser": 0},
                            "command": ["/bin/bash", "-c"],
                            "args": [build_script],
                            "env": [
                                {"name": "NPM_CONFIG_REGISTRY", "value": f"{NPM_REGISTRY}/"}
                            ],
                            "volumeMounts": [{"mountPath": "/workspace", "name": "workspace"}],
                        },
                        {
                            "name": "crane-bin",
                            "image": CRANE_IMAGE,
                            "command": ["/busybox/sh", "-c"],
                            "args": [
                                "mkdir -p /workspace/tools && "
                                "cp /ko-app/crane /workspace/tools/crane && "
                                "chmod 0755 /workspace/tools/crane"
                            ],
                            "volumeMounts": [{"mountPath": "/workspace", "name": "workspace"}],
                        },
                    ],
                    "containers": [
                        {
                            "name": "overlay",
                            "image": runtime_image,
                            "securityContext": {"runAsUser": 0},
                            "command": ["python3", "-c"],
                            "args": [_embedded_runner()],
                            "env": [
                                {"name": "REGISTRY_V2", "value": REGISTRY_V2},
                                {"name": "REGISTRY_REF", "value": REGISTRY_REF},
                                {"name": "IMAGE_REPO", "value": args.image_repo},
                                {"name": "BASE_INDEX_DIGEST", "value": args.base_index_digest},
                                {"name": "BASE_SOURCE_SHA", "value": args.base_source_sha},
                                {"name": "SOURCE_SHA", "value": args.source_sha},
                                {"name": "CANDIDATE_TAG", "value": args.candidate_tag},
                                {"name": "CLAUDE_CODE_VERSION", "value": args.claude_code},
                                {"name": "CODEX_VERSION", "value": args.codex},
                                {"name": "ANTIGRAVITY_VERSION", "value": args.antigravity},
                                {"name": "OPENCLAW_VERSION", "value": args.openclaw},
                                {"name": "SCLI_VERSION", "value": args.scli},
                                {"name": "SKILLS_SHA", "value": args.skills_sha},
                            ],
                            "volumeMounts": [{"mountPath": "/workspace", "name": "workspace"}],
                        }
                    ],
                    "volumes": [{"emptyDir": {}, "name": "workspace"}],
                }
            },
        },
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    for flag in (
        "candidate-tag",
        "image-repo",
        "base-index-digest",
        "base-source-sha",
        "source-sha",
        "claude-code",
        "codex",
        "antigravity",
        "openclaw",
        "scli",
        "skills-sha",
    ):
        result.add_argument(f"--{flag}", required=True)
    return result


if __name__ == "__main__":
    json.dump(render(parser().parse_args()), fp=__import__("sys").stdout)
    print()
