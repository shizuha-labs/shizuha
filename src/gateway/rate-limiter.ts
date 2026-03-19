import { logger } from '../utils/logger.js';

export interface RateLimitConfig {
  /** Max messages per window (default: 30) */
  maxMessages: number;
  /** Window size in ms (default: 60000 = 1 minute) */
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxMessages: 30,
  windowMs: 60_000,
};

interface UserBucket {
  timestamps: number[];
}

export class RateLimiter {
  private buckets = new Map<string, UserBucket>();
  private config: RateLimitConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a user is allowed to send a message.
   * Returns { allowed: true } or { allowed: false, retryAfterMs }.
   */
  check(userId: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    let bucket = this.buckets.get(userId);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(userId, bucket);
    }

    // Prune old timestamps
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= this.config.maxMessages) {
      const oldest = bucket.timestamps[0]!;
      const retryAfterMs = oldest + this.config.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    bucket.timestamps.push(now);
    return { allowed: true };
  }

  /** Start periodic cleanup of stale buckets (every 5 minutes) */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - this.config.windowMs * 2;
      for (const [userId, bucket] of this.buckets) {
        if (bucket.timestamps.every((t) => t < cutoff)) {
          this.buckets.delete(userId);
        }
      }
    }, 5 * 60_000);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Get current usage for a user */
  getUsage(userId: string): { count: number; windowMs: number; maxMessages: number } {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const bucket = this.buckets.get(userId);
    const count = bucket ? bucket.timestamps.filter((t) => t > cutoff).length : 0;
    return { count, windowMs: this.config.windowMs, maxMessages: this.config.maxMessages };
  }
}
