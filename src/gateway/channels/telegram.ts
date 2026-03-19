/**
 * Telegram Bot Channel — connects the agent to Telegram via Bot API.
 *
 * Uses long polling (getUpdates) — no webhook or public URL needed.
 * Messages are received, pushed to the inbox, and responses stream
 * back as edited Telegram messages (progressive updates).
 *
 * Features:
 * - Long polling with automatic reconnect
 * - Typing indicator while agent processes
 * - Progressive message editing (streaming feel)
 * - Message chunking for long responses (4096 char limit)
 * - MarkdownV2 formatting for code blocks
 * - Allowed chat ID filtering (security)
 * - Photo/document attachment support (forwarded as descriptions)
 */

import * as crypto from 'node:crypto';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage, TelegramChannelConfig } from '../types.js';
import type { DeliveryQueue, DeliveryEntry } from '../delivery-queue.js';
import { downloadImage, buildImageContent } from '../../utils/image.js';
import { logger } from '../../utils/logger.js';

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT_S = 30;
const MAX_MESSAGE_LENGTH = 4096;
const EDIT_DEBOUNCE_MS = 800; // Min time between message edits (rate limit)
const TYPING_INTERVAL_MS = 4000; // Resend typing action every 4s

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; last_name?: string; username?: string };
  chat: { id: number; type: string; title?: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; duration: number; mime_type?: string };
  reply_to_message?: TelegramMessage;
}

/** Active response being streamed back to a Telegram chat. */
interface ActiveResponse {
  chatId: number;
  sentMessageId: number | null; // The bot's response message (null until first send)
  accumulated: string;          // Full accumulated text
  lastEditAt: number;           // Timestamp of last edit
  editTimer: NodeJS.Timeout | null;
  typingTimer: NodeJS.Timeout | null;
  toolCalls: string[];          // Active tool names
  complete: boolean;
  resolve: () => void;
}

/** Serializable payload for the delivery queue. */
interface TelegramPayload {
  chatId: number;
  text: string;
}

export class TelegramChannel implements Channel {
  readonly id: string;
  readonly type = 'telegram' as const;

  private inbox: Inbox | null = null;
  private botToken: string;
  private allowedChatIds: Set<number> | null;
  private running = false;
  private offset = 0;
  private pollController: AbortController | null = null;
  private activeResponses = new Map<string, ActiveResponse>(); // threadId → response
  private botUsername = '';
  private deliveryQueue: DeliveryQueue | null = null;

  /** Chat IDs that have interacted with the bot — used for fan-out broadcasts. */
  private knownChatIds = new Set<number>();
  /** Accumulated fan-out content per origin thread (sent on complete). */
  private fanOutBuffers = new Map<string, string>();

  constructor(config: TelegramChannelConfig) {
    this.id = `telegram-${config.botToken.split(':')[0]}`;
    this.botToken = config.botToken;
    this.allowedChatIds = config.allowedChatIds?.length
      ? new Set(config.allowedChatIds)
      : null;
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    this.running = true;

    // Verify bot token and get bot info
    const me = await this.apiCall('getMe');
    if (!me?.ok) {
      throw new Error(`Telegram bot token invalid: ${JSON.stringify(me)}`);
    }
    this.botUsername = me.result.username ?? '';
    logger.info({
      botUsername: this.botUsername,
      botId: me.result.id,
    }, 'Telegram bot connected');

    // Start long polling loop
    this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollController?.abort();

    // Clean up active responses
    for (const [, resp] of this.activeResponses) {
      if (resp.editTimer) clearTimeout(resp.editTimer);
      if (resp.typingTimer) clearInterval(resp.typingTimer);
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
        this.scheduleEdit(threadId, resp);
        break;

      case 'tool_start':
        resp.toolCalls.push(event.toolName);
        this.updateTypingStatus(resp);
        break;

      case 'tool_complete': {
        const idx = resp.toolCalls.indexOf(event.toolName);
        if (idx >= 0) resp.toolCalls.splice(idx, 1);
        // Send images from tool results directly (screenshots, charts, etc.)
        if (event.image && !event.isError) {
          this.sendPhoto(resp.chatId, event.image, event.toolName === 'Read' ? undefined : event.toolName).catch((err) => {
            logger.debug({ err }, 'Failed to send tool image via Telegram');
          });
        }
        // Send audio from tool results as voice messages (TTS, etc.)
        if (event.audio && !event.isError) {
          this.sendVoice(resp.chatId, event.audio.base64).catch((err) => {
            logger.debug({ err }, 'Failed to send voice message via Telegram');
          });
        }
        break;
      }

      case 'error':
        resp.accumulated += `\n\n⚠️ Error: ${event.error}`;
        await this.flushEdit(threadId, resp);
        break;

      case 'complete':
        resp.complete = true;
        // Enqueue final message for crash-safe delivery before attempting send
        if (this.deliveryQueue && resp.accumulated) {
          const payload: TelegramPayload = { chatId: resp.chatId, text: resp.accumulated };
          const entryId = await this.deliveryQueue.enqueue('telegram', String(resp.chatId), payload);
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
    this.deliveryQueue.registerHandler('telegram', async (entry: DeliveryEntry) => {
      const payload = entry.payload as TelegramPayload;
      const chunks = splitMessage(payload.text);
      for (const chunk of chunks) {
        const result = await this.apiCall('sendMessage', {
          chat_id: payload.chatId,
          text: chunk,
          parse_mode: 'MarkdownV2',
        });
        if (!result?.ok) {
          // Retry without markdown
          const plainResult = await this.apiCall('sendMessage', {
            chat_id: payload.chatId,
            text: stripMarkdown(chunk),
          });
          if (!plainResult?.ok) {
            throw new Error(plainResult?.description ?? 'Telegram API error');
          }
        }
      }
    });
  }

  notifyBusy(threadId: string, queuePosition: number): void {
    // threadId for telegram is chatId:messageId
    const chatId = parseInt(threadId.split(':')[0]!, 10);
    if (!chatId) return;
    // Don't spam — only notify for position 1
    if (queuePosition === 1) {
      this.apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    }
  }

  /**
   * Fan-out: receive events from another channel's execution.
   * Accumulates content and sends a single summary message to all known
   * chat IDs on completion — avoids spamming Telegram with streaming deltas.
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

        // Send to all known chats (except the origin if it's a Telegram chat)
        const originChatId = parseInt(threadId.split(':')[0]!, 10);
        const label = `📡 *Fan\\-out from ${escapeMarkdownV2(originChannelId)}*`;
        const chunks = splitMessage(`${label}\n\n${escapeMarkdownV2(text)}`);

        for (const chatId of this.knownChatIds) {
          if (chatId === originChatId) continue; // Don't echo back to origin
          for (const chunk of chunks) {
            await this.apiCall('sendMessage', {
              chat_id: chatId,
              text: chunk,
              parse_mode: 'MarkdownV2',
            }).catch(() => {
              // Retry without markdown
              this.apiCall('sendMessage', {
                chat_id: chatId,
                text: stripMarkdown(chunk),
              }).catch(() => {});
            });
          }
        }
        break;
      }

      case 'error': {
        const prev = this.fanOutBuffers.get(key) ?? '';
        this.fanOutBuffers.set(key, prev + `\n\n⚠️ Error: ${event.error}`);
        break;
      }
    }
  }

  // ── Long Polling ──

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        this.pollController = new AbortController();
        const updates = await this.getUpdates();
        if (!updates) continue;

        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.running) break;
        const msg = (err as Error).message ?? '';
        // Don't log abort errors
        if (!msg.includes('abort')) {
          logger.error({ err }, 'Telegram poll error');
        }
        // Brief pause before retry
        await sleep(2000);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[] | null> {
    const result = await this.apiCall('getUpdates', {
      offset: this.offset,
      timeout: POLL_TIMEOUT_S,
      allowed_updates: ['message'],
    }, this.pollController!.signal);

    if (!result?.ok) return null;
    return result.result as TelegramUpdate[];
  }

  // ── Message Handling ──

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;

    // Security: check allowed chat IDs
    if (this.allowedChatIds && !this.allowedChatIds.has(msg.chat.id)) {
      logger.debug({ chatId: msg.chat.id }, 'Ignoring message from non-allowed chat');
      return;
    }

    // In group chats, only respond to messages that mention the bot
    if (msg.chat.type !== 'private') {
      const text = msg.text ?? msg.caption ?? '';
      const isMentioned = text.includes(`@${this.botUsername}`);
      const isReply = msg.reply_to_message?.from?.username === this.botUsername;
      if (!isMentioned && !isReply) return;
    }

    // Extract content
    let content: string | unknown = msg.text ?? msg.caption ?? '';
    // Strip bot mention from group messages
    if (this.botUsername && typeof content === 'string') {
      content = content.replace(new RegExp(`@${this.botUsername}\\b`, 'gi'), '').trim();
    }
    if (!content && !msg.photo && !msg.document && !msg.voice) return;

    // Download and attach photos as multimodal content
    if (msg.photo) {
      const textContent = (typeof content === 'string' ? content : '') || 'User sent a photo';
      // Use the largest photo (last in array — Telegram sorts by size ascending)
      const largestPhoto = msg.photo[msg.photo.length - 1];
      const imageData = largestPhoto ? await this.downloadTelegramMedia(largestPhoto.file_id) : null;
      if (imageData) {
        content = buildImageContent(textContent, imageData);
      } else {
        content = textContent ? `${textContent}\n[Photo attached — download failed]` : '[Photo attached — download failed]';
      }
    }
    // Download and transcribe voice messages
    if (msg.voice) {
      const audioBuffer = await this.downloadTelegramFile(msg.voice.file_id);
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
    }

    if (msg.document) {
      const fileName = msg.document.file_name ?? 'document';
      const textContent = typeof content === 'string' ? content : '';
      content = textContent ? `${textContent}\n[File: ${fileName}]` : `[File: ${fileName}]`;
    }

    const threadId = `${msg.chat.id}:${msg.message_id}`;
    const userName = msg.from
      ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
      : undefined;

    // Create response slot
    let resolvePromise: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });

    const activeResp: ActiveResponse = {
      chatId: msg.chat.id,
      sentMessageId: null,
      accumulated: '',
      lastEditAt: 0,
      editTimer: null,
      typingTimer: null,
      toolCalls: [],
      complete: false,
      resolve: resolvePromise!,
    };

    this.activeResponses.set(threadId, activeResp);

    // Track this chat for fan-out broadcasts
    this.knownChatIds.add(msg.chat.id);

    // Start typing indicator
    activeResp.typingTimer = setInterval(() => {
      this.apiCall('sendChatAction', {
        chat_id: msg.chat.id,
        action: 'typing',
      }).catch(() => {});
    }, TYPING_INTERVAL_MS);

    // Send initial typing
    await this.apiCall('sendChatAction', {
      chat_id: msg.chat.id,
      action: 'typing',
    }).catch(() => {});

    // Push to inbox
    const inbound: InboundMessage = {
      id: crypto.randomUUID(),
      channelId: this.id,
      channelType: 'telegram',
      threadId,
      userId: String(msg.from?.id ?? msg.chat.id),
      userName,
      content,
      timestamp: msg.date * 1000,
      metadata: {
        chatId: msg.chat.id,
        chatType: msg.chat.type,
        chatTitle: msg.chat.title,
        messageId: msg.message_id,
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
        // First chunk — send new message
        const result = await this.apiCall('sendMessage', {
          chat_id: resp.chatId,
          text: chunks[0],
          parse_mode: 'MarkdownV2',
        });
        if (result?.ok) {
          resp.sentMessageId = result.result.message_id;
        } else {
          // Retry without markdown if parse fails
          const plainResult = await this.apiCall('sendMessage', {
            chat_id: resp.chatId,
            text: stripMarkdown(chunks[0]!),
          });
          if (plainResult?.ok) {
            resp.sentMessageId = plainResult.result.message_id;
          }
        }
      } else if (chunks.length === 1) {
        // Edit existing message
        await this.apiCall('editMessageText', {
          chat_id: resp.chatId,
          message_id: resp.sentMessageId,
          text: chunks[0],
          parse_mode: 'MarkdownV2',
        }).catch(() => {
          // Retry without markdown
          this.apiCall('editMessageText', {
            chat_id: resp.chatId,
            message_id: resp.sentMessageId,
            text: stripMarkdown(chunks[0]!),
          }).catch(() => {});
        });
      }

      // Send additional chunks as new messages (for very long responses)
      if (resp.complete && chunks.length > 1) {
        for (let i = 1; i < chunks.length; i++) {
          await this.apiCall('sendMessage', {
            chat_id: resp.chatId,
            text: chunks[i],
            parse_mode: 'MarkdownV2',
          }).catch(() => {
            this.apiCall('sendMessage', {
              chat_id: resp.chatId,
              text: stripMarkdown(chunks[i]!),
            }).catch(() => {});
          });
        }
      }

      resp.lastEditAt = Date.now();
    } catch (err) {
      logger.warn({ err, chatId: resp.chatId }, 'Failed to send/edit Telegram message');
    }
  }

  /** Format the response with tool status indicators. */
  private formatResponse(resp: ActiveResponse): string {
    let text = resp.accumulated;
    if (!text && resp.toolCalls.length === 0) return '';

    // Show active tools at the bottom
    if (resp.toolCalls.length > 0 && !resp.complete) {
      const toolLine = resp.toolCalls.map((t) => `⚙️ ${t}`).join(' ');
      text = text ? `${text}\n\n${toolLine}` : toolLine;
    }

    // Add streaming indicator
    if (!resp.complete && text) {
      text += ' ▍';
    }

    return text;
  }

  /** Update typing indicator based on tool activity. */
  private updateTypingStatus(resp: ActiveResponse): void {
    this.apiCall('sendChatAction', {
      chat_id: resp.chatId,
      action: 'typing',
    }).catch(() => {});
  }

  // ── Telegram API ──

  private async apiCall(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: params ? JSON.stringify(params) : undefined,
      signal,
    });
    return res.json();
  }

  /**
   * Download media from Telegram Bot API.
   * Two-step: getFile to get file_path, then download from file endpoint.
   */
  private async downloadTelegramMedia(fileId: string): Promise<import('../../utils/image.js').ImageData | null> {
    try {
      const fileInfo = await this.apiCall('getFile', { file_id: fileId });
      if (!fileInfo?.ok || !fileInfo.result?.file_path) return null;

      const fileUrl = `${TELEGRAM_API}/file/bot${this.botToken}/${fileInfo.result.file_path}`;
      return await downloadImage(fileUrl);
    } catch (err) {
      logger.debug({ err, fileId }, 'Failed to download Telegram media');
      return null;
    }
  }

  /** Download a file from Telegram by file_id, returning raw Buffer. */
  private async downloadTelegramFile(fileId: string): Promise<Buffer | null> {
    try {
      // Step 1: Get file path
      const fileInfo = await this.apiCall('getFile', { file_id: fileId });
      if (!fileInfo?.ok || !fileInfo.result?.file_path) return null;

      // Step 2: Download the file
      const downloadUrl = `${TELEGRAM_API}/file/bot${this.botToken}/${fileInfo.result.file_path}`;
      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return null;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 25 * 1024 * 1024) return null; // 25MB Whisper limit
      return buffer;
    } catch (err) {
      logger.debug({ err, fileId }, 'Telegram file download error');
      return null;
    }
  }

  /**
   * Send a photo to a Telegram chat.
   */
  private async sendPhoto(chatId: number, image: { base64: string; mediaType: string }, caption?: string): Promise<void> {
    const buffer = Buffer.from(image.base64, 'base64');
    const ext = image.mediaType === 'image/png' ? 'png' : 'jpg';
    const blob = new Blob([buffer], { type: image.mediaType });

    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('photo', blob, `image.${ext}`);
    if (caption) formData.append('caption', caption);

    await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendPhoto`, {
      method: 'POST',
      body: formData,
    });
  }

  /** Send an audio file as a voice message. */
  private async sendVoice(chatId: number, audioBase64: string, caption?: string): Promise<void> {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('voice', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
    if (caption) formData.append('caption', caption.slice(0, 1024));

    await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendVoice`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });
  }
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split a message into chunks that fit Telegram's 4096 char limit. */
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

/**
 * Escape special characters for Telegram MarkdownV2.
 * Only escapes outside of code blocks.
 */
function escapeMarkdownV2(text: string): string {
  // Split by code blocks to avoid escaping inside them
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    // Odd indices are code blocks — don't escape
    if (i % 2 === 1) return part;
    // Escape special chars outside code blocks
    return part.replace(/([_*\[\]()~>#+=|{}.!\\-])/g, '\\$1');
  }).join('');
}

/** Strip markdown formatting for fallback plain text. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\\([_*\[\]()~>#+=|{}.!\\-])/g, '$1')  // Unescape MarkdownV2
    .replace(/```[\s\S]*?```/g, (m) => m.slice(3, -3)) // Remove code fences
    .replace(/`([^`]+)`/g, '$1')                        // Remove inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')                  // Remove bold
    .replace(/\*([^*]+)\*/g, '$1')                      // Remove italic
    .replace(/ ▍$/g, '');                               // Remove cursor
}
