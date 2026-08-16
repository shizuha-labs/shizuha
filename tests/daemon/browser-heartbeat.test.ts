import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = MockWebSocket.CLOSED;
  }

  get parsed(): Array<Record<string, unknown>> {
    return this.sent.map((entry) => JSON.parse(entry));
  }
}

interface BrowserClient {
  ws: MockWebSocket;
  lastHeartbeatAt: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

class HeartbeatBridge {
  static readonly INTERVAL_MS = 25_000;
  static readonly TIMEOUT_MS = 60_000;
  clients = new Map<string, BrowserClient>();

  addClient(clientId: string, ws: MockWebSocket): void {
    this.clients.set(clientId, {
      ws,
      lastHeartbeatAt: Date.now(),
      heartbeatTimer: null,
    });
    this.startClientHeartbeat(clientId);
  }

  routeFromBrowser(clientId: string, msg: Record<string, unknown>): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.lastHeartbeatAt = Date.now();
    if (msg.type === 'ping') {
      client.ws.send(JSON.stringify({ type: 'pong' }));
    }
  }

  private stopClientHeartbeat(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client?.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = null;
    }
  }

  private startClientHeartbeat(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.stopClientHeartbeat(clientId);
    client.lastHeartbeatAt = Date.now();
    client.heartbeatTimer = setInterval(() => {
      const current = this.clients.get(clientId);
      if (!current) return;
      if (current.ws.readyState !== MockWebSocket.OPEN) {
        this.stopClientHeartbeat(clientId);
        return;
      }
      if (Date.now() - current.lastHeartbeatAt > HeartbeatBridge.TIMEOUT_MS) {
        this.stopClientHeartbeat(clientId);
        current.ws.close(4000, 'heartbeat timeout');
        return;
      }
      current.ws.send(JSON.stringify({ type: 'ping' }));
    }, HeartbeatBridge.INTERVAL_MS);
  }
}

describe('browser websocket heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-18T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends daemon-originated ping frames on the heartbeat interval', () => {
    const bridge = new HeartbeatBridge();
    const ws = new MockWebSocket();

    bridge.addClient('client-1', ws);
    vi.advanceTimersByTime(HeartbeatBridge.INTERVAL_MS);

    expect(ws.parsed).toEqual([{ type: 'ping' }]);
    expect(ws.closeCalls).toEqual([]);
  });

  it('responds to client ping with pong and refreshes liveness', () => {
    const bridge = new HeartbeatBridge();
    const ws = new MockWebSocket();

    bridge.addClient('client-1', ws);
    vi.advanceTimersByTime(50_000);
    bridge.routeFromBrowser('client-1', { type: 'ping' });
    vi.advanceTimersByTime(50_000);

    expect(ws.parsed).toContainEqual({ type: 'pong' });
    expect(ws.closeCalls).toEqual([]);
  });

  it('closes the socket after the heartbeat timeout without client liveness', () => {
    const bridge = new HeartbeatBridge();
    const ws = new MockWebSocket();

    bridge.addClient('client-1', ws);
    vi.advanceTimersByTime(75_000);

    expect(ws.closeCalls).toEqual([{ code: 4000, reason: 'heartbeat timeout' }]);
  });
});
