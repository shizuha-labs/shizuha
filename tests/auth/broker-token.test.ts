import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  brokerPresent,
  brokerSocketPath,
  fetchBrokerToken,
  fetchBrokerModelToken,
  reportBrokerModelTokenStatus,
} from '../../src/auth/broker-token.js';

// PLAT-169: the agent runtime fetches its shizuha-id JWT from the broker sidecar
// over a pod-local UDS (GET /token), instead of an in-container password login.

const ENV = 'MCP_AUTH_PROXY_SOCKET';
let _sockSeq = 0;
let SOCK = path.join(os.tmpdir(), `broker-test-${process.pid}-${Date.now()}.sock`);

function startBroker(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<http.Server> {
  // Unique socket per server so tests can never collide on a stale/closing socket.
  SOCK = path.join(os.tmpdir(), `broker-test-${process.pid}-${Date.now()}-${_sockSeq++}.sock`);
  return new Promise((resolve) => {
    if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
    const srv = http.createServer(handler);
    srv.listen(SOCK, () => resolve(srv));
  });
}

describe('broker-token', () => {
  let server: http.Server | null = null;
  const prev = process.env[ENV];

  afterEach(async () => {
    if (server) { await new Promise((r) => server!.close(() => r(null))); server = null; }
    if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
    if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev;
  });

  it('reports no broker when the socket is absent', () => {
    process.env[ENV] = SOCK; // points at a non-existent socket
    expect(brokerSocketPath()).toBeNull();
    expect(brokerPresent()).toBe(false);
  });

  it('returns null from fetchBrokerToken when no broker is present', async () => {
    // PLAT-4720: must not rely on `delete process.env[ENV]`.
    // brokerSocketPath() falls back to DEFAULT_BROKER_SOCKET
    // (/run/shizuha/mcp-auth-proxy/proxy.sock), which EXISTS on fleet-context
    // runners — so the ambient socket makes this assertion fail wherever the
    // sidecar is present. Point at an explicit absent path instead (same shape
    // as the unit above) so the test is green on clean CI Jobs AND fleet pods.
    process.env[ENV] = path.join(os.tmpdir(), `absent-broker-${process.pid}.sock`);
    expect(await fetchBrokerToken()).toBeNull();
  });

  it('fetches and parses the JWT from GET /token over the UDS', async () => {
    server = await startBroker((req, res) => {
      if (req.url === '/token' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access: 'jwt-from-broker', expires_at: '2026-06-08T12:00:00Z' }));
        return;
      }
      res.writeHead(404); res.end();
    });
    process.env[ENV] = SOCK;
    expect(brokerPresent()).toBe(true);
    const tok = await fetchBrokerToken();
    expect(tok).toEqual({ accessToken: 'jwt-from-broker', expiresAt: '2026-06-08T12:00:00Z' });
  });

  it('returns null when the broker is not ready (503 no session)', async () => {
    server = await startBroker((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no session yet' }));
    });
    process.env[ENV] = SOCK;
    expect(await fetchBrokerToken()).toBeNull();
  });

  it('returns null on a malformed body (no access field)', async () => {
    server = await startBroker((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nope: true }));
    });
    process.env[ENV] = SOCK;
    expect(await fetchBrokerToken()).toBeNull();
  });

  // HIVE-125: the Claude model token is delivered over the UDS at GET /model-token,
  // distinct from the shizuha-id JWT at /token.
  describe('fetchBrokerModelToken', () => {
    it('returns null when no broker is present', async () => {
      // PLAT-4720: same ambient-socket trap as fetchBrokerToken above.
      process.env[ENV] = path.join(os.tmpdir(), `absent-model-broker-${process.pid}.sock`);
      expect(await fetchBrokerModelToken()).toBeNull();
    });

    it('fetches the model token + label from GET /model-token (with provider query)', async () => {
      let seenUrl = '';
      server = await startBroker((req, res) => {
        seenUrl = req.url ?? '';
        if (req.url?.startsWith('/model-token') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            token: 'oat-from-broker',
            label: 'primary',
            entry_id: 'entry-1',
            lease_id: 'lease-1',
            expires_at: '2026-06-08T12:00:00Z',
          }));
          return;
        }
        res.writeHead(404); res.end();
      });
      process.env[ENV] = SOCK;
      const tok = await fetchBrokerModelToken('anthropic');
      expect(tok).toEqual({
        token: 'oat-from-broker',
        label: 'primary',
        entryId: 'entry-1',
        leaseId: 'lease-1',
        expiresAt: '2026-06-08T12:00:00Z',
      });
      expect(seenUrl).toBe('/model-token?provider=anthropic');
    });

    it('forwards refresh, preferred, exclusion, and sticky caller hints', async () => {
      let seenUrl = '';
      server = await startBroker((req, res) => {
        seenUrl = req.url ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token: 'access-only-bundle',
          label: 'primary',
          entry_id: 'entry-1',
          lease_id: 'lease-2',
          expires_at: '2026-06-08T12:00:00Z',
        }));
      });
      process.env[ENV] = SOCK;

      await expect(fetchBrokerModelToken('openai', 5000, {
        forceRefresh: true,
        preferredEntryId: 'entry-1',
        excludeEntryId: 'entry-exhausted',
        stickyKey: 'agent:sora',
      })).resolves.toMatchObject({
        token: 'access-only-bundle',
        entryId: 'entry-1',
        leaseId: 'lease-2',
      });
      expect(seenUrl).toBe(
        '/model-token?provider=openai&force_refresh=1&preferred_entry_id=entry-1&exclude_entry_id=entry-exhausted&sticky_key=agent%3Asora',
      );
    });

    it('returns null when the broker is not ready (503)', async () => {
      server = await startBroker((_req, res) => { res.writeHead(503); res.end(); });
      process.env[ENV] = SOCK;
      expect(await fetchBrokerModelToken()).toBeNull();
    });

    it('returns null on a malformed body (no token field)', async () => {
      server = await startBroker((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ label: 'x' }));
      });
      process.env[ENV] = SOCK;
      expect(await fetchBrokerModelToken()).toBeNull();
    });
  });

  describe('reportBrokerModelTokenStatus', () => {
    it('reports cooldown for a leased model token over the broker UDS', async () => {
      let seenBody = '';
      server = await startBroker((req, res) => {
        if (req.url === '/model-token/report-status' && req.method === 'POST') {
          req.on('data', (chunk) => { seenBody += String(chunk); });
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          });
          return;
        }
        res.writeHead(404); res.end();
      });
      process.env[ENV] = SOCK;
      await expect(reportBrokerModelTokenStatus(
        { entryId: 'entry-1', leaseId: 'lease-1' },
        { action: 'cool', cooldownSeconds: 600 },
      )).resolves.toBe(true);
      expect(JSON.parse(seenBody)).toEqual({
        entry_id: 'entry-1',
        lease_id: 'lease-1',
        action: 'cool',
        cooldown_seconds: 600,
      });
    });
  });
});
