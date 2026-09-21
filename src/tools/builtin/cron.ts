import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { CronStore, parseSchedule, HARD_INTERVAL_RUNAWAY_CAP, type CronDelivery } from '../../cron/store.js';
import { HEARTBEAT_TRIGGER } from '../../agent-base-instructions.js';

/** Shared CronStore instance -- set by AgentProcess during init */
let sharedStore: CronStore | null = null;
let sharedDelivery: CronDelivery | null = null;

/** Called by AgentProcess to inject the store and default delivery info */
export function setCronStore(store: CronStore, delivery?: CronDelivery): void {
  sharedStore = store;
  if (delivery) sharedDelivery = delivery;
}

/** Called by channel message handler to set delivery context for current message */
export function setCronDelivery(delivery: CronDelivery): void {
  sharedDelivery = delivery;
}

/**
 * Read the currently active (enabled) cron jobs from the shared store.
 * Returns null when the cron system is not initialized (e.g. interactive TUI
 * without a gateway). Used by the TUI tasks pane (SCLI-621).
 */
export function getCronJobs(): Array<{ id: string; name: string; schedule: string; nextRunAt: string }> | null {
  if (!sharedStore) return null;
  return sharedStore.listJobs(false).map((job) => ({
    id: job.id,
    name: job.name,
    schedule: job.schedule.display,
    nextRunAt: job.nextRunAt,
  }));
}


export const scheduleJobTool: ToolHandler = {
  name: 'schedule_job',
  description:
    'Schedule a prompt to run at a future time or on a recurring basis. ' +
    'The prompt will be executed by the agent and the result delivered back to the current channel.\n\n' +
    'FORBIDDEN: interval polls that watch CI, PRs, merge-on-green, or "until X happens". ' +
    'Those occupy the GLM seat and poison the eternal session (Aoi 2026-09-09: 380×10m curl ticks → 300k degraded). ' +
    'Hook the event (Forgejo webhook, Pulse transition, CI status check) instead. See skill context-poisoning.\n\n' +
    'Schedule formats:\n' +
    '  - Delay: "30m", "2h", "1d" -- runs once after the delay\n' +
    '  - Interval: "every 30m", "every 2h" -- bounded (max 50 ticks); not for PR/CI watches\n' +
    '  - Cron: "0 9 * * *" -- standard 5-field calendar expression (daily standup OK)\n\n' +
    'Examples:\n' +
    '  schedule_job(name="Morning Summary", prompt="Summarize my unread emails", schedule="0 9 * * 1-5")\n' +
    '  schedule_job(name="Reminder", prompt="Remind the user to submit the report", schedule="2h")',
  parameters: z.object({
    name: z.string().describe('Short name for this job (e.g., "Daily Standup")'),
    prompt: z.string().describe('The prompt to execute when the job fires'),
    schedule: z.string().describe('When to run: "30m", "every 2h", or "0 9 * * *"'),
    times: z.number().int().min(1).max(HARD_INTERVAL_RUNAWAY_CAP).optional()
      .describe(`Max runs for an interval job (default ${HARD_INTERVAL_RUNAWAY_CAP}, never forever). Omit for one-shot delays and calendar crons.`),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedStore) {
      return { toolUseId: '', content: 'Cron system not initialized', isError: true };
    }
    const { name, prompt, schedule, times } = (this as any).parameters.parse(params);

    try {
      const parsed = parseSchedule(schedule);
      const delivery = sharedDelivery ?? { channelId: 'unknown', threadId: 'unknown', channelType: 'http' };
      const job = await sharedStore.addJob({
        name,
        prompt,
        schedule: parsed,
        deliver: delivery,
        repeatTimes: times,
      });

      return {
        toolUseId: '',
        content: JSON.stringify({
          success: true,
          jobId: job.id,
          name: job.name,
          nextRunAt: job.nextRunAt,
          schedule: parsed.display,
          repeats: job.repeat.times === 1 ? 'once' : job.repeat.times === null ? 'forever' : `${job.repeat.times} times`,
        }, null, 2),
      };
    } catch (err) {
      return { toolUseId: '', content: `Schedule error: ${(err as Error).message}`, isError: true };
    }
  },
};

export const listJobsTool: ToolHandler = {
  name: 'list_jobs',
  description: 'List all scheduled cron jobs. Shows job ID, name, schedule, next run time, and status.',
  parameters: z.object({
    include_disabled: z.boolean().optional().default(false).describe('Include disabled/completed jobs'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedStore) {
      return { toolUseId: '', content: 'Cron system not initialized', isError: true };
    }
    const { include_disabled } = (this as any).parameters.parse(params);
    await sharedStore.load(); // Reload from disk

    const jobs = sharedStore.listJobs(include_disabled);
    if (jobs.length === 0) {
      return { toolUseId: '', content: 'No scheduled jobs.' };
    }

    const summary = jobs.map((j) => ({
      id: j.id,
      name: j.name,
      schedule: j.schedule.display,
      nextRunAt: j.nextRunAt,
      enabled: j.enabled,
      lastStatus: j.lastStatus ?? 'never run',
      kind: j.kind ?? 'job',
      loopKey: j.loop?.key,
      mode: j.loop?.mode,
      timesRun: j.repeat.completed,
      prompt: j.prompt.length > 80 ? j.prompt.slice(0, 77) + '...' : j.prompt,
    }));

    return { toolUseId: '', content: JSON.stringify(summary, null, 2) };
  },
};

export const removeJobTool: ToolHandler = {
  name: 'remove_job',
  description: 'Remove a scheduled cron job by its ID.',
  parameters: z.object({
    job_id: z.string().describe('The job ID to remove (from list_jobs)'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedStore) {
      return { toolUseId: '', content: 'Cron system not initialized', isError: true };
    }
    const { job_id } = (this as any).parameters.parse(params);

    const removed = await sharedStore.removeJob(job_id);
    if (!removed) {
      return { toolUseId: '', content: `Job "${job_id}" not found.`, isError: true };
    }
    return { toolUseId: '', content: `Job "${job_id}" removed.` };
  },
};

export const configureHeartbeatTool: ToolHandler = {
  name: 'configure_heartbeat',
  description:
    'Configure a periodic heartbeat interval. Do not disable it. Do not read HEARTBEAT.md — ' +
    'a heartbeat is a Pulse check-in, not a file task.\n\n' +
    'Example:\n' +
    '  configure_heartbeat(interval="every 30m", enabled=true)',
  parameters: z.object({
    enabled: z.boolean().describe('Enable or disable the heartbeat'),
    interval: z.string().optional().default('every 30m').describe('How often: "every 10m", "every 30m", "every 1h"'),
    checklist: z.string().optional().describe('Custom checklist (overrides HEARTBEAT.md)'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    if (!sharedStore) {
      return { toolUseId: '', content: 'Cron system not initialized', isError: true };
    }
    const { enabled, interval, checklist } = (this as any).parameters.parse(params);

    try {
      await sharedStore.load();
      const existing = sharedStore.listJobs(true).find((j) => j.name === '__heartbeat__');

      if (!enabled) {
        // Hiro 2026-09-15: GLM wrap-up called configure_heartbeat(enabled=false)
        // while looping on HEARTBEAT.md, then kept burning 115k GLM turns.
        // Fleet seats must not be able to turn the scheduler off.
        return {
          toolUseId: '',
          content: JSON.stringify({
            success: false,
            heartbeat: 'unchanged',
            error: 'Heartbeat cannot be disabled on this seat',
          }),
          isError: true,
        };
      }

      if (existing) await sharedStore.removeJob(existing.id);

      // Do not dump HEARTBEAT.md into the turn. GLM treated that essay as a
      // file-read task (Hiro: read HEARTBEAT.md, ls /home, "stuck in a loop")
      // instead of calling Pulse. Keep the same one-line nudge as idle beats.
      const prompt = HEARTBEAT_TRIGGER;

      const parsed = parseSchedule(interval);
      const delivery = sharedDelivery ?? { channelId: 'unknown', threadId: 'unknown', channelType: 'http' };
      const job = await sharedStore.addJob({ name: '__heartbeat__', prompt, schedule: parsed, deliver: delivery });

      return {
        toolUseId: '',
        content: JSON.stringify({
          success: true,
          heartbeat: 'enabled',
          interval: parsed.display,
          nextRunAt: job.nextRunAt,
          hasChecklist: Boolean(checklist),
        }, null, 2),
      };
    } catch (err) {
      return { toolUseId: '', content: `Heartbeat error: ${(err as Error).message}`, isError: true };
    }
  },
};
