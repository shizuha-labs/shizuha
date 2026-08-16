/**
 * Platform MCP Service Registry
 *
 * Central registry of all platform services that expose an MCP HTTP endpoint.
 * Bridges (claude, gemini, codex, openclaw) call `getPlatformMcpConfigs(...)`
 * to get ready-to-use MCP server entries for their config files.
 *
 * Authentication is the *caller's* job — pass in a bearer token obtained from
 * shizuha-id (`AgentTokenManager.getToken()` or the daemon-provisioned
 * `AGENT_ACCESS_TOKEN` env var). This module no longer mints JWTs locally;
 * shizuha-id is the single signer and source of truth for agent identity.
 */

import * as fs from 'node:fs';

/** A platform service that exposes an MCP SSE / Streamable HTTP endpoint. */
export interface PlatformMcpService {
  /** Service name (used as mcp server key: `shizuha-{name}`) */
  name: string;
  /** Host-published HTTP port (used in local mode) */
  port: number;
}

/**
 * All platform services with MCP HTTP endpoints. Add a service here and every
 * bridge picks it up automatically.
 */
export const PLATFORM_MCP_SERVICES: PlatformMcpService[] = [
  { name: 'pulse',     port: 18101 },
  { name: 'id',        port: 18102 },
  { name: 'admin',     port: 18103 },
  { name: 'notes',     port: 18104 },
  { name: 'wiki',      port: 18105 },
  { name: 'drive',     port: 18106 },
  // Hive — agent/claw lifecycle management via MCP tools (HIVE-435). Standalone
  // MCP daemon (own image), unlike the sidecar-in-backend services above; the
  // shizuha-hive-mcp Deployment/Service lives in ns `shizuha` and proxies to the
  // Hive backend in ns `shizuha-hive`. Port 18107 sits in the drive/connect gap.
  { name: 'hive',      port: 18107 },
  // Connect — messaging, conversations, and `message_user` (agents push
  // direct messages to any platform user via Connect, regardless of what
  // triggered the current turn).
  { name: 'connect',   port: 18108 },
  { name: 'finance',   port: 18109 },
  { name: 'books',     port: 18110 },
  // hr (18111) and time (18112) are PURPOSELY DECOMMISSIONED (operator
  // directive 2026-07-02, never restore) — keeping them here made every agent
  // retry-loop dead 405 endpoints forever. Do not re-add.
  { name: 'inventory', port: 18113 },
  { name: 'mail',      port: 18114 },
  // SCS — Shizuha Cloud Services (revived 2026-07-11 as the apps-estate home):
  // app hosting on <slug>.apps.shizuha.com (scs_deploy_app et al) + compute
  // jobs. Sidecar-in-backend like pulse/wiki: MCP served by the shizuha-scs
  // pod itself on 18115 (the retired hr/time ports stay untouched).
  { name: 'scs',       port: 18115 },
];

const RETIRED_PLATFORM_MCP_KEYS = new Set([
  'shizuha-cron',
  'shizuha-hr',
  'shizuha-time',
]);

/**
 * MCP server config entry (matches Claude Code / Codex .mcp.json format).
 *
 * Three shapes:
 *   - HTTP/SSE form: `{ type, url, headers }` — the default; claude-code talks
 *     directly to the remote streamable-HTTP MCP endpoint.
 *   - Stdio-proxy form: `{ command, args, env }` — emitted when the
 *     `SHIZUHA_MCP_STDIO_PROXY` flag selects the service. claude-code talks to a
 *     local stdio `mcp-proxy` process (which never drops, so tools stay
 *     registered) and the proxy owns + transparently reconnects the upstream
 *     HTTP connection. Permanent fix for the print-mode no-reconnect bug
 *     (PLAT-504/PLAT-427).
 *   - Multiplexer form: `{ command, args, env }` — emitted when the
 *     `SHIZUHA_MCP_MULTIPLEXER` flag is set. A SINGLE stdio process replaces
 *     N separate mcp-proxy processes, reducing CPU and process count (PLAT-3119).
 *     The multiplexer internally manages connections to all allowed upstream
 *     services and routes tool calls by name prefix.
 */
export type McpServerEntry = McpHttpServerEntry | McpStdioServerEntry | McpMultiplexerServerEntry;

/** HTTP/SSE entry — direct connection to the remote MCP endpoint. */
export interface McpHttpServerEntry {
  type: 'sse' | 'http';
  url: string;
  headers: Record<string, string>;
}

/** Stdio entry — a local command claude-code spawns (here: the reconnecting proxy). */
export interface McpStdioServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Multiplexer entry — a SINGLE stdio process that replaces N separate
 * mcp-proxy processes. The multiplexer internally manages connections to
 * all upstream services and routes tool calls by name prefix (PLAT-3119).
 */
export interface McpMultiplexerServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface PlatformMcpConfigOptions {
  /**
   * Bearer JWT obtained from shizuha-id. Caller must obtain this themselves —
   * either from `AGENT_ACCESS_TOKEN` (daemon-provisioned) or by calling
   * `AgentTokenManager.getToken()`. No fallback minting happens here.
   */
  bearerToken: string;
  /**
   * Absolute path to a file holding the CURRENT bearer JWT, kept rewritten by
   * the bridge ahead of token expiry. When set, the stdio `mcp-proxy` entries
   * get `MCP_UPSTREAM_BEARER_FILE` and the proxy reads the token FRESH from this
   * file on every (re)connect — so a refreshed token takes effect in-process
   * without restarting the long-lived proxy (fixes the 24h token cliff). The
   * spawn-time `MCP_UPSTREAM_BEARER` env stays as the seed/fallback.
   */
  bearerTokenFile?: string;
  /**
   * Backend host. Resolution order: explicit opt > PLATFORM_HOST env >
   * hostname extracted from SHIZUHA_PLATFORM_URL > DAEMON_HOST > localhost.
   */
  mcpHost?: string;
  /**
   * Full backend URL (e.g. https://s1.tail.shizuha.com). Used to build remote
   * `/mcp/{service}/mcp` paths. Defaults to SHIZUHA_PLATFORM_URL env.
   */
  platformUrl?: string;
  /**
   * Explicit org scope for every platform MCP request. Highest-priority
   * override; otherwise we resolve from env/JWT when unambiguous.
   */
  organizationId?: string | number;
  /**
   * Optional per-agent allow-list of platform service NAMES (e.g.
   * `['pulse','wiki','connect']`). When set, only these platform MCP servers
   * are configured; everything else is omitted (default-deny within the
   * platform set). Unset → all services. Defaults to the comma-separated
   * `SHIZUHA_MCP_SERVICES` env var. Scopes the turn-1 tool surface to keep
   * input context small on weak/large-context models (SCLI-64).
   */
  allowList?: string[];
  /**
   * Opt-in selector for the local stdio reconnecting MCP proxy
   * (PLAT-504/PLAT-427). When a service is selected, its entry is emitted in
   * the stdio-proxy form (`{command,args,env}`) instead of the direct HTTP
   * form, so claude-code talks to a local pipe that never drops and the proxy
   * owns + transparently reconnects the upstream. Resolution (see
   * `resolveStdioProxyServices`): this opt > `SHIZUHA_MCP_STDIO_PROXY` env.
   * Accepts `1`/`true`/`*`/`all` (all services) or a comma-list of service
   * names. Default ON — every service uses the stdio reconnecting proxy
   * (PLAT-504). Opt out with `0`/`false`/`off`/`no` (or set
   * `SHIZUHA_MCP_STDIO_PROXY=off`). This is the correct default because
   * print-mode claude-code never reconnects raw `type:http` MCP after a
   * backend restart; the proxy makes that transparent.
   */
  stdioProxy?: string;
  /**
   * Opt-in for the per-agent MCP multiplexer (PLAT-3119). When set, a SINGLE
   * stdio `mcp-multiplexer` process replaces N separate `mcp-proxy` processes,
   * reducing CPU and process count. The multiplexer internally manages
   * connections to all allowed upstream services and routes tool calls by
   * name prefix (`{service}__{tool}`).
   *
   * Resolution: this opt > `SHIZUHA_MCP_MULTIPLEXER` env.
   * Accepts `1`/`true`/`on`/`yes` to enable, `0`/`false`/`off`/`no` to disable.
   * Default: OFF (uses the existing per-service stdio proxy model).
   * When enabled, `stdioProxy` is ignored (multiplexer replaces per-service proxies).
   */
  mcpMultiplexer?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolveOrganizationIdForMcp(opts: PlatformMcpConfigOptions): string | undefined {
  if (opts.organizationId !== undefined && opts.organizationId !== null) {
    const explicit = String(opts.organizationId).trim();
    if (explicit) return explicit;
  }

  const envOrg = (process.env['SHIZUHA_ORGANIZATION_ID'] ?? '').trim();
  if (envOrg) return envOrg;

  const payload = decodeJwtPayload(opts.bearerToken);
  if (!payload) return undefined;

  const jwtOrg = payload['organization_id'];
  if (jwtOrg) return String(jwtOrg);

  const memberships = payload['organization_memberships'];
  if (memberships && typeof memberships === 'object' && !Array.isArray(memberships)) {
    const orgIds = Object.keys(memberships);
    if (orgIds.length === 1) return orgIds[0];
  }
  if (Array.isArray(memberships) && memberships.length === 1) {
    const sole = memberships[0];
    if (sole && typeof sole === 'object') {
      const orgId = (sole as Record<string, unknown>)['id']
        ?? (sole as Record<string, unknown>)['organization_id'];
      if (orgId) return String(orgId);
    } else if (sole) {
      return String(sole);
    }
  }
  return undefined;
}

/**
 * Build the `mcpServers` map for all platform services using the supplied
 * bearer token. Each entry hits either the local Docker port (`:18101` etc.)
 * or the nginx-routed `/mcp/{service}/mcp` path on the remote backend.
 */
export function getPlatformMcpConfigs(opts: PlatformMcpConfigOptions): Record<string, McpServerEntry> {
  const platformUrl = (opts.platformUrl ?? process.env['SHIZUHA_PLATFORM_URL'] ?? '').replace(/\/+$/, '');

  let mcpHost = opts.mcpHost || process.env['PLATFORM_HOST'] || '';
  if (!mcpHost && platformUrl) {
    try { mcpHost = new URL(platformUrl).hostname; } catch { /* ignore */ }
  }
  if (!mcpHost) mcpHost = process.env['DAEMON_HOST'] || 'host.docker.internal';

  const isLocalHost = mcpHost === 'host.docker.internal' || mcpHost === 'localhost' || mcpHost === '127.0.0.1';
  const organizationId = resolveOrganizationIdForMcp(opts);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.bearerToken}`,
    ...(organizationId ? { 'X-Organization-ID': organizationId } : {}),
  };

  // Per-agent allow-list: opt override → SHIZUHA_MCP_SERVICES env (comma list)
  // → null (allow all). Scopes the turn-1 MCP tool surface; with all 16 servers
  // the tool schemas alone can push input past 200K on a fresh session and trip
  // 1M-context credit errors (SCLI-64).
  const allow = resolveMcpAllowList(opts.allowList);

  // PLAT-504/PLAT-427: which services route through the local stdio
  // reconnecting proxy. DEFAULT-ON: empty/unset → '*' (all services). Opt out
  // with SHIZUHA_MCP_STDIO_PROXY=off (or 0/false/no).
  const stdioProxy = resolveStdioProxyServices(opts.stdioProxy);
  // PLAT-3119: per-agent MCP multiplexer replaces N per-service proxies with one.
  const useMultiplexer = resolveMcpMultiplexer(opts.mcpMultiplexer);
  // Resolve the local proxy launcher once (node binary + bundled shizuha.js),
  // mirroring setupCronMcp's resolution. Only needed when the flag selects
  // something, but it's cheap and pure.
  const launcher = (stdioProxy || useMultiplexer) ? resolveProxyLauncher() : null;

  const configs: Record<string, McpServerEntry> = {};

  // PLAT-3119: multiplexer mode — emit a SINGLE stdio entry that replaces
  // all per-service proxies. The multiplexer receives the full list of upstream
  // services as a JSON env var and routes tool calls by name prefix.
  if (useMultiplexer && launcher) {
    const services = PLATFORM_MCP_SERVICES
      .filter((svc) => !allow || allow.has(svc.name))
      .map((svc) => {
        const url = isLocalHost
          ? `http://${mcpHost}:${svc.port}/mcp`
          : `${platformUrl || `https://${mcpHost}`}/mcp/${svc.name}/mcp`;
        // Bearer credentials are deliberately NOT baked into the long-lived
        // service JSON. The multiplexer reads MCP_UPSTREAM_BEARER_FILE/broker/env
        // fresh on every (re)connect, matching mcp-proxy's 24h-cliff fix. Keep
        // only non-secret routing scope in the per-service config.
        return {
          name: svc.name,
          url,
          headers: organizationId
            ? { 'X-Organization-ID': organizationId }
            : {},
        };
      });

    if (services.length > 0) {
      configs['shizuha-mcp'] = {
        command: launcher.command,
        args: [
          ...launcher.prefixArgs,
          'mcp-multiplexer',
          '--services', JSON.stringify(services),
        ],
        env: {
          MCP_UPSTREAM_BEARER: opts.bearerToken,
          ...(opts.bearerTokenFile ? { MCP_UPSTREAM_BEARER_FILE: opts.bearerTokenFile } : {}),
          ...(organizationId ? { MCP_UPSTREAM_ORG: organizationId } : {}),
        },
      };
    }
    return configs;
  }

  for (const svc of PLATFORM_MCP_SERVICES) {
    if (allow && !allow.has(svc.name)) continue;
    const url = isLocalHost
      ? `http://${mcpHost}:${svc.port}/mcp`
      : `${platformUrl || `https://${mcpHost}`}/mcp/${svc.name}/mcp`;

    if (stdioProxy && launcher && (stdioProxy === '*' || stdioProxy.has(svc.name))) {
      // Stdio-proxy form: claude-code spawns a local `mcp-proxy` that owns the
      // upstream HTTP connection and reconnects it transparently. The stdio pipe
      // never drops, so the tool schemas stay registered across backend restarts.
      // The bearer is passed via env (read FRESH by the proxy on each reconnect),
      // not baked into a header, so a token refresh is picked up without a restart.
      configs[`shizuha-${svc.name}`] = {
        command: launcher.command,
        args: [
          ...launcher.prefixArgs,
          'mcp-proxy',
          '--name', svc.name,
          '--upstream-url', url,
        ],
        env: {
          MCP_UPSTREAM_BEARER: opts.bearerToken,
          ...(opts.bearerTokenFile ? { MCP_UPSTREAM_BEARER_FILE: opts.bearerTokenFile } : {}),
          ...(organizationId ? { MCP_UPSTREAM_ORG: organizationId } : {}),
        },
      };
      continue;
    }

    configs[`shizuha-${svc.name}`] = {
      type: 'http',
      url,
      headers: { ...headers },
    };
  }
  return configs;
}

/**
 * Resolve which services route through the local stdio proxy (PLAT-504/PLAT-427).
 *   - opt override > `SHIZUHA_MCP_STDIO_PROXY` env.
 *   - `0`/`false`/`off`/`no` → `null` (explicitly OFF; everything stays HTTP — the
 *     escape hatch / reversal lever).
 *   - UNSET (default) or `1`/`true`/`*`/`all` → `'*'` (every platform service via the
 *     local reconnecting stdio proxy). DEFAULT-ON (PLAT-504): print-mode claude-code
 *     never reconnects raw `type:http` MCP after a backend restart, so the proxy is
 *     the correct default; HTTP is opt-out for emergencies.
 *   - comma-list (e.g. `pulse,wiki`) → a Set of those service names.
 * Exported for tests.
 */
export function resolveStdioProxyServices(explicit?: string): '*' | Set<string> | null {
  const raw = (explicit ?? process.env['SHIZUHA_MCP_STDIO_PROXY'] ?? '').trim();
  const lower = raw.toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(lower)) return null;       // explicit opt-out
  if (!raw || ['1', 'true', '*', 'all', 'yes', 'on'].includes(lower)) return '*'; // DEFAULT-ON
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length ? new Set(names) : '*';
}

/**
 * Resolve whether the per-agent MCP multiplexer is enabled (PLAT-3119).
 *   - opt override > `SHIZUHA_MCP_MULTIPLEXER` env.
 *   - `1`/`true`/`on`/`yes` → enabled (replaces per-service stdio proxies with one process).
 *   - `0`/`false`/`off`/`no` / unset → disabled (uses existing per-service proxy model).
 * Exported for tests.
 */
export function resolveMcpMultiplexer(explicit?: string): boolean {
  const raw = (explicit ?? process.env['SHIZUHA_MCP_MULTIPLEXER'] ?? '').trim().toLowerCase();
  if (!raw) return false;
  return ['1', 'true', 'on', 'yes'].includes(raw);
}

/**
 * Resolve the command + leading args that launch a bundled-runtime subcommand
 * (`mcp-proxy`, …). Mirrors the bridge MCP setup:
 * the same node binary running this process re-executes the bundled
 * `dist/shizuha.js`. `realpathSync` follows the symlink so the container's
 * `/opt/shizuha/dist/shizuha.js` (or the bare-metal host path) is used.
 * Exported for tests.
 */
export function resolveProxyLauncher(): { command: string; prefixArgs: string[] } {
  let shizuhaJs = process.argv[1] ?? 'shizuha';
  try { shizuhaJs = fs.realpathSync(shizuhaJs); } catch { /* keep raw path */ }
  return { command: 'node', prefixArgs: [shizuhaJs] };
}

/**
 * Resolve the platform MCP allow-list with two-level semantics (SCLI-44/SCLI-64):
 *   - `explicit` (role-derived) = ceiling — the maximum a role may connect.
 *   - `SHIZUHA_MCP_SERVICES` env = optional further narrowing — the operator lever.
 * When both are present, INTERSECT them so the env lever always wins.
 * When only one is present, that one is the result.
 * When neither is present, return null (allow all, legacy/no-restriction mode).
 */
export function resolveMcpAllowList(explicit?: string[]): Set<string> | null {
  const roleSet = (explicit && explicit.length) ? new Set(explicit) : null;
  const envStr = (process.env['SHIZUHA_MCP_SERVICES'] ?? '').trim();
  const envSet = envStr
    ? new Set(envStr.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  if (roleSet && envSet) {
    // Both present: intersect. Role = ceiling; env = further narrowing.
    return new Set([...roleSet].filter((s) => envSet.has(s)));
  }
  return roleSet ?? envSet ?? null;
}

/**
 * Drop platform `shizuha-*` entries that are NOT in the allow-list from an
 * existing mcpServers map. The claude-bridge MERGES fresh configs into
 * `/workspace/.mcp.json`, so a server trimmed from the allow-list would
 * otherwise persist across restarts (the live gotcha behind SCLI-64). Call at
 * compose time before writing `.mcp.json`. Only known `shizuha-{service}` keys
 * are considered; non-platform / custom MCP entries are left untouched.
 *
 * Also handles the `shizuha-mcp` multiplexer key (PLAT-3119): when the
 * multiplexer is in use, the allow-list applies to the services it manages,
 * not the multiplexer entry itself.
 */
/**
 * Remove every platform-MANAGED MCP entry from an existing mcpServers map:
 * the per-service `shizuha-<service>` proxies AND the `shizuha-mcp` multiplexer
 * key. Non-platform / custom entries (`ori`, `google-drive`, user-defined
 * servers) are preserved. Retired platform keys are explicitly stripped so old
 * persistent `.mcp.json` files cannot resurrect dead endpoints.
 *
 * The bridges MERGE fresh platform configs into a PERSISTENT `.mcp.json`, so
 * without stripping the platform block first it is only ever appended to:
 * a prior boot's per-service proxy entries survive a switch TO the multiplexer
 * (both run → duplicate tools, +RSS) and a stale `shizuha-mcp` survives a
 * switch back OFF (PLAT-4023). Call this on the existing map right before
 * merging `getPlatformMcpConfigs()` output so that output is the single
 * authoritative source for the platform block — making the multiplexer flag
 * idempotent and reversible.
 *
 * Unlike codex-bridge's broad `shizuha-*` delete, this only drops KNOWN
 * platform keys, so a custom `shizuha-<x>` MCP the operator added by hand is
 * left intact.
 */
export function stripPlatformManagedMcpEntries<T>(servers: Record<string, T>): Record<string, T> {
  const managed = new Set<string>(PLATFORM_MCP_SERVICES.map((s) => `shizuha-${s.name}`));
  managed.add('shizuha-mcp'); // PLAT-3119 multiplexer entry
  for (const key of RETIRED_PLATFORM_MCP_KEYS) managed.add(key);
  const out: Record<string, T> = {};
  for (const [key, val] of Object.entries(servers)) {
    if (!managed.has(key)) out[key] = val;
  }
  return out;
}

export function prunePlatformMcpKeys<T>(
  servers: Record<string, T>,
  allow?: string[],
): Record<string, T> {
  const allowSet = resolveMcpAllowList(allow);
  const platformKeys = new Set(PLATFORM_MCP_SERVICES.map((s) => `shizuha-${s.name}`));
  const out: Record<string, T> = {};
  for (const [key, val] of Object.entries(servers)) {
    if (RETIRED_PLATFORM_MCP_KEYS.has(key)) continue;
    // Keep the multiplexer entry as-is (it manages its own allow-list internally)
    if (key === 'shizuha-mcp') {
      out[key] = val;
      continue;
    }
    if (allowSet && platformKeys.has(key) && !allowSet.has(key.slice('shizuha-'.length))) {
      continue; // non-allowed platform entry → drop
    }
    out[key] = val;
  }
  return out;
}
