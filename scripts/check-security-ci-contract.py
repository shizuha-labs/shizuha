#!/usr/bin/env python3
"""Fail closed when a vendored security-ci workflow drifts from its contract."""

from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path


REQUIRED_PATTERNS = {
    "pip cache argument array": r"(?m)^\s*pip_cache_args=\($",
    "bounded pip read timeout": r"(?m)^\s*--timeout 120$",
    "bounded pip retry": r"(?m)^\s*--retries 1$",
    "three outer attempts": r'''if \[ "\$n" -ge 3 \]''',
    "300-second bootstrap deadline": r"retry timeout -k 30 300 python3 -m pip install",
    "480-second scanner deadline": r"retry timeout -k 30 480 python3 -m pip install",
    "job deadline": r"(?m)^\s*timeout-minutes:\s*70$",
    "retry backoff": r"sleep \$\(\(n\*10\)\)",
    "bounded semgrep deadline": r"timeout -k 30 300 semgrep scan",
    "bounded bandit deadline": r"timeout -k 30 300 bandit -r",
    "bounded osv deadline": r"timeout -k 30 300 osv-scanner",
    "bounded trivy deadline": r"timeout -k 30 300 trivy fs",
    "uv lock project guard": r"if \[ -f pyproject\.toml \] && \[ -f uv\.lock \]; then",
    "uv lock non-project skip": r"Skipping uv lock drift check: pyproject\.toml and uv\.lock are not both present\.",
}

TIMEOUT_FINALIZATION_MARGIN_SECONDS = 120
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS_PER_COMMAND = sum(attempt * 10 for attempt in range(1, RETRY_ATTEMPTS))


def validate(workflow: Path, expected_sha256: str | None = None) -> list[str]:
    data = workflow.read_bytes()
    text = data.decode("utf-8")
    errors = [name for name, pattern in REQUIRED_PATTERNS.items() if not re.search(pattern, text)]
    if text.count('python3 -m pip install "${pip_cache_args[@]}"') < 2:
        errors.append("all in-cluster pip installs use the bounded argument array")
    job_match = re.search(r"(?m)^\s*timeout-minutes:\s*(\d+)\s*$", text)
    command_budgets = [
        int(value)
        for value in re.findall(r"\btimeout\s+-k\s+\d+\s+(\d+)\b", text)
    ]
    retry_command_budgets = [
        int(value)
        for value in re.findall(
            r"(?m)^\s*retry\s+timeout\s+-k\s+\d+\s+(\d+)\b", text
        )
    ]
    if job_match and command_budgets:
        job_budget = int(job_match.group(1)) * 60
        literal_budget = sum(command_budgets)
        retry_extra_budget = (RETRY_ATTEMPTS - 1) * sum(retry_command_budgets)
        retry_backoff_budget = (
            len(retry_command_budgets) * RETRY_BACKOFF_SECONDS_PER_COMMAND
        )
        required = (
            literal_budget
            + retry_extra_budget
            + retry_backoff_budget
            + TIMEOUT_FINALIZATION_MARGIN_SECONDS
        )
        if required > job_budget:
            errors.append(
                "timeout hierarchy inverted: literal command budgets "
                f"{literal_budget}s + retry attempt budgets {retry_extra_budget}s "
                f"+ retry backoff {retry_backoff_budget}s + finalization margin "
                f"{TIMEOUT_FINALIZATION_MARGIN_SECONDS}s exceed job budget {job_budget}s"
            )
    if expected_sha256:
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected_sha256:
            errors.append(f"workflow sha256 mismatch: expected {expected_sha256}, got {actual}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workflow", type=Path, default=Path(".forgejo/workflows/security-ci.yml"))
    parser.add_argument("--expected-sha256")
    args = parser.parse_args()
    errors = validate(args.workflow, args.expected_sha256)
    if errors:
        for error in errors:
            print(f"security-ci contract error: {error}")
        return 1
    print("security-ci contract: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
