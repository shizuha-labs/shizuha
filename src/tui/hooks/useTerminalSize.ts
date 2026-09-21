import { useState, useEffect, useRef } from 'react';

export interface TerminalSize {
  rows: number;
  columns: number;
}

/**
 * SCLI-372: a SINGLE shared native `resize` listener, not one per hook use.
 *
 * The old hook called `process.stdout.on('resize', ...)` in every component
 * that used it (TranscriptPager, StatusBar, SessionPicker, MessageBlock,
 * InputBox, ModelPicker, StreamingText, App). During prompt-queue interactions
 * those components mount/unmount repeatedly, so native listeners accumulated
 * until Node printed `MaxListenersExceededWarning: 11 resize listeners added
 * to [WriteStream]` straight into the TUI.
 *
 * Fix: attach ONE module-level native listener (lazily, idempotently) and let
 * each hook use subscribe/unsubscribe from a local subscriber set. No matter
 * how many components mount, exactly one native listener ever exists, and a
 * component unmounting can never leak.
 */

type Subscriber = (size: TerminalSize) => void;

let sharedSubscribers = new Set<Subscriber>();
let sharedTimer: ReturnType<typeof setTimeout> | null = null;
let nativeAttached = false;

function readSize(): TerminalSize {
  return {
    rows: process.stdout.rows ?? 24,
    columns: process.stdout.columns ?? 80,
  };
}

function emitResize(): void {
  if (sharedTimer) clearTimeout(sharedTimer);
  sharedTimer = setTimeout(() => {
    sharedTimer = null;
    const next = readSize();
    for (const sub of sharedSubscribers) {
      try {
        sub(next);
      } catch {
        // A subscriber throwing must never break the shared dispatch.
      }
    }
  }, 80);
}

function ensureNativeListener(): void {
  if (nativeAttached) return;
  nativeAttached = true;
  process.stdout.on('resize', emitResize);
}

/** Hook returning terminal dimensions, debounced on resize.
 *  During rapid resizing (zoom in/out), updates are suppressed for 80ms
 *  after the last resize event to avoid rendering stale intermediate layouts. */
export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(readSize);

  useEffect(() => {
    ensureNativeListener();
    const sub: Subscriber = (next) => {
      setSize((prev) => {
        if (prev.rows === next.rows && prev.columns === next.columns) {
          return prev;
        }
        return next;
      });
    };
    sharedSubscribers.add(sub);
    return () => {
      sharedSubscribers.delete(sub);
    };
  }, []);

  return size;
}
