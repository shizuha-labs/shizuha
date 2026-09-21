// SCLI-411 regression: `shizuha -p ''` / `-p '   '` / `exec -p ''` / `exec -p '   '`
// must reject nonzero with a prompt-specific diagnostic BEFORE any auth/provider/
// TUI/state work — never fall back to the interactive renderer or exit 0.
//
// Drives the BUILT CLI (dist/shizuha.js) in an isolated fresh HOME with
// redirected non-TTY stdout/stderr and closed stdin, asserting exact
// exit/channel/state behavior. Requires the node bundle; CI builds it before
// the suite (npm run ci: build:check -> build:node -> vitest).
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scli411-'));
}

function run(args: string[], home: string) {
  return spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? '',
      TERM: 'dumb',
      NO_COLOR: '1',
      SHIZUHA_AUTO_UPDATE: '0',
    },
    encoding: 'utf8',
    timeout: 15000,
    input: '', // closed stdin
  });
}

describe('SCLI-411 blank-prompt preflight (root + exec)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('root -p "" rejects nonzero, prompt-specific, ANSI-free, state-free', () => {
    const home = freshHome();
    const r = run(['-p', ''], home);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toMatch(/Interactive Agent|Initializing/);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--prompt/);
    expect(r.stderr).not.toMatch(/TypeError|\/opt\/|at /i);
    // No state created in the fresh HOME.
    expect(fs.existsSync(path.join(home, '.config', 'shizuha', 'state.db'))).toBe(false);
  });

  it('root -p "   " rejects nonzero, prompt-specific, state-free', () => {
    const home = freshHome();
    const r = run(['-p', '   '], home);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--prompt/);
    expect(fs.existsSync(path.join(home, '.config', 'shizuha', 'state.db'))).toBe(false);
  });

  it('exec -p "" rejects nonzero before auth/provider work', () => {
    const home = freshHome();
    const r = run(['exec', '-p', ''], home);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/--prompt/);
    expect(r.stderr).not.toMatch(/Codex not authenticated/);
  });

  it('exec -p "   " rejects nonzero before auth/provider work', () => {
    const home = freshHome();
    const r = run(['exec', '-p', '   '], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--prompt/);
    expect(r.stderr).not.toMatch(/Codex not authenticated/);
  });

  it('missing-value / unknown-option controls stay precise and state-free', () => {
    const home = freshHome();
    const r = run(['-p'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/prompt|argument/i);
    expect(fs.existsSync(path.join(home, '.config', 'shizuha', 'state.db'))).toBe(false);
  });
});
