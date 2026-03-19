"""Persistent SQLite database for benchmark results across runs.

Stores all benchmark results, jury verdicts, and run metadata so that
past results are never lost. Supports skip-cache logic via git/task
fingerprinting.
"""

import hashlib
import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "benchmark.db"

SCHEMA = """\
CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    agents      TEXT NOT NULL,
    task_filter TEXT,
    total_pairs INTEGER NOT NULL,
    git_commit  TEXT,
    git_dirty   BOOLEAN DEFAULT FALSE,
    shizuha_version TEXT,
    codex_version   TEXT,
    metadata    TEXT
);

CREATE TABLE IF NOT EXISTS results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          INTEGER NOT NULL REFERENCES runs(id),
    agent           TEXT NOT NULL,
    model           TEXT NOT NULL,
    agent_version   TEXT,
    task_id         TEXT NOT NULL,
    task_name       TEXT NOT NULL,
    tier            TEXT NOT NULL,
    passed          BOOLEAN NOT NULL,
    score           REAL NOT NULL,
    elapsed_seconds REAL NOT NULL,
    timed_out       BOOLEAN NOT NULL DEFAULT FALSE,
    evaluations     TEXT,
    workspace_files TEXT,
    file_contents   TEXT,
    stdout          TEXT,
    stderr          TEXT,
    timestamp       TEXT NOT NULL,
    task_hash       TEXT,
    agent_hash      TEXT,
    UNIQUE(run_id, agent, task_id)
);

CREATE TABLE IF NOT EXISTS jury_verdicts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    result_id   INTEGER NOT NULL REFERENCES results(id),
    jury_model  TEXT NOT NULL,
    jury_method TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    rating      INTEGER NOT NULL,
    correctness INTEGER,
    completeness INTEGER,
    code_quality INTEGER,
    reasoning   TEXT,
    correctness_reasoning TEXT,
    completeness_reasoning TEXT,
    code_quality_reasoning TEXT,
    judged_at   TEXT NOT NULL,
    UNIQUE(result_id, jury_model)
);

CREATE INDEX IF NOT EXISTS idx_results_task ON results(task_id, agent);
CREATE INDEX IF NOT EXISTS idx_results_agent_hash ON results(agent_hash, task_hash);
CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
CREATE INDEX IF NOT EXISTS idx_jury_result ON jury_verdicts(result_id);

CREATE TABLE IF NOT EXISTS battle_tournaments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game            TEXT NOT NULL,
    task_id         TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    games_per_side  INTEGER NOT NULL,
    participants    TEXT NOT NULL,
    metadata        TEXT
);

CREATE TABLE IF NOT EXISTS battle_matches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id   INTEGER NOT NULL REFERENCES battle_tournaments(id),
    white_agent     TEXT NOT NULL,
    white_model     TEXT NOT NULL,
    black_agent     TEXT NOT NULL,
    black_model     TEXT NOT NULL,
    result          TEXT NOT NULL,
    reason          TEXT,
    move_count      INTEGER NOT NULL,
    moves           TEXT,
    final_fen       TEXT,
    duration_ms     INTEGER,
    played_at       TEXT NOT NULL,
    move_details    TEXT,
    agent_telemetry TEXT
);

CREATE TABLE IF NOT EXISTS battle_standings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id   INTEGER NOT NULL REFERENCES battle_tournaments(id),
    agent           TEXT NOT NULL,
    model           TEXT NOT NULL,
    played          INTEGER NOT NULL,
    wins            INTEGER NOT NULL,
    draws           INTEGER NOT NULL,
    losses          INTEGER NOT NULL,
    crashes         INTEGER NOT NULL,
    points          INTEGER NOT NULL,
    rank            INTEGER NOT NULL,
    UNIQUE(tournament_id, agent)
);

CREATE INDEX IF NOT EXISTS idx_battle_matches_tournament ON battle_matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_battle_standings_tournament ON battle_standings(tournament_id);
"""


def get_git_info() -> dict:
    """Get git fingerprint information for the current repo."""
    info = {"commit": None, "dirty": False, "shizuha_version": None}

    try:
        info["commit"] = (
            subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=Path(__file__).resolve().parent,
                stderr=subprocess.DEVNULL,
            )
            .decode()
            .strip()
        )
    except Exception:
        pass

    try:
        info["dirty"] = (
            subprocess.call(
                ["git", "diff", "--quiet"],
                cwd=Path(__file__).resolve().parent,
                stderr=subprocess.DEVNULL,
            )
            != 0
        )
    except Exception:
        pass

    try:
        shizuha_dir = Path(__file__).resolve().parent.parent.parent / "shizuha"
        if shizuha_dir.is_dir():
            info["shizuha_version"] = (
                subprocess.check_output(
                    ["git", "rev-parse", "HEAD"],
                    cwd=shizuha_dir,
                    stderr=subprocess.DEVNULL,
                )
                .decode()
                .strip()
            )
    except Exception:
        pass

    return info


def compute_task_hash(task: dict) -> str:
    """SHA256 of task prompt + evaluation config for cache invalidation."""
    blob = json.dumps(
        {"prompt": task.get("prompt", ""), "evaluation": task.get("evaluation", [])},
        sort_keys=True,
    )
    return hashlib.sha256(blob.encode()).hexdigest()


def compute_agent_hash(agent_name: str) -> str:
    """SHA256 based on git commit of agent source."""
    info = get_git_info()
    blob = json.dumps(
        {"agent": agent_name, "commit": info.get("commit"), "shizuha": info.get("shizuha_version")},
        sort_keys=True,
    )
    return hashlib.sha256(blob.encode()).hexdigest()


class BenchmarkDB:
    """SQLite-backed persistent benchmark database."""

    def __init__(self, db_path: str | Path = DB_PATH):
        self.db_path = str(db_path)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema()

    def _init_schema(self):
        self._conn.executescript(SCHEMA)
        self._migrate_battle_matches_v2()
        self._conn.commit()

    def _migrate_battle_matches_v2(self):
        """Add move_details + agent_telemetry columns to existing battle_matches tables."""
        cur = self._conn.execute("PRAGMA table_info(battle_matches)")
        columns = {row[1] for row in cur.fetchall()}
        if "move_details" not in columns:
            self._conn.execute("ALTER TABLE battle_matches ADD COLUMN move_details TEXT")
        if "agent_telemetry" not in columns:
            self._conn.execute("ALTER TABLE battle_matches ADD COLUMN agent_telemetry TEXT")
        # Add git_commit and metadata to results table
        cur2 = self._conn.execute("PRAGMA table_info(results)")
        result_cols = {row[1] for row in cur2.fetchall()}
        if "git_commit" not in result_cols:
            self._conn.execute("ALTER TABLE results ADD COLUMN git_commit TEXT")
        if "metadata" not in result_cols:
            self._conn.execute("ALTER TABLE results ADD COLUMN metadata TEXT")

    def close(self):
        self._conn.close()

    # ─── Run management ──────────────────────────────────────────────────

    def create_run(
        self,
        agents: list[str],
        task_filter: str | None = None,
        total_pairs: int = 0,
        git_info: dict | None = None,
        metadata: dict | None = None,
    ) -> int:
        """Create a new benchmark run record. Returns run_id."""
        gi = git_info or {}
        cur = self._conn.execute(
            """INSERT INTO runs (started_at, agents, task_filter, total_pairs,
               git_commit, git_dirty, shizuha_version, codex_version, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                datetime.now(timezone.utc).isoformat(),
                json.dumps(agents),
                task_filter,
                total_pairs,
                gi.get("commit"),
                gi.get("dirty", False),
                gi.get("shizuha_version"),
                gi.get("codex_version"),
                json.dumps(metadata) if metadata else None,
            ),
        )
        self._conn.commit()
        return cur.lastrowid

    def finish_run(self, run_id: int):
        """Mark a run as finished."""
        self._conn.execute(
            "UPDATE runs SET finished_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), run_id),
        )
        self._conn.commit()

    def get_run(self, run_id: int) -> dict | None:
        row = self._conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return dict(row) if row else None

    def get_all_runs(self) -> list[dict]:
        rows = self._conn.execute("SELECT * FROM runs ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]

    # ─── Result management ───────────────────────────────────────────────

    def save_result(self, run_id: int, result: dict) -> int:
        """Save a single task result. Returns result_id."""
        cur = self._conn.execute(
            """INSERT OR REPLACE INTO results
               (run_id, agent, model, agent_version, task_id, task_name, tier,
                passed, score, elapsed_seconds, timed_out, evaluations,
                workspace_files, file_contents, stdout, stderr, timestamp,
                task_hash, agent_hash, git_commit, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run_id,
                result["agent"],
                result.get("model", ""),
                result.get("agent_version"),
                result["task_id"],
                result.get("task_name", result["task_id"]),
                result["tier"],
                result["passed"],
                result.get("score", 0.0),
                result.get("elapsed_seconds", 0),
                result.get("timed_out", False),
                json.dumps(result.get("evaluations", [])),
                json.dumps(result.get("workspace_files", [])),
                json.dumps(result.get("file_contents", {})) if result.get("file_contents") else None,
                result.get("stdout"),
                result.get("stderr"),
                result.get("timestamp", datetime.now(timezone.utc).isoformat()),
                result.get("task_hash"),
                result.get("agent_hash"),
                result.get("git_commit"),
                json.dumps(result.get("metadata")) if result.get("metadata") else None,
            ),
        )
        self._conn.commit()
        return cur.lastrowid

    def save_jury_verdict(self, result_id: int, verdict: dict):
        """Save a jury verdict for a result."""
        self._conn.execute(
            """INSERT OR REPLACE INTO jury_verdicts
               (result_id, jury_model, jury_method, verdict, rating,
                correctness, completeness, code_quality, reasoning,
                correctness_reasoning, completeness_reasoning, code_quality_reasoning,
                judged_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                result_id,
                verdict.get("jury_model", "unknown"),
                verdict.get("jury_method", "unknown"),
                verdict["verdict"],
                verdict["rating"],
                verdict.get("correctness"),
                verdict.get("completeness"),
                verdict.get("code_quality"),
                verdict.get("reasoning"),
                verdict.get("correctness_reasoning"),
                verdict.get("completeness_reasoning"),
                verdict.get("code_quality_reasoning"),
                verdict.get("judged_at", datetime.now(timezone.utc).isoformat()),
            ),
        )
        self._conn.commit()

    def get_latest_passed(
        self, agent: str, task_id: str, agent_hash: str | None, task_hash: str | None
    ) -> dict | None:
        """Get the latest passing result for agent+task with matching hashes.

        Used for skip-cache logic: if the agent source and task definition
        haven't changed since the last pass, we can skip re-running.
        """
        if not agent_hash or not task_hash:
            return None

        row = self._conn.execute(
            """SELECT * FROM results
               WHERE agent = ? AND task_id = ? AND passed = 1
                     AND agent_hash = ? AND task_hash = ?
               ORDER BY id DESC LIMIT 1""",
            (agent, task_id, agent_hash, task_hash),
        ).fetchone()
        return self._row_to_result(row) if row else None

    def get_run_results(self, run_id: int) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM results WHERE run_id = ? ORDER BY id", (run_id,)
        ).fetchall()
        return [self._row_to_result(r) for r in rows]

    def get_all_results(
        self,
        agent: str | None = None,
        tier: str | None = None,
        task_id: str | None = None,
    ) -> list[dict]:
        query = "SELECT * FROM results WHERE 1=1"
        params: list = []
        if agent:
            query += " AND agent = ?"
            params.append(agent)
        if tier:
            query += " AND tier = ?"
            params.append(tier)
        if task_id:
            query += " AND task_id = ?"
            params.append(task_id)
        query += " ORDER BY id DESC"
        rows = self._conn.execute(query, params).fetchall()
        return [self._row_to_result(r) for r in rows]

    def get_best_results_per_task(self, agent: str | None = None) -> list[dict]:
        """Get the latest passing result per task (optionally per agent)."""
        query = """
            SELECT r.* FROM results r
            INNER JOIN (
                SELECT task_id, agent, MAX(id) as max_id
                FROM results WHERE passed = 1
        """
        params: list = []
        if agent:
            query += " AND agent = ?"
            params.append(agent)
        query += " GROUP BY task_id, agent) latest ON r.id = latest.max_id ORDER BY r.tier, r.task_id"
        rows = self._conn.execute(query, params).fetchall()
        return [self._row_to_result(r) for r in rows]

    def get_result_by_id(self, result_id: int) -> dict | None:
        row = self._conn.execute("SELECT * FROM results WHERE id = ?", (result_id,)).fetchone()
        return self._row_to_result(row) if row else None

    def get_jury_verdicts(self, result_id: int) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM jury_verdicts WHERE result_id = ? ORDER BY id", (result_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def attach_jury_verdicts(self, results: list[dict], jury_model: str | None = None) -> list[dict]:
        """Attach jury verdicts to a list of result dicts (in-place).

        Looks up jury_verdicts for each result by _db_id and adds
        the best-rated verdict as result['jury_verdict'].

        Args:
            results: List of result dicts to attach verdicts to.
            jury_model: If set, only attach verdicts from this specific model.
                        If None, picks the highest-rated verdict across all models.
        """
        for r in results:
            db_id = r.get("_db_id")
            if not db_id:
                continue
            verdicts = self.get_jury_verdicts(db_id)
            if jury_model:
                verdicts = [v for v in verdicts if v.get("jury_model") == jury_model]
            if verdicts:
                best = max(verdicts, key=lambda v: v.get("rating", 0))
                r["jury_verdict"] = {
                    "verdict": best["verdict"],
                    "rating": best["rating"],
                    "correctness": best.get("correctness"),
                    "completeness": best.get("completeness"),
                    "code_quality": best.get("code_quality"),
                    "reasoning": best.get("reasoning"),
                    "correctness_reasoning": best.get("correctness_reasoning"),
                    "completeness_reasoning": best.get("completeness_reasoning"),
                    "code_quality_reasoning": best.get("code_quality_reasoning"),
                    "jury_model": best["jury_model"],
                    "jury_method": best["jury_method"],
                }
        return results

    def get_distinct_jury_models(self) -> list[str]:
        """Get all distinct jury models that have submitted verdicts."""
        rows = self._conn.execute(
            "SELECT DISTINCT jury_model FROM jury_verdicts ORDER BY jury_model"
        ).fetchall()
        return [row[0] for row in rows]

    # ─── Battle management ─────────────────────────────────────────────

    def create_tournament(
        self,
        game: str,
        task_id: str,
        games_per_side: int,
        participants: list[dict],
        metadata: dict | None = None,
    ) -> int:
        """Create a new battle tournament. Returns tournament_id."""
        cur = self._conn.execute(
            """INSERT INTO battle_tournaments
               (game, task_id, started_at, games_per_side, participants, metadata)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                game,
                task_id,
                datetime.now(timezone.utc).isoformat(),
                games_per_side,
                json.dumps(participants),
                json.dumps(metadata) if metadata else None,
            ),
        )
        self._conn.commit()
        return cur.lastrowid

    def finish_tournament(self, tournament_id: int):
        """Mark a tournament as finished."""
        self._conn.execute(
            "UPDATE battle_tournaments SET finished_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), tournament_id),
        )
        self._conn.commit()

    def save_match(self, tournament_id: int, match: dict) -> int:
        """Save a single battle match result. Returns match_id."""
        cur = self._conn.execute(
            """INSERT INTO battle_matches
               (tournament_id, white_agent, white_model, black_agent, black_model,
                result, reason, move_count, moves, final_fen, duration_ms, played_at,
                move_details, agent_telemetry)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                tournament_id,
                match["white_agent"],
                match["white_model"],
                match["black_agent"],
                match["black_model"],
                match["result"],
                match.get("reason"),
                match["move_count"],
                json.dumps(match.get("moves", [])),
                match.get("final_fen"),
                match.get("duration_ms"),
                match.get("played_at", datetime.now(timezone.utc).isoformat()),
                json.dumps(match.get("move_details")) if match.get("move_details") else None,
                json.dumps(match.get("agent_telemetry")) if match.get("agent_telemetry") else None,
            ),
        )
        self._conn.commit()
        return cur.lastrowid

    def save_standings(self, tournament_id: int, standings: list[dict]):
        """Save tournament standings (replaces existing for this tournament)."""
        self._conn.execute(
            "DELETE FROM battle_standings WHERE tournament_id = ?", (tournament_id,)
        )
        for s in standings:
            self._conn.execute(
                """INSERT INTO battle_standings
                   (tournament_id, agent, model, played, wins, draws, losses,
                    crashes, points, rank)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    tournament_id,
                    s["agent"],
                    s["model"],
                    s["played"],
                    s["wins"],
                    s["draws"],
                    s["losses"],
                    s["crashes"],
                    s["points"],
                    s["rank"],
                ),
            )
        self._conn.commit()

    def get_tournaments(self, game: str | None = None) -> list[dict]:
        """Get all tournaments, optionally filtered by game."""
        if game:
            rows = self._conn.execute(
                "SELECT * FROM battle_tournaments WHERE game = ? ORDER BY id DESC",
                (game,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM battle_tournaments ORDER BY id DESC"
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("participants") and isinstance(d["participants"], str):
                try:
                    d["participants"] = json.loads(d["participants"])
                except (json.JSONDecodeError, TypeError):
                    pass
            if d.get("metadata") and isinstance(d["metadata"], str):
                try:
                    d["metadata"] = json.loads(d["metadata"])
                except (json.JSONDecodeError, TypeError):
                    pass
            result.append(d)
        return result

    def get_tournament_matches(self, tournament_id: int) -> list[dict]:
        """Get all matches for a tournament."""
        rows = self._conn.execute(
            "SELECT * FROM battle_matches WHERE tournament_id = ? ORDER BY id",
            (tournament_id,),
        ).fetchall()
        return [self._parse_match_row(r) for r in rows]

    def get_match(self, match_id: int) -> dict | None:
        """Get a single match by ID with full details."""
        row = self._conn.execute(
            "SELECT * FROM battle_matches WHERE id = ?", (match_id,)
        ).fetchone()
        return self._parse_match_row(row) if row else None

    def _parse_match_row(self, row) -> dict:
        """Parse a battle_matches row, deserializing JSON fields."""
        d = dict(row)
        for field in ("moves", "move_details", "agent_telemetry"):
            if d.get(field) and isinstance(d[field], str):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
        return d

    def get_tournament_standings(self, tournament_id: int) -> list[dict]:
        """Get standings for a tournament, sorted by rank."""
        rows = self._conn.execute(
            "SELECT * FROM battle_standings WHERE tournament_id = ? ORDER BY rank",
            (tournament_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ─── Import / Export ─────────────────────────────────────────────────

    def import_json(self, json_path: str | Path) -> int:
        """Import results from an existing JSON file. Returns count imported."""
        path = Path(json_path)
        if not path.exists():
            raise FileNotFoundError(f"Results file not found: {path}")

        with open(path) as f:
            results = json.load(f)

        if not results:
            return 0

        # Extract run timestamp from filename (run-YYYYMMDD-HHMMSS.json)
        stem = path.stem
        agents = list({r["agent"] for r in results})
        tiers = list({r.get("tier", "unknown") for r in results})

        run_id = self.create_run(
            agents=agents,
            task_filter=f"imported:{stem}",
            total_pairs=len(results),
            metadata={"source": str(path), "imported_at": datetime.now(timezone.utc).isoformat()},
        )

        count = 0
        for result in results:
            result_id = self.save_result(run_id, result)
            count += 1

            # Import jury verdict if present
            jury = result.get("jury_verdict")
            if jury and isinstance(jury, dict) and jury.get("verdict"):
                self.save_jury_verdict(
                    result_id,
                    {
                        **jury,
                        "jury_model": jury.get("jury_model", "claude-sonnet-4-5"),
                        "jury_method": jury.get("jury_method", "imported"),
                        "judged_at": jury.get("judged_at", result.get("timestamp", "")),
                    },
                )

        self.finish_run(run_id)
        return count

    def export_json(self, run_id: int | None = None) -> list[dict]:
        """Export results as JSON-compatible list (for backward compat)."""
        if run_id:
            results = self.get_run_results(run_id)
        else:
            results = self.get_all_results()

        # Attach jury verdicts
        for r in results:
            verdicts = self.get_jury_verdicts(r.get("_db_id", 0))
            if verdicts:
                # Use the highest-rated verdict as the primary
                best = max(verdicts, key=lambda v: v.get("rating", 0))
                r["jury_verdict"] = {
                    "verdict": best["verdict"],
                    "rating": best["rating"],
                    "correctness": best.get("correctness"),
                    "completeness": best.get("completeness"),
                    "code_quality": best.get("code_quality"),
                    "reasoning": best.get("reasoning"),
                    "correctness_reasoning": best.get("correctness_reasoning"),
                    "completeness_reasoning": best.get("completeness_reasoning"),
                    "code_quality_reasoning": best.get("code_quality_reasoning"),
                    "jury_model": best["jury_model"],
                    "jury_method": best["jury_method"],
                }
        return results

    # ─── Helpers ─────────────────────────────────────────────────────────

    def _row_to_result(self, row: sqlite3.Row) -> dict:
        """Convert a sqlite3.Row to a result dict matching JSON format."""
        d = dict(row)
        db_id = d.pop("id", None)
        d.pop("run_id", None)

        # Parse JSON fields
        for field in ("evaluations", "workspace_files"):
            if d.get(field) and isinstance(d[field], str):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass

        if d.get("file_contents") and isinstance(d["file_contents"], str):
            try:
                d["file_contents"] = json.loads(d["file_contents"])
            except (json.JSONDecodeError, TypeError):
                pass

        if d.get("metadata") and isinstance(d["metadata"], str):
            try:
                d["metadata"] = json.loads(d["metadata"])
            except (json.JSONDecodeError, TypeError):
                pass

        # Convert boolean fields
        for field in ("passed", "timed_out"):
            if field in d:
                d[field] = bool(d[field])

        # Keep db_id for jury verdict lookups
        d["_db_id"] = db_id
        return d

    def result_count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) FROM results").fetchone()
        return row[0] if row else 0

    def run_count(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) FROM runs").fetchone()
        return row[0] if row else 0
