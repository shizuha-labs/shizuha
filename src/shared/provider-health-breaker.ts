/**
 * PLAT-11317 (PLAT-10352 part b): provider-health circuit breaker.
 *
 * When a seat's LLM provider (cortex/vLLM) is in a degraded/outage window
 * (elevated TTFT, dropped streamed tool turns, 5xx rate), the harness must
 * SKIP non-essential heartbeat ticks instead of burning turns — and ANDON
 * emissions — against a dead provider (evidence class: GLM degradation
 * 09-12, TTFT 43.4s, eaten tool turns; multiple outage windows each
 * consumed ANDON turns with no actionable lane while heartbeats fired into
 * the void).
 *
 * Design: consecutive-failure circuit breaker, in-process (one harness
 * process serves one seat). Failure feeds come from the agent turn loop
 * (hard provider errors: 5xx / timeout / connection / stream-drop) and the
 * existing SCLI-22 sustained-TTFT-degradation detector. Success feeds: any
 * completed turn and TTFT-window recovery. The idle-heartbeat scheduler
 * consults `isProviderDegraded()` before its Pulse preflight and skips the
 * tick entirely (accounted as a `[heartbeat-budget-skip] provider_degraded`
 * record) while degraded.
 *
 * Deliberate offline states are NOT degradation: 429 (provider-handled
 * rotation), cortex maintenance 503, model_leased, residency_full — those
 * have their own graceful-pause behavior and must not trip the breaker.
 *
 * Auto-recovery: the degraded state expires after
 * PLAT11317_PROVIDER_DEGRADED_TTL_MS (default 15m) — a recovered provider is
 * not skipped forever if no turn runs to flip the state; the next tick
 * re-probes by letting the beat through.
 *
 * This module is intentionally independent from manager.ts/gateway internals
 * (same import-cycle discipline as heartbeat-budget-skip.ts).
 */

export type ProviderFailureKind =
  | 'http_5xx'          // provider answered 5xx
  | 'timeout'           // request/read timeout (incl. sustained-TTFT window)
  | 'connection_error'  // connect/socket failure
  | 'stream_drop';      // streamed response dropped mid-turn

export interface ProviderHealthState {
  consecutiveFailures: number;
  degraded: boolean;
  degradedSince: string | null;
  lastFailureAt: string | null;
  lastFailureKind: ProviderFailureKind | null;
}

export interface ProviderFailureRecord {
  key: string;
  consecutiveFailures: number;
  degraded: boolean;
  /** true exactly on the transition into the degraded state */
  becameDegraded: boolean;
  kind: ProviderFailureKind;
  observedAt: string;
}

export interface ProviderRecoveryRecord {
  key: string;
  /** true exactly on the transition out of the degraded state */
  recovered: boolean;
  degradedMs: number | null;
  observedAt: string;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_DEGRADED_TTL_MS = 15 * 60 * 1000;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function providerFailureThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolvePositiveInt(env['PLAT11317_PROVIDER_FAILURE_THRESHOLD'], DEFAULT_FAILURE_THRESHOLD);
}

export function providerDegradedTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolvePositiveInt(env['PLAT11317_PROVIDER_DEGRADED_TTL_MS'], DEFAULT_DEGRADED_TTL_MS);
}

interface BreakerEntry {
  consecutiveFailures: number;
  degradedSince: number | null;
  lastFailureAt: number | null;
  lastFailureKind: ProviderFailureKind | null;
}

const breakers = new Map<string, BreakerEntry>();

function entryFor(key: string): BreakerEntry {
  let e = breakers.get(key);
  if (!e) {
    e = {
      consecutiveFailures: 0,
      degradedSince: null,
      lastFailureAt: null,
      lastFailureKind: null,
    };
    breakers.set(key, e);
  }
  return e;
}

/**
 * Record one provider failure. Transitions the breaker into the degraded
 * state once `providerFailureThreshold()` consecutive failures accumulate.
 * Returns the record for logging/telemetry.
 */
export function recordProviderFailure(
  key: string,
  kind: ProviderFailureKind,
  observedAt = Date.now(),
): ProviderFailureRecord {
  const e = entryFor(key);
  e.consecutiveFailures += 1;
  e.lastFailureAt = observedAt;
  e.lastFailureKind = kind;
  const threshold = providerFailureThreshold();
  let becameDegraded = false;
  if (!e.degradedSince && e.consecutiveFailures >= threshold) {
    e.degradedSince = observedAt;
    becameDegraded = true;
  }
  return {
    key,
    consecutiveFailures: e.consecutiveFailures,
    degraded: e.degradedSince !== null,
    becameDegraded,
    kind,
    observedAt: new Date(observedAt).toISOString(),
  };
}

/**
 * Record one provider success (a turn that completed, or TTFT-window
 * recovery). Resets the failure streak; if the breaker was degraded, this is
 * the recovery transition.
 */
export function recordProviderSuccess(
  key: string,
  observedAt = Date.now(),
): ProviderRecoveryRecord {
  const e = entryFor(key);
  const wasDegraded = e.degradedSince !== null;
  const degradedMs = wasDegraded ? observedAt - (e.degradedSince as number) : null;
  e.consecutiveFailures = 0;
  e.degradedSince = null;
  return {
    key,
    recovered: wasDegraded,
    degradedMs,
    observedAt: new Date(observedAt).toISOString(),
  };
}

/**
 * True while the breaker is degraded (and the TTL has not expired). The
 * idle-heartbeat scheduler must skip the tick while this answers true.
 */
export function isProviderDegraded(key: string, now = Date.now()): boolean {
  const e = breakers.get(key);
  if (!e || e.degradedSince === null) return false;
  if (now - e.degradedSince >= providerDegradedTtlMs()) {
    // Half-open: the degraded window expired. Let the next beat through to
    // re-probe; the failure streak keeps its count so a still-dead provider
    // re-degrades after a single failure from the retained streak.
    e.degradedSince = null;
    return false;
  }
  return true;
}

/** Read-only state snapshot (dashboard/telemetry). */
export function getProviderHealthState(key: string): ProviderHealthState {
  const e = entryFor(key);
  return {
    consecutiveFailures: e.consecutiveFailures,
    degraded: e.degradedSince !== null && isProviderDegraded(key),
    degradedSince: e.degradedSince !== null ? new Date(e.degradedSince).toISOString() : null,
    lastFailureAt: e.lastFailureAt !== null ? new Date(e.lastFailureAt).toISOString() : null,
    lastFailureKind: e.lastFailureKind,
  };
}

/** Test/diagnostic reset. */
export function resetProviderHealth(key?: string): void {
  if (key === undefined) breakers.clear();
  else breakers.delete(key);
}
