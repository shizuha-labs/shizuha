/**
 * Connect Bridge — direct WebSocket client to a Connect backend (mini-Connect
 * on the daemon, or real shizuha-connect when the user points at a remote
 * platform). Translates Connect's slim protocol into the dashboard's existing
 * event shape so `useChat.ts` can consume it without a rewrite.
 *
 * Activated when the user has explicitly saved a Backend URL in Settings
 * (see `hasBackendUrlSet()` in backend.ts). When activated, the dashboard
 * opens TWO WebSockets:
 *   - `/ws/chat` (existing, daemon-internal events: agent state, RPC, streaming)
 *   - `${backendUrl}/connect/ws/connect/user/` (new, Connect chat events)
 *
 * `useChat.ts` filters chat-message events out of `/ws/chat` while the bridge
 * is active so we don't double-render. Agent streaming (session_start,
 * content, tool_*, complete) keeps flowing through `/ws/chat` because real
 * Connect intentionally no-ops agent_stream forwarding (see MESSAGING_PROTOCOL.md).
 */

import { backendApiUrl, connectWsUrl, getBackendUrl } from './backend';

/**
 * Bridge target = the dashboard's own origin (the daemon).
 *
 * The daemon's mini-Connect WS endpoint serves chat directly when in local
 * mode, or proxies transparently to real Connect when linked. Either way
 * the browser stays on a single host — no cross-origin WS, no per-backend
 * JWT mismatches, no CORS / Origin-validation gotchas.
 *
 * Conceptually the daemon IS the backend from the browser's POV, regardless
 * of where chat data ultimately lands.
 */
function bridgeTargetOrigin(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

export interface ConnectBridgeEvent {
  /** Dashboard-shape event type. */
  type: string;
  [key: string]: unknown;
}

interface ConnectMessage {
  id: string;
  conversation_id: string;
  sender_id: number;
  sender_is_agent: boolean;
  sender_username?: string;
  sender_name?: string;
  agent_id?: string | null;
  content: string;
  client_message_id: string | null;
  seq_num: number;
  // K1 cursors. `event_id` is the globally-monotonic BIGINT assigned by
  // Postgres on insert — used for cross-conversation cursor replay on WS
  // reconnect. `seqNum` is per-conversation, used for clock-skew-free
  // ordering within a conversation.
  event_id?: number | null;
  seqNum?: number | null;
  created_at: string;
}

interface ConnectParticipant {
  user_id: number;
  participant_type: 'human' | 'agent' | 'system';
  agent_id: string | null;
}

interface ConnectConversation {
  id: string;
  conversation_type: 'direct' | 'group';
  participants: ConnectParticipant[];
  last_message_at: string | null;
}

export interface ConnectBridgeConfig {
  /** Called for every translated dashboard-shape event. */
  onEvent: (event: ConnectBridgeEvent) => void;
  /** Called when the underlying WS opens or closes. */
  onConnectionChange?: (connected: boolean) => void;
}

/** Persistent outbox entry — outgoing send buffered while WS is closed. */
interface OutboxEntry {
  convId: string;
  content: string;
  clientMessageId: string;
  enqueuedAt: number;
}

const OUTBOX_STORAGE_KEY = 'shizuha_connect_outbox_v1';
const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Event-log cursor — highest `event_id` we've ingested across all
// conversations. Sent back as `since_event_id` on every WS open so the
// server replays exactly the delta (see MESSAGING_KAFKA.md § K4).
const CURSOR_STORAGE_KEY = 'shizuha_connect_cursor_v1';

export class ConnectBridge {
  private ws: WebSocket | null = null;
  private backendUrl: string;
  private jwt: string | null = null;
  private myUserId: number | null = null;
  private agentToConv = new Map<string, string>();   // agent_id (UUID) → conv_id
  private convToAgent = new Map<string, string>();   // conv_id → agent_id (UUID)
  private convToAgentUserId = new Map<string, number>(); // conv_id → agent's user_id
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private config: ConnectBridgeConfig;
  /** Sends buffered while WS was closed. Flushed on reconnect. Persisted to
   *  localStorage so they survive page refresh / tab restart. See
   *  MESSAGING_PROTOCOL.md § Resilience Contract (9). */
  private outbox: OutboxEntry[] = [];
  /** Highest `event_id` we've ever ingested. Sent to the server as
   *  `since_event_id` on every WS open (K4). null = never seen a cursor,
   *  server falls back to `last_read_event_id` or time-based window. */
  private eventCursor: number | null = null;

  constructor(config: ConnectBridgeConfig) {
    this.config = config;
    this.backendUrl = getBackendUrl();
    this.loadOutbox();
    this.loadCursor();
  }

  // ── Persistent outbox (offline send queue) ──
  //
  // WhatsApp behaviour: every send must eventually reach the server even if
  // composed offline, in a flaky tunnel, or while the tab was closed. The
  // outbox is persisted to localStorage on every enqueue and drained on WS
  // open. Server-side `UNIQUE(conversation_id, client_message_id)` means
  // replays are safe — the server returns the existing message instead of
  // duplicating. Entries older than OUTBOX_TTL_MS are pruned on load.

  private loadOutbox(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as OutboxEntry[];
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      this.outbox = parsed.filter((e) =>
        e && typeof e.convId === 'string' && typeof e.content === 'string'
        && typeof e.clientMessageId === 'string'
        && typeof e.enqueuedAt === 'number'
        && now - e.enqueuedAt < OUTBOX_TTL_MS,
      );
      if (this.outbox.length !== parsed.length) this.persistOutbox();
    } catch { this.outbox = []; }
  }

  private persistOutbox(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      if (this.outbox.length === 0) localStorage.removeItem(OUTBOX_STORAGE_KEY);
      else localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(this.outbox));
    } catch { /* quota / disabled — best-effort */ }
  }

  // ── Event-log cursor (K4 client side) ──
  //
  // The server assigns a globally-monotonic `event_id` to every DirectMessage
  // on insert (K1). The client stores the max it has ever seen and sends it
  // back on every WS open via `{type:"sync", since_event_id:N}`. The server
  // replays exactly the delta and emits `sync_complete` when caught up.
  //
  // This is the WhatsApp "server-side queue" contract: regardless of how
  // long the client was offline, reconnect produces a gap-free replay.

  private loadCursor(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(CURSOR_STORAGE_KEY);
      if (!raw) return;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) this.eventCursor = n;
    } catch { /* swallow */ }
  }

  private persistCursor(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      if (this.eventCursor === null) localStorage.removeItem(CURSOR_STORAGE_KEY);
      else localStorage.setItem(CURSOR_STORAGE_KEY, String(this.eventCursor));
    } catch { /* quota / disabled — best-effort */ }
  }

  /** Advance the cursor to `eventId` if it's higher than current. Monotonic. */
  private advanceCursor(eventId: unknown): void {
    if (typeof eventId !== 'number' || !Number.isFinite(eventId) || eventId <= 0) return;
    if (this.eventCursor === null || eventId > this.eventCursor) {
      this.eventCursor = eventId;
      this.persistCursor();
    }
  }

  private flushOutbox(): void {
    if (this.outbox.length === 0) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Copy & clear BEFORE sending so a mid-flush failure doesn't double-buffer.
    const toSend = this.outbox.slice();
    this.outbox = [];
    this.persistOutbox();
    for (const entry of toSend) {
      try {
        this.ws.send(JSON.stringify({
          type: 'send_message',
          conversation_id: entry.convId,
          content: entry.content,
          client_message_id: entry.clientMessageId,
        }));
      } catch {
        // Re-queue whatever we haven't flushed yet.
        this.outbox.push(entry);
      }
    }
    if (this.outbox.length > 0) this.persistOutbox();
  }

  /** True iff the bridge has an open WS to Connect. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Returns conv_id for a given agent (by UUID), or undefined if not mapped. */
  getConversationIdForAgent(agentId: string): string | undefined {
    return this.agentToConv.get(agentId);
  }

  /** Open the bridge: fetch JWT, build agent map, open WS to the daemon. */
  async start(): Promise<void> {
    try {
      // 0. Bridge target = dashboard origin (the daemon's mini-Connect WS).
      //    The daemon's WS handler serves locally OR proxies to upstream
      //    Connect when linked — browser doesn't care which.
      this.backendUrl = bridgeTargetOrigin();

      // 1. Session JWT for the daemon's mini-Connect.
      const jwtResp = await fetch('/v1/connect-jwt', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!jwtResp.ok) {
        throw new Error(`/v1/connect-jwt → ${jwtResp.status}`);
      }
      const jwtData = await jwtResp.json() as { access?: string; user?: { id?: number } };
      this.jwt = jwtData.access ?? null;
      this.myUserId = jwtData.user?.id ?? null;
      if (!this.jwt || !this.myUserId) throw new Error('connect-jwt response missing fields');

      // 2. Fetch the conversation list and build agent_id → conv_id mapping.
      await this.refreshConversations();

      // 3. Open the WS.
      this.connectWs();
    } catch (err) {
      console.warn('[connect-bridge] start failed:', err);
      this.scheduleReconnect();
    }
  }

  /** Close the bridge and stop reconnecting. */
  stop(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.config.onConnectionChange?.(false);
  }

  /**
   * Fetch recent history for a conversation via REST and deliver each message
   * as a synthetic `missed_message` event through `onEvent` — same code path
   * as the server's push on reconnect. Used on first-ever open of a chat to
   * hydrate the panel (matches Kotlin's `syncConversationMessages()`).
   *
   * Dedup is handled downstream: `useChat`'s user_message / complete handlers
   * reconcile by client_message_id / server id / (pending role+content) via
   * `insertOrdered`, so overlap with subsequent live `new_message`s is safe.
   *
   * Per MESSAGING_PROTOCOL.md § Resilience Contract (7): one-shot REST sync
   * on FIRST-EVER open only. Do NOT call on every reconnect — `missed_message`
   * via WS handles those.
   */
  async syncConversationHistory(agentId: string, opts?: { limit?: number }): Promise<number> {
    const convId = this.agentToConv.get(agentId);
    if (!convId || !this.jwt) return 0;
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
    const url = backendApiUrl(`/connect/api/conversations/${encodeURIComponent(convId)}/messages/?limit=${limit}`);
    try {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${this.jwt}` } });
      if (!resp.ok) return 0;
      const data = await resp.json() as
        | { messages?: ConnectMessage[] }
        | { results?: ConnectMessage[] }
        | ConnectMessage[];
      const messages: ConnectMessage[] = Array.isArray(data)
        ? data
        : ('messages' in data && data.messages) ? data.messages
        : ('results' in data && data.results) ? data.results
        : [];
      // Server returns newest-first; feed chronologically so the chat lands
      // in natural scroll order via the ordering helper downstream.
      const ordered = [...messages].sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      for (const message of ordered) {
        // Advance cursor from REST bootstrap too — otherwise first-ever
        // open + WS open would re-replay everything we just fetched.
        this.advanceCursor(message.event_id);
        this.handleConnectMessage({
          type: 'missed_message',
          conversation_id: convId,
          message: message as unknown as Record<string, unknown>,
        });
      }
      return ordered.length;
    } catch {
      return 0;
    }
  }

  /**
   * Send a `message_read` WS event to advance the server's `last_read_at`
   * for this user in this conversation. Per MESSAGING_PROTOCOL.md §
   * Resilience Contract (8): the server shrinks the `missed_message`
   * replay window based on `last_read_at` — without these receipts, every
   * reconnect re-sends the same 30-minute window. Idempotent: re-sending
   * for the same or older message is a no-op server-side.
   */
  sendReadReceipt(agentId: string, messageId: string): boolean {
    const convId = this.agentToConv.get(agentId);
    if (!convId) return false;
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({
      type: 'message_read',
      conversation_id: convId,
      message_id: messageId,
    }));
    return true;
  }

  /**
   * Send a chat message to the agent's conversation. Returns true if sent,
   * false if no conversation is mapped (caller can fall back to other paths).
   */
  sendChatMessage(agentId: string, content: string, clientMessageId: string): boolean {
    const convId = this.agentToConv.get(agentId);
    if (!convId) {
      console.warn('[connect-bridge] no conversation mapped for agent', agentId);
      return false;
    }
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // WS down — buffer the send persistently. On next open, `flushOutbox`
      // replays in order; server dedup (UNIQUE constraint on
      // conversation_id + client_message_id) makes replays idempotent.
      this.outbox.push({ convId, content, clientMessageId, enqueuedAt: Date.now() });
      this.persistOutbox();
      return true; // From the caller's POV, the send is guaranteed to land.
    }
    this.ws.send(JSON.stringify({
      type: 'send_message',
      conversation_id: convId,
      content,
      client_message_id: clientMessageId,
    }));
    return true;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async refreshConversations(): Promise<void> {
    if (!this.jwt) return;
    // 1. Agent roster (from the daemon) gives us user_id → agent_id. Real
    //    Connect stores conversation participants as plain users; it doesn't
    //    know which ones are agents. So we cross-reference here rather than
    //    trusting `participant.participant_type === 'agent'` (which real
    //    Connect never sets) or `participant.agent_id` (which it never
    //    populates for conversation participants — only for message senders).
    const userIdToAgentId = new Map<number, string>();
    try {
      const agentsResp = await fetch('/v1/agents', { credentials: 'same-origin' });
      if (agentsResp.ok) {
        const { agents } = await agentsResp.json() as { agents?: Array<{ id: string; platformUserId?: number }> };
        for (const a of agents ?? []) {
          if (typeof a.platformUserId === 'number' && a.platformUserId > 0) {
            userIdToAgentId.set(a.platformUserId, a.id);
          }
        }
      }
    } catch (err) {
      console.warn('[connect-bridge] /v1/agents fetch failed:', (err as Error).message);
    }

    // 2. Conversation list (direct DMs). Real Connect returns a plain list;
    //    the daemon's mini-Connect returns { results: [...] }. Handle both.
    const resp = await fetch(backendApiUrl('/connect/api/conversations/'), {
      headers: { Authorization: `Bearer ${this.jwt}` },
    });
    if (!resp.ok) {
      console.warn('[connect-bridge] conversations fetch failed:', resp.status);
      return;
    }
    const data = await resp.json();
    const convList: ConnectConversation[] = Array.isArray(data)
      ? (data as ConnectConversation[])
      : ((data as { results?: ConnectConversation[] }).results ?? []);

    this.agentToConv.clear();
    this.convToAgent.clear();
    this.convToAgentUserId.clear();

    for (const conv of convList) {
      if (conv.conversation_type !== 'direct') continue;
      // Find the participant whose user_id is a known agent. We do not use
      // "not me" to identify the other participant because the bridge's
      // `myUserId` comes from the local mini-Connect JWT, which has a
      // different user-id space than real Connect's upstream. Matching by
      // agent-roster membership works regardless of which side minted the
      // JWT the proxy is piping.
      for (const p of conv.participants) {
        const agentId = userIdToAgentId.get(Number(p.user_id))
          ?? (p.participant_type === 'agent' && p.agent_id ? p.agent_id : undefined);
        if (agentId) {
          this.agentToConv.set(agentId, conv.id);
          this.convToAgent.set(conv.id, agentId);
          this.convToAgentUserId.set(conv.id, Number(p.user_id));
          break; // one agent per direct DM — skip remaining participants
        }
      }
    }
    console.log(
      `[connect-bridge] refreshConversations: ${this.agentToConv.size} agent→conv mappings ` +
      `(agents seen: ${userIdToAgentId.size}, convs seen: ${convList.length})`,
    );
  }

  private connectWs(): void {
    if (!this.jwt || this.disposed) return;
    if (this.ws) {
      try { this.ws.close(); } catch { /* swallow */ }
    }
    const url = connectWsUrl('/connect/ws/connect/user/', this.jwt, this.backendUrl);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.disposed) return;
      this.reconnectAttempt = 0;
      this.config.onConnectionChange?.(true);
      this.config.onEvent({ type: 'transport_status', connected: true, source: 'connect-bridge' });
      // K4 cursor replay. Send immediately on open — before flushing the
      // outbox — so the server's missed_message replay and our own outbound
      // sends are serialized by the server in correct event-id order.
      // When `eventCursor` is null (first-ever open), omit the field;
      // server falls back to last_read_event_id / time window.
      const syncFrame: Record<string, unknown> = { type: 'sync' };
      if (this.eventCursor !== null) syncFrame.since_event_id = this.eventCursor;
      try { this.ws!.send(JSON.stringify(syncFrame)); } catch { /* best-effort */ }
      // Drain any sends that were composed while the socket was closed.
      // Server-side uniqueness on (conversation_id, client_message_id) keeps
      // replays of already-landed sends idempotent.
      this.flushOutbox();
    };

    ws.onmessage = (evt) => {
      if (this.disposed || ws !== this.ws) return;
      try {
        const msg = JSON.parse(evt.data);
        this.handleConnectMessage(msg);
      } catch { /* ignore malformed JSON */ }
    };

    ws.onclose = () => {
      if (this.disposed || ws !== this.ws) return;
      this.ws = null;
      this.config.onConnectionChange?.(false);
      this.config.onEvent({ type: 'transport_status', connected: false, source: 'connect-bridge' });
      this.scheduleReconnect();
    };

    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 15000);
    this.reconnectAttempt++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      // Re-fetch JWT every few retries — token has 1h lifetime.
      if (this.reconnectAttempt > 3) {
        this.start();
      } else {
        this.connectWs();
      }
    }, delay);
  }

  private handleConnectMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    switch (type) {
      case 'pong':
        return;

      case 'ping':
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'pong' }));
        }
        return;

      // `missed_message` is what `UserChatConsumer._push_missed_messages`
      // sends on WS (re)connect for every DirectMessage since the
      // participant's `last_read_at` cutoff (see MESSAGING_PROTOCOL.md
      // § History Replay on Connect/Reconnect). Shape is identical to
      // `new_message` — same `message` payload, same routing — so we
      // handle both in one branch. Without this case the chat panel
      // stays blank on refresh; the live feed only catches messages
      // that arrive AFTER the socket opens.
      case 'new_message':
      case 'missed_message': {
        const message = msg.message as ConnectMessage;
        if (!message) return;
        const convId = (msg.conversation_id as string) || message.conversation_id;
        const agentId = this.convToAgent.get(convId);

        // Advance the event-log cursor. Track for EVERY message we ingest —
        // including our own echoes — because the server's subsequent
        // `since_event_id` replay must skip over rows we've already seen
        // regardless of who sent them.
        this.advanceCursor(message.event_id);

        // Drop if this is the dashboard owner's own send (echoed back). We
        // already render it optimistically when the user typed.
        const isMine = this.myUserId !== null && Number(message.sender_id) === this.myUserId;

        // Server-authoritative created_at. `eventTimestampToIso` in useChat
        // reads the numeric `_ts` (ms since epoch), while the string
        // `timestamp` field is kept for any other consumer. Without _ts
        // here, the dashboard would fall back to `new Date().toISOString()`
        // at render time — which is why history replayed via this path was
        // collapsing to "now" instead of the real send time.
        const createdAtMs = Date.parse(message.created_at);
        const tsNum = Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : undefined;

        if (message.sender_is_agent) {
          // Agent sent a final reply — emit a `complete` event so useChat.ts
          // closes out the assistant turn and renders the message.
          this.config.onEvent({
            type: 'complete',
            agent_id: agentId,
            conversation_id: convId,
            data: {
              content: message.content,
              message_id: message.id,
              client_message_id: message.client_message_id,
            },
            timestamp: message.created_at,
            _ts: tsNum,
          });
        } else {
          // User-sent message — either (a) our own echo across tabs/devices
          // or (b) another human in this conversation. Emit user_message
          // either way; useChat's insertOrdered reconciles by
          // `client_message_id` (rule 0, WhatsApp-style primary dedup) so
          // the optimistic pending entry on THIS tab collapses into the
          // server-echoed version without duplication. On OTHER tabs of
          // the same user, there's no pending entry, so the message
          // inserts fresh.
          this.config.onEvent({
            type: 'user_message',
            agent_id: agentId,
            conversation_id: convId,
            data: {
              content: message.content,
              user_id: message.sender_id,
              sender_username: message.sender_username,
              sender_name: message.sender_name,
              message_id: message.id,
              client_message_id: message.client_message_id,
            },
            timestamp: message.created_at,
            _ts: tsNum,
          });
        }
        return;
      }

      case 'agent_stream': {
        const eventType = msg.event_type as string;
        const data = (msg.data ?? {}) as Record<string, unknown>;
        const convId = msg.conversation_id as string;
        const agentId = this.convToAgent.get(convId);
        // Map the Connect event_type to the dashboard's flat event shape.
        const out: ConnectBridgeEvent = {
          type: eventType,
          agent_id: agentId,
          conversation_id: convId,
          data,
        };
        this.config.onEvent(out);
        return;
      }

      case 'typing': {
        const convId = msg.conversation_id as string;
        const agentId = this.convToAgent.get(convId);
        this.config.onEvent({
          type: 'typing',
          agent_id: agentId,
          conversation_id: convId,
          user_id: msg.user_id,
          is_typing: msg.is_typing,
        });
        return;
      }

      case 'message_read': {
        // Read receipt — emit as-is for now; useChat.ts can ignore if not handled.
        const convId = msg.conversation_id as string;
        this.config.onEvent({
          type: 'message_read',
          conversation_id: convId,
          user_id: msg.user_id,
          message_id: msg.message_id,
        });
        return;
      }

      case 'conversation_created': {
        // A new conversation includes us — refresh the mapping in case it's
        // a new agent we didn't know about.
        this.refreshConversations().catch(() => { /* swallow */ });
        return;
      }

      case 'send_error':
        // Echo the error so useChat can surface it.
        this.config.onEvent({
          type: 'error',
          conversation_id: msg.conversation_id,
          error: msg.error,
          client_message_id: msg.client_message_id,
        });
        return;

      case 'sync_complete':
        // Server has drained the delta since our `since_event_id`. Nothing
        // more to do — the preceding `missed_message` frames already updated
        // state. Silently consume to keep the `unknown message type` noise
        // out of the console.
        return;

      case 'history': {
        // K5: scroll-back pagination response. Emit each message as a
        // synthetic `missed_message` so the same upsert path handles it.
        // (Dashboard doesn't currently trigger `history` requests; this is
        // forward-wiring so Connect K5 lands end-to-end.)
        const messages = (msg.messages ?? []) as ConnectMessage[];
        const convId = msg.conversation_id as string;
        // Server sends newest-first; emit chronologically so insertOrdered
        // puts them in natural scroll order.
        const ordered = [...messages].sort((a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        for (const message of ordered) {
          this.advanceCursor(message.event_id);
          this.handleConnectMessage({
            type: 'missed_message',
            conversation_id: convId,
            message: message as unknown as Record<string, unknown>,
          });
        }
        return;
      }
    }
  }
}
