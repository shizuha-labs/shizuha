import type { CoreStreamEvent, StructuredCoreErrorPayload } from '../../../src/local-core-protocol.js';

export type RunLifecycle = 'idle' | 'running' | 'cancelling' | 'cancelled' | 'done' | 'error';

export interface RunLogEntry {
  id: string;
  at: string;
  level: 'status' | 'tool' | 'error' | 'cancel';
  message: string;
  details?: unknown;
  request_id?: string;
}

export interface RunSummary {
  id: string;
  sessionId: string;
  status: RunLifecycle | string;
  startedAt: string;
  endedAt?: string;
  error?: StructuredCoreErrorPayload;
  logs: RunLogEntry[];
}

export interface RunMonitorSnapshot {
  current?: RunSummary;
  recent: RunSummary[];
}

const MAX_RECENT_RUNS = 10;
const MAX_LOGS_PER_RUN = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function eventDetails(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  return value;
}

export function formatStructuredError(error: StructuredCoreErrorPayload): string {
  const parts = [error.code || 'ERROR', error.message || 'Unknown error'];
  parts.push(error.retryable ? 'retryable' : 'not retryable');
  if (error.request_id) parts.push(`request ${error.request_id}`);
  return parts.join(' — ');
}

export class RunMonitorState {
  private currentRun?: RunSummary;
  private recentRuns: RunSummary[] = [];
  private seq = 0;

  snapshot(): RunMonitorSnapshot {
    return {
      current: this.currentRun ? this.cloneRun(this.currentRun) : undefined,
      recent: this.recentRuns.map((run) => this.cloneRun(run)),
    };
  }

  current(): RunSummary | undefined {
    return this.snapshot().current;
  }

  beginRun(sessionId: string): RunSummary {
    const run: RunSummary = {
      id: this.nextId('run'),
      sessionId,
      status: 'running',
      startedAt: nowIso(),
      logs: [],
    };
    this.currentRun = run;
    this.append(run, 'status', 'Run started');
    return this.cloneRun(run);
  }

  handleEvent(event: CoreStreamEvent): RunMonitorSnapshot {
    const run = this.ensureRun();
    if (event.type === 'run_status') {
      run.status = event.status;
      this.append(run, 'status', `Run status: ${event.status}`);
      if (event.status === 'cancelled') this.finish(run, 'cancelled');
    } else if (event.type === 'tool_call') {
      this.append(run, 'tool', `Tool call: ${event.name || event.id}`, eventDetails(event.content));
    } else if (event.type === 'tool_result') {
      this.append(run, 'tool', `Tool result: ${event.name || event.id}`, eventDetails(event.content));
    } else if (event.type === 'error') {
      run.error = event.error;
      this.append(run, 'error', formatStructuredError(event.error), eventDetails(event.error.details), event.error.request_id);
      this.finish(run, 'error');
    } else if (event.type === 'done') {
      this.append(run, 'status', 'Run completed');
      this.finish(run, 'done');
    }
    return this.snapshot();
  }

  markCancellationRequested(): RunMonitorSnapshot {
    const run = this.ensureRun();
    run.status = 'cancelling';
    this.append(run, 'cancel', 'Cancellation requested');
    return this.snapshot();
  }

  handleCancelAck(message = 'Cancellation acknowledged by local core', requestId?: string, status = 'cancelling'): RunMonitorSnapshot {
    const run = this.ensureRun();
    this.append(run, 'cancel', message, undefined, requestId);
    if (status === 'cancelled' || status === 'not_running') {
      this.finish(run, 'cancelled');
    } else {
      run.status = 'cancelling';
    }
    return this.snapshot();
  }

  handleCancelError(error: StructuredCoreErrorPayload): RunMonitorSnapshot {
    const run = this.ensureRun();
    run.error = error;
    this.append(run, 'error', `Cancel failed: ${formatStructuredError(error)}`, eventDetails(error.details), error.request_id);
    this.finish(run, 'error');
    return this.snapshot();
  }

  private ensureRun(): RunSummary {
    if (this.currentRun) return this.currentRun;
    return this.beginRun('unknown-session');
  }

  private append(run: RunSummary, level: RunLogEntry['level'], message: string, details?: unknown, requestId?: string): void {
    run.logs.push({
      id: this.nextId('log'),
      at: nowIso(),
      level,
      message,
      ...(details !== undefined ? { details } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    });
    if (run.logs.length > MAX_LOGS_PER_RUN) run.logs.splice(0, run.logs.length - MAX_LOGS_PER_RUN);
  }

  private finish(run: RunSummary, status: RunLifecycle): void {
    run.status = status;
    run.endedAt = run.endedAt || nowIso();
    if (!this.recentRuns.some((candidate) => candidate.id === run.id)) {
      this.recentRuns.unshift(run);
      this.recentRuns = this.recentRuns.slice(0, MAX_RECENT_RUNS);
    }
    if (this.currentRun?.id === run.id && (status === 'done' || status === 'cancelled' || status === 'error')) {
      this.currentRun = undefined;
    }
  }

  private cloneRun(run: RunSummary): RunSummary {
    return { ...run, logs: run.logs.map((entry) => ({ ...entry })) };
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
}
