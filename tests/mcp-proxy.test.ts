import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseExtraHeaders,
  resolveProxyConfig,
  buildUpstreamHeaders,
  resolveUpstreamBearer,
  isConnectionError,
  isAuthError,
  AUTH_RETRY_MAX,
  AUTH_RETRY_DELAY_MS,
  LIVENESS_PROBE_TIMEOUT_MS,
  LIVENESS_FAILURES_BEFORE_RECONNECT,
  shouldReconnectAfterLivenessFailure,
  UpstreamConnection,
} from '../src/mcp-proxy/server.js';
import {
  getPlatformMcpConfigs,
  resolveStdioProxyServices,
  type McpStdioServerEntry,
  type McpHttpServerEntry,
} from '../src/platform/mcp-services.js';

// ── mcp-proxy pure helpers ──

describe('mcp-proxy: parseExtraHeaders', () => {
  it('parses "Key: Value" and "Key=Value" forms, trimming whitespace', () => {
    expect(parseExtraHeaders(['X-Organization-ID: 3', 'X-Foo=bar'])).toEqual({
      'X-Organization-ID': '3',
      'X-Foo': 'bar',
    });
  });

  it('skips blank / malformed entries and tolerates undefined', () => {
    expect(parseExtraHeaders(undefined)).toEqual({});
    expect(parseExtraHeaders(['', 'no-separator', '  '])).toEqual({});
  });

  it('keeps colons inside the value (e.g. URLs)', () => {
    expect(parseExtraHeaders(['X-Url: https://x/y'])).toEqual({ 'X-Url': 'https://x/y' });
  });
});

describe('mcp-proxy: resolveProxyConfig', () => {
  it('requires an upstream URL', () => {
    expect(() => resolveProxyConfig({ name: 'pulse' }, {})).toThrow(/upstream-url/);
  });

  it('materialises MCP_UPSTREAM_ORG into an X-Organization-ID header', () => {
    const cfg = resolveProxyConfig(
      { name: 'pulse', upstreamUrl: 'http://h/mcp/pulse/mcp' },
      { MCP_UPSTREAM_ORG: '3' },
    );
    expect(cfg.extraHeaders).toEqual({ 'X-Organization-ID': '3' });
  });

  it('does not override an explicit X-Organization-ID header from --header', () => {
    const cfg = resolveProxyConfig(
      { name: 'pulse', upstreamUrl: 'http://h/mcp/pulse/mcp', header: ['X-Organization-ID: 7'] },
      { MCP_UPSTREAM_ORG: '3' },
    );
    expect(cfg.extraHeaders).toEqual({ 'X-Organization-ID': '7' });
  });

  it('falls back to env for name + url', () => {
    const cfg = resolveProxyConfig({}, { MCP_UPSTREAM_NAME: 'wiki', MCP_UPSTREAM_URL: 'http://h/mcp/wiki/mcp' });
    expect(cfg.name).toBe('wiki');
    expect(cfg.upstreamUrl).toBe('http://h/mcp/wiki/mcp');
  });
});

describe('mcp-proxy: buildUpstreamHeaders reads the bearer FRESH from env', () => {
  let previousBrokerSocket: string | undefined;

  beforeEach(() => {
    previousBrokerSocket = process.env['MCP_AUTH_PROXY_SOCKET'];
    // Keep these unit tests deterministic even when they run inside a fleet pod
    // that has a live broker sidecar; this describe exercises the file/env
    // fallback path, not broker precedence.
    process.env['MCP_AUTH_PROXY_SOCKET'] = path.join(os.tmpdir(), `missing-mcp-broker-${process.pid}.sock`);
  });

  afterEach(() => {
    if (previousBrokerSocket === undefined) delete process.env['MCP_AUTH_PROXY_SOCKET'];
    else process.env['MCP_AUTH_PROXY_SOCKET'] = previousBrokerSocket;
  });

  it('injects Authorization from MCP_UPSTREAM_BEARER on each call', async () => {
    const extra = { 'X-Organization-ID': '3' };
    await expect(buildUpstreamHeaders(extra, { MCP_UPSTREAM_BEARER: 'tok1' })).resolves.toEqual({
      'X-Organization-ID': '3',
      Authorization: 'Bearer tok1',
    });
    // A refreshed token is picked up because the value is read at call time.
    await expect(buildUpstreamHeaders(extra, { MCP_UPSTREAM_BEARER: 'tok2' })).resolves.toEqual({
      'X-Organization-ID': '3',
      Authorization: 'Bearer tok2',
    });
  });

  it('omits Authorization when no bearer is set', async () => {
    await expect(buildUpstreamHeaders({}, {})).resolves.toEqual({});
  });
});

describe('mcp-proxy: resolveUpstreamBearer (file > env — the 24h-cliff fix)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpbearer-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('prefers the FRESH token from MCP_UPSTREAM_BEARER_FILE over the env seed', async () => {
    const file = path.join(dir, '.mcp-upstream-token');
    fs.writeFileSync(file, 'fresh-from-file\n'); // trailing newline must be trimmed
    expect(resolveUpstreamBearer({ MCP_UPSTREAM_BEARER: 'stale-env-seed', MCP_UPSTREAM_BEARER_FILE: file }))
      .toBe('fresh-from-file');
    // buildUpstreamHeaders threads the file through too
    const previousBrokerSocket = process.env['MCP_AUTH_PROXY_SOCKET'];
    process.env['MCP_AUTH_PROXY_SOCKET'] = path.join(os.tmpdir(), `missing-mcp-broker-${process.pid}.sock`);
    try {
      await expect(buildUpstreamHeaders({}, { MCP_UPSTREAM_BEARER: 'stale-env-seed', MCP_UPSTREAM_BEARER_FILE: file }))
        .resolves.toEqual({ Authorization: 'Bearer fresh-from-file' });
    } finally {
      if (previousBrokerSocket === undefined) delete process.env['MCP_AUTH_PROXY_SOCKET'];
      else process.env['MCP_AUTH_PROXY_SOCKET'] = previousBrokerSocket;
    }
  });

  it('rewriting the file is picked up WITHOUT a process restart (re-read each call)', () => {
    const file = path.join(dir, '.mcp-upstream-token');
    fs.writeFileSync(file, 'tok-A');
    const env = { MCP_UPSTREAM_BEARER: 'seed', MCP_UPSTREAM_BEARER_FILE: file };
    expect(resolveUpstreamBearer(env)).toBe('tok-A');
    fs.writeFileSync(file, 'tok-B'); // bridge refreshes the file
    expect(resolveUpstreamBearer(env)).toBe('tok-B');
  });

  it('falls back to the env seed when the file is missing or empty', () => {
    const missing = path.join(dir, 'does-not-exist');
    expect(resolveUpstreamBearer({ MCP_UPSTREAM_BEARER: 'seed', MCP_UPSTREAM_BEARER_FILE: missing })).toBe('seed');
    const empty = path.join(dir, 'empty'); fs.writeFileSync(empty, '   ');
    expect(resolveUpstreamBearer({ MCP_UPSTREAM_BEARER: 'seed', MCP_UPSTREAM_BEARER_FILE: empty })).toBe('seed');
  });
});

describe('mcp-proxy: isAuthError (401/403 now self-heals via reconnect-with-fresh-token)', () => {
  it('classifies transport-level auth failures as retryable', () => {
    for (const m of [
      'Error POSTing to endpoint (HTTP 401): {"detail":"token expired"}',
      'Error POSTing to endpoint (HTTP 403): forbidden',
      'request failed with status 401',
      '401: Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Authentication required"}',
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Authentication required"}',
      'token_not_valid',
    ]) {
      expect(isAuthError(new Error(m)), m).toBe(true);
    }
  });

  it('keeps auth retries long enough for bridge force-refresh to hide one-off 401s', () => {
    // The bridge observes .mcp-force-refresh on a 5s poll and mints a fresh token
    // asynchronously. A short 5x150ms retry loop surfaced the first 401 to the
    // agent before the bridge could update .mcp-upstream-token; keep the proxy
    // retry window comfortably above that poll interval.
    expect(AUTH_RETRY_DELAY_MS).toBeGreaterThanOrEqual(1000);
    expect(AUTH_RETRY_MAX * AUTH_RETRY_DELAY_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('does NOT treat a tool-level "forbidden"/"unauthorized" message as an auth retry', () => {
    for (const m of [
      'Permission denied for this project',
      'You are forbidden from transitioning this task',
      'unauthorized: user lacks the reviewer role',
    ]) {
      expect(isAuthError(new Error(m)), m).toBe(false);
    }
  });
});

describe('mcp-proxy: isConnectionError', () => {
  it('treats transport-ish errors as reconnectable', () => {
    for (const m of [
      'Connection closed',
      'fetch failed',
      'ECONNREFUSED 1.2.3.4:80',
      'socket hang up',
      'Not connected',
      'request timed out',
      'HTTP 503 Service Unavailable',
      'MCP error -32000: Connection closed',
      'session expired',
    ]) {
      expect(isConnectionError(new Error(m)), m).toBe(true);
    }
  });

  it('does NOT reconnect on genuine application/tool errors', () => {
    for (const m of [
      'Task PLAT-1 not found',
      'Invalid arguments: missing field "title"',
      'Permission denied for this project',
    ]) {
      expect(isConnectionError(new Error(m)), m).toBe(false);
    }
  });
});


describe('mcp-proxy: liveness probe dampening', () => {
  it('requires repeated idle-probe failures before reconnecting the shared upstream session', () => {
    // PLAT-2970: a single `health probe timeout` was closing the shared MCP
    // session and aborting in-flight agent turns. Keep the probe bounded, but
    // never destructive on the first transient miss.
    expect(LIVENESS_PROBE_TIMEOUT_MS).toBeLessThan(30_000);
    expect(LIVENESS_FAILURES_BEFORE_RECONNECT).toBeGreaterThanOrEqual(3);
    expect(shouldReconnectAfterLivenessFailure(1)).toBe(false);
    expect(shouldReconnectAfterLivenessFailure(LIVENESS_FAILURES_BEFORE_RECONNECT - 1)).toBe(false);
    expect(shouldReconnectAfterLivenessFailure(LIVENESS_FAILURES_BEFORE_RECONNECT)).toBe(true);
  });

  it('does not invalidate if a real forward starts while a liveness probe is timing out', async () => {
    vi.useFakeTimers();
    const upstream = new UpstreamConnection({
      name: 'pulse',
      upstreamUrl: 'https://example.invalid/mcp',
      extraHeaders: [],
    } as any);
    let rejectPing!: (err: Error) => void;
    (upstream as any).client = {
      request: vi.fn(() => new Promise((_resolve, reject) => { rejectPing = reject; })),
    };
    (upstream as any).livenessFailureCount = LIVENESS_FAILURES_BEFORE_RECONNECT - 1;
    const invalidate = vi.spyOn(upstream, 'invalidate').mockResolvedValue(undefined);
    const warm = vi.spyOn(upstream, 'warm').mockImplementation(() => {});

    upstream.startLiveness(10);
    await vi.advanceTimersByTimeAsync(10);
    expect((upstream as any).client.request).toHaveBeenCalledWith(
      { method: 'ping', params: {} },
      expect.anything(),
      { timeout: LIVENESS_PROBE_TIMEOUT_MS },
    );

    (upstream as any).activeForwardRequests = 1;
    rejectPing(new Error('request timed out'));
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    expect((upstream as any).livenessFailureCount).toBe(LIVENESS_FAILURES_BEFORE_RECONNECT);

    clearInterval((upstream as any).livenessTimer);
    vi.useRealTimers();
  });
});

// ── flag wiring in getPlatformMcpConfigs ──

describe('getPlatformMcpConfigs: SHIZUHA_MCP_STDIO_PROXY flag', () => {
  const ENV_KEYS = ['SHIZUHA_MCP_STDIO_PROXY', 'SHIZUHA_MCP_SERVICES', 'SHIZUHA_ORGANIZATION_ID', 'PLATFORM_HOST', 'DAEMON_HOST', 'SHIZUHA_PLATFORM_URL'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

  const baseOpts = { bearerToken: 'jwt-abc', platformUrl: 'https://shizuha.com' };

  it('default ON: every entry uses the stdio-proxy form', () => {
    const cfgs = getPlatformMcpConfigs({ ...baseOpts, allowList: ['pulse'] });
    const pulse = cfgs['shizuha-pulse'] as McpStdioServerEntry;
    // DEFAULT-ON (PLAT-504): no stdioProxy opt, no env var → all services via proxy.
    expect('command' in pulse).toBe(true);
    expect(pulse.command).toBe('node');
    expect(pulse.args).toContain('mcp-proxy');
    expect(pulse.args).toContain('pulse');
    const i = pulse.args.indexOf('--upstream-url');
    expect(pulse.args[i + 1]).toBe('https://shizuha.com/mcp/pulse/mcp');
    expect(pulse.env.MCP_UPSTREAM_BEARER).toBe('jwt-abc');
  });

  it('flag=pulse,wiki: only those become stdio-proxy entries; others stay HTTP', () => {
    const cfgs = getPlatformMcpConfigs({
      ...baseOpts,
      allowList: ['pulse', 'wiki', 'notes'],
      stdioProxy: 'pulse,wiki',
      organizationId: 3,
    });
    const pulse = cfgs['shizuha-pulse'] as McpStdioServerEntry;
    expect(pulse.command).toBe('node');
    expect(pulse.args).toContain('mcp-proxy');
    expect(pulse.args).toContain('--name');
    expect(pulse.args).toContain('pulse');
    // upstream-url is the SAME url the HTTP form would have used.
    const i = pulse.args.indexOf('--upstream-url');
    expect(pulse.args[i + 1]).toBe('https://shizuha.com/mcp/pulse/mcp');
    // bearer passed via env (read fresh by the proxy), org id forwarded.
    expect(pulse.env.MCP_UPSTREAM_BEARER).toBe('jwt-abc');
    expect(pulse.env.MCP_UPSTREAM_ORG).toBe('3');

    // notes was NOT selected → still HTTP.
    const notes = cfgs['shizuha-notes'] as McpHttpServerEntry;
    expect(notes.type).toBe('http');
    expect('command' in notes).toBe(false);
  });

  it('flag=1 / true / * → ALL allowed services become stdio-proxy entries', () => {
    for (const flag of ['1', 'true', '*', 'all']) {
      const cfgs = getPlatformMcpConfigs({ ...baseOpts, allowList: ['pulse', 'wiki'], stdioProxy: flag });
      expect('command' in cfgs['shizuha-pulse']!).toBe(true);
      expect('command' in cfgs['shizuha-wiki']!).toBe(true);
    }
  });

  it('reads the flag from SHIZUHA_MCP_STDIO_PROXY env when no opt is passed', () => {
    process.env['SHIZUHA_MCP_STDIO_PROXY'] = 'pulse';
    const cfgs = getPlatformMcpConfigs({ ...baseOpts, allowList: ['pulse'] });
    expect('command' in cfgs['shizuha-pulse']!).toBe(true);
  });
});

describe('resolveStdioProxyServices', () => {
  it('returns null for explicit OFF values (not empty — empty is DEFAULT-ON)', () => {
    for (const v of ['0', 'false', 'off', 'no']) expect(resolveStdioProxyServices(v)).toBeNull();
  });
  it('returns "*" for empty/unset (DEFAULT-ON, PLAT-504)', () => {
    expect(resolveStdioProxyServices('')).toBe('*');
    expect(resolveStdioProxyServices(undefined)).toBe('*');
  });
  it('returns "*" for all-on values', () => {
    for (const v of ['1', 'true', '*', 'all', 'on', 'yes']) expect(resolveStdioProxyServices(v)).toBe('*');
  });
  it('returns a name Set for a comma-list', () => {
    const r = resolveStdioProxyServices('pulse, wiki ,connect');
    expect(r).toBeInstanceOf(Set);
    expect([...(r as Set<string>)].sort()).toEqual(['connect', 'pulse', 'wiki']);
  });
});
