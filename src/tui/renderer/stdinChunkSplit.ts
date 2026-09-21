/**
 * SCLI-774: split a coalesced stdin chunk into per-keypress segments.
 *
 * A terminal/SSH/PTY routinely delivers an escape sequence and subsequent keys
 * in ONE read ('\x1b[BX' = Down + X typed back-to-back). Ink's vendored
 * parse-keypress consumes only the FIRST keypress of the string and — because
 * `fnKeyRe` has no end anchor — reports the WHOLE chunk as its sequence, so
 * stableUseInput mapped the trailing bytes into `input=''` and silently
 * dropped them (SCLI-461 e2e run 6757: 'valuable draftX' rendered as
 * 'valuable draft').
 *
 * Splitting rules:
 * - A chunk with NO escape byte is one segment (parsed as one printable input
 *   string — multi-char paste semantics preserved: MultiLineInput's
 *   paste-placeholder detection keys on the chunk arriving as one event).
 * - An escape byte starts a segment that is exactly ONE complete sequence:
 *   CSI (\x1b[ ... final byte, incl. kitty `\x1b[<n>u`), SS3 (\x1bO<char>),
 *   ESC-ESC (optionally followed by a CSI/SS3 body — the Alt-shifted form),
 *   or ESC + one char (the meta chord — parseKeypress consumes it wholly, so
 *   it stays one segment and Alt+X keeps working).
 * - Bytes between escape sequences form printable runs, one segment each.
 */

const CSI_RE = /^\x1b\[[0-9;:<>?]*[ \/-]*[@-~]/;
const SS3_RE = /^\x1bO[a-zA-Z0-9]/;
const ESC_ESC_SEQ_RE = /^\x1b\x1b(?:\[[0-9;:<>?]*[ \/-]*[@-~]|O[a-zA-Z0-9])?/;
const ESC_CHAR_RE = /^\x1b[\s\S]/;

export function splitStdinChunk(data: string): string[] {
  if (data.length === 0) return [];
  if (!data.includes('\x1b')) return [data];

  const segments: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] !== '\x1b') {
      // One printable run up to the next ESC — a single keypress event.
      let end = data.indexOf('\x1b', i);
      if (end === -1) end = data.length;
      segments.push(data.slice(i, end));
      i = end;
      continue;
    }
    const rest = data.slice(i);
    const match = CSI_RE.exec(rest) ?? SS3_RE.exec(rest) ?? ESC_ESC_SEQ_RE.exec(rest) ?? ESC_CHAR_RE.exec(rest);
    const consumed = match ? match[0].length : 1;
    segments.push(data.slice(i, i + consumed));
    i += consumed;
  }
  return segments;
}
