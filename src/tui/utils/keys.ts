/**
 * Terminal key helpers.
 *
 * Shift+Tab is not reported uniformly across terminals/multiplexers:
 * - Ink key object: { shift: true, tab: true }
 * - Raw input sequence: "\x1b[Z" (reverse tab)
 * - Some stacks emit variants like "\x1b[1;2Z"
 */
export function isModeCycleKey(
  input: string,
  key: { shift?: boolean; tab?: boolean },
): boolean {
  if (key.shift && key.tab) return true;
  if (input === '\u001b[Z') return true;
  if (/^\u001b\[[0-9;]*Z$/.test(input)) return true;
  return false;
}

