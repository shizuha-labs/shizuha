// SCLI-566 regression: `serve` host channel must sit inside the shared
// SCLI-400 preflight, exactly like the port channel.
//
// Live deploy-verify finding (san/devops, 2026-08-12, PLAT-5893 follow-up):
//   - `serve -h synthetic-extra` leaked a raw `node:dns` getaddrinfo stack
//     (value crossed semantic preflight into DNS/socket work).
//   - `serve --host=` started and bound an EMPTY-host listener (broadened
//     listener authority).
//
// This suite drives the REAL CLI (dist/shizuha.js) through the serve host
// channel and asserts every invalid host class rejects pre-init with ONE
// bounded diagnostic — no getaddrinfo/raw stack, no bundle absolute path, no
// listener bind, no process start.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function runServe(args: string[]) {
  return spawnSync('node', [CLI, 'serve', ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'scli566-')), FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 15000,
  });
}

describe('serve host preflight (SCLI-566)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('rejects unresolvable hostname pre-init with a bounded diagnostic (no getaddrinfo stack)', () => {
    const r = runServe(['-h', 'synthetic-extra']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Invalid --host "synthetic-extra"/);
    expect(r.stderr).toMatch(/does not resolve/);
    // No raw node:dns getaddrinfo stack, no bundle absolute path, no ERR_ code.
    expect(r.stderr).not.toMatch(/getaddrinfo|node:internal|at |\/dist\/|TypeError|ERR_/);
    // No listener bind / server start.
    expect(r.stdout + r.stderr).not.toMatch(/listening|server started/i);
  });

  it('rejects explicit-empty host pre-init (never binds an empty-host listener)', () => {
    for (const args of [['--host='], ['-h', '']]) {
      const r = runServe(args);
      expect(r.status, `status for ${JSON.stringify(args)}`).toBe(1);
      expect(r.stderr, `stderr for ${JSON.stringify(args)}`).toMatch(/Invalid --host/);
      expect(r.stderr).not.toMatch(/getaddrinfo|node:internal|at |\/dist\/|TypeError|ERR_/);
      expect(r.stdout + r.stderr).not.toMatch(/listening|server started/i);
    }
  });

  it('rejects whitespace-only host pre-init', () => {
    const r = runServe(['-h', '   ']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Invalid --host/);
    expect(r.stderr).not.toMatch(/getaddrinfo|node:internal|at |\/dist\/|TypeError|ERR_/);
  });

  it('rejects malformed/control-bearing host values pre-init', () => {
    const cases: Array<[string, string[]]> = [
      ['space', ['-h', 'bad host']],
      ['tab', ['-h', 'bad\thost']],
      ['newline', ['-h', 'bad\nhost']],
      ['colon', ['-h', 'host:1234']],
      ['bracket', ['-h', '[bad']],
      ['path', ['-h', '/tmp/evil']],
      ['underscore', ['-h', 'bad_host']],
    ];
    for (const [label, args] of cases) {
      const r = runServe(args);
      expect(r.status, `status for ${label}`).toBe(1);
      expect(r.stderr, `stderr for ${label}`).toMatch(/Invalid --host/);
      expect(r.stderr, `stderr for ${label}`).not.toMatch(/getaddrinfo|node:internal|at |\/dist\/|TypeError|ERR_/);
      expect(r.stdout + r.stderr, `stdout for ${label}`).not.toMatch(/listening|server started/i);
    }
  });

  it('rejects oversized host pre-init', () => {
    const r = runServe(['-h', 'a'.repeat(300)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Invalid --host/);
    expect(r.stderr).not.toMatch(/getaddrinfo|node:internal|at |\/dist\/|TypeError|ERR_/);
  });

  it('valid explicit IP host still starts the server (control)', () => {
    const r = runServe(['-h', '127.0.0.1', '-p', '18015']);
    // Server starts listening and blocks until the timeout kills it.
    expect(r.stdout + r.stderr).toMatch(/listening on 127\.0\.0\.1:18015|server started/i);
    expect(r.stderr).not.toMatch(/Invalid --host/);
  });
});
