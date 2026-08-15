/**
 * iMessage Channel — connects the agent to iMessage via BlueBubbles API.
 *
 * Uses a self-hosted BlueBubbles server (https://bluebubbles.app/) as a
 * bridge to iMessage. Requires a Mac with Messages.app running.
 *
 * Receives messages via BlueBubbles webhook (HTTP POST).
 * Sends responses via BlueBubbles REST API.
 *
 * Features:
 * - Webhook-based message reception
 * - Message chunking for long responses (no hard limit, but 2000 chars recommended)
 * - Allowed handle filtering (security — limit to specific contacts)
 * - Read receipts (marks messages as read)
 * - Typing indicator support
 *
 * Setup:
 * 1. Install BlueBubbles on a Mac (always-on, signed into iMessage)
 * 2. Configure the server URL and password
 * 3. Set webhook URL in BlueBubbles to: http://your-host:PORT/webhook
 * 4. Enable "New Message" webhook event
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage, IMessageChannelConfig } from '../types.js';
import type { DeliveryQueue, DeliveryEntry } from '../delivery-queue.js';
import { logger } from '../../utils/logger.js';

const MAX_MESSAGE_LENGTH = 2000;

/** Active response being prepared for an iMessage conversation. */
interface ActiveResponse {
  chatGuid: string;
  accumulated: string;
  toolCalls: string[];
  complete: boolean;
  resolve: () => void;
}

/** Serializable payload for the delivery queue. */
interface IMessagePayload {
  chatGuid: string;
  text: string;
}

export class IMessageChannel implements Channel {
  readonly id: string;
  readonly type = 'imessage' as const;

  private inbox: Inbox | null = null;
  private server: http.Server | null = null;
  private serverUrl: string;
  private password: string;
  private webhookPort: number;
  private allowedHandles: Set<string> | null;
  private running = false;
  private deliveryQueue: DeliveryQueue | null = null;

  private activeResponses = new Map<string, ActiveResponse>();
  private processedMessages = new Set<string>();
  private dedupeCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Known chat GUIDs — used for fan-out broadcasts. */
  private knownChats = new Set<string>();
  /** Accumulated fan-out content per origin thread. */
  private fanOutBuffers = new Map<string, string>();

  constructor(config: IMessageChannelConfig) {
    this.id = `imessage-${crypto.randomUUID().slice(0, 8)}`;
    this.serverUrl = config.serverUrl.replace(/\/+$/, '');
    this.password = config.password;
    this.webhookPort = config.webhookPort ?? 8019;
    this.allowedHandles = config.allowedHandles?.length
      ? new Set(config.allowedHandles.map((h) => h.toLowerCase()))
      : null;
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.running = true;

    // Verify BlueBubbles server is reachable
    try {
      const res = await fetch(`${this.serverUrl}/api/v1/server/info?password=${encodeURIComponent(this.password)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { data?: { os_version?: string; server_version?: string } };
      logger.info({
        osVersion: data.data?.os_version,
        serverVersion: data.data?.server_version,
      }, 'BlueBubbles server connected');
    } catch (err) {
      throw new Error(`BlueBubbles server unreachable at ${this.serverUrl}: ${(err as Error).message}`);
    }

    // Start webhook server
    await this.startWebhookServer();

    // Periodically clean deduplication set
    this.dedupeCleanupTimer = setInterval(() => {
      this.processedMessages.clear();
    }, 5 * 60 * 1000);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.dedupeCleanupTimer) {
      clearInterval(this.dedupeCleanupTimer);
      this.dedupeCleanupTimer = null;
    }

    for (const [, resp] of this.activeResponses) {
      resp.resolve();
    }
    this.activeResponses.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  async sendEvent(threadId: string, event: AgentEvent): Promise<void> {
    const resp = this.activeResponses.get(threadId);
    if (!resp) return;

    switch (event.type) {
      case 'content':
        resp.accumulated += event.text;
        break;

      case 'tool_start':
        resp.toolCalls.push(event.toolName);
        // Send typing indicator
        this.sendTypingIndicator(resp.chatGuid).catch(() => {});
        break;

      case 'tool_complete': {
        const idx = resp.toolCalls.indexOf(event.toolName);
        if (idx >= 0) resp.toolCalls.splice(idx, 1);
        break;
      }

      case 'error':
        resp.accumulated += `\n\nError: ${event.error}`;
        break;

      case 'complete':
        resp.complete = true;
        await this.sendFinalResponse(resp);
        break;
    }
  }

  sendComplete(threadId: string): void {
    const resp = this.activeResponses.get(threadId);
    if (!resp) return;
    resp.resolve();
    this.activeResponses.delete(threadId);
  }

  setDeliveryQueue(queue: DeliveryQueue): void {
    this.deliveryQueue = queue;
    this.deliveryQueue.registerHandler('imessage', async (entry: DeliveryEntry) => {
      const payload = entry.payload as IMessagePayload;
      await this.sendChunkedMessage(payload.chatGuid, payload.text);
    });
  }

  notifyBusy(threadId: string, _queuePosition: number): void {
    const chatGuid = threadId.split(':')[0]!;
    this.sendTypingIndicator(chatGuid).catch(() => {});
  }

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
        if (!text?.trim()) break;

        const originChat = threadId.split(':')[0]!;
        const msg = `[Fan-out from ${originChannelId}]\n\n${text}`;
        for (const chatGuid of this.knownChats) {
          if (chatGuid === originChat) continue;
          await this.sendChunkedMessage(chatGuid, msg).catch(() => {});
        }
        break;
      }
      case 'error': {
        const prev = this.fanOutBuffers.get(key) ?? '';
        this.fanOutBuffers.set(key, prev + `\n\nError: ${event.error}`);
        break;
      }
    }
  }

  // ── Webhook Server ──

  private startWebhookServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleWebhookRequest(req, res);
      });

      this.server.on('error', (err) => {
        logger.error({ err }, 'iMessage webhook server error');
        reject(err);
      });

      this.server.listen(this.webhookPort, '0.0.0.0', () => {
        logger.info({ port: this.webhookPort }, 'iMessage webhook server started');
        resolve();
      });
    });
  }

  private handleWebhookRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200);
        res.end('OK');

        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          this.processWebhookPayload(body);
        } catch (err) {
          logger.warn({ err }, 'Failed to parse iMessage webhook payload');
        }
      });
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', channel: 'imessage' }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  private processWebhookPayload(payload: any): void {
    // BlueBubbles webhook event types: "new-message", "updated-message", "typing-indicator", etc.
    const eventType = payload.type;
    if (eventType !== 'new-message') return;

    const data = payload.data;
    if (!data) return;

    this.handleIMessage(data).catch((err) => {
      logger.error({ err }, 'Error handling iMessage');
    });
  }

  // ── Message Handling ──

  private async handleIMessage(msg: any): Promise<void> {
    const guid = msg.guid as string;
    if (!guid) return;

    // Deduplicate
    if (this.processedMessages.has(guid)) return;
    this.processedMessages.add(guid);

    // Skip messages sent by us
    if (msg.isFromMe) return;

    const handle = (msg.handle?.address || msg.sender || '').toLowerCase();
    const chatGuid = msg.chats?.[0]?.guid || `iMessage;-;${handle}`;

    // Security: check allowed handles
    if (this.allowedHandles && !this.allowedHandles.has(handle)) {
      logger.debug({ handle }, 'Ignoring iMessage from non-allowed handle');
      return;
    }

    const content = msg.text || '';
    if (!content && !msg.attachments?.length) return;

    const threadId = `${chatGuid}:${guid}`;

    this.knownChats.add(chatGuid);

    // Mark as read
    this.markAsRead(chatGuid).catch(() => {});

    let resolvePromise: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const activeResp: ActiveResponse = {
      chatGuid,
      accumulated: '',
      toolCalls: [],
      complete: false,
      resolve: resolvePromise!,
    };
    this.activeResponses.set(threadId, activeResp);

    const inbound: InboundMessage = {
      id: crypto.randomUUID(),
      channelId: this.id,
      channelType: 'imessage',
      threadId,
      userId: handle || 'unknown',
      userName: msg.handle?.address || handle,
      content: msg.attachments?.length
        ? `${content}\n[${msg.attachments.length} attachment(s)]`
        : content,
      timestamp: msg.dateCreated ? new Date(msg.dateCreated).getTime() : Date.now(),
      metadata: { chatGuid, messageGuid: guid, handle },
    };

    this.inbox!.push(inbound);
    await promise;
  }

  // ── Response Sending ──

  private async sendFinalResponse(resp: ActiveResponse): Promise<void> {
    if (!resp.accumulated) return;

    const payload: IMessagePayload = { chatGuid: resp.chatGuid, text: resp.accumulated };

    if (this.deliveryQueue) {
      const entryId = await this.deliveryQueue.enqueue('imessage', resp.chatGuid, payload);
      if (entryId) {
        try {
          await this.sendChunkedMessage(resp.chatGuid, resp.accumulated);
          await this.deliveryQueue.ack(entryId);
        } catch (err) {
          await this.deliveryQueue.failDelivery(entryId, (err as Error).message ?? String(err));
        }
        return;
      }
    }

    try {
      await this.sendChunkedMessage(resp.chatGuid, resp.accumulated);
    } catch (err) {
      logger.warn({ err, chatGuid: resp.chatGuid }, 'Failed to send iMessage');
    }
  }

  private async sendChunkedMessage(chatGuid: string, text: string): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      const res = await fetch(
        `${this.serverUrl}/api/v1/message/text?password=${encodeURIComponent(this.password)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatGuid,
            message: chunk,
            method: 'apple-script',
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`BlueBubbles send failed: HTTP ${res.status} ${body}`);
      }
    }
  }

  /** Send typing indicator via BlueBubbles. */
  private async sendTypingIndicator(chatGuid: string): Promise<void> {
    try {
      await fetch(
        `${this.serverUrl}/api/v1/chat/${encodeURIComponent(chatGuid)}/typing?password=${encodeURIComponent(this.password)}`,
        { method: 'POST' },
      );
    } catch {
      // Non-critical
    }
  }

  /** Mark chat as read via BlueBubbles. */
  private async markAsRead(chatGuid: string): Promise<void> {
    try {
      await fetch(
        `${this.serverUrl}/api/v1/chat/${encodeURIComponent(chatGuid)}/read?password=${encodeURIComponent(this.password)}`,
        { method: 'POST' },
      );
    } catch {
      // Non-critical
    }
  }
}

// ── Helpers ──

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH * 0.3) {
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}
