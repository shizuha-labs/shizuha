#!/usr/bin/env python3
"""
Memory Benchmark — tests memory store/search/recall across all agent types
via the Dashboard WebSocket (same interface as a real user).

Agents:
  - Sora   (shizuha runtime)
  - Kai    (claude_code_server)
  - Yuki   (codex_app_server)
  - Claw   (openclaw_bridge)
"""

import json, time, sys, threading
from websocket import create_connection, WebSocketTimeoutException  # pip install websocket-client

DASHBOARD_URL = "ws://localhost:8015"
SESSION_COOKIE = None  # Will be set after login

MEMORIES = [
    "The team decided to use PostgreSQL for all services and Redis for caching",
    "Hritik prefers dark mode across all dashboards and uses a 4K monitor",
    "API rate limit is 100 requests per minute per authenticated user",
    "Sara is the AI research lead focusing on model evaluation and benchmarks",
    "Sprint planning happens every Monday at 10am IST in the main conference room",
    "Kubernetes cluster runs on AWS EKS with spot instances for non-critical workloads",
    "Authentication uses JWT tokens with 1-hour expiry and refresh token rotation",
    "Database migration from MySQL to PostgreSQL completed in February 2026",
    "Backup strategy uses daily S3 snapshots with 30-day retention policy",
    "Mobile app built with React Native and Expo for iOS and Android deployment",
]

QUERIES = [
    ("PostgreSQL Redis",           [0], "exact keyword"),
    ("dark mode monitor",          [1], "exact keyword"),
    ("rate limit API",             [2], "keyword reorder"),
    ("who leads AI research",      [3], "conceptual person"),
    ("when is sprint planning",    [4], "conceptual schedule"),
    ("cloud infrastructure",       [5], "semantic gap"),
    ("security tokens expiry",     [6], "partial + conceptual"),
    ("mobile app iOS Android",     [9], "keyword match"),
]


def login_dashboard():
    """Login to dashboard and get session cookie."""
    import urllib.request
    data = json.dumps({"username": "shizuha", "password": "shizuha"}).encode()
    req = urllib.request.Request(
        "http://localhost:8015/v1/dashboard/login",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req)
    cookie = resp.headers.get("Set-Cookie", "")
    # Extract token
    for part in cookie.split(";"):
        part = part.strip()
        if part.startswith("shizuha_session="):
            return part
    return ""


def get_agents():
    """Get agent list with IDs."""
    import urllib.request
    req = urllib.request.Request("http://localhost:8015/v1/agents")
    if SESSION_COOKIE:
        req.add_header("Cookie", SESSION_COOKIE)
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    return {a["name"]: a for a in data.get("agents", [])}


def send_and_collect(agent_id, prompt, timeout_s=90):
    """Send a message via dashboard WS and collect events until turn_complete."""
    ws = create_connection(
        DASHBOARD_URL + "/ws/chat",
        timeout=timeout_s,
        cookie=SESSION_COOKIE,
    )

    # Auth handshake - dashboard WS sends agents_snapshot on connect
    # Just wait for it then send our message
    try:
        # Read initial messages (agents snapshot, etc.)
        ws.settimeout(5)
        try:
            while True:
                initial = ws.recv()
                d = json.loads(initial)
                if d.get("type") in ("agents_snapshot", "agents_update", "session_start"):
                    break
        except WebSocketTimeoutException:
            pass

        # Send message
        ws.settimeout(timeout_s)
        ws.send(json.dumps({
            "type": "message",
            "agent_id": agent_id,
            "content": prompt,
        }))

        tool_events = []
        content_chunks = []
        start = time.time()

        while time.time() - start < timeout_s:
            try:
                msg = ws.recv()
            except WebSocketTimeoutException:
                break

            try:
                evt = json.loads(msg)
            except json.JSONDecodeError:
                continue

            etype = evt.get("type", "")

            if etype == "tool_complete":
                # Dashboard format: data.is_error, data.tool, data.duration_ms
                tool_events.append(evt)
            elif etype == "content":
                # Dashboard format: data.delta (not text)
                delta = evt.get("data", {}).get("delta", "") or evt.get("text", "")
                content_chunks.append(delta)
            elif etype in ("turn_complete", "complete", "execution_complete"):
                break
            elif etype == "error":
                return {"error": evt.get("data", {}).get("message", str(evt)), "elapsed_ms": int((time.time() - start) * 1000)}

        elapsed = int((time.time() - start) * 1000)
        return {
            "tool_events": tool_events,
            "content": "".join(content_chunks),
            "elapsed_ms": elapsed,
        }
    finally:
        ws.close()


def check_recall(text, expected_indices):
    """Check if expected memories appear in text."""
    text_lower = text.lower()
    for idx in expected_indices:
        mem = MEMORIES[idx].lower()
        keywords = [w for w in mem.split() if len(w) > 4][:3]
        if any(kw in text_lower for kw in keywords):
            return True
    return False


def run_benchmark():
    global SESSION_COOKIE

    print("=" * 72)
    print("  MEMORY BENCHMARK via Dashboard WebSocket")
    print("  10 memories × 8 queries × 4 agent types")
    print("=" * 72)

    # Login
    print("\nLogging in to dashboard...")
    SESSION_COOKIE = login_dashboard()
    if not SESSION_COOKIE:
        print("ERROR: Failed to login to dashboard")
        sys.exit(1)
    print(f"  Session: {SESSION_COOKIE[:30]}...")

    # Get agents
    agents = get_agents()
    targets = {
        "Sora":  {"type": "shizuha"},
        "Kai":   {"type": "claude_code_server"},
        "Yuki":  {"type": "codex_app_server"},
        "Claw":  {"type": "openclaw_bridge"},
    }

    agent_ids = {}
    for name in targets:
        a = agents.get(name)
        if a:
            agent_ids[name] = a["id"]
            print(f"  {name:10} id={a['id'][:16]}...  exec={a.get('executionMethod','?')}")
        else:
            print(f"  {name:10} NOT FOUND")

    results = {}

    for agent_name, agent_cfg in targets.items():
        aid = agent_ids.get(agent_name)
        if not aid:
            print(f"\n  Skipping {agent_name} (not found)")
            results[agent_name] = {"store": 0, "recall": 0, "avg_ms": 0, "score": 0}
            continue

        print(f"\n{'─' * 72}")
        print(f"  {agent_name} ({agent_cfg['type']})")
        print(f"{'─' * 72}")

        # Phase 1: Store
        print("  Storing memories...")
        store_ok = 0
        store_total_ms = 0
        for i, mem in enumerate(MEMORIES):
            prompt = f'Remember this for later: "{mem}"'
            r = send_and_collect(aid, prompt, timeout_s=60)
            ms = r.get("elapsed_ms", 0)
            store_total_ms += ms

            if "error" in r:
                print(f"    [{i+1:2}] ERR  ({ms:5}ms) {r['error'][:60]}")
                continue

            # Check tool results for success
            # Dashboard format: data.is_error (not isError at top level)
            ok = False
            for te in r.get("tool_events", []):
                te_data = te.get("data", {})
                if not te_data.get("is_error", True) and not te.get("isError", True):
                    ok = True
                # Also check: if tool_complete exists at all with a tool name, it likely succeeded
                if te_data.get("tool") and not te_data.get("is_error"):
                    ok = True
            # Also check content
            content = r.get("content", "").lower()
            if "stored" in content or "added" in content or "success" in content or "memory" in content:
                ok = True

            if ok:
                store_ok += 1
                print(f"    [{i+1:2}] OK   ({ms:5}ms)")
            else:
                detail = r.get("content", "")[:80] or str(r.get("tool_events", []))[:80]
                print(f"    [{i+1:2}] FAIL ({ms:5}ms) {detail}")

        # Phase 2: Search
        print("  Searching...")
        hits = 0
        search_total_ms = 0
        for query, expected, desc in QUERIES:
            prompt = f'What do you remember about "{query}"?'
            r = send_and_collect(aid, prompt, timeout_s=60)
            ms = r.get("elapsed_ms", 0)
            search_total_ms += ms

            if "error" in r:
                print(f"    [MISS] ({ms:5}ms) {desc:30} ERR: {r['error'][:50]}")
                continue

            # Collect all text — content deltas contain both tool results and assistant text
            all_text = r.get("content", "")
            for te in r.get("tool_events", []):
                all_text += " " + te.get("result", "")
                all_text += " " + json.dumps(te.get("data", {}))

            tool_ms = 0
            for te in r.get("tool_events", []):
                tool_ms = te.get("data", {}).get("duration_ms", 0) or te.get("durationMs", 0)

            hit = check_recall(all_text, expected)
            if hit:
                hits += 1
            marker = "HIT " if hit else "MISS"
            print(f"    [{marker}] ({ms:5}ms, tool={tool_ms:3}ms) {desc:30} q=\"{query}\"")
            if not hit:
                snippet = all_text[:120].replace("\n", " ")
                print(f"           → {snippet}")

        recall = (hits / len(QUERIES)) * 100
        store_pct = (store_ok / len(MEMORIES)) * 100
        avg_search = search_total_ms // len(QUERIES) if QUERIES else 0
        speed = max(0, (15000 - avg_search) / 15000) * 100
        score = 0.4 * store_pct + 0.4 * recall + 0.2 * speed

        results[agent_name] = {
            "store": store_ok,
            "store_pct": store_pct,
            "recall_pct": recall,
            "hits": hits,
            "avg_ms": avg_search,
            "score": score,
        }

    # Final report
    print(f"\n{'=' * 72}")
    print("  FINAL SCORES")
    print(f"{'=' * 72}")
    print(f"  {'Agent':20} {'Type':20} {'Store':7} {'Recall':9} {'Avg ms':8} {'SCORE':7}")
    print(f"  {'─'*20} {'─'*20} {'─'*7} {'─'*9} {'─'*8} {'─'*7}")

    ranked = sorted(results.items(), key=lambda x: -x[1]["score"])
    for name, r in ranked:
        t = targets.get(name, {}).get("type", "?")
        print(f"  {name:20} {t:20} {r.get('store',0):2}/10  {r.get('recall_pct',0):5.1f}%  {r.get('avg_ms',0):6}ms  {r.get('score',0):5.1f}%")

    print(f"\n  Ranking:")
    for i, (name, r) in enumerate(ranked):
        print(f"    #{i+1} {name:20} {r.get('score',0):.1f}%")
    print()


if __name__ == "__main__":
    run_benchmark()
