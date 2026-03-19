import { describe, it, expect } from 'vitest';
import { HookEngine } from '../../src/hooks/engine.js';
import type { HookConfig } from '../../src/hooks/types.js';

describe('HookEngine', () => {
  it('runs matching PreToolUse hooks', async () => {
    const hooks: HookConfig[] = [
      { event: 'PreToolUse', command: 'echo "ok"' },
    ];
    const engine = new HookEngine(hooks);
    const results = await engine.runHooks('PreToolUse', { TOOL_NAME: 'bash', CWD: '/tmp', SESSION_ID: 's1' }, 'bash');
    expect(results).toHaveLength(1);
    expect(results[0]!.exitCode).toBe(0);
    expect(results[0]!.blocked).toBe(false);
    expect(results[0]!.stdout).toBe('ok');
  });

  it('blocks tool execution on exit code 2', async () => {
    const hooks: HookConfig[] = [
      { event: 'PreToolUse', command: 'echo "blocked for security" && exit 2' },
    ];
    const engine = new HookEngine(hooks);
    const results = await engine.runHooks('PreToolUse', { TOOL_NAME: 'bash', CWD: '/tmp', SESSION_ID: 's1' }, 'bash');
    expect(results).toHaveLength(1);
    expect(results[0]!.blocked).toBe(true);
    expect(results[0]!.blockReason).toContain('blocked for security');
  });

  it('filters hooks by tool matcher', async () => {
    const hooks: HookConfig[] = [
      { event: 'PreToolUse', matcher: 'bash', command: 'echo "bash hook"' },
      { event: 'PreToolUse', matcher: 'read_file', command: 'echo "read hook"' },
    ];
    const engine = new HookEngine(hooks);
    const results = await engine.runHooks('PreToolUse', { TOOL_NAME: 'bash', CWD: '/tmp', SESSION_ID: 's1' }, 'bash');
    expect(results).toHaveLength(1);
    expect(results[0]!.stdout).toBe('bash hook');
  });

  it('wildcard matcher matches all tools', async () => {
    const hooks: HookConfig[] = [
      { event: 'PreToolUse', matcher: '*', command: 'echo "all tools"' },
    ];
    const engine = new HookEngine(hooks);
    const results = await engine.runHooks('PreToolUse', { TOOL_NAME: 'any_tool', CWD: '/tmp', SESSION_ID: 's1' }, 'any_tool');
    expect(results).toHaveLength(1);
    expect(results[0]!.stdout).toBe('all tools');
  });

  it('runs PostToolUse hooks with tool result env', async () => {
    const hooks: HookConfig[] = [
      { event: 'PostToolUse', command: 'echo "$TOOL_RESULT"' },
    ];
    const engine = new HookEngine(hooks);
    const env = { TOOL_NAME: 'bash', TOOL_RESULT: 'success', TOOL_ERROR: 'false', CWD: '/tmp', SESSION_ID: 's1' };
    const results = await engine.runHooks('PostToolUse', env, 'bash');
    expect(results).toHaveLength(1);
    expect(results[0]!.stdout).toBe('success');
  });

  it('skips hooks for non-matching events', async () => {
    const hooks: HookConfig[] = [
      { event: 'PostToolUse', command: 'echo "post"' },
    ];
    const engine = new HookEngine(hooks);
    const results = await engine.runHooks('PreToolUse', { TOOL_NAME: 'bash', CWD: '/tmp', SESSION_ID: 's1' }, 'bash');
    expect(results).toHaveLength(0);
  });

  it('hasHooks returns correct values', () => {
    const hooks: HookConfig[] = [
      { event: 'PreToolUse', command: 'echo ok' },
    ];
    const engine = new HookEngine(hooks);
    expect(engine.hasHooks('PreToolUse')).toBe(true);
    expect(engine.hasHooks('PostToolUse')).toBe(false);
  });

  it('handles empty hooks list', async () => {
    const engine = new HookEngine([]);
    const results = await engine.runHooks('PreToolUse', {}, 'bash');
    expect(results).toHaveLength(0);
    expect(engine.hasHooks('PreToolUse')).toBe(false);
  });

  it('handles hook command failure (non-2 exit code)', async () => {
    const hooks: HookConfig[] = [
      { event: 'PreToolUse', command: 'exit 1' },
    ];
    const engine = new HookEngine(hooks);
    const results = await engine.runHooks('PreToolUse', {}, 'bash');
    expect(results).toHaveLength(1);
    expect(results[0]!.exitCode).toBe(1);
    expect(results[0]!.blocked).toBe(false);
  });

  it('stops running hooks after a PreToolUse block', async () => {
    const hooks: HookConfig[] = [
      { event: 'PreToolUse', command: 'exit 2' },
      { event: 'PreToolUse', command: 'echo "should not run"' },
    ];
    const engine = new HookEngine(hooks);
    const results = await engine.runHooks('PreToolUse', {}, 'bash');
    expect(results).toHaveLength(1);
    expect(results[0]!.blocked).toBe(true);
  });
});
