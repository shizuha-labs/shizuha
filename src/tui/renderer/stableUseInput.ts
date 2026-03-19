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

    const handleData = (data: string) => {
      if (!isActiveRef.current) return;

      const keypress = parseKeypress(data);

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
        backspace: keypress.name === 'backspace',
        delete: keypress.name === 'delete',
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

    eventEmitter?.on('input', handleData);

    return () => {
      eventEmitter?.removeListener('input', handleData);
      setRawMode(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps — register ONCE, never re-subscribe
};

export default useInput;
