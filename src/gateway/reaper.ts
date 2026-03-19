/**
 * Maintenance Reaper — periodic cleanup of transient state.
 *
 * Runs inside AgentProcess on a timer. Cleans up:
 *   1. Microcompaction spill files older than 24h
 *   2. Delivery-queue failed/ entries older than 7 days
 *   3. Stale .tmp files in the delivery-queue directory
 *   4. Old interrupt checkpoints from SQLite (>7 days)
 *   5. SQLite VACUUM (every 24h)
 *
 * Design principles:
 *   - Best-effort: errors in any step don't block others
 *   - Low frequency: runs once per hour, not a hot path
 *   - No session deletion: eternal sessions are compacted, never reaped
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../utils/logger.js';

// ── Options ──

export interface ReaperOptions {
  /** How often to run (ms). Default: 3_600_000 (1 hour). */
  intervalMs?: number;
  /** Max age for microcompaction spill files (ms). Default: 86_400_000 (24h). */
  spillMaxAgeMs?: number;
  /** Max age for delivery-queue failed entries (ms). Default: 604_800_000 (7 days). */
  failedMaxAgeMs?: number;
  /** Max age for stale .tmp files in delivery queue (ms). Default: 3_600_000 (1h). */
  tmpMaxAgeMs?: number;
  /** Max age for interrupt checkpoints (ms). Default: 604_800_000 (7 days). */
  checkpointMaxAgeMs?: number;
  /** Interval between SQLite vacuums (ms). Default: 86_400_000 (24h). */
  vacuumIntervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 3_600_000;       // 1 hour
const DEFAULT_SPILL_MAX_AGE_MS = 86_400_000; // 24h
const DEFAULT_FAILED_MAX_AGE_MS = 604_800_000; // 7 days
const DEFAULT_TMP_MAX_AGE_MS = 3_600_000;    // 1h
const DEFAULT_CHECKPOINT_MAX_AGE_MS = 604_800_000; // 7 days
const DEFAULT_VACUUM_INTERVAL_MS = 86_400_000; // 24h

// ── ReaperStats ──

export interface ReaperStats {
  spillFilesRemoved: number;
  failedEntriesRemoved: number;
  tmpFilesRemoved: number;
  checkpointsRemoved: number;
  vacuumed: boolean;
}

// ── MaintenanceReaper ──

export class MaintenanceReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastVacuumAt = 0;

  // Resolved options
  private intervalMs: number;
  private spillMaxAgeMs: number;
  private failedMaxAgeMs: number;
  private tmpMaxAgeMs: number;
  private checkpointMaxAgeMs: number;
  private vacuumIntervalMs: number;

  // Paths
  private spillDir: string;
  private failedDir: string | null;
  private queueDir: string | null;

  // Dependencies
  private store: any; // StateStore — typed as any to avoid circular imports

  constructor(
    opts?: ReaperOptions,
    deps?: {
      store?: any;
      failedDir?: string;
      queueDir?: string;
    },
  ) {
    this.intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.spillMaxAgeMs = opts?.spillMaxAgeMs ?? DEFAULT_SPILL_MAX_AGE_MS;
    this.failedMaxAgeMs = opts?.failedMaxAgeMs ?? DEFAULT_FAILED_MAX_AGE_MS;
    this.tmpMaxAgeMs = opts?.tmpMaxAgeMs ?? DEFAULT_TMP_MAX_AGE_MS;
    this.checkpointMaxAgeMs = opts?.checkpointMaxAgeMs ?? DEFAULT_CHECKPOINT_MAX_AGE_MS;
    this.vacuumIntervalMs = opts?.vacuumIntervalMs ?? DEFAULT_VACUUM_INTERVAL_MS;

    this.spillDir = path.join(os.tmpdir(), 'shizuha-microcompact');
    this.failedDir = deps?.failedDir ?? null;
    this.queueDir = deps?.queueDir ?? null;
    this.store = deps?.store ?? null;
  }

  /** Start the periodic reaper loop. */
  start(): void {
    if (this.timer) return;

    // Run first sweep after a short delay (don't block startup)
    setTimeout(() => this.sweep().catch(() => {}), 30_000);

    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        logger.debug({ err }, 'Reaper: sweep error');
      });
    }, this.intervalMs);

    logger.info({ intervalMs: this.intervalMs }, 'Maintenance reaper started');
  }

  /** Stop the reaper loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single sweep — called by the timer or manually. */
  async sweep(): Promise<ReaperStats> {
    const stats: ReaperStats = {
      spillFilesRemoved: 0,
      failedEntriesRemoved: 0,
      tmpFilesRemoved: 0,
      checkpointsRemoved: 0,
      vacuumed: false,
    };

    const now = Date.now();

    // 1. Clean microcompaction spill files
    stats.spillFilesRemoved = await this.cleanSpillFiles(now);

    // 2. Clean delivery-queue failed/ entries
    stats.failedEntriesRemoved = await this.cleanFailedEntries(now);

    // 3. Clean stale .tmp files in delivery queue
    stats.tmpFilesRemoved = await this.cleanTmpFiles(now);

    // 4. Prune old interrupt checkpoints
    stats.checkpointsRemoved = await this.pruneCheckpoints(now);

    // 5. Vacuum SQLite
    stats.vacuumed = await this.maybeVacuum(now);

    const total = stats.spillFilesRemoved + stats.failedEntriesRemoved +
      stats.tmpFilesRemoved + stats.checkpointsRemoved;

    if (total > 0 || stats.vacuumed) {
      logger.info(stats, 'Reaper: sweep complete');
    }

    return stats;
  }

  // ── Cleanup tasks ──

  /** Remove microcompaction spill files older than spillMaxAgeMs. */
  private async cleanSpillFiles(now: number): Promise<number> {
    let removed = 0;

    try {
      const files = await fs.readdir(this.spillDir);
      for (const file of files) {
        if (!file.endsWith('.txt')) continue;
        const filePath = path.join(this.spillDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > this.spillMaxAgeMs) {
            await fs.unlink(filePath);
            removed++;
          }
        } catch {
          // File may have been removed concurrently
        }
      }
    } catch {
      // Spill dir may not exist yet — that's fine
    }

    return removed;
  }

  /** Remove delivery-queue failed/ entries older than failedMaxAgeMs. */
  private async cleanFailedEntries(now: number): Promise<number> {
    if (!this.failedDir) return 0;
    let removed = 0;

    try {
      const files = await fs.readdir(this.failedDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.failedDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > this.failedMaxAgeMs) {
            await fs.unlink(filePath);
            removed++;
          }
        } catch {
          // Concurrent removal — safe to ignore
        }
      }
    } catch {
      // Failed dir may not exist
    }

    return removed;
  }

  /** Remove stale .tmp files from the delivery queue directory. */
  private async cleanTmpFiles(now: number): Promise<number> {
    if (!this.queueDir) return 0;
    let removed = 0;

    try {
      const files = await fs.readdir(this.queueDir);
      for (const file of files) {
        if (!file.endsWith('.tmp')) continue;
        const filePath = path.join(this.queueDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > this.tmpMaxAgeMs) {
            await fs.unlink(filePath);
            removed++;
          }
        } catch {
          // Concurrent removal
        }
      }
    } catch {
      // Queue dir may not exist
    }

    return removed;
  }

  /** Remove old interrupt checkpoints from SQLite. */
  private async pruneCheckpoints(now: number): Promise<number> {
    if (!this.store) return 0;

    try {
      const cutoff = now - this.checkpointMaxAgeMs;
      return this.store.pruneOldCheckpoints(cutoff) ?? 0;
    } catch {
      return 0;
    }
  }

  /** Run VACUUM if enough time has passed since last one. */
  private async maybeVacuum(now: number): Promise<boolean> {
    if (!this.store) return false;
    if (now - this.lastVacuumAt < this.vacuumIntervalMs) return false;

    try {
      this.store.vacuum();
      this.lastVacuumAt = now;
      return true;
    } catch {
      return false;
    }
  }
}
