import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transposeWords } from '../../src/tui/utils/textEdit.js';

/**
 * SCLI-465: Meta-T / Alt+T transpose-words was a silent no-op. The fix adds a
 * transposeWords() helper (Bash/readline semantics) wired into MultiLineInput.
 *
 * Acceptance coverage:
 * - `alpha beta` + Meta-T -> `beta alpha`, cursor at end;
 * - three-word input transposes only the last two words at end-of-line;
 * - precomposed/decomposed accents, CJK, emoji-prefixed words preserve
 *   grapheme integrity (no U+FFFD, no mid-cluster split);
 * - cursor placement matches Bash/readline at the tested boundary.
 */
const src = readFileSync(
  resolve(import.meta.dirname!, '../../src/tui/components/MultiLineInput.tsx'),
  'utf8',
);

describe('Meta-T / Alt+T transpose-words', () => {
  it('wires the Meta-T binding in MultiLineInput', () => {
    expect(src, 'transposeWords must be imported').toMatch(/transposeWords/);
    expect(src, 'Meta-T must be recognised').toMatch(
      /key\.meta\s*&&\s*input\.toLowerCase\(\)\s*===\s*'t'/,
    );
    expect(src, 'ESC+t terminal encoding must be recognised').toMatch(
      /input\s*===\s*'\\u001bt'/,
    );
  });

  it('transposes two words at end-of-line (alpha beta -> beta alpha)', () => {
    const r = transposeWords('alpha beta', 10);
    expect(r).not.toBeNull();
    expect(r!.text).toBe('beta alpha');
    expect(r!.cursor).toBe(10);
  });

  it('transposes only the last two words of a three-word line at end', () => {
    const r = transposeWords('one two three', 13);
    expect(r!.text).toBe('one three two');
    expect(r!.cursor).toBe(13);
  });

  it('transposes the word under the cursor with the previous word (middle)', () => {
    // cursor inside "two" of "one two three" -> transpose one/two
    const r = transposeWords('one two three', 5);
    expect(r!.text).toBe('two one three');
  });

  it('transposes the word before and after whitespace when on whitespace', () => {
    const r = transposeWords('one two three', 3); // on the space after "one"
    expect(r!.text).toBe('two one three');
  });

  it('preserves precomposed and decomposed accents', () => {
    const pre = transposeWords('café déjà', 9);
    expect(pre!.text).toBe('déjà café');
    const decomp = transposeWords('cafe\u0301 deja\u0300', 12);
    expect(decomp!.text).toBe('deja\u0300 cafe\u0301');
    expect(decomp!.text).not.toContain('\uFFFD');
  });

  it('preserves CJK words as whole runs', () => {
    const r = transposeWords('你好 世界', 5);
    expect(r!.text).toBe('世界 你好');
    expect(r!.cursor).toBe(5);
  });

  it('preserves emoji-prefixed words without splitting graphemes', () => {
    const r = transposeWords('🚀 alpha beta', 13);
    expect(r!.text).toBe('🚀 beta alpha');
    expect(r!.text).not.toContain('\uFFFD');
  });

  it('returns null at start of line / single word (no-op)', () => {
    expect(transposeWords('alpha', 5)).toBeNull();
    expect(transposeWords('', 0)).toBeNull();
    expect(transposeWords('  ', 2)).toBeNull();
  });

  it('leaves a single leading word and transposes the trailing pair', () => {
    const r = transposeWords('alpha beta gamma', 16);
    expect(r!.text).toBe('alpha gamma beta');
  });
});
