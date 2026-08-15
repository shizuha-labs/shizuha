/** Mouse wheel decoding for terminals using SGR (DECSET 1006) reports. */

const SGR_MOUSE_RE = /^(?:\x1b)?\[<(\d+);(\d+);(\d+)([mM])$/;

export type MouseWheelDirection = 'up' | 'down';

/**
 * Ink removes the leading ESC before delivering unknown control sequences to
 * useInput, while raw stdin keeps it. Accept both representations.
 */
export function parseMouseWheel(input: string): MouseWheelDirection | null {
  const match = SGR_MOUSE_RE.exec(input);
  if (!match || match[4] !== 'M') return null;

  const button = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(button) || (button & 64) === 0) return null;

  const wheelButton = button & 3;
  if (wheelButton === 0) return 'up';
  if (wheelButton === 1) return 'down';
  return null;
}

export function isSgrMouseSequence(input: string): boolean {
  return SGR_MOUSE_RE.test(input);
}
