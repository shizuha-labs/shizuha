import { describe, it, expect } from 'vitest';
import { isBlankSystemPromptValue } from '../../src/index.js';

// SCLI-565: `shizuha pipe --system-prompt` must reject empty and
// whitespace-only overrides (ASCII + Unicode) instead of silently replacing
// the governing instruction scaffold with nothing.

describe('isBlankSystemPromptValue (SCLI-565)', () => {
  it('rejects the empty string', () => {
    expect(isBlankSystemPromptValue('')).toBe(true);
  });

  it('rejects ASCII whitespace-only values', () => {
    expect(isBlankSystemPromptValue(' ')).toBe(true);
    expect(isBlankSystemPromptValue('\t')).toBe(true);
    expect(isBlankSystemPromptValue('\n')).toBe(true);
    expect(isBlankSystemPromptValue(' \t\n ')).toBe(true);
  });

  it('rejects Unicode whitespace-only values', () => {
    expect(isBlankSystemPromptValue('\u00A0')).toBe(true); // NBSP
    expect(isBlankSystemPromptValue('\u2003')).toBe(true); // EM SPACE
    expect(isBlankSystemPromptValue('\u3000')).toBe(true); // IDEOGRAPHIC SPACE
    expect(isBlankSystemPromptValue('\u00A0\u2003\u3000')).toBe(true);
  });

  it('accepts a valid non-blank override', () => {
    expect(isBlankSystemPromptValue('You are a careful financial analyst.')).toBe(false);
    expect(isBlankSystemPromptValue('  answer in JSON only  ')).toBe(false);
  });

  it('accepts a value with internal whitespace', () => {
    expect(isBlankSystemPromptValue('line one\nline two')).toBe(false);
  });
});
