import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, getLastContextBudget } from '../../src/prompt/builder.js';

// EVOL-15: the composed per-turn system context is measured in tokens and
// compared to a fraction of the model's window — warn at 20%, fail at 25%
// (doctrine ccdd36e0), resolved per-model from nativeContextWindow. Warn-only v1.
describe('EVOL-15 context-budget telemetry', () => {
  it('records a report with thresholds derived from the model window', async () => {
    await buildSystemPrompt({ cwd: process.cwd(), tools: [], model: 'GLM-4.7' });
    const r = getLastContextBudget();
    expect(r).not.toBeNull();
    // GLM-4.7 profile window = 131072
    expect(r!.contextWindow).toBe(131072);
    expect(r!.warnTokens).toBe(Math.round(131072 * 0.20));
    expect(r!.failTokens).toBe(Math.round(131072 * 0.25));
    expect(r!.totalTokens).toBe(r!.systemPromptTokens + r!.toolSchemaTokens);
    expect(typeof r!.systemPromptTokens).toBe('number');
  });

  it('flags overWarn when tool schemas blow the 20% budget', async () => {
    // ~200K chars of tool-schema text ≈ tens of thousands of tokens — past 20% of 131072.
    const bigDesc = 'x'.repeat(200_000);
    const tools = [{
      name: 'big_tool', description: bigDesc,
      parameters: { type: 'object', properties: {} },
    }] as any;
    await buildSystemPrompt({ cwd: process.cwd(), tools, model: 'GLM-4.7' });
    const r = getLastContextBudget();
    expect(r!.toolSchemaTokens).toBeGreaterThan(0);
    expect(r!.totalTokens).toBeGreaterThan(r!.warnTokens);
    expect(r!.overWarn).toBe(true);
  });

  it('stays under budget for a lean prompt with no tools', async () => {
    await buildSystemPrompt({ cwd: process.cwd(), tools: [], model: 'GLM-4.7' });
    const r = getLastContextBudget();
    expect(r!.overWarn).toBe(false);
  });
});
