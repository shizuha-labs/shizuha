/**
 * Disk-backed Delivery Queue — crash-safe outbound message delivery.
 *
 * Modeled after OpenClaw's delivery-queue: a single unified queue directory
 * where each pending delivery is a JSON file. Survives process restarts.
 *
 * Flow:
 *   1. Channel calls enqueue() before sending → persisted to disk
 *   2. Channel sends the message → on success calls ack() → entry deleted
 *   3. On failure → failDelivery() increments retryCount
 *   4. On restart → recoverPending() replays all entries with backoff
 *
 * Two-phase ack (crash-safe):
 *   Phase 1: rename {id}.json → {id}.delivered  (atomic on local FS)
 *   Phase 2: unlink {id}.delivered
 *   If crash between phases, next loadPending() cleans up markers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

// ── Types ──

export interface DeliveryEntry {
  /** UUID for this delivery */
  id: string;
  /** Target channel type */
  channel: string;
  /** Recipient identifier (phone number, chat ID, WS thread, etc.) */
  to: string;
  /** The message payload to deliver */
  payload: unknown;
  /** When the entry was first enqueued (epoch ms) */
  enqueuedAt: number;
  /** Number of delivery attempts so far */
  retryCount: number;
  /** Timestamp of last attempt (epoch ms) */
  lastAttemptAt?: number;
  /** Error from last failed attempt */
  lastError?: string;
}

export type DeliveryHandler = (entry: DeliveryEntry) => Promise<void>;

// ── Options ──

export interface DeliveryQueueOptions {
  /** Max delivery attempts before moving to failed/. Default: 5. */
  maxRetries?: number;
  /** Backoff delays in ms, indexed by retryCount. Default: [0, 5s, 25s, 2min, 10min]. */
  backoffMs?: number[];
  /** Cap for backoff when retryCount exceeds the array length. Default: 600_000 (10min). */
  backoffCapMs?: number;
  /** Entries older than this (ms) are moved to failed/ regardless of retry count. Default: 86_400_000 (24h). */
  staleTtlMs?: number;
  /** Max time to spend on recovery during startup (ms). Default: 60_000 (60s). */
  maxRecoveryMs?: number;
  /** Background retry loop interval (ms). Default: 10_000 (10s). */
  retryLoopIntervalMs?: number;
}

// ── Defaults ──

const DEFAULT_MAX_RETRIES = 5;

const DEFAULT_BACKOFF_MS = [
  0,        // retry 0: immediate (first attempt)
  5_000,    // retry 1: 5s
  25_000,   // retry 2: 25s
  120_000,  // retry 3: 2min
  600_000,  // retry 4: 10min
];
const DEFAULT_BACKOFF_CAP_MS = 600_000; // 10min max
const DEFAULT_STALE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_RECOVERY_MS = 60_000; // 60s
const DEFAULT_RETRY_LOOP_INTERVAL_MS = 10_000; // 10s

/** Patterns indicating permanent delivery errors (don't retry). */
const PERMANENT_ERROR_PATTERNS = [
  'user not found',
  'chat not found',
  'bot was blocked',
  'bot was kicked',
  'chat_id is empty',
  'recipient is not valid',
  'invalid phone number',
  'number is not registered',
  'outbound not configured',
  'message is too long',
  '403',         // WhatsApp/Telegram forbidden
  'deregistered', // WhatsApp deregistered user
];

// ── Helpers ──

function computeBackoffMs(retryCount: number, backoffMs: number[], backoffCapMs: number): number {
  if (retryCount <= 0) return 0;
  return backoffMs[retryCount] ?? backoffCapMs;
}

function isPermanentError(error: string): boolean {
  const lower = error.toLowerCase();
  return PERMANENT_ERROR_PATTERNS.some((p) => lower.includes(p));
}

// ── DeliveryQueue ──

export class DeliveryQueue {
  private queueDir: string;
  private failedDir: string;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private handlers = new Map<string, DeliveryHandler>();

  // Resolved options
  private maxRetries: number;
  private backoffMs: number[];
  private backoffCapMs: number;
  private staleTtlMs: number;
  private maxRecoveryMs: number;
  private retryLoopIntervalMs: number;

  constructor(stateDir: string, opts?: DeliveryQueueOptions) {
    this.queueDir = path.join(stateDir, 'delivery-queue');
    this.failedDir = path.join(stateDir, 'delivery-queue', 'failed');

    this.maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.backoffCapMs = opts?.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.staleTtlMs = opts?.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    this.maxRecoveryMs = opts?.maxRecoveryMs ?? DEFAULT_MAX_RECOVERY_MS;
    this.retryLoopIntervalMs = opts?.retryLoopIntervalMs ?? DEFAULT_RETRY_LOOP_INTERVAL_MS;
  }

  /** Create queue directories if they don't exist. */
  async init(): Promise<void> {
    await fs.mkdir(this.queueDir, { recursive: true });
    await fs.mkdir(this.failedDir, { recursive: true });
  }

  /** Register a delivery handler for a channel type. */
  registerHandler(channelType: string, handler: DeliveryHandler): void {
    this.handlers.set(channelType, handler);
  }

  /** Unregister a handler. */
  unregisterHandler(channelType: string): void {
    this.handlers.delete(channelType);
  }

  // ── Core operations ──

  /** Enqueue a delivery. Returns the entry ID. Best-effort (doesn't throw). */
  async enqueue(channel: string, to: string, payload: unknown): Promise<string | null> {
    const entry: DeliveryEntry = {
      id: crypto.randomUUID(),
      channel,
      to,
      payload,
      enqueuedAt: Date.now(),
      retryCount: 0,
    };

    try {
      const tmpPath = path.join(this.queueDir, `${entry.id}.tmp`);
      const finalPath = path.join(this.queueDir, `${entry.id}.json`);
      await fs.writeFile(tmpPath, JSON.stringify(entry), 'utf-8');
      await fs.rename(tmpPath, finalPath); // atomic on local FS
      return entry.id;
    } catch (err) {
      logger.warn({ err, channel, to }, 'DeliveryQueue: failed to enqueue');
      return null;
    }
  }

  /** Acknowledge successful delivery — remove from queue. */
  async ack(id: string): Promise<void> {
    const jsonPath = path.join(this.queueDir, `${id}.json`);
    const deliveredPath = path.join(this.queueDir, `${id}.delivered`);

    try {
      // Phase 1: atomic rename
      await fs.rename(jsonPath, deliveredPath);
      // Phase 2: unlink
      await fs.unlink(deliveredPath).catch(() => {});
    } catch {
      // Entry may have already been acked or cleaned up — safe to ignore
    }
  }

  /** Record a delivery failure — increment retry count. */
  async failDelivery(id: string, error: string): Promise<void> {
    const jsonPath = path.join(this.queueDir, `${id}.json`);

    try {
      const raw = await fs.readFile(jsonPath, 'utf-8');
      const entry: DeliveryEntry = JSON.parse(raw);
      entry.retryCount++;
      entry.lastAttemptAt = Date.now();
      entry.lastError = error;

      if (entry.retryCount >= this.maxRetries || isPermanentError(error)) {
        await this.moveToFailed(id, entry);
        logger.warn(
          { id, channel: entry.channel, to: entry.to, retries: entry.retryCount, error },
          'DeliveryQueue: moved to failed (max retries or permanent error)',
        );
      } else {
        // Update in-place (atomic write)
        const tmpPath = path.join(this.queueDir, `${id}.tmp`);
        await fs.writeFile(tmpPath, JSON.stringify(entry), 'utf-8');
        await fs.rename(tmpPath, jsonPath);
        logger.info(
          { id, channel: entry.channel, retryCount: entry.retryCount, nextRetryMs: computeBackoffMs(entry.retryCount, this.backoffMs, this.backoffCapMs) },
          'DeliveryQueue: delivery failed, will retry',
        );
      }
    } catch {
      // Entry may have been acked concurrently — safe to ignore
    }
  }

  /** Move an entry to the failed/ directory (atomic rename). */
  private async moveToFailed(id: string, entry: DeliveryEntry): Promise<void> {
    const srcPath = path.join(this.queueDir, `${id}.json`);
    const failedPath = path.join(this.failedDir, `${id}.json`);

    try {
      // Update entry content before moving (captures latest retryCount/lastError)
      const tmpPath = path.join(this.queueDir, `${id}.moving.tmp`);
      await fs.writeFile(tmpPath, JSON.stringify(entry), 'utf-8');
      await fs.rename(tmpPath, srcPath);
      // Atomic move to failed/
      await fs.rename(srcPath, failedPath);
    } catch {
      // Best-effort — try direct write as fallback
      try {
        await fs.writeFile(failedPath, JSON.stringify(entry), 'utf-8');
        await fs.unlink(srcPath).catch(() => {});
      } catch {
        // Give up
      }
    }
  }

  // ── Load & Recovery ──

  /** Load all pending entries from the queue directory. */
  async loadPending(): Promise<DeliveryEntry[]> {
    const entries: DeliveryEntry[] = [];

    let files: string[];
    try {
      files = await fs.readdir(this.queueDir);
    } catch {
      return entries;
    }

    for (const file of files) {
      // Clean up stale .delivered markers (crash between phase 1 and 2)
      if (file.endsWith('.delivered')) {
        await fs.unlink(path.join(this.queueDir, file)).catch(() => {});
        continue;
      }
      // Skip .tmp files (crash during write) and subdirectories
      if (!file.endsWith('.json')) continue;

      try {
        const raw = await fs.readFile(path.join(this.queueDir, file), 'utf-8');
        entries.push(JSON.parse(raw));
      } catch {
        // Corrupt file — remove
        await fs.unlink(path.join(this.queueDir, file)).catch(() => {});
      }
    }

    // Sort oldest first
    entries.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    return entries;
  }

  /**
   * Recover pending deliveries on startup.
   * Retries eligible entries, moves stale/exhausted ones to failed/.
   */
  async recoverPending(): Promise<{ recovered: number; failed: number; deferred: number }> {
    const entries = await this.loadPending();
    if (entries.length === 0) return { recovered: 0, failed: 0, deferred: 0 };

    logger.info({ count: entries.length }, 'DeliveryQueue: recovering pending deliveries');

    const startTime = Date.now();
    let recovered = 0;
    let failed = 0;
    let deferred = 0;

    for (const entry of entries) {
      // Time budget exceeded — defer remaining
      if (Date.now() - startTime > this.maxRecoveryMs) {
        deferred += entries.length - recovered - failed - deferred;
        break;
      }

      // Stale entries → move to failed
      if (Date.now() - entry.enqueuedAt > this.staleTtlMs) {
        await this.moveToFailed(entry.id, entry);
        failed++;
        continue;
      }

      // Max retries exceeded → move to failed
      if (entry.retryCount >= this.maxRetries) {
        await this.moveToFailed(entry.id, entry);
        failed++;
        continue;
      }

      // Check backoff eligibility
      const backoffMs = computeBackoffMs(entry.retryCount, this.backoffMs, this.backoffCapMs);
      if (entry.lastAttemptAt && Date.now() - entry.lastAttemptAt < backoffMs) {
        deferred++;
        continue;
      }

      // Try to deliver
      const handler = this.handlers.get(entry.channel);
      if (!handler) {
        deferred++; // Channel not registered yet — will be retried by retry loop
        continue;
      }

      try {
        await handler(entry);
        await this.ack(entry.id);
        recovered++;
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        await this.failDelivery(entry.id, errMsg);
        if (entry.retryCount + 1 >= this.maxRetries || isPermanentError(errMsg)) {
          failed++;
        } else {
          deferred++;
        }
      }
    }

    logger.info({ recovered, failed, deferred }, 'DeliveryQueue: recovery complete');
    return { recovered, failed, deferred };
  }

  // ── Retry Loop ──

  /** Start the background retry loop. */
  startRetryLoop(): void {
    if (this.retryTimer) return;

    this.retryTimer = setInterval(async () => {
      try {
        const entries = await this.loadPending();
        const now = Date.now();

        for (const entry of entries) {
          // Only retry entries that have been attempted at least once
          if (entry.retryCount === 0) continue;

          // Check backoff eligibility
          const backoffMs = computeBackoffMs(entry.retryCount, this.backoffMs, this.backoffCapMs);
          if (entry.lastAttemptAt && now - entry.lastAttemptAt < backoffMs) continue;

          // Stale → move to failed
          if (now - entry.enqueuedAt > this.staleTtlMs) {
            await this.moveToFailed(entry.id, entry);
            continue;
          }

          const handler = this.handlers.get(entry.channel);
          if (!handler) continue;

          try {
            await handler(entry);
            await this.ack(entry.id);
            logger.info({ id: entry.id, channel: entry.channel, retryCount: entry.retryCount }, 'DeliveryQueue: retry succeeded');
          } catch (err) {
            await this.failDelivery(entry.id, (err as Error).message ?? String(err));
          }
        }
      } catch (err) {
        logger.debug({ err }, 'DeliveryQueue: retry loop error');
      }
    }, this.retryLoopIntervalMs);
  }

  /** Stop the retry loop. */
  stopRetryLoop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Get count of pending entries (for monitoring). */
  async pendingCount(): Promise<number> {
    try {
      const files = await fs.readdir(this.queueDir);
      return files.filter((f) => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
}
