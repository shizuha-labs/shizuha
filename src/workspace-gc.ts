/**
 * Workspace GC — periodic retention of per-task scratch in the agent home.
 *
 * PLAT-6053: fleet agent workspace PVCs fill up with un-retained per-task
 * scratch (`~/.shizuha/work/*` per-task clones + `~/.shizuha/tmp` tool output)
 * that is never GC'd (kai/ryo/ni/mika hit 94–97% occupancy; kai needed 487
 * stale clones removed by hand). This module prunes aged scratch while
 * preserving active work, browser/login state, audits, and sessions.
 *
 * Safety predicate (proven PLAT-3994, live-verified): a `work/*` git clone is
 * removed ONLY when ALL hold:
 *   (a) it is a git repo (has .git),
 *   (b) clean            -> `git status --porcelain` empty,
 *   (c) fully pushed     -> `git log --branches --not --remotes` empty,
 *   (d) on a named branch (not detached HEAD — off-branch commits can't be lost),
 *   (e) no stashed work  -> `git stash list` empty,
 *   (f) aged             -> dir mtime older than PRUNE_DAYS.
 * Anything else (dirty / unpushed / detached / stashed / recent / non-git) is
 * KEPT. The remote-tracking check errs safe: stale/unfetched remotes make a
 * pushed commit look unpushed -> the clone is KEPT, never wrongly deleted.
 *
 * Only `work/*` and `tmp/*` are ever touched. Browser/login state, qa audits,
 * sessions, credentials, and every other home directory are preserved by
 * construction (the GC never enumerates them).
 *
 * DRY_RUN gates deletion: with dryRun=true every RM/KEEP decision is logged
 * without deleting (verify-before-destroy). Fail-loud: a failed git/rm op
 * exits non-zero so the caller (or a Job) can surface it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './utils/logger.js';

const execFileAsync = promisify(execFile);

// ── Options ──

export interface WorkspaceGcOptions {
  /** Agent home directory (default: $HOME). `work/` and `tmp/` live under it. */
  homeDir?: string;
  /** Prune entries whose mtime is older than this many days (default: 7). */
  pruneDays?: number;
  /** Log RM/KEEP decisions without deleting (default: true — verify-before-destroy). */
  dryRun?: boolean;
  /** How often to run on the timer (ms, default: 6h). */
  intervalMs?: number;
}

const DEFAULT_PRUNE_DAYS = 7;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Results ──

export interface GcEntryStat {
  /** work/ or tmp/ */
  area: 'work' | 'tmp';
  name: string;
  decision: 'RM' | 'KEEP';
  reason: string;
}

export interface WorkspaceGcResult {
  dryRun: boolean;
  pruneDays: number;
  workRoot: string | null;
  tmpRoot: string | null;
  entries: GcEntryStat[];
  removed: number;
  kept: number;
  /** Bytes reclaimed by RM'd entries (best-effort du; 0 when dryRun). */
  freedBytes: number;
}

// ── Git helpers (async, bounded) ──

const GIT_TIMEOUT_MS = 15_000;

async function gitOk(dir: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync('git', args, {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
      // safe.directory via env: container may run as uid 1000 with a
      // non-writable HOME, so a global config write would fail.
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function gitOutputEmpty(dir: string, args: string[]): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
      },
    });
    return stdout.trim().length === 0;
  } catch {
    return false; // err safe: a git error means KEEP
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function dirIsAged(dir: string, pruneDays: number): Promise<boolean> {
  try {
    const st = await fs.stat(dir);
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs > pruneDays * 24 * 60 * 60 * 1000;
  } catch {
    return false; // stat error -> KEEP (fail-safe)
  }
}

async function dirSizeBytes(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', dir], { timeout: 30_000 });
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '0', 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

/**
 * Best-effort check whether any live process has its cwd inside `dir`.
 * Scans /proc PID cwd symlinks. On any error returns false (caller keeps the
 * entry when unsure — see pruneTmpDirs). Only meaningful inside the agent pod
 * where /proc is visible.
 */
async function anyLiveProcessCwdInside(dir: string): Promise<boolean> {
  try {
    const procRoot = '/proc';
    const entries = await fs.readdir(procRoot);
    const target = await fs.realpath(dir).catch(() => null);
    if (!target) return false;
    for (const pid of entries) {
      if (!/^\d+$/.test(pid)) continue;
      const cwdLink = path.join(procRoot, pid, 'cwd');
      const real = await fs.realpath(cwdLink).catch(() => null);
      if (real && (real === target || real.startsWith(target + path.sep))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ── Core prune functions ──

async function pruneWorkDirs(
  workRoot: string,
  pruneDays: number,
  dryRun: boolean,
  entries: GcEntryStat[],
): Promise<{ removed: number; kept: number; freedBytes: number }> {
  let removed = 0;
  let kept = 0;
  let freedBytes = 0;

  let names: string[];
  try {
    names = await fs.readdir(workRoot);
  } catch {
    return { removed, kept, freedBytes }; // no work dir yet
  }

  for (const name of names) {
    const dir = path.join(workRoot, name);
    let st;
    try {
      st = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      entries.push({ area: 'work', name, decision: 'KEEP', reason: 'not a directory' });
      kept += 1;
      continue;
    }

    if (!(await isGitRepo(dir))) {
      entries.push({ area: 'work', name, decision: 'KEEP', reason: 'not a git repo' });
      kept += 1;
      continue;
    }

    if (!(await dirIsAged(dir, pruneDays))) {
      entries.push({ area: 'work', name, decision: 'KEEP', reason: `modified within ${pruneDays}d` });
      kept += 1;
      continue;
    }
    if (!(await gitOutputEmpty(dir, ['status', '--porcelain']))) {
      entries.push({ area: 'work', name, decision: 'KEEP', reason: 'uncommitted changes' });
      kept += 1;
      continue;
    }
    if (!(await gitOutputEmpty(dir, ['log', '--branches', '--not', '--remotes', '--oneline']))) {
      entries.push({ area: 'work', name, decision: 'KEEP', reason: 'unpushed commits' });
      kept += 1;
      continue;
    }
    // detached-HEAD guard: commits reachable only from a detached HEAD are not
    // on any branch, so --branches..--not..--remotes misses them.
    if (!(await gitOk(dir, ['symbolic-ref', '-q', 'HEAD']))) {
      entries.push({ area: 'work', name, decision: 'KEEP', reason: 'detached HEAD — possible off-branch work' });
      kept += 1;
      continue;
    }
    if (!(await gitOutputEmpty(dir, ['stash', 'list']))) {
      entries.push({ area: 'work', name, decision: 'KEEP', reason: 'stashed work' });
      kept += 1;
      continue;
    }

    const size = dryRun ? await dirSizeBytes(dir) : 0;
    if (dryRun) {
      entries.push({
        area: 'work',
        name,
        decision: 'RM',
        reason: `would remove: clean + pushed + on-branch + no-stash + aged >${pruneDays}d`,
      });
    } else {
      entries.push({
        area: 'work',
        name,
        decision: 'RM',
        reason: `clean + fully pushed + on-branch + no-stash + aged >${pruneDays}d`,
      });
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        // Fail-loud: a failed rm must surface, not silently keep counting.
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ area: 'work', name, error: message }, 'workspace-gc rm failed');
        throw err;
      }
    }
    removed += 1;
    freedBytes += size;
  }

  return { removed, kept, freedBytes };
}

async function pruneTmpDirs(
  tmpRoot: string,
  pruneDays: number,
  dryRun: boolean,
  entries: GcEntryStat[],
): Promise<{ removed: number; kept: number; freedBytes: number }> {
  let removed = 0;
  let kept = 0;
  let freedBytes = 0;

  let names: string[];
  try {
    names = await fs.readdir(tmpRoot);
  } catch {
    return { removed, kept, freedBytes }; // no tmp dir yet
  }

  for (const name of names) {
    const dir = path.join(tmpRoot, name);
    let st;
    try {
      st = await fs.stat(dir);
    } catch {
      continue;
    }

    if (!(await dirIsAged(dir, pruneDays))) {
      entries.push({ area: 'tmp', name, decision: 'KEEP', reason: `modified within ${pruneDays}d` });
      kept += 1;
      continue;
    }
    // Safety: never delete tmp an active process is using.
    if (await anyLiveProcessCwdInside(dir)) {
      entries.push({ area: 'tmp', name, decision: 'KEEP', reason: 'live process cwd inside' });
      kept += 1;
      continue;
    }

    const size = dryRun ? await dirSizeBytes(dir) : 0;
    if (dryRun) {
      entries.push({ area: 'tmp', name, decision: 'RM', reason: `would remove: aged >${pruneDays}d, no live process cwd` });
    } else {
      entries.push({ area: 'tmp', name, decision: 'RM', reason: `aged >${pruneDays}d, no live process cwd` });
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ area: 'tmp', name, error: message }, 'workspace-gc rm failed');
        throw err;
      }
    }
    removed += 1;
    freedBytes += size;
  }

  return { removed, kept, freedBytes };
}

// ── Public API ──

export async function runWorkspaceGc(options: WorkspaceGcOptions = {}): Promise<WorkspaceGcResult> {
  const homeDir = options.homeDir ?? process.env['HOME'] ?? os.homedir();
  const pruneDays = options.pruneDays ?? DEFAULT_PRUNE_DAYS;
  const dryRun = options.dryRun ?? true;

  const workRoot = path.join(homeDir, '.shizuha', 'work');
  const tmpRoot = path.join(homeDir, '.shizuha', 'tmp');

  const entries: GcEntryStat[] = [];
  const work = await pruneWorkDirs(workRoot, pruneDays, dryRun, entries);
  const tmp = await pruneTmpDirs(tmpRoot, pruneDays, dryRun, entries);

  const result: WorkspaceGcResult = {
    dryRun,
    pruneDays,
    workRoot,
    tmpRoot,
    entries,
    removed: work.removed + tmp.removed,
    kept: work.kept + tmp.kept,
    freedBytes: work.freedBytes + tmp.freedBytes,
  };

  logger.info(
    {
      dryRun,
      pruneDays,
      workRemoved: work.removed,
      workKept: work.kept,
      tmpRemoved: tmp.removed,
      tmpKept: tmp.kept,
      freedBytes: result.freedBytes,
    },
    dryRun
      ? 'workspace-gc dry-run complete (no deletion)'
      : 'workspace-gc complete',
  );

  return result;
}

/**
 * Periodic Workspace GC — mirrors the MaintenanceReaper pattern inside
 * AgentProcess. Best-effort: a failure in one sweep is logged and the timer
 * continues; it never blocks the agent loop.
 */
export class WorkspaceGc {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly homeDir: string | undefined;
  private readonly pruneDays: number;
  private readonly dryRun: boolean;
  private readonly intervalMs: number;

  constructor(options: WorkspaceGcOptions = {}) {
    this.homeDir = options.homeDir;
    this.pruneDays = options.pruneDays ?? DEFAULT_PRUNE_DAYS;
    this.dryRun = options.dryRun ?? true;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    // First sweep after a short delay so startup isn't blocked.
    const first = setTimeout(() => {
      void this.sweep();
    }, 15_000);
    first.unref?.();
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info({ intervalMs: this.intervalMs, dryRun: this.dryRun }, 'Workspace GC started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sweep(): Promise<void> {
    try {
      const result = await runWorkspaceGc({
        homeDir: this.homeDir,
        pruneDays: this.pruneDays,
        dryRun: this.dryRun,
      });
      // Log every RM/KEEP decision at debug; summary at info (already logged).
      if (result.entries.length > 0) {
        logger.debug(
          { decisions: result.entries.slice(0, 200) },
          'workspace-gc decisions',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'workspace-gc sweep failed');
    }
  }
}
