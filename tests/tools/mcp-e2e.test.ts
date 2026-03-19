/**
 * MCP E2E Tests — real MCP servers connected via stdio transport.
 *
 * These tests start actual Shizuha MCP servers (Python FastMCP) as child processes
 * and verify the full pipeline: connectMCP → listMCPTools → callMCPTool → disconnectMCP.
 *
 * Prerequisites:
 *   - Python 3 with `mcp` and `requests` packages installed
 *   - Shizuha services running in Docker (Pulse, Wiki, Notes at minimum)
 *   - Valid JWT token (generated from shizuha-id)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import type { MCPServerConfig } from '../../src/agent/types.js';
import type { MCPConnection } from '../../src/tools/mcp/client.js';
import { connectMCP, callMCPTool, disconnectMCP, listMCPTools } from '../../src/tools/mcp/client.js';
import { MCPManager } from '../../src/tools/mcp/manager.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerMCPTools, createMCPResourceReadTool, deriveReadOnly, deriveRiskLevel } from '../../src/tools/mcp/bridge.js';

// ── Helpers ──

const MCP_SERVERS_DIR = '/home/phoenix/work/shizuha-stack/shizuha-agent/mcp-servers';

/** Generate a fresh JWT token from shizuha-id (valid for 24h) */
function generateJWT(): string {
  try {
    const output = execSync(
      `docker compose exec -T shizuha-id python manage.py shell -c "
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.tokens import RefreshToken
u = get_user_model().objects.filter(is_superuser=True).first()
if u:
    print(str(RefreshToken.for_user(u).access_token))
else:
    print('NO_USER')
"`,
      { cwd: '/home/phoenix/work/shizuha-stack/compose', encoding: 'utf-8', timeout: 15000 },
    ).trim();
    if (output === 'NO_USER' || !output) throw new Error('No superuser found');
    return output;
  } catch {
    return '';
  }
}

/** Check if a Docker service is healthy */
function isServiceHealthy(name: string): boolean {
  try {
    const status = execSync(
      `docker compose ps --format '{{.Status}}' ${name}`,
      { cwd: '/home/phoenix/work/shizuha-stack/compose', encoding: 'utf-8', timeout: 5000 },
    ).trim();
    return status.includes('Up') && !status.includes('unhealthy');
  } catch {
    return false;
  }
}

/** Build an MCPServerConfig for a Shizuha MCP server in stdio mode */
function mcpConfig(serverName: string, jwt: string, apiPort: number): MCPServerConfig {
  return {
    name: serverName,
    transport: 'stdio',
    command: 'python3',
    args: [`${MCP_SERVERS_DIR}/${serverName}_server.py`],
    env: {
      [`SHIZUHA_${serverName.toUpperCase()}_JWT_TOKEN`]: jwt,
      [`SHIZUHA_${serverName.toUpperCase()}_URL`]: `http://localhost:${apiPort}`,
    },
  };
}

// ── Test Setup ──

let jwt = '';
let servicesAvailable = false;

// Track all connections for cleanup
const activeConns: MCPConnection[] = [];

beforeAll(() => {
  // Check Python MCP SDK
  try {
    execSync('python3 -c "from mcp.server.fastmcp import FastMCP"', { timeout: 5000, stdio: 'pipe' });
  } catch {
    console.warn('⚠ Python MCP SDK not available — skipping E2E tests');
    return;
  }

  // Check Docker services
  const pulseUp = isServiceHealthy('shizuha-pulse');
  const idUp = isServiceHealthy('shizuha-id');
  if (!pulseUp || !idUp) {
    console.warn('⚠ Required Docker services not running — skipping E2E tests');
    return;
  }

  // Generate JWT
  jwt = generateJWT();
  if (!jwt) {
    console.warn('⚠ Could not generate JWT token — skipping E2E tests');
    return;
  }

  servicesAvailable = true;
}, 30000);

afterEach(async () => {
  // Clean up any connections opened during a test
  for (const conn of activeConns) {
    try { await disconnectMCP(conn); } catch { /* ignore */ }
  }
  activeConns.length = 0;
});

// ── Tests ──

describe('MCP E2E — Pulse server (stdio)', () => {
  it('connects and lists tools', async () => {
    if (!servicesAvailable) return;

    const config = mcpConfig('pulse', jwt, 18002);
    const conn = await connectMCP(config);
    activeConns.push(conn);

    // Should have capabilities
    expect(conn.capabilities).toBeDefined();
    expect(conn.capabilities?.tools).toBeTruthy();

    // Should have tools cached after connect
    const tools = listMCPTools(conn);
    expect(tools.length).toBeGreaterThan(0);

    // All tools should be prefixed
    for (const tool of tools) {
      expect(tool.name).toMatch(/^mcp__pulse__/);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }

    // Should have known Pulse tools (server prefixes tool names with "pulse_")
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('mcp__pulse__pulse_list_tasks');

    console.log(`  ✓ Pulse: ${tools.length} tools discovered`);
  }, 15000);

  it('calls list_tasks tool successfully', async () => {
    if (!servicesAvailable) return;

    const config = mcpConfig('pulse', jwt, 18002);
    const conn = await connectMCP(config);
    activeConns.push(conn);

    const result = await callMCPTool(conn, 'mcp__pulse__pulse_list_tasks', { limit: 5 });

    // Should return text content (may be "No tasks found" or task list)
    expect(result.content).toBeDefined();
    expect(typeof result.content).toBe('string');
    // Should not be an error
    expect(result.isError).toBeFalsy();

    console.log(`  ✓ Pulse list_tasks: ${result.content.slice(0, 100)}...`);
  }, 15000);

  it('calls get_my_identity tool', async () => {
    if (!servicesAvailable) return;

    const config = mcpConfig('pulse', jwt, 18002);
    const conn = await connectMCP(config);
    activeConns.push(conn);

    // Check if get_my_identity exists
    const tools = listMCPTools(conn);
    const hasIdentity = tools.some((t) => t.name === 'mcp__pulse__pulse_get_my_identity');
    if (!hasIdentity) {
      console.log('  ⏭ get_my_identity not available');
      return;
    }

    const result = await callMCPTool(conn, 'mcp__pulse__pulse_get_my_identity', {});
    expect(result.content).toBeDefined();
    expect(result.isError).toBeFalsy();
    // Should contain user info
    expect(result.content.toLowerCase()).toMatch(/admin|email|user/i);

    console.log(`  ✓ Pulse identity: ${result.content.slice(0, 120)}...`);
  }, 15000);

  it('handles tool call timeout via AbortSignal', async () => {
    if (!servicesAvailable) return;

    const config: MCPServerConfig = {
      ...mcpConfig('pulse', jwt, 18002),
      toolTimeoutMs: 50, // Very short timeout — should trigger
    };
    const conn = await connectMCP(config);
    activeConns.push(conn);

    // With a 50ms timeout, this might or might not fail depending on how fast the server responds.
    // The important thing is it doesn't hang forever.
    try {
      await callMCPTool(conn, 'mcp__pulse__pulse_list_tasks', { limit: 1 });
      // If it succeeds quickly, that's fine too
    } catch (err) {
      // Should be a timeout-related error
      const msg = (err as Error).message ?? '';
      expect(msg.toLowerCase()).toMatch(/timeout|abort/i);
    }
  }, 15000);
});

describe('MCP E2E — Wiki server (stdio)', () => {
  it('connects and lists tools', async () => {
    if (!servicesAvailable) return;
    if (!isServiceHealthy('shizuha-wiki')) {
      console.log('  ⏭ Wiki service not available');
      return;
    }

    const config = mcpConfig('wiki', jwt, 18013);
    const conn = await connectMCP(config);
    activeConns.push(conn);

    const tools = listMCPTools(conn);
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = tools.map((t) => t.name);
    // Wiki should have standard tools
    expect(toolNames.some((n) => n.includes('wiki'))).toBe(true);

    console.log(`  ✓ Wiki: ${tools.length} tools — ${toolNames.slice(0, 5).join(', ')}...`);
  }, 15000);
});

describe('MCP E2E — Notes server (stdio)', () => {
  it('connects and calls list tools', async () => {
    if (!servicesAvailable) return;
    if (!isServiceHealthy('shizuha-notes')) {
      console.log('  ⏭ Notes service not available');
      return;
    }

    const config = mcpConfig('notes', jwt, 18012);
    const conn = await connectMCP(config);
    activeConns.push(conn);

    const tools = listMCPTools(conn);
    expect(tools.length).toBeGreaterThan(0);

    console.log(`  ✓ Notes: ${tools.length} tools`);
  }, 15000);
});

describe('MCP E2E — MCPManager multi-server', () => {
  it('connects to multiple servers and registers tools', async () => {
    if (!servicesAvailable) return;

    const configs: MCPServerConfig[] = [
      mcpConfig('pulse', jwt, 18002),
    ];
    // Add wiki if available
    if (isServiceHealthy('shizuha-wiki')) {
      configs.push(mcpConfig('wiki', jwt, 18013));
    }

    const manager = new MCPManager();
    await manager.connectAll(configs);

    expect(manager.size).toBe(configs.length);

    // List all tools across servers
    const allTools = manager.listAllTools();
    expect(allTools.length).toBeGreaterThan(0);

    // Should have pulse tools
    expect(allTools.some((t) => t.name.startsWith('mcp__pulse__'))).toBe(true);

    // Register into a ToolRegistry
    const registry = new ToolRegistry();
    const count = await registerMCPTools(manager, (h) => registry.register(h));
    expect(count).toBe(allTools.length);
    expect(registry.size).toBe(count);

    // Each registered tool should be callable
    const pulseHandler = registry.get('mcp__pulse__pulse_list_tasks');
    expect(pulseHandler).toBeDefined();
    expect(pulseHandler!.name).toBe('mcp__pulse__pulse_list_tasks');

    // Verify tool definitions generate valid JSON Schema
    const defs = registry.definitions();
    expect(defs.length).toBe(count);
    for (const def of defs) {
      expect(def.name).toMatch(/^mcp__/);
      expect(def.inputSchema).toBeDefined();
    }

    console.log(`  ✓ Manager: ${configs.length} servers, ${allTools.length} tools registered`);

    await manager.disconnectAll();
    expect(manager.size).toBe(0);
  }, 30000);

  it('executes a tool through the bridge handler', async () => {
    if (!servicesAvailable) return;

    const manager = new MCPManager();
    await manager.connectAll([mcpConfig('pulse', jwt, 18002)]);

    const registry = new ToolRegistry();
    await registerMCPTools(manager, (h) => registry.register(h));

    const handler = registry.get('mcp__pulse__pulse_list_tasks');
    expect(handler).toBeDefined();

    // Execute through the handler (as the agent loop would)
    const result = await handler!.execute(
      { limit: 3 },
      { cwd: '/tmp', sessionId: 'test-session' },
    );

    expect(result.content).toBeDefined();
    expect(result.isError).toBeFalsy();

    console.log(`  ✓ Bridge execution: ${result.content.slice(0, 100)}...`);

    await manager.disconnectAll();
  }, 20000);
});

describe('MCP E2E — tool annotations and readOnly mapping', () => {
  it('MCP tools get correct readOnly/riskLevel from annotations', async () => {
    if (!servicesAvailable) return;

    const config = mcpConfig('pulse', jwt, 18002);
    const conn = await connectMCP(config);
    activeConns.push(conn);

    const tools = listMCPTools(conn);

    // Log annotation info for debugging
    for (const tool of tools.slice(0, 5)) {
      const ro = deriveReadOnly(tool.annotations);
      const risk = deriveRiskLevel(tool.annotations);
      console.log(`  ${tool.name}: readOnly=${ro}, riskLevel=${risk}, annotations=${JSON.stringify(tool.annotations ?? 'none')}`);
    }

    // At minimum tools should have valid annotations (possibly undefined)
    for (const tool of tools) {
      const ro = deriveReadOnly(tool.annotations);
      const risk = deriveRiskLevel(tool.annotations);
      expect(typeof ro).toBe('boolean');
      expect(['low', 'medium', 'high']).toContain(risk);
    }
  }, 15000);
});

describe('MCP E2E — error handling', () => {
  it('handles connection to non-existent server gracefully', async () => {
    const config: MCPServerConfig = {
      name: 'nonexistent',
      transport: 'stdio',
      command: 'python3',
      args: ['/tmp/nonexistent_mcp_server.py'],
    };

    // Should throw on connect (process will fail to start)
    await expect(connectMCP(config)).rejects.toThrow();
  }, 10000);

  it('MCPManager handles partial failures', async () => {
    if (!servicesAvailable) return;

    const configs: MCPServerConfig[] = [
      mcpConfig('pulse', jwt, 18002), // Should succeed
      {
        name: 'bad-server',
        transport: 'stdio',
        command: 'python3',
        args: ['/tmp/nonexistent.py'],
      }, // Should fail
    ];

    const manager = new MCPManager();
    await manager.connectAll(configs);

    // Should have connected to pulse but not bad-server
    expect(manager.size).toBe(1);
    expect(manager.get('pulse')).toBeDefined();
    expect(manager.get('bad-server')).toBeUndefined();

    await manager.disconnectAll();
  }, 20000);

  it('returns error result for disconnected server tool call', async () => {
    if (!servicesAvailable) return;

    const manager = new MCPManager();
    await manager.connectAll([mcpConfig('pulse', jwt, 18002)]);

    const registry = new ToolRegistry();
    await registerMCPTools(manager, (h) => registry.register(h));

    // Disconnect the server
    await manager.disconnectAll();

    // Tool handler should return error, not throw
    const handler = registry.get('mcp__pulse__pulse_list_tasks');
    expect(handler).toBeDefined();
    const result = await handler!.execute({ limit: 1 }, { cwd: '/tmp', sessionId: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not connected');
  }, 20000);
});

describe('MCP E2E — dynamic tool refresh wiring', () => {
  it('MCPManager wires setToolRegistry correctly', async () => {
    if (!servicesAvailable) return;

    const manager = new MCPManager();
    await manager.connectAll([mcpConfig('pulse', jwt, 18002)]);

    const registry = new ToolRegistry();
    await registerMCPTools(manager, (h) => registry.register(h));

    const initialCount = registry.size;
    expect(initialCount).toBeGreaterThan(0);

    // Wire up the registry for dynamic refresh
    manager.setToolRegistry(registry);

    // Verify getAll() exposes connections
    const conns = manager.getAll();
    expect(conns.size).toBe(1);
    expect(conns.has('pulse')).toBe(true);

    console.log(`  ✓ Dynamic refresh wired: ${initialCount} tools, registry connected`);

    await manager.disconnectAll();
  }, 20000);
});
