/**
 * HIVE-586: stateless Codex token broker.
 *
 * The host daemon no longer owns an OAuth refresh token or a refresh loop.
 * Every request is leased from Hive's Token Coordinator, which is the sole
 * refresh and persistence authority.  The dashboard keeps the legacy
 * GET /v1/codex/token contract for older container clients, but this module
 * never reads or writes ~/.shizuha/credentials.json.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

type CoordinatorTokenResponse = {
  token?: unknown;
};

export function coordinatorOpenAiAccessToken(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const access = parsed.access_token ?? parsed.accessToken;
    return typeof access === 'string' && access ? access : null;
  } catch {
    // Backward compatibility for coordinators that served a bare access token.
    return raw;
  }
}

function coordinatorBearerToken(): string {
  const configured = process.env['MCP_AUTH_PROXY_COORDINATOR_TOKEN']?.trim();
  if (configured) return configured;

  const tokenFile = process.env['MCP_AUTH_PROXY_COORDINATOR_TOKEN_FILE']
    || path.join(process.env['HOME'] || '/home/phoenix', '.shizuha', 'mcp-auth-proxy', 'coordinator-token.txt');
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Lease a current OpenAI access token from Hive.
 *
 * The optional email argument is retained at the dashboard route for wire
 * compatibility, but account selection belongs exclusively to Hive's pool.
 */
export async function getCodexBrokerToken(_email?: string): Promise<string | null> {
  const coordinatorUrl = process.env['MCP_AUTH_PROXY_COORDINATOR_URL']?.trim();
  const bearerToken = coordinatorBearerToken();
  if (!coordinatorUrl || !bearerToken) {
    logger.warn('[codex-broker] Hive coordinator unavailable');
    return null;
  }

  try {
    const response = await fetch(coordinatorUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ provider: 'openai' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, '[codex-broker] Hive lease failed');
      return null;
    }

    const payload = await response.json() as CoordinatorTokenResponse;
    const accessToken = coordinatorOpenAiAccessToken(payload.token);
    if (!accessToken) {
      logger.warn('[codex-broker] Hive lease returned no token');
      return null;
    }
    return accessToken;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[codex-broker] Hive lease error');
    return null;
  }
}
