/**
 * ADR-0004 — canonical agent-identity primitive (the identity-guarantee invariant).
 *
 * Extracted from manager.ts (HIVE-247) into a dependency-light leaf module so the
 * admission GATE (provision-gate.ts) and its tests can REUSE the exact same
 * `validateAgentIdentity` check the spawn-path flag-mode logic uses — one
 * definition, no re-implementation, no need to load the whole daemon to test it.
 */

export interface AgentIdentity {
  userId: number;
  isStaff: boolean;
  isSuperuser: boolean;
  orgRole?: string;
  // ADR-0004 phase 2 (identity-guarantee): canonical Shizuha-ID attributes the
  // daemon validates at spawn. Populated from the phase-1 ID-API fields.
  accountType?: string;        // 'human' | 'agent' (UserProfile.account_type)
  isActive?: boolean;          // User.is_active
  agentRuntimeId?: string | null; // UserProfile.agent_runtime_id (which runtime hosts it)
}

/**
 * ADR-0004 phase 2 — the identity-guarantee invariant. A spawned/provisioned child
 * must have a valid canonical Shizuha-ID: resolved (userId>0), active, and
 * account_type=agent.
 *
 * Lenient by design: `account_type`/`is_active` are only present once the phase-1
 * ID-API is deployed, so an *unknown* (undefined) value never fails — only an
 * explicit contradiction (inactive, or account_type set to a non-'agent' value)
 * does. This lets the daemon flag/repair orphan / non-agent / missing identities
 * without hard-blocking spawns during rollout. Returns reasons
 * for logging. The provision GATE (provision-gate.ts) acts on a failing result
 * (403, no materialize); the spawn path only warns+meters (flag mode).
 */
export function validateAgentIdentity(
  agent: { username: string; email?: string | null },
  identity: AgentIdentity,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!identity.userId || identity.userId <= 0) {
    reasons.push('no-canonical-shizuha-id');
  } else {
    if (identity.isActive === false) reasons.push('inactive');
    if (identity.accountType !== undefined && identity.accountType !== 'agent') {
      reasons.push(`account_type=${identity.accountType}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
