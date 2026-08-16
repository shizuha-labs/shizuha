import { describe, expect, it } from 'vitest';

import {
  cortexAdvertisedStreamTimeoutMs,
  requestAwareToolStreamTimeoutMs,
} from '../../src/provider/stream-timeout.js';

describe('requestAwareToolStreamTimeoutMs', () => {
  it('keeps the ordinary fast deadline when no tool parser can buffer', () => {
    expect(requestAwareToolStreamTimeoutMs({
      baseMs: 90_000,
      maxTokens: 8_192,
      hasTools: false,
    })).toBe(90_000);
  });

  it('covers a fully buffered 8K DeepSeek invoke plus client margin', () => {
    expect(requestAwareToolStreamTimeoutMs({
      baseMs: 300_000,
      maxTokens: 8_192,
      hasTools: true,
    })).toBe(1_174_000);
  });

  it('honors tool_choice none and caps dead upstreams', () => {
    expect(requestAwareToolStreamTimeoutMs({
      baseMs: 300_000,
      maxTokens: 8_192,
      hasTools: true,
      toolChoice: 'none',
    })).toBe(300_000);
    expect(requestAwareToolStreamTimeoutMs({
      baseMs: 300_000,
      maxTokens: 1_000_000,
      hasTools: true,
    })).toBe(7_230_000);
  });
});

describe('cortexAdvertisedStreamTimeoutMs', () => {
  it('places the SCLI deadline after Cortex, not on the same millisecond', () => {
    const headers = new Headers({ 'x-cortex-inter-token-timeout-seconds': '2168' });
    expect(cortexAdvertisedStreamTimeoutMs(headers)).toBe(2_198_000);
  });

  it('ignores absent or invalid contracts', () => {
    expect(cortexAdvertisedStreamTimeoutMs(new Headers())).toBeUndefined();
    expect(cortexAdvertisedStreamTimeoutMs(new Headers({
      'x-cortex-inter-token-timeout-seconds': 'invalid',
    }))).toBeUndefined();
  });
});
