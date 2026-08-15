import { describe, expect, it } from 'vitest';
import {
  harnessRollHasCapacity,
  harnessRollInFlightReady,
  resolveHarnessRollBusyRecheckMs,
  harnessRollWakeDelayMs,
  pendingHarnessRollAgentIds,
  shouldDeferK8sGithubProbeForHarnessRoll,
} from '../../src/daemon/manager.js';
import {
  K8S_RUNTIME_SPEC_REVISION,
  type K8sDeploymentState,
} from '../../src/daemon/k8s-backend.js';

function deployment(overrides: Partial<K8sDeploymentState> = {}): K8sDeploymentState {
  return {
    agentId: 'previous',
    username: 'previous',
    name: 'agent-previous',
    replicas: 1,
    readyReplicas: 0,
    availableReplicas: 0,
    generation: 2,
    observedGeneration: 2,
    updatedReplicas: 0,
    currentImage: 'runtime:desired',
    runtimeSpecRevision: K8S_RUNTIME_SPEC_REVISION,
    ...overrides,
  };
}

describe('SCLI-331 harness-roll cadence', () => {
  it('bounds busy-fence rechecks away from a hot poll', () => {
    expect(resolveHarnessRollBusyRecheckMs(undefined)).toBe(15_000);
    expect(resolveHarnessRollBusyRecheckMs(1)).toBe(5_000);
    expect(resolveHarnessRollBusyRecheckMs(120)).toBe(60_000);
    expect(resolveHarnessRollBusyRecheckMs('invalid')).toBe(15_000);
  });

  it('self-schedules at the remaining cooldown boundary instead of the 60s heartbeat', () => {
    expect(harnessRollWakeDelayMs(12_000, 10_000, 15_000)).toBe(13_000);
    expect(harnessRollWakeDelayMs(30_000, 10_000, 15_000)).toBe(1_000);
  });

  it('keeps a replacement in flight until its runtime pod is ready and available', () => {
    expect(harnessRollInFlightReady('previous', [deployment()])).toBe(false);
    expect(harnessRollInFlightReady('previous', [deployment({ readyReplicas: 1 })])).toBe(false);
    expect(harnessRollInFlightReady(
      'previous',
      [deployment({ readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 })],
    )).toBe(true);
    expect(harnessRollInFlightReady('missing', [])).toBe(false);
  });

  it('restores only current desired agents and enforces the bounded window', () => {
    expect(pendingHarnessRollAgentIds(
      ['previous', 'removed', 'ready'],
      new Set(['previous', 'ready']),
      [deployment(), deployment({
        agentId: 'ready',
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 1,
      })],
    )).toEqual(['previous']);
    expect(harnessRollHasCapacity(3, 4)).toBe(true);
    expect(harnessRollHasCapacity(4, 4)).toBe(false);
  });

  it('defers blocking fleet diagnostics while runtime image drift exists', () => {
    expect(shouldDeferK8sGithubProbeForHarnessRoll(
      [deployment({ currentImage: 'runtime:old' })],
      'runtime:desired',
      undefined,
    )).toBe(true);
    expect(shouldDeferK8sGithubProbeForHarnessRoll(
      [deployment({ currentImage: 'runtime:desired' })],
      'runtime:desired',
      undefined,
    )).toBe(false);
    expect(shouldDeferK8sGithubProbeForHarnessRoll(
      [deployment({ currentImage: 'runtime:desired', readyReplicas: 1 })],
      'runtime:desired',
      undefined,
      true,
    )).toBe(true);
  });
});
