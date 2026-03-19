import type { CronStore } from './store.js';
import type { InboundMessage, ChannelType } from '../gateway/types.js';
import { logger } from '../utils/logger.js';

const TICK_INTERVAL_MS = 15_000; // Check every 15s (short delays need fast ticks)

export interface CronSchedulerOptions {
  store: CronStore;
  /** Submit a cron job as an inbox message — processed sequentially by the agent loop */
  submitToInbox: (msg: InboundMessage) => void;
}

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private store: CronStore;
  private submitToInbox: (msg: InboundMessage) => void;

  constructor(options: CronSchedulerOptions) {
    this.store = options.store;
    this.submitToInbox = options.submitToInbox;
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    // First tick after 30s (avoid blocking startup)
    setTimeout(() => {
      if (this.running) this.tick();
    }, 30_000);
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.timer.unref();
    logger.info({ intervalMs: TICK_INTERVAL_MS }, 'Cron scheduler started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      // Reload jobs from disk (another process may have added jobs)
      await this.store.load();
      const dueJobs = this.store.getDueJobs();
      if (dueJobs.length === 0) return;

      logger.info({ count: dueJobs.length }, 'Cron: submitting due jobs to inbox');
      for (const job of dueJobs) {
        this.enqueueJob(job.id);
      }
    } catch (err) {
      logger.error({ err }, 'Cron tick error');
    }
  }

  private enqueueJob(jobId: string): void {
    const job = this.store.getJob(jobId);
    if (!job) return;

    logger.info({ jobId: job.id, name: job.name }, 'Cron: submitting job to inbox');

    // Submit as an inbox message — the agent loop will process it
    // sequentially after any active turn finishes (no interleaving)
    this.submitToInbox({
      id: `cron-${jobId}-${Date.now()}`,
      channelId: job.deliver.channelId,
      channelType: (job.deliver.channelType ?? 'http') as ChannelType,
      threadId: `cron-${jobId}`,
      userId: 'cron-scheduler',
      userName: 'Cron',
      content: job.prompt,
      timestamp: Date.now(),
      source: 'cron',
      cronJobId: jobId,
      cronJobName: job.name,
    });
  }
}
