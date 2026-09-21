import { describe, expect, it, vi } from 'vitest';
import { resolveMcpMultiplexer } from '../../src/platform/mcp-services.js';
import { validateMcpMultiplexerConfig } from '../../src/mcp-multiplexer/server.js';

// SCLI-601: the multiplexer bearer path resolves a token via the broker UDS
// (fetchBrokerToken) and the cwd .mcp-upstream-token file. In an agent-pod
// runner both exist and leak a real token into the assertion. Mock the broker
// module so the test is hermetic — it asserts the refreshed-bearer precedence,
// not broker resolution.
vi.mock('../../src/auth/broker-token.js', () => ({
  brokerSocketPath: () => null,
  brokerPresent: () => false,
  brokerExpected: () => false,
  fetchBrokerToken: () => Promise.resolve(null),
  fetchBrokerModelToken: () => Promise.resolve(null),
  reportBrokerModelTokenStatus: () => {},
}));

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

describe('PLAT-5275 atomic dispatch scope boundary', () => {
  it('refuses before the first upstream dial when the signed scope excludes the service', async () => {
    let allowed = false;
    let bearerReads = 0;
    const { UpstreamConnection } = await import('../../src/mcp-multiplexer/server.js');
    const upstream = new UpstreamConnection(
      { name: 'mail', url: 'http://127.0.0.1:9/mcp', headers: {} },
      {},
      () => allowed,
      async () => { bearerReads += 1; return ''; },
    );

    await expect(upstream.forward('tools/call', { name: 'mail_get_folder_tree' }))
      .rejects.toMatchObject({ code: -32003, data: { code: 'scope_denied', service: 'mail' } });
    expect(bearerReads).toBe(0);
  });

  it('re-checks the signed scope at the same boundary that admits a forward', async () => {
    let allowed = true;
    let bearerReads = 0;
    const { UpstreamConnection } = await import('../../src/mcp-multiplexer/server.js');
    const upstream = new UpstreamConnection(
      { name: 'pulse', url: 'http://127.0.0.1:9/mcp', headers: {} },
      {},
      () => allowed,
      async () => {
        bearerReads += 1;
        // Simulate the projection expiring while connection setup is entering
        // its first transport operation. The connection must never become an
        // authority bypass just because it was constructed while allowed.
        allowed = false;
        throw new Error('synthetic connect stop');
      },
    );

    await expect(upstream.forward('tools/call', { name: 'pulse_get_my_tasks' }))
      .rejects.toMatchObject({ code: -32003, data: { code: 'scope_denied', service: 'pulse' } });
    expect(bearerReads).toBe(1);
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
    expect((entry as { env: Record<string, string> }).env['MCP_UPSTREAM_BEARER']).toBeUndefined();
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
      async (env) => env['MCP_UPSTREAM_BEARER'] ?? '',
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

// ── SCLI-401: config validation (mcp-multiplexer --services / --liveness-interval) ──

describe('validateMcpMultiplexerConfig (SCLI-401)', () => {
  const validServices = [
    { name: 'pulse', url: 'https://pulse.shizuha.com/mcp', headers: { 'X-Org': '1' } },
    { name: 'wiki', url: 'http://wiki.shizuha.com/mcp' },
  ];

  it('accepts a valid services array and positive integer liveness interval', () => {
    const result = validateMcpMultiplexerConfig(validServices, '30000');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.services).toHaveLength(2);
      expect(result.config.services[0]).toEqual(validServices[0]);
      expect(result.config.services[1].headers).toEqual({});
      expect(result.config.livenessIntervalMs).toBe(30000);
    }
  });

  it('accepts headers omitted entirely', () => {
    const result = validateMcpMultiplexerConfig([{ name: 'pulse', url: 'https://pulse.shizuha.com/mcp' }], '30000');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.services[0].headers).toEqual({});
    }
  });

  it('rejects a non-array top-level value', () => {
    const result = validateMcpMultiplexerConfig({ name: 'pulse' }, '30000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('JSON array');
  });

  it('rejects an empty array', () => {
    const result = validateMcpMultiplexerConfig([], '30000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('at least one upstream service');
  });

  it('rejects null / non-object entries', () => {
    for (const bad of [null, 'pulse', 42, true, ['x']]) {
      const result = validateMcpMultiplexerConfig([bad], '30000');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('service[0] must be an object');
    }
  });

  it('rejects missing / empty / whitespace-only name', () => {
    for (const name of [undefined, '', '   ']) {
      const result = validateMcpMultiplexerConfig([{ name, url: 'https://x.shizuha.com/mcp' }], '30000');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('service[0].name must be a non-empty string');
    }
  });

  it('rejects name with leading/trailing whitespace or control characters', () => {
    for (const name of [' pulse', 'pulse ', 'pul\nse', 'pul\x00se']) {
      const result = validateMcpMultiplexerConfig([{ name, url: 'https://x.shizuha.com/mcp' }], '30000');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('service[0].name');
    }
  });

  it('rejects duplicate names with the offending index', () => {
    const result = validateMcpMultiplexerConfig(
      [
        { name: 'pulse', url: 'https://a.shizuha.com/mcp' },
        { name: 'pulse', url: 'https://b.shizuha.com/mcp' },
      ],
      '30000',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('service[1].name');
      expect(result.error).toContain('unique');
    }
  });

  it('rejects missing / empty url', () => {
    for (const url of [undefined, '', '   ']) {
      const result = validateMcpMultiplexerConfig([{ name: 'pulse', url }], '30000');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('service[0].url must be a non-empty string');
    }
  });

  it('rejects relative / non-absolute url', () => {
    const result = validateMcpMultiplexerConfig([{ name: 'pulse', url: '/mcp' }], '30000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('service[0].url must be an absolute URL');
  });

  it('rejects non-HTTP(S) schemes', () => {
    for (const url of ['file:///etc/passwd', 'ftp://x.shizuha.com/mcp', 'ws://x.shizuha.com/mcp']) {
      const result = validateMcpMultiplexerConfig([{ name: 'pulse', url }], '30000');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('service[0].url must use http:// or https://');
    }
  });

  it('rejects urls containing userinfo', () => {
    const result = validateMcpMultiplexerConfig([{ name: 'pulse', url: 'https://user:pass@x.shizuha.com/mcp' }], '30000');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('service[0].url must not contain userinfo');
  });

  it('rejects invalid headers shape (array / non-string values)', () => {
    const arrayHeaders = validateMcpMultiplexerConfig(
      [{ name: 'pulse', url: 'https://x.shizuha.com/mcp', headers: ['a'] }],
      '30000',
    );
    expect(arrayHeaders.ok).toBe(false);
    if (!arrayHeaders.ok) expect(arrayHeaders.error).toContain('service[0].headers must be an object');

    const nonStringValue = validateMcpMultiplexerConfig(
      [{ name: 'pulse', url: 'https://x.shizuha.com/mcp', headers: { 'X-Org': 1 } }],
      '30000',
    );
    expect(nonStringValue.ok).toBe(false);
    if (!nonStringValue.ok) expect(nonStringValue.error).toContain("service[0].headers['X-Org'] must be a string");
  });

  it('rejects zero / negative / decimal / alpha / blank / overflow liveness interval', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', '   ', '99999999999999999999999999']) {
      const result = validateMcpMultiplexerConfig(validServices, bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('--liveness-interval must be a finite positive integer');
    }
  });

  it('accepts a valid liveness interval edge (1)', () => {
    const result = validateMcpMultiplexerConfig(validServices, '1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.livenessIntervalMs).toBe(1);
  });

  it('never emits a stack, bundle path, or success/startup wording on failure', () => {
    const result = validateMcpMultiplexerConfig([{ name: 'pulse', url: '/mcp' }], '0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toMatch(/at /);
      expect(result.error).not.toMatch(/\.js:/);
      expect(result.error).not.toMatch(/\/opt\/|\/home\//);
      expect(result.error).not.toMatch(/starting|success|retry/i);
    }
  });
});
