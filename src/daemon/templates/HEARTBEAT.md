# Catch-up checklist

Run each check below *silently*. Silence is still the default — but only conclude "nothing to do" after the Step 6 held-work re-check (SCLI-76). If no action is surfaced, stop immediately with **zero output**: do not consult the wiki, load/announce skills, send status text, or otherwise narrate that you are idle.

## Checks (in order)

1. **Sync from Pulse in order.** First call `mcp__shizuha-pulse__pulse_get_my_alerts`, then call `mcp__shizuha-pulse__pulse_get_my_tasks`, and read what's currently assigned to you. Your session memory may be stale after a restart; Pulse is the source of truth. This ordered pair is mandatory on every heartbeat.

   If either exact tool name is unavailable, inspect/search your available tool catalog for the Pulse alert/task inbox tools and use the exact exposed names. Do **not** stop with "tool unavailable" before attempting tool discovery.

2. **Alerts outrank tasks.** Acknowledge the first assigned active alert, investigate/remediate its incident, and resolve it only after a green recovery signal. Do not abandon an active alert to start ordinary queue work.

3. **Drain movable tasks when no alert requires action.** Open the first task's latest comments + linked PR, and continue or start the work. Do it; don't narrate. If the first task cannot be moved by you, triage/forward it this turn. Then re-check alerts before calling `mcp__shizuha-pulse__pulse_get_my_tasks` again and take the next ready non-blocked item. Repeat this same turn until no ready alert/task remains.

4. **Process reviews.** For any task with status `in_review` assigned to you (you are the reviewer): follow the transition's knowledge article — verify against the acceptance criteria + PR CI, then fire **Approve & Merge** (if all criteria met) or **Request Changes** (with specific actionable feedback). You are NOT the task author — if you wrote the PR, re-route to another pod member via the correct Submit for X Review transition instead.

5. **Triage bugs.** For any task with status `needs_triage` where the Team field matches your pod: pick the appropriate "Triage to X" transition per `autonomous-bug` workflow.

6. **Handle blocked-on-other-agent cases.** If your in-progress task is blocked by another open task, and you haven't pinged that task's owner in >4h, send ONE `message_user` to them asking for an update. One ping only.

7. **Before concluding "nothing to do" — re-check held urgent/high work (SCLI-76).** `mcp__shizuha-pulse__pulse_get_my_tasks` returns STATUS ONLY; it does NOT show new comments or PR-review feedback. So a held `in_progress` or `in_review` **urgent or high** task whose next action arrived as a COMMENT or a PR review is invisible in the list — that is NOT "blocked/waiting", it is ready work you cannot see from the list alone (a task you submitted for review is not ready-to-work, but its reviewer feedback can still be the next action you owe). So whenever the list surfaces no `open`/ready item and you are about to go idle while still holding non-blocked urgent/high `in_progress` or `in_review` work, go through EACH such held item — not just the top-ranked one, since one held item can have fresh feedback while another still waits — calling `mcp__shizuha-pulse__pulse_list_comments` on each AND checking its linked PR for new review feedback, then act on anything new (a fix, a reply, a transition, a deploy step). Only treat an item as genuinely waiting once its latest comment/feedback puts the ball on someone else; you may idle only after that is true of ALL of them.

## Why this matters

Connect DMs sent while your container was offline (restart, crash, network blip) are not always replayed on reconnect. This checklist is your recovery mechanism — it runs 2 minutes after every container restart and hourly after that, so anything you missed while offline gets picked up here.

## What this does NOT mean

- Don't ping Hritik on a heartbeat. Escalate only per `/HKR/Escalations` — the 5 deliberate breakpoints.
- Don't send status reports. The dashboard already shows your task state.
- Don't reply to the `[Heartbeat]` itself. It has no author. Silence.
- Don't act on stale memory: fetch fresh from Pulse every heartbeat before doing anything.
