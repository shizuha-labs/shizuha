import { beforeEach, describe, expect, it } from 'vitest';

class MockWebSocket {
  static readonly OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  get parsed(): Record<string, unknown>[] {
    return this.sent.map((entry) => JSON.parse(entry));
  }
}

interface BrowserClient {
  ws: MockWebSocket;
  agentId: string | null;
}

class StatusBridge {
  clients = new Map<string, BrowserClient>();
  agentSubscribers = new Map<string, Set<string>>();
  lastStatusByScope = new Map<string, boolean>();

  addClient(clientId: string, ws: MockWebSocket): void {
    this.clients.set(clientId, { ws, agentId: null });
  }

  subscribe(clientId: string, agentId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (client.agentId && client.agentId !== agentId) {
      this.agentSubscribers.get(client.agentId)?.delete(clientId);
    }
    client.agentId = agentId;
    let subs = this.agentSubscribers.get(agentId);
    if (!subs) {
      subs = new Set();
      this.agentSubscribers.set(agentId, subs);
    }
    subs.add(clientId);
  }

  private statusScopeKey(type: string, agentId?: string | null): string {
    return type === 'agent_status' && agentId ? `agent:${agentId}` : 'global';
  }

  private normalizeStatusEvent(
    msg: Record<string, unknown>,
    agentId?: string | null,
  ): Record<string, unknown> | null {
    const rawType = msg.type as string;
    if (rawType !== 'transport_status' && rawType !== 'agent_status') {
      return msg;
    }

    const connected = msg.connected;
    if (typeof connected !== 'boolean') return msg;

    const normalizedType = rawType;
    const scopedAgentId = normalizedType === 'agent_status'
      ? agentId ?? (msg.agent_id as string | undefined)
      : undefined;
    if (normalizedType === 'agent_status' && !scopedAgentId) return null;

    const scopeKey = this.statusScopeKey(normalizedType, scopedAgentId);
    if (this.lastStatusByScope.get(scopeKey) === connected) return null;
    this.lastStatusByScope.set(scopeKey, connected);

    const normalized: Record<string, unknown> = {
      ...msg,
      type: normalizedType,
      connected,
    };
    if (normalizedType === 'agent_status') {
      normalized.agent_id = scopedAgentId;
    } else if ('agent_id' in normalized) {
      delete normalized.agent_id;
    }
    return normalized;
  }

  emitTransportStatus(connected: boolean): void {
    const msg = this.normalizeStatusEvent({ type: 'transport_status', connected });
    if (!msg) return;
    for (const cid of this.clients.keys()) this.sendToClient(cid, msg);
  }

  emitAgentStatus(agentId: string, connected: boolean): void {
    const msg = this.normalizeStatusEvent({ type: 'agent_status', agent_id: agentId, connected }, agentId);
    if (!msg) return;
    const subs = this.agentSubscribers.get(agentId);
    if (!subs) return;
    for (const cid of subs) this.sendToClient(cid, msg);
  }

  routeFromUpstream(msg: Record<string, unknown>): void {
    let agentId = (msg.agent_id as string)
      ?? ((msg.data as Record<string, unknown> | undefined)?.entity_id as string | undefined);

    const normalized = this.normalizeStatusEvent(msg, agentId);
    if (!normalized) return;
    msg = normalized;
    agentId = (msg.agent_id as string)
      ?? ((msg.data as Record<string, unknown> | undefined)?.entity_id as string | undefined);

    if (agentId) {
      const subs = this.agentSubscribers.get(agentId);
      if (!subs) return;
      for (const cid of subs) this.sendToClient(cid, msg);
      return;
    }

    for (const cid of this.clients.keys()) this.sendToClient(cid, msg);
  }

  private sendToClient(clientId: string, msg: Record<string, unknown>): void {
    const ws = this.clients.get(clientId)?.ws;
    if (ws?.readyState === MockWebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

describe('status routing and suppression', () => {
  let bridge: StatusBridge;
  let clawViewer: MockWebSocket;
  let kaiViewer: MockWebSocket;

  beforeEach(() => {
    bridge = new StatusBridge();
    clawViewer = new MockWebSocket();
    kaiViewer = new MockWebSocket();
    bridge.addClient('claw-viewer', clawViewer);
    bridge.addClient('kai-viewer', kaiViewer);
    bridge.subscribe('claw-viewer', 'claw');
    bridge.subscribe('kai-viewer', 'kai');
  });

  it('agent-scopes daemon status events and suppresses identical repeats', () => {
    bridge.emitAgentStatus('claw', true);
    bridge.emitAgentStatus('claw', true);
    bridge.emitAgentStatus('claw', false);

    expect(clawViewer.parsed).toEqual([
      { type: 'agent_status', agent_id: 'claw', connected: true },
      { type: 'agent_status', agent_id: 'claw', connected: false },
    ]);
    expect(kaiViewer.parsed).toEqual([]);
  });

  it('deduplicates explicit upstream agent_status against daemon agent_status in the same scope', () => {
    bridge.emitAgentStatus('claw', true);
    bridge.routeFromUpstream({ type: 'agent_status', agent_id: 'claw', connected: true });
    bridge.routeFromUpstream({ type: 'agent_status', agent_id: 'claw', connected: false });

    expect(clawViewer.parsed).toEqual([
      { type: 'agent_status', agent_id: 'claw', connected: true },
      { type: 'agent_status', agent_id: 'claw', connected: false },
    ]);
  });

  it('broadcasts transport_status separately from agent_status', () => {
    bridge.emitTransportStatus(true);
    bridge.emitTransportStatus(true);
    bridge.routeFromUpstream({ type: 'transport_status', connected: false });

    expect(clawViewer.parsed).toEqual([
      { type: 'transport_status', connected: true },
      { type: 'transport_status', connected: false },
    ]);
    expect(kaiViewer.parsed).toEqual([
      { type: 'transport_status', connected: true },
      { type: 'transport_status', connected: false },
    ]);
  });
});
