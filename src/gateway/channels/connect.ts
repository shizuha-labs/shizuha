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

export class ConnectChannel implements Channel {
  readonly id: string;
  readonly type = 'connect' as const;

  private inbox: Inbox | null = null;
  private client: ConnectClient;
  private agentId?: string;

  // SCLI chat-assistant auto-reply (opt-in via env): deliver the agent's
  // natural turn output back to the originating Connect conversation, so a
  // user-facing assistant replies conversationally without having to emit an
  // explicit `message_user` tool call (which reasoning models do unreliably).
  // Scoped to real conversation threads (populated from onMessage) so heartbeat
  // / non-connect turns are never auto-sent to the owner.
  private readonly autoReply = process.env['SHIZUHA_CONNECT_AUTOREPLY'] === '1';
  private readonly replyEmail = (process.env['SHIZUHA_CONNECT_REPLY_EMAIL'] || '').trim();
  private readonly replyBuf = new Map<string, string>();
  private readonly convThreads = new Set<string>();

  constructor(config: ConnectChannelConfig) {
    this.id = `connect-${config.agentId ?? 'default'}`;
    this.agentId = config.agentId;

    this.client = new ConnectClient({
      wsUrl: config.url || undefined,
      token: config.token || undefined,
      onMessage: (convId, content, senderId, senderName, messageId, conversationType, replyObligation) => {
        if (!this.inbox) return;
        if (this.autoReply && this.replyEmail) this.convThreads.add(convId);
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
    if (!this.autoReply || !this.replyEmail) return;
    if (!this.convThreads.has(threadId)) return;
    if (event.type === 'content') {
      const text = (event as unknown as { text?: string }).text;
      if (text) this.replyBuf.set(threadId, (this.replyBuf.get(threadId) || '') + text);
    }
  }

  sendComplete(threadId: string): void {
    if (!this.autoReply || !this.replyEmail) return;
    if (!this.convThreads.has(threadId)) return;
    const text = (this.replyBuf.get(threadId) || '').trim();
    this.replyBuf.delete(threadId);
    if (!text) return;
    void sendConnectDm({
      recipientEmail: this.replyEmail,
      content: text,
      sender: { username: process.env['AGENT_USERNAME'] || '', agentId: process.env['AGENT_ID'] || undefined },
    }).catch(() => { /* best-effort delivery */ });
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
