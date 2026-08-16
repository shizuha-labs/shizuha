import { describe, expect, it } from 'vitest';
import { runtimeLaneHealthFromProbe } from '../../src/daemon/runtime-lane-health.js';
import {
  RUNTIME_LANE_EXECUTION_METHODS,
  runtimeCommandForExecutionMethod,
} from '../../src/daemon/runtime-lane-methods.js';

const digest = 'a'.repeat(64);
const context = {
  desiredGeneration: 7,
  runtimeLaneDigest: digest,
  runtimeLane: {
    execution_method: 'codex_app_server',
    model: 'gpt-5.6-sol',
    primary: { provider: 'openai', model_id: 'gpt-5.6-sol' },
  },
};

function probe(overrides: Record<string, unknown> = {}) {
  return {
    generation: 7,
    digest,
    brokerReady: true,
    runtime: {
      status: 'ok',
      bridge: 'codex-app-server',
      model: 'gpt-5.6-sol',
      initialized: true,
      authenticated: true,
      providerHealthy: true,
      quota_ok: true,
      in_backoff: false,
      ...overrides,
    },
  };
}

describe('RuntimeLane in-pod health correlation', () => {
  it.each(Object.entries(RUNTIME_LANE_EXECUTION_METHODS))(
    'renders and health-correlates admitted method %s',
    (executionMethod, capability) => {
      const laneContext = {
        ...context,
        runtimeLane: {
          execution_method: executionMethod,
          model: 'registry-model',
          primary: { provider: 'registry-provider', model_id: 'registry-model' },
        },
      };
      const laneProbe = probe({
        bridge: capability.healthBridge,
        model: 'registry-model',
      });

      expect(runtimeCommandForExecutionMethod(executionMethod)).toBe(capability.command);
      expect(runtimeLaneHealthFromProbe(laneContext, laneProbe, true, true)).toMatchObject({
        apply_status: 'ok',
        harness_ready: true,
      });
    },
  );

  it('accepts only exact-fence authenticated provider readiness', () => {
    expect(runtimeLaneHealthFromProbe(context, probe(), true, true)).toMatchObject({
      apply_status: 'ok',
      harness_ready: true,
      provider_health: { available: true, quota_ok: true, in_backoff: false },
    });
  });

  it.each([
    [{ authenticated: false }, 'runtime_harness_not_authenticated'],
    [{ providerHealthy: false }, 'runtime_provider_unavailable'],
    [{ quota_ok: false }, 'runtime_provider_quota_unavailable'],
    [{ in_backoff: true }, 'runtime_provider_in_backoff'],
  ])('fails closed for negative runtime evidence %#', (runtime, error) => {
    expect(runtimeLaneHealthFromProbe(context, probe(runtime), true, true)).toMatchObject({
      apply_status: 'failed',
      harness_ready: false,
      error,
    });
  });

  it('rejects a healthy-looking payload from the wrong applied generation', () => {
    expect(runtimeLaneHealthFromProbe(
      context,
      { ...probe(), generation: 6 },
      true,
      true,
    )).toMatchObject({ apply_status: 'failed', error: 'runtime_lane_fence_mismatch' });
  });
});
