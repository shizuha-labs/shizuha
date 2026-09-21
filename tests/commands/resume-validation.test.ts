import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// SCLI-490: `shizuha resume` must reject empty/whitespace-only session-ids
// before lookup with a clear validation error and nonzero exit — not the
// identifier-free "Session not found:" verdict. Nonblank unknown IDs keep a
// bounded not-found verdict; no raw stack on any path.

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(REPO_ROOT, 'dist', 'shizuha.js');

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scli490-'));
}

function runResume(id: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(
    // Spawn the CURRENT node binary by absolute path (process.execPath), not
    // a bare `node` resolved via PATH: the test pins PATH to /usr/bin:/bin for
    // hermeticity, but CI's node:22-bookworm image installs node to
    // /usr/local/bin — a bare `node` would not be found and the spawn would
    // fail with empty stderr, tripping every assertion.
    process.execPath,
    [CLI, 'resume', id],
    {
      env: { ...process.env, HOME: freshHome(), PATH: '/usr/bin:/bin', TERM: 'dumb', NO_COLOR: '1' },
      input: '',
      encoding: 'utf8',
      // Generous bound: CI runs the full suite with SHIZUHA_CI_MAX_WORKERS=2,
      // so a cold node bundle + contended node can take longer than a local
      // run to boot. 10s was flaky under that contention; 30s keeps the
      // spawn-based regression bounded without tripping the correctness gate.
      timeout: 30000,
    },
  );
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('resume session-id validation (SCLI-490)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      const build = spawnSync('node', ['esbuild.config.js'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000 });
      expect(build.status).toBe(0);
    }
  });

  it('rejects an empty session-id with a clear validation error', () => {
    const r = runResume('');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('session-id must be a non-empty value');
    expect(r.stderr).not.toMatch(/at /); // no raw stack
  });

  it('rejects ASCII whitespace-only session-ids (space, tab, LF, CRLF)', () => {
    for (const id of ['   ', '\t', '\n', '\r\n']) {
      const r = runResume(id);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('session-id must be a non-empty value');
      expect(r.stderr).not.toMatch(/at /);
    }
  });

  it('rejects Unicode whitespace-only session-ids (NBSP, EM space)', () => {
    for (const id of ['\u00A0', '\u2003']) {
      const r = runResume(id);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('session-id must be a non-empty value');
      expect(r.stderr).not.toMatch(/at /);
    }
  });

  it('keeps a bounded not-found verdict for an ordinary unknown ID', () => {
    const r = runResume('nonexistent-session-xyz');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Session not found: nonexistent-session-xyz');
    expect(r.stderr).not.toMatch(/at /);
  });

  it('keeps a bounded verdict for Unicode and traversal-shaped unknown IDs', () => {
    for (const id of ['\u30bb\u30c3\u30b7\u30e7\u30f3', '../etc/passwd', 'a/b/c']) {
      const r = runResume(id);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Session not found');
      expect(r.stderr).not.toMatch(/at /);
    }
  });
});
