/**
 * Daemon dashboard — HTTP server serving the web UI + agent management API.
 *
 * Started by `shizuha up` to provide a unified dashboard at http://localhost:8015
 * where users can see all their agents, chat with them, and monitor status.
 *
 * Chat uses WebSocket: browser ↔ dashboard ↔ platform /ws/chat/.
 * Same pattern as the mobile apps (ori-expo, kotlin).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
// @ts-ignore
import WebSocket, { WebSocketServer } from 'ws';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { execFileSync } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { PlatformClient } from './platform-client.js';
import { readProviderConfigValue } from '../config/provider-env.js';
import {
  DEFAULT_CORTEX_BASE_URL,
  DEFAULT_CORTEX_MODEL,
  resolveCortexAuthToken,
} from '../provider/registry.js';
// runner-proxy was removed 2026-04-20 — shizuha-agent's /ws/runner/ is retired
import { readDaemonState, updateAgentConfig, getFailoverChain, readEnabledAgents } from './state.js';
import { assertAgentCredentialScope } from './agent-credential.js';
// mail-sync.ts is no longer used — mail sync is handled by shizuha-mail service
// which POSTs to /v1/webhooks/mail when new messages arrive
import { getShizuhaAuthStatus, loginToShizuhaId, clearShizuhaAuth, readShizuhaAuth, getValidShizuhaAccessToken } from '../config/shizuhaAuth.js';
import {
  readCredentials,
  writeCredentials,
  readCodexAccounts,
  addAnthropicToken,
  removeAnthropicToken,
  toggleAnthropicTokenActive,
  clearTokenCooldown,
  reportTokenRateLimited,
  reportTokenInvalid,
  getActiveClaudeToken,
  setOpenAIKey,
  setGoogleKey,
  removeProvider,
  saveCodexAccount,
  removeCodexAccount,
  updateCodexTokens,
  reorderCodexAccounts,
  setCopilotToken,
  removeCopilotToken,
} from '../config/credentials.js';
import { codexDeviceAuth } from '../auth/codex-device-auth.js';
import { getCodexBrokerToken } from './codex-broker.js';
import {
  decideProvision,
  ProvisionOpStore,
  buildIdentityEvent,
  buildStateDelta,
} from './provision-gate.js';
import {
  FLEET_CONTROL_SECRET_HEADER,
  fleetControlSecretMatches,
  getFleetControlSecret,
  isHiveOnlyFleetEndpoint,
} from './fleet-control-auth.js';
import {
  enableAndStartAgent,
  disableAndStopAgent,
  pauseK8sAgent,
  restartAgent,
  resetAgentRuntimeSession,
  isAgentRunning,
  getLocalAgentPort,
  getContainerUrl,
  clearContainerIpCache,
  createLocalAgentAtRuntime,
  resolveAgentIdentityLive,
  deleteLocalAgentAtRuntime,
  updateLocalAgentAtRuntime,
  isDockerAvailable,
  resolveDindMode,
  setAgentStateChangeListener,
  setMiniConnectAuth,
  getAgentLastActivity,
  noteAgentActivity,
  getAgentActivity,
  logActivity,
  resolvePlatformUrl,
  setPlatformUrl,
  getCachedAgentIdentity,
  isAutoSkillSyncEnabled,
  refreshCredentialBrokerAgentSockets,
  validateCodexModelChain,
  isAgentInTokenPoolBackoff,
} from './manager.js';
import { isK8sAgent, readK8sAgentSessionTailStatus, resetK8sAgentRuntimeSession, scheduleK8sLastActivityProbe, type K8sAgentSessionTailUnavailable } from './k8s-backend.js';
import {
  ensureDashboardCredentials,
  login as dashboardLogin,
  logout as dashboardLogout,
  validateSession,
  changePassword,
  isDefaultPassword,
  extractSessionToken,
  verifyDashboardCredentials,
  getDashboardUsername,
} from './dashboard-auth.js';
import { ConnectStore } from './connect-store/sqlite.js';
import { AuthService as MiniConnectAuth } from './connect-store/auth.js';
import { ChannelLayer } from './connect-store/channel-layer.js';
import { registerMiniConnectRoutes, handleMiniConnectUpgrade } from './connect-store/server.js';
import {
  exchangeAgentGatewayChallenge,
  hasAgentGatewayScope,
  issueAgentGatewayChallenge,
  revokeAgentGatewayTokens,
  validateAgentGatewayToken,
} from './agent-auth.js';
import type { AgentInfo } from './types.js';
import type { AgentGatewayScope } from '../auth/agent-gateway.js';
import { DEFAULT_FAN_OUT } from '../gateway/types.js';
import { getHeartbeatQueueDrainOutcome, listHeartbeatQueueDrainOutcomes } from './heartbeat-outcome.js';
import { generatePairingCode, formatCode, generateDeviceToken, hashToken, CODE_TTL_MS } from '../devices/pairing.js';
import { addPendingCode, consumePendingCode, addDevice, findDeviceByTokenHash, updateLastSeen, listDevices, removeDevice, generateDeviceId } from '../devices/store.js';
import { checkRateLimit, recordFailure, resetFailures } from '../devices/rateLimit.js';
import type { ChannelType } from '../gateway/types.js';
import { EventLog, isDurableEvent, type ReplayedEvent } from './event-log.js';
import { sendJsonOverSocket } from './ws-send.js';

// (No JWT minting in the daemon. The dashboard talks to platform Pulse using
// the operator's stored shizuha-id JWT — see getPulseServiceToken() below.)

interface DashboardConfig {
  port: number;
  host: string;
  platformUrl: string;
  accessToken: string;
  agents: AgentInfo[];
  daemonLinkStatus?: () => Record<string, unknown> | null;
  /** TLS cert + key PEM strings. If provided, dashboard serves HTTPS. */
  tls?: { cert: string; key: string };
}

interface DashboardTcpProxyConfig {
  listenHost: string;
  port: number;
  targetHost: string;
  targetPort?: number;
}

const DASHBOARD_BRIDGE_HEADER = 'x-shizuha-dashboard-bridge';
const DASHBOARD_BRIDGE_VALUE = 'docker-gateway';

type HeaderBag = Record<string, string | string[] | number | undefined>;

export function dashboardProxyTargetHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

export function isDashboardBridgeRequest(headers: HeaderBag): boolean {
  const value = headers[DASHBOARD_BRIDGE_HEADER];
  if (Array.isArray(value)) return value.includes(DASHBOARD_BRIDGE_VALUE);
  return value === DASHBOARD_BRIDGE_VALUE;
}

/** Decode a JWT's header `alg`, or null if not parseable (PLAT-1161). */
function jwtAlg(token: string): string | null {
  try {
    const header = token.split('.')[0] ?? '';
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    return typeof decoded.alg === 'string' ? decoded.alg : null;
  } catch {
    return null;
  }
}

function isDashboardLocalhostIp(ip: string | undefined): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

function isDockerGatewayIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  const [first, second, ...rest] = normalized.split('.');
  if (first !== '172' || rest.length < 2) return false;
  const secondNum = Number(second);
  return Number.isInteger(secondNum) && secondNum >= 16 && secondNum <= 31;
}

export function isTrustedDashboardBridgeRequest(headers: HeaderBag, remoteIp: string | undefined): boolean {
  return isDashboardLocalhostIp(remoteIp) && isDashboardBridgeRequest(headers);
}

function withDashboardBridgeHeader(headers: HeaderBag): HeaderBag {
  return {
    ...headers,
    [DASHBOARD_BRIDGE_HEADER]: DASHBOARD_BRIDGE_VALUE,
  };
}

function serializeHttpHeaders(headers: HeaderBag): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return lines.join('\r\n');
}

export async function startDashboardTcpProxy(config: DashboardTcpProxyConfig): Promise<void> {
  // Container agents reach the daemon through the Docker gateway alias while
  // the real dashboard stays bound to loopback by default. Use an HTTP/WS
  // bridge instead of a transparent TCP pipe so downstream auth can distinguish
  // Docker-originated traffic from genuine localhost requests and avoid granting
  // the broad localhost dashboard bypass to containers.
  const http = await import('node:http');
  const targetHost = dashboardProxyTargetHost(config.targetHost);
  const targetPort = config.targetPort ?? config.port;
  const server = http.createServer((clientReq, clientRes) => {
    const proxyReq = http.request({
      hostname: targetHost,
      port: targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers: withDashboardBridgeHeader(clientReq.headers),
    }, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(clientRes);
    });
    clientReq.pipe(proxyReq);
    proxyReq.on('error', () => {
      try {
        clientRes.writeHead(502);
        clientRes.end();
      } catch { /* ignore */ }
    });
  });

  server.on('upgrade', (clientReq, clientSocket, clientHead) => {
    const upstream = net.connect({ host: targetHost, port: targetPort }, () => {
      const headers = withDashboardBridgeHeader(clientReq.headers);
      const serializedHeaders = serializeHttpHeaders(headers);
      upstream.write(`${clientReq.method} ${clientReq.url} HTTP/1.1\r\n${serializedHeaders}\r\n\r\n`);
      if (clientHead.length) upstream.write(clientHead);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const closeBoth = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    clientSocket.once('error', closeBoth);
    upstream.once('error', closeBoth);
    clientSocket.once('close', () => upstream.destroy());
    upstream.once('close', () => clientSocket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.listenHost);
  });
  server.on('error', (err) => {
    logger.warn({ err: (err as Error).message, listenHost: config.listenHost, port: config.port, targetHost, targetPort }, 'Dashboard container HTTP bridge error');
  });
  server.unref();
}

interface DashboardModelInfo {
  slug: string;
  provider: string;
}

interface MiniConnectState {
  store: ConnectStore;
  auth: MiniConnectAuth;
  channelLayer: ChannelLayer;
}

let sharedMiniConnectState: MiniConnectState | null = null;

export function getSharedMiniConnectState(): MiniConnectState {
  // Ensure first-run credentials exist before mini-Connect mirrors the local
  // dashboard owner. This preserves SHIZUHA_DASHBOARD_USERNAME on a fresh boot.
  ensureDashboardCredentials();

  if (!sharedMiniConnectState) {
    const store = new ConnectStore();
    sharedMiniConnectState = {
      store,
      auth: new MiniConnectAuth(store, {
        passwordVerifier: verifyDashboardCredentials,
      }),
      channelLayer: new ChannelLayer(),
    };
  }

  // Bootstrap the local human user from the dashboard credentials (single
  // source of truth for the password). Idempotent — no-op after first boot.
  const miniConnectUsername = getDashboardUsername() ?? 'shizuha';
  sharedMiniConnectState.auth.ensureLocalUser({
    username: miniConnectUsername,
    email: `${miniConnectUsername}@local`,
    displayName: miniConnectUsername,
  });

  return sharedMiniConnectState;
}

export function resetSharedMiniConnectStateForTest(): void {
  sharedMiniConnectState?.store.close();
  sharedMiniConnectState = null;
  setMiniConnectAuth(null);
}

const STATIC_DASHBOARD_MODELS: DashboardModelInfo[] = [
  { slug: 'claude-opus-5', provider: 'anthropic' },
  { slug: 'claude-opus-4-7', provider: 'anthropic' },
  { slug: 'claude-sonnet-4-6', provider: 'anthropic' },
  { slug: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
  { slug: 'claude-opus-4.7', provider: 'copilot' },
  { slug: 'claude-sonnet-4.6', provider: 'copilot' },
  { slug: 'claude-sonnet-4.5', provider: 'copilot' },
  { slug: 'claude-haiku-4.5', provider: 'copilot' },
  { slug: 'gpt-5.5', provider: 'openai' },
  { slug: 'gpt-4.1', provider: 'openai' },
  { slug: 'o4-mini', provider: 'openai' },
  { slug: 'codex-mini-latest', provider: 'openai' },
  { slug: 'gemini-2.0-flash', provider: 'google' },
  { slug: DEFAULT_CORTEX_MODEL, provider: 'cortex' },
];

const STATIC_DASHBOARD_PROVIDERS = ['anthropic', 'openai', 'google', 'copilot', 'codex', 'ollama', 'litellm', 'openrouter', 'cortex'];

/** HIVE-586: all host Codex credential-management surfaces are disabled in fleet mode. */
export function shouldRejectHostCodexCredentialRoute(url: string): boolean {
  const pathOnly = url.split('?')[0] ?? '';
  return Boolean(process.env['MCP_AUTH_PROXY_COORDINATOR_URL'])
    && (pathOnly === '/v1/providers/codex' || pathOnly.startsWith('/v1/providers/codex/'));
}

// ── Claude Code version detection (from a running agent container) ──
// The version surfaced in Settings → Runtime. Probed lazily on first request
// and cached for CLAUDE_CODE_VERSION_TTL_MS so we don't fork docker every poll.
// We intentionally probe INSIDE a container (not the host) so the UI reflects
// what the agents actually run — containers have `claude` installed via
// `npm install -g @anthropic-ai/claude-code` and rebuild independently of host.
interface ClaudeCodeVersionCache {
  version: string | null;
  source: string | null; // container name we read from
  fetchedAt: number;
}
let _claudeCodeVersionCache: ClaudeCodeVersionCache | null = null;
const CLAUDE_CODE_VERSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function detectClaudeCodeVersionFromContainer(
  candidateContainers: string[],
): Promise<ClaudeCodeVersionCache> {
  const now = Date.now();
  if (_claudeCodeVersionCache && (now - _claudeCodeVersionCache.fetchedAt) < CLAUDE_CODE_VERSION_TTL_MS) {
    return _claudeCodeVersionCache;
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const dockerPath = (() => {
    const candidates = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'];
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    return 'docker';
  })();

  for (const name of candidateContainers) {
    try {
      const { stdout } = await exec(dockerPath, ['exec', name, 'claude', '--version'], { timeout: 5000 });
      // Output shape: "2.1.112 (Claude Code)\n" or similar.
      const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:[.-][\w.]+)?)/);
      const version = match?.[1] ?? stdout.trim().split('\n')[0] ?? null;
      if (version) {
        _claudeCodeVersionCache = { version, source: name, fetchedAt: now };
        return _claudeCodeVersionCache;
      }
    } catch {
      // container not running, claude not installed, or exec blocked — try next
    }
  }
  _claudeCodeVersionCache = { version: null, source: null, fetchedAt: now };
  return _claudeCodeVersionCache;
}

// ── MCP tool-error telemetry ────────────────────────────────────────────
//
// Per-agent rolling buffer of recent tool failures. Updated when an agent
// emits `tool_complete` with `is_error=true`. Surfaced via /v1/settings
// so the dashboard can show "Connect MCP failing for 3 agents" without
// depending on agents to self-report (Shizuha mis-diagnosed Connect as
// "down" when one tool call hiccupped — this gives operators ground truth).
//
// In-memory only, not persisted: this is operational triage signal, not
// audit data. A daemon restart resets the buffers; that's fine because
// the dashboard only shows recent (last hour) errors anyway.
const TOOL_ERROR_BUFFER_LIMIT = 25;       // per-agent retention
const TOOL_ERROR_RETENTION_MS = 60 * 60 * 1000; // 1h sliding window
interface ToolErrorEvent {
  tool: string;
  message: string;
  ts: number;
}
const toolErrorBuffers = new Map<string, ToolErrorEvent[]>();

function recordToolError(agentId: string, tool: string, message: string): void {
  const buf = toolErrorBuffers.get(agentId) ?? [];
  buf.push({ tool, message: (message || '').slice(0, 240), ts: Date.now() });
  // Keep only recent + cap length
  const cutoff = Date.now() - TOOL_ERROR_RETENTION_MS;
  const pruned = buf.filter((e) => e.ts >= cutoff).slice(-TOOL_ERROR_BUFFER_LIMIT);
  toolErrorBuffers.set(agentId, pruned);
}

function getRecentToolErrors(agentId: string): ToolErrorEvent[] {
  const buf = toolErrorBuffers.get(agentId);
  if (!buf) return [];
  const cutoff = Date.now() - TOOL_ERROR_RETENTION_MS;
  return buf.filter((e) => e.ts >= cutoff);
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function collectProviderBaseUrls(agents: AgentInfo[], providerName: string, envName: string): string[] {
  const urls: Array<string | undefined> = [process.env[envName], readProviderConfigValue(providerName, 'baseUrl')];
  for (const agent of agents) {
    urls.push(agent.env?.[envName]);
  }
  return uniqueStrings(urls).map((url) => url.replace(/\/+$/, ''));
}

function providerModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

async function discoverOpenAICompatibleModels(baseUrl: string, provider: string, apiKey?: string): Promise<DashboardModelInfo[]> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const res = await fetch(providerModelsUrl(baseUrl), {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const json = await res.json() as { data?: Array<{ id?: string }> };
    return (json.data ?? [])
      .map((model) => model.id?.trim())
      .filter((model): model is string => !!model)
      // CTX-67: cortex models use clean slugs (GLM-4.7); other providers keep prefix (vllm/model).
      .map((model) => ({ slug: provider === 'cortex' ? model : `${provider}/${model}`, provider }));
  } catch {
    return [];
  }
}

// ── WebSocket Chat Bridge ──
//
// One persistent WS connection to the platform's /ws/chat/ endpoint.
// Multiple browser clients connect to the dashboard's /ws/chat endpoint.
// Routes by agent_id: each client is chatting with one agent, events go
// to the client(s) subscribed to that agent.

interface BrowserClient {
  ws: WebSocket;
  /** Which agent this client is currently chatting with */
  agentId: string | null;
  /** Authenticated username (from session cookie) */
  username?: string;
  /** Platform user ID from shizuha-id (integer). Used as the canonical user
   *  identifier so dashboard and mobile app share the same sessions. */
  platformUserId?: number;
  /** Source IP captured during WS upgrade. */
  remoteIp?: string;
  /** How the client authenticated during WS upgrade. */
  authMethod?: 'session-cookie' | 'device-token-query' | 'device-token-bearer' | 'localhost-bypass';
  /** Last time the client proved app-level liveness via ping/pong or any WS message. */
  lastHeartbeatAt: number;
  heartbeatTimer: NodeJS.Timeout | null;
}

// Exported for unit testing (PLAT-317). Pure: (method, url) -> required scope.
export function resolveAgentGatewayScope(method: string, url: string): AgentGatewayScope | null {
  if (method === 'GET' && url === '/v1/agents') return 'agents:list';
  if (method === 'POST' && url.startsWith('/v1/agents/') && url.endsWith('/message')) return 'agents:message';
  if (method === 'POST' && url.startsWith('/v1/agents/') && (
    url.endsWith('/pause')
    || url.endsWith('/resume')
    || url.endsWith('/kill-task')
    // PLAT-317: these three agent-management ops were missing from the scope map,
    // so they fell through to `null` -> 403 "not allowed for this endpoint",
    // breaking the DevOps self-serve seat-recovery ladder (reset_agent_session /
    // restart_agent / toggle_agent) post-PLAT-181. They are the same control
    // class as pause/resume/kill-task, so they take the same `agents:control` scope.
    || url.endsWith('/restart')             // /v1/agents/:id/restart
    || url.endsWith('/restart-if-running')  // /v1/agents/:id/restart-if-running (NOT matched by /restart)
    || url.endsWith('/reset-session')       // /v1/agents/:id/reset-session
    || url.endsWith('/toggle')              // /v1/agents/toggle
    || url.endsWith('/provision')           // HIVE-247: /v1/agents/provision (admission gate)
  )) {
    return 'agents:control';
  }
  return null;
}

function resolveAgentByIdentifier(agents: AgentInfo[], identifier: string | undefined): AgentInfo | null {
  if (!identifier) return null;
  return agents.find((agent) => agent.id === identifier || agent.username === identifier) ?? null;
}

interface AgentRestartRouteDeps {
  agents: AgentInfo[];
  restartAgent: (agentId: string) => Promise<void>;
  isAgentRunning: (agentId: string) => boolean;
  enableAndStartAgent: (agentId: string) => Promise<{ ok: boolean; error?: string }>;
  broadcastAgentUpdate: (agentId: string) => void;
}

/** Register the restart endpoint separately so its HTTP failure contract is executable in tests. */
export function registerAgentRestartRoute(
  app: FastifyInstance,
  deps: AgentRestartRouteDeps,
): void {
  app.post<{
    Params: { id: string };
  }>('/v1/agents/:id/restart', async (request, reply) => {
    const { id } = request.params;
    const resolved = resolveAgentByIdentifier(deps.agents, id);
    if (resolved && isK8sAgent(resolved)) {
      try {
        await deps.restartAgent(resolved.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: message || 'k8s restart failed' });
      }
      deps.broadcastAgentUpdate(resolved.id);
      setTimeout(() => deps.broadcastAgentUpdate(resolved.id), 3000);
      return { status: 'restarted', agent_id: resolved.id };
    }
    if (!deps.isAgentRunning(id)) {
      const result = await deps.enableAndStartAgent(id);
      if (!result.ok) return reply.status(500).send({ error: result.error });
      deps.broadcastAgentUpdate(id);
      return { status: 'restarted', agent_id: id };
    }
    await deps.restartAgent(id);
    deps.broadcastAgentUpdate(id);
    await new Promise((r) => setTimeout(r, 3000));
    setTimeout(() => deps.broadcastAgentUpdate(id), 3000);
    return { status: 'restarted', agent_id: id };
  });
}

function primaryExecutionMethod(agent: AgentInfo | undefined): string {
  return agent?.executionMethod ?? agent?.modelFallbacks?.[0]?.method ?? 'shizuha';
}

function shouldLogGatewayIngress(agent: AgentInfo | undefined): boolean {
  return primaryExecutionMethod(agent) === 'shizuha';
}

function previewContent(content: unknown, max = 180): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactActivityDetail(value: unknown, max = 4000): string {
  const text = typeof value === 'string'
    ? value
    : value == null
      ? ''
      : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function activityToolName(data: Record<string, unknown> | undefined, fallback = 'tool'): string {
  return String(data?.tool ?? data?.name ?? fallback);
}

export interface AgentActivityRate {
  words_per_sec: number | null;
  recent_words: number;
  window_sec: number;
  last_activity_ts: string | null;
  rate_available: boolean;
}

/**
 * Build the hot-path activity-rate projection from daemon-observed events.
 *
 * K8s-native agents do not stream stdout into the daemon, so their in-memory
 * event ring can be empty even while the lightweight last-activity probe is
 * current. In that case the rate is unknown, not zero: preserve the observed
 * timestamp and explicitly mark the numeric rate unavailable.
 */
export function buildAgentActivityRate(
  events: Array<{ ts?: string; detail?: string; tool?: string }>,
  lastKnownActivity: string | null | undefined,
  windowSec: number,
  nowMs = Date.now(),
): AgentActivityRate {
  const cutoffMs = nowMs - windowSec * 1000;
  let recentWords = 0;
  let firstTs = 0;
  let lastTs = 0;
  let sampleCount = 0;

  for (const event of events) {
    const tsMs = event.ts ? Date.parse(event.ts) : 0;
    if (!tsMs || tsMs < cutoffMs) continue;
    sampleCount++;
    const words = [event.detail, event.tool].filter(Boolean).join(' ')
      .trim().split(/\s+/).filter(Boolean).length;
    recentWords += words;
    if (!firstTs || tsMs < firstTs) firstTs = tsMs;
    if (tsMs > lastTs) lastTs = tsMs;
  }

  if (sampleCount === 0) {
    const fallbackTs = lastKnownActivity && !Number.isNaN(Date.parse(lastKnownActivity))
      ? new Date(lastKnownActivity).toISOString()
      : null;
    return {
      words_per_sec: null,
      recent_words: 0,
      window_sec: windowSec,
      last_activity_ts: fallbackTs,
      rate_available: false,
    };
  }

  // Rate over the active span within the window (reflects generation speed);
  // fall back to the full window when the span is too short to be meaningful.
  const spanSec = lastTs > firstTs ? (lastTs - firstTs) / 1000 : 0;
  const denom = spanSec >= 5 ? spanSec : windowSec;
  return {
    words_per_sec: Number((recentWords / denom).toFixed(2)),
    recent_words: recentWords,
    window_sec: windowSec,
    last_activity_ts: new Date(lastTs).toISOString(),
    rate_available: true,
  };
}

interface AgentStateDbMessage {
  role: string;
  content: string;
  timestamp: number;
}

function agentContainerName(agent: AgentInfo): string | null {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(agent.username)) return null;
  return `shizuha-agent-${agent.username}`;
}

function readAgentStateDbMessages(agent: AgentInfo, limit: number, sinceTs?: number): AgentStateDbMessage[] {
  const container = agentContainerName(agent);
  if (!container) return [];
  const where = typeof sinceTs === 'number' ? ` WHERE timestamp >= ${Math.trunc(sinceTs)}` : '';
  const sql = `
    SELECT role, content, timestamp
    FROM messages
    ${where}
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ${Math.max(1, Math.trunc(limit))};
  `;
  try {
    const raw = execFileSync(
      'docker',
      ['exec', container, 'sqlite3', '-json', '/workspace/.codex-state.db', sql],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
    );
    const rows = JSON.parse(raw || '[]') as AgentStateDbMessage[];
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row.timestamp === 'number') : [];
  } catch (err) {
    logger.debug({ agentId: agent.id, agentUsername: agent.username, err: (err as Error).message }, 'Agent state DB activity read failed');
    return [];
  }
}

function stateDbMessagesToActivity(messages: AgentStateDbMessage[]): any[] {
  return messages.map((message) => ({
    type: 'message',
    role: message.role,
    ts: new Date(message.timestamp).toISOString(),
    text: message.content.slice(0, 12_000),
  }));
}

/** Serialize an AgentInfo to the JSON shape the frontend expects. */
function redactAgentEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const secretName = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|bearer)/i;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, secretName.test(key) ? '****' : value]),
  );
}

function serializeAgent(a: AgentInfo): Record<string, unknown> {
  const state = readDaemonState();
  const agentState = state?.agents.find((s) => s.agentId === a.id);
  // Read the agent's platform user_id from its local cred file (populated by
  // ensureAgentAccount after shizuha-id login). The dashboard's Connect
  // bridge uses this to map conversation participants → agent UUIDs so
  // `bridge.sendChatMessage(agentId, ...)` can route by conv.
  let platformUserId: number | undefined;
  try {
    const credPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agent-auth', `${a.username}.json`);
    if (fs.existsSync(credPath)) {
      const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as { userId?: number };
      if (typeof cred.userId === 'number') platformUserId = cred.userId;
    }
  } catch { /* ignore — cred file may not exist for new agents */ }
  // SCLI-330: k8s agents have no stdout stream feeding the activity map — kick
  // a rate-limited background mtime probe so lastActiveAt stays truthful.
  scheduleK8sLastActivityProbe(a, noteAgentActivity);
  return {
    id: a.id,
    name: a.name,
    username: a.username,
    email: a.email,
    platformUserId,
    role: a.role,
    env: redactAgentEnv(a.env),
    executionMethod: a.executionMethod,
    runtimeEnvironment: a.runtimeEnvironment ?? 'bare_metal',
    resourceLimits: a.resourceLimits ?? {},
    modelOverrides: a.modelOverrides,
    modelFallbacks: a.modelFallbacks,
    skills: a.skills,
    eagerSkills: a.eagerSkills ?? [],
    personalityTraits: a.personalityTraits,
    mcpServers: (a.mcpServers || []).map((s) => ({ name: s.name, slug: s.slug })),
    effectiveCapabilities: a.effectiveCapabilities ?? null,
    status: agentState?.status ?? 'unknown',
    enabled: agentState?.enabled ?? false,
    pid: agentState?.pid,
    error: agentState?.error,
    lastActiveAt: getAgentLastActivity(a.id) ?? null,
    startedAt: agentState?.startedAt ?? null,
    credentials: (a.credentials ?? []).map((c) => ({
      ...c,
      credentialData: Object.fromEntries(
        Object.entries(c.credentialData).map(([k, v]) => [k, v ? v.slice(0, 4) + '****' : ''])
      ),
    })),
    agentMemory: a.agentMemory,
    workSchedule: a.workSchedule,
    tokenBudget: a.tokenBudget,
    maxConcurrentTasks: a.maxConcurrentTasks ?? 1,
    allowParallelExecution: a.allowParallelExecution ?? false,
    warmPoolSize: a.warmPoolSize ?? 0,
    tier: a.tier ?? 'normal',
    sshKeys: a.sshKeys ?? { enabled: false },
    contextPrompt: a.contextPrompt,
    failoverChainId: a.failoverChainId ?? null,
  };
}

class ChatbotBridge {
  private static readonly BROWSER_HEARTBEAT_INTERVAL_MS = 25_000;
  private static readonly BROWSER_HEARTBEAT_TIMEOUT_MS = 60_000;
  private platformWs: WebSocket | null = null;
  private connected = false;
  private _connectPingTimer: NodeJS.Timeout | null = null;
  private _connectLastPong = 0;
  private url: string | null;
  private clients = new Map<string, BrowserClient>();
  /** agent_id → Set of clientIds subscribed to this agent */
  private agentSubscribers = new Map<string, Set<string>>();
  /** Local agent WS connections: agentId → WebSocket to local gateway */
  private localAgentWs = new Map<string, WebSocket>();
  /** Pending reconnect timers so one close cannot fan out into many reconnects */
  private localAgentReconnectTimers = new Map<string, NodeJS.Timeout>();
  /** Reconnect backoff counters: agentId → consecutive failures */
  private localAgentReconnectBackoff = new Map<string, number>();
  /** Last connection status per scope so repeated identical status events are suppressed */
  private lastStatusByScope = new Map<string, boolean>();
  private agents: AgentInfo[];
  /** Pending device auth: clientId → { sessionId, pendingMessage } */
  private pendingDeviceAuth = new Map<string, { sessionId: string; agentId: string; content: unknown }>();
  /** Append-only event log for message reliability (Kafka-style cursors) */
  private eventLog: EventLog;
  /** Tracks execution IDs from local agents — used to skip platform echo duplicates */
  private _localExecutionIds: Set<string> = new Set();
  /** Last user message per agent — used to replay after inline auth */
  private lastUserMessage = new Map<string, unknown>();

  /** Platform base URL for Connect API calls */
  private platformBaseUrl: string | null = null;
  /** Platform access token for Connect API auth */
  private platformAccessToken: string | null = null;
  /** Agent ID → Connect conversation ID cache */
  private connectConversations = new Map<string, string>();
  /** Whether to route messages through Connect (platform-linked mode) */
  private useConnectRouting = false;

  constructor(platformUrl: string, accessToken: string, agents: AgentInfo[], eventLog: EventLog) {
    this.agents = agents;
    this.eventLog = eventLog;
    if (accessToken) {
      // PLAT-1161: in-cluster daemons (rt-fleet) should dial Connect's service
      // directly instead of round-tripping through the s1 nginx edge — the edge
      // adds a 502/ECONNREFUSED failure mode whenever nginx or its upstream
      // blips. When SHIZUHA_CONNECT_WS_BASE is set (e.g.
      // ws://shizuha-connect.shizuha.svc.cluster.local:8019), the WS path is
      // Connect's native /ws/... (no /connect edge-alias prefix).
      const connectWsBase = (process.env['SHIZUHA_CONNECT_WS_BASE'] ?? '').trim().replace(/\/+$/, '');
      const wsBase = platformUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
      this.connectWsUserUrl = connectWsBase
        ? `${connectWsBase}/ws/connect/user/`
        : `${wsBase}/connect/ws/connect/user/`;
      // Connect requires RS256 user JWTs (CON-122); shizuha-id still mints
      // HS256 for human identities (PLAT-255 back-compat), and the daemon's
      // platform token is the operator's human token. Dialing with an HS256
      // token yields 101-then-auth-close forever while the daemon logs
      // "connected" — fail CLOSED with a clear disabled state instead, and
      // self-heal via the token-refresh loop once an RS256 token appears
      // (contract gap tracked from PLAT-1161).
      if (jwtAlg(accessToken) !== 'RS256') {
        logger.error(
          { tokenAlg: jwtAlg(accessToken) ?? 'unknown' },
          'Dashboard chatbot WS disabled: Connect requires RS256 user JWTs (CON-122) '
          + 'but the platform token is not RS256 — channel disabled until an RS256 '
          + 'platform token is available (PLAT-1161)',
        );
        this.url = null;
      } else {
        // Connect directly to Connect's UserChatConsumer (unified, multiplexed per user)
        this.url = `${this.connectWsUserUrl}?token=${encodeURIComponent(accessToken)}`;
      }
      this.platformBaseUrl = platformUrl.replace(/\/+$/, '');
      this.platformAccessToken = accessToken;
      this.platformWsBase = wsBase;
      // Enable Connect routing when platform is linked. `userId` may live on
      // the auth.json top-level OR only inside the JWT — decode from token as
      // a fallback so older / partial auth.json files still route correctly.
      const authState = readShizuhaAuth();
      let userIdPresent = authState?.userId != null;
      if (!userIdPresent && accessToken) {
        try {
          const parts = accessToken.split('.');
          if (parts.length >= 2) {
            const payload = parts[1]! + '='.repeat((4 - parts[1]!.length % 4) % 4);
            const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
            userIdPresent = decoded.user_id != null;
          }
        } catch { /* leave as false */ }
      }
      this.useConnectRouting = !!platformUrl && !!accessToken && userIdPresent;
      // Periodically refresh the platform access token so long-running
      // daemons don't silently stop working after token TTL (~24h). Picks
      // up a new token from ~/.shizuha/auth.json and reconnects if it
      // changed.
      this.startPlatformTokenRefreshLoop();
    } else {
      this.url = null; // Local mode — no platform connection
    }
  }

  private _tokenRefreshTimer: NodeJS.Timeout | null = null;
  private platformWsBase: string | null = null;
  /** Resolved Connect user-WS URL (no token) — svc-direct when SHIZUHA_CONNECT_WS_BASE is set (PLAT-1161) */
  private connectWsUserUrl: string | null = null;
  /** Consecutive platform-WS connection failures since last successful open (PLAT-1161 health signal) */
  private _wsConsecutiveFailures = 0;

  private startPlatformTokenRefreshLoop(): void {
    if (this._tokenRefreshTimer) clearInterval(this._tokenRefreshTimer);
    const check = async () => {
      try {
        const { getValidShizuhaAccessToken } = await import('../config/shizuhaAuth.js');
        const fresh = await getValidShizuhaAccessToken();
        if (!fresh || fresh === this.platformAccessToken) return;
        logger.info('[platform-auth] access token refreshed — updating Connect WS');
        this.platformAccessToken = fresh;
        if (jwtAlg(fresh) !== 'RS256') {
          // Still no RS256 platform token — keep the channel fail-closed
          // rather than resuming the 101-then-auth-close loop (PLAT-1161).
          this.url = null;
          return;
        }
        if (this.connectWsUserUrl) {
          const wasDisabled = !this.url;
          this.url = `${this.connectWsUserUrl}?token=${encodeURIComponent(fresh)}`;
          if (wasDisabled) {
            logger.info('Dashboard chatbot WS re-enabled: RS256 platform token now available (PLAT-1161)');
            this.connect();
            return;
          }
        }
        // Force reconnect with fresh token
        if (this.platformWs) {
          try { this.platformWs.terminate(); } catch { /* ignore */ }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[platform-auth] refresh check failed');
      }
    };
    this._tokenRefreshTimer = setInterval(() => { void check(); }, 10 * 60 * 1000);
    // Also run once after 30s to pick up any recent refresh from parallel code paths
    setTimeout(() => { void check(); }, 30_000);
  }

  connect(): void {
    if (this.platformWs || !this.url) return;

    this.platformWs = new WebSocket(this.url);

    this.platformWs.on('open', () => {
      this.connected = true;
      let endpoint = 'connect-ws';
      try {
        const parsed = new URL(this.url ?? '');
        endpoint = `${parsed.origin}${parsed.pathname}`;
      } catch { /* keep generic endpoint */ }
      if (this._wsConsecutiveFailures > 0) {
        logger.info(
          { recoveredAfterFailures: this._wsConsecutiveFailures },
          'Dashboard chatbot WS recovered',
        );
      }
      this._wsConsecutiveFailures = 0;
      logger.info({ endpoint }, 'Dashboard Connect WS connected');
      this.emitTransportStatus(true);

      // Keepalive ping every 30s with stale detection
      if (this._connectPingTimer) clearInterval(this._connectPingTimer);
      this._connectLastPong = Date.now();
      this._connectPingTimer = setInterval(() => {
        if (this.platformWs?.readyState === WebSocket.OPEN) {
          // If no pong received in 60s, connection is dead — force reconnect
          if (Date.now() - this._connectLastPong > 60_000) {
            console.log('[ConnectWS] No pong in 60s — connection dead, reconnecting');
            this.platformWs?.terminate();
            return;
          }
          try { this.platformWs.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
        }
      }, 30_000);

      // Push local agent configs to platform (local-first sync)
      this.pushAgentSync();
    });

    this.platformWs.on('message', (data: Buffer | string) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString();
        const msg = JSON.parse(raw);
        const msgType = msg.type as string;

        // Handle sync messages from platform (legacy, may still arrive)
        if (msgType?.startsWith('sync:')) {
          this.handleSyncMessage(msg);
          return;
        }

        // ── Connect UserChatConsumer events ──
        // These arrive directly from Connect's multiplexed user WS.
        // Same protocol as the Kotlin app receives.
        if (msgType === 'new_message' || msgType === 'agent_stream'
            || msgType === 'typing' || msgType === 'message_read'
            || msgType === 'message_delivered'
            || msgType === 'conversation_created'
            || msgType === 'missed_message'
            || msgType === 'send_error') {
          this.handleConnectEvent(msg);
          return;
        }

        // Server-initiated ping — respond with pong
        if (msgType === 'ping') {
          try { this.platformWs?.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
          this._connectLastPong = Date.now(); // Server is alive
          return;
        }

        // Pong from our keepalive ping
        if (msgType === 'pong') {
          this._connectLastPong = Date.now();
          return;
        }

        this.routeFromUpstream(msg);
      } catch { /* ignore malformed */ }
    });

    this.platformWs.on('close', () => {
      this.connected = false;
      this.platformWs = null;
      this.emitTransportStatus(false);
      if (this.url) {
        // Exponential backoff, capped — a dead edge/upstream must not produce
        // a hot 3s retry loop that floods the daemon log (PLAT-1161).
        this._wsConsecutiveFailures += 1;
        const backoffMs = Math.min(3000 * 2 ** Math.min(this._wsConsecutiveFailures - 1, 5), 60_000);
        setTimeout(() => this.connect(), backoffMs);
      }
    });

    this.platformWs.on('error', (err: Error) => {
      // Log the first failure at error level, then every 10th at warn with the
      // running count — repeated identical failures become one visible health
      // signal instead of hidden per-attempt noise (PLAT-1161).
      const failures = this._wsConsecutiveFailures;
      if (failures === 0) {
        logger.error({ err, wsUrl: this.connectWsUserUrl }, 'Dashboard chatbot WS error');
      } else if (failures % 10 === 0) {
        logger.warn(
          { err: err.message, consecutiveFailures: failures, wsUrl: this.connectWsUserUrl },
          'Dashboard chatbot WS still failing',
        );
      }
    });
  }

  private clearLocalAgentReconnect(agentId: string): void {
    const timer = this.localAgentReconnectTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.localAgentReconnectTimers.delete(agentId);
    }
  }

  private statusScopeKey(type: string, agentId?: string | null): string {
    return type === 'agent_status' && agentId ? `agent:${agentId}` : 'global';
  }

  private normalizeStatusEvent(
    msg: Record<string, unknown>,
    agentId?: string | null,
  ): Record<string, unknown> | null {
    const rawType = msg.type as string;
    if (rawType !== 'transport_status' && rawType !== 'agent_status') {
      return msg;
    }

    const connected = msg.connected;
    if (typeof connected !== 'boolean') return msg;

    const normalizedType = rawType;
    const scopedAgentId = normalizedType === 'agent_status'
      ? agentId ?? (msg.agent_id as string | undefined)
      : undefined;
    if (normalizedType === 'agent_status' && !scopedAgentId) return null;

    const scopeKey = this.statusScopeKey(normalizedType, scopedAgentId);
    if (this.lastStatusByScope.get(scopeKey) === connected) return null;
    this.lastStatusByScope.set(scopeKey, connected);

    const normalized: Record<string, unknown> = {
      ...msg,
      type: normalizedType,
      connected,
    };
    if (normalizedType === 'agent_status') {
      normalized.agent_id = scopedAgentId;
    } else if ('agent_id' in normalized) {
      delete normalized.agent_id;
    }
    return normalized;
  }

  private emitTransportStatus(connected: boolean): void {
    const msg = this.normalizeStatusEvent({ type: 'transport_status', connected });
    if (!msg) return;
    this.broadcastAll(msg);
  }

  private emitAgentStatus(agentId: string, connected: boolean): void {
    const msg = this.normalizeStatusEvent({ type: 'agent_status', connected, agent_id: agentId }, agentId);
    if (!msg) return;
    this.broadcastToAgent(agentId, msg);
  }

  private touchClientHeartbeat(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastHeartbeatAt = Date.now();
    }
  }

  private stopClientHeartbeat(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client?.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = null;
    }
  }

  private startClientHeartbeat(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.stopClientHeartbeat(clientId);
    client.lastHeartbeatAt = Date.now();
    client.heartbeatTimer = setInterval(() => {
      const current = this.clients.get(clientId);
      if (!current) return;
      if (current.ws.readyState !== WebSocket.OPEN) {
        this.stopClientHeartbeat(clientId);
        return;
      }
      if (Date.now() - current.lastHeartbeatAt > ChatbotBridge.BROWSER_HEARTBEAT_TIMEOUT_MS) {
        logger.warn({ clientId, agentId: current.agentId, username: current.username }, 'Dashboard WS heartbeat timed out');
        this.stopClientHeartbeat(clientId);
        try {
          current.ws.close(4000, 'heartbeat timeout');
        } catch { /* ignore */ }
        return;
      }
      this.sendToClient(clientId, { type: 'ping' });
    }, ChatbotBridge.BROWSER_HEARTBEAT_INTERVAL_MS);
  }

  private scheduleLocalAgentReconnect(agentId: string): void {
    if (this.localAgentReconnectTimers.has(agentId) || !isAgentRunning(agentId)) return;
    // Don't guard on getContainerUrl() here — it may return null during restart
    // while the new container is still spinning up. Let connectLocalAgent handle null.

    // Exponential backoff: 3s, 6s, 12s, 24s, 30s max
    const failures = this.localAgentReconnectBackoff.get(agentId) ?? 0;
    const delay = Math.min(3000 * Math.pow(2, failures), 30_000);
    this.localAgentReconnectBackoff.set(agentId, failures + 1);

    const timer = setTimeout(() => {
      if (this.localAgentReconnectTimers.get(agentId) === timer) {
        this.localAgentReconnectTimers.delete(agentId);
      }
      this.connectLocalAgent(agentId);
    }, delay);

    this.localAgentReconnectTimers.set(agentId, timer);
  }

  async waitForLocalAgentSocket(agentId: string, ws: WebSocket | null): Promise<WebSocket | null> {
    if (!ws) return null;
    if (ws.readyState === WebSocket.OPEN) return ws;

    if (ws.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        const onOpen = () => { ws.removeListener('error', onErr); ws.removeListener('close', onClose); resolve(); };
        const onErr = () => { ws.removeListener('open', onOpen); ws.removeListener('close', onClose); resolve(); };
        const onClose = () => { ws.removeListener('open', onOpen); ws.removeListener('error', onErr); resolve(); };
        ws.once('open', onOpen);
        ws.once('error', onErr);
        ws.once('close', onClose);
      });
      return ws.readyState === WebSocket.OPEN
        ? ws
        : this.waitForLocalAgentSocket(agentId, this.connectLocalAgent(agentId));
    }

    if (ws.readyState === WebSocket.CLOSING) {
      await new Promise<void>((resolve) => ws.once('close', () => resolve()));
      return this.waitForLocalAgentSocket(agentId, this.connectLocalAgent(agentId));
    }

    return this.waitForLocalAgentSocket(agentId, this.connectLocalAgent(agentId));
  }

  /** Connect to a local agent's gateway WS */
  connectLocalAgent(agentId: string): WebSocket | null {
    const existing = this.localAgentWs.get(agentId);
    if (existing) {
      if (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING) {
        return existing;
      }
      if (existing.readyState === WebSocket.CLOSING) {
        return existing;
      }
      this.localAgentWs.delete(agentId);
    }

    const wsUrl = getContainerUrl(agentId);
    if (!wsUrl) return null;

    const ws = new WebSocket(wsUrl);
    this.localAgentWs.set(agentId, ws);

    ws.on('open', () => {
      if (this.localAgentWs.get(agentId) !== ws) {
        ws.close();
        return;
      }
      this.clearLocalAgentReconnect(agentId);
      this.localAgentReconnectBackoff.delete(agentId);
      logger.info({ agentId, wsUrl }, 'Connected to local agent gateway');
      // Notify subscribers that local agent is connected
      this.emitAgentStatus(agentId, true);

      // Periodic ping to detect stale connections (container restarts)
      const pingInterval = setInterval(() => {
        if (this.localAgentWs.get(agentId) !== ws || ws.readyState !== WebSocket.OPEN) {
          clearInterval(pingInterval);
          return;
        }
        try {
          ws.ping();
        } catch {
          // Ping failed — connection is dead, force reconnect
          logger.warn({ agentId }, 'WS ping failed — stale connection, forcing reconnect');
          clearInterval(pingInterval);
          this.localAgentWs.delete(agentId);
          ws.terminate();
          this.connectLocalAgent(agentId);
        }
      }, 30_000); // Check every 30s

      // If pong not received within 10s after ping, connection is stale
      ws.on('pong', () => { /* connection alive */ });
    });

    // Accumulate streamed content so we mirror a single complete message
    let streamedContent = '';
    let streamRequestId = '';

    ws.on('message', (data: Buffer) => {
      if (this.localAgentWs.get(agentId) !== ws) return;
      try {
        const msg = JSON.parse(data.toString());
        // Skip local relay events when Connect routing is active —
        // events already arrive via Connect's UserChatConsumer WS.
        if (this.useConnectRouting && this.connectConversations.has(agentId)) return;
        // Tag with agent_id so routing works
        if (!msg.agent_id) msg.agent_id = agentId;
        msg._fromLocal = true; // Mark as locally-originated (for dedup in routeFromUpstream)
        this.routeFromUpstream(msg);

        // Runner-proxy forwarding of agent stream events to shizuha-agent's
        // /ws/runner/ was removed 2026-04-20 along with the runner proxy.
        const msgType = msg.type as string;

        const msgData = msg.data as Record<string, unknown> | undefined;
        const activityTs = new Date().toISOString();
        if (msgType === 'session_start') {
          logActivity(agentId, { ts: activityTs, type: 'session_start', detail: 'Turn started' });
        } else if (msgType === 'content') {
          logActivity(agentId, {
            ts: activityTs,
            type: 'message_sent',
            detail: compactActivityDetail(msgData?.delta ?? msgData?.content ?? ''),
          });
        } else if (msgType === 'reasoning') {
          logActivity(agentId, {
            ts: activityTs,
            type: 'reasoning',
            detail: compactActivityDetail(msgData?.text ?? msgData?.summary ?? msgData?.summaries ?? ''),
          });
        } else if (msgType === 'tool_start') {
          logActivity(agentId, {
            ts: activityTs,
            type: 'tool_start',
            tool: activityToolName(msgData),
            detail: compactActivityDetail(msgData?.input ?? msgData?.command ?? ''),
          });
        } else if (msgType === 'tool_output') {
          logActivity(agentId, {
            ts: activityTs,
            type: 'tool_output',
            tool: activityToolName(msgData),
            detail: compactActivityDetail(msgData?.output ?? msgData?.delta ?? ''),
            stream: typeof msgData?.stream === 'string' ? msgData.stream : undefined,
          });
        } else if (msgType === 'tool_complete') {
          logActivity(agentId, {
            ts: activityTs,
            type: 'tool_complete',
            tool: activityToolName(msgData),
            detail: compactActivityDetail(msgData),
          });
        } else if (msgType === 'complete') {
          logActivity(agentId, { ts: activityTs, type: 'turn_complete', detail: 'Turn completed' });
        } else if (msgType === 'error') {
          logActivity(agentId, {
            ts: activityTs,
            type: 'error',
            detail: compactActivityDetail(msgData?.message ?? msgData?.error ?? msg),
          });
        }

        // MCP tool-error telemetry — capture failed tool calls into the
        // per-agent rolling buffer. The agent's chat shows this in-line as
        // a tool card; we additionally aggregate it so operators can see
        // "Shizuha hit 5 connect-mcp errors in the last hour" at a glance.
        if (msgType === 'tool_complete') {
          const td = msgData;
          if (td?.is_error) {
            const toolName = (td.tool ?? td.name ?? 'unknown') as string;
            const errMsg = (td.error_text ?? td.error ?? td.message ?? '') as string;
            recordToolError(agentId, toolName, errMsg);
          }
        }

        // Accumulate streamed assistant content for platform mirror
        if (msgType === 'content') {
          if (!streamRequestId) streamRequestId = crypto.randomUUID();
          streamedContent += (msgData?.delta ?? '');
        } else if (msgType === 'complete') {
          // Mirror complete assistant message to platform (best-effort cross-device sync)
          if (streamedContent.trim()) {
            this.forwardToPlatform({
              type: 'mirror',
              agent_id: agentId,
              role: 'assistant',
              content: streamedContent,
              request_id: streamRequestId,
              source_service: 'dashboard',
            });
          }
          streamedContent = '';
          streamRequestId = '';
        }
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => {
      if (this.localAgentWs.get(agentId) !== ws) return;
      this.localAgentWs.delete(agentId);
      clearContainerIpCache(agentId); // Clear stale IP immediately on disconnect
      this.emitAgentStatus(agentId, false);
      this.scheduleLocalAgentReconnect(agentId);
    });

    ws.on('error', (err: Error) => {
      if (this.localAgentWs.get(agentId) !== ws) return;
      logger.error({ err, agentId }, 'Local agent WS error');
    });

    return ws;
  }

  /** All agents in agents.json are local — check if one exists with this ID. */
  private isLocalAgent(agentId: string): boolean {
    return this.agents.some((a) => a.id === agentId);
  }

  /** Get the local agent WS connection (used by runner proxy to forward messages). */
  getLocalAgentWs(agentId: string): WebSocket | null {
    const ws = this.localAgentWs.get(agentId);
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    // Lazily connect if not connected yet
    const newWs = this.connectLocalAgent(agentId);
    return newWs && newWs.readyState === WebSocket.OPEN ? newWs : null;
  }

  /** Proactively connect to all local agents (for runner proxy). */
  connectAllLocalAgents(): void {
    for (const agent of this.agents) {
      if (!this.localAgentWs.has(agent.id)) {
        this.connectLocalAgent(agent.id);
      }
    }
  }

  /** Forward a message to the platform WS (best-effort, fire-and-forget). */
  private forwardToPlatform(msg: Record<string, unknown>): void {
    if (this.platformWs && this.connected) {
      this.platformWs.send(JSON.stringify(msg));
    }
  }

  /**
   * Send a message to an agent via Connect REST API.
   * Returns true if the message was sent successfully.
   */
  private async sendViaConnect(agentId: string, content: string, clientId: string): Promise<boolean> {
    const t0 = Date.now();
    const CONNECT_API = 'http://localhost';

    if (!this.platformAccessToken) {
      logger.warn({ agentId }, '[Connect:send] no platform access token');
      return false;
    }

    try {
      // Step 1: Resolve conversation ID
      let convId = this.connectConversations.get(agentId);
      logger.info({ agentId, cached: !!convId, elapsed: Date.now() - t0 }, '[Connect:send] step 1: resolve convId');

      if (!convId) {
        try {
          convId = (await this.getOrCreateConnectConversation(agentId)) ?? undefined;
        } catch (lookupErr) {
          logger.error({ err: (lookupErr as Error).message, stack: (lookupErr as Error).stack?.split('\n').slice(0,3).join(' | '), agentId, elapsed: Date.now() - t0 }, '[Connect:send] conversation lookup threw');
        }
        if (!convId) {
          logger.warn({ agentId, elapsed: Date.now() - t0 }, '[Connect:send] no convId — aborting');
          return false;
        }
        this.connectConversations.set(agentId, convId);
        // Subscribe to this conversation's events on the platform WS
        // so we receive agent_stream events for streaming
        if (this.platformWs && this.connected) {
          this.platformWs.send(JSON.stringify({
            type: 'subscribe_conversation',
            conversation_id: convId,
          }));
        }
      }

      // Step 2: POST message to Connect
      const url = `${CONNECT_API}/connect/api/conversations/${convId}/messages/`;
      const clientMsgId = crypto.randomUUID();
      logger.info({ agentId, convId: convId.substring(0, 8), url, elapsed: Date.now() - t0 }, '[Connect:send] step 2: POST message');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.platformAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, client_message_id: clientMsgId }),
        signal: AbortSignal.timeout(10000),
      });

      logger.info({ agentId, status: response.status, elapsed: Date.now() - t0 }, '[Connect:send] step 3: response received');

      if (response.ok) {
        return true;
      } else {
        const errText = await response.text().catch(() => '');
        logger.warn({ agentId, status: response.status, body: errText.substring(0, 200), elapsed: Date.now() - t0 }, '[Connect:send] HTTP error');
        return false;
      }
    } catch (err) {
      logger.error({ err: (err as Error).message, stack: (err as Error).stack?.split('\n').slice(0,3).join(' | '), agentId, elapsed: Date.now() - t0 }, '[Connect:send] exception');
      return false;
    }
  }

  /**
   * Fetch message history from Connect API and send as event_replay to the browser.
   * This provides message persistence across daemon restarts — messages are stored
   * in Connect's PostgreSQL, not the daemon's ephemeral event log.
   */
  private async replayFromConnect(clientId: string, agentId: string): Promise<boolean> {
    if (!this.platformAccessToken) return false;

    try {
      let convId = this.connectConversations.get(agentId);
      if (!convId) {
        convId = (await this.getOrCreateConnectConversation(agentId)) ?? undefined;
        if (convId) this.connectConversations.set(agentId, convId);
      }
      if (!convId) return false;

      // Hit the real platform directly instead of a self-proxy on port 80
      // (which doesn't exist — daemon listens on 8015 only). The dashboard
      // browser already has its own ConnectBridge doing REST sync, so this
      // path is now mostly vestigial — but when it DOES fire, at least let
      // it succeed.
      const base = (this.platformBaseUrl ?? '').replace(/\/+$/, '');
      if (!base) return false;
      const url = `${base}/connect/api/conversations/${convId}/messages/`;
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.platformAccessToken}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return false;

      const data = await resp.json() as { messages?: Array<Record<string, unknown>> };
      const messages = data.messages;
      if (!Array.isArray(messages) || messages.length === 0) return false;

      // Resolve "me" for left/right alignment. The viewer is the dashboard
      // user this WS connection authenticated as — NOT the daemon-runner's
      // shizuha-id account (those can be different identities entirely:
      // daemon ran first under user_id=1, Hritik later logged into the
      // dashboard as user_id=3). Falling back to the runner identity made
      // every message Hritik typed render as agent on refresh because
      // `'3' === '1'` is false → all messages took the `else` branch →
      // session_start + content + complete = agent-side bubble.
      const client = this.clients.get(clientId);
      let myUserId = client?.platformUserId != null ? String(client.platformUserId) : '';
      // Last-resort fallback to the runner's identity (covers headless test
      // contexts where the WS client wasn't fully authenticated). Decode
      // user_id from the access token JWT directly so a legacy auth.json
      // missing the explicit `userId` field still resolves correctly.
      if (!myUserId) {
        const authState = readShizuhaAuth();
        myUserId = authState?.userId != null ? String(authState.userId) : '';
        if (!myUserId && authState?.accessToken) {
          try {
            const parts = authState.accessToken.split('.');
            if (parts.length >= 2) {
              const payload = parts[1]! + '='.repeat((4 - parts[1]!.length % 4) % 4);
              const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
              if (decoded.user_id != null) myUserId = String(decoded.user_id);
            }
          } catch { /* malformed token — leave as '' */ }
        }
      }

      // Convert Connect messages to dashboard event_replay format
      const events: Array<Record<string, unknown>> = [];
      let seq = 1;
      for (const msg of messages) {
        const senderId = String(msg.sender_id ?? '');
        const content = (msg.content as string) ?? '';
        const isMe = senderId === myUserId;
        const ts = new Date(msg.created_at as string).getTime();

        if (isMe) {
          // User message
          events.push({
            type: 'user_message',
            agent_id: agentId,
            data: {
              content,
              message_id: msg.id,
              request_id: msg.client_message_id ?? msg.id,
            },
            _seq: seq++,
            _ts: ts,
          });
        } else {
          // Agent/other message — replay as session_start → content → complete
          // The frontend accumulates content from 'content' events before
          // finalizing on 'complete', so we must include the content event.
          const execId = String(msg.id);
          events.push({
            type: 'session_start',
            agent_id: agentId,
            execution_id: execId,
            data: { session_id: convId, message_id: msg.id },
            _seq: seq++,
            _ts: ts,
          });
          events.push({
            type: 'content',
            agent_id: agentId,
            execution_id: execId,
            data: { delta: content },
            _seq: seq++,
            _ts: ts,
          });
          events.push({
            type: 'complete',
            agent_id: agentId,
            execution_id: execId,
            data: { content },
            _seq: seq++,
            _ts: ts,
          });
        }
      }

      this.sendToClient(clientId, {
        type: 'event_replay',
        agent_id: agentId,
        events,
        first_seq: 1,
        last_seq: seq - 1,
        cursor: seq - 1,
      });
      return true;
    } catch (err) {
      logger.debug({ err: (err as Error).message, agentId }, '[Connect:replay] Failed to fetch history');
      return false;
    }
  }

  /**
   * Get or create a Connect conversation between the current user and an agent.
   */
  private async getOrCreateConnectConversation(agentId: string): Promise<string | null> {
    const t0 = Date.now();
    const CONNECT_API = 'http://localhost';

    if (!this.platformAccessToken) {
      logger.warn('[Connect:lookup] no access token');
      return null;
    }

    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent) {
      logger.warn({ agentId, agentCount: this.agents.length, ids: this.agents.slice(0,3).map(a => a.id) }, '[Connect:lookup] agent not found in roster');
      return null;
    }
    logger.info({ agentId, agentName: agent.name, elapsed: Date.now() - t0 }, '[Connect:lookup] agent found, fetching conversations');

    try {
      const listUrl = `${CONNECT_API}/connect/api/conversations/`;
      logger.info({ url: listUrl, tokenLen: this.platformAccessToken.length, elapsed: Date.now() - t0 }, '[Connect:lookup] fetching...');
      const listResp = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${this.platformAccessToken}` },
        signal: AbortSignal.timeout(10000),
      });
      logger.info({ status: listResp.status, elapsed: Date.now() - t0 }, '[Connect:lookup] fetch completed');
      if (listResp.ok) {
        const conversations = await listResp.json() as Array<Record<string, unknown>>;
        for (const conv of conversations) {
          if (conv.conversation_type !== 'direct') continue;
          const participants = conv.participants as Array<Record<string, unknown>> | undefined;
          if (!participants) continue;
          // Match by agent name or user_name (agents may be registered as
          // human participants if created via regular conversation API)
          const hasAgent = participants.some((p) =>
            (p.participant_type === 'agent' && p.agent_id === agentId) ||
            (p.user_name === agent.name) ||
            (p.user_name === agent.username)
          );
          if (hasAgent) return conv.id as string;
        }
      }

      // No existing conversation — create one.
      // We need the agent's platform user_id. Try the stored email first,
      // then fall back to <username>@shizuha.com. Many agents have stale
      // stored emails (`*@agents.shizuha.io`, `*@local`) that don't match
      // shizuha-id which uses `*@shizuha.com`.
      const username = (agent as any).username ?? agent.name.toLowerCase();
      const emailCandidates = Array.from(new Set([
        (agent as any).email,
        `${username}@shizuha.com`,
      ].filter(Boolean)));
      let agentUserId: number | null = null;
      for (const email of emailCandidates) {
        const url = `${CONNECT_API}/id/api/internal/users/by-email/?email=${encodeURIComponent(email)}`;
        try {
          const resp = await fetch(url, {
            headers: { 'Authorization': `Bearer ${this.platformAccessToken}` },
            signal: AbortSignal.timeout(5000),
          });
          if (resp.ok) {
            const user = await resp.json() as Record<string, unknown>;
            if (user && typeof user.id === 'number') {
              agentUserId = user.id;
              logger.info({ agentId, email, agentUserId }, '[Connect:lookup] resolved platform user id');
              break;
            }
          } else {
            logger.info({ email, status: resp.status }, '[Connect:lookup] email variant not found, trying next');
          }
        } catch (err) {
          logger.warn({ email, err: (err as Error).message }, '[Connect:lookup] email lookup threw');
        }
      }

      if (!agentUserId) {
        logger.warn({ agentId, agentName: agent.name, emailCandidates }, 'Could not find agent platform user ID');
        return null;
      }

      // Create the conversation
      const createUrl = `${CONNECT_API}/connect/api/conversations/`;
      const createResp = await fetch(createUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.platformAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversation_type: 'direct',
          participant_ids: [agentUserId],
          participant_details: {
            [String(agentUserId)]: {
              name: agent.name,
              email: (agent as any).email ?? `${(agent as any).username ?? agent.name}@shizuha.com`,
            },
          },
        }),
      });

      if (createResp.ok) {
        const conv = await createResp.json() as Record<string, unknown>;
        logger.info({ agentId, convId: (conv.id as string).substring(0, 8) }, 'Created Connect conversation');
        return conv.id as string;
      }

      return null;
    } catch (err) {
      logger.error({ err: (err as Error).message, name: (err as Error).name, stack: (err as Error).stack?.split('\n').slice(0,3).join(' | '), agentId, elapsed: Date.now() - t0 }, '[Connect:lookup] exception');
      return null;
    }
  }

  /** Register a browser WebSocket client */
  addClient(
    clientId: string,
    ws: WebSocket,
    meta?: {
      username?: string;
      platformUserId?: number;
      remoteIp?: string;
      authMethod?: BrowserClient['authMethod'];
    },
  ): void {
    this.clients.set(clientId, {
      ws,
      agentId: null,
      username: meta?.username,
      platformUserId: meta?.platformUserId,
      remoteIp: meta?.remoteIp,
      authMethod: meta?.authMethod,
      lastHeartbeatAt: Date.now(),
      heartbeatTimer: null,
    });
    this.startClientHeartbeat(clientId);

    ws.on('message', (data: Buffer) => {
      try {
        this.routeFromBrowser(clientId, JSON.parse(data.toString())).catch((err) => {
          console.error(`[dashboard] routeFromBrowser error for client ${clientId}:`, (err as Error).message);
        });
      } catch { /* ignore malformed JSON */ }
    });

    ws.on('close', () => {
      this.stopClientHeartbeat(clientId);
      const client = this.clients.get(clientId);
      if (client?.agentId) {
        this.agentSubscribers.get(client.agentId)?.delete(clientId);
      }
      this.clients.delete(clientId);
    });

    // Report transport state — all agents are local, platform is optional relay
    this.sendToClient(clientId, {
      type: 'transport_status',
      connected: this.connected || this.agents.length > 0,
    });
  }

  /** Subscribe a client to an agent's events */
  private subscribe(clientId: string, agentId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Unsubscribe from previous agent
    if (client.agentId && client.agentId !== agentId) {
      this.agentSubscribers.get(client.agentId)?.delete(clientId);
    }

    client.agentId = agentId;
    let subs = this.agentSubscribers.get(agentId);
    if (!subs) {
      subs = new Set();
      this.agentSubscribers.set(agentId, subs);
    }
    subs.add(clientId);
  }

  private logGatewayIngress(
    agentId: string,
    pathway: 'dashboard_ws' | 'agents_ask' | 'webhook',
    details: {
      clientId?: string;
      username?: string;
      remoteIp?: string;
      authMethod?: string;
      requestId?: string;
      source?: string;
      content: unknown;
    },
  ): void {
    const agent = this.agents.find((entry) => entry.id === agentId);
    if (!shouldLogGatewayIngress(agent)) return;

    logger.info({
      agentId,
      agentName: agent?.name,
      agentUsername: agent?.username,
      executionMethod: primaryExecutionMethod(agent),
      pathway,
      clientId: details.clientId,
      username: details.username,
      remoteIp: details.remoteIp,
      authMethod: details.authMethod,
      requestId: details.requestId,
      source: details.source,
      contentPreview: previewContent(details.content),
      contentLength: typeof details.content === 'string'
        ? details.content.length
        : JSON.stringify(details.content).length,
    }, 'Gateway ingress message');
  }

  /** Route a message from browser → platform or local agent */
  private async routeFromBrowser(clientId: string, msg: Record<string, unknown>): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.touchClientHeartbeat(clientId);

    const type = msg.type as string;

    if (type === 'ping') {
      this.sendToClient(clientId, { type: 'pong' });
      return;
    }
    if (type === 'pong') {
      return;
    }

    // ── JSON-RPC over WebSocket ──
    if (type === 'rpc') {
      const rpcId = msg.id as string;
      const method = msg.method as string;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      try {
        const result = await this.handleRpc(method, params);
        this.sendToClient(clientId, { type: 'rpc_response', id: rpcId, result });
      } catch (err) {
        this.sendToClient(clientId, {
          type: 'rpc_response',
          id: rpcId,
          error: { message: (err as Error).message },
        });
      }
      return;
    }

    // Explicit subscribe — browser opens a chat view without sending a message
    if (type === 'subscribe') {
      const agentId = msg.agent_id as string;
      if (agentId) {
        this.subscribe(clientId, agentId);
        this.sendToClient(clientId, { type: 'subscribed', agent_id: agentId });
        // For local agents, ensure WS connection to gateway
        if (this.isLocalAgent(agentId) && isAgentRunning(agentId)) {
          this.connectLocalAgent(agentId);
        }
      }
      return;
    }

    // Sync request — subscribe to the agent so real-time events arrive.
    // If the client sends a cursor, replay missed events from the event log.
    if (type === 'sync') {
      const agentId = msg.agent_id as string;
      if (agentId) {
        this.subscribe(clientId, agentId);
        if (this.isLocalAgent(agentId) && isAgentRunning(agentId)) {
          this.connectLocalAgent(agentId);
        }

        // ── Message replay ──
        // When Connect routing is active, Connect is the sole source of truth
        // (like WhatsApp Server). Skip the daemon's ephemeral event log.
        //
        // Contract: this MUST emit exactly one `event_replay` back to the
        // client, even if there's nothing to replay. The dashboard gates
        // real-time event processing behind `pendingReplayRef` until
        // event_replay arrives; if we stay silent after sync, bridge-sourced
        // messages queue up and never render.
        if (this.useConnectRouting) {
          const replayed = await this.replayFromConnect(clientId, agentId);
          if (!replayed) {
            // Send an empty event_replay to unblock the client's replay gate.
            this.sendToClient(clientId, {
              type: 'event_replay',
              agent_id: agentId,
              events: [],
              first_seq: 0,
              last_seq: 0,
              cursor: 0,
            });
          }
        } else {
          // Local mode: use daemon's event log for replay
          const cursor = typeof msg.cursor === 'number' ? msg.cursor : 0;
          const serverMaxSeq = this.eventLog.latestSeq(agentId);
          if (cursor > 0 && serverMaxSeq !== null && cursor > serverMaxSeq) {
            this.sendToClient(clientId, {
              type: 'cursor_reset',
              agent_id: agentId,
              data: { reason: 'server_behind', serverSeq: serverMaxSeq, clientCursor: cursor },
            });
          }
          const effectiveCursor = (cursor > 0 && serverMaxSeq !== null && cursor > serverMaxSeq) ? 0 : cursor;
          const BATCH_SIZE = 2000;
          const MAX_TOTAL = 2000;
          let afterSeq = effectiveCursor;
          if (afterSeq === 0 && serverMaxSeq !== null && serverMaxSeq > MAX_TOTAL) {
            afterSeq = Math.max(0, serverMaxSeq - MAX_TOTAL);
          }
          let missed: import('./event-log.js').ReplayedEvent[] = [];
          let batch: import('./event-log.js').ReplayedEvent[];
          do {
            batch = this.eventLog.replay(agentId, afterSeq, BATCH_SIZE);
            missed.push(...batch);
            if (batch.length > 0) afterSeq = batch[batch.length - 1]!.seq;
          } while (batch.length === BATCH_SIZE && missed.length < MAX_TOTAL);
          if (missed.length > 0) {
            const coalesced = this.coalesceReplayEvents(missed);
            this.sendToClient(clientId, {
              type: 'event_replay',
              agent_id: agentId,
              events: coalesced.map((e) => ({ ...e.event, _seq: e.seq, _ts: e.ts })),
              first_seq: missed[0]!.seq,
              last_seq: missed[missed.length - 1]!.seq,
              cursor: missed[missed.length - 1]!.seq,
            });
          }
        }
      }
      return;
    }

    // Restart session — kill agent process so next message starts fresh context
    if (type === 'restart_session') {
      const agentId = msg.agent_id as string;
      if (!agentId) return;

      this.subscribe(clientId, agentId);

      if (this.isLocalAgent(agentId)) {
        // Local agent: stop → start to get a fresh process
        this.sendToClient(clientId, {
          type: 'status_update',
          data: { message: 'Restarting agent session...', agent_id: agentId },
        });

        // Close existing WS to local agent
        const existingWs = this.localAgentWs.get(agentId);
        if (existingWs) {
          existingWs.close();
        }

        await restartAgent(agentId);

        // Wait for the process to exit and auto-restart to bring it back
        await new Promise((r) => setTimeout(r, 8000));

        if (!isAgentRunning(agentId)) {
          this.sendToClient(clientId, {
            type: 'error',
            data: { message: 'Agent is restarting — it may take a few seconds' },
          });
          return;
        }

        await new Promise((r) => setTimeout(r, 2000));
        this.connectLocalAgent(agentId);
      } else {
        // Platform agent: forward restart request to platform WS
        if (this.platformWs && this.connected) {
          this.platformWs.send(JSON.stringify({
            type: 'restart_session',
            agent_id: agentId,
          }));
        }
      }

      this.sendToClient(clientId, {
        type: 'session_restarted',
        agent_id: agentId,
      });
      return;
    }

    if (type === 'message') {
      const agentId = msg.agent_id as string;
      logger.info({ type, agentId, hasContent: !!msg.content, clientId: clientId.substring(0, 8) }, 'Browser WS message received');
      if (!agentId) return;

      // Reject unknown agent up-front so we don't spend a Connect round-trip
      // only to return a generic "could not resolve conversation" error.
      if (!this.agents.find((a) => a.id === agentId)) {
        this.sendToClient(clientId, {
          type: 'error',
          agent_id: agentId,
          data: { message: `Unknown agent: ${agentId}` },
        });
        return;
      }

      // Reject empty / whitespace-only content early so we don't burn tokens
      // on a request that has no useful prompt.
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      if (!rawContent.trim()) {
        this.sendToClient(clientId, {
          type: 'error',
          agent_id: agentId,
          data: { message: 'Empty message content' },
        });
        return;
      }

      // Subscribe this client to the agent
      this.subscribe(clientId, agentId);

      // ── Connect routing (unified messaging) ──
      // When the daemon is linked to the platform, Connect is the ONLY path.
      // No local WS fallback — any failure surfaces as an explicit error to
      // the client so the user sees it instead of a silent drop.
      //
      // The local branch below is only taken in pure standalone mode
      // (useConnectRouting=false, no platform linkage).
      if (this.useConnectRouting) {
        logger.info({
          agentId,
          platformWsOpen: this.platformWs?.readyState === WebSocket.OPEN,
          connected: this.connected,
        }, '[routing] Connect-mandatory path');

        if (!this.platformWs || !this.connected || this.platformWs.readyState !== WebSocket.OPEN) {
          logger.warn({ agentId }, '[routing] Platform WS not connected — cannot deliver');
          this.sendToClient(clientId, {
            type: 'error',
            agent_id: agentId,
            data: { message: 'Connect is not reachable — your message was not sent. Retrying soon.' },
          });
          return;
        }

        let convId = this.connectConversations.get(agentId);
        if (!convId) {
          logger.info({ agentId }, '[routing] No cached convId, fetching from Connect');
          convId = (await this.getOrCreateConnectConversation(agentId)) ?? undefined;
          if (convId) this.connectConversations.set(agentId, convId);
        }
        if (!convId) {
          logger.warn({ agentId }, '[routing] Could not resolve Connect conversation');
          this.sendToClient(clientId, {
            type: 'error',
            agent_id: agentId,
            data: { message: 'Could not find or create a Connect conversation with this agent.' },
          });
          return;
        }
        // Pass the client's request_id through as Connect's client_message_id
        // when it looks like a UUID, so the same ID flows through client → daemon
        // → Connect DB → replayFromConnect → client dedup. This is the WhatsApp
        // pattern: one stable ID end-to-end so the sender's optimistic echo
        // matches the replayed copy and isn't shown twice on agent switch/reconnect.
        // Connect's client_message_id is a UUIDField with a unique-per-conversation
        // constraint, so non-UUID request_ids must fall back to a fresh UUID.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const clientMsgId = (typeof msg.request_id === 'string' && UUID_RE.test(msg.request_id))
          ? msg.request_id
          : crypto.randomUUID();
        try {
          this.platformWs.send(JSON.stringify({
            type: 'send_message',
            conversation_id: convId,
            content: msg.content,
            client_message_id: clientMsgId,
          }));
          this.sendToClient(clientId, { type: 'relay_ack', agent_id: agentId });
          logger.info({ agentId, convId: convId.substring(0, 8) }, '[routing] Sent via Connect');

          // Cross-tab echo: broadcast the user_message to other dashboard
          // clients subscribed to this agent. Without this, a user with the
          // dashboard open in two tabs sees the message only in the tab that
          // sent it — the other tab waits for Connect's broadcast, but
          // handleConnectEvent skips new_message for sender's own user_id.
          const subs = this.agentSubscribers.get(agentId);
          if (subs && subs.size > 1) {
            const broadcastMsg = {
              type: 'user_message',
              agent_id: agentId,
              data: {
                content: msg.content,
                agent_id: agentId,
                message_id: clientMsgId,
                ...(msg.request_id ? { request_id: msg.request_id } : {}),
              },
            };
            for (const cid of subs) {
              if (cid !== clientId) this.sendToClient(cid, broadcastMsg);
            }
          }
        } catch (err) {
          logger.error({ agentId, err: (err as Error).message }, '[routing] Connect WS send failed');
          this.sendToClient(clientId, {
            type: 'error',
            agent_id: agentId,
            data: { message: `Failed to send via Connect: ${(err as Error).message}` },
          });
        }
        return;
      }

      logger.info({ agentId }, '[routing] Standalone mode, using local gateway WS');

      // Auto-activate agent if not running
      if (!isAgentRunning(agentId)) {
        this.sendToClient(clientId, {
          type: 'status_update',
          data: { message: 'Starting agent runtime...', agent_id: agentId },
        });
        const result = await enableAndStartAgent(agentId);
        if (!result.ok) {
          const error = result.error ?? '';

          // Auth errors → trigger inline auth flow instead of failing
          if (error.includes('Codex not authenticated') || error.includes('not authenticated')) {
            await this.triggerInlineAuth(clientId, agentId, msg.content);
            return;
          }
          if (error.includes('no Claude OAuth token')) {
            const agentInfo = this.agents.find((a) => a.id === agentId);
            const isClaudeBridge = agentInfo?.executionMethod === 'claude_code_server'
              || agentInfo?.modelFallbacks?.[0]?.method === 'claude_code_server';
            if (isClaudeBridge) {
              this.sendToClient(clientId, {
                type: 'auth_token_input',
                agent_id: agentId,
                data: {
                  provider: 'anthropic',
                  message: 'Run "claude setup-token" on your machine, then paste the token below.',
                  placeholder: 'sk-ant-oat01-...',
                },
              });
              this.pendingDeviceAuth.set(clientId, { sessionId: '', agentId, content: msg.content });
              return;
            }
          }

          this.sendToClient(clientId, {
            type: 'error',
            data: { message: `Failed to start agent: ${error}` },
          });
          return;
        }
        // Poll for gateway readiness (containers can take 8-15s for DinD)
        let started = false;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (isAgentRunning(agentId)) {
            // Also verify gateway is accepting connections
            const wsUrl = getContainerUrl(agentId);
            if (wsUrl) {
              try {
                const healthUrl = wsUrl.replace('ws://', 'http://').replace('/ws/chat/', '/health');
                const healthResp = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
                if (healthResp.ok) { started = true; break; }
              } catch { /* gateway not ready yet */ }
            } else {
              started = true; break; // No URL means bare-metal process, trust isAgentRunning
            }
          }
          // Check for fatal errors (auth, crash)
          const state = readDaemonState();
          const agentState = state?.agents.find((a) => a.agentId === agentId);
          if (agentState?.status === 'error') break;
        }

        if (!started && this.isLocalAgent(agentId)) {
          const state = readDaemonState();
          const agentState = state?.agents.find((a) => a.agentId === agentId);
          const error = agentState?.error ?? '';

          // Detect auth failure — trigger inline Codex device auth
          if (error.includes('Codex not authenticated') || error.includes('not authenticated')) {
            await this.triggerInlineAuth(clientId, agentId, msg.content);
            return;
          }

          // Detect Claude auth failure — guide user to set up OAuth token
          if (error.includes('no Claude OAuth token') || error.includes('Claude Code process exited') || error.includes('Exited with code 1')) {
            // Check if this is a Claude bridge agent
            const agentInfo = this.agents.find((a) => a.id === agentId);
            const isClaudeBridge = agentInfo?.executionMethod === 'claude_code_server'
              || agentInfo?.modelFallbacks?.[0]?.method === 'claude_code_server';
            if (isClaudeBridge) {
              this.sendToClient(clientId, {
                type: 'auth_token_input',
                agent_id: agentId,
                data: {
                  provider: 'claude',
                  message: 'Claude requires an OAuth token to authenticate.',
                  instructions: 'Run "claude setup-token" on your machine, then paste the token below.',
                  envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
                  tokenLabel: 'OAuth Token',
                  placeholder: 'sk-ant-oat01-...',
                },
              });
              return;
            }
          }

          this.sendToClient(clientId, {
            type: 'error',
            data: { message: `Agent failed to start: ${error || 'unknown error'}` },
          });
          return;
        }
      }

      // Route to local agent gateway
      if (this.isLocalAgent(agentId)) {
        logger.info({ agentId, hasExistingWs: this.localAgentWs.has(agentId), wsState: this.localAgentWs.get(agentId)?.readyState }, 'Routing message to local agent');
        let localWs = this.localAgentWs.get(agentId);
        if (!localWs || localWs.readyState !== WebSocket.OPEN) {
          logger.info({ agentId, wsState: localWs?.readyState }, 'Local agent WS not open, connecting...');
          localWs = await this.waitForLocalAgentSocket(agentId, this.connectLocalAgent(agentId));
          if (!localWs) {
            // Agent process exists but WS not ready — check for auth error
            const state = readDaemonState();
            const agentState = state?.agents.find((a) => a.agentId === agentId);
            if (agentState?.error?.includes('not authenticated')) {
              await this.triggerInlineAuth(clientId, agentId, msg.content);
              return;
            }
            this.sendToClient(clientId, {
              type: 'error',
              data: { message: this.diagnoseAgentError(agentId) },
            });
            return;
          }
        }

        if (localWs.readyState === WebSocket.OPEN) {
          // Track last user message per agent for auth retry
          this.lastUserMessage.set(agentId, msg.content);

          const client = this.clients.get(clientId);
          this.logGatewayIngress(agentId, 'dashboard_ws', {
            clientId,
            username: client?.username,
            remoteIp: client?.remoteIp,
            authMethod: client?.authMethod,
            requestId: typeof msg.request_id === 'string' ? msg.request_id : undefined,
            source: 'dashboard',
            content: msg.content,
          });

          // Persist user message to event log so cursor-based replay includes it.
          // Include request_id so the client can deduplicate against its local echo.
          // Generate a stable message_id for cross-device dedup.
          const userMsgId = crypto.randomUUID();
          const userMsgEvent = {
            type: 'user_message',
            agent_id: agentId,
            content: msg.content,
            message_id: userMsgId,
            ...(msg.request_id ? { request_id: msg.request_id } : {}),
          };
          const seq = this.eventLog.append(agentId, userMsgEvent);

          // **Actually deliver the message to the agent.** This path is the
          // local fallback — reached when useConnectRouting is off OR the
          // platform WS isn't connected. Without this send, the user message
          // is only logged/broadcast/mirrored and never reaches the agent.
          // (Regression from the Connect migration commit — the send call
          // was dropped when Connect was added as the preferred path, but
          // the local fallback still needs to forward to the gateway WS.)
          try {
            localWs.send(JSON.stringify({
              type: 'message',
              content: msg.content,
              agent_id: agentId,
              message_id: userMsgId,
              ...(msg.request_id ? { request_id: msg.request_id } : {}),
            }));
          } catch (err) {
            logger.warn({ agentId, err: (err as Error).message }, 'Failed to send user message to local agent gateway');
            this.sendToClient(clientId, {
              type: 'error',
              data: { message: `Failed to deliver message: ${(err as Error).message}` },
            });
            return;
          }

          // Broadcast user_message to other subscribers (not the sender) for
          // cross-device sync — like Discord/Telegram showing your own messages
          // on other devices. Include message_id so the client stores the same ID
          // as the event log — preventing duplicates on later sync.
          const subs = this.agentSubscribers.get(agentId);
          if (subs && subs.size > 0) {
            const broadcastMsg = {
              type: 'user_message',
              agent_id: agentId,
              data: {
                content: msg.content,
                agent_id: agentId,
                message_id: userMsgId,
                ...(msg.request_id ? { request_id: msg.request_id } : {}),
              },
              _seq: seq,
            };
            for (const cid of subs) {
              if (cid !== clientId) {
                this.sendToClient(cid, broadcastMsg);
              }
            }
          }

          // Mirror user message to platform for cross-device fanout (best-effort)
          this.forwardToPlatform({
            type: 'mirror',
            agent_id: agentId,
            role: 'user',
            content: msg.content,
            request_id: crypto.randomUUID(),
            source_service: 'dashboard',
          });
        } else {
          this.sendToClient(clientId, {
            type: 'error',
            data: { message: this.diagnoseAgentError(agentId) },
          });
        }
        return;
      }
      return;
    }

    // NOTE: Do NOT forward streaming events to platform here.
    // The shizuha-ws channel's broadcastEvent() already handles platform relay
    // for fan-out events. Forwarding here too causes duplicate delivery to
    // platform-connected clients (Kotlin app, other browsers).
  }

  /** Route an upstream event (platform or local agent) to subscribed browser clients. */
  private routeFromUpstream(msg: Record<string, unknown>): void {
    // Deduplicate: track execution_ids from local agents. When the platform echoes
    // these events back, skip them to prevent double-logging and double-rendering.
    const execId = (msg.execution_id as string)
      ?? (msg.data as Record<string, unknown> | undefined)?.execution_id as string | undefined;
    if (execId) {
      if (!this._localExecutionIds) this._localExecutionIds = new Set();
      if (msg._fromLocal) {
        // Tagged by the local agent WS handler — remember this execution
        this._localExecutionIds.add(execId);
        delete msg._fromLocal; // don't leak internal tag
      } else if (this._localExecutionIds.has(execId)) {
        // This execution originated locally — skip the platform echo
        return;
      }
      // Prune old execution IDs
      if (this._localExecutionIds.size > 500) {
        const arr = [...this._localExecutionIds];
        this._localExecutionIds = new Set(arr.slice(-250));
      }
    }

    let agentId = (msg.agent_id as string)
      ?? ((msg.data as Record<string, unknown> | undefined)?.entity_id as string | undefined);

    const normalizedStatus = this.normalizeStatusEvent(msg, agentId);
    if (!normalizedStatus) return;
    msg = normalizedStatus;
    agentId = (msg.agent_id as string)
      ?? ((msg.data as Record<string, unknown> | undefined)?.entity_id as string | undefined);

    // ── Intercept auth errors from running agents (e.g. codex-bridge with no auth) ──
    // The error arrives as a runtime event, not a startup error in daemon state.
    // Detect "not authenticated" errors and trigger inline device auth instead of
    // just forwarding the raw error to the browser.
    if (agentId && msg.type === 'error') {
      const errMsg = ((msg.data as Record<string, unknown> | undefined)?.message as string) ?? '';
      if (errMsg.includes('not authenticated') || errMsg.includes('Codex not authenticated')) {
        // Find the client that's subscribed to this agent
        const subs = this.agentSubscribers.get(agentId);
        if (subs && subs.size > 0) {
          const clientId = subs.values().next().value!;
          // Retrieve the pending message content from the last user message
          const pendingContent = this.lastUserMessage?.get(agentId) ?? '';
          this.triggerInlineAuth(clientId, agentId, pendingContent);
          return;
        }
      }
    }

    // Persist durable events to the append-only log (Kafka-style).
    // Clients can replay missed events using their cursor.
    if (agentId && isDurableEvent(msg)) {
      const seq = this.eventLog.append(agentId, msg);
      msg._seq = seq;
    }

    if (agentId) {
      const subs = this.agentSubscribers.get(agentId);
      if (subs && subs.size > 0) {
        for (const cid of subs) {
          this.sendToClient(cid, msg);
        }
      }
      // Events are persisted to event log — no need to broadcast to unrelated clients.
      // Clients will pick up missed events via cursor-based replay on next sync.
      return;
    }

    // No agent_id — broadcast to all (e.g., transport_status)
    this.broadcastAll(msg);
  }

  /**
   * Coalesce consecutive content deltas into single content events.
   * Streaming produces hundreds of tiny deltas per turn — on replay, the
   * client only needs one content event per contiguous block.  Tool events,
   * user_messages, and boundary events (complete/error) are kept as-is.
   */
  /** Extract the effective event type, handling gateway envelopes. */
  private effectiveEventType(event: Record<string, unknown>): string {
    const type = event.type as string;
    if (type === 'stream_event' && event.event) {
      return (event.event as Record<string, unknown>).type as string;
    }
    if (type === 'execution_complete') return 'complete';
    if (type === 'execution_error') return 'error';
    return type;
  }

  /** Extract content delta from both bare and wrapped events. */
  private extractContentDelta(event: Record<string, unknown>): string {
    if (event.type === 'stream_event' && event.event) {
      const inner = event.event as Record<string, unknown>;
      const data = inner.data as Record<string, unknown> | undefined;
      return (data?.delta ?? data?.content ?? '') as string;
    }
    const data = event.data as Record<string, unknown> | undefined;
    return (data?.delta ?? data?.content ?? '') as string;
  }

  private coalesceReplayEvents(events: ReplayedEvent[]): ReplayedEvent[] {
    const result: ReplayedEvent[] = [];
    let accContent = '';
    let lastContentEvt: ReplayedEvent | null = null;
    // Track recent assistant content to filter proactive echoes (duplicates)
    const recentContent = new Set<string>();

    for (const evt of events) {
      const type = this.effectiveEventType(evt.event);
      if (type === 'content') {
        accContent += this.extractContentDelta(evt.event);
        lastContentEvt = evt;
      } else {
        // Flush accumulated content as a single event
        if (accContent && lastContentEvt) {
          // Check if this is a proactive echo of content we've already seen
          const isProactiveEcho = type === 'complete'
            && (evt.event.data as Record<string, unknown>)?.result
            && ((evt.event.data as Record<string, unknown>).result as Record<string, unknown>)?.proactive === true
            && recentContent.has(accContent.trim());
          if (!isProactiveEcho) {
            result.push(this.buildCoalescedContent(lastContentEvt, accContent));
            recentContent.add(accContent.trim());
          }
          accContent = '';
          lastContentEvt = null;
        }
        // Skip proactive complete events that were filtered above
        const isProactiveComplete = type === 'complete'
          && (evt.event.data as Record<string, unknown>)?.result
          && ((evt.event.data as Record<string, unknown>).result as Record<string, unknown>)?.proactive === true;
        if (!isProactiveComplete || result.length === 0 || this.effectiveEventType(result[result.length - 1]!.event) !== 'complete') {
          result.push(evt);
        }
      }
    }
    // Flush remaining (agent still running, no terminal event yet)
    if (accContent && lastContentEvt) {
      result.push(this.buildCoalescedContent(lastContentEvt, accContent));
    }
    return result;
  }

  /** Build a coalesced content event preserving the original format (bare or wrapped). */
  private buildCoalescedContent(templateEvt: ReplayedEvent, content: string): ReplayedEvent {
    const evt = templateEvt.event;
    if (evt.type === 'stream_event' && evt.event) {
      // Wrapped format: { type: 'stream_event', event: { type: 'content', data: {...} } }
      const inner = evt.event as Record<string, unknown>;
      return {
        seq: templateEvt.seq,
        ts: templateEvt.ts,
        event: {
          ...evt,
          event: {
            ...inner,
            data: { ...((inner.data as Record<string, unknown>) ?? {}), delta: content },
          },
        },
      };
    }
    // Bare format: { type: 'content', data: {...} }
    return {
      seq: templateEvt.seq,
      ts: templateEvt.ts,
      event: {
        ...evt,
        data: { ...((evt.data as Record<string, unknown>) ?? {}), delta: content },
      },
    };
  }

  private broadcastToAgent(agentId: string, msg: Record<string, unknown>): void {
    const subs = this.agentSubscribers.get(agentId);
    if (subs) {
      for (const cid of subs) {
        this.sendToClient(cid, msg);
      }
    }
  }

  private sendToClient(clientId: string, msg: Record<string, unknown>): void {
    const ws = this.clients.get(clientId)?.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastAll(msg: Record<string, unknown>): void {
    for (const cid of this.clients.keys()) {
      this.sendToClient(cid, msg);
    }
  }

  /**
   * Broadcast a single agent's updated state to all connected WS clients.
   * Called after any agent mutation (toggle, restart, config change, etc.).
   */
  /** Log an event to the event log + broadcast to subscribers (for cross-device messages). */
  logEvent(agentId: string, event: Record<string, unknown>): void {
    if (!event.agent_id) event.agent_id = agentId;
    const seq = this.eventLog.append(agentId, event);
    event._seq = seq;
    // Also broadcast to subscribed browser clients
    const subs = this.agentSubscribers.get(agentId);
    if (subs) {
      for (const cid of subs) this.sendToClient(cid, event);
    }
  }

  broadcastAgentUpdate(agentId: string): void {
    const agent = this.agents.find((a) => a.id === agentId);
    if (!agent) return;
    this.broadcastAll({
      type: 'agent_updated',
      agent: serializeAgent(agent),
    });
  }

  /** Broadcast the full agent list (used after create/delete). */
  broadcastAgentsSnapshot(): void {
    this.broadcastAll({
      type: 'agents_snapshot',
      agents: this.agents.map(serializeAgent),
    });
  }

  // ── Platform Sync (local-first) ──

  /**
   * Push all local agent configs to platform on connect.
   * Platform stores as mirror — never overwrites local.
   */
  pushAgentSync(): void {
    if (!this.platformWs || !this.connected) return;
    const syncPayload = {
      type: 'sync:push',
      runtime_id: `runtime-${process.pid}`,
      agents: this.agents.map((a) => ({
        id: a.id,
        username: a.username,
        fields: {
          name: { value: a.name, updated_at: new Date().toISOString() },
          email: { value: a.email, updated_at: new Date().toISOString() },
          role: { value: a.role, updated_at: new Date().toISOString() },
          executionMethod: { value: a.executionMethod, updated_at: new Date().toISOString() },
          runtimeEnvironment: { value: a.runtimeEnvironment, updated_at: new Date().toISOString() },
          contextPrompt: { value: a.contextPrompt, updated_at: new Date().toISOString() },
          modelFallbacks: { value: a.modelFallbacks, updated_at: new Date().toISOString() },
          modelOverrides: { value: a.modelOverrides, updated_at: new Date().toISOString() },
          skills: { value: a.skills, updated_at: new Date().toISOString() },
          personalityTraits: { value: a.personalityTraits, updated_at: new Date().toISOString() },
        },
      })),
    };
    try {
      this.platformWs.send(JSON.stringify(syncPayload));
      logger.info({ agentCount: this.agents.length }, 'Pushed agent sync to platform');
    } catch (err) {
      logger.error({ err }, 'Failed to push agent sync');
    }
  }

  /**
   * Push a single field change to platform (called on every local edit).
   */
  pushFieldUpdate(agentId: string, field: string, value: unknown): void {
    if (!this.platformWs || !this.connected) return;
    try {
      this.platformWs.send(JSON.stringify({
        type: 'sync:field_update',
        agent_id: agentId,
        field,
        value,
        updated_at: new Date().toISOString(),
        updated_by: `runtime-${process.pid}`,
      }));
    } catch { /* best-effort push */ }
  }

  /**
   * Push agent creation to platform.
   */
  pushAgentCreated(agent: AgentInfo): void {
    if (!this.platformWs || !this.connected) return;
    try {
      this.platformWs.send(JSON.stringify({
        type: 'sync:agent_created',
        agent: {
          id: agent.id,
          username: agent.username,
          name: agent.name,
          email: agent.email,
          role: agent.role,
          executionMethod: agent.executionMethod,
          runtimeEnvironment: agent.runtimeEnvironment,
          contextPrompt: agent.contextPrompt,
          modelFallbacks: agent.modelFallbacks,
          skills: agent.skills,
          personalityTraits: agent.personalityTraits,
        },
        runtime_id: `runtime-${process.pid}`,
      }));
    } catch { /* best-effort push */ }
  }

  /**
   * Push agent deletion to platform.
   */
  pushAgentDeleted(agentId: string, username: string): void {
    if (!this.platformWs || !this.connected) return;
    try {
      this.platformWs.send(JSON.stringify({
        type: 'sync:agent_deleted',
        agent_id: agentId,
        username,
      }));
    } catch { /* best-effort push */ }
  }

  // ── Pending Updates from Platform ──

  private pendingUpdates: Array<{
    agent_id: string;
    field: string;
    old_value: unknown;
    new_value: unknown;
    updated_at: string;
    updated_by: string;
  }> = [];

  /**
   * Handle sync messages from the platform.
   */
  /**
   * Handle events from Connect's UserChatConsumer (unified multiplexed WS).
   * These are the exact same events the Kotlin app receives.
   */
  private handleConnectEvent(msg: Record<string, unknown>): void {
    const msgType = msg.type as string;
    const convId = (msg.conversation_id as string) ?? '';

    // Resolve which agent this conversation belongs to
    let agentId: string | null = null;
    for (const [aid, cid] of this.connectConversations) {
      if (cid === convId) { agentId = aid; break; }
    }

    // No mapping found — drop the event. Don't guess.
    // Events for unmapped conversations are from other agents'
    // conversations and must not be routed to the wrong chat.
    if (!agentId) return;

    switch (msgType) {
      case 'agent_stream': {
        const eventType = msg.event_type as string;
        const eventData = (msg.data ?? {}) as Record<string, unknown>;

        let dashboardMsg: Record<string, unknown>;
        switch (eventType) {
          case 'session_start':
            dashboardMsg = { type: 'session_start', agent_id: agentId, execution_id: convId,
              data: { session_id: convId, message_id: eventData.message_id ?? '' } };
            break;
          case 'content':
            dashboardMsg = { type: 'content', agent_id: agentId, execution_id: convId,
              data: { delta: eventData.delta ?? '' } };
            break;
          case 'reasoning':
            dashboardMsg = { type: 'reasoning', agent_id: agentId, execution_id: convId,
              data: { summaries: eventData.summaries } };
            break;
          case 'tool_start':
            dashboardMsg = { type: 'tool_start', agent_id: agentId, execution_id: convId,
              data: { tool: eventData.tool, tool_call_id: eventData.tool_call_id } };
            break;
          case 'tool_output':
            dashboardMsg = { type: 'tool_output', agent_id: agentId, execution_id: convId,
              data: {
                tool: eventData.tool,
                output: eventData.output ?? eventData.delta ?? '',
                stream: eventData.stream,
                tool_call_id: eventData.tool_call_id,
              } };
            break;
          case 'tool_complete':
            dashboardMsg = { type: 'tool_complete', agent_id: agentId, execution_id: convId,
              data: {
                tool: eventData.tool,
                duration_ms: eventData.duration_ms,
                is_error: eventData.is_error,
                exit_code: eventData.exit_code,
                output: eventData.output,
              } };
            break;
          case 'complete':
            dashboardMsg = { type: 'complete', agent_id: agentId, execution_id: convId, data: eventData };
            break;
          case 'error':
            dashboardMsg = { type: 'error', agent_id: agentId, execution_id: convId,
              data: { message: eventData.error ?? 'Unknown error' } };
            break;
          default:
            return;
        }
        const subs = this.agentSubscribers.get(agentId);
        if (subs) { for (const cid of subs) this.sendToClient(cid, dashboardMsg); }
        break;
      }

      case 'new_message':
      case 'missed_message': {
        const message = (msg.message ?? {}) as Record<string, unknown>;
        const senderId = String(message.sender_id ?? '');
        const authState = readShizuhaAuth();
        if (senderId === String(authState?.userId)) return; // Don't echo own messages

        // After Session 79 (stream-event auto-relay removal), agents deliver
        // ALL replies via explicit `message_user` tool calls, which result in
        // `new_message` events. There is no parallel `agent_stream_event`
        // path anymore — so we MUST forward agent-sent new_messages to the
        // dashboard. Previously this was skipped to avoid double-delivery
        // with the now-deleted streaming path.
        const content = (message.content as string) ?? '';
        const completeMsg = { type: 'complete', agent_id: agentId, execution_id: convId,
          data: { content, sender_name: message.sender_name } };
        const subs2 = this.agentSubscribers.get(agentId);
        if (subs2) { for (const cid of subs2) this.sendToClient(cid, completeMsg); }
        break;
      }

      case 'typing': {
        const subs3 = this.agentSubscribers.get(agentId);
        if (subs3) {
          for (const cid of subs3) {
            this.sendToClient(cid, { type: 'typing', agent_id: agentId, ...msg });
          }
        }
        break;
      }

      case 'conversation_created': {
        // Auto-cache the new conversation mapping
        if (convId) {
          // We'd need the agent_id from the conversation participants
          logger.info({ conversationId: convId }, 'New conversation created via Connect');
        }
        break;
      }

      case 'send_error': {
        // Connect rejected a send_message — most likely the cached convId
        // points at a deleted conversation. Invalidate so the next message
        // triggers a fresh getOrCreateConnectConversation round-trip.
        const failedConvId = convId;
        if (failedConvId) {
          for (const [aid, cid] of this.connectConversations) {
            if (cid === failedConvId) {
              this.connectConversations.delete(aid);
              logger.warn({ agentId: aid, convId: failedConvId, error: msg.error }, '[Connect:send_error] invalidating stale convId');
              // Notify subscribers so the user sees a fresh error instead of
              // a silently stuck conversation.
              const subs = this.agentSubscribers.get(aid);
              if (subs) {
                for (const cidClient of subs) {
                  this.sendToClient(cidClient, {
                    type: 'error',
                    agent_id: aid,
                    data: { message: `Connect could not deliver: ${msg.error ?? 'conversation not found'}. Retry the message.` },
                  });
                }
              }
              break;
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Handle chat_event messages from Connect (via platform unified WS).
   * Legacy handler for shizuha-agent bridge path. Kept for backwards compat.
   */
  private handleConnectChatEvent(msg: Record<string, unknown>): void {
    const convId = msg.conversation_id as string;
    const eventType = msg.event_type as string;
    const eventData = (msg.data ?? {}) as Record<string, unknown>;

    if (!convId || !eventType) return;

    // Resolve which agent this conversation belongs to
    let agentId: string | null = null;
    for (const [aid, cid] of this.connectConversations) {
      if (cid === convId) { agentId = aid; break; }
    }

    // If we don't have a cached mapping, try to find by agent name in participants
    if (!agentId) {
      // Look up agent by matching conversation to agent roster
      // The agent's userId is embedded in the conversation participant list
      // For now, broadcast to all subscribers — the browser can filter
      for (const agent of this.agents) {
        const subs = this.agentSubscribers.get(agent.id);
        if (subs && subs.size > 0) {
          agentId = agent.id;
          break;
        }
      }
    }

    if (!agentId) return;

    // Map Connect chat events to the dashboard's streaming protocol
    switch (eventType) {
      case 'agent_stream': {
        // Agent streaming event — extract inner event_type and data
        const innerEventType = (eventData.event_type as string) ?? '';
        const innerData = (eventData.data ?? {}) as Record<string, unknown>;

        let dashboardMsg: Record<string, unknown>;
        switch (innerEventType) {
          case 'session_start':
            dashboardMsg = {
              type: 'session_start',
              agent_id: agentId,
              execution_id: convId,
              data: { session_id: convId, message_id: innerData.message_id ?? '' },
            };
            break;
          case 'content':
            dashboardMsg = {
              type: 'content',
              agent_id: agentId,
              execution_id: convId,
              data: { delta: innerData.delta ?? '' },
            };
            break;
          case 'reasoning':
            dashboardMsg = {
              type: 'reasoning',
              agent_id: agentId,
              execution_id: convId,
              data: { summaries: innerData.summaries },
            };
            break;
          case 'tool_start':
            dashboardMsg = {
              type: 'tool_start',
              agent_id: agentId,
              execution_id: convId,
              data: { tool: innerData.tool, tool_call_id: innerData.tool_call_id },
            };
            break;
          case 'tool_output':
            dashboardMsg = {
              type: 'tool_output',
              agent_id: agentId,
              execution_id: convId,
              data: {
                tool: innerData.tool,
                output: innerData.output ?? innerData.delta ?? '',
                stream: innerData.stream,
                tool_call_id: innerData.tool_call_id,
              },
            };
            break;
          case 'tool_complete':
            dashboardMsg = {
              type: 'tool_complete',
              agent_id: agentId,
              execution_id: convId,
              data: {
                tool: innerData.tool,
                duration_ms: innerData.duration_ms,
                is_error: innerData.is_error,
                exit_code: innerData.exit_code,
                output: innerData.output,
              },
            };
            break;
          case 'complete':
            dashboardMsg = {
              type: 'complete',
              agent_id: agentId,
              execution_id: convId,
              data: innerData,
            };
            break;
          case 'error':
            dashboardMsg = {
              type: 'error',
              agent_id: agentId,
              execution_id: convId,
              data: { message: innerData.error ?? 'Unknown error' },
            };
            break;
          default:
            return;
        }

        // Route to browser subscribers
        const subs = this.agentSubscribers.get(agentId);
        if (subs) {
          for (const cid of subs) {
            this.sendToClient(cid, dashboardMsg);
          }
        }
        break;
      }

      case 'new_message': {
        // Final persisted message — broadcast as complete event
        const content = (eventData.content as string) ?? '';
        const senderId = String(eventData.sender_id ?? '');
        const senderName = (eventData.sender_name as string) ?? '';

        // Only forward agent messages (not our own echoed back)
        const authState = readShizuhaAuth();
        if (senderId === String(authState?.userId)) return;

        const completeMsg: Record<string, unknown> = {
          type: 'complete',
          agent_id: agentId,
          execution_id: convId,
          data: { content, sender_name: senderName },
        };
        const subs2 = this.agentSubscribers.get(agentId);
        if (subs2) {
          for (const cid of subs2) {
            this.sendToClient(cid, completeMsg);
          }
        }
        break;
      }

      // Typing, read receipts — forward as-is
      case 'typing_indicator': {
        const subs3 = this.agentSubscribers.get(agentId);
        if (subs3) {
          for (const cid of subs3) {
            this.sendToClient(cid, { type: 'typing', agent_id: agentId, ...eventData });
          }
        }
        break;
      }
    }
  }

  private handleSyncMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'sync:result': {
        // Response to our sync:push
        const result = msg as Record<string, unknown>;
        const registered = (result.registered ?? []) as string[];
        const conflicts = (result.conflicts ?? []) as Array<Record<string, string>>;
        const newAgents = (result.new_agents ?? []) as Array<Record<string, unknown>>;

        if (registered.length > 0) {
          logger.info({ count: registered.length }, 'Agents registered on platform');
        }
        if (conflicts.length > 0) {
          logger.error({ conflicts }, 'Agent sync conflicts detected!');
          // Broadcast to dashboard so UI can show the notification
          this.broadcastAll({ type: 'sync_conflicts', conflicts });
        }
        if (newAgents.length > 0) {
          logger.info({ count: newAgents.length }, 'New agents imported from platform');
        }
        break;
      }

      case 'sync:pending_update': {
        // Platform wants to update an agent field — queue for user review
        const update = msg as Record<string, unknown>;
        const pending = {
          agent_id: update.agent_id as string,
          field: update.field as string,
          old_value: update.old_value,
          new_value: update.new_value,
          updated_at: update.updated_at as string,
          updated_by: update.updated_by as string,
        };
        this.pendingUpdates.push(pending);
        logger.info({ agent: pending.agent_id, field: pending.field, by: pending.updated_by }, 'Pending platform update');

        // Broadcast notification to dashboard browsers
        this.broadcastAll({
          type: 'sync_pending_update',
          update: pending,
          total_pending: this.pendingUpdates.length,
        });
        break;
      }

      case 'sync:agent_claimed': {
        // Another runtime claimed one of our agents
        const claimed = msg as Record<string, unknown>;
        const username = claimed.username as string;
        const claimedBy = claimed.claimed_by as string;
        logger.warn({ username, claimedBy }, 'Agent claimed by another runtime');

        this.broadcastAll({
          type: 'sync_agent_claimed',
          username,
          claimed_by: claimedBy,
        });
        break;
      }

      default:
        logger.debug({ type: msg.type }, 'Unknown sync message type');
    }
  }

  /**
   * Get pending updates for the dashboard UI.
   */
  getPendingUpdates(): typeof this.pendingUpdates {
    return this.pendingUpdates;
  }

  /**
   * Accept a pending update — apply to local config and push ack.
   */
  acceptPendingUpdate(agentId: string, field: string): boolean {
    const idx = this.pendingUpdates.findIndex(u => u.agent_id === agentId && u.field === field);
    if (idx < 0) return false;

    const update = this.pendingUpdates[idx]!;
    // Apply to local agent
    const agent = this.agents.find(a => a.id === agentId);
    if (agent) {
      (agent as any)[field] = update.new_value;
      updateAgentConfig(agentId, { [field]: update.new_value } as any);
    }

    // Ack to platform
    if (this.platformWs && this.connected) {
      try {
        this.platformWs.send(JSON.stringify({
          type: 'sync:accept',
          agent_id: agentId,
          field,
        }));
      } catch { /* best-effort */ }
    }

    this.pendingUpdates.splice(idx, 1);
    this.broadcastAgentUpdate(agentId);
    return true;
  }

  /**
   * Reject a pending update — push local value to platform.
   */
  rejectPendingUpdate(agentId: string, field: string): boolean {
    const idx = this.pendingUpdates.findIndex(u => u.agent_id === agentId && u.field === field);
    if (idx < 0) return false;

    const agent = this.agents.find(a => a.id === agentId);
    const localValue = agent ? (agent as any)[field] : undefined;

    // Push local version to platform (local wins)
    if (this.platformWs && this.connected) {
      try {
        this.platformWs.send(JSON.stringify({
          type: 'sync:reject',
          agent_id: agentId,
          field,
          local_value: localValue,
          updated_at: new Date().toISOString(),
        }));
      } catch { /* best-effort */ }
    }

    this.pendingUpdates.splice(idx, 1);
    return true;
  }

  /** Handle an RPC request and return the result. */
  private async handleRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'agents.list':
        return { agents: this.agents.map(serializeAgent) };

      case 'templates.list': {
        try {
          const { loadTemplates } = await import('../templates/loader.js');
          const templates = loadTemplates();
          return {
            templates: templates.map((t) => ({
              name: t.name,
              description: t.description,
              tags: t.tags,
              category: t.category,
              role: t.role,
              model: t.model,
              executionMethod: t.executionMethod,
              skills: t.skills,
              requires: t.requires,
              author: t.author,
              version: t.version,
            })),
          };
        } catch {
          return { templates: [] };
        }
      }

      case 'agents.toggle': {
        const agentId = params.agent_id as string;
        const enabled = params.enabled as boolean;
        if (!agentId || typeof enabled !== 'boolean') {
          throw new Error('agent_id and enabled (boolean) are required');
        }
        if (enabled) {
          const result = await enableAndStartAgent(agentId);
          if (!result.ok) throw new Error(result.error);
          // Status update happens asynchronously — broadcast after a short delay
          setTimeout(() => this.broadcastAgentUpdate(agentId), 1000);
          return { status: 'enabled', agent_id: agentId };
        } else {
          const result = disableAndStopAgent(agentId);
          if (!result.ok) throw new Error(result.error);
          this.broadcastAgentUpdate(agentId);
          // Also broadcast full snapshot so sidebar updates immediately
          this.broadcastAgentsSnapshot();
          return { status: 'disabled', agent_id: agentId };
        }
      }

      case 'agents.restart': {
        const agentId = params.agent_id as string;
        if (!agentId) throw new Error('agent_id is required');
        if (!isAgentRunning(agentId)) {
          const result = await enableAndStartAgent(agentId);
          if (!result.ok) throw new Error(result.error);
        } else {
          await restartAgent(agentId);
        }
        // Agent will come back up asynchronously — broadcast intermediate state now,
        // then updated state after the process restarts.
        this.broadcastAgentUpdate(agentId);
        setTimeout(() => this.broadcastAgentUpdate(agentId), 5000);
        return { status: 'restarted', agent_id: agentId };
      }

      case 'agents.update': {
        const agentId = params.agent_id as string;
        if (!agentId) throw new Error('agent_id is required');
        const agent = this.agents.find((a) => a.id === agentId);
        if (!agent) throw new Error('Agent not found');

        const keyMap: Record<string, string> = {
          executionMethod: 'execution_method',
          runtimeEnvironment: 'runtime_environment',
          resourceLimits: 'resource_limits',
          modelOverrides: 'model_overrides',
          modelFallbacks: 'model_fallbacks',
          personalityTraits: 'personality_traits',
          mcpServers: 'enabled_mcp_server_ids',
          contextPrompt: 'context_prompt',
          agentMemory: 'agent_memory',
          workSchedule: 'work_schedule',
          tokenBudget: 'token_budget',
          maxConcurrentTasks: 'max_concurrent_tasks',
          allowParallelExecution: 'allow_parallel_execution',
          warmPoolSize: 'warm_pool_size',
          failoverChainId: 'failover_chain_id',
        };
        const mapped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(params)) {
          if (k === 'agent_id') continue;
          mapped[keyMap[k] ?? k] = v;
        }

        // PLAT-394: validate Codex model chain on WS agents.update (same gate as REST PATCH).
        // The WS path arrives with camelCase keys; mapped already has snake_case keys here.
        // kei #2: validate ONLY when this update actually changes a model/override field.
        // Validating unconditionally (falling back to the PERSISTED config) rejected unrelated
        // edits — e.g. a contextPrompt/skills change on an agent created before this guard with
        // a now-invalid persisted model — which blocks the very remediation needed to fix it.
        const wsMappedFallbacks = mapped['model_fallbacks'] as Array<{ method: string; model: string }> | undefined;
        const wsMappedOverrides = mapped['model_overrides'] as Record<string, string> | undefined;
        if (wsMappedFallbacks !== undefined || wsMappedOverrides !== undefined) {
          const wsFallbacks = wsMappedFallbacks ?? agent.modelFallbacks ?? [];
          const wsOverrides = wsMappedOverrides ?? agent.modelOverrides ?? {};
          const wsModelErr = validateCodexModelChain(wsFallbacks, wsOverrides);
          if (wsModelErr) throw new Error(wsModelErr);
        }
        // PLAT-394 P2: validate named chain when failoverChainId is set via WS.
        // Read from `mapped` (post-keyMap) so camelCase failoverChainId is resolved.
        const wsChainId = mapped['failover_chain_id'] as string | undefined | null;
        if (wsChainId) {
          const wsNamedChain = getFailoverChain(wsChainId);
          if (!wsNamedChain) throw new Error(`Named chain "${wsChainId}" not found`);
          const wsChainErr = validateCodexModelChain(wsNamedChain.steps);
          if (wsChainErr) throw new Error(`Named chain "${wsChainId}": ${wsChainErr}`);
        }

        const oldModelKey = JSON.stringify(agent.modelFallbacks) + JSON.stringify(agent.modelOverrides);
        const result = updateLocalAgentAtRuntime(agentId, mapped);
        if (!result.ok) throw new Error(result.error);

        const newModelKey = JSON.stringify(agent.modelFallbacks) + JSON.stringify(agent.modelOverrides);
        if (oldModelKey !== newModelKey && isAgentRunning(agentId)) {
          await restartAgent(agentId);
          setTimeout(() => this.broadcastAgentUpdate(agentId), 5000);
        }

        this.broadcastAgentUpdate(agentId);
        return { ok: true, agent: serializeAgent(agent) };
      }

      case 'agents.create': {
        const { name, username } = params as { name?: string; username?: string };
        if (!name || !username) throw new Error('name and username are required');
        if (!/^[a-z][a-z0-9_-]{1,30}$/.test(username)) {
          throw new Error('Username must be lowercase, start with a letter, 2-31 chars');
        }
        const existing = this.agents.find(
          (a) => a.username === username || a.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing) throw new Error(`Agent "${username}" or "${name}" already exists`);

        // Load template defaults if template_name is provided
        let templateDefaults: Record<string, unknown> = {};
        const templateName = params.template_name as string | undefined;
        if (templateName) {
          try {
            const { loadTemplates, loadTemplateContent } = await import('../templates/loader.js');
            const templates = loadTemplates();
            const tpl = templates.find((t) => t.name === templateName);
            if (tpl) {
              templateDefaults = {
                role: tpl.role,
                executionMethod: tpl.executionMethod,
                runtimeEnvironment: tpl.runtimeEnvironment,
                skills: tpl.skills?.length ? tpl.skills : undefined,
                personalityTraits: tpl.personalityTraits,
                modelOverrides: tpl.modelOverrides,
                modelFallbacks: tpl.modelFallbacks,
                extraDockerArgs: tpl.extraDockerArgs,
                extraVolumes: tpl.extraVolumes,
                contextPrompt: tpl.contextPrompt || loadTemplateContent(tpl),
              };
              // Remove undefined values
              Object.keys(templateDefaults).forEach((k) => {
                if (templateDefaults[k] === undefined) delete templateDefaults[k];
              });
            }
          } catch (err) {
            console.warn(`[daemon] Failed to load template "${templateName}": ${(err as Error).message}`);
          }
        }

        // PLAT-394 (kei #3): validate the Codex model chain on WS agent CREATE too. REST create
        // is guarded but agents.create previously passed payload/template modelFallbacks straight
        // into createLocalAgentAtRuntime — a Codex template/payload with an invalid
        // codex_app_server model would persist and 400 at the backend → silent empty turns.
        const createFallbacks = (params.modelFallbacks ?? templateDefaults.modelFallbacks) as Array<{ method: string; model: string }> | undefined;
        const createOverrides = (params.modelOverrides ?? templateDefaults.modelOverrides) as Record<string, string> | undefined;
        if (createFallbacks !== undefined || createOverrides !== undefined) {
          const createModelErr = validateCodexModelChain(createFallbacks ?? [], createOverrides ?? {});
          if (createModelErr) throw new Error(createModelErr);
        }

        // Merge: explicit params override template defaults
        const agent = createLocalAgentAtRuntime({
          name,
          username,
          email: params.email as string | undefined,
          role: (params.role ?? templateDefaults.role) as string | undefined,
          executionMethod: (params.executionMethod ?? templateDefaults.executionMethod) as string | undefined,
          runtimeEnvironment: (params.runtimeEnvironment ?? templateDefaults.runtimeEnvironment) as string | undefined,
          skills: (params.skills ?? templateDefaults.skills) as string[] | undefined,
          personalityTraits: (params.personalityTraits ?? templateDefaults.personalityTraits) as Record<string, string> | undefined,
          modelFallbacks: (params.modelFallbacks ?? templateDefaults.modelFallbacks) as Array<{ method: string; model: string }> | undefined,
          modelOverrides: (params.modelOverrides ?? templateDefaults.modelOverrides) as Record<string, string> | undefined,
          contextPrompt: (params.contextPrompt ?? templateDefaults.contextPrompt) as string | undefined,
          extraDockerArgs: (params.extraDockerArgs ?? templateDefaults.extraDockerArgs) as string[] | undefined,
          extraVolumes: (params.extraVolumes ?? templateDefaults.extraVolumes) as Array<{ host: string; container: string; mode?: string }> | undefined,
        });
        if (!this.agents.some((a) => a.id === agent.id)) {
          this.agents.push(agent);
        }
        this.broadcastAgentsSnapshot();
        return { ok: true, agent: serializeAgent(agent), template: templateName || null };
      }

      case 'agents.delete': {
        const agentId = params.agent_id as string;
        if (!agentId) throw new Error('agent_id is required');
        const result = deleteLocalAgentAtRuntime(agentId);
        if (!result.ok) throw new Error(result.error);
        const idx = this.agents.findIndex((a) => a.id === agentId);
        if (idx >= 0) this.agents.splice(idx, 1);
        this.broadcastAgentsSnapshot();
        return { ok: true };
      }

      case 'auth.save_token': {
        // Save an OAuth token for a provider (e.g. Claude) and restart the agent
        const token = params.token as string;
        const provider = params.provider as string;
        const agentId = params.agent_id as string;
        if (!token || !provider) throw new Error('token and provider are required');

        // Persist the token to credentials store
        const { readCredentials, writeCredentials } = await import('../config/credentials.js');
        const store = readCredentials();

        if (provider === 'claude') {
          if (!store.anthropic) store.anthropic = { tokens: [] };
          const exists = store.anthropic.tokens.some((t: { token: string }) => t.token === token);
          if (!exists) {
            store.anthropic.tokens.push({ token, label: 'dashboard-input', addedAt: new Date().toISOString() });
          }
          // Also set env var for immediate use
          process.env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
        }

        writeCredentials(store);

        // Restart the agent if specified
        if (agentId) {
          try { await restartAgent(agentId); } catch { /* best effort */ }
        }

        return { ok: true, provider };
      }

      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  /** Build an informative error message when the agent fails to respond. */
  private diagnoseAgentError(agentId: string): string {
    // Check if the agent process logged a specific error
    const state = readDaemonState();
    const agentState = state?.agents.find((a) => a.agentId === agentId);
    if (agentState?.error) {
      return `Agent error: ${agentState.error}`;
    }

    // Check if any LLM provider is configured
    const creds = readCredentials();
    const hasAnthropic = (creds.anthropic?.tokens?.length ?? 0) > 0;
    const hasOpenAI = !!creds.openai?.apiKey;
    const hasGoogle = !!creds.google?.apiKey;
    const hasCodex = (creds.codex?.accounts?.length ?? 0) > 0;

    if (!hasAnthropic && !hasOpenAI && !hasGoogle && !hasCodex) {
      return 'No LLM provider configured. Go to Settings and add an API key or sign in with your ChatGPT account.';
    }

    return 'Could not connect to the agent. Check Settings to verify your LLM credentials are valid, or try restarting the daemon.';
  }

  /**
   * Trigger inline Codex device auth when agent fails due to missing auth.
   * Sends the device code + verification URL to the browser so the user
   * can authorize right from the chat. Polls for completion, then auto-starts
   * the agent and delivers the original message.
   */
  private async triggerInlineAuth(clientId: string, agentId: string, pendingContent: unknown): Promise<void> {
    if (process.env['MCP_AUTH_PROXY_COORDINATOR_URL']) {
      this.sendToClient(clientId, {
        type: 'auth_required',
        agent_id: agentId,
        data: {
          provider: 'codex',
          message: 'Codex credentials are managed by Hive. Re-authenticate the account from Hive Credentials, then retry.',
          verificationUrl: 'https://shizuha.com/hive/credentials',
        },
      });
      return;
    }

    // Send auth_required event with instructions
    this.sendToClient(clientId, {
      type: 'auth_required',
      agent_id: agentId,
      data: {
        provider: 'codex',
        message: 'Sign in with your ChatGPT account to use this agent. Starting authentication...',
      },
    });

    // Start device auth flow
    try {
      const authResult = await new Promise<{ userCode: string; verificationUrl: string; email?: string; error?: string }>((resolve) => {
        let userCode = '';
        let verificationUrl = '';

        codexDeviceAuth({
          onUserCode: (code, url) => {
            userCode = code;
            verificationUrl = url;
            // Send the code to the browser immediately
            this.sendToClient(clientId, {
              type: 'auth_device_code',
              agent_id: agentId,
              data: {
                provider: 'codex',
                userCode: code,
                verificationUrl: url,
                message: `Go to ${url} and enter code: ${code}`,
              },
            });
          },
          onPolling: () => {
            this.sendToClient(clientId, {
              type: 'auth_polling',
              agent_id: agentId,
              data: { message: 'Waiting for authorization...' },
            });
          },
          onSuccess: (email) => {
            resolve({ userCode, verificationUrl, email });
          },
          onError: (error) => {
            resolve({ userCode, verificationUrl, error });
          },
        }).catch((err) => {
          resolve({ userCode, verificationUrl, error: (err as Error).message });
        });
      });

      if (authResult.error) {
        this.sendToClient(clientId, {
          type: 'auth_error',
          agent_id: agentId,
          data: { message: `Authentication failed: ${authResult.error}` },
        });
        return;
      }

      // Auth succeeded — notify the browser
      this.sendToClient(clientId, {
        type: 'auth_complete',
        agent_id: agentId,
        data: {
          provider: 'codex',
          email: authResult.email,
          message: `Signed in as ${authResult.email}. Starting agent...`,
        },
      });

      // Now try starting the agent again
      this.sendToClient(clientId, {
        type: 'status_update',
        data: { message: 'Starting agent runtime...', agent_id: agentId },
      });

      const result = await enableAndStartAgent(agentId);
      if (!result.ok) {
        this.sendToClient(clientId, {
          type: 'error',
          data: { message: `Failed to start agent: ${result.error}` },
        });
        return;
      }

      // Wait for gateway
      await new Promise((r) => setTimeout(r, 3000));

      // Deliver the original message
      if (isAgentRunning(agentId) && this.isLocalAgent(agentId)) {
        const localWs = await this.waitForLocalAgentSocket(agentId, this.connectLocalAgent(agentId));
        if (localWs) {
          if (localWs.readyState === WebSocket.OPEN) {
            localWs.send(JSON.stringify({
              type: 'message',
              agent_id: agentId,
              content: pendingContent,
              source_service: 'dashboard',
            }));
            this.sendToClient(clientId, { type: 'relay_ack', agent_id: agentId });
            return;
          }
        }
      }

      this.sendToClient(clientId, {
        type: 'error',
        data: { message: 'Agent started but could not connect. Try sending your message again.' },
      });
    } catch (err) {
      this.sendToClient(clientId, {
        type: 'error',
        data: { message: `Authentication error: ${(err as Error).message}` },
      });
    }
  }
}


export async function startDashboard(config: DashboardConfig): Promise<void> {
  // When TLS is available: HTTPS on primary port (8015), HTTP fallback on port+1 (8016).
  // When no TLS: HTTP on primary port (8015), no secondary.
  // This ensures the default port always gives the best experience (HTTPS + wss://).
  const app = Fastify({
    logger: false,
    ...(config.tls ? { https: { cert: config.tls.cert, key: config.tls.key } } : {}),
  });
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB max audio

  // ── Mini-Connect (lightweight platform implementation) ──
  // Lets browser / Kotlin / agent containers point at the daemon as if it were
  // the real shizuha-id + shizuha-connect backend. Identical wire format, so
  // the same client code works whether `Backend URL` = daemon `:8015` or the
  // real platform on `:443`. See plans/vivid-watching-token.md. The state is
  // shared across multiple bind listeners so loopback browser traffic and
  // Docker-gateway agent traffic see the same users, conversations, and WS
  // channel layer.
  const {
    store: miniConnectStore,
    auth: miniConnectAuth,
    channelLayer: miniConnectChannelLayer,
  } = getSharedMiniConnectState();
  // Resolves to the upstream Connect when daemon is linked to a remote
  // platform AND we have a valid platform JWT in auth.json; null otherwise.
  // mini-Connect's WS handler uses this to decide whether to serve locally
  // or proxy to the real platform. Errors (refresh-token expired, network
  // blip, etc.) fall through to local mode rather than blowing up — the
  // user can re-link via Settings → Backend whenever they want.
  async function resolveMiniConnectUpstream(): Promise<{ wsUrl: string; accessToken: string } | null> {
    const platformUrl = resolvePlatformUrl();
    const remote = platformUrl
      && platformUrl !== 'http://localhost'
      && !platformUrl.includes('127.0.0.1');
    if (!remote) return null;
    try {
      const { getValidShizuhaAccessToken } = await import('../config/shizuhaAuth.js');
      const access = await getValidShizuhaAccessToken();
      if (!access) return null;
      const wsScheme = platformUrl.startsWith('https') ? 'wss' : 'ws';
      const host = platformUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      return { wsUrl: `${wsScheme}://${host}/connect/ws/connect/user/`, accessToken: access };
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'Upstream platform JWT unavailable — bridge falls back to local mini-Connect mode',
      );
      return null;
    }
  }

  registerMiniConnectRoutes(app, {
    store: miniConnectStore,
    auth: miniConnectAuth,
    channelLayer: miniConnectChannelLayer,
    getUpstream: resolveMiniConnectUpstream,
  });

  // ── Upstream HTTP proxy for `/connect/api/*` and `/id/api/me/` ──
  //
  // Companion to the WS proxy. When the daemon is linked to a remote
  // platform, the browser's bridge calls REST endpoints (conversation list,
  // message history, etc.) on the daemon's host to avoid cross-origin
  // headaches. This preHandler intercepts those calls and forwards them to
  // the real platform with the correct upstream JWT — keeping a single
  // host for the browser end-to-end.
  //
  // Local mode: hook is a no-op; the registered local handlers serve
  // mini-Connect's SQLite directly.
  app.addHook('preHandler', async (request, reply) => {
    const u = request.url;
    // Only proxy chat REST + identity-me. Auth login MUST stay local so the
    // dashboard can issue mini-Connect JWTs from cookie sessions, and
    // POST /messaging/dm/ from the daemon's own MCP path keeps using its
    // own logic.
    const proxyable = u.startsWith('/connect/api/conversations/')
      || u === '/connect/api/conversations'
      || u === '/id/api/me/'
      || u === '/id/api/me';
    if (!proxyable) return;

    const upstream = await resolveMiniConnectUpstream();
    if (!upstream) return; // local mode — let the local handler run

    // Resolve to platform base URL — drop the path-specific suffix from the
    // upstream WS URL to get the http base.
    const httpBase = upstream.wsUrl
      .replace(/^ws/, 'http')
      .replace(/\/connect\/ws\/connect\/[^?]*$/, '');
    const targetUrl = `${httpBase}${u}`;
    try {
      const fetchOpts: RequestInit = {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${upstream.accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      };
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
        fetchOpts.body = typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
      }
      const resp = await fetch(targetUrl, fetchOpts);
      reply.status(resp.status);
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const data = await resp.json();
        return reply.send(data);
      }
      const text = await resp.text();
      return reply.type(ct || 'text/plain').send(text);
    } catch (err) {
      return reply.status(502).send({ error: 'upstream proxy failed', detail: (err as Error).message });
    }
  });

  // Let the manager bootstrap each spawning agent into mini-Connect so it
  // can auth against `${BACKEND_URL}/id/api/auth/login/` when BACKEND_URL is
  // the daemon. Idempotent — manager calls ensureAgentUser per spawn.
  setMiniConnectAuth(miniConnectAuth);

  const client = new PlatformClient(config.platformUrl, config.accessToken);

  // Daemon epoch — unique per daemon lifetime. Clients compare this with their
  // stored epoch to detect daemon restarts and clear stale chat caches.
  const daemonEpoch = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ── Event log for message reliability (Kafka-style append-only log) ──
  const eventLog = new EventLog();
  // Clear stale events from previous daemon lifetime. Agent containers restart
  // with the daemon, so their session context is gone — replaying events from
  // dead sessions causes ghost messages in the dashboard ("flash of old messages").
  const staleCleared = eventLog.clearAll();
  if (staleCleared > 0) logger.info({ cleared: staleCleared }, 'Event log: cleared stale events from previous daemon lifetime');

  // Reap old events every hour (keeps last 24h)
  const reapTimer = setInterval(() => {
    try {
      const deleted = eventLog.reap();
      if (deleted > 0) logger.debug({ deleted }, 'Event log reaper cleaned old events');
    } catch { /* ignore */ }
  }, 60 * 60 * 1000);
  reapTimer.unref();

  // HIVE-247 (ADR-0004 §5.2): op_id idempotency for the provision gate, so a
  // retried POST /v1/agents/provision replays its prior decision instead of
  // double-materializing. Reaped on the same hourly tick.
  const provisionOpStore = new ProvisionOpStore();
  const provisionReapTimer = setInterval(() => {
    try { provisionOpStore.reap(); } catch { /* ignore */ }
  }, 60 * 60 * 1000);
  provisionReapTimer.unref();

  // ── Task scheduler — LOCAL Pulse only ──
  //
  // When platform is linked, pulse-server's own Redis scheduler owns ALL
  // platform task scheduling and notification delivery via shizuha-connect.
  // The daemon must NEVER poll platform tasks here — doing so would create
  // split-brain delivery (daemon + pulse both firing). Only local
  // (daemon-SQLite) pulse tasks flow through this loop.

  /** Dispatch a due-task message to an agent (fire-and-forget). */
  async function dispatchDueTaskToAgent(agentUsername: string, prompt: string) {
    const http = await import('node:http');
    const payload = JSON.stringify({ content: prompt, from_agent: 'pulse-scheduler', timeout: 120000 });
    const req = http.default.request({
      hostname: '127.0.0.1', port: config.port + 1,
      path: `/v1/agents/${encodeURIComponent(agentUsername)}/message`,
      method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    });
    req.on('error', () => {}); // fire-and-forget
    req.write(payload);
    req.end();
  }

  // ── Task scheduler — LOCAL Pulse only ──
  //
  // When platform is linked, pulse-server's own Redis scheduler owns ALL
  // platform task scheduling and notification delivery. The daemon must
  // NEVER poll platform tasks here — doing so would create split-brain
  // delivery (daemon + pulse both firing).
  //
  // Local Pulse (SQLite, daemon-only) continues to fire via this loop
  // for daemon-internal/cron-like tasks that don't live on the platform.
  const taskSchedulerTimer = setInterval(async () => {
    try {
      const ps = pulse();
      const dueTasks = ps.getDueTasks();
      for (const task of dueTasks) {
        if (!task.assignee) continue;
        const agent = config.agents.find(a => a.username === task.assignee);
        if (!agent || !isAgentRunning(agent.id)) continue;
        if (!getContainerUrl(agent.id)) continue;

        const isRecurring = task.is_recurring;
        const prompt = isRecurring
          ? `[Scheduled Task ${task.item_key}] "${task.title}"${task.description ? `\n\n${task.description}` : ''}\n\nThis is a recurring task (${task.schedule}). Please handle it now. When done, no need to mark it complete — it will automatically recur.`
          : `[Task ${task.item_key} is due] "${task.title}"${task.description ? `\n\n${task.description}` : ''}\n\nPlease handle this task. When complete, use pulse_local_complete_task(task="${task.item_key}") to mark it done.`;

        ps.markTriggered(task.id);
        await dispatchDueTaskToAgent(task.assignee, prompt);
        logger.info({ taskKey: task.item_key, agent: task.assignee, recurring: isRecurring }, 'Task scheduler: dispatched local due task');
      }
    } catch (err) {
      logger.error({ err }, 'Local task scheduler tick error');
    }
  }, 30_000); // every 30 seconds
  taskSchedulerTimer.unref();

  // NOTE: The Platform Pulse assignment notifier that used to live here has
  // been removed. When platform is linked, pulse-server delivers assignment
  // and due notifications directly via shizuha-connect
  // (see send_task_assignment_notification + fire_recurring_due in
  // shizuha-pulse/tasks/tasks.py). The daemon has no role in relaying
  // platform notifications.

  // ── Mail webhook receiver — shizuha-mail POSTs here when new messages arrive ──
  // Also supports manual trigger via periodic sync check
  app.post<{ Body: { type: string; account?: string; messages?: Array<Record<string, unknown>> } }>(
    '/v1/webhooks/mail', async (request) => {
      const { type: eventType, account: accountEmail, messages: newMessages } = request.body ?? {};

      if (eventType === 'new_messages' && newMessages?.length) {
        const assignee = 'mio'; // Dedicated mail operations agent
        let alertCount = 0;
        for (const msg of newMessages) {
          const ps = pulse();
          ps.fireAlert({
            title: `${msg.from_name || msg.from_address}: ${msg.subject}`,
            description: `From: ${msg.from_address}\nTo: ${msg.to}\nDate: ${msg.date}`,
            item_type: 'alert.email.new',
            severity: 'info',
            assignee,
            source: 'gmail',
            source_id: (msg.message_id as string) || `uid:${msg.imap_uid}`,
            payload: msg,
            labels: msg.has_attachments ? ['has-attachments'] : [],
            created_by: 'mail-webhook',
          });
          alertCount++;
        }
        logger.info({ account: accountEmail, count: alertCount }, 'Mail webhook: created alerts');

        // Dispatch to mail handler agent
        const agent = config.agents.find(a => a.username === assignee);
        if (agent && isAgentRunning(agent.id)) {
          const http = await import('node:http');
          const prompt = `[Mail Alert] ${alertCount} new email(s) received for ${accountEmail}. Check your alerts with pulse_local_get_alerts and process them.`;
          const body = JSON.stringify({ content: prompt, from_agent: 'mail-webhook', timeout: 120000 });
          const req = http.request({
            hostname: '127.0.0.1', port: config.port + 1,
            path: `/v1/agents/${encodeURIComponent(assignee)}/message`,
            method: 'POST', timeout: 5000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
          });
          req.on('error', () => {});
          req.write(body);
          req.end();
        }

        return { ok: true, alerts_created: alertCount };
      }

      return { ok: true, message: 'No action needed' };
    },
  );

  // ── Start chatbot WS bridge ──
  const chatBridge = new ChatbotBridge(config.platformUrl, config.accessToken, config.agents, eventLog);
  chatBridge.connect();

  // Runner-proxy connections to shizuha-agent's /ws/runner/ were removed
  // 2026-04-20. Agents now receive all work via Connect (DMs from users /
  // workflow / Pulse notifications). The Django runner_consumer was dead
  // weight — zero execute_task dispatches in the 24h before deletion.
  // Keep `__startRunnerProxies` as a no-op so manager.ts's scheduler-side
  // invocation continues to compile without a crash during transition.
  (globalThis as any).__startRunnerProxies = async () => { /* removed */ };

  // Push agent state changes (start/stop/error/restart) to all WS clients in real-time.
  setAgentStateChangeListener((agentId) => {
    chatBridge.broadcastAgentUpdate(agentId);
  });

  // ── Serve web UI static files ──
  // Canonical location: sibling to the binary (e.g. ~/.shizuha/lib/web/)
  const bundleDir = path.dirname(new URL(import.meta.url).pathname);
  const webDirPrimary = path.resolve(bundleDir, 'web');
  // Fallback: dev layout (cwd/dist/web)
  const webDirDev = path.resolve(process.cwd(), 'dist', 'web');
  const staticDir = fs.existsSync(webDirPrimary) ? webDirPrimary : fs.existsSync(webDirDev) ? webDirDev : null;

  if (staticDir) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      decorateReply: false,
      // All files in /assets/ have content hashes in filenames — safe to cache forever.
      // For index.html, we override via onSend hook below.
      maxAge: '1y',
      immutable: true,
    });
    // index.html and sw.js must not be cached — new deploys change JS hashes.
    app.addHook('onSend', (req, reply, payload, done) => {
      const url = req.url.split('?')[0]!;
      if (url === '/' || url.endsWith('.html') || url === '/sw.js' || !url.includes('.')) {
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
      done();
    });
    // SPA fallback — must also set no-cache (same as index.html)
    // Exclude /ws/ paths so they reach the httpServer 'upgrade' handler instead.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/v1/') || req.url.startsWith('/api/')) {
        return reply
          .status(404)
          .type('application/json')
          .send({ error: 'API route not found', path: req.url.split('?')[0] });
      }
      if (req.url.startsWith('/ws/') || /^\/(pulse|admin|wiki|notes|drive|finance|hr|inventory|mail|books|time|connect|agora|id|agent)\/api\//.test(req.url)) {
        // WebSocket paths should NOT be handled by the SPA fallback.
        // If this fires, it means a non-upgrade GET hit /ws/chat (e.g., Firefox
        // pre-flight or keep-alive reuse). Return 400 so Firefox retries with
        // a proper upgrade request on a fresh connection.
        return reply.status(400).send({ error: 'WebSocket upgrade required' });
      }
      const indexPath = path.join(staticDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        return reply.type('text/html').header('Cache-Control', 'no-cache, no-store, must-revalidate').send(fs.createReadStream(indexPath));
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  } else {
    logger.warn('Web UI not found — dashboard will only serve API endpoints');
  }

  // ── Dashboard authentication ──

  // Public endpoints (no auth required)
  app.get('/health', async () => ({
    status: 'ok',
    service: 'shizuha-daemon',
    version: '0.1.0',
    agents: config.agents.length,
  }));

  // Readiness (2026-08-11): /health answers 200 from the boot-phase
  // placeholder within milliseconds of exec (liveness = process alive);
  // /ready exists only on this real server, so it flips 200 exactly when the
  // full API surface is bound. k8s readiness must point here, not /health —
  // otherwise a booting daemon receives fleet-inventory traffic and serves
  // partial lists.
  app.get('/ready', async () => ({
    status: 'ready',
    service: 'shizuha-daemon',
    agents: config.agents.length,
  }));

  // Prometheus metrics (SCLI-74) — aggregate from per-agent JSONL telemetry files.
  // The daemon and its child gateway processes are separate OS processes and cannot
  // share in-process TurnTelemetryWindow objects. Reading the durable JSONL files
  // written by each gateway gives the daemon visibility into child-process metrics
  // without requiring cross-process IPC.
  app.get('/metrics', async (_request, reply) => {
    const nodeOs = await import('node:os');
    const nodePath = await import('node:path');
    const nodeFs = await import('node:fs');
    const { renderMetricsFromFiles } = await import('../metrics/registry.js');

    const jsonlPaths = (config.agents ?? [])
      .map((a) => nodePath.default.join(
        nodeOs.default.homedir(),
        '.shizuha', 'claude-sessions', a.username, 'turn-telemetry.jsonl',
      ))
      .filter((p) => nodeFs.default.existsSync(p));

    const body = await renderMetricsFromFiles(jsonlPaths);
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body);
  });

  app.get('/v1/dashboard/session', async (request) => {
    const token = extractSessionToken(request.headers.cookie);
    if (token) {
      const session = validateSession(token);
      if (session.valid) {
        const usingDefault = isDefaultPassword();
        return { authenticated: true, username: session.username, defaultPassword: usingDefault, requirePasswordChange: usingDefault, daemonEpoch };
      }
    }
    return { authenticated: false };
  });

  app.post<{ Body: { username: string; password: string } }>('/v1/dashboard/login', async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (!username || !password) {
      return reply.status(400).send({ error: 'Username and password are required' });
    }
    const result = dashboardLogin(username, password);
    if (!result.ok) {
      return reply.status(401).send({ error: result.error });
    }
    // Set session cookie
    reply.header('Set-Cookie', `shizuha_session=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}`);
    const usingDefault = isDefaultPassword();
    return { ok: true, username, defaultPassword: usingDefault, requirePasswordChange: usingDefault };
  });

  app.post('/v1/dashboard/logout', async (request, reply) => {
    const token = extractSessionToken(request.headers.cookie);
    if (token) dashboardLogout(token);
    reply.header('Set-Cookie', 'shizuha_session=; Path=/; HttpOnly; Max-Age=0');
    return { ok: true };
  });

  /**
   * Issue a daemon-side mini-Connect JWT for the bridge.
   *
   * The bridge ALWAYS connects to the daemon's WS (single host), even when
   * we're linked to a remote platform — the daemon proxies upstream. So the
   * browser-facing token is always the daemon's own mini-Connect JWT,
   * validated by the daemon's mini-id key. The upstream platform JWT (when
   * needed) is fetched separately by the daemon and never round-trips through
   * the browser.
   */
  app.post('/v1/connect-jwt', async (request, reply) => {
    const sessionToken = extractSessionToken(request.headers.cookie);
    if (!sessionToken) return reply.status(401).send({ error: 'Not authenticated' });
    const session = validateSession(sessionToken);
    if (!session.valid || !session.username) return reply.status(401).send({ error: 'Not authenticated' });

    const user = miniConnectStore.getUserByUsername(session.username);
    if (!user) return reply.status(404).send({ error: 'mini-Connect user not provisioned' });
    const tokens = miniConnectAuth.issueTokens(user);
    return reply.send({
      access: tokens.access,
      refresh: tokens.refresh,
      user: {
        id: tokens.user.id,
        username: tokens.user.username,
        email: tokens.user.email,
        is_agent: tokens.user.isAgent,
        agent_id: tokens.user.agentId,
        display_name: tokens.user.displayName,
      },
    });
  });

  app.post<{ Body: { currentPassword: string; newPassword: string } }>('/v1/dashboard/change-password', async (request, reply) => {
    const token = extractSessionToken(request.headers.cookie);
    if (!token || !validateSession(token).valid) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    const { currentPassword, newPassword } = request.body ?? {};
    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: 'Current and new password are required' });
    }
    const result = changePassword(currentPassword, newPassword);
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }
    // Clear the session cookie (password change invalidates all sessions)
    reply.header('Set-Cookie', 'shizuha_session=; Path=/; HttpOnly; Max-Age=0');
    return { ok: true };
  });

  app.post<{ Body: { agent_id?: string } }>('/v1/agent-auth/challenge', async (request, reply) => {
    const agent = resolveAgentByIdentifier(config.agents, request.body?.agent_id);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    const agentState = readDaemonState()?.agents.find((entry) => entry.agentId === agent.id);
    if (agentState && !agentState.enabled) {
      return reply.status(403).send({ error: 'Agent is disabled' });
    }
    try {
      return issueAgentGatewayChallenge(agent);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.post<{
    Body: { agent_id?: string; challenge_id?: string; timestamp?: number; signature?: string };
  }>('/v1/agent-auth/token', async (request, reply) => {
    const agent = resolveAgentByIdentifier(config.agents, request.body?.agent_id);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    const agentState = readDaemonState()?.agents.find((entry) => entry.agentId === agent.id);
    if (agentState && !agentState.enabled) {
      return reply.status(403).send({ error: 'Agent is disabled' });
    }
    const { challenge_id, timestamp, signature } = request.body ?? {};
    if (!challenge_id || typeof timestamp !== 'number' || !signature) {
      return reply.status(400).send({ error: 'challenge_id, timestamp, and signature are required' });
    }
    try {
      const token = exchangeAgentGatewayChallenge(agent, challenge_id, timestamp, signature);
      return { ok: true, ...token };
    } catch (err) {
      return reply.status(401).send({ error: (err as Error).message });
    }
  });

  // Auth middleware — gate all /v1/* endpoints (except public ones above)
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0]!;
    const method = (request.method || 'GET').toUpperCase();

    // HIVE-586: coordinator-backed daemons cannot use ANY local Codex account,
    // device-auth, refresh, test, reorder, add, or remove handler. Block at the
    // common request boundary before a route can read or mutate credentials.json.
    if (shouldRejectHostCodexCredentialRoute(url)) {
      return reply.status(409).send({
        error: 'Codex credentials are managed by Hive',
        code: 'hive_codex_authority',
        reauth_url: 'https://shizuha.com/hive/credentials',
      });
    }

    // Public endpoints — no auth needed
    if (
      url === '/health' ||
      url === '/v1/dashboard/session' ||
      url === '/v1/dashboard/login' ||
      url === '/v1/dashboard/logout' ||
      url === '/v1/agent-auth/challenge' ||
      url === '/v1/agent-auth/token' ||
      !url.startsWith('/v1/')
    ) {
      return;
    }

    // Device pairing endpoints — public (pair has its own code validation)
    if (url === '/v1/devices/pair' || url === '/v1/devices/status') {
      return;
    }

    // Webhook endpoints — have their own Bearer token auth (not session cookies)
    if (url.startsWith('/v1/hooks/')) {
      return; // Webhook handler validates its own token
    }

    // Hive-only fleet management (operator 2026-07-09): when FLEET_CONTROL_SECRET
    // is set, lifecycle/config/inspect endpoints accept ONLY the shared secret.
    // Localhost, session cookies, device tokens, and agent gateway tokens cannot
    // mutate fleet desired-state — Hive is the sole control plane client.
    if (isHiveOnlyFleetEndpoint(method, url)) {
      const secretConfigured = Boolean(getFleetControlSecret());
      if (secretConfigured) {
        const provided = request.headers[FLEET_CONTROL_SECRET_HEADER]
          ?? request.headers['X-Fleet-Control-Secret' as keyof typeof request.headers];
        if (!fleetControlSecretMatches(provided as string | string[] | undefined)) {
          return reply.status(403).send({
            error: 'fleet control requires hive control secret',
            code: 'hive_only_fleet_control',
          });
        }
        return; // authorized as Hive control plane
      }
      // Secret unset (local dev): fall through to existing session/localhost auth.
    }

    // Inter-agent communication endpoints — allow from localhost and Docker bridge.
    // Agents inside containers use host.docker.internal which resolves to the Docker
    // bridge gateway (172.x.0.1), not 127.0.0.1. Both are same-machine, no security risk.
    if (url.startsWith('/v1/agents/') && url.includes('/message')) {
      const remoteIp = request.ip;
      const isLocalhost = isDashboardLocalhostIp(remoteIp);
      const isDockerBridge = isDockerGatewayIp(remoteIp) || isTrustedDashboardBridgeRequest(request.headers, remoteIp);
      if (isLocalhost || isDockerBridge) {
        return; // Same-machine call — bypass auth
      }
    }
    // SCLI-100: Codex broker token endpoint — containers fetch current access
    // token from here instead of doing their own refresh. Same-machine + Docker
    // bridge bypass (read-only: returns token, does not write credentials).
    if (url === '/v1/codex/token') {
      const ip = request.ip;
      if (isDashboardLocalhostIp(ip) || isDockerGatewayIp(ip) || isTrustedDashboardBridgeRequest(request.headers, ip)) {
        return;
      }
    }
    // Token rate-limit reports from bridges (SCLI-73) — same-machine only.
    // Bridges live in containers (172.x / host.docker.internal) and must be
    // able to stamp a cooldown on their exhausted token without a session.
    // Write surface is limited to cooldown metadata on an existing label.
    if (url.startsWith('/v1/providers/anthropic/tokens/') &&
        (url.endsWith('/report-rate-limit') || url.endsWith('/report-invalid'))) {
      const ip = request.ip;
      if (isDashboardLocalhostIp(ip) || isDockerGatewayIp(ip) || isTrustedDashboardBridgeRequest(request.headers, ip)) {
        return;
      }
    }
    // Also allow /v1/agents list from localhost + Docker (for agent discovery)
    if (url === '/v1/agents') {
      const remoteIp = request.ip;
      const isLocal = isDashboardLocalhostIp(remoteIp)
        || isDockerGatewayIp(remoteIp)
        || isTrustedDashboardBridgeRequest(request.headers, remoteIp);
      if (isLocal) return;
    }
    // Localhost bypass — same-machine CLI/browser is trusted
    const remoteIp = request.ip || '';
    if (!isTrustedDashboardBridgeRequest(request.headers, remoteIp) && isDashboardLocalhostIp(remoteIp)) {
      return;
    }

    // Code generation is localhost-only
    if (url === '/v1/devices/code') {
      return reply.status(403).send({ error: 'Code generation is only available from localhost' });
    }

    // Check session cookie (dashboard web UI)
    const sessionToken = extractSessionToken(request.headers.cookie);
    if (sessionToken && validateSession(sessionToken).valid) {
      // SEC-642: Block all non-password-change API calls when default password is still in use.
      // Users must change their password before they can use the dashboard.
      if (isDefaultPassword() && url !== '/v1/dashboard/change-password' && url !== '/v1/dashboard/logout') {
        return reply.status(403).send({ error: 'Password change required', requirePasswordChange: true });
      }
      return;
    }

    // Check Bearer token (paired device)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const hash = hashToken(token);
      const device = findDeviceByTokenHash(hash);
      if (device) {
        const now = Date.now();
        if (now - device.lastSeenAt > 60_000) {
          updateLastSeen(device.deviceId, now, remoteIp);
        }
        (request as any).deviceId = device.deviceId;
        return;
      }

      const agentAuth = validateAgentGatewayToken(token);
      if (agentAuth.valid) {
        const requiredScope = resolveAgentGatewayScope(request.method, url);
        if (!requiredScope) {
          return reply.status(403).send({ error: 'Agent token is not allowed for this endpoint' });
        }
        if (!hasAgentGatewayScope(agentAuth.scopes, requiredScope)) {
          return reply.status(403).send({ error: 'Agent token lacks required scope' });
        }
        (request as any).agentAuth = agentAuth;
        return;
      }
    }

    return reply.status(401).send({ error: 'Not authenticated' });
  });

  // ── Device pairing (for mobile apps + remote access) ──

  app.get('/v1/devices/status', async () => {
    const devices = listDevices();
    return { pairingRequired: devices.length === 0 };
  });

  app.post('/v1/devices/code', async (request, reply) => {
    // Localhost-only — checked in auth middleware (returns 403 for remote)
    const raw = generatePairingCode();
    const now = Date.now();
    addPendingCode({ code: raw, createdAt: now, expiresAt: now + CODE_TTL_MS });
    return { code: formatCode(raw), raw, expiresAt: now + CODE_TTL_MS };
  });

  app.post<{ Body: { code: string; deviceName?: string; platform?: string } }>(
    '/v1/devices/pair', async (request, reply) => {
      const ip = request.ip || '';
      if (!checkRateLimit(ip)) {
        return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
      }

      const { code, deviceName = 'Unknown', platform = 'unknown' } = request.body ?? {};
      if (!code) return reply.status(400).send({ error: 'Code is required' });

      const normalized = code.replace(/[-\s]/g, '').toUpperCase();
      const consumed = consumePendingCode(normalized);
      if (!consumed) {
        recordFailure(ip);
        return reply.status(400).send({ error: 'Invalid or expired pairing code' });
      }

      resetFailures(ip);
      const deviceId = generateDeviceId();
      const token = generateDeviceToken();
      const tokenHash = hashToken(token);
      const now = Date.now();
      addDevice({ deviceId, deviceName, platform, tokenHash, createdAt: now, lastSeenAt: now, remoteIp: ip });
      logger.info(`Device paired: ${deviceName} (${platform}) from ${ip}`);
      return { deviceId, token, deviceName };
    }
  );

  app.get('/v1/devices', async () => {
    return { devices: listDevices() };
  });

  app.delete<{ Params: { id: string } }>('/v1/devices/:id', async (request, reply) => {
    const removed = removeDevice(request.params.id);
    if (!removed) return reply.status(404).send({ error: 'Device not found' });
    return { ok: true };
  });

  app.get('/v1/sessions', async () => ({ sessions: [] }));

  // ── Voice Call (Twilio) ──

  const twilioSid = process.env['TWILIO_ACCOUNT_SID'] ?? '';
  const twilioAuth = process.env['TWILIO_AUTH_TOKEN'] ?? '';
  const twilioPhone = process.env['TWILIO_PHONE_NUMBER'] ?? '';
  const twilioConfigured = !!(twilioSid && twilioAuth && twilioPhone);

  app.get('/v1/voice/status', async (request, reply) => {
    const callSid = (request.query as Record<string, string>).callSid;
    if (callSid && twilioConfigured) {
      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls/${callSid}.json`,
          { headers: { 'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioAuth}`).toString('base64') } },
        );
        if (res.ok) {
          const data = await res.json() as { status?: string };
          return { configured: true, callStatus: data.status ?? 'unknown' };
        }
      } catch { /* ignore */ }
    }
    return { configured: twilioConfigured, callStatus: null };
  });

  app.post<{ Body: { phoneNumber: string; twiml?: string } }>('/v1/voice/call', async (request, reply) => {
    if (!twilioConfigured) return reply.status(503).send({ error: 'Twilio not configured' });
    const { phoneNumber, twiml } = request.body ?? {};
    if (!phoneNumber) return reply.status(400).send({ error: 'phoneNumber required' });

    const defaultTwiml = `<Response><Say voice="Polly.Matthew">Hello, this is your Shizuha agent. How can I help you?</Say><Pause length="60"/></Response>`;

    try {
      const body = new URLSearchParams({
        To: phoneNumber,
        From: twilioPhone,
        Twiml: twiml || defaultTwiml,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioAuth}`).toString('base64'),
          },
          body: body.toString(),
        },
      );
      const data = await res.json() as { sid?: string; status?: string; message?: string };
      if (!res.ok) return reply.status(res.status).send({ error: data.message ?? 'Twilio error' });
      return { callSid: data.sid, status: data.status };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { callSid: string } }>('/v1/voice/hangup', async (request, reply) => {
    if (!twilioConfigured) return reply.status(503).send({ error: 'Twilio not configured' });
    const { callSid } = request.body ?? {};
    if (!callSid) return reply.status(400).send({ error: 'callSid required' });

    try {
      const body = new URLSearchParams({ Status: 'completed' });
      await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls/${callSid}.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioAuth}`).toString('base64'),
          },
          body: body.toString(),
        },
      );
      return { ok: true };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Agent list ──

  app.get('/v1/agents', async () => {
    return { agents: config.agents.map(serializeAgent) };
  });

  // ── Agent activity log (full transcript from session JSONL) ──

  const MAX_RUNTIME_MEMORY_ACTIVITY_EVENTS = 500;
  const RUNTIME_WORKSPACE_ACTIVITY_TAIL_BYTES = 2 * 1024 * 1024;
  const ACTIVITY_INLINE_TEXT_LIMIT = 12_000;

  const readTailUtf8 = (filePath: string, maxBytes: number): string => {
    try {
      const stat = fs.statSync(filePath);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const text = buf.toString('utf-8');
        if (start <= 0) return text;
        const firstNewline = text.indexOf('\n');
        return firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  };

  const parseJsonLines = (text: string): any[] => {
    const rows: any[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
    return rows;
  };

  const runtimeWorkspaceDir = (agent: AgentInfo): string => {
    const shizuhaHome = process.env['HOME'] ?? '/root';
    return path.join(shizuhaHome, '.shizuha', 'workspaces', agent.username);
  };

  const telemetryObjToTurnSummary = (obj: any): any | null => {
    const ts = obj.endTime ?? obj.startTime;
    if (!ts || obj.name !== 'llm-turn') return null;
    const result = obj.result ?? {};
    const metadata = obj.metadata ?? {};
    const durationMs = typeof obj.durationMs === 'number' ? obj.durationMs : undefined;
    const model = metadata.model ? String(metadata.model) : 'model';
    const toolCalls = typeof result.toolCalls === 'number' ? result.toolCalls : 0;
    const inputTokens = typeof result.inputTokens === 'number' ? result.inputTokens : 0;
    const outputTokens = typeof result.outputTokens === 'number' ? result.outputTokens : 0;
    const duration = durationMs !== undefined ? `${Number((durationMs / 1000).toFixed(1))}s` : 'unknown duration';
    const status = obj.status === 'error' ? 'failed' : 'completed';
    // Behaviour first, accounting second (operator 2026-08-05). Empty
    // 0-tool / 294k-token heartbeats must say so — token counts alone
    // made Saki's Live activity look permanently doomed.
    const toolNameList = Array.isArray(result.toolNames)
      ? result.toolNames.map((n: unknown) => String(n))
      : [];
    const excerpt = typeof result.assistantExcerpt === 'string'
      ? result.assistantExcerpt.trim()
      : '';
    const behaviour = [
      excerpt ? `“${excerpt.slice(0, 300)}${excerpt.length > 300 ? '…' : ''}”` : '',
      toolNameList.length ? `tools: ${toolNameList.join(', ')}` : '',
      !toolCalls && !excerpt ? 'no tools' : '',
    ].filter(Boolean).join(' · ');
    return {
      type: 'turn_summary',
      ts,
      text: `LLM turn ${status}: ${model}, ${duration}, ${inputTokens} input tokens, ${outputTokens} output tokens, ${toolCalls} tool calls`
        + (behaviour ? ` — ${behaviour}` : ''),
      status,
      model,
      duration_ms: durationMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      tool_calls: toolCalls,
      tool_names: toolNameList,
      assistant_excerpt: excerpt,
    };
  };

  const parseRuntimeWorkspaceActivity = (agent: AgentInfo): any[] => {
    const workspaceDir = runtimeWorkspaceDir(agent);
    const events: any[] = [];

    for (const obj of parseJsonLines(readTailUtf8(path.join(workspaceDir, '.audit-log.jsonl'), RUNTIME_WORKSPACE_ACTIVITY_TAIL_BYTES))) {
      const ts = obj.timestamp;
      const tool = obj.tool;
      if (!ts || !tool) continue;
      if (obj.phase === 'before') {
        events.push({
          type: 'tool_call',
          ts,
          tool,
          input: String(obj.inputSummary ?? '').slice(0, ACTIVITY_INLINE_TEXT_LIMIT),
        });
      } else if (obj.phase === 'after' || obj.phase === 'error') {
        events.push({
          type: 'tool_result',
          ts,
          tool,
          output: String(obj.resultSummary ?? (obj.phase === 'error' ? 'ERROR' : '')).slice(0, ACTIVITY_INLINE_TEXT_LIMIT),
        });
      }
    }

    for (const obj of parseJsonLines(readTailUtf8(path.join(workspaceDir, '.telemetry.jsonl'), RUNTIME_WORKSPACE_ACTIVITY_TAIL_BYTES))) {
      const event = telemetryObjToTurnSummary(obj);
      if (event) events.push(event);
    }

    return events;
  };

  const mergeAndSliceActivityEvents = (events: any[], limit: number, offset: number): any[] => {
    events.sort((a, b) => Date.parse(b.ts ?? '') - Date.parse(a.ts ?? ''));

    const deduped: any[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      const key = [
        event.ts ?? '',
        event.type ?? '',
        event.role ?? '',
        event.tool ?? '',
        event.text ?? event.input ?? event.output ?? '',
      ].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(event);
    }

    return deduped.slice(offset, offset + limit);
  };

  const normalizeRuntimeActivityEvent = (event: ReturnType<typeof getAgentActivity>[number]): any | null => {
    const ts = event.ts;
    switch (event.type) {
      case 'tool_start':
        return {
          type: 'tool_call',
          ts,
          tool: event.tool,
          input: event.detail ?? '',
        };
      case 'tool_complete':
        return {
          type: 'tool_result',
          ts,
          tool: event.tool,
          output: event.detail ?? '',
        };
      case 'tool_output':
        return {
          type: 'tool_output',
          ts,
          tool: event.tool,
          stream: event.stream,
          output: event.detail ?? '',
        };
      case 'message_received':
        return { type: 'message', role: 'user', ts, text: event.detail ?? '' };
      case 'message_sent':
        return { type: 'message', role: 'assistant', ts, text: event.detail ?? '' };
      case 'reasoning':
        return { type: 'reasoning', ts, text: event.detail ?? '' };
      case 'telemetry':
        return { type: 'turn_summary', ts, text: event.detail ?? '' };
      case 'turn_complete':
      case 'session_start':
        return { type: 'message', role: 'system', ts, text: event.detail ?? event.type.replace('_', ' ') };
      case 'error':
        return { type: 'message', role: 'system', ts, text: `error: ${event.detail ?? ''}`.trim() };
      default:
        return null;
    }
  };

  app.get<{ Params: { agentId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/v1/agents/:agentId/activity',
    async (request) => {
      const agent = config.agents.find(a => a.id === request.params.agentId);
      if (!agent) return { events: [] };

      const limit = Math.min(parseInt(request.query.limit ?? '100', 10), 500);
      const offset = parseInt(request.query.offset ?? '0', 10);

      // k8s-native agents (HIVE-303): the live session JSONL is on the pod
      // PVC, not the host claude-sessions mount — host paths only hold stale
      // pre-migration leftovers. Read the pod's newest session via kubectl
      // exec; fall back to host/telemetry sources when the pod is unreachable.
      let sessionFile = '';
      let sessionSource = '';
      let sessionLines: string[] | null = null;
      let liveTailUnavailable: K8sAgentSessionTailUnavailable | undefined;
      if (isK8sAgent(agent)) {
        const podSession = await readK8sAgentSessionTailStatus(agent, Math.min(Math.max(limit + offset + 200, 2000), 10000));
        if (podSession.tail) {
          sessionFile = podSession.tail.file;
          sessionLines = podSession.tail.lines;
          sessionSource = 'pod-jsonl';
          // SCLI-330: k8s agents have no child-stdout stream feeding
          // lastActivityMap, so derive lastActiveAt from the pod tail we just
          // read (newest event timestamp, scanning from the end). This is what
          // keeps Hive's Agents-page last_active_at truthful for pod agents.
          for (let i = podSession.tail.lines.length - 1; i >= 0; i--) {
            const raw = podSession.tail.lines[i];
            if (!raw?.trim()) continue;
            try {
              const obj = JSON.parse(raw);
              const ts = obj?.timestamp ?? obj?.ts ?? obj?.endTime ?? obj?.startTime;
              if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) {
                noteAgentActivity(agent.id, ts);
                break;
              }
            } catch { /* skip malformed line, keep scanning */ }
          }
        } else {
          liveTailUnavailable = podSession.unavailable;
        }
      }

      if (!sessionLines) {
        const shizuhaHome = process.env['HOME'] ?? '/root';
        const sessionDir = path.join(shizuhaHome, '.shizuha', 'claude-sessions', agent.username, 'projects', '-workspace');

        // Find the most recent session JSONL
        try {
          const files = fs.readdirSync(sessionDir)
            .filter((f: string) => f.endsWith('.jsonl'))
            .map((f: string) => ({ name: f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
            .sort((a: any, b: any) => b.mtime - a.mtime);
          if (files.length > 0) sessionFile = path.join(sessionDir, files[0]!.name);
        } catch { /* no session files */ }
        if (sessionFile) {
          try {
            sessionLines = fs.readFileSync(sessionFile, 'utf-8').split('\n');
            sessionSource = 'jsonl';
          } catch { /* file read error */ }
        }
      }

      if (!sessionLines) {
        // Fall back to Shizuha runtime workspace logs, Codex/Shizuha state DB,
        // and in-memory telemetry events.
        const events = [
          ...parseRuntimeWorkspaceActivity(agent),
          ...stateDbMessagesToActivity(readAgentStateDbMessages(agent, limit)),
          ...getAgentActivity(request.params.agentId, limit)
          .map(normalizeRuntimeActivityEvent)
            .filter(Boolean),
        ];
        const sliced = mergeAndSliceActivityEvents(events, limit, offset);
        return {
          events: sliced,
          total: events.length,
          source: 'workspace+state-db+memory',
          ...(liveTailUnavailable ? { degraded: true, liveTailUnavailable } : {}),
        };
      }

      // Parse JSONL into rich activity events
      const events: any[] = [];
      // The pod tail may resolve to the SCLI/gateway audit log or turn
      // telemetry instead of a Claude session (newest file wins) — those use
      // their own schemas; the claude-session parse below would silently drop
      // every line.
      const tailedName = path.basename(sessionFile || '');
      if (tailedName === '.audit-log.jsonl' || tailedName === '.telemetry.jsonl') {
        for (const line of sessionLines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (tailedName === '.audit-log.jsonl') {
              const ts = obj.timestamp;
              const tool = obj.tool;
              if (!ts || !tool) continue;
              if (obj.phase === 'before') {
                events.push({
                  type: 'tool_call',
                  ts,
                  tool,
                  input: String(obj.inputSummary ?? '').slice(0, ACTIVITY_INLINE_TEXT_LIMIT),
                });
              } else if (obj.phase === 'after' || obj.phase === 'error') {
                events.push({
                  type: 'tool_result',
                  ts,
                  tool,
                  output: String(obj.resultSummary ?? (obj.phase === 'error' ? 'ERROR' : '')).slice(0, ACTIVITY_INLINE_TEXT_LIMIT),
                });
              }
            } else {
              const event = telemetryObjToTurnSummary(obj);
              if (event) events.push(event);
            }
          } catch { /* skip malformed lines */ }
        }
      } else {
        for (const line of sessionLines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'user') {
              const content = obj.message?.content ?? '';
              const text = typeof content === 'string' ? content :
                (Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '');
              if (text) {
                events.push({
                  type: 'message',
                  role: 'user',
                  ts: obj.timestamp,
                  text: text.slice(0, ACTIVITY_INLINE_TEXT_LIMIT),
                });
              }
            } else if (obj.type === 'assistant') {
              const blocks = obj.message?.content ?? [];
              for (const block of blocks) {
                if (block.type === 'text' && block.text?.trim()) {
                  events.push({
                    type: 'message',
                    role: 'assistant',
                    ts: obj.timestamp,
                    text: block.text.slice(0, ACTIVITY_INLINE_TEXT_LIMIT),
                  });
                } else if (block.type === 'tool_use') {
                  events.push({
                    type: 'tool_call',
                    ts: obj.timestamp,
                    tool: block.name,
                    input: JSON.stringify(block.input ?? {}).slice(0, ACTIVITY_INLINE_TEXT_LIMIT),
                  });
                } else if (block.type === 'tool_result') {
                  events.push({
                    type: 'tool_result',
                    ts: obj.timestamp,
                    tool: block.name,
                    output: (typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')).slice(0, ACTIVITY_INLINE_TEXT_LIMIT),
                  });
                }
              }
            }
          } catch { /* skip malformed lines */ }
        }
      }

      // JSONL history can be stale for container-backed sessions while the
      // runtime is actively emitting telemetry. Merge the fresh Shizuha
      // workspace logs and in-memory ring so Hive never hides current work
      // behind an older session file.
      // k8s agents must NOT merge the host ~/.shizuha/workspaces leftover —
      // that file still holds Saki's 294k-token empty heartbeats and makes
      // a recovered pod look queue-blind.
      if (!isK8sAgent(agent)) {
        events.push(...parseRuntimeWorkspaceActivity(agent));
      }
      events.push(...stateDbMessagesToActivity(readAgentStateDbMessages(agent, MAX_RUNTIME_MEMORY_ACTIVITY_EVENTS)));
      for (const event of getAgentActivity(request.params.agentId, MAX_RUNTIME_MEMORY_ACTIVITY_EVENTS)) {
        const normalized = normalizeRuntimeActivityEvent(event);
        if (normalized) events.push(normalized);
      }
      const total = mergeAndSliceActivityEvents(events, Number.MAX_SAFE_INTEGER, 0).length;
      const sliced = mergeAndSliceActivityEvents(events, limit, offset);
      return {
        events: sliced,
        total,
        sessionFile: path.basename(sessionFile),
        source: `${sessionSource}+workspace+state-db+memory`,
        ...(liveTailUnavailable ? { degraded: true, liveTailUnavailable } : {}),
      };
    },
  );

  // ── Structured heartbeat queue-drain outcome telemetry (PLAT-1112) ──

  app.get('/v1/agents/heartbeat-outcomes', async () => {
    return { outcomes: listHeartbeatQueueDrainOutcomes() };
  });

  app.get<{ Params: { agentId: string } }>(
    '/v1/fleet/agents/:agentId/heartbeat-outcome',
    async (request) => {
      const outcome = getHeartbeatQueueDrainOutcome(request.params.agentId);
      return { outcome: outcome ?? null };
    },
  );

  // ── Per-agent recent activity rate (≈ tok/s) for the fleet cards ──
  // This endpoint is on Hive's hot agents-list path. Keep it memory-only; the
  // detailed drawer endpoint may read session/workspace/state files on demand.
  app.get<{ Querystring: { window?: string } }>(
    '/v1/agents/activity-rates',
    async (request) => {
      const windowSec = Math.min(Math.max(parseInt(request.query.window ?? '600', 10), 60), 3600);
      const nowMs = Date.now();
      const rates: Record<string, any> = {};

      for (const agent of config.agents) {
        rates[agent.id] = buildAgentActivityRate(
          getAgentActivity(agent.id, MAX_RUNTIME_MEMORY_ACTIVITY_EVENTS),
          getAgentLastActivity(agent.id),
          windowSec,
          nowMs,
        );
      }
      return { rates, window_sec: windowSec };
    },
  );

  // ── Agent workspace files (images, screenshots, artifacts) ──
  // Agents can share images by saving to /workspace/ and referencing via markdown:
  //   ![screenshot](/v1/workspace/nori/files/screenshots/page.png)

  app.get<{ Params: { username: string; '*': string } }>(
    '/v1/workspace/:username/files/*',
    async (request, reply) => {
      const { username } = request.params;
      const filePath = (request.params as Record<string, string>)['*'] ?? '';

      // Validate: no path traversal
      if (filePath.includes('..') || filePath.startsWith('/')) {
        return reply.status(400).send({ error: 'Invalid path' });
      }

      // Resolve workspace directory
      const workspaceRoot = path.join(
        process.env['HOME'] ?? '/root',
        '.shizuha', 'workspaces', username,
      );
      const fullPath = path.join(workspaceRoot, filePath);

      // Ensure the resolved path is within the workspace
      if (!fullPath.startsWith(workspaceRoot)) {
        return reply.status(403).send({ error: 'Path outside workspace' });
      }

      if (!fs.existsSync(fullPath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        return reply.status(400).send({ error: 'Not a file' });
      }

      // Determine content type
      const ext = path.extname(fullPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf', '.json': 'application/json',
        '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'public, max-age=300'); // 5 min cache
      return reply.send(fs.createReadStream(fullPath));
    },
  );

  // ── Agent templates ──

  app.get('/v1/templates', async () => {
    try {
      const { loadTemplates } = await import('../templates/loader.js');
      return { templates: loadTemplates().map((t) => ({
        name: t.name, description: t.description, tags: t.tags, category: t.category,
        role: t.role, model: t.model, executionMethod: t.executionMethod,
        skills: t.skills, requires: t.requires, author: t.author, version: t.version,
      })) };
    } catch { return { templates: [] }; }
  });

  // ── Async message injection — fire-and-forget ──
  //
  // Used by: message_user tool (inter-agent path), task scheduler, mail webhook, any inter-agent
  // communication. Returns immediately after dispatching the message.
  //
  // Routing policy (Hritik's principle: daemon is a headless fallback only):
  //   1. Platform linked → proxy to shizuha-connect's /api/messaging/dm/
  //      endpoint. The recipient's ConnectChannel WebSocket picks it up and
  //      pushes it into their inbox. Same path as humans and message_user.
  //   2. Platform unlinked → WS-inject directly into the target agent's
  //      gateway (headless fallback for local-only runtimes).
  //
  // The legacy `/v1/agents/:id/ask` alias has been removed — `/message` is
  // the only path now.
  app.post<{
    Params: { targetId: string };
    Body: { content: string; from_agent?: string; timeout?: number };
  }>('/v1/agents/:targetId/message', async (request, reply) => {
    const { targetId } = request.params;
    const { content, from_agent } = request.body ?? {};
    if (!content) return reply.status(400).send({ error: 'content required' });
    const senderAgent = (request as any).agentAuth as
      | { agentId: string; agentName: string; agentUsername: string }
      | undefined;

    const targetAgent = config.agents.find(a => a.id === targetId || a.username === targetId);
    if (!targetAgent) return reply.status(404).send({ error: `Agent "${targetId}" not found` });

    const userMsgId = crypto.randomUUID();
    const source = senderAgent ? `agent:${senderAgent.agentUsername}` : from_agent ? `agent:${from_agent}` : 'api';

    if (shouldLogGatewayIngress(targetAgent)) {
      logger.info({
        agentId: targetAgent.id, agentName: targetAgent.name, agentUsername: targetAgent.username,
        executionMethod: primaryExecutionMethod(targetAgent), pathway: 'agents_message',
        source, contentPreview: previewContent(content), contentLength: content.length,
      }, 'Agent message injected');
    }

    // ── Platform-linked path: proxy through Connect ────────────────────────
    // Daemon processes don't usually have SHIZUHA_PLATFORM_URL in env (that's
    // injected into containers). Use the daemon's own config.platformUrl,
    // which is resolved at startup from settings.json.
    const platformBase = config.platformUrl || process.env['SHIZUHA_PLATFORM_URL'] || '';
    if (platformBase) {
      try {
        const { sendConnectDm } = await import('../platform/connect-dm.js');
        const recipientEmail = targetAgent.email || `${targetAgent.username}@agents.shizuha.io`;

        // Resolve sender identity. Priority:
        //   1. The caller already presented a valid Authorization header
        //      (e.g., the dashboard user's access token) — forward it as-is.
        //      Connect extracts the sender from the token's user_id claim.
        //   2. Calling agent via agentAuth / from_agent → look up in config
        //      and the daemon's identity cache, then self-mint a token with
        //      the correct user_id + is_agent + agent_id claims.
        const authHeader = request.headers['authorization'] || '';
        let callerToken: string | undefined = undefined;
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
          callerToken = authHeader.slice(7);
        }

        let sendOpts;
        if (callerToken && !senderAgent && !from_agent) {
          // Dashboard / human-user case: just forward their token.
          sendOpts = {
            recipientEmail,
            content,
            clientMessageId: userMsgId,
            token: callerToken,
            platformUrl: platformBase,
          };
        } else {
          // Agent-as-sender case: self-mint with agent claims.
          const senderUsername = senderAgent?.agentUsername || from_agent || '';
          const senderAgentRecord = senderUsername
            ? config.agents.find(a => a.username === senderUsername)
            : undefined;
          const senderAgentId = senderAgent?.agentId || senderAgentRecord?.id || undefined;
          const senderEmail = senderAgentRecord?.email
            || (senderUsername ? `${senderUsername}@agents.shizuha.io` : undefined);
          const senderIdentity = senderUsername ? getCachedAgentIdentity(senderUsername) : undefined;
          const senderUserId = senderIdentity?.userId;

          if (!senderUserId && !callerToken) {
            // Can't mint a valid token without user_id and no caller token to
            // forward. Fall back to WS inject below.
            logger.warn({
              agentId: targetAgent.id, senderUsername,
            }, 'No resolvable sender for Connect route, falling back to daemon WS inject');
            throw new Error('no_sender_identity');
          }

          sendOpts = callerToken && !senderUserId
            ? {
              recipientEmail, content, clientMessageId: userMsgId,
              token: callerToken, platformUrl: platformBase,
            }
            : {
              recipientEmail, content, clientMessageId: userMsgId,
              sender: {
                username: senderUsername || 'daemon',
                email: senderEmail,
                userId: senderUserId,
                agentId: senderAgentId,
                isAgent: !!senderUsername,
              },
              platformUrl: platformBase,
            };
        }

        const result = await sendConnectDm(sendOpts);
        if (result.ok) {
          logActivity(targetAgent.id, {
            ts: new Date().toISOString(),
            type: 'message_received',
            detail: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
          });
          return {
            ok: true,
            message: `Message delivered to ${targetAgent.name} via Connect`,
            agent: targetAgent.username,
            message_id: result.messageId || userMsgId,
            conversation_id: result.conversationId,
            routed: 'connect',
          };
        }
        logger.warn({
          agentId: targetAgent.id, error: result.error, status: result.status,
        }, 'Connect route failed, falling back to daemon WS inject');
      } catch (err) {
        logger.warn({
          agentId: targetAgent.id, err: (err as Error).message,
        }, 'Connect route threw, falling back to daemon WS inject');
      }
    }

    // ── Headless fallback: WS-inject directly into the target's gateway ────
    if (!isAgentRunning(targetAgent.id)) return reply.status(503).send({ error: `Agent "${targetAgent.name}" is not running` });

    const agentWsUrl = getContainerUrl(targetAgent.id);
    if (!agentWsUrl) return reply.status(503).send({ error: `Agent "${targetAgent.name}" has no port assigned` });

    const ws = new WebSocket(agentWsUrl);

    ws.on('open', async () => {
      const senderName = senderAgent?.agentName || from_agent || '';
      const senderUsername = senderAgent?.agentUsername || from_agent || '';
      const senderRole = senderName ? config.agents.find(a => a.username === senderUsername)?.role : '';
      const prefix = senderUsername
        ? `[Agent Message]\nFrom: @${senderUsername}${senderRole ? ` (${senderRole})` : ''}\nReply to: @${senderUsername} via mcp__shizuha-connect__message_user(recipient_username="${senderUsername}", content=...)\n\n`
        : '';
      try {
        await sendJsonOverSocket(ws, {
          type: 'message',
          content: `${prefix}${content}`,
          agent_id: targetAgent.id,
        });
        chatBridge.logEvent(targetAgent.id, {
          type: 'user_message', agent_id: targetAgent.id, content,
          message_id: userMsgId, source,
          data: { content, agent_id: targetAgent.id, message_id: userMsgId },
        });
      } catch {
        ws.close();
      }
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!msg.agent_id) msg.agent_id = targetAgent.id;
        const msgType = msg.type as string;
        chatBridge.logEvent(targetAgent.id, msg);
        // forwardAgentEvent() removed 2026-04-20 — runner proxy retired.
        if (msgType === 'complete') {
          ws.close();
        }
      } catch { /* ignore */ }
    });

    ws.on('error', () => { ws.close(); });
    setTimeout(() => { try { ws.close(); } catch {} }, 600_000);

    logActivity(targetAgent.id, {
      ts: new Date().toISOString(),
      type: 'message_received',
      detail: content.slice(0, 100) + (content.length > 100 ? '...' : ''),
    });
    return { ok: true, message: `Message sent to ${targetAgent.name}`, agent: targetAgent.username, message_id: userMsgId, routed: 'daemon-ws' };
  });

  // ── Compatibility endpoint for mobile apps (same format as SaaS agent/api/agents/) ──

  app.get('/agent/api/agents/', async () => {
    const state = readDaemonState();
    return config.agents.map((a) => {
      const agentState = state?.agents.find((s) => s.agentId === a.id);
      return {
        id: a.id,
        name: a.name,
        username: a.username,
        role: a.role,
        role_name: a.role,
        status: agentState?.enabled ? 'active' : 'paused',
        execution_method: a.executionMethod,
        avatar_url: null,
      };
    });
  });

  // ── Agent chat history (stub for mobile app compatibility) ──

  app.get<{ Params: { agentId: string } }>('/agent/api/chatbot/agents/:agentId/history/', async () => {
    return [];
  });

  // ── HIVE-247 (ADR-0004 §5.2): agent provisioning admission gate ──
  // Hive's provisioner calls this op instead of materializing a runtime/k8s agent
  // directly. We validate the child's canonical Shizuha-ID BEFORE materialize:
  // an explicit identity violation returns 403 and creates NOTHING (no orphaned
  // agent) — unlike the flag-mode spawn path which materializes then only warns.
  // op_id makes the op idempotent (a retried provision replays its decision).
  // Scope: the reused validateAgentIdentity covers §4.2 (a)-(d); (e) Pulse-identity
  // and (f) single-owner are Slice 1b. Hive-side event consumption is Slice 2 — the
  // authoritative provision result here is the HTTP response.
  app.post<{
    Body: {
      op_id?: string;
      username?: string;
      name?: string;
      email?: string;
      role?: string;
      executionMethod?: string;
      runtimeEnvironment?: string;
      skills?: string[];
      personalityTraits?: Record<string, string>;
      modelFallbacks?: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string }>;
      modelOverrides?: Record<string, string>;
      contextPrompt?: string;
    };
  }>('/v1/agents/provision', async (request, reply) => {
    const body = request.body ?? {};
    const opId = typeof body.op_id === 'string' ? body.op_id : '';
    const username = typeof body.username === 'string' ? body.username : '';
    if (!opId || !username) {
      return reply.status(400).send({ error: 'op_id and username are required' });
    }

    // Idempotency: a retried provision replays its prior decision — never re-materializes.
    const prior = provisionOpStore.get(opId);
    if (prior) {
      // Replay the prior decision verbatim — including the materialized agent_id on
      // an admit (P2), so Hive recovers it after losing the 201. httpStatus matches
      // the fresh response (201 admit / 403 reject) so retries don't see 200-vs-201 (P3).
      return reply.status(prior.httpStatus).send({
        op_id: opId, username, admitted: prior.admit, reasons: prior.reasons,
        agent_id: prior.agentId, duplicate: true,
      });
    }

    // §5.2 gate — validate identity BEFORE materialize. Cache-or-LIVE: a
    // top-down provision targets a BRAND-NEW username whose ID account Hive
    // created moments ago — never in the startup prefetch cache, so the
    // cache-only resolver hard-rejected every new agent ('no-canonical-
    // shizuha-id'). resolveAgentIdentityLive falls back to the authoritative
    // users API on a cache miss (same gate semantics otherwise).
    const identity = await resolveAgentIdentityLive({ username, email: body.email });
    const decision = decideProvision({ username, email: body.email }, identity);
    const ts = Date.now();

    if (!decision.admit) {
      // Reject -> 403, materialize NOTHING (no orphan). Emit a rejected identity_event.
      logger.warn({ event: buildIdentityEvent(username, decision, opId, ts) },
        'HIVE-247 provision REJECTED — identity violation, no agent materialized');
      provisionOpStore.record(opId, decision);
      return reply.status(403).send({ op_id: opId, username, admitted: false, reasons: decision.reasons, duplicate: false });
    }

    // Admit -> materialize, then emit identity_event(admitted) + state_delta(added).
    try {
      const agent = createLocalAgentAtRuntime({
        name: body.name || username,
        username,
        email: body.email,
        role: body.role,
        executionMethod: body.executionMethod,
        runtimeEnvironment: body.runtimeEnvironment,
        skills: body.skills,
        personalityTraits: body.personalityTraits,
        modelFallbacks: body.modelFallbacks,
        modelOverrides: body.modelOverrides,
        contextPrompt: body.contextPrompt,
      });
      logger.info({ event: buildIdentityEvent(username, decision, opId, ts) }, 'HIVE-247 provision ADMITTED');
      logger.info({ event: buildStateDelta(agent.id, username, opId, ts) }, 'HIVE-247 state_delta added');
      // Store the materialized agent_id with the decision so an idempotent replay
      // can return it (P2); use decision.httpStatus (201) so fresh + replay agree (P3).
      decision.agentId = agent.id;
      provisionOpStore.record(opId, decision);
      return reply.status(decision.httpStatus).send({ op_id: opId, username, admitted: true, agent_id: agent.id, duplicate: false });
    } catch (e) {
      // Materialize failed AFTER admit -> do NOT cache the op, so Hive can retry.
      logger.error({ username, opId, err: (e as Error).message },
        'HIVE-247 provision admitted but materialize failed');
      return reply.status(500).send({ op_id: opId, username, admitted: true, error: `materialize failed: ${(e as Error).message}` });
    }
  });

  // ── Agent enable/disable ──

  app.post<{
    Body: { agent_id: string; enabled: boolean; overrideKillSwitch?: boolean };
  }>('/v1/agents/toggle', async (request, reply) => {
    const { agent_id, enabled, overrideKillSwitch } = request.body ?? {};
    if (!agent_id || typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'agent_id and enabled (boolean) are required' });
    }

    if (enabled) {
      // SCLI-110: only an explicit operator un-stop (overrideKillSwitch:true, sent
      // by the Hive Start control) may revive an operator-disabled agent. A plain
      // toggle-on without the flag respects the kill-switch and is refused, so
      // automation / fleet agents can't silently un-stop what the operator stopped.
      const result = await enableAndStartAgent(agent_id, { overrideKillSwitch: overrideKillSwitch === true });
      if (!result.ok) return reply.status(500).send({ error: result.error });
      setTimeout(() => chatBridge.broadcastAgentUpdate(agent_id), 1000);
      return { status: 'enabled', agent_id };
    } else {
      const result = disableAndStopAgent(agent_id);
      if (!result.ok) return reply.status(500).send({ error: result.error });
      chatBridge.broadcastAgentUpdate(agent_id);
      return { status: 'disabled', agent_id };
    }
  });

  // ── Agent restart ──

  registerAgentRestartRoute(app, {
    agents: config.agents,
    restartAgent,
    isAgentRunning,
    enableAndStartAgent,
    broadcastAgentUpdate: (agentId) => chatBridge.broadcastAgentUpdate(agentId),
  });

  app.post<{
    Params: { id: string };
  }>('/v1/agents/:id/restart-if-running', async (request, reply) => {
    const { id } = request.params;
    const agent = config.agents.find((candidate) => candidate.id === id || candidate.username === id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    if (!isAgentRunning(agent.id)) {
      return { status: 'not_running', agent_id: agent.id, restarted: false };
    }
    await restartAgent(agent.id);
    chatBridge.broadcastAgentUpdate(agent.id);
    await new Promise((r) => setTimeout(r, 3000));
    setTimeout(() => chatBridge.broadcastAgentUpdate(agent.id), 3000);
    return { status: 'restarted', agent_id: agent.id, restarted: true };
  });

  // ── Agent runtime session reset ──

  app.post<{
    Params: { id: string };
  }>('/v1/agents/:id/reset-session', async (request, reply) => {
    const resolved = resolveAgentByIdentifier(config.agents, request.params.id);
    if (!resolved) return reply.status(404).send({ error: 'Agent not found' });

    // k8s session lives on the PVC, not host ~/.shizuha/workspaces/<user>.
    // Wipe the pod sqlite (including wire-prefix) THEN SIGKILL-recycle so a
    // graceful stop cannot flush the poisoned transcript back.
    if (isK8sAgent(resolved)) {
      const reset = await resetK8sAgentRuntimeSession(resolved);
      if (!reset.ok) return reply.status(502).send({ error: reset.error ?? 'Failed to reset k8s runtime session' });
      chatBridge.broadcastAgentUpdate(resolved.id);
      setTimeout(() => chatBridge.broadcastAgentUpdate(resolved.id), 1000);
      setTimeout(() => chatBridge.broadcastAgentUpdate(resolved.id), 6000);
      return { status: 'session_reset', agent_id: resolved.id, plane: 'k8s-pvc', archived: reset.archived };
    }

    const wasRunning = isAgentRunning(resolved.id);
    if (wasRunning) {
      await restartAgent(resolved.id);
      chatBridge.broadcastAgentUpdate(resolved.id);
      const stopDeadline = Date.now() + 10_000;
      while (isAgentRunning(resolved.id) && Date.now() < stopDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const reset = resetAgentRuntimeSession(resolved.id);
    if (!reset.ok) return reply.status(400).send({ error: reset.error ?? 'Failed to reset runtime session' });

    if (wasRunning) {
      setTimeout(() => chatBridge.broadcastAgentUpdate(resolved.id), 1000);
      setTimeout(() => chatBridge.broadcastAgentUpdate(resolved.id), 6000);
    }

    return { status: 'session_reset', agent_id: resolved.id };
  });

  // ── GAP D: ACP Control Plane — pause/resume/kill-task ──

  // Pause an agent (stop processing inbox, keep container running)
  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>('/v1/agents/:id/pause', async (request, reply) => {
    const { id } = request.params;
    const agent = config.agents.find(a => a.id === id || a.username === id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    if (isK8sAgent(agent)) {
      const result = pauseK8sAgent(agent.id);
      if (!result.ok) return reply.status(500).send({ error: result.error ?? 'Failed to pause k8s agent' });
      chatBridge.broadcastAgentUpdate(agent.id);
      logger.info({ agentId: agent.id, reason: request.body?.reason }, 'K8s-native agent paused');
      return { ok: true, status: 'paused', agent_id: agent.id };
    }

    if (!isAgentRunning(agent.id)) return reply.status(400).send({ error: 'Agent is not running' });

    // Set paused state on the agent's gateway via WS command
    const agentWsUrl = getContainerUrl(agent.id);
    if (!agentWsUrl) return reply.status(503).send({ error: 'Agent has no port' });

    try {
      const ws = new WebSocket(agentWsUrl);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'control', action: 'pause', reason: request.body?.reason }));
          clearTimeout(timer);
          ws.close();
          resolve();
        });
        ws.on('error', (err: unknown) => { clearTimeout(timer); reject(err); });
      });
    } catch (err) {
      logger.warn({ agentId: agent.id, err: (err as Error).message }, 'Pause control send failed, still marking paused');
    }

    // Update persistent state
    updateAgentConfig(agent.id, { status: 'paused' } as any);
    chatBridge.broadcastAgentUpdate(agent.id);
    logger.info({ agentId: agent.id, reason: request.body?.reason }, 'Agent paused');
    return { ok: true, status: 'paused', agent_id: agent.id };
  });

  // Resume a paused agent
  app.post<{
    Params: { id: string };
  }>('/v1/agents/:id/resume', async (request, reply) => {
    const { id } = request.params;
    const agent = config.agents.find(a => a.id === id || a.username === id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const agentWsUrl = getContainerUrl(agent.id);
    if (agentWsUrl) {
      try {
        const ws = new WebSocket(agentWsUrl);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
          ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'control', action: 'resume' }));
            clearTimeout(timer);
            ws.close();
            resolve();
          });
          ws.on('error', (err: unknown) => { clearTimeout(timer); reject(err); });
        });
      } catch (err) {
        logger.warn({ agentId: agent.id, err: (err as Error).message }, 'Resume control send failed, will rely on restart');
      }
    }

    // Update persistent state, refresh per-agent broker sockets, and restart if needed.
    // Paused agents are excluded from the broker's active socket set; refresh after
    // marking active and before a cold resume so env-injected broker grants are live.
    updateAgentConfig(agent.id, { status: 'active' } as any);
    await refreshCredentialBrokerAgentSockets();
    if (!isAgentRunning(agent.id)) {
      await enableAndStartAgent(agent.id);
    }
    chatBridge.broadcastAgentUpdate(agent.id);
    logger.info({ agentId: agent.id }, 'Agent resumed');
    return { ok: true, status: 'resumed', agent_id: agent.id };
  });

  // Kill the current running task/turn
  app.post<{
    Params: { id: string };
  }>('/v1/agents/:id/kill-task', async (request, reply) => {
    const { id } = request.params;
    const agent = config.agents.find(a => a.id === id || a.username === id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    if (!isAgentRunning(agent.id)) return reply.status(400).send({ error: 'Agent is not running' });

    const agentWsUrl = getContainerUrl(agent.id);
    if (!agentWsUrl) return reply.status(503).send({ error: 'Agent has no port' });

    try {
      const ws = new WebSocket(agentWsUrl);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'cancel' }));
          clearTimeout(timer);
          ws.close();
          resolve();
        });
        ws.on('error', (err: unknown) => { clearTimeout(timer); reject(err); });
      });
      logger.info({ agentId: agent.id }, 'Kill-task sent to agent');
      return { ok: true, status: 'task_cancelled', agent_id: agent.id };
    } catch (err) {
      return reply.status(503).send({ error: `Failed to contact agent: ${(err as Error).message}` });
    }
  });

  // ── Agent config update (local agents handled directly, platform proxied) ──

  app.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>('/v1/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? {};

    // Map camelCase frontend keys to snake_case backend keys
    const keyMap: Record<string, string> = {
      executionMethod: 'execution_method',
      runtimeEnvironment: 'runtime_environment',
      resourceLimits: 'resource_limits',
      modelOverrides: 'model_overrides',
      modelFallbacks: 'model_fallbacks',
      personalityTraits: 'personality_traits',
      mcpServers: 'enabled_mcp_server_ids',
      contextPrompt: 'context_prompt',
      agentMemory: 'agent_memory',
      workSchedule: 'work_schedule',
      tokenBudget: 'token_budget',
      maxConcurrentTasks: 'max_concurrent_tasks',
      allowParallelExecution: 'allow_parallel_execution',
      warmPoolSize: 'warm_pool_size',
      failoverChainId: 'failover_chain_id',
      eagerSkills: 'eager_skills',
    };

    const mapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      mapped[keyMap[k] ?? k] = v;
    }

    // All agents are local — update directly
    const agent = config.agents.find((a) => a.id === id);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    // PLAT-394: reject invalid codex model entries before applying the update.
    // Invalid models → HTTP 400 from Codex backend → silent empty turns (root cause of PLAT-392).
    // kei #1: validate the CANONICAL mapped values (post-keyMap), NOT the raw camelCase body —
    // otherwise snake_case model_fallbacks/model_overrides/failover_chain_id are written into
    // `mapped` (and thus persisted by updateLocalAgentAtRuntime) but skip this guard entirely.
    // Only validate when the update actually changes a model/failover field, so an unrelated
    // edit isn't rejected because the persisted config is already invalid.
    const mappedFallbacks = mapped['model_fallbacks'] as Array<{ method: string; model: string }> | undefined;
    const mappedOverrides = mapped['model_overrides'] as Record<string, string> | undefined;
    if (mappedFallbacks !== undefined || mappedOverrides !== undefined) {
      const newFallbacks = mappedFallbacks ?? agent.modelFallbacks ?? [];
      const newOverrides = mappedOverrides ?? agent.modelOverrides ?? {};
      const modelErr = validateCodexModelChain(newFallbacks, newOverrides);
      if (modelErr) return reply.status(400).send({ error: modelErr });
    }
    // PLAT-394 P2: named failover chains bypass the inline guard above because they
    // are stored separately and resolved at runtime (resolveEffectiveChain gives named
    // chains priority). Validate the chain's Codex steps when a failover_chain_id is set
    // (read from `mapped` so the camelCase failoverChainId is resolved — kei #1).
    const mappedChainId = mapped['failover_chain_id'];
    if (mappedChainId !== undefined && mappedChainId !== null && mappedChainId !== '') {
      const namedChain = getFailoverChain(mappedChainId as string);
      if (namedChain) {
        const chainErr = validateCodexModelChain(namedChain.steps);
        if (chainErr) {
          return reply.status(400).send({ error: `Named chain "${mappedChainId}": ${chainErr}` });
        }
      }
    }

    const oldModelKey = JSON.stringify(agent.modelFallbacks) + JSON.stringify(agent.modelOverrides);
    const oldSkillsKey = JSON.stringify(agent.skills) + JSON.stringify(agent.eagerSkills ?? []);
    // HIVE-752 (Symptom 2): fail closed on fields the REST PATCH would silently
    // drop (e.g. `status`) rather than return 200 {ok:true} for a no-op body.
    const result = updateLocalAgentAtRuntime(id, mapped, undefined, { rejectUnappliedFields: true });
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }

    // Restart gateway if model OR skills config changed so the new system
    // prompt / starred-skill bodies take effect on the next turn. Skills feed
    // into buildBridgeIdentityPrompt + loadStarredSkills + installStarredSkillsForClaudeCode
    // — all evaluated at process start, so a restart is the only way to refresh.
    const newModelKey = JSON.stringify(agent.modelFallbacks) + JSON.stringify(agent.modelOverrides);
    const newSkillsKey = JSON.stringify(agent.skills) + JSON.stringify(agent.eagerSkills ?? []);
    if ((oldModelKey !== newModelKey || oldSkillsKey !== newSkillsKey) && agent.status !== 'disabled' && isAgentRunning(id)) {
      await restartAgent(id);
    }

    // Push field updates to platform via WS (local-first sync)
    for (const [key, value] of Object.entries(body)) {
      chatBridge.pushFieldUpdate(id, key, value);
    }

    chatBridge.broadcastAgentUpdate(id);
    return { ok: true, agent: { id: agent.id, name: agent.name, username: agent.username } };
  });

  // ── Create local agent ──

  app.post<{
    Body: {
      name: string;
      username: string;
      email?: string;
      role?: string;
      executionMethod?: string;
      skills?: string[];
      personalityTraits?: Record<string, string>;
      modelFallbacks?: Array<{ method: string; model: string }>;
    };
  }>('/v1/agents', async (request, reply) => {
    const body = request.body ?? {} as Record<string, unknown>;
    const { name, username } = body;

    if (!name || !username) {
      return reply.status(400).send({ error: 'name and username are required' });
    }

    // Validate username format
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(username)) {
      return reply.status(400).send({ error: 'Username must be lowercase, start with a letter, 2-31 chars (a-z, 0-9, _, -)' });
    }

    // Check uniqueness
    const existing = config.agents.find(
      (a) => a.username === username || a.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      return reply.status(409).send({ error: `Agent with username "${username}" or name "${name}" already exists` });
    }

    // PLAT-394: validate codex model chain on create.
    if (body.modelFallbacks) {
      const modelErr = validateCodexModelChain(body.modelFallbacks, undefined);
      if (modelErr) return reply.status(400).send({ error: modelErr });
    }

    const agent = createLocalAgentAtRuntime({
      name,
      username,
      email: body.email,
      role: body.role,
      executionMethod: body.executionMethod,
      skills: body.skills,
      personalityTraits: body.personalityTraits,
      modelFallbacks: body.modelFallbacks,
    });

    // createLocalAgentAtRuntime() pushes to discoveredAgents which may be the
    // same array reference as config.agents (shared from runDaemon). After any
    // deletion, the references diverge. Only push if not already present.
    if (!config.agents.some((a) => a.id === agent.id)) {
      config.agents.push(agent);
    }

    chatBridge.broadcastAgentsSnapshot();
    chatBridge.pushAgentCreated(agent);
    return { ok: true, agent };
  });

  // ── Delete local agent ──

  app.delete<{
    Params: { id: string };
  }>('/v1/agents/:id', async (request, reply) => {
    const { id } = request.params;

    const result = deleteLocalAgentAtRuntime(id);
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }

    revokeAgentGatewayTokens(id);

    // Remove from dashboard's config.agents
    const deletedAgent = config.agents.find((a) => a.id === id);
    config.agents = config.agents.filter((a) => a.id !== id);

    chatBridge.broadcastAgentsSnapshot();
    if (deletedAgent) chatBridge.pushAgentDeleted(id, deletedAgent.username);
    return { ok: true };
  });

  // ── Platform Sync — pending updates ──

  app.get('/v1/sync/pending', async () => {
    return { updates: chatBridge.getPendingUpdates() };
  });

  app.post<{ Body: { agent_id: string; field: string; action: 'accept' | 'reject' } }>(
    '/v1/sync/resolve', async (request) => {
      const { agent_id, field, action } = request.body ?? {};
      if (!agent_id || !field || !action) return { error: 'agent_id, field, action required' };
      if (action === 'accept') {
        return { ok: chatBridge.acceptPendingUpdate(agent_id, field) };
      } else {
        return { ok: chatBridge.rejectPendingUpdate(agent_id, field) };
      }
    },
  );

  // ── Skills discovery ──
  // Lists every SKILL.md found under ~/.shizuha/skills/, returning the
  // metadata needed by the dashboard skills picker. The frontmatter is the
  // single source of truth — descriptions and starredByDefault both come from
  // there. Bundled skills are visible because syncBundledSkills() symlinks
  // them into this directory at daemon startup.
  app.get('/v1/skills', async () => {
    const { readSkillFrontmatter } = await import('../skills/frontmatter.js');
    const home = process.env['HOME'] ?? '/root';
    const skillsDir = path.join(home, '.shizuha', 'skills');
    if (!fs.existsSync(skillsDir)) return { skills: [] };

    type SkillEntry = {
      name: string;
      description: string | null;
      starredByDefault: boolean;
      tags: string[];
      bundled: boolean;
    };
    const skills: SkillEntry[] = [];

    let entries: string[];
    try { entries = fs.readdirSync(skillsDir); } catch { return { skills: [] }; }

    for (const name of entries) {
      const skillPath = path.join(skillsDir, name);
      let isDir = false;
      try { isDir = fs.statSync(skillPath).isDirectory(); } catch { continue; }
      if (!isDir) continue;

      const skillMd = path.join(skillPath, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      const meta = readSkillFrontmatter(skillMd);
      if (!meta) continue;

      // "bundled" = carries the .shizuha-bundled marker dropped by syncBundledSkills()
      const bundled = fs.existsSync(path.join(skillPath, '.shizuha-bundled'));

      skills.push({
        name,
        description: meta.description,
        starredByDefault: meta.starred,
        tags: meta.tags,
        bundled,
      });
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return { skills };
  });

  // ── Failover Chain CRUD ──

  app.get('/v1/failover-chains', async () => {
    const { readFailoverChains } = await import('./state.js');
    return { chains: readFailoverChains() };
  });

  app.get<{ Params: { id: string } }>('/v1/failover-chains/:id', async (request, reply) => {
    const { getFailoverChain } = await import('./state.js');
    const chain = getFailoverChain(request.params.id);
    if (!chain) return reply.status(404).send({ error: 'Chain not found' });
    return { chain };
  });

  app.post<{
    Body: { id?: string; name: string; steps: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string; maxTokenRetries?: number }> };
  }>('/v1/failover-chains', async (request, reply) => {
    const { upsertFailoverChain } = await import('./state.js');
    const body = request.body ?? {} as Record<string, unknown>;
    if (!body.name || !body.steps?.length) {
      return reply.status(400).send({ error: 'name and steps[] are required' });
    }
    // Validate Codex models at chain-creation time — an invalid model stored here
    // would bypass the PATCH /v1/agents guard (named chains skip inline validation).
    const createChainErr = validateCodexModelChain(body.steps as Array<{ method: string; model: string }>);
    if (createChainErr) {
      return reply.status(400).send({ error: createChainErr });
    }
    const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const now = new Date().toISOString();
    const chain = { id, name: body.name, steps: body.steps, createdAt: now, updatedAt: now };
    upsertFailoverChain(chain);
    return { ok: true, chain };
  });

  app.put<{
    Params: { id: string };
    Body: { name?: string; steps?: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string; maxTokenRetries?: number }> };
  }>('/v1/failover-chains/:id', async (request, reply) => {
    const { getFailoverChain, upsertFailoverChain } = await import('./state.js');
    const existing = getFailoverChain(request.params.id);
    if (!existing) return reply.status(404).send({ error: 'Chain not found' });
    const body = request.body ?? {};
    if (body.name) existing.name = body.name;
    if (body.steps) {
      // Validate Codex models at chain-update time as well.
      const updateChainErr = validateCodexModelChain(body.steps as Array<{ method: string; model: string }>);
      if (updateChainErr) {
        return reply.status(400).send({ error: updateChainErr });
      }
      existing.steps = body.steps;
    }
    existing.updatedAt = new Date().toISOString();
    upsertFailoverChain(existing);
    return { ok: true, chain: existing };
  });

  app.delete<{ Params: { id: string } }>('/v1/failover-chains/:id', async (request, reply) => {
    const { deleteFailoverChain } = await import('./state.js');
    // Check if any agent uses this chain
    const usingAgents = config.agents.filter(a => a.failoverChainId === request.params.id);
    if (usingAgents.length > 0) {
      return reply.status(409).send({
        error: `Chain is used by ${usingAgents.length} agent(s): ${usingAgents.map(a => a.name).join(', ')}`,
      });
    }
    const deleted = deleteFailoverChain(request.params.id);
    if (!deleted) return reply.status(404).send({ error: 'Chain not found' });
    return { ok: true };
  });

  // ── Agent credential CRUD ──

  // List credentials (with masked data)
  app.get<{ Params: { id: string } }>('/v1/agents/:id/credentials', async (request, reply) => {
    const agent = config.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    return {
      credentials: (agent.credentials ?? []).map((c) => ({
        ...c,
        credentialData: Object.fromEntries(
          Object.entries(c.credentialData).map(([k, v]) => [k, v ? v.slice(0, 4) + '****' : ''])
        ),
      })),
    };
  });

  // Add credential
  app.post<{
    Params: { id: string };
  }>('/v1/agents/:id/credentials', async (request, reply) => {
    const agent = config.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    return reply.status(403).send({
      error: 'AgentCredential grants are broker-managed; use the credential broker grant socket',
    });
  });

  // Update credential (broker-managed; direct mutation disabled)
  app.patch<{
    Params: { id: string; credId: string };
  }>('/v1/agents/:id/credentials/:credId', async (request, reply) => {
    const agent = config.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const cred = agent.credentials?.find((c) => c.id === request.params.credId);
    if (!cred) return reply.status(404).send({ error: 'Credential not found' });

    return reply.status(403).send({
      error: 'AgentCredential grants are broker-managed; use the credential broker revoke/grant path',
    });
  });

  // Delete credential (broker-managed; direct mutation disabled)
  app.delete<{
    Params: { id: string; credId: string };
  }>('/v1/agents/:id/credentials/:credId', async (request, reply) => {
    const agent = config.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const cred = agent.credentials?.find((c) => c.id === request.params.credId);
    if (!cred) return reply.status(404).send({ error: 'Credential not found' });

    return reply.status(403).send({
      error: 'AgentCredential grants are broker-managed; use the credential broker revoke path',
    });
  });

  // ── Daemon status ──

  app.get('/v1/status', async () => {
    const state = readDaemonState();
    const runners: Array<Record<string, unknown>> = [];

    return {
      daemon: state ? {
        pid: state.pid,
        startedAt: state.startedAt,
        platformUrl: state.platformUrl,
        agentCount: state.agents.length,
        agents: state.agents,
      } : null,
      daemonLink: config.daemonLinkStatus?.() ?? null,
      runners,
    };
  });

  // ── Settings / Runtime info ──

  app.get('/v1/settings', async () => {
    const state = readDaemonState();
    const auth = getShizuhaAuthStatus();
    const creds = readCredentials();
    const runners: Array<Record<string, unknown>> = [];

    return {
      // Identity
      identity: {
        loggedIn: auth.loggedIn,
        username: auth.username,
        accessTokenExpiresAt: auth.accessTokenExpiresAt,
        refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
      },

      // Daemon
      daemon: state ? {
        pid: state.pid,
        startedAt: state.startedAt,
        platformUrl: state.platformUrl,
        agentCount: state.agents.length,
        dockerAvailable: isDockerAvailable(),
        dindMode: resolveDindMode(),
      } : null,
      daemonLink: config.daemonLinkStatus?.() ?? null,

      // Auto skill-sync (keeps the fleet's skills current from upstream)
      skillSync: { enabled: isAutoSkillSyncEnabled() },

      // Connected runners
      runners,

      // Configured providers (keys masked)
      providers: {
        anthropic: {
          configured: !!(creds.anthropic?.tokens?.length),
          tokens: (creds.anthropic?.tokens ?? []).map((t) => ({
            label: t.label,
            prefix: t.token.slice(0, 12) + '...',
            addedAt: t.addedAt,
            active: t.active !== false, // default true
            cooldownUntil: t.cooldownUntil,
            lastRateLimitAt: t.lastRateLimitAt,
          })),
        },
        openai: {
          configured: !!creds.openai?.apiKey,
          keyPrefix: creds.openai?.apiKey ? creds.openai.apiKey.slice(0, 10) + '...' : null,
        },
        google: {
          configured: !!creds.google?.apiKey,
          keyPrefix: creds.google?.apiKey ? creds.google.apiKey.slice(0, 10) + '...' : null,
        },
        codex: {
          configured: !!(creds.codex?.accounts?.length),
          accounts: (creds.codex?.accounts ?? []).map((a) => ({
            email: a.email,
            accountId: a.accountId,
            addedAt: a.addedAt,
            lastRefresh: a.lastRefresh ?? null,
          })),
        },
        copilot: {
          configured: !!creds.copilot?.githubToken,
          tokenPrefix: creds.copilot?.githubToken ? creds.copilot.githubToken.slice(0, 10) + '...' : null,
          label: creds.copilot?.label ?? null,
          addedAt: creds.copilot?.addedAt ?? null,
        },
      },

      // Agents with full status
      agents: config.agents.map((a) => {
        const agentState = state?.agents.find((s) => s.agentId === a.id);
        return {
          id: a.id,
          name: a.name,
          username: a.username,
          email: a.email,
          role: a.role,
          env: a.env ?? {},
          executionMethod: a.executionMethod,
          runtimeEnvironment: a.runtimeEnvironment ?? 'bare_metal',
          resourceLimits: a.resourceLimits ?? {},
          modelOverrides: a.modelOverrides,
          modelFallbacks: a.modelFallbacks,
          skills: a.skills,
          personalityTraits: a.personalityTraits,
          mcpServers: (a.mcpServers || []).map((s) => ({ name: s.name, slug: s.slug })),
          effectiveCapabilities: a.effectiveCapabilities ?? null,
          status: agentState?.status ?? 'unknown',
          enabled: agentState?.enabled ?? false,
          pid: agentState?.pid,
          error: agentState?.error,
          startedAt: agentState?.startedAt,
          tokenPrefix: agentState?.tokenPrefix,
          oauthTokenLabel: agentState?.oauthTokenLabel,
          // Platform-aligned fields
          credentials: (a.credentials ?? []).map((c) => ({
            ...c,
            credentialData: Object.fromEntries(
              Object.entries(c.credentialData).map(([k, v]) => [k, v ? v.slice(0, 4) + '****' : ''])
            ),
          })),
          agentMemory: a.agentMemory,
          workSchedule: a.workSchedule,
          tokenBudget: a.tokenBudget,
          maxConcurrentTasks: a.maxConcurrentTasks ?? 1,
          allowParallelExecution: a.allowParallelExecution ?? false,
          warmPoolSize: a.warmPoolSize ?? 0,
          tier: a.tier ?? 'normal',
          contextPrompt: a.contextPrompt,
          // Recent MCP tool failures (last hour, capped at 25). Operator
          // visibility: lets you spot "Connect MCP failing for 3 agents"
          // without depending on agents to self-report.
          recentToolErrors: getRecentToolErrors(a.id),
        };
      }),

      // Runtime — including Claude Code version read from a live agent container
      runtime: await (async () => {
        const runningAgents = config.agents.filter((a) => isAgentRunning(a.id));
        const candidateContainers = runningAgents.map((a) => `shizuha-agent-${a.username}`);
        const claudeCode = await detectClaudeCodeVersionFromContainer(candidateContainers);
        return {
          version: '0.1.0',
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().rss,
          claudeCodeVersion: claudeCode.version,
          claudeCodeVersionSource: claudeCode.source,
        };
      })(),
    };
  });

  // ── Toggle auto skill-sync (persisted to ~/.shizuha/settings.json) ──
  app.post<{ Body: { enabled?: boolean } }>('/v1/settings/skill-sync', async (request, reply) => {
    const enabled = request.body?.enabled;
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'body must be { enabled: boolean }' });
    }
    try {
      const settingsPath = path.join(process.env['HOME'] ?? '/root', '.shizuha', 'settings.json');
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* new file */ }
      settings.autoSkillSync = enabled;
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`[daemon] auto skill-sync ${enabled ? 'enabled' : 'disabled'} via dashboard`);
      return { ok: true, skillSync: { enabled } };
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Available models ──

  app.get('/v1/models', async () => {
    const models = new Map<string, DashboardModelInfo>();
    for (const model of STATIC_DASHBOARD_MODELS) {
      models.set(model.slug, model);
    }

    const vllmBaseUrls = collectProviderBaseUrls(config.agents, 'vllm', 'VLLM_BASE_URL');
    if (vllmBaseUrls.length > 0) {
      const discovered = await Promise.all(vllmBaseUrls.map((url) => (
        discoverOpenAICompatibleModels(url, 'vllm', process.env['VLLM_API_KEY'] ?? readProviderConfigValue('vllm', 'apiKey'))
      )));
      for (const modelList of discovered) {
        for (const model of modelList) {
          models.set(model.slug, model);
        }
      }
    }

    const cortexBaseUrls = collectProviderBaseUrls(config.agents, 'cortex', 'CORTEX_BASE_URL');
    const cortexDiscoveryUrls = cortexBaseUrls.length > 0 ? cortexBaseUrls : [DEFAULT_CORTEX_BASE_URL];
    const discovered = await Promise.all(cortexDiscoveryUrls.map((url) => (
      discoverOpenAICompatibleModels(url, 'cortex', resolveCortexAuthToken())
    )));
    for (const modelList of discovered) {
      for (const model of modelList) {
        models.set(model.slug, model);
      }
    }

    const providers = [...STATIC_DASHBOARD_PROVIDERS];
    if ([...models.values()].some((model) => model.provider === 'vllm')) {
      providers.push('vllm');
    }

    return {
      models: [...models.values()],
      providers,
    };
  });

  // ── Fan-out settings ──
  // In daemon mode, fan-out is handled by the platform's Redis channel layer.
  // These endpoints store preferences that can be read by the Settings UI.
  const fanOutSettings: Record<ChannelType, boolean> = { ...DEFAULT_FAN_OUT };

  app.get('/v1/fan-out', async () => {
    return { fanOut: fanOutSettings };
  });

  app.post<{ Body: { channelType: string; enabled: boolean } }>(
    '/v1/fan-out',
    async (request, reply) => {
      const { channelType, enabled } = request.body ?? {};
      if (!channelType || typeof enabled !== 'boolean') {
        return reply.status(400).send({ error: 'channelType and enabled (boolean) are required' });
      }
      if (channelType in fanOutSettings) {
        fanOutSettings[channelType as ChannelType] = enabled;
      }
      return { ok: true, fanOut: fanOutSettings };
    },
  );

  // ── Authentication ──

  app.post<{ Body: { username: string; password: string; platformUrl?: string } }>('/v1/auth/login', async (request, reply) => {
    const { username, password, platformUrl } = request.body ?? {};
    if (!username || !password) {
      return reply.status(400).send({ error: 'Username and password are required' });
    }
    try {
      const result = await loginToShizuhaId(username, password, platformUrl || undefined);
      // Sync daemon state so resolveBackendUrl() picks it up immediately.
      if (platformUrl) setPlatformUrl(platformUrl.replace(/\/+$/, ''));
      return { ok: true, username: result.username };
    } catch (err) {
      return reply.status(401).send({ error: (err as Error).message });
    }
  });

  app.post('/v1/auth/logout', async () => {
    clearShizuhaAuth();
    return { ok: true };
  });

  // ── Unified Backend (single source of truth) ──
  //
  // Replaces the split "Account Linking" + "Backend URL" UI. One concept:
  // *what URL does the runtime point at*. When it's the daemon's own host →
  // local mode (mini-Connect serves chat, no Pulse/Wiki/KA). When it's a
  // real shizuha-connect/-id stack → remote mode + identity.
  //
  // GET returns the current backend; POST sets it (with optional sign-in for
  // remote URLs); DELETE reverts to local. All authenticated by dashboard
  // session cookie — these are operator controls, not agent-facing.
  function isLocalUrl(url: string): boolean {
    if (!url) return true;
    const lower = url.toLowerCase();
    return lower === 'http://localhost'
      || lower.includes('127.0.0.1')
      || lower.startsWith(`http://${require('node:os').hostname().toLowerCase()}`)
      || lower.startsWith(`https://${require('node:os').hostname().toLowerCase()}`);
  }
  function describeBackend() {
    const platformUrl = resolvePlatformUrl();
    const idStatus = getShizuhaAuthStatus();
    const local = !platformUrl || platformUrl === 'http://localhost' || isLocalUrl(platformUrl);
    return {
      url: platformUrl || `http://${require('node:os').hostname()}:${config.port}`,
      mode: local ? 'local' : 'remote',
      linked: idStatus.loggedIn,
      identity: idStatus.loggedIn ? {
        username: idStatus.username,
        accessTokenExpiresAt: idStatus.accessTokenExpiresAt,
        refreshTokenExpiresAt: idStatus.refreshTokenExpiresAt,
      } : null,
    };
  }

  app.get('/v1/backend', async (request, reply) => {
    const sessionToken = extractSessionToken(request.headers.cookie);
    if (!sessionToken || !validateSession(sessionToken).valid) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    return reply.send(describeBackend());
  });

  app.post<{ Body: { url?: string; username?: string; password?: string } }>('/v1/backend', async (request, reply) => {
    const sessionToken = extractSessionToken(request.headers.cookie);
    if (!sessionToken || !validateSession(sessionToken).valid) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    const url = (request.body?.url ?? '').trim().replace(/\/+$/, '');
    const username = (request.body?.username ?? '').trim();
    const password = (request.body?.password ?? '').trim();
    if (!url) return reply.status(400).send({ error: 'url is required' });

    if (isLocalUrl(url)) {
      // Switching to local mode — tear down any existing platform link.
      clearShizuhaAuth();
      setPlatformUrl('');
      return reply.send(describeBackend());
    }

    // Remote URL — must sign in.
    if (!username || !password) {
      return reply.status(400).send({ error: 'username and password are required for remote backends' });
    }
    try {
      await loginToShizuhaId(username, password, url);
      setPlatformUrl(url);
      return reply.send(describeBackend());
    } catch (err) {
      return reply.status(401).send({ error: (err as Error).message });
    }
  });

  app.delete('/v1/backend', async (request, reply) => {
    const sessionToken = extractSessionToken(request.headers.cookie);
    if (!sessionToken || !validateSession(sessionToken).valid) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    clearShizuhaAuth();
    setPlatformUrl('');
    return reply.send(describeBackend());
  });

  // ── Local Pulse (task management) ──
  const { LocalPulseStore } = await import('../pulse/local-store.js');
  const localPulseDbPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'pulse-local.db');
  let _pulseStore: InstanceType<typeof LocalPulseStore> | null = null;
  function pulse() {
    if (!_pulseStore) _pulseStore = new LocalPulseStore(localPulseDbPath);
    return _pulseStore;
  }

  // List tasks (with filters)
  app.get<{ Querystring: Record<string, string> }>('/v1/local-pulse/tasks', async (request) => {
    const { status, assignee, project, priority, limit, include_completed } = request.query;
    return {
      tasks: pulse().listTasks({
        status, assignee, project, priority,
        limit: limit ? parseInt(limit) : 50,
        include_completed: include_completed === 'true',
      }),
    };
  });

  // Get single task
  app.get<{ Params: { id: string } }>('/v1/local-pulse/tasks/:id', async (request) => {
    const task = pulse().getTask(request.params.id);
    if (!task) return { error: 'Not found' };
    const comments = pulse().listComments(task.id);
    return { task, comments };
  });

  // Create task
  app.post<{ Body: Record<string, unknown> }>('/v1/local-pulse/tasks', async (request) => {
    const body = request.body ?? {};
    if (!body.title) return { error: 'title required' };
    // If workflow is specified, auto-set workflow_status to initial_status
    let workflowStatus = body.workflow_status as string | undefined;
    if (body.workflow && !workflowStatus) {
      const wf = workflowStore.getWorkflow(body.workflow as string);
      if (wf) workflowStatus = wf.initial_status;
    }
    const task = pulse().createTask({
      title: body.title as string,
      description: body.description as string | undefined,
      project: body.project as string | undefined,
      status: body.status as string | undefined,
      priority: body.priority as string | undefined,
      assignee: body.assignee as string | undefined,
      created_by: body.created_by as string | undefined,
      labels: body.labels as string[] | undefined,
      due_date: body.due_date as string | undefined,
      schedule: body.schedule as string | undefined,
      workflow: body.workflow as string | undefined,
      workflow_status: workflowStatus,
    });

    // Auto-fire any 'auto' transitions from the initial status
    if (task.workflow && task.workflow_status) {
      const wf = workflowStore.getWorkflow(task.workflow);
      if (wf) {
        const autoTrans = wf.transitions.filter(
          (t: any) => t.from === task.workflow_status && t.trigger === 'auto',
        );
        if (autoTrans.length === 1) {
          pulse().transitionTask(task.id, autoTrans[0]!.to, 'auto', 'system', {
            getWorkflow: workflowStore.getWorkflow,
            validateTransition: workflowStore.validateTransition as any,
            executeTransitionActions: workflowStore.executeTransitionActions,
          });
        }
      }
    }

    // Refetch to get the auto-transitioned state
    const finalTask = pulse().getTask(task.id) ?? task;
    return { task: finalTask };
  });

  // Update task
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/v1/local-pulse/tasks/:id', async (request) => {
    const task = pulse().updateTask(request.params.id, request.body ?? {});
    if (!task) return { error: 'Not found' };
    return { task };
  });

  // Delete task
  app.delete<{ Params: { id: string } }>('/v1/local-pulse/tasks/:id', async (request) => {
    const ok = pulse().deleteTask(request.params.id);
    return { ok };
  });

  // Complete task
  app.post<{ Params: { id: string } }>('/v1/local-pulse/tasks/:id/complete', async (request) => {
    const task = pulse().completeTask(request.params.id);
    if (!task) return { error: 'Not found' };
    return { task };
  });

  // Cancel recurring task
  app.post<{ Params: { id: string } }>('/v1/local-pulse/tasks/:id/cancel-recurring', async (request) => {
    const task = pulse().cancelRecurring(request.params.id);
    if (!task) return { error: 'Not found' };
    return { task };
  });

  // Fire alert
  app.post<{ Body: Record<string, unknown> }>('/v1/local-pulse/alerts', async (request) => {
    const body = request.body ?? {};
    if (!body.title) return { error: 'title required' };
    const alert = pulse().fireAlert({
      title: body.title as string,
      description: body.description as string | undefined,
      item_type: body.item_type as string | undefined,
      severity: body.severity as string | undefined,
      assignee: body.assignee as string | undefined,
      source: body.source as string | undefined,
      source_id: body.source_id as string | undefined,
      source_url: body.source_url as string | undefined,
      payload: body.payload as Record<string, unknown> | undefined,
      labels: body.labels as string[] | undefined,
      project: body.project as string | undefined,
      created_by: body.created_by as string | undefined,
    });
    return { alert };
  });

  // Acknowledge alert
  app.post<{ Params: { id: string }; Body: { by?: string } }>('/v1/local-pulse/tasks/:id/acknowledge', async (request) => {
    const alert = pulse().acknowledgeAlert(request.params.id, request.body?.by);
    if (!alert) return { error: 'Alert not found' };
    return { alert };
  });

  // Resolve alert
  app.post<{ Params: { id: string }; Body: { by?: string } }>('/v1/local-pulse/tasks/:id/resolve', async (request) => {
    const alert = pulse().resolveAlert(request.params.id, request.body?.by);
    if (!alert) return { error: 'Alert not found' };
    return { alert };
  });

  // Silence alert
  app.post<{ Params: { id: string } }>('/v1/local-pulse/tasks/:id/silence', async (request) => {
    const alert = pulse().silenceAlert(request.params.id);
    if (!alert) return { error: 'Alert not found' };
    return { alert };
  });

  // Sync local task to platform Pulse (one-way push)
  app.post<{ Params: { id: string } }>('/v1/local-pulse/tasks/:id/sync-to-platform', async (request, reply) => {
    const task = pulse().getTask(request.params.id);
    if (!task) return reply.status(404).send({ error: 'Task not found' });

    const token = await getPulseServiceToken();
    if (!token) return reply.status(401).send({ error: 'Operator not logged in to shizuha-id' });
    const body: Record<string, unknown> = {
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      source: 'agent-runtime',
      source_id: task.id,
    };
    if (task.assignee) {
      body.assignee_email = task.assignee.includes('@') ? task.assignee : `${task.assignee}@agents.shizuha.io`;
    }

    try {
      const resp = await fetch(`${PULSE_INTERNAL_URL}/api/tasks/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        // Mark as synced in local store
        pulse().markSynced(task.id, String(data.id ?? ''), String(data.item_key ?? ''));
        return { ok: true, remote_id: data.id, remote_key: data.item_key };
      }
      const errData = await resp.json().catch(() => ({})) as Record<string, unknown>;
      return reply.status(resp.status).send({ error: errData.detail || `Platform returned ${resp.status}` });
    } catch (err) {
      return reply.status(502).send({ error: `Sync failed: ${(err as Error).message}` });
    }
  });

  // Sync ALL local tasks to platform
  app.post('/v1/local-pulse/sync-all-to-platform', async (_request, reply) => {
    const tasks = pulse().listTasks({ limit: 200 });
    const token = await getPulseServiceToken();
    if (!token) return reply.status(401).send({ error: 'Operator not logged in to shizuha-id' });
    let synced = 0;
    let failed = 0;

    for (const task of tasks) {
      if (task.remote_id) { synced++; continue; } // Already synced
      const body: Record<string, unknown> = {
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
        source: 'agent-runtime',
        source_id: task.id,
      };
      if (task.assignee) {
        body.assignee_email = task.assignee.includes('@') ? task.assignee : `${task.assignee}@agents.shizuha.io`;
      }
      try {
        const resp = await fetch(`${PULSE_INTERNAL_URL}/api/tasks/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          const data = await resp.json() as Record<string, unknown>;
          pulse().markSynced(task.id, String(data.id ?? ''), String(data.item_key ?? ''));
          synced++;
        } else { failed++; }
      } catch { failed++; }
    }
    return { ok: true, synced, failed, total: tasks.length };
  });

  // Get firing alerts
  app.get<{ Querystring: { assignee?: string } }>('/v1/local-pulse/alerts', async (request) => {
    return { alerts: pulse().getFiringAlerts(request.query.assignee) };
  });

  // Add comment
  app.post<{ Params: { id: string }; Body: { content: string; author?: string } }>('/v1/local-pulse/tasks/:id/comments', async (request) => {
    const { content, author } = request.body ?? {};
    if (!content) return { error: 'content required' };
    const comment = pulse().addComment(request.params.id, author ?? 'dashboard', content);
    if (!comment) return { error: 'Task not found' };
    return { comment };
  });

  // List comments
  app.get<{ Params: { id: string } }>('/v1/local-pulse/tasks/:id/comments', async (request) => {
    return { comments: pulse().listComments(request.params.id) };
  });

  // Search tasks
  app.get<{ Querystring: { q: string; limit?: string } }>('/v1/local-pulse/search', async (request) => {
    return { tasks: pulse().searchTasks(request.query.q, parseInt(request.query.limit ?? '20')) };
  });

  // Stats
  app.get('/v1/local-pulse/stats', async () => {
    return pulse().getStatistics();
  });

  // Projects
  app.get('/v1/local-pulse/projects', async () => {
    return { projects: pulse().listProjects() };
  });

  app.post<{ Body: Record<string, unknown> }>('/v1/local-pulse/projects', async (request) => {
    const body = request.body ?? {};
    if (!body.name || !body.key) return { error: 'name and key required' };
    try {
      const project = pulse().createProject({
        name: body.name as string,
        key: body.key as string,
        description: body.description as string | undefined,
        default_assignee: body.default_assignee as string | undefined,
      });
      return { project };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });

  // ── Workflow endpoints ──
  const workflowStore = await import('../workflows/store.js');

  // ── Action endpoints (standalone agent proposals — not workflow transitions) ──

  app.get<{ Querystring: { assignee?: string } }>('/v1/local-pulse/actions', async (request) => {
    return { actions: pulse().getPendingActions(request.query.assignee) };
  });

  app.post<{ Params: { id: string }; Body: { by?: string } }>(
    '/v1/local-pulse/actions/:id/approve', async (request) => {
      const { by } = request.body ?? {};
      const action = pulse().approveAction(request.params.id, by ?? 'dashboard');
      if (!action) return { error: 'Action not found or already resolved' };
      return { action };
    },
  );

  app.post<{ Params: { id: string }; Body: { by?: string; reason?: string } }>(
    '/v1/local-pulse/actions/:id/reject', async (request) => {
      const { by, reason } = request.body ?? {};
      const action = pulse().rejectAction(request.params.id, by ?? 'dashboard', reason);
      if (!action) return { error: 'Action not found or already resolved' };
      return { action };
    },
  );

  app.get('/v1/local-pulse/workflows', async () => {
    return { workflows: workflowStore.listWorkflows() };
  });

  app.get<{ Params: { name: string } }>('/v1/local-pulse/workflows/:name', async (request) => {
    const wf = workflowStore.getWorkflow(request.params.name);
    if (!wf) return { error: 'Not found' };
    return { workflow: wf };
  });

  app.post<{ Body: Record<string, unknown> }>('/v1/local-pulse/workflows', async (request) => {
    const body = request.body ?? {};
    if (!body.name || !body.statuses || !body.initial_status || !body.transitions) {
      return { error: 'name, statuses, initial_status, and transitions required' };
    }
    const result = workflowStore.createWorkflow(body as any);
    if (!result.ok) return { error: result.error };
    return { ok: true, workflow: workflowStore.getWorkflow(body.name as string) };
  });

  app.delete<{ Params: { name: string } }>('/v1/local-pulse/workflows/:name', async (request) => {
    const result = workflowStore.deleteWorkflow(request.params.name);
    return result;
  });

  // Transition a task through its workflow
  app.post<{ Params: { id: string }; Body: { to: string; actor_type?: string; actor?: string; comment?: string } }>(
    '/v1/local-pulse/tasks/:id/transition', async (request) => {
      const { to, actor_type, actor, comment } = request.body ?? {};
      if (!to) return { error: 'target status (to) required' };
      const result = pulse().transitionTask(
        request.params.id,
        to,
        (actor_type as 'human' | 'agent' | 'auto') ?? 'human',
        actor,
        {
          getWorkflow: workflowStore.getWorkflow,
          validateTransition: workflowStore.validateTransition as any,
          executeTransitionActions: workflowStore.executeTransitionActions,
        },
      );
      if (!result.ok) return { error: result.error };
      // Add explicit comment if provided alongside transition
      if (comment && result.task) {
        pulse().addComment(result.task.id, actor ?? 'system', comment);
      }

      // Auto-fire any 'auto' transitions from the new status
      let finalTask = result.task;
      if (finalTask?.workflow && finalTask?.workflow_status) {
        const wf = workflowStore.getWorkflow(finalTask.workflow);
        if (wf) {
          const autoTrans = wf.transitions.filter(
            (t: any) => t.from === finalTask!.workflow_status && t.trigger === 'auto',
          );
          if (autoTrans.length === 1) {
            const autoResult = pulse().transitionTask(finalTask.id, autoTrans[0]!.to, 'auto', 'system', {
              getWorkflow: workflowStore.getWorkflow,
              validateTransition: workflowStore.validateTransition as any,
              executeTransitionActions: workflowStore.executeTransitionActions,
            });
            if (autoResult.ok && autoResult.task) finalTask = autoResult.task;
          }
        }
      }

      return { task: finalTask, comment: result.comment };
    },
  );

  // ── Pulse Proxy — forwards requests to platform Pulse API ──
  // Used by pulse-sync.ts to push/pull tasks and workflows to/from the platform.
  // Generates a service JWT signed with the shared secret (same as Pulse's SECRET_KEY).

  // Resolve Pulse URL: try env, then Docker container IP, then localhost
  let PULSE_INTERNAL_URL = process.env['PULSE_INTERNAL_URL'] || '';
  if (!PULSE_INTERNAL_URL) {
    try {
      // Try to resolve Docker container IP (daemon runs on host, not in Docker)
      const { execSync } = await import('node:child_process');
      const ip = execSync("docker inspect shizuha-pulse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null", { timeout: 3000 }).toString().trim();
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        PULSE_INTERNAL_URL = `http://${ip}:8002`;
      }
    } catch { /* Docker not available or container not running */ }
    if (!PULSE_INTERNAL_URL) PULSE_INTERNAL_URL = 'http://shizuha-pulse:8002';
  }
  // The Pulse proxy forwards the dashboard browser's requests to platform
  // Pulse on behalf of the logged-in operator (Hritik). We use his stored
  // shizuha-id JWT — no shared-secret forging, no synthetic "system" user.
  async function getPulseServiceToken(): Promise<string | null> {
    try {
      return await getValidShizuhaAccessToken();
    } catch {
      return null;
    }
  }

  // Generic proxy: forwards any /v1/pulse-proxy/* request to PULSE_INTERNAL_URL/api/*
  app.all<{ Params: { '*': string } }>('/v1/pulse-proxy/*', async (request, reply) => {
    const subPath = (request.params as any)['*'] || '';
    const qs = request.url.includes('?') ? '?' + request.url.split('?')[1] : '';
    const targetUrl = `${PULSE_INTERNAL_URL}/api/${subPath}${qs}`;
    const token = await getPulseServiceToken();
    if (!token) return reply.status(401).send({ error: 'Operator not logged in to shizuha-id' });

    try {
      const fetchOpts: RequestInit = {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15_000),
      };
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
        fetchOpts.body = JSON.stringify(request.body);
      }

      const resp = await fetch(targetUrl, fetchOpts);
      const contentType = resp.headers.get('content-type') || '';

      reply.status(resp.status);
      if (contentType.includes('json')) {
        const data = await resp.json();
        return reply.send(data);
      } else {
        const text = await resp.text();
        return reply.send(text);
      }
    } catch (err) {
      return reply.status(502).send({ error: `Pulse proxy error: ${(err as Error).message}` });
    }
  });

  // ── Platform service proxy for mobile apps ──
  // Mobile/Kotlin apps request /{service}/api/* which matches nginx routing on
  // the SaaS platform. In local runtime mode, proxy to Docker containers.
  // Daemon runs on host (not in Docker), so resolve container IPs via docker inspect.
  const SERVICE_PORTS: Record<string, number> = {
    pulse: 8002, admin: 8003, wiki: 8013, notes: 8005,
    drive: 8006, finance: 8007, hr: 8008, inventory: 8009,
    mail: 8010, books: 8004, time: 8011, connect: 8012,
    agora: 8014, id: 8001, agent: 8017,
  };
  const serviceIpCache = new Map<string, string>();
  function resolveServiceUrl(service: string): string | null {
    const cached = serviceIpCache.get(service);
    if (cached) return cached;
    // Special case: pulse already resolved
    if (service === 'pulse' && PULSE_INTERNAL_URL) {
      serviceIpCache.set(service, PULSE_INTERNAL_URL);
      return PULSE_INTERNAL_URL;
    }
    try {
      const containerName = `shizuha-${service}`;
      const ip = require('node:child_process').execSync(
        `docker inspect ${containerName} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null`,
        { timeout: 3000 },
      ).toString().trim();
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        const url = `http://${ip}:${SERVICE_PORTS[service] ?? 8000}`;
        serviceIpCache.set(service, url);
        return url;
      }
    } catch { /* container not running */ }
    return null;
  }
  for (const service of Object.keys(SERVICE_PORTS)) {
    app.all<{ Params: { '*': string } }>(`/${service}/api/*`, async (request, reply) => {
      const baseUrl = resolveServiceUrl(service);
      if (!baseUrl) return reply.status(503).send({ error: `Service ${service} not available` });
      const subPath = (request.params as any)['*'] || '';
      const qs = request.url.includes('?') ? '?' + request.url.split('?')[1] : '';
      const targetUrl = `${baseUrl}/api/${subPath}${qs}`;
      const authHeader = request.headers['authorization'] as string | undefined;
      try {
        // Set Host header to the Docker service name — Django's ALLOWED_HOSTS
        // expects the container hostname, not the client's Host header.
        const serviceHost = `shizuha-${service}`;
        const fetchOpts: RequestInit = {
          method: request.method,
          headers: {
            'Host': serviceHost,
            'Content-Type': request.headers['content-type'] as string || 'application/json',
            ...(authHeader ? { 'Authorization': authHeader } : {}),
            ...(request.headers['x-organization-id'] ? { 'X-Organization-ID': request.headers['x-organization-id'] as string } : {}),
          },
          signal: AbortSignal.timeout(15_000),
        };
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
          fetchOpts.body = JSON.stringify(request.body);
        }
        const resp = await fetch(targetUrl, fetchOpts);
        reply.status(resp.status);
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('json')) return reply.send(await resp.json());
        return reply.send(await resp.text());
      } catch (err) {
        return reply.status(502).send({ error: `Service proxy (${service}): ${(err as Error).message}` });
      }
    });
  }

  // ── Provider credential management ──

  // Anthropic: add token
  app.post<{ Body: { token: string; label?: string } }>('/v1/providers/anthropic/tokens', async (request, reply) => {
    const { token, label } = request.body ?? {};
    if (!token || typeof token !== 'string' || token.length < 10) {
      return reply.status(400).send({ error: 'Valid token is required (min 10 chars)' });
    }
    addAnthropicToken(token, label);
    return { ok: true, label: label ?? `token_${(readCredentials().anthropic?.tokens?.length ?? 1)}` };
  });

  // Anthropic: remove token by label
  app.delete<{ Params: { label: string } }>('/v1/providers/anthropic/tokens/:label', async (request, reply) => {
    const { label } = request.params;
    const removed = removeAnthropicToken(label);
    if (!removed) return reply.status(404).send({ error: `Token with label "${label}" not found` });
    return { ok: true };
  });

  // Anthropic: toggle token active state
  app.patch<{ Params: { label: string }; Body: { active: boolean } }>('/v1/providers/anthropic/tokens/:label', async (request, reply) => {
    const { label } = request.params;
    const { active } = request.body ?? {};
    if (typeof active !== 'boolean') {
      return reply.status(400).send({ error: '"active" boolean is required' });
    }
    const result = toggleAnthropicTokenActive(label, active);
    if (result === null) return reply.status(404).send({ error: `Token with label "${label}" not found` });
    return { ok: true, active: result };
  });

  // PLAT-810: a bridge's rate-limit/invalid report cools the token in the DAEMON
  // host pool (credentials.json) — but agents actually source their model token
  // from the HIVE COORDINATOR pool via the broker UDS, and that pool was NEVER
  // told the token is exhausted. So the coordinator kept serving the dead token
  // forever and auto-rotation to the next active token (e.g. cl2) never happened
  // — every spawn re-picked the exhausted token and crash-looped until an
  // operator manually cooled the coordinator entry (2026-06-24 ichi incident).
  // FIX: when a coordinator is configured, ALSO cool the matching coordinator
  // entry so the broker serves the next active token automatically. Best-effort
  // (host-pool cooldown is unaffected if this fails); never throws.
  const coolCoordinatorTokenByLabel = async (label: string, cooldownSeconds: number): Promise<boolean> => {
    const coordUrl = process.env['MCP_AUTH_PROXY_COORDINATOR_URL'];
    if (!coordUrl) return false; // host-pool-only mode (headless dev) — nothing to do
    const base = coordUrl.replace(/\/model-token\/?$/, '');
    let token = process.env['MCP_AUTH_PROXY_COORDINATOR_TOKEN'] || '';
    if (!token) {
      const tokenFile = process.env['MCP_AUTH_PROXY_COORDINATOR_TOKEN_FILE']
        || `${process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''}/.shizuha/mcp-auth-proxy/coordinator-token.txt`;
      try { token = require('node:fs').readFileSync(tokenFile, 'utf-8').trim(); } catch { return false; }
    }
    if (!token) return false;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    try {
      const listRes = await fetch(`${base}/token-entries`, { headers, signal: AbortSignal.timeout(6000) });
      if (!listRes.ok) return false;
      const data: any = await listRes.json();
      const entries: any[] = Array.isArray(data) ? data : (data.entries || data.results || data.token_entries || []);
      const match = entries.find((e: any) => e.label === label && (!e.provider || e.provider === 'anthropic'));
      const id = match?.id || match?.entry_id;
      if (!id) return false;
      const patchRes = await fetch(`${base}/token-entries/${id}`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ cooldown_seconds: Math.max(60, Math.round(cooldownSeconds)) }),
        signal: AbortSignal.timeout(6000),
      });
      return patchRes.ok;
    } catch { return false; }
  };

  // Anthropic: a bridge reports its token hit a quota/rate limit (SCLI-73).
  // Containers mount credentials.json READ-ONLY, so this daemon-side write is
  // the only way a bridge's rate-limit observation reaches the host pool that
  // manager.ts picks from. Stamps cooldownUntil + lastRateLimitAt; the
  // reporting bridge then exits and its restart picks the next active token.
  app.post<{ Params: { label: string }; Body: { retryAfterSeconds?: number; source?: string } }>(
    '/v1/providers/anthropic/tokens/:label/report-rate-limit', async (request, reply) => {
    const { label } = request.params;
    const { retryAfterSeconds, source } = request.body ?? {};
    const ok = reportTokenRateLimited(label, retryAfterSeconds);
    // PLAT-810: cool the coordinator pool too (the pool the broker actually serves).
    const coordCooled = await coolCoordinatorTokenByLabel(label, retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds : 60 * 60);
    // Succeed if EITHER pool was cooled — a coordinator-only token (e.g. oat-1,
    // not in the host pool) previously 404'd here and was never cooled anywhere.
    if (!ok && !coordCooled) return reply.status(404).send({ error: `Token with label "${label}" not found in host or coordinator pool` });
    const next = getActiveClaudeToken(label);
    console.log(`[daemon] Token "${label}" reported rate-limited by ${source ?? 'unknown'} — host-pool cooled=${ok}, coordinator cooled=${coordCooled}; next host pick: "${next?.label ?? '(pool empty)'}"`);
    return { ok: true, hostCooled: ok, coordinatorCooled: coordCooled, nextToken: next?.label ?? null };
  });

  // Anthropic: a bridge reports its token is auth-invalid (401 — bad key or
  // permanently revoked). Distinct from report-rate-limit (429): marks the
  // token active=false so the picker never selects it again on container
  // restart. Requires operator to re-enable via the dashboard toggle.
  // HIVE-122: prevents the daemon from re-injecting the same dead token after
  // a 401 auth failure, which was the root cause of the 6h fleet park.
  app.post<{ Params: { label: string }; Body: { source?: string } }>(
    '/v1/providers/anthropic/tokens/:label/report-invalid', async (request, reply) => {
    const { label } = request.params;
    const { source } = request.body ?? {};
    const ok = reportTokenInvalid(label);
    // PLAT-810: an invalid token is worse than rate-limited — cool it long in the
    // coordinator pool (7d) so the broker stops serving it until an operator
    // re-enables it. (The coordinator API exposes cooldown, not active=false.)
    const coordCooled = await coolCoordinatorTokenByLabel(label, 7 * 24 * 60 * 60);
    if (!ok && !coordCooled) return reply.status(404).send({ error: `Token with label "${label}" not found in host or coordinator pool` });
    const next = getActiveClaudeToken(label);
    console.log(`[daemon] Token "${label}" reported auth-invalid by ${source ?? 'unknown'} — host active=false=${ok}, coordinator cooled=${coordCooled}; next host pick: "${next?.label ?? '(pool empty)'}"`);
    return { ok: true, hostMarked: ok, coordinatorCooled: coordCooled, nextToken: next?.label ?? null };
  });

  // Anthropic: clear a token's cooldown (operator override — e.g. "I know the
  // limit reset, put this back in rotation"). The next agent spawn will pick
  // it again per the normal LRU rules.
  app.post<{ Params: { label: string } }>('/v1/providers/anthropic/tokens/:label/clear-cooldown', async (request, reply) => {
    const { label } = request.params;
    const cleared = clearTokenCooldown(label);
    if (!cleared) return reply.status(404).send({ error: `Token with label "${label}" not found` });
    return { ok: true };
  });

  // OpenAI: set API key
  app.put<{ Body: { apiKey: string } }>('/v1/providers/openai', async (request, reply) => {
    const { apiKey } = request.body ?? {};
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
      return reply.status(400).send({ error: 'Valid API key is required' });
    }
    setOpenAIKey(apiKey);
    return { ok: true };
  });

  // Google: set API key
  app.put<{ Body: { apiKey: string } }>('/v1/providers/google', async (request, reply) => {
    const { apiKey } = request.body ?? {};
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
      return reply.status(400).send({ error: 'Valid API key is required' });
    }
    setGoogleKey(apiKey);
    return { ok: true };
  });

  // Remove entire provider
  app.delete<{ Params: { provider: string } }>('/v1/providers/:provider', async (request, reply) => {
    const { provider } = request.params;
    if (!['anthropic', 'openai', 'google'].includes(provider)) {
      return reply.status(400).send({ error: 'Invalid provider. Use: anthropic, openai, google' });
    }
    const removed = removeProvider(provider as 'anthropic' | 'openai' | 'google');
    if (!removed) return reply.status(404).send({ error: `Provider "${provider}" not configured` });
    return { ok: true };
  });

  // Codex: add account
  app.post<{ Body: { email: string; accessToken: string; refreshToken: string; accountId: string } }>(
    '/v1/providers/codex/accounts',
    async (request, reply) => {
      const { email, accessToken, refreshToken, accountId } = request.body ?? {};
      if (!email || !accessToken || !refreshToken || !accountId) {
        return reply.status(400).send({ error: 'email, accessToken, refreshToken, and accountId are required' });
      }
      saveCodexAccount({ email, accessToken, refreshToken, accountId, addedAt: new Date().toISOString() });
      return { ok: true };
    },
  );

  // Codex: remove account by email
  app.delete<{ Params: { email: string } }>('/v1/providers/codex/accounts/:email', async (request, reply) => {
    const { email } = request.params;
    const removed = removeCodexAccount(decodeURIComponent(email));
    if (!removed) return reply.status(404).send({ error: `Codex account "${email}" not found` });
    return { ok: true };
  });

  // Codex: refresh tokens for an account
  app.put<{ Body: { email: string; accessToken: string; refreshToken?: string } }>(
    '/v1/providers/codex/accounts/refresh',
    async (request, reply) => {
      const { email, accessToken, refreshToken } = request.body ?? {};
      if (!email || !accessToken) {
        return reply.status(400).send({ error: 'email and accessToken are required' });
      }
      updateCodexTokens(email, accessToken, refreshToken);
      return { ok: true };
    },
  );

  // Codex: reorder accounts (determines pool rotation priority)
  app.post<{ Body: { emails: string[] } }>(
    '/v1/providers/codex/accounts/reorder',
    async (request, reply) => {
      const { emails } = request.body ?? {};
      if (!Array.isArray(emails) || emails.length === 0) {
        return reply.status(400).send({ error: 'emails array is required' });
      }
      const ok = reorderCodexAccounts(emails);
      if (!ok) return reply.status(400).send({ error: 'Invalid email list — must contain exactly the same accounts' });
      return { ok: true };
    },
  );

  // Codex: test account credentials
  app.post<{ Body: { email: string } }>(
    '/v1/providers/codex/accounts/test',
    async (request, reply) => {
      const { email } = request.body ?? {};
      if (!email) return reply.status(400).send({ error: 'email is required' });

      const accounts = readCodexAccounts();
      const account = accounts.find((a) => a.email === email);
      if (!account) return reply.status(404).send({ error: `Account "${email}" not found` });

      // Step 1: Try refreshing the token
      const REFRESH_URL = 'https://auth.openai.com/oauth/token';
      const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

      let accessToken = account.accessToken;
      let refreshOk = false;

      if (account.refreshToken) {
        try {
          const refreshResp = await fetch(REFRESH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: CLIENT_ID,
              grant_type: 'refresh_token',
              refresh_token: account.refreshToken,
              scope: 'openid profile email',
            }),
          });
          if (refreshResp.ok) {
            const data = await refreshResp.json() as Record<string, unknown>;
            const newAccess = data.access_token as string;
            const newRefresh = data.refresh_token as string | undefined;
            if (newAccess) {
              accessToken = newAccess;
              refreshOk = true;
              updateCodexTokens(email, newAccess, newRefresh);
            }
          } else {
            const errText = await refreshResp.text().catch(() => '');
            return reply.send({
              ok: false,
              status: 'token_refresh_failed',
              error: `Token refresh failed (${refreshResp.status}): ${errText.slice(0, 200)}`,
            });
          }
        } catch (e) {
          return reply.send({
            ok: false,
            status: 'token_refresh_error',
            error: `Token refresh error: ${(e as Error).message}`,
          });
        }
      }

      // Step 2: Try a minimal Codex API call (use gpt-5-codex-mini for cheapest test)
      const CODEX_BASE_URL = process.env['CODEX_BASE_URL'] ?? 'https://chatgpt.com/backend-api/codex';
      try {
        const apiResp = await fetch(`${CODEX_BASE_URL}/responses`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...(account.accountId ? { 'ChatGPT-Account-ID': account.accountId } : {}),
          },
          body: JSON.stringify({
            model: 'gpt-5-codex-mini',
            instructions: 'Reply with just "ok".',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'test' }] }],
            store: false,
            stream: true,
          }),
        });

        if (apiResp.ok) {
          // Streaming response — just abort the body, we only needed the 200
          try { apiResp.body?.cancel(); } catch { /* ignore */ }
          return reply.send({
            ok: true,
            status: 'working',
            refreshed: refreshOk,
            message: `Account ${email} is working`,
          });
        } else {
          const errText = await apiResp.text().catch(() => '');
          const is429 = apiResp.status === 429;
          return reply.send({
            ok: is429 ? true : false,
            status: is429 ? 'rate_limited' : 'api_error',
            refreshed: refreshOk,
            error: `API ${apiResp.status}: ${errText.slice(0, 200)}`,
            message: is429
              ? `Account ${email} credentials valid but rate-limited`
              : refreshOk
                ? `Account ${email} token refresh OK but API returned ${apiResp.status}`
                : `API error (${apiResp.status})`,
          });
        }
      } catch (e) {
        // If token refresh succeeded, that's still a positive signal
        if (refreshOk) {
          return reply.send({
            ok: true,
            status: 'refresh_ok',
            refreshed: true,
            message: `Account ${email} token refresh OK (API unreachable: ${(e as Error).message})`,
          });
        }
        return reply.send({
          ok: false,
          status: 'api_unreachable',
          refreshed: refreshOk,
          error: `API error: ${(e as Error).message}`,
        });
      }
    },
  );

  // HIVE-586: legacy daemon endpoint backed by a stateless Hive coordinator
  // lease. The host never reads or refreshes Codex credentials itself.
  // Auth: localhost + Docker bridge bypass (same-machine read-only endpoint).
  app.get<{ Querystring: { email?: string } }>('/v1/codex/token', async (request, reply) => {
    const token = await getCodexBrokerToken(request.query?.email);
    if (!token) {
      return reply.status(503).send({ error: 'Codex token unavailable from Hive coordinator' });
    }
    return { accessToken: token };
  });

  // Codex: device auth — start flow
  const deviceAuthSessions = new Map<string, {
    status: 'pending' | 'complete' | 'error';
    userCode?: string;
    verificationUrl?: string;
    email?: string;
    error?: string;
  }>();

  app.post('/v1/providers/codex/device-auth/start', async (_request, reply) => {
    const sessionId = crypto.randomUUID();
    deviceAuthSessions.set(sessionId, { status: 'pending' });

    // Run device auth flow in background
    codexDeviceAuth({
      onUserCode: (code, url) => {
        const session = deviceAuthSessions.get(sessionId);
        if (session) {
          session.userCode = code;
          session.verificationUrl = url;
        }
      },
      onPolling: () => { /* no-op */ },
      onSuccess: (email) => {
        const session = deviceAuthSessions.get(sessionId);
        if (session) {
          session.status = 'complete';
          session.email = email;
        }
        // Clean up after 5 minutes
        setTimeout(() => deviceAuthSessions.delete(sessionId), 5 * 60 * 1000);
      },
      onError: (error) => {
        const session = deviceAuthSessions.get(sessionId);
        if (session) {
          session.status = 'error';
          session.error = error;
        }
        setTimeout(() => deviceAuthSessions.delete(sessionId), 5 * 60 * 1000);
      },
    }).catch((err) => {
      const session = deviceAuthSessions.get(sessionId);
      if (session) {
        session.status = 'error';
        session.error = (err as Error).message;
      }
    });

    // Wait briefly for the user code to be available (step 1 is fast)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const session = deviceAuthSessions.get(sessionId);
      if (session?.userCode || session?.status === 'error') break;
    }

    const session = deviceAuthSessions.get(sessionId);
    if (session?.status === 'error') {
      return reply.status(500).send({ error: session.error });
    }

    return {
      sessionId,
      userCode: session?.userCode,
      verificationUrl: session?.verificationUrl,
    };
  });

  // Codex: device auth — poll for completion
  app.get<{ Params: { sessionId: string } }>(
    '/v1/providers/codex/device-auth/poll/:sessionId',
    async (request, reply) => {
      const session = deviceAuthSessions.get(request.params.sessionId);
      if (!session) return reply.status(404).send({ error: 'Session not found or expired' });

      return {
        status: session.status,
        email: session.email,
        error: session.error,
      };
    },
  );

  // ── GitHub Copilot provider management ──

  // Copilot: set GitHub PAT
  app.put<{ Body: { githubToken: string; label?: string } }>('/v1/providers/copilot', async (request, reply) => {
    const { githubToken, label } = request.body ?? {};
    if (!githubToken || typeof githubToken !== 'string' || githubToken.length < 10) {
      return reply.status(400).send({ error: 'Valid GitHub token is required (min 10 chars)' });
    }
    setCopilotToken(githubToken, label);
    return { ok: true };
  });

  // Copilot: remove
  app.delete('/v1/providers/copilot', async (_request, reply) => {
    const removed = removeCopilotToken();
    if (!removed) return reply.status(404).send({ error: 'Copilot not configured' });
    return { ok: true };
  });

  // Copilot: test connection (exchanges GitHub PAT for Copilot token)
  app.post('/v1/providers/copilot/test', async (_request, reply) => {
    const creds = readCredentials();
    const token = creds.copilot?.githubToken;
    if (!token) return reply.status(404).send({ error: 'Copilot not configured' });

    try {
      const { CopilotProvider } = await import('../provider/copilot.js');
      const provider = new CopilotProvider(token);
      const result = await provider.testConnection();
      if (result.ok) {
        return {
          ok: true,
          status: 'working',
          message: 'GitHub Copilot connection successful',
          expiresAt: result.expiresAt ? new Date(result.expiresAt).toISOString() : undefined,
        };
      } else {
        return reply.send({
          ok: false,
          status: 'auth_failed',
          error: result.error,
        });
      }
    } catch (e) {
      return reply.send({
        ok: false,
        status: 'error',
        error: (e as Error).message,
      });
    }
  });

  // ── Audio endpoints (Talk Mode: STT + TTS) ──

  // STT: Transcribe audio → text via Whisper API
  app.post('/v1/audio/transcribe', async (request, reply) => {
    const token = extractSessionToken(request.headers.cookie);
    if (!token || !validateSession(token).valid) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    try {
      // Get audio from multipart form data
      const parts = request.parts();
      let audioBuffer: Buffer | null = null;
      let language = 'en';

      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'audio') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          audioBuffer = Buffer.concat(chunks);
        } else if (part.type === 'field' && part.fieldname === 'language') {
          language = String(part.value) || 'en';
        }
      }

      if (!audioBuffer || audioBuffer.length < 100) {
        return reply.status(400).send({ error: 'No audio data received' });
      }

      // Call Whisper API
      const apiKey = process.env['OPENAI_API_KEY'] || process.env['EMBEDDING_API_KEY'];
      if (!apiKey) {
        // Try Codex OAuth (unlikely to work, but try)
        return reply.status(503).send({ error: 'No OpenAI API key configured for speech-to-text. Set OPENAI_API_KEY.' });
      }

      const FormData = (await import('node:buffer')).Blob ? globalThis.FormData : null;
      if (!FormData) {
        return reply.status(503).send({ error: 'FormData not available in this Node.js version' });
      }

      const formData = new FormData();
      const audioBytes = new Uint8Array(audioBuffer.byteLength);
      audioBytes.set(audioBuffer);
      formData.append('file', new Blob([audioBytes.buffer], { type: 'audio/webm' }), 'recording.webm');
      formData.append('model', 'whisper-1');
      formData.append('language', language);
      formData.append('response_format', 'json');

      const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData,
      });

      if (!whisperResp.ok) {
        const errText = await whisperResp.text().catch(() => '');
        return reply.status(502).send({ error: `Whisper API error ${whisperResp.status}: ${errText.slice(0, 200)}` });
      }

      const result = await whisperResp.json() as { text: string };
      return { text: result.text || '' };
    } catch (err) {
      return reply.status(500).send({ error: `Transcription failed: ${(err as Error).message}` });
    }
  });

  // TTS: Synthesize text → audio via OpenAI TTS
  app.post<{ Body: { text: string; voice?: string } }>('/v1/audio/synthesize', async (request, reply) => {
    const token = extractSessionToken(request.headers.cookie);
    if (!token || !validateSession(token).valid) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const { text, voice = 'nova' } = request.body ?? {};
    if (!text || typeof text !== 'string') {
      return reply.status(400).send({ error: 'text is required' });
    }

    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      return reply.status(503).send({ error: 'No OpenAI API key for TTS. Set OPENAI_API_KEY.' });
    }

    try {
      const ttsResp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text.slice(0, 4096),
          voice,
          response_format: 'opus',
        }),
      });

      if (!ttsResp.ok) {
        const errText = await ttsResp.text().catch(() => '');
        return reply.status(502).send({ error: `TTS API error ${ttsResp.status}: ${errText.slice(0, 200)}` });
      }

      const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
      reply.header('Content-Type', 'audio/ogg');
      reply.header('Content-Length', audioBuffer.length);
      return reply.send(audioBuffer);
    } catch (err) {
      return reply.status(500).send({ error: `TTS failed: ${(err as Error).message}` });
    }
  });

  // ── Webhook endpoints (external triggers) ──

  const { registerWebhookRoutes } = await import('./webhooks.js');

  // Generate a default webhook token if not set (persisted in credentials)
  const creds = readCredentials();
  let webhookToken = (creds as any).webhookToken as string | undefined;
  if (!webhookToken) {
    webhookToken = crypto.randomBytes(32).toString('hex');
    (creds as any).webhookToken = webhookToken;
    writeCredentials(creds);
    console.log(`[daemon] Generated webhook token: ${webhookToken.slice(0, 8)}...`);
  }

  registerWebhookRoutes(app, {
    getAgents: () => config.agents.map(a => {
      const state = readDaemonState();
      const agentState = state?.agents.find(s => s.agentId === a.id);
      return { id: a.id, name: a.name, username: a.username, status: agentState?.status ?? 'unknown' };
    }),
    sendToAgent: async (agentId: string, message: string, source: string) => {
      const agent = config.agents.find(a => a.id === agentId || a.username === agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);
      if (!isAgentRunning(agent.id)) throw new Error(`Agent ${agent.name} is not running`);
      const agentWsUrl = getContainerUrl(agent.id);
      if (!agentWsUrl) throw new Error(`Agent ${agent.name} has no port`);

      if (shouldLogGatewayIngress(agent)) {
        logger.info({
          agentId: agent.id,
          agentName: agent.name,
          agentUsername: agent.username,
          executionMethod: primaryExecutionMethod(agent),
          pathway: 'webhook',
          source,
          contentPreview: previewContent(message),
          contentLength: message.length,
        }, 'Gateway ingress message');
      }

      const runId = crypto.randomUUID();
      // Fire and forget — send via local WS, don't wait for response
      const ws = new WebSocket(agentWsUrl);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'message',
          content: `[Webhook: ${source}] ${message}`,
          agent_id: agent.id,
        }));
        // Close after sending — agent processes asynchronously
        setTimeout(() => ws.close(), 2000);
      });
      ws.on('error', () => ws.close());
      return runId;
    },
    getToken: () => webhookToken!,
    isAgentAllowed: (agentId: string, allowedIds: string[]) => {
      if (allowedIds.includes('*')) return true;
      return allowedIds.includes(agentId) ||
        allowedIds.includes(config.agents.find(a => a.id === agentId)?.username ?? '');
    },
  }, { token: webhookToken });

  // ── Start server ──

  await app.listen({ port: config.port, host: config.host });

  // ── PLAT-479: Agent health exporter (port 9888) ──
  // Serves per-agent health metrics consumed by the Pulse org-health sweep
  // (shizuha-tasks/tasks/views.py _scrape_agent_health via PULSE_HEALTH_EXPORTER_URL).
  {
    const { startAgentHealthServer, buildAgentHealth } = await import('../metrics/health-server.js');
    startAgentHealthServer(() => {
      // PLAT-587 AC4/AC5: derive `enabled` from enabled-agents.json read FRESH on
      // every scrape (the authoritative source of truth), not from the cached
      // daemon.json `enabled` flag — so a daemon toggle propagates to Pulse routing
      // within one gather cycle and there is no stale-cache split-brain.
      const state = readDaemonState();
      const enabledIds = readEnabledAgents();
      const runningIds = new Set(
        (state?.agents ?? []).filter((s) => s.status === 'running').map((s) => s.agentId),
      );
      // PLAT-962: expose capacity-limited agents (PLAT-879 token-pool backoff) to Prometheus
      const capacityUnavailableIds = new Set(
        config.agents.filter((a) => isAgentInTokenPoolBackoff(a.id)).map((a) => a.id),
      );
      return buildAgentHealth(config.agents, enabledIds, runningIds, capacityUnavailableIds);
    });
  }

  // ── Attach WebSocket server for browser chat ──

  const httpServer = app.server;
  const wss = new WebSocketServer({ noServer: true });


  httpServer.on('upgrade', (request: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
    const remoteIp = (request.socket as any).remoteAddress || '';
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    // Mini-Connect WS: /connect/ws/connect/{user,agent}/ — same protocol the
    // real platform speaks. Authenticated via JWT on the query string. When
    // the daemon is linked to a remote platform, this transparently proxies
    // to the upstream Connect (browser stays on dashboard origin).
    if (handleMiniConnectUpgrade(request, socket, head, wss, {
      store: miniConnectStore,
      auth: miniConnectAuth,
      channelLayer: miniConnectChannelLayer,
      getUpstream: resolveMiniConnectUpstream,
    })) {
      return;
    }

    if (url.pathname === '/ws/chat' || url.pathname === '/ws/chat/') {
      // Authenticate: session cookie OR device token (query param or Bearer header)
      let authenticated = false;
      let authMethod: BrowserClient['authMethod'];

      // Check session cookie (dashboard web UI)
      const cookie = request.headers.cookie;
      const sessionToken = extractSessionToken(cookie);
      if (sessionToken && validateSession(sessionToken).valid) {
        authenticated = true;
        authMethod = 'session-cookie';
      }

      // Check device token in query string (?token=...)
      if (!authenticated) {
        const queryToken = url.searchParams.get('token');
        if (queryToken) {
          const hash = hashToken(queryToken);
          if (findDeviceByTokenHash(hash)) {
            authenticated = true;
            authMethod = 'device-token-query';
          }
        }
      }

      // Check Bearer token header
      if (!authenticated) {
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          const hash = hashToken(authHeader.slice(7));
          if (findDeviceByTokenHash(hash)) {
            authenticated = true;
            authMethod = 'device-token-bearer';
          }
        }
      }

      // Localhost bypass
      if (!authenticated) {
        if (!isTrustedDashboardBridgeRequest(request.headers, remoteIp) && isDashboardLocalhostIp(remoteIp)) {
          authenticated = true;
          authMethod = 'localhost-bypass';
        }
      }

      if (!authenticated) {
        logger.warn({ remoteIp, hasCookie: !!cookie, sessionToken: sessionToken?.substring(0, 10), url: request.url }, 'WS auth rejected');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        const clientId = crypto.randomUUID();
        // Extract username from session cookie for identity injection
        const sessionToken = extractSessionToken(request.headers.cookie);
        const session = sessionToken ? validateSession(sessionToken) : { valid: false };
        const username = session.valid ? session.username : undefined;
        // Read platform user ID from stored auth (set during /login to shizuha-id)
        const platformUserId = readShizuhaAuth()?.userId;
        chatBridge.addClient(clientId, ws, { username, platformUserId, remoteIp, authMethod });
      });
    } else {
      socket.destroy();
    }
  });

  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  if (config.tls) {
    // Primary port is HTTPS (with native wss:// support)
    console.log(`Dashboard: https://${host}:${config.port}`);
    // Secondary HTTP on port+1 — proxies to the main HTTPS Fastify server
    // so users who can't accept self-signed certs still get a working dashboard.
    try {
      const http2 = await import('node:http');
      const httpPort = config.port + 1;
      const httpFallback = http2.createServer((clientReq, clientRes) => {
        const proxyReq = (require('node:https') as typeof import('node:https')).request({
          hostname: dashboardProxyTargetHost(config.host),
          port: config.port,
          path: clientReq.url,
          method: clientReq.method,
          headers: clientReq.headers,
          rejectUnauthorized: false,
        }, (proxyRes) => {
          clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
          proxyRes.pipe(clientRes);
        });
        clientReq.pipe(proxyReq);
        proxyReq.on('error', () => { try { clientRes.writeHead(502); clientRes.end(); } catch {} });
      });
      // Forward WebSocket upgrades from HTTP fallback → HTTPS primary
      httpFallback.on('upgrade', (clientReq: import('http').IncomingMessage, clientSocket: import('stream').Duplex, clientHead: Buffer) => {
        const proxySocket = net.connect(config.port, dashboardProxyTargetHost(config.host), () => {
          // Reconstruct the raw HTTP upgrade request to forward to the HTTPS server.
          // Use TLS since primary is HTTPS.
          const tls = require('node:tls') as typeof import('node:tls');
          const tlsSocket = tls.connect({ socket: proxySocket, rejectUnauthorized: false }, () => {
            const headers = Object.entries(clientReq.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
            tlsSocket.write(`${clientReq.method} ${clientReq.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
            if (clientHead.length) tlsSocket.write(clientHead);
            tlsSocket.pipe(clientSocket);
            clientSocket.pipe(tlsSocket);
          });
          tlsSocket.on('error', () => clientSocket.destroy());
        });
        proxySocket.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => proxySocket.destroy());
      });
      httpFallback.listen(httpPort, config.host);
      httpFallback.unref();
      console.log(`Dashboard: http://${host}:${httpPort}`);
    } catch { /* non-critical */ }
  } else {
    console.log(`Dashboard: http://${host}:${config.port}`);
  }
}
