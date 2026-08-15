/**
 * Background Task Registry — in-memory store for background tasks.
 *
 * Tracks bash commands and sub-agents running in the background.
 * Before each API call, the agent loop calls collectAttachments()
 * to inject task status/progress as system-reminder messages.
 */

import * as crypto from 'node:crypto';
import type { BackgroundTask, BackgroundTaskWatch, TaskAttachment, TaskNotifyPolicy, TaskType, TaskStatus } from './types.js';
import type { BackgroundTaskEvent } from '../events/types.js';
import { logger } from '../utils/logger.js';

/** Max output bytes to include in a progress attachment */
const MAX_DELTA_BYTES = 4000;
/** Max total output to keep in memory per task */
const MAX_OUTPUT_BYTES = 100_000;
/** How long to keep completed tasks before pruning */
const COMPLETED_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PROGRESS_EVENT_MIN_INTERVAL_MS = 2000;

export class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>();
  private watches = new Map<string, BackgroundTaskWatch>();
  private onEvent?: (event: BackgroundTaskEvent) => void;
  private lastProgressEventAt = new Map<string, number>();
  private terminalWaiters = new Set<(task: BackgroundTask) => void>();

  constructor(onEvent?: (event: BackgroundTaskEvent) => void) {
    this.onEvent = onEvent;
  }

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
      notifyPolicy: this.policyForDescription(description),
      abort: new AbortController(),
    };
    this.tasks.set(id, task);
    logger.info({ taskId: id, type, description }, 'Background task created');
    this.emitTaskEvent(task, 'started');
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

  /** List active /watch registrations. */
  listWatches(): BackgroundTaskWatch[] {
    return [...this.watches.values()];
  }

  /**
   * Register a watch by exact task id or description substring.
   * Existing matching tasks immediately inherit the selected notification policy;
   * future tasks inherit it from policyForDescription().
   */
  watch(target: string, policy: TaskNotifyPolicy = 'done_only'): { watch: BackgroundTaskWatch; matched: BackgroundTask[] } {
    const normalized = target.trim();
    if (!normalized) {
      throw new Error('Watch target is required');
    }
    const watch: BackgroundTaskWatch = {
      id: `watch-${crypto.randomUUID().slice(0, 8)}`,
      target: normalized,
      policy,
      createdAt: Date.now(),
    };
    this.watches.set(watch.id, watch);

    const matched = this.matchingTasks(normalized);
    for (const task of matched) {
      task.notifyPolicy = policy;
      task.notified = false;
    }
    logger.info({ watchId: watch.id, target: normalized, policy, matched: matched.map(t => t.id) }, 'Background task watch added');
    return { watch, matched };
  }

  /** Remove an existing /watch registration. */
  unwatch(idOrTarget: string): boolean {
    const key = idOrTarget.trim();
    if (!key) return false;
    if (this.watches.delete(key)) return true;
    for (const [id, watch] of this.watches) {
      if (watch.target === key) {
        this.watches.delete(id);
        return true;
      }
    }
    return false;
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
    const now = Date.now();
    const last = this.lastProgressEventAt.get(id) ?? 0;
    if (chunk.length > 0 && task.notifyPolicy === 'state_changes' && now - last >= PROGRESS_EVENT_MIN_INTERVAL_MS) {
      this.lastProgressEventAt.set(id, now);
      this.emitTaskEvent(task, 'progress');
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
    this.emitTaskEvent(task, 'completed');
    this.notifyTerminalWaiters(task);
  }

  /** Mark a task as failed. */
  fail(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();
    logger.warn({ taskId: id, error }, 'Background task failed');
    this.emitTaskEvent(task, 'failed');
    this.notifyTerminalWaiters(task);
  }

  /** Kill a running task. */
  kill(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || (task.status !== 'running' && task.status !== 'pending')) return false;
    task.abort.abort();
    task.status = 'killed';
    task.completedAt = Date.now();
    logger.info({ taskId: id }, 'Background task killed');
    this.emitTaskEvent(task, 'killed');
    this.notifyTerminalWaiters(task);
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

      if (task.notifyPolicy === 'silent') {
        task.outputOffset = task.output.length;
        if (isTerminal) task.notified = true;
        continue;
      }

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
      } else if (task.notifyPolicy === 'state_changes' && task.status === 'running' && task.output.length > task.outputOffset) {
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

  /** Return the next terminal task whose attachment has not been consumed. */
  nextUnreportedTerminal(): BackgroundTask | null {
    return [...this.tasks.values()].find((task) =>
      !task.notified && isTerminalStatus(task.status)) ?? null;
  }

  /**
   * Wait for the next previously-unreported terminal task.
   *
   * This is intentionally event-driven: the autonomous loop can park until a
   * background test finishes, then start the next model turn where
   * collectAttachments() injects the result. The timeout remains referenced so
   * an awaited one-shot CLI process cannot exit underneath its own notification
   * wait. Every resolution path removes its listener.
   */
  async waitForNextTerminal(timeoutMs: number, signal?: AbortSignal): Promise<BackgroundTask | null> {
    const ready = this.nextUnreportedTerminal();
    if (ready) return ready;
    if (timeoutMs <= 0 || signal?.aborted) return null;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (task: BackgroundTask | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.terminalWaiters.delete(onTerminal);
        signal?.removeEventListener('abort', onAbort);
        resolve(task);
      };
      const onTerminal = (task: BackgroundTask) => finish(task);
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.terminalWaiters.add(onTerminal);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private matchingTasks(target: string): BackgroundTask[] {
    const needle = target.toLowerCase();
    const exact = this.tasks.get(target);
    if (exact) return [exact];
    return [...this.tasks.values()].filter((task) => task.description.toLowerCase().includes(needle));
  }

  private policyForDescription(description: string): TaskNotifyPolicy {
    for (const watch of this.watches.values()) {
      const needle = watch.target.toLowerCase();
      if (description.toLowerCase().includes(needle)) {
        return watch.policy;
      }
    }
    // Preserve SCLI's existing behavior: un-watched background tasks still
    // surface meaningful progress deltas plus terminal status. /watch can opt
    // matching tasks down to done_only or silent.
    return 'state_changes';
  }

  private emitTaskEvent(task: BackgroundTask, status: BackgroundTaskEvent['status']): void {
    if (!this.onEvent) return;
    try {
      this.onEvent({
        type: 'background_task',
        status,
        taskId: task.id,
        description: task.description,
        runningMs: Date.now() - task.createdAt,
        timestamp: Date.now(),
      });
    } catch {
      // UI event emission is best-effort and must not affect task lifecycle.
    }
  }

  private notifyTerminalWaiters(task: BackgroundTask): void {
    for (const waiter of [...this.terminalWaiters]) waiter(task);
  }
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}

function truncateDelta(delta: string): string {
  if (delta.length <= MAX_DELTA_BYTES) return delta;
  // Keep the tail (most recent output is most relevant)
  return `[...${delta.length - MAX_DELTA_BYTES} bytes trimmed...]\n` + delta.slice(-MAX_DELTA_BYTES);
}
