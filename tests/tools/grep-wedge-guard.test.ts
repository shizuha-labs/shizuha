/**
 * Regression tests for the 2026-07-03 TUI wedge: a `grep path=/home/phoenix`
 * pinned the agent loop at 100% CPU for 17+ minutes because
 *  (a) rg/grep TIMEOUT kills were misclassified as "binary missing" and
 *      cascaded into the unbounded pure-JS grep fallback, and
 *  (b) nothing in the agent loop could unwedge a tool that ignores
 *      ToolContext.abortSignal.
 */
import { describe, it, expect } from 'vitest';
import { classifyExecError, grepTool } from '../../src/tools/builtin/grep.js';
import { globTool } from '../../src/tools/builtin/glob.js';
import { runToolGuarded } from '../../src/agent/turn.js';
import type { ToolHandler, ToolContext, ToolResult } from '../../src/tools/types.js';
import type { ToolCall } from '../../src/agent/types.js';

const tc: ToolCall = { id: 'tc-1', name: 'fake', input: {} };
const baseCtx: ToolContext = { cwd: '/tmp', sessionId: 'wedge-test' };

function fakeHandler(overrides: Partial<ToolHandler>): ToolHandler {
  return {
    name: 'fake',
    description: 'fake',
    parameters: undefined as never,
    readOnly: true,
    riskLevel: 'low',
    execute: () => new Promise<ToolResult>(() => { /* never resolves */ }),
    ...overrides,
  };
}

describe('classifyExecError — timeout must not cascade to slower fallbacks', () => {
  it('exit code 1 is no-match', () => {
    expect(classifyExecError({ code: 1 })).toBe('no-match');
  });
  it('a killed child (execFile timeout) is timeout, not a broken binary', () => {
    expect(classifyExecError({ killed: true, signal: 'SIGTERM', code: null })).toBe('timeout');
  });
  it('maxBuffer overflow is output-overflow', () => {
    expect(classifyExecError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toBe('output-overflow');
  });
  it('abort is aborted', () => {
    expect(classifyExecError({ code: 'ABORT_ERR' })).toBe('aborted');
  });
  it('only ENOENT-class spawn failures fall through to the next grep', () => {
    expect(classifyExecError({ code: 'ENOENT' })).toBe('not-runnable');
  });
});

describe('grep/glob honor a pre-aborted turn signal', () => {
  it('grep returns cancelled instead of searching', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await grepTool.execute(
      { pattern: 'anything', path: '/tmp' },
      { ...baseCtx, abortSignal: ac.signal },
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain('cancel');
  });

  it('glob returns cancelled instead of walking', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await globTool.execute(
      { pattern: '**/*' },
      { ...baseCtx, abortSignal: ac.signal },
    );
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain('cancel');
  });
});

describe('runToolGuarded — the agent loop can always recover', () => {
  it('abandons a silent never-resolving tool after silentTimeoutMs', async () => {
    const handler = fakeHandler({ silentTimeoutMs: 60 });
    const result = await runToolGuarded(handler, tc, baseCtx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('abandoned as wedged');
  });

  it('turn abort unblocks a tool that ignores its abortSignal', async () => {
    const ac = new AbortController();
    const handler = fakeHandler({});
    const pending = runToolGuarded(handler, tc, { ...baseCtx, abortSignal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('cancelled');
  });

  it('progress output resets the silent watchdog', async () => {
    const handler = fakeHandler({
      silentTimeoutMs: 80,
      execute: (_input, ctx2) =>
        new Promise<ToolResult>((resolve) => {
          // Emit progress every 40ms, resolve at 250ms — total time exceeds the
          // 80ms watchdog, but no silent gap does.
          const iv = setInterval(() => ctx2.onProgress?.('tick'), 40);
          setTimeout(() => {
            clearInterval(iv);
            resolve({ toolUseId: '', content: 'done' });
          }, 250);
        }),
    });
    const result = await runToolGuarded(handler, tc, baseCtx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('done');
  });

  it('passes through a normally-resolving tool untouched', async () => {
    const handler = fakeHandler({
      silentTimeoutMs: 5_000,
      execute: async () => ({ toolUseId: '', content: 'ok' }),
    });
    const result = await runToolGuarded(handler, tc, baseCtx);
    expect(result.content).toBe('ok');
  });
});
