/**
 * SCLI-563 black-box regressions for `shizuha up --agent`.
 *
 * An explicitly supplied `--agent` is a scope decision and must never collapse
 * to omission's all-agents default. Commander stores `undefined` when --agent
 * is omitted but `''` when it is passed empty (`--agent=` / `--agent ''`), so
 * an explicit-empty (or whitespace/control/comma-only/pathlike/oversized)
 * selector used to silently expand into an all-agents startup that crossed
 * first-run init, skill sync, network, and listener boundaries.
 *
 * These tests run the built `dist/shizuha.js` black-box against a fresh
 * isolated HOME and assert:
 *   - malformed selectors are rejected nonzero BEFORE any state is created,
 *   - valid single/comma-separated selectors are accepted and stay scoped,
 *   - omission still starts all default agents,
 *   - commander's missing-value and --help precedence are preserved.
 *
 * The daemon runs in foreground and never exits on its own, so output is
 * redirected to files (never pipes) and the whole process group is SIGKILLed on
 * timeout — a foreground daemon that forks agent subprocesses must not be able
 * to keep the test's stdout pipe open.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const projectDir = path.resolve(import.meta.dirname!, '../..');
const CLI = path.join(projectDir, 'dist', 'shizuha.js');

interface RunUpResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  stateCreated: boolean;
}

async function runUp(
  args: string[],
  opts: { timeoutMs?: number; noDefaults?: boolean } = {},
): Promise<RunUpResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli563-'));
  const outFile = path.join(home, 'out.log');
  const errFile = path.join(home, 'err.log');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const fullArgs = opts.noDefaults
    ? ['up', ...args]
    : ['up', ...args, '--no-service', '--foreground'];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    SHIZUHA_AUTO_UPDATE: '0',
    SHIZUHA_IMMUTABLE_SKILLS: '1',
    FORCE_COLOR: '0',
  };
  const child = spawn('node', [CLI, ...fullArgs], {
    cwd: projectDir,
    env,
    stdio: ['ignore', outFd, errFd],
    detached: true,
  });
  const outcome = await new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => {
    let settled = false;
    const finish = (exitCode: number, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, timedOut });
    };
    const timer = setTimeout(() => {
      try {
        // detached:true makes the child a process-group leader; kill the whole
        // group so forked agent subprocesses cannot survive as orphans.
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
      finish(-1, true);
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code ?? -1, false);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(-1, false);
    });
  });
  try {
    fs.closeSync(outFd);
  } catch {
    /* ignore */
  }
  try {
    fs.closeSync(errFd);
  } catch {
    /* ignore */
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  const stateCreated = fs.existsSync(path.join(home, '.shizuha'));
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return { stdout, stderr, exitCode: outcome.exitCode, timedOut: outcome.timedOut, stateCreated };
}

describe('SCLI-563: shizuha up --agent selector validation (black-box dist)', () => {
  beforeAll(() => {
    expect(fs.existsSync(CLI)).toBe(true);
  });

  describe('rejects malformed explicit --agent selectors before any state', () => {
    const cases: Array<[string, string[]]> = [
      ['explicit empty (--agent=)', ['--agent=']],
      ['explicit empty (--agent "")', ['--agent', '']],
      ['whitespace-only space', ['--agent', ' ']],
      ['whitespace-only tab', ['--agent', '\t']],
      ['control newline', ['--agent', 'a\nb']],
      ['control escape', ['--agent', '\x1b[31mred']],
      ['comma-only', ['--agent', ',']],
      ['empty comma segment', ['--agent', 'a,,b']],
      ['pathlike slash', ['--agent', 'a/b']],
      ['pathlike dotdot', ['--agent', '..']],
      ['unreasonable length', ['--agent', 'a'.repeat(3000)]],
    ];
    for (const [name, args] of cases) {
      it(`rejects ${name} with nonzero exit and no first-run init`, async () => {
        const r = await runUp(args);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain('Invalid --agent value');
        // Rejection must precede first-run init / HOME mutation.
        expect(r.stateCreated).toBe(false);
        expect(r.stdout).not.toContain('Shizuha Runtime v0.1.0');
      });
    }

    it('bounds the diagnostic instead of echoing a long selector', async () => {
      const r = await runUp(['--agent', 'a'.repeat(3000)]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('Invalid --agent value');
      expect(r.stderr).not.toContain('a'.repeat(3000));
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
    });

    it('escapes control characters so a newline cannot forge a diagnostic line', async () => {
      const r = await runUp(['--agent', 'a\nb']);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('\\n'); // escaped, not a literal line break
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
    });
  });

  describe('accepts valid explicit selectors and keeps them scoped', () => {
    it('accepts a valid single selector and scopes to it (no all-agents fallback)', async () => {
      const r = await runUp(['--agent', 'zen']);
      expect(r.stderr).toContain('No agents match filter: zen');
      expect(r.stderr).not.toContain('Invalid --agent value');
    });

    it('accepts a valid comma-separated selector, trimming whitespace', async () => {
      const r = await runUp(['--agent', ' zen , mika ']);
      expect(r.stderr).toContain('No agents match filter: zen, mika');
      expect(r.stderr).not.toContain('Invalid --agent value');
    });
  });

  describe('preserves omission and matching-valid behavior', () => {
    it('omission still starts all default agents (not rejected)', async () => {
      const r = await runUp([], { timeoutMs: 6000 });
      expect(r.timedOut).toBe(true); // daemon runs until killed
      expect(r.stdout).toContain('Shizuha Runtime v0.1.0');
      expect(r.stdout).toContain('created 4 default agents');
      expect(r.stderr).not.toContain('Invalid --agent value');
    });

    it('a matching valid selector is scoped to that agent', async () => {
      const r = await runUp(['--agent', 'claude'], { timeoutMs: 6000 });
      expect(r.timedOut).toBe(true);
      expect(r.stdout).toContain('Shizuha Runtime v0.1.0');
      expect(r.stdout).toContain('created 4 default agents');
      expect(r.stderr).not.toContain('Invalid --agent value');
      expect(r.stderr).not.toContain('No agents match filter');
    });
  });

  describe('missing value and help order', () => {
    it('missing option value is rejected by commander', async () => {
      const r = await runUp(['--agent'], { noDefaults: true });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('argument missing');
    });

    it('--help shows usage and exits 0', async () => {
      const r = await runUp(['--help']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Usage: shizuha up');
    });

    it('--help takes precedence over an invalid --agent value', async () => {
      const r = await runUp(['--agent=', '--help']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Usage: shizuha up');
    });
  });
});
