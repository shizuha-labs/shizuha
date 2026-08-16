/**
 * Broker token client (PLAT-169) — fetch the agent's shizuha-id JWT from the
 * per-agent broker sidecar (PLAT-149 `mcp-auth-proxy`) over its pod-local Unix
 * Domain Socket.
 *
 * In k3s-native fleet pods, `AGENT_PASSWORD` lives ONLY inside the broker
 * sidecar. The sidecar mints/refreshes the shizuha-id JWT and serves the current
 * access token over `GET /token` on a shared UDS, gated by SO_PEERCRED to the
 * agent's UID. The agent runtime fetches the token from here instead of doing an
 * in-container username/password login — so the crown-jewel password never
 * enters the agent container.
 *
 * Detection is by socket presence: the provisioner mounts the shared volume and
 * the sidecar creates the socket there, so DinD agents (which have neither) fall
 * through to the legacy password path in the callers. Token bytes are never
 * logged here.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';

/** Default UDS path the broker serves on (matches the sidecar's MCP_AUTH_PROXY_SOCKET default). */
const DEFAULT_BROKER_SOCKET = '/run/shizuha/mcp-auth-proxy/proxy.sock';

export interface BrokerToken {
  accessToken: string;
  /** ISO timestamp parsed from the broker's `expires_at`; empty if not reported. */
  expiresAt: string;
}

/** A provider MODEL token (e.g. the Claude/Anthropic OAuth token) delivered by the
 *  broker over the UDS — distinct from the shizuha-id JWT served at `/token`. */
export interface BrokerModelToken {
  token: string;
  /** Pool label the coordinator picked, for rotation reporting; empty if absent. */
  label: string;
  /** Coordinator TokenEntry id bound to the broker lease. */
  entryId: string;
  /** Coordinator lease id required to report status for this token. */
  leaseId: string;
  /** ISO timestamp from the broker's `expires_at`; empty if not reported. */
  expiresAt: string;
}

export interface BrokerModelTokenFetchOptions {
  /** Ask Hive to rotate the canonical provider access token before leasing it. */
  forceRefresh?: boolean;
  /** Prefer the currently leased entry so a 401 refresh stays on the same account. */
  preferredEntryId?: string;
  /** Exclude the current unusable lease when deliberately rotating accounts. */
  excludeEntryId?: string;
  /** Stable caller identity used by Hive's per-agent token-pool pinning. */
  stickyKey?: string;
}

/**
 * Resolve the broker UDS path if a broker sidecar is present, else null.
 * Honors an explicit `MCP_AUTH_PROXY_SOCKET` override (same env the sidecar
 * reads), otherwise checks the default path. Returns null when the socket does
 * not exist so callers transparently use their legacy auth path.
 */
export function brokerSocketPath(): string | null {
  const explicit = process.env['MCP_AUTH_PROXY_SOCKET'];
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  return fs.existsSync(DEFAULT_BROKER_SOCKET) ? DEFAULT_BROKER_SOCKET : null;
}

/** True when a per-agent broker sidecar UDS is present (socket file exists) in this pod. */
export function brokerPresent(): boolean {
  return brokerSocketPath() !== null;
}

/**
 * True when broker mode is CONFIGURED (expected), even if the socket isn't bound
 * yet. The provisioner injects `MCP_AUTH_PROXY_SOCKET` in broker mode, so its
 * presence means "a broker sidecar is coming up" during the pod-boot race —
 * before the sidecar has created the UDS. Callers use this (not brokerPresent)
 * to decide whether to RETRY/await the broker rather than fall back to the
 * password path, so the earliest boot-race window (socket-not-bound-yet) is
 * covered. Falls back to brokerPresent() for the default-path case where no env
 * is set but a socket already exists.
 */
export function brokerExpected(): boolean {
  return !!process.env['MCP_AUTH_PROXY_SOCKET'] || brokerPresent();
}

/**
 * GET /token over the broker UDS. Resolves the current JWT, or null if the
 * broker is absent, not ready yet (503), rejects the peer (401), or errors.
 * Never logs or surfaces token bytes.
 */
export function fetchBrokerToken(timeoutMs = 5000): Promise<BrokerToken | null> {
  const socketPath = brokerSocketPath();
  if (!socketPath) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath, path: '/token', method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              access?: string;
              expires_at?: string;
            };
            if (!body.access) {
              resolve(null);
              return;
            }
            resolve({ accessToken: body.access, expiresAt: body.expires_at ?? '' });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * GET /model-token over the broker UDS (HIVE-125). The broker fetches the current
 * provider model token from the Coordinator (`GET /model-token?provider=…`) and
 * serves it here so the agent runtime never bakes a static `CLAUDE_CODE_OAUTH_TOKEN`
 * into its container env. Resolves the token, or null if the broker is absent /
 * not ready / has no token — callers then fall back to the env token (headless dev
 * only). Never logs token bytes.
 */
export function fetchBrokerModelToken(
  provider = 'anthropic',
  timeoutMs = 5000,
  options: BrokerModelTokenFetchOptions = {},
): Promise<BrokerModelToken | null> {
  const socketPath = brokerSocketPath();
  if (!socketPath) return Promise.resolve(null);
  const query = new URLSearchParams({ provider });
  if (options.forceRefresh) query.set('force_refresh', '1');
  if (options.preferredEntryId) query.set('preferred_entry_id', options.preferredEntryId);
  if (options.excludeEntryId) query.set('exclude_entry_id', options.excludeEntryId);
  if (options.stickyKey) query.set('sticky_key', options.stickyKey);
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: `/model-token?${query.toString()}`,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              token?: string;
              label?: string;
              entry_id?: string;
              lease_id?: string;
              expires_at?: string;
            };
            if (!body.token) {
              resolve(null);
              return;
            }
            resolve({
              token: body.token,
              label: body.label ?? '',
              entryId: body.entry_id ?? '',
              leaseId: body.lease_id ?? '',
              expiresAt: body.expires_at ?? '',
            });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

export function reportBrokerModelTokenStatus(
  token: Pick<BrokerModelToken, 'entryId' | 'leaseId'>,
  opts: { action?: 'cool' | 'deactivate'; cooldownSeconds?: number } = {},
  timeoutMs = 5000,
): Promise<boolean> {
  const socketPath = brokerSocketPath();
  if (!socketPath || !token.entryId || !token.leaseId) return Promise.resolve(false);
  const body = JSON.stringify({
    entry_id: token.entryId,
    lease_id: token.leaseId,
    action: opts.action ?? 'cool',
    ...(opts.cooldownSeconds ? { cooldown_seconds: opts.cooldownSeconds } : {}),
  });
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: '/model-token/report-status',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(!!res.statusCode && res.statusCode >= 200 && res.statusCode < 300));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}
