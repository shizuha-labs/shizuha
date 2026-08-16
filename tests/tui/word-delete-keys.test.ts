import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findPreviousWordStart } from '../../src/tui/utils/textEdit.js';

/**
 * Ctrl+Backspace must delete a WORD, not a character.
 *
 * Terminals overwhelmingly send DEL () for plain Backspace and BS
 * () for Ctrl+Backspace.  was absent from the word-delete
 * condition in MultiLineInput, so Ctrl+Backspace fell through to the
 * "held backspace run" handler, which deletes one character per byte. Holding
 * it crawled through the line one letter at a time (operator 2026-08-04:
 * "if i keep it pressed .. i have no time to delete it word by word").
 */
const src = readFileSync(
  resolve(import.meta.dirname!, '../../src/tui/components/MultiLineInput.tsx'),
  'utf8',
);

describe('Ctrl+Backspace word delete', () => {
  it('treats BS (\\u0008) as a word delete, not a character delete', () => {
    expect(src, 'BS must be recognised as Ctrl+Backspace').toMatch(
      /ctrlBackspaceRun\s*=\s*\/\^\\u0008\+\$\/\.test\(input\)/,
    );
    expect(src, 'BS must participate in the word-delete condition')
      .toMatch(/ctrlBackspaceRun\s*>\s*0/);
  });

  it('no longer lets the held-backspace run handler swallow BS', () => {
    // The run handler must match DEL only; matching BS too would re-introduce
    // the character-at-a-time behaviour.
    expect(src).toMatch(/!key\.ctrl && !key\.meta && \/\^\\u007f\+\$\/\.test\(input\)/);
    expect(src, 'run handler must not match BS').not.toMatch(
      /!key\.ctrl && !key\.meta && \/\^\[\\u0008\\u007f\]\+\$\/\.test\(input\)/,
    );
  });

  it('handles Alt+Backspace, the other conventional word delete', () => {
    expect(src).toMatch(/input === '\\u001b\\u007f'/);
    expect(src).toMatch(/key\.meta && \(key\.backspace \|\| key\.delete\)/);
  });

  it('deletes one word per coalesced BS byte when the key is held', () => {
    // A held Ctrl+Backspace can arrive as several BS bytes in one event; the
    // loop must consume one word per byte.
    expect(src).toMatch(/for \(let n = 0; n < Math\.max\(1, ctrlBackspaceRun\) && start > 0; n\+\+\)/);

    // Verify the arithmetic the loop relies on: repeated application walks back
    // word by word rather than stalling.
    const text = 'fix the compaction amnesia bug';
    let cursor = text.length;
    const stops: number[] = [];
    for (let i = 0; i < 3; i++) {
      cursor = findPreviousWordStart(text, cursor);
      stops.push(cursor);
    }
    expect(stops).toEqual([text.indexOf('bug'), text.indexOf('amnesia'), text.indexOf('compaction')]);
    expect(new Set(stops).size, 'each press must make progress').toBe(3);
  });
});
