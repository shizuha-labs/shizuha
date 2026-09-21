import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the logger so we can assert on the concise warning (no raw stack).
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { logger } = await import('../src/utils/logger.js');
const { startMetricsServer } = await import('../src/metrics/server.js');

/**
 * SCLI-535: the fixed default metrics port (9103) can already be held by
 * another process (a primary gateway when a codex-bridge secondary spawns).
 * The secondary must NOT emit a raw EADDRINUSE stack and run without its own
 * listener — it should bump the port and retry (bounded) so it still gets a
 * scrape endpoint.
 */
describe('startMetricsServer port-collision handling (SCLI-535)', () => {
  const servers: ReturnType<typeof startMetricsServer>[] = [];
  const listeners: ReturnType<typeof createServer>[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    for (const l of listeners) l.close();
    servers.length = 0;
    listeners.length = 0;
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.info).mockClear();
  });

  it('serves /metrics on the requested port when free', async () => {
    const server = startMetricsServer(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const addr = server.address();
    expect(addr).not.toBeNull();
    if (addr && typeof addr === 'object') {
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('shizuha_active_runs');
    }
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('bumps to the next port and still listens when the port is taken (no raw EADDRINUSE)', async () => {
    // Occupy a port, then ask the metrics server for the same port.
    const blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', resolve));
    listeners.push(blocker);
    const taken = (blocker.address() as { port: number }).port;

    const server = startMetricsServer(taken);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const addr = server.address();
    expect(addr).not.toBeNull();
    // It must have landed on a DIFFERENT (bumped) port, not the taken one.
    if (addr && typeof addr === 'object') {
      expect(addr.port).not.toBe(taken);
      const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(res.status).toBe(200);
    }
  });

  it('does not crash and does not log a raw EADDRINUSE stack when all retries are exhausted', async () => {
    // Occupy a run of consecutive ports so every retry hits EADDRINUSE.
    const base = 19103;
    const blockers: ReturnType<typeof createServer>[] = [];
    for (let p = base; p < base + 8; p++) {
      const b = createServer(() => {});
      await new Promise<void>((resolve) => b.listen(p, '0.0.0.0', resolve));
      blockers.push(b);
      listeners.push(b);
    }

    const server = startMetricsServer(base);
    servers.push(server);

    // Give the retry loop time to exhaust (5 retries) without crashing.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    // No raw stack line from the EADDRINUSE error object.
    const all = vi.mocked(logger.warn).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(all).not.toMatch(/EADDRINUSE.*at /);
    expect(all).toMatch(/running without a metrics listener/);
  });
});
