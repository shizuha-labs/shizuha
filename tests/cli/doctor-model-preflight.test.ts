// SCLI-579 regression: `shizuha doctor --model <blank>` must reject the
// supplied-but-blank selector locally (nonzero, bounded diagnostic) BEFORE
// doctor runs or mutates state — never report "No model selected in this
// session" and certify healthy with exit 0.
//
// Zen's live audit (SCLI-178, installed 0.1.0 artifact): `doctor --model=`,
// `--model='   '`, and a Unicode em-space each ran the full doctor, reported
// "Selected model: No model selected in this session", created a fresh
// ~/.config/shizuha/state.db, and exited 0 with "0 failed".
//
// Requires the node bundle (dist/shizuha.js); CI builds it before the suite.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function runDoctor(home: string, model: string | null) {
  const args = ['doctor'];
  if (model !== null) args.push('--model', model);
  return spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, TERM: 'dumb', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
}

describe('doctor --model blank-selector preflight (SCLI-579)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('rejects explicit-empty, ASCII-whitespace, and Unicode-whitespace --model values nonzero', () => {
    for (const bad of ['', '   ', '\t\n ', '\u2003', '\u00a0']) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli579-doctor-'));
      try {
        const r = runDoctor(home, bad);
        expect(r.status, `status for --model ${JSON.stringify(bad)}`).toBe(1);
        expect(r.stderr, `stderr for --model ${JSON.stringify(bad)}`).toContain(
          'Invalid --model',
        );
        expect(r.stderr).toContain('non-empty');
        // Bounded diagnostic: no raw stack / bundle path / node internals.
        expect(r.stderr).not.toMatch(/at |node:internal|\/dist\/|TypeError|ERR_/i);
        // Must NOT reach the doctor body (no "No model selected", no results).
        expect(r.stdout + r.stderr).not.toMatch(/No model selected|Results:/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('does not create a state.db for rejected blank selectors', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli579-nostate-'));
    try {
      const r = runDoctor(home, '   ');
      expect(r.status).toBe(1);
      const dbPath = path.join(home, '.config', 'shizuha', 'state.db');
      expect(fs.existsSync(dbPath), 'rejected value must not create state.db').toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps --help ordering consistent (both orders show help, never certify)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli579-help-'));
    try {
      const before = runDoctor(home, '');
      // --model '' --help: Commander short-circuits to help (shared policy).
      const r1 = spawnSync('node', [CLI, 'doctor', '--model', '', '--help'], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, TERM: 'dumb', NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 30000,
      });
      const r2 = spawnSync('node', [CLI, 'doctor', '--help', '--model', ''], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, TERM: 'dumb', NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 30000,
      });
      // Both orders must behave identically (help text, same exit), so argument
      // order alone can never flip a blank selector into a passing doctor run.
      expect(r1.stdout).toContain('Usage: shizuha doctor');
      expect(r2.stdout).toContain('Usage: shizuha doctor');
      expect(r1.status).toBe(r2.status);
      expect(r1.stdout + r1.stderr).not.toMatch(/No model selected|Results:/);
      expect(r2.stdout + r2.stderr).not.toMatch(/No model selected|Results:/);
      // The non-help blank selector still rejects nonzero (control).
      expect(before.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
