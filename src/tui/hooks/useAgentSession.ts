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
import { addAnthropicToken, setOpenAIKey, setGoogleKey, setCortexApiKey } from '../../config/credentials.js';
import { formatTokenProgressStatus } from '../../utils/perf-metrics.js';
import { DEFAULT_TUI_STALL_ESCALATION_MS, longWaitDisplayMs } from '../utils/stallDisplay.js';
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

function shouldRenderReasoningTextAsAssistantContent(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.startsWith('cortex/') || normalized.includes('glm');
}

function appendStreamingDelta(current: string, delta: string): string {
  if (!delta) return current;
  if (!current) return delta;
  if (delta === current || current.endsWith(delta)) return current;
  if (delta.startsWith(current)) return delta;

  const maxOverlap = Math.min(current.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (current.endsWith(delta.slice(0, overlap))) {
      return current + delta.slice(overlap);
    }
  }
  return current + delta;
}

const ANIMATED_TUI = shouldAnimateTUI();
const STREAM_RENDER_INTERVAL_MS = ANIMATED_TUI ? 220 : 500;
const STALL_WARN_MS = parseInt(
  process.env['TUI_STALL_WARN_MS'] || String(DEFAULT_TUI_STALL_ESCALATION_MS),
  10,
);
/** Provider no-header wait threshold for the prominent recovery UI (Esc / /model). */
const PROVIDER_SOFT_STALL_MS = parseInt(
  process.env['TUI_PROVIDER_SOFT_STALL_MS'] || String(DEFAULT_TUI_STALL_ESCALATION_MS),
  10,
);

/**
 * Lifecycle / non-turn provider notices must never become a live streaming
 * turn. Creating an empty liveEntry + processingLabel for "MCP ready" left a
 * permanent ◆ Shizuha spinner (minutes+) and continuous re-renders that ghost
 * duplicate chrome into tmux scrollback.
 */
export function isLifecycleProviderStatus(code: string | undefined, message: string): boolean {
  const c = (code ?? '').trim().toLowerCase();
  if (c === 'mcp_ready' || c === 'mcp_unavailable' || c.startsWith('mcp_')) return true;
  const m = message.trim();
  return /^(MCP ready|MCP unavailable)\b/i.test(m);
}

export function formatLifecycleProviderStatus(code: string | undefined, message: string): string {
  const label = message.trim();
  const c = (code ?? '').trim().toLowerCase();
  if (c === 'mcp_ready' || /^MCP ready\b/i.test(label)) return `✓ ${label}`;
  if (c === 'mcp_unavailable' || /^MCP unavailable\b/i.test(label)) return `⚠ ${label}`;
  return label;
}

/**
 * Evidence that a provider wait/retry has recovered.
 *
 * `provider_retry_recovered` is emitted only after executeTurn returns. That
 * can be minutes after the retried request has already started streaming, so
 * it is too late to own the transient warning lifecycle. Clear the warning as
 * soon as the event stream proves headers/output arrived instead.
 */
export function isProviderRecoverySignal(event: AgentEvent): boolean {
  switch (event.type) {
    case 'content':
    case 'reasoning_text':
      return event.text.length > 0;
    case 'reasoning':
      return event.summaries.some((summary) => summary.trim().length > 0);
    case 'tool_start':
    case 'turn_complete':
    case 'served_model':
    case 'perf_metrics':
      return true;
    case 'token_progress':
      return event.outputTokens > 0;
    case 'inference_telemetry':
      return event.outcome === 'success';
    case 'provider_status': {
      const code = event.code?.trim().toLowerCase();
      return code === 'provider_retry_recovered' || code === 'connection_recovered';
    }
    default:
      return false;
  }
}
const STATUS_TICK_MS = 1000;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * How many completed transcript entries stay in memory.
 *
 * This returned `null` — UNBOUNDED — unless an operator happened to set
 * SHIZUHA_TUI_HISTORY_WINDOW, and every append path short-circuits on null. So
 * by default a TUI session retained every entry for its entire life, including
 * full tool outputs (file reads, kubectl dumps, log tails), and each append
 * rebuilt the whole array (`[...prev, ...entries]`) — unbounded retention plus
 * O(n^2) allocation churn.
 *
 * A ~4h session died on it (2026-08-05):
 *
 *   Mark-Compact 3813.0 (4133.0) -> 3797.3 MB ... allocation failure
 *   FATAL ERROR: Ineffective mark-compacts near heap limit
 *   JavaScript heap out of memory
 *
 * That is V8's own ~4GB default heap ceiling, not the host's memory — s1 has
 * 512GB and it made no difference. The crash took the session, its scrollback
 * and its queued input with it.
 *
 * A default cap costs nothing durable: the canonical transcript remains in
 * SQLite, `archivedEntryCount` reports the in-memory omission, and the pager
 * rebuilds the full transcript from the store on demand.
 * The env var still overrides — set it to a larger number, or to `unbounded`
 * for the old behaviour.
 */
const DEFAULT_COMPLETED_ENTRY_LIMIT = 1500;

function resolveCompletedEntryLimit(): number | null {
  const raw = (process.env['SHIZUHA_TUI_HISTORY_WINDOW'] ?? '').trim().toLowerCase();
  if (raw === 'unbounded' || raw === 'off' || raw === '0') return null;
  return parsePositiveInt(process.env['SHIZUHA_TUI_HISTORY_WINDOW'])
    ?? DEFAULT_COMPLETED_ENTRY_LIMIT;
}

const COMPLETED_ENTRY_LIMIT = resolveCompletedEntryLimit();

/** Test seam: re-derive the limit from the CURRENT env (the const is captured
 *  at module load, which a retention test cannot vary). */
export function __resolveCompletedEntryLimitForTest(): number | null {
  return resolveCompletedEntryLimit();
}
const AUTH_MCP_RELOAD_TIMEOUT_MS = parsePositiveInt(process.env['SHIZUHA_AUTH_MCP_RELOAD_TIMEOUT_MS']) ?? 5000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ResumedSessionPayload {
  id: string;
  model: string;
  messages: Message[];
  /** Append-only user-visible history; messages remains the provider working set. */
  transcriptMessages?: Message[];
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  sanitizedRemoved?: number;
  resumeTrimmedDropped?: number;
  resumeTrim?: {
    dropped: number;
    beforeMessages: number;
    afterMessages: number;
    beforeTokens: number;
    afterTokens: number;
    preflightCeiling: number;
    contextWindowCeiling: number;
    maxContextTokens: number;
    responsiveBudgetExceeded: boolean;
    hardBudgetExceeded: boolean;
    shrunkOversizedContent?: boolean;
    contextWindowDiscoveryDeferred?: boolean;
  };
  resumeCompaction?: {
    compacted: boolean;
    method: 'provider_semantic';
    attempts: number;
    beforeMessages: number;
    afterMessages: number;
    beforeTokens: number;
    afterTokens: number;
    thresholdTokens: number;
    maxContextTokens: number;
  };
  resumeCompactionPlanned?: boolean;
  interruptCheckpoint?: {
    createdAt: number;
    promptExcerpt: string;
    note: string;
    kind?: 'turn' | 'maintenance';
  };
}

type CompactResult = Awaited<ReturnType<AgentSession['compact']>>;

interface PendingSubmission {
  prompt: string;
  images?: Array<{ base64: string; mediaType: string }>;
}

function isTranscriptRole(message: Message): message is Message & { role: 'user' | 'assistant' } {
  return message.role === 'user' || message.role === 'assistant';
}

export function messageToTranscriptContent(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
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
      if (blockType === 'reasoning') {
        const rawContent = (block as { rawContent?: string }).rawContent;
        if (typeof rawContent === 'string' && rawContent.trim()) {
          reasoningParts.push(rawContent);
        }
      }
      internalAssistantBlockCount++;
      continue;
    }
  }

  if (textParts.length > 0) {
    return textParts.join('\n\n');
  }
  if (message.role === 'assistant' && reasoningParts.length > 0) {
    return reasoningParts.join('\n\n');
  }
  if (internalAssistantBlockCount > 0) {
    return '';
  }
  if (toolResultCount > 0) return '';

  return '';
}

export function messagesToTranscript(messages: Message[]): TranscriptEntry[] {
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

export function assistantTranscriptText(messages: Message[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .map((message) => messageToTranscriptContent(message).trim())
    .filter(Boolean)
    .join('\n\n');
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

function formatCompactSummary(result: CompactResult): string {
  const action = result.compacted ? 'Context compacted' : 'Context compaction skipped';
  const parts = [
    `messages ${result.beforeMessages.toLocaleString()} -> ${result.afterMessages.toLocaleString()}`,
    `~${result.beforeTokens.toLocaleString()} -> ~${result.afterTokens.toLocaleString()} tokens`,
  ];
  if (result.sanitizedRemoved > 0) {
    parts.push(`removed ${result.sanitizedRemoved.toLocaleString()} stale recovery entries`);
  }
  return `${action}: ${parts.join(', ')}.`;
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

function compactActivityText(value: string, maxLen = 34): string {
  const normalized = value
    .replace(/^\s*\/bin\/bash\s+-lc\s+/, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLen - 1)).trimEnd()}\u2026`;
}

function compactBashPurpose(input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) return '';
  const segments = command
    .split(/\s*(?:&&|;|\n)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const meaningful = segments.find((segment) => !/^(?:cd|echo|printf)\b/i.test(segment));
  return compactActivityText(meaningful ?? segments[0] ?? '');
}

function compactToolName(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const parts = toolName.split('__');
  return parts[2] || parts[1] || 'mcp';
}

/** One terminal-width-safe progress hint; never renders tool output bodies. */
export function formatToolActivityLabel(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const lower = toolName.toLowerCase();
  let purpose = lower === 'bash' ? compactBashPurpose(input) : '';
  if (!purpose) {
    for (const key of ['query', 'pattern', 'path', 'file_path', 'url', 'glob']) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) {
        purpose = compactActivityText(value);
        break;
      }
    }
  }
  const name = compactToolName(toolName);
  return purpose ? `Running ${name} \u00b7 ${purpose}...` : `Running ${name}...`;
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
  providerReloaded?: boolean;
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
  /** Live status during the pre-ready window (resume-time compaction etc.). */
  initStatus: string | null;
  /** Completed entries rendered in the prompt transcript */
  completedEntries: TranscriptEntry[];
  /** Entries trimmed from memory; they remain in SQLite and the full pager. */
  archivedEntryCount: number;
  /** Remount key for the <Static> transcript; see the state declaration. */
  transcriptEpoch: number;
  /** Live retry/stall notice shown under the streaming entry, or null. */
  retryNotice: string | null;
  /** Currently streaming entry (or null when idle) */
  liveEntry: TranscriptEntry | null;
  /** Derived full transcript (completedEntries + liveEntry) for pager/copy */
  transcript: TranscriptEntry[];
  /** Full transcript for pager (loaded from the append-only store on demand) */
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
  servedModelInfo: { requestedModel: string; model: string; contextWindow: number } | null;
  /** Last turn's perf summary fragment (e.g. "TTFT 1.2s · 38 tok/s"), or null. */
  lastTurnPerf: string | null;
  /** Current turn live token progress fragment, or null when idle. */
  liveTurnPerf: string | null;
  queuedPromptCount: number;
  queuedPrompts: string[];
  dequeueQueuedPrompts: () => string[];
  stalledMs: number;
  /** Timestamp (epoch ms) of the last agent event, or 0 if none.  StatusBar
   *  derives its own "idle Xs" / "live Xs" display from this without causing
   *  parent re-renders every second. */
  lastAgentEventAt: number;
  processingLabel: string | null;
  /** Descriptions of running background tasks (e.g. "benchmark.py (45s)") */
  runningTasks: string[];
  /** Active /watch subscriptions shown in the status bar */
  activeWatches: string[];
  sessionVersion: number;
  getTaskRegistry: () => AgentSession['taskRegistry'] | null;
  refreshWatches: () => void;
  submitPrompt: (prompt: string) => void;
  resolveApproval: (decision: 'allow' | 'deny' | 'allow_always') => void;
  setModel: (model: string) => boolean;
  setMode: (mode: PermissionMode) => void;
  clearTranscript: () => void;
  compact: (instructions?: string) => Promise<string | void>;
  interrupt: () => void;
  listSessions: () => ReturnType<AgentSession['listSessions']>;
  resumeSession: (id: string) => Promise<{ ok: boolean; checkpointNotice?: string }>;
  newSession: () => void;
  availableModels: () => ModelInfo[];
  availableProviders: () => string[];
  renameSession: (name: string) => boolean;
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

export function useAgentSession(
  cwd: string,
  initialModel?: string,
  initialMode?: PermissionMode,
  initialResumeSessionId?: string,
): UseAgentSessionResult {
  const sessionRef = useRef<AgentSession | null>(null);
  const [ready, setReady] = useState(false);
  // Live status line for the pre-ready window (session init / resume-time
  // compaction). Rendered by App's loading branch instead of a silent
  // "Initializing..." while long maintenance runs.
  const [initStatus, setInitStatus] = useState<string | null>(null);
  const readyRef = useRef(false);
  useEffect(() => { readyRef.current = ready; if (ready) setInitStatus(null); }, [ready]);
  const [completedEntries, setCompletedEntries] = useState<TranscriptEntry[]>([]);
  // Bumped whenever the transcript array is REPLACED or trimmed rather than
  // appended to. <Static> in App.tsx renders items once and tracks how many it
  // has already painted by index, so a shrunk/replaced array would make it skip
  // or duplicate entries. Remounting it on this key reprints correctly.
  const [transcriptEpoch, setTranscriptEpoch] = useState(0);
  // Retry/stall notice pinned BELOW the live entry. processingLabel is only
  // rendered when there is no live entry (`isProcessing && !showLiveEntry`), so
  // once text starts streaming the retry information disappeared from the
  // bottom of the screen and survived only in scrollback — where it scrolls
  // away and gets missed during a long outage (operator 2026-08-04).
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const providerWaitNoticeActiveRef = useRef(false);
  const [archivedEntryCount, setArchivedEntryCount] = useState(0);
  const [liveEntry, setLiveEntry] = useState<TranscriptEntry | null>(null);
  const liveEntryIdRef = useRef('');
  // Deferred finalization: stores entries waiting to be flushed to <Static>.
  // The flush happens in a useEffect so Ink gets one render with liveEntry=null
  // (clearing the dynamic area) before the completed entry appears in <Static>.
  // Kept as a distinct phase so completion state stays coherent for renderers.
  const [isProcessing, setIsProcessing] = useState(false);
  /** Mirror of isProcessing for the long-lived agent_event handler (avoids stale closures). */
  const isProcessingRef = useRef(false);
  const setProcessing = useCallback((value: boolean) => {
    isProcessingRef.current = value;
    setIsProcessing(value);
  }, []);
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
  const [servedModelInfo, setServedModelInfo] = useState<{ requestedModel: string; model: string; contextWindow: number } | null>(null);
  const [lastTurnPerf, setLastTurnPerf] = useState<string | null>(null);
  const [liveTurnPerf, setLiveTurnPerf] = useState<string | null>(null);
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
  const lastAgentEventAtRef = useRef<number>(0);
  const autoShowModelPickerRef = useRef(false);
  const [queuedPromptCount, setQueuedPromptCount] = useState(0);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  const [stalledMs, setStalledMs] = useState(0);
  const stalledMsRef = useRef(0);
  stalledMsRef.current = stalledMs;
  const [processingLabel, setProcessingLabel] = useState<string | null>(null);
  const [runningTasks, setRunningTasks] = useState<string[]>([]);
  const [activeWatches, setActiveWatches] = useState<string[]>([]);
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

  const dequeueQueuedPrompts = useCallback((): string[] => {
    const queued = pendingSubmissionsRef.current;
    const prompts = queued.map((p) => p.prompt);
    pendingSubmissionsRef.current = [];
    sessionRef.current?.dequeuePendingInput();
    syncQueueState();
    return prompts;
  }, [syncQueueState]);

  const refreshWatches = useCallback(() => {
    const watches = sessionRef.current?.taskRegistry.listWatches() ?? [];
    setActiveWatches(watches.map((watch) => `${watch.target} (${watch.policy})`));
  }, []);

  const getTaskRegistry = useCallback(() => sessionRef.current?.taskRegistry ?? null, []);

  const replaceCompletedEntriesWindow = useCallback((entries: TranscriptEntry[], archivedBase = 0) => {
    setTranscriptEpoch((e) => e + 1);
    if (COMPLETED_ENTRY_LIMIT === null) {
      setCompletedEntries(entries);
      setArchivedEntryCount(Math.max(0, archivedBase));
      return;
    }
    const overflow = Math.max(0, entries.length - COMPLETED_ENTRY_LIMIT);
    const visible = overflow > 0 ? entries.slice(-COMPLETED_ENTRY_LIMIT) : entries;
    setCompletedEntries(visible);
    setArchivedEntryCount(Math.max(0, archivedBase + overflow));
  }, []);

  const appendCompletedEntries = useCallback((entries: TranscriptEntry[]) => {
    if (entries.length === 0) return;
    setCompletedEntries((prev) => {
      const merged = [...prev, ...entries];
      if (COMPLETED_ENTRY_LIMIT === null) return merged;
      if (merged.length <= COMPLETED_ENTRY_LIMIT) return merged;
      const overflow = merged.length - COMPLETED_ENTRY_LIMIT;
      setArchivedEntryCount((count) => count + overflow);
      setTranscriptEpoch((e) => e + 1);
      return merged.slice(-COMPLETED_ENTRY_LIMIT);
    });
  }, []);

  const appendCompletedEntry = useCallback((entry: TranscriptEntry) => {
    appendCompletedEntries([entry]);
  }, [appendCompletedEntries]);

  const appendSystemEntry = useCallback((content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
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
      if (COMPLETED_ENTRY_LIMIT === null) return merged;
      if (merged.length <= COMPLETED_ENTRY_LIMIT) return merged;
      const overflow = merged.length - COMPLETED_ENTRY_LIMIT;
      setArchivedEntryCount((count) => count + overflow);
      setTranscriptEpoch((e) => e + 1);
      return merged.slice(-COMPLETED_ENTRY_LIMIT);
    });
  }, []);

  // Derived transcript for pager, /copy, getLastAssistantMessage
  const transcript = useMemo(() => {
    if (liveEntry) return [...completedEntries, liveEntry];
    return completedEntries;
  }, [completedEntries, liveEntry]);

  const getPagerTranscript = useCallback((): TranscriptEntry[] => {
    // The canonical transcript lives in SQLite. Materialize it only for the
    // pager, whose App state is released on exit; never retain a second full
    // transcript for the lifetime of the interactive process.
    const storedMessages = sessionRef.current?.loadTranscriptMessagesForDisplay();
    const base = storedMessages ? messagesToTranscript(storedMessages) : completedEntries;
    if (liveEntry) {
      return [...base, liveEntry];
    }
    return base;
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

    s.init(cwd, initialModel, initialMode).then(async () => {
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
        // SCLI-388: keepalive provider waits must NOT reset the idle stall clock —
        // otherwise "Waiting for model response" every 5s hides multi-minute hangs.
        const isProviderWaitKeepalive =
          event.type === 'provider_status'
          && (event.code === 'request_wait' || event.code === 'request_start');
        if (!isProviderWaitKeepalive) {
          lastAgentEventAtRef.current = Date.now();
        }
        // The timestamp update above is ref-only; ordinary chunks do not force
        // an extra render solely to keep the watchdog current.
        // A timeout notice describes the provider's CURRENT wait state, not
        // historical retry telemetry. Clear it at the first authoritative
        // recovery signal so a healthy streaming response never sits beneath
        // a stale "no response headers" warning until executeTurn completes.
        if (
          isProviderRecoverySignal(event)
          && (
            providerWaitNoticeActiveRef.current
            || stalledMsRef.current !== 0
            || prevStalledRef.current !== 0
            || stallAnnouncedRef.current
          )
        ) {
          providerWaitNoticeActiveRef.current = false;
          setRetryNotice(null);
          setStalledMs(0);
          stalledMsRef.current = 0;
          prevStalledRef.current = 0;
          stallAnnouncedRef.current = false;
        }
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
            setLiveTurnPerf(null);
            setProcessingLabel('Thinking...');
            setStalledMs(0);
            break;

          case 'background_task': {
            const running = s.taskRegistry.list().filter(t => t.status === 'running');
            setRunningTasks(running.map((t) => {
              const elapsed = Math.floor((Date.now() - t.createdAt) / 1000);
              return `${t.description} (${elapsed}s)`;
            }));
            refreshWatches();
            const icon =
              event.status === 'completed' ? '✓'
                : event.status === 'failed' ? '✗'
                  : event.status === 'killed' ? '⏹'
                    : event.status === 'progress' ? '…'
                      : '↪';
            const elapsed = Math.max(0, Math.floor(event.runningMs / 1000));
            appendSystemEntry(`${icon} ${event.taskId} ${event.status}: ${event.description} (${elapsed}s)`);
            break;
          }

          case 'content': {
            streamingTextRef.current = appendStreamingDelta(streamingTextRef.current, event.text);
            // Stream assistant text live in all verbosity modes.
            // Re-render cadence is still throttled to prevent terminal reflow spikes.
            if (shouldStreamAssistantText()) {
              // Throttle content re-renders so large streamed payloads (e.g. big JSON)
              // don't cause violent terminal reflow.
              upsertStreamingAssistant(false);
            }
            break;
          }

          case 'reasoning_text': {
            if (!shouldRenderReasoningTextAsAssistantContent(s.model)) {
              break;
            }
            streamingTextRef.current = appendStreamingDelta(streamingTextRef.current, event.text);
            if (shouldStreamAssistantText()) {
              upsertStreamingAssistant(false);
            }
            break;
          }

          case 'provider_status': {
            const statusCode = String((event as { code?: string }).code ?? '');
            // Resume-time maintenance (large-session compaction) can hold the
            // TUI in the pre-ready state for minutes. Surface the live status
            // there instead of a bare "Initializing..." (operator 2026-08-09:
            // "no signs or hints for the user that compaction is underway").
            if (!readyRef.current) {
              setInitStatus(String(event.message ?? '') || null);
            }
            if (statusCode === 'provider_retry_stall') {
              providerWaitNoticeActiveRef.current = true;
              setRetryNotice(`↻ ${event.message}`);
            }
            // SCLI-388: finite provider no-header stall → recovery affordance.
            if (statusCode === 'stall_timeout') {
              const elapsed = typeof event.elapsedMs === 'number' ? event.elapsedMs : 0;
              const stallMs = longWaitDisplayMs(elapsed, PROVIDER_SOFT_STALL_MS);
              setStalledMs(stallMs);
              // Keep prevStalledRef in sync so the idle watchdog (the only path
              // that CLEARS the banner) sees the positive state and can drop it
              // back to 0 once tokens stream. Without this, the banner froze at
              // "stall 1m 6s" while the model streamed normally (operator 2026-08-08).
              prevStalledRef.current = stallMs;
              providerWaitNoticeActiveRef.current = true;
              setRetryNotice(
                `⚠ Provider/model timeout — no response headers`
                + (elapsed > 0 ? ` after ${Math.round(elapsed / 1000)}s` : '')
                + '. Esc to cancel · /model to switch',
              );
            }
            if (statusCode === 'request_wait' || statusCode === 'request_start') {
              const elapsed = typeof event.elapsedMs === 'number' ? event.elapsedMs : 0;
              const stallMs = longWaitDisplayMs(elapsed, PROVIDER_SOFT_STALL_MS);
              if (stallMs > 0 && stallMs !== stalledMsRef.current) {
                setStalledMs(stallMs);
                // Same sync as above — a genuine pre-first-token wait is a soft
                // stall, but it MUST clear the moment streaming begins.
                prevStalledRef.current = stallMs;
                // The warning is transient UI, not transcript content. A cold
                // start must not leave a stack of five-second status frames in
                // scrollback or persisted session history.
                stallAnnouncedRef.current = true;
              }
              // Provider keepalives carry an exact-second label every five
              // seconds after the soft threshold. Keep the dock label stable;
              // stalledMs is the sole, minute-bucketed elapsed-time display.
              setProcessingLabel('Waiting for model response...');
              break;
            }
            const label = event.message.trim();
            if (!label) break;
            const code = event.code;
            // Lifecycle notices (MCP connect, etc.) and any status while idle
            // are one-shot system entries — never a live streaming turn.
            if (isLifecycleProviderStatus(code, label) || !isProcessingRef.current) {
              if (!isProcessingRef.current) {
                setProcessingLabel(null);
                // Drop a stale empty live entry left by older status handling.
                setLiveEntry((prev) => {
                  if (
                    prev
                    && prev.isStreaming
                    && !(prev.content && prev.content.trim())
                    && !(prev.toolCalls && prev.toolCalls.length > 0)
                  ) {
                    liveEntryIdRef.current = '';
                    return null;
                  }
                  return prev;
                });
              }
              appendSystemEntry(formatLifecycleProviderStatus(code, label));
              break;
            }
            // In-turn status: update the thinking label only. Do not create a
            // live assistant entry from status alone — App shows the standalone
            // ThinkingIndicator while isProcessing && !liveEntry.
            setProcessingLabel(label);
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
            const rawInput = hasToolInput(event.input)
              ? event.input
              : (dequeueToolInputHint(event.toolName) ?? {});
            const { input: resolvedInput, commandPreview } = splitToolInputAndPreview(event.toolName, rawInput);
            setProcessingLabel(formatToolActivityLabel(event.toolName, resolvedInput));
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
              const nextTool = currentToolsRef.current[0]!;
              setProcessingLabel(formatToolActivityLabel(nextTool.name, nextTool.input));
            } else {
              setProcessingLabel('Thinking...');
            }
            upsertStreamingAssistant(true);
            break;
          }

          case 'served_model':
            setServedModelInfo({
              requestedModel: event.requestedModel,
              model: event.model,
              contextWindow: event.contextWindow,
            });
            setContextTokens(s.estimatedContextTokens);
            break;

          case 'turn_complete':
            setTotalInputTokens((prev) => prev + event.inputTokens);
            setTotalOutputTokens((prev) => prev + event.outputTokens);
            setTurnCount((prev) => prev + 1);
            setContextTokens(s.estimatedContextTokens);
            break;

          case 'perf_metrics': {
            // SCLI-21: surface last-turn TTFT / decode rate on the status line.
            const parts: string[] = [];
            if (event.ttftMs !== null) parts.push(`TTFT ${(event.ttftMs / 1000).toFixed(1)}s`);
            if (event.decodeTokensPerSec !== null) parts.push(`${event.decodeTokensPerSec} tok/s`);
            if (event.cacheHitRate != null) parts.push(`cache ${(event.cacheHitRate * 100).toFixed(0)}%`);
            setLastTurnPerf(parts.length ? parts.join(' · ') : null);
            break;
          }

          case 'token_progress':
            setLiveTurnPerf(formatTokenProgressStatus(event));
            break;

          case 'input_injected': {
            // Mid-turn injection: finalize the current liveEntry (partial response),
            // then add the injected user message — in the correct transcript order.
            const injectedText = streamingTextRef.current;
            const injectedTools = [
              [...currentToolsRef.current],
              [...recentCompletedToolsRef.current],
            ].flat().slice(-2);
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
            setLiveTurnPerf(null);
            if (/retrying in|retrying turn|compacted history and retrying/i.test(event.error)) {
              setProcessingLabel('Retrying...');
              providerWaitNoticeActiveRef.current = true;
              setRetryNotice(`↻ ${event.error}`);
              // Commit whatever the assistant has already streamed BEFORE the
              // retry notice. completedEntries render above liveEntry, so
              // appending the notice while a partial response is still live put
              // the ↻ line ABOVE that text — reading as a prefix to the answer
              // rather than a note underneath it, and easy to miss during a long
              // outage (operator 2026-08-04). Flushing first keeps the notice
              // pinned to the bottom of the most recent output.
              setLiveEntry((prev) => {
                if (!prev) return prev;
                const hasContent = Boolean(prev.content && prev.content.trim())
                  || (prev.toolCalls?.length ?? 0) > 0;
                if (!hasContent) return prev;
                appendCompletedEntries([{ ...prev, isStreaming: false }]);
                liveEntryIdRef.current = '';
                streamingTextRef.current = '';
                return null;
              });
              appendSystemEntry(`↻ ${event.error}`);
            } else {
              appendSystemEntry(`✗ ${event.error}`);
              // Settle any tools still marked 'running': a terminal turn error
              // means no tool_complete will ever arrive for them, and the
              // status line otherwise shows a phantom running tool forever
              // (observed live: "bash (1910m)" — 31h — after a ✗ terminated
              // turn whose child process was long gone, 2026-07-07).
              if (currentToolsRef.current.some((tool) => tool.status === 'running')) {
                currentToolsRef.current = currentToolsRef.current.map((tool) =>
                  tool.status === 'running'
                    ? { ...tool, status: 'complete' as const, isError: true, result: tool.result ?? 'Interrupted: turn ended with an error' }
                    : tool);
                upsertStreamingAssistant(false);
              } else {
                // Terminal error with no tools/content: drop empty live ghost
                // (bare ◆ Shizuha left after "Cortex stream error: … timed out").
                setLiveEntry((prev) => {
                  if (
                    prev
                    && prev.isStreaming
                    && !(prev.content && prev.content.trim())
                    && !(prev.toolCalls && prev.toolCalls.length > 0)
                  ) {
                    liveEntryIdRef.current = '';
                    return null;
                  }
                  return prev;
                });
                setProcessingLabel(null);
              }
              // Auto-open model picker on first-turn auth/rate-limit failures
              if (/Use \/model/i.test(event.error)) {
                autoShowModelPickerRef.current = true;
              }
            }
            break;

          case 'complete': {
            providerWaitNoticeActiveRef.current = false;
            setRetryNotice(null);
            // Finalize streaming entry: move liveEntry → completedEntries
            lastStreamingRenderAtRef.current = 0;
            recentCompletedToolsRef.current = recentCompletedToolsRef.current.map((tool) => {
              if (hasToolInput(tool.input)) return tool;
              const recovered = s.findToolInput(tool.id);
              if (!recovered) return tool;
              const { input, commandPreview } = splitToolInputAndPreview(tool.name, recovered);
              return { ...tool, input, commandPreview: tool.commandPreview ?? commandPreview };
            });
            // Keep bounded details for the explicit Ctrl+P pager. The normal
            // conversation viewport omits them, so completed output never
            // remains pinned above the composer.
            const archivedTools = [
              [...currentToolsRef.current],
              [...recentCompletedToolsRef.current],
            ].flat().slice(-2);
            // Build the finalized entry from liveEntry or create a new one.
            // Trim whitespace-only text (e.g. lone '\n' from turn_start paragraph breaks)
            // to avoid creating empty entries that render bare "◆ Shizuha" headers.
            const persistedText = assistantTranscriptText(s.getMessagesSinceLastUserPrompt()).trim();
            const finalText = persistedText || streamingTextRef.current.trim() || undefined;
            // Finalize: move liveEntry → completedEntries (rendered via <Static>).
            // The liveEntry's MessageBlock uses hideHeader so any ghost frame in
            // scrollback won't duplicate the "◆ Shizuha" header from the Static entry.
            setLiveEntry((prev) => {
                if (prev || finalText || archivedTools.length > 0) {
                  const finalized: TranscriptEntry = {
                    id: prev?.id ?? `assistant-${Date.now()}`,
                    role: 'assistant',
                    content: finalText ?? '',
                    timestamp: prev?.timestamp ?? Date.now(),
                    toolCalls: archivedTools,
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
              setProcessing(true);
              setLiveTurnPerf(null);
              setProcessingLabel('Thinking...');
              setStalledMs(0);
              lastAgentEventAtRef.current = Date.now();
              lastAgentEventAtRef.current = Date.now();
              stallAnnouncedRef.current = false;
              void s.submitPrompt(next.prompt, next.images);
            } else {
              setProcessing(false);
              setLiveTurnPerf(null);
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
        setServedModelInfo(null);
        const displayMessages = session.transcriptMessages ?? session.messages;
        const entries = messagesToTranscript(displayMessages);
        replaceCompletedEntriesWindow(entries, 0);
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
        setProcessing(false);
        setStalledMs(0);
        lastAgentEventAtRef.current = Date.now();
        setProcessingLabel(null);
        setLiveTurnPerf(null);
        stallAnnouncedRef.current = false;
        setError(null);
        // Replay only turn checkpoints — maintenance frames (compaction
        // heartbeats) are crash forensics, and this resume already reported
        // any compaction it ran via the dedicated lines above.
        const cp = session.interruptCheckpoint?.kind === 'maintenance'
          ? undefined
          : session.interruptCheckpoint;
        const promptClause = cp && cp.promptExcerpt && cp.promptExcerpt !== '(unknown prompt)'
          ? ` Last prompt: "${cp.promptExcerpt}"`
          : '';
        resumeCheckpointNoticeRef.current = cp ? `${cp.note}${promptClause}` : null;
        appendSystemEntry(`Resumed session ${session.id.slice(0, 8)}.`);
        if ((session.sanitizedRemoved ?? 0) > 0) {
          appendSystemEntry(`Cleaned stale recovery messages: ${session.sanitizedRemoved} removed.`);
        }
        if (session.resumeCompaction?.compacted) {
          const compacted = session.resumeCompaction;
          appendSystemEntry(
            `Resumed context exceeded the compaction threshold and its oldest history was summarized via the model provider before the session became ready`
              + ` (${compacted.beforeMessages} -> ${compacted.afterMessages} messages,`
              + ` ~${compacted.beforeTokens} -> ~${compacted.afterTokens} tokens;`
              + ` threshold ${compacted.thresholdTokens}/${compacted.maxContextTokens}).`,
          );
        }
        if ((session.resumeTrimmedDropped ?? 0) > 0) {
          const trim = session.resumeTrim;
          const detail = trim
            ? ` (${trim.beforeMessages} -> ${trim.afterMessages} messages, ~${trim.beforeTokens} -> ~${trim.afterTokens} tokens; backend fit ${trim.contextWindowCeiling}/${trim.maxContextTokens})`
            : '';
          appendSystemEntry(`Using a trimmed working context because the resumed transcript exceeded the backend context fit budget: ${session.resumeTrimmedDropped} older message(s) omitted from this model context${detail}. Full session history remains stored.`);
        } else if (session.resumeTrim?.shrunkOversizedContent) {
          const trim = session.resumeTrim;
          appendSystemEntry(
            `Oversized resumed tool output was bounded without dropping whole messages`
              + ` (~${trim.beforeTokens} -> ~${trim.afterTokens} tokens).`,
          );
        } else if (session.resumeTrim?.contextWindowDiscoveryDeferred) {
          appendSystemEntry('Provider context metadata was temporarily unavailable. The resumed working context was preserved unchanged; SCLI will retry discovery before the next model request.');
        } else if (session.resumeTrim?.responsiveBudgetExceeded) {
          const trim = session.resumeTrim;
          appendSystemEntry(`Large resumed context preserved for KV continuity: ~${trim.beforeTokens} tokens exceeds the responsive target ${trim.preflightCeiling}, but fits backend budget ${trim.contextWindowCeiling}/${trim.maxContextTokens}.`);
        }
        if (cp) {
          appendSystemEntry(`Resume checkpoint: ${cp.note}${promptClause}`);
        }
        if (session.resumeCompactionPlanned) {
          appendSystemEntry('Interrupted session will compact automatically before the next prompt.');
        }
      });

      s.on('session_new', () => {
        replaceCompletedEntriesWindow([], 0);
        setLiveEntry(null);
        liveEntryIdRef.current = '';
        streamingTextRef.current = '';
        reasoningSummariesRef.current = [];
        lastReasoningSummaryRef.current = '';
        setStalledMs(0);
        lastAgentEventAtRef.current = 0;
        setProcessingLabel(null);
        setLiveTurnPerf(null);
        pendingToolInputHintsRef.current.clear();
        recentCompletedToolsRef.current = [];
        lastCompactionSummaryRef.current = '';
        stallAnnouncedRef.current = false;
        setSessionVersion((v) => v + 1);
      });

      if (initialResumeSessionId) {
        const ok = await s.resumeSession(initialResumeSessionId);
        if (!ok) {
          setError(`Failed to resume session ${initialResumeSessionId.slice(0, 8)}`);
        }
      }

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
  }, [cwd, initialModel, initialMode, initialResumeSessionId]);

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
        const nextStall = longWaitDisplayMs(idleMs, STALL_WARN_MS);
        // The idle watchdog is the ONLY authority that CLEARS the stall banner.
        // Direct writers (provider_status request_wait/stall_timeout handlers)
        // set positive stalledMs AND sync prevStalledRef. Reconcile against the
        // actual state ref too, so a future direct writer cannot leave a stale
        // positive banner merely by forgetting that sync. (A false-positive
        // "stall 1m 6s" froze while tokens streamed — operator 2026-08-08.)
        const changed = nextStall === 0
          ? prevStalledRef.current !== 0 || stalledMsRef.current !== 0
          : prevStalledRef.current === 0
            ? nextStall > 0
            : Math.abs(nextStall - prevStalledRef.current) >= STATUS_TICK_MS;
        if (changed) {
          prevStalledRef.current = nextStall;
          setStalledMs(nextStall);
          if (nextStall > 0 && !stallAnnouncedRef.current) {
            // Check if we're waiting on a background task. This remains
            // transient status state; long-wait warnings do not belong in the
            // durable transcript.
            const s = sessionRef.current;
            const bgTasks = s?.taskRegistry.list().filter(t => t.status === 'running') ?? [];
            if (bgTasks.length > 0) {
              setRunningTasks(bgTasks.map(t => {
                const elapsed = Math.floor((Date.now() - t.createdAt) / 1000);
                return `${t.description} (${elapsed}s)`;
              }));
            } else {
              setRunningTasks([]);
            }
            stallAnnouncedRef.current = true;
          } else if (nextStall === 0) {
            stallAnnouncedRef.current = false;
          }
        }
      } else if (prevStalledRef.current !== 0) {
        prevStalledRef.current = 0;
        setStalledMs(0);
        setRunningTasks([]);
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
      // Queue for delivery at the next turn boundary — typing no longer cuts
      // the agent off mid-answer (Esc is the explicit interrupt).
      // DON'T add user entry to completedEntries yet — the input_injected event
      // will add it in the correct order (after the assistant response).
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

    setProcessing(true);
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
      setServedModelInfo(null);
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
    setContextTokens(0);
    setServedModelInfo(null);
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

  const compact = useCallback(async (instructions?: string): Promise<string | void> => {
    const s = sessionRef.current;
    if (!s) return 'Session is not ready yet.';
    if (isProcessing) {
      const message = 'A turn is still running. Press Ctrl+C to interrupt it, or wait for it to finish, then run /compact again.';
      appendSystemEntry(message);
      return message;
    }

    setProcessing(true);
    setError(null);
    setProcessingLabel('Compacting context...');
    setStalledMs(0);
    lastAgentEventAtRef.current = Date.now();
    stallAnnouncedRef.current = false;
    try {
      const result = await s.compact(instructions);
      if (result.reason) {
        appendSystemEntry(result.reason);
        return result.reason;
      }
      const entries = messagesToTranscript(result.messages);
      replaceCompletedEntriesWindow(entries, 0);
      setLiveEntry(null);
      liveEntryIdRef.current = '';
      streamingTextRef.current = '';
      reasoningSummariesRef.current = [];
      lastReasoningSummaryRef.current = '';
      currentToolsRef.current = [];
      recentCompletedToolsRef.current = [];
      lastCompactionSummaryRef.current = '';
      pendingToolInputHintsRef.current.clear();
      lastStreamingRenderAtRef.current = 0;
      setContextTokens(s.estimatedContextTokens);
      const message = formatCompactSummary(result);
      appendSystemEntry(message);
      return message;
    } finally {
      setProcessing(false);
      setProcessingLabel(null);
      setStalledMs(0);
    }
  }, [appendSystemEntry, isProcessing, replaceCompletedEntriesWindow]);

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
    setProcessing(false);
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
    // Do not expose the composer while resume-time maintenance can still
    // rewrite the active context. A prompt accepted in this window used to be
    // overwritten when a slow compaction completed later.
    setReady(false);
    let ok = false;
    try {
      ok = await s.resumeSession(id);
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
    } finally {
      setReady(true);
    }
    const checkpointNotice = resumeCheckpointNoticeRef.current ?? undefined;
    resumeCheckpointNoticeRef.current = null;
    return { ok, checkpointNotice };
  }, []);

  const newSession = useCallback(() => {
    sessionRef.current?.newSession();
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
      // Queue with image — delivered at the next turn boundary
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

    setProcessing(true);
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

  const renameSessionFn = useCallback((name: string): boolean => {
    return sessionRef.current?.renameSession(name) ?? false;
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
    else if (provider === 'cortex') setCortexApiKey(token);

    // 2. Reinitialize providers so the new credential is picked up
    const s = sessionRef.current;
    if (s) {
      s.reinitializeProviders();
      s.setModel(modelSlug);
    }
    setModelState(modelSlug);
    setServedModelInfo(null);
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
    setServedModelInfo(null);
    setInitWarning(null);
  }, []);

  const loginShizuha = useCallback(async (username: string, password: string): Promise<ShizuhaLoginResult> => {
    const loginResult = await loginToShizuhaId(username, password);
    const s = sessionRef.current;
    if (!s) {
      return {
        username: loginResult.username,
        providerReloaded: false,
        mcpReloaded: false,
        reloadError: 'Session is not ready yet',
      };
    }

    s.reinitializeProviders();

    try {
      await withTimeout(s.reconnectMCPWithLatestConfig(), AUTH_MCP_RELOAD_TIMEOUT_MS, 'MCP auth reload');
      return { username: loginResult.username, providerReloaded: true, mcpReloaded: true };
    } catch (err) {
      return {
        username: loginResult.username,
        providerReloaded: true,
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
      await withTimeout(s.reconnectMCPWithLatestConfig(), AUTH_MCP_RELOAD_TIMEOUT_MS, 'MCP auth reload');
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
    ready, initStatus, completedEntries, archivedEntryCount, transcriptEpoch, retryNotice, liveEntry, transcript, getPagerTranscript, isProcessing,
    pendingApproval, approvalQueueLength, error, initWarning,
    model, mode, totalInputTokens, totalOutputTokens, turnCount, sessionId, sessionVersion,
    contextTokens, servedModelInfo, lastTurnPerf, liveTurnPerf, queuedPromptCount, queuedPrompts, stalledMs,
    lastAgentEventAt: lastAgentEventAtRef.current, processingLabel, runningTasks, activeWatches,
    getTaskRegistry, refreshWatches,
    submitPrompt, dequeueQueuedPrompts, resolveApproval, setModel, setMode, clearTranscript,
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
