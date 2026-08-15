import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../src/prompt/builder.js';
import {
  ToolSearchState,
  buildAwarenessPrompt,
  buildConfiguredServerSummaries,
  buildDeferredToolDefinitions,
  createToolSearchTool,
  modelSupportsAppendOnlyToolActivation,
} from '../../src/tools/tool-search.js';
import type { ToolDefinition } from '../../src/tools/types.js';

const defs: ToolDefinition[] = [
  { name: 'bash', description: 'Run a command', inputSchema: { type: 'object' } },
  { name: 'ToolSearch', description: 'Find deferred tools', inputSchema: { type: 'object' } },
  { name: 'mcp__wiki__a_tool', description: 'A tool', inputSchema: { type: 'object' } },
  { name: 'mcp__wiki__z_tool', description: 'Z tool', inputSchema: { type: 'object' } },
];

describe('ToolSearch provider-prefix contract', () => {
  it('keeps the declared tool head fixed for DeepSeek V4 Flash', () => {
    const state = new ToolSearchState();
    state.markDiscovered(['mcp__wiki__z_tool']);

    const before = buildDeferredToolDefinitions(defs, state, true);
    state.markDiscovered(['mcp__wiki__a_tool']);
    const after = buildDeferredToolDefinitions(defs, state, true);

    expect(after).toEqual(before);
    expect(after.map((tool) => tool.name)).toEqual(['bash', 'ToolSearch']);
    expect(modelSupportsAppendOnlyToolActivation('cortex/DeepSeek-V4-Flash')).toBe(true);
    expect(modelSupportsAppendOnlyToolActivation('DeepSeek-V4-Flash')).toBe(true);
    expect(modelSupportsAppendOnlyToolActivation('cortex/auto')).toBe(false);
    expect(modelSupportsAppendOnlyToolActivation('GLM-4.7')).toBe(false);
  });

  it('appends hosted-provider compatibility schemas in first-discovery order', () => {
    const state = new ToolSearchState();
    state.markDiscovered(['mcp__wiki__z_tool']);
    const before = buildDeferredToolDefinitions(defs, state, false);
    state.markDiscovered(['mcp__wiki__a_tool']);
    const after = buildDeferredToolDefinitions(defs, state, false);

    expect(before.map((tool) => tool.name)).toEqual(['bash', 'ToolSearch', 'mcp__wiki__z_tool']);
    expect(after.map((tool) => tool.name)).toEqual([
      'bash',
      'ToolSearch',
      'mcp__wiki__z_tool',
      'mcp__wiki__a_tool',
    ]);
  });

  it('derives stable source awareness from config rather than live counts', () => {
    const servers = buildConfiguredServerSummaries([
      { name: 'shizuha-wiki' },
      { name: 'shizuha-pulse' },
      { name: 'shizuha-wiki' },
    ]);
    const state = new ToolSearchState();
    state.setCatalog([], servers);

    expect(servers.map((server) => server.name)).toEqual(['shizuha-pulse', 'shizuha-wiki']);
    expect(buildAwarenessPrompt('servers', state)).not.toMatch(/\d+ tools/);
    const tool = createToolSearchTool(state, 3);
    expect(tool.description).toContain('shizuha-pulse: task & project management');
    expect(tool.description).toContain('shizuha-wiki: documentation & knowledge base');
  });

  it('keeps discovered MCP tools out of the textual system-prompt tool list', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/tmp',
      model: 'gpt-5.5',
      tools: defs,
      deferredMcpTools: true,
    });

    expect(prompt).toContain('**ToolSearch**');
    expect(prompt).not.toContain('mcp__wiki__a_tool');
    expect(prompt).not.toContain('mcp__wiki__z_tool');
  });
});
