import { shouldUseSynchronizedOutput } from './terminal.js';

/**
 * DEC Private Mode 2026 — Synchronized Output.
 *
 * Wraps process.stdout.write to batch writes into atomic terminal frames.
 * The terminal buffers all output between BSU (Begin Synchronized Update)
 * and ESU (End Synchronized Update), then paints once — eliminating tearing
 * and flickering caused by partial screen updates.
 *
 * Unsupported terminals silently ignore the escape sequences.
 *
 * Reference: https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
 */

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

interface PendingWrite {
  data: string | Uint8Array;
  encoding?: BufferEncoding;
  callback?: (err?: Error | null) => void;
}

/**
 * Patch process.stdout.write to wrap bursts of writes in DEC 2026 markers.
 * All synchronous writes within a single event-loop turn are batched into
 * one atomic terminal update via queueMicrotask.
 *
 * Returns a cleanup function that restores the original stdout.write.
 */
export function enableSynchronizedOutput(): () => void {
  if (!process.stdout.isTTY || !shouldUseSynchronizedOutput()) {
    return () => {};
  }

  const original = process.stdout.write;
  const bound = original.bind(process.stdout);

  let batchActive = false;
  let pending: PendingWrite[] = [];

  const patched = function (
    this: NodeJS.WriteStream,
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean {
    let encoding: BufferEncoding | undefined;
    let cb: ((err?: Error | null) => void) | undefined;

    if (typeof encodingOrCallback === 'function') {
      cb = encodingOrCallback;
    } else {
      encoding = encodingOrCallback;
      cb = callback;
    }

    pending.push({ data: chunk, encoding, callback: cb });

    if (!batchActive) {
      batchActive = true;
      bound(BSU);

      queueMicrotask(() => {
        const writes = pending;
        pending = [];
        batchActive = false;

        for (const w of writes) {
          if (w.encoding) {
            bound(w.data as string, w.encoding, w.callback);
          } else if (w.callback) {
            bound(w.data, w.callback);
          } else {
            bound(w.data);
          }
        }

        bound(ESU);
      });
    }

    return true;
  };

  process.stdout.write = patched as typeof process.stdout.write;

  return () => {
    process.stdout.write = original;
  };
}
