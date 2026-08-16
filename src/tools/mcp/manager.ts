import type { MCPServerConfig } from '../../agent/types.js';
import type { MCPConnection, MCPToolInfo, MCPResourceInfo } from './client.js';
import type { ToolRegistry } from '../registry.js';
import { connectMCP, disconnectMCP, refreshMCPTools } from './client.js';
import { createMCPToolHandler } from './bridge.js';
import { logger } from '../../utils/logger.js';
import { setMcpReconnectConsecutiveFailures } from '../../metrics/registry.js';

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Per-connection timeout for MCP connect. Keep above the MCP SDK request timeout so slow stdio servers fail cleanly. */
const CONNECT_TIMEOUT_MS = positiveIntEnv('MCP_CONNECT_TIMEOUT_MS', 90_000);
/** Bound parallel MCP stdio startup; launching every server at once can starve slower agents and wedge Pulse tools. */
const CONNECT_CONCURRENCY = positiveIntEnv('MCP_CONNECT_CONCURRENCY', 3);
// SCLI-19: cap how long a reconnect waits on the OLD connection's graceful
// shutdown so a hung old transport can't stall the swap-in of the new one.
const DISCONNECT_TIMEOUT_MS = 5_000;

// ── PLAT-427: MCP auto-reconnect / health monitor ──
// A dropped MCP server (e.g. the `pulse` server during the s1 Pulse outage) used to stay
// permanently dead: connectAll() is one-shot, so its tools vanished from the registry and
// every `ToolSearch select:pulse_get_my_tasks` missed → the agent idled forever ("Pulse
// unavailable") until a manual `docker restart`. The monitor below periodically probes each
// server and redials the dead ones, re-registering their tools into the deferred-tool
// registry — no agent session reset, so zero context loss.

/** Liveness-probe timeout for the periodic health check (a hung server must not hang the loop). */
const HEALTH_PROBE_TIMEOUT_MS = positiveIntEnv('MCP_HEALTH_PROBE_TIMEOUT_MS', 15_000);
/** Interval between MCP health probes. `MCP_HEALTH_CHECK_INTERVAL_MS=0` disables the monitor. */
const HEALTH_CHECK_INTERVAL_MS = ((): number => {
  const raw = process.env['MCP_HEALTH_CHECK_INTERVAL_MS'];
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (!isNaN(n)) return n;
  }
  return 30_000;
})();
/** Capped-exponential backoff bounds for repeated reconnect failures (genuinely-down server). */
const RECONNECT_BACKOFF_BASE_MS = 5_000;
const RECONNECT_BACKOFF_MAX_MS = 5 * 60_000;
/** Retry interval for servers whose ROUTE is missing (405/501 — not deployed / no edge route). */
const ROUTE_MISSING_RETRY_MS = 60 * 60_000;

const MCP_START_PRIORITY = ['shizuha-pulse', 'shizuha-connect', 'shizuha-id', 'shizuha-wiki', 'shizuha-admin'];

function prioritizeConfigs(configs: MCPServerConfig[]): MCPServerConfig[] {
  return [...configs].sort((a, b) => {
    const ai = MCP_START_PRIORITY.indexOf(a.name);
    const bi = MCP_START_PRIORITY.indexOf(b.name);
    const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });
}

async function runBounded<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

function timeout<T>(ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    (timer as { unref?: () => void }).unref?.();
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}


/**
 * Apply per-agent MCP allow-list from SHIZUHA_MCP_SERVICES.
 * Value is a comma-separated list of MCP server names. Empty/unset means all configured servers.
 */
export function filterMCPConfigsByEnv(configs: MCPServerConfig[], raw = process.env['SHIZUHA_MCP_SERVICES']): MCPServerConfig[] {
  const allowed = new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  if (allowed.size === 0) return configs;
  return configs.filter((config) => allowed.has(config.name));
}

export class MCPManager {
  private connections = new Map<string, MCPConnection>();
  private toolRegistry: ToolRegistry | null = null;
  /** Callback invoked after dynamic tool refresh completes */
  onToolsRefreshed?: () => void;

  /** Wire the tool registry for dynamic listChanged refresh */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /** Servers that were configured but failed to connect */
  readonly failedServers: Array<{ name: string; error: string }> = [];

  // ── PLAT-427 reconnect state ──
  /** Persisted configs (incl. ones that failed initial connect) so the monitor knows how to redial. */
  private readonly configs = new Map<string, MCPServerConfig>();
  /** Periodic health-probe timer; null when the monitor is stopped/disabled. */
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** Servers with an in-flight (re)connect — prevents overlapping attempts from probe + onclose. */
  private readonly reconnecting = new Set<string>();
  /** Per-server earliest next reconnect time (ms epoch) for capped backoff. */
  private readonly nextRetryAt = new Map<string, number>();
  /** Per-server consecutive reconnect-failure count (drives backoff). */
  private readonly reconnectFailures = new Map<string, number>();
  /** Set by disconnectAll() — bails in-flight reconnects/probes so a redial scheduled by a
   *  transport onclose can't resurrect a connection after teardown (PLAT-427 review P2: shutdown race). */
  private disposed = false;

  /** Connect to all configured MCP servers (with per-connection timeout) */
  async connectAll(configs: MCPServerConfig[]): Promise<void> {
    this.disposed = false; // allow reuse after a prior disconnectAll()
    (this.failedServers as Array<{ name: string; error: string }>).length = 0;
    for (const config of configs) this.configs.set(config.name, config);
    logger.info({ total: configs.length, concurrency: CONNECT_CONCURRENCY, timeoutMs: CONNECT_TIMEOUT_MS }, 'MCP startup connect plan');
    await runBounded(prioritizeConfigs(configs), CONNECT_CONCURRENCY, async (config) => {
      try {
        const conn = await this.connectServer(config.name, config);
        this.wireTransportHandlers(config.name, conn);
        this.connections.set(config.name, conn);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ server: config.name, err }, 'Failed to connect MCP server');
        (this.failedServers as Array<{ name: string; error: string }>).push({ name: config.name, error: msg });
      }
    });
    // PLAT-427: keep probing + redial dead servers (incl. ones that failed above).
    this.startHealthMonitor();
  }

  private async connectServer(name: string, config: MCPServerConfig): Promise<MCPConnection> {
    return Promise.race([
      connectMCP(config, {
        onToolsChanged: () => this.refreshToolsForServer(name),
        onEvicted: (reason, conn) => this.evictServer(name, reason, conn),
        onReconnected: () => this.reconcileServerTools(name),
        onTransportReplaced: (conn) => this.wireTransportHandlers(name, conn),
      }),
      timeout<MCPConnection>(CONNECT_TIMEOUT_MS, `Connection timeout after ${CONNECT_TIMEOUT_MS}ms`),
    ]);
  }

  /**
   * PLAT-427: begin periodic liveness probing + auto-reconnect. Idempotent; `unref`'d so it
   * never keeps the process alive. Disabled when the interval is <= 0.
   */
  startHealthMonitor(intervalMs = HEALTH_CHECK_INTERVAL_MS): void {
    if (intervalMs <= 0 || this.healthTimer) return;
    this.healthTimer = setInterval(() => { void this.checkHealth(); }, intervalMs);
    (this.healthTimer as { unref?: () => void }).unref?.();
    logger.info({ intervalMs }, 'MCP health monitor started');
  }

  /** PLAT-427: stop the health monitor (called from disconnectAll). */
  stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * PLAT-427: probe every configured server and redial the dead/missing ones. A live server is
   * checked with a cheap protocol `ping` (short timeout); a server with no live connection is
   * redialed once its backoff window has elapsed.
   */
  private async checkHealth(): Promise<void> {
    if (this.disposed) return;
    const now = Date.now();
    await Promise.all([...this.configs.keys()].map(async (name) => {
      if (this.reconnecting.has(name)) return;
      const conn = this.connections.get(name);
      if (conn) {
        if (!(await this.probe(conn))) await this.healthReconnectServer(name);
      } else if (now >= (this.nextRetryAt.get(name) ?? 0)) {
        await this.healthReconnectServer(name);
      }
    }));
  }

  /**
   * PLAT-427 / SCLI-311: lightweight liveness probe.
   *
   * This MUST stay cheap. The platform MCP path is now a local stdio `mcp-proxy`; that proxy
   * already owns upstream streamable-HTTP liveness and reconnect. Probing it with `tools/list`
   * forwards a heavyweight schema request upstream every 30s per agent per server. When an
   * upstream probe is slow, the manager misclassifies the local stdio proxy as dead, respawns it,
   * and can then spend the full 90s connect budget re-initializing the same otherwise-healthy
   * server — the SCLI-311 reconnect-churn signature. `ping` is the MCP protocol liveness
   * primitive and the stdio proxy answers it locally, so manager health only proves the local
   * child/transport is alive while the proxy handles upstream health.
   */
  private async probe(conn: MCPConnection): Promise<boolean> {
    try {
      await Promise.race([
        conn.client.ping({ timeout: HEALTH_PROBE_TIMEOUT_MS }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('health probe timeout')), HEALTH_PROBE_TIMEOUT_MS)),
      ]);
      return true;
    } catch (err) {
      logger.warn({ server: conn.config.name, err }, 'MCP health probe failed — will reconnect');
      return false;
    }
  }

  /**
   * PLAT-427: (re)dial a single server and re-register its tools. Safe to call repeatedly:
   * guarded against overlap, capped-backoff on repeated failure, and it only mutates connection
   * state on a SUCCESSFUL redial — if the server is still down the redial just throws and a later
   * retry is scheduled. So a Pulse outage self-heals within one cycle of Pulse returning, with no
   * agent session reset (the dropped tools are re-registered into the deferred-tool registry that
   * `ToolSearch` reads), hence zero context loss.
   */
  private async healthReconnectServer(name: string): Promise<void> {
    if (this.disposed) return;
    if (this.reconnecting.has(name)) return;
    // PLAT-427 review (blocker): the backoff/cooldown gate applies to EVERY caller — including
    // the transport onclose path — so a flapping/crashlooping server can't tight-loop reconnects
    // into a fleet-wide storm that impedes the server's recovery. A fresh drop has nextRetryAt
    // unset (default 0) so it still redials promptly.
    if (Date.now() < (this.nextRetryAt.get(name) ?? 0)) return;
    const config = this.configs.get(name);
    if (!config) return;
    this.reconnecting.add(name);
    try {
      const old = this.connections.get(name);
      if (old) {
        // PLAT-912: mark superseded FIRST but do NOT remove from this.connections yet —
        // keep the old (dying) conn in the map so concurrent tool calls get a real transport
        // error rather than "MCP server not connected" during the re-dial window. The bridge
        // treats transport errors as retriable (shouldReconnectAfterToolError); "not connected"
        // causes a silent queue stall (the PLAT-912 symptom).
        old.superseded = true;
        await Promise.race([
          disconnectMCP(old),
          new Promise<void>(r => setTimeout(r, DISCONNECT_TIMEOUT_MS)),
        ]).catch(() => { /* best-effort teardown of the dead conn */ });
      }
      // PLAT-504: connectServer wires eviction + reconcile so health-monitor-established
      // connections have the same SSE reconnect resilience as connections from connectAll().
      const conn = await this.connectServer(name, config);
      // PLAT-427 review (P2): if disconnectAll() ran while we were redialing, don't resurrect.
      if (this.disposed) { await disconnectMCP(conn).catch(() => { /* ignore */ }); return; }
      this.wireTransportHandlers(name, conn);
      // PLAT-912: atomically swap old → new. Remove old (if present) then publish new so
      // there is no gap where getForTool returns undefined for this server name.
      if (old) this.connections.delete(name);
      this.connections.set(name, conn);
      // Success: reset the failure count (so a future failure starts fresh exponential backoff)
      // but KEEP a base-interval cooldown — a reconnect that succeeds then instantly drops again
      // (flapping server) must not tight-loop via onclose. Re-floored from now so it holds
      // regardless of how long the redial took.
      this.reconnectFailures.delete(name);
      setMcpReconnectConsecutiveFailures(name, 0);
      this.nextRetryAt.set(name, Date.now() + RECONNECT_BACKOFF_BASE_MS);
      const idx = this.failedServers.findIndex((f) => f.name === name);
      if (idx >= 0) (this.failedServers as Array<{ name: string; error: string }>).splice(idx, 1);
      // Re-register the server's tools so the deferred-tool registry is repopulated immediately.
      if (this.toolRegistry) {
        for (const tool of conn.tools) this.toolRegistry.upsert(createMCPToolHandler(tool, this));
      }
      logger.info({ server: name, tools: conn.tools.length }, 'MCP server reconnected');
      this.onToolsRefreshed?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fails = (this.reconnectFailures.get(name) ?? 0) + 1;
      this.reconnectFailures.set(name, fails);
      setMcpReconnectConsecutiveFailures(name, fails);
      // Route-level permanent rejections (endpoint not deployed / no nginx
      // route): 405/501 or nginx's "Not Allowed" page. Backoff-retrying these
      // every few minutes forever just burns cycles and floods error logs —
      // park with a long retry so a later route deployment still self-heals.
      const routeMissing = /\b(405|501)\b/.test(msg) || /not allowed/i.test(msg);
      const delay = routeMissing
        ? ROUTE_MISSING_RETRY_MS
        : Math.min(RECONNECT_BACKOFF_MAX_MS, RECONNECT_BACKOFF_BASE_MS * 2 ** (fails - 1));
      this.nextRetryAt.set(name, Date.now() + delay);
      if (!this.failedServers.some((f) => f.name === name)) {
        (this.failedServers as Array<{ name: string; error: string }>).push({ name, error: msg });
      }
      if (routeMissing) {
        logger.error({ server: name, err: msg, retryInMs: delay, event: 'mcp_route_missing' },
          'MCP endpoint route missing (405/501) — parking server, will re-check hourly');
      } else {
        logger.warn({ server: name, err, fails, retryInMs: delay }, 'MCP reconnect failed — will retry');
      }
    } finally {
      this.reconnecting.delete(name);
    }
  }

  /**
   * PLAT-427: wire transport close/error so a drop triggers an immediate reconnect attempt
   * rather than waiting for the next periodic probe. Preserves any pre-existing handler.
   */
  private wireTransportHandlers(name: string, conn: MCPConnection): void {
    const prevClose = conn.transport.onclose;
    conn.transport.onclose = () => {
      try { prevClose?.(); } catch { /* ignore */ }
      if (this.disposed) return; // don't schedule reconnects during/after teardown
      // SCLI-488: auth refresh deliberately closes the old transport before
      // publishing its replacement. That is not a backend failure and must not
      // fork a concurrent manager reconnect. The refresh callback re-wires the
      // replacement transport after Client.connect installs its own handlers.
      if (conn.refreshingTransport) return;
      logger.warn({ server: name }, 'MCP transport closed — scheduling reconnect');
      void this.healthReconnectServer(name);
    };
    const prevError = conn.transport.onerror;
    conn.transport.onerror = (err: Error) => {
      try { prevError?.(err); } catch { /* ignore */ }
      logger.warn({ server: name, err }, 'MCP transport error');
    };
  }

  /** Get a connection by server name */
  get(name: string): MCPConnection | undefined {
    return this.connections.get(name);
  }

  /** Get connection for a tool name (mcp__<server>__<tool>) */
  getForTool(toolName: string): MCPConnection | undefined {
    if (!toolName.startsWith('mcp__')) return undefined;
    const parts = toolName.split('__');
    const serverName = parts[1];
    return serverName ? this.connections.get(serverName) : undefined;
  }

  /** Reconnect the MCP server backing a tool and refresh its registered handlers. */
  async reconnectForTool(toolName: string): Promise<MCPConnection | undefined> {
    if (!toolName.startsWith('mcp__')) return undefined;
    const parts = toolName.split('__');
    const serverName = parts[1];
    return serverName ? this.reconnectServer(serverName) : undefined;
  }

  /** Reconnect a single MCP server using its existing config. */
  async reconnectServer(serverName: string): Promise<MCPConnection | undefined> {
    const previous = this.connections.get(serverName);
    if (!previous) return undefined;

    try {
      const next = await this.connectServer(previous.config.name, previous.config);

      // SCLI-19 (aoi): synchronously mark the OLD connection superseded so even a
      // disconnectMCP that hangs past DISCONNECT_TIMEOUT_MS cannot fire a stale
      // listChanged/onReconnected reconcile against the new registry.
      previous.superseded = true;

      // SCLI-19 (kei P2): PUBLISH `next` and sync the registry to it BEFORE awaiting
      // the old connection's bounded close. If we awaited first, `this.connections`
      // would still resolve `serverName` to `previous` during the wait, so a
      // NEW-server `tools/listChanged` (routed by server name) would refresh/no-op
      // the OLD superseded connection and the notification could be lost before
      // `next` is published with its stale snapshot. Publishing first means any
      // in-window refresh resolves to `next`; the old connection stays superseded
      // (its callbacks no-op) and is torn down immediately afterward.
      this.connections.set(serverName, next);

      if (this.toolRegistry) {
        const oldToolNames = new Set(previous.tools.map((t) => t.name));
        const newToolNames = new Set(next.tools.map((t) => t.name));
        for (const oldName of oldToolNames) {
          if (!newToolNames.has(oldName)) {
            this.toolRegistry.unregister(oldName);
          }
        }
        for (const tool of next.tools) {
          this.toolRegistry.upsert(createMCPToolHandler(tool, this));
        }
        this.onToolsRefreshed?.();
      }

      // Old connection is now superseded AND unreferenced (next is published) —
      // tear down its transport + listChanged subscriptions, bounded so a hung old
      // transport can't stall the reconnect. Best-effort: `next` is already live.
      // A stale onEvicted from `previous` during this wait is ignored by
      // evictServer's identity guard (conn !== this.connections.get(serverName)).
      await Promise.race([
        disconnectMCP(previous),
        new Promise<void>((resolve) => setTimeout(resolve, DISCONNECT_TIMEOUT_MS)),
      ]).catch((err) => {
        logger.debug({ server: serverName, err }, 'Old MCP connection cleanup after reconnect failed');
      });

      logger.info({ server: serverName, tools: next.tools.length }, 'MCP reconnected');
      this.reconnectFailures.delete(serverName);
      setMcpReconnectConsecutiveFailures(serverName, 0);
      return next;
    } catch (err) {
      const fails = (this.reconnectFailures.get(serverName) ?? 0) + 1;
      this.reconnectFailures.set(serverName, fails);
      setMcpReconnectConsecutiveFailures(serverName, fails);
      logger.warn({ server: serverName, err }, 'MCP reconnect failed');
      return undefined;
    }
  }

  /**
   * PLAT-912: ensure a server is connected, recovering immediately rather than waiting
   * for the next 30-second health probe. Used by the tool bridge when a tool call arrives
   * and the connection is absent — prevents silent "not connected" stalls after a Pulse
   * (or other MCP) rollout/restart.
   *
   * Behaviour:
   * - Connection already live → return it immediately (fast path).
   * - Reconnect already in flight → wait up to maxWaitMs for it to land.
   * - No connection and no reconnect in flight → bypass the backoff cooldown and force an
   *   immediate single reconnect attempt, then return whatever landed.
   */
  async ensureConnected(serverName: string, maxWaitMs = 8_000): Promise<MCPConnection | undefined> {
    const existing = this.connections.get(serverName);
    if (existing) return existing;

    const deadline = Date.now() + maxWaitMs;

    if (this.reconnecting.has(serverName)) {
      // Reconnect already running — poll briefly for it to finish rather than spawning a second.
      while (this.reconnecting.has(serverName) && Date.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 100));
      }
      return this.connections.get(serverName);
    }

    // Force an immediate attempt: clear the backoff so healthReconnectServer won't skip it.
    this.nextRetryAt.delete(serverName);
    await this.healthReconnectServer(serverName);
    return this.connections.get(serverName);
  }

  /** Expose all connections (for resource tool registration) */
  getAll(): Map<string, MCPConnection> {
    return this.connections;
  }

  /** Check if a server supports resources */
  hasResourceSupport(serverName: string): boolean {
    const conn = this.connections.get(serverName);
    return Boolean(conn?.capabilities?.resources);
  }

  /** List all cached tools across all connections (no server roundtrip) */
  listAllTools(): MCPToolInfo[] {
    const allTools: MCPToolInfo[] = [];
    for (const conn of this.connections.values()) {
      allTools.push(...conn.tools);
    }
    return allTools;
  }

  /** List all resources across all connections */
  listAllResources(): MCPResourceInfo[] {
    const allResources: MCPResourceInfo[] = [];
    for (const conn of this.connections.values()) {
      allResources.push(...conn.resources);
    }
    return allResources;
  }

  /** Handle listChanged notification — refresh tools for a single server */
  private async refreshToolsForServer(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    try {
      const oldToolNames = new Set(conn.tools.map((t) => t.name));
      const newTools = await refreshMCPTools(conn);
      const newToolNames = new Set(newTools.map((t) => t.name));

      // SCLI-19 (Codex P2): a tools/listChanged that arrived from this connection
      // just before it was superseded/replaced can land its refresh AFTER reconnect
      // published `next`. Re-check identity + superseded AFTER the await so a stale
      // in-flight refresh can never mutate the registry for a connection that is no
      // longer the live one (would re-add/remove tools from a dead connection).
      if (this.connections.get(serverName) !== conn || conn.superseded) {
        logger.debug({ server: serverName }, 'Ignoring stale MCP tools refresh from a replaced/superseded connection');
        return;
      }

      if (!this.toolRegistry) {
        logger.info({ server: serverName, tools: newTools.length }, 'MCP tools refreshed (no registry wired)');
        return;
      }

      // Unregister removed tools
      let removed = 0;
      for (const oldName of oldToolNames) {
        if (!newToolNames.has(oldName)) {
          this.toolRegistry.unregister(oldName);
          removed++;
        }
      }

      // Upsert new/changed tools
      let added = 0;
      for (const tool of newTools) {
        if (!oldToolNames.has(tool.name)) {
          added++;
        }
        // Always upsert — schema may have changed even if name didn't
        this.toolRegistry.upsert(createMCPToolHandler(tool, this));
      }

      logger.info({ server: serverName, added, removed, total: newTools.length }, 'MCP tools refreshed');
      this.onToolsRefreshed?.();
    } catch (err) {
      logger.warn({ server: serverName, err }, 'Failed to refresh MCP tools');
    }
  }

  /**
   * Permanently evict a dead MCP server: unregister its tools and drop the
   * connection so agents stop being offered (and calling) tools that hang.
   * Fired by the SSE reconnect wrapper's onEvicted callback (budget-exhausted
   * or 401/403/404). Idempotent. LOUD by design — a recurring eviction is a real
   * problem someone must see, not a silent capability loss.
   */
  evictServer(serverName: string, reason?: string, evictedConn?: MCPConnection): void {
    const conn = this.connections.get(serverName);
    if (!conn) return; // already evicted / never connected
    // RACE GUARD: only evict if the live connection is the SAME one that fired the eviction.
    // reconnectServer publishes a new connection before the old wrapper is disconnected; without
    // this check a STALE onEvicted from the OLD wrapper (hitting budget/permanent-error in that
    // window) would delete the freshly-reconnected HEALTHY connection.
    if (evictedConn && conn !== evictedConn) {
      logger.debug({ server: serverName, reason }, 'Ignoring stale MCP eviction for a replaced connection');
      return;
    }
    this.connections.delete(serverName);
    // PLAT-504: reset backoff counters so the health monitor re-dials promptly after
    // eviction rather than waiting out a stale retry window from a prior failed
    // healthReconnectServer (which could gate the redial for up to RECONNECT_BACKOFF_MAX_MS).
    this.nextRetryAt.delete(serverName);
    this.reconnectFailures.delete(serverName);

    let unregistered = 0;
    if (this.toolRegistry) {
      for (const tool of conn.tools) {
        this.toolRegistry.unregister(tool.name);
        unregistered++;
      }
      // Also unregister the synthetic resource-read tool (mcp__<server>__read_resource),
      // registered separately for resource-capable servers and NOT present in conn.tools —
      // otherwise it lingers after eviction and returns "not connected" on call.
      this.toolRegistry.unregister(`mcp__${serverName}__read_resource`);
    }

    logger.error(
      { server: serverName, reason: reason ?? 'unknown', tools: unregistered, event: 'mcp_server_evicted' },
      'MCP server evicted — unregistered tools and dropped connection',
    );

    // Best-effort cleanup of the dead connection (destroys the reconnect wrapper + closes the client).
    void disconnectMCP(conn).catch((err) =>
      logger.debug({ server: serverName, err }, 'Evicted MCP connection cleanup failed'),
    );

    this.onToolsRefreshed?.();
  }

  /**
   * Reconcile the registry to a connection's current conn.tools after an in-place SSE
   * auto-reconnect (the SSEReconnectWrapper updates conn.tools but not the registry).
   * Unregister this server's stale tool handlers no longer in conn.tools + (re)register the
   * current set, so a changed-toolset reconnect (A+B→A) doesn't leave B callable/routed to a
   * server that no longer serves it, and a tools-capability-less reconnect (conn.tools=[])
   * clears them all. SCLI-42 L349/L351. Idempotent.
   */
  reconcileServerTools(serverName: string): void {
    const conn = this.connections.get(serverName);
    if (!conn || !this.toolRegistry) return;
    const live = new Set(conn.tools.map((t) => t.name));
    const prefix = `mcp__${serverName}__`;
    const resourceTool = `${prefix}read_resource`;
    let removed = 0;
    for (const def of this.toolRegistry.definitions()) {
      if (!def.name.startsWith(prefix) || def.name === resourceTool) continue;
      if (!live.has(def.name)) { this.toolRegistry.unregister(def.name); removed++; }
    }
    for (const tool of conn.tools) this.toolRegistry.upsert(createMCPToolHandler(tool, this));
    // Drop the synthetic resource tool if the reconnected server no longer supports resources.
    if (!conn.capabilities?.resources && this.toolRegistry.unregister(resourceTool)) removed++;
    if (removed) logger.info({ server: serverName, removed, tools: conn.tools.length }, 'MCP registry reconciled after reconnect');
    this.onToolsRefreshed?.();
  }

  /** Disconnect all */
  async disconnectAll(): Promise<void> {
    this.disposed = true; // PLAT-427 review (P2): bail any in-flight reconnect so it can't resurrect a conn
    this.stopHealthMonitor(); // PLAT-427: stop probing before we tear down connections
    const tasks = [...this.connections.values()].map((conn) => disconnectMCP(conn));
    await Promise.all(tasks);
    this.connections.clear();
  }

  /** Number of active connections */
  get size(): number {
    return this.connections.size;
  }
}
