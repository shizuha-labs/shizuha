import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { assertWorkspaceDir } from '../../src/utils/fs.js';

/**
 * SCLI-493 regression: shared bridge `--cwd` preflight.
 *
 * Both `codex-bridge` and `openclaw-bridge` must reject a bad working directory
 * BEFORE session/token/telemetry/gateway init. This test exercises the shared
 * `assertWorkspaceDir` helper across the full acceptance matrix:
 *   reject — empty/whitespace, nonexistent, regular file, FIFO, dangling-symlink
 *   accept — existing directory, and a symlink resolving to a directory
 */

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'scli493-ws-'));
const CLEANUPS: string[] = [];

afterEach(() => {
  while (CLEANUPS.length > 0) {
    const p = CLEANUPS.pop();
    if (p) fsSync.rmSync(p, { recursive: true, force: true });
  }
});

function track(p: string): string {
  CLEANUPS.push(p);
  return p;
}

describe('assertWorkspaceDir (shared --cwd preflight)', () => {
  it('accepts an existing directory', () => {
    const dir = track(fsSync.mkdtempSync(path.join(TMP, 'ok-dir-')));
    expect(assertWorkspaceDir(dir)).toBe(fsSync.realpathSync(dir));
  });

  it('accepts a symlink resolving to an existing directory', () => {
    const target = track(fsSync.mkdtempSync(path.join(TMP, 'link-target-')));
    const link = track(path.join(TMP, 'link-' + path.basename(target)));
    fsSync.symlinkSync(target, link);
    expect(assertWorkspaceDir(link)).toBe(fsSync.realpathSync(target));
  });

  it('rejects an empty value', () => {
    expect(() => assertWorkspaceDir('')).toThrow(/--cwd/);
    expect(() => assertWorkspaceDir(undefined)).toThrow(/--cwd/);
  });

  it('rejects a whitespace-only value', () => {
    expect(() => assertWorkspaceDir('   ')).toThrow(/--cwd/);
    expect(() => assertWorkspaceDir('\t\n')).toThrow(/--cwd/);
  });

  it('rejects a nonexistent directory', () => {
    const missing = track(path.join(TMP, 'does-not-exist-xyz'));
    expect(() => assertWorkspaceDir(missing)).toThrow(/--cwd/);
    expect(() => assertWorkspaceDir(missing)).toThrow(/existing directory/);
  });

  it('rejects a regular file', () => {
    const file = track(path.join(TMP, 'plain-file'));
    fsSync.writeFileSync(file, 'x');
    expect(() => assertWorkspaceDir(file)).toThrow(/--cwd/);
    expect(() => assertWorkspaceDir(file)).toThrow(/regular file/);
  });

  it('rejects a FIFO', () => {
    if (process.platform === 'win32') return; // mkfifo not supported
    const fifo = track(path.join(TMP, 'fifo'));
    execSync(`mkfifo "${fifo}"`);
    expect(() => assertWorkspaceDir(fifo)).toThrow(/--cwd/);
    expect(() => assertWorkspaceDir(fifo)).toThrow(/not a directory/);
  });

  it('rejects a dangling symlink', () => {
    const dangling = track(path.join(TMP, 'dangling-link'));
    fsSync.symlinkSync(path.join(TMP, 'no-such-target'), dangling);
    expect(() => assertWorkspaceDir(dangling)).toThrow(/--cwd/);
    expect(() => assertWorkspaceDir(dangling)).toThrow(/existing directory/);
  });

  it('rejects a path with trailing whitespace that does not resolve', () => {
    const dir = track(fsSync.mkdtempSync(path.join(TMP, 'ws-dir-')));
    // "dir " (trailing space) is a distinct, nonexistent path on POSIX.
    const withSpace = dir + ' ';
    expect(() => assertWorkspaceDir(withSpace)).toThrow(/--cwd/);
  });

  it('throws a concise error without a stack trace line in the message', () => {
    const file = track(path.join(TMP, 'no-stack-file'));
    fsSync.writeFileSync(file, 'x');
    let msg = '';
    try {
      assertWorkspaceDir(file);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('--cwd');
    expect(msg).not.toMatch(/\n\s+at /); // no raw stack frame in the message
  });
});
