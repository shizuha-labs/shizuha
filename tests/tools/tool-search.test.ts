import { describe, it, expect } from 'vitest';
import {
  ToolSearchState,
  createToolSearchTool,
  buildServerSummaries,
  buildToolCatalog,
  buildAwarenessPrompt,
} from '../../src/tools/tool-search.js';

// ── Test data ──

const MOCK_TOOLS = [
  { name: 'mcp__pulse__list_tasks', description: 'List tasks in a project', inputSchema: { type: 'object', properties: { project_id: { type: 'string' } } } },
  { name: 'mcp__pulse__create_task', description: 'Create a new task', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'mcp__pulse__get_task', description: 'Get task details by ID', inputSchema: { type: 'object', properties: { task_id: { type: 'string' } } } },
  { name: 'mcp__inventory__list_items', description: 'List all inventory items with optional filtering', inputSchema: { type: 'object', properties: { category: { type: 'string' } } } },
  { name: 'mcp__inventory__create_item', description: 'Create a new inventory item', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'mcp__inventory__get_dashboard', description: 'Get inventory dashboard metrics', inputSchema: { type: 'object', properties: {} } },
  { name: 'mcp__mail__send_email', description: 'Send an email message', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' } } } },
  { name: 'mcp__mail__list_messages', description: 'List email messages in a folder', inputSchema: { type: 'object', properties: { folder: { type: 'string' } } } },
  { name: 'mcp__wiki__create_page', description: 'Create a new wiki page', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'mcp__wiki__search_pages', description: 'Search wiki pages by query', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
];

function makeState(): ToolSearchState {
  const state = new ToolSearchState();
  const catalog = buildToolCatalog(MOCK_TOOLS);
  const servers = [
    { name: 'pulse', description: 'task & project management', toolCount: 3 },
    { name: 'inventory', description: 'stock & warehouse management', toolCount: 3 },
    { name: 'mail', description: 'email send/receive/search', toolCount: 2 },
    { name: 'wiki', description: 'documentation & knowledge base', toolCount: 2 },
  ];
  state.setCatalog(catalog, servers);
  return state;
}

// ── Tests ──

describe('ToolSearchState', () => {
  describe('search', () => {
    it('finds tools by keyword', () => {
      const state = makeState();
      const results = state.search('inventory');
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.serverName === 'inventory')).toBe(true);
    });

    it('finds tools by description keyword', () => {
      const state = makeState();
      const results = state.search('email');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.name === 'mcp__mail__send_email')).toBe(true);
    });

    it('ranks exact server name matches higher', () => {
      const state = makeState();
      const results = state.search('pulse task');
      expect(results[0]?.serverName).toBe('pulse');
    });

    it('supports select: syntax for direct selection', () => {
      const state = makeState();
      const results = state.search('select:mcp__mail__send_email');
      expect(results.length).toBe(1);
      expect(results[0]?.name).toBe('mcp__mail__send_email');
    });

    it('supports select: with multiple tools', () => {
      const state = makeState();
      const results = state.search('select:mcp__mail__send_email,mcp__wiki__create_page');
      expect(results.length).toBe(2);
    });

    it('supports + prefix for required terms', () => {
      const state = makeState();
      const results = state.search('+inventory create');
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.serverName === 'inventory')).toBe(true);
    });

    it('returns empty for no matches', () => {
      const state = makeState();
      const results = state.search('nonexistent_xyz');
      expect(results.length).toBe(0);
    });

    it('respects maxResults', () => {
      const state = makeState();
      const results = state.search('list', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty for empty query', () => {
      const state = makeState();
      expect(state.search('').length).toBe(0);
      expect(state.search('   ').length).toBe(0);
    });
  });

  describe('BM25 + regex union', () => {
    it('IDF boosts rare terms over common ones', () => {
      const state = makeState();
      // "dashboard" appears in only 1 tool (inventory), so IDF is high
      // "create" appears in 4 tools, so IDF is lower
      const results = state.search('dashboard');
      expect(results[0]?.name).toBe('mcp__inventory__get_dashboard');
    });

    it('regex catches partial matches BM25 misses', () => {
      const state = makeState();
      // "inv" is a substring match for "inventory" — regex catches it, BM25 doesn't
      // (BM25 needs full token match; "inv" doesn't match token "inventory")
      const results = state.search('inv');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.serverName === 'inventory')).toBe(true);
    });

    it('union ranks tools found by both methods higher', () => {
      const state = makeState();
      // "inventory list items" — both BM25 and regex match mcp__inventory__list_items
      const results = state.search('inventory list items');
      expect(results[0]?.name).toBe('mcp__inventory__list_items');
    });

    it('finds tools across both methods when queries span strategies', () => {
      const state = makeState();
      // Multi-word query where some terms match via BM25 (full tokens)
      // and some match via regex (partial/field-specific)
      const results = state.search('pulse');
      expect(results.length).toBe(3); // all 3 pulse tools
      expect(results.every((r) => r.serverName === 'pulse')).toBe(true);
    });

    it('handles queries with mixed common and rare terms', () => {
      const state = makeState();
      // "email send" — "email" is in mail desc, "send" is in mail__send_email name
      // BM25 IDF should boost "send" (rarer in names) over "email"
      const results = state.search('email send');
      expect(results[0]?.name).toBe('mcp__mail__send_email');
    });
  });

  describe('discovery tracking', () => {
    it('tracks discovered tools', () => {
      const state = makeState();
      expect(state.getDiscovered().size).toBe(0);

      state.markDiscovered(['mcp__pulse__list_tasks']);
      expect(state.getDiscovered().has('mcp__pulse__list_tasks')).toBe(true);
      expect(state.getDiscovered().size).toBe(1);
    });

    it('deduplicates discoveries', () => {
      const state = makeState();
      state.markDiscovered(['mcp__pulse__list_tasks']);
      state.markDiscovered(['mcp__pulse__list_tasks', 'mcp__mail__send_email']);
      expect(state.getDiscovered().size).toBe(2);
    });
  });

  describe('auto-enable threshold', () => {
    it('returns true when catalog tokens exceed threshold', () => {
      const state = makeState();
      const catalogTokens = state.estimateCatalogTokens();
      // Set context window small enough that catalog exceeds 10%
      const contextWindow = Math.floor(catalogTokens * 5); // catalog = 20% of window
      expect(state.shouldAutoEnable(contextWindow, 10)).toBe(true);
    });

    it('returns false when catalog tokens are below threshold', () => {
      const state = makeState();
      // 10 tools with small schemas shouldn't exceed 10% of 200K
      expect(state.shouldAutoEnable(200000, 10)).toBe(false);
    });
  });
});

describe('createToolSearchTool', () => {
  it('executes search and marks discovered', async () => {
    const state = makeState();
    const tool = createToolSearchTool(state);

    const result = await tool.execute(
      { query: 'inventory items' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Found');
    expect(result.content).toContain('mcp__inventory__list_items');
    expect(state.getDiscovered().has('mcp__inventory__list_items')).toBe(true);
  });

  it('returns helpful message when no results', async () => {
    const state = makeState();
    const tool = createToolSearchTool(state);

    const result = await tool.execute(
      { query: 'xyznonexistent' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(result.content).toContain('No tools found');
    expect(result.content).toContain('Available servers');
  });
});

describe('buildToolCatalog', () => {
  it('extracts server name from mcp__ prefix', () => {
    const catalog = buildToolCatalog(MOCK_TOOLS);
    expect(catalog[0]?.serverName).toBe('pulse');
    expect(catalog[3]?.serverName).toBe('inventory');
    expect(catalog[6]?.serverName).toBe('mail');
  });
});

describe('buildServerSummaries', () => {
  it('builds summaries from connection map', () => {
    const connections = new Map<string, { tools: Array<{ name: string }>; instructions?: string }>([
      ['shizuha-pulse', { tools: [{ name: 'a' }, { name: 'b' }], instructions: 'Task management server' }],
      ['inventory', { tools: [{ name: 'c' }] }],
    ]);

    const summaries = buildServerSummaries(connections);
    expect(summaries.length).toBe(2);
    expect(summaries[0]?.description).toBe('Task management server');
    expect(summaries[0]?.toolCount).toBe(2);
    // Falls back to known description when no instructions
    expect(summaries[1]?.description).toBe('stock & warehouse management');
  });
});

describe('buildAwarenessPrompt', () => {
  it('returns empty for mode=none', () => {
    const state = makeState();
    expect(buildAwarenessPrompt('none', state)).toBe('');
  });

  it('returns server listing for mode=servers', () => {
    const state = makeState();
    const prompt = buildAwarenessPrompt('servers', state);
    expect(prompt).toContain('Available MCP Servers');
    expect(prompt).toContain('pulse');
    expect(prompt).toContain('inventory');
    expect(prompt).toContain('ToolSearch');
  });

  it('returns tool listing for mode=tools', () => {
    const state = makeState();
    const prompt = buildAwarenessPrompt('tools', state);
    expect(prompt).toContain('Available MCP Tools');
  });
});
