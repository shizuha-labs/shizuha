import { describe, it, expect } from 'vitest';
import { configSchema, hookSchema, permissionRuleSchema, autoReplyRuleSchema, sandboxSchema } from '../../src/config/schema.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerBuiltinTools } from '../../src/tools/builtin/index.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { ToolsetManager, BUILTIN_TOOLSETS } from '../../src/tools/toolsets.js';

// ════════════════════════════════════════════════════════════════════════════
// 1. Config Schema Validation
// ════════════════════════════════════════════════════════════════════════════

describe('Config Schema Validation', () => {
  it('parses empty object with all defaults applied', () => {
    const result = configSchema.parse({});

    // agent defaults
    expect(result.agent.defaultModel).toBe('auto');
    expect(result.agent.maxTurns).toBe(0);
    expect(result.agent.temperature).toBe(0);
    expect(result.agent.maxOutputTokens).toBe(32000);
    expect(result.agent.cwd).toBe(process.cwd());
    expect(result.agent.toolset).toBeUndefined();

    // providers defaults
    expect(result.providers).toEqual({});

    // permissions defaults
    expect(result.permissions.mode).toBe('supervised');
    expect(result.permissions.rules).toEqual([]);

    // mcp defaults
    expect(result.mcp.servers).toEqual([]);
    expect(result.mcp.toolSearch.mode).toBe('auto');
    expect(result.mcp.toolSearch.awareness).toBe('servers');
    expect(result.mcp.toolSearch.autoThresholdPercent).toBe(10);
    expect(result.mcp.toolSearch.maxResults).toBe(5);

    // hooks defaults
    expect(result.hooks.hooks).toEqual([]);

    // skills defaults
    expect(result.skills.trustProjectSkills).toBe(false);

    // sandbox defaults
    expect(result.sandbox.mode).toBe('unrestricted');
    expect(result.sandbox.writablePaths).toEqual([]);
    expect(result.sandbox.networkAccess).toBe(false);
    expect(result.sandbox.allowedHosts).toEqual([]);
    expect(result.sandbox.protectedPaths).toEqual(['.git', '.shizuha', '.env', '.claude']);

    // logging defaults
    expect(result.logging.level).toBe('info');
    expect(result.logging.file).toBeUndefined();

    // autoReply defaults
    expect(result.autoReply.enabled).toBe(false);
    expect(result.autoReply.rules).toEqual([]);
  });

  it('parses config with autoReply section', () => {
    const result = configSchema.parse({
      autoReply: {
        enabled: true,
        rules: [{ pattern: 'hello', response: 'hi' }],
      },
    });

    expect(result.autoReply.enabled).toBe(true);
    expect(result.autoReply.rules).toHaveLength(1);
    expect(result.autoReply.rules[0]!.pattern).toBe('hello');
    expect(result.autoReply.rules[0]!.response).toBe('hi');
    // Defaults for optional fields
    expect(result.autoReply.rules[0]!.caseSensitive).toBe(false);
    expect(result.autoReply.rules[0]!.priority).toBe(0);
    expect(result.autoReply.rules[0]!.channels).toBeUndefined();
  });

  it('parses autoReply rules with all fields', () => {
    const result = configSchema.parse({
      autoReply: {
        enabled: true,
        rules: [
          {
            pattern: '^urgent:',
            response: 'Acknowledged. Escalating immediately.',
            channels: ['slack', 'telegram'],
            caseSensitive: true,
            priority: 10,
          },
        ],
      },
    });

    const rule = result.autoReply.rules[0]!;
    expect(rule.pattern).toBe('^urgent:');
    expect(rule.response).toBe('Acknowledged. Escalating immediately.');
    expect(rule.channels).toEqual(['slack', 'telegram']);
    expect(rule.caseSensitive).toBe(true);
    expect(rule.priority).toBe(10);
  });

  it('rejects invalid autoReply (enabled is not boolean)', () => {
    expect(() =>
      configSchema.parse({
        autoReply: { enabled: 'yes', rules: [] },
      }),
    ).toThrow();
  });

  it('rejects autoReply rules missing required fields', () => {
    expect(() =>
      configSchema.parse({
        autoReply: {
          enabled: true,
          rules: [{ response: 'hi' }], // missing pattern
        },
      }),
    ).toThrow();
  });

  it('parses config with agent.toolset', () => {
    const result = configSchema.parse({
      agent: { toolset: 'safe' },
    });
    expect(result.agent.toolset).toBe('safe');
  });

  it('parses config with sandbox.allowedHosts', () => {
    const result = configSchema.parse({
      sandbox: {
        allowedHosts: ['api.example.com', '*.internal.dev', 'localhost'],
      },
    });
    expect(result.sandbox.allowedHosts).toEqual([
      'api.example.com',
      '*.internal.dev',
      'localhost',
    ]);
  });

  it('parses config with hooks containing all lifecycle events', () => {
    const allEvents = [
      'PreToolUse',
      'PostToolUse',
      'PreCompact',
      'PostCompact',
      'SessionStart',
      'SessionStop',
      'Notification',
      'Stop',
    ] as const;

    const hooks = allEvents.map((event) => ({
      event,
      command: `echo ${event}`,
    }));

    const result = configSchema.parse({ hooks: { hooks } });
    expect(result.hooks.hooks).toHaveLength(allEvents.length);

    for (const event of allEvents) {
      expect(result.hooks.hooks.some((h) => h.event === event)).toBe(true);
    }
  });

  it('rejects hooks with invalid event name', () => {
    expect(() =>
      hookSchema.parse({ event: 'InvalidEvent', command: 'echo test' }),
    ).toThrow();
  });

  it('parses hooks with optional matcher and timeout', () => {
    const result = hookSchema.parse({
      event: 'PreToolUse',
      matcher: 'bash',
      command: 'echo "about to run bash"',
      timeout: 5000,
    });
    expect(result.matcher).toBe('bash');
    expect(result.timeout).toBe(5000);
  });

  it('rejects hook timeout below minimum (100ms)', () => {
    expect(() =>
      hookSchema.parse({
        event: 'PreToolUse',
        command: 'echo test',
        timeout: 50,
      }),
    ).toThrow();
  });

  it('rejects hook timeout above maximum (60000ms)', () => {
    expect(() =>
      hookSchema.parse({
        event: 'PreToolUse',
        command: 'echo test',
        timeout: 100000,
      }),
    ).toThrow();
  });

  it('parses config with permissions rules including wildcards', () => {
    const result = configSchema.parse({
      permissions: {
        mode: 'supervised',
        rules: [
          { tool: 'mcp__*', decision: 'allow' },
          { tool: 'bash', decision: 'deny' },
          { tool: '*', pattern: '/tmp/*', decision: 'allow' },
        ],
      },
    });

    expect(result.permissions.rules).toHaveLength(3);
    expect(result.permissions.rules[0]!.tool).toBe('mcp__*');
    expect(result.permissions.rules[0]!.decision).toBe('allow');
    expect(result.permissions.rules[1]!.tool).toBe('bash');
    expect(result.permissions.rules[1]!.decision).toBe('deny');
    expect(result.permissions.rules[2]!.pattern).toBe('/tmp/*');
  });

  it('rejects invalid permission decision', () => {
    expect(() =>
      permissionRuleSchema.parse({ tool: 'bash', decision: 'maybe' }),
    ).toThrow();
  });

  it('rejects invalid permission mode', () => {
    expect(() =>
      configSchema.parse({ permissions: { mode: 'yolo' } }),
    ).toThrow();
  });

  it('parses providers section with all providers', () => {
    const result = configSchema.parse({
      providers: {
        anthropic: { apiKey: 'sk-ant-xxx', baseUrl: 'https://custom.api.com' },
        openai: { apiKey: 'sk-xxx' },
        google: { apiKey: 'ggl-xxx' },
        openrouter: { apiKey: 'or-xxx', appName: 'myapp', siteUrl: 'https://mysite.com' },
        ollama: { baseUrl: 'http://gpu-server:11434' },
      },
    });

    expect(result.providers.anthropic?.apiKey).toBe('sk-ant-xxx');
    expect(result.providers.anthropic?.baseUrl).toBe('https://custom.api.com');
    expect(result.providers.openai?.apiKey).toBe('sk-xxx');
    expect(result.providers.google?.apiKey).toBe('ggl-xxx');
    expect(result.providers.openrouter?.appName).toBe('myapp');
    expect(result.providers.ollama?.baseUrl).toBe('http://gpu-server:11434');
  });

  it('applies ollama default baseUrl', () => {
    const result = configSchema.parse({
      providers: { ollama: {} },
    });
    expect(result.providers.ollama?.baseUrl).toBe('http://localhost:11434');
  });

  it('parses sandbox with all fields', () => {
    const result = sandboxSchema.parse({
      mode: 'workspace-write',
      writablePaths: ['/home/user/data', '/var/log'],
      networkAccess: true,
      allowedHosts: ['*.example.com'],
      protectedPaths: ['.git', '.env', 'secrets/'],
    });

    expect(result.mode).toBe('workspace-write');
    expect(result.writablePaths).toEqual(['/home/user/data', '/var/log']);
    expect(result.networkAccess).toBe(true);
    expect(result.allowedHosts).toEqual(['*.example.com']);
    expect(result.protectedPaths).toEqual(['.git', '.env', 'secrets/']);
  });

  it('accepts all valid sandbox modes', () => {
    for (const mode of ['unrestricted', 'read-only', 'workspace-write', 'external'] as const) {
      const result = sandboxSchema.parse({ mode });
      expect(result.mode).toBe(mode);
    }
  });

  it('parses MCP server configuration', () => {
    const result = configSchema.parse({
      mcp: {
        servers: [
          {
            name: 'pulse',
            transport: 'stdio',
            command: 'npx',
            args: ['--yes', '@shizuha/mcp-pulse'],
            env: { PULSE_API_KEY: 'test' },
          },
          {
            name: 'wiki',
            transport: 'sse',
            url: 'https://wiki.example.com/sse',
            headers: { Authorization: 'Bearer xxx' },
          },
          {
            name: 'drive',
            transport: 'streamable-http',
            url: 'https://drive.example.com/mcp',
            reconnection: {
              maxReconnectionDelay: 30000,
              initialReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1.5,
              maxRetries: 5,
            },
            toolTimeoutMs: 30000,
          },
        ],
        toolSearch: {
          mode: 'on',
          awareness: 'tools',
          autoThresholdPercent: 15,
          maxResults: 10,
        },
      },
    });

    expect(result.mcp.servers).toHaveLength(3);
    expect(result.mcp.servers[0]!.transport).toBe('stdio');
    expect(result.mcp.servers[1]!.transport).toBe('sse');
    expect(result.mcp.servers[2]!.transport).toBe('streamable-http');
    expect(result.mcp.servers[2]!.reconnection?.maxRetries).toBe(5);
    expect(result.mcp.toolSearch.mode).toBe('on');
    expect(result.mcp.toolSearch.maxResults).toBe(10);
  });

  it('rejects invalid MCP transport', () => {
    expect(() =>
      configSchema.parse({
        mcp: {
          servers: [{ name: 'test', transport: 'grpc' }],
        },
      }),
    ).toThrow();
  });

  it('parses agent section with all fields', () => {
    const result = configSchema.parse({
      agent: {
        defaultModel: 'claude-sonnet-4-20250514',
        maxTurns: 50,
        maxContextTokens: 200000,
        temperature: 0.7,
        maxOutputTokens: 16000,
        cwd: '/home/user/project',
        toolset: 'developer',
      },
    });

    expect(result.agent.defaultModel).toBe('claude-sonnet-4-20250514');
    expect(result.agent.maxTurns).toBe(50);
    expect(result.agent.maxContextTokens).toBe(200000);
    expect(result.agent.temperature).toBe(0.7);
    expect(result.agent.maxOutputTokens).toBe(16000);
    expect(result.agent.cwd).toBe('/home/user/project');
    expect(result.agent.toolset).toBe('developer');
  });

  it('rejects temperature out of range', () => {
    expect(() =>
      configSchema.parse({ agent: { temperature: 3.0 } }),
    ).toThrow();
    expect(() =>
      configSchema.parse({ agent: { temperature: -0.1 } }),
    ).toThrow();
  });

  it('rejects maxOutputTokens below minimum', () => {
    expect(() =>
      configSchema.parse({ agent: { maxOutputTokens: 50 } }),
    ).toThrow();
  });

  it('rejects maxContextTokens below minimum', () => {
    expect(() =>
      configSchema.parse({ agent: { maxContextTokens: 500 } }),
    ).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Tool Registry Completeness
// ════════════════════════════════════════════════════════════════════════════

describe('Tool Registry Completeness', () => {
  // All 38 builtin tools with their expected properties
  const EXPECTED_TOOLS: Record<string, { riskLevel: 'low' | 'medium' | 'high'; readOnly: boolean }> = {
    read:              { riskLevel: 'low',    readOnly: true },
    write:             { riskLevel: 'medium', readOnly: false },
    edit:              { riskLevel: 'medium', readOnly: false },
    glob:              { riskLevel: 'low',    readOnly: true },
    grep:              { riskLevel: 'low',    readOnly: true },
    bash:              { riskLevel: 'high',   readOnly: false },
    notebook_edit:     { riskLevel: 'medium', readOnly: false },
    web_fetch:         { riskLevel: 'medium', readOnly: true },
    web_search:        { riskLevel: 'low',    readOnly: true },
    ask_user:          { riskLevel: 'low',    readOnly: true },
    task:              { riskLevel: 'medium', readOnly: true },
    todo_write:        { riskLevel: 'low',    readOnly: false },
    todo_read:         { riskLevel: 'low',    readOnly: true },
    enter_plan_mode:   { riskLevel: 'low',    readOnly: true },
    exit_plan_mode:    { riskLevel: 'medium', readOnly: false },
    TaskOutput:        { riskLevel: 'low',    readOnly: true },
    TaskStop:          { riskLevel: 'medium', readOnly: false },
    schedule_job:      { riskLevel: 'medium', readOnly: false },
    list_jobs:         { riskLevel: 'low',    readOnly: true },
    remove_job:        { riskLevel: 'medium', readOnly: false },
    configure_heartbeat: { riskLevel: 'medium', readOnly: false },
    message_agent:     { riskLevel: 'medium', readOnly: true },
    list_agents:       { riskLevel: 'low',    readOnly: true },
    memory:            { riskLevel: 'low',    readOnly: false },
    text_to_speech:    { riskLevel: 'low',    readOnly: true },
    image_generate:    { riskLevel: 'low',    readOnly: true },
    session_search:    { riskLevel: 'low',    readOnly: true },
    usage_stats:       { riskLevel: 'low',    readOnly: true },
    browser:           { riskLevel: 'medium', readOnly: false },
    pdf_extract:       { riskLevel: 'low',    readOnly: true },
    update_plan:       { riskLevel: 'low',    readOnly: false },
    apply_patch:       { riskLevel: 'medium', readOnly: false },
    search_skills:     { riskLevel: 'low',    readOnly: true },
    use_skill:         { riskLevel: 'low',    readOnly: true },
    memory_index_search: { riskLevel: 'low',  readOnly: true },
    memory_index_stats:  { riskLevel: 'low',  readOnly: true },
    // GAP A: Interactive payloads
    interactive_reply: { riskLevel: 'low',    readOnly: true },
    // GAP C: Audit trail
    audit_log:         { riskLevel: 'low',    readOnly: true },
    // GAP D: Agent control
    pause_agent:       { riskLevel: 'medium', readOnly: false },
    resume_agent:      { riskLevel: 'medium', readOnly: false },
  };

  const EXPECTED_TOOL_NAMES = Object.keys(EXPECTED_TOOLS);
  const EXPECTED_TOOL_COUNT = EXPECTED_TOOL_NAMES.length; // 27

  function createPopulatedRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    return registry;
  }

  it('registers the exact expected number of builtin tools', () => {
    const registry = createPopulatedRegistry();
    expect(registry.size).toBe(EXPECTED_TOOL_COUNT);
  });

  it('contains every expected tool by name', () => {
    const registry = createPopulatedRegistry();
    const registeredNames = registry.list().map((t) => t.name).sort();

    for (const name of EXPECTED_TOOL_NAMES) {
      expect(registry.has(name), `Missing tool: ${name}`).toBe(true);
    }

    // Also verify no unexpected tools
    expect(registeredNames.sort()).toEqual(EXPECTED_TOOL_NAMES.sort());
  });

  it('every tool has required fields: name, description, parameters, execute, riskLevel', () => {
    const registry = createPopulatedRegistry();

    for (const tool of registry.list()) {
      expect(tool.name, `Tool missing name`).toBeTruthy();
      expect(typeof tool.name).toBe('string');

      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
      expect(typeof tool.description).toBe('string');

      expect(tool.parameters, `${tool.name} missing parameters`).toBeDefined();

      expect(tool.execute, `${tool.name} missing execute`).toBeDefined();
      expect(typeof tool.execute).toBe('function');

      expect(tool.riskLevel, `${tool.name} missing riskLevel`).toBeDefined();
      expect(['low', 'medium', 'high']).toContain(tool.riskLevel);

      expect(typeof tool.readOnly).toBe('boolean');
    }
  });

  it('tool names are unique (no duplicates)', () => {
    const registry = createPopulatedRegistry();
    const names = registry.list().map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  it('throws when registering a duplicate tool name', () => {
    const registry = createPopulatedRegistry();
    const existingTool = registry.get('read')!;
    expect(() => registry.register(existingTool)).toThrow(/already registered/);
  });

  it('tools can generate JSON Schema definitions', () => {
    const registry = createPopulatedRegistry();
    const definitions = registry.definitions();

    expect(definitions).toHaveLength(EXPECTED_TOOL_COUNT);

    for (const def of definitions) {
      expect(def.name, 'Definition missing name').toBeTruthy();
      expect(def.description, `${def.name} definition missing description`).toBeTruthy();
      expect(def.inputSchema, `${def.name} definition missing inputSchema`).toBeDefined();
      expect(typeof def.inputSchema).toBe('object');
    }
  });

  it('definitions are cached until registry changes', () => {
    const registry = createPopulatedRegistry();
    const defs1 = registry.definitions();
    const defs2 = registry.definitions();
    expect(defs1).toBe(defs2); // Same reference (cached)
  });

  it('each tool has the correct risk level', () => {
    const registry = createPopulatedRegistry();

    for (const [name, expected] of Object.entries(EXPECTED_TOOLS)) {
      const tool = registry.get(name);
      expect(tool, `Tool "${name}" not found`).toBeDefined();
      expect(tool!.riskLevel, `${name} riskLevel`).toBe(expected.riskLevel);
    }
  });

  it('each tool has the correct readOnly flag', () => {
    const registry = createPopulatedRegistry();

    for (const [name, expected] of Object.entries(EXPECTED_TOOLS)) {
      const tool = registry.get(name);
      expect(tool, `Tool "${name}" not found`).toBeDefined();
      expect(tool!.readOnly, `${name} readOnly`).toBe(expected.readOnly);
    }
  });

  it('upsert updates existing tool without error', () => {
    const registry = createPopulatedRegistry();
    const originalRead = registry.get('read')!;
    const updatedRead = { ...originalRead, description: 'Updated description' };

    registry.upsert(updatedRead);
    expect(registry.get('read')!.description).toBe('Updated description');
    expect(registry.size).toBe(EXPECTED_TOOL_COUNT); // Count unchanged
  });

  it('unregister removes a tool', () => {
    const registry = createPopulatedRegistry();
    expect(registry.has('bash')).toBe(true);

    const removed = registry.unregister('bash');
    expect(removed).toBe(true);
    expect(registry.has('bash')).toBe(false);
    expect(registry.size).toBe(EXPECTED_TOOL_COUNT - 1);
  });

  it('unregister returns false for non-existent tool', () => {
    const registry = createPopulatedRegistry();
    expect(registry.unregister('nonexistent_tool')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Permission Engine Integration
// ════════════════════════════════════════════════════════════════════════════

describe('Permission Engine Integration', () => {
  function createPopulatedRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    return registry;
  }

  describe('autonomous mode', () => {
    it('allows all tools regardless of risk level', () => {
      const engine = new PermissionEngine('autonomous');
      const registry = createPopulatedRegistry();

      for (const tool of registry.list()) {
        const decision = engine.check({
          toolName: tool.name,
          input: {},
          riskLevel: tool.riskLevel,
        });
        expect(decision, `${tool.name} should be allowed in autonomous`).toBe('allow');
      }
    });
  });

  describe('supervised mode', () => {
    it('allows low-risk tools, asks for medium and high', () => {
      const engine = new PermissionEngine('supervised');
      const registry = createPopulatedRegistry();

      for (const tool of registry.list()) {
        const decision = engine.check({
          toolName: tool.name,
          input: {},
          riskLevel: tool.riskLevel,
        });

        if (tool.riskLevel === 'low') {
          expect(decision, `${tool.name} (low) should be allowed in supervised`).toBe('allow');
        } else {
          expect(decision, `${tool.name} (${tool.riskLevel}) should ask in supervised`).toBe('ask');
        }
      }
    });
  });

  describe('plan mode', () => {
    it('allows low-risk tools, denies medium/high (except exit_plan_mode)', () => {
      const engine = new PermissionEngine('plan');
      const registry = createPopulatedRegistry();

      for (const tool of registry.list()) {
        const decision = engine.check({
          toolName: tool.name,
          input: {},
          riskLevel: tool.riskLevel,
        });

        if (tool.riskLevel === 'low') {
          expect(decision, `${tool.name} (low) should be allowed in plan`).toBe('allow');
        } else if (tool.name === 'exit_plan_mode') {
          expect(decision, `exit_plan_mode should ask in plan`).toBe('ask');
        } else {
          expect(decision, `${tool.name} (${tool.riskLevel}) should be denied in plan`).toBe('deny');
        }
      }
    });

    it('allows write/edit to plan file in plan mode', () => {
      const engine = new PermissionEngine('plan');
      engine.setPlanFilePath('/tmp/plan.md');

      expect(
        engine.check({
          toolName: 'write',
          input: { file_path: '/tmp/plan.md' },
          riskLevel: 'medium',
        }),
      ).toBe('allow');

      expect(
        engine.check({
          toolName: 'edit',
          input: { file_path: '/tmp/plan.md' },
          riskLevel: 'medium',
        }),
      ).toBe('allow');
    });

    it('denies write/edit to non-plan files in plan mode', () => {
      const engine = new PermissionEngine('plan');
      engine.setPlanFilePath('/tmp/plan.md');

      expect(
        engine.check({
          toolName: 'write',
          input: { file_path: '/tmp/other.md' },
          riskLevel: 'medium',
        }),
      ).toBe('deny');
    });
  });

  describe('specific tool risk levels', () => {
    const expectedRisks: Record<string, 'low' | 'medium' | 'high'> = {
      memory: 'low',
      schedule_job: 'medium',
      text_to_speech: 'low',
      image_generate: 'low',
      session_search: 'low',
      usage_stats: 'low',
      browser: 'medium',
      pdf_extract: 'low',
      bash: 'high',
      read: 'low',
      write: 'medium',
      edit: 'medium',
      glob: 'low',
      grep: 'low',
    };

    it('verifies risk levels for all key tools', () => {
      const registry = createPopulatedRegistry();

      for (const [name, expectedRisk] of Object.entries(expectedRisks)) {
        const tool = registry.get(name);
        expect(tool, `Tool "${name}" not found`).toBeDefined();
        expect(tool!.riskLevel, `${name} should be ${expectedRisk}-risk`).toBe(expectedRisk);
      }
    });
  });

  describe('rules and wildcards', () => {
    it('wildcard mcp__* rule allows all MCP tools', () => {
      const engine = new PermissionEngine('supervised', [
        { tool: 'mcp__*', decision: 'allow' },
      ]);

      expect(
        engine.check({ toolName: 'mcp__pulse__list_tasks', input: {}, riskLevel: 'medium' }),
      ).toBe('allow');
      expect(
        engine.check({ toolName: 'mcp__wiki__get_page', input: {}, riskLevel: 'medium' }),
      ).toBe('allow');
    });

    it('explicit deny rule overrides mode default', () => {
      const engine = new PermissionEngine('autonomous', [
        { tool: 'bash', decision: 'deny' },
      ]);

      expect(
        engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' }),
      ).toBe('deny');
    });

    it('rules are evaluated in order — first match wins', () => {
      const engine = new PermissionEngine('supervised', [
        { tool: 'bash', decision: 'allow' },
        { tool: '*', decision: 'deny' },
      ]);

      // bash matches first rule (allow)
      expect(
        engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' }),
      ).toBe('allow');
      // everything else matches second rule (deny)
      expect(
        engine.check({ toolName: 'write', input: {}, riskLevel: 'medium' }),
      ).toBe('deny');
    });

    it('session approval persists across checks', () => {
      const engine = new PermissionEngine('supervised');

      expect(
        engine.check({ toolName: 'browser', input: {}, riskLevel: 'medium' }),
      ).toBe('ask');

      engine.approve('browser');

      expect(
        engine.check({ toolName: 'browser', input: {}, riskLevel: 'medium' }),
      ).toBe('allow');
    });

    it('mode can be changed at runtime', () => {
      const engine = new PermissionEngine('supervised');

      expect(
        engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' }),
      ).toBe('ask');

      engine.setMode('autonomous');
      expect(engine.getMode()).toBe('autonomous');

      expect(
        engine.check({ toolName: 'bash', input: {}, riskLevel: 'high' }),
      ).toBe('allow');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Toolset Filtering Integration
// ════════════════════════════════════════════════════════════════════════════

describe('Toolset Filtering Integration', () => {
  function getAllToolNames(): string[] {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    return registry.list().map((t) => t.name);
  }

  const allToolNames = getAllToolNames();

  it('has all four builtin toolsets', () => {
    const manager = new ToolsetManager();
    expect(manager.get('full')).toBeDefined();
    expect(manager.get('safe')).toBeDefined();
    expect(manager.get('messaging')).toBeDefined();
    expect(manager.get('developer')).toBeDefined();
  });

  describe('full toolset', () => {
    it('includes all tools', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('full', allToolNames);
      expect(filtered.sort()).toEqual(allToolNames.sort());
    });
  });

  describe('safe toolset', () => {
    it('includes only read-only/safe tools', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('safe', allToolNames);

      // Explicitly defined safe tools
      const safelist = BUILTIN_TOOLSETS['safe']!.include;
      expect(filtered.sort()).toEqual(safelist.sort());
    });

    it('excludes bash, write, edit, browser', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('safe', allToolNames);

      expect(filtered).not.toContain('bash');
      expect(filtered).not.toContain('write');
      expect(filtered).not.toContain('edit');
      expect(filtered).not.toContain('browser');
    });

    it('includes read, glob, grep, web_fetch, web_search, memory, pdf_extract', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('safe', allToolNames);

      expect(filtered).toContain('read');
      expect(filtered).toContain('glob');
      expect(filtered).toContain('grep');
      expect(filtered).toContain('web_fetch');
      expect(filtered).toContain('web_search');
      expect(filtered).toContain('memory');
      expect(filtered).toContain('pdf_extract');
      expect(filtered).toContain('session_search');
      expect(filtered).toContain('usage_stats');
    });
  });

  describe('messaging toolset', () => {
    it('excludes bash, write, edit, browser (as defined in toolset)', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('messaging', allToolNames);

      expect(filtered).not.toContain('bash');
      expect(filtered).not.toContain('write');
      expect(filtered).not.toContain('edit');
      expect(filtered).not.toContain('browser');
      // Note: the messaging toolset excludes 'notebook' (exact match), but the
      // registered tool name is 'notebook_edit', so it is NOT excluded.
    });

    it('includes read, glob, grep, and other non-excluded tools', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('messaging', allToolNames);

      expect(filtered).toContain('read');
      expect(filtered).toContain('glob');
      expect(filtered).toContain('grep');
      expect(filtered).toContain('web_fetch');
      expect(filtered).toContain('memory');
      expect(filtered).toContain('session_search');
    });
  });

  describe('developer toolset', () => {
    it('includes core development tools', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('developer', allToolNames);

      expect(filtered).toContain('read');
      expect(filtered).toContain('write');
      expect(filtered).toContain('edit');
      expect(filtered).toContain('bash');
      expect(filtered).toContain('glob');
      expect(filtered).toContain('grep');
      expect(filtered).toContain('web_fetch');
      expect(filtered).toContain('web_search');
      expect(filtered).toContain('session_search');
      // Note: the developer toolset includes 'notebook' (exact match pattern),
      // but the registered tool name is 'notebook_edit' — so it won't match.
      // This is the actual behavior; the toolset pattern may need updating separately.
    });

    it('excludes tools not in its include list', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('developer', allToolNames);

      // Developer toolset only includes explicitly listed tools
      const devInclude = BUILTIN_TOOLSETS['developer']!.include;
      for (const name of filtered) {
        expect(devInclude).toContain(name);
      }
    });
  });

  describe('custom toolset', () => {
    it('supports include-only pattern', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'readonly',
        include: ['read', 'glob', 'grep'],
      });

      const filtered = manager.filterTools('readonly', allToolNames);
      expect(filtered.sort()).toEqual(['glob', 'grep', 'read']);
    });

    it('supports include with exclude patterns', () => {
      const manager = new ToolsetManager();
      manager.register({
        name: 'custom',
        include: ['*'],
        exclude: ['bash', 'browser', 'web_*'],
      });

      const filtered = manager.filterTools('custom', allToolNames);

      expect(filtered).not.toContain('bash');
      expect(filtered).not.toContain('browser');
      expect(filtered).not.toContain('web_fetch');
      expect(filtered).not.toContain('web_search');
      expect(filtered).toContain('read');
      expect(filtered).toContain('write');
      expect(filtered).toContain('edit');
    });

    it('supports wildcard include patterns', () => {
      const manager = new ToolsetManager();
      const allNamesWithMcp = [...allToolNames, 'mcp__pulse__list_tasks', 'mcp__wiki__get_page'];

      manager.register({
        name: 'mcp-only',
        include: ['mcp__*'],
      });

      const filtered = manager.filterTools('mcp-only', allNamesWithMcp);
      expect(filtered).toEqual(['mcp__pulse__list_tasks', 'mcp__wiki__get_page']);
    });

    it('overwrites existing toolset with same name', () => {
      const manager = new ToolsetManager();

      manager.register({
        name: 'custom',
        include: ['read'],
      });
      expect(manager.filterTools('custom', allToolNames)).toEqual(['read']);

      manager.register({
        name: 'custom',
        include: ['write'],
      });
      expect(manager.filterTools('custom', allToolNames)).toEqual(['write']);
    });
  });

  describe('unknown toolset', () => {
    it('returns all tools when toolset is unknown', () => {
      const manager = new ToolsetManager();
      const filtered = manager.filterTools('nonexistent', allToolNames);
      expect(filtered).toEqual(allToolNames);
    });
  });

  describe('list()', () => {
    it('lists all registered toolsets including builtins', () => {
      const manager = new ToolsetManager();
      const toolsets = manager.list();
      const names = toolsets.map((t) => t.name);

      expect(names).toContain('full');
      expect(names).toContain('safe');
      expect(names).toContain('messaging');
      expect(names).toContain('developer');
      expect(toolsets.length).toBeGreaterThanOrEqual(4);
    });

    it('includes custom toolsets after registration', () => {
      const manager = new ToolsetManager();
      manager.register({ name: 'my-toolset', include: ['read'] });

      const names = manager.list().map((t) => t.name);
      expect(names).toContain('my-toolset');
    });
  });
});
