import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentConfig, MCPServerConfig } from './agent/types.js';
import { runAgent } from './agent/loop.js';
import { toSSE, toNDJSON } from './events/stream.js';
import { logger } from './utils/logger.js';
import { createDeviceAuthHook } from './devices/middleware.js';
import {
  addPendingCode, consumePendingCode, addDevice,
  removeDevice, listDevices, rotateDeviceToken, generateDeviceId,
} from './devices/store.js';
import {
  generatePairingCode, generateDeviceToken, hashToken,
  formatCode, normalizeCode, CODE_TTL_MS,
} from './devices/pairing.js';
import { checkRateLimit, recordFailure, resetFailures } from './devices/rateLimit.js';

interface QueryRequest {
  prompt: string;
  model?: string;
  cwd?: string;
  maxTurns?: number;
  permissionMode?: 'plan' | 'supervised' | 'autonomous';
  temperature?: number;
  systemPrompt?: string;
  mcpServers?: MCPServerConfig[];
  sessionId?: string;
}

export async function startServer(port = 8015, host = '0.0.0.0'): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // Device authentication
  app.addHook('preHandler', createDeviceAuthHook());

  // Serve web UI static files — canonical: sibling to binary (lib/web/)
  const currentDir = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const webDirPrimary = path.resolve(currentDir, 'web');
  // Fallback: dev layout (cwd/dist/web)
  const webDirDev = path.resolve(process.cwd(), 'dist', 'web');
  const staticDir = fs.existsSync(webDirPrimary) ? webDirPrimary : fs.existsSync(webDirDev) ? webDirDev : null;

  if (staticDir) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      decorateReply: false,
    });
    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler((_req, reply) => {
      const indexPath = path.join(staticDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        return reply.type('text/html').send(fs.createReadStream(indexPath));
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  // Health check
  app.get('/health', async () => ({ status: 'ok', service: 'shizuha', version: '0.1.0' }));

  // SSE streaming query endpoint
  app.post<{ Body: QueryRequest }>('/v1/query/stream', async (request, reply) => {
    const body = request.body;
    if (!body?.prompt) {
      return reply.status(400).send({ error: 'prompt is required' });
    }

    const config: AgentConfig = {
      model: body.model ?? 'codex-mini-latest',
      cwd: body.cwd ?? process.cwd(),
      maxTurns: body.maxTurns ?? 0, // 0 = unlimited
      permissionMode: body.permissionMode ?? 'autonomous',
      temperature: body.temperature ?? 0,
      systemPrompt: body.systemPrompt,
      mcpServers: body.mcpServers,
      sessionId: body.sessionId,
    };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      // We need to inject the prompt like in CLI mode
      // For now, use the same approach as runAgentWithPrompt
      const { AgentEventEmitter } = await import('./events/emitter.js');
      const { ToolRegistry } = await import('./tools/registry.js');
      const { registerBuiltinTools } = await import('./tools/builtin/index.js');
      const { PermissionEngine } = await import('./permissions/engine.js');
      const { ProviderRegistry } = await import('./provider/registry.js');
      const { StateStore } = await import('./state/store.js');
      const { loadConfig } = await import('./config/loader.js');
      const { buildSystemPrompt } = await import('./prompt/builder.js');
      const { compactMessages } = await import('./state/compaction.js');
      const { needsCompaction } = await import('./prompt/context.js');
      const { resolveModelContextWindow } = await import('./provider/context-window.js');
      const { MCPManager } = await import('./tools/mcp/manager.js');
      const { registerMCPTools } = await import('./tools/mcp/bridge.js');
      const { executeTurn } = await import('./agent/turn.js');

      const cfg = await loadConfig(config.cwd);
      const model = config.model ?? cfg.agent.defaultModel;
      const cwd = config.cwd ?? cfg.agent.cwd;

      const providerReg = new ProviderRegistry(cfg);
      const provider = providerReg.resolve(model);
      const toolRegistry = new ToolRegistry();
      registerBuiltinTools(toolRegistry);
      // Unregister client-side web_search when provider handles it natively
      if (provider.supportsNativeWebSearch) {
        toolRegistry.unregister('web_search');
      }
      const permissions = new PermissionEngine(config.permissionMode ?? 'autonomous', cfg.permissions.rules);
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

      const session = config.sessionId ? store.loadSession(config.sessionId) : null;
      const activeSession = session ?? store.createSession(model, cwd);
      const assistantMessageId = crypto.randomUUID();

      const toolDefs = toolRegistry.definitions();
      const systemPrompt = config.systemPrompt ?? await buildSystemPrompt({ cwd, tools: toolDefs });
      const messages = [...activeSession.messages, {
        id: crypto.randomUUID(),
        executionId: assistantMessageId,
        role: 'user' as const,
        content: body.prompt,
        timestamp: Date.now(),
      }];
      store.appendMessage(activeSession.id, messages[messages.length - 1]!);

      const sandboxCfg = cfg.sandbox;
      const sandbox = sandboxCfg?.mode !== 'unrestricted' ? sandboxCfg : undefined;
      const toolContext = { cwd, sessionId: activeSession.id, sandbox };
      const maxTurns = config.maxTurns ?? cfg.agent.maxTurns;
      const maxContextTokens = config.maxContextTokens
        ?? cfg.agent.maxContextTokens
        ?? resolveModelContextWindow(model, provider.maxContextWindow);

      // Emit session start
      const sessionStartEvent = {
        type: 'session_start' as const,
        sessionId: activeSession.id,
        model,
        messageId: assistantMessageId,
        timestamp: Date.now(),
      };
      reply.raw.write(toSSE(sessionStartEvent));

      let turnIndex = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheCreationInputTokens = 0;
      let totalCacheReadInputTokens = 0;
      const startTime = Date.now();

      // Continuation logic: error-aware nudges to prevent premature exit
      const MAX_TEXT_NUDGES = 3;
      const MAX_ERROR_NUDGES = 5;
      let consecutiveTextTurns = 0;
      let everUsedTools = false;
      let lastToolHadErrors = false;

      while (!maxTurns || turnIndex < maxTurns) {
        const turnStart = Date.now();

        // Forward emitter events to SSE
        const unsub = emitter.on('*', (event) => {
          reply.raw.write(toSSE(event));
        });

        const result = await executeTurn(
          messages, provider, model, systemPrompt, toolDefs,
          toolRegistry, permissions, emitter, toolContext,
          config.maxOutputTokens ?? cfg.agent.maxOutputTokens,
          config.temperature ?? cfg.agent.temperature,
        );

        unsub();

        result.assistantMessage.id = assistantMessageId;
        result.assistantMessage.executionId = assistantMessageId;
        messages.push(result.assistantMessage);
        store.appendMessage(activeSession.id, result.assistantMessage);

        if (result.toolResults.length > 0) {
          const trMsg = {
            role: 'user' as const,
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
          store.appendMessage(activeSession.id, trMsg);
        }

        // Track tool usage and error state
        if (result.toolCalls.length > 0) {
          everUsedTools = true;
          consecutiveTextTurns = 0;
          lastToolHadErrors = result.toolResults.some((tr) => tr.isError);
          if (!lastToolHadErrors) {
            lastToolHadErrors = result.toolResults.some((tr) =>
              /(?:FAILED|Error|error|exit code [1-9]|Traceback|AssertionError|ERRORS)/i.test(tr.content),
            );
          }
        }

        totalInputTokens += result.inputTokens;
        totalOutputTokens += result.outputTokens;
        if (result.cacheCreationInputTokens) totalCacheCreationInputTokens += result.cacheCreationInputTokens;
        if (result.cacheReadInputTokens) totalCacheReadInputTokens += result.cacheReadInputTokens;
        store.updateTokens(activeSession.id, result.inputTokens, result.outputTokens);

        reply.raw.write(toSSE({
          type: 'turn_complete', turnIndex,
          inputTokens: result.inputTokens, outputTokens: result.outputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          durationMs: Date.now() - turnStart, timestamp: Date.now(),
        }));

        turnIndex++;

        // Continuation logic: error-aware nudges
        if (result.toolCalls.length === 0) {
          consecutiveTextTurns++;
          const nudgeLimit = lastToolHadErrors ? MAX_ERROR_NUDGES : MAX_TEXT_NUDGES;
          if (everUsedTools && consecutiveTextTurns <= nudgeLimit) {
            let nudgeContent: string;
            if (lastToolHadErrors) {
              nudgeContent = '[Continue] Your previous tool execution produced errors or test failures. You must fix these issues before the task is complete. Run the tests again after making fixes to verify they pass.';
            } else {
              nudgeContent = '[Continue] If there is more work to do, continue using your tools. If you wrote code, verify it works by running the tests. If all tests pass and the task is complete, provide a brief final summary.';
            }
            const nudgeMsg = {
              role: 'user' as const,
              content: nudgeContent,
              timestamp: Date.now(),
            };
            messages.push(nudgeMsg);
            store.appendMessage(activeSession.id, nudgeMsg);
            continue;
          }
          break;
        }

        if (needsCompaction(messages, maxContextTokens)) {
          const { messages: compacted, compacted: didCompact } = await compactMessages(messages, provider, model, maxContextTokens);
          if (didCompact) {
            messages.length = 0;
            messages.push(...compacted);
            store.replaceMessages(activeSession.id, compacted);
          }
        }
      }

      reply.raw.write(toSSE({
        type: 'complete', totalTurns: turnIndex,
        totalInputTokens, totalOutputTokens,
        totalCacheCreationInputTokens, totalCacheReadInputTokens,
        totalDurationMs: Date.now() - startTime, timestamp: Date.now(),
      }));

      await mcpManager.disconnectAll();
      store.close();
    } catch (err) {
      reply.raw.write(toSSE({
        type: 'error',
        error: (err as Error).message,
        timestamp: Date.now(),
      }));
    }

    reply.raw.end();
  });

  // NDJSON streaming query endpoint
  app.post<{ Body: QueryRequest }>('/v1/query/ndjson', async (request, reply) => {
    const body = request.body;
    if (!body.prompt) {
      return reply.status(400).send({ error: 'prompt is required' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    });

    // Reuse SSE logic but output NDJSON
    // For brevity, forward to the same pattern (in production, extract shared logic)
    reply.raw.write(toNDJSON({ type: 'session_start', sessionId: 'ndjson', model: body.model ?? '', timestamp: Date.now() }));
    reply.raw.write(toNDJSON({ type: 'complete', totalTurns: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationInputTokens: 0, totalCacheReadInputTokens: 0, totalDurationMs: 0, timestamp: Date.now() }));
    reply.raw.end();
  });

  // ── Session management REST API ──

  app.get('/v1/sessions', async (request) => {
    const { StateStore } = await import('./state/store.js');
    const store = new StateStore();
    try {
      const query = request.query as { limit?: string; cwd?: string };
      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const sessions = store.listSessions(limit, query.cwd ?? process.cwd());
      return { sessions };
    } finally {
      store.close();
    }
  });

  app.get<{ Params: { id: string } }>('/v1/sessions/:id', async (request, reply) => {
    const { StateStore } = await import('./state/store.js');
    const store = new StateStore();
    try {
      const session = store.loadSession(request.params.id);
      if (!session) return reply.status(404).send({ error: 'Session not found' });
      // Return session with messages serialized
      return {
        id: session.id,
        model: session.model,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        turnCount: session.turnCount,
        name: session.name,
        messages: session.messages.map((m: any) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          timestamp: m.timestamp,
        })),
      };
    } finally {
      store.close();
    }
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>('/v1/sessions/:id', async (request, reply) => {
    const { StateStore } = await import('./state/store.js');
    const store = new StateStore();
    try {
      const body = request.body;
      if (body?.name != null) {
        store.renameSession(request.params.id, body.name);
      }
      return { ok: true };
    } finally {
      store.close();
    }
  });

  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (request) => {
    const { StateStore } = await import('./state/store.js');
    const store = new StateStore();
    try {
      store.deleteSession(request.params.id);
      return { ok: true };
    } finally {
      store.close();
    }
  });

  // ── Tool Gateway endpoints ──

  /**
   * GET /v1/tools — List available tools (catalog).
   * Useful for dashboards, scripts, and external systems to discover tools
   * without going through the LLM agent loop.
   */
  app.get<{ Querystring: { toolset?: string } }>('/v1/tools', async (request) => {
    const { ToolRegistry } = await import('./tools/registry.js');
    const { registerBuiltinTools } = await import('./tools/builtin/index.js');
    const { loadConfig } = await import('./config/loader.js');
    const { MCPManager } = await import('./tools/mcp/manager.js');
    const { registerMCPTools } = await import('./tools/mcp/bridge.js');

    const cfg = await loadConfig(process.cwd());
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    // Connect MCP servers for full catalog
    const mcpManager = new MCPManager();
    const mcpConfigs = cfg.mcp.servers ?? [];
    if (mcpConfigs.length > 0) {
      await mcpManager.connectAll(mcpConfigs);
      await registerMCPTools(mcpManager, (h) => registry.register(h));
    }

    // Apply toolset filter if requested
    const toolsetName = request.query.toolset;
    let tools = registry.list();
    if (toolsetName && toolsetName !== 'full') {
      const { ToolsetManager } = await import('./tools/toolsets.js');
      const mgr = new ToolsetManager();
      const allNames = tools.map((t) => t.name);
      const allowed = new Set(mgr.filterTools(toolsetName, allNames));
      tools = tools.filter((t) => allowed.has(t.name));
    }

    await mcpManager.disconnectAll();

    // Build definitions (JSON Schema) via the registry, then enrich with handler metadata
    const defs = registry.definitions();
    const defMap = new Map(defs.map((d) => [d.name, d]));
    const toolNames = new Set(tools.map((t) => t.name));

    await mcpManager.disconnectAll();

    return {
      tools: tools
        .filter((t) => toolNames.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          readOnly: t.readOnly,
          riskLevel: t.riskLevel,
          inputSchema: defMap.get(t.name)?.inputSchema,
        })),
      count: tools.length,
      toolset: toolsetName ?? 'full',
    };
  });

  /**
   * POST /v1/tools/invoke — Execute a single tool directly.
   * Runs the tool without the LLM agent loop — useful for scripts,
   * dashboards, cron jobs, and external integrations.
   */
  app.post<{
    Body: {
      tool: string;
      input?: Record<string, unknown>;
      cwd?: string;
      toolset?: string;
    };
  }>('/v1/tools/invoke', async (request, reply) => {
    const body = request.body;
    if (!body?.tool) {
      return reply.status(400).send({ error: 'tool is required' });
    }

    const { ToolRegistry } = await import('./tools/registry.js');
    const { registerBuiltinTools } = await import('./tools/builtin/index.js');
    const { loadConfig } = await import('./config/loader.js');
    const { MCPManager } = await import('./tools/mcp/manager.js');
    const { registerMCPTools } = await import('./tools/mcp/bridge.js');

    const cfg = await loadConfig(body.cwd ?? process.cwd());
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const mcpManager = new MCPManager();
    const mcpConfigs = cfg.mcp.servers ?? [];
    if (mcpConfigs.length > 0) {
      await mcpManager.connectAll(mcpConfigs);
      await registerMCPTools(mcpManager, (h) => registry.register(h));
    }

    // Apply toolset filter if specified
    if (body.toolset && body.toolset !== 'full') {
      const { ToolsetManager } = await import('./tools/toolsets.js');
      const mgr = new ToolsetManager();
      const allNames = registry.list().map((t) => t.name);
      const allowed = new Set(mgr.filterTools(body.toolset, allNames));
      for (const name of allNames) {
        if (!allowed.has(name)) registry.unregister(name);
      }
    }

    const handler = registry.get(body.tool);
    if (!handler) {
      await mcpManager.disconnectAll();
      return reply.status(404).send({
        error: `Tool "${body.tool}" not found`,
        available: registry.list().map((t) => t.name),
      });
    }

    const toolContext = {
      cwd: body.cwd ?? process.cwd(),
      sessionId: `tool-invoke-${Date.now()}`,
    };

    try {
      const startMs = Date.now();
      const result = await handler.execute(body.input ?? {}, toolContext);
      const durationMs = Date.now() - startMs;

      await mcpManager.disconnectAll();

      return {
        tool: body.tool,
        content: result.content,
        isError: result.isError ?? false,
        metadata: result.metadata,
        durationMs,
      };
    } catch (err) {
      await mcpManager.disconnectAll();
      return reply.status(500).send({
        error: (err as Error).message,
        tool: body.tool,
      });
    }
  });

  // ── Available toolsets endpoint ──

  app.get('/v1/toolsets', async () => {
    const { BUILTIN_TOOLSETS } = await import('./tools/toolsets.js');
    return {
      toolsets: Object.values(BUILTIN_TOOLSETS).map((ts) => ({
        name: ts.name,
        description: ts.description,
        includeCount: ts.include.length,
        excludeCount: ts.exclude?.length ?? 0,
      })),
    };
  });

  // ── Available models endpoint ──

  app.get('/v1/models', async () => {
    const { ProviderRegistry } = await import('./provider/registry.js');
    const { loadConfig } = await import('./config/loader.js');
    const cfg = await loadConfig(process.cwd());
    const providerReg = new ProviderRegistry(cfg);
    const providers = providerReg.list();

    // Return known model list
    const models = [
      { slug: 'claude-opus-4-6', provider: 'anthropic' },
      { slug: 'claude-sonnet-4-6', provider: 'anthropic' },
      { slug: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
      { slug: 'gpt-5.3-codex-spark', provider: 'openai' },
      { slug: 'gpt-5.4', provider: 'openai' },
      { slug: 'gpt-4.1', provider: 'openai' },
      { slug: 'gpt-4.1-mini', provider: 'openai' },
      { slug: 'o4-mini', provider: 'openai' },
      { slug: 'codex-mini-latest', provider: 'openai' },
      { slug: 'gemini-2.0-flash', provider: 'google' },
    ];

    return { models, providers };
  });

  // ── Device pairing endpoints ──

  // Generate a pairing code (localhost-only, enforced by middleware)
  app.post('/v1/devices/code', async () => {
    const code = generatePairingCode();
    const now = Date.now();
    addPendingCode({ code, createdAt: now, expiresAt: now + CODE_TTL_MS });
    return { code: formatCode(code), raw: code, expiresAt: now + CODE_TTL_MS };
  });

  // Pair a device using a code
  app.post<{ Body: { code: string; deviceName?: string; platform?: string } }>(
    '/v1/devices/pair',
    async (request, reply) => {
      const ip = request.ip || '';
      if (!checkRateLimit(ip)) {
        return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
      }

      const { code: rawCode, deviceName, platform } = request.body || {};
      if (!rawCode) {
        return reply.status(400).send({ error: 'code is required' });
      }

      const code = normalizeCode(rawCode);
      const pending = consumePendingCode(code);
      if (!pending) {
        recordFailure(ip);
        return reply.status(401).send({ error: 'Invalid or expired pairing code' });
      }

      resetFailures(ip);
      const token = generateDeviceToken();
      const deviceId = generateDeviceId();
      addDevice({
        deviceId,
        deviceName: deviceName || 'Unknown Device',
        platform: platform || 'unknown',
        tokenHash: hashToken(token),
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        remoteIp: ip,
      });

      return { deviceId, token, deviceName: deviceName || 'Unknown Device' };
    },
  );

  // Check pairing status (is auth required?)
  app.get('/v1/devices/status', async () => {
    const devices = listDevices();
    return { pairingRequired: devices.length > 0 };
  });

  // List paired devices (requires auth)
  app.get('/v1/devices', async () => {
    const devices = listDevices();
    return {
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        platform: d.platform,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        remoteIp: d.remoteIp,
      })),
    };
  });

  // Revoke a device (requires auth)
  app.delete<{ Params: { id: string } }>('/v1/devices/:id', async (request) => {
    const removed = removeDevice(request.params.id);
    return { ok: removed };
  });

  // Rotate a device's token (requires auth)
  app.patch<{ Params: { id: string } }>('/v1/devices/:id/rotate', async (request, reply) => {
    const token = generateDeviceToken();
    const ok = rotateDeviceToken(request.params.id, hashToken(token));
    if (!ok) return reply.status(404).send({ error: 'Device not found' });
    return { token };
  });

  await app.listen({ port, host });
  logger.info({ port, host }, 'Shizuha server started');
  console.log(`Shizuha server listening on ${host}:${port}`);
}
