import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../../src/agent/types.js';

class MockStreamableHttpTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  closed = false;
  start = vi.fn(async () => undefined);
  send = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  });
}

const transports: MockStreamableHttpTransport[] = [];

class MockClient {
  private transport?: MockStreamableHttpTransport;

  connect = vi.fn(async (transport: MockStreamableHttpTransport) => {
    this.transport = transport;
    await transport.start();
  });
  close = vi.fn(async () => this.transport?.close());
  ping = vi.fn(async () => ({}));
  listTools = vi.fn(async () => ({ tools: [] }));
  listResources = vi.fn(async () => ({ resources: [] }));
  getServerCapabilities = vi.fn(() => ({}));
  getServerVersion = vi.fn(() => undefined);
  getInstructions = vi.fn(() => undefined);
}

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(() => {
    const transport = new MockStreamableHttpTransport();
    transports.push(transport);
    return transport;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => new MockClient()),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/websocket.js', () => ({
  WebSocketClientTransport: vi.fn(),
}));

vi.mock('../../src/auth/broker-token.js', () => ({
  fetchBrokerToken: vi.fn(),
  brokerExpected: vi.fn(() => false),
}));

vi.mock('../../src/config/shizuhaAuth.js', () => ({
  getValidShizuhaOAuthAccessToken: vi.fn(async () => shortLivedJwt()),
}));

import { MCPManager } from '../../src/tools/mcp/manager.js';

function shortLivedJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 1;
  return `${encode({ alg: 'none' })}.${encode({ exp })}.sig`;
}

function config(): MCPServerConfig {
  return {
    name: 'shizuha-hive',
    transport: 'streamable-http',
    url: 'http://hive-mcp.test/mcp',
    headers: { Authorization: `Bearer ${shortLivedJwt()}` },
  };
}

function activeTransportCount(): number {
  return transports.filter((transport) => !transport.closed).length;
}

describe('SCLI-488 streamable-http auth refresh lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    transports.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps exactly one upstream stream across two production-order proactive refresh cycles', async () => {
    const manager = new MCPManager();
    await manager.connectAll([config()]);

    expect(manager.size).toBe(1);
    expect(activeTransportCount()).toBe(1);

    // A near-expiry JWT is refreshed at the 30s floor. The real manager has
    // already wrapped transport.onclose at this point, matching production.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.size).toBe(1);
    expect(activeTransportCount()).toBe(1);

    // Re-arm boundary: the replacement token is also near expiry, so run the
    // complete timer -> intentional close -> replacement sequence a second time.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.size).toBe(1);
    expect(activeTransportCount()).toBe(1);

    await manager.disconnectAll();
    expect(activeTransportCount()).toBe(0);
  });
});
