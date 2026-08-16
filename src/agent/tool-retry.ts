/**
 * SCLI-20 (a): bounded, per-turn retry budget for transient tool failures.
 *
 * Tool calls — especially MCP calls over stdio/HTTP — occasionally fail for
 * transient reasons: a request times out, a remote rate-limits us (429), or a
 * socket is reset mid-flight. Re-issuing the exact same call a moment later
 * usually succeeds. But blindly retrying any error is wrong: a bad argument, a
 * permission denial, or a "file not found" will never get better by retrying,
 * and retrying them just wastes turns and hides the real problem.
 *
 * This module separates the two: {@link isRetryableToolError} decides whether an
 * error is worth retrying, {@link computeBackoffMs} spaces the attempts out with
 * exponential backoff + full jitter, and {@link ToolRetryBudget} bounds the total
 * number of retries so a flaky dependency can't make a single turn spin forever.
 * The budget is created once per turn and therefore resets every turn.
 */

export interface ToolRetryConfig {
  /** Max retry attempts shared across all tool calls in a single turn (default 2). */
  maxRetries: number;
  /** Base delay for the first retry, in ms (default 500). */
  baseDelayMs: number;
  /** Upper bound on a single backoff delay, in ms (default 8000). */
  maxDelayMs: number;
  /** Exponential growth factor between attempts (default 2). */
  backoffFactor: number;
}

export const DEFAULT_TOOL_RETRY_CONFIG: ToolRetryConfig = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  backoffFactor: 2,
};

/**
 * Error signatures that indicate a transient failure worth retrying. Matched
 * case-insensitively against the error message (and, when present, a numeric
 * `status`/`code`). Anything not matched here is treated as non-retryable and
 * fails immediately.
 */
const RETRYABLE_PATTERNS: RegExp[] = [
  /\btimed?\s*-?\s*out\b|\btimeout\b|etimedout/i,
  /rate.?limit|too many requests|\b429\b/i,
  /econnreset|econnrefused|enetunreach|ehostunreach|eai_again|epipe|socket hang ?up|network|connection (?:reset|closed|refused|aborted)/i,
  /temporarily unavailable|service unavailable|\b50[234]\b|overloaded|try again/i,
];

/** HTTP status codes that are transient and safe to retry. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function errorText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return `${err.message} ${(err as { code?: unknown }).code ?? ''}`;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const parts = [o['message'], o['code'], o['error'], o['reason']]
      .filter((v) => typeof v === 'string' || typeof v === 'number');
    if (parts.length) return parts.join(' ');
    try { return JSON.stringify(o); } catch { return String(err); }
  }
  return String(err);
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    for (const key of ['status', 'statusCode', 'code']) {
      const v = o[key];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    }
  }
  return undefined;
}

/** True when the error looks transient (timeout / rate-limit / network blip). */
export function isRetryableToolError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return true;
  const text = errorText(err);
  if (!text) return false;
  return RETRYABLE_PATTERNS.some((re) => re.test(text));
}

/**
 * Backoff for the Nth retry (1-based) with full jitter:
 *   delay ∈ [0, min(base · factor^(n-1), maxDelay)]
 * Full jitter (random across the whole window) avoids the thundering-herd
 * problem where many callers retry in lockstep. `rand` is injectable for tests.
 */
export function computeBackoffMs(
  attempt: number,
  config: ToolRetryConfig = DEFAULT_TOOL_RETRY_CONFIG,
  rand: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const exp = config.baseDelayMs * Math.pow(config.backoffFactor, n - 1);
  const capped = Math.min(exp, config.maxDelayMs);
  return Math.round(Math.max(0, Math.min(1, rand())) * capped);
}

/**
 * A bounded pool of retry attempts shared across every tool call in one turn.
 * Construct one per turn (so it resets each turn) and `consume()` an attempt
 * each time you retry.
 */
export class ToolRetryBudget {
  private remainingAttempts: number;

  constructor(private readonly config: ToolRetryConfig = DEFAULT_TOOL_RETRY_CONFIG) {
    this.remainingAttempts = Math.max(0, config.maxRetries);
  }

  get remaining(): number {
    return this.remainingAttempts;
  }

  canRetry(): boolean {
    return this.remainingAttempts > 0;
  }

  /** Spend one retry attempt. Returns false if the budget was already empty. */
  consume(): boolean {
    if (this.remainingAttempts <= 0) return false;
    this.remainingAttempts--;
    return true;
  }

  /** Restore the budget to full (call at the start of a new turn). */
  reset(): void {
    this.remainingAttempts = Math.max(0, this.config.maxRetries);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryHooks {
  /** Delay implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** RNG for jitter (injectable for tests). */
  rand?: () => number;
  /** Observability callback fired before each retry sleep. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Run `fn`, retrying only transient failures and only while `budget` allows,
 * with exponential backoff + jitter between attempts. Non-retryable errors (and
 * the final failure once the budget is spent) are rethrown to the caller.
 */
export async function executeToolWithRetry<T>(
  fn: () => Promise<T>,
  budget: ToolRetryBudget,
  config: ToolRetryConfig = DEFAULT_TOOL_RETRY_CONFIG,
  hooks: RetryHooks = {},
): Promise<T> {
  const sleep = hooks.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableToolError(err) || !budget.canRetry()) throw err;
      budget.consume();
      attempt++;
      const delayMs = computeBackoffMs(attempt, config, hooks.rand);
      hooks.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
