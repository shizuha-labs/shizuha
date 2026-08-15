export interface StuckLatchRecoveryHooks {
  isStuck: () => boolean;
  fenceAndRestart: () => Promise<void>;
  releaseLatch: () => void;
  drainQueue: () => void | Promise<void>;
}

export type TurnStallReason =
  | 'first_model_event_timeout'
  | 'progress_timeout'
  | 'hard_age_timeout';

/** One stall classifier drives both operator telemetry and recovery.
 *
 * A first-event timeout catches a child that accepted a turn but never began
 * model work. A progress timeout catches a turn that started and then wedged.
 * The historical hard-age threshold is only a fail-safe for malformed progress
 * timestamps: wall-clock age alone must never abort a long turn that is still
 * producing model/tool/command events.
 */
export function getTurnStallReason(params: {
  activeThreadId: string | null;
  activeThreadStartedAt: number | null;
  firstModelEventAt: number | null;
  lastProgressAt: number | null;
  firstEventTimeoutMs: number;
  progressTimeoutMs: number;
  hardAgeTimeoutMs: number;
  now: number;
}): TurnStallReason | null {
  if (!params.activeThreadId || params.activeThreadStartedAt === null) return null;
  const activeForMs = Math.max(0, params.now - params.activeThreadStartedAt);
  if (
    params.firstModelEventAt === null
    && activeForMs >= params.firstEventTimeoutMs
  ) {
    return 'first_model_event_timeout';
  }
  if (
    params.firstModelEventAt === null
    && activeForMs >= params.hardAgeTimeoutMs
  ) {
    return 'hard_age_timeout';
  }
  if (params.firstModelEventAt !== null) {
    const lastProgressAt = params.lastProgressAt ?? params.firstModelEventAt;
    const timestampsAreCoherent =
      Number.isFinite(params.firstModelEventAt)
      && params.firstModelEventAt >= params.activeThreadStartedAt
      && params.firstModelEventAt <= params.now
      && Number.isFinite(lastProgressAt)
      && lastProgressAt >= params.firstModelEventAt
      && lastProgressAt <= params.now;
    if (!timestampsAreCoherent) {
      return activeForMs >= params.hardAgeTimeoutMs ? 'hard_age_timeout' : null;
    }
    if (Math.max(0, params.now - lastProgressAt) >= params.progressTimeoutMs) {
      return 'progress_timeout';
    }
  }
  return null;
}

/** No-progress predicate used by the Claude watchdog.
 *
 * `lastProgressAt` is optional for backwards compatibility and startup paths.
 * A coherent recent child event extends the lease; a stale/malformed timestamp
 * safely falls back to the latch acquisition time.
 */
export function isLatchStuck(
  activeThreadId: string | null,
  activeThreadStartedAt: number | null,
  heartbeatStuckMs: number,
  now: number,
  lastProgressAt: number | null = null,
): boolean {
  if (!activeThreadId || activeThreadStartedAt === null) return false;
  const progressAnchor =
    lastProgressAt !== null
    && Number.isFinite(lastProgressAt)
    && lastProgressAt >= activeThreadStartedAt
    && lastProgressAt <= now
      ? lastProgressAt
      : activeThreadStartedAt;
  return (now - progressAnchor) >= heartbeatStuckMs;
}

/**
 * Serialize the safety-critical recovery order shared by both bridges.
 * The dead execution is fenced and its child is replaced before ownership of
 * the busy latch is released; queue draining is always last.
 */
export async function runSerializedStuckRecovery(hooks: StuckLatchRecoveryHooks): Promise<boolean> {
  if (!hooks.isStuck()) return false;
  await hooks.fenceAndRestart();
  hooks.releaseLatch();
  await hooks.drainQueue();
  return true;
}

/** Process identity is the generation fence for child stdout/exit events. */
export function isCurrentBridgeChild<T>(source: T, current: T | null): boolean {
  return source === current;
}
