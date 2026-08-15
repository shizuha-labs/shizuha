import { describe, expect, it } from 'vitest';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import type { Message } from '../../src/agent/types.js';

type BudgetInspection = {
  exceeded: boolean;
  promptTokens: number;
  targetTokens: number;
};

function inspect(
  messages: Message[],
  maxContextTokens: number,
  outputBudget: number,
  reportedPromptTokens = 0,
): BudgetInspection {
  return (AgentProcess as unknown as {
    inspectContextBudget: (
      messages: Message[],
      model: string,
      maxContextTokens: number,
      systemPrompt: string,
      toolDefs: unknown[],
      outputBudget: number,
      reportedPromptTokens?: number,
    ) => BudgetInspection;
  }).inspectContextBudget(
    messages,
    'cortex/DeepSeek-V4-Flash',
    maxContextTokens,
    'system prompt',
    [],
    outputBudget,
    reportedPromptTokens,
  );
}

describe('AgentProcess read-only context-budget assertion', () => {
  it('reports a fitting transcript without returning a rewritten projection', () => {
    const messages: Message[] = [{ role: 'user', content: 'stable history '.repeat(2_000) }];
    const result = inspect(messages, 262_144, 16_384);

    expect(result.exceeded).toBe(false);
    expect(result.promptTokens).toBeLessThanOrEqual(result.targetTokens);
    expect(result).not.toHaveProperty('messages');
    expect(result).not.toHaveProperty('trimmed');
  });

  it('detects oversized wire payloads but cannot delete or truncate them', () => {
    const imageBase64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'.repeat(4_000);
    const messages: Message[] = [{
      role: 'user',
      content: [{
        type: 'tool_result',
        toolUseId: 'shot-1',
        content: 'screenshot captured',
        image: { base64: imageBase64, mediaType: 'image/png' },
      }],
    }];
    const before = structuredClone(messages);
    const result = inspect(messages, 32_768, 4_096);

    expect(result.exceeded).toBe(true);
    expect(result.promptTokens).toBeGreaterThan(result.targetTokens);
    expect(messages).toEqual(before);
    expect(JSON.stringify(messages)).toContain(imageBase64);
  });

  it('uses provider truth to avoid false positives without authorizing a rewrite', () => {
    const dense = 'benchmark transcript token stream '.repeat(340);
    const messages: Message[] = Array.from({ length: 120 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${index}\n${dense}`,
    }));

    expect(inspect(messages, 262_144, 32_000, 0).exceeded).toBe(true);
    const anchored = inspect(messages, 262_144, 32_000, 104_000);
    expect(anchored.exceeded).toBe(false);
    expect(anchored.promptTokens).toBeLessThanOrEqual(anchored.targetTokens);
  });
});
