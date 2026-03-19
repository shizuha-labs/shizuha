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
