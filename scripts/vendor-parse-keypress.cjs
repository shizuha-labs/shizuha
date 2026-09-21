// Pristine ink@6.8.0 vendored parser (build/parse-keypress.js), CJS-adapted
// for the SCLI-774 verification harness. The repo's patches/ink+6.8.0.patch
// does not touch this file, so this matches the vendored copy byte-for-byte
// in behavior. kittyModifiers is stubbed with the real flag values from
// ink's kitty-keyboard.js (shift=1, alt=2, ctrl=4, meta=8? — see below).
'use strict';
// ink kitty-keyboard.js flag values (standard kitty protocol: shift=1, alt=2, ctrl=4)
const kittyModifiers = { shift: 1, alt: 2, ctrl: 4, super: 8, hyper: 16, meta: 32, capsLock: 64, numLock: 128 };
const metaKeyCodeRe = /^(?:\x1b)([a-zA-Z0-9])$/;
const fnKeyRe = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;
const keyName = {
  OP: 'f1', OQ: 'f2', OR: 'f3', OS: 'f4',
  '[11~': 'f1', '[12~': 'f2', '[13~': 'f3', '[14~': 'f4',
  '[[A': 'f1', '[[B': 'f2', '[[C': 'f3', '[[D': 'f4', '[[E': 'f5',
  '[15~': 'f5', '[17~': 'f6', '[18~': 'f7', '[19~': 'f8', '[20~': 'f9', '[21~': 'f10', '[23~': 'f11', '[24~': 'f12',
  '[A': 'up', '[B': 'down', '[C': 'right', '[D': 'left', '[E': 'clear', '[F': 'end', '[H': 'home',
  OA: 'up', OB: 'down', OC: 'right', OD: 'left', OE: 'clear', OF: 'end', OH: 'home',
  '[1~': 'home', '[2~': 'insert', '[3~': 'delete', '[4~': 'end', '[5~': 'pageup', '[6~': 'pagedown',
  '[[5~': 'pageup', '[[6~': 'pagedown',
  '[a': 'up', '[b': 'down', '[c': 'right', '[d': 'left', '[e': 'clear',
  '[2$': 'insert', '[3$': 'delete', '[5$': 'pageup', '[6$': 'pagedown', '[7$': 'home', '[8$': 'end',
  Oa: 'up', Ob: 'down', Oc: 'right', Od: 'left', Oe: 'clear',
  '[2^': 'insert', '[3^': 'delete', '[5^': 'pageup', '[6^': 'pagedown', '[7^': 'home', '[8^': 'end',
  '[Z': 'tab',
};
const nonAlphanumericKeys = [...Object.values(keyName), 'backspace'];
const isShiftKey = (code) => ['[a','[b','[c','[d','[e','[2$','[3$','[5$','[6$','[7$','[8$','[Z'].includes(code);
const isCtrlKey = (code) => ['Oa','Ob','Oc','Od','Oe','[2^','[3^','[5^','[6^','[7^','[8^'].includes(code);
const kittyKeyRe = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?(?:;([\d:]+))?)?u$/;
const kittySpecialKeyRe = /^\x1b\[(\d+);(\d+):(\d+)([A-Za-z~])$/;
const kittySpecialLetterKeys = { A: 'up', B: 'down', C: 'right', D: 'left', E: 'clear', F: 'end', H: 'home', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
const kittySpecialNumberKeys = { 2: 'insert', 3: 'delete', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end', 11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5', 17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10', 23: 'f11', 24: 'f12' };
const kittyCodepointNames = { 27: 'escape', 9: 'tab', 127: 'delete', 8: 'backspace' };
const isValidCodepoint = (cp) => cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
const safeFromCodePoint = (cp) => isValidCodepoint(cp) ? String.fromCodePoint(cp) : '?';
function resolveEventType(value) { if (value === 3) return 'release'; if (value === 2) return 'repeat'; return 'press'; }
function parseKittyModifiers(modifiers) {
  return {
    ctrl: !!(modifiers & kittyModifiers.ctrl), shift: !!(modifiers & kittyModifiers.shift),
    meta: !!(modifiers & kittyModifiers.meta), option: !!(modifiers & kittyModifiers.alt),
    super: !!(modifiers & kittyModifiers.super), hyper: !!(modifiers & kittyModifiers.hyper),
    capsLock: !!(modifiers & kittyModifiers.capsLock), numLock: !!(modifiers & kittyModifiers.numLock),
  };
}
const parseKittyKeypress = (s) => {
  const match = kittyKeyRe.exec(s);
  if (!match) return null;
  const codepoint = parseInt(match[1], 10);
  const modifiers = match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : 0;
  const eventType = match[3] ? parseInt(match[3], 10) : 1;
  const textField = match[4];
  if (!isValidCodepoint(codepoint)) return null;
  let text;
  if (textField) text = textField.split(':').map((cp) => safeFromCodePoint(parseInt(cp, 10))).join('');
  let name; let isPrintable;
  if (codepoint === 32) { name = 'space'; isPrintable = true; }
  else if (codepoint === 13) { name = 'return'; isPrintable = true; }
  else if (kittyCodepointNames[codepoint]) { name = kittyCodepointNames[codepoint]; isPrintable = false; }
  else if (codepoint >= 1 && codepoint <= 26) { name = String.fromCodePoint(codepoint + 96); isPrintable = false; }
  else { name = safeFromCodePoint(codepoint).toLowerCase(); isPrintable = true; }
  if (isPrintable && !text) text = safeFromCodePoint(codepoint);
  return { name, ...parseKittyModifiers(modifiers), eventType: resolveEventType(eventType), sequence: s, raw: s, isKittyProtocol: true, isPrintable, text };
};
const parseKittySpecialKey = (s) => {
  const match = kittySpecialKeyRe.exec(s);
  if (!match) return null;
  const modifiers = Math.max(0, parseInt(match[2], 10) - 1);
  const eventType = parseInt(match[3], 10);
  const terminator = match[4];
  const name = terminator === '~' ? kittySpecialNumberKeys[parseInt(match[1], 10)] : kittySpecialLetterKeys[terminator];
  if (!name) return null;
  return { name, ...parseKittyModifiers(modifiers), eventType: resolveEventType(eventType), sequence: s, raw: s, isKittyProtocol: true, isPrintable: false };
};
const parseKeypress = (s = '') => {
  let parts;
  if (Buffer.isBuffer(s)) {
    if (s[0] > 127 && s[1] === undefined) { s[0] -= 128; s = '\x1b' + String(s); }
    else s = String(s);
  } else if (s !== undefined && typeof s !== 'string') s = String(s);
  else if (!s) s = '';
  const kittyResult = parseKittyKeypress(s);
  if (kittyResult) return kittyResult;
  const kittySpecialResult = parseKittySpecialKey(s);
  if (kittySpecialResult) return kittySpecialResult;
  if (kittyKeyRe.test(s)) {
    return { name: '', ctrl: false, meta: false, shift: false, option: false, sequence: s, raw: s, isKittyProtocol: true, isPrintable: false };
  }
  const key = { name: '', ctrl: false, meta: false, shift: false, option: false, sequence: s, raw: s };
  key.sequence = key.sequence || s || key.name;
  if (s === '\r' || s === '\x1b\r') { key.raw = undefined; key.name = 'return'; key.option = s.length === 2; }
  else if (s === '\n') key.name = 'enter';
  else if (s === '\t') key.name = 'tab';
  else if (s === '\b' || s === '\x1b\b') { key.name = 'backspace'; key.meta = s.charAt(0) === '\x1b'; }
  else if (s === '\x7f' || s === '\x1b\x7f') { key.name = 'delete'; key.meta = s.charAt(0) === '\x1b'; }
  else if (s === '\x1b' || s === '\x1b\x1b') { key.name = 'escape'; key.meta = s.length === 2; }
  else if (s === ' ' || s === '\x1b ') { key.name = 'space'; key.meta = s.length === 2; }
  else if (s.length === 1 && s <= '\x1a') { key.name = String.fromCharCode(s.charCodeAt(0) + 96); key.ctrl = true; }
  else if (s.length === 1 && s >= '0' && s <= '9') key.name = 'number';
  else if (s.length === 1 && s >= 'a' && s <= 'z') key.name = s;
  else if (s.length === 1 && s >= 'A' && s <= 'Z') { key.name = s.toLowerCase(); key.shift = true; }
  else if ((parts = metaKeyCodeRe.exec(s))) { key.meta = true; key.shift = /^[A-Z]$/.test(parts[1]); }
  else if ((parts = fnKeyRe.exec(s))) {
    const segs = [...s];
    if (segs[0] === '\u001b' && segs[1] === '\u001b') key.option = true;
    const code = [parts[1], parts[2], parts[4], parts[6]].filter(Boolean).join('');
    const modifier = (parts[3] || parts[5] || 1) - 1;
    key.ctrl = !!(modifier & 4);
    key.meta = !!(modifier & 10);
    key.shift = !!(modifier & 1);
    key.code = code;
    key.name = keyName[code];
    key.shift = isShiftKey(code) || key.shift;
    key.ctrl = isCtrlKey(code) || key.ctrl;
  }
  return key;
};
module.exports = { parseKeypress, nonAlphanumericKeys };
