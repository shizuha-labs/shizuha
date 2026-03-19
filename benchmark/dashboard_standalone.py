#!/usr/bin/env python3
"""Standalone benchmark dashboard — reads from SQLite DB and serves a self-contained HTML page.

Falls back to JSON files if DB is not available.
"""

import json
import re
import subprocess
import sys
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

RESULTS_DIR = Path(__file__).resolve().parent / "results"
DB_PATH = Path(__file__).resolve().parent / "benchmark.db"
LIVE_STATE_PATH = Path("/tmp/benchmark-live.json")

# Display-only canonical naming (DB rows are unchanged):
#   <agent>-<model>[-xhigh-thinking]
# This keeps benchmark history intact while fixing historical/legacy labels.
MODEL_NAME_ALIASES = {
    "gpt-5.4-xhigh": "gpt-5.4",
}


def _canonical_agent_name(agent: str | None, model: str | None) -> str | None:
    """Return dashboard display name without mutating persisted benchmark data.

    Rules requested:
      - openai families shown as <agent>-<model>
      - add '-xhigh-thinking' for gpt-5.4 xhigh thinking variants
    """
    if not agent:
        return agent
    model_norm = (model or "").strip()
    model_norm = MODEL_NAME_ALIASES.get(model_norm, model_norm)

    # Normalize shizuha/codex families to requested convention.
    if agent.startswith("shizuha"):
        family = "shizuha"
    elif agent.startswith("codex"):
        family = "codex"
    else:
        return agent

    if not model_norm:
        return family

    model_token = re.sub(r"[^a-zA-Z0-9._-]+", "-", model_norm).strip("-")
    thinking_suffix = ""
    if model_norm.startswith("gpt-5.4") and ("xhigh" in agent or "thinking" in agent):
        thinking_suffix = "-xhigh"

    return f"{family}-{model_token}{thinking_suffix}"


def _model_hint_from_agent_name(agent_name: str | None) -> str:
    """Best-effort model hint when only agent name is available (e.g. run metadata)."""
    name = (agent_name or "").lower()
    if "5.4" in name:
        return "gpt-5.4"
    if "claude" in name:
        return "claude-opus-4-6"
    if "qwen3.5" in name:
        return "qwen3.5:35b-a3b"
    if "qwen3" in name:
        return "qwen3-coder-next:q4_K_M"
    if name.startswith("shizuha") or name.startswith("codex"):
        return "gpt-5.3-codex"
    return ""


def _normalize_result_identity(result: dict) -> dict:
    """Normalize labels for display and aggregation (without touching DB)."""
    r = dict(result)
    raw_agent = r.get("agent")
    model = MODEL_NAME_ALIASES.get(r.get("model"), r.get("model"))
    r["model"] = model
    r["agent"] = _canonical_agent_name(raw_agent, model)
    r["_raw_agent"] = raw_agent
    return r


def load_live_state() -> dict:
    """Load live benchmark state from the shared JSON file.
    Returns empty dict with active=False if no benchmark is running."""
    try:
        if LIVE_STATE_PATH.exists():
            import time as _time
            data = json.loads(LIVE_STATE_PATH.read_text())
            # Consider stale if not updated in 30 seconds
            if _time.time() - data.get("ts", 0) < 30:
                # Normalize agent labels in live banner/running chips.
                agents = data.get("agents") or []
                if isinstance(agents, list):
                    data["agents"] = [
                        _canonical_agent_name(a, _model_hint_from_agent_name(a)) or a
                        for a in agents
                    ]

                running = data.get("running") or {}
                if isinstance(running, dict):
                    normalized_running = {}
                    for name, info in running.items():
                        new_name = _canonical_agent_name(name, _model_hint_from_agent_name(name)) or name
                        normalized_running[new_name] = info
                    data["running"] = normalized_running
                return data
    except Exception:
        pass
    return {"active": False}


def get_db():
    """Get a BenchmarkDB instance if available."""
    if not DB_PATH.exists():
        return None
    try:
        from db import BenchmarkDB
        return BenchmarkDB(DB_PATH)
    except Exception:
        return None


def find_latest_results():
    """Find the most recent results JSON file."""
    files = sorted(RESULTS_DIR.glob("run-*.json"), reverse=True)
    return files[0] if files else None


def load_results_from_json():
    """Load results from latest JSON file, stripping large fields."""
    f = find_latest_results()
    if not f:
        return []
    with open(f) as fh:
        raw = json.load(fh)
    slim = []
    for r in raw:
        normalized = _normalize_result_identity(r)
        entry = {k: v for k, v in normalized.items() if k not in ("file_contents", "stdout", "stderr", "_db_id")}
        slim.append(entry)
    return slim


def _filter_disabled_agents(results):
    """Remove results from disabled or empty agents so they don't show on the dashboard."""
    try:
        from config import DISABLED_AGENTS
    except ImportError:
        DISABLED_AGENTS = set()

    filtered = []
    for r in results:
        display_agent = r.get("agent")
        raw_agent = r.get("_raw_agent", display_agent)
        if not display_agent:
            continue
        if raw_agent in DISABLED_AGENTS:
            continue
        if "_raw_agent" in r:
            r = dict(r)
            r.pop("_raw_agent", None)
        filtered.append(r)
    return filtered


def load_results(run_id=None, agent=None, tier=None, jury_model=None):
    """Load results from DB if available, otherwise from JSON.

    When no run_id is specified, deduplicates by agent+task_id keeping
    the latest result for each pair.

    Args:
        jury_model: If set, only attach verdicts from this specific jury model.
    """
    db = get_db()
    if db:
        try:
            if run_id:
                results = db.get_run_results(int(run_id))
                results = [_normalize_result_identity(r) for r in results]
            else:
                results = db.get_all_results(agent=agent, tier=tier)
                results = [_normalize_result_identity(r) for r in results]
                # Deduplicate: keep latest (highest id) per canonical agent+task
                seen = {}
                for r in results:
                    key = (r.get("agent"), r.get("task_id"))
                    if key not in seen:
                        seen[key] = r
                results = list(seen.values())
            # Attach jury verdicts from DB
            db.attach_jury_verdicts(results, jury_model=jury_model)
            # Strip large fields
            slim = []
            for r in results:
                entry = {k: v for k, v in r.items()
                         if k not in ("file_contents", "stdout", "stderr", "_db_id")}
                slim.append(entry)
            db.close()
            return _filter_disabled_agents(slim)
        except Exception:
            db.close()
    return _filter_disabled_agents(load_results_from_json())


def load_runs():
    """Load all runs from DB."""
    db = get_db()
    if not db:
        return []
    try:
        runs = db.get_all_runs()
        # Normalize agent names in run metadata for selector labels.
        for run in runs:
            agents_raw = run.get("agents")
            if not agents_raw:
                continue
            try:
                agents = json.loads(agents_raw)
                normalized = []
                for a in agents:
                    normalized.append(_canonical_agent_name(a, _model_hint_from_agent_name(a)) or a)
                # Keep order but remove duplicates after normalization.
                deduped = list(dict.fromkeys(normalized))
                run["agents"] = json.dumps(deduped)
            except Exception:
                continue
        db.close()
        return runs
    except Exception:
        db.close()
        return []


def load_battles(tournament_id=None):
    """Load battle tournaments with standings and matches from DB."""
    db = get_db()
    if not db:
        return []
    try:
        if tournament_id:
            t = db.get_tournaments()
            tournaments = [tt for tt in t if tt["id"] == int(tournament_id)]
        else:
            tournaments = db.get_tournaments()
        for t in tournaments:
            # Normalize participant labels
            participants = t.get("participants") or []
            if isinstance(participants, list):
                for p in participants:
                    if isinstance(p, dict):
                        p_model = MODEL_NAME_ALIASES.get(p.get("model"), p.get("model"))
                        p["model"] = p_model
                        p["agent"] = _canonical_agent_name(p.get("agent"), p_model) or p.get("agent")

            standings = db.get_tournament_standings(t["id"])
            for s in standings:
                s_model = MODEL_NAME_ALIASES.get(s.get("model"), s.get("model"))
                s["model"] = s_model
                s["agent"] = _canonical_agent_name(s.get("agent"), s_model) or s.get("agent")
            t["standings"] = standings

            matches = db.get_tournament_matches(t["id"])
            for m in matches:
                wm = MODEL_NAME_ALIASES.get(m.get("white_model"), m.get("white_model"))
                bm = MODEL_NAME_ALIASES.get(m.get("black_model"), m.get("black_model"))
                m["white_model"] = wm
                m["black_model"] = bm
                m["white_agent"] = _canonical_agent_name(m.get("white_agent"), wm) or m.get("white_agent")
                m["black_agent"] = _canonical_agent_name(m.get("black_agent"), bm) or m.get("black_agent")
            t["matches"] = matches
        db.close()
        return tournaments
    except Exception:
        db.close()
        return []


def load_match(match_id):
    """Load a single match by ID with full details."""
    db = get_db()
    if not db:
        return None
    try:
        match = db.get_match(int(match_id))
        if match:
            wm = MODEL_NAME_ALIASES.get(match.get("white_model"), match.get("white_model"))
            bm = MODEL_NAME_ALIASES.get(match.get("black_model"), match.get("black_model"))
            match["white_model"] = wm
            match["black_model"] = bm
            match["white_agent"] = _canonical_agent_name(match.get("white_agent"), wm) or match.get("white_agent")
            match["black_agent"] = _canonical_agent_name(match.get("black_agent"), bm) or match.get("black_agent")
        db.close()
        return match
    except Exception:
        db.close()
        return None


def discover_live_games():
    """Discover running chess-server Docker containers and fetch their game state."""
    try:
        result = subprocess.run(
            ["docker", "ps", "--filter", "ancestor=chess-server:latest",
             "--format", "{{.ID}}\t{{.Names}}\t{{.Ports}}"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0 or not result.stdout.strip():
            return []
    except Exception:
        return []

    games = []
    for line in result.stdout.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        container_id, name, ports = parts[0], parts[1], parts[2]
        # Extract host port from port mapping like "0.0.0.0:32768->5000/tcp"
        host_port = None
        for mapping in ports.split(","):
            mapping = mapping.strip()
            if "->5000" in mapping:
                try:
                    host_port = int(mapping.split(":")[1].split("->")[0])
                except (IndexError, ValueError):
                    continue
                break
        if not host_port:
            continue
        # Fetch game state from the chess server
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{host_port}/api/state",
                headers={"Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=2) as resp:
                state = json.loads(resp.read().decode())
        except Exception:
            state = {"error": "unreachable"}
        # Normalize player labels in live game state for dashboard display.
        if isinstance(state, dict):
            wn = state.get("white_name")
            bn = state.get("black_name")
            if wn:
                state["white_name"] = _canonical_agent_name(wn, _model_hint_from_agent_name(wn)) or wn
            if bn:
                state["black_name"] = _canonical_agent_name(bn, _model_hint_from_agent_name(bn)) or bn

        games.append({
            "id": container_id[:12],
            "container_name": name,
            "port": host_port,
            "state": state,
        })
    return games


def proxy_screenshot(container_id_prefix):
    """Proxy a screenshot PNG from a running chess-server container."""
    try:
        result = subprocess.run(
            ["docker", "ps", "--filter", "ancestor=chess-server:latest",
             "--format", "{{.ID}}\t{{.Ports}}"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return None
    except Exception:
        return None

    for line in result.stdout.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        cid, ports = parts[0], parts[1]
        if not cid.startswith(container_id_prefix):
            continue
        # Found the container — extract port
        host_port = None
        for mapping in ports.split(","):
            mapping = mapping.strip()
            if "->5000" in mapping:
                try:
                    host_port = int(mapping.split(":")[1].split("->")[0])
                except (IndexError, ValueError):
                    continue
                break
        if not host_port:
            return None
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{host_port}/screenshot")
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.read()
        except Exception:
            return None
    return None


def build_html():
    """Build a self-contained HTML page with results embedded inline."""
    results = load_results()
    runs = load_runs()
    battles = load_battles()
    results_json = json.dumps(results, separators=(",", ":"))
    results_json = results_json.replace("</script>", "<\\/script>")
    runs_json = json.dumps(runs, separators=(",", ":"))
    runs_json = runs_json.replace("</script>", "<\\/script>")
    battles_json = json.dumps(battles, separators=(",", ":"))
    battles_json = battles_json.replace("</script>", "<\\/script>")
    html = DASHBOARD_TEMPLATE.replace("__RESULTS_JSON__", results_json)
    html = html.replace("__RUNS_JSON__", runs_json)
    html = html.replace("__BATTLES_JSON__", battles_json)
    return html


DASHBOARD_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Agent Benchmark</title>
<style>
  :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3;
          --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --red: #f85149;
          --orange: #d29922; --purple: #bc8cff; --cyan: #39d2c0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: var(--bg); color: var(--text); padding: 2rem; max-width: 1400px; margin: 0 auto; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .header { margin-bottom: 2rem; }
  .header h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  .header .subtitle { color: var(--muted); font-size: 0.9rem; }
  .run-selector { margin-bottom: 0; }
  .run-selector select { background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.5rem 0.75rem; font-size: 0.85rem; min-width: 300px; cursor: pointer; }
  .run-selector label { color: var(--muted); font-size: 0.85rem; margin-right: 0.5rem; }
  .run-info { color: var(--muted); font-size: 0.8rem; margin-top: 0.5rem;
              background: var(--surface); border: 1px solid var(--border);
              border-radius: 6px; padding: 0.75rem; display: inline-block; }
  .run-info b { color: var(--text); }
  .agents-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.25rem; margin-bottom: 2rem; }
  .agent-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; position: relative; overflow: hidden; }
  .agent-card .bar-top { position: absolute; top: 0; left: 0; right: 0; height: 3px; }
  .agent-name { font-size: 1.3rem; font-weight: 700; }
  .agent-model { color: var(--accent); font-size: 0.9rem; font-weight: 500; margin-top: 0.15rem; font-family: monospace; }
  .agent-version { color: var(--muted); font-size: 0.75rem; margin-top: 0.15rem; }
  .agent-type { font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; font-weight: 600; display: inline-block; }
  .type-local { background: rgba(57,210,192,0.15); color: var(--cyan); }
  .type-cloud { background: rgba(188,140,255,0.15); color: var(--purple); }
  .stats-row { display: flex; gap: 1.5rem; margin-top: 1rem; flex-wrap: wrap; }
  .stat-box .num { font-size: 1.8rem; font-weight: 700; }
  .stat-box .label { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; }
  .pass-bar { height: 8px; background: rgba(248,81,73,0.3); border-radius: 4px; margin-top: 0.75rem; overflow: hidden; }
  .pass-bar-fill { height: 100%; background: var(--green); border-radius: 4px; }
  .tier-pills { display: flex; gap: 0.4rem; margin-top: 0.75rem; flex-wrap: wrap; }
  .tier-pill { font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
  .badge-pass { background: rgba(63,185,80,0.2); color: var(--green); }
  .badge-fail { background: rgba(248,81,73,0.2); color: var(--red); }
  .badge-timeout { background: rgba(210,153,34,0.2); color: var(--orange); }
  .jury-rating-inline { font-size: 0.75rem; color: var(--orange); margin-left: 4px; font-weight: 600; }
  .jury-avg { font-size: 1.1rem; font-weight: 700; color: var(--orange); }
  .jury-verdict-badge { display: inline-block; font-size: 0.68rem; padding: 1px 6px; border-radius: 8px; margin-left: 4px; font-weight: 600; }
  .jury-verdict-pass { background: rgba(63,185,80,0.15); color: var(--green); }
  .jury-verdict-partial { background: rgba(210,153,34,0.15); color: var(--orange); }
  .jury-verdict-fail { background: rgba(248,81,73,0.15); color: var(--red); }
  .tier { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; display: inline-block; }
  .tier-easy { background: rgba(63,185,80,0.15); color: var(--green); }
  .tier-medium { background: rgba(210,153,34,0.15); color: var(--orange); }
  .tier-hard { background: rgba(248,81,73,0.15); color: var(--red); }
  .tier-extreme { background: rgba(188,140,255,0.15); color: var(--purple); }
  .tier-nightmare { background: rgba(248,81,73,0.3); color: #ff6b6b; }
  .tier-impossible { background: rgba(255,0,0,0.25); color: #ff4444; font-weight: 800; }
  .tier-swebench { background: rgba(88,166,255,0.2); color: var(--accent); font-weight: 700; }
  h2 { font-size: 1.15rem; color: var(--accent); margin: 2rem 0 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); text-align: left; }
  th { color: var(--muted); font-weight: 500; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover { background: rgba(88,166,255,0.05); }
  .result-time { color: var(--muted); font-size: 0.8rem; margin-left: 4px; }
  .result-score { color: var(--muted); font-size: 0.75rem; }
  .speed-winner { color: var(--green); font-weight: 600; }
  .detail-row { display: none; background: var(--bg); }
  .detail-row.open { display: table-row; }
  .detail-row td { padding: 1rem; }
  .detail-grid { display: grid; gap: 1.5rem; }
  .eval-item { padding: 0.25rem 0; font-size: 0.8rem; display: flex; gap: 0.5rem; align-items: flex-start; }
  .eval-icon { flex-shrink: 0; width: 16px; text-align: center; }
  .eval-pass { color: var(--green); }
  .eval-fail { color: var(--red); }
  .eval-detail { color: var(--muted); font-size: 0.72rem; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .eval-detail:hover { white-space: normal; word-break: break-all; }
  .file-tag { display: inline-block; background: var(--bg); border: 1px solid var(--border); padding: 1px 6px; border-radius: 4px; margin: 1px; font-family: monospace; font-size: 0.72rem; color: var(--muted); }
  .tier-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; }
  .tier-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
  .tier-agent { display: flex; justify-content: space-between; padding: 0.3rem 0; font-size: 0.85rem; }
  .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.75rem; text-align: center; }
  .jury-box { margin-top: 0.75rem; padding: 0.75rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
  .jury-header { font-size: 0.85rem; font-weight: 600; margin-bottom: 0.4rem; }
  .jury-scores { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.78rem; margin-bottom: 0.4rem; }
  .jury-score b { color: var(--muted); font-weight: 500; }
  .jury-reasoning { font-size: 0.8rem; color: var(--text); font-style: italic; margin-bottom: 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--border); }
  .jury-detail-section { margin-top: 0.4rem; }
  .jury-detail-label { font-size: 0.72rem; font-weight: 600; color: var(--accent); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 0.15rem; }
  .jury-detail-text { font-size: 0.78rem; color: var(--text); line-height: 1.45; padding-left: 0.5rem; border-left: 2px solid var(--border); margin-bottom: 0.3rem; }
  .tabs { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 2px solid var(--border); }
  .tab { background: none; border: none; color: var(--muted); font-size: 0.95rem; font-weight: 600;
         padding: 0.6rem 1.5rem; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.15s; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .battle-selector { margin-bottom: 1.5rem; }
  .battle-selector select { background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.5rem 0.75rem; font-size: 0.85rem; min-width: 300px; cursor: pointer; }
  .battle-selector label { color: var(--muted); font-size: 0.85rem; margin-right: 0.5rem; }
  .standings-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 2rem; }
  .standings-table th { background: var(--surface); }
  .rank-1 { color: #ffd700; font-weight: 700; }
  .rank-2 { color: #c0c0c0; font-weight: 600; }
  .rank-3 { color: #cd7f32; font-weight: 600; }
  .h2h-grid { overflow-x: auto; margin-bottom: 2rem; }
  .h2h-grid table { border-collapse: collapse; font-size: 0.8rem; }
  .h2h-grid th, .h2h-grid td { padding: 0.5rem 0.75rem; border: 1px solid var(--border); text-align: center; min-width: 100px; }
  .h2h-grid th { background: var(--surface); font-weight: 600; }
  .h2h-grid td.self { background: var(--surface); color: var(--muted); }
  .h2h-win { color: var(--green); font-weight: 600; }
  .h2h-loss { color: var(--red); }
  .h2h-draw { color: var(--orange); }
  .match-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem;
    margin-bottom: 0.5rem; font-size: 0.82rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
  .match-card:hover { border-color: var(--accent); }
  .match-result { font-weight: 700; font-size: 0.9rem; }
  .match-meta { color: var(--muted); font-size: 0.75rem; }
  .crash-badge { background: rgba(248,81,73,0.2); color: var(--red); padding: 1px 6px; border-radius: 8px; font-size: 0.7rem; font-weight: 600; }
  .no-battles { color: var(--muted); font-size: 0.9rem; padding: 2rem; text-align: center; }

  /* Match detail modal */
  .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7);
    z-index: 1000; display: flex; justify-content: center; align-items: flex-start; padding: 2rem; overflow-y: auto; }
  .modal-content { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem;
    max-width: 900px; width: 100%; max-height: 90vh; overflow-y: auto; position: relative; }
  .modal-close { position: absolute; top: 0.75rem; right: 1rem; background: none; border: none; color: var(--muted);
    font-size: 1.5rem; cursor: pointer; }
  .modal-close:hover { color: var(--text); }
  .move-timeline { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin: 1rem 0; }
  .move-timeline th { background: var(--surface); padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid var(--border); font-weight: 600; }
  .move-timeline td { padding: 0.4rem 0.6rem; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .move-timeline tr:hover { background: var(--surface); }
  .timing-bar { height: 14px; border-radius: 3px; display: inline-block; min-width: 2px; }
  .timing-bar.white { background: rgba(255,255,255,0.6); }
  .timing-bar.black { background: var(--accent); }
  .timing-bar.slow { background: var(--red); }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1rem 0; }
  .summary-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem; }
  .summary-card .label { color: var(--muted); font-size: 0.75rem; margin-bottom: 0.25rem; }
  .summary-card .value { font-size: 1.1rem; font-weight: 700; }
  .telemetry-section { margin-top: 1.5rem; }
  .telemetry-section h4 { color: var(--accent); margin-bottom: 0.5rem; }
  .live-section { margin-bottom: 2rem; }
  .live-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
  .live-header h2 { margin: 0; border: none; padding: 0; }
  .live-dot { width: 10px; height: 10px; background: var(--red); border-radius: 50%; animation: pulse-dot 1.5s infinite; }
  @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .live-games-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 1.25rem; }
  .live-game-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .live-game-card .board-area { text-align: center; padding: 0.75rem; background: #1a1a2e; user-select: none; cursor: default; }
  .live-game-card .board-area img { max-width: 100%; height: auto; border-radius: 4px; image-rendering: auto; user-select: none; -webkit-user-drag: none; pointer-events: none; }
  .live-game-info { padding: 0.75rem 1rem; }
  .live-players { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .live-player { display: flex; align-items: center; gap: 0.4rem; }
  .live-player-name { font-weight: 600; font-size: 0.9rem; }
  .live-player-color { width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--border); }
  .live-clock { font-family: monospace; font-size: 0.95rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .live-clock-active { background: rgba(63,185,80,0.2); color: var(--green); }
  .live-clock-inactive { color: var(--muted); }
  .live-clock-low { background: rgba(248,81,73,0.2); color: var(--red); }
  .live-status { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.5rem; }
  .live-status-turn { color: var(--accent); font-weight: 600; }
  .live-moves { font-size: 0.75rem; color: var(--muted); font-family: monospace; max-height: 80px; overflow-y: auto; line-height: 1.6; }
  .live-move-num { color: var(--accent); }
  .live-game-over { background: rgba(248,81,73,0.1); border-color: var(--red); }
  .live-result-banner { text-align: center; padding: 0.4rem; font-weight: 700; font-size: 0.9rem; }
  .live-no-games { color: var(--muted); font-size: 0.85rem; padding: 1rem; text-align: center;
    background: var(--surface); border: 1px dashed var(--border); border-radius: 8px; }
  .live-run-banner { background: linear-gradient(135deg, rgba(88,166,255,0.12), rgba(63,185,80,0.08));
    border: 1px solid var(--accent); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.25rem;
    animation: livePulse 2s ease-in-out infinite; }
  @keyframes livePulse { 0%,100% { border-color: var(--accent); } 50% { border-color: var(--green); } }
  .live-run-title { font-size: 1rem; font-weight: 700; color: var(--green); margin-bottom: 0.5rem; }
  .live-run-title .dot { display: inline-block; width: 8px; height: 8px; background: var(--green);
    border-radius: 50%; margin-right: 0.5rem; animation: blink 1s infinite; }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .live-run-progress { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
  .live-run-stat { font-size: 0.85rem; color: var(--muted); }
  .live-run-stat b { color: var(--text); }
  .live-agents-row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .live-agent-chip { background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 0.4rem 0.75rem; font-size: 0.8rem; }
  .live-agent-chip .name { font-weight: 600; color: var(--accent); }
  .live-agent-chip .task { color: var(--muted); margin-left: 0.4rem; }
  .live-agent-chip .activity { font-size: 0.7rem; padding: 1px 6px; border-radius: 4px;
    margin-left: 0.4rem; font-weight: 600; }
  .activity-thinking { background: rgba(88,166,255,0.2); color: var(--accent); }
  .activity-running_tool { background: rgba(210,153,34,0.2); color: var(--orange); }
  .activity-writing { background: rgba(63,185,80,0.2); color: var(--green); }
  .activity-starting { background: rgba(139,148,158,0.2); color: var(--muted); }
  .live-log { font-family: monospace; font-size: 0.75rem; color: var(--muted); max-height: 120px;
    overflow-y: auto; margin-top: 0.5rem; background: var(--bg); border-radius: 4px; padding: 0.5rem; }

  /* Agent filter chips */
  .agent-filter { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-bottom: 1.25rem;
    padding: 0.75rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
  .agent-filter-label { color: var(--muted); font-size: 0.78rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.03em; margin-right: 0.25rem; }
  .agent-chip { font-size: 0.8rem; padding: 4px 12px; border-radius: 16px; cursor: pointer; font-weight: 500;
    border: 1px solid var(--border); background: var(--bg); color: var(--muted); transition: all 0.15s;
    user-select: none; }
  .agent-chip:hover { border-color: var(--accent); color: var(--text); }
  .agent-chip.active { background: rgba(88,166,255,0.15); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .agent-chip-reset { font-size: 0.75rem; padding: 3px 10px; border-radius: 12px; cursor: pointer;
    border: 1px dashed var(--border); background: none; color: var(--muted); margin-left: 0.5rem; transition: all 0.15s; }
  .agent-chip-reset:hover { border-color: var(--accent); color: var(--accent); }

  /* Jury model selector */
  .jury-selector { display: inline-flex; align-items: center; gap: 0.5rem; margin-left: 1.5rem; }
  .jury-selector label { color: var(--muted); font-size: 0.85rem; }
  .jury-selector select { background: var(--surface); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.4rem 0.6rem; font-size: 0.82rem; cursor: pointer; }
  .jury-eval-btn { background: rgba(210,153,34,0.15); color: var(--orange); border: 1px solid var(--orange);
    border-radius: 6px; padding: 0.4rem 0.75rem; font-size: 0.8rem; cursor: pointer; font-weight: 600; transition: all 0.15s; }
  .jury-eval-btn:hover { background: rgba(210,153,34,0.3); }
  .jury-eval-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .jury-status { font-size: 0.8rem; color: var(--muted); margin-left: 0.5rem; }
  .jury-status.running { color: var(--orange); }
  .jury-status.done { color: var(--green); }
  .jury-status.error { color: var(--red); }
</style>
</head>
<body>
<div class="header">
  <h1>AI Agent Benchmark</h1>
  <div class="subtitle">Automated coding task evaluation across difficulty tiers</div>
</div>
<div class="tabs">
  <button class="tab active" onclick="switchTab('benchmark')">Benchmark</button>
  <button class="tab" onclick="switchTab('battle')">Battle</button>
</div>
<div id="benchmark-tab" class="tab-content active">
  <div id="live-banner"></div>
  <div style="display:flex;align-items:flex-start;flex-wrap:wrap;gap:0.5rem;margin-bottom:1.5rem">
    <div class="run-selector" id="run-selector"></div>
    <div id="jury-selector-area"></div>
  </div>
  <div id="app"></div>
</div>
<div id="battle-tab" class="tab-content">
  <div class="battle-selector" id="battle-selector"></div>
  <div id="battle-app"></div>
</div>
<div class="footer">Shizuha Trading LLP | Benchmark Framework v2</div>

<script>
var RESULTS = __RESULTS_JSON__;
var RUNS = __RUNS_JSON__;
var BATTLES = __BATTLES_JSON__;
var currentRunId = null;
var currentBattleIdx = 0;
var currentJuryModel = null;
var juryJobId = null;
var juryPollInterval = null;

// ── Agent Visibility Filter ──
var DEFAULT_HIDDEN_AGENTS = ['shizuha-qwen3-coder-next', 'shizuha-qwen3.5'];
var agentVisibility = {};

function loadAgentVisibility() {
  try {
    var saved = localStorage.getItem('benchmarkAgentVisibility');
    if (saved) { agentVisibility = JSON.parse(saved); return; }
  } catch(e) {}
  agentVisibility = {};
  DEFAULT_HIDDEN_AGENTS.forEach(function(a) { agentVisibility[a] = false; });
}

function saveAgentVisibility() {
  try { localStorage.setItem('benchmarkAgentVisibility', JSON.stringify(agentVisibility)); } catch(e) {}
}

function isAgentVisible(name) {
  if (agentVisibility.hasOwnProperty(name)) return agentVisibility[name];
  return true;
}

function toggleAgent(name) {
  agentVisibility[name] = !isAgentVisible(name);
  saveAgentVisibility();
  render();
}

function showAllAgents() {
  Object.keys(agentVisibility).forEach(function(k) { agentVisibility[k] = true; });
  saveAgentVisibility();
  render();
}

loadAgentVisibility();

function fmt(s) {
  if (s >= 3600) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';
  if (s >= 60) return Math.floor(s/60)+'m '+Math.round(s%60)+'s';
  return s.toFixed(1)+'s';
}
function tb(t) { return '<span class="tier tier-'+t+'">'+t+'</span>'; }
function escape(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderRunSelector() {
  if (!RUNS.length) return;
  var sel = '<label>Run:</label><select id="run-select" onchange="switchRun(this.value)">';
  sel += '<option value="">All Results (latest)</option>';
  RUNS.forEach(function(r) {
    var d = r.started_at ? new Date(r.started_at).toLocaleString() : 'unknown';
    var agents = r.agents ? JSON.parse(r.agents).join(', ') : '?';
    var filter = r.task_filter ? ' [' + r.task_filter + ']' : '';
    sel += '<option value="'+r.id+'">Run #'+r.id+' — '+d+' — '+agents+filter+' ('+r.total_pairs+' pairs)</option>';
  });
  sel += '</select>';
  document.getElementById('run-selector').innerHTML = sel;
}

function switchRun(runId) {
  currentRunId = runId;
  var url = runId ? '/api/results?run_id='+runId : '/api/results';
  if (currentJuryModel) url += (url.indexOf('?')>=0?'&':'?') + 'jury_model='+encodeURIComponent(currentJuryModel);
  fetch(url).then(r => r.json()).then(function(data) {
    RESULTS = data;
    render();
  });
}

function switchJuryModel(model) {
  currentJuryModel = model || null;
  var url = currentRunId ? '/api/results?run_id='+currentRunId : '/api/results';
  if (currentJuryModel) url += (url.indexOf('?')>=0?'&':'?') + 'jury_model='+encodeURIComponent(currentJuryModel);
  fetch(url).then(function(r){return r.json();}).then(function(data) {
    RESULTS = data;
    render();
  });
}

function triggerJuryEval() {
  var sel = document.getElementById('jury-backend-select');
  if (!sel) return;
  var backend = sel.value;
  if (!backend) return;
  var btn = document.getElementById('jury-eval-btn');
  var status = document.getElementById('jury-eval-status');
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Starting...'; status.className = 'jury-status running'; }

  fetch('/api/jury/evaluate', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({backend: backend, run_id: currentRunId || null})
  }).then(function(r){return r.json();}).then(function(data) {
    if (data.error) {
      if (status) { status.textContent = data.error; status.className = 'jury-status error'; }
      if (btn) btn.disabled = false;
      return;
    }
    juryJobId = data.job_id;
    if (status) { status.textContent = 'Evaluating...'; status.className = 'jury-status running'; }
    juryPollInterval = setInterval(pollJuryStatus, 3000);
  }).catch(function(e) {
    if (status) { status.textContent = 'Error: '+e; status.className = 'jury-status error'; }
    if (btn) btn.disabled = false;
  });
}

function pollJuryStatus() {
  if (!juryJobId) return;
  fetch('/api/jury/status?job_id='+juryJobId).then(function(r){return r.json();}).then(function(data) {
    var status = document.getElementById('jury-eval-status');
    var btn = document.getElementById('jury-eval-btn');
    if (data.status === 'running') {
      if (status) { status.textContent = data.completed+'/'+data.total+' evaluated...'; status.className = 'jury-status running'; }
    } else if (data.status === 'done') {
      if (status) { status.textContent = data.completed+'/'+data.total+' done!'; status.className = 'jury-status done'; }
      if (btn) btn.disabled = false;
      clearInterval(juryPollInterval);
      juryPollInterval = null;
      juryJobId = null;
      // Refresh results with updated verdicts
      switchJuryModel(currentJuryModel);
      // Refresh jury model list
      loadJuryModels();
    } else if (data.status === 'error') {
      if (status) { status.textContent = 'Error: '+(data.error||'unknown'); status.className = 'jury-status error'; }
      if (btn) btn.disabled = false;
      clearInterval(juryPollInterval);
      juryPollInterval = null;
      juryJobId = null;
    }
  }).catch(function(){});
}

var juryModels = [];
var defaultJuryBackend = 'codex-xhigh';
var JURY_BACKENDS = ['codex-xhigh','codex-5.3','claude-opus','claude-cli','anthropic-api'];
var executionEnvironment = 'container';
var EXECUTION_ENVIRONMENTS = ['container', 'baremetal'];

function loadJuryModels() {
  fetch('/api/jury-models').then(function(r){return r.json();}).then(function(data) {
    juryModels = data || [];
    renderJurySelector();
  }).catch(function(){});
}

function loadSettings() {
  fetch('/api/settings').then(function(r){return r.json();}).then(function(data) {
    if (data.jury_backend) defaultJuryBackend = data.jury_backend;
    if (data.execution_environment) executionEnvironment = data.execution_environment;
    renderJurySelector();
  }).catch(function(){});
}

function setDefaultJuryBackend(backend) {
  fetch('/api/settings', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({jury_backend: backend})
  }).then(function(r){return r.json();}).then(function(data) {
    if (data.ok) {
      defaultJuryBackend = backend;
      renderJurySelector();
    }
  }).catch(function(){});
}

function setExecutionEnvironment(env) {
  fetch('/api/settings', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({execution_environment: env})
  }).then(function(r){return r.json();}).then(function(data) {
    if (data.ok) {
      executionEnvironment = env;
      renderJurySelector();
    }
  }).catch(function(){});
}

function renderJurySelector() {
  var container = document.getElementById('jury-selector-area');
  if (!container) return;
  var h = '<div class="jury-selector">';
  h += '<label>Jury view:</label>';
  h += '<select id="jury-model-select" onchange="switchJuryModel(this.value)">';
  h += '<option value=""'+(currentJuryModel?'':' selected')+'>Best (all models)</option>';
  juryModels.forEach(function(m) {
    h += '<option value="'+escape(m)+'"'+(currentJuryModel===m?' selected':'')+'>'+escape(m)+'</option>';
  });
  h += '</select>';
  h += '</div>';
  h += '<div class="jury-selector">';
  h += '<label>Default backend:</label>';
  h += '<select id="jury-backend-select" onchange="setDefaultJuryBackend(this.value)">';
  JURY_BACKENDS.forEach(function(b) {
    h += '<option value="'+b+'"'+(defaultJuryBackend===b?' selected':'')+'>'+b+'</option>';
  });
  h += '</select>';
  h += '<button id="jury-eval-btn" class="jury-eval-btn" onclick="triggerJuryEval()">Re-evaluate</button>';
  h += '<span id="jury-eval-status" class="jury-status"></span>';
  h += '</div>';
  h += '<div class="jury-selector">';
  h += '<label>Agent environment:</label>';
  h += '<select id="exec-env-select" onchange="setExecutionEnvironment(this.value)">';
  EXECUTION_ENVIRONMENTS.forEach(function(e) {
    h += '<option value="'+e+'"'+(executionEnvironment===e?' selected':'')+'>'+e+'</option>';
  });
  h += '</select>';
  h += '</div>';
  container.innerHTML = h;
}

function render() {
  var results = RESULTS;
  if (!results.length) { document.getElementById('app').innerHTML = '<p style="color:var(--muted)">No results found.</p>'; return; }

  var agentMap = {}, taskMap = {}, tierTasks = {};
  var tierOrder = ['easy','medium','hard','extreme','nightmare','impossible','swebench'];
  var colors = ['#58a6ff','#bc8cff','#39d2c0','#d29922'];

  // First pass: discover all agent names for the filter chip bar
  results.forEach(function(r) {
    if (!agentMap[r.agent]) agentMap[r.agent] = true;
  });
  var allAgents = Object.keys(agentMap).sort();
  agentMap = {};

  // Render agent filter chips
  var filterHtml = '<div class="agent-filter"><span class="agent-filter-label">Agents:</span>';
  allAgents.forEach(function(name) {
    var vis = isAgentVisible(name);
    filterHtml += '<span class="agent-chip'+(vis?' active':'')+'" onclick="toggleAgent(\''+name+'\')">'+name+'</span>';
  });
  var anyHidden = allAgents.some(function(n) { return !isAgentVisible(n); });
  if (anyHidden) filterHtml += '<button class="agent-chip-reset" onclick="showAllAgents()">Show All</button>';
  filterHtml += '</div>';

  // Filter results by visibility
  results = results.filter(function(r) { return isAgentVisible(r.agent); });

  // Rebuild maps with only visible agents
  agentMap = {}; taskMap = {}; tierTasks = {};
  results.forEach(function(r) {
    if (!agentMap[r.agent]) agentMap[r.agent] = {
      name:r.agent, model:r.model, version:r.agent_version,
      pass:0, fail:0, timeout:0, total:0, time:0, score:0, byTier:{},
      juryTotal:0, jurySum:0
    };
    var a = agentMap[r.agent];
    a.total++; a.time += r.elapsed_seconds; a.score += r.score;
    if (r.timed_out) a.timeout++;
    r.passed ? a.pass++ : a.fail++;
    var t = r.tier;
    if (!a.byTier[t]) a.byTier[t] = {pass:0, fail:0, total:0};
    a.byTier[t].total++;
    r.passed ? a.byTier[t].pass++ : a.byTier[t].fail++;
    if (r.jury_verdict) { a.juryTotal++; a.jurySum += r.jury_verdict.rating; }
    if (!taskMap[r.task_id]) taskMap[r.task_id] = {tier:r.tier, name:r.task_name||r.task_id, agents:{}};
    taskMap[r.task_id].agents[r.agent] = r;
    if (!tierTasks[t]) tierTasks[t] = [];
    if (tierTasks[t].indexOf(r.task_id) < 0) tierTasks[t].push(r.task_id);
  });

  var agents = Object.keys(agentMap).map(function(k){return agentMap[k];}).sort(function(a,b){return b.pass-a.pass||a.time-b.time;});
  var names = agents.map(function(a){return a.name;});

  function isLocal(m) {
    m = (m||'').toLowerCase();
    return m.indexOf(':q')>=0||m.indexOf('qwen')>=0||m.indexOf('llama')>=0||m.indexOf('mistral')>=0||m.indexOf('deepseek')>=0||m.indexOf('phi')>=0||m.indexOf('gguf')>=0;
  }

  // Run info
  var first = results[0].timestamp, last = results[results.length-1].timestamp;
  var totalTasks = Object.keys(taskMap).length;
  var h = filterHtml;
  h += '<div class="run-info"><b>'+totalTasks+'</b> tasks &times; <b>'+agents.length+'</b> agents = <b>'+results.length+'</b> evaluations';
  if (first) h += ' | Run: <b>'+new Date(first).toLocaleDateString()+'</b>';
  h += '</div>';

  // Agent cards
  h += '<div class="agents-grid">';
  agents.forEach(function(a, i) {
    var pct = a.total ? Math.round(a.pass/a.total*100) : 0;
    var local = isLocal(a.model);
    var col = colors[i % colors.length];
    h += '<div class="agent-card"><div class="bar-top" style="background:'+col+'"></div>';
    h += '<div class="agent-name">'+a.name+'</div>';
    h += '<div class="agent-model">'+(a.model||'unknown')+'</div>';
    h += '<div class="agent-version">v'+(a.version||'?')+' &nbsp; <span class="agent-type '+(local?'type-local':'type-cloud')+'">'+(local?'Local (Ollama)':'Cloud API')+'</span></div>';
    h += '<div class="stats-row">';
    h += '<div class="stat-box"><div class="num" style="color:var(--green)">'+a.pass+'</div><div class="label">passed</div></div>';
    h += '<div class="stat-box"><div class="num" style="color:var(--red)">'+a.fail+'</div><div class="label">failed</div></div>';
    h += '<div class="stat-box"><div class="num">'+pct+'%</div><div class="label">pass rate</div></div>';
    h += '<div class="stat-box"><div class="num" style="font-size:1.3rem">'+fmt(a.time/a.total)+'</div><div class="label">avg time</div></div>';
    h += '<div class="stat-box"><div class="num" style="font-size:1.3rem">'+(a.score/a.total*100).toFixed(0)+'%</div><div class="label">avg score</div></div>';
    if (a.juryTotal > 0) {
      var javg = (a.jurySum/a.juryTotal).toFixed(1);
      h += '<div class="stat-box"><div class="num jury-avg">'+javg+'<span style="font-size:0.9rem">/100</span></div><div class="label">jury rating</div></div>';
    }
    h += '</div>';
    h += '<div class="pass-bar"><div class="pass-bar-fill" style="width:'+pct+'%"></div></div>';
    h += '<div class="tier-pills">';
    tierOrder.forEach(function(t) {
      var bt = a.byTier[t];
      if (!bt) return;
      var c = bt.pass===bt.total ? 'var(--green)' : bt.pass===0 ? 'var(--red)' : 'var(--orange)';
      h += '<span class="tier-pill" style="background:'+c+'22;color:'+c+'">'+t+' '+bt.pass+'/'+bt.total+'</span>';
    });
    h += '</div></div>';
  });
  h += '</div>';

  // Tier summary (moved to top, before detailed head-to-head table)
  h += '<h2>Tier Summary</h2><div class="tier-summary">';
  tierOrder.forEach(function(tier) {
    var tids = tierTasks[tier];
    if (!tids) return;
    h += '<div class="tier-card"><h4 style="margin-bottom:0.5rem">'+tb(tier)+' <span style="color:var(--text);font-weight:400;margin-left:0.5rem">'+tids.length+' tasks</span></h4>';
    agents.forEach(function(a) {
      var bt = a.byTier[tier];
      if (!bt) return;
      var rate = bt.total ? Math.round(bt.pass/bt.total*100) : 0;
      h += '<div class="tier-agent"><span><strong>'+a.name+'</strong> <span style="color:var(--muted);font-size:0.8rem">('+(a.model||'')+')</span></span>';
      h += '<span>'+bt.pass+'/'+bt.total+' <span style="color:var(--muted)">('+rate+'%)</span></span></div>';
    });
    h += '</div>';
  });
  h += '</div>';

  // Comparison table
  h += '<h2>Head-to-Head Results</h2>';
  h += '<p style="color:var(--muted);font-size:0.8rem;margin-bottom:0.75rem">Click any row to expand evaluation details</p>';
  h += '<table><thead><tr><th>Task</th><th>Tier</th>';
  names.forEach(function(n) {
    h += '<th>'+n+'<br><span style="font-weight:400;text-transform:none;letter-spacing:0;font-family:monospace;font-size:0.72rem">'+(agentMap[n].model||'')+'</span></th>';
  });
  h += '<th>Speed Winner</th></tr></thead><tbody>';

  var ri = 0;
  tierOrder.forEach(function(tier) {
    var tids = tierTasks[tier];
    if (!tids) return;
    // Tier separator
    h += '<tr><td colspan="'+(names.length+3)+'" style="padding-top:1.5rem;border-bottom:none">'+tb(tier)+'</td></tr>';
    tids.forEach(function(tid) {
      var task = taskMap[tid];
      if (!task) return;
      var id = 'r'+ri; ri++;
      h += '<tr class="clickable" onclick="toggle(\''+id+'\')">';
      h += '<td><strong>'+task.name+'</strong></td>';
      h += '<td>'+tb(task.tier)+'</td>';
      var times = {};
      names.forEach(function(n) {
        var r = task.agents[n];
        if (!r) { h += '<td>--</td>'; return; }
        var cls = r.timed_out ? 'badge-timeout' : (r.passed ? 'badge-pass' : 'badge-fail');
        var lbl = r.timed_out ? 'TIMEOUT' : (r.passed ? 'PASS' : 'FAIL');
        var juryBit = '';
        if (r.jury_verdict) {
          var jv = r.jury_verdict;
          var jcls = jv.verdict==='pass' ? 'jury-verdict-pass' : (jv.verdict==='partial' ? 'jury-verdict-partial' : 'jury-verdict-fail');
          juryBit = '<span class="jury-verdict-badge '+jcls+'">'+jv.verdict.toUpperCase()+'</span><span class="jury-rating-inline">'+jv.rating+'/100</span>';
        }
        h += '<td><span class="badge '+cls+'">'+lbl+'</span><span class="result-time">'+fmt(r.elapsed_seconds)+'</span> <span class="result-score">('+Math.round(r.score*100)+'%)</span>'+juryBit+'</td>';
        times[n] = r.elapsed_seconds;
      });
      var ents = Object.keys(times).map(function(k){return [k,times[k]];}).sort(function(a,b){return a[1]-b[1];});
      if (ents.length >= 2) {
        var spd = (ents[1][1]/ents[0][1]).toFixed(1);
        h += '<td><span class="speed-winner">'+ents[0][0]+'</span> <span style="color:var(--muted);font-size:0.8rem">('+spd+'x)</span></td>';
      } else { h += '<td>--</td>'; }
      h += '</tr>';

      // Detail row
      h += '<tr class="detail-row" id="'+id+'"><td colspan="'+(names.length+3)+'">';
      h += '<div class="detail-grid" style="grid-template-columns:repeat('+names.length+',1fr)">';
      names.forEach(function(n) {
        var r = task.agents[n];
        if (!r) { h += '<div></div>'; return; }
        h += '<div><strong>'+n+'</strong> <span style="color:var(--muted);font-size:0.8rem">('+(r.model||'')+')</span>';
        if (r.git_commit) { h += ' <span style="color:var(--accent);font-size:0.72rem;font-family:monospace" title="Git commit">@'+r.git_commit+'</span>'; }
        h += '<br>';
        if (r.evaluations && r.evaluations.length) {
          r.evaluations.forEach(function(ev) {
            var ic = ev.passed ? '<span class="eval-icon eval-pass">&#10003;</span>' : '<span class="eval-icon eval-fail">&#10007;</span>';
            var det = ev.detail ? '<div class="eval-detail" title="'+ev.detail.replace(/"/g,'&quot;').replace(/</g,'&lt;')+'">'+ev.detail.replace(/</g,'&lt;').substring(0,200)+'</div>' : '';
            h += '<div class="eval-item">'+ic+'<div><strong>'+ev.type+'</strong>'+det+'</div></div>';
          });
        }
        if (r.workspace_files && r.workspace_files.length) {
          h += '<div style="margin-top:0.5rem;font-size:0.72rem;color:var(--muted)">Files:</div>';
          r.workspace_files.forEach(function(f) { h += '<span class="file-tag">'+f+'</span>'; });
        }
        // Jury verdict section
        var jv = r.jury_verdict;
        if (jv) {
          var vcls = jv.verdict==='pass' ? 'badge-pass' : (jv.verdict==='partial' ? 'badge-timeout' : 'badge-fail');
          h += '<div class="jury-box">';
          h += '<div class="jury-header">Jury Verdict: <span class="badge '+vcls+'">'+jv.verdict.toUpperCase()+'</span>';
          h += ' <span style="color:var(--muted);font-size:0.72rem">('+escape(jv.jury_model||'')+')</span></div>';
          h += '<div class="jury-scores">';
          h += '<span class="jury-score"><b>Rating:</b> '+jv.rating+'/100</span>';
          h += '<span class="jury-score"><b>Correctness:</b> '+jv.correctness+'/100</span>';
          h += '<span class="jury-score"><b>Completeness:</b> '+jv.completeness+'/100</span>';
          h += '<span class="jury-score"><b>Code Quality:</b> '+jv.code_quality+'/100</span>';
          h += '</div>';
          if (jv.reasoning) {
            h += '<div class="jury-reasoning"><em>'+escape(jv.reasoning)+'</em></div>';
          }
          // Per-category detailed reasoning
          if (jv.correctness_reasoning) {
            h += '<div class="jury-detail-section">';
            h += '<div class="jury-detail-label">Correctness Analysis:</div>';
            h += '<div class="jury-detail-text">'+escape(jv.correctness_reasoning)+'</div>';
            h += '</div>';
          }
          if (jv.completeness_reasoning) {
            h += '<div class="jury-detail-section">';
            h += '<div class="jury-detail-label">Completeness Analysis:</div>';
            h += '<div class="jury-detail-text">'+escape(jv.completeness_reasoning)+'</div>';
            h += '</div>';
          }
          if (jv.code_quality_reasoning) {
            h += '<div class="jury-detail-section">';
            h += '<div class="jury-detail-label">Code Quality Analysis:</div>';
            h += '<div class="jury-detail-text">'+escape(jv.code_quality_reasoning)+'</div>';
            h += '</div>';
          }
          h += '</div>';
        }
        h += '</div>';
      });
      h += '</div></td></tr>';
    });
  });
  h += '</tbody></table>';

  document.getElementById('app').innerHTML = h;
}

renderRunSelector();
loadJuryModels();
loadSettings();
render();

function toggle(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById(tab+'-tab').classList.add('active');
  document.querySelector('.tab[onclick*="\''+tab+'\'"]').classList.add('active');
  if (tab === 'battle') {
    // Always fetch fresh battle data from API
    fetch('/api/battles').then(function(r){return r.json();}).then(function(data) {
      BATTLES = data;
      renderBattle();
    }).catch(function() { renderBattle(); });
  }
}

function renderBattleSelector() {
  if (!BATTLES.length) return;
  var sel = '<label>Tournament:</label><select id="battle-select" onchange="switchBattle(this.selectedIndex)">';
  BATTLES.forEach(function(b, i) {
    var d = b.started_at ? new Date(b.started_at).toLocaleString() : 'unknown';
    var n = b.participants ? b.participants.length : '?';
    var mode = (b.metadata && b.metadata.mode) ? b.metadata.mode : 'random';
    var modeLabel = mode === 'agent' ? 'Agent-Played' : 'Random';
    sel += '<option value="'+i+'">#'+b.id+' — '+b.game+' ['+modeLabel+'] — '+d+' — '+n+' agents, '+b.games_per_side+' games/side</option>';
  });
  sel += '</select>';
  document.getElementById('battle-selector').innerHTML = sel;
}

function switchBattle(idx) {
  currentBattleIdx = idx;
  renderBattle();
}

function renderBattle() {
  renderBattleSelector();
  // Live games section — always shown at top
  var liveHtml = '<div class="live-section">';
  liveHtml += '<div class="live-header"><div class="live-dot"></div><h2 style="border:none;margin:0;padding:0">Live Games</h2></div>';
  liveHtml += '<div id="live-games-area"><div class="live-no-games">Checking for live games...</div></div>';
  liveHtml += '</div>';

  if (!BATTLES.length) {
    document.getElementById('battle-app').innerHTML = liveHtml + '<div class="no-battles">No battle tournaments found. Run <code>python battle.py --game chess</code> to start one.</div>';
    startLiveGamesPolling();
    return;
  }
  var b = BATTLES[currentBattleIdx];
  var standings = b.standings || [];
  var matches = b.matches || [];
  // Recompute crashes from match data — only count crash/illegal reasons, not timeouts
  var crashMap = {};
  standings.forEach(function(s) { crashMap[s.agent] = 0; });
  matches.forEach(function(m) {
    var isCrash = m.reason === 'crash' || m.reason === 'illegal';
    if (!isCrash) return;
    if (m.result === 'white_crash' || m.result === 'white_forfeit') crashMap[m.white_agent] = (crashMap[m.white_agent]||0) + 1;
    if (m.result === 'black_crash' || m.result === 'black_forfeit') crashMap[m.black_agent] = (crashMap[m.black_agent]||0) + 1;
  });
  standings.forEach(function(s) { s.crashes = crashMap[s.agent] || 0; });
  var agents = standings.map(function(s) { return s.agent; });
  var h = '';

  // Tournament info
  var bmode = (b.metadata && b.metadata.mode) ? b.metadata.mode : 'random';
  var bmodeLabel = bmode === 'agent' ? 'Agent-Played' : 'Random';
  var bmodeColor = bmode === 'agent' ? 'var(--green)' : 'var(--muted)';
  h += '<div class="run-info" style="margin-bottom:1.5rem"><b>'+b.game.toUpperCase()+'</b> Tournament #'+b.id;
  h += ' | <span style="color:'+bmodeColor+';font-weight:600">'+bmodeLabel+'</span>';
  h += ' | <b>'+standings.length+'</b> agents | <b>'+matches.length+'</b> games';
  h += ' | '+b.games_per_side+' games per side';
  if (b.finished_at) h += ' | Finished: <b>'+new Date(b.finished_at).toLocaleString()+'</b>';
  h += '</div>';

  // Leaderboard
  h += '<h2>Leaderboard</h2>';
  h += '<table class="standings-table"><thead><tr><th>#</th><th>Agent</th><th>Model</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Crashes</th><th>Points</th></tr></thead><tbody>';
  standings.forEach(function(s) {
    var rcls = s.rank <= 3 ? ' class="rank-'+s.rank+'"' : '';
    var medal = s.rank===1?'&#129351; ':s.rank===2?'&#129352; ':s.rank===3?'&#129353; ':'';
    h += '<tr>';
    h += '<td'+rcls+'>'+medal+s.rank+'</td>';
    h += '<td><strong>'+s.agent+'</strong></td>';
    h += '<td style="font-family:monospace;font-size:0.8rem;color:var(--accent)">'+s.model+'</td>';
    h += '<td>'+s.played+'</td>';
    h += '<td style="color:var(--green)">'+s.wins+'</td>';
    h += '<td style="color:var(--orange)">'+s.draws+'</td>';
    h += '<td style="color:var(--red)">'+s.losses+'</td>';
    h += '<td>'+(s.crashes>0?'<span class="crash-badge">'+s.crashes+'</span>':'0')+'</td>';
    h += '<td><strong>'+s.points+'</strong></td>';
    h += '</tr>';
  });
  h += '</tbody></table>';

  // Head-to-head grid
  if (agents.length > 1) {
    h += '<h2>Head-to-Head</h2>';
    // Build h2h map
    var h2h = {};
    agents.forEach(function(a) { h2h[a] = {}; agents.forEach(function(b2) { h2h[a][b2] = {w:0,d:0,l:0}; }); });
    matches.forEach(function(m) {
      var wa = m.white_agent, ba = m.black_agent;
      if (m.result === 'white' || m.result === 'black_crash' || m.result === 'black_forfeit') { h2h[wa][ba].w++; h2h[ba][wa].l++; }
      else if (m.result === 'black' || m.result === 'white_crash' || m.result === 'white_forfeit') { h2h[ba][wa].w++; h2h[wa][ba].l++; }
      else { h2h[wa][ba].d++; h2h[ba][wa].d++; }
    });

    h += '<div class="h2h-grid"><table><thead><tr><th></th>';
    agents.forEach(function(a) { h += '<th>'+a+'</th>'; });
    h += '</tr></thead><tbody>';
    agents.forEach(function(a) {
      h += '<tr><th>'+a+'</th>';
      agents.forEach(function(b2) {
        if (a === b2) { h += '<td class="self">-</td>'; return; }
        var r = h2h[a][b2];
        var parts = [];
        if (r.w) parts.push('<span class="h2h-win">'+r.w+'W</span>');
        if (r.d) parts.push('<span class="h2h-draw">'+r.d+'D</span>');
        if (r.l) parts.push('<span class="h2h-loss">'+r.l+'L</span>');
        h += '<td>'+(parts.length ? parts.join(' ') : '-')+'</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
  }

  // Match list
  h += '<h2>Matches ('+matches.length+')</h2>';
  matches.forEach(function(m) {
    var isCrash = m.reason === 'crash' || m.reason === 'illegal';
    var whiteWins = m.result==='white'||m.result==='black_crash'||m.result==='black_forfeit';
    var blackWins = m.result==='black'||m.result==='white_crash'||m.result==='white_forfeit';
    var sym = whiteWins ? (isCrash?'1-0*':'1-0') : blackWins ? (isCrash?'0-1*':'0-1') : '1/2';
    var rcol = whiteWins?'var(--green)':blackWins?'var(--red)':'var(--orange)';
    var hasDetail = m.id ? ' style="cursor:pointer" onclick="showMatchDetail('+m.id+')" title="Click for per-move timing"' : '';
    h += '<div class="match-card"'+hasDetail+'>';
    h += '<span><strong>'+m.white_agent+'</strong> <span style="color:var(--muted)">vs</span> <strong>'+m.black_agent+'</strong></span>';
    h += '<span class="match-result" style="color:'+rcol+'">'+sym+'</span>';
    h += '<span class="match-meta">'+m.reason+' | '+m.move_count+' moves | '+(m.duration_ms||0)+'ms';
    if (isCrash) h += ' <span class="crash-badge">CRASH</span>';
    if (m.move_details && m.move_details.length) h += ' <span style="color:var(--accent);font-size:0.75rem">&#9201; telemetry</span>';
    h += '</span>';
    h += '</div>';
  });

  document.getElementById('battle-app').innerHTML = liveHtml + h;
  startLiveGamesPolling();
}

// ── Live Games ──
var liveGamesInterval = null;
var liveGamesActive = false;

function fmtClock(seconds) {
  if (seconds === undefined || seconds === null) return '--:--';
  if (seconds <= 0) return '0:00';
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function formatMoveList(moves) {
  if (!moves || !moves.length) return '';
  var h = '';
  for (var i = 0; i < moves.length; i += 2) {
    var num = Math.floor(i / 2) + 1;
    h += '<span class="live-move-num">' + num + '.</span> ' + moves[i];
    if (i + 1 < moves.length) h += ' ' + moves[i + 1];
    h += '  ';
  }
  return h;
}

var _liveGamesMoveCount = {};  // track move counts to avoid unnecessary image reloads

function renderLiveGames() {
  fetch('/api/live-games').then(function(r) { return r.json(); }).then(function(games) {
    var container = document.getElementById('live-games-area');
    if (!container) return;

    if (!games || !games.length) {
      container.innerHTML = '<div class="live-no-games">No live games running. Start a visual battle with <code>python battle.py --game chess --mode visual</code></div>';
      _liveGamesMoveCount = {};
      return;
    }

    // Check if we need to rebuild the DOM (game count changed or new game IDs)
    var existingCards = container.querySelectorAll('.live-game-card');
    var existingIds = {};
    existingCards.forEach(function(c) { existingIds[c.getAttribute('data-game-id')] = c; });
    var gameIds = games.map(function(g) { return g.id; });
    var needsRebuild = existingCards.length !== games.length ||
      gameIds.some(function(id) { return !existingIds[id]; });

    if (needsRebuild) {
      // Full rebuild — create all cards from scratch
      var h = '<div class="live-games-grid">';
      games.forEach(function(g) {
        h += _buildLiveGameCard(g);
      });
      h += '</div>';
      container.innerHTML = h;
      _liveGamesMoveCount = {};
      // Force load all screenshots
      games.forEach(function(g) {
        _liveGamesMoveCount[g.id] = -1;
      });
    }

    // Incremental update — patch each card's dynamic content
    games.forEach(function(g) {
      var card = container.querySelector('[data-game-id="' + g.id + '"]');
      if (!card) return;
      var st = g.state || {};
      _updateLiveGameCard(card, g, st);
    });
  }).catch(function() {
    var container = document.getElementById('live-games-area');
    if (container && !container.querySelector('.live-game-card'))
      container.innerHTML = '<div class="live-no-games">Could not fetch live games</div>';
  });
}

function _buildLiveGameCard(g) {
  var st = g.state || {};
  var isOver = st.game_over || st.error;
  var h = '<div class="live-game-card' + (isOver ? ' live-game-over' : '') + '" data-game-id="' + g.id + '">';
  h += '<div class="board-area"><img data-role="board-img" src="/api/live-games/' + g.id + '/screenshot?t=' + Date.now() + '" alt="Board"></div>';
  h += '<div class="live-game-info">';
  h += '<div class="live-players" data-role="players"></div>';
  h += '<div data-role="status"></div>';
  h += '<div class="live-moves" data-role="moves"></div>';
  h += '</div></div>';
  return h;
}

function _updateLiveGameCard(card, g, st) {
  var isOver = st.game_over || st.error;
  if (isOver) card.classList.add('live-game-over');

  // Update screenshot only when move count changes
  var mc = st.move_count || 0;
  var prevMc = _liveGamesMoveCount[g.id];
  if (prevMc === undefined || prevMc !== mc || isOver) {
    var img = card.querySelector('[data-role="board-img"]');
    if (img) {
      var newSrc = '/api/live-games/' + g.id + '/screenshot?t=' + Date.now();
      // Preload to avoid flash
      var preload = new Image();
      preload.onload = function() { img.src = newSrc; };
      preload.src = newSrc;
    }
    _liveGamesMoveCount[g.id] = mc;
  }

  // Update players + clocks
  var whiteName = st.white_name || 'White';
  var blackName = st.black_name || 'Black';
  var turn = st.turn || 'white';
  var wClock = st.clocks ? st.clocks.white : null;
  var bClock = st.clocks ? st.clocks.black : null;
  var wClockClass = 'live-clock' + (turn === 'white' ? ' live-clock-active' : ' live-clock-inactive');
  var bClockClass = 'live-clock' + (turn === 'black' ? ' live-clock-active' : ' live-clock-inactive');
  if (wClock !== null && wClock < 60) wClockClass = 'live-clock live-clock-low';
  if (bClock !== null && bClock < 60) bClockClass = 'live-clock live-clock-low';

  var playersEl = card.querySelector('[data-role="players"]');
  if (playersEl) {
    playersEl.innerHTML =
      '<div class="live-player"><div class="live-player-color" style="background:#fff"></div>' +
      '<span class="live-player-name">' + escape(whiteName) + '</span>' +
      '<span class="' + wClockClass + '">' + fmtClock(wClock) + '</span></div>' +
      '<div class="live-player"><span class="' + bClockClass + '">' + fmtClock(bClock) + '</span>' +
      '<span class="live-player-name">' + escape(blackName) + '</span>' +
      '<div class="live-player-color" style="background:#333"></div></div>';
  }

  // Update status
  var statusEl = card.querySelector('[data-role="status"]');
  if (statusEl) {
    if (isOver && st.game_result) {
      var resultColor = st.game_result === 'white' ? 'var(--green)' : st.game_result === 'black' ? 'var(--red)' : 'var(--orange)';
      var resultText = st.game_result === 'white' ? 'White wins' : st.game_result === 'black' ? 'Black wins' : 'Draw';
      if (st.game_over_reason) resultText += ' (' + st.game_over_reason + ')';
      statusEl.innerHTML = '<div class="live-result-banner" style="color:' + resultColor + '">' + resultText + '</div>';
    } else if (st.error) {
      statusEl.innerHTML = '<div class="live-status">Server unreachable</div>';
    } else {
      statusEl.innerHTML = '<div class="live-status">Move <strong>' + mc + '</strong> &mdash; <span class="live-status-turn">' + turn + ' to move</span></div>';
    }
  }

  // Update move list
  var movesEl = card.querySelector('[data-role="moves"]');
  if (movesEl && st.moves) {
    movesEl.innerHTML = formatMoveList(st.moves);
  }
}

function startLiveGamesPolling() {
  if (liveGamesActive) return;
  liveGamesActive = true;
  renderLiveGames();
  liveGamesInterval = setInterval(renderLiveGames, 3000);
}

function stopLiveGamesPolling() {
  liveGamesActive = false;
  if (liveGamesInterval) { clearInterval(liveGamesInterval); liveGamesInterval = null; }
}

// Override switchTab to manage live games polling
var _origSwitchTab = switchTab;
switchTab = function(tab) {
  _origSwitchTab(tab);
  if (tab === 'battle') {
    startLiveGamesPolling();
  } else {
    stopLiveGamesPolling();
  }
};

// ── Match Detail Modal ──
function showMatchDetail(matchId) {
  fetch('/api/matches/' + matchId).then(function(r) { return r.json(); }).then(function(m) {
    if (m.error) { alert('Match not found'); return; }
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

    var content = '<div class="modal-content">';
    content += '<button class="modal-close" onclick="this.closest(\'.modal-overlay\').remove()">&times;</button>';

    // Header
    var whiteWins = m.result==='white'||m.result==='black_crash'||m.result==='black_forfeit';
    var blackWins = m.result==='black'||m.result==='white_crash'||m.result==='white_forfeit';
    var sym = whiteWins ? '1-0' : blackWins ? '0-1' : '1/2';
    content += '<h2 style="margin-top:0">'+m.white_agent+' vs '+m.black_agent+' &mdash; <span style="color:'+(whiteWins?'var(--green)':blackWins?'var(--red)':'var(--orange)')+'">'+sym+'</span></h2>';
    content += '<div style="color:var(--muted);font-size:0.85rem;margin-bottom:1rem">'+m.reason+' | '+m.move_count+' moves | '+(m.duration_ms||0)+'ms | Match #'+m.id+'</div>';

    var details = m.move_details || [];
    if (!details.length) {
      content += '<div style="color:var(--muted);padding:2rem;text-align:center">No per-move timing available for this match.</div>';
      content += '</div>';
      overlay.innerHTML = content;
      document.body.appendChild(overlay);
      return;
    }

    // Summary stats
    var whiteMoves = details.filter(function(d){return d.color==='white';});
    var blackMoves = details.filter(function(d){return d.color==='black';});
    var whiteTotal = whiteMoves.reduce(function(s,d){return s+d.think_time_ms;},0);
    var blackTotal = blackMoves.reduce(function(s,d){return s+d.think_time_ms;},0);
    var whiteAvg = whiteMoves.length ? whiteTotal/whiteMoves.length : 0;
    var blackAvg = blackMoves.length ? blackTotal/blackMoves.length : 0;
    var whiteSlowest = whiteMoves.length ? whiteMoves.reduce(function(a,b){return a.think_time_ms>b.think_time_ms?a:b;}) : null;
    var blackSlowest = blackMoves.length ? blackMoves.reduce(function(a,b){return a.think_time_ms>b.think_time_ms?a:b;}) : null;

    content += '<div class="summary-grid">';
    content += '<div class="summary-card"><div class="label">White Total Think</div><div class="value">'+fmtMs(whiteTotal)+'</div></div>';
    content += '<div class="summary-card"><div class="label">Black Total Think</div><div class="value">'+fmtMs(blackTotal)+'</div></div>';
    content += '<div class="summary-card"><div class="label">White Avg/Move</div><div class="value">'+fmtMs(Math.round(whiteAvg))+'</div></div>';
    content += '<div class="summary-card"><div class="label">Black Avg/Move</div><div class="value">'+fmtMs(Math.round(blackAvg))+'</div></div>';
    if (whiteSlowest) content += '<div class="summary-card"><div class="label">White Slowest</div><div class="value">'+fmtMs(whiteSlowest.think_time_ms)+' <span style="color:var(--muted);font-size:0.75rem">#'+whiteSlowest.move_number+' '+whiteSlowest.move+'</span></div></div>';
    if (blackSlowest) content += '<div class="summary-card"><div class="label">Black Slowest</div><div class="value">'+fmtMs(blackSlowest.think_time_ms)+' <span style="color:var(--muted);font-size:0.75rem">#'+blackSlowest.move_number+' '+blackSlowest.move+'</span></div></div>';
    content += '</div>';

    // Per-move timing bars
    var maxThink = Math.max.apply(null, details.map(function(d){return d.think_time_ms;}));
    content += '<h3>Per-Move Timing</h3>';
    content += '<table class="move-timeline"><thead><tr><th>#</th><th>Move</th><th>Side</th><th>Think Time</th><th>Clock</th><th style="width:40%">Timeline</th></tr></thead><tbody>';
    var cumWhite = 0, cumBlack = 0;
    details.forEach(function(d) {
      if (d.color === 'white') cumWhite += d.think_time_ms; else cumBlack += d.think_time_ms;
      var isSlow = d.think_time_ms > 30000;
      var barWidth = maxThink > 0 ? Math.max(2, Math.round(d.think_time_ms / maxThink * 100)) : 2;
      var barClass = 'timing-bar ' + d.color + (isSlow ? ' slow' : '');
      content += '<tr>';
      content += '<td>'+d.move_number+'</td>';
      content += '<td><strong>'+d.move+'</strong></td>';
      content += '<td>'+(d.color==='white'?'&#9812;':'&#9818;')+' '+d.color+'</td>';
      content += '<td'+(isSlow?' style="color:var(--red);font-weight:600"':'')+'>'+fmtMs(d.think_time_ms)+'</td>';
      content += '<td>'+fmtClock(d.clock_after)+'</td>';
      content += '<td><div class="'+barClass+'" style="width:'+barWidth+'%" title="'+fmtMs(d.think_time_ms)+'"></div></td>';
      content += '</tr>';
    });
    content += '</tbody></table>';

    // Agent telemetry section
    var tel = m.agent_telemetry || {};
    if (tel.white || tel.black) {
      content += '<div class="telemetry-section">';
      content += '<h3>Agent Telemetry</h3>';

      // Side-by-side summary cards for agents with telemetry
      var agentSummaries = [];
      ['white', 'black'].forEach(function(side) {
        var t = tel[side];
        if (!t || !t.has_telemetry) return;
        var totalTurnMs = 0, totalToolMs = 0, totalTokensIn = 0, totalTokensOut = 0;
        var toolBreakdown = {};
        t.turns.forEach(function(turn) {
          totalTurnMs += turn.duration_ms || 0;
          var tok = turn.tokens || {};
          totalTokensIn += tok.input || 0;
          totalTokensOut += tok.output || 0;
          (turn.tools || []).forEach(function(tl) {
            totalToolMs += tl.duration_ms || 0;
            var name = tl.name || 'unknown';
            toolBreakdown[name] = (toolBreakdown[name] || 0) + (tl.duration_ms || 0);
          });
        });
        var llmMs = totalTurnMs - totalToolMs;
        var movesForSide = side === 'white' ? whiteMoves.length : blackMoves.length;
        var turnsPerMove = movesForSide > 0 ? (t.total_turns / movesForSide).toFixed(1) : '?';
        agentSummaries.push({side: side, agent: t.agent, totalTurnMs: totalTurnMs,
          totalToolMs: totalToolMs, llmMs: llmMs, totalTokensIn: totalTokensIn,
          totalTokensOut: totalTokensOut, turnsPerMove: turnsPerMove,
          totalTurns: t.total_turns, toolBreakdown: toolBreakdown, turns: t.turns});
      });

      // Agent comparison cards
      if (agentSummaries.length > 0) {
        content += '<div class="summary-grid">';
        agentSummaries.forEach(function(a) {
          var llmPct = a.totalTurnMs > 0 ? Math.round(a.llmMs / a.totalTurnMs * 100) : 0;
          var toolPct = 100 - llmPct;
          var sideIcon = a.side === 'white' ? '&#9812;' : '&#9818;';
          content += '<div class="summary-card" style="grid-column: span 2">';
          content += '<div class="label">' + sideIcon + ' ' + a.side.charAt(0).toUpperCase()+a.side.slice(1)+' &mdash; '+a.agent+'</div>';
          content += '<div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:0.5rem">';
          content += '<div><div style="color:var(--muted);font-size:0.7rem">LLM Thinking</div><div class="value" style="color:var(--accent)">'+fmtMs(a.llmMs)+' <span style="font-size:0.75rem;color:var(--muted)">('+llmPct+'%)</span></div></div>';
          content += '<div><div style="color:var(--muted);font-size:0.7rem">Tool Execution</div><div class="value">'+fmtMs(a.totalToolMs)+' <span style="font-size:0.75rem;color:var(--muted)">('+toolPct+'%)</span></div></div>';
          content += '<div><div style="color:var(--muted);font-size:0.7rem">Turns/Move</div><div class="value">'+a.turnsPerMove+'</div></div>';
          content += '<div><div style="color:var(--muted);font-size:0.7rem">Total Turns</div><div class="value">'+a.totalTurns+'</div></div>';
          if (a.totalTokensIn > 0 || a.totalTokensOut > 0) {
            content += '<div><div style="color:var(--muted);font-size:0.7rem">Tokens (in/out)</div><div class="value" style="font-size:0.9rem">'+a.totalTokensIn.toLocaleString()+' / '+a.totalTokensOut.toLocaleString()+'</div></div>';
          }
          content += '</div>';
          // LLM vs Tool bar
          content += '<div style="margin-top:0.5rem;height:8px;background:var(--border);border-radius:4px;overflow:hidden;display:flex">';
          content += '<div style="width:'+llmPct+'%;background:var(--accent)" title="LLM: '+fmtMs(a.llmMs)+'"></div>';
          content += '<div style="width:'+toolPct+'%;background:var(--green)" title="Tools: '+fmtMs(a.totalToolMs)+'"></div>';
          content += '</div>';
          content += '<div style="font-size:0.65rem;color:var(--muted);margin-top:2px"><span style="color:var(--accent)">&#9632;</span> LLM &nbsp; <span style="color:var(--green)">&#9632;</span> Tools</div>';
          // Tool breakdown
          var toolNames = Object.keys(a.toolBreakdown);
          if (toolNames.length > 0 && !(toolNames.length === 1 && toolNames[0] === 'unknown')) {
            content += '<div style="margin-top:0.5rem;font-size:0.75rem">';
            toolNames.sort(function(x,y){return a.toolBreakdown[y]-a.toolBreakdown[x];});
            toolNames.forEach(function(name) {
              content += '<span style="color:var(--muted);margin-right:1rem">'+name+': '+fmtMs(a.toolBreakdown[name])+'</span>';
            });
            content += '</div>';
          }
          content += '</div>';
        });
        content += '</div>';
      }

      // Per-turn detail tables (collapsible)
      agentSummaries.forEach(function(a) {
        var sideIcon = a.side === 'white' ? '&#9812;' : '&#9818;';
        content += '<details style="margin-top:1rem"><summary style="cursor:pointer;color:var(--accent);font-size:0.85rem">'+sideIcon+' '+a.agent+' &mdash; '+a.totalTurns+' turns detail</summary>';
        content += '<table class="move-timeline" style="margin-top:0.5rem"><thead><tr><th>Turn</th><th>Duration</th><th>LLM Time</th><th>Tools</th>';
        if (a.totalTokensIn > 0) content += '<th>Tokens (in/out)</th>';
        content += '</tr></thead><tbody>';
        a.turns.forEach(function(turn) {
          var toolMs = (turn.tools||[]).reduce(function(s,tl){return s+(tl.duration_ms||0);},0);
          var llm = (turn.duration_ms||0) - toolMs;
          var toolNames = (turn.tools||[]).map(function(tl){return (tl.name||'?')+'('+fmtMs(tl.duration_ms||0)+')';}).join(', ') || '<span style="color:var(--muted)">none</span>';
          var tok = turn.tokens || {};
          content += '<tr><td>'+turn.turn_index+'</td><td>'+fmtMs(turn.duration_ms||0)+'</td><td style="color:var(--accent)">'+fmtMs(llm)+'</td><td style="font-size:0.75rem">'+toolNames+'</td>';
          if (a.totalTokensIn > 0) content += '<td>'+(tok.input||0)+' / '+(tok.output||0)+'</td>';
          content += '</tr>';
        });
        content += '</tbody></table></details>';
      });

      // Non-shizuha agents
      ['white', 'black'].forEach(function(side) {
        var t = tel[side];
        if (t && !t.has_telemetry) {
          content += '<div style="color:var(--muted);font-size:0.85rem;margin-top:0.5rem">'+(side==='white'?'&#9812;':'&#9818;')+' '+t.agent+': No NDJSON telemetry (non-shizuha agent)</div>';
        }
      });

      content += '</div>';
    }

    // Latency insights panel
    content += '<div class="telemetry-section">';
    content += '<h3>Latency Insights</h3>';
    content += '<div class="summary-grid">';

    // Clock vs agent time gap
    if (tel.white && tel.white.has_telemetry) {
      var wAgentTotal = (tel.white.turns||[]).reduce(function(s,t){return s+(t.duration_ms||0);},0);
      var wClockUsed = whiteTotal;
      var wGap = wAgentTotal - wClockUsed;
      content += '<div class="summary-card"><div class="label">White: Clock vs Agent Gap</div><div class="value">'+(wGap>0?'+':'')+fmtMs(Math.abs(wGap))+'</div><div style="font-size:0.7rem;color:var(--muted)">Agent spent '+fmtMs(wAgentTotal)+' but only '+fmtMs(wClockUsed)+' was on chess clock</div></div>';
    }
    if (tel.black && tel.black.has_telemetry) {
      var bAgentTotal = (tel.black.turns||[]).reduce(function(s,t){return s+(t.duration_ms||0);},0);
      var bClockUsed = blackTotal;
      var bGap = bAgentTotal - bClockUsed;
      content += '<div class="summary-card"><div class="label">Black: Clock vs Agent Gap</div><div class="value">'+(bGap>0?'+':'')+fmtMs(Math.abs(bGap))+'</div><div style="font-size:0.7rem;color:var(--muted)">Agent spent '+fmtMs(bAgentTotal)+' but only '+fmtMs(bClockUsed)+' was on chess clock</div></div>';
    }

    // Move tempo comparison
    if (whiteMoves.length && blackMoves.length) {
      var wFastest = whiteMoves.reduce(function(a,b){return a.think_time_ms<b.think_time_ms?a:b;});
      var bFastest = blackMoves.reduce(function(a,b){return a.think_time_ms<b.think_time_ms?a:b;});
      content += '<div class="summary-card"><div class="label">White Fastest Move</div><div class="value" style="color:var(--green)">'+fmtMs(wFastest.think_time_ms)+'</div><div style="font-size:0.7rem;color:var(--muted)">#'+wFastest.move_number+' '+wFastest.move+'</div></div>';
      content += '<div class="summary-card"><div class="label">Black Fastest Move</div><div class="value" style="color:var(--green)">'+fmtMs(bFastest.think_time_ms)+'</div><div style="font-size:0.7rem;color:var(--muted)">#'+bFastest.move_number+' '+bFastest.move+'</div></div>';
    }

    content += '</div></div>';

    content += '</div>';
    overlay.innerHTML = content;
    document.body.appendChild(overlay);
  }).catch(function(err) { console.error('Failed to load match detail:', err); });
}

function fmtMs(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  var m = Math.floor(ms / 60000);
  var s = ((ms % 60000) / 1000).toFixed(0);
  return m + 'm' + (s < 10 ? '0' : '') + s + 's';
}

// ── Live Benchmark Run ──
var _liveInterval = null;
var _lastLiveActive = false;

function renderLiveBanner(data) {
  var el = document.getElementById('live-banner');
  if (!el) return;
  if (!data.active) {
    if (_lastLiveActive) {
      // Run just finished — refresh historical data
      _lastLiveActive = false;
      fetch('/api/results').then(function(r){return r.json();}).then(function(d) { RESULTS=d; render(); });
      fetch('/api/runs').then(function(r){return r.json();}).then(function(d) { RUNS=d; renderRunSelector(); });
    }
    el.innerHTML = '';
    return;
  }
  _lastLiveActive = true;
  var h = '<div class="live-run-banner">';
  h += '<div class="live-run-title"><span class="dot"></span>Benchmark Running</div>';
  h += '<div class="live-run-progress">';
  h += '<span class="live-run-stat"><b>' + data.completed + '</b>/' + data.total_pairs + ' done</span>';
  if (data.skipped) h += '<span class="live-run-stat"><b>' + data.skipped + '</b> cached</span>';
  h += '<span class="live-run-stat">Elapsed: <b>' + fmt(data.elapsed) + '</b></span>';
  h += '<span class="live-run-stat">Agents: <b>' + (data.agents||[]).join(', ') + '</b></span>';
  h += '</div>';
  var running = data.running || {};
  var agents = Object.keys(running);
  if (agents.length) {
    h += '<div class="live-agents-row">';
    agents.forEach(function(name) {
      var a = running[name];
      var actClass = 'activity-' + (a.activity||'starting');
      h += '<div class="live-agent-chip">';
      h += '<span class="name">' + escape(name) + '</span>';
      h += '<span class="task">' + escape(a.task_id) + ' (' + escape(a.tier) + ')</span>';
      h += '<span class="activity ' + actClass + '">' + (a.activity||'starting') + '</span>';
      if (a.current_tool) h += '<span class="task"> ' + escape(a.current_tool) + '</span>';
      h += '<span class="task"> T' + (a.current_turn||0) + '/' + (a.max_turns||50) + '</span>';
      h += '<span class="task"> ' + fmt(a.elapsed||0) + '</span>';
      h += '</div>';
    });
    h += '</div>';
  }
  // Summary
  var summary = data.results_summary || [];
  if (summary.length) {
    h += '<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--muted)">';
    summary.forEach(function(s) {
      h += '<span style="margin-right:1rem">' + escape(s.agent) + ': ';
      h += '<span style="color:var(--green)">' + s.passed + 'P</span>';
      h += '/<span style="color:var(--red)">' + s.failed + 'F</span>';
      if (s.timeout) h += '/<span style="color:var(--orange)">' + s.timeout + 'T</span>';
      h += '</span>';
    });
    h += '</div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

function pollLiveState() {
  fetch('/api/live').then(function(r){return r.json();}).then(renderLiveBanner).catch(function(){});
}

// Start polling immediately
pollLiveState();
_liveInterval = setInterval(pollLiveState, 2000);
</script>
</body>
</html>
"""


# ── Background Jury Evaluation ──
import threading
import uuid

_jury_jobs = {}  # job_id -> {status, total, completed, errors, error}
_jury_jobs_lock = threading.Lock()


def get_jury_job_status(job_id):
    """Get status of a background jury evaluation job."""
    if not job_id:
        return {"status": "error", "error": "No job_id provided"}
    with _jury_jobs_lock:
        job = _jury_jobs.get(job_id)
    if not job:
        return {"status": "error", "error": "Job not found"}
    return dict(job)


def _run_jury_evaluation_job(job_id, backend, run_id=None):
    """Background worker that evaluates all results with the specified jury backend."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from jury import jury_review_single
        from db import BenchmarkDB
        import yaml

        db = BenchmarkDB(DB_PATH)

        # Load results that need judging
        if run_id:
            results = db.get_run_results(int(run_id))
        else:
            all_results = db.get_all_results()
            seen = {}
            for r in all_results:
                key = (r.get("agent"), r.get("task_id"))
                if key not in seen:
                    seen[key] = r
            results = list(seen.values())

        # Load task definitions for prompts
        tasks_dir = Path(__file__).resolve().parent / "tasks"
        task_prompts = {}
        task_ground_truths = {}
        for f in tasks_dir.glob("*.yaml"):
            try:
                with open(f) as fh:
                    task = yaml.safe_load(fh)
                if task and task.get("id"):
                    task_prompts[task["id"]] = task.get("prompt", "")
                    task_ground_truths[task["id"]] = task.get("ground_truth", "")
            except Exception:
                pass

        with _jury_jobs_lock:
            _jury_jobs[job_id]["total"] = len(results)

        completed = 0
        errors = 0

        for r in results:
            task_id = r.get("task_id", "")
            prompt = task_prompts.get(task_id, "(prompt not found)")
            ground_truth = task_ground_truths.get(task_id, "")

            try:
                verdicts = jury_review_single(r, prompt, jury_backend=backend, ground_truth=ground_truth)
                if verdicts and r.get("_db_id"):
                    for v in verdicts:
                        try:
                            db.save_jury_verdict(r["_db_id"], v)
                        except Exception:
                            pass
                completed += 1
            except Exception:
                errors += 1

            with _jury_jobs_lock:
                _jury_jobs[job_id]["completed"] = completed
                _jury_jobs[job_id]["errors"] = errors

        db.close()

        with _jury_jobs_lock:
            _jury_jobs[job_id]["status"] = "done"
            _jury_jobs[job_id]["completed"] = completed
            _jury_jobs[job_id]["errors"] = errors

    except Exception as e:
        with _jury_jobs_lock:
            _jury_jobs[job_id]["status"] = "error"
            _jury_jobs[job_id]["error"] = str(e)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/api/results":
            run_id = params.get("run_id", [None])[0]
            agent = params.get("agent", [None])[0]
            tier = params.get("tier", [None])[0]
            jury_model = params.get("jury_model", [None])[0]
            data = load_results(run_id=run_id, agent=agent, tier=tier, jury_model=jury_model)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif path == "/api/runs":
            data = load_runs()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif path == "/api/live-games":
            data = discover_live_games()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif re.match(r"^/api/live-games/([a-f0-9]+)/screenshot$", path):
            m = re.match(r"^/api/live-games/([a-f0-9]+)/screenshot$", path)
            cid = m.group(1)
            png_data = proxy_screenshot(cid)
            if png_data:
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-cache, no-store")
                self.send_header("Content-Length", str(len(png_data)))
                self.end_headers()
                self.wfile.write(png_data)
            else:
                self.send_response(404)
                self.end_headers()
        elif re.match(r"^/api/matches/\d+$", path):
            m = re.match(r"^/api/matches/(\d+)$", path)
            mid = m.group(1)
            data = load_match(mid)
            if data:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())
            else:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":"Match not found"}')
        elif path == "/api/battles" or re.match(r"^/api/battles/\d+$", path):
            tid = None
            m = re.match(r"^/api/battles/(\d+)$", path)
            if m:
                tid = m.group(1)
            data = load_battles(tournament_id=tid)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif path == "/api/jury-models":
            db = get_db()
            models = []
            if db:
                try:
                    models = db.get_distinct_jury_models()
                except Exception:
                    pass
                db.close()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(models).encode())
        elif path == "/api/settings":
            try:
                from config import load_settings, get_jury_backend
                data = load_settings()
                data["jury_backend"] = get_jury_backend()
            except Exception:
                data = {}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif path == "/api/jury/status":
            job_id = params.get("job_id", [None])[0]
            data = get_jury_job_status(job_id)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif path == "/api/live":
            data = load_live_state()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        elif path == "/":
            page = build_html()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page.encode())))
            self.end_headers()
            self.wfile.write(page.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length else b"{}"

        if path == "/api/settings":
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {}
            from config import load_settings, save_settings, VALID_EXECUTION_ENVIRONMENTS
            settings = load_settings()
            # Only allow updating known keys
            if "jury_backend" in data:
                settings["jury_backend"] = data["jury_backend"]
            if "execution_environment" in data:
                val = data["execution_environment"]
                if val in VALID_EXECUTION_ENVIRONMENTS:
                    settings["execution_environment"] = val
            save_settings(settings)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, **settings}).encode())
        elif path == "/api/jury/evaluate":
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {}

            backend = data.get("backend", "codex-xhigh")
            run_id = data.get("run_id")

            # Check if a job is already running
            with _jury_jobs_lock:
                running = any(j["status"] == "running" for j in _jury_jobs.values())
            if running:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "A jury evaluation is already running"}).encode())
                return

            job_id = str(uuid.uuid4())[:8]
            with _jury_jobs_lock:
                _jury_jobs[job_id] = {"status": "running", "total": 0, "completed": 0, "errors": 0}

            t = threading.Thread(target=_run_jury_evaluation_job, args=(job_id, backend, run_id), daemon=True)
            t.start()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"job_id": job_id}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Dashboard at http://0.0.0.0:{port}")
    print(f"Results dir: {RESULTS_DIR}")
    if DB_PATH.exists():
        print(f"Database: {DB_PATH}")
    else:
        print("No database found, using JSON files")
    server.serve_forever()


if __name__ == "__main__":
    main()
