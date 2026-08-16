import { describe, expect, it } from 'vitest';

import { buildAgentActivityRate } from '../../src/daemon/dashboard.js';

describe('runtime agent activity rate', () => {
  const nowMs = Date.parse('2026-07-17T05:00:00.000Z');

  it('preserves a numeric rate when recent in-memory samples exist', () => {
    const result = buildAgentActivityRate(
      [
        {
          ts: '2026-07-17T04:59:40.000Z',
          tool: 'pulse_get_my_tasks',
          detail: 'started queue read',
        },
        {
          ts: '2026-07-17T04:59:50.000Z',
          tool: 'pulse_add_comment',
          detail: 'completed task progress',
        },
      ],
      '2026-07-17T04:59:59.000Z',
      600,
      nowMs,
    );

    expect(result).toEqual({
      words_per_sec: 0.8,
      recent_words: 8,
      window_sec: 600,
      last_activity_ts: '2026-07-17T04:59:50.000Z',
      rate_available: true,
    });
  });

  it('returns a truthful k8s timestamp and unknown rate when memory is empty', () => {
    const result = buildAgentActivityRate(
      [],
      '2026-07-17T04:59:55.000Z',
      600,
      nowMs,
    );

    expect(result).toEqual({
      words_per_sec: null,
      recent_words: 0,
      window_sec: 600,
      last_activity_ts: '2026-07-17T04:59:55.000Z',
      rate_available: false,
    });
  });

  it('uses the last-activity fallback when memory has no samples in the window', () => {
    const result = buildAgentActivityRate(
      [{ ts: '2026-07-17T04:40:00.000Z', tool: 'stale_tool', detail: 'stale event' }],
      '2026-07-17T04:59:58.000Z',
      600,
      nowMs,
    );

    expect(result).toEqual({
      words_per_sec: null,
      recent_words: 0,
      window_sec: 600,
      last_activity_ts: '2026-07-17T04:59:58.000Z',
      rate_available: false,
    });
  });

  it('does not invent a timestamp when neither source has valid activity', () => {
    const result = buildAgentActivityRate([], 'not-a-date', 600, nowMs);

    expect(result).toEqual({
      words_per_sec: null,
      recent_words: 0,
      window_sec: 600,
      last_activity_ts: null,
      rate_available: false,
    });
  });

  it('keeps a sampled zero rate available for timestamp-only events', () => {
    const result = buildAgentActivityRate(
      [{ ts: '2026-07-17T04:59:50.000Z' }],
      null,
      600,
      nowMs,
    );

    expect(result).toEqual({
      words_per_sec: 0,
      recent_words: 0,
      window_sec: 600,
      last_activity_ts: '2026-07-17T04:59:50.000Z',
      rate_available: true,
    });
  });
});
