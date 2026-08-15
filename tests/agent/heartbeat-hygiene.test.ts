import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/agent/types.js';
import {
  classifyPromptSource,
  estimatePromptTokenBudget,
  heartbeatBudgetConfig,
  resolveContextPreflightGuardTokens,
  resolveInteractivePreflightCeilingTokens,
} from '../../src/agent/heartbeat-hygiene.js';
import { TurnTelemetryWindow, recordTurnTelemetry } from '../../src/telemetry/turn-telemetry.js';

function msg(role: 'user' | 'assistant', content: string): Message {
  return { role, content, timestamp: Date.now() };
}

describe('heartbeat context hygiene', () => {
  it('classifies scheduler heartbeat prompts separately from user turns', () => {
    expect(classifyPromptSource([msg('user', '[HEARTBEAT] Automatic sync')])).toBe('heartbeat');
    expect(classifyPromptSource([msg('user', 'please explain this code')])).toBe('user');
  });

  it('uses fractional budgets of the announced window when known', () => {
    // 512K DeepSeek: soft 0.70 / hard 0.85 — not fixed 80k/100k.
    expect(heartbeatBudgetConfig(524_288, {} as NodeJS.ProcessEnv)).toEqual({
      softBudgetTokens: Math.floor(524_288 * 0.70),
      hardBudgetTokens: Math.floor(524_288 * 0.85),
    });
    expect(heartbeatBudgetConfig(524_288, {
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_FRACTION: '0.6',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_FRACTION: '0.9',
    } as unknown as NodeJS.ProcessEnv)).toEqual({
      softBudgetTokens: Math.floor(524_288 * 0.6),
      hardBudgetTokens: Math.floor(524_288 * 0.9),
    });
  });

  it('honors explicit absolute token budgets even when the window is known', () => {
    expect(heartbeatBudgetConfig(undefined, {} as NodeJS.ProcessEnv)).toEqual({
      softBudgetTokens: 30_000,
      hardBudgetTokens: 45_000,
    });
    expect(heartbeatBudgetConfig(undefined, {
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS: '10',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS: '5',
    } as unknown as NodeJS.ProcessEnv)).toEqual({ softBudgetTokens: 10, hardBudgetTokens: 10 });
    expect(heartbeatBudgetConfig(524_288, {
      SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS: '80000',
      SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS: '100000',
    } as unknown as NodeJS.ProcessEnv)).toEqual({ softBudgetTokens: 80_000, hardBudgetTokens: 100_000 });
    expect(heartbeatBudgetConfig(100_000, {
      SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE: 'absolute',
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
});
