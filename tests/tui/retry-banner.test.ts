import { describe, expect, it } from 'vitest';
import { retryBannerClass } from '../../src/tui/retry-banner.js';

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
});
