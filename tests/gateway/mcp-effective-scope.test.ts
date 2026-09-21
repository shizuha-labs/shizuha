import { describe, expect, it } from 'vitest';
import { platformMcpServiceGranted, scopeGatewayPlatformMcpConfigs } from '../../src/gateway/agent-process.js';
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
  it('treats Hive service:org grants as permission for the unscoped service', () => {
    expect(platformMcpServiceGranted('pulse', ['pulse:komal-soni', 'wiki:personal-3'])).toBe(true);
    expect(platformMcpServiceGranted('pulse', ['pulse'])).toBe(true);
    expect(platformMcpServiceGranted('scs', ['pulse:komal-soni'])).toBe(false);
    expect(platformMcpServiceGranted('id', ['identity:personal-3'])).toBe(false);
  });

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

  it('keeps unscoped shizuha-pulse when Hive grants pulse:org (Sato 2026-08-18)', () => {
    const result = scopeGatewayPlatformMcpConfigs([
      { name: 'shizuha-pulse', transport: 'stdio', command: 'pulse' },
      { name: 'shizuha-books', transport: 'stdio', command: 'books' },
      { name: 'shizuha-scs', transport: 'stdio', command: 'scs' },
      { name: 'customer-tools', transport: 'stdio', command: 'custom' },
    ], new Set([
      'admin:komal-soni',
      'books:komal-soni',
      'books:personal-3',
      'connect:komal-soni',
      'pulse:komal-soni',
      'pulse:personal-3',
      'wiki:komal-soni',
    ]));

    expect(result.configs.map((config) => config.name)).toEqual([
      'shizuha-pulse', 'shizuha-books', 'customer-tools',
    ]);
    expect(result.dropped).toEqual(['shizuha-scs']);
  });

  it('does not treat a longer service name as a grant prefix', () => {
    const result = scopeGatewayPlatformMcpConfigs([
      { name: 'shizuha-id', transport: 'stdio', command: 'id' },
      { name: 'shizuha-identity', transport: 'stdio', command: 'identity' },
    ], new Set(['id:personal-3']));

    expect(result.configs.map((config) => config.name)).toEqual(['shizuha-id']);
    expect(result.dropped).toEqual(['shizuha-identity']);
  });

  it('scopes multiplexer embeds against service:org grants', () => {
    const result = scopeGatewayPlatformMcpConfigs(
      [multiplexer(['pulse', 'id', 'admin', 'notes', 'wiki', 'drive', 'hive', 'connect'])],
      new Set(['pulse:komal-soni', 'wiki:personal-3', 'connect:komal-soni']),
    );

    expect(result.configs).toHaveLength(1);
    const args = result.configs[0]?.args ?? [];
    const services = JSON.parse(args[args.indexOf('--services') + 1]!) as Array<{ name: string }>;
    expect(services.map((service) => service.name)).toEqual(['pulse', 'wiki', 'connect']);
    expect(result.dropped).toEqual([
      'shizuha-id', 'shizuha-admin', 'shizuha-notes', 'shizuha-drive', 'shizuha-hive',
    ]);
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
