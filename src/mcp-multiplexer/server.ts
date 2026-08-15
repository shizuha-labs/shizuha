#!/usr/bin/env node
/**
 * Shizuha Per-Agent MCP Multiplexer (PLAT-3119)
 *
 * Replaces N separate `mcp-proxy` processes (one per platform MCP service) with
 * a SINGLE stdio MCP server that internally manages connections to all upstream
 * services. This reduces per-agent process count from N+1 to 2 (claude + one
 * multiplexer), cutting idle CPU from ~10-15% per proxy to a single process.
 *
 * DESIGN
 * ------
 *     claude-code  ──stdio (never drops)──▶  mcp-multiplexer  ──streamable-HTTP──▶  pulse
 *                                                                    ├── wiki
 *                                                                    ├── connect
 *                                                                    └── … (N services)
 *
 * The stdio side is a hand-rolled JSON-RPC server (like mcp-proxy). The
 * multiplexer presents as a SINGLE MCP server to claude-code, aggregating tools
 * and resources from all upstreams. Tool names are prefixed with the service
 * name (e.g. `pulse__get_task`, `wiki__search_pages`) so the multiplexer can
 * route `tools/call` to the correct upstream.
 *
 * Each upstream connection is independently managed with its own reconnect
 * loop, liveness probe, and token refresh — so one service's outage doesn't
 * affect others.
 *
 * METRICS
 * -------
 * A synthetic `__mcp_metrics` tool returns per-upstream and aggregate stats:
 *   - upstream count, connected count
 *   - per-upstream: reconnect count, liveness probe count/failures, state
 *   - process-level: CPU (via process.cpuUsage), memory, uptime
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResultSchema, type ServerCapabilities, type Implementation } from '@modelcontextprotocol/sdk/types.js';
import { buildUpstreamHeaders } from '../mcp-proxy/server.js';

// ── Types ──

export interface UpstreamServiceConfig {
  /** Logical service name, e.g. "pulse" */
  name: string;
  /** Full upstream streamable-HTTP MCP URL */
  url: string;
  /** Extra headers to send upstream (e.g. X-Organization-ID) */
  headers: Record<string, string>;
}

export interface MultiplexerConfig {
  /** All upstream services to connect to */
  services: UpstreamServiceConfig[];
  /** Interval for liveness probes (ms). 0 = disabled. */
  livenessIntervalMs: number;
}

// ── Constants ──

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const UPSTREAM_REQUEST_TIMEOUT_MS = 290_000;
const SESSION_RETRY_MAX = 5;
const SESSION_RETRY_DELAY_MS = 150;
const AUTH_RETRY_MAX = 45;
const AUTH_RETRY_DELAY_MS = 1_000;
const LIVENESS_PROBE_TIMEOUT_MS = 8_000;
const LIVENESS_FAILURES_BEFORE_RECONNECT = 3;
const DEFAULT_LIVENESS_INTERVAL_MS = 30_000;
export const DEFAULT_UPSTREAM_CONNECT_BUDGET_MS = 8_000;

export function upstreamConnectBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env['MCP_MUX_CONNECT_BUDGET_MS'] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_UPSTREAM_CONNECT_BUDGET_MS;
}

/**
 * Bound caller latency without cancelling the shared background reconnect.
 *
 * UpstreamConnection intentionally retries forever so a transient service
 * outage self-heals without respawning the stdio server.  An MCP initialize or
 * targeted call must not inherit that infinite wait, however: one bad service
 * used to hold the whole multiplexer handshake until the harness killed it.
 */
export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not connect within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Multiplexer parity with mcp-proxy: broker/file/env bearer beats stale args. */
export async function buildMultiplexerUpstreamHeaders(
  configuredHeaders: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  return buildUpstreamHeaders(configuredHeaders, env);
}

// ── Logging ──

function log(msg: string): void {
  process.stderr.write(`[mcp-mux] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

// ── Error classification (shared logic with mcp-proxy) ──

function isConnectionError(err: unknown): boolean {
  const msg = ((err as Error)?.message ?? String(err)).toLowerCase();
  return (
    msg.includes('closed') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('not connected') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('terminated') ||
    msg.includes('aborted') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('eai_again') ||
    msg.includes('enotfound') ||
    msg.includes('http 5') ||
    msg.includes('session') ||
    msg.includes('-32000')
  );
}

function isSessionError(err: unknown): boolean {
  const msg = ((err as Error)?.message ?? String(err)).toLowerCase();
  return (
    msg.includes('session not found') ||
    (msg.includes('session') &&
      (msg.includes('invalid') || msg.includes('expired') ||
       msg.includes('not found') || msg.includes('unknown') ||
       msg.includes('-32600')))
  );
}

function isAuthError(err: unknown): boolean {
  const msg = ((err as Error)?.message ?? String(err)).toLowerCase();
  return (
    msg.includes('http 401') || msg.includes('http 403') ||
    msg.includes('status 401') || msg.includes('status 403') ||
    msg.includes('401 unauthorized') || msg.includes('403 forbidden') ||
    ((msg.includes('401:') || msg.includes('streamable http error')) &&
      (msg.includes('invalid_token') || msg.includes('authentication required'))) ||
    msg.includes('token expired') || msg.includes('token_not_valid')
  );
}

// ── Upstream connection (one per service) ──

interface UpstreamMetrics {
  reconnectCount: number;
  livenessProbeCount: number;
  livenessFailureCount: number;
  lastConnectedAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
}

export class UpstreamConnection {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private capabilities: ServerCapabilities | undefined;
  private serverInfo: Implementation | undefined;
  private instructions: string | undefined;
  private generation = 0;
  private livenessTimer: NodeJS.Timeout | null = null;
  private livenessInFlight = false;
  private livenessFailureCount = 0;
  private activeForwardRequests = 0;
  private _connected = false;

  readonly metrics: UpstreamMetrics = {
    reconnectCount: 0,
    livenessProbeCount: 0,
    livenessFailureCount: 0,
    lastConnectedAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
  };

  constructor(
    readonly config: UpstreamServiceConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get connected(): boolean { return this._connected; }
  get upstreamCapabilities(): ServerCapabilities | undefined { return this.capabilities; }
  get upstreamServerInfo(): Implementation | undefined { return this.serverInfo; }
  get upstreamInstructions(): string | undefined { return this.instructions; }

  /** Start background liveness probing. */
  startLiveness(intervalMs: number): void {
    if (this.livenessTimer || intervalMs <= 0) return;
    const tick = async (): Promise<void> => {
      if (this.livenessInFlight || !this.client || this.activeForwardRequests > 0) return;
      this.livenessInFlight = true;
      this.metrics.livenessProbeCount++;
      try {
        await this.client.request({ method: 'ping', params: {} }, ResultSchema, { timeout: LIVENESS_PROBE_TIMEOUT_MS });
        this.livenessFailureCount = 0;
        this.metrics.livenessFailureCount = 0;
      } catch (err) {
        if (isConnectionError(err)) {
          this.livenessFailureCount++;
          this.metrics.livenessFailureCount = this.livenessFailureCount;
          if (this.livenessFailureCount >= LIVENESS_FAILURES_BEFORE_RECONNECT) {
            if (this.activeForwardRequests > 0) return;
            log(`liveness: "${this.config.name}" probe failed ${this.livenessFailureCount}x — proactive reconnect`);
            this.livenessFailureCount = 0;
            this.metrics.livenessFailureCount = 0;
            await this.invalidate().catch(() => {});
            this.warm();
          }
        }
      } finally {
        this.livenessInFlight = false;
      }
    };
    this.livenessTimer = setInterval(() => { void tick(); }, intervalMs);
    if (typeof this.livenessTimer.unref === 'function') this.livenessTimer.unref();
  }

  /** Stop liveness probing. */
  stopLiveness(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /** Ensure a live upstream client. Dedups concurrent callers. */
  async ensure(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithRetry();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** Bounded foreground wait; the deduplicated reconnect keeps warming behind it. */
  async ensureWithin(timeoutMs = upstreamConnectBudgetMs(this.env)): Promise<Client> {
    return settleWithin(this.ensure(), timeoutMs, `upstream "${this.config.name}"`);
  }

  /** Tear down the current session so next ensure() dials fresh. */
  async invalidate(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this._connected = false;
    this.generation++;
    if (client) { try { await client.close(); } catch { /* ignore */ } }
    if (transport) { try { await transport.close(); } catch { /* ignore */ } }
  }

  private async connectWithRetry(): Promise<Client> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.connectOnce();
      } catch (err) {
        attempt++;
        const base = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
        const jitter = base * 0.25 * (2 * Math.random() - 1);
        const delay = Math.max(0, Math.round(base + jitter));
        log(`"${this.config.name}" connect attempt ${attempt} failed: ${(err as Error).message} — retry in ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  private async connectOnce(): Promise<Client> {
    // The service JSON can outlive the JWT that created it.  Read the same
    // broker/token-file/env chain as mcp-proxy on every dial so the bridge's
    // in-process refresh actually reaches a long-lived multiplexer.  A legacy
    // configured Authorization header remains a fallback when no fresh bearer
    // source exists.
    const headers = await buildMultiplexerUpstreamHeaders(
      this.config.headers,
      this.env,
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers },
    });
    const client = new Client(
      { name: `shizuha-mcp-mux/${this.config.name}`, version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    this._connected = true;
    this.capabilities = client.getServerCapabilities();
    const sv = client.getServerVersion();
    this.serverInfo = sv ? { name: sv.name, version: sv.version } : undefined;
    this.instructions = client.getInstructions();
    this.metrics.reconnectCount++;
    this.metrics.lastConnectedAt = Date.now();
    log(`"${this.config.name}" connected (${this.serverInfo?.name ?? '?'})`);
    return client;
  }

  /**
   * Forward an MCP request to this upstream, with transparent reconnect+retry
   * on connection/auth/session failures.
   */
  async forward(method: string, params: unknown): Promise<unknown> {
    const req = { method, params: (params ?? {}) as Record<string, unknown> };
    this.activeForwardRequests++;
    try {
      for (let attempt = 0; ; attempt++) {
        const client = await this.ensureWithin();
        const genAtCall = this.generation;
        try {
          return await client.request(req, ResultSchema, { timeout: UPSTREAM_REQUEST_TIMEOUT_MS });
        } catch (err) {
          const authFail = isAuthError(err);
          if (!isConnectionError(err) && !authFail) throw err;
          const sessionLoss = isSessionError(err);
          const safeRetry = sessionLoss || authFail;
          const maxAttempts = authFail ? AUTH_RETRY_MAX : (sessionLoss ? SESSION_RETRY_MAX : 1);
          if (attempt >= maxAttempts) throw err;
          const kind = authFail ? 'auth' : (sessionLoss ? 'session-loss' : 'connection');
          log(`"${this.config.name}" ${method} failed (${kind}, attempt ${attempt + 1}/${maxAttempts + 1}): ${(err as Error).message} — reconnect+retry`);
          if (authFail) {
            try { fs.writeFileSync(path.join(process.cwd(), '.mcp-force-refresh'), String(genAtCall)); } catch { /* best-effort */ }
          }
          if (this.generation === genAtCall) {
            this.metrics.lastErrorAt = Date.now();
            this.metrics.lastErrorMessage = (err as Error).message;
            await this.invalidate();
          }
          if (safeRetry) await sleep(authFail ? AUTH_RETRY_DELAY_MS : SESSION_RETRY_DELAY_MS);
        }
      }
    } finally {
      this.activeForwardRequests--;
    }
  }

  /** Best-effort background warm-up. */
  warm(): void {
    this.ensure().catch(() => {});
  }

  /** Clean up resources. */
  async destroy(): Promise<void> {
    this.stopLiveness();
    await this.invalidate();
  }
}

// ── Tool name routing ──

/**
 * Parse a tool name to extract the upstream service name and the real tool name.
 * Tool names are formatted as `{service}__{tool}` (e.g. `pulse__get_task`).
 */
export function parseToolName(toolName: string): { service: string; tool: string } | null {
  const idx = toolName.indexOf('__');
  if (idx <= 0) return null;
  return { service: toolName.slice(0, idx), tool: toolName.slice(idx + 2) };
}

/**
 * Build a prefixed tool name from service name and real tool name.
 */
export function buildToolName(service: string, tool: string): string {
  return `${service}__${tool}`;
}

/**
 * Build a prefixed resource URI from service name and real resource URI.
 * Uses the same `__` separator as tool names to preserve the original URI
 * for round-trip reconstruction.
 */
export function buildResourceUri(service: string, uri: string): string {
  return `${service}__${uri}`;
}

/**
 * Parse a prefixed resource URI back to service name and real URI.
 */
export function parseResourceUri(prefixedUri: string): { service: string; uri: string } | null {
  const idx = prefixedUri.indexOf('__');
  if (idx <= 0) return null;
  return {
    service: prefixedUri.slice(0, idx),
    uri: prefixedUri.slice(idx + 2),
  };
}

// ── Multiplexer ──

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function writeStdout(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id: string | number, result: unknown): void {
  writeStdout({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number, code: number, message: string, data?: unknown): void {
  writeStdout({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export async function runMcpMultiplexer(config: MultiplexerConfig): Promise<void> {
  const upstreams = new Map<string, UpstreamConnection>();
  for (const svc of config.services) {
    upstreams.set(svc.name, new UpstreamConnection(svc));
  }

  log(`starting mcp-multiplexer for ${config.services.length} services: ${config.services.map(s => s.name).join(', ')}`);

  // Start liveness probes for all upstreams
  const livenessMs = config.livenessIntervalMs > 0 ? config.livenessIntervalMs : DEFAULT_LIVENESS_INTERVAL_MS;
  for (const [name, upstream] of upstreams) {
    upstream.warm();
    upstream.startLiveness(livenessMs);
  }

  async function handleRequest(msg: JsonRpcMessage): Promise<void> {
    const id = msg.id as string | number;
    const method = msg.method!;
    const params = msg.params as Record<string, unknown> | undefined;

    // ── initialize: connect all upstreams, aggregate capabilities ──
    if (method === 'initialize') {
      // Warm all upstreams in parallel, but never let one infinite reconnect
      // inherit into the stdio handshake. Timed-out upstreams continue warming
      // in the background and join later list/call requests once healthy.
      await Promise.allSettled(
        [...upstreams.values()].map(u => u.ensureWithin()),
      );

      // Aggregate capabilities: union of all upstream capabilities
      const aggregatedCaps: ServerCapabilities = {};
      for (const [name, upstream] of upstreams) {
        const caps = upstream.upstreamCapabilities;
        if (!caps) continue;
        if (caps.tools) aggregatedCaps.tools = caps.tools;
        if (caps.resources) aggregatedCaps.resources = caps.resources;
        if (caps.prompts) aggregatedCaps.prompts = caps.prompts;
        if (caps.logging) aggregatedCaps.logging = caps.logging;
        if (caps.experimental) aggregatedCaps.experimental = caps.experimental;
      }

      const clientProtocol = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
      sendResult(id, {
        protocolVersion: clientProtocol || DEFAULT_PROTOCOL_VERSION,
        capabilities: aggregatedCaps,
        serverInfo: { name: 'shizuha-mcp-multiplexer', version: '1.0.0' },
      });
      return;
    }

    // ── ping ──
    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    // ── tools/list: aggregate tools from all upstreams ──
    if (method === 'tools/list') {
      const toolSets = await Promise.all([...upstreams].map(async ([name, upstream]) => {
        try {
          const client = await upstream.ensureWithin();
          const result = await client.request(
            { method: 'tools/list', params: {} },
            ResultSchema,
            { timeout: 30_000 },
          ) as { tools?: Array<Record<string, unknown>> };
          return (result.tools ?? []).map(tool => ({
              ...tool,
              name: buildToolName(name, tool.name as string),
          }));
        } catch (err) {
          log(`"${name}" tools/list failed: ${(err as Error).message}`);
          return [];
        }
      }));
      sendResult(id, { tools: toolSets.flat() });
      return;
    }

    // ── tools/call: route to the correct upstream ──
    if (method === 'tools/call') {
      const fullName = (params as { name?: string })?.name ?? '';
      const parsed = parseToolName(fullName);
      if (!parsed) {
        sendError(id, -32602, `Invalid tool name "${fullName}" — expected "{service}__{tool}" format`);
        return;
      }
      const upstream = upstreams.get(parsed.service);
      if (!upstream) {
        sendError(id, -32602, `Unknown service "${parsed.service}" in tool name "${fullName}"`);
        return;
      }
      try {
        const result = await upstream.forward('tools/call', {
          name: parsed.tool,
          arguments: (params as { arguments?: unknown })?.arguments ?? {},
        });
        sendResult(id, result);
      } catch (err) {
        const code = typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code : -32603;
        sendError(id, code, (err as Error).message ?? 'upstream error', (err as { data?: unknown }).data);
      }
      return;
    }

    // ── resources/list: aggregate resources from all upstreams ──
    if (method === 'resources/list') {
      const resourceSets = await Promise.all([...upstreams].map(async ([name, upstream]) => {
        try {
          const client = await upstream.ensureWithin();
          const result = await client.request(
            { method: 'resources/list', params: {} },
            ResultSchema,
            { timeout: 30_000 },
          ) as { resources?: Array<Record<string, unknown>> };
          return (result.resources ?? []).map(res => ({
              ...res,
              uri: buildResourceUri(name, res.uri as string),
          }));
        } catch (err) {
          log(`"${name}" resources/list failed: ${(err as Error).message}`);
          return [];
        }
      }));
      sendResult(id, { resources: resourceSets.flat() });
      return;
    }

    // ── resources/read: route to the correct upstream ──
    if (method === 'resources/read') {
      const uri = (params as { uri?: string })?.uri ?? '';
      const parsed = parseResourceUri(uri);
      if (!parsed) {
        sendError(id, -32602, `Invalid resource URI "${uri}" — expected "{service}:..." format`);
        return;
      }
      const upstream = upstreams.get(parsed.service);
      if (!upstream) {
        sendError(id, -32602, `Unknown service "${parsed.service}" in resource URI "${uri}"`);
        return;
      }
      try {
        const result = await upstream.forward('resources/read', { uri: parsed.uri });
        sendResult(id, result);
      } catch (err) {
        const code = typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code : -32603;
        sendError(id, code, (err as Error).message ?? 'upstream error', (err as { data?: unknown }).data);
      }
      return;
    }

    // ── __mcp_metrics: return aggregate metrics ──
    if (method === '__mcp_metrics') {
      const cpuUsage = process.cpuUsage();
      const memUsage = process.memoryUsage();
      const upstreamMetrics: Record<string, unknown> = {};
      let connectedCount = 0;
      for (const [name, upstream] of upstreams) {
        if (upstream.connected) connectedCount++;
        upstreamMetrics[name] = {
          connected: upstream.connected,
          reconnectCount: upstream.metrics.reconnectCount,
          livenessProbeCount: upstream.metrics.livenessProbeCount,
          livenessFailureCount: upstream.metrics.livenessFailureCount,
          lastConnectedAt: upstream.metrics.lastConnectedAt,
          lastErrorAt: upstream.metrics.lastErrorAt,
          lastErrorMessage: upstream.metrics.lastErrorMessage,
        };
      }
      sendResult(id, {
        process: {
          pid: process.pid,
          uptimeMs: process.uptime() * 1000,
          cpuUser: cpuUsage.user,
          cpuSystem: cpuUsage.system,
          memoryRss: memUsage.rss,
          memoryHeapUsed: memUsage.heapUsed,
          memoryHeapTotal: memUsage.heapTotal,
        },
        upstreams: {
          total: upstreams.size,
          connected: connectedCount,
          details: upstreamMetrics,
        },
      });
      return;
    }

    // ── prompts/list: aggregate from all upstreams ──
    if (method === 'prompts/list') {
      const promptSets = await Promise.all([...upstreams].map(async ([, upstream]) => {
        try {
          const client = await upstream.ensureWithin();
          const result = await client.request(
            { method: 'prompts/list', params: {} },
            ResultSchema,
            { timeout: 30_000 },
          ) as { prompts?: Array<Record<string, unknown>> };
          return result.prompts ?? [];
        } catch { return []; }
      }));
      sendResult(id, { prompts: promptSets.flat() });
      return;
    }

    // ── prompts/get: route by service prefix in name ──
    if (method === 'prompts/get') {
      const name = (params as { name?: string })?.name ?? '';
      const parsed = parseToolName(name);
      if (!parsed) {
        sendError(id, -32602, `Invalid prompt name "${name}" — expected "{service}__{name}" format`);
        return;
      }
      const upstream = upstreams.get(parsed.service);
      if (!upstream) {
        sendError(id, -32602, `Unknown service "${parsed.service}" in prompt name "${name}"`);
        return;
      }
      try {
        const result = await upstream.forward('prompts/get', { ...params, name: parsed.tool });
        sendResult(id, result);
      } catch (err) {
        const code = typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code : -32603;
        sendError(id, code, (err as Error).message ?? 'upstream error', (err as { data?: unknown }).data);
      }
      return;
    }

    // ── Unknown method: try all upstreams (best-effort) ──
    // This handles methods like `logging/setLevel`, `completion/complete`, etc.
    for (const [, upstream] of upstreams) {
      try {
        const client = await upstream.ensureWithin();
        const result = await client.request(
          { method, params: params ?? {} },
          ResultSchema,
          { timeout: 30_000 },
        );
        sendResult(id, result);
        return;
      } catch {
        // Try next upstream
      }
    }
    sendError(id, -32601, `Method not found: ${method}`);
  }

  async function handleNotification(msg: JsonRpcMessage): Promise<void> {
    const method = msg.method!;
    if (method === 'notifications/initialized') return;
    // Forward notifications to all upstreams best-effort
    await Promise.allSettled([...upstreams.values()].map(async upstream => {
      try {
        const client = await upstream.ensureWithin();
        await (client as unknown as { notification: (n: unknown) => Promise<void> })
          .notification({ method, params: msg.params });
      } catch { /* best-effort */ }
    }));
  }

  // Read line-delimited JSON-RPC from stdin
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    if (!msg.method) return;
    if (msg.id !== undefined && msg.id !== null) {
      void handleRequest(msg).catch((err) => {
        log(`unhandled request error (${msg.method}): ${(err as Error).message}`);
        if (msg.id !== undefined && msg.id !== null) {
          sendError(msg.id as string | number, -32603, (err as Error).message ?? 'internal error');
        }
      });
    } else {
      void handleNotification(msg);
    }
  });

  rl.on('close', () => {
    log('stdin closed — exiting');
    process.exit(0);
  });

  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection (kept alive): ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    log(`uncaughtException (kept alive): ${err.message}`);
  });
}
