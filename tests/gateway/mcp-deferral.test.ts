import { describe, expect, it } from 'vitest';
import {
  activateExplicitlyMentionedMcpToolsForModel,
  addExplicitlyMentionedMcpTools,
  appendInlineMcpSchemasToMessage,
  extractMentionedMcpToolNames,
} from '../../src/gateway/agent-process.js';
import {
  buildProviderPrefixSnapshot,
  compareProviderPrefixSnapshots,
} from '../../src/telemetry/provider-prefix-continuity.js';

describe('gateway deferred MCP activation', () => {
  it('extracts exact MCP tool names from text and structured content', () => {
    expect(extractMentionedMcpToolNames(
      'call mcp__shizuha-pulse__pulse_get_my_tasks then mcp__shizuha-wiki__wiki_search_pages',
    )).toEqual([
      'mcp__shizuha-pulse__pulse_get_my_tasks',
      'mcp__shizuha-wiki__wiki_search_pages',
    ]);

    expect(extractMentionedMcpToolNames([
      { type: 'text', text: 'use mcp__shizuha-drive__drive_list_files' },
    ])).toEqual(['mcp__shizuha-drive__drive_list_files']);
  });

  it('activates any explicitly mentioned deferred MCP tool without server-specific exceptions', () => {
    const activeDefs = [
      { name: 'Bash' },
      { name: 'ToolSearch' },
    ];
    const allDefs = [
      ...activeDefs,
      { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
      { name: 'mcp__shizuha-wiki__wiki_search_pages' },
      { name: 'mcp__shizuha-drive__drive_list_files' },
    ];

    const { toolDefs, added } = addExplicitlyMentionedMcpTools(
      activeDefs,
      allDefs,
      [
        'mcp__shizuha-pulse__pulse_get_my_tasks',
        'mcp__shizuha-wiki__wiki_search_pages',
        'mcp__unknown__missing',
      ],
    );

    expect(added).toEqual([
      'mcp__shizuha-pulse__pulse_get_my_tasks',
      'mcp__shizuha-wiki__wiki_search_pages',
    ]);
    expect(toolDefs.map((d) => d.name)).toEqual([
      'Bash',
      'ToolSearch',
      'mcp__shizuha-pulse__pulse_get_my_tasks',
      'mcp__shizuha-wiki__wiki_search_pages',
    ]);
  });

  it('setup pre-activation with SORTED names yields a byte-stable toolDefs order across restarts (PLAT-4189)', () => {
    // The tool schema block renders at the HEAD of the served chat template —
    // any order flap across restarts rewrites the prompt prefix and busts the
    // vLLM prefix cache. Setup pre-activation sorts the mentioned set, so two
    // boots that discovered the mentions in DIFFERENT orders must produce the
    // exact same toolDefs sequence.
    const activeDefs = [{ name: 'Bash' }, { name: 'ToolSearch' }];
    const allDefs = [
      ...activeDefs,
      { name: 'mcp__shizuha-wiki__wiki_search_pages' },
      { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
      { name: 'mcp__shizuha-drive__drive_list_files' },
    ];
    const bootA = new Set([
      'mcp__shizuha-wiki__wiki_search_pages',
      'mcp__shizuha-pulse__pulse_get_my_tasks',
      'mcp__shizuha-drive__drive_list_files',
    ]);
    const bootB = new Set([
      'mcp__shizuha-drive__drive_list_files',
      'mcp__shizuha-wiki__wiki_search_pages',
      'mcp__shizuha-pulse__pulse_get_my_tasks',
    ]);

    const a = addExplicitlyMentionedMcpTools(activeDefs, allDefs, [...bootA].sort());
    const b = addExplicitlyMentionedMcpTools(activeDefs, allDefs, [...bootB].sort());
    expect(a.toolDefs.map((d) => d.name)).toEqual(b.toolDefs.map((d) => d.name));
  });

  it('keeps the DeepSeek V4 warmup tool head stable when a heartbeat explicitly names deferred tools', () => {
    const stableHead = Array.from({ length: 50 }, (_, index) => ({
      name: index === 49 ? 'ToolSearch' : `builtin_${index}`,
      description: `tool ${index}`,
      inputSchema: { type: 'object' },
    }));
    const alertTool = {
      name: 'mcp__shizuha-pulse__pulse_get_my_alerts',
      description: 'get alerts',
      inputSchema: { type: 'object' },
    };
    const taskTool = {
      name: 'mcp__shizuha-pulse__pulse_get_my_tasks',
      description: 'get tasks',
      inputSchema: { type: 'object' },
    };
    const warmMessages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message-${index}`,
    }));
    const warmup = buildProviderPrefixSnapshot({
      model: 'cortex/DeepSeek-V4-Flash',
      systemPrompt: 'stable system prompt',
      tools: stableHead,
      chatMessages: warmMessages,
    });

    const activation = activateExplicitlyMentionedMcpToolsForModel(
      stableHead,
      [...stableHead, alertTool, taskTool],
      [alertTool.name, taskTool.name],
      'cortex/DeepSeek-V4-Flash',
    );
    const heartbeatMessage = { role: 'user' as const, content: '[heartbeat]' };
    appendInlineMcpSchemasToMessage(heartbeatMessage, activation.availableAppendOnly);
    const firstReal = buildProviderPrefixSnapshot({
      model: 'cortex/DeepSeek-V4-Flash',
      systemPrompt: 'stable system prompt',
      tools: activation.toolDefs,
      chatMessages: [...warmMessages, heartbeatMessage],
    });
    const continuity = compareProviderPrefixSnapshots(warmup, firstReal);

    expect(activation.toolDefs).toBe(stableHead);
    expect(activation.added).toEqual([]);
    expect(activation.availableAppendOnly).toEqual([alertTool, taskTool]);
    expect(heartbeatMessage.content).toContain(`"name":"${alertTool.name}"`);
    expect(heartbeatMessage.content).toContain(`"inputSchema":{"type":"object"}`);
    expect(firstReal.systemToolPrefixHash).toBe(warmup.systemToolPrefixHash);
    expect(continuity.appendOnly).toBe(true);
    expect(continuity.cacheBreaking).toBe(false);
    expect(continuity.previousMessageCount).toBe(24);
    expect(continuity.currentMessageCount).toBe(25);
  });

  it('retains declared-schema activation for models without append-only parser evidence', () => {
    const stableHead = [{ name: 'ToolSearch', description: 'search', inputSchema: { type: 'object' } }];
    const taskTool = {
      name: 'mcp__shizuha-pulse__pulse_get_my_tasks',
      description: 'get tasks',
      inputSchema: { type: 'object' },
    };
    const activation = activateExplicitlyMentionedMcpToolsForModel(
      stableHead,
      [...stableHead, taskTool],
      [taskTool.name],
      'claude-sonnet-4-5',
    );

    expect(activation.toolDefs.map((tool) => tool.name)).toEqual(['ToolSearch', taskTool.name]);
    expect(activation.added).toEqual([taskTool.name]);
    expect(activation.availableAppendOnly).toEqual([]);
  });
});
