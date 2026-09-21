/**
 * PLAT-5467 / HIVE-332: daemon-side recovery_action evaluator.
 *
 * The authenticated DaemonLinkClient owns transport. This module owns the
 * observe-only v1 policy: every action is evaluated without mutation and
 * returns a correlated recovery_result. Apply, unsafe/high-impact actions,
 * privilege expansion, and broad restarts remain default-denied.
 */
import type { AgentInfo } from './types.js';

export type RecoveryResultState = 'would_apply' | 'applied' | 'skipped' | 'denied' | 'failed';

export interface RecoveryActionFrame {
  type?: string;
  seq?: number;
  action_id?: string;
  correlation_id?: string;
  action_type?: string;
  mode?: string;
  target_runtime_id?: string;
  agent_username?: string;
  params?: unknown;
  expires_at?: string | null;
  issue_ids?: string[];
}

export type RecoveryResultFrame = {
  type: 'recovery_result';
  action_id: string;
  correlation_id: string;
  action_type: string;
  mode: string;
  result: RecoveryResultState;
  reason: string;
  before_summary: Record<string, unknown>;
  after_summary: Record<string, unknown>;
};

export interface RecoveryDeps {
  /** Resolve a manager-owned AgentInfo by id, username, or runtime id. */
  findAgent(key: string): AgentInfo | null;
}

export const SAFE_RECOVERY_ACTIONS = new Set([
  'pull_desired_state_now',
  'reconcile_identity_alias',
  'refresh_credential_grants',
  'refresh_team_roster_cache',
  'apply_effective_runtime_config',
  'restart_agent',
]);

export const GATED_RECOVERY_ACTIONS = new Set([
  'cross_org_identity_change',
  'create_user',
  'delete_user',
  'grant_external_credential',
  'grant_billing_credential',
  'mutate_team_roster',
  'disable_agent',
  'delete_agent',
  'restart_fleet',
  'restart_daemon',
  'expand_privileges',
]);

const EXTERNAL_SCOPE_RE = /external|billing|payment|stripe|razorpay|paypal|aws|gcp|azure/i;
const PRIVILEGE_FIELD_RE = /(?:^|_)(?:credential|privilege|sensitive|ssh|host_access|capabilit)/i;
const BROAD_TARGETS = new Set(['', '*', 'all', 'fleet', 'daemon']);
const SECRET_PREFIX_RE = /^(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|xoxb-|xoxp-|glpat-|pat_|eyJ)/;
const EMBEDDED_SECRET_RE = /(?:gh[pousr]_|github_pat_|sk-|xox[aboprs]-|glpat-|pat_)[A-Za-z0-9_+/=.-]{12,}/g;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const EMBEDDED_JWT_RE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const HEX_DIGEST_RE = /^[0-9a-f]{32,64}$/;
const HIGH_ENTROPY_RE = /^[A-Za-z0-9_+/=-]{32,}$/;
const REDACTED = '[redacted-secret]';

export function looksLikeSecret(value: string): boolean {
  const candidate = (value ?? '').trim();
  if (!candidate) return false;
  const lowered = candidate.toLowerCase();
  if (lowered.includes('-----begin ') || lowered.includes('-----end ')) return true;
  if (SECRET_PREFIX_RE.test(candidate)) return true;
  if (JWT_RE.test(candidate)) return true;
  if (HEX_DIGEST_RE.test(lowered)) return false;
  return HIGH_ENTROPY_RE.test(candidate) && !candidate.includes('://');
}

function sanitizeString(value: string): string {
  if (looksLikeSecret(value)) return REDACTED;
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, REDACTED)
    .replace(EMBEDDED_SECRET_RE, REDACTED)
    .replace(EMBEDDED_JWT_RE, REDACTED);
}

/** Deep-copy a result payload while removing secret-looking string material. */
export function sanitizeSummary(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeSummary);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeSummary(item);
    }
    return out;
  }
  return value;
}

function safeEcho(value: unknown): string {
  return sanitizeString(String(value ?? '').trim());
}

function baseResult(frame: RecoveryActionFrame): RecoveryResultFrame {
  return {
    type: 'recovery_result',
    action_id: safeEcho(frame.action_id),
    correlation_id: safeEcho(frame.correlation_id),
    action_type: safeEcho(frame.action_type),
    mode: safeEcho(frame.mode || 'dry_run'),
    result: 'failed',
    reason: '',
    before_summary: {},
    after_summary: {},
  };
}

function finish(
  result: RecoveryResultFrame,
  state: RecoveryResultState,
  reason: string,
  before: Record<string, unknown> = {},
  after: Record<string, unknown> = {},
): RecoveryResultFrame {
  result.result = state;
  result.reason = sanitizeString(reason);
  result.before_summary = sanitizeSummary(before) as Record<string, unknown>;
  result.after_summary = sanitizeSummary(after) as Record<string, unknown>;
  return result;
}

function resolveTargetAgent(frame: RecoveryActionFrame, deps: RecoveryDeps): AgentInfo | null {
  for (const key of [frame.target_runtime_id, frame.agent_username]) {
    const trimmed = String(key ?? '').trim();
    if (!trimmed) continue;
    const agent = deps.findAgent(trimmed);
    if (agent) return agent;
  }
  return null;
}

function stringSet(values: unknown): Set<string> {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map((value) => String(value).trim()).filter(Boolean));
}

function agentGrantScopes(agent: AgentInfo): Set<string> {
  return new Set([
    ...(agent.credentialGrantScopes ?? []),
    ...(agent.effectiveCapabilities?.credentialGrantScopes ?? []),
  ].map((scope) => String(scope)));
}

function privilegeExpandingPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => privilegeExpandingPaths(item, `${prefix}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  const paths: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (PRIVILEGE_FIELD_RE.test(key)) paths.push(path);
    paths.push(...privilegeExpandingPaths(item, path));
  }
  return paths;
}

function targetLabel(frame: RecoveryActionFrame): string {
  return safeEcho(frame.target_runtime_id || frame.agent_username || '');
}

/**
 * Evaluate one authenticated recovery_action frame. This function never
 * throws: malformed input and dependency failures become explicit terminal
 * recovery_result states so Hive's audit row cannot be stranded silently.
 */
export async function executeRecoveryAction(
  frame: RecoveryActionFrame,
  deps: RecoveryDeps,
): Promise<RecoveryResultFrame> {
  const result = baseResult(frame);
  try {
    if (!String(frame.action_id ?? '').trim() || !String(frame.correlation_id ?? '').trim()) {
      return finish(result, 'failed', 'action_id and correlation_id are required');
    }

    const actionType = String(frame.action_type ?? '').trim();
    const mode = String(frame.mode ?? 'dry_run').trim() || 'dry_run';
    result.mode = safeEcho(mode);

    if (GATED_RECOVERY_ACTIONS.has(actionType)) {
      return finish(result, 'denied',
        `action '${actionType}' is unsafe/privilege-expanding and gated in v1`);
    }
    if (!SAFE_RECOVERY_ACTIONS.has(actionType)) {
      return finish(result, 'denied', `unknown action type '${safeEcho(actionType)}' - default-deny`);
    }
    if (mode !== 'dry_run') {
      return finish(result, 'denied',
        'apply mode is separately approval-gated; daemon recovery v1 is dry-run only');
    }
    if (frame.expires_at) {
      const expiry = Date.parse(frame.expires_at);
      if (Number.isNaN(expiry)) {
        return finish(result, 'failed', 'expires_at must be a valid ISO timestamp');
      }
      if (expiry <= Date.now()) {
        return finish(result, 'skipped', `action expired at ${safeEcho(frame.expires_at)} before execution`);
      }
    }
    if (frame.params !== undefined
      && (!frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params))) {
      return finish(result, 'failed', 'params must be an object');
    }
    const params = (frame.params ?? {}) as Record<string, unknown>;

    switch (actionType) {
      case 'refresh_team_roster_cache':
        return finish(result, 'would_apply',
          'dry-run: would re-pull the daemon team-roster cache; no roster mutation path is exposed');

      case 'pull_desired_state_now': {
        const agent = resolveTargetAgent(frame, deps);
        if (!agent) {
          return finish(result, 'skipped', `target '${targetLabel(frame)}' is not managed by this daemon`);
        }
        return finish(result, 'would_apply',
          'dry-run: would pull current Hive desired state and report the observed generation',
          { agent: agent.username });
      }

      case 'reconcile_identity_alias': {
        const agent = resolveTargetAgent(frame, deps);
        if (!agent) {
          return finish(result, 'skipped', `target '${targetLabel(frame)}' is not managed by this daemon`);
        }
        const canonicalEmail = String(params.canonical_email ?? '').trim().toLowerCase();
        const platformUserId = String(params.canonical_platform_user_id ?? '').trim();
        if (!canonicalEmail || !platformUserId || params.same_platform_user !== true) {
          return finish(result, 'denied',
            'alias is not proven to resolve to the same platform user');
        }
        return finish(result, 'would_apply',
          'dry-run: alias is proven to be the same platform user; would update runtime identity metadata',
          { agent: agent.username, runtime_email: agent.email },
          { canonical_email: canonicalEmail, platform_user_id: platformUserId });
      }

      case 'refresh_credential_grants': {
        const agent = resolveTargetAgent(frame, deps);
        if (!agent) {
          return finish(result, 'skipped', `target '${targetLabel(frame)}' is not managed by this daemon`);
        }
        if (params.grant_scopes !== undefined && !Array.isArray(params.grant_scopes)) {
          return finish(result, 'failed', 'params.grant_scopes must be an array when provided');
        }
        const current = agentGrantScopes(agent);
        const requested = params.grant_scopes === undefined ? current : stringSet(params.grant_scopes);
        const external = [...requested].filter((scope) => EXTERNAL_SCOPE_RE.test(scope));
        if (external.length > 0) {
          return finish(result, 'denied',
            `external/billing credential scopes are gated in v1: ${external.sort().join(', ')}`);
        }
        const expansion = [...requested].filter((scope) => !current.has(scope));
        if (expansion.length > 0) {
          return finish(result, 'denied',
            `credential refresh cannot expand grant scope: ${expansion.sort().join(', ')}`);
        }
        if (requested.size === 0) {
          return finish(result, 'skipped', 'no existing internal credential grant scopes to refresh');
        }
        return finish(result, 'would_apply',
          'dry-run: would refresh existing internal credential grants through the scoped broker',
          { agent: agent.username, grant_scopes: [...requested].sort() });
      }

      case 'apply_effective_runtime_config': {
        const agent = resolveTargetAgent(frame, deps);
        if (!agent) {
          return finish(result, 'skipped', `target '${targetLabel(frame)}' is not managed by this daemon`);
        }
        const desired = params.desired;
        if (!desired || typeof desired !== 'object' || Array.isArray(desired)) {
          return finish(result, 'failed', 'params.desired must be the desired runtime-config object');
        }
        const privilegePaths = privilegeExpandingPaths(desired);
        if (privilegePaths.length > 0) {
          return finish(result, 'denied',
            `desired config contains privilege-expanding fields: ${privilegePaths.sort().join(', ')}`);
        }
        const desiredObject = desired as Record<string, unknown>;
        return finish(result, 'would_apply',
          'dry-run: would apply the Hive desired generation through the daemon-owned config gate',
          { agent: agent.username, config_fields: Object.keys(desiredObject).sort() },
          { desired_generation: params.desired_generation ?? null });
      }

      case 'restart_agent': {
        const rawTarget = String(frame.target_runtime_id ?? frame.agent_username ?? '').trim();
        if (BROAD_TARGETS.has(rawTarget.toLowerCase())) {
          return finish(result, 'denied',
            'broad daemon/fleet restart is gated; restart_agent requires one concrete runtime id');
        }
        const agent = resolveTargetAgent(frame, deps);
        if (!agent) {
          return finish(result, 'skipped', `target '${targetLabel(frame)}' is not managed by this daemon`);
        }
        return finish(result, 'would_apply',
          'dry-run: would restart this single named agent runtime',
          { agent: agent.username, runtime_id: agent.id });
      }
    }
    return finish(result, 'denied', `unhandled action type '${safeEcho(actionType)}' - default-deny`);
  } catch (error) {
    return finish(result, 'failed',
      `recovery handler error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
