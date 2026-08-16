/**
 * Linux OS-level sandboxing via bubblewrap (bwrap).
 *
 * Bubblewrap provides:
 * - Filesystem isolation: read-only root with selective writable mounts
 * - PID namespace isolation: processes can't see/kill host PIDs
 * - Network namespace isolation: optional network blocking
 * - No-new-privileges: prevents setuid escalation
 *
 * Requires `bwrap` binary (bubblewrap package).
 * Fallback: if bwrap is unavailable, logs a warning and runs unsandboxed.
 */

import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SandboxConfig, SandboxSpawnOptions } from './types.js';

/** Default paths protected from writes even within writable roots */
const DEFAULT_PROTECTED_PATHS = ['.git', '.shizuha', '.env', '.claude'];

/** Check if bubblewrap is available on the system */
let bwrapAvailable: boolean | null = null;

export function isBwrapAvailable(): boolean {
  if (bwrapAvailable !== null) return bwrapAvailable;
  try {
    execFileSync('bwrap', ['--version'], { stdio: 'ignore', timeout: 5000 });
    bwrapAvailable = true;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/**
 * Build sandboxed spawn options for Linux using bubblewrap.
 *
 * @param innerCommand - The shell command to execute inside the sandbox
 * @param cwd - Working directory
 * @param config - Sandbox policy configuration
 * @param env - Environment variables for the process
 * @returns SandboxSpawnOptions with bwrap command and args
 */
export function buildLinuxSandbox(
  innerCommand: string,
  cwd: string,
  config: SandboxConfig,
  env: Record<string, string>,
): SandboxSpawnOptions {
  const args: string[] = [];
  const protectedPaths = config.protectedPaths ?? DEFAULT_PROTECTED_PATHS;

  if (config.mode === 'read-only') {
    // Read-only mode: entire filesystem is read-only, no network
    args.push(
      '--ro-bind', '/', '/',       // Read-only root
      '--dev', '/dev',              // Device nodes
      '--proc', '/proc',            // Fresh /proc for PID namespace
      '--tmpfs', '/tmp',            // Writable /tmp (ephemeral)
      '--unshare-pid',              // Isolate PID namespace
      '--unshare-net',              // Block all networking
      '--die-with-parent',          // Kill when parent dies
      '--new-session',              // New session (don't kill parent on Ctrl-C)
    );
  } else if (config.mode === 'workspace-write') {
    // Workspace-write mode: read-only root, writable cwd + /tmp + explicit paths
    args.push(
      '--ro-bind', '/', '/',       // Read-only root
      '--dev', '/dev',              // Device nodes
      '--proc', '/proc',            // Fresh /proc
    );

    // Make cwd writable (re-mount as read-write)
    const resolvedCwd = path.resolve(cwd);
    args.push('--bind', resolvedCwd, resolvedCwd);

    // Make /tmp writable
    args.push('--bind', '/tmp', '/tmp');

    // Make $TMPDIR writable if set and different from /tmp
    const tmpdir = env['TMPDIR'];
    if (tmpdir && tmpdir !== '/tmp' && path.resolve(tmpdir) !== '/tmp') {
      args.push('--bind', path.resolve(tmpdir), path.resolve(tmpdir));
    }

    // Additional writable paths from config
    if (config.writablePaths) {
      for (const p of config.writablePaths) {
        const resolved = path.resolve(p);
        args.push('--bind', resolved, resolved);
      }
    }

    // Protect sensitive paths within writable roots (re-mount as read-only)
    for (const protectedName of protectedPaths) {
      const protectedPath = path.join(resolvedCwd, protectedName);
      // Only protect if the path exists — bwrap errors on non-existent bind sources
      args.push('--ro-bind-try', protectedPath, protectedPath);
    }

    // PID isolation
    args.push('--unshare-pid');

    // Network isolation (unless explicitly allowed)
    if (!config.networkAccess) {
      args.push('--unshare-net');
    }

    // Safety
    args.push(
      '--die-with-parent',
      '--new-session',
    );
  }

  // Set working directory inside the sandbox
  args.push('--chdir', path.resolve(cwd));

  // The inner command: bash -c "..."
  args.push('--', 'bash', '-c', innerCommand);

  return {
    command: 'bwrap',
    args,
    env,
  };
}
