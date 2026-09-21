# Background tasks: launch, wait, monitor, stop

Operator/author guide for SCLI's background-task patterns (SCLI-430 core +
SCLI-688 tool surface). Cross-links the gap matrix: wiki `7552dd04`
(SCLI-431), row 4 / §1 (`wait_tasks`).

## The tool set

| Tool | Job | Blocking? |
|---|---|---|
| `Bash` / `Task` with `run_in_background=true` | Launch; returns a task ID immediately | no |
| `TaskOutput` | Read one task's output; `block=true` waits for THAT task | per-task |
| `WaitTasks` | Wait on SEVERAL tasks — first completer (`any`) or all of them (`all`) | multi-task |
| `TaskStop` | Kill a running task (SIGTERM→SIGKILL escalation) | no |

## The race pattern (wait_any)

Launch parallel candidates, take the first winner, stop the losers:

```
1. Bash(command="sleep 2; probe A", run_in_background=true)  -> task-AAA
2. Bash(command="sleep 8; probe B", run_in_background=true)  -> task-BBB
3. WaitTasks(task_ids=[AAA, BBB], mode="any", timeout=30000)
   -> "First completer: task-AAA (completed) ... output: ..."
4. TaskStop(task_id="BBB")          # the loser
5. TaskOutput(task_id="AAA")        # outputs remain retrievable
```

`mode=any` resolves on the first terminal state (completed, failed, or
killed — a failed task also wins the race; check the status line).
Unknown ids are skipped and reported; an unknown-only set resolves
immediately with the timeout-path message.

## The barrier pattern (wait_all)

Gate on every task before proceeding:

```
WaitTasks(task_ids=[AAA, BBB, CCC], mode="all", timeout=120000)
-> "All tasks terminal:
    task-AAA: completed (exit 0)
    task-BBB: failed — Exited with code 3
    task-CCC: killed"
```

Per-task status lines include exit codes / errors; use `TaskOutput` for
the full buffers. Non-zero exits surface via the error field
("Exited with code N").

## Semantics worth knowing

- **Non-destructive reads.** `WaitTasks` reports the full output buffer
  without advancing the delta offset — a later `TaskOutput` still sees
  everything. (The registry's delta-poll `getOutput(id)` semantics are
  for internal callers; the tool surface never consumes your delta.)
- **Timeout is not an error.** On timeout `mode=any` lists the
  still-running ids; `mode=all` lists per-task states. Decide whether
  to `TaskStop` or keep waiting.
- **Completion notify.** Independently of waiting,
  `collectAttachments()` injects task completion as a
  `<system-reminder>` before the next model turn — you often don't need
  to poll at all (gap-matrix row 1/18).
- **Monitors** (SCLI-432) stream long-running command output line by
  line as notifications — use `monitor` when you want events pushed per
  line, `WaitTasks` when you want a barrier or a race.

## Live-verification recipe (gateway-live acceptance)

```
shizuha -p "Launch two background sleeps (2s/8s, run_in_background=true),
WaitTasks(mode=any) on both ids, TaskStop the loser, report final states."
```

Expected: the 2s task wins with its output; the 8s task reports `killed`
after TaskStop. Recorded for SCLI-688 on 2026-09-05 (winning id
`task-356fe257` completed/ALPHA-DONE; loser `task-67ffba1c` killed).
