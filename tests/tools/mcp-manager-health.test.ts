import { describe, expect, it, vi } from 'vitest';
import { MCPManager } from '../../src/tools/mcp/manager.js';
import type { MCPConnection } from '../../src/tools/mcp/client.js';

function mockConnection(client: Partial<MCPConnection['client']>): MCPConnection {
  return {
    client: client as MCPConnection['client'],
    config: { name: 'shizuha-pulse', transport: 'stdio', command: 'node', args: ['proxy.js'] },
    transport: {} as MCPConnection['transport'],
    tools: [{ name: 'mcp__shizuha-pulse__pulse_get_task', description: '', inputSchema: {} }],
    resources: [],
  };
}

describe('MCPManager health probe', () => {
  it('uses cheap protocol ping instead of tools/list so stdio mcp-proxy health does not churn upstream schemas', async () => {
    const ping = vi.fn().mockResolvedValue({});
    const listTools = vi.fn().mockRejectedValue(new Error('tools/list should not be used for health'));
    const conn = mockConnection({ ping, listTools });

    const ok = await (new MCPManager() as unknown as { probe: (conn: MCPConnection) => Promise<boolean> }).probe(conn);

    expect(ok).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledWith({ timeout: expect.any(Number) });
    expect(listTools).not.toHaveBeenCalled();
  });

  it('treats a ping failure as an unhealthy connection', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('ping timeout'));
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    const conn = mockConnection({ ping, listTools });

    const ok = await (new MCPManager() as unknown as { probe: (conn: MCPConnection) => Promise<boolean> }).probe(conn);

    expect(ok).toBe(false);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(listTools).not.toHaveBeenCalled();
  });
});
