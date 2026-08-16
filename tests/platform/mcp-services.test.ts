import { afterEach, describe, expect, it } from 'vitest';
import {
  getPlatformMcpConfigs,
  resolveOrganizationIdForMcp,
  resolveMcpAllowList,
  prunePlatformMcpKeys,
  stripPlatformManagedMcpEntries,
} from '../../src/platform/mcp-services.js';

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

describe('platform MCP organization context', () => {
  const savedOrg = process.env['SHIZUHA_ORGANIZATION_ID'];

  afterEach(() => {
    if (savedOrg === undefined) delete process.env['SHIZUHA_ORGANIZATION_ID'];
    else process.env['SHIZUHA_ORGANIZATION_ID'] = savedOrg;
  });

  it('explicit organization id wins', () => {
    process.env['SHIZUHA_ORGANIZATION_ID'] = '42';
    const bearerToken = token({ organization_id: 99, organization_memberships: { '1': 'owner' } });
    expect(resolveOrganizationIdForMcp({ bearerToken, organizationId: 7 })).toBe('7');
  });

  it('environment organization id wins over token claims', () => {
    process.env['SHIZUHA_ORGANIZATION_ID'] = '42';
    const bearerToken = token({ organization_id: 99 });
    expect(resolveOrganizationIdForMcp({ bearerToken })).toBe('42');
  });

  it('uses legacy token organization_id claim', () => {
    delete process.env['SHIZUHA_ORGANIZATION_ID'];
    const bearerToken = token({ organization_id: 99 });
    expect(resolveOrganizationIdForMcp({ bearerToken })).toBe('99');
  });

  it('auto-selects a single organization membership', () => {
    delete process.env['SHIZUHA_ORGANIZATION_ID'];
    const bearerToken = token({ organization_memberships: { '50': 'owner' } });
    expect(resolveOrganizationIdForMcp({ bearerToken })).toBe('50');
  });

  it('omits organization header for multi-membership tokens', () => {
    delete process.env['SHIZUHA_ORGANIZATION_ID'];
    const bearerToken = token({ organization_memberships: { '1': 'admin', '7': 'owner' } });
    const configs = getPlatformMcpConfigs({ bearerToken, mcpHost: 'localhost', stdioProxy: 'off' });
    expect(configs['shizuha-wiki']?.headers['Authorization']).toBe(`Bearer ${bearerToken}`);
    expect(configs['shizuha-wiki']?.headers['X-Organization-ID']).toBeUndefined();
  });

  it('injects X-Organization-ID when the token has a single membership', () => {
    delete process.env['SHIZUHA_ORGANIZATION_ID'];
    const bearerToken = token({ organization_memberships: { '50': 'owner' } });
    const configs = getPlatformMcpConfigs({ bearerToken, mcpHost: 'localhost', stdioProxy: 'off' });
    expect(configs['shizuha-wiki']?.headers['X-Organization-ID']).toBe('50');
  });
});

describe('SHIZUHA_MCP_SERVICES allow-list (SCLI-64)', () => {
  const saved = process.env['SHIZUHA_MCP_SERVICES'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SHIZUHA_MCP_SERVICES'];
    else process.env['SHIZUHA_MCP_SERVICES'] = saved;
  });

  it('unset env → all platform services configured', () => {
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const configs = getPlatformMcpConfigs({ bearerToken: token({}), mcpHost: 'localhost' });
    expect(configs['shizuha-pulse']).toBeDefined();
    expect(configs['shizuha-wiki']).toBeDefined();
    expect(Object.keys(configs).length).toBeGreaterThan(3);
  });


  it('explicit stdioProxy off emits HTTP entries with headers for Codex config generation', () => {
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const bearerToken = token({ organization_memberships: { '50': 'owner' } });
    const configs = getPlatformMcpConfigs({ bearerToken, mcpHost: 'localhost', stdioProxy: 'off' });
    expect(configs['shizuha-pulse']).toMatchObject({ type: 'http', url: 'http://localhost:18101/mcp' });
    expect('headers' in configs['shizuha-pulse']!).toBe(true);
  });

  it('opts.allowList → only listed services, default-deny the rest', () => {
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const configs = getPlatformMcpConfigs({
      bearerToken: token({}), mcpHost: 'localhost', allowList: ['pulse', 'wiki', 'connect'],
    });
    expect(Object.keys(configs).sort()).toEqual(['shizuha-connect', 'shizuha-pulse', 'shizuha-wiki']);
  });

  it('env allow-list (comma, with whitespace) scopes the set', () => {
    process.env['SHIZUHA_MCP_SERVICES'] = 'pulse, wiki';
    const configs = getPlatformMcpConfigs({ bearerToken: token({}), mcpHost: 'localhost' });
    expect(Object.keys(configs).sort()).toEqual(['shizuha-pulse', 'shizuha-wiki']);
  });

  it('resolveMcpAllowList: intersects when both explicit and env are set (env narrows role ceiling)', () => {
    // Both present → intersection (env wins as the narrowing lever)
    process.env['SHIZUHA_MCP_SERVICES'] = 'pulse,wiki,connect';
    expect(resolveMcpAllowList(['pulse', 'wiki', 'drive'])).toEqual(new Set(['pulse', 'wiki'])); // drive outside env
    expect(resolveMcpAllowList(['drive'])).toEqual(new Set()); // nothing in common
    // Only explicit (no env) → explicit wins
    delete process.env['SHIZUHA_MCP_SERVICES'];
    expect(resolveMcpAllowList(['drive', 'pulse'])).toEqual(new Set(['drive', 'pulse']));
    // Only env (no explicit) → env wins
    process.env['SHIZUHA_MCP_SERVICES'] = 'pulse,wiki';
    expect(resolveMcpAllowList()).toEqual(new Set(['pulse', 'wiki']));
    // Neither → null (allow all)
    delete process.env['SHIZUHA_MCP_SERVICES'];
    expect(resolveMcpAllowList()).toBeNull();
  });

  it('analytics role + narrowed SHIZUHA_MCP_SERVICES env → only intersection connected (SCLI-44/SCLI-64)', async () => {
    // analytics role = base + {finance, books, inventory}
    // operator narrows env to base only: {pulse, wiki, connect}
    // result: only {pulse, wiki, connect} — extra analytics grants blocked by env
    const { resolveAllowedServers } = await import('../../src/platform/mcp-access-matrix.js');
    process.env['SHIZUHA_MCP_SERVICES'] = 'pulse,wiki,connect';
    const analyticsAllowed = resolveAllowedServers('analytics');
    const resolved = resolveMcpAllowList([...analyticsAllowed]);
    expect(resolved).toEqual(new Set(['pulse', 'wiki', 'connect']));
    expect(resolved!.has('finance')).toBe(false);
    expect(resolved!.has('books')).toBe(false);
    delete process.env['SHIZUHA_MCP_SERVICES'];
  });

  it('prunePlatformMcpKeys drops stale non-allowed shizuha-* but keeps allowed + custom keys', () => {
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const merged = {
      'shizuha-pulse': 1, 'shizuha-wiki': 2, 'shizuha-notes': 3, // notes was trimmed
      'shizuha-cron': 4,  // retired local cron MCP — pruned as stale platform-era config
      'shizuha-time': 7,  // retired platform MCP — pruned as stale platform-era config
      'shizuha-hr': 8,    // retired platform MCP — pruned as stale platform-era config
      'ori': 5, 'google-drive': 6, // custom non-platform → untouched
    };
    const pruned = prunePlatformMcpKeys(merged, ['pulse', 'wiki']);
    expect(pruned['shizuha-notes']).toBeUndefined();   // dropped (not allowed)
    expect(pruned['shizuha-pulse']).toBe(1);
    expect(pruned['shizuha-wiki']).toBe(2);
    expect(pruned['shizuha-cron']).toBeUndefined();    // retired local MCP is always stale
    expect(pruned['shizuha-time']).toBeUndefined();
    expect(pruned['shizuha-hr']).toBeUndefined();
    expect(pruned['ori']).toBe(5);
    expect(pruned['google-drive']).toBe(6);
  });

  it('prunePlatformMcpKeys keeps active entries when allow-list unset but still drops retired entries', () => {
    delete process.env['SHIZUHA_MCP_SERVICES'];
    const merged = { 'shizuha-pulse': 1, 'shizuha-notes': 2, 'shizuha-time': 3, 'shizuha-hr': 4 };
    expect(prunePlatformMcpKeys(merged)).toEqual({ 'shizuha-pulse': 1, 'shizuha-notes': 2 });
  });
});

describe('PLAT-4023: multiplexer flag is idempotent + reversible (authoritative platform block)', () => {
  const ALLOW = ['pulse', 'id', 'admin', 'wiki', 'connect'];
  const bearer = token({});

  // Simulate the claude-bridge merge: strip platform-managed keys from the
  // persistent .mcp.json, then Object.assign the freshly-computed platform block.
  function mergeLikeBridge(
    existing: Record<string, unknown>,
    fresh: Record<string, unknown>,
  ): Record<string, unknown> {
    const base = stripPlatformManagedMcpEntries(existing);
    Object.assign(base, fresh);
    return base;
  }

  it('turning the multiplexer ON replaces the per-service proxies with a single shizuha-mcp', () => {
    // Prior boot left the 5 per-service entries + custom entries on the volume.
    const existing: Record<string, unknown> = {
      'shizuha-cron': { command: 'node' },
      'shizuha-pulse': { type: 'http' },
      'shizuha-id': { type: 'http' },
      'shizuha-admin': { type: 'http' },
      'shizuha-wiki': { type: 'http' },
      'shizuha-connect': { type: 'http' },
      ori: { type: 'http' },
    };
    const fresh = getPlatformMcpConfigs({
      bearerToken: bearer, mcpHost: 'localhost', allowList: ALLOW, mcpMultiplexer: 'true',
    });
    const merged = mergeLikeBridge(existing, fresh);
    const keys = Object.keys(merged).sort();
    expect(keys).toEqual(['ori', 'shizuha-mcp']);
    expect(keys.filter((k) => k.startsWith('shizuha-') && k !== 'shizuha-mcp')).toEqual([]);
  });

  it('turning the multiplexer OFF after a prior ON restores the per-service baseline with no stale shizuha-mcp', () => {
    // Prior boot ran the multiplexer; the volume carries shizuha-mcp + custom.
    const existing: Record<string, unknown> = {
      'shizuha-cron': { command: 'node' },
      'shizuha-mcp': { command: 'node', args: ['mcp-multiplexer'] },
      ori: { type: 'http' },
    };
    const fresh = getPlatformMcpConfigs({
      bearerToken: bearer, mcpHost: 'localhost', allowList: ALLOW,
      mcpMultiplexer: 'false', stdioProxy: 'off',
    });
    const merged = mergeLikeBridge(existing, fresh);
    expect(merged['shizuha-mcp']).toBeUndefined();
    expect(Object.keys(merged).sort()).toEqual(
      ['ori', 'shizuha-admin', 'shizuha-connect', 'shizuha-id', 'shizuha-pulse', 'shizuha-wiki'],
    );
  });

  it('stripPlatformManagedMcpEntries drops per-service + shizuha-mcp + retired cron but preserves custom', () => {
    const out = stripPlatformManagedMcpEntries({
      'shizuha-cron': 1, 'shizuha-pulse': 2, 'shizuha-mcp': 3, 'shizuha-foo-custom': 4, ori: 5,
    });
    expect(out).toEqual({ 'shizuha-foo-custom': 4, ori: 5 });
  });
});
