import type { ZodSchema, ZodType } from 'zod';

// ── Tool Results ──

export interface ImageData {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  /** If set, the tool result contains an image (e.g., from reading a PNG file) */
  image?: ImageData;
  /** SCLI-31: wall-clock execution time for this tool call, stamped at the
   *  call site so run-telemetry can report real per-tool durations. */
  durationMs?: number;
}

// ── Tool Context ──

export interface ToolContext {
  cwd: string;
  sessionId: string;
  abortSignal?: AbortSignal;
  /** Callback for tools to emit incremental output (e.g., streaming bash) */
  onProgress?: (text: string) => void;
  /** Active plan file path when in plan mode */
  planFilePath?: string;
  /** Background task registry — available when background tasks are enabled */
  taskRegistry?: import('../tasks/registry.js').BackgroundTaskRegistry;
  /** OS-level sandbox configuration — when set, bash commands run inside a sandbox */
  sandbox?: import('../sandbox/types.js').SandboxConfig;
  /** Parent agent config — used by task tool to spawn sub-agents with same model/provider */
  agentConfig?: import('../agent/types.js').AgentConfig;
}

// ── Tool Definition (sent to LLM) ──

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── Tool Handler (implementation) ──

export interface ToolHandler {
  /** Tool name (e.g., "read", "bash", "mcp__pulse__list_tasks") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Zod schema for input validation (auto-generates JSON Schema for LLM) */
  parameters: ZodType;
  /** Optional JSON Schema to send to the LLM when the source already provides one. */
  inputSchema?: Record<string, unknown>;
  /** Execute the tool */
  execute(params: unknown, context: ToolContext): Promise<ToolResult>;
  /** If true, can run in parallel with other read-only tools */
  readOnly: boolean;
  /** Risk level drives permission decisions */
  riskLevel: 'low' | 'medium' | 'high';
  /**
   * Silent-stall watchdog (opt-in): if the tool emits no progress output for
   * this long, the agent loop abandons it with an error result instead of
   * awaiting it forever. Each onProgress emission resets the timer. Leave
   * unset for tools that legitimately wait silently (ask_user, task).
   */
  silentTimeoutMs?: number;
}
