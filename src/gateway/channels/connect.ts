/**
 * Connect Channel — gateway-mode agent connection to shizuha-connect.
 *
 * Uses the shared ConnectClient for authentication, WebSocket management,
 * and streaming. This channel translates between the gateway's Channel
 * interface (InboundMessage/AgentEvent) and Connect's protocol.
 *
 * For bridge-mode agents, the ConnectClient is used directly
 * (not through this Channel wrapper).
 */

import * as crypto from 'node:crypto';
import type { AgentEvent } from '../../events/types.js';
import type { Channel, Inbox, InboundMessage, ConnectChannelConfig } from '../types.js';
import { ConnectClient } from '../../connect-client/index.js';
import { sendConnectDm } from '../../platform/connect-dm.js';
import { isRoutineTaskNotificationContent, isWorkingDeferredTaskNotification } from '../inbox.js';
import { connectAutoReplyEnabled } from '../../platform/lean-conversational.js';
import { logger } from '../../utils/logger.js';

export class ConnectChannel implements Channel {
  readonly id: string;
  readonly type = 'connect' as const;

  private inbox: Inbox | null = null;
  private client: ConnectClient;
  private agentId?: string;

  // Lean talk seats auto-reply by default (Grok Build already did). DeepSeek
  // does not reliably call message_user. Opt out with SHIZUHA_CONNECT_AUTOREPLY=0.
  // Reply goes to the inbound sender (conversation-scoped), not a fixed inbox.
  private readonly autoReply = connectAutoReplyEnabled();
  private readonly replyEmail = (process.env['SHIZUHA_CONNECT_REPLY_EMAIL'] || '').trim();
  private readonly replyBuf = new Map<string, string>();
  private readonly flushedLen = new Map<string, number>();
  private readonly convThreads = new Set<string>();
  private readonly replyTargets = new Map<string, { username?: string; email?: string }>();

  constructor(config: ConnectChannelConfig) {
    this.id = `connect-${config.agentId ?? 'default'}`;
    this.agentId = config.agentId;

    this.client = new ConnectClient({
      wsUrl: config.url || undefined,
      token: config.token || undefined,
      onMessage: (convId, content, senderId, senderName, messageId, conversationType, replyObligation) => {
        if (!this.inbox) return;
        if (this.autoReply) {
          this.convThreads.add(convId);
          const username = (senderName || '').trim();
          this.replyTargets.set(convId, {
            username: username || undefined,
            email: this.replyEmail || undefined,
          });
        }
        const routineTaskNotification = isRoutineTaskNotificationContent(content);
        const taskKey = routineTaskNotification
          ? content.match(/\b[A-Z][A-Z0-9]*-\d+\b/i)?.[0]?.toUpperCase()
          : undefined;
        const inbound: InboundMessage = {
          id: messageId || crypto.randomUUID(),
          channelId: this.id,
          channelType: 'connect',
          threadId: convId,
          userId: senderId,
          userName: senderName,
          content,
          timestamp: Date.now(),
          agentId: this.agentId,
          metadata: {
            conversationId: convId,
            conversationType,
            replyObligation,
            schedulerClass: routineTaskNotification ? 'routine-task' : 'direct-control',
            ...(taskKey ? { schedulerTaskKey: taskKey } : {}),
          },
        };
        if (this.inbox.tryPush) this.inbox.tryPush(inbound);
        else this.inbox.push(inbound);
        // Ack Pulse assignment/update notices on receipt. They may be held
        // (never turned) while the agent is working; without an early ack
        // Connect missed-message replay re-floods the same notices.
        if (isWorkingDeferredTaskNotification(inbound) && inbound.id) {
          this.client.ackMessageProcessed(inbound.id);
        }
      },
    });
  }

  async start(inbox: Inbox): Promise<void> {
    this.inbox = inbox;
    await this.client.start();
  }

  async stop(): Promise<void> {
    this.client.stop();
  }

  // ── Outbound stream events are no longer forwarded to Connect ──
  //
  // Agents' natural LLM turn output is private reasoning, not a user-visible
  // message. To *send* a reply the agent may call `message_user` (or the
  // auto-reply path below). Silence after a Connect inject is valid — the
  // gateway acks the inbound message when processMessage finishes regardless
  // (inject-once; see shared/connect-inject.ts). Do not treat missing
  // message_user as provider failure or re-queue the DM.
  //
  // When SHIZUHA_CONNECT_AUTOREPLY=1 (per-user chat assistant), these accumulate
  // the assistant's content for a Connect conversation turn and deliver it to the
  // owner on completion. Otherwise they remain no-ops (agents reply via message_user).
  async sendEvent(threadId: string, event: AgentEvent): Promise<void> {
    if (!this.autoReply) return;
    if (!this.convThreads.has(threadId)) return;
    if (event.type === 'content') {
      const text = (event as unknown as { text?: string }).text;
      if (text) {
        const next = (this.replyBuf.get(threadId) || '') + text;
        this.replyBuf.set(threadId, next);
        this.client.sendStreamEvent(threadId, 'content', { text });
        this.flushSpokenSentences(threadId);
      }
    }
  }

  ensureBufferedReply(threadId: string, text: string): void {
    if (!this.autoReply) return;
    if (!this.convThreads.has(threadId)) return;
    const spoken = (text || '').trim();
    if (!spoken) return;
    if ((this.replyBuf.get(threadId) || '').trim()) return;
    this.replyBuf.set(threadId, spoken);
  }

  sendComplete(threadId: string, fallbackText?: string): void {
    if (!this.autoReply) return;
    if (!this.convThreads.has(threadId)) return;
    this.ensureBufferedReply(threadId, fallbackText || '');
    const text = (this.replyBuf.get(threadId) || '').trim();
    this.replyBuf.delete(threadId);
    this.flushedLen.delete(threadId);
    this.client.sendStreamEvent(threadId, 'complete', {});
    if (!text) {
      logger.warn({ threadId }, 'connect auto-reply: empty turn text (thinking-only or tool-only)');
      return;
    }
    void this.deliverReply(threadId, text);
  }

  private flushSpokenSentences(threadId: string): void {
    const buf = this.replyBuf.get(threadId) || '';
    const already = this.flushedLen.get(threadId) || 0;
    const unsent = buf.slice(already);
    const match = unsent.match(/^[\s\S]*?[.!?…](?:["')\]]+)?(?=\s|$)/);
    if (!match) return;
    const sentence = match[0].trim();
    if (sentence.length < 8) return;
    this.flushedLen.set(threadId, already + match[0].length);
    this.client.sendStreamEvent(threadId, 'sentence', { text: sentence });
  }

  private async deliverReply(threadId: string, text: string): Promise<void> {
    const target = this.replyTargets.get(threadId) || {};
    const recipientEmail = target.email || this.replyEmail || undefined;
    // Prefer email when present. Inbound senderName is often a display/Google
    // local-part (hothritik1) that is not the Shizuha username (hritik).
    // Sending both makes Connect 404 on username and drop the reply.
    const recipientUsername = recipientEmail ? undefined : target.username;
    if (!recipientEmail && !recipientUsername) {
      logger.error({ threadId }, 'connect auto-reply: no recipient');
      return;
    }
    let lastError = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await sendConnectDm({
        conversationId: threadId,
        recipientEmail,
        recipientUsername,
        content: text,
        sender: { username: process.env['AGENT_USERNAME'] || '', agentId: process.env['AGENT_ID'] || undefined },
      });
      if (result.ok) return;
      lastError = result.error || `status ${result.status}`;
      logger.warn({ threadId, attempt, error: lastError, status: result.status }, 'connect auto-reply send failed');
      if (result.status === 400 || result.status === 403 || result.status === 404) break;
      const waitMs = result.status === 429
        ? Math.min(result.retryAfterMs || 21_000, 25_000)
        : 400 * attempt;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    logger.error({ threadId, error: lastError }, 'connect auto-reply exhausted retries');
  }

  ackProcessed(messageId: string): boolean {
    return this.client.ackMessageProcessed(messageId);
  }

  fenceRuntimeRollIngress(): void { this.client.stop(); }

  resumeRuntimeRollIngress(): void { void this.client.start(); }

  async broadcastEvent(_event: AgentEvent, _originChannelId: string, _threadId: string): Promise<void> {
    return;
  }

  sendTelemetry(payload: Record<string, unknown>): boolean {
    return this.client.sendTelemetry(payload);
  }
}
