import type { AgentConfig, Message, ContentBlock } from './types.js';
import type { AgentEvent } from '../events/types.js';
import type { ToolResult, ToolContext, ToolDefinition } from '../tools/types.js';
import { AgentEventEmitter } from '../events/emitter.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/builtin/index.js';
import { PermissionEngine } from '../permissions/engine.js';
import { ProviderRegistry } from '../provider/registry.js';
import { StateStore } from '../state/store.js';
import { loadConfig } from '../config/loader.js';
import { buildSystemPrompt } from '../prompt/builder.js';
import {
  needsCompaction,
  estimateOverheadTokens,
  providerPromptTokensOrEstimate,
} from '../prompt/context.js';
import {
  classifyPromptSource,
  estimatePromptTokenBudget,
  heartbeatBudgetConfig,
  type HeartbeatCompactionAction,
} from './heartbeat-hygiene.js';
import { resolveDynamicCompactionWindow, resolveEffectiveContextWindow, type CompactionWindowMode } from '../provider/context-window.js';
import { MCPManager } from '../tools/mcp/manager.js';
import { isLeanConversationalEnv, leanConversationalSkillNames, talkSeatSuppressesTools, talkSeatTurnTimeoutMs } from '../platform/lean-conversational.js';
import { registerMCPTools, createMCPResourceReadTool } from '../tools/mcp/bridge.js';
import {
  ToolSearchState,
  createToolSearchTool,
  buildConfiguredServerSummaries,
  buildDeferredToolDefinitions,
  buildToolCatalog,
  buildAwarenessPrompt,
  modelNeedsInlineToolSchemas,
  modelSupportsAppendOnlyToolActivation,
} from '../tools/tool-search.js';
import { BackgroundTaskRegistry } from '../tasks/registry.js';
import { executeTurn } from './turn.js';
import {
  hasVisibleAssistantText,
  isProgressOnlyAssistantText,
  reasoningTextFromContent,
  strippedVisibleTextFromContent,
  visibleTextFromContent,
} from './content.js';
import { DEGENERACY_RECOVERY_PROMPT } from './output-degeneracy-guard.js';
import {
  AUTONOMOUS_MAX_TOKENS_CONTINUE_PROMPT,
  incompleteTurnError,
  MAX_THINKING_ONLY_RECOVERY,
  shouldContinueAutonomousMaxTokens,
} from './incomplete-turn.js';
import {
  BackgroundTaskWaitController,
  decideBackgroundTaskContinuation,
  isBackgroundTaskWaitContentIntent,
} from './background-task-wait.js';
import {
  evaluateRepeatedToolLoop,
  isEmptyToolArgsError,
  toolCallSignature,
  turnHadToolError,
  NoProgressGuard,
} from './tool-loop-guard.js';import { TurnTelemetryWindow, JsonlTelemetrySink, recordTurnTelemetry, type TurnTelemetrySink } from '../telemetry/turn-telemetry.js';
import { StruggleAnalyzer } from './struggle-analyzer.js';
import { setupStrugglePulseAutoFiler } from '../telemetry/struggle-auto-filer.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { compareProviderPrefixSnapshots, providerPrefixContinuityLogFields, providerPrefixContinuityLogMessage, type ProviderPrefixSnapshot } from '../telemetry/provider-prefix-continuity.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { generatePlanSlug, resolvePlanFilePath } from '../tools/builtin/plan-mode.js';
import { setSearchStore } from '../tools/builtin/session-search.js';


/**
 * Core agent loop — plan → act → observe.
 * Yields AgentEvents for streaming to CLI/HTTP consumers.
 */
// SCLI-31/SCLI-74: registry of all currently active telemetry windows.
// Using a Set (not a single global) so concurrent serve-mode requests each
// get their own window and renderMetrics() can aggregate across all of them
// without races. Gateway mode registers exactly one window (via
// setActiveTelemetryWindow); serve mode registers per-request via
// registerTelemetryWindow/unregisterTelemetryWindow.
const _telemetryWindows = new Set<TurnTelemetryWindow>();

/** All currently active telemetry windows (gateway + any in-flight serve requests). */
export function getAllTelemetryWindows(): TurnTelemetryWindow[] {
  return [..._telemetryWindows];
}

/** The most recently registered window (for TUI backwards-compat), or null. */
export function getTurnTelemetryWindow(): TurnTelemetryWindow | null {
  const arr = [..._telemetryWindows];
  return arr[arr.length - 1] ?? null;
}

/** Gateway mode: replace all windows with a single one (or clear if null). */
export function setActiveTelemetryWindow(window: TurnTelemetryWindow | null): void {
  _telemetryWindows.clear();
  if (window) _telemetryWindows.add(window);
}

/** Serve mode: register a per-request window so /metrics sees it. */
export function registerTelemetryWindow(win: TurnTelemetryWindow): void {
  _telemetryWindows.add(win);
}

/** Serve mode: deregister the per-request window when the request ends. */
export function unregisterTelemetryWindow(win: TurnTelemetryWindow): void {
  _telemetryWindows.delete(win);
}

export function createTurnTelemetrySink(): TurnTelemetrySink | undefined {
  if (process.env['SHIZUHA_TELEMETRY_SINK'] === 'off') return undefined;
  try {
    const fsImpl = {
      mkdirSync: (p: string, opts: { recursive: boolean }) => { fs.mkdirSync(p, opts); },
      appendFileSync: (p: string, data: string) => { fs.appendFileSync(p, data); },
      dirname: (p: string) => nodePath.dirname(p),
    };
    const agentUser = process.env['AGENT_USERNAME'];
    const filePath = agentUser
      ? nodePath.join(os.homedir(), '.shizuha', 'claude-sessions', agentUser, 'turn-telemetry.jsonl')
      : nodePath.join(os.homedir(), '.config', 'shizuha', 'turn-telemetry.jsonl');
    return new JsonlTelemetrySink(filePath, fsImpl);
  } catch {
    return undefined;
  }
}

/**
 * Classify a provider error as a context-overflow that emergency compaction +
 * a single retry can fix. Matches message patterns from Anthropic, llama.cpp,
 * OpenAI, and Cortex/vLLM ("context window exhausted", SCLI-206), plus the
 * structured `context_too_large_for_capacity` contract from cortex/auto
 * (SCLI-218 / CTX-302: top rung saturated AND the prompt fits no available
 * rung — the client's move is compact-then-retry-once, never a loop).
 */
export function isContextOverflowError(
  status: number | undefined,
  code: string | undefined,
  msg: string,
): boolean {
  if (code === 'context_too_large_for_capacity' || /context_too_large_for_capacity/i.test(msg)) {
    return true;
  }
  return (status === 400 || status == null) && (
    /exceed.*context/i.test(msg) || /too long/i.test(msg) ||
    /too many tokens/i.test(msg) || /maximum context/i.test(msg) ||
    /prompt is too long/i.test(msg) || /context.size/i.test(msg) ||
    /context.*exhaust/i.test(msg) || /context.*too.small/i.test(msg)
  );
}

export async function* runAgent(agentConfig: AgentConfig, initialPrompt?: string): AsyncGenerator<AgentEvent> {
  const startTime = Date.now();

  // 1. Load config
  const config = await loadConfig(agentConfig.cwd);
  let model = agentConfig.model ?? config.agent.defaultModel;
  // Capture the original slug (with provider prefix, e.g. "cortex/GLM-4.7")
  // BEFORE resolveWithModel strips it — needed to decide inline-schema gating.
  const modelSlug = model;
  const cwd = agentConfig.cwd ?? config.agent.cwd;
  const maxTurns = agentConfig.maxTurns ?? config.agent.maxTurns;
  // SCLI-53 turn-watchdog: an ABSOLUTE per-turn ceiling that always applies, even
  // when maxTurns=0 (the "unlimited" default). A runaway model (e.g. a weak GLM
  // looping on tool calls) otherwise iterates forever, wedging the agent —
  // inbox stuck busy, no heartbeat can rescue it (observed: zen, 226+ model-calls).
  // Hitting this ends the turn cleanly so the inbox frees and the heartbeat re-drives.
  const talkOneShot = talkSeatSuppressesTools();
  const hardMaxTurns = talkOneShot ? 1 : Number(process.env['SHIZUHA_HARD_MAX_TURNS'] ?? 100);
  const temperature = agentConfig.temperature ?? config.agent.temperature;
  const maxOutputTokens = agentConfig.maxOutputTokens ?? config.agent.maxOutputTokens;
  const permissionMode = agentConfig.permissionMode ?? config.permissions.mode;
  const thinkingLevel = agentConfig.thinkingLevel;
  const reasoningEffort = agentConfig.reasoningEffort;

  // 2. Initialize components
  const providerRegistry = new ProviderRegistry(config);
  const resolved = providerRegistry.resolveWithModel(model);
  const provider = resolved.provider;
  model = resolved.resolvedModel; // Strip provider prefix (e.g. copilot/claude-opus-4.6 → claude-opus-4.6)
  // Pre-warm provider's discovery so maxContextWindow reflects the SERVED limit
  // (e.g. vLLM's /v1/models max_model_len), not the env-var guess. Without this,
  // compaction fires at 90% of the initial guess (often 65K) even when vLLM serves
  // 131K — choking max_tokens output and dropping history aggressively.
  const provAny = provider as unknown as { getServedModel?: (preferredModel?: string) => Promise<string | undefined> };
  if (typeof provAny.getServedModel === 'function') {
    try { await provAny.getServedModel(model); } catch { /* ignore — chat() will surface */ }
  }
  const maxContextTokens = resolveEffectiveContextWindow(
    model,
    provider,
    agentConfig.maxContextTokens ?? config.agent.maxContextTokens,
  );

  // ── SCLI-218: dynamic context windows (cortex/auto) ─────────────────────────
  // A virtual alias serves a different concrete model per response, so ONE
  // static window is wrong by construction. Track the served model each turn
  // and re-resolve the compaction budget. 'conservative' mode compacts against
  // the alias's advertised context floor so the session fits EVERY ladder rung
  // (agents' eternal sessions want this); default 'planning' uses the current
  // best-known window.
  const envWindowMode = process.env['SHIZUHA_COMPACTION_WINDOW_MODE'];
  const compactionWindowMode: CompactionWindowMode =
    (agentConfig.compactionWindowMode
      ?? config.agent.compactionWindowMode
      ?? (envWindowMode === 'conservative' ? 'conservative' : 'planning')) === 'conservative'
      ? 'conservative' : 'planning';
  const configuredWindow = agentConfig.maxContextTokens ?? config.agent.maxContextTokens;
  let servedModel: string | undefined;
  let servedWindowFromBackend: number | undefined;
  let effectiveContextTokens = resolveDynamicCompactionWindow({
    requestedModel: model,
    source: provider,
    configured: configuredWindow,
    mode: compactionWindowMode,
  });
  // ────────────────────────────────────────────────────────────────────────────

  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);

  // Unregister client-side web_search when provider handles it natively
  if (provider.supportsNativeWebSearch) {
    toolRegistry.unregister('web_search');
  }

  // Apply toolset filter only when explicitly configured. Default stays full.
  const toolsetName = agentConfig.toolset ?? 'full';
  console.error(`[DEBUG] toolsetName=${toolsetName}`);
  if (toolsetName && toolsetName !== 'full') {
    const { ToolsetManager } = await import('../tools/toolsets.js');
    const mgr = new ToolsetManager();
    const allNames = toolRegistry.list().map((t) => t.name);
    const allowed = new Set(mgr.filterTools(toolsetName, allNames));
    console.error(`[DEBUG] Filtering tools: ${allNames.length} → ${allowed.size} (toolset=${toolsetName})`);
    for (const name of allNames) {
      if (!allowed.has(name)) toolRegistry.unregister(name);
    }
    logger.info({ toolset: toolsetName, total: allNames.length, active: allowed.size }, 'Toolset applied');
  }

  const permissions = new PermissionEngine(permissionMode, config.permissions.rules);
  const emitter = new AgentEventEmitter();
  const store = new StateStore();
  setSearchStore(store);

  // Plan mode: generate plan file path and set on permissions
  let planFilePath: string | undefined;
  if (permissionMode === 'plan') {
    const slug = generatePlanSlug();
    planFilePath = resolvePlanFilePath(slug);
    permissions.setPlanFilePath(planFilePath);
  }

  // 3. MCP connections
  const mcpManager = new MCPManager();
  const mcpConfigs = [...(config.mcp.servers ?? []), ...(agentConfig.mcpServers ?? [])];
  if (mcpConfigs.length > 0) {
    await mcpManager.connectAll(mcpConfigs);
    const mcpToolCount = await registerMCPTools(mcpManager, (h) => toolRegistry.register(h));
    // Register resource read tools for servers that support resources
    for (const [serverName, conn] of mcpManager.getAll()) {
      if (conn.capabilities?.resources) {
        toolRegistry.register(createMCPResourceReadTool(serverName, mcpManager));
      }
    }
    // Wire dynamic tool refresh
    mcpManager.setToolRegistry(toolRegistry);
    logger.info({ mcpToolCount }, 'MCP tools registered');
  }

  // 4. Tool search setup (deferred MCP tool loading)
  const toolSearchConfig = config.mcp.toolSearch;
  const toolSearchState = new ToolSearchState();
  let toolSearchEnabled = false;

  if (mcpConfigs.length > 0 && toolSearchConfig.mode !== 'off') {
    // Build catalog from all MCP tools
    const allMcpTools = mcpManager.listAllTools();
    const catalog = buildToolCatalog(allMcpTools);
    const serverSummaries = buildConfiguredServerSummaries(mcpConfigs);
    toolSearchState.setCatalog(catalog, serverSummaries);

    // Decide if tool search should be enabled
    if (toolSearchConfig.mode === 'on') {
      toolSearchEnabled = true;
    } else {
      // mode === 'auto': enable when MCP tool tokens exceed threshold
      toolSearchEnabled = toolSearchState.shouldAutoEnable(
        maxContextTokens,
        toolSearchConfig.autoThresholdPercent,
      );
    }

    if (toolSearchEnabled) {
      toolRegistry.register(createToolSearchTool(toolSearchState, toolSearchConfig.maxResults, {
        inlineSchemas: modelNeedsInlineToolSchemas(modelSlug),
      }));
      logger.info(
        { catalogSize: toolSearchState.catalogSize, servers: serverSummaries.length },
        'Tool search enabled — MCP tools deferred',
      );
    }
  }

  // 4b. Skills
  const { loadSkills } = await import('../skills/loader.js');
  const { SkillRegistry } = await import('../skills/registry.js');
  const { createSkillTool } = await import('../tools/builtin/skill.js');
  const skillRegistry = new SkillRegistry();
  skillRegistry.registerAll(loadSkills(cwd, { trustProjectSkills: config.skills.trustProjectSkills }));
  if (skillRegistry.size > 0) {
    toolRegistry.register(createSkillTool(skillRegistry));
    logger.info({ skillCount: skillRegistry.size }, 'Skills loaded');
  }

  // 5. Session (resume or create)
  let session = agentConfig.sessionId ? store.loadSession(agentConfig.sessionId) : null;
  if (!session) {
    session = store.createSession(model, cwd);
  }

  yield {
    type: 'session_start',
    sessionId: session.id,
    model,
    timestamp: Date.now(),
    planFilePath,
  };

  // 6. Build system prompt
  const mcpAwareness = toolSearchEnabled
    ? buildAwarenessPrompt(toolSearchConfig.awareness, toolSearchState)
    : undefined;

  /** Get tool definitions for the LLM — filters MCP tools when tool search is active */
  function getToolDefs(): ToolDefinition[] {
    const allDefs = toolRegistry.definitions();
    if (!toolSearchEnabled) return allDefs;
    return buildDeferredToolDefinitions(
      allDefs,
      toolSearchState,
      modelSupportsAppendOnlyToolActivation(modelSlug),
    );
  }

  let toolDefs = talkSeatSuppressesTools() ? [] : getToolDefs();
  const skillCatalog = skillRegistry.size > 0
    ? skillRegistry.buildCatalog(
      process.env['AGENT_ROLE'],
      process.env['AGENT_TEAM'],
      isLeanConversationalEnv() ? leanConversationalSkillNames() : undefined,
    )
    : undefined;
  const systemPrompt = agentConfig.systemPrompt ?? await buildSystemPrompt({
    cwd,
    tools: toolDefs,
    provider: provider.name,
    model,
    contextWindow: maxContextTokens,
    mode: permissionMode,
    planFilePath,
    mcpAwareness,
    deferredMcpTools: toolSearchEnabled,
    skillCatalog,
  });

  // 7. Initialize messages
  const messages: Message[] = [...session.messages];

  // On resume, rebuild the tool-search discovered set from the loaded transcript
  // (it's in-memory only, so a fresh process starts empty — without this, MCP
  // tools the model already found would be filtered out of the tools array).
  if (toolSearchEnabled && messages.length > 0) {
    const reMarked = toolSearchState.markDiscoveredFromHistory(messages);
    if (reMarked > 0) {
      logger.info({ reMarked }, 'Tool search: re-derived discovered MCP tools from resumed transcript');
    }
  }

  // Inject initial prompt (used by sub-agents and exec --prompt)
  if (initialPrompt) {
    const msg: Message = { id: randomUUID(), role: 'user', content: initialPrompt, timestamp: Date.now() };
    messages.push(msg);
    store.appendMessage(session.id, msg);
  }

  // Inject MCP failure diagnostic so the LLM knows about degraded capabilities
  if (mcpManager.failedServers.length > 0) {
    const failedList = mcpManager.failedServers
      .map((f) => `- ${f.name}: ${f.error}`)
      .join('\n');
    const total = mcpManager.failedServers.length + mcpManager.size;
    const diagnostic = `[System Notice] ${mcpManager.failedServers.length}/${total} MCP tool servers failed to connect. You are operating with reduced capabilities.\n\nFailed servers:\n${failedList}\n\nInform the user about this limitation. Do not pretend everything is normal.`;
    const msg: Message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: diagnostic }], timestamp: Date.now() };
    messages.push(msg);
    store.appendMessage(session.id, msg);
  }

  const taskRegistry = new BackgroundTaskRegistry();

  // Sandbox config: agent-level override takes precedence over config file
  const sandboxConfig = agentConfig.sandboxMode
    ? { ...config.sandbox, mode: agentConfig.sandboxMode }
    : config.sandbox;
  const sandbox = sandboxConfig.mode !== 'unrestricted' ? sandboxConfig : undefined;

  const toolContext: ToolContext = { cwd, sessionId: session.id, planFilePath, taskRegistry, sandbox, agentConfig };

  // Estimate system prompt + tool definition token overhead for accurate compaction checks
  let systemOverheadTokens = estimateOverheadTokens(systemPrompt, toolDefs);

  // 8. Load model profile for tool response adaptation
  const { getModelProfile } = await import('../provider/model-profile.js');
  const modelProfile = getModelProfile(model);
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

  // 9. Agent loop
  // SCLI-31: run-telemetry — a queryable last-N-turns window plus a durable
  // JSONL sink. TUI → ~/.config/shizuha/turn-telemetry.jsonl; fleet agents →
  // ~/.shizuha/claude-sessions/<agent>/turn-telemetry.jsonl (the AGENT_USERNAME
  // path). Exposed via getTurnTelemetryWindow() for the TUI / SCLI-32 analyzer.
  const telemetryWindow = new TurnTelemetryWindow();
  setActiveTelemetryWindow(telemetryWindow);
  const agentLabel = process.env['AGENT_USERNAME'];
  const telemetrySink: TurnTelemetrySink | undefined = createTurnTelemetrySink();
  // SCLI-31: a fresh run id PER INVOCATION (session-prefixed for correlation).
  // Resuming a session reuses session.id while turnIndex restarts at 0, so
  // keying telemetry on session.id alone produced duplicate (runId, turnIndex)
  // rows across runs of the same session — consumers couldn't order/de-dup them.
  const telemetryRunId = `${session.id}#${randomUUID().slice(0, 8)}`;

  // SCLI-32: heuristic struggle analyzer for this TUI run. Same pattern as the
  // exec loop: drives THRASH/ERROR_DENSITY/LONG_RUN off this run's telemetry
  // window and STALL off the live activity events executeTurn emits on `emitter`;
  // emits 'struggle' events the SCLI-33 auto-filer files as deduped Pulse bugs.
  // Declared before the main try so the finally tears it down on every exit path.
  const struggleAnalyzer = new StruggleAnalyzer(emitter, telemetryWindow, {
    runId: telemetryRunId,
    ...(agentLabel ? { agent: agentLabel } : {}),
  });
  const { unsub: struggleAutoFilerUnsub, flush: struggleAutoFilerFlush } = setupStrugglePulseAutoFiler(
    emitter as unknown as Parameters<typeof setupStrugglePulseAutoFiler>[0],
  );

  let turnIndex = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // SCLI-182: last provider-reported prompt_tokens (real context size), used to
  // drive the pre-turn compaction gate from truth instead of the tiktoken×1.45
  // guess. 0 until the first response completes (cold start → estimate path).
  let lastReportedPromptTokens = 0;
  // Provider's own prompt token estimate (from max_tokens clamping), used only
  // as a fallback when usage.prompt_tokens is unavailable.
  let lastProviderPromptEstimate = 0;
  let totalCacheCreationInputTokens = 0;
  let totalCacheReadInputTokens = 0;

  // Continuation logic:
  // - Text-only response → STOP immediately
  // - max_tokens with visible text / transport salvage → incomplete terminal, no replay
  // - max_tokens with thinking/reasoning only (autonomous) → same re-prompt as thinking-only
  // - Thinking-only (no output text) → re-prompt up to 3 times, counted separately
  // - Non-thinking reasoning-only → one visible-answer recovery; never surface hidden text
  // - Silent generation (0 output tokens) → targeted recovery up to 2 times
  // - Progress-only narration ("Let me search...") → force an actual tool call/final answer
  // - Has tool_use → execute tools, continue
  const REPEATED_TOOL_CALL_NUDGE_AT = 2;
  const REPEATED_TOOL_CALL_STOP_AT = 6;
  const MAX_SILENT_GENERATION_RECOVERY = 2; // SCLI-9: model returned 0 output tokens (completely silent)
  const MAX_NON_THINKING_REASONING_RECOVERY = 1; // SCLI-117: backend leaked reasoning_content for a non-thinking model
  const MAX_PROGRESS_ONLY_RECOVERY = 2;
  const MAX_DEGENERACY_RECOVERY = 2;
  let previousToolSignature: string | null = null;
  let repeatedToolSignatureCount = 0;
  let thinkingOnlyRecoveryCount = 0; // SCLI-9
  let silentGenerationCount = 0;     // SCLI-9
  let nonThinkingReasoningRecoveryCount = 0; // SCLI-117
  let progressOnlyRecoveryCount = 0;
  let degeneracyRecoveryCount = 0;
  const backgroundTaskWait = new BackgroundTaskWaitController(undefined, agentConfig.abortSignal);

  // Automatic context safety is a provider-backed maintenance gate. The rewrite
  // is applied atomically to memory + durable state, and no ordinary generation
  // may proceed until semantic compaction commits below the invariant. The next
  // ordinary call is marked as the expected cold successor.
  let postCompactionRequestKind: string | undefined;
  let skipProactiveCompactUntilGrowth = false;
  const applyAutomaticSemanticCompaction = async (
    phase: 'pre-turn' | 'pre-provider' | 'post-turn' | 'overflow-recovery',
  ): Promise<void> => {
    // ALWAYS use the LLM-based compaction (operator 2026-08-08): no local-vs-
    // autonomous differentiation — every agent compacts via the LLM so no
    // conversation loses meaning to the lossy extractive projection.
    const { applyRequiredCompactionOrThrow } = await import('../state/compaction.js');
    const compacted = await applyRequiredCompactionOrThrow({
      messages,
      provider,
      model,
      maxTokens: effectiveContextTokens,
      overheadTokens: systemOverheadTokens,
      outputBudget: maxOutputTokens,
      planFilePath,
    });
    messages.length = 0;
    messages.push(...compacted.messages);
    store.replaceMessages(session.id, compacted.messages);
    lastReportedPromptTokens = 0;
    lastProviderPromptEstimate = 0;
    postCompactionRequestKind = 'post_compaction';
    thinkingOnlyRecoveryCount = 0;
    skipProactiveCompactUntilGrowth = !compacted.reachedTrigger;
    logger.warn(
      { turnIndex, phase, effectiveContextTokens, compactedMessages: compacted.messages.length },
      'Applied provider-backed semantic context compaction',
    );
  };

  // PLAT-216: Cross-turn no-progress guard — bail when the agent loops without advancing.
  const MAX_NO_PROGRESS_TURNS = parseInt(process.env['AGENT_NO_PROGRESS_TURNS'] ?? '5', 10);
  const noProgressGuard = new NoProgressGuard(MAX_NO_PROGRESS_TURNS);
  let stuckCleanupPending = false;

  // SCLI-22: Rolling TTFT watchdog.
  // Tracks the last TTFT_WINDOW_SIZE turn TTFT samples. When the rolling average
  // exceeds TTFT_WARN_THRESHOLD_MS, emits a warning event so the user knows the
  // model is degraded and can switch to a faster alternative.
  const _parseEnvInt = (v: string | undefined, def: number) => { const n = parseInt(v ?? String(def), 10); return Number.isFinite(n) && n > 0 ? n : def; };
  const TTFT_WINDOW_SIZE = _parseEnvInt(process.env['TTFT_WATCHDOG_WINDOW'], 5);
  const TTFT_WARN_THRESHOLD_MS = _parseEnvInt(process.env['TTFT_WARN_THRESHOLD_MS'], 8000);
  const ttftWindow: number[] = [];
  let ttftDegraded = false; // true while avg is above threshold; reset on recovery so each new episode re-emits once

  try {
    while ((!maxTurns || turnIndex < maxTurns) && turnIndex < hardMaxTurns) {
      if (!talkOneShot && turnIndex === hardMaxTurns - 1) {
        logger.warn({ turnIndex, hardMaxTurns }, '[turn-watchdog] SCLI-53: hard turn cap reached — ending turn to break a runaway loop (inbox will free; heartbeat re-drives)');
      }
      yield { type: 'turn_start', turnIndex, timestamp: Date.now() };
      const turnStart = Date.now();

      let compactionAction: HeartbeatCompactionAction = 'none';
      let preProviderBudgetExceeded = false;
      let effectiveReportedTokens = providerPromptTokensOrEstimate(
        lastReportedPromptTokens,
        lastProviderPromptEstimate,
      );
      let promptBudget = estimatePromptTokenBudget({
        messages,
        systemPrompt,
        toolDefs,
        model,
        sourceKind: classifyPromptSource(messages, initialPrompt),
        reportedPromptTokens: effectiveReportedTokens,
      });

      // Pre-turn compaction check — prevents context overflow when resuming
      // a long session. Autonomous heartbeat turns use a much lower operational
      // budget than the model hard window so Cortex-backed agents do not carry
      // 100k+ prompts into every scheduler tick.
      const hbBudget = heartbeatBudgetConfig(effectiveContextTokens);
      const heartbeatOverSoft = promptBudget.sourceKind === 'heartbeat' && promptBudget.promptTokenEstimate > hbBudget.softBudgetTokens;
      // One-shot: when compaction/trim rewrote the prompt head, tag the
      // next interactive model call so Cortex attributes its (expected) cold
      // prefill as post_compaction — not the ideally-zero mid-session surface.
      const needsProactiveCompact = needsCompaction(
        messages, effectiveContextTokens, model, systemOverheadTokens, maxOutputTokens, effectiveReportedTokens,
      );
      const holdOffProactive = skipProactiveCompactUntilGrowth;
      if (holdOffProactive) skipProactiveCompactUntilGrowth = false;
      if (heartbeatOverSoft || (needsProactiveCompact && !holdOffProactive)) {
        preProviderBudgetExceeded = heartbeatOverSoft;
        logger.info({ turnIndex, effectiveContextTokens, servedModel, compactionWindowMode, promptBudget, hbBudget }, 'Pre-turn compaction triggered');
        await applyAutomaticSemanticCompaction('pre-turn');
        compactionAction = 'compact';
        effectiveReportedTokens = 0;
        promptBudget = estimatePromptTokenBudget({ messages, systemPrompt, toolDefs, model, sourceKind: promptBudget.sourceKind });
        if (promptBudget.sourceKind === 'heartbeat' && promptBudget.promptTokenEstimate > hbBudget.softBudgetTokens) {
          throw new Error('Semantic context compaction did not restore heartbeat headroom');
        }
      }

      // Refresh tool definitions if tool search discovered new tools
      if (toolSearchEnabled) {
        const newToolDefs = getToolDefs();
        if (newToolDefs.length !== toolDefs.length) {
          toolDefs = newToolDefs;
          systemOverheadTokens = estimateOverheadTokens(systemPrompt, toolDefs);
          logger.debug(
            { toolCount: toolDefs.length, discovered: toolSearchState.getDiscovered().size },
            'Tool definitions updated with discovered tools',
          );
        }
      }

      // SCLI-32: arm the STALL idle timer before the provider call (after the
      // pre-turn compaction above), so a pre-stream hang — no content/tool event
      // at all — still trips STALL (review P1).
      struggleAnalyzer.onTurnStart();

      // Execute turn — retry transient API errors indefinitely with backoff
      // (operator 2026-07-23). Fleet agents: maintenance/pool-dry still end the
      // turn so the next heartbeat re-enters cleanly; pure transients never stop.
      let result: Awaited<ReturnType<typeof executeTurn>>;
      let overflowRecoveryAttempted = false;
      for (let retryAttempt = 0; ; retryAttempt++) {
        try {
          // The guard lives at the actual provider-call boundary so no retry or
          // recovery path can bypass it. Most iterations are a cheap false check;
          // a true result is handled locally without a maintenance model call.
          const providerCallReportedTokens = providerPromptTokensOrEstimate(
            lastReportedPromptTokens,
            lastProviderPromptEstimate,
          );
          if (needsCompaction(
            messages,
            effectiveContextTokens,
            model,
            systemOverheadTokens,
            maxOutputTokens,
            providerCallReportedTokens,
          ) && !skipProactiveCompactUntilGrowth) {
            logger.info(
              { turnIndex, retryAttempt, effectiveContextTokens, servedModel, compactionWindowMode },
              'Pre-provider context compaction triggered',
            );
            await applyAutomaticSemanticCompaction('pre-provider');
            compactionAction = 'compact';
            preProviderBudgetExceeded = true;
            effectiveReportedTokens = 0;
            promptBudget = estimatePromptTokenBudget({
              messages,
              systemPrompt,
              toolDefs,
              model,
              sourceKind: promptBudget.sourceKind,
            });
          }

          const requestKind = postCompactionRequestKind;
          postCompactionRequestKind = undefined;
          result = await executeTurn(
            messages,
            provider,
            model,
            systemPrompt,
            toolDefs,
            toolRegistry,
            permissions,
            emitter,
            toolContext,
            maxOutputTokens,
            temperature,
            undefined, // onPermissionAsk
            undefined, // hookEngine
            thinkingLevel,
            (() => {
              const ms = talkSeatTurnTimeoutMs();
              const talkAbort = ms ? AbortSignal.timeout(ms) : undefined;
              if (talkAbort && agentConfig.abortSignal) {
                return AbortSignal.any([talkAbort, agentConfig.abortSignal]);
              }
              return talkAbort ?? agentConfig.abortSignal;
            })(),
            reasoningEffort,
            undefined, // fastMode
            coerceToolParamsFn,
            undefined, // toolRetry
            {
              contextWindow: maxContextTokens,
              ...(requestKind ? { requestKind } : {}),
              observe: (snapshot: ProviderPrefixSnapshot) => {
                const previous = typeof store.loadProviderPrefixSnapshot === 'function'
                  ? store.loadProviderPrefixSnapshot(session.id)
                  : null;
                const continuity = compareProviderPrefixSnapshots(previous, snapshot);
                if (typeof store.saveProviderPrefixSnapshot === 'function') {
                  store.saveProviderPrefixSnapshot(session.id, snapshot);
                }
                const log = continuity.cacheBreaking ? logger.warn.bind(logger) : logger.info.bind(logger);
                log(
                  { sessionId: session.id, model, continuity, ...providerPrefixContinuityLogFields(continuity) },
                  providerPrefixContinuityLogMessage(continuity),
                );
                return continuity;
              },
            },
            talkOneShot ? 'none' : undefined,
          );
          break; // Success
        } catch (turnErr) {
          const status = (turnErr as { status?: number }).status;
          const code = (turnErr as { code?: string }).code;
          const msg = (turnErr as Error).message ?? '';
          // Rate limit errors are fully handled by the provider (rotation + stall).
          // Do NOT retry them here to avoid 429-spamming.
          const isRateLimit = status === 429 || (turnErr as any).allAccountsExhausted ||
            (turnErr as any).providerPoolDry === true || /provider_pool_dry/i.test(msg) ||
            /all.*account.*rate.limited/i.test(msg);
          if (isRateLimit) throw turnErr;

          // CTX-154: maintenance mode (cortex 503 type=maintenance). The model is
          // intentionally offline; retrying in-loop just storms a backend the
          // operator is maintaining. End the turn cleanly — the agent's heartbeat/
          // inbox cycle re-attempts later (the desired graceful-pause behavior).
          // status>=500 would otherwise classify this transient below.
          const isMaintenance = (turnErr as { maintenance?: boolean }).maintenance === true ||
            /model in maintenance|type"?:\s*"?maintenance/i.test(msg);
          if (isMaintenance) {
            logger.warn({ turnIndex }, 'Model in maintenance — ending turn, will retry on next heartbeat');
            throw turnErr;
          }

          // Model exclusivity lease (cortex 503 model_leased): another agent holds
          // the sprint. Provider already long-backed-off; do NOT re-enter as a
          // short transient 5xx retry (Rui 2026-07-28 hammered 40×). End turn;
          // heartbeat / next message re-attempts after the lease can flip.
          const isModelLeased = (turnErr as { modelLeased?: boolean }).modelLeased === true ||
            /model_leased|leased to another agent/i.test(msg);
          if (isModelLeased) {
            logger.warn({ turnIndex }, 'Model leased to another agent — ending turn, will retry after long pause / next heartbeat');
            throw turnErr;
          }

          // Context overflow — run provider-backed semantic compaction and retry
          // once. A second overflow fails loud: destructively dropping old
          // history is not an acceptable fallthrough for a safety rewrite.
          const isContextOverflow = isContextOverflowError(status, code, msg);
          if (isContextOverflow) {
            logger.warn({ turnIndex, effectiveContextTokens, msgCount: messages.length, retryAttempt },
              'Context overflow detected — provider-backed semantic recovery');
            try { struggleAnalyzer.suspendStall(); } catch { /* best-effort */ }
            if (!overflowRecoveryAttempted) {
              await applyAutomaticSemanticCompaction('overflow-recovery');
              compactionAction = 'compact';
              preProviderBudgetExceeded = true;
              effectiveReportedTokens = 0;
              promptBudget = estimatePromptTokenBudget({
                messages,
                systemPrompt,
                toolDefs,
                model,
                sourceKind: promptBudget.sourceKind,
              });
              overflowRecoveryAttempted = true;
              try { struggleAnalyzer.onTurnStart(); } catch { /* best-effort */ }
              continue;
            }
            throw turnErr;
          }

          const isToolParseTransient = /returned no parsable tool calls/i.test(msg);
          // SCLI-88: mid-stream drops + OpenAI Codex intermittent server_error must
          // re-run the turn instead of ending the agent loop — indefinitely.
          const {
            isTransientProviderFailure,
            sleepMs,
            transientRetryDelayMs,
          } = await import('../provider/transient-errors.js');
          const isStreamDrop = isTransientProviderFailure({
            message: msg,
            code,
            retryable: (turnErr as { retryable?: boolean }).retryable,
            status,
            hadSuccessfulProviderTurn: turnIndex > 0,
          }) || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_REQ_RETRY';
          const isTransient = (status != null && status >= 500) ||
            code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' ||
            isToolParseTransient || isStreamDrop;
          if (!isTransient) {
            throw turnErr;
          }
          const jitter = transientRetryDelayMs(retryAttempt);
          logger.warn({ attempt: retryAttempt + 1, delay: Math.round(jitter), status, code },
            `Transient API error, retrying turn indefinitely...`);
          // SCLI-88: make the retry VISIBLE in the TUI — never a silent mid-turn cut.
          try {
            emitter.emit({
              type: 'provider_status',
              message: `Upstream interrupted (${code || status || 'stream drop'}) — retrying turn (attempt ${retryAttempt + 1}, indefinite) in ${Math.round(jitter / 1000)}s…`,
              level: 'warning',
              code: 'turn_retry',
              attempt: retryAttempt + 1,
              retryInMs: Math.round(jitter),
              timestamp: Date.now(),
            });
          } catch { /* best-effort — visibility only */ }
          await sleepMs(jitter);
        }
      }

      // Non-thinking models must never persist reasoning-only output. Handle this
      // before appending the assistant message so hidden/stale reasoning cannot
      // contaminate resume context or the durable transcript.
      if (result.toolCalls.length === 0
        && !modelProfile.supportsThinking
        && !hasVisibleAssistantText(result.assistantMessage.content)) {
        const reasoningStr = reasoningTextFromContent(result.assistantMessage.content);
        if (reasoningStr.length > 0) {
          logger.warn(
            { turnIndex, reasoningLen: reasoningStr.length, model },
            'SCLI-9: non-thinking model returned reasoning-only output before persistence; dropping assistant block',
          );
          if (nonThinkingReasoningRecoveryCount < MAX_NON_THINKING_REASONING_RECOVERY) {
            nonThinkingReasoningRecoveryCount++;
            const retryMsg: Message = {
              role: 'user',
              content: 'Your previous response was not visible to the user. Reply again with the final answer in normal visible text only.',
              timestamp: Date.now(),
            };
            messages.push(retryMsg);
            store.appendMessage(session.id, retryMsg);
            continue;
          }
          logger.warn(
            { turnIndex, stopReason: result.stopReason, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
            'SCLI-9: reasoning-only response persisted nowhere after all recovery attempts — stopping loop',
          );
          break;
        }
      }

      // Persist the provider's assistant message exactly. Context maintenance
      // may summarize it semantically later, but this boundary must never clip
      // content before the append-only transcript records it.
      const assistantMsg = result.assistantMessage;
      messages.push(assistantMsg);
      store.appendMessage(session.id, assistantMsg);

      // Append tool results as user message (for next turn)
      if (result.toolResults.length > 0) {
        const toolResultBlocks: ContentBlock[] = result.toolResults.map((tr) => {
          let content = tr.content;
          // Apply model-specific response adapter (e.g., qwen-code format)
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
        });
        const toolResultMessage: Message = {
          role: 'user',
          content: toolResultBlocks,
          timestamp: Date.now(),
        };
        messages.push(toolResultMessage);
        store.appendMessage(session.id, toolResultMessage);
      }

      // SCLI-218: dynamic context windows — when the backend served a different
      // concrete model (cortex/auto rung change), re-resolve the compaction
      // budget so the pre/post-turn gates run against the window that actually
      // applies, and surface the change to consumers (status bar honesty).
      if (result.servedModel && result.servedModel !== servedModel) {
        const previousWindow = effectiveContextTokens;
        servedModel = result.servedModel;
        servedWindowFromBackend = result.servedContextWindow ?? servedWindowFromBackend;
        effectiveContextTokens = resolveDynamicCompactionWindow({
          requestedModel: model,
          servedModel,
          ...(servedWindowFromBackend != null ? { servedContextWindow: servedWindowFromBackend } : {}),
          source: provider,
          configured: configuredWindow,
          mode: compactionWindowMode,
        });
        if (servedModel !== model || effectiveContextTokens !== previousWindow) {
          logger.info(
            { turnIndex, requestedModel: modelSlug, servedModel, previousWindow, effectiveContextTokens, compactionWindowMode },
            'SCLI-218: served model resolved — compaction window re-resolved',
          );
          yield {
            type: 'served_model',
            requestedModel: modelSlug,
            model: servedModel,
            contextWindow: effectiveContextTokens,
            timestamp: Date.now(),
          };
        }
      }

      // Update token counts
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      // SCLI-182: remember the real prompt size for the next pre-turn gate.
      if (result.inputTokens > 0) lastReportedPromptTokens = result.inputTokens;
      if (result.providerPromptEstimate != null && result.providerPromptEstimate > 0) lastProviderPromptEstimate = result.providerPromptEstimate;
      if (result.cacheCreationInputTokens) totalCacheCreationInputTokens += result.cacheCreationInputTokens;
      if (result.cacheReadInputTokens) totalCacheReadInputTokens += result.cacheReadInputTokens;
      store.updateTokens(session.id, result.inputTokens, result.outputTokens);

      // Compact every completed subturn before any continuation/break decision.
      // In particular, a text-only final used to break above the old post-turn
      // gate, leaving an oversized session for the next user request.
      const postTurnEffectiveTokens = providerPromptTokensOrEstimate(
        lastReportedPromptTokens,
        lastProviderPromptEstimate,
      );
      if (needsCompaction(
        messages,
        effectiveContextTokens,
        model,
        systemOverheadTokens,
        maxOutputTokens,
        postTurnEffectiveTokens,
      )) {
        await applyAutomaticSemanticCompaction('post-turn');
        compactionAction = 'compact';
      }

      const turnDurationMs = Date.now() - turnStart;

      yield {
        type: 'turn_complete',
        turnIndex,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        durationMs: turnDurationMs,
        timestamp: Date.now(),
      };

      // SCLI-31: consolidate this turn's signals into the run-telemetry window
      // + durable JSONL sink via the shared helper (same impl as the exec loop).
      // A loop-guard hit = this turn's tool signature repeats the previous turn's
      // (the same condition the nudge/stop guard below acts on). Best-effort —
      // never breaks a turn.
      try {
        const sig = toolCallSignature(result.toolCalls);
        recordTurnTelemetry({
          window: telemetryWindow,
          sink: telemetrySink,
          result,
          providerName: provider.name,
          runId: telemetryRunId,
          ...(agentLabel ? { agentLabel } : {}),
          turnIndex,
          model,
          turnDurationMs,
          loopGuardHit: sig !== null && sig === previousToolSignature,
          promptBudget,
          compactionAction,
          preProviderBudgetExceeded,
        });
      } catch (err) {
        logger.debug({ err }, 'SCLI-31: turn-telemetry capture failed (non-fatal)');
      }
      // SCLI-32: run the window-driven struggle heuristics now that this turn's
      // record is in the window. Pass the actual post-decision continuation state:
      // recovery turns (max_tokens, silent-gen, thinking-only) have no tool calls
      // but still loop back — LONG_RUN must fire on those too. Best-effort.
      // Capture struggle events before calling onTurnRecorded() so they are
      // yielded to generator consumers (sub-agents, SSE streams) in addition to
      // being handled by the auto-filer's internal subscription (Codex P2 fix).
      const _turnStruggles: AgentEvent[] = [];
      const _struggleUnsub = emitter.on('struggle', (e: AgentEvent) => { _turnStruggles.push(e); });
      try {
        const _c = result.assistantMessage.content;
        const _txt = visibleTextFromContent(_c);
        const _reasoning = Array.isArray(_c) ? _c.some((b) => b.type === 'reasoning') : false;
        const _isThinkingOnly = !_txt.replace(/<think>[\s\S]*?<\/think>/g, '').trim() && _txt.length > 0;
        const continuing = !talkOneShot && (
          result.toolCalls.length > 0
          || (result.outputTokens === 0 && silentGenerationCount < MAX_SILENT_GENERATION_RECOVERY)
          || (_reasoning && !_txt.trim() && !modelProfile.supportsThinking
            && nonThinkingReasoningRecoveryCount < MAX_NON_THINKING_REASONING_RECOVERY)
          || (_isThinkingOnly && thinkingOnlyRecoveryCount < MAX_THINKING_ONLY_RECOVERY)
        );
        if (!continuing && taskRegistry.runningCount > 0 && isBackgroundTaskWaitContentIntent(_c)) {
          struggleAnalyzer.onTurnRecorded(true);
        } else {
          struggleAnalyzer.onTurnRecorded(continuing);
        }
      } catch { /* best-effort */ }
      _struggleUnsub();
      for (const _s of _turnStruggles) yield _s;

      // SCLI-22: update TTFT rolling window and warn on sustained degradation.
      // Emits exactly once per degradation episode; resets when avg recovers.
      if (result.ttftMs != null && TTFT_WARN_THRESHOLD_MS > 0) {
        ttftWindow.push(result.ttftMs);
        if (ttftWindow.length > TTFT_WINDOW_SIZE) ttftWindow.shift();
        if (ttftWindow.length >= TTFT_WINDOW_SIZE) {
          const avg = ttftWindow.reduce((s, v) => s + v, 0) / ttftWindow.length;
          if (avg > TTFT_WARN_THRESHOLD_MS) {
            if (!ttftDegraded) {
              ttftDegraded = true;
              logger.warn(
                { model, ttftAvgMs: Math.round(avg), thresholdMs: TTFT_WARN_THRESHOLD_MS, window: ttftWindow.length },
                'SCLI-22: sustained TTFT degradation detected',
              );
              yield {
                type: 'warning',
                code: 'ttft_degraded',
                message: `Model '${model}' TTFT averaging ${Math.round(avg)}ms (threshold: ${TTFT_WARN_THRESHOLD_MS}ms). Consider switching to a faster model or checking provider health.`,
                timestamp: Date.now(),
              };
            }
          } else {
            ttftDegraded = false; // recovery — next degradation episode will re-emit
          }
        }
      }

      turnIndex++;

      // PLAT-216: if last turn was the stuck cleanup turn, hard-stop now regardless
      // of whether the cleanup turn had tool calls (text-only cleanup is the norm).
      if (stuckCleanupPending) {
        logger.warn(
          { turnsWithoutProgress: noProgressGuard.turnsWithoutProgress, threshold: MAX_NO_PROGRESS_TURNS },
          'PLAT-216: stuck cleanup turn done — hard stopping',
        );
        yield {
          type: 'stuck',
          reason: `Agent looped without advancing for ${noProgressGuard.turnsWithoutProgress} consecutive turns (threshold: ${MAX_NO_PROGRESS_TURNS}). Stopped after one cleanup turn.`,
          turnsWithoutProgress: noProgressGuard.turnsWithoutProgress,
          threshold: MAX_NO_PROGRESS_TURNS,
          timestamp: Date.now(),
        };
        break;
      }

      // Continuation — stop if no tool calls
      if (talkOneShot) {
        if (!visibleTextFromContent(result.assistantMessage.content).replace(/<think>[\s\S]*?<\/think>/g, '').trim()) {
          const reasoningStr = reasoningTextFromContent(result.assistantMessage.content);
          if (reasoningStr.length > 0) {
            yield { type: 'content', text: reasoningStr, timestamp: Date.now() };
          }
        }
        break;
      }
      if (result.toolCalls.length === 0) {
        if (shouldContinueAutonomousMaxTokens({
          stopReason: result.stopReason,
          permissionMode,
          reasoningText: reasoningTextFromContent(result.assistantMessage.content),
          recoveryCount: thinkingOnlyRecoveryCount,
          outputTokens: result.outputTokens,
        })) {
          thinkingOnlyRecoveryCount++;
          logger.warn(
            { turnIndex, attempt: thinkingOnlyRecoveryCount, outputTokens: result.outputTokens, stopReason: result.stopReason },
            'SCLI: max_tokens hit on a thinking-only autonomous turn — continuing so the model can tool-call',
          );
          const continueMsg: Message = {
            role: 'user',
            content: AUTONOMOUS_MAX_TOKENS_CONTINUE_PROMPT,
            timestamp: Date.now(),
          };
          messages.push(continueMsg);
          store.appendMessage(session.id, continueMsg);
          continue;
        }
        const incompleteError = incompleteTurnError(result.stopReason);
        if (incompleteError) {
          logger.warn({ turnIndex, stopReason: result.stopReason }, 'SCLI: model turn ended incomplete; refusing automatic replay');
          yield { type: 'error', error: incompleteError, timestamp: Date.now() };
          break;
        }

        if (result.stopReason === 'degenerate_generation' && permissionMode !== 'plan') {
          if (degeneracyRecoveryCount < MAX_DEGENERACY_RECOVERY) {
            degeneracyRecoveryCount++;
            logger.warn(
              { turnIndex, attempt: degeneracyRecoveryCount },
              'SCLI: chatter-guard stop — re-prompting once for a concrete tool call',
            );
            const continueMsg: Message = {
              role: 'user',
              content: DEGENERACY_RECOVERY_PROMPT,
              timestamp: Date.now(),
            };
            messages.push(continueMsg);
            store.appendMessage(session.id, continueMsg);
            continue;
          }
          logger.warn(
            { turnIndex, attempts: degeneracyRecoveryCount },
            'SCLI: chatter-guard stop exhausted recovery — ending turn',
          );
          break;
        }

        const content = result.assistantMessage.content;

        // SCLI-9(a): Silent generation guard — model returned 0 output tokens.
        if (result.outputTokens === 0 && silentGenerationCount < MAX_SILENT_GENERATION_RECOVERY) {
          silentGenerationCount++;
          logger.warn(
            { turnIndex, attempt: silentGenerationCount, stopReason: result.stopReason },
            'SCLI-9: silent generation (0 output tokens) — retrying with short prompt',
          );
          const retryMsg: Message = {
            role: 'user',
            content: 'Please respond. What is your answer or next step?',
            timestamp: Date.now(),
          };
          messages.push(retryMsg);
          store.appendMessage(session.id, retryMsg);
          continue;
        }

        // SCLI-9(b): Reasoning-channel surfacing — model put its answer entirely
        // into a reasoning/thinking block with no text content. Try rawContent
        // first (vLLM/OpenAI-compatible), then fall back to summary[].text
        // (Anthropic extended thinking).
        const reasoningStr = reasoningTextFromContent(content);
        const textContent = visibleTextFromContent(content);
        const strippedContent = strippedVisibleTextFromContent(content);
        const hasActionableText = strippedContent.length > 0;

        if (!hasActionableText && reasoningStr.length > 0) {
          if (modelProfile.supportsThinking) {
            logger.info(
              { turnIndex, reasoningLen: reasoningStr.length },
              'SCLI-9: surfacing reasoning-only answer (no text content) — stopping loop',
            );
            yield { type: 'content', text: reasoningStr, timestamp: Date.now() };
            break;
          }
          logger.warn(
            { turnIndex, reasoningLen: reasoningStr.length, model },
            'SCLI-9: non-thinking model returned reasoning-only output; treating as invalid provider response',
          );
          if (nonThinkingReasoningRecoveryCount < MAX_NON_THINKING_REASONING_RECOVERY) {
            nonThinkingReasoningRecoveryCount++;
            const retryMsg: Message = {
              role: 'user',
              content: 'Your previous response was not visible to the user. Reply again with the final answer in normal visible text only.',
              timestamp: Date.now(),
            };
            messages.push(retryMsg);
            store.appendMessage(session.id, retryMsg);
            continue;
          }
        }

        // SCLI-9(c): Thinking-only re-prompt — model generated <think>...</think>
        // but no actionable output. Re-prompt separately from truncation recovery.
        if (!talkOneShot && !hasActionableText && textContent.length > 0 && thinkingOnlyRecoveryCount < MAX_THINKING_ONLY_RECOVERY) {
          thinkingOnlyRecoveryCount++;
          logger.info(
            { turnIndex, attempt: thinkingOnlyRecoveryCount, outputTokens: result.outputTokens },
            'SCLI-9: thinking-only response — re-prompting for action',
          );
          const continueMsg: Message = {
            role: 'user',
            content: 'Continue. Use your tools to implement the solution.',
            timestamp: Date.now(),
          };
          messages.push(continueMsg);
          store.appendMessage(session.id, continueMsg);
          continue;
        }

        if (!hasActionableText) {
          logger.warn(
            { turnIndex, stopReason: result.stopReason, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
              silentGenerationCount, thinkingOnlyRecoveryCount },
            'SCLI-9: model returned empty response after all recovery attempts — stopping loop',
          );
        }
        if (hasActionableText) {
          const backgroundAction = await decideBackgroundTaskContinuation({
            controller: backgroundTaskWait,
            registry: taskRegistry,
            toolCallCount: result.toolCalls.length,
            assistantContent: result.assistantMessage.content,
          });
          if (backgroundAction === 'continue') continue;
          if (backgroundAction === 'nudge') {
            const nudgeMsg = backgroundTaskWait.nudgeMessage();
            messages.push(nudgeMsg);
            store.appendMessage(session.id, nudgeMsg);
            continue;
          }
        }
        if (hasActionableText && permissionMode !== 'plan' && isProgressOnlyAssistantText(strippedContent)) {
          if (progressOnlyRecoveryCount < MAX_PROGRESS_ONLY_RECOVERY) {
            progressOnlyRecoveryCount++;
            logger.warn(
              { turnIndex, attempt: progressOnlyRecoveryCount, text: strippedContent.slice(0, 240) },
              'SCLI: progress-only assistant narration without tool call — re-prompting',
            );
            const continueMsg: Message = {
              role: 'user',
              content: `Your previous response was only a progress update, not a completed answer: "${strippedContent.slice(0, 240)}"\n\nDo not stop after narrating the next step. If work remains, call the appropriate tool now. If the task is actually complete, give the final answer directly.`,
              timestamp: Date.now(),
            };
            messages.push(continueMsg);
            store.appendMessage(session.id, continueMsg);
            continue;
          }
          logger.warn(
            { turnIndex, attempts: progressOnlyRecoveryCount, text: strippedContent.slice(0, 240) },
            'SCLI: model stopped after progress-only narration without calling a tool',
          );
        }
        break;
      }
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
          nudgeContent = `You have already called \`${repeatedToolNames}\` with the same input ${n} times and have its result. Prefer using that result for the NEXT step, or answer the user directly. If you intentionally need to re-run the same check (e.g. polling), continue — this is only a reminder.`;
        }
        const nudgeMsg: Message = { role: 'user', content: nudgeContent, timestamp: Date.now() };
        messages.push(nudgeMsg);
        store.appendMessage(session.id, nudgeMsg);
        continue;
      }

      if (loopVerdict.action === 'stop') {
        // Hard-stop only for failing/empty-args runaways — never success_repeat.
        const repeatedToolNames = [...new Set(result.toolCalls.map((tc) => tc.name))].join(', ');
        const errSnippet = String(erroredResult?.content ?? '');
        const guardText = loopVerdict.kind === 'empty_args' || isEmptyToolArgsError(errSnippet)
          ? `Stopped after ${loopVerdict.count} identical \`${repeatedToolNames}\` calls with empty/invalid arguments (tool schema rejected the input). This is not a working-directory issue — the tool was called without required fields. Re-issue with complete args, or answer without that tool.`
          : `Stopped after ${loopVerdict.count} identical \`${repeatedToolNames}\` calls that kept failing the same way. Likely cause: the command needs a different working directory or inputs.`;
        const guardMsg: Message = { role: 'assistant', content: guardText, timestamp: Date.now() };
        messages.push(guardMsg);
        store.appendMessage(session.id, guardMsg);
        yield { type: 'content', text: guardText, timestamp: Date.now() };
        break;
      }

      // PLAT-216: Cross-turn no-progress guard.
      if (MAX_NO_PROGRESS_TURNS > 0) {
        const noProgressResult = noProgressGuard.record(result.toolCalls);
        if (noProgressResult === 'stuck') {
          const n = noProgressGuard.turnsWithoutProgress;
          logger.warn({ turnsWithoutProgress: n }, 'PLAT-216: no-progress guard triggered — injecting cleanup notification');
          const stuckNotice: Message = {
            role: 'user',
            content: `[System] No-progress guard: you have repeated the same tool calls for ${n} consecutive turns without advancing. You appear to be stuck. Please post a comment or message explaining why you cannot proceed (e.g. via pulse_add_comment or message_user), then stop. This is your final turn.`,
            timestamp: Date.now(),
          };
          messages.push(stuckNotice);
          store.appendMessage(session.id, stuckNotice);
          stuckCleanupPending = true;
        }
      }

    }
  } catch (err) {
    yield {
      type: 'error',
      error: (err as Error).message,
      timestamp: Date.now(),
    };
  } finally {
    // Cleanup
    // SCLI-32: tear down the analyzer (clears the STALL idle timer), fire-and-forget
    // the auto-filer flush, then unsubscribe — on every exit path incl. error.
    // Fire-and-forget (not await): runAgent() is used by sub-agents; blocking here
    // delays the sub-agent's `complete` event and stalls the caller's tool result.
    // Unlike the exec path (index.ts) there is no forced process.exit, so pending
    // Pulse requests complete naturally after the generator finishes (Codex P2 fix).
    struggleAnalyzer.destroy();
    backgroundTaskWait.dispose();
    void struggleAutoFilerFlush().catch(() => {});
    struggleAutoFilerUnsub();
    await mcpManager.disconnectAll();
    store.close();
  }

  yield {
    type: 'complete',
    totalTurns: turnIndex,
    totalInputTokens,
    totalOutputTokens,
    totalCacheCreationInputTokens,
    totalCacheReadInputTokens,
    totalDurationMs: Date.now() - startTime,
    timestamp: Date.now(),
  };
}
