import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { bashTool } from '../../src/tools/builtin/bash.js';
import type { ToolContext } from '../../src/tools/types.js';

// SCLI-39 regression: when the user queues a message mid-turn, the turn's abort
// signal must kill an in-flight long-running bash promptly — otherwise the turn
// wedges awaiting a command that never returns and the TUI's running-tool timer
// ticks unbounded (operator observed `bash (556m)`).

function ctx(abortSignal?: AbortSignal): ToolContext {
  return { cwd: os.tmpdir(), sessionId: `sess-${Math.round(performance.now())}`, abortSignal } as unknown as ToolContext;
}

describe('bash honors context.abortSignal (SCLI-39)', () => {
  it('kills a long-running command promptly when aborted mid-run', async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 150);
    // 10-minute timeout so ONLY the abort (not the timeout) can end this early.
    const result = await bashTool.execute({ command: 'sleep 30', timeout: 600000 }, ctx(ac.signal));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // returned far before the 30s sleep / 600s timeout
    expect(result.content.toLowerCase()).toContain('aborted');
  }, 15000);

  it('returns immediately when the signal is already aborted before execute', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    const result = await bashTool.execute({ command: 'sleep 30', timeout: 600000 }, ctx(ac.signal));
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.content.toLowerCase()).toContain('aborted');
  }, 15000);

  it('runs normally and does NOT report aborted when the signal never fires', async () => {
    const result = await bashTool.execute({ command: 'echo hello-world' }, ctx(new AbortController().signal));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello-world');
    expect(result.content.toLowerCase()).not.toContain('aborted');
  });

  it('runs normally when no abort signal is provided (back-compat)', async () => {
    const result = await bashTool.execute({ command: 'echo ok' }, ctx(undefined));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('ok');
  });
});
