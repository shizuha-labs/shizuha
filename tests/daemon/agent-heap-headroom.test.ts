/**
 * An agent's JS heap must be able to use the pod memory it was given.
 *
 * Operator 2026-08-05: "tbh we should give our agents plenty of ram to work
 * with" — after a session died with
 *
 *   Mark-Compact 3813.0 (4133.0) -> 3797.3 MB ... allocation failure
 *   FATAL ERROR: Ineffective mark-compacts near heap limit
 *   JavaScript heap out of memory
 *
 * on a host with 512GB of RAM. `4133 MB` is V8's own default old-space ceiling,
 * which Node applies regardless of how much memory it can see. Agent pods
 * already carried 6Gi/8Gi limits, so most of that was simply unreachable by the
 * JS heap — and an agent that grew past ~4GB died with a fatal heap error
 * rather than being OOMKilled, which looks like a restart, not a memory limit.
 *
 * Measured before writing this: `v8.setFlagsFromString('--max-old-space-size')`
 * does NOT move the ceiling after startup (4144MB -> 4144MB); only NODE_OPTIONS
 * does (8240MB). So it has to be rendered into the pod env.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { agentNodeHeapMb } from '../../src/daemon/k8s-backend.js';

const backendSrc = fs.readFileSync(
  path.resolve(import.meta.dirname!, '../../src/plugins/fleet/k8s-backend.ts'),
  'utf-8',
);

describe('agent heap ceiling', () => {
  it('exceeds the ~4GB default for a gateway agent', () => {
    expect(
      agentNodeHeapMb('gateway'),
      'the whole point is to get past the default ceiling the fatal error hit',
    ).toBeGreaterThan(4144);
  });

  it('exceeds it for a bridge agent too', () => {
    for (const cmd of ['claude-bridge', 'codex-bridge', 'openclaw-bridge']) {
      expect(agentNodeHeapMb(cmd)).toBeGreaterThan(4144);
    }
  });

  it('stays BELOW the pod limit so a runaway hits a JS error, not SIGKILL', () => {
    // A heap ceiling at or above the cgroup limit converts a recoverable
    // JavaScript heap error into a kernel kill that loses the agent's session.
    expect(agentNodeHeapMb('gateway')).toBeLessThan(8 * 1024);
    expect(agentNodeHeapMb('claude-bridge')).toBeLessThan(12 * 1024);
  });

  it('leaves real headroom for non-heap memory', () => {
    // V8 external memory, native buffers and RSS overhead all live outside the
    // old space; ~75% keeps them from pushing the container over its limit.
    expect(agentNodeHeapMb('gateway')).toBeLessThanOrEqual(Math.floor(8 * 1024 * 0.8));
    expect(agentNodeHeapMb('gateway')).toBeGreaterThanOrEqual(Math.floor(8 * 1024 * 0.6));
  });

  it('gives bridge agents more than gateway agents', () => {
    expect(agentNodeHeapMb('claude-bridge')).toBeGreaterThan(agentNodeHeapMb('gateway'));
  });

  it('falls back to a safe value for an unparseable limit', () => {
    // Never return NaN or 0 into `--max-old-space-size=`, which would produce a
    // pod that cannot start.
    expect(Number.isFinite(agentNodeHeapMb('some-unknown-command'))).toBe(true);
    expect(agentNodeHeapMb('some-unknown-command')).toBeGreaterThan(0);
  });
});

describe('the ceiling reaches the pod', () => {
  it('renders NODE_OPTIONS into the agent container env', () => {
    expect(
      backendSrc,
      'computing the value is useless unless it is in the pod env — the flag '
        + 'cannot be applied from inside the process',
    ).toContain('max-old-space-size=${agentNodeHeapMb(');
  });

  it('lets an explicit operator NODE_OPTIONS win', () => {
    // heapEnv is merged FIRST and mergeOrderedUniqueEnv keeps the later value,
    // so agentTuningEnv/agentPlatformEnv remain authoritative on collision.
    const merged = backendSrc.slice(
      backendSrc.indexOf('const platformEnvYaml = mergeOrderedUniqueEnv('),
      backendSrc.indexOf('const contextPromptPath'),
    );
    const heapIdx = merged.indexOf('heapEnv');
    const tuningIdx = merged.indexOf('agentTuningEnv');
    expect(heapIdx).toBeGreaterThan(-1);
    expect(heapIdx, 'heapEnv must come before the operator-owned sources')
      .toBeLessThan(tuningIdx);
  });
});
