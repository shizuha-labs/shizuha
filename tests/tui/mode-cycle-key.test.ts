import { describe, it, expect } from 'vitest';
import { isModeCycleKey } from '../../src/tui/utils/keys.js';

describe('isModeCycleKey', () => {
  it('detects Ink-style shift+tab key object', () => {
    expect(isModeCycleKey('', { shift: true, tab: true })).toBe(true);
  });

  it('detects xterm reverse-tab raw sequence', () => {
    expect(isModeCycleKey('\u001b[Z', {})).toBe(true);
  });

  it('detects parameterized reverse-tab raw sequence', () => {
    expect(isModeCycleKey('\u001b[1;2Z', {})).toBe(true);
  });

  it('does not match regular tab', () => {
    expect(isModeCycleKey('\t', { tab: true })).toBe(false);
  });
});

