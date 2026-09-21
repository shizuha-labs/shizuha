import { describe, it, expect } from 'vitest';
import {
  applyBackwardDelete,
  applyForwardDelete,
  findLineEnd,
  findLineStart,
  findNextWordEnd,
  findPreviousWordStart,
  graphemeOffsets,
  nextGraphemeIndex,
  prevGraphemeIndex,
  graphemeMoveLeft,
  graphemeMoveRight,
  graphemeClusterAt,
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

  // SCLI-457: accented Unicode (é/ï) must be part of the word, not a boundary.
  it('moves before a whole accented word (alpha café)', () => {
    const text = 'alpha café';
    expect(findPreviousWordStart(text, text.length)).toBe(6);
  });

  it('moves before a whole accented word (hello naïve)', () => {
    const text = 'hello naïve';
    expect(findPreviousWordStart(text, text.length)).toBe(6);
  });

  it('moves to start of a lone accented word (café)', () => {
    const text = 'café';
    expect(findPreviousWordStart(text, text.length)).toBe(0);
  });

  it('keeps ASCII word navigation unchanged (hello world)', () => {
    const text = 'hello world';
    expect(findPreviousWordStart(text, text.length)).toBe(6);
  });

  // SCLI-452: Unicode letters must be word chars, not symbols, so word-delete
  // removes the whole word (e.g. "café") rather than stopping at the first
  // non-ASCII code point.
  it('deletes a whole accented word (café)', () => {
    const text = 'alpha café';
    expect(findPreviousWordStart(text, text.length)).toBe(6); // delete "café"
  });

  it('deletes a whole CJK word run', () => {
    const text = 'hello 世界';
    expect(findPreviousWordStart(text, text.length)).toBe(6); // delete "世界"
  });

  it('deletes a whole Devanagari word run', () => {
    const text = 'alpha हिन्दी';
    expect(findPreviousWordStart(text, text.length)).toBe(6); // delete "हिन्दी"
  });

  it('deletes a word with a combining-mark letter as one run', () => {
    // "cafe" + combining acute (U+0301) — combining mark is a word char.
    const text = 'alpha cafe\u0301';
    expect(findPreviousWordStart(text, text.length)).toBe(6); // delete "cafe\u0301"
  });

  it('still treats punctuation as a separate symbol run', () => {
    const text = 'foo/bar';
    expect(findPreviousWordStart(text, 4)).toBe(3); // delete "/"
    expect(findPreviousWordStart(text, text.length)).toBe(4); // delete "bar"
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

  // SCLI-457: accented Unicode (é/ï) must be part of the word, not a boundary.
  it('moves past a whole accented word (café)', () => {
    const text = 'café';
    expect(findNextWordEnd(text, 0)).toBe(4);
  });

  it('moves past a whole accented word (alpha café)', () => {
    const text = 'alpha café';
    expect(findNextWordEnd(text, 0)).toBe(5); // end of "alpha"
    expect(findNextWordEnd(text, 6)).toBe(10); // end of "café"
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

describe('SCLI-458 grapheme char navigation', () => {
  it('graphemeOffsets handles ASCII, emoji, CJK and combining sequences', () => {
    expect(graphemeOffsets('abc')).toEqual([0, 1, 2]);
    // A🙂X — emoji is a surrogate pair (2 code units)
    expect(graphemeOffsets('A🙂X')).toEqual([0, 1, 3]);
    // 東京 — CJK single units
    expect(graphemeOffsets('東京')).toEqual([0, 1]);
  });

  it('prevGraphemeIndex moves back one grapheme', () => {
    expect(prevGraphemeIndex('abc', 2)).toBe(1);
    expect(prevGraphemeIndex('abc', 1)).toBe(0);
    expect(prevGraphemeIndex('abc', 0)).toBe(0);
    // emoji: cursor after 'A' (index 1) -> back to 0
    expect(prevGraphemeIndex('A🙂X', 1)).toBe(0);
    // cursor inside the emoji surrogate pair (index 2) -> snap to emoji start (1)
    expect(prevGraphemeIndex('A🙂X', 2)).toBe(1);
  });

  it('nextGraphemeIndex moves forward one grapheme', () => {
    expect(nextGraphemeIndex('abc', 0)).toBe(1);
    expect(nextGraphemeIndex('abc', 1)).toBe(2);
    expect(nextGraphemeIndex('abc', 2)).toBe(3);
    expect(nextGraphemeIndex('abc', 3)).toBe(3); // at end
    // emoji: from 0 -> 1 (start of emoji), from 1 -> 3 (past the pair)
    expect(nextGraphemeIndex('A🙂X', 0)).toBe(1);
    expect(nextGraphemeIndex('A🙂X', 1)).toBe(3);
    expect(nextGraphemeIndex('A🙂X', 2)).toBe(3);
  });
});

// SCLI-463: Left/Right arrow navigation must move by complete extended
// grapheme clusters, never UTF-16 code units, so movement cannot split an
// emoji/combining cluster or corrupt the draft.
describe('SCLI-463 grapheme-aware cursor movement', () => {
  it('Right arrow moves past a surrogate-pair emoji as one unit', () => {
    const text = 'A🙂B';
    // cursor after 'A' (offset 1) -> should land after the emoji (offset 3)
    expect(graphemeMoveRight(text, 1)).toBe(3);
  });

  it('Left arrow moves back across a surrogate-pair emoji as one unit', () => {
    const text = 'A🙂B';
    // cursor after the emoji (offset 3) -> should land after 'A' (offset 1)
    expect(graphemeMoveLeft(text, 3)).toBe(1);
  });

  it('Right arrow across a ZWJ sequence moves as one unit', () => {
    const cluster = '👩\u200d💻';
    const text = `A${cluster}B`;
    // after 'A' (offset 1) -> after the whole ZWJ cluster
    expect(graphemeMoveRight(text, 1)).toBe(1 + cluster.length);
  });

  it('Right arrow across a decomposed combining mark moves as one unit', () => {
    // 'e' + U+0301 combining acute
    const cluster = 'e\u0301';
    const text = `A${cluster}B`;
    expect(graphemeMoveRight(text, 1)).toBe(1 + cluster.length);
  });

  it('Right arrow across a regional-indicator flag moves as one unit', () => {
    const flag = '🇮🇳';
    const text = `A${flag}B`;
    expect(graphemeMoveRight(text, 1)).toBe(1 + flag.length);
  });

  it('Right arrow across a skin-tone-modified emoji moves as one unit', () => {
    const cluster = '👋🏽';
    const text = `A${cluster}B`;
    expect(graphemeMoveRight(text, 1)).toBe(1 + cluster.length);
  });

  it('Right arrow across a keycap sequence moves as one unit', () => {
    const cluster = '1\uFE0F\u20E3'; // 1 + VS16 + combining keycap
    const text = `A${cluster}B`;
    expect(graphemeMoveRight(text, 1)).toBe(1 + cluster.length);
  });

  it('Right arrow across a variation-selector sequence moves as one unit', () => {
    const cluster = '❤\uFE0F'; // heart + VS16
    const text = `A${cluster}B`;
    expect(graphemeMoveRight(text, 1)).toBe(1 + cluster.length);
  });

  it('CJK and ASCII still move one code point per step', () => {
    expect(graphemeMoveRight('A界B', 1)).toBe(2); // 界 is a single code unit
    expect(graphemeMoveRight('AxB', 1)).toBe(2);
    expect(graphemeMoveLeft('AxB', 2)).toBe(1);
  });

  it('movement never lands inside a cluster and never mutates the buffer', () => {
    const text = 'A🙂B';
    const before = text;
    const right = graphemeMoveRight(text, 1);
    expect(right).toBe(3);
    const left = graphemeMoveLeft(text, right);
    expect(left).toBe(1);
    expect(text).toBe(before); // byte-for-byte unchanged
  });

  it('clamps at the start and end of the buffer', () => {
    expect(graphemeMoveLeft('A🙂B', 0)).toBe(0);
    expect(graphemeMoveRight('A🙂B', 'A🙂B'.length)).toBe('A🙂B'.length);
  });
});

describe('SCLI-463 graphemeClusterAt (renderer cursor cell)', () => {
  it('returns the whole emoji cluster under the cursor offset', () => {
    const text = 'A🙂B';
    expect(graphemeClusterAt(text, 1)).toEqual({ start: 1, end: 3 });
  });

  it('returns a zero-width range at end of text', () => {
    const text = 'A🙂B';
    expect(graphemeClusterAt(text, text.length)).toEqual({ start: text.length, end: text.length });
  });

  it('returns the whole ZWJ cluster at its start offset', () => {
    const cluster = '👩\u200d💻';
    const text = `A${cluster}B`;
    expect(graphemeClusterAt(text, 1)).toEqual({ start: 1, end: 1 + cluster.length });
  });
});

// SCLI-450: Backspace must delete exactly one extended grapheme cluster, never
// a code-unit fragment. The composer's held-backspace run handler deletes one
// cluster per DEL char via repeated applyBackwardDelete — these regressions
// cover the exact cases from the live-PTY audit (ZWJ, decomposed combining,
// flags) plus variation selectors and skin-tone modifiers.
describe('SCLI-450 backspace deletes one grapheme cluster (no U+FFFD/residue)', () => {
  function backspaceN(text: string, n: number): string {
    let value = text;
    let cursor = value.length;
    for (let i = 0; i < n; i++) {
      const del = applyBackwardDelete(value, cursor);
      if (!del) return value;
      value = del.text;
      cursor = del.cursor;
    }
    return value;
  }

  it('removes a full emoji ZWJ cluster, leaving the ASCII base', () => {
    expect(backspaceN('A👩\u200d💻', 1)).toBe('A');
  });

  it('removes a decomposed combining-mark cluster, leaving the base letter', () => {
    expect(backspaceN('Xe\u0301', 1)).toBe('X');
  });

  it('removes a regional-indicator flag as one unit, leaving the base letter', () => {
    expect(backspaceN('M🇮🇳', 1)).toBe('M');
  });

  it('removes a variation-selector sequence as one unit', () => {
    expect(backspaceN('a❤\ufe0f', 1)).toBe('a');
  });

  it('removes a skin-tone-modified emoji as one unit', () => {
    expect(backspaceN('a👋\u{1F3FF}', 1)).toBe('a');
  });

  it('never leaves U+FFFD, a dangling joiner, or a base residue', () => {
    for (const draft of ['A👩\u200d💻', 'Xe\u0301', 'M🇮🇳', 'a❤\ufe0f', 'a👋\u{1F3FF}']) {
      const out = backspaceN(draft, 1);
      expect(out, `draft ${JSON.stringify(draft)}`).not.toContain('\uFFFD');
      expect(out, `draft ${JSON.stringify(draft)}`).not.toContain('\u200d');
      expect(out, `draft ${JSON.stringify(draft)}`).not.toContain('\u0301');
      expect(out, `draft ${JSON.stringify(draft)}`).not.toContain('\ufe0f');
      expect(out, `draft ${JSON.stringify(draft)}`).not.toContain('\u{1F3FF}');
    }
  });

  it('deletes one grapheme per backspace in a two-Backspace sequence (ASCII control)', () => {
    // The audit's positive control: one Backspace over ASCII removes one char.
    expect(backspaceN('AB', 1)).toBe('A');
    expect(backspaceN('AB', 2)).toBe('');
  });

  it('walks back one cluster per press across mixed graphemes', () => {
    const draft = 'A👩\u200d💻B';
    expect(backspaceN(draft, 1)).toBe('A👩\u200d💻');
    expect(backspaceN(draft, 2)).toBe('A');
    expect(backspaceN(draft, 3)).toBe('');
  });
});
