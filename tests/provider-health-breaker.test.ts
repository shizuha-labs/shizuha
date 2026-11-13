import { afterEach, describe, expect, it } from 'vitest';
import {
  getProviderHealthState,
  isProviderDegraded,
  providerDegradedTtlMs,
  providerFailureThreshold,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderHealth,
} from '../src/shared/provider-health-breaker.js';

describe('provider-health circuit breaker (PLAT-11317)', () => {
  afterEach(() => resetProviderHealth());

  it('threshold defaults to 3 and is env-overridable', () => {
    expect(providerFailureThreshold({} as NodeJS.ProcessEnv)).toBe(3);
    expect(providerFailureThreshold({ PLAT11317_PROVIDER_FAILURE_THRESHOLD: '5' } as NodeJS.ProcessEnv)).toBe(5);
    expect(providerDegradedTtlMs({} as NodeJS.ProcessEnv)).toBe(15 * 60 * 1000);
  });

  it('stays closed below the consecutive-failure threshold', () => {
    const r1 = recordProviderFailure('a', 'http_5xx');
    const r2 = recordProviderFailure('a', 'timeout');
    expect(r1.degraded).toBe(false);
    expect(r2.degraded).toBe(false);
    expect(r2.consecutiveFailures).toBe(2);
    expect(isProviderDegraded('a')).toBe(false);
  });

  it('opens exactly at the threshold and reports the transition once', () => {
    recordProviderFailure('a', 'http_5xx');
    recordProviderFailure('a', 'http_5xx');
    const r3 = recordProviderFailure('a', 'stream_drop');
    expect(r3.becameDegraded).toBe(true);
    expect(r3.degraded).toBe(true);
    expect(isProviderDegraded('a')).toBe(true);
    const r4 = recordProviderFailure('a', 'http_5xx');
    expect(r4.becameDegraded).toBe(false);
    expect(r4.degraded).toBe(true);
  });

  it('keys are independent', () => {
    recordProviderFailure('a', 'http_5xx');
    recordProviderFailure('a', 'http_5xx');
    recordProviderFailure('a', 'http_5xx');
    expect(isProviderDegraded('a')).toBe(true);
    expect(isProviderDegraded('b')).toBe(false);
  });

  it('one success resets the streak; recovery transition reported once', () => {
    recordProviderFailure('a', 'http_5xx');
    recordProviderFailure('a', 'http_5xx');
    recordProviderFailure('a', 'http_5xx');
    expect(isProviderDegraded('a')).toBe(true);
    const rec = recordProviderSuccess('a');
    expect(rec.recovered).toBe(true);
    expect(rec.degradedMs).toBeGreaterThanOrEqual(0);
    expect(isProviderDegraded('a')).toBe(false);
    const rec2 = recordProviderSuccess('a');
    expect(rec2.recovered).toBe(false);
  });

  it('degraded state expires after the TTL (half-open re-probe) and re-degrades fast', () => {
    const t0 = 1_000_000;
    recordProviderFailure('a', 'http_5xx', t0);
    recordProviderFailure('a', 'http_5xx', t0);
    recordProviderFailure('a', 'http_5xx', t0);
    expect(isProviderDegraded('a', t0 + 60_000)).toBe(true);
    // past the 15m TTL: half-open, beat re-probes
    expect(isProviderDegraded('a', t0 + 16 * 60_000)).toBe(false);
    // still-dead provider re-degrades after ONE further failure (streak kept)
    const r = recordProviderFailure('a', 'http_5xx', t0 + 16 * 60_000 + 1);
    expect(r.becameDegraded).toBe(true);
    expect(isProviderDegraded('a', t0 + 16 * 60_000 + 2)).toBe(true);
  });

  it('state snapshot is read-only shaped', () => {
    recordProviderFailure('a', 'timeout');
    const s = getProviderHealthState('a');
    expect(s.consecutiveFailures).toBe(1);
    expect(s.degraded).toBe(false);
    expect(s.lastFailureKind).toBe('timeout');
    expect(s.lastFailureAt).toBeTruthy();
  });
});
