/**
 * Required-input prompting for CLI auth flows (SCLI-404).
 *
 * `readline.question` does not invoke its callback when stdin hits EOF before
 * the user types anything (e.g. `shizuha login </dev/null`).  The pending
 * promise never settles, the event loop drains, and the process exits 0 with
 * only the prompt printed — a false-success auth result for scripts, installers
 * and CI.  This helper closes that hole by rejecting with `InputCancelledError`
 * when the underlying stream closes, so callers can exit nonzero with a single
 * bounded stderr diagnostic and never touch credential state on the failed path.
 */
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class InputCancelledError extends Error {
  constructor() {
    super('input cancelled (EOF)');
    this.name = 'InputCancelledError';
  }
}

/**
 * Ask one required question on an existing readline interface.
 *
 * Resolves with the trimmed answer; rejects with `InputCancelledError` if the
 * underlying input stream closes (EOF) before a complete line is submitted.
 * Keeps the interface open so callers can ask several prompts against the same
 * stdin stream.
 */
export function promptLine(rl: Interface, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onClose = (): void => {
      // stdin closed before a line was submitted -> no required input.
      rl.close();
      reject(new InputCancelledError());
    };
    const onAnswer = (answer: string): void => {
      // Remove the close listener first so a subsequent close of the shared
      // interface (e.g. after the last prompt) cannot race a later resolve
      // with a spurious rejection.
      rl.removeListener('close', onClose);
      resolve(answer.trim());
    };

    rl.on('close', onClose);
    try {
      rl.question(prompt, onAnswer);
    } catch {
      // readline throws ERR_USE_AFTER_CLOSE if the underlying input stream has
      // already ended and auto-closed the interface (e.g. a short stdin pipe
      // between two prompts).  Treat that as the same EOF/cancel contract.
      rl.removeListener('close', onClose);
      reject(new InputCancelledError());
    }
  });
}

/**
 * Prompt for a single required value on a fresh interface; rejects with
 * `InputCancelledError` on EOF.
 *
 * `input`/`output` default to `process.stdin`/`process.stdout` but are
 * injectable for tests.  Use this only when exactly one prompt is needed; for
 * multi-prompt flows (e.g. `login` username + password) create one interface
 * and use `promptLine` for each prompt so they share the same stdin stream.
 */
export function promptRequired(
  prompt: string,
  options: { input?: Readable; output?: Writable } = {},
): Promise<string> {
  const rl: Interface = createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
  });
  return promptLine(rl, prompt).finally(() => {
    // Close the interface on both settle paths; the close event has already
    // fired or the answer was consumed, so this cannot double-settle.
    rl.close();
  });
}
