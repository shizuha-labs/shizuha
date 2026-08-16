function classifyChar(ch: string): 'whitespace' | 'word' | 'symbol' {
  if (/\s/.test(ch)) return 'whitespace';
  if (/[A-Za-z0-9_]/.test(ch)) return 'word';
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
