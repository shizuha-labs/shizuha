function classifyChar(ch: string): 'whitespace' | 'word' | 'symbol' {
  if (/\s/.test(ch)) return 'whitespace';
  // Unicode-aware: \p{L} letters (incl. accented/CJK), \p{N} numbers and
  // \p{M} combining marks are word characters so "déjà", "你好" and decomposed
  // "cafe\u0301" stay single runs instead of fragmenting (SCLI-465).
  if (/[\p{L}\p{N}_\p{M}]/u.test(ch)) return 'word';
  return 'symbol';
}

/**
 * Find the start offset that Ctrl+Backspace/Ctrl+W should delete to.
 * Behavior:
 * - delete preceding symbol/word run
 * - if cursor is after whitespace, consume that whitespace and the previous run
 */
export function findPreviousWordStart(text: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, text.length));
  if (i === 0) return 0;

  let cls = classifyChar(text[i - 1]!);
  while (i > 0 && classifyChar(text[i - 1]!) === cls) i--;

  if (cls === 'whitespace' && i > 0) {
    cls = classifyChar(text[i - 1]!);
    while (i > 0 && classifyChar(text[i - 1]!) === cls) i--;
  }

  return i;
}

/**
 * Find the end offset for Ctrl+Right / Alt+F movement.
 * Behavior:
 * - if on a word/symbol run, move to end of that run
 * - if on whitespace, consume whitespace then consume the next run
 */
export function findNextWordEnd(text: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, text.length));
  if (i >= text.length) return text.length;

  let cls = classifyChar(text[i]!);
  while (i < text.length && classifyChar(text[i]!) === cls) i++;

  if (cls === 'whitespace' && i < text.length) {
    cls = classifyChar(text[i]!);
    while (i < text.length && classifyChar(text[i]!) === cls) i++;
  }

  return i;
}

/** Move to start of current line */
export function findLineStart(text: string, cursor: number): number {
  const i = Math.max(0, Math.min(cursor, text.length));
  const nl = text.lastIndexOf('\n', i - 1);
  return nl === -1 ? 0 : nl + 1;
}

/** Move to end of current line */
export function findLineEnd(text: string, cursor: number): number {
  const i = Math.max(0, Math.min(cursor, text.length));
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl;
}

/** Extended-grapheme-cluster boundaries as [start, end) code-unit ranges. */
function graphemeEdges(text: string): Array<{ start: number; end: number }> {
  // Prefer the engine's grapheme segmentation (Node >=16) so multi-code-unit
  // clusters (emoji ZWJ, combining marks, flags, skin-tone modifiers) are
  // treated as one unit; fall back to code units for exotic runtimes.
  const Segmenter = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Segmenter === 'function') {
    const seg = new Segmenter(undefined, { granularity: 'grapheme' });
    const edges: Array<{ start: number; end: number }> = [];
    for (const s of seg.segment(text)) {
      edges.push({ start: s.index, end: s.index + s.segment.length });
    }
    return edges;
  }
  return Array.from({ length: text.length }, (_, i) => ({ start: i, end: i + 1 }));
}

/**
 * Start offset of the grapheme cluster immediately to the LEFT of `cursor`.
 * Returns null when there is nothing to the left.
 */
export function graphemeDeleteBackwardOffset(text: string, cursor: number): number | null {
  const i = Math.max(0, Math.min(cursor, text.length));
  if (i <= 0) return null;
  const segs = graphemeEdges(text);
  let start = 0;
  for (const s of segs) {
    if (s.end <= i) {
      start = s.start;
    } else if (s.start < i) {
      return s.start;
    } else {
      break;
    }
  }
  return start;
}

/**
 * Range [start, end) of the grapheme cluster UNDER/at-or-right-of `cursor`.
 * Returns null when the cursor is at the end (never a left delete).
 */
export function graphemeDeleteForwardRange(text: string, cursor: number): { start: number; end: number } | null {
  const i = Math.max(0, Math.min(cursor, text.length));
  if (i >= text.length) return null;
  const segs = graphemeEdges(text);
  for (const s of segs) {
    if (s.end <= i) continue;
    return { start: s.start, end: s.end };
  }
  return { start: text.length, end: text.length };
}

/** Forward-delete the cluster under the cursor; null if nothing to delete. */
export function applyForwardDelete(text: string, cursor: number): { text: string; cursor: number } | null {
  const range = graphemeDeleteForwardRange(text, cursor);
  if (!range) return null;
  return { text: text.slice(0, range.start) + text.slice(range.end), cursor: range.start };
}

/** Backward-delete the cluster left of the cursor; null when at start. */
export function applyBackwardDelete(text: string, cursor: number): { text: string; cursor: number } | null {
  const start = graphemeDeleteBackwardOffset(text, cursor);
  if (start === null) return null;
  return { text: text.slice(0, start) + text.slice(cursor), cursor: start };
}

/**
 * SCLI-458: grapheme-cluster offsets for readline char-level bindings.
 *
 * Returns the start offset (code-unit index) of every grapheme cluster in
 * `text`. Uses Intl.Segmenter when available so emoji (surrogate pairs),
 * CJK, and combining sequences move as one visual character — the QA matrix
 * for SCLI-458 explicitly covers `A🙂X`, `aé`, and `東京`. Falls back to
 * code-point iteration (Array.from) when Segmenter is unavailable.
 */
export function graphemeOffsets(text: string): number[] {
  const offsets: number[] = [];
  const SegmenterCtor = (Intl as { Segmenter?: new (locales?: string, opts?: { granularity?: string }) => { segment(s: string): Iterable<{ index: number }> } }).Segmenter;
  if (typeof SegmenterCtor === 'function') {
    const seg = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    for (const part of seg.segment(text)) {
      offsets.push(part.index);
    }
    return offsets;
  }
  // Fallback: iterate code points (handles surrogate pairs, not combining marks).
  let i = 0;
  for (const ch of text) {
    offsets.push(i);
    i += ch.length;
  }
  return offsets;
}

/**
 * SCLI-458: the grapheme start strictly before `cursor` (backward-char target).
 * Returns 0 when the cursor is at the start.
 */
export function prevGraphemeIndex(text: string, cursor: number): number {
  const i = Math.max(0, Math.min(cursor, text.length));
  if (i === 0) return 0;
  let result = 0;
  for (const o of graphemeOffsets(text)) {
    if (o < i) result = o;
    else break;
  }
  return result;
}

/**
 * SCLI-458: the grapheme start strictly after `cursor` (forward-char target).
 * Returns text.length when the cursor is at the end.
 */
export function nextGraphemeIndex(text: string, cursor: number): number {
  const i = Math.max(0, Math.min(cursor, text.length));
  for (const o of graphemeOffsets(text)) {
    if (o > i) return o;
  }
  return text.length;
}

/**
 * [start, end) of the extended grapheme cluster at/after `offset`; returns
 * [offset, offset] when the offset is at the end (no cluster under it).
 * Used by the renderer so the cursor never splits an emoji/combining cluster.
 */
export function graphemeClusterAt(text: string, offset: number): { start: number; end: number } {
  const i = Math.max(0, Math.min(offset, text.length));
  const segs = graphemeEdges(text);
  for (const s of segs) {
    if (s.end <= i) continue;
    return { start: s.start, end: s.end };
  }
  return { start: i, end: i };
}

/**
 * Move the cursor one extended grapheme cluster to the LEFT (SCLI-463).
 * Never lands inside a surrogate pair / combining sequence / ZWJ cluster, so
 * plain arrow navigation cannot split an emoji or drop a combining mark.
 */
export function graphemeMoveLeft(text: string, cursor: number): number {
  const i = Math.max(0, Math.min(cursor, text.length));
  if (i <= 0) return 0;
  const segs = graphemeEdges(text);
  let start = 0;
  for (const s of segs) {
    if (s.end <= i) {
      start = s.start;
    } else if (s.start < i) {
      // Cursor is inside a cluster (defensive) — snap to its start.
      return s.start;
    } else {
      break;
    }
  }
  return start;
}

/**
 * Move the cursor one extended grapheme cluster to the RIGHT (SCLI-463).
 * Never lands inside a cluster, so arrow navigation cannot corrupt the draft.
 */
export function graphemeMoveRight(text: string, cursor: number): number {
  const i = Math.max(0, Math.min(cursor, text.length));
  if (i >= text.length) return text.length;
  const segs = graphemeEdges(text);
  for (const s of segs) {
    if (s.end <= i) continue;
    return s.end;

  }
  return text.length;
}

/**
 * Transpose the two words around `cursor` (Meta-T / Alt+T), matching
 * Bash/readline transpose-words:
 * - cursor at end-of-line: transpose the last two words, cursor lands at end;
 * - cursor on whitespace: transpose the word before the whitespace with the
 *   word after it;
 * - cursor inside a word: transpose that word with the previous word.
 *
 * Words are the same runs the word-navigation helpers use (whitespace / word /
 * symbol), so CJK, emoji and combining-mark sequences are swapped as whole
 * runs — grapheme integrity is preserved, no U+FFFD or mid-cluster splits.
 * Returns null when there is nothing to transpose (start of line, single
 * word, or only whitespace).
 */
export function transposeWords(text: string, cursor: number): { text: string; cursor: number } | null {
  const i = Math.max(0, Math.min(cursor, text.length));
  if (i === 0) return null;

  // Determine the right word's [start, end).
  let rightStart: number;
  let rightEnd: number;

  if (i >= text.length) {
    // At end of line: the right word is the last word.
    rightEnd = i;
    while (rightEnd > 0 && /\s/.test(text[rightEnd - 1]!)) rightEnd--;
    if (rightEnd === 0) return null;
    rightStart = findPreviousWordStart(text, rightEnd);
  } else if (/\s/.test(text[i]!)) {
    // On whitespace: the right word is the word after the whitespace run.
    let s = i;
    while (s < text.length && /\s/.test(text[s]!)) s++;
    if (s >= text.length) return null;
    rightStart = s;
    rightEnd = findNextWordEnd(text, s);
  } else {
    // At the start of a word (char before is whitespace/start) or inside it:
    // the right word is the word containing/starting at the cursor.
    rightStart = i;
    if (i > 0 && !/\s/.test(text[i - 1]!)) {
      // Inside the word — back up to its start.
      rightStart = findPreviousWordStart(text, i);
    }
    rightEnd = findNextWordEnd(text, rightStart);
  }

  if (rightStart <= 0) return null;

  // The left word is the word immediately before rightStart (skipping the
  // whitespace between them).
  let leftEnd = rightStart;
  while (leftEnd > 0 && /\s/.test(text[leftEnd - 1]!)) leftEnd--;
  if (leftEnd === 0) return null;
  const leftStart = findPreviousWordStart(text, leftEnd);

  const leftWord = text.slice(leftStart, leftEnd);
  const rightWord = text.slice(rightStart, rightEnd);
  const between = text.slice(leftEnd, rightStart);

  const newText =
    text.slice(0, leftStart) +
    rightWord +
    between +
    leftWord +
    text.slice(rightEnd);

  // Cursor lands after the transposed pair (same total length).
  const newCursor = leftStart + rightWord.length + between.length + leftWord.length;
  return { text: newText, cursor: newCursor };
}
