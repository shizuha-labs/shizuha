/**
 * SCLI-688 (SCLI-430 second increment) — agent-callable WaitTasks tool.
 *
 * Pins the acceptance shape: start two background sleeps → WaitTasks(mode=any)
 * returns the FIRST completer's id + output → TaskStop the remaining → outputs
 * retrievable. Also pins mode=all, the timeout→null path, unknown-id skipping,
 * already-terminal immediate resolution, and the no-registry error.
 */

import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { bashTool } from '../../src/tools/builtin/bash.js';
import { taskStopTool } from '../../src/tools/builtin/task-stop.js';
import { waitTasksTool } from '../../src/tools/builtin/wait-tasks.js';
import type { ToolContext } from '../../src/tools/types.js';
import { BackgroundTaskRegistry } from '../../src/tasks/registry.js';

function makeContext(): ToolContext & { taskRegistry: BackgroundTaskRegistry } {
  return {
    cwd: os.tmpdir(),
    sessionId: 'wait-tasks-test',
    taskRegistry: new BackgroundTaskRegistry(),
  };
}

async function launchBg(ctx: ReturnType<typeof makeContext>, command: string): Promise<string> {
  const result = await bashTool.execute({ command, run_in_background: true }, ctx);
  const m = result.content.match(/task ID: (\S+)/);
  expect(m, `background launch should return a task id: ${result.content}`).toBeTruthy();
  return m![1];
}

describe('WaitTasks (SCLI-688 / SCLI-430 acceptance #1)', () => {
  it('mode=any returns the FIRST completer; the loser stays stoppable; outputs retrievable', async () => {
    const ctx = makeContext();
    const fastId = await launchBg(ctx, 'sleep 0.4; echo fast-done');
    const slowId = await launchBg(ctx, 'sleep 5; echo slow-done');

    const result = await waitTasksTool.execute(
      { task_ids: [fastId, slowId], mode: 'any', timeout: 8000 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain(`First completer: ${fastId}`);
    expect(result.content).toContain('fast-done');
    expect(result.content).not.toContain(`First completer: ${slowId}`);

    // The loser is still running → TaskStop it (the acceptance's kill-remaining step).
    const stop = await taskStopTool.execute({ task_id: slowId }, ctx);
    expect(stop.isError).toBeFalsy();

    // Outputs retrievable afterwards: winner completed, loser killed.
    const winnerOut = ctx.taskRegistry.getOutput(fastId, true);
    expect(winnerOut?.status).toBe('completed');
    expect(winnerOut?.deltaOutput).toContain('fast-done');
    const loserOut = ctx.taskRegistry.getOutput(slowId, true);
    expect(loserOut?.status).toBe('killed');
  }, 15000);

  it('mode=any resolves an already-terminal task immediately', async () => {
    const ctx = makeContext();
    const id = await launchBg(ctx, 'echo instant; sleep 2');
    // Wait for it to finish on its own terms.
    await ctx.taskRegistry.waitAll([id], 8000);

    const result = await waitTasksTool.execute({ task_ids: [id], mode: 'any', timeout: 500 }, ctx);
    expect(result.content).toContain(`First completer: ${id}`);
    expect(result.content).toContain('instant');
  }, 15000);

  it('mode=all reports per-task terminal status', async () => {
    const ctx = makeContext();
    const a = await launchBg(ctx, 'echo a-out');
    const b = await launchBg(ctx, 'echo b-out; exit 3');

    const result = await waitTasksTool.execute(
      { task_ids: [a, b], mode: 'all', timeout: 8000 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('All tasks terminal');
    expect(result.content).toContain(`${a}: completed`);
    // The registry surfaces non-zero exits via the error field ("Exited with code N").
    expect(result.content).toContain(`${b}: failed — Exited with code 3`);
  }, 15000);

  it('mode=any returns the timeout path with still-running ids', async () => {
    const ctx = makeContext();
    const id = await launchBg(ctx, 'sleep 5');

    const result = await waitTasksTool.execute(
      { task_ids: [id], mode: 'any', timeout: 300 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('No task reached a terminal state within 300ms');
    expect(result.content).toContain(`Still running: ${id}`);
    // Cleanup.
    await taskStopTool.execute({ task_id: id }, ctx);
  }, 15000);

  it('unknown ids are skipped; unknown-only set resolves immediately', async () => {
    const ctx = makeContext();
    // Unknown-only: waitAny resolves null immediately → timeout-path message, no hang.
    const unknownOnly = await waitTasksTool.execute(
      { task_ids: ['nope-1', 'nope-2'], mode: 'any', timeout: 5000 },
      ctx,
    );
    expect(unknownOnly.content).toContain('No task reached a terminal state');
    expect(unknownOnly.content).toContain('Unknown ids (skipped): nope-1, nope-2');

    // Mixed: the known task wins, unknowns reported as skipped.
    const realId = await launchBg(ctx, 'echo mixed-ok');
    const mixed = await waitTasksTool.execute(
      { task_ids: ['nope-1', realId], mode: 'any', timeout: 8000 },
      ctx,
    );
    expect(mixed.content).toContain(`First completer: ${realId}`);
    expect(mixed.content).toContain('Unknown ids (skipped): nope-1');
  }, 15000);

  it('errors cleanly when the task registry is unavailable', async () => {
    const ctx = { cwd: os.tmpdir(), sessionId: 'no-registry' } as ToolContext;
    const result = await waitTasksTool.execute({ task_ids: ['x'] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Background tasks are not available');
  });
});
