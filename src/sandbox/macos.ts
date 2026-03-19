/**
 * macOS OS-level sandboxing via Seatbelt (sandbox-exec).
 *
 * Seatbelt provides:
 * - Filesystem restrictions: fine-grained path-based read/write/execute rules
 * - Network restrictions: block outbound connections
 * - Process restrictions: block fork/exec of unauthorized binaries
 *
 * Uses `sandbox-exec -p '<profile>'` with a generated SBPL profile.
 * Note: sandbox-exec is deprecated by Apple but still functional and widely
 * used (Homebrew, Nix, Codex CLI all rely on it).
 */

import * as path from 'node:path';
import type { SandboxConfig, SandboxSpawnOptions } from './types.js';

/** Default paths protected from writes */
const DEFAULT_PROTECTED_PATHS = ['.git', '.shizuha', '.env', '.claude'];

/**
 * Generate a Seatbelt Profile Language (SBPL) profile string.
 *
 * SBPL is an S-expression-based policy language:
 * - (allow ...) permits operations
 * - (deny ...) blocks operations
 * - (version 1) is required header
 * - Default is (deny default) — everything not explicitly allowed is blocked
 */
function generateSeatbeltProfile(
  cwd: string,
  config: SandboxConfig,
): string {
  const resolvedCwd = path.resolve(cwd);
  const protectedPaths = config.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const lines: string[] = [
    '(version 1)',
    '',
    '; Start with deny-all baseline',
    '(deny default)',
    '',
    '; Allow basic process operations',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow mach-register)',
    '(allow ipc-posix-shm-read*)',
    '(allow ipc-posix-shm-write-create)',
    '(allow ipc-posix-shm-write-data)',
    '',
  ];

  if (config.mode === 'read-only') {
    lines.push(
      '; Read-only: allow reading everything, deny all writes',
      '(allow file-read*)',
      '(deny file-write*)',
      '',
      '; Allow writing to /dev/null, /dev/tty, stdout/stderr',
      '(allow file-write* (subpath "/dev"))',
      '',
      '; Deny all network',
      '(deny network*)',
    );
  } else if (config.mode === 'workspace-write') {
    lines.push(
      '; Allow reading everything',
      '(allow file-read*)',
      '',
      '; Deny writes by default',
      '(deny file-write*)',
      '',
      '; Allow writes to workspace',
      `(allow file-write* (subpath "${escapeSbpl(resolvedCwd)}"))`,
      '',
      '; Allow writes to /tmp and temp directories',
      '(allow file-write* (subpath "/tmp"))',
      '(allow file-write* (subpath "/private/tmp"))',
    );

    // Allow writes to $TMPDIR (macOS uses /var/folders/...)
    const tmpdir = process.env['TMPDIR'];
    if (tmpdir) {
      lines.push(`(allow file-write* (subpath "${escapeSbpl(path.resolve(tmpdir))}"))`,);
    }

    // Additional writable paths
    if (config.writablePaths) {
      for (const p of config.writablePaths) {
        lines.push(`(allow file-write* (subpath "${escapeSbpl(path.resolve(p))}"))`,);
      }
    }

    // Protect sensitive paths within writable roots
    for (const protectedName of protectedPaths) {
      const protectedPath = path.join(resolvedCwd, protectedName);
      lines.push(`(deny file-write* (subpath "${escapeSbpl(protectedPath)}"))`);
    }

    lines.push('');

    // Allow writing to /dev (for /dev/null, /dev/tty, etc.)
    lines.push('(allow file-write* (subpath "/dev"))');
    lines.push('');

    // Network access
    if (config.networkAccess) {
      lines.push(
        '; Allow network access',
        '(allow network*)',
      );
    } else {
      lines.push(
        '; Block network access (allow Unix domain sockets for IPC)',
        '(deny network-outbound)',
        '(deny network-inbound)',
        '(allow network* (local udp))',
        '(allow network* (local unix-socket))',
      );
    }
  }

  return lines.join('\n');
}

/** Escape a string for use in SBPL profile (double-quote context) */
function escapeSbpl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build sandboxed spawn options for macOS using sandbox-exec.
 *
 * @param innerCommand - The shell command to execute inside the sandbox
 * @param cwd - Working directory
 * @param config - Sandbox policy configuration
 * @param env - Environment variables for the process
 * @returns SandboxSpawnOptions with sandbox-exec command and args
 */
export function buildMacOSSandbox(
  innerCommand: string,
  cwd: string,
  config: SandboxConfig,
  env: Record<string, string>,
): SandboxSpawnOptions {
  const profile = generateSeatbeltProfile(cwd, config);

  return {
    command: 'sandbox-exec',
    args: ['-p', profile, 'bash', '-c', innerCommand],
    env,
  };
}

/** Export for testing */
export { generateSeatbeltProfile as _generateSeatbeltProfile };
