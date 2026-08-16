/**
 * Runtime-roll deferral observability state (PLAT-5335 / PLAT-5039).
 *
 * One `reconcilePass` call represents the result of one production
 * reconcileHarnessImageRoll pass for one agent/target.  Keeping the alert latch,
 * clear/re-arm boundaries, persistence snapshot and metric writes in this one
 * component prevents the caller from accidentally re-arming only part of the
 * state between consecutive passes.
 */

export type RuntimeRollDeferralReason = 'bridge-busy' | 'probe-failed';
export type RuntimeRollDeferralProtocol = 'drain-v1' | 'drain-v2' | 'legacy-health' | 'unknown';

export interface PersistedRuntimeRollDeferral {
  since: number;
  agent: string;
  reason: RuntimeRollDeferralReason;
  protocol: RuntimeRollDeferralProtocol;
  alerted: boolean;
}

export type PersistedRuntimeRollDeferrals = Record<string, PersistedRuntimeRollDeferral>;

export interface RuntimeRollDeferralMetricSink {
  set(
    agent: string,
    reason: RuntimeRollDeferralReason,
    protocol: RuntimeRollDeferralProtocol,
    sinceMs: number,
  ): void;
  clear(agent: string): void;
}

export type RuntimeRollDeferralPass =
  | {
      kind: 'deferred';
      key: string;
      agent: string;
      now: number;
      reason: RuntimeRollDeferralReason;
      protocol?: RuntimeRollDeferralProtocol;
    }
  | {
      kind: 'admitted' | 'converged' | 'stopped' | 'ineligible';
      key: string;
      agent: string;
    };

export interface RuntimeRollDeferralPassResult {
  allowRoll: boolean;
  changed: boolean;
  elapsedMs: number;
  shouldLogAlert: boolean;
}

export const DEFAULT_RUNTIME_ROLL_DEFER_ALERT_MS = 30 * 60_000;

export function resolveRuntimeRollDeferAlertMs(rawSeconds: unknown): number {
  const seconds = rawSeconds === undefined || rawSeconds === ''
    ? DEFAULT_RUNTIME_ROLL_DEFER_ALERT_MS / 1000
    : Number(rawSeconds);
  if (seconds === 0) return 0;
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RUNTIME_ROLL_DEFER_ALERT_MS;
  return seconds * 1000;
}

export class RuntimeRollDeferralTracker {
  private readonly records = new Map<string, PersistedRuntimeRollDeferral>();

  constructor(
    private readonly metrics: RuntimeRollDeferralMetricSink,
    private readonly alertAfterMs: number,
  ) {}

  /** Restore the persisted wait before the first post-restart reconcile pass. */
  restore(snapshot: PersistedRuntimeRollDeferrals): void {
    for (const record of this.records.values()) this.metrics.clear(record.agent);
    this.records.clear();
    for (const [key, record] of Object.entries(snapshot)) {
      this.records.set(key, { ...record });
      this.metrics.set(record.agent, record.reason, record.protocol, record.since);
    }
  }

  snapshot(): PersistedRuntimeRollDeferrals {
    return Object.fromEntries(
      [...this.records.entries()].map(([key, record]) => [key, { ...record }]),
    );
  }

  /**
   * Apply one production-order actuator pass. A denied live bridge gate always
   * returns allowRoll=false; observability can never authorize an interrupt.
   */
  reconcilePass(pass: RuntimeRollDeferralPass): RuntimeRollDeferralPassResult {
    if (pass.kind !== 'deferred') {
      const existing = this.records.get(pass.key);
      if (existing) {
        this.records.delete(pass.key);
        this.metrics.clear(existing.agent);
      } else {
        // Clear by the current stable label too, so a restored/legacy mismatch
        // cannot leave a stale series firing after convergence.
        this.metrics.clear(pass.agent);
      }
      return { allowRoll: true, changed: existing !== undefined, elapsedMs: 0, shouldLogAlert: false };
    }

    const protocol = pass.protocol ?? 'unknown';
    const existing = this.records.get(pass.key);
    const record: PersistedRuntimeRollDeferral = existing
      ? {
          ...existing,
          agent: pass.agent,
          reason: pass.reason,
          protocol,
        }
      : {
          since: pass.now,
          agent: pass.agent,
          reason: pass.reason,
          protocol,
          alerted: false,
        };
    const elapsedMs = Math.max(0, pass.now - record.since);
    const shouldLogAlert = this.alertAfterMs > 0
      && elapsedMs >= this.alertAfterMs
      && !record.alerted;
    if (shouldLogAlert) record.alerted = true;
    this.records.set(pass.key, record);
    this.metrics.set(record.agent, record.reason, record.protocol, record.since);

    return {
      allowRoll: false,
      changed: !existing
        || existing.agent !== record.agent
        || existing.reason !== record.reason
        || existing.protocol !== record.protocol
        || existing.alerted !== record.alerted,
      elapsedMs,
      shouldLogAlert,
    };
  }

  /** Remove deferrals that no longer appear in the authoritative drift set. */
  prune(activeKeys: ReadonlySet<string>): boolean {
    let changed = false;
    for (const [key, record] of this.records) {
      if (activeKeys.has(key)) continue;
      this.records.delete(key);
      this.metrics.clear(record.agent);
      changed = true;
    }
    return changed;
  }
}
