export type AgentEventType =
  | 'session_start'
  | 'turn_start'
  | 'content'
  | 'thinking'
  | 'reasoning'
  | 'reasoning_text'
  | 'provider_status'
  | 'tool_start'
  | 'tool_progress'
  | 'tool_complete'
  | 'turn_complete'
  | 'input_injected'
  | 'model_fallback'
  | 'served_model'
  | 'perf_metrics'
  | 'token_progress'
  | 'inference_telemetry'
  | 'error'
  | 'proactive_message'
  | 'warning'
  | 'stuck'
  | 'struggle'
  | 'background_task'
  | 'complete';

export interface SessionStartEvent {
  type: 'session_start';
  sessionId: string;
  model: string;
  timestamp: number;
  /** Stable assistant message UUID for the enclosing execution. */
  messageId?: string;
  /** Active plan file path when in plan mode */
  planFilePath?: string;
}

export interface TurnStartEvent {
  type: 'turn_start';
  turnIndex: number;
  timestamp: number;
}

export interface ContentEvent {
  type: 'content';
  text: string;
  timestamp: number;
}

export interface ToolStartEvent {
  type: 'tool_start';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
}

export interface ToolProgressEvent {
  type: 'tool_progress';
  toolCallId: string;
  toolName: string;
  output: string;
  timestamp: number;
}

export interface ToolCompleteEvent {
  type: 'tool_complete';
  toolCallId: string;
  toolName: string;
  result: string;
  isError: boolean;
  durationMs: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
  /** Image data from tool result (e.g., reading an image file) */
  image?: { base64: string; mediaType: string };
  /** Audio data from tool result (e.g., text-to-speech) */
  audio?: { base64: string; format: string; mimeType: string };
}

export interface TurnCompleteEvent {
  type: 'turn_complete';
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  durationMs: number;
  timestamp: number;
}

export interface ThinkingEvent {
  type: 'thinking';
  timestamp: number;
}

export interface ReasoningEvent {
  type: 'reasoning';
  summaries: string[];
  timestamp: number;
}

/** Streaming reasoning summary delta — the model's live thinking text (gpt-5.5 etc.) */
export interface ReasoningTextEvent {
  type: 'reasoning_text';
  text: string;
  timestamp: number;
}

export interface ProviderStatusEvent {
  type: 'provider_status';
  message: string;
  level?: 'info' | 'warning';
  provider?: string;
  code?: string;
  attempt?: number;
  maxAttempts?: number;
  retryInMs?: number;
  traceId?: string;
  requestId?: string;
  sessionId?: string;
  waitPhase?: 'headers' | 'first_chunk' | 'retry_backoff' | 'stream' | 'none';
  elapsedMs?: number;
  timeoutMs?: number;
  timestamp: number;
}

export interface ErrorEvent {
  type: 'error';
  error: string;
  code?: string;
  timestamp: number;
}

/** Emitted when a model fails and the agent falls back to the next model in the chain. */
export interface ModelFallbackEvent {
  type: 'model_fallback';
  fromModel: string;
  toModel: string;
  reason: string;
  fallbackIndex: number;
  chainLength: number;
  timestamp: number;
}

/**
 * SCLI-218: the backend served this session's last response with a concrete
 * model that differs from (or newly resolves) the requested one — emitted for
 * virtual aliases like cortex/auto when the served rung changes. Consumers
 * (TUI status bar, dashboard) should display `requestedModel→model` and use
 * `contextWindow` as the honest denominator for context-usage percentages.
 */
export interface ServedModelEvent {
  type: 'served_model';
  /** Original requested slug, e.g. "cortex/auto". */
  requestedModel: string;
  /** Concrete model the backend served. */
  model: string;
  /** Effective compaction/context window now in force for the session. */
  contextWindow: number;
  timestamp: number;
}

/** Emitted when a queued user message is injected mid-loop (instant interruption). */
export interface InputInjectedEvent {
  type: 'input_injected';
  prompt: string;
  timestamp: number;
}

export interface CompleteEvent {
  type: 'complete';
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalDurationMs: number;
  timestamp: number;
}

export interface ProactiveMessageEvent {
  type: 'proactive_message';
  content: string;
  agentId?: string;
  messageId?: string;
  timestamp: number;
}

export interface PerfMetricsEvent {
  type: 'perf_metrics';
  provider: string;
  model: string;
  ttftMs: number | null;
  decodeTokensPerSec: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cacheHitRate?: number | null;
  totalDurationMs: number;
  timestamp: number;
}


export interface InferenceTelemetryEvent {
  type: 'inference_telemetry';
  traceId: string;
  requestId: string;
  spanId: string;
  sessionId?: string;
  agentId?: string;
  runtimeId?: string;
  provider: string;
  harness?: string;
  requestedModel: string;
  resolvedModel: string;
  /** Cortex request id for the final accepted attempt (server-side log/UsageRecord join key). */
  upstreamRequestId?: string;
  /** Rejected admission attempts preceding the accepted response. */
  admissionAttempts?: Array<{ requestId?: string; status: number; waitMs: number; retryInMs: number }>;
  backend?: {
    id?: string;
    baseUrl?: string;
    pod?: string;
    node?: string;
    hint?: string;
  };
  lifecycle: {
    requestStart: number;
    headersReceived?: number;
    firstChunk?: number;
    firstToken?: number;
    completion?: number;
    abort?: number;
  };
  timeoutPhase?: 'connect' | 'headers' | 'first_chunk' | 'mid_stream_stall' | 'finalization' | 'none';
  errorClass?: string;
  upstreamStatus?: number;
  upstreamCode?: string | number;
  upstreamMessage?: string;
  retryCount: number;
  outcome: 'success' | 'error' | 'timeout' | 'aborted';
  inputTokens?: number;
  outputTokens?: number;
  thinkingMode?: string;
  toolMode?: boolean;
  maxTokens?: number;
  timestamp: number;
}

export interface TokenProgressEvent {
  type: 'token_progress';
  inputTokens: number;
  outputTokens: number;
  outputTokensPerSec: number | null;
  estimated: boolean;
  timestamp: number;
}

/** Advisory warning from the agent loop (e.g. TTFT degradation). */
export interface WarningEvent {
  type: 'warning';
  code: string;
  message: string;
  timestamp: number;
}

/** PLAT-216: emitted when the no-progress guard fires — agent looped without advancing. */
export interface StuckEvent {
  type: 'stuck';
  /** Human-readable reason */
  reason: string;
  /** How many consecutive turns had no new tool-call signatures */
  turnsWithoutProgress: number;
  /** The configured threshold that was exceeded */
  threshold: number;
  timestamp: number;
}

/**
 * SCLI-32: emitted by the struggle analyzer when a confirmed struggle pattern is detected.
 * SCLI-33 subscribes to this and auto-files a deduped Pulse bug without LLM involvement.
 */
/**
 * Emitted when a background task is created, updated, or completed.
 * Lets the TUI show what the agent is waiting on instead of a generic stall message.
 */
export interface BackgroundTaskEvent {
  type: 'background_task';
  /** 'started' | 'progress' | 'completed' | 'failed' | 'killed' */
  status: 'started' | 'progress' | 'completed' | 'failed' | 'killed';
  taskId: string;
  description: string;
  /** How long the task has been running in ms */
  runningMs: number;
  timestamp: number;
}

export interface StruggleEvent {
  type: 'struggle';
  runId: string;
  agent?: string;
  /** Pattern classification from the struggle analyzer (SCLI-32). */
  kind: 'STALL' | 'THRASH' | 'ERROR_DENSITY' | 'LONG_RUN';
  /** Human-readable diagnosis from the heuristic (not LLM-generated). */
  diagnosis: string;
  /** Rolling-window summary at detection time. */
  windowSummary: {
    turnsAnalyzed: number;
    errorRate: number;
    noOpRate: number;
    avgTurnMs: number;
  };
  timestamp: number;
}

export type AgentEvent =
  | SessionStartEvent
  | TurnStartEvent
  | ContentEvent
  | ThinkingEvent
  | ReasoningEvent
  | ReasoningTextEvent
  | ProviderStatusEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolCompleteEvent
  | TurnCompleteEvent
  | InputInjectedEvent
  | ModelFallbackEvent
  | ServedModelEvent
  | PerfMetricsEvent
  | TokenProgressEvent
  | InferenceTelemetryEvent
  | ErrorEvent
  | ProactiveMessageEvent
  | WarningEvent
  | StuckEvent
  | StruggleEvent
  | BackgroundTaskEvent
  | CompleteEvent;
