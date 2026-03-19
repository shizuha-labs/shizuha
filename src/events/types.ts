export type AgentEventType =
  | 'session_start'
  | 'turn_start'
  | 'content'
  | 'thinking'
  | 'reasoning'
  | 'reasoning_text'
  | 'tool_start'
  | 'tool_progress'
  | 'tool_complete'
  | 'turn_complete'
  | 'input_injected'
  | 'model_fallback'
  | 'error'
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

/** Streaming reasoning summary delta — the model's live thinking text (gpt-5.4 etc.) */
export interface ReasoningTextEvent {
  type: 'reasoning_text';
  text: string;
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

export type AgentEvent =
  | SessionStartEvent
  | TurnStartEvent
  | ContentEvent
  | ThinkingEvent
  | ReasoningEvent
  | ReasoningTextEvent
  | ToolStartEvent
  | ToolProgressEvent
  | ToolCompleteEvent
  | TurnCompleteEvent
  | InputInjectedEvent
  | ModelFallbackEvent
  | ErrorEvent
  | CompleteEvent;
