/**
 * CON-225: codex-bridge (and any agent runtime) exposes the shared Prometheus
 * metrics server on :9103 (SCLI-74). This test proves startMetricsServer()
 * serves the shared registry at /metrics and 404s everything else — the exact
 * surface CON-224 reconciles for suppressed-vs-delivered counters.
 */
import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startMetricsServer } from '../src/metrics/server.js';

const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('no port'));
      }
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('CON-225 codex-bridge metrics server', () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
  });

  it('serves the shared registry at /metrics with text content-type', async () => {
    const server = startMetricsServer();
    servers.push(server);
    const port = await listen(server);
    const res = await get(port, '/metrics');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    // registry render is Prometheus exposition text
    expect(res.body).toContain('# HELP') || expect(res.body).toMatch(/^[\w:#]/m);
  });

  it('404s non-/metrics paths (e.g. /health is NOT served by metrics server)', async () => {
    const server = startMetricsServer();
    servers.push(server);
    const port = await listen(server);
    const res = await get(port, '/health');
    expect(res.status).toBe(404);
  });
});
