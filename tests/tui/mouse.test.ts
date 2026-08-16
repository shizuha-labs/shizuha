import { describe, expect, it } from 'vitest';
import { isSgrMouseSequence, parseMouseWheel } from '../../src/tui/utils/mouse.js';

describe('SGR mouse input', () => {
  it('decodes raw and Ink-normalized wheel reports', () => {
    expect(parseMouseWheel('\x1b[<64;10;20M')).toBe('up');
    expect(parseMouseWheel('[<65;10;20M')).toBe('down');
    expect(parseMouseWheel('[<80;10;20M')).toBe('up'); // Ctrl + wheel
  });

  it('does not treat clicks, releases, or text as scrolling', () => {
    expect(parseMouseWheel('[<0;10;20M')).toBeNull();
    expect(parseMouseWheel('[<64;10;20m')).toBeNull();
    expect(parseMouseWheel('hello')).toBeNull();
    expect(isSgrMouseSequence('[<0;10;20M')).toBe(true);
    expect(isSgrMouseSequence('hello')).toBe(false);
  });
});
