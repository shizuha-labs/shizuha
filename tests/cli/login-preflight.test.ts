// SCLI-178 / PLAT-5893 / SCLI-492 regression: `shizuha login -u ''` / `-p ''`
// and whitespace-only credentials must reject through the shared required-value
// preflight BEFORE any prompt, state, or network work.
//
// Zen's exact-current QA (installed 1932e0bc…): `login -u '' -p <value>` and
// `login -u <value> -p ''` silently enter the interactive prompt path and render
// a blank terminal (surviving to the external bound), and whitespace-only
// username/password cross into the downstream auth path producing the same
// "Login failed: fetch failed" as the non-empty control. Missing-value and
// unknown-option controls already reject locally at exit 1, proving the parser
// can fail — the gap was the explicit-empty/whitespace class.
//
// Requires the node bundle (dist/shizuha.js); CI builds it before the suite.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function runLogin(home: string, args: string[]) {
  return spawnSync('node', [CLI, 'login', ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 15000,
  });
}

describe('login --username/--password preflight (SCLI-178 / SCLI-492)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('rejects explicit-empty and whitespace-only username/password pre-init', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli178-login-'));
    try {
      const cases: Array<[string, string[]]> = [
        ['empty username', ['-u', '', '-p', 'secret']],
        ['empty password', ['-u', 'alice', '-p', '']],
        ['whitespace username', ['-u', '   ', '-p', 'secret']],
        ['whitespace password', ['-u', 'alice', '-p', '   ']],
      ];
      for (const [label, args] of cases) {
        const r = runLogin(home, args);
        expect(r.status, `status for ${label}`).toBe(1);
        // Bounded diagnostic naming the field — no raw stack / bundle path.
        expect(r.stderr, `stderr for ${label}`).toMatch(/Invalid --(username|password)/);
        expect(r.stderr).not.toMatch(/at |node:internal|\/dist\/|TypeError|ERR_|fetch failed/i);
        // Must NOT enter the interactive prompt or auth path.
        expect(r.stdout + r.stderr).not.toMatch(/Username:|Password:|Logged in as|Login failed|Credentials saved/);
      }
      // No auth state written for any rejected case.
      const authFile = path.join(home, '.shizuha', 'auth.json');
      expect(fs.existsSync(authFile)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves the interactive prompt when credentials are absent', () => {
    // With no -u/-p, login enters the interactive prompt path (reads from
    // stdin). In a non-TTY spawn, readline on a closed stdin resolves '' —
    // the CLI proceeds toward auth with empty creds. We assert the CLI does NOT
    // exit 1 with an option diagnostic (i.e. preflight did not reject absent
    // values), which is the SCLI-492 contract: absent stays optional.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli178-login-absent-'));
    try {
      const r = runLogin(home, []);
      expect(r.stderr).not.toMatch(/Invalid --(username|password)/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
