/**
 * Tests for the ChatbotBridge — verifies agent_id-based routing
 * so events for Agent A never leak to clients chatting with Agent B.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Minimal WS mock ──

class MockWebSocket {
  readyState = 1; // OPEN
  sent: string[] = [];
  handlers = new Map<string, Function[]>();

  send(data: string) { this.sent.push(data); }

  on(event: string, handler: Function) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  close() { this.readyState = 3; }

  simulateClose() {
    for (const handler of this.handlers.get('close') ?? []) handler();
  }

  get parsed(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s));
  }

  clear() { this.sent = []; }
}

// ── Extracted bridge routing logic (mirrors dashboard.ts ChatbotBridge) ──

interface BrowserClient {
  ws: MockWebSocket;
  agentId: string | null;
}

class TestBridge {
  clients = new Map<string, BrowserClient>();
  agentSubscribers = new Map<string, Set<string>>();

  addClient(clientId: string, ws: MockWebSocket) {
    this.clients.set(clientId, { ws, agentId: null });
    ws.on('close', () => {
      const client = this.clients.get(clientId);
      if (client?.agentId) {
        this.agentSubscribers.get(client.agentId)?.delete(clientId);
      }
      this.clients.delete(clientId);
    });
  }

  subscribe(clientId: string, agentId: string) {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (client.agentId && client.agentId !== agentId) {
      this.agentSubscribers.get(client.agentId)?.delete(clientId);
    }
    client.agentId = agentId;
    let subs = this.agentSubscribers.get(agentId);
    if (!subs) { subs = new Set(); this.agentSubscribers.set(agentId, subs); }
    subs.add(clientId);
  }

  routeFromPlatform(msg: Record<string, unknown>) {
    const agentId = (msg.agent_id as string)
      ?? (msg.data as Record<string, unknown> | undefined)?.entity_id as string | undefined;

    if (agentId) {
      const subs = this.agentSubscribers.get(agentId);
      if (subs) {
        for (const cid of subs) this.sendToClient(cid, msg);
        return;
      }
    }
    // No agent_id → broadcast
    for (const cid of this.clients.keys()) this.sendToClient(cid, msg);
  }

  private sendToClient(clientId: string, msg: Record<string, unknown>) {
    const client = this.clients.get(clientId);
    if (client?.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }
}

// ── Frontend filter (defense-in-depth, mirrors useChat.ts) ──

function shouldProcess(msg: Record<string, unknown>, currentAgentId: string | null): boolean {
  const msgAgentId = msg.agent_id as string | undefined;
  if (msgAgentId && currentAgentId && msgAgentId !== currentAgentId) return false;
  return true;
}

// ── Tests ──

const SORA = 'agent-sora-uuid';
const YUKI = 'agent-yuki-uuid';

describe('ChatbotBridge agent_id routing', () => {
  let bridge: TestBridge;
  let wsA: MockWebSocket;
  let wsB: MockWebSocket;

  beforeEach(() => {
    bridge = new TestBridge();
    wsA = new MockWebSocket();
    wsB = new MockWebSocket();
    bridge.addClient('a', wsA);
    bridge.addClient('b', wsB);
  });

  it('routes events only to the client subscribed to that agent', () => {
    bridge.subscribe('a', SORA);
    bridge.subscribe('b', YUKI);

    bridge.routeFromPlatform({ type: 'content', agent_id: SORA, data: { delta: 'hi' } });

    expect(wsA.parsed).toHaveLength(1);
    expect(wsA.parsed[0]!.agent_id).toBe(SORA);
    expect(wsB.parsed).toHaveLength(0);
  });

  it('isolates two agents completely', () => {
    bridge.subscribe('a', SORA);
    bridge.subscribe('b', YUKI);

    bridge.routeFromPlatform({ type: 'content', agent_id: SORA, data: { delta: 'from sora' } });
    bridge.routeFromPlatform({ type: 'content', agent_id: YUKI, data: { delta: 'from yuki' } });

    expect(wsA.parsed).toHaveLength(1);
    expect(wsA.parsed[0]!.agent_id).toBe(SORA);
    expect(wsB.parsed).toHaveLength(1);
    expect(wsB.parsed[0]!.agent_id).toBe(YUKI);
  });

  it('broadcasts events without agent_id to all clients', () => {
    bridge.subscribe('a', SORA);
    bridge.subscribe('b', YUKI);

    bridge.routeFromPlatform({ type: 'agents_updated' });

    expect(wsA.parsed).toHaveLength(1);
    expect(wsB.parsed).toHaveLength(1);
  });

  it('resolves agent_id from data.entity_id for presence events', () => {
    bridge.subscribe('a', SORA);
    bridge.subscribe('b', YUKI);

    bridge.routeFromPlatform({
      type: 'presence',
      data: { entity_type: 'agent', entity_id: SORA, status: 'busy' },
    });

    expect(wsA.parsed).toHaveLength(1);
    expect(wsB.parsed).toHaveLength(0); // Yuki's client does NOT see Sora's presence
  });

  it('unsubscribes from previous agent when switching', () => {
    bridge.subscribe('a', SORA);

    // Client A switches to Yuki
    bridge.subscribe('a', YUKI);

    bridge.routeFromPlatform({ type: 'content', agent_id: SORA, data: { delta: 'late' } });
    expect(wsA.parsed).toHaveLength(0); // No longer subscribed to Sora

    bridge.routeFromPlatform({ type: 'content', agent_id: YUKI, data: { delta: 'hello' } });
    expect(wsA.parsed).toHaveLength(1);
  });

  it('cleans up subscriptions on disconnect', () => {
    bridge.subscribe('a', SORA);
    wsA.simulateClose();

    bridge.routeFromPlatform({ type: 'content', agent_id: SORA, data: { delta: 'orphan' } });
    // No crash, no delivery to dead socket
    expect(wsA.sent).toHaveLength(0);
  });

  it('supports multiple clients watching the same agent', () => {
    bridge.subscribe('a', SORA);
    bridge.subscribe('b', SORA);

    bridge.routeFromPlatform({ type: 'content', agent_id: SORA, data: { delta: 'hi both' } });

    expect(wsA.parsed).toHaveLength(1);
    expect(wsB.parsed).toHaveLength(1);
  });

  it('events for unsubscribed agents fall through to broadcast', () => {
    bridge.subscribe('a', SORA);

    // Event for an agent nobody is subscribed to — frontend filter catches it
    bridge.routeFromPlatform({ type: 'content', agent_id: 'unknown-agent', data: {} });

    // Bridge has no subscriber set for unknown-agent, so it broadcasts.
    // The frontend's defense-in-depth filter (shouldProcess) would reject it
    // since client A is viewing SORA, not unknown-agent.
    expect(wsA.parsed).toHaveLength(1); // bridge broadcasts
    expect(shouldProcess(wsA.parsed[0]!, SORA)).toBe(false); // but frontend rejects
  });
});

describe('Frontend agent_id filter (defense-in-depth)', () => {
  it('accepts events for current agent', () => {
    expect(shouldProcess({ type: 'content', agent_id: SORA }, SORA)).toBe(true);
  });

  it('rejects events for different agent', () => {
    expect(shouldProcess({ type: 'content', agent_id: YUKI }, SORA)).toBe(false);
  });

  it('accepts global events (no agent_id)', () => {
    expect(shouldProcess({ type: 'transport_status', connected: true }, SORA)).toBe(true);
  });

  it('accepts all events when no agent selected', () => {
    expect(shouldProcess({ type: 'content', agent_id: YUKI }, null)).toBe(true);
  });

  it('full contamination scenario: all Sora events rejected when viewing Yuki', () => {
    const soraEvents = [
      { type: 'content', agent_id: SORA, data: { delta: 'thinking...' } },
      { type: 'tool_start', agent_id: SORA, data: { tool: 'read' } },
      { type: 'tool_complete', agent_id: SORA, data: { tool: 'read' } },
      { type: 'complete', agent_id: SORA, data: {} },
    ];
    for (const evt of soraEvents) {
      expect(shouldProcess(evt, YUKI)).toBe(false);
    }
  });
});
