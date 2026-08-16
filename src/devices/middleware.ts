import type { FastifyRequest, FastifyReply } from 'fastify';
import { findDeviceByTokenHash, updateLastSeen, listDevices } from './store.js';
import { hashToken } from './pairing.js';

function isLocalhost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Paths that never require auth
const PUBLIC_PATHS = new Set([
  '/health',
  '/manifest.json',
  '/sw.js',
]);

// Paths that only need to be accessible for pairing
const PAIRING_PATHS = new Set([
  '/v1/devices/pair',
  '/v1/devices/status',
]);

export function createDeviceAuthHook() {
  return async function deviceAuthHook(request: FastifyRequest, reply: FastifyReply) {
    const url = request.url.split('?')[0]!;

    // Always allow public paths
    if (PUBLIC_PATHS.has(url)) return;

    // Always allow pairing endpoint (it has its own code validation)
    if (PAIRING_PATHS.has(url)) return;

    // Always allow static assets (non-API paths serve the SPA)
    if (!url.startsWith('/v1/')) return;

    // Localhost bypass — same-machine CLI/browser is trusted
    const ip = request.ip || (request.socket?.remoteAddress ?? '');
    if (isLocalhost(ip)) return;

    // No zero-device bypass for remote clients — they must always pair.
    // Localhost is already bypassed above, so first-time setup works locally.
    // Code generation endpoint is localhost-only
    if (url === '/v1/devices/code') {
      reply.status(403).send({ error: 'Code generation is only available from localhost' });
      return;
    }

    // Check Bearer token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Device not paired. Enter a pairing code to connect.' });
      return;
    }

    const token = authHeader.slice(7);
    const hash = hashToken(token);
    const device = findDeviceByTokenHash(hash);

    if (!device) {
      reply.status(401).send({ error: 'Invalid or revoked device token' });
      return;
    }

    // Update last seen (debounced — skip if within 60s)
    const now = Date.now();
    if (now - device.lastSeenAt > 60_000) {
      updateLastSeen(device.deviceId, now, ip);
    }

    // Attach device info to request for downstream use
    (request as any).deviceId = device.deviceId;
  };
}
