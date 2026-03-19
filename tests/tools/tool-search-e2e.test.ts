/**
 * Tool Search E2E Tests — tests the full deferred MCP tool loading pipeline.
 *
 * Uses a mock MCP server (56 tools across 5 services) to verify:
 * 1. MCPManager → ToolSearchState catalog build
 * 2. Auto-enable threshold detection
 * 3. ToolSearch tool execution + discovery tracking
 * 4. getToolDefs() filtering (only builtins + discovered tools sent to LLM)
 * 5. System prompt awareness sections
 * 6. Turn-level tool refresh after discovery
 * 7. Edge cases: empty queries, select syntax, +required syntax
 *
 * Prerequisites:
 *   - Python 3 with `mcp` package installed
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import type { MCPServerConfig } from '../../src/agent/types.js';
import { MCPManager } from '../../src/tools/mcp/manager.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerMCPTools } from '../../src/tools/mcp/bridge.js';
import { registerBuiltinTools } from '../../src/tools/builtin/index.js';
import {
  ToolSearchState,
  createToolSearchTool,
  buildServerSummaries,
  buildToolCatalog,
  buildAwarenessPrompt,
} from '../../src/tools/tool-search.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import path from 'node:path';

// ── Setup ──

const MOCK_SERVER = path.resolve(__dirname, '../fixtures/mock-mcp-server.py');
let pythonAvailable = false;
let manager: MCPManager;

beforeAll(async () => {
  // Check Python MCP SDK
  try {
    execSync('python3 -c "from mcp.server.fastmcp import FastMCP"', { timeout: 5000, stdio: 'pipe' });
    pythonAvailable = true;
  } catch {
    console.warn('⚠ Python MCP SDK not available — skipping tool search E2E tests');
    return;
  }

  // Connect to mock MCP server
  manager = new MCPManager();
  const config: MCPServerConfig = {
    name: 'mock-multi-service',
    transport: 'stdio',
    command: 'python3',
    args: [MOCK_SERVER],
  };

  await manager.connectAll([config]);
}, 30000);

afterAll(async () => {
  if (manager) await manager.disconnectAll();
}, 10000);

// ── Tests ──

describe('Tool Search E2E — mock MCP server', () => {
  it('connects and discovers 50+ tools', () => {
    if (!pythonAvailable) return;

    const tools = manager.listAllTools();
    expect(tools.length).toBeGreaterThanOrEqual(50);

    // Tools should be prefixed with mcp__<server>__
    for (const tool of tools) {
      expect(tool.name).toMatch(/^mcp__mock-multi-service__/);
    }

    // Should have tools from all 5 services
    const names = tools.map((t) => t.name);
    expect(names.some((n) => n.includes('crm_'))).toBe(true);
    expect(names.some((n) => n.includes('billing_'))).toBe(true);
    expect(names.some((n) => n.includes('support_'))).toBe(true);
    expect(names.some((n) => n.includes('analytics_'))).toBe(true);
    expect(names.some((n) => n.includes('calendar_'))).toBe(true);

    console.log(`  ✓ Mock server: ${tools.length} tools across 5 services`);
  });

  it('builds ToolSearchState catalog correctly', () => {
    if (!pythonAvailable) return;

    const allTools = manager.listAllTools();
    const catalog = buildToolCatalog(allTools);
    const serverSummaries = buildServerSummaries(manager.getAll());

    const state = new ToolSearchState();
    state.setCatalog(catalog, serverSummaries);

    expect(state.catalogSize).toBe(allTools.length);
    expect(state.getServers().length).toBe(1); // One mock server

    // Server summary should have instructions from the server
    const summary = state.getServers()[0]!;
    expect(summary.name).toBe('mock-multi-service');
    expect(summary.toolCount).toBe(allTools.length);

    console.log(`  ✓ Catalog: ${state.catalogSize} tools, ${state.getServers().length} server(s)`);
    console.log(`    Server instructions: "${summary.description}"`);
  });

  it('auto-enable threshold works correctly', () => {
    if (!pythonAvailable) return;

    const allTools = manager.listAllTools();
    const catalog = buildToolCatalog(allTools);
    const state = new ToolSearchState();
    state.setCatalog(catalog, []);

    const catalogTokens = state.estimateCatalogTokens();
    console.log(`  Catalog estimated tokens: ${catalogTokens}`);

    // Should NOT enable for large context (200K)
    expect(state.shouldAutoEnable(200000, 10)).toBe(false);

    // Should enable for small context where catalog > 10%
    const smallContext = Math.floor(catalogTokens * 5); // catalog = 20%
    expect(state.shouldAutoEnable(smallContext, 10)).toBe(true);

    // Should enable when forced with low threshold
    expect(state.shouldAutoEnable(200000, 0.1)).toBe(true);
  });
});

describe('Tool Search E2E — full pipeline simulation', () => {
  let toolRegistry: ToolRegistry;
  let toolSearchState: ToolSearchState;

  beforeAll(async () => {
    if (!pythonAvailable) return;

    // Simulate what the agent loop does:
    // 1. Create registry and register builtins
    toolRegistry = new ToolRegistry();
    registerBuiltinTools(toolRegistry);

    // 2. Register ALL MCP tools into registry (for execution)
    await registerMCPTools(manager, (h) => toolRegistry.register(h));

    // 3. Build tool search state
    const allTools = manager.listAllTools();
    const catalog = buildToolCatalog(allTools);
    const serverSummaries = buildServerSummaries(manager.getAll());
    toolSearchState = new ToolSearchState();
    toolSearchState.setCatalog(catalog, serverSummaries);

    // 4. Register ToolSearch tool
    toolRegistry.register(createToolSearchTool(toolSearchState));
  });

  it('registry has all tools (builtins + MCP + ToolSearch)', () => {
    if (!pythonAvailable) return;

    const allDefs = toolRegistry.definitions();
    const mcpTools = allDefs.filter((d) => d.name.startsWith('mcp__'));
    const builtins = allDefs.filter((d) => !d.name.startsWith('mcp__'));

    expect(mcpTools.length).toBeGreaterThanOrEqual(50);
    expect(builtins.length).toBeGreaterThan(10); // 15 builtins + ToolSearch
    expect(allDefs.some((d) => d.name === 'ToolSearch')).toBe(true);

    console.log(`  ✓ Registry: ${allDefs.length} total (${builtins.length} builtins, ${mcpTools.length} MCP)`);
  });

  it('getToolDefs() filters MCP tools when tool search is active', () => {
    if (!pythonAvailable) return;

    const allDefs = toolRegistry.definitions();
    const discovered = toolSearchState.getDiscovered();

    // Simulate getToolDefs() from loop.ts
    const filteredDefs = allDefs.filter((d) => {
      if (!d.name.startsWith('mcp__')) return true;
      return discovered.has(d.name);
    });

    // Before any discovery: only builtins + ToolSearch
    expect(filteredDefs.length).toBeLessThan(allDefs.length);
    expect(filteredDefs.every((d) => !d.name.startsWith('mcp__'))).toBe(true);

    console.log(`  ✓ Before discovery: ${filteredDefs.length} defs (${allDefs.length} total filtered to builtins only)`);
  });

  it('ToolSearch tool finds and marks tools as discovered', async () => {
    if (!pythonAvailable) return;

    const toolSearchHandler = toolRegistry.get('ToolSearch')!;
    expect(toolSearchHandler).toBeDefined();

    // Search for billing tools
    const result = await toolSearchHandler.execute(
      { query: 'billing invoice' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Found');
    expect(result.content).toContain('billing');

    // Some billing tools should now be discovered
    const discovered = toolSearchState.getDiscovered();
    expect(discovered.size).toBeGreaterThan(0);
    const discoveredBilling = [...discovered].filter((n) => n.includes('billing'));
    expect(discoveredBilling.length).toBeGreaterThan(0);

    console.log(`  ✓ After search "billing invoice": ${discovered.size} tools discovered`);
    console.log(`    Discovered: ${[...discovered].join(', ')}`);
  });

  it('discovered tools appear in filtered toolDefs after search', () => {
    if (!pythonAvailable) return;

    const allDefs = toolRegistry.definitions();
    const discovered = toolSearchState.getDiscovered();

    // Simulate getToolDefs() again
    const filteredDefs = allDefs.filter((d) => {
      if (!d.name.startsWith('mcp__')) return true;
      return discovered.has(d.name);
    });

    // Should now include discovered MCP tools
    const mcpInFiltered = filteredDefs.filter((d) => d.name.startsWith('mcp__'));
    expect(mcpInFiltered.length).toBe(discovered.size);
    expect(mcpInFiltered.length).toBeGreaterThan(0);

    // All discovered tools should be in filtered defs
    for (const name of discovered) {
      expect(filteredDefs.some((d) => d.name === name)).toBe(true);
    }

    console.log(`  ✓ After discovery: ${filteredDefs.length} defs (${mcpInFiltered.length} MCP tools now included)`);
  });

  it('discovered tools are callable through the registry', async () => {
    if (!pythonAvailable) return;

    const discovered = [...toolSearchState.getDiscovered()];
    expect(discovered.length).toBeGreaterThan(0);

    // Pick billing_list_invoices — it has only optional params (status="", limit=10)
    const toolName = discovered.find((n) => n.includes('billing_list_invoices')) ?? discovered[0]!;
    const handler = toolRegistry.get(toolName);
    expect(handler).toBeDefined();

    const result = await handler!.execute(
      {},
      { cwd: '/tmp', sessionId: 'test' },
    );

    // Mock server returns "mock" results, not errors
    expect(result.isError).toBeFalsy();
    console.log(`  ✓ Called discovered tool ${toolName}: ${result.content.slice(0, 80)}`);
  });

  it('incremental discovery accumulates across searches', async () => {
    if (!pythonAvailable) return;

    const discoveredBefore = toolSearchState.getDiscovered().size;

    // Search for calendar tools (different from billing)
    const toolSearchHandler = toolRegistry.get('ToolSearch')!;
    await toolSearchHandler.execute(
      { query: 'calendar event' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    const discoveredAfter = toolSearchState.getDiscovered().size;
    expect(discoveredAfter).toBeGreaterThan(discoveredBefore);

    // Both billing AND calendar tools should be discovered
    const discovered = [...toolSearchState.getDiscovered()];
    expect(discovered.some((n) => n.includes('billing'))).toBe(true);
    expect(discovered.some((n) => n.includes('calendar'))).toBe(true);

    console.log(`  ✓ Incremental discovery: ${discoveredBefore} → ${discoveredAfter} tools`);
  });

  it('select: syntax works for direct tool loading', async () => {
    if (!pythonAvailable) return;

    const toolSearchHandler = toolRegistry.get('ToolSearch')!;

    // Directly select a specific tool
    const result = await toolSearchHandler.execute(
      { query: 'select:mcp__mock-multi-service__support_create_ticket' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('support_create_ticket');
    expect(toolSearchState.getDiscovered().has('mcp__mock-multi-service__support_create_ticket')).toBe(true);

    console.log(`  ✓ select: syntax loaded support_create_ticket`);
  });

  it('select: with multiple tools', async () => {
    if (!pythonAvailable) return;

    const toolSearchHandler = toolRegistry.get('ToolSearch')!;
    const before = toolSearchState.getDiscovered().size;

    const result = await toolSearchHandler.execute(
      { query: 'select:mcp__mock-multi-service__analytics_get_dashboard,mcp__mock-multi-service__analytics_list_reports' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Found 2');
    expect(toolSearchState.getDiscovered().size).toBeGreaterThanOrEqual(before + 2);

    console.log(`  ✓ select: loaded 2 analytics tools`);
  });

  it('+required prefix filters correctly', async () => {
    if (!pythonAvailable) return;

    const toolSearchHandler = toolRegistry.get('ToolSearch')!;

    const result = await toolSearchHandler.execute(
      { query: '+crm list' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(result.isError).toBeFalsy();
    // All results should contain "crm" in their name
    const discovered = [...toolSearchState.getDiscovered()].filter((n) => n.includes('crm'));
    expect(discovered.length).toBeGreaterThan(0);

    console.log(`  ✓ +required: found ${discovered.length} CRM tools`);
  });

  it('no results returns helpful message with server list', async () => {
    if (!pythonAvailable) return;

    const toolSearchHandler = toolRegistry.get('ToolSearch')!;

    const result = await toolSearchHandler.execute(
      { query: 'xyznonexistent_completely_fake_tool' },
      { cwd: '/tmp', sessionId: 'test' },
    );

    expect(result.content).toContain('No tools found');
    expect(result.content).toContain('mock-multi-service');

    console.log(`  ✓ No results: shows available servers`);
  });
});

describe('Tool Search E2E — awareness prompts', () => {
  let state: ToolSearchState;

  beforeAll(() => {
    if (!pythonAvailable) return;

    const allTools = manager.listAllTools();
    const catalog = buildToolCatalog(allTools);
    const serverSummaries = buildServerSummaries(manager.getAll());
    state = new ToolSearchState();
    state.setCatalog(catalog, serverSummaries);
  });

  it('mode=none produces empty prompt', () => {
    if (!pythonAvailable) return;
    expect(buildAwarenessPrompt('none', state)).toBe('');
  });

  it('mode=servers lists server with description and tool count', () => {
    if (!pythonAvailable) return;

    const prompt = buildAwarenessPrompt('servers', state);
    expect(prompt).toContain('Available MCP Servers');
    expect(prompt).toContain('mock-multi-service');
    expect(prompt).toContain('ToolSearch');
    // Should have tool count
    expect(prompt).toMatch(/\d+ tools/);

    console.log(`  ✓ Servers awareness prompt (${prompt.length} chars):\n${prompt}`);
  });

  it('mode=tools lists all individual tool names', () => {
    if (!pythonAvailable) return;

    const prompt = buildAwarenessPrompt('tools', state);
    expect(prompt).toContain('Available MCP Tools');
    // Should list individual tool names
    expect(prompt).toContain('crm_list_contacts');
    expect(prompt).toContain('billing_create_invoice');
    expect(prompt).toContain('calendar_create_event');

    // Count lines — should have at least 50 tool lines
    const toolLines = prompt.split('\n').filter((l) => l.startsWith('- `mcp__'));
    expect(toolLines.length).toBeGreaterThanOrEqual(50);

    console.log(`  ✓ Tools awareness prompt: ${toolLines.length} tools listed (${prompt.length} chars)`);
  });
});

describe('Tool Search E2E — token savings', () => {
  it('measures token reduction from deferred loading', () => {
    if (!pythonAvailable) return;

    const allTools = manager.listAllTools();
    const catalog = buildToolCatalog(allTools);
    const serverSummaries = buildServerSummaries(manager.getAll());
    const state = new ToolSearchState();
    state.setCatalog(catalog, serverSummaries);

    // Full tool definitions: estimate from raw MCP tool data (name + desc + schema)
    const fullTokens = allTools.reduce((sum, t) => {
      return sum + Math.ceil((t.name.length + t.description.length + JSON.stringify(t.inputSchema).length) / 4);
    }, 0);

    // Deferred: server awareness prompt only (no MCP tool schemas)
    const awarenessPrompt = buildAwarenessPrompt('servers', state);
    const awarenessTokens = Math.ceil(awarenessPrompt.length / 4);

    // ToolSearch tool definition itself
    const toolSearchDefTokens = Math.ceil(('ToolSearch'.length + 200 + 200) / 4); // ~150 tokens

    const deferredTotal = awarenessTokens + toolSearchDefTokens;
    const savings = ((fullTokens - deferredTotal) / fullTokens * 100).toFixed(1);

    console.log(`  ✓ Token comparison (MCP tools only):`);
    console.log(`    Full (56 MCP tools):  ~${fullTokens} tokens`);
    console.log(`    Awareness prompt:     ~${awarenessTokens} tokens`);
    console.log(`    ToolSearch def:       ~${toolSearchDefTokens} tokens`);
    console.log(`    Total deferred:       ~${deferredTotal} tokens`);
    console.log(`    Savings:              ${savings}%`);

    // Should save at least 90% on MCP tool tokens
    expect(parseFloat(savings)).toBeGreaterThan(90);
  });
});
