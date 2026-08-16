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

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Metrics server listening');
  });

  server.on('error', (err) => {
    logger.warn({ err, port }, 'Metrics server error');
  });

  return server;
}
