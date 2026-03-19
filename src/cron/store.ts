import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  enabled: boolean;
  createdAt: string;    // ISO timestamp
  nextRunAt: string;    // ISO timestamp
  lastRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  repeat: { times: number | null; completed: number }; // null = forever
  deliver: CronDelivery;
}

export type CronSchedule =
  | { kind: 'delay'; ms: number; display: string }
  | { kind: 'interval'; ms: number; display: string }
  | { kind: 'cron'; expr: string; display: string };

export interface CronDelivery {
  channelId: string;
  threadId: string;
  channelType: string;
}

/**
 * Parse a human-friendly schedule string into a CronSchedule.
 *
 * Supports:
 *   - Relative delays: "30m", "2h", "1d", "45s"
 *   - Intervals: "every 30m", "every 2h", "every 1d"
 *   - Cron expressions: "0 9 * * *", "star-slash-30 * * * *"
 */
export function parseSchedule(input: string): CronSchedule {
  const trimmed = input.trim();

  // Interval: "every Xm/h/d/s"
  const intervalMatch = trimmed.match(/^every\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (intervalMatch) {
    const ms = parseDuration(parseInt(intervalMatch[1]!, 10), intervalMatch[2]!);
    return { kind: 'interval', ms, display: trimmed };
  }

  // Delay: "Xm/h/d/s" (without "every")
  const delayMatch = trimmed.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (delayMatch) {
    const ms = parseDuration(parseInt(delayMatch[1]!, 10), delayMatch[2]!);
    return { kind: 'delay', ms, display: trimmed };
  }

  // Cron expression: 5 fields (minute hour dom month dow)
  const cronMatch = trimmed.match(/^([\d*,/\-]+\s+){4}[\d*,/\-]+$/);
  if (cronMatch) {
    return { kind: 'cron', expr: trimmed, display: trimmed };
  }

  throw new Error(`Invalid schedule: "${trimmed}". Use "30m" (delay), "every 2h" (interval), or "0 9 * * *" (cron).`);
}

function parseDuration(value: number, unit: string): number {
  const raw = unit.toLowerCase();
  // Handle 's' directly before stripping trailing 's' (which would erase it)
  if (raw === 's') return value * 1000;
  const u = raw.replace(/s$/, '');
  switch (u) {
    case 'sec': case 'second': return value * 1000;
    case 'min': case 'minute': case 'm': return value * 60_000;
    case 'hr': case 'hour': case 'h': return value * 3_600_000;
    case 'day': case 'd': return value * 86_400_000;
    default: throw new Error(`Unknown time unit: ${unit}`);
  }
}

/** Compute the next run time from a schedule. Returns ISO string. */
export function computeNextRun(schedule: CronSchedule, fromDate?: Date): string {
  const from = fromDate ?? new Date();

  switch (schedule.kind) {
    case 'delay':
      return new Date(from.getTime() + schedule.ms).toISOString();
    case 'interval':
      return new Date(from.getTime() + schedule.ms).toISOString();
    case 'cron':
      return computeNextCronRun(schedule.expr, from);
    default:
      throw new Error('Unknown schedule kind');
  }
}

/** Simple cron field matching -- supports wildcard, N, N-M, step, comma lists. */
function computeNextCronRun(expr: string, from: Date): string {
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression: "${expr}" (need 5 fields)`);

  // Brute force: check each minute for the next 366 days
  const check = new Date(from);
  check.setSeconds(0, 0);
  check.setMinutes(check.getMinutes() + 1); // Start from next minute

  const limit = 366 * 24 * 60; // Max iterations
  for (let i = 0; i < limit; i++) {
    if (
      matchCronField(fields[0]!, check.getMinutes(), 0, 59) &&
      matchCronField(fields[1]!, check.getHours(), 0, 23) &&
      matchCronField(fields[2]!, check.getDate(), 1, 31) &&
      matchCronField(fields[3]!, check.getMonth() + 1, 1, 12) &&
      matchCronField(fields[4]!, check.getDay(), 0, 6)
    ) {
      return check.toISOString();
    }
    check.setMinutes(check.getMinutes() + 1);
  }

  throw new Error(`No matching time found for cron "${expr}" in the next year`);
}

function matchCronField(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (part === '*') return true;

    // Step: */N or N-M/N
    const stepMatch = part.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4]!, 10);
      const rangeStart = stepMatch[2] ? parseInt(stepMatch[2]!, 10) : min;
      const rangeEnd = stepMatch[3] ? parseInt(stepMatch[3]!, 10) : max;
      if (value >= rangeStart && value <= rangeEnd && (value - rangeStart) % step === 0) return true;
      continue;
    }

    // Range: N-M
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10);
      const hi = parseInt(rangeMatch[2]!, 10);
      if (value >= lo && value <= hi) return true;
      continue;
    }

    // Exact: N
    if (parseInt(part, 10) === value) return true;
  }
  return false;
}

/** Persistent JSON-file cron store */
export class CronStore {
  private filePath: string;
  private jobs: CronJob[] = [];

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'cron', 'jobs.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as { jobs?: CronJob[] };
      this.jobs = data.jobs ?? [];
    } catch {
      this.jobs = [];
    }
  }

  private async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = this.filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify({ jobs: this.jobs, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.filePath);
  }

  async addJob(opts: {
    name: string;
    prompt: string;
    schedule: CronSchedule;
    deliver: CronDelivery;
  }): Promise<CronJob> {
    const job: CronJob = {
      id: crypto.randomBytes(6).toString('hex'),
      name: opts.name,
      prompt: opts.prompt,
      schedule: opts.schedule,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: computeNextRun(opts.schedule),
      repeat: {
        times: opts.schedule.kind === 'delay' ? 1 : null,
        completed: 0,
      },
      deliver: opts.deliver,
    };
    this.jobs.push(job);
    await this.save();
    return job;
  }

  async removeJob(jobId: string): Promise<boolean> {
    const idx = this.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    this.jobs.splice(idx, 1);
    await this.save();
    return true;
  }

  listJobs(includeDisabled = false): CronJob[] {
    return includeDisabled ? [...this.jobs] : this.jobs.filter((j) => j.enabled);
  }

  getDueJobs(): CronJob[] {
    const now = new Date().toISOString();
    return this.jobs.filter((j) => j.enabled && j.nextRunAt <= now);
  }

  async markJobRun(jobId: string, status: 'ok' | 'error', error?: string): Promise<void> {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;

    job.lastRunAt = new Date().toISOString();
    job.lastStatus = status;
    job.lastError = error;
    job.repeat.completed++;

    // Check if completed
    if (job.repeat.times !== null && job.repeat.completed >= job.repeat.times) {
      job.enabled = false;
    } else {
      // Compute next run
      job.nextRunAt = computeNextRun(job.schedule);
    }
    await this.save();
  }

  getJob(jobId: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === jobId);
  }
}
