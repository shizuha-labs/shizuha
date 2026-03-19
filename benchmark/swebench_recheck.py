#!/usr/bin/env python3
"""Re-check SWE-bench instances that never passed.

Purpose:
- Find instances for an agent that have NEVER passed across previous swebench runs.
- Re-run official SWE-bench evaluation for instances that already have patches.
- Save incremental progress to both DB and a JSON state file, so interrupted runs can resume.

This avoids the 1-hour timeout of evaluating all 500 instances in one harness invocation.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from db import BenchmarkDB, get_git_info
from swebench import eval_single_instance, _save_result_to_db


def load_predictions_map(path: Path) -> dict[str, str]:
    m: dict[str, str] = {}
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            iid = row.get("instance_id")
            patch = row.get("model_patch", "")
            if iid:
                m[iid] = patch
    return m


def get_target_instances(db: BenchmarkDB, agent_name: str) -> tuple[list[str], list[str]]:
    """Return (with_patch_never_passed, no_patch_never_passed)."""
    cur = db._conn.cursor()
    run_rows = cur.execute(
        """
        SELECT id
        FROM runs
        WHERE task_filter='swebench-verified' AND agents = ?
        """,
        (json.dumps([agent_name]),),
    ).fetchall()

    run_ids = [r[0] for r in run_rows]
    if not run_ids:
        return [], []

    placeholders = ",".join("?" * len(run_ids))
    rows = cur.execute(
        f"""
        SELECT
          task_id,
          MAX(CASE WHEN passed=1 THEN 1 ELSE 0 END) AS ever_pass,
          MAX(CASE WHEN json_extract(evaluations, '$[0].has_patch')=1 THEN 1 ELSE 0 END) AS ever_patch
        FROM results
        WHERE run_id IN ({placeholders}) AND tier='swebench'
        GROUP BY task_id
        """,
        run_ids,
    ).fetchall()

    with_patch = []
    no_patch = []
    for task_id, ever_pass, ever_patch in rows:
        if ever_pass:
            continue
        if ever_patch:
            with_patch.append(task_id)
        else:
            no_patch.append(task_id)

    return sorted(with_patch), sorted(no_patch)


def main():
    parser = argparse.ArgumentParser(description="Re-check never-passed SWE-bench instances")
    parser.add_argument("--agent", default="shizuha-codex-xhigh")
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--state", type=Path, default=Path("swebench_results/recheck_state.json"))
    parser.add_argument("--limit", type=int, default=None, help="Optional cap for this run")
    args = parser.parse_args()

    db = BenchmarkDB()
    preds = load_predictions_map(args.predictions)

    with_patch, no_patch = get_target_instances(db, args.agent)

    print(f"Agent: {args.agent}")
    print(f"Never-passed with patch: {len(with_patch)}")
    print(f"Never-passed without patch: {len(no_patch)}")

    if args.limit:
        with_patch = with_patch[: args.limit]
        print(f"Applying --limit => evaluating first {len(with_patch)} with-patch instances")

    args.state.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "agent": args.agent,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "run_id": None,
        "done": {},
        "skipped_no_patch": no_patch,
    }
    if args.state.exists():
        try:
            state = json.loads(args.state.read_text())
        except Exception:
            pass

    run_id = state.get("run_id")
    if not run_id:
        run_id = db.create_run(
            agents=[args.agent],
            task_filter="swebench-recheck-never-passed",
            total_pairs=len(with_patch),
            git_info=get_git_info(),
            metadata={
                "benchmark": "swebench-recheck",
                "source_predictions": str(args.predictions),
                "target_count": len(with_patch),
            },
        )
        state["run_id"] = run_id
        args.state.write_text(json.dumps(state, indent=2) + "\n")

    done: dict = state.get("done", {})

    processed = 0
    for idx, instance_id in enumerate(with_patch, start=1):
        if instance_id in done:
            continue

        patch = preds.get(instance_id, "")
        if not patch.strip():
            done[instance_id] = {
                "status": "missing_patch",
                "resolved": None,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
            state["done"] = done
            args.state.write_text(json.dumps(state, indent=2) + "\n")
            continue

        print(f"[{idx}/{len(with_patch)}] Evaluating {instance_id} ...", flush=True)
        t0 = time.monotonic()
        resolved = eval_single_instance(
            instance_id=instance_id,
            model_patch=patch,
            agent_name=args.agent,
            model_name="gpt-5.3-codex",
        )
        elapsed = round(time.monotonic() - t0, 1)

        row = {
            "instance_id": instance_id,
            "agent": args.agent,
            "model": "gpt-5.3-codex",
            "model_patch": patch,
            "passed": bool(resolved) if resolved is not None else False,
            "elapsed_seconds": elapsed,
            "timed_out": False,
            "stdout": "",
            "stderr": "",
            "metadata": {
                "source": "swebench_recheck",
                "rechecked_at": datetime.now(timezone.utc).isoformat(),
            },
        }
        _save_result_to_db(db, run_id, row, passed_override=resolved if resolved is not None else False)

        done[instance_id] = {
            "status": "ok" if resolved is not None else "eval_error",
            "resolved": resolved,
            "elapsed_seconds": elapsed,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        state["done"] = done
        args.state.write_text(json.dumps(state, indent=2) + "\n")
        processed += 1

        verdict = "RESOLVED" if resolved else ("UNRESOLVED" if resolved is False else "EVAL_ERROR")
        print(f"    -> {verdict} in {elapsed}s", flush=True)

    # Finish run when all selected targets are done
    remaining = [iid for iid in with_patch if iid not in done]
    if not remaining:
        db.finish_run(run_id)
        print(f"Finished run {run_id}")
    else:
        print(f"Partial progress saved. Remaining: {len(remaining)}")

    print(f"Processed this invocation: {processed}")
    print(f"State file: {args.state}")
    print(f"Skipped (no patch): {len(no_patch)}")


if __name__ == "__main__":
    main()
