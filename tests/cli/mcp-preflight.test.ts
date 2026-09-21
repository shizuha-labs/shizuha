/**
 * SCLI-517: fail-closed preflight for explicitly-requested --mcp-server entries.
 *
 * Regression: `exec --mcp-server` silently continued with a reduced tool surface
 * on empty/whitespace/nonexistent/non-executable commands and raw-stacked blank
 * values. The preflight must reject those BEFORE any provider/session/state
 * initialization, and preserve omitted-server behavior.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveExecutableOnPath,
  validateMcpServers,
} from '../../src/cli/mcp-preflight.js';
import type { MCPServerConfig } from '../../src/agent/types.js';

const TMP_DIRS: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scli517-'));
  TMP_DIRS.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of TMP_DIRS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function server(cmd: string, name = 'mcp_0'): MCPServerConfig {
  return { name, transport: 'stdio', command: cmd, args: [] };
}

describe('resolveExecutableOnPath', () => {
  it('resolves an executable on PATH', async () => {
    // /bin/true exists and is executable on every POSIX host.
    const resolved = await resolveExecutableOnPath('true');
    expect(resolved).not.toBeNull();
  });

  it('resolves an absolute executable path', async () => {
    const dir = tmpDir();
    const exe = join(dir, 'tool');
    writeFileSync(exe, '#!/bin/sh\nexit 0\n');
    chmodSync(exe, 0o755);
    expect(await resolveExecutableOnPath(exe)).toBe(exe);
  });

  it('returns null for a nonexistent command', async () => {
    expect(await resolveExecutableOnPath('definitely-not-a-real-cmd-xyz')).toBeNull();
  });

  it('returns null for a non-executable file', async () => {
    const dir = tmpDir();
    const file = join(dir, 'notexec');
    writeFileSync(file, 'plain text');
    chmodSync(file, 0o644);
    expect(await resolveExecutableOnPath(file)).toBeNull();
  });
});

describe('validateMcpServers', () => {
  it('accepts a usable command (no problems)', async () => {
    const problems = await validateMcpServers([server('true')]);
    expect(problems).toEqual([]);
  });

  it('rejects an empty command', async () => {
    const problems = await validateMcpServers([server('')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('empty command');
  });

  it('rejects a whitespace-only command', async () => {
    const problems = await validateMcpServers([server('   ')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('empty command');
  });

  it('rejects a nonexistent command', async () => {
    const problems = await validateMcpServers([server('definitely-not-a-real-cmd-xyz')]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not found or not executable');
  });

  it('rejects a non-executable command', async () => {
    const dir = tmpDir();
    const file = join(dir, 'notexec');
    writeFileSync(file, 'plain text');
    chmodSync(file, 0o644);
    const problems = await validateMcpServers([server(file)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not found or not executable');
  });

  it('is a no-op for an empty config (omitted-server behavior preserved)', async () => {
    expect(await validateMcpServers([])).toEqual([]);
  });

  it('names the failed entry and cause (bounded, no raw stack)', async () => {
    const problems = await validateMcpServers([
      server('true', 'mcp_0'),
      server('definitely-not-a-real-cmd-xyz', 'mcp_1'),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('mcp_1');
    expect(problems[0]).toContain('definitely-not-a-real-cmd-xyz');
    expect(problems[0]).not.toContain('at ');
  });
});
