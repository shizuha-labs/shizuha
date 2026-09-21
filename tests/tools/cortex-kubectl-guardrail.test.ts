import { afterEach, describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { bashTool } from '../../src/tools/builtin/bash.js';
import { evaluateCortexKubectlGuardrail } from '../../src/safety/cortex-kubectl-guardrail.js';
import type { ToolContext } from '../../src/tools/types.js';

/**
 * PLAT-5392: Cortex kubectl guardrail — ported from the stranded `shizuha`
 * repo into the authoritative `shizuha` runtime and wired into the bash
 * tool. These fixtures exercise the REAL caller boundary (bashTool.execute),
 * not just the guardrail helper, so a green suite proves the guard is enforced
 * in the artifact every fleet agent runs.
 *
 * Red-first: before this port the shipped runtime had ZERO enforcement — the
 * guardrail file was absent from the dev repo and from the built bundle
 * (hiro's grep evidence on PLAT-5392). A mutating `kubectl -n ai-models` from
 * the bash tool sailed through. These fixtures are green only because the
 * guard is now wired in.
 */

function makeContext(cwd?: string): ToolContext {
  return { cwd: cwd ?? os.tmpdir(), sessionId: 'test-session' };
}

const BREAK_GLASS_ENV_KEYS = [
  'SHIZUHA_CORTEX_BREAK_GLASS_APPROVAL',
  'SHIZUHA_CORTEX_BREAK_GLASS_REASON',
  'SHIZUHA_CORTEX_MODEL_SERVING_BREAK_GLASS_APPROVAL',
  'SHIZUHA_CORTEX_MODEL_SERVING_BREAK_GLASS_REASON',
] as const;
const originalEnv = new Map(BREAK_GLASS_ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of BREAK_GLASS_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Cortex kubectl guardrail — bash tool boundary (PLAT-5392)', () => {
  it('REFUSES a mutating kubectl against the ai-models namespace (red-first)', async () => {
    const result = await bashTool.execute(
      { command: 'kubectl delete pod -n ai-models my-vllm-pod' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('Blocked by Cortex model-serving guardrail');
    expect(String(result.content)).toContain('ai-models');
  });

  it('REFUSES a mutating kubectl apply -f targeting ai-models', async () => {
    const result = await bashTool.execute(
      { command: 'kubectl apply -f /tmp/manifest.yaml -n ai-models' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('Blocked by Cortex model-serving guardrail');
  });

  it('ALLOWS read-only kubectl get -n ai-models (paired positive)', async () => {
    // Read-only diagnostics must still succeed — a total block would pass the
    // refusal fixtures identically.
    const result = await bashTool.execute(
      { command: 'kubectl get pods -n ai-models 2>&1 || true' },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).not.toContain('Blocked by Cortex model-serving guardrail');
  });

  it('ALLOWS a mutating kubectl with a valid break-glass approval marker', async () => {
    process.env.SHIZUHA_CORTEX_BREAK_GLASS_APPROVAL = 'human:hritik:CTX-535';
    process.env.SHIZUHA_CORTEX_BREAK_GLASS_REASON = 'operator-approved model teardown';
    const result = await bashTool.execute(
      { command: 'kubectl delete pod -n ai-models my-vllm-pod 2>&1 || true' },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).not.toContain('Blocked by Cortex model-serving guardrail');
    // The break-glass audit trail must be visible in the transcript.
    expect(String(result.content)).toContain('[Cortex guardrail break-glass]');
    expect(String(result.content)).toContain('approval=human:hritik:CTX-535');
  });

  it('REFUSES a mutating kubectl with a MALFORMED break-glass marker', async () => {
    // Inline command assignment is NOT trusted — the marker must come from the
    // runtime env, and the reason must be specific.
    process.env.SHIZUHA_CORTEX_BREAK_GLASS_APPROVAL = 'human:hritik:CTX-535';
    process.env.SHIZUHA_CORTEX_BREAK_GLASS_REASON = 'short';
    const result = await bashTool.execute(
      { command: 'kubectl delete pod -n ai-models my-vllm-pod' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('Blocked by Cortex model-serving guardrail');
  });

  it('REFUSES mutating kubectl with --all-namespaces (fail closed on scope)', async () => {
    const result = await bashTool.execute(
      { command: 'kubectl delete pod --all-namespaces -l app=vllm' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('Blocked by Cortex model-serving guardrail');
  });
});

describe('Cortex kubectl guardrail — namespace resolution (fail closed on unknown)', () => {
  it('refuses an unresolvable namespace expression with file-based mutation', () => {
    const decision = evaluateCortexKubectlGuardrail(
      'kubectl apply -f /tmp/x.yaml -n $UNSET_NS',
      {},
    );
    expect(decision.allowed).toBe(false);
  });

  it('refuses an implicit/default-namespace mutating invocation naming a protected model', () => {
    const decision = evaluateCortexKubectlGuardrail(
      'kubectl delete statefulset vllm-deepseek-r1',
      {},
    );
    expect(decision.allowed).toBe(false);
  });

  it('refuses a shell-expression namespace with file-based mutation (cannot prove it avoids ai-models)', () => {
    const decision = evaluateCortexKubectlGuardrail(
      'kubectl apply -f /tmp/x.yaml -n $(cat /tmp/ns)',
      {},
    );
    expect(decision.allowed).toBe(false);
  });

  it('refuses an unresolvable namespace that names a protected model (fail closed on unknown)', () => {
    const decision = evaluateCortexKubectlGuardrail(
      'kubectl delete pod -n $UNSET_NS vllm-deepseek-r1',
      {},
    );
    expect(decision.allowed).toBe(false);
  });

  it('allows read-only kubectl with --all-namespaces', () => {
    const decision = evaluateCortexKubectlGuardrail(
      'kubectl get pods --all-namespaces',
      {},
    );
    expect(decision.allowed).toBe(true);
  });
});
