import { describe, expect, it } from 'vitest';
import { formatThinkStatus } from '../../src/tui/components/StatusBar.js';

describe('formatThinkStatus', () => {
  it('shows DeepSeek profile default as think:on(high) when /effort is unset', () => {
    expect(formatThinkStatus('DeepSeek-V4-Flash', 'on', null)).toBe('think:on(high)');
  });

  it('shows an explicit /effort override', () => {
    expect(formatThinkStatus('DeepSeek-V4-Flash', 'on', 'max')).toBe('think:on(max)');
  });

  it('omits effort when thinking is off', () => {
    expect(formatThinkStatus('DeepSeek-V4-Flash', 'off', 'high')).toBe('think:off');
  });

  it('shortens the token on a very narrow tmux footer', () => {
    expect(formatThinkStatus('DeepSeek-V4-Flash', 'on', null, { veryNarrow: true }))
      .toBe('t:on(h)');
  });
});
