import { describe, expect, it } from 'vitest';
import { getPlatformMcpConfigs, platformMcpEntriesToConfigs } from '../../src/platform/mcp-services.js';

describe('PLAT-3195 env derivation → harness MCP configs (PLAT-4013)', () => {
  it('admits the PLAT-3119 multiplexer stdio entry (flag-ON derivation shape)', () => {
    // Exact shape getPlatformMcpConfigs returns when SHIZUHA_MCP_MULTIPLEXER=true:
    // a SINGLE stdio command entry with no `url` field. The pre-PLAT-4013
    // url-only filter in the PLAT-3195 fallback dropped it, leaving
    // derivation-reliant seats (no provisioned ~/.mcp.json, no agentCfg
    // mcp.servers) with ZERO MCP servers — the staged agent-hina canary
    // signature (flag live at every layer, entire MCP surface empty).
    const derived = getPlatformMcpConfigs({
      bearerToken: 'test-jwt',
      stdioProxy: 'off',
      mcpMultiplexer: 'true',
      platformUrl: 'https://platform.example',
      allowList: ['pulse', 'wiki', 'connect'],
    });

    expect(Object.keys(derived)).toEqual(['shizuha-mcp']);
    expect(derived['shizuha-mcp']).not.toHaveProperty('url');

    const configs = platformMcpEntriesToConfigs(derived);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      name: 'shizuha-mcp',
      transport: 'stdio',
      platformManaged: true,
    });
    expect(configs[0]?.command).toBe('node');
    expect(configs[0]?.args?.join(' ')).toContain('mcp-multiplexer');
    // Bearer must NOT be baked into the entry env (broker/file re-read per dial).
    expect(configs[0]?.env?.MCP_UPSTREAM_BEARER).toBeUndefined();
    const servicesArg = configs[0]?.args?.indexOf('--services');
    expect(servicesArg).toBeGreaterThanOrEqual(0);
    const services = JSON.parse(configs[0]?.args?.[servicesArg! + 1]!) as Array<{ name: string }>;
    expect(services.map((s) => s.name)).toEqual(['pulse', 'wiki', 'connect']);
  });

  it('still maps direct-http entries (flag-OFF derivation shape) to streamable-http', () => {
    const derived = getPlatformMcpConfigs({
      bearerToken: 'test-jwt',
      stdioProxy: 'off',
      platformUrl: 'https://platform.example',
      allowList: ['pulse'],
    });

    expect(Object.keys(derived)).toEqual(['shizuha-pulse']);
    const configs = platformMcpEntriesToConfigs(derived);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      name: 'shizuha-pulse',
      transport: 'streamable-http',
      url: 'https://platform.example/mcp/pulse/mcp',
      platformManaged: true,
    });
  });

  it('skips entries that are neither http nor stdio command entries', () => {
    const configs = platformMcpEntriesToConfigs({
      'shizuha-weird': {} as never,
    });
    expect(configs).toEqual([]);
  });
});
