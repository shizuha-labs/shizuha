import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackgroundTaskRegistry } from '../../src/tasks/registry.js';

describe('BackgroundTaskRegistry', () => {
  let registry: BackgroundTaskRegistry;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create', () => {
    it('creates a task with running status', () => {
      const task = registry.create('bash', 'echo hello');
      expect(task.id).toMatch(/^task-/);
      expect(task.type).toBe('bash');
      expect(task.status).toBe('running');
      expect(task.description).toBe('echo hello');
      expect(task.output).toBe('');
      expect(task.notified).toBe(false);
    });

    it('tracks task count', () => {
      expect(registry.size).toBe(0);
      registry.create('bash', 'task1');
      registry.create('agent', 'task2');
      expect(registry.size).toBe(2);
      expect(registry.runningCount).toBe(2);
    });
  });

  describe('lifecycle', () => {
    it('completes a task', () => {
      const task = registry.create('bash', 'echo hello');
      registry.appendOutput(task.id, 'hello\n');
      registry.complete(task.id, 0);

      const t = registry.get(task.id)!;
      expect(t.status).toBe('completed');
      expect(t.exitCode).toBe(0);
      expect(t.completedAt).toBeGreaterThan(0);
      expect(t.output).toBe('hello\n');
    });

    it('fails a task', () => {
      const task = registry.create('bash', 'bad command');
      registry.fail(task.id, 'command not found');

      const t = registry.get(task.id)!;
      expect(t.status).toBe('failed');
      expect(t.error).toBe('command not found');
    });

    it('kills a task', () => {
      const task = registry.create('bash', 'sleep 100');
      const killed = registry.kill(task.id);

      expect(killed).toBe(true);
      expect(registry.get(task.id)!.status).toBe('killed');
      expect(registry.runningCount).toBe(0);
    });

    it('cannot kill a completed task', () => {
      const task = registry.create('bash', 'echo ok');
      registry.complete(task.id);
      const killed = registry.kill(task.id);

      expect(killed).toBe(false);
      expect(registry.get(task.id)!.status).toBe('completed');
    });
  });

  describe('collectAttachments', () => {
    it('returns task_status for completed tasks', () => {
      const task = registry.create('bash', 'echo hello');
      registry.appendOutput(task.id, 'hello\n');
      registry.complete(task.id, 0);

      const attachments = registry.collectAttachments();
      expect(attachments).toHaveLength(1);
      expect(attachments[0]!.type).toBe('task_status');
      expect(attachments[0]!.taskId).toBe(task.id);
      expect(attachments[0]!.status).toBe('completed');
      expect(attachments[0]!.deltaOutput).toBe('hello\n');
    });

    it('marks tasks as notified after collection', () => {
      const task = registry.create('bash', 'echo hello');
      registry.complete(task.id, 0);

      registry.collectAttachments();
      const second = registry.collectAttachments();
      expect(second).toHaveLength(0);
    });

    it('returns task_progress for running tasks with new output', () => {
      const task = registry.create('bash', 'long running');
      // Small output — no progress reported
      registry.appendOutput(task.id, 'small');
      expect(registry.collectAttachments()).toHaveLength(0);

      // Large output — progress reported
      registry.appendOutput(task.id, 'x'.repeat(200));
      const attachments = registry.collectAttachments();
      expect(attachments).toHaveLength(1);
      expect(attachments[0]!.type).toBe('task_progress');
      expect(attachments[0]!.status).toBe('running');
    });

    it('returns task_status for failed tasks', () => {
      const task = registry.create('bash', 'bad');
      registry.fail(task.id, 'exit code 1');

      const attachments = registry.collectAttachments();
      expect(attachments).toHaveLength(1);
      expect(attachments[0]!.status).toBe('failed');
      expect(attachments[0]!.error).toBe('exit code 1');
    });

    it('handles multiple tasks', () => {
      const t1 = registry.create('bash', 'task 1');
      const t2 = registry.create('bash', 'task 2');
      registry.complete(t1.id, 0);
      registry.fail(t2.id, 'oops');

      const attachments = registry.collectAttachments();
      expect(attachments).toHaveLength(2);
    });
  });

  describe('waitForCompletion', () => {
    it('resolves immediately for already-completed tasks', async () => {
      const task = registry.create('bash', 'done');
      registry.complete(task.id, 0);

      const result = await registry.waitForCompletion(task.id, 1000);
      expect(result).toBe(true);
    });

    it('resolves when task completes during wait', async () => {
      const task = registry.create('bash', 'slow');

      // Complete after 50ms
      setTimeout(() => registry.complete(task.id, 0), 50);

      const result = await registry.waitForCompletion(task.id, 5000);
      expect(result).toBe(true);
    });

    it('times out for stuck tasks', async () => {
      const task = registry.create('bash', 'stuck');

      const result = await registry.waitForCompletion(task.id, 200);
      expect(result).toBe(false);
    });

    it('returns false for unknown tasks', async () => {
      const result = await registry.waitForCompletion('nonexistent', 100);
      expect(result).toBe(false);
    });
  });

  describe('waitForNextTerminal', () => {
    it('resolves on a terminal event without consuming its attachment', async () => {
      const task = registry.create('bash', 'test suite');
      const waiting = registry.waitForNextTerminal(5000);

      registry.appendOutput(task.id, '23 passed\n');
      registry.complete(task.id, 0);

      await expect(waiting).resolves.toMatchObject({ id: task.id, status: 'completed' });
      expect((registry as unknown as { terminalWaiters: Set<unknown> }).terminalWaiters.size).toBe(0);
      expect(registry.collectAttachments()).toEqual([
        expect.objectContaining({ taskId: task.id, status: 'completed', deltaOutput: '23 passed\n' }),
      ]);
    });

    it('resolves for failed and killed tasks', async () => {
      const failed = registry.create('bash', 'failing test');
      const failedWait = registry.waitForNextTerminal(5000);
      registry.fail(failed.id, 'exit 1');
      await expect(failedWait).resolves.toMatchObject({ id: failed.id, status: 'failed' });
      registry.collectAttachments();

      const killed = registry.create('agent', 'stuck helper');
      const killedWait = registry.waitForNextTerminal(5000);
      registry.kill(killed.id);
      await expect(killedWait).resolves.toMatchObject({ id: killed.id, status: 'killed' });
    });

    it('uses a bounded referenced timer and removes the waiter on timeout', async () => {
      vi.useFakeTimers();
      const task = registry.create('bash', 'stuck');
      const waiting = registry.waitForNextTerminal(250);

      await vi.advanceTimersByTimeAsync(249);
      let settled = false;
      void waiting.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBeNull();
      expect((registry as unknown as { terminalWaiters: Set<unknown> }).terminalWaiters.size).toBe(0);

      // A later completion remains collectable and cannot re-settle the expired waiter.
      registry.complete(task.id, 0);
      expect(registry.collectAttachments()).toEqual([
        expect.objectContaining({ taskId: task.id, status: 'completed' }),
      ]);
    });

    it('removes the waiter when its caller aborts', async () => {
      vi.useFakeTimers();
      registry.create('bash', 'stuck');
      const abort = new AbortController();
      const waiting = registry.waitForNextTerminal(5000, abort.signal);

      expect((registry as unknown as { terminalWaiters: Set<unknown> }).terminalWaiters.size).toBe(1);
      abort.abort();
      await expect(waiting).resolves.toBeNull();
      expect((registry as unknown as { terminalWaiters: Set<unknown> }).terminalWaiters.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('list', () => {
    it('lists all tasks', () => {
      registry.create('bash', 'task 1');
      registry.create('agent', 'task 2');

      const tasks = registry.list();
      expect(tasks).toHaveLength(2);
      expect(tasks.map(t => t.type)).toContain('bash');
      expect(tasks.map(t => t.type)).toContain('agent');
    });
  });

  describe('output management', () => {
    it('appends output', () => {
      const task = registry.create('bash', 'test');
      registry.appendOutput(task.id, 'line 1\n');
      registry.appendOutput(task.id, 'line 2\n');

      expect(registry.get(task.id)!.output).toBe('line 1\nline 2\n');
    });

    it('truncates very large output', () => {
      const task = registry.create('bash', 'big output');
      // Append 200KB of output
      for (let i = 0; i < 20; i++) {
        registry.appendOutput(task.id, 'x'.repeat(10_000) + '\n');
      }

      // Should be capped at ~100KB
      expect(registry.get(task.id)!.output.length).toBeLessThanOrEqual(120_000);
    });
  });

  describe('waitAny', () => {
    it('resolves with the first task to reach terminal state', async () => {
      const a = registry.create('bash', 'sleep 1');
      const b = registry.create('bash', 'sleep 2');
      const waiter = registry.waitAny([a.id, b.id], 5000);
      // Complete b first — waitAny must return b, not a.
      registry.complete(b.id, 0);
      const result = await waiter;
      expect(result?.id).toBe(b.id);
      expect(result?.status).toBe('completed');
    });

    it('resolves immediately when a task is already terminal', async () => {
      const a = registry.create('bash', 'done already');
      registry.complete(a.id, 0);
      const b = registry.create('bash', 'still running');
      const result = await registry.waitAny([a.id, b.id], 1000);
      expect(result?.id).toBe(a.id);
    });

    it('resolves null on timeout when nothing completes', async () => {
      const a = registry.create('bash', 'stuck');
      const result = await registry.waitAny([a.id], 150);
      expect(result).toBeNull();
    });

    it('resolves null immediately for unknown ids', async () => {
      const result = await registry.waitAny(['task-nope'], 1000);
      expect(result).toBeNull();
    });
  });

  describe('waitAll', () => {
    it('resolves true when all tasks complete', async () => {
      const a = registry.create('bash', 'a');
      const b = registry.create('bash', 'b');
      const waiter = registry.waitAll([a.id, b.id], 5000);
      registry.complete(a.id, 0);
      registry.complete(b.id, 0);
      expect(await waiter).toBe(true);
    });

    it('resolves true immediately when all are already terminal', async () => {
      const a = registry.create('bash', 'a');
      registry.complete(a.id, 0);
      expect(await registry.waitAll([a.id], 1000)).toBe(true);
    });

    it('resolves false on timeout when one task is stuck', async () => {
      const a = registry.create('bash', 'a');
      const b = registry.create('bash', 'stuck');
      registry.complete(a.id, 0);
      expect(await registry.waitAll([a.id, b.id], 150)).toBe(false);
    });

    it('resolves true for an empty/unknown set', async () => {
      expect(await registry.waitAll([], 1000)).toBe(true);
      expect(await registry.waitAll(['task-nope'], 1000)).toBe(true);
    });
  });

  describe('getOutput', () => {
    it('returns structured output and advances the offset', () => {
      const a = registry.create('bash', 'echo hi');
      registry.appendOutput(a.id, 'hello ');
      const first = registry.getOutput(a.id);
      expect(first?.deltaOutput).toBe('hello ');
      registry.appendOutput(a.id, 'world');
      const second = registry.getOutput(a.id);
      expect(second?.deltaOutput).toBe('world');
    });

    it('returns full output when full=true without advancing offset', () => {
      const a = registry.create('bash', 'echo hi');
      registry.appendOutput(a.id, 'hello');
      const full = registry.getOutput(a.id, true);
      expect(full?.deltaOutput).toBe('hello');
      const again = registry.getOutput(a.id, true);
      expect(again?.deltaOutput).toBe('hello');
    });

    it('includes status, exitCode and error', () => {
      const a = registry.create('bash', 'boom');
      registry.fail(a.id, 'command not found');
      const out = registry.getOutput(a.id, true);
      expect(out?.status).toBe('failed');
      expect(out?.error).toBe('command not found');
    });

    it('returns undefined for unknown ids', () => {
      expect(registry.getOutput('task-nope')).toBeUndefined();
    });
  });

  describe('monitor tasks (SCLI-432)', () => {
    it('creates a monitor task with type monitor', () => {
      const m = registry.create('monitor', 'tail -f app.log');
      expect(m.type).toBe('monitor');
      expect(m.status).toBe('running');
    });

    it('monitorLine appends line-buffered output', () => {
      const m = registry.create('monitor', 'tail -f app.log');
      registry.monitorLine(m.id, 'INFO request ok');
      registry.monitorLine(m.id, 'WARN retry');
      expect(registry.get(m.id)!.output).toBe('INFO request ok\nWARN retry\n');
    });

    it('monitorLine is a no-op for non-monitor tasks', () => {
      const b = registry.create('bash', 'echo hi');
      registry.monitorLine(b.id, 'should not append');
      expect(registry.get(b.id)!.output).toBe('');
    });

    it('monitorLine is a no-op for unknown ids', () => {
      registry.monitorLine('task-nope', 'x');
      expect(registry.get('task-nope')).toBeUndefined();
    });

    it('monitor progress flows into collectAttachments', () => {
      const m = registry.create('monitor', 'tail -f app.log');
      const longLine = 'INFO request ok ' + 'x'.repeat(120);
      registry.monitorLine(m.id, longLine);
      const attachments = registry.collectAttachments();
      expect(attachments.length).toBeGreaterThan(0);
      const progress = attachments.find((a) => a.type === 'task_progress');
      expect(progress).toBeDefined();
      expect(progress!.deltaOutput).toContain('INFO request ok');
    });

    it('monitor task can be killed', () => {
      const m = registry.create('monitor', 'tail -f app.log');
      expect(registry.kill(m.id)).toBe(true);
      expect(registry.get(m.id)!.status).toBe('killed');
    });
  });
});
