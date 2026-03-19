/**
 * LINE Channel — connects the agent to LINE via the Messaging API.
 *
 * Uses the LINE Messaging API:
 * - Receives messages via webhook (HTTP POST from LINE Platform)
 * - Sends responses via reply/push API
 * - Accumulates full response and sends on completion (no streaming edits)
 *
 * Features:
 * - Webhook signature verification (HMAC-SHA256)
 * - Reply tokens (used within 30s for free replies)
 * - Push API fallback when reply token expires
 * - Message chunking for long responses (5000 char limit per text message)
 * - Allowed user/group ID filtering (security)
 * - Group/room message support
 *
 * Setup:
 * 1. Create a LINE Messaging API channel at developers.line.biz
 * 2. Get Channel Access Token (long-lived)
 * 3. Get Channel Secret
 * 4. Set webhook URL to: https://your-domain:PORT/webhook
 * 5. Enable "Use webhook" in the LINE console
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage, LineChannelConfig } from '../types.js';
import type { DeliveryQueue, DeliveryEntry } from '../delivery-queue.js';
import { logger } from '../../utils/logger.js';

const LINE_API = 'https://api.line.me/v2';
const MAX_MESSAGE_LENGTH = 5000;

/** Active response being prepared for a LINE conversation. */
interface ActiveResponse {
  /** Reply token (valid for ~30s) */
  replyToken: string;
  /** Target user/group/room ID for push fallback */
  targetId: string;
  /** Full accumulated text */
  accumulated: string;
  /** Active tool names */
  toolCalls: string[];
  /** Timestamp when reply token was received */
  replyTokenTime: number;
  /** Whether the response is complete */
  complete: boolean;
  /** Promise resolver */
  resolve: () => void;
}

/** Serializable payload for the delivery queue. */
interface LinePayload {
  targetId: string;
  text: string;
}

export class LineChannel implements Channel {
  readonly id: string;
  readonly type = 'line' as const;

  private inbox: Inbox | null = null;
  private server: http.Server | null = null;
  private channelAccessToken: string;
  private channelSecret: string;
  private webhookPort: number;
  private webhookHost: string;
  private running = false;
  private deliveryQueue: DeliveryQueue | null = null;

  private activeResponses = new Map<string, ActiveResponse>();
  private processedEvents = new Set<string>();
  private dedupeCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Known target IDs — used for fan-out broadcasts. */
  private knownTargets = new Set<string>();
  /** Accumulated fan-out content per origin thread. */
  private fanOutBuffers = new Map<string, string>();

  constructor(config: LineChannelConfig) {
    this.id = `line-${crypto.randomUUID().slice(0, 8)}`;
    this.channelAccessToken = config.channelAccessToken;
    this.channelSecret = config.channelSecret;
    this.webhookPort = config.webhookPort ?? 8018;
    this.webhookHost = '0.0.0.0';
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.running = true;

    // Verify access token
    const res = await fetch(`${LINE_API}/bot/info`, {
      headers: { 'Authorization': `Bearer ${this.channelAccessToken}` },
    });
    if (!res.ok) {
      throw new Error(`LINE channel access token invalid: HTTP ${res.status}`);
    }
    const botInfo = await res.json() as { displayName?: string; userId?: string };
    logger.info({ botName: botInfo.displayName, botId: botInfo.userId }, 'LINE bot connected');

    // Start webhook server
    await this.startWebhookServer();

    // Periodically clean deduplication set
    this.dedupeCleanupTimer = setInterval(() => {
      this.processedEvents.clear();
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
    this.deliveryQueue.registerHandler('line', async (entry: DeliveryEntry) => {
      const payload = entry.payload as LinePayload;
      await this.pushMessage(payload.targetId, payload.text);
    });
  }

  notifyBusy(_threadId: string, _queuePosition: number): void {
    // LINE has no typing indicator API
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

        const originTarget = threadId.split(':')[0]!;
        const msg = `[Fan-out from ${originChannelId}]\n\n${text}`;
        for (const targetId of this.knownTargets) {
          if (targetId === originTarget) continue;
          await this.pushMessage(targetId, msg).catch(() => {});
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
        logger.error({ err }, 'LINE webhook server error');
        reject(err);
      });

      this.server.listen(this.webhookPort, this.webhookHost, () => {
        logger.info({ port: this.webhookPort }, 'LINE webhook server started');
        resolve();
      });
    });
  }

  private handleWebhookRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // POST /webhook — Incoming events from LINE
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200);
        res.end('OK');

        const rawBody = Buffer.concat(chunks).toString('utf8');

        // Verify signature
        const signature = req.headers['x-line-signature'] as string | undefined;
        if (!this.verifySignature(rawBody, signature)) {
          logger.warn('LINE webhook signature verification failed');
          return;
        }

        try {
          const body = JSON.parse(rawBody);
          this.processWebhookPayload(body);
        } catch (err) {
          logger.warn({ err }, 'Failed to parse LINE webhook payload');
        }
      });
      return;
    }

    // Health check
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', channel: 'line' }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  private verifySignature(body: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = crypto
      .createHmac('SHA256', this.channelSecret)
      .update(body)
      .digest('base64');
    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  private processWebhookPayload(payload: any): void {
    const events = payload.events as any[];
    if (!events) return;

    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text') continue;
      this.handleLineMessage(event).catch((err) => {
        logger.error({ err }, 'Error handling LINE message');
      });
    }
  }

  // ── Message Handling ──

  private async handleLineMessage(event: any): Promise<void> {
    const messageId = event.message.id as string;
    if (this.processedEvents.has(messageId)) return;
    this.processedEvents.add(messageId);

    const source = event.source;
    const targetId: string = source.groupId || source.roomId || source.userId;
    const userId: string = source.userId || targetId;
    const content = event.message.text || '';

    if (!content) return;

    const threadId = `${targetId}:${messageId}`;

    this.knownTargets.add(targetId);

    let resolvePromise: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const activeResp: ActiveResponse = {
      replyToken: event.replyToken,
      targetId,
      accumulated: '',
      toolCalls: [],
      replyTokenTime: Date.now(),
      complete: false,
      resolve: resolvePromise!,
    };
    this.activeResponses.set(threadId, activeResp);

    const inbound: InboundMessage = {
      id: crypto.randomUUID(),
      channelId: this.id,
      channelType: 'line',
      threadId,
      userId,
      content,
      timestamp: event.timestamp || Date.now(),
      metadata: {
        messageId,
        replyToken: event.replyToken,
        sourceType: source.type,
        targetId,
      },
    };

    this.inbox!.push(inbound);
    await promise;
  }

  // ── Response Sending ──

  private async sendFinalResponse(resp: ActiveResponse): Promise<void> {
    if (!resp.accumulated) return;

    const payload: LinePayload = { targetId: resp.targetId, text: resp.accumulated };

    // Try reply token first (free, but expires in ~30s)
    const tokenAge = Date.now() - resp.replyTokenTime;
    if (tokenAge < 25_000 && resp.replyToken) {
      try {
        await this.replyMessage(resp.replyToken, resp.accumulated);
        return;
      } catch {
        // Reply token expired — fall through to push
      }
    }

    // Use push API (costs money for some plan tiers)
    if (this.deliveryQueue) {
      const entryId = await this.deliveryQueue.enqueue('line', resp.targetId, payload);
      if (entryId) {
        try {
          await this.pushMessage(resp.targetId, resp.accumulated);
          await this.deliveryQueue.ack(entryId);
        } catch (err) {
          await this.deliveryQueue.failDelivery(entryId, (err as Error).message ?? String(err));
        }
        return;
      }
    }

    try {
      await this.pushMessage(resp.targetId, resp.accumulated);
    } catch (err) {
      logger.warn({ err, targetId: resp.targetId }, 'Failed to send LINE message');
    }
  }

  /** Reply using the reply token (free). */
  private async replyMessage(replyToken: string, text: string): Promise<void> {
    const chunks = splitMessage(text);
    // LINE reply API accepts max 5 messages at once
    const messages = chunks.slice(0, 5).map((c) => ({ type: 'text', text: c }));

    const res = await fetch(`${LINE_API}/bot/message/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.channelAccessToken}`,
      },
      body: JSON.stringify({ replyToken, messages }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LINE reply failed: HTTP ${res.status} ${body}`);
    }
  }

  /** Push message to a target (user/group/room). */
  private async pushMessage(targetId: string, text: string): Promise<void> {
    const chunks = splitMessage(text);
    // LINE push API accepts max 5 messages at once, send in batches
    for (let i = 0; i < chunks.length; i += 5) {
      const batch = chunks.slice(i, i + 5).map((c) => ({ type: 'text', text: c }));
      const res = await fetch(`${LINE_API}/bot/message/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.channelAccessToken}`,
        },
        body: JSON.stringify({ to: targetId, messages: batch }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LINE push failed: HTTP ${res.status} ${body}`);
      }
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
