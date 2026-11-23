import { describe, expect, it } from 'vitest';
import {
  collapsePlatformMcpToMultiplexer,
  scopeGatewayPlatformMcpConfigs,
} from '../../src/gateway/agent-process.js';
import type { MCPServerConfig } from '../../src/agent/types.js';

const LAUNCHER = { command: 'node', prefixArgs: ['/opt/shizuha/dist/shizuha.js'] };

/** Platform-delivered per-service entries (the fleet-pod shape, PLAT-9226). */
function platformServers(): MCPServerConfig[] {
  return (['pulse', 'id', 'wiki', 'connect', 'drive', 'hive', 'scs'] as const).map((svc) => ({
    name: `shizuha-${svc}`,
    transport: 'streamable-http' as const,
    url: `https://platform.example/mcp/${svc}/mcp`,
    headers: {
      Authorization: 'Bearer seed-jwt',
      'X-Organization-ID': 'org-1',
    },
    platformManaged: true,
  }));
}

function manifestOf(entry: MCPServerConfig): Array<{ name: string; url: string; headers: Record<string, string> }> {
  const args = entry.args ?? [];
  const idx = args.indexOf('--services');
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(args[idx + 1]!) as Array<{ name: string; url: string; headers: Record<string, string> }>;
}

describe('PLAT-9226 gateway multiplexer collapse', () => {
  it('flag OFF → config passes through byte-identical (same reference, zero collapse)', () => {
    const configs = platformServers();
    const result = collapsePlatformMcpToMultiplexer(configs, { useMultiplexer: false, launcher: LAUNCHER });
    expect(result.configs).toBe(configs);
    expect(result.collapsed).toEqual([]);
  });

  it('flag ON + platform per-service entries → exactly one shizuha-mcp stdio entry', () => {
    const result = collapsePlatformMcpToMultiplexer(platformServers(), {
      useMultiplexer: true,
      launcher: LAUNCHER,
      bearerFile: '/run/shizuha/mcp-upstream-token',
    });
    expect(result.collapsed).toEqual(['shizuha-pulse', 'shizuha-id', 'shizuha-wiki', 'shizuha-connect', 'shizuha-drive', 'shizuha-hive', 'shizuha-scs']);

    const aggregate = result.configs.filter((s) => s.name.startsWith('shizuha-'));
    expect(aggregate).toHaveLength(1);
    const mcp = aggregate[0]!;
    expect(mcp.name).toBe('shizuha-mcp');
    expect(mcp.transport).toBe('stdio');
    expect(mcp.command).toBe('node');
    expect(mcp.args?.slice(0, LAUNCHER.prefixArgs.length)).toEqual(LAUNCHER.prefixArgs);
    expect(mcp.args).toContain('mcp-multiplexer');
    expect(mcp.platformManaged).toBe(true);

    // Emission shape parity with getPlatformMcpConfigs: upstream service list
    // in --services, bearer NOT baked into the manifest (fresh-read contract).
    const services = manifestOf(mcp);
    expect(services.map((s) => s.name)).toEqual(['pulse', 'id', 'wiki', 'connect', 'drive', 'hive', 'scs']);
    expect(services[0]?.url).toBe('https://platform.example/mcp/pulse/mcp');
    for (const svc of services) {
      expect(svc.headers).toEqual({ 'X-Organization-ID': 'org-1' });
      expect(JSON.stringify(svc)).not.toContain('Bearer');
    }

    // Spawn-time env mirrors the per-service proxy entries: seed bearer +
    // fresh-read token file + org routing scope.
    expect(mcp.env).toEqual({
      MCP_UPSTREAM_BEARER: 'seed-jwt',
      MCP_UPSTREAM_BEARER_FILE: '/run/shizuha/mcp-upstream-token',
      MCP_UPSTREAM_ORG: 'org-1',
    });
  });

  it('bearerFile omitted → env carries only the seed bearer and org', () => {
    const result = collapsePlatformMcpToMultiplexer(platformServers(), { useMultiplexer: true, launcher: LAUNCHER });
    const mcp = result.configs.find((s) => s.name === 'shizuha-mcp')!;
    expect(mcp.env).toEqual({
      MCP_UPSTREAM_BEARER: 'seed-jwt',
      MCP_UPSTREAM_ORG: 'org-1',
    });
  });

  it('never double-emits when a shizuha-mcp aggregate already exists (PLAT-3195 path)', () => {
    const existing: MCPServerConfig[] = [
      ...platformServers(),
      {
        name: 'shizuha-mcp',
        transport: 'stdio',
        command: 'node',
        args: ['/opt/shizuha/dist/shizuha.js', 'mcp-multiplexer', '--services', '[]'],
        platformManaged: true,
      },
    ];
    const result = collapsePlatformMcpToMultiplexer(existing, { useMultiplexer: true, launcher: LAUNCHER });
    expect(result.configs).toBe(existing);
    expect(result.collapsed).toEqual([]);
  });

  it('non-proxy-form stdio shizuha-* entries are not collapsible (no recognized upstream shape)', () => {
    const configs: MCPServerConfig[] = [
      { name: 'shizuha-drive', transport: 'stdio', command: 'node', args: ['mcp-proxy'], platformManaged: true },
    ];
    const result = collapsePlatformMcpToMultiplexer(configs, { useMultiplexer: true, launcher: LAUNCHER });
    expect(result.configs).toBe(configs);
    expect(result.collapsed).toEqual([]);
  });

  it('PLAT-4013: stdio-PROXY form entries (fleet delivery shape) collapse into the single multiplexer', () => {
    // The shape the fleet path actually materializes (PLAT-504 default-on
    // stdio proxy): command = launcher, args = mcp-proxy --name <svc>
    // --upstream-url <url>. Observed live on agent-shizuha-115 as 7 children.
    const configs: MCPServerConfig[] = (['pulse', 'id', 'wiki', 'connect', 'drive', 'hive', 'scs'] as const).map((svc) => ({
      name: `shizuha-${svc}`,
      transport: 'stdio' as const,
      command: LAUNCHER.command,
      args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', svc, '--upstream-url', `https://platform.example/mcp/${svc}/mcp`],
      env: { MCP_UPSTREAM_BEARER: 'seed-jwt', MCP_UPSTREAM_BEARER_FILE: '/run/shizuha/mcp-upstream-token' },
      platformManaged: true,
    }));
    const result = collapsePlatformMcpToMultiplexer(configs, {
      useMultiplexer: true,
      launcher: LAUNCHER,
      bearerFile: '/run/shizuha/mcp-upstream-token',
    });
    expect(result.collapsed).toHaveLength(7);
    const aggregate = result.configs.filter((s) => s.name.startsWith('shizuha-'));
    expect(aggregate).toHaveLength(1);
    const mcp = aggregate[0]!;
    expect(mcp.name).toBe('shizuha-mcp');
    expect(mcp.transport).toBe('stdio');
    expect(mcp.env?.['MCP_UPSTREAM_BEARER']).toBe('seed-jwt'); // seed preserved, fresh-per-dial rule unchanged
    const services = manifestOf(mcp);
    expect(services.map((s) => s.name)).toEqual(['pulse', 'id', 'wiki', 'connect', 'drive', 'hive', 'scs']);
    expect(services.map((s) => s.url)).toEqual((['pulse', 'id', 'wiki', 'connect', 'drive', 'hive', 'scs'] as const).map((svc) => `https://platform.example/mcp/${svc}/mcp`));
  });

  it('PLAT-4013: launcher-command stdio entries with a WRONG arg shape pass through untouched', () => {
    const configs: MCPServerConfig[] = [
      { name: 'shizuha-pulse', transport: 'stdio', command: LAUNCHER.command, args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', 'pulse'], platformManaged: true },
    ];
    const result = collapsePlatformMcpToMultiplexer(configs, { useMultiplexer: true, launcher: LAUNCHER });
    expect(result.configs).toBe(configs);
    expect(result.collapsed).toEqual([]);
  });

  it('PLAT-4013: a stdio entry whose name disagrees with its --name service is not trusted', () => {
    const configs: MCPServerConfig[] = [
      { name: 'shizuha-pulse', transport: 'stdio', command: LAUNCHER.command, args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', 'wiki', '--upstream-url', 'https://platform.example/mcp/wiki/mcp'], platformManaged: true },
    ];
    const result = collapsePlatformMcpToMultiplexer(configs, { useMultiplexer: true, launcher: LAUNCHER });
    expect(result.configs).toBe(configs);
    expect(result.collapsed).toEqual([]);
  });

  it('san round-2: divergent per-entry org scope fails the collapse closed (pass-through, per-service identity preserved)', () => {
    const configs: MCPServerConfig[] = [
      { name: 'shizuha-pulse', transport: 'stdio', command: LAUNCHER.command, args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', 'pulse', '--upstream-url', 'https://platform.example/mcp/pulse/mcp'], env: { MCP_UPSTREAM_ORG: 'org-1' }, platformManaged: true },
      { name: 'shizuha-wiki', transport: 'stdio', command: LAUNCHER.command, args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', 'wiki', '--upstream-url', 'https://platform.example/mcp/wiki/mcp'], env: { MCP_UPSTREAM_ORG: 'org-2' }, platformManaged: true },
    ];
    const result = collapsePlatformMcpToMultiplexer(configs, { useMultiplexer: true, launcher: LAUNCHER });
    expect(result.configs).toBe(configs);
    expect(result.collapsed).toEqual([]);
  });

  it('san round-2: divergent per-entry bearer seeds fail the collapse closed', () => {
    const configs: MCPServerConfig[] = [
      { name: 'shizuha-pulse', transport: 'stdio', command: LAUNCHER.command, args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', 'pulse', '--upstream-url', 'https://platform.example/mcp/pulse/mcp'], env: { MCP_UPSTREAM_BEARER: 'jwt-a' }, platformManaged: true },
      { name: 'shizuha-wiki', transport: 'stdio', command: LAUNCHER.command, args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', 'wiki', '--upstream-url', 'https://platform.example/mcp/wiki/mcp'], env: { MCP_UPSTREAM_BEARER: 'jwt-b' }, platformManaged: true },
    ];
    const result = collapsePlatformMcpToMultiplexer(configs, { useMultiplexer: true, launcher: LAUNCHER });
    expect(result.configs).toBe(configs);
    expect(result.collapsed).toEqual([]);
  });

  it('san round-2: homogeneous entries collapse and carry the single org/bearer scope', () => {
    const configs: MCPServerConfig[] = [
      { name: 'shizuha-pulse', transport: 'stdio', command: LAUNCHER.command, args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', 'pulse', '--upstream-url', 'https://platform.example/mcp/pulse/mcp'], env: { MCP_UPSTREAM_BEARER: 'jwt-a', MCP_UPSTREAM_ORG: 'org-1' }, platformManaged: true },
      { name: 'shizuha-wiki', transport: 'stdio', command: LAUNCHER.command, args: [...LAUNCHER.prefixArgs, 'mcp-proxy', '--name', 'wiki', '--upstream-url', 'https://platform.example/mcp/wiki/mcp'], env: { MCP_UPSTREAM_BEARER: 'jwt-a', MCP_UPSTREAM_ORG: 'org-1' }, platformManaged: true },
    ];
    const result = collapsePlatformMcpToMultiplexer(configs, { useMultiplexer: true, launcher: LAUNCHER });
    expect(result.collapsed).toEqual(['shizuha-pulse', 'shizuha-wiki']);
    const mcp = result.configs.find((s) => s.name === 'shizuha-mcp')!;
    expect(mcp.env?.['MCP_UPSTREAM_ORG']).toBe('org-1');
    expect(mcp.env?.['MCP_UPSTREAM_BEARER']).toBe('jwt-a');
    expect(manifestOf(mcp).map((s) => s.name)).toEqual(['pulse', 'wiki']);
  });

  it('non-platform servers are preserved alongside the collapsed aggregate', () => {
    const configs: MCPServerConfig[] = [
      ...platformServers(),
      { name: 'custom-tool', transport: 'stdio', command: 'uvx', args: ['some-tool'] },
    ];
    const result = collapsePlatformMcpToMultiplexer(configs, { useMultiplexer: true, launcher: LAUNCHER });
    expect(result.configs.some((s) => s.name === 'custom-tool')).toBe(true);
    expect(result.configs.filter((s) => s.name.startsWith('shizuha-'))).toHaveLength(1);
  });

  it('collapsed aggregate flows through the SCLI-44 scoper, which scopes its manifest', () => {
    const collapsed = collapsePlatformMcpToMultiplexer(platformServers(), { useMultiplexer: true, launcher: LAUNCHER });
    const scoped = scopeGatewayPlatformMcpConfigs(collapsed.configs, new Set(['pulse', 'wiki', 'connect']));

    expect(scoped.configs).toHaveLength(1);
    expect(scoped.configs[0]?.name).toBe('shizuha-mcp');
    expect(scoped.configs[0]?.transport).toBe('stdio');
    expect(manifestOf(scoped.configs[0]!).map((s) => s.name)).toEqual(['pulse', 'wiki', 'connect']);
    expect(scoped.dropped).toEqual(['shizuha-id', 'shizuha-drive', 'shizuha-hive', 'shizuha-scs']);
  });
});
