/**
 * SCLI-587 regression: `shizuha down` must not report success or delete durable
 * PID/state until the targeted daemon + owned children have exited.
 *
 * The old stopDaemon() sent SIGTERM and immediately cleared daemon state +
 * released the PID lock, so `down` could false-succeed while the daemon (and
 * its in-flight Docker builds) kept running. This suite exercises the real
 * stopDaemon() against deliberately busy fake daemon processes:
 *   1. A daemon that exits on SIGTERM (graceful path — no escalation).
 *   2. A daemon that IGNORES SIGTERM (wedged mid-build — must escalate to
 *      SIGKILL, and only then clear PID/state).
 *   3. No daemon running (idempotent, stale state cleared).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  __setStopDaemonTimingsForTest,
  stopDaemon,
} from '../../src/daemon/manager.js';
import { isShizuhaDaemonProcess } from '../../src/daemon/state.js';

const PID_LOCK = '.shizuha/daemon.pid';
const SIGTERM_MARKER = '/tmp/scli587-sigterm-marker';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stopDaemon honesty (SCLI-587)', () => {
  let tmpHome: string;
  let previousHome: string | undefined;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli587-stop-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
    // Shorten the bounded waits so the escalation path is fast in tests.
    __setStopDaemonTimingsForTest({ graceMs: 300, killWaitMs: 300, pollMs: 20 });
  });

  afterEach(() => {
    for (const child of children) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
    children.length = 0;
    try { fs.rmSync(SIGTERM_MARKER, { force: true }); } catch { /* ignore */ }
    if (previousHome !== undefined) process.env['HOME'] = previousHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Spawn a fake daemon whose /proc cmdline looks like a real shizuha daemon
   * (`node <...>/shizuha.js up`) so isShizuhaDaemonProcess accepts it, and whose
   * SIGTERM behavior is configurable. detached:true makes it a process-group
   * leader, exactly like the real daemon.
   */
  function spawnFakeDaemon(ignoreSigterm: boolean): ChildProcess {
    const scriptPath = path.join(tmpHome, 'fake-shizuha.js');
    const body = ignoreSigterm
      ? `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(SIGTERM_MARKER)}, '1'); }); setInterval(() => {}, 1000);`
      : `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
    fs.writeFileSync(scriptPath, body);
    const child = spawn(process.execPath, [scriptPath, 'up'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    children.push(child);
    return child;
  }

  function writePidLock(pid: number): void {
    fs.writeFileSync(path.join(tmpHome, PID_LOCK), String(pid));
  }

  function pidLockExists(): boolean {
    try {
      return fs.statSync(path.join(tmpHome, PID_LOCK)).isFile();
    } catch {
      return false;
    }
  }

  it('reports success only after a SIGTERM-cooperative daemon exits, then clears PID state', async () => {
    const child = spawnFakeDaemon(false);
    await sleep(500);
    expect(isShizuhaDaemonProcess(child.pid!)).toBe(true);
    writePidLock(child.pid!);
    expect(pidLockExists()).toBe(true);

    const result = stopDaemon();

    expect(result.escalated).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.remainingPids).toEqual([]);
    // The daemon exited on SIGTERM → durable PID state is cleared.
    expect(pidLockExists()).toBe(false);
  });

  it('escalates to SIGKILL when the daemon ignores SIGTERM, and only clears PID state after exit', async () => {
    const child = spawnFakeDaemon(true);
    await sleep(500);
    expect(isShizuhaDaemonProcess(child.pid!)).toBe(true);
    writePidLock(child.pid!);
    expect(pidLockExists()).toBe(true);

    const result = stopDaemon();

    // The fake daemon received SIGTERM (marker written) and ignored it.
    expect(fs.existsSync(SIGTERM_MARKER)).toBe(true);
    // SIGTERM was ignored → SIGKILL escalation happened.
    expect(result.escalated).toBe(true);
    // After SIGKILL the daemon is gone → stopped, no remaining PIDs.
    expect(result.stopped).toBe(true);
    expect(result.remainingPids).toEqual([]);
    // Durable PID state is cleared only after the daemon actually exited.
    expect(pidLockExists()).toBe(false);
    // The fake daemon process is really gone (not just a zombie).
    expect(isShizuhaDaemonProcess(child.pid!)).toBe(false);
  });

  it('is idempotent when no daemon is running and clears stale state', () => {
    // Stale lock file with a PID that is not a live shizuha daemon.
    writePidLock(999999);
    const result = stopDaemon();
    expect(result.stopped).toBe(true);
    expect(result.escalated).toBe(false);
    expect(result.remainingPids).toEqual([]);
    expect(pidLockExists()).toBe(false);
  });
});
