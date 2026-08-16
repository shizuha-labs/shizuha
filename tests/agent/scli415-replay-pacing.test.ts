import { describe, expect, it } from 'vitest';
import {
  ExpensiveTurnGuard,
  expensiveTurnGuardConfigFromEnv,
} from '../../src/agent/expensive-turn-guard.js';
import type { ExpensiveTurnSample } from '../../src/agent/expensive-turn-guard.js';

/**
 * SCLI-415 — replay pacing must be DERIVED from the live guard thresholds.
 *
 * The regression was that a verified episode released its whole deferred FIFO
 * at once, placing >= minTurns high-prompt turns inside one guard window and
 * re-tripping SCLI-195. The structural fix is that background replay can never
 * satisfy the guard on its own.
 *
 * Production overrode the defaults (agent-ni ran minTurns=8 / window=120s
 * against DEFAULT_CONFIG's 4 / 60s), so a constant tuned to the defaults would
 * be wrong live by a factor of two. These tests fail if a constant is ever
 * reintroduced at the call site.
 */

function expensive(now: number): ExpensiveTurnSample {
  // Sterile high-prefill plateau: full re-prefill shape with no tools and
  // negligible text — the only shape that should force-pause.
  return { now, inputTokens: 120_000, outputTokens: 10, toolCallCount: 0 };
}

describe('SCLI-415 replay pacing derives from the live guard config', () => {
  it('paces so replay alone can never reach minTurns inside one window', () => {
    for (const [minTurns, windowMs] of [[4, 60_000], [8, 120_000], [12, 300_000]] as const) {
      const guard = new ExpensiveTurnGuard({
        ...expensiveTurnGuardConfigFromEnv({}),
        enabled: true,
        minTurns,
        windowMs,
      });
      const { maxInFlight, minSpacingMs } = guard.replayPacing();
      expect(maxInFlight).toBe(1);

      // Turns landing in any window of length windowMs when spaced minSpacingMs.
      const turnsPerWindow = Math.floor(windowMs / minSpacingMs) + 1;
      expect(turnsPerWindow).toBeLessThan(minTurns);
    }
  });

  it('a paced replay stream does not trip the guard, while a burst does', () => {
    const config = { ...expensiveTurnGuardConfigFromEnv({}), enabled: true, minTurns: 8, windowMs: 120_000 };

    // Positive control: the OLD behaviour (bulk release) trips it.
    const bursting = new ExpensiveTurnGuard(config);
    let tripped = false;
    for (let i = 0; i < 11; i += 1) {
      if (bursting.record(expensive(1_000 + i * 200)).action === 'pause') tripped = true;
    }
    expect(tripped).toBe(true);

    // The paced pump must NOT trip on the same 11 rows.
    const paced = new ExpensiveTurnGuard(config);
    const { minSpacingMs } = paced.replayPacing();
    let pacedTripped = false;
    for (let i = 0; i < 11; i += 1) {
      if (paced.record(expensive(1_000 + i * minSpacingMs)).action === 'pause') pacedTripped = true;
    }
    expect(pacedTripped).toBe(false);
  });

  it('spacing tracks the env overrides rather than DEFAULT_CONFIG', () => {
    const fromDefaults = new ExpensiveTurnGuard(expensiveTurnGuardConfigFromEnv({}));
    const fromEnv = new ExpensiveTurnGuard(expensiveTurnGuardConfigFromEnv({
      SHIZUHA_EXPENSIVE_TURN_MIN_TURNS: '8',
      SHIZUHA_EXPENSIVE_TURN_WINDOW_MS: '120000',
    } as NodeJS.ProcessEnv));

    // Live production values differ from the defaults; the pacing must too.
    expect(fromEnv.replayPacing().minSpacingMs)
      .not.toBe(fromDefaults.replayPacing().minSpacingMs);
  });

  it('a disabled guard imposes no spacing but still releases one row at a time', () => {
    const guard = new ExpensiveTurnGuard({
      ...expensiveTurnGuardConfigFromEnv({}),
      enabled: false,
    });
    const pacing = guard.replayPacing();
    expect(pacing.maxInFlight).toBe(1);
    expect(pacing.minSpacingMs).toBe(0);
  });
});
