export interface LegacyGatewayCheckpoint {
  sessionId: string;
  toolResultAt: number;
}

export interface LegacyGatewayCheckpointRecoveryInput {
  desiredImage: string;
  deferralElapsedMs: number;
  checkpoint?: LegacyGatewayCheckpoint;
  now: number;
}

const MIN_DEFERRAL_MS = 30 * 60_000;
const MAX_CHECKPOINT_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;
const CHECKPOINT_RESUME_MIN_BUILD = '202608020733';

/**
 * Whether a runtime image contains gateway checkpoint replay support.
 *
 * Harness tags are monotonic source builds (harness-YYYYMMDDhhmm-<sha>) and
 * Hive rejects regressive promotions.  202608020733 is the first published
 * build containing exact-message replay plus the bridge-local drain contract.
 */
export function runtimeImageSupportsLegacyCheckpointReplay(image: string): boolean {
  const match = /(?:^|:)harness-(\d{12})-[0-9a-f]+$/i.exec(image.trim());
  return Boolean(match && match[1]! >= CHECKPOINT_RESUME_MIN_BUILD);
}

/**
 * Compatibility fence for gateways which predate drain-v1.
 *
 * A fresh persisted tool_result is an at-least-once replay checkpoint: tool
 * side effects and their results are already durable, while the upstream
 * execution remains unacknowledged until the whole inbox row completes.  A
 * drain-capable successor can therefore resume the exact row without repeating
 * completed tools.  Missing, stale, future-dated, or unsupported-target proof
 * always fails closed.
 */
export function legacyGatewayCheckpointRecoveryAllowed(
  input: LegacyGatewayCheckpointRecoveryInput,
): boolean {
  if (input.deferralElapsedMs < MIN_DEFERRAL_MS
    || !runtimeImageSupportsLegacyCheckpointReplay(input.desiredImage)) return false;
  const checkpoint = input.checkpoint;
  if (!checkpoint || !checkpoint.sessionId || !Number.isFinite(checkpoint.toolResultAt)) return false;
  const ageMs = input.now - checkpoint.toolResultAt;
  return ageMs >= -MAX_FUTURE_SKEW_MS && ageMs <= MAX_CHECKPOINT_AGE_MS;
}
