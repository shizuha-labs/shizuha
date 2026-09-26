import { describe, expect, it } from 'vitest';
import { retryBannerClass, withoutResolvedRetryBanners } from '../../src/tui/retry-banner.js';

describe('retry banner class', () => {
  it('groups the same API error and keeps a different status apart', () => {
    const reset = '↻ API error (ECONNRESET): terminated — retrying in 58s (attempt 15, stalled 16m 31s, indefinite)';
    const again = '↻ API error (ECONNRESET): terminated — retrying in 50s (attempt 16, stalled 17m, indefinite)';
    const gateway = '↻ API error (502): vLLM error 502 after 2 retries — retrying in 60s (attempt 9, stalled 5m 11s, indefinite)';
    expect(retryBannerClass(reset)).toBe('econnreset');
    expect(retryBannerClass(again)).toBe(retryBannerClass(reset));
    expect(retryBannerClass(gateway)).toBe('502');
    expect(retryBannerClass(gateway)).not.toBe(retryBannerClass(reset));
    expect(retryBannerClass('✗ Cannot submit safely')).toBeNull();
  });

  it('drops resolved ↻ lines even when partial answers sit between them', () => {
    const entries = [
      { role: 'user', content: 'bring the guild up' },
      { role: 'system', content: '↻ API error (retryable): ECONNREFUSED — retrying in 1s (attempt 1, indefinite)' },
      { role: 'assistant', content: 'Now plain Postgres' },
      { role: 'system', content: '↻ API error (retryable): ECONNREFUSED — retrying in 2s (attempt 2, stalled 5s, indefinite)' },
      { role: 'assistant', content: 'The volume scheduled' },
      { role: 'system', content: '✗ Cannot submit safely' },
    ];
    expect(withoutResolvedRetryBanners(entries).map((entry) => entry.role + ':' + entry.content.slice(0, 12))).toEqual([
      'user:bring the gu',
      'assistant:Now plain Po',
      'assistant:The volume s',
      'system:✗ Cannot sub',
    ]);
    const clean = entries.slice(0, 1);
    expect(withoutResolvedRetryBanners(clean)).toBe(clean);
  });
});
