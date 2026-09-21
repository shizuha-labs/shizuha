// SCLI-402 regression: `shizuha config --cwd <dir>` must resolve configuration
// for the explicit target directory (both placements — before and after the
// subcommand) and report that exact canonical directory, never the caller CWD.
// A nonexistent/unreadable explicit directory rejects nonzero with a bounded
// error. No-option behavior continues to resolve from the caller CWD.
//
// Requires the node bundle (dist/shizuha.js); CI builds it before the suite.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function runConfig(home: string, caller: string, args: string[]) {
  return spawnSync('node', [CLI, ...args], {
    cwd: caller,
    env: { ...process.env, HOME: home, TERM: 'dumb', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function agentCwd(stdout: string): string | null {
  try {
    return JSON.parse(stdout)?.agent?.cwd ?? null;
  } catch {
    return null;
  }
}

describe('config --cwd resolution (SCLI-402)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('resolves agent.cwd to the explicit target for the after-subcommand placement', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-'));
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-caller-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-target-'));
    try {
      const r = runConfig(home, caller, ['config', '--cwd', target]);
      expect(r.status).toBe(0);
      expect(agentCwd(r.stdout)).toBe(target);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('resolves agent.cwd to the explicit target for the before-subcommand placement', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-'));
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-caller-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-target-'));
    try {
      const r = runConfig(home, caller, ['--cwd', target, 'config']);
      expect(r.status).toBe(0);
      expect(agentCwd(r.stdout)).toBe(target);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('resolves agent.cwd to the target for same-value-both placements', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-'));
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-caller-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-target-'));
    try {
      const r = runConfig(home, caller, ['--cwd', target, 'config', '--cwd', target]);
      expect(r.status).toBe(0);
      expect(agentCwd(r.stdout)).toBe(target);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects a nonexistent explicit directory nonzero with a bounded error', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-'));
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-caller-'));
    try {
      const r = runConfig(home, caller, ['config', '--cwd', '/nonexistent/scli402-xyz']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--cwd must be an existing directory');
      expect(r.stderr).not.toMatch(/at |node:internal|\/dist\/|TypeError|ERR_/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
    }
  });

  it('resolves agent.cwd to the caller CWD with no --cwd option', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-'));
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'scli402-caller-'));
    try {
      const r = runConfig(home, caller, ['config']);
      expect(r.status).toBe(0);
      expect(agentCwd(r.stdout)).toBe(caller);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(caller, { recursive: true, force: true });
    }
  });
});
