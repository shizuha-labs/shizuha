/**
 * Background Task Registry — in-memory store for background tasks.
 *
 * Tracks bash commands and sub-agents running in the background.
 * Before each API call, the agent loop calls collectAttachments()
 * to inject task status/progress as system-reminder messages.
 */

import * as crypto from 'node:crypto';
import type { BackgroundTask, TaskAttachment, TaskType, TaskStatus } from './types.js';
import { logger } from '../utils/logger.js';

/** Max output bytes to include in a progress attachment */
const MAX_DELTA_BYTES = 4000;
/** Max total output to keep in memory per task */
const MAX_OUTPUT_BYTES = 100_000;
/** How long to keep completed tasks before pruning */
const COMPLETED_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>();

  /** Create and register a new background task. Returns the task ID. */
  create(type: TaskType, description: string): BackgroundTask {
    const id = `task-${crypto.randomUUID().slice(0, 8)}`;
    const task: BackgroundTask = {
      id,
      type,
      description,
      status: 'running',
      output: '',
      createdAt: Date.now(),
      outputOffset: 0,
      notified: false,
      abort: new AbortController(),
    };
    this.tasks.set(id, task);
    logger.info({ taskId: id, type, description }, 'Background task created');
    return task;
  }

  /** Get a task by ID. */
  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /** List all tasks. */
  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  /** Append output to a task's buffer. */
  appendOutput(id: string, chunk: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.output += chunk;
    // Prevent unbounded memory growth
    if (task.output.length > MAX_OUTPUT_BYTES) {
      const trimmed = task.output.length - MAX_OUTPUT_BYTES;
      task.output = `[${trimmed} bytes trimmed]\n` + task.output.slice(-MAX_OUTPUT_BYTES);
    }
  }

  /** Mark a task as completed. */
  complete(id: string, exitCode?: number): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'completed';
    task.exitCode = exitCode;
    task.completedAt = Date.now();
    logger.info({ taskId: id, exitCode, durationMs: task.completedAt - task.createdAt }, 'Background task completed');
  }

  /** Mark a task as failed. */
  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();
    logger.warn({ taskId: id, error }, 'Background task failed');
  }

  /** Kill a running task. */
  kill(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || (task.status !== 'running' && task.status !== 'pending')) return false;
    task.abort.abort();
    task.status = 'killed';
    task.completedAt = Date.now();
    logger.info({ taskId: id }, 'Background task killed');
    return true;
  }

  /** Number of tasks. */
  get size(): number {
    return this.tasks.size;
  }

  /** Number of running tasks. */
  get runningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') count++;
    }
    return count;
  }

  /**
   * Collect task status attachments to inject before the next API call.
   * This is the push-notification mechanism — the model doesn't need to poll.
   *
   * Returns attachments for:
   * - Completed/failed/killed tasks that haven't been notified yet
   * - Running tasks with new output since last check (progress updates)
   */
  collectAttachments(): TaskAttachment[] {
    const attachments: TaskAttachment[] = [];

    for (const task of this.tasks.values()) {
      const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'killed';

      if (isTerminal && !task.notified) {
        // Terminal state — notify once
        const delta = task.output.slice(task.outputOffset);
        attachments.push({
          type: 'task_status',
          taskId: task.id,
          taskType: task.type,
          status: task.status,
          description: task.description,
          deltaOutput: delta.length > 0 ? truncateDelta(delta) : undefined,
          error: task.error,
        });
        task.notified = true;
        task.outputOffset = task.output.length;
      } else if (task.status === 'running' && task.output.length > task.outputOffset) {
        // Running with new output — progress update
        const delta = task.output.slice(task.outputOffset);
        if (delta.length > 100) { // Only report meaningful progress
          attachments.push({
            type: 'task_progress',
            taskId: task.id,
            taskType: task.type,
            status: 'running',
            description: task.description,
            deltaOutput: truncateDelta(delta),
          });
          task.outputOffset = task.output.length;
        }
      }
    }

    // Prune old completed tasks
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.notified && task.completedAt && (now - task.completedAt) > COMPLETED_TTL_MS) {
        this.tasks.delete(id);
      }
    }

    return attachments;
  }

  /**
   * Wait for a task to reach a terminal state.
   * Returns true if the task completed, false if timed out.
   */
  async waitForCompletion(id: string, timeoutMs: number = 30000): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task) return false;

    const isTerminal = () => {
      const t = this.tasks.get(id);
      return t && (t.status === 'completed' || t.status === 'failed' || t.status === 'killed');
    };

    if (isTerminal()) return true;

    return new Promise((resolve) => {
      const pollInterval = setInterval(() => {
        if (isTerminal()) {
          clearInterval(pollInterval);
          clearTimeout(timeoutTimer);
          resolve(true);
        }
      }, 100);

      const timeoutTimer = setTimeout(() => {
        clearInterval(pollInterval);
        resolve(false);
      }, timeoutMs);

      // Don't keep the event loop alive for polling
      pollInterval.unref();
      timeoutTimer.unref();
    });
  }
}

function truncateDelta(delta: string): string {
  if (delta.length <= MAX_DELTA_BYTES) return delta;
  // Keep the tail (most recent output is most relevant)
  return `[...${delta.length - MAX_DELTA_BYTES} bytes trimmed...]\n` + delta.slice(-MAX_DELTA_BYTES);
}
