import { describe, expect, it } from 'vitest';
import { resolveModelContextWindow } from '../../src/provider/context-window.js';

describe('resolveModelContextWindow', () => {
  it('returns codex/openai model-specific windows', () => {
    expect(resolveModelContextWindow('gpt-5.4', 128000)).toBe(272000);
    expect(resolveModelContextWindow('codex-mini-latest', 128000)).toBe(192000);
  });

  it('returns claude model windows', () => {
    expect(resolveModelContextWindow('claude-opus-4.6', 128000)).toBe(1000000);
  });

  it('falls back to provider default for unknown models', () => {
    expect(resolveModelContextWindow('unknown-model', 123456)).toBe(123456);
  });
});
