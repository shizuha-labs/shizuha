"""LLM jury module — uses multiple AI backends as automated judges for benchmark results.

Supported jury backends:
  - codex-xhigh: Codex CLI with gpt-5.3-xhigh (best reasoning)
  - claude-cli: Claude Code CLI with sonnet
  - anthropic-api: Direct Anthropic API (claude-sonnet-4-5)
  - all: Run all backends, majority vote
"""

import json
import os
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone

JURY_PROMPT_TEMPLATE = """\
You are a ruthlessly exacting code reviewer and benchmark judge. Your standards are \
extraordinarily high. A score of 100 should be virtually unattainable — reserved for \
flawless, production-grade work that a senior engineer would ship without a single comment \
in code review. Most good submissions should score 60-80. Even correct solutions have \
room for improvement.

## Task Information
- **Task ID**: {task_id}
- **Task Name**: {task_name}
- **Tier**: {tier}
- **Prompt given to agent**: {prompt}

## Files Created by Agent
{file_listing}

## File Contents
{file_contents}

## Ground Truth (if available)
{ground_truth}

## Automated Evaluation Results
{eval_results}

## Scoring Instructions (1-100 scale)

You MUST score on a **1-100 scale** across three dimensions. Be harsh, specific, and \
evidence-based. Do NOT give generous scores. Differentiate aggressively between agents.

### Correctness (1-100)
- Does it produce the right output? Are there ANY edge cases missed?
- Are there off-by-one errors, rounding issues, type mismatches?
- Does it handle malformed input gracefully or crash?
- Even if automated checks pass, look for subtle logical flaws.
- 90+ requires zero functional bugs. 70-89 means minor issues. Below 70 means real bugs.

### Completeness (1-100)
- Does it implement EVERYTHING the prompt asked for? Check every bullet point.
- Are there missing features, partial implementations, or TODO comments?
- Does it handle the full range of inputs, not just the happy path?
- Did the agent cut corners (e.g., hardcoded values instead of computing them)?
- 90+ requires full implementation of every requirement. 70-89 means mostly complete.

### Code Quality (1-100)
- Is the code clean, well-structured, and idiomatic for the language?
- Are variable names descriptive? Is the logic decomposed into functions?
- Does it have proper error handling, not overly broad except clauses?
- Are there unnecessary dependencies, bloated imports, or dead code?
- Is the approach efficient, or does it use a brute-force hack?
- Would you approve this in a production code review without comments?
- 90+ requires production-quality code. 70-89 is decent but with style issues. Below 70 is messy.

### Overall Rating (1-100)
- Weighted average: Correctness 40%, Completeness 30%, Code Quality 30%.
- Apply a penalty (up to -10) for: slow execution, excessive dependencies, poor UX.
- Apply a bonus (up to +5) for: elegant solutions, good documentation, robust edge case handling.

Return a JSON object with EXACTLY this structure (no markdown, no extra text):
{{
  "verdict": "pass" | "partial" | "fail",
  "rating": <1-100 overall>,
  "correctness": <1-100>,
  "correctness_reasoning": "<specific evidence: what works, what doesn't, which test cases pass/fail, any logical errors>",
  "completeness": <1-100>,
  "completeness_reasoning": "<what was implemented vs what was asked, missing features, partial implementations>",
  "code_quality": <1-100>,
  "code_quality_reasoning": "<code structure, naming, error handling, edge cases, idiomatic usage, maintainability>",
  "reasoning": "<overall 2-3 sentence summary of the verdict>"
}}

**verdict**: "pass" if rating >= 70, "partial" if rating 40-69, "fail" if rating < 40
"""

REQUIRED_FIELDS = {"verdict", "rating", "correctness", "completeness", "code_quality", "reasoning"}
OPTIONAL_FIELDS = {"correctness_reasoning", "completeness_reasoning", "code_quality_reasoning"}


def _format_file_listing(result: dict) -> str:
    files = result.get("workspace_files", [])
    if not files:
        return "(no files created)"
    kept = [f for f in files if not _should_skip_file(f)]
    skipped = len(files) - len(kept)
    listing = "\n".join(f"- {f}" for f in kept)
    if skipped:
        listing += f"\n\n({skipped} more files in .venv/node_modules/cache dirs omitted)"
    return listing


SKIP_PATTERNS = {
    "__pycache__", ".pytest_cache", ".pyc", "node_modules",
    ".git", ".DS_Store", "CACHEDIR.TAG",
    ".venv", "site-packages", ".tox", ".eggs", "dist-info",
    ".egg-info", "pip-", ".whl",
}


def _should_skip_file(path: str) -> bool:
    """Skip binary/cache files that add noise to jury review."""
    return any(pat in path for pat in SKIP_PATTERNS)


MAX_JURY_CONTENT_CHARS = 100_000  # Cap total file content to ~100KB for jury prompt


def _format_file_contents(result: dict) -> str:
    contents = result.get("file_contents", {})
    if not contents:
        return "(no file contents available)"
    parts = []
    total = 0
    for path, content in sorted(contents.items()):
        if _should_skip_file(path):
            continue
        # Truncate large files for the jury prompt
        if len(content) > 4000:
            content = content[:4000] + "\n... (truncated)"
        part = f"### {path}\n```\n{content}\n```"
        total += len(part)
        if total > MAX_JURY_CONTENT_CHARS:
            parts.append(f"... ({len(contents) - len(parts)} more files omitted for size)")
            break
        parts.append(part)
    if not parts:
        return "(only cache/binary files — no source code)"
    return "\n\n".join(parts)


def _format_eval_results(result: dict) -> str:
    evals = result.get("evaluations", [])
    if not evals:
        return "(no automated evaluations)"
    lines = []
    for ev in evals:
        icon = "PASS" if ev["passed"] else "FAIL"
        lines.append(f"- [{icon}] {ev['type']}: {ev['detail']}")
    return "\n".join(lines)


def _extract_verdict(text: str) -> dict | None:
    """Extract a verdict JSON object from text."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines).strip()

    # Try direct parse first
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            if REQUIRED_FIELDS.issubset(parsed.keys()):
                return parsed
            # Check for nested verdict object
            for v in parsed.values():
                if isinstance(v, dict) and REQUIRED_FIELDS.issubset(v.keys()):
                    return v
                elif isinstance(v, str):
                    try:
                        inner = json.loads(v)
                        if isinstance(inner, dict) and REQUIRED_FIELDS.issubset(inner.keys()):
                            return inner
                    except (json.JSONDecodeError, TypeError):
                        pass
    except json.JSONDecodeError:
        pass

    # Fallback: find JSON with balanced braces containing "verdict"
    import re
    for match in re.finditer(r'\{', text):
        start = match.start()
        depth = 0
        end = start
        for j in range(start, len(text)):
            if text[j] == '{':
                depth += 1
            elif text[j] == '}':
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
        if depth == 0 and end > start:
            candidate = text[start:end]
            if '"verdict"' in candidate:
                try:
                    parsed = json.loads(candidate)
                    if isinstance(parsed, dict) and REQUIRED_FIELDS.issubset(parsed.keys()):
                        return parsed
                except json.JSONDecodeError:
                    continue

    return None


def _jury_via_api(prompt: str) -> dict | None:
    """Call Anthropic API directly (no tools, guaranteed single response)."""
    try:
        import anthropic
    except ImportError:
        print("    anthropic SDK not installed, skipping API fallback", file=sys.stderr)
        return None

    try:
        client = anthropic.Anthropic()
        response = client.messages.create(
            model="claude-sonnet-4-5-20250929",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        return _extract_verdict(text)
    except Exception as e:
        print(f"    API fallback error: {e}", file=sys.stderr)
        return None


def _get_token_pool():
    """Get the shared Claude token pool singleton."""
    from token_pool import get_token_pool
    return get_token_pool()


def _write_claude_credentials(token: str) -> None:
    """Write a Claude OAuth credential to the host's credentials file."""
    import pathlib
    creds_path = pathlib.Path.home() / ".claude" / ".credentials.json"
    creds_path.parent.mkdir(parents=True, exist_ok=True)
    creds = {
        "claudeAiOauth": {
            "accessToken": token,
            "refreshToken": "",
            "expiresAt": 9999999999999,
            "scopes": ["user:inference"],
        }
    }
    creds_path.write_text(json.dumps(creds))


def _run_claude_cli_once(prompt: str, model: str, env: dict, timeout: int) -> tuple[dict | None, bool, str]:
    """Run Claude CLI once and return (verdict_or_none, was_rate_limited, raw_output).

    Returns:
        Tuple of (verdict dict or None, True if rate-limited, raw stdout+stderr for reset parsing).
    """
    try:
        proc = subprocess.run(
            [
                "claude",
                "-p",
                "--output-format", "json",
                "--max-turns", "1",
                "--model", model,
                "--tools", "",  # Disable all tools — jury should only produce text
            ],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )

        raw_output = (proc.stdout or "") + "\n" + (proc.stderr or "")

        # Check for rate limiting in stdout
        if "hit your limit" in proc.stdout.lower() or "rate limit" in proc.stdout.lower():
            return None, True, raw_output

        if proc.returncode != 0:
            # Check stderr for rate limiting too
            if proc.stderr and ("hit your limit" in proc.stderr.lower() or "rate limit" in proc.stderr.lower()):
                return None, True, raw_output
            print(f"    Claude CLI ({model}) error (exit {proc.returncode})", file=sys.stderr)
            if proc.stderr:
                print(f"    stderr: {proc.stderr[:200]}", file=sys.stderr)
            return None, False, raw_output

        # Parse the claude JSON output — extract the text result
        try:
            claude_output = json.loads(proc.stdout)
            text = claude_output.get("result", "")
            # Check if result itself is a rate-limit message
            if text and "hit your limit" in text.lower():
                return None, True, raw_output
            if not text:
                text = proc.stdout
        except json.JSONDecodeError:
            text = proc.stdout

        verdict = _extract_verdict(text)
        return verdict, False, raw_output

    except subprocess.TimeoutExpired:
        print(f"    Claude CLI ({model}) timed out ({timeout}s)", file=sys.stderr)
        return None, False, ""
    except FileNotFoundError:
        print("    Claude CLI not found", file=sys.stderr)
        return None, False, ""
    except Exception as e:
        print(f"    Claude CLI ({model}) error: {e}", file=sys.stderr)
        return None, False, ""


def _jury_via_cli(prompt: str, model: str = "sonnet") -> dict | None:
    """Call Claude CLI to get a jury verdict with smart token pool rotation.

    Uses the shared ClaudeTokenPool for LRU round-robin token selection,
    automatic exhaustion tracking, and stall-and-wait when all tokens are
    rate-limited.

    Args:
        prompt: The jury prompt.
        model: Claude model to use (e.g. "sonnet", "opus").
    """
    from token_pool import ClaudeTokenPool

    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
    timeout = 300 if model == "opus" else 180

    pool = _get_token_pool()

    if len(pool) == 0:
        # No token pool — run normally (uses whatever credentials are on disk)
        verdict, _, _ = _run_claude_cli_once(prompt, model, env, timeout)
        return verdict

    # Try each token + one wait cycle for exhaustion recovery
    max_attempts = len(pool) + 1
    for attempt in range(max_attempts):
        acquired = pool.acquire(max_wait=600)  # block up to 10 min if all exhausted
        if not acquired:
            print("    [pool] all tokens exhausted beyond max wait, giving up", file=sys.stderr)
            return None

        label, token = acquired
        _write_claude_credentials(token)

        verdict, rate_limited, raw_output = _run_claude_cli_once(prompt, model, env, timeout)

        if verdict is not None:
            pool.release(token, success=True)
            return verdict

        if rate_limited:
            reset_at = ClaudeTokenPool.parse_reset_time(raw_output)
            pool.release(token, success=False, usage_limited=True, reset_at=reset_at)
            print(f"    [{label}] usage-limited, rotating...", file=sys.stderr)
            continue
        else:
            pool.release(token, success=False)
            return None  # non-rate-limit failure, don't retry

    return None


def _jury_via_codex(prompt: str, model: str = "gpt-5.3-codex", reasoning_effort: str | None = None) -> dict | None:
    """Use codex exec as jury with high-reasoning model.

    Pipes the prompt via stdin (using '-' placeholder) to handle long prompts
    that would exceed command-line length limits.

    Args:
        prompt: The jury prompt.
        model: Codex model to use.
        reasoning_effort: Optional reasoning effort level (e.g. "xhigh").
    """
    try:
        cmd = [
            "codex", "exec",
            "-",
            "--model", model,
            "--json",
        ]
        if reasoning_effort:
            cmd.extend(["-c", f"model_reasoning_effort={reasoning_effort}"])
        proc = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=300,
        )

        if proc.returncode != 0:
            print(f"    Codex jury error (exit {proc.returncode})", file=sys.stderr)
            if proc.stderr:
                print(f"    stderr: {proc.stderr[:300]}", file=sys.stderr)
            return None

        # codex exec --json outputs JSONL events — find the agent_message with the verdict
        text = ""
        for line in proc.stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                # item.completed events contain agent messages
                item = event.get("item", {})
                if isinstance(item, dict) and item.get("type") == "agent_message":
                    text = item.get("text", "")
                # Also check for plain output/result/message fields
                msg = event.get("message", {})
                if isinstance(msg, dict) and msg.get("content"):
                    text = msg["content"]
                if event.get("output"):
                    text = event["output"]
                if event.get("result"):
                    text = event["result"]
            except json.JSONDecodeError:
                continue

        if not text:
            # Fallback: try entire stdout
            text = proc.stdout

        return _extract_verdict(text)

    except subprocess.TimeoutExpired:
        print("    Codex jury timed out (5min limit)", file=sys.stderr)
        return None
    except FileNotFoundError:
        print("    Codex CLI not found", file=sys.stderr)
        return None
    except Exception as e:
        print(f"    Codex jury error: {e}", file=sys.stderr)
        return None


def _build_jury_prompt(result: dict, task_prompt: str, ground_truth: str = "") -> str:
    """Build the jury review prompt from a result and task prompt."""
    prompt = JURY_PROMPT_TEMPLATE.format(
        task_id=result["task_id"],
        task_name=result["task_name"],
        tier=result["tier"],
        prompt=task_prompt,
        file_listing=_format_file_listing(result),
        file_contents=_format_file_contents(result),
        ground_truth=ground_truth or "(not provided — evaluate based on code quality and automated test results)",
        eval_results=_format_eval_results(result),
    )
    # Strip null bytes from prompt (file contents may contain them)
    return prompt.replace("\x00", "")


def jury_review_single(result: dict, task_prompt: str, jury_backend: str = "codex-xhigh", ground_truth: str = "") -> list[dict]:
    """Call AI jury to review a single benchmark result.

    Args:
        result: Benchmark result dict.
        task_prompt: The original task prompt.
        jury_backend: One of "codex-xhigh", "claude-cli", "anthropic-api", "all".
        ground_truth: Optional ground truth for verifying correctness.

    Returns:
        List of verdict dicts (one per backend used), each with jury_model and jury_method added.
    """
    prompt = _build_jury_prompt(result, task_prompt, ground_truth)

    backends = {
        "codex-xhigh": ("gpt-5.3-codex", "codex", lambda p: _jury_via_codex(p, "gpt-5.3-codex", reasoning_effort="xhigh")),
        "codex-spark-xhigh": ("gpt-5.3-codex-spark", "codex", lambda p: _jury_via_codex(p, "gpt-5.3-codex-spark", reasoning_effort="xhigh")),
        "codex-5.3": ("gpt-5.3-codex", "codex", lambda p: _jury_via_codex(p, "gpt-5.3-codex")),
        "claude-opus": ("claude-opus-4-6", "claude-cli", lambda p: _jury_via_cli(p, "opus")),
        "claude-cli": ("claude-sonnet", "claude-cli", lambda p: _jury_via_cli(p, "sonnet")),
        "anthropic-api": ("claude-sonnet-4-5", "anthropic-api", _jury_via_api),
    }

    if jury_backend == "all":
        selected = list(backends.keys())
    elif jury_backend in backends:
        selected = [jury_backend]
    else:
        print(f"    Unknown jury backend: {jury_backend}, falling back to codex-xhigh", file=sys.stderr)
        selected = ["codex-xhigh"]

    verdicts = []
    for backend_name in selected:
        model_name, method_name, fn = backends[backend_name]
        verdict = fn(prompt)
        if verdict:
            verdict["jury_model"] = model_name
            verdict["jury_method"] = method_name
            verdict["judged_at"] = datetime.now(timezone.utc).isoformat()
            verdicts.append(verdict)

    # If primary backend(s) all failed and we're not in "all" mode, try fallbacks
    if not verdicts and jury_backend != "all":
        # Try other backends as fallback
        fallback_order = ["claude-opus", "claude-cli", "anthropic-api", "codex-xhigh"]
        for fb in fallback_order:
            if fb == jury_backend:
                continue
            model_name, method_name, fn = backends[fb]
            verdict = fn(prompt)
            if verdict:
                verdict["jury_model"] = model_name
                verdict["jury_method"] = method_name
                verdict["judged_at"] = datetime.now(timezone.utc).isoformat()
                verdicts.append(verdict)
                break

    return verdicts


def majority_vote(verdicts: list[dict]) -> dict | None:
    """Given multiple jury verdicts, return the majority verdict.

    If tied, prefer the verdict from the highest-rated jury.
    """
    if not verdicts:
        return None
    if len(verdicts) == 1:
        return verdicts[0]

    # Count verdict outcomes
    votes = Counter(v["verdict"] for v in verdicts)
    winning_verdict = votes.most_common(1)[0][0]

    # Among verdicts with the winning outcome, pick the one with highest rating
    winners = [v for v in verdicts if v["verdict"] == winning_verdict]
    best = max(winners, key=lambda v: v.get("rating", 0))

    return {
        **best,
        "jury_method": "majority_vote",
        "jury_model": f"majority({','.join(v.get('jury_model', '?') for v in verdicts)})",
        "vote_breakdown": dict(votes),
    }


JURY_PER_TASK_TIMEOUT = 1200  # 20 min per task (generous, covers all retries/fallbacks)
JURY_MAX_PARALLEL = 4  # Max parallel jury evaluations


def _jury_worker(args: tuple) -> tuple[int, list[dict] | None]:
    """Worker function for parallel jury evaluation.

    Args:
        args: Tuple of (index, result, task_prompt, jury_backend, ground_truth)

    Returns:
        Tuple of (index, verdicts_list_or_none)
    """
    idx, result, task_prompt, jury_backend, ground_truth = args
    verdicts = jury_review_single(result, task_prompt, jury_backend, ground_truth)
    return idx, verdicts


def jury_review_all(
    results: list[dict],
    tasks: list[dict],
    jury_backend: str = "codex-xhigh",
    db=None,
) -> list[dict]:
    """Run jury review on all results in parallel, merging verdicts back in.

    Uses a thread pool to evaluate multiple results concurrently with per-task
    timeouts. Each task gets up to JURY_PER_TASK_TIMEOUT seconds.

    Args:
        results: List of benchmark result dicts.
        tasks: List of task definitions (for prompts).
        jury_backend: Jury backend to use.
        db: Optional BenchmarkDB instance for persisting verdicts.

    Returns:
        The same results list with jury_verdict added to each entry.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # Build task prompt and ground truth lookup
    task_prompts = {t["id"]: t["prompt"] for t in tasks}
    task_ground_truths = {t["id"]: t.get("ground_truth", "") for t in tasks}

    total = len(results)
    jury_start = time.monotonic()

    # Collect items that need judging
    work_items = []
    for i, result in enumerate(results):
        if result.get("jury_verdict"):
            print(f"  [{i+1}/{total}] {result['agent']} / {result['task_id']} — already judged, skipping")
            continue
        task_id = result["task_id"]
        prompt = task_prompts.get(task_id, "(prompt not found)")
        ground_truth = task_ground_truths.get(task_id, "")
        work_items.append((i, result, prompt, jury_backend, ground_truth))

    if not work_items:
        print("  All results already judged.")
        return results

    print(f"  Evaluating {len(work_items)} results in parallel "
          f"(max {JURY_MAX_PARALLEL} workers, {JURY_PER_TASK_TIMEOUT}s per-task timeout)...\n")

    completed = 0
    errors = 0

    with ThreadPoolExecutor(max_workers=JURY_MAX_PARALLEL) as executor:
        future_to_idx = {}
        for item in work_items:
            idx = item[0]
            future = executor.submit(_jury_worker, item)
            future_to_idx[future] = idx

        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            result = results[idx]
            task_id = result["task_id"]
            agent = result["agent"]

            try:
                _, verdicts = future.result(timeout=JURY_PER_TASK_TIMEOUT)
            except Exception as e:
                verdicts = None
                print(f"  [{idx+1}/{total}] {agent} / {task_id} — ERROR: {e}")

            if verdicts:
                if jury_backend == "all" and len(verdicts) > 1:
                    primary = majority_vote(verdicts)
                else:
                    primary = verdicts[0]

                result["jury_verdict"] = primary
                vstr = primary["verdict"].upper()
                rating = primary["rating"]
                model = primary.get("jury_model", "?")
                completed += 1
                print(f"  [{idx+1}/{total}] {agent} / {task_id} — {vstr} (rating: {rating}/100, model: {model})")

                if db and result.get("_db_id"):
                    for v in verdicts:
                        try:
                            db.save_jury_verdict(result["_db_id"], v)
                        except Exception as e:
                            print(f"    DB save error: {e}", file=sys.stderr)
            else:
                errors += 1
                result["jury_verdict"] = None
                print(f"  [{idx+1}/{total}] {agent} / {task_id} — ERROR (no verdict from any backend)")

    jury_elapsed = time.monotonic() - jury_start
    judged = sum(1 for r in results if r.get("jury_verdict"))
    print(f"\n  Jury complete: {judged}/{total} judged ({errors} errors) in {jury_elapsed:.0f}s")

    return results
