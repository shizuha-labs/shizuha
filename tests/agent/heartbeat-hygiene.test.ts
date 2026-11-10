import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/agent/types.js';
import {
  applyHeartbeatHardBudgetTrim,
  classifyPromptSource,
  estimatePromptTokenBudget,
  heartbeatBudgetConfig,
  isToolResultMessage,
  keepHeartbeatNudgeOnly,
  trimMessagesToTokenBudget,
  resolveContextPreflightGuardTokens,
  resolveInteractivePreflightCeilingTokens,
} from '../../src/agent/heartbeat-hygiene.js';
import { TurnTelemetryWindow, recordTurnTelemetry } from '../../src/telemetry/turn-telemetry.js';

function msg(role: 'user' | 'assistant', content: string): Message {
  return { role, content, timestamp: Date.now() };
}

describe('heartbeat context hygiene', () => {
  it('keeps only the current heartbeat nudge when a hard-budget reset fires', () => {
    const heartbeat = msg('user', '[HEARTBEAT] You have been idle. Call pulse_get_my_alerts');
    const history = [
      msg('user', 'please explain this code'),
      msg('assistant', 'sure'),
      heartbeat,
    ];
    expect(keepHeartbeatNudgeOnly(history)).toEqual([heartbeat]);
    expect(keepHeartbeatNudgeOnly([msg('user', 'please explain this code')])).toEqual([]);
    expect(keepHeartbeatNudgeOnly([])).toEqual([]);
  });

  it('trims oldest messages until the hard budget fits, else the heartbeat nudge', () => {
    const heartbeat = msg('user', '[HEARTBEAT] check pulse');
    const history = [
      msg('user', 'x'.repeat(50)),
      msg('assistant', 'y'.repeat(50)),
      heartbeat,
    ];
    const estimate = (candidate: Message[]) => candidate.reduce((n, m) => n + String(m.content).length, 0);
    const dropped = trimMessagesToTokenBudget(history, 80, estimate);
    expect(dropped.trimmed).toBe(true);
    expect(dropped.messages[0]).toEqual(heartbeat);
    const alreadyFit = trimMessagesToTokenBudget([heartbeat], 10_000, estimate);
    expect(alreadyFit.trimmed).toBe(false);
    expect(alreadyFit.messages).toEqual([heartbeat]);
  });

  it('classifies scheduler heartbeat prompts separately from user turns', () => {
    expect(classifyPromptSource([msg('user', '[HEARTBEAT] Automatic sync')])).toBe('heartbeat');
    expect(classifyPromptSource([msg('user', 'please explain this code')])).toBe('user');
  });

  it('defaults to bounded ABSOLUTE budgets when the window is known (PLAT-9203)', () => {
    // PLAT-9203: the fraction default let eternal sessions ratchet below the
    // window-proportional thresholds (aoi 173K→187K on a 272K model — soft
    // 0.70×272K≈190K, trigger 0.75×272K≈204K, compaction never engaged).
    // The default posture is now bounded absolute: soft 120K / hard 160K.
    expect(heartbeatBudgetConfig(272_000, {} as NodeJS.ProcessEnv)).toEqual({
      softBudgetTokens: 120_000,
      hardBudgetTokens: 160_000,
    });
    // Env token overrides still win over the eternal defaults.
    expect(heartbeatBudgetConfig(272_000, {
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS: '80000',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS: '100000',
    } as unknown as NodeJS.ProcessEnv)).toEqual({ softBudgetTokens: 80_000, hardBudgetTokens: 100_000 });
  });

  it('restores window-fraction budgets only via mode=proportional', () => {
    // Legacy opt-in: 512K DeepSeek soft 0.70 / hard 0.85.
    expect(heartbeatBudgetConfig(524_288, {
      SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE: 'proportional',
    } as unknown as NodeJS.ProcessEnv)).toEqual({
      softBudgetTokens: Math.floor(524_288 * 0.70),
      hardBudgetTokens: Math.floor(524_288 * 0.85),
    });
    expect(heartbeatBudgetConfig(524_288, {
      SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE: 'proportional',
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_FRACTION: '0.6',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_FRACTION: '0.9',
    } as unknown as NodeJS.ProcessEnv)).toEqual({
      softBudgetTokens: Math.floor(524_288 * 0.6),
      hardBudgetTokens: Math.floor(524_288 * 0.9),
    });
  });

  it('proportional mode ignores leftover 80k/100k token pins (legacy parity)', () => {
    // Live fleet daemon + Hive pods set BOTH fractions and 80k/100k tokens.
    // In proportional mode the fractions still win (2026-08-17 parity).
    expect(heartbeatBudgetConfig(524_288, {
      SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE: 'proportional',
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_FRACTION: '0.70',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_FRACTION: '0.85',
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS: '80000',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS: '100000',
    } as unknown as NodeJS.ProcessEnv)).toEqual({
      softBudgetTokens: Math.floor(524_288 * 0.70),
      hardBudgetTokens: Math.floor(524_288 * 0.85),
    });
  });

  it('uses the audited 30K/45K absolute fallbacks when the window is unknown', () => {
    expect(heartbeatBudgetConfig(undefined, {} as NodeJS.ProcessEnv)).toEqual({
      softBudgetTokens: 30_000,
      hardBudgetTokens: 45_000,
    });
    expect(heartbeatBudgetConfig(undefined, {
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS: '10',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS: '5',
    } as unknown as NodeJS.ProcessEnv)).toEqual({ softBudgetTokens: 10, hardBudgetTokens: 10 });
    expect(heartbeatBudgetConfig(100_000, {
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS: '80000',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS: '100000',
    } as unknown as NodeJS.ProcessEnv)).toEqual({ softBudgetTokens: 80_000, hardBudgetTokens: 100_000 });
  });

  it('uses an adaptive final preflight guard for provider calls', () => {
    expect(resolveContextPreflightGuardTokens(8_192, {} as NodeJS.ProcessEnv)).toBe(1_024);
    expect(resolveContextPreflightGuardTokens(32_768, {} as NodeJS.ProcessEnv)).toBe(4_096);
    expect(resolveContextPreflightGuardTokens(262_144, {} as NodeJS.ProcessEnv)).toBe(32_768);
    expect(resolveContextPreflightGuardTokens(1_000_000, {} as NodeJS.ProcessEnv)).toBe(65_536);
    expect(resolveContextPreflightGuardTokens(262_144, {
      SHIZUHA_TUI_PREFLIGHT_GUARD_TOKENS: '12345',
    } as NodeJS.ProcessEnv)).toBe(12_345);
  });

  it('caps large interactive prompts as a fraction of the announced window', () => {
    // 512k → 0.70 default = 367001; still under contextCeiling.
    expect(resolveInteractivePreflightCeilingTokens(524_288, 1_024, 32_768, {} as NodeJS.ProcessEnv))
      .toBe(Math.floor(524_288 * 0.70));
    expect(resolveInteractivePreflightCeilingTokens(131_072, 1_024, 16_384, {} as NodeJS.ProcessEnv))
      .toBe(113_664);
    expect(resolveInteractivePreflightCeilingTokens(262_144, 1_024, 32_768, {
      SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS: '180000',
    } as NodeJS.ProcessEnv)).toBe(180_000);
    expect(resolveInteractivePreflightCeilingTokens(262_144, 1_024, 32_768, {
      SHIZUHA_TUI_PREFLIGHT_TARGET_TOKENS: '999999',
    } as NodeJS.ProcessEnv)).toBe(228_352);
  });

  it('estimates prompt budget with source and overhead breakdowns', () => {
    const estimate = estimatePromptTokenBudget({
      messages: [msg('user', '[Heartbeat] check queue')],
      systemPrompt: 'system instructions',
      toolDefs: [{ name: 'pulse_get_my_tasks', description: 'queue', inputSchema: { type: 'object' } }],
      model: 'cortex/test-model',
    });

    expect(estimate.sourceKind).toBe('heartbeat');
    expect(estimate.promptTokenEstimate).toBeGreaterThan(0);
    expect(estimate.systemOverheadTokens).toBeGreaterThan(0);
    expect(estimate.messageTokens).toBeGreaterThan(0);
    expect(estimate.toolDefinitionTokens).toBeGreaterThan(0);
  });

  it('records prompt budget and compaction action in turn telemetry', () => {
    const window = new TurnTelemetryWindow();
    recordTurnTelemetry({
      window,
      result: { toolCalls: [], toolResults: [], inputTokens: 10, outputTokens: 2, ttftMs: 31000, decodeTokensPerSec: null },
      providerName: 'cortex',
      runId: 'run',
      turnIndex: 0,
      model: 'cortex/test-model',
      turnDurationMs: 32000,
      promptBudget: {
        promptTokenEstimate: 120000,
        systemOverheadTokens: 20000,
        messageTokens: 90000,
        toolDefinitionTokens: 10000,
        sourceKind: 'heartbeat',
      },
      compactionAction: 'compact',
      preProviderBudgetExceeded: true,
    });

    expect(window.query()[0]).toMatchObject({
      promptTokenEstimate: 120000,
      sourceKind: 'heartbeat',
      compactionAction: 'compact',
      preProviderBudgetExceeded: true,
    });
  });

  // PLAT-9203 re-review (ren CR P1): the oldest-first kept.shift() loop stops
  // on a token boundary, not a tool-pair boundary. When the fit boundary lands
  // inside a tool pair, the pre-fix loop left an orphaned tool_result at the
  // kept head (Anthropic-style providers reject that with a 400).
  it('drops orphaned kept-head tool_result when the fit boundary lands inside a tool pair', () => {
    const heartbeat = msg('user', '[HEARTBEAT] check pulse');
    const toolUse: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'pulse_get_my_tasks', input: {} }],
      timestamp: Date.now(),
    };
    const toolResult: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'r'.repeat(40) }],
      timestamp: Date.now(),
    };
    const filler = msg('user', 'f'.repeat(40));
    const history = [filler, toolUse, toolResult, heartbeat];
    const size = (m: Message) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length);
    const estimate = (candidate: Message[]) => candidate.reduce((n, m) => n + size(m), 0);
    // Budget fits [toolResult, heartbeat] but not [toolUse, toolResult, heartbeat]:
    // the shift loop stops exactly between toolUse and toolResult.
    const toolUseSize = size(toolUse);
    const budget = size(toolResult) + size(heartbeat) + 1;
    expect(estimate([toolResult, heartbeat])).toBeLessThanOrEqual(budget);
    expect(estimate([toolUse, toolResult, heartbeat])).toBeGreaterThan(budget);
    const trimmed = trimMessagesToTokenBudget(history, budget, estimate);
    expect(trimmed.trimmed).toBe(true);
    // Pre-fix: kept head was the orphaned tool_result (its tool_use shifted
    // away). Post-fix: pair-complete head — no leading tool_result remains.
    expect(isToolResultMessage(trimmed.messages[0])).toBe(false);
    expect(trimmed.messages).toEqual([heartbeat]);
  });

  it('keeps the single over-budget non-nudge tail instead of wiping a non-heartbeat transcript', () => {
    const bigUser = msg('user', 'z'.repeat(200));
    const trimmed = trimMessagesToTokenBudget([bigUser], 50, (c) => c.reduce((n, m) => n + String(m.content).length, 0));
    expect(trimmed.trimmed).toBe(true);
    expect(trimmed.messages).toEqual([bigUser]);
  });

  it('pins an over-budget heartbeat nudge (fall-through) so the operative instruction survives', () => {
    const hugeNudge = msg('user', `[HEARTBEAT] ${'n'.repeat(200)}`);
    const trimmed = trimMessagesToTokenBudget([hugeNudge], 50, (c) => c.reduce((n, m) => n + String(m.content).length, 0));
    expect(trimmed.trimmed).toBe(true);
    expect(trimmed.messages).toEqual([hugeNudge]);
  });

  it('applyHeartbeatHardBudgetTrim unifies both turn paths (trim, persist, heartbeat-only)', () => {
    const heartbeat = msg('user', '[HEARTBEAT] check pulse');
    const history = [msg('user', 'x'.repeat(100)), heartbeat];
    const estimate = (candidate: Message[]) => candidate.reduce((n, m) => n + String(m.content).length, 0);
    const persisted: Array<[string, Message[]]> = [];
    const live = history.slice();
    const out = applyHeartbeatHardBudgetTrim({
      messages: live,
      sessionId: 'sess-1',
      sourceKind: 'heartbeat',
      hardBudgetTokens: 60,
      estimate,
      replaceMessages: (sid, next) => persisted.push([sid, next]),
      turnIndex: 3,
    });
    expect(out.trimmed).toBe(true);
    // In-place: the caller's live array reference now holds the trimmed head.
    expect(live).toEqual([heartbeat]);
    expect(persisted).toEqual([['sess-1', live]]);
    // Non-heartbeat turns are never trimmed by the shared reset.
    const interactive = [msg('user', 'y'.repeat(100))];
    expect(applyHeartbeatHardBudgetTrim({
      messages: interactive,
      sessionId: 'sess-2',
      sourceKind: 'user',
      hardBudgetTokens: 10,
      estimate,
      replaceMessages: () => { throw new Error('must not persist'); },
    })).toEqual({ trimmed: false });
    // Already-fitting heartbeat is a no-op.
    const fits = [heartbeat];
    expect(applyHeartbeatHardBudgetTrim({
      messages: fits,
      sessionId: 'sess-3',
      sourceKind: 'heartbeat',
      hardBudgetTokens: 10_000,
      estimate,
      replaceMessages: () => { throw new Error('must not persist'); },
    })).toEqual({ trimmed: false });
  });
});
