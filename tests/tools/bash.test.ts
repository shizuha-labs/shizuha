import { afterEach, describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { bashChildEnvironment, bashTool } from '../../src/tools/builtin/bash.js';
import type { ToolContext } from '../../src/tools/types.js';
import { BackgroundTaskRegistry } from '../../src/tasks/registry.js';

function makeContext(cwd?: string): ToolContext {
  return { cwd: cwd ?? os.tmpdir(), sessionId: 'test-session' };
}

const mutatedEnvKeys = [
  'AGENT_ID',
  'CORTEX_API_KEY',
  'CORTEX_API_KEY_SHARED_FALLBACK',
  'CORTEX_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'VLLM_API_KEY',
  'TASK_SAFE_VALUE',
] as const;
const originalEnv = new Map(mutatedEnvKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of mutatedEnvKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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

  it('does not expose model-runtime credentials to fleet-agent shell commands', async () => {
    process.env['AGENT_ID'] = 'agent-nova';
    process.env['CORTEX_API_KEY'] = 'cortex-runtime-secret';
    process.env['CORTEX_API_KEY_SHARED_FALLBACK'] = 'cortex-fallback-secret';
    process.env['CORTEX_OAUTH_TOKEN'] = 'cortex-oauth-secret';
    process.env['OPENAI_API_KEY'] = 'openai-runtime-alias';
    process.env['VLLM_API_KEY'] = 'vllm-runtime-alias';
    process.env['TASK_SAFE_VALUE'] = 'still-visible';

    const childEnv = bashChildEnvironment();
    expect(childEnv['TASK_SAFE_VALUE']).toBe('still-visible');
    for (const key of [
      'CORTEX_API_KEY',
      'CORTEX_API_KEY_SHARED_FALLBACK',
      'CORTEX_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'VLLM_API_KEY',
    ]) {
      expect(childEnv[key]).toBeUndefined();
    }

    const result = await bashTool.execute(
      {
        command: 'test -z "${CORTEX_API_KEY:-}" && test -z "${OPENAI_API_KEY:-}" && printf "%s" "$TASK_SAFE_VALUE"',
      },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('still-visible');
  });

  it('preserves provider credentials for a non-agent interactive shell', () => {
    const childEnv = bashChildEnvironment({
      CORTEX_API_KEY: 'interactive-key',
      PATH: process.env['PATH'],
    });
    expect(childEnv['CORTEX_API_KEY']).toBe('interactive-key');
  });

  it('returns surface-neutral structured TaskOutput guidance for background commands', async () => {
    const taskRegistry = new BackgroundTaskRegistry();
    const result = await bashTool.execute(
      { command: 'true', timeout: 4321, run_in_background: true },
      { ...makeContext(), taskRegistry },
    );

    const task = taskRegistry.list()[0]!;
    expect(result.content).toContain(`TaskOutput with {"task_id":"${task.id}","block":true,"timeout":4321}`);
    expect(result.content).not.toMatch(/automatically notified|automatic(?:ally)? deliver|say that you are waiting/i);
    await expect(taskRegistry.waitForCompletion(task.id, 1000)).resolves.toBe(true);
  });
});
