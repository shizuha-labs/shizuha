/**
 * Agent Process — the core runtime loop.
 *
 * Models the agent as a persistent entity with one eternal session.
 * Messages arrive from channels via the inbox, are processed sequentially,
 * and responses stream back to the originating channel.
 *
 * Like a human:
 * - One brain (session) with continuous memory
 * - Messages from many sources (channels)
 * - Processed one at a time
 * - Responds on the same medium the message arrived on
 * - Remembers everything (with compaction as forgetting)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent } from '../events/types.js';
import type { Message, ContentBlock } from '../agent/types.js';
import type { PermissionMode } from '../permissions/types.js';
import type { Channel, ChannelType, InboundMessage, GatewayConfig } from './types.js';
import { DEFAULT_FAN_OUT } from './types.js';
import { Inbox } from './inbox.js';
import { DeliveryQueue } from './delivery-queue.js';
import { MaintenanceReaper } from './reaper.js';
import { BackgroundTaskRegistry } from '../tasks/registry.js';
import type { HookEngine } from '../hooks/engine.js';
import { CronStore } from '../cron/store.js';
import { CronScheduler } from '../cron/scheduler.js';
import { setCronStore, setCronDelivery } from '../tools/builtin/cron.js';
import { SkillSearchEngine } from '../cron-mcp/skill-search.js';
import { setSkillSearchEngine } from '../tools/builtin/skill-search.js';
import { MemoryIndex } from '../memory/index.js';
import { setMemoryIndex } from '../tools/builtin/memory-index.js';
import { LoopDetector } from '../agent/loop-detector.js';
import { RateLimiter } from './rate-limiter.js';
import { UsageTracker } from './usage-tracker.js';
import { setUsageTracker } from '../tools/builtin/usage.js';
import { AutoReplyEngine } from './auto-reply.js';
import { logger } from '../utils/logger.js';
import { AuditLogger } from '../security/audit.js';
import { loadOrCreateAgentKeypair, type Keypair } from '../crypto/identity.js';
import { setAuditLogger } from '../tools/builtin/audit-log.js';
import { SpanTracker } from '../telemetry/spans.js';

const AGENT_SESSION_PREFIX = 'agent-session-';

export class AgentProcess {
  private inbox = new Inbox();
  private channels = new Map<string, Channel>();
  private running = false;
  private sessionId: string | null = null;

  // Core dependencies — lazily initialized
  private store: any = null;
  private providerReg: any = null;
  private provider: any = null;
  private toolRegistry: any = null;
  private permissions: any = null;
  private emitter: any = null;
  private mcpManager: any = null;
  private taskRegistry = new BackgroundTaskRegistry();
  private deliveryQueue: DeliveryQueue | null = null;
  private reaper: MaintenanceReaper | null = null;
  private hookEngine: HookEngine | null = null;
  private cronStore: CronStore | null = null;
  private pluginLoader: import('../plugins/loader.js').PluginLoader | null = null;
  private cronScheduler: CronScheduler | null = null;
  private rateLimiter: RateLimiter | null = null;
  private usageTracker: UsageTracker | null = null;
  private autoReplyEngine: AutoReplyEngine | null = null;
  private auditLogger: AuditLogger | null = null;
  private spanTracker: SpanTracker | null = null;
  private agentKeypair: (Keypair & { x25519Public: string; x25519Private: string }) | null = null;
  private systemPrompt = '';
  private toolDefs: any[] = [];
  private messages: Message[] = [];

  // Config
  private model: string;
  private cwd: string;
  private maxContextTokens = 0;
  private maxOutputTokens = 0;
  private temperature = 0;
  private permissionMode: string;
  private thinkingLevel?: string;
  private reasoningEffort?: string;
  private sandboxConfig?: import('../sandbox/types.js').SandboxConfig;

  // Model fallback chain — ordered list of (method, model) pairs with optional per-entry settings.
  // When the active model fails, we try the next one in the chain.
  private modelFallbacks: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string }> = [];
  /** Index into modelFallbacks for the currently pinned model (0 = primary). */
  private pinnedFallbackIndex = 0;

  /** Resolved fan-out settings (merged with defaults). */
  private fanOut: Record<ChannelType, boolean>;

  constructor(private config: GatewayConfig) {
    this.model = config.model ?? 'codex-mini-latest';
    this.cwd = config.cwd ?? process.cwd();
    this.permissionMode = config.permissionMode ?? 'autonomous';
    this.fanOut = { ...DEFAULT_FAN_OUT, ...config.fanOut };
  }

  /** Check if fan-out is enabled for a channel type. */
  isFanOutEnabled(channelType: ChannelType): boolean {
    return this.fanOut[channelType] ?? false;
  }

  /** Update fan-out settings at runtime (e.g., from dashboard API). */
  setFanOut(channelType: ChannelType, enabled: boolean): void {
    this.fanOut[channelType] = enabled;
    logger.info({ channelType, enabled }, 'Fan-out updated');
  }

  /** Get current fan-out settings. */
  getFanOutSettings(): Record<ChannelType, boolean> {
    return { ...this.fanOut };
  }

  /** Register a channel with the gateway. */
  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id, type: channel.type }, 'Channel registered');
  }

  /** Unregister a channel. */
  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  /** Get the inbox (for channels that need to push on start). */
  getInbox(): Inbox {
    return this.inbox;
  }

  /** Get all registered channels. */
  getChannels(): Channel[] {
    return Array.from(this.channels.values());
  }

  /** Whether the agent is currently processing a message. */
  isBusy(): boolean {
    return this.inbox.busy;
  }

  /** Number of messages waiting in the inbox. */
  queueDepth(): number {
    return this.inbox.depth;
  }

  /** The agent's session ID. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** The current messages (for web UI to read). */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * Initialize the agent — load config, connect to providers, set up tools.
   * Must be called before start().
   */
  async initialize(): Promise<void> {
    const { ToolRegistry } = await import('../tools/registry.js');
    const { registerBuiltinTools } = await import('../tools/builtin/index.js');
    const { PermissionEngine } = await import('../permissions/engine.js');
    const { ProviderRegistry, normalizeModelName } = await import('../provider/registry.js');
    const { StateStore } = await import('../state/store.js');
    const { loadConfig, loadAgentConfig, loadAgentClaudeMd } = await import('../config/loader.js');
    const { buildSystemPrompt } = await import('../prompt/builder.js');
    const { resolveModelContextWindow } = await import('../provider/context-window.js');
    const { AgentEventEmitter } = await import('../events/emitter.js');
    const { MCPManager } = await import('../tools/mcp/manager.js');
    const { registerMCPTools } = await import('../tools/mcp/bridge.js');

    const cfg = await loadConfig(this.cwd);

    // Load per-agent config: ~/.shizuha/agents/{username}/agent.toml + CLAUDE.md
    const agentUsername = this.config.agentUsername;
    const agentCfg = agentUsername ? await loadAgentConfig(agentUsername) : null;
    const agentClaudeMd = agentUsername ? await loadAgentClaudeMd(agentUsername) : null;

    // Priority: per-agent TOML > CLI flag > global config > defaults
    this.model = normalizeModelName(agentCfg?.model ?? this.config.model ?? cfg.agent.defaultModel);
    this.temperature = agentCfg?.temperature ?? cfg.agent.temperature;
    this.maxOutputTokens = agentCfg?.maxOutputTokens ?? cfg.agent.maxOutputTokens;
    this.permissionMode = agentCfg?.permissionMode ?? this.config.permissionMode ?? cfg.permissions.mode;
    this.thinkingLevel = agentCfg?.thinkingLevel ?? this.config.thinkingLevel;
    this.reasoningEffort = agentCfg?.reasoningEffort ?? this.config.reasoningEffort;
    this.sandboxConfig = cfg.sandbox?.mode !== 'unrestricted' ? cfg.sandbox : undefined;

    this.providerReg = new ProviderRegistry(cfg);
    if (this.model === 'auto') {
      this.model = this.providerReg.resolveAutoModel();
    }
    this.provider = this.providerReg.resolve(this.model);

    // Load model fallback chain from env (set by daemon manager)
    const fallbacksEnv = process.env['SHIZUHA_MODEL_FALLBACKS'];
    if (fallbacksEnv) {
      try {
        const parsed = JSON.parse(fallbacksEnv) as Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.modelFallbacks = parsed;
          logger.info({
            chain: parsed.map((f) => f.model),
            primary: parsed[0]!.model,
          }, 'Model fallback chain configured');
        }
      } catch {
        logger.warn('Invalid SHIZUHA_MODEL_FALLBACKS env, ignoring');
      }
    }

    this.maxContextTokens = agentCfg?.maxContextTokens
      ?? cfg.agent.maxContextTokens
      ?? resolveModelContextWindow(this.model, this.provider.maxContextWindow);

    this.toolRegistry = new ToolRegistry();
    registerBuiltinTools(this.toolRegistry);
    if (this.provider.supportsNativeWebSearch) {
      this.toolRegistry.unregister('web_search');
    }

    // Build network policy from sandbox config
    const networkPolicy = cfg.sandbox?.mode !== 'unrestricted' ? {
      networkAccess: cfg.sandbox?.networkAccess ?? false,
      allowedHosts: cfg.sandbox?.allowedHosts ?? [],
    } : undefined;
    this.permissions = new PermissionEngine(this.permissionMode as PermissionMode, cfg.permissions.rules, { networkPolicy });
    this.emitter = new AgentEventEmitter();
    // Store state.db in the working directory (mounted volume in containers)
    // so sessions survive container restarts.
    this.store = new StateStore(path.join(this.cwd, '.shizuha-state.db'));

    // Inject store into session search tool
    const { setSearchStore } = await import('../tools/builtin/session-search.js');
    setSearchStore(this.store);

    // Initialize per-user rate limiting and usage tracking
    this.rateLimiter = new RateLimiter();
    this.usageTracker = new UsageTracker(this.store);
    setUsageTracker(this.usageTracker);

    // Initialize auto-reply engine from config
    if (cfg.autoReply?.enabled && cfg.autoReply.rules.length > 0) {
      this.autoReplyEngine = new AutoReplyEngine(cfg.autoReply.rules);
    }

    // Connect MCP servers (merge per-agent servers with global)
    this.mcpManager = new MCPManager();
    let mcpConfigs = cfg.mcp.servers ?? [];
    if (agentCfg?.mcp?.servers?.length) {
      const existingNames = new Set(mcpConfigs.map((s) => s.name));
      const agentServers = agentCfg.mcp.servers.filter((s) => !existingNames.has(s.name));
      mcpConfigs = [...mcpConfigs, ...agentServers];
    }
    if (mcpConfigs.length > 0) {
      await this.mcpManager.connectAll(mcpConfigs);
      await registerMCPTools(this.mcpManager, (h: any) => this.toolRegistry.register(h));
    }

    // Load skills
    const { loadSkills } = await import('../skills/loader.js');
    const { SkillRegistry } = await import('../skills/registry.js');
    const { createSkillTool } = await import('../tools/builtin/skill.js');
    const skillRegistry = new SkillRegistry();
    skillRegistry.registerAll(loadSkills(this.cwd, { trustProjectSkills: cfg.skills.trustProjectSkills }));
    if (skillRegistry.size > 0) {
      this.toolRegistry.register(createSkillTool(skillRegistry));
      logger.info({ skillCount: skillRegistry.size }, 'Skills loaded');
    }

    // Initialize skill search engine for search_skills/use_skill tools
    // Skills are SKILL.md files in ~/.shizuha/skills/ or /opt/shizuha/skills/
    const skillsDirs = [
      path.join(process.env['HOME'] ?? '/root', '.shizuha', 'skills'),
      '/opt/skills',
      path.join(this.cwd, '.shizuha', 'skills'),
    ];
    const skillsDir = skillsDirs.find(d => fs.existsSync(d));
    if (skillsDir) {
      const skillEngine = new SkillSearchEngine(skillsDir);
      skillEngine.load();
      setSkillSearchEngine(skillEngine);
      if (skillEngine.count > 0) {
        logger.info({ skillCount: skillEngine.count }, 'Skills loaded');
      }
    }

    // Initialize memory index (FTS5 + optional vector embeddings)
    try {
      const vectorEnabled = !!(process.env['OPENAI_API_KEY'] || process.env['EMBEDDING_API_KEY']);
      const memoryIndex = new MemoryIndex(this.cwd, {
        vectorEnabled,
        embeddingApiKey: process.env['EMBEDDING_API_KEY'] || process.env['OPENAI_API_KEY'] || '',
        temporalDecay: true,
        halfLifeDays: 30,
      });
      setMemoryIndex(memoryIndex);
      const stats = await memoryIndex.sync();
      if (stats.indexed > 0 || stats.embedded > 0) {
        logger.info({ indexed: stats.indexed, embedded: stats.embedded, files: memoryIndex.stats().files }, 'Memory index synced');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Memory index init failed (non-fatal)');
    }

    // GAP C: Initialize audit logger
    this.auditLogger = new AuditLogger(this.cwd);
    setAuditLogger(this.auditLogger);
    logger.info('Audit logger initialized');

    // GAP F: Initialize telemetry span tracker
    this.spanTracker = new SpanTracker(this.cwd);
    logger.info('Telemetry span tracker initialized');

    // Initialize agent cryptographic identity (Ed25519 + X25519)
    try {
      this.agentKeypair = loadOrCreateAgentKeypair(this.cwd);
      logger.info({ publicKey: this.agentKeypair.publicKey.slice(0, 16) + '...' }, 'Agent keypair loaded');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Agent keypair init failed (non-fatal)');
    }

    // Load plugins (tools, channels, hooks, services)
    const { PluginLoader } = await import('../plugins/loader.js');
    const pluginAllowList = (agentCfg as any)?.plugins?.allow ?? cfg.plugins?.allow ?? ['*'];
    this.pluginLoader = new PluginLoader({
      workspaceDir: this.cwd,
      toolRegistry: this.toolRegistry,
      inbox: this.inbox,
      onRegisterChannel: (ch) => this.registerChannel(ch),
      allowList: pluginAllowList,
      trustProjectPlugins: cfg.skills?.trustProjectSkills ?? false,
      pluginConfigs: (agentCfg as any)?.plugins?.config ?? {},
    });
    const pluginEntries = await this.pluginLoader.loadAll();
    if (pluginEntries.length > 0) {
      const loaded = pluginEntries.filter(e => e.status === 'loaded');
      if (loaded.length > 0) {
        logger.info({ plugins: loaded.map(e => e.manifest.id) }, 'Plugins registered');
      }
    }

    // Merge LLM providers registered by plugins (overrides built-ins)
    const pluginProviders = this.pluginLoader.getProviders();
    if (pluginProviders.size > 0) {
      this.providerReg.mergePluginProviders(pluginProviders);
      // Re-resolve the active provider in case a plugin overrode it
      this.provider = this.providerReg.resolve(this.model);
      logger.info({ providers: [...pluginProviders.keys()] }, 'Plugin providers merged');
    }

    // Apply toolset filter — restrict available tools based on named toolset.
    // Priority: per-agent config > GatewayConfig > global config > default ('full')
    const toolsetName = (agentCfg as any)?.toolset ?? this.config.toolset ?? cfg.agent.toolset ?? 'full';
    if (toolsetName !== 'full') {
      const { ToolsetManager } = await import('../tools/toolsets.js');
      const toolsetManager = new ToolsetManager();
      const allToolNames = this.toolRegistry.list().map((t: any) => t.name);
      const allowedNames = toolsetManager.filterTools(toolsetName, allToolNames);
      const allowedSet = new Set(allowedNames);
      for (const name of allToolNames) {
        if (!allowedSet.has(name)) {
          this.toolRegistry.unregister(name);
        }
      }
      logger.info({ toolset: toolsetName, total: allToolNames.length, active: allowedNames.length }, 'Toolset applied');
    }

    this.toolDefs = this.toolRegistry.definitions();
    const skillCatalog = skillRegistry.size > 0 ? skillRegistry.buildCatalog() : undefined;
    const customPrompt = agentClaudeMd ?? this.config.contextPrompt ?? undefined;
    this.systemPrompt = await buildSystemPrompt({ cwd: this.cwd, tools: this.toolDefs, skillCatalog, customPrompt });

    // Initialize disk-backed delivery queue for crash-safe outbound delivery
    const stateDir = this.config.agentUsername
      ? path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents', this.config.agentUsername)
      : path.join(process.env['HOME'] ?? '~', '.shizuha');
    this.deliveryQueue = new DeliveryQueue(stateDir);
    await this.deliveryQueue.init();

    // Initialize persistent agent memory
    // Use writable workspace (not stateDir which may be read-only in containers)
    const { setMemoryFilePath } = await import('../tools/builtin/memory.js');
    const { loadAgentMemory } = await import('../state/agent-memory.js');
    const memoryPath = path.join(this.cwd, 'MEMORY.md');
    setMemoryFilePath(memoryPath);
    const agentMemory = await loadAgentMemory(memoryPath);
    if (agentMemory) {
      this.systemPrompt += '\n\n' + agentMemory;
    }

    // Inject delivery queue into channels that support it
    for (const channel of this.channels.values()) {
      channel.setDeliveryQueue?.(this.deliveryQueue);
    }

    // Initialize lifecycle hook engine (includes plugin hooks)
    const { HookEngine: HookEngineCls } = await import('../hooks/engine.js');
    const allHooks = cfg.hooks?.hooks ?? [];
    if (agentCfg && (agentCfg as any).hooks?.hooks?.length) {
      allHooks.push(...(agentCfg as any).hooks.hooks);
    }
    // Merge hooks registered by plugins
    if (this.pluginLoader) {
      allHooks.push(...this.pluginLoader.getHooks());
    }
    this.hookEngine = new HookEngineCls(allHooks);

    // Initialize maintenance reaper
    this.reaper = new MaintenanceReaper(undefined, {
      store: this.store,
      failedDir: path.join(stateDir, 'delivery-queue', 'failed'),
      queueDir: path.join(stateDir, 'delivery-queue'),
    });

    // Initialize cron store for scheduled jobs
    // Use cwd (workspace) for cron storage — it's on a mounted volume that survives
    // container restarts. The stateDir is container-local and gets wiped on restart.
    this.cronStore = new CronStore(this.cwd);
    await this.cronStore.load();
    setCronStore(this.cronStore);

    // Load or create the agent's eternal session
    this.loadEternalSession();

    logger.info({
      model: this.model,
      sessionId: this.sessionId,
      messageCount: this.messages.length,
      channels: this.channels.size,
    }, 'Agent process initialized');
  }

  /**
   * Start the agent process — begins listening on all channels and
   * processing messages from the inbox. This method runs forever.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start all channels — they begin pushing messages to the inbox
    for (const channel of this.channels.values()) {
      try {
        await channel.start(this.inbox);
        logger.info({ channelId: channel.id, type: channel.type }, 'Channel started');
      } catch (err) {
        logger.error({ channelId: channel.id, err }, 'Failed to start channel');
      }
    }

    // Recover pending deliveries from previous run and start retry loop
    if (this.deliveryQueue) {
      const recovery = await this.deliveryQueue.recoverPending();
      if (recovery.recovered > 0 || recovery.failed > 0 || recovery.deferred > 0) {
        logger.info(recovery, 'Delivery queue recovery complete');
      }
      this.deliveryQueue.startRetryLoop();
    }

    // Start maintenance reaper (cleans spill files, failed deliveries, stale temps)
    if (this.reaper) {
      this.reaper.start();
    }

    // Start rate limiter cleanup (prunes stale user buckets every 5 minutes)
    this.rateLimiter?.startCleanup();

    // Start cron scheduler for scheduled jobs.
    // Cron jobs are submitted to the inbox (not executed directly) so they
    // are serialized with user turns — prevents SSE stream interleaving.
    if (this.cronStore) {
      this.cronScheduler = new CronScheduler({
        store: this.cronStore,
        submitToInbox: (msg) => this.inbox.push(msg),
      });
      this.cronScheduler.start();
    }

    // Fire SessionStart lifecycle hook
    if (this.hookEngine?.hasHooks('SessionStart')) {
      const hookEnv: Record<string, string> = {
        SESSION_ID: this.sessionId ?? '',
        MODEL: this.model,
        CWD: this.cwd,
      };
      await this.hookEngine.runHooks('SessionStart', hookEnv);
    }

    // Start plugin services (background tasks)
    if (this.pluginLoader) {
      await this.pluginLoader.startServices();
    }

    logger.info('Agent process started — waiting for messages');

    // Main loop — runs forever
    while (this.running) {
      try {
        const msg = await this.inbox.next();
        await this.processMessage(msg);
      } catch (err) {
        if (!this.running) break; // Shutdown
        logger.error({ err }, 'Error in agent main loop');
      }
    }
  }

  /** Stop the agent process gracefully. */
  async stop(): Promise<void> {
    this.running = false;
    this.inbox.clear();

    // Fire SessionStop lifecycle hook before teardown
    if (this.hookEngine?.hasHooks('SessionStop')) {
      const hookEnv: Record<string, string> = {
        SESSION_ID: this.sessionId ?? '',
        MODEL: this.model,
        CWD: this.cwd,
      };
      await this.hookEngine.runHooks('SessionStop', hookEnv).catch(() => {}); // best-effort on shutdown
    }

    // Shutdown plugin services
    if (this.pluginLoader) {
      await this.pluginLoader.shutdown();
    }

    // Stop cron scheduler
    if (this.cronScheduler) {
      this.cronScheduler.stop();
    }

    // Stop rate limiter cleanup
    this.rateLimiter?.stopCleanup();

    // Stop maintenance reaper and delivery retry loop before tearing down channels
    if (this.reaper) {
      this.reaper.stop();
    }
    if (this.deliveryQueue) {
      this.deliveryQueue.stopRetryLoop();
    }

    for (const channel of this.channels.values()) {
      try {
        await channel.stop();
      } catch (err) {
        logger.error({ channelId: channel.id, err }, 'Error stopping channel');
      }
    }

    if (this.mcpManager) {
      await this.mcpManager.disconnectAll();
    }
    if (this.store) {
      this.store.close();
    }
  }

  // ── Private ──

  /**
   * Execute a turn with model fallback support.
   * Tries the active model first, then each fallback in order on eligible errors.
   * Pins to whichever model succeeds so subsequent turns use it directly.
   */
  private async executeTurnWithFallback(
    executeTurn: typeof import('../agent/turn.js').executeTurn,
    activeModel: string,
    activeProvider: any,
    useFallbackChain: boolean,
    toolContext: any,
    msg: InboundMessage,
    channel: Channel,
  ): Promise<any> {
    // Resolve per-entry effort/thinking for the active model (pinned or primary)
    const resolveEntrySettings = (index: number) => {
      const entry = this.modelFallbacks[index];
      return {
        thinking: entry?.thinkingLevel ?? this.thinkingLevel,
        effort: entry?.reasoningEffort ?? this.reasoningEffort,
      };
    };

    const doTurn = (provider: any, model: string, thinking?: string, effort?: string) =>
      executeTurn(
        this.messages, provider, model, this.systemPrompt, this.toolDefs,
        this.toolRegistry, this.permissions, this.emitter, toolContext,
        this.maxOutputTokens, this.temperature,
        undefined, // onPermissionAsk
        this.hookEngine ?? undefined,
        thinking ?? this.thinkingLevel,
        undefined, // abortSignal
        effort ?? this.reasoningEffort,
      );

    // Try active model first (use per-entry settings from the pinned/primary entry)
    const activeSettings = resolveEntrySettings(this.pinnedFallbackIndex);
    try {
      return await doTurn(activeProvider, activeModel, activeSettings.thinking, activeSettings.effort);
    } catch (primaryErr) {
      if (!useFallbackChain || !AgentProcess.isFallbackEligible(primaryErr)) {
        throw primaryErr;
      }

      logger.warn(
        { model: activeModel, error: (primaryErr as Error).message },
        'Primary model failed, trying fallback chain',
      );

      // Try each model in the fallback chain (skip the one that just failed)
      const { normalizeModelName } = await import('../provider/registry.js');
      for (let i = 0; i < this.modelFallbacks.length; i++) {
        if (i === this.pinnedFallbackIndex) continue; // skip the one that just failed

        const fb = this.modelFallbacks[i]!;
        const fbModel = normalizeModelName(fb.model);

        let fbProvider: any;
        try {
          fbProvider = this.providerReg.resolve(fbModel);
        } catch {
          logger.warn({ model: fbModel }, 'Fallback model provider not available, skipping');
          continue;
        }

        // Notify channel about the fallback
        try {
          await channel.sendEvent(msg.threadId, {
            type: 'model_fallback',
            fromModel: activeModel,
            toModel: fbModel,
            reason: (primaryErr as Error).message?.slice(0, 200) ?? 'unknown error',
            fallbackIndex: i,
            chainLength: this.modelFallbacks.length,
            timestamp: Date.now(),
          } as any);
        } catch { /* swallow send errors */ }

        try {
          const fbSettings = resolveEntrySettings(i);
          const result = await doTurn(fbProvider, fbModel, fbSettings.thinking, fbSettings.effort);
          // Success — pin this model for future turns
          this.pinnedFallbackIndex = i;
          this.model = fbModel;
          this.provider = fbProvider;
          logger.info(
            { fromModel: activeModel, toModel: fbModel, fallbackIndex: i },
            'Model fallback succeeded — pinned',
          );
          return result;
        } catch (fbErr) {
          logger.warn(
            { model: fbModel, error: (fbErr as Error).message },
            'Fallback model also failed, trying next',
          );
          continue;
        }
      }

      // All fallbacks exhausted — throw the original error
      throw primaryErr;
    }
  }

  /** Check if an error from executeTurn is eligible for model fallback. */
  private static isFallbackEligible(err: unknown): boolean {
    if (!(err instanceof Error)) return true;
    const msg = err.message.toLowerCase();
    // Abort/cancel — user-initiated, don't fallback
    if (msg.includes('abort') || msg.includes('cancel') || msg.includes('interrupted')) return false;
    // Content policy — model understood but refused, switching model won't help
    if (msg.includes('content policy') || msg.includes('safety filter')) return false;
    // Everything else (rate limit, server error, auth, connection, provider config) — try fallback
    return true;
  }

  /**
   * Pre-compaction memory flush — extract key facts from recent conversation
   * and persist them to the memory store before context compaction destroys them.
   *
   * Scans recent assistant messages for patterns that indicate memorable content:
   * decisions, user preferences, task outcomes, names/dates, and important findings.
   * Writes them to the workspace memory store so they survive compaction.
   */
  private async flushPreCompactionMemory(): Promise<void> {
    const memDir = path.join(this.cwd, 'memory');
    fs.mkdirSync(memDir, { recursive: true });

    // Collect recent assistant messages (the ones about to be compacted)
    const recentAssistant: string[] = [];
    for (let i = Math.max(0, this.messages.length - 20); i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg?.role !== 'assistant') continue;
      const text = Array.isArray(msg.content)
        ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : typeof msg.content === 'string' ? msg.content : '';
      if (text.length > 50) recentAssistant.push(text.slice(0, 2000));
    }
    if (recentAssistant.length === 0) return;

    // Extract sentences that look like facts, decisions, or outcomes
    const factPatterns = [
      /(?:decided|chose|agreed|concluded|determined|found|discovered|confirmed|verified|noted)\s+(?:to|that)\s+.{10,200}/gi,
      /(?:the user|user prefers?|preference|important|remember|critical|key finding|takeaway)[:\s]+.{10,200}/gi,
      /(?:deployed|fixed|resolved|completed|implemented|created|updated|configured)\s+.{10,150}/gi,
    ];

    const extracted = new Set<string>();
    for (const text of recentAssistant) {
      for (const pattern of factPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const fact = match[0].trim().replace(/\s+/g, ' ');
          if (fact.length > 20 && fact.length < 300) extracted.add(fact);
        }
      }
    }

    if (extracted.size === 0) return;

    // Append to workspace memory with timestamp
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const sessionLog = path.join(memDir, 'session-log.md');
    const lines = [`\n## Auto-saved before compaction (${now})\n`];
    for (const fact of extracted) {
      lines.push(`- ${fact}`);
    }
    lines.push('');

    fs.appendFileSync(sessionLog, lines.join('\n'));
    logger.info({ count: extracted.size }, 'Pre-compaction memory flush');
  }

  /**
   * GAP E: Validate compacted messages — ensure they form a valid conversation.
   * Returns false if the compacted output is invalid (empty, roles don't alternate, etc.)
   */
  private validateCompactedMessages(messages: Message[]): boolean {
    // Must have at least one message
    if (!messages || messages.length === 0) {
      logger.warn('Compaction produced empty message list');
      return false;
    }

    // Every message must have non-empty content
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (!msg.role) {
        logger.warn({ index: i }, 'Compacted message missing role');
        return false;
      }
      // Content can be string or array of blocks — must not be completely empty
      if (msg.content === undefined || msg.content === null) {
        logger.warn({ index: i, role: msg.role }, 'Compacted message has null/undefined content');
        return false;
      }
      if (typeof msg.content === 'string' && msg.content.length === 0 && msg.role === 'assistant') {
        logger.warn({ index: i }, 'Compacted assistant message has empty string content');
        return false;
      }
    }

    // Check role alternation — user/assistant should roughly alternate
    // (tool results may follow assistant, system messages can appear anywhere)
    let lastRole = '';
    let consecutiveSameRole = 0;
    for (const msg of messages) {
      if (msg.role === lastRole && (msg.role === 'user' || msg.role === 'assistant')) {
        consecutiveSameRole++;
        if (consecutiveSameRole > 3) {
          // More than 3 consecutive same-role messages is suspicious
          logger.warn({ role: msg.role, count: consecutiveSameRole }, 'Compaction produced too many consecutive same-role messages');
          return false;
        }
      } else {
        consecutiveSameRole = 0;
      }
      lastRole = msg.role;
    }

    return true;
  }

  /** Load or create the agent's single eternal session. */
  private loadEternalSession(): void {
    const agentSessionId = this.config.agentId
      ? `${AGENT_SESSION_PREFIX}${this.config.agentId}`
      : `${AGENT_SESSION_PREFIX}default`;

    const existing = this.store.loadSession(agentSessionId);
    if (existing) {
      this.sessionId = existing.id;
      this.messages = [...existing.messages];
      logger.info({
        sessionId: this.sessionId,
        messageCount: this.messages.length,
      }, 'Resumed eternal session');
    } else {
      // Create with a deterministic ID so it's always the same
      this.store.createSessionWithId(agentSessionId, this.model, this.cwd);
      this.sessionId = agentSessionId;
      this.messages = [];
      logger.info({ sessionId: this.sessionId }, 'Created new eternal session');
    }
  }

  /** Process a single inbound message through the agent loop. */
  private async processMessage(msg: InboundMessage): Promise<void> {
    // Cron messages are processed separately — they don't need an originating channel
    if (msg.source === 'cron') {
      await this.processCronMessage(msg);
      return;
    }

    const channel = this.channels.get(msg.channelId);
    if (!channel) {
      logger.warn({ channelId: msg.channelId }, 'Message from unknown channel, dropping');
      return;
    }

    this.inbox.busy = true;

    logger.info({
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      pathway: 'gateway_inbox',
      source: msg.source ?? 'user',
      channelId: msg.channelId,
      channelType: msg.channelType,
      threadId: msg.threadId,
      userId: msg.userId,
      userName: msg.userName,
      requestId: msg.requestId,
      executionId: msg.executionId,
      platformSessionId: msg.platformSessionId,
      contentPreview: typeof msg.content === 'string'
        ? (msg.content.length > 180 ? `${msg.content.slice(0, 180)}...` : msg.content)
        : JSON.stringify(msg.content).slice(0, 180),
    }, 'Gateway inbox message');

    // Verify cryptographic signature if present
    if (msg.senderPublicKey && msg.signature) {
      try {
        const { verifySignature } = await import('../crypto/identity.js');
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const verified = verifySignature(content, msg.timestamp, msg.senderPublicKey, msg.signature);
        if (verified) {
          // Upgrade userName to include verified badge
          msg.userName = `${msg.userName ?? msg.senderPublicKey.slice(0, 8)} ✓`;
        } else {
          logger.warn({ userId: msg.userId }, 'Message signature verification FAILED');
          msg.userName = `${msg.userName ?? 'unknown'} ⚠️ unverified`;
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Signature verification error');
      }
    }

    // Fire MessageReceived hook
    if (this.hookEngine?.hasHooks('MessageReceived')) {
      await this.hookEngine.runHooks('MessageReceived', {
        SESSION_ID: this.sessionId ?? '',
        MESSAGE_CONTENT: (msg.content ?? '').slice(0, 1000),
        CHANNEL_ID: msg.channelId,
        CHANNEL_TYPE: channel.type,
        USER_ID: msg.userId || '',
        CWD: this.cwd,
      }).catch(() => {});
    }

    // Rate limit check
    if (this.rateLimiter) {
      const check = this.rateLimiter.check(msg.userId);
      if (!check.allowed) {
        logger.warn({ userId: msg.userId, retryAfterMs: check.retryAfterMs }, 'Rate limited');
        try {
          await channel.sendEvent(msg.threadId, {
            type: 'error',
            error: `Rate limited. Please wait ${Math.ceil(check.retryAfterMs / 1000)} seconds.`,
            timestamp: Date.now(),
          });
        } catch { /* swallow */ }
        this.inbox.busy = false;
        channel.sendComplete(msg.threadId);
        return;
      }
    }

    // Auto-reply check — intercept before LLM processing
    if (this.autoReplyEngine) {
      const autoResponse = this.autoReplyEngine.check(msg);
      if (autoResponse !== null) {
        try {
          await channel.sendEvent(msg.threadId, {
            type: 'content',
            text: autoResponse,
            timestamp: Date.now(),
          });
          await channel.sendEvent(msg.threadId, {
            type: 'complete',
            totalTurns: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheCreationInputTokens: 0,
            totalCacheReadInputTokens: 0,
            totalDurationMs: 0,
            timestamp: Date.now(),
          });
        } catch { /* swallow send errors */ }
        this.inbox.busy = false;
        channel.sendComplete(msg.threadId);
        return;
      }
    }

    // Set cron delivery context so schedule_job knows where to deliver results
    setCronDelivery({
      channelId: msg.channelId,
      threadId: msg.threadId,
      channelType: msg.channelType,
    });

    // Notify queued messages that we're busy
    const queued = this.inbox.queued();
    for (let i = 0; i < queued.length; i++) {
      const queuedMsg = queued[i]!;
      const queuedCh = this.channels.get(queuedMsg.channelId);
      queuedCh?.notifyBusy?.(queuedMsg.threadId, i + 1);
    }

    try {
      // Build user message with channel context prefix
      const prefix = formatChannelPrefix(msg);
      // Content can be string, ContentBlock[], or provider-specific multimodal blocks (image + text)
      let content: Message['content'];
      if (typeof msg.content === 'string') {
        content = prefix ? `${prefix} ${msg.content}` : msg.content;
      } else if (Array.isArray(msg.content)) {
        // Multimodal content (image + text blocks from channels)
        // Prepend channel prefix to the first text block
        const blocks = [...(msg.content as ContentBlock[])];
        if (prefix) {
          const textBlock = blocks.find((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text' && 'text' in b);
          if (textBlock) {
            textBlock.text = `${prefix} ${textBlock.text}`;
          } else {
            blocks.unshift({ type: 'text', text: prefix } as ContentBlock);
          }
        }
        content = blocks;
      } else {
        content = String(msg.content);
      }

      // Add user message to eternal session
      const userMessage: Message = {
        id: msg.id,
        executionId: msg.threadId,
        role: 'user',
        content,
        timestamp: msg.timestamp,
      };
      this.messages.push(userMessage);
      this.store.appendMessage(this.sessionId, userMessage);

      // Fan-out user_message to ALL channels (including originator) so
      // cross-device clients see what the user typed. The originating
      // socket may get a duplicate, but client-side dedup (content + 60s
      // window) handles that. We broadcast to the originator too because
      // the HTTP channel may have multiple WS clients (e.g., mobile app
      // + a temporary API socket on the same channel).
      // Fan-out user_message to OTHER channel TYPES (Telegram, Discord, etc.)
      // so those platforms see what the user typed. Skip the originating channel
      // TYPE — the dashboard bridge already handles cross-client sync within
      // the same channel (it broadcasts to all subscribers except the sender).
      // Without this skip, the agent echoes the user_message back to the HTTP
      // channel → dashboard logs it again → browser gets a duplicate.
      const userMsgEvent = {
        type: 'user_message' as const,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        userName: msg.userName,
        messageId: msg.id,
        timestamp: msg.timestamp,
      };
      for (const [, otherChannel] of this.channels) {
        if (otherChannel.type === channel.type) continue; // Same channel type handles its own sync
        if (!this.fanOut[otherChannel.type]) continue;
        if (!otherChannel.broadcastEvent) continue;
        try {
          await otherChannel.broadcastEvent(userMsgEvent as any, channel.id, msg.threadId);
        } catch { /* fan-out target unavailable */ }
      }

      // Execute agent turns
      await this.executeTurns(msg, channel);

    } catch (err) {
      const errorMsg = (err as Error).message || 'Internal error';
      logger.error({ err, channelId: msg.channelId, threadId: msg.threadId }, 'Error processing message');

      // Fire AgentError hook
      if (this.hookEngine?.hasHooks('AgentError')) {
        await this.hookEngine.runHooks('AgentError', {
          SESSION_ID: this.sessionId ?? '',
          ERROR_MESSAGE: errorMsg.slice(0, 500),
          CHANNEL_ID: msg.channelId,
          CWD: this.cwd,
        }).catch(() => {});
      }

      try {
        await channel.sendEvent(msg.threadId, {
          type: 'error',
          error: errorMsg,
          timestamp: Date.now(),
        });
      } catch { /* swallow send errors */ }
    } finally {
      // Fire MessageSent hook (agent finished responding)
      if (this.hookEngine?.hasHooks('MessageSent')) {
        await this.hookEngine.runHooks('MessageSent', {
          SESSION_ID: this.sessionId ?? '',
          CHANNEL_ID: msg.channelId,
          CHANNEL_TYPE: channel.type,
          MESSAGE_COUNT: String(this.messages.length),
          CWD: this.cwd,
        }).catch(() => {});
      }

      this.inbox.busy = false;
      channel.sendComplete(msg.threadId);
    }
  }

  /**
   * Process a cron job message — standalone LLM call, no session pollution.
   * Broadcasts the result as a proactive_message to all channels.
   * Serialized through the inbox so it never interleaves with user turns.
   */
  private async processCronMessage(msg: InboundMessage): Promise<void> {
    const { cronJobId, cronJobName } = msg;
    logger.info({ cronJobId, cronJobName }, 'Processing cron job from inbox');
    this.inbox.busy = true;

    try {
      // Standalone LLM call — no session history, no tools.
      // Cron prompts are typically short reminders ("say PONG", "summarize X").
      let result = '';
      let finalResult: string | undefined;
      for await (const chunk of this.provider.chat([
        { role: 'user', content: typeof msg.content === 'string' ? msg.content : String(msg.content) },
      ], {
        model: this.model,
        maxTokens: 1000,
        reasoningEffort: 'low',
      })) {
        if (chunk.type === 'text') result += chunk.text;
        if (chunk.type === 'final_text') finalResult = chunk.text;
      }
      if (finalResult) result = finalResult;
      logger.info({ cronJobId, resultLength: result.length }, 'Cron: LLM call completed');

      // Broadcast result as proactive_message to all channels
      const proactiveMsg = `⏰ ${cronJobName}\n\n${result || msg.content}`;
      const messageId = crypto.randomUUID();
      for (const ch of this.channels.values()) {
        try {
          ch.sendEvent('proactive', {
            type: 'proactive_message',
            content: proactiveMsg,
            agentId: this.config.agentId,
            messageId,
            timestamp: Date.now(),
          } as any);
          ch.sendEvent('proactive', { type: 'complete', timestamp: Date.now() } as any);
        } catch { /* channel doesn't support proactive push */ }
      }

      // Mark job as completed
      if (cronJobId && this.cronStore) {
        await this.cronStore.markJobRun(cronJobId, 'ok');
      }
    } catch (err) {
      const errorMsg = (err as Error).message ?? 'unknown error';
      logger.error({ cronJobId, err: errorMsg }, 'Cron: job execution failed');
      if (cronJobId && this.cronStore) {
        await this.cronStore.markJobRun(cronJobId, 'error', errorMsg);
      }
    } finally {
      this.inbox.busy = false;
    }
  }

  /** Run agent turns until the model stops (no tool calls, max turns, etc.). */
  private async executeTurns(msg: InboundMessage, channel: Channel): Promise<void> {
    const { executeTurn } = await import('../agent/turn.js');
    const { microcompactLatest } = await import('../state/microcompaction.js');
    const { compactMessages } = await import('../state/compaction.js');
    const { needsCompaction } = await import('../prompt/context.js');

    const { normalizeModelName } = await import('../provider/registry.js');
    const hasPerMessageModel = !!msg.model;
    const useFallbackChain = !hasPerMessageModel && this.modelFallbacks.length > 1;

    // Resolve active model + provider (respects pinning from previous fallbacks)
    let activeModel = normalizeModelName(msg.model ?? this.model);
    let activeProvider = this.provider;

    if (useFallbackChain && this.pinnedFallbackIndex > 0) {
      const pinned = this.modelFallbacks[this.pinnedFallbackIndex];
      if (pinned) {
        try {
          const pinnedModel = normalizeModelName(pinned.model);
          activeProvider = this.providerReg.resolve(pinnedModel);
          activeModel = pinnedModel;
        } catch {
          // Pinned model's provider no longer available — reset to primary
          this.pinnedFallbackIndex = 0;
          activeModel = normalizeModelName(this.modelFallbacks[0]!.model);
          activeProvider = this.providerReg.resolve(activeModel);
        }
      }
    }

    const toolContext = { cwd: this.cwd, sessionId: this.sessionId!, taskRegistry: this.taskRegistry, sandbox: this.sandboxConfig };
    const startTime = Date.now();
    let turnIndex = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    const assistantMessageId = crypto.randomUUID();

    // Emit session start
    const sessionStartEvent: AgentEvent = {
      type: 'session_start',
      sessionId: this.sessionId!,
      model: activeModel,
      messageId: assistantMessageId,
      timestamp: Date.now(),
    };
    await channel.sendEvent(msg.threadId, sessionStartEvent);
    // Fan out session start
    for (const [, otherChannel] of this.channels) {
      if (otherChannel === channel || !this.fanOut[otherChannel.type] || !otherChannel.broadcastEvent) continue;
      try { await otherChannel.broadcastEvent(sessionStartEvent, channel.id, msg.threadId); } catch { /* ignore */ }
    }

    // Continuation nudges for truncated responses
    const MAX_TRUNCATION_RECOVERY = 3;
    let truncationRecoveryCount = 0;

    // Loop detection — catches the agent calling the same tool repeatedly
    const loopDetector = new LoopDetector();

    while (true) {
      // Pre-turn compaction check — prevents context overflow when the session
      // has accumulated too many messages (eternal sessions can grow indefinitely).
      if (needsCompaction(this.messages, this.maxContextTokens)) {
        const msgCount = this.messages.length;
        logger.info({ messageCount: msgCount, maxContextTokens: this.maxContextTokens },
          'Pre-turn compaction triggered');

        // Emergency truncation first if messages are extremely bloated (>200).
        // LLM-based compaction can't handle 200K+ token payloads — the API call
        // itself exceeds context limits or times out. Truncate to a manageable
        // size first, then compact the remainder.
        const EMERGENCY_THRESHOLD = 200;
        const KEEP_RECENT = 30;
        if (msgCount > EMERGENCY_THRESHOLD) {
          logger.warn({ messageCount: msgCount }, 'Emergency truncation — session too large for LLM compaction');
          try { await this.flushPreCompactionMemory(); } catch { /* non-fatal */ }
          const notice: import('../agent/types.js').Message = {
            role: 'user',
            content: `[System: conversation history was truncated from ${msgCount} messages to ${KEEP_RECENT} due to context size limits. Earlier context has been lost. The agent should continue from the most recent context.]`,
            timestamp: Date.now(),
          };
          const recent = this.messages.slice(-KEEP_RECENT);
          this.messages.length = 0;
          this.messages.push(notice, ...recent);
          this.store.replaceMessages(this.sessionId, this.messages);
          logger.info({ before: msgCount, after: this.messages.length }, 'Emergency truncation complete');
        } else {
          // Normal LLM-based compaction for moderately sized sessions
          try { await this.flushPreCompactionMemory(); } catch { /* non-fatal */ }
          try {
            const COMPACTION_TIMEOUT_MS = 60_000;
            const compactionPromise = compactMessages(this.messages, activeProvider, activeModel, this.maxContextTokens);
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Compaction timed out')), COMPACTION_TIMEOUT_MS));
            const { messages: compacted, compacted: didCompact } =
              await Promise.race([compactionPromise, timeoutPromise]);
            if (didCompact && this.validateCompactedMessages(compacted)) {
              this.messages.length = 0;
              this.messages.push(...compacted);
              this.store.replaceMessages(this.sessionId, compacted);
              logger.info({ before: msgCount, after: compacted.length }, 'Pre-turn compaction complete');
            }
          } catch (compactErr) {
            logger.warn({ err: (compactErr as Error).message, messageCount: this.messages.length },
              'Compaction failed — falling back to truncation');
            if (this.messages.length > KEEP_RECENT) {
              const notice: import('../agent/types.js').Message = {
                role: 'user',
                content: `[System: conversation history was truncated from ${this.messages.length} to ${KEEP_RECENT} messages due to compaction failure.]`,
                timestamp: Date.now(),
              };
              const recent = this.messages.slice(-KEEP_RECENT);
              this.messages.length = 0;
              this.messages.push(notice, ...recent);
              this.store.replaceMessages(this.sessionId, this.messages);
            }
          }
        }
      }

      const turnStart = Date.now();

      // Forward emitter events to the channel in real-time + fan out
      const unsub = this.emitter.on('*', async (event: AgentEvent) => {
        // 1. Send to originating channel (always)
        try {
          await channel.sendEvent(msg.threadId, event);
        } catch { /* client disconnected */ }

        // 2. Fan out to other channels that have it enabled
        for (const [, otherChannel] of this.channels) {
          if (otherChannel === channel) continue; // skip originator
          if (!this.fanOut[otherChannel.type]) continue; // fan-out disabled for this type
          if (!otherChannel.broadcastEvent) continue; // channel doesn't support fan-out
          try {
            await otherChannel.broadcastEvent(event, channel.id, msg.threadId);
          } catch { /* fan-out target unavailable */ }
        }
      });

      // GAP F: Start telemetry span for this turn
      const turnSpanId = this.spanTracker?.startSpan('llm-turn', {
        model: activeModel,
        turn: turnIndex,
        agent: this.config.agentName ?? this.config.agentId ?? 'unknown',
      });

      let result: any;
      try {
        result = await this.executeTurnWithFallback(
          executeTurn, activeModel, activeProvider, useFallbackChain,
          toolContext, msg, channel,
        );
        // Update active model/provider if fallback changed them
        if (useFallbackChain && this.pinnedFallbackIndex < this.modelFallbacks.length) {
          const pinned = this.modelFallbacks[this.pinnedFallbackIndex]!;
          const pinnedModel = normalizeModelName(pinned.model);
          if (pinnedModel !== activeModel) {
            activeModel = pinnedModel;
            activeProvider = this.providerReg.resolve(pinnedModel);
          }
        }

        // GAP F: End turn span
        if (turnSpanId) {
          this.spanTracker?.endSpan(turnSpanId, {
            toolCalls: result.toolCalls.length,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          });
        }
      } catch (err) {
        if (turnSpanId) {
          this.spanTracker?.endSpan(turnSpanId, { error: (err as Error).message }, 'error');
        }
        throw err;
      } finally {
        unsub();
      }

      // GAP C: Audit-log each tool call from this turn
      const agentName = this.config.agentName ?? this.config.agentId ?? 'unknown';
      if (this.auditLogger && result.toolCalls) {
        for (let ti = 0; ti < result.toolCalls.length; ti++) {
          const tc = result.toolCalls[ti];
          const tr = result.toolResults[ti];
          const auditId = this.auditLogger.logBefore(agentName, tc.name, tc.input);
          if (tr?.isError) {
            this.auditLogger.logError(auditId, agentName, tc.name, tr.content ?? 'unknown error', 0);
          } else {
            this.auditLogger.logAfter(auditId, agentName, tc.name, tr?.content ?? '', 0);
          }
        }
      }

      // Persist assistant message
      result.assistantMessage.id = assistantMessageId;
      result.assistantMessage.executionId = msg.threadId;
      this.messages.push(result.assistantMessage);
      this.store.appendMessage(this.sessionId, result.assistantMessage);

      if (result.toolResults.length > 0) {
        const trMsg: Message = {
          role: 'user',
          content: result.toolResults.map((tr: any) => ({
            type: 'tool_result' as const,
            toolUseId: tr.toolUseId,
            content: tr.content,
            isError: tr.isError,
            image: tr.image,
          })),
          timestamp: Date.now(),
        };
        this.messages.push(trMsg);
        microcompactLatest(this.messages);
        this.store.appendMessage(this.sessionId, trMsg);
      }

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalToolCalls += result.toolCalls.length;
      this.store.updateTokens(this.sessionId, result.inputTokens, result.outputTokens);

      await channel.sendEvent(msg.threadId, {
        type: 'turn_complete',
        turnIndex,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        durationMs: Date.now() - turnStart,
        timestamp: Date.now(),
      });

      turnIndex++;

      // Continuation logic — provider-specific behavior
      if (result.toolCalls.length === 0) {
        // Claude Code uses truncation recovery nudges: when the model hits
        // max_tokens with text-only output, inject a "continue" prompt.
        // Codex/OpenAI does NOT do this — when text-only + max_tokens, the
        // turn simply ends (needs_follow_up=false in Codex source). Applying
        // nudges to Codex causes degenerate infinite loops where the model
        // repeats garbage until token exhaustion.
        const isClaudeModel = activeModel.startsWith('claude-');
        if (isClaudeModel && result.stopReason === 'max_tokens' && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY) {
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
        break; // Text-only — done (non-Claude), or max nudges exhausted (Claude)
      }

      truncationRecoveryCount = 0;

      // Loop detection — check if the agent is stuck calling the same tool(s)
      let worstLoopStatus: 'ok' | 'warning' | 'break' = 'ok';
      for (const tc of result.toolCalls) {
        const status = loopDetector.record(tc.name, tc.input);
        if (status === 'break') { worstLoopStatus = 'break'; break; }
        if (status === 'warning') worstLoopStatus = 'warning';
      }
      if (worstLoopStatus === 'break') {
        const breakMsg: Message = {
          role: 'user',
          content: 'You are stuck in a loop. Stopping execution. Please try a completely different approach.',
          timestamp: Date.now(),
        };
        this.messages.push(breakMsg);
        this.store.appendMessage(this.sessionId, breakMsg);
        break;
      }
      if (worstLoopStatus === 'warning') {
        const warnMsg: Message = {
          role: 'user',
          content: 'You appear to be calling the same tool repeatedly with the same arguments. This may indicate you are stuck in a loop. Try a different approach.',
          timestamp: Date.now(),
        };
        this.messages.push(warnMsg);
        this.store.appendMessage(this.sessionId, warnMsg);
      }

      // Compact if needed (with snapshot recovery — GAP E)
      if (needsCompaction(this.messages, this.maxContextTokens)) {
        // Pre-compaction memory flush — extract key facts from conversation
        // before context window compaction destroys them (inspired by OpenClaw's memsearch).
        // This runs BEFORE hooks/compaction so the agent doesn't lose important context.
        try {
          await this.flushPreCompactionMemory();
        } catch (err) {
          logger.warn({ err }, 'Pre-compaction memory flush failed (non-fatal)');
        }

        // PreCompact lifecycle hook
        if (this.hookEngine?.hasHooks('PreCompact')) {
          const hookEnv: Record<string, string> = {
            SESSION_ID: this.sessionId ?? '',
            MESSAGE_COUNT: String(this.messages.length),
            CWD: this.cwd,
          };
          await this.hookEngine.runHooks('PreCompact', hookEnv);
        }

        // GAP E: Snapshot before compaction for recovery
        const preCompactSnapshot = this.messages.map(m => ({ ...m }));
        const preCompactCount = this.messages.length;
        let compactionRecovered = false;

        const { messages: compacted, compacted: didCompact } =
          await compactMessages(this.messages, activeProvider, activeModel, this.maxContextTokens);
        if (didCompact) {
          // GAP E: Validate compacted messages before applying
          const isValid = this.validateCompactedMessages(compacted);
          if (isValid) {
            this.messages.length = 0;
            this.messages.push(...compacted);
            this.store.replaceMessages(this.sessionId, compacted);
          } else {
            // Recovery: restore from pre-compaction snapshot
            logger.warn({
              preCount: preCompactCount,
              postCount: compacted.length,
            }, 'Compaction produced invalid state — restoring from snapshot');
            this.messages.length = 0;
            this.messages.push(...preCompactSnapshot);
            compactionRecovered = true;
          }
        }

        // PostCompact lifecycle hook
        if (this.hookEngine?.hasHooks('PostCompact')) {
          const hookEnv: Record<string, string> = {
            SESSION_ID: this.sessionId ?? '',
            MESSAGE_COUNT: String(this.messages.length),
            DID_COMPACT: String(didCompact),
            RECOVERED: String(compactionRecovered),
            CWD: this.cwd,
          };
          await this.hookEngine.runHooks('PostCompact', hookEnv);
        }
      }
    }

    // Emit completion
    await channel.sendEvent(msg.threadId, {
      type: 'complete',
      totalTurns: turnIndex,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalDurationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });

    // Track usage
    if (this.usageTracker) {
      try {
        this.usageTracker.recordMessage(msg.userId, msg.channelType, totalInputTokens, totalOutputTokens, totalToolCalls);
      } catch (err) {
        logger.warn({ err, userId: msg.userId }, 'Failed to record usage stats');
      }
    }
  }
}

// ── Helpers ──

/**
 * Format a natural language prefix for the user message.
 * e.g. "[Telegram · Hritik]" or "[Discord · Sara · #general]"
 */
function formatChannelPrefix(msg: InboundMessage): string {
  // HTTP channel from localhost — no prefix needed (direct interaction)
  if (msg.channelType === 'http' && !msg.userName) return '';

  const parts: string[] = [];

  // Channel type (skip for HTTP — it's the default)
  if (msg.channelType !== 'http') {
    const channelLabel = CHANNEL_LABELS[msg.channelType] ?? msg.channelType;
    parts.push(channelLabel);
  }

  // User name
  if (msg.userName) {
    parts.push(msg.userName);
  } else if (msg.userId && msg.channelType !== 'http') {
    parts.push(msg.userId);
  }

  // Platform-specific context (channel name, thread, etc.)
  if (msg.metadata?.channelName) {
    parts.push(`#${msg.metadata.channelName}`);
  }

  if (parts.length === 0) return '';
  return `[${parts.join(' · ')}]`;
}

const CHANNEL_LABELS: Record<string, string> = {
  'http': 'Web',
  'shizuha-ws': 'Shizuha',
  'telegram': 'Telegram',
  'discord': 'Discord',
  'whatsapp': 'WhatsApp',
  'slack': 'Slack',
  'signal': 'Signal',
  'line': 'LINE',
  'imessage': 'iMessage',
  'cli': 'CLI',
};
