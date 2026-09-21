// SCLI-421 regression: `gemini-bridge` must fail loud and bounded, never hang.
//
// The old gemini-bridge launched browser OAuth on a fresh/headless runtime and
// stayed alive without a listener after the Gemini child exited 0. Gemini CLI
// was permanently replaced by Antigravity CLI (commit 50473ae7, on master
// 2026-07-28): the command now refuses with a bounded actionable diagnostic
// and exit 2 — no browser OAuth, no runtime/session state creation, no hang.
//
// Requires the node bundle (dist/shizuha.js); CI builds it before the suite.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function runGeminiBridge(home: string) {
  return spawnSync('node', [CLI, 'gemini-bridge'], {
    cwd: ROOT,
    // Fresh HOME, dumb terminal, no colour, closed stdin (headless).
    input: '',
    env: { ...process.env, HOME: home, TERM: 'dumb', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 15000,
  });
}

describe('gemini-bridge removed — fails loud, never hangs (SCLI-421)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `node bundle missing at ${CLI}; run 'npm run build:node' (CI does this before the suite)`,
      );
    }
  });

  it('exits nonzero with a bounded actionable diagnostic on a fresh HOME (run 1)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli421-gb1-'));
    try {
      const r = runGeminiBridge(home);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('gemini-bridge has been removed');
      expect(r.stderr).toContain('antigravity-bridge');
      // No hang: spawnSync returned within the 15s timeout (status set).
      expect(r.error).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits nonzero deterministically on a second fresh HOME (run 2)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli421-gb2-'));
    try {
      const r = runGeminiBridge(home);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('gemini-bridge has been removed');
      expect(r.error).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not create runtime/session state in the fresh HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli421-gb3-'));
    try {
      runGeminiBridge(home);
      // No gemini session/settings metadata may be created before the refusal.
      const shizuhaDir = path.join(home, '.shizuha');
      expect(fs.existsSync(shizuhaDir)).toBe(false);
      const geminiDir = path.join(home, '.gemini');
      expect(fs.existsSync(geminiDir)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
