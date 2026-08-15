# CTX-258 Prefix Stability Audit

**Pulse:** CTX-258  
**Scope:** SCLI request construction and benchmark/replay harnesses for Cortex KV/prefix-cache reuse.

## What is now instrumented

- `src/telemetry/prefix-fingerprint.ts` computes SHA-256 fingerprints over the reusable prefix: system prompt + normalized tool schemas.
- `ToolRegistry.definitions()` returns tools sorted by name, making tool schema order independent of MCP/server registration order.
- Set `SHIZUHA_DEBUG_PREFIX=1` to log consecutive-turn prefix fingerprints from `executeTurn`; the log reports prompt/tool hashes and whether the hash changed from the previous turn for the same provider/model.

- Benchmark cells emit comparable `bench_prefix_fingerprint` JSON from the real `benchmark/runner.py` paths (`docker`, `docker-workspace`, `k8s`, and `baremetal`) when `SHIZUHA_DEBUG_PREFIX=1` or `SHIZUHA_BENCH_DEBUG_PREFIX=1` is set. The event hashes the reusable harness command/env-key/mount shape and reports the task-prompt hash separately without printing raw prompt or env values.

## Intentional prefix-changing fields

Keep these after the reusable prefix, or isolate them when measuring cache reuse:

| Field | Why it changes |
| --- | --- |
| Git branch/status | Workspace-dependent and changes after edits. |
| Memory / CLAUDE.md / AGENTS.md | Project and agent dependent. |
| Tool list / MCP availability | Changes with role, toolset, MCP reconnect, capability refresh. |
| Skill catalog | Changes when skills sync or agent role/team changes. |
| Plan-mode / permission reminders | Mode-dependent runtime instruction. |
| Custom user/agent instructions | User/agent-specific. |
| Model profile/context settings | Should be static for same model/profile; changes are intentional only when profile/mode changes. |

## Debug workflow

1. Run consecutive turns with `SHIZUHA_DEBUG_PREFIX=1`.
2. Compare `prefixHash`; if changed, inspect `systemPromptChanged`, `toolSchemaChanged`, `addedTools`, and `removedTools`.
3. For benchmark cells, run a focused bench with prefix debug enabled and inspect live logs/stdout for consecutive `bench_prefix_fingerprint` rows:
   ```bash
   SHIZUHA_BENCH_DEBUG_PREFIX=1 python benchmark/benchmark.py --agents <agent> --task <task> --no-dashboard --no-skip
   ```
   The first cell reports `reason=first-observation`; later cells for the same agent/model report `previousHash` plus `changed=false` unless the reusable harness shape changed. `taskPromptChanged=true` is expected when comparing different tasks and should be isolated after the reusable prefix.
4. If only dynamic fields changed, move/measure them after the reusable prefix. If tool schema hash changed without a capability/toolset change, check MCP registration order and schema generation.

## Smoke/regression checks

```bash
npm test -- tests/prefix-stability.test.ts --reporter=dot
python -m unittest benchmark/test_prefix_debug.py
```
