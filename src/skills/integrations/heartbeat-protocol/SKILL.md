---
name: heartbeat-protocol
description: How to react to [Heartbeat] messages — observe both Pulse inboxes, execute by priority with alerts winning ties, and stay silent when no real work exists
starred: true
tags:
  - heartbeat
  - agent-protocol
---

# Heartbeat Protocol

You receive a `[Heartbeat]` message about once an hour. It is a scheduler nudge, not a prompt for a reply. **Most heartbeats produce zero output.**

## Hard rule: a heartbeat with no real work produces ZERO tokens

When the input for your turn is a bare `[Heartbeat]` (or `[Heartbeat]` followed by a focus reminder from your workspace's `HEARTBEAT.md`), and you cannot identify a concrete piece of actionable work, your turn MUST end with **zero assistant output tokens**. That means:

- No `message_user` tool call.
- No other tool call.
- **Absolutely no text content** — not even a short status like "nothing pending", "standing by", "all quiet".
- **No `Human:`-prefixed line.** If you are ever about to output a line that starts with `Human:` or `[username]`, STOP — that is a role-leak hallucination. You are the assistant. Your role is to produce tool calls or stay silent. Never produce text that looks like a user message.
- No "let me think about what to do" narration.
- No fake user-turn continuations that start with `Human:`, `User:`, `[hritik]`, `[kai]`, or any other bracketed username. Those are user-shaped inputs; you must never synthesize them.

Silence IS the reply. The scheduler logs the heartbeat; the dashboard shows no bubble; you move on.

## Act on a heartbeat ONLY when...

Run the Pulse inbox checks first on every heartbeat: call `mcp__shizuha-pulse__pulse_get_my_alerts`, then `mcp__shizuha-pulse__pulse_get_my_tasks`. The ordered pair is mandatory even when prior context suggests an alert is resolved or the task queue is empty. After both results, execute the highest-priority ready item across alerts and tasks; alerts win ties but never preempt higher-priority task WIP. A Connect alert DM/wake uses the same arbitration.

Act when any of the following applies:

1. **The highest-priority ready item is an active alert.** Acknowledge it, investigate/remediate the incident, and resolve it only after a green recovery signal.
2. **The highest-priority ready item is a movable task.** Keep it in WIP even when a lower-priority alert exists; blocker-root effective priority is authoritative. Respect task queue order: ready work first, then highest priority, then FIFO inside that priority bucket. Take the task and advance it silently with real work. Then obey the scheduler trigger's drain mode: a **bounded** trigger ends after that task because the runtime immediately launches a clean successor turn while ready work remains; an unbounded trigger re-checks alerts before tasks, re-arbitrates by priority, and repeats until no ready work remains. Bounded turns isolate task context without idling; stopping after one task without either successor mechanism is still a throughput bug.
3. **You have a real critical finding** (security incident, production outage, deadline at genuine risk). You escalate via `mcp__shizuha-connect__message_user` to Hritik, then end the turn. Fabricated urgency does not qualify.
4. **A blocker on your task is unclear** and the responsible party hasn't been pinged in the last few hours. You ask them **once** via `mcp__shizuha-connect__message_user`, then end the turn.
5. **Optional focus text appears after `[Heartbeat]`** naming a specific action you can take right now. You do that action, then end the turn.
6. **A task you CANNOT advance yourself** (human-only decision; OR another team's; OR privileged infra/access). Forward it THIS turn — `Escalate to DevOps` / `assignment_group="devops"` for host, cluster, credential-broker, registry, kubeconfig, vault, prod data, or GitHub write gaps; `Raise to Admin Ops` / `assignment_group="admin-ops"` only for genuine human-only decisions. Do not assign the operator email directly. Then continue through the configured same-turn or bounded-successor drain mode. Holding a task you can't move (any status, incl. `todo`/`blocked`) is a stall, not silence.
7. **You hold non-blocked urgent/high `in_progress` OR `in_review` work whose next action is invisible in the task list (SCLI-76).** `mcp__shizuha-pulse__pulse_get_my_tasks` returns STATUS ONLY — it does NOT surface new comments or PR-review feedback, so a held urgent/high task whose next action arrived as a comment or a PR review looks like "nothing ready" when it is actually ready work you can't see from the list. Before you conclude none of 1–6 apply, check every such held item’s comments and linked PR feedback.

If none of the above apply — **zero tokens**. But ending a heartbeat idle while you still hold non-blocked urgent/high `in_progress`/`in_review` work with unaddressed comment/PR feedback is the SCLI-76 churn signature — that is a bug, not silence.

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

- Don't reply "nothing pending" / "awaiting X" / "all quiet" / any acknowledgement — these are tokens on a turn that should have produced zero.
- Don't send periodic status reports. The dashboard already shows your task state.
- Don't re-ping someone you already messaged in the last few hours about the same item.
- Don't treat the heartbeat as a conversation opener. A heartbeat has no content and does not deserve a textual response.
- **Don't hallucinate a follow-up from the user.** If you find yourself composing `Human: [hritik] ...` or `[hritik] can you please...`, that is YOUR output leaking user format. Delete it. End the turn.
- Don't summarize prior work. The session transcript already has it.

## Anti-patterns caught in real sessions

These are failure modes that have actually happened and motivated this updated skill. Each represents a turn that should have had zero output:

- `"Standing by."` — chatty token leak.
- `"Nothing pending on me right now — will check in on the next heartbeat."` — self-narration.
- `"Human: [hritik] I see merge issues with #26 and #3 .. can you ask Ichi and Kai to look into this?"` — **impersonation hallucination**. The model synthesized a user turn that was never actually sent by the user, and on the next real turn acted on its own fabrication (pinged two engineers to investigate non-existent bugs). Zero tokens would have prevented the cascade.
- `"Acknowledged — will monitor and report back."` — acknowledgement to no one.
- `"Let me check what's pending..."` — narrating internal reasoning as visible text.

## Why this matters

Every unnecessary token on a heartbeat:

- Pollutes the activity log with noise.
- Gets stored in your own session memory, making future turns more likely to treat that noise as authoritative context and act on it. This is how hallucinated "user requests" cascade into real wasted work by other agents.
- Costs real money (Opus tokens aren't free).
- Makes you look busy when you aren't, which degrades trust.

A silent heartbeat is a correctly handled heartbeat. Treat every heartbeat as an opportunity to do nothing well.

## If the operator appended extra text

A heartbeat may look like `[Heartbeat]` alone, or `[Heartbeat]` followed by text from your workspace's `HEARTBEAT.md`. Treat any appended text as an **optional** focus reminder from the operator — still silent-by-default unless the reminder names a specific action you can take right now. A generic reminder like "remember your priorities" is not an action; stay silent.
