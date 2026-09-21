import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runWorkspaceGc } from '../src/workspace-gc.js';

/**
 * PLAT-6053 workspace GC regression suite.
 *
 * The unit of regression is the real caller sequence: a `work/*` clone is
 * removed only when ALL safety predicates hold (git repo + clean + fully
 * pushed + on-branch + no-stash + aged); anything else is KEEP. tmp entries
 * are pruned only when aged AND no live process cwd is inside. Browser/login
 * state, audits, and sessions are never enumerated.
 */

// ── Module-scope helpers (shared by both describe blocks) ──

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    },
  });
}

function ageDir(dir: string, days: number): void {
  const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(dir, t, t);
}

/** Create a git clone that is clean + fully pushed + on-branch + no-stash. */
function makePushedClone(homeDir: string, workDir: string, name: string, ageDays: number): string {
  const remote = path.join(homeDir, `.remote-${name}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(remote, 'init', '--bare');
  const clone = path.join(workDir, name);
  fs.mkdirSync(clone, { recursive: true });
  git(clone, 'init');
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'Test');
  git(clone, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(clone, 'file.txt'), 'hello\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'init');
  git(clone, 'push', '-u', 'origin', 'master');
  ageDir(clone, ageDays);
  return clone;
}

function makeTmpEntry(tmpDir: string, name: string, ageDays: number): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'out.txt'), 'tool output\n');
  ageDir(dir, ageDays);
  return dir;
}

function decisionFor(result: { entries: Array<{ area: string; name: string; decision: string }> }, area: string, name: string): string | undefined {
  return result.entries.find((e) => e.area === area && e.name === name)?.decision;
}

describe('WorkspaceGc', () => {
  let homeDir: string;
  let workDir: string;
  let tmpDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-gc-home-'));
    workDir = path.join(homeDir, '.shizuha', 'work');
    tmpDir = path.join(homeDir, '.shizuha', 'tmp');
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('dry-run marks an aged clean+pushed+on-branch+no-stash clone as RM without deleting', async () => {
    const clone = makePushedClone(homeDir, workDir, 'plat-1234-clean', 30);
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: true });
    expect(decisionFor(result, 'work', 'plat-1234-clean')).toBe('RM');
    expect(fs.existsSync(clone)).toBe(true); // dry-run never deletes
    expect(result.removed).toBe(1);
  });

  it('non-dry-run deletes an aged clean+pushed+on-branch+no-stash clone', async () => {
    const clone = makePushedClone(homeDir, workDir, 'plat-1234-clean', 30);
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'work', 'plat-1234-clean')).toBe('RM');
    expect(fs.existsSync(clone)).toBe(false);
    expect(result.removed).toBe(1);
  });

  it('keeps a dirty clone (uncommitted changes)', async () => {
    const clone = makePushedClone(homeDir, workDir, 'plat-dirty', 30);
    fs.writeFileSync(path.join(clone, 'file.txt'), 'modified\n');
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'work', 'plat-dirty')).toBe('KEEP');
    expect(fs.existsSync(clone)).toBe(true);
  });

  it('keeps a clone with unpushed commits', async () => {
    const clone = makePushedClone(homeDir, workDir, 'plat-unpushed', 30);
    fs.writeFileSync(path.join(clone, 'file2.txt'), 'new\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'unpushed');
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'work', 'plat-unpushed')).toBe('KEEP');
    expect(fs.existsSync(clone)).toBe(true);
  });

  it('keeps a clone on a detached HEAD', async () => {
    const clone = makePushedClone(homeDir, workDir, 'plat-detached', 30);
    git(clone, 'checkout', '--detach');
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'work', 'plat-detached')).toBe('KEEP');
    expect(fs.existsSync(clone)).toBe(true);
  });

  it('keeps a clone with stashed work', async () => {
    const clone = makePushedClone(homeDir, workDir, 'plat-stash', 30);
    fs.writeFileSync(path.join(clone, 'stash.txt'), 'stashed\n');
    git(clone, 'stash', 'push', '-u', '-m', 'wip');
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'work', 'plat-stash')).toBe('KEEP');
    expect(fs.existsSync(clone)).toBe(true);
  });

  it('keeps a recently-modified clone (within prune window)', async () => {
    makePushedClone(homeDir, workDir, 'plat-recent', 1); // 1 day old < 7 day window
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'work', 'plat-recent')).toBe('KEEP');
    expect(fs.existsSync(path.join(workDir, 'plat-recent'))).toBe(true);
  });

  it('keeps a non-git directory in work/', async () => {
    const dir = path.join(workDir, 'not-a-repo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.bin'), 'x'.repeat(100));
    ageDir(dir, 30);
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'work', 'not-a-repo')).toBe('KEEP');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('prunes an aged tmp entry with no live process cwd (non-dry-run)', async () => {
    const entry = makeTmpEntry(tmpDir, 'tool-output-123', 30);
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'tmp', 'tool-output-123')).toBe('RM');
    expect(fs.existsSync(entry)).toBe(false);
  });

  it('keeps a recent tmp entry', async () => {
    const entry = makeTmpEntry(tmpDir, 'tool-output-recent', 1);
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'tmp', 'tool-output-recent')).toBe('KEEP');
    expect(fs.existsSync(entry)).toBe(true);
  });

  it('preserves browser/login state, audits, and sessions (never enumerated)', async () => {
    // Browser/login state + QA audits live OUTSIDE work/ and tmp/.
    const browser = path.join(homeDir, '.shizuha', 'x-browser-profile');
    const audits = path.join(homeDir, '.shizuha', 'qa-tui', 'audits');
    const sessions = path.join(homeDir, '.shizuha', 'claude-sessions');
    fs.mkdirSync(browser, { recursive: true });
    fs.mkdirSync(audits, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(browser, 'cookies.db'), 'cookie-data');
    fs.writeFileSync(path.join(audits, 'audit-1.json'), '{}');
    fs.writeFileSync(path.join(sessions, 'session.json'), '{}');
    ageDir(browser, 30);
    ageDir(audits, 30);
    ageDir(sessions, 30);

    makePushedClone(homeDir, workDir, 'plat-clean', 30);
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });

    // The GC removed the aged clone but never touched the preserved dirs.
    expect(result.removed).toBe(1);
    expect(fs.existsSync(path.join(browser, 'cookies.db'))).toBe(true);
    expect(fs.existsSync(path.join(audits, 'audit-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessions, 'session.json'))).toBe(true);
  });

  it('respects a custom prune window', async () => {
    makePushedClone(homeDir, workDir, 'plat-5day', 5);
    makePushedClone(homeDir, workDir, 'plat-10day', 10);
    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });
    expect(decisionFor(result, 'work', 'plat-5day')).toBe('KEEP'); // 5d < 7d
    expect(decisionFor(result, 'work', 'plat-10day')).toBe('RM'); // 10d > 7d
  });
});

describe('WorkspaceGc fill/recovery (PLAT-6053 item 4)', () => {
  let homeDir: string;
  let workDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-gc-fill-'));
    workDir = path.join(homeDir, '.shizuha', 'work');
    fs.mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('fires under a simulated fill and restores occupancy without touching active state', async () => {
    // Simulate a filled workspace: many aged clean+pushed clones (the kai/ni
    // class: 487 / 159 stale per-task clones) plus one active recent clone.
    for (let i = 0; i < 20; i++) {
      makePushedClone(homeDir, workDir, `stale-clone-${i}`, 30);
    }
    const active = makePushedClone(homeDir, workDir, 'active-task', 1); // recent -> must survive

    // Active session state that must never be touched.
    const browser = path.join(homeDir, '.shizuha', 'x-browser-profile');
    const audits = path.join(homeDir, '.shizuha', 'qa-tui', 'audits');
    const sessions = path.join(homeDir, '.shizuha', 'claude-sessions');
    fs.mkdirSync(browser, { recursive: true });
    fs.mkdirSync(audits, { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(browser, 'cookies.db'), 'cookie-data');
    fs.writeFileSync(path.join(audits, 'audit-1.json'), '{}');
    fs.writeFileSync(path.join(sessions, 'session.json'), '{}');

    const result = await runWorkspaceGc({ homeDir, pruneDays: 7, dryRun: false });

    // All 20 stale clones removed; active + preserved state intact.
    expect(result.removed).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(fs.existsSync(path.join(workDir, `stale-clone-${i}`))).toBe(false);
    }
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(path.join(browser, 'cookies.db'))).toBe(true);
    expect(fs.existsSync(path.join(audits, 'audit-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(sessions, 'session.json'))).toBe(true);
  });
});
