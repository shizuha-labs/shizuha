import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { bashTool } from '../../src/tools/builtin/bash.js';
import type { ToolContext } from '../../src/tools/types.js';

// SCLI-6xx regression (operator 2026-09-18): a detached grandchild that
// inherits the tool call's stdio pipes (e.g. `gcloud auth login` relaunched
// detached inside the command) must NOT wedge the turn. Node's 'close' waits
// for ALL stdio streams to end — the tool used to settle on 'close', so the
// turn hung for 78 minutes on a command that finished in milliseconds while
// the pipe-holding grandchild lived on. The tool must settle on process EXIT
// with a bounded drain window, then cut the pipes.

function ctx(): ToolContext {
  return { cwd: os.tmpdir(), sessionId: `sess-${Math.round(performance.now())}` } as unknown as ToolContext;
}

describe('bash settles on process exit with bounded stdio drain (SCLI-6xx)', () => {
  it('returns promptly when a detached grandchild holds the pipes', async () => {
    const start = Date.now();
    // The command finishes instantly but leaves a detached 60s sleeper holding
    // stdout/stderr — the exact gcloud-orphan shape.
    const result = await bashTool.execute(
      {
        command:
          'echo pipe-holder-test; nohup sleep 60 >/dev/null 2>&1 & disown; exit 0',
        timeout: 600000,
      },
      ctx(),
    );
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(false);
    expect(result.content).toContain('pipe-holder-test');
    // Must settle within the drain grace (5s default) + slack — NOT 60s.
    expect(elapsed).toBeLessThan(15000);
  }, 30000);

  it('still waits for a live foreground command (drain does not cut early)', async () => {
    const start = Date.now();
    const result = await bashTool.execute(
      { command: 'echo slow-start; sleep 2; echo slow-done', timeout: 600000 },
      ctx(),
    );
    const elapsed = Date.now() - start;
    expect(result.isError).toBe(false);
    expect(result.content).toContain('slow-done');
    expect(elapsed).toBeGreaterThanOrEqual(1900);
  }, 30000);
});
