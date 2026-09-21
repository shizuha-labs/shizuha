import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitStdinChunk } from '../../src/tui/renderer/stdinChunkSplit.js';

/**
 * SCLI-774: stableUseInput dropped trailing bytes when an escape sequence and
 * subsequent keys arrived in ONE stdin chunk — parseKeypress consumes only the
 * first keypress and fnKeyRe (no end anchor) reported the WHOLE chunk as its
 * sequence, so '\x1b[BX' (Down + X) mapped the X into input='' (SCLI-461 e2e
 * run 6757: 'valuable draftX' rendered as 'valuable draft').
 *
 * The fix splits the chunk into per-keypress segments and dispatches each
 * through the same pipeline. These tests pin the splitter; the e2e zero-delay
 * Down+X case in e2e-tmux-renderer.test.ts pins the runtime behavior.
 */
const stableUseInputSrc = readFileSync(
  resolve(import.meta.dirname!, '../../src/tui/renderer/stableUseInput.ts'),
  'utf8',
);

describe('splitStdinChunk (SCLI-774)', () => {
  it('coalesced Down+X splits into two segments', () => {
    expect(splitStdinChunk('\x1b[BX')).toEqual(['\x1b[B', 'X']);
  });

  it('coalesced arrow+text+arrow splits into three', () => {
    expect(splitStdinChunk('\x1b[Bhi\x1b[C')).toEqual(['\x1b[B', 'hi', '\x1b[C']);
  });

  it('plain-text chunk (no ESC) is ONE segment — paste semantics preserved', () => {
    expect(splitStdinChunk('hello world')).toEqual(['hello world']);
    expect(splitStdinChunk('line1\nline2\n')).toEqual(['line1\nline2\n']);
  });

  it('meta chord (ESC + char) stays ONE segment — Alt+X keeps working', () => {
    expect(splitStdinChunk('\x1bX')).toEqual(['\x1bX']);
  });

  it('CSI with params and tilde final is one segment', () => {
    expect(splitStdinChunk('\x1b[3~x')).toEqual(['\x1b[3~', 'x']);
    expect(splitStdinChunk('\x1b[1;5A')).toEqual(['\x1b[1;5A']);
  });

  it('kitty CSI-u is one segment', () => {
    expect(splitStdinChunk('\x1b[13u')).toEqual(['\x1b[13u']);
    expect(splitStdinChunk('\x1b[97;1u')).toEqual(['\x1b[97;1u']);
  });

  it('SS3 is one segment', () => {
    expect(splitStdinChunk('\x1bOAz')).toEqual(['\x1bOA', 'z']);
  });

  it('ESC-ESC with CSI body (Alt-shifted) stays one segment', () => {
    expect(splitStdinChunk('\x1b\x1b[B')).toEqual(['\x1b\x1b[B']);
    expect(splitStdinChunk('\x1b\x1b')).toEqual(['\x1b\x1b']);
  });

  it('lone trailing ESC is its own segment', () => {
    expect(splitStdinChunk('ab\x1b')).toEqual(['ab', '\x1b']);
  });

  it('empty chunk yields no segments', () => {
    expect(splitStdinChunk('')).toEqual([]);
  });

  it('text run between sequences is one segment per run', () => {
    expect(splitStdinChunk('a\x1b[Bb\x1b[Cc')).toEqual(['a', '\x1b[B', 'b', '\x1b[C', 'c']);
  });
});

describe('stableUseInput wiring (SCLI-774)', () => {
  it('dispatches every segment through the same pipeline', () => {
    expect(stableUseInputSrc).toMatch(/for \(const segment of splitStdinChunk\(data\)\)/);
    expect(stableUseInputSrc).toMatch(/dispatchKeypress\(parseKeypress\(segment\)\)/);
  });

  it('dispatch generation is per KEYPRESS, not per stdin read', () => {
    // beginInputDispatch must live inside dispatchKeypress (per key event),
    // NOT in handleData (per chunk) — a subscriber consuming the first
    // keypress of a coalesced chunk must not suppress the trailing bytes.
    const dispatchFn = stableUseInputSrc.slice(
      stableUseInputSrc.indexOf('const dispatchKeypress'),
      stableUseInputSrc.indexOf('const handleData'),
    );
    expect(dispatchFn).toMatch(/beginInputDispatch\(\)/);
    const handleFn = stableUseInputSrc.slice(
      stableUseInputSrc.indexOf('const handleData'),
    );
    expect(handleFn, 'handleData must not begin a dispatch itself').not.toMatch(/beginInputDispatch/);
  });

  it('inactive subscriber short-circuits before any dispatch', () => {
    const handleFn = stableUseInputSrc.slice(stableUseInputSrc.indexOf('const handleData'));
    expect(handleFn).toMatch(/if \(!isActiveRef\.current\) return;/);
  });
});
