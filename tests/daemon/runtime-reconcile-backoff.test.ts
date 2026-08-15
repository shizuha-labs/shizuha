import { describe, expect, it } from 'vitest';
import { RuntimeReconcileRepairBackoff } from '../../src/daemon/runtime-reconcile-backoff.js';

describe('RuntimeReconcileRepairBackoff', () => {
  it('deduplicates in-flight repair and exponentially backs off the same desired revision', () => {
    const gate = new RuntimeReconcileRepairBackoff(1_000, 4_000);

    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 0)).toMatchObject({ allowed: true });
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 1)).toMatchObject({
      allowed: false,
      reason: 'in_flight',
      shouldLog: true,
    });
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 2)).toMatchObject({ shouldLog: false });

    expect(gate.markFailed('mio', 'refresh', 'hash-a', 10)).toEqual({
      action: 'refresh',
      failureCount: 1,
      nextRetryAt: 1_010,
      delayMs: 1_000,
    });
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 500)).toMatchObject({
      allowed: false,
      reason: 'backoff',
      retryAfterMs: 510,
      failureCount: 1,
      shouldLog: true,
    });
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 600)).toMatchObject({ shouldLog: false });
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 1_010)).toMatchObject({ allowed: true });

    expect(gate.markFailed('mio', 'refresh', 'hash-a', 1_020)).toMatchObject({
      failureCount: 2,
      nextRetryAt: 3_020,
      delayMs: 2_000,
    });
  });

  it('caps retry delay while preserving the failure streak', () => {
    const gate = new RuntimeReconcileRepairBackoff(1_000, 2_000);
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 0).allowed).toBe(true);
    gate.markFailed('mio', 'refresh', 'hash-a', 0);
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 1_000).allowed).toBe(true);
    gate.markFailed('mio', 'refresh', 'hash-a', 1_000);
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 3_000).allowed).toBe(true);
    expect(gate.markFailed('mio', 'refresh', 'hash-a', 3_000)).toMatchObject({
      failureCount: 3,
      delayMs: 2_000,
    });
  });

  it('admits new desired state immediately and ignores a stale async failure', () => {
    const gate = new RuntimeReconcileRepairBackoff(60_000, 300_000);
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 0).allowed).toBe(true);
    gate.markFailed('mio', 'refresh', 'hash-a', 10);

    const changed = gate.tryBegin('mio', 'refresh', 'hash-b', 20);
    expect(changed).toMatchObject({ allowed: true, failureCount: 0 });
    expect(gate.markFailed('mio', 'refresh', 'hash-a', 30)).toBeNull();
    expect(gate.tryBegin('mio', 'refresh', 'hash-b', 40)).toMatchObject({
      allowed: false,
      reason: 'in_flight',
    });
  });

  it('serializes a changed desired revision behind the current in-flight apply only', () => {
    const gate = new RuntimeReconcileRepairBackoff(60_000, 300_000);
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 0).allowed).toBe(true);
    expect(gate.tryBegin('mio', 'refresh', 'hash-b', 1)).toMatchObject({
      allowed: false,
      reason: 'in_flight',
      failureCount: 0,
    });

    // Completion belongs to hash-a, so it cannot back off or clear hash-b.
    expect(gate.markFailed('mio', 'refresh', 'hash-a', 2)).toBeNull();
    expect(gate.tryBegin('mio', 'refresh', 'hash-b', 3)).toMatchObject({
      allowed: true,
      failureCount: 0,
    });
  });

  it('holds a successful revision while the Deployment settles, then admits a retry', () => {
    const gate = new RuntimeReconcileRepairBackoff(1_000, 4_000, 2_000);
    gate.tryBegin('mio', 'refresh', 'hash-a', 0);
    expect(gate.markSucceeded('mio', 'refresh', 'hash-a', 10)).toBe(true);
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 11)).toMatchObject({
      allowed: false,
      reason: 'settling',
      retryAfterMs: 1_999,
      failureCount: 0,
      shouldLog: true,
    });
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 12)).toMatchObject({
      allowed: false,
      reason: 'settling',
      shouldLog: false,
    });
    expect(gate.tryBegin('mio', 'refresh', 'hash-a', 2_010)).toMatchObject({
      allowed: true,
      failureCount: 0,
    });
  });

  it('clears a settling repair as soon as an external observation proves convergence', () => {
    const gate = new RuntimeReconcileRepairBackoff(1_000, 4_000, 2_000);
    gate.tryBegin('mio', 'refresh', 'hash-a', 0);
    expect(gate.markSucceeded('mio', 'refresh', 'hash-a', 10)).toBe(true);
    expect(gate.clear('mio')).toBe('refresh');
    expect(gate.clear('mio')).toBeNull();
  });

  it('admits a new desired revision immediately during the old revision settle window', () => {
    const gate = new RuntimeReconcileRepairBackoff(1_000, 4_000, 2_000);
    gate.tryBegin('mio', 'refresh', 'hash-a', 0);
    expect(gate.markSucceeded('mio', 'refresh', 'hash-a', 10)).toBe(true);
    expect(gate.tryBegin('mio', 'refresh', 'hash-b', 11)).toMatchObject({
      allowed: true,
      failureCount: 0,
    });
  });
});
