/**
 * HIVE-247 (ADR-0004 §5.2) — daemon-side provision admission GATE.
 *
 * Slice 1: the `POST /v1/agents/provision` op validates a child's canonical
 * Shizuha-ID BEFORE materializing it (createLocalAgentAtRuntime). On an explicit
 * identity violation it returns 403 to Hive and does NOT materialize — so a
 * rejected provision leaves NO orphaned pod (unlike the flag-mode spawn path,
 * which materializes then warns). On admit it materializes and emits an
 * `identity_event(admitted)` + `state_delta(added)` so Hive's read model stays
 * authoritative.
 *
 * This module is the pure, dependency-light decision core (gate + idempotency +
 * event builders); the route handler in dashboard.ts wires it to
 * resolveAgentIdentity / createLocalAgentAtRuntime and the event sink.
 *
 * Scope note (flagged for the PR): the reused `validateAgentIdentity` covers
 * §4.2 (a)-(d) — canonical id, active, account_type=agent, lenient-on-unknown.
 * (e) Pulse-identity-exists and (f) single-owner require live ID/registry lookups
 * with their own degraded-mode (fail-open vs fail-closed) semantics and land in
 * Slice 1b — they are intentionally NOT checked here.
 */
import { type AgentIdentity, validateAgentIdentity } from './agent-identity.js';

export interface ProvisionDecision {
  admit: boolean;
  /** 201 admit | 403 explicit-violation reject. */
  httpStatus: number;
  reasons: string[];
  /** true when this result was replayed from the idempotency store (op_id seen). */
  duplicate: boolean;
  /**
   * Materialized agent id. Set on the admit path AFTER createLocalAgentAtRuntime,
   * then stored, so an idempotent replay of the admit can return it — the exact
   * case idempotency exists for (Hive loses the 201 on a network blip and retries
   * the same op_id). Undefined for rejects and pre-materialize.
   */
  agentId?: string;
}

/**
 * §5.2 admission decision. REUSES validateAgentIdentity (the exact §4.2 a-d check
 * the spawn path uses in flag mode) — no re-implementation. Lenient-on-unknown is
 * preserved: an undefined account_type/is_active still admits; only an EXPLICIT
 * violation (no-canonical-id / inactive / account_type≠agent) is hard-rejected.
 */
export function decideProvision(
  agent: { username: string; email?: string | null },
  identity: AgentIdentity,
): ProvisionDecision {
  const { ok, reasons } = validateAgentIdentity(agent, identity);
  return ok
    ? { admit: true, httpStatus: 201, reasons: [], duplicate: false }
    : { admit: false, httpStatus: 403, reasons, duplicate: false };
}

/**
 * op_id idempotency store. A provision is at-least-once from Hive (it retries on
 * network blips), so a retried op_id must NOT double-materialize — it replays the
 * prior decision. Bounded by TTL and reaped on the daemon tick. In-memory is
 * sufficient: the daemon is the single materializer and a restart re-derives state.
 */
export class ProvisionOpStore {
  private readonly seen = new Map<string, { decision: ProvisionDecision; ts: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 60 * 60 * 1000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Prior decision for this op_id (marked duplicate), or undefined if new/expired. */
  get(opId: string): ProvisionDecision | undefined {
    const e = this.seen.get(opId);
    if (!e) return undefined;
    if (this.now() - e.ts > this.ttlMs) {
      this.seen.delete(opId);
      return undefined;
    }
    return { ...e.decision, duplicate: true };
  }

  record(opId: string, decision: ProvisionDecision): void {
    this.seen.set(opId, { decision: { ...decision, duplicate: false }, ts: this.now() });
  }

  /** Drop expired entries (call from the daemon retention tick). */
  reap(): number {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const [k, v] of this.seen) {
      if (v.ts <= cutoff) { this.seen.delete(k); removed++; }
    }
    return removed;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface IdentityEvent {
  type: 'identity_event';
  outcome: 'admitted' | 'rejected';
  username: string;
  reasons: string[];
  opId: string;
  ts: number;
}

export interface StateDelta {
  type: 'state_delta';
  op: 'added';
  agentId: string;
  username: string;
  opId: string;
  ts: number;
}

export function buildIdentityEvent(
  username: string,
  decision: ProvisionDecision,
  opId: string,
  ts: number,
): IdentityEvent {
  return {
    type: 'identity_event',
    outcome: decision.admit ? 'admitted' : 'rejected',
    username,
    reasons: decision.reasons,
    opId,
    ts,
  };
}

export function buildStateDelta(agentId: string, username: string, opId: string, ts: number): StateDelta {
  return { type: 'state_delta', op: 'added', agentId, username, opId, ts };
}
