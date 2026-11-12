import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  XAI_LEASE_QUOTA_COOLDOWN_SECONDS,
  classifyHiveXaiLeaseFailure,
  failoverHiveXaiLease,
  leaseHiveXaiAccess,
} from '../../src/auth/xai-broker.js';
import { XaiDirectBudgetExceededError } from '../../src/provider/xai-direct-budget.js';

// CTX-5382: a SuperGrok account whose included usage is exhausted keeps 429ing
// for hours. The direct Hive path must cool that account long and move the seat
// to another pool account, not retry the sticky lease every turn.
describe('Hive xAI lease account failover', () => {
  it('classifies included-usage 429 and out-of-credit 403 as quota exhaustion', () => {
    const free = Object.assign(new Error('429 "You\'ve used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window"'), { status: 429 });
    expect(classifyHiveXaiLeaseFailure(free)).toEqual({ kind: 'quota_exhausted', cooldownSeconds: XAI_LEASE_QUOTA_COOLDOWN_SECONDS });
    const credits = Object.assign(new Error('403 Your team is out of credits'), { status: 403 });
    expect(classifyHiveXaiLeaseFailure(credits)?.kind).toBe('quota_exhausted');
    const plain = Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    expect(classifyHiveXaiLeaseFailure(plain)).toEqual({ kind: 'rate_limited', cooldownSeconds: 60 });
    // Our own per-seat breaker is not an account failure — never fail over on it.
    expect(classifyHiveXaiLeaseFailure(new XaiDirectBudgetExceededError('total', 41_000_000, 40_000_000, Date.now() + 60_000))).toBeNull();
    expect(classifyHiveXaiLeaseFailure(Object.assign(new Error('boom'), { status: 500 }))).toBeNull();
    expect(classifyHiveXaiLeaseFailure(Object.assign(new Error('Forbidden'), { status: 403 }))).toBeNull();
  });

  describe('against a fake broker UDS', () => {
    let dir: string;
    let server: http.Server;
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const prev = process.env['MCP_AUTH_PROXY_SOCKET'];
    let entries: string[] = ['entry-a', 'entry-b'];

    beforeEach(async () => {
      seen.length = 0;
      entries = ['entry-a', 'entry-b'];
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xai-broker-'));
      const sock = path.join(dir, 'proxy.sock');
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          seen.push({ method: req.method || '', url: req.url || '', body });
          if (req.url?.startsWith('/model-token')) {
            const q = new URL(req.url, 'http://x').searchParams;
            const pick = entries.find((e) => e !== q.get('exclude_entry_id'));
            if (!pick) { res.statusCode = 503; res.end('{}'); return; }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              token: JSON.stringify({ auth_mode: 'xaiAccessToken', access_token: `tok.${pick}.sig`, email: `${pick}@example.com`, account_id: pick }),
              label: `${pick}@example.com`, entry_id: pick, lease_id: `lease-${pick}`,
            }));
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end('{}');
        });
      });
      await new Promise<void>((r) => server.listen(sock, r));
      process.env['MCP_AUTH_PROXY_SOCKET'] = sock;
    });

    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env['MCP_AUTH_PROXY_SOCKET'];
      else process.env['MCP_AUTH_PROXY_SOCKET'] = prev;
    });

    it('cools the exhausted account for the quota window and leases a different one', async () => {
      const first = await leaseHiveXaiAccess({ stickyKey: 'agent:riku' });
      expect(first?.token.entryId).toBe('entry-a');
      const next = await failoverHiveXaiLease(first!, { kind: 'quota_exhausted', cooldownSeconds: XAI_LEASE_QUOTA_COOLDOWN_SECONDS }, 'agent:riku');
      expect(next?.token.entryId).toBe('entry-b');
      const report = seen.find((s) => s.url === '/model-token/report-status');
      expect(report?.method).toBe('POST');
      expect(JSON.parse(report!.body)).toEqual({
        entry_id: 'entry-a', lease_id: 'lease-entry-a', action: 'cool',
        cooldown_seconds: XAI_LEASE_QUOTA_COOLDOWN_SECONDS, reason: 'quota_exhausted',
      });
      const relet = seen.filter((s) => s.url.startsWith('/model-token?')).pop()!;
      const q = new URL(relet.url, 'http://x').searchParams;
      expect(q.get('exclude_entry_id')).toBe('entry-a');
      expect(q.get('sticky_key')).toBe('agent:riku');
    });

    it('returns null when no other pool account is routable', async () => {
      entries = ['entry-a'];
      const first = await leaseHiveXaiAccess({ stickyKey: 'agent:riku' });
      const next = await failoverHiveXaiLease(first!, { kind: 'rate_limited', cooldownSeconds: 60 }, 'agent:riku');
      expect(next).toBeNull();
      expect(seen.some((s) => s.url === '/model-token/report-status')).toBe(true);
    });
  });
});
