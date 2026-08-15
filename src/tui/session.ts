import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { Message } from '../agent/types.js';
import type { AgentEvent } from '../events/types.js';
import type { PermissionMode } from '../permissions/types.js';
import type { ToolContext, ToolDefinition } from '../tools/types.js';
import {
  buildDeferredToolDefinitions,
  modelSupportsAppendOnlyToolActivation,
} from '../tools/tool-search.js';
import type { PermissionAskCallback } from '../agent/turn.js';
import {
  evaluateRepeatedToolLoop,
  isEmptyToolArgsError,
  toolCallSignature,
  turnHadToolError,
} from '../agent/tool-loop-guard.js';import type { LLMProvider } from '../provider/types.js';
import {
  type CompactionProgress,
} from '../state/compaction.js';
import {
  resolveDynamicCompactionWindow,
  type CompactionWindowMode,
} from '../provider/context-window.js';
import {
  resolveCortexAuthToken,
  resolveCortexBaseUrl,
} from '../provider/registry.js';
import { assembleCortexModels } from './cortex-models.js';
import { BackgroundTaskRegistry } from '../tasks/registry.js';
import type { SessionSummary, ModelInfo } from './state/types.js';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';
// SCLI-32: the interactive TUI loop is a SEPARATE executeTurn loop from runAgent,
// so it must wire the struggle analyzer + auto-filer itself (review P2-4) — else
// STALL/THRASH/ERROR_DENSITY/LONG_RUN never fire for interactive sessions.
import { TurnTelemetryWindow, recordTurnTelemetry } from '../telemetry/turn-telemetry.js';
import { StruggleAnalyzer } from '../agent/struggle-analyzer.js';
import { setupStrugglePulseAutoFiler } from '../telemetry/struggle-auto-filer.js';
import {
  hasVisibleAssistantText,
  isProgressOnlyAssistantText,
  reasoningTextFromContent,
  visibleTextFromContent,
} from '../agent/content.js';
import { incompleteTurnError } from '../agent/incomplete-turn.js';
import {
  DEGENERACY_RECOVERY_PROMPT,
  detectOutputDegeneracy,
  isDegeneracyStopNotice,
} from '../agent/output-degeneracy-guard.js';
import { getModelProfile } from '../provider/model-profile.js';
import {
  compareProviderPrefixSnapshots,
  providerPrefixContinuityLogFields,
  providerPrefixContinuityLogMessage,
  type ProviderPrefixSnapshot,
} from '../telemetry/provider-prefix-continuity.js';
import {
  compactionThresholdFor,
  effectiveContextTokens,
  estimateTokens,
  getSafetyFactor,
  needsCompaction,
} from '../prompt/context.js';
import {
  estimatePromptTokenBudget,
  resolveContextPreflightGuardTokens,
  resolveInteractivePreflightCeilingTokens,
} from '../agent/heartbeat-hygiene.js';
import {
  loadInlineFileForMention,
  maxTotalInlineFileChars,
} from './utils/fileMentions.js';

const INTERACTIVE_DEFAULT_MAX_TURNS = 30;
// Repeated identical tool-call handling. We do NOT hard-stop early (Claude Code
// trusts the model + maxTurns + user interrupt). Instead, from the 2nd identical
// repeat onward we inject an escalating, ERROR-AWARE corrective nudge so the model
// fixes its approach (e.g. wrong cwd) rather than being killed. A hard stop only
// fires as a generous runaway backstop to bound token burn on weak local models.
/** Soft nudge for consecutive *failing* identical tool turns (see evaluateRepeatedToolLoop). */
const REPEATED_TOOL_CALL_NUDGE_AT = 2;
/** Hard-stop only for failing identical turns — successful repeats never hard-stop. */
const REPEATED_TOOL_CALL_STOP_AT = 6;
// Error-streak: after this many CONSECUTIVE turns whose tool calls error out, inject
// a forcing nudge (diagnose root cause, change approach). Catches diffuse flailing
// (many DIFFERENT calls that keep failing) the byte-identical guard misses. NOTE:
// the trigger is repeated ERRORS, NOT absence of file edits — read-only/exploratory
// tasks legitimately make no edits and must never be nudged for that.
const ERRORED_TURN_NUDGE_AT = 4;
const INTERNAL_RECOVERY_PROMPTS = new Set([
  'Continue. If a tool result is available, answer the user directly from it.',
  'Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.',
  DEGENERACY_RECOVERY_PROMPT,
]);

export function resolveTuiPreflightGuardTokens(maxContextTokens: number, env: NodeJS.ProcessEnv = process.env): number {
  return resolveContextPreflightGuardTokens(maxContextTokens, env);
}

export function resolveTuiPreflightCeilingTokens(
  maxContextTokens: number,
  outputReserveTokens: number,
  guardTokens: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveInteractivePreflightCeilingTokens(maxContextTokens, outputReserveTokens, guardTokens, env);
}

interface TuiCompactResult {
  compacted: boolean;
  reason?: string;
  messages: Message[];
  sanitizedRemoved: number;
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
}

interface ResumeTrimResult {
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
  /** Oversized payloads were truncated without dropping whole messages. */
  shrunkOversizedContent?: boolean;
  /** No destructive fit was attempted because live self-hosted metadata was unavailable. */
  contextWindowDiscoveryDeferred: boolean;
}

interface ResumeCompactionResult {
  compacted: boolean;
  method: 'provider_semantic';
  attempts: number;
  beforeMessages: number;
  afterMessages: number;
  beforeTokens: number;
  afterTokens: number;
  thresholdTokens: number;
  maxContextTokens: number;
}

type CompactMessagesFn = (
  messages: Message[],
  provider: LLMProvider,
  model: string,
  maxTokens: number,
  options?: {
    force?: boolean;
    customInstructions?: string;
    abortSignal?: AbortSignal;
    overheadTokens?: number;
    planFilePath?: string;
    sessionId?: string;
    onProgress?: (p: CompactionProgress) => void;
  },
) => Promise<{ messages: Message[]; compacted: boolean }>;

/** Render a one-line compaction status with a live progress bar (Claude-Code style). */
function renderCompactionStatus(
  phase: string,
  seconds: number,
  progress: CompactionProgress | null,
  expectedPrefillSeconds = 0,
): string {
  const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  // Before the first output token, the model is prefilling the (large) prompt.
  // With an expected-duration estimate (prompt tokens at the conservative
  // prefill floor rate), show a determinate bar so a multi-minute compaction
  // reads as PROGRESS, not a hang (operator 2026-08-09).
  if (!progress || progress.outputTokens <= 0) {
    if (expectedPrefillSeconds > 0) {
      const width = 16;
      const frac = Math.min(0.99, seconds / expectedPrefillSeconds);
      const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
      const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
      const fmtMin = (s: number) => (s >= 90 ? `~${Math.round(s / 60)}m` : `~${Math.round(s)}s`);
      return `Compacting context (${phase})... reading conversation ▕${bar}▏ ${seconds}s / ${fmtMin(expectedPrefillSeconds)} expected`;
    }
    return `Compacting context (${phase})... reading conversation · ${seconds}s`;
  }
  const { outputTokens, budget, stage } = progress;
  const width = 16;
  // Cap the visible fill at 99% so it never shows "100%" while still generating;
  // the budget is the real upper bound (summary usually stops well before it).
  const frac = Math.min(0.99, budget > 0 ? outputTokens / budget : 0);
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const tps = Math.round(outputTokens / seconds);
  const retry = stage === 'retry' ? ' (retry)' : '';
  return `Compacting context (${phase})${retry} ▕${bar}▏ ${fmtTok(outputTokens)}/${fmtTok(budget)} tok · ${tps} tok/s · ${seconds}s`;
}

function messageTextContent(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('\n');
}

function isInternalRecoveryPrompt(message: Message): boolean {
  return message.role === 'user' && INTERNAL_RECOVERY_PROMPTS.has(messageTextContent(message).trim());
}

function isEmptyAssistantMessage(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (typeof message.content === 'string') return message.content.trim().length === 0 || message.content.trim() === '[]';
  return Array.isArray(message.content) && message.content.length === 0;
}

/** Clean up raw API error messages for display in the TUI.
 *  Extracts human-readable info from JSON error bodies and Anthropic SDK messages. */
function humanizeApiError(raw: string): string {
  // Try to extract from JSON error body: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) {
      const type = parsed.error.type ? ` (${parsed.error.type.replace(/_/g, ' ')})` : '';
      return `${parsed.error.message}${type}`;
    }
  } catch { /* not JSON */ }

  // Anthropic SDK format: "529 {"type":"error",...}" — strip status prefix and parse
  const statusPrefixMatch = raw.match(/^\d{3}\s+(\{.+\})$/s);
  if (statusPrefixMatch) {
    try {
      const parsed = JSON.parse(statusPrefixMatch[1]!);
      if (parsed?.error?.message) {
        const type = parsed.error.type ? ` (${parsed.error.type.replace(/_/g, ' ')})` : '';
        return `${parsed.error.message}${type}`;
      }
    } catch { /* not parseable */ }
  }

  // Already human-friendly messages (e.g., from fast-fail path) — pass through
  if (/Use \/model/i.test(raw)) return raw;

  // Cortex auth-required when NO key was sent (not upstream OAuth / ChatGPT pool failures).
  // Narrow match: only the empty-credentials DRF/gateway responses — not generic 401/403
  // (those often mean ChatGPT Codex OAuth account issues and were mislabeled as
  // "login for Qwen/Gemma").
  if (/Authentication credentials were not provided/i.test(raw)
    || /no cortex api key|cortex api key (is )?(missing|not (set|configured))/i.test(raw)
    || (/vLLM error 401/i.test(raw) && /credentials were not provided/i.test(raw))) {
    return 'Cortex needs authentication for hosted models. Either:\n'
      + '  • /login <email> <password>           — sign in with your Shizuha ID\n'
      + '  • /config auth cortex sk-cortex-…      — paste a Cortex API key (cortex.shizuha.com → API Keys)\n'
      + 'Then resend your message.';
  }
  if (/vLLM error 401|Cortex error 401|error 401|token_not_valid|malformed jwt/i.test(raw)) {
    // Keep the raw detail — "check your API key" is often wrong when earlier
    // turns in the same session already succeeded (operator 2026-07-23).
    const detail = raw.replace(/^[\s\S]{0,40}?(vLLM error 401|Cortex error 401):\s*/i, '').slice(0, 240);
    if (/credentials were not provided|no cortex api key/i.test(raw)) {
      return 'Cortex rejected the request: no API credentials were sent. '
        + 'Use /login or /config auth cortex sk-cortex-… then resend.';
    }
    if (/signature has expired|token_not_valid/i.test(raw)) {
      return 'Cortex rejected an expired Shizuha login JWT (401 Signature has expired). '
        + 'Your sk-cortex API key is usually still fine — this is the short-lived login token going stale mid-session. '
        + 'Resend the prompt (SCLI now re-resolves auth per request and falls back to the API key). '
        + 'If it keeps failing: /login <email> <password> once to mint a fresh JWT.';
    }
    if (/token_not_valid|malformed jwt|invalid api key|incorrect api key/i.test(raw)) {
      return `Cortex rejected auth (401): ${detail || raw.slice(0, 200)}. `
        + 'If earlier turns in this session worked, try resending once. '
        + 'Only /login or /config auth cortex if the key/JWT is actually gone.';
    }
    return `HTTP 401 from provider path: ${detail || raw.slice(0, 200)}. `
      + 'Not auto-retried. Resend once; persistent → /login or check Cortex key.';
  }
  if (/vLLM error 403|Cortex error 403|error 403/i.test(raw)) {
    return 'Provider refused the request (403). Check plan/quota, model access, or OAuth account health.';
  }

  // Common known patterns → friendly messages
  if (/overloaded/i.test(raw)) return 'API is overloaded — SCLI retries indefinitely with backoff. Wait or Esc to cancel.';
  if (/rate.limit/i.test(raw)) return 'Rate limited — SCLI retries indefinitely with backoff. Wait or Esc to cancel.';
  if (/stream stalled/i.test(raw)) return 'Stream stalled (no response from API). SCLI retries with backoff; Esc to cancel.';
  if (/upstream stream timed out|upstream timed out/i.test(raw)) {
    return 'Provider stream timed out before a response finished (ChatGPT Codex / upstream). '
      + 'SCLI retries indefinitely with backoff; Esc to cancel, or try /model DeepSeek-V4-Flash / /clear.';
  }
  if (/server_error|error occurred while processing your request|help\.openai\.com/i.test(raw)) {
    return 'Upstream ChatGPT/Codex had a temporary server_error. '
      + 'SCLI retries indefinitely with backoff until it succeeds; Esc to cancel.';
  }

  return raw;
}

/**
 * AgentSession — bridge between React TUI and the agent infrastructure.
 * Wraps all agent components, exposes a simple event-based API.
 *
 * Provider resolution is deferred to submitPrompt() time so the TUI
 * can start even when no API key is configured yet.
 */
export class AgentSession extends EventEmitter {
  private config!: Awaited<ReturnType<typeof import('../config/loader.js').loadConfig>>;
  private provider: LLMProvider | null = null;
  private toolRegistry!: import('../tools/registry.js').ToolRegistry;
  private permissions!: import('../permissions/engine.js').PermissionEngine;
  private emitter!: import('../events/emitter.js').AgentEventEmitter;
  private store!: import('../state/store.js').StateStore;
  private mcpManager!: import('../tools/mcp/manager.js').MCPManager;
  private providerRegistry!: import('../provider/registry.js').ProviderRegistry;
  private hookEngine!: import('../hooks/engine.js').HookEngine;
  /** @internal exposed for TUI stall detection — shows what the agent is waiting on */
  readonly taskRegistry = new BackgroundTaskRegistry((event) => this.emit('agent_event', event));
  private toolSearchState: import('../tools/tool-search.js').ToolSearchState | null = null;
  private toolSearchEnabled = false;
  private mcpAwareness: string | undefined;
  private skillCatalog: string | undefined;
  /** Active-session system prompt anchor. Dynamic repository/MCP state is
   *  sampled once per session so subsequent requests extend the provider
   *  payload instead of rewriting its system-message prefix. */
  private systemPromptAnchor: { key: string; prompt: string } | null = null;
  private _isTurnActive = false;
  private _servedModel: string | undefined;
  private _servedContextWindow: number | undefined;

  private messages: Message[] = [];
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  /** Explicit maintenance commands have their own cancellable lifecycle. */
  private maintenanceAbortController: AbortController | null = null;
  /** Fence long resume maintenance from later sessions and unmount cleanup. */
  private resumeAbortController: AbortController | null = null;
  private resumeGeneration = 0;
  private destroyed = false;
  private pendingInputQueue: Array<{ prompt: string; images?: Array<{ base64: string; mediaType: string }> }> = [];
  private _model = '';
  private _mode: PermissionMode = 'supervised';
  private _cwd = '';
  private _totalInputTokens = 0;
  private _totalOutputTokens = 0;
  private _turnCount = 0;
  private _initialized = false;
  private _permissionCallback: PermissionAskCallback | null = null;
  private _initError: string | null = null;
  private _thinkingLevel = 'off';
  private _reasoningEffort: string | null = null;
  private _fastMode = false;
  private _ollamaModels: string[] = [];
  private _turnPromptExcerpt: string | null = null;
  /** Estimated tokens for system prompt + tool definitions (overhead not in messages) */
  private _systemOverheadTokens = 0;
  /** Last actual input_tokens from the API response — most accurate context usage.
   *  This is the real number from Anthropic's tokenizer (system + tools + messages). */
  private _lastApiInputTokens = 0;
  /** Provider-calibrated estimate used by vLLM/Cortex for its output clamp. */
  private _lastProviderPromptEstimate = 0;
  /** Uninflated estimate of the exact request that produced the provider truth. */
  private _lastReportedRawPromptTokens = 0;
  /**
   * Observed provider-tokenizer/raw ratio. This is calibration, not a context
   * position: sanitation and compaction invalidate the absolute anchor but do
   * not change how the same model tokenizes text.
   */
  private _providerTokenizerRatio = 0;
  /** Active plan file path when in plan mode */
  private _planFilePath: string | null = null;
  /** Cached plan mode utilities (loaded once during init) */
  private _planUtils: { generatePlanSlug: () => string; resolvePlanFilePath: (slug: string) => string } | null = null;
  /** One-shot resume hygiene: compact interrupted transcripts before the next model call. */
  private _forceCompactOnNextTurn: string | null = null;
  /** The next provider call follows a context rewrite, even across submitPrompt calls. */
  private _postCompactionRequestPending = false;
  private _stopShizuhaAuthAutoRefresh: (() => void) | null = null;

  get model() { return this._model; }
  get mode() { return this._mode; }
  get cwd() { return this._cwd; }
  get totalInputTokens() { return this._totalInputTokens; }
  get totalOutputTokens() { return this._totalOutputTokens; }
  get turnCount() { return this._turnCount; }
  get currentSessionId() { return this.sessionId; }
  get initialized() { return this._initialized; }
  get initError() { return this._initError; }
  get thinkingLevel() { return this._thinkingLevel; }
  get reasoningEffort() { return this._reasoningEffort; }
  get fastMode() { return this._fastMode; }
  get planFilePath() { return this._planFilePath; }

  /**
   * Materialize append-only history only when a display surface asks for it.
   * Keeping this array in the React session hook defeated the bounded
   * completed-entry window and drove long TUIs into V8's heap ceiling.
   */
  loadTranscriptMessagesForDisplay(): Message[] {
    if (!this.sessionId) return this.messages.slice();
    return this.sanitizeRecoveredTranscript(
      this.store.loadTranscriptMessages(this.sessionId),
      this._model,
    ).messages;
  }

  private isSyntheticToolResultMessage(message: Message): boolean {
    if (message.role !== 'user' || !Array.isArray(message.content)) return false;
    return message.content.some((block) => (block as { type?: string }).type === 'tool_result');
  }

  getMessagesSinceLastUserPrompt(): Message[] {
    let start = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (!message || message.role !== 'user') continue;
      if (this.isSyntheticToolResultMessage(message)) continue;
      start = i + 1;
      break;
    }
    return this.messages.slice(start);
  }

  /** Estimate current context window usage in tokens.
   *  Uses the actual API input_tokens from the last turn when available (most accurate),
   *  otherwise falls back to rough char/4 approximation with overhead.
   *  The API count includes system prompt + tools + messages as counted by Anthropic's
   *  tokenizer, which counts ~35% more than tiktoken for mixed code content. */
  get estimatedContextTokens(): number {
    return effectiveContextTokens(
      this.messages,
      this._model,
      this._systemOverheadTokens,
      this.effectiveReportedPromptTokens(),
      this.effectiveReportedRawPromptTokens(),
    );
  }

  private effectiveReportedPromptTokens(
    messages: Message[] = this.messages,
    overheadTokens = this._systemOverheadTokens,
  ): number {
    // Real usage.prompt_tokens is authoritative. The provider estimate is a
    // cold preflight guess and can be dramatically larger (live DeepSeek
    // incident: 326,049 actual vs 479,865 estimated); taking Math.max made the
    // footer lie and re-triggered compaction on the next turn.
    if (this._lastApiInputTokens > 0) return this._lastApiInputTokens;
    if (this._lastProviderPromptEstimate > 0) return this._lastProviderPromptEstimate;

    const factor = this.calibratedTokenizerFactor();
    if (factor <= 0) return 0;
    const raw = estimateTokens(messages, this._model) + overheadTokens;
    return Math.ceil(raw * factor);
  }

  private effectiveReportedRawPromptTokens(
    messages: Message[] = this.messages,
    overheadTokens = this._systemOverheadTokens,
  ): number {
    if (this._lastApiInputTokens > 0 || this._lastProviderPromptEstimate > 0) {
      return this._lastReportedRawPromptTokens;
    }
    if (this._providerTokenizerRatio > 0) {
      return estimateTokens(messages, this._model) + overheadTokens;
    }
    return 0;
  }

  private calibratedTokenizerFactor(): number {
    if (!Number.isFinite(this._providerTokenizerRatio) || this._providerTokenizerRatio <= 0) return 0;
    // Match VllmProvider's adaptive calibration: observed ratio + 5% headroom,
    // bounded so one noisy response cannot disable the fit guard or run away.
    return Math.min(
      Math.max(this._providerTokenizerRatio * 1.05, 1.0),
      Math.max(getSafetyFactor(this._model), 1.6),
    );
  }

  private clearContextTokenAnchors(clearCalibration = false): void {
    this._lastApiInputTokens = 0;
    this._lastProviderPromptEstimate = 0;
    this._lastReportedRawPromptTokens = 0;
    if (clearCalibration) this._providerTokenizerRatio = 0;
  }

  private estimateContextTokensFor(messages: Message[]): number {
    let total = this._systemOverheadTokens;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 4);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block && typeof block.text === 'string') total += Math.ceil(block.text.length / 4);
          if ('content' in block && typeof block.content === 'string') total += Math.ceil(block.content.length / 4);
          if ('rawContent' in block && typeof block.rawContent === 'string') total += Math.ceil(block.rawContent.length / 4);
          if ('encryptedContent' in block && typeof block.encryptedContent === 'string') total += Math.ceil(block.encryptedContent.length / 4);
          if ('input' in block && block.input) total += Math.ceil(JSON.stringify(block.input).length / 4);
        }
      }
    }
    return total;
  }

  private removeRegisteredMCPTools(): void {
    if (!this.toolRegistry) return;
    for (const tool of this.toolRegistry.list()) {
      if (tool.name.startsWith('mcp__')) {
        this.toolRegistry.unregister(tool.name);
      }
    }
    this.toolRegistry.unregister('ToolSearch');
    this.toolSearchState = null;
    this.toolSearchEnabled = false;
    this.mcpAwareness = undefined;
  }

  private getToolDefs(): ToolDefinition[] {
    const allDefs = this.toolRegistry.definitions();
    if (!this.toolSearchEnabled || !this.toolSearchState) return allDefs;

    return buildDeferredToolDefinitions(
      allDefs,
      this.toolSearchState,
      modelSupportsAppendOnlyToolActivation(this._model),
    );
  }

  /**
   * Install the stable ToolSearch shell before asynchronous MCP connection.
   * Otherwise a fast first prompt can leave before MCP hydration, and turn two
   * inserts ToolSearch + awareness into the cached prefix. The catalog object is
   * populated in place when connections finish, so the provider-visible tool
   * definition never changes.
   */
  private async initializeDeferredToolSearch(
    mcpConfigs: import('../agent/types.js').MCPServerConfig[],
  ): Promise<void> {
    const toolSearchConfig = this.config.mcp.toolSearch;
    if (mcpConfigs.length === 0 || toolSearchConfig.mode !== 'on') return;

    const {
      ToolSearchState,
      createToolSearchTool,
      buildConfiguredServerSummaries,
      buildAwarenessPrompt,
      modelNeedsInlineToolSchemas,
    } = await import('../tools/tool-search.js');
    const state = this.toolSearchState ?? new ToolSearchState();
    const stableServers = buildConfiguredServerSummaries(mcpConfigs);
    state.setCatalog([], stableServers);

    if (!this.toolRegistry.has('ToolSearch')) {
      this.toolRegistry.register(createToolSearchTool(state, toolSearchConfig.maxResults, {
        // Re-evaluated per call so a mid-session /model switch is respected.
        inlineSchemas: () => modelNeedsInlineToolSchemas(this._model),
      }));
    }
    this.toolSearchState = state;
    this.toolSearchEnabled = true;
    this.mcpAwareness = buildAwarenessPrompt(toolSearchConfig.awareness, state);
  }

  private async connectMCPServers(mcpConfigs: import('../agent/types.js').MCPServerConfig[]): Promise<void> {
    const { MCPManager } = await import('../tools/mcp/manager.js');
    const { registerMCPTools, createMCPResourceReadTool } = await import('../tools/mcp/bridge.js');
    const {
      ToolSearchState,
      createToolSearchTool,
      buildConfiguredServerSummaries,
      buildToolCatalog,
      buildAwarenessPrompt,
      modelNeedsInlineToolSchemas,
    } = await import('../tools/tool-search.js');

    this.mcpManager = new MCPManager();
    if (mcpConfigs.length === 0) return;

    // Do NOT race connectAll against a short global timeout.
    // MCPManager already applies per-server connect timeouts (default 90s) with
    // bounded concurrency. A TUI-level 10s race previously aborted tool
    // registration while servers were still connecting, leaving the status bar
    // stuck on "MCP unavailable: MCP connection timeout" even though Pulse/Wiki
    // etc. came up a few seconds later.
    await this.mcpManager.connectAll(mcpConfigs);
    if (this.mcpManager.failedServers.length > 0) {
      const failed = this.mcpManager.failedServers
        .map((server) => `${server.name}: ${server.error.replace(/\s+/g, ' ').slice(0, 120)}`)
        .join('; ');
      this.emitProviderStatus(
        `MCP degraded: ${failed}`,
        'mcp_degraded',
        'warning',
      );
    }
    await registerMCPTools(this.mcpManager, (h) => this.toolRegistry.register(h));
    for (const [serverName, conn] of this.mcpManager.getAll()) {
      if (conn.capabilities?.resources) {
        this.toolRegistry.register(createMCPResourceReadTool(serverName, this.mcpManager));
      }
    }
    this.mcpManager.setToolRegistry(this.toolRegistry);

    const toolSearchConfig = this.config.mcp.toolSearch;
    if (toolSearchConfig.mode !== 'off') {
      const state = this.toolSearchState ?? new ToolSearchState();
      state.setCatalog(
        buildToolCatalog(this.mcpManager.listAllTools()),
        buildConfiguredServerSummaries(mcpConfigs),
      );

      const maxContextTokens = this.effectiveMaxContextTokens(this.provider);
      this.toolSearchEnabled = toolSearchConfig.mode === 'on'
        || state.shouldAutoEnable(maxContextTokens, toolSearchConfig.autoThresholdPercent);

      if (this.toolSearchEnabled) {
        if (!this.toolRegistry.has('ToolSearch')) {
          this.toolRegistry.register(createToolSearchTool(state, toolSearchConfig.maxResults, {
            // Re-evaluated per call so a mid-session /model switch is respected.
            inlineSchemas: () => modelNeedsInlineToolSchemas(this._model),
          }));
        }
        this.toolSearchState = state;
        this.mcpAwareness = buildAwarenessPrompt(toolSearchConfig.awareness, state);
      }
    }

    const connected = this.mcpManager.getAll().size;
    if (connected > 0 && this.mcpManager.failedServers.length === 0) {
      this.emitProviderStatus(
        `MCP ready (${connected} server${connected === 1 ? '' : 's'})`,
        'mcp_ready',
        'info',
      );
    }
  }

  private connectMCPServersInBackground(mcpConfigs: import('../agent/types.js').MCPServerConfig[]): void {
    void this.connectMCPServers(mcpConfigs).catch((err) => {
      this.emitProviderStatus(
        `MCP unavailable: ${(err as Error).message}`,
        'mcp_unavailable',
        'warning',
      );
    });
  }

  async reconnectMCPWithLatestConfig(): Promise<void> {
    const { loadConfig } = await import('../config/loader.js');

    if (this.abortController) {
      // Avoid changing tool set while a turn is actively executing.
      throw new Error('Cannot reload MCP auth during an active turn');
    }

    const nextConfig = await loadConfig(this._cwd);
    const nextMcpConfigs = nextConfig.mcp.servers ?? [];

    await this.mcpManager?.disconnectAll();
    this.removeRegisteredMCPTools();

    this.config.mcp = nextConfig.mcp;
    await this.connectMCPServers(nextMcpConfigs);
    // Explicit config/auth reload is an intentional prefix boundary. Keep the
    // active prompt frozen during ordinary connection hydration; rebuild only
    // when the operator explicitly reloads MCP configuration.
    this.systemPromptAnchor = null;
  }

  async init(cwd: string, model?: string, mode?: PermissionMode): Promise<void> {
    const { loadConfig } = await import('../config/loader.js');
    const { startShizuhaAuthAutoRefresh } = await import('../config/shizuhaAuth.js');
    const { ProviderRegistry } = await import('../provider/registry.js');
    const { ToolRegistry } = await import('../tools/registry.js');
    const { registerBuiltinTools } = await import('../tools/builtin/index.js');
    const { PermissionEngine } = await import('../permissions/engine.js');
    const { AgentEventEmitter } = await import('../events/emitter.js');
    const { StateStore } = await import('../state/store.js');
    const { HookEngine } = await import('../hooks/engine.js');

    this.config = await loadConfig(cwd);
    this._stopShizuhaAuthAutoRefresh?.();
    this._stopShizuhaAuthAutoRefresh = startShizuhaAuthAutoRefresh((err) => {
      logger.debug({ err }, 'Shizuha auth auto-refresh failed');
    });
    this._cwd = cwd;
    this._model = model ?? this.config.agent.defaultModel;
    this._mode = mode ?? this.config.permissions.mode;

    this.providerRegistry = new ProviderRegistry(this.config);

    // Attempt provider resolution — non-fatal, user can /model later.
    // When model is 'auto', pin to the resolved concrete model so the
    // status bar shows the actual model and effort sync works correctly.
    try {
      const { provider, resolvedModel } = this.providerRegistry.resolveWithModel(this._model);
      this.provider = provider;
      if (this._model === 'auto' && resolvedModel !== 'auto') {
        this._model = resolvedModel;
      }
    } catch (err) {
      this._initError = (err as Error).message;
      // Don't throw — allow TUI to start. User can /model to fix.
    }

    // First-run detection: no cloud provider configured AND using auto model
    // → guide user to authenticate. Skip when user explicitly chose a model.
    if (!this.providerRegistry.hasCloudProvider() && !model) {
      this._initError =
        'No AI provider configured. Run: shizuha auth codex (free with ChatGPT account)';
    }

    this.toolRegistry = new ToolRegistry();
    registerBuiltinTools(this.toolRegistry);

    // Load skills the same way the bench/exec path does. The built-in skill
    // tools are present in TUI, but without this registry/catalog they operate
    // with degraded context compared with benchmark runs.
    try {
      const { loadSkills } = await import('../skills/loader.js');
      const { SkillRegistry } = await import('../skills/registry.js');
      const { createSkillTool } = await import('../tools/builtin/skill.js');
      const skillRegistry = new SkillRegistry();
      skillRegistry.registerAll(loadSkills(cwd, { trustProjectSkills: this.config.skills.trustProjectSkills }));
      if (skillRegistry.size > 0) {
        this.toolRegistry.register(createSkillTool(skillRegistry));
        this.skillCatalog = skillRegistry.buildCatalog(process.env['AGENT_ROLE'], process.env['AGENT_TEAM']);
      }
    } catch {
      // Skills are optional; keep TUI startup non-fatal.
    }

    // Initialize search_skills/use_skill for local TUI sessions. This mirrors
    // gateway initialization and prevents those built-ins from advertising a
    // capability that is not wired.
    try {
      const pathMod = await import('node:path');
      const { SkillSearchEngine } = await import('../skills/search-engine.js');
      const { setSkillSearchEngine } = await import('../tools/builtin/skill-search.js');
      const home = process.env['HOME'] ?? '/root';
      const skillsDirs = [
        pathMod.join(home, '.shizuha', 'skills'),
        pathMod.join(cwd, '.shizuha', 'skills'),
        '/opt/skills',
      ].filter((dir) => fs.existsSync(dir));
      if (skillsDirs.length > 0) {
        const engine = new SkillSearchEngine(skillsDirs[0]!);
        engine.load();
        for (const dir of skillsDirs.slice(1)) engine.loadFrom(dir);
        setSkillSearchEngine(engine);
      }
    } catch {
      // Skill search is optional; keep TUI startup non-fatal.
    }

    // Unregister client-side web_search when provider handles it natively
    if (this.provider?.supportsNativeWebSearch) {
      this.toolRegistry.unregister('web_search');
    }

    this.emitter = new AgentEventEmitter();
    this.store = new StateStore();
    this.hookEngine = new HookEngine(this.config.hooks?.hooks ?? []);

    // Inject store into session search tool
    const { setSearchStore } = await import('../tools/builtin/session-search.js');
    setSearchStore(this.store);

    this.permissions = new PermissionEngine(this._mode, this.config.permissions.rules, {
      persistedApprovals: this.store.loadToolApprovals(),
      onPersistApproval: (toolName: string) => this.store.saveToolApproval(toolName),
    });

    // Load plan mode utilities (always, so setMode can use them synchronously)
    const planMod = await import('../tools/builtin/plan-mode.js');
    this._planUtils = { generatePlanSlug: planMod.generatePlanSlug, resolvePlanFilePath: planMod.resolvePlanFilePath };

    // Generate plan file path if starting in plan mode
    if (this._mode === 'plan') {
      const slug = this._planUtils.generatePlanSlug();
      this._planFilePath = this._planUtils.resolvePlanFilePath(slug);
      this.permissions.setPlanFilePath(this._planFilePath);
    }

    // Wire emitter events to this EventEmitter
    this.emitter.on('*', (event: AgentEvent) => {
      this.emit('agent_event', event);
    });

    // MCP connections are optional capability hydration. Start them in the
    // background so broken/retired MCP endpoints never block model interaction.
    const mcpConfigs = this.config.mcp.servers ?? [];
    await this.initializeDeferredToolSearch(mcpConfigs);
    this.connectMCPServersInBackground(mcpConfigs);

    // Proactively refresh expired Codex tokens (non-fatal)
    try {
      const codexProvider = this.providerRegistry.get('codex');
      if (codexProvider && 'refreshExpiredTokens' in codexProvider) {
        await (codexProvider as any).refreshExpiredTokens();
        // Reinitialize providers to pick up refreshed tokens
        this.providerRegistry.reinitialize();
        if (this._initError) {
          // Re-attempt provider resolution after refresh
          try {
            const { provider, resolvedModel } = this.providerRegistry.resolveWithModel(this._model);
            this.provider = provider;
            if (this._model === 'auto' && resolvedModel !== 'auto') {
              this._model = resolvedModel;
            }
            this._initError = null;
          } catch { /* still broken — keep existing error */ }
        }
      }
    } catch { /* ignore refresh failures */ }

    // Discover local Ollama models (non-fatal, with short timeout)
    try {
      const ollamaBase = this.config.providers?.ollama?.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
      const ollamaResp = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (ollamaResp.ok) {
        const data = await ollamaResp.json() as { models?: Array<{ name: string }> };
        if (data.models && Array.isArray(data.models)) {
          this._ollamaModels = data.models.map((m) => m.name);
        }
      }
    } catch {
      // Ollama not running — ignore
    }

    // Initialize persistent agent memory (TUI uses anonymous path)
    const { setMemoryFilePath } = await import('../tools/builtin/memory.js');
    const memoryPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'MEMORY.md');
    setMemoryFilePath(memoryPath);

    this._initialized = true;
  }

  setPermissionCallback(cb: PermissionAskCallback): void {
    this._permissionCallback = cb;
  }

  /** Ensure provider is resolved before use */
  private ensureProvider(): LLMProvider {
    if (this.provider) return this.provider;
    // Try again — maybe env was set since init
    const { provider, resolvedModel } = this.providerRegistry.resolveWithModel(this._model);
    this.provider = provider;
    if (this._model === 'auto' && resolvedModel !== 'auto') {
      this._model = resolvedModel;
    }
    return this.provider;
  }

  private promptExcerpt(prompt: string): string {
    const normalized = prompt.replace(/\s+/g, ' ').trim();
    if (!normalized) return '(empty prompt)';
    return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
  }

  /** Effective context window for compaction: config can lower, but not exceed provider/model max. */
  private effectiveMaxContextTokens(provider?: LLMProvider | null): number {
    const source = provider ?? this.provider ?? undefined;
    const envWindowMode = process.env['SHIZUHA_COMPACTION_WINDOW_MODE'];
    const compactionWindowMode: CompactionWindowMode =
      (this.config.agent.compactionWindowMode
        ?? (envWindowMode === 'conservative' ? 'conservative' : 'planning')) === 'conservative'
        ? 'conservative' : 'planning';
    return resolveDynamicCompactionWindow({
      requestedModel: this.model,
      servedModel: this._servedModel,
      ...(this._servedContextWindow != null ? { servedContextWindow: this._servedContextWindow } : {}),
      source,
      configured: this.config.agent.maxContextTokens,
      mode: compactionWindowMode,
    });
  }

  private upsertInterruptCheckpoint(note: string, kind: 'turn' | 'maintenance' = 'turn'): void {
    if (!this.sessionId) return;
    this.store.saveInterruptCheckpoint(this.sessionId, {
      createdAt: Date.now(),
      promptExcerpt: this._turnPromptExcerpt ?? '(unknown prompt)',
      note,
      kind,
    });
  }

  findToolInput(toolCallId: string): Record<string, unknown> | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as { type?: string; id?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use' && b.id === toolCallId && b.input && typeof b.input === 'object') {
          return JSON.parse(JSON.stringify(b.input)) as Record<string, unknown>;
        }
      }
    }
    return null;
  }

  private emitReasoningStatus(text: string): void {
    this.emit('agent_event', {
      type: 'reasoning',
      summaries: [text],
      timestamp: Date.now(),
    });
  }

  private emitProviderStatus(message: string, code: string, level: 'info' | 'warning' = 'info'): void {
    this.emit('agent_event', {
      type: 'provider_status',
      message,
      level,
      code,
      timestamp: Date.now(),
    });
  }

  private sanitizeRecoveredTranscript(messages: Message[], modelName = this._model): { messages: Message[]; removed: number } {
    const sanitized: Message[] = [];
    let removed = 0;
    const modelProfile = getModelProfile(modelName);

    for (const message of messages) {
      if (isInternalRecoveryPrompt(message)) {
        removed++;
        continue;
      }

      if (isEmptyAssistantMessage(message)) {
        removed++;
        continue;
      }

      if (message.role === 'assistant'
        && !modelProfile.supportsThinking
        && !hasVisibleAssistantText(message.content)
        && reasoningTextFromContent(message.content).length > 0) {
        removed++;
        continue;
      }

      if (message.role === 'assistant') {
        const visible = visibleTextFromContent(message.content);
        const ownsToolCall = Array.isArray(message.content)
          && message.content.some((block) => block.type === 'tool_use');
        // Drop pure chatter-guard stop notices from outbound context so the
        // model does not echo the diagnostic or treat it as prior work.
        if (!ownsToolCall && isDegeneracyStopNotice(visible)) {
          removed++;
          continue;
        }
        if (!ownsToolCall && detectOutputDegeneracy(visible).degenerate) {
          removed++;
          continue;
        }
      }

      sanitized.push(message);
    }

    return { messages: sanitized, removed };
  }

  private hasRecentToolResult(): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (!message) continue;
      if (message.role === 'user' && Array.isArray(message.content)) {
        if (message.content.some((block) => block.type === 'tool_result')) return true;
        continue;
      }
      if (isInternalRecoveryPrompt(message) || isEmptyAssistantMessage(message)) {
        continue;
      }
      if (message.role === 'user') return false;
    }
    return false;
  }

  private async runCompactionWithHeartbeat(
    compactMessagesFn: CompactMessagesFn,
    provider: LLMProvider,
    maxContextTokens: number,
    options: { force?: boolean; customInstructions?: string; abortSignal?: AbortSignal; overheadTokens?: number; planFilePath?: string; sessionId?: string; allowNonReducing?: boolean } | undefined,
    phase: 'pre-turn' | 'overflow-recovery' | 'post-turn' | 'resume' | 'manual',
  ): Promise<{ messages: Message[]; compacted: boolean }> {
    const startedAt = Date.now();
    // SCLI-389: automatic maintenance has a deadline so a multi-MB @file prefill
    // cannot silently pin an agent turn. An explicit /compact is different: it
    // is a mandatory, user-owned operation and remains active until it succeeds,
    // fails permanently, or the user cancels it. Its provider request still has
    // the normal provider stall budget, and maintenanceAbortController makes Esc
    // effective; elapsed time is never authority to report a forced command as
    // "skipped".
    const deadlineRaw = parseInt(process.env['SHIZUHA_COMPACTION_DEADLINE_MS'] || '', 10);
    // 2026-08-09 fleet incident: the old FLAT 90s default aborted every
    // attempt to compact a 361K-token session (its prefill alone needs
    // minutes on any lane), so the session could never compact, every turn
    // re-triggered it, and the retry loop threw a fresh ~361K cold prefill
    // at the fleet every ~90s for 40 minutes — decode throughput on all
    // three engines collapsed under the grind. A compaction deadline must
    // scale with the prompt it has to prefill (same conservative floor rate
    // as the provider's first-token budget): completing ONCE and caching is
    // strictly cheaper than aborting guaranteed-to-retry work forever.
    // Floor 90s for small sessions; cap 900s (the headless first-token
    // patience); env override wins when set.
    const promptTokensForDeadline = estimateTokens(this.messages, this._model);
    const scaledDeadlineMs = Math.min(
      900_000,
      Math.max(90_000, Math.ceil((promptTokensForDeadline / 150) * 1000) + 60_000),
    );
    const automaticDeadlineMs = Number.isFinite(deadlineRaw) && deadlineRaw >= 0
      ? deadlineRaw
      : scaledDeadlineMs;
    const deadlineMs = phase === 'manual' ? 0 : automaticDeadlineMs;
    this.emitProviderStatus(
      phase === 'manual'
        ? 'Compacting context (manual)...'
        : `Compacting context (${phase}) before model call...`,
      `compaction_${phase}_start`,
    );
    this.upsertInterruptCheckpoint(`Compacting context (${phase})...`, 'maintenance');
    // Live progress from the streaming summary call (null until the first token —
    // i.e. during the prompt prefill, which can dominate on long conversations).
    let lastProgress: CompactionProgress | null = null;
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks++;
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const msg = renderCompactionStatus(
        phase, seconds, lastProgress,
        // Prefill-time estimate at the same conservative floor rate the
        // deadline uses (prompt/150 tok/s) — but never promise longer than
        // the deadline allows (a 545K resume showed "~40m expected" while
        // the deadline would abort at 15m).
        deadlineMs > 0
          ? Math.min(Math.ceil(promptTokensForDeadline / 150), Math.ceil(deadlineMs / 1000))
          : Math.ceil(promptTokensForDeadline / 150),
      );
      this.emitProviderStatus(msg, `compaction_${phase}_heartbeat`);
      // Checkpoint at a coarser cadence (every 15s) — these persist; the status line
      // updates every second for a smooth bar.
      if (ticks % 15 === 0) this.upsertInterruptCheckpoint(msg, 'maintenance');
    }, 1000);
    heartbeat.unref?.();

    // Nested controller so the deadline can abort the provider call without
    // permanently aborting the outer turn controller (user may still want to
    // continue after a timed-out compaction).
    const deadlineController = new AbortController();
    const onOuterAbort = () => {
      try { deadlineController.abort(options?.abortSignal?.reason ?? new Error('Interrupted')); } catch { /* ignore */ }
    };
    if (options?.abortSignal) {
      if (options.abortSignal.aborted) onOuterAbort();
      else options.abortSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        try {
          deadlineController.abort(new Error(
            `SCLI-389 compaction deadline exceeded (${deadlineMs}ms, phase=${phase})`,
          ));
        } catch { /* ignore */ }
      }, deadlineMs);
      deadlineTimer.unref?.();
    }

    try {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error('Interrupted');
      }
      const result = await compactMessagesFn(
        this.messages,
        provider,
        this._model,
        maxContextTokens,
        {
          ...options,
          // Compaction is a rewrite of THIS session's warm prefix. Without the
          // affinity key Cortex may send a 400K+ summary prefill to a cold lane.
          sessionId: options?.sessionId ?? this.sessionId ?? undefined,
          abortSignal: deadlineController.signal,
          onProgress: (p) => { lastProgress = p; },
        },
      );
      // A provider may finish after ignoring cancellation. Do not publish a
      // stale completion/checkpoint for maintenance that no longer owns the
      // active session; the caller also fences the eventual state mutation.
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error('Compaction superseded');
      }
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      if (result.compacted) {
        this.emitProviderStatus(
          phase === 'manual'
            ? `Context compaction complete (manual) in ${seconds}s.`
            : `Context compaction complete (${phase}) in ${seconds}s; calling model next...`,
          `compaction_${phase}_complete`,
        );
        this.upsertInterruptCheckpoint(`Context compaction complete (${phase}) in ${seconds}s`, 'maintenance');
      } else {
        if (phase === 'manual') {
          throw new Error('Manual compaction returned without rewriting the context');
        }
        this.emitProviderStatus(`Context compaction did not commit (${phase}) in ${seconds}s; retrying maintenance...`, `compaction_${phase}_retry`);
        this.upsertInterruptCheckpoint(`Context compaction did not commit (${phase}) in ${seconds}s; retrying`, 'maintenance');
      }
      return result;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      const isDeadline = deadlineMs > 0 && (
        /compaction deadline exceeded/i.test(msg)
        || (deadlineController.signal.aborted && !options?.abortSignal?.aborted)
      );
      if (isDeadline) {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        logger.warn(
          { sessionId: this.sessionId, phase, deadlineMs, seconds, err: msg },
          'SCLI-389 compaction deadline exceeded — continuing without rewrite',
        );
        this.emitProviderStatus(
          `Context compaction timed out (${phase}) after ${seconds}s; retrying before any model call...`,
          `compaction_${phase}_deadline`,
        );
        this.upsertInterruptCheckpoint(`Context compaction timed out (${phase}) after ${seconds}s`, 'maintenance');
        // Leave transcript intact. Required call sites re-check the threshold
        // and retry; they must never fall through to a model call.
        return { messages: this.messages, compacted: false };
      }

      // A compaction request is maintenance for the current agent turn. The
      // provider already performs its bounded in-request retries, but an
      // exhausted transient response (for example Cortex's fleet-wide
      // compaction-serialization 503) used to escape this wrapper. Pre-turn and
      // post-turn compaction both sit outside executeTurn's indefinite provider
      // retry loop, so that escape marked the whole turn complete and returned
      // the TUI to idle immediately after a successful tool call.
      //
      // Keep permanent failures (auth/policy/bad request) fail-loud. For a
      // transient provider failure, preserve the transcript and keep the model
      // gate closed until a later maintenance attempt commits the rewrite.
      const { isTransientProviderFailure, summarizeFailureReason } = await import('../provider/transient-errors.js');
      const status = (err as { status?: number }).status;
      const code = (err as { code?: string | number }).code;
      const retryable = (err as { retryable?: boolean }).retryable;
      if (isTransientProviderFailure({ message: msg, code, status, retryable })) {
        const reason = summarizeFailureReason(msg);
        if (phase === 'manual') {
          logger.warn(
            { sessionId: this.sessionId, phase, status, code, err: msg },
            'Transient manual compaction failure — explicit command will retry',
          );
          throw err;
        }
        logger.warn(
          { sessionId: this.sessionId, phase, status, code, err: msg },
          'Transient compaction provider failure — retaining history and retrying maintenance',
        );
        const notice = `Context compaction temporarily unavailable (${phase})`
          + `${reason ? `: ${reason}` : ''}; retrying before any model call...`;
        this.emitProviderStatus(notice, `compaction_${phase}_transient_skip`);
        this.upsertInterruptCheckpoint(notice, 'maintenance');
        return { messages: this.messages, compacted: false };
      }
      throw err;
    } finally {
      clearInterval(heartbeat);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (options?.abortSignal) {
        options.abortSignal.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  /**
   * Enforce compaction as a provider-call invariant.
   *
   * Every completed assistant/tool round is a sub-turn boundary. Tool output can
   * push the transcript across the threshold inside one outer user request, so
   * checking only before/after submitPrompt is insufficient. The next ordinary
   * provider call remains blocked until provider-backed semantic compaction has
   * committed a projection below the invariant.
   */
  private async enforceRequiredCompaction(
    maxContextTokens: number,
    options: { customInstructions?: string; abortSignal?: AbortSignal; overheadTokens?: number; planFilePath?: string } | undefined,
    phase: 'pre-turn' | 'overflow-recovery' | 'post-turn' | 'resume',
    isRequired: () => boolean,
    forceOnce = false,
  ): Promise<{ compacted: boolean; attempts: number }> {
    let compacted = false;
    let attempts = 0;
    let mustRun = forceOnce;

    while (mustRun || isRequired()) {
      mustRun = false;
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error('Interrupted');
      }
      attempts++;
      const beforeTokens = estimateTokens(this.messages, this._model)
        + (options?.overheadTokens ?? 0);
      // Only provider-backed semantic compaction is legal here. A timeout or
      // transient serialization response retains the old projection and loops;
      // a permanent/quality failure throws without rewriting history.
      const { compactMessages } = await import('../state/compaction.js');
      const provider = this.ensureProvider();
      const result = await this.runCompactionWithHeartbeat(
        compactMessages,
        provider,
        maxContextTokens,
        {
          force: true,
          customInstructions: options?.customInstructions,
          overheadTokens: options?.overheadTokens,
          planFilePath: options?.planFilePath,
          abortSignal: options?.abortSignal,
          sessionId: this.sessionId ?? undefined,
        },
        phase,
      );

      if (!result.compacted) {
        const retryDelayMs = Math.min(5_000, 250 * (2 ** Math.min(attempts - 1, 5)));
        await new Promise<void>((resolve, reject) => {
          const signal = options?.abortSignal;
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('Interrupted'));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, retryDelayMs);
          timer.unref?.();
          if (!signal) return;
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
        continue;
      }

      // Some provider implementations do not reject immediately when their
      // signal is aborted. Fence the mutation after the await as well: a late
      // compaction result must never overwrite a superseding resume/turn.
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error('Compaction superseded');
      }
      this.messages.length = 0;
      this.messages.push(...result.messages);
      if (this.sessionId) this.store.replaceMessages(this.sessionId, result.messages);
      this.clearContextTokenAnchors();
      compacted = true;
      const afterTokens = estimateTokens(this.messages, this._model)
        + (options?.overheadTokens ?? 0);
      this.emitProviderStatus(
        `Context compacted (${phase}): ~${beforeTokens} → ~${afterTokens} tokens.`,
        `compaction_${phase}_complete`,
      );
      if (!isRequired()) break;
      if (afterTokens >= beforeTokens) {
        throw new Error(`Semantic compaction made no progress (${beforeTokens} -> ${afterTokens} tokens)`);
      }
    }

    return { compacted, attempts };
  }

  /** Submit a user prompt — runs the full multi-turn agent loop */
  async submitPrompt(prompt: string, images?: Array<{ base64: string; mediaType: string }>): Promise<void> {
    if (!this._initialized) throw new Error('Session not initialized');
    if (this.resumeAbortController) {
      this.emit('agent_event', {
        type: 'error',
        error: 'Cannot submit while session resume is still reconciling context.',
        timestamp: Date.now(),
      });
      this.emit('agent_event', {
        type: 'complete', totalTurns: 0,
        totalInputTokens: this._totalInputTokens, totalOutputTokens: this._totalOutputTokens,
        totalDurationMs: 0, timestamp: Date.now(),
      });
      return;
    }
    if (this.maintenanceAbortController) {
      throw new Error('Cannot submit a prompt while manual compaction is running');
    }

    if (this.sessionId && this.messages.length > 0) {
      const sanitized = this.sanitizeRecoveredTranscript(this.messages);
      if (sanitized.removed > 0) {
        this.messages = sanitized.messages;
        this.store.replaceMessages(this.sessionId, sanitized.messages);
        this.clearContextTokenAnchors();
        logger.info({ sessionId: this.sessionId, removed: sanitized.removed }, 'Sanitized internal recovery messages before TUI turn');
      }
    }

    let provider: LLMProvider;
    try {
      provider = this.ensureProvider();
    } catch (err) {
      this.emit('agent_event', {
        type: 'error',
        error: `Cannot submit: ${(err as Error).message}. Use /model to switch to a configured model.`,
        timestamp: Date.now(),
      });
      this.emit('agent_event', {
        type: 'complete', totalTurns: 0,
        totalInputTokens: this._totalInputTokens, totalOutputTokens: this._totalOutputTokens,
        totalDurationMs: 0, timestamp: Date.now(),
      });
      return;
    }

    const { executeTurn } = await import('../agent/turn.js');
    const { buildSystemPrompt } = await import('../prompt/builder.js');
    const { estimateOverheadTokens } = await import('../prompt/context.js');
    const { estimatePromptTokenBudget } = await import('../agent/heartbeat-hygiene.js');

    // Cortex/vLLM context metadata is deployment state, not a client constant.
    // Refresh it before persisting the user prompt or making any compaction /
    // trimming decision. If metadata is unavailable, preserve the transcript
    // byte-for-byte and let the user retry rather than guessing a window.
    const providerDiscovery = provider as unknown as {
      getServedModel?: (
        preferredModel?: string,
        options?: { forceRefresh?: boolean },
      ) => Promise<string | undefined>;
    };
    if (typeof providerDiscovery.getServedModel === 'function') {
      let servedModel: string | undefined;
      try {
        servedModel = await providerDiscovery.getServedModel(
          this._model,
          { forceRefresh: true },
        );
      } catch (err) {
        logger.debug({ err, model: this._model }, 'TUI context-window refresh failed');
      }
      if (!servedModel) {
        this.emit('agent_event', {
          type: 'error',
          error: `Cannot submit safely: ${this._model} is missing from live provider metadata. No transcript content was changed; retry when /v1/models is healthy.`,
          timestamp: Date.now(),
        });
        this.emit('agent_event', {
          type: 'complete', totalTurns: 0,
          totalInputTokens: this._totalInputTokens, totalOutputTokens: this._totalOutputTokens,
          totalDurationMs: 0, timestamp: Date.now(),
        });
        return;
      }
    }

    // Create session if needed
    if (!this.sessionId) {
      const session = this.store.createSession(this._model, this._cwd);
      this.sessionId = session.id;
      this.messages = [];
      this._totalInputTokens = 0;
      this._totalOutputTokens = 0;
      this.clearContextTokenAnchors(true);
      this._turnCount = 0;
      this.emit('agent_event', {
        type: 'session_start', sessionId: this.sessionId,
        model: this._model, timestamp: Date.now(),
        planFilePath: this._mode === 'plan' ? this._planFilePath ?? undefined : undefined,
      });
    }

    // Extract @file mentions and prepend file contents (SCLI-389: hard size bounds).
    // Unbounded full-file inlining of multi-MB attachments forces pre-turn
    // compaction into a multi-minute "reading conversation" prefill with no
    // recovery path — cap per-file and total inline budget instead.
    let expandedPrompt = prompt;
    const mentionRegex = /@([\w.\/\-]+)/g;
    let mentionMatch;
    const fileContextParts: string[] = [];
    let remainingInlineBudget = maxTotalInlineFileChars();
    const seenMentionPaths = new Set<string>();
    while ((mentionMatch = mentionRegex.exec(prompt)) !== null) {
      const filePath = mentionMatch[1]!;
      const resolved = path.resolve(this._cwd, filePath);
      if (seenMentionPaths.has(resolved)) continue;
      seenMentionPaths.add(resolved);
      const loaded = loadInlineFileForMention(resolved, remainingInlineBudget);
      if (loaded.skipped && !loaded.block) continue;
      if (loaded.block) {
        fileContextParts.push(loaded.block);
        // Charge the original size against the budget so subsequent mentions
        // still see a shrinking remaining allowance even when we truncated.
        remainingInlineBudget = Math.max(0, remainingInlineBudget - loaded.originalChars);
        if (loaded.truncated || loaded.skipped) {
          logger.info(
            {
              sessionId: this.sessionId,
              path: resolved,
              originalChars: loaded.originalChars,
              truncated: loaded.truncated,
              skipped: loaded.skipped,
              reason: loaded.reason,
              remainingInlineBudget,
            },
            'SCLI-389 bounded @file mention inline',
          );
        }
      }
    }
    if (fileContextParts.length > 0) {
      expandedPrompt = fileContextParts.join('\n\n') + '\n\n' + prompt;
    }

    // Append user message — include images if provided
    let userContent: string | Array<{ type: string; text?: string; source?: { type: string; data: string; media_type: string } }> = expandedPrompt;
    if (images && images.length > 0) {
      const blocks: Array<{ type: string; text?: string; source?: { type: string; data: string; media_type: string } }> = [];
      for (const img of images) {
        blocks.push({ type: 'image', source: { type: 'base64', data: img.base64, media_type: img.mediaType } });
      }
      blocks.push({ type: 'text', text: expandedPrompt });
      userContent = blocks;
    }
    const userMsg: Message = { role: 'user', content: userContent as string, timestamp: Date.now() };
    this.messages.push(userMsg);
    this.store.appendMessage(this.sessionId, userMsg);

    // Keep the interactive TUI aligned with the bench/exec path: model profiles
    // control prompt shape, tool catalog inclusion, and provider-specific setup.
    const { getModelProfile } = await import('../provider/model-profile.js');
    const modelProfile = getModelProfile(this._model);

    const maxContextTokens = this.effectiveMaxContextTokens(provider);

    let toolDefs = this.getToolDefs();
    const systemPromptKey = JSON.stringify({
      sessionId: this.sessionId,
      cwd: this._cwd,
      provider: provider.name,
      model: this._model,
      mode: this._mode,
      planFilePath: this._planFilePath,
      deferredMcpTools: this.toolSearchEnabled,
    });
    let systemPrompt: string;
    if (this.systemPromptAnchor?.key === systemPromptKey) {
      systemPrompt = this.systemPromptAnchor.prompt;
    } else {
      systemPrompt = await buildSystemPrompt({
        cwd: this._cwd,
        tools: toolDefs,
        provider: provider.name,
        model: this._model,
        contextWindow: maxContextTokens,
        mode: this._mode,
        planFilePath: this._planFilePath ?? undefined,
        mcpAwareness: this.mcpAwareness,
        deferredMcpTools: this.toolSearchEnabled,
        skillCatalog: this.skillCatalog,
      });
      this.systemPromptAnchor = { key: systemPromptKey, prompt: systemPrompt };
    }

    // Sandbox config: apply if mode is not 'unrestricted'
    const sandboxConfig = this.config.sandbox;
    const sandbox = sandboxConfig?.mode !== 'unrestricted' ? sandboxConfig : undefined;

    const toolContext: ToolContext = {
      cwd: this._cwd,
      sessionId: this.sessionId,
      planFilePath: this._planFilePath ?? undefined,
      taskRegistry: this.taskRegistry,
      sandbox,
    };
    const maxTurns = this.config.agent.maxTurns ?? INTERACTIVE_DEFAULT_MAX_TURNS;
    const maxOutputTokens = modelProfile.recommendedMaxOutputTokens ?? this.config.agent.maxOutputTokens;
    const temperature = modelProfile.defaultTemperature === null
      ? undefined
      : (modelProfile.defaultTemperature ?? this.config.agent.temperature);

    let adaptToolResultFn: ((toolName: string, content: string, input: Record<string, unknown>, metadata?: Record<string, unknown>, isError?: boolean) => string) | undefined;
    let coerceToolParamsFn: ((input: Record<string, unknown>) => Record<string, unknown>) | undefined;
    if (modelProfile.toolResponseFormat || modelProfile.coerceToolParams) {
      const { adaptToolResult, coerceToolParams } = await import('../provider/tool-response-adapter.js');
      if (modelProfile.toolResponseFormat) {
        adaptToolResultFn = (toolName, content, input, metadata, isError) =>
          adaptToolResult(modelProfile.toolResponseFormat, toolName, content, input, metadata, isError);
      }
      if (modelProfile.coerceToolParams) {
        coerceToolParamsFn = coerceToolParams;
      }
    }

    // Estimate system prompt + tool definition overhead (constant for this turn).
    // This is critical for accurate compaction timing — without it, the status bar
    // underreports usage and compaction triggers too late (e.g., 78% shown but 100% actual).
    this._systemOverheadTokens = estimateOverheadTokens(systemPrompt, toolDefs, this._model);

    this.abortController = new AbortController();
    this._turnPromptExcerpt = this.promptExcerpt(prompt);
    this.upsertInterruptCheckpoint('Turn started. Progress may be incomplete until this turn finishes.');

    // Continuation logic:
    // - Has tool_use → execute tools, continue
    // - max_tokens / transport salvage → explicit incomplete terminal, no replay
    // - No tool_use (text-only or reasoning-only) → STOP immediately
    const MAX_TRUNCATION_RECOVERY = 3;
    const MAX_EMPTY_TOOL_RESULT_RECOVERY = 1;
    const MAX_NON_THINKING_REASONING_RECOVERY = 1;
    const MAX_PROGRESS_ONLY_RECOVERY = 2;
    // One auto-retry after a chatter-guard stop: the spin was real, but going
    // idle forces the operator to re-prompt. A single forced tool call is enough
    // to unstick dojo/verify work without letting infinite plan-loops resume.
    const MAX_DEGENERACY_RECOVERY = 2;
    let truncationRecoveryCount = 0;
    let emptyToolResultRecoveryCount = 0;
    let nonThinkingReasoningRecoveryCount = 0;
    let progressOnlyRecoveryCount = 0;
    let degeneracyRecoveryCount = 0;
    let interrupted = false;
    let hadError = false;
    let lastFailureMessage: string | null = null;
    let previousToolSignature: string | null = null;
    let repeatedToolSignatureCount = 0;
    // Error-streak: consecutive turns whose tool calls error out. Catches diffuse
    // flailing the byte-identical guard misses (many different calls, all failing).
    // Forcing nudge at NUDGE_AT; resets the moment a tool call succeeds or the model answers.
    let erroredTurnStreak = 0;
    let errorNudgedAt = 0;

    let turnIndex = 0;
    // A rewrite performed after one assistant/tool round belongs to the NEXT
    // provider call. Keep the marker across loop iterations; a block-local
    // variable used to reset it before that call and lost Cortex's warmup hint.
    let pendingProviderRequestKind = this._postCompactionRequestPending
      ? 'post_compaction'
      : undefined;
    this._postCompactionRequestPending = false;

    // Cumulative provider stall for THIS prompt, spanning every sub-turn of the
    // agentic loop. The per-`executeTurn` retry counter below restarts at 0 for
    // each sub-turn, so on its own it reported "attempt 1" again a few minutes
    // into an outage and hid how long the prompt had really been blocked
    // (shizuha1 sat >10min on Cortex 503s showing a 3s-old counter, 2026-08-03).
    // Reset only when a turn actually completes.
    let stallStartedAt = 0;
    let stallAttempts = 0;
    const noteStallRetry = (): { attempt: number; elapsedMs: number } => {
      const now = Date.now();
      if (!stallStartedAt) stallStartedAt = now;
      stallAttempts += 1;
      return { attempt: stallAttempts, elapsedMs: now - stallStartedAt };
    };
    const clearStall = () => { stallStartedAt = 0; stallAttempts = 0; };

    // SCLI-32 (review P2-4): wire the struggle analyzer + SCLI-33 auto-filer for
    // this interactive run. Per-run telemetry window (session-scoped runId with a
    // unique suffix so resumed runs don't collapse in dedup — P2-5); STALL armed
    // per turn, completed-turn heuristics off the window. Best-effort; never
    // breaks the interactive loop.
    const struggleRunId = `${this.sessionId ?? 'tui'}#${randomUUID().slice(0, 8)}`;
    const struggleWindow = new TurnTelemetryWindow();
    const struggleAnalyzer = new StruggleAnalyzer(this.emitter, struggleWindow, {
      runId: struggleRunId,
    });
    const { unsub: struggleAutoFilerUnsub, flush: struggleAutoFilerFlush } =
      setupStrugglePulseAutoFiler(
        this.emitter as unknown as Parameters<typeof setupStrugglePulseAutoFiler>[0],
      );

    // Outer loop allows re-entering the turn loop after catch-block injection
    // (e.g., abort propagated through compaction/retry instead of executeTurn's graceful path)
    // eslint-disable-next-line no-labels
    this._isTurnActive = true;
    injection_loop: while (true) { try {
      while (!maxTurns || turnIndex < maxTurns) {
        // Check abort — but if there's pending user input, it was a soft abort (instant injection)
        if (this.abortController.signal.aborted) {
          // Soft abort (explicit interrupt-and-inject): deliver the queued
          // message and continue. A bare abort with nothing queued is a real
          // interrupt and ends the run.
          if (this.drainQueuedInput()) {
            // Reset abort controller for continuation
            this.abortController = new AbortController();
            // fall through to next turn
          } else {
            interrupted = true;
            break;
          }
        }

        // Pre-turn compaction — MUST keep the next provider call inside the
        // backend window. Overflow-recovery is last-resort only (operator 2026-07-24).
        // When resuming an interrupted transcript, force one compaction even if
        // the token estimate is below threshold; the issue is often semantic
        // pollution from a bad partial turn rather than raw context size.
        // PLAT-4189: tag the first interactive call after a rewrite as expected-cold.
        let postCompactionRequestKind = pendingProviderRequestKind;
        pendingProviderRequestKind = undefined;
        this._postCompactionRequestPending = false;
        const forceResumeCompaction = this._forceCompactOnNextTurn;
        if (forceResumeCompaction) this._forceCompactOnNextTurn = null;
        const preflightGuardTokens = resolveTuiPreflightGuardTokens(maxContextTokens);
        const preflightOutputReserve = Math.max(512, Math.min(maxOutputTokens, 16_384));
        const contextWindowCeiling = maxContextTokens - preflightOutputReserve - preflightGuardTokens;
        const preflightCeiling = resolveTuiPreflightCeilingTokens(
          maxContextTokens,
          preflightOutputReserve,
          preflightGuardTokens,
        );
        const effectiveReportedPromptTokens = this.effectiveReportedPromptTokens();
        // SCLI-182: gate on the real last-turn prompt_tokens (this._lastApiInputTokens)
        // when available, not the tiktoken×1.45 guess that fired cortex compaction at
        // ~48% of the true window. Matches the post-turn check and the status-bar %,
        // both of which already prefer _lastApiInputTokens.
        const needsPreTurnCompact = needsCompaction(
          this.messages,
          maxContextTokens,
          this._model,
          this._systemOverheadTokens,
          preflightOutputReserve,
          effectiveReportedPromptTokens,
          this.effectiveReportedRawPromptTokens(),
          preflightGuardTokens,
        );
        if (forceResumeCompaction || needsPreTurnCompact) {
          // This is a pre-MODEL-CALL invariant, not merely an outer user-turn
          // hook. The loop returns here after every assistant/tool round.
          const required = () => needsCompaction(
            this.messages,
            maxContextTokens,
            this._model,
            this._systemOverheadTokens,
            preflightOutputReserve,
            this.effectiveReportedPromptTokens(),
            this.effectiveReportedRawPromptTokens(),
            preflightGuardTokens,
          );
          const { compacted: didCompact } = await this.enforceRequiredCompaction(
            maxContextTokens,
            {
              customInstructions: forceResumeCompaction
                ? 'The previous interactive turn was interrupted. Preserve the user request, completed tool observations, and current repository state, but discard repeated failed tool attempts and stale partial-turn momentum.'
                : undefined,
              abortSignal: this.abortController?.signal,
              overheadTokens: this._systemOverheadTokens,
              planFilePath: this._planFilePath ?? undefined,
            },
            'pre-turn',
            required,
            Boolean(forceResumeCompaction),
          );
          if (didCompact) {
            // PLAT-4189: first interactive call after compaction is expected-cold.
            postCompactionRequestKind = 'post_compaction';
          }
        }

        if (this.toolSearchEnabled) {
          const newToolDefs = this.getToolDefs();
          if (newToolDefs.length !== toolDefs.length) {
            toolDefs = newToolDefs;
            this._systemOverheadTokens = estimateOverheadTokens(systemPrompt, toolDefs, this._model);
          }
        }

        // Hard pre-provider fit check. The responsive ceiling is only a latency
        // signal; do not rewrite history just because a 262K/1M window prompt is
        // above the interactive comfort target. Trimming is reserved for the true
        // backend fit ceiling.
        let promptBudget = estimatePromptTokenBudget({
          messages: this.messages,
          systemPrompt,
          toolDefs,
          model: this._model,
          reportedPromptTokens: this.effectiveReportedPromptTokens(),
          reportedRawEstimateTokens: this.effectiveReportedRawPromptTokens(),
        });
        if (promptBudget.promptTokenEstimate > preflightCeiling
          && promptBudget.promptTokenEstimate <= contextWindowCeiling) {
          logger.warn(
            { sessionId: this.sessionId, promptBudget, maxContextTokens, contextWindowCeiling, preflightCeiling },
            'TUI prompt exceeded responsive latency budget but still preserving append-only context',
          );
          this.emit('agent_event', {
            type: 'provider_status',
            code: 'responsive_budget_exceeded',
            level: 'warning',
            provider: provider.name,
            message: `Prompt is above the interactive responsive budget (${promptBudget.promptTokenEstimate}/${preflightCeiling} tokens) but below the backend context window; preserving full append-only context for KV continuity.`,
            sessionId: this.sessionId,
            timestamp: Date.now(),
          });
        }
        if (promptBudget.promptTokenEstimate > contextWindowCeiling) {
          throw new Error(
            `Semantic compaction invariant failed before provider call (${promptBudget.promptTokenEstimate}/${contextWindowCeiling} input tokens); history was preserved`,
          );
        }

        this.emit('agent_event', { type: 'turn_start', turnIndex, timestamp: Date.now() });
        const turnStart = Date.now();
        // SCLI-32: arm the STALL idle timer before the provider call (review P1) —
        // a pre-stream hang trips STALL even with no content/tool event.
        try { struggleAnalyzer.onTurnStart(); } catch { /* best-effort */ }

        // SCLI-32 (review P2-3): wrap the permission callback so STALL is suspended
        // while awaiting user approval — no AgentEventEmitter activity fires during
        // the approval pause, so without this the 90s STALL timer fires on a normal
        // approval wait. onTurnStart() re-arms once the user responds.
        const permCallbackForTurn = this._permissionCallback
          ? async (...args: Parameters<NonNullable<typeof this._permissionCallback>>) => {
              try { struggleAnalyzer.suspendStall(); } catch { /* best-effort */ }
              try {
                return await this._permissionCallback!(...args);
              } finally {
                try { struggleAnalyzer.onTurnStart(); } catch { /* best-effort */ }
              }
            }
          : undefined;

        // Retry transient API errors at the session level — indefinitely with
        // exponential backoff (operator 2026-07-23). Only non-transient errors
        // or user abort end the turn.
        let result: Awaited<ReturnType<typeof executeTurn>>;
        let providerRequestRawPromptTokens = 0;
        let recoveredFromContextOverflow = false;
        for (let retryAttempt = 0; ; retryAttempt++) {
          try {
            result = await executeTurn(
              this.messages, provider, this._model, systemPrompt, toolDefs,
              this.toolRegistry, this.permissions, this.emitter, toolContext,
              maxOutputTokens, temperature, permCallbackForTurn,
              this.hookEngine, this._thinkingLevel,
              this.abortController?.signal,
              this._reasoningEffort ?? undefined,
              this._fastMode,
              coerceToolParamsFn,
              undefined,
              {
                contextWindow: maxContextTokens,
                inputTokenEstimate: promptBudget.promptTokenEstimate,
                ...(postCompactionRequestKind ? { requestKind: postCompactionRequestKind } : {}),
                observe: (snapshot: ProviderPrefixSnapshot) => {
                  const previous = typeof this.store.loadProviderPrefixSnapshot === 'function'
                    ? this.store.loadProviderPrefixSnapshot(this.sessionId!)
                    : null;
                  const continuity = compareProviderPrefixSnapshots(previous, snapshot);
                  if (typeof this.store.saveProviderPrefixSnapshot === 'function') {
                    this.store.saveProviderPrefixSnapshot(this.sessionId!, snapshot);
                  }
                  const log = continuity.cacheBreaking ? logger.warn.bind(logger) : logger.info.bind(logger);
                  log(
                    { sessionId: this.sessionId, model: this._model, continuity, ...providerPrefixContinuityLogFields(continuity) },
                    providerPrefixContinuityLogMessage(continuity),
                  );
                  return continuity;
                },
              },
            );
            if (stallAttempts > 0) {
              const { formatStallDuration } = await import('../provider/transient-errors.js');
              this.emit('agent_event', {
                type: 'provider_status',
                code: 'provider_retry_recovered',
                level: 'info',
                message: `Provider recovered after ${formatStallDuration(Date.now() - stallStartedAt)}`
                  + ` (${stallAttempts} attempts)`,
                timestamp: Date.now(),
              } as never);
            }
            clearStall();
            break; // Success
          } catch (turnErr) {
            const status = (turnErr as { status?: number }).status;
            const code = (turnErr as { code?: string }).code;
            const errMsg = String((turnErr as Error)?.message ?? '');
            const errLower = errMsg.toLowerCase();
            const codeLower = String(code ?? '').toLowerCase();
            const isContextOverflow = errLower.includes('context window')
              || errLower.includes('maximum context')
              || errLower.includes('context length')
              || errLower.includes('context_length')
              || errLower.includes('too many tokens')
              || errLower.includes('input exceeds')
              || errLower.includes('prompt is too long')
              || errLower.includes('too long')
              || codeLower.includes('context')
              || codeLower === 'context_length_exceeded';

            // LAST-RESORT semantic recovery: the proactive gate should prevent
            // this path. If provider truth still rejects the prompt, force one
            // provider-backed prefix compaction. A second rejection fails closed;
            // no trim/reset is allowed to erase the evidence needed to recover.
            if (isContextOverflow && !recoveredFromContextOverflow) {
              logger.error(
                {
                  sessionId: this.sessionId,
                  model: this._model,
                  maxContextTokens,
                  lastApiInputTokens: this._lastApiInputTokens,
                  messageCount: this.messages.length,
                  errMsg: errMsg.slice(0, 300),
                },
                'Context overflow reached provider — proactive compaction failed; running overflow-recovery',
              );
              try { struggleAnalyzer.suspendStall(); } catch { /* best-effort */ }

              const overflowRequiresCompaction = () => needsCompaction(
                this.messages,
                maxContextTokens,
                this._model,
                this._systemOverheadTokens,
                preflightOutputReserve,
                this.effectiveReportedPromptTokens(),
                this.effectiveReportedRawPromptTokens(),
                preflightGuardTokens,
              );
              const { compacted: didCompact } = await this.enforceRequiredCompaction(
                maxContextTokens,
                {
                  customInstructions: 'The request exceeded context limits. Preserve critical task state, errors, decisions, and pending work while semantically summarizing the oldest complete prefix.',
                  abortSignal: this.abortController?.signal,
                  overheadTokens: this._systemOverheadTokens,
                  planFilePath: this._planFilePath ?? undefined,
                },
                'overflow-recovery',
                overflowRequiresCompaction,
                true,
              );
              if (!didCompact) throw new Error('Required overflow-recovery compaction returned without a semantic rewrite');
              postCompactionRequestKind = 'post_compaction';
              recoveredFromContextOverflow = true;
              this.emit('agent_event', {
                type: 'provider_status',
                code: 'context_overflow_compact_retry',
                level: 'info',
                message: 'Context exceeded the model limit — semantically compacted the oldest history and retrying…',
                timestamp: Date.now(),
              });
              try { struggleAnalyzer.onTurnStart(); } catch { /* best-effort */ }
              continue;
            }
            if (isContextOverflow && recoveredFromContextOverflow) {
              throw new Error(
                `Provider rejected the prompt after semantic compaction; preserved the full active projection instead of trimming it (${errMsg})`,
              );
            }

            const {
              isTransientProviderFailure,
              isInvalidModelOrProviderFailure,
              formatInvalidModelError,
              sleepMs,
              transientRetryDelayMs,
              formatRetryNotice,
              formatStallDuration,
              resolveRetryDelayMs,
              retryAfterMsFromError,
            } = await import('../provider/transient-errors.js');
            const isTransient = isTransientProviderFailure({
              message: errMsg,
              code,
              retryable: (turnErr as { retryable?: boolean }).retryable,
              status,
            }) || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE'
              || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_REQ_RETRY';

            // Fast-fail 429 on the first turn: if we've never had a successful API call,
            // this likely means the API key is invalid/rate-limited/expired — not a transient blip.
            // Retrying just wastes time while the user stares at "Thinking...".
            const isFirstTurn = this._turnCount === 0 && turnIndex === 0;
            if (status === 429 && isFirstTurn) {
              throw Object.assign(new Error(
                `API key rate limited or over quota. Use /model to login with ChatGPT (free) or switch providers.`
              ), { status });
            }

            // SCLI-384: invalid provider/model must never enter indefinite backoff.
            if (isInvalidModelOrProviderFailure({ message: errMsg, code, status })) {
              throw Object.assign(
                new Error(formatInvalidModelError(this._model, errMsg)),
                { status, code, retryable: false },
              );
            }

            if (!isTransient) {
              throw turnErr; // Permanent / non-retryable
            }
            // Indefinite retries with capped exponential backoff until success or abort.
            const abortSignal = this.abortController?.signal;
            if (abortSignal?.aborted) throw turnErr;
            // Spark/Codex first-token stalls: longer backoff (re-sending 80k+ prompts
            // immediately worsens OpenAI thrash). After several stalls, nudge model switch.
            const isFirstTokenStall = /no first chunk|first-token stall|stream stalled|timed?\s*out/i.test(errMsg);
            const isSpark = /spark|codex/i.test(this._model);
            // SCLI-388: bound no-header / first-token stall retries so the TUI
            // returns idle with a diagnosis + recovery instead of retrying forever
            // while the footer still invites queueing.
            const MAX_FIRST_TOKEN_STALL_RETRIES = parseInt(
              process.env['TUI_MAX_FIRST_TOKEN_STALL_RETRIES'] || '2',
              10,
            );
            if (isFirstTokenStall && stallAttempts + 1 >= Math.max(1, MAX_FIRST_TOKEN_STALL_RETRIES)) {
              const stall = noteStallRetry();
              const diagnosis =
                `Provider/model timeout: no response headers after ${formatStallDuration(stall.elapsedMs)}`
                + ` (${stall.attempt} attempt${stall.attempt === 1 ? '' : 's'}).`
                + ' Try /model <reachable-id> or Esc and relaunch with a healthy model.';
              this.emit('agent_event', {
                type: 'provider_status',
                code: 'stall_timeout',
                level: 'warning',
                message: diagnosis,
                stalledMs: stall.elapsedMs,
                attempts: stall.attempt,
                elapsedMs: stall.elapsedMs,
                timestamp: Date.now(),
              } as never);
              throw Object.assign(new Error(diagnosis), {
                code: 'ETIMEDOUT',
                retryable: false,
              });
            }
            // Cortex's admission guards send an accurate Retry-After; prefer it
            // over blind exponential so a freed lane is picked up promptly.
            // Spark/Codex first-token stalls keep their deliberately longer
            // backoff — re-sending 80k+ prompts fast makes OpenAI thrash worse.
            const serverRetryAfterMs = retryAfterMsFromError(turnErr);
            const jitter = isFirstTokenStall && isSpark
              ? Math.min(transientRetryDelayMs(retryAttempt + 2), 60_000) // start ~4s, cap 60s
              : resolveRetryDelayMs({ attempt: retryAttempt, retryAfterMs: serverRetryAfterMs });
            const label = /server_error|help\.openai|error occurred while processing/i.test(errMsg)
              ? 'Upstream provider glitch'
              : isFirstTokenStall
                ? 'Provider stream/first-token stall'
                : 'API error';
            let hint = '';
            if (isFirstTokenStall && isSpark && retryAttempt >= 2) {
              hint = ' — Spark/Codex is slow on large contexts; try /model DeepSeek-V4-Flash or Esc + /clear';
            }
            const stall = noteStallRetry();
            this.emit('agent_event', {
              type: 'error',
              error: formatRetryNotice({
                label,
                code,
                status,
                message: errMsg,
                attempt: stall.attempt,
                elapsedMs: stall.elapsedMs,
                delayMs: jitter,
                hint,
              }),
              timestamp: Date.now(),
            });
            // Persistent, machine-readable stall state for the status footer:
            // the scrollback banner above scrolls away, leaving only a spinner.
            this.emit('agent_event', {
              type: 'provider_status',
              code: 'provider_retry_stall',
              level: stall.elapsedMs >= 60_000 ? 'warning' : 'info',
              message: `Provider unavailable for ${formatStallDuration(stall.elapsedMs)}`
                + ` (${stall.attempt} attempts) — Esc to cancel`,
              stalledMs: stall.elapsedMs,
              attempts: stall.attempt,
              timestamp: Date.now(),
            } as never);
            try {
              await sleepMs(jitter, abortSignal);
            } catch {
              throw turnErr; // Aborted during backoff
            }
          }
        }

        // Capture the uninflated baseline for the exact request after
        // executeTurn has injected any registry reminders, but before this loop
        // appends the assistant response/tool results.
        providerRequestRawPromptTokens = estimateTokens(this.messages, this._model)
          + this._systemOverheadTokens;
        this._lastApiInputTokens = result.inputTokens;
        this._lastProviderPromptEstimate = result.providerPromptEstimate ?? 0;
        this._lastReportedRawPromptTokens = providerRequestRawPromptTokens;
        // Only a server-reported prompt count calibrates the tokenizer. vLLM
        // falls back to its own preflight estimate when usage is absent; equal
        // values therefore carry no independent evidence.
        if (this._lastApiInputTokens > 0
          && this._lastReportedRawPromptTokens > 0
          && (this._lastProviderPromptEstimate <= 0
            || this._lastApiInputTokens !== this._lastProviderPromptEstimate)) {
          this._providerTokenizerRatio = this._lastApiInputTokens / this._lastReportedRawPromptTokens;
        }
        if (this._lastApiInputTokens > 0 || this._lastProviderPromptEstimate > 0) {
          this.store.saveContextTokenAnchor(this.sessionId, {
            model: this._model,
            providerInputTokens: this._lastApiInputTokens,
            providerPromptEstimate: this._lastProviderPromptEstimate,
            rawPromptTokens: this._lastReportedRawPromptTokens,
          }, this.messages);
        }

        // Non-thinking models must never persist reasoning-only output. DeepSeek
        // can return `reasoning_content` when a backend template defaults to
        // thinking=true; treat that as an invisible provider response and recover
        // before adding it to live/durable transcript state.
        if (result.toolCalls.length === 0
          && !modelProfile.supportsThinking
          && !hasVisibleAssistantText(result.assistantMessage.content)) {
          const reasoningStr = reasoningTextFromContent(result.assistantMessage.content);
          if (reasoningStr.length > 0) {
            logger.warn(
              { turnIndex, reasoningLen: reasoningStr.length, model: this._model },
              'TUI: non-thinking model returned reasoning-only output before persistence; dropping assistant block',
            );
            if (nonThinkingReasoningRecoveryCount < MAX_NON_THINKING_REASONING_RECOVERY) {
              nonThinkingReasoningRecoveryCount++;
              const continueMsg: Message = {
                role: 'user',
                content: 'Your previous response was not visible to the user. Reply again with the final answer in normal visible text only.',
                timestamp: Date.now(),
              };
              this.messages.push(continueMsg);
              this.store.appendMessage(this.sessionId, continueMsg);
              continue;
            }
            const emptyResponseMessage = `Model returned an empty response after ${nonThinkingReasoningRecoveryCount} recovery attempt${nonThinkingReasoningRecoveryCount === 1 ? '' : 's'}. The provider returned reasoning-only content for a non-thinking model; checking logs is required before resuming.`;
            hadError = true;
            lastFailureMessage = emptyResponseMessage;
            this.emit('agent_event', {
              type: 'error',
              error: emptyResponseMessage,
              timestamp: Date.now(),
            });
            break;
          }
        }

        // Save partial or full assistant message
        this.messages.push(result.assistantMessage);
        this.store.appendMessage(this.sessionId, result.assistantMessage);
        if (result.stopReason === 'degenerate_generation') {
          const noticeText = typeof result.assistantMessage.content === 'string'
            ? result.assistantMessage.content
            : visibleTextFromContent(result.assistantMessage.content);
          this.emit('agent_event', {
            type: 'system_notice',
            message: degeneracyRecoveryCount < MAX_DEGENERACY_RECOVERY
              ? `Stopped repetitive planning chatter (no tool in that segment). Auto-recovering once — model must call a tool or finish. ${noticeText.slice(0, 280)}`
              : `Stopped repetitive planning chatter after recovery. Earlier tool results are intact; send the next instruction. ${noticeText.slice(0, 280)}`,
            timestamp: Date.now(),
          });
        }

        if (result.toolResults.length > 0) {
          const trMsg: Message = {
            role: 'user',
            content: result.toolResults.map((tr) => {
              let content = tr.content;
              if (adaptToolResultFn) {
                const tc = result.toolCalls.find((c) => c.id === tr.toolUseId);
                if (tc) {
                  content = adaptToolResultFn(tc.name, tr.content, tc.input, tr.metadata, tr.isError);
                }
              }
              return {
                type: 'tool_result' as const,
                toolUseId: tr.toolUseId,
                content,
                isError: tr.isError,
                image: tr.image,
              };
            }),
            timestamp: Date.now(),
          };
          this.messages.push(trMsg);
          this.store.appendMessage(this.sessionId, trMsg);
        }

        if (result.servedModel) {
          this._servedModel = result.servedModel;
          if (result.servedContextWindow != null) {
            this._servedContextWindow = result.servedContextWindow;
          }
          this.emit('agent_event', {
            type: 'served_model',
            requestedModel: this._model,
            model: result.servedModel,
            contextWindow: this.effectiveMaxContextTokens(provider),
            timestamp: Date.now(),
          });
        }

        this._totalInputTokens += result.inputTokens;
        this._totalOutputTokens += result.outputTokens;
        // Track actual API input tokens for accurate context usage display.
        // This is the real count from Anthropic's tokenizer (system + tools + messages).
        this._turnCount++;
        this.store.updateTokens(this.sessionId, result.inputTokens, result.outputTokens);

        // SCLI-32: capture this turn into the run-telemetry window, then run the
        // window-driven heuristics (review P2-4). Best-effort; never breaks a turn.
        try {
          const sig = toolCallSignature(result.toolCalls);
          recordTurnTelemetry({
            window: struggleWindow,
            result,
            providerName: provider.name,
            runId: struggleRunId,
            turnIndex,
            model: this._model,
            turnDurationMs: Date.now() - turnStart,
            loopGuardHit: sig !== null && sig === previousToolSignature,
          });
          const _c = result.assistantMessage.content;
          const _txt = typeof _c === 'string' ? _c
            : Array.isArray(_c) ? (_c as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
          const _hasReasoningOnly = Array.isArray(_c)
            && (_c as any[]).some((b: any) => b.type === 'reasoning')
            && !_txt.trim();
          const _isThinkingOnly = !_txt.replace(/<think>[\s\S]*?<\/think>/g, '').trim() && _txt.length > 0;
          const continuing = result.toolCalls.length > 0
            || result.stopReason === 'interrupted'
            || (_hasReasoningOnly && !modelProfile.supportsThinking
              && nonThinkingReasoningRecoveryCount < MAX_NON_THINKING_REASONING_RECOVERY)
            || (_isThinkingOnly && (
              (this.hasRecentToolResult() && emptyToolResultRecoveryCount < MAX_EMPTY_TOOL_RESULT_RECOVERY)
              || (modelProfile.supportsThinking && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY)
            ));
          struggleAnalyzer.onTurnRecorded(continuing);
        } catch (err) {
          logger.debug({ err }, 'SCLI-32: TUI turn-telemetry/analyzer failed (non-fatal)');
        }

        this.emit('agent_event', {
          type: 'turn_complete', turnIndex,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens,
          durationMs: Date.now() - turnStart, timestamp: Date.now(),
        });

        turnIndex++;

        // Instant injection: if the turn was interrupted by user input, loop back
        // immediately — the abort+queue check at the top of the loop will inject it.
        if (result.stopReason === 'interrupted') {
          continue;
        }

        // Enforce the ceiling between every assistant/tool round, including a
        // terminal text-only answer. The old block lived below the no-tool
        // break, leaving the common completion path oversized until next input.
        const requiresCompletedSubturnCompaction = () => needsCompaction(
          this.messages,
          maxContextTokens,
          this._model,
          this._systemOverheadTokens,
          preflightOutputReserve,
          this.effectiveReportedPromptTokens(),
          this.effectiveReportedRawPromptTokens(),
          preflightGuardTokens,
        );
        if (requiresCompletedSubturnCompaction()) {
          const { compacted: didCompact } = await this.enforceRequiredCompaction(
            maxContextTokens,
            {
              abortSignal: this.abortController?.signal,
              overheadTokens: this._systemOverheadTokens,
              planFilePath: this._planFilePath ?? undefined,
            },
            'post-turn',
            requiresCompletedSubturnCompaction,
          );
          if (didCompact) {
            pendingProviderRequestKind = 'post_compaction';
            this._postCompactionRequestPending = true;
          }
        }

        // Continuation: incomplete provider terminals are visible failures and
        // are never replayed automatically after partial output.
        if (result.toolCalls.length === 0) {
          const incompleteError = incompleteTurnError(result.stopReason);
          if (incompleteError) {
            hadError = true;
            lastFailureMessage = incompleteError;
            this.emit('agent_event', {
              type: 'error',
              error: incompleteError,
              timestamp: Date.now(),
            });
            // Queued user input is a distinct new request, not a replay of the
            // incomplete assistant turn, so it remains safe to deliver.
            if (this.drainQueuedInput()) continue;
            break;
          }

          // Chatter-guard stop: one forced recovery (like progress-only) so the
          // session does not go idle after a true spin. Evidence is in the stop
          // notice; the recovery prompt forbids restating the plan.
          if (result.stopReason === 'degenerate_generation' && this._mode !== 'plan') {
            if (degeneracyRecoveryCount < MAX_DEGENERACY_RECOVERY) {
              degeneracyRecoveryCount++;
              logger.warn(
                { turnIndex, attempt: degeneracyRecoveryCount, sessionId: this.sessionId },
                'TUI: chatter-guard stop — re-prompting once for a concrete tool call',
              );
              const continueMsg: Message = {
                role: 'user',
                content: DEGENERACY_RECOVERY_PROMPT,
                timestamp: Date.now(),
              };
              this.messages.push(continueMsg);
              this.store.appendMessage(this.sessionId, continueMsg);
              continue;
            }
            if (this.drainQueuedInput()) continue;
            break;
          }

          const contentForCheck = result.assistantMessage.content;
          const contentCheckStr = visibleTextFromContent(contentForCheck);
          const strippedCheck = contentCheckStr.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          const hasActionableText = strippedCheck.length > 0;
          logger.info({
            turnIndex,
            stopReason: result.stopReason,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            contentType: typeof contentForCheck,
            contentIsArray: Array.isArray(contentForCheck),
            contentStrLen: contentCheckStr.length,
            strippedLen: strippedCheck.length,
            hasActionableText,
            supportsThinking: modelProfile.supportsThinking,
            truncRecovery: truncationRecoveryCount,
            contentHead: contentCheckStr.slice(0, 100),
            contentTail: contentCheckStr.slice(-100),
          }, 'TUI empty-response check');
          // GLM/local-model fallback: the answer landed entirely in the reasoning
          // channel (model emitted <think> content but no post-think text). Surface
          // it as the answer and stop, instead of nudge-looping — these models
          // ignore the "Continue" nudge and keep re-reasoning until we error out.
          if (!hasActionableText) {
            const reasoningStr = reasoningTextFromContent(contentForCheck);
            if (reasoningStr.length > 0) {
              if (modelProfile.supportsThinking) {
                logger.info({ turnIndex, reasoningLen: reasoningStr.length }, 'TUI: surfaced reasoning-only answer (no text content)');
                this.emit('agent_event', { type: 'content', text: reasoningStr, timestamp: Date.now() });
                // Turn is over — deliver anything the user queued while it ran.
                if (this.drainQueuedInput()) continue;
                break;
              }
              logger.warn(
                { turnIndex, reasoningLen: reasoningStr.length, model: this._model },
                'TUI: non-thinking model returned reasoning-only output; treating as invalid provider response',
              );
              if (nonThinkingReasoningRecoveryCount < MAX_NON_THINKING_REASONING_RECOVERY) {
                nonThinkingReasoningRecoveryCount++;
                const continueMsg: Message = {
                  role: 'user',
                  content: 'Your previous response was not visible to the user. Reply again with the final answer in normal visible text only.',
                  timestamp: Date.now(),
                };
                this.messages.push(continueMsg);
                this.store.appendMessage(this.sessionId, continueMsg);
                continue;
              }
            }
          }

          if (!hasActionableText && this.hasRecentToolResult() && emptyToolResultRecoveryCount < MAX_EMPTY_TOOL_RESULT_RECOVERY) {
            emptyToolResultRecoveryCount++;
            const continueMsg: Message = {
              role: 'user',
              content: 'Continue. If a tool result is available, answer the user directly from it.',
              timestamp: Date.now(),
            };
            this.messages.push(continueMsg);
            this.store.appendMessage(this.sessionId, continueMsg);
            continue;
          }

          if (!hasActionableText && modelProfile.supportsThinking && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY) {
            truncationRecoveryCount++;
            const continueMsg: Message = {
              role: 'user',
              content: 'Continue. If a tool result is available, answer the user directly from it.',
              timestamp: Date.now(),
            };
            this.messages.push(continueMsg);
            this.store.appendMessage(this.sessionId, continueMsg);
            continue;
          }
          if (!hasActionableText) {
            const recoveryAttempts = Math.max(truncationRecoveryCount, emptyToolResultRecoveryCount);
            const emptyResponseMessage = `Model returned an empty response after ${recoveryAttempts} recovery attempt${recoveryAttempts === 1 ? '' : 's'}. The last tool result is already in the transcript; submit a follow-up or resume after checking logs.`;
            logger.warn({
              turnIndex,
              stopReason: result.stopReason,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              truncRecovery: truncationRecoveryCount,
              model: this._model,
              sessionId: this.sessionId,
            }, 'TUI model returned empty response');
            hadError = true;
            lastFailureMessage = emptyResponseMessage;
            this.emit('agent_event', {
              type: 'error',
              error: emptyResponseMessage,
              timestamp: Date.now(),
            });
          }

          if (hasActionableText && this._mode !== 'plan' && isProgressOnlyAssistantText(strippedCheck)) {
            if (progressOnlyRecoveryCount < MAX_PROGRESS_ONLY_RECOVERY) {
              progressOnlyRecoveryCount++;
              const continueMsg: Message = {
                role: 'user',
                content: `Your previous response was only a progress update, not a completed answer: "${strippedCheck.slice(0, 240)}"\n\nDo not stop after narrating the next step. If work remains, call the appropriate tool now. If the task is actually complete, give the final answer directly.`,
                timestamp: Date.now(),
              };
              this.messages.push(continueMsg);
              this.store.appendMessage(this.sessionId, continueMsg);
              continue;
            }

            const progressOnlyMessage = `Model stopped after progress-only narration without calling a tool after ${progressOnlyRecoveryCount} recovery attempts. The turn is incomplete; resume after checking logs or switch models.`;
            hadError = true;
            lastFailureMessage = progressOnlyMessage;
            this.emit('agent_event', {
              type: 'error',
              error: progressOnlyMessage,
              timestamp: Date.now(),
            });
          }

          // Turn is over — deliver anything the user queued while it ran.
          // The top-of-loop injector only fires on abort, so drain here: with
          // queue-don't-interrupt semantics no abort ever happens.
          if (this.drainQueuedInput()) continue;
          break;
        }
        truncationRecoveryCount = 0;

        // Identical-call loop policy (false-positive hardened):
        // - successful repeats → soft nudge only, never hard-stop (polling/re-check OK)
        // - failing / empty-args repeats → nudge then hard-stop
        // - text-only turns → ignore (no signature tracking)
        const erroredResult = (result.toolResults ?? []).find((r) => r.isError);
        const loopVerdict = evaluateRepeatedToolLoop({
          toolCalls: result.toolCalls,
          previousSignature: previousToolSignature,
          previousCount: repeatedToolSignatureCount,
          hadError: turnHadToolError(result.toolResults),
          errorContent: erroredResult?.content,
          errorNudgeAt: REPEATED_TOOL_CALL_NUDGE_AT,
          errorStopAt: REPEATED_TOOL_CALL_STOP_AT,
        });
        previousToolSignature = loopVerdict.previousSignature;
        repeatedToolSignatureCount = loopVerdict.count;

        // Error-streak forcing-function: count consecutive turns whose tool calls
        // error out. Reset the moment a call succeeds (real progress) or the model
        // answers. At the threshold, inject ONE forcing nudge per escalation window
        // so the model diagnoses the root cause instead of retrying failing variations.
        // (Trigger is repeated ERRORS — never absence of edits; read-only work is fine.)
        if (turnHadToolError(result.toolResults)) {
          erroredTurnStreak++;
        } else {
          erroredTurnStreak = 0;
          errorNudgedAt = 0;
        }
        if (erroredTurnStreak >= ERRORED_TURN_NUDGE_AT
            && erroredTurnStreak - errorNudgedAt >= ERRORED_TURN_NUDGE_AT
            && loopVerdict.action === 'none') {
          errorNudgedAt = erroredTurnStreak;
          const lastErr = (result.toolResults ?? []).find((r) => r.isError);
          const errSnippet = String(lastErr?.content ?? '').replace(/\s+/g, ' ').slice(0, 300).trim();
          const nudgeContent = `Your last ${erroredTurnStreak} turns of tool calls have all ended in errors — most recently:\n\n${errSnippet}\n\nStop retrying variations. State your best hypothesis about the ROOT cause in one or two sentences, then either fix that root cause directly (e.g. correct a path/cwd/format, create the missing file) or, if you cannot, report exactly what is blocking you and what you'd need to proceed.`;
          const nudgeMsg: Message = { role: 'user', content: nudgeContent, timestamp: Date.now() };
          this.messages.push(nudgeMsg);
          this.store.appendMessage(this.sessionId, nudgeMsg);
          continue;
        }

        if (loopVerdict.action === 'nudge') {
          const repeatedToolNames = [...new Set(result.toolCalls.map((tc) => tc.name))].join(', ');
          const n = loopVerdict.count;
          const errSnippet = String(erroredResult?.content ?? '').replace(/\s+/g, ' ').slice(0, 300).trim();
          let nudgeContent: string;
          if (loopVerdict.kind === 'empty_args') {
            nudgeContent = `STOP repeating that call. You have run \`${repeatedToolNames}\` ${n} times with EMPTY/invalid arguments (schema error):\n\n${errSnippet}\n\nYour last tool call had missing required fields (empty input {}). Do NOT retry the same empty call. Either re-issue the tool WITH complete arguments (e.g. bash needs {"command":"..."}, grep needs {"pattern":"..."}), or answer the user without that tool.`;
          } else if (loopVerdict.kind === 'error_repeat') {
            nudgeContent = `STOP repeating that call. You have run the same \`${repeatedToolNames}\` ${n} times and it keeps FAILING with the same error:\n\n${errSnippet}\n\nRunning it again will not change anything. Diagnose the root cause and try a DIFFERENT approach — e.g. fix the working directory (cd into the correct folder before the command), correct a path or filename, or use a different command. If you truly cannot proceed, stop and explain what is blocking you.`;
          } else {
            // success_repeat — soft only
            nudgeContent = `You have already called \`${repeatedToolNames}\` with the same input ${n} times and have its result. Prefer using that result for the NEXT step, or answer the user directly. If you intentionally need to re-run the same check (e.g. polling), continue — this is only a reminder.`;
          }
          const nudgeMsg: Message = { role: 'user', content: nudgeContent, timestamp: Date.now() };
          this.messages.push(nudgeMsg);
          this.store.appendMessage(this.sessionId, nudgeMsg);
          continue;
        }

        if (loopVerdict.action === 'stop') {
          // Hard-stop only for failing/empty-args runaways (never success_repeat).
          const repeatedToolNames = [...new Set(result.toolCalls.map((tc) => tc.name))].join(', ');
          const errSnippet = String(erroredResult?.content ?? '');
          const guardText = loopVerdict.kind === 'empty_args' || isEmptyToolArgsError(errSnippet)
            ? `Stopped after ${loopVerdict.count} identical \`${repeatedToolNames}\` calls with empty/invalid arguments (tool schema rejected the input). This is not a working-directory issue — the tool was called without required fields. Re-issue with complete args, or answer without that tool.`
            : `Stopped after ${loopVerdict.count} identical \`${repeatedToolNames}\` calls that kept failing the same way. Likely cause: the command needs a different working directory or inputs — re-issue it correctly, or tell me what's blocking you.`;
          const guardMsg: Message = { role: 'assistant', content: guardText, timestamp: Date.now() };
          this.messages.push(guardMsg);
          this.store.appendMessage(this.sessionId, guardMsg);
          this.emit('agent_event', { type: 'content', text: guardText, timestamp: Date.now() });
          break;
        }

        // Queued-input drain at the NEXT TURN BOUNDARY (2026-08-08): a message
        // typed while the agent is mid-query must not wait for the WHOLE
        // multi-turn agentic loop to finish (up to maxTurns=30 tool rounds)
        // before it's processed — that makes the "press Enter to queue"
        // affordance effectively a "wait for the entire query" promise. Drain
        // here, at the end of a single tool round, so the queued message
        // becomes the very next user turn (the loop's top runs pre-turn
        // compaction, then executeTurn with the injected user turn). Reset
        // turnIndex so the new user query gets a fresh turn budget instead of
        // being pinned against the previous query's maxTurns ceiling.
        if (this.drainQueuedInput()) {
          turnIndex = 0;
          // eslint-disable-next-line no-labels
          continue;
        }
      }
    // Catch-all: the inner loop has many completion paths, and with
    // queue-don't-interrupt semantics nothing aborts to wake the injector.
    // Any message still queued here would otherwise sit unanswered until the
    // user typed again, which reads exactly like the agent ignoring them.
    if (this.drainQueuedInput()) {
      // eslint-disable-next-line no-labels
      continue injection_loop;
    }
    // eslint-disable-next-line no-labels
    break injection_loop; // Normal exit from inner turn loop
    } catch (err) {
      const rawMessage = (err as Error).message ?? String(err);
      const errorMessage = humanizeApiError(rawMessage);
      const abortSignalTripped = Boolean(this.abortController?.signal.aborted);
      const abortLikeError = (err as Error).name === 'AbortError'
        || rawMessage.toLowerCase().includes('abort')
        || rawMessage.toLowerCase().includes('interrupted');
      if ((abortSignalTripped || abortLikeError) && this.pendingInputQueue.length > 0) {
        // Soft abort with pending input — re-enter the turn loop.
        // This handles edge cases where abort propagated through compaction/retry
        // instead of being caught by executeTurn's graceful handling.
        this.abortController = new AbortController();
        this.drainQueuedInput();
        // eslint-disable-next-line no-labels
        continue injection_loop;
      } else if (abortSignalTripped || abortLikeError) {
        interrupted = true;
      } else {
        hadError = true;
        lastFailureMessage = errorMessage;
      }
      this.emit('agent_event', {
        type: 'error',
        error: interrupted ? 'Interrupted' : errorMessage,
        timestamp: Date.now(),
      });
      // eslint-disable-next-line no-labels
      break injection_loop;
    }
    } // end injection_loop

    // SCLI-32 teardown (review P2-4): kick off the auto-filer flush fire-and-forget
    // (review P2-A) — awaiting it would block the `complete` event below; if Pulse
    // is slow/unreachable the TUI stalls at "Processing…" even though the turn is
    // done. Sync teardown (unsub + destroy) runs immediately so no stale listeners
    // remain. The flush promise is best-effort: a struggle on the final turn may be
    // lost if the process exits before it resolves, which is acceptable.
    try {
      void struggleAutoFilerFlush().catch(() => {});
      struggleAutoFilerUnsub();
      struggleAnalyzer.destroy();
    } catch (err) {
      logger.debug({ err }, 'SCLI-32: TUI struggle teardown failed (non-fatal)');
    }

    if (this.sessionId) {
      if (interrupted) {
        this.upsertInterruptCheckpoint('Previous turn was interrupted before completion.');
      } else if (hadError) {
        const detail = lastFailureMessage ? ` Error: ${lastFailureMessage}` : '';
        this.upsertInterruptCheckpoint(`Previous turn ended with an error before completion.${detail}`);
      } else if (!hadError) {
        this.store.clearInterruptCheckpoint(this.sessionId);
      }
    }

    this._turnPromptExcerpt = null;
    this.abortController = null;
    this._isTurnActive = false;
    this.emit('agent_event', {
      type: 'complete', totalTurns: turnIndex,
      totalInputTokens: this._totalInputTokens, totalOutputTokens: this._totalOutputTokens,
      totalDurationMs: 0, timestamp: Date.now(),
    });
  }

  /** List recent sessions */
  listSessions(limit = 50): SessionSummary[] {
    if (!this.store) return [];
    return this.store.listSessions(limit, this._cwd);
  }

  private async prepareResumeTranscriptForUse(
    sessionId: string,
    contextWindowDiscoveryDeferred = false,
    abortSignal?: AbortSignal,
  ): Promise<ResumeTrimResult> {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error('Session resume superseded');
    }
    const noTrim = (
      maxContextTokens = 0,
      preflightCeiling = 0,
      contextWindowCeiling = 0,
      promptTokens = 0,
    ): ResumeTrimResult => ({
      dropped: 0,
      beforeMessages: this.messages.length,
      afterMessages: this.messages.length,
      beforeTokens: promptTokens,
      afterTokens: promptTokens,
      preflightCeiling,
      contextWindowCeiling,
      maxContextTokens,
      responsiveBudgetExceeded: promptTokens > preflightCeiling,
      hardBudgetExceeded: promptTokens > contextWindowCeiling,
      contextWindowDiscoveryDeferred,
    });
    if (this.messages.length === 0) return noTrim();

    if (contextWindowDiscoveryDeferred) {
      const promptTokens = estimatePromptTokenBudget({
        messages: this.messages,
        systemPrompt: '',
        toolDefs: [],
        model: this._model,
        reportedPromptTokens: this.effectiveReportedPromptTokens(this.messages, 0),
        reportedRawEstimateTokens: this.effectiveReportedRawPromptTokens(this.messages, 0),
      }).promptTokenEstimate;
      logger.warn(
        { sessionId, model: this._model, beforeMessages: this.messages.length, promptTokens },
        'TUI resume context-window discovery unavailable — preserving working context and deferring hard fit',
      );
      return noTrim(0, 0, 0, promptTokens);
    }

    const maxContextTokens = this.effectiveMaxContextTokens(this.provider);
    const modelProfile = getModelProfile(this._model);
    const maxOutputTokens = modelProfile.recommendedMaxOutputTokens ?? this.config.agent.maxOutputTokens;
    const outputReserve = Math.max(512, Math.min(maxOutputTokens, 16_384));
    const guardTokens = resolveTuiPreflightGuardTokens(maxContextTokens);
    const preflightCeiling = resolveTuiPreflightCeilingTokens(maxContextTokens, outputReserve, guardTokens);
    const contextWindowCeiling = Math.max(1_000, maxContextTokens - outputReserve - guardTokens);
    let promptBudget = estimatePromptTokenBudget({
      messages: this.messages,
      systemPrompt: '',
      toolDefs: [],
      model: this._model,
      reportedPromptTokens: this.effectiveReportedPromptTokens(),
      reportedRawEstimateTokens: this.effectiveReportedRawPromptTokens(),
    });
    const beforeMessages = this.messages.length;
    const beforeTokens = promptBudget.promptTokenEstimate;
    if (promptBudget.promptTokenEstimate <= contextWindowCeiling) {
      if (promptBudget.promptTokenEstimate > preflightCeiling) {
        logger.warn(
          { sessionId, beforeMessages, beforeTokens, maxContextTokens, preflightCeiling, contextWindowCeiling },
          'TUI resume transcript exceeds responsive budget but fits backend window — preserving full context',
        );
      }
      return noTrim(maxContextTokens, preflightCeiling, contextWindowCeiling, beforeTokens);
    }

    const hardFitRequired = () => estimatePromptTokenBudget({
      messages: this.messages,
      systemPrompt: '',
      toolDefs: [],
      model: this._model,
      reportedPromptTokens: this.effectiveReportedPromptTokens(),
      reportedRawEstimateTokens: this.effectiveReportedRawPromptTokens(),
    }).promptTokenEstimate > contextWindowCeiling;
    const result = await this.enforceRequiredCompaction(
      maxContextTokens,
      {
        customInstructions: 'The resumed session exceeded the backend fit budget. Semantically summarize only the oldest complete prefix while preserving the recent suffix verbatim.',
        overheadTokens: this._systemOverheadTokens,
        planFilePath: this._planFilePath ?? undefined,
        abortSignal,
      },
      'resume',
      hardFitRequired,
      true,
    );
    if (!result.compacted) {
      throw new Error('Required resume compaction returned without a semantic rewrite');
    }
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error('Session resume superseded');
    }
    promptBudget = estimatePromptTokenBudget({
      messages: this.messages,
      systemPrompt: '',
      toolDefs: [],
      model: this._model,
      reportedPromptTokens: this.effectiveReportedPromptTokens(this.messages, 0),
      reportedRawEstimateTokens: this.effectiveReportedRawPromptTokens(this.messages, 0),
    });
    if (promptBudget.promptTokenEstimate > contextWindowCeiling) {
      throw new Error(
        `Resume semantic compaction did not restore backend headroom (${promptBudget.promptTokenEstimate}/${contextWindowCeiling} tokens); history was preserved`,
      );
    }
    logger.info(
      { sessionId, beforeMessages, afterMessages: this.messages.length, beforeTokens, afterTokens: promptBudget.promptTokenEstimate },
      'TUI resume restored backend headroom through semantic prefix compaction',
    );
    return {
      dropped: 0,
      beforeMessages,
      afterMessages: this.messages.length,
      beforeTokens,
      afterTokens: promptBudget.promptTokenEstimate,
      preflightCeiling,
      contextWindowCeiling,
      maxContextTokens,
      responsiveBudgetExceeded: beforeTokens > preflightCeiling,
      hardBudgetExceeded: beforeTokens > contextWindowCeiling,
      contextWindowDiscoveryDeferred: false,
    };
  }

  /**
   * Resolve self-hosted model metadata before resume can rewrite the bounded
   * working set. A transient /v1/models failure must never turn the vLLM
   * constructor's generic 131K floor into a destructive persistence decision.
   */
  private async discoverResumeContextWindow(): Promise<boolean> {
    const providerDiscovery = this.provider as unknown as {
      getServedModel?: (
        preferredModel?: string,
        options?: { forceRefresh?: boolean },
      ) => Promise<string | undefined>;
    };
    if (typeof providerDiscovery?.getServedModel !== 'function') return true;

    try {
      const servedModel = await providerDiscovery.getServedModel(
        this._model,
        { forceRefresh: true },
      );
      if (servedModel) return true;
    } catch (err) {
      logger.debug({ err, model: this._model }, 'TUI resume context-window discovery failed');
    }

    // Static model knowledge is useful for display only. It is not evidence of
    // the active deployment's launch limit, so never authorize destructive
    // resume trimming from it.
    return false;
  }

  private assertResumeCurrent(signal: AbortSignal, generation: number): void {
    if (this.destroyed || signal.aborted || generation !== this.resumeGeneration) {
      throw signal.reason ?? new Error('Session resume superseded');
    }
  }

  /** Resume a previous session, fencing any older in-flight resume. */
  async resumeSession(id: string): Promise<boolean> {
    this.resumeAbortController?.abort(new Error('Session resume superseded'));
    const controller = new AbortController();
    const generation = ++this.resumeGeneration;
    this.resumeAbortController = controller;
    try {
      return await this.resumeSessionFenced(id, controller.signal, generation);
    } finally {
      if (this.resumeAbortController === controller) {
        this.resumeAbortController = null;
      }
    }
  }

  private async resumeSessionFenced(
    id: string,
    abortSignal: AbortSignal,
    generation: number,
  ): Promise<boolean> {
    this.assertResumeCurrent(abortSignal, generation);
    const session = this.store.loadSession(id);
    if (!session) return false;
    const transcriptMessages = this.sanitizeRecoveredTranscript(
      this.store.loadTranscriptMessages(id),
      session.model,
    ).messages;
    // Token anchors belong to the previous in-memory session. Never let them
    // influence a different resumed transcript.
    this.clearContextTokenAnchors(true);
    this.systemPromptAnchor = null;
    this.sessionId = session.id;
    const sanitized = this.sanitizeRecoveredTranscript(session.messages, session.model);
    this.messages = sanitized.messages;
    if (sanitized.removed > 0) {
      this.store.replaceMessages(session.id, sanitized.messages);
      logger.info({ sessionId: session.id, removed: sanitized.removed }, 'Sanitized internal recovery messages on TUI resume');
    }
    this._totalInputTokens = session.totalInputTokens;
    this._totalOutputTokens = session.totalOutputTokens;
    this._turnCount = session.turnCount;
    // Resume must NOT force a compaction (Claude Code / Codex resume without one).
    // Compaction is governed solely by the context-size threshold (needsCompaction)
    // or an explicit /compact. Dangling tool_use from an interrupted turn is already
    // handled by sanitizeRecoveredTranscript above, so no forced compaction is needed.
    this._forceCompactOnNextTurn = null;
    this._postCompactionRequestPending = false;
    this._servedModel = undefined;
    this._servedContextWindow = undefined;
    // Switch provider for resumed session's model without clearing messages.
    // (setModel() clears messages on provider change, which we don't want during resume.)
    if (session.model !== this._model) {
      try {
        this.provider = this.providerRegistry.resolve(session.model);
        this._model = session.model;
        this._initError = null;
      } catch { /* keep current model if resume model is unavailable */ }
    }
    const tokenizerCalibration = this.store.loadTokenizerCalibration(
      session.id,
      this._model,
    );
    if (tokenizerCalibration) {
      this._providerTokenizerRatio = tokenizerCalibration.ratio;
      logger.info(
        {
          sessionId: session.id,
          model: this._model,
          providerInputTokens: tokenizerCalibration.providerInputTokens,
          rawPromptTokens: tokenizerCalibration.rawPromptTokens,
          tokenizerRatio: tokenizerCalibration.ratio,
        },
        'TUI resume restored provider-tokenizer calibration',
      );
    }
    const contextTokenAnchor = this.store.loadContextTokenAnchor(
      session.id,
      this._model,
      this.messages,
    );
    if (contextTokenAnchor) {
      this._lastApiInputTokens = contextTokenAnchor.providerInputTokens;
      this._lastProviderPromptEstimate = contextTokenAnchor.providerPromptEstimate;
      this._lastReportedRawPromptTokens = contextTokenAnchor.rawPromptTokens;
      logger.info(
        {
          sessionId: session.id,
          model: this._model,
          anchorMessageCount: contextTokenAnchor.messageCount,
          currentMessageCount: this.messages.length,
          providerInputTokens: contextTokenAnchor.providerInputTokens,
          providerPromptEstimate: contextTokenAnchor.providerPromptEstimate,
        },
        'TUI resume restored provider-tokenizer context anchor',
      );
    }
    const contextWindowResolved = await this.discoverResumeContextWindow();
    this.assertResumeCurrent(abortSignal, generation);
    let resumeCompaction: ResumeCompactionResult | undefined;
    if (contextWindowResolved) {
      const maxContextTokens = this.effectiveMaxContextTokens(this.provider);
      const modelProfile = getModelProfile(this._model);
      const outputReserve = Math.max(
        512,
        Math.min(
          modelProfile.recommendedMaxOutputTokens ?? this.config.agent.maxOutputTokens,
          16_384,
        ),
      );
      const guardTokens = resolveTuiPreflightGuardTokens(maxContextTokens);
      const compactionRequired = () => needsCompaction(
        this.messages,
        maxContextTokens,
        this._model,
        this._systemOverheadTokens,
        outputReserve,
        this.effectiveReportedPromptTokens(),
        this.effectiveReportedRawPromptTokens(),
        guardTokens,
      );
      if (compactionRequired()) {
        const beforeMessages = this.messages.length;
        const beforeTokens = effectiveContextTokens(
          this.messages,
          this._model,
          this._systemOverheadTokens,
          this.effectiveReportedPromptTokens(),
          this.effectiveReportedRawPromptTokens(),
        );
        const result = await this.enforceRequiredCompaction(
          maxContextTokens,
          {
            overheadTokens: this._systemOverheadTokens,
            planFilePath: this._planFilePath ?? undefined,
            abortSignal,
          },
          'resume',
          compactionRequired,
        );
        this.assertResumeCurrent(abortSignal, generation);
        const afterTokens = effectiveContextTokens(
          this.messages,
          this._model,
          this._systemOverheadTokens,
        );
        resumeCompaction = {
          compacted: result.compacted,
          method: 'provider_semantic',
          attempts: result.attempts,
          beforeMessages,
          afterMessages: this.messages.length,
          beforeTokens,
          afterTokens,
          thresholdTokens: Math.round(
            maxContextTokens * compactionThresholdFor(maxContextTokens),
          ),
          maxContextTokens,
        };
        this._postCompactionRequestPending = result.compacted;
      }
    }
    const resumeTrim = await this.prepareResumeTranscriptForUse(
      session.id,
      !contextWindowResolved,
      abortSignal,
    );
    this.assertResumeCurrent(abortSignal, generation);
    if (resumeTrim.dropped > 0 || resumeTrim.shrunkOversizedContent) {
      // Persist only the bounded active-context projection. The canonical
      // transcript remains append-only in session_message_transcript.
      this.store.replaceMessages(session.id, this.messages);
    }
    // Rebuild the tool-search discovered set from the resumed transcript — the
    // set is in-memory only and a fresh TUI process starts empty, so without
    // this any MCP tool the model already found would be filtered out of the
    // tools array and the model would fall back to faking the call via bash.
    if (this.toolSearchEnabled && this.toolSearchState) {
      const reMarked = this.toolSearchState.markDiscoveredFromHistory(this.messages);
      if (reMarked > 0) {
        logger.info({ sessionId: session.id, reMarked }, 'Tool search: re-derived discovered MCP tools on TUI resume');
      }
    }
    // Maintenance checkpoints (compaction heartbeat frames etc.) are crash
    // forensics only. This resume just re-ran and re-reported any needed
    // maintenance itself, so the persisted frame is superseded — clear it and
    // keep it out of the resume banner. Turn checkpoints ('previous turn was
    // interrupted') stay until the next turn completes cleanly.
    if (session.interruptCheckpoint?.kind === 'maintenance') {
      this.store.clearInterruptCheckpoint(session.id);
      delete session.interruptCheckpoint;
    }
    this.emit('session_resumed', {
      ...session,
      messages: this.messages,
      transcriptMessages,
      sanitizedRemoved: sanitized.removed,
      resumeTrimmedDropped: resumeTrim.dropped,
      resumeTrim,
      resumeCompaction,
      resumeCompactionPlanned: this._forceCompactOnNextTurn !== null,
    });
    return true;
  }

  /** Start a new session */
  newSession(): void {
    if (this.resumeAbortController) {
      this.resumeGeneration++;
      this.resumeAbortController.abort(new Error('Session resume superseded by new session'));
    }
    this.sessionId = null;
    this.messages = [];
    this._forceCompactOnNextTurn = null;
    this._postCompactionRequestPending = false;
    this.clearContextTokenAnchors(true);
    this._totalInputTokens = 0;
    this._totalOutputTokens = 0;
    this._turnCount = 0;
    this._servedModel = undefined;
    this._servedContextWindow = undefined;
    this.systemPromptAnchor = null;
    this.emit('session_new');
  }

  /** Reinitialize providers (e.g. after adding credentials to credential store) */
  reinitializeProviders(): void {
    if (this.providerRegistry) {
      this.providerRegistry.reinitialize();
      // Clear current provider so ensureProvider() re-resolves
      this.provider = null;
      this._initError = null;
    }
  }

  /** Switch model — clears session when provider changes to avoid cross-provider format issues.
   *  E.g. Claude thinking blocks use `thinking_0` IDs; Codex expects `rs_*` prefix.
   *  Returns 'cleared' if session was reset, 'ok' if same provider, 'error' if failed. */
  setModel(model: string): 'cleared' | 'ok' | 'error' {
    if (this.resumeAbortController) {
      this.resumeGeneration++;
      this.resumeAbortController.abort(new Error('Session resume superseded by model change'));
    }
    const oldProvider = this.provider;
    const oldModel = this._model;
    try {
      const { provider: newProvider, resolvedModel } = this.providerRegistry.resolveWithModel(model);
      const providerChanged = oldProvider && newProvider.name !== oldProvider.name;
      this.provider = newProvider;
      // Pin auto to the resolved concrete model
      this._model = (model === 'auto' && resolvedModel !== 'auto') ? resolvedModel : model;
      this._servedModel = undefined;
      this._servedContextWindow = undefined;
      this.systemPromptAnchor = null;
      this._initError = null;
      if (this._model !== oldModel) this.clearContextTokenAnchors(true);

      // Sync web_search tool with new provider — unregister builtin when
      // provider handles it natively to avoid duplicate tool name error
      if (newProvider.supportsNativeWebSearch && this.toolRegistry.has('web_search')) {
        this.toolRegistry.unregister('web_search');
      }

      // Clear session when switching between different providers
      // (message formats are incompatible across providers)
      if (providerChanged && this.messages.length > 0) {
        this.messages = [];
        this._totalInputTokens = 0;
        this._totalOutputTokens = 0;
        this._turnCount = 0;
        this.clearContextTokenAnchors(true);
        this._servedModel = undefined;
        this._servedContextWindow = undefined;
        this.sessionId = null;
        this.emit('session_new');
        return 'cleared';
      }
      return 'ok';
    } catch (err) {
      this.emit('agent_event', {
        type: 'error',
        error: `Cannot set model "${model}": ${(err as Error).message}`,
        timestamp: Date.now(),
      });
      return 'error';
    }
  }

  /** Switch permission mode */
  setMode(mode: PermissionMode): void {
    if (mode !== this._mode) this.systemPromptAnchor = null;
    this._mode = mode;
    this.permissions.setMode(mode);

    if (mode === 'plan') {
      // Generate plan file path on entering plan mode (if not already set)
      if (!this._planFilePath && this._planUtils) {
        const slug = this._planUtils.generatePlanSlug();
        this._planFilePath = this._planUtils.resolvePlanFilePath(slug);
      }
      this.permissions.setPlanFilePath(this._planFilePath ?? undefined);
    } else {
      // Leaving plan mode — clear plan file from permissions (but keep path for reference)
      this.permissions.setPlanFilePath(undefined);
    }
  }

  /** Set thinking level (Claude: on/off) */
  setThinkingLevel(level: string): void {
    this._thinkingLevel = level;
  }

  /** Set reasoning effort (Codex: low/medium/high/xhigh) */
  setReasoningEffort(level: string | null): void {
    this._reasoningEffort = level;
  }

  /** Set fast mode (service_tier: 'fast' — 1.5x speed, 2x credits) */
  setFastMode(enabled: boolean): void {
    this._fastMode = enabled;
  }

  /** Delete a session by ID */
  deleteSession(id: string): boolean {
    if (!this.store) return false;
    return this.store.deleteSession(id);
  }

  /** Trigger context compaction */
  async compact(instructions?: string): Promise<TuiCompactResult> {
    const beforeMessages = this.messages.length;
    const beforeTokens = this.estimateContextTokensFor(this.messages);
    if (!this.sessionId || this.messages.length === 0 || !this.provider) {
      return {
        compacted: false,
        reason: 'No active session to compact.',
        messages: this.messages,
        sanitizedRemoved: 0,
        beforeMessages,
        afterMessages: this.messages.length,
        beforeTokens,
        afterTokens: beforeTokens,
      };
    }
    if (this._isTurnActive || this.abortController || this.maintenanceAbortController) {
      return {
        compacted: false,
        reason: this.maintenanceAbortController
          ? 'Manual compaction is already running.'
          : 'A turn is still running. Interrupt or wait for it to finish before compacting.',
        messages: this.messages,
        sanitizedRemoved: 0,
        beforeMessages,
        afterMessages: this.messages.length,
        beforeTokens,
        afterTokens: beforeTokens,
      };
    }

    const sanitized = this.sanitizeRecoveredTranscript(this.messages);
    if (sanitized.removed > 0) {
      this.messages = sanitized.messages;
      this.store.replaceMessages(this.sessionId, sanitized.messages);
      this.clearContextTokenAnchors();
      logger.info({ sessionId: this.sessionId, removed: sanitized.removed }, 'Sanitized internal recovery messages before manual compaction');
    }

    const controller = new AbortController();
    this.maintenanceAbortController = controller;
    try {
      const { compactMessages } = await import('../state/compaction.js');
      const {
        isTransientProviderFailure,
        resolveRetryDelayMs,
        retryAfterMsFromError,
        sleepMs,
        summarizeFailureReason,
      } = await import('../provider/transient-errors.js');
      const maxContextTokens = this.effectiveMaxContextTokens(this.provider);
      let retryAttempt = 0;

      for (;;) {
        try {
          const { messages: compacted, compacted: didCompact } = await this.runCompactionWithHeartbeat(
            compactMessages,
            this.provider,
            maxContextTokens,
            {
              force: true,
              customInstructions: instructions,
              abortSignal: controller.signal,
              overheadTokens: this._systemOverheadTokens,
              planFilePath: this._planFilePath ?? undefined,
              allowNonReducing: true,
            },
            'manual',
          );
          if (!didCompact) {
            throw new Error('Manual compaction returned without rewriting the context');
          }

          this.messages.length = 0;
          this.messages.push(...compacted);
          this.store.replaceMessages(this.sessionId, compacted);
          this.clearContextTokenAnchors();
          return {
            compacted: true,
            messages: this.messages,
            sanitizedRemoved: sanitized.removed,
            beforeMessages,
            afterMessages: this.messages.length,
            beforeTokens,
            afterTokens: this.estimateContextTokensFor(this.messages),
          };
        } catch (err) {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? err;
          }
          const message = (err as Error)?.message ?? String(err);
          const status = (err as { status?: number }).status;
          const code = (err as { code?: string | number }).code;
          const retryable = (err as { retryable?: boolean }).retryable;
          if (!isTransientProviderFailure({ message, code, status, retryable })) {
            throw err;
          }

          const delayMs = resolveRetryDelayMs({
            attempt: retryAttempt,
            retryAfterMs: retryAfterMsFromError(err),
          });
          retryAttempt++;
          const reason = summarizeFailureReason(message);
          const notice = `Manual compaction temporarily unavailable${reason ? `: ${reason}` : ''}`
            + `; retrying in ${Math.max(1, Math.round(delayMs / 1000))}s (attempt ${retryAttempt}, Esc to cancel)...`;
          logger.warn(
            { sessionId: this.sessionId, status, code, retryAttempt, delayMs, err: message },
            'Manual compaction waiting for a transient provider failure to clear',
          );
          this.emitProviderStatus(notice, 'compaction_manual_retry');
          this.upsertInterruptCheckpoint(notice, 'maintenance');
          await sleepMs(delayMs, controller.signal);
        }
      }
    } finally {
      if (this.maintenanceAbortController === controller) {
        this.maintenanceAbortController = null;
      }
    }
  }

  /** Interrupt current turn */
  interrupt(): void {
    this.pendingInputQueue = [];
    this.abortController?.abort();
    this.maintenanceAbortController?.abort(new Error('Manual compaction interrupted'));
    this.resumeAbortController?.abort(new Error('Session resume interrupted'));
  }

  /**
   * Queue user input to be delivered at the next natural turn boundary.
   *
   * This used to abort the live LLM stream so the message landed "ASAP", which
   * meant typing while the agent worked silently truncated its turn mid-answer
   * — throwing away partial reasoning and any in-flight tool round, and making
   * the input box's own "press Enter to queue" affordance a lie. Queued input
   * now waits for the agent to finish its current turn (Codex-style); the user
   * keeps an explicit interrupt via Esc.
   *
   * `interrupt: true` restores the old cut-the-stream behaviour for callers
   * that genuinely want it.
   */
  queueInput(
    prompt: string,
    images?: Array<{ base64: string; mediaType: string }>,
    opts?: { interrupt?: boolean },
  ): void {
    this.pendingInputQueue.push({ prompt, images });
    const forceInterrupt = opts?.interrupt
      ?? process.env['SHIZUHA_TUI_INTERRUPT_ON_SUBMIT'] === '1';
    if (forceInterrupt) this.abortController?.abort();
  }

  /**
   * Deliver EVERY queued message as the next user turn.
   *
   * This used to `.shift()` a single entry, so N queued messages needed N turn
   * boundaries to reach the agent. Anything that consumed a boundary without
   * draining — or any turn that ended through a path other than the one the
   * user was watching — left the rest sitting in the queue while the agent
   * carried on, and the operator watched "+2 more queued" persist across turn
   * after turn (2026-08-05):
   *
   *     is it that the harness is queueing messages until the next turn but
   *     skipping a lot of turns? .. ideally it should send all queued messages
   *     at the next turn at once
   *
   * Draining the whole queue also keeps the messages in the order they were
   * typed, which a one-per-turn drain could not guarantee once the user queued
   * a correction behind the message it corrects.
   *
   * Images were dropped outright here: the queued entry carried them, and this
   * built a text-only message. A queued screenshot silently became nothing.
   *
   * Returns false when the queue is empty so callers fall through to their
   * normal completion path.
   */
  private drainQueuedInput(): boolean {
    if (this.pendingInputQueue.length === 0) return false;
    const pending = this.pendingInputQueue;
    this.pendingInputQueue = [];
    for (const item of pending) {
      this.emit('agent_event', {
        type: 'input_injected', prompt: item.prompt, timestamp: Date.now(),
      });
      // Same content shape as submitPrompt so a queued image behaves exactly
      // like one sent directly.
      let content: unknown = item.prompt;
      if (item.images && item.images.length > 0) {
        const blocks: Array<{
          type: string;
          text?: string;
          source?: { type: string; data: string; media_type: string };
        }> = [];
        for (const img of item.images) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', data: img.base64, media_type: img.mediaType },
          });
        }
        blocks.push({ type: 'text', text: item.prompt });
        content = blocks;
      }
      const userMsg: Message = {
        role: 'user', content: content as string, timestamp: Date.now(),
      };
      this.messages.push(userMsg);
      this.store.appendMessage(this.sessionId!, userMsg);
    }
    this._turnPromptExcerpt = this.promptExcerpt(
      pending.map((item) => item.prompt).join('\n\n'),
    );
    return true;
  }

  /** Remove all queued user input and return it for editing. */
  dequeuePendingInput(): Array<{ prompt: string; images?: Array<{ base64: string; mediaType: string }> }> {
    const pending = [...this.pendingInputQueue];
    this.pendingInputQueue = [];
    return pending;
  }

  /** Number of messages waiting in the input queue. */
  get pendingInputCount(): number {
    return this.pendingInputQueue.length;
  }

  /** Get list of available providers */
  availableProviders(): string[] {
    return this.providerRegistry?.list() ?? [];
  }

  /** Get available models for the model picker */
  availableModels(): ModelInfo[] {
    const models: ModelInfo[] = [];

    // Try reading Codex CLI models cache first (most detailed, includes descriptions)
    let codexCacheLoaded = false;
    try {
      const cachePath = path.join(process.env['HOME'] ?? '~', '.codex', 'models_cache.json');
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (data?.models && Array.isArray(data.models)) {
        codexCacheLoaded = true;
        for (const m of data.models) {
          // gpt-5.x and gpt-oss-* models require codex auth (ChatGPT backend);
          // gpt-4.x models use the standard OpenAI API
          const isCodexModel = m.slug.startsWith('gpt-5') || m.slug.startsWith('gpt-oss-');
          models.push({
            slug: m.slug,
            displayName: m.display_name ?? m.slug,
            description: m.description ?? '',
            provider: isCodexModel ? 'codex' : 'openai',
            group: 'OpenAI / Codex',
            reasoningLevels: (m.supported_reasoning_levels ?? []).map((l: { effort: string }) => l.effort),
            visibility: m.visibility === 'hide' ? 'hide' : 'list',
          });
        }
      }
    } catch { /* no cache */ }

    if (!codexCacheLoaded) {
      // Fallback — key Codex models only
      const defaultEffortLevels = ['low', 'medium', 'high', 'xhigh'];
      const codexModels: Array<{ slug: string; desc: string; levels?: string[] }> = [
        { slug: 'gpt-5.5', desc: 'Latest frontier model', levels: defaultEffortLevels },
        { slug: 'gpt-5.2-codex', desc: 'Frontier agentic coding model', levels: defaultEffortLevels },
        { slug: 'gpt-5.1-codex-max', desc: 'Deep and fast reasoning', levels: defaultEffortLevels },
      ];
      for (const { slug, desc, levels } of codexModels) {
        const isCodexModel = slug.startsWith('gpt-5') || slug.startsWith('gpt-oss-');
        models.push({
          slug, displayName: slug, description: desc, provider: isCodexModel ? 'codex' : 'openai',
          group: 'OpenAI / Codex', reasoningLevels: levels ?? [], visibility: 'list',
        });
      }
    }

    // Anthropic models (grayed out if provider not configured)
    const claudeModels: Array<{ slug: string; desc: string }> = [
      { slug: 'claude-opus-5', desc: 'Most capable, deep reasoning' },
      { slug: 'claude-opus-4-7', desc: 'Previous-generation Opus' },
      { slug: 'claude-sonnet-4-6', desc: 'Best balance of speed and capability' },
      { slug: 'claude-haiku-4-5-20251001', desc: 'Fast and lightweight' },
    ];
    for (const { slug, desc } of claudeModels) {
      models.push({
        slug, displayName: slug, description: desc, provider: 'anthropic',
        group: 'Anthropic / Claude', reasoningLevels: [], visibility: 'list',
      });
    }

    // Google models (grayed out if provider not configured)
    const googleModels: Array<{ slug: string; desc: string }> = [
      { slug: 'gemini-2.5-pro', desc: 'Advanced reasoning and coding' },
      { slug: 'gemini-2.5-flash', desc: 'Fast and efficient' },
    ];
    for (const { slug, desc } of googleModels) {
      models.push({
        slug, displayName: slug, description: desc, provider: 'google',
        group: 'Google / Gemini', reasoningLevels: [], visibility: 'list',
      });
    }

    // GitHub Copilot models (only if configured — uses Copilot Pro+ subscription)
    if (this.providerRegistry?.list().includes('copilot') || this.providerRegistry?.list().includes('litellm')) {
      const copilotModels: Array<{ slug: string; desc: string }> = [
        { slug: 'copilot/claude-opus-4.6', desc: 'Claude Opus 4.6 via Copilot Pro+' },
        { slug: 'copilot/claude-sonnet-4.6', desc: 'Claude Sonnet 4.6 via Copilot Pro+' },
        { slug: 'copilot/gpt-4.1', desc: 'GPT-4.1 via Copilot Pro+' },
        { slug: 'copilot/o3', desc: 'o3 via Copilot Pro+' },
        { slug: 'copilot/gemini-2.5-pro', desc: 'Gemini 2.5 Pro via Copilot Pro+' },
      ];
      for (const { slug, desc } of copilotModels) {
        models.push({
          slug, displayName: slug, description: desc, provider: 'copilot',
          group: 'GitHub Copilot', reasoningLevels: [], visibility: 'list',
        });
      }
    }

    // OpenRouter models (only if configured)
    if (this.providerRegistry?.list().includes('openrouter')) {
      const orModels = [
        'anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-6',
        'openai/gpt-4.1', 'google/gemini-2.5-pro',
        'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b',
        'mistralai/mistral-large', 'qwen/qwen3-coder',
      ];
      for (const slug of orModels) {
        models.push({
          slug, displayName: slug, description: '',
          provider: 'openrouter', group: 'OpenRouter',
          reasoningLevels: [], visibility: 'list',
        });
      }
    }

    // vLLM models (self-hosted, e.g. DGX Spark)
    // Shizuha / Cortex — our own inference gateway (GLM-4.7 etc.), shown as a first-class
    // branded provider alongside OpenAI/Anthropic. The scaffold talks ONLY to Cortex (a
    // hosted OpenAI-compatible service) — we deliberately do NOT expose a direct vLLM
    // group; vLLM is an internal implementation detail behind Cortex. Models are
    // discovered live from the Cortex /v1/models endpoint.
    if (this.providerRegistry?.list().includes('cortex')) {
      // SCLI-162: source the Cortex picker list from a LIVE per-session
      // /v1/models call (the served set) — never a static catalog. liveModelIds
      // stays null when Cortex is unreachable so assembleCortexModels() renders a
      // clearly-marked offline fallback instead of presenting stale models as
      // live. The previous code unconditionally injected DEFAULT_CORTEX_MODEL
      // (a retired GLM-4.7), which is exactly why stale models appeared.
      let liveModelIds: string[] | null = null;
      try {
        const configuredUrl = resolveCortexBaseUrl(this.config);
        const cortexUrl = configuredUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
        const token = resolveCortexAuthToken(this.config);
        const authHeader = token ? ` -H ${JSON.stringify(`Authorization: Bearer ${token}`)}` : '';
        const raw = execSync(`curl -sf${authHeader} ${JSON.stringify(`${cortexUrl}/models`)} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
        const data = JSON.parse(raw) as { data?: Array<{ id: string }> };
        liveModelIds = (data.data ?? []).map((m) => m.id);
      } catch { /* offline or unreachable -> liveModelIds stays null */ }
      for (const info of assembleCortexModels(liveModelIds)) {
        models.push(info);
      }
    }

    // Ollama (local) models
    if (this._ollamaModels.length > 0) {
      for (const slug of this._ollamaModels) {
        models.push({
          slug, displayName: slug, description: 'local', provider: 'ollama',
          group: 'Ollama / Local', reasoningLevels: [], visibility: 'list',
        });
      }
    }

    return models;
  }

  /** List all MCP tools from connected servers */
  async listMCPTools(): Promise<Array<{ name: string; description: string }>> {
    if (!this.mcpManager) return [];
    try {
      const tools = await this.mcpManager.listAllTools();
      return tools.map((t) => ({ name: t.name, description: t.description }));
    } catch {
      return [];
    }
  }

  /**
   * Rename current session.
   * SCLI-390: returns true only when a durable session id exists and was renamed.
   * Callers must not emit success wording on false (no active session).
   */
  renameSession(name: string): boolean {
    if (this.sessionId && this.store) {
      this.store.renameSession(this.sessionId, name);
      return true;
    }
    return false;
  }

  /** Fork current session — returns new session ID */
  forkSession(): string | null {
    if (!this.sessionId || !this.store) return null;
    const forked = this.store.forkSession(this.sessionId);
    return forked?.id ?? null;
  }

  /** Clean shutdown */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.resumeGeneration++;
    this.interrupt();
    try { this._stopShizuhaAuthAutoRefresh?.(); } catch { /* ignore */ }
    this._stopShizuhaAuthAutoRefresh = null;
    try { await this.mcpManager?.disconnectAll(); } catch { /* ignore */ }
    try { this.store?.close(); } catch { /* ignore */ }
    this.removeAllListeners();
  }
}
