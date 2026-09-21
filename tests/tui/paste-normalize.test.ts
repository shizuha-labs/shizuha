import { describe, it, expect } from 'vitest';
import {
  PasteNormalizer,
  normalizePastedChunks,
  sanitizePastedChunk,
} from '../../src/tui/utils/pasteNormalize.js';

describe('sanitizePastedChunk', () => {
  it('normalizes CRLF and CR to LF', () => {
    expect(sanitizePastedChunk('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('expands tabs and strips control chars', () => {
    expect(sanitizePastedChunk('a\tb\x00c')).toBe('a    bc');
  });
});

describe('normalizePastedChunks (SCLI-489 CRLF split)', () => {
  it('single CRLF chunk renders one newline per line break', () => {
    const result = normalizePastedChunks(['first CRLF\r\n!touch\r\nthird CRLF']);
    expect(result).toBe('first CRLF\n!touch\nthird CRLF');
    expect(result.split('\n')).toHaveLength(3);
  });

  it('CRLF split across chunk boundary does NOT double the blank line', () => {
    // The regression: chunk boundary lands between \r and \n.
    const result = normalizePastedChunks(['first CRLF\r', '\n!touch\r', '\nthird CRLF']);
    expect(result).toBe('first CRLF\n!touch\nthird CRLF');
    expect(result.split('\n')).toHaveLength(3);
  });

  it('CR-only line endings normalize to one newline each', () => {
    const result = normalizePastedChunks(['first CRLF\r', 'second\r', 'third']);
    expect(result).toBe('first CRLF\nsecond\nthird');
    expect(result.split('\n')).toHaveLength(3);
  });

  it('mixed CRLF/LF payload preserves literal command-looking text', () => {
    const result = normalizePastedChunks(['!touch PASTE_SHOULD_NOT_EXIST\r\nplain\nend']);
    expect(result).toBe('!touch PASTE_SHOULD_NOT_EXIST\nplain\nend');
    expect(result).not.toContain('\r');
  });

  it('LF-only paste is unchanged', () => {
    const result = normalizePastedChunks(['a\nb\nc']);
    expect(result).toBe('a\nb\nc');
  });
});

describe('PasteNormalizer (stateful, mirrors composer)', () => {
  it('buffers a trailing CR and combines with a leading LF', () => {
    const n = new PasteNormalizer();
    expect(n.push('abc\r')).toBe('abc');
    expect(n.push('\ndef')).toBe('\ndef'); // one newline for the \r\n pair
    expect(n.push('')).toBe('');
  });

  it('flushes a standalone CR as one newline', () => {
    const n = new PasteNormalizer();
    expect(n.push('abc\r')).toBe('abc');
    expect(n.push('def')).toBe('\ndef');
  });

  it('reset clears a pending CR', () => {
    const n = new PasteNormalizer();
    expect(n.push('abc\r')).toBe('abc');
    n.reset();
    expect(n.push('def')).toBe('def');
  });
});
