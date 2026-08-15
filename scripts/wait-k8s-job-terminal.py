#!/usr/bin/env python3
"""Wait for one Kubernetes Job to become terminal, failing closed on Failed."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time


def _terminal_condition(job: dict[str, object]) -> tuple[str, dict[str, object]] | None:
    status = job.get("status")
    if not isinstance(status, dict):
        return None
    conditions = status.get("conditions", [])
    if not isinstance(conditions, list):
        return None

    # Failed wins if a malformed/stale object ever exposes both conditions.
    # A release observer must never admit an ambiguously terminal Job.
    for condition_type in ("Failed", "Complete"):
        for condition in conditions:
            if (
                isinstance(condition, dict)
                and condition.get("type") == condition_type
                and condition.get("status") == "True"
            ):
                return condition_type, condition
    return None


def _read_job(namespace: str, job: str) -> dict[str, object]:
    completed = subprocess.run(
        ["kubectl", "get", "job", "-n", namespace, job, "-o", "json"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    value = json.loads(completed.stdout)
    if not isinstance(value, dict):
        raise RuntimeError("kubectl returned a non-object Job")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--timeout-seconds", type=float, required=True)
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    args = parser.parse_args()
    if args.timeout_seconds < 0 or args.poll_seconds < 0:
        parser.error("timeouts must be non-negative")

    deadline = time.monotonic() + args.timeout_seconds
    while True:
        terminal = _terminal_condition(_read_job(args.namespace, args.job))
        if terminal is not None:
            condition_type, condition = terminal
            reason = condition.get("reason", "")
            message = condition.get("message", "")
            print(
                f"Job {args.namespace}/{args.job} terminal: {condition_type}=True"
                f" reason={reason!s} message={message!s}",
                file=sys.stderr if condition_type == "Failed" else sys.stdout,
            )
            return 1 if condition_type == "Failed" else 0
        if time.monotonic() >= deadline:
            print(
                f"Job {args.namespace}/{args.job} did not become terminal within "
                f"{args.timeout_seconds:g}s",
                file=sys.stderr,
            )
            return 124
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
