import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_TASK_WAIT_EXPIRED_MESSAGE,
  BackgroundTaskWaitController,
  MAX_BACKGROUND_TASK_WAIT_MS,
  decideBackgroundTaskContinuation,
  isBackgroundTaskWaitIntent,
} from '../../src/agent/background-task-wait.js';
import { BackgroundTaskRegistry } from '../../src/tasks/registry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('background task wait intent', () => {
  it.each([
    'Let me wait for the test results:',
    'Waiting for the background task to complete.',
    "The test suite is still running; I'll wait.",
    'I am awaiting command output.',
    "I'm waiting for it to finish.",
    "I'll wait until the tests finish.",
    'Waiting on the test suite.',
    "The command is still running; I'll wait.",
    "The process is still running; I'll wait.",
    "Tests are still running; I'll wait.",
    "The benchmark run is still running; I'll wait.",
  ])('accepts explicit wait-only text: %s', (text) => {
    expect(isBackgroundTaskWaitIntent(text)).toBe(true);
  });

  it.each([
    'The server is running in the background. Done.',
    'I waited for the tests and fixed the failure.',
    'All tests pass; here is the final answer.',
    'Let me inspect the implementation next.',
    'I will wait for your command before deploying. The background server remains running as intended.',
    'I will await your command. The test server remains running in the background.',
    'Waiting for your approval. The background server is healthy and intentionally left running.',
    "I won't wait for the background task; it is intentionally detached. Done.",
    'No need to wait for the background task; the server is intentionally persistent. Done.',
    'Without waiting for the test results, I completed the requested fix.',
    'Rather than wait for the background task, I am finishing now.',
    'I will wait for the task assignment from you. A background server is also running.',
    'I was waiting for the test results, but they have now passed.',
    'I finished waiting for the test results and fixed the failure.',
    'I am done waiting for the background task; it is intentionally detached.',
    'After waiting for the test results, I fixed all failures.',
    'I stopped waiting for the test results and completed the work.',
  ])('rejects non-wait final/progress text: %s', (text) => {
    expect(isBackgroundTaskWaitIntent(text)).toBe(false);
  });
});

describe('BackgroundTaskWaitController', () => {
  it.each(['complete', 'fail'] as const)('continues when a task reaches %s before decide', async (terminal) => {
    const registry = new BackgroundTaskRegistry();
    const task = registry.create('bash', 'pytest');
    registry.appendOutput(task.id, `${terminal} output\n`);
    if (terminal === 'complete') registry.complete(task.id, 0);
    else registry.fail(task.id, 'exit 1');

    const controller = new BackgroundTaskWaitController(1000);
    await expect(controller.decide('Let me wait for the test results.', registry)).resolves.toBe('continue');
    expect(registry.collectAttachments()).toEqual([
      expect.objectContaining({ taskId: task.id, deltaOutput: `${terminal} output\n` }),
    ]);
    expect(registry.collectAttachments()).toHaveLength(0);
  });

  it('continues after a terminal event so the next turn can collect it', async () => {
    const registry = new BackgroundTaskRegistry();
    const task = registry.create('bash', 'pytest');
    const controller = new BackgroundTaskWaitController(1000);
    const decision = controller.decide('Let me wait for the test results.', registry);

    registry.appendOutput(task.id, '22 passed, 1 failed\n');
    registry.complete(task.id, 1);

    await expect(decision).resolves.toBe('continue');
    expect(registry.collectAttachments()).toEqual([
      expect.objectContaining({ taskId: task.id, deltaOutput: '22 passed, 1 failed\n' }),
    ]);
  });

  it('does not wait for an ordinary final answer or stop a background server', async () => {
    const registry = new BackgroundTaskRegistry();
    const server = registry.create('bash', 'python server.py');
    const controller = new BackgroundTaskWaitController(1000);

    await expect(controller.decide('The server is running. Done.', registry)).resolves.toBe('terminate');
    expect(registry.get(server.id)?.status).toBe('running');
  });

  it('uses one absolute budget, nudges once, then terminates without killing unrelated work', async () => {
    vi.useFakeTimers();
    const registry = new BackgroundTaskRegistry();
    const first = registry.create('bash', 'first test');
    const controller = new BackgroundTaskWaitController(100);

    const firstDecision = controller.decide('Waiting for the first test result.', registry);
    await vi.advanceTimersByTimeAsync(60);
    registry.complete(first.id, 0);
    await expect(firstDecision).resolves.toBe('continue');
    registry.collectAttachments();

    const second = registry.create('bash', 'second test');
    const secondDecision = controller.decide('Waiting for the second test result.', registry);
    await vi.advanceTimersByTimeAsync(39);
    let settled = false;
    void secondDecision.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(secondDecision).resolves.toBe('nudge');
    expect(controller.nudgeMessage().content).toBe(BACKGROUND_TASK_WAIT_EXPIRED_MESSAGE);

    await expect(controller.decide('I will wait for the task results again.', registry)).resolves.toBe('terminate');
    expect(registry.get(second.id)?.status).toBe('running');

    const persistentServer = registry.create('bash', 'persistent server');
    await expect(controller.decide('Waiting for the background task again.', registry)).resolves.toBe('terminate');
    expect(registry.get(second.id)?.status).toBe('running');
    expect(registry.get(persistentServer.id)?.status).toBe('running');
  });

  it('hard-caps an oversized configured budget at 610 seconds', async () => {
    vi.useFakeTimers();
    const registry = new BackgroundTaskRegistry();
    registry.create('agent', 'long helper');
    const controller = new BackgroundTaskWaitController(Number.MAX_SAFE_INTEGER);
    const decision = controller.decide('Waiting for the background task.', registry);

    await vi.advanceTimersByTimeAsync(MAX_BACKGROUND_TASK_WAIT_MS - 1);
    let settled = false;
    void decision.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(decision).resolves.toBe('nudge');
  });

  it('cancels its active event wait from an external caller signal', async () => {
    const registry = new BackgroundTaskRegistry();
    registry.create('bash', 'tests');
    const abort = new AbortController();
    const controller = new BackgroundTaskWaitController(1000, abort.signal);
    const decision = controller.decide('Waiting on the test suite.', registry);

    expect((registry as unknown as { terminalWaiters: Set<unknown> }).terminalWaiters.size).toBe(1);
    abort.abort();
    await expect(decision).resolves.toBe('terminate');
    expect((registry as unknown as { terminalWaiters: Set<unknown> }).terminalWaiters.size).toBe(0);
  });
});

describe('decideBackgroundTaskContinuation', () => {
  it('uses stripped visible text and ignores hidden reasoning', async () => {
    const registry = new BackgroundTaskRegistry();
    const task = registry.create('bash', 'tests');
    registry.complete(task.id, 0);
    const controller = new BackgroundTaskWaitController(1000);

    await expect(decideBackgroundTaskContinuation({
      controller,
      registry,
      toolCallCount: 0,
      assistantContent: [
        { type: 'reasoning', id: 'r1', rawContent: 'unrelated hidden reasoning' },
        { type: 'text', text: '<think>hidden</think> Waiting on the test suite.' },
      ],
    })).resolves.toBe('continue');
  });

  it('never treats a turn with tool calls as wait-only', async () => {
    const registry = new BackgroundTaskRegistry();
    registry.create('bash', 'tests');
    const controller = new BackgroundTaskWaitController(1000);

    await expect(decideBackgroundTaskContinuation({
      controller,
      registry,
      toolCallCount: 1,
      assistantContent: 'Waiting on the test suite.',
    })).resolves.toBe('terminate');
  });
});
