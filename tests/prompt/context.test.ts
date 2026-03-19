import { describe, it, expect } from 'vitest';
import { estimateTokens, needsCompaction, getSafetyFactor } from '../../src/prompt/context.js';
import type { Message } from '../../src/agent/types.js';

describe('estimateTokens', () => {
  it('counts tokens for a string content message', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello, how are you?' },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts tokens for text content blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I am doing well.' }],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts tool_use blocks by serializing them', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc1', name: 'read', input: { file_path: '/tmp/test.txt' } },
        ],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts tool_result blocks with text content', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tc1', content: 'File contents here' },
        ],
      },
    ];
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('adds IMAGE_TOKEN_ESTIMATE (1600) for images in tool_result', () => {
    const textOnly: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tc1', content: 'Image caption' },
        ],
      },
    ];
    const withImage: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tc1',
            content: 'Image caption',
            image: { base64: 'abc', mediaType: 'image/png' as const },
          },
        ],
      },
    ];
    const textTokens = estimateTokens(textOnly);
    const imageTokens = estimateTokens(withImage);
    // Image version should be ~1600 tokens more
    expect(imageTokens - textTokens).toBeGreaterThanOrEqual(1500);
    expect(imageTokens - textTokens).toBeLessThanOrEqual(1700);
  });

  it('returns 0 for empty messages array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('sums tokens across multiple messages', () => {
    const one: Message[] = [{ role: 'user', content: 'Hello' }];
    const two: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'World' },
    ];
    const oneTokens = estimateTokens(one);
    const twoTokens = estimateTokens(two);
    expect(twoTokens).toBeGreaterThan(oneTokens);
  });
});

describe('needsCompaction', () => {
  // needsCompaction applies a 1.35x safety factor to tiktoken estimates
  // (accounting for ~35% undercount vs Anthropic tokenizer), then checks
  // if the adjusted estimate exceeds 90% of maxTokens.
  // Effective threshold in raw tiktoken terms: maxTokens * 0.90 / 1.35 ≈ maxTokens * 0.667
  const SAFETY_FACTOR = 1.35;
  const THRESHOLD = 0.90;

  it('returns false when below effective threshold', () => {
    // Single short message — way below any reasonable threshold
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    expect(needsCompaction(messages, 200000)).toBe(false);
  });

  it('returns true when above effective threshold', () => {
    // Create enough messages to exceed threshold after safety factor
    const longText = 'word '.repeat(5000); // ~5000 tokens
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    // 20 messages * ~5000 tokens = ~100K raw → *1.35 = ~135K; 90% of 100K = 90K → triggers
    expect(needsCompaction(messages, 100000)).toBe(true);
  });

  it('handles boundary with safety factor', () => {
    // needsCompaction: ceil(rawEstimate * 1.35) > maxTokens * 0.90
    const messages: Message[] = [{ role: 'user', content: 'a' }];
    const rawTokens = estimateTokens(messages);
    // Set maxTokens so rawTokens * 1.35 == maxTokens * 0.90 (at boundary)
    const adjustedTokens = Math.ceil(rawTokens * SAFETY_FACTOR);
    const maxTokens = Math.ceil(adjustedTokens / THRESHOLD);
    // At exact boundary, adjusted <= maxTokens * 0.90 → false
    expect(needsCompaction(messages, maxTokens)).toBe(false);
    // Just below → triggers
    expect(needsCompaction(messages, maxTokens - 1)).toBe(true);
  });

  it('accounts for overhead tokens in compaction threshold', () => {
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    const rawTokens = estimateTokens(messages);
    // Without overhead: well below threshold
    expect(needsCompaction(messages, 200000)).toBe(false);
    // With overhead pushing adjusted total above 90% of 200K (= 180K):
    // Need (rawTokens + overhead) * 1.35 > 180000
    // → overhead > 180000 / 1.35 - rawTokens ≈ 133333 - rawTokens
    const overhead = Math.ceil(200000 * THRESHOLD / SAFETY_FACTOR) - rawTokens + 1;
    expect(needsCompaction(messages, 200000, undefined, overhead)).toBe(true);
  });

  it('uses 1.2x safety factor for llamacpp models (Qwen/Llama tokenizer mismatch)', () => {
    // tiktoken undercounts vs Qwen/Llama tokenizers by ~15-20%. Use 1.2x.
    const longText = 'word '.repeat(5000); // ~5000 tokens
    const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    // ~30K raw tokens. With 1.2x factor: 36K. 90% of 32768 = 29491.
    // 36K > 29491 → should trigger compaction at 32K context.
    expect(needsCompaction(messages, 32768, 'llamacpp/local')).toBe(true);
    // 90% of 40K = 36K. 30K * 1.2 = 36K ≥ 36K → triggers.
    expect(needsCompaction(messages, 40000, 'llamacpp/local')).toBe(true);
    // 90% of 45K = 40.5K. 30K * 1.2 = 36K < 40.5K → does NOT trigger.
    expect(needsCompaction(messages, 45000, 'llamacpp/local')).toBe(false);
  });

  it('uses 1.35x safety factor for Claude models', () => {
    const longText = 'word '.repeat(5000); // ~5000 tokens
    const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: longText,
    }));
    // ~30K raw tokens. With 1.35x: ~40.5K. 90% of 50K = 45K.
    // Should NOT trigger at 50K context (40.5K < 45K).
    expect(needsCompaction(messages, 50000, 'claude-sonnet-4-6')).toBe(false);
    // 90% of 40K = 36K. 30K * 1.35 = 40.5K > 36K → triggers.
    expect(needsCompaction(messages, 40000, 'claude-sonnet-4-6')).toBe(true);
  });
});

describe('getSafetyFactor', () => {
  it('returns 1.35 for Anthropic/Claude models', () => {
    expect(getSafetyFactor('claude-opus-4-6')).toBe(1.35);
    expect(getSafetyFactor('claude-sonnet-4-6')).toBe(1.35);
    expect(getSafetyFactor('claude-haiku-4-5-20251001')).toBe(1.35);
  });

  it('returns 1.0 for GPT/Codex/O-series models', () => {
    expect(getSafetyFactor('gpt-4.1')).toBe(1.0);
    expect(getSafetyFactor('gpt-5.3-codex')).toBe(1.0);
    expect(getSafetyFactor('codex-mini-latest')).toBe(1.0);
    expect(getSafetyFactor('o3-mini')).toBe(1.0);
    expect(getSafetyFactor('o4-mini')).toBe(1.0);
  });

  it('returns 1.2 for local models (llamacpp, ollama)', () => {
    expect(getSafetyFactor('llamacpp/local')).toBe(1.2);
    expect(getSafetyFactor('llamacpp/Qwen3.5-2B')).toBe(1.2);
    expect(getSafetyFactor('ollama/qwen3.5')).toBe(1.2);
    expect(getSafetyFactor('ollama/llama3.1')).toBe(1.2);
  });

  it('returns 1.35 (conservative) when model is undefined', () => {
    expect(getSafetyFactor(undefined)).toBe(1.35);
    expect(getSafetyFactor()).toBe(1.35);
  });

  it('returns 1.35 for unknown model names', () => {
    expect(getSafetyFactor('some-unknown-model')).toBe(1.35);
    expect(getSafetyFactor('mistral-large')).toBe(1.35);
  });
});
