/**
 * Hive xAI / SuperGrok lease — Codex-shaped, access-only.
 *
 * Hive Token Coordinator is the sole refresh writer. Agent runtimes lease an
 * access token through the pod-local broker UDS (`GET /model-token?provider=xai`).
 * The rotating refresh token never enters the agent filesystem or env. Serving
 * a stale refresh copy would invalidate the current generation (RFC 9700 §4.14).
 */

import { XaiProvider } from '../provider/xai.js';
import type { LLMProvider } from '../provider/types.js';
import {
  brokerExpected,
  fetchBrokerModelToken,
  reportBrokerModelTokenStatus,
  type BrokerModelToken,
} from './broker-token.js';

export const HIVE_XAI_GROK_MODEL = 'xai:grok-4.6';
export const HIVE_XAI_UPSTREAM_MODEL = 'grok-4.6';

export interface BrokerXaiAuthPayload {
  accessToken: string;
  email: string;
  accountId: string;
}

export function hiveDirectXaiUpstreamModel(model: string): string {
  const lower = String(model || '').trim().toLowerCase();
  const bare = lower.startsWith('xai:') ? lower.slice(4) : lower;
  if (bare.startsWith('grok-')) return bare;
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
    return {
      accessToken,
      email: firstString(parsed.email) || 'broker',
      accountId: firstString(parsed.account_id, parsed.accountId),
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
    provider: new XaiProvider(payload.accessToken),
  };
}

export async function coolHiveXaiLease(lease: HiveXaiLease | null): Promise<void> {
  if (!lease) return;
  await reportBrokerModelTokenStatus(lease.token, { action: 'cool', cooldownSeconds: 60 });
}
