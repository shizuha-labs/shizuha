// PLAT-166 / ADR-PLAT-002 §5 — tests for the credential broker's cluster-internal
// JWT-authed network listener. Proves: JWT gate (fail-closed), subject→agent,
// routing into the UNCHANGED arbiter on the request plane (grant-plane rejected),
// TTL clamp [precond b], per-subject rate-limit + circuit-breaker [precond a].

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWK, type JWTVerifyGetKey } from 'jose';
import { JwksTokenVerifier } from '../../src/daemon/jwks-token-verifier.js';
import {
  buildCredentialBrokerNetworkListener,
  clampExpiry,
  defaultSubjectToAgent,
  SeamGuard,
} from '../../src/daemon/credential-broker-network-listener.js';
import type { CredentialBrokerOptions, CredentialBrokerStore } from '../../src/daemon/credential-broker.js';
import type { AgentInfo } from '../../src/daemon/types.js';

const ISS = 'https://id.shizuha.test/';
const AUD = 'shizuha-credential-broker';
const KID = 'rs-1';

let priv: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const rs = await generateKeyPair('RS256');
  priv = rs.privateKey;
  const jwk: JWK = { ...(await exportJWK(rs.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-a',
    username: 'alice',
    email: 'alice@shizuha.com',
    role: 'Engineer',
    status: 'active',
    mcpServers: [],
    personalityTraits: {},
    skills: [],
    ...overrides,
  } as AgentInfo;
}

function makeStore(initial: AgentInfo[]): CredentialBrokerStore & { agents: AgentInfo[] } {
  return {
    agents: structuredClone(initial),
    readAgents() {
      return this.agents;
    },
    writeAgents(agents: AgentInfo[]) {
      this.agents = structuredClone(agents);
    },
  };
}

async function mint(sub: string | undefined, extra: Record<string, unknown> = {}): Promise<string> {
  const jwt = new SignJWT(extra)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(ISS)
    .setAudience(AUD)
    .setExpirationTime('2h');
  if (sub !== undefined) jwt.setSubject(sub);
  return jwt.sign(priv);
}

function build(opts: {
  store: CredentialBrokerStore;
  audit?: (e: Record<string, unknown>) => void;
  maxTtlSeconds?: number;
  rateLimit?: { sustainedPerMinute: number; burst: number };
  circuitBreaker?: { failureThreshold: number; cooldownMs: number };
  now?: () => number;
}) {
  // The arbiter (and the listener's fail-closed guard) require an audit sink.
  const options: CredentialBrokerOptions = { store: opts.store, recordAuditEvent: opts.audit ?? (() => {}) };
  return buildCredentialBrokerNetworkListener({
    verifier: new JwksTokenVerifier({ jwks, issuer: ISS, audience: AUD }),
    options,
    podIdentity: 'sidecar-pod-xyz',
    maxTtlSeconds: opts.maxTtlSeconds ?? 3600,
    rateLimit: opts.rateLimit,
    circuitBreaker: opts.circuitBreaker,
    now: opts.now,
  });
}

async function post(app: ReturnType<typeof build>, token: string | null, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/credential/request',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as object,
  });
}

describe('credential-broker network listener — auth gate', () => {
  it('rejects a missing/invalid token with 401', async () => {
    const app = build({ store: makeStore([makeAgent()]) });
    const noTok = await post(app, null, { action: 'request_credential', request: { scope: 'github', reason: 'x' } });
    expect(noTok.statusCode).toBe(401);
    const badTok = await post(app, 'not-a-jwt', { action: 'request_credential', request: { scope: 'github', reason: 'x' } });
    expect(badTok.statusCode).toBe(401);
  });

  it('rejects a verified subject that maps to no agent with 403', async () => {
    const app = build({ store: makeStore([makeAgent()]) });
    const token = await mint('agent:nobody');
    const res = await post(app, token, { action: 'request_credential', request: { scope: 'github', reason: 'x' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/not mapped/) });
  });
});

describe('credential-broker network listener — arbiter routing', () => {
  it('routes request_credential into the arbiter and opens a request (200)', async () => {
    const store = makeStore([makeAgent()]);
    const app = build({ store });
    const token = await mint('alice'); // matches agent.username
    const res = await post(app, token, {
      action: 'request_credential',
      request: { scope: 'github', reason: 'alice needs github' },
    });
    expect(res.statusCode).toBe(200);
    expect(store.agents.find((a) => a.username === 'alice')!.credentialRequests).toHaveLength(1);
  });

  it('rejects a grant-plane action over the network (request plane only) with 403', async () => {
    const store = makeStore([makeAgent({ credentialGrantScopes: ['github'] })]);
    const app = build({ store });
    const token = await mint('alice');
    const res = await post(app, token, {
      action: 'grant_credential',
      request: { scope: 'github', requestId: 'x' },
    });
    expect(res.statusCode).toBe(403); // arbiter: grant_credential requires the grant socket
  });

  it('rejects a malformed envelope with 400', async () => {
    const app = build({ store: makeStore([makeAgent()]) });
    const token = await mint('alice');
    expect((await post(app, token, { nope: true })).statusCode).toBe(400);
    expect((await post(app, token, { action: 'request_credential' })).statusCode).toBe(400);
  });
});

describe('credential-broker network listener — TTL clamp [precond b]', () => {
  it('clamps an over-ceiling requested expiry to now+maxTtlSeconds', async () => {
    const store = makeStore([makeAgent()]);
    // Use the real clock: the arbiter's normalizeExpiry enforces "future" against
    // Date.now(), so the clamp ceiling must be computed from the same clock.
    const app = build({ store, maxTtlSeconds: 3600 });
    const token = await mint('alice');
    const before = Date.now();
    const farFuture = new Date(before + 10 * 24 * 3600 * 1000).toISOString();
    const res = await post(app, token, {
      action: 'request_credential',
      request: { scope: 'github', reason: 'x', expiry: farFuture },
    });
    expect(res.statusCode).toBe(200);
    const stored = store.agents.find((a) => a.username === 'alice')!.credentialRequests![0];
    const storedMs = Date.parse(stored.expiry as string);
    expect(storedMs).toBeGreaterThan(before); // future clamp
    expect(storedMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 1000); // clamped to the ceiling
  });

  it('clampExpiry unit: absent/over-ceiling → ceiling; within-ceiling → unchanged', () => {
    const now = Date.parse('2026-06-14T00:00:00.000Z');
    const ceiling = new Date(now + 3600_000).toISOString();
    expect(clampExpiry(undefined, now, 3600)).toBe(ceiling);
    expect(clampExpiry('not-a-date', now, 3600)).toBe(ceiling);
    expect(clampExpiry(new Date(now + 10 * 3600_000).toISOString(), now, 3600)).toBe(ceiling);
    const within = new Date(now + 1800_000).toISOString();
    expect(clampExpiry(within, now, 3600)).toBe(within);
  });
});

describe('credential-broker network listener — rate-limit + circuit-breaker [precond a]', () => {
  it('429s once the per-subject burst is exhausted (no refill)', async () => {
    const store = makeStore([makeAgent()]);
    // sustainedPerMinute:0 means zero refill regardless of elapsed wall-clock, so
    // the real clock is fine here (and keeps the arbiter's expiry check consistent).
    const app = build({ store, rateLimit: { sustainedPerMinute: 0, burst: 2 } });
    const token = await mint('alice');
    const body = { action: 'request_credential', request: { scope: 'github', reason: 'x' } };
    expect((await post(app, token, body)).statusCode).toBe(200);
    expect((await post(app, token, body)).statusCode).toBe(200);
    expect((await post(app, token, body)).statusCode).toBe(429);
  });

  it('opens the per-subject circuit breaker after consecutive arbiter failures (503)', async () => {
    const store = makeStore([makeAgent()]);
    const app = build({
      store,
      rateLimit: { sustainedPerMinute: 0, burst: 100 }, // don't let rate-limit interfere
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
    });
    const token = await mint('alice');
    const bad = { action: 'request_credential', request: { scope: 'not-a-valid-scope', reason: 'x' } };
    expect((await post(app, token, bad)).statusCode).toBe(403); // arbiter rejects bad scope → failure 1
    expect((await post(app, token, bad)).statusCode).toBe(403); // failure 2 → trips breaker
    // breaker now open: even a well-formed request fast-rejects
    const good = { action: 'request_credential', request: { scope: 'github', reason: 'x' } };
    expect((await post(app, token, good)).statusCode).toBe(503);
  });

  it('SeamGuard unit: success resets the breaker', () => {
    let t = 0;
    const g = new SeamGuard({ sustainedPerMinute: 0, burst: 100 }, { failureThreshold: 2, cooldownMs: 1000 }, () => t);
    g.check('s'); g.recordFailure('s');
    g.recordSuccess('s'); // reset
    g.check('s'); g.recordFailure('s'); // only 1 failure since reset → not open
    expect(g.check('s')).toEqual({ ok: true });
  });
});

describe('credential-broker network listener — construction guard', () => {
  it('refuses to build without an audit sink (fail-closed)', () => {
    expect(() =>
      buildCredentialBrokerNetworkListener({
        verifier: new JwksTokenVerifier({ jwks, issuer: ISS, audience: AUD }),
        options: { store: makeStore([makeAgent()]) } as CredentialBrokerOptions,
        maxTtlSeconds: 3600,
      }),
    ).toThrow(/audit is mandatory/);
  });
});

describe('credential-broker network listener — subject resolution unit', () => {
  it('defaultSubjectToAgent requires a unique id|username match', () => {
    const a = makeAgent({ id: 'id-1', username: 'alice' });
    const b = makeAgent({ id: 'id-2', username: 'bob' });
    expect(defaultSubjectToAgent('id-1', [a, b])).toBe(a);
    expect(defaultSubjectToAgent('bob', [a, b])).toBe(b);
    expect(defaultSubjectToAgent('nobody', [a, b])).toBeUndefined();
    // ambiguous (username collides with another's id) → deny
    const c = makeAgent({ id: 'alice', username: 'carol' });
    expect(defaultSubjectToAgent('alice', [a, c])).toBeUndefined();
  });
});

describe('Fastify per-content-type body validation security boundary', () => {
  it.each([
    ['canonical JSON', 'application/json'],
    ['leading-space JSON (CVE-2026-33806)', ' application/json'],
    ['leading-tab JSON', '\tapplication/json'],
  ])('rejects an invalid payload with %s', async (_label, contentType) => {
    const app = Fastify({ logger: false });
    app.post('/transfer', {
      schema: {
        body: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount', 'recipient'],
                properties: {
                  amount: { type: 'number', maximum: 1_000 },
                  recipient: { type: 'string', maxLength: 50 },
                  admin: { type: 'boolean', enum: [false] },
                },
                additionalProperties: false,
              },
            },
          },
        },
      },
      handler: async (request) => ({ processed: true, data: request.body }),
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/transfer',
        headers: { 'content-type': contentType },
        payload: JSON.stringify({ amount: 9_999, recipient: 'EVIL', admin: true }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'FST_ERR_VALIDATION' });
    } finally {
      await app.close();
    }
  });
});
