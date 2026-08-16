#!/usr/bin/env python3
"""Render the post-smoke, exact-child multi-architecture manifest Job."""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import sys

CRANE_IMAGE = (
    "gcr.io/go-containerregistry/crane:debug@"
    "sha256:ba318977330d2a41fdd4af7536d35567a4ceb204252b7dfcd19b01dad2567793"
)
REGISTRY_REF = "registry.registry.svc.cluster.local:5000"
REGISTRY_V2 = f"http://{REGISTRY_REF}/v2"


def _runner() -> str:
    module = Path(__file__).with_name("agent_runtime_overlay.py").read_bytes()
    encoded = base64.b64encode(module).decode()
    return f"""import base64, os
namespace = {{"__name__": "agent_runtime_overlay"}}
exec(base64.b64decode({encoded!r}), namespace)
argv = [
    "combine",
    "--registry-v2", os.environ["REGISTRY_V2"],
    "--registry-ref", os.environ["REGISTRY_REF"],
    "--repo", os.environ["IMAGE_REPO"],
    "--tag", os.environ["TAG"],
    "--amd64-digest", os.environ["AMD64_DIGEST"],
    "--arm64-digest", os.environ["ARM64_DIGEST"],
    "--crane", "/tools/crane",
]
raise SystemExit(namespace["main"](argv))
"""


def render(args: argparse.Namespace) -> dict:
    runtime_image = (
        f"localhost:30500/{args.image_repo}@{args.base_index_digest}"
    )
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": f"ci-manifest-agentrt-{args.candidate_tag}",
            "namespace": "build",
            "labels": {"app": "ci-manifest", "service": "agent-runtime"},
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 300,
            "ttlSecondsAfterFinished": 300,
            "template": {
                "spec": {
                    "restartPolicy": "Never",
                    "initContainers": [
                        {
                            "name": "crane-bin",
                            "image": CRANE_IMAGE,
                            "command": ["/busybox/sh", "-c"],
                            "args": ["cp /ko-app/crane /tools/crane && chmod 0755 /tools/crane"],
                            "volumeMounts": [{"mountPath": "/tools", "name": "tools"}],
                        }
                    ],
                    "containers": [
                        {
                            "name": "combine-and-verify",
                            "image": runtime_image,
                            "securityContext": {"runAsUser": 0},
                            "command": ["python3", "-c"],
                            "args": [_runner()],
                            "env": [
                                {"name": "REGISTRY_V2", "value": REGISTRY_V2},
                                {"name": "REGISTRY_REF", "value": REGISTRY_REF},
                                {"name": "IMAGE_REPO", "value": args.image_repo},
                                {"name": "TAG", "value": args.tag},
                                {"name": "AMD64_DIGEST", "value": args.amd64_digest},
                                {"name": "ARM64_DIGEST", "value": args.arm64_digest},
                            ],
                            "volumeMounts": [{"mountPath": "/tools", "name": "tools"}],
                        }
                    ],
                    "volumes": [{"emptyDir": {}, "name": "tools"}],
                }
            },
        },
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--candidate-tag", required=True)
    result.add_argument("--tag", required=True)
    result.add_argument("--image-repo", required=True)
    result.add_argument("--base-index-digest", required=True)
    result.add_argument("--amd64-digest", required=True)
    result.add_argument("--arm64-digest", required=True)
    return result


if __name__ == "__main__":
    json.dump(render(parser().parse_args()), sys.stdout)
    print()
