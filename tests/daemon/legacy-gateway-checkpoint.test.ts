import { describe, expect, it } from 'vitest';

import {
  legacyGatewayCheckpointRecoveryAllowed,
  runtimeImageSupportsLegacyCheckpointReplay,
} from '../../src/daemon/legacy-gateway-checkpoint.js';

describe('legacy gateway checkpoint rollout recovery', () => {
  const desiredImage = 'localhost:30500/shizuha-agent-runtime:harness-202608020733-64cf0df';

  it('admits a fresh persisted tool checkpoint after a long legacy deferral', () => {
    const now = Date.now();
    expect(legacyGatewayCheckpointRecoveryAllowed({
      desiredImage,
      deferralElapsedMs: 31 * 60_000,
      checkpoint: { sessionId: 'agent-session-nagi', toolResultAt: now - 15_000 },
      now,
    })).toBe(true);
  });

  it('fails closed on missing, stale, future, or too-young evidence', () => {
    const now = Date.now();
    const base = { desiredImage, deferralElapsedMs: 31 * 60_000, now };
    expect(legacyGatewayCheckpointRecoveryAllowed(base)).toBe(false);
    expect(legacyGatewayCheckpointRecoveryAllowed({
      ...base,
      checkpoint: { sessionId: 'agent-session-nagi', toolResultAt: now - 121_000 },
    })).toBe(false);
    expect(legacyGatewayCheckpointRecoveryAllowed({
      ...base,
      checkpoint: { sessionId: 'agent-session-nagi', toolResultAt: now + 31_000 },
    })).toBe(false);
    expect(legacyGatewayCheckpointRecoveryAllowed({
      ...base,
      deferralElapsedMs: 29 * 60_000,
      checkpoint: { sessionId: 'agent-session-nagi', toolResultAt: now },
    })).toBe(false);
  });

  it('only permits monotonic builds containing exact-message replay', () => {
    expect(runtimeImageSupportsLegacyCheckpointReplay(desiredImage)).toBe(true);
    expect(runtimeImageSupportsLegacyCheckpointReplay(
      'localhost:30500/shizuha-agent-runtime:harness-202608020216-b18e9c5',
    )).toBe(false);
    expect(runtimeImageSupportsLegacyCheckpointReplay('runtime:latest')).toBe(false);
  });
});
