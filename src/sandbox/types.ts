/**
 * OS-level sandbox policy types.
 *
 * Provides process-level isolation via platform-native mechanisms:
 * - Linux: bubblewrap (bwrap) for filesystem/PID/network namespaces
 * - macOS: Seatbelt (sandbox-exec) for filesystem/network restrictions
 *
 * This is an *alternative* to Docker-based isolation — agents can use
 * either Docker containers OR OS-level sandboxing per configuration.
 */

/** Sandbox policy modes (mirrors Codex CLI's SandboxPolicy) */
export type SandboxMode =
  | 'unrestricted'     // No restrictions — full host access (default)
  | 'read-only'        // Read-only filesystem, no network
  | 'workspace-write'  // Write only in cwd + /tmp + explicit paths; network configurable
  | 'external';        // Already sandboxed externally (e.g., Docker) — skip OS sandbox

/** Full sandbox configuration */
export interface SandboxConfig {
  /** Sandbox mode */
  mode: SandboxMode;

  /** Additional directories with write access (workspace-write mode).
   *  cwd and /tmp are always writable. */
  writablePaths?: string[];

  /** Allow outbound network access (default: false for sandbox modes) */
  networkAccess?: boolean;

  /** Allowed destination hosts/patterns for outbound network requests.
   *  When set (non-empty), only URLs matching these patterns are permitted.
   *  Supports exact hostnames ("api.example.com") and wildcard prefixes ("*.example.com").
   *  An empty array means all hosts are allowed (no filtering). */
  allowedHosts?: string[];

  /** Paths that are always read-only even within writable roots.
   *  Defaults to ['.git', '.shizuha', '.env'] */
  protectedPaths?: string[];
}

/** Resolved spawn options for sandboxed execution */
export interface SandboxSpawnOptions {
  /** The command to execute (e.g., 'bwrap' on Linux, 'sandbox-exec' on macOS) */
  command: string;
  /** Full argument list including the wrapped command */
  args: string[];
  /** Environment variables (may be filtered) */
  env: Record<string, string>;
}
