import type { Message, ToolCall, ContentBlock } from './types.js';
import type { LLMProvider, ChatMessage, ChatContentBlock, StreamChunk, ChatOptions } from '../provider/types.js';
import type { ToolHandler, ToolResult, ToolContext, ToolDefinition } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionEngine } from '../permissions/engine.js';
import type { AgentEventEmitter } from '../events/emitter.js';
import type { HookEngine } from '../hooks/engine.js';
import type { BackgroundTaskRegistry } from '../tasks/registry.js';
import { PerfTimer, formatPerfStatus, ttftWarnThresholdMs } from '../utils/perf-metrics.js';
import { salvageDsmlToolCalls } from './dsml-salvage.js';
import { countTokens } from '../utils/tokens.js';
import { getSafetyFactor } from '../prompt/context.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ToolRetryBudget,
  executeToolWithRetry,
  DEFAULT_TOOL_RETRY_CONFIG,
  type ToolRetryConfig,
} from './tool-retry.js';
import { getModelProfile } from '../provider/model-profile.js';
import { PrefixFingerprintTracker, computePrefixFingerprint } from '../telemetry/prefix-fingerprint.js';
import { buildProviderPrefixSnapshot, type ProviderPrefixContinuity, type ProviderPrefixSnapshot } from '../telemetry/provider-prefix-continuity.js';
import { detectOutputDegeneracy, detectScriptCollapse, formatDegeneracyStopNotice, messagesHaveRecentToolWork } from './output-degeneracy-guard.js';
import { requestAwareToolStreamTimeoutMs } from '../provider/stream-timeout.js';

/** SCLI debug mode: when SHIZUHA_DEBUG_DIR is set, dump the EXACT context sent to the
 *  model each turn (system prompt + full message history + tools + params) as NDJSON,
 *  so any turn can be reproduced byte-for-byte to diagnose scaffold/harness issues. */
function dumpTurnContext(model: string, systemPrompt: string, toolDefs: ToolDefinition[],
  chatMessages: ChatMessage[], maxOutputTokens: number, temperature?: number): void {
  // Trigger via env, OR a workspace flag file (no container env-injection needed).
  let dir = process.env['SHIZUHA_DEBUG_DIR'];
  if (!dir) {
    try { if (fs.existsSync('/workspace/.shizuha-debug')) dir = '/workspace/.shizuha-debug-dumps'; } catch { /* */ }
  }
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'turns.ndjson'), JSON.stringify({
      phase: 'request',
      ts: new Date().toISOString(),
      model, maxOutputTokens, temperature,
      systemPromptChars: systemPrompt.length,
      systemPrompt,
      tools: toolDefs.map((t) => t.name),
      messageCount: chatMessages.length,
      messages: chatMessages,
    }) + '\n');
  } catch { /* debug is best-effort, never break a turn */ }
}
import { logger } from '../utils/logger.js';

const prefixFingerprintTracker = new PrefixFingerprintTracker();

function estimateProviderInputTokens(
  model: string,
  systemPrompt: string,
  toolDefs: ToolDefinition[],
  chatMessages: ChatMessage[],
): number {
  const raw = countTokens(systemPrompt, model)
    + (toolDefs.length > 0 ? countTokens(JSON.stringify(toolDefs), model) : 0)
    + countTokens(JSON.stringify(chatMessages), model);
  return Math.ceil(raw * getSafetyFactor(model));
}

/**
 * Detect a "faked" MCP tool call — where the model, instead of emitting a real
 * tool call, runs `bash`/`shell` to merely echo/print the tool's name (e.g.
 * `echo "mcp__shizuha-pulse__pulse_list_workflows"` or `echo "Need to call
 * pulse_list_workflows"`). Weaker open models fall into this when a discovered
 * MCP tool isn't visibly callable (e.g. after a resume that lost the in-memory
 * discovered set) and then imitate the pattern from their own transcript,
 * looping until the loop-guard stops them.
 *
 * Returns the real tool name the model was trying to invoke, or null. Only
 * fires on a PURE echo/printf (no pipes, redirects, chaining, or subshells) so
 * legitimate shell work that happens to mention a tool name is never caught.
 */
export function detectFakedMcpToolCall(tc: ToolCall, registry: ToolRegistry): string | null {
  if (tc.name !== 'bash' && tc.name !== 'shell') return null;
  const input = tc.input as Record<string, unknown> | undefined;
  const cmd = typeof input?.['command'] === 'string'
    ? (input['command'] as string)
    : typeof input?.['cmd'] === 'string'
      ? (input['cmd'] as string)
      : '';
  if (!cmd) return null;
  // Bail if the command does any real shell work — only bare echo/printf qualifies.
  if (/[|&;<>`]|\$\(/.test(cmd)) return null;
  const m = cmd.match(/^\s*(?:echo|printf)\s+(.+)$/s);
  if (!m) return null;
  const payload = m[1] ?? '';
  const mcpDefs = registry.list().filter((d) => d.name.startsWith('mcp__'));
  // Direct full-name match by substring — robust to hyphens in the server segment
  // (e.g. mcp__shizuha-pulse__...) and surrounding quotes, which a token regex splits.
  for (const def of mcpDefs) {
    if (payload.includes(def.name)) return def.name;
  }
  // Bare-suffix match (e.g. "Need to call pulse_list_workflows" → the full tool).
  const tokens = payload.match(/[A-Za-z_][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*/g) ?? [];
  const tokenSet = new Set(tokens);
  for (const def of mcpDefs) {
    const suffix = def.name.slice(def.name.lastIndexOf('__') + 2);
    if (suffix.length >= 6 && tokenSet.has(suffix)) return def.name;
  }
  return null;
}

/** Callback for interactive permission approval (TUI) */
export type PermissionAskCallback = (
  toolName: string,
  input: Record<string, unknown>,
  riskLevel: 'low' | 'medium' | 'high',
) => Promise<'allow' | 'deny' | 'allow_always'>;

export interface TurnResult {
  assistantMessage: Message;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** SCLI-21/31: per-turn perf, surfaced for the telemetry sink. */
  ttftMs?: number | null;
  decodeTokensPerSec?: number | null;
  /** Provider's own prompt token estimate (may differ from usage.prompt_tokens). */
  providerPromptEstimate?: number;
  /**
   * SCLI-218: concrete model the backend served this turn (differs from the
   * requested model for virtual aliases like cortex/auto). The loop re-resolves
   * its compaction window when this changes mid-session.
   */
  servedModel?: string;
  /** Backend-advertised context window for servedModel, when the provider knows it. */
  servedContextWindow?: number;
}

/**
 * Return the client-defined tools that are safe to send to a provider.
 *
 * Providers advertising native web search append their own server-side
 * `web_search` tool to the request. Cross-provider fallback can reach one of
 * those providers with a registry built for a non-native provider, so exclude
 * the client implementation at the final shared request boundary. Keep the
 * caller's array untouched because a later fallback may still need it.
 */
export function toolDefinitionsForProvider(
  toolDefs: ToolDefinition[],
  provider: Pick<LLMProvider, 'supportsNativeWebSearch'>,
): ToolDefinition[] {
  if (!provider.supportsNativeWebSearch) return toolDefs;
  return toolDefs.filter((tool) => tool.name !== 'web_search');
}

/** Convert agent messages to chat messages for the LLM */
/** Assemble the provider payload from a frozen wire prefix plus the converted
 *  internal tail. The prefix region is the STORED payload verbatim — identity,
 *  not re-derivation — so `assemble(prefix, msgs).slice(0, prefix.messages.length)`
 *  is byte-identical to the previous send by construction. Falls back to full
 *  conversion when the prefix is absent, stale (sourceCount > messages), or
 *  the assembled payload would overflow the context window (safety valve for
 *  any in-place trim that bypassed replaceMessages). */
export function assembleWireChatMessages(
  messages: Message[],
  wirePrefix?: { sourceCount: number; messages: ChatMessage[] },
  contextWindow?: number,
): { chatMessages: ChatMessage[]; usedWirePrefix: boolean } {
  if (
    !wirePrefix
    || wirePrefix.sourceCount <= 0
    || wirePrefix.sourceCount > messages.length
    || !Array.isArray(wirePrefix.messages)
    || wirePrefix.messages.length === 0
  ) {
    return { chatMessages: messagesToChat(messages), usedWirePrefix: false };
  }
  const tail = messagesToChat(messages.slice(wirePrefix.sourceCount));
  const assembled = [...wirePrefix.messages, ...tail];
  if (contextWindow && contextWindow > 0) {
    const approxTokens = Math.ceil(
      assembled.reduce((n, m) => n + JSON.stringify(m).length, 0) / 3,
    );
    if (approxTokens > contextWindow * 0.98) {
      return { chatMessages: messagesToChat(messages), usedWirePrefix: false };
    }
  }
  return { chatMessages: assembled, usedWirePrefix: true };
}

export function messagesToChat(messages: Message[]): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content } as ChatMessage;
    }
    const blocks = (m.content as ContentBlock[]).map((b): ChatContentBlock => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      if (b.type === 'reasoning') return { type: 'reasoning', id: b.id, encryptedContent: b.encryptedContent, rawContent: b.rawContent, signature: b.signature, summary: b.summary };
      return { type: 'tool_result', toolUseId: b.toolUseId, content: b.content, isError: b.isError, image: b.image };
    });
    return { role: m.role, content: blocks } as ChatMessage;
  });
}

/** Max concurrent read-only tools to execute during streaming */
const MAX_CONCURRENT_STREAMING_TOOLS = 8;

/** Execute a single turn: send messages to LLM, stream response, execute tool calls.
 *
 * Read-only tools start executing as soon as their input is complete during streaming,
 * overlapping API latency with tool execution. Write tools execute sequentially after
 * streaming completes.
 */
export async function executeTurn(
  messages: Message[],
  provider: LLMProvider,
  model: string,
  systemPrompt: string,
  toolDefs: ToolDefinition[],
  toolRegistry: ToolRegistry,
  permissions: PermissionEngine,
  emitter: AgentEventEmitter,
  context: ToolContext,
  maxOutputTokens: number,
  temperature?: number,
  onPermissionAsk?: PermissionAskCallback,
  hookEngine?: HookEngine,
  thinkingLevel?: string,
  abortSignal?: AbortSignal,
  reasoningEffort?: string,
  fastMode?: boolean,
  paramCoercion?: (input: Record<string, unknown>) => Record<string, unknown>,
  toolRetry?: ToolRetryConfig,
  providerPrefixContinuity?: {
    contextWindow?: number;
    observe?: (snapshot: ProviderPrefixSnapshot) => ProviderPrefixContinuity | void;
    /** Frozen provider-wire payload prefix (the exact ChatMessage[] last
     *  SENT). When present, the payload is stored_prefix ++ convert(tail) BY
     *  CONSTRUCTION — restart re-serialization divergence is impossible
     *  (operator 2026-08-08). */
    wirePrefix?: { sourceCount: number; messages: ChatMessage[] };
    /** Called with the exact payload sent + the internal message count it
     *  covers, so the caller can persist it as the next frozen prefix. */
    captureWirePayload?: (chatMessages: ChatMessage[], internalCount: number) => void;
    /** Caller-authoritative prompt estimate used by live token progress. */
    inputTokenEstimate?: number;
    /**
     * Cortex cold-prefill attribution tag. After compaction, the next
     * interactive call is expected-cold (`post_compaction`); mid-session
     * interactive high TTFT without this tag is the ideally-zero surface.
     */
    requestKind?: string;
    /** Set when Cortex reports that the exact current session home is in
     * warm-only soft drain and needs an out-of-band full-prefix handoff. */
    onCortexRehomeRequired?: () => void;
  },
  toolChoice?: ChatOptions['toolChoice'],
): Promise<TurnResult> {
  // SCLI-20(a): a single bounded retry budget for this turn. Created here so it
  // resets every turn and is shared across all of the turn's tool calls — a
  // flaky dependency can burn the budget but cannot make one turn spin forever.
  const retryConfig = toolRetry ?? DEFAULT_TOOL_RETRY_CONFIG;
  const retryBudget = new ToolRetryBudget(retryConfig);
  // Inject background task status/progress before this turn's API call.
  // This is the push-notification mechanism — completed tasks get surfaced
  // as system-reminder messages so the model knows without polling.
  if (context.taskRegistry) {
    const attachments = context.taskRegistry.collectAttachments();
    for (const att of attachments) {
      let text: string;
      if (att.type === 'task_status') {
        const parts = [
          `Background task ${att.taskId} (${att.taskType}) has ${att.status}.`,
          `Description: ${att.description}`,
        ];
        if (att.deltaOutput) parts.push(`Output:\n${att.deltaOutput}`);
        if (att.error) parts.push(`Error: ${att.error}`);
        parts.push('You can read the full output using the TaskOutput tool.');
        text = parts.join('\n');
      } else {
        text = `Background task ${att.taskId} (${att.taskType}) is still running: ${att.description}`;
        if (att.deltaOutput) text += `\nRecent output:\n${att.deltaOutput}`;
      }
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `<system-reminder>${text}</system-reminder>` }],
        timestamp: Date.now(),
      });
    }
  }

  const { chatMessages } = assembleWireChatMessages(
    messages,
    providerPrefixContinuity?.wirePrefix,
    providerPrefixContinuity?.contextWindow,
  );
  providerPrefixContinuity?.captureWirePayload?.(chatMessages, messages.length);
  const modelProfile = getModelProfile(model);
  const providerToolDefs = toolDefinitionsForProvider(toolDefs, provider);
  const providerPrefixSnapshot = buildProviderPrefixSnapshot({
    model,
    contextWindow: providerPrefixContinuity?.contextWindow,
    systemPrompt,
    tools: providerToolDefs,
    chatMessages,
  });
  const providerPrefixObservation = providerPrefixContinuity?.observe?.(providerPrefixSnapshot);
  if (providerPrefixObservation?.cacheBreaking) {
    emitter.emit({
      type: 'provider_status',
      code: 'prefix_cache_break',
      level: 'warning',
      provider: provider.name,
      message: `Provider payload cache break: append_only=false reason=${providerPrefixObservation.primaryReason ?? 'unknown'} (${providerPrefixObservation.reasons.join(', ')}).`,
      sessionId: context.sessionId,
      timestamp: Date.now(),
    });
  }

  // Stream LLM response
  let text = '';
  let finalText: string | undefined;
  const toolCalls: ToolCall[] = [];
  const reasoningBlocks: Array<{ id: string; encryptedContent?: string | null; rawContent?: string; signature?: string; summary?: Array<{ text: string }> }> = [];
  let rawReasoningText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | undefined;
  let cacheCreationInputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  let providerPromptEstimate: number | undefined;
  let servedModel: string | undefined;          // SCLI-218
  let servedContextWindow: number | undefined;  // SCLI-218
  let outputDegeneracyReason: string | undefined;
  let outputDegeneracyEvidence: string | undefined;
  const workingTurn = messagesHaveRecentToolWork(messages);

  const pendingToolInputs = new Map<string, { name: string; inputStr: string }>();

  // Track in-flight read-only tool executions started during streaming
  const inflightResults = new Map<string, Promise<ToolResult>>(); // toolCallId → promise
  let inflightCount = 0;

  let streamAborted = false;
  let _yieldCounter = 0;
  dumpTurnContext(model, systemPrompt, providerToolDefs, chatMessages, maxOutputTokens, temperature);
  if (process.env['SHIZUHA_DEBUG_PREFIX'] === '1') {
    const fp = computePrefixFingerprint({ systemPrompt, tools: providerToolDefs, model, profile: modelProfile.displayName });
    const observed = prefixFingerprintTracker.observe(`${provider.name}:${model}`, fp);
    logger.info({
      model,
      provider: provider.name,
      prefixHash: fp.hash,
      systemPromptHash: fp.systemPromptHash,
      toolSchemaHash: fp.toolSchemaHash,
      toolCount: fp.toolCount,
      systemPromptChars: fp.systemPromptChars,
      comparison: observed,
    }, 'SCLI prefix fingerprint');
  }
  // SCLI-21: per-turn perf measurement at the stream consumer — one
  // instrumentation point covers every provider.
  const perfTimer = new PerfTimer();
  const estimatedInputTokens = providerPrefixContinuity?.inputTokenEstimate
    && providerPrefixContinuity.inputTokenEstimate > 0
    ? providerPrefixContinuity.inputTokenEstimate
    : estimateProviderInputTokens(model, systemPrompt, providerToolDefs, chatMessages);
  let liveInputTokens = estimatedInputTokens;
  let liveOutputTokens = 0;
  let firstOutputAt: number | null = null;
  let lastTokenProgressAt = 0;
  const emitTokenProgress = (estimated: boolean, force = false) => {
    const now = Date.now();
    if (!force && now - lastTokenProgressAt < 500) return;
    lastTokenProgressAt = now;
    let outputTokensPerSec: number | null = null;
    if (firstOutputAt !== null && liveOutputTokens > 0) {
      const elapsedMs = Math.max(1, now - firstOutputAt);
      outputTokensPerSec = Math.round((liveOutputTokens / elapsedMs) * 1000);
    }
    emitter.emit({
      type: 'token_progress',
      inputTokens: liveInputTokens,
      outputTokens: liveOutputTokens,
      outputTokensPerSec,
      estimated,
      timestamp: now,
    });
  };
  const addOutputDelta = (delta: string | undefined) => {
    if (!delta) return;
    liveOutputTokens += Math.max(1, Math.ceil(countTokens(delta, model) * getSafetyFactor(model)));
    if (firstOutputAt === null) firstOutputAt = Date.now();
    emitTokenProgress(true);
  };
  emitTokenProgress(true, true);
  // SCLI-22: populated from perf.ttftMs after the stream (PerfTimer is the
  // authoritative source per SCLI-21; no separate wall-clock measurement needed).
  let ttftMs: number | null = null;

  // SCLI-32: fallback stall watchdog for providers without their own SCLI-22
  // inactivity timer. It must not false-file before the provider/request budget has
  // expired, so the first-token deadline is derived from API_TIMEOUT_MS instead of
  // an arbitrary 120s wall-clock. Providers with their own watchdog still emit
  // stall_timeout earlier and clear this timer in finally.
  const PROVIDER_REQUEST_TIMEOUT_MS = parseInt(process.env['API_TIMEOUT_MS'] || '600000', 10);
  // This is a BACKSTOP for providers that have no stall watchdog of their own.
  // It must never fire before a provider's OWN configured budget, or it silently
  // overrides that configuration. The vLLM provider reads VLLM_STREAM_STALL_MS
  // (benchmarks set 1_800_000 for long reasoning turns) while this fallback was
  // pinned at 605s, so a legitimately-thinking model was declared stalled at
  // ~605s — observed killing hard-chess-engine mid-stream after one turn with an
  // empty workspace, which grades identically to a model that wrote nothing.
  const providerStallFloor = (name: string, fallback: number): number => {
    const raw = parseInt(process.env[name] || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  const FALLBACK_FIRST_TOKEN_MS = Math.max(
    120_000,
    PROVIDER_REQUEST_TIMEOUT_MS + 5_000,
    providerStallFloor('VLLM_FIRST_TOKEN_TIMEOUT_MS', 0) + 5_000,
  );
  const FALLBACK_STREAM_MS = Math.max(
    600_000,
    PROVIDER_REQUEST_TIMEOUT_MS + 5_000,
    providerStallFloor('VLLM_STREAM_STALL_MS', 0) + 5_000,
    provider.name === 'vllm' || provider.name === 'cortex'
      ? requestAwareToolStreamTimeoutMs({
          baseMs: providerStallFloor('VLLM_STREAM_STALL_MS', 1),
          maxTokens: maxOutputTokens,
          hasTools: providerToolDefs.length > 0,
          toolChoice,
        }) + 5_000
      : 0,
  );
  let fbGotFirstChunk = false;
  let fbStallTimer: ReturnType<typeof setTimeout> | null = null;
  const armFbStall = () => {
    if (fbStallTimer) clearTimeout(fbStallTimer);
    // Cortex owns liveness for an accepted stream. Its provider retains a
    // bounded pre-header watchdog, so a second heuristic timer here can only
    // mislabel a valid buffered tool call. Transport comments stay internal to
    // the provider and never masquerade as semantic agent progress.
    if (provider.name === 'cortex') {
      fbStallTimer = null;
      return;
    }
    const ms = fbGotFirstChunk ? FALLBACK_STREAM_MS : FALLBACK_FIRST_TOKEN_MS;
    fbStallTimer = setTimeout(() => {
      emitter.emit({
        type: 'provider_status' as const,
        code: 'stall_timeout',
        message: `No response from ${provider.name} after provider timeout budget (${Math.round(ms / 1000)}s)`,
        level: 'warning' as const,
        provider: provider.name,
        timestamp: Date.now(),
      });
    }, ms);
  };
  armFbStall();

  try {
    stream_loop: for await (const chunk of provider.chat(chatMessages, {
      model,
      systemPrompt,
      tools: providerToolDefs.length > 0 ? providerToolDefs : undefined,
      ...(toolChoice ? { toolChoice } : {}),
      maxTokens: maxOutputTokens,
      temperature,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(fastMode ? { serviceTier: 'priority' as const } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      // PLAT-4189: first interactive turn after compaction is expected-cold.
      ...(providerPrefixContinuity?.requestKind
        ? { requestKind: providerPrefixContinuity.requestKind }
        : {}),
      ...(providerPrefixContinuity?.onCortexRehomeRequired
        ? { onCortexRehomeRequired: providerPrefixContinuity.onCortexRehomeRequired }
        : {}),
      abortSignal,
    })) {
      // Check abort signal — break out of streaming immediately
      if (abortSignal?.aborted) { streamAborted = true; break; }

      // SCLI-21: TTFT = first model-output chunk (not usage/stop bookkeeping).
      // EXCLUDE 'thinking' — it's a content-less keep-alive heartbeat (types.ts)
      // emitted when a reasoning block starts / periodically during reasoning,
      // BEFORE any real output. Counting it records a tiny TTFT for a turn that
      // then spends minutes reasoning, masking exactly the slow pre-output
      // latency this metric exists to catch (P2). Real reasoning OUTPUT
      // (reasoning / reasoning_text) still starts the timer.
      if (chunk.type === 'text' || chunk.type === 'final_text' || chunk.type === 'tool_use_start'
          || chunk.type === 'tool_use_delta' || chunk.type === 'tool_use_end'
          || chunk.type === 'reasoning' || chunk.type === 'reasoning_text') {
        perfTimer.markFirstChunk();
        if (!fbGotFirstChunk) fbGotFirstChunk = true;
        armFbStall();
      }
      // Provider-owned keepalive signals (vLLM request_wait status, anthropic thinking
      // heartbeat) indicate the provider is still healthy within its own adaptive budget.
      // Reset the fallback so it does not false-fire during a legitimate long prefill or
      // extended-thinking session managed by the provider's own SCLI-22 watchdog.
      if (chunk.type === 'thinking' || (chunk.type === 'status' && chunk.code !== 'stall_timeout')) {
        armFbStall();
      }

      // Yield control periodically to prevent event loop starvation
      // This allows stdin events (Ctrl+C) to be processed during streaming
      if (++_yieldCounter % 5 === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }

      switch (chunk.type) {
        case 'text':
          text += chunk.text;
          addOutputDelta(chunk.text);
          emitter.emit({ type: 'content', text: chunk.text, timestamp: Date.now() });
          const soup = detectScriptCollapse(text);
          if (soup.degenerate) {
            outputDegeneracyReason = soup.reason ?? 'script_collapse';
            outputDegeneracyEvidence = soup.evidence;
            stopReason = 'degenerate_generation';
            logger.warn(
              {
                model,
                provider: provider.name,
                reason: outputDegeneracyReason,
                evidence: soup.evidence,
                outputChars: text.length,
              },
              'Stopped mixed-script collapse before it painted the TUI',
            );
            emitter.emit({
              type: 'provider_status',
              code: 'degenerate_generation_stopped',
              level: 'warning',
              provider: provider.name,
              message: 'Stopped mixed-script garbage output.',
              timestamp: Date.now(),
            });
            break stream_loop;
          }
          if (toolCalls.length === 0) {
            // workingTurn still judges mid-stream, but detectOutputDegeneracy
            // uses the 3x bar so a 3-line "let me patch" preamble lives and a
            // 70-line "let me run it" carousel (shizuha5 18:58Z, 151× let-me)
            // does not paint until Esc.
            const verdict = detectOutputDegeneracy(text, {
              midStream: true,
              workingTurn,
            });
            if (verdict.degenerate) {
              outputDegeneracyReason = verdict.reason ?? 'repeated_output';
              outputDegeneracyEvidence = verdict.evidence;
              stopReason = 'degenerate_generation';
              logger.warn(
                {
                  model,
                  provider: provider.name,
                  reason: outputDegeneracyReason,
                  evidence: verdict.evidence,
                  outputChars: text.length,
                },
                'Stopped degenerate repeated assistant generation before output-budget exhaustion',
              );
              emitter.emit({
                type: 'provider_status',
                code: 'degenerate_generation_stopped',
                level: 'warning',
                provider: provider.name,
                message: 'Stopped repetitive planning output before it could loop indefinitely.',
                timestamp: Date.now(),
              });
              break stream_loop;
            }
          }
          break;

        case 'final_text':
          finalText = chunk.text;
          addOutputDelta(chunk.text);
          // Only judge final_text when this segment produced no structured tool
          // call. A tool-bearing turn may still have a dense "Let me…" preamble
          // (DeepSeek often rephrases intent before the invoke); replacing it
          // with a stop notice while still executing tools confuses the UI and
          // poisons the transcript (seen as stop-notice + tool_use in one msg).
          if (toolCalls.length === 0) {
            const soup = detectScriptCollapse(finalText);
            const verdict = soup.degenerate ? soup : detectOutputDegeneracy(finalText, { workingTurn });
            if (verdict.degenerate) {
              outputDegeneracyReason = verdict.reason ?? 'repeated_output';
              outputDegeneracyEvidence = verdict.evidence;
              stopReason = 'degenerate_generation';
              logger.warn(
                {
                  model,
                  provider: provider.name,
                  reason: outputDegeneracyReason,
                  evidence: verdict.evidence,
                  outputChars: finalText.length,
                },
                'Stopped degenerate final assistant generation',
              );
              emitter.emit({
                type: 'provider_status',
                code: 'degenerate_generation_stopped',
                level: 'warning',
                provider: provider.name,
                message: 'Stopped repetitive planning output before it could loop indefinitely.',
                timestamp: Date.now(),
              });
            }
          }
          break;

        case 'tool_use_start':
          pendingToolInputs.set(chunk.id, { name: chunk.name, inputStr: '' });
          emitter.emit({
            type: 'tool_start',
            toolCallId: chunk.id,
            toolName: chunk.name,
            input: {},
            timestamp: Date.now(),
          });
          break;

        case 'tool_use_delta': {
          const pending = pendingToolInputs.get(chunk.id);
          if (pending) pending.inputStr += chunk.input;
          addOutputDelta(chunk.input);
          break;
        }

        case 'tool_use_end': {
          const pending = pendingToolInputs.get(chunk.id);
          const tc: ToolCall = {
            id: chunk.id,
            name: pending?.name ?? '',
            input: paramCoercion ? paramCoercion(chunk.input) : chunk.input,
          };
          toolCalls.push(tc);
          pendingToolInputs.delete(chunk.id);

          // Re-emit tool_start with the complete input so the TUI can display
          // tool arguments (file_path, pattern, etc). The initial tool_start
          // at tool_use_start time has input:{} because input streams incrementally.
          // The TUI handler merges duplicates by toolCallId.
          emitter.emit({
            type: 'tool_start',
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.input,
            timestamp: Date.now(),
          });

          // Start read-only tools immediately during streaming (up to concurrency limit)
          const handler = toolRegistry.get(tc.name);
          if (handler?.readOnly && inflightCount < MAX_CONCURRENT_STREAMING_TOOLS) {
            inflightCount++;
            const promise = executeToolCallTimed(tc, toolRegistry, permissions, emitter, context, onPermissionAsk, hookEngine, retryBudget, retryConfig, abortSignal)
              .finally(() => { inflightCount--; });
            inflightResults.set(tc.id, promise);
          }
          break;
        }

        case 'web_search': {
          const wsId = `ws-${Date.now()}`;
          emitter.emit({ type: 'tool_start', toolCallId: wsId, toolName: 'web_search', input: {}, timestamp: Date.now() });
          if (chunk.status === 'done') {
            emitter.emit({ type: 'tool_complete', toolCallId: wsId, toolName: 'web_search', result: 'Search complete', isError: false, durationMs: 0, timestamp: Date.now() });
          }
          break;
        }

        case 'thinking':
          // Heartbeat from provider during extended thinking — emit so TUI resets stall timer
          emitter.emit({ type: 'thinking', timestamp: Date.now() });
          break;

        case 'status':
          emitter.emit({
            type: 'provider_status',
            message: chunk.message,
            level: chunk.level,
            provider: chunk.provider,
            code: chunk.code,
            attempt: chunk.attempt,
            maxAttempts: chunk.maxAttempts,
            retryInMs: chunk.retryInMs,
            traceId: chunk.traceId,
            requestId: chunk.requestId,
            sessionId: chunk.sessionId,
            waitPhase: chunk.waitPhase,
            elapsedMs: chunk.elapsedMs,
            timeoutMs: chunk.timeoutMs,
            timestamp: Date.now(),
          });
          break;

        case 'reasoning_text':
          // Keep raw reasoning internally for diagnostics/recovery, but only
          // stream it to UI clients for models explicitly marked thinking-capable.
          // Cortex is the same vLLM protocol under a first-class provider name.
          // Preserve streamed reasoning for both aliases so a truncated Cortex
          // turn is not persisted as an empty assistant response and blindly
          // restarted without the reasoning that already occurred.
          if (provider.name === 'vllm' || provider.name === 'cortex') rawReasoningText += chunk.text;
          addOutputDelta(chunk.text);
          if (modelProfile.supportsThinking) {
            emitter.emit({ type: 'reasoning_text', text: chunk.text, timestamp: Date.now() });
          }
          break;

        case 'reasoning':
          reasoningBlocks.push({
            id: chunk.id,
            encryptedContent: chunk.encryptedContent,
            rawContent: chunk.rawContent,
            signature: chunk.signature,
            summary: chunk.summary,
          });
          // Emit reasoning summaries to TUI
          if (chunk.summary?.length) {
            const summaryTexts = chunk.summary.map((s) => s.text).filter(Boolean);
            if (summaryTexts.length > 0 && modelProfile.supportsThinking) {
              emitter.emit({ type: 'reasoning', summaries: summaryTexts, timestamp: Date.now() });
            }
          }
          break;

        case 'inference_telemetry':
          emitter.emit({ ...chunk, timestamp: chunk.timestamp ?? Date.now() });
          break;

        case 'served_model':
          // SCLI-218: remember the concrete served model for the loop's dynamic window.
          servedModel = chunk.model;
          if (chunk.contextWindow != null) servedContextWindow = chunk.contextWindow;
          break;

        case 'usage':
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
          liveInputTokens = chunk.inputTokens;
          liveOutputTokens = chunk.outputTokens;
          if (chunk.cacheCreationInputTokens != null) cacheCreationInputTokens = chunk.cacheCreationInputTokens;
          if (chunk.cacheReadInputTokens != null) cacheReadInputTokens = chunk.cacheReadInputTokens;
          if (chunk.providerPromptEstimate != null) providerPromptEstimate = chunk.providerPromptEstimate;
          emitTokenProgress(false, true);
          break;

        case 'stop_reason':
          stopReason = chunk.reason;
          break;

        case 'done':
          break;
      }
    }
  } catch (err) {
    // Abort fires during streaming — provider throws AbortError.
    // Catch it and return a partial result instead of propagating.
    if (abortSignal?.aborted) {
      streamAborted = true;
    } else {
      throw err;
    }
  } finally {
    if (fbStallTimer) clearTimeout(fbStallTimer);
  }

  // Breaking the async stream deliberately invokes the provider iterator's
  // return path before its trailing usage chunk arrives. Preserve honest
  // telemetry for the stopped generation instead of recording it as 0/0.
  if (outputDegeneracyReason) {
    if (inputTokens <= 0) inputTokens = estimatedInputTokens;
    if (outputTokens <= 0) outputTokens = liveOutputTokens;
  }

  // On stream abort: return partial result (text only, no orphaned tool_use blocks)
  if (streamAborted) {
    const spoken = (text || '').trim();
    if (!spoken) {
      emitter.emit({ type: 'content', text: '(interrupted)', timestamp: Date.now() });
    }
    const partialMsg: Message = {
      role: 'assistant',
      content: spoken || '(interrupted)',
      timestamp: Date.now(),
    };
    return {
      assistantMessage: partialMsg,
      toolCalls: [],
      toolResults: [],
      inputTokens,
      outputTokens,
      stopReason: 'interrupted',
    };
  }

  // SCLI-21: emit the structured per-turn perf event (consumed by the TUI
  // status line, the SCLI-2.2 watchdog, and benches). Aborted streams return
  // above and intentionally emit nothing.
  {
    const perf = perfTimer.finish({
      provider: provider.name,
      model,
      inputTokens,
      outputTokens,
      ...(cacheCreationInputTokens != null ? { cacheCreationTokens: cacheCreationInputTokens } : {}),
      ...(cacheReadInputTokens != null ? { cacheReadTokens: cacheReadInputTokens } : {}),
    });
    emitter.emit({ ...perf, type: 'perf_metrics', timestamp: Date.now() });
    ttftMs = perf.ttftMs ?? null; // SCLI-22: read from PerfTimer; no separate measurement needed
    const warnMs = ttftWarnThresholdMs();
    if (perf.ttftMs !== null && perf.ttftMs > warnMs) {
      logger.warn(
        { model, provider: provider.name, ttftMs: perf.ttftMs, thresholdMs: warnMs, status: formatPerfStatus(perf) },
        'TTFT exceeded warn threshold',
      );
    }
  }

  if (stopReason === 'tool_calls' && toolCalls.length === 0) {
    logger.warn(
      { model, provider: provider.name, inputTokens, outputTokens, textLen: (finalText ?? text).length },
      'Provider signaled tool_calls but no parsable tool calls were received',
    );
    throw new Error(
      'Provider signaled tool_calls but returned no parsable tool calls. Check the model tool parser/reasoning parser configuration and request transcript.',
    );
  }

  // max_tokens can truncate a tool invoke mid-JSON. Transport salvage
  // (stall_salvage) only exists when the parser already emitted tool_use_end,
  // which DeepSeek/vLLM do after the invoke is fully buffered — keep those.
  // Dropping a completed call is what stranded shizuha1 on 2026-08-15.
  if (stopReason === 'max_tokens' && toolCalls.length > 0) {
    logger.warn(
      { model, provider: provider.name, stopReason, droppedToolCalls: toolCalls.length },
      'Dropping tool calls from truncated model turn before execution',
    );
    await Promise.allSettled(inflightResults.values());
    toolCalls.length = 0;
    pendingToolInputs.clear();
  }

  // DSML wire-markup salvage BEFORE the end-of-stream chatter guard. Under
  // speculative decoding the engine can stream a tool invoke as CONTENT; if we
  // mark the turn degenerate first, we claim "no tool call" while salvage would
  // have recovered one — and we still replace the text with a stop notice.
  {
    const rawAssistantText = finalText ?? text;
    if (rawAssistantText) {
      const dsml = salvageDsmlToolCalls(rawAssistantText);
      if (dsml.hadMarkup) {
        logger.warn(
          {
            model,
            provider: provider.name,
            salvagedCalls: dsml.calls.map((c) => c.name),
            existingToolCalls: toolCalls.length,
          },
          'DSML wire markup leaked into content — engine tool-parser miss; salvaged and sanitized',
        );
        emitter.emit({
          type: 'provider_status',
          code: 'dsml_leak_salvaged',
          level: 'warning',
          provider: provider.name,
          message: dsml.calls.length
            ? `Recovered ${dsml.calls.length} tool call(s) from leaked DSML markup.`
            : 'Stripped leaked DSML markup from model output.',
          timestamp: Date.now(),
        });
        if (finalText !== undefined) finalText = dsml.cleaned;
        else text = dsml.cleaned;
        if (toolCalls.length === 0 && dsml.calls.length > 0 && !abortSignal?.aborted) {
          for (const call of dsml.calls) {
            const id = `dsml_salvaged_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            emitter.emit({ type: 'tool_start', toolCallId: id, toolName: call.name, input: call.input, timestamp: Date.now() });
            toolCalls.push({ id, name: call.name, input: call.input });
          }
        }
      }
    }
  }

  // If a structured or salvaged tool call arrived, the "no tool" chatter stop
  // is no longer valid — keep the (cleaned) content and execute the tools.
  if (toolCalls.length > 0 && outputDegeneracyReason) {
    logger.info(
      {
        model,
        provider: provider.name,
        reason: outputDegeneracyReason,
        toolCount: toolCalls.length,
      },
      'Clearing chatter-guard stop — tool call(s) present after stream/salvage',
    );
    outputDegeneracyReason = undefined;
    outputDegeneracyEvidence = undefined;
    if (stopReason === 'degenerate_generation') stopReason = 'tool_calls';
  }

  // CTX-649: the strict chatter verdict applies at END of stream — "no tool
  // call arrived" is now a fact, not a prediction. (Mid-stream needs 3x the
  // evidence; providers that never emit final_text still get enforcement here.)
  // Runs after DSML salvage so a recovered invoke is not mislabeled as spin.
  if (!outputDegeneracyReason && toolCalls.length === 0 && (finalText ?? text)) {
    const soup = detectScriptCollapse(finalText ?? text);
    const finalVerdict = soup.degenerate ? soup : detectOutputDegeneracy(finalText ?? text, { workingTurn });
    if (finalVerdict.degenerate) {
      outputDegeneracyReason = finalVerdict.reason ?? 'repeated_output';
      outputDegeneracyEvidence = finalVerdict.evidence;
      stopReason = 'degenerate_generation';
      logger.warn(
        { model, provider: provider.name, reason: outputDegeneracyReason, evidence: finalVerdict.evidence },
        'Degenerate text-only turn stopped at stream end (no tool call arrived)',
      );
      emitter.emit({
        type: 'provider_status',
        code: 'degenerate_generation_stopped',
        level: 'warning',
        provider: provider.name,
        message: 'Stopped repetitive planning output before it could loop indefinitely.',
        timestamp: Date.now(),
      });
    }
  }

  // Build assistant message
  const contentBlocks: ContentBlock[] = [];
  const assistantText = outputDegeneracyReason
    ? formatDegeneracyStopNotice(outputDegeneracyReason, outputDegeneracyEvidence)
    : finalText ?? text;
  // Reasoning items first (for roundtripping encrypted content)
  if (rawReasoningText.trim()) {
    contentBlocks.push({ type: 'reasoning', id: `vllm_reasoning_${Date.now()}`, rawContent: rawReasoningText });
  }
  for (const rb of reasoningBlocks) {
    contentBlocks.push({ type: 'reasoning', id: rb.id, encryptedContent: rb.encryptedContent, rawContent: rb.rawContent, signature: rb.signature, summary: rb.summary });
  }
  if (assistantText) contentBlocks.push({ type: 'text', text: assistantText });
  for (const tc of toolCalls) {
    contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  const assistantMessage: Message = {
    role: 'assistant',
    content: contentBlocks.length === 1 && contentBlocks[0]!.type === 'text'
      ? (contentBlocks[0] as { text: string }).text
      : contentBlocks,
    timestamp: Date.now(),
  };

  // Execute tool calls — some read-only tools may already be in-flight from streaming
  const resultMap = new Map<string, ToolResult>();

  if (toolCalls.length > 0) {
    // Separate remaining read-only (not yet started) from write tools
    const remainingReadOnly: ToolCall[] = [];
    const writeCalls: ToolCall[] = [];

    for (const tc of toolCalls) {
      if (inflightResults.has(tc.id)) continue; // already started during streaming
      const handler = toolRegistry.get(tc.name);
      if (handler?.readOnly) {
        remainingReadOnly.push(tc);
      } else {
        writeCalls.push(tc);
      }
    }

    // Await all in-flight results from streaming
    const inflightEntries = [...inflightResults.entries()];
    const inflightSettled = await Promise.all(inflightEntries.map(([, p]) => p));
    for (let i = 0; i < inflightEntries.length; i++) {
      resultMap.set(inflightEntries[i]![0], inflightSettled[i]!);
    }

    // Execute remaining read-only tools in parallel
    if (remainingReadOnly.length > 0) {
      const results = await Promise.all(
        remainingReadOnly.map((tc) => executeToolCallTimed(tc, toolRegistry, permissions, emitter, context, onPermissionAsk, hookEngine, retryBudget, retryConfig, abortSignal)),
      );
      for (let i = 0; i < remainingReadOnly.length; i++) {
        resultMap.set(remainingReadOnly[i]!.id, results[i]!);
      }
    }

    // Execute write tools sequentially
    for (const tc of writeCalls) {
      const result = await executeToolCallTimed(tc, toolRegistry, permissions, emitter, context, onPermissionAsk, hookEngine, retryBudget, retryConfig, abortSignal);
      resultMap.set(tc.id, result);
    }
  }

  // Sort results to match original tool call order
  const toolResults: ToolResult[] = toolCalls
    .map((tc) => resultMap.get(tc.id))
    .filter((r): r is ToolResult => r !== undefined);

  return { assistantMessage, toolCalls, toolResults, inputTokens, outputTokens, stopReason, cacheCreationInputTokens, cacheReadInputTokens, ttftMs, providerPromptEstimate, servedModel, servedContextWindow };
}

/**
 * Guarded tool execution: a tool that ignores ToolContext.abortSignal must not
 * wedge the turn forever (a /home-wide grep once pinned a TUI at 100% CPU for
 * 17+ minutes with the queued user message undeliverable). Races the tool's
 * promise against:
 *  - the turn's abort signal — abort ALWAYS unblocks the loop, even when the
 *    tool never checks its signal;
 *  - an opt-in silent-stall watchdog (handler.silentTimeoutMs) that abandons a
 *    tool emitting no progress output for that long; each onProgress resets it.
 * A rogue promise may keep running in the background, but the turn recovers and
 * the model is told what happened instead of the session hanging.
 */
export function runToolGuarded(handler: ToolHandler, tc: ToolCall, toolContext: ToolContext): Promise<ToolResult> {
  const signal = toolContext.abortSignal;
  const silentMs = handler.silentTimeoutMs;
  if (!signal && !silentMs) return handler.execute(tc.input, toolContext);

  return new Promise<ToolResult>((resolve, reject) => {
    let settled = false;
    let watchdog: NodeJS.Timeout | undefined;
    const onAbort = () => settle(() =>
      resolve({
        toolUseId: tc.id,
        content: `Tool ${tc.name} was cancelled: the turn was aborted while it was still running.`,
        isError: true,
      }));
    const cleanup = () => {
      if (watchdog) clearTimeout(watchdog);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const armWatchdog = () => {
      if (!silentMs || settled) return;
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => settle(() => {
        logger.warn({ tool: tc.name, silentMs }, 'Tool produced no output past its silent watchdog — abandoned as wedged');
        resolve({
          toolUseId: tc.id,
          content:
            `Tool ${tc.name} produced no output for ${Math.round(silentMs / 1000)}s and was abandoned as wedged. ` +
            'Retry with a narrower request (smaller path, more specific pattern/filter).',
          isError: true,
        });
      }), silentMs);
      watchdog.unref?.();
    };

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    let ctx = toolContext;
    if (silentMs) {
      const innerProgress = toolContext.onProgress;
      ctx = { ...toolContext, onProgress: (text: string) => { armWatchdog(); innerProgress?.(text); } };
      armWatchdog();
    }
    handler.execute(tc.input, ctx).then(
      (res) => settle(() => resolve(res)),
      (err) => settle(() => reject(err)),
    );
  });
}

/** SCLI-31: thin timing wrapper around executeToolCall. The tool_complete
 *  EVENT already carries durationMs, but the returned ToolResult did not, so
 *  the run-telemetry capture (which works off TurnResult.toolResults) recorded
 *  0 for every tool. Stamp the wall-clock duration onto the result so both
 *  agent loops report real per-tool durations. */
async function executeToolCallTimed(
  tc: ToolCall,
  registry: ToolRegistry,
  permissions: PermissionEngine,
  emitter: AgentEventEmitter,
  context: ToolContext,
  onPermissionAsk?: PermissionAskCallback,
  hookEngine?: HookEngine,
  retryBudget?: ToolRetryBudget,
  retryConfig: ToolRetryConfig = DEFAULT_TOOL_RETRY_CONFIG,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const result = await executeToolCall(tc, registry, permissions, emitter, context, onPermissionAsk, hookEngine, retryBudget, retryConfig, abortSignal);
  if (result.durationMs === undefined) result.durationMs = Date.now() - startedAt;
  return result;
}

async function executeToolCall(
  tc: ToolCall,
  registry: ToolRegistry,
  permissions: PermissionEngine,
  emitter: AgentEventEmitter,
  context: ToolContext,
  onPermissionAsk?: PermissionAskCallback,
  hookEngine?: HookEngine,
  retryBudget?: ToolRetryBudget,
  retryConfig: ToolRetryConfig = DEFAULT_TOOL_RETRY_CONFIG,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  const startTime = Date.now();
  const handler = registry.get(tc.name);

  if (!handler) {
    const result: ToolResult = {
      toolUseId: tc.id,
      content: `Unknown tool: ${tc.name}`,
      isError: true,
    };
    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return result;
  }

  // Guard: model faked an MCP tool call by echoing its name through bash.
  // Short-circuit with a corrective result instead of running the useless echo —
  // this breaks the imitation loop and steers the model back to a real call.
  const fakedTool = detectFakedMcpToolCall(tc, registry);
  if (fakedTool) {
    const result: ToolResult = {
      toolUseId: tc.id,
      content:
        `Do not echo or print tool names through bash. "${fakedTool}" is a real tool available to you right now — ` +
        `call it DIRECTLY as a tool call with its JSON arguments. Re-issue your intended action as a real call to ${fakedTool}.`,
      isError: true,
    };
    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return result;
  }

  // Check permissions
  const decision = permissions.check({
    toolName: tc.name,
    input: tc.input,
    riskLevel: handler.riskLevel,
  });

  if (decision === 'deny') {
    const result: ToolResult = {
      toolUseId: tc.id,
      content: `Permission denied for tool "${tc.name}" in current mode.`,
      isError: true,
    };
    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return result;
  }

  // Interactive approval for 'ask' decision
  if (decision === 'ask' && onPermissionAsk) {
    const approval = await onPermissionAsk(tc.name, tc.input, handler.riskLevel);
    if (approval === 'deny') {
      const result: ToolResult = {
        toolUseId: tc.id,
        content: `User denied permission for tool "${tc.name}".`,
        isError: true,
      };
      emitter.emit({
        type: 'tool_complete',
        toolCallId: tc.id,
        toolName: tc.name,
        result: result.content,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
      return result;
    }
    if (approval === 'allow_always') {
      permissions.approve(tc.name);
    }
  }

  // PreToolUse hooks — can block execution
  if (hookEngine?.hasHooks('PreToolUse')) {
    const hookEnv: Record<string, string> = {
      TOOL_NAME: tc.name,
      TOOL_INPUT: JSON.stringify(tc.input),
      SESSION_ID: context.sessionId,
      CWD: context.cwd,
    };
    const hookResults = await hookEngine.runHooks('PreToolUse', hookEnv, tc.name);
    const blocked = hookResults.find((r) => r.blocked);
    if (blocked) {
      const result: ToolResult = {
        toolUseId: tc.id,
        content: `Blocked by hook: ${blocked.blockReason ?? 'PreToolUse hook returned exit code 2'}`,
        isError: true,
      };
      emitter.emit({
        type: 'tool_complete',
        toolCallId: tc.id,
        toolName: tc.name,
        result: result.content,
        isError: true,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
      return result;
    }
  }

  // Execute — provide onProgress callback for streaming tool output
  const toolContext: ToolContext = {
    ...context,
    // SCLI-39: thread the current turn's abort signal so long-running tools
    // (esp. bash) are killed when the user queues a message mid-turn, instead of
    // wedging the turn and leaving a runaway running-tool timer in the TUI.
    abortSignal: abortSignal ?? context.abortSignal,
    onProgress: (text: string) => {
      emitter.emit({
        type: 'tool_progress',
        toolCallId: tc.id,
        toolName: tc.name,
        output: text,
        timestamp: Date.now(),
      });
    },
  };
  try {
    // SCLI-20(a): retry only transient failures (timeout/rate-limit/network),
    // bounded by the per-turn budget. Non-retryable errors throw on the first
    // attempt and fall through to the catch below unchanged.
    const result = retryBudget
      ? await executeToolWithRetry(
          () => runToolGuarded(handler, tc, toolContext),
          retryBudget,
          retryConfig,
          {
            onRetry: ({ attempt, delayMs, error }) => {
              logger.warn(
                { tool: tc.name, attempt, delayMs, err: (error as Error)?.message ?? String(error) },
                'Retrying transient tool failure',
              );
              emitter.emit({
                type: 'tool_progress',
                toolCallId: tc.id,
                toolName: tc.name,
                output: `Transient failure — retry ${attempt} in ${delayMs}ms`,
                timestamp: Date.now(),
              });
            },
          },
        )
      : await runToolGuarded(handler, tc, toolContext);
    result.toolUseId = tc.id;

    // Cap tool output before it enters the transcript / model context.
    // Unbounded grep/bash dumps (hundreds of KB) cause provider
    // context_length_exceeded even when the status bar still looks fine.
    const MAX_TOOL_RESULT_CHARS = 40_000;
    if (typeof result.content === 'string' && result.content.length > MAX_TOOL_RESULT_CHARS) {
      const original = result.content.length;
      result.content = `${result.content.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n`
        + `[... tool output truncated: kept ${MAX_TOOL_RESULT_CHARS}/${original} chars to protect the context window ...]`;
    }

    // PostToolUse hooks
    if (hookEngine?.hasHooks('PostToolUse')) {
      const hookEnv: Record<string, string> = {
        TOOL_NAME: tc.name,
        TOOL_INPUT: JSON.stringify(tc.input),
        TOOL_RESULT: result.content,
        TOOL_ERROR: String(result.isError ?? false),
        SESSION_ID: context.sessionId,
        CWD: context.cwd,
      };
      await hookEngine.runHooks('PostToolUse', hookEnv, tc.name);
    }

    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: result.isError ?? false,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
      metadata: result.metadata,
      ...(result.image ? { image: result.image } : {}),
      ...(result.metadata?.audio ? { audio: result.metadata.audio as { base64: string; format: string; mimeType: string } } : {}),
    });
    return result;
  } catch (err) {
    const result: ToolResult = {
      toolUseId: tc.id,
      content: `Tool error: ${(err as Error).message}`,
      isError: true,
    };
    emitter.emit({
      type: 'tool_complete',
      toolCallId: tc.id,
      toolName: tc.name,
      result: result.content,
      isError: true,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });
    return result;
  }
}
