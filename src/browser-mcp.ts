import * as crypto from 'node:crypto';
import { resolveProxyLauncher, type McpHttpServerEntry, type McpStdioServerEntry } from './platform/mcp-services.js';

const DEFAULT_BROWSER_MCP_URL = 'http://127.0.0.1:18116/mcp';
const DEFAULT_BROWSER_MCP_SECRET = 'dev_jwt_secret_key_for_local_development_only_change_in_prod';

export const BROWSER_MCP_TOKEN_ENV = 'SHIZUHA_BROWSER_MCP_BEARER';

/** Capabilities / roles that should receive the local browser MCP surface. */
const BROWSER_CAPABILITY_TOKENS = new Set([
  'qa',
  'browser',
  'social',
  'social-media',
  'social_media',
  'qa_engineer',
  'qa-engineer',
]);

export type BrowserMcpServerEntry = McpHttpServerEntry | McpStdioServerEntry;

export interface ResolvedBrowserMcpServer {
  name: 'browser';
  /** Present only for HTTP/sidecar mode. */
  url?: string;
  /** Bearer for HTTP mode; empty string for stdio. */
  token: string;
  entry: BrowserMcpServerEntry;
  /** Which transport the entry uses. */
  transport: 'http' | 'stdio';
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = {
    iat: Math.floor(Date.now() / 1000),
    ...payload,
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(body));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  return `${encodedHeader}.${encodedPayload}.${base64url(signature)}`;
}

function envEnabled(name: string, env: NodeJS.ProcessEnv = process.env): boolean | null {
  const raw = env[name];
  if (raw == null) return null;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  return true;
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * True when the agent runtime is expected to expose browser automation tools.
 *
 * Priority:
 *   1. SHIZUHA_BROWSER_MCP explicit on/off (wins)
 *   2. SHIZUHA_BROWSER_MCP_URL set → on (HTTP sidecar mode)
 *   3. Auto-on when effective capabilities / role / skills include qa|browser|social*
 *      (PLAT-5106: cron-mcp decommission left QA agents with zero browser tools;
 *      the local stdio browser-mcp server replaces that surface without needing
 *      a :18116 sidecar).
 *
 * Role/context free-text alone is NOT enough — that previously caused every
 * bridge to hammer a missing HTTP sidecar. Auto-enable is capability-gated and
 * pairs with the in-process stdio server so transport failures do not recur.
 */
export function wantsBrowserMcp(
  contextPrompt?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = envEnabled('SHIZUHA_BROWSER_MCP', env);
  if (explicit != null) return explicit;
  if (env['SHIZUHA_BROWSER_MCP_URL']) return true;

  const tokens = new Set<string>([
    ...splitCsv(env['AGENT_EFFECTIVE_CAPABILITIES']),
    ...splitCsv(env['AGENT_ROLE']),
    ...splitCsv(env['AGENT_SKILLS']),
    ...splitCsv(env['AGENT_EFFECTIVE_CAPABILITY_SOURCE_TEAMS']),
  ]);

  for (const token of tokens) {
    if (BROWSER_CAPABILITY_TOKENS.has(token)) return true;
    // Tolerate compound values like "qa,review" already split, and role labels
    // such as "QA Engineer" → tokens "qa" + "engineer" after split on space.
    for (const needle of BROWSER_CAPABILITY_TOKENS) {
      if (token === needle || token.startsWith(`${needle}-`) || token.endsWith(`-${needle}`)) {
        return true;
      }
    }
  }

  // contextPrompt is intentionally ignored for auto-wire (see comment above).
  void contextPrompt;
  return false;
}

export function browserMcpBearerToken(env: NodeJS.ProcessEnv = process.env): string {
  const existing = env[BROWSER_MCP_TOKEN_ENV] || env['SHIZUHA_BROWSER_MCP_TOKEN'];
  if (existing) return existing;

  const secret = env['SHIZUHA_BROWSER_MCP_JWT_SECRET']
    || env['JWT_SECRET_KEY']
    || DEFAULT_BROWSER_MCP_SECRET;

  return signHs256({
    sub: env['AGENT_USERNAME'] || env['USER'] || 'agent',
    username: env['AGENT_USERNAME'] || env['USER'] || 'agent',
    email: env['AGENT_EMAIL'] || undefined,
    organization_id: env['SHIZUHA_ORGANIZATION_ID'] || env['ORGANIZATION_ID'] || undefined,
    project_id: env['SHIZUHA_PROJECT_ID'] || env['PROJECT_ID'] || undefined,
    aud: 'shizuha-browser',
  }, secret);
}

/**
 * Resolve the browser MCP server entry for bridge .mcp.json / Codex TOML.
 *
 * Transport selection (PLAT-5106):
 *   - SHIZUHA_BROWSER_MCP_URL set → HTTP entry (pod-local sidecar on :18116 or
 *     an operator-provided URL).
 *   - otherwise → stdio entry spawning `node dist/shizuha.js browser-mcp`
 *     (in-process Playwright tools; no sidecar required).
 *
 * Previously this always emitted HTTP against 127.0.0.1:18116, which fails on
 * every fleet pod that does not run a browser sidecar — the root cause of QA
 * agents seeing zero Browser tools after cron-mcp was removed.
 */
export function resolveBrowserMcpServer(
  contextPrompt?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBrowserMcpServer | null {
  if (!wantsBrowserMcp(contextPrompt, env)) return null;

  const explicitUrl = (env['SHIZUHA_BROWSER_MCP_URL'] || '').trim().replace(/\/+$/, '');
  if (explicitUrl) {
    const token = browserMcpBearerToken(env);
    return {
      name: 'browser',
      url: explicitUrl,
      token,
      transport: 'http',
      entry: {
        type: 'http',
        url: explicitUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    };
  }

  // Stdio default — local browser-mcp command wrapping native tools.
  // Prefer the currently-running shizuha.js so the spawned server matches the
  // bridge binary (same pattern as mcp-proxy / mcp-multiplexer).
  const launcher = resolveProxyLauncher();
  const entry: McpStdioServerEntry = {
    command: launcher.command,
    args: [...launcher.prefixArgs, 'browser-mcp'],
    env: {
      // Propagate browser path so Playwright finds the image-bundled Chromium.
      ...(env['PLAYWRIGHT_BROWSERS_PATH']
        ? { PLAYWRIGHT_BROWSERS_PATH: env['PLAYWRIGHT_BROWSERS_PATH'] }
        : {}),
      ...(env['BROWSER_MCP_SESSION_ID']
        ? { BROWSER_MCP_SESSION_ID: env['BROWSER_MCP_SESSION_ID'] }
        : {}),
      ...(env['HOME'] ? { HOME: env['HOME'] } : {}),
      ...(env['DISPLAY'] ? { DISPLAY: env['DISPLAY'] } : {}),
    },
  };

  return {
    name: 'browser',
    token: '',
    transport: 'stdio',
    entry,
  };
}

/** @deprecated kept for callers that still import the default URL constant. */
export const BROWSER_MCP_DEFAULT_URL = DEFAULT_BROWSER_MCP_URL;
