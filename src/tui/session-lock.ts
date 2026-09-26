// Single-instance lock for interactive TUI sessions (SCLI: session lock).
//
// Without this, `shizuha resume <id>` happily stacks a second, third, … live
// TUI process on top of the one already rendering the same session — each
// holding hundreds of MB and running whatever build was current when it
// started. The stale ones keep writing transcript state behind the visible
// TUI's back. This module guarantees: at most ONE live TUI per session id.
//
// Design (mirrors the withShizuhaAuthLock owner-file precedent):
//   - Lock file: <stateDir>/session-locks/<sanitized-session-id>.json
//     Content: { pid, hostname, startedAt, cwd, token }.
//   - Acquire: exclusive create ('wx'). On conflict:
//       * holder on this host, process dead (or corrupt lock)  → steal
//       * holder on this host, alive, takeover requested       → SIGTERM it,
//         wait briefly for release, steal as a last resort
//       * holder alive, no takeover                            → refuse
//       * holder on a DIFFERENT host                           → refuse
//         (liveness of a remote pid cannot be verified here)
//   - Release: only if the file's token matches the one we wrote (never
//     delete a successor's lock after a takeover handed the session over).
//   - Auto-update handoff: the restarting TUI releases the lock BEFORE
//     spawning its replacement, and the replacement runs with
//     SHIZUHA_TUI_TAKEOVER=1 as a safety net (same pattern as
//     SHIZUHA_AUTO_UPDATE_RESTARTED) — see auto-update.ts.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SessionLockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  cwd?: string;
}

export type SessionLockAcquireResult =
  | { acquired: true; path: string }
  | { acquired: false; holder: SessionLockInfo | null; reason: 'alive' | 'remote-host' };

export interface AcquireSessionLockOptions {
  sessionId: string;
  /** Override the lock directory (tests). Default: <stateDir>/session-locks */
  lockDir?: string;
  pid?: number;
  hostname?: string;
  cwd?: string;
  /** Liveness probe (tests inject a fake). Default: kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
  /** Signal a live holder during takeover (tests inject a fake). Default: SIGTERM. */
  signalHolder?: (pid: number) => void;
  /** Replace a live holder instead of refusing. */
  takeover?: boolean;
  /** How long to wait for a signalled holder to release (default 2000ms). */
  takeoverWaitMs?: number;
}

interface LockFileContent extends SessionLockInfo {
  token: string;
}

const DEFAULT_TAKEOVER_WAIT_MS = 2_000;

export function sessionLockDir(lockDir?: string): string {
  if (lockDir) return lockDir;
  // Same base dir as StateStore's state.db (src/state/store.ts).
  const base = process.env['SHIZUHA_STATE_DIR']
    ?? path.join(process.env['HOME'] ?? '.', '.config', 'shizuha');
  return path.join(base, 'session-locks');
}

/** Session ids are UUIDs in practice; sanitize anyway so a hostile id can't
 *  escape the lock directory. */
function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 0 ? safe.slice(0, 128) : '_';
}

function lockPathFor(sessionId: string, lockDir?: string): string {
  return path.join(sessionLockDir(lockDir), `${sanitizeSessionId(sessionId)}.json`);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // POSIX: EPERM means the process EXISTS but we may not signal it (e.g. a
    // root-owned pid). Only ESRCH (and friends) means it is really gone.
    // Treating EPERM as dead stole locks from unsignalable live holders.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultSignalHolder(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Holder died between the liveness check and the signal — fine.
  }
}

function readLockFile(lockPath: string): LockFileContent | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<LockFileContent>;
    if (typeof parsed?.pid !== 'number' || typeof parsed?.hostname !== 'string' || typeof parsed?.token !== 'string') {
      return null;
    }
    return parsed as LockFileContent;
  } catch {
    return null;
  }
}

function describeHolder(holder: SessionLockInfo): string {
  const parts = [`pid ${holder.pid}`, `started ${holder.startedAt}`];
  if (holder.cwd) parts.push(`cwd ${holder.cwd}`);
  return parts.join(', ');
}

/** Human-facing explanation for a refused acquire, for CLI/TUI surfaces. */
export function describeSessionLockConflict(sessionId: string, result: Extract<SessionLockAcquireResult, { acquired: false }>): string {
  const holderText = result.holder
    ? ` (pid ${result.holder.pid}, started ${result.holder.startedAt}${result.holder.cwd ? `, cwd ${result.holder.cwd}` : ''}${result.reason === 'remote-host' ? `, host ${result.holder.hostname}` : ''})`
    : '';
  const hint = result.reason === 'remote-host'
    ? 'The lock is held on another host, so it cannot be verified or taken over from here.'
    : 'Close that TUI (Ctrl+C when idle) first, or pass --take-over to replace it.';
  return `Session ${sessionId} is already open in another Shizuha TUI${holderText}.\n  ${hint}`;
}

function stealLock(lockPath: string, content: LockFileContent): void {
  // Exclusive re-create: remove then 'wx'. A racing acquirer either wins the
  // 'wx' or sees our fresh file — never two owners of one token.
  fs.rmSync(lockPath, { force: true });
  fs.writeFileSync(lockPath, JSON.stringify(content, null, 2), { flag: 'wx', mode: 0o600 });
  ownedTokens.set(lockPath, content.token);
}

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/** Tokens of locks THIS process acquired, keyed by lock path, so release is
 *  ownership-checked even when tests exercise several sessions in one process. */
const ownedTokens = new Map<string, string>();

function ownerToken(lockPath: string): string | undefined {
  return ownedTokens.get(lockPath);
}

/**
 * Acquire the single-instance lock for an interactive TUI session.
 * Synchronous: the TUI must not render a frame before ownership is decided.
 */
export function acquireSessionLock(opts: AcquireSessionLockOptions): SessionLockAcquireResult {
  const lockPath = lockPathFor(opts.sessionId, opts.lockDir);
  const pid = opts.pid ?? process.pid;
  const hostname = opts.hostname ?? os.hostname();
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const signalHolder = opts.signalHolder ?? defaultSignalHolder;
  const content: LockFileContent = {
    pid,
    hostname,
    startedAt: new Date().toISOString(),
    cwd: opts.cwd,
    token: crypto.randomUUID(),
  };

  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(content, null, 2), { flag: 'wx', mode: 0o600 });
      ownedTokens.set(lockPath, content.token);
      return { acquired: true, path: lockPath };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
    }

    const holder = readLockFile(lockPath);
    if (!holder) {
      // Corrupt/truncated lock (crash mid-write) — nothing alive owns this.
      stealLock(lockPath, content);
      return { acquired: true, path: lockPath };
    }

    if (holder.hostname !== hostname) {
      // A different machine holds the lock (shared home dir); we cannot probe
      // its liveness. Fail closed.
      return { acquired: false, holder, reason: 'remote-host' };
    }

    if (!isAlive(holder.pid)) {
      stealLock(lockPath, content);
      return { acquired: true, path: lockPath };
    }

    if (!opts.takeover) {
      return { acquired: false, holder, reason: 'alive' };
    }

    signalHolder(holder.pid);
    const waitMs = opts.takeoverWaitMs ?? DEFAULT_TAKEOVER_WAIT_MS;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!fs.existsSync(lockPath)) break; // holder released via its exit hook
      if (!isAlive(holder.pid)) break;     // holder died without releasing
      sleepSync(25);
    }
    // Loop: either the path is gone (retry the 'wx' create) or the holder is
    // gone (steal) or it ignored SIGTERM within the wait (final steal below).
    if (!fs.existsSync(lockPath)) continue;
    if (!isAlive(holder.pid)) {
      stealLock(lockPath, content);
      return { acquired: true, path: lockPath };
    }
    // Holder ignored SIGTERM and is still alive: steal anyway — the operator
    // explicitly asked to take the session over.
    stealLock(lockPath, content);
    return { acquired: true, path: lockPath };
  }
}

export interface ReleaseSessionLockOptions {
  sessionId: string;
  lockDir?: string;
  pid?: number;
  hostname?: string;
}

/**
 * Release the lock previously acquired by this process. Ownership is checked
 * via the random token stashed at acquire time, so a process that lost its
 * lock to a takeover never deletes the winner's file.
 */
export function releaseSessionLock(opts: ReleaseSessionLockOptions): void {
  const lockPath = lockPathFor(opts.sessionId, opts.lockDir);
  const current = readLockFile(lockPath);
  if (!current) return;
  if (current.pid !== (opts.pid ?? process.pid)) return;
  if (current.hostname !== (opts.hostname ?? os.hostname())) return;
  if (current.token !== ownerToken(lockPath)) return;
  fs.rmSync(lockPath, { force: true });
}
