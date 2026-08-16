/**
 * Hive-only gate for fleet management APIs (operator 2026-07-09).
 *
 * When FLEET_CONTROL_SECRET is set, lifecycle/config endpoints accept ONLY the
 * shared X-Fleet-Control-Secret header (held by Hive + the control/readonly
 * proxies). Session cookies, agent gateway tokens, device tokens, and the
 * localhost dashboard bypass are NOT sufficient — that stops kubectl-exec and
 * agent self-serve from becoming a second write path.
 *
 * Agent message / codex / discovery paths stay on the existing auth model.
 */

import * as crypto from 'node:crypto';

export const FLEET_CONTROL_SECRET_ENV = 'FLEET_CONTROL_SECRET';
export const FLEET_CONTROL_SECRET_HEADER = 'x-fleet-control-secret';

export function getFleetControlSecret(): string {
  return (process.env[FLEET_CONTROL_SECRET_ENV] ?? '').trim();
}

export function fleetControlSecretMatches(
  provided: string | string[] | undefined | null,
): boolean {
  const expected = getFleetControlSecret();
  if (!expected) return false;
  const raw = Array.isArray(provided) ? provided[0] : provided;
  const a = Buffer.from(String(raw ?? ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Fleet management surface that must be Hive-mediated when the control secret
 * is configured. Inter-agent message, health, and non-agent APIs are excluded.
 */
export function isHiveOnlyFleetEndpoint(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  const m = method.toUpperCase();

  // List/create collection
  if (path === '/v1/agents' || path === '/v1/agents/') {
    // GET list stays open for same-machine agent discovery (handled elsewhere).
    // POST create is Hive-only.
    return m === 'POST' || m === 'PUT' || m === 'DELETE';
  }

  if (path === '/v1/agents/toggle' || path === '/v1/agents/provision') {
    return m === 'POST';
  }

  if (path === '/v1/agents/activity-rates' || path === '/v1/agents/heartbeat-outcomes') {
    return m === 'GET';
  }

  if (path === '/v1/agents/claude-token-pressure') {
    // Bridges report pressure from containers; not a Hive config path.
    return false;
  }

  // /v1/agents/:id[...] 
  const agentRoot = /^\/v1\/agents\/([^/]+)(\/.*)?$/;
  const match = agentRoot.exec(path);
  if (!match) return false;
  const rest = match[2] ?? '';

  // Inter-agent message — not fleet config
  if (rest === '/message') return false;

  // Per-agent credentials are broker/platform surfaces, not Hive SoT config
  if (rest.startsWith('/credentials')) return false;

  // Lifecycle / config used by Hive control plane (GET single agent stays on normal auth)
  if (rest === '' || rest === '/') {
    return m === 'PATCH' || m === 'DELETE' || m === 'PUT';
  }

  const hiveControlSuffixes = [
    '/restart',
    '/restart-if-running',
    '/reset-session',
    '/pause',
    '/resume',
    '/kill-task',
    '/enable',
    '/disable',
    '/activity',
  ];
  if (hiveControlSuffixes.includes(rest)) {
    return m === 'POST' || m === 'GET';
  }

  return false;
}
