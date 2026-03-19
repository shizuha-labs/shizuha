"""HTML report generation from JSON results using Jinja2."""

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from config import TEMPLATE_DIR, REPORTS_DIR


def load_results(results_file: Path) -> list[dict]:
    """Load results from a JSON file."""
    with open(results_file) as f:
        return json.load(f)


def compute_agent_stats(results: list[dict], agents: list[str], tasks: list[dict]) -> list[dict]:
    """Compute per-agent statistics for the report."""
    # Group results by agent
    by_agent = defaultdict(list)
    for r in results:
        by_agent[r["agent"]].append(r)

    agent_stats = []
    for agent_name in agents:
        agent_results = by_agent.get(agent_name, [])

        # Overall stats
        total = len(agent_results)
        passed = sum(1 for r in agent_results if r["passed"])
        pct = round(passed / total * 100) if total else 0

        # Per-tier stats
        tier_stats = {}
        for tier in ["easy", "medium", "hard", "extreme", "nightmare", "impossible"]:
            tier_results = [r for r in agent_results if r["tier"] == tier]
            t_total = len(tier_results)
            t_passed = sum(1 for r in tier_results if r["passed"])
            t_pct = round(t_passed / t_total * 100) if t_total else 0
            tier_stats[tier] = {"passed": t_passed, "total": t_total, "pct": t_pct}

        # Get model/version from first result
        model = agent_results[0]["model"] if agent_results else "unknown"
        version = agent_results[0]["agent_version"] if agent_results else "unknown"

        # Jury stats
        jury_verdicts = [r["jury_verdict"] for r in agent_results if r.get("jury_verdict")]
        jury_stats = None
        if jury_verdicts:
            jury_pass = sum(1 for v in jury_verdicts if v.get("verdict") == "pass")
            jury_partial = sum(1 for v in jury_verdicts if v.get("verdict") == "partial")
            jury_fail = sum(1 for v in jury_verdicts if v.get("verdict") == "fail")
            jury_total = len(jury_verdicts)
            jury_pct = round(jury_pass / jury_total * 100) if jury_total else 0
            avg_rating = sum(v.get("rating", 0) for v in jury_verdicts) / jury_total
            avg_correctness = sum(v.get("correctness", 0) for v in jury_verdicts) / jury_total
            avg_completeness = sum(v.get("completeness", 0) for v in jury_verdicts) / jury_total
            avg_code_quality = sum(v.get("code_quality", 0) for v in jury_verdicts) / jury_total
            jury_stats = {
                "pass": jury_pass,
                "partial": jury_partial,
                "fail": jury_fail,
                "total": jury_total,
                "pct": jury_pct,
                "avg_rating": round(avg_rating, 1),
                "avg_correctness": round(avg_correctness, 1),
                "avg_completeness": round(avg_completeness, 1),
                "avg_code_quality": round(avg_code_quality, 1),
            }

        agent_stats.append({
            "name": agent_name,
            "model": model,
            "version": version,
            "overall_passed": passed,
            "overall_total": total,
            "overall_pct": pct,
            "tier_stats": tier_stats,
            "jury_stats": jury_stats,
        })

    return agent_stats


def build_results_map(results: list[dict]) -> dict:
    """Build a task_id -> agent_name -> result mapping."""
    results_map = defaultdict(dict)
    for r in results:
        results_map[r["task_id"]][r["agent"]] = r
    return dict(results_map)


def generate_report(results: list[dict], tasks: list[dict], output_path: Path | None = None) -> Path:
    """Generate an HTML report from benchmark results.

    Args:
        results: List of result dicts (one per agent-task pair).
        tasks: List of task definitions.
        output_path: Optional path for the report. Auto-generated if None.

    Returns:
        Path to the generated HTML report.
    """
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    if output_path is None:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        output_path = REPORTS_DIR / f"report-{ts}.html"

    # Collect unique agents in order
    seen = {}
    agent_names = []
    for r in results:
        if r["agent"] not in seen:
            seen[r["agent"]] = True
            agent_names.append(r["agent"])

    agents = compute_agent_stats(results, agent_names, tasks)
    results_map = build_results_map(results)

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=True,
    )
    template = env.get_template("report.html.j2")

    html = template.render(
        timestamp=timestamp,
        task_count=len(tasks),
        agents=agents,
        tasks=tasks,
        results_map=results_map,
    )

    output_path.write_text(html)
    return output_path
