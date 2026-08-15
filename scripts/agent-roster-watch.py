#!/usr/bin/env python3
"""AT-113: Alert CoS when a running agent appears on the roster without an onboarding record.

Compares GET /v1/agents (daemon API) against the attributed-agents baseline file.
Any running agent not in the baseline triggers:
  - A Connect DM alert to shizuha via POST /v1/agents/shizuha/message
  - A deduplicated alert (skips re-alerting agents already in the seen-alerts file)

Run periodically (hourly/daily via systemd timer). Daemon must be running at DAEMON_URL.
Add newly onboarded agents to agent-roster-baseline.json to silence their alerts.
"""

import json, os, sys, time, urllib.request, urllib.error

DAEMON_URL   = os.environ.get("SHIZUHA_DAEMON_URL", "http://localhost:8015")
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
BASELINE_PATH = os.path.join(SCRIPT_DIR, "agent-roster-baseline.json")
SEEN_PATH    = os.path.expanduser("~/.shizuha/roster-watch-seen.json")


def fetch(url: str, method: str = "GET", body: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def load_json(path: str, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def main() -> None:
    baseline = load_json(BASELINE_PATH, None)
    if baseline is None:
        print(f"[roster-watch] FATAL: baseline not found: {BASELINE_PATH}", file=sys.stderr)
        sys.exit(1)
    attributed: set[str] = set(baseline.get("attributed_usernames", []))
    if not attributed:
        print(
            "[roster-watch] FATAL: baseline attributed_usernames is empty — "
            "refusing to run (would false-alarm on every running agent). "
            "Populate scripts/agent-roster-baseline.json first.",
            file=sys.stderr,
        )
        sys.exit(1)
    seen: dict = load_json(SEEN_PATH, {})

    try:
        data = fetch(f"{DAEMON_URL}/v1/agents")
    except Exception as e:
        print(f"[roster-watch] daemon unreachable: {e}", file=sys.stderr)
        sys.exit(0)  # soft-exit: don't false-alarm if daemon is temporarily down

    agents = data.get("agents", [])
    running = [a for a in agents if a.get("status") == "running"]

    gaps: list[str] = []
    for agent in running:
        username = agent.get("username", "")
        if not username:
            continue
        if username in attributed:
            continue
        # Check dedup: skip if already alerted this calendar day
        last_alerted = seen.get(username, "")
        today = time.strftime("%Y-%m-%d")
        if last_alerted == today:
            continue
        gaps.append(username)
        seen[username] = today

    if not gaps:
        print(f"[roster-watch] OK — {len(running)} running agents, all attributed.")
        return

    gap_list = ", ".join(f"@{u}" for u in gaps)
    alert_msg = (
        f"[roster-watch] Unattributed running agent(s) detected: {gap_list}\n"
        "These agents are running but have no entry in the onboarding baseline. "
        "Please create an Agent Onboarding Record in the EVOL wiki (see EVOL-19 / Shion precedents) "
        "or add them to scripts/agent-roster-baseline.json if they are charter-fleet members. "
        f"AT-113 / PLAT-243."
    )

    print(f"[roster-watch] ALERT: {gap_list}")

    try:
        sender = os.environ.get("AGENT_USERNAME", "sara")
        body = json.dumps({"content": alert_msg, "from_agent": sender}).encode()
        fetch(
            f"{DAEMON_URL}/v1/agents/shizuha/message",
            method="POST",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        save_json(SEEN_PATH, seen)
        print(f"[roster-watch] Alert sent to shizuha.")
    except Exception as e:
        print(f"[roster-watch] Failed to DM shizuha: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
