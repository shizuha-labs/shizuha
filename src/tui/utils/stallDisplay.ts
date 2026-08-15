/**
 * Cold model starts can legitimately spend several minutes in prefill without
 * producing an event. Keep that ordinary wait quiet; only promote it to the
 * recovery UI once it is long enough to be actionable.
 */
export const DEFAULT_TUI_STALL_ESCALATION_MS = 5 * 60_000;

/**
 * Once promoted, update the visible duration at minute boundaries. Provider
 * keepalives arrive every five seconds, but repainting an identical warning at
 * that cadence creates terminal noise without adding useful information.
 */
export const TUI_STALL_DISPLAY_STEP_MS = 60_000;

export function longWaitDisplayMs(elapsedMs: number, escalationMs: number): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(escalationMs)) return 0;
  const elapsed = Math.max(0, elapsedMs);
  const threshold = Math.max(0, escalationMs);
  if (elapsed < threshold) return 0;

  const minuteBucket = Math.floor(elapsed / TUI_STALL_DISPLAY_STEP_MS)
    * TUI_STALL_DISPLAY_STEP_MS;
  return Math.max(threshold, minuteBucket);
}
