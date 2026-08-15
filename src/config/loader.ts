import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { configSchema, perAgentConfigSchema, type ConfigInput } from './schema.js';
import type { ShizuhaConfig, PerAgentConfig } from './types.js';
import type { MCPServerConfig } from '../agent/types.js';
import { logger } from '../utils/logger.js';
import { getValidShizuhaOAuthAccessToken } from './shizuhaAuth.js';
import { AgentTokenManager } from '../auth/agent-token-manager.js';

/**
 * 4-layer config loader (later layers override earlier):
 * 1. Enterprise: /etc/shizuha/config.toml
 * 2. User: ~/.config/shizuha/config.toml
 * 3. Project shared: <project>/.shizuha/config.toml
 * 4. Project local: <project>/.shizuha/config.local.toml
 *
 * Additionally reads .mcp.json (Claude Code format) from the project root
 * and converts it to shizuha MCPServerConfig format.
 */
const CONFIG_LAYERS = [
  '/etc/shizuha/config.toml',
  () => path.join(process.env['HOME'] ?? '~', '.config', 'shizuha', 'config.toml'),
  (cwd: string) => path.join(cwd, '.shizuha', 'config.toml'),
  (cwd: string) => path.join(cwd, '.shizuha', 'config.local.toml'),
];

async function readTOML(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return parseTOML(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Well-known HTTP ports for Shizuha MCP servers.
 * Each service hosts its own MCP server on this port (see `<service>/mcp-server/`).
 */
const MCP_DAEMON_PORTS: Record<string, number> = {
  'shizuha-pulse': 18101, pulse: 18101,
  'shizuha-id': 18102, id: 18102,
  'shizuha-admin': 18103, admin: 18103,
  'shizuha-notes': 18104, notes: 18104,
  'shizuha-wiki': 18105, wiki: 18105,
  'shizuha-drive': 18106, drive: 18106,
  'shizuha-connect': 18108, connect: 18108,
  'shizuha-finance': 18109, finance: 18109,
  'shizuha-books': 18110, books: 18110,
  'shizuha-inventory': 18113, inventory: 18113,
  'shizuha-mail': 18114, mail: 18114,
  'shizuha-mail-agent': 18115, 'mail-agent': 18115,
};

const RETIRED_MCP_SERVERS = new Set(['shizuha-hr', 'hr', 'shizuha-time', 'time']);

function normalizeServiceName(serverName: string): string {
  return serverName.startsWith('shizuha-') ? serverName.slice('shizuha-'.length) : serverName;
}

function isShizuhaService(serverName: string): boolean {
  return Boolean(MCP_DAEMON_PORTS[serverName]);
}

function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

function hasDelegatedUserHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  const delegatedHeaderKeys = new Set([
    'x-shizuha-user-authorization',
    'x-shizuha-user-jwt-token',
    'x-shizuha-user-jwt',
  ]);
  return Object.keys(headers).some((key) => delegatedHeaderKeys.has(key.toLowerCase()));
}

function applyShizuhaAuth(config: MCPServerConfig, accessToken: string | null): MCPServerConfig {
  if (!isShizuhaService(config.name)) {
    return config;
  }
  // Mark as platform-managed so client.ts can gate broker JWT refresh to these servers only.
  config = { ...config, platformManaged: true };
  if (!accessToken) {
    return config;
  }

  const normalized = normalizeServiceName(config.name).toUpperCase();

  if (config.transport === 'stdio') {
    const env = { ...(config.env ?? {}) };
    env[`SHIZUHA_${normalized}_JWT_TOKEN`] ??= accessToken;
    env[`SHIZUHA_${normalized}_USER_JWT_TOKEN`] ??= accessToken;
    return { ...config, env };
  }

  const headers = { ...(config.headers ?? {}) };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') delete headers[key];
  }
  headers['Authorization'] = `Bearer ${accessToken}`;
  if (!hasDelegatedUserHeader(headers)) {
    headers['X-Shizuha-User-Authorization'] = `Bearer ${accessToken}`;
  } else {
    for (const key of Object.keys(headers)) {
      if ([
        'x-shizuha-user-authorization',
        'x-shizuha-user-jwt-token',
        'x-shizuha-user-jwt',
      ].includes(key.toLowerCase())) {
        headers[key] = `Bearer ${accessToken}`;
      }
    }
  }
  return { ...config, headers };
}

async function getValidMcpAccessToken(): Promise<string | null> {
  const userToken = await getValidShizuhaOAuthAccessToken().catch((err) => {
    logger.debug({ err }, 'Unable to resolve user Shizuha auth token for MCP config');
    return null;
  });
  if (userToken) return userToken;

  const agentUsername = process.env['AGENT_USERNAME']?.trim();
  if (!agentUsername) return null;

  const platformUrl = (
    process.env['SHIZUHA_PLATFORM_URL']
    ?? process.env['SHIZUHA_ID_URL']
    ?? process.env['SHIZUHA_ID_API_URL']
    ?? process.env['BACKEND_URL']
    ?? 'https://shizuha.com'
  ).replace(/\/+$/, '');

  const manager = new AgentTokenManager({
    agentUsername,
    platformUrl,
  });
  return manager.getToken().catch((err) => {
    logger.debug({ err, agentUsername }, 'Unable to resolve agent Shizuha auth token for MCP config');
    return null;
  });
}

/** Probe if a TCP port is listening (200ms timeout). */
function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host, timeout: 200 });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

/**
 * Read .mcp.json (Claude Code format) and convert to MCPServerConfig[].
 *
 * Claude Code .mcp.json format:
 * { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
 *
 * Shizuha MCPServerConfig format:
 * { name, transport: "stdio", command, args, env }
 *
 * Auto-detection: for known Shizuha servers, probes the well-known SSE
 * daemon port. If a daemon is already running, uses SSE transport instead
 * of spawning a new stdio process.
 */
async function readMcpJson(cwd: string): Promise<MCPServerConfig[]> {
  const configs: MCPServerConfig[] = [];
  if (process.env['SHIZUHA_DISABLE_MCP_JSON'] === '1') {
    return configs;
  }

  // Search: project .mcp.json, then user ~/.mcp.json
  const candidates = [
    path.join(cwd, '.mcp.json'),
    path.join(process.env['HOME'] ?? '~', '.mcp.json'),
  ];

  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as Record<string, unknown>;
      const servers = data['mcpServers'] as Record<string, Record<string, unknown>> | undefined;
      if (!servers || typeof servers !== 'object') continue;

      // Probe daemon ports in parallel for all known servers
      const serverNames = Object.keys(servers);
      const needsShizuhaAuth = serverNames.some((name) => isShizuhaService(name));
      const shizuhaAccessToken = needsShizuhaAuth
        ? await getValidMcpAccessToken().catch((err) => {
          logger.debug({ err }, 'Unable to resolve Shizuha auth token for MCP auto-auth');
          return null;
        })
        : null;

      const daemonProbes = new Map<string, Promise<boolean>>();
      for (const name of serverNames) {
        const port = MCP_DAEMON_PORTS[name];
        if (port) {
          daemonProbes.set(name, probePort(port));
        }
      }
      // Await all probes at once (each is ~200ms max)
      const probeResults = new Map<string, boolean>();
      for (const [name, probe] of daemonProbes) {
        probeResults.set(name, await probe);
      }

      for (const [name, serverDef] of Object.entries(servers)) {
        if (RETIRED_MCP_SERVERS.has(name)) {
          logger.info({ server: name }, 'Skipping retired MCP server from .mcp.json');
          continue;
        }
        if (!serverDef || typeof serverDef !== 'object') continue;

        // Check if a daemon is already running for this server
        const daemonPort = MCP_DAEMON_PORTS[name];
        const daemonRunning = daemonPort ? (probeResults.get(name) ?? false) : false;

        let config: MCPServerConfig;
        if (daemonRunning && daemonPort) {
          // Connect to running daemon via streamable-http — no process spawning
          config = {
            name,
            transport: 'streamable-http',
            url: `http://127.0.0.1:${daemonPort}/mcp`,
            env: serverDef['env'] as Record<string, string> | undefined,
          };
          logger.info({ server: name, port: daemonPort }, 'MCP daemon detected, using streamable-http');
        } else {
          // Fall back to stdio — spawn process
          config = {
            name,
            transport: 'stdio',
            command: serverDef['command'] as string | undefined,
            args: serverDef['args'] as string[] | undefined,
            env: serverDef['env'] as Record<string, string> | undefined,
          };
        }

        // Support url-based transports in .mcp.json (explicit overrides)
        if (serverDef['url'] && typeof serverDef['url'] === 'string') {
          const url = serverDef['url'] as string;
          const explicitType = serverDef['type'] as string | undefined;
          if (url.startsWith('ws://') || url.startsWith('wss://')) {
            config.transport = 'websocket';
          } else if (explicitType === 'sse') {
            // Respect explicit "type": "sse" — the server uses the older SSE transport
            // (GET-based), not the newer Streamable HTTP (POST-based).
            config.transport = 'sse';
          } else {
            config.transport = 'streamable-http';
          }
          config.url = url;
          config.command = undefined;
          config.args = undefined;
        }
        const rawHeaders = serverDef['headers'] ?? serverDef['http_headers'];
        if (rawHeaders && typeof rawHeaders === 'object') {
          config.headers = rawHeaders as Record<string, string>;
        }

        const configWithAuth = applyShizuhaAuth(config, shizuhaAccessToken);
        configs.push(configWithAuth);
      }

      const httpCount = configs.filter(c => c.transport !== 'stdio').length;
      const stdioCount = configs.filter(c => c.transport === 'stdio').length;
      logger.info(
        { filePath, total: configs.length, daemon: httpCount, stdio: stdioCount },
        'Loaded .mcp.json',
      );
      break; // Use first file found (project > user)
    } catch {
      // File not found or invalid JSON — skip
    }
  }
  return configs;
}

export async function loadConfig(cwd?: string): Promise<ShizuhaConfig> {
  const workDir = cwd ?? process.cwd();
  let merged: Record<string, unknown> = {};

  for (const layer of CONFIG_LAYERS) {
    const filePath = typeof layer === 'function' ? layer(workDir) : layer;
    const data = await readTOML(filePath);
    if (data) {
      logger.debug({ filePath }, 'Loaded config layer');
      merged = deepMerge(merged, data);
    }
  }

  // Apply credential store API key (lowest priority — env and TOML override)
  try {
    const { readCredentials } = await import('./credentials.js');
    const creds = readCredentials();
    if (creds.anthropic?.apiKey) {
      const providers = (merged['providers'] as Record<string, unknown>) ?? {};
      const anthropic = (providers['anthropic'] as Record<string, unknown>) ?? {};
      if (!anthropic['apiKey']) {
        merged['providers'] = deepMerge(providers, { anthropic: { apiKey: creds.anthropic.apiKey } });
      }
    }
  } catch { /* ignore — credential store may not exist yet */ }

  // Apply environment variable overrides
  if (process.env['ANTHROPIC_API_KEY']) {
    merged['providers'] = deepMerge(
      (merged['providers'] as Record<string, unknown>) ?? {},
      { anthropic: { apiKey: process.env['ANTHROPIC_API_KEY'] } },
    );
  }
  if (process.env['OPENAI_API_KEY']) {
    merged['providers'] = deepMerge(
      (merged['providers'] as Record<string, unknown>) ?? {},
      { openai: { apiKey: process.env['OPENAI_API_KEY'] } },
    );
  }
  if (process.env['GOOGLE_API_KEY']) {
    merged['providers'] = deepMerge(
      (merged['providers'] as Record<string, unknown>) ?? {},
      { google: { apiKey: process.env['GOOGLE_API_KEY'] } },
    );
  }
  const cortexBaseUrl = nonEmptyEnv('CORTEX_BASE_URL');
  const cortexAuthToken = nonEmptyEnv('CORTEX_API_KEY') ?? nonEmptyEnv('CORTEX_OAUTH_TOKEN');
  if (cortexBaseUrl || cortexAuthToken) {
    merged['providers'] = deepMerge(
      (merged['providers'] as Record<string, unknown>) ?? {},
      {
        cortex: {
          ...(cortexBaseUrl ? { baseUrl: cortexBaseUrl } : {}),
          ...(cortexAuthToken ? { apiKey: cortexAuthToken } : {}),
        },
      },
    );
  }

  // Read .mcp.json (Claude Code format) and merge with TOML MCP servers.
  // TOML servers take precedence — .mcp.json servers are added only if their
  // name doesn't already exist in the TOML config.
  const mcpJsonServers = await readMcpJson(workDir);
  if (mcpJsonServers.length > 0) {
    const mcpSection = (merged['mcp'] as Record<string, unknown>) ?? {};
    const existingServers = (mcpSection['servers'] as Array<Record<string, unknown>>) ?? [];
    const existingNames = new Set(existingServers.map((s) => s['name'] as string));
    const newServers = mcpJsonServers
      .filter((s) => !existingNames.has(s.name))
      .map((s) => ({ ...s }));  // Plain objects for Zod
    if (newServers.length > 0) {
      mcpSection['servers'] = [...existingServers, ...newServers];
      merged['mcp'] = mcpSection;
    }
  }

  // Auto-inject user auth for known Shizuha MCP servers (TOML + .mcp.json sources).
  const mergedMcpSection = (merged['mcp'] as Record<string, unknown>) ?? {};
  const mergedServers = (mergedMcpSection['servers'] as MCPServerConfig[] | undefined) ?? [];
  if (mergedServers.length > 0) {
    const needsAuth = mergedServers.some((server) => isShizuhaService(server.name));
    if (needsAuth) {
      const accessToken = await getValidMcpAccessToken();
      if (accessToken) {
        mergedMcpSection['servers'] = mergedServers.map((server) => applyShizuhaAuth(server, accessToken));
        merged['mcp'] = mergedMcpSection;
      }
    }
  }

  return configSchema.parse(merged) as ShizuhaConfig;
}

/**
 * Load per-agent runtime config from ~/.shizuha/agents/{username}/agent.toml.
 * Returns null if the file doesn't exist.
 */
export async function loadAgentConfig(username: string): Promise<PerAgentConfig | null> {
  const configPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents', username, 'agent.toml');
  const data = await readTOML(configPath);
  if (!data) return null;
  logger.info({ username, configPath }, 'Loaded per-agent config');
  return perAgentConfigSchema.parse(data) as PerAgentConfig;
}

/**
 * Load per-agent CLAUDE.md from ~/.shizuha/agents/{username}/CLAUDE.md.
 * Returns null if the file doesn't exist.
 */
export async function loadAgentClaudeMd(username: string): Promise<string | null> {
  const mdPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents', username, 'CLAUDE.md');
  try {
    return await fs.readFile(mdPath, 'utf-8');
  } catch {
    return null;
  }
}
