/**
 * HTTP/SSE Channel — wraps a Fastify server for browser/curl access.
 *
 * The web UI POSTs to /v1/query/stream and receives SSE events.
 * This channel bridges that to the gateway inbox: each HTTP request
 * becomes an InboundMessage, and the SSE response is fed by
 * sendEvent/sendComplete callbacks.
 *
 * Also exposes a WebSocket endpoint at /ws/chat that speaks the
 * same protocol as the SaaS shizuha-agent chatbot consumer. This
 * allows the Kotlin/React Native apps to connect to a local runtime
 * using their existing WebSocket client — no protocol changes needed.
 *
 * The HTTP channel also serves the web UI static files, device pairing,
 * session history (read-only view of the eternal session), and models list.
 */

import * as crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-ignore — ws has no declaration file in this project
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage } from '../types.js';
import { toSSE } from '../../events/stream.js';
import { logger } from '../../utils/logger.js';
import { buildSyncHistoryMessages } from '../../state/sync-history.js';
import type { Message } from '../../agent/types.js';
import { createDeviceAuthHook } from '../../devices/middleware.js';
import {
  addPendingCode, consumePendingCode, addDevice,
  removeDevice, listDevices, rotateDeviceToken, generateDeviceId,
  findDeviceByTokenHash,
} from '../../devices/store.js';
import {
  generatePairingCode, generateDeviceToken, hashToken,
  formatCode, normalizeCode, CODE_TTL_MS,
} from '../../devices/pairing.js';
import { checkRateLimit, recordFailure, resetFailures } from '../../devices/rateLimit.js';

/** Pending SSE response slot — bridges inbox processing to HTTP response. */
interface ResponseSlot {
  reply: FastifyReply;
  resolve: () => void;
  promise: Promise<void>;
}

/** Active WebSocket client — bridges WS messages to/from the inbox. */
interface WsClientSlot {
  ws: WebSocket;
  userId: string;
  /** Map of threadId → true for in-flight executions on this socket */
  activeThreads: Set<string>;
}

const WS_PING_INTERVAL_MS = 30_000;

export interface HttpChannelOptions {
  port?: number;
  host?: string;
  /** Reference to AgentProcess for reading session state */
  getMessages?: () => readonly any[];
  getSessionId?: () => string | null;
  /** Fan-out settings accessors (from AgentProcess) */
  getFanOutSettings?: () => Record<string, boolean>;
  setFanOut?: (channelType: string, enabled: boolean) => void;
}

export class HttpChannel implements Channel {
  readonly id = 'http-default';
  readonly type = 'http' as const;

  private app: FastifyInstance | null = null;
  private inbox: Inbox | null = null;
  private pendingResponses = new Map<string, ResponseSlot>();
  /** WS clients: threadId → WsClientSlot (for routing events back to the right socket) */
  private wsClients = new Map<string, WsClientSlot>();
  /** All connected WS sockets (for cleanup) */
  private allWsSockets = new Set<WebSocket>();
  private wss: InstanceType<typeof WebSocketServer> | null = null;
  private wsPingTimer: NodeJS.Timeout | null = null;
  private port: number;
  private host: string;
  private getMessages: () => readonly any[];
  private getSessionId: () => string | null;
  private getFanOutSettings: () => Record<string, boolean>;
  private setFanOut: (channelType: string, enabled: boolean) => void;

  constructor(options: HttpChannelOptions = {}) {
    this.port = options.port ?? 8015;
    this.host = options.host ?? '0.0.0.0';
    this.getMessages = options.getMessages ?? (() => []);
    this.getSessionId = options.getSessionId ?? (() => null);
    this.getFanOutSettings = options.getFanOutSettings ?? (() => ({}));
    this.setFanOut = options.setFanOut ?? (() => {});
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.app = Fastify({ logger: false });
    await this.app.register(cors, { origin: true });

    // Device authentication
    this.app.addHook('preHandler', createDeviceAuthHook());

    // Serve web UI static files
    await this.registerStaticFiles();

    // Register all routes (HTTP + SSE)
    this.registerRoutes();

    await this.app.listen({ port: this.port, host: this.host });

    // Attach WebSocket server to the same HTTP server (path: /ws/chat)
    this.startWebSocketServer();

    logger.info({ port: this.port, host: this.host }, 'HTTP channel started (SSE + WebSocket)');
    console.log(`Shizuha agent listening on ${this.host}:${this.port}`);
  }

  async stop(): Promise<void> {
    // Stop WS ping timer
    if (this.wsPingTimer) { clearInterval(this.wsPingTimer); this.wsPingTimer = null; }

    // Close all WebSocket clients
    for (const ws of this.allWsSockets) {
      try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    }
    this.allWsSockets.clear();
    this.wsClients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Complete all pending SSE responses
    for (const [threadId, slot] of this.pendingResponses) {
      try {
        slot.reply.raw.end();
        slot.resolve();
      } catch { /* ignore */ }
      this.pendingResponses.delete(threadId);
    }

    if (this.app) {
      await this.app.close();
      this.app = null;
    }
  }

  async sendEvent(threadId: string, event: AgentEvent): Promise<void> {
    // Proactive/broadcast: send to ALL connected WS sockets (cron, heartbeat, etc.)
    // Uses allWsSockets (persistent set) instead of wsClients (per-thread, gets cleaned up).
    if (threadId === 'proactive') {
      const wsMsg = this.agentEventToWsMessage('proactive', event);
      if (wsMsg) {
        for (const ws of this.allWsSockets) {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify(wsMsg)); } catch { /* ignore */ }
          }
        }
      }
      return;
    }

    // Try SSE response slot first
    const slot = this.pendingResponses.get(threadId);
    if (slot) {
      try {
        slot.reply.raw.write(toSSE(event));
      } catch {
        this.pendingResponses.delete(threadId);
        slot.resolve();
      }
      return;
    }

    // Try WebSocket client
    const wsSlot = this.wsClients.get(threadId);
    if (wsSlot && wsSlot.ws.readyState === WebSocket.OPEN) {
      const wsMsg = this.agentEventToWsMessage(threadId, event);
      if (wsMsg) {
        try { wsSlot.ws.send(JSON.stringify(wsMsg)); } catch { /* ignore */ }
      }
    }
  }

  sendComplete(threadId: string): void {
    // SSE
    const slot = this.pendingResponses.get(threadId);
    if (slot) {
      try { slot.reply.raw.end(); } catch { /* ignore */ }
      slot.resolve();
      this.pendingResponses.delete(threadId);
      return;
    }

    // WebSocket — clean up thread tracking (socket stays open for more messages)
    const wsSlot = this.wsClients.get(threadId);
    if (wsSlot) {
      wsSlot.activeThreads.delete(threadId);
      this.wsClients.delete(threadId);
    }
  }

  /**
   * Fan-out: broadcast an event from another channel's execution to ALL
   * connected /ws/chat/ WebSocket clients. This allows dashboard browsers
   * and mobile apps to see the agent's work regardless of which channel
   * (Telegram, Discord, ShizuhaWS, etc.) originated the message.
   */
  async broadcastEvent(event: AgentEvent, originChannelId: string, threadId: string): Promise<void> {
    const wsMsg = this.agentEventToWsMessage(threadId, event);
    if (!wsMsg) return;
    // Tag as fan-out so clients can distinguish
    (wsMsg as Record<string, unknown>).fan_out = true;
    (wsMsg as Record<string, unknown>).origin_channel = originChannelId;
    const payload = JSON.stringify(wsMsg);
    for (const ws of this.allWsSockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch { /* ignore dead sockets */ }
      }
    }
  }

  notifyBusy(threadId: string, queuePosition: number): void {
    // SSE
    const slot = this.pendingResponses.get(threadId);
    if (slot) {
      try {
        slot.reply.raw.write(toSSE({
          type: 'error' as const,
          error: `Agent is busy. Your message is #${queuePosition} in queue.`,
          code: 'QUEUED',
          timestamp: Date.now(),
        }));
      } catch { /* ignore */ }
      return;
    }

    // WebSocket
    const wsSlot = this.wsClients.get(threadId);
    if (wsSlot && wsSlot.ws.readyState === WebSocket.OPEN) {
      try {
        wsSlot.ws.send(JSON.stringify({
          type: 'busy',
          data: { message: `Agent is busy. Your message is #${queuePosition} in queue.` },
        }));
      } catch { /* ignore */ }
    }
  }

  // ── Route Registration ──

  private registerRoutes(): void {
    const app = this.app!;

    // Health check
    app.get('/health', async () => ({
      status: 'ok',
      service: 'shizuha',
      version: '0.1.0',
      mode: 'gateway',
      queueDepth: this.inbox?.depth ?? 0,
      busy: this.inbox?.busy ?? false,
    }));

    // SSE streaming query — pushes to inbox instead of running inline
    app.post<{ Body: { prompt: string; model?: string; permissionMode?: string } }>(
      '/v1/query/stream',
      async (request, reply) => {
        const body = request.body;
        if (!body?.prompt) {
          return reply.status(400).send({ error: 'prompt is required' });
        }

        // Set up SSE response
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        // Create response slot
        const threadId = crypto.randomUUID();
        let resolvePromise: () => void;
        const promise = new Promise<void>((resolve) => {
          resolvePromise = resolve;
        });

        this.pendingResponses.set(threadId, {
          reply,
          resolve: resolvePromise!,
          promise,
        });

        // Push to inbox
        const msg: InboundMessage = {
          id: crypto.randomUUID(),
          channelId: this.id,
          channelType: 'http',
          threadId,
          userId: (request as any).deviceId ?? 'localhost',
          content: body.prompt,
          timestamp: Date.now(),
          model: body.model,
          permissionMode: body.permissionMode,
        };
        this.inbox!.push(msg);

        // Wait for agent to finish processing
        await promise;
      },
    );

    // ── Session endpoint — returns the eternal session messages ──
    app.get('/v1/sessions', async () => {
      const sessionId = this.getSessionId();
      const messages = this.getMessages();
      if (!sessionId) return { sessions: [] };

      return {
        sessions: [{
          id: sessionId,
          model: '',
          cwd: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          totalInputTokens: 0,
          totalOutputTokens: 0,
          turnCount: 0,
          name: 'Agent Session',
          firstMessage: messages.length > 0
            ? (typeof messages[0]?.content === 'string' ? messages[0].content.slice(0, 100) : 'Session')
            : undefined,
        }],
      };
    });

    app.get<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
      const sessionId = this.getSessionId();
      if (request.params.id !== sessionId) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      const messages = this.getMessages();
      return {
        id: sessionId,
        model: '',
        messages: messages.map((m: any) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          timestamp: m.timestamp,
        })),
      };
    });

    // ── Models endpoint ──
    app.get('/v1/models', async () => {
      const models = [
        { slug: 'claude-opus-4-6', provider: 'anthropic' },
        { slug: 'claude-sonnet-4-6', provider: 'anthropic' },
        { slug: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
        { slug: 'gpt-5.3-codex-spark', provider: 'openai' },
        { slug: 'gpt-5.4', provider: 'openai' },
        { slug: 'gpt-4.1', provider: 'openai' },
        { slug: 'gpt-4.1-mini', provider: 'openai' },
        { slug: 'o4-mini', provider: 'openai' },
        { slug: 'codex-mini-latest', provider: 'openai' },
        { slug: 'gemini-2.0-flash', provider: 'google' },
      ];
      return { models, providers: ['anthropic', 'openai', 'google'] };
    });

    // ── Fan-out settings ──
    app.get('/v1/fan-out', async () => {
      return { fanOut: this.getFanOutSettings() };
    });

    app.post<{ Body: { channelType: string; enabled: boolean } }>(
      '/v1/fan-out',
      async (request, reply) => {
        const { channelType, enabled } = request.body || {};
        if (!channelType || typeof enabled !== 'boolean') {
          return reply.status(400).send({ error: 'channelType and enabled (boolean) are required' });
        }
        this.setFanOut(channelType, enabled);
        return { ok: true, fanOut: this.getFanOutSettings() };
      },
    );

    // ── Device pairing endpoints ──
    app.post('/v1/devices/code', async () => {
      const code = generatePairingCode();
      const now = Date.now();
      addPendingCode({ code, createdAt: now, expiresAt: now + CODE_TTL_MS });
      return { code: formatCode(code), raw: code, expiresAt: now + CODE_TTL_MS };
    });

    app.post<{ Body: { code: string; deviceName?: string; platform?: string } }>(
      '/v1/devices/pair',
      async (request, reply) => {
        const ip = request.ip || '';
        if (!checkRateLimit(ip)) {
          return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
        }
        const { code: rawCode, deviceName, platform } = request.body || {};
        if (!rawCode) return reply.status(400).send({ error: 'code is required' });

        const code = normalizeCode(rawCode);
        const pending = consumePendingCode(code);
        if (!pending) {
          recordFailure(ip);
          return reply.status(401).send({ error: 'Invalid or expired pairing code' });
        }

        resetFailures(ip);
        const token = generateDeviceToken();
        const deviceId = generateDeviceId();
        addDevice({
          deviceId,
          deviceName: deviceName || 'Unknown Device',
          platform: platform || 'unknown',
          tokenHash: hashToken(token),
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          remoteIp: ip,
        });

        return { deviceId, token, deviceName: deviceName || 'Unknown Device' };
      },
    );

    app.get('/v1/devices/status', async () => {
      const devices = listDevices();
      return { pairingRequired: devices.length > 0 };
    });

    app.get('/v1/devices', async () => {
      const devices = listDevices();
      return {
        devices: devices.map((d) => ({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          platform: d.platform,
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          remoteIp: d.remoteIp,
        })),
      };
    });

    app.delete<{ Params: { id: string } }>('/v1/devices/:id', async (request) => {
      return { ok: removeDevice(request.params.id) };
    });

    app.patch<{ Params: { id: string } }>('/v1/devices/:id/rotate', async (request, reply) => {
      const token = generateDeviceToken();
      const ok = rotateDeviceToken(request.params.id, hashToken(token));
      if (!ok) return reply.status(404).send({ error: 'Device not found' });
      return { token };
    });
  }

  // ── WebSocket Server (chatbot protocol) ──

  /**
   * Attach a WebSocket server to Fastify's underlying HTTP server.
   * Path: /ws/chat — speaks the same protocol as the SaaS chat consumer.
   */
  private startWebSocketServer(): void {
    const server = this.app!.server;

    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests — only accept /ws/chat path
    server.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws/chat' && url.pathname !== '/ws/chat/') {
        socket.destroy();
        return;
      }

      // Authenticate: check ?token= query param, bypass for localhost
      const token = url.searchParams.get('token');
      const remoteIp = request.socket.remoteAddress || '';
      const isLocalhost = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1'
        || process.env['SHIZUHA_GATEWAY_LOCALHOST_BYPASS'] === '1';

      let userId = 'localhost';
      if (!isLocalhost) {
        // Remote clients must always authenticate — no zero-device bypass.
        // First-time setup is done from localhost (already bypassed above).
        {
          if (!token) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          const device = findDeviceByTokenHash(hashToken(token));
          if (!device) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          userId = device.deviceId;
        }
      }

      this.wss!.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        this.wss!.emit('connection', ws, request, userId);
      });
    });

    this.wss.on('connection', (ws: WebSocket, _request: IncomingMessage, userId: string) => {
      this.allWsSockets.add(ws);
      logger.info({ userId }, 'WebSocket client connected');

      // Track this socket's active threads for cleanup
      const socketThreads = new Set<string>();

      ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleWsMessage(ws, userId, msg, socketThreads);
        } catch (err) {
          try {
            ws.send(JSON.stringify({
              type: 'error',
              data: { message: 'Invalid JSON' },
            }));
          } catch { /* ignore */ }
        }
      });

      ws.on('close', () => {
        this.allWsSockets.delete(ws);
        // Clean up thread registrations for this socket
        for (const threadId of socketThreads) {
          this.wsClients.delete(threadId);
        }
        socketThreads.clear();
        logger.info({ userId }, 'WebSocket client disconnected');
      });

      ws.on('error', (err: Error) => {
        logger.warn({ err, userId }, 'WebSocket client error');
      });
    });

    // Keepalive ping — detect dead connections
    this.wsPingTimer = setInterval(() => {
      for (const ws of this.allWsSockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, WS_PING_INTERVAL_MS);
  }

  /**
   * Handle an incoming WebSocket message from a chatbot client.
   * Matches the SaaS ChatbotConsumer protocol.
   */
  private handleWsMessage(
    ws: WebSocket,
    userId: string,
    msg: Record<string, unknown>,
    socketThreads: Set<string>,
  ): void {
    const type = msg.type as string;

    switch (type) {
      case 'ping': {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
        break;
      }

      case 'message': {
        const content = ((msg.content as string) || '').trim();
        if (!content) {
          try {
            ws.send(JSON.stringify({
              type: 'error',
              data: { message: 'content is required' },
            }));
          } catch { /* ignore */ }
          break;
        }

        // Create a thread ID for this message exchange
        const threadId = crypto.randomUUID();

        // Register this socket as the recipient for events on this thread
        const slot: WsClientSlot = this.wsClients.get(threadId) ?? {
          ws,
          userId,
          activeThreads: socketThreads,
        };
        slot.activeThreads.add(threadId);
        this.wsClients.set(threadId, slot);
        socketThreads.add(threadId);

        // Push to inbox — the agent process will pick this up
        const inbound: InboundMessage = {
          id: (msg.request_id as string) ?? crypto.randomUUID(),
          channelId: this.id,
          channelType: 'http',
          threadId,
          userId,
          userName: (msg.user_name as string) ?? undefined,
          content,
          timestamp: Date.now(),
          model: msg.model as string | undefined,
        };
        this.inbox!.push(inbound);
        break;
      }

      case 'sync': {
        // Return conversation history for this agent
        const sessionId = this.getSessionId();
        const messages = this.getMessages();
        const historyMessages = buildSyncHistoryMessages(messages as readonly Message[]);

        try {
          ws.send(JSON.stringify({
            type: 'sync_history',
            session_id: sessionId,
            messages: historyMessages,
          }));
        } catch { /* ignore */ }
        break;
      }

      case 'create_session': {
        // Local runtime has a single eternal session — return it
        const sessionId = this.getSessionId();
        try {
          ws.send(JSON.stringify({
            type: 'session_created',
            session_id: sessionId,
            agent: {
              name: 'Shizuha',
              id: 'local',
            },
          }));
        } catch { /* ignore */ }
        break;
      }

      case 'stream_ack':
      case 'cancel':
        // Acknowledged but not implemented for local runtime
        break;

      default:
        logger.debug({ type }, 'Unhandled WS message type');
    }
  }

  /**
   * Translate an internal AgentEvent to the SaaS chatbot wire format.
   * Returns null if the event should not be forwarded to the client.
   *
   * Protocol (matches ChatbotConsumer in shizuha-agent/agents/consumers.py):
   *   content      → { type: "content", data: { delta: "..." } }
   *   reasoning    → { type: "reasoning", data: { summaries: [...] } }
   *   tool_start   → { type: "tool_start", data: { tool, input, tool_call_id } }
   *   tool_complete→ { type: "tool_complete", data: { tool, duration_ms, is_error } }
   *   complete     → { type: "complete", data: { result, duration_seconds } }
   *   error        → { type: "error", data: { message: "..." } }
   */
  private agentEventToWsMessage(
    threadId: string,
    event: AgentEvent,
  ): Record<string, unknown> | null {
    switch (event.type) {
      case 'content':
        return {
          type: 'content',
          execution_id: threadId,
          data: { delta: event.text },
        };

      case 'reasoning':
        return {
          type: 'reasoning',
          execution_id: threadId,
          data: { summaries: event.summaries },
        };

      case 'tool_start':
        return {
          type: 'tool_start',
          execution_id: threadId,
          data: {
            tool: event.toolName,
            input: event.input,
            tool_call_id: event.toolCallId,
          },
        };

      case 'tool_complete':
        return {
          type: 'tool_complete',
          execution_id: threadId,
          data: {
            tool: event.toolName,
            duration_ms: event.durationMs,
            is_error: event.isError,
          },
        };

      case 'complete':
        return {
          type: 'complete',
          execution_id: threadId,
          data: {
            result: {
              total_turns: event.totalTurns,
              input_tokens: event.totalInputTokens,
              output_tokens: event.totalOutputTokens,
            },
            duration_seconds: event.totalDurationMs / 1000,
          },
        };

      case 'error':
        return {
          type: 'error',
          execution_id: threadId,
          data: { message: event.error },
        };

      case 'session_start':
        return {
          type: 'session_start',
          execution_id: threadId,
          data: {
            session_id: event.sessionId,
            model: event.model,
            ...(event.messageId ? { message_id: event.messageId } : {}),
          },
        };

      case 'proactive_message':
        return {
          type: 'proactive_message',
          execution_id: threadId,
          agent_id: (event as any).agentId,
          data: {
            content: (event as any).content,
            agent_id: (event as any).agentId,
            message_id: (event as any).messageId,
          },
        };

      case 'user_message' as any:
        return {
          type: 'user_message',
          data: {
            content: (event as any).content,
            message_id: (event as any).messageId,
            user_name: (event as any).userName,
          },
        };

      // Internal events — don't send to chatbot clients
      case 'turn_start':
      case 'turn_complete':
      case 'thinking':
      case 'tool_progress':
      case 'input_injected':
        return null;

      default:
        return null;
    }
  }

  private async registerStaticFiles(): Promise<void> {
    const currentDir = typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));
    // Walk up from dist/gateway/channels/ to dist/
    const webDir = path.resolve(currentDir, '..', '..', '..', 'dist', 'web');
    const webDirAlt = path.resolve(process.cwd(), 'dist', 'web');
    const staticDir = fs.existsSync(webDir) ? webDir : fs.existsSync(webDirAlt) ? webDirAlt : null;

    if (staticDir) {
      await this.app!.register(fastifyStatic, {
        root: staticDir,
        prefix: '/',
        decorateReply: false,
      });
      this.app!.setNotFoundHandler((_req, reply) => {
        const indexPath = path.join(staticDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          return reply.type('text/html').send(fs.createReadStream(indexPath));
        }
        return reply.status(404).send({ error: 'Not found' });
      });
    }
  }
}
