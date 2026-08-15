import { afterEach, describe, expect, it, vi } from 'vitest';

import { startUpdateChecker, updateCanApply } from '../../src/daemon/update-check.js';

afterEach(() => vi.useRealTimers());

describe('daemon idle update gate', () => {
  it('applies only when the manager reports every session idle', () => {
    expect(updateCanApply(() => true)).toBe(true);
    expect(updateCanApply(() => false)).toBe(false);
  });

  it('fails closed when idle-state inspection throws', () => {
    const broken = vi.fn(() => { throw new Error('state unavailable'); });
    expect(updateCanApply(broken)).toBe(false);
  });

  it('waits for idle, applies once, and stops the tight retry afterward', async () => {
    vi.useFakeTimers();
    let idle = false;
    const applyUpdate = vi.fn(async () => 0);
    const stop = startUpdateChecker({
      log: vi.fn(),
      isIdle: () => idle,
      applyUpdate,
      sourceInstall: () => false,
      updatesEnabled: () => true,
      check: async () => ({
        target: 'linux-x64', installedSha: 'old', installedVersion: '1.0',
        latestSha: 'new', latestVersion: '1.1', updateAvailable: true, reason: 'new release',
      }),
      startupDelayMs: 1,
      checkIntervalMs: 10_000,
      idleRetryMs: 5,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(applyUpdate).not.toHaveBeenCalled();
    idle = true;
    await vi.advanceTimersByTimeAsync(5);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    stop();
  });
});
