// PLAT-166 / ADR-PLAT-002 §5 — the credential broker's cluster-internal,
// JWT-authenticated NETWORK listener (the "dual-listener, one arbiter").
//
// This is the pod-reachable twin of the host `request.sock`. It authenticates the
// caller from a verified JWT subject (JwksTokenVerifier) instead of SO_PEERCRED,
// resolves that subject to an AgentInfo, and routes the SAME broker envelope into
// the UNCHANGED arbiter (`handleCredentialBrokerRequest`) with `socketKind:'request'`
// — so it carries only request-plane actions; grant-plane actions (grant/deny/
// expire/payload-audit) remain host-grant-socket-only, rejected here by the arbiter.
//
// It adds ONLY transport concerns at the seam (no new authz — the arbiter stays the
// sole grant authority): a per-subject rate-limit + circuit-breaker [precond a], an
// enforced TTL clamp on the requested expiry [precond b], and a fail-closed,
// metadata-only audit (subject + sidecar pod identity; never secret material).
//
// Inert until wired: nothing calls this unless startup installs it with a verifier
// + listen config, so it can land ahead of the sidecar relay (PR-B).

import Fastify, { type FastifyInstance } from 'fastify';
import {
  handleCredentialBrokerRequest,
  type CredentialBrokerEnvelope,
  type CredentialBrokerOptions,
} from './credential-broker.js';
import { TokenVerificationError, type TokenVerifier } from './jwks-token-verifier.js';
import type { AgentInfo } from './types.js';

export interface SeamRateLimitConfig {
  /** Sustained refill rate (requests/min) per subject. */
  sustainedPerMinute: number;
  /** Bucket capacity (max burst) per subject. */
  burst: number;
}

export interface SeamCircuitBreakerConfig {
  /** Consecutive arbiter failures (per subject) that trip the breaker open. */
  failureThreshold: number;
  /** How long the breaker stays open (ms) before allowing a trial again. */
  cooldownMs: number;
}

export interface BrokerNetworkListenerConfig {
  /** JWT verifier (JwksTokenVerifier in prod). */
  verifier: TokenVerifier;
  /** The broker arbiter options (store, recordAuditEvent, …) — UNCHANGED authority. */
  options: CredentialBrokerOptions;
  /** Sidecar/pod identity recorded in the audit trail. */
  podIdentity?: string;
  /** Enforced ceiling on a request's expiry [precond b]. */
  maxTtlSeconds: number;
  rateLimit?: SeamRateLimitConfig;
  circuitBreaker?: SeamCircuitBreakerConfig;
  /** Resolve a verified JWT subject to an AgentInfo. Default: unique id|username. */
  subjectToAgent?: (subject: string, agents: AgentInfo[]) => AgentInfo | undefined;
  /** Max request body bytes (default 16 KiB). */
  bodyLimitBytes?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

const DEFAULT_RATE_LIMIT: SeamRateLimitConfig = { sustainedPerMinute: 30, burst: 10 };
const DEFAULT_CIRCUIT_BREAKER: SeamCircuitBreakerConfig = { failureThreshold: 5, cooldownMs: 60_000 };

/** Default subject→agent: a UNIQUE match on agent id or username, else deny (fail-closed). */
export function defaultSubjectToAgent(subject: string, agents: AgentInfo[]): AgentInfo | undefined {
  const matches = agents.filter((a) => a.id === subject || a.username === subject);
  return matches.length === 1 ? matches[0] : undefined;
}

type GateResult = { ok: true } | { ok: false; status: number; reason: string };

/** Per-subject token-bucket rate-limit + consecutive-failure circuit-breaker [precond a]. */
export class SeamGuard {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  private readonly breakers = new Map<string, { failures: number; openUntilMs: number }>();
  private readonly rl: SeamRateLimitConfig;
  private readonly cb: SeamCircuitBreakerConfig;
  private readonly now: () => number;

  constructor(rl: SeamRateLimitConfig | undefined, cb: SeamCircuitBreakerConfig | undefined, now: () => number) {
    this.rl = rl ?? DEFAULT_RATE_LIMIT;
    this.cb = cb ?? DEFAULT_CIRCUIT_BREAKER;
    this.now = now;
  }

  /** Admission check: circuit-breaker first (fast-reject), then token bucket. */
  check(subject: string): GateResult {
    const t = this.now();
    const breaker = this.breakers.get(subject);
    if (breaker && breaker.openUntilMs > t) {
      return { ok: false, status: 503, reason: 'circuit_open' };
    }
    let bucket = this.buckets.get(subject);
    if (!bucket) {
      bucket = { tokens: this.rl.burst, lastRefillMs: t };
      this.buckets.set(subject, bucket);
    } else {
      const refill = ((t - bucket.lastRefillMs) / 60_000) * this.rl.sustainedPerMinute;
      bucket.tokens = Math.min(this.rl.burst, bucket.tokens + refill);
      bucket.lastRefillMs = t;
    }
    if (bucket.tokens < 1) {
      return { ok: false, status: 429, reason: 'rate_limited' };
    }
    bucket.tokens -= 1;
    return { ok: true };
  }

  recordSuccess(subject: string): void {
    this.breakers.delete(subject);
  }

  recordFailure(subject: string): void {
    const t = this.now();
    const breaker = this.breakers.get(subject) ?? { failures: 0, openUntilMs: 0 };
    breaker.failures += 1;
    if (breaker.failures >= this.cb.failureThreshold) {
      breaker.openUntilMs = t + this.cb.cooldownMs;
      breaker.failures = 0;
    }
    this.breakers.set(subject, breaker);
  }
}

/**
 * Clamp a requested expiry to now+maxTtlSeconds [precond b]. Returns an ISO string
 * the arbiter's normalizeExpiry accepts. Always enforces a ceiling: an absent or
 * over-ceiling expiry becomes exactly the ceiling.
 */
export function clampExpiry(provided: unknown, nowMs: number, maxTtlSeconds: number): string {
  const ceilingMs = nowMs + maxTtlSeconds * 1000;
  const ceilingIso = new Date(ceilingMs).toISOString();
  if (typeof provided !== 'string' || !provided.trim()) return ceilingIso;
  const parsed = Date.parse(provided.trim());
  if (!Number.isFinite(parsed) || parsed > ceilingMs) return ceilingIso;
  return provided.trim();
}

const REQUEST_PLANE: 'request' = 'request';

/**
 * Build the fastify app for the cluster-internal network listener. Returns the
 * (un-listened) instance — callers `listen()` on a cluster-internal address that
 * a NetworkPolicy scopes to sidecar pods. Testable via `app.inject(...)`.
 */
export function buildCredentialBrokerNetworkListener(cfg: BrokerNetworkListenerConfig): FastifyInstance {
  // Fail-closed: the broker arbiter throws if it has no audit sink, and the §5
  // invariant is a metadata-only audit on every outcome — so refuse to build the
  // listener without one rather than discover it per-request.
  if (!cfg.options.recordAuditEvent) {
    throw new Error('credential-broker network listener requires options.recordAuditEvent (audit is mandatory)');
  }
  const app = Fastify({ bodyLimit: cfg.bodyLimitBytes ?? 16 * 1024 });
  const now = cfg.now ?? (() => Date.now());
  const subjectToAgent = cfg.subjectToAgent ?? defaultSubjectToAgent;
  const guard = new SeamGuard(cfg.rateLimit, cfg.circuitBreaker, now);

  const audit = (event: Record<string, unknown>): void => {
    cfg.options.recordAuditEvent?.({
      transport: 'cluster-network',
      pod: cfg.podIdentity ?? null,
      ...event,
    });
  };

  app.post('/credential/request', async (req, reply) => {
    // --- 1. JWT identity gate (fail closed; no SO_PEERCRED on the network path) ---
    const authz = req.headers['authorization'];
    const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    let subject: string;
    try {
      ({ subject } = await cfg.verifier.verify(token));
    } catch (err) {
      const reason = err instanceof TokenVerificationError ? err.code : 'verification_failed';
      audit({ event: 'credential-network-refused', failure_class: 'jwt_fail', reason });
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // --- 2. per-subject rate-limit + circuit-breaker [precond a] ---
    const gate = guard.check(subject);
    if (!gate.ok) {
      audit({ event: 'credential-network-refused', failure_class: gate.reason, subject });
      return reply.code(gate.status).send({ error: gate.reason });
    }

    // --- 3. resolve the verified subject to an agent (fail closed) ---
    const agents = cfg.options.store.readAgents();
    const agent = subjectToAgent(subject, agents);
    if (!agent) {
      guard.recordFailure(subject);
      audit({ event: 'credential-network-refused', failure_class: 'subject_unmapped', subject });
      return reply.code(403).send({ error: 'subject not mapped to an agent' });
    }

    // --- 4. validate the broker envelope + enforce the TTL clamp [precond b] ---
    const body = req.body as Partial<CredentialBrokerEnvelope> | undefined;
    if (
      !body ||
      typeof body !== 'object' ||
      typeof body.action !== 'string' ||
      typeof body.request !== 'object' ||
      body.request === null
    ) {
      audit({ event: 'credential-network-refused', failure_class: 'bad_envelope', subject, agent_id: agent.id });
      return reply.code(400).send({ error: 'invalid broker envelope' });
    }
    const request: Record<string, unknown> = { ...(body.request as Record<string, unknown>) };
    request.expiry = clampExpiry(request.expiry, now(), cfg.maxTtlSeconds);
    const envelope: CredentialBrokerEnvelope = { action: body.action as CredentialBrokerEnvelope['action'], request };

    // --- 5. route into the UNCHANGED arbiter on the request plane (no socket) ---
    // socketKind='request' means grant-plane actions are rejected by the arbiter
    // itself — the network path can never issue a grant, only open/manage requests.
    try {
      const result = handleCredentialBrokerRequest(envelope, null, REQUEST_PLANE, cfg.options, undefined, {
        agent,
        agents,
      });
      guard.recordSuccess(subject);
      audit({
        event: 'credential-network-ok',
        subject,
        agent_id: agent.id,
        action: envelope.action,
        scope: typeof request.scope === 'string' ? request.scope : null,
      });
      return reply.code(200).send(result);
    } catch (err) {
      // Arbiter throws on validation/authz/plane violations. Fail closed: a generic
      // 403, NEVER any secret material; the specific cause goes only to the audit.
      guard.recordFailure(subject);
      audit({
        event: 'credential-network-denied',
        subject,
        agent_id: agent.id,
        action: envelope.action,
        reason: err instanceof Error ? err.message : 'arbiter_error',
      });
      return reply.code(403).send({ error: 'credential request denied' });
    }
  });

  return app;
}
