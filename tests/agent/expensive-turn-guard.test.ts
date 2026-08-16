import { describe, it, expect } from 'vitest';

const {
  ExpensiveTurnGuard,
  estimatePrefillTokens,
  expensiveTurnGuardConfigFromEnv,
  expensiveTurnGuardNotifyUsername,
} = await import('../../src/agent/expensive-turn-guard.js');

const baseConfig = {
  enabled: true,
  windowMs: 60_000,
  minTurns: 4,
  minPromptTokens: 100_000,
  minPromptOutputRatio: 100,
  minProductiveOutputTokens: 32,
  baseBackoffMs: 1_000,
  maxBackoffMs: 8_000,
  notifyCooldownMs: 10_000,
  coldTtftMs: 15_000,
};

describe('estimatePrefillTokens', () => {
  it('uses cache_read when the prompt includes cached tokens', () => {
    expect(estimatePrefillTokens(
      { inputTokens: 120_000, cacheReadTokens: 115_000, cacheCreationTokens: 0 },
      null,
      baseConfig,
    )).toBe(5_000);
  });

  it('treats Anthropic-style input as already uncached when read > input', () => {
    expect(estimatePrefillTokens(
      { inputTokens: 4_000, cacheReadTokens: 110_000, cacheCreationTokens: 500 },
      null,
      baseConfig,
    )).toBe(4_500);
  });

  it('charges only the growth delta for an append-only session without cache stats', () => {
    expect(estimatePrefillTokens(
      { inputTokens: 125_000 },
      { inputTokens: 120_000, prefillTokens: 120_000 },
      baseConfig,
    )).toBe(5_000);
  });

  it('charges full input on plateau without cache stats (replay / re-prefill risk)', () => {
    expect(estimatePrefillTokens(
      { inputTokens: 120_000 },
      { inputTokens: 120_000, prefillTokens: 120_000 },
      baseConfig,
    )).toBe(120_000);
  });

  it('forces full charge on cold TTFT for large prompts', () => {
    expect(estimatePrefillTokens(
      { inputTokens: 125_000, ttftMs: 35_000 },
      { inputTokens: 120_000, prefillTokens: 5_000 },
      baseConfig,
    )).toBe(125_000);
  });

  it('forces full charge when prefix cache is busted', () => {
    expect(estimatePrefillTokens(
      { inputTokens: 125_000, prefixCacheBusted: true },
      { inputTokens: 120_000, prefillTokens: 5_000 },
      baseConfig,
    )).toBe(125_000);
  });
});

describe('ExpensiveTurnGuard', () => {
  it('does not trip for low-context busy work', () => {
    const guard = new ExpensiveTurnGuard(baseConfig);
    let decision: any = { action: 'ok' };
    for (let i = 0; i < 8; i++) {
      decision = guard.record({ now: i * 5_000, inputTokens: 20_000, outputTokens: 100 });
    }
    expect(decision.action).toBe('ok');
  });

  it('does not trip for genuine long-context work with small appends', () => {
    // Growing ~120k→140k session: only the first turn is a large prefill; the rest
    // are small suffixes. Must not force-pause a productive agent.
    const guard = new ExpensiveTurnGuard(baseConfig);
    let decision: any = { action: 'ok' };
    for (let i = 0; i < 8; i++) {
      decision = guard.record({
        now: i * 5_000,
        inputTokens: 120_000 + i * 3_000,
        outputTokens: 400,
      });
    }
    expect(decision.action).toBe('ok');
  });

  it('does not trip when most of a large prompt is a cache hit', () => {
    const guard = new ExpensiveTurnGuard(baseConfig);
    let decision: any = { action: 'ok' };
    for (let i = 0; i < 6; i++) {
      decision = guard.record({
        now: i * 8_000,
        inputTokens: 130_000,
        outputTokens: 200,
        cacheReadTokens: 125_000,
        cacheCreationTokens: 0,
      });
    }
    expect(decision.action).toBe('ok');
  });

  it('pauses after repeated sterile high-prefill plateaus (no tools, tiny text)', () => {
    const guard = new ExpensiveTurnGuard(baseConfig);
    for (let i = 0; i < 3; i++) {
      expect(guard.record({
        now: i * 10_000,
        inputTokens: 132_000,
        outputTokens: 10,
        toolCallCount: 0,
      }).action).toBe('ok');
    }
    const decision = guard.record({
      now: 30_000,
      inputTokens: 132_000,
      outputTokens: 10,
      toolCallCount: 0,
    });
    expect(decision.action).toBe('pause');
    if (decision.action !== 'pause') throw new Error('expected pause');
    expect(decision.turnCount).toBe(4);
    expect(decision.prefillTokens).toBeGreaterThanOrEqual(100_000 * 4);
    expect(decision.toolCallCount).toBe(0);
    expect(decision.backoffMs).toBe(1_000);
    expect(guard.remainingPauseMs(30_500)).toBe(500);
  });

  it('does not trip when high-prefill turns only issue tool calls (tiny text is fine)', () => {
    const guard = new ExpensiveTurnGuard(baseConfig);
    let decision: any = { action: 'ok' };
    for (let i = 0; i < 6; i++) {
      decision = guard.record({
        now: i * 8_000,
        inputTokens: 132_000,
        outputTokens: 20, // tool-call args only — normal agent shape
        toolCallCount: 2,
      });
    }
    expect(decision.action).toBe('ok');
  });

  it('does not trip when high-prefill turns produce substantive text without tools', () => {
    const guard = new ExpensiveTurnGuard(baseConfig);
    let decision: any = { action: 'ok' };
    for (let i = 0; i < 4; i++) {
      decision = guard.record({
        now: i * 10_000,
        inputTokens: 120_000,
        outputTokens: 3_000,
        toolCallCount: 0,
      });
    }
    expect(decision.action).toBe('ok');
  });

  it('reads thresholds and notify lead from environment', () => {
    const config = expensiveTurnGuardConfigFromEnv({
      SHIZUHA_EXPENSIVE_TURN_WINDOW_MS: '30000',
      SHIZUHA_EXPENSIVE_TURN_MIN_TURNS: '2',
      SHIZUHA_EXPENSIVE_TURN_PROMPT_TOKENS: '50000',
      SHIZUHA_EXPENSIVE_TURN_PROMPT_OUTPUT_RATIO: '42',
      SHIZUHA_EXPENSIVE_TURN_BACKOFF_MS: '1234',
      SHIZUHA_EXPENSIVE_TURN_MAX_BACKOFF_MS: '5678',
      SHIZUHA_EXPENSIVE_TURN_NOTIFY_COOLDOWN_MS: '9999',
      SHIZUHA_EXPENSIVE_TURN_COLD_TTFT_MS: '20000',
    } as any);
    expect(config).toMatchObject({
      windowMs: 30_000,
      minTurns: 2,
      minPromptTokens: 50_000,
      minPromptOutputRatio: 42,
      minProductiveOutputTokens: 32,
      baseBackoffMs: 1_234,
      maxBackoffMs: 5_678,
      notifyCooldownMs: 9_999,
      coldTtftMs: 20_000,
    });
    expect(expensiveTurnGuardNotifyUsername({ AGENT_TEAM: 'engineering' } as any)).toBe('ryo');
    expect(expensiveTurnGuardNotifyUsername({ SHIZUHA_EXPENSIVE_TURN_NOTIFY_USERNAME: 'aoi' } as any)).toBe('aoi');
  });

  it('falls back to effective source teams when AGENT_TEAM is missing (SCLI-345)', () => {
    expect(expensiveTurnGuardNotifyUsername({
      AGENT_EFFECTIVE_CAPABILITY_SOURCE_TEAMS: 'devops,architecture',
    } as any)).toBe('ichi');
  });
});
