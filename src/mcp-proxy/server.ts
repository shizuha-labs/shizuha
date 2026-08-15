#!/usr/bin/env node
/**
 * Shizuha Local Stdio Reconnecting MCP Proxy (PLAT-504 / PLAT-427)
 *
 * Permanent fix for the "claude-code never reconnects platform MCP after a
 * backend restart" bug.
 *
 * THE PROBLEM
 * -----------
 * Agents run as a single long-lived Claude Code CLI process in *print mode*
 * (`-p ... --resume`). When they connect to a platform MCP server (pulse, wiki,
 * …) over `type:http`, claude-code registers that server's tool schemas once at
 * session start. When the backend restarts, the streamable-HTTP session drops
 * and claude-code's client gets permanently stuck "not connected":
 *   - print mode has NO background MCP reconnect (that only exists in the
 *     interactive REPL), and
 *   - even a transport-level reconnect would NOT re-register the tool schemas
 *     in an already-running session.
 * The endpoint, the token, and the streamable-HTTP transport are all fine — only
 * claude-code's *client* wedges.
 *
 * THE FIX (this module)
 * ---------------------
 * Insert a local stdio MCP server between claude-code and the remote backend:
 *
 *     claude-code  ──stdio (never drops)──▶  mcp-proxy  ──streamable-HTTP──▶  backend
 *
 * claude-code talks to a local stdio pipe that NEVER closes, so its registered
 * tools stay live for the whole session. This proxy owns the connection to the
 * remote backend and reconnects it transparently (exponential backoff, infinite
 * retries). Because the stdio side never drops, claude-code never sees a
 * disconnect and never needs to re-register tools — the exact failure that the
 * `type:http` form hits.
 *
 * DESIGN
 * ------
 * The stdio side is a hand-rolled JSON-RPC server over stdin/stdout rather than
 * the SDK's high-level `Server` class.
 * That class auto-answers `initialize` with ITS OWN serverInfo/capabilities and
 * asserts capability for each method — both wrong for a *transparent* proxy,
 * which must surface the UPSTREAM's real serverInfo/capabilities and pass any
 * method through untouched. The hand-rolled loop forwards every request to the
 * upstream verbatim and relays the response/error back.
 *
 * The upstream side is the SDK's high-level `Client` + `StreamableHTTPClient
 * Transport`. We use the generic `client.request(req, ResultSchema, …)` to
 * forward arbitrary MCP methods (tools/list, tools/call, resources/*, prompts/*,
 * …) without enumerating them. `ResultSchema` is the SDK's permissive
 * loose-object base, so every well-formed upstream result passes through.
 *
 * RECONNECT + TOKEN REFRESH
 * -------------------------
 *   - The bearer token is read FRESH from `MCP_UPSTREAM_BEARER` on EVERY
 *     (re)connect, so a daemon token refresh is picked up automatically the next
 *     time we dial upstream — no proxy restart needed.
 *   - A single shared connect promise dedups concurrent dials.
 *   - On an upstream error during a call, we drop the dead session, reconnect
 *     (fresh transport + fresh token), and retry the call ONCE. The stdio side
 *     stays alive throughout.
 *   - The process NEVER exits because the upstream is down — it just keeps
 *     retrying in the background.
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResultSchema, type ServerCapabilities, type Implementation } from '@modelcontextprotocol/sdk/types.js';
import { fetchBrokerToken } from '../auth/broker-token.js';

// ── Config resolution (pure, unit-testable) ──

export interface McpProxyConfig {
  /** Logical service name, e.g. "pulse" (used only for log labels). */
  name: string;
  /** Full upstream streamable-HTTP MCP URL, e.g. http://100.64.0.3/mcp/pulse/mcp */
  upstreamUrl: string;
  /** Extra headers to send upstream on every request (e.g. X-Organization-ID). */
  extraHeaders: Record<string, string>;
}

/**
 * Parse repeated `--header "Key: Value"` CLI args into a header map. Also
 * accepts `Key=Value`. Blank / malformed entries are skipped. Exported for
 * tests.
 */
export function parseExtraHeaders(raw: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw ?? []) {
    if (!entry) continue;
    const sep = entry.indexOf(':') >= 0 ? ':' : (entry.indexOf('=') >= 0 ? '=' : '');
    if (!sep) continue;
    const idx = entry.indexOf(sep);
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Resolve proxy config from parsed CLI options + env. The org id from
 * `MCP_UPSTREAM_ORG` is materialised into an `X-Organization-ID` header (unless
 * one was already supplied via `--header`). Exported for tests.
 */
export function resolveProxyConfig(
  opts: { name?: string; upstreamUrl?: string; header?: string[] },
  env: NodeJS.ProcessEnv,
): McpProxyConfig {
  const name = opts.name || env['MCP_UPSTREAM_NAME'] || 'upstream';
  const upstreamUrl = opts.upstreamUrl || env['MCP_UPSTREAM_URL'] || '';
  if (!upstreamUrl) {
    throw new Error('mcp-proxy: --upstream-url (or MCP_UPSTREAM_URL) is required');
  }
  const extraHeaders = parseExtraHeaders(opts.header);
  const org = (env['MCP_UPSTREAM_ORG'] ?? '').trim();
  if (org && !Object.keys(extraHeaders).some((k) => k.toLowerCase() === 'x-organization-id')) {
    extraHeaders['X-Organization-ID'] = org;
  }
  return { name, upstreamUrl, extraHeaders };
}

/**
 * Resolve the upstream bearer FRESH at (re)connect time.
 *
 * Order: `MCP_UPSTREAM_BEARER_FILE` (a path the bridge keeps rewritten with the
 * current JWT) read fresh from disk → `MCP_UPSTREAM_BEARER` env (the spawn-time
 * snapshot, used as seed/fallback). The file is the durable fix for the 24h
 * token cliff: a process env var is FROZEN at spawn, so a long-lived stdio proxy
 * could never pick up a refreshed token without a session restart. Reading the
 * file on each connect (and on a 401-triggered reconnect) makes refresh actually
 * take effect in-process. (PLAT-?? MCP-token-staleness fix.)
 */
export function resolveUpstreamBearer(env: NodeJS.ProcessEnv): string {
  // Try, in order: the explicit MCP_UPSTREAM_BEARER_FILE, then a well-known
  // DEFAULT path (<cwd>/.mcp-upstream-token) the bridge always keeps fresh. The
  // default-path read is the robustness fix: Claude Code respawns stdio MCP
  // servers without reliably carrying new env, so a proxy spawned from a config
  // that predates MCP_UPSTREAM_BEARER_FILE would otherwise be stuck on its frozen
  // env bearer. Reading the default path means ANY current-code proxy self-heals
  // off the bridge-maintained token file regardless of how it was spawned. cwd is
  // the agent workspace, where both .mcp.json and the token file live.
  const paths: string[] = [];
  const explicit = (env['MCP_UPSTREAM_BEARER_FILE'] ?? '').trim();
  if (explicit) paths.push(explicit);
  try { paths.push(path.join(process.cwd(), '.mcp-upstream-token')); } catch { /* no cwd */ }
  for (const p of paths) {
    try {
      const fromFile = fs.readFileSync(p, 'utf-8').trim();
      if (fromFile) return fromFile;
    } catch { /* missing/unreadable → try next / env seed */ }
  }
  return (env['MCP_UPSTREAM_BEARER'] ?? '').trim();
}

/**
 * Resolve the bearer FRESH, preferring the per-agent broker sidecar.
 *
 * Order: broker `GET /token` (freshest — the sidecar mints/refreshes the JWT
 * continuously, so this SELF-HEALS the 24h token cliff for ANY caller that has
 * no bridge rewriting the token file, e.g. gateway agents that route platform
 * MCP through this proxy) → `MCP_UPSTREAM_BEARER_FILE`/default token file →
 * `MCP_UPSTREAM_BEARER` env seed. The broker socket is inherited from the
 * spawning process env (MCP_AUTH_PROXY_SOCKET / default UDS); when absent this
 * transparently falls back to the file/env path used by bridge agents.
 */
async function resolveUpstreamBearerFresh(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const bt = await fetchBrokerToken(4_000);
    if (bt?.accessToken) return bt.accessToken;
  } catch { /* broker absent / not ready / errored → fall back to file/env */ }
  return resolveUpstreamBearer(env);
}

/** Build the per-request header set, reading the bearer FRESH (broker > file > env). */
export async function buildUpstreamHeaders(extraHeaders: Record<string, string>, env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const bearer = await resolveUpstreamBearerFresh(env);
  return {
    ...extraHeaders,
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
}

// ── Reconnecting upstream client ──

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** Methods are forwarded with a generous timeout; tools/call can be slow. */
const UPSTREAM_REQUEST_TIMEOUT_MS = 290_000;
/**
 * Upstream "Session not found" recovery (PLAT-518). When the backend is HA
 * (>1 replica) and streamable-HTTP sessions are NOT affinity-routed, a request
 * can land on a replica that doesn't hold the session → pre-handler rejection
 * ("Session not found"). Because the call never executed, retrying is SAFE; each
 * retry re-initializes (fresh session, possibly a different replica), so a few
 * attempts converge with high probability. A *generic* connection error MIGHT
 * have executed, so that path still retries only once (avoid duplicate effects).
 */
const SESSION_RETRY_MAX = 5;
const SESSION_RETRY_DELAY_MS = 150;
// PLS-120: a 401 can mean the bridge must force-mint a replacement token after
// seeing `.mcp-force-refresh`. That bridge-side poll is asynchronous, so hiding
// the auth error from the agent requires a longer transparent retry window than
// the quick HA session-loss retry. Keep this bounded below the request timeout.
export const AUTH_RETRY_MAX = 45;
export const AUTH_RETRY_DELAY_MS = 1_000;
/**
 * Liveness probes are advisory. A single 8s timeout can be caused by an
 * overloaded MCP backend or transient fabric hiccup; invalidating immediately
 * closes the shared streamable-HTTP session and can abort an in-flight agent
 * turn. Only reconnect after repeated idle-probe failures.
 */
export const LIVENESS_PROBE_TIMEOUT_MS = 8_000;
export const LIVENESS_FAILURES_BEFORE_RECONNECT = 3;

export function shouldReconnectAfterLivenessFailure(consecutiveFailures: number): boolean {
  return consecutiveFailures >= LIVENESS_FAILURES_BEFORE_RECONNECT;
}

function log(msg: string): void {
  // stderr only — stdout is the JSON-RPC channel to claude-code.
  process.stderr.write(`[mcp-proxy] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Owns the streamable-HTTP connection to the remote MCP server and keeps it
 * healthy with infinite-retry exponential backoff. Forwards arbitrary MCP
 * requests via the generic `Client.request()`.
 */
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

  constructor(private readonly config: McpProxyConfig) {}

  /**
   * Background liveness probe (parity with the scaffold's SSEReconnectWrapper,
   * src/tools/mcp/client.ts). Streamable-HTTP is request/response with no
   * persistent stream, so an IDLE backend restart is otherwise invisible until
   * the next real call — which then eats a full reconnect cycle. Probing keeps
   * the upstream session warm AND heals an idle drop proactively, so the next
   * tools/call from claude-code is instant. Cheap `ping`, short timeout, never
   * fatal, never overlapping.
   */
  startLiveness(intervalMs = 30_000): void {
    if (this.livenessTimer) return;
    const tick = async (): Promise<void> => {
      // Never let the background probe close the shared upstream session while a
      // real tool call is using it. PLAT-2970 observed `health probe timeout`
      // reconnects killing in-flight turns and causing re-pickup loops.
      if (this.livenessInFlight || !this.client || this.activeForwardRequests > 0) return;
      this.livenessInFlight = true;
      try {
        await this.client.request({ method: 'ping', params: {} }, ResultSchema, { timeout: LIVENESS_PROBE_TIMEOUT_MS });
        this.livenessFailureCount = 0;
      } catch (err) {
        if (isConnectionError(err)) {
          this.livenessFailureCount++;
          if (shouldReconnectAfterLivenessFailure(this.livenessFailureCount)) {
            if (this.activeForwardRequests > 0) {
              log(`liveness: "${this.config.name}" probe failed ${this.livenessFailureCount}x (${(err as Error).message}) but ${this.activeForwardRequests} request(s) are active — postponing reconnect`);
              return;
            }
            log(`liveness: "${this.config.name}" probe failed ${this.livenessFailureCount}x (${(err as Error).message}) — proactive reconnect`);
            this.livenessFailureCount = 0;
            await this.invalidate().catch(() => { /* already dead */ });
            this.warm(); // re-establish now so claude-code's next call doesn't wait
          }
        }
        // a non-connection error from ping is ignored (server quirk); keep probing
      } finally {
        this.livenessInFlight = false;
      }
    };
    this.livenessTimer = setInterval(() => { void tick(); }, intervalMs);
    if (typeof this.livenessTimer.unref === 'function') this.livenessTimer.unref();
  }

  /**
   * Ensure a live upstream client. Dedups concurrent callers behind one connect
   * promise. Retries forever (exponential backoff) — resolves only once a
   * session is established, so the stdio side simply waits instead of erroring.
   */
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

  /** Current upstream capabilities (populated after first connect). */
  getCapabilities(): ServerCapabilities | undefined { return this.capabilities; }
  /** Current upstream serverInfo (populated after first connect). */
  getServerInfo(): Implementation | undefined { return this.serverInfo; }
  /** Current upstream instructions (populated after first connect). */
  getInstructions(): string | undefined { return this.instructions; }

  /**
   * Tear down the current (presumed dead) session so the next ensure() dials a
   * fresh one with a freshly-read token. Idempotent.
   */
  async invalidate(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.generation++;
    if (client) { try { await client.close(); } catch { /* already dead */ } }
    if (transport) { try { await transport.close(); } catch { /* already dead */ } }
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
        log(`upstream "${this.config.name}" connect attempt ${attempt} failed: ${(err as Error).message} — retrying in ${delay}ms`);
        await sleep(delay);
        // loop forever; the stdio side stays alive while we keep trying
      }
    }
  }

  /** One connect attempt: fresh transport, fresh token, MCP initialize handshake. */
  private async connectOnce(): Promise<Client> {
    const headers = await buildUpstreamHeaders(this.config.extraHeaders, process.env);
    const transport = new StreamableHTTPClientTransport(new URL(this.config.upstreamUrl), {
      requestInit: { headers },
    });
    const client = new Client(
      { name: `shizuha-mcp-proxy/${this.config.name}`, version: '1.0.0' },
      { capabilities: {} },
    );
    // connect() performs the MCP initialize handshake; on success the upstream's
    // real serverInfo + capabilities are available.
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    this.capabilities = client.getServerCapabilities();
    const sv = client.getServerVersion();
    this.serverInfo = sv ? { name: sv.name, version: sv.version } : undefined;
    this.instructions = client.getInstructions();
    log(`upstream "${this.config.name}" connected (serverInfo=${this.serverInfo?.name ?? '?'})`);
    return client;
  }

  /**
   * Forward an arbitrary MCP request to the upstream, with one transparent
   * reconnect+retry on a connection-level failure. `ResultSchema` is the
   * permissive loose-object base so any well-formed result passes through.
   */
  async forward(method: string, params: unknown): Promise<unknown> {
    const req = { method, params: (params ?? {}) as Record<string, unknown> };
    this.activeForwardRequests++;
    try {
      // attempt 0 = first try; on a connection-level failure we reconnect+retry.
      // Session-loss (PLAT-518) is safe to retry several times (pre-handler reject;
      // each retry re-initializes a fresh session, possibly on a different HA
      // replica → converges). A generic connection error retries only ONCE — it
      // might have executed, so we avoid duplicate side-effects.
      for (let attempt = 0; ; attempt++) {
        const client = await this.ensure();
        const genAtCall = this.generation;
        try {
          return await client.request(req, ResultSchema, { timeout: UPSTREAM_REQUEST_TIMEOUT_MS });
        } catch (err) {
          const authFail = isAuthError(err);
          // Auth + session failures are pre-handler rejections (the tool never ran),
          // so they're safe to retry a few times. Auth retry re-reads the bearer
          // FILE on reconnect → picks up a token the bridge refreshed ahead of
          // expiry, self-healing the 24h-token cliff without an agent restart.
          if (!isConnectionError(err) && !authFail) throw err; // a real upstream/tool error — surface verbatim
          const sessionLoss = isSessionError(err);
          const safeRetry = sessionLoss || authFail;
          const maxAttempts = authFail ? AUTH_RETRY_MAX : (sessionLoss ? SESSION_RETRY_MAX : 1);
          if (attempt >= maxAttempts) throw err; // retries exhausted — surface the failure
          const kind = authFail ? 'auth' : (sessionLoss ? 'session-loss' : 'connection');
          log(`upstream "${this.config.name}" request ${method} failed (${kind}, attempt ${attempt + 1}/${maxAttempts + 1}): ${(err as Error).message} — reconnect+retry`);
          // On an auth failure, re-reading the bearer FILE only heals an EXPIRED token
          // (the bridge's 30min tick rewrote it). A token the server invalidated while
          // still time-valid (id/broker restart, key rotation) is NOT stale, so the
          // bridge's refresh is a no-op and the file keeps the rejected token → flap.
          // Drop a sentinel the bridge's fast tick force-mints on (bypassing the stale
          // gate), so the next reconnect re-reads a genuinely-fresh token. Best-effort.
          if (authFail) {
            try { fs.writeFileSync(path.join(process.cwd(), '.mcp-force-refresh'), String(genAtCall)); } catch { /* best-effort */ }
          }
          // Only invalidate if nobody else already swapped the session out from under us.
          if (this.generation === genAtCall) await this.invalidate();
          if (safeRetry) await sleep(authFail ? AUTH_RETRY_DELAY_MS : SESSION_RETRY_DELAY_MS);
        }
      }
    } finally {
      this.activeForwardRequests--;
    }
  }

  /** Best-effort background warm-up so the first real request is fast. */
  warm(): void {
    this.ensure().catch(() => { /* connectWithRetry never rejects; defensive */ });
  }
}

/**
 * Classify an error as a connection-level failure (worth a reconnect+retry) vs.
 * a genuine application/tool error (which must be surfaced verbatim so the agent
 * sees the real message). Conservative: only treat clearly transport-ish errors
 * as reconnectable.
 */
export function isConnectionError(err: unknown): boolean {
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
    msg.includes('http 5') ||           // 5xx upstream
    msg.includes('session') ||          // streamable-HTTP session expired/invalid
    msg.includes('-32000')              // MCP "Connection closed" JSON-RPC code
  );
}

/**
 * A specifically *session-invalid* upstream error (e.g. an HA replica that does
 * not hold this streamable-HTTP session → "Session not found"). This is a
 * pre-handler rejection: the call never ran, so it is SAFE to re-initialize and
 * retry multiple times. Subset of isConnectionError. (PLAT-518)
 */
export function isSessionError(err: unknown): boolean {
  const msg = ((err as Error)?.message ?? String(err)).toLowerCase();
  return (
    msg.includes('session not found') ||
    (msg.includes('session') &&
      (msg.includes('invalid') || msg.includes('expired') ||
       msg.includes('not found') || msg.includes('unknown') ||
       msg.includes('-32600')))
  );
}

/**
 * An auth failure (expired/invalid bearer). The bridge keeps the bearer FILE
 * refreshed ahead of expiry, so a reconnect re-reads a fresh token — making this
 * SAFE to retry. This is the durable fix for the "MCP goes down at the 24h token
 * expiry until the agent restarts" outage: a 401 now self-heals via
 * reconnect-with-fresh-token instead of hard-failing the call. Like a session
 * error, this is a pre-handler rejection (auth is checked before the tool runs),
 * so retrying does not duplicate side-effects.
 */
export function isAuthError(err: unknown): boolean {
  const msg = ((err as Error)?.message ?? String(err)).toLowerCase();
  // Keep this to TRANSPORT/HTTP-level auth signals only — NOT bare words like
  // "forbidden"/"unauthorized" which a legitimate tool error could contain (we
  // don't want to re-run a real tool error). The streamable-HTTP transport
  // surfaces these as "...(HTTP 401)..." / "...(HTTP 403)...".
  return (
    msg.includes('http 401') || msg.includes('http 403') ||
    msg.includes('status 401') || msg.includes('status 403') ||
    msg.includes('401 unauthorized') || msg.includes('403 forbidden') ||
    // Some streamable-HTTP stacks surface auth failures as:
    //   "401: Streamable HTTP error: ... invalid_token ..."
    // (without the literal "HTTP 401" substring). Match only when the
    // transport/status context is present so tool-level text is not retried.
    ((msg.includes('401:') || msg.includes('streamable http error')) &&
      (msg.includes('invalid_token') || msg.includes('authentication required'))) ||
    msg.includes('token expired') || msg.includes('token_not_valid')
  );
}

// ── Stdio JSON-RPC server (faces claude-code) ──

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

function sendNotification(method: string, params?: unknown): void {
  writeStdout({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
}

/** Default protocol version echoed if the client didn't send one. */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export async function runMcpProxy(config: McpProxyConfig): Promise<void> {
  const upstream = new UpstreamConnection(config);
  log(`starting stdio proxy for "${config.name}" → ${config.upstreamUrl}`);

  async function handleRequest(msg: JsonRpcMessage): Promise<void> {
    const id = msg.id as string | number; // requests always carry an id
    const method = msg.method!;
    const params = msg.params;

    // `initialize` is the one method we answer locally: connect upstream, then
    // hand claude-code the UPSTREAM's real serverInfo + capabilities so its
    // registered tool surface matches what the backend actually serves.
    if (method === 'initialize') {
      try {
        await upstream.ensure();
      } catch {
        // ensure() retries forever and won't normally reject; if it somehow
        // does, fall through with whatever (possibly undefined) metadata we have
        // so the handshake still completes and the stdio side stays usable.
      }
      const clientProtocol = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
      const caps = upstream.getCapabilities() ?? {};
      const serverInfo = upstream.getServerInfo() ?? { name: `shizuha-mcp-proxy/${config.name}`, version: '1.0.0' };
      const instructions = upstream.getInstructions();
      sendResult(id, {
        protocolVersion: clientProtocol || DEFAULT_PROTOCOL_VERSION,
        capabilities: caps,
        serverInfo,
        ...(instructions ? { instructions } : {}),
      });
      return;
    }

    // ping is cheap and must work even if upstream is mid-reconnect.
    if (method === 'ping') {
      sendResult(id, {});
      return;
    }

    // Everything else is forwarded transparently to the upstream.
    try {
      const result = await upstream.forward(method, params);
      sendResult(id, result);
    } catch (err) {
      // Map an MCP/JSON-RPC error through with its original code when we can; the
      // SDK throws McpError with a numeric `.code`.
      const code = typeof (err as { code?: unknown }).code === 'number'
        ? (err as { code: number }).code
        : -32603; // InternalError
      const data = (err as { data?: unknown }).data;
      sendError(id, code, (err as Error).message ?? 'proxy error', data);
    }
  }

  async function handleNotification(msg: JsonRpcMessage): Promise<void> {
    const method = msg.method!;
    // `notifications/initialized` is part of the local handshake — don't forward.
    if (method === 'notifications/initialized') return;
    // Forward other client→server notifications upstream best-effort.
    try {
      const client = await upstream.ensure();
      // The SDK validates outbound notifications against ServerNotification; an
      // unknown client notification may be rejected. Best-effort, never fatal.
      await (client as unknown as { notification: (n: unknown) => Promise<void> })
        .notification({ method, params: msg.params });
    } catch (err) {
      log(`dropping client notification ${method}: ${(err as Error).message}`);
    }
  }

  // Read line-delimited JSON-RPC from stdin.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // skip malformed input
    }
    if (!msg.method) return; // a response to a server→client request; nothing to do
    // Requests have an id; notifications don't.
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

  // If claude-code closes stdin, the session is over — exit cleanly.
  rl.on('close', () => {
    log(`stdin closed for "${config.name}" — exiting`);
    process.exit(0);
  });

  // CRITICAL: the proxy must NEVER exit because the upstream is down. An
  // unhandled upstream rejection/exception must not kill the process — log and
  // keep the stdio side alive so claude-code never sees a disconnect.
  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection (kept alive): ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    log(`uncaughtException (kept alive): ${err.message}`);
  });

  // Warm the upstream in the background so the first tools/list is fast, and so
  // we begin healing immediately if the backend is down at startup.
  upstream.warm();
  // Proactively keep the upstream session warm + heal idle drops (scaffold parity).
  upstream.startLiveness();
}
