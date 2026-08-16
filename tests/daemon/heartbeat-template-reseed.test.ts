/**
 * SCLI-435 regression: `reseed-heartbeat` must never follow a HEARTBEAT.md
 * symlink outside the workspaces root, must never hang on a FIFO target, and
 * must never claim success for a rejected destination.
 *
 * Caller-sequence note (verify-before-push stateful-recurrence clause): the
 * CLI (`src/index.ts` reseed-heartbeat) resolves each workspace beneath
 * `HOME/.shizuha/workspaces`, then calls `reseedHeartbeatTemplate(dir,
 * { root })`. These fixtures drive that same writer boundary — real filesystem
 * objects (regular / dangling symlink / existing symlink / FIFO / directory /
 * socket) — plus a top-level `tsx src/index.ts reseed-heartbeat` run against a
 * disposable HOME in the e2e block, so the unit of regression is the writer +
 * command sequence, not a mocked helper.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import * as net from 'node:net';
import { promisify } from 'node:util';
import {
  inspectHeartbeatTarget,
  reseedHeartbeatTemplate,
  seedHeartbeatTemplate,
} from '../../src/daemon/heartbeat-template.js';

const exec = promisify(execFile);

const projectDir = path.resolve(import.meta.dirname!, '../..');

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scli435-'));
}

function makeWorkspace(root: string, name: string, makeTarget: (p: string) => void): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  makeTarget(path.join(dir, 'HEARTBEAT.md'));
  return dir;
}

/** Run the real command against a disposable HOME. */
async function runCommand(
  args: string[],
  home: string,
  timeout = 10_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await exec(
      'node',
      [path.join(projectDir, 'node_modules/.bin/tsx'), path.join(projectDir, 'src', 'index.ts'), ...args],
      {
        env: { ...process.env, HOME: home, FORCE_COLOR: '0', SHIZUHA_TEST: '1' },
        timeout,
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

describe('reseedHeartbeatTemplate — SCLI-435 writer integrity', () => {
  it('writes a fresh regular HEARTBEAT.md atomically (canonical destination)', () => {
    const root = tmpRoot();
    const dir = makeWorkspace(root, 'agent-a', () => {});
    const result = reseedHeartbeatTemplate(dir, { root });
    expect(result.written).toBe(true);
    const target = path.join(dir, 'HEARTBEAT.md');
    expect(fs.existsSync(target)).toBe(true);
    const st = fs.lstatSync(target);
    expect(st.isFile()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
    // Template content landed (non-empty, no temp residue).
    expect(fs.readFileSync(target, 'utf-8').length).toBeGreaterThan(0);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.HEARTBEAT.md.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('overwrites an existing REGULAR target only', () => {
    const root = tmpRoot();
    const dir = makeWorkspace(root, 'agent-b', (p) => fs.writeFileSync(p, 'old custom content', 'utf-8'));
    const result = reseedHeartbeatTemplate(dir, { root });
    expect(result.written).toBe(true);
    const content = fs.readFileSync(path.join(dir, 'HEARTBEAT.md'), 'utf-8');
    expect(content.length).toBeGreaterThan('old custom content'.length);
  });

  it('rejects a DANGLING outside symlink and does not create the outside target', () => {
    const root = tmpRoot();
    const outside = path.join(root, 'outside-dangling.md');
    const dir = makeWorkspace(root, 'agent-dangling', (p) => fs.symlinkSync(outside, p));
    const result = reseedHeartbeatTemplate(dir, { root });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/symlink/i);
    expect(fs.existsSync(outside)).toBe(false); // never created
    expect(fs.lstatSync(path.join(dir, 'HEARTBEAT.md')).isSymbolicLink()).toBe(true); // preserved
  });

  it('rejects an EXISTING outside symlink and preserves the outside sentinel', () => {
    const root = tmpRoot();
    const outside = path.join(root, 'outside-sentinel.md');
    fs.writeFileSync(outside, 'SENTINEL-KEEP-ME', 'utf-8');
    const dir = makeWorkspace(root, 'agent-link', (p) => fs.symlinkSync(outside, p));
    const result = reseedHeartbeatTemplate(dir, { root });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/symlink/i);
    expect(fs.readFileSync(outside, 'utf-8')).toBe('SENTINEL-KEEP-ME'); // untouched
  });

  it('rejects a FIFO target boundedly without hanging (SCLI-435 FIFO hang)', () => {
    const root = tmpRoot();
    const dir = makeWorkspace(root, 'agent-fifo', (p) => {
      // mkfifo is unavailable to pure node; prefer the system utility, else skip.
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        execFileSync('mkfifo', [p]);
      } catch {
        // skip if FIFOs unsupported on this FS — the intent is the bounded write.
      }
    });
    const fifoPath = path.join(dir, 'HEARTBEAT.md');
    if (!fs.existsSync(fifoPath)) {
      return; // environment cannot express a FIFO; covered by other type cases
    }
    const started = Date.now();
    const result = reseedHeartbeatTemplate(dir, { root });
    const elapsed = Date.now() - started;
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/FIFO|not a regular file/i);
    expect(elapsed).toBeLessThan(5000); // bounded — the command must not block
    expect(fs.lstatSync(fifoPath).isFIFO()).toBe(true); // preserved
  });

  it('rejects a directory target boundedly and preserves it', () => {
    const root = tmpRoot();
    const dir = makeWorkspace(root, 'agent-dir', (p) => fs.mkdirSync(p, { recursive: true }));
    const result = reseedHeartbeatTemplate(dir, { root });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/not a regular file/i);
    expect(fs.lstatSync(path.join(dir, 'HEARTBEAT.md')).isDirectory()).toBe(true);
  });

  it('rejects a Unix socket target boundedly and preserves it', () => {
    const root = tmpRoot();
    const dir = makeWorkspace(root, 'agent-sock', (p) => {
      try {
        const srv = net.createServer();
        srv.listen(p, () => srv.close());
      } catch {
        /* socket unsupported — type case covered by others */
      }
    });
    const sockPath = path.join(dir, 'HEARTBEAT.md');
    if (!fs.existsSync(sockPath)) {
      return;
    }
    const result = reseedHeartbeatTemplate(dir, { root });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/not a regular file/i);
  });

  it('rejects a symlinked WORKSPACE directory (no outside escape via dir)', () => {
    const root = tmpRoot();
    const realDir = path.join(root, '..', `real-ws-${Date.now()}`);
    fs.mkdirSync(realDir, { recursive: true });
    const link = path.join(root, 'agent-link-dir');
    fs.symlinkSync(realDir, link, 'dir');
    const result = reseedHeartbeatTemplate(link, { root });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/symlinked workspace/i);
  });

  it('rejects a workspace that resolves outside the canonical root (containment)', () => {
    const root = tmpRoot();
    const outside = path.join(root, '..', `escape-ws-${Date.now()}`);
    fs.mkdirSync(outside, { recursive: true });
    const result = reseedHeartbeatTemplate(outside, { root });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/outside the workspaces root/);
  });

  it('reports missing workspace without success', () => {
    const root = tmpRoot();
    const missing = path.join(root, 'does-not-exist');
    const result = reseedHeartbeatTemplate(missing, { root });
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/does not exist/);
  });

  it('dry-run predicts the EXACT UTF-8 bytes of the real write (SCLI-435 parity)', () => {
    const root = tmpRoot();
    const dir = makeWorkspace(root, 'agent-parity', () => {});
    const info = inspectHeartbeatTarget(dir, root);
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    // inspect uses UTF-8 byteLength, not JS string UTF-16 length.
    const template = fs.readFileSync(path.join(projectDir, 'src', 'daemon', 'templates', 'HEARTBEAT.md'), 'utf-8');
    expect(info.bytes).toBe(Buffer.byteLength(template, 'utf-8'));
    expect(info.bytes).not.toBe(template.length); // the historical 4251-vs-4269 bug
    // The real write must produce exactly that many bytes on disk.
    expect(reseedHeartbeatTemplate(dir, { root }).written).toBe(true);
    expect(fs.statSync(path.join(dir, 'HEARTBEAT.md')).size).toBe(info.bytes);
  });

  it('dry-run rejects the same targets the real run rejects (existing symlink)', () => {
    const root = tmpRoot();
    const outside = path.join(root, 'dry-outside.md');
    fs.writeFileSync(outside, 'keep', 'utf-8');
    const dir = makeWorkspace(root, 'agent-dry', (p) => fs.symlinkSync(outside, p));
    const info = inspectHeartbeatTarget(dir, root);
    expect(info.ok).toBe(false);
    if (info.ok) return;
    expect(info.reason).toMatch(/symlink/i);
  });

  it('seed is no-follow idempotent: a planted symlink is never seeded through', () => {
    const root = tmpRoot();
    const outside = path.join(root, 'seed-outside.md');
    const dir = makeWorkspace(root, 'agent-seed', (p) => fs.symlinkSync(outside, p));
    seedHeartbeatTemplate(dir);
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.lstatSync(path.join(dir, 'HEARTBEAT.md')).isSymbolicLink()).toBe(true);
  });
});

describe('reseed-heartbeat top-level command — SCLI-435 (real sequence)', () => {
  const home = tmpRoot();
  const workspaces = path.join(home, '.shizuha', 'workspaces');
  fs.mkdirSync(path.join(workspaces, 'agent-ok'), { recursive: true });
  const outside = path.join(home, 'outside-escape.md');
  fs.mkdirSync(path.join(workspaces, 'agent-link'), { recursive: true });
  fs.symlinkSync(outside, path.join(workspaces, 'agent-link', 'HEARTBEAT.md'));

  it('refuses the outside symlink and does not overwrite outside HOME', async () => {
    const { stdout, stderr, exitCode } = await runCommand(['reseed-heartbeat'], home, 15_000);
    // Combined output should not claim success for the symlink workspace.
    const combined = `${stdout}\n${stderr}`;
    expect(combined).toContain('symlink');
    // The GOOD workspace still reseeded (the command keeps going, bounded).
    expect(fs.existsSync(path.join(workspaces, 'agent-ok', 'HEARTBEAT.md'))).toBe(true);
    // The outside file was NEVER created by following the symlink.
    expect(fs.existsSync(outside)).toBe(false);
    // Exit is nonzero because one workspace was rejected — never a false "all green".
    expect(exitCode).not.toBe(0);
  });

  it('FIFO target does not hang the top-level command (bounded run)', async () => {
    const home2 = tmpRoot();
    const ws2 = path.join(home2, '.shizuha', 'workspaces');
    const dir = path.join(ws2, 'agent-fifo');
    fs.mkdirSync(dir, { recursive: true });
    const fifo = path.join(dir, 'HEARTBEAT.md');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // env can't make FIFOs
    }
    const started = Date.now();
    const { stderr, exitCode } = await runCommand(['reseed-heartbeat'], home2, 10_000);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(9000); // must return; old code blocked forever
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/FIFO|not a regular file/i);
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
  });
});
