/**
 * SCLI-619 — Ctrl+B foreground→background demotion.
 *
 * A running foreground bash command can be demoted to the background: it keeps
 * running, gets a task ID in the BackgroundTaskRegistry, and its output keeps
 * accumulating. The TUI calls `demoteForegroundBash()` on Ctrl+B.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { bashTool, demoteForegroundBash } from '../../src/tools/builtin/bash.js';
import type { ToolContext } from '../../src/tools/types.js';
import { BackgroundTaskRegistry } from '../../src/tasks/registry.js';

function makeContext(): ToolContext & { taskRegistry: BackgroundTaskRegistry } {
  return {
    cwd: os.tmpdir(),
    sessionId: 'demote-test',
    taskRegistry: new BackgroundTaskRegistry(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  // Any lingering foreground handle must not leak into the next test.
  demoteForegroundBash();
});

describe('SCLI-619 foreground→background demotion', () => {
  it('returns null when no foreground command is running', () => {
    expect(demoteForegroundBash()).toBeNull();
  });

  it('demotes a running foreground command to a background task', async () => {
    const ctx = makeContext();
    const promise = bashTool.execute({ command: 'sleep 1; echo demoted-output' }, ctx);

    // Give the process a moment to spawn and register as the active foreground.
    await sleep(300);
    const taskId = demoteForegroundBash();
    expect(taskId).toBeTruthy();

    // The foreground promise resolves immediately with the demotion notice.
    const result = await promise;
    expect(result.content).toContain(`Demoted to background task ${taskId}`);
    expect(result.content).toContain(`TaskOutput(task_id="${taskId}")`);
    expect(result.isError).toBeFalsy();

    // The task is registered and still running (not killed).
    const running = ctx.taskRegistry.get(taskId!);
    expect(running).toBeTruthy();
    expect(running!.status).toBe('running');
    expect(running!.type).toBe('bash');
    expect(running!.pid).toBeTruthy();

    // Wait for the underlying command to finish — the demoted task completes
    // and its output accumulates in the registry.
    await sleep(1500);
    const done = ctx.taskRegistry.get(taskId!);
    expect(done!.status).toBe('completed');
    expect(done!.output).toContain('demoted-output');
  }, 10000);

  it('does not kill the demoted task when the turn abort fires afterwards', async () => {
    const ctx = makeContext();
    const controller = new AbortController();
    const promise = bashTool.execute(
      { command: 'sleep 1; echo survived' },
      { ...ctx, abortSignal: controller.signal },
    );

    await sleep(300);
    const taskId = demoteForegroundBash();
    expect(taskId).toBeTruthy();
    await promise;

    // Aborting the turn after demotion must NOT kill the demoted task.
    controller.abort();
    await sleep(1500);
    const task = ctx.taskRegistry.get(taskId!);
    expect(task!.status).toBe('completed');
    expect(task!.output).toContain('survived');
  }, 10000);
});
