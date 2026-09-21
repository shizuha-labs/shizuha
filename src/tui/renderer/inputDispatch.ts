/**
 * Cross-module input-consumption boundary for the patched Ink renderer.
 *
 * `stableUseInput.ts` is loaded once as an esbuild replacement for Ink and
 * source modules import this helper normally, so a Symbol.for global is the
 * shared boundary between those two module instances.
 */
const inputDispatchKey = Symbol.for('shizuha.tui.input-dispatch');

export interface InputDispatchState {
  generation: number;
  consumedGeneration: number | null;
  dispatchOpen: boolean;
}

export function createInputDispatchState(): InputDispatchState {
  return {
    generation: 0,
    consumedGeneration: null,
    dispatchOpen: false,
  };
}

function state(): InputDispatchState {
  const root = globalThis as typeof globalThis & { [inputDispatchKey]?: InputDispatchState };
  return root[inputDispatchKey] ??= createInputDispatchState();
}

/** Give every subscriber in one synchronous EventEmitter broadcast one ID. */
export function beginInputDispatch(current: InputDispatchState = state()): void {
  if (current.dispatchOpen) return;
  current.generation += 1;
  current.dispatchOpen = true;
  queueMicrotask(() => { current.dispatchOpen = false; });
}

export function consumeInputDispatch(current: InputDispatchState): void {
  current.consumedGeneration = current.generation;
}

/** Consume this stdin broadcast for subscribers later in the same dispatch. */
export function consumeCurrentInputDispatch(): void {
  consumeInputDispatch(state());
}

export function inputDispatchWasConsumed(current: InputDispatchState): boolean {
  return current.generation > 0 && current.consumedGeneration === current.generation;
}

export function currentInputDispatchWasConsumed(): boolean {
  return inputDispatchWasConsumed(state());
}
