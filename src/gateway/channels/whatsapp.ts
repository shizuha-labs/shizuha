/**
 * WhatsApp Channel — connects the agent to WhatsApp via the Cloud API.
 *
 * Uses the Meta WhatsApp Business Cloud API:
 * - Receives messages via webhook (HTTP POST from Meta)
 * - Sends responses via REST API (graph.facebook.com)
 * - Streams responses as progressive message edits (not supported by WA API,
 *   so we send the full response once complete, with typing indicators while processing)
 *
 * Features:
 * - Webhook verification (GET challenge for Meta setup)
 * - Message deduplication (Meta can send the same webhook multiple times)
 * - Read receipts (marks messages as read)
 * - Typing indicators ("recording" status while processing)
 * - Message chunking for long responses (4096 char limit)
 * - Allowed phone number filtering (security)
 * - Reply quoting (references the user's message)
 * - Media message handling (image/document/audio captions)
 *
 * Setup:
 * 1. Create a Meta App at developers.facebook.com
 * 2. Add WhatsApp product
 * 3. Get a permanent access token
 * 4. Set webhook URL to: https://your-domain/webhook
 * 5. Subscribe to "messages" webhook field
 * 6. Set verify token to match --whatsapp-verify-token
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage, WhatsAppChannelConfig } from '../types.js';
import type { DeliveryQueue, DeliveryEntry } from '../delivery-queue.js';
import { downloadImage, buildImageContent } from '../../utils/image.js';
import { logger } from '../../utils/logger.js';

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const MAX_MESSAGE_LENGTH = 4096;
const TYPING_INTERVAL_MS = 4000; // Resend "typing" every 4s (WA presence TTL ~5s)

/** Active response being prepared for a WhatsApp conversation. */
interface ActiveResponse {
  /** The user's phone number (wa_id) */
  waId: string;
  /** The user's original message ID (for reply quoting) */
  replyToMessageId: string;
  /** Full accumulated text */
  accumulated: string;
  /** Active tool names */
  toolCalls: string[];
  /** Typing indicator timer */
  typingTimer: NodeJS.Timeout | null;
  /** Whether the response is complete */
  complete: boolean;
  /** Promise resolver — signals handleMessage to return */
  resolve: () => void;
}

/** Serializable payload for the delivery queue. */
interface WhatsAppPayload {
  waId: string;
  replyToMessageId: string;
  text: string;
}

export class WhatsAppChannel implements Channel {
  readonly id: string;
  readonly type = 'whatsapp' as const;

  private inbox: Inbox | null = null;
  private server: http.Server | null = null;
  private accessToken: string;
  private phoneNumberId: string;
  private verifyToken: string;
  private webhookPort: number;
  private webhookHost: string;
  private allowedNumbers: Set<string> | null;
  private appSecret: string | null;
  private running = false;
  private deliveryQueue: DeliveryQueue | null = null;

  // Active responses: threadId (waId:messageId) → ActiveResponse
  private activeResponses = new Map<string, ActiveResponse>();

  // Deduplication: track recently processed message IDs
  private processedMessages = new Set<string>();
  private dedupeCleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: WhatsAppChannelConfig) {
    this.id = `whatsapp-${config.phoneNumberId}`;
    this.accessToken = config.accessToken;
    this.phoneNumberId = config.phoneNumberId;
    this.verifyToken = config.verifyToken;
    this.webhookPort = config.webhookPort ?? 8016;
    this.webhookHost = config.webhookHost ?? '0.0.0.0';
    this.allowedNumbers = config.allowedNumbers?.length
      ? new Set(config.allowedNumbers)
      : null;
    this.appSecret = config.appSecret ?? null;
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.running = true;

    // Verify access token by fetching phone number info
    const info = await this.apiCall('GET', `/${this.phoneNumberId}`);
    if (!info?.id) {
      throw new Error(`WhatsApp phone number ID invalid: ${JSON.stringify(info)}`);
    }
    logger.info({
      phoneNumberId: this.phoneNumberId,
      displayPhoneNumber: info.display_phone_number,
      verifiedName: info.verified_name,
    }, 'WhatsApp Business API verified');

    // Start webhook HTTP server
    await this.startWebhookServer();

    // Periodically clean up deduplication set (every 5 minutes)
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

    // Clean up active responses
    for (const [, resp] of this.activeResponses) {
      if (resp.typingTimer) clearInterval(resp.typingTimer);
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
        // Send images from tool results directly (screenshots, charts, etc.)
        if (event.image && !event.isError) {
          this.sendImage(resp.waId, event.image, event.toolName === 'Read' ? undefined : event.toolName).catch((err) => {
            logger.debug({ err }, 'Failed to send tool image via WhatsApp');
          });
        }
        // Send audio from tool results as voice messages (TTS, etc.)
        if (event.audio && !event.isError) {
          this.sendAudio(resp.waId, event.audio.base64).catch((err) => {
            logger.debug({ err }, 'Failed to send voice message via WhatsApp');
          });
        }
        break;
      }

      case 'error':
        resp.accumulated += `\n\n⚠️ Error: ${event.error}`;
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

    if (resp.typingTimer) clearInterval(resp.typingTimer);
    resp.resolve();
    this.activeResponses.delete(threadId);
  }

  setDeliveryQueue(queue: DeliveryQueue): void {
    this.deliveryQueue = queue;
    this.deliveryQueue.registerHandler('whatsapp', async (entry: DeliveryEntry) => {
      await this.deliverChunkedMessage(entry.payload as WhatsAppPayload);
    });
  }

  notifyBusy(threadId: string, _queuePosition: number): void {
    const parts = threadId.split(':');
    const waId = parts[0]!;
    // Show "typing" to indicate we received the message
    this.sendPresence(waId).catch(() => {});
  }

  // ── Webhook Server ──

  private startWebhookServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleWebhookRequest(req, res);
      });

      this.server.on('error', (err) => {
        logger.error({ err }, 'WhatsApp webhook server error');
        reject(err);
      });

      this.server.listen(this.webhookPort, this.webhookHost, () => {
        logger.info({
          port: this.webhookPort,
          host: this.webhookHost,
        }, 'WhatsApp webhook server started');
        resolve();
      });
    });
  }

  private handleWebhookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // GET /webhook — Meta verification challenge
    if (req.method === 'GET' && url.pathname === '/webhook') {
      this.handleVerification(url, res);
      return;
    }

    // POST /webhook — Incoming messages
    if (req.method === 'POST' && url.pathname === '/webhook') {
      this.handleIncomingWebhook(req, res);
      return;
    }

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', channel: 'whatsapp' }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  /** Handle Meta's webhook verification (GET with challenge). */
  private handleVerification(url: URL, res: http.ServerResponse): void {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === this.verifyToken) {
      logger.info('WhatsApp webhook verified');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge);
    } else {
      logger.warn({ mode, token: token?.slice(0, 4) }, 'WhatsApp webhook verification failed');
      res.writeHead(403);
      res.end('Forbidden');
    }
  }

  /** Handle incoming webhook POST from Meta. */
  private handleIncomingWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // Always respond 200 quickly — Meta retries on non-2xx
      res.writeHead(200);
      res.end('OK');

      const rawBody = Buffer.concat(chunks).toString('utf8');

      // Verify webhook signature if app secret is configured
      if (this.appSecret) {
        const signature = req.headers['x-hub-signature-256'] as string | undefined;
        if (!this.verifySignature(rawBody, signature)) {
          logger.warn('WhatsApp webhook signature verification failed');
          return;
        }
      }

      try {
        const body = JSON.parse(rawBody);
        this.processWebhookPayload(body);
      } catch (err) {
        logger.warn({ err }, 'Failed to parse WhatsApp webhook payload');
      }
    });
  }

  /** Verify webhook payload signature using app secret. */
  private verifySignature(body: string, signature: string | undefined): boolean {
    if (!signature || !this.appSecret) return false;

    const expectedSig = 'sha256=' + crypto
      .createHmac('sha256', this.appSecret)
      .update(body)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSig),
    );
  }

  /** Process the webhook payload — extract messages. */
  private processWebhookPayload(payload: any): void {
    // WhatsApp Cloud API webhook structure:
    // { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [...] } }] }] }
    if (payload.object !== 'whatsapp_business_account') return;

    const entries = payload.entry as any[];
    if (!entries) return;

    for (const entry of entries) {
      const changes = entry.changes as any[];
      if (!changes) continue;

      for (const change of changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        if (!value?.messages) continue;

        const contacts = value.contacts as any[] | undefined;
        const contactMap = new Map<string, string>();
        if (contacts) {
          for (const c of contacts) {
            if (c.wa_id && c.profile?.name) {
              contactMap.set(c.wa_id, c.profile.name);
            }
          }
        }

        for (const msg of value.messages) {
          this.handleMessage(msg, contactMap).catch((err) => {
            logger.error({ err }, 'Error handling WhatsApp message');
          });
        }
      }
    }
  }

  // ── Message Handling ──

  private async handleMessage(
    msg: any,
    contactMap: Map<string, string>,
  ): Promise<void> {
    const messageId = msg.id as string;
    const waId = msg.from as string; // Sender's phone number
    const msgType = msg.type as string;

    // Deduplicate — Meta can send the same webhook multiple times
    if (this.processedMessages.has(messageId)) return;
    this.processedMessages.add(messageId);

    // Security: check allowed phone numbers
    if (this.allowedNumbers && !this.allowedNumbers.has(waId)) {
      logger.debug({ waId }, 'Ignoring message from non-allowed number');
      return;
    }

    // Extract content based on message type
    let content: string | unknown = '';
    switch (msgType) {
      case 'text':
        content = msg.text?.body ?? '';
        break;
      case 'image': {
        const caption = msg.image?.caption ?? '';
        const imageData = await this.downloadWhatsAppMedia(msg.image?.id);
        if (imageData) {
          content = buildImageContent(caption || 'User sent an image', imageData);
        } else {
          content = caption ? `${caption}\n[Image attached — download failed]` : '[Image attached — download failed]';
        }
        break;
      }
      case 'document':
        content = msg.document?.caption
          ? `${msg.document.caption}\n[Document: ${msg.document.filename ?? 'file'}]`
          : `[Document: ${msg.document?.filename ?? 'file'}]`;
        break;
      case 'audio': {
        const audioBuffer = await this.downloadWhatsAppFile(msg.audio?.id);
        if (audioBuffer) {
          const { transcribeAudio } = await import('../../utils/audio.js');
          const result = await transcribeAudio(audioBuffer, { fileName: 'voice.ogg' });
          if (result) {
            content = `[Voice message] ${result.text}`;
          } else {
            content = '[Voice message — transcription unavailable]';
          }
        } else {
          content = '[Voice message — download failed]';
        }
        break;
      }
      case 'video':
        content = msg.video?.caption
          ? `${msg.video.caption}\n[Video attached]`
          : '[Video attached]';
        break;
      case 'location':
        content = `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
        break;
      case 'contacts':
        content = '[Contact shared]';
        break;
      case 'sticker':
        content = '[Sticker]';
        break;
      case 'reaction':
        // Reactions don't need agent processing
        return;
      default:
        content = `[${msgType} message]`;
        break;
    }

    if (!content) return;

    // Mark as read
    this.markAsRead(messageId).catch(() => {});

    const threadId = `${waId}:${messageId}`;
    const userName = contactMap.get(waId);

    // Create response slot
    let resolvePromise: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const activeResp: ActiveResponse = {
      waId,
      replyToMessageId: messageId,
      accumulated: '',
      toolCalls: [],
      typingTimer: null,
      complete: false,
      resolve: resolvePromise!,
    };

    this.activeResponses.set(threadId, activeResp);

    // Start typing indicator
    activeResp.typingTimer = setInterval(() => {
      this.sendPresence(waId).catch(() => {});
    }, TYPING_INTERVAL_MS);

    // Send initial typing
    await this.sendPresence(waId).catch(() => {});

    // Build inbound message
    const inbound: InboundMessage = {
      id: crypto.randomUUID(),
      channelId: this.id,
      channelType: 'whatsapp',
      threadId,
      userId: waId,
      userName,
      content,
      timestamp: parseInt(msg.timestamp, 10) * 1000,
      metadata: {
        messageType: msgType,
        messageId,
        waId,
      },
    };

    this.inbox!.push(inbound);

    // Wait for the agent to finish processing
    await promise;
  }

  // ── Response Sending ──

  /**
   * Send the complete response via delivery queue (crash-safe) or direct.
   * WhatsApp doesn't support message editing, so we accumulate everything
   * and send once when the agent is done.
   */
  private async sendFinalResponse(resp: ActiveResponse): Promise<void> {
    if (!resp.accumulated) return;

    const payload: WhatsAppPayload = {
      waId: resp.waId,
      replyToMessageId: resp.replyToMessageId,
      text: resp.accumulated,
    };

    if (this.deliveryQueue) {
      const entryId = await this.deliveryQueue.enqueue('whatsapp', resp.waId, payload);
      if (entryId) {
        try {
          await this.deliverChunkedMessage(payload);
          await this.deliveryQueue.ack(entryId);
        } catch (err) {
          await this.deliveryQueue.failDelivery(entryId, (err as Error).message ?? String(err));
        }
        return;
      }
    }

    // No queue or enqueue failed — direct delivery
    try {
      await this.deliverChunkedMessage(payload);
    } catch (err) {
      logger.warn({ err, waId: resp.waId }, 'Failed to send WhatsApp message');
    }
  }

  /** Deliver a chunked WhatsApp message (used by both immediate send and retry handler). */
  private async deliverChunkedMessage(payload: WhatsAppPayload): Promise<void> {
    const chunks = splitMessage(payload.text);

    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to: payload.waId,
        type: 'text',
        text: { body: chunks[i] },
      };

      // Quote the original message on the first chunk
      if (i === 0 && payload.replyToMessageId) {
        body.context = { message_id: payload.replyToMessageId };
      }

      const result = await this.apiCall('POST', `/${this.phoneNumberId}/messages`, body);
      if (result?.error) {
        throw new Error(result.error.message ?? `WhatsApp API error: ${JSON.stringify(result.error)}`);
      }
    }
  }

  /** Send "typing" presence indicator. */
  private async sendPresence(waId: string): Promise<void> {
    // WhatsApp doesn't have a direct "typing" API via Cloud API.
    // The closest is the "contacts" or "presence" but those aren't
    // available in Cloud API. We mark as read instead to show engagement.
    // Note: On-Premise API supports presence, Cloud API does not.
    // This is a no-op placeholder for future Cloud API support.
  }

  /** Mark a message as read (sends blue ticks). */
  private async markAsRead(messageId: string): Promise<void> {
    try {
      await this.apiCall('POST', `/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
    } catch {
      // Non-critical — don't log
    }
  }

  // ── WhatsApp Cloud API ──

  private async apiCall(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const url = `${GRAPH_API}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return null;

    const data = await res.json();

    // Handle rate limiting
    if (res.status === 429) {
      logger.warn({ path }, 'WhatsApp API rate limited');
      await sleep(2000);
      return this.apiCall(method, path, body);
    }

    if (!res.ok) {
      const errMsg = (data as any)?.error?.message ?? `HTTP ${res.status}`;
      logger.warn({ status: res.status, error: errMsg, path }, 'WhatsApp API error');
    }

    return data;
  }

  /**
   * Download media from WhatsApp Cloud API.
   * Two-step: first GET /{mediaId} to get the URL, then download the binary.
   */
  private async downloadWhatsAppMedia(mediaId: string | undefined): Promise<import('../../utils/image.js').ImageData | null> {
    if (!mediaId) return null;

    try {
      // Step 1: Get media URL
      const meta = await this.apiCall('GET', `/${mediaId}`);
      const mediaUrl = meta?.url;
      if (!mediaUrl) return null;

      // Step 2: Download the actual media (requires auth header)
      return await downloadImage(mediaUrl, {
        'Authorization': `Bearer ${this.accessToken}`,
      });
    } catch (err) {
      logger.debug({ err, mediaId }, 'Failed to download WhatsApp media');
      return null;
    }
  }

  /** Download a file from WhatsApp by media ID, returning raw Buffer. */
  private async downloadWhatsAppFile(mediaId: string | undefined): Promise<Buffer | null> {
    if (!mediaId) return null;
    try {
      // Step 1: Get media URL
      const mediaRes = await fetch(`${GRAPH_API}/${mediaId}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!mediaRes.ok) return null;
      const mediaInfo = await mediaRes.json() as { url?: string };
      if (!mediaInfo.url) return null;

      // Step 2: Download the file
      const { downloadAudio } = await import('../../utils/audio.js');
      return await downloadAudio(mediaInfo.url, { Authorization: `Bearer ${this.accessToken}` });
    } catch (err) {
      logger.debug({ err, mediaId }, 'WhatsApp file download error');
      return null;
    }
  }

  /**
   * Send an image via WhatsApp Cloud API.
   * Uses the media upload endpoint, then sends a message referencing the media ID.
   */
  private async sendImage(waId: string, image: { base64: string; mediaType: string }, caption?: string): Promise<void> {
    // Upload image to WhatsApp media endpoint
    const buffer = Buffer.from(image.base64, 'base64');
    const ext = image.mediaType === 'image/png' ? 'png' : 'jpg';
    const blob = new Blob([buffer], { type: image.mediaType });

    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', image.mediaType);
    formData.append('file', blob, `image.${ext}`);

    const uploadRes = await fetch(`${GRAPH_API}/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
      body: formData,
    });
    const uploadData = await uploadRes.json() as { id?: string };
    if (!uploadData?.id) {
      logger.warn({ response: uploadData }, 'WhatsApp media upload failed');
      return;
    }

    // Send image message
    await this.apiCall('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: waId,
      type: 'image',
      image: {
        id: uploadData.id,
        ...(caption ? { caption } : {}),
      },
    });
  }

  /**
   * Send an audio file as a voice message via WhatsApp Cloud API.
   * Uploads the audio to WhatsApp media, then sends a message referencing the media ID.
   */
  private async sendAudio(waId: string, audioBase64: string): Promise<void> {
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Step 1: Upload audio to WhatsApp media
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', 'audio/ogg');
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');

    const uploadRes = await fetch(`${GRAPH_API}/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });
    const uploadData = await uploadRes.json() as { id?: string };
    if (!uploadData?.id) {
      logger.warn({ response: uploadData }, 'WhatsApp audio upload failed');
      return;
    }

    // Step 2: Send audio message
    await this.apiCall('POST', `/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: waId,
      type: 'audio',
      audio: { id: uploadData.id },
    });
  }
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split a message into chunks that fit WhatsApp's 4096 char limit. */
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
