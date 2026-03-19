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
  resolveAssistantTurnId,
  upsertAssistantMessage,
} from '../lib/chat-sync';

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

function loadPersistedMessages(agentId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${agentId}`);
    if (!raw) return [];
    const msgs = JSON.parse(raw) as ChatMessage[];
    // Fix stale streaming messages from previous disconnects
    return msgs.map((m) =>
      m.status === 'streaming' ? { ...m, status: 'failed' as const, errorMessage: m.errorMessage || 'Connection lost' } : m,
    );
  } catch {
    return [];
  }
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

function persistMessages(agentId: string, messages: ChatMessage[]) {
  try {
    // Keep only the last N messages to avoid bloating localStorage
    const toSave = messages.slice(-MAX_PERSISTED_MESSAGES);
    localStorage.setItem(`${STORAGE_PREFIX}${agentId}`, JSON.stringify(toSave));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
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

/** Load the committed (persisted) cursor — last boundary event seq. */
function loadCommittedCursor(agentId: string): number {
  try {
    const raw = localStorage.getItem(`${CURSOR_PREFIX}${agentId}`);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Persist cursor to localStorage — only call on boundary events. */
function commitCursor(agentId: string, seq: number) {
  try {
    const current = loadCommittedCursor(agentId);
    if (seq > current) {
      localStorage.setItem(`${CURSOR_PREFIX}${agentId}`, String(seq));
    }
  } catch { /* ignore */ }
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
  const { apiBase = '', defaultModel = 'claude-sonnet-4-20250514', authHeaders, agentId, authState: dashboardAuthState, onAgentsSnapshot, onAgentUpdated } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const abortRef = useRef<AbortController | null>(null);
  const accumulatedRef = useRef('');
  const toolCallsRef = useRef<ToolCall[]>([]);
  const reasoningRef = useRef<string[]>([]);
  /** True while processing an event_replay batch — disables session cursor dedup. */
  const isReplayingRef = useRef(false);
  /** Dedup key for event_replay — prevents processing identical replays (e.g., 4x from duplicate syncs). Reset on WS disconnect so reconnect replays are processed. */
  const lastReplayKeyRef = useRef('');

  // ── RPC over WebSocket ──
  const rpcPendingRef = useRef<Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>>(new Map());
  const onAgentsSnapshotRef = useRef(onAgentsSnapshot);
  const onAgentUpdatedRef = useRef(onAgentUpdated);
  onAgentsSnapshotRef.current = onAgentsSnapshot;
  onAgentUpdatedRef.current = onAgentUpdated;
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

    // Restore persisted messages for the new agent
    if (newAid && newAid !== prevAid) {
      const cached = loadPersistedMessages(newAid);
      if (cached.length > 0) {
        setMessages(cached);
        // Recalculate token counts from cached messages
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
      }
      setError(null);
      setSessionId(null);
      currentAssistantMessageIdRef.current = null;
      currentAssistantCreatedAtRef.current = null;

      // Sync is handled by the [agentId, wsConnected] effect below.
      // Do NOT send sync here — both effects share agentId in their deps,
      // so both fire on agent switch. Sending sync in both causes two
      // identical replays → duplicate messages.
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
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWs(); }, delay);
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
        try { handleWsMessage(JSON.parse(event.data)); } catch { /* ignore */ }
      };

      ws.onclose = () => {
        clearConnectTimeout();
        if (disposed || activeSocket !== ws) return;
        activeSocket = null; wsRef.current = null;
        setWsConnected(false);
        const w = window as Window & { __shizuhaWs?: WebSocket | null };
        if (w.__shizuhaWs === ws) w.__shizuhaWs = null;
        lastReplayKeyRef.current = '';
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
        await fetch('/v1/dashboard/session', { cache: 'no-store' });
      } catch { /* server down — connectWs will handle retry */ }
      if (!disposed) connectWs();
    }
    waitAndConnect();

    reconnectWsRef.current = () => {
      clearReconnectTimer();
      if (activeSocket) { activeSocket.onclose = null; activeSocket.close(); activeSocket = null; }
      wsRef.current = null;
      connectWs();
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
  }, [dashboardAuthState]);

  // Send sync when agentId changes or WS reconnects.
  // Use the session cursor when available so same-page WS reconnects resume
  // from the live high-water mark. On cold load / refresh there is no
  // in-memory session cursor, so getSessionCursor() falls back to the
  // committed boundary cursor from localStorage.
  useEffect(() => {
    const ws = wsRef.current;
    if (!agentId || !ws || ws.readyState !== WebSocket.OPEN) return;
    const cached = loadPersistedMessages(agentId);
    const msgCursor = lastServerMessageId(cached);
    const eventCursor = getSessionCursor(agentId);
    const syncMsg: Record<string, unknown> = { type: 'sync', agent_id: agentId, cursor: eventCursor };
    if (msgCursor) syncMsg.last_message_id = msgCursor;
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

      case 'content': {
        const data = msg.data as Record<string, unknown> | undefined;
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
        // User message from event log replay or cross-device sync.
        // Dedup: request_id matches against the local echo's message ID.
        // During replay, seq-based dedup is disabled (isReplaying), so
        // request_id is the primary dedup mechanism for user messages.
        const data = msg.data as Record<string, unknown> | undefined;
        const content = (msg.content ?? data?.content) as string;
        const requestId = (msg.request_id ?? data?.request_id ?? msg.message_id ?? data?.message_id) as string | undefined;
        if (content) {
          setMessages((prev) => {
            if (requestId && prev.some((m) => m.id === requestId)) return prev;
            // Fallback dedup: skip if an identical user message already exists.
            // Covers pre-request_id events during replay (no unique ID to match).
            if (!requestId && prev.some((m) => m.role === 'user' && m.content === content)) return prev;
            const userMsg: ChatMessage = {
              id: requestId ?? `user-remote-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role: 'user',
              content,
              createdAt: eventTimestampToIso(msg) ?? new Date().toISOString(),
              seqNum: seq || undefined,
            };
            return [...prev, userMsg];
          });
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
          setMessages((prev) => [...prev, sysMsg]);
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
        setMessages((prev) => [...prev, authMsg]);
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
        setMessages((prev) => [...prev, authMsg]);
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
        setMessages((prev) => [...prev, authMsg]);
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
        setMessages((prev) => [...prev, authMsg]);
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
        setMessages((prev) => [...prev, authMsg]);
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
            const merged = [...prev, ...newMsgs];
            // Sort by createdAt so messages from other devices appear in order
            merged.sort((a, b) =>
              new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
            );
            return merged;
          });
        }
        break;
      }

      case 'cursor_reset': {
        // Server's event log was reset (reinstall, DB deletion, etc.).
        // Our cursor is ahead of the server's max seq — reset to 0 so we
        // don't skip new events.
        const resetAgentId = (msg.agent_id as string) ?? agentIdRef.current;
        if (resetAgentId) {
          sessionCursor.delete(resetAgentId);
          commitCursor(resetAgentId, 0);
        }
        break;
      }

      case 'event_replay': {
        // Dedup identical replays by actual seq range instead of event count.
        // Content and coalescing can vary while the count stays constant.
        const replayKey = buildReplayBatchKey(msg);
        if (replayKey === lastReplayKeyRef.current) break;
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

          // Process all replayed events. isReplayingRef disables session cursor
          // dedup so every event is processed (the server already filtered by
          // committed cursor). Multi-turn replays (user→content→complete→user→...)
          // are handled by the per-event streaming state entry below.
          //
          // Track the highest boundary seq so we can commit the cursor after.
          isReplayingRef.current = true;
          let highestBoundarySeq = 0;
          for (const evt of filteredEvents) {
            const evtType = unwrapEventType(evt);
            const evtSeq = (evt._seq as number) || 0;
            if (isBoundaryEvent(evtType) && evtSeq > highestBoundarySeq) {
              highestBoundarySeq = evtSeq;
            }
            if ((evtType === 'content' || evtType === 'tool_start') && !streamingRef.current) {
              // Note: proactive_message is NOT included here — it's handled as a complete
              // message in the switch handler, not as streaming content.
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
    const requestId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentUserRequestIdRef.current = requestId;

    const userMsg: ChatMessage = {
      id: requestId,
      role: 'user',
      content: content.trim(),
      images: images && images.length > 0 ? images : undefined,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // If the agent is mid-stream, finalize the current response so far
    // and start fresh for the next response cycle.
    if (streamingRef.current && accumulatedRef.current) {
      finalizeAssistantMessage();
    }

    // Enter streaming state for the upcoming response
    setIsStreaming(true);
    setStreamingContent('');
    setActiveTools([]);
    setReasoningSummaries([]);
    setError(null);
    accumulatedRef.current = '';
    toolCallsRef.current = [];
    reasoningRef.current = [];
    toolsRanRef.current = false;
    streamingRef.current = true;
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

    // ── WebSocket path (dashboard agent mode) ──
    if (agentId) {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setError('Not connected to server. Please wait for the connection to establish.');
        setMessages((prev) => prev.filter((m) => m.id !== requestId));
        return;
      }
      wsRef.current.send(JSON.stringify({
        type: 'message',
        agent_id: agentId,
        content: typeof promptPayload === 'string' ? promptPayload : JSON.stringify(promptPayload),
        request_id: requestId,
      }));
      return;
    }

    // ── HTTP SSE path (local TUI web mode only — no agent selected) ──
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
      setMessages((prev) => [...prev, assistantMsg]);
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
        setMessages((prev) => [...prev, failedMsg]);
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
        commitCursor(agentIdRef.current, latestSeq);
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
