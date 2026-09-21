/**
 * SCLI-74: Dedicated Prometheus metrics server on port 9103.
 * Spawned by gateway mode so Prometheus can scrape each agent container.
 */
import * as http from 'node:http';
import { renderMetrics } from './registry.js';
import { logger } from '../utils/logger.js';

export function startMetricsServer(port = 9103): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        const body = await renderMetrics();
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  // SCLI-535: the fixed default port (9103) can already be held by another
  // process (e.g. a primary gateway when a codex-bridge secondary spawns).
  // Instead of emitting a raw EADDRINUSE stack and then running WITHOUT its own
  // listener, bump the port and retry (bounded) so this process still gets a
  // scrape endpoint. If every retry is exhausted, log a concise warning and
  // continue without metrics — never a raw stack, never a crash.
  const MAX_RETRIES = 5;
  const attemptListen = (p: number, retries: number): void => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        logger.warn({ port: p }, 'Metrics port in use — retrying on next port');
        attemptListen(p + 1, retries - 1);
      } else if (err.code === 'EADDRINUSE') {
        logger.warn({ port: p }, 'Metrics port in use — running without a metrics listener');
      } else {
        logger.warn({ err, port: p }, 'Metrics server error');
      }
    });
    server.listen(p, '0.0.0.0', () => {
      logger.info({ port: p }, 'Metrics server listening');
    });
  };

  attemptListen(port, MAX_RETRIES);

  return server;
}
