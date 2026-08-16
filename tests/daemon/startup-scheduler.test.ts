import { describe, expect, it } from 'vitest';
import { launchConcurrentlyWithIoYield } from '../../src/daemon/startup-scheduler.js';

describe('daemon startup scheduling', () => {
  it('yields to control-plane I/O between agent launches', async () => {
    const events: string[] = [];

    await launchConcurrentlyWithIoYield([1, 2, 3], async (item) => {
      events.push(`start:${item}`);
      if (item === 1) {
        setImmediate(() => events.push('dashboard-io'));
      }
    });

    expect(events.indexOf('dashboard-io')).toBeGreaterThan(events.indexOf('start:1'));
    expect(events.indexOf('dashboard-io')).toBeLessThan(events.indexOf('start:2'));
  });

  it('keeps launched agent startup work concurrent', async () => {
    const launched: number[] = [];
    const releases: Array<() => void> = [];

    const completion = launchConcurrentlyWithIoYield([1, 2, 3], async (item) => {
      launched.push(item);
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    while (launched.length < 3) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(launched).toEqual([1, 2, 3]);
    releases.forEach((release) => release());
    await expect(completion).resolves.toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]);
  });
});
