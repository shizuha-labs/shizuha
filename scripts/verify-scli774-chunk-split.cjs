// SCLI-774 verification: run the pristine vendored parser against
// splitStdinChunk segments and assert the stableUseInput per-segment mapping.
'use strict';
const { parseKeypress } = require('./vendor-parse-keypress.cjs');

// transcribed from src/tui/renderer/stdinChunkSplit.ts
const CSI_RE = /^\x1b\[[0-9;:<>?]*[ \/-]*[@-~]/;
const SS3_RE = /^\x1bO[a-zA-Z0-9]/;
const ESC_ESC_SEQ_RE = /^\x1b\x1b(?:\[[0-9;:<>?]*[ \/-]*[@-~]|O[a-zA-Z0-9])?/;
const ESC_CHAR_RE = /^\x1b[\s\S]/;
function splitStdinChunk(data) {
  if (data.length === 0) return [];
  if (!data.includes('\x1b')) return [data];
  const segments = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] !== '\x1b') {
      let end = data.indexOf('\x1b', i);
      if (end === -1) end = data.length;
      segments.push(data.slice(i, end));
      i = end;
      continue;
    }
    const rest = data.slice(i);
    const m = CSI_RE.exec(rest) ?? SS3_RE.exec(rest) ?? ESC_ESC_SEQ_RE.exec(rest) ?? ESC_CHAR_RE.exec(rest);
    const consumed = m ? m[0].length : 1;
    segments.push(data.slice(i, i + consumed));
    i += consumed;
  }
  return segments;
}

// stableUseInput's input mapping (post-fix shape, per segment)
function mapSegment(segment) {
  const k = parseKeypress(segment);
  let input;
  if (k.isKittyProtocol) {
    input = k.isPrintable ? (k.text ?? k.name) : (k.ctrl && k.name.length === 1 ? k.name : '');
  } else if (k.ctrl) input = k.name;
  else input = k.sequence;
  if (!k.isKittyProtocol && nonAlnum(k) && !/^[\u007f\u0008]+$/.test(k.sequence ?? '')) input = '';
  if (input.startsWith('\u001B')) input = input.slice(1);
  return { name: k.name, meta: !!k.meta, input };
}
function nonAlnum(k) {
  return ['up','down','left','right','pageup','pagedown','home','end','insert','delete','backspace','escape','tab',
    'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12'].includes(k.name);
}
const mapChunk = (chunk) => splitStdinChunk(chunk).map(mapSegment);

let fail = 0;
function check(chunk, want) {
  const got = JSON.stringify(mapChunk(chunk));
  const wantStr = JSON.stringify(want);
  if (got !== wantStr) { fail++; console.log('FAIL', JSON.stringify(chunk), '\n  got ', got, '\n  want', wantStr); }
}

// THE bug case: Down + X coalesced in one chunk — X must survive as input
check('\x1b[BX', [{ name: 'down', meta: false, input: '' }, { name: 'x', meta: false, input: 'X' }]);
// Escape + X coalesced: stays a meta chord (parseKeypress consumes it wholly)
check('\x1bX', [{ name: '', meta: true, input: 'X' }]);
// plain-text chunk: ONE event (paste semantics preserved)
check('hello world', [{ name: '', meta: false, input: 'hello world' }]);
check('abc\x1b[A', [{ name: '', meta: false, input: 'abc' }, { name: 'up', meta: false, input: '' }]);
check('\x1b[Bhi\x1b[C', [{ name: 'down', meta: false, input: '' }, { name: '', meta: false, input: 'hi' }, { name: 'right', meta: false, input: '' }]);
check('\x1b[3~x', [{ name: 'delete', meta: false, input: '' }, { name: 'x', meta: false, input: 'x' }]);
check('\x1bOAz', [{ name: 'up', meta: false, input: '' }, { name: 'z', meta: false, input: 'z' }]);
// kitty CSI-u Enter: printable text '\r' + key.return=true → MultiLineInput submits
check('\x1b[13u', [{ name: 'return', meta: false, input: '\r' }]);
// Alt-shifted sequence (ESC ESC form): pristine parser reports option+down,
// kept as ONE segment (no split inside the sequence)
check('\x1b\x1b[B', [{ name: 'down', meta: false, input: '' }]);
// lone trailing ESC
check('ab\x1b', [{ name: '', meta: false, input: 'ab' }, { name: 'escape', meta: false, input: '' }]);
// multi-line paste chunk (no ESC) stays ONE event
check('line1\nline2\n', [{ name: '', meta: false, input: 'line1\nline2\n' }]);
// DEL-only run (held backspace, no ESC): one segment, sequence preserved so
// MultiLineInput can count the run
check('\u007f\u007f', [{ name: '', meta: false, input: '\u007f\u007f' }]);
// mixed DEL+y chunk (no ESC): one printable-run event — pre-fix behavior unchanged
check('\u007f\u007fy', [{ name: '', meta: false, input: '\u007f\u007fy' }]);
// ctrl+char unchanged
check('\x01', [{ name: 'a', meta: false, input: 'a' }]);
// CR submit unchanged (lone segment)
check('\r', [{ name: 'return', meta: false, input: '\r' }]);
// CR-suffixed coalesced chunk (SCLI-370 contract): text + CR in one chunk
check('hi\r', [{ name: '', meta: false, input: 'hi\r' }]);

console.log(fail === 0 ? 'ALL SPLIT+PARSE CASES PASS' : fail + ' FAILURES');
process.exit(fail === 0 ? 0 : 1);
