/**
 * Hive xAI / SuperGrok lease — Codex-shaped, access-only.
 *
 * Hive Token Coordinator is the sole refresh writer. Agent runtimes lease an
 * access token through the pod-local broker UDS (`GET /model-token?provider=xai`).
 * The rotating refresh token never enters the agent filesystem or env. Serving
 * a stale refresh copy would invalidate the current generation (RFC 9700 §4.14).
 */

import { XaiProvider, inferXaiAuthMode, type XaiAuthMode } from '../provider/xai.js';
import { sharedXaiDirectBudget } from '../provider/xai-direct-budget.js';
import type { LLMProvider } from '../provider/types.js';
import {
  brokerExpected,
  fetchBrokerModelToken,
  reportBrokerModelTokenStatus,
  type BrokerModelToken,
} from './broker-token.js';

export const HIVE_XAI_GROK_MODEL = 'xai:grok-4.7';
export const HIVE_XAI_UPSTREAM_MODEL = 'grok-4.7';
const DEPRECATED_GROK_UPSTREAMS = new Set(['grok-4.6', 'grok-4.6-latest']);

export interface BrokerXaiAuthPayload {
  accessToken: string;
  email: string;
  accountId: string;
  /** Credential class; Hive's xAI pool holds SuperGrok OAuth subscriptions. */
  authMode: XaiAuthMode;
}

export function hiveDirectXaiUpstreamModel(model: string): string {
  const lower = String(model || '').trim().toLowerCase();
  const bare = lower.startsWith('xai:') ? lower.slice(4) : lower;
  if (bare.startsWith('grok-')) {
    if (DEPRECATED_GROK_UPSTREAMS.has(bare)) return HIVE_XAI_UPSTREAM_MODEL;
    return bare;
  }
  return HIVE_XAI_UPSTREAM_MODEL;
}

export function isHiveDirectXaiGrokModel(model: string): boolean {
  const raw = String(model || '').trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith('cortex/')) return false;
  if (lower.startsWith('xai/')) return false;
  return lower.startsWith('xai:grok-');
}

export function parseBrokerXaiPayload(raw: string): BrokerXaiAuthPayload | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const firstString = (...values: unknown[]): string =>
      values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
    const accessToken = firstString(parsed.access_token, parsed.accessToken);
    if (!accessToken) return null;
    if ('refresh_token' in parsed || 'refreshToken' in parsed) {
      // Coordinator must never serve a rotating refresh grant to a runtime.
      return null;
    }
    // CTX-5382: Hive's Token Coordinator labels every TokenPool xAI lease
    // `auth_mode: xaiAccessToken` — an access token of a SuperGrok / Grok Build
    // OAuth device grant (Hive is the sole refresh writer). Those must use the
    // Grok CLI chat proxy, never the console API endpoint. An explicit
    // auth_class wins; shape inference is only for unlabeled payloads.
    const declaredClass = firstString(parsed.auth_class, parsed.authClass).toLowerCase();
    const declaredMode = firstString(parsed.auth_mode, parsed.authMode);
    const override = String(process.env['SHIZUHA_XAI_DIRECT_AUTH_MODE'] || '').trim().toLowerCase();
    const authMode: XaiAuthMode = override === 'api_key' || override === 'oauth_subscription'
      ? override
      : declaredClass === 'api_key'
        ? 'api_key'
        : declaredClass === 'oauth_subscription' || declaredMode === 'xaiAccessToken'
          ? 'oauth_subscription'
          : inferXaiAuthMode(accessToken);
    return {
      accessToken,
      email: firstString(parsed.email) || 'broker',
      accountId: firstString(parsed.account_id, parsed.accountId),
      authMode,
    };
  } catch {
    return null;
  }
}

export interface HiveXaiLease {
  token: BrokerModelToken;
  payload: BrokerXaiAuthPayload;
  provider: LLMProvider;
}

export async function leaseHiveXaiAccess(opts: {
  stickyKey?: string;
  preferredEntryId?: string;
  excludeEntryId?: string;
  forceRefresh?: boolean;
  timeoutMs?: number;
} = {}): Promise<HiveXaiLease | null> {
  if (!brokerExpected() && !process.env['MCP_AUTH_PROXY_SOCKET']) {
    return null;
  }
  const token = await fetchBrokerModelToken('xai', opts.timeoutMs ?? 8000, {
    forceRefresh: opts.forceRefresh,
    preferredEntryId: opts.preferredEntryId,
    excludeEntryId: opts.excludeEntryId,
    stickyKey: opts.stickyKey,
  });
  if (!token) return null;
  const payload = parseBrokerXaiPayload(token.token);
  if (!payload) return null;
  return {
    token,
    payload,
    // CTX-5382: OAuth subscription tokens go to the Grok CLI chat proxy with
    // Grok CLI headers (api.x.ai refuses subscription spend); console API keys
    // keep api.x.ai. The direct path bypasses Cortex's breaker, so every lease
    // shares one per-process rolling-hour budget + usage ledger.
    provider: new XaiProvider(payload.accessToken, {
      authMode: payload.authMode,
      budget: sharedXaiDirectBudget(),
      accountLabel: token.label || payload.email,
    }),
  };
}

export async function coolHiveXaiLease(lease: HiveXaiLease | null): Promise<void> {
  if (!lease) return;
  await reportBrokerModelTokenStatus(lease.token, { action: 'cool', cooldownSeconds: 60 });
}

export type HiveXaiLeaseFailure =
  | { kind: 'quota_exhausted'; cooldownSeconds: number }
  | { kind: 'rate_limited'; cooldownSeconds: number };

/** Default hold for a provider-confirmed exhausted subscription (rolling 24h window). */
export const XAI_LEASE_QUOTA_COOLDOWN_SECONDS = 6 * 3600;
export const XAI_LEASE_RATE_LIMIT_COOLDOWN_SECONDS = 60;

/**
 * CTX-5382: classify an upstream failure on a Hive-leased xAI account.
 * SuperGrok free/included-usage exhaustion arrives as 429 ("used all the
 * included free usage ... rolling 24-hour window") and an out-of-credit
 * account as 403. Both are per-account and last hours, so the lease must be
 * cooled for that long and the seat re-leased onto another account — retrying
 * the same account only burns turns. Our own per-seat breaker
 * (code xai_direct_budget_exhausted) is NOT an account failure.
 */
export function classifyHiveXaiLeaseFailure(err: unknown): HiveXaiLeaseFailure | null {
  const e = err as { status?: number; code?: string; message?: string } | null;
  if (!e) return null;
  if (e.code === 'xai_direct_budget_exhausted') return null;
  const status = Number(e.status || 0);
  const msg = String(e.message || '');
  const quotaText = /included free usage|rolling 24-hour|out of credits|credit balance|spending limit|exhausted|insufficient[_ ]quota/i;
  if ((status === 429 || status === 403 || status === 402) && quotaText.test(msg)) {
    return { kind: 'quota_exhausted', cooldownSeconds: XAI_LEASE_QUOTA_COOLDOWN_SECONDS };
  }
  if (status === 429) {
    return { kind: 'rate_limited', cooldownSeconds: XAI_LEASE_RATE_LIMIT_COOLDOWN_SECONDS };
  }
  return null;
}

/**
 * Cool the failing lease's account for the classified window and lease a
 * different account (excludeEntryId). Returns null when the pool has nothing
 * else routable — the caller then surfaces the original error.
 */
export async function failoverHiveXaiLease(
  lease: HiveXaiLease,
  failure: HiveXaiLeaseFailure,
  stickyKey: string,
): Promise<HiveXaiLease | null> {
  await reportBrokerModelTokenStatus(lease.token, {
    action: 'cool',
    cooldownSeconds: failure.cooldownSeconds,
    reason: failure.kind,
  });
  const next = await leaseHiveXaiAccess({ stickyKey, excludeEntryId: lease.token.entryId });
  if (!next || next.token.entryId === lease.token.entryId) return null;
  return next;
}
