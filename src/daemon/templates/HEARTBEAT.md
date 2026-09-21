# Catch-up checklist

Same contract as Heartbeat Protocol. Do not invent a second one.

1. If this turn already has a `mcp__shizuha-pulse__pulse_get_my_work` result, that is the snapshot — do not fetch alerts/tasks again. Otherwise call `mcp__shizuha-pulse__pulse_get_my_work` once.
2. If the snapshot has a firing alert or a ready/movable task: advance exactly one item with tools. Do not write a status sentence.
3. Before treating the snapshot as empty: go through EACH held urgent/high `in_progress` or `in_review` item (not just the top-ranked one) — `mcp__shizuha-pulse__pulse_list_comments` plus linked PR review. Unaddressed feedback is ready work (SCLI-76). Idle only when the latest comment puts the ball on someone else for ALL of them.
4. If still empty: stop with no text.

Do not ping Hritik on a heartbeat. Do not send status reports. `[Heartbeat]` has no author.
