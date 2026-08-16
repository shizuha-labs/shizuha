import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isLoopbackRuntimeRollCaller,
  normalizeRuntimeRollDrainLeaseMs,
  RuntimeRollDrainLease,
} from '../../src/shared/runtime-roll-drain.js';

afterEach(() => vi.useRealTimers());

describe('RuntimeRollDrainLease', () => {
  it('latches a matching request at ready while extending its bounded lease', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
    const expired = vi.fn();
    const drain = new RuntimeRollDrainLease(expired);

    expect(drain.arm({
      requestId: 'roll-agent-a-image-b',
      targetImage: 'runtime:image-b',
      leaseMs: 30_000,
    })).toMatchObject({
      protocol: 1,
      state: 'draining',
      acceptingTurns: true,
    });
    drain.markReady();
    expect(drain.snapshot(false, 0)).toMatchObject({
      state: 'ready',
      acceptingTurns: false,
      busy: false,
      pendingAcceptedTurns: 0,
    });

    vi.advanceTimersByTime(20_000);
    drain.arm({
      requestId: 'roll-agent-a-image-b',
      targetImage: 'runtime:image-b',
      leaseMs: 30_000,
    });
    expect(drain.ready).toBe(true);
    vi.advanceTimersByTime(29_999);
    expect(drain.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(drain.active).toBe(false);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('supersedes a ready fence when the desired target changes', () => {
    const drain = new RuntimeRollDrainLease(() => undefined);
    drain.arm({ requestId: 'request-a', targetImage: 'runtime:a' });
    drain.markReady();

    expect(drain.arm({ requestId: 'request-b', targetImage: 'runtime:b' }))
      .toMatchObject({
        requestId: 'request-b',
        targetImage: 'runtime:b',
        state: 'draining',
        acceptingTurns: true,
      });
    drain.dispose();
  });

  it('clamps leases and restricts the control endpoint to loopback callers', () => {
    expect(normalizeRuntimeRollDrainLeaseMs(1)).toBe(5_000);
    expect(normalizeRuntimeRollDrainLeaseMs(999_999)).toBe(120_000);
    expect(normalizeRuntimeRollDrainLeaseMs('junk')).toBe(60_000);
    expect(isLoopbackRuntimeRollCaller('127.0.0.1')).toBe(true);
    expect(isLoopbackRuntimeRollCaller('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackRuntimeRollCaller('10.42.0.8')).toBe(false);
  });
});
