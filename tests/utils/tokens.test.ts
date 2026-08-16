import { describe, it, expect } from 'vitest';
import { countTokens } from '../../src/utils/tokens.js';

describe('countTokens', () => {
  it('returns a positive number for non-empty text', () => {
    const count = countTokens('hello world');
    expect(count).toBeGreaterThan(0);
  });

  it('returns 0 for an empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('uses gpt-4o encoder for Claude models', () => {
    const a = countTokens('testing claude token count', 'claude-sonnet-4-20250514');
    const b = countTokens('testing claude token count', 'gpt-4o');
    // Both should map to the same tiktoken encoder, so identical counts
    expect(a).toBe(b);
  });

  it('maps gpt-4 model correctly', () => {
    const count = countTokens('hello world', 'gpt-4');
    expect(count).toBeGreaterThan(0);
  });

  it('falls back for unknown model names', () => {
    const count = countTokens('hello world', 'unknown-model-xyz');
    expect(count).toBeGreaterThan(0);
  });

  it('returns proportional count for longer strings', () => {
    const short = countTokens('hello');
    const long = countTokens('hello '.repeat(100));
    expect(long).toBeGreaterThan(short);
  });
});
