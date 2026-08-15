/**
 * Ink's parse-keypress names ASCII DEL (0x7f) as `delete` and ASCII BS
 * (0x08) as `backspace`. Real terminals send 0x7f for the Backspace key and
 * CSI 3~ for Forward Delete. Treating Ink's `delete` flag as Forward Delete
 * makes Backspace a no-op at end-of-line (the usual typing cursor).
 */

export interface TerminalDeleteFlags {
  backspace: boolean;
  forwardDelete: boolean;
}

export function classifyTerminalDelete(
  sequence: string,
  name?: string,
): TerminalDeleteFlags {
  const seq = sequence ?? '';
  const isAsciiDel = seq === '\u007f' || /^\u007f+$/.test(seq) || seq === '\u001b\u007f';
  const isCsiForwardDelete =
    seq === '\u001b[3~'
    || /\[3(;[\d;]+)?~$/.test(seq);

  if (isAsciiDel) return { backspace: true, forwardDelete: false };
  if (isCsiForwardDelete) return { backspace: false, forwardDelete: true };

  return {
    backspace: name === 'backspace',
    forwardDelete: name === 'delete',
  };
}
