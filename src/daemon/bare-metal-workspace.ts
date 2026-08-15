import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const AGENT_STATE_DB_BASENAME = '.shizuha-state.db';
export const SQLITE_STATE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

export type WorkspaceStateSnapshot = {
  path: string;
  kind: 'workspace' | 'sqlite-state';
  uid: number;
  gid: number;
  mode: number;
};

export type WorkspaceStateRepairPlan = {
  ownershipPaths: string[];
  modePaths: string[];
};

export type WorkspaceStatePreflightResult = {
  workspaceDir: string;
  repairedOwnership: string[];
  repairedModes: string[];
};

export type BareMetalChildLaunch = {
  child: ChildProcess;
  preflight: WorkspaceStatePreflightResult;
};

export class WorkspaceStatePreflightError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(`${message}: ${JSON.stringify(detail)}`);
    this.name = 'WorkspaceStatePreflightError';
  }
}

/**
 * Build the allow-listed repair plan without touching the filesystem. Keeping
 * this pure makes the root-owned-file regression deterministic on unprivileged
 * CI runners.
 */
export function planWorkspaceStateRepairs(
  snapshots: WorkspaceStateSnapshot[],
  effectiveUid: number,
  effectiveGid: number,
): WorkspaceStateRepairPlan {
  const ownershipPaths: string[] = [];
  const modePaths: string[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.uid !== effectiveUid || snapshot.gid !== effectiveGid) {
      ownershipPaths.push(snapshot.path);
    }
    const required = snapshot.kind === 'workspace' ? 0o700 : 0o600;
    if ((snapshot.mode & 0o777) !== required) modePaths.push(snapshot.path);
  }
  return { ownershipPaths, modePaths };
}

function allowedStatePaths(workspaceDir: string): string[] {
  const dbPath = path.join(workspaceDir, AGENT_STATE_DB_BASENAME);
  return SQLITE_STATE_SUFFIXES.map((suffix) => `${dbPath}${suffix}`);
}

function readSnapshot(targetPath: string, kind: WorkspaceStateSnapshot['kind']): WorkspaceStateSnapshot {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    throw new WorkspaceStatePreflightError('refusing symbolic link in agent state preflight', {
      path: targetPath,
      kind,
    });
  }
  if (kind === 'workspace' && !stat.isDirectory()) {
    throw new WorkspaceStatePreflightError('agent workspace is not a directory', {
      path: targetPath,
      mode: (stat.mode & 0o777).toString(8),
      uid: stat.uid,
      gid: stat.gid,
    });
  }
  if (kind === 'sqlite-state' && !stat.isFile()) {
    throw new WorkspaceStatePreflightError('agent SQLite state entry is not a regular file', {
      path: targetPath,
      mode: (stat.mode & 0o777).toString(8),
      uid: stat.uid,
      gid: stat.gid,
    });
  }
  return {
    path: targetPath,
    kind,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
  };
}

function repairOwnership(paths: string[], uid: number, gid: number): void {
  if (paths.length === 0) return;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    for (const targetPath of paths) fs.chownSync(targetPath, uid, gid);
    return;
  }
  try {
    // The fleet manager service account has a narrowly-auditable passwordless
    // sudo path on its host. argv form avoids shell expansion of workspace names.
    execFileSync('sudo', ['-n', 'chown', `${uid}:${gid}`, '--', ...paths], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
    throw new WorkspaceStatePreflightError('unable to repair agent SQLite state ownership', {
      paths,
      effective_uid: uid,
      effective_gid: gid,
      code: err.code ?? null,
      stderr: String(err.stderr ?? '').trim().slice(0, 300),
    });
  }
}

function assertWritable(snapshot: WorkspaceStateSnapshot, uid: number, gid: number): void {
  const required = snapshot.kind === 'workspace'
    ? fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
    : fs.constants.R_OK | fs.constants.W_OK;
  try {
    fs.accessSync(snapshot.path, required);
  } catch (error) {
    throw new WorkspaceStatePreflightError('agent SQLite state remains inaccessible after repair', {
      path: snapshot.path,
      kind: snapshot.kind,
      uid: snapshot.uid,
      gid: snapshot.gid,
      mode: snapshot.mode.toString(8),
      effective_uid: uid,
      effective_gid: gid,
      code: (error as NodeJS.ErrnoException).code ?? null,
    });
  }
}

function repairMode(snapshot: WorkspaceStateSnapshot, uid: number, gid: number): void {
  const targetMode = snapshot.kind === 'workspace' ? 0o700 : 0o600;
  try {
    fs.chmodSync(snapshot.path, targetMode);
  } catch (error) {
    throw new WorkspaceStatePreflightError('unable to repair agent SQLite state mode', {
      path: snapshot.path,
      kind: snapshot.kind,
      uid: snapshot.uid,
      gid: snapshot.gid,
      mode: snapshot.mode.toString(8),
      target_mode: targetMode.toString(8),
      effective_uid: uid,
      effective_gid: gid,
      code: (error as NodeJS.ErrnoException).code ?? null,
    });
  }
}

/**
 * Preflight the persistent SQLite boundary before a bare-metal child starts.
 *
 * Only the workspace directory and the StateStore database plus SQLite
 * sidecars are eligible for repair. A read-only mount, failed sudo/chown, or a
 * surprising file type fails before fork so the supervisor cannot enter a
 * deterministic six-second restart loop.
 */
export function preflightBareMetalWorkspaceState(
  workspaceDir: string,
  effectiveUid = typeof process.getuid === 'function' ? process.getuid() : 0,
  effectiveGid = typeof process.getgid === 'function' ? process.getgid() : 0,
): WorkspaceStatePreflightResult {
  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

  const snapshots: WorkspaceStateSnapshot[] = [readSnapshot(workspaceDir, 'workspace')];
  for (const targetPath of allowedStatePaths(workspaceDir)) {
    try {
      snapshots.push(readSnapshot(targetPath, 'sqlite-state'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }

  const plan = planWorkspaceStateRepairs(snapshots, effectiveUid, effectiveGid);
  repairOwnership(plan.ownershipPaths, effectiveUid, effectiveGid);

  const modeRepairPaths = new Set(plan.modePaths);
  for (const snapshot of snapshots) {
    if (modeRepairPaths.has(snapshot.path)) repairMode(snapshot, effectiveUid, effectiveGid);
  }

  const verified = snapshots.map((snapshot) => readSnapshot(snapshot.path, snapshot.kind));
  for (const snapshot of verified) {
    if (snapshot.uid !== effectiveUid || snapshot.gid !== effectiveGid) {
      throw new WorkspaceStatePreflightError('agent SQLite state ownership repair did not converge', {
        path: snapshot.path,
        uid: snapshot.uid,
        gid: snapshot.gid,
        mode: snapshot.mode.toString(8),
        effective_uid: effectiveUid,
        effective_gid: effectiveGid,
      });
    }
    assertWritable(snapshot, effectiveUid, effectiveGid);
  }

  return {
    workspaceDir,
    repairedOwnership: plan.ownershipPaths,
    repairedModes: plan.modePaths,
  };
}

/**
 * The production bare-metal start boundary. Keeping preflight and fork in one
 * synchronous operation makes the ordering explicit: no child exists while
 * ownership is inspected/repaired, and no child is created on preflight error.
 */
export function launchBareMetalChild(options: {
  workspaceDir: string;
  shizuhaJs: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  beforeFork?: () => void;
  forkProcess?: typeof fork;
}): BareMetalChildLaunch {
  const preflight = preflightBareMetalWorkspaceState(options.workspaceDir);
  options.beforeFork?.();
  const child = (options.forkProcess ?? fork)(options.shizuhaJs, options.args, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: options.workspaceDir,
    env: options.env,
  });
  return { child, preflight };
}
