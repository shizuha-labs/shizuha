#!/usr/bin/env python3
"""
Memory Benchmark v2 — tests PERSISTENT memory, not context recall.

Methodology:
  Phase 1: Store 10 memories via natural conversation
  Phase 2: Restart the agent (kills context window entirely)
  Phase 3: Query from a fresh session (only persistent memory survives)

This ensures we're testing real persistent recall, not LLM context.
"""

import json, time, sys, subprocess, urllib.request
from websocket import create_connection, WebSocketTimeoutException

DASHBOARD = "http://localhost:8015"
WS_URL = "ws://localhost:8015/ws/chat"
SESSION_COOKIE = None

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
    ("cloud infrastructure",       [5], "semantic gap (no keyword overlap)"),
    ("security tokens expiry",     [6], "partial + conceptual"),
    ("mobile app iOS Android",     [9], "keyword match"),
]


def login():
    global SESSION_COOKIE
    data = json.dumps({"username": "shizuha", "password": "shizuha"}).encode()
    req = urllib.request.Request(f"{DASHBOARD}/v1/dashboard/login", data=data,
                                 headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req)
    for part in resp.headers.get("Set-Cookie", "").split(";"):
        part = part.strip()
        if part.startswith("shizuha_session="):
            SESSION_COOKIE = part
            return
    raise Exception("Login failed")


def api_get(path):
    req = urllib.request.Request(f"{DASHBOARD}{path}")
    if SESSION_COOKIE:
        req.add_header("Cookie", SESSION_COOKIE)
    return json.loads(urllib.request.urlopen(req).read())


def api_post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{DASHBOARD}{path}", data=data,
                                 headers={"Content-Type": "application/json"})
    if SESSION_COOKIE:
        req.add_header("Cookie", SESSION_COOKIE)
    return json.loads(urllib.request.urlopen(req).read())


def send_msg(agent_id, prompt, timeout_s=120):
    """Send via dashboard WS, collect until turn ends."""
    ws = create_connection(WS_URL, timeout=timeout_s, cookie=SESSION_COOKIE)
    try:
        # Drain initial events
        ws.settimeout(3)
        try:
            while True:
                ws.recv()
        except:
            pass

        ws.settimeout(timeout_s)
        ws.send(json.dumps({"type": "message", "agent_id": agent_id, "content": prompt}))

        tool_events = []
        content = []
        start = time.time()

        while time.time() - start < timeout_s:
            try:
                raw = ws.recv()
                evt = json.loads(raw)
                t = evt.get("type", "")
                if t == "tool_complete":
                    tool_events.append(evt)
                elif t == "content":
                    content.append(evt.get("data", {}).get("delta", ""))
                elif t in ("turn_complete", "complete", "execution_complete"):
                    break
                elif t == "error":
                    return {"error": str(evt), "ms": int((time.time()-start)*1000)}
            except WebSocketTimeoutException:
                break

        return {
            "tools": tool_events,
            "text": "".join(content),
            "ms": int((time.time()-start)*1000),
        }
    finally:
        ws.close()


def restart_agent(agent_id, name):
    """Restart agent to clear context window."""
    print(f"    Restarting {name}...", end=" ", flush=True)
    try:
        api_post(f"/v1/agents/{agent_id}/restart", {})
    except Exception as e:
        print(f"restart API failed ({e}), trying toggle...")
        try:
            api_post("/v1/agents/toggle", {"agent_id": agent_id, "enabled": False})
            time.sleep(3)
            api_post("/v1/agents/toggle", {"agent_id": agent_id, "enabled": True})
        except Exception as e2:
            print(f"toggle failed too: {e2}")
            return False

    # Wait for agent to come back
    for i in range(30):
        time.sleep(2)
        try:
            agents = api_get("/v1/agents").get("agents", [])
            agent = next((a for a in agents if a["id"] == agent_id), None)
            if agent and agent.get("status") == "running":
                print(f"back up ({(i+1)*2}s)")
                # Give it a moment to fully initialize
                time.sleep(3)
                return True
        except:
            pass
    print("TIMEOUT")
    return False


def check_recall(text, expected_indices):
    """Check if expected memory content appears in response text."""
    text_lower = text.lower()
    for idx in expected_indices:
        mem = MEMORIES[idx].lower()
        # Check multiple key phrases
        keywords = [w for w in mem.split() if len(w) > 4]
        matched = sum(1 for kw in keywords if kw in text_lower)
        if matched >= 2:  # At least 2 significant keywords
            return True
    return False


def run():
    print("=" * 72)
    print("  MEMORY BENCHMARK v2 — Persistent Recall After Restart")
    print("  Store 10 memories → Restart agent → Query from cold start")
    print("=" * 72)

    login()
    print(f"  Logged in: {SESSION_COOKIE[:30]}...")

    agents_data = api_get("/v1/agents").get("agents", [])
    targets = {
        "Sora": "shizuha",
        "Kai": "claude_code_server",
        "Yuki": "codex_app_server",
        "Claw": "openclaw_bridge",
    }

    agent_map = {}
    for a in agents_data:
        if a["name"] in targets and a.get("status") == "running":
            agent_map[a["name"]] = a
            print(f"  {a['name']:10} id={a['id'][:16]}...  exec={a.get('executionMethod')}")

    results = {}

    for name, exec_type in targets.items():
        agent = agent_map.get(name)
        if not agent:
            print(f"\n  SKIP: {name} (not running)")
            results[name] = {"store": 0, "recall": 0, "score": 0, "type": exec_type}
            continue

        aid = agent["id"]
        print(f"\n{'━' * 72}")
        print(f"  {name} ({exec_type})")
        print(f"{'━' * 72}")

        # ── Phase 1: Store memories ──
        print(f"\n  Phase 1: Storing 10 memories...")
        store_ok = 0
        for i, mem in enumerate(MEMORIES):
            r = send_msg(aid, f'Remember this for later: "{mem}"', timeout_s=90)
            ms = r.get("ms", 0)
            if "error" in r:
                print(f"    [{i+1:2}] ERR  ({ms:5}ms) {r['error'][:60]}")
                continue

            # Check if a tool was called or agent acknowledged
            has_tool = len(r.get("tools", [])) > 0
            text = r.get("text", "").lower()
            acknowledged = any(w in text for w in ["remember", "noted", "stored", "saved", "added", "got it", "i'll keep", "memory"])

            if has_tool or acknowledged:
                store_ok += 1
                method = "tool" if has_tool else "ack"
                print(f"    [{i+1:2}] OK   ({ms:5}ms) [{method}]")
            else:
                print(f"    [{i+1:2}] FAIL ({ms:5}ms) {r.get('text','')[:60]}")

        print(f"  → {store_ok}/10 stored")

        # ── Phase 2: Restart agent (clear context) ──
        print(f"\n  Phase 2: Restarting agent to clear context...")
        if not restart_agent(aid, name):
            print(f"    FAILED to restart — skipping recall phase")
            results[name] = {"store": store_ok, "recall": 0, "score": store_ok * 4, "type": exec_type}
            continue

        # ── Phase 3: Cold recall ──
        print(f"\n  Phase 3: Cold recall (fresh session, no context)...")
        hits = 0
        total_ms = 0
        for query, expected, desc in QUERIES:
            r = send_msg(aid, f'What do you remember about "{query}"?', timeout_s=90)
            ms = r.get("ms", 0)
            total_ms += ms

            if "error" in r:
                print(f"    [MISS] ({ms:5}ms) {desc:35} ERR")
                continue

            all_text = r.get("text", "")
            for te in r.get("tools", []):
                all_text += " " + json.dumps(te.get("data", {}))

            hit = check_recall(all_text, expected)
            if hit:
                hits += 1
            marker = "HIT " if hit else "MISS"
            print(f"    [{marker}] ({ms:5}ms) {desc:35} q=\"{query}\"")
            if not hit:
                snippet = all_text[:120].replace("\n", " ").strip()
                if snippet:
                    print(f"           → {snippet}")

        recall = (hits / len(QUERIES)) * 100 if QUERIES else 0
        avg_ms = total_ms // len(QUERIES) if QUERIES else 0
        store_pct = (store_ok / len(MEMORIES)) * 100
        speed = max(0, (15000 - avg_ms) / 15000) * 100
        score = 0.4 * store_pct + 0.4 * recall + 0.2 * speed

        results[name] = {
            "store": store_ok,
            "store_pct": store_pct,
            "hits": hits,
            "recall": recall,
            "avg_ms": avg_ms,
            "score": score,
            "type": exec_type,
        }

    # ── Final Report ──
    print(f"\n{'═' * 72}")
    print("  FINAL SCORES — Persistent Memory (post-restart recall)")
    print(f"{'═' * 72}\n")
    print(f"  {'Agent':15} {'Runtime':22} {'Store':7} {'Recall':10} {'Avg ms':8} {'SCORE':7}")
    print(f"  {'─'*15} {'─'*22} {'─'*7} {'─'*10} {'─'*8} {'─'*7}")

    ranked = sorted(results.items(), key=lambda x: -x[1].get("score", 0))
    for name, r in ranked:
        print(f"  {name:15} {r['type']:22} {r.get('store',0):2}/10  {r.get('recall',0):5.1f}%   {r.get('avg_ms',0):6}ms  {r.get('score',0):5.1f}%")

    print(f"\n  {'─'*72}")
    print(f"  Ranking:")
    for i, (name, r) in enumerate(ranked):
        emoji = ["🥇", "🥈", "🥉", "  "][min(i, 3)]
        print(f"    {emoji} #{i+1} {name:15} — {r.get('score',0):.1f}%  (store={r.get('store',0)}/10, recall={r.get('recall',0):.0f}%)")
    print()


if __name__ == "__main__":
    run()
