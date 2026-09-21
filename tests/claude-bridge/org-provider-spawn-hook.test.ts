import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

import {
  resolveOrgProviderForSpawn,
} from '../../src/claude-bridge/index.js';
import {
  setProviderResolutionMetricsSink,
  type ProviderResolutionMetricsSink,
} from '../../src/auth/org-provider-resolver.js';

/**
 * HIVE-2166 slice 3 — the claude-bridge spawn-time org-provider resolution hook.
 * Contract under test: never throws (PLAT-879 no-crash-loop), fail-loud on
 * same-org invariant violations (redacted), silent null pre-cutover, and
 * resolved/unavailable outcomes logged without key material.
 */

function startBroker(body: unknown, status = 200): Promise<{ server: Server; socketPath: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    const socketPath = join(mkdtempSync(join(tmpdir(), 'orgprov-')), 'broker.sock');
    server.listen(socketPath, () => resolve({ server, socketPath }));
  });
}

const RESOLVED_BODY = {
  outcome: 'resolved',
  organization_id: 'org-a',
  cortex_provider_id: 'prov-1',
  cortex_key_ref: 'cred-1',
  provider_type: 'anthropic',
  base_url: 'https://cortex.example.internal/v1',
  model_id: 'glm-5.3-flash',
  metering_context_id: 'm-1',
  resolved_at: '2026-09-02T00:00:00Z',
  fallback_chain: [],
};

const UNAVAILABLE_BODY = { outcome: 'unavailable', reason: 'no_reference', message: 'no org provider reference' };

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

describe('resolveOrgProviderForSpawn (HIVE-2166 slice 3)', () => {
  const originalSocketEnv = process.env['MCP_AUTH_PROXY_SOCKET'];

  beforeEach(() => {
    setProviderResolutionMetricsSink(null);
  });

  afterEach(() => {
    if (originalSocketEnv === undefined) delete process.env['MCP_AUTH_PROXY_SOCKET'];
    else process.env['MCP_AUTH_PROXY_SOCKET'] = originalSocketEnv;
    setProviderResolutionMetricsSink(null);
    vi.restoreAllMocks();
  });

  it('resolves to null without throwing when no sidecar socket exists (pre-cutover inert)', async () => {
    // Point at a guaranteed-nonexistent socket (the established pattern from
    // tests/auth/org-provider-resolver.test.ts — deleting the env would fall
    // back to DEFAULT_BROKER_SOCKET).
    process.env['MCP_AUTH_PROXY_SOCKET'] = join(tmpdir(), `orgprov-missing-${process.pid}.sock`);
    const result = await resolveOrgProviderForSpawn({ identity: 'ni@shizuha.com', log: silentLog });
    expect(result).toBeNull();
  });

  it('returns the resolved context and logs without key material', async () => {
    const { server, socketPath } = await startBroker(RESOLVED_BODY);
    process.env['MCP_AUTH_PROXY_SOCKET'] = socketPath;
    const lines: string[] = [];
    const log = {
      info: (l: string) => lines.push(l),
      warn: () => {},
      error: () => {},
    };
    const result = await resolveOrgProviderForSpawn({
      identity: 'ni@shizuha.com',
      requestedModelId: 'glm-5.3-flash',
      log,
    });
    server.close();
    expect(result?.outcome).toBe('resolved');
    if (result?.outcome === 'resolved') {
      expect(result.context.organizationId).toBe('org-a');
      expect(result.context.cortexKeyRef).toBe('cred-1');
    }
    const joined = lines.join('\n');
    expect(joined).toContain('org-provider resolved');
    expect(joined).toContain('org=org-a');
    // Key-ref stays opaque in logs (the context field is never printed).
    expect(joined).not.toContain('cred-1');
  });

  it('logs the model override when the resolved model differs from the requested one', async () => {
    const { server, socketPath } = await startBroker({ ...RESOLVED_BODY, model_id: 'glm-5.3-air' });
    process.env['MCP_AUTH_PROXY_SOCKET'] = socketPath;
    const lines: string[] = [];
    const result = await resolveOrgProviderForSpawn({
      identity: 'ni@shizuha.com',
      requestedModelId: 'glm-5.3-flash',
      log: { info: (l: string) => lines.push(l), warn: () => {}, error: () => {} },
    });
    server.close();
    expect(result?.outcome).toBe('resolved');
    expect(lines.join('\n')).toContain('model-override=glm-5.3-air');
  });

  it('surfaces unavailable outcomes without throwing', async () => {
    const { server, socketPath } = await startBroker(UNAVAILABLE_BODY);
    process.env['MCP_AUTH_PROXY_SOCKET'] = socketPath;
    const warns: string[] = [];
    const result = await resolveOrgProviderForSpawn({
      identity: 'ni@shizuha.com',
      log: { info: () => {}, warn: (l: string) => warns.push(l), error: () => {} },
    });
    server.close();
    expect(result?.outcome).toBe('unavailable');
    expect(warns.join('\n')).toContain('reason=no_reference');
  });

  it('resolves to null (never throws) on malformed broker payloads', async () => {
    const { server, socketPath } = await startBroker('not-json{', 200);
    process.env['MCP_AUTH_PROXY_SOCKET'] = socketPath;
    const result = await resolveOrgProviderForSpawn({ identity: 'ni@shizuha.com', log: silentLog });
    server.close();
    expect(result).toBeNull();
  });

  it('resolves to null (never throws) when the broker errors or times out', async () => {
    const { server, socketPath } = await startBroker(RESOLVED_BODY, 500);
    process.env['MCP_AUTH_PROXY_SOCKET'] = socketPath;
    const result = await resolveOrgProviderForSpawn({ identity: 'ni@shizuha.com', log: silentLog });
    server.close();
    expect(result).toBeNull();
  });

  it('fires the fail-loud reporter on a same-org invariant violation and still resolves to null (pre-cutover)', async () => {
    // Cross-org fallback candidate in the broker response → the client's
    // assertSameOrgCandidates fires the reporter and rejects; the hook must
    // catch it, log redacted, and resolve to null (pre-cutover proceed).
    const crossOrg = {
      ...RESOLVED_BODY,
      fallback_chain: [
        { cortex_provider_id: 'prov-b', cortex_key_ref: 'cred-orgB', model_id: 'mb', organization_id: 'org-b' },
      ],
    };
    const { server, socketPath } = await startBroker(crossOrg);
    process.env['MCP_AUTH_PROXY_SOCKET'] = socketPath;
    const errors: string[] = [];
    const sink: ProviderResolutionMetricsSink = {
      incAttempt: () => {},
      incInvariantViolation: () => {},
    };
    setProviderResolutionMetricsSink(sink);
    const result = await resolveOrgProviderForSpawn({
      identity: 'ni@shizuha.com',
      log: { info: () => {}, warn: () => {}, error: (l: string) => errors.push(l) },
    });
    server.close();
    expect(result).toBeNull();
    expect(errors.join('\n')).toContain('PROVIDER ISOLATION VIOLATION');
    expect(errors.join('\n')).toContain('org-b');
    // The cortex_key_ref in the violation message is audit attribution, not a
    // secret (HIVE-1862 §3: resolve steps log (agent, org, provider, key_ref)
    // — "nothing secret"); the redaction contract targets auth headers and
    // token-like blobs, which the hook scrubs via redactProviderErrorText.
  });
});
