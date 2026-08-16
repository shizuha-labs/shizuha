---
name: pulse-workflows
description: How to use Pulse workflows correctly — mandatory procedures, knowledge articles, transition rules
starred: true
tags:
  - pulse
  - workflow
  - transitions
  - knowledge-articles
---

# Pulse Workflows

Tasks on the platform are governed by **workflows** — state machines with defined statuses, transitions, team assignments, and knowledge articles.

## Tools

| Tool | Purpose |
|------|---------|
| `mcp__shizuha-pulse__pulse_list_workflows` | List all workflows |
| `mcp__shizuha-pulse__pulse_get_workflow_detail(workflow_id)` | Full workflow with statuses, transitions, and knowledge articles |
| `mcp__shizuha-pulse__pulse_get_available_transitions(item_id)` | Legal transitions for a task + knowledge articles |
| `mcp__shizuha-pulse__pulse_execute_transition(item_id, to_status)` | Execute a transition |
| `mcp__shizuha-pulse__pulse_create_task(..., workflow="slug")` | Create a task on a specific workflow |

## Mandatory Procedure

**When you receive a task assignment, you MUST:**

1. Call `mcp__shizuha-pulse__pulse_get_available_transitions(item_id)` — this shows what you can do AND the knowledge articles
2. **Read ALL knowledge articles** in the output (marked with 📋 or 🔗) — these are MANDATORY instructions, not suggestions
3. Follow the knowledge articles EXACTLY — they tell you the git workflow, PR process, review checklists, etc.
4. Do your work according to the knowledge articles
5. Call `mcp__shizuha-pulse__pulse_execute_transition(item_id, to_status)` to advance the task when done

**Knowledge articles are the authoritative source.** They override your assumptions, training data, and prior experience. If the knowledge article says "push to your fork, not upstream" — do exactly that. If it says "DO NOT rewrite history" — don't. Agents who skip knowledge articles cause rework and workflow failures.

## Queue Selection and Program Management

- **Work in Pulse queue order.** `mcp__shizuha-pulse__pulse_get_my_tasks` is ordered for execution: ready work first, then highest priority (`urgent` → `high` → `normal`/`medium` → `low`), then FIFO by `created_at` inside that priority bucket.
- **Do not cherry-pick.** Work the first task you can actually move. If that task is misrouted, blocked, operator-only, or outside your pod, triage it the same turn with a comment plus the right transition/reassignment; then continue to the next eligible task.
- **Team assignment is the default.** Workflow post-functions should assign to a team wherever possible. Pulse resolves that team to the least-loaded available member, and the pod rebalance sweep moves movable work from overloaded members to free peers.
- **Program Management is automated by Pulse.** Do not create duplicate "rebalance" tasks because someone looks overloaded; use comments/escalation only when automation cannot resolve it.

## Blockers, Deferred, and Discarded Work

- **Active blocker links must drive `blocked`.** If task B blocks your task A, create/link `B --blocks--> A` (or `A --is_blocked_by--> B`). Pulse auto-transitions A to `blocked` when the workflow supports it. If it does not, call `mcp__shizuha-pulse__pulse_get_available_transitions(A)` and use the blocked transition.
- **Do not leave active blocker links on open work.** A task with active blockers should not sit in `open`/`in_progress`.
- **`deferred` is terminal parked work.** It is not active plate work, but it still prevents duplicates.
- **`cancelled` / `Cancel / Discard` is terminal cleanup.** Use it for invalid artifacts, test artifacts, duplicates, or work that should not exist.
- **Unblock only after blockers are terminal.** Pulse normally restores the pre-block status and owner automatically.

## Rules

- **Never set status directly** — always use `mcp__shizuha-pulse__pulse_execute_transition`
- **Never skip knowledge articles** — they contain critical instructions (git workflow, review checklists, merge policy, etc.)
- **Respect human-gated statuses** — some transitions are reserved for humans (e.g., merge decisions, triage). If a transition says "HUMAN ONLY", stop and wait.
- **Use the right workflow** when creating tasks — call `mcp__shizuha-pulse__pulse_list_workflows` to see options
- **Don't set assignee** when the workflow handles team assignment — post-functions auto-assign based on team config

## Blocking on Human Actions

When your task requires a human to do something (rotate a password, approve a purchase, sign a document):

1. **Create a separate task** for the human action and assign it to the appropriate team:
   ```
   mcp__shizuha-pulse__pulse_create_task(title="Rotate X/Twitter password on x.com", priority="urgent", assignment_group="admin-ops")
   ```

2. **Link it as blocking** your original task:
   ```
   mcp__shizuha-pulse__pulse_link_issues(task_id="NEW_TASK_ID", target_task_id="ORIGINAL_TASK_ID", link_type="blocks")
   ```

3. **Add a comment** on your original task explaining the blocker.

4. **Do not wait idly** — continue with other parts of the work that don't depend on the human action.

This way the human sees a clear task assigned to them, and the original task shows "blocked by #X" in its links. When the human completes their task, the blocker is resolved.

## Creating Tasks

Always specify the `workflow` parameter:

```
mcp__shizuha-pulse__pulse_create_task(
    title="[SEVERITY] Description",
    workflow="security-finding",
    priority="high",
    description="..."
)
```

The workflow determines lifecycle, team routing, and knowledge articles. Without it, the task gets the default simple workflow with no guidance.

## Understanding the Output

When you call `mcp__shizuha-pulse__pulse_get_available_transitions`, the output shows:

```
- **Start Work** → in_progress (slug: in_progress)
  Instructions: Begin fixing via a Pull Request.
  📋 Fix Procedure (PR-Based): 1. Create fix branch...
```

- The **transition name** and **target status** tell you what the move does
- **Instructions** is the transition's description
- **📋 inline articles** contain step-by-step procedures — read and follow these
- **🔗 wiki/link articles** point to external docs — fetch and read before proceeding

## Workflow-Level Knowledge

Call `mcp__shizuha-pulse__pulse_get_workflow_detail(workflow_id)` to see:
- All statuses and their categories
- All transitions with their knowledge articles
- The workflow's **Knowledge Base** — general guidelines that apply to all steps
