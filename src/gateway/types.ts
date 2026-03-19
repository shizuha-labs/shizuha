/**
 * Gateway + Channel type definitions.
 *
 * The agent is modeled as a persistent entity — one process, one identity,
 * one eternal session. Messages arrive from multiple channels (HTTP, WebSocket,
 * Telegram, Discord, etc.) and are processed sequentially through a FIFO inbox.
 * Responses flow back to the originating channel, and optionally fan out to
 * other channels so the agent's work is visible everywhere.
 */

import type { AgentEvent } from '../events/types.js';
import type { DeliveryQueue } from './delivery-queue.js';

// ── Channel Types ──

export type ChannelType =
  | 'http'           // Browser / curl — Fastify SSE
  | 'shizuha-ws'     // Shizuha platform — WebSocket client
  | 'telegram'       // Telegram Bot API
  | 'discord'        // Discord gateway
  | 'whatsapp'       // WhatsApp Business API
  | 'slack'          // Slack Events API
  | 'signal'         // Signal via signal-cli REST API
  | 'line'           // LINE Messaging API
  | 'imessage'       // iMessage via BlueBubbles
  | 'cli';           // stdin/stdout (pipe mode)

// ── Inbound Message ──

export interface InboundMessage {
  /** Unique message ID */
  id: string;
  /** Channel that produced this message */
  channelId: string;
  /** Channel type (for formatting context prefix) */
  channelType: ChannelType;
  /** Thread ID for response routing — HTTP request ID, Telegram chat ID, etc. */
  threadId: string;
  /** User identifier on the source platform */
  userId: string;
  /** Display name of the sender (if known) */
  userName?: string;
  /** Ed25519 public key of the sender (hex, if signed) */
  senderPublicKey?: string;
  /** Ed25519 signature over content+timestamp (hex, if signed) */
  signature?: string;
  /** Whether the message is E2E encrypted */
  encrypted?: boolean;
  /** Message content — string or multimodal content array */
  content: string | unknown;
  /** Timestamp of the message */
  timestamp: number;
  /** Model override for this message (optional) */
  model?: string;
  /** Permission mode override (optional) */
  permissionMode?: string;
  /** Idempotency key (optional) */
  requestId?: string;

  // ── ShizuhaWS-specific fields ──

  /** Agent ID (for agent-routed protocol) */
  agentId?: string;
  /** Session ID from the platform */
  platformSessionId?: string;
  /** Execution ID from the platform */
  executionId?: string;

  // ── Platform-specific metadata ──

  /** Arbitrary platform metadata (reply-to IDs, message types, etc.) */
  metadata?: Record<string, unknown>;

  // ── Cron / internal routing ──

  /** Message source — 'cron' messages are routed differently in processMessage */
  source?: 'user' | 'cron' | 'inter-agent';
  /** Cron job ID (for marking completion after processing) */
  cronJobId?: string;
  /** Cron job name (for proactive event labeling) */
  cronJobName?: string;
}

// ── Channel Interface ──

export interface Channel {
  /** Unique identifier for this channel instance */
  readonly id: string;
  /** Channel type */
  readonly type: ChannelType;

  /**
   * Start the channel. The channel should begin listening for messages
   * and push them to the provided inbox.
   */
  start(inbox: Inbox): Promise<void>;

  /** Gracefully stop the channel. */
  stop(): Promise<void>;

  /**
   * Send an agent event back to the source thread.
   * Called by the gateway as the agent processes a message.
   */
  sendEvent(threadId: string, event: AgentEvent): Promise<void>;

  /**
   * Signal that the agent has finished processing the current message.
   * The channel should finalize the response (close SSE stream, etc.).
   */
  sendComplete(threadId: string): void;

  /**
   * Notify the channel that the agent is busy processing another message.
   * Channels can show "typing" indicators, queue position, etc.
   */
  notifyBusy?(threadId: string, queuePosition: number): void;

  /**
   * Receive a fan-out event from another channel's execution.
   * Called when cross-channel fan-out is enabled, so all channels see the
   * agent's work regardless of which channel originated the message.
   *
   * Channels that support fan-out should broadcast to all connected clients
   * (WebSocket channels) or send a notification (push channels like Telegram).
   *
   * @param event The agent event
   * @param originChannelId The channel that originally received the message
   * @param threadId The execution thread ID (from the originating channel)
   */
  broadcastEvent?(event: AgentEvent, originChannelId: string, threadId: string): Promise<void>;

  /**
   * Inject the shared delivery queue for crash-safe outbound delivery.
   * Called by AgentProcess after the queue is initialized.
   */
  setDeliveryQueue?(queue: DeliveryQueue): void;
}

// ── Inbox Interface ──

export interface Inbox {
  /** Push a message into the inbox (called by channels). */
  push(msg: InboundMessage): void;

  /** Pull the next message, blocking until one is available. */
  next(): Promise<InboundMessage>;

  /** Current queue depth (messages waiting to be processed). */
  readonly depth: number;

  /** Whether a message is currently being processed. */
  readonly busy: boolean;
}

// ── Gateway Config ──

export interface GatewayConfig {
  /** Agent identity — if not set, runs as anonymous agent */
  agentId?: string;
  agentName?: string;
  /** Agent username — used to load per-agent config from ~/.shizuha/agents/{username}/ */
  agentUsername?: string;

  /** Channels to enable */
  channels: ChannelConfig[];

  /** Model to use (can be overridden per-message) */
  model?: string;

  /** Working directory */
  cwd?: string;

  /** Permission mode */
  permissionMode?: 'plan' | 'supervised' | 'autonomous';

  /** Thinking level for Claude models */
  thinkingLevel?: string;

  /** Reasoning effort for Codex models */
  reasoningEffort?: string;

  /** Platform context prompt (fallback if no per-agent CLAUDE.md) */
  contextPrompt?: string;

  /** Named toolset to use (default: 'full'). Filters available tools at init time. */
  toolset?: string;

  /**
   * Cross-channel fan-out: when an agent responds on one channel, broadcast
   * events to all other channels with fan-out enabled. This ensures the
   * agent's work is visible everywhere (dashboard, Telegram, Discord, etc.).
   *
   * Per-channel-type enable/disable. Defaults:
   *   http: true, shizuha-ws: true, telegram: true, discord: true, whatsapp: false
   */
  fanOut?: Partial<Record<ChannelType, boolean>>;
}

/** Default fan-out settings — all on except WhatsApp/LINE (per-message cost). */
export const DEFAULT_FAN_OUT: Record<ChannelType, boolean> = {
  'http': true,
  'shizuha-ws': true,
  'telegram': true,
  'discord': true,
  'whatsapp': false,
  'slack': true,
  'signal': true,
  'line': false,
  'imessage': true,
  'cli': false,
};

export type ChannelConfig =
  | HttpChannelConfig
  | ShizuhaWSChannelConfig
  | TelegramChannelConfig
  | DiscordChannelConfig
  | WhatsAppChannelConfig
  | SlackChannelConfig
  | SignalChannelConfig
  | LineChannelConfig
  | IMessageChannelConfig;

export interface HttpChannelConfig {
  type: 'http';
  port?: number;     // default 8015
  host?: string;     // default 0.0.0.0
}

export interface ShizuhaWSChannelConfig {
  type: 'shizuha-ws';
  /** WebSocket URL to shizuha-agent, e.g. ws://localhost:8017/ws/chat/ */
  url: string;
  /** JWT token for authentication */
  token: string;
  /** Agent ID on the platform */
  agentId?: string;
  /** Auto-reconnect on disconnect */
  reconnect?: boolean;
  /** Event log for cursor-based replay (replaces RAM outbox) */
  eventLog?: import('../daemon/event-log.js').EventLog;

  /**
   * Called when another runner is already connected for this agent.
   * The callback receives info about existing runners and must return
   * 'evict' (take over) or 'use_local' (disconnect, run locally).
   * If not provided, defaults to 'use_local' (no auto-eviction).
   */
  onAuthPending?: (info: {
    existingRunners: Array<{
      agent_name: string;
      token_prefix: string;
      connected_at: string;
      runner_version: string;
    }>;
    message: string;
  }) => Promise<'evict' | 'use_local'>;

  /**
   * Called when this runner has been evicted by another runner that
   * connected for the same agent. The channel will NOT reconnect.
   */
  onEvicted?: (reason: string) => void;
}

export interface TelegramChannelConfig {
  type: 'telegram';
  /** Bot token from @BotFather */
  botToken: string;
  /** Allowed user/chat IDs (empty = allow all) */
  allowedChatIds?: number[];
}

export interface DiscordChannelConfig {
  type: 'discord';
  /** Bot token from Discord Developer Portal */
  botToken: string;
  /** Allowed guild IDs (empty = allow all) */
  allowedGuildIds?: string[];
  /** Respond mode */
  respondMode?: 'mention' | 'dm' | 'all';
}

export interface SlackChannelConfig {
  type: 'slack';
  /** Bot token (xoxb-...) from Slack App */
  botToken: string;
  /** App-level token (xapp-...) for Socket Mode */
  appToken: string;
  /** Allowed channel IDs (empty = allow all) */
  allowedChannelIds?: string[];
  /** Respond mode: mention = only when @mentioned, dm = DMs only, all = everything */
  respondMode?: 'mention' | 'dm' | 'all';
}

export interface WhatsAppChannelConfig {
  type: 'whatsapp';
  /** Permanent access token from Meta App Dashboard */
  accessToken: string;
  /** Phone number ID (from WhatsApp Business settings) */
  phoneNumberId: string;
  /** Webhook verify token (you choose this, Meta sends it to verify) */
  verifyToken: string;
  /** Port for the webhook HTTP server */
  webhookPort?: number;
  /** Host for the webhook HTTP server */
  webhookHost?: string;
  /** Allowed phone numbers (empty = allow all) */
  allowedNumbers?: string[];
  /** App secret for webhook signature verification */
  appSecret?: string;
}

export interface SignalChannelConfig {
  type: 'signal';
  /** URL of the signal-cli REST API (e.g. http://localhost:8080) */
  apiUrl: string;
  /** Registered Signal phone number (e.g. +1234567890) */
  phoneNumber: string;
  /** Allowed sender phone numbers (empty = allow all) */
  allowedNumbers?: string[];
}

export interface LineChannelConfig {
  type: 'line';
  /** Channel access token (long-lived) from LINE Developers console */
  channelAccessToken: string;
  /** Channel secret for webhook signature verification */
  channelSecret: string;
  /** Port for the webhook HTTP server */
  webhookPort?: number;
}

export interface IMessageChannelConfig {
  type: 'imessage';
  /** BlueBubbles server URL (e.g. http://mac-mini:1234) */
  serverUrl: string;
  /** BlueBubbles server password */
  password: string;
  /** Port for the webhook HTTP server */
  webhookPort?: number;
  /** Allowed iMessage handles/phone numbers (empty = allow all) */
  allowedHandles?: string[];
}
