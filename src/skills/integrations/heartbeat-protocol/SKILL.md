---
name: heartbeat-protocol
description: "[Heartbeat] / HEARTBEAT / idle nudge — call pulse_get_my_work (alerts + tasks in one snapshot), you choose what to advance, emit no assistant text when both inboxes are empty. Mandatory inline skill for every Pulse/Hive seat, independent of team capability."
starred: true
critical: true
agents_md: true
tags:
  - heartbeat
  - agent-protocol
  - watcher
  - coordinator
  - universal
  - pulse
  - pulse_get_my_work
  - pulse_get_my_tasks
  - hive
roles: []
---

# Heartbeat Protocol

**Floor skill — every Pulse/Hive seat, every capability.** This is the only
heartbeat contract. Do not invent a second one from the user message.

A `[Heartbeat]` is a scheduler nudge (also the fallback when a Connect alert
DM/wake was missed). It is not a chat, not a status request, and not a human
speaker. **You choose** what to advance — the harness does not pick an item.

## On every `[Heartbeat]` — this order, nothing else

1. Call `mcp__shizuha-pulse__pulse_get_my_work` **once** (alerts + tasks in one
   snapshot). Empty alerts is not an empty queue. If that exact tool is
   missing, discover `mcp__shizuha-pulse__pulse_get_my_alerts` and
   `mcp__shizuha-pulse__pulse_get_my_tasks` as primitives — not a required
   sequence.
2. If the snapshot has a firing/acknowledged alert or a ready/movable task:
   advance **exactly one** item with tools. Do not write a status sentence.
   Wiki-lifecycle applies when you do real work (`wiki-lifecycle`).
3. If it has neither, and you hold no urgent/high `in_progress` or `in_review`
   item with unaddressed comments/PR feedback: **stop with no text**.
4. The harness does **not** prefetch Pulse, inject tools, or continue the turn
   after you stop. No tool calls = the turn ends. The next beat is the idle
   cadence, not an immediate successor.

**Never output a `Human:`/`User:`/`[username]` line** (e.g. `[hritik]`, `[kai]`).
Those are user-shaped inputs; synthesizing one is a role-leak that cascades
into wasted work. Emit tool calls, or emit no assistant text.

## Act ONLY when one is true

1. **You choose a firing or acknowledged alert from the snapshot.** Acknowledge it, verify it is still firing from the named source, load the linked runbook/`runbook` skill, diagnose from live state/logs, fix the durable cause, and resolve the Pulse alert only after the source is green. A `mode=alert` item is the durable incident episode, **not a Pulse task**; never create a task merely for the firing. File a task only when the response discovers a separate durable defect that needs workflow ownership. After resolution, you may call `mcp__shizuha-pulse__pulse_get_my_work` again. If the exact tool is unavailable, inspect/search the tool catalog; do not silently skip the alert lane.
2. **You choose a movable task from the snapshot.** Keep it in WIP and advance it silently with real work. After that item you may call `mcp__shizuha-pulse__pulse_get_my_work` again in this turn, or stop. The runtime does not launch an immediate successor heartbeat; the next beat is the idle cadence. (Blocked/deferred/waiting ≠ ready — skip, forward per rule 6.)
3. **Real critical finding** (security incident, prod outage, deadline at genuine risk) → escalate via `mcp__shizuha-connect__message_user` to Hritik, then end. Fabricated urgency doesn't qualify.
4. **A blocker is unclear** and the responsible party wasn't pinged in the last few hours → ask them **once** via `mcp__shizuha-connect__message_user`, then end.
5. **Focus text after `[Heartbeat]`** naming a specific action you can take now → do it, then end. (A generic "remember your priorities" is not an action — emit no assistant text.)
6. **A task you CANNOT advance yourself** — forward it THIS turn so it leaves your queue (see **`queue-hygiene`**):
   - **Privileged-infra / can't-do-from-my-container** (host SSH/sudo, `kubectl`/cluster, admin web-UI login, service API token, credential-broker grant, registry/kubeconfig/vault, prod data) → **route to DevOps**: `mcp__shizuha-pulse__pulse_assign_task(<key>, assignment_group="devops")` + the exact remaining step. NOT operator-gated; "outside my sandbox" ≠ "needs the human." DevOps holds full prod/credential access.
   - **Human-gated — genuine HUMAN decisions ONLY** (billing, legal/contracts, CEO/product/strategy/sign-off, a secret only the human holds) → use **Raise to Admin Ops** or `mcp__shizuha-pulse__pulse_assign_task(<key>, assignment_group="admin-ops")` + a one-line comment. Do NOT assign `hothritik1@gmail.com` directly. Admin Ops triages and creates an explicit human blocker only when no team can act. Do NOT send privileged-infra/credential execution here.
   - **Another team's** → `mcp__shizuha-pulse__pulse_assign_task` / `Triage to X`.
   Then end. Holding a task you can't move (any status, incl. `todo`/`blocked`) is a stall, not silence.

If none apply — stop with no text.

## Runtime lifecycle invariant

Autonomous heartbeat context is disposable; Pulse and the working tree are the
durable state. A runtime that starts a clean successor heartbeat MUST first use
the provider's supported unload/close lifecycle for the previous session
(Codex app-server: `thread/unsubscribe`) and wait for that cleanup before
starting the replacement. Merely forgetting a thread/session ID leaks its MCP
children and stale context; retaining completed heartbeat sessions wastes
memory and input tokens. Direct human conversations may preserve their own
continuity, but an autonomous heartbeat must not inherit one.

## Never on a heartbeat

- No idle acknowledgement or queue-status narration — those are tokens on a zero-output turn.
- No periodic status reports or prior-work summaries — the dashboard/transcript has them.
- No re-pinging someone messaged in the last few hours about the same item.
- Don't treat the heartbeat as a conversation opener.
- Don't hallucinate a user follow-up; composing a `Human:` / `User:` / `[username]` line is YOUR output leaking user format — delete it, end the turn.

## Anti-patterns (each should have been stop-with-no-text)

- Idle acknowledgements and queue-status narration. Do not name the idle state.
- Self-narration that you will check later.
- **Impersonation:** synthesizing a `Human:` / `User:` / `[username]` line that was never sent, then acting on it.

**Inverse failure — false-drain (idling while real work remains, SCLI-32):** a STATUS-FILTERED query returns one slice; **an empty slice is NOT an empty queue.** To decide if you have work, call `mcp__shizuha-pulse__pulse_get_my_work` (or the alerts + tasks primitives if that tool is missing). Empty alerts is not an empty inbox. Only both halves empty lets you idle. (Real case: agent saw `status=awaiting_merge` and `status=in_review` both empty, declared "drained," while holding urgent `in_progress` epics CTX-57/CTX-110 plus `todo`/`open` work.)

**Three false-drain variants (2026-06-23 fleet audit) — bugs, not idle:**
- **Sitting on `in_progress` epics.** Owning one is a mandate to advance it: no new comment/feedback does NOT mean "wait" — decompose its next concrete deliverable and SHIP it this beat (commit/PR, a child task you execute, or a design increment), or record a real linked blocker. Zero forward motion this cycle = false-drain. (aoi held ~26 such epics, ended every beat "no movable work" — only checked merge-queue filters.)
- **Dismissing due recurring/open tasks as "nothing actionable."** A recurring/scheduled/operational task that is DUE is ready work — EXECUTE what it describes (run the verification/check), don't dismiss it. (hana held 4 due `open` recurring QA tasks incl. a daily deployment-stability check.)
- **Bailing at the first obstacle.** A tool failure is something you DEBUG and retry (read the error, fix the cause) — persist-to-root-cause applies on heartbeats too; never a reason to end the turn. (ryo held 19 tasks, abandoned its one attempt after a single `git checkout` failure citing "tooling friction / session depth.")

## Watcher/coordinator rule: never nudge agents manually

The framework must make agents progress; coordinators/watchers must not become the manual nudge loop.

- **Never DM/nudge an agent just to make it work its queue.** A direct message like "please start task X" is manual operations, not framework maintenance.
- **Heartbeats are the nudge.** Agent heartbeat jobs, Pulse due-task routing, rebalancers, watchdogs, and workflow post-functions are the only acceptable routine progress triggers.
- **If an agent is idle, stale, or not progressing**, diagnose the automated path:
  - Is the agent process up, authenticated, and receiving heartbeat turns?
  - Is Pulse assigning the task to the right team/assignee?
  - Is the task in a state the heartbeat loop considers actionable?
  - Is the agent wedged, empty-turning, quota-limited, or blocked by an MCP/auth/runtime error?
  - Is a sweep/rebalancer/workflow rule missing or misconfigured?
- **Fix the mechanism, not the symptom.** Repair the heartbeat/sweep/routing/watchdog/skill/workflow defect and verify the next automated cycle advances the work.
- **Do not create fake work to keep agents busy.** Empty queues for a team are valid; creating filler tasks bloats Pulse and hides the real signal.

### Allowed exceptions
- Human/user communication: answering a user or asking the operator for genuinely operator-only input.
- Incident notification: alerting the owning on-call lead when a framework mechanism says to notify, not to ask them to "please work".
- Break-glass coordination during a live outage: use the minimum message needed to coordinate recovery, then file/fix the durable automation gap.

### Audit response pattern
When a watcher audit finds "agent not progressing":
1. Record evidence from runtime, metrics, Pulse state, recent activity, and logs.
2. Classify it as one of: no ready work, legitimately blocked, agent/runtime failure, routing bug, heartbeat/sweep bug, or task-work issue.
3. For no ready work or legitimate blockers, report that state; do not nudge.
4. For framework failures, fix or file the durable framework defect and verify live.
5. For task-work issues, ensure the automated heartbeat/routing path will surface and drive it; do not personally DM the agent.

## Why this matters

Unnecessary heartbeat text pollutes the activity log, is stored as if a human said it, and fakes busyness. Stop-with-no-text on an empty snapshot is a correctly handled heartbeat. Do not copy idle-acknowledgement phrasing from anywhere in context.
