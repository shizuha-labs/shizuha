/**
 * SCLI-404 regression tests — required-input prompting must fail on EOF.
 *
 * `readline.question` never invokes its callback when stdin reaches EOF before
 * any line is typed, so a naive `new Promise((r) => rl.question(q, r))` never
 * settles and the CLI exits 0 after printing only the prompt.  These tests pin
 * the fixed contract: `promptRequired` rejects with `InputCancelledError` on
 * stdin EOF so the auth command family can exit nonzero with a diagnostic and
 * write no credential state.
 */
import { Readable } from 'node:stream';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';

import {
  InputCancelledError,
  promptLine,
  promptRequired,
} from '../../src/utils/prompt.js';

function nullOutput(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

function inputFrom(lines: string[], endImmediately: boolean): Readable {
  if (endImmediately) {
    return Readable.from([]);
  }
  return Readable.from(lines.map((l) => `${l}\n`));
}

describe('promptRequired (SCLI-404 EOF honesty)', () => {
  it('rejects with InputCancelledError when stdin closes with no input', async () => {
    await expect(
      promptRequired('Username: ', {
        input: inputFrom([], true),
        output: nullOutput(),
      }),
    ).rejects.toBeInstanceOf(InputCancelledError);
  });

  it('rejects with InputCancelledError for partial/empty EOF stream', async () => {
    // A stream that ends after emitting a partial non-terminated chunk is still
    // an EOF-without-a-complete-line case.
    const partial = Readable.from(['userna']);
    await expect(
      promptRequired('Username: ', { input: partial, output: nullOutput() }),
    ).rejects.toBeInstanceOf(InputCancelledError);
  });

  it('resolves with the trimmed answer when a line is provided', async () => {
    await expect(
      promptRequired('Username: ', {
        input: inputFrom(['  alice  '], false),
        output: nullOutput(),
      }),
    ).resolves.toBe('alice');
  });

  it('resolves empty string for an empty line (caller applies required check)', async () => {
    await expect(
      promptRequired('Password: ', {
        input: inputFrom([''], false),
        output: nullOutput(),
      }),
    ).resolves.toBe('');
  });

  it('does not settle twice (close racing a real answer)', async () => {
    // Answer line arrives, then the stream ends: the resolve path must win and
    // a later close must not reject the already-settled promise.
    const input = Readable.from(['bob\n']);
    const result = await promptRequired('Username: ', {
      input,
      output: nullOutput(),
    });
    expect(result).toBe('bob');
  });
});

describe('promptLine on a shared interface (SCLI-404 login username+password)', () => {
  it('reads two sequential prompts from one stdin stream', async () => {
    // Use a PassThrough so lines arrive like a live pipe (not a pre-buffered
    // stream that ends immediately and auto-closes the interface).
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const rl = createInterface({ input, output: nullOutput() });
    try {
      const first = promptLine(rl, 'Username: ');
      input.write('alice\n');
      expect(await first).toBe('alice');

      const second = promptLine(rl, 'Password: ');
      input.write('s3cret\n');
      expect(await second).toBe('s3cret');
    } finally {
      input.end();
      rl.close();
    }
  });

  it('rejects with InputCancelledError on EOF before the first prompt', async () => {
    const rl = createInterface({
      input: Readable.from([]),
      output: nullOutput(),
    });
    await expect(promptLine(rl, 'Username: ')).rejects.toBeInstanceOf(
      InputCancelledError,
    );
  });

  it('rejects with InputCancelledError on EOF before the second prompt', async () => {
    // Only one line is supplied; the stream ends before the second prompt, so
    // EOF hits the pending question.
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const rl = createInterface({ input, output: nullOutput() });
    try {
      const first = promptLine(rl, 'Username: ');
      input.write('alice\n');
      expect(await first).toBe('alice');

      const second = promptLine(rl, 'Password: ');
      input.end();
      await expect(second).rejects.toBeInstanceOf(InputCancelledError);
    } finally {
      rl.close();
    }
  });
});
