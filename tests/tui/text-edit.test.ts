import { describe, it, expect } from 'vitest';
import { findLineEnd, findLineStart, findNextWordEnd, findPreviousWordStart } from '../../src/tui/utils/textEdit.js';

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
