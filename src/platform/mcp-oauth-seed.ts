/**
 * MCP OAuth seeding for Claude Code (cli) agents.
 *
 * Background: Claude Code caches the static `Authorization` bearer from
 * `.mcp.json` at MCP-connect time and never refreshes it. A long-lived agent
 * session therefore outlives its 60-minute shizuha-id access token and every
 * MCP tool call 401s in the response body (the in-session token-staleness bug).
 *
 * Fix (generic, standards-based): let Claude Code's NATIVE MCP OAuth client own
 * the token lifecycle. When a platform MCP server enforces bearer auth
 * (SHIZUHA_MCP_OAUTH_ENFORCE=true), FastMCP returns a transport-level 401 +
 * `WWW-Authenticate: Bearer resource_metadata=...` on an expired/missing token.
 * Claude Code's `ClaudeAuthProvider` then refreshes via the authorization
 * server (shizuha-id) using a stored refresh token and retries — with no human
 * and no browser. This is exactly how it would handle any third-party OAuth MCP
 * server.
 *
 * Two things make that engage:
 *   1. The `.mcp.json` entry must NOT carry a static `Authorization` header
 *      (Claude Code merges config headers AFTER the OAuth token, so a static
 *      header overrides — and defeats — the OAuth path). We strip it.
 *   2. Claude Code needs seeded OAuth credentials in its secure storage
 *      (`{HOME}/.claude/.credentials.json` → `mcpOAuth[serverKey]`), because
 *      the interactive authorization-code flow is browser-based and agents are
 *      headless. We mint them here via the password grant against shizuha-id's
 *      OAuth token endpoint, using the existing public `shizuha-claude-code`
 *      client and the agent's own credentials.
 *
 * Refresh-token ROTATION (shizuha-id has ROTATE_REFRESH_TOKENS=True) means each
 * server entry must hold its OWN refresh token — a shared one would be
 * invalidated by the first server that refreshes. So we mint one grant per
 * service.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default public OAuth client registered in shizuha-id for the agent fleet. */
const FLEET_CLIENT_ID = 'shizuha-claude-code';

/** HTTP/SSE MCP entry — the only shape OAuth seeding applies to. */
export interface McpEntry {
  type: 'sse' | 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Stdio MCP entry (e.g. the local reconnecting proxy, PLAT-504/PLAT-427). OAuth
 * seeding does not apply to stdio servers — `seedMcpOAuthCredentials` skips them
 * via the `type` discriminant. Modelled with `type?: undefined` so a
 * `McpEntry | McpStdioEntry` union discriminates cleanly on `type`.
 */
export interface McpStdioEntry {
  type?: undefined;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Replicates Claude Code's `getServerKey` EXACTLY
 * (vendor src/services/mcp/auth.ts): sha256 over a `{type,url,headers}` object
 * serialized with plain JSON.stringify (key order type→url→headers), first 16
 * hex chars, prefixed with `${serverName}|`. Must match byte-for-byte or the
 * seeded credentials won't be found.
 */
export function mcpServerKey(serverName: string, entry: McpEntry): string {
  const configJson = JSON.stringify({
    type: entry.type,
    url: entry.url,
    headers: entry.headers || {},
  });
  const hash = createHash('sha256').update(configJson).digest('hex').substring(0, 16);
  return `${serverName}|${hash}`;
}

/** Parse SHIZUHA_MCP_OAUTH_SERVICES into a predicate. `*` = all services. */
export function oauthServiceMatcher(raw: string | undefined): (svc: string) => boolean {
  const v = (raw ?? '').trim();
  if (!v) return () => false;
  if (v === '*') return () => true;
  const set = new Set(v.split(',').map((s) => s.trim()).filter(Boolean));
  return (svc: string) => set.has(svc);
}

/** One OAuth token grant (password grant) against shizuha-id. */
async function passwordGrant(
  platformBase: string,
  username: string,
  password: string,
  clientId: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope?: string } | null> {
  const url = `${platformBase.replace(/\/+$/, '')}/id/api/oauth/token`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: clientId,
        username,
        password,
        scope: '*',
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!data.access_token || !data.refresh_token) return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in ?? 3600,
      scope: data.scope ?? '*',
    };
  } catch {
    return null;
  }
}

export interface SeedResult {
  /** serverKey → entry, ready to merge into `.credentials.json` `mcpOAuth`. */
  mcpOAuth: Record<string, unknown>;
  /** Service names successfully seeded. */
  seeded: string[];
}

/**
 * For every OAuth-enabled platform MCP entry in `mcpServers`:
 *   - strip its static `Authorization` header (mutates the entry in place), and
 *   - mint an independent OAuth grant and build its `mcpOAuth[serverKey]` seed.
 *
 * Then writes the merged credentials to `{homeDir}/.claude/.credentials.json`.
 * Entries for non-OAuth services are left untouched (keep their static header).
 */
export async function seedMcpOAuthCredentials(opts: {
  mcpServers: Record<string, McpEntry | McpStdioEntry>;
  homeDir: string;
  agentUsername: string;
  agentPassword: string;
  platformBase: string;
  isOAuthService: (svc: string) => boolean;
  clientId?: string;
  log?: (msg: string) => void;
}): Promise<SeedResult> {
  const clientId = opts.clientId ?? FLEET_CLIENT_ID;
  const log = opts.log ?? (() => {});
  const mcpOAuth: Record<string, unknown> = {};
  const seeded: string[] = [];

  if (!opts.agentPassword) {
    log('MCP OAuth seed: no agent password available — cannot mint OAuth tokens; leaving static headers');
    return { mcpOAuth, seeded };
  }

  for (const [key, entry] of Object.entries(opts.mcpServers)) {
    // Only platform services named `shizuha-<svc>`.
    const m = /^shizuha-([a-z]+)$/.exec(key);
    if (!m) continue;
    const svc = m[1]!;
    if (!opts.isOAuthService(svc)) continue;
    if (entry.type !== 'http' && entry.type !== 'sse') continue;

    const grant = await passwordGrant(opts.platformBase, opts.agentUsername, opts.agentPassword, clientId);
    if (!grant) {
      log(`MCP OAuth seed: grant failed for ${svc} — leaving static header on ${key}`);
      continue;
    }

    // Strip the static Authorization header so Claude Code's OAuth provider
    // engages. headers MUST become {} BEFORE computing the serverKey, since the
    // key hashes the (now empty) headers.
    entry.headers = {};
    const serverKey = mcpServerKey(key, entry);

    mcpOAuth[serverKey] = {
      serverName: key,
      serverUrl: entry.url,
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      // expiresAt is epoch MILLIS in Claude Code's store.
      expiresAt: Date.now() + grant.expires_in * 1000,
      scope: grant.scope ?? '*',
      clientId,
    };
    seeded.push(svc);
  }

  if (seeded.length > 0) {
    const claudeDir = path.join(opts.homeDir, '.claude');
    const credPath = path.join(claudeDir, '.credentials.json');
    let existing: Record<string, unknown> = {};
    try {
      if (fs.existsSync(credPath)) existing = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    } catch { /* start fresh */ }
    const mergedMcpOAuth = { ...((existing.mcpOAuth as Record<string, unknown>) ?? {}), ...mcpOAuth };
    const merged = { ...existing, mcpOAuth: mergedMcpOAuth };
    try {
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(credPath, JSON.stringify(merged, null, 2), { encoding: 'utf-8' });
      fs.chmodSync(credPath, 0o600);
      log(`MCP OAuth seed: seeded ${seeded.length} services [${seeded.join(', ')}] → ${credPath}`);
    } catch (err) {
      log(`MCP OAuth seed: failed to write credentials: ${(err as Error).message}`);
    }
  }

  return { mcpOAuth, seeded };
}
