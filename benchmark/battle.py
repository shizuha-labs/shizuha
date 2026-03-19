#!/usr/bin/env python3
"""Battle system — head-to-head matches between agent implementations.

Three modes:
  agent (default): Agents actually play chess — each LLM decides its own moves.
                   A single reference engine (claude-opus's implementation) handles
                   board state. Long-running containers avoid per-move startup cost.
  visual:          Agents play via vision — they see a PNG screenshot of the board
                   and make HTTP API calls to submit moves. All agents use the same
                   visual interface (screenshots) for a level playing field. Each
                   agent runs autonomously in a Docker container connected to a
                   shared chess server.
  random:          Legacy mode — random move selection tests engine correctness.

Usage:
    # Agent-played tournament (default)
    python battle.py --game chess --games-per-side 1

    # Specific matchup
    python battle.py --game chess --white shizuha --black claude-opus --games 2

    # Visual battle — 1v1 (vision-based)
    python battle.py --game chess --mode visual --white shizuha-claude --black claude-opus --games 1

    # Visual knockout tournament — all agents
    python battle.py --game chess --mode visual --time-control rapid15+10

    # Visual knockout with best-of-3 per matchup
    python battle.py --game chess --mode visual --format knockout --best-of 3

    # Visual round-robin
    python battle.py --game chess --mode visual --format roundrobin

    # Exclude agents from visual tournament
    python battle.py --game chess --mode visual --exclude codex codex-51max

    # List visual-capable agents
    python battle.py --game chess --mode visual --list

    # Legacy random-move mode
    python battle.py --game chess --mode random --games-per-side 5

    # List available agents/engines
    python battle.py --game chess --list
"""

import argparse
import importlib.util
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from uuid import uuid4

from config import AgentConfig, AGENTS, AGENT_IMAGE, LOGS_DIR
from db import BenchmarkDB

ARCHIVES_DIR = Path(__file__).resolve().parent / "archives"
REFERENCE_ENGINE_DIR = Path(__file__).resolve().parent / "reference_engine"
DOCKER_DIR = Path(__file__).resolve().parent / "docker"
CHESS_SERVER_IMAGE = "chess-server:latest"

# Task ID per game type
GAME_TASKS = {
    "chess": "hard-chess-engine",
}

# Time controls: (base_seconds, increment_per_move_seconds)
# Increment is added to your clock after every move you make.
TIME_CONTROLS = {
    "bullet1+0": (60, 0),        # 1 min, no increment
    "bullet2+1": (120, 1),       # 2 min + 1s/move
    "blitz3+2": (180, 2),        # 3 min + 2s/move
    "blitz5+3": (300, 3),        # 5 min + 3s/move
    "rapid10+5": (600, 5),       # 10 min + 5s/move
    "rapid15+10": (900, 10),     # 15 min + 10s/move
    "classical30+15": (1800, 15),  # 30 min + 15s/move
    "unlimited": (0, 0),         # no clock
}
# Shorthand aliases
TIME_CONTROLS["bullet"] = TIME_CONTROLS["bullet1+0"]
TIME_CONTROLS["blitz"] = TIME_CONTROLS["blitz3+2"]
TIME_CONTROLS["rapid"] = TIME_CONTROLS["rapid10+5"]
TIME_CONTROLS["classical"] = TIME_CONTROLS["classical30+15"]


def _get_host_ip() -> str:
    """Get the host IP address accessible from Docker containers.
    Used for --add-host host.docker.internal:<ip> on Linux."""
    try:
        result = subprocess.run(
            ["ip", "-4", "addr", "show", "docker0"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("inet "):
                return line.split()[1].split("/")[0]
    except Exception:
        pass
    return "172.17.0.1"  # Docker default bridge


# ─── Reference Engine ────────────────────────────────────────────────────────


class ReferenceEngine:
    """Loads the reference chess engine from battle/reference_engine/.

    Uses claude-opus's chess_engine.py as the single source of truth for
    board state, legal moves, and game-end conditions in agent-played mode.
    """

    def __init__(self):
        engine_path = REFERENCE_ENGINE_DIR / "chess_engine.py"
        if not engine_path.exists():
            raise FileNotFoundError(
                f"Reference engine not found at {engine_path}. "
                "Copy claude-opus's chess_engine.py to battle/reference_engine/"
            )

        module_name = f"reference_chess_engine_{id(self)}"
        spec = importlib.util.spec_from_file_location(module_name, engine_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        self._module = module

        if not hasattr(module, "Board"):
            raise AttributeError("No Board class in reference chess_engine.py")
        self._board_class = module.Board

        # Discover legal moves method
        candidates = (
            "legal_moves_algebraic", "legal_moves_notation", "legal_moves_list",
            "legal_moves", "generate_legal_moves",
        )
        test_board = self._board_class()
        self._legal_moves_method = None
        for method_name in candidates:
            fn = getattr(test_board, method_name, None)
            if fn is None:
                continue
            try:
                result = fn()
                if result and isinstance(result, (list, tuple)):
                    first = result[0]
                    if isinstance(first, str) and len(first) >= 4:
                        self._legal_moves_method = method_name
                        break
            except Exception:
                continue
        if not self._legal_moves_method:
            raise AttributeError(
                f"No legal_moves method found in reference Board class "
                f"(tried: {', '.join(candidates)})"
            )

    def create_board(self):
        return self._board_class()

    def get_legal_moves(self, board) -> list[str]:
        method = getattr(board, self._legal_moves_method)
        return method()

    def make_move(self, board, move: str) -> bool:
        return board.make_move(move)

    def is_checkmate(self, board) -> bool:
        return board.is_checkmate()

    def is_stalemate(self, board) -> bool:
        return board.is_stalemate()

    def get_fen(self, board) -> str:
        return board.to_fen()

    def from_fen(self, fen: str):
        return self._board_class.from_fen(fen)


# ─── Agent Session (long-running container) ──────────────────────────────────


class AgentSession:
    """Long-running Docker container for an agent to make chess moves.

    Starts the container once with auth setup + sleep infinity, then uses
    docker exec for each move query. Avoids per-move container startup cost.
    """

    def __init__(self, agent: AgentConfig):
        self.agent = agent
        self.container_name = f"battle_{agent.name}_{uuid4().hex[:8]}"
        self._started = False

    def start(self):
        """Start the container: run auth setup, then sleep infinity."""
        # Get the container config to reuse mounts and env setup
        cc = self.agent.container_config(prompt="__unused__", workspace="/tmp/battle")

        docker_cmd = [
            "docker", "run", "-d",
            "--name", self.container_name,
            # Allow containers to reach host services (e.g., LiteLLM proxy)
            "--add-host", f"host.docker.internal:{_get_host_ip()}",
        ]

        # Add mounts
        for host_path, container_path, mode in cc.mounts:
            docker_cmd.extend(["-v", f"{host_path}:{container_path}:{mode}"])

        # Add env vars (we need the auth env vars for the setup command)
        for key, val in cc.env.items():
            if key == "BENCH_PROMPT":
                continue  # skip the prompt — we pass it per-move
            docker_cmd.extend(["-e", f"{key}={val}"])

        docker_cmd.extend(["-w", "/tmp/battle"])
        docker_cmd.append(AGENT_IMAGE)

        # Extract the auth setup portion from the command.
        # The command is ["bash", "-c", "auth_setup && exec agent_cmd..."]
        # We want just the auth_setup part, followed by sleep infinity.
        original_cmd = " ".join(cc.command[2:]) if len(cc.command) > 2 else cc.command[-1]

        # Split on 'exec ' to separate auth setup from agent execution
        # Auth setup ends with "&& exec npx..." or "&& exec codex..." or "&& exec claude..."
        setup_cmd = original_cmd
        for marker in ("exec npx ", "exec codex ", "exec claude "):
            idx = setup_cmd.find(marker)
            if idx > 0:
                # Keep everything before the exec, strip trailing "&&" or whitespace
                setup_cmd = setup_cmd[:idx].rstrip().rstrip("&").rstrip()
                break
        else:
            # No exec found — just use sleep directly
            setup_cmd = "true"

        docker_cmd.extend([
            "bash", "-c",
            f"{setup_cmd} && sleep infinity"
        ])

        result = subprocess.run(
            docker_cmd,
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to start container {self.container_name}: {result.stderr}"
            )
        self._started = True

        # Wait a moment for auth setup to complete
        time.sleep(2)

    def get_move(
        self,
        fen: str,
        legal_moves: list[str],
        move_history: list[str],
        color: str,
        timeout: int = 60,
        your_clock: float = 0,
        opponent_clock: float = 0,
    ) -> str:
        """Ask the agent to pick a move via docker exec.

        Returns the chosen move string, or raises TimeoutError/ValueError.
        """
        if not self._started:
            raise RuntimeError("AgentSession not started")

        prompt = build_chess_prompt(
            fen, legal_moves, move_history, color,
            your_clock=your_clock, opponent_clock=opponent_clock,
        )
        move_cmd = self.agent.move_command()

        # docker exec with env var for the prompt
        docker_cmd = [
            "docker", "exec",
            "-e", f"MOVE_PROMPT={prompt}",
            self.container_name,
        ] + move_cmd

        try:
            result = subprocess.run(
                docker_cmd,
                capture_output=True, text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise TimeoutError(
                f"{self.agent.name} timed out after {timeout}s"
            )

        # Parse the agent's response for a valid move
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        move = _parse_move_from_output(stdout, legal_moves)
        if not move:
            # Try stderr too (some agents might output there)
            move = _parse_move_from_output(stderr, legal_moves)
        if not move:
            raise ValueError(
                f"{self.agent.name} returned no valid move. "
                f"stdout={stdout[-500:]}, stderr={stderr[-200:]}"
            )
        return move

    def stop(self):
        """Kill and remove the container."""
        if not self._started:
            return
        try:
            subprocess.run(
                ["docker", "kill", self.container_name],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass
        try:
            subprocess.run(
                ["docker", "rm", "-f", self.container_name],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass
        self._started = False

    def restart(self):
        """Stop and re-create the container with fresh auth tokens."""
        old_name = self.container_name
        self.stop()
        self.container_name = f"battle_{self.agent.name}_{uuid4().hex[:8]}"
        self._started = False
        self.start()

    def __del__(self):
        self.stop()


def refresh_codex_tokens_on_host():
    """Refresh all Codex OAuth tokens on the host disk.

    Called between tournament rounds to ensure containers get fresh tokens.
    Single-use refresh tokens mean each refresh consumes the old token.
    """
    import urllib.request
    import urllib.parse
    import urllib.error

    accounts_dir = Path(os.path.expanduser("~/.codex/accounts"))
    if not accounts_dir.is_dir():
        return

    refreshed = 0
    for f in sorted(accounts_dir.glob("*.json")):
        try:
            with open(f) as fh:
                data = json.load(fh)
            rt = data.get("tokens", {}).get("refresh_token")
            if not rt:
                continue
            body = urllib.parse.urlencode({
                "grant_type": "refresh_token",
                "refresh_token": rt,
                "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
            }).encode()
            req = urllib.request.Request(
                "https://auth.openai.com/oauth/token",
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
                data["tokens"]["access_token"] = result["access_token"]
                if "refresh_token" in result:
                    data["tokens"]["refresh_token"] = result["refresh_token"]
                with open(f, "w") as fh:
                    json.dump(data, fh)
                refreshed += 1
        except Exception:
            continue

    # Update auth.json with first working account
    if refreshed > 0:
        for f in sorted(accounts_dir.glob("*.json")):
            try:
                auth_path = os.path.expanduser("~/.codex/auth.json")
                shutil.copy(str(f), auth_path)
                break
            except Exception:
                continue
    return refreshed


def build_chess_prompt(
    fen: str,
    legal_moves: list[str],
    move_history: list[str],
    color: str,
    your_clock: float = 0,
    opponent_clock: float = 0,
) -> str:
    """Build a prompt asking the agent to choose a chess move."""
    history_str = ""
    if move_history:
        # Format as numbered move pairs
        pairs = []
        for i in range(0, len(move_history), 2):
            move_num = i // 2 + 1
            white_move = move_history[i]
            black_move = move_history[i + 1] if i + 1 < len(move_history) else ""
            if black_move:
                pairs.append(f"{move_num}. {white_move} {black_move}")
            else:
                pairs.append(f"{move_num}. {white_move}")
        history_str = " ".join(pairs)

    clock_str = ""
    if your_clock > 0 or opponent_clock > 0:
        if your_clock < 60:
            urgency = " CRITICAL: Under 1 minute! Play your first instinct immediately."
        elif your_clock < 180:
            urgency = " Low on time — decide quickly."
        else:
            urgency = ""
        clock_str = (
            f"\nClock: You={_fmt_clock(your_clock)}, "
            f"Opponent={_fmt_clock(opponent_clock)}.{urgency}"
        )

    return (
        f"You are playing chess as {color}. "
        f"Current position (FEN): {fen}\n"
        f"Move history: {history_str or '(game start)'}\n"
        f"Legal moves: {', '.join(legal_moves)}"
        f"{clock_str}\n\n"
        f"Reply with ONLY the move in algebraic notation "
        f"(e.g. e2e4, g1f3, e1g1 for castling). Nothing else."
    )


def _parse_move_from_output(output: str, legal_moves: list[str]) -> str | None:
    """Extract a valid move from agent output.

    Tries multiple strategies:
    0. Reconstruct from NDJSON streaming (type=content events)
    1. Parse as JSON and look for a 'move' or 'result' field
    2. Check if the entire output (stripped) is a legal move
    3. Search for any legal move in the output text
    """
    if not output:
        return None

    # Strategy 0: NDJSON streaming reconstruction
    # Shizuha/Codex output character-by-character: {"type":"content","text":"e",...}
    # Concatenate all content events to get the full response text
    content_parts = []
    has_ndjson = False
    for line in output.split("\n"):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
            if data.get("type") == "content" and "text" in data:
                content_parts.append(data["text"])
                has_ndjson = True
        except (json.JSONDecodeError, TypeError):
            pass

    if has_ndjson and content_parts:
        reconstructed = "".join(content_parts).strip()
        if reconstructed in legal_moves:
            return reconstructed
        found = _find_move_in_text(reconstructed, legal_moves)
        if found:
            return found

    # Strategy 1: JSON parsing — look for complete response fields
    for line in output.split("\n"):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
            for key in ("move", "result", "output", "text", "response", "content"):
                val = data.get(key)
                if isinstance(val, str) and len(val) >= 4:
                    val = val.strip()
                    if val in legal_moves:
                        return val
                    found = _find_move_in_text(val, legal_moves)
                    if found:
                        return found
        except (json.JSONDecodeError, TypeError):
            pass

    # Strategy 2: Entire output is a legal move
    clean = output.strip()
    if clean in legal_moves:
        return clean

    # Strategy 3: Search for any legal move in the text
    return _find_move_in_text(output, legal_moves)


def _find_move_in_text(text: str, legal_moves: list[str]) -> str | None:
    """Find a legal move mentioned in text. Prefers longer matches."""
    # Sort by length descending to prefer more specific matches (e.g. e7e8q over e7e8)
    for move in sorted(legal_moves, key=len, reverse=True):
        # Use word boundary to avoid false positives inside other words
        pattern = re.escape(move)
        if re.search(r'(?<![a-zA-Z0-9])' + pattern + r'(?![a-zA-Z0-9])', text):
            return move
    # Fallback: case-insensitive search
    text_lower = text.lower()
    for move in sorted(legal_moves, key=len, reverse=True):
        if move.lower() in text_lower:
            return move
    return None


# ─── Engine Adapter (legacy random mode) ─────────────────────────────────────


class EngineAdapter:
    """Wraps an agent's chess_engine.py for head-to-head play (random mode).

    Each engine is loaded into its own module namespace to avoid class conflicts
    when multiple agents define Board with different internals.
    """

    def __init__(self, agent_name: str, model: str, task_id: str = "hard-chess-engine"):
        self.agent_name = agent_name
        self.model = model
        self.task_id = task_id
        self._tmpdir = None
        self._module = None
        self._board_class = None
        self._legal_moves_method = None  # name of the legal moves method

        self._load()

    def _load(self):
        """Extract archive and load chess_engine module."""
        model_safe = self.model.replace("/", "-")
        archive_path = (
            ARCHIVES_DIR / f"{self.agent_name}_{model_safe}" / self.task_id / "passed.tar.gz"
        )
        if not archive_path.exists():
            raise FileNotFoundError(
                f"No passed archive for {self.agent_name} ({self.model}): {archive_path}"
            )

        self._tmpdir = tempfile.mkdtemp(prefix=f"battle_{self.agent_name}_")
        with tarfile.open(archive_path, "r:gz") as tar:
            tar.extractall(self._tmpdir, filter="data")

        engine_path = Path(self._tmpdir) / "chess_engine.py"
        if not engine_path.exists():
            raise FileNotFoundError(f"No chess_engine.py in archive for {self.agent_name}")

        # Load into unique module namespace
        module_name = f"chess_engine_{self.agent_name}_{id(self)}"
        spec = importlib.util.spec_from_file_location(module_name, engine_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        self._module = module

        # Find Board class
        if not hasattr(module, "Board"):
            raise AttributeError(f"No Board class in {self.agent_name}'s chess_engine.py")
        self._board_class = module.Board

        # Discover legal moves method — must return list of algebraic strings
        # Try each candidate and verify it returns strings (not tuples/ints)
        candidates = (
            "legal_moves_algebraic", "legal_moves_notation", "legal_moves_list",
            "legal_moves", "generate_legal_moves",
        )
        test_board = self._board_class()
        for method_name in candidates:
            fn = getattr(test_board, method_name, None)
            if fn is None:
                continue
            try:
                result = fn()
                if result and isinstance(result, (list, tuple)):
                    first = result[0]
                    if isinstance(first, str) and len(first) >= 4:
                        self._legal_moves_method = method_name
                        break
            except Exception:
                continue
        if not self._legal_moves_method:
            raise AttributeError(
                f"No legal_moves method found in {self.agent_name}'s Board class "
                f"(tried: {', '.join(candidates)})"
            )

    def label(self) -> str:
        return f"{self.agent_name} ({self.model})"

    def create_board(self):
        """Create a new board in starting position."""
        return self._board_class()

    def get_legal_moves(self, board) -> list[str]:
        """Get legal moves in algebraic notation."""
        method = getattr(board, self._legal_moves_method)
        return method()

    def make_move(self, board, move: str) -> bool:
        """Execute a move on the board. Returns True if successful."""
        return board.make_move(move)

    def is_checkmate(self, board) -> bool:
        return board.is_checkmate()

    def is_stalemate(self, board) -> bool:
        return board.is_stalemate()

    def get_fen(self, board) -> str:
        return board.to_fen()

    def from_fen(self, fen: str):
        """Create a board from FEN string."""
        return self._board_class.from_fen(fen)

    def cleanup(self):
        """Remove temp directory."""
        if self._tmpdir:
            shutil.rmtree(self._tmpdir, ignore_errors=True)

    def __del__(self):
        self.cleanup()

    def __repr__(self):
        return f"EngineAdapter({self.agent_name}, {self.model})"


# ─── Match Result ────────────────────────────────────────────────────────────


@dataclass
class MatchResult:
    white_agent: str
    white_model: str
    black_agent: str
    black_model: str
    result: str  # "white", "black", "draw", "white_forfeit", "black_forfeit"
    reason: str  # "checkmate", "stalemate", "50-move", "move_limit", "timeout", "illegal", "crash"
    move_count: int
    moves: list[str] = field(default_factory=list)
    final_fen: str = ""
    duration_ms: int = 0
    error: str = ""
    move_details: list[dict] = field(default_factory=list)
    agent_telemetry: dict = field(default_factory=dict)


def _match_result_to_dict(result: MatchResult) -> dict:
    """Convert a MatchResult to a dict suitable for db.save_match()."""
    d = {
        "white_agent": result.white_agent,
        "white_model": result.white_model,
        "black_agent": result.black_agent,
        "black_model": result.black_model,
        "result": result.result,
        "reason": result.reason,
        "move_count": result.move_count,
        "moves": result.moves,
        "final_fen": result.final_fen,
        "duration_ms": result.duration_ms,
        "played_at": datetime.now(timezone.utc).isoformat(),
    }
    if result.move_details:
        d["move_details"] = result.move_details
    if result.agent_telemetry:
        d["agent_telemetry"] = result.agent_telemetry
    return d


# ─── Agent-Played Match ─────────────────────────────────────────────────────


def play_agent_match(
    engine: ReferenceEngine,
    white: AgentSession,
    black: AgentSession,
    max_moves: int = 200,
    move_timeout: int = 60,
    time_control: tuple[int, int] = (0, 0),
    verbose: bool = True,
    log_buffer: StringIO | None = None,
) -> MatchResult:
    """Play a single game where agents choose their own moves.

    Uses the reference engine for board state management and legality checking.
    Each agent is queried via docker exec for move selection.

    Args:
        time_control: (base_seconds, increment_seconds) per player.
                      base=0 means unlimited (per-move timeout only).
                      increment is added to the clock after each move.
        log_buffer: If provided, write verbose output here instead of stdout.
    """
    def _log(msg: str):
        if verbose:
            if log_buffer is not None:
                log_buffer.write(msg + "\n")
            else:
                print(msg)

    base_time, increment = time_control
    start_time = time.monotonic()
    moves_played = []

    # Chess clocks: remaining time per side (seconds)
    clocks = {"white": float(base_time), "black": float(base_time)}
    use_clock = base_time > 0

    try:
        board = engine.create_board()
    except Exception as e:
        return MatchResult(
            white_agent=white.agent.name, white_model=white.agent.model,
            black_agent=black.agent.name, black_model=black.agent.model,
            result="draw", reason="crash", move_count=0,
            error=f"Board creation failed: {e}",
            duration_ms=int((time.monotonic() - start_time) * 1000),
        )

    for move_num in range(1, max_moves + 1):
        color = "white" if move_num % 2 == 1 else "black"
        session = white if color == "white" else black

        # Get legal moves from reference engine
        try:
            legal = engine.get_legal_moves(board)
        except Exception as e:
            elapsed = int((time.monotonic() - start_time) * 1000)
            return MatchResult(
                white_agent=white.agent.name, white_model=white.agent.model,
                black_agent=black.agent.name, black_model=black.agent.model,
                result="draw", reason="crash", move_count=len(moves_played),
                moves=moves_played, final_fen=_safe_ref_fen(engine, board),
                duration_ms=elapsed,
                error=f"Reference engine get_legal_moves crashed: {e}",
            )

        # No legal moves — check for checkmate or stalemate
        if not legal:
            elapsed = int((time.monotonic() - start_time) * 1000)
            try:
                if engine.is_checkmate(board):
                    winner = "black" if color == "white" else "white"
                    return MatchResult(
                        white_agent=white.agent.name, white_model=white.agent.model,
                        black_agent=black.agent.name, black_model=black.agent.model,
                        result=winner, reason="checkmate",
                        move_count=len(moves_played), moves=moves_played,
                        final_fen=_safe_ref_fen(engine, board),
                        duration_ms=elapsed,
                    )
            except Exception:
                pass
            return MatchResult(
                white_agent=white.agent.name, white_model=white.agent.model,
                black_agent=black.agent.name, black_model=black.agent.model,
                result="draw", reason="stalemate",
                move_count=len(moves_played), moves=moves_played,
                final_fen=_safe_ref_fen(engine, board),
                duration_ms=elapsed,
            )

        # Determine timeout for this move: min(per-move timeout, remaining clock)
        if use_clock:
            remaining = clocks[color]
            if remaining <= 0:
                # Flag fall — already out of time
                elapsed = int((time.monotonic() - start_time) * 1000)
                forfeit = f"{color}_forfeit"
                return MatchResult(
                    white_agent=white.agent.name, white_model=white.agent.model,
                    black_agent=black.agent.name, black_model=black.agent.model,
                    result=forfeit, reason="flag_fall",
                    move_count=len(moves_played), moves=moves_played,
                    final_fen=_safe_ref_fen(engine, board),
                    duration_ms=elapsed,
                    error=f"{color} ran out of time ({base_time}s clock)",
                )
            effective_timeout = min(move_timeout, int(remaining) + 1)
        else:
            effective_timeout = move_timeout

        # Ask agent for a move
        fen = engine.get_fen(board)
        opponent_color = "black" if color == "white" else "white"
        move_start = time.monotonic()
        try:
            move = session.get_move(
                fen, legal, moves_played, color, effective_timeout,
                your_clock=clocks[color] if use_clock else 0,
                opponent_clock=clocks[opponent_color] if use_clock else 0,
            )
        except TimeoutError as e:
            move_elapsed = time.monotonic() - move_start
            if use_clock:
                clocks[color] -= move_elapsed
            elapsed = int((time.monotonic() - start_time) * 1000)
            forfeit = f"{color}_forfeit"
            reason = "flag_fall" if (use_clock and clocks[color] <= 0) else "timeout"
            return MatchResult(
                white_agent=white.agent.name, white_model=white.agent.model,
                black_agent=black.agent.name, black_model=black.agent.model,
                result=forfeit, reason=reason,
                move_count=len(moves_played), moves=moves_played,
                final_fen=_safe_ref_fen(engine, board),
                duration_ms=elapsed,
                error=str(e),
            )
        except Exception as e:
            move_elapsed = time.monotonic() - move_start
            if use_clock:
                clocks[color] -= move_elapsed
            elapsed = int((time.monotonic() - start_time) * 1000)
            forfeit = f"{color}_forfeit"
            return MatchResult(
                white_agent=white.agent.name, white_model=white.agent.model,
                black_agent=black.agent.name, black_model=black.agent.model,
                result=forfeit, reason="crash",
                move_count=len(moves_played), moves=moves_played,
                final_fen=_safe_ref_fen(engine, board),
                duration_ms=elapsed,
                error=f"{color} move query failed: {e}",
            )

        move_elapsed = time.monotonic() - move_start

        # Deduct from chess clock, then add increment
        if use_clock:
            clocks[color] -= move_elapsed
            if clocks[color] <= 0:
                # Flag fall after move — the move still counts but clock expired
                elapsed = int((time.monotonic() - start_time) * 1000)
                forfeit = f"{color}_forfeit"
                return MatchResult(
                    white_agent=white.agent.name, white_model=white.agent.model,
                    black_agent=black.agent.name, black_model=black.agent.model,
                    result=forfeit, reason="flag_fall",
                    move_count=len(moves_played), moves=moves_played,
                    final_fen=_safe_ref_fen(engine, board),
                    duration_ms=elapsed,
                    error=f"{color} clock expired ({clocks[color]:.1f}s remaining)",
                )
            # Add increment after successful move
            clocks[color] += increment

        # Validate move is legal
        if move not in legal:
            elapsed = int((time.monotonic() - start_time) * 1000)
            forfeit = f"{color}_forfeit"
            return MatchResult(
                white_agent=white.agent.name, white_model=white.agent.model,
                black_agent=black.agent.name, black_model=black.agent.model,
                result=forfeit, reason="illegal",
                move_count=len(moves_played), moves=moves_played,
                final_fen=_safe_ref_fen(engine, board),
                duration_ms=elapsed,
                error=f"{color} played illegal move '{move}'",
            )

        # Execute move on reference engine
        engine.make_move(board, move)
        moves_played.append(move)

        side_label = "W" if color == "white" else "B"
        clock_str = ""
        if use_clock:
            wc = clocks["white"]
            bc = clocks["black"]
            clock_str = f" [W:{_fmt_clock(wc)} B:{_fmt_clock(bc)}]"
        _log(
            f"    {move_num}. {side_label}: {move} "
            f"({session.agent.name}, {move_elapsed:.1f}s){clock_str}"
        )

        # Check 50-move rule
        try:
            if hasattr(board, "halfmove_clock") and board.halfmove_clock >= 100:
                elapsed = int((time.monotonic() - start_time) * 1000)
                return MatchResult(
                    white_agent=white.agent.name, white_model=white.agent.model,
                    black_agent=black.agent.name, black_model=black.agent.model,
                    result="draw", reason="50-move",
                    move_count=len(moves_played), moves=moves_played,
                    final_fen=_safe_ref_fen(engine, board),
                    duration_ms=elapsed,
                )
        except Exception:
            pass

    # Move limit reached
    elapsed = int((time.monotonic() - start_time) * 1000)
    return MatchResult(
        white_agent=white.agent.name, white_model=white.agent.model,
        black_agent=black.agent.name, black_model=black.agent.model,
        result="draw", reason="move_limit",
        move_count=len(moves_played), moves=moves_played,
        final_fen=_safe_ref_fen(engine, board),
        duration_ms=elapsed,
    )


def _fmt_clock(seconds: float) -> str:
    """Format clock time as M:SS."""
    if seconds <= 0:
        return "0:00"
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m}:{s:02d}"


def _safe_ref_fen(engine: ReferenceEngine, board) -> str:
    try:
        return engine.get_fen(board)
    except Exception:
        return ""


# ─── Visual Chess Battle ─────────────────────────────────────────────────────


class VisualAgentSession:
    """Long-running Docker container for a visual chess agent.

    Unlike AgentSession (which uses docker exec per move), the visual agent
    runs autonomously — it takes screenshots and makes HTTP calls on its own.
    We just start it and monitor the chess server for game progress.
    """

    def __init__(self, agent: AgentConfig, network: str, prompt: str, workspace: str):
        self.agent = agent
        self.network = network
        self.container_name = f"visual_{agent.name}_{uuid4().hex[:8]}"
        self._started = False
        self._prompt = prompt
        self._workspace = workspace

    def start(self):
        """Start the agent container connected to the chess battle network."""
        cc = self.agent.visual_container_config(
            prompt=self._prompt,
            workspace=self._workspace,
            server_hostname="chess-server",
        )

        docker_cmd = [
            "docker", "run", "-d",
            "--name", self.container_name,
            "--network", self.network,
            "--add-host", f"host.docker.internal:{_get_host_ip()}",
        ]

        # Add mounts
        for host_path, container_path, mode in cc.mounts:
            docker_cmd.extend(["-v", f"{host_path}:{container_path}:{mode}"])

        # Add env vars
        for key, val in cc.env.items():
            docker_cmd.extend(["-e", f"{key}={val}"])

        docker_cmd.extend(["-w", "/workspace"])
        docker_cmd.append(AGENT_IMAGE)
        docker_cmd.extend(cc.command)

        result = subprocess.run(
            docker_cmd,
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to start visual agent {self.container_name}: {result.stderr}"
            )
        self._started = True

    def is_running(self) -> bool:
        """Check if the container is still running."""
        if not self._started:
            return False
        try:
            result = subprocess.run(
                ["docker", "inspect", "-f", "{{.State.Running}}", self.container_name],
                capture_output=True, text=True, timeout=10,
            )
            return result.stdout.strip() == "true"
        except Exception:
            return False

    def get_logs(self, tail: int = 50) -> str:
        """Get container logs. Use tail=0 to get all logs."""
        try:
            cmd = ["docker", "logs"]
            if tail > 0:
                cmd.extend(["--tail", str(tail)])
            cmd.append(self.container_name)
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30,
            )
            return result.stdout + result.stderr
        except Exception:
            return ""

    def stop(self):
        """Kill and remove the container."""
        if not self._started:
            return
        try:
            subprocess.run(
                ["docker", "kill", self.container_name],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass
        try:
            subprocess.run(
                ["docker", "rm", "-f", self.container_name],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass
        self._started = False

    def __del__(self):
        self.stop()


def build_visual_chess_prompt(color: str, server_hostname: str = "chess-server") -> str:
    """Build the one-time prompt for a chess agent playing on the visual server.

    All agents use the same vision-based approach: take a screenshot (PNG),
    read it to see the board, then make moves via HTTP API. This ensures a
    level playing field — every agent sees the same visual interface.

    Args:
        color: "white" or "black"
        server_hostname: Docker hostname of the chess server
    """
    is_white = color == "white"
    base_url = f"http://{server_hostname}:5000"

    return f"""You are playing a chess game as {color.upper()}. You will interact with a chess server to play your moves.

## How to Play

1. **Take a screenshot** of the board to see the current position:
   ```
   curl -s {base_url}/screenshot -o /tmp/board.png
   ```
   Then read the PNG file to see the board visually.

2. **Make a move** by sending an HTTP POST request:
   ```
   curl -s -X POST {base_url}/api/move -H "Content-Type: application/json" -d '{{"move":"e2e4"}}'
   ```
   Moves use coordinate notation: source square + destination square (e.g., e2e4, g1f3, e1g1 for kingside castling).
   For pawn promotion, append the piece letter: e7e8q (promote to queen).

3. **Check if it's your turn** by looking at the screenshot — the active player's clock is highlighted green.
   If it's not your turn, wait a few seconds and take another screenshot.

## Your Role

- You are playing as **{color.upper()}**.
- {"You move FIRST. Start by taking a screenshot, then make your opening move." if is_white else "You move SECOND. The white player moves first. Start by taking a screenshot to see if white has moved yet. If not, wait a few seconds and check again."}
- After making a move, wait for your opponent to respond. Take periodic screenshots (every 5-10 seconds) to check for their move.
- The board image shows: piece positions, whose turn it is, chess clocks, and check/checkmate status.

## Game Loop

Repeat this cycle until the game ends:
1. Take a screenshot (`curl -s {base_url}/screenshot -o /tmp/board.png`) and read it
2. If it's your turn, analyze the position and make a move
3. If it's not your turn, wait 5 seconds then take another screenshot
4. If the screenshot shows "Checkmate", "Stalemate", or "Flag fall", the game is over — stop playing

## Strategy Tips

- Think carefully about each move. Consider piece safety, center control, and king safety.
- Watch the clock — if you're low on time, make moves faster.
- Use standard opening principles: control the center, develop pieces, castle early.
- Look for tactical opportunities: forks, pins, skewers, discovered attacks.

## Important

- Use ONLY the screenshot for game information. The visual board is your primary interface.
- Use coordinate notation for moves (e2e4, NOT e4 or Nf3).
- If a move is rejected (illegal), the server will return an error with the list of legal moves.
- Keep playing until the game ends. Do not stop early.
- Do NOT use any other tools or commands besides curl and reading the PNG file.

Begin now — take your first screenshot!"""


def _build_chess_server_image() -> None:
    """Build the chess-server Docker image if not already present."""
    # Check if image exists
    result = subprocess.run(
        ["docker", "image", "inspect", CHESS_SERVER_IMAGE],
        capture_output=True, timeout=10,
    )
    if result.returncode == 0:
        print(f"  Chess server image '{CHESS_SERVER_IMAGE}' already exists")
        return

    print(f"  Building chess server image '{CHESS_SERVER_IMAGE}'...")
    dockerfile = DOCKER_DIR / "Dockerfile.chess-server"
    context = REFERENCE_ENGINE_DIR

    result = subprocess.run(
        ["docker", "build", "-t", CHESS_SERVER_IMAGE, "-f", str(dockerfile), str(context)],
        capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to build chess server image:\n{result.stderr}")
    print(f"  Chess server image built successfully")


def _poll_chess_server(url: str, timeout: float = 10) -> dict | None:
    """Poll the chess server's /api/state endpoint. Returns state dict or None."""
    import urllib.request
    import urllib.error
    try:
        req = urllib.request.Request(f"{url}/api/state")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _parse_agent_ndjson(logs: str, agent_name: str) -> dict:
    """Parse NDJSON telemetry events from agent container logs.

    Shizuha agents emit NDJSON events (turn_start, tool_start, tool_complete,
    turn_complete). Non-shizuha agents won't have these events.

    Returns a summary dict with per-turn breakdowns.
    """
    result = {"agent": agent_name, "has_telemetry": False, "total_turns": 0, "turns": []}
    if not logs:
        return result

    events = []
    for line in logs.split("\n"):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
            if isinstance(event, dict) and "type" in event:
                events.append(event)
        except (json.JSONDecodeError, TypeError):
            continue

    if not events:
        return result

    result["has_telemetry"] = True

    # Group events into turns
    current_turn = None
    turn_index = 0
    for event in events:
        etype = event.get("type", "")

        if etype == "turn_start":
            current_turn = {
                "turn_index": turn_index,
                "start_ms": event.get("timestamp_ms", 0),
                "duration_ms": 0,
                "tools": [],
                "tokens": {"input": 0, "output": 0, "cache_creation": 0, "cache_read": 0},
            }
            turn_index += 1

        elif etype == "tool_start" and current_turn is not None:
            # Track tool start for pairing with tool_complete
            pass

        elif etype == "tool_complete" and current_turn is not None:
            current_turn["tools"].append({
                "name": event.get("toolName", event.get("tool", event.get("name", "unknown"))),
                "duration_ms": event.get("durationMs", event.get("duration_ms", 0)),
            })

        elif etype == "turn_complete":
            if current_turn is not None:
                duration = event.get("durationMs", event.get("duration_ms", 0))
                current_turn["duration_ms"] = duration
                # Extract token usage — shizuha uses flat fields, not nested usage{}
                current_turn["tokens"] = {
                    "input": event.get("inputTokens", event.get("input_tokens", 0)),
                    "output": event.get("outputTokens", event.get("output_tokens", 0)),
                    "cache_creation": event.get("cacheCreationInputTokens", event.get("cache_creation_input_tokens", 0)),
                    "cache_read": event.get("cacheReadInputTokens", event.get("cache_read_input_tokens", 0)),
                }
                result["turns"].append(current_turn)
                current_turn = None

    # Handle unclosed turn
    if current_turn is not None:
        result["turns"].append(current_turn)

    result["total_turns"] = len(result["turns"])
    return result


def play_visual_match(
    white_agent: AgentConfig,
    black_agent: AgentConfig,
    time_control: tuple[int, int] = (300, 3),
    max_game_time: int = 1800,
    stall_timeout: int = 300,
    verbose: bool = True,
    host_port: int = 0,
) -> MatchResult:
    """Play a single visual chess game.

    Both agents run autonomously in Docker containers, connected to a shared
    chess server via a Docker network. The host monitors game progress by
    polling /api/state.

    Args:
        time_control: (base_seconds, increment_seconds) for chess clocks
        max_game_time: Maximum total wall-clock time for the game
        stall_timeout: Forfeit if no moves happen within this many seconds
        host_port: Port to expose on host for browser debugging (0 = auto-assign)
    """
    base_time, increment = time_control
    network_name = f"chess-battle-{uuid4().hex[:12]}"
    server_container = f"chess-server-{uuid4().hex[:8]}"
    start_time = time.monotonic()

    white_session = None
    black_session = None

    def _log(msg: str):
        if verbose:
            print(msg)

    def _cleanup():
        """Stop all containers and remove the network."""
        for session in [white_session, black_session]:
            if session:
                try:
                    session.stop()
                except Exception:
                    pass
        # Stop chess server
        try:
            subprocess.run(
                ["docker", "kill", server_container],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass
        try:
            subprocess.run(
                ["docker", "rm", "-f", server_container],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass
        # Remove network
        try:
            subprocess.run(
                ["docker", "network", "rm", network_name],
                capture_output=True, timeout=10,
            )
        except Exception:
            pass

    try:
        # 1. Create Docker network
        _log(f"  Creating network: {network_name}")
        result = subprocess.run(
            ["docker", "network", "create", network_name],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to create network: {result.stderr}")

        # 2. Start chess server
        _log(f"  Starting chess server...")
        port_arg = ["-p", f"{host_port}:5000"] if host_port else ["-p", "5000"]
        server_cmd = [
            "docker", "run", "-d",
            "--name", server_container,
            "--network", network_name,
            "--network-alias", "chess-server",
        ] + port_arg + [
            "-v", f"{REFERENCE_ENGINE_DIR}:/app:ro",
            "-e", f"BASE_TIME={base_time}",
            "-e", f"INCREMENT={increment}",
            "-e", f"WHITE_NAME={white_agent.name}",
            "-e", f"BLACK_NAME={black_agent.name}",
            CHESS_SERVER_IMAGE,
        ]

        result = subprocess.run(
            server_cmd, capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to start chess server: {result.stderr}")

        # Get the mapped host port for monitoring
        port_result = subprocess.run(
            ["docker", "port", server_container, "5000"],
            capture_output=True, text=True, timeout=10,
        )
        host_url = None
        if port_result.returncode == 0:
            port_line = port_result.stdout.strip().split("\n")[0]
            host_url = f"http://{port_line}"
            _log(f"  Chess server accessible at: {host_url}")

        # Wait for server to be ready
        _log(f"  Waiting for chess server to be ready...")
        server_ready = False
        for _ in range(20):
            if host_url and _poll_chess_server(host_url):
                server_ready = True
                break
            time.sleep(1)
        if not server_ready:
            raise RuntimeError("Chess server failed to start within 20 seconds")
        _log(f"  Chess server ready!")

        # 3. Create workspaces
        white_workspace = tempfile.mkdtemp(prefix="visual_white_")
        black_workspace = tempfile.mkdtemp(prefix="visual_black_")

        # 4. Start white agent
        white_prompt = build_visual_chess_prompt("white", "chess-server")
        white_session = VisualAgentSession(
            white_agent, network_name, white_prompt, white_workspace,
        )
        _log(f"  Starting white agent: {white_agent.name}")
        white_session.start()
        _log(f"    Container: {white_session.container_name}")

        # 5. Brief delay, then start black agent
        time.sleep(3)

        black_prompt = build_visual_chess_prompt("black", "chess-server")
        black_session = VisualAgentSession(
            black_agent, network_name, black_prompt, black_workspace,
        )
        _log(f"  Starting black agent: {black_agent.name}")
        black_session.start()
        _log(f"    Container: {black_session.container_name}")

        # 6. Monitor loop
        _log(f"\n  Monitoring game progress...")
        last_move_count = 0
        last_move_time = time.monotonic()
        match_result = None
        final_state = None

        while True:
            time.sleep(3)

            elapsed = time.monotonic() - start_time

            # Check total timeout
            if elapsed > max_game_time:
                _log(f"\n  Total game time exceeded ({max_game_time}s)")
                final_state = _poll_chess_server(host_url)
                moves = final_state.get("moves", []) if final_state else []
                match_result = MatchResult(
                    white_agent=white_agent.name, white_model=white_agent.model,
                    black_agent=black_agent.name, black_model=black_agent.model,
                    result="draw", reason="timeout",
                    move_count=len(moves), moves=moves,
                    final_fen=final_state.get("fen", "") if final_state else "",
                    duration_ms=int(elapsed * 1000),
                    error=f"Game exceeded {max_game_time}s total time limit",
                )
                break

            # Poll game state
            state = _poll_chess_server(host_url)
            if not state:
                # Server might have crashed
                if not subprocess.run(
                    ["docker", "inspect", server_container],
                    capture_output=True, timeout=10,
                ).returncode == 0:
                    match_result = MatchResult(
                        white_agent=white_agent.name, white_model=white_agent.model,
                        black_agent=black_agent.name, black_model=black_agent.model,
                        result="draw", reason="crash",
                        move_count=0, duration_ms=int(elapsed * 1000),
                        error="Chess server stopped responding",
                    )
                    break
                continue

            move_count = state.get("move_count", 0)
            game_over = state.get("game_over", False)

            # Detect new moves
            if move_count > last_move_count:
                moves = state.get("moves", [])
                new_moves = moves[last_move_count:]
                for i, m in enumerate(new_moves):
                    move_num = last_move_count + i + 1
                    side = "W" if move_num % 2 == 1 else "B"
                    clocks = state.get("clocks", {})
                    wc = clocks.get("white", 0)
                    bc = clocks.get("black", 0)
                    clock_str = f" [W:{_fmt_clock(wc)} B:{_fmt_clock(bc)}]"
                    _log(f"    {(move_num + 1) // 2}. {side}: {m}{clock_str}")
                last_move_count = move_count
                last_move_time = time.monotonic()

            # Check game over
            if game_over:
                final_state = state
                game_result = state.get("game_result", "draw")
                game_reason = state.get("game_reason", "unknown")
                moves = state.get("moves", [])
                fen = state.get("fen", "")

                # Map server results to MatchResult format
                if game_reason == "flag_fall":
                    loser = "white" if game_result == "black" else "black"
                    result_str = f"{loser}_forfeit"
                    reason = "flag_fall"
                elif game_reason == "checkmate":
                    result_str = game_result  # "white" or "black"
                    reason = "checkmate"
                elif game_reason in ("stalemate", "50-move"):
                    result_str = "draw"
                    reason = game_reason
                else:
                    result_str = game_result
                    reason = game_reason

                _log(f"\n  Game over: {result_str} ({reason}), {len(moves)} moves")
                match_result = MatchResult(
                    white_agent=white_agent.name, white_model=white_agent.model,
                    black_agent=black_agent.name, black_model=black_agent.model,
                    result=result_str, reason=reason,
                    move_count=len(moves), moves=moves, final_fen=fen,
                    duration_ms=int(elapsed * 1000),
                )
                break

            # Check stall (no moves for stall_timeout seconds)
            stall_elapsed = time.monotonic() - last_move_time
            if stall_elapsed > stall_timeout:
                final_state = state
                turn = state.get("turn", "unknown")
                forfeit_color = turn
                moves = state.get("moves", [])
                _log(f"\n  Stall detected: no moves for {stall_timeout}s, {turn} forfeits")
                match_result = MatchResult(
                    white_agent=white_agent.name, white_model=white_agent.model,
                    black_agent=black_agent.name, black_model=black_agent.model,
                    result=f"{forfeit_color}_forfeit", reason="stall",
                    move_count=len(moves), moves=moves,
                    final_fen=state.get("fen", ""),
                    duration_ms=int(elapsed * 1000),
                    error=f"No moves for {stall_timeout}s, {turn} forfeits",
                )
                break

            # Check if agents are still running
            white_running = white_session.is_running()
            black_running = black_session.is_running()
            if not white_running and not black_running:
                final_state = state
                moves = state.get("moves", [])
                _log(f"\n  Both agents stopped!")
                match_result = MatchResult(
                    white_agent=white_agent.name, white_model=white_agent.model,
                    black_agent=black_agent.name, black_model=black_agent.model,
                    result="draw", reason="crash",
                    move_count=len(moves), moves=moves,
                    final_fen=state.get("fen", ""),
                    duration_ms=int(elapsed * 1000),
                    error="Both agents stopped unexpectedly",
                )
                break
            if not white_running and not game_over:
                final_state = state
                moves = state.get("moves", [])
                _log(f"\n  White agent stopped!")
                match_result = MatchResult(
                    white_agent=white_agent.name, white_model=white_agent.model,
                    black_agent=black_agent.name, black_model=black_agent.model,
                    result="white_forfeit", reason="crash",
                    move_count=len(moves), moves=moves,
                    final_fen=state.get("fen", ""),
                    duration_ms=int(elapsed * 1000),
                    error="White agent container stopped",
                )
                break
            if not black_running and not game_over:
                final_state = state
                moves = state.get("moves", [])
                _log(f"\n  Black agent stopped!")
                match_result = MatchResult(
                    white_agent=white_agent.name, white_model=white_agent.model,
                    black_agent=black_agent.name, black_model=black_agent.model,
                    result="black_forfeit", reason="crash",
                    move_count=len(moves), moves=moves,
                    final_fen=state.get("fen", ""),
                    duration_ms=int(elapsed * 1000),
                    error="Black agent container stopped",
                )
                break

        # ── Capture telemetry before cleanup ──
        # Grab move_details from chess server state
        if final_state and final_state.get("move_details"):
            match_result.move_details = final_state["move_details"]

        # Capture agent logs for NDJSON telemetry (before containers are destroyed)
        try:
            agent_telemetry = {}
            if white_session:
                white_logs = white_session.get_logs(tail=0)
                agent_telemetry["white"] = _parse_agent_ndjson(white_logs, white_agent.name)
            if black_session:
                black_logs = black_session.get_logs(tail=0)
                agent_telemetry["black"] = _parse_agent_ndjson(black_logs, black_agent.name)
            if agent_telemetry:
                match_result.agent_telemetry = agent_telemetry
        except Exception:
            pass  # telemetry capture is best-effort

        return match_result

    except Exception as e:
        elapsed = int((time.monotonic() - start_time) * 1000)
        return MatchResult(
            white_agent=white_agent.name, white_model=white_agent.model,
            black_agent=black_agent.name, black_model=black_agent.model,
            result="draw", reason="crash", move_count=0,
            duration_ms=elapsed, error=f"Visual match setup failed: {e}",
        )
    finally:
        _cleanup()
        # Cleanup temp workspaces
        for d in [white_workspace, black_workspace]:
            try:
                shutil.rmtree(d, ignore_errors=True)
            except Exception:
                pass


def _reset_chess_server(host_url: str) -> bool:
    """Reset the chess server for a new game. Returns True on success."""
    import urllib.request
    import urllib.error
    try:
        req = urllib.request.Request(
            f"{host_url}/api/reset",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("ok", False)
    except Exception:
        return False


# ─── Random-Move Match (legacy) ─────────────────────────────────────────────


def play_random_match(
    white: EngineAdapter,
    black: EngineAdapter,
    max_moves: int = 200,
    seed: int | None = None,
) -> MatchResult:
    """Play a single game between two engines using random move selection.

    Legacy mode: tests rule correctness, not playing strength.
    """
    rng = random.Random(seed)
    start_time = time.monotonic()
    moves_played = []

    try:
        w_board = white.create_board()
        b_board = black.create_board()
    except Exception as e:
        return MatchResult(
            white_agent=white.agent_name, white_model=white.model,
            black_agent=black.agent_name, black_model=black.model,
            result="draw", reason="crash", move_count=0,
            error=f"Board creation failed: {e}",
            duration_ms=int((time.monotonic() - start_time) * 1000),
        )

    engines = [white, black]
    boards = [w_board, b_board]
    labels = ["white", "black"]

    for move_num in range(1, max_moves + 1):
        side = 0 if (move_num % 2 == 1) else 1
        current_engine = engines[side]
        current_board = boards[side]
        other_engine = engines[1 - side]
        other_board = boards[1 - side]

        try:
            legal = current_engine.get_legal_moves(current_board)
        except Exception as e:
            elapsed = int((time.monotonic() - start_time) * 1000)
            return MatchResult(
                white_agent=white.agent_name, white_model=white.model,
                black_agent=black.agent_name, black_model=black.model,
                result=f"{labels[side]}_crash", reason="crash",
                move_count=len(moves_played), moves=moves_played,
                final_fen=_safe_fen(other_engine, other_board),
                duration_ms=elapsed,
                error=f"{labels[side]} get_legal_moves crashed: {e}",
            )

        if not legal:
            elapsed = int((time.monotonic() - start_time) * 1000)
            try:
                if current_engine.is_checkmate(current_board):
                    winner = "black" if side == 0 else "white"
                    return MatchResult(
                        white_agent=white.agent_name, white_model=white.model,
                        black_agent=black.agent_name, black_model=black.model,
                        result=winner, reason="checkmate",
                        move_count=len(moves_played), moves=moves_played,
                        final_fen=_safe_fen(current_engine, current_board),
                        duration_ms=elapsed,
                    )
                elif current_engine.is_stalemate(current_board):
                    return MatchResult(
                        white_agent=white.agent_name, white_model=white.model,
                        black_agent=black.agent_name, black_model=black.model,
                        result="draw", reason="stalemate",
                        move_count=len(moves_played), moves=moves_played,
                        final_fen=_safe_fen(current_engine, current_board),
                        duration_ms=elapsed,
                    )
            except Exception:
                pass
            return MatchResult(
                white_agent=white.agent_name, white_model=white.model,
                black_agent=black.agent_name, black_model=black.model,
                result="draw", reason="no_legal_moves",
                move_count=len(moves_played), moves=moves_played,
                final_fen=_safe_fen(current_engine, current_board),
                duration_ms=elapsed,
            )

        move = rng.choice(legal)
        moves_played.append(move)

        try:
            result = current_engine.make_move(current_board, move)
            if result is False:
                elapsed = int((time.monotonic() - start_time) * 1000)
                return MatchResult(
                    white_agent=white.agent_name, white_model=white.model,
                    black_agent=black.agent_name, black_model=black.model,
                    result=f"{labels[side]}_crash", reason="crash",
                    move_count=len(moves_played), moves=moves_played,
                    final_fen=_safe_fen(other_engine, other_board),
                    duration_ms=elapsed,
                    error=f"{labels[side]} make_move returned False for '{move}'",
                )
        except Exception as e:
            elapsed = int((time.monotonic() - start_time) * 1000)
            return MatchResult(
                white_agent=white.agent_name, white_model=white.model,
                black_agent=black.agent_name, black_model=black.model,
                result=f"{labels[side]}_crash", reason="crash",
                move_count=len(moves_played), moves=moves_played,
                final_fen=_safe_fen(other_engine, other_board),
                duration_ms=elapsed,
                error=f"{labels[side]} make_move crashed on '{move}': {e}",
            )

        # Sync the other engine's board
        try:
            other_result = other_engine.make_move(other_board, move)
            if other_result is False:
                raise ValueError("make_move returned False")
        except Exception:
            try:
                fen = current_engine.get_fen(current_board)
                boards[1 - side] = other_engine.from_fen(fen)
                if side == 0:
                    b_board = boards[1]
                else:
                    w_board = boards[0]
            except Exception as e2:
                elapsed = int((time.monotonic() - start_time) * 1000)
                return MatchResult(
                    white_agent=white.agent_name, white_model=white.model,
                    black_agent=black.agent_name, black_model=black.model,
                    result=f"{labels[1-side]}_crash", reason="crash",
                    move_count=len(moves_played), moves=moves_played,
                    final_fen=_safe_fen(current_engine, current_board),
                    duration_ms=elapsed,
                    error=f"{labels[1-side]} failed FEN sync after rejecting '{move}': {e2}",
                )

        w_board = boards[0]
        b_board = boards[1]

        # Cross-validate FEN
        try:
            w_fen = white.get_fen(w_board)
            b_fen = black.get_fen(b_board)
            w_pos = " ".join(w_fen.split()[:4])
            b_pos = " ".join(b_fen.split()[:4])
            if w_pos != b_pos:
                elapsed = int((time.monotonic() - start_time) * 1000)
                return MatchResult(
                    white_agent=white.agent_name, white_model=white.model,
                    black_agent=black.agent_name, black_model=black.model,
                    result="draw", reason="fen_mismatch",
                    move_count=len(moves_played), moves=moves_played,
                    final_fen=f"white={w_fen} | black={b_fen}",
                    duration_ms=elapsed,
                    error=f"FEN mismatch after move {move_num} '{move}'",
                )
        except Exception:
            pass

        # Check 50-move rule
        try:
            if hasattr(w_board, "halfmove_clock") and w_board.halfmove_clock >= 100:
                elapsed = int((time.monotonic() - start_time) * 1000)
                return MatchResult(
                    white_agent=white.agent_name, white_model=white.model,
                    black_agent=black.agent_name, black_model=black.model,
                    result="draw", reason="50-move",
                    move_count=len(moves_played), moves=moves_played,
                    final_fen=_safe_fen(white, w_board),
                    duration_ms=elapsed,
                )
        except Exception:
            pass

    elapsed = int((time.monotonic() - start_time) * 1000)
    return MatchResult(
        white_agent=white.agent_name, white_model=white.model,
        black_agent=black.agent_name, black_model=black.model,
        result="draw", reason="move_limit",
        move_count=len(moves_played), moves=moves_played,
        final_fen=_safe_fen(white, w_board),
        duration_ms=elapsed,
    )


def _safe_fen(engine: EngineAdapter, board) -> str:
    try:
        return engine.get_fen(board)
    except Exception:
        return ""


# ─── Tournament ───────────────────────────────────────────────────────────────


@dataclass
class Standing:
    agent: str
    model: str
    played: int = 0
    wins: int = 0
    draws: int = 0
    losses: int = 0
    crashes: int = 0
    points: int = 0


class Tournament:
    """Round-robin tournament supporting both agent-played and random modes."""

    def __init__(
        self,
        mode: str = "agent",
        # Agent mode: list of (AgentConfig, AgentSession) — sessions managed externally
        agent_sessions: list[tuple[AgentConfig, AgentSession]] | None = None,
        reference_engine: ReferenceEngine | None = None,
        # Random mode: list of EngineAdapter
        engines: list[EngineAdapter] | None = None,
        games_per_side: int = 1,
        move_timeout: int = 60,
        time_control: tuple[int, int] = (0, 0),
        db: BenchmarkDB | None = None,
    ):
        self.mode = mode
        self.agent_sessions = agent_sessions or []
        self.reference_engine = reference_engine
        self.engines = engines or []
        self.games_per_side = games_per_side
        self.move_timeout = move_timeout
        self.time_control = time_control
        self.db = db
        self.matches: list[MatchResult] = []
        self.standings: dict[str, Standing] = {}

        if mode == "agent":
            for agent, _ in self.agent_sessions:
                self.standings[agent.name] = Standing(agent=agent.name, model=agent.model)
        else:
            for e in self.engines:
                self.standings[e.agent_name] = Standing(agent=e.agent_name, model=e.model)

    def run(self, verbose: bool = True) -> dict:
        """Run the full tournament. Returns tournament summary dict."""
        if self.mode == "agent":
            return self._run_agent(verbose)
        else:
            return self._run_random(verbose)

    def _run_agent(self, verbose: bool) -> dict:
        """Run agent-played tournament."""
        n = len(self.agent_sessions)
        total_matchups = n * (n - 1) // 2
        total_games = total_matchups * self.games_per_side * 2

        if verbose:
            print(f"\n{'='*60}")
            base_t, inc_t = self.time_control
            tc_name = next(
                (k for k, v in TIME_CONTROLS.items() if v == self.time_control),
                f"{base_t//60}+{inc_t}" if base_t else "unlimited",
            )
            print(f"  AGENT-PLAYED BATTLE — {n} agents, {total_games} games")
            print(f"  {self.games_per_side} game(s) per side per matchup")
            print(f"  Time control: {tc_name} | Move timeout: {self.move_timeout}s")
            print(f"{'='*60}")
            for agent, _ in self.agent_sessions:
                print(f"  - {agent.name} ({agent.model})")
            print()

        # Create tournament in DB
        tournament_id = None
        if self.db:
            participants = [
                {"agent": a.name, "model": a.model} for a, _ in self.agent_sessions
            ]
            tournament_id = self.db.create_tournament(
                game="chess",
                task_id=GAME_TASKS["chess"],
                games_per_side=self.games_per_side,
                participants=participants,
                metadata={
                    "mode": "agent",
                    "move_timeout": self.move_timeout,
                    "time_control": self.time_control,
                },
            )

        game_num = 0
        for i in range(n):
            for j in range(i + 1, n):
                a1, s1 = self.agent_sessions[i]
                a2, s2 = self.agent_sessions[j]
                if verbose:
                    print(f"\n--- {a1.name} vs {a2.name} ---")

                for side_swap in range(2):
                    white_session = s1 if side_swap == 0 else s2
                    black_session = s2 if side_swap == 0 else s1

                    for g in range(self.games_per_side):
                        game_num += 1
                        if verbose:
                            print(
                                f"\n  Game {game_num}/{total_games}: "
                                f"{white_session.agent.name} (W) vs "
                                f"{black_session.agent.name} (B)"
                            )

                        result = play_agent_match(
                            self.reference_engine,
                            white_session,
                            black_session,
                            move_timeout=self.move_timeout,
                            time_control=self.time_control,
                            verbose=verbose,
                        )
                        self.matches.append(result)
                        self._update_standings(result)
                        self._save_match(tournament_id, result)

                        if verbose:
                            symbol = {
                                "white": "1-0", "black": "0-1", "draw": "1/2",
                            }.get(result.result, "0-1*" if "forfeit" in result.result else "?")
                            forfeit = " [FORFEIT]" if "forfeit" in result.result else ""
                            print(
                                f"  Result: {symbol} ({result.reason}, "
                                f"{result.move_count} moves, "
                                f"{result.duration_ms}ms){forfeit}"
                            )
                            if result.error:
                                print(f"    Error: {result.error}")

        ranked = self._compute_rankings()

        if self.db and tournament_id:
            self.db.save_standings(tournament_id, ranked)
            self.db.finish_tournament(tournament_id)

        if verbose:
            self._print_standings(ranked)

        return {
            "tournament_id": tournament_id,
            "games_played": len(self.matches),
            "standings": ranked,
        }

    def _run_random(self, verbose: bool) -> dict:
        """Run legacy random-move tournament."""
        n = len(self.engines)
        total_matchups = n * (n - 1) // 2
        total_games = total_matchups * self.games_per_side * 2

        if verbose:
            print(f"\n{'='*60}")
            print(f"  RANDOM-MOVE BATTLE — {n} engines, {total_games} games")
            print(f"  {self.games_per_side} games per side per matchup")
            print(f"{'='*60}")
            for e in self.engines:
                print(f"  - {e.label()}")
            print()

        tournament_id = None
        if self.db:
            participants = [
                {"agent": e.agent_name, "model": e.model} for e in self.engines
            ]
            tournament_id = self.db.create_tournament(
                game="chess",
                task_id=GAME_TASKS["chess"],
                games_per_side=self.games_per_side,
                participants=participants,
                metadata={"mode": "random"},
            )

        game_num = 0
        for i in range(n):
            for j in range(i + 1, n):
                e1, e2 = self.engines[i], self.engines[j]
                if verbose:
                    print(f"\n--- {e1.agent_name} vs {e2.agent_name} ---")

                for side_swap in range(2):
                    white_engine = e1 if side_swap == 0 else e2
                    black_engine = e2 if side_swap == 0 else e1

                    for g in range(self.games_per_side):
                        game_num += 1
                        seed = game_num * 31337 + g
                        result = play_random_match(
                            white_engine, black_engine, seed=seed,
                        )
                        self.matches.append(result)
                        self._update_standings(result)
                        self._save_match(tournament_id, result)

                        if verbose:
                            symbol = {
                                "white": "1-0", "black": "0-1", "draw": "1/2",
                            }.get(result.result, "?-?")
                            crash = " [CRASH]" if "crash" in result.result else ""
                            print(
                                f"  Game {game_num}/{total_games}: "
                                f"{result.white_agent} vs {result.black_agent} "
                                f"= {symbol} ({result.reason}, {result.move_count} moves"
                                f", {result.duration_ms}ms){crash}"
                            )
                            if result.error:
                                print(f"    Error: {result.error}")

        ranked = self._compute_rankings()

        if self.db and tournament_id:
            self.db.save_standings(tournament_id, ranked)
            self.db.finish_tournament(tournament_id)

        if verbose:
            self._print_standings(ranked)

        return {
            "tournament_id": tournament_id,
            "games_played": len(self.matches),
            "standings": ranked,
        }

    def _save_match(self, tournament_id: int | None, result: MatchResult):
        """Save a match result to DB."""
        if self.db and tournament_id:
            self.db.save_match(tournament_id, _match_result_to_dict(result))

    def _update_standings(self, result: MatchResult):
        """Update standings after a single match."""
        w = self.standings[result.white_agent]
        b = self.standings[result.black_agent]
        w.played += 1
        b.played += 1

        if result.result == "white":
            w.wins += 1
            w.points += 3
            b.losses += 1
        elif result.result == "black":
            b.wins += 1
            b.points += 3
            w.losses += 1
        elif result.result in ("white_crash", "white_forfeit"):
            if result.reason in ("crash", "illegal"):
                w.crashes += 1
            w.losses += 1
            b.wins += 1
            b.points += 3
        elif result.result in ("black_crash", "black_forfeit"):
            if result.reason in ("crash", "illegal"):
                b.crashes += 1
            b.losses += 1
            w.wins += 1
            w.points += 3
        else:
            # draw
            w.draws += 1
            w.points += 1
            b.draws += 1
            b.points += 1

    def _compute_rankings(self) -> list[dict]:
        """Rank agents by points, then wins, then fewer crashes."""
        sorted_standings = sorted(
            self.standings.values(),
            key=lambda s: (-s.points, -s.wins, s.crashes),
        )
        ranked = []
        for rank, s in enumerate(sorted_standings, 1):
            ranked.append({
                "agent": s.agent,
                "model": s.model,
                "played": s.played,
                "wins": s.wins,
                "draws": s.draws,
                "losses": s.losses,
                "crashes": s.crashes,
                "points": s.points,
                "rank": rank,
            })
        return ranked

    def _print_standings(self, ranked: list[dict]):
        """Print formatted standings table."""
        print(f"\n{'='*60}")
        print("  FINAL STANDINGS")
        print(f"{'='*60}")
        print(f"  {'#':<3} {'Agent':<20} {'P':>3} {'W':>3} {'D':>3} {'L':>3} {'C':>3} {'Pts':>4}")
        print(f"  {'-'*3} {'-'*20} {'-'*3} {'-'*3} {'-'*3} {'-'*3} {'-'*3} {'-'*4}")
        for s in ranked:
            print(
                f"  {s['rank']:<3} {s['agent']:<20} "
                f"{s['played']:>3} {s['wins']:>3} {s['draws']:>3} "
                f"{s['losses']:>3} {s['crashes']:>3} {s['points']:>4}"
            )
        print()


# ─── Knockout Tournament ──────────────────────────────────────────────────────


class KnockoutTournament:
    """Single-elimination knockout bracket.

    Each round: pairs face off best-of-N (default 1). Loser is eliminated.
    If odd number of agents, last seed gets a bye. Seeded by agent name order.
    """

    def __init__(
        self,
        agent_sessions: list[tuple[AgentConfig, AgentSession]],
        reference_engine: ReferenceEngine,
        best_of: int = 1,
        move_timeout: int = 60,
        time_control: tuple[int, int] = (0, 0),
        db: BenchmarkDB | None = None,
    ):
        self.agent_sessions = list(agent_sessions)  # copy for mutation
        self.reference_engine = reference_engine
        self.best_of = best_of
        self.move_timeout = move_timeout
        self.time_control = time_control
        self.db = db
        self.matches: list[MatchResult] = []
        self.bracket: list[list[dict]] = []  # rounds -> matchup results

    def _refresh_and_restart_containers(
        self,
        sessions: list[tuple[AgentConfig, AgentSession]],
        verbose: bool,
    ) -> list[tuple[AgentConfig, AgentSession]]:
        """Refresh codex tokens and restart all containers between rounds."""
        if verbose:
            print("\n  Refreshing auth tokens and restarting containers...")
        refresh_codex_tokens_on_host()
        new_sessions = []
        for agent, old_session in sessions:
            old_session.stop()
            new_session = AgentSession(agent)
            new_session.start()
            new_sessions.append((agent, new_session))
            if verbose:
                print(f"    Restarted: {agent.name} ({new_session.container_name})")
        return new_sessions

    def run(self, verbose: bool = True) -> dict:
        """Run knockout tournament with parallel matches per round."""
        remaining = list(self.agent_sessions)
        round_num = 0

        base_time, increment = self.time_control
        if increment > 0:
            tc_name = next(
                (k for k, v in TIME_CONTROLS.items()
                 if v == self.time_control and "+" in k),
                f"{base_time//60}+{increment}",
            )
        else:
            tc_name = next(
                (k for k, v in TIME_CONTROLS.items() if v == self.time_control),
                f"{base_time}s" if base_time else "unlimited",
            )

        if verbose:
            n = len(remaining)
            print(f"\n{'='*60}")
            print(f"  KNOCKOUT TOURNAMENT — {n} agents, best-of-{self.best_of}")
            print(f"  Time control: {tc_name} | Move timeout: {self.move_timeout}s")
            print(f"{'='*60}")
            for a, _ in remaining:
                print(f"  - {a.name} ({a.model})")
            print()

        # Create tournament in DB
        tournament_id = None
        if self.db:
            participants = [
                {"agent": a.name, "model": a.model} for a, _ in remaining
            ]
            self.db.create_tournament(
                game="chess",
                task_id=GAME_TASKS["chess"],
                games_per_side=self.best_of,
                participants=participants,
                metadata={
                    "mode": "knockout",
                    "best_of": self.best_of,
                    "move_timeout": self.move_timeout,
                    "time_control": self.time_control,
                },
            )
            tournament_id = self.db._conn.execute(
                "SELECT last_insert_rowid()"
            ).fetchone()[0]

        while len(remaining) > 1:
            round_num += 1

            # Refresh tokens and restart containers between rounds (not before round 1)
            if round_num > 1:
                remaining = self._refresh_and_restart_containers(remaining, verbose)

            if verbose:
                print(f"\n{'─'*50}")
                print(f"  ROUND {round_num} — {len(remaining)} agents remaining")
                print(f"{'─'*50}")

            round_results = []
            next_round = []

            # Pair up: 0v1, 2v3, etc. Last one gets a bye if odd.
            pairs = []
            for i in range(0, len(remaining) - 1, 2):
                pairs.append((remaining[i], remaining[i + 1]))

            # Run all matches in this round in PARALLEL
            if len(pairs) > 1:
                matchup_results = self._run_parallel_matchups(
                    pairs, round_num, tournament_id, verbose,
                )
            else:
                # Single match — run directly with live output
                matchup_results = []
                for (a1, s1), (a2, s2) in pairs:
                    matchup = self._play_matchup(
                        a1, s1, a2, s2, round_num, tournament_id, verbose,
                    )
                    matchup_results.append(matchup)

            for matchup in matchup_results:
                round_results.append(matchup)
                next_round.append(matchup["winner_session"])

            # Bye for last agent if odd count
            if len(remaining) % 2 == 1:
                bye = remaining[-1]
                if verbose:
                    print(f"\n  {bye[0].name} gets a BYE")
                next_round.append(bye)
                round_results.append({
                    "agent1": bye[0].name,
                    "agent2": "(bye)",
                    "winner": bye[0].name,
                    "score": "bye",
                })

            self.bracket.append(round_results)
            remaining = next_round

        # Winner
        winner_agent, winner_session = remaining[0]

        if verbose:
            print(f"\n{'='*60}")
            print(f"  CHAMPION: {winner_agent.name} ({winner_agent.model})")
            print(f"  Rounds: {round_num} | Total games: {len(self.matches)}")
            print(f"{'='*60}\n")

            # Print bracket summary
            for r, round_results in enumerate(self.bracket, 1):
                print(f"  Round {r}:")
                for m in round_results:
                    print(f"    {m['agent1']} vs {m['agent2']} → {m['winner']} ({m['score']})")
                print()

        if self.db and tournament_id:
            # Save standings based on elimination order
            standings = self._compute_knockout_standings()
            self.db.save_standings(tournament_id, standings)
            self.db.finish_tournament(tournament_id)

        return {
            "tournament_id": tournament_id,
            "games_played": len(self.matches),
            "bracket": [
                [
                    {k: v for k, v in m.items() if k != "winner_session"}
                    for m in round_results
                ]
                for round_results in self.bracket
            ],
            "champion": winner_agent.name,
        }

    def _run_parallel_matchups(
        self,
        pairs: list[tuple[tuple, tuple]],
        round_num: int,
        tournament_id: int | None,
        verbose: bool,
    ) -> list[dict]:
        """Run multiple matchups in parallel using threads."""
        if verbose:
            for (a1, s1), (a2, s2) in pairs:
                print(f"\n  [PARALLEL] {a1.name} vs {a2.name} (best-of-{self.best_of})")

        results_map = {}  # index -> matchup dict
        logs_map = {}     # index -> log string

        def run_one(idx, pair):
            (a1, s1), (a2, s2) = pair
            log_buf = StringIO()
            matchup = self._play_matchup(
                a1, s1, a2, s2, round_num, tournament_id,
                verbose=verbose, log_buffer=log_buf,
            )
            return idx, matchup, log_buf.getvalue()

        with ThreadPoolExecutor(max_workers=len(pairs)) as pool:
            futures = {
                pool.submit(run_one, i, pair): i
                for i, pair in enumerate(pairs)
            }
            for future in as_completed(futures):
                idx, matchup, logs = future.result()
                results_map[idx] = matchup
                logs_map[idx] = logs

        # Print logs in order and collect results
        ordered = []
        for i in range(len(pairs)):
            if verbose and logs_map.get(i):
                print(logs_map[i], end="")
            ordered.append(results_map[i])
        return ordered

    def _play_matchup(
        self,
        a1: AgentConfig, s1: AgentSession,
        a2: AgentConfig, s2: AgentSession,
        round_num: int,
        tournament_id: int | None,
        verbose: bool,
        log_buffer: StringIO | None = None,
    ) -> dict:
        """Play a best-of-N matchup between two agents. Returns winner info."""
        def _log(msg: str):
            if verbose:
                if log_buffer is not None:
                    log_buffer.write(msg + "\n")
                else:
                    print(msg)

        wins = {a1.name: 0, a2.name: 0}
        games_needed = (self.best_of // 2) + 1  # majority wins

        _log(f"\n  {a1.name} vs {a2.name} (best-of-{self.best_of})")

        for game_num in range(self.best_of):
            # Alternate colors
            if game_num % 2 == 0:
                white_session, black_session = s1, s2
            else:
                white_session, black_session = s2, s1

            _log(
                f"    Game {game_num + 1}: "
                f"{white_session.agent.name} (W) vs "
                f"{black_session.agent.name} (B)"
            )

            result = play_agent_match(
                self.reference_engine,
                white_session,
                black_session,
                move_timeout=self.move_timeout,
                time_control=self.time_control,
                verbose=verbose,
                log_buffer=log_buffer,
            )
            self.matches.append(result)

            # Save to DB (thread-safe for sqlite in WAL mode)
            if self.db and tournament_id:
                self.db.save_match(tournament_id, _match_result_to_dict(result))

            # Determine game winner
            if result.result == "white" or result.result in ("black_crash", "black_forfeit"):
                wins[white_session.agent.name] += 1
            elif result.result == "black" or result.result in ("white_crash", "white_forfeit"):
                wins[black_session.agent.name] += 1
            # draws don't count toward either

            symbol = {
                "white": "1-0", "black": "0-1", "draw": "1/2",
            }.get(result.result, "0-1*" if "forfeit" in result.result else "?")
            _log(
                f"    Result: {symbol} ({result.reason}, "
                f"{result.move_count} moves) "
                f"[{a1.name}:{wins[a1.name]} {a2.name}:{wins[a2.name]}]"
            )

            # Check if matchup is decided
            if wins[a1.name] >= games_needed or wins[a2.name] >= games_needed:
                break

        # Determine matchup winner (most wins; if tied, a1 advances as higher seed)
        if wins[a1.name] >= wins[a2.name]:
            winner_name = a1.name
            winner_session = (a1, s1)
        else:
            winner_name = a2.name
            winner_session = (a2, s2)

        score = f"{wins[a1.name]}-{wins[a2.name]}"
        _log(f"    → {winner_name} advances ({score})")

        return {
            "agent1": a1.name,
            "agent2": a2.name,
            "winner": winner_name,
            "score": score,
            "winner_session": winner_session,
        }

    def _compute_knockout_standings(self) -> list[dict]:
        """Compute standings from bracket. Champion = rank 1, etc."""
        # Track elimination round per agent
        eliminated_in: dict[str, int] = {}
        all_agents = {a.name: a.model for a, _ in self.agent_sessions}

        for round_idx, round_results in enumerate(self.bracket):
            for m in round_results:
                loser = m["agent2"] if m["winner"] == m["agent1"] else m["agent1"]
                if loser != "(bye)" and loser not in eliminated_in:
                    eliminated_in[loser] = round_idx + 1

        # Champion is whoever was never eliminated
        champion = None
        for name in all_agents:
            if name not in eliminated_in:
                champion = name
                break

        # Sort: champion first, then by elimination round (later = better)
        ranked_agents = sorted(
            all_agents.keys(),
            key=lambda n: (n != champion, -eliminated_in.get(n, 999)),
        )

        standings = []
        for rank, name in enumerate(ranked_agents, 1):
            # Count wins/losses from all matches
            wins = losses = draws = crashes = 0
            for result in self.matches:
                if result.white_agent == name:
                    if result.result in ("white", "black_crash", "black_forfeit"):
                        wins += 1
                        if result.result in ("black_crash", "black_forfeit"):
                            pass  # opponent crashed, still a win
                    elif result.result in ("white_crash", "white_forfeit"):
                        if result.reason in ("crash", "illegal"):
                            crashes += 1
                        losses += 1
                    elif result.result == "black":
                        losses += 1
                    else:
                        draws += 1
                elif result.black_agent == name:
                    if result.result in ("black", "white_crash", "white_forfeit"):
                        wins += 1
                        if result.result in ("white_crash", "white_forfeit"):
                            pass  # opponent crashed, still a win
                    elif result.result in ("black_crash", "black_forfeit"):
                        if result.reason in ("crash", "illegal"):
                            crashes += 1
                        losses += 1
                    elif result.result == "white":
                        losses += 1
                    else:
                        draws += 1

            standings.append({
                "agent": name,
                "model": all_agents[name],
                "played": wins + losses + draws,
                "wins": wins,
                "draws": draws,
                "losses": losses,
                "crashes": crashes,
                "points": wins * 3 + draws,
                "rank": rank,
            })
        return standings


class VisualKnockoutTournament:
    """Single-elimination knockout for visual chess battles.

    Each matchup is a best-of-N series. Each game uses play_visual_match()
    which creates its own Docker network + chess server per game.
    Matches run sequentially to avoid API key exhaustion.
    """

    def __init__(
        self,
        agents: list[AgentConfig],
        best_of: int = 1,
        time_control: tuple[int, int] = (600, 5),
        max_game_time: int = 1800,
        stall_timeout: int = 300,
        db: BenchmarkDB | None = None,
    ):
        self.agents = list(agents)
        self.best_of = best_of
        self.time_control = time_control
        self.max_game_time = max_game_time
        self.stall_timeout = stall_timeout
        self.db = db
        self.matches: list[MatchResult] = []
        self.bracket: list[list[dict]] = []  # rounds -> matchup results

    def run(self, verbose: bool = True) -> dict:
        """Run single-elimination visual knockout tournament."""
        remaining = list(self.agents)
        round_num = 0

        base_time, increment = self.time_control
        if increment > 0:
            tc_name = next(
                (k for k, v in TIME_CONTROLS.items()
                 if v == self.time_control and "+" in k),
                f"{base_time // 60}+{increment}",
            )
        else:
            tc_name = next(
                (k for k, v in TIME_CONTROLS.items() if v == self.time_control),
                f"{base_time}s" if base_time else "unlimited",
            )

        if verbose:
            n = len(remaining)
            print(f"\n{'='*60}")
            print(f"  VISUAL KNOCKOUT TOURNAMENT — {n} agents, best-of-{self.best_of}")
            print(f"  Time control: {tc_name}")
            print(f"{'='*60}")
            for a in remaining:
                print(f"  - {a.name} ({a.model})")
            print()

        # Create tournament in DB
        tournament_id = None
        if self.db:
            participants = [
                {"agent": a.name, "model": a.model} for a in remaining
            ]
            self.db.create_tournament(
                game="chess",
                task_id="visual-chess-battle",
                games_per_side=self.best_of,
                participants=participants,
                metadata={
                    "mode": "visual-knockout",
                    "best_of": self.best_of,
                    "time_control": self.time_control,
                    "max_game_time": self.max_game_time,
                    "stall_timeout": self.stall_timeout,
                },
            )
            tournament_id = self.db._conn.execute(
                "SELECT last_insert_rowid()"
            ).fetchone()[0]

        while len(remaining) > 1:
            round_num += 1

            # Refresh codex tokens between rounds (not before round 1)
            if round_num > 1:
                if verbose:
                    print("\n  Refreshing auth tokens between rounds...")
                refresh_codex_tokens_on_host()

            if verbose:
                print(f"\n{'─'*50}")
                print(f"  ROUND {round_num} — {len(remaining)} agents remaining")
                print(f"{'─'*50}")

            round_results = []
            next_round = []

            # Pair up: 0v1, 2v3, etc.
            pairs = []
            for i in range(0, len(remaining) - 1, 2):
                pairs.append((remaining[i], remaining[i + 1]))

            # Run matches SEQUENTIALLY (visual matches are expensive)
            for a1, a2 in pairs:
                matchup = self._play_visual_matchup(
                    a1, a2, round_num, tournament_id, verbose,
                )
                round_results.append(matchup)
                next_round.append(matchup["winner_agent"])

            # Bye for last agent if odd count
            if len(remaining) % 2 == 1:
                bye_agent = remaining[-1]
                if verbose:
                    print(f"\n  {bye_agent.name} gets a BYE")
                next_round.append(bye_agent)
                round_results.append({
                    "agent1": bye_agent.name,
                    "agent2": "(bye)",
                    "winner": bye_agent.name,
                    "score": "bye",
                })

            self.bracket.append(round_results)
            remaining = next_round

        # Winner
        winner = remaining[0]

        if verbose:
            print(f"\n{'='*60}")
            print(f"  CHAMPION: {winner.name} ({winner.model})")
            print(f"  Rounds: {round_num} | Total games: {len(self.matches)}")
            print(f"{'='*60}\n")

            # Print bracket summary
            for r, round_results in enumerate(self.bracket, 1):
                print(f"  Round {r}:")
                for m in round_results:
                    print(f"    {m['agent1']} vs {m['agent2']} → {m['winner']} ({m['score']})")
                print()

        if self.db and tournament_id:
            standings = self._compute_knockout_standings()
            self.db.save_standings(tournament_id, standings)
            self.db.finish_tournament(tournament_id)

        return {
            "tournament_id": tournament_id,
            "games_played": len(self.matches),
            "bracket": [
                [
                    {k: v for k, v in m.items() if k != "winner_agent"}
                    for m in round_results
                ]
                for round_results in self.bracket
            ],
            "champion": winner.name,
        }

    def _play_visual_matchup(
        self,
        a1: AgentConfig,
        a2: AgentConfig,
        round_num: int,
        tournament_id: int | None,
        verbose: bool,
    ) -> dict:
        """Play a best-of-N visual matchup. Returns winner info."""
        wins = {a1.name: 0, a2.name: 0}
        games_needed = (self.best_of // 2) + 1

        if verbose:
            print(f"\n  {a1.name} vs {a2.name} (best-of-{self.best_of})")

        for game_num in range(self.best_of):
            # Alternate colors
            if game_num % 2 == 0:
                w_agent, b_agent = a1, a2
            else:
                w_agent, b_agent = a2, a1

            if verbose:
                print(
                    f"    Game {game_num + 1}: "
                    f"{w_agent.name} (W) vs {b_agent.name} (B)"
                )

            result = play_visual_match(
                white_agent=w_agent,
                black_agent=b_agent,
                time_control=self.time_control,
                max_game_time=self.max_game_time,
                stall_timeout=self.stall_timeout,
                verbose=verbose,
            )
            self.matches.append(result)

            # Save to DB
            if self.db and tournament_id:
                self.db.save_match(tournament_id, _match_result_to_dict(result))

            # Determine game winner
            if result.result == "white" or result.result in ("black_crash", "black_forfeit"):
                wins[w_agent.name] += 1
            elif result.result == "black" or result.result in ("white_crash", "white_forfeit"):
                wins[b_agent.name] += 1
            # draws don't count toward either

            symbol = {
                "white": "1-0", "black": "0-1", "draw": "1/2",
            }.get(result.result, "0-1*" if "forfeit" in result.result else "?")
            if verbose:
                print(
                    f"    Result: {symbol} ({result.reason}, "
                    f"{result.move_count} moves) "
                    f"[{a1.name}:{wins[a1.name]} {a2.name}:{wins[a2.name]}]"
                )

            # Check if matchup is decided
            if wins[a1.name] >= games_needed or wins[a2.name] >= games_needed:
                break

        # Determine matchup winner (most wins; if tied, a1 advances as higher seed)
        if wins[a1.name] >= wins[a2.name]:
            winner_name = a1.name
            winner_agent = a1
        else:
            winner_name = a2.name
            winner_agent = a2

        score = f"{wins[a1.name]}-{wins[a2.name]}"
        if verbose:
            print(f"    → {winner_name} advances ({score})")

        return {
            "agent1": a1.name,
            "agent2": a2.name,
            "winner": winner_name,
            "score": score,
            "winner_agent": winner_agent,
        }

    def _compute_knockout_standings(self) -> list[dict]:
        """Compute standings from bracket. Champion = rank 1, etc."""
        eliminated_in: dict[str, int] = {}
        all_agents = {a.name: a.model for a in self.agents}

        for round_idx, round_results in enumerate(self.bracket):
            for m in round_results:
                loser = m["agent2"] if m["winner"] == m["agent1"] else m["agent1"]
                if loser != "(bye)" and loser not in eliminated_in:
                    eliminated_in[loser] = round_idx + 1

        # Champion is whoever was never eliminated
        champion = None
        for name in all_agents:
            if name not in eliminated_in:
                champion = name
                break

        # Sort: champion first, then by elimination round (later = better)
        ranked_agents = sorted(
            all_agents.keys(),
            key=lambda n: (n != champion, -eliminated_in.get(n, 999)),
        )

        standings = []
        for rank, name in enumerate(ranked_agents, 1):
            wins = losses = draws = crashes = 0
            for result in self.matches:
                if result.white_agent == name:
                    if result.result in ("white", "black_crash", "black_forfeit"):
                        wins += 1
                    elif result.result in ("white_crash", "white_forfeit"):
                        if result.reason in ("crash", "illegal"):
                            crashes += 1
                        losses += 1
                    elif result.result == "black":
                        losses += 1
                    else:
                        draws += 1
                elif result.black_agent == name:
                    if result.result in ("black", "white_crash", "white_forfeit"):
                        wins += 1
                    elif result.result in ("black_crash", "black_forfeit"):
                        if result.reason in ("crash", "illegal"):
                            crashes += 1
                        losses += 1
                    elif result.result == "white":
                        losses += 1
                    else:
                        draws += 1

            standings.append({
                "agent": name,
                "model": all_agents[name],
                "played": wins + losses + draws,
                "wins": wins,
                "draws": draws,
                "losses": losses,
                "crashes": crashes,
                "points": wins * 3 + draws,
                "rank": rank,
            })
        return standings


# ─── Discovery ────────────────────────────────────────────────────────────────


def discover_engines(game: str = "chess") -> list[EngineAdapter]:
    """Find all agents that have a passed archive for the given game's task."""
    task_id = GAME_TASKS.get(game)
    if not task_id:
        raise ValueError(f"Unknown game: {game}")

    engines = []
    if not ARCHIVES_DIR.exists():
        return engines

    for agent_dir in sorted(ARCHIVES_DIR.iterdir()):
        if not agent_dir.is_dir():
            continue
        task_dir = agent_dir / task_id
        if not (task_dir / "passed.tar.gz").exists():
            continue

        dirname = agent_dir.name
        parts = dirname.split("_", 1)
        if len(parts) != 2:
            continue
        agent_name, model = parts

        try:
            engine = EngineAdapter(agent_name, model, task_id)
            engines.append(engine)
            print(f"  Loaded: {engine.label()} [{engine._legal_moves_method}]")
        except Exception as e:
            print(f"  SKIP {dirname}: {e}")

    return engines


def discover_agents(game: str = "chess") -> list[AgentConfig]:
    """Find all registered agents that can participate in agent-played battles.

    Requires the agent to have a move_command() method implemented.
    """
    available = []
    for name, agent in sorted(AGENTS.items()):
        try:
            agent.move_command()  # Verify it's implemented
            available.append(agent)
            print(f"  Available: {name} ({agent.model})")
        except NotImplementedError:
            print(f"  SKIP {name}: no move_command()")
    return available


# ─── CLI ──────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Battle: Agent vs Agent chess tournaments"
    )
    parser.add_argument(
        "--game", default="chess", choices=list(GAME_TASKS.keys()),
        help="Game type (default: chess)",
    )
    parser.add_argument(
        "--mode", default="agent", choices=["agent", "visual", "random"],
        help="Battle mode: 'agent' = LLM-decided moves (default), "
             "'visual' = vision-based (screenshot + HTTP API), "
             "'random' = random move selection (legacy)",
    )
    parser.add_argument(
        "--format", default="knockout", choices=["knockout", "roundrobin"],
        help="Tournament format: 'knockout' = single-elimination (default), "
             "'roundrobin' = every pair plays",
    )
    tc_choices = list(TIME_CONTROLS.keys())
    parser.add_argument(
        "--time-control", default="rapid",
        choices=tc_choices,
        help="Chess clock. Formats: bullet(1+0), blitz(3+2), rapid(10+5), "
             "classical(30+15), unlimited. Aliases: bullet, blitz, rapid, classical. "
             "(default: rapid = 10+5)",
    )
    parser.add_argument(
        "--best-of", type=int, default=1,
        help="Best-of-N per matchup in knockout format (default: 1)",
    )
    parser.add_argument(
        "--games-per-side", type=int, default=None,
        help="Games per side per matchup in roundrobin (default: 1 for agent, 5 for random)",
    )
    parser.add_argument(
        "--games", type=int, default=None,
        help="Total games for a specific matchup (overrides --games-per-side)",
    )
    parser.add_argument(
        "--move-timeout", type=int, default=90,
        help="Max seconds per individual move (default: 90)",
    )
    parser.add_argument(
        "--white", type=str, help="White agent name (for specific matchup)",
    )
    parser.add_argument(
        "--black", type=str, help="Black agent name (for specific matchup)",
    )
    parser.add_argument(
        "--list", action="store_true", help="List available agents/engines and exit",
    )
    parser.add_argument(
        "--db", type=str, default=None, help="Database path (default: benchmark.db)",
    )
    parser.add_argument(
        "--exclude", type=str, nargs="+", default=[],
        help="Agent names to exclude from the tournament",
    )
    parser.add_argument(
        "--seed", type=int, default=None, help="Random seed (random mode only)",
    )
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    db_path = args.db or (Path(__file__).resolve().parent / "benchmark.db")
    db = BenchmarkDB(db_path)

    # Set default games-per-side
    if args.games_per_side is None:
        games_per_side = 1
    else:
        games_per_side = args.games_per_side

    if args.mode == "agent":
        _run_agent_mode(args, db, games_per_side)
    elif args.mode == "visual":
        _run_visual_mode(args, db, games_per_side)
    else:
        _run_random_mode(args, db, games_per_side)

    db.close()


def _run_agent_mode(args, db: BenchmarkDB, games_per_side: int):
    """Run agent-played battle mode."""
    time_control = TIME_CONTROLS[args.time_control]

    print("Discovering agents...")
    available_agents = discover_agents(args.game)

    if args.list:
        print(f"\nFound {len(available_agents)} agents:")
        for a in available_agents:
            print(f"  {a.name} ({a.model})")
        sys.exit(0)

    # Filter out excluded agents
    if args.exclude:
        available_agents = [a for a in available_agents if a.name not in args.exclude]
        if args.exclude:
            print(f"\n  Excluded: {', '.join(args.exclude)}")

    # Filter to requested agents
    if args.white and args.black:
        agent_names = [args.white, args.black]
    else:
        agent_names = [a.name for a in available_agents]

    agents = []
    for name in agent_names:
        match = next((a for a in available_agents if a.name == name), None)
        if not match:
            print(f"Agent not found: {name}")
            sys.exit(1)
        agents.append(match)

    if len(agents) < 2:
        print("Need at least 2 agents for a tournament.")
        sys.exit(1)

    # Override games for specific matchup
    if args.games and args.white and args.black:
        games_per_side = args.games // 2 or 1

    # Load reference engine
    print("\nLoading reference engine...")
    try:
        ref_engine = ReferenceEngine()
        legal = ref_engine.get_legal_moves(ref_engine.create_board())
        print(f"  Reference engine OK ({len(legal)} legal moves from start)")
    except Exception as e:
        print(f"FATAL: Cannot load reference engine: {e}")
        sys.exit(1)

    # Start agent sessions
    print("\nStarting agent containers...")
    sessions: list[tuple[AgentConfig, AgentSession]] = []
    for agent in agents:
        session = AgentSession(agent)
        try:
            session.start()
            print(f"  Started: {agent.name} ({session.container_name})")
            sessions.append((agent, session))
        except Exception as e:
            print(f"  FAILED: {agent.name}: {e}")
            # Stop already-started sessions
            for _, s in sessions:
                s.stop()
            sys.exit(1)

    try:
        if args.format == "knockout":
            tournament = KnockoutTournament(
                agent_sessions=sessions,
                reference_engine=ref_engine,
                best_of=args.best_of,
                move_timeout=args.move_timeout,
                time_control=time_control,
                db=db,
            )
            tournament.run()
        else:
            tournament = Tournament(
                mode="agent",
                agent_sessions=sessions,
                reference_engine=ref_engine,
                games_per_side=games_per_side,
                move_timeout=args.move_timeout,
                time_control=time_control,
                db=db,
            )
            tournament.run()
    finally:
        # Always stop containers
        print("\nStopping agent containers...")
        for agent, session in sessions:
            session.stop()
            print(f"  Stopped: {agent.name}")


def _run_visual_mode(args, db: BenchmarkDB, games_per_side: int):
    """Run visual chess battle mode — agents play via screenshots and HTTP.

    Two modes:
      - With --white/--black: single 1v1 series (existing behavior)
      - Without: tournament over all visual-capable agents
    """
    time_control = TIME_CONTROLS[args.time_control]

    # Build chess server image first
    print("\nPreparing chess server...")
    try:
        _build_chess_server_image()
    except Exception as e:
        print(f"FATAL: {e}")
        sys.exit(1)

    # If specific matchup requested, use 1v1 logic
    if args.white and args.black:
        _run_visual_1v1(args, db, time_control, games_per_side)
        return

    # Tournament mode — discover all visual-capable agents
    visual_agents = [
        a for n, a in sorted(AGENTS.items())
        if a.supports_visual_battle() and n not in args.exclude
    ]

    if args.list:
        print(f"\nVisual-capable agents ({len(visual_agents)}):")
        for a in visual_agents:
            vision = " [vision]" if a.has_vision() else ""
            print(f"  {a.name} ({a.model}){vision}")
        sys.exit(0)

    if len(visual_agents) < 2:
        print("Need at least 2 visual-capable agents for a tournament.")
        print("Use --white and --black for a specific 1v1 matchup.")
        sys.exit(1)

    if args.exclude:
        print(f"\n  Excluded: {', '.join(args.exclude)}")

    if args.format == "knockout":
        tournament = VisualKnockoutTournament(
            agents=visual_agents,
            best_of=args.best_of,
            time_control=time_control,
            max_game_time=1800,
            stall_timeout=300,
            db=db,
        )
        tournament.run()
    else:
        # Round-robin: every pair plays
        _run_visual_roundrobin(visual_agents, time_control, games_per_side, db)


def _run_visual_1v1(args, db: BenchmarkDB, time_control, games_per_side: int):
    """Run a 1v1 visual battle series between two specific agents."""
    from config import get_agent
    white_agent = get_agent(args.white)
    black_agent = get_agent(args.black)

    if not white_agent.supports_visual_battle():
        print(f"Agent '{args.white}' does not support visual battles")
        sys.exit(1)
    if not black_agent.supports_visual_battle():
        print(f"Agent '{args.black}' does not support visual battles")
        sys.exit(1)

    base_time, increment = time_control
    total_games = args.games or (games_per_side * 2)

    tc_name = next(
        (k for k, v in TIME_CONTROLS.items()
         if v == time_control and "+" in k),
        f"{base_time // 60}+{increment}" if base_time else "unlimited",
    )

    print(f"\n{'='*60}")
    print(f"  VISUAL CHESS BATTLE")
    print(f"  {white_agent.name} vs {black_agent.name}")
    print(f"  Time control: {tc_name} | Games: {total_games}")
    print(f"{'='*60}\n")

    # Create tournament in DB
    tournament_id = None
    if db:
        participants = [
            {"agent": white_agent.name, "model": white_agent.model},
            {"agent": black_agent.name, "model": black_agent.model},
        ]
        tournament_id = db.create_tournament(
            game="chess",
            task_id="visual-chess-battle",
            games_per_side=total_games,
            participants=participants,
            metadata={
                "mode": "visual",
                "time_control": time_control,
            },
        )

    standings = {
        white_agent.name: Standing(agent=white_agent.name, model=white_agent.model),
        black_agent.name: Standing(agent=black_agent.name, model=black_agent.model),
    }
    all_matches = []

    for game_num in range(1, total_games + 1):
        # Alternate colors
        if game_num % 2 == 1:
            w_agent, b_agent = white_agent, black_agent
        else:
            w_agent, b_agent = black_agent, white_agent

        print(f"\n--- Game {game_num}/{total_games}: "
              f"{w_agent.name} (W) vs {b_agent.name} (B) ---")

        result = play_visual_match(
            white_agent=w_agent,
            black_agent=b_agent,
            time_control=time_control,
            max_game_time=1800,
            stall_timeout=300,
            verbose=True,
        )
        all_matches.append(result)

        # Update standings
        w = standings[result.white_agent]
        b = standings[result.black_agent]
        w.played += 1
        b.played += 1

        if result.result == "white":
            w.wins += 1; w.points += 3; b.losses += 1
        elif result.result == "black":
            b.wins += 1; b.points += 3; w.losses += 1
        elif "white" in result.result and "forfeit" in result.result:
            w.losses += 1; b.wins += 1; b.points += 3
            if result.reason in ("crash", "illegal"):
                w.crashes += 1
        elif "black" in result.result and "forfeit" in result.result:
            b.losses += 1; w.wins += 1; w.points += 3
            if result.reason in ("crash", "illegal"):
                b.crashes += 1
        else:
            w.draws += 1; w.points += 1; b.draws += 1; b.points += 1

        # Save to DB
        if db and tournament_id:
            db.save_match(tournament_id, _match_result_to_dict(result))

        symbol = {
            "white": "1-0", "black": "0-1", "draw": "1/2",
        }.get(result.result, "0-1*" if "forfeit" in result.result else "?")
        forfeit = " [FORFEIT]" if "forfeit" in result.result else ""
        print(
            f"  Result: {symbol} ({result.reason}, "
            f"{result.move_count} moves, "
            f"{result.duration_ms}ms){forfeit}"
        )
        if result.error:
            print(f"    Error: {result.error}")

    # Print final standings
    ranked = sorted(
        standings.values(),
        key=lambda s: (-s.points, -s.wins, s.crashes),
    )
    print(f"\n{'='*60}")
    print("  FINAL STANDINGS (Visual Battle)")
    print(f"{'='*60}")
    print(f"  {'#':<3} {'Agent':<20} {'P':>3} {'W':>3} {'D':>3} {'L':>3} {'C':>3} {'Pts':>4}")
    print(f"  {'-'*3} {'-'*20} {'-'*3} {'-'*3} {'-'*3} {'-'*3} {'-'*3} {'-'*4}")
    for rank, s in enumerate(ranked, 1):
        print(
            f"  {rank:<3} {s.agent:<20} "
            f"{s.played:>3} {s.wins:>3} {s.draws:>3} "
            f"{s.losses:>3} {s.crashes:>3} {s.points:>4}"
        )
    print()

    if db and tournament_id:
        ranked_dicts = [
            {
                "agent": s.agent, "model": s.model,
                "played": s.played, "wins": s.wins, "draws": s.draws,
                "losses": s.losses, "crashes": s.crashes, "points": s.points,
                "rank": rank,
            }
            for rank, s in enumerate(ranked, 1)
        ]
        db.save_standings(tournament_id, ranked_dicts)
        db.finish_tournament(tournament_id)


def _run_visual_roundrobin(
    agents: list[AgentConfig],
    time_control: tuple[int, int],
    games_per_side: int,
    db: BenchmarkDB | None,
):
    """Run round-robin visual tournament — every pair plays."""
    from itertools import combinations

    base_time, increment = time_control
    tc_name = next(
        (k for k, v in TIME_CONTROLS.items()
         if v == time_control and "+" in k),
        f"{base_time // 60}+{increment}" if base_time else "unlimited",
    )

    pairs = list(combinations(agents, 2))
    total_games = len(pairs) * games_per_side * 2

    print(f"\n{'='*60}")
    print(f"  VISUAL ROUND-ROBIN — {len(agents)} agents, {len(pairs)} matchups")
    print(f"  Time control: {tc_name} | Games per side: {games_per_side}")
    print(f"  Total games: {total_games}")
    print(f"{'='*60}")
    for a in agents:
        print(f"  - {a.name} ({a.model})")
    print()

    # Create tournament in DB
    tournament_id = None
    if db:
        participants = [
            {"agent": a.name, "model": a.model} for a in agents
        ]
        tournament_id = db.create_tournament(
            game="chess",
            task_id="visual-chess-battle",
            games_per_side=games_per_side,
            participants=participants,
            metadata={
                "mode": "visual-roundrobin",
                "time_control": time_control,
                "games_per_side": games_per_side,
            },
        )

    standings = {
        a.name: Standing(agent=a.name, model=a.model) for a in agents
    }
    all_matches = []
    game_count = 0

    for pair_idx, (a1, a2) in enumerate(pairs, 1):
        print(f"\n{'─'*50}")
        print(f"  Matchup {pair_idx}/{len(pairs)}: {a1.name} vs {a2.name}")
        print(f"{'─'*50}")

        for side in range(games_per_side):
            for flip in range(2):
                game_count += 1
                if (side * 2 + flip) % 2 == 0:
                    w_agent, b_agent = a1, a2
                else:
                    w_agent, b_agent = a2, a1

                print(f"\n  Game {game_count}/{total_games}: "
                      f"{w_agent.name} (W) vs {b_agent.name} (B)")

                result = play_visual_match(
                    white_agent=w_agent,
                    black_agent=b_agent,
                    time_control=time_control,
                    max_game_time=1800,
                    stall_timeout=300,
                    verbose=True,
                )
                all_matches.append(result)

                # Update standings
                w = standings[result.white_agent]
                b = standings[result.black_agent]
                w.played += 1
                b.played += 1

                if result.result == "white":
                    w.wins += 1; w.points += 3; b.losses += 1
                elif result.result == "black":
                    b.wins += 1; b.points += 3; w.losses += 1
                elif "white" in result.result and "forfeit" in result.result:
                    w.losses += 1; b.wins += 1; b.points += 3
                    if result.reason in ("crash", "illegal"):
                        w.crashes += 1
                elif "black" in result.result and "forfeit" in result.result:
                    b.losses += 1; w.wins += 1; w.points += 3
                    if result.reason in ("crash", "illegal"):
                        b.crashes += 1
                else:
                    w.draws += 1; w.points += 1; b.draws += 1; b.points += 1

                # Save to DB
                if db and tournament_id:
                    db.save_match(tournament_id, _match_result_to_dict(result))

                symbol = {
                    "white": "1-0", "black": "0-1", "draw": "1/2",
                }.get(result.result, "0-1*" if "forfeit" in result.result else "?")
                forfeit = " [FORFEIT]" if "forfeit" in result.result else ""
                print(
                    f"  Result: {symbol} ({result.reason}, "
                    f"{result.move_count} moves, "
                    f"{result.duration_ms}ms){forfeit}"
                )

        # Refresh tokens between matchups
        refresh_codex_tokens_on_host()

    # Print final standings
    ranked = sorted(
        standings.values(),
        key=lambda s: (-s.points, -s.wins, s.crashes),
    )
    print(f"\n{'='*60}")
    print("  FINAL STANDINGS (Visual Round-Robin)")
    print(f"{'='*60}")
    print(f"  {'#':<3} {'Agent':<20} {'P':>3} {'W':>3} {'D':>3} {'L':>3} {'C':>3} {'Pts':>4}")
    print(f"  {'-'*3} {'-'*20} {'-'*3} {'-'*3} {'-'*3} {'-'*3} {'-'*3} {'-'*4}")
    for rank, s in enumerate(ranked, 1):
        print(
            f"  {rank:<3} {s.agent:<20} "
            f"{s.played:>3} {s.wins:>3} {s.draws:>3} "
            f"{s.losses:>3} {s.crashes:>3} {s.points:>4}"
        )
    print()

    if db and tournament_id:
        ranked_dicts = [
            {
                "agent": s.agent, "model": s.model,
                "played": s.played, "wins": s.wins, "draws": s.draws,
                "losses": s.losses, "crashes": s.crashes, "points": s.points,
                "rank": rank,
            }
            for rank, s in enumerate(ranked, 1)
        ]
        db.save_standings(tournament_id, ranked_dicts)
        db.finish_tournament(tournament_id)


def _run_random_mode(args, db: BenchmarkDB, games_per_side: int):
    """Run legacy random-move battle mode."""
    print(f"Discovering {args.game} engines...")
    engines = discover_engines(args.game)

    if not engines:
        print("No engines found! Run benchmarks first to generate archives.")
        sys.exit(1)

    if args.list:
        print(f"\nFound {len(engines)} engines:")
        for e in engines:
            print(f"  {e.label()}")
        sys.exit(0)

    if args.white and args.black:
        white = next((e for e in engines if e.agent_name == args.white), None)
        black = next((e for e in engines if e.agent_name == args.black), None)
        if not white:
            print(f"Engine not found: {args.white}")
            sys.exit(1)
        if not black:
            print(f"Engine not found: {args.black}")
            sys.exit(1)

        total_games = args.games or (games_per_side * 2)
        games_per_side = total_games // 2

        tournament = Tournament(
            mode="random",
            engines=[white, black],
            games_per_side=games_per_side,
            db=db,
        )
        tournament.run()
    else:
        if len(engines) < 2:
            print("Need at least 2 engines for a tournament.")
            sys.exit(1)

        tournament = Tournament(
            mode="random",
            engines=engines,
            games_per_side=games_per_side,
            db=db,
        )
        tournament.run()

    for e in engines:
        e.cleanup()


if __name__ == "__main__":
    main()
