import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { AgentSession } from '../session.js';
import type { AgentEvent } from '../../events/types.js';
import type { Message } from '../../agent/types.js';
import type { PermissionMode } from '../../permissions/types.js';
import type { TranscriptEntry, ToolCallEntry, ApprovalRequest, ModelInfo } from '../state/types.js';
import { pushEdit } from '../utils/editHistory.js';
import { notifyTaskComplete } from '../utils/notify.js';
import { getVisibleToolCalls } from '../utils/toolVisibility.js';
import { shouldAnimateTUI } from '../utils/terminal.js';
import { addAnthropicToken, setOpenAIKey, setGoogleKey } from '../../config/credentials.js';
import {
  loginToShizuhaId,
  clearShizuhaAuth,
  readShizuhaAuth,
  getShizuhaAuthStatus as readShizuhaAuthStatus,
  verifyShizuhaAuthIdentity,
} from '../../config/shizuhaAuth.js';

function shouldStreamAssistantText(): boolean {
  // Match Codex/Claude-style UX: assistant text should stream in all modes.
  // Verbosity still controls truncation/visibility details (MessageBlock),
  // not whether text appears during generation.
  return true;
}

const ANIMATED_TUI = shouldAnimateTUI();
const STREAM_RENDER_INTERVAL_MS = ANIMATED_TUI ? 220 : 500;
const STALL_WARN_MS = parseInt(process.env['TUI_STALL_WARN_MS'] || '120000', 10);
const STATUS_TICK_MS = 1000;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveCompletedEntryLimit(): number {
  const override = parsePositiveInt(process.env['SHIZUHA_TUI_HISTORY_WINDOW']);
  if (override) return override;
  const rows = process.stdout.rows ?? 24;
  const multiplier = ANIMATED_TUI ? 8 : 4;
  return Math.max(40, Math.min(320, rows * multiplier));
}

function resolveResumeTailLimit(): number {
  const override = parsePositiveInt(process.env['SHIZUHA_TUI_RESUME_WINDOW']);
  if (override) return override;
  const rows = process.stdout.rows ?? 24;
  const multiplier = ANIMATED_TUI ? 12 : 6;
  return Math.max(80, Math.min(480, rows * multiplier));
}

const COMPLETED_ENTRY_LIMIT = resolveCompletedEntryLimit();
const RESUME_TAIL_ENTRY_LIMIT = resolveResumeTailLimit();

interface ResumedSessionPayload {
  id: string;
  model: string;
  messages: Message[];
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  interruptCheckpoint?: {
    createdAt: number;
    promptExcerpt: string;
    note: string;
  };
}

interface PendingSubmission {
  prompt: string;
  images?: Array<{ base64: string; mediaType: string }>;
}

function isTranscriptRole(message: Message): message is Message & { role: 'user' | 'assistant' } {
  return message.role === 'user' || message.role === 'assistant';
}

function messageToTranscriptContent(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const textParts: string[] = [];
  let toolResultCount = 0;
  let internalAssistantBlockCount = 0;

  for (const block of message.content) {
    const blockType = (block as { type?: string }).type;
    if (blockType === 'text') {
      const text = (block as { text?: string }).text;
      if (text) textParts.push(text);
      continue;
    }
    if (blockType === 'tool_result') {
      // Tool-result messages are synthetic turn plumbing (stored as user-role
      // messages for the provider protocol). Do not render them as "You".
      toolResultCount++;
      continue;
    }
    // Hide internal assistant machinery from resumed transcript view.
    if (message.role === 'assistant' && (blockType === 'reasoning' || blockType === 'tool_use')) {
      internalAssistantBlockCount++;
      continue;
    }
  }

  if (textParts.length > 0) {
    return textParts.join('\n\n');
  }
  if (internalAssistantBlockCount > 0) {
    return '';
  }
  if (toolResultCount > 0) return '';

  return '';
}

function messagesToTranscript(messages: Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let idx = 0; idx < messages.length; idx++) {
    const message = messages[idx];
    if (!message || !isTranscriptRole(message)) continue;
    const content = messageToTranscriptContent(message).trim();
    if (!content) continue;
    entries.push({
      id: `resume-${idx}-${message.timestamp ?? Date.now()}`,
      role: message.role,
      content,
      timestamp: message.timestamp ?? Date.now(),
    });
  }
  return entries;
}

function hasRenderableTranscriptContent(message: Message): boolean {
  if (typeof message.content === 'string') {
    return message.content.trim().length > 0;
  }
  if (!Array.isArray(message.content)) return false;
  for (const block of message.content) {
    const blockType = (block as { type?: string }).type;
    if (blockType === 'text') {
      const text = (block as { text?: string }).text;
      if (typeof text === 'string' && text.trim().length > 0) return true;
    }
  }
  return false;
}

function collectTranscriptTail(messages: Message[], limit: number): {
  entries: TranscriptEntry[];
  omittedCount: number;
} {
  const tailReversed: TranscriptEntry[] = [];
  let omittedCount = 0;

  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = messages[idx];
    if (!message || !isTranscriptRole(message)) continue;

    if (tailReversed.length < limit) {
      const content = messageToTranscriptContent(message).trim();
      if (!content) continue;
      tailReversed.push({
        id: `resume-${idx}-${message.timestamp ?? Date.now()}`,
        role: message.role,
        content,
        timestamp: message.timestamp ?? Date.now(),
      });
      continue;
    }

    if (hasRenderableTranscriptContent(message)) omittedCount++;
  }

  tailReversed.reverse();
  return { entries: tailReversed, omittedCount };
}

function hasToolInput(input: Record<string, unknown> | null | undefined): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && Object.keys(input).length > 0;
}

function cloneToolInput(input: Record<string, unknown>): Record<string, unknown> {
  // Tool inputs are JSON-like objects; deep-clone to avoid accidental shared mutation.
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function truncateInline(value: string, maxLen = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLen - 3))}...`;
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCommandPreview(toolName: string, input: Record<string, unknown>): string | undefined {
  const lower = toolName.toLowerCase();
  if (lower === 'bash') {
    const command = input.command;
    if (typeof command === 'string' && command.trim()) {
      return `/bin/bash -lc ${shellQuoteSingle(truncateInline(command, 260))}`;
    }
    return 'bash';
  }
  if (lower === 'web_search') {
    const query = typeof input.query === 'string' ? truncateInline(input.query, 120) : '';
    return query ? `web_search query="${query}"` : 'web_search';
  }
  if (lower.startsWith('mcp__')) {
    const [, server, tool] = toolName.split('__');
    if (server && tool) return `mcp ${server}/${tool}`;
  }
  const keys = ['file_path', 'path', 'pattern', 'query', 'url', 'glob', 'command'];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return `${toolName} ${key}=${truncateInline(value, 100)}`;
    }
  }
  return toolName;
}

function splitToolInputAndPreview(
  toolName: string,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; commandPreview?: string } {
  const normalized = cloneToolInput(input);
  let preview: string | undefined;
  const explicitPreview = normalized.command_preview;
  if (typeof explicitPreview === 'string' && explicitPreview.trim()) {
    preview = truncateInline(explicitPreview, 260);
  }
  delete normalized.command_preview;
  return {
    input: normalized,
    commandPreview: preview ?? formatCommandPreview(toolName, normalized),
  };
}

function pushRecentCompletedTools(
  tools: ToolCallEntry[],
  next: ToolCallEntry,
  limit = 2,
): ToolCallEntry[] {
  const deduped = tools.filter((t) => t.id !== next.id);
  return [...deduped, next].slice(-limit);
}

interface ShizuhaLoginResult {
  username: string;
  mcpReloaded: boolean;
  reloadError?: string;
}

interface ShizuhaLogoutResult {
  loggedOut: boolean;
  mcpReloaded: boolean;
  reloadError?: string;
}

interface ShizuhaAuthStatusResult {
  loggedIn: boolean;
  username?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}

interface ShizuhaIdentityResult {
  username?: string;
}

interface UseAgentSessionResult {
  /** True once init completes (even with warnings) */
  ready: boolean;
  /** Completed entries — rendered once via <Static>, never re-rendered */
  completedEntries: TranscriptEntry[];
  /** Older completed entries omitted from prompt view window */
  archivedEntryCount: number;
  /** Currently streaming entry (or null when idle) */
  liveEntry: TranscriptEntry | null;
  /** Derived full transcript (completedEntries + liveEntry) for pager/copy */
  transcript: TranscriptEntry[];
  /** Full transcript for pager (materialized lazily after resume) */
  getPagerTranscript: () => TranscriptEntry[];
  isProcessing: boolean;
  pendingApproval: ApprovalRequest | null;
  approvalQueueLength: number;
  error: string | null;
  /** Non-fatal init warning (e.g. provider not configured) */
  initWarning: string | null;
  model: string;
  mode: PermissionMode;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  sessionId: string | null;
  contextTokens: number;
  queuedPromptCount: number;
  queuedPrompts: string[];
  stalledMs: number;
  /** Timestamp (epoch ms) of the last agent event, or 0 if none.  StatusBar
   *  derives its own "idle Xs" / "live Xs" display from this without causing
   *  parent re-renders every second. */
  lastAgentEventAt: number;
  processingLabel: string | null;
  sessionVersion: number;
  submitPrompt: (prompt: string) => void;
  resolveApproval: (decision: 'allow' | 'deny' | 'allow_always') => void;
  setModel: (model: string) => boolean;
  setMode: (mode: PermissionMode) => void;
  clearTranscript: () => void;
  compact: (instructions?: string) => void;
  interrupt: () => void;
  listSessions: () => ReturnType<AgentSession['listSessions']>;
  resumeSession: (id: string) => Promise<{ ok: boolean; checkpointNotice?: string }>;
  newSession: () => void;
  availableModels: () => ModelInfo[];
  availableProviders: () => string[];
  renameSession: (name: string) => void;
  forkSession: () => string | null;
  listMCPTools: () => Promise<Array<{ name: string; description: string }>>;
  addTranscriptEntry: (entry: TranscriptEntry) => void;
  submitWithImage: (prompt: string, imageBase64: string, mediaType: string) => void;
  setThinkingLevel: (level: string) => void;
  setReasoningEffort: (level: string | null) => void;
  setFastMode: (enabled: boolean) => void;
  deleteSession: (id: string) => boolean;
  configureAuth: (provider: string, modelSlug: string, token: string) => void;
  codexDeviceAuthDone: (modelSlug: string) => void;
  consumeAutoShowModelPicker: () => boolean;
  loginShizuha: (username: string, password: string) => Promise<ShizuhaLoginResult>;
  logoutShizuha: () => Promise<ShizuhaLogoutResult>;
  getShizuhaAuthStatus: () => Promise<ShizuhaAuthStatusResult>;
  verifyShizuhaIdentity: () => Promise<ShizuhaIdentityResult>;
  /** Active plan file path when in plan mode */
  planFilePath: string | null;
}

export function useAgentSession(cwd: string, initialModel?: string, initialMode?: PermissionMode): UseAgentSessionResult {
  const sessionRef = useRef<AgentSession | null>(null);
  const [ready, setReady] = useState(false);
  const [completedEntries, setCompletedEntries] = useState<TranscriptEntry[]>([]);
  const [archivedEntryCount, setArchivedEntryCount] = useState(0);
  const [liveEntry, setLiveEntry] = useState<TranscriptEntry | null>(null);
  const liveEntryIdRef = useRef('');
  // Deferred finalization: stores entries waiting to be flushed to <Static>.
  // The flush happens in a useEffect so Ink gets one render with liveEntry=null
  // (clearing the dynamic area) before the completed entry appears in <Static>.
  // This prevents the last streaming frame from being "burned" into scrollback
  // as a ghost duplicate above the finalized Static entry.
  const [isProcessing, setIsProcessing] = useState(false);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [initWarning, setInitWarning] = useState<string | null>(null);
  const [model, setModelState] = useState(initialModel ?? '');
  const [mode, setModeState] = useState<PermissionMode>(initialMode ?? 'supervised');
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [turnCount, setTurnCount] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [contextTokens, setContextTokens] = useState(0);
  const [planFilePath, setPlanFilePath] = useState<string | null>(null);

  // Current streaming text accumulator
  const streamingTextRef = useRef('');
  const reasoningSummariesRef = useRef<string[]>([]);
  const lastReasoningSummaryRef = useRef('');
  const currentToolsRef = useRef<ToolCallEntry[]>([]);
  const recentCompletedToolsRef = useRef<ToolCallEntry[]>([]);
  const lastStreamingRenderAtRef = useRef(0);
  const trailingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSubmissionsRef = useRef<PendingSubmission[]>([]);
  const pendingToolInputHintsRef = useRef<Map<string, Array<Record<string, unknown>>>>(new Map());
  const resumeCheckpointNoticeRef = useRef<string | null>(null);
  const deferredResumeMessagesRef = useRef<Message[] | null>(null);
  const pagerTranscriptCacheRef = useRef<TranscriptEntry[] | null>(null);
  const lastAgentEventAtRef = useRef<number>(0);
  const autoShowModelPickerRef = useRef(false);
  const [queuedPromptCount, setQueuedPromptCount] = useState(0);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const [stalledMs, setStalledMs] = useState(0);
  const [processingLabel, setProcessingLabel] = useState<string | null>(null);
  const lastCompactionSummaryRef = useRef<string>('');
  const stallAnnouncedRef = useRef(false);

  /** Sync queue count + prompt texts from the ref into React state. */
  const syncQueueState = useCallback(() => {
    const q = pendingSubmissionsRef.current;
    setQueuedPromptCount(q.length);
    setQueuedPrompts(q.map((p) => p.prompt));
  }, []);

  const clearQueueState = useCallback(() => {
    setQueuedPromptCount(0);
    setQueuedPrompts([]);
  }, []);

  const replaceCompletedEntriesWindow = useCallback((entries: TranscriptEntry[], archivedBase = 0) => {
    const overflow = Math.max(0, entries.length - COMPLETED_ENTRY_LIMIT);
    const visible = overflow > 0 ? entries.slice(-COMPLETED_ENTRY_LIMIT) : entries;
    setCompletedEntries(visible);
    setArchivedEntryCount(Math.max(0, archivedBase + overflow));
  }, []);

  const appendCompletedEntries = useCallback((entries: TranscriptEntry[]) => {
    if (entries.length === 0) return;
    if (pagerTranscriptCacheRef.current) {
      pagerTranscriptCacheRef.current = [...pagerTranscriptCacheRef.current, ...entries];
    }
    setCompletedEntries((prev) => {
      const merged = [...prev, ...entries];
      if (merged.length <= COMPLETED_ENTRY_LIMIT) return merged;
      const overflow = merged.length - COMPLETED_ENTRY_LIMIT;
      setArchivedEntryCount((count) => count + overflow);
      return merged.slice(-COMPLETED_ENTRY_LIMIT);
    });
  }, []);

  const appendCompletedEntry = useCallback((entry: TranscriptEntry) => {
    appendCompletedEntries([entry]);
  }, [appendCompletedEntries]);

  const appendSystemEntry = useCallback((content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    pagerTranscriptCacheRef.current = null;
    setCompletedEntries((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'system' && last.content === trimmed) return prev;
      const systemEntry: TranscriptEntry = {
        id: `system-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        role: 'system',
        content: trimmed,
        timestamp: Date.now(),
      };
      const merged = [...prev, systemEntry];
      if (merged.length <= COMPLETED_ENTRY_LIMIT) return merged;
      const overflow = merged.length - COMPLETED_ENTRY_LIMIT;
      setArchivedEntryCount((count) => count + overflow);
      return merged.slice(-COMPLETED_ENTRY_LIMIT);
    });
  }, []);

  // Derived transcript for pager, /copy, getLastAssistantMessage
  const transcript = useMemo(() => {
    if (liveEntry) return [...completedEntries, liveEntry];
    return completedEntries;
  }, [completedEntries, liveEntry]);

  const getPagerTranscript = useCallback((): TranscriptEntry[] => {
    const resumedMessages = deferredResumeMessagesRef.current;
    if (!resumedMessages) {
      return liveEntry ? [...completedEntries, liveEntry] : completedEntries;
    }
    if (!pagerTranscriptCacheRef.current) {
      pagerTranscriptCacheRef.current = messagesToTranscript(resumedMessages);
    }
    if (liveEntry) {
      return [...pagerTranscriptCacheRef.current, liveEntry];
    }
    return pagerTranscriptCacheRef.current;
  }, [completedEntries, liveEntry]);


  const enqueueToolInputHint = useCallback((toolName: string, input: Record<string, unknown>) => {
    if (!hasToolInput(input)) return;
    const queue = pendingToolInputHintsRef.current.get(toolName) ?? [];
    queue.push(cloneToolInput(input));
    pendingToolInputHintsRef.current.set(toolName, queue);
  }, []);

  const dequeueToolInputHint = useCallback((toolName: string): Record<string, unknown> | null => {
    const queue = pendingToolInputHintsRef.current.get(toolName);
    if (!queue || queue.length === 0) return null;
    const next = queue.shift() ?? null;
    if (queue.length === 0) pendingToolInputHintsRef.current.delete(toolName);
    return next;
  }, []);

  const doRender = useCallback(() => {
    lastStreamingRenderAtRef.current = Date.now();
    const text = streamingTextRef.current;
    const tools = getVisibleToolCalls([...currentToolsRef.current], [...recentCompletedToolsRef.current]);
    const reasoning = reasoningSummariesRef.current.length > 0 ? [...reasoningSummariesRef.current] : undefined;
    setLiveEntry((prev) => {
      if (reasoning) reasoningSummariesRef.current = [];
      const latestReasoning = reasoning ?? prev?.reasoningSummaries;
      if (latestReasoning?.length) {
        lastReasoningSummaryRef.current = latestReasoning[latestReasoning.length - 1] ?? '';
      }
      if (prev) {
        return { ...prev, content: text, toolCalls: tools, reasoningSummaries: latestReasoning };
      }
      const id = `assistant-${Date.now()}`;
      liveEntryIdRef.current = id;
      return {
        id,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        toolCalls: tools,
        isStreaming: true,
        reasoningSummaries: latestReasoning,
      };
    });
  }, []);

  const upsertStreamingAssistant = useCallback((force = false) => {
    if (trailingTimerRef.current) {
      clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
    const now = Date.now();
    if (!force && (now - lastStreamingRenderAtRef.current) < STREAM_RENDER_INTERVAL_MS) {
      // Schedule a trailing render so the latest content isn't lost
      trailingTimerRef.current = setTimeout(doRender, STREAM_RENDER_INTERVAL_MS);
      return;
    }
    doRender();
  }, [doRender]);

  useEffect(() => {
    let destroyed = false;
    const s = new AgentSession();
    sessionRef.current = s;

    s.init(cwd, initialModel, initialMode).then(() => {
      if (destroyed) return;
      setModelState(s.model);
      setModeState(s.mode);

      // Set plan file path if starting in plan mode
      if (s.planFilePath) {
        setPlanFilePath(s.planFilePath);
      }

      // Show init warning if provider wasn't configured
      if (s.initError) {
        setInitWarning(`${s.initError}. Use /model <name> to switch to a configured model.`);
      }

      // Wire permission callback — push to queue
      s.setPermissionCallback(async (toolName, input, riskLevel) => {
        enqueueToolInputHint(toolName, input);
        return new Promise<'allow' | 'deny' | 'allow_always'>((resolve) => {
          setApprovalQueue((prev) => [...prev, { toolName, input, riskLevel, resolve }]);
        });
      });

      // Listen to agent events
      s.on('agent_event', (event: AgentEvent) => {
        lastAgentEventAtRef.current = Date.now();
        // Ref update only — no setState, so no React re-render on every chunk.
        switch (event.type) {
          case 'session_start':
            setSessionId(event.sessionId);
            if (event.planFilePath) {
              setPlanFilePath(event.planFilePath);
            }
            break;

          case 'turn_start':
            // Insert paragraph break between turns so text doesn't run together
            if (streamingTextRef.current.length > 0) {
              streamingTextRef.current += '\n';
            }
            setProcessingLabel('Thinking...');
            break;

          case 'content': {
            streamingTextRef.current += event.text;
            // Stream assistant text live in all verbosity modes.
            // Re-render cadence is still throttled to prevent terminal reflow spikes.
            if (shouldStreamAssistantText()) {
              // Throttle content re-renders so large streamed payloads (e.g. big JSON)
              // don't cause violent terminal reflow.
              upsertStreamingAssistant(false);
            }
            break;
          }

          case 'reasoning': {
            const summaries = event.summaries.filter(
              (summary) => !/compacting context|context compaction/i.test(summary),
            );
            if (summaries.length === 0) break;
            // Keep only the latest distinct summary while streaming.
            // Accumulating all summaries causes long bullet stacks and severe
            // reflow/jumpiness in tmux.
            const next = summaries[summaries.length - 1]?.trim();
            if (!next) break;
            const prevVisible = lastReasoningSummaryRef.current;
            const prevQueued = reasoningSummariesRef.current[reasoningSummariesRef.current.length - 1];
            if (next === prevVisible || next === prevQueued) break;
            reasoningSummariesRef.current = [next];
            // Show reasoning summary in the ThinkingIndicator/processingLabel
            // instead of as bullet points in the dynamic area (which ghost into scrollback).
            setProcessingLabel(next);
            upsertStreamingAssistant(false);
            break;
          }

          case 'tool_start': {
            setProcessingLabel(`Running ${event.toolName}...`);
            const rawInput = hasToolInput(event.input)
              ? event.input
              : (dequeueToolInputHint(event.toolName) ?? {});
            const { input: resolvedInput, commandPreview } = splitToolInputAndPreview(event.toolName, rawInput);
            const entry: ToolCallEntry = {
              id: event.toolCallId,
              name: event.toolName,
              input: resolvedInput,
              commandPreview,
              result: event.toolName === 'web_search' ? 'Searching...' : undefined,
              status: 'running',
            };
            const existingIdx = currentToolsRef.current.findIndex((t) => t.id === event.toolCallId);
            if (existingIdx >= 0) {
              const existing = currentToolsRef.current[existingIdx]!;
              const next = [...currentToolsRef.current];
              next[existingIdx] = { ...existing, ...entry };
              currentToolsRef.current = next;
            } else {
              currentToolsRef.current = [...currentToolsRef.current, entry];
            }
            upsertStreamingAssistant(true);
            break;
          }

          case 'tool_progress': {
            // Update running tool with incremental output
            currentToolsRef.current = currentToolsRef.current.map((t) =>
              t.id === event.toolCallId
                ? { ...t, result: event.output }
                : t,
            );
            // Throttle progress re-renders — these fire rapidly for streaming tools
            upsertStreamingAssistant(false);
            break;
          }

          case 'tool_complete': {
            // Track edits for undo
            if (event.metadata?.oldContent != null && event.metadata?.newContent != null && event.metadata?.filePath) {
              pushEdit({
                filePath: event.metadata.filePath as string,
                oldContent: event.metadata.oldContent as string,
                newContent: event.metadata.newContent as string,
                timestamp: event.timestamp,
              });
            }
            const completed = currentToolsRef.current.find((t) => t.id === event.toolCallId);
            const rawCompletedInput = hasToolInput(completed?.input)
              ? completed.input
              : (dequeueToolInputHint(event.toolName) ?? {});
            const { input: completedInput, commandPreview } = splitToolInputAndPreview(event.toolName, rawCompletedInput);
            const completedEntry: ToolCallEntry = {
              id: event.toolCallId,
              name: event.toolName,
              input: completedInput,
              commandPreview: completed?.commandPreview ?? commandPreview,
              result: event.result,
              isError: event.isError,
              durationMs: event.durationMs,
              status: 'complete',
              metadata: event.metadata,
            };
            recentCompletedToolsRef.current = pushRecentCompletedTools(
              recentCompletedToolsRef.current,
              completedEntry,
            );
            currentToolsRef.current = currentToolsRef.current.filter((t) => t.id !== event.toolCallId);
            if (currentToolsRef.current.length > 0) {
              setProcessingLabel(`Running ${currentToolsRef.current[0]!.name}...`);
            } else {
              setProcessingLabel('Thinking...');
            }
            upsertStreamingAssistant(true);
            break;
          }

          case 'turn_complete':
            setTotalInputTokens((prev) => prev + event.inputTokens);
            setTotalOutputTokens((prev) => prev + event.outputTokens);
            setTurnCount((prev) => prev + 1);
            setContextTokens(s.estimatedContextTokens);
            break;

          case 'input_injected': {
            // Mid-turn injection: finalize the current liveEntry (partial response),
            // then add the injected user message — in the correct transcript order.
            const injectedText = streamingTextRef.current;
            const injectedTools = getVisibleToolCalls(
              [...currentToolsRef.current],
              [...recentCompletedToolsRef.current],
            );
            setLiveEntry((prev) => {
              const entries: TranscriptEntry[] = [];
              // 1. Finalize partial assistant response (if any content exists)
              if (prev || injectedText || injectedTools.length > 0) {
                entries.push({
                  id: prev?.id ?? `assistant-${Date.now()}`,
                  role: 'assistant',
                  content: injectedText || '(interrupted)',
                  timestamp: prev?.timestamp ?? Date.now(),
                  toolCalls: injectedTools,
                  isStreaming: false,
                });
              }
              // 2. Add user message entry for the injected prompt
              entries.push({
                id: `user-${Date.now()}`,
                role: 'user',
                content: event.prompt,
                timestamp: Date.now(),
              });
              if (entries.length > 0) {
                appendCompletedEntries(entries);
              }
              return null;
            });
            // Reset streaming state for next turn
            liveEntryIdRef.current = '';
            if (trailingTimerRef.current) {
              clearTimeout(trailingTimerRef.current);
              trailingTimerRef.current = null;
            }
            streamingTextRef.current = '';
            reasoningSummariesRef.current = [];
            lastReasoningSummaryRef.current = '';
            currentToolsRef.current = [];
            recentCompletedToolsRef.current = [];
            lastCompactionSummaryRef.current = '';
            pendingToolInputHintsRef.current.clear();
            lastStreamingRenderAtRef.current = 0;
            // Update queue display — one item was consumed
            if (pendingSubmissionsRef.current.length > 0) {
              pendingSubmissionsRef.current.shift();
            }
            syncQueueState();
            // Reset timers for fresh turn
            setStalledMs(0);
            lastAgentEventAtRef.current = Date.now();
            lastAgentEventAtRef.current = Date.now();
            setProcessingLabel('Thinking...');
            stallAnnouncedRef.current = false;
            break;
          }

          case 'error':
            setError(event.error);
            if (/retrying in|retrying turn|compacted history and retrying/i.test(event.error)) {
              setProcessingLabel('Retrying...');
              appendSystemEntry(`↻ ${event.error}`);
            } else {
              appendSystemEntry(`✗ ${event.error}`);
              // Auto-open model picker on first-turn auth/rate-limit failures
              if (/Use \/model/i.test(event.error)) {
                autoShowModelPickerRef.current = true;
              }
            }
            break;

          case 'complete': {
            // Finalize streaming entry: move liveEntry → completedEntries
            lastStreamingRenderAtRef.current = 0;
            recentCompletedToolsRef.current = recentCompletedToolsRef.current.map((tool) => {
              if (hasToolInput(tool.input)) return tool;
              const recovered = s.findToolInput(tool.id);
              if (!recovered) return tool;
              const { input, commandPreview } = splitToolInputAndPreview(tool.name, recovered);
              return { ...tool, input, commandPreview: tool.commandPreview ?? commandPreview };
            });
            const visibleTools = getVisibleToolCalls(
              [...currentToolsRef.current],
              [...recentCompletedToolsRef.current],
            );
            // Build the finalized entry from liveEntry or create a new one.
            // Trim whitespace-only text (e.g. lone '\n' from turn_start paragraph breaks)
            // to avoid creating empty entries that render bare "◆ Shizuha" headers.
            const finalText = streamingTextRef.current.trim() || undefined;
            // Finalize: move liveEntry → completedEntries (rendered via <Static>).
            // The liveEntry's MessageBlock uses hideHeader so any ghost frame in
            // scrollback won't duplicate the "◆ Shizuha" header from the Static entry.
            setLiveEntry((prev) => {
                if (prev || finalText || visibleTools.length > 0) {
                  const finalized: TranscriptEntry = {
                    id: prev?.id ?? `assistant-${Date.now()}`,
                    role: 'assistant',
                    content: finalText ?? '',
                    timestamp: prev?.timestamp ?? Date.now(),
                    toolCalls: visibleTools,
                    isStreaming: false,
                  };
                  appendCompletedEntry(finalized);
                }
                return null;
              });
            liveEntryIdRef.current = '';
            if (trailingTimerRef.current) {
              clearTimeout(trailingTimerRef.current);
              trailingTimerRef.current = null;
            }
            streamingTextRef.current = '';
            reasoningSummariesRef.current = [];
            lastReasoningSummaryRef.current = '';
            currentToolsRef.current = [];
            recentCompletedToolsRef.current = [];
            lastCompactionSummaryRef.current = '';
            pendingToolInputHintsRef.current.clear();
            const next = pendingSubmissionsRef.current.shift();
            syncQueueState();
            if (next) {
              setError(null);
              setIsProcessing(true);
              setProcessingLabel('Thinking...');
              setStalledMs(0);
              lastAgentEventAtRef.current = Date.now();
              lastAgentEventAtRef.current = Date.now();
              stallAnnouncedRef.current = false;
              void s.submitPrompt(next.prompt, next.images);
            } else {
              setIsProcessing(false);
              setStalledMs(0);
              setProcessingLabel(null);
              stallAnnouncedRef.current = false;
              // Desktop notification
              notifyTaskComplete();
            }
            break;
          }
        }
      });

      s.on('session_resumed', (session: ResumedSessionPayload) => {
        setSessionId(session.id);
        setModelState(session.model);
        setTotalInputTokens(session.totalInputTokens);
        setTotalOutputTokens(session.totalOutputTokens);
        setTurnCount(session.turnCount);
        setContextTokens(s.estimatedContextTokens);
        deferredResumeMessagesRef.current = session.messages;
        pagerTranscriptCacheRef.current = null;
        const { entries, omittedCount } = collectTranscriptTail(session.messages, RESUME_TAIL_ENTRY_LIMIT);
        replaceCompletedEntriesWindow(entries, omittedCount);
        setLiveEntry(null);
        liveEntryIdRef.current = '';
        if (trailingTimerRef.current) {
          clearTimeout(trailingTimerRef.current);
          trailingTimerRef.current = null;
        }
        streamingTextRef.current = '';
        reasoningSummariesRef.current = [];
        lastReasoningSummaryRef.current = '';
        currentToolsRef.current = [];
        recentCompletedToolsRef.current = [];
        lastCompactionSummaryRef.current = '';
        pendingToolInputHintsRef.current.clear();
        lastStreamingRenderAtRef.current = 0;
        pendingSubmissionsRef.current = [];
        clearQueueState();
        setIsProcessing(false);
        setStalledMs(0);
        lastAgentEventAtRef.current = Date.now();
        setProcessingLabel(null);
        stallAnnouncedRef.current = false;
        setError(null);
        const cp = session.interruptCheckpoint;
        resumeCheckpointNoticeRef.current = cp
          ? `${cp.note} Last prompt: "${cp.promptExcerpt}"`
          : null;
      });

      s.on('session_new', () => {
        deferredResumeMessagesRef.current = null;
        pagerTranscriptCacheRef.current = null;
        replaceCompletedEntriesWindow([], 0);
        setLiveEntry(null);
        liveEntryIdRef.current = '';
        streamingTextRef.current = '';
        reasoningSummariesRef.current = [];
        lastReasoningSummaryRef.current = '';
        setStalledMs(0);
        lastAgentEventAtRef.current = 0;
        setProcessingLabel(null);
        pendingToolInputHintsRef.current.clear();
        recentCompletedToolsRef.current = [];
        lastCompactionSummaryRef.current = '';
        stallAnnouncedRef.current = false;
        setSessionVersion((v) => v + 1);
      });

      setReady(true);
    }).catch((err) => {
      if (destroyed) return;
      setError((err as Error).message);
    });

    return () => {
      destroyed = true;
      s.destroy();
      sessionRef.current = null;
    };
  }, [cwd, initialModel, initialMode]);

  // Stall detection watchdog — only sets state when stall status changes,
  // so it doesn't trigger re-renders every tick.  Agent-event age display
  // is now handled internally by StatusBar using lastAgentEventAtRef.
  const prevStalledRef = useRef(0);
  useEffect(() => {
    if (!ready) return;
    if (isProcessing && lastAgentEventAtRef.current === 0) {
      lastAgentEventAtRef.current = Date.now();
    }
    const tick = () => {
      if (isProcessing) {
        const idleMs = Date.now() - lastAgentEventAtRef.current;
        const nextStall = idleMs >= STALL_WARN_MS ? idleMs : 0;
        const changed = prevStalledRef.current === 0
          ? nextStall > 0
          : nextStall === 0 || Math.abs(nextStall - prevStalledRef.current) >= STATUS_TICK_MS;
        if (changed) {
          prevStalledRef.current = nextStall;
          setStalledMs(nextStall);
          if (nextStall > 0 && !stallAnnouncedRef.current) {
            appendSystemEntry(`\u26A0 Stalled ${Math.floor(nextStall / 1000)}s \xB7 no agent events`);
            stallAnnouncedRef.current = true;
          } else if (nextStall === 0) {
            stallAnnouncedRef.current = false;
          }
        }
      } else if (prevStalledRef.current !== 0) {
        prevStalledRef.current = 0;
        setStalledMs(0);
        stallAnnouncedRef.current = false;
      }
    };
    tick();
    const timer = setInterval(tick, STATUS_TICK_MS);
    return () => clearInterval(timer);
  }, [appendSystemEntry, ready, isProcessing]);

  const submitPrompt = useCallback((prompt: string) => {
    const s = sessionRef.current;
    if (!s || !ready) return;

    if (isProcessing) {
      // Instant injection: queue on the session (aborts current LLM stream).
      // DON'T add user entry to completedEntries yet — the input_injected event
      // will add it in the correct order (after the partial assistant response).
      pendingSubmissionsRef.current.push({ prompt });
      syncQueueState();
      s.queueInput(prompt);
      return;
    }

    // Fresh submit — add user entry immediately
    appendCompletedEntry({
      id: `user-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    setIsProcessing(true);
    setError(null);
    setStalledMs(0);
    lastAgentEventAtRef.current = Date.now();
    setProcessingLabel('Thinking...');
    lastAgentEventAtRef.current = Date.now();
    stallAnnouncedRef.current = false;
    if (trailingTimerRef.current) {
      clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
    streamingTextRef.current = '';
    reasoningSummariesRef.current = [];
    lastReasoningSummaryRef.current = '';
    currentToolsRef.current = [];
    recentCompletedToolsRef.current = [];
    lastCompactionSummaryRef.current = '';
    pendingToolInputHintsRef.current.clear();
    lastStreamingRenderAtRef.current = 0;

    s.submitPrompt(prompt);
  }, [ready, isProcessing, appendCompletedEntry]);

  // Derive pendingApproval from queue head for backward compatibility
  const pendingApproval = approvalQueue.length > 0 ? approvalQueue[0]! : null;
  const approvalQueueLength = approvalQueue.length;

  const resolveApproval = useCallback((decision: 'allow' | 'deny' | 'allow_always') => {
    setApprovalQueue((prev) => {
      if (prev.length === 0) return prev;
      const request = prev[0]!;

      // Handle exit_plan_mode approval: switch to supervised mode
      if (request.toolName === 'exit_plan_mode' && (decision === 'allow' || decision === 'allow_always')) {
        sessionRef.current?.setMode('supervised');
        setModeState('supervised');
      }

      request.resolve(decision);
      return prev.slice(1);
    });
  }, []);

  const setModel = useCallback((m: string): boolean => {
    const s = sessionRef.current;
    if (!s) return false;
    const result = s.setModel(m);
    if (result === 'error') return false;
    // Use session's model (may differ from input if 'auto' was pinned to a concrete model)
    setModelState(s.model);
    // Clear init warning if model switch succeeded
    if (!s.initError) {
      setInitWarning(null);
    }
    // If provider changed, clear TUI transcript (session was reset)
    if (result === 'cleared') {
      deferredResumeMessagesRef.current = null;
      pagerTranscriptCacheRef.current = null;
      replaceCompletedEntriesWindow([], 0);
      setLiveEntry(null);
      liveEntryIdRef.current = '';
      streamingTextRef.current = '';
      reasoningSummariesRef.current = [];
      lastReasoningSummaryRef.current = '';
      setTotalInputTokens(0);
      setTotalOutputTokens(0);
      setTurnCount(0);
      setSessionId(null);
      setContextTokens(0);
      setSessionVersion((v) => v + 1);
    }
    return true;
  }, []);

  const setMode = useCallback((m: PermissionMode) => {
    sessionRef.current?.setMode(m);
    setModeState(m);
    // Update planFilePath from session (generated on entering plan mode)
    if (m === 'plan') {
      setPlanFilePath(sessionRef.current?.planFilePath ?? null);
    }
  }, []);

  const clearTranscript = useCallback(() => {
    deferredResumeMessagesRef.current = null;
    pagerTranscriptCacheRef.current = null;
    replaceCompletedEntriesWindow([], 0);
    setLiveEntry(null);
    liveEntryIdRef.current = '';
    sessionRef.current?.newSession();
    pendingSubmissionsRef.current = [];
    pendingToolInputHintsRef.current.clear();
    clearQueueState();
    setSessionId(null);
    setTotalInputTokens(0);
    setTotalOutputTokens(0);
    setTurnCount(0);
    setError(null);
    setStalledMs(0);
    lastAgentEventAtRef.current = 0;
    setProcessingLabel(null);
    streamingTextRef.current = '';
    reasoningSummariesRef.current = [];
    lastReasoningSummaryRef.current = '';
    recentCompletedToolsRef.current = [];
    lastCompactionSummaryRef.current = '';
    stallAnnouncedRef.current = false;
  }, [replaceCompletedEntriesWindow]);

  const compact = useCallback((instructions?: string) => {
    sessionRef.current?.compact(instructions);
  }, []);

  const interrupt = useCallback(() => {
    sessionRef.current?.interrupt();
    if (trailingTimerRef.current) {
      clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
    // Finalize any in-progress liveEntry → completedEntries
    setLiveEntry((prev) => {
      if (prev) {
        const finalEntry: TranscriptEntry = {
          ...prev,
          content: streamingTextRef.current || prev.content,
          isStreaming: false,
        };
        appendCompletedEntry(finalEntry);
      }
      return null;
    });
    liveEntryIdRef.current = '';
    streamingTextRef.current = '';
    reasoningSummariesRef.current = [];
    lastReasoningSummaryRef.current = '';
    currentToolsRef.current = [];
    recentCompletedToolsRef.current = [];
    lastCompactionSummaryRef.current = '';
    pendingSubmissionsRef.current = [];
    pendingToolInputHintsRef.current.clear();
    clearQueueState();
    setIsProcessing(false);
    setStalledMs(0);
    lastAgentEventAtRef.current = 0;
    setProcessingLabel(null);
    stallAnnouncedRef.current = false;
  }, [appendCompletedEntry]);

  const listSessions = useCallback(() => {
    return sessionRef.current?.listSessions(100) ?? [];
  }, []);

  const resumeSession = useCallback(async (id: string) => {
    const s = sessionRef.current;
    if (!s) return { ok: false };
    const ok = await s.resumeSession(id);
    if (ok) {
      pendingSubmissionsRef.current = [];
      pendingToolInputHintsRef.current.clear();
      streamingTextRef.current = '';
      reasoningSummariesRef.current = [];
      lastReasoningSummaryRef.current = '';
      recentCompletedToolsRef.current = [];
      lastCompactionSummaryRef.current = '';
      clearQueueState();
      setSessionId(id);
      setTotalInputTokens(s.totalInputTokens);
      setTotalOutputTokens(s.totalOutputTokens);
      setTurnCount(s.turnCount);
      setModelState(s.model);
      setStalledMs(0);
      lastAgentEventAtRef.current = Date.now();
      setProcessingLabel(null);
      stallAnnouncedRef.current = false;
    }
    const checkpointNotice = resumeCheckpointNoticeRef.current ?? undefined;
    resumeCheckpointNoticeRef.current = null;
    return { ok, checkpointNotice };
  }, []);

  const newSession = useCallback(() => {
    sessionRef.current?.newSession();
    deferredResumeMessagesRef.current = null;
    pagerTranscriptCacheRef.current = null;
    pendingSubmissionsRef.current = [];
    pendingToolInputHintsRef.current.clear();
    streamingTextRef.current = '';
    reasoningSummariesRef.current = [];
    lastReasoningSummaryRef.current = '';
    recentCompletedToolsRef.current = [];
    lastCompactionSummaryRef.current = '';
    clearQueueState();
    replaceCompletedEntriesWindow([], 0);
    setLiveEntry(null);
    liveEntryIdRef.current = '';
    setSessionId(null);
    setTotalInputTokens(0);
    setTotalOutputTokens(0);
    setTurnCount(0);
    setStalledMs(0);
    lastAgentEventAtRef.current = 0;
    setProcessingLabel(null);
    stallAnnouncedRef.current = false;
  }, [replaceCompletedEntriesWindow]);

  const availableModels = useCallback(() => {
    return sessionRef.current?.availableModels() ?? [];
  }, []);

  const availableProvidersList = useCallback(() => {
    return sessionRef.current?.availableProviders() ?? [];
  }, []);

  const addTranscriptEntry = useCallback((entry: TranscriptEntry) => {
    appendCompletedEntry(entry);
  }, [appendCompletedEntry]);

  const submitWithImage = useCallback((prompt: string, imageBase64: string, mediaType: string) => {
    const s = sessionRef.current;
    if (!s || !ready) return;

    const images = [{ base64: imageBase64, mediaType }];
    if (isProcessing) {
      // Instant injection with image
      pendingSubmissionsRef.current.push({ prompt, images });
      syncQueueState();
      s.queueInput(prompt, images);
      return;
    }

    // Fresh submit — add user entry immediately
    appendCompletedEntry({
      id: `user-${Date.now()}`,
      role: 'user',
      content: `${prompt} [image attached]`,
      timestamp: Date.now(),
    });

    setIsProcessing(true);
    setError(null);
    setStalledMs(0);
    lastAgentEventAtRef.current = Date.now();
    setProcessingLabel('Thinking...');
    lastAgentEventAtRef.current = Date.now();
    stallAnnouncedRef.current = false;
    if (trailingTimerRef.current) {
      clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
    streamingTextRef.current = '';
    reasoningSummariesRef.current = [];
    lastReasoningSummaryRef.current = '';
    currentToolsRef.current = [];
    recentCompletedToolsRef.current = [];
    lastCompactionSummaryRef.current = '';
    pendingToolInputHintsRef.current.clear();

    s.submitPrompt(prompt, images);
  }, [ready, isProcessing, appendCompletedEntry]);

  const renameSessionFn = useCallback((name: string) => {
    sessionRef.current?.renameSession(name);
  }, []);

  const forkSessionFn = useCallback((): string | null => {
    return sessionRef.current?.forkSession() ?? null;
  }, []);

  const listMCPToolsFn = useCallback(async (): Promise<Array<{ name: string; description: string }>> => {
    return sessionRef.current?.listMCPTools() ?? [];
  }, []);

  const setThinkingLevelFn = useCallback((level: string) => {
    sessionRef.current?.setThinkingLevel(level);
  }, []);

  const setReasoningEffortFn = useCallback((level: string | null) => {
    sessionRef.current?.setReasoningEffort(level);
  }, []);

  const setFastModeFn = useCallback((enabled: boolean) => {
    sessionRef.current?.setFastMode(enabled);
  }, []);

  const deleteSessionFn = useCallback((id: string): boolean => {
    return sessionRef.current?.deleteSession(id) ?? false;
  }, []);

  const configureAuth = useCallback((provider: string, modelSlug: string, token: string) => {
    // 1. Save to credential store
    if (provider === 'anthropic') addAnthropicToken(token);
    else if (provider === 'openai') setOpenAIKey(token);
    else if (provider === 'google') setGoogleKey(token);

    // 2. Reinitialize providers so the new credential is picked up
    const s = sessionRef.current;
    if (s) {
      s.reinitializeProviders();
      s.setModel(modelSlug);
    }
    setModelState(modelSlug);
    setInitWarning(null);
  }, []);

  /** Check if model picker should auto-open (e.g. after first-turn 429). Resets on read. */
  const consumeAutoShowModelPicker = useCallback((): boolean => {
    if (autoShowModelPickerRef.current) {
      autoShowModelPickerRef.current = false;
      return true;
    }
    return false;
  }, []);

  /** Called after codex device auth completes — reinit providers and switch model */
  const codexDeviceAuthDone = useCallback((modelSlug: string) => {
    const s = sessionRef.current;
    if (s) {
      s.reinitializeProviders();
      s.setModel(modelSlug);
    }
    setModelState(modelSlug);
    setInitWarning(null);
  }, []);

  const loginShizuha = useCallback(async (username: string, password: string): Promise<ShizuhaLoginResult> => {
    const loginResult = await loginToShizuhaId(username, password);
    const s = sessionRef.current;
    if (!s) {
      return { username: loginResult.username, mcpReloaded: false, reloadError: 'Session is not ready yet' };
    }

    try {
      await s.reconnectMCPWithLatestConfig();
      return { username: loginResult.username, mcpReloaded: true };
    } catch (err) {
      return {
        username: loginResult.username,
        mcpReloaded: false,
        reloadError: (err as Error).message,
      };
    }
  }, []);

  const logoutShizuha = useCallback(async (): Promise<ShizuhaLogoutResult> => {
    const hadAuth = Boolean(readShizuhaAuth());
    clearShizuhaAuth();

    const s = sessionRef.current;
    if (!s) {
      return { loggedOut: hadAuth, mcpReloaded: false, reloadError: 'Session is not ready yet' };
    }

    try {
      await s.reconnectMCPWithLatestConfig();
      return { loggedOut: hadAuth, mcpReloaded: true };
    } catch (err) {
      return {
        loggedOut: hadAuth,
        mcpReloaded: false,
        reloadError: (err as Error).message,
      };
    }
  }, []);

  const getShizuhaAuthStatus = useCallback(async (): Promise<ShizuhaAuthStatusResult> => {
    return readShizuhaAuthStatus();
  }, []);

  const verifyShizuhaIdentity = useCallback(async (): Promise<ShizuhaIdentityResult> => {
    return verifyShizuhaAuthIdentity();
  }, []);

  return {
    ready, completedEntries, archivedEntryCount, liveEntry, transcript, getPagerTranscript, isProcessing,
    pendingApproval, approvalQueueLength, error, initWarning,
    model, mode, totalInputTokens, totalOutputTokens, turnCount, sessionId, sessionVersion,
    contextTokens, queuedPromptCount, queuedPrompts, stalledMs,
    lastAgentEventAt: lastAgentEventAtRef.current, processingLabel,
    submitPrompt, resolveApproval, setModel, setMode, clearTranscript,
    compact, interrupt, listSessions, resumeSession, newSession,
    availableModels, availableProviders: availableProvidersList,
    renameSession: renameSessionFn, forkSession: forkSessionFn, listMCPTools: listMCPToolsFn,
    addTranscriptEntry, submitWithImage,
    setThinkingLevel: setThinkingLevelFn, setReasoningEffort: setReasoningEffortFn, setFastMode: setFastModeFn,
    deleteSession: deleteSessionFn, configureAuth, codexDeviceAuthDone, consumeAutoShowModelPicker,
    loginShizuha, logoutShizuha, getShizuhaAuthStatus, verifyShizuhaIdentity,
    planFilePath,
  };
}
