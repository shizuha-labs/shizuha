import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  decideEmptyTurnExhaustionAction,
  evaluateEmptyTurnFailoverTrigger,
  firstDistinctFallbackStep,
  isStickyProviderOutageReason,
  loadLocalCodexRateLimitRecoveryAccounts,
  shouldClearLegacyEmptyTurnMarker,
} from '../../src/codex-bridge/index.js';

// PLAT-2946: when a codex agent empty-turn-wedges on a usage-limited org and no
// alternate codex account can rotate in, the bridge must fail over to the configured
// non-codex fallback (claude-sonnet-4-6) via exit(42) — but must NOT churn for a
// codex-only agent with no distinct fallback (PLAT-906/PLAT-1136 restart-churn guard).
// These pure helpers drive that decision; the private
// failoverToConfiguredFallbackOnExhaustion() is thin glue over decideEmptyTurnExhaustionAction.

const SORA_CHAIN = JSON.stringify([
  { method: 'codex_app_server', model: 'gpt-5.5', reasoningEffort: 'xhigh' },
  { method: 'claude_code_server', model: 'claude-sonnet-4-6', reasoningEffort: 'high', thinkingLevel: 'on' },
]);

describe('firstDistinctFallbackStep (PLAT-2946)', () => {
  it('returns the claude step for a wedged codex agent (current→claude chain)', () => {
    expect(firstDistinctFallbackStep(SORA_CHAIN, 'gpt-5.5')).toEqual({
      method: 'claude_code_server',
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'high',
      thinkingLevel: 'on',
    });
  });

  it('returns null when missing env (no chain configured)', () => {
    expect(firstDistinctFallbackStep(undefined, 'gpt-5.5')).toBeNull();
    expect(firstDistinctFallbackStep(null, 'gpt-5.5')).toBeNull();
    expect(firstDistinctFallbackStep('', 'gpt-5.5')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(firstDistinctFallbackStep('{not json', 'gpt-5.5')).toBeNull();
  });

  it('returns null when the value is not a chain array', () => {
    expect(firstDistinctFallbackStep('{"method":"codex_app_server","model":"gpt-5.5"}', 'gpt-5.5')).toBeNull();
  });

  it('returns null when every configured step is the current (wedged) model', () => {
    const codexOnly = JSON.stringify([
      { method: 'codex_app_server', model: 'gpt-5.5' },
      { method: 'codex_app_server', model: 'GPT-5.5' }, // case-insensitive match → still current
    ]);
    expect(firstDistinctFallbackStep(codexOnly, 'gpt-5.5')).toBeNull();
  });

  it('advances to the first DIFFERENT model even if it is another codex model', () => {
    const chain = JSON.stringify([
      { method: 'codex_app_server', model: 'gpt-5.5' },
      { method: 'codex_app_server', model: 'gpt-5.3-codex-spark' },
      { method: 'claude_code_server', model: 'claude-sonnet-4-6' },
    ]);
    expect(firstDistinctFallbackStep(chain, 'gpt-5.5')).toEqual({
      method: 'codex_app_server',
      model: 'gpt-5.3-codex-spark',
    });
  });

  it('skips steps with no/blank model', () => {
    const chain = JSON.stringify([
      { method: 'codex_app_server' },
      { method: 'claude_code_server', model: 'claude-sonnet-4-6' },
    ]);
    expect(firstDistinctFallbackStep(chain, 'gpt-5.5')).toEqual({
      method: 'claude_code_server',
      model: 'claude-sonnet-4-6',
    });
  });
});

describe('decideEmptyTurnExhaustionAction (PLAT-2946)', () => {
  it('FAILS OVER when a distinct fallback exists (exit-42 path)', () => {
    const action = decideEmptyTurnExhaustionAction(SORA_CHAIN, 'gpt-5.5');
    expect(action.kind).toBe('failover');
    if (action.kind === 'failover') {
      expect(action.step.method).toBe('claude_code_server');
      expect(action.step.model).toBe('claude-sonnet-4-6');
    }
  });

  it('STAYS ALIVE for a codex-only agent with no distinct fallback (soft recovery, not exit-43)', () => {
    const codexOnly = JSON.stringify([{ method: 'codex_app_server', model: 'gpt-5.5' }]);
    expect(decideEmptyTurnExhaustionAction(codexOnly, 'gpt-5.5')).toEqual({ kind: 'stay-alive' });
  });

  it('STAYS ALIVE when no chain is configured at all', () => {
    expect(decideEmptyTurnExhaustionAction(undefined, 'gpt-5.5')).toEqual({ kind: 'stay-alive' });
  });
});

describe('sticky provider outage reasons (human model)', () => {
  it('rejects empty-turn exhausted as sticky outage', () => {
    expect(isStickyProviderOutageReason('empty-turn exhausted on gpt-5.6-sol; no distinct fallback configured')).toBe(false);
    expect(shouldClearLegacyEmptyTurnMarker('empty-turn exhausted on gpt-5.6-sol; no distinct fallback configured')).toBe(true);
  });

  it('accepts real rate-limit / pool reasons as sticky', () => {
    expect(isStickyProviderOutageReason('rate_limit: usage limit reached')).toBe(true);
    expect(isStickyProviderOutageReason('claude-token-pool-exhausted')).toBe(true);
    expect(isStickyProviderOutageReason('HTTP 429 from ChatGPT')).toBe(true);
  });
});

// PLAT-2946 case (iv) — aoi's required P1-iv. The exporter (deploy repo) can restart
// a wedged codex bridge in-place, resetting the fresh process's empty-turn/rotation
// counters. Closing the cross-process race (exporter must defer to exit-42 for a
// sustained wedge with a distinct fallback) is the EXPORTER's half. The BRIDGE's
// guarantee, proven here: the failover decision is DETERMINISTIC and IDEMPOTENT — a
// wedged chain always resolves to the SAME exit-42 target and never oscillates back
// to stay-alive. So every fresh bridge lifetime that reaches the compound trigger
// converges to exit-42; the bridge never resets itself into an infinite loop.
describe('empty-turn failover convergence (PLAT-2946 case iv)', () => {
  it('is deterministic across repeated evaluations — same wedged chain → same exit-42 target, never flips to stay-alive', () => {
    const results = Array.from({ length: 50 }, () => decideEmptyTurnExhaustionAction(SORA_CHAIN, 'gpt-5.5'));
    // Every evaluation converges to the identical failover step (no oscillation).
    for (const r of results) {
      expect(r.kind).toBe('failover');
      if (r.kind === 'failover') {
        expect(r.step.method).toBe('claude_code_server');
        expect(r.step.model).toBe('claude-sonnet-4-6');
      }
    }
    // Simulate successive restarted-then-immediately-empty bridge lifetimes: each
    // fresh process re-derives the SAME decision from the daemon-provided chain +
    // its running model, so restarts can't reset the outcome into a different branch.
    const acrossRestarts = [
      decideEmptyTurnExhaustionAction(SORA_CHAIN, 'gpt-5.5'),
      decideEmptyTurnExhaustionAction(SORA_CHAIN, 'gpt-5.5'),
      decideEmptyTurnExhaustionAction(SORA_CHAIN, 'gpt-5.5'),
    ];
    expect(acrossRestarts.every((r) => r.kind === 'failover')).toBe(true);
  });

  it('a codex-only wedged agent is deterministically stay-alive across restarts — no exit-42 churn loop', () => {
    const codexOnly = JSON.stringify([{ method: 'codex_app_server', model: 'gpt-5.5' }]);
    const results = Array.from({ length: 20 }, () => decideEmptyTurnExhaustionAction(codexOnly, 'gpt-5.5'));
    expect(results.every((r) => r.kind === 'stay-alive')).toBe(true);
  });

  it('re-advance: the exit-42 gate still fires from a peer codex model (never stay-alive) — the daemon owns the ordered target', () => {
    const chain = JSON.stringify([
      { method: 'codex_app_server', model: 'gpt-5.5' },
      { method: 'codex_app_server', model: 'gpt-5.3-codex-spark' },
      { method: 'claude_code_server', model: 'claude-sonnet-4-6' },
    ]);
    // From the first codex model a distinct fallback exists → failover fires.
    expect(decideEmptyTurnExhaustionAction(chain, 'gpt-5.5').kind).toBe('failover');
    // From the PEER codex model a distinct fallback STILL exists → failover still
    // fires (never flips to stay-alive), so exit-42 hands back to the daemon whose
    // index-based advanceFailoverStep walks the chain forward to the claude step.
    // firstDistinctFallbackStep is a GATE ("a distinct target exists?"), matched by
    // model — it does NOT model the daemon's index ordering, so the target it names
    // for the log is best-effort; the guarantee under test is convergence, not order.
    const fromPeer = decideEmptyTurnExhaustionAction(chain, 'gpt-5.3-codex-spark');
    expect(fromPeer.kind).toBe('failover');
    if (fromPeer.kind === 'failover') {
      expect(fromPeer.step.model).not.toBe('gpt-5.3-codex-spark'); // distinct from the wedged model
    }
  });
});

describe('HIVE-586 broker-mode rate-limit recovery authority', () => {
  const originalHome = process.env['HOME'];
  const originalSocket = process.env['MCP_AUTH_PROXY_SOCKET'];
  const originalRequired = process.env['CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'];
  let tmpHome = '';

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (originalSocket === undefined) delete process.env['MCP_AUTH_PROXY_SOCKET'];
    else process.env['MCP_AUTH_PROXY_SOCKET'] = originalSocket;
    if (originalRequired === undefined) delete process.env['CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'];
    else process.env['CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'] = originalRequired;
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('does not read or expose a poisoned host account pool when broker mode is expected', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-586-codex-bridge-'));
    process.env['HOME'] = tmpHome;
    delete process.env['MCP_AUTH_PROXY_SOCKET'];
    process.env['CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'] = '1';
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'credentials.json'), JSON.stringify({
      codex: { accounts: [{
        email: 'poison@host.invalid',
        accessToken: 'poison-access',
        refreshToken: 'poison-refresh',
        accountId: 'poison-account',
      }] },
    }));

    expect(loadLocalCodexRateLimitRecoveryAccounts()).toEqual([]);
  });
});

describe('evaluateEmptyTurnFailoverTrigger (PLAT-4033 flapping provider)', () => {
  const cfg = {
    consecutiveThreshold: 3,
    windowMs: 10 * 60 * 1000,
    windowMinTurns: 4,
    windowMinEmptyTurns: 3,
    windowFractionThreshold: 0.5,
  };

  it('keeps the existing consecutive-empty trigger for hard wedges', () => {
    const now = 1_000_000;
    const trigger = evaluateEmptyTurnFailoverTrigger([
      { ts: now - 2_000, empty: true },
      { ts: now - 1_000, empty: true },
      { ts: now, empty: true },
    ], now, 3, cfg);
    expect(trigger).toEqual({ kind: 'consecutive', consecutiveEmptyTurns: 3, threshold: 3 });
  });

  it('triggers on a rolling-window empty fraction even when a productive turn reset the streak', () => {
    const now = 1_000_000;
    const trigger = evaluateEmptyTurnFailoverTrigger([
      { ts: now - 4_000, empty: true },
      { ts: now - 3_000, empty: true },
      { ts: now - 2_000, empty: false },
      { ts: now - 1_000, empty: true },
    ], now, 1, cfg);
    expect(trigger).toMatchObject({
      kind: 'window',
      windowMs: cfg.windowMs,
      totalTurns: 4,
      emptyTurns: 3,
      threshold: 0.5,
      minTurns: 4,
      minEmptyTurns: 3,
    });
    if (trigger?.kind === 'window') {
      expect(trigger.emptyFraction).toBe(0.75);
    }
  });

  it('does not trigger on sparse or old empty turns below the window gates', () => {
    const now = 1_000_000;
    expect(evaluateEmptyTurnFailoverTrigger([
      { ts: now - 20 * 60 * 1000, empty: true },
      { ts: now - 4_000, empty: true },
      { ts: now - 3_000, empty: false },
      { ts: now - 2_000, empty: true },
    ], now, 1, cfg)).toBeNull();

    expect(evaluateEmptyTurnFailoverTrigger([
      { ts: now - 4_000, empty: true },
      { ts: now - 3_000, empty: false },
      { ts: now - 2_000, empty: false },
      { ts: now - 1_000, empty: true },
    ], now, 1, cfg)).toBeNull();
  });
});
