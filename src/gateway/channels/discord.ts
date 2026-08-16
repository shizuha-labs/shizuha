/**
 * Discord Channel — connects the agent to Discord via Gateway WebSocket + REST API.
 *
 * Uses the Discord Gateway (WebSocket) to receive messages and the REST API
 * to send/edit responses. No discord.js dependency — raw protocol implementation.
 *
 * Features:
 * - Gateway WebSocket with heartbeat, identify, resume, reconnect
 * - Typing indicator while agent processes
 * - Progressive message editing (streaming feel)
 * - Message chunking for long responses (2000 char limit)
 * - Standard Discord markdown (code blocks, bold, etc.)
 * - Allowed guild ID filtering (security)
 * - Respond modes: mention-only, DM-only, or all
 * - Thread support (replies in same channel)
 */

import * as crypto from 'node:crypto';
// @ts-ignore — ws has no declaration file in this project
import WebSocket from 'ws';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage, DiscordChannelConfig } from '../types.js';
import type { DeliveryQueue, DeliveryEntry } from '../delivery-queue.js';
import { logger } from '../../utils/logger.js';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const MAX_MESSAGE_LENGTH = 2000;
const EDIT_DEBOUNCE_MS = 1000;  // Min time between message edits
const TYPING_INTERVAL_MS = 8000; // Discord typing lasts 10s, resend every 8s
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Gateway Opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Intents (bitmask)
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15; // Privileged — required for reading message text

/** Active response being streamed back to a Discord channel. */
interface ActiveResponse {
  channelId: string;
  sentMessageId: string | null;  // The bot's response message (null until first send)
  replyToMessageId: string;      // The user's message we're replying to
  accumulated: string;           // Full accumulated text
  lastEditAt: number;            // Timestamp of last edit
  editTimer: NodeJS.Timeout | null;
  typingTimer: NodeJS.Timeout | null;
  toolCalls: string[];           // Active tool names
  complete: boolean;
  resolve: () => void;
}

/** Serializable payload for the delivery queue. */
interface DiscordPayload {
  channelId: string;
  text: string;
  replyToMessageId?: string;
}

export class DiscordChannel implements Channel {
  readonly id: string;
  readonly type = 'discord' as const;

  private inbox: Inbox | null = null;
  private ws: WebSocket | null = null;
  private botToken: string;
  private allowedGuildIds: Set<string> | null;
  private respondMode: 'mention' | 'dm' | 'all';
  private running = false;

  // Gateway state
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatAcked = true;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // Bot identity
  private botUserId = '';
  private botUsername = '';

  // Active responses
  private activeResponses = new Map<string, ActiveResponse>(); // threadId → response
  private deliveryQueue: DeliveryQueue | null = null;

  /** Channel IDs that have interacted with the bot — used for fan-out broadcasts. */
  private knownChannelIds = new Set<string>();
  /** Accumulated fan-out content per origin thread (sent on complete). */
  private fanOutBuffers = new Map<string, string>();

  constructor(config: DiscordChannelConfig) {
    this.id = 'discord-bot';
    this.botToken = config.botToken;
    this.allowedGuildIds = config.allowedGuildIds?.length
      ? new Set(config.allowedGuildIds)
      : null;
    this.respondMode = config.respondMode ?? 'mention';
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.running = true;

    // Verify bot token by fetching bot user info
    const me = await this.apiCall('GET', '/users/@me');
    if (!me?.id) {
      throw new Error(`Discord bot token invalid: ${JSON.stringify(me)}`);
    }
    this.botUserId = me.id;
    this.botUsername = me.username;
    logger.info({
      botUsername: this.botUsername,
      botId: this.botUserId,
    }, 'Discord bot verified');

    // Connect to Gateway
    this.connectGateway();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Clean up active responses
    for (const [, resp] of this.activeResponses) {
      if (resp.editTimer) clearTimeout(resp.editTimer);
      if (resp.typingTimer) clearInterval(resp.typingTimer);
      resp.resolve();
    }
    this.activeResponses.clear();

    if (this.ws) {
      this.ws.close(1000, 'Agent shutting down');
      this.ws = null;
    }
  }

  async sendEvent(threadId: string, event: AgentEvent): Promise<void> {
    const resp = this.activeResponses.get(threadId);
    if (!resp) return;

    switch (event.type) {
      case 'content':
        resp.accumulated += event.text;
        this.scheduleEdit(threadId, resp);
        break;

      case 'tool_start':
        resp.toolCalls.push(event.toolName);
        this.triggerTyping(resp);
        break;

      case 'tool_complete': {
        const idx = resp.toolCalls.indexOf(event.toolName);
        if (idx >= 0) resp.toolCalls.splice(idx, 1);
        break;
      }

      case 'error':
        resp.accumulated += `\n\n> **Error:** ${event.error}`;
        await this.flushEdit(threadId, resp);
        break;

      case 'complete':
        resp.complete = true;
        // Enqueue final message for crash-safe delivery before attempting send
        if (this.deliveryQueue && resp.accumulated) {
          const payload: DiscordPayload = {
            channelId: resp.channelId,
            text: resp.accumulated,
            replyToMessageId: resp.replyToMessageId,
          };
          const entryId = await this.deliveryQueue.enqueue('discord', resp.channelId, payload);
          await this.flushEdit(threadId, resp);
          // Ack after successful send
          if (entryId) await this.deliveryQueue.ack(entryId);
        } else {
          await this.flushEdit(threadId, resp);
        }
        break;
    }
  }

  sendComplete(threadId: string): void {
    const resp = this.activeResponses.get(threadId);
    if (!resp) return;

    if (resp.editTimer) clearTimeout(resp.editTimer);
    if (resp.typingTimer) clearInterval(resp.typingTimer);
    resp.resolve();
    this.activeResponses.delete(threadId);
  }

  setDeliveryQueue(queue: DeliveryQueue): void {
    this.deliveryQueue = queue;
    this.deliveryQueue.registerHandler('discord', async (entry: DeliveryEntry) => {
      const payload = entry.payload as DiscordPayload;
      const chunks = splitMessage(payload.text);
      for (const chunk of chunks) {
        const result = await this.apiCall('POST', `/channels/${payload.channelId}/messages`, {
          content: chunk,
        });
        if (result?.code || result?.message) {
          throw new Error(result.message ?? 'Discord API error');
        }
      }
    });
  }

  notifyBusy(threadId: string, queuePosition: number): void {
    const parts = threadId.split(':');
    const channelId = parts[0]!;
    if (queuePosition === 1) {
      this.apiCall('POST', `/channels/${channelId}/typing`).catch(() => {});
    }
  }

  /**
   * Fan-out: receive events from another channel's execution.
   * Accumulates content and sends a single summary message to all known
   * Discord channels on completion — avoids hammering Discord's rate limits.
   */
  async broadcastEvent(event: AgentEvent, originChannelId: string, threadId: string): Promise<void> {
    const key = `${originChannelId}:${threadId}`;

    switch (event.type) {
      case 'content': {
        const prev = this.fanOutBuffers.get(key) ?? '';
        this.fanOutBuffers.set(key, prev + event.text);
        break;
      }

      case 'complete': {
        const text = this.fanOutBuffers.get(key);
        this.fanOutBuffers.delete(key);
        if (!text || text.trim().length === 0) break;

        // Send to all known channels (except the origin if it's a Discord channel)
        const originDiscordChannelId = threadId.split(':')[0]!;
        const header = `-# 📡 Fan-out from ${originChannelId}`;
        const chunks = splitMessage(`${header}\n\n${text}`);

        for (const chanId of this.knownChannelIds) {
          if (chanId === originDiscordChannelId) continue; // Don't echo back
          for (const chunk of chunks) {
            await this.apiCall('POST', `/channels/${chanId}/messages`, {
              content: chunk,
            }).catch(() => {});
          }
        }
        break;
      }

      case 'error': {
        const prev = this.fanOutBuffers.get(key) ?? '';
        this.fanOutBuffers.set(key, prev + `\n\n> **Error:** ${event.error}`);
        break;
      }
    }
  }

  // ── Discord Gateway ──

  private connectGateway(): void {
    const url = this.resumeGatewayUrl ?? DISCORD_GATEWAY_URL;

    logger.info({ url }, 'Connecting to Discord Gateway');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('Discord Gateway WebSocket opened');
      // Wait for Hello (OP 10) before identifying
    });

    this.ws.on('message', (data: any) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handleGatewayPayload(payload);
      } catch (err) {
        logger.warn({ err }, 'Failed to parse Discord Gateway message');
      }
    });

    this.ws.on('close', (code: number, reason: any) => {
      logger.info({ code, reason: reason?.toString() }, 'Discord Gateway disconnected');

      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }

      if (!this.running) return;

      // Certain close codes mean we should NOT resume
      const noResumeCodes = [4004, 4010, 4011, 4012, 4013, 4014];
      if (noResumeCodes.includes(code)) {
        logger.error({ code }, 'Discord Gateway fatal close code — cannot reconnect');
        // 4004 = authentication failed, 4014 = disallowed intents
        return;
      }

      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'Discord Gateway error');
      // 'close' event fires after this, triggering reconnect
    });
  }

  private handleGatewayPayload(payload: {
    op: number;
    d: any;
    s: number | null;
    t: string | null;
  }): void {
    // Update sequence number for heartbeating and resume
    if (payload.s !== null) {
      this.lastSequence = payload.s;
    }

    switch (payload.op) {
      case OP_HELLO:
        this.startHeartbeat(payload.d.heartbeat_interval);
        // Identify or resume
        if (this.sessionId && this.lastSequence !== null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;

      case OP_HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;

      case OP_HEARTBEAT:
        // Server requested immediate heartbeat
        this.sendHeartbeat();
        break;

      case OP_RECONNECT:
        // Server wants us to reconnect
        logger.info('Discord Gateway requested reconnect');
        this.ws?.close(4000, 'Server requested reconnect');
        break;

      case OP_INVALID_SESSION:
        // Can we resume?
        if (payload.d === true) {
          // Yes — wait a bit and resume
          setTimeout(() => this.sendResume(), 1000 + Math.random() * 4000);
        } else {
          // No — re-identify
          this.sessionId = null;
          this.lastSequence = null;
          setTimeout(() => this.sendIdentify(), 1000 + Math.random() * 4000);
        }
        break;

      case OP_DISPATCH:
        this.handleDispatch(payload.t!, payload.d);
        break;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    this.heartbeatAcked = true;

    // First heartbeat after random jitter (Discord docs)
    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      this.sendHeartbeat();

      this.heartbeatInterval = setInterval(() => {
        if (!this.heartbeatAcked) {
          // Zombie connection — reconnect
          logger.warn('Discord Gateway heartbeat not ACKed — reconnecting');
          this.ws?.close(4009, 'Heartbeat timeout');
          return;
        }
        this.heartbeatAcked = false;
        this.sendHeartbeat();
      }, intervalMs);
    }, jitter);
  }

  private sendHeartbeat(): void {
    this.gatewaySend({ op: OP_HEARTBEAT, d: this.lastSequence });
  }

  private sendIdentify(): void {
    const intents = INTENT_GUILDS | INTENT_GUILD_MESSAGES
      | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

    this.gatewaySend({
      op: OP_IDENTIFY,
      d: {
        token: this.botToken,
        intents,
        properties: {
          os: 'linux',
          browser: 'shizuha',
          device: 'shizuha',
        },
      },
    });
  }

  private sendResume(): void {
    this.gatewaySend({
      op: OP_RESUME,
      d: {
        token: this.botToken,
        session_id: this.sessionId,
        seq: this.lastSequence,
      },
    });
  }

  private gatewaySend(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    const jitter = delay * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt++;

    logger.info({
      attempt: this.reconnectAttempt,
      delayMs: Math.round(jitter),
    }, 'Scheduling Discord Gateway reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectGateway();
    }, jitter);
  }

  // ── Dispatch Events ──

  private handleDispatch(eventType: string, data: any): void {
    switch (eventType) {
      case 'READY':
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        this.botUserId = data.user.id;
        this.botUsername = data.user.username;
        this.reconnectAttempt = 0;
        logger.info({
          sessionId: this.sessionId,
          botUsername: this.botUsername,
          guilds: data.guilds?.length ?? 0,
        }, 'Discord Gateway ready');
        break;

      case 'RESUMED':
        this.reconnectAttempt = 0;
        logger.info('Discord Gateway session resumed');
        break;

      case 'MESSAGE_CREATE':
        this.handleMessage(data).catch((err) => {
          logger.error({ err }, 'Error handling Discord message');
        });
        break;

      // Other events we might care about in the future
      case 'GUILD_CREATE':
      case 'GUILD_DELETE':
        break;

      default:
        // Ignore other events silently
        break;
    }
  }

  // ── Message Handling ──

  private async handleMessage(msg: any): Promise<void> {
    // Ignore bot messages (including our own)
    if (msg.author?.bot) return;

    const guildId = msg.guild_id as string | undefined;
    const channelId = msg.channel_id as string;
    const messageId = msg.id as string;
    const isDM = !guildId; // No guild_id means DM

    // Security: check allowed guild IDs
    if (guildId && this.allowedGuildIds && !this.allowedGuildIds.has(guildId)) {
      return;
    }

    // Apply respond mode filter
    const isMentioned = (msg.mentions as any[])?.some((m: any) => m.id === this.botUserId);
    const mentionedInContent = (msg.content as string)?.includes(`<@${this.botUserId}>`);

    switch (this.respondMode) {
      case 'mention':
        // Respond to @mentions and DMs
        if (!isDM && !isMentioned && !mentionedInContent) return;
        break;
      case 'dm':
        // DMs only
        if (!isDM) return;
        break;
      case 'all':
        // Everything (in allowed guilds)
        break;
    }

    // Extract content
    let content = (msg.content as string) ?? '';

    // Strip bot mention from content
    content = content
      .replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '')
      .trim();

    // Handle attachments
    const attachments = msg.attachments as any[];
    if (attachments?.length > 0) {
      for (const att of attachments) {
        const desc = att.description
          ? `[${att.filename}: ${att.description}]`
          : `[File: ${att.filename}]`;
        content = content ? `${content}\n${desc}` : desc;
      }
    }

    if (!content) return;

    // Build thread ID: channelId:messageId (channelId needed for routing responses)
    const threadId = `${channelId}:${messageId}`;

    const userName = msg.author?.global_name
      ?? msg.author?.username
      ?? undefined;

    // Create response slot
    let resolvePromise: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const activeResp: ActiveResponse = {
      channelId,
      sentMessageId: null,
      replyToMessageId: messageId,
      accumulated: '',
      lastEditAt: 0,
      editTimer: null,
      typingTimer: null,
      toolCalls: [],
      complete: false,
      resolve: resolvePromise!,
    };

    this.activeResponses.set(threadId, activeResp);

    // Track this channel for fan-out broadcasts
    this.knownChannelIds.add(channelId);

    // Start typing indicator
    activeResp.typingTimer = setInterval(() => {
      this.apiCall('POST', `/channels/${channelId}/typing`).catch(() => {});
    }, TYPING_INTERVAL_MS);

    // Send initial typing
    await this.apiCall('POST', `/channels/${channelId}/typing`).catch(() => {});

    // Build inbound message
    const inbound: InboundMessage = {
      id: crypto.randomUUID(),
      channelId: this.id,
      channelType: 'discord',
      threadId,
      userId: msg.author?.id ?? 'unknown',
      userName,
      content,
      timestamp: new Date(msg.timestamp).getTime(),
      metadata: {
        guildId,
        channelId,
        messageId,
        isDM,
        channelName: msg.channel?.name,
      },
    };

    this.inbox!.push(inbound);

    // Wait for the agent to finish processing
    await promise;
  }

  // ── Response Streaming ──

  /** Schedule a debounced edit of the response message. */
  private scheduleEdit(threadId: string, resp: ActiveResponse): void {
    if (resp.editTimer) return; // Already scheduled

    const timeSinceLastEdit = Date.now() - resp.lastEditAt;
    const delay = Math.max(0, EDIT_DEBOUNCE_MS - timeSinceLastEdit);

    resp.editTimer = setTimeout(() => {
      resp.editTimer = null;
      this.flushEdit(threadId, resp);
    }, delay);
  }

  /** Send or edit the response message with current accumulated content. */
  private async flushEdit(threadId: string, resp: ActiveResponse): Promise<void> {
    if (!resp.accumulated && !resp.complete) return;

    const text = this.formatResponse(resp);
    if (!text) return;

    // Split into chunks if needed
    const chunks = splitMessage(text);

    try {
      if (!resp.sentMessageId) {
        // First chunk — send new message as a reply
        const result = await this.apiCall('POST', `/channels/${resp.channelId}/messages`, {
          content: chunks[0],
          message_reference: {
            message_id: resp.replyToMessageId,
          },
          allowed_mentions: {
            replied_user: false,
          },
        });
        if (result?.id) {
          resp.sentMessageId = result.id;
        }
      } else if (chunks.length === 1) {
        // Edit existing message
        await this.apiCall('PATCH',
          `/channels/${resp.channelId}/messages/${resp.sentMessageId}`,
          { content: chunks[0] },
        ).catch(() => {});
      }

      // Send additional chunks as new messages (for very long responses)
      if (resp.complete && chunks.length > 1) {
        for (let i = 1; i < chunks.length; i++) {
          await this.apiCall('POST', `/channels/${resp.channelId}/messages`, {
            content: chunks[i],
          }).catch(() => {});
        }
      }

      resp.lastEditAt = Date.now();
    } catch (err) {
      logger.warn({ err, channelId: resp.channelId }, 'Failed to send/edit Discord message');
    }
  }

  /** Format the response with tool status indicators. */
  private formatResponse(resp: ActiveResponse): string {
    let text = resp.accumulated;
    if (!text && resp.toolCalls.length === 0) return '';

    // Show active tools at the bottom
    if (resp.toolCalls.length > 0 && !resp.complete) {
      const toolLine = resp.toolCalls.map((t) => `\`${t}\``).join(' ');
      text = text ? `${text}\n\n-# Working: ${toolLine}` : `-# Working: ${toolLine}`;
    }

    // Add streaming indicator
    if (!resp.complete && text) {
      text += ' **|**';
    }

    return text;
  }

  /** Trigger typing indicator. */
  private triggerTyping(resp: ActiveResponse): void {
    this.apiCall('POST', `/channels/${resp.channelId}/typing`).catch(() => {});
  }

  // ── Discord REST API ──

  private async apiCall(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const url = `${DISCORD_API}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bot ${this.botToken}`,
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Discord returns 204 No Content for some endpoints (e.g., typing)
    if (res.status === 204) return null;

    // Handle rate limiting
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retryAfter = (data as any).retry_after ?? 1;
      logger.warn({ retryAfter, path }, 'Discord rate limited');
      await sleep(retryAfter * 1000);
      return this.apiCall(method, path, body); // Retry
    }

    return res.json();
  }
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split a message into chunks that fit Discord's 2000 char limit. */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      // No good newline — split at space
      splitAt = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH * 0.3) {
      // No good split point — hard cut
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
