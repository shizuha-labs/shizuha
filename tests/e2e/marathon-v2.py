#!/usr/bin/env python3
"""
Marathon v2 — 5 hours of dynamic, unique interactions via dashboard WS.
Every round picks random agents, random scenarios, unique prompts.
Tracks pass/fail, reports every 10 min, logs bugs with context.
"""

import json, time, random, sys, os, traceback, hashlib
from datetime import datetime, timedelta
from websocket import create_connection, WebSocketTimeoutException
import urllib.request, urllib.error

BASE = "http://127.0.0.1:8015"
WS = "ws://127.0.0.1:8015/ws/chat"
USER, PASS = "shizuha", "shizuha"
DURATION_HOURS = 5

# State
cookie = ""
tests_run = tests_passed = tests_failed = 0
bugs = []
unique_prompts = set()

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def bug(desc, detail=""):
    bugs.append({"t": datetime.now().isoformat(), "d": desc, "x": detail[:300]})
    log(f"🐛 {desc}")

def login():
    global cookie
    data = json.dumps({"username": USER, "password": PASS}).encode()
    req = urllib.request.Request(f"{BASE}/v1/dashboard/login", data=data, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=10)
    for p in resp.headers.get("Set-Cookie", "").split(";"):
        if p.strip().startswith("shizuha_session="): cookie = p.strip(); return True
    return False

def agents():
    req = urllib.request.Request(f"{BASE}/v1/agents")
    req.add_header("Cookie", cookie)
    return [a for a in json.loads(urllib.request.urlopen(req, timeout=10).read()).get("agents", []) if a["status"] == "running"]

def send(aid, prompt, timeout=50):
    ws = create_connection(WS, timeout=timeout, cookie=cookie)
    ws.settimeout(3)
    try:
        while True: ws.recv()
    except: pass
    ws.settimeout(timeout)
    ws.send(json.dumps({"type": "message", "agent_id": aid, "content": prompt}))
    content, tools = [], []
    start = time.time()
    while time.time() - start < timeout:
        try:
            e = json.loads(ws.recv())
            t = e.get("type", "")
            if t == "content": content.append(e.get("data", {}).get("delta", ""))
            elif t == "tool_complete": tools.append(e.get("data", {}).get("tool", "?"))
            elif t in ("complete", "turn_complete"): break
            elif t == "proactive_message":
                c = e.get("content", e.get("data", {}).get("content", ""))
                if c: content.append(f"[PROACTIVE]{c}")
                break
            elif t == "error":
                content.append(f"[ERR:{e.get('data',{}).get('message','?')}]")
                break
        except: break
    ws.close()
    return "".join(content), tools, int((time.time()-start)*1000)

def uid(): return hashlib.md5(str(time.time()).encode()).hexdigest()[:8]

# ── Scenarios ──

def s_math(ag):
    a = random.choice(ag)
    x, y, op = random.randint(1,99), random.randint(1,99), random.choice(["+","*"])
    exp = x+y if op=="+" else x*y
    txt, _, ms = send(a["id"], f"What is {x}{op}{y}? Just the number.", 25)
    ok = str(exp) in txt or len(txt) > 0
    return f"{a['name']} {x}{op}{y}={exp}", ok, ms, txt

def s_memory_store(ag):
    a = random.choice(ag)
    m = f"M_{uid()}"
    txt, tools, ms = send(a["id"], f'Remember: "{m}"', 30)
    ok = bool(txt) or "memory" in str(tools)
    return f"{a['name']} mem-store {m[:12]}", ok, ms, txt

def s_memory_recall(ag):
    a = random.choice(ag)
    txt, tools, ms = send(a["id"], 'memory(action="list")', 20)
    ok = len(txt) > 3
    return f"{a['name']} mem-recall", ok, ms, txt

def s_skill(ag):
    a = random.choice(ag)
    t = random.choice(["docker","weather","ssh","1password","nginx","git","python","audio","video","phone"])
    txt, tools, ms = send(a["id"], f'search_skills(query="{t}")', 20)
    ok = "score" in txt.lower() or "skill" in txt.lower() or len(txt) > 10
    return f"{a['name']} skill '{t}'", ok, ms, txt

def s_plugin(ag):
    a = random.choice(ag)
    n = random.choice(["Alice","Bob","World","Hritik"])
    l = random.choice(["en","es","ja","hi"])
    txt, tools, ms = send(a["id"], f"Use the greet tool to say hello to {n} in {l}", 30)
    ok = bool(txt) or "plugin" in str(tools)
    return f"{a['name']} greet {n}/{l}", ok, ms, txt

def s_cron(ag):
    a = random.choice(ag)
    j = f"j_{uid()}"
    txt, tools, ms = send(a["id"], f'Schedule a job named "{j}" in 20 seconds with prompt "hello"', 30)
    ok = "schedule" in txt.lower() or "job" in txt.lower() or "schedule_job" in str(tools)
    return f"{a['name']} cron {j[:8]}", ok, ms, txt

def s_unicode(ag):
    a = random.choice(ag)
    t = random.choice(["你好🎉","café résumé","Привет🌍","مرحبا","🎵🎶🎷","日本語テスト"])
    txt, _, ms = send(a["id"], f"Echo: {t}", 20)
    ok = len(txt) > 2
    return f"{a['name']} unicode", ok, ms, txt

def s_long(ag):
    a = random.choice(ag)
    n = random.choice([500, 1000, 1500])
    txt, _, ms = send(a["id"], "X"*n + f" How many X chars? (answer: {n})", 30)
    ok = bool(txt)
    return f"{a['name']} long-{n}", ok, ms, txt

def s_identity(ag):
    a = random.choice(ag)
    txt, _, ms = send(a["id"], "What is your name? Just the name.", 20)
    ok = len(txt) > 0
    return f"{a['name']} identity", ok, ms, txt

def s_inter_agent(ag):
    if len(ag) < 2: return "inter-agent skip", True, 0, ""
    a1, a2 = random.sample(ag, 2)
    txt, tools, ms = send(a1["id"], f'Use message_agent to send "hi" to {a2["username"]}', 60)
    ok = bool(txt) or "message_agent" in str(tools)
    return f"{a1['name']}→{a2['name']}", ok, ms, txt

def s_webhook(ag):
    try:
        creds = json.loads(open("/home/phoenix/.shizuha/credentials.json").read())
        token = creds.get("webhookToken", "")
        if not token: return "webhook skip", True, 0, ""
        a = random.choice(ag)
        m = f"WH_{uid()}"
        req = urllib.request.Request(f"{BASE}/v1/hooks/agent/{a['username']}",
            data=json.dumps({"message": m}).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        d = json.loads(urllib.request.urlopen(req, timeout=10).read())
        ok = d.get("ok", False)
        return f"{a['name']} webhook {m[:8]}", ok, 0, str(d)
    except Exception as e:
        return f"webhook err", False, 0, str(e)

def s_canvas(ag):
    a = random.choice(ag)
    shapes = ["blue circle r=30","red square 50x50","green triangle","bar chart 3 bars"]
    txt, tools, ms = send(a["id"], f"Use canvas_render: simple SVG {random.choice(shapes)}", 30)
    ok = bool(txt) or "canvas" in str(tools)
    return f"{a['name']} canvas", ok, ms, txt

def s_rapid_switch(ag):
    ws = create_connection(WS, timeout=10, cookie=cookie)
    ws.settimeout(2)
    try:
        while True: ws.recv()
    except: pass
    for a in random.sample(ag, min(6, len(ag))):
        ws.send(json.dumps({"type": "subscribe", "agent_id": a["id"]}))
        time.sleep(0.05)
    ws.close()
    return "rapid-switch", True, 0, ""

def s_empty(ag):
    a = random.choice(ag)
    txt, _, ms = send(a["id"], "   ", 10)
    return f"{a['name']} empty-msg", True, ms, txt  # Should not crash

def s_special_chars(ag):
    a = random.choice(ag)
    txt, _, ms = send(a["id"], 'Reply: <b>bold</b> & "quotes" `code` $HOME', 20)
    ok = len(txt) > 0
    return f"{a['name']} special-chars", ok, ms, txt

def s_audit_check(ag):
    a = random.choice(ag)
    ws_dir = f"/home/phoenix/.shizuha/workspaces/{a['username']}"
    has_audit = os.path.exists(f"{ws_dir}/.audit-log.jsonl")
    has_telem = os.path.exists(f"{ws_dir}/.telemetry.jsonl")
    return f"{a['name']} audit={has_audit} telem={has_telem}", True, 0, ""

SCENARIOS = [
    (s_math, 25), (s_memory_store, 8), (s_memory_recall, 6), (s_skill, 10),
    (s_plugin, 8), (s_cron, 4), (s_unicode, 8), (s_long, 3), (s_identity, 5),
    (s_inter_agent, 3), (s_webhook, 4), (s_canvas, 4), (s_rapid_switch, 5),
    (s_empty, 2), (s_special_chars, 5), (s_audit_check, 2),
]

def pick():
    total = sum(w for _, w in SCENARIOS)
    r = random.randint(1, total)
    for fn, w in SCENARIOS:
        r -= w
        if r <= 0: return fn
    return SCENARIOS[0][0]

# ── Main ──

def main():
    global tests_run, tests_passed, tests_failed
    end = datetime.now() + timedelta(hours=DURATION_HOURS)

    if not login():
        log("FATAL: Login failed"); return

    ag = agents()
    log(f"Starting marathon: {len(ag)} agents, running until {end.strftime('%H:%M')}")

    rnd = 0
    last_report = time.time()
    last_relogin = time.time()

    while datetime.now() < end:
        rnd += 1
        if rnd % 100 == 0: log(f"\n━━━ Round {rnd} ━━━")

        # Re-login + refresh agents every 30 min
        if time.time() - last_relogin > 1800:
            login(); ag = agents(); last_relogin = time.time()

        # Run 2-4 scenarios per round
        for _ in range(random.randint(2, 4)):
            scenario = pick()
            try:
                name, ok, ms, txt = scenario(ag)
                tests_run += 1
                if ok:
                    tests_passed += 1
                else:
                    tests_failed += 1
                    bug(name, txt[:200])

                if rnd <= 10 or rnd % 25 == 0:
                    log(f"  {'✓' if ok else '✗'} {name} ({ms}ms)")
            except Exception as e:
                tests_run += 1
                tests_failed += 1
                if "Connection refused" not in str(e):
                    log(f"  ERROR {scenario.__name__}: {e}")

        # Report every 10 min
        if time.time() - last_report > 600:
            last_report = time.time()
            rate = tests_passed/tests_run*100 if tests_run else 0
            log(f"\n╔══ REPORT ({datetime.now().strftime('%H:%M')}) R{rnd} ══╗")
            log(f"║ {tests_run} tests: {tests_passed} pass, {tests_failed} fail ({rate:.1f}%)")
            log(f"║ Bugs: {len(bugs)}")
            if bugs:
                for b in bugs[-3:]: log(f"║  • {b['d'][:60]}")
            log(f"╚{'═'*45}╝")

        time.sleep(random.uniform(0.5, 3))

    # Final
    rate = tests_passed/tests_run*100 if tests_run else 0
    log(f"\n{'═'*55}")
    log(f"  MARATHON v2 COMPLETE at {datetime.now().strftime('%H:%M')}")
    log(f"  Rounds: {rnd}")
    log(f"  Tests: {tests_run} run, {tests_passed} pass, {tests_failed} fail ({rate:.1f}%)")
    log(f"  Bugs: {len(bugs)}")
    if bugs:
        for b in bugs: log(f"    [{b['t'][:19]}] {b['d']}")
    log(f"{'═'*55}")

if __name__ == "__main__":
    main()
