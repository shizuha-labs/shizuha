/**
 * Org-scoped provider resolver client (HIVE-314 S3 / HIVE-2166).
 *
 * Implements the runtime side of the approved per-org Cortex provider/credential
 * reference contract (HIVE-1862, wiki `ec7be32b`; supersedes the older HIVE-336
 * lease wording where they conflict): Hive holds READ-ONLY
 * `HiveOrgProviderReference` mirrors, provider secrets live only in Cortex
 * `ProviderCredential`, and the Cortex router enforces the BYO tenant-lock
 * server-side (`byo_org:<org>` is selectable only for that org).
 *
 * Mirrors the coordinator TokenPool flow (HIVE-125 broker-model-token pattern):
 * the bridge asks the broker sidecar over the pod-local UDS for an org-scoped
 * resolution. The org scope is SERVER-DERIVED by the broker (Hive token claims),
 * never client-claimed. This module never sees key material: the resolved
 * context is redacted by construction (no secret field exists on the type), and
 * the bridge calls Cortex with the Hive consumer token; Cortex's router does the
 * tenant-lock + auth_class enforcement.
 *
 * Isolation invariant (non-waivable, HIVE-336 §isolation / HIVE-1862 §5):
 *   For any inference request by agent principal A in organization O, only a
 *   provider reference where `organization_id == O` may be resolved or cached.
 *   A cross-org candidate is an INVARIANT VIOLATION (fail-loud: Security-owned
 *   Pulse finding + DMs), not a fallback miss.
 *
 * Never logs key material, Authorization headers, or raw provider error bodies
 * (see `redactProviderErrorText`).
 */

import * as fs from 'node:fs';
import * as http from 'node:http';

/** Broker UDS path resolution — same sidecar that serves /token and /model-token. */
const DEFAULT_BROKER_SOCKET = '/run/shizuha/mcp-auth-proxy/proxy.sock';

/** Env var holding an explicit broker socket override (same env the sidecar reads). */
const BROKER_SOCKET_ENV = 'MCP_AUTH_PROXY_SOCKET';

/** Default cache TTL for non-secret provider metadata (ms). */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Identity alias domains canonicalized to one Shizuha ID principal before any
 * membership/override lookup (HIVE-336 resolution step 1). Extend via env.
 */
const DEFAULT_ALIAS_DOMAINS = ['shizuha.com', 'agents.shizuha.io'];

export type ProviderType = 'openai' | 'anthropic' | 'openai_compatible';

export type ProviderUnavailableReason =
  | 'no_provider_configured'
  | 'key_invalid'
  | 'provider_quota_exhausted'
  | 'endpoint_unreachable'
  | 'membership_unproven';

/**
 * Redacted resolution returned to bridges/brokers. By construction this type
 * carries NO secret field — no key material, no Authorization header, no
 * bearer token. The bridge authenticates to Cortex with the Hive consumer
 * token it already holds (org-bound at mint); Cortex injects the provider
 * credential server-side.
 */
export interface ResolvedProviderContext {
  organizationId: string;
  cortexProviderId: string;
  /** Opaque Cortex ProviderCredential reference — an id, never a secret. */
  cortexKeyRef: string;
  providerType: ProviderType;
  baseUrl: string;
  modelId: string;
  /** Stable id for HIVE-319 metering attribution of this resolution. */
  meteringContextId: string;
  /** ISO timestamp of the broker-side resolution (cache/freshness metadata). */
  resolvedAt: string;
  /**
   * Same-org fallback candidates (ordered). Every candidate MUST carry the
   * same organizationId — enforced by `assertSameOrgCandidates`.
   */
  fallbackChain: Array<{
    cortexProviderId: string;
    cortexKeyRef: string;
    modelId: string;
    /** Present on broker responses; a differing value is an invariant violation. */
    organizationId?: string;
  }>;
}

export interface OrgProviderUnavailable {
  outcome: 'unavailable';
  organizationId: string;
  reason: ProviderUnavailableReason;
  /** Redacted broker message; never a raw provider error body. */
  message: string;
}

export interface OrgProviderResolution {
  outcome: 'resolved';
  context: ResolvedProviderContext;
}

export type OrgProviderResolveResult = OrgProviderResolution | OrgProviderUnavailable;

/**
 * Raised when any resolution surface exhibits cross-org evidence. This is an
 * isolation invariant violation — fail-loud, never a fallback miss.
 */
export class ProviderIsolationViolationError extends Error {
  readonly organizationId: string;
  readonly violatingOrgId: string;
  readonly cortexKeyRef: string;

  constructor(args: { organizationId: string; violatingOrgId: string; cortexKeyRef: string }) {
    super(
      `provider isolation invariant violation: org ${args.organizationId} resolved org ${args.violatingOrgId} credential ${args.cortexKeyRef}`,
    );
    this.name = 'ProviderIsolationViolationError';
    this.organizationId = args.organizationId;
    this.violatingOrgId = args.violatingOrgId;
    this.cortexKeyRef = args.cortexKeyRef;
  }
}

export interface CanonicalizeOptions {
  /** Additional approved alias domains (env `SHIZUHA_ID_ALIAS_DOMAINS`). */
  extraAliasDomains?: string[];
}

/**
 * Canonicalize an agent identity to one Shizuha ID principal (HIVE-336 step 1):
 * `agent@shizuha.com` and `agent@agents.shizuha.io` (and any approved alias
 * domains) map to the same principal BEFORE membership or override checks.
 * Unknown domains are preserved verbatim (never silently re-scoped) so the
 * broker-side membership check fails closed on them.
 */
export function canonicalizeAgentPrincipal(identity: string, options: CanonicalizeOptions = {}): string {
  const trimmed = identity.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const aliasDomains = new Set([
    ...DEFAULT_ALIAS_DOMAINS,
    ...(options.extraAliasDomains ?? []),
    ...processEnvAliasDomains(),
  ]);
  if (aliasDomains.has(domain)) return local;
  return trimmed;
}

function processEnvAliasDomains(): string[] {
  const raw = process.env['SHIZUHA_ID_ALIAS_DOMAINS'];
  if (!raw) return [];
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export interface FetchOrgProviderResolutionOptions {
  /** Runtime-presented identity (email or principal); canonicalized here. */
  identity: string;
  /** Requested model id, when the caller has one (else broker picks the org default). */
  requestedModelId?: string;
  /** Provider preference from the UI/runtime, when set. */
  providerPreference?: ProviderType;
  /** Explicit org context when the caller holds it server-side; broker re-verifies. */
  organizationId?: string;
  timeoutMs?: number;
  /** Cache TTL override (ms). */
  cacheTtlMs?: number;
  /** Test/daemon hook: invoked on invariant violations (Pulse finding + DMs). */
  onInvariantViolation?: (violation: ProviderIsolationViolationError) => void;
}

interface BrokerResolutionResponse {
  outcome?: string;
  organization_id?: string;
  cortex_provider_id?: string;
  cortex_key_ref?: string;
  provider_type?: string;
  base_url?: string;
  model_id?: string;
  metering_context_id?: string;
  resolved_at?: string;
  fallback_chain?: Array<{ cortex_provider_id?: string; cortex_key_ref?: string; model_id?: string; organization_id?: string }>;
  reason?: string;
  message?: string;
}

// --- Liveness counters (PLAT-1254 / HIVE-336 fail-loud + liveness) ---
//
// The Prometheus counters themselves live in `src/metrics/registry.ts`
// (`providerResolutionAttempts` / `providerResolutionInvariantViolations`) so
// they are scraped by the daemon's /metrics endpoint like every other counter.
// This module depends on an injectable sink so the resolution logic stays
// unit-testable without the metrics import graph; the default sink lazily
// loads the registry at first use and no-ops if it is unavailable.

export interface ProviderResolutionMetricsSink {
  incAttempt(outcome: 'success' | 'unavailable', providerType: string, reason?: string): void;
  incInvariantViolation(providerType: string): void;
}

const noopSink: ProviderResolutionMetricsSink = {
  incAttempt: () => {},
  incInvariantViolation: () => {},
};

let activeSink: ProviderResolutionMetricsSink | null = null;
let sinkLoadAttempted = false;

async function defaultSink(): Promise<ProviderResolutionMetricsSink> {
  if (activeSink) return activeSink;
  if (!sinkLoadAttempted) {
    sinkLoadAttempted = true;
    try {
      const registry = (await import('../metrics/registry.js')) as unknown as {
        providerResolutionAttempts?: { inc: (labels: Record<string, string>) => void };
        providerResolutionInvariantViolations?: { inc: (labels: Record<string, string>) => void };
      };
      if (registry.providerResolutionAttempts && registry.providerResolutionInvariantViolations) {
        activeSink = {
          incAttempt(outcome, providerType, reason) {
            registry.providerResolutionAttempts!.inc(
              reason ? { outcome, provider_type: providerType, reason } : { outcome, provider_type: providerType },
            );
          },
          incInvariantViolation(providerType) {
            registry.providerResolutionInvariantViolations!.inc({ provider_type: providerType });
          },
        };
      }
    } catch {
      // Metrics unavailable (e.g. unit-test env): resolution correctness never
      // depends on observability; keep the no-op sink.
    }
  }
  return activeSink ?? noopSink;
}

/** Test/daemon override for the metrics sink. Returns the previous sink. */
export function setProviderResolutionMetricsSink(sink: ProviderResolutionMetricsSink | null): ProviderResolutionMetricsSink {
  const prev = activeSink;
  activeSink = sink;
  sinkLoadAttempted = sink !== null ? true : sinkLoadAttempted;
  return prev ?? noopSink;
}

// --- Non-secret metadata cache (TTL, keyed by org + credential) ---

interface CacheEntry {
  result: OrgProviderResolution;
  expiresAt: number;
}

const resolutionCache = new Map<string, CacheEntry>();

export function orgProviderCacheKey(orgId: string, providerId: string, keyRef: string, modelId: string): string {
  // Cache key includes org + provider credential id (HIVE-336 caching rules):
  // a collision across orgs is structurally impossible.
  return `${orgId}|${providerId}|${keyRef}|${modelId}`;
}

/**
 * Invalidate cached non-secret provider metadata. Called by the daemon on
 * credential update/disable signals; with no arguments clears everything.
 */
export function invalidateOrgProviderCache(filter: { organizationId?: string; cortexKeyRef?: string } = {}): number {
  if (!filter.organizationId && !filter.cortexKeyRef) {
    const n = resolutionCache.size;
    resolutionCache.clear();
    return n;
  }
  let removed = 0;
  for (const [key, entry] of resolutionCache) {
    const [orgId, , keyRef] = key.split('|');
    if (filter.organizationId && orgId !== filter.organizationId) continue;
    if (filter.cortexKeyRef && keyRef !== filter.cortexKeyRef) continue;
    resolutionCache.delete(key);
    removed += 1;
  }
  return removed;
}

// --- Invariant enforcement ---

/**
 * Same-org-only validation of a resolved context and its fallback chain
 * (HIVE-336 resolution step 7): a cross-org candidate is an invariant
 * violation, not a fallback miss.
 */
export async function assertSameOrgCandidates(
  context: ResolvedProviderContext,
  onInvariantViolation?: (violation: ProviderIsolationViolationError) => void,
): Promise<void> {
  const offenders = context.fallbackChain.filter((c) => c.organizationId && c.organizationId !== context.organizationId);
  if (offenders.length === 0) return;
  const first = offenders[0];
  if (!first) return; // unreachable after the length guard; satisfies noUncheckedIndexedAccess
  const violation = new ProviderIsolationViolationError({
    organizationId: context.organizationId,
    violatingOrgId: first.organizationId as string,
    cortexKeyRef: first.cortexKeyRef ?? 'unknown',
  });
  try {
    (await defaultSink()).incInvariantViolation(context.providerType);
  } catch {
    // Counter failures must never mask the violation path.
  }
  try {
    onInvariantViolation?.(violation);
  } catch {
    // Reporter failures must not mask the violation path; the throw below is authoritative.
  }
  throw violation;
}

// --- UDS client (mirrors broker-token.ts fetchBrokerModelToken) ---

export function orgProviderBrokerSocketPath(): string | null {
  const override = process.env[BROKER_SOCKET_ENV];
  const candidate = override && override.length > 0 ? override : DEFAULT_BROKER_SOCKET;
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    return null;
  }
  return null;
}

function buildQuery(opts: FetchOrgProviderResolutionOptions, canonicalIdentity: string): string {
  const params = new URLSearchParams();
  params.set('identity', canonicalIdentity);
  if (opts.requestedModelId) params.set('model', opts.requestedModelId);
  if (opts.providerPreference) params.set('provider', opts.providerPreference);
  if (opts.organizationId) params.set('org', opts.organizationId);
  return params.toString();
}

function parseResolutionResponse(body: BrokerResolutionResponse): OrgProviderResolveResult | null {
  if (body.outcome === 'unavailable') {
    const reason = (body.reason ?? 'no_provider_configured') as ProviderUnavailableReason;
    return {
      outcome: 'unavailable',
      organizationId: body.organization_id ?? '',
      reason,
      message: typeof body.message === 'string' ? redactProviderErrorText(body.message) : '',
    };
  }
  if (body.outcome !== 'resolved') return null;
  if (!body.organization_id || !body.cortex_provider_id || !body.cortex_key_ref || !body.model_id) return null;
  const providerType = (body.provider_type ?? 'openai_compatible') as ProviderType;
  const context: ResolvedProviderContext = {
    organizationId: body.organization_id,
    cortexProviderId: body.cortex_provider_id,
    cortexKeyRef: body.cortex_key_ref,
    providerType,
    baseUrl: body.base_url ?? '',
    modelId: body.model_id,
    meteringContextId: body.metering_context_id ?? '',
    resolvedAt: body.resolved_at ?? '',
    fallbackChain: (body.fallback_chain ?? []).map((c) => ({
      cortexProviderId: c.cortex_provider_id ?? '',
      cortexKeyRef: c.cortex_key_ref ?? '',
      modelId: c.model_id ?? '',
      organizationId: c.organization_id,
    })),
  };
  return { outcome: 'resolved', context };
}

/**
 * Ask the broker sidecar for the org-scoped provider resolution (HIVE-1862 §3).
 * Returns null when the broker is absent/unreachable (callers fall back to the
 * existing per-agent path — the org reference is additive, never a forced
 * migration). Non-null results carry a redacted context or an org-scoped
 * `unavailable` outcome.
 *
 * DENY SEMANTICS: cross-org evidence raises `ProviderIsolationViolationError`
 * (after the fail-loud counter + reporter). Callers MUST treat that error as a
 * terminal deny — fail the inference request; NEVER fall back to the legacy
 * env-token/broker-model-token path on it (a silent fallback would serve the
 * request the invariant just denied).
 */
export async function fetchOrgProviderResolution(
  opts: FetchOrgProviderResolutionOptions,
): Promise<OrgProviderResolveResult | null> {
  const socketPath = orgProviderBrokerSocketPath();
  if (!socketPath) return null;

  const canonicalIdentity = canonicalizeAgentPrincipal(opts.identity);
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  const query = buildQuery(opts, canonicalIdentity);
  const body = await requestBroker(socketPath, query, opts.timeoutMs ?? 5000);
  if (!body) return null;

  const parsed = parseResolutionResponse(body);
  if (!parsed) return null;

  const sink = await defaultSink();
  if (parsed.outcome === 'resolved') {
    await assertSameOrgCandidates(parsed.context, opts.onInvariantViolation);
    const key = orgProviderCacheKey(
      parsed.context.organizationId,
      parsed.context.cortexProviderId,
      parsed.context.cortexKeyRef,
      parsed.context.modelId,
    );
    resolutionCache.set(key, { result: parsed, expiresAt: Date.now() + ttlMs });
    sink.incAttempt('success', parsed.context.providerType);
    return parsed;
  }

  sink.incAttempt('unavailable', 'unknown', parsed.reason);
  return parsed;
}

/** Read a cached resolution without hitting the broker (TTL-respected). */
export function peekOrgProviderResolution(
  orgId: string,
  providerId: string,
  keyRef: string,
  modelId: string,
): OrgProviderResolution | null {
  const entry = resolutionCache.get(orgProviderCacheKey(orgId, providerId, keyRef, modelId));
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    resolutionCache.delete(orgProviderCacheKey(orgId, providerId, keyRef, modelId));
    return null;
  }
  return entry.result;
}

function requestBroker(socketPath: string, query: string, timeoutMs: number): Promise<BrokerResolutionResponse | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath, path: `/org-provider/resolve?${query}`, method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as BrokerResolutionResponse);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

// --- Redaction (HIVE-336 §redaction / probe suite) ---

const AUTH_HEADER_RE = /(?<=^|\s)(authorization|proxy-authorization|x-api-key)\s*[:=]\s*\S+/gi;
/** Bearer/sk-style token shapes; long hex/base64url blobs ≥ 24 chars. */
const TOKEN_LIKE_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|[A-Za-z0-9_-]{24,})\b/g;

/**
 * Scrub provider/broker error text before it can reach logs, metrics, Pulse,
 * or UI surfaces: drops Authorization-style headers and token-like blobs.
 * Structurally, `ResolvedProviderContext` never carries key material; this
 * guards the free-text paths (error messages, provider bodies).
 */
export function redactProviderErrorText(text: string): string {
  return text.replace(AUTH_HEADER_RE, '$1=<redacted>').replace(TOKEN_LIKE_RE, '<redacted>');
}
