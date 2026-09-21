/**
 * SCLI-406: `shizuha status` must not collapse a live k3s/rt-fleet managed
 * runtime into a bare "Daemon: not running" false-negative. It must render
 * both truths (loopback daemon absent + fleet runtime live/managed), while a
 * genuinely inactive standalone install keeps a truthful local-daemon verdict.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as manager from '../../src/daemon/manager.js';
import * as state from '../../src/daemon/state.js';

const originalEnv = { ...process.env };
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

function lastLog(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('SCLI-406 status truth', () => {
  beforeEach(() => {
    logSpy.mockClear();
    // Default: no daemon state, no fleet markers.
    delete process.env.SHIZUHA_FLEET_ID;
    delete process.env.FLEET_ID;
    delete process.env.SHIZUHA_DAEMON_ID;
    delete process.env.FLEET_DAEMON_ID;
    delete process.env.SHIZUHA_DAEMON_LINK_URL;
    delete process.env.FLEET_DAEMON_LINK_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('standalone install with no daemon state stays a truthful local verdict', async () => {
    vi.spyOn(state, 'readDaemonState').mockReturnValue(null);
    await manager.showStatus();
    const out = lastLog();
    expect(out).toContain('Daemon: not running (loopback)');
    expect(out).toContain('No loopback daemon state found; no fleet runtime detected.');
  });

  it('inside a live k3s/rt-fleet agent renders BOTH truths', async () => {
    vi.spyOn(state, 'readDaemonState').mockReturnValue(null);
    process.env.SHIZUHA_FLEET_ID = 'rt-fleet-zen';
    process.env.SHIZUHA_DAEMON_LINK_URL = 'http://fleet-link';
    await manager.showStatus();
    const out = lastLog();
    expect(out).toContain('Daemon: not running (loopback)');
    expect(out).toContain('Fleet runtime: live (managed by k3s/rt-fleet)');
    expect(out).toContain('rt-fleet-zen');
    // The old collapse must not appear.
    expect(out.trim()).not.toBe('Daemon: not running');
  });
});
