import type { HeartbeatQueueDrainRecord } from './heartbeat-outcome.js';

export interface LegacyHeartbeatRollRecoveryInput {
  stale: boolean;
  protocol?: 'drain-v1' | 'drain-v2' | 'legacy-health';
  reason: 'bridge-busy' | 'probe-failed';
  deferralElapsedMs: number;
  outcome?: HeartbeatQueueDrainRecord;
  now: number;
}

const MIN_DEFERRAL_MS = 60 * 60_000;
const MIN_NO_PROGRESS_HEARTBEATS = 6;
const MAX_OUTCOME_AGE_MS = 15 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;

/**
 * Escape hatch for the pre-drain-v1 gateway heartbeat deadlock.
 *
 * Old gateways could enqueue a new autonomous heartbeat while one was active.
 * That keeps the legacy `busy` latch true forever, so the fixed successor can
 * never be installed. Only telemetry that proves a long-running, recent,
 * repeated no-progress heartbeat episode may authorize this transition. A
 * productive, user-driven, stale, missing, or probe-failed turn remains fenced.
 */
export function legacyHeartbeatRollRecoveryAllowed(
  input: LegacyHeartbeatRollRecoveryInput,
): boolean {
  if (!input.stale
    || input.protocol !== 'legacy-health'
    || input.reason !== 'bridge-busy'
    || input.deferralElapsedMs < MIN_DEFERRAL_MS) return false;
  const outcome = input.outcome;
  if (!outcome
    || outcome.outcome !== 'needs_help'
    || outcome.readyTaskCount <= 0
    || outcome.progressEventCount !== 0
    || outcome.forwardedEventCount !== 0
    || outcome.consecutiveReadyNoProgressHeartbeats < MIN_NO_PROGRESS_HEARTBEATS) return false;
  const observedAt = Date.parse(outcome.observedAt);
  if (!Number.isFinite(observedAt)) return false;
  const ageMs = input.now - observedAt;
  return ageMs >= -MAX_FUTURE_SKEW_MS && ageMs <= MAX_OUTCOME_AGE_MS;
}
