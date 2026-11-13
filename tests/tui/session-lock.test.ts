import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  acquireSessionLock,
  describeSessionLockConflict,
  releaseSessionLock,
  sessionLockDir,
} from '../../src/tui/session-lock.js';

describe('TUI single-instance session lock', () => {
  const tmpDirs: string[] = [];

  function tmpLockDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-session-lock-'));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const base = (lockDir: string) => ({
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    lockDir,
    hostname: 'host-a',
  });

  it('acquires exclusively and records holder metadata', () => {
    const lockDir = tmpLockDir();
    const result = acquireSessionLock({ ...base(lockDir), pid: 100 });
    expect(result.acquired).toBe(true);
    const file = path.join(sessionLockDir(lockDir), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.pid).toBe(100);
    expect(parsed.hostname).toBe('host-a');
    expect(typeof parsed.token).toBe('string');
    expect(typeof parsed.startedAt).toBe('string');
  });

  it('refuses a second TUI while the holder is alive, keeping the original lock', () => {
    const lockDir = tmpLockDir();
    const first = acquireSessionLock({ ...base(lockDir), pid: 100 });
    expect(first.acquired).toBe(true);
    const file = path.join(sessionLockDir(lockDir), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    const original = fs.readFileSync(file, 'utf-8');

    const second = acquireSessionLock({ ...base(lockDir), pid: 200, isAlive: () => true });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toBe('alive');
      expect(second.holder?.pid).toBe(100);
    }
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });

  it('steals the lock when the holder process is dead', () => {
    const lockDir = tmpLockDir();
    const first = acquireSessionLock({ ...base(lockDir), pid: 100 });
    expect(first.acquired).toBe(true);

    const second = acquireSessionLock({ ...base(lockDir), pid: 200, isAlive: () => false });
    expect(second.acquired).toBe(true);
    const file = path.join(sessionLockDir(lockDir), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(200);
  });

  it('steals a corrupt lock file instead of refusing forever', () => {
    const lockDir = tmpLockDir();
    const file = path.join(sessionLockDir(lockDir), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    fs.mkdirSync(sessionLockDir(lockDir), { recursive: true });
    fs.writeFileSync(file, '{ truncated');
    const result = acquireSessionLock({ ...base(lockDir), pid: 300 });
    expect(result.acquired).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(300);
  });

  it('takeover signals a live holder and acquires once it releases', () => {
    const lockDir = tmpLockDir();
    acquireSessionLock({ ...base(lockDir), pid: 100 });
    const file = path.join(sessionLockDir(lockDir), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    const signalled: number[] = [];

    const result = acquireSessionLock({
      ...base(lockDir),
      pid: 200,
      isAlive: () => fs.existsSync(file),
      signalHolder: (pid) => {
        signalled.push(pid);
        fs.rmSync(file, { force: true }); // holder releases via its exit hook
      },
      takeover: true,
      takeoverWaitMs: 500,
    });
    expect(signalled).toEqual([100]);
    expect(result.acquired).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(200);
  });

  it('takeover steals after the wait when the holder ignores the signal', () => {
    const lockDir = tmpLockDir();
    acquireSessionLock({ ...base(lockDir), pid: 100 });
    const result = acquireSessionLock({
      ...base(lockDir),
      pid: 200,
      isAlive: () => true,
      signalHolder: () => { /* holder ignores SIGTERM */ },
      takeover: true,
      takeoverWaitMs: 30,
    });
    expect(result.acquired).toBe(true);
    const file = path.join(sessionLockDir(lockDir), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(200);
  });

  it('never steals a lock held on another host, even with takeover', () => {
    const lockDir = tmpLockDir();
    acquireSessionLock({ ...base(lockDir), pid: 100, hostname: 'host-b' });
    const result = acquireSessionLock({
      ...base(lockDir),
      pid: 200,
      isAlive: () => true,
      takeover: true,
    });
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.reason).toBe('remote-host');
      expect(result.holder?.hostname).toBe('host-b');
    }
  });

  it('release removes the owner lock but never a foreign successor lock', () => {
    const lockDir = tmpLockDir();
    const file = path.join(sessionLockDir(lockDir), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json');
    acquireSessionLock({ ...base(lockDir), pid: 100 });
    releaseSessionLock({ ...base(lockDir), pid: 100 });
    expect(fs.existsSync(file)).toBe(false);

    // A successor took over (different pid/token); the old owner must not delete it.
    acquireSessionLock({ ...base(lockDir), pid: 100 });
    acquireSessionLock({ ...base(lockDir), pid: 200, isAlive: () => false });
    releaseSessionLock({ ...base(lockDir), pid: 100 });
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(200);
  });

  it('sanitizes hostile session ids into safe lock filenames', () => {
    const lockDir = tmpLockDir();
    const result = acquireSessionLock({ sessionId: '../../evil id', lockDir, pid: 100 });
    expect(result.acquired).toBe(true);
    const dirEntries = fs.readdirSync(sessionLockDir(lockDir));
    expect(dirEntries).toEqual(['.._.._evil_id.json']);
  });

  it('describes a conflict with actionable guidance', () => {
    const message = describeSessionLockConflict('sess-1', {
      acquired: false,
      holder: { pid: 42990, hostname: 'host-a', startedAt: '2026-09-26T04:35:38.000Z', cwd: '/work' },
      reason: 'alive',
    });
    expect(message).toContain('sess-1');
    expect(message).toContain('42990');
    expect(message).toContain('--take-over');

    const remote = describeSessionLockConflict('sess-1', {
      acquired: false,
      holder: { pid: 1, hostname: 'other-host', startedAt: '2026-09-26T04:35:38.000Z' },
      reason: 'remote-host',
    });
    expect(remote).toContain('other-host');
    expect(remote).toContain('another host');
  });
});
