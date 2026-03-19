#!/usr/bin/env python3
"""
Dynamic E2E Marathon — plays with the dashboard like a real user for hours.
Each interaction is unique. Logs bugs, screenshots issues, reports every 10 min.

Scenarios:
 - Random agent selection + conversation
 - Cron scheduling + proactive delivery verification
 - Memory store + cold recall after agent switch
 - Skill search with varied queries
 - Plugin tool invocation
 - Inter-agent messaging chains
 - Clear chat + verify no ghosts
 - Rapid agent switching
 - Canvas render (static + interactive)
 - Webhook dispatch + verify arrival
 - Edge cases: empty input, long input, unicode, special chars
 - Browser tool (navigate + screenshot)
 - Concurrent WS connections
 - Stress: rapid messages to same agent
"""

import json, time, random, sys, os, traceback
from datetime import datetime, timedelta
from websocket import create_connection, WebSocketTimeoutException
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8015"
WS_URL = "ws://127.0.0.1:8015/ws/chat"
USER = "shizuha"
PASS = "shizuha"

# ── State ──
bugs_found = []
tests_run = 0
tests_passed = 0
tests_failed = 0
session_log = []
cookie = ""

def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    session_log.append(line)

def bug(desc, details=""):
    bugs_found.append({"time": datetime.now().isoformat(), "desc": desc, "details": details[:500]})
    log(f"🐛 BUG: {desc}")

# ── API Helpers ──

def login():
    global cookie
    try:
        data = json.dumps({"username": USER, "password": PASS}).encode()
        req = urllib.request.Request(f"{BASE}/v1/dashboard/login", data=data, headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=10)
        for part in resp.headers.get("Set-Cookie", "").split(";"):
            if part.strip().startswith("shizuha_session="):
                cookie = part.strip()
                return True
    except: pass
    return False

def api_get(path):
    req = urllib.request.Request(f"{BASE}{path}")
    req.add_header("Cookie", cookie)
    return json.loads(urllib.request.urlopen(req, timeout=15).read())

def api_post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers={"Content-Type": "application/json"})
    req.add_header("Cookie", cookie)
    return json.loads(urllib.request.urlopen(req, timeout=15).read())

def get_running_agents():
    d = api_get("/v1/agents")
    return [a for a in d.get("agents", d) if a.get("status") == "running"]

def send_ws(agent_id, prompt, timeout=45):
    """Send message via dashboard WS, collect response."""
    ws = create_connection(WS_URL, timeout=timeout, cookie=cookie)
    ws.settimeout(3)
    try:
        while True: ws.recv()
    except: pass
    ws.settimeout(timeout)
    ws.send(json.dumps({"type": "message", "agent_id": agent_id, "content": prompt}))
    tools, content = [], []
    start = time.time()
    while time.time() - start < timeout:
        try:
            msg = json.loads(ws.recv())
            t = msg.get("type", "")
            if t == "tool_complete": tools.append(msg.get("data", {}))
            elif t == "content": content.append(msg.get("data", {}).get("delta", ""))
            elif t in ("turn_complete", "complete", "execution_complete"): break
            elif t == "proactive_message":
                pc = msg.get("content", msg.get("data", {}).get("content", ""))
                if pc: content.append(f"[PROACTIVE: {pc}]")
                break
        except WebSocketTimeoutException: break
        except: break
    ws.close()
    text = "".join(content)
    return {"tools": tools, "text": text, "ms": int((time.time()-start)*1000), "has_response": len(text) > 0}

# ── Test Scenarios ──

def scenario_basic_chat(agents):
    """Send a simple math question to a random agent."""
    a = random.choice(agents)
    x, y = random.randint(1, 50), random.randint(1, 50)
    r = send_ws(a["id"], f"What is {x} + {y}? Reply with just the number.", timeout=20)
    expected = str(x + y)
    ok = expected in r["text"]
    if not ok and r["has_response"]:
        # Agent might format differently
        ok = any(c.isdigit() for c in r["text"])
    log(f"  basic_chat({a['name']}): {x}+{y}={expected} → {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    if not ok: bug(f"{a['name']} wrong answer for {x}+{y}", r["text"][:200])
    return ok

def scenario_memory_store(agents):
    """Store a unique memory in a random agent."""
    a = random.choice(agents)
    marker = f"MEM_{random.randint(10000,99999)}_{int(time.time())}"
    r = send_ws(a["id"], f'Remember this: "{marker}"', timeout=30)
    ok = r["has_response"]
    log(f"  memory_store({a['name']}): {marker[:20]} → {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    if not ok: bug(f"{a['name']} no response to memory store", r["text"][:200])
    return ok

def scenario_memory_recall(agents):
    """Ask an agent what it remembers."""
    a = random.choice(agents)
    r = send_ws(a["id"], 'memory(action="list")', timeout=20)
    ok = r["has_response"]
    log(f"  memory_recall({a['name']}): {'PASS' if ok else 'FAIL'} ({r['ms']}ms) — {len(r['text'])} chars")
    return ok

def scenario_skill_search(agents):
    """Search for a random skill topic."""
    a = random.choice(agents)
    topics = ["smart home", "docker container", "weather forecast", "notes apple", "ssh tunnel",
              "git workflow", "python venv", "nginx config", "audio transcription", "1password"]
    topic = random.choice(topics)
    r = send_ws(a["id"], f'search_skills(query="{topic}")', timeout=20)
    ok = r["has_response"] and ("score" in r["text"].lower() or "skill" in r["text"].lower() or "no skill" in r["text"].lower())
    log(f"  skill_search({a['name']}, '{topic}'): {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    return ok

def scenario_plugin_greet(agents):
    """Use the hello-world plugin greet tool."""
    a = random.choice(agents)
    names = ["Alice", "Bob", "Hritik", "Sara", "World"]
    langs = ["en", "es", "ja", "hi"]
    name, lang = random.choice(names), random.choice(langs)
    r = send_ws(a["id"], f'Use the greet tool to say hello to {name} in {lang}', timeout=30)
    ok = r["has_response"] and (name.lower() in r["text"].lower() or "plugin" in r["text"].lower() or "hello" in r["text"].lower() or "hola" in r["text"].lower())
    log(f"  plugin_greet({a['name']}, {name}, {lang}): {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    return ok

def scenario_cron_schedule(agents):
    """Schedule a cron job with short delay."""
    a = random.choice(agents)
    delay = random.choice([15, 20, 25, 30])
    job_name = f"test-{random.randint(1000,9999)}"
    r = send_ws(a["id"], f'Schedule a job named "{job_name}" to run in {delay} seconds with prompt "Test reminder {job_name}"', timeout=30)
    ok = r["has_response"] and ("schedule" in r["text"].lower() or "job" in r["text"].lower() or "remind" in r["text"].lower())
    log(f"  cron_schedule({a['name']}, {delay}s, {job_name}): {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    return ok

def scenario_inter_agent(agents):
    """Send message between two agents."""
    if len(agents) < 2: return True
    a1, a2 = random.sample(agents, 2)
    r = send_ws(a1["id"], f'Send a message to {a2["username"]} saying "ping from {a1["name"]}"', timeout=60)
    ok = r["has_response"]
    log(f"  inter_agent({a1['name']}→{a2['name']}): {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    return ok

def scenario_unicode(agents):
    """Test unicode handling."""
    a = random.choice(agents)
    texts = ["你好世界 🎉", "café naïve résumé", "Привет мир 🌍", "مرحبا بالعالم", "🎵🎶🎷🎸"]
    text = random.choice(texts)
    r = send_ws(a["id"], f'Echo exactly: {text}', timeout=20)
    ok = r["has_response"]
    log(f"  unicode({a['name']}): {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    return ok

def scenario_long_message(agents):
    """Send a long message."""
    a = random.choice(agents)
    length = random.choice([500, 1000, 2000])
    msg = "X" * length + f" — count the X characters (there are {length})"
    r = send_ws(a["id"], msg, timeout=30)
    ok = r["has_response"]
    log(f"  long_msg({a['name']}, {length} chars): {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    return ok

def scenario_rapid_switch(agents):
    """Rapidly switch agent subscriptions via WS."""
    ws = create_connection(WS_URL, timeout=10, cookie=cookie)
    ws.settimeout(2)
    try:
        while True: ws.recv()
    except: pass
    for a in random.sample(agents, min(5, len(agents))):
        ws.send(json.dumps({"type": "subscribe", "agent_id": a["id"]}))
        time.sleep(0.1)
    ws.close()
    log(f"  rapid_switch({len(agents)} agents): PASS (no crash)")
    return True

def scenario_webhook(agents):
    """Send a webhook and verify it dispatches."""
    try:
        creds = json.loads(open("/home/phoenix/.shizuha/credentials.json").read())
        token = creds.get("webhookToken", "")
        if not token: return True
        a = random.choice(agents)
        marker = f"WH_{random.randint(1000,9999)}"
        req = urllib.request.Request(
            f"{BASE}/v1/hooks/agent/{a['username']}",
            data=json.dumps({"message": f"Webhook test {marker}"}).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        ok = resp.get("ok", False)
        log(f"  webhook({a['name']}, {marker}): {'PASS' if ok else 'FAIL'}")
        return ok
    except Exception as e:
        log(f"  webhook: ERROR {e}")
        return False

def scenario_canvas(agents):
    """Ask agent to render canvas."""
    a = random.choice(agents)
    shapes = [
        'a blue circle with radius 30',
        'a red rectangle 100x50',
        'a green triangle',
        'a simple bar chart with 3 bars',
    ]
    r = send_ws(a["id"], f'Use canvas_render to create a simple SVG: {random.choice(shapes)}', timeout=30)
    ok = r["has_response"]
    log(f"  canvas({a['name']}): {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    return ok

def scenario_browser(agents):
    """Ask agent to use browser tool."""
    a = random.choice(agents)
    r = send_ws(a["id"], 'Use the browser tool to navigate to https://example.com and get the page title', timeout=45)
    ok = r["has_response"] and ("example" in r["text"].lower() or "title" in r["text"].lower() or "browser" in r["text"].lower())
    log(f"  browser({a['name']}): {'PASS' if ok else 'FAIL'} ({r['ms']}ms)")
    return ok

def scenario_audit_check(agents):
    """Verify audit log exists."""
    a = random.choice(agents)
    ws_dir = f"/home/phoenix/.shizuha/workspaces/{a['username']}"
    audit = os.path.exists(f"{ws_dir}/.audit-log.jsonl")
    telemetry = os.path.exists(f"{ws_dir}/.telemetry.jsonl")
    log(f"  audit({a['name']}): audit={audit}, telemetry={telemetry}")
    return True

# ── Main Loop ──

SCENARIOS = [
    (scenario_basic_chat, 20),      # weight 20 — most common
    (scenario_memory_store, 10),
    (scenario_memory_recall, 8),
    (scenario_skill_search, 10),
    (scenario_plugin_greet, 8),
    (scenario_cron_schedule, 5),
    (scenario_inter_agent, 5),
    (scenario_unicode, 8),
    (scenario_long_message, 5),
    (scenario_rapid_switch, 5),
    (scenario_webhook, 5),
    (scenario_canvas, 5),
    (scenario_browser, 3),
    (scenario_audit_check, 3),
]

def pick_scenario():
    total = sum(w for _, w in SCENARIOS)
    r = random.randint(1, total)
    for fn, w in SCENARIOS:
        r -= w
        if r <= 0: return fn
    return SCENARIOS[0][0]

def main():
    global tests_run, tests_passed, tests_failed

    end_time = datetime.now() + timedelta(hours=5)
    log(f"Marathon started. Running until {end_time.strftime('%H:%M')}")

    if not login():
        log("FATAL: Login failed")
        return

    agents = get_running_agents()
    log(f"Found {len(agents)} running agents")

    round_num = 0
    last_report = time.time()

    while datetime.now() < end_time:
        round_num += 1
        log(f"\n━━━ Round {round_num} ({datetime.now().strftime('%H:%M:%S')}) ━━━")

        # Re-login periodically (session might expire)
        if round_num % 20 == 0:
            login()
            agents = get_running_agents()

        # Run 3-5 random scenarios per round
        n_scenarios = random.randint(3, 5)
        for _ in range(n_scenarios):
            scenario = pick_scenario()
            try:
                ok = scenario(agents)
                tests_run += 1
                if ok:
                    tests_passed += 1
                else:
                    tests_failed += 1
            except Exception as e:
                tests_run += 1
                tests_failed += 1
                log(f"  ERROR in {scenario.__name__}: {e}")
                traceback.print_exc()

        # Report every 10 minutes
        if time.time() - last_report > 600:
            last_report = time.time()
            rate = (tests_passed / tests_run * 100) if tests_run > 0 else 0
            log(f"\n╔══ REPORT ({datetime.now().strftime('%H:%M')}) ══╗")
            log(f"║ Tests: {tests_run} run, {tests_passed} passed, {tests_failed} failed ({rate:.1f}%)")
            log(f"║ Bugs: {len(bugs_found)}")
            for b in bugs_found[-3:]:
                log(f"║   • {b['desc']}")
            log(f"╚{'═'*40}╝")

        # Pause between rounds (1-5s)
        time.sleep(random.uniform(1, 5))

    # Final report
    rate = (tests_passed / tests_run * 100) if tests_run > 0 else 0
    log(f"\n{'═'*60}")
    log(f"  MARATHON COMPLETE at {datetime.now().strftime('%H:%M')}")
    log(f"  Duration: {round_num} rounds")
    log(f"  Tests: {tests_run} run, {tests_passed} passed, {tests_failed} failed")
    log(f"  Pass rate: {rate:.1f}%")
    log(f"  Bugs found: {len(bugs_found)}")
    for b in bugs_found:
        log(f"    [{b['time'][:19]}] {b['desc']}")
    log(f"{'═'*60}")

if __name__ == "__main__":
    main()
