/**
 * Shared Connect Client — used by all bridge types (claude, codex, openclaw)
 * and the gateway ConnectChannel.
 *
 * Provides a persistent WebSocket connection to Connect's AgentChatConsumer.
 * Handles self-authentication, message reception, streaming emission,
 * and reconnection.
 *
 * Usage:
 *   const client = new ConnectClient({
 *     onMessage: (convId, content, senderId, senderName) => { ... },
 *   });
 *   await client.start();
 *   client.sendStreamEvent(convId, 'content', { delta: 'Hello' });
 *   client.sendStreamEvent(convId, 'complete', { content: 'Hello world' });
 */

// @ts-ignore
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { brokerExpected, brokerPresent, fetchBrokerToken } from '../auth/broker-token.js';
import { readAgentCredential } from '../auth/credential-resolver.js';
import {
  recordConnectIngressEvent,
  recordConnectTurn,
  type ConnectIngressReason,
  type ConnectReplyObligation,
} from '../metrics/registry.js';

const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const AUTH_RECONNECT_MAX_MS = 5 * 60_000;
// HIVE-628 (operator 2026-07-11): Connect messages must never be lost to the
// agent loop. The server replays unread-since-last_read_at durably; these
// client caps are only flood guards. The old 25/24h caps silently DROPPED
// backlog for agents parked >1 day ("replay_too_old" — the message stayed
// unread in Connect but the agent never processed it). The hive unread-wake
// sweep bounds park-with-unread to ~10min, so wider caps only matter for
// deliberately long-parked agents coming back — which is exactly when
// dropping their inbox is least acceptable.
const DEFAULT_MAX_MISSED_REPLAY_MESSAGES = 100;
const DEFAULT_MAX_MISSED_REPLAY_AGE_HOURS = 24 * 7;
// A connection must stay open at least this long to count as "stable" and
// reset the reconnect/backoff counter. Guards the stale-token flap: an expired
// JWT lets the WS handshake open but the server immediately closes it (code
// 1011); without this gate the `open` handler reset reconnectAttempt to 0 every
// time, so it never crossed the re-auth threshold and the agent flapped forever
// without ever re-minting its token (PLAT — codex 1011 flap).
const STABLE_CONNECTION_MS = 30_000;

// Connect/Django-Channels auth failures can arrive as WebSocket close codes
// after a successful socket open (not as an HTTP 401/403 handshake error). Keep
// these on the auth-refresh path and do not let a "stable" lifetime reset the
// reconnect counter, or a revoked/stale token can reconnect every ~1s forever.
function isAuthCloseCode(code: number): boolean {
  return code === 4401 || code === 4403 || code === 4001 || code === 4003 || code === 1008;
}

// SCLI-201: floor for the per-agent shizuha-id login fallback when the broker
// /token is unavailable. When the id login rate-limiter returns 429, the client
// must WAIT (honoring Retry-After) instead of hammering /auth/login/ and
// self-inflicting the rate-limit. Cap parsed Retry-After so a pathological
// header can't wedge an agent for hours.
const LOGIN_429_MIN_BACKOFF_MS = 30_000;
const LOGIN_429_MAX_BACKOFF_MS = 5 * 60_000;

/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into ms.
 *  Returns 0 when absent/unparseable. Clamped to LOGIN_429_MAX_BACKOFF_MS. */
function parseRetryAfterMs(header: string | null | undefined): number {
  if (!header) return 0;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, LOGIN_429_MAX_BACKOFF_MS);
  }
  const when = Date.parse(header);
  if (!Number.isNaN(when)) {
    return Math.max(0, Math.min(when - Date.now(), LOGIN_429_MAX_BACKOFF_MS));
  }
  return 0;
}

/**
 * Base URL for agent → real-platform auth + Connect WS. Prefers
 * SHIZUHA_PLATFORM_URL (the real shizuha-id / Connect, e.g. s1.tail). Falls
 * back to BACKEND_URL only when SHIZUHA_PLATFORM_URL is missing or loopback
 * (which is unreachable from inside a container). The daemon's BACKEND_URL
 * (:8016) is NOT a valid agent auth target — its mini-id 401s agent creds.
 */
function resolveConnectAuthBase(): string {
  const sp = (process.env['SHIZUHA_PLATFORM_URL'] || '').trim();
  if (sp && !sp.includes('127.0.0.1') && sp !== 'http://localhost') {
    return sp.replace(/\/+$/, '');
  }
  return (process.env['BACKEND_URL'] || sp || '').replace(/\/+$/, '');
}

/**
 * Reset this agent's shizuha-id password back to `password` via the daemon
 * admin token (DAEMON_ADMIN_TOKEN + AGENT_USER_ID, injected at spawn). Mirrors
 * AgentTokenManager.resyncPassword. Best-effort; returns true on success.
 */

function isJwtExpired(token: string): boolean {
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp !== 'number') return false;
    return payload.exp <= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function connectSocketUrl(wsUrl: string, token: string): string {
  const separator = wsUrl.includes('?') ? '&' : '?';
  return `${wsUrl}${separator}token=${encodeURIComponent(token)}&processing_ack=1`;
}

async function resyncAgentPassword(authBase: string, password: string): Promise<boolean> {
  const adminToken = process.env['DAEMON_ADMIN_TOKEN'] || '';
  const userId = process.env['AGENT_USER_ID'] || '';
  if (!adminToken || !userId) return false;
  try {
    const resp = await fetch(`${authBase}/id/api/auth/admin/users/${userId}/set-password/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(10000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export interface ParsedConnectInboundMessage {
  conversationId: string;
  content: string;
  senderId: string;
  senderName: string;
  messageId: string;
  createdAt?: string;
  conversationType: 'direct' | 'group' | 'unknown';
  senderSameOrg: true | false | 'unknown';
}

const CONNECT_ACK_ONLY = new Set([
  'ack', 'acknowledged', 'confirmed', 'closed', 'done', 'got it', 'noted',
  'ok', 'okay', 'received', 'resolved', 'sounds good', 'thanks', 'thank you',
  'understood', 'all set', 'no action needed', 'no further action',
  'no further action needed', 'no change', 'no gate-state change', 'response path ended', 'stopped', 'loop ended',
]);

function connectMessageBody(content: string): string {
  // Unicode format controls (Cf) are invisible but are not whitespace to
  // String.trim().  Connect has observed empty loop-terminal payloads made
  // solely from zero-width separators such as U+200B/U+2063; normalize those
  // away before deciding whether a message is empty.  Substantive characters
  // remain intact and therefore continue through normal delivery.
  return content.replace(/\p{Cf}/gu, '').trim().replace(/^\[[^\]\s]+\]\s*/, '').trim();
}

/**
 * Classify whole-message terminal Connect payloads conservatively. Unknown or
 * mixed/actionable text returns null and MUST be delivered to the agent turn.
 */
export function classifyConnectTurnSuppression(content: string): ConnectIngressReason | null {
  const body = connectMessageBody(content);
  if (!body) return 'ack_only';

  const normalized = body.toLowerCase().replace(/[.!]+$/g, '').trim();
  if (CONNECT_ACK_ONLY.has(normalized)) return 'ack_only';
  if (/^(?:acknowledged|confirmed|noted)[,;:\s-]+(?:no further action|no action needed)$/i.test(normalized)) {
    return 'ack_only';
  }
  if (/^bridge-mandated reply only(?:\b|[;:,.]).*$/i.test(body)) return 'no_reply_requested';
  if (/^(?:(?:thanks|thank you)[,;:.!\s-]*)?(?:no|do not|don't)\s+(?:further\s+)?(?:reply|response|acknowledg(?:e|ement))\s+(?:is\s+)?(?:needed|required|intended)[.!]?$/i.test(body)) {
    return 'no_reply_requested';
  }
  if (/^(?:thread|conversation)\s+(?:is\s+)?(?:closed|resolved|archived)[.!]?$/i.test(body)
    || /^closing\s+(?:this\s+)?thread[.!]?$/i.test(body)) {
    return 'thread_close';
  }

  // Reactions are admitted only when the entire body is emoji/modifier/joiner
  // material (or the conventional textual +1/-1 reaction). A sentence that
  // merely contains an emoji remains actionable and is delivered.
  if (/^[+-]1$/u.test(body)
    || /^(?=.*\p{Extended_Pictographic})(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|\s)+$/u.test(body)) {
    return 'reaction_only';
  }
  return null;
}

/** Conservative required-reply detector. Uncertain text remains optional. */
export function classifyConnectReplyObligation(content: string): Exclude<ConnectReplyObligation, 'none'> {
  const body = connectMessageBody(content);
  // A direct question remains an explicit reply obligation even when the
  // sender appends a courtesy/status sentence after it. Requiring the question
  // mark to be the final character silently downgraded messages such as
  // "Can you review this? Details below." to optional.
  if (/\?(?:\s|$)/u.test(body)) return 'required';
  if (/\b(?:please|kindly)\s+(?:reply|respond|inspect|check|review|verify|send|run|fix|deploy|proceed)\b/i.test(body)) return 'required';
  if (/\breply\s+(?:exactly|with\s+(?:the\s+)?(?:word|phrase|text))\b/i.test(body)) return 'required';
  return 'optional';
}

export function classifyConnectNonMessageEvent(type: string): ConnectIngressReason | null {
  switch (type) {
    case 'reaction_added':
    case 'reaction_removed':
    case 'reaction':
    case 'message_reaction':
    case 'message_reaction_added':
    case 'message_reaction_removed':
      return 'reaction_only';
    case 'conversation_closed':
    case 'conversation_archived':
    case 'conversation_deleted':
    case 'thread_closed':
      return 'thread_close';
    default:
      return null;
  }
}

export function shouldAcceptMissedMessageReplay(
  parsed: Pick<ParsedConnectInboundMessage, 'createdAt'>,
  acceptedCount: number,
  nowMs = Date.now(),
  maxMessages = parseInt(process.env['SHIZUHA_CONNECT_MAX_MISSED_MESSAGES'] ?? String(DEFAULT_MAX_MISSED_REPLAY_MESSAGES), 10),
  maxAgeHours = parseFloat(process.env['SHIZUHA_CONNECT_MAX_MISSED_AGE_HOURS'] ?? String(DEFAULT_MAX_MISSED_REPLAY_AGE_HOURS)),
): { ok: boolean; reason?: string } {
  const max = Number.isFinite(maxMessages) ? Math.max(0, Math.floor(maxMessages)) : DEFAULT_MAX_MISSED_REPLAY_MESSAGES;
  if (acceptedCount >= max) return { ok: false, reason: 'replay_cap' };

  const ageHours = Number.isFinite(maxAgeHours) ? maxAgeHours : DEFAULT_MAX_MISSED_REPLAY_AGE_HOURS;
  if (ageHours > 0 && parsed.createdAt) {
    const createdMs = Date.parse(parsed.createdAt);
    if (Number.isFinite(createdMs) && nowMs - createdMs > ageHours * 60 * 60 * 1000) {
      return { ok: false, reason: 'replay_too_old' };
    }
  }

  return { ok: true };
}

export function parseConnectInboundMessageEvent(
  msg: Record<string, unknown>,
  selfUserId = process.env['AGENT_USER_ID'] || '',
): ParsedConnectInboundMessage | null {
  const message = msg.message as Record<string, unknown> | undefined;
  const convId = ((msg.conversation_id as string | undefined)
    ?? (message?.conversation_id as string | undefined)
    ?? '').trim();
  if (!message || !convId) return null;

  const rawContent = ((message.content as string | undefined) ?? '').trim();
  if (!rawContent) return null;

  const senderName = (message.sender_name as string) ?? '';
  const senderId = String(message.sender_id ?? '');
  if (selfUserId && senderId && senderId === selfUserId) return null;

  const senderUsernameRaw = (message.sender_username as string) ?? '';
  const senderEmail = (message.sender_email as string) ?? '';

  // Resolve the canonical username prefix. Preference order:
  //   1. sender_username (canonical shizuha-id username — set at write time)
  //   2. sender_email local-part (fallback for legacy messages that pre-date sender_username)
  //   3. sender_name first token, lowercased (last-resort fallback)
  let senderUsername = senderUsernameRaw.trim();
  if (!senderUsername && senderEmail) {
    senderUsername = senderEmail.split('@')[0]?.trim() ?? '';
  }
  if (!senderUsername && senderName) {
    senderUsername = senderName.split(/\s+/)[0]?.toLowerCase() ?? '';
  }

  return {
    conversationId: convId,
    content: senderUsername ? `[${senderUsername}] ${rawContent}` : rawContent,
    senderId,
    senderName: senderUsername || senderName,
    messageId: (message.id as string) ?? '',
    createdAt: (message.created_at as string | undefined) ?? undefined,
    conversationType: message.conversation_type === 'direct' || message.conversation_type === 'group'
      ? message.conversation_type
      : 'unknown',
    senderSameOrg: message.sender_same_org === true || message.sender_same_org === false
      ? message.sender_same_org
      : 'unknown',
  };
}

export interface ConnectClientConfig {
  /** Called once the websocket is open and ready for sends. */
  onOpen?: () => void;
  /** Called when a human sends a message in one of the agent's conversations */
  onMessage?: (conversationId: string, content: string, senderId: string, senderName: string, messageId: string, conversationType: 'direct' | 'group' | 'unknown', replyObligation: Exclude<ConnectReplyObligation, 'none'>) => void;
  /** Called when a new conversation is created with this agent */
  onConversationCreated?: (conversationId: string) => void;
  /** Called when a live config push arrives via agent_config_update (HIVE-215) */
  onConfigUpdate?: (config: Record<string, unknown>) => void;
  /** Explicit Connect WS URL override (default: derived from SHIZUHA_PLATFORM_URL) */
  wsUrl?: string;
  /** Explicit JWT token override (default: self-authenticate using AGENT_USERNAME/AGENT_PASSWORD) */
  token?: string;
}

export class ConnectClient {
  private ws: WebSocket | null = null;
  private connectedAt = 0;
  private token: string;
  private wsUrl: string;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private authRetryAttempt = 0;
  private running = false;
  private forceTokenRefresh = false;
  // SCLI-201: the id-login fallback must back off on 429 (honor Retry-After) so
  // it never self-inflicts the id rate-limit. `authRateLimitedUntil` gates the
  // next login attempt; `authFailureStreak` suppresses the same-error-streak so
  // one fail-loud line is emitted, not a hot log loop that trips the andon.
  private authRateLimitedUntil = 0;
  private authFailureStreak = 0;
  private config: ConnectClientConfig;
  private missedReplayAccepted = 0;
  /** Bounded idempotency window across live/replay delivery on this client. */
  private recentInboundMessageIds = new Set<string>();

  /** Track accumulated content per conversation for complete events */
  private streamingContent = new Map<string, string[]>();

  constructor(config: ConnectClientConfig = {}) {
    this.config = config;
    this.token = config.token ?? '';
    this.wsUrl = config.wsUrl ?? this.deriveWsUrl();
  }

  /**
   * Derive the Connect WS URL.
   *
   * Agents speak to the REAL Connect directly (post-2026-04-20), so this must
   * resolve to the platform (SHIZUHA_PLATFORM_URL, e.g. http://s1.tail...),
   * NOT the daemon's BACKEND_URL (:8016) whose mini-id rejects agent creds and
   * whose host has no agent ChatConsumer. Falls back to BACKEND_URL only when
   * SHIZUHA_PLATFORM_URL is missing/loopback (unreachable inside containers).
   */
  private deriveWsUrl(): string {
    const platformUrl = resolveConnectAuthBase();
    if (!platformUrl) return '';
    const wsScheme = platformUrl.startsWith('https') ? 'wss' : 'ws';
    const host = platformUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `${wsScheme}://${host}/connect/ws/connect/agent/`;
  }

  /** Whether the client is connected and ready */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Start the Connect client.
   * Self-authenticates if no token provided, then connects.
   */
  async start(): Promise<void> {
    this.running = true;

    if (!this.wsUrl) {
      logger.info('[ConnectClient] No platform URL — Connect disabled');
      return;
    }

    if (!this.token) {
      await this.selfAuthenticate();
    }

    if (!this.token) {
      // Broker present but /token not ready yet (boot race — the sidecar mints
      // in the background and is readiness-gated). Retry with backoff instead of
      // disabling Connect forever; this also recovers Connect after a broker
      // re-mint/restart (PLAT-169 follow-up — fleettest2 hit the ~2s race). For
      // the non-broker (password) path a missing token is a real misconfig, so
      // keep the disable.
      // brokerEXPECTED (env set), not brokerPRESENT (socket file exists): at pod
      // boot the agent + sidecar start concurrently, so the UDS may not be bound
      // yet. Retry on expected so the earliest boot-race window (socket-not-
      // bound) recovers once the sidecar binds + mints, instead of permanently
      // disabling (PLAT-175 Codex P2 :140). Genuinely-no-broker (no env, no
      // socket) still falls through to the disable.
      if (brokerExpected()) {
        logger.warn('[ConnectClient] broker token not ready at start (socket bound=' + brokerPresent() + ') — retrying with backoff');
        this.scheduleAuthRetry();
        return;
      }
      logger.warn('[ConnectClient] No token after auth — Connect disabled');
      return;
    }

    this.connect();
  }

  /** Stop the client gracefully */
  stop(): void {
    this.running = false;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.close(1000, 'Agent shutting down'); this.ws = null; }
  }

  // ── Sending ──

  /**
   * Send a streaming event to a Connect conversation.
   * The AgentChatConsumer broadcasts these to all conversation participants.
   */
  /**
   * Live token/sentence stream for talk seats. Humans in the conversation
   * receive `agent_stream` frames; other agents do not (loop-safe).
   * Persistence still happens via sendComplete → sendConnectDm.
   */
  sendStreamEvent(conversationId: string, eventType: string, data: Record<string, unknown> = {}): void {
    if (!conversationId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        type: 'stream_event',
        conversation_id: conversationId,
        event_type: eventType,
        data,
      }));
    } catch { /* next token retries */ }
  }

  /**
   * DEPRECATED — see `sendStreamEvent`. No-op.
   */
  forwardBridgeEvent(_threadId: string, _msg: Record<string, unknown>): void {
    return;
  }

  /**
   * Send a typing indicator.
   */
  sendTyping(conversationId: string, isTyping: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        type: isTyping ? 'typing_start' : 'typing_stop',
        conversation_id: conversationId,
      }));
    } catch { /* ignore */ }
  }

  /**
   * Report agent runtime telemetry to the platform over the existing Connect
   * socket. The server (UserChatConsumer) stores the latest snapshot per agent
   * and surfaces it in Hive (live model / context% / tok-per-sec / health) and
   * routes reported errors to the proactive health stream. Fire-and-forget: if
   * the socket is down the snapshot is simply skipped (the next tick re-sends).
   * `payload` is an open-ended bag — send as much as is useful.
   */
  sendTelemetry(payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type: 'agent.telemetry', ...payload }));
      return true;
    } catch { return false; }
  }

  /** Durably acknowledge that the agent loop, not merely the WebSocket, has
   * completed an inbound Connect message. A failed send closes the socket so
   * the server replays the still-unacknowledged id on reconnect. */
  ackMessageProcessed(messageId: string): boolean {
    if (!messageId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ type: 'agent.message_processed', message_id: messageId }));
      return true;
    } catch {
      try { this.ws.close(1011, 'processing acknowledgement failed'); } catch { /* ignore */ }
      return false;
    }
  }

  // ── Private ──

  private connect(): void {
    // Never open a socket after stop() — guards the shutdown race where a
    // scheduleAuthRetry/scheduleReconnect timer already fired and its
    // selfAuthenticate() resolves AFTER stop() ran (no timer left to cancel),
    // which would otherwise reconnect a stopped client and keep the process
    // alive (PLAT-175 Codex P2). Covers all connect() callers in one place.
    if (!this.running) return;
    if (!this.token || !this.wsUrl) return;

    // Advertise the processing-ack contract in the opening handshake so the
    // server enables it before connect-time missed-message replay. The
    // capability frame sent after `open` remains an idempotent compatibility
    // signal, but is too late to classify frames the server sends while
    // accepting the socket.
    const url = connectSocketUrl(this.wsUrl, this.token);
    logger.info({ url: this.wsUrl }, '[ConnectClient] Connecting');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('[ConnectClient] Connected to Connect');
      this.connectedAt = Date.now();
      this.missedReplayAccepted = 0;
      // Transport delivery is not processing completion. Opt into the durable
      // sent-but-unprocessed replay contract before any new work is accepted.
      try {
        this.ws?.send(JSON.stringify({ type: 'agent.processing_ack_capability', version: 1 }));
      } catch { /* reconnect replay remains fail-safe */ }
      try { this.config.onOpen?.(); } catch { /* best-effort hook */ }
      // NB: do NOT reset reconnectAttempt here. A stale-token connection opens
      // then is immediately closed (1011) by the server; resetting on `open`
      // would pin the counter at 0 forever and the re-auth path (attempt > 3)
      // would never fire. The counter is reset in `close` only when the
      // connection proved stable (survived STABLE_CONNECTION_MS).
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch { /* ignore malformed JSON */ }
    });

    this.ws.on('close', (code: number) => this.handleSocketClose(code));

    this.ws.on('error', (err: Error) => {
      if (/Unexpected server response: (401|403|502)/.test(err.message)) {
        this.forceTokenRefresh = true;
        this.token = '';
      }
      logger.error({ err: err.message }, '[ConnectClient] WebSocket error');
    });
  }

  // Retry self-auth with capped backoff until the broker mints a token, then
  // connect. Used when the broker /token isn't ready at start (boot race) so
  // Connect comes up once the sidecar is healthy instead of staying disabled —
  // and recovers on a broker re-mint/restart (PLAT-169 follow-up). Reuses
  // reconnectTimer (no WS is active during this phase) so stop() cancels it.
  private scheduleAuthRetry(): void {
    if (!this.running) return;
    const backoff = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.authRetryAttempt), RECONNECT_MAX_MS);
    // SCLI-201: never retry the id login before the 429 rate-limit window clears,
    // even if that is longer than the normal backoff cap (honor Retry-After).
    const rateLimitWait = Math.max(0, this.authRateLimitedUntil - Date.now());
    const delay = Math.max(backoff, rateLimitWait);
    const jitter = delay * (0.75 + Math.random() * 0.5);
    this.authRetryAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.selfAuthenticate()
        .then(() => {
          if (this.token) {
            this.authRetryAttempt = 0;
            this.connect();
          } else {
            this.scheduleAuthRetry();
          }
        })
        .catch(() => this.scheduleAuthRetry());
    }, jitter);
  }

  private handleSocketClose(code: number): void {
    logger.info({ code }, '[ConnectClient] Disconnected');
    this.ws = null;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    // Only a connection that stayed open long enough to be real resets the
    // backoff/re-auth counter. Short-lived opens (e.g. expired-token 1011
    // flap) keep the counter climbing so scheduleReconnect() crosses the
    // re-auth threshold and re-mints the JWT instead of flapping forever.
    //
    // SCLI-220: explicit auth close codes (notably Connect 4401) are different:
    // the server can reject the already-open socket after it has survived the
    // stability window. Those must force token refresh and keep the reconnect
    // counter climbing, otherwise every close resets to attempt 0 and the agent
    // retries at ~1/s forever.
    const lifetime = this.connectedAt ? Date.now() - this.connectedAt : 0;
    this.connectedAt = 0;
    if (isAuthCloseCode(code)) {
      this.forceTokenRefresh = true;
      this.token = '';
      logger.warn(
        { code, lifetimeMs: lifetime, reconnectAttempt: this.reconnectAttempt },
        '[ConnectClient] Auth-class WebSocket close — forcing token refresh and preserving reconnect backoff',
      );
    } else if (lifetime >= STABLE_CONNECTION_MS) {
      this.reconnectAttempt = 0;
    }
    if (this.running) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const maxDelay = this.forceTokenRefresh ? AUTH_RECONNECT_MAX_MS : RECONNECT_MAX_MS;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), maxDelay);
    const jitter = delay * (0.75 + Math.random() * 0.5);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Re-authenticate if token might have expired, or if the previous WS
      // handshake looked auth-like. Nginx reports early upstream auth closes as
      // 502, so treat that like 401/403 and force a fresh token instead of
      // retrying a daemon-provisioned but stale/revoked AGENT_ACCESS_TOKEN.
      if (this.forceTokenRefresh || this.reconnectAttempt > 3) {
        this.selfAuthenticate()
          .then(() => {
            if (this.token) {
              this.connect();
            } else {
              this.scheduleReconnect();
            }
          })
          .catch(() => this.scheduleReconnect());
      } else {
        this.connect();
      }
    }, jitter);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    const terminalEventReason = classifyConnectNonMessageEvent(type);
    if (terminalEventReason) {
      recordConnectIngressEvent('suppressed', terminalEventReason);
      logger.info({ type, reason: terminalEventReason }, '[ConnectClient] Suppressed non-actionable Connect event at ingress');
      return;
    }

    switch (type) {
      case 'pong':
        break;

      case 'agent_config_update': {
        // HIVE-195: top-down config push from Hive relayed by Connect.
        const cfg = (msg.config as Record<string, unknown>) || {};
        logger.info({ keys: Object.keys(cfg) }, '[ConnectClient] agent_config_update received');
        try { this.config.onConfigUpdate?.(cfg); } catch { /* non-fatal */ }
        break;
      }

      case 'new_message':
      case 'missed_message': {
        const parsed = parseConnectInboundMessageEvent(msg);
        if (!parsed) {
          const message = msg.message as Record<string, unknown> | undefined;
          const convId = ((msg.conversation_id as string | undefined)
            ?? (message?.conversation_id as string | undefined)
            ?? '').trim();
          const senderId = String(message?.sender_id ?? '');
          const selfUserId = process.env['AGENT_USER_ID'] || '';
          if (selfUserId && senderId && senderId === selfUserId) {
            recordConnectIngressEvent('suppressed', 'self_echo');
            logger.debug(
              { convId: convId?.substring(0, 8), senderId },
              '[ConnectClient] Dropping self-message (own outbound echoed back)',
            );
          }
          break;
        }

        if (parsed.messageId && this.recentInboundMessageIds.has(parsed.messageId)) {
          recordConnectIngressEvent('suppressed', 'duplicate', parsed.conversationType);
          logger.info({
            convId: parsed.conversationId.substring(0, 8),
            sender: parsed.senderName,
            messageId: parsed.messageId,
          }, '[ConnectClient] Suppressed duplicate Connect message at ingress');
          break;
        }
        if (parsed.messageId) {
          this.recentInboundMessageIds.add(parsed.messageId);
          if (this.recentInboundMessageIds.size > 2048) {
            const oldest = this.recentInboundMessageIds.values().next().value as string | undefined;
            if (oldest) this.recentInboundMessageIds.delete(oldest);
          }
        }

        // CON-226 is deliberately Direct-only. Group admission remains owned
        // by CON-224/225; missing provenance fails open to one optional turn.
        const suppressionReason = parsed.conversationType === 'direct' && parsed.senderSameOrg === true
          ? classifyConnectTurnSuppression(parsed.content)
          : null;
        if (suppressionReason) {
          recordConnectIngressEvent('suppressed', suppressionReason, parsed.conversationType);
          logger.info({
            convId: parsed.conversationId.substring(0, 8),
            sender: parsed.senderName,
            messageId: parsed.messageId,
            reason: suppressionReason,
          }, '[ConnectClient] Suppressed non-actionable Connect message at ingress');
          break;
        }

        if (type === 'missed_message') {
          const accepted = shouldAcceptMissedMessageReplay(parsed, this.missedReplayAccepted);
          if (!accepted.ok) {
            recordConnectIngressEvent(
              'suppressed',
              accepted.reason === 'replay_cap' ? 'replay_cap' : 'replay_too_old',
            );
            logger.warn({
              convId: parsed.conversationId.substring(0, 8),
              sender: parsed.senderName,
              messageId: parsed.messageId,
              createdAt: parsed.createdAt,
              reason: accepted.reason,
              acceptedCount: this.missedReplayAccepted,
            }, '[ConnectClient] Dropping missed_message replay');
            break;
          }
          this.missedReplayAccepted++;
        }

        logger.info({
          convId: parsed.conversationId.substring(0, 8),
          sender: parsed.senderName,
          contentLen: parsed.content.length,
          replayed: type === 'missed_message',
        }, `[ConnectClient] Received ${type}`);

        // Inject-once: never force "required reply" solely because of channel type.
        // Group and direct both use content-based classification; silence is valid
        // unless the text itself is an explicit reply probe (see classifyConnectReplyObligation).
        const replyObligation = parsed.conversationType === 'unknown'
          ? 'optional'
          : parsed.senderSameOrg === true || parsed.conversationType === 'group'
            ? classifyConnectReplyObligation(parsed.content)
            : 'optional';
        recordConnectIngressEvent(
          'delivered',
          replyObligation === 'required' ? 'actionable' : 'actionable',
          parsed.conversationType,
        );
        recordConnectTurn(parsed.conversationType, replyObligation);

        this.config.onMessage?.(
          parsed.conversationId,
          parsed.content,
          parsed.senderId,
          parsed.senderName,
          parsed.messageId,
          parsed.conversationType,
          replyObligation,
        );
        break;
      }

      case 'conversation_created': {
        const convId = msg.conversation_id as string;
        if (convId) {
          logger.info({ conversationId: convId }, '[ConnectClient] Added to new conversation');
          this.config.onConversationCreated?.(convId);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Obtain a JWT that identifies this connection to Connect by logging in
   * to shizuha-id with AGENT_USERNAME / AGENT_PASSWORD. shizuha-id reads
   * `UserProfile.account_type` and stamps `is_agent: true` in the emitted
   * JWT for agent users — the single source of truth for agent identity.
   * No local minting fallback (was a security risk and is now gone).
   */
  private async selfAuthenticate(): Promise<void> {
    const envAccessToken = process.env['AGENT_ACCESS_TOKEN'];
    if (envAccessToken && !this.forceTokenRefresh) {
      if (!isJwtExpired(envAccessToken)) {
        this.token = envAccessToken;
        logger.info({ source: 'agent-access-token' }, '[ConnectClient] Authenticated via daemon-provisioned AGENT_ACCESS_TOKEN');
        return;
      }
      logger.warn({ source: 'agent-access-token' }, '[ConnectClient] daemon-provisioned AGENT_ACCESS_TOKEN is expired — falling back to broker/password re-auth');
    }

    // ── Preferred path: per-agent broker sidecar (PLAT-149/PLAT-169) ──
    // In k3s-native fleet pods AGENT_PASSWORD lives only in the broker sidecar,
    // which mints the JWT and serves it over the pod-local UDS. Fetch it there
    // instead of an in-container password login. No password fallback in broker
    // mode (the password is absent by design); on a not-ready broker we return
    // and let the reconnect loop retry. Token bytes are never logged.
    // brokerEXPECTED (env-configured), not just brokerPRESENT (socket exists):
    // in broker mode the UDS may not be bound yet at boot. fetchBrokerToken()
    // returns null until the socket binds + /token serves; we never fall back to
    // the password path in broker mode (the password is absent by design) — the
    // start()/reconnect retry loop re-runs this until the broker is ready.
    if (brokerExpected()) {
      const bt = await fetchBrokerToken();
      if (bt?.accessToken) {
        this.token = bt.accessToken;
        this.forceTokenRefresh = false;
        logger.info({ source: 'broker-uds' }, '[ConnectClient] Authenticated via broker /token');
        return;
      }
      // Broker /token unavailable. Connect is a per-user WS — each agent must
      // authenticate with ITS OWN shizuha-id identity. The shared host mcp-auth-proxy
      // serves the (shared) MODEL token but NOT a per-agent JWT (/token → 503), and
      // rt-fleet agents have no per-agent sidecar to mint one. So when we DO have
      // AGENT_PASSWORD, fall through to the per-agent password login below instead of
      // retrying a broker that will never serve /token. Only a true sidecar-broker pod
      // (password absent by design) keeps retrying the broker.
      if (!readAgentCredential('AGENT_PASSWORD')) {
        logger.warn('[ConnectClient] broker token not ready (socket bound=' + brokerPresent() + ') — Connect will retry');
        return;
      }
      logger.warn('[ConnectClient] broker /token unavailable — authenticating Connect with the agent\'s own shizuha-id credentials (per-agent identity)');
      // fall through to the password path
    }

    const username = process.env['AGENT_USERNAME'];
    const password = readAgentCredential('AGENT_PASSWORD');
    // Authenticate against the REAL shizuha-id (SHIZUHA_PLATFORM_URL). The
    // daemon's BACKEND_URL (:8016) shadows /id/api/auth/login/ and 401s on
    // agent credentials, so it must NOT be the primary auth base.
    const platformUrl = resolveConnectAuthBase();

    if (!username) {
      logger.warn('[ConnectClient] Missing AGENT_USERNAME — cannot authenticate');
      return;
    }

    // ── Primary path: shizuha-id login (with admin password self-heal) ──
    if (password && platformUrl) {
      const host = platformUrl.replace(/\/+$/, '');
      const endpoint = `${host}/id/api/auth/login/`;
      // SCLI-201: if the id login rate-limiter (429) told us to wait, do NOT hit
      // /auth/login/ again until the window clears — hammering it just re-trips
      // the limiter and keeps the agent wedged. The scheduler already spaced this
      // call, but guard here too in case any caller invokes us early.
      const rateLimitedFor = this.authRateLimitedUntil - Date.now();
      if (rateLimitedFor > 0) {
        return; // stay backed off; scheduleAuthRetry() waits out authRateLimitedUntil
      }
      const doLogin = () => fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(10000),
      });
      try {
        const resp = await doLogin();
        // SECURITY: no admin-token self-heal. Agents never hold
        // DAEMON_ADMIN_TOKEN (privilege-escalation risk). The daemon provisions
        // the account password reliably at spawn; drift recovery is owner-scoped.
        if (!resp.ok) {
          if (resp.status === 429) {
            // A 429 is a "wait", not a "retry immediately". Honor Retry-After;
            // floor to LOGIN_429_MIN_BACKOFF_MS so we stay well under the id
            // login rate-limit even when the header is absent.
            const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
            const backoffMs = Math.min(
              Math.max(retryAfterMs, LOGIN_429_MIN_BACKOFF_MS),
              LOGIN_429_MAX_BACKOFF_MS,
            );
            this.authRateLimitedUntil = Date.now() + backoffMs;
            // Fail-loud ONCE per streak, then suppress the repeat log so we do
            // not emit a same-error-streak that trips the bridge auto-andon.
            if (this.authFailureStreak === 0) {
              logger.warn(
                { endpoint, status: 429, retryAfterMs, backoffMs },
                '[ConnectClient] shizuha-id login rate-limited (429) — backing off and honoring Retry-After '
                + '(broker /token unavailable; suppressing repeat logs until recovery)',
              );
            }
            this.authFailureStreak++;
          } else {
            if (this.authFailureStreak === 0) {
              logger.warn({ endpoint, status: resp.status }, '[ConnectClient] shizuha-id login failed');
            }
            this.authFailureStreak++;
          }
        } else {
          const data = await resp.json() as {
            tokens?: { access?: string };
            access?: string;
            user?: { id?: number };
          };
          const token = data.tokens?.access ?? data.access;
          if (token) {
            this.token = token;
            this.forceTokenRefresh = false;
            if (this.authFailureStreak > 0) {
              logger.info(
                { username, streak: this.authFailureStreak },
                '[ConnectClient] shizuha-id login recovered after backoff',
              );
            }
            this.authRateLimitedUntil = 0;
            this.authFailureStreak = 0;
            logger.info(
              { username, userId: data.user?.id, source: 'shizuha-id-login' },
              '[ConnectClient] Authenticated via shizuha-id',
            );
            return;
          }
        }
      } catch (err) {
        if (this.authFailureStreak === 0) {
          logger.warn({ endpoint, err: (err as Error).message }, '[ConnectClient] shizuha-id login error');
        }
        this.authFailureStreak++;
      }
    }

    // No fallback — agents MUST authenticate via shizuha-id with real credentials.
    // Self-minting was removed as a security risk.
    logger.error(
      { username, platformUrl },
      '[ConnectClient] Cannot authenticate — shizuha-id login failed and no fallback available. ' +
      'Ensure AGENT_PASSWORD is set and shizuha-id is reachable at SHIZUHA_PLATFORM_URL.',
    );
  }
}
