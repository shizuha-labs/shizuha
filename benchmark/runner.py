"""Agent execution with timeout and output capture.

Supports two execution modes:
- container: Docker-based execution with isolated env vars (default)
- baremetal: Direct host execution with sandboxed HOME directory

Mode is controlled by the 'execution_environment' setting in settings.json.
"""

import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from config import AgentConfig, TIER_TIMEOUTS, LOGS_DIR, AGENT_IMAGE, get_agent_version, get_execution_environment


_SENSITIVE_ENV_MARKERS = (
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "API_KEY",
    "ACCOUNTS_JSON",
    "AUTH",
    "PROMPT",
)


def _is_sensitive_env_key(key: str) -> bool:
    upper = key.upper()
    return any(marker in upper for marker in _SENSITIVE_ENV_MARKERS)


def _sanitize_docker_cmd_for_log(docker_cmd: list[str]) -> str:
    """Return a log-safe docker command string with sensitive env vars redacted."""
    redacted: list[str] = []
    i = 0
    while i < len(docker_cmd):
        token = docker_cmd[i]
        if token == "-e" and i + 1 < len(docker_cmd):
            env_assignment = docker_cmd[i + 1]
            if "=" in env_assignment:
                key, _ = env_assignment.split("=", 1)
                if _is_sensitive_env_key(key):
                    redacted.extend(["-e", f"{key}=<REDACTED>"])
                else:
                    redacted.extend(["-e", env_assignment])
            else:
                redacted.extend(["-e", "<REDACTED>"])
            i += 2
            continue
        redacted.append(token)
        i += 1
    return " ".join(redacted)


@dataclass
class RunResult:
    agent_name: str
    model: str
    agent_version: str
    task_id: str
    task_name: str
    tier: str
    elapsed_seconds: float
    timed_out: bool
    workspace: str
    workspace_files: list[str]
    file_contents: dict[str, str]
    stdout: str
    stderr: str
    exit_code: int


def list_workspace_files(workspace: str) -> list[str]:
    """List all files in workspace relative to workspace root, excluding .git."""
    files = []
    for root, dirs, filenames in os.walk(workspace):
        # Skip .git directory
        dirs[:] = [d for d in dirs if d != ".git"]
        for f in filenames:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, workspace)
            files.append(rel)
    return sorted(files)


def read_workspace_contents(workspace: str, max_file_size: int = 5120) -> dict[str, str]:
    """Read all workspace files up to max_file_size bytes each.

    Returns a dict mapping relative path -> file content (text).
    Binary files or files exceeding the size limit are noted but not included.
    """
    contents = {}
    for root, dirs, filenames in os.walk(workspace):
        dirs[:] = [d for d in dirs if d != ".git"]
        for f in filenames:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, workspace)
            try:
                size = os.path.getsize(full)
                if size > max_file_size:
                    contents[rel] = f"[file too large: {size} bytes]"
                    continue
                with open(full, "r", errors="replace") as fh:
                    contents[rel] = fh.read()
            except Exception as e:
                contents[rel] = f"[read error: {e}]"
    return contents


def _drain_stderr(proc: subprocess.Popen, stderr_lines: list):
    """Drain stderr in a background thread to prevent pipe deadlock."""
    try:
        for line in proc.stderr:
            stderr_lines.append(line)
    except (ValueError, OSError):
        pass  # pipe closed


def _stream_stdout(proc: subprocess.Popen, agent_name: str, stdout_lines: list,
                   event_callback: Callable | None, live_log_file=None):
    """Read stdout line-by-line, parse NDJSON, call event_callback for each event."""
    try:
        for line in proc.stdout:
            stdout_lines.append(line)
            # Write to live log file for real-time monitoring (tail -f)
            if live_log_file:
                try:
                    live_log_file.write(line)
                    live_log_file.flush()
                except (ValueError, OSError):
                    pass
            if event_callback and line.strip():
                try:
                    event = json.loads(line)
                    event_callback(agent_name, event)
                except (json.JSONDecodeError, ValueError):
                    pass  # not JSON, skip silently
    except (ValueError, OSError):
        pass  # pipe closed


def run_agent(agent: AgentConfig, task: dict, timeout_override: int | None = None,
              event_callback: Callable | None = None) -> RunResult:
    """Execute an agent in the configured execution environment.

    Checks settings.json for 'execution_environment' (container or baremetal).
    Container mode: isolated Docker execution with explicit env vars.
    Baremetal mode: direct host execution with sandboxed HOME.
    """
    if get_execution_environment() == "baremetal":
        return _run_agent_baremetal(agent, task, timeout_override, event_callback)
    tier = task["tier"]
    timeout = timeout_override or task.get("timeout") or TIER_TIMEOUTS.get(tier, 300)
    version = get_agent_version(agent)

    # Create isolated workspace on host (mounted into container)
    workspace = tempfile.mkdtemp(prefix=f"bench-{agent.name}-{task['id']}-")
    subprocess.run(["git", "init", workspace], capture_output=True)
    subprocess.run(
        ["git", "commit", "--allow-empty", "-m", "init"],
        capture_output=True, cwd=workspace,
        env={**os.environ, "GIT_AUTHOR_NAME": "bench", "GIT_AUTHOR_EMAIL": "bench@test",
             "GIT_COMMITTER_NAME": "bench", "GIT_COMMITTER_EMAIL": "bench@test"},
    )

    # Copy any task-provided files into the workspace (e.g. images for vision tasks)
    for file_spec in task.get("files", []):
        src = Path(__file__).resolve().parent / file_spec["source"]
        dst = os.path.join(workspace, file_spec["dest"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(str(src), dst)

    # Get container config from agent
    cc = agent.container_config(task["prompt"], workspace)

    # Build docker run command
    docker_cmd = ["docker", "run", "--rm"]

    # Add extra docker args (e.g. --add-host for host network access)
    if cc.extra_docker_args:
        docker_cmd.extend(cc.extra_docker_args)

    # Add mounts
    for host_path, container_path, mode in cc.mounts:
        docker_cmd.extend(["-v", f"{host_path}:{container_path}:{mode}"])

    # Add env vars (explicit — no host env leak)
    for key, val in cc.env.items():
        docker_cmd.extend(["-e", f"{key}={val}"])

    # Working directory inside container
    docker_cmd.extend(["-w", "/workspace"])

    # Use the agent image
    docker_cmd.append(AGENT_IMAGE)

    # Add the command
    docker_cmd.extend(cc.command)

    start = time.monotonic()
    timed_out = False
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    # Live log file
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    live_log_path = LOGS_DIR / f"{agent.name}-{task['id']}.live.log"
    live_log_file = open(live_log_path, "w")
    live_log_file.write(f"=== CONTAINER LIVE LOG: {agent.name} / {task['id']} | {time.strftime('%H:%M:%S')} ===\n")
    log_safe_docker_cmd = _sanitize_docker_cmd_for_log(docker_cmd)
    live_log_file.write(f"=== CMD: {log_safe_docker_cmd[:400]}... ===\n\n")
    live_log_file.flush()

    try:
        proc = subprocess.Popen(
            docker_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        stdout_thread = threading.Thread(
            target=_stream_stdout,
            args=(proc, agent.name, stdout_lines, event_callback, live_log_file),
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=_drain_stderr,
            args=(proc, stderr_lines),
            daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()

        # Wait with timeout — for containers, use docker kill for cleanup
        deadline = start + timeout
        while True:
            try:
                proc.wait(timeout=1.0)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    timed_out = True
                    # Kill via docker (more reliable than proc.kill for containers)
                    proc.kill()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    break

        stdout_thread.join(timeout=5)
        stderr_thread.join(timeout=5)

        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)
        exit_code = proc.returncode if proc.returncode is not None else -1

    except Exception as e:
        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines) + "\n" + str(e)
        exit_code = -1
    finally:
        try:
            live_log_file.close()
        except Exception:
            pass

    elapsed = time.monotonic() - start
    ws_files = list_workspace_files(workspace)
    file_contents = read_workspace_contents(workspace)

    # Save logs
    try:
        log_file = LOGS_DIR / f"{agent.name}-{task['id']}.log"
        with open(log_file, "w") as f:
            f.write(f"=== CONTAINER AGENT: {agent.name} | TASK: {task['id']} | ELAPSED: {elapsed:.1f}s ===\n")
            f.write(f"=== CMD: {_sanitize_docker_cmd_for_log(docker_cmd)} ===\n\n")
            f.write("=== STDOUT (agent log) ===\n")
            f.write(stdout or "(empty)")
            f.write("\n\n=== STDERR ===\n")
            f.write(stderr or "(empty)")
            f.write("\n")
    except Exception:
        pass

    return RunResult(
        agent_name=agent.name,
        model=agent.model,
        agent_version=version,
        task_id=task["id"],
        task_name=task["name"],
        tier=tier,
        elapsed_seconds=round(elapsed, 2),
        timed_out=timed_out,
        workspace=workspace,
        workspace_files=ws_files,
        file_contents=file_contents,
        stdout=stdout[-5000:] if len(stdout) > 5000 else stdout,
        stderr=stderr[-5000:] if len(stderr) > 5000 else stderr,
        exit_code=exit_code,
    )


def run_agent_with_workspace(
    agent: AgentConfig,
    task: dict,
    workspace: str,
    timeout_override: int | None = None,
    event_callback: Callable | None = None,
) -> RunResult:
    """Execute an agent using a pre-prepared workspace.

    Like run_agent() but skips workspace creation, git init, and file copy.
    Respects execution_environment setting (container or baremetal).
    """
    if get_execution_environment() == "baremetal":
        return _run_agent_baremetal_with_workspace(
            agent, task, workspace, timeout_override, event_callback
        )
    tier = task.get("tier", "hard")
    timeout = timeout_override or task.get("timeout") or TIER_TIMEOUTS.get(tier, 300)
    version = get_agent_version(agent)

    # Get container config from agent
    cc = agent.container_config(task["prompt"], workspace)

    # Build docker run command
    docker_cmd = ["docker", "run", "--rm"]
    if cc.extra_docker_args:
        docker_cmd.extend(cc.extra_docker_args)
    for host_path, container_path, mode in cc.mounts:
        docker_cmd.extend(["-v", f"{host_path}:{container_path}:{mode}"])
    for key, val in cc.env.items():
        docker_cmd.extend(["-e", f"{key}={val}"])
    docker_cmd.extend(["-w", "/workspace"])
    docker_cmd.append(AGENT_IMAGE)
    docker_cmd.extend(cc.command)

    start = time.monotonic()
    timed_out = False
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    live_log_path = LOGS_DIR / f"{agent.name}-{task['id']}.live.log"
    live_log_file = open(live_log_path, "w")
    live_log_file.write(f"=== CONTAINER LIVE LOG: {agent.name} / {task['id']} | {time.strftime('%H:%M:%S')} ===\n")
    log_safe_docker_cmd = _sanitize_docker_cmd_for_log(docker_cmd)
    live_log_file.write(f"=== CMD: {log_safe_docker_cmd[:400]}... ===\n\n")
    live_log_file.flush()

    try:
        proc = subprocess.Popen(
            docker_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        stdout_thread = threading.Thread(
            target=_stream_stdout,
            args=(proc, agent.name, stdout_lines, event_callback, live_log_file),
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=_drain_stderr, args=(proc, stderr_lines), daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()

        deadline = start + timeout
        while True:
            try:
                proc.wait(timeout=1.0)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    timed_out = True
                    proc.kill()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    break

        stdout_thread.join(timeout=5)
        stderr_thread.join(timeout=5)
        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)
        exit_code = proc.returncode if proc.returncode is not None else -1

    except Exception as e:
        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines) + "\n" + str(e)
        exit_code = -1
    finally:
        try:
            live_log_file.close()
        except Exception:
            pass

    elapsed = time.monotonic() - start
    ws_files = list_workspace_files(workspace)
    file_contents = read_workspace_contents(workspace)

    try:
        log_file = LOGS_DIR / f"{agent.name}-{task['id']}.log"
        with open(log_file, "w") as f:
            f.write(f"=== CONTAINER AGENT: {agent.name} | TASK: {task['id']} | ELAPSED: {elapsed:.1f}s ===\n")
            f.write(f"=== CMD: {_sanitize_docker_cmd_for_log(docker_cmd)} ===\n\n")
            f.write("=== STDOUT (agent log) ===\n")
            f.write(stdout or "(empty)")
            f.write("\n\n=== STDERR ===\n")
            f.write(stderr or "(empty)")
            f.write("\n")
    except Exception:
        pass

    return RunResult(
        agent_name=agent.name,
        model=agent.model,
        agent_version=version,
        task_id=task["id"],
        task_name=task.get("name", task["id"]),
        tier=tier,
        elapsed_seconds=round(elapsed, 2),
        timed_out=timed_out,
        workspace=workspace,
        workspace_files=ws_files,
        file_contents=file_contents,
        stdout=stdout[-5000:] if len(stdout) > 5000 else stdout,
        stderr=stderr[-5000:] if len(stderr) > 5000 else stderr,
        exit_code=exit_code,
    )


# ── Baremetal execution ──────────────────────────────────────────────────────


def _translate_container_paths(command: list[str], mounts: list[tuple[str, str, str]],
                               workspace: str) -> list[str]:
    """Translate container paths in command to host paths using mount mappings."""
    translated = []
    for arg in command:
        for host_path, container_path, _ in mounts:
            arg = arg.replace(container_path, host_path)
        arg = arg.replace("/workspace", workspace)
        translated.append(arg)
    return translated


def _run_baremetal_core(
    agent: AgentConfig, task: dict, workspace: str,
    timeout: int, event_callback: Callable | None,
) -> RunResult:
    """Core baremetal execution: run agent directly on host with sandboxed HOME."""
    version = get_agent_version(agent)
    tier = task.get("tier", "hard")

    # Get container config for env vars and command
    cc = agent.container_config(task.get("prompt", task.get("description", "")), workspace)

    # Translate container paths to host paths
    cmd = _translate_container_paths(cc.command, cc.mounts, workspace)

    # Build a sandboxed HOME so credential setup doesn't pollute real home
    sandbox_home = tempfile.mkdtemp(prefix=f"bench-home-{agent.name}-")

    # Build env: start from a minimal set, add agent's env vars with path translation
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": sandbox_home,
        "USER": os.environ.get("USER", "bench"),
        "TERM": "dumb",
        "LANG": "en_US.UTF-8",
    }
    for key, val in cc.env.items():
        translated_val = val
        for host_path, container_path, _ in cc.mounts:
            translated_val = translated_val.replace(container_path, host_path)
        translated_val = translated_val.replace("/workspace", workspace)
        translated_val = translated_val.replace("/home/bench", sandbox_home)
        env[key] = translated_val
    # Ensure HOME points to sandbox
    env["HOME"] = sandbox_home

    start = time.monotonic()
    timed_out = False
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    live_log_path = LOGS_DIR / f"{agent.name}-{task['id']}.live.log"
    live_log_file = open(live_log_path, "w")
    cmd_str = " ".join(cmd)
    live_log_file.write(f"=== BAREMETAL LIVE LOG: {agent.name} / {task['id']} | {time.strftime('%H:%M:%S')} ===\n")
    live_log_file.write(f"=== CMD: {cmd_str[:400]}... ===\n\n")
    live_log_file.flush()

    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=workspace, env=env,
        )
        stdout_thread = threading.Thread(
            target=_stream_stdout,
            args=(proc, agent.name, stdout_lines, event_callback, live_log_file),
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=_drain_stderr, args=(proc, stderr_lines), daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()

        deadline = start + timeout
        while True:
            try:
                proc.wait(timeout=1.0)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    timed_out = True
                    proc.kill()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
                    break

        stdout_thread.join(timeout=5)
        stderr_thread.join(timeout=5)
        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)
        exit_code = proc.returncode if proc.returncode is not None else -1

    except Exception as e:
        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines) + "\n" + str(e)
        exit_code = -1
    finally:
        try:
            live_log_file.close()
        except Exception:
            pass

    elapsed = time.monotonic() - start
    ws_files = list_workspace_files(workspace)
    file_contents = read_workspace_contents(workspace)

    # Clean up sandbox home
    try:
        shutil.rmtree(sandbox_home, ignore_errors=True)
    except Exception:
        pass

    try:
        log_file = LOGS_DIR / f"{agent.name}-{task['id']}.log"
        with open(log_file, "w") as f:
            f.write(f"=== BAREMETAL AGENT: {agent.name} | TASK: {task['id']} | ELAPSED: {elapsed:.1f}s ===\n")
            f.write(f"=== CMD: {_sanitize_docker_cmd_for_log(cmd)} ===\n\n")
            f.write("=== STDOUT (agent log) ===\n")
            f.write(stdout or "(empty)")
            f.write("\n\n=== STDERR ===\n")
            f.write(stderr or "(empty)")
            f.write("\n")
    except Exception:
        pass

    return RunResult(
        agent_name=agent.name,
        model=agent.model,
        agent_version=version,
        task_id=task["id"],
        task_name=task.get("name", task["id"]),
        tier=tier,
        elapsed_seconds=round(elapsed, 2),
        timed_out=timed_out,
        workspace=workspace,
        workspace_files=ws_files,
        file_contents=file_contents,
        stdout=stdout[-5000:] if len(stdout) > 5000 else stdout,
        stderr=stderr[-5000:] if len(stderr) > 5000 else stderr,
        exit_code=exit_code,
    )


def _run_agent_baremetal(agent: AgentConfig, task: dict,
                         timeout_override: int | None = None,
                         event_callback: Callable | None = None) -> RunResult:
    """Execute an agent directly on the host (baremetal mode)."""
    tier = task["tier"]
    timeout = timeout_override or task.get("timeout") or TIER_TIMEOUTS.get(tier, 300)

    # Create isolated workspace
    workspace = tempfile.mkdtemp(prefix=f"bench-{agent.name}-{task['id']}-")
    subprocess.run(["git", "init", workspace], capture_output=True)
    subprocess.run(
        ["git", "commit", "--allow-empty", "-m", "init"],
        capture_output=True, cwd=workspace,
        env={**os.environ, "GIT_AUTHOR_NAME": "bench", "GIT_AUTHOR_EMAIL": "bench@test",
             "GIT_COMMITTER_NAME": "bench", "GIT_COMMITTER_EMAIL": "bench@test"},
    )

    # Copy task files
    for file_spec in task.get("files", []):
        src = Path(__file__).resolve().parent / file_spec["source"]
        dst = os.path.join(workspace, file_spec["dest"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(str(src), dst)

    return _run_baremetal_core(agent, task, workspace, timeout, event_callback)


def _run_agent_baremetal_with_workspace(
    agent: AgentConfig, task: dict, workspace: str,
    timeout_override: int | None = None,
    event_callback: Callable | None = None,
) -> RunResult:
    """Execute an agent directly on the host using a pre-prepared workspace."""
    tier = task.get("tier", "hard")
    timeout = timeout_override or task.get("timeout") or TIER_TIMEOUTS.get(tier, 300)
    return _run_baremetal_core(agent, task, workspace, timeout, event_callback)
