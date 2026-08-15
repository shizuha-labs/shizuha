import { describe, expect, it } from 'vitest';
import type { HeartbeatQueueDrainRecord } from '../../src/daemon/heartbeat-outcome.js';
import { legacyHeartbeatRollRecoveryAllowed } from '../../src/daemon/legacy-heartbeat-roll-recovery.js';

const now = Date.parse('2026-08-01T15:30:00.000Z');
const outcome: HeartbeatQueueDrainRecord = {
  agentId: 'agent-1',
  outcome: 'needs_help',
  reason: '16 ready task(s) with no progress for 31 heartbeat(s)',
  observedAt: '2026-08-01T15:26:00.000Z',
  readyTaskCount: 16,
  blockedTaskCount: 0,
  futureDueCount: 0,
  progressEventCount: 0,
  forwardedEventCount: 0,
  pulseGetMyTasksOnly: false,
  pulseGetMyAlertsObserved: true,
  pulseAlertTaskOrderValid: true,
  consecutiveReadyNoProgressHeartbeats: 31,
  needsHelpAfter: 2,
};

function allowed(overrides: Record<string, unknown> = {}) {
  return legacyHeartbeatRollRecoveryAllowed({
    stale: true,
    protocol: 'legacy-health',
    reason: 'bridge-busy',
    deferralElapsedMs: 2 * 60 * 60_000,
    outcome,
    now,
    ...overrides,
  });
}

describe('legacy heartbeat rollout recovery', () => {
  it('admits only a recent, long-deferred legacy no-progress heartbeat deadlock', () => {
    expect(allowed()).toBe(true);
  });

  it.each([
    ['new drain protocol', { protocol: 'drain-v1' }],
    ['fenced drain protocol', { protocol: 'drain-v2' }],
    ['not stale', { stale: false }],
    ['short deferral', { deferralElapsedMs: 59 * 60_000 }],
    ['probe failure', { reason: 'probe-failed' }],
    ['productive outcome', { outcome: { ...outcome, progressEventCount: 1 } }],
    ['forwarded outcome', { outcome: { ...outcome, forwardedEventCount: 1 } }],
    ['too few episodes', { outcome: { ...outcome, consecutiveReadyNoProgressHeartbeats: 5 } }],
    ['no ready work', { outcome: { ...outcome, readyTaskCount: 0 } }],
    ['stale evidence', { outcome: { ...outcome, observedAt: '2026-08-01T15:14:59.000Z' } }],
    ['missing evidence', { outcome: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(allowed(overrides)).toBe(false);
  });
});
