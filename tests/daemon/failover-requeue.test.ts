import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  nextFailoverRequeueDelayMs,
  resetFailoverRequeue,
  advanceFailoverStep,
  resetFailoverStep,
  getFailoverStepIndex,
} from '../../src/daemon/manager.js';

// SCLI-107: a transient provider-wide outage that exhausts the whole failover
// chain must NOT permanently park codex agents in `error`. The daemon re-queues
// a start with exponential back-off (capped) and self-heals on recovery.
describe('SCLI-107 failover-chain-exhaustion back-off', () => {
  const AGENT = 'agent-scli107';

  beforeEach(() => {
    resetFailoverRequeue(AGENT);
    resetFailoverStep(AGENT);
  });

  it('escalates exponentially from 30s and caps at 10min per outage cycle', () => {
    // 30s → 60s → 120s → 240s → 480s → 600s (cap) → 600s …
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(30_000);
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(60_000);
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(120_000);
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(240_000);
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(480_000);
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(600_000); // ceiling
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(600_000); // stays capped
  });

  it('resets to the 30s floor after genuine recovery (per-cycle, not cumulative)', () => {
    nextFailoverRequeueDelayMs(AGENT); // 30s
    nextFailoverRequeueDelayMs(AGENT); // 60s
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(120_000);

    // Genuine recovery clears the counter (shizuha note #1): a second outage
    // must start back at the floor, not continue the previous escalation.
    resetFailoverRequeue(AGENT);

    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(30_000);
  });

  it('tracks back-off independently per agent', () => {
    const other = 'agent-other';
    resetFailoverRequeue(other);

    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(30_000);
    expect(nextFailoverRequeueDelayMs(AGENT)).toBe(60_000);
    // A different agent's outage is unaffected by AGENT's escalation.
    expect(nextFailoverRequeueDelayMs(other)).toBe(30_000);
    resetFailoverRequeue(other);
  });

  it('re-queue retries from step 0 (the primary) — provider may have recovered', () => {
    // advanceFailoverStep schedules a real 10-min cooldown timer on exhaustion;
    // fake timers keep it from leaking past the test.
    vi.useFakeTimers();
    try {
      const chain = [
        { method: 'codex_app_server', model: 'gpt-5.5' },
        { method: 'claude_code_server', model: 'claude-opus-4-8' },
      ];
      // Walk the chain to exhaustion: step 0 → 1, then exhausted (null).
      expect(advanceFailoverStep(AGENT, chain)?.method).toBe('claude_code_server');
      expect(getFailoverStepIndex(AGENT)).toBe(1);
      expect(advanceFailoverStep(AGENT, chain)).toBeNull(); // exhausted

      // The back-off re-queue calls resetFailoverStep before re-spawning, so the
      // retry starts at the primary again (codex) once the provider is back.
      resetFailoverStep(AGENT);
      expect(getFailoverStepIndex(AGENT)).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
