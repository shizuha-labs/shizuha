#!/usr/bin/env python3
"""SWE-bench Verified evaluation for shizuha-claude.

Runs shizuha agents against real GitHub issues from the SWE-bench Verified
dataset (500 human-validated instances). Delegates grading to the official
SWE-bench harness for comparable leaderboard scores.

Usage:
    python swebench.py --limit 10
    python swebench.py --instances sympy__sympy-20590 django__django-16379
    python swebench.py --eval-only swebench_predictions/shizuha-claude.jsonl
    python swebench.py --limit 50 --workers 4 --agent shizuha-claude

Prerequisites:
    pip install swebench datasets
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from config import get_agent, TIER_TIMEOUTS
from db import BenchmarkDB, get_git_info
from runner import run_agent_with_workspace

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "swebench_data"
REPOS_DIR = DATA_DIR / "repos"
PREDICTIONS_DIR = BASE_DIR / "swebench_predictions"
RESULTS_DIR = BASE_DIR / "swebench_results"

# SWE-bench timeout: most instances should complete in 30 minutes
# Hard cap at 45 minutes to avoid runaway containers
SWEBENCH_TIMEOUT = 2700  # 45 minutes

# Difficulty tiers based on SWE-bench metadata
DIFFICULTY_TIERS = {
    "easy": 900,      # 15 min
    "medium": 1800,   # 30 min
    "hard": 2700,     # 45 min
}

# Per-repo locks to prevent concurrent bare repo cloning
_repo_locks: dict[str, Lock] = {}
_repo_locks_lock = Lock()


def load_swebench_dataset(
    split: str = "test",
    limit: int | None = None,
    instance_ids: list[str] | None = None,
) -> list[dict]:
    """Load SWE-bench Verified instances from HuggingFace.

    Returns a list of instance dicts with keys:
        instance_id, repo, base_commit, problem_statement, hints_text,
        patch, test_patch, FAIL_TO_PASS, PASS_TO_PASS, version, etc.
    """
    try:
        from datasets import load_dataset
    except ImportError:
        print("ERROR: 'datasets' package required. Install with: pip install datasets", file=sys.stderr)
        sys.exit(1)

    print(f"Loading SWE-bench Verified dataset (split={split})...")
    ds = load_dataset("princeton-nlp/SWE-bench_Verified", split=split)
    instances = [dict(row) for row in ds]
    print(f"  Loaded {len(instances)} instances")

    if instance_ids:
        id_set = set(instance_ids)
        instances = [i for i in instances if i["instance_id"] in id_set]
        missing = id_set - {i["instance_id"] for i in instances}
        if missing:
            print(f"  WARNING: {len(missing)} instance IDs not found: {missing}", file=sys.stderr)
        print(f"  Filtered to {len(instances)} instances by ID")

    if limit and len(instances) > limit:
        instances = instances[:limit]
        print(f"  Limited to {limit} instances")

    return instances


def prepare_workspace(instance: dict) -> str:
    """Clone a repo at the correct base_commit for an SWE-bench instance.

    Uses a bare repo cache at swebench_data/repos/ to avoid re-downloading.
    Returns the path to the prepared workspace directory.
    """
    repo = instance["repo"]  # e.g. "sympy/sympy"
    base_commit = instance["base_commit"]
    instance_id = instance["instance_id"]

    # Bare repo cache (with per-repo locking to prevent concurrent clones)
    REPOS_DIR.mkdir(parents=True, exist_ok=True)
    bare_name = repo.replace("/", "__") + ".git"
    bare_path = REPOS_DIR / bare_name

    # Get or create a lock for this repo
    with _repo_locks_lock:
        if repo not in _repo_locks:
            _repo_locks[repo] = Lock()
        repo_lock = _repo_locks[repo]

    with repo_lock:
        if not bare_path.exists():
            print(f"  [{instance_id}] Cloning bare repo: {repo}...")
            result = subprocess.run(
                ["git", "clone", "--bare", f"https://github.com/{repo}.git", str(bare_path)],
                capture_output=True, text=True, timeout=600,
            )
            if result.returncode != 0:
                raise RuntimeError(f"Failed to clone {repo}: {result.stderr}")
        else:
            # Fetch latest to ensure the base_commit exists
            subprocess.run(
                ["git", "fetch", "--all"],
                capture_output=True, cwd=str(bare_path), timeout=300,
            )

    # Create workspace from bare repo
    workspace = tempfile.mkdtemp(prefix=f"swe-{instance_id}-")
    result = subprocess.run(
        ["git", "clone", str(bare_path), workspace],
        capture_output=True, text=True, timeout=300,
    )
    if result.returncode != 0:
        shutil.rmtree(workspace, ignore_errors=True)
        raise RuntimeError(f"Failed to clone from bare: {result.stderr}")

    # Checkout the base commit
    result = subprocess.run(
        ["git", "checkout", base_commit],
        capture_output=True, text=True, cwd=workspace, timeout=60,
    )
    if result.returncode != 0:
        shutil.rmtree(workspace, ignore_errors=True)
        raise RuntimeError(f"Failed to checkout {base_commit}: {result.stderr}")

    return workspace


def build_agent_prompt(instance: dict) -> str:
    """Build the agent prompt from an SWE-bench instance.

    Includes the problem statement (GitHub issue) and any available hints.
    Instructs the agent to fix the issue by modifying the repository files.
    """
    repo = instance["repo"]
    instance_id = instance["instance_id"]
    problem = instance["problem_statement"]
    hints = instance.get("hints_text", "")

    prompt_parts = [
        f"You are working on the repository: {repo}",
        f"Instance ID: {instance_id}",
        "",
        "The following GitHub issue was filed against this repository:",
        "",
        "--- ISSUE START ---",
        problem,
        "--- ISSUE END ---",
    ]

    if hints and hints.strip():
        prompt_parts.extend([
            "",
            "--- HINTS ---",
            hints,
            "--- HINTS END ---",
        ])

    prompt_parts.extend([
        "",
        "Your task is to fix the issue described above by modifying the repository files.",
        "Make the minimal changes necessary to resolve the issue.",
        "Do NOT add tests or modify test files unless the issue specifically requires it.",
        "Do NOT create new files unless absolutely necessary.",
        "Focus on fixing the bug or implementing the feature described in the issue.",
        "",
        "After making your changes, verify they work by running relevant tests if possible.",
        "The repository is already checked out at the correct commit in /workspace.",
    ])

    return "\n".join(prompt_parts)


def extract_patch(workspace: str) -> str:
    """Extract the git diff from the workspace as the model's patch."""
    result = subprocess.run(
        ["git", "diff", "HEAD"],
        capture_output=True, text=True, cwd=workspace, timeout=30,
    )
    return result.stdout if result.returncode == 0 else ""


def run_swebench_instance(
    agent_name: str,
    instance: dict,
    timeout: int = SWEBENCH_TIMEOUT,
    event_callback=None,
) -> dict:
    """Run a single SWE-bench instance and return the result dict.

    Returns a dict with keys: instance_id, agent, model, passed (None until eval),
    model_patch, elapsed_seconds, timed_out, error, metadata.
    """
    instance_id = instance["instance_id"]
    agent = get_agent(agent_name)
    workspace = None
    start = time.monotonic()

    try:
        # Prepare workspace
        workspace = prepare_workspace(instance)

        # Build prompt
        prompt = build_agent_prompt(instance)

        # Build task dict for runner
        task = {
            "id": instance_id,
            "name": f"SWE-bench: {instance_id}",
            "tier": "hard",
            "prompt": prompt,
        }

        # Run agent
        run_result = run_agent_with_workspace(
            agent=agent,
            task=task,
            workspace=workspace,
            timeout_override=timeout,
            event_callback=event_callback,
        )

        # Extract patch
        model_patch = extract_patch(workspace)
        elapsed = time.monotonic() - start

        return {
            "instance_id": instance_id,
            "agent": agent_name,
            "model": agent.model,
            "model_patch": model_patch,
            "passed": None,  # Set after eval
            "elapsed_seconds": round(elapsed, 2),
            "timed_out": run_result.timed_out,
            "error": None,
            "exit_code": run_result.exit_code,
            "stdout": run_result.stdout,
            "stderr": run_result.stderr,
            "metadata": {
                "repo": instance["repo"],
                "base_commit": instance["base_commit"],
                "version": instance.get("version", ""),
            },
        }

    except Exception as e:
        elapsed = time.monotonic() - start
        return {
            "instance_id": instance_id,
            "agent": agent_name,
            "model": agent.model if 'agent' in dir() else "",
            "model_patch": "",
            "passed": False,
            "elapsed_seconds": round(elapsed, 2),
            "timed_out": False,
            "error": str(e),
            "exit_code": -1,
            "stdout": "",
            "stderr": str(e),
            "metadata": {
                "repo": instance["repo"],
                "base_commit": instance["base_commit"],
                "version": instance.get("version", ""),
            },
        }

    finally:
        # Cleanup workspace (but keep patch)
        if workspace and os.path.isdir(workspace):
            try:
                shutil.rmtree(workspace)
            except Exception:
                pass


def write_predictions(results: list[dict], output_path: Path):
    """Write predictions in SWE-bench JSONL format for the eval harness."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        for r in results:
            prediction = {
                "instance_id": r["instance_id"],
                "model_patch": r.get("model_patch", ""),
                "model_name_or_path": f"{r['agent']}-{r['model']}",
            }
            f.write(json.dumps(prediction) + "\n")
    print(f"Wrote {len(results)} predictions to {output_path}")


def load_predictions(path: Path) -> list[dict]:
    """Load predictions from a JSONL file."""
    predictions = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                predictions.append(json.loads(line))
    return predictions


def _parse_report(data: dict) -> dict:
    """Parse a SWE-bench v4 report JSON into eval_results dict."""
    results = {}
    # v4 schema uses *_ids suffix (e.g. resolved_ids, unresolved_ids)
    # Earlier versions used plain names (resolved, unresolved)
    for key in ("resolved_ids", "resolved"):
        for iid in data.get(key, []):
            results[iid] = {"resolved": True}
    for key in ("unresolved_ids", "unresolved"):
        for iid in data.get(key, []):
            results[iid] = {"resolved": False}
    for key in ("error_ids", "error"):
        for iid in data.get(key, []):
            results[iid] = {"resolved": False}
    return results


def _check_swebench_installed():
    """Check that the swebench package is installed (not our own swebench.py)."""
    swebench_pkg = Path(sys.prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages" / "swebench"
    if not swebench_pkg.is_dir():
        print("ERROR: 'swebench' package required. Install with: pip install swebench", file=sys.stderr)
        sys.exit(1)


def _run_eval_harness(
    predictions_path: Path,
    output_dir: Path,
    instance_ids: list[str] | None = None,
) -> dict:
    """Run the SWE-bench evaluation harness and parse the report.

    Args:
        predictions_path: Path to the JSONL predictions file.
        output_dir: Directory for reports.
        instance_ids: If set, only evaluate these instances.

    Returns a dict mapping instance_id -> {"resolved": bool}.
    """
    report_dir = output_dir.resolve() / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)

    run_id = f"shizuha-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--predictions_path", str(predictions_path.resolve()),
        "--dataset_name", "princeton-nlp/SWE-bench_Verified",
        "--run_id", run_id,
        "--max_workers", "1",
        "--timeout", "900",
        "--cache_level", "env",
        "--report_dir", str(report_dir),
    ]
    if instance_ids:
        cmd.extend(["--instance_ids"] + instance_ids)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600, cwd="/tmp")

    if result.returncode != 0:
        print(f"  EVAL WARNING: harness exited with code {result.returncode}", file=sys.stderr)

    # Parse results from the report JSON
    eval_results = {}
    report_found = False
    search_dirs = [Path("/tmp"), report_dir]
    for search_dir in search_dirs:
        if report_found:
            break
        for rfile in search_dir.glob(f"*{run_id}*.json"):
            try:
                with open(rfile) as f:
                    data = json.load(f)
                eval_results = _parse_report(data)
                if eval_results:
                    report_found = True
                    break
            except Exception:
                continue

    if not report_found:
        for rfile in report_dir.glob("*.json"):
            try:
                with open(rfile) as f:
                    data = json.load(f)
                eval_results = _parse_report(data)
                if eval_results:
                    break
            except Exception:
                continue

    return eval_results


def _cleanup_eval_temps(instance_id: str) -> None:
    """Remove temp directories left behind by the SWE-bench eval harness."""
    import glob
    # The harness creates /tmp/swe-eval-<instance_id>-* dirs and
    # also /tmp/<run_id>/ style dirs. Clean up anything matching this instance.
    patterns = [
        f"/tmp/swe-eval-{instance_id}-*",
        f"/tmp/swe-{instance_id}-*",
    ]
    for pat in patterns:
        for d in glob.glob(pat):
            try:
                if os.path.isdir(d):
                    shutil.rmtree(d, ignore_errors=True)
                else:
                    os.unlink(d)
            except Exception:
                pass


def eval_single_instance(
    instance_id: str,
    model_patch: str,
    agent_name: str,
    model_name: str,
    output_dir: Path | None = None,
) -> bool | None:
    """Evaluate a single SWE-bench instance immediately after its agent run.

    Writes a temp JSONL, runs the harness with --instance_ids for just this one,
    and returns True (resolved), False (unresolved), or None (eval error).
    """
    if not model_patch.strip():
        return False  # No patch = definitely not resolved

    if output_dir is None:
        output_dir = RESULTS_DIR
    output_dir.mkdir(parents=True, exist_ok=True)

    # Write a temp predictions file for this single instance
    tmp_pred = tempfile.NamedTemporaryFile(
        mode="w", suffix=".jsonl", prefix=f"swe-eval-{instance_id}-", delete=False,
    )
    try:
        prediction = {
            "instance_id": instance_id,
            "model_patch": model_patch,
            "model_name_or_path": f"{agent_name}-{model_name}",
        }
        tmp_pred.write(json.dumps(prediction) + "\n")
        tmp_pred.close()

        eval_results = _run_eval_harness(
            Path(tmp_pred.name), output_dir, instance_ids=[instance_id],
        )

        if instance_id in eval_results:
            return eval_results[instance_id]["resolved"]
        return None  # Eval didn't produce a result for this instance
    except Exception as e:
        print(f"  [{instance_id}] EVAL ERROR: {e}", file=sys.stderr)
        return None
    finally:
        try:
            os.unlink(tmp_pred.name)
        except Exception:
            pass
        # Clean up SWE-bench eval temp dirs to prevent disk exhaustion
        _cleanup_eval_temps(instance_id)


def run_swebench_eval(predictions_path: Path, output_dir: Path | None = None) -> dict:
    """Run the official SWE-bench evaluation harness on predictions (batch mode).

    Returns a dict mapping instance_id -> {"resolved": bool}.
    """
    _check_swebench_installed()

    if output_dir is None:
        output_dir = RESULTS_DIR

    print(f"\nRunning SWE-bench evaluation harness on {predictions_path}...")
    print("  This will build Docker images and run tests for each prediction.")
    print("  This may take a long time (minutes per instance).\n")

    eval_results = _run_eval_harness(predictions_path, output_dir)

    resolved = sum(1 for v in eval_results.values() if v["resolved"])
    print(f"\nEval complete: {resolved}/{len(eval_results)} resolved")
    return eval_results


def import_to_db(
    results: list[dict],
    eval_results: dict | None,
    agent_name: str,
    db: BenchmarkDB,
) -> int:
    """Import SWE-bench results into the benchmark database (batch mode).

    Used by --eval-only. For live runs, results are saved incrementally.
    Returns the run_id.
    """
    git_info = get_git_info()
    run_id = db.create_run(
        agents=[agent_name],
        task_filter="swebench-verified",
        total_pairs=len(results),
        git_info=git_info,
        metadata={"benchmark": "swebench-verified", "total_instances": len(results)},
    )

    resolved_count = 0
    for r in results:
        instance_id = r["instance_id"]
        passed_override = None
        if eval_results and instance_id in eval_results:
            passed_override = eval_results[instance_id]["resolved"]
        _save_result_to_db(db, run_id, r, passed_override=passed_override)
        if passed_override:
            resolved_count += 1

    db.finish_run(run_id)
    total = len(results) or 1
    print(f"\nImported {len(results)} results to DB (run_id={run_id})")
    print(f"  Resolved: {resolved_count}/{len(results)} ({resolved_count/total*100:.1f}%)")
    return run_id


def _save_result_to_db(
    db: BenchmarkDB, run_id: int, r: dict, passed_override: bool | None = None,
):
    """Save a single SWE-bench result to the database (upsert)."""
    instance_id = r["instance_id"]
    if passed_override is not None:
        passed = passed_override
    elif r.get("passed") is not None:
        passed = r["passed"]
    else:
        # Before eval, mark as False with "pending_eval" in evaluations
        passed = False

    has_patch = bool(r.get("model_patch", "").strip())
    db.save_result(run_id, {
        "agent": r.get("agent", ""),
        "model": r.get("model", ""),
        "task_id": instance_id,
        "task_name": f"SWE-bench: {instance_id}",
        "tier": "swebench",
        "passed": passed,
        "score": 1.0 if passed else 0.0,
        "elapsed_seconds": r.get("elapsed_seconds", 0),
        "timed_out": r.get("timed_out", False),
        "evaluations": [{"type": "swebench", "has_patch": has_patch, "resolved": passed}],
        "stdout": r.get("stdout", ""),
        "stderr": r.get("stderr", ""),
        "metadata": r.get("metadata"),
    })


def run_swebench(
    agent_name: str = "shizuha-claude",
    limit: int | None = None,
    instance_ids: list[str] | None = None,
    workers: int = 2,
    timeout: int = SWEBENCH_TIMEOUT,
    resume_path: Path | None = None,
    no_eval: bool = False,
    eval_only: Path | None = None,
):
    """Main SWE-bench evaluation flow."""

    # ── Eval-only mode ──
    if eval_only:
        print(f"Eval-only mode: {eval_only}")
        eval_results = run_swebench_eval(eval_only)
        predictions = load_predictions(eval_only)
        results = []
        for p in predictions:
            results.append({
                "instance_id": p["instance_id"],
                "agent": agent_name,
                "model": "",
                "model_patch": p.get("model_patch", ""),
                "passed": eval_results.get(p["instance_id"], {}).get("resolved", False),
                "elapsed_seconds": 0,
                "timed_out": False,
                "metadata": {},
            })
        db = BenchmarkDB()
        import_to_db(results, eval_results, agent_name, db)
        return

    # ── Pre-check eval harness availability ──
    if not no_eval:
        _check_swebench_installed()

    # ── Load dataset ──
    instances = load_swebench_dataset(limit=limit, instance_ids=instance_ids)
    if not instances:
        print("No instances to run.", file=sys.stderr)
        return

    # ── Resume from partial run ──
    completed_ids: set[str] = set()
    results: list[dict] = []
    if resume_path and resume_path.exists():
        print(f"Resuming from {resume_path}")
        for line in open(resume_path):
            line = line.strip()
            if line:
                r = json.loads(line)
                completed_ids.add(r["instance_id"])
                results.append(r)
        print(f"  Loaded {len(completed_ids)} completed instances")

    remaining = [i for i in instances if i["instance_id"] not in completed_ids]
    total_instances = len(remaining) + len(completed_ids)
    print(f"\nRunning {len(remaining)} instances with {workers} workers (timeout={timeout}s)")
    print(f"Agent: {agent_name}\n")

    # ── Create DB run record upfront for live dashboard visibility ──
    db = BenchmarkDB()
    git_info = get_git_info()
    run_id = db.create_run(
        agents=[agent_name],
        task_filter="swebench-verified",
        total_pairs=total_instances,
        git_info=git_info,
        metadata={"benchmark": "swebench-verified", "total_instances": total_instances},
    )
    print(f"  DB run_id={run_id} (live on dashboard)\n")

    # Import already-completed results from resume
    for r in results:
        _save_result_to_db(db, run_id, r)

    # ── Predictions file for incremental writes ──
    PREDICTIONS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    predictions_path = resume_path or (PREDICTIONS_DIR / f"{agent_name}-{timestamp}.jsonl")
    write_lock = Lock()

    def process_instance(instance: dict) -> dict:
        instance_id = instance["instance_id"]
        print(f"  [{instance_id}] Starting...")
        result = run_swebench_instance(
            agent_name=agent_name,
            instance=instance,
            timeout=timeout,
        )
        status = "TIMEOUT" if result["timed_out"] else ("ERROR" if result.get("error") else "OK")
        patch_lines = len(result.get("model_patch", "").splitlines())
        print(f"  [{instance_id}] {status} ({result['elapsed_seconds']:.0f}s, {patch_lines} patch lines)")

        # ── Evaluate immediately after agent run ──
        resolved = None
        if not no_eval and result.get("model_patch", "").strip() and not result.get("error"):
            print(f"  [{instance_id}] Evaluating...")
            eval_start = time.monotonic()
            resolved = eval_single_instance(
                instance_id=instance_id,
                model_patch=result["model_patch"],
                agent_name=agent_name,
                model_name=result.get("model", ""),
            )
            eval_time = time.monotonic() - eval_start
            verdict = "RESOLVED" if resolved else ("UNRESOLVED" if resolved is False else "EVAL_ERROR")
            print(f"  [{instance_id}] {verdict} (eval {eval_time:.0f}s)")
            if resolved is not None:
                result["passed"] = resolved

        # Append to predictions file and save to DB atomically
        with write_lock:
            with open(predictions_path, "a") as f:
                prediction = {
                    "instance_id": instance_id,
                    "model_patch": result.get("model_patch", ""),
                    "model_name_or_path": f"{result['agent']}-{result.get('model', '')}",
                }
                f.write(json.dumps(prediction) + "\n")
            # Save to DB with eval result (or pending if eval failed)
            _save_result_to_db(db, run_id, result, passed_override=resolved)

        return result

    # ── Run instances in parallel ──
    start_time = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(process_instance, inst): inst for inst in remaining}
        try:
            for future in as_completed(futures):
                instance = futures[future]
                try:
                    result = future.result()
                    results.append(result)
                    done = len(results)
                    print(f"  Progress: {done}/{total_instances}")
                except Exception as e:
                    print(f"  [{instance['instance_id']}] EXCEPTION: {e}", file=sys.stderr)
                    err_result = {
                        "instance_id": instance["instance_id"],
                        "agent": agent_name,
                        "model": "",
                        "model_patch": "",
                        "passed": False,
                        "elapsed_seconds": 0,
                        "timed_out": False,
                        "error": str(e),
                        "metadata": {
                            "repo": instance["repo"],
                            "base_commit": instance["base_commit"],
                        },
                    }
                    results.append(err_result)
                    with write_lock:
                        _save_result_to_db(db, run_id, err_result)
        except KeyboardInterrupt:
            print("\n\nInterrupted! Saving partial results...")
            executor.shutdown(wait=False, cancel_futures=True)

    total_elapsed = time.monotonic() - start_time

    # ── Summary ──
    errors = sum(1 for r in results if r.get("error"))
    timeouts = sum(1 for r in results if r.get("timed_out"))
    has_patch = sum(1 for r in results if r.get("model_patch", "").strip())
    already_evaled = sum(1 for r in results if r.get("passed") is not None)
    resolved_inline = sum(1 for r in results if r.get("passed") is True)
    print(f"\n{'='*60}")
    print(f"SWE-bench run complete: {len(results)} instances in {total_elapsed:.0f}s")
    print(f"  Patches generated: {has_patch}/{len(results)}")
    print(f"  Evaluated inline: {already_evaled} ({resolved_inline} resolved)")
    print(f"  Timeouts: {timeouts}")
    print(f"  Errors: {errors}")
    print(f"  Predictions: {predictions_path}")
    print(f"{'='*60}")

    # ── Batch eval for any unevaluated instances ──
    unevaled = [r for r in results if r.get("passed") is None and r.get("model_patch", "").strip()]
    eval_results = None
    if not no_eval and unevaled:
        print(f"\nRunning batch eval for {len(unevaled)} unevaluated instances...")
        try:
            eval_results = run_swebench_eval(predictions_path)
        except Exception as e:
            print(f"\nWARNING: Eval harness failed: {e}", file=sys.stderr)
            print("You can run eval later with: python swebench.py --eval-only", predictions_path)
    elif no_eval:
        print("\nSkipping evaluation (--no-eval). Run later with:")
        print(f"  python swebench.py --eval-only {predictions_path}")

    # ── Update DB with batch eval results (only for unevaluated) ──
    if eval_results:
        for r in unevaled:
            iid = r["instance_id"]
            if iid in eval_results:
                resolved = eval_results[iid]["resolved"]
                r["passed"] = resolved
                _save_result_to_db(db, run_id, r, passed_override=resolved)

    db.finish_run(run_id)

    # ── Final score ──
    total_resolved = sum(1 for r in results if r.get("passed") is True)
    total_evaled = sum(1 for r in results if r.get("passed") is not None)
    if total_evaled > 0:
        print(f"\n*** SWE-bench Verified Score: {total_resolved}/{total_evaled} ({total_resolved/total_evaled*100:.1f}%) ***")


def main():
    parser = argparse.ArgumentParser(
        description="Run SWE-bench Verified evaluation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python swebench.py --limit 10                          # Run 10 instances
  python swebench.py --instances sympy__sympy-20590      # Run specific instance
  python swebench.py --limit 50 --workers 4              # Parallel execution
  python swebench.py --eval-only predictions.jsonl       # Grade existing predictions
  python swebench.py --limit 10 --no-eval                # Generate patches only
  python swebench.py --resume predictions.jsonl --limit 50  # Resume partial run
        """,
    )
    parser.add_argument(
        "--agent", default="shizuha-claude",
        help="Agent to evaluate (default: shizuha-claude)",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Maximum number of instances to run",
    )
    parser.add_argument(
        "--instances", nargs="+", default=None,
        help="Specific instance IDs to run (e.g. sympy__sympy-20590)",
    )
    parser.add_argument(
        "--workers", type=int, default=2,
        help="Number of parallel workers (default: 2)",
    )
    parser.add_argument(
        "--timeout", type=int, default=SWEBENCH_TIMEOUT,
        help=f"Per-instance timeout in seconds (default: {SWEBENCH_TIMEOUT})",
    )
    parser.add_argument(
        "--resume", type=Path, default=None,
        help="Resume from a partial predictions JSONL file",
    )
    parser.add_argument(
        "--eval-only", type=Path, default=None,
        help="Only run evaluation on existing predictions JSONL",
    )
    parser.add_argument(
        "--no-eval", action="store_true",
        help="Skip evaluation (generate patches only)",
    )

    args = parser.parse_args()

    run_swebench(
        agent_name=args.agent,
        limit=args.limit,
        instance_ids=args.instances,
        workers=args.workers,
        timeout=args.timeout,
        resume_path=args.resume,
        no_eval=args.no_eval,
        eval_only=args.eval_only,
    )


if __name__ == "__main__":
    main()
