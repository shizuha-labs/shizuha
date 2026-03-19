import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { bashTool } from '../../src/tools/builtin/bash.js';
import type { ToolContext } from '../../src/tools/types.js';

function makeContext(cwd?: string): ToolContext {
  return { cwd: cwd ?? os.tmpdir(), sessionId: 'test-session' };
}

describe('bash tool', () => {
  it('returns stdout for a simple command', async () => {
    const result = await bashTool.execute({ command: 'echo hello' }, makeContext());
    expect(result.content).toContain('hello');
    expect(result.isError).toBeFalsy();
  });

  it('returns exit code 0 as non-error', async () => {
    const result = await bashTool.execute({ command: 'true' }, makeContext());
    expect(result.isError).toBeFalsy();
  });

  it('returns non-zero exit code as error', async () => {
    const result = await bashTool.execute({ command: 'false' }, makeContext());
    expect(result.isError).toBe(true);
  });

  it('captures stderr', async () => {
    const result = await bashTool.execute({ command: 'echo err >&2' }, makeContext());
    expect(result.content).toContain('err');
  });

  it('respects custom timeout', async () => {
    const result = await bashTool.execute(
      { command: 'sleep 10', timeout: 1500 },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  }, 10000);

  it('handles pipes and redirects', async () => {
    const result = await bashTool.execute(
      { command: 'echo "abc" | tr a-z A-Z' },
      makeContext(),
    );
    expect(result.content).toContain('ABC');
    expect(result.isError).toBeFalsy();
  });

  it('works with the specified cwd', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bash-test-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'marker.txt'), 'found');
      const result = await bashTool.execute(
        { command: 'cat marker.txt' },
        makeContext(tmpDir),
      );
      expect(result.content).toContain('found');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('truncates large output', async () => {
    // Generate > 100KB of output
    const result = await bashTool.execute(
      { command: 'yes "aaaaaaaaaa" | head -c 200000' },
      makeContext(),
    );
    // Output should be capped
    expect(result.content.length).toBeLessThanOrEqual(110 * 1024); // some margin
  });

  it('returns combined stdout and stderr', async () => {
    const result = await bashTool.execute(
      { command: 'echo out && echo err >&2' },
      makeContext(),
    );
    expect(result.content).toContain('out');
    expect(result.content).toContain('err');
  });

  it('tool metadata is correct', () => {
    expect(bashTool.name).toBe('bash');
    expect(bashTool.readOnly).toBe(false);
    expect(bashTool.riskLevel).toBe('high');
  });
});
