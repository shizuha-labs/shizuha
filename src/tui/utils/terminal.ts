/** Terminal capability flags for TUI rendering decisions. */

const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) return true;
  if (FALSE_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

export function isTmuxSession(): boolean {
  return Boolean(process.env['TMUX']);
}

/**
 * Animation policy:
 * - default ON everywhere (including tmux — diffLogUpdate's line-diff
 *   renderer overwrites in place, so there's no repaint flicker)
 * - override with SHIZUHA_TUI_ANIMATIONS=0 to disable
 */
export function shouldAnimateTUI(): boolean {
  const override = parseBooleanEnv(process.env['SHIZUHA_TUI_ANIMATIONS']);
  if (override !== undefined) return override;
  return true;
}

/**
 * Synchronized-output (DECSET 2026) policy:
 * - default OFF in tmux (prevents pane jitter on unsupported setups)
 * - override with SHIZUHA_SYNC_OUTPUT=1|0
 */
export function shouldUseSynchronizedOutput(): boolean {
  const override = parseBooleanEnv(process.env['SHIZUHA_SYNC_OUTPUT']);
  if (override !== undefined) return override;
  return !isTmuxSession();
}

/** Legacy constant kept for existing call sites. */
export const IS_TMUX = isTmuxSession();
