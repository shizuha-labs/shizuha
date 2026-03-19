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
import { compactMessages } from '../state/compaction.js';
import { needsCompaction, estimateOverheadTokens } from '../prompt/context.js';
import { resolveModelContextWindow } from '../provider/context-window.js';
import { microcompactLatest } from '../state/microcompaction.js';
import { MCPManager } from '../tools/mcp/manager.js';
import { registerMCPTools, createMCPResourceReadTool } from '../tools/mcp/bridge.js';
import { ToolSearchState, createToolSearchTool, buildServerSummaries, buildToolCatalog, buildAwarenessPrompt } from '../tools/tool-search.js';
import { BackgroundTaskRegistry } from '../tasks/registry.js';
import { executeTurn } from './turn.js';
import { logger } from '../utils/logger.js';
import { generatePlanSlug, resolvePlanFilePath } from '../tools/builtin/plan-mode.js';
import { setSearchStore } from '../tools/builtin/session-search.js';

/**
 * Core agent loop — plan → act → observe.
 * Yields AgentEvents for streaming to CLI/HTTP consumers.
 */
export async function* runAgent(agentConfig: AgentConfig): AsyncGenerator<AgentEvent> {
  const startTime = Date.now();

  // 1. Load config
  const config = await loadConfig(agentConfig.cwd);
  const model = agentConfig.model ?? config.agent.defaultModel;
  const cwd = agentConfig.cwd ?? config.agent.cwd;
  const maxTurns = agentConfig.maxTurns ?? config.agent.maxTurns;
  const temperature = agentConfig.temperature ?? config.agent.temperature;
  const maxOutputTokens = agentConfig.maxOutputTokens ?? config.agent.maxOutputTokens;
  const permissionMode = agentConfig.permissionMode ?? config.permissions.mode;
  const thinkingLevel = agentConfig.thinkingLevel;
  const reasoningEffort = agentConfig.reasoningEffort;

  // 2. Initialize components
  const providerRegistry = new ProviderRegistry(config);
  const provider = providerRegistry.resolve(model);
  const maxContextTokens = agentConfig.maxContextTokens
    ?? config.agent.maxContextTokens
    ?? resolveModelContextWindow(model, provider.maxContextWindow);

  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);

  // Unregister client-side web_search when provider handles it natively
  if (provider.supportsNativeWebSearch) {
    toolRegistry.unregister('web_search');
  }

  // Apply toolset filter — restrict available tools (e.g., 'local' for on-device models)
  const toolsetName = agentConfig.toolset;
  if (toolsetName && toolsetName !== 'full') {
    const { ToolsetManager } = await import('../tools/toolsets.js');
    const mgr = new ToolsetManager();
    const allNames = toolRegistry.list().map((t) => t.name);
    const allowed = new Set(mgr.filterTools(toolsetName, allNames));
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
    const serverSummaries = buildServerSummaries(mcpManager.getAll());
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
      toolRegistry.register(createToolSearchTool(toolSearchState));
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

    const discovered = toolSearchState.getDiscovered();
    return allDefs.filter((d) => {
      // Always include non-MCP tools (builtins, ToolSearch itself)
      if (!d.name.startsWith('mcp__')) return true;
      // Include MCP tools that have been discovered this session
      return discovered.has(d.name);
    });
  }

  let toolDefs = getToolDefs();
  const skillCatalog = skillRegistry.size > 0
    ? skillRegistry.buildCatalog()
    : undefined;
  const systemPrompt = agentConfig.systemPrompt ?? await buildSystemPrompt({
    cwd,
    tools: toolDefs,
    provider: provider.name,
    mode: permissionMode,
    planFilePath,
    mcpAwareness,
    skillCatalog,
  });

  // 7. Initialize messages
  const messages: Message[] = [...session.messages];

  // Inject MCP failure diagnostic so the LLM knows about degraded capabilities
  if (mcpManager.failedServers.length > 0) {
    const failedList = mcpManager.failedServers
      .map((f) => `- ${f.name}: ${f.error}`)
      .join('\n');
    const total = mcpManager.failedServers.length + mcpManager.size;
    const diagnostic = `[System Notice] ${mcpManager.failedServers.length}/${total} MCP tool servers failed to connect. You are operating with reduced capabilities.\n\nFailed servers:\n${failedList}\n\nInform the user about this limitation. Do not pretend everything is normal.`;
    messages.push({ role: 'user', content: [{ type: 'text', text: diagnostic }] });
  }

  const taskRegistry = new BackgroundTaskRegistry();

  // Sandbox config: agent-level override takes precedence over config file
  const sandboxConfig = agentConfig.sandboxMode
    ? { ...config.sandbox, mode: agentConfig.sandboxMode }
    : config.sandbox;
  const sandbox = sandboxConfig.mode !== 'unrestricted' ? sandboxConfig : undefined;

  const toolContext: ToolContext = { cwd, sessionId: session.id, planFilePath, taskRegistry, sandbox };

  // Estimate system prompt + tool definition token overhead for accurate compaction checks
  let systemOverheadTokens = estimateOverheadTokens(systemPrompt, toolDefs);

  // 8. Agent loop
  let turnIndex = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let totalCacheReadInputTokens = 0;

  // Continuation logic:
  // - Text-only response → STOP immediately
  // - max_tokens truncation → nudge up to 3 times
  // - Has tool_use → execute tools, continue
  const MAX_TRUNCATION_RECOVERY = 3;
  let truncationRecoveryCount = 0;

  try {
    while (!maxTurns || turnIndex < maxTurns) {
      yield { type: 'turn_start', turnIndex, timestamp: Date.now() };
      const turnStart = Date.now();

      // Pre-turn compaction check — prevents context overflow when resuming
      // a long session or when previous turns produced text-only responses
      // (the post-turn check only runs after tool calls).
      if (needsCompaction(messages, maxContextTokens, model, systemOverheadTokens)) {
        logger.info({ turnIndex, maxContextTokens }, 'Pre-turn compaction triggered');
        const { messages: compacted, compacted: didCompact } = await compactMessages(
          messages,
          provider,
          model,
          maxContextTokens,
          { overheadTokens: systemOverheadTokens, planFilePath },
        );
        if (didCompact) {
          messages.length = 0;
          messages.push(...compacted);
          store.replaceMessages(session.id, compacted);
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

      // Execute turn — retry transient API errors at the session level
      let result: Awaited<ReturnType<typeof executeTurn>>;
      const SESSION_MAX_RETRIES = 3;
      for (let retryAttempt = 0; ; retryAttempt++) {
        try {
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
            undefined, // abortSignal
            reasoningEffort,
          );
          break; // Success
        } catch (turnErr) {
          const status = (turnErr as { status?: number }).status;
          const code = (turnErr as { code?: string }).code;
          const msg = (turnErr as Error).message ?? '';
          // Rate limit errors are fully handled by the provider (rotation + stall).
          // Do NOT retry them here to avoid 429-spamming.
          const isRateLimit = status === 429 || (turnErr as any).allAccountsExhausted ||
            /all.*account.*rate.limited/i.test(msg);
          if (isRateLimit) throw turnErr;

          // Context overflow — compact and retry once instead of crashing.
          // Matches patterns from Anthropic, llama.cpp, and OpenAI APIs.
          // Check both status code (if available) and message text patterns.
          const isContextOverflow = (status === 400 || status == null) && (
            /exceed.*context/i.test(msg) || /too long/i.test(msg) ||
            /too many tokens/i.test(msg) || /maximum context/i.test(msg) ||
            /prompt is too long/i.test(msg) || /context.size/i.test(msg)
          );
          if (isContextOverflow && retryAttempt === 0) {
            logger.warn({ turnIndex, maxContextTokens, msgCount: messages.length },
              'Context overflow detected — emergency compaction');
            const { messages: compacted, compacted: didCompact } = await compactMessages(
              messages, provider, model, maxContextTokens,
              { overheadTokens: systemOverheadTokens, planFilePath },
            );
            if (didCompact) {
              messages.length = 0;
              messages.push(...compacted);
              store.replaceMessages(session.id, compacted);
              continue; // Retry the turn with compacted context
            }
            throw turnErr; // Compaction didn't help
          }

          const isTransient = (status != null && status >= 500) ||
            code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
          if (!isTransient || retryAttempt >= SESSION_MAX_RETRIES) {
            throw turnErr;
          }
          const delay = Math.min(1000 * Math.pow(2, retryAttempt), 16000);
          const jitter = delay * (0.75 + Math.random() * 0.5);
          logger.warn({ attempt: retryAttempt + 1, delay: Math.round(jitter), status, code },
            `Transient API error, retrying turn...`);
          await new Promise((r) => setTimeout(r, jitter));
        }
      }

      // Append assistant message (truncate if absurdly large to prevent context overflow)
      const MAX_MESSAGE_CHARS = 50_000; // ~12.5K tokens — generous but prevents 1MB+ messages
      const assistantMsg = result.assistantMessage;
      if (typeof assistantMsg.content === 'string' && assistantMsg.content.length > MAX_MESSAGE_CHARS) {
        const original = assistantMsg.content.length;
        const head = assistantMsg.content.slice(0, Math.floor(MAX_MESSAGE_CHARS * 0.25));
        const tail = assistantMsg.content.slice(-Math.floor(MAX_MESSAGE_CHARS * 0.75));
        assistantMsg.content = head
          + `\n\n[... ${Math.ceil((original - MAX_MESSAGE_CHARS) / 4)} tokens of output truncated to prevent context overflow ...]\n\n`
          + tail;
        logger.warn({ originalChars: original, truncatedTo: assistantMsg.content.length },
          'Truncated oversized assistant message before storage');
      }
      messages.push(assistantMsg);
      store.appendMessage(session.id, assistantMsg);

      // Append tool results as user message (for next turn)
      if (result.toolResults.length > 0) {
        const toolResultBlocks: ContentBlock[] = result.toolResults.map((tr) => ({
          type: 'tool_result' as const,
          toolUseId: tr.toolUseId,
          content: tr.content,
          isError: tr.isError,
          image: tr.image,
        }));
        const toolResultMessage: Message = {
          role: 'user',
          content: toolResultBlocks,
          timestamp: Date.now(),
        };
        messages.push(toolResultMessage);
        microcompactLatest(messages);
        store.appendMessage(session.id, toolResultMessage);
      }

      // Update token counts
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      if (result.cacheCreationInputTokens) totalCacheCreationInputTokens += result.cacheCreationInputTokens;
      if (result.cacheReadInputTokens) totalCacheReadInputTokens += result.cacheReadInputTokens;
      store.updateTokens(session.id, result.inputTokens, result.outputTokens);

      yield {
        type: 'turn_complete',
        turnIndex,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        durationMs: Date.now() - turnStart,
        timestamp: Date.now(),
      };

      turnIndex++;

      // Continuation — stop if no tool calls
      if (result.toolCalls.length === 0) {
        if (result.stopReason === 'max_tokens' && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY) {
          truncationRecoveryCount++;
          const nudgeMsg: Message = {
            role: 'user',
            content: 'Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.',
            timestamp: Date.now(),
          };
          messages.push(nudgeMsg);
          store.appendMessage(session.id, nudgeMsg);
          continue;
        }

        // Detect empty responses (no text, no tool calls) — insert placeholder
        const content = result.assistantMessage.content;
        const hasText = typeof content === 'string'
          ? content.trim().length > 0
          : Array.isArray(content) && content.some((b) => b.type === 'text' && b.text.trim().length > 0);
        if (!hasText) {
          logger.warn(
            { turnIndex, stopReason: result.stopReason, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
            'Model returned empty response (no text content)',
          );
        }
        break;
      }
      truncationRecoveryCount = 0;

      // Context compaction check
      if (needsCompaction(messages, maxContextTokens, model, systemOverheadTokens)) {
        const { messages: compacted, compacted: didCompact } = await compactMessages(
          messages,
          provider,
          model,
          maxContextTokens,
          { overheadTokens: systemOverheadTokens, planFilePath },
        );
        if (didCompact) {
          messages.length = 0;
          messages.push(...compacted);
          store.replaceMessages(session.id, compacted);
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
