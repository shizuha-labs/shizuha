export type RuntimeRepairAction = 'start' | 'refresh';

export interface RuntimeRepairAdmission {
  allowed: boolean;
  reason?: 'in_flight' | 'backoff' | 'settling';
  retryAfterMs: number;
  failureCount: number;
  shouldLog: boolean;
  replacedAction?: RuntimeRepairAction;
}

export interface RuntimeRepairFailure {
  action: RuntimeRepairAction;
  failureCount: number;
  nextRetryAt: number;
  delayMs: number;
}

interface RuntimeRepairState {
  action: RuntimeRepairAction;
  desiredRevision: string;
  inFlightAction: RuntimeRepairAction | null;
  inFlightRevision: string | null;
  failureCount: number;
  nextRetryAt: number;
  settlingUntil: number;
  inFlightDeferralLogged: boolean;
  backoffDeferralLogged: boolean;
  settlingDeferralLogged: boolean;
}

/**
 * Per-agent controller workqueue semantics for runtime repair.
 *
 * Reconcile can be woken by both the ordinary lifecycle timer and the faster
 * harness-roll continuation timer. A failed repair must therefore be deduped
 * while in flight and rate-limited after failure. Desired-state changes create
 * a new key and are admitted immediately, matching Kubernetes controller
 * workqueue behavior instead of making fresh config wait behind a stale error.
 */
export class RuntimeReconcileRepairBackoff {
  private readonly stateByAgent = new Map<string, RuntimeRepairState>();

  constructor(
    private readonly baseDelayMs = 60_000,
    private readonly maxDelayMs = 5 * 60_000,
    private readonly settleDelayMs = 2 * 60_000,
  ) {
    if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
      throw new Error('baseDelayMs must be a positive finite number');
    }
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
      throw new Error('maxDelayMs must be finite and at least baseDelayMs');
    }
    if (!Number.isFinite(settleDelayMs) || settleDelayMs < 0) {
      throw new Error('settleDelayMs must be a non-negative finite number');
    }
  }

  tryBegin(
    agentId: string,
    action: RuntimeRepairAction,
    desiredRevision: string,
    now = Date.now(),
  ): RuntimeRepairAdmission {
    let state = this.stateByAgent.get(agentId);
    let replacedAction: RuntimeRepairAction | undefined;
    if (!state || state.action !== action || state.desiredRevision !== desiredRevision) {
      replacedAction = state?.action;
      const inFlightAction = state?.inFlightAction ?? null;
      const inFlightRevision = state?.inFlightRevision ?? null;
      state = {
        action,
        desiredRevision,
        // A new desired key bypasses failure backoff immediately, but it must
        // still serialize behind an already-running apply for this agent.
        inFlightAction,
        inFlightRevision,
        failureCount: 0,
        nextRetryAt: 0,
        settlingUntil: 0,
        inFlightDeferralLogged: false,
        backoffDeferralLogged: false,
        settlingDeferralLogged: false,
      };
      this.stateByAgent.set(agentId, state);
    }

    if (state.inFlightRevision !== null) {
      const shouldLog = !state.inFlightDeferralLogged;
      state.inFlightDeferralLogged = true;
      return {
        allowed: false,
        reason: 'in_flight',
        retryAfterMs: 0,
        failureCount: state.failureCount,
        shouldLog,
        replacedAction,
      };
    }

    // kubectl apply returning successfully means the desired objects were
    // accepted, not that the Deployment controller has observed the new
    // generation or replaced the old Ready pod. A fast reconcile wake can
    // therefore re-read the old healthy hash and apply again. Re-rendering
    // carries observability-only timestamps, so that duplicate apply creates a
    // fresh ReplicaSet and can keep a Recreate Deployment in permanent churn.
    // Hold the exact successful revision until a later observation clears the
    // gate on convergence (or this bounded settle window expires).
    if (now < state.settlingUntil) {
      const shouldLog = !state.settlingDeferralLogged;
      state.settlingDeferralLogged = true;
      return {
        allowed: false,
        reason: 'settling',
        retryAfterMs: state.settlingUntil - now,
        failureCount: state.failureCount,
        shouldLog,
        replacedAction,
      };
    }

    if (now < state.nextRetryAt) {
      const shouldLog = !state.backoffDeferralLogged;
      state.backoffDeferralLogged = true;
      return {
        allowed: false,
        reason: 'backoff',
        retryAfterMs: state.nextRetryAt - now,
        failureCount: state.failureCount,
        shouldLog,
        replacedAction,
      };
    }

    state.inFlightAction = action;
    state.inFlightRevision = desiredRevision;
    state.inFlightDeferralLogged = false;
    state.settlingDeferralLogged = false;
    return {
      allowed: true,
      retryAfterMs: 0,
      failureCount: state.failureCount,
      shouldLog: false,
      replacedAction,
    };
  }

  markFailed(
    agentId: string,
    action: RuntimeRepairAction,
    desiredRevision: string,
    now = Date.now(),
  ): RuntimeRepairFailure | null {
    const state = this.stateByAgent.get(agentId);
    if (!state) return null;
    // Ignore duplicate/out-of-order completion without releasing a newer
    // attempt. Only the exact admitted action/revision owns the latch.
    if (state.inFlightAction !== action || state.inFlightRevision !== desiredRevision) return null;
    state.inFlightAction = null;
    state.inFlightRevision = null;
    state.settlingUntil = 0;
    // An old async repair must never poison a newer desired-state key. Its own
    // latch is now released, so the next tick may apply the new revision.
    if (state.action !== action || state.desiredRevision !== desiredRevision) {
      state.inFlightDeferralLogged = false;
      return null;
    }

    state.failureCount += 1;
    const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** (state.failureCount - 1)));
    state.nextRetryAt = now + delayMs;
    state.backoffDeferralLogged = false;
    return { action, failureCount: state.failureCount, nextRetryAt: state.nextRetryAt, delayMs };
  }

  markSucceeded(
    agentId: string,
    action: RuntimeRepairAction,
    desiredRevision: string,
    now = Date.now(),
  ): boolean {
    const state = this.stateByAgent.get(agentId);
    if (!state) return false;
    if (state.inFlightAction !== action || state.inFlightRevision !== desiredRevision) return false;
    state.inFlightAction = null;
    state.inFlightRevision = null;
    if (state.action !== action || state.desiredRevision !== desiredRevision) {
      state.inFlightDeferralLogged = false;
      return false;
    }
    state.failureCount = 0;
    state.nextRetryAt = 0;
    state.settlingUntil = now + this.settleDelayMs;
    state.backoffDeferralLogged = false;
    state.settlingDeferralLogged = false;
    return true;
  }

  clear(agentId: string): RuntimeRepairAction | null {
    const state = this.stateByAgent.get(agentId);
    if (!state) return null;
    this.stateByAgent.delete(agentId);
    return state.action;
  }
}
