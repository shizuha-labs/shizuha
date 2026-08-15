/**
 * Core chat hook — manages messages and WebSocket streaming.
 *
 * When agentId is set, connects via WebSocket to /ws/chat (dashboard bridge).
 * Otherwise falls back to POST /v1/query/stream (local TUI mode).
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { ChatMessage, ToolCall, ImageAttachment } from '../lib/types';
import {
  buildReplayBatchKey,
  eventTimestampToIso,
  insertOrdered,
  resolveAssistantTurnId,
  upsertAssistantMessage,
} from '../lib/chat-sync';
import { ConnectBridge } from '../lib/connect-bridge';
import { loadCachedMessages, saveCachedMessages } from '../lib/connect-cache';

/**
 * Generate a UUID v4 that works in both secure and insecure contexts.
 *
 * `crypto.randomUUID()` requires a secure context (HTTPS / localhost).
 * `crypto.getRandomValues()` works in every context that has a `crypto` object,
 * including plain HTTP on a non-local host. We fall back to it and build a
 * v4 UUID manually. As a last-resort fallback (no `crypto` at all) we use
 * `Math.random()` — not cryptographically strong, but still a valid v4 shape
 * which is all Connect's `client_message_id` uniqueness check requires.
 */
function generateUuidV4(): string {
  const g = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }) : {};
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 §4.4: set version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' + hex.slice(4, 6).join('') +
    '-' + hex.slice(6, 8).join('') +
    '-' + hex.slice(8, 10).join('') +
    '-' + hex.slice(10, 16).join('')
  );
}

/** Unwrap gateway event envelopes to get the effective event type. */
function unwrapEventType(evt: Record<string, unknown>): string {
  if (evt.type === 'stream_event' && evt.event) {
    return (evt.event as Record<string, unknown>).type as string;
  }
  if (evt.type === 'execution_complete') return 'complete';
  if (evt.type === 'execution_error') return 'error';
  return evt.type as string;
}

// ── localStorage persistence helpers ──

const STORAGE_PREFIX = 'shizuha_chat_';
const CURSOR_PREFIX = 'shizuha_cursor_';
const MAX_PERSISTED_MESSAGES = 200;

// localStorage message caching DISABLED — was causing flip-flop on refresh.
// Messages now come exclusively from event log replay (single source of truth).
// The committed cursor in localStorage is still used for replay efficiency.
function loadPersistedMessages(_agentId: string): ChatMessage[] {
  return [];
}

/** Find the last server-assigned message ID (UUID) from cached messages for delta sync. */
function lastServerMessageId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]!.id;
    // Server IDs are UUIDs; skip client-generated IDs (user-*, assistant-*, etc.)
    if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)) return id;
  }
  return null;
}

// localStorage persistence disabled — event log is the single source of truth.
function persistMessages(_agentId: string, _messages: ChatMessage[]) {
  // no-op
}

function clearPersistedMessages(agentId: string) {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${agentId}`);
  } catch { /* ignore */ }
}

/** Clear persisted messages for ALL agents and advance all cursors. */
function clearAllPersistedMessages() {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) keysToRemove.push(key);
    }
    for (const key of keysToRemove) localStorage.removeItem(key);

    // Advance committed cursor for every agent to their session cursor.
    // Without this, switching to another agent triggers event replay from
    // the old cursor, repopulating the chat we just cleared.
    for (const [agentId, seq] of sessionCursor.entries()) {
      if (seq > 0) commitCursor(agentId, seq);
    }
  } catch { /* ignore */ }
}

/**
 * Two-cursor system (Kafka-style):
 *
 * 1. **committedCursor** (localStorage) — advances only on boundary events
 *    (complete/error). Sent in sync requests so page refresh replays full
 *    content from the last completed turn. Like Kafka's committed offset.
 *
 * 2. **sessionCursor** (in-memory Map) — advances on every event seen in this
 *    page session. Used to skip already-processed events on WS reconnect
 *    (without page refresh). Like Kafka's in-flight offset. Lost on refresh.
 */
const sessionCursor = new Map<string, number>();

/** Load the committed (persisted) cursor — always 0 to replay from server. */
function loadCommittedCursor(_agentId: string): number {
  // Always return 0 — forces full replay from event log on every page load.
  // This ensures messages always come from the server (single source of truth)
  // and eliminates the flip-flop bug caused by cursor/message desync.
  return 0;
}

/** Persist cursor — disabled (always replay from 0). */
function commitCursor(_agentId: string, _seq: number) {
  // no-op — cursor not persisted
}

/** Get the session cursor (highest seq seen in this page session). */
function getSessionCursor(agentId: string): number {
  return sessionCursor.get(agentId) ?? loadCommittedCursor(agentId);
}

/** Advance the session cursor. */
function advanceSessionCursor(agentId: string, seq: number) {
  const current = getSessionCursor(agentId);
  if (seq > current) sessionCursor.set(agentId, seq);
}

interface UseChatOptions {
  apiBase?: string;
  defaultModel?: string;
  authHeaders?: () => Record<string, string>;
  /** When set, uses WebSocket via the dashboard bridge */
  agentId?: string | null;
  /** Dashboard auth state — WS only connects when 'authenticated' */
  authState?: 'loading' | 'login' | 'authenticated';
  /** Called when the server pushes a full agent list snapshot */
  onAgentsSnapshot?: (agents: unknown[]) => void;
  /** Called when the server pushes a single agent update */
  onAgentUpdated?: (agent: unknown) => void;
  /** Called when the daemon reports that the dashboard session is no longer authenticated. */
  onDashboardAuthExpired?: () => boolean | Promise<boolean>;
  /** Called when sync events arrive from the platform */
  onSyncEvent?: (event: { type: string; [key: string]: unknown }) => void;
}

interface ClearedChatState {
  clearedSeq: number;
  suppressStreamingTurn: boolean;
  suppressedTurnId: string | null;
  suppressedRequestId: string | null;
}

function isBoundaryEvent(type: string): boolean {
  return type === 'complete' || type === 'error';
}

function isChatEventType(type: string): boolean {
  return type === 'content'
    || type === 'content_reset'
    || type === 'user_message'
    || type === 'complete'
    || type === 'error'
    || type === 'tool_start'
    || type === 'tool_complete'
    || type === 'tool_result'
    || type === 'proactive_message'
    || type === 'status_update'
    || type === 'reasoning'
    || type === 'reasoning_text'
    || type === 'thinking'
    || type === 'session_start'
    || type === 'turn_complete'
    || type === 'execution_complete'
    || type === 'auth_required'
    || type === 'auth_device_code'
    || type === 'auth_polling'
    || type === 'auth_complete'
    || type === 'auth_error'
    || type === 'model_fallback';
}

function isAssistantStreamEventType(type: string): boolean {
  return type === 'session_start'
    || type === 'content'
    || type === 'content_reset'
    || type === 'tool_start'
    || type === 'tool_complete'
    || type === 'tool_result'
    || type === 'reasoning'
    || type === 'reasoning_text'
    || type === 'thinking'
    || type === 'complete'
    || type === 'error'
    || type === 'turn_complete'
    || type === 'execution_complete'
    || type === 'status_update'
    || type === 'auth_required'
    || type === 'auth_device_code'
    || type === 'auth_polling'
    || type === 'auth_complete'
    || type === 'auth_error'
    || type === 'model_fallback';
}

export function useChat(options: UseChatOptions = {}) {
  const {
    apiBase = '',
    defaultModel = 'claude-sonnet-4-20250514',
    authHeaders,
    agentId,
    authState: dashboardAuthState,
    onAgentsSnapshot,
    onAgentUpdated,
    onDashboardAuthExpired,
    onSyncEvent,
  } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Mirror of messages state, kept in sync via effect below. Used by
  // callbacks (e.g. read-receipt emitter) that need the latest array but
  // shouldn't re-subscribe on every mutation.
  const messagesRef = useRef<ChatMessage[]>([]);
  // In-memory per-agent message cache (survives agent switches, lost on page close).
  // This replaces localStorage caching — messages are kept in RAM, so switching
  // agents and back restores them instantly without waiting for event log replay.
  const agentMessageCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  // Tracks which agents have had a first-load REST hydration this session,
  // so agent toggles don't re-fetch and parallel effect re-fires (wsConnected
  // toggling on reconnect) don't double-fetch.
  const syncedHistoryRef = useRef<Set<string>>(new Set());
  // Tracks the most recent server-authoritative message id we've sent a
  // `message_read` WS event for, per agent. Prevents re-firing on every
  // render while also allowing later messages to advance the cursor.
  const lastReadReceiptRef = useRef<Map<string, string>>(new Map());
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [reasoningSummaries, setReasoningSummaries] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [model, setModel] = useState(defaultModel);
  const [mode, setMode] = useState<'plan' | 'supervised' | 'autonomous'>('supervised');
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [turnCount, setTurnCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const connectBridgeRef = useRef<ConnectBridge | null>(null);
  const bridgeActiveRef = useRef<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);
  const accumulatedRef = useRef('');
  const toolCallsRef = useRef<ToolCall[]>([]);
  const reasoningRef = useRef<string[]>([]);
  /** True while processing an event_replay batch — disables session cursor dedup. */
  const isReplayingRef = useRef(false);
  /** Dedup key for event_replay — prevents processing identical replays (e.g., 4x from duplicate syncs). Reset on WS disconnect so reconnect replays are processed. */
  const lastReplayKeyRef = useRef('');
  /**
   * True between sending a sync request and receiving its event_replay response.
   * While set, real-time events must NOT advance the session cursor — otherwise
   * the event_replay dedup filter (preReplaySessionCursor) skips legitimate events.
   * Race: agent switch → sync(cursor=0) → real-time events arrive → advance cursor →
   * event_replay arrives → preReplaySessionCursor is high → skips most replay events.
   * Queued events are processed after replay completes.
   */
  const pendingReplayRef = useRef(false);
  const queuedEventsRef = useRef<Array<Record<string, unknown>>>([]);

  // ── RPC over WebSocket ──
  const rpcPendingRef = useRef<Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map());
  const onAgentsSnapshotRef = useRef(onAgentsSnapshot);
  const onAgentUpdatedRef = useRef(onAgentUpdated);
  const onSyncEventRef = useRef(onSyncEvent);
  onAgentsSnapshotRef.current = onAgentsSnapshot;
  onAgentUpdatedRef.current = onAgentUpdated;
  onSyncEventRef.current = onSyncEvent;
  const toolsRanRef = useRef(false);
  const streamingRef = useRef(false);
  /**
   * Per-agent local clear fences. A clear is browser-local: old events at or before
   * clearedSeq must stay hidden, but genuinely new events after the clear should
   * still appear. If a turn was mid-stream at clear time, suppress its remaining
   * assistant events until that turn reaches a boundary.
   */
  const clearedChatRef = useRef<Map<string, ClearedChatState>>(new Map());
  const agentIdRef = useRef<string | null>(agentId ?? null);
  const prevAgentIdRef = useRef<string | null>(null);
  const currentAssistantMessageIdRef = useRef<string | null>(null);
  const currentAssistantCreatedAtRef = useRef<string | null>(null);
  const currentAssistantSeqRef = useRef<number | undefined>(undefined);
  const currentUserRequestIdRef = useRef<string | null>(null);

  // ── Persist messages on every change ──

  useEffect(() => {
    const aid = agentIdRef.current;
    if (aid && messages.length > 0) {
      persistMessages(aid, messages);
    }
  }, [messages]);

  // ── Save & restore on agent switch ──

  useEffect(() => {
    const prevAid = prevAgentIdRef.current;
    const newAid = agentId ?? null;
    agentIdRef.current = newAid;

    // Finalize any in-flight stream as an interrupted message so it's saved
    if (streamingRef.current && accumulatedRef.current && prevAid) {
      const partialMsg: ChatMessage = {
        id: currentAssistantMessageIdRef.current ?? `assistant-interrupted-${Date.now()}`,
        role: 'assistant',
        content: accumulatedRef.current,
        toolCalls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
        reasoningSummaries: reasoningRef.current.length > 0 ? [...reasoningRef.current] : undefined,
        status: 'complete',
        createdAt: currentAssistantCreatedAtRef.current ?? new Date().toISOString(),
      };
      // Save the partial message into the old agent's persisted messages
      const oldMsgs = loadPersistedMessages(prevAid);
      persistMessages(prevAid, upsertAssistantMessage(oldMsgs, partialMsg, false));
    }
    // Reset streaming state
    if (streamingRef.current) {
      streamingRef.current = false;
      setIsStreaming(false);
      setStreamingContent('');
      setActiveTools([]);
      setReasoningSummaries([]);
      accumulatedRef.current = '';
      toolCallsRef.current = [];
      reasoningRef.current = [];
      toolsRanRef.current = false;
    }
    currentAssistantMessageIdRef.current = null;
    currentAssistantCreatedAtRef.current = null;

    // Restore persisted messages for the new agent.
    if (newAid && newAid !== prevAid) {
      // Save current agent's messages to in-memory cache before switching
      if (prevAid) {
        setMessages((prev) => {
          if (prev.length > 0) agentMessageCacheRef.current.set(prevAid, prev);
          return prev;
        });
      }

      // Restore from in-memory cache (instant) or start empty. If neither,
      // kick off an IndexedDB read so the panel fills in within a frame or
      // two on page refresh without waiting for WS/REST round-trips.
      const cached = agentMessageCacheRef.current.get(newAid) ?? [];
      if (cached.length > 0) {
        setMessages(cached);
        let inTok = 0, outTok = 0, turns = 0;
        for (const m of cached) {
          if (m.role === 'assistant') {
            inTok += m.inputTokens ?? 0;
            outTok += m.outputTokens ?? 0;
            turns++;
          }
        }
        setTotalInputTokens(inTok);
        setTotalOutputTokens(outTok);
        setTurnCount(turns);
      } else {
        setMessages([]);
        setTotalInputTokens(0);
        setTotalOutputTokens(0);
        setTurnCount(0);
        // Fire-and-forget IndexedDB hydration. When it returns, only apply
        // if the user is still on this agent and messages is still empty
        // (don't clobber live data that may have arrived in the meantime).
        loadCachedMessages(newAid).then((persisted) => {
          if (persisted.length === 0) return;
          if (agentIdRef.current !== newAid) return;
          setMessages((prev) => prev.length === 0 ? persisted : prev);
          agentMessageCacheRef.current.set(newAid, persisted);
        }).catch(() => { /* non-fatal */ });
      }
      setError(null);
      setSessionId(null);
      currentAssistantMessageIdRef.current = null;
      currentAssistantCreatedAtRef.current = null;

      // Clear session cursor so the sync effect sends cursor=0 and replays
      // all events from the event log. Without this, the in-memory cursor
      // from a previous visit to this agent would skip the replay.
      sessionCursor.delete(newAid);

      // Sync is handled by the [agentId, wsConnected] effect below.
      // Do NOT send sync here — both effects share agentId in their deps,
      // so both fire on agent switch. Sending sync in both causes two
      // identical replays → duplicate messages.

      // On refresh, Connect history arrives via the WS `missed_message`
      // events that `UserChatConsumer._push_missed_messages` sends on
      // every fresh connect. See MESSAGING_PROTOCOL.md § History Replay.
    }

    prevAgentIdRef.current = newAid;
  }, [agentId]);

  // ── Save streaming state on page refresh/close ──
  // The agent switch effect only fires when agentId changes, NOT on unmount.
  // Without this, a page refresh mid-stream loses the accumulated content.
  // The event log replay will reconstruct it, but this provides immediate
  // partial content in localStorage so the user sees something right away.

  useEffect(() => {
    const handleBeforeUnload = () => {
      const aid = agentIdRef.current;
      if (aid && streamingRef.current && accumulatedRef.current) {
        const partialMsg: ChatMessage = {
          id: currentAssistantMessageIdRef.current ?? `assistant-interrupted-${Date.now()}`,
          role: 'assistant',
          content: accumulatedRef.current,
          toolCalls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
          reasoningSummaries: reasoningRef.current.length > 0 ? [...reasoningRef.current] : undefined,
          status: 'complete',
          createdAt: currentAssistantCreatedAtRef.current ?? new Date().toISOString(),
        };
        const oldMsgs = loadPersistedMessages(aid);
        persistMessages(aid, upsertAssistantMessage(oldMsgs, partialMsg, false));
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // ── WebSocket connection (gated on dashboard auth) ──

  const reconnectWsRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Don't connect WS until dashboard auth is confirmed
    if (dashboardAuthState !== 'authenticated') return;

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let activeSocket: WebSocket | null = null;

    const clearReconnectTimer = () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };
    const clearConnectTimeout = () => { if (connectTimeoutTimer) { clearTimeout(connectTimeoutTimer); connectTimeoutTimer = null; } };

    // Exponential backoff: Firefox on HTTP kills WS connections for ~20s after
    // page load. Instead of spamming retries, back off: 1s, 2s, 4s, 8s...
    let attempt = 0;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      // After successful connection (attempt reset to 0), use short delay.
      // During initial connect failures, back off exponentially.
      const delay = attempt === 0 ? 3000 : Math.min(1000 * Math.pow(2, attempt - 1), 15000);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; void waitAndConnect(); }, delay);
    };

    function connectWs() {
      if (disposed) return;
      attempt++;

      // Close any lingering socket
      if (activeSocket) {
        activeSocket.onopen = null; activeSocket.onmessage = null;
        activeSocket.onclose = null; activeSocket.onerror = null;
        if (activeSocket.readyState === WebSocket.CONNECTING || activeSocket.readyState === WebSocket.OPEN) activeSocket.close();
        activeSocket = null;
      }

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws/chat?_t=${Date.now()}`;
      const ws = new WebSocket(wsUrl);
      activeSocket = ws;
      wsRef.current = ws;
      (window as Window & { __shizuhaWs?: WebSocket | null }).__shizuhaWs = ws;

      // Connect timeout: if onopen doesn't fire within 3s, close and retry
      // with exponential backoff. Suppresses console noise from rapid retries.
      clearConnectTimeout();
      connectTimeoutTimer = setTimeout(() => {
        connectTimeoutTimer = null;
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
          ws.close();
          activeSocket = null; wsRef.current = null;
          scheduleReconnect();
        }
      }, 3000);

      ws.onopen = () => {
        clearConnectTimeout();
        if (disposed || activeSocket !== ws) return;
        attempt = 0; // Reset backoff on success
        setWsConnected(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        if (disposed || activeSocket !== ws) return;
        try { handleWsMessage(JSON.parse(event.data)); } catch { /* ignore parse errors */ }
      };

      ws.onclose = () => {
        clearConnectTimeout();
        if (disposed || activeSocket !== ws) return;
        activeSocket = null; wsRef.current = null;
        setWsConnected(false);
        const w = window as Window & { __shizuhaWs?: WebSocket | null };
        if (w.__shizuhaWs === ws) w.__shizuhaWs = null;
        lastReplayKeyRef.current = '';
        pendingReplayRef.current = false;
        queuedEventsRef.current = [];
        scheduleReconnect();
      };

      ws.onerror = () => { /* onclose follows */ };
    }

    // Firefox kills WebSocket connections opened during/shortly after page load on
    // HTTP (non-HTTPS) pages with "connection was interrupted while the page was loading".
    // Workaround: verify the server is reachable with a lightweight fetch first,
    // then open the WS. The fetch completes through Firefox's HTTP pipeline normally,
    // and by the time it returns, the page load is truly finished.
    async function waitAndConnect() {
      if (disposed) return;
      try {
        const res = await fetch('/v1/dashboard/session', { cache: 'no-store' });
        const session = await res.clone().json().catch(() => null) as { authenticated?: boolean } | null;
        if (session?.authenticated === false) {
          const recovered = await onDashboardAuthExpired?.();
          if (!recovered) return;
        }
      } catch { /* server down — connectWs will handle retry */ }
      if (!disposed) connectWs();
    }
    waitAndConnect();

    reconnectWsRef.current = () => {
      clearReconnectTimer();
      if (activeSocket) { activeSocket.onclose = null; activeSocket.close(); activeSocket = null; }
      wsRef.current = null;
      void waitAndConnect();
    };

    return () => {
      disposed = true;
      clearReconnectTimer();
      clearConnectTimeout();
      const socket = activeSocket;
      activeSocket = null;
      if (socket) {
        socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      }
      if (wsRef.current === socket) wsRef.current = null;
      const w = window as Window & { __shizuhaWs?: WebSocket | null };
      if (w.__shizuhaWs === socket) w.__shizuhaWs = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardAuthState, onDashboardAuthExpired]);

  // ── Connect Bridge — direct WebSocket to the configured backend ──
  //
  // Always activate when dashboard auth is OK. The bridge resolves its target
  // URL from `/v1/backend` (server-side single source of truth) — local
  // daemon mini-Connect by default, remote platform when linked.
  //
  // The legacy `/ws/chat` daemon WS keeps running in parallel for
  // daemon-internal events (RPC, agent state, event-log streaming). When the
  // bridge is *connected*, `handleWsMessage` filters out `user_message` and
  // `complete` events sourced from `/ws/chat` to prevent double-rendering —
  // those come authoritatively from the bridge. If the bridge disconnects,
  // the filter relaxes so `/ws/chat` chat events take over as a safety net.
  useEffect(() => {
    if (dashboardAuthState !== 'authenticated') return;
    if (typeof window === 'undefined') return;

    let disposed = false;
    // Bridge is the authoritative chat source from the moment the dashboard
    // mounts, not only while its WS is open. Two reasons:
    //
    //   (1) Initial load race: /ws/chat's event_replay can land before the
    //       bridge's JWT+conversations handshake completes. If the filter
    //       is connection-gated, those events would leak agent session
    //       text into chat.
    //   (2) Bridge disconnects (network flap, daemon restart) still leave
    //       /ws/chat alive. Its session events must never become bubbles
    //       during those windows either.
    //
    // History continuity used to be the reason for the connection gating
    // ("fall back to /ws/chat replay when bridge is down"). With first-load
    // REST sync (`bridge.syncConversationHistory`) and WS `missed_message`
    // replay on reconnect, we no longer need that fallback — the bridge
    // owns chat end-to-end. See MESSAGING_PROTOCOL.md § Resilience Contract.
    bridgeActiveRef.current = true;
    const bridge = new ConnectBridge({
      onEvent: (event) => {
        if (disposed) return;
        handleWsMessage({ ...event, _source: 'connect-bridge' });
      },
      onConnectionChange: (connected) => {
        if (disposed) return;
        if (connected) setWsConnected(true);
      },
    });
    connectBridgeRef.current = bridge;
    bridge.start();

    return () => {
      disposed = true;
      bridgeActiveRef.current = false;
      connectBridgeRef.current = null;
      bridge.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardAuthState]);

  // ── First-load REST history sync (Kotlin-style) ──
  //
  // Per MESSAGING_PROTOCOL.md § Resilience Contract (7): on first-ever open
  // of a conversation, do a ONE-SHOT REST fetch of the latest N messages and
  // feed each through the same upsert path as `missed_message`. This fills
  // the gap where the WS's `missed_message` replay window is empty because
  // the user has already read everything from another device (so
  // `last_read_at` is current and the server has nothing to push).
  //
  // Idempotency: downstream dedup (client_message_id + server id + pending
  // role+content match) handles overlap with live WS deliveries that race
  // the REST response. `syncedHistoryRef` guards against re-fetching on the
  // same agent within one session (e.g. agent toggle back-and-forth, or
  // `wsConnected` bouncing during a network flap).
  useEffect(() => {
    if (!agentId) return;
    if (!wsConnected) return; // bridge not ready yet
    if (syncedHistoryRef.current.has(agentId)) return;

    const bridge = connectBridgeRef.current;
    if (!bridge) return;

    // Skip if we already have this agent's messages cached — an in-memory
    // cache means we've either hydrated once or streamed live into this
    // agent. Either way, REST sync would be redundant.
    const cached = agentMessageCacheRef.current.get(agentId) ?? [];
    if (cached.length > 0) {
      syncedHistoryRef.current.add(agentId);
      return;
    }

    syncedHistoryRef.current.add(agentId);
    bridge.syncConversationHistory(agentId).catch(() => {
      // Allow retry on next wsConnected toggle.
      syncedHistoryRef.current.delete(agentId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, wsConnected]);

  // ── Read receipts ──
  //
  // Per MESSAGING_PROTOCOL.md § Resilience Contract (8): emit `message_read`
  // WS events when a message becomes visible to the user. The server updates
  // `ConversationParticipant.last_read_at`, which shrinks the next
  // reconnect's `missed_message` replay window. Without this, every
  // reconnect replays the same 30-minute window forever.
  //
  // Visibility heuristic: tab must be focused AND the agent's conversation
  // must be currently selected. (A full implementation with IntersectionObserver
  // per-bubble would be ideal, but agent-level is where the server cares —
  // `last_read_at` is conversation-scoped, not message-scoped.)
  const sendReadReceiptForNewest = useCallback(() => {
    const aid = agentIdRef.current;
    if (!aid) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const bridge = connectBridgeRef.current;
    if (!bridge) return;

    // Find the newest message whose id is a server UUID (not a client-only
    // optimistic id). Optimistic ids would cause the server to reject the
    // receipt since that id doesn't exist server-side yet.
    let newest: ChatMessage | null = null;
    for (let i = messagesRef.current.length - 1; i >= 0; i--) {
      const m = messagesRef.current[i]!;
      if (m.pending) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(m.id)) continue;
      newest = m;
      break;
    }
    if (!newest) return;

    const last = lastReadReceiptRef.current.get(aid);
    if (last === newest.id) return;
    if (bridge.sendReadReceipt(aid, newest.id)) {
      lastReadReceiptRef.current.set(aid, newest.id);
    }
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // ── IndexedDB persistence ──
  //
  // Save the current agent's messages to IndexedDB on change (debounced).
  // Restored on next page load in the agent-switch effect above. Per
  // MESSAGING_PROTOCOL.md § Client-Side Cache: cache is NEVER source of
  // truth — Connect wins on conflict. The cache is solely a UX
  // optimisation for instant render on refresh.
  useEffect(() => {
    if (!agentId) return;
    if (messages.length === 0) return;
    const handle = window.setTimeout(() => {
      saveCachedMessages(agentId, messages).catch(() => { /* non-fatal */ });
    }, 600);
    return () => window.clearTimeout(handle);
  }, [agentId, messages]);

  useEffect(() => { sendReadReceiptForNewest(); }, [agentId, messages, sendReadReceiptForNewest]);

  // Fire on tab re-focus so a stale tab catches up when the user returns.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => { if (document.visibilityState === 'visible') sendReadReceiptForNewest(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [sendReadReceiptForNewest]);

  // Send sync when agentId changes or WS reconnects.
  // Use the session cursor when available so same-page WS reconnects resume
  // from the live high-water mark. On cold load / refresh there is no
  // in-memory session cursor, so getSessionCursor() falls back to the
  // committed boundary cursor from localStorage.
  //
  // Pre-sync validation: if the committed cursor is very high but we have no
  // session cursor (= fresh page load after daemon restart), proactively clear
  // stale localStorage to prevent flashing old messages before cursor_reset arrives.
  useEffect(() => {
    const ws = wsRef.current;
    if (!agentId || !ws || ws.readyState !== WebSocket.OPEN) return;
    const cached = loadPersistedMessages(agentId);
    const msgCursor = lastServerMessageId(cached);
    const eventCursor = getSessionCursor(agentId);
    const syncMsg: Record<string, unknown> = { type: 'sync', agent_id: agentId, cursor: eventCursor };
    if (msgCursor) syncMsg.last_message_id = msgCursor;
    // Gate real-time events until event_replay arrives.
    // Without this, live events arriving between sync and replay advance the
    // session cursor, causing the replay dedup filter to skip legitimate events.
    pendingReplayRef.current = true;
    queuedEventsRef.current = [];
    ws.send(JSON.stringify(syncMsg));
  }, [agentId, wsConnected]);

  function shouldSuppressClearedChatEvent(
    msg: Record<string, unknown>,
    type: string,
    currentAgentId: string | null,
    seq?: number,
  ): boolean {
    if (!currentAgentId || !isChatEventType(type)) return false;

    const state = clearedChatRef.current.get(currentAgentId);
    if (!state) return false;

    if (seq && seq <= state.clearedSeq) return true;

    if (!state.suppressStreamingTurn) return false;

    const data = msg.data as Record<string, unknown> | undefined;
    const requestId = (msg.request_id ?? data?.request_id ?? msg.message_id ?? data?.message_id) as string | undefined;
    const suppressByRequest = type === 'user_message' && !!state.suppressedRequestId && requestId === state.suppressedRequestId;
    const suppressAssistantTail = state.suppressStreamingTurn && isAssistantStreamEventType(type);
    const shouldSuppress = suppressByRequest || suppressAssistantTail;

    if (shouldSuppress && isBoundaryEvent(type)) {
      state.suppressStreamingTurn = false;
      state.suppressedTurnId = null;
      state.suppressedRequestId = null;
    }

    return shouldSuppress;
  }

  function handleWsMessage(msg: Record<string, unknown>) {
    // Chat tab = pure Connect DMs (mirrors the Kotlin app and shizuha.com/c).
    // The agent's LLM-turn output — thoughts, tool calls, reasoning, per-token
    // streaming — is private. It belongs in the Activity tab, never in chat.
    //
    // When the Connect bridge is active (always, post-Phase E), the chat tab
    // receives exactly four event types, from either source:
    //   - user_message   (hritik types → local optimistic + Connect echo)
    //   - complete       (agent's message_user DM arrives via the bridge)
    //   - proactive_message (cron/heartbeat DMs agents send into chat)
    //   - error          (API errors surfaced to the user)
    // Everything else is dropped here — including bridge-sourced agent_stream
    // events (tool_start, content, reasoning), which the mini-Connect proxy
    // re-emits for backward compat but which the chat tab must never render.
    if (bridgeActiveRef.current) {
      const t = msg.type as string;
      const fromBridge = msg._source === 'connect-bridge';

      // Bubble-rendering events must come from the Connect bridge. /ws/chat
      // also emits these — its `complete` event carries the agent's private
      // session-final text (e.g. an internal response that was never routed
      // through message_user), and its session-end stats event has no
      // content at all. Neither belongs in the chat panel, which mirrors
      // what was actually sent as a DM. Activity tab renders daemon-internal
      // session data separately via /v1/agents/:id/activity (REST).
      const BRIDGE_ONLY = new Set(['user_message', 'complete', 'proactive_message']);
      if (BRIDGE_ONLY.has(t) && !fromBridge) return;

      const CHAT_ALLOWED = new Set([
        'user_message', 'complete', 'proactive_message', 'error',
        // Control events that useChat needs for non-render bookkeeping:
        'transport_status', 'agent_status', 'agent_updated', 'agents_snapshot',
        'ping', 'pong', 'rpc_response', 'event_replay', 'cursor_reset',
        'auth_required', 'auth_device_code', 'auth_polling', 'auth_complete',
        'auth_error', 'auth_token_input', 'model_fallback', 'sync_ack', 'sync_done',
        'status_update', 'system_message',
      ]);
      if (!CHAT_ALLOWED.has(t)) return;
    }

    // Gate real-time chat events while waiting for event_replay.
    // The replay handler will process these queued events AFTER the replay
    // completes, preventing the session cursor from racing ahead.
    if (pendingReplayRef.current && !isReplayingRef.current) {
      const t = msg.type as string;
      // Let control messages (event_replay, cursor_reset, ping, pong, transport_status,
      // agents_snapshot, agent_updated, rpc_response, sync_*) through — only queue
      // chat-stream events that would advance the session cursor.
      if (isChatEventType(t) && t !== 'event_replay' && t !== 'cursor_reset') {
        queuedEventsRef.current.push(msg);
        return;
      }
    }

    // Unwrap gateway envelope: the gateway wraps agent events as
    //   { type: 'stream_event', event: { type: 'content', data: {...} } }
    //   { type: 'execution_complete', result: {...} }
    //   { type: 'execution_error', error: '...' }
    // Normalize to flat { type, data } so the rest of the handler works uniformly.
    if (msg.type === 'stream_event' && msg.event) {
      const inner = msg.event as Record<string, unknown>;
      msg = {
        ...msg,
        type: inner.type as string,
        data: inner.data ?? msg.data,
      };
    } else if (msg.type === 'execution_complete') {
      msg = { ...msg, type: 'complete', data: { result: msg.result } };
    } else if (msg.type === 'execution_error') {
      msg = { ...msg, type: 'error', data: { message: msg.error } };
    }

    const type = msg.type as string;

    // Filter by agent_id: ignore events for other agents to prevent cross-contamination.
    // Global control events (transport_status, ping, pong) don't have agent_id and should
    // always be processed.
    // IMPORTANT: this must happen BEFORE cursor tracking to prevent saving another
    // agent's event seq under the current agent's cursor key.
    const msgAgentId = msg.agent_id as string | undefined;
    const currentAgentId = agentIdRef.current;
    if (msgAgentId && currentAgentId && msgAgentId !== currentAgentId) {
      return; // Event belongs to a different agent — skip
    }

    // Kafka-style dedup: every durable event carries a monotonically increasing
    // _seq from the server's append-only event log.
    //
    // During REPLAY: skip seq check — the server already filtered by committed
    // cursor, and replay resets streaming state to rebuild from scratch.
    //
    // During REAL-TIME: check session cursor (in-memory) to skip events we've
    // already processed (prevents duplicates on WS reconnect without page refresh).
    //
    // Committed cursor (localStorage) only advances on boundary events
    // (complete/error) so page refresh replays full content from last boundary.
    const seq = msg._seq as number | undefined;
    if (seq && currentAgentId && !isReplayingRef.current) {
      const session = getSessionCursor(currentAgentId);
      if (seq <= session) return; // Already processed in this session — skip
      advanceSessionCursor(currentAgentId, seq);
      // Persist only on boundary events (like Kafka committing offsets)
      const isBoundary = isBoundaryEvent(type);
      if (isBoundary) commitCursor(currentAgentId, seq);
    }

    // A local clear should hide only pre-clear history and the remainder of any
    // assistant turn that was already in flight. Do not suppress genuinely new
    // post-clear messages from other devices or proactive sources.
    if (shouldSuppressClearedChatEvent(msg, type, currentAgentId, seq)) {
      return;
    }

    switch (type) {
      case 'transport_status':
        setWsConnected(msg.connected as boolean);
        break;

      case 'agent_status':
        break;

      case 'ping':
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'pong' }));
        }
        break;

      case 'message_ack':
      case 'relay_ack':
        // Our message was accepted
        break;

      case 'session_start': {
        const data = msg.data as Record<string, unknown> | undefined;
        const runtimeSessionId = (data?.session_id ?? data?.sessionId ?? msg.session_id) as string | undefined;
        if (runtimeSessionId) setSessionId(runtimeSessionId);
        currentAssistantMessageIdRef.current = resolveAssistantTurnId(msg);
        currentAssistantCreatedAtRef.current = eventTimestampToIso(msg) ?? new Date().toISOString();
        currentAssistantSeqRef.current = seq || undefined;
        break;
      }

      case 'content_reset':
        // B3/L958: also reset streaming indicator so the UI does not stay in a
        // perpetual-streaming state between a failed attempt and the retry's first
        // content event. The retry will re-set streamingRef=true when its first
        // content delta arrives (content handler L984).
        accumulatedRef.current = '';
        toolCallsRef.current = [];
        reasoningRef.current = [];
        toolsRanRef.current = false;
        streamingRef.current = false;
        setIsStreaming(false);
        setStreamingContent('');
        setActiveTools([]);
        setReasoningSummaries([]);
        break;

      case 'content': {
        const data = msg.data as Record<string, unknown> | undefined;
        if (data?.reset === true) {
          accumulatedRef.current = '';
          toolCallsRef.current = [];
          reasoningRef.current = [];
          toolsRanRef.current = false;
          setStreamingContent('');
          setActiveTools([]);
          setReasoningSummaries([]);
          break;
        }
        const delta = (data?.delta ?? data?.content ?? msg.content) as string;
        if (delta) {
          const assistantTurnId = resolveAssistantTurnId(msg);
          if (assistantTurnId && !currentAssistantMessageIdRef.current) {
            currentAssistantMessageIdRef.current = assistantTurnId;
          }
          if (!currentAssistantCreatedAtRef.current) {
            currentAssistantCreatedAtRef.current = eventTimestampToIso(msg) ?? new Date().toISOString();
          }
          // Enter streaming state if not already — this handles content from
          // other devices/clients (test scripts, Kotlin app, webhooks).
          // Without this, cross-device responses accumulate but never render.
          if (!streamingRef.current) {
            streamingRef.current = true;
            setIsStreaming(true);
            accumulatedRef.current = '';
            toolCallsRef.current = [];
            reasoningRef.current = [];
            toolsRanRef.current = false;
          }
          if (toolsRanRef.current && accumulatedRef.current) {
            accumulatedRef.current += '\n\n';
          }
          toolsRanRef.current = false;
          accumulatedRef.current += delta;
          setStreamingContent(accumulatedRef.current);
        }
        break;
      }

      case 'thinking':
      case 'reasoning': {
        const data = msg.data as Record<string, unknown> | undefined;
        const summaries = Array.isArray(data?.summaries)
          ? (data!.summaries as string[]).filter(Boolean).slice(-8)
          : typeof data?.text === 'string' ? [data.text as string] : [];
        if (summaries.length > 0) {
          reasoningRef.current = mergeReasoning(reasoningRef.current, summaries);
          setReasoningSummaries([...reasoningRef.current]);
        }
        break;
      }

      case 'tool_start': {
        const data = msg.data as Record<string, unknown> | undefined;
        const toolName = (data?.tool ?? data?.name) as string;
        if (toolName) {
          toolsRanRef.current = true;
          setActiveTools((prev) => [...prev, toolName]);
        }
        break;
      }

      case 'tool_complete': {
        const data = msg.data as Record<string, unknown> | undefined;
        const completedTool = (data?.tool ?? data?.name) as string;
        if (completedTool) {
          setActiveTools((prev) => prev.filter((t) => t !== completedTool));
          toolCallsRef.current.push({
            tool: completedTool,
            durationMs: data?.duration_ms as number,
            isError: data?.is_error as boolean,
          });
        }
        break;
      }

      case 'complete': {
        const data = msg.data as Record<string, unknown> | undefined;
        const result = data?.result as Record<string, unknown> | undefined;
        const totalIn = (result?.input_tokens as number) || 0;
        const totalOut = (result?.output_tokens as number) || 0;
        setTotalInputTokens((prev) => prev + totalIn);
        setTotalOutputTokens((prev) => prev + totalOut);
        setTurnCount((prev) => prev + ((result?.total_turns as number) || 1));

        // Final-message content. After Session 79 (stream-event auto-relay
        // removal), agents deliver replies as a single `new_message` →
        // forwarded by the daemon as one `complete` event with the full
        // body in `data.content` (no preceding `content` deltas). Without
        // this fallback, finalizeAssistantMessage would read an empty
        // accumulatedRef and produce an empty bubble that never renders.
        const completeContent =
          (data?.content as string | undefined)
          ?? (result?.content as string | undefined)
          ?? undefined;
        if (completeContent && !accumulatedRef.current) {
          accumulatedRef.current = completeContent;
          // Make sure streamingRef is true so finalizeAssistantMessage runs.
          // (Set by sendMessage on local sends, but not for cross-device.)
          if (!streamingRef.current) streamingRef.current = true;
        }

        // Finalize assistant message
        finalizeAssistantMessage(undefined, {
          assistantId: resolveAssistantTurnId(msg),
          createdAt: eventTimestampToIso(msg),
        });
        currentUserRequestIdRef.current = null;
        break;
      }

      case 'error': {
        const data = msg.data as Record<string, unknown> | undefined;
        const errorMsg = (data?.message ?? msg.error ?? 'Unknown error') as string;
        setError(errorMsg);
        finalizeAssistantMessage(errorMsg, {
          assistantId: resolveAssistantTurnId(msg),
          createdAt: eventTimestampToIso(msg),
        });
        currentUserRequestIdRef.current = null;
        break;
      }

      case 'user_message': {
        // User message echoed back from server. This is either:
        //   (a) the echo of our OWN local send (same request_id) — replace the
        //       pending optimistic entry with the server's id/createdAt/seqNum
        //       so ordering uses the server clock, not ours.
        //   (b) a message typed on ANOTHER device for the same user — insert fresh.
        //   (c) replay from event log on reconnect — insert or update.
        // See MESSAGING_PROTOCOL.md § Message Ordering.
        const data = msg.data as Record<string, unknown> | undefined;
        const content = (msg.content ?? data?.content) as string;
        const clientMessageId = (data?.client_message_id ?? msg.client_message_id) as string | undefined;
        const serverMessageId = (data?.message_id ?? msg.message_id) as string | undefined;
        // `requestId` is kept as the primary id only when we don't have a
        // proper server message_id (legacy path). When both exist, prefer the
        // server id for identity and carry the CMID separately for dedup.
        const requestId = (msg.request_id ?? data?.request_id ?? serverMessageId ?? clientMessageId) as string | undefined;
        if (content) {
          const source = (msg.source ?? data?.source) as string | undefined;
          const userMsg: ChatMessage = {
            id: serverMessageId ?? requestId ?? `user-remote-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            clientMessageId: clientMessageId ?? requestId,
            role: 'user',
            content,
            createdAt: eventTimestampToIso(msg) ?? new Date().toISOString(),
            seqNum: seq || undefined,
            source,
            pending: false,
          };
          // Fallback dedup for replay: skip identical user content within the
          // same replay batch when there's no request_id to match against.
          if (!requestId && isReplayingRef.current) {
            setMessages((prev) => {
              if (prev.some((m) => m.role === 'user' && m.content === content)) return prev;
              return insertOrdered(prev, userMsg, { isReplay: true, isServerEcho: true });
            });
          } else {
            setMessages((prev) => insertOrdered(prev, userMsg, { isReplay: isReplayingRef.current, isServerEcho: true }));
          }
        }
        break;
      }

      case 'proactive_message': {
        // Proactive messages (cron, heartbeat, inter-agent) are COMPLETE messages,
        // not streaming content. Add directly to message list — don't use the
        // streaming buffer (which would leave isStreaming=true with blinking cursor).
        const data = msg.data as Record<string, unknown> | undefined;
        const content = (msg.content ?? data?.content) as string;
        if (content) {
          // If we were streaming from a prior user message, finalize that first
          if (streamingRef.current && accumulatedRef.current) {
            finalizeAssistantMessage();
          }

          // Add proactive message as a complete message (not streaming)
          const proactiveId = (data?.message_id ?? msg.message_id ?? msg.execution_id) as string | undefined;
          const proactiveMsg: ChatMessage = {
            id: proactiveId ?? `proactive-${Date.now()}`,
            role: 'assistant',
            content,
            status: 'complete',
            createdAt: eventTimestampToIso(msg) ?? new Date().toISOString(),
            seqNum: seq || undefined,
          };
          setMessages((prev) => upsertAssistantMessage(prev, proactiveMsg, isReplayingRef.current));
        }
        break;
      }

      case 'status_update':
      case 'system_message': {
        const data = msg.data as Record<string, unknown> | undefined;
        const statusMsg = (data?.message ?? '') as string;
        if (statusMsg) {
          const sysMsg: ChatMessage = {
            id: `sys-${Date.now()}`,
            role: 'system',
            content: statusMsg,
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => insertOrdered(prev, sysMsg));
        }
        break;
      }

      case 'auth_required': {
        const data = msg.data as Record<string, unknown> | undefined;
        // End any pending stream — this is an auth-triggered system flow
        if (streamingRef.current) {
          streamingRef.current = false;
          setIsStreaming(false);
          setStreamingContent('');
          setActiveTools([]);
          setReasoningSummaries([]);
        }
        const authMsg: ChatMessage = {
          id: `auth-${Date.now()}`,
          role: 'system',
          content: (data?.message as string) ?? 'Authentication required',
          createdAt: new Date().toISOString(),
          authData: {
            provider: (data?.provider as string) ?? 'codex',
            stage: 'required',
          },
        };
        setMessages((prev) => insertOrdered(prev, authMsg));
        break;
      }

      case 'auth_device_code': {
        const data = msg.data as Record<string, unknown> | undefined;
        const authMsg: ChatMessage = {
          id: `auth-code-${Date.now()}`,
          role: 'system',
          content: (data?.message as string) ?? 'Enter the code below',
          createdAt: new Date().toISOString(),
          authData: {
            provider: (data?.provider as string) ?? 'codex',
            stage: 'device_code',
            userCode: data?.userCode as string,
            verificationUrl: data?.verificationUrl as string,
          },
        };
        setMessages((prev) => insertOrdered(prev, authMsg));
        break;
      }

      case 'auth_token_input': {
        const data = msg.data as Record<string, unknown> | undefined;
        if (streamingRef.current) {
          streamingRef.current = false;
          setIsStreaming(false);
          setStreamingContent('');
          setActiveTools([]);
          setReasoningSummaries([]);
        }
        const authMsg: ChatMessage = {
          id: `auth-token-${Date.now()}`,
          role: 'system',
          content: (data?.message as string) ?? 'Token required',
          createdAt: new Date().toISOString(),
          authData: {
            provider: (data?.provider as string) ?? 'claude',
            stage: 'token_input' as any,
            instructions: data?.instructions as string,
            placeholder: data?.placeholder as string,
            tokenLabel: data?.tokenLabel as string,
            envVar: data?.envVar as string,
            agentId: (msg.agent_id as string) ?? undefined,
          },
        };
        setMessages((prev) => insertOrdered(prev, authMsg));
        break;
      }

      case 'auth_polling': {
        // Update the last auth message to show polling state
        // (Don't add a new message each poll — just update existing)
        break;
      }

      case 'auth_complete': {
        const data = msg.data as Record<string, unknown> | undefined;
        const authMsg: ChatMessage = {
          id: `auth-done-${Date.now()}`,
          role: 'system',
          content: (data?.message as string) ?? 'Authentication complete',
          createdAt: new Date().toISOString(),
          authData: {
            provider: (data?.provider as string) ?? 'codex',
            stage: 'complete',
            email: data?.email as string,
          },
        };
        setMessages((prev) => insertOrdered(prev, authMsg));
        break;
      }

      case 'auth_error': {
        const data = msg.data as Record<string, unknown> | undefined;
        const authMsg: ChatMessage = {
          id: `auth-err-${Date.now()}`,
          role: 'system',
          content: (data?.message as string) ?? 'Authentication failed',
          status: 'failed',
          createdAt: new Date().toISOString(),
          authData: {
            provider: (data?.provider as string) ?? 'codex',
            stage: 'error',
          },
        };
        setMessages((prev) => insertOrdered(prev, authMsg));
        break;
      }

      case 'sync_history': {
        // Delta sync response — merge server messages into local state.
        // Messages arrive sorted oldest→newest. Deduplicate by ID AND by
        // content+role (server messages have UUIDs that won't match
        // client-generated IDs like "user-123" or "assistant-456").
        const history = msg.messages as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(history) && history.length > 0) {
          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const newMsgs: ChatMessage[] = [];
            for (const h of history) {
              const id = h.id as string;
              if (existingIds.has(id)) continue;
              const content = (h.content as string) ?? '';
              const role = h.role as 'user' | 'assistant';
              newMsgs.push({
                id,
                role,
                content,
                status: 'complete',
                createdAt: (h.created_at as string) ?? new Date().toISOString(),
              });
            }
            if (newMsgs.length === 0) return prev;
            // Use insertOrdered per message so ordering follows the
            // (seqNum, createdAt, id) contract, consistent with every other
            // insertion path. See MESSAGING_PROTOCOL.md § Message Ordering.
            let merged = prev;
            for (const m of newMsgs) {
              merged = insertOrdered(merged, m, { isReplay: true });
            }
            return merged;
          });
        }
        break;
      }

      case 'cursor_reset': {
        // Server's event log was reset (reinstall, DB deletion, etc.).
        // Our cursor is ahead of the server's max seq — force-reset to 0.
        // NOTE: We must write directly to localStorage and the session map
        // because commitCursor/advanceSessionCursor only go forward (seq > current).
        const resetAgentId = (msg.agent_id as string) ?? agentIdRef.current;
        if (resetAgentId) {
          sessionCursor.delete(resetAgentId);
          try {
            localStorage.setItem(`${CURSOR_PREFIX}${resetAgentId}`, '0');
          } catch { /* ignore */ }
          // Clear cached messages — the subsequent full event_replay will
          // rebuild from scratch. Without this, replay appends on top of
          // stale cached messages, creating duplicates that accumulate
          // across page refreshes.
          clearPersistedMessages(resetAgentId);
          if (resetAgentId === agentIdRef.current) {
            setMessages([]);
          }
          console.log(`[Chat:WS] cursor_reset — force-reset cursor + clear cache for ${resetAgentId.slice(0,8)}`);
        }
        break;
      }

      case 'event_replay': {
        // Dedup identical replays by actual seq range instead of event count.
        // Content and coalescing can vary while the count stays constant.
        const replayKey = buildReplayBatchKey(msg);
        if (replayKey === lastReplayKeyRef.current) {
          // Deduped replay — still release the gate so queued events are processed.
          pendingReplayRef.current = false;
          const dedupeQueued = queuedEventsRef.current;
          queuedEventsRef.current = [];
          for (const qEvt of dedupeQueued) handleWsMessage(qEvt);
          break;
        }
        lastReplayKeyRef.current = replayKey;
        // Cursor-based replay from the server's event log.
        // The server filtered by our committed cursor (last boundary), so this
        // may include events we've already seen in real-time (between last
        // boundary and the WS drop). We process ALL events unconditionally
        // (isReplayingRef=true skips session cursor check) and rebuild
        // streaming state from scratch.
        const events = msg.events as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(events) && events.length > 0) {
          const filteredEvents: Array<Record<string, unknown>> = [];
          let highestSuppressedBoundarySeq = 0;
          for (const evt of events) {
            const evtType = unwrapEventType(evt);
            const evtSeq = (evt._seq as number | undefined);
            if (shouldSuppressClearedChatEvent(evt, evtType, currentAgentId, evtSeq)) {
              if (evtSeq && isBoundaryEvent(evtType) && evtSeq > highestSuppressedBoundarySeq) {
                highestSuppressedBoundarySeq = evtSeq;
              }
              continue;
            }
            filteredEvents.push(evt);
          }

          // Reset streaming state — replay rebuilds content from scratch.
          // Without this, a WS reconnect mid-stream would double content
          // (accumulatedRef already has partial content from real-time events).
          if (streamingRef.current) {
            streamingRef.current = false;
            setIsStreaming(false);
          }
          accumulatedRef.current = '';
          currentAssistantMessageIdRef.current = null;
          currentAssistantCreatedAtRef.current = null;
          toolCallsRef.current = [];
          reasoningRef.current = [];
          toolsRanRef.current = false;

          // Replay is a bounded delta stream from the daemon event log, not an
          // authoritative full snapshot. Overlap with already-seen session seqs
          // is expected on reconnect because the committed cursor intentionally
          // lags the in-memory session cursor. Never clear local state here:
          // just re-process replay events idempotently and let seq/message-id
          // dedup handle duplicates.

          // Remove interrupted assistant messages — replay will reconstruct them.
          const hasContentEvents = filteredEvents.some((e) => {
            const t = unwrapEventType(e);
            return t === 'content' || t === 'proactive_message';
          });
          if (hasContentEvents) {
            setMessages((prev) =>
              prev.filter((m) => !m.id.startsWith('assistant-interrupted-')),
            );
          }

          // Process replayed events. The server filters by committed cursor,
          // but the session cursor may be ahead (we saw events in real-time
          // between the last boundary and now). Skip events at or below the
          // session cursor to avoid duplicating messages already in the cache.
          // Only process events ABOVE the session cursor — these are genuinely
          // new events the client hasn't seen.
          const preReplaySessionCursor = currentAgentId
            ? getSessionCursor(currentAgentId) : 0;

          isReplayingRef.current = true;
          let highestBoundarySeq = 0;
          for (const evt of filteredEvents) {
            const evtType = unwrapEventType(evt);
            const evtSeq = (evt._seq as number) || 0;
            if (isBoundaryEvent(evtType) && evtSeq > highestBoundarySeq) {
              highestBoundarySeq = evtSeq;
            }
            // Skip events already covered by the session cursor — these are
            // already present in the cached messages loaded from localStorage.
            // Without this, switching agents and back causes old messages to
            // re-appear because isReplayingRef disables the normal seq dedup.
            if (evtSeq > 0 && evtSeq <= preReplaySessionCursor) continue;
            if (
              (evtType === 'content' || evtType === 'tool_start')
              && !streamingRef.current
              && !bridgeActiveRef.current
            ) {
              // Note: proactive_message is NOT included here — it's handled as a complete
              // message in the switch handler, not as streaming content.
              //
              // When the Connect bridge is active, content/tool_start events from
              // /ws/chat are filtered out by handleWsMessage (they're daemon-internal
              // session streams, not chat). Pre-setting streamingRef here would leave
              // a stuck streaming cursor because no content ever accumulates and no
              // /ws/chat `complete` ever finalizes it.
              setIsStreaming(true);
              accumulatedRef.current = '';
              toolCallsRef.current = [];
              reasoningRef.current = [];
              toolsRanRef.current = false;
              streamingRef.current = true;
            }
            handleWsMessage(evt);
          }
          isReplayingRef.current = false;

          // Commit the cursor if the replay contained boundary events.
          // This advances the persisted cursor so the NEXT page refresh
          // syncs from the latest boundary — not the stale one before replay.
          if (currentAgentId) {
            const highestRelevantBoundarySeq = Math.max(highestBoundarySeq, highestSuppressedBoundarySeq);
            if (highestRelevantBoundarySeq > 0) {
              commitCursor(currentAgentId, highestRelevantBoundarySeq);
            }
          }

          // Advance session cursor to cover ALL replayed events (including
          // non-boundary ones like content deltas). This prevents a WS
          // reconnect (without page refresh) from re-processing them.
          const replayCursor = msg.cursor as number | undefined;
          if (replayCursor && currentAgentId) {
            advanceSessionCursor(currentAgentId, replayCursor);
          }
        }

        // Replay received — release the gate and drain queued real-time events.
        // These events arrived between sync and replay and were held back to
        // prevent the session cursor from racing ahead of the replay dedup filter.
        pendingReplayRef.current = false;
        const queued = queuedEventsRef.current;
        queuedEventsRef.current = [];
        for (const queuedEvt of queued) {
          handleWsMessage(queuedEvt);
        }
        break;
      }

      // ── RPC response ──
      case 'rpc_response': {
        const rpcId = msg.id as string;
        const pending = rpcPendingRef.current.get(rpcId);
        if (pending) {
          rpcPendingRef.current.delete(rpcId);
          if (msg.error) {
            pending.reject(new Error((msg.error as Record<string, string>).message ?? 'RPC error'));
          } else {
            pending.resolve(msg.result);
          }
        }
        break;
      }

      // ── Agent state push from server ──
      case 'agents_snapshot':
        onAgentsSnapshotRef.current?.((msg.agents ?? []) as unknown[]);
        break;

      case 'agent_updated':
        onAgentUpdatedRef.current?.(msg.agent);
        break;

      // ── Platform sync events ──
      case 'sync_pending_update':
      case 'sync_conflicts':
      case 'sync_agent_claimed':
        onSyncEventRef.current?.(msg as { type: string; [key: string]: unknown });
        break;

      // Informational — ignore
      case 'presence':
      case 'busy':
      case 'pong':
        break;
    }
  }

  function finalizeAssistantMessage(
    errorMsg?: string,
    options?: { assistantId?: string | null; createdAt?: string | null },
  ) {
    // Allow finalization if either streaming is active OR there's accumulated
    // content (handles cross-device events where streamingRef might not be set)
    if (!streamingRef.current && !accumulatedRef.current) return;

    const content = accumulatedRef.current;
    const assistantId =
      options?.assistantId
      ?? currentAssistantMessageIdRef.current
      ?? `assistant-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content,
      reasoningSummaries: reasoningRef.current.length > 0 ? [...reasoningRef.current] : undefined,
      toolCalls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
      status: errorMsg ? 'failed' : 'complete',
      errorMessage: errorMsg,
      createdAt: currentAssistantCreatedAtRef.current ?? options?.createdAt ?? new Date().toISOString(),
      seqNum: currentAssistantSeqRef.current,
    };
    setMessages((prev) => upsertAssistantMessage(prev, assistantMsg, isReplayingRef.current));
    setIsStreaming(false);
    setStreamingContent('');
    setActiveTools([]);
    setReasoningSummaries([]);
    streamingRef.current = false;
    accumulatedRef.current = '';
    toolCallsRef.current = [];
    reasoningRef.current = [];
    toolsRanRef.current = false;
    currentAssistantMessageIdRef.current = null;
    currentAssistantCreatedAtRef.current = null;
    currentAssistantSeqRef.current = undefined;

    // Eagerly persist to localStorage — don't wait for React effect.
    // This prevents data loss if the page unloads before the next render.
    const aid = agentIdRef.current;
    if (aid && content) {
      try {
        const existing = loadPersistedMessages(aid);
        persistMessages(aid, upsertAssistantMessage(existing, assistantMsg, false));
      } catch { /* non-fatal */ }
    }
  }

  // ── Send message ──

  const sendMessage = useCallback(async (content: string, images?: ImageAttachment[]) => {
    if (!content.trim() && (!images || images.length === 0)) return;

    // Generate a stable request_id for this message. Used as the local echo ID
    // and included in the WS payload so the server's event log entry carries it.
    // On replay, the user_message handler deduplicates by checking request_id
    // against existing message IDs — prevents the local echo from being doubled.
    //
    // Must be a UUID so the daemon's Connect path can pass it through as
    // `client_message_id` (Connect enforces UUIDField + unique-per-conversation).
    // This gives us the WhatsApp/Discord pattern: one ID from client → Connect DB
    // → replay, so the sender's optimistic echo dedupes against the replayed copy.
    //
    // `crypto.randomUUID()` is only available in secure contexts (HTTPS or
    // localhost). When the dashboard is accessed over plain HTTP on a non-local
    // host (e.g. http://192.0.2.10:8016/), it's undefined — fall back
    // to a UUID v4 built from `crypto.getRandomValues`, which is available in
    // insecure contexts.
    const requestId = generateUuidV4();
    currentUserRequestIdRef.current = requestId;

    // Pending optimistic user message — gets replaced when the server echoes
    // the `user_message` event back with the real id/createdAt/seqNum.
    // See MESSAGING_PROTOCOL.md § Message Ordering.
    const userMsg: ChatMessage = {
      id: requestId,
      clientMessageId: requestId, // stable primary dedup key (see MESSAGING_PROTOCOL.md § Resilience Contract (1))
      role: 'user',
      content: content.trim(),
      images: images && images.length > 0 ? images : undefined,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((prev) => insertOrdered(prev, userMsg));

    // If the agent is mid-stream, finalize the current response so far
    // and start fresh for the next response cycle.
    if (streamingRef.current && accumulatedRef.current) {
      finalizeAssistantMessage();
    }

    // Clear error + reset streaming-related refs. DO NOT yet enter streaming
    // UI state — that only applies to the HTTP SSE fallback path below. The
    // Connect path handles replies as a single `complete` event (no per-token
    // streaming bubble, no tool-call cards in chat).
    setError(null);
    accumulatedRef.current = '';
    toolCallsRef.current = [];
    reasoningRef.current = [];
    toolsRanRef.current = false;
    currentAssistantMessageIdRef.current = null;
    currentAssistantCreatedAtRef.current = null;

    // Build prompt with images if present
    let promptPayload: unknown = content.trim();
    if (images && images.length > 0) {
      const parts: unknown[] = [];
      for (const img of images) {
        const [meta, data] = img.dataUrl.split(',');
        const mediaType = meta?.match(/:(.*?);/)?.[1] || img.mimeType;
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data },
        });
      }
      if (content.trim()) {
        parts.push({ type: 'text', text: content.trim() });
      }
      promptPayload = parts;
    }

    // ── Connect path (dashboard agent mode) ──
    // Send via the Connect bridge so the message persists in the platform's
    // DM store and shows up in every client attached to the conversation:
    // this dashboard, the Kotlin app, the web Connect UI at /c/<conv>.
    // All three surfaces stay consistent because there's only ONE source of
    // truth (Connect) — the dashboard isn't a side channel any more.
    //
    // The /ws/chat WebSocket is still open for observability (agent state,
    // streaming events → Activity tab), but it is NOT the messaging path.
    if (agentId) {
      const bridge = connectBridgeRef.current;
      const msgContent = typeof promptPayload === 'string' ? promptPayload : JSON.stringify(promptPayload);
      if (bridge && bridge.connected) {
        const sent = bridge.sendChatMessage(agentId, msgContent, requestId);
        if (!sent) {
          setError('Could not send — no conversation mapped for this agent on Connect.');
          setMessages((prev) => prev.filter((m) => m.id !== requestId));
          return;
        }
        // No streaming-state setup here: the agent replies with a single
        // `complete` event when it DMs back via message_user. The
        // optimistic user bubble we already inserted will be replaced by
        // the bridge's echo of the persisted message.
        setIsStreaming(false);
        streamingRef.current = false;
        return;
      }
      // Bridge not up — fail loud rather than leaking through /ws/chat.
      setError('Connect bridge is not connected. Refresh the page.');
      setMessages((prev) => prev.filter((m) => m.id !== requestId));
      return;
    }

    // ── HTTP SSE path (local TUI web mode only — no agent selected) ──
    // This path DOES stream the model's turn live, so we enter streaming
    // UI state here (not for the Connect path above).
    setIsStreaming(true);
    setStreamingContent('');
    setActiveTools([]);
    setReasoningSummaries([]);
    streamingRef.current = true;

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const url = `${apiBase}/v1/query/stream`;
      const body = JSON.stringify({
        prompt: promptPayload,
        model,
        permissionMode: mode,
        sessionId: sessionId ?? undefined,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeaders?.() ?? {}) },
        body,
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = '';
      let turnInputTokens = 0;
      let turnOutputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSEEvent(eventType, data);
            } catch {
              // Skip malformed JSON
            }
            eventType = '';
          }
        }
      }

      function handleSSEEvent(sseType: string, data: Record<string, unknown>) {
        switch (sseType) {
          case 'session_start':
            if (data.sessionId) setSessionId(data.sessionId as string);
            currentAssistantMessageIdRef.current = (data.messageId as string) ?? currentAssistantMessageIdRef.current;
            currentAssistantCreatedAtRef.current = typeof data.timestamp === 'number'
              ? new Date(data.timestamp).toISOString()
              : currentAssistantCreatedAtRef.current;
            break;
          case 'content': {
            const delta = (data.delta as string) || (data.text as string) || '';
            if (toolsRanRef.current && accumulatedRef.current) {
              accumulatedRef.current += '\n\n';
            }
            toolsRanRef.current = false;
            accumulatedRef.current += delta;
            setStreamingContent(accumulatedRef.current);
            break;
          }
          case 'thinking':
          case 'reasoning': {
            const summaries = Array.isArray(data.summaries)
              ? (data.summaries as string[]).filter(Boolean).slice(-8)
              : typeof data.text === 'string' ? [data.text as string] : [];
            if (summaries.length > 0) {
              reasoningRef.current = mergeReasoning(reasoningRef.current, summaries);
              setReasoningSummaries([...reasoningRef.current]);
            }
            break;
          }
          case 'tool_start': {
            toolsRanRef.current = true;
            const toolName = (data.toolName ?? data.tool ?? data.name) as string;
            if (toolName) setActiveTools((prev) => [...prev, toolName]);
            break;
          }
          case 'tool_complete': {
            const completedTool = (data.toolName ?? data.tool ?? data.name) as string;
            if (completedTool) {
              setActiveTools((prev) => prev.filter((t) => t !== completedTool));
              toolCallsRef.current.push({
                tool: completedTool,
                output: (data.result as string) ?? undefined,
                diff: (data.metadata as any)?.diff,
                durationMs: (data.durationMs ?? data.duration_ms) as number,
                isError: data.isError as boolean,
              });
            }
            break;
          }
          case 'turn_complete':
            turnInputTokens += (data.inputTokens as number) || 0;
            turnOutputTokens += (data.outputTokens as number) || 0;
            break;
          case 'model_fallback': {
            const from = data.fromModel as string;
            const to = data.toModel as string;
            accumulatedRef.current += `\n\n> **Model fallback**: ${from} failed, switching to ${to}\n\n`;
            setStreamingContent(accumulatedRef.current);
            break;
          }
          case 'error': {
            const errorMsg = (data.error as string) || 'Unknown error';
            setError(errorMsg);
            break;
          }
          case 'complete': {
            const totalIn = (data.totalInputTokens as number) || turnInputTokens;
            const totalOut = (data.totalOutputTokens as number) || turnOutputTokens;
            setTotalInputTokens((prev) => prev + totalIn);
            setTotalOutputTokens((prev) => prev + totalOut);
            setTurnCount((prev) => prev + ((data.totalTurns as number) || 1));
            break;
          }
        }
      }

      // Create final assistant message
      const assistantMsg: ChatMessage = {
        id: currentAssistantMessageIdRef.current ?? `assistant-${Date.now()}`,
        role: 'assistant',
        content: accumulatedRef.current,
        reasoningSummaries: reasoningRef.current.length > 0 ? [...reasoningRef.current] : undefined,
        toolCalls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
        status: error ? 'failed' : 'complete',
        errorMessage: error ?? undefined,
        createdAt: currentAssistantCreatedAtRef.current ?? new Date().toISOString(),
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
      };
      setMessages((prev) => insertOrdered(prev, assistantMsg));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      const errorMsg = (e as Error).message || 'Request failed';
      setError(errorMsg);
      if (accumulatedRef.current) {
        const failedMsg: ChatMessage = {
          id: `failed-${Date.now()}`,
          role: 'assistant',
          content: accumulatedRef.current,
          status: 'failed',
          errorMessage: errorMsg,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => insertOrdered(prev, failedMsg));
      }
    } finally {
      setIsStreaming(false);
      setStreamingContent('');
      setActiveTools([]);
      setReasoningSummaries([]);
      streamingRef.current = false;
      currentAssistantMessageIdRef.current = null;
      currentAssistantCreatedAtRef.current = null;
    }
  }, [apiBase, model, mode, sessionId, error, authHeaders, agentId]);

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setActiveTools([]);
    streamingRef.current = false;
  }, []);

  const clearMessages = useCallback(() => {
    const targetAgentId = agentIdRef.current;
    const latestSeq = targetAgentId ? getSessionCursor(targetAgentId) : 0;
    const suppressStreamingTurn = streamingRef.current;
    const suppressedTurnId = currentAssistantMessageIdRef.current;
    const suppressedRequestId = currentUserRequestIdRef.current;

    setMessages([]);
    setSessionId(null);
    setTotalInputTokens(0);
    setTotalOutputTokens(0);
    setTurnCount(0);
    setError(null);
    // Reset streaming state so <StreamingMessage> doesn't linger
    setIsStreaming(false);
    setStreamingContent('');
    setActiveTools([]);
    setReasoningSummaries([]);
    streamingRef.current = false;
    accumulatedRef.current = '';
    toolCallsRef.current = [];
    reasoningRef.current = [];
    toolsRanRef.current = false;
    currentAssistantMessageIdRef.current = null;
    currentAssistantCreatedAtRef.current = null;
    currentAssistantSeqRef.current = undefined;
    if (targetAgentId) {
      clearedChatRef.current.set(targetAgentId, {
        clearedSeq: latestSeq,
        suppressStreamingTurn,
        suppressedTurnId,
        suppressedRequestId,
      });
      clearPersistedMessages(targetAgentId);
      // Advance the committed cursor to the latest session cursor so
      // reconnect/refresh won't replay events from before the clear.
      // This keeps the clear browser-local while preventing backward replay.
      if (latestSeq > 0) {
        if (agentIdRef.current) commitCursor(agentIdRef.current, latestSeq);
      }
    }
    currentUserRequestIdRef.current = null;
  }, []);

  /** Clear messages for ALL agents — preserves cursors so old events aren't replayed. */
  const clearAllMessages = useCallback(() => {
    // Clear current agent's in-memory state (same as clearMessages)
    clearMessages();
    // Also wipe persisted messages for every agent
    clearAllPersistedMessages();
  }, [clearMessages]);

  const loadSessionMessages = useCallback((
    msgs: ChatMessage[],
    sid: string,
    sessionModel?: string,
  ) => {
    setMessages(msgs);
    setSessionId(sid);
    if (sessionModel) setModel(sessionModel);
    setError(null);
    let inTok = 0, outTok = 0, turns = 0;
    for (const m of msgs) {
      if (m.role === 'assistant') {
        inTok += m.inputTokens ?? 0;
        outTok += m.outputTokens ?? 0;
        turns++;
      }
    }
    setTotalInputTokens(inTok);
    setTotalOutputTokens(outTok);
    setTurnCount(turns);
  }, []);

  const restartSession = useCallback(() => {
    if (agentId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'restart_session',
        agent_id: agentId,
      }));
    }
  }, [agentId]);

  /** Send an RPC request over the WebSocket and return the result. */
  const rpc = useCallback((method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket not connected'));
    }
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      // Timeout after 30s
      const timer = setTimeout(() => {
        rpcPendingRef.current.delete(id);
        reject(new Error('RPC timeout'));
      }, 30_000);
      rpcPendingRef.current.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
    });
  }, []);

  return {
    messages,
    isStreaming,
    streamingContent,
    activeTools,
    reasoningSummaries,
    error,
    sessionId,
    model,
    mode,
    totalInputTokens,
    totalOutputTokens,
    turnCount,
    wsConnected,
    sendMessage,
    cancelStream,
    clearMessages,
    clearAllMessages,
    restartSession,
    reconnectWs: useCallback(() => reconnectWsRef.current(), []),
    rpc,
    setModel,
    setMode,
    setError,
    setSessionId,
    loadSessionMessages,
  };
}

function mergeReasoning(existing: string[], incoming: string[]): string[] {
  const result = [...existing];
  for (const item of incoming) {
    if (!item) continue;
    const lastIdx = result.length - 1;
    if (lastIdx >= 0) {
      const last = result[lastIdx]!;
      if (item.startsWith(last) || last.startsWith(item)) {
        result[lastIdx] = item.length >= last.length ? item : last;
        continue;
      }
    }
    if (!result.includes(item)) result.push(item);
  }
  return result.slice(-8);
}
