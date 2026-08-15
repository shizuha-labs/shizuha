/**
 * The per-agent Cortex credential contract, pinned so it cannot silently rot.
 *
 * 2026-08-05: rei ran for five weeks — Running, Ready, Alive, heartbeating every
 * 900s, holding a model lease — while every turn returned
 * `vLLM error 401: Authentication credentials were not provided`. Its
 * `rei-agent-creds` Secret, created 2026-06-27 before per-agent Cortex keys
 * existed, had no CORTEX_API_KEY. The container referenced that key with
 * `optional: true`, so Kubernetes resolved it to an EMPTY STRING instead of
 * refusing the Pod. The only symptom anywhere was a detail-less "Runtime
 * unhealthy" chip on the Hive Agents page.
 *
 * The render already carried the right INTENT in a comment — "missing per-agent
 * key must fail loud (mint into <user>-agent-creds) rather than silently
 * coalesce" — while the code did the opposite. These tests make the intent
 * executable.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const backendSrc = fs.readFileSync(
  path.resolve(import.meta.dirname!, '../../src/plugins/fleet/k8s-backend.ts'),
  'utf-8',
);

/** The `stringData:` block of the rendered `<u>-agent-creds` Secret. */
function agentCredsStringData(): string {
  const start = backendSrc.indexOf('name: ${u}-agent-creds');
  expect(start, 'the agent-creds Secret render must still exist').toBeGreaterThan(0);
  const dataStart = backendSrc.indexOf('stringData:', start);
  const end = backendSrc.indexOf('${hasFleetSsh', dataStart);
  expect(dataStart).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(dataStart);
  return backendSrc.slice(dataStart, end);
}

describe('per-agent Cortex key', () => {
  it('is never written by the daemon Secret render', () => {
    // This is the load-bearing property that lets Hive mint a key into an
    // existing Secret at all. The daemon applies this manifest on every
    // reconcile; `kubectl apply`'s three-way merge preserves live keys that the
    // manifest does not declare, which is why nova's key (minted 2026-07-04)
    // survived a month of re-renders.
    //
    // GITHUB_TOKEN shows the other outcome: it IS declared here, so every apply
    // overwrites it — and `reconcile_agent_github_identity` documents that
    // hand-patching it "reverted on every reconcile". Adding CORTEX_API_KEY to
    // this block would put the minted key on exactly that treadmill and silently
    // re-break every agent Hive had healed.
    expect(
      agentCredsStringData(),
      'CORTEX_API_KEY must be minted out-of-band by Hive, not declared here — '
        + 'declaring it makes every daemon apply clobber the minted key',
    ).not.toContain('CORTEX_API_KEY');
  });

  it('is referenced from the per-agent Secret, never the shared fleet key', () => {
    // Usage, leases and billing attribute to `agent-<username>`. Falling back to
    // the shared `cortex-fleet-key` would make a missing per-agent key invisible
    // — the agent would work, and nothing would ever reveal it was uncredentialed.
    for (const alias of ['OPENAI_API_KEY', 'VLLM_API_KEY', 'CORTEX_API_KEY']) {
      const line = backendSrc
        .split('\n')
        .find((l) => l.includes(`- { name: ${alias}, valueFrom:`));
      expect(line, `${alias} must be rendered as a secretKeyRef`).toBeTruthy();
      expect(line!).toContain('${u}-agent-creds');
      expect(line!).toContain('key: CORTEX_API_KEY');
      expect(line!, `${alias} must not fall back to the shared fleet key`)
        .not.toContain('cortex-fleet-key');
    }
  });
});
