import { describe, it, expect } from 'vitest';
import {
  applyBackwardDelete,
  applyForwardDelete,
  findLineEnd,
  findLineStart,
  findNextWordEnd,
  findPreviousWordStart,
} from '../../src/tui/utils/textEdit.js';

describe('findPreviousWordStart', () => {
  it('returns 0 at start', () => {
    expect(findPreviousWordStart('hello', 0)).toBe(0);
  });

  it('deletes back to previous word start', () => {
    const text = 'hello world';
    expect(findPreviousWordStart(text, text.length)).toBe(6);
  });

  it('consumes trailing whitespace and previous word', () => {
    const text = 'hello world   ';
    expect(findPreviousWordStart(text, text.length)).toBe(6);
  });

  it('handles symbol runs separately', () => {
    const text = 'foo/bar';
    expect(findPreviousWordStart(text, 4)).toBe(3); // delete "/"
    expect(findPreviousWordStart(text, text.length)).toBe(4); // delete "bar"
  });

  it('treats newlines as whitespace boundaries', () => {
    const text = 'foo\nbar';
    expect(findPreviousWordStart(text, text.length)).toBe(4);
  });
});

describe('findNextWordEnd', () => {
  it('moves to end of current word run', () => {
    const text = 'hello world';
    expect(findNextWordEnd(text, 0)).toBe(5);
  });

  it('consumes whitespace then next word run', () => {
    const text = 'hello   world';
    expect(findNextWordEnd(text, 5)).toBe(13);
  });

  it('handles symbols as separate runs', () => {
    const text = 'foo/bar';
    expect(findNextWordEnd(text, 3)).toBe(4); // "/"
    expect(findNextWordEnd(text, 4)).toBe(7); // "bar"
  });
});

describe('line navigation', () => {
  it('findLineStart returns start of current line', () => {
    const text = 'alpha\nbeta\ngamma';
    expect(findLineStart(text, 8)).toBe(6); // beta
    expect(findLineStart(text, 2)).toBe(0); // alpha
  });

  it('findLineEnd returns end of current line', () => {
    const text = 'alpha\nbeta\ngamma';
    expect(findLineEnd(text, 8)).toBe(10); // beta
    expect(findLineEnd(text, 2)).toBe(5); // alpha
    expect(findLineEnd(text, text.length)).toBe(text.length);
  });
});

// SCLI-451: Forward Delete (CSI 3~) must remove the cluster under/right of the
// cursor, never the left neighbor; at line start it deletes the char under the
// cursor (not a no-op), and at line end it is a no-op (never removes the last
// char). Backspace removes the cluster left of the cursor.
describe('Forward Delete (CSI 3~) grapheme-cluster deletion', () => {
  it('deletes the char under the cursor at line start (not a no-op)', () => {
    expect(applyForwardDelete('ABC', 0)?.text).toBe('BC');
  });

  it('deletes the char under the cursor mid-line (not the left neighbor)', () => {
    const r = applyForwardDelete('ABC', 1);
    expect(r?.text).toBe('AC');
    expect(r?.cursor).toBe(1);
  });

  it('is a no-op at end of line (never removes the last char)', () => {
    expect(applyForwardDelete('hello world', 'hello world'.length)).toBeNull();
  });

  it('handles unicode start control (AΩZ -> ΩZ)', () => {
    expect(applyForwardDelete('AΩZ', 0)?.text).toBe('ΩZ');
  });

  it('removes an entire emoji ZWJ cluster as one unit', () => {
    const cluster = '👩\u200d💻';
    const text = `a${cluster}b`;
    const r = applyForwardDelete(text, 1);
    expect(r?.text).toBe('ab');
    expect(r?.text).not.toContain('\u200d');
    expect(r?.text).not.toContain('\uFFFD');
  });

  it('removes an entire combining-mark cluster as one unit', () => {
    const text = 'aéx';
    const r = applyForwardDelete(text, 1);
    expect(r?.text).toBe('ax');
    expect(r?.text).not.toContain('\uFFFD');
  });

  it('removes an entire flag emoji (regional indicator pair) as one unit', () => {
    const flag = '🇮🇳';
    const text = `a${flag}b`;
    const r = applyForwardDelete(text, 1);
    expect(r?.text).toBe('ab');
  });

  it('removes a skin-tone-modified emoji as one unit', () => {
    const okHand = '👋🏽';
    const text = `a${okHand}b`;
    const r = applyForwardDelete(text, 1);
    expect(r?.text).toBe('ab');
  });

  it('cursor stays put after a mid-line forward delete', () => {
    const r = applyForwardDelete('ABCD', 1);
    expect(r?.text).toBe('ACD');
    expect(r?.cursor).toBe(1);
  });
});

describe('Backspace grapheme-cluster deletion (unchanged left semantics)', () => {
  it('is a no-op at line start', () => {
    expect(applyBackwardDelete('ABC', 0)).toBeNull();
  });

  it('removes the cluster left of the cursor', () => {
    const r = applyBackwardDelete('ABC', 1);
    expect(r?.text).toBe('BC');
    expect(r?.cursor).toBe(0);
  });

  it('removes an entire ZWJ cluster to the left as one unit', () => {
    const cluster = '👩\u200d💻';
    const text = `a${cluster}`;
    const r = applyBackwardDelete(text, text.length);
    expect(r?.text).toBe('a');
    expect(r?.text).not.toContain('\u200d');
  });
});
