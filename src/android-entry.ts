/**
 * Android entry point for embedded Shizuha agent.
 *
 * Re-exports `runAgentWithPrompt` from the shared runner module.
 * No CLI (commander), no TUI (Ink/React), no program.parse() side effects.
 *
 * Usage from main.js:
 *   const { runAgentWithPrompt } = await import('./shizuha.js');
 *   for await (const event of runAgentWithPrompt(config, prompt, sessionId)) { ... }
 */

import * as crypto from 'node:crypto';

// Re-export types for consumers
export type { AgentConfig, MCPServerConfig, Message } from './agent/types.js';
export type { AgentEvent } from './events/types.js';

import type { AgentConfig } from './agent/types.js';
import type { AgentEvent } from './events/types.js';
import type { Message } from './agent/types.js';

/**
 * Run the full Shizuha agent loop with an initial user prompt.
 * Yields AgentEvent objects as an async generator.
 *
 * Copied from src/index.ts:runAgentWithPrompt (lines 986-1339).
 * This avoids importing index.ts which has program.parse() side effects.
 */
export async function* runAgentWithPrompt(
  config: AgentConfig,
  prompt: string,
  resumeSessionId?: string,
): AsyncGenerator<AgentEvent> {
  const { AgentEventEmitter } = await import('./events/emitter.js');
  const { ToolRegistry } = await import('./tools/registry.js');
  const { registerBuiltinTools } = await import('./tools/builtin/index.js');
  const { PermissionEngine } = await import('./permissions/engine.js');
  const { ProviderRegistry } = await import('./provider/registry.js');
  const { StateStore } = await import('./state/store.js');
  const { loadConfig: lc } = await import('./config/loader.js');
  const { buildSystemPrompt } = await import('./prompt/builder.js');
  const { compactMessages } = await import('./state/compaction.js');
  const { needsCompaction } = await import('./prompt/context.js');
  const { resolveModelContextWindow } = await import('./provider/context-window.js');
  const { microcompactLatest } = await import('./state/microcompaction.js');
  const { MCPManager } = await import('./tools/mcp/manager.js');
  const { registerMCPTools } = await import('./tools/mcp/bridge.js');
  const { executeTurn } = await import('./agent/turn.js');

  const cfg = await lc(config.cwd);
  let model = config.model ?? cfg.agent.defaultModel;
  const cwd = config.cwd ?? cfg.agent.cwd;
  const maxTurns = config.maxTurns ?? cfg.agent.maxTurns;
  const temperature = config.temperature ?? cfg.agent.temperature;
  const maxOutputTokens = config.maxOutputTokens ?? cfg.agent.maxOutputTokens;
  const permissionMode = config.permissionMode ?? cfg.permissions.mode;
  const thinkingLevel = config.thinkingLevel;
  const reasoningEffort = config.reasoningEffort;

  const providerReg = new ProviderRegistry(cfg);

  if (model === 'auto') {
    model = providerReg.resolveAutoModel();
  }

  let provider;
  try {
    provider = providerReg.resolve(model);
  } catch (err) {
    yield { type: 'error', error: (err as Error).message, timestamp: Date.now() };
    return;
  }

  const maxContextTokens = config.maxContextTokens
    ?? cfg.agent.maxContextTokens
    ?? resolveModelContextWindow(model, provider.maxContextWindow);
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  if (provider.supportsNativeWebSearch) {
    toolRegistry.unregister('web_search');
  }
  // Disable sub-agent task tool — not wired up for embedded mode
  toolRegistry.unregister('task');
  const permissions = new PermissionEngine(permissionMode, cfg.permissions.rules);
  const emitter = new AgentEventEmitter();
  const store = new StateStore();

  // Inject store into session search tool
  const { setSearchStore } = await import('./tools/builtin/session-search.js');
  setSearchStore(store);

  const mcpManager = new MCPManager();
  const mcpConfigs = [...(cfg.mcp.servers ?? []), ...(config.mcpServers ?? [])];
  if (mcpConfigs.length > 0) {
    await mcpManager.connectAll(mcpConfigs);
    await registerMCPTools(mcpManager, (h) => toolRegistry.register(h));
  }

  // Load skills
  const { loadSkills: loadSkillsFn } = await import('./skills/loader.js');
  const { SkillRegistry: SkillReg } = await import('./skills/registry.js');
  const { createSkillTool: createSkill } = await import('./tools/builtin/skill.js');
  const skillReg = new SkillReg();
  skillReg.registerAll(loadSkillsFn(cwd, { trustProjectSkills: cfg.skills.trustProjectSkills }));
  if (skillReg.size > 0) {
    toolRegistry.register(createSkill(skillReg));
  }

  let session = resumeSessionId ? store.loadSession(resumeSessionId) : null;
  if (!session) {
    session = store.createSession(model, cwd);
  }

  const assistantMessageId = crypto.randomUUID();
  yield { type: 'session_start', sessionId: session.id, model, messageId: assistantMessageId, timestamp: Date.now() };

  const toolDefs = toolRegistry.definitions();
  const skillCatalogStr = skillReg.size > 0 ? skillReg.buildCatalog() : undefined;
  const systemPrompt = config.systemPrompt ?? await buildSystemPrompt({ cwd, tools: toolDefs, skillCatalog: skillCatalogStr });

  const messages: Message[] = [...session.messages];
  if (mcpManager.failedServers.length > 0) {
    const failedList = mcpManager.failedServers
      .map((f: { name: string; error: string }) => `- ${f.name}: ${f.error}`)
      .join('\n');
    const total = mcpManager.failedServers.length + mcpManager.size;
    const diagnostic = `[System Notice] ${mcpManager.failedServers.length}/${total} MCP tool servers failed to connect. You are operating with reduced capabilities.\n\nFailed servers:\n${failedList}\n\nInform the user about this limitation. Do not pretend everything is normal.`;
    messages.push({ role: 'user', content: diagnostic, timestamp: Date.now() });
    messages.push({ role: 'assistant', content: 'Understood. I will inform the user about the degraded tool availability.', timestamp: Date.now() });
  }
  const userMessage: Message = { id: crypto.randomUUID(), executionId: assistantMessageId, role: 'user', content: prompt, timestamp: Date.now() };
  messages.push(userMessage);
  store.appendMessage(session.id, userMessage);

  const { BackgroundTaskRegistry } = await import('./tasks/registry.js');
  const taskRegistry = new BackgroundTaskRegistry();
  const toolContext = { cwd, sessionId: session.id, taskRegistry, sandbox: undefined };
  const startTime = Date.now();
  let turnIndex = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let totalCacheReadInputTokens = 0;

  const MAX_TRUNCATION_RECOVERY = 3;
  let truncationRecoveryCount = 0;

  try {
    while (!maxTurns || turnIndex < maxTurns) {
      yield { type: 'turn_start', turnIndex, timestamp: Date.now() };
      const turnStart = Date.now();

      const bufferedEvents: AgentEvent[] = [];
      const liveEvents: AgentEvent[] = [];
      let wakeLive: (() => void) | null = null;
      let turnDone = false;
      let turnError: unknown = null;
      let result: Awaited<ReturnType<typeof executeTurn>> | undefined;
      const signalLive = () => {
        const wake = wakeLive;
        wakeLive = null;
        wake?.();
      };
      const unsub = emitter.on('*', (ev) => {
        if (ev.type === 'content' || ev.type === 'reasoning') {
          liveEvents.push(ev);
          signalLive();
          return;
        }
        bufferedEvents.push(ev);
      });

      const SESSION_MAX_RETRIES = 3;
      const turnPromise = (async () => {
        for (let retryAttempt = 0; ; retryAttempt++) {
          try {
            result = await executeTurn(
              messages, provider, model, systemPrompt, toolDefs,
              toolRegistry, permissions, emitter, toolContext,
              maxOutputTokens, temperature,
              undefined, // onPermissionAsk
              undefined, // hookEngine
              thinkingLevel,
              undefined, // abortSignal
              reasoningEffort,
            );
            return;
          } catch (turnErr) {
            const status = (turnErr as { status?: number }).status;
            const code = (turnErr as { code?: string }).code;
            const msg = (turnErr as Error).message ?? '';
            const isRateLimit = status === 429 || (turnErr as { allAccountsExhausted?: boolean }).allAccountsExhausted ||
              /all.*account.*rate.limited/i.test(msg);
            if (isRateLimit) throw turnErr;
            const isTransient = (status != null && status >= 500) ||
              code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
            if (!isTransient || retryAttempt >= SESSION_MAX_RETRIES) {
              throw turnErr;
            }
            const delay = Math.min(1000 * Math.pow(2, retryAttempt), 16000);
            const jitter = delay * (0.75 + Math.random() * 0.5);
            bufferedEvents.push({
              type: 'error',
              error: `API error (${status ?? code}), retrying in ${Math.round(jitter / 1000)}s... (${retryAttempt + 1}/${SESSION_MAX_RETRIES})`,
              timestamp: Date.now(),
            });
            await new Promise((r) => setTimeout(r, jitter));
          }
        }
      })()
        .catch((err) => { turnError = err; })
        .finally(() => { turnDone = true; signalLive(); });

      // Flush live content/reasoning during turn execution
      while (!turnDone || liveEvents.length > 0) {
        while (liveEvents.length > 0) {
          const ev = liveEvents.shift();
          if (ev) yield ev;
        }
        if (turnDone) break;
        await new Promise<void>((resolve) => {
          wakeLive = resolve;
          if (turnDone || liveEvents.length > 0) signalLive();
        });
      }

      await turnPromise;
      unsub();
      if (turnError) throw turnError;
      if (!result) throw new Error('Turn completed without a result');

      // De-duplicate tool_start events
      const normalizedEvents: AgentEvent[] = [];
      const toolStartIdxById = new Map<string, number>();
      for (const ev of bufferedEvents) {
        if (ev.type === 'tool_start') {
          const prevIdx = toolStartIdxById.get(ev.toolCallId);
          if (prevIdx != null) {
            normalizedEvents[prevIdx] = ev;
          } else {
            toolStartIdxById.set(ev.toolCallId, normalizedEvents.length);
            normalizedEvents.push(ev);
          }
          continue;
        }
        normalizedEvents.push(ev);
      }

      for (const ev of normalizedEvents) {
        yield ev;
      }

      result.assistantMessage.id = assistantMessageId;
      result.assistantMessage.executionId = assistantMessageId;
      messages.push(result.assistantMessage);
      store.appendMessage(session.id, result.assistantMessage);

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
        messages.push(trMsg);
        microcompactLatest(messages);
        store.appendMessage(session.id, trMsg);
      }

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      if (result.cacheCreationInputTokens) totalCacheCreationInputTokens += result.cacheCreationInputTokens;
      if (result.cacheReadInputTokens) totalCacheReadInputTokens += result.cacheReadInputTokens;
      store.updateTokens(session.id, result.inputTokens, result.outputTokens);

      yield {
        type: 'turn_complete', turnIndex,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        durationMs: Date.now() - turnStart, timestamp: Date.now(),
      };

      turnIndex++;

      // Continuation logic
      if (result.toolCalls.length === 0) {
        const isClaudeModel = model.startsWith('claude-');
        if (isClaudeModel && result.stopReason === 'max_tokens' && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY) {
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
        break;
      }
      truncationRecoveryCount = 0;

      if (needsCompaction(messages, maxContextTokens)) {
        const { messages: compacted, compacted: didCompact } = await compactMessages(messages, provider, model, maxContextTokens);
        if (didCompact) {
          messages.length = 0;
          messages.push(...compacted);
          store.replaceMessages(session.id, compacted);
        }
      }
    }
  } catch (err) {
    yield { type: 'error', error: (err as Error).message, timestamp: Date.now() };
  } finally {
    await mcpManager.disconnectAll();
    store.close();
  }

  yield {
    type: 'complete', totalTurns: turnIndex,
    totalInputTokens, totalOutputTokens,
    totalCacheCreationInputTokens, totalCacheReadInputTokens,
    totalDurationMs: Date.now() - startTime, timestamp: Date.now(),
  };
}
