import { describe, expect, it, vi } from 'vitest';
import {
  isRetryableToolError,
  computeBackoffMs,
  ToolRetryBudget,
  executeToolWithRetry,
  DEFAULT_TOOL_RETRY_CONFIG,
  type ToolRetryConfig,
} from '../../src/agent/tool-retry.js';

/** SCLI-20(a): bounded retry budget + backoff classification. */

const CFG: ToolRetryConfig = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000, backoffFactor: 2 };
const noSleep = () => Promise.resolve();

describe('isRetryableToolError', () => {
  it('classifies timeouts as retryable', () => {
    expect(isRetryableToolError(new Error('Request timed out after 30s'))).toBe(true);
    expect(isRetryableToolError(new Error('connect ETIMEDOUT 10.0.0.1:443'))).toBe(true);
    expect(isRetryableToolError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('classifies rate limits as retryable', () => {
    expect(isRetryableToolError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRetryableToolError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableToolError({ status: 429 })).toBe(true);
  });

  it('classifies transient network errors as retryable', () => {
    expect(isRetryableToolError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableToolError(new Error('read ECONNRESET'))).toBe(true);
    expect(isRetryableToolError({ statusCode: 503 })).toBe(true);
    expect(isRetryableToolError(new Error('Service Unavailable'))).toBe(true);
  });

  it('classifies deterministic errors as non-retryable', () => {
    expect(isRetryableToolError(new Error('ENOENT: no such file or directory'))).toBe(false);
    expect(isRetryableToolError(new Error('Permission denied'))).toBe(false);
    expect(isRetryableToolError(new Error('invalid argument: foo'))).toBe(false);
    expect(isRetryableToolError({ status: 404 })).toBe(false);
    expect(isRetryableToolError(new Error('400 Bad Request'))).toBe(false);
  });

  it('handles non-Error shapes safely', () => {
    expect(isRetryableToolError(null)).toBe(false);
    expect(isRetryableToolError(undefined)).toBe(false);
    expect(isRetryableToolError('connection reset by peer')).toBe(true);
    expect(isRetryableToolError('all good')).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('grows exponentially with full jitter (rand=1 gives the ceiling)', () => {
    expect(computeBackoffMs(1, CFG, () => 1)).toBe(100);   // 100 * 2^0
    expect(computeBackoffMs(2, CFG, () => 1)).toBe(200);   // 100 * 2^1
    expect(computeBackoffMs(3, CFG, () => 1)).toBe(400);   // 100 * 2^2
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoffMs(10, CFG, () => 1)).toBe(1000); // would be 51200, capped
  });

  it('applies jitter across the [0, ceiling] window', () => {
    expect(computeBackoffMs(3, CFG, () => 0)).toBe(0);
    expect(computeBackoffMs(3, CFG, () => 0.5)).toBe(200); // half of 400
  });

  it('clamps out-of-range rand values', () => {
    expect(computeBackoffMs(1, CFG, () => 5)).toBe(100);
    expect(computeBackoffMs(1, CFG, () => -5)).toBe(0);
  });
});

describe('ToolRetryBudget', () => {
  it('bounds the number of retries and resets to full', () => {
    const budget = new ToolRetryBudget(CFG);
    expect(budget.remaining).toBe(3);
    expect(budget.canRetry()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);  // exhausted
    expect(budget.canRetry()).toBe(false);
    budget.reset();
    expect(budget.remaining).toBe(3);
  });

  it('treats a zero budget as no retries', () => {
    const budget = new ToolRetryBudget({ ...CFG, maxRetries: 0 });
    expect(budget.canRetry()).toBe(false);
  });
});

describe('executeToolWithRetry', () => {
  it('returns immediately on success without consuming budget', async () => {
    const budget = new ToolRetryBudget(CFG);
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await executeToolWithRetry(fn, budget, CFG, { sleep: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(3);
  });

  it('retries a transient failure then succeeds', async () => {
    const budget = new ToolRetryBudget(CFG);
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce('recovered');
    const result = await executeToolWithRetry(fn, budget, CFG, { sleep: noSleep, onRetry, rand: () => 1 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(budget.remaining).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, delayMs: 100 });
  });

  it('does NOT retry a non-retryable error — fails on first attempt', async () => {
    const budget = new ToolRetryBudget(CFG);
    const fn = vi.fn().mockRejectedValue(new Error('Permission denied'));
    await expect(executeToolWithRetry(fn, budget, CFG, { sleep: noSleep })).rejects.toThrow('Permission denied');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(budget.remaining).toBe(3);  // untouched
  });

  it('gives up once the budget is exhausted and rethrows the last error', async () => {
    const budget = new ToolRetryBudget({ ...CFG, maxRetries: 2 });
    const fn = vi.fn().mockRejectedValue(new Error('429 rate limit'));
    await expect(executeToolWithRetry(fn, budget, CFG, { sleep: noSleep })).rejects.toThrow('429');
    expect(fn).toHaveBeenCalledTimes(3);  // 1 initial + 2 retries
    expect(budget.canRetry()).toBe(false);
  });

  it('shares one budget across calls (per-turn semantics)', async () => {
    const budget = new ToolRetryBudget({ ...CFG, maxRetries: 2 });
    const flaky = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce('a');
    await executeToolWithRetry(flaky, budget, CFG, { sleep: noSleep });  // spends 1
    expect(budget.remaining).toBe(1);

    const stillFlaky = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce('b');
    // only 1 retry left → second failure exhausts the shared budget and rethrows
    await expect(executeToolWithRetry(stillFlaky, budget, CFG, { sleep: noSleep })).rejects.toThrow('ETIMEDOUT');
    expect(stillFlaky).toHaveBeenCalledTimes(2);
  });

  it('uses sane defaults when no config is passed', () => {
    expect(DEFAULT_TOOL_RETRY_CONFIG.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_TOOL_RETRY_CONFIG.backoffFactor).toBeGreaterThan(1);
  });
});
