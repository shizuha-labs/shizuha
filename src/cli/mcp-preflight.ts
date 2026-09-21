/**
 * SCLI-517: fail-closed preflight for explicitly-requested `--mcp-server` entries.
 *
 * An explicitly supplied `--mcp-server` must be usable: reject empty/whitespace,
 * nonexistent, and non-executable commands BEFORE any provider/session/state
 * initialization, with ONE bounded actionable diagnostic (no raw Node/bundle
 * stack). Omitted-server behavior is preserved (empty config = no-op).
 */
import type { MCPServerConfig } from '../agent/types.js';

/**
 * Resolve a command against PATH (like child_process.spawn does).
 * Returns the absolute path when found and executable, else null.
 */
export async function resolveExecutableOnPath(cmd: string): Promise<string | null> {
  const { accessSync, constants } = await import('node:fs');
  const { join } = await import('node:path');
  if (cmd.includes('/')) {
    // Absolute or relative path — check directly.
    try {
      accessSync(cmd, constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const pathEntries = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = join(dir, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

/**
 * Validate explicitly-requested MCP server entries. Returns a list of bounded
 * human-readable problems (empty when all entries are usable).
 */
export async function validateMcpServers(mcpServers: MCPServerConfig[]): Promise<string[]> {
  const problems: string[] = [];
  for (const srv of mcpServers) {
    const cmd = (srv.command ?? '').trim();
    if (!cmd) {
      problems.push(`- ${srv.name}: empty command (--mcp-server requires a command)`);
      continue;
    }
    const resolved = await resolveExecutableOnPath(cmd);
    if (!resolved) {
      problems.push(`- ${srv.name}: command '${cmd}' not found or not executable`);
    }
  }
  return problems;
}

/**
 * Fail closed: print ONE bounded diagnostic and exit nonzero when any requested
 * server is unusable. No-op when the config is empty.
 */
export async function preflightMcpServersOrExit(mcpServers: MCPServerConfig[]): Promise<void> {
  if (mcpServers.length === 0) return;
  const problems = await validateMcpServers(mcpServers);
  if (problems.length > 0) {
    console.error(
      `Error: --mcp-server preflight failed (${problems.length} of ${mcpServers.length} requested server(s) unusable):\n` +
      problems.join('\n') +
      `\n\nFix the --mcp-server value(s) and retry. No provider/session state was initialized.`,
    );
    process.exit(1);
  }
}
