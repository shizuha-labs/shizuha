import { describe, expect, it } from 'vitest';
import { scopeGatewayPlatformMcpConfigs } from '../../src/gateway/agent-process.js';
import type { MCPServerConfig } from '../../src/agent/types.js';

function multiplexer(services: string[]): MCPServerConfig {
  return {
    name: 'shizuha-mcp',
    transport: 'stdio',
    command: 'node',
    args: [
      '/opt/shizuha/dist/shizuha.js',
      'mcp-multiplexer',
      '--services',
      JSON.stringify(services.map((name) => ({
        name,
        url: `https://platform.example/mcp/${name}/mcp`,
        headers: { Authorization: 'Bearer secret' },
      }))),
    ],
  };
}

describe('gateway effective MCP scope', () => {
  it('keeps the PLAT-3119 multiplexer and scopes its embedded services', () => {
    const result = scopeGatewayPlatformMcpConfigs(
      [multiplexer(['pulse', 'id', 'admin', 'notes', 'wiki', 'drive', 'hive', 'connect'])],
      new Set(['admin', 'connect', 'id', 'pulse', 'wiki']),
    );

    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]?.name).toBe('shizuha-mcp');
    const args = result.configs[0]?.args ?? [];
    const services = JSON.parse(args[args.indexOf('--services') + 1]!) as Array<{ name: string }>;
    expect(services.map((service) => service.name)).toEqual([
      'pulse', 'id', 'admin', 'wiki', 'connect',
    ]);
    expect(result.dropped).toEqual([
      'shizuha-notes', 'shizuha-drive', 'shizuha-hive',
    ]);
  });

  it('still filters per-service configs and preserves custom MCP servers', () => {
    const result = scopeGatewayPlatformMcpConfigs([
      { name: 'shizuha-pulse', transport: 'stdio', command: 'pulse' },
      { name: 'shizuha-books', transport: 'stdio', command: 'books' },
      { name: 'customer-tools', transport: 'stdio', command: 'custom' },
    ], new Set(['pulse']));

    expect(result.configs.map((config) => config.name)).toEqual([
      'shizuha-pulse', 'customer-tools',
    ]);
    expect(result.dropped).toEqual(['shizuha-books']);
  });

  it('fails a malformed multiplexer closed', () => {
    const result = scopeGatewayPlatformMcpConfigs([{
      name: 'shizuha-mcp',
      transport: 'stdio',
      command: 'node',
      args: ['mcp-multiplexer', '--services', 'not-json'],
    }], new Set(['pulse']));

    expect(result.configs).toEqual([]);
    expect(result.dropped).toEqual(['shizuha-mcp(malformed-services)']);
  });
});
