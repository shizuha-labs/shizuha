import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

import { startDashboardTcpProxy } from '../../src/daemon/dashboard.js';

// SCLI-848 — the daemon serves the dashboard on localhost (binds [::1] by
// default) and a TCP relay on 127.0.0.1:8016 for IPv4-only clients. The
// relay is transport-only: it must not inject the bridge header, because
// the auth hook reads that header as proof of container-originated traffic
// and skips the localhost bypass. A relay that stamps the header turns a
// genuine localhost request into an "agent container" request, and any
// route guarded by the auth check fails with 401 even though the caller is
// the human user on the same machine.

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

describe('loopback alias relay (SCLI-848)', () => {
  it('loopback alias forwards /v1/voice/s2s like [::1] — without the bridge header; the Docker gateway default keeps it', async () => {
    const seen: Array<{ url: string | undefined; bridge: boolean }> = [];

    const upstream = http.createServer((req, res) => {
      seen.push({
        url: req.url,
        bridge: req.headers['x-shizuha-dashboard-bridge'] !== undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transport: 's2s', served: true }));
    });
    const upstreamPort = await listen(upstream);

    // Loopback alias (SCLI-832): transport-only relay — must NOT stamp the
    // bridge header, or the auth hook strips the localhost bypass.
    const alias = await startDashboardTcpProxy({
      listenHost: '127.0.0.1',
      port: 0,
      targetHost: '127.0.0.1',
      targetPort: upstreamPort,
      markAsBridge: false,
    });
    expect(alias).toBeTruthy();
    expect(alias.port).toBeGreaterThan(0);

    const served = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${alias.port}/v1/voice/s2s`, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        })
        .on('error', reject);
    });
    expect(served.status).toBe(200); // same as [::1]
    expect(JSON.parse(served.body)).toMatchObject({ ok: true, transport: 's2s' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/v1/voice/s2s');
    expect(seen[0].bridge).toBe(false);

    // Default relay (Docker gateway alias): keeps the bridge header.
    const gateway = await startDashboardTcpProxy({
      listenHost: '127.0.0.1',
      port: 0,
      targetHost: '127.0.0.1',
      targetPort: upstreamPort,
    });
    const stamped = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${gateway.port}/v1/voice/s2s`, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        })
        .on('error', reject);
    });
    expect(stamped.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1].bridge).toBe(true);

    alias.server.close();
    gateway.server.close();
    upstream.close();
  });
});
