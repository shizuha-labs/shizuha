/**
 * Antigravity Bridge — bridges Antigravity CLI (`agy`) to the gateway HTTP/WS protocol.
 *
 * When the execution method is `antigravity_server`, the daemon spawns this instead of
 * `shizuha.js gateway`. It:
 *   1. Starts an HTTP/WS server on the same port the dashboard expects
 *   2. Runs `agy -p` (print mode) per user turn — Gemini CLI / `--acp` is never used
 *   3. Streams stdout (text or stream-json) back to WS clients
 *   4. Preserves direct-turn continuity by explicit conversation ID while
 *      autonomous heartbeats always use a fresh conversation
 *
 * Gemini CLI was permanently removed. Install source is the official Antigravity
 * release channel (https://antigravity.google/cli/install.sh), binary names `agy`
 * / `antigravity` only.
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
// @ts-ignore — ws has no declaration file
import { WebSocketServer, WebSocket } from 'ws';
import { resolveBrowserMcpServer } from '../browser-mcp.js';
import {
  brokerExpected,
  fetchBrokerModelToken,
  type BrokerModelToken,
} from '../auth/broker-token.js';
import {
  CODEX_HEARTBEAT_TRIGGER,
  parsePulseHeartbeatPreflightResponse,
  resolveIdleHeartbeatMs,
  type PulseHeartbeatPreflightDecision,
} from '../codex-bridge/index.js';
import {
  ActivityPhaseTracker,
  applyAgentEventToPhase,
  buildActivityTelemetry,
  createTelemetryFlusher,
} from '../telemetry/activity-phase.js';
import {
  formatHeartbeatQueueDrainOutcomeLogLine,
  heartbeatQueueDrainTelemetry,
  recordHeartbeatQueueDrainOutcome,
  recordHeartbeatQueueDrainTurn,
  type HeartbeatQueueDrainTurnToolCall,
  type HeartbeatQueueDrainTurnToolResult,
} from '../daemon/heartbeat-outcome.js';

// ── Types ──

interface AntigravityBridgeOptions {
  port: number;
  host: string;
  model: string;
  agentId?: string;
  agentName?: string;
  agentUsername?: string;
  contextPrompt?: string;
  cwd?: string;
}

interface WsClient {
  ws: WebSocket;
  userId: string;
  activeThreadId: string | null;
}

interface QueuedMessage {
  clientId: string;
  content: string;
  source: 'dashboard' | 'connect' | 'heartbeat';
  /** Connect inbound id — acked on turn complete (inject-once; silence is valid). */
  messageId?: string;
}

interface AntigravityStoredToken {
  token: {
    access_token: string;
    token_type: string;
    refresh_token: string;
    expiry: string;
  };
  auth_method: 'consumer';
}

type AntigravityMcpServer = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  serverUrl?: string;
  headers?: Record<string, string>;
};

const ANTIGRAVITY_PROVIDER_RECHECK_MS = 5 * 60_000;
const ANTIGRAVITY_AUTH_RELATIVE_PATH = path.join(
  '.gemini',
  'antigravity-cli',
  'antigravity-oauth-token',
);

/** Convert Hive's Google OAuth pool payload to Antigravity CLI's headless file store. */
export function buildAntigravityStoredToken(raw: string): AntigravityStoredToken {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Google broker token is not valid JSON');
  }
  const accessToken = typeof payload['access_token'] === 'string'
    ? payload['access_token'].trim()
    : '';
  const refreshToken = typeof payload['refresh_token'] === 'string'
    ? payload['refresh_token'].trim()
    : '';
  const rawExpiry = payload['expiry_date'] ?? payload['expiry'];
  const expiryMs = typeof rawExpiry === 'number'
    ? rawExpiry
    : typeof rawExpiry === 'string' && /^\d+$/.test(rawExpiry)
      ? Number(rawExpiry)
      : Date.parse(String(rawExpiry ?? ''));
  if (!accessToken || !refreshToken || !Number.isFinite(expiryMs)) {
    throw new Error('Google broker token lacks access_token, refresh_token, or expiry');
  }
  return {
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: new Date(expiryMs).toISOString(),
    },
    auth_method: 'consumer',
  };
}

/** Translate the shared MCP format to Antigravity's watched mcp_config.json schema. */
export function buildAntigravityMcpConfig(
  servers: Record<string, unknown>,
): { mcpServers: Record<string, AntigravityMcpServer> } {
  const mcpServers: Record<string, AntigravityMcpServer> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry['command'] === 'string' && entry['command'].trim()) {
      mcpServers[name] = {
        command: entry['command'],
        ...(Array.isArray(entry['args'])
          ? { args: entry['args'].filter((value): value is string => typeof value === 'string') }
          : {}),
        ...(entry['env'] && typeof entry['env'] === 'object' && !Array.isArray(entry['env'])
          ? { env: entry['env'] as Record<string, string> }
          : {}),
      };
      continue;
    }
    const serverUrl = typeof entry['serverUrl'] === 'string'
      ? entry['serverUrl']
      : typeof entry['url'] === 'string'
        ? entry['url']
        : '';
    if (!serverUrl) continue;
    mcpServers[name] = {
      serverUrl,
      ...(entry['headers'] && typeof entry['headers'] === 'object' && !Array.isArray(entry['headers'])
        ? { headers: entry['headers'] as Record<string, string> }
        : {}),
    };
  }
  return { mcpServers };
}

// ── Bridge ──

export class AntigravityBridge {
  private app: FastifyInstance | null = null;
  private wss: WebSocketServer | null = null;
  private cliProcess: ChildProcess | null = null;
  private clients = new Map<string, WsClient>();
  private sessionId = '';
  private initialized = false;
  private agyPath = '';
  private directConversationId = '';

  private streamingThreadId: string | null = null;
  private streamingContent = '';

  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private turnCount = 0;
  private totalOutputChars = 0;
  private lastActivityAt = Date.now();
  private lastTurnDurationMs = 0;
  private lastTurnOutputTokens = 0;
  private recentErrors: Array<{ ts: number; level: string; msg: string }> = [];

  private replayHistory: Array<{ id?: string; role: string; content: string; createdAt: string }> = [];

  private activeThreadId: string | null = null;
  private readonly activityPhase = new ActivityPhaseTracker({
    onChange: () => this.telemetryFlusher?.soon(),
  });
  private readonly telemetryFlusher = createTelemetryFlusher(() => this.emitTelemetry());
  private activeTurnSource: QueuedMessage['source'] | null = null;
  /** Connect inbound id acked when the inject turn finishes (silence is valid). */
  private activeConnectMessageId: string | null = null;
  private activeHeartbeatToolCalls: HeartbeatQueueDrainTurnToolCall[] = [];
  private activeHeartbeatToolResults: HeartbeatQueueDrainTurnToolResult[] = [];
  private activeHeartbeatToolIndexes = new Map<string, number>();
  private messageQueue: QueuedMessage[] = [];

  private startTime = Date.now();
  private _mcpServers: Record<string, unknown> = {};
  private connectClient: import('../connect-client/index.js').ConnectClient | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInitialTimer: ReturnType<typeof setTimeout> | null = null;
  private providerRecheckTimer: ReturnType<typeof setInterval> | null = null;
  private tokenManager: import('../auth/agent-token-manager.js').AgentTokenManager | null = null;
  private platformJwt = '';
  private activeBrokerToken: BrokerModelToken | null = null;
  private credentialInstalled = false;
  private authenticated = false;
  private providerHealthy = false;
  private providerError = 'Google OAuth has not been checked';
  private lastProviderCheckAt = 0;

  constructor(private opts: AntigravityBridgeOptions) {
    this.sessionId = `antigravity-bridge-${opts.agentId ?? 'default'}`;
  }

  async start(): Promise<void> {
    await this.startConnect();
    this.agyPath = await this.findAntigravityCli();
    const homeDir = process.getuid?.() === 0 ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? process.cwd();
    await this.configureMcpServers(homeDir, workDir);
    this.configureSkills(workDir);
    this.writeContextPrompt(workDir);
    await this.refreshProviderAuth(true);
    this.initialized = true;
    await this.startServer();
    this.processQueue();
    this.startTelemetry();
    this.startHeartbeat();
    this.providerRecheckTimer = setInterval(
      () => void this.refreshProviderAuth(true),
      ANTIGRAVITY_PROVIDER_RECHECK_MS,
    );
    this.providerRecheckTimer.unref?.();
    console.log(
      `Antigravity CLI bridge listening on ${this.opts.host}:${this.opts.port} (binary=${this.agyPath})`,
    );
  }

  private rememberError(message: string, level = 'error'): void {
    this.recentErrors.push({ ts: Date.now(), level, msg: message });
    this.recentErrors = this.recentErrors.slice(-20);
  }

  private async startConnect(): Promise<void> {
    try {
      const { ConnectClient } = await import('../connect-client/index.js');
      this.connectClient = new ConnectClient({
        onOpen: () => this.emitTelemetry(),
        onMessage: (convId, content, _senderId, senderName, messageId) => {
          const queued: QueuedMessage = {
            clientId: `connect:${convId}`,
            content,
            source: 'connect',
            messageId,
          };
          this.messageQueue.push(queued);
          console.log(
            `[antigravity-bridge] [Connect] Queued message from ${senderName} ` +
            `in conv ${convId.substring(0, 8)}… busy=${this.activeThreadId !== null} ` +
            `depth=${this.messageQueue.length}`,
          );
          this.processQueue();
          this.emitTelemetry();
        },
        onConfigUpdate: (cfg) => {
          console.log(
            `[antigravity-bridge] agent_config_update received: keys=${Object.keys(cfg).join(',')}`,
          );
          if (typeof cfg['contextPrompt'] === 'string') {
            this.opts.contextPrompt = cfg['contextPrompt'];
            this.writeContextPrompt(this.opts.cwd ?? process.cwd());
          }
        },
      });
      await this.connectClient.start();
    } catch (err) {
      const message = `Connect client failed to start: ${(err as Error).message}`;
      this.rememberError(message);
      console.error(`[antigravity-bridge] ${message}`);
    }
  }

  private configureSkills(workDir: string): void {
    const catalogDir = '/opt/skills';
    if (!fs.existsSync(catalogDir)) return;
    const targetDir = path.join(workDir, '.agents', 'skills');
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      let linked = 0;
      for (const entry of fs.readdirSync(catalogDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = path.join(catalogDir, entry.name);
        if (!fs.existsSync(path.join(source, 'SKILL.md'))) continue;
        const target = path.join(targetDir, entry.name);
        try {
          const existing = fs.lstatSync(target);
          if (existing.isSymbolicLink() && fs.readlinkSync(target) === source) {
            linked++;
            continue;
          }
          continue;
        } catch { /* create below */ }
        fs.symlinkSync(source, target, 'dir');
        linked++;
      }
      console.log(`[antigravity-bridge] Linked ${linked} fleet skills into ${targetDir}`);
    } catch (err) {
      const message = `Failed to configure skills: ${(err as Error).message}`;
      this.rememberError(message, 'warn');
      console.warn(`[antigravity-bridge] ${message}`);
    }
  }

  private async resolvePlatformJwt(): Promise<string> {
    if (!this.tokenManager) {
      const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
      const platformUrl = process.env['SHIZUHA_PLATFORM_URL'] || process.env['BACKEND_URL'] || '';
      this.tokenManager = new AgentTokenManager({
        agentUsername: this.opts.agentUsername ?? process.env['AGENT_USERNAME'] ?? 'agent',
        agentEmail: process.env['AGENT_EMAIL'] || undefined,
        platformUrl,
      });
    }
    this.platformJwt = (
      await this.tokenManager.getTokenWithRetry({
        maxWaitMs: 30_000,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
      })
    ) ?? '';
    return this.platformJwt;
  }

  private homeDir(): string {
    return process.getuid?.() === 0 ? '/home/agent' : (process.env['HOME'] ?? '/root');
  }

  private writeAntigravityAuthFile(rawToken: string): void {
    const stored = buildAntigravityStoredToken(rawToken);
    const authPath = path.join(this.homeDir(), ANTIGRAVITY_AUTH_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(authPath), 0o700);
    const tmp = `${authPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    if (process.getuid?.() === 0) {
      try {
        fs.chownSync(path.dirname(authPath), 1000, 1000);
        fs.chownSync(tmp, 1000, 1000);
      } catch { /* the runtime may already be uid 1000 */ }
    }
    fs.renameSync(tmp, authPath);
    this.credentialInstalled = true;
  }

  private runAgyCapture(args: string[], timeoutMs: number): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }> {
    const isRoot = process.getuid?.() === 0;
    const spawnCmd = isRoot ? 'runuser' : this.agyPath;
    const spawnArgs = isRoot
      ? ['-p', '-u', 'agent', '--', this.agyPath, ...args]
      : args;
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.opts.cwd ?? process.cwd(),
        env: {
          ...process.env,
          HOME: this.homeDir(),
          USER: isRoot ? 'agent' : (process.env['USER'] ?? 'agent'),
        },
      });
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-16_000);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16_000);
      });
      child.on('error', (err) => {
        stderr = err.message;
        finish(null);
      });
      child.on('exit', (code) => finish(code));
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        finish(null);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private async refreshProviderAuth(validate: boolean): Promise<boolean> {
    if (!validate && this.providerHealthy && this.activeBrokerToken) {
      return true;
    }
    if (
      !validate
      && !this.providerHealthy
      && Date.now() - this.lastProviderCheckAt < ANTIGRAVITY_PROVIDER_RECHECK_MS
    ) {
      return false;
    }
    try {
      const brokerToken = await fetchBrokerModelToken(
        'google',
        8_000,
        {
          stickyKey: this.opts.agentId ?? this.opts.agentUsername ?? 'antigravity-agent',
        },
      );
      if (!brokerToken) {
        this.lastProviderCheckAt = Date.now();
        const reason = brokerExpected()
          ? 'Hive broker returned no Google OAuth lease'
          : 'Hive broker is not configured for Google OAuth';
        this.authenticated = false;
        this.providerHealthy = false;
        this.providerError = reason;
        this.rememberError(reason, 'warn');
        this.emitTelemetry();
        return false;
      }
      this.activeBrokerToken = brokerToken;
      this.writeAntigravityAuthFile(brokerToken.token);
      const result = await this.runAgyCapture(['models'], 25_000);
      this.lastProviderCheckAt = Date.now();
      if (result.code === 0) {
        this.authenticated = true;
        this.providerHealthy = true;
        this.providerError = '';
        this.recentErrors = this.recentErrors.filter(
          (entry) => !entry.msg.startsWith('Antigravity provider check failed'),
        );
        console.log(
          `[antigravity-bridge] Google OAuth verified through Antigravity CLI ` +
          `(pool=${brokerToken.label || 'unlabelled'})`,
        );
        this.emitTelemetry();
        return true;
      }
      const diagnostic = (result.stderr || result.stdout || `exit ${result.code}`)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      const reason = `Antigravity provider check failed: ${diagnostic}`;
      this.authenticated = false;
      this.providerHealthy = false;
      this.providerError = reason;
      this.rememberError(reason);
      console.error(`[antigravity-bridge] ${reason}`);
      this.emitTelemetry();
      return false;
    } catch (err) {
      this.lastProviderCheckAt = Date.now();
      const reason = `Antigravity auth setup failed: ${(err as Error).message}`;
      this.authenticated = false;
      this.providerHealthy = false;
      this.providerError = reason;
      this.rememberError(reason);
      console.error(`[antigravity-bridge] ${reason}`);
      this.emitTelemetry();
      return false;
    }
  }

  private modelMaxTokens(): number {
    return this.opts.model.toLowerCase().startsWith('gemini') ? 1_000_000 : 200_000;
  }

  private buildTelemetry(): Record<string, unknown> {
    const maxTokens = this.modelMaxTokens();
    const tokensPerSecond = this.lastTurnDurationMs > 0
      ? Number((this.lastTurnOutputTokens / (this.lastTurnDurationMs / 1000)).toFixed(1))
      : 0;
    const agentId = this.opts.agentId ?? process.env['AGENT_ID'] ?? null;
    return {
      v: 1,
      ts: Date.now(),
      agent_username: this.opts.agentUsername ?? null,
      agent_id: agentId,
      runtime: {
        harness: 'antigravity-bridge',
        model: this.opts.model,
        provider: 'google',
        version: process.env['SHIZUHA_RUNTIME_VERSION'] ?? null,
        host: os.hostname(),
        pid: process.pid,
        uptime_ms: Date.now() - this.startTime,
      },
      context: {
        used_tokens: this.totalInputTokens,
        max_tokens: maxTokens,
        pct: maxTokens && this.totalInputTokens
          ? Number(((this.totalInputTokens / maxTokens) * 100).toFixed(1))
          : null,
      },
      usage: {
        total_input_tokens: this.totalInputTokens,
        total_output_tokens: this.totalOutputTokens,
        total_output_chars: this.totalOutputChars,
        turns: this.turnCount,
        tokens_per_sec: tokensPerSecond,
      },
      performance: {
        last_turn_duration_ms: this.lastTurnDurationMs || null,
        last_turn_output_tokens: this.lastTurnOutputTokens,
      },
      activity: buildActivityTelemetry(this.activityPhase, {
        busy: this.activeThreadId !== null,
        queueDepth: this.messageQueue.length,
        lastActivityAt: this.lastActivityAt,
      }),
      capabilities: {
        connect: this.connectClient?.connected ?? false,
        mcp_services: Object.keys(this._mcpServers),
        skills_directory: path.join(this.opts.cwd ?? process.cwd(), '.agents', 'skills'),
      },
      health: {
        ok: this.initialized && this.authenticated && this.providerHealthy,
        authenticated: this.authenticated,
        credential_installed: this.credentialInstalled,
        provider_unavailable: !this.providerHealthy,
        provider_unavailable_reason: this.providerError || null,
        broker_lease_label: this.activeBrokerToken?.label ?? null,
        recent_errors: this.recentErrors.slice(-10),
      },
      heartbeat: agentId ? heartbeatQueueDrainTelemetry(agentId) : null,
    };
  }

  private emitTelemetry(): void {
    try { this.connectClient?.sendTelemetry(this.buildTelemetry()); } catch { /* best effort */ }
  }

  private startTelemetry(): void {
    const raw = Number(process.env['SHIZUHA_TELEMETRY_INTERVAL_MS'] ?? 30_000);
    const intervalMs = Number.isFinite(raw) && raw >= 5_000 ? raw : 30_000;
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = setInterval(() => this.emitTelemetry(), intervalMs);
    this.telemetryTimer.unref?.();
    this.emitTelemetry();
    console.log(
      `[antigravity-bridge] Telemetry enabled (every ${Math.round(intervalMs / 1000)}s -> Connect)`,
    );
  }

  private platformBase(): string {
    return process.env['SHIZUHA_PLATFORM_URL'] || process.env['BACKEND_URL'] || '';
  }

  /**
   * Zero-token Pulse gate. Only a validated `skip` response suppresses the
   * autonomous model turn; auth, transport, and schema uncertainty fail open.
   */
  private async runPulseHeartbeatPreflight(): Promise<PulseHeartbeatPreflightDecision> {
    try {
      const platformBase = this.platformBase();
      const username = (this.opts.agentUsername ?? process.env['AGENT_USERNAME'] ?? '').trim();
      const email = (process.env['AGENT_EMAIL'] ?? (username ? `${username}@shizuha.com` : '')).trim();
      let token = await this.resolvePlatformJwt();
      if (!platformBase || !email || !token) {
        return { kind: 'run', reason: 'Pulse preflight lacks platform URL, email, or JWT' };
      }

      const request = async (): Promise<Response> => {
        const url = new URL('/pulse/api/items/heartbeat-preflight/', platformBase);
        url.searchParams.set('assignee_email', email);
        return fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000),
        });
      };

      let response = await request();
      if (response.status === 401) {
        this.tokenManager = null;
        this.platformJwt = '';
        token = await this.resolvePlatformJwt();
        if (!token) return { kind: 'run', reason: 'Pulse preflight JWT refresh failed' };
        response = await request();
      }
      if (!response.ok) {
        return {
          kind: 'run',
          reason: `Pulse heartbeat preflight unavailable (HTTP ${response.status})`,
        };
      }
      return parsePulseHeartbeatPreflightResponse(await response.json());
    } catch (err) {
      return {
        kind: 'run',
        reason: `Pulse heartbeat preflight unavailable: ${(err as Error).message}`,
      };
    }
  }

  private startHeartbeat(): void {
    const intervalMs = resolveIdleHeartbeatMs();
    const rawInitial = Number(process.env['SHIZUHA_HEARTBEAT_INITIAL_DELAY_MS'] ?? 15_000);
    const initialDelayMs = Number.isFinite(rawInitial) && rawInitial >= 1_000
      ? rawInitial
      : 15_000;
    console.log(
      `[antigravity-bridge] Heartbeat enabled ` +
      `(initial ${Math.round(initialDelayMs / 1000)}s, then every ${Math.round(intervalMs / 60_000)}m)`,
    );
    this.heartbeatInitialTimer = setTimeout(() => {
      void this.fireHeartbeat();
      this.heartbeatTimer = setInterval(() => void this.fireHeartbeat(), intervalMs);
      this.heartbeatTimer.unref?.();
    }, initialDelayMs);
    this.heartbeatInitialTimer.unref?.();
  }

  private async fireHeartbeat(): Promise<void> {
    if (
      this.activeTurnSource === 'heartbeat'
      || this.messageQueue.some((message) => message.source === 'heartbeat')
    ) {
      return;
    }
    const preflight = await this.runPulseHeartbeatPreflight();
    const agentId = this.opts.agentId ?? process.env['AGENT_ID'] ?? 'unknown-antigravity-agent';
    if (preflight.kind === 'skip') {
      const outcome = recordHeartbeatQueueDrainOutcome(agentId, {
        readyTaskCount: preflight.readyTaskCount,
        blockedTaskCount: preflight.blockedTaskCount,
        futureDueCount: preflight.futureDueCount,
        pulseGetMyAlertsObserved: true,
        pulseAlertTaskOrderValid: true,
      });
      console.log(formatHeartbeatQueueDrainOutcomeLogLine(outcome));
      console.log(
        `[antigravity-bridge] Heartbeat preflight skipped model turn — ${preflight.reason} ` +
        `(model_tokens=0)`,
      );
      this.emitTelemetry();
      return;
    }
    this.messageQueue.push({
      clientId: 'heartbeat',
      content: CODEX_HEARTBEAT_TRIGGER,
      source: 'heartbeat',
    });
    console.log(`[antigravity-bridge] Heartbeat queued — ${preflight.reason}`);
    this.processQueue();
  }

  private writeContextPrompt(workDir: string): void {
    if (!this.opts.contextPrompt) return;
    // Antigravity / agent CLIs commonly honor AGENTS.md; keep GEMINI.md only as
    // a legacy filename is never preferred for the binary itself.
    for (const name of ['AGENTS.md', 'ANTIGRAVITY.md']) {
      try {
        fs.writeFileSync(path.join(workDir, name), this.opts.contextPrompt);
        console.log(`[antigravity-bridge] Wrote context prompt to ${name}`);
      } catch (err) {
        console.warn(`[antigravity-bridge] Failed to write ${name}: ${(err as Error).message}`);
      }
    }
  }

  private async findAntigravityCli(): Promise<string> {
    // Never resolve a bare `gemini` binary — Gemini CLI is permanently removed.
    const home = process.env['HOME'] ?? '/root';
    const candidates = [
      '/usr/local/bin/antigravity',
      '/usr/bin/antigravity',
      '/usr/local/bin/agy',
      '/usr/bin/agy',
      path.join(home, '.local', 'bin', 'antigravity'),
      path.join(home, '.local', 'bin', 'agy'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    try {
      const { execSync } = await import('node:child_process');
      for (const name of ['antigravity', 'agy']) {
        try {
          const result = execSync(`which ${name}`, { encoding: 'utf-8', timeout: 5000 }).trim();
          if (result && !/\/gemini$/.test(result)) return result;
        } catch { /* try next */ }
      }
    } catch { /* not found */ }

    throw new Error(
      'Antigravity CLI not found (expected `antigravity` or `agy` on PATH). '
      + 'Gemini CLI has been removed; install Antigravity CLI in the agent image '
      + '(https://antigravity.google/cli/install.sh).',
    );
  }

  /** Configure MCP servers for Antigravity CLI — same servers as the Claude bridge */
  private async configureMcpServers(homeDir: string, workDir: string): Promise<void> {
    const platformBase = process.env['SHIZUHA_PLATFORM_URL'] || process.env['BACKEND_URL'] || '';
    const browserMcp = resolveBrowserMcpServer(this.opts.contextPrompt);

    const mcpServers: Record<string, unknown> = {};
    if (browserMcp) {
      mcpServers[browserMcp.name] = browserMcp.entry;
    }

    if (platformBase) {
      let bearerToken = process.env['AGENT_ACCESS_TOKEN'] || '';
      if (!bearerToken) {
        try {
          const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
          this.tokenManager = new AgentTokenManager({
            agentUsername: this.opts.agentUsername ?? 'agent',
            agentEmail: process.env['AGENT_EMAIL'] || undefined,
            platformUrl: platformBase,
          });
          // Broker JWT mints ~1–3s after the sidecar starts; a single getToken()
          // races and permanently skips platform MCP (Pulse/wiki) for the life
          // of the process. Wait/retry like codex/claude bridges (max 90s).
          bearerToken = (
            await this.tokenManager.getTokenWithRetry({
              maxWaitMs: 90_000,
              baseDelayMs: 500,
              maxDelayMs: 5_000,
            })
          ) ?? '';
        } catch (err) {
          console.warn(`[antigravity-bridge] shizuha-id login failed: ${(err as Error).message}`);
        }
      }
      if (bearerToken) {
        this.platformJwt = bearerToken;
        const { getPlatformMcpConfigs, PLATFORM_MCP_SERVICES, prunePlatformMcpKeys } = await import('../platform/mcp-services.js');
        const { resolveAllowedServers } = await import('../platform/mcp-access-matrix.js');
        const { parseAgentEffectiveMcpServicesFromEnv } = await import('../platform/effective-capabilities.js');
        const agentRole = process.env['AGENT_ROLE'];
        const agentSkills = (process.env['AGENT_SKILLS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const hiveAllowList = parseAgentEffectiveMcpServicesFromEnv();
        const roleAllowList = hiveAllowList ?? [...resolveAllowedServers(agentRole, this.opts.agentUsername ?? process.env['AGENT_USERNAME'], agentSkills)];
        const platformConfigs = prunePlatformMcpKeys(
          getPlatformMcpConfigs({ bearerToken, platformUrl: platformBase }),
          roleAllowList,
        );
        Object.assign(mcpServers, platformConfigs);
        console.log(`[antigravity-bridge] Platform MCP: ${Object.keys(platformConfigs).length}/${PLATFORM_MCP_SERVICES.length} services configured${hiveAllowList ? ` (Hive effective: ${roleAllowList.join(', ')})` : agentRole ? ` (role ${agentRole}: ${roleAllowList.join(', ')})` : ''}`);
      } else {
        console.warn(`[antigravity-bridge] Platform MCP: no JWT — skipping platform MCP servers`);
      }
    }

    const configuredCount = Object.keys(mcpServers).length;
    if (configuredCount > 0) {
      console.log(`[antigravity-bridge] Platform MCP servers configured (${configuredCount} services)`);
    }

    try {
      fs.writeFileSync(path.join(workDir, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2));
    } catch { /* ignore */ }

    // Antigravity does not read Claude/Codex-style .mcp.json or mcpServers
    // nested only in settings.json. Its watched global contract is
    // ~/.gemini/config/mcp_config.json.
    const antigravityMcpConfig = buildAntigravityMcpConfig(mcpServers);
    const globalMcpPath = path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
    try {
      fs.mkdirSync(path.dirname(globalMcpPath), { recursive: true, mode: 0o700 });
      const tmp = `${globalMcpPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(antigravityMcpConfig, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, globalMcpPath);
      if (process.getuid?.() === 0) {
        try {
          fs.chownSync(path.dirname(globalMcpPath), 1000, 1000);
          fs.chownSync(globalMcpPath, 1000, 1000);
        } catch { /* already uid 1000 or unsupported */ }
      }
      console.log(
        `[antigravity-bridge] MCP config written to ${globalMcpPath} ` +
        `(${Object.keys(antigravityMcpConfig.mcpServers).length} services)`,
      );
    } catch (err) {
      const message = `Failed to write Antigravity MCP config: ${(err as Error).message}`;
      this.rememberError(message);
      console.warn(`[antigravity-bridge] ${message}`);
    }

    // Antigravity settings: always-proceed for unattended fleet agents.
    const settingsBlob = {
      toolPermission: 'always-proceed',
      artifactReviewPolicy: 'always-proceed',
      enableTerminalSandbox: false,
      mcpServers,
    };
    for (const rel of [
      path.join('.antigravity', 'settings.json'),
      path.join('.config', 'antigravity', 'settings.json'),
    ]) {
      const settingsPath = path.join(homeDir, rel);
      try {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(settingsBlob, null, 2));
        console.log(`[antigravity-bridge] MCP/settings written to ${settingsPath}`);
      } catch (err) {
        console.warn(`[antigravity-bridge] Failed to write ${settingsPath}: ${(err as Error).message}`);
      }
    }

    this._mcpServers = mcpServers;
  }

  // ── Execution (agy print mode — never gemini / ACP) ──

  private async startAgyExecution(message: QueuedMessage): Promise<void> {
    const { clientId, content, source } = message;
    const client = source === 'dashboard' ? this.clients.get(clientId) : undefined;
    if (source === 'dashboard' && !client) return;
    const threadId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    if (client) client.activeThreadId = threadId;
    this.activeThreadId = threadId;
    this.activeTurnSource = source;
    this.activeConnectMessageId = source === 'connect' ? (message.messageId ?? null) : null;
    this.activeHeartbeatToolCalls = [];
    this.activeHeartbeatToolResults = [];
    this.activeHeartbeatToolIndexes.clear();
    this.streamingThreadId = threadId;
    this.streamingContent = '';
    this.lastActivityAt = Date.now();
    const turnStartedAt = Date.now();
    const outputTokensBefore = this.totalOutputTokens;
    let stderrText = '';

    if (client) {
      this.sendWs(client.ws, {
        type: 'message_ack',
        data: { thread_id: threadId, session_id: this.sessionId },
      });
    }
    this.broadcastToThread(threadId, {
      type: 'session_start',
      execution_id: threadId,
      data: {
        session_id: this.sessionId,
        model: this.opts.model,
        message_id: messageId,
      },
    });

    this.replayHistory.push({
      id: messageId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });

    const providerReady = await this.refreshProviderAuth(false);
    if (!providerReady) {
      const errorMessage = this.providerError || 'Antigravity provider is unavailable';
      this.broadcastToThread(threadId, {
        type: 'error',
        execution_id: threadId,
        data: { message: errorMessage },
      });
      if (source === 'heartbeat') {
        const agentId = this.opts.agentId ?? process.env['AGENT_ID'] ?? 'unknown-antigravity-agent';
        const outcome = recordHeartbeatQueueDrainOutcome(agentId, {
          // The preflight selected a model turn, so preserve a presence marker
          // instead of falsely reporting an empty queue.
          readyTaskCount: 1,
          pulseGetMyAlertsObserved: true,
          pulseAlertTaskOrderValid: true,
        });
        console.log(formatHeartbeatQueueDrainOutcomeLogLine(outcome));
      }
      this.finishExecution(threadId, client, turnStartedAt, outputTokensBefore);
      return;
    }

    const workDir = this.opts.cwd ?? process.cwd();
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');

    const args = this.buildAgyArgs(content, source);
    console.log(`[antigravity-bridge] Spawning: ${this.agyPath} ${args.map((a) => (a.length > 80 ? a.slice(0, 80) + '…' : a)).join(' ')}`);

    const spawnCmd = isRoot ? 'runuser' : this.agyPath;
    const spawnArgs = isRoot ? ['-p', '-u', 'agent', '--', this.agyPath, ...args] : args;

    try {
      await new Promise<void>((resolve, reject) => {
        let lineBuffer = '';
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };

        this.cliProcess = spawn(spawnCmd, spawnArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: workDir,
          env: {
            ...process.env,
            HOME: homeDir,
            USER: isRoot ? 'agent' : (process.env['USER'] ?? 'agent'),
          },
        });

        this.cliProcess.stdout!.on('data', (chunk: Buffer) => {
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            this.handleAgyStdoutLine(threadId, line);
          }
        });

        this.cliProcess.stderr!.on('data', (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) {
            stderrText = (stderrText + '\n' + text).slice(-16_000);
            console.error(`[antigravity-bridge] stderr: ${text.slice(0, 500)}`);
          }
        });

        this.cliProcess.on('error', (err) => {
          console.error(`[antigravity-bridge] agy spawn error: ${err.message}`);
          finish(err);
        });

        this.cliProcess.on('exit', (code, signal) => {
          if (lineBuffer.trim()) this.handleAgyStdoutLine(threadId, lineBuffer);
          lineBuffer = '';
          this.cliProcess = null;
          if (code !== 0 && code !== null) {
            finish(new Error(`agy exited code=${code} signal=${signal}`));
          } else {
            finish();
          }
        });
      });

      this.turnCount++;
      this.authenticated = true;
      this.providerHealthy = true;
      this.providerError = '';

      if (this.streamingContent) {
        this.replayHistory.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: this.streamingContent,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      const diagnostic = `${(err as Error).message} ${stderrText}`.replace(/\s+/g, ' ').trim();
      if (/permission_denied|\b401\b|\b403\b|not logged in|authenticate|oauth/i.test(diagnostic)) {
        this.authenticated = false;
        this.providerHealthy = false;
        this.providerError = `Antigravity provider turn failed: ${diagnostic.slice(0, 500)}`;
        this.lastProviderCheckAt = Date.now();
      }
      this.rememberError(`Antigravity turn failed: ${diagnostic.slice(0, 500)}`);
      this.broadcastToThread(threadId, {
        type: 'error',
        execution_id: threadId,
        data: { message: (err as Error).message },
      });
    }

    if (source === 'heartbeat') {
      const agentId = this.opts.agentId ?? process.env['AGENT_ID'] ?? 'unknown-antigravity-agent';
      const outcome = recordHeartbeatQueueDrainTurn(agentId, {
        toolCalls: this.activeHeartbeatToolCalls,
        toolResults: this.activeHeartbeatToolResults,
      });
      console.log(formatHeartbeatQueueDrainOutcomeLogLine(outcome));
    }
    this.finishExecution(threadId, client, turnStartedAt, outputTokensBefore);
  }

  private finishExecution(
    threadId: string,
    client: WsClient | undefined,
    turnStartedAt: number,
    outputTokensBefore: number,
  ): void {
    this.lastTurnDurationMs = Math.max(0, Date.now() - turnStartedAt);
    this.lastTurnOutputTokens = Math.max(0, this.totalOutputTokens - outputTokensBefore);
    this.totalOutputChars += this.streamingContent.length;
    this.lastActivityAt = Date.now();
    this.broadcastToThread(threadId, {
      type: 'complete',
      execution_id: threadId,
      data: {
        result: {
          total_turns: this.turnCount,
          input_tokens: this.totalInputTokens,
          output_tokens: this.totalOutputTokens,
        },
      },
    });

    if (client) client.activeThreadId = null;
    if (this.activeConnectMessageId) {
      this.connectClient?.ackMessageProcessed(this.activeConnectMessageId);
      this.activeConnectMessageId = null;
    }
    this.activeThreadId = null;
    this.activeTurnSource = null;
    this.streamingThreadId = null;
    this.activeHeartbeatToolCalls = [];
    this.activeHeartbeatToolResults = [];
    this.activeHeartbeatToolIndexes.clear();
    this.emitTelemetry();
    this.processQueue();
  }

  private buildAgyArgs(prompt: string, source: QueuedMessage['source']): string[] {
    const workDir = this.opts.cwd ?? process.cwd();
    const args = buildAntigravitySpawnArgs({
      model: this.opts.model,
      prompt,
      conversationId: source === 'heartbeat' ? undefined : this.directConversationId || undefined,
    });
    args.push('--add-dir', workDir);
    return args;
  }

  private handleAgyStdoutLine(threadId: string, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Prefer stream-json NDJSON; fall back to plain text deltas.
    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      this.handleStreamJsonEvent(threadId, msg);
      return;
    } catch {
      // plain text
    }

    this.broadcastToThread(threadId, {
      type: 'content',
      execution_id: threadId,
      data: { delta: trimmed + '\n' },
    });
    this.streamingContent += trimmed + '\n';
  }

  private handleStreamJsonEvent(threadId: string, msg: Record<string, unknown>): void {
    const stepType = String(msg.step_type ?? msg.type ?? msg.event ?? '').toLowerCase();
    const text =
      (typeof msg.text === 'string' && msg.text)
      || (typeof msg.content === 'string' && msg.content)
      || (typeof (msg.message as any)?.content === 'string' && (msg.message as any).content)
      || (typeof msg.delta === 'string' && msg.delta)
      || '';

    if (text && (stepType.includes('message') || stepType.includes('text') || stepType === 'assistant' || stepType === 'content' || !stepType)) {
      // Avoid dumping pure control frames without text
      if (text) {
        this.broadcastToThread(threadId, {
          type: 'content',
          execution_id: threadId,
          data: { delta: text },
        });
        this.streamingContent += text;
        applyAgentEventToPhase(this.activityPhase, { type: 'content' });
      }
    }

    if (stepType.includes('tool') || msg.tool_info) {
      const toolInfo = (msg.tool_info as Record<string, unknown>) ?? msg;
      const name = String(toolInfo.name ?? toolInfo.tool ?? toolInfo.canonical_name ?? 'tool');
      const toolCallId = String(toolInfo.id ?? toolInfo.tool_call_id ?? '');
      if (stepType.includes('start') || stepType.includes('call')) {
        this.broadcastToThread(threadId, {
          type: 'tool_start',
          execution_id: threadId,
          data: {
            tool: name,
            input: toolInfo.parameters ?? toolInfo.input ?? {},
            tool_call_id: toolCallId,
          },
        });
        applyAgentEventToPhase(this.activityPhase, { type: 'tool_start', toolName: name });
        if (this.activeTurnSource === 'heartbeat') {
          const index = this.activeHeartbeatToolCalls.push({
            name,
            input: toolInfo.parameters ?? toolInfo.input ?? {},
          }) - 1;
          this.activeHeartbeatToolResults[index] = {};
          if (toolCallId) this.activeHeartbeatToolIndexes.set(toolCallId, index);
        }
      }
      if (stepType.includes('result') || stepType.includes('end') || toolInfo.output != null) {
        const resultContent = toolInfo.output ?? toolInfo.result ?? '';
        const isError = toolInfo.is_error === true || toolInfo.status === 'error';
        this.broadcastToThread(threadId, {
          type: 'tool_complete',
          execution_id: threadId,
          data: {
            tool: name,
            result: typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent),
            is_error: isError,
            tool_call_id: toolCallId,
          },
        });
        applyAgentEventToPhase(this.activityPhase, { type: 'tool_complete' });
        if (this.activeTurnSource === 'heartbeat') {
          let index = toolCallId ? this.activeHeartbeatToolIndexes.get(toolCallId) : undefined;
          if (index === undefined) {
            index = this.activeHeartbeatToolCalls.push({ name }) - 1;
          }
          this.activeHeartbeatToolResults[index] = {
            content: resultContent,
            isError,
          };
        }
      }
    }

    // Final result usage
    const usage = (msg.usage as Record<string, unknown>) ?? ((msg.result as any)?.usage as Record<string, unknown> | undefined);
    if (usage) {
      this.totalInputTokens += Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
      this.totalOutputTokens += Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
    }

    // Terminal result event with aggregated text
    if (stepType === 'result' || msg.event === 'result') {
      const resultObject = msg.result && typeof msg.result === 'object'
        ? msg.result as Record<string, unknown>
        : undefined;
      const conversationId = String(
        resultObject?.['conversation_id'] ?? msg['conversation_id'] ?? '',
      ).trim();
      if (conversationId && this.activeTurnSource !== 'heartbeat') {
        this.directConversationId = conversationId;
      }
      const resultText =
        (typeof msg.result === 'string' && msg.result)
        || (typeof (msg.result as any)?.text === 'string' && (msg.result as any).text)
        || '';
      if (resultText && !this.streamingContent.includes(resultText)) {
        this.broadcastToThread(threadId, {
          type: 'content',
          execution_id: threadId,
          data: { delta: resultText },
        });
        this.streamingContent += resultText;
      }
    }
  }

  private processQueue(): void {
    if (!this.initialized || !this.agyPath || this.activeThreadId || this.messageQueue.length === 0) {
      return;
    }
    // Direct dashboard/control work stays highest priority. Autonomous Pulse
    // reconciliation then wins over ordinary Connect notifications so a noisy
    // notification FIFO cannot starve the canonical queue.
    const dashboardIndex = this.messageQueue.findIndex((message) => message.source === 'dashboard');
    const heartbeatIndex = this.messageQueue.findIndex((message) => message.source === 'heartbeat');
    const nextIndex = dashboardIndex >= 0
      ? dashboardIndex
      : heartbeatIndex >= 0
        ? heartbeatIndex
        : 0;
    const [next] = this.messageQueue.splice(nextIndex, 1);
    if (next) void this.startAgyExecution(next);
  }

  // ── WebSocket ──

  private broadcastToThread(threadId: string, msg: Record<string, unknown>): void {
    for (const [_, client] of this.clients) {
      if (client.activeThreadId === threadId) {
        this.sendWs(client.ws, msg);
      }
    }
  }

  private sendWs(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  private async startServer(): Promise<void> {
    this.app = Fastify({ logger: false });
    await this.app.register(cors, { origin: true });

    this.app.get('/health', async () => ({
      status: this.initialized && this.authenticated && this.providerHealthy ? 'ok' : 'degraded',
      bridge: 'antigravity-cli',
      model: this.opts.model,
      binary: this.agyPath,
      initialized: this.initialized,
      authenticated: this.authenticated,
      credentialInstalled: this.credentialInstalled,
      credential_installed: this.credentialInstalled,
      providerHealthy: this.providerHealthy,
      provider_available: this.providerHealthy,
      providerError: this.providerError || null,
      provider_error: this.providerError || null,
      quota_ok: this.providerHealthy,
      in_backoff: !this.providerHealthy,
      connectConnected: this.connectClient?.connected ?? false,
      connect_connected: this.connectClient?.connected ?? false,
      mcpServices: Object.keys(this._mcpServers),
      mcp_services: Object.keys(this._mcpServers),
      heartbeat: heartbeatQueueDrainTelemetry(
        this.opts.agentId ?? process.env['AGENT_ID'] ?? 'unknown-antigravity-agent',
      ),
      busy: this.activeThreadId !== null,
      queueDepth: this.messageQueue.length,
      uptime: Date.now() - this.startTime,
      turns: this.turnCount,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      outputChars: this.totalOutputChars,
    }));

    await this.app.listen({ port: this.opts.port, host: this.opts.host });

    this.wss = new WebSocketServer({ noServer: true });
    this.app.server.on('upgrade', (req: any, socket: any, head: any) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/ws/chat' || url.pathname === '/ws/chat/') {
        this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          this.wss!.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = crypto.randomUUID();
      this.clients.set(clientId, { ws, userId: 'localhost', activeThreadId: null });

      console.log(JSON.stringify({
        level: 30, time: Date.now(), pid: process.pid,
        hostname: os.hostname(), userId: 'localhost',
        msg: 'WebSocket client connected',
      }));

      ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleWsMessage(clientId, msg);
        } catch { /* ignore */ }
      });

      ws.on('close', () => this.clients.delete(clientId));
      ws.on('error', () => this.clients.delete(clientId));
      this.sendWs(ws, { type: 'transport_status', connected: true });
    });

    setInterval(() => {
      for (const [_, client] of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try { client.ws.ping(); } catch { /* ignore */ }
        }
      }
    }, 30_000);
  }

  private handleWsMessage(clientId: string, msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === 'ping') {
      const client = this.clients.get(clientId);
      if (client) this.sendWs(client.ws, { type: 'pong' });
      return;
    }

    if (type === 'subscribe') {
      const client = this.clients.get(clientId);
      if (client) this.sendWs(client.ws, { type: 'subscribed', agent_id: msg.agent_id });
      return;
    }

    if (type === 'message') {
      const content = (msg.content as string || '').trim();
      if (!content) {
        const client = this.clients.get(clientId);
        if (client) this.sendWs(client.ws, { type: 'error', data: { message: 'content is required' } });
        return;
      }

      if (!this.initialized || !this.agyPath) {
        const client = this.clients.get(clientId);
        if (client) this.sendWs(client.ws, { type: 'error', data: { message: 'Antigravity CLI not ready' } });
        return;
      }

      if (this.activeThreadId) {
        this.messageQueue.push({ clientId, content, source: 'dashboard' });
        const client = this.clients.get(clientId);
        if (client) this.sendWs(client.ws, { type: 'message_ack', data: { queued: true, session_id: this.sessionId } });
        return;
      }

      void this.startAgyExecution({ clientId, content, source: 'dashboard' });
      return;
    }

    if (type === 'sync') {
      const client = this.clients.get(clientId);
      if (client) {
        this.sendWs(client.ws, {
          type: 'sync_history',
          session_id: this.sessionId,
          messages: this.replayHistory,
        });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.cliProcess) this.cliProcess.kill();
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatInitialTimer) clearTimeout(this.heartbeatInitialTimer);
    if (this.providerRecheckTimer) clearInterval(this.providerRecheckTimer);
    this.connectClient?.stop();
    if (this.app) await this.app.close();
  }
}

/** Build argv for a one-shot agy print-mode run (tests / diagnostics). */
export function buildAntigravitySpawnArgs(params: {
  model: string;
  prompt?: string;
  conversationId?: string;
}): string[] {
  const args = [
    '--print',
    params.prompt ?? '',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
  ];
  if (params.model && params.model !== 'auto') {
    args.push('--model', params.model);
  }
  if (params.conversationId) {
    args.push('--conversation', params.conversationId);
  }
  return args;
}

/** @deprecated Use buildAntigravitySpawnArgs — Gemini CLI removed. */
export function buildGeminiSpawnArgs(params: {
  model: string;
  storedSessionId?: string | null;
  contextPrompt?: string;
}): string[] {
  return buildAntigravitySpawnArgs({ model: params.model });
}

export async function startAntigravityBridge(opts: AntigravityBridgeOptions): Promise<AntigravityBridge> {
  const bridge = new AntigravityBridge(opts);
  await bridge.start();
  return bridge;
}
