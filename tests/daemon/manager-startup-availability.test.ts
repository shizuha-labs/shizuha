import { describe, expect, it, vi } from 'vitest';

import { settleDaemonStartupDependencies } from '../../src/daemon/manager.js';


describe('runtime-fleet startup availability', () => {
  it('overlaps identity prefetch without overlapping the two Hive fan-outs', async () => {
    const resolvers = new Map<string, (value: string) => void>();
    const start = vi.fn((name: string) => new Promise<string>((resolve) => {
      resolvers.set(name, resolve);
    }));

    const settled = settleDaemonStartupDependencies({
      effectiveCapabilities: () => start('capabilities'),
      runtimeSsot: () => start('runtime'),
      credentialIdentities: () => start('identities'),
    });

    expect(start.mock.calls.map(([name]) => name)).toEqual(['capabilities', 'identities']);
    resolvers.get('identities')!('identities');
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);
    resolvers.get('capabilities')!('capabilities');
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    expect(start.mock.calls[2]![0]).toBe('runtime');
    resolvers.get('runtime')!('runtime');

    await expect(settled).resolves.toEqual(['capabilities', 'runtime', 'identities']);
  });
});
