#!/usr/bin/env python3
"""Rerun SWE-bench only for instances that have never passed for an agent.

This computes target IDs from benchmark.db (across all swebench-verified runs
for the agent), then calls swebench.run_swebench with --instances equivalent.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from swebench import run_swebench


def never_passed_instance_ids(db_path: Path, agent: str) -> list[str]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    run_ids = [
        r[0]
        for r in cur.execute(
            "SELECT id FROM runs WHERE task_filter='swebench-verified' AND agents=? ORDER BY id",
            (json.dumps([agent]),),
        ).fetchall()
    ]
    if not run_ids:
        conn.close()
        return []

    placeholders = ",".join("?" * len(run_ids))
    rows = cur.execute(
        f"""
        SELECT
          task_id,
          MAX(CASE WHEN passed=1 THEN 1 ELSE 0 END) AS ever_pass
        FROM results
        WHERE run_id IN ({placeholders}) AND tier='swebench'
        GROUP BY task_id
        ORDER BY task_id
        """,
        run_ids,
    ).fetchall()
    conn.close()

    return [r["task_id"] for r in rows if not r["ever_pass"]]


def main() -> None:
    parser = argparse.ArgumentParser(description="Rerun never-passed SWE-bench instances")
    parser.add_argument("--agent", default="shizuha-codex-xhigh")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=2700)
    parser.add_argument(
        "--resume",
        type=Path,
        default=Path("swebench_predictions/shizuha-codex-xhigh-never-passed-resume.jsonl"),
    )
    parser.add_argument("--db", type=Path, default=Path("benchmark.db"))
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    ids = never_passed_instance_ids(args.db, args.agent)
    if args.limit:
        ids = ids[: args.limit]

    print(f"agent={args.agent}")
    print(f"never_passed_ids={len(ids)}")
    print(f"resume_file={args.resume}")
    if not ids:
        print("Nothing to run.")
        return

    run_swebench(
        agent_name=args.agent,
        instance_ids=ids,
        workers=args.workers,
        timeout=args.timeout,
        resume_path=args.resume,
        no_eval=False,
        eval_only=None,
    )


if __name__ == "__main__":
    main()
