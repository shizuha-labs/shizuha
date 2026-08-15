/**
 * OS-level sandbox — unified API for platform-native process isolation.
 *
 * Platform support:
 * - Linux: bubblewrap (bwrap) — filesystem/PID/network namespaces
 * - macOS: Seatbelt (sandbox-exec) — filesystem/network restrictions
 * - Windows: not supported (use Docker-based isolation)
 *
 * Usage:
 *   import { buildSandboxedSpawn, canSandbox } from '../sandbox/index.js';
 *
 *   if (canSandbox()) {
 *     const opts = buildSandboxedSpawn(command, cwd, config, env);
 *     spawn(opts.command, opts.args, { env: opts.env, ... });
 *   }
 */

import * as os from 'node:os';
import type { SandboxConfig, SandboxSpawnOptions } from './types.js';
import { buildLinuxSandbox, isBwrapAvailable } from './linux.js';
import { buildMacOSSandbox } from './macos.js';
import { logger } from '../utils/logger.js';

export type { SandboxConfig, SandboxMode, SandboxSpawnOptions } from './types.js';

const platform = os.platform();

/**
 * Check if OS-level sandboxing is available on the current platform.
 * Returns false if the required sandbox binary is not installed.
 */
export function canSandbox(): boolean {
  if (platform === 'linux') return isBwrapAvailable();
  if (platform === 'darwin') return true; // sandbox-exec is always present on macOS
  return false;
}

/**
 * Build platform-specific sandboxed spawn options.
 *
 * Wraps a shell command in the appropriate sandbox for the current OS.
 * For modes 'unrestricted' and 'external', returns null — the caller
 * should spawn normally without sandbox wrapping.
 *
 * @param innerCommand - The bash command to execute inside the sandbox
 * @param cwd - Working directory for the command
 * @param config - Sandbox policy configuration
 * @param env - Environment variables (may be filtered by sandbox)
 * @returns SandboxSpawnOptions if sandboxing applies, null otherwise
 */
export function buildSandboxedSpawn(
  innerCommand: string,
  cwd: string,
  config: SandboxConfig,
  env: Record<string, string>,
): SandboxSpawnOptions | null {
  // No sandboxing for these modes
  if (config.mode === 'unrestricted' || config.mode === 'external') {
    return null;
  }

  if (platform === 'linux') {
    if (!isBwrapAvailable()) {
      logger.warn('Sandbox mode requested but bubblewrap (bwrap) is not installed. Install with: apt install bubblewrap');
      return null;
    }
    return buildLinuxSandbox(innerCommand, cwd, config, env);
  }

  if (platform === 'darwin') {
    return buildMacOSSandbox(innerCommand, cwd, config, env);
  }

  logger.warn({ platform }, 'OS-level sandboxing not supported on this platform — running unsandboxed');
  return null;
}

/**
 * Get a human-readable description of the active sandbox.
 * Useful for status display / diagnostics.
 */
export function describeSandbox(config: SandboxConfig): string {
  if (config.mode === 'unrestricted') return 'No sandbox';
  if (config.mode === 'external') return 'External sandbox (Docker)';

  const parts: string[] = [];
  if (platform === 'linux') parts.push('bwrap');
  else if (platform === 'darwin') parts.push('seatbelt');

  if (config.mode === 'read-only') {
    parts.push('read-only filesystem', 'no network');
  } else if (config.mode === 'workspace-write') {
    parts.push('workspace-write');
    if (config.networkAccess) parts.push('network: allowed');
    else parts.push('network: blocked');
    if (config.writablePaths?.length) {
      parts.push(`extra paths: ${config.writablePaths.length}`);
    }
  }

  return parts.join(', ');
}
