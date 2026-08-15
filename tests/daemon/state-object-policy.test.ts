import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyStateObject,
  readDaemonState,
  readPidLock,
} from '../../src/daemon/state.js';

function makeFifo(filePath: string): void {
  const r = spawnSync('mkfifo', [filePath], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`mkfifo ${filePath} failed: ${r.stderr || r.stdout || r.status}`);
  }
}

describe('SCLI-434 persisted-state object policy', () => {
  let tmpHome: string;
  const originalHome = process.env['HOME'];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli434-state-'));
    process.env['HOME'] = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('classifies missing / regular / directory / fifo', () => {
    const missing = path.join(tmpHome, 'nope.json');
    expect(classifyStateObject(missing)).toBe('missing');

    const regular = path.join(tmpHome, '.shizuha', 'daemon.json');
    fs.writeFileSync(regular, '{"pid":9}', { mode: 0o600 });
    expect(classifyStateObject(regular)).toBe('regular');

    const dir = path.join(tmpHome, '.shizuha', 'adir');
    fs.mkdirSync(dir);
    expect(classifyStateObject(dir)).toBe('directory');

    const fifo = path.join(tmpHome, '.shizuha', 'afifo');
    makeFifo(fifo);
    expect(classifyStateObject(fifo)).toBe('fifo');
  });

  it('readDaemonState returns JSON for a regular file and does not open a FIFO', () => {
    const regular = path.join(tmpHome, '.shizuha', 'daemon.json');
    fs.writeFileSync(regular, JSON.stringify({ pid: 42, startedAt: 't', agents: [] }), { mode: 0o600 });
    expect(readDaemonState()?.pid).toBe(42);

    fs.rmSync(regular);
    makeFifo(regular);
    const started = Date.now();
    expect(readDaemonState()).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('readPidLock ignores a FIFO at daemon.pid', () => {
    const lock = path.join(tmpHome, '.shizuha', 'daemon.pid');
    makeFifo(lock);
    const started = Date.now();
    expect(readPidLock()).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
