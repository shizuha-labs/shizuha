/**
 * Daemon dashboard — HTTP server serving the web UI + agent management API.
 *
 * Started by `shizuha up` to provide a unified dashboard at http://localhost:8015
 * where users can see all their agents, chat with them, and monitor status.
 *
 * Chat uses WebSocket: browser ↔ dashboard ↔ platform /ws/chat/.
 * Same pattern as the mobile apps (ori-expo, kotlin).
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
// @ts-ignore
import WebSocket, { WebSocketServer } from 'ws';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { PlatformClient } from './platform-client.js';
import { readDaemonState, updateAgentConfig } from './state.js';
import { getShizuhaAuthStatus, loginToShizuhaId, clearShizuhaAuth } from '../config/shizuhaAuth.js';
import {
  readCredentials,
  writeCredentials,
  readCodexAccounts,
  addAnthropicToken,
  removeAnthropicToken,
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
import {
  enableAndStartAgent,
  disableAndStopAgent,
  restartAgent,
  resetAgentRuntimeSession,
  isAgentRunning,
  getLocalAgentPort,
  createLocalAgentAtRuntime,
  deleteLocalAgentAtRuntime,
  updateLocalAgentAtRuntime,
  isDockerAvailable,
  resolveDindMode,
  setAgentStateChangeListener,
} from './manager.js';
import {
  ensureDashboardCredentials,
  login as dashboardLogin,
  logout as dashboardLogout,
  validateSession,
  changePassword,
  isDefaultPassword,
  extractSessionToken,
} from './dashboard-auth.js';
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
import { generatePairingCode, formatCode, generateDeviceToken, hashToken, CODE_TTL_MS } from '../devices/pairing.js';
import { addPendingCode, consumePendingCode, addDevice, findDeviceByTokenHash, updateLastSeen, listDevices, removeDevice, generateDeviceId } from '../devices/store.js';
import { checkRateLimit, recordFailure, resetFailures } from '../devices/rateLimit.js';
import type { ChannelType } from '../gateway/types.js';
import { EventLog, isDurableEvent, type ReplayedEvent } from './event-log.js';
import { sendJsonOverSocket } from './ws-send.js';

interface DashboardConfig {
  port: number;
  host: string;
  platformUrl: string;
  accessToken: string;
  agents: AgentInfo[];
  /** TLS cert + key PEM strings. If provided, dashboard serves HTTPS. */
  tls?: { cert: string; key: string };
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
  /** Source IP captured during WS upgrade. */
  remoteIp?: string;
  /** How the client authenticated during WS upgrade. */
  authMethod?: 'session-cookie' | 'device-token-query' | 'device-token-bearer' | 'localhost-bypass';
  /** Last time the client proved app-level liveness via ping/pong or any WS message. */
  lastHeartbeatAt: number;
  heartbeatTimer: NodeJS.Timeout | null;
}

function resolveAgentGatewayScope(method: string, url: string): AgentGatewayScope | null {
  if (method === 'GET' && url === '/v1/agents') return 'agents:list';
  if (method === 'POST' && url.startsWith('/v1/agents/') && url.endsWith('/ask')) return 'agents:message';
  if (method === 'POST' && url.startsWith('/v1/agents/') && (
    url.endsWith('/pause')
    || url.endsWith('/resume')
    || url.endsWith('/kill-task')
  )) {
    return 'agents:control';
  }
  return null;
}

function resolveAgentByIdentifier(agents: AgentInfo[], identifier: string | undefined): AgentInfo | null {
  if (!identifier) return null;
  return agents.find((agent) => agent.id === identifier || agent.username === identifier) ?? null;
}

function primaryExecutionMethod(agent: AgentInfo | undefined): string {
  return agent?.modelFallbacks?.[0]?.method ?? agent?.executionMethod ?? 'shizuha';
}

function shouldLogGatewayIngress(agent: AgentInfo | undefined): boolean {
  return primaryExecutionMethod(agent) === 'shizuha';
}

function previewContent(content: unknown, max = 180): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Serialize an AgentInfo to the JSON shape the frontend expects. */
function serializeAgent(a: AgentInfo): Record<string, unknown> {
  const state = readDaemonState();
  const agentState = state?.agents.find((s) => s.agentId === a.id);
  return {
    id: a.id,
    name: a.name,
    username: a.username,
    email: a.email,
    role: a.role,
    executionMethod: a.executionMethod,
    runtimeEnvironment: a.runtimeEnvironment ?? 'bare_metal',
    resourceLimits: a.resourceLimits ?? {},
    modelOverrides: a.modelOverrides,
    modelFallbacks: a.modelFallbacks,
    skills: a.skills,
    personalityTraits: a.personalityTraits,
    mcpServers: (a.mcpServers || []).map((s) => ({ name: s.name, slug: s.slug })),
    status: agentState?.status ?? 'unknown',
    enabled: agentState?.enabled ?? false,
    pid: agentState?.pid,
    error: agentState?.error,
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
  };
}

class ChatbotBridge {
  private static readonly BROWSER_HEARTBEAT_INTERVAL_MS = 25_000;
  private static readonly BROWSER_HEARTBEAT_TIMEOUT_MS = 60_000;
  private platformWs: WebSocket | null = null;
  private connected = false;
  private url: string | null;
  private clients = new Map<string, BrowserClient>();
  /** agent_id → Set of clientIds subscribed to this agent */
  private agentSubscribers = new Map<string, Set<string>>();
  /** Local agent WS connections: agentId → WebSocket to local gateway */
  private localAgentWs = new Map<string, WebSocket>();
  /** Pending reconnect timers so one close cannot fan out into many reconnects */
  private localAgentReconnectTimers = new Map<string, NodeJS.Timeout>();
  /** Last connection status per scope so repeated identical status events are suppressed */
  private lastStatusByScope = new Map<string, boolean>();
  private agents: AgentInfo[];
  /** Pending device auth: clientId → { sessionId, pendingMessage } */
  private pendingDeviceAuth = new Map<string, { sessionId: string; agentId: string; content: unknown }>();
  /** Append-only event log for message reliability (Kafka-style cursors) */
  private eventLog: EventLog;
  /** Last user message per agent — used to replay after inline auth */
  private lastUserMessage = new Map<string, unknown>();

  constructor(platformUrl: string, accessToken: string, agents: AgentInfo[], eventLog: EventLog) {
    this.agents = agents;
    this.eventLog = eventLog;
    if (accessToken) {
      const wsBase = platformUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
      this.url = `${wsBase}/agent/ws/chat/?token=${encodeURIComponent(accessToken)}`;
    } else {
      this.url = null; // Local mode — no platform connection
    }
  }

  connect(): void {
    if (this.platformWs || !this.url) return;

    this.platformWs = new WebSocket(this.url);

    this.platformWs.on('open', () => {
      this.connected = true;
      logger.info('Dashboard chatbot WS connected to platform');
      this.emitTransportStatus(true);
    });

    this.platformWs.on('message', (data: Buffer) => {
      try {
        this.routeFromUpstream(JSON.parse(data.toString()));
      } catch { /* ignore malformed */ }
    });

    this.platformWs.on('close', () => {
      this.connected = false;
      this.platformWs = null;
      this.emitTransportStatus(false);
      if (this.url) {
        setTimeout(() => this.connect(), 3000);
      }
    });

    this.platformWs.on('error', (err: Error) => {
      logger.error({ err }, 'Dashboard chatbot WS error');
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

    const timer = setTimeout(() => {
      if (this.localAgentReconnectTimers.get(agentId) === timer) {
        this.localAgentReconnectTimers.delete(agentId);
      }
      this.connectLocalAgent(agentId);
    }, 3000);

    this.localAgentReconnectTimers.set(agentId, timer);
  }

  private async waitForLocalAgentSocket(agentId: string, ws: WebSocket | null): Promise<WebSocket | null> {
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
  private connectLocalAgent(agentId: string): WebSocket | null {
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

    const port = getLocalAgentPort(agentId);
    if (!port) return null;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/`);
    this.localAgentWs.set(agentId, ws);

    ws.on('open', () => {
      if (this.localAgentWs.get(agentId) !== ws) {
        ws.close();
        return;
      }
      this.clearLocalAgentReconnect(agentId);
      logger.info({ agentId, port }, 'Connected to local agent gateway');
      // Notify subscribers that local agent is connected
      this.emitAgentStatus(agentId, true);
    });

    // Accumulate streamed content so we mirror a single complete message
    let streamedContent = '';
    let streamRequestId = '';

    ws.on('message', (data: Buffer) => {
      if (this.localAgentWs.get(agentId) !== ws) return;
      try {
        const msg = JSON.parse(data.toString());
        // Tag with agent_id so routing works
        if (!msg.agent_id) msg.agent_id = agentId;
        this.routeFromUpstream(msg);

        // Accumulate streamed assistant content for platform mirror
        const msgType = msg.type as string;
        const msgData = msg.data as Record<string, unknown> | undefined;
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

  /** Forward a message to the platform WS (best-effort, fire-and-forget). */
  private forwardToPlatform(msg: Record<string, unknown>): void {
    if (this.platformWs && this.connected) {
      this.platformWs.send(JSON.stringify(msg));
    }
  }

  /** Register a browser WebSocket client */
  addClient(
    clientId: string,
    ws: WebSocket,
    meta?: {
      username?: string;
      remoteIp?: string;
      authMethod?: BrowserClient['authMethod'];
    },
  ): void {
    this.clients.set(clientId, {
      ws,
      agentId: null,
      username: meta?.username,
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

        // Cursor-based replay: client says "I have events up to seq X".
        // cursor=0 means "give me everything" (fresh tab / cleared storage).
        // The event log is the single source of truth for all agents — local
        // or platform-synced — so always check it first.
        //
        // Paginate: the replay query has a per-call limit (2000). If the agent
        // has more events than that, we must fetch in batches so the client
        // gets the full history (especially for cursor=0 full replays).
        const cursor = typeof msg.cursor === 'number' ? msg.cursor : 0;

        // Detect cursor ahead of server (event log was reset/truncated).
        // If the client's cursor is higher than the server's max seq, the
        // event log was recreated (reinstall, manual deletion, etc.).
        // Tell the client to reset its cursor so it doesn't skip new events.
        const serverMaxSeq = this.eventLog.latestSeq(agentId);
        if (cursor > 0 && serverMaxSeq !== null && cursor > serverMaxSeq) {
          this.sendToClient(clientId, {
            type: 'cursor_reset',
            agent_id: agentId,
            data: { reason: 'server_behind', serverSeq: serverMaxSeq, clientCursor: cursor },
          });
          // Replay from the beginning
          // (fall through with cursor=0)
        }
        const effectiveCursor = (cursor > 0 && serverMaxSeq !== null && cursor > serverMaxSeq) ? 0 : cursor;

        const BATCH_SIZE = 2000;
        const MAX_TOTAL = 50000; // Safety cap — prevents OOM on corrupted/huge logs
        let afterSeq = effectiveCursor;
        let missed: import('./event-log.js').ReplayedEvent[] = [];
        let batch: import('./event-log.js').ReplayedEvent[];
        do {
          batch = this.eventLog.replay(agentId, afterSeq, BATCH_SIZE);
          missed.push(...batch);
          if (batch.length > 0) afterSeq = batch[batch.length - 1]!.seq;
        } while (batch.length === BATCH_SIZE && missed.length < MAX_TOTAL);
        if (missed.length > 0) {
          // Coalesce consecutive content deltas into single events to reduce
          // replay payload size (hundreds of streaming deltas → one per turn).
          const coalesced = this.coalesceReplayEvents(missed);
          this.sendToClient(clientId, {
            type: 'event_replay',
            agent_id: agentId,
            events: coalesced.map((e) => ({ ...e.event, _seq: e.seq, _ts: e.ts })),
            first_seq: missed[0]!.seq,
            last_seq: missed[missed.length - 1]!.seq,
            cursor: missed[missed.length - 1]!.seq,
          });
          return;
        }
        // Nothing in local event log — ask platform for history (if connected)
        if (this.platformWs && this.connected) {
          this.platformWs.send(JSON.stringify(msg));
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

        restartAgent(agentId);

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
      if (!agentId) return;

      // Subscribe this client to the agent
      this.subscribe(clientId, agentId);

      // Auto-activate agent if not running
      if (!isAgentRunning(agentId)) {
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
        // Poll for gateway readiness (containers can take 8-15s for DinD)
        let started = false;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (isAgentRunning(agentId)) {
            // Also verify gateway is accepting connections
            const port = getLocalAgentPort(agentId);
            if (port) {
              try {
                const healthResp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
                if (healthResp.ok) { started = true; break; }
              } catch { /* gateway not ready yet */ }
            } else {
              started = true; break; // No port means bare-metal process, trust isAgentRunning
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
        let localWs = this.localAgentWs.get(agentId);
        if (!localWs || localWs.readyState !== WebSocket.OPEN) {
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
          localWs.send(JSON.stringify({
            type: 'message',
            agent_id: agentId,
            content: msg.content,
            source_service: 'dashboard',
            // Inject user identity so the agent knows who's talking
            user_name: client?.username ?? undefined,
            user_id: client?.username ?? clientId,
          }));
          this.sendToClient(clientId, { type: 'relay_ack', agent_id: agentId });

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

    // Forward other message types to platform (best-effort relay)
    if (this.platformWs && this.connected) {
      this.platformWs.send(JSON.stringify(msg));
    }
  }

  /** Route an upstream event (platform or local agent) to subscribed browser clients. */
  private routeFromUpstream(msg: Record<string, unknown>): void {
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

  /** Handle an RPC request and return the result. */
  private async handleRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'agents.list':
        return { agents: this.agents.map(serializeAgent) };

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
          restartAgent(agentId);
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
        };
        const mapped: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(params)) {
          if (k === 'agent_id') continue;
          mapped[keyMap[k] ?? k] = v;
        }

        const oldModelKey = JSON.stringify(agent.modelFallbacks) + JSON.stringify(agent.modelOverrides);
        const result = updateLocalAgentAtRuntime(agentId, mapped);
        if (!result.ok) throw new Error(result.error);

        const newModelKey = JSON.stringify(agent.modelFallbacks) + JSON.stringify(agent.modelOverrides);
        if (oldModelKey !== newModelKey && isAgentRunning(agentId)) {
          restartAgent(agentId);
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

        const agent = createLocalAgentAtRuntime({
          name,
          username,
          email: params.email as string | undefined,
          role: params.role as string | undefined,
          executionMethod: params.executionMethod as string | undefined,
          skills: params.skills as string[] | undefined,
          personalityTraits: params.personalityTraits as Record<string, string> | undefined,
          modelFallbacks: params.modelFallbacks as Array<{ method: string; model: string }> | undefined,
        });
        if (!this.agents.some((a) => a.id === agent.id)) {
          this.agents.push(agent);
        }
        this.broadcastAgentsSnapshot();
        return { ok: true, agent: serializeAgent(agent) };
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
          try { restartAgent(agentId); } catch { /* best effort */ }
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

  const client = new PlatformClient(config.platformUrl, config.accessToken);

  // ── Event log for message reliability (Kafka-style append-only log) ──
  const eventLog = new EventLog();

  // Reap old events every hour (keeps last 24h)
  const reapTimer = setInterval(() => {
    try {
      const deleted = eventLog.reap();
      if (deleted > 0) logger.debug({ deleted }, 'Event log reaper cleaned old events');
    } catch { /* ignore */ }
  }, 60 * 60 * 1000);
  reapTimer.unref();

  // ── Start chatbot WS bridge ──
  const chatBridge = new ChatbotBridge(config.platformUrl, config.accessToken, config.agents, eventLog);
  chatBridge.connect();

  // Push agent state changes (start/stop/error/restart) to all WS clients in real-time
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
      if (req.url.startsWith('/ws/')) {
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

  ensureDashboardCredentials();

  // Public endpoints (no auth required)
  app.get('/health', async () => ({
    status: 'ok',
    service: 'shizuha-daemon',
    version: '0.1.0',
    agents: config.agents.length,
  }));

  app.get('/v1/dashboard/session', async (request) => {
    const token = extractSessionToken(request.headers.cookie);
    if (token) {
      const session = validateSession(token);
      if (session.valid) {
        return { authenticated: true, username: session.username, defaultPassword: isDefaultPassword() };
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
    return { ok: true, username, defaultPassword: isDefaultPassword() };
  });

  app.post('/v1/dashboard/logout', async (request, reply) => {
    const token = extractSessionToken(request.headers.cookie);
    if (token) dashboardLogout(token);
    reply.header('Set-Cookie', 'shizuha_session=; Path=/; HttpOnly; Max-Age=0');
    return { ok: true };
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

    // Inter-agent communication endpoints — allow from localhost and Docker bridge.
    // Agents inside containers use host.docker.internal which resolves to the Docker
    // bridge gateway (172.x.0.1), not 127.0.0.1. Both are same-machine, no security risk.
    if (url.startsWith('/v1/agents/') && url.includes('/ask')) {
      const remoteIp = request.ip;
      const isLocalhost = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
      const isDockerBridge = remoteIp?.startsWith('172.') || remoteIp?.startsWith('::ffff:172.');
      if (isLocalhost || isDockerBridge) {
        return; // Same-machine call — bypass auth
      }
    }
    // Also allow /v1/agents list from localhost + Docker (for agent discovery)
    if (url === '/v1/agents') {
      const remoteIp = request.ip;
      const isLocal = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1'
        || remoteIp?.startsWith('172.') || remoteIp?.startsWith('::ffff:172.');
      if (isLocal) return;
    }
    // Localhost bypass — same-machine CLI/browser is trusted
    const remoteIp = request.ip || '';
    if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
      return;
    }

    // Code generation is localhost-only
    if (url === '/v1/devices/code') {
      return reply.status(403).send({ error: 'Code generation is only available from localhost' });
    }

    // Check session cookie (dashboard web UI)
    const sessionToken = extractSessionToken(request.headers.cookie);
    if (sessionToken && validateSession(sessionToken).valid) {
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

  // ── Inter-agent messaging — one agent talks to another ──
  app.post<{
    Params: { targetId: string };
    Body: { content: string; from_agent?: string; timeout?: number };
  }>('/v1/agents/:targetId/ask', async (request, reply) => {
    const { targetId } = request.params;
    const { content, from_agent, timeout = 60000 } = request.body ?? {};
    if (!content) return reply.status(400).send({ error: 'content required' });
    const senderAgent = (request as any).agentAuth as
      | { agentId: string; agentName: string; agentUsername: string }
      | undefined;

    const targetAgent = config.agents.find(a => a.id === targetId || a.username === targetId);
    if (!targetAgent) return reply.status(404).send({ error: `Agent "${targetId}" not found` });
    if (!isAgentRunning(targetAgent.id)) return reply.status(503).send({ error: `Agent "${targetAgent.name}" is not running` });

    const userMsgId = crypto.randomUUID();
    const userMsgEvent = {
      type: 'user_message',
      agent_id: targetAgent.id,
      content,
      message_id: userMsgId,
      source: senderAgent ? `agent:${senderAgent.agentUsername}` : from_agent ? `agent:${from_agent}` : 'api',
      // Include data envelope for mobile app compatibility
      data: { content, agent_id: targetAgent.id, message_id: userMsgId },
    };
    // Connect to the target agent's bridge WS and send a message
    const port = getLocalAgentPort(targetAgent.id);
    if (!port) return reply.status(503).send({ error: `Agent "${targetAgent.name}" has no port assigned` });

    if (shouldLogGatewayIngress(targetAgent)) {
      logger.info({
        agentId: targetAgent.id,
        agentName: targetAgent.name,
        agentUsername: targetAgent.username,
        executionMethod: primaryExecutionMethod(targetAgent),
        pathway: 'agents_ask',
        source: senderAgent ? `agent:${senderAgent.agentUsername}` : from_agent ? `agent:${from_agent}` : 'api',
        requestId: undefined,
        contentPreview: previewContent(content),
        contentLength: content.length,
      }, 'Gateway ingress message');
    }

    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/`);
      let responseText = '';
      let completed = false;
      let sentUpstream = false;
      const timer = setTimeout(() => {
        if (!completed) {
          completed = true;
          ws.close();
          if (!sentUpstream) {
            resolve(reply.status(503).send({ error: `Timed out connecting to agent "${targetAgent.name}"` }));
            return;
          }
          resolve(reply.send({ ok: true, response: responseText || '[timeout — no response within ' + timeout + 'ms]', from: targetAgent.name, partial: true }));
        }
      }, timeout);

      ws.on('open', async () => {
        const relayName = senderAgent?.agentName || senderAgent?.agentUsername || from_agent;
        const prefix = relayName ? `[Message from agent ${relayName}] ` : '';
        try {
          await sendJsonOverSocket(ws, {
            type: 'message',
            content: `${prefix}${content}`,
            agent_id: targetAgent.id,
          });
          sentUpstream = true;
          // Persist + broadcast only after the upstream runtime accepted the socket write.
          chatBridge.logEvent(targetAgent.id, userMsgEvent);
        } catch {
          if (!completed) {
            completed = true;
            clearTimeout(timer);
            resolve(reply.status(503).send({ error: `Failed to send message to agent "${targetAgent.name}"` }));
          }
        }
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'content' && msg.data?.delta) {
            responseText += msg.data.delta;
          }
          if (msg.type === 'complete') {
            completed = true;
            clearTimeout(timer);
            ws.close();
            resolve(reply.send({ ok: true, response: responseText, from: targetAgent.name }));
          }
        } catch { /* ignore */ }
      });

      ws.on('error', () => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          resolve(reply.status(503).send({ error: `Failed to connect to agent "${targetAgent.name}"` }));
        }
      });

      ws.on('close', () => {
        if (!completed) {
          completed = true;
          clearTimeout(timer);
          if (!sentUpstream) {
            resolve(reply.status(503).send({ error: `Failed to connect to agent "${targetAgent.name}"` }));
            return;
          }
          resolve(reply.send({ ok: true, response: responseText || '[connection closed]', from: targetAgent.name }));
        }
      });
    });
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

  // ── Agent enable/disable ──

  app.post<{
    Body: { agent_id: string; enabled: boolean };
  }>('/v1/agents/toggle', async (request, reply) => {
    const { agent_id, enabled } = request.body ?? {};
    if (!agent_id || typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'agent_id and enabled (boolean) are required' });
    }

    if (enabled) {
      const result = await enableAndStartAgent(agent_id);
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

  app.post<{
    Params: { id: string };
  }>('/v1/agents/:id/restart', async (request, reply) => {
    const { id } = request.params;
    if (!isAgentRunning(id)) {
      const result = await enableAndStartAgent(id);
      if (!result.ok) return reply.status(500).send({ error: result.error });
      chatBridge.broadcastAgentUpdate(id);
      return { status: 'restarted', agent_id: id };
    }
    restartAgent(id);
    chatBridge.broadcastAgentUpdate(id);
    await new Promise((r) => setTimeout(r, 3000));
    setTimeout(() => chatBridge.broadcastAgentUpdate(id), 3000);
    return { status: 'restarted', agent_id: id };
  });

  // ── Agent runtime session reset ──

  app.post<{
    Params: { id: string };
  }>('/v1/agents/:id/reset-session', async (request, reply) => {
    const resolved = resolveAgentByIdentifier(config.agents, request.params.id);
    if (!resolved) return reply.status(404).send({ error: 'Agent not found' });

    const wasRunning = isAgentRunning(resolved.id);
    if (wasRunning) {
      restartAgent(resolved.id);
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
    if (!isAgentRunning(agent.id)) return reply.status(400).send({ error: 'Agent is not running' });

    // Set paused state on the agent's gateway via WS command
    const port = getLocalAgentPort(agent.id);
    if (!port) return reply.status(503).send({ error: 'Agent has no port' });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'control', action: 'pause', reason: request.body?.reason }));
          clearTimeout(timer);
          ws.close();
          resolve();
        });
        ws.on('error', reject);
      });
    } catch {
      // If WS fails, still mark as paused in state
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

    const port = getLocalAgentPort(agent.id);
    if (port) {
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
          ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'control', action: 'resume' }));
            clearTimeout(timer);
            ws.close();
            resolve();
          });
          ws.on('error', reject);
        });
      } catch {
        // Best-effort — if WS fails, the restart will resume it
      }
    }

    // Update persistent state and restart if needed
    updateAgentConfig(agent.id, { status: 'active' } as any);
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

    const port = getLocalAgentPort(agent.id);
    if (!port) return reply.status(503).send({ error: 'Agent has no port' });

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'cancel' }));
          clearTimeout(timer);
          ws.close();
          resolve();
        });
        ws.on('error', reject);
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

    const oldModelKey = JSON.stringify(agent.modelFallbacks) + JSON.stringify(agent.modelOverrides);
    const result = updateLocalAgentAtRuntime(id, mapped);
    if (!result.ok) {
      return reply.status(400).send({ error: result.error });
    }

    // Restart gateway if model config changed (so new model takes effect)
    const newModelKey = JSON.stringify(agent.modelFallbacks) + JSON.stringify(agent.modelOverrides);
    if (oldModelKey !== newModelKey && agent.status !== 'disabled' && isAgentRunning(id)) {
      restartAgent(id);
    }

    // Also sync to platform (best-effort)
    if (client) {
      try {
        await client.updateAgent(id, mapped);
      } catch (err) {
        logger.warn({ agentId: id, err: (err as Error).message }, 'Platform sync failed (best-effort)');
      }
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
    config.agents = config.agents.filter((a) => a.id !== id);

    chatBridge.broadcastAgentsSnapshot();
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
    Body: {
      service: string;
      label: string;
      credentialData: Record<string, string>;
      injectAsEnv?: boolean;
      envMapping?: Record<string, string>;
    };
  }>('/v1/agents/:id/credentials', async (request, reply) => {
    const agent = config.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    const body = request.body ?? {} as Record<string, unknown>;
    if (!body.service || !body.label || !body.credentialData) {
      return reply.status(400).send({ error: 'service, label, and credentialData are required' });
    }

    const cred = {
      id: `cred-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      service: body.service,
      label: body.label,
      credentialData: body.credentialData,
      injectAsEnv: body.injectAsEnv ?? true,
      envMapping: body.envMapping,
      isActive: true,
    };

    if (!agent.credentials) agent.credentials = [];
    agent.credentials.push(cred);
    updateAgentConfig(agent.id, { credentials: agent.credentials });

    // Auto-restart agent so new env vars take effect immediately.
    // Use restartAgent() which gracefully stops the process and lets the
    // auto-restart handler bring it back with the updated config.
    let restarted = false;
    if (cred.injectAsEnv && isAgentRunning(agent.id)) {
      logger.info({ agentId: agent.id }, 'Credential added — restarting agent to inject env vars');
      restartAgent(agent.id);
      restarted = true;
    }

    return {
      ok: true,
      credential: {
        ...cred,
        credentialData: Object.fromEntries(
          Object.entries(cred.credentialData).map(([k, v]) => [k, v ? v.slice(0, 4) + '****' : ''])
        ),
      },
      restarted,
    };
  });

  // Update credential (toggle active, change env mapping)
  app.patch<{
    Params: { id: string; credId: string };
    Body: { isActive?: boolean; envMapping?: Record<string, string>; label?: string };
  }>('/v1/agents/:id/credentials/:credId', async (request, reply) => {
    const agent = config.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const cred = agent.credentials?.find((c) => c.id === request.params.credId);
    if (!cred) return reply.status(404).send({ error: 'Credential not found' });

    const body = request.body ?? {};
    if (body.isActive !== undefined) cred.isActive = body.isActive;
    if (body.envMapping !== undefined) cred.envMapping = body.envMapping;
    if (body.label !== undefined) cred.label = body.label;

    updateAgentConfig(agent.id, { credentials: agent.credentials });

    // Auto-restart agent so env var changes take effect
    let restarted = false;
    if (isAgentRunning(agent.id)) {
      logger.info({ agentId: agent.id }, 'Credential updated — restarting agent');
      restartAgent(agent.id);
      restarted = true;
    }

    return { ok: true, restarted };
  });

  // Delete credential
  app.delete<{
    Params: { id: string; credId: string };
  }>('/v1/agents/:id/credentials/:credId', async (request, reply) => {
    const agent = config.agents.find((a) => a.id === request.params.id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const before = agent.credentials?.length ?? 0;
    agent.credentials = (agent.credentials ?? []).filter((c) => c.id !== request.params.credId);
    if (agent.credentials.length === before) {
      return reply.status(404).send({ error: 'Credential not found' });
    }

    updateAgentConfig(agent.id, { credentials: agent.credentials });

    // Auto-restart agent so env var removal takes effect
    let restarted = false;
    if (isAgentRunning(agent.id)) {
      logger.info({ agentId: agent.id }, 'Credential deleted — restarting agent');
      restartAgent(agent.id);
      restarted = true;
    }

    return { ok: true, restarted };
  });

  // ── Daemon status ──

  app.get('/v1/status', async () => {
    const state = readDaemonState();
    let runners: Array<Record<string, unknown>> = [];
    try {
      runners = await client.getRunnerStatus();
    } catch { /* ignore */ }

    return {
      daemon: state ? {
        pid: state.pid,
        startedAt: state.startedAt,
        platformUrl: state.platformUrl,
        agentCount: state.agents.length,
        agents: state.agents,
      } : null,
      runners,
    };
  });

  // ── Settings / Runtime info ──

  app.get('/v1/settings', async () => {
    const state = readDaemonState();
    const auth = getShizuhaAuthStatus();
    const creds = readCredentials();
    let runners: Array<Record<string, unknown>> = [];
    try {
      runners = await client.getRunnerStatus();
    } catch { /* ignore */ }

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
          executionMethod: a.executionMethod,
          runtimeEnvironment: a.runtimeEnvironment ?? 'bare_metal',
          resourceLimits: a.resourceLimits ?? {},
          modelOverrides: a.modelOverrides,
          modelFallbacks: a.modelFallbacks,
          skills: a.skills,
          personalityTraits: a.personalityTraits,
          mcpServers: (a.mcpServers || []).map((s) => ({ name: s.name, slug: s.slug })),
          status: agentState?.status ?? 'unknown',
          enabled: agentState?.enabled ?? false,
          pid: agentState?.pid,
          error: agentState?.error,
          startedAt: agentState?.startedAt,
          tokenPrefix: agentState?.tokenPrefix,
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
        };
      }),

      // Runtime
      runtime: {
        version: '0.1.0',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage().rss,
      },
    };
  });

  // ── Available models ──

  app.get('/v1/models', async () => {
    return {
      models: [
        { slug: 'claude-opus-4-6', provider: 'anthropic' },
        { slug: 'claude-sonnet-4-6', provider: 'anthropic' },
        { slug: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
        { slug: 'claude-opus-4.6', provider: 'copilot' },
        { slug: 'claude-sonnet-4.6', provider: 'copilot' },
        { slug: 'claude-sonnet-4.5', provider: 'copilot' },
        { slug: 'claude-haiku-4.5', provider: 'copilot' },
        { slug: 'gpt-5.3-codex-spark', provider: 'openai' },
        { slug: 'gpt-5.4', provider: 'openai' },
        { slug: 'gpt-4.1', provider: 'openai' },
        { slug: 'o4-mini', provider: 'openai' },
        { slug: 'codex-mini-latest', provider: 'openai' },
        { slug: 'gemini-2.0-flash', provider: 'google' },
      ],
      providers: ['anthropic', 'openai', 'google', 'copilot'],
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

  app.post<{ Body: { username: string; password: string } }>('/v1/auth/login', async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (!username || !password) {
      return reply.status(400).send({ error: 'Username and password are required' });
    }
    try {
      const result = await loginToShizuhaId(username, password);
      return { ok: true, username: result.username };
    } catch (err) {
      return reply.status(401).send({ error: (err as Error).message });
    }
  });

  app.post('/v1/auth/logout', async () => {
    clearShizuhaAuth();
    return { ok: true };
  });

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
      formData.append('file', new Blob([audioBuffer], { type: 'audio/webm' }), 'recording.webm');
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
      const port = getLocalAgentPort(agent.id);
      if (!port) throw new Error(`Agent ${agent.name} has no port`);

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
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat/`);
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

  // ── Attach WebSocket server for browser chat ──

  const httpServer = app.server;
  const wss = new WebSocketServer({ noServer: true });


  httpServer.on('upgrade', (request: import('http').IncomingMessage, socket: import('stream').Duplex, head: Buffer) => {
    const remoteIp = (request.socket as any).remoteAddress || '';
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

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
        if (remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1') {
          authenticated = true;
          authMethod = 'localhost-bypass';
        }
      }

      if (!authenticated) {
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
        chatBridge.addClient(clientId, ws, { username, remoteIp, authMethod });
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
          hostname: '127.0.0.1',
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
      httpFallback.listen(httpPort, config.host);
      httpFallback.unref();
      console.log(`Dashboard: http://${host}:${httpPort}`);
    } catch { /* non-critical */ }
  } else {
    console.log(`Dashboard: http://${host}:${config.port}`);
  }
}
