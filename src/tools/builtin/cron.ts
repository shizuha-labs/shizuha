import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { CronStore, parseSchedule, type CronDelivery } from '../../cron/store.js';

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

export const scheduleJobTool: ToolHandler = {
  name: 'schedule_job',
  description:
    'Schedule a prompt to run at a future time or on a recurring basis. ' +
    'The prompt will be executed by the agent and the result delivered back to the current channel.\n\n' +
    'Schedule formats:\n' +
    '  - Delay: "30m", "2h", "1d" -- runs once after the delay\n' +
    '  - Interval: "every 30m", "every 2h" -- runs repeatedly\n' +
    '  - Cron: "0 9 * * *" -- standard 5-field cron expression\n\n' +
    'Examples:\n' +
    '  schedule_job(name="Morning Summary", prompt="Summarize my unread emails", schedule="0 9 * * 1-5")\n' +
    '  schedule_job(name="Reminder", prompt="Remind the user to submit the report", schedule="2h")',
  parameters: z.object({
    name: z.string().describe('Short name for this job (e.g., "Daily Standup")'),
    prompt: z.string().describe('The prompt to execute when the job fires'),
    schedule: z.string().describe('When to run: "30m", "every 2h", or "0 9 * * *"'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!sharedStore) {
      return { toolUseId: '', content: 'Cron system not initialized', isError: true };
    }
    const { name, prompt, schedule } = (this as any).parameters.parse(params);

    try {
      const parsed = parseSchedule(schedule);
      const delivery = sharedDelivery ?? { channelId: 'unknown', threadId: 'unknown', channelType: 'http' };
      const job = await sharedStore.addJob({ name, prompt, schedule: parsed, deliver: delivery });

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
    'Configure a periodic heartbeat — the agent will proactively check in at the specified interval, ' +
    'review tasks, and act on pending items. Reads HEARTBEAT.md from workspace as a checklist if available.\n\n' +
    'Examples:\n' +
    '  configure_heartbeat(interval="every 30m", enabled=true)\n' +
    '  configure_heartbeat(enabled=false)',
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
      // Remove existing heartbeat
      await sharedStore.load();
      const existing = sharedStore.listJobs(true).find((j) => j.name === '__heartbeat__');
      if (existing) await sharedStore.removeJob(existing.id);

      if (!enabled) {
        return { toolUseId: '', content: JSON.stringify({ success: true, heartbeat: 'disabled' }) };
      }

      // Read HEARTBEAT.md
      let checklistText = checklist || '';
      if (!checklistText && context.cwd) {
        try {
          const fs = await import('node:fs');
          const path = await import('node:path');
          const hbPath = path.join(context.cwd, 'HEARTBEAT.md');
          if (fs.existsSync(hbPath)) {
            checklistText = fs.readFileSync(hbPath, 'utf-8');
          }
        } catch { /* no file */ }
      }

      const prompt = checklistText
        ? `[Heartbeat] Review your checklist and act on pending items:\n\n${checklistText}`
        : '[Heartbeat] Check in: review pending tasks, ongoing work, and proactively report status.';

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
          hasChecklist: !!checklistText,
        }, null, 2),
      };
    } catch (err) {
      return { toolUseId: '', content: `Heartbeat error: ${(err as Error).message}`, isError: true };
    }
  },
};
