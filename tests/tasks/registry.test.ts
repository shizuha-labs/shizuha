import { describe, it, expect, beforeEach } from 'vitest';
import { BackgroundTaskRegistry } from '../../src/tasks/registry.js';

describe('BackgroundTaskRegistry', () => {
  let registry: BackgroundTaskRegistry;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
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
});
