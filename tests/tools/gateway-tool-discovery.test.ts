import { beforeEach, describe, expect, it } from 'vitest';
import { setDeferredTools, setOnToolResolved, toolSearchTool } from '../../src/tools/builtin/tool-search.js';
import { ToolSearchState } from '../../src/tools/tool-search.js';
import type { ToolContext, ToolDefinition } from '../../src/tools/types.js';

const context = {} as ToolContext;
const definitions: ToolDefinition[] = [
  { name: 'mcp__shizuha-pulse__pulse_get_task', description: 'Get task details by task identifier.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  { name: 'mcp__shizuha-pulse__pulse_get_my_work', description: 'Get assigned alerts and ready tasks for the current agent.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp__shizuha-connect__connect_share_to_pulse', description: 'Share a task in the social feed.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
];
let activated: string[];

function install(tools = definitions): void {
  setDeferredTools(new Map(tools.map(tool => [tool.name, tool])),
    new Map(tools.map(tool => [tool.name, { description: tool.description, inputSchema: tool.inputSchema }])));
}

describe('gateway deferred discovery caller contract', () => {
  beforeEach(() => {
    activated = [];
    install();
    setOnToolResolved(tool => activated.push(tool.name));
  });

  it('returns a callable full schema from the first keyword search', async () => {
    const result = await toolSearchTool.execute({ query: 'pulse_get_task', max_results: 1 }, context);
    expect(result.isError).not.toBe(true);
    expect(activated).toEqual([definitions[0]!.name]);
    expect(result.content).toContain(JSON.stringify(definitions[0]!.inputSchema));
    expect(result.content).not.toContain('Use "select:');
  });

  it('uses the shared ranked search for the exact observed comma-separated query', async () => {
    const query = 'pulse_get_my_work,pulse_get_alerts,pulse_get_tasks';
    const state = new ToolSearchState();
    state.setCatalog(definitions.map(tool => ({ ...tool, serverName: tool.name.split('__')[1]! })), []);
    const expected = state.search(query, 3).map(tool => tool.name);
    expect(expected.length).toBeGreaterThan(0);
    const result = await toolSearchTool.execute({ query, max_results: 3 }, context);
    expect(activated).toEqual(expected);
    for (const name of expected) expect(result.content).toContain(name);
    expect(result.content).toContain('"inputSchema"');
  });

  it('reports the observed queries/mode contract violation without pretending success', async () => {
    const result = await toolSearchTool.execute({ queries: 'pulse_get_my_work', mode: 'select' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"query"');
    expect(result.content).not.toContain('Available deferred tools');
    expect(activated).toEqual([]);
  });

  it('rejects malformed query and result count before discovery', async () => {
    for (const input of [{}, { query: '' }, { query: [] }, { query: 'pulse', max_results: 0 },
      { query: 'pulse', max_results: -1 }, { query: 'pulse', max_results: Infinity },
      { query: 'pulse', max_results: 1.5 }]) {
      const result = await toolSearchTool.execute(input, context);
      expect(result.isError).toBe(true);
    }
    expect(activated).toEqual([]);
  });

  it('refreshes the shared search index after eviction and re-arms after reconnect', async () => {
    const original = JSON.stringify(definitions);
    install([definitions[2]!]);
    await toolSearchTool.execute({ query: 'pulse_get_task', max_results: 3 }, context);
    expect(activated).not.toContain(definitions[0]!.name);
    activated = [];
    install();
    await toolSearchTool.execute({ query: 'pulse_get_task', max_results: 1 }, context);
    expect(activated).toEqual([definitions[0]!.name]);
    expect(JSON.stringify(definitions)).toBe(original);
  });

  it('keeps explicit selection usable with identical in-message schema shape', async () => {
    const result = await toolSearchTool.execute({ query: 'select:' + definitions[0]!.name }, context);
    expect(result.content).toContain(JSON.stringify({ name: definitions[0]!.name,
      description: definitions[0]!.description, inputSchema: definitions[0]!.inputSchema }));
    expect(activated).toContain(definitions[0]!.name);
  });

  it('keeps the authoritative definition schema when the presentation map is missing', async () => {
    setDeferredTools(new Map(definitions.map(tool => [tool.name, tool])), new Map());
    const result = await toolSearchTool.execute({ query: 'pulse_get_task', max_results: 1 }, context);
    expect(result.content).toContain(JSON.stringify(definitions[0]!.inputSchema));
    expect(activated).toEqual([definitions[0]!.name]);
  });

  it('distinguishes a valid empty search from malformed arguments', async () => {
    install([]);
    const result = await toolSearchTool.execute({ query: 'pulse_get_task' }, context);
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('No deferred tools found');
    expect(activated).toEqual([]);
  });
});
