import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '../../agent/types.js';
import type { ImageData } from '../types.js';
import { logger } from '../../utils/logger.js';
import { fetchBrokerToken, brokerExpected } from '../../auth/broker-token.js';
import { getValidShizuhaOAuthAccessToken } from '../../config/shizuhaAuth.js';
import { readAgentCredential } from '../../auth/credential-resolver.js';
import { AgentTokenManager } from '../../auth/agent-token-manager.js';

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Types ──

export interface MCPToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface MCPToolInfo {
  /** Prefixed name: mcp__<server>__<tool> */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: MCPToolAnnotations;
}

export interface MCPResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPToolResult {
  content: string;
  isError?: boolean;
  image?: ImageData;
}

export interface MCPConnection {
  client: Client;
  config: MCPServerConfig;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;
  capabilities?: ServerCapabilities;
  serverVersion?: { name: string; version: string };
  instructions?: string;
  tools: MCPToolInfo[];
  resources: MCPResourceInfo[];
  /** SCLI-19: true once a manager reconnect has superseded this connection; its stale
   *  listChanged / onReconnected callbacks then no-op (orphaned-listener guard). */
  superseded?: boolean;
  /** SCLI-488: true while auth refresh intentionally closes the current transport.
   *  The manager must not mistake that planned close for a backend failure. */
  refreshingTransport?: boolean;
}

// ── Constants ──

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_RESOURCE_TIMEOUT_MS = 30_000;
/** Startup initialize timeout. Must be high enough for slow stdio MCP servers on loaded agents. */
const CONNECT_INIT_TIMEOUT_MS = positiveIntEnv('MCP_CONNECT_INIT_TIMEOUT_MS', positiveIntEnv('MCP_CONNECT_TIMEOUT_MS', 90_000));
/** Startup schema discovery timeout. */
const CONNECT_LIST_TIMEOUT_MS = positiveIntEnv('MCP_CONNECT_LIST_TIMEOUT_MS', CONNECT_INIT_TIMEOUT_MS);
const CONNECT_RESOURCE_LIST_TIMEOUT_MS = positiveIntEnv('MCP_CONNECT_RESOURCE_LIST_TIMEOUT_MS', CONNECT_LIST_TIMEOUT_MS);
/** Max MCP output in estimated tokens */
const MAX_MCP_OUTPUT_TOKENS = 25_000;

// ── SSE Reconnection Constants (mirrors Claude Code's SSETransport) ──

/** Base delay between reconnection attempts */
const SSE_RECONNECT_BASE_DELAY_MS = 1_000;
/** Maximum delay between reconnection attempts */
const SSE_RECONNECT_MAX_DELAY_MS = 30_000;
/** Total time budget for reconnection attempts before giving up */
const SSE_RECONNECT_GIVE_UP_MS = 600_000; // 10 minutes
/** If no successful tool call within this period after an error, treat connection as dead */
const SSE_LIVENESS_TIMEOUT_MS = 45_000;
/** Bounded timeout for a tool-list probe (liveness probe + reconnect usability gate) */
const SSE_TOOL_LIST_PROBE_MS = 5_000;

// ── Streamable-HTTP 401 Auth-Refresh ──────────────────────────────────────────

/** Callback type: returns fresh headers (re-read from .mcp.json / re-minted) or null */
type HeaderRefreshFn = () => Promise<Record<string, string> | null>;

type StreamableHttpRefreshContext = {
  refreshHeaders: HeaderRefreshFn;
  clientOptions: ConstructorParameters<typeof Client>[1];
  onTransportReplaced?: (conn: MCPConnection) => void;
};

/** Per-connection refresh callbacks for streamable-http servers with auth headers. */
const streamableHttpRefreshers = new WeakMap<MCPConnection, StreamableHttpRefreshContext>();

// ── PLS-115: Proactive (pre-expiry) token refresh ─────────────────────────────
// SCLI-70 made streamable-http recover *reactively* from a 401 (expired JWT).
// That still surfaces one mid-session "token expired" error to the caller before
// it recovers. PLS-115 refreshes the token BEFORE it expires — a timer keyed to
// the JWT `exp` re-reads the watchdog-fresh .mcp.json and swaps the transport at
// PROACTIVE_REFRESH_TTL_FRACTION of the remaining lifetime, so a long-lived MCP
// connection never hits the hard expiry. The reactive 401 path stays as the net.

/** Refresh at this fraction of the token's remaining lifetime (before expiry). */
const PROACTIVE_REFRESH_TTL_FRACTION = 0.8;
/** Floor so a near-expired token doesn't busy-loop the refresh. */
const PROACTIVE_REFRESH_MIN_MS = 30_000;
/** Ceiling so a very long-lived token still re-anchors to the watchdog file periodically. */
const PROACTIVE_REFRESH_MAX_MS = 30 * 60_000; // 30 min — matches the agent-jwt-watchdog cadence
/**
 * Pre-dial refresh skew (CTX-4xx / PLAT gateway-token-cliff). Before DIALING a
 * platform-managed streamable-http server, if the baked Authorization token is
 * expired, unparseable, or within this window of expiry, re-mint it from the
 * per-agent broker. This closes the gap the reactive-401 and PLS-115 proactive
 * refreshers cannot: they only run on an ESTABLISHED connection, so a token that
 * expired while the connection was DOWN gets re-dialed with the stale header —
 * the server 401s the initialize but StreamableHTTP surfaces it as a 90s connect
 * HANG (not a 401), so nothing ever refreshes and the agent loses all platform
 * MCP. 5 min ensures the dialed token has ample life for the handshake + first calls.
 */
const PREDIAL_REFRESH_SKEW_MS = 5 * 60_000;

/** Per-connection proactive-refresh timers (PLS-115). */
const proactiveRefreshTimers = new WeakMap<MCPConnection, NodeJS.Timeout>();

/** Decode a JWT `exp` (seconds) from the first Bearer auth header → epoch ms, or null for opaque tokens. */
export function decodeBearerExpMs(headers: Record<string, string> | undefined): number | null {
  if (!headers) return null;
  const authKeys = ['authorization', 'x-shizuha-user-authorization', 'x-shizuha-user-jwt-token', 'x-shizuha-user-jwt'];
  for (const key of Object.keys(headers)) {
    if (!authKeys.includes(key.toLowerCase())) continue;
    const val = headers[key];
    if (!val) continue;
    const token = val.replace(/^Bearer\s+/i, '').trim();
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) continue;
    try {
      const padLen = (4 - (parts[1].length % 4)) % 4;
      const payload = JSON.parse(
        Buffer.from(parts[1] + '='.repeat(padLen), 'base64').toString('utf-8'),
      ) as { exp?: number };
      if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return payload.exp * 1000;
    } catch {
      // not a JWT / unparseable — try the next candidate header
    }
  }
  return null;
}

/**
 * Swap a streamable-http connection onto a fresh transport carrying `freshHeaders`
 * (close old client, connect new, refresh capabilities/tools); updates `conn` in
 * place. Shared by the reactive 401 path and the PLS-115 proactive refresh.
 */
async function reconnectStreamableHttpWithHeaders(
  conn: MCPConnection,
  freshHeaders: Record<string, string>,
  clientOptions: ConstructorParameters<typeof Client>[1],
  onTransportReplaced?: (conn: MCPConnection) => void,
): Promise<void> {
  if (!conn.config.url) throw new Error('streamable-http reconnect requires url');
  conn.config.headers = freshHeaders;
  const newTransport = new StreamableHTTPClientTransport(
    new URL(conn.config.url),
    buildStreamableHttpTransportOptions(conn.config, freshHeaders),
  );
  const newClient = new Client({ name: 'shizuha', version: '0.1.0' }, clientOptions);
  // SCLI-488: Client.close() synchronously fires transport.onclose. MCPManager
  // normally treats that callback as an unexpected backend drop and starts a
  // second reconnect. During auth refresh that creates two replacement streams,
  // two proactive timers, and an unbounded branch on every refresh cycle. Mark
  // this close as planned until the single replacement is published.
  conn.refreshingTransport = true;
  try {
    try { await conn.client.close(); } catch { /* old connection may already be dead */ }
    await newClient.connect(newTransport);
    conn.client = newClient;
    conn.transport = newTransport;
  } finally {
    conn.refreshingTransport = false;
  }
  // Client.connect() installs transport handlers belonging to the new Client.
  // Let the manager wrap those fresh handlers; copying the old wrapper would
  // retain callbacks bound to the retired Client.
  onTransportReplaced?.(conn);
  conn.capabilities = newClient.getServerCapabilities();
  const sv = newClient.getServerVersion();
  conn.serverVersion = sv ? { name: sv.name, version: sv.version } : undefined;
  conn.instructions = newClient.getInstructions();
  if (conn.capabilities?.tools) {
    conn.tools = await listMCPToolsWithTimeout(newClient, conn.config.name, SSE_TOOL_LIST_PROBE_MS);
  }
}

/**
 * Schedule a proactive auth refresh for a streamable-http connection BEFORE its
 * JWT expires, then re-arm for the next lifetime. No-op (leaves the reactive 401
 * path in charge) when the token has no decodable `exp`. Best-effort: a failed
 * attempt just re-arms; the reactive path is the safety net.
 */
function scheduleProactiveRefresh(conn: MCPConnection): void {
  const ctx = streamableHttpRefreshers.get(conn);
  if (!ctx) return;
  const existing = proactiveRefreshTimers.get(conn);
  if (existing) { clearTimeout(existing); proactiveRefreshTimers.delete(conn); }

  const expMs = decodeBearerExpMs(conn.config.headers);
  if (expMs == null) return; // opaque/non-JWT token — nothing to anchor a timer to

  const remaining = expMs - Date.now();
  const delay = Math.min(
    Math.max(Math.floor(remaining * PROACTIVE_REFRESH_TTL_FRACTION), PROACTIVE_REFRESH_MIN_MS),
    PROACTIVE_REFRESH_MAX_MS,
  );

  const timer = setTimeout(() => {
    proactiveRefreshTimers.delete(conn);
    void (async () => {
      try {
        const fresh = await ctx.refreshHeaders();
        if (fresh) {
          await reconnectStreamableHttpWithHeaders(
            conn,
            fresh,
            ctx.clientOptions,
            ctx.onTransportReplaced,
          );
          logger.debug(
            { server: conn.config.name, event: 'mcp_proactive_refresh' },
            'MCP token proactively refreshed before expiry (PLS-115)',
          );
        }
      } catch (err) {
        logger.debug(
          { server: conn.config.name, err: (err as Error).message },
          'MCP proactive refresh failed — reactive 401 path remains the safety net',
        );
      } finally {
        scheduleProactiveRefresh(conn); // re-arm for the next token lifetime
      }
    })();
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  proactiveRefreshTimers.set(conn, timer);
}

const SHIZUHA_MCP_SERVICES = new Set([
  'shizuha-pulse', 'pulse',
  'shizuha-id', 'id',
  'shizuha-admin', 'admin',
  'shizuha-notes', 'notes',
  'shizuha-wiki', 'wiki',
  'shizuha-drive', 'drive',
  'shizuha-connect', 'connect',
  'shizuha-finance', 'finance',
  'shizuha-books', 'books',
  'shizuha-inventory', 'inventory',
  'shizuha-mail', 'mail',
  'shizuha-mail-agent', 'mail-agent',
  'shizuha-browser', 'browser',
]);

const RETIRED_SHIZUHA_MCP_SERVICES = new Set(['shizuha-hr', 'hr', 'shizuha-time', 'time']);

/** Candidates for the watchdog-maintained .mcp.json (highest priority first). */
function getMcpJsonCandidates(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path: typeof import('node:path') = require('node:path');
  const candidates = [
    path.join(process.cwd(), '.mcp.json'),
    '/workspace/.mcp.json',
    path.join(process.env['HOME'] ?? '/root', '.mcp.json'),
  ];
  return [...new Set(candidates)];
}

function hasHeader(headers: Record<string, string> | undefined, headerName: string): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === headerName.toLowerCase());
}

function hasAuthHeaders(headers: Record<string, string> | undefined): boolean {
  return hasHeader(headers, 'authorization') || hasHeader(headers, 'x-shizuha-user-authorization') ||
    hasHeader(headers, 'x-shizuha-user-jwt-token') || hasHeader(headers, 'x-shizuha-user-jwt');
}

function isShizuhaMcpService(config: MCPServerConfig): boolean {
  if (RETIRED_SHIZUHA_MCP_SERVICES.has(config.name)) return false;
  return SHIZUHA_MCP_SERVICES.has(config.name) || config.name.startsWith('shizuha-');
}

function setAuthHeader(headers: Record<string, string>, headerName: string, token: string): boolean {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === headerName.toLowerCase());
  if (!existingKey) return false;
  headers[existingKey] = `Bearer ${token}`;
  return true;
}

async function getValidMcpAccessToken(): Promise<string | null> {
  const userToken = await getValidShizuhaOAuthAccessToken().catch((err) => {
    logger.debug({ err }, 'Unable to resolve user Shizuha auth token for MCP refresh');
    return null;
  });
  if (userToken) return userToken;

  const agentUsername = process.env['AGENT_USERNAME']?.trim();
  if (!agentUsername || !readAgentCredential('AGENT_PASSWORD')) return null;

  const platformUrl = (
    process.env['SHIZUHA_PLATFORM_URL']
    ?? process.env['SHIZUHA_ID_URL']
    ?? process.env['SHIZUHA_ID_API_URL']
    ?? process.env['BACKEND_URL']
    ?? 'http://s1.tail.shizuha.com'
  ).replace(/\/+$/, '');

  const manager = new AgentTokenManager({ agentUsername, platformUrl });
  return manager.getToken().catch((err) => {
    logger.debug({ err, agentUsername }, 'Unable to resolve agent Shizuha auth token for MCP refresh');
    return null;
  });
}


/**
 * True when an error looks like a 401 / expired-token from a streamable-http server.
 * The Shizuha platform returns `invalid_token: Authentication required` in the error.
 */
function isAuthError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('401') ||
    msg.includes('unauthorized') ||
    msg.includes('invalid_token') ||
    msg.includes('authentication required') ||
    msg.includes('token expired')
  );
}

/**
 * Re-read headers for `serverName` from the watchdog-maintained .mcp.json.
 * The agent-jwt-watchdog rewrites /workspace/.mcp.json every 30 min with a
 * fresh bearer token — this is the primary refresh source (SCLI-70).
 */
async function readFreshHeadersFromMcpJson(serverName: string): Promise<Record<string, string> | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs: typeof import('node:fs') = require('node:fs');
  for (const candidate of getMcpJsonCandidates()) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      const servers = data['mcpServers'] as Record<string, Record<string, unknown>> | undefined;
      const serverDef = servers?.[serverName];
      if (serverDef?.['headers'] && typeof serverDef['headers'] === 'object') {
        const headers = serverDef['headers'] as Record<string, string>;
        // Only file headers that actually carry auth are a full refresh. If a
        // project .mcp.json only has non-auth metadata (for example
        // X-Organization-ID while startup auth was injected), fall through to
        // token re-minting instead of replacing a working Authorization header
        // with an unauthenticated header set.
        if (hasAuthHeaders(headers)) return headers;
      }
    } catch {
      // file not found or malformed — try next candidate
    }
  }
  return null;
}

// ── SSE Reconnection Wrapper ──

/**
 * Wraps an SSE MCP connection with Claude Code-style auto-reconnection.
 *
 * Mirrors Claude Code's SSETransport reconnection strategy:
 * - Liveness detection: if tool calls fail, assume SSE connection died
 * - Exponential backoff: 1s → 2s → 4s → ... up to 30s with ±25% jitter
 * - Time budget: keeps trying for 10 minutes before giving up
 * - Fresh transport: creates new SSEClientTransport on each reconnect
 * - Tool list refresh: re-fetches tools after reconnect (schema may have changed)
 */
class SSEReconnectWrapper {
  private reconnectAttempts = 0;
  private reconnectStartTime: number | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private isReconnecting = false;
  private closed = false;
  private evicted = false;
  private brokerRefreshAttempted = false;
  private lastActivityTime = Date.now();

  /** HTTP status codes that indicate permanent rejection — don't retry */
  private static PERMANENT_CODES = new Set([401, 403, 404]);
  /** Close/error codes indicating auth failure — try token refresh once */
  private static AUTH_FAILURE_CODES = new Set([4001, 4003]);

  constructor(
    private conn: MCPConnection,
    private sseUrl: URL,
    private sseOpts: ConstructorParameters<typeof SSEClientTransport>[1],
    /** Fired once when the server is permanently evicted (budget-exhausted or 401/403/404) */
    private onEvicted?: (reason: string, conn: MCPConnection) => void,
    /** Fired after a successful SSE auto-reconnect refreshes conn.tools (registry reconcile) */
    private onReconnected?: () => void,
  ) {
    this.setupTransportHandlers();
    this.resetLivenessTimer();
  }

  /**
   * Fire the one-time eviction signal: a LOUD structured log (so a recurring
   * eviction surfaces as a signal, not a silent capability loss) + the manager
   * callback that unregisters the dead server's tools.
   */
  private markEvicted(reason: string) {
    if (this.evicted) return;
    this.evicted = true;
    logger.error(
      { server: this.conn.config.name, reason, event: 'mcp_server_evicted' },
      'MCP server evicted — tools will be unregistered until restart/reconnect',
    );
    try {
      // Pass the conn identity so the manager can guard against a STALE eviction from an
      // old wrapper deleting a freshly-reconnected connection (see MCPManager.evictServer).
      this.onEvicted?.(reason, this.conn);
    } catch (err) {
      logger.warn({ server: this.conn.config.name, err }, 'MCP onEvicted callback threw');
    }
  }

  /** Wire up error/close handlers on the current transport */
  private setupTransportHandlers() {
    const transport = this.conn.transport as SSEClientTransport;

    transport.onerror = (err: Error) => {
      const errMsg = err.message ?? '';
      logger.warn(
        { server: this.conn.config.name, err: errMsg },
        'MCP SSE error detected',
      );

      // Pattern 2: Permanent close code detection
      // Check for HTTP status codes in the error message
      const httpCodeMatch = errMsg.match(/(\d{3})/);
      if (httpCodeMatch) {
        const code = parseInt(httpCodeMatch[1]!, 10);
        if (SSEReconnectWrapper.PERMANENT_CODES.has(code)) {
          logger.error(
            { server: this.conn.config.name, code },
            'MCP SSE permanent error — not retrying',
          );
          // 401/403 = auth failure — attempt a broker token-refresh once before evicting,
          // but ONLY for platform-managed configs. Sending a broker-minted identity token to
          // an arbitrary user-supplied URL is a credential-exfiltration risk (PLAT-223 P1-2).
          if ((code === 401 || code === 403) && !this.brokerRefreshAttempted
              && brokerExpected() && this.conn.config.platformManaged) {
            this.brokerRefreshAttempted = true;
            void this.tryBrokerRefreshAndReconnect(code);
            return;
          }
          // 404 or broker refresh already attempted / not configured — evict immediately.
          this.closed = true;
          this.markEvicted(`http-${code}`);
          return;
        }
        // Pattern 6: Auth failure — try refreshing headers once
        if (SSEReconnectWrapper.AUTH_FAILURE_CODES.has(code) && this.reconnectAttempts === 0) {
          logger.warn(
            { server: this.conn.config.name, code },
            'MCP SSE auth failure — refreshing headers and retrying once',
          );
          this.refreshSseHeaders();
        }
      }

      this.handleConnectionLoss();
    };

    transport.onclose = () => {
      if (this.closed) return;
      logger.warn(
        { server: this.conn.config.name },
        'MCP SSE connection closed',
      );
      this.handleConnectionLoss();
    };
  }

  /** Pattern 6: Refresh auth headers from config (re-reads JWT/token) */
  private refreshSseHeaders() {
    if (this.conn.config.headers && Object.keys(this.conn.config.headers).length > 0) {
      // Re-apply headers — the config may have been updated externally
      if (this.sseOpts) {
        this.sseOpts.requestInit = { headers: { ...this.conn.config.headers } };
      }
      logger.info({ server: this.conn.config.name }, 'MCP SSE refreshed auth headers');
    }
  }

  /**
   * PLAT-223: On 401/403, fetch a fresh JWT from the per-agent broker sidecar
   * (mcp-auth-proxy UDS). If a token is obtained and the connection has an
   * Authorization header, update the header in-place and reconnect. Only evict
   * if the broker is absent, returns nothing, or no Authorization header exists.
   */
  private async tryBrokerRefreshAndReconnect(code: number): Promise<void> {
    // On a 401/403 the current Authorization header has already been rejected.
    // Do NOT "refresh" from the spawn-time AGENT_ACCESS_TOKEN env var: long-lived
    // rt-fleet containers keep that env token forever, so reusing it just repeats
    // invalid_token until an operator restarts the agent. The broker/file
    // refresh path is the live credential source.
    const token = await fetchBrokerToken(5_000);
    const headers = this.conn.config.headers;
    if (token && headers) {
      const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
      if (authKey) {
        headers[authKey] = `Bearer ${token.accessToken}`;
        this.refreshSseHeaders();
        logger.info(
          { server: this.conn.config.name },
          'MCP SSE broker token refreshed — retrying connection after auth failure',
        );
        this.handleConnectionLoss();
        return;
      }
    }
    logger.warn(
      { server: this.conn.config.name, code },
      'MCP SSE broker token refresh unavailable or no auth header — evicting',
    );
    this.closed = true;
    this.markEvicted(`http-${code}`);
  }

  /** Reset the liveness timer — called after successful operations */
  resetLivenessTimer() {
    this.clearLivenessTimer();
    if (this.closed) return;
    this.lastActivityTime = Date.now();

    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      if (this.closed) return;
      if (this.isReconnecting) return;

      // Pattern 7: System sleep detection — if clock jumped >60s, connection is stale
      const now = Date.now();
      const gap = now - this.lastActivityTime;
      if (gap > 60_000 + SSE_LIVENESS_TIMEOUT_MS) {
        logger.warn(
          { server: this.conn.config.name, gapMs: gap },
          'MCP SSE clock gap detected (system sleep?) — reconnecting immediately',
        );
        this.isReconnecting = false;
        this.reconnectAttempts = 0; // Skip backoff — reconnect immediately after wake
        this.handleConnectionLoss();
        return;
      }

      logger.warn(
        { server: this.conn.config.name, timeoutMs: SSE_LIVENESS_TIMEOUT_MS },
        'MCP SSE liveness timeout — probing connection',
      );
      // Probe with a short timeout — if it hangs, connection is dead
      const probe = Promise.race([
        this.conn.client.listTools(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), SSE_TOOL_LIST_PROBE_MS)),
      ]);
      probe.then(() => {
        this.resetLivenessTimer();
      }).catch(() => {
        logger.warn({ server: this.conn.config.name }, 'MCP SSE liveness probe failed — forcing reconnect');
        this.isReconnecting = false;
        this.handleConnectionLoss();
      });
    }, SSE_LIVENESS_TIMEOUT_MS);
    if (this.livenessTimer.unref) this.livenessTimer.unref();
  }

  private clearLivenessTimer() {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /** Handle a detected connection loss — start reconnection with backoff */
  private handleConnectionLoss() {
    if (this.isReconnecting || this.closed) return;
    this.clearLivenessTimer();
    this.isReconnecting = true;

    const now = Date.now();
    if (!this.reconnectStartTime) {
      this.reconnectStartTime = now;
    }

    this.scheduleReconnect();
  }

  /** Schedule a reconnection attempt with exponential backoff */
  private scheduleReconnect() {
    // PLAT-504: stop immediately if the manager has superseded this connection (e.g.
    // healthReconnectServer published a new conn before the SSE wrapper finished
    // reconnecting). Continuing would create an orphaned conn that the manager no longer
    // tracks, wasting resources and potentially firing stale onReconnected reconciles.
    if (this.closed || this.conn.superseded) return;

    const elapsed = Date.now() - (this.reconnectStartTime ?? Date.now());
    if (elapsed >= SSE_RECONNECT_GIVE_UP_MS) {
      logger.error(
        {
          server: this.conn.config.name,
          attempts: this.reconnectAttempts,
          elapsedMs: elapsed,
        },
        'MCP SSE reconnection time budget exhausted — giving up',
      );
      this.closed = true;
      this.markEvicted('budget-exhausted');
      return;
    }

    this.reconnectAttempts++;

    // Exponential backoff with ±25% jitter (matches Claude Code)
    const baseDelay = Math.min(
      SSE_RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      SSE_RECONNECT_MAX_DELAY_MS,
    );
    const jitter = baseDelay * 0.25 * (2 * Math.random() - 1);
    const delay = Math.max(0, baseDelay + jitter);

    logger.info(
      {
        server: this.conn.config.name,
        attempt: this.reconnectAttempts,
        delayMs: Math.round(delay),
        elapsedMs: Math.round(elapsed),
      },
      'MCP SSE scheduling reconnect',
    );

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  /** Attempt to create a new SSE transport and reconnect the client */
  private async attemptReconnect() {
    // PLAT-504: also guard on superseded here — the timer may have fired between the
    // scheduleReconnect check and the actual attempt (e.g. healthReconnectServer runs
    // concurrently and takes over before this fires).
    if (this.closed || this.conn.superseded) return;

    try {
      // The MCP SDK Client requires close() before connecting to a new transport.
      // Create a fresh Client instance to avoid "Already connected" errors.
      const newClient = new Client(
        { name: 'shizuha', version: '0.1.0' },
        { capabilities: {} },
      );

      // Close old client gracefully (best effort)
      try {
        await this.conn.client.close();
      } catch { /* ignore close errors — old connection is dead anyway */ }

      // Create fresh transport
      const newTransport = new SSEClientTransport(new URL(this.sseUrl.href), this.sseOpts);

      // Connect new client with new transport
      await newClient.connect(newTransport);

      // Swap in the new client and transport
      this.conn.client = newClient;
      this.conn.transport = newTransport;

      // P2 (PLAT-223): install handlers immediately after transport swap so any 401/403 that
      // arrives during the capability probe (below) is routed through broker-refresh-or-evict
      // rather than the generic error path which would just schedule another reconnect.
      this.setupTransportHandlers();

      // Refresh capabilities from the reconnected server (a restart may change them).
      this.conn.capabilities = newClient.getServerCapabilities();

      // USABILITY GATE: a reconnect counts as ALIVE only after a bounded, SUCCESSFUL
      // capability-appropriate probe. A connect-but-hang server accepts the socket but
      // hangs on MCP traffic; letting the probe throw (instead of swallowing) propagates to
      // the catch below → scheduleReconnect WITHOUT resetting the give-up budget, so a wedged
      // server eventually evicts instead of probing/reconnecting forever. The probe is
      // CAPABILITY-GATED so a healthy resources/prompts-only server (no tools to list) is not
      // falsely evicted on every reconnect: tools-capable → re-list tools (also refreshes the
      // schema); else resources-capable → a bounded listResources for liveness; else (neither)
      // → connect success is the only signal available, so accept it.
      if (this.conn.capabilities?.tools) {
        this.conn.tools = await listMCPToolsWithTimeout(
          this.conn.client,
          this.conn.config.name,
          SSE_TOOL_LIST_PROBE_MS,
        );
      } else {
        // No tools capability on the reconnected server — clear any stale tools so they
        // aren't left callable/routed to a server that no longer serves them (Codex L351).
        this.conn.tools = [];
        if (this.conn.capabilities?.resources) {
          await raceTimeout(this.conn.client.listResources(), SSE_TOOL_LIST_PROBE_MS, 'resource-list');
        }
      }

      // Reconcile the registry to the refreshed conn.tools: a changed-toolset reconnect
      // (A+B→A) otherwise leaves B's handler registered + routable to a server that no
      // longer serves it (Codex L349). The wrapper only updates conn.tools; the manager
      // owns the registry, so delegate the reconcile.
      // SCLI-19: a superseded connection (replaced by a manager reconnect) must not fire
      // a stale reconcile against the new registry, even if its SSE wrapper reconnects.
      if (!this.conn.superseded) {
        try { this.onReconnected?.(); }
        catch (err) { logger.warn({ server: this.conn.config.name, err }, 'MCP onReconnected reconcile threw'); }
      }

      // Usable connection confirmed (connected AND capability-probe passed) — reset the budget.
      this.reconnectAttempts = 0;
      this.reconnectStartTime = null;
      this.isReconnecting = false;
      // P1-1 (PLAT-223): reset so the next disconnection episode gets a fresh refresh attempt.
      // Without this reset, a second 401 hours later (on a long-lived agent) falls through to
      // immediate eviction — recreating the exact wedge this PR exists to fix.
      this.brokerRefreshAttempted = false;

      // Handlers already wired on newTransport above (P2 fix); reset liveness timer.
      this.resetLivenessTimer();

      logger.info(
        { server: this.conn.config.name, tools: this.conn.tools.length },
        'MCP SSE reconnected successfully',
      );
    } catch (err) {
      logger.warn(
        {
          server: this.conn.config.name,
          attempt: this.reconnectAttempts,
          err: (err as Error).message,
        },
        'MCP SSE reconnect attempt failed',
      );
      // Schedule next attempt
      this.scheduleReconnect();
    }
  }

  /** Call this when tool calls succeed — proves the connection is alive */
  markAlive() {
    if (this.isReconnecting) return;
    this.resetLivenessTimer();
  }

  /** Permanently stop reconnection (for shutdown) */
  destroy() {
    this.closed = true;
    this.clearLivenessTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// Track reconnect wrappers per connection for tool-call liveness updates
const sseReconnectWrappers = new WeakMap<MCPConnection, SSEReconnectWrapper>();

// ── Connection ──


function buildStreamableHttpTransportOptions(
  config: MCPServerConfig,
  headers?: Record<string, string>,
): ConstructorParameters<typeof StreamableHTTPClientTransport>[1] {
  const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
  const effectiveHeaders = headers ?? config.headers;
  if (effectiveHeaders && Object.keys(effectiveHeaders).length > 0) {
    opts.requestInit = { headers: { ...effectiveHeaders } };
  }
  if (config.reconnection) {
    opts.reconnectionOptions = {
      maxReconnectionDelay: config.reconnection.maxReconnectionDelay ?? 30000,
      initialReconnectionDelay: config.reconnection.initialReconnectionDelay ?? 1000,
      reconnectionDelayGrowFactor: config.reconnection.reconnectionDelayGrowFactor ?? 1.5,
      maxRetries: config.reconnection.maxRetries ?? 2,
    };
  }
  return opts;
}

function buildMCPClientOptions(
  serverName: string,
  onToolsChanged?: () => void,
  connRef?: { current?: MCPConnection },
): ConstructorParameters<typeof Client>[1] {
  const clientOptions: ConstructorParameters<typeof Client>[1] = {
    capabilities: {},
  };

  // Wire listChanged handler if callback provided
  if (onToolsChanged) {
    clientOptions.listChanged = {
      tools: {
        onChanged: (error) => {
          if (error) {
            logger.warn({ server: serverName, err: error }, 'MCP listChanged error');
            return;
          }
          // SCLI-19: drop stale notifications from a connection a reconnect superseded.
          if (connRef?.current?.superseded) return;
          onToolsChanged();
        },
      },
    };
  }

  return clientOptions;
}

export interface ConnectMCPOptions {
  /** Callback when the server notifies that its tool list has changed */
  onToolsChanged?: () => void;
  /** Callback when the server is permanently evicted (reconnect budget exhausted or 401/403/404) */
  onEvicted?: (reason: string, conn: MCPConnection) => void;
  /** Callback after a successful SSE auto-reconnect refreshes conn.tools — reconcile the registry */
  onReconnected?: () => void;
  /** Callback after auth refresh swaps a StreamableHTTP transport in place. */
  onTransportReplaced?: (conn: MCPConnection) => void;
}

/** Connect to an MCP server via stdio, SSE, Streamable HTTP, or WebSocket */
export async function connectMCP(
  config: MCPServerConfig,
  options?: ConnectMCPOptions,
): Promise<MCPConnection> {
  // SCLI-19: forward holder so the listChanged guard (inside buildMCPClientOptions)
  // can see this connection's superseded flag (conn is built later, then assigned
  // to connRef.current).
  const connRef: { current?: MCPConnection } = {};
  const clientOptions = buildMCPClientOptions(config.name, options?.onToolsChanged, connRef);

  const client = new Client(
    { name: 'shizuha', version: '0.1.0' },
    clientOptions,
  );

  // Pre-dial broker token refresh for platform-managed streamable-http servers
  // (CTX-4xx gateway-token-cliff). The reactive on-401 (callMCPTool) and PLS-115
  // proactive refreshers only run on an ESTABLISHED connection. Gateway agents
  // bake the broker JWT into config.headers once at startup; after the 24h token
  // cliff the connection is DOWN, so every reconnect re-dials with the expired
  // header. The server 401s the initialize, but StreamableHTTP surfaces that as a
  // 90s connect HANG (not a 401) — no refresher fires and the agent loses ALL
  // platform MCP (queue_empty → production stalls). The broker serves a fresh
  // token the whole time, so refresh the header from it BEFORE dialing whenever
  // it's expired/near-expiry/unparseable; every (re)connect then self-heals.
  if (
    config.transport === 'streamable-http'
    && (config.platformManaged || isShizuhaMcpService(config))
    && brokerExpected()
  ) {
    const expMs = decodeBearerExpMs(config.headers);
    const stale = expMs === null || expMs - Date.now() < PREDIAL_REFRESH_SKEW_MS;
    if (stale) {
      const bt = await fetchBrokerToken(5_000).catch(() => null);
      if (bt?.accessToken) {
        const refreshed = { ...(config.headers ?? {}) };
        if (!setAuthHeader(refreshed, 'authorization', bt.accessToken)) {
          refreshed['Authorization'] = `Bearer ${bt.accessToken}`;
        }
        // Mirror onto the delegated header when the service uses it, so both stay in sync.
        if (hasHeader(config.headers, 'x-shizuha-user-authorization')) {
          setAuthHeader(refreshed, 'x-shizuha-user-authorization', bt.accessToken);
        }
        config.headers = refreshed;
        logger.info({ server: config.name, wasExpired: expMs !== null && expMs <= Date.now() },
          'MCP pre-dial: refreshed platform auth from broker');
      } else {
        logger.warn({ server: config.name },
          'MCP pre-dial: broker token refresh returned nothing — dialing with existing header');
      }
    }
  }

  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;
  let sseUrl: URL | undefined;
  let sseOpts: ConstructorParameters<typeof SSEClientTransport>[1] | undefined;

  if (config.transport === 'stdio') {
    if (!config.command) throw new Error(`MCP server "${config.name}": stdio transport requires command`);
    const stdioTransport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...config.env } as Record<string, string>,
      stderr: process.env['SHIZUHA_MCP_STDERR'] === 'inherit' ? 'inherit' : 'pipe',
    });
    if (process.env['SHIZUHA_MCP_STDERR'] !== 'inherit') {
      stdioTransport.stderr?.on('data', () => {
        // Drain child stderr so MCP server diagnostics do not corrupt the TUI.
      });
    }
    transport = stdioTransport;
  } else if (config.transport === 'sse') {
    if (!config.url) throw new Error(`MCP server "${config.name}": sse transport requires url`);
    sseUrl = new URL(config.url);
    sseOpts = {};
    if (config.headers && Object.keys(config.headers).length > 0) {
      sseOpts.eventSourceInit = { fetch: (url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(config.headers!)) headers.set(k, v);
        return fetch(url, { ...init, headers });
      }};
      sseOpts.requestInit = { headers: { ...config.headers } };
    }
    transport = new SSEClientTransport(sseUrl, sseOpts);
  } else if (config.transport === 'streamable-http') {
    if (!config.url) throw new Error(`MCP server "${config.name}": streamable-http transport requires url`);
    transport = new StreamableHTTPClientTransport(new URL(config.url), buildStreamableHttpTransportOptions(config));
  } else if (config.transport === 'websocket') {
    if (!config.url) throw new Error(`MCP server "${config.name}": websocket transport requires url`);
    transport = new WebSocketClientTransport(new URL(config.url));
  } else {
    throw new Error(`MCP server "${config.name}": unknown transport "${config.transport}"`);
  }

  await client.connect(transport, { timeout: CONNECT_INIT_TIMEOUT_MS });

  // Read server metadata
  const capabilities = client.getServerCapabilities();
  const sv = client.getServerVersion();
  const serverVersion = sv ? { name: sv.name, version: sv.version } : undefined;
  const instructions = client.getInstructions();

  // List tools if supported
  let tools: MCPToolInfo[] = [];
  if (capabilities?.tools) {
    tools = await listMCPToolsWithTimeout(client, config.name, CONNECT_LIST_TIMEOUT_MS);
  }

  // List resources if supported
  let resources: MCPResourceInfo[] = [];
  if (capabilities?.resources) {
    try {
      const result = await raceTimeout(
        client.listResources(undefined, { timeout: CONNECT_RESOURCE_LIST_TIMEOUT_MS }),
        CONNECT_RESOURCE_LIST_TIMEOUT_MS,
        'resource-list',
      );
      resources = (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch (err) {
      logger.warn({ server: config.name, err }, 'Failed to list MCP resources');
    }
  }

  const conn: MCPConnection = { client, config, transport, capabilities, serverVersion, instructions, tools, resources };
  connRef.current = conn; // SCLI-19: wire the listChanged guard to this connection

  // For SSE transports: install Claude Code-style auto-reconnection
  if (config.transport === 'sse' && sseUrl && sseOpts) {
    const wrapper = new SSEReconnectWrapper(conn, sseUrl, sseOpts, options?.onEvicted, options?.onReconnected);
    sseReconnectWrappers.set(conn, wrapper);
  }

  // SCLI-70: for streamable-http transports with auth headers, register a
  // refresh callback so callMCPTool can recover from a 401 (expired JWT) by
  // re-reading the watchdog-maintained .mcp.json and reconnecting.
  if (config.transport === 'streamable-http' && config.headers && Object.keys(config.headers).length > 0) {
    const capturedName = config.name;
    const capturedHeaders = config.headers;
    const allowShizuhaTokenFallback = isShizuhaMcpService(config) || hasHeader(capturedHeaders, 'x-shizuha-user-authorization') ||
      hasHeader(capturedHeaders, 'x-shizuha-user-jwt-token') || hasHeader(capturedHeaders, 'x-shizuha-user-jwt');
    streamableHttpRefreshers.set(conn, {
      clientOptions,
      onTransportReplaced: options?.onTransportReplaced,
      refreshHeaders: async () => {
        // Primary: watchdog rewrites .mcp.json every 30 min — read fresh auth headers.
        const fromFile = await readFreshHeadersFromMcpJson(capturedName);
        if (fromFile) return fromFile;

        // Fallback only for Shizuha-owned MCP services. Never send a Shizuha JWT
        // to an arbitrary third-party Bearer-auth server after its own 401.
        if (!allowShizuhaTokenFallback) return null;
        const token = await getValidMcpAccessToken();
        if (!token) return null;

        const refreshed = { ...capturedHeaders };
        const updatedPrimary = setAuthHeader(refreshed, 'authorization', token);
        const updatedDelegated = setAuthHeader(refreshed, 'x-shizuha-user-authorization', token);
        if (!updatedPrimary) refreshed['Authorization'] = `Bearer ${token}`;
        if (!updatedDelegated) refreshed['X-Shizuha-User-Authorization'] = `Bearer ${token}`;
        return refreshed;
      },
    });
    // PLS-115: arm the proactive pre-expiry refresh now that the refresher is registered.
    scheduleProactiveRefresh(conn);
  }

  logger.info(
    { server: config.name, transport: config.transport, tools: tools.length, resources: resources.length },
    'MCP connected',
  );

  return conn;
}

// ── Tool Listing ──

/** Race a promise against a bounded timeout — a hung server must not block reconnect. */
function raceTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** Internal: list tools with a bounded timeout — a hung server must not block reconnect. */
function listMCPToolsWithTimeout(
  client: Client,
  serverName: string,
  timeoutMs: number,
): Promise<MCPToolInfo[]> {
  return raceTimeout(listMCPToolsInternal(client, serverName, timeoutMs), timeoutMs, 'tool-list');
}

/** Internal: list tools from a Client instance */
async function listMCPToolsInternal(client: Client, serverName: string, timeoutMs?: number): Promise<MCPToolInfo[]> {
  const result = await client.listTools(undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
  return (result.tools ?? []).map((t) => ({
    name: `mcp__${serverName}__${t.name}`,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    annotations: t.annotations ? {
      title: t.annotations.title,
      readOnlyHint: t.annotations.readOnlyHint,
      destructiveHint: t.annotations.destructiveHint,
      idempotentHint: t.annotations.idempotentHint,
      openWorldHint: t.annotations.openWorldHint,
    } : undefined,
  }));
}

/** List tools from an MCP connection (returns cached list) */
export function listMCPTools(conn: MCPConnection): MCPToolInfo[] {
  return conn.tools;
}

/** Refresh tools from server (re-fetches from server) */
export async function refreshMCPTools(conn: MCPConnection): Promise<MCPToolInfo[]> {
  conn.tools = await listMCPToolsInternal(conn.client, conn.config.name);
  return conn.tools;
}

// ── Tool Execution ──

/** Resolve the effective timeout for an MCP tool call */
function resolveToolTimeout(config: MCPServerConfig): number {
  if (config.toolTimeoutMs) return config.toolTimeoutMs;
  const envTimeout = process.env['MCP_TOOL_TIMEOUT'];
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

/** Combine an optional abort signal with a timeout into a single signal */
function combinedSignal(timeoutMs: number, abortSignal?: AbortSignal): AbortSignal {
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  if (!abortSignal) return timeoutSig;
  return AbortSignal.any([abortSignal, timeoutSig]);
}

/** Call an MCP tool with timeout, abort signal, and rich content handling */
export async function callMCPTool(
  conn: MCPConnection,
  toolName: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<MCPToolResult> {
  // Strip the mcp__<server>__ prefix to get the real tool name
  const prefix = `mcp__${conn.config.name}__`;
  const realName = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;

  const timeoutMs = resolveToolTimeout(conn.config);
  const signal = combinedSignal(timeoutMs, abortSignal);

  try {
    const result = await conn.client.callTool(
      { name: realName, arguments: args },
      undefined,
      { signal },
    );

    // Tool call succeeded — mark SSE connection as alive
    const wrapper = sseReconnectWrappers.get(conn);
    if (wrapper) wrapper.markAlive();

    const content = result.content as Array<Record<string, unknown>>;
    const isError = 'isError' in result ? (result.isError as boolean | undefined) : undefined;
    return processToolOutput(content, isError);
  } catch (err) {
    // Tool call failed — could be a dead SSE connection
    const wrapper = sseReconnectWrappers.get(conn);
    if (wrapper && conn.config.transport === 'sse') {
      const errMsg = (err as Error).message ?? '';
      // If the error suggests connection issues, trigger reconnect
      if (errMsg.includes('closed') || errMsg.includes('ECONNREFUSED') ||
          errMsg.includes('aborted') || errMsg.includes('fetch failed') ||
          errMsg.includes('network') || errMsg.includes('timeout')) {
        logger.warn(
          { server: conn.config.name, err: errMsg },
          'MCP tool call failed with connection error — triggering SSE reconnect',
        );
      }
    }

    // SCLI-70: streamable-http 401 recovery — re-read .mcp.json (watchdog-fresh
    // bearer), reconnect, retry ONCE. This breaks the haru-style pulse loop where
    // a 24h-expired JWT causes every MCP call to 401 until a manual restart.
    if (conn.config.transport === 'streamable-http' && isAuthError(err)) {
      const refreshContext = streamableHttpRefreshers.get(conn);
      if (refreshContext) {
        logger.warn({ server: conn.config.name }, 'MCP 401 on streamable-http — attempting auth refresh');
        try {
          const freshHeaders = await refreshContext.refreshHeaders();
          if (freshHeaders && conn.config.url) {
            // Swap onto a transport with the fresh token (shared with PLS-115 proactive path).
            await reconnectStreamableHttpWithHeaders(
              conn,
              freshHeaders,
              refreshContext.clientOptions,
              refreshContext.onTransportReplaced,
            );
            // PLS-115: re-arm the proactive timer against the new token's expiry so
            // the next refresh happens before expiry instead of on another 401.
            scheduleProactiveRefresh(conn);
            logger.info({ server: conn.config.name }, 'MCP auth refreshed — retrying tool call once');
            // One retry — do NOT loop (looping is the original bug).
            const retryResult = await conn.client.callTool(
              { name: realName, arguments: args },
              undefined,
              { signal: combinedSignal(timeoutMs, abortSignal) },
            );
            const retryContent = retryResult.content as Array<Record<string, unknown>>;
            const retryIsError = 'isError' in retryResult ? (retryResult.isError as boolean | undefined) : undefined;
            return processToolOutput(retryContent, retryIsError);
          }
        } catch (refreshErr) {
          logger.warn(
            { server: conn.config.name, err: (refreshErr as Error).message },
            'MCP auth-refresh or retry failed — propagating original 401',
          );
        }
      }
    }

    throw err;
  }
}

// ── Rich Content Processing ──

/** Process MCP tool output — handles text, image, audio, resource, resource_link content types */
export function processToolOutput(
  content: Array<Record<string, unknown>>,
  isError?: boolean,
): MCPToolResult {
  const textParts: string[] = [];
  let firstImage: ImageData | undefined;

  for (const item of content) {
    const type = item['type'] as string;

    switch (type) {
      case 'text':
        textParts.push(item['text'] as string ?? '');
        break;

      case 'image': {
        const data = item['data'] as string;
        const mimeType = item['mimeType'] as string;
        const supported = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
        if (data && mimeType && supported.includes(mimeType as typeof supported[number]) && !firstImage) {
          firstImage = { base64: data, mediaType: mimeType as ImageData['mediaType'] };
        } else {
          textParts.push(`[Image: ${mimeType ?? 'unknown type'}]`);
        }
        break;
      }

      case 'audio': {
        const mimeType = item['mimeType'] as string;
        textParts.push(`[Audio: ${mimeType ?? 'unknown type'}]`);
        break;
      }

      case 'resource': {
        const resource = item['resource'] as Record<string, unknown> | undefined;
        if (resource) {
          if (typeof resource['text'] === 'string') {
            textParts.push(resource['text']);
          } else if (typeof resource['blob'] === 'string') {
            const uri = resource['uri'] as string ?? 'unknown';
            textParts.push(`[Binary resource: ${uri}]`);
          }
        }
        break;
      }

      case 'resource_link': {
        const uri = item['uri'] as string;
        const name = item['name'] as string;
        textParts.push(`[Resource: ${name ?? 'unnamed'} (${uri ?? 'no URI'})]`);
        break;
      }

      default:
        // Unknown content type — include as text if possible
        if (typeof item['text'] === 'string') {
          textParts.push(item['text']);
        }
        break;
    }
  }

  let text = textParts.join('\n');

  // Output truncation: estimate tokens as text.length / 4, truncate at MAX_MCP_OUTPUT_TOKENS
  const estimatedTokens = Math.ceil(text.length / 4);
  if (estimatedTokens > MAX_MCP_OUTPUT_TOKENS) {
    const maxChars = MAX_MCP_OUTPUT_TOKENS * 4;
    text = text.slice(0, maxChars) +
      `\n\n[Output truncated: ~${estimatedTokens} tokens exceeded ${MAX_MCP_OUTPUT_TOKENS} token limit]`;
  }

  return { content: text, isError: isError ?? false, image: firstImage };
}

// ── Resource Reading ──

/** Read a resource from an MCP server */
export async function readMCPResource(
  conn: MCPConnection,
  uri: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (!conn.capabilities?.resources) {
    throw new Error(`MCP server "${conn.config.name}" does not support resources`);
  }

  const signal = combinedSignal(DEFAULT_RESOURCE_TIMEOUT_MS, abortSignal);

  const result = await conn.client.readResource(
    { uri },
    { signal },
  );

  // Mark alive on success
  const wrapper = sseReconnectWrappers.get(conn);
  if (wrapper) wrapper.markAlive();

  const parts: string[] = [];
  for (const item of result.contents) {
    if ('text' in item && typeof item.text === 'string') {
      parts.push(item.text);
    } else if ('blob' in item && typeof item.blob === 'string') {
      parts.push(`[Binary blob: ${item.uri}]`);
    }
  }
  return parts.join('\n');
}

// ── Disconnect ──

/** Disconnect from an MCP server */
export async function disconnectMCP(conn: MCPConnection): Promise<void> {
  // Destroy reconnect wrapper if exists
  const wrapper = sseReconnectWrappers.get(conn);
  if (wrapper) {
    wrapper.destroy();
    sseReconnectWrappers.delete(conn);
  }

  // PLS-115: cancel the proactive refresh timer so a disconnected server doesn't
  // keep reconnecting in the background.
  const proactiveTimer = proactiveRefreshTimers.get(conn);
  if (proactiveTimer) {
    clearTimeout(proactiveTimer);
    proactiveRefreshTimers.delete(conn);
  }

  try {
    await conn.client.close();
    logger.info({ server: conn.config.name }, 'MCP disconnected');
  } catch (err) {
    logger.warn({ server: conn.config.name, err }, 'MCP disconnect error');
  }
}
