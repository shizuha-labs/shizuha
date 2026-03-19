import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }

  sendMessage(msg: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }

  fail(err = new Error('boom')): void {
    this.emit('error', err);
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSING;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close');
  }
}

class LocalAgentSocketManager {
  localAgentWs = new Map<string, MockWebSocket>();
  localAgentReconnectTimers = new Map<string, NodeJS.Timeout>();
  routed: Record<string, unknown>[] = [];

  constructor(
    private readonly createSocket: (agentId: string) => MockWebSocket,
    private readonly isAgentRunning: (agentId: string) => boolean = () => true,
  ) {}

  private clearLocalAgentReconnect(agentId: string): void {
    const timer = this.localAgentReconnectTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.localAgentReconnectTimers.delete(agentId);
    }
  }

  private scheduleLocalAgentReconnect(agentId: string): void {
    if (this.localAgentReconnectTimers.has(agentId) || !this.isAgentRunning(agentId)) return;

    const timer = setTimeout(() => {
      if (this.localAgentReconnectTimers.get(agentId) === timer) {
        this.localAgentReconnectTimers.delete(agentId);
      }
      this.connectLocalAgent(agentId);
    }, 3000);

    this.localAgentReconnectTimers.set(agentId, timer);
  }

  connectLocalAgent(agentId: string): MockWebSocket | null {
    const existing = this.localAgentWs.get(agentId);
    if (existing) {
      if (existing.readyState === MockWebSocket.OPEN || existing.readyState === MockWebSocket.CONNECTING) {
        return existing;
      }
      if (existing.readyState === MockWebSocket.CLOSING) {
        return existing;
      }
      this.localAgentWs.delete(agentId);
    }

    const ws = this.createSocket(agentId);
    this.localAgentWs.set(agentId, ws);

    ws.on('open', () => {
      if (this.localAgentWs.get(agentId) !== ws) {
        ws.close();
        return;
      }
      this.clearLocalAgentReconnect(agentId);
    });

    ws.on('message', (data: Buffer) => {
      if (this.localAgentWs.get(agentId) !== ws) return;
      this.routed.push(JSON.parse(data.toString()));
    });

    ws.on('close', () => {
      if (this.localAgentWs.get(agentId) !== ws) return;
      this.localAgentWs.delete(agentId);
      this.scheduleLocalAgentReconnect(agentId);
    });

    ws.on('error', () => {
      if (this.localAgentWs.get(agentId) !== ws) return;
    });

    return ws;
  }
}

describe('local agent websocket singleton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('reuses the same socket while the first connection is still connecting', () => {
    const created: MockWebSocket[] = [];
    const manager = new LocalAgentSocketManager(() => {
      const ws = new MockWebSocket();
      created.push(ws);
      return ws;
    });

    const first = manager.connectLocalAgent('claw');
    const second = manager.connectLocalAgent('claw');

    expect(first).toBe(second);
    expect(created).toHaveLength(1);
  });

  it('ignores messages from a stale socket that is no longer current', () => {
    const created: MockWebSocket[] = [];
    const manager = new LocalAgentSocketManager(() => {
      const ws = new MockWebSocket();
      created.push(ws);
      return ws;
    });

    const stale = manager.connectLocalAgent('claw')!;
    stale.readyState = MockWebSocket.CLOSED;
    const current = manager.connectLocalAgent('claw')!;
    current.open();

    stale.sendMessage({ type: 'content', data: { delta: 'stale' } });
    current.sendMessage({ type: 'content', data: { delta: 'current' } });

    expect(manager.routed).toEqual([
      { type: 'content', data: { delta: 'current' } },
    ]);
  });

  it('does not create a third socket when reconnect timer fires during an in-flight reconnect', () => {
    const created: MockWebSocket[] = [];
    const manager = new LocalAgentSocketManager(() => {
      const ws = new MockWebSocket();
      created.push(ws);
      return ws;
    });

    const first = manager.connectLocalAgent('claw')!;
    first.open();
    first.close();

    const second = manager.connectLocalAgent('claw');
    expect(second).toBe(created[1]);
    expect(created).toHaveLength(2);

    vi.advanceTimersByTime(3000);

    expect(created).toHaveLength(2);
    expect(manager.connectLocalAgent('claw')).toBe(second);
  });
});
