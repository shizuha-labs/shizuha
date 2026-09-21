// SCLI-414 regression (CLI-level): the full public journey
//   auth cortex <key> → auth status (configured) → logout → auth status (cleared)
// must be honest: logout clears the stored Cortex credential, not just the
// platform auth. Drives the BUILT CLI (dist/shizuha.js) in an isolated HOME.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scli414cli-'));
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
    input: '',
  });
}

describe('SCLI-414 logout clears stored Cortex credential (CLI)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('auth cortex → status configured → logout → status not configured', () => {
    const home = freshHome();

    const set = run(['auth', 'cortex', 'sk-cortex-QA_SYNTHETIC_NOT_SECRET_0001'], home);
    expect(set.status).toBe(0);
    expect(set.stdout).toMatch(/Cortex key saved/);

    const before = run(['auth', 'status'], home);
    expect(before.status).toBe(0);
    expect(before.stdout).toMatch(/Cortex: API key configured|Cortex: configured/i);

    const logout = run(['logout'], home);
    expect(logout.status).toBe(0);
    expect(logout.stdout).toMatch(/Authentication cleared/);

    const after = run(['auth', 'status'], home);
    expect(after.status).toBe(0);
    expect(after.stdout).toMatch(/Cortex: not configured|Cortex: not/i);

    // The stored credential file no longer holds the Cortex key.
    const credsPath = path.join(home, '.shizuha', 'credentials.json');
    if (fs.existsSync(credsPath)) {
      const raw = fs.readFileSync(credsPath, 'utf-8');
      expect(raw).not.toContain('sk-cortex-QA_SYNTHETIC_NOT_SECRET_0001');
    }
  });

  it('logout is idempotent (repeat reports cleared, exit 0)', () => {
    const home = freshHome();
    run(['auth', 'cortex', 'sk-cortex-QA_SYNTHETIC_NOT_SECRET_0002'], home);
    run(['logout'], home);
    const again = run(['logout'], home);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/Authentication cleared/);
  });
});
