import { describe, it, expect } from 'vitest';
import {
  PerfTimer,
  formatPerfStatus,
  formatTokenProgressStatus,
  ttftWarnThresholdMs,
  DEFAULT_TTFT_WARN_MS,
} from '../../src/utils/perf-metrics.js';

describe('PerfTimer (SCLI-21)', () => {
  it('measures TTFT from start to first chunk', () => {
    const t = new PerfTimer(1000);
    t.markFirstChunk(1300);
    const m = t.finish({ provider: 'vllm', model: 'm', inputTokens: 50, outputTokens: 200 }, 6300);
    expect(m.ttftMs).toBe(300);
  });

  it('markFirstChunk is idempotent (first wins)', () => {
    const t = new PerfTimer(1000);
    t.markFirstChunk(1200);
    t.markFirstChunk(1900);
    const m = t.finish({ provider: 'p', model: 'm', inputTokens: 1, outputTokens: 10 }, 3000);
    expect(m.ttftMs).toBe(200);
  });

  it('decode rate = output tokens over the decode window', () => {
    const t = new PerfTimer(0);
    t.markFirstChunk(1000);          // 1s prefill
    const m = t.finish({ provider: 'p', model: 'm', inputTokens: 0, outputTokens: 100 }, 6000); // 5s decode
    expect(m.decodeTokensPerSec).toBe(20); // 100 / 5s
  });

  it('falls back to whole-stream window for sub-100ms decode', () => {
    const t = new PerfTimer(0);
    t.markFirstChunk(950);
    const m = t.finish({ provider: 'p', model: 'm', inputTokens: 0, outputTokens: 50 }, 1000); // 50ms decode
    // window becomes 0..1000ms => 50 tok/s, not an absurd 1000 tok/s
    expect(m.decodeTokensPerSec).toBe(50);
  });

  it('null TTFT and null decode when no chunk ever arrived', () => {
    const t = new PerfTimer(0);
    const m = t.finish({ provider: 'p', model: 'm', inputTokens: 10, outputTokens: 0 }, 5000);
    expect(m.ttftMs).toBeNull();
    expect(m.decodeTokensPerSec).toBeNull();
  });

  it('computes cache hit rate and omits absent cache fields', () => {
    const t = new PerfTimer(0);
    t.markFirstChunk(100);
    const m = t.finish({ provider: 'anthropic', model: 'm', inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheCreationTokens: 0 }, 1000);
    expect(m.cacheReadTokens).toBe(300);
    expect(m.cacheHitRate).toBeCloseTo(300 / 400, 3);

    const t2 = new PerfTimer(0);
    t2.markFirstChunk(100);
    const m2 = t2.finish({ provider: 'openai', model: 'm', inputTokens: 100, outputTokens: 10 }, 1000);
    expect(m2.cacheHitRate).toBeNull();
    expect('cacheReadTokens' in m2).toBe(false);
  });
});

describe('formatPerfStatus', () => {
  it('renders TTFT + tok/s + cache', () => {
    expect(formatPerfStatus({
      provider: 'p', model: 'm', ttftMs: 1234, decodeTokensPerSec: 38,
      inputTokens: 1, outputTokens: 1, cacheHitRate: 0.5, totalDurationMs: 2000,
    })).toBe('TTFT 1.2s · 38 tok/s · cache 50%');
  });
  it('omits unmeasured fields', () => {
    expect(formatPerfStatus({
      provider: 'p', model: 'm', ttftMs: null, decodeTokensPerSec: null,
      inputTokens: 1, outputTokens: 1, cacheHitRate: null, totalDurationMs: 0,
    })).toBe('');
  });
});

describe('formatTokenProgressStatus', () => {
  it('renders estimated live input/output/rate', () => {
    expect(formatTokenProgressStatus({
      inputTokens: 3422,
      outputTokens: 210,
      outputTokensPerSec: 14,
      estimated: true,
    })).toBe('in ~3.4k · out ~210 · 14 tok/s');
  });

  it('renders exact usage without estimate markers', () => {
    expect(formatTokenProgressStatus({
      inputTokens: 3422,
      outputTokens: 210,
      outputTokensPerSec: null,
      estimated: false,
    })).toBe('in 3.4k · out 210');
  });
});

describe('ttftWarnThresholdMs', () => {
  it('defaults when unset/invalid', () => {
    const prev = process.env['SHIZUHA_TTFT_WARN_MS'];
    delete process.env['SHIZUHA_TTFT_WARN_MS'];
    expect(ttftWarnThresholdMs()).toBe(DEFAULT_TTFT_WARN_MS);
    process.env['SHIZUHA_TTFT_WARN_MS'] = 'nope';
    expect(ttftWarnThresholdMs()).toBe(DEFAULT_TTFT_WARN_MS);
    process.env['SHIZUHA_TTFT_WARN_MS'] = '1500';
    expect(ttftWarnThresholdMs()).toBe(1500);
    if (prev === undefined) delete process.env['SHIZUHA_TTFT_WARN_MS'];
    else process.env['SHIZUHA_TTFT_WARN_MS'] = prev;
  });
});
