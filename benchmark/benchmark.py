#!/usr/bin/env python3
"""AI Agent Benchmark — Main CLI entry point.

Usage:
    python benchmark.py                           # Run all tasks on all agents (parallel)
    python benchmark.py --agents shizuha codex    # Specific agents
    python benchmark.py --tier easy               # Specific tier
    python benchmark.py --task easy-fizzbuzz      # Single task
    python benchmark.py --jury-only results/run.json  # Judge existing results only (jury always runs)
    python benchmark.py --jury-backend codex-xhigh    # Use codex with gpt-5.3-xhigh as jury
    python benchmark.py --jury-backend all            # Majority vote across all backends
    python benchmark.py --resume results/run.json     # Resume an interrupted run
    python benchmark.py --report results/run.json     # Regenerate report from saved results
    python benchmark.py --no-dashboard                 # Disable live dashboard (on by default at :8002)
    python benchmark.py --import results/run-*.json   # Import JSON results into DB
    python benchmark.py --skip-passed                 # Skip tasks with cached pass (default)
    python benchmark.py --no-skip                     # Force re-run everything
"""

import argparse
import glob as globmod
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

import yaml

from config import (
    AGENTS,
    AGENT_DOCKERFILE_PATH,
    AGENT_IMAGE,
    DOCKERFILE_PATH,
    EVAL_IMAGE,
    RESULTS_DIR,
    TASKS_FILE,
    get_agent,
)
from db import BenchmarkDB, compute_agent_hash, compute_task_hash, get_git_info
from evaluator import evaluate_task
from reporter import generate_report
from runner import run_agent

# ─── Workspace Archiving ────────────────────────────────────────────────────

ARCHIVES_DIR = Path(__file__).resolve().parent / "archives"


def archive_workspace(workspace: str, agent_name: str, model: str, task_id: str,
                      passed: bool) -> str | None:
    """Archive a workspace to archives/{agent}_{model}/{task_id}/ as a .tar.gz.

    Maintains two archives per agent-model-task combination:
      - latest.tar.gz  — always overwritten with the most recent run
      - passed.tar.gz   — only overwritten when the run passes

    Returns the archive path or None if archiving fails.
    """
    import shutil
    import tarfile

    try:
        # Sanitize model name for directory (replace / with -)
        model_safe = model.replace("/", "-")
        archive_dir = ARCHIVES_DIR / f"{agent_name}_{model_safe}" / task_id
        archive_dir.mkdir(parents=True, exist_ok=True)

        # Create latest archive
        latest_path = archive_dir / "latest.tar.gz"
        with tarfile.open(latest_path, "w:gz") as tar:
            for root, dirs, files in os.walk(workspace):
                dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".pytest_cache")]
                for f in files:
                    full = os.path.join(root, f)
                    arcname = os.path.relpath(full, workspace)
                    try:
                        tar.add(full, arcname=arcname)
                    except (PermissionError, OSError):
                        pass

        # If passed, also copy to passed.tar.gz
        if passed:
            passed_path = archive_dir / "passed.tar.gz"
            shutil.copy2(latest_path, passed_path)

        return str(latest_path)
    except Exception:
        return None


# ─── Live Agent State ─────────────────────────────────────────────────────────

class Activity(str, Enum):
    STARTING = "starting"
    THINKING = "thinking"
    WRITING = "writing"
    RUNNING_TOOL = "running_tool"
    COMPLETE = "complete"


@dataclass
class AgentLiveState:
    """Real-time state for a running agent."""
    agent_name: str
    task_id: str
    task_name: str
    tier: str
    start_time: float = field(default_factory=time.monotonic)
    current_turn: int = 0
    max_turns: int = 50
    activity: Activity = Activity.STARTING
    current_tool: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    events: deque = field(default_factory=lambda: deque(maxlen=200))
    tool_calls: list = field(default_factory=list)
    agent_output: str = ""


# ─── Shared benchmark state (for dashboard) ─────────────────────────────────

LIVE_STATE_PATH = Path("/tmp/benchmark-live.json")


class BenchmarkState:
    """Thread-safe shared state for the benchmark runner and dashboard."""

    def __init__(self):
        self._lock = threading.Lock()
        self._event_seq = 0  # monotonic event sequence number
        self.results: list[dict] = []
        self.running: dict[str, dict] = {}  # agent_name -> {task_id, task_name, tier, start_time}
        self.live_agents: dict[str, AgentLiveState] = {}  # agent_name -> live state
        self.completed_count = 0
        self.skipped_count = 0
        self.total_pairs = 0
        self.start_time: float | None = None
        self.finished = False
        self.tasks: list[dict] = []
        self.agent_names: list[str] = []
        self.log_lines: list[str] = []
        self._all_events: deque = deque(maxlen=2000)  # global event ring for SSE
        self._last_live_write = 0.0  # throttle file writes

    def write_live_state(self, force: bool = False):
        """Write live state to a JSON file for the standalone dashboard.
        Throttled to max once per second unless force=True."""
        now = time.time()
        if not force and (now - self._last_live_write) < 1.0:
            return
        self._last_live_write = now
        try:
            mono_now = time.monotonic()
            running = {}
            for name, live in self.live_agents.items():
                running[name] = {
                    "task_id": live.task_id,
                    "task_name": live.task_name,
                    "tier": live.tier,
                    "elapsed": round(mono_now - live.start_time, 1),
                    "current_turn": live.current_turn,
                    "max_turns": live.max_turns,
                    "activity": live.activity.value,
                    "current_tool": live.current_tool,
                    "input_tokens": live.input_tokens,
                    "output_tokens": live.output_tokens,
                }
            state = {
                "active": True,
                "ts": now,
                "total_pairs": self.total_pairs,
                "completed": self.completed_count,
                "skipped": self.skipped_count,
                "running": running,
                "finished": self.finished,
                "elapsed": round(mono_now - self.start_time, 1) if self.start_time else 0,
                "agents": self.agent_names,
                "results_summary": self._results_summary(),
                "log_lines": list(self.log_lines[-50:]),
            }
            tmp = LIVE_STATE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(state))
            tmp.rename(LIVE_STATE_PATH)
        except Exception:
            pass  # Don't crash the benchmark over dashboard IO

    def clear_live_state(self):
        """Remove the live state file when benchmark finishes."""
        try:
            LIVE_STATE_PATH.unlink(missing_ok=True)
        except Exception:
            pass

    def log(self, msg: str):
        with self._lock:
            self.log_lines.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            # Keep last 500 lines
            if len(self.log_lines) > 500:
                self.log_lines = self.log_lines[-500:]
        print(msg, flush=True)

    def set_running(self, agent_name: str, task: dict):
        with self._lock:
            self.running[agent_name] = {
                "task_id": task["id"],
                "task_name": task["name"],
                "tier": task["tier"],
                "start_time": time.monotonic(),
            }
            self.live_agents[agent_name] = AgentLiveState(
                agent_name=agent_name,
                task_id=task["id"],
                task_name=task["name"],
                tier=task["tier"],
            )
            self.write_live_state(force=True)

    def clear_running(self, agent_name: str):
        with self._lock:
            self.running.pop(agent_name, None)
            self.live_agents.pop(agent_name, None)
            self.write_live_state(force=True)

    def add_result(self, result: dict):
        with self._lock:
            self.results.append(result)
            self.completed_count += 1
            self.write_live_state(force=True)

    def add_skip(self):
        with self._lock:
            self.skipped_count += 1

    def push_event(self, agent_name: str, raw_event: dict):
        """Called by runner's event_callback — normalize and store event."""
        with self._lock:
            live = self.live_agents.get(agent_name)
            if not live:
                return

            normalized = self._normalize_event(agent_name, raw_event, live)
            if not normalized:
                return

            self._event_seq += 1
            normalized["seq"] = self._event_seq
            normalized["ts"] = time.time()

            live.events.append(normalized)
            self._all_events.append(normalized)
            self.write_live_state()  # throttled to 1/s

    @staticmethod
    def _coerce_int(value: Any, default: int = 0) -> int:
        """Best-effort int conversion for mixed event payloads."""
        try:
            if value is None:
                return default
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _short_command_label(command: Any) -> str:
        """Create a human-friendly command label from raw command payloads."""
        if isinstance(command, list):
            cmd = " ".join(str(part) for part in command)
        else:
            cmd = str(command or "")

        if not cmd:
            return "shell"

        # Common wrappers from Codex logs: /bin/bash -lc "<inner>"
        m = re.match(r"^(/bin/)?bash\s+-lc\s+(['\"])(.*)\2$", cmd, flags=re.DOTALL)
        if m:
            cmd = m.group(3)

        line = cmd.splitlines()[0].strip()
        if "<<" in line:
            line = line.split("<<", 1)[0].strip()

        # Convert noisy heredoc write commands into concise labels.
        if line.startswith("cat > "):
            parts = line.split()
            if len(parts) >= 3:
                return f"write {parts[2]}"

        if not line:
            line = cmd.strip()[:90]

        if len(line) > 90:
            line = line[:87] + "..."
        return line

    def _apply_token_usage(self, live: AgentLiveState, event: dict):
        """Extract and accumulate token usage from multiple event schemas."""
        usage = event.get("usage")
        if isinstance(usage, dict):
            inp = usage.get("input_tokens", 0) or usage.get("prompt_tokens", 0)
            out = usage.get("output_tokens", 0) or usage.get("completion_tokens", 0)
        else:
            inp = event.get("inputTokens", 0) or event.get("input_tokens", 0) or event.get("prompt_tokens", 0)
            out = event.get("outputTokens", 0) or event.get("output_tokens", 0) or event.get("completion_tokens", 0)

        in_tokens = self._coerce_int(inp, 0)
        out_tokens = self._coerce_int(out, 0)
        if in_tokens or out_tokens:
            live.input_tokens += in_tokens
            live.output_tokens += out_tokens

    def _normalize_event(self, agent_name: str, event: dict, live: AgentLiveState) -> dict | None:
        """Normalize NDJSON events from different agent formats into a common schema.

        Returns a dict with: agent, kind, and extra fields depending on kind.
        Mutates `live` state as a side effect.
        """
        base = {"agent": agent_name}

        # ── Shizuha agent format ──
        event_type = event.get("type") or event.get("event")

        if event_type == "session_start":
            live.activity = Activity.THINKING
            live.max_turns = event.get("max_turns", 50)
            return {**base, "kind": "session_start", "model": event.get("model", "")}

        if event_type == "turn_start":
            turn = event.get("turn")
            if turn is None and event.get("turnIndex") is not None:
                turn = self._coerce_int(event.get("turnIndex"), 0) + 1
            if turn is None:
                turn = live.current_turn + 1
            live.current_turn = max(1, self._coerce_int(turn, live.current_turn + 1))
            live.activity = Activity.THINKING
            live.current_tool = None
            return {**base, "kind": "turn_start", "turn": live.current_turn}

        if event_type == "tool_start":
            tool_name = event.get("toolName") or event.get("tool") or event.get("name", "unknown")
            live.activity = Activity.RUNNING_TOOL
            live.current_tool = tool_name
            if len(live.tool_calls) < 100:
                live.tool_calls.append({
                    "tool": tool_name,
                    "turn": live.current_turn,
                    "ts": time.time(),
                })
            return {**base, "kind": "tool_start", "tool": tool_name}

        if event_type == "tool_complete":
            tool_name = event.get("toolName") or event.get("tool") or event.get("name", "unknown")
            live.activity = Activity.THINKING
            live.current_tool = None
            return {**base, "kind": "tool_complete", "tool": tool_name}

        if event_type == "content":
            text = event.get("text", "")
            if text:
                live.agent_output = (live.agent_output + text)[-5000:]
                live.activity = Activity.WRITING
            return {**base, "kind": "content", "text": text[:200]}

        if event_type == "turn_complete":
            live.activity = Activity.THINKING
            live.current_tool = None
            self._apply_token_usage(live, event)
            return {**base, "kind": "turn_complete", "turn": live.current_turn,
                    "input_tokens": live.input_tokens, "output_tokens": live.output_tokens}

        if event_type == "complete":
            live.activity = Activity.COMPLETE
            return {**base, "kind": "complete"}

        # ── Codex CLI format ──
        if event_type == "thread.started":
            live.activity = Activity.THINKING
            return {**base, "kind": "session_start", "model": event.get("model", "")}

        if event_type == "turn.started":
            live.current_turn += 1
            live.activity = Activity.THINKING
            return {**base, "kind": "turn_start", "turn": live.current_turn}

        if event_type == "item.started":
            item = event.get("item") if isinstance(event.get("item"), dict) else {}
            item_type = item.get("type") or event.get("item_type", "")
            if item_type == "command_execution":
                tool_name = self._short_command_label(item.get("command") or event.get("command") or "shell")
                live.activity = Activity.RUNNING_TOOL
                live.current_tool = tool_name
                if len(live.tool_calls) < 100:
                    live.tool_calls.append({
                        "tool": tool_name,
                        "turn": live.current_turn,
                        "ts": time.time(),
                    })
                return {**base, "kind": "tool_start", "tool": tool_name}
            elif item_type == "reasoning":
                live.activity = Activity.THINKING
                return {**base, "kind": "thinking"}
            elif item_type == "agent_message":
                live.activity = Activity.WRITING
                return {**base, "kind": "writing"}
            return None

        if event_type == "item.completed":
            item = event.get("item") if isinstance(event.get("item"), dict) else {}
            item_type = item.get("type") or event.get("item_type", "")
            if item_type == "command_execution":
                live.activity = Activity.THINKING
                live.current_tool = None
                tool_name = self._short_command_label(item.get("command") or event.get("command") or "shell")
                return {**base, "kind": "tool_complete", "tool": tool_name}
            elif item_type == "agent_message":
                text = item.get("text") or event.get("text", "")
                if text:
                    live.agent_output = (live.agent_output + text)[-5000:]
                return {**base, "kind": "content", "text": (text or "")[:200]}
            return None

        if event_type == "turn.completed":
            live.activity = Activity.THINKING
            live.current_tool = None
            self._apply_token_usage(live, event)
            return {**base, "kind": "turn_complete", "turn": live.current_turn,
                    "input_tokens": live.input_tokens, "output_tokens": live.output_tokens}

        if event_type == "thread.completed":
            live.activity = Activity.COMPLETE
            return {**base, "kind": "complete"}

        if event_type == "turn.failed":
            live.activity = Activity.THINKING
            live.current_tool = None
            err = event.get("error")
            if isinstance(err, dict):
                text = str(err.get("message", "turn failed"))
            else:
                text = str(err or "turn failed")
            return {**base, "kind": "error", "text": text[:200]}

        if event_type == "error":
            text = str(event.get("message", "error"))
            return {**base, "kind": "error", "text": text[:200]}

        # ── Claude Code format (single JSON blob at end) ──
        if "result" in event and isinstance(event.get("result"), str):
            text = event["result"][:200]
            live.agent_output = (live.agent_output + event["result"])[-5000:]
            live.activity = Activity.COMPLETE
            usage = event.get("usage", {})
            if usage:
                live.input_tokens = usage.get("input_tokens", 0)
                live.output_tokens = usage.get("output_tokens", 0)
            return {**base, "kind": "complete", "text": text}

        # ── Generic: try to extract useful info ──
        # Look for token usage in any format
        usage = event.get("usage") or event.get("token_usage")
        if usage and isinstance(usage, dict):
            inp = usage.get("input_tokens", 0) or usage.get("prompt_tokens", 0)
            out = usage.get("output_tokens", 0) or usage.get("completion_tokens", 0)
            if inp or out:
                live.input_tokens = max(live.input_tokens, inp)
                live.output_tokens = max(live.output_tokens, out)
                return {**base, "kind": "usage", "input_tokens": live.input_tokens,
                        "output_tokens": live.output_tokens}

        return None  # unrecognized event

    def live_snapshot(self) -> dict:
        """Return JSON-serializable dict of all live agent states."""
        with self._lock:
            now = time.monotonic()
            result = {}
            for name, live in self.live_agents.items():
                result[name] = {
                    "task_id": live.task_id,
                    "task_name": live.task_name,
                    "tier": live.tier,
                    "elapsed": round(now - live.start_time, 1),
                    "current_turn": live.current_turn,
                    "max_turns": live.max_turns,
                    "activity": live.activity.value,
                    "current_tool": live.current_tool,
                    "input_tokens": live.input_tokens,
                    "output_tokens": live.output_tokens,
                    "tool_calls": list(live.tool_calls[-10:]),
                    "agent_output": live.agent_output[-500:],
                    "events": [dict(e) for e in list(live.events)[-20:]],
                }
            return result

    def get_events_since(self, last_seq: int) -> list[dict]:
        """Return events with seq > last_seq (for SSE)."""
        with self._lock:
            return [dict(e) for e in self._all_events if e.get("seq", 0) > last_seq]

    def snapshot(self) -> dict:
        """Return a JSON-serializable snapshot of current state."""
        with self._lock:
            now = time.monotonic()
            running_info = {}
            for agent, info in self.running.items():
                running_info[agent] = {
                    **info,
                    "elapsed": round(now - info["start_time"], 1),
                }
            return {
                "total_pairs": self.total_pairs,
                "completed": self.completed_count,
                "skipped": self.skipped_count,
                "running": running_info,
                "finished": self.finished,
                "elapsed": round(now - self.start_time, 1) if self.start_time else 0,
                "agents": self.agent_names,
                "log_lines": list(self.log_lines[-100:]),
                "results_summary": self._results_summary(),
                "live_agents": self._live_agents_summary(),
            }

    def _live_agents_summary(self) -> dict:
        """Compact live agent info for /api/status."""
        result = {}
        now = time.monotonic()
        for name, live in self.live_agents.items():
            result[name] = {
                "task_id": live.task_id,
                "tier": live.tier,
                "elapsed": round(now - live.start_time, 1),
                "current_turn": live.current_turn,
                "max_turns": live.max_turns,
                "activity": live.activity.value,
                "current_tool": live.current_tool,
                "input_tokens": live.input_tokens,
                "output_tokens": live.output_tokens,
                "recent_events": [dict(e) for e in list(live.events)[-5:]],
            }
        return result

    def _results_summary(self) -> list[dict]:
        """Per-agent pass/fail/timeout counts."""
        by_agent: dict[str, dict] = defaultdict(lambda: {"passed": 0, "failed": 0, "timeout": 0, "total": 0})
        for r in self.results:
            agent = r["agent"]
            by_agent[agent]["total"] += 1
            if r["timed_out"]:
                by_agent[agent]["timeout"] += 1
            elif r["passed"]:
                by_agent[agent]["passed"] += 1
            else:
                by_agent[agent]["failed"] += 1
        return [{"agent": k, **v} for k, v in by_agent.items()]


# Global state instance
STATE = BenchmarkState()


# ─── Dashboard ───────────────────────────────────────────────────────────────

def start_dashboard(port: int):
    """Start a threaded HTTP dashboard with SSE support in a background thread."""
    from http.server import HTTPServer, BaseHTTPRequestHandler
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

    class DashboardHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Suppress access logs

        def do_GET(self):
            if self.path == "/api/status":
                self._json_response(STATE.snapshot())

            elif self.path == "/api/results":
                with STATE._lock:
                    data = [
                        {
                            "agent": r["agent"],
                            "task_id": r["task_id"],
                            "task_name": r["task_name"],
                            "tier": r["tier"],
                            "passed": r["passed"],
                            "timed_out": r["timed_out"],
                            "elapsed_seconds": r["elapsed_seconds"],
                            "score": r["score"],
                        }
                        for r in STATE.results
                    ]
                self._json_response(data)

            elif self.path == "/api/live":
                self._json_response(STATE.live_snapshot())

            elif self.path.startswith("/api/agent/"):
                agent_name = self.path[len("/api/agent/"):]
                snapshot = STATE.live_snapshot()
                if agent_name in snapshot:
                    self._json_response(snapshot[agent_name])
                else:
                    self.send_response(404)
                    self.end_headers()

            elif self.path == "/api/events":
                self._handle_sse()

            elif self.path == "/":
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(DASHBOARD_HTML.encode())

            else:
                self.send_response(404)
                self.end_headers()

        def _json_response(self, data):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data, default=str).encode())

        def _handle_sse(self):
            """Server-Sent Events stream for real-time agent monitoring."""
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            last_seq = 0
            status_tick = 0

            try:
                while not STATE.finished:
                    # Send new events
                    new_events = STATE.get_events_since(last_seq)
                    for evt in new_events:
                        last_seq = max(last_seq, evt.get("seq", 0))
                        line = f"data: {json.dumps(evt, default=str)}\n\n"
                        self.wfile.write(line.encode())

                    # Send status heartbeat every 2 ticks (2 seconds)
                    status_tick += 1
                    if status_tick >= 2:
                        status_tick = 0
                        snapshot = STATE.snapshot()
                        line = f"event: status\ndata: {json.dumps(snapshot, default=str)}\n\n"
                        self.wfile.write(line.encode())

                    self.wfile.flush()
                    time.sleep(1)

                # Final done event
                self.wfile.write(b"event: done\ndata: {}\n\n")
                self.wfile.flush()

            except (BrokenPipeError, ConnectionResetError, OSError):
                pass  # client disconnected

    server = ThreadingHTTPServer(("0.0.0.0", port), DashboardHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


DASHBOARD_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Benchmark Dashboard</title>
<style>
  :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3;
          --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --red: #f85149;
          --orange: #d29922; --purple: #bc8cff; --cyan: #39d2c0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: var(--bg); color: var(--text); padding: 1.5rem; }

  /* Header */
  .header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .header h1 { font-size: 1.4rem; flex-shrink: 0; }
  .header-stats { display: flex; gap: 1rem; align-items: center; margin-left: auto; font-size: 0.9rem; }
  .header-stats .stat-val { font-weight: 700; color: var(--accent); }
  .connection-badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .connection-badge.sse { background: rgba(63,185,80,0.2); color: var(--green); }
  .connection-badge.poll { background: rgba(210,153,34,0.2); color: var(--orange); }
  .connection-badge.dead { background: rgba(248,81,73,0.2); color: var(--red); }

  /* Progress */
  .progress-bar { height: 6px; background: var(--surface); border-radius: 3px; overflow: hidden; margin-bottom: 0.5rem; }
  .progress-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
  .progress-fill.running { background: linear-gradient(90deg, var(--accent), var(--cyan)); }
  .progress-fill.done { background: var(--green); }
  .progress-label { text-align: center; color: var(--muted); font-size: 0.8rem; margin-bottom: 1.5rem; }

  /* Section headers */
  h2 { font-size: 1rem; color: var(--accent); margin: 1.5rem 0 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
  h2 .count { font-size: 0.8rem; color: var(--muted); font-weight: 400; }

  /* Agent cards */
  .agents-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
  .agent-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; border-left: 3px solid var(--accent); }
  .agent-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .agent-name { font-weight: 700; font-size: 1.05rem; }
  .activity-badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .activity-thinking { background: rgba(88,166,255,0.2); color: var(--accent); }
  .activity-writing { background: rgba(63,185,80,0.2); color: var(--green); }
  .activity-running_tool { background: rgba(188,140,255,0.2); color: var(--purple); animation: pulse 1.5s infinite; }
  .activity-starting { background: rgba(210,153,34,0.2); color: var(--orange); }
  .activity-complete { background: rgba(63,185,80,0.2); color: var(--green); }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

  .agent-meta { display: flex; gap: 1rem; font-size: 0.8rem; color: var(--muted); margin-bottom: 0.75rem; flex-wrap: wrap; }
  .agent-meta span { display: flex; align-items: center; gap: 0.3rem; }

  /* Turn progress */
  .turn-bar { height: 4px; background: var(--bg); border-radius: 2px; overflow: hidden; margin: 0.3rem 0 0.75rem; }
  .turn-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.3s; }

  /* Token display */
  .tokens { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.5rem; }
  .tokens .num { color: var(--cyan); font-weight: 600; font-family: monospace; }

  /* Tool indicator */
  .current-tool { font-size: 0.8rem; padding: 3px 8px; background: rgba(188,140,255,0.15); color: var(--purple);
                   border-radius: 4px; display: inline-block; margin-bottom: 0.5rem; font-family: monospace; }

  /* Tool history */
  .tool-history { font-size: 0.75rem; color: var(--muted); margin-bottom: 0.5rem; }
  .tool-history .tool-tag { display: inline-block; padding: 1px 5px; background: rgba(139,148,158,0.1);
                             border-radius: 3px; margin: 1px 2px; font-family: monospace; }

  /* Agent output */
  .agent-output { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem;
                   font-family: monospace; font-size: 0.75rem; max-height: 80px; overflow-y: auto;
                   white-space: pre-wrap; color: var(--muted); margin-bottom: 0.5rem; word-break: break-all; }

  /* Event log */
  .event-log { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem;
               font-family: monospace; font-size: 0.7rem; max-height: 120px; overflow-y: auto;
               color: var(--muted); }
  .event-log .evt { padding: 1px 0; border-bottom: 1px solid rgba(48,54,61,0.5); }
  .evt-tool_start { color: var(--purple); }
  .evt-tool_complete { color: var(--cyan); }
  .evt-turn_start { color: var(--accent); }
  .evt-turn_complete { color: var(--orange); }
  .evt-content, .evt-writing { color: var(--green); }
  .evt-complete { color: var(--green); font-weight: 600; }

  /* Summary grid */
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }
  .summary-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem; text-align: center; }
  .summary-card .agent-name { font-size: 0.95rem; }

  /* Results table */
  .results-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .results-table th, .results-table td { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); text-align: left; }
  .results-table th { color: var(--muted); font-weight: 500; }

  /* Badges */
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
  .badge-pass { background: rgba(63,185,80,0.2); color: var(--green); }
  .badge-fail { background: rgba(248,81,73,0.2); color: var(--red); }
  .badge-timeout { background: rgba(210,153,34,0.2); color: var(--orange); }
  .tier { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; padding: 1px 6px; border-radius: 4px; }
  .tier-easy { background: rgba(63,185,80,0.15); color: var(--green); }
  .tier-medium { background: rgba(210,153,34,0.15); color: var(--orange); }
  .tier-hard { background: rgba(248,81,73,0.15); color: var(--red); }
  .tier-extreme { background: rgba(188,140,255,0.15); color: var(--purple); }
  .tier-nightmare { background: rgba(248,81,73,0.3); color: #ff6b6b; }
  .tier-impossible { background: rgba(255,0,0,0.25); color: #ff4444; font-weight: 800; }

  /* System log */
  .log { background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
         padding: 0.75rem; font-family: monospace; font-size: 0.8rem; max-height: 250px;
         overflow-y: auto; white-space: pre-wrap; color: var(--muted); }

  /* Finished banner */
  .finished-banner { background: rgba(63,185,80,0.15); border: 1px solid var(--green); border-radius: 8px;
                     padding: 1rem; text-align: center; font-size: 1.2rem; color: var(--green); margin-bottom: 1rem; }

  /* Collapsible */
  .collapse-toggle { cursor: pointer; color: var(--accent); font-size: 0.75rem; user-select: none; }
  .collapse-toggle:hover { text-decoration: underline; }
</style>
</head>
<body>
<div id="app">Loading...</div>

<script>
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
const fmt = s => Math.floor(s/60)+'m '+Math.round(s%60)+'s';
const fmtTokens = n => n >= 1000000 ? (n/1000000).toFixed(1)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : ''+n;
const tierBadge = t => `<span class="tier tier-${esc(t)}">${esc(t)}</span>`;

let connectionMode = 'connecting';
let statusData = null;
let resultsData = [];
let sseConnected = false;
let lastRender = 0;
let userScrolled = {};  // track per-agent if user scrolled up

function render() {
  if (!statusData) return;
  const data = statusData;
  const pct = data.total_pairs ? Math.round(((data.completed + data.skipped) / data.total_pairs) * 100) : 0;
  let html = '';

  // Header
  html += `<div class="header">
    <h1>AI Agent Benchmark</h1>
    <div class="header-stats">
      <span><span class="stat-val">${data.completed}</span> / ${data.total_pairs} done</span>
      <span><span class="stat-val">${fmt(data.elapsed)}</span></span>
      <span class="connection-badge ${connectionMode}">${connectionMode === 'sse' ? 'SSE Live' : connectionMode === 'poll' ? 'Polling' : connectionMode === 'dead' ? 'Disconnected' : 'Connecting...'}</span>
    </div>
  </div>`;

  if (data.finished) {
    html += `<div class="finished-banner">Benchmark Complete! ${data.completed} tasks evaluated in ${fmt(data.elapsed)}</div>`;
  }

  // Progress bar
  html += `<div class="progress-bar"><div class="progress-fill ${data.finished ? 'done' : 'running'}" style="width:${pct}%"></div></div>`;
  html += `<div class="progress-label">${pct}% \u2014 ${data.completed + data.skipped}/${data.total_pairs} (${data.skipped} cached/skipped)</div>`;

  // Running agents panel
  const liveAgents = data.live_agents || {};
  const liveNames = Object.keys(liveAgents);
  if (liveNames.length > 0) {
    html += `<h2>Running Agents <span class="count">(${liveNames.length})</span></h2>`;
    html += '<div class="agents-grid">';
    for (const name of liveNames) {
      const ag = liveAgents[name];
      const turnPct = ag.max_turns ? Math.round((ag.current_turn / ag.max_turns) * 100) : 0;

      html += `<div class="agent-card">`;

      // Header: name + activity badge
      html += `<div class="agent-header">
        <span class="agent-name">${esc(name)}</span>
        <span class="activity-badge activity-${esc(ag.activity)}">${esc(ag.activity.replace('_', ' '))}</span>
      </div>`;

      // Meta: task, tier, elapsed
      html += `<div class="agent-meta">
        <span>${esc(ag.task_id)} ${tierBadge(ag.tier)}</span>
        <span style="color:var(--orange);font-weight:600">${fmt(ag.elapsed)}</span>
      </div>`;

      // Turn progress
      html += `<div style="font-size:0.8rem;color:var(--muted)">Turn ${ag.current_turn} / ${ag.max_turns}</div>`;
      html += `<div class="turn-bar"><div class="turn-fill" style="width:${turnPct}%"></div></div>`;

      // Tokens
      if (ag.input_tokens || ag.output_tokens) {
        html += `<div class="tokens">Tokens: <span class="num">${fmtTokens(ag.input_tokens)}</span> in / <span class="num">${fmtTokens(ag.output_tokens)}</span> out</div>`;
      }

      // Current tool
      if (ag.current_tool) {
        html += `<div class="current-tool">\u25B6 ${esc(ag.current_tool)}</div>`;
      }

      // Tool history (last 8)
      if (ag.tool_calls && ag.tool_calls.length > 0) {
        const recent = ag.tool_calls.slice(-8);
        html += `<div class="tool-history">Tools: ${recent.map(t => `<span class="tool-tag">${esc(t.tool)}</span>`).join('')}</div>`;
      }

      // Agent output (last 500 chars)
      if (ag.agent_output) {
        html += `<div class="agent-output" id="output-${esc(name)}">${esc(ag.agent_output.slice(-500))}</div>`;
      }

      // Event log (last 15)
      const events = ag.recent_events || ag.events || [];
      if (events.length > 0) {
        const logId = `events-${name}`;
        html += `<div class="event-log" id="${esc(logId)}">`;
        for (const ev of events.slice(-15)) {
          const kind = ev.kind || 'unknown';
          let desc = kind;
          if (kind === 'tool_start') desc = `\u25B6 tool: ${ev.tool || '?'}`;
          else if (kind === 'tool_complete') desc = `\u2714 tool: ${ev.tool || '?'}`;
          else if (kind === 'turn_start') desc = `Turn ${ev.turn || '?'} started`;
          else if (kind === 'turn_complete') desc = `Turn ${ev.turn || '?'} done (${fmtTokens(ev.input_tokens||0)}/${fmtTokens(ev.output_tokens||0)} tok)`;
          else if (kind === 'content') desc = `\u270E ${(ev.text||'').slice(0, 80)}`;
          else if (kind === 'session_start') desc = `Session started (${ev.model || ''})`;
          else if (kind === 'complete') desc = '\u2713 Complete';
          html += `<div class="evt evt-${esc(kind)}">${esc(desc)}</div>`;
        }
        html += '</div>';
      }

      html += '</div>';  // agent-card
    }
    html += '</div>';  // agents-grid
  }

  // Agent summary scores
  if (data.results_summary && data.results_summary.length > 0) {
    html += '<h2>Agent Scores</h2><div class="summary-grid">';
    for (const s of data.results_summary) {
      html += `<div class="summary-card">
        <div class="agent-name">${esc(s.agent)}</div>
        <div style="margin-top:0.5rem">
          <span class="badge badge-pass">${s.passed} pass</span>
          <span class="badge badge-fail">${s.failed} fail</span>
          <span class="badge badge-timeout">${s.timeout} timeout</span>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  // Results table
  if (resultsData.length > 0) {
    html += '<h2>Results <span class="count">(' + resultsData.length + ')</span></h2>';
    html += '<table class="results-table"><thead><tr><th>Agent</th><th>Task</th><th>Tier</th><th>Status</th><th>Time</th><th>Score</th></tr></thead><tbody>';
    const sorted = [...resultsData].reverse();
    for (const r of sorted.slice(0, 50)) {
      const badge = r.timed_out ? 'badge-timeout' : (r.passed ? 'badge-pass' : 'badge-fail');
      const label = r.timed_out ? 'TIMEOUT' : (r.passed ? 'PASS' : 'FAIL');
      html += `<tr>
        <td>${esc(r.agent)}</td>
        <td>${esc(r.task_name)}</td>
        <td>${tierBadge(r.tier)}</td>
        <td><span class="badge ${badge}">${label}</span></td>
        <td>${r.elapsed_seconds}s</td>
        <td>${Math.round(r.score * 100)}%</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  // System log
  if (data.log_lines && data.log_lines.length > 0) {
    html += '<h2>System Log <span class="count">(' + data.log_lines.length + ')</span></h2>';
    html += '<div class="log" id="logbox">';
    html += data.log_lines.map(l => esc(l)).join('\\n');
    html += '</div>';
  }

  document.getElementById('app').innerHTML = html;

  // Auto-scroll event logs and system log
  const logbox = document.getElementById('logbox');
  if (logbox) logbox.scrollTop = logbox.scrollHeight;
  for (const name of liveNames) {
    const el = document.getElementById('events-' + name);
    if (el) el.scrollTop = el.scrollHeight;
  }
}

// ── SSE connection ──
function connectSSE() {
  const evtSource = new EventSource('/api/events');

  evtSource.onopen = () => {
    connectionMode = 'sse';
    sseConnected = true;
    render();
  };

  evtSource.onmessage = (e) => {
    // Default events (agent events) — just trigger a re-render on next status update
  };

  evtSource.addEventListener('status', (e) => {
    try {
      statusData = JSON.parse(e.data);
      render();
    } catch(err) {}
  });

  evtSource.addEventListener('done', () => {
    connectionMode = 'poll';
    evtSource.close();
    // Do final poll to get final state
    pollOnce();
  });

  evtSource.onerror = () => {
    if (sseConnected) {
      sseConnected = false;
      connectionMode = 'poll';
      evtSource.close();
      startPolling();
    } else {
      // SSE never connected, fall back to polling
      connectionMode = 'poll';
      evtSource.close();
      startPolling();
    }
  };

  // Timeout: if no open event in 3 seconds, fall back
  setTimeout(() => {
    if (!sseConnected) {
      evtSource.close();
      connectionMode = 'poll';
      startPolling();
    }
  }, 3000);
}

// ── Polling fallback ──
let pollInterval = null;

async function pollOnce() {
  try {
    const [statusRes, resultsRes] = await Promise.all([
      fetch('/api/status'),
      fetch('/api/results')
    ]);
    statusData = await statusRes.json();
    resultsData = await resultsRes.json();
    if (connectionMode === 'dead') connectionMode = 'poll';
    render();
  } catch(e) {
    connectionMode = 'dead';
    render();
  }
}

function startPolling() {
  if (pollInterval) return;
  pollOnce();
  pollInterval = setInterval(pollOnce, 2000);
}

// ── Also poll results on a slower interval (SSE doesn't send full results list) ──
setInterval(async () => {
  try {
    const res = await fetch('/api/results');
    resultsData = await res.json();
  } catch(e) {}
}, 5000);

// ── Init ──
connectSSE();
// Always do an initial poll to seed data immediately
pollOnce();
</script>
</body>
</html>
"""


# ─── Core benchmark logic ────────────────────────────────────────────────────

def load_tasks(tasks_file: Path = TASKS_FILE) -> list[dict]:
    """Load task definitions from YAML."""
    with open(tasks_file) as f:
        return yaml.safe_load(f)


def filter_tasks(tasks: list[dict], tier: str | None, task_ids: list[str] | None) -> list[dict]:
    """Filter tasks by tier or specific task ID(s)."""
    if task_ids:
        id_set = set(task_ids)
        filtered = [t for t in tasks if t["id"] in id_set]
        missing = id_set - {t["id"] for t in filtered}
        if missing:
            print(f"Error: task(s) not found: {missing}. Available: {[t['id'] for t in tasks]}")
            sys.exit(1)
        return filtered
    if tier:
        filtered = [t for t in tasks if t["tier"] == tier]
        if not filtered:
            print(f"Error: no tasks in tier '{tier}'.")
            sys.exit(1)
        return filtered
    return tasks


def ensure_eval_image():
    """Build the evaluation Docker image if it doesn't exist."""
    result = subprocess.run(
        ["docker", "image", "inspect", EVAL_IMAGE],
        capture_output=True,
    )
    if result.returncode == 0:
        return

    print(f"Building evaluation image '{EVAL_IMAGE}'...")
    result = subprocess.run(
        ["docker", "build", "-t", EVAL_IMAGE, "-f", str(DOCKERFILE_PATH), str(DOCKERFILE_PATH.parent)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Failed to build eval image:\n{result.stderr}")
        sys.exit(1)
    print("Eval image built successfully.")


def ensure_agent_image():
    """Build the agent execution Docker image if it doesn't exist."""
    result = subprocess.run(
        ["docker", "image", "inspect", AGENT_IMAGE],
        capture_output=True,
    )
    if result.returncode == 0:
        return

    print(f"Building agent image '{AGENT_IMAGE}'...")
    result = subprocess.run(
        ["docker", "build", "-t", AGENT_IMAGE, "-f", str(AGENT_DOCKERFILE_PATH), str(AGENT_DOCKERFILE_PATH.parent)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Failed to build agent image:\n{result.stderr}")
        sys.exit(1)
    print("Agent image built successfully.")


def save_results_atomic(results: list[dict], results_path: Path):
    """Atomically write results to disk (write tmp, then rename)."""
    results_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = results_path.with_suffix(".tmp")
    # Strip _db_id before saving to JSON
    clean = []
    for r in results:
        entry = {k: v for k, v in r.items() if k != "_db_id"}
        clean.append(entry)
    with open(tmp_path, "w") as f:
        json.dump(clean, f, indent=2)
    os.replace(tmp_path, results_path)


def run_single_agent_task(agent_name: str, task: dict, db: BenchmarkDB | None = None, run_id: int | None = None) -> dict:
    """Run a single agent on a single task inside a Docker container. Returns a result dict."""
    agent = get_agent(agent_name)
    tier = task["tier"]
    # Capture git commit for traceability (short hash for display)
    _git_commit = get_git_info().get("commit", "")[:12]

    STATE.set_running(agent_name, task)
    STATE.log(f"  START {agent_name} / {task['id']} ({tier})")

    try:
        run_result = run_agent(agent, task, event_callback=STATE.push_event)
        eval_results = evaluate_task(run_result.workspace, task["evaluation"])

        all_evals_passed = all(e.passed for e in eval_results) if eval_results else False
        all_passed = all_evals_passed  # timeout no longer overrides passing evals
        score = sum(1 for e in eval_results if e.passed) / len(eval_results) if eval_results else 0.0

        if run_result.timed_out and not all_evals_passed:
            status = "TIMEOUT"
        elif all_passed:
            status = "PASS"
        else:
            status = "FAIL"
        STATE.log(f"  {status} {agent_name} / {task['id']} ({run_result.elapsed_seconds}s)")

        result = {
            "agent": agent_name,
            "model": agent.model,
            "agent_version": run_result.agent_version,
            "task_id": task["id"],
            "task_name": task["name"],
            "tier": tier,
            "passed": all_passed,
            "score": round(score, 3),
            "elapsed_seconds": run_result.elapsed_seconds,
            "timed_out": run_result.timed_out,
            "evaluations": [
                {"type": e.check_type, "passed": e.passed, "detail": e.detail}
                for e in eval_results
            ],
            "workspace_files": run_result.workspace_files,
            "file_contents": run_result.file_contents,
            "stdout": run_result.stdout,
            "stderr": run_result.stderr,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "task_hash": compute_task_hash(task),
            "agent_hash": compute_agent_hash(agent_name),
            "git_commit": _git_commit,
        }

        # Archive workspace (persists implementations on disk)
        archive_path = archive_workspace(
            run_result.workspace, agent_name, agent.model,
            task["id"], all_passed,
        )
        if archive_path:
            result["workspace_archive"] = archive_path

        # Save to DB
        if db and run_id:
            try:
                result_id = db.save_result(run_id, result)
                result["_db_id"] = result_id
            except Exception as e:
                STATE.log(f"  DB save error: {e}")

        return result
    except Exception as e:
        STATE.log(f"  ERROR {agent_name} / {task['id']}: {e}")
        result = {
            "agent": agent_name,
            "model": agent.model,
            "agent_version": "unknown",
            "task_id": task["id"],
            "task_name": task["name"],
            "tier": tier,
            "passed": False,
            "score": 0.0,
            "elapsed_seconds": 0,
            "timed_out": False,
            "evaluations": [],
            "workspace_files": [],
            "file_contents": {},
            "stdout": "",
            "stderr": str(e),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "task_hash": compute_task_hash(task),
            "agent_hash": compute_agent_hash(agent_name),
            "git_commit": _git_commit,
        }

        if db and run_id:
            try:
                result_id = db.save_result(run_id, result)
                result["_db_id"] = result_id
            except Exception:
                pass

        return result
    finally:
        STATE.clear_running(agent_name)


def _run_inline_jury(
    result: dict,
    all_tasks: list[dict],
    jury_backend: str,
    db: BenchmarkDB | None,
    results_lock: threading.Lock,
    results: list[dict],
    results_path: Path,
):
    """Run jury evaluation on a single result inline (called from background thread)."""
    from jury import jury_review_single

    task_prompts = {t["id"]: t["prompt"] for t in all_tasks}
    task_ground_truths = {t["id"]: t.get("ground_truth", "") for t in all_tasks}

    task_id = result["task_id"]
    agent = result["agent"]
    prompt = task_prompts.get(task_id, "(prompt not found)")
    ground_truth = task_ground_truths.get(task_id, "")

    try:
        verdicts = jury_review_single(result, prompt, jury_backend, ground_truth)
    except Exception as e:
        STATE.log(f"  JURY ERROR {agent} / {task_id}: {e}")
        return

    if verdicts:
        primary = verdicts[0]
        result["jury_verdict"] = primary
        vstr = primary["verdict"].upper()
        rating = primary["rating"]
        model = primary.get("jury_model", "?")
        STATE.log(f"  JURY {agent} / {task_id} — {vstr} (rating: {rating}/100, model: {model})")

        # Persist to DB
        if db and result.get("_db_id"):
            for v in verdicts:
                try:
                    db.save_jury_verdict(result["_db_id"], v)
                except Exception as e:
                    STATE.log(f"    Jury DB save error: {e}")

        # Re-save results with jury verdict included
        with results_lock:
            save_results_atomic(results, results_path)
    else:
        STATE.log(f"  JURY ERROR {agent} / {task_id} — no verdict from any backend")


def run_benchmark(
    agent_names: list[str],
    tasks: list[dict],
    results_path: Path,
    resume_results: list[dict] | None = None,
    db: BenchmarkDB | None = None,
    run_id: int | None = None,
    skip_passed: bool = False,
    jury_backend: str | None = None,
    all_tasks: list[dict] | None = None,
) -> list[dict]:
    """Run all agent-task combinations with parallel execution per task.

    For each task, all agents run concurrently (separate workspaces).
    Results are saved incrementally after each completion.

    If jury_backend is provided, jury evaluation runs inline (in background
    threads) immediately after each task completes, rather than as a batch
    at the end.
    """
    results = list(resume_results) if resume_results else []
    completed_keys = {(r["agent"], r["task_id"]) for r in results}
    results_lock = threading.Lock()

    STATE.results = list(results)
    STATE.total_pairs = len(agent_names) * len(tasks)
    STATE.skipped_count = 0
    STATE.start_time = time.monotonic()
    STATE.agent_names = agent_names
    STATE.tasks = tasks

    interrupted = False

    # Background jury thread pool (max 2 concurrent jury evals to avoid rate limits)
    jury_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="jury") if jury_backend else None
    jury_futures = []

    def handle_sigint(signum, frame):
        nonlocal interrupted
        if interrupted:
            sys.exit(1)
        interrupted = True
        STATE.log(f"\nInterrupted! Saving {len(results)} results to {results_path}...")
        with results_lock:
            save_results_atomic(results, results_path)
        STATE.log(f"Partial results saved. Resume with: python benchmark.py --resume {results_path}")
        sys.exit(0)

    old_handler = signal.signal(signal.SIGINT, handle_sigint)

    try:
        for task in tasks:
            # Collect agents that need to run this task
            agents_to_run = []
            for agent_name in agent_names:
                if (agent_name, task["id"]) in completed_keys:
                    STATE.log(f"  SKIP {agent_name} / {task['id']} — already completed")
                    STATE.add_skip()
                    continue

                # Check skip-cache: reuse cached pass if agent+task hash match
                if skip_passed and db:
                    task_hash = compute_task_hash(task)
                    agent_hash = compute_agent_hash(agent_name)
                    cached = db.get_latest_passed(agent_name, task["id"], agent_hash, task_hash)
                    if cached:
                        STATE.log(f"  CACHE {agent_name} / {task['id']} — reusing cached pass")
                        with results_lock:
                            results.append(cached)
                            STATE.add_result(cached)
                            # Also save to this run in DB
                            if run_id:
                                try:
                                    cached["task_hash"] = task_hash
                                    cached["agent_hash"] = agent_hash
                                    db.save_result(run_id, cached)
                                except Exception:
                                    pass
                            save_results_atomic(results, results_path)
                        continue

                agents_to_run.append(agent_name)

            if not agents_to_run:
                continue

            # Run all agents for this task in parallel
            with ThreadPoolExecutor(max_workers=len(agents_to_run)) as executor:
                futures = {
                    executor.submit(run_single_agent_task, agent_name, task, db, run_id): agent_name
                    for agent_name in agents_to_run
                }

                for future in as_completed(futures):
                    result = future.result()
                    with results_lock:
                        results.append(result)
                        STATE.add_result(result)
                        save_results_atomic(results, results_path)

                    # Fire off inline jury evaluation in background
                    if jury_executor and all_tasks:
                        jf = jury_executor.submit(
                            _run_inline_jury,
                            result, all_tasks, jury_backend, db,
                            results_lock, results, results_path,
                        )
                        jury_futures.append(jf)
    finally:
        signal.signal(signal.SIGINT, old_handler)

    # Wait for any remaining jury evaluations to complete
    if jury_futures:
        pending = [f for f in jury_futures if not f.done()]
        if pending:
            STATE.log(f"\n  Waiting for {len(pending)} jury evaluation(s) to finish...")
        for f in jury_futures:
            try:
                f.result(timeout=1200)
            except Exception as e:
                STATE.log(f"  Jury future error: {e}")
        jury_executor.shutdown(wait=False)

    STATE.finished = True
    STATE.clear_live_state()
    return results


def print_summary(results: list[dict]):
    """Print a quick summary to stdout."""
    by_agent = defaultdict(lambda: {"passed": 0, "total": 0})
    for r in results:
        by_agent[r["agent"]]["total"] += 1
        if r["passed"]:
            by_agent[r["agent"]]["passed"] += 1

    print("\n" + "=" * 50)
    print("SUMMARY")
    print("=" * 50)
    for agent, stats in by_agent.items():
        pct = round(stats["passed"] / stats["total"] * 100) if stats["total"] else 0
        print(f"  {agent:12s}  {stats['passed']}/{stats['total']} passed ({pct}%)")

    # Jury summary if available
    jury_results = [r for r in results if r.get("jury_verdict")]
    if jury_results:
        print()
        print("JURY VERDICTS")
        print("-" * 50)
        by_agent_jury = defaultdict(list)
        for r in jury_results:
            by_agent_jury[r["agent"]].append(r["jury_verdict"])
        for agent, verdicts in by_agent_jury.items():
            passes = sum(1 for v in verdicts if v.get("verdict") == "pass")
            partials = sum(1 for v in verdicts if v.get("verdict") == "partial")
            fails = sum(1 for v in verdicts if v.get("verdict") == "fail")
            avg_rating = sum(v.get("rating", 0) for v in verdicts) / len(verdicts)
            print(f"  {agent:12s}  P:{passes} / Pa:{partials} / F:{fails}  avg rating: {avg_rating:.1f}/100")

    print("=" * 50)


def import_json_files(db: BenchmarkDB, patterns: list[str]):
    """Import JSON result files into the database."""
    files = []
    for pattern in patterns:
        files.extend(globmod.glob(pattern))

    if not files:
        print("No matching files found.")
        return

    total_imported = 0
    for f in sorted(set(files)):
        path = Path(f)
        if not path.exists() or not path.suffix == ".json":
            print(f"  Skipping {f} (not a JSON file)")
            continue
        try:
            count = db.import_json(path)
            print(f"  Imported {count} results from {path.name}")
            total_imported += count
        except Exception as e:
            print(f"  Error importing {f}: {e}")

    print(f"\nTotal: {total_imported} results imported into {db.db_path}")
    print(f"DB now has {db.result_count()} results across {db.run_count()} runs")


def main():
    parser = argparse.ArgumentParser(description="AI Agent Benchmark Framework")
    parser.add_argument("--agents", nargs="+", help="Agent names to benchmark (default: all)")
    parser.add_argument("--tier", choices=["easy", "medium", "hard", "extreme", "nightmare", "impossible"], help="Run only tasks in this tier")
    parser.add_argument("--task", nargs="+", help="Run specific task(s) by ID (one or more)")
    parser.add_argument("--report", help="Regenerate HTML report from a saved results JSON file")
    parser.add_argument("--no-report", action="store_true", help="Skip HTML report generation")
    # Jury is always enabled — no opt-out flag
    parser.add_argument("--jury-only", metavar="RESULTS_JSON", help="Run jury on existing results without re-running benchmarks")
    from config import get_jury_backend
    parser.add_argument("--jury-backend", default=get_jury_backend(),
                        choices=["codex-xhigh", "codex-5.3", "claude-opus", "claude-cli", "anthropic-api", "all"],
                        help=f"Jury backend (default: {get_jury_backend()}, set via dashboard or settings.json)")
    parser.add_argument("--resume", metavar="RESULTS_JSON", help="Resume an interrupted benchmark run")
    parser.add_argument("--dashboard", type=int, metavar="PORT", nargs="?", const=8002, default=None,
                        help="Start embedded live dashboard on PORT (default: off, use standalone on :8001)")
    parser.add_argument("--no-dashboard", action="store_true", help="Disable live dashboard (default)")
    parser.add_argument("--import", dest="import_files", nargs="+", metavar="JSON_FILE",
                        help="Import existing JSON results into the database")
    parser.add_argument("--skip-passed", action="store_true", default=True,
                        help="Skip tasks with cached pass for same agent+task hash (default)")
    parser.add_argument("--no-skip", action="store_true",
                        help="Force re-run everything, ignoring cache")
    parser.add_argument("--db", default=None, help="Path to SQLite database (default: benchmark.db)")
    parser.add_argument("--build-agent-image", action="store_true",
                        help="Build the bench-agent Docker image and exit")
    args = parser.parse_args()

    # Handle --build-agent-image (build and exit)
    if args.build_agent_image:
        ensure_agent_image()
        return

    # Initialize DB
    db = BenchmarkDB(args.db) if args.db else BenchmarkDB()

    # Handle --import mode
    if args.import_files:
        print(f"Importing JSON results into {db.db_path}...")
        import_json_files(db, args.import_files)
        db.close()
        return

    # Load tasks
    all_tasks = load_tasks()

    # Report-only mode
    if args.report:
        print(f"Loading results from {args.report}...")
        results = json.loads(Path(args.report).read_text())
        report_path = generate_report(results, all_tasks)
        print(f"Report generated: {report_path}")
        db.close()
        return

    # Jury-only mode
    if args.jury_only:
        from jury import jury_review_all

        results_path = Path(args.jury_only)
        print(f"Loading results from {results_path}...")
        results = json.loads(results_path.read_text())

        # Look up DB IDs for each result so jury verdicts can be saved to DB
        for r in results:
            if not r.get("_db_id"):
                db_results = db.get_all_results(
                    agent=r.get("agent"), task_id=r.get("task_id")
                )
                if db_results:
                    r["_db_id"] = db_results[0].get("_db_id")

        print(f"Running jury evaluation on {len(results)} results ({args.jury_backend})...\n")
        results = jury_review_all(results, all_tasks, jury_backend=args.jury_backend, db=db)
        save_results_atomic(results, results_path)
        print(f"\nJury verdicts saved to {results_path}")
        print_summary(results)
        if not args.no_report:
            report_path = generate_report(results, all_tasks)
            print(f"Report: {report_path}")
        db.close()
        return

    # Normal benchmark mode
    tasks = filter_tasks(all_tasks, args.tier, args.task)
    agent_names = args.agents or list(AGENTS.keys())

    # Validate agents
    for name in agent_names:
        get_agent(name)  # raises if unknown

    # Build Docker images (always needed — all execution is container-only)
    ensure_eval_image()
    ensure_agent_image()

    # Start live dashboard (always on by default, disable with --no-dashboard)
    if args.dashboard and not args.no_dashboard:
        port = args.dashboard
        start_dashboard(port)
        print(f"Dashboard running at http://localhost:{port}")

    # Prepare results path
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    results_path = RESULTS_DIR / f"run-{ts}.json"

    # Handle resume
    resume_results = None
    if args.resume:
        resume_path = Path(args.resume)
        if resume_path.exists():
            resume_results = json.loads(resume_path.read_text())
            results_path = resume_path  # Overwrite the same file
            completed = len(resume_results)
            print(f"Resuming from {resume_path} ({completed} results already complete)")
        else:
            print(f"Warning: {resume_path} not found, starting fresh")

    # Determine skip behavior
    skip_passed = args.skip_passed and not args.no_skip

    # Create DB run record
    git_info = get_git_info()
    task_filter_str = args.tier or (", ".join(args.task) if args.task else None)
    run_id = db.create_run(
        agents=agent_names,
        task_filter=task_filter_str,
        total_pairs=len(tasks) * len(agent_names),
        git_info=git_info,
    )

    print(f"\nAI Agent Benchmark (parallel execution)")
    print(f"  Tasks: {len(tasks)}")
    print(f"  Agents: {', '.join(agent_names)}")
    print(f"  Total runs: {len(tasks) * len(agent_names)}")
    print(f"  Results: {results_path}")
    print(f"  DB: {db.db_path} (run #{run_id})")
    print(f"  Skip cached: {skip_passed}")
    print(f"  Execution: container (Docker)")
    print(f"  Jury: inline ({args.jury_backend})")
    if args.dashboard and not args.no_dashboard:
        print(f"  Dashboard: http://localhost:{args.dashboard}")
    print()

    # Run benchmarks (with inline jury evaluation)
    start = time.monotonic()
    results = run_benchmark(
        agent_names, tasks, results_path, resume_results,
        db=db, run_id=run_id, skip_passed=skip_passed,
        jury_backend=args.jury_backend, all_tasks=all_tasks,
    )
    elapsed = time.monotonic() - start

    # Finish run in DB
    db.finish_run(run_id)

    if not results:
        print("No results generated.")
        db.close()
        return

    print(f"\nResults saved: {results_path}")

    # Catch-up jury for any results that didn't get judged inline
    unjudged = [r for r in results if not r.get("jury_verdict")]
    if unjudged:
        from jury import jury_review_all

        print(f"\nRunning catch-up jury on {len(unjudged)} unjudged results ({args.jury_backend})...\n")
        results = jury_review_all(results, all_tasks, jury_backend=args.jury_backend, db=db)
        save_results_atomic(results, results_path)
        print(f"Jury verdicts saved to {results_path}")
    else:
        print(f"All {len(results)} results already judged inline.")

    # Print summary
    print_summary(results)
    print(f"Total time: {elapsed:.1f}s")

    # Generate report
    if not args.no_report:
        report_path = generate_report(results, all_tasks)
        print(f"Report: {report_path}")

    db.close()


if __name__ == "__main__":
    main()
