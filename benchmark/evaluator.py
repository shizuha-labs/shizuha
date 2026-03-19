"""Docker-based evaluation of agent-produced code.

Each evaluation check runs inside an ephemeral Docker container
to isolate agent-generated code from the host.
"""

import json
import subprocess
import time
from dataclasses import dataclass

from config import EVAL_IMAGE


@dataclass
class EvalResult:
    check_type: str
    passed: bool
    detail: str


def _docker_run(workspace: str, command: str, timeout: int = 30) -> tuple[int, str, str]:
    """Run a command inside the eval Docker container with workspace mounted."""
    cmd = [
        "docker", "run", "--rm",
        "--network", "none",
        "-v", f"{workspace}:/workspace",
        "-w", "/workspace",
        EVAL_IMAGE,
        "bash", "-c", command,
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Docker evaluation timed out"
    except Exception as e:
        return -1, "", str(e)


def check_file_exists(workspace: str, check: dict) -> EvalResult:
    """Verify a file exists in the workspace."""
    path = check["path"]
    code, stdout, stderr = _docker_run(workspace, f'test -f "{path}" && echo "EXISTS"')
    exists = "EXISTS" in stdout
    return EvalResult(
        check_type="file_exists",
        passed=exists,
        detail=f"{path} {'exists' if exists else 'NOT FOUND'}",
    )


def check_syntax(workspace: str, check: dict) -> EvalResult:
    """Run a syntax/import check command."""
    command = check["command"]
    code, stdout, stderr = _docker_run(workspace, command)
    passed = code == 0
    detail = f"exit code {code}"
    if not passed and stderr:
        detail += f": {stderr[:200]}"
    return EvalResult(
        check_type="syntax_check",
        passed=passed,
        detail=detail,
    )


def check_run_command(workspace: str, check: dict) -> EvalResult:
    """Run a command and check exit code."""
    command = check["command"]
    expected_code = check.get("exit_code", 0)
    timeout = check.get("timeout", 30)
    code, stdout, stderr = _docker_run(workspace, command, timeout=timeout)
    passed = code == expected_code
    detail = f"exit code {code} (expected {expected_code})"
    if not passed and stderr:
        detail += f"\nstderr: {stderr[:300]}"
    if not passed and stdout:
        detail += f"\nstdout: {stdout[:300]}"
    return EvalResult(
        check_type="run_command",
        passed=passed,
        detail=detail,
    )


def check_output_contains(workspace: str, check: dict) -> EvalResult:
    """Run a command and verify stdout contains expected strings."""
    command = check["command"]
    expected = check["expected"]
    code, stdout, stderr = _docker_run(workspace, command)

    missing = [s for s in expected if s not in stdout]
    passed = code == 0 and len(missing) == 0
    if missing:
        detail = f"missing in output: {missing}"
    elif code != 0:
        detail = f"command failed with exit code {code}: {stderr[:200]}"
    else:
        detail = f"all {len(expected)} expected strings found"
    return EvalResult(
        check_type="output_contains",
        passed=passed,
        detail=detail,
    )


def check_output_line_count(workspace: str, check: dict) -> EvalResult:
    """Run a command and verify the number of output lines."""
    command = check["command"]
    expected = check["expected"]
    code, stdout, stderr = _docker_run(workspace, command)

    lines = stdout.strip().split("\n") if stdout.strip() else []
    actual = len(lines)
    passed = code == 0 and actual == expected
    detail = f"{actual} lines (expected {expected})"
    if code != 0:
        detail = f"command failed (exit code {code}): {stderr[:200]}"
    return EvalResult(
        check_type="output_line_count",
        passed=passed,
        detail=detail,
    )


def check_server(workspace: str, check: dict) -> EvalResult:
    """Start a server in a container, curl endpoints, then kill it."""
    start_command = check["start_command"]
    port = check["port"]
    startup_wait = check.get("startup_wait", 3)
    checks = check["checks"]

    # Build a shell script that:
    # 1. Starts the server in background
    # 2. Waits for it to be ready
    # 3. Curls each endpoint and checks response
    # 4. Kills the server
    # 5. Reports results

    curl_checks = []
    for i, c in enumerate(checks):
        url = c["url"]
        expected_status = c.get("status", 200)
        contains = c.get("contains", "")
        curl_checks.append(f"""
        STATUS_{i}=$(curl -s -o /tmp/resp_{i}.txt -w "%{{http_code}}" "{url}" 2>/dev/null)
        BODY_{i}=$(cat /tmp/resp_{i}.txt)
        if [ "$STATUS_{i}" = "{expected_status}" ]; then
            if echo "$BODY_{i}" | grep -q "{contains}"; then
                echo "CHECK_{i}=PASS"
            else
                echo "CHECK_{i}=FAIL:missing '{contains}' in body"
            fi
        else
            echo "CHECK_{i}=FAIL:status $STATUS_{i} (expected {expected_status})"
        fi
        """)

    script = f"""
    {start_command} &
    SERVER_PID=$!
    sleep {startup_wait}

    # Verify server is running
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "SERVER_FAILED_TO_START"
        exit 1
    fi

    {"".join(curl_checks)}

    kill $SERVER_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
    """

    # Run with network enabled for localhost access
    cmd = [
        "docker", "run", "--rm",
        "-v", f"{workspace}:/workspace",
        "-w", "/workspace",
        EVAL_IMAGE,
        "bash", "-c", script,
    ]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=startup_wait + 30,
        )
        stdout = proc.stdout
        stderr = proc.stderr
    except subprocess.TimeoutExpired:
        return EvalResult(
            check_type="server_check",
            passed=False,
            detail="Server check timed out",
        )

    if "SERVER_FAILED_TO_START" in stdout:
        return EvalResult(
            check_type="server_check",
            passed=False,
            detail=f"Server failed to start. stderr: {stderr[:300]}",
        )

    # Parse check results
    failures = []
    for i in range(len(checks)):
        line = [l for l in stdout.split("\n") if f"CHECK_{i}=" in l]
        if not line:
            failures.append(f"check {i}: no result")
        elif "FAIL" in line[0]:
            failures.append(f"check {i}: {line[0].split('FAIL:')[-1]}")

    passed = len(failures) == 0
    detail = "all endpoint checks passed" if passed else "; ".join(failures)
    return EvalResult(
        check_type="server_check",
        passed=passed,
        detail=detail,
    )


# Dispatch table
EVALUATORS = {
    "file_exists": check_file_exists,
    "syntax_check": check_syntax,
    "run_command": check_run_command,
    "output_contains": check_output_contains,
    "output_line_count": check_output_line_count,
    "server_check": check_server,
}


def evaluate_task(workspace: str, evaluation_checks: list[dict]) -> list[EvalResult]:
    """Run all evaluation checks for a task and return results."""
    results = []
    for check in evaluation_checks:
        check_type = check["type"]
        evaluator = EVALUATORS.get(check_type)
        if evaluator is None:
            results.append(EvalResult(
                check_type=check_type,
                passed=False,
                detail=f"Unknown check type: {check_type}",
            ))
            continue
        result = evaluator(workspace, check)
        results.append(result)
    return results
