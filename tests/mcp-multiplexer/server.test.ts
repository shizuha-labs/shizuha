import { describe, expect, it } from 'vitest';
import { resolveMcpMultiplexer } from '../../src/platform/mcp-services.js';

// ── Tool name routing tests ──

describe('tool name routing', () => {
  it('parses service__tool format', async () => {
    const { parseToolName, buildToolName } = await import('../../src/mcp-multiplexer/server.js');
    const parsed = parseToolName('pulse__get_task');
    expect(parsed).toEqual({ service: 'pulse', tool: 'get_task' });
  });

  it('parses service__tool with underscores in tool name', async () => {
    const { parseToolName } = await import('../../src/mcp-multiplexer/server.js');
    const parsed = parseToolName('wiki__search_pages');
    expect(parsed).toEqual({ service: 'wiki', tool: 'search_pages' });
  });

  it('returns null for tool name without separator', async () => {
    const { parseToolName } = await import('../../src/mcp-multiplexer/server.js');
    expect(parseToolName('get_task')).toBeNull();
  });

  it('returns null for tool name starting with separator', async () => {
    const { parseToolName } = await import('../../src/mcp-multiplexer/server.js');
    expect(parseToolName('__get_task')).toBeNull();
  });

  it('buildToolName creates correct prefix', async () => {
    const { buildToolName } = await import('../../src/mcp-multiplexer/server.js');
    expect(buildToolName('pulse', 'get_task')).toBe('pulse__get_task');
    expect(buildToolName('connect', 'message_user')).toBe('connect__message_user');
  });
});

// ── Resource URI routing tests ──

describe('resource URI routing', () => {
  it('builds prefixed resource URI', async () => {
    const { buildResourceUri, parseResourceUri } = await import('../../src/mcp-multiplexer/server.js');
    const prefixed = buildResourceUri('pulse', 'pulse://tasks/123');
    expect(prefixed).toBe('pulse__pulse://tasks/123');
    const parsed = parseResourceUri(prefixed);
    expect(parsed).toEqual({ service: 'pulse', uri: 'pulse://tasks/123' });
  });

  it('handles https scheme resources', async () => {
    const { buildResourceUri, parseResourceUri } = await import('../../src/mcp-multiplexer/server.js');
    const prefixed = buildResourceUri('wiki', 'https://wiki.shizuha/pages/456');
    expect(prefixed).toBe('wiki__https://wiki.shizuha/pages/456');
    const parsed = parseResourceUri(prefixed);
    expect(parsed).toEqual({ service: 'wiki', uri: 'https://wiki.shizuha/pages/456' });
  });

  it('returns null for URI without colon', async () => {
    const { parseResourceUri } = await import('../../src/mcp-multiplexer/server.js');
    expect(parseResourceUri('plain-uri')).toBeNull();
  });
});

// ── resolveMcpMultiplexer tests ──

describe('resolveMcpMultiplexer', () => {
  const saved = process.env['SHIZUHA_MCP_MULTIPLEXER'];

  afterEach(() => {
    if (saved === undefined) delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    else process.env['SHIZUHA_MCP_MULTIPLEXER'] = saved;
  });

  it('returns false when unset', () => {
    delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    expect(resolveMcpMultiplexer()).toBe(false);
  });

  it('returns true for 1', () => {
    delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    expect(resolveMcpMultiplexer('1')).toBe(true);
  });

  it('returns true for true', () => {
    delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    expect(resolveMcpMultiplexer('true')).toBe(true);
  });

  it('returns true for on', () => {
    delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    expect(resolveMcpMultiplexer('on')).toBe(true);
  });

  it('returns true for yes', () => {
    delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    expect(resolveMcpMultiplexer('yes')).toBe(true);
  });

  it('returns false for 0', () => {
    delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    expect(resolveMcpMultiplexer('0')).toBe(false);
  });

  it('returns false for off', () => {
    delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    expect(resolveMcpMultiplexer('off')).toBe(false);
  });

  it('reads from env when explicit is undefined', () => {
    process.env['SHIZUHA_MCP_MULTIPLEXER'] = 'true';
    expect(resolveMcpMultiplexer()).toBe(true);
  });

  it('explicit opt overrides env', () => {
    process.env['SHIZUHA_MCP_MULTIPLEXER'] = 'true';
    expect(resolveMcpMultiplexer('off')).toBe(false);
  });
});

// ── getPlatformMcpConfigs multiplexer mode tests ──

describe('getPlatformMcpConfigs multiplexer mode', () => {
  const savedMux = process.env['SHIZUHA_MCP_MULTIPLEXER'];
  const savedServices = process.env['SHIZUHA_MCP_SERVICES'];

  afterEach(() => {
    if (savedMux === undefined) delete process.env['SHIZUHA_MCP_MULTIPLEXER'];
    else process.env['SHIZUHA_MCP_MULTIPLEXER'] = savedMux;
    if (savedServices === undefined) delete process.env['SHIZUHA_MCP_SERVICES'];
    else process.env['SHIZUHA_MCP_SERVICES'] = savedServices;
  });

  function token(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8')
      .toString('base64url');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
  }

  it('emits a single shizuha-mcp entry when multiplexer is enabled', async () => {
    const { getPlatformMcpConfigs } = await import('../../src/platform/mcp-services.js');
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const configs = getPlatformMcpConfigs({
      bearerToken: token({}),
      mcpHost: 'localhost',
      mcpMultiplexer: 'true',
    });
    // Should have exactly one entry: shizuha-mcp
    expect(Object.keys(configs)).toEqual(['shizuha-mcp']);
    const entry = configs['shizuha-mcp'];
    expect(entry).toBeDefined();
    expect('command' in entry!).toBe(true);
    expect('args' in entry!).toBe(true);
    expect('env' in entry!).toBe(true);
    // Verify the args contain the services JSON
    const args = (entry as { args: string[] }).args;
    expect(args).toContain('mcp-multiplexer');
    const servicesIdx = args.indexOf('--services');
    expect(servicesIdx).toBeGreaterThan(-1);
    const servicesJson = JSON.parse(args[servicesIdx + 1]);
    expect(Array.isArray(servicesJson)).toBe(true);
    expect(servicesJson.length).toBeGreaterThan(0);
    // Should include pulse, wiki, etc.
    const names = servicesJson.map((s: { name: string }) => s.name);
    expect(names).toContain('pulse');
    expect(names).toContain('wiki');
    expect(names).toContain('connect');
  });

  it('multiplexer respects allow-list', async () => {
    const { getPlatformMcpConfigs } = await import('../../src/platform/mcp-services.js');
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const configs = getPlatformMcpConfigs({
      bearerToken: token({}),
      mcpHost: 'localhost',
      mcpMultiplexer: 'true',
      allowList: ['pulse', 'wiki'],
    });
    expect(Object.keys(configs)).toEqual(['shizuha-mcp']);
    const entry = configs['shizuha-mcp'];
    const args = (entry as { args: string[] }).args;
    const servicesIdx = args.indexOf('--services');
    const servicesJson = JSON.parse(args[servicesIdx + 1]);
    const names = servicesJson.map((s: { name: string }) => s.name);
    expect(names).toEqual(['pulse', 'wiki']);
  });

  it('multiplexer keeps org scope but does not freeze bearer in service args', async () => {
    const { getPlatformMcpConfigs } = await import('../../src/platform/mcp-services.js');
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const configs = getPlatformMcpConfigs({
      bearerToken: token({ organization_memberships: { '50': 'owner' } }),
      mcpHost: 'localhost',
      mcpMultiplexer: 'true',
    });
    const entry = configs['shizuha-mcp'];
    const args = (entry as { args: string[] }).args;
    const servicesIdx = args.indexOf('--services');
    const servicesJson = JSON.parse(args[servicesIdx + 1]);
    // Each upstream should have the org header
    for (const svc of servicesJson) {
      expect(svc.headers['X-Organization-ID']).toBe('50');
      expect(svc.headers['Authorization']).toBeUndefined();
    }
    expect((entry as { env: Record<string, string> }).env['MCP_UPSTREAM_BEARER']).toMatch(/\./);
  });

  it('multiplexer mode returns empty when allow-list excludes everything', async () => {
    const { getPlatformMcpConfigs } = await import('../../src/platform/mcp-services.js');
    delete process.env['SHIZUHA_MCP_SERVICES'];
    // Use a non-existent service name to exclude everything
    const configs = getPlatformMcpConfigs({
      bearerToken: token({}),
      mcpHost: 'localhost',
      mcpMultiplexer: 'true',
      allowList: ['nonexistent-service'],
    });
    expect(Object.keys(configs)).toEqual([]);
  });
});

describe('multiplexer upstream recovery boundary', () => {
  it('uses the refreshed bearer instead of a stale configured Authorization header', async () => {
    const { buildMultiplexerUpstreamHeaders } = await import('../../src/mcp-multiplexer/server.js');
    await expect(buildMultiplexerUpstreamHeaders(
      {
        Authorization: 'Bearer stale-spawn-token',
        'X-Organization-ID': '1',
      },
      { MCP_UPSTREAM_BEARER: 'fresh-runtime-token' },
    )).resolves.toEqual({
      Authorization: 'Bearer fresh-runtime-token',
      'X-Organization-ID': '1',
    });
  });

  it('bounds a reconnecting upstream without cancelling background recovery', async () => {
    const { settleWithin } = await import('../../src/mcp-multiplexer/server.js');
    const started = Date.now();
    await expect(settleWithin(
      new Promise<never>(() => {}),
      20,
      'upstream "pulse"',
    )).rejects.toThrow('upstream "pulse" did not connect within 20ms');
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// ── prunePlatformMcpKeys with multiplexer key ──

describe('prunePlatformMcpKeys with multiplexer', () => {
  const saved = process.env['SHIZUHA_MCP_SERVICES'];

  afterEach(() => {
    if (saved === undefined) delete process.env['SHIZUHA_MCP_SERVICES'];
    else process.env['SHIZUHA_MCP_SERVICES'] = saved;
  });

  it('keeps shizuha-mcp key when pruning', async () => {
    const { prunePlatformMcpKeys } = await import('../../src/platform/mcp-services.js');
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const merged = {
      'shizuha-mcp': { command: 'node', args: ['mcp-multiplexer'] },
      'shizuha-pulse': 1,
      'shizuha-wiki': 2,
      'custom-tool': 3,
    };
    const pruned = prunePlatformMcpKeys(merged, ['pulse']);
    // shizuha-mcp should be kept (multiplexer entry)
    expect(pruned['shizuha-mcp']).toBeDefined();
    // shizuha-pulse should be kept (allowed)
    expect(pruned['shizuha-pulse']).toBe(1);
    // shizuha-wiki should be dropped (not allowed)
    expect(pruned['shizuha-wiki']).toBeUndefined();
    // custom-tool should be kept (non-platform)
    expect(pruned['custom-tool']).toBe(3);
  });
});
