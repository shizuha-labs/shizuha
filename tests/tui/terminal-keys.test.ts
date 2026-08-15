import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyTerminalDelete } from '../../src/tui/utils/terminalKeys.js';
import { applyBackwardDelete, applyForwardDelete } from '../../src/tui/utils/textEdit.js';

/**
 * Ink parse-keypress names ASCII DEL (0x7f) as `delete` and CSI 3~ as
 * `delete` too. Plain Backspace is 0x7f. If we honor Ink's name, Backspace
 * at end-of-line becomes applyForwardDelete → null (no-op).
 */
describe('classifyTerminalDelete', () => {
  it('treats ASCII DEL (terminal Backspace) as backspace, not forward delete', () => {
    expect(classifyTerminalDelete('\u007f', 'delete')).toEqual({
      backspace: true,
      forwardDelete: false,
    });
  });

  it('treats a held DEL run as backspace', () => {
    expect(classifyTerminalDelete('\u007f\u007f\u007f', 'delete')).toEqual({
      backspace: true,
      forwardDelete: false,
    });
  });

  it('treats CSI 3~ as forward delete', () => {
    expect(classifyTerminalDelete('\u001b[3~', 'delete')).toEqual({
      backspace: false,
      forwardDelete: true,
    });
  });

  it('treats ASCII BS as backspace (Ctrl+Backspace / Ctrl+H)', () => {
    expect(classifyTerminalDelete('\u0008', 'backspace')).toEqual({
      backspace: true,
      forwardDelete: false,
    });
  });
});

describe('misrouting DEL as forward-delete is a no-op at EOL', () => {
  it('applyForwardDelete at end of line does not remove the last char', () => {
    expect(applyForwardDelete('hello', 5)).toBeNull();
  });

  it('applyBackwardDelete at end of line removes the last char', () => {
    const r = applyBackwardDelete('hello', 5);
    expect(r?.text).toBe('hell');
    expect(r?.cursor).toBe(4);
  });
});

describe('stableUseInput stays in sync with the classifier', () => {
  it('inlines the ASCII-DEL → backspace remap (resolveDir cannot import src/)', () => {
    const src = readFileSync(
      resolve(import.meta.dirname!, '../../src/tui/renderer/stableUseInput.ts'),
      'utf8',
    );
    expect(src).toMatch(/classifyTerminalDelete/);
    expect(src).toMatch(/seq === '\\u007f'/);
    expect(src).toMatch(/seq === '\\u001b\[3~'/);
    expect(src).toMatch(/backspace: deleteFlags\.backspace/);
    expect(src).toMatch(/delete: deleteFlags\.forwardDelete/);
    expect(src).toMatch(/!\/\^\[\\u007f\\u0008\]\+\$\/\.test\(keypress\.sequence/);
  });
});
