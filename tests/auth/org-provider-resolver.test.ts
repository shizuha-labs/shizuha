import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  ProviderIsolationViolationError,
  assertSameOrgCandidates,
  canonicalizeAgentPrincipal,
  fetchOrgProviderResolution,
  invalidateOrgProviderCache,
  orgProviderCacheKey,
  orgProviderBrokerSocketPath,
  peekOrgProviderResolution,
  redactProviderErrorText,
} from '../../src/auth/org-provider-resolver.js';

// HIVE-2166 (HIVE-314 S3): runtime-side tests for the org-scoped provider
// resolver — alias canonicalization, same-org isolation invariant, cache
// invalidation, and redaction, per the HIVE-336/HIVE-1862 probe suite.

const ENV = 'MCP_AUTH_PROXY_SOCKET';
let _sockSeq = 0;
let SOCK = path.join(os.tmpdir(), `orgprov-test-${process.pid}-${Date.now()}.sock`);

function startBroker(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<http.Server> {
  SOCK = path.join(os.tmpdir(), `orgprov-test-${process.pid}-${Date.now()}-${_sockSeq++}.sock`);
  return new Promise((resolve) => {
    if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
    const srv = http.createServer(handler);
    srv.listen(SOCK, () => resolve(srv));
  });
}

function resolvedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: 'resolved',
    organization_id: 'org-a',
    cortex_provider_id: 'prov-1',
    cortex_key_ref: 'cred-1',
    provider_type: 'openai_compatible',
    base_url: 'https://fake-a.example.internal/v1',
    model_id: 'fake-model',
    metering_context_id: 'm-1',
    resolved_at: '2026-09-02T00:00:00Z',
    fallback_chain: [],
    ...overrides,
  };
}

describe('org-provider-resolver', () => {
  let server: http.Server | null = null;
  const prev = process.env[ENV];

  beforeEach(() => {
    invalidateOrgProviderCache();
  });

  afterEach(async () => {
    if (server) {
      await new Promise((r) => server!.close(() => r(null)));
      server = null;
    }
    if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  });

  describe('canonicalizeAgentPrincipal (alias test)', () => {
    it('maps @shizuha.com and @agents.shizuha.io to the same principal', () => {
      expect(canonicalizeAgentPrincipal('Agent@shizuha.com')).toBe('agent');
      expect(canonicalizeAgentPrincipal('agent@agents.shizuha.io')).toBe('agent');
      expect(canonicalizeAgentPrincipal('agent@shizuha.com')).toBe(
        canonicalizeAgentPrincipal('agent@agents.shizuha.io'),
      );
    });

    it('honors extra approved alias domains and preserves unknown domains', () => {
      expect(canonicalizeAgentPrincipal('a@corp.example', { extraAliasDomains: ['corp.example'] })).toBe('a');
      // Unknown domain is preserved verbatim so membership checks fail closed.
      expect(canonicalizeAgentPrincipal('a@unknown.example')).toBe('a@unknown.example');
    });

    it('supports env-configured alias domains', () => {
      const prevDomains = process.env['SHIZUHA_ID_ALIAS_DOMAINS'];
      process.env['SHIZUHA_ID_ALIAS_DOMAINS'] = 'Other.example';
      try {
        expect(canonicalizeAgentPrincipal('x@other.example')).toBe('x');
      } finally {
        if (prevDomains === undefined) delete process.env['SHIZUHA_ID_ALIAS_DOMAINS'];
        else process.env['SHIZUHA_ID_ALIAS_DOMAINS'] = prevDomains;
      }
    });
  });

  describe('isolation invariant (same-org only)', () => {
    it('throws ProviderIsolationViolationError on a cross-org fallback candidate and calls the reporter', async () => {
      const violations: ProviderIsolationViolationError[] = [];
      const context = {
        organizationId: 'org-a',
        cortexProviderId: 'prov-1',
        cortexKeyRef: 'cred-1',
        providerType: 'openai_compatible' as const,
        baseUrl: 'https://fake-a.example.internal/v1',
        modelId: 'm',
        meteringContextId: 'm-1',
        resolvedAt: '2026-09-02T00:00:00Z',
        fallbackChain: [
          { cortexProviderId: 'prov-b', cortexKeyRef: 'cred-orgB', modelId: 'mb', organizationId: 'org-b' },
        ],
      };
      await expect(
        assertSameOrgCandidates(context, (v: ProviderIsolationViolationError) => {
          violations.push(v);
        }),
      ).rejects.toThrow(ProviderIsolationViolationError);
      expect(violations).toHaveLength(1);
      expect(violations[0].organizationId).toBe('org-a');
      expect(violations[0].violatingOrgId).toBe('org-b');
    });

    it('accepts a same-org fallback chain', async () => {
      server = await startBroker((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            resolvedBody({
              fallback_chain: [
                { cortex_provider_id: 'prov-2', cortex_key_ref: 'cred-2', model_id: 'm2', organization_id: 'org-a' },
              ],
            }),
          ),
        );
      });
      process.env[ENV] = SOCK;
      const result = await fetchOrgProviderResolution({ identity: 'agent@shizuha.com' });
      expect(result?.outcome).toBe('resolved');
    });

    it('DENIES with ProviderIsolationViolationError on cross-org evidence from the broker (no silent fallback)', async () => {
      server = await startBroker((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            resolvedBody({
              fallback_chain: [
                { cortex_provider_id: 'prov-b', cortex_key_ref: 'cred-orgB', model_id: 'mb', organization_id: 'org-b' },
              ],
            }),
          ),
        );
      });
      process.env[ENV] = SOCK;
      const violations: ProviderIsolationViolationError[] = [];
      await expect(
        fetchOrgProviderResolution({
          identity: 'agent@shizuha.com',
          onInvariantViolation: (v) => violations.push(v),
        }),
      ).rejects.toThrow(ProviderIsolationViolationError);
      expect(violations).toHaveLength(1);
      // The violating context must never be cached.
      expect(peekOrgProviderResolution('org-a', 'prov-1', 'cred-1', 'fake-model')).toBeNull();
    });
  });

  describe('cache (non-secret metadata, TTL, invalidation)', () => {
    it('caches a resolved context keyed by org+provider+credential+model and peeks it', async () => {
      server = await startBroker((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resolvedBody()));
      });
      process.env[ENV] = SOCK;
      await fetchOrgProviderResolution({ identity: 'agent@shizuha.com' });
      expect(peekOrgProviderResolution('org-a', 'prov-1', 'cred-1', 'fake-model')?.outcome).toBe('resolved');
      // Distinct org with the same provider/key/model ids must NOT collide.
      expect(peekOrgProviderResolution('org-b', 'prov-1', 'cred-1', 'fake-model')).toBeNull();
    });

    it('invalidates by org and by credential ref', async () => {
      server = await startBroker((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resolvedBody()));
      });
      process.env[ENV] = SOCK;
      await fetchOrgProviderResolution({ identity: 'agent@shizuha.com' });
      expect(invalidateOrgProviderCache({ cortexKeyRef: 'cred-other' })).toBe(0);
      expect(invalidateOrgProviderCache({ organizationId: 'org-a' })).toBe(1);
      expect(peekOrgProviderResolution('org-a', 'prov-1', 'cred-1', 'fake-model')).toBeNull();
    });

    it('expires entries after the TTL', async () => {
      server = await startBroker((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resolvedBody()));
      });
      process.env[ENV] = SOCK;
      await fetchOrgProviderResolution({ identity: 'agent@shizuha.com', cacheTtlMs: 1 });
      await new Promise((r) => setTimeout(r, 5));
      expect(peekOrgProviderResolution('org-a', 'prov-1', 'cred-1', 'fake-model')).toBeNull();
    });
  });

  describe('UDS client', () => {
    it('returns null when no broker socket exists', async () => {
      process.env[ENV] = path.join(os.tmpdir(), `orgprov-missing-${process.pid}.sock`);
      expect(orgProviderBrokerSocketPath()).toBeNull();
      expect(await fetchOrgProviderResolution({ identity: 'agent@shizuha.com' })).toBeNull();
    });

    it('returns an org-scoped unavailable outcome from the broker', async () => {
      server = await startBroker((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            outcome: 'unavailable',
            organization_id: 'org-a',
            reason: 'no_provider_configured',
            message: 'no active provider for org',
          }),
        );
      });
      process.env[ENV] = SOCK;
      const result = await fetchOrgProviderResolution({ identity: 'agent@shizuha.com' });
      expect(result?.outcome).toBe('unavailable');
      if (result?.outcome === 'unavailable') {
        expect(result.reason).toBe('no_provider_configured');
        expect(result.organizationId).toBe('org-a');
      }
    });

    it('returns null on malformed broker payloads', async () => {
      server = await startBroker((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ outcome: 'resolved' })); // missing required fields
      });
      process.env[ENV] = SOCK;
      expect(await fetchOrgProviderResolution({ identity: 'agent@shizuha.com' })).toBeNull();
    });

    it('sends the canonicalized identity to the broker', async () => {
      let seenIdentity = '';
      server = await startBroker((req, res) => {
        seenIdentity = new URL(req.url ?? '/', 'http://localhost').searchParams.get('identity') ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(resolvedBody()));
      });
      process.env[ENV] = SOCK;
      await fetchOrgProviderResolution({ identity: 'Agent@Agents.Shizuha.io' });
      expect(seenIdentity).toBe('agent');
    });
  });

  describe('redaction', () => {
    it('scrubs Authorization headers and token-like blobs from error text', () => {
      const raw =
        'upstream error: Authorization: Bearer sk-abcdef1234567890abcdef; x-api-key: sk-zzz999888777666; trace 0123456789abcdef01234567';
      const out = redactProviderErrorText(raw);
      expect(out).not.toContain('sk-abcdef');
      expect(out).not.toContain('sk-zzz999');
      expect(out).not.toContain('0123456789abcdef01234567');
      expect(out).toContain('<redacted>');
    });

    it('ResolvedProviderContext carries no secret field by construction', async () => {
      server = await startBroker((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Broker must never include key material; even if it did, the parser
        // only copies the redacted field set below.
        res.end(JSON.stringify(resolvedBody({ secret_key: 'sk-should-never-propagate' })));
      });
      process.env[ENV] = SOCK;
      const result = await fetchOrgProviderResolution({ identity: 'agent@shizuha.com' });
      expect(result?.outcome).toBe('resolved');
      if (result?.outcome === 'resolved') {
        const json = JSON.stringify(result.context);
        expect(json).not.toContain('sk-should-never-propagate');
        expect(json).not.toContain('secret_key');
      }
    });
  });

  describe('cache key helper', () => {
    it('distinguishes orgs and credentials', () => {
      expect(orgProviderCacheKey('org-a', 'p', 'c', 'm')).not.toBe(orgProviderCacheKey('org-b', 'p', 'c', 'm'));
      expect(orgProviderCacheKey('org-a', 'p', 'c', 'm')).not.toBe(orgProviderCacheKey('org-a', 'p', 'c2', 'm'));
    });
  });
});
