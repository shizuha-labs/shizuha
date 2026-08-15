import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeRollDeferralTracker,
  resolveRuntimeRollDeferAlertMs,
  type RuntimeRollDeferralMetricSink,
} from '../../src/daemon/runtime-roll-deferral.js';

function metricSink() {
  return {
    set: vi.fn<RuntimeRollDeferralMetricSink['set']>(),
    clear: vi.fn<RuntimeRollDeferralMetricSink['clear']>(),
  };
}

describe('PLAT-5335 runtime-roll deferral production-order recurrence', () => {
  it('defers a genuinely busy agent across two actuator passes, alerts over-age, then clears and re-arms', () => {
    const metrics = metricSink();
    const tracker = new RuntimeRollDeferralTracker(metrics, 30 * 60_000);
    const key = 'agent-sara\0runtime:v2';
    const t0 = 1_000_000;

    // Production mapping: reconcileHarnessImageRoll pass 1 receives
    // runtimeRollBusyGate.allow=false for the visible busy agent.
    const first = tracker.reconcilePass({
      kind: 'deferred',
      key,
      agent: 'sara',
      now: t0,
      reason: 'bridge-busy',
      protocol: 'drain-v1',
    });
    expect(first).toMatchObject({ allowRoll: false, elapsedMs: 0, shouldLogAlert: false });

    // Production mapping: the next top-level pass runs the normal live gate
    // again. Observability trips, but still cannot authorize a force-roll.
    const overAge = tracker.reconcilePass({
      kind: 'deferred',
      key,
      agent: 'sara',
      now: t0 + 30 * 60_000,
      reason: 'bridge-busy',
      protocol: 'drain-v1',
    });
    expect(overAge).toMatchObject({
      allowRoll: false,
      elapsedMs: 30 * 60_000,
      shouldLogAlert: true,
    });
    expect(tracker.reconcilePass({
      kind: 'deferred',
      key,
      agent: 'sara',
      now: t0 + 31 * 60_000,
      reason: 'bridge-busy',
      protocol: 'drain-v1',
    }).shouldLogAlert).toBe(false);

    // Production mapping: a later live-gate admission clears the active series.
    expect(tracker.reconcilePass({ kind: 'admitted', key, agent: 'sara' }))
      .toMatchObject({ allowRoll: true, changed: true });
    expect(metrics.clear).toHaveBeenCalledWith('sara');

    // A subsequent independent wait starts a fresh clock and may alert again.
    expect(tracker.reconcilePass({
      kind: 'deferred',
      key,
      agent: 'sara',
      now: t0 + 40 * 60_000,
      reason: 'probe-failed',
    })).toMatchObject({ allowRoll: false, elapsedMs: 0, shouldLogAlert: false });
    expect(tracker.reconcilePass({
      kind: 'deferred',
      key,
      agent: 'sara',
      now: t0 + 70 * 60_000,
      reason: 'probe-failed',
    }).shouldLogAlert).toBe(true);
  });

  it('restores the start and one-shot log latch after controller restart', () => {
    const firstMetrics = metricSink();
    const first = new RuntimeRollDeferralTracker(firstMetrics, 1_000);
    const key = 'agent-aoi\0runtime:v2';
    first.reconcilePass({
      kind: 'deferred', key, agent: 'aoi', now: 100, reason: 'bridge-busy', protocol: 'legacy-health',
    });
    expect(first.reconcilePass({
      kind: 'deferred', key, agent: 'aoi', now: 1_100, reason: 'bridge-busy', protocol: 'legacy-health',
    }).shouldLogAlert).toBe(true);

    const restoredMetrics = metricSink();
    const restored = new RuntimeRollDeferralTracker(restoredMetrics, 1_000);
    restored.restore(first.snapshot());
    expect(restoredMetrics.set).toHaveBeenCalledWith(
      'aoi', 'bridge-busy', 'legacy-health', 100,
    );
    expect(restored.reconcilePass({
      kind: 'deferred', key, agent: 'aoi', now: 2_100, reason: 'bridge-busy', protocol: 'legacy-health',
    })).toMatchObject({ allowRoll: false, elapsedMs: 2_000, shouldLogAlert: false });
  });

  it('prunes externally converged agents and bounds the alert configuration', () => {
    const metrics = metricSink();
    const tracker = new RuntimeRollDeferralTracker(metrics, 1_000);
    tracker.reconcilePass({
      kind: 'deferred',
      key: 'agent-ryo\0runtime:v2',
      agent: 'ryo',
      now: 100,
      reason: 'probe-failed',
    });
    expect(tracker.prune(new Set())).toBe(true);
    expect(metrics.clear).toHaveBeenCalledWith('ryo');

    expect(resolveRuntimeRollDeferAlertMs(undefined)).toBe(30 * 60_000);
    expect(resolveRuntimeRollDeferAlertMs('0')).toBe(0);
    expect(resolveRuntimeRollDeferAlertMs('-1')).toBe(30 * 60_000);
    expect(resolveRuntimeRollDeferAlertMs('not-a-number')).toBe(30 * 60_000);
  });
});
