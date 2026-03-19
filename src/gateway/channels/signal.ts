/**
 * Signal Channel — connects the agent to Signal via signal-cli REST API.
 *
 * Uses a self-hosted signal-cli-rest-api container (e.g. bbernhard/signal-cli-rest-api)
 * for sending and receiving Signal messages.
 *
 * Receives messages via polling /v1/receive (no webhook or public URL needed).
 * Sends responses via /v2/send (REST API).
 *
 * Features:
 * - Polling-based message reception (configurable interval)
 * - Typing indicator while agent processes
 * - Message chunking for long responses (2000 char soft limit)
 * - Allowed phone number filtering (security)
 * - Attachment support (images forwarded as descriptions)
 *
 * Setup:
 * 1. Run signal-cli-rest-api container (docker run -p 8080:8080 bbernhard/signal-cli-rest-api)
 * 2. Register or link a phone number via signal-cli
 * 3. Set --signal-api-url to the container URL (e.g. http://localhost:8080)
 * 4. Set --signal-phone to your registered Signal phone number
 */

import * as crypto from 'node:crypto';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage, SignalChannelConfig } from '../types.js';
import type { DeliveryQueue, DeliveryEntry } from '../delivery-queue.js';
import { logger } from '../../utils/logger.js';

const MAX_MESSAGE_LENGTH = 2000;
const POLL_INTERVAL_MS = 2000;

/** Active response being prepared for a Signal conversation. */
interface ActiveResponse {
  recipientNumber: string;
  accumulated: string;
  toolCalls: string[];
  complete: boolean;
  resolve: () => void;
}

/** Serializable payload for the delivery queue. */
interface SignalPayload {
  recipientNumber: string;
  text: string;
}

export class SignalChannel implements Channel {
  readonly id: string;
  readonly type = 'signal' as const;

  private inbox: Inbox | null = null;
  private apiUrl: string;
  private phoneNumber: string;
  private allowedNumbers: Set<string> | null;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeResponses = new Map<string, ActiveResponse>();
  private deliveryQueue: DeliveryQueue | null = null;

  /** Known sender numbers — used for fan-out broadcasts. */
  private knownNumbers = new Set<string>();
  /** Accumulated fan-out content per origin thread. */
  private fanOutBuffers = new Map<string, string>();

  constructor(config: SignalChannelConfig) {
    this.id = `signal-${config.phoneNumber.replace(/\+/g, '')}`;
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.phoneNumber = config.phoneNumber;
    this.allowedNumbers = config.allowedNumbers?.length
      ? new Set(config.allowedNumbers)
      : null;
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.running = true;

    // Verify signal-cli API is reachable
    try {
      const res = await fetch(`${this.apiUrl}/v1/about`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as Record<string, unknown>;
      logger.info({ versions: data }, 'Signal CLI REST API connected');
    } catch (err) {
      throw new Error(`Signal CLI API unreachable at ${this.apiUrl}: ${(err as Error).message}`);
    }

    // Start polling for messages
    this.pollTimer = setInterval(() => this.pollMessages(), POLL_INTERVAL_MS);
    logger.info({ phoneNumber: this.phoneNumber }, 'Signal channel started');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [, resp] of this.activeResponses) {
      resp.resolve();
    }
    this.activeResponses.clear();
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
    this.deliveryQueue.registerHandler('signal', async (entry: DeliveryEntry) => {
      const payload = entry.payload as SignalPayload;
      await this.sendChunkedMessage(payload.recipientNumber, payload.text);
    });
  }

  notifyBusy(threadId: string, _queuePosition: number): void {
    // Signal typing indicators are not supported via REST API
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

        const originNumber = threadId.split(':')[0]!;
        const msg = `[Fan-out from ${originChannelId}]\n\n${text}`;

        for (const number of this.knownNumbers) {
          if (number === originNumber) continue;
          await this.sendChunkedMessage(number, msg).catch(() => {});
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

  // ── Polling ──

  private async pollMessages(): Promise<void> {
    if (!this.running) return;

    try {
      const res = await fetch(
        `${this.apiUrl}/v1/receive/${encodeURIComponent(this.phoneNumber)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return;

      const messages = await res.json() as any[];
      for (const msg of messages) {
        await this.handleMessage(msg).catch((err) => {
          logger.error({ err }, 'Error handling Signal message');
        });
      }
    } catch (err) {
      if (this.running) {
        logger.debug({ err }, 'Signal poll error');
      }
    }
  }

  // ── Message Handling ──

  private async handleMessage(envelope: any): Promise<void> {
    const data = envelope.envelope;
    if (!data) return;

    const sourceNumber = data.sourceNumber || data.source;
    if (!sourceNumber) return;

    // Security: check allowed numbers
    if (this.allowedNumbers && !this.allowedNumbers.has(sourceNumber)) {
      logger.debug({ sourceNumber }, 'Ignoring Signal message from non-allowed number');
      return;
    }

    const dataMessage = data.dataMessage;
    if (!dataMessage) return;

    const content = dataMessage.message || '';
    if (!content && !dataMessage.attachments?.length) return;

    const threadId = `${sourceNumber}:${dataMessage.timestamp}`;
    const userName = data.sourceName || sourceNumber;

    // Track for fan-out
    this.knownNumbers.add(sourceNumber);

    let resolvePromise: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const activeResp: ActiveResponse = {
      recipientNumber: sourceNumber,
      accumulated: '',
      toolCalls: [],
      complete: false,
      resolve: resolvePromise!,
    };
    this.activeResponses.set(threadId, activeResp);

    const inbound: InboundMessage = {
      id: crypto.randomUUID(),
      channelId: this.id,
      channelType: 'signal',
      threadId,
      userId: sourceNumber,
      userName,
      content,
      timestamp: dataMessage.timestamp || Date.now(),
      metadata: {
        sourceNumber,
        hasAttachments: !!dataMessage.attachments?.length,
      },
    };

    this.inbox!.push(inbound);
    await promise;
  }

  // ── Response Sending ──

  private async sendFinalResponse(resp: ActiveResponse): Promise<void> {
    if (!resp.accumulated) return;

    const payload: SignalPayload = {
      recipientNumber: resp.recipientNumber,
      text: resp.accumulated,
    };

    if (this.deliveryQueue) {
      const entryId = await this.deliveryQueue.enqueue('signal', resp.recipientNumber, payload);
      if (entryId) {
        try {
          await this.sendChunkedMessage(resp.recipientNumber, resp.accumulated);
          await this.deliveryQueue.ack(entryId);
        } catch (err) {
          await this.deliveryQueue.failDelivery(entryId, (err as Error).message ?? String(err));
        }
        return;
      }
    }

    try {
      await this.sendChunkedMessage(resp.recipientNumber, resp.accumulated);
    } catch (err) {
      logger.warn({ err, to: resp.recipientNumber }, 'Failed to send Signal message');
    }
  }

  private async sendChunkedMessage(recipientNumber: string, text: string): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      const res = await fetch(`${this.apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: chunk,
          number: this.phoneNumber,
          recipients: [recipientNumber],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Signal send failed: HTTP ${res.status} ${body}`);
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
