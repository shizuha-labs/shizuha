/**
 * Shizuha WebSocket Channel — connects the agent to the shizuha-agent platform.
 *
 * This channel acts as a WebSocket CLIENT, connecting outbound to the
 * shizuha-agent's /ws/runner/ endpoint. The platform routes messages
 * from web chat, Discord, Telegram, etc. to this agent via the WebSocket.
 *
 * Delivery guarantee (Kafka-style event log):
 *   1. Events are appended to a shared SQLite event log with auto-increment seq
 *   2. Each event gets a _seq number attached before sending
 *   3. On reconnect, the platform can replay missed events via cursor
 *   4. Zero per-client state on the server — clients track their own cursor
 *
 * Protocol matches shizuha-agent/agents/runner_consumer.py:
 * - Client connects, sends {"type": "auth", "token": "sza_..."}
 * - Server responds with auth_ok (agent config) or auth_error
 * - Server dispatches tasks as {"type": "execute", "messages": [...]}
 * - Client streams responses back as {"type": "stream_event", ...}
 * - Keepalive via ping/pong every 30 seconds
 */

import * as crypto from 'node:crypto';
// @ts-ignore — ws has no declaration file in this project
import WebSocket from 'ws';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage, ShizuhaWSChannelConfig } from '../types.js';
import { logger } from '../../utils/logger.js';
import { EventLog, isDurableEvent } from '../../daemon/event-log.js';

const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class ShizuhaWSChannel implements Channel {
  readonly id: string;
  readonly type = 'shizuha-ws' as const;

  private ws: WebSocket | null = null;
  private inbox: Inbox | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private running = false;
  private url: string;
  private token: string;
  private agentId?: string;
  private autoReconnect: boolean;
  private onAuthPending: ShizuhaWSChannelConfig['onAuthPending'];
  private onEvicted: ShizuhaWSChannelConfig['onEvicted'];

  /** Set when evicted by another runner — prevents reconnection. */
  private evicted = false;
  /** Set during WhatsApp-style "Use Here" auth pending flow. */
  private pendingAuth = false;
  /** Tracks whether auth completed successfully (prevents pre-auth sends). */
  private authenticated = false;
  /** Monotonic counter — prevents stale auth callbacks from acting on new connections. */
  private connectionGeneration = 0;

  /** Shared event log — durable events get _seq for cursor-based replay. */
  private eventLog: EventLog | null;

  constructor(config: ShizuhaWSChannelConfig) {
    this.id = `shizuha-ws-${config.agentId ?? 'default'}`;
    this.url = config.url;
    this.token = config.token;
    this.agentId = config.agentId;
    this.autoReconnect = config.reconnect ?? true;
    this.onAuthPending = config.onAuthPending;
    this.onEvicted = config.onEvicted;
    this.eventLog = config.eventLog ?? null;
  }

  /** Whether the channel is in auth-pending state (waiting for user decision). */
  get isPending(): boolean {
    return this.pendingAuth;
  }

  /** Whether this runner was evicted by another runner. */
  get isEvicted(): boolean {
    return this.evicted;
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.running = true;
    this.evicted = false;
    this.pendingAuth = false;
    this.authenticated = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Agent shutting down');
      this.ws = null;
    }
  }

  async sendEvent(threadId: string, event: AgentEvent): Promise<void> {
    const wsMsg = this.mapEventToProtocol(threadId, event);
    if (!wsMsg) return;

    // Append durable events to the event log (SQLite-backed, crash-safe).
    // Check the original AgentEvent type (not the wire format which wraps it as stream_event).
    if (this.eventLog && this.agentId && isDurableEvent({ type: event.type } as Record<string, unknown>)) {
      const seq = this.eventLog.append(this.agentId, wsMsg as Record<string, unknown>);
      (wsMsg as Record<string, unknown>)._seq = seq;
    }

    // Send immediately if connected and authenticated
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(wsMsg));
      } catch {
        // Connection lost — event is persisted in event log for cursor-based replay
      }
    }
    // If not connected, event is in the event log — clients replay via cursor
  }

  sendComplete(threadId: string): void {
    // Complete is sent as part of sendEvent for the 'complete' event type
    // No additional action needed
  }

  /**
   * Fan-out: forward an event from another channel's execution to the platform.
   * The platform can then relay it to connected web chat clients.
   * Uses the same stream_event protocol but tagged as fan-out.
   */
  async broadcastEvent(event: AgentEvent, originChannelId: string, threadId: string): Promise<void> {
    if (!this.authenticated || this.ws?.readyState !== WebSocket.OPEN) return;

    const wsMsg = this.mapEventToProtocol(threadId, event);
    if (!wsMsg) return;

    // Tag as fan-out so the platform can distinguish from normal execution events
    (wsMsg as Record<string, unknown>).fan_out = true;
    (wsMsg as Record<string, unknown>).origin_channel = originChannelId;

    try {
      this.ws.send(JSON.stringify(wsMsg));
    } catch {
      // Connection lost — event will be missed (fan-out is best-effort)
    }
  }

  // ── Private ──

  private connect(): void {
    this.connectionGeneration++;
    this.pendingAuth = false;
    this.authenticated = false;

    const wsUrl = `${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`;

    logger.info({ url: this.url, agentId: this.agentId }, 'Connecting to shizuha-agent');

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      logger.info({ url: this.url }, 'Connected to shizuha-agent');
      this.reconnectAttempt = 0;

      // Authenticate with runner token (RunnerConsumer requires explicit auth message)
      this.ws!.send(JSON.stringify({
        type: 'auth',
        token: this.token,
        runner_version: '0.1.0',
      }));
      // Keepalive starts after auth_ok — see handleServerMessage
    });

    this.ws.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleServerMessage(msg);
      } catch (err) {
        logger.warn({ err, data: data.toString().slice(0, 200) }, 'Failed to parse WS message');
      }
    });

    this.ws.on('close', (code: number, reason: any) => {
      logger.info({ code, reason: reason.toString() }, 'Disconnected from shizuha-agent');

      this.authenticated = false;
      this.ws = null;

      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }

      // Close codes that should NOT trigger reconnection:
      //   4010 — evicted by another runner
      //   4011 — user chose "use_local" (voluntary cancel)
      //   4012 — auth pending timed out
      //   4013 — another auth attempt in progress (server-side lock)
      const noReconnectCodes = [4010, 4011, 4012, 4013];
      const shouldReconnect = this.running
        && this.autoReconnect
        && !this.evicted
        && !noReconnectCodes.includes(code);

      if (shouldReconnect) {
        this.scheduleReconnect();
      } else if (noReconnectCodes.includes(code) || this.evicted) {
        logger.info(
          { code, evicted: this.evicted },
          'Not reconnecting — eviction or voluntary disconnect',
        );
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'WebSocket error');
      // The 'close' event will fire after this, triggering reconnect
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    // Add jitter (±25%)
    const jitter = delay * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt++;

    logger.info({
      attempt: this.reconnectAttempt,
      delayMs: Math.round(jitter),
    }, 'Scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jitter);
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    switch (type) {
      case 'pong':
        // Keepalive response — nothing to do
        break;

      case 'auth_ok': {
        const agent = msg.agent as Record<string, unknown>;
        this.pendingAuth = false;
        this.authenticated = true;
        logger.info({
          agentName: agent?.name,
          tokenPrefix: msg.token_prefix,
        }, 'Authenticated with platform');

        // Start keepalive — RunnerConsumer expects {"type": "heartbeat"}
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: 'heartbeat',
              runner_version: '0.1.0',
            }));
          }
        }, PING_INTERVAL_MS);
        break;
      }

      case 'auth_error':
        logger.error({ message: msg.message }, 'Platform auth failed');
        break;

      case 'auth_pending': {
        // Another runner is already connected — WhatsApp "Use Here" flow.
        // Ask the user/daemon what to do: evict or use_local.
        if (this.pendingAuth) {
          logger.warn('Duplicate auth_pending received — ignoring');
          break;
        }
        this.pendingAuth = true;
        const existingRunners = msg.existing_runners as Array<{
          agent_name: string;
          token_prefix: string;
          connected_at: string;
          runner_version: string;
        }>;
        const pendingMsg = msg.message as string;
        logger.warn(
          { existingRunners, message: pendingMsg },
          'Auth pending — another runner is connected for this agent',
        );

        // Capture the connection generation so the callback can't act on a
        // newer connection if this one closes and reconnects in the meantime.
        const gen = this.connectionGeneration;

        if (this.onAuthPending) {
          // Callback decides: 'evict' or 'use_local'
          this.onAuthPending({ existingRunners, message: pendingMsg })
            .then((action) => {
              if (this.connectionGeneration !== gen) {
                logger.warn('auth_pending callback resolved after reconnect — ignoring');
                return;
              }
              this.confirmAuth(action);
            })
            .catch((err) => {
              logger.error({ err }, 'onAuthPending callback failed — defaulting to use_local');
              if (this.connectionGeneration === gen) {
                this.confirmAuth('use_local');
              }
            });
        } else {
          // No callback — default to use_local (safe, no auto-eviction)
          logger.info('No onAuthPending callback — defaulting to use_local');
          this.confirmAuth('use_local');
        }
        break;
      }

      case 'evicted': {
        // This runner has been evicted by another runner — do NOT reconnect.
        const reason = (msg.reason as string) ?? 'Evicted by newer runner';
        this.evicted = true;
        this.pendingAuth = false;
        logger.warn({ reason }, 'Runner evicted by platform');
        this.onEvicted?.(reason);
        break;
      }

      case 'auth_cancelled':
        // Server confirms we chose "use_local" — connection will close with 4011
        this.pendingAuth = false;
        logger.info({ message: msg.message }, 'Auth cancelled — running in local mode');
        break;

      case 'auth_timeout':
        // Server closed because we took too long to confirm
        this.pendingAuth = false;
        logger.warn({ message: msg.message }, 'Auth pending timed out');
        break;

      case 'execute': {
        // Platform dispatched a task — extract messages and route to inbox
        const messages = msg.messages as Array<Record<string, unknown>>;
        const lastUserMsg = messages?.findLast((m) => m.role === 'user');
        const content = (lastUserMsg?.content as string) ?? '';

        if (!content) {
          logger.warn({ msg }, 'Received execute with no user message');
          break;
        }

        const inbound: InboundMessage = {
          id: crypto.randomUUID(),
          channelId: this.id,
          channelType: 'shizuha-ws',
          threadId: (msg.session_id as string) ?? crypto.randomUUID(),
          userId: 'platform',
          userName: 'Platform',
          content,
          timestamp: Date.now(),
          agentId: this.agentId,
          platformSessionId: msg.session_id as string,
          executionId: msg.session_id as string,
          metadata: {
            config: msg.config,
            allMessages: messages,
          },
        };

        this.inbox!.push(inbound);
        break;
      }

      case 'cancel':
        logger.info({ sessionId: msg.session_id }, 'Platform cancelled execution');
        break;

      case 'gateway_credentials': {
        const env = msg.env as Record<string, string>;
        if (env) {
          // Update process environment with refreshed credentials
          for (const [key, value] of Object.entries(env)) {
            process.env[key] = value;
          }
          logger.info({ keys: Object.keys(env) }, 'Received refreshed gateway credentials');
        }
        break;
      }

      case 'mcp_config':
        logger.info({ servers: msg.servers }, 'Received MCP server config');
        break;

      case 'message':
      case 'user_message': {
        // A message routed to this agent by the platform
        const content = (msg.content as string)
          ?? (msg.data as Record<string, unknown>)?.content as string
          ?? '';

        if (!content) {
          logger.warn({ msg }, 'Received empty message from platform');
          break;
        }

        const inbound: InboundMessage = {
          id: (msg.message_id as string) ?? crypto.randomUUID(),
          channelId: this.id,
          channelType: 'shizuha-ws',
          threadId: (msg.execution_id as string) ?? (msg.session_id as string) ?? crypto.randomUUID(),
          userId: (msg.user_id as string) ?? 'unknown',
          userName: (msg.username as string) ?? (msg.user_name as string),
          content,
          timestamp: Date.now(),
          agentId: msg.agent_id as string,
          platformSessionId: msg.session_id as string,
          executionId: msg.execution_id as string,
          model: msg.model as string,
          metadata: {
            sourceService: (msg.data as Record<string, unknown>)?.source_service,
            channelSource: (msg.data as Record<string, unknown>)?.channel_source,
          },
        };

        this.inbox!.push(inbound);
        break;
      }

      case 'session_created':
        logger.info({
          sessionId: msg.session_id,
          agentId: msg.agent_id,
        }, 'Platform created session');
        break;

      case 'sync_history': {
        // Historical messages from the platform — could use for recovery
        const messages = (msg.data as Record<string, unknown>)?.messages as unknown[];
        if (messages?.length) {
          logger.info({ count: messages.length }, 'Received sync history from platform');
        }
        break;
      }

      case 'proactive_message': {
        // Server-pushed message (e.g., another bot completed a task)
        const data = msg.data as Record<string, unknown>;
        const proactiveContent = data?.content as string;
        if (proactiveContent) {
          const inbound: InboundMessage = {
            id: (data.message_id as string) ?? crypto.randomUUID(),
            channelId: this.id,
            channelType: 'shizuha-ws',
            threadId: (msg.session_id as string) ?? crypto.randomUUID(),
            userId: 'system',
            userName: 'System',
            content: proactiveContent,
            timestamp: Date.now(),
            metadata: { proactive: true },
          };
          this.inbox!.push(inbound);
        }
        break;
      }

      case 'busy': {
        const data = msg.data as Record<string, unknown>;
        logger.info({
          executionId: data?.in_flight_execution_id,
          retryAfter: data?.retry_after_ms,
        }, 'Platform reports session busy');
        break;
      }

      case 'error': {
        const data = msg.data as Record<string, unknown>;
        logger.error({ error: msg.message ?? data?.message ?? msg.error }, 'Platform error');
        break;
      }

      case 'presence':
        // Agent/user presence updates — informational
        break;

      default:
        logger.debug({ type }, 'Unhandled platform message type');
    }
  }

  /**
   * Send auth confirmation to the platform (WhatsApp "Use Here" flow).
   * @param action - 'evict' to take over from the existing runner,
   *                 'use_local' to disconnect and run locally.
   */
  confirmAuth(action: 'evict' | 'use_local'): void {
    if (!this.pendingAuth) {
      logger.warn('confirmAuth called but no auth is pending');
      return;
    }
    if (this.ws?.readyState !== WebSocket.OPEN) {
      logger.warn('confirmAuth called but WebSocket is not open');
      return;
    }

    this.pendingAuth = false;
    this.ws.send(JSON.stringify({
      type: 'auth_confirm',
      action,
    }));

    logger.info({ action }, 'Sent auth_confirm to platform');
  }

  /**
   * Map an AgentEvent to the shizuha-agent WebSocket protocol.
   * Returns null if the event doesn't need to be sent.
   *
   * Protocol (matches runner_consumer.py):
   *   stream events → {"type": "stream_event", "session_id", "event": {type, data}}
   *   complete      → {"type": "execution_complete", "session_id", "result": {...}}
   *   error         → {"type": "execution_error", "session_id", "error": "..."}
   */
  private mapEventToProtocol(
    threadId: string,
    event: AgentEvent,
  ): Record<string, unknown> | null {
    // threadId is the execution_id from the platform
    const base = {
      session_id: threadId,
      execution_id: threadId,
      agent_id: this.agentId,
    };

    switch (event.type) {
      case 'content':
        return {
          type: 'stream_event',
          ...base,
          event: { type: 'content', data: { delta: event.text } },
        };

      case 'reasoning':
        return {
          type: 'stream_event',
          ...base,
          event: { type: 'reasoning', data: { summaries: event.summaries } },
        };

      case 'tool_start':
        return {
          type: 'stream_event',
          ...base,
          event: {
            type: 'tool_start',
            data: {
              tool: event.toolName,
              input: event.input,
              tool_call_id: event.toolCallId,
            },
          },
        };

      case 'tool_complete':
        return {
          type: 'stream_event',
          ...base,
          event: {
            type: 'tool_complete',
            data: {
              tool: event.toolName,
              duration_ms: event.durationMs,
              is_error: event.isError,
            },
          },
        };

      case 'complete':
        return {
          type: 'execution_complete',
          ...base,
          result: {
            total_turns: event.totalTurns,
            input_tokens: event.totalInputTokens,
            output_tokens: event.totalOutputTokens,
            duration_seconds: event.totalDurationMs / 1000,
          },
        };

      case 'error':
        return {
          type: 'execution_error',
          ...base,
          error: event.error,
        };

      case 'proactive_message':
        return {
          type: 'proactive_message',
          ...base,
          data: {
            content: (event as any).content,
            agent_id: (event as any).agentId,
            message_id: (event as any).messageId,
          },
        };

      // These are internal events — don't send to platform
      case 'session_start':
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
}
