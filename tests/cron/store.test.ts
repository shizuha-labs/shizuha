import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  CronStore,
  parseSchedule,
  computeNextRun,
  type CronSchedule,
  type CronDelivery,
  type CronJob,
} from '../../src/cron/store.js';
import { CronScheduler, type CronSchedulerOptions } from '../../src/cron/scheduler.js';

// ── Helpers ──

function tmpDir(): string {
  return path.join(os.tmpdir(), `shizuha-cron-test-${crypto.randomUUID()}`);
}

function delivery(): CronDelivery {
  return { channelId: 'ch-1', threadId: 'th-1', channelType: 'http' };
}

// ── parseSchedule ──

describe('parseSchedule', () => {
  // --- Delay schedules ---
  describe('delay schedules', () => {
    it('parses "sec" unit (10sec)', () => {
      const s = parseSchedule('10sec');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(10_000);
    });

    it('parses "seconds" (5seconds)', () => {
      const s = parseSchedule('5seconds');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(5_000);
    });

    it('parses bare "s" unit as seconds (30s)', () => {
      const s = parseSchedule('30s');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(30_000);
    });

    it('parses minutes (30m)', () => {
      const s = parseSchedule('30m');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(30 * 60_000);
    });

    it('parses "min" unit', () => {
      const s = parseSchedule('15min');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(15 * 60_000);
    });

    it('parses "minutes"', () => {
      const s = parseSchedule('45minutes');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(45 * 60_000);
    });

    it('parses hours (2h)', () => {
      const s = parseSchedule('2h');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(2 * 3_600_000);
    });

    it('parses "hr" unit', () => {
      const s = parseSchedule('3hr');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(3 * 3_600_000);
    });

    it('parses "hours"', () => {
      const s = parseSchedule('1hours');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(3_600_000);
    });

    it('parses days (1d)', () => {
      const s = parseSchedule('1d');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(86_400_000);
    });

    it('parses "days"', () => {
      const s = parseSchedule('7days');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(7 * 86_400_000);
    });

    it('trims whitespace', () => {
      const s = parseSchedule('  30m  ');
      expect(s.kind).toBe('delay');
      expect((s as any).ms).toBe(30 * 60_000);
    });

    it('preserves original display string', () => {
      const s = parseSchedule('  30m  ');
      expect((s as any).display).toBe('30m');
    });
  });

  // --- Interval schedules ---
  describe('interval schedules', () => {
    it('parses "every 30m"', () => {
      const s = parseSchedule('every 30m');
      expect(s.kind).toBe('interval');
      expect((s as any).ms).toBe(30 * 60_000);
    });

    it('parses "every 2h"', () => {
      const s = parseSchedule('every 2h');
      expect(s.kind).toBe('interval');
      expect((s as any).ms).toBe(2 * 3_600_000);
    });

    it('parses "every 1d"', () => {
      const s = parseSchedule('every 1d');
      expect(s.kind).toBe('interval');
      expect((s as any).ms).toBe(86_400_000);
    });

    it('parses bare "s" unit in interval (every 45s)', () => {
      const s = parseSchedule('every 45s');
      expect(s.kind).toBe('interval');
      expect((s as any).ms).toBe(45_000);
    });

    it('parses "every 10sec"', () => {
      const s = parseSchedule('every 10sec');
      expect(s.kind).toBe('interval');
      expect((s as any).ms).toBe(10_000);
    });

    it('is case-insensitive', () => {
      const s = parseSchedule('Every 10M');
      expect(s.kind).toBe('interval');
      expect((s as any).ms).toBe(10 * 60_000);
    });

    it('preserves display string', () => {
      const s = parseSchedule('every 5h');
      expect((s as any).display).toBe('every 5h');
    });
  });

  // --- Cron expressions ---
  describe('cron expressions', () => {
    it('parses "0 9 * * *" (daily at 9am)', () => {
      const s = parseSchedule('0 9 * * *');
      expect(s.kind).toBe('cron');
      expect((s as any).expr).toBe('0 9 * * *');
    });

    it('parses "*/15 * * * *" (every 15 min)', () => {
      const s = parseSchedule('*/15 * * * *');
      expect(s.kind).toBe('cron');
      expect((s as any).expr).toBe('*/15 * * * *');
    });

    it('parses "0 0 1 * *" (first of every month)', () => {
      const s = parseSchedule('0 0 1 * *');
      expect(s.kind).toBe('cron');
    });

    it('parses cron with ranges "0 9-17 * * 1-5"', () => {
      const s = parseSchedule('0 9-17 * * 1-5');
      expect(s.kind).toBe('cron');
    });

    it('parses cron with comma lists "0,30 * * * *"', () => {
      const s = parseSchedule('0,30 * * * *');
      expect(s.kind).toBe('cron');
    });

    it('preserves display for cron', () => {
      const s = parseSchedule('0 9 * * *');
      expect((s as any).display).toBe('0 9 * * *');
    });
  });

  // --- Invalid inputs ---
  describe('invalid inputs', () => {
    it('throws on empty string', () => {
      expect(() => parseSchedule('')).toThrow('Invalid schedule');
    });

    it('throws on random text', () => {
      expect(() => parseSchedule('tomorrow at noon')).toThrow('Invalid schedule');
    });

    it('throws on partial cron (4 fields)', () => {
      expect(() => parseSchedule('0 9 * *')).toThrow('Invalid schedule');
    });

    it('throws on cron with 6 fields', () => {
      expect(() => parseSchedule('0 0 9 * * *')).toThrow('Invalid schedule');
    });
  });
});

// ── computeNextRun ──

describe('computeNextRun', () => {
  it('computes delay from a fixed date', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const schedule: CronSchedule = { kind: 'delay', ms: 60_000, display: '1m' };
    const next = computeNextRun(schedule, from);
    expect(next).toBe('2026-01-01T00:01:00.000Z');
  });

  it('computes interval from a fixed date', () => {
    const from = new Date('2026-01-01T12:00:00Z');
    const schedule: CronSchedule = { kind: 'interval', ms: 3_600_000, display: 'every 1h' };
    const next = computeNextRun(schedule, from);
    expect(next).toBe('2026-01-01T13:00:00.000Z');
  });

  it('computes next cron run for "0 9 * * *" (daily 9am local)', () => {
    // computeNextCronRun uses local time methods (getHours, getMinutes, etc.)
    // so we construct a "from" date in local time where 8:00 local has not yet passed 9am
    const from = new Date(2026, 0, 1, 8, 0, 0, 0); // Jan 1, 2026 8:00 local
    const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' };
    const next = computeNextRun(schedule, from);
    const nextDate = new Date(next);
    // Check in local time since the cron engine operates in local time
    expect(nextDate.getHours()).toBe(9);
    expect(nextDate.getMinutes()).toBe(0);
    expect(nextDate.getDate()).toBe(1);
  });

  it('computes next cron run wrapping to next day', () => {
    // From 10:00 local on Jan 1 — 9am already passed, so next is Jan 2 at 9:00 local
    const from = new Date(2026, 0, 1, 10, 0, 0, 0); // Jan 1, 2026 10:00 local
    const schedule: CronSchedule = { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' };
    const next = computeNextRun(schedule, from);
    const nextDate = new Date(next);
    expect(nextDate.getHours()).toBe(9);
    expect(nextDate.getMinutes()).toBe(0);
    expect(nextDate.getDate()).toBe(2);
  });

  it('computes next cron run for "*/15 * * * *" (every 15 min)', () => {
    const from = new Date('2026-01-01T08:03:00Z');
    const schedule: CronSchedule = { kind: 'cron', expr: '*/15 * * * *', display: '*/15 * * * *' };
    const next = computeNextRun(schedule, from);
    const nextDate = new Date(next);
    expect(nextDate.getUTCMinutes()).toBe(15);
    expect(nextDate.getUTCHours()).toBe(8);
  });

  it('computes next cron for step starting at 0 when at 14:59', () => {
    // At 14:59, next */15 should be 15:00
    const from = new Date('2026-01-01T14:59:00Z');
    const schedule: CronSchedule = { kind: 'cron', expr: '*/15 * * * *', display: '*/15 * * * *' };
    const next = computeNextRun(schedule, from);
    const nextDate = new Date(next);
    expect(nextDate.getUTCMinutes()).toBe(0);
    expect(nextDate.getUTCHours()).toBe(15);
  });

  it('computes next run using current time when no fromDate given', () => {
    const schedule: CronSchedule = { kind: 'delay', ms: 60_000, display: '1m' };
    const before = Date.now();
    const next = computeNextRun(schedule);
    const after = Date.now();
    const nextMs = new Date(next).getTime();
    // Should be roughly now + 60s
    expect(nextMs).toBeGreaterThanOrEqual(before + 60_000 - 1);
    expect(nextMs).toBeLessThanOrEqual(after + 60_000 + 1);
  });

  it('throws on invalid cron with wrong field count', () => {
    const schedule: CronSchedule = { kind: 'cron', expr: '0 9 *', display: 'bad' };
    expect(() => computeNextRun(schedule)).toThrow('need 5 fields');
  });
});

// ── CronStore ──

describe('CronStore', () => {
  let stateDir: string;
  let store: CronStore;

  beforeEach(async () => {
    stateDir = tmpDir();
    store = new CronStore(stateDir);
    await store.load();
  });

  afterEach(async () => {
    try {
      await fs.rm(stateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('CRUD operations', () => {
    it('starts with empty job list', () => {
      expect(store.listJobs()).toEqual([]);
    });

    it('adds a job and returns it', async () => {
      const schedule = parseSchedule('30m');
      const job = await store.addJob({
        name: 'Test Job',
        prompt: 'Say hello',
        schedule,
        deliver: delivery(),
      });

      expect(job.id).toBeDefined();
      expect(job.id).toHaveLength(12); // 6 random bytes = 12 hex chars
      expect(job.name).toBe('Test Job');
      expect(job.prompt).toBe('Say hello');
      expect(job.enabled).toBe(true);
      expect(job.schedule).toEqual(schedule);
      expect(job.createdAt).toBeDefined();
      expect(job.nextRunAt).toBeDefined();
    });

    it('getJob returns the added job', async () => {
      const job = await store.addJob({
        name: 'My Job',
        prompt: 'Do stuff',
        schedule: parseSchedule('1h'),
        deliver: delivery(),
      });
      const found = store.getJob(job.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('My Job');
    });

    it('getJob returns undefined for non-existent ID', () => {
      expect(store.getJob('nonexistent')).toBeUndefined();
    });

    it('lists multiple jobs', async () => {
      await store.addJob({ name: 'A', prompt: 'a', schedule: parseSchedule('1h'), deliver: delivery() });
      await store.addJob({ name: 'B', prompt: 'b', schedule: parseSchedule('2h'), deliver: delivery() });
      await store.addJob({ name: 'C', prompt: 'c', schedule: parseSchedule('3h'), deliver: delivery() });

      const jobs = store.listJobs();
      expect(jobs).toHaveLength(3);
      expect(jobs.map((j) => j.name)).toEqual(['A', 'B', 'C']);
    });

    it('listJobs returns a copy (not internal reference)', async () => {
      await store.addJob({ name: 'X', prompt: 'x', schedule: parseSchedule('1h'), deliver: delivery() });
      const list1 = store.listJobs();
      const list2 = store.listJobs();
      expect(list1).not.toBe(list2);
    });

    it('removes a job by ID', async () => {
      const job = await store.addJob({
        name: 'To Remove',
        prompt: 'remove me',
        schedule: parseSchedule('1h'),
        deliver: delivery(),
      });
      const removed = await store.removeJob(job.id);
      expect(removed).toBe(true);
      expect(store.listJobs()).toHaveLength(0);
      expect(store.getJob(job.id)).toBeUndefined();
    });

    it('removeJob returns false for non-existent ID', async () => {
      const removed = await store.removeJob('nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('schedule-based repeat behavior', () => {
    it('delay jobs get repeat.times = 1', async () => {
      const job = await store.addJob({
        name: 'Once',
        prompt: 'once',
        schedule: parseSchedule('30m'),
        deliver: delivery(),
      });
      expect(job.repeat.times).toBe(1);
      expect(job.repeat.completed).toBe(0);
    });

    it('interval jobs get repeat.times = null (infinite)', async () => {
      const job = await store.addJob({
        name: 'Repeat',
        prompt: 'repeat',
        schedule: parseSchedule('every 30m'),
        deliver: delivery(),
      });
      expect(job.repeat.times).toBeNull();
      expect(job.repeat.completed).toBe(0);
    });

    it('cron jobs get repeat.times = null (infinite)', async () => {
      const job = await store.addJob({
        name: 'Cron',
        prompt: 'cron',
        schedule: parseSchedule('0 9 * * *'),
        deliver: delivery(),
      });
      expect(job.repeat.times).toBeNull();
    });
  });

  describe('markJobRun', () => {
    it('marks a job as completed and updates status', async () => {
      const job = await store.addJob({
        name: 'Run Me',
        prompt: 'run',
        schedule: parseSchedule('every 1h'),
        deliver: delivery(),
      });

      await store.markJobRun(job.id, 'ok');

      const updated = store.getJob(job.id)!;
      expect(updated.lastStatus).toBe('ok');
      expect(updated.lastRunAt).toBeDefined();
      expect(updated.repeat.completed).toBe(1);
      expect(updated.enabled).toBe(true); // infinite repeat, still enabled
    });

    it('marks error status with error message', async () => {
      const job = await store.addJob({
        name: 'Fail',
        prompt: 'fail',
        schedule: parseSchedule('every 1h'),
        deliver: delivery(),
      });

      await store.markJobRun(job.id, 'error', 'Something went wrong');

      const updated = store.getJob(job.id)!;
      expect(updated.lastStatus).toBe('error');
      expect(updated.lastError).toBe('Something went wrong');
      expect(updated.repeat.completed).toBe(1);
    });

    it('disables a delay job after single completion', async () => {
      const job = await store.addJob({
        name: 'One-shot',
        prompt: 'once',
        schedule: parseSchedule('30m'),
        deliver: delivery(),
      });
      expect(job.repeat.times).toBe(1);

      await store.markJobRun(job.id, 'ok');

      const updated = store.getJob(job.id)!;
      expect(updated.enabled).toBe(false); // disabled after 1 completion
      expect(updated.repeat.completed).toBe(1);
    });

    it('updates nextRunAt for interval jobs', async () => {
      const job = await store.addJob({
        name: 'Interval',
        prompt: 'repeat',
        schedule: parseSchedule('every 1h'),
        deliver: delivery(),
      });
      const originalNextRun = job.nextRunAt;

      await store.markJobRun(job.id, 'ok');

      const updated = store.getJob(job.id)!;
      // nextRunAt should be refreshed (different from original since time has passed)
      expect(updated.nextRunAt).toBeDefined();
      // The new nextRunAt should be in the future
      expect(new Date(updated.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 1000);
    });

    it('silently ignores non-existent job IDs', async () => {
      // Should not throw
      await store.markJobRun('nonexistent', 'ok');
    });
  });

  describe('getDueJobs', () => {
    it('returns empty when no jobs are due', async () => {
      await store.addJob({
        name: 'Future',
        prompt: 'later',
        schedule: parseSchedule('every 24h'), // nextRunAt is ~24h from now
        deliver: delivery(),
      });
      expect(store.getDueJobs()).toEqual([]);
    });

    it('returns jobs whose nextRunAt is in the past', async () => {
      const job = await store.addJob({
        name: 'Due',
        prompt: 'now',
        schedule: parseSchedule('every 1h'),
        deliver: delivery(),
      });

      // Manually set nextRunAt to the past
      (job as any).nextRunAt = new Date(Date.now() - 60_000).toISOString();

      const due = store.getDueJobs();
      expect(due).toHaveLength(1);
      expect(due[0]!.id).toBe(job.id);
    });

    it('excludes disabled jobs', async () => {
      const job = await store.addJob({
        name: 'Disabled',
        prompt: 'skip',
        schedule: parseSchedule('every 1h'),
        deliver: delivery(),
      });

      // Manually set to past and disable
      (job as any).nextRunAt = new Date(Date.now() - 60_000).toISOString();
      (job as any).enabled = false;

      expect(store.getDueJobs()).toHaveLength(0);
    });
  });

  describe('listJobs with includeDisabled', () => {
    it('excludes disabled jobs by default', async () => {
      const job = await store.addJob({
        name: 'One-shot',
        prompt: 'once',
        schedule: parseSchedule('1m'),
        deliver: delivery(),
      });
      await store.markJobRun(job.id, 'ok'); // disables it

      expect(store.listJobs()).toHaveLength(0);
      expect(store.listJobs(true)).toHaveLength(1);
    });

    it('includes disabled jobs when flag is true', async () => {
      const job = await store.addJob({
        name: 'Disabled',
        prompt: 'done',
        schedule: parseSchedule('1m'),
        deliver: delivery(),
      });
      await store.markJobRun(job.id, 'ok');

      const all = store.listJobs(true);
      expect(all).toHaveLength(1);
      expect(all[0]!.enabled).toBe(false);
    });
  });

  describe('persistence (save/load cycle)', () => {
    it('persists jobs to disk and loads them back', async () => {
      await store.addJob({ name: 'Persist A', prompt: 'a', schedule: parseSchedule('1h'), deliver: delivery() });
      await store.addJob({ name: 'Persist B', prompt: 'b', schedule: parseSchedule('every 2h'), deliver: delivery() });

      // Create a new store pointing at the same directory
      const store2 = new CronStore(stateDir);
      await store2.load();

      const jobs = store2.listJobs(true);
      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.name)).toEqual(['Persist A', 'Persist B']);
    });

    it('atomic save uses tmp + rename', async () => {
      await store.addJob({ name: 'Atomic', prompt: 'atomic', schedule: parseSchedule('1h'), deliver: delivery() });

      // Verify the jobs.json file exists (not .tmp)
      const filePath = path.join(stateDir, 'cron', 'jobs.json');
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);

      // Verify .tmp file is cleaned up (renamed away)
      const tmpExists = await fs.stat(filePath + '.tmp').catch(() => null);
      expect(tmpExists).toBeNull();
    });

    it('creates directory structure if it does not exist', async () => {
      const freshDir = tmpDir();
      const freshStore = new CronStore(freshDir);
      await freshStore.load(); // empty, no dir yet

      await freshStore.addJob({ name: 'First', prompt: 'first', schedule: parseSchedule('1h'), deliver: delivery() });

      const filePath = path.join(freshDir, 'cron', 'jobs.json');
      const stat = await fs.stat(filePath);
      expect(stat.isFile()).toBe(true);

      await fs.rm(freshDir, { recursive: true, force: true });
    });

    it('load handles missing file gracefully (empty store)', async () => {
      const freshDir = tmpDir();
      const freshStore = new CronStore(freshDir);
      await freshStore.load();
      expect(freshStore.listJobs()).toEqual([]);
      await fs.rm(freshDir, { recursive: true, force: true }).catch(() => {});
    });

    it('load handles corrupt JSON gracefully', async () => {
      const cronDir = path.join(stateDir, 'cron');
      await fs.mkdir(cronDir, { recursive: true });
      await fs.writeFile(path.join(cronDir, 'jobs.json'), 'NOT VALID JSON', 'utf-8');

      const freshStore = new CronStore(stateDir);
      await freshStore.load();
      expect(freshStore.listJobs()).toEqual([]);
    });
  });
});

// ── CronScheduler ──

describe('CronScheduler', () => {
  let stateDir: string;
  let store: CronStore;

  beforeEach(async () => {
    stateDir = tmpDir();
    store = new CronStore(stateDir);
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('tick submits due jobs to inbox', async () => {
    const job = await store.addJob({
      name: 'Tick Test',
      prompt: 'What time is it?',
      schedule: parseSchedule('every 1h'),
      deliver: delivery(),
    });
    vi.spyOn(store, 'getDueJobs').mockReturnValue([job]);

    const submitToInbox = vi.fn();
    const scheduler = new CronScheduler({ store, submitToInbox });

    await (scheduler as any).tick();

    // Should submit an inbox message with cron metadata
    expect(submitToInbox).toHaveBeenCalledTimes(1);
    const msg = submitToInbox.mock.calls[0]![0];
    expect(msg.content).toBe('What time is it?');
    expect(msg.source).toBe('cron');
    expect(msg.cronJobId).toBe(job.id);
    expect(msg.cronJobName).toBe('Tick Test');
    expect(msg.channelId).toBe('ch-1');
    expect(msg.userId).toBe('cron-scheduler');
  });

  it('tick does nothing when no jobs are due', async () => {
    await store.addJob({
      name: 'Not Due',
      prompt: 'later',
      schedule: parseSchedule('every 24h'),
      deliver: delivery(),
    });

    const submitToInbox = vi.fn();
    const scheduler = new CronScheduler({ store, submitToInbox });
    await (scheduler as any).tick();

    expect(submitToInbox).not.toHaveBeenCalled();
  });

  it('tick submits job even when channel is missing (inbox handles delivery)', async () => {
    const job = await store.addJob({
      name: 'No Channel',
      prompt: 'orphan',
      schedule: parseSchedule('every 1h'),
      deliver: delivery(),
    });
    vi.spyOn(store, 'getDueJobs').mockReturnValue([job]);

    const submitToInbox = vi.fn();
    const scheduler = new CronScheduler({ store, submitToInbox });
    await (scheduler as any).tick();

    // Should still submit — the agent loop handles missing channels
    expect(submitToInbox).toHaveBeenCalledTimes(1);
    expect(submitToInbox.mock.calls[0]![0].source).toBe('cron');
  });

  it('start and stop manage timer lifecycle', () => {
    vi.useFakeTimers();

    const submitToInbox = vi.fn();
    const scheduler = new CronScheduler({ store, submitToInbox });

    scheduler.start();
    // Second start should be a no-op (timer already set)
    scheduler.start();

    scheduler.stop();
    // After stop, internal timer should be cleared
    expect((scheduler as any).timer).toBeNull();
    expect((scheduler as any).running).toBe(false);

    vi.useRealTimers();
  });

  it('tick reloads store from disk before checking due jobs', async () => {
    const loadSpy = vi.spyOn(store, 'load');

    const submitToInbox = vi.fn();
    const scheduler = new CronScheduler({ store, submitToInbox });

    await (scheduler as any).tick();

    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('tick handles store.load errors gracefully', async () => {
    vi.spyOn(store, 'load').mockRejectedValue(new Error('disk error'));

    const submitToInbox = vi.fn();
    const scheduler = new CronScheduler({ store, submitToInbox });

    // Should not throw
    await (scheduler as any).tick();
    expect(submitToInbox).not.toHaveBeenCalled();
  });

  it('tick submits multiple due jobs in order', async () => {
    const job1 = await store.addJob({
      name: 'Job 1',
      prompt: 'first',
      schedule: parseSchedule('every 1h'),
      deliver: delivery(),
    });
    const job2 = await store.addJob({
      name: 'Job 2',
      prompt: 'second',
      schedule: parseSchedule('every 1h'),
      deliver: delivery(),
    });
    vi.spyOn(store, 'getDueJobs').mockReturnValue([job1, job2]);

    const submitToInbox = vi.fn();
    const scheduler = new CronScheduler({ store, submitToInbox });
    await (scheduler as any).tick();

    expect(submitToInbox).toHaveBeenCalledTimes(2);
    expect(submitToInbox.mock.calls[0]![0].cronJobName).toBe('Job 1');
    expect(submitToInbox.mock.calls[1]![0].cronJobName).toBe('Job 2');
  });
});
