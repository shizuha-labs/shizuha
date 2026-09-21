/**
 * SCLI-548: help dismiss must consume the exact stdin broadcast.
 *
 * Production order: overlay receives `q` and dismisses, React activates the
 * composer, then the same Ink EventEmitter broadcast reaches composer input
 * subscribers. The following `/` begins a new broadcast and must be accepted.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginInputDispatch,
  consumeInputDispatch,
  createInputDispatchState,
  inputDispatchWasConsumed,
  type InputDispatchState,
} from '../../src/tui/renderer/inputDispatch.js';

describe('SCLI-548 help dismiss input isolation', () => {
  let dispatch: InputDispatchState;

  beforeEach(() => {
    dispatch = createInputDispatchState();
  });

  it('does not suppress before any stdin dispatch', () => {
    expect(inputDispatchWasConsumed(dispatch)).toBe(false);
  });

  it('rejects the rest of the broadcast that dismissed help', () => {
    beginInputDispatch(dispatch);
    expect(inputDispatchWasConsumed(dispatch)).toBe(false);

    consumeInputDispatch(dispatch);

    // InputBox and MultiLineInput run later in this same EventEmitter emit.
    beginInputDispatch(dispatch);
    expect(inputDispatchWasConsumed(dispatch)).toBe(true);
    expect(inputDispatchWasConsumed(dispatch)).toBe(true);
  });

  it('accepts the first key of the next slash command immediately', async () => {
    beginInputDispatch(dispatch);
    consumeInputDispatch(dispatch);
    expect(inputDispatchWasConsumed(dispatch)).toBe(true);

    // No timer: the next stdin chunk is a distinct broadcast and is accepted.
    await Promise.resolve();
    beginInputDispatch(dispatch);
    expect(inputDispatchWasConsumed(dispatch)).toBe(false);
  });

  it('keeps Escape control on the same consumption boundary', async () => {
    beginInputDispatch(dispatch);
    consumeInputDispatch(dispatch);
    expect(inputDispatchWasConsumed(dispatch)).toBe(true);

    await Promise.resolve();
    beginInputDispatch(dispatch);
    expect(inputDispatchWasConsumed(dispatch)).toBe(false);
  });
});
