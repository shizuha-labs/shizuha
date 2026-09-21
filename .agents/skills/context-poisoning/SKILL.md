---
name: context-poisoning
description: "Never grow the eternal session with poll/curl/watch transcripts — 300k context makes GLM self-report degraded and look dumb. Load before schedule_job, interval cron, merge-on-green watches, 300k TTFT, or 'agent is unintelligent'."
starred: false
critical: false
tags: [cron, schedule_job, context, poisoning, glm, session, interval, watch, 300k]
roles: []
---

# Context poisoning — do not make the model dumb

The eternal session is the agent's working memory. Filling it with repeated curl diaries, CI JSON, and "nothing to do this tick" lines is not diligence — it is **poison**. At ~50k GLM does architect work. At ~300k it self-reports a degraded state, mangles URLs, and emits 16k-token empty turns (Aoi 2026-09-09).

## Forbidden

- `schedule_job(schedule="every 10m"|"every 20m"|…)` to watch a PR, CI, merge-on-green, co-sign, or "until X".
- Pasting a curl recipe into an interval job prompt and letting it run forever (`repeat.times = null`).
- Treating bash HTTP 200 as Pulse progress (Sato-class).
- Wiping the session as the product (fruitless rotate is stop-bleed).

## Required instead

1. **Hook the event** (`event-driven-over-sweeps`): Forgejo webhook, CI status check, Pulse transition, Connect DM. One fire when the head moves or checks go green.
2. Calendar crons (`0 9 * * 1-5`) for daily checklists are fine.
3. One-shot delays (`30m`, `2h`) are fine.
4. Interval jobs are **capped at 50 ticks** (`HARD_INTERVAL_RUNAWAY_CAP`). Do not work around the cap.
5. `schedule_job` **refuses** interval PR/CI/serving watches (`isForbiddenIntervalPoll`). The error is the product — do not rephrase the curl into a delay loop.
6. Cron `kind=job` transcripts are trimmed from the eternal session after the tick (SCLI `3853e5c2`). Do not re-append them.

## If you see it live

Read `shizuha.log` + `jobs.json` (`agent-log-inspection`). Do not restart first. Disable the runaway interval job (`remove_job` / harness cap on load). Confirm prompt tokens flatten. Then fix the missing event hook so the watch is not needed.

Wiki: Standard: never poison the eternal session with poll transcripts.
