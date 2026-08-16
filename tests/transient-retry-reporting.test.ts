import { describe, it, expect } from 'vitest';
import {
  RETRY_AFTER_MIN_MS,
  TRANSIENT_RETRY_MAX_DELAY_MS,
  formatRetryNotice,
  formatStallDuration,
  resolveRetryDelayMs,
  retryAfterMsFromError,
  summarizeFailureReason,
  transientRetryDelayMs,
} from '../src/provider/transient-errors.js';

/**
 * Regression cover for the shizuha1 stall (2026-08-03): the TUI retried Cortex
 * 503s for >10 minutes while printing only "API error (503), retrying in 3s…
 * (attempt 1, indefinite)". Two facts were missing from that line — WHY Cortex
 * refused, and HOW LONG the prompt had actually been blocked — and their
 * absence turned a one-look diagnosis into a live investigation.
 */
describe('summarizeFailureReason', () => {
  it('keeps the actionable Cortex reason that used to be dropped', () => {
    const raw = 'Cortex error 503: latency tail guard: no safe cold-prefill lane';
    expect(summarizeFailureReason(raw)).toBe('latency tail guard: no safe cold-prefill lane');
  });

  it('unwraps a JSON error envelope down to the message', () => {
    const raw = '{"error": {"message": "DeepSeek-V4-Flash is currently leased to another agent (agent-fumi). Retry after the lease is released.", "type": "model_leased"}}';
    expect(summarizeFailureReason(raw)).toContain('leased to another agent (agent-fumi)');
  });

  it('strips the vLLM prefix that only repeats the status code', () => {
    expect(summarizeFailureReason('vLLM error 500 - upstream interrupted')).toBe('upstream interrupted');
  });

  it('truncates to one terminal line', () => {
    const out = summarizeFailureReason('x'.repeat(400), 60);
    expect(out).toHaveLength(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty for a blank message rather than a stray separator', () => {
    expect(summarizeFailureReason('')).toBe('');
    expect(summarizeFailureReason(undefined)).toBe('');
  });
});

describe('formatStallDuration', () => {
  it('renders sub-minute stalls in seconds', () => {
    expect(formatStallDuration(45_000)).toBe('45s');
  });

  it('renders long stalls in minutes so a 10-minute outage reads as one', () => {
    expect(formatStallDuration(630_000)).toBe('10m 30s');
    expect(formatStallDuration(120_000)).toBe('2m');
  });
});

describe('formatRetryNotice', () => {
  it('surfaces the cause and the cumulative stall, not just the status', () => {
    const line = formatRetryNotice({
      label: 'API error',
      code: undefined,
      status: 503,
      message: 'Cortex error 503: latency tail guard: no safe cold-prefill lane',
      attempt: 27,
      elapsedMs: 640_000,
      delayMs: 38_000,
    });
    expect(line).toContain('(503)');
    expect(line).toContain('latency tail guard: no safe cold-prefill lane');
    expect(line).toContain('attempt 27');
    expect(line).toContain('stalled 10m 40s');
    expect(line).toContain('retrying in 38s');
  });

  it('omits the stall clause on the very first failure', () => {
    const line = formatRetryNotice({
      label: 'API error',
      status: 503,
      message: 'overloaded',
      attempt: 1,
      elapsedMs: 0,
      delayMs: 1_000,
    });
    expect(line).not.toContain('stalled');
    expect(line).toContain('attempt 1');
  });

  it('never rounds a sub-second backoff down to "0s"', () => {
    const line = formatRetryNotice({
      label: 'API error', status: 503, message: 'x',
      attempt: 1, elapsedMs: 0, delayMs: 400,
    });
    expect(line).toContain('retrying in 1s');
  });

  it('preserves the caller hint', () => {
    const line = formatRetryNotice({
      label: 'Provider stream/first-token stall', code: 'ETIMEDOUT', status: null,
      message: 'no first chunk', attempt: 3, elapsedMs: 90_000, delayMs: 8_000,
      hint: ' — try /model DeepSeek-V4-Flash',
    });
    expect(line).toContain('(ETIMEDOUT)');
    expect(line).toContain('stalled 1m 30s');
    expect(line).toContain('try /model DeepSeek-V4-Flash');
  });
});

/**
 * Cortex answers its admission guards with an accurate Retry-After (the
 * latency-tail guard sends 5s), but SCLI climbed a blind exponential to 60s and
 * could idle a full minute after the lane had already freed.
 */
describe('retryAfterMsFromError', () => {
  it('reads the normalized hint the provider attaches', () => {
    expect(retryAfterMsFromError(Object.assign(new Error('x'), { retryAfterMs: 5000 }))).toBe(5000);
  });

  it('ignores absent, zero, negative and non-numeric values', () => {
    expect(retryAfterMsFromError(new Error('x'))).toBeNull();
    expect(retryAfterMsFromError(Object.assign(new Error('x'), { retryAfterMs: 0 }))).toBeNull();
    expect(retryAfterMsFromError(Object.assign(new Error('x'), { retryAfterMs: -5 }))).toBeNull();
    expect(retryAfterMsFromError(Object.assign(new Error('x'), { retryAfterMs: 'soon' }))).toBeNull();
    expect(retryAfterMsFromError(null)).toBeNull();
    expect(retryAfterMsFromError(undefined)).toBeNull();
  });
});

describe('resolveRetryDelayMs', () => {
  const mid = () => 0.5; // no jitter skew

  it('falls back to the unchanged exponential when no hint is present', () => {
    for (const attempt of [0, 3, 9]) {
      expect(resolveRetryDelayMs({ attempt, rand: mid }))
        .toBe(transientRetryDelayMs(attempt, mid));
    }
  });

  it('honors a 5s hint instead of climbing toward the 60s ceiling', () => {
    // The exact shizuha1 case: without the hint, attempt 9 waits tens of seconds.
    const blind = transientRetryDelayMs(9, mid);
    const honored = resolveRetryDelayMs({ attempt: 9, retryAfterMs: 5_000, rand: mid });
    expect(honored).toBeLessThan(blind);
    expect(honored).toBeLessThanOrEqual(8_000);
  });

  it('never thrashes below the anti-storm floor', () => {
    expect(resolveRetryDelayMs({ attempt: 0, retryAfterMs: 10, rand: mid }))
      .toBeGreaterThanOrEqual(RETRY_AFTER_MIN_MS * 0.9);
  });

  it('escalates a sustained guard into a poll rather than a hammer', () => {
    const early = resolveRetryDelayMs({ attempt: 0, retryAfterMs: 1_000, rand: mid });
    const late = resolveRetryDelayMs({ attempt: 40, retryAfterMs: 1_000, rand: mid });
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThanOrEqual(15_000 * 1.1);
  });

  it('clamps an absurd server hint to the session ceiling', () => {
    expect(resolveRetryDelayMs({ attempt: 0, retryAfterMs: 86_400_000, rand: mid }))
      .toBeLessThanOrEqual(TRANSIENT_RETRY_MAX_DELAY_MS * 1.1);
  });

  it('stays within jitter bounds of the honored value', () => {
    const lo = resolveRetryDelayMs({ attempt: 0, retryAfterMs: 5_000, rand: () => 0 });
    const hi = resolveRetryDelayMs({ attempt: 0, retryAfterMs: 5_000, rand: () => 1 });
    expect(lo).toBe(4_500);
    expect(hi).toBe(5_500);
  });
});
