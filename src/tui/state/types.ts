import type { PermissionMode } from '../../permissions/types.js';

/** TUI screen modes */
export type ScreenMode = 'prompt' | 'approval' | 'sessions' | 'models' | 'help' | 'pager';

/** Model info for model picker */
export interface ModelInfo {
  slug: string;
  displayName: string;
  description: string;
  provider: string;
  /** Provider group label for hierarchical display (e.g., "OpenAI / Codex", "Anthropic / Claude") */
  group: string;
  reasoningLevels: string[];
  visibility: 'list' | 'hide';
}

/** A rendered message in the transcript */
export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCallEntry[];
  isStreaming?: boolean;
  reasoningSummaries?: string[];
}

/** A tool call in the transcript */
export interface ToolCallEntry {
  id: string;
  name: string;
  input: Record<string, unknown>;
  commandPreview?: string;
  result?: string;
  isError?: boolean;
  durationMs?: number;
  status: 'running' | 'complete';
  metadata?: Record<string, unknown>;
}

/** Pending approval request */
export interface ApprovalRequest {
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high';
  resolve: (decision: 'allow' | 'deny' | 'allow_always') => void;
}

/** Session summary for picker */
export interface SessionSummary {
  id: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  name?: string;
  firstMessage?: string;
}

/** TUI global state */
export interface TUIState {
  screen: ScreenMode;
  model: string;
  mode: PermissionMode;
  sessionId: string | null;
  transcript: TranscriptEntry[];
  isProcessing: boolean;
  pendingApproval: ApprovalRequest | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  startTime: number;
  error: string | null;
}
