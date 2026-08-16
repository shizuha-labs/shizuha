import { describe, it, expect } from 'vitest';
import { parseRateLimitHeaders } from '../../src/tui/utils/rateLimit.js';

describe('parseRateLimitHeaders', () => {
  it('parses standard rate limit headers', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '25',
    });
    expect(result).not.toBeNull();
    expect(result!.limit).toBe(100);
    expect(result!.remaining).toBe(25);
    expect(result!.usagePercent).toBe(0.75);
  });

  it('returns null when headers missing', () => {
    const result = parseRateLimitHeaders({});
    expect(result).toBeNull();
  });

  it('returns null when headers are non-numeric', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit': 'abc',
      'x-ratelimit-remaining': 'def',
    });
    expect(result).toBeNull();
  });

  it('warns at 75%+ usage', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '24',
    });
    expect(result!.warning).toContain('used');
    expect(result!.usagePercent).toBeGreaterThanOrEqual(0.75);
  });

  it('warns at 90% usage', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '9',
    });
    expect(result!.warning).toContain('warning');
  });

  it('warns critical at 95% usage', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '4',
    });
    expect(result!.warning).toContain('critical');
  });

  it('no warning at low usage', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '80',
    });
    expect(result!.warning).toBeNull();
  });

  it('parses short header names', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit': '1000',
      'x-ratelimit-remaining': '500',
    });
    expect(result!.limit).toBe(1000);
    expect(result!.remaining).toBe(500);
  });

  it('parses ISO date reset time', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '50',
      'x-ratelimit-reset': future,
    });
    expect(result!.resetAt).toBeGreaterThan(Date.now());
  });

  it('parses numeric reset time (seconds)', () => {
    const result = parseRateLimitHeaders({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '50',
      'x-ratelimit-reset': '60',
    });
    expect(result!.resetAt).toBeGreaterThan(Date.now());
  });
});
