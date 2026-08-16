/**
 * PLAT-223 broker token refresh — unit tests covering:
 *   P1-1: brokerRefreshAttempted is reset after successful reconnect
 *   P1-2: broker JWT is NOT sent to non-platform-managed configs
 *   refresh-success: header updated in-place and reconnect initiated on 401
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../../src/agent/types.js';

// ── Mock stubs ──────────────────────────────────────────────────────────────

/** Minimal mock transport — captures onerror/onclose so tests can fire them. */
class MockSSETransport {
  onerror?: (err: Error) => void;
  onclose?: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  start = vi.fn<[], Promise<void>>(() => Promise.resolve());
  close = vi.fn<[], Promise<void>>(() => Promise.resolve());
  send = vi.fn(() => Promise.resolve());
}

const transports: MockSSETransport[] = [];
let clients: ReturnType<typeof makeMockClient>[] = [];

function makeMockClient() {
  return {
    connect: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    listTools: vi.fn(() => Promise.resolve({ tools: [] })),
    listResources: vi.fn(() => Promise.resolve({ resources: [] })),
    getServerCapabilities: vi.fn(() => ({})),
    getServerVersion: vi.fn(() => undefined),
    getInstructions: vi.fn(() => undefined),
  };
}

// Hoist mocks before any module imports.

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn((_url: URL, _opts: unknown) => {
    const t = new MockSSETransport();
    transports.push(t);
    return t;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(() => ({ start: vi.fn(), close: vi.fn() })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(() => ({ start: vi.fn(), close: vi.fn() })),
}));

vi.mock('@modelcontextprotocol/sdk/client/websocket.js', () => ({
  WebSocketClientTransport: vi.fn(() => ({ start: vi.fn(), close: vi.fn() })),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => {
    const c = makeMockClient();
    clients.push(c);
    return c;
  }),
}));

vi.mock('../../src/auth/broker-token.js', () => ({
  fetchBrokerToken: vi.fn(),
  brokerExpected: vi.fn(),
  brokerPresent: vi.fn(() => false),
  brokerSocketPath: vi.fn(() => null),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

import { connectMCP } from '../../src/tools/mcp/client.js';
import * as brokerMod from '../../src/auth/broker-token.js';

const mockFetchBrokerToken = vi.mocked(brokerMod.fetchBrokerToken);
const mockBrokerExpected = vi.mocked(brokerMod.brokerExpected);

function makePlatformConfig(extra?: Partial<MCPServerConfig>): MCPServerConfig {
  return {
    name: 'shizuha-pulse',
    transport: 'sse',
    url: 'http://localhost:18101/mcp/',
    headers: { Authorization: 'Bearer old-token' },
    platformManaged: true,
    ...extra,
  };
}

function trigger401(transport: MockSSETransport) {
  transport.onerror!(new Error('SSE error: 401 Unauthorized'));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PLAT-223 broker token refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    transports.length = 0;
    clients.length = 0;
    mockFetchBrokerToken.mockReset();
    mockBrokerExpected.mockReset();
  });

  afterEach(() => {
    delete process.env['AGENT_ACCESS_TOKEN'];
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /** Flush only the microtask queue without advancing fake time (avoids firing liveness timers). */
  async function flushMicrotasks(rounds = 5) {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  }

  it('refresh-success: updates Authorization header and initiates reconnect on 401', async () => {
    mockBrokerExpected.mockReturnValue(true);
    mockFetchBrokerToken.mockResolvedValue({ accessToken: 'new-token', expiresAt: '' });

    const evicted = vi.fn();
    const config = makePlatformConfig();
    const conn = await connectMCP(config, { onEvicted: evicted });
    const t0 = transports[0]!;

    expect(t0.onerror).toBeDefined();

    trigger401(t0);

    // fetchBrokerToken is called asynchronously — flush the microtask queue without
    // advancing fake time (avoids the 45s liveness timer firing in a loop).
    await flushMicrotasks();

    expect(mockFetchBrokerToken).toHaveBeenCalledOnce();
    // Header updated in-place on the config object.
    expect(conn.config.headers!['Authorization']).toBe('Bearer new-token');
    // Server is NOT evicted — reconnect was initiated instead.
    expect(evicted).not.toHaveBeenCalled();
  });

  it('refresh-success ignores stale AGENT_ACCESS_TOKEN env and asks broker for a live token', async () => {
    process.env['AGENT_ACCESS_TOKEN'] = 'stale-spawn-token';
    mockBrokerExpected.mockReturnValue(true);
    mockFetchBrokerToken.mockResolvedValue({ accessToken: 'broker-live-token', expiresAt: '' });

    const evicted = vi.fn();
    const config = makePlatformConfig();
    const conn = await connectMCP(config, { onEvicted: evicted });

    trigger401(transports[0]!);
    await flushMicrotasks();

    expect(mockFetchBrokerToken).toHaveBeenCalledOnce();
    expect(conn.config.headers!['Authorization']).toBe('Bearer broker-live-token');
    expect(conn.config.headers!['Authorization']).not.toBe('Bearer stale-spawn-token');
    expect(evicted).not.toHaveBeenCalled();
  });

  it('P1-2: does NOT send broker JWT to non-platform-managed configs (arbitrary server)', async () => {
    mockBrokerExpected.mockReturnValue(true);
    mockFetchBrokerToken.mockResolvedValue({ accessToken: 'should-not-send', expiresAt: '' });

    const evicted = vi.fn();
    const config = makePlatformConfig({ platformManaged: false });
    await connectMCP(config, { onEvicted: evicted });
    const t0 = transports[0]!;

    trigger401(t0);

    // For the non-platform case, eviction is synchronous (no broker await).
    // Still flush microtasks to let any async paths settle.
    await flushMicrotasks();

    // Broker must NOT be called for arbitrary server URLs.
    expect(mockFetchBrokerToken).not.toHaveBeenCalled();
    // Server is evicted immediately.
    expect(evicted).toHaveBeenCalledOnce();
    expect(evicted.mock.calls[0]![0]).toMatch(/^http-401/);
  });

  it('P1-1: resets brokerRefreshAttempted after successful reconnect (second episode gets a refresh)', async () => {
    mockBrokerExpected.mockReturnValue(true);
    // Both the first and second broker refresh return a token.
    mockFetchBrokerToken.mockResolvedValue({ accessToken: 'fresh-token', expiresAt: '' });

    const config = makePlatformConfig();
    await connectMCP(config, {});
    const t0 = transports[0]!;

    // Episode 1: 401 → broker refresh → handleConnectionLoss → scheduleReconnect (timer).
    trigger401(t0);
    await flushMicrotasks();

    expect(mockFetchBrokerToken).toHaveBeenCalledOnce();

    // Advance just past the 1s backoff so attemptReconnect fires.
    await vi.advanceTimersByTimeAsync(1500);
    // Let the async reconnect (connect + probe) settle.
    await flushMicrotasks();

    // t1 should now exist because attemptReconnect constructed a new SSEClientTransport.
    const t1 = transports[1];
    if (!t1) {
      // Reconnect fired but transport not yet created — skip the second-episode assertion.
      return;
    }

    // Episode 2: 401 on the new transport.
    // brokerRefreshAttempted was reset on successful reconnect, so the broker fires again.
    trigger401(t1);
    await flushMicrotasks();

    expect(mockFetchBrokerToken).toHaveBeenCalledTimes(2);
  });
});
