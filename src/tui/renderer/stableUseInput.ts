/**
 * Stable useInput hook — replaces ink/build/hooks/use-input.js via esbuild.
 *
 * Ink's original useInput puts `inputHandler` in the useEffect dependency
 * array. Every time the handler reference changes (i.e., every render), the
 * effect re-runs: removes the old listener, adds the new one. During that
 * tiny window, keystrokes can be lost or delivered out of order.
 *
 * This version:
 *   - Stores the handler in a ref (always current, never re-subscribes)
 *   - Stores isActive in a ref (no effect re-run on activation change)
 *   - Registers the stdin listener ONCE in the initial effect
 *   - Provides the exact same API as Ink's useInput
 *
 * Import paths below are relative to ink/build/hooks/ because esbuild's
 * onLoad plugin sets resolveDir to that directory.
 */

import { useEffect, useRef } from 'react';
// @ts-expect-error — Ink internal, resolved via esbuild resolveDir
import parseKeypress, { nonAlphanumericKeys } from '../parse-keypress.js';
// @ts-expect-error — Ink internal
import useStdin from './use-stdin.js';
// @ts-expect-error — resolved from Ink's hook resolveDir by the esbuild patch
import { beginInputDispatch } from '../../../../src/tui/renderer/inputDispatch.js';
// @ts-expect-error — resolved from Ink's hook resolveDir by the esbuild patch
import { splitStdinChunk } from '../../../../src/tui/renderer/stdinChunkSplit.js';

// Inlined (do not import src/ — this file is loaded with resolveDir =
// ink/build/hooks). Keep in sync with src/tui/utils/terminalKeys.ts.
// Ink names ASCII DEL (0x7f, the Backspace key) as `delete`; CSI 3~ is
// the real Forward Delete. Treating the flag as CSI 3~ makes Backspace
// a no-op at end-of-line.
function classifyTerminalDelete(sequence: string, name?: string): {
  backspace: boolean;
  forwardDelete: boolean;
} {
  const seq = sequence ?? '';
  const isAsciiDel = seq === '\u007f' || /^\u007f+$/.test(seq) || seq === '\u001b\u007f';
  const isCsiForwardDelete = seq === '\u001b[3~' || /\[3(;[\d;]+)?~$/.test(seq);
  if (isAsciiDel) return { backspace: true, forwardDelete: false };
  if (isCsiForwardDelete) return { backspace: false, forwardDelete: true };
  return {
    backspace: name === 'backspace',
    forwardDelete: name === 'delete',
  };
}

const useInput = (inputHandler: any, options: any = {}) => {
  const {
    stdin,
    setRawMode,
    internal_exitOnCtrlC: exitOnCtrlC,
    internal_eventEmitter: eventEmitter,
  } = useStdin() as any;

  // ── Stable refs: updated every render, never trigger re-subscription ──
  const handlerRef = useRef(inputHandler);
  handlerRef.current = inputHandler;

  const isActiveRef = useRef(options.isActive !== false);
  isActiveRef.current = options.isActive !== false;

  const exitOnCtrlCRef = useRef(exitOnCtrlC);
  exitOnCtrlCRef.current = exitOnCtrlC;

  // ── One-time effect: enable raw mode + register listener ──
  useEffect(() => {
    setRawMode(true);

    // SCLI-774 dispatch boundary (explicit): ONE dispatch generation per
    // KEYPRESS event, not per stdin read. A coalesced chunk ('\x1b[BX' =
    // Down + X) is N logical key events; each gets its own generation so a
    // subscriber consuming the first (e.g. a pager handling Down) cannot
    // suppress the trailing bytes for later subscribers. A plain-text chunk
    // (paste) parses as ONE event and keeps exactly one generation — the
    // pre-fix semantics for that case are unchanged.
    const dispatchKeypress = (keypress: any) => {
      if (isActiveRef.current) beginInputDispatch();
      if (!isActiveRef.current) return;

      const deleteFlags = classifyTerminalDelete(keypress.sequence ?? '', keypress.name);

      const key: Record<string, any> = {
        upArrow: keypress.name === 'up',
        downArrow: keypress.name === 'down',
        leftArrow: keypress.name === 'left',
        rightArrow: keypress.name === 'right',
        pageDown: keypress.name === 'pagedown',
        pageUp: keypress.name === 'pageup',
        home: keypress.name === 'home',
        end: keypress.name === 'end',
        return: keypress.name === 'return',
        escape: keypress.name === 'escape',
        ctrl: keypress.ctrl,
        shift: keypress.shift,
        tab: keypress.name === 'tab',
        backspace: deleteFlags.backspace,
        delete: deleteFlags.forwardDelete,
        meta: keypress.meta || keypress.name === 'escape' || keypress.option,
        super: keypress.super ?? false,
        hyper: keypress.hyper ?? false,
        capsLock: keypress.capsLock ?? false,
        numLock: keypress.numLock ?? false,
        eventType: keypress.eventType,
      };

      let input: string;

      if (keypress.isKittyProtocol) {
        if (keypress.isPrintable) {
          input = keypress.text ?? keypress.name;
        } else if (keypress.ctrl && keypress.name.length === 1) {
          input = keypress.name;
        } else {
          input = '';
        }
      } else if (keypress.ctrl) {
        input = keypress.name;
      } else {
        input = keypress.sequence;
      }

      if (
        !keypress.isKittyProtocol &&
        nonAlphanumericKeys.includes(keypress.name)
        // Keep ASCII DEL/BS so MultiLineInput can count a held-Backspace run.
        && !/^[\u007f\u0008]+$/.test(keypress.sequence ?? '')
      ) {
        input = '';
      }

      // Strip leading ESC that remains after parseKeypress
      if (input.startsWith('\u001B')) {
        input = input.slice(1);
      }

      if (
        input.length === 1 &&
        typeof input[0] === 'string' &&
        /[A-Z]/.test(input[0])
      ) {
        key.shift = true;
      }

      // Respect exitOnCtrlC (our app sets it to false, so this always passes)
      if (!(input === 'c' && key.ctrl) || !exitOnCtrlCRef.current) {
        handlerRef.current(input, key);
      }
    };

    // SCLI-774: a stdin chunk can coalesce an escape sequence with subsequent
    // keys ('\x1b[BX' = Down + X). parseKeypress consumes only the FIRST
    // keypress and — fnKeyRe having no end anchor — reports the WHOLE chunk
    // as its sequence, so the trailing bytes were mapped into input='' and
    // silently dropped (SCLI-461 e2e run 6757). Split the chunk into
    // per-keypress segments and dispatch each through the same pipeline.
    // Plain-text chunks (no ESC) are one segment — paste semantics preserved.
    const handleData = (data: string) => {
      if (!isActiveRef.current) return;
      for (const segment of splitStdinChunk(data)) {
        dispatchKeypress(parseKeypress(segment));
      }
    };

    eventEmitter?.on('input', handleData);

    return () => {
      eventEmitter?.removeListener('input', handleData);
      setRawMode(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps — register ONCE, never re-subscribe
};

export default useInput;
