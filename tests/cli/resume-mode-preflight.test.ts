// SCLI-178 / PLAT-5893 regression: `shizuha resume <real-session> --mode <bad>`
// must reject pre-init through the shared option preflight instead of entering
// the full resume path and rendering a blank permission-mode footer.
//
// Zen's post-head whole-class residual (installed 1932e0bc…): public
// `resume <real-session> --mode nope|AUTONOMOUS|=|'   '` entered the full
// resume path (session loaded, TUI launched) with an invalid permission mode.
// The dedicated `resume` subcommand was the one action exposing --mode that did
// NOT run the shared option preflight. This test seeds a REAL resumed session
// in an isolated HOME and drives the BUILT CLI (dist/shizuha.js) so the
// regression exercises the actual public boundary.
//
// Requires the node bundle (dist/shizuha.js); CI builds it before the suite
// (npm run ci: build:check -> build:node -> vitest).
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../src/state/store.js';
import { validateCommonAgentOptions } from '../../src/cli/option-preflight.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function seedSession(home: string): string {
  const dbPath = path.join(home, '.config', 'shizuha', 'state.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new StateStore(dbPath);
  const s = store.createSession('gpt-5.3-codex', '/tmp/realproj');
  store.appendMessage(s.id, {
    id: 'm1',
    role: 'user',
    content: 'hello from a real resumed session',
    timestamp: Date.now(),
  });
  store.close();
  return s.id;
}

function runResume(home: string, sessionId: string, mode: string) {
  const args = ['resume', sessionId];
  if (mode !== null) {
    args.push('--mode', mode);
  }
  return spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 20000,
  });
}

// SCLI-523: resume with extra --cwd/--mode overrides. mode === null means omit
// the flag entirely; cwd === null means omit --cwd.
function runResumeOverrides(home: string, sessionId: string, opts: { mode?: string | null; cwd?: string | null }) {
  const args = ['resume', sessionId];
  if (opts.mode !== null && opts.mode !== undefined) {
    args.push('--mode', opts.mode);
  }
  if (opts.cwd !== null && opts.cwd !== undefined) {
    args.push('--cwd', opts.cwd);
  }
  return spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 20000,
  });
}

function stateDbPath(home: string): string {
  return path.join(home, '.config', 'shizuha', 'state.db');
}

describe('resume --mode preflight (SCLI-178 / PLAT-5893)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('rejects every invalid --mode value pre-init on a real resumed session', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli178-resume-'));
    try {
      const sessionId = seedSession(home);
      // Prove the session is real and resumable before the negative assertions.
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

      for (const bad of ['nope', 'AUTONOMOUS', '=', '   ']) {
        const r = runResume(home, sessionId, bad);
        expect(r.status, `status for --mode ${JSON.stringify(bad)}`).toBe(1);
        expect(r.stderr, `stderr for --mode ${JSON.stringify(bad)}`).toContain(
          'Invalid --mode',
        );
        expect(r.stderr).toContain('plan, supervised, autonomous');
        // Bounded diagnostic: no raw stack / bundle path / node internals.
        expect(r.stderr).not.toMatch(/at |node:internal|\/dist\/|TypeError|ERR_/i);
        // Must NOT reach the resume body (no "Session not found", no TUI paint).
        expect(r.stdout + r.stderr).not.toMatch(/Session not found|Interactive Agent|Initializing/);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts a valid --mode: preflight passes and the resume flow proceeds past it', () => {
    // Unit-level: a valid permission mode passes the shared option domain.
    expect(validateCommonAgentOptions({ mode: 'plan' }).mode).toBe('plan');
    expect(validateCommonAgentOptions({ mode: 'supervised' }).mode).toBe('supervised');
    expect(validateCommonAgentOptions({ mode: 'autonomous' }).mode).toBe('autonomous');

    // CLI-level: with a valid --mode the preflight does NOT reject, so the
    // resume body runs and reports the missing session instead of "Invalid
    // --mode". This is deliberately TTY-independent: launching the interactive
    // TUI from a spawned (non-TTY) process is unsupported by Ink in CI
    // ("Raw mode is not supported"), so the valid-mode TUI paint is NOT part
    // of this regression's assertion surface.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli178-resume-ok-'));
    try {
      const r = runResume(home, 'no-such-session', 'plan');
      expect(r.stdout + r.stderr).not.toMatch(/Invalid --mode/);
      expect(r.stdout + r.stderr).toMatch(/Session not found/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// SCLI-523: `shizuha resume` must (1) adjudicate --cwd at the public boundary
// before session lookup (empty/whitespace/non-directory rejected pre-init) and
// (2) keep a failed read-only session lookup state-free — a syntactically valid
// but unknown session id (or an invalid override path) must NOT create
// ~/.config/shizuha/state.db in a fresh HOME.
describe('resume --cwd preflight + state-free lookup (SCLI-523)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('rejects empty --cwd before session lookup, state-free', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli523-cwd-empty-'));
    try {
      const r = runResumeOverrides(home, '00000000-0000-0000-0000-000000000000', { cwd: '' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--cwd must be an existing directory');
      expect(r.stderr).toContain('empty or whitespace-only');
      expect(r.stderr).not.toMatch(/Session not found|at |node:internal|\/dist\/|TypeError|ERR_/i);
      expect(fs.existsSync(stateDbPath(home))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects whitespace-only --cwd before session lookup, state-free', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli523-cwd-ws-'));
    try {
      const r = runResumeOverrides(home, '00000000-0000-0000-0000-000000000000', { cwd: '   ' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--cwd must be an existing directory');
      expect(r.stderr).toContain('empty or whitespace-only');
      expect(r.stderr).not.toMatch(/Session not found|at |node:internal|\/dist\/|TypeError|ERR_/i);
      expect(fs.existsSync(stateDbPath(home))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects non-directory --cwd before session lookup, state-free', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli523-cwd-nd-'));
    try {
      const r = runResumeOverrides(home, '00000000-0000-0000-0000-000000000000', { cwd: '/no/such/dir/xyz' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--cwd must be an existing directory');
      expect(r.stderr).toContain('path does not resolve');
      expect(r.stderr).not.toMatch(/Session not found|at |node:internal|\/dist\/|TypeError|ERR_/i);
      expect(fs.existsSync(stateDbPath(home))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects invalid --mode before session lookup, state-free', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli523-mode-'));
    try {
      const r = runResumeOverrides(home, '00000000-0000-0000-0000-000000000000', { mode: 'synthetic-invalid' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Invalid --mode');
      expect(r.stderr).not.toMatch(/Session not found|at |node:internal|\/dist\/|TypeError|ERR_/i);
      expect(fs.existsSync(stateDbPath(home))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps a syntactically valid unknown-session lookup state-free', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli523-unknown-'));
    try {
      const r = runResumeOverrides(home, '00000000-0000-0000-0000-000000000000', {});
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/Session not found/);
      expect(r.stdout + r.stderr).not.toMatch(/at |node:internal|\/dist\/|TypeError|ERR_/i);
      expect(fs.existsSync(stateDbPath(home))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts a valid --cwd on a real session: preflight passes and lookup proceeds', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli523-cwd-ok-'));
    try {
      const sessionId = seedSession(home);
      const r = runResumeOverrides(home, sessionId, { cwd: '/tmp' });
      // Valid --cwd must not be rejected by preflight; the resume body runs and
      // (in a non-TTY spawn) reports the Ink raw-mode limitation rather than an
      // option diagnostic. Crucially it must NOT say "Invalid --cwd".
      expect(r.stdout + r.stderr).not.toMatch(/Invalid --cwd/);
      expect(r.stdout + r.stderr).not.toMatch(/Invalid --mode/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
