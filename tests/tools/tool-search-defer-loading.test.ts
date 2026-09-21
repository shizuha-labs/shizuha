import { describe, expect, it } from 'vitest';
import { toolDefinitionsForProvider } from '../../src/agent/turn.js';
import {
  attachDeferredCatalogForEngine,
  createToolSearchTool,
  formatToolReferenceBlocks,
  modelUsesServerToolReferences,
  ToolSearchState,
} from '../../src/tools/tool-search.js';
import type { DeferredToolInfo } from '../../src/tools/tool-search.js';
import type { ToolContext, ToolDefinition } from '../../src/tools/types.js';
import {
  buildProviderPrefixSnapshot,
  compareProviderPrefixSnapshots,
} from '../../src/telemetry/provider-prefix-continuity.js';

const PLATFORM_SERVERS = [
  'pulse', 'id', 'admin', 'notes', 'wiki', 'drive', 'hive',
  'connect', 'finance', 'books', 'inventory', 'mail', 'scs',
] as const;

function mcpName(server: string, tool: string): string {
  return `mcp__shizuha-${server}__${tool}`;
}

function catalogForAllServers(): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  for (const server of PLATFORM_SERVERS) {
    for (const tool of [`${server}_list`, `${server}_get`, `${server}_search`]) {
      defs.push({
        name: mcpName(server, tool),
        description: `${server} ${tool}`,
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      });
    }
  }
  return defs;
}

const DIRECT: ToolDefinition[] = [
  { name: 'Bash', description: 'shell', inputSchema: { type: 'object' } },
  { name: 'ToolSearch', description: 'search', inputSchema: { type: 'object' } },
  {
    name: 'mcp__shizuha-pulse__pulse_get_my_alerts',
    description: 'alerts',
    inputSchema: { type: 'object' },
  },
  {
    name: 'mcp__shizuha-pulse__pulse_get_my_tasks',
    description: 'tasks',
    inputSchema: { type: 'object' },
  },
];

describe('attachDeferredCatalogForEngine', () => {
  it('marks every non-direct MCP tool deferLoading and keeps the Direct head first', () => {
    const catalog = catalogForAllServers();
    const attached = attachDeferredCatalogForEngine(DIRECT, [...DIRECT, ...catalog]);
    expect(attached.slice(0, DIRECT.length).map((tool) => tool.name)).toEqual(DIRECT.map((tool) => tool.name));
    expect(attached.slice(0, DIRECT.length).every((tool) => !tool.deferLoading)).toBe(true);
    const deferred = attached.filter((tool) => tool.deferLoading);
    expect(deferred.length).toBe(catalog.length);
    expect(deferred.every((tool) => tool.name.startsWith('mcp__'))).toBe(true);
    for (const server of PLATFORM_SERVERS) {
      expect(deferred.some((tool) => tool.name.includes(`shizuha-${server}__`))).toBe(true);
    }
  });

  it('does not rewrite the prefix hash when a late MCP server connects', () => {
    const catalog = catalogForAllServers();
    const withoutInventory = catalog.filter((tool) => !tool.name.includes('shizuha-inventory__'));
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `turn-${index}`,
    }));
    const first = attachDeferredCatalogForEngine(DIRECT, [...DIRECT, ...withoutInventory]);
    const second = attachDeferredCatalogForEngine(DIRECT, [...DIRECT, ...catalog]);
    const snap1 = buildProviderPrefixSnapshot({
      model: 'DeepSeek-V4-Flash',
      systemPrompt: 'stable',
      tools: first,
      chatMessages: messages,
    });
    const snap2 = buildProviderPrefixSnapshot({
      model: 'DeepSeek-V4-Flash',
      systemPrompt: 'stable',
      tools: second,
      chatMessages: messages,
    });
    const continuity = compareProviderPrefixSnapshots(snap1, snap2);
    expect(snap1.systemToolPrefixHash).toBe(snap2.systemToolPrefixHash);
    expect(snap1.toolNames).toEqual(
      DIRECT.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
    );
    expect(continuity.appendOnly).toBe(true);
    expect(continuity.cacheBreaking).toBe(false);
  });
});

describe('toolDefinitionsForProvider Cortex attach', () => {
  it('attaches the catalog only for Cortex/Anthropic/Codex', () => {
    const catalog = catalogForAllServers();
    const cortex = toolDefinitionsForProvider(DIRECT, { name: 'cortex', supportsNativeWebSearch: false }, [...DIRECT, ...catalog]);
    const vllm = toolDefinitionsForProvider(DIRECT, { name: 'vllm', supportsNativeWebSearch: false }, [...DIRECT, ...catalog]);
    expect(cortex.some((tool) => tool.deferLoading)).toBe(true);
    expect(vllm.every((tool) => !tool.deferLoading)).toBe(true);
    expect(vllm.map((tool) => tool.name)).toEqual(DIRECT.map((tool) => tool.name));
  });
});

describe('ToolSearch tool_reference emission', () => {
  it('emits Claude-shaped tool_reference blocks for every matched server', async () => {
    const catalog = catalogForAllServers();
    const state = new ToolSearchState();
    const info: DeferredToolInfo[] = catalog.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      serverName: tool.name.split('__')[1] ?? '',
    }));
    state.setCatalog(info, PLATFORM_SERVERS.map((server) => ({
      name: `shizuha-${server}`,
      description: server,
      toolCount: 3,
    })));
    const tool = createToolSearchTool(state, 20, { inlineSchemas: false });
    const ctx = { cwd: '/tmp', sessionId: 's1' } as unknown as ToolContext;

    for (const server of PLATFORM_SERVERS) {
      const result = await tool.execute({ query: `${server} list`, max_results: 5 }, ctx);
      expect(result.content).toContain('"type":"tool_reference"');
      expect(result.content).toContain(mcpName(server, `${server}_list`));
      expect(state.getDiscovered().has(mcpName(server, `${server}_list`))).toBe(true);
    }
  });

  it('formatToolReferenceBlocks is the Cortex-parseable wire form', () => {
    expect(formatToolReferenceBlocks(['mcp__shizuha-wiki__wiki_search_pages'])).toBe(
      '{"type":"tool_reference","tool_name":"mcp__shizuha-wiki__wiki_search_pages"}',
    );
    expect(modelUsesServerToolReferences('DeepSeek-V4-Flash')).toBe(true);
    expect(modelUsesServerToolReferences('cortex/GLM-4.7')).toBe(true);
    expect(modelUsesServerToolReferences('vllm/GLM-4.7')).toBe(false);
  });
});
