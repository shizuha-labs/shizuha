import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type { Message } from '../agent/types.js';
import type { AgentEvent } from '../events/types.js';
import type { PermissionMode } from '../permissions/types.js';
import type { ToolContext } from '../tools/types.js';
import type { PermissionAskCallback } from '../agent/turn.js';
import type { LLMProvider } from '../provider/types.js';
import { resolveModelContextWindow } from '../provider/context-window.js';
import { BackgroundTaskRegistry } from '../tasks/registry.js';
import type { SessionSummary, ModelInfo } from './state/types.js';

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

  // Common known patterns → friendly messages
  if (/overloaded/i.test(raw)) return 'API is overloaded — retries exhausted. Try again in a moment.';
  if (/rate.limit/i.test(raw)) return 'Rate limited — retries exhausted. Try again in a moment.';
  if (/stream stalled/i.test(raw)) return 'Stream stalled (no response from API). Try again.';

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
  private taskRegistry = new BackgroundTaskRegistry();

  private messages: Message[] = [];
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
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
  private _thinkingLevel = 'on';
  private _reasoningEffort: string | null = null;
  private _fastMode = false;
  private _ollamaModels: string[] = [];
  private _turnPromptExcerpt: string | null = null;
  /** Estimated tokens for system prompt + tool definitions (overhead not in messages) */
  private _systemOverheadTokens = 0;
  /** Last actual input_tokens from the API response — most accurate context usage.
   *  This is the real number from Anthropic's tokenizer (system + tools + messages). */
  private _lastApiInputTokens = 0;
  /** Active plan file path when in plan mode */
  private _planFilePath: string | null = null;
  /** Cached plan mode utilities (loaded once during init) */
  private _planUtils: { generatePlanSlug: () => string; resolvePlanFilePath: (slug: string) => string } | null = null;

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

  /** Estimate current context window usage in tokens.
   *  Uses the actual API input_tokens from the last turn when available (most accurate),
   *  otherwise falls back to rough char/4 approximation with overhead.
   *  The API count includes system prompt + tools + messages as counted by Anthropic's
   *  tokenizer, which counts ~35% more than tiktoken for mixed code content. */
  get estimatedContextTokens(): number {
    // Prefer actual API count — it's from Anthropic's tokenizer and includes everything.
    // After the first turn, this gives the real number. We add a rough estimate for
    // tokens added since the last API call (new tool results, user messages).
    if (this._lastApiInputTokens > 0) {
      return this._lastApiInputTokens;
    }
    // Fallback: char/4 with overhead (before first API response)
    let total = this._systemOverheadTokens;
    for (const msg of this.messages) {
      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 4);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block && typeof block.text === 'string') total += Math.ceil(block.text.length / 4);
          if ('content' in block && typeof block.content === 'string') total += Math.ceil(block.content.length / 4);
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
  }

  private async connectMCPServers(mcpConfigs: import('../agent/types.js').MCPServerConfig[]): Promise<void> {
    const { MCPManager } = await import('../tools/mcp/manager.js');
    const { registerMCPTools, createMCPResourceReadTool } = await import('../tools/mcp/bridge.js');

    this.mcpManager = new MCPManager();
    if (mcpConfigs.length === 0) return;

    const mcpTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('MCP connection timeout')), 10000),
    );

    await Promise.race([
      (async () => {
        await this.mcpManager.connectAll(mcpConfigs);
        await registerMCPTools(this.mcpManager, (h) => this.toolRegistry.register(h));
        for (const [serverName, conn] of this.mcpManager.getAll()) {
          if (conn.capabilities?.resources) {
            this.toolRegistry.register(createMCPResourceReadTool(serverName, this.mcpManager));
          }
        }
        this.mcpManager.setToolRegistry(this.toolRegistry);
      })(),
      mcpTimeout,
    ]);
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
  }

  async init(cwd: string, model?: string, mode?: PermissionMode): Promise<void> {
    const { loadConfig } = await import('../config/loader.js');
    const { ProviderRegistry } = await import('../provider/registry.js');
    const { ToolRegistry } = await import('../tools/registry.js');
    const { registerBuiltinTools } = await import('../tools/builtin/index.js');
    const { PermissionEngine } = await import('../permissions/engine.js');
    const { AgentEventEmitter } = await import('../events/emitter.js');
    const { StateStore } = await import('../state/store.js');
    const { HookEngine } = await import('../hooks/engine.js');

    this.config = await loadConfig(cwd);
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

    // MCP connections — non-fatal if unavailable
    const mcpConfigs = this.config.mcp.servers ?? [];
    try {
      await this.connectMCPServers(mcpConfigs);
    } catch {
      // MCP connection failures are non-fatal
    }

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
    const memoryPath = require('node:path').join(process.env['HOME'] ?? '~', '.shizuha', 'MEMORY.md');
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

  /** Effective context window for compaction: explicit config override, else provider/model max. */
  private effectiveMaxContextTokens(provider?: LLMProvider | null): number {
    const configured = this.config.agent.maxContextTokens;
    if (typeof configured === 'number' && configured > 0) return configured;
    const fallback = provider?.maxContextWindow ?? this.provider?.maxContextWindow ?? 200000;
    return resolveModelContextWindow(this.model, fallback);
  }

  private upsertInterruptCheckpoint(note: string): void {
    if (!this.sessionId) return;
    this.store.saveInterruptCheckpoint(this.sessionId, {
      createdAt: Date.now(),
      promptExcerpt: this._turnPromptExcerpt ?? '(unknown prompt)',
      note,
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

  private async runCompactionWithHeartbeat(
    compactMessagesFn: (
      messages: Message[],
      provider: LLMProvider,
      model: string,
      maxTokens: number,
      options?: { force?: boolean; customInstructions?: string; abortSignal?: AbortSignal; overheadTokens?: number; planFilePath?: string },
    ) => Promise<{ messages: Message[]; compacted: boolean }>,
    provider: LLMProvider,
    maxContextTokens: number,
    options: { force?: boolean; customInstructions?: string; abortSignal?: AbortSignal; overheadTokens?: number; planFilePath?: string } | undefined,
    phase: 'pre-turn' | 'overflow-recovery' | 'post-turn' | 'manual',
  ): Promise<{ messages: Message[]; compacted: boolean }> {
    const startedAt = Date.now();
    this.emitReasoningStatus(`Compacting context (${phase})...`);
    this.upsertInterruptCheckpoint(`Compacting context (${phase})...`);
    const heartbeat = setInterval(() => {
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      this.emitReasoningStatus(`Still compacting context (${phase})... ${seconds}s elapsed`);
      this.upsertInterruptCheckpoint(`Still compacting context (${phase})... ${seconds}s elapsed`);
    }, 15000);
    heartbeat.unref?.();
    try {
      if (options?.abortSignal?.aborted) {
        throw options.abortSignal.reason ?? new Error('Interrupted');
      }
      const result = await compactMessagesFn(
        this.messages,
        provider,
        this._model,
        maxContextTokens,
        options,
      );
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      if (result.compacted) {
        this.emitReasoningStatus(`Context compaction complete (${phase}) in ${seconds}s`);
        this.upsertInterruptCheckpoint(`Context compaction complete (${phase}) in ${seconds}s`);
      } else {
        this.emitReasoningStatus(`Context compaction skipped (${phase}) in ${seconds}s`);
        this.upsertInterruptCheckpoint(`Context compaction skipped (${phase}) in ${seconds}s`);
      }
      return result;
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Submit a user prompt — runs the full multi-turn agent loop */
  async submitPrompt(prompt: string, images?: Array<{ base64: string; mediaType: string }>): Promise<void> {
    if (!this._initialized) throw new Error('Session not initialized');

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
    const { compactMessages } = await import('../state/compaction.js');
    const { needsCompaction, estimateOverheadTokens } = await import('../prompt/context.js');

    // Create session if needed
    if (!this.sessionId) {
      const session = this.store.createSession(this._model, this._cwd);
      this.sessionId = session.id;
      this.messages = [];
      this._totalInputTokens = 0;
      this._totalOutputTokens = 0;
      this._lastApiInputTokens = 0;
      this._turnCount = 0;
      this.emit('agent_event', {
        type: 'session_start', sessionId: this.sessionId,
        model: this._model, timestamp: Date.now(),
        planFilePath: this._mode === 'plan' ? this._planFilePath ?? undefined : undefined,
      });
    }

    // Extract @file mentions and prepend file contents
    let expandedPrompt = prompt;
    const mentionRegex = /@([\w.\/\-]+)/g;
    let mentionMatch;
    const fileContextParts: string[] = [];
    while ((mentionMatch = mentionRegex.exec(prompt)) !== null) {
      const filePath = mentionMatch[1]!;
      const resolved = require('node:path').resolve(this._cwd, filePath);
      try {
        const content = fs.readFileSync(resolved, 'utf-8');
        fileContextParts.push(`<file path="${resolved}">\n${content}\n</file>`);
      } catch { /* not a valid file — ignore */ }
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

    const toolDefs = this.toolRegistry.definitions();
    let systemPrompt = await buildSystemPrompt({
      cwd: this._cwd,
      tools: toolDefs,
      mode: this._mode,
      planFilePath: this._planFilePath ?? undefined,
    });

    // Inject persistent agent memory snapshot into system prompt
    const { getMemoryFilePath } = await import('../tools/builtin/memory.js');
    const memFilePath = getMemoryFilePath();
    if (memFilePath) {
      const { loadAgentMemory } = await import('../state/agent-memory.js');
      const agentMemory = await loadAgentMemory(memFilePath);
      if (agentMemory) {
        systemPrompt += '\n\n' + agentMemory;
      }
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
    const maxTurns = this.config.agent.maxTurns;
    const maxContextTokens = this.effectiveMaxContextTokens(provider);
    const maxOutputTokens = this.config.agent.maxOutputTokens;
    const temperature = this.config.agent.temperature;

    // Estimate system prompt + tool definition overhead (constant for this turn).
    // This is critical for accurate compaction timing — without it, the status bar
    // underreports usage and compaction triggers too late (e.g., 78% shown but 100% actual).
    this._systemOverheadTokens = estimateOverheadTokens(systemPrompt, toolDefs);

    this.abortController = new AbortController();
    this._turnPromptExcerpt = this.promptExcerpt(prompt);
    this.upsertInterruptCheckpoint('Turn started. Progress may be incomplete until this turn finishes.');

    // Continuation logic:
    // - Has tool_use → execute tools, continue
    // - max_tokens truncation → nudge up to 3 times
    // - No tool_use (text-only or reasoning-only) → STOP immediately
    const MAX_TRUNCATION_RECOVERY = 3;
    let truncationRecoveryCount = 0;
    let interrupted = false;
    let hadError = false;
    let lastFailureMessage: string | null = null;

    let turnIndex = 0;
    // Outer loop allows re-entering the turn loop after catch-block injection
    // (e.g., abort propagated through compaction/retry instead of executeTurn's graceful path)
    // eslint-disable-next-line no-labels
    injection_loop: while (true) { try {
      while (!maxTurns || turnIndex < maxTurns) {
        // Check abort — but if there's pending user input, it was a soft abort (instant injection)
        if (this.abortController.signal.aborted) {
          const pending = this.pendingInputQueue.shift();
          if (pending) {
            // Soft abort: inject queued message and continue
            this.emit('agent_event', { type: 'input_injected', prompt: pending.prompt, timestamp: Date.now() });
            const userMsg: Message = { role: 'user', content: pending.prompt, timestamp: Date.now() };
            this.messages.push(userMsg);
            this.store.appendMessage(this.sessionId!, userMsg);
            this._turnPromptExcerpt = this.promptExcerpt(pending.prompt);
            // Reset abort controller for continuation
            this.abortController = new AbortController();
            // fall through to next turn
          } else {
            interrupted = true;
            break;
          }
        }

        // Pre-turn compaction to avoid context-limit failures before a new API call.
        if (needsCompaction(this.messages, maxContextTokens, undefined, this._systemOverheadTokens)) {
          const { messages: compacted, compacted: didCompact } = await this.runCompactionWithHeartbeat(
            compactMessages,
            provider,
            maxContextTokens,
            { abortSignal: this.abortController?.signal, overheadTokens: this._systemOverheadTokens, planFilePath: this._planFilePath ?? undefined },
            'pre-turn',
          );
          if (didCompact) {
            this.messages.length = 0;
            this.messages.push(...compacted);
            this.store.replaceMessages(this.sessionId, compacted);
          }
        }

        this.emit('agent_event', { type: 'turn_start', turnIndex, timestamp: Date.now() });
        const turnStart = Date.now();

        // Retry transient API errors at the session level
        let result: Awaited<ReturnType<typeof executeTurn>>;
        const SESSION_MAX_RETRIES = 3;
        let recoveredFromContextOverflow = false;
        for (let retryAttempt = 0; ; retryAttempt++) {
          try {
            result = await executeTurn(
              this.messages, provider, this._model, systemPrompt, toolDefs,
              this.toolRegistry, this.permissions, this.emitter, toolContext,
              maxOutputTokens, temperature, this._permissionCallback ?? undefined,
              this.hookEngine, this._thinkingLevel !== 'off' ? this._thinkingLevel : undefined,
              this.abortController?.signal,
              this._reasoningEffort ?? undefined,
              this._fastMode,
            );
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
              || errLower.includes('too many tokens')
              || errLower.includes('input exceeds')
              || errLower.includes('prompt is too long')
              || errLower.includes('too long')
              || codeLower.includes('context');

            // Non-transient but recoverable path: compact and retry once for context overflow.
            if (isContextOverflow && !recoveredFromContextOverflow) {
              const { messages: compacted, compacted: didCompact } = await this.runCompactionWithHeartbeat(
                compactMessages,
                provider,
                maxContextTokens,
                {
                  force: true,
                  customInstructions: 'The request exceeded context limits. Preserve only critical task state, errors, decisions, and pending work. Drop large raw logs/HTML/JSON/code dumps.',
                  abortSignal: this.abortController?.signal,
                  overheadTokens: this._systemOverheadTokens,
                  planFilePath: this._planFilePath ?? undefined,
                },
                'overflow-recovery',
              );
              if (didCompact) {
                this.messages.length = 0;
                this.messages.push(...compacted);
                this.store.replaceMessages(this.sessionId, compacted);
                recoveredFromContextOverflow = true;
                this.emit('agent_event', {
                  type: 'error',
                  error: 'Context window exceeded; compacted history and retrying turn.',
                  timestamp: Date.now(),
                });
                continue;
              }
            }

            const isTransient = status === 429 || (status != null && status >= 500) ||
              code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';

            // Fast-fail 429 on the first turn: if we've never had a successful API call,
            // this likely means the API key is invalid/rate-limited/expired — not a transient blip.
            // Retrying just wastes time while the user stares at "Thinking...".
            const isFirstTurn = this._turnCount === 0 && turnIndex === 0;
            if (status === 429 && isFirstTurn) {
              throw Object.assign(new Error(
                `API key rate limited or over quota. Use /model to login with ChatGPT (free) or switch providers.`
              ), { status });
            }

            if (!isTransient || retryAttempt >= SESSION_MAX_RETRIES) {
              throw turnErr; // Not retryable or exhausted retries
            }
            const delay = Math.min(1000 * Math.pow(2, retryAttempt), 16000);
            const jitter = delay * (0.75 + Math.random() * 0.5);
            this.emit('agent_event', {
              type: 'error',
              error: `API error (${status ?? code}), retrying in ${Math.round(jitter / 1000)}s... (${retryAttempt + 1}/${SESSION_MAX_RETRIES})`,
              timestamp: Date.now(),
            });
            await new Promise((r) => setTimeout(r, jitter));
          }
        }

        // Save partial or full assistant message
        this.messages.push(result.assistantMessage);
        this.store.appendMessage(this.sessionId, result.assistantMessage);

        if (result.toolResults.length > 0) {
          const trMsg: Message = {
            role: 'user',
            content: result.toolResults.map((tr) => ({
              type: 'tool_result' as const,
              toolUseId: tr.toolUseId,
              content: tr.content,
              isError: tr.isError,
              image: tr.image,
            })),
            timestamp: Date.now(),
          };
          this.messages.push(trMsg);
          this.store.appendMessage(this.sessionId, trMsg);
        }

        this._totalInputTokens += result.inputTokens;
        this._totalOutputTokens += result.outputTokens;
        // Track actual API input tokens for accurate context usage display.
        // This is the real count from Anthropic's tokenizer (system + tools + messages).
        this._lastApiInputTokens = result.inputTokens;
        this._turnCount++;
        this.store.updateTokens(this.sessionId, result.inputTokens, result.outputTokens);

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

        // Continuation:
        // Stop on the FIRST turn with no tool calls. Only exception: max_tokens truncation
        // or pending user input in the queue.
        if (result.toolCalls.length === 0) {
          if (result.stopReason === 'max_tokens' && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY) {
            truncationRecoveryCount++;
            const nudgeMsg: Message = {
              role: 'user',
              content: 'Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.',
              timestamp: Date.now(),
            };
            this.messages.push(nudgeMsg);
            this.store.appendMessage(this.sessionId, nudgeMsg);
            continue;
          }
          // Check queue before exiting — process any messages queued during final turn
          if (this.pendingInputQueue.length > 0) {
            continue; // Loop back — top-of-loop check will inject
          }
          break;
        }
        truncationRecoveryCount = 0;

        // Post-turn compaction: use actual API input_tokens when available (most accurate).
        // The API count includes system + tools + messages as counted by Anthropic's tokenizer,
        // which is ~35% higher than tiktoken for mixed code content.
        const postTurnShouldCompact = this._lastApiInputTokens > 0
          ? this._lastApiInputTokens > maxContextTokens * 0.90
          : needsCompaction(this.messages, maxContextTokens, undefined, this._systemOverheadTokens);
        if (postTurnShouldCompact) {
          const { messages: compacted, compacted: didCompact } = await this.runCompactionWithHeartbeat(
            compactMessages,
            provider,
            maxContextTokens,
            { abortSignal: this.abortController?.signal, overheadTokens: this._systemOverheadTokens, planFilePath: this._planFilePath ?? undefined },
            'post-turn',
          );
          if (didCompact) {
            this.messages.length = 0;
            this.messages.push(...compacted);
            this.store.replaceMessages(this.sessionId, compacted);
          }
        }
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
        const pending = this.pendingInputQueue.shift()!;
        this.emit('agent_event', { type: 'input_injected', prompt: pending.prompt, timestamp: Date.now() });
        const userMsg: Message = { role: 'user', content: pending.prompt, timestamp: Date.now() };
        this.messages.push(userMsg);
        this.store.appendMessage(this.sessionId!, userMsg);
        this._turnPromptExcerpt = this.promptExcerpt(pending.prompt);
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

  /** Resume a previous session */
  async resumeSession(id: string): Promise<boolean> {
    const session = this.store.loadSession(id);
    if (!session) return false;
    this.sessionId = session.id;
    this.messages = session.messages;
    this._totalInputTokens = session.totalInputTokens;
    this._totalOutputTokens = session.totalOutputTokens;
    this._turnCount = session.turnCount;
    // Switch provider for resumed session's model without clearing messages.
    // (setModel() clears messages on provider change, which we don't want during resume.)
    if (session.model !== this._model) {
      try {
        this.provider = this.providerRegistry.resolve(session.model);
        this._model = session.model;
        this._initError = null;
      } catch { /* keep current model if resume model is unavailable */ }
    }
    this.emit('session_resumed', session);
    return true;
  }

  /** Start a new session */
  newSession(): void {
    this.sessionId = null;
    this.messages = [];
    this._lastApiInputTokens = 0;
    this._totalInputTokens = 0;
    this._totalOutputTokens = 0;
    this._turnCount = 0;
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
    const oldProvider = this.provider;
    try {
      const { provider: newProvider, resolvedModel } = this.providerRegistry.resolveWithModel(model);
      const providerChanged = oldProvider && newProvider.name !== oldProvider.name;
      this.provider = newProvider;
      // Pin auto to the resolved concrete model
      this._model = (model === 'auto' && resolvedModel !== 'auto') ? resolvedModel : model;
      this._initError = null;

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
        this._lastApiInputTokens = 0;
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
  async compact(instructions?: string): Promise<void> {
    if (!this.sessionId || this.messages.length === 0 || !this.provider) return;
    const { compactMessages } = await import('../state/compaction.js');
    const maxContextTokens = this.effectiveMaxContextTokens(this.provider);
    const { messages: compacted, compacted: didCompact } = await this.runCompactionWithHeartbeat(
      compactMessages,
      this.provider,
      maxContextTokens,
      { force: true, customInstructions: instructions, abortSignal: this.abortController?.signal, overheadTokens: this._systemOverheadTokens, planFilePath: this._planFilePath ?? undefined },
      'manual',
    );
    if (didCompact) {
      this.messages.length = 0;
      this.messages.push(...compacted);
      this.store.replaceMessages(this.sessionId, compacted);
    }
  }

  /** Interrupt current turn */
  interrupt(): void {
    this.pendingInputQueue = [];
    this.abortController?.abort();
  }

  /** Queue user input for instant mid-turn injection.
   *  Aborts the current LLM stream so the message is picked up ASAP. */
  queueInput(prompt: string, images?: Array<{ base64: string; mediaType: string }>): void {
    this.pendingInputQueue.push({ prompt, images });
    // Abort current LLM stream — the submitPrompt loop will pick up the queued message
    this.abortController?.abort();
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
      const fs = require('node:fs');
      const path = require('node:path');
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
        { slug: 'gpt-5.3-codex', desc: 'Latest frontier agentic coding model', levels: defaultEffortLevels },
        { slug: 'gpt-5.3-codex-spark', desc: 'Preferred fast coding model', levels: defaultEffortLevels },
        { slug: 'gpt-5.4', desc: 'Latest frontier model', levels: defaultEffortLevels },
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
      { slug: 'claude-opus-4-6', desc: 'Most capable, deep reasoning' },
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

    // OpenRouter models (only if configured)
    if (this.providerRegistry?.list().includes('openrouter')) {
      const orModels = [
        'anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6',
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

  /** Rename current session */
  renameSession(name: string): void {
    if (this.sessionId && this.store) {
      this.store.renameSession(this.sessionId, name);
    }
  }

  /** Fork current session — returns new session ID */
  forkSession(): string | null {
    if (!this.sessionId || !this.store) return null;
    const forked = this.store.forkSession(this.sessionId);
    return forked?.id ?? null;
  }

  /** Clean shutdown */
  async destroy(): Promise<void> {
    this.interrupt();
    try { await this.mcpManager?.disconnectAll(); } catch { /* ignore */ }
    try { this.store?.close(); } catch { /* ignore */ }
    this.removeAllListeners();
  }
}
