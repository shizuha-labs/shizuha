/**
 * The TUI transcript must not grow without bound.
 *
 * A ~4h session died on 2026-08-05:
 *
 *   Mark-Compact 3813.0 (4133.0) -> 3797.3 MB ... allocation failure
 *   FATAL ERROR: Ineffective mark-compacts near heap limit
 *   JavaScript heap out of memory
 *
 * That is V8's own ~4GB default heap ceiling, NOT the host's memory — s1 has
 * 512GB and it made no difference. (Measured: setFlagsFromString cannot raise
 * it after startup, 4144MB -> 4144MB; only NODE_OPTIONS does, 8240MB.)
 *
 * The cause was `resolveCompletedEntryLimit()` returning null — unbounded —
 * unless an operator happened to set SHIZUHA_TUI_HISTORY_WINDOW. Every append
 * path short-circuits on null, so the TUI retained every completed entry for
 * the whole session, full tool outputs included, and rebuilt the entire array
 * on each append. The crash took the session, its scrollback, and its queued
 * input with it.
 */
import { describe, expect, it, afterEach } from 'vitest';

// The seam re-derives from the CURRENT env, so one import is enough — the
// module-level const is captured at load time and cannot be varied.
import { __resolveCompletedEntryLimitForTest as limit } from '../../src/tui/hooks/useAgentSession.js';

const ENV_KEY = 'SHIZUHA_TUI_HISTORY_WINDOW';
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

function limitFor(value: string | undefined): number | null {
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  return limit();
}

describe('completed-transcript retention', () => {
  it('is BOUNDED by default', () => {
    const limit = limitFor(undefined);
    expect(
      limit,
      'returning null here is what let a 4h session reach V8\'s 4GB ceiling '
        + 'and die, losing the scrollback and every queued message',
    ).not.toBeNull();
    expect(limit).toBeGreaterThan(0);
  });

  it('keeps enough history that normal sessions never notice', () => {
    const limit = limitFor(undefined);
    expect(limit!).toBeGreaterThanOrEqual(1000);
  });

  it('honours an explicit numeric override', () => {
    expect(limitFor('42')).toBe(42);
  });

  it('still allows opting back into unbounded', () => {
    for (const value of ['unbounded', 'off', '0']) {
      expect(limitFor(value), `${value} must disable the cap`).toBeNull();
    }
  });

  it('falls back to the default for junk values', () => {
    const fallback = limitFor(undefined);
    expect(limitFor('not-a-number')).toBe(fallback);
    expect(limitFor('-5')).toBe(fallback);
  });
});
