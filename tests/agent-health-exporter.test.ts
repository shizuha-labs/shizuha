import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentHealth, startAgentHealthServer, stopAgentHealthServer } from '../src/metrics/health-server.js';

/**
 * PLAT-587 AC4/AC5: the agent-health exporter must derive `enabled` from the
 * authoritative enabled-agents.json set (read fresh per scrape), NOT from a
 * cached daemon-state flag — so a daemon toggle reflects in Pulse routing within
 * one gather cycle and the 2026-06-13 stale-cache split-brain cannot recur.
 */
describe('PLAT-587 agent-health exporter: enabled derives from enabled-agents.json', () => {
  const agents = [
    { id: 'id-a', username: 'alice' },
    { id: 'id-b', username: 'bob' },
    { id: 'id-c', username: 'carol' },
  ];

  it('reports enabled=1 only for agents in the enabled set', () => {
    const enabled = new Set(['id-a', 'id-c']);
    const running = new Set(['id-a']);
    const health = buildAgentHealth(agents, enabled, running);
    expect(health).toEqual([
      { username: 'alice', enabled: true, running: true, capacityUnavailable: false },
      { username: 'bob', enabled: false, running: false, capacityUnavailable: false },
      { username: 'carol', enabled: true, running: false, capacityUnavailable: false },
    ]);
  });

  it('reflects a toggle immediately when the fresh set changes (no stale cache)', () => {
    const running = new Set<string>();
    // bob disabled
    expect(buildAgentHealth(agents, new Set(['id-a']), running)
      .find((a) => a.username === 'bob')!.enabled).toBe(false);
    // operator enables bob in the daemon -> next scrape passes the fresh set
    expect(buildAgentHealth(agents, new Set(['id-a', 'id-b']), running)
      .find((a) => a.username === 'bob')!.enabled).toBe(true);
  });

  it('an agent absent from the enabled set is disabled even if daemon-state thought otherwise', () => {
    // The fresh enabled-agents.json is the sole authority: an empty set => all disabled,
    // regardless of any cached daemon.json enabled flag.
    const health = buildAgentHealth(agents, new Set(), new Set(['id-a', 'id-b', 'id-c']));
    expect(health.every((a) => a.enabled === false)).toBe(true);
    expect(health.every((a) => a.running === true)).toBe(true); // running is orthogonal
  });
});

describe('PLAT-3367 agent-health exporter startup is idempotent', () => {
  afterEach(async () => {
    await stopAgentHealthServer(0);
  });

  it('reuses an existing server instead of binding the same port twice', async () => {
    const first = startAgentHealthServer(() => [
      { username: 'first', enabled: true, running: true, capacityUnavailable: false },
    ], 0);
    const second = startAgentHealthServer(() => [
      { username: 'second', enabled: true, running: true, capacityUnavailable: false },
    ], 0);

    expect(second).toBe(first);
    if (!first.listening) {
      await new Promise<void>((resolve) => first.once('listening', resolve));
    }

    const addr = first.address();
    if (!addr || typeof addr === 'string') throw new Error('expected TCP listener address');
    const response = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('shizuha_agent_process_up{agent="first"} 1');
    expect(body).not.toContain('agent="second"');
  });
});
