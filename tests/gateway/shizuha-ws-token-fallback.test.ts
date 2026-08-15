import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wsInstances: FakeWebSocket[] = [];

class FakeWebSocket {
  static OPEN = 1;

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  constructor(readonly url: string) {
    wsInstances.push(this);
  }

  on(event: string, handler: (...args: any[]) => void): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(event: string, ...args: any[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }));

const { ShizuhaWSChannel } = await import('../../src/gateway/channels/shizuha-ws.js');

function writeCachedAgentToken(home: string, accessToken: string): void {
  const authDir = path.join(home, '.shizuha', 'auth');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'token-mika.json'), JSON.stringify({
    accessToken,
    refreshToken: 'refresh-token',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    userId: 1,
    email: 'mika@agents.shizuha.io',
    organizationId: 1,
    obtainedAt: new Date().toISOString(),
  }));
}

function makeChannel(token: string): InstanceType<typeof ShizuhaWSChannel> {
  return new ShizuhaWSChannel({
    type: 'shizuha-ws',
    url: 'ws://connect.example/ws/runner/',
    token,
    agentId: 'agent-mika',
    reconnect: true,
  });
}

describe('ShizuhaWSChannel agent-token fallback', () => {
  beforeEach(() => {
    wsInstances.length = 0;
    process.env['AGENT_USERNAME'] = 'mika';
    process.env['SHIZUHA_PLATFORM_URL'] = 'https://shizuha.com';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-163-'));
    process.env['HOME'] = home;
    writeCachedAgentToken(home, 'agent-token-from-cache');
  });

  it('uses a provided broker token first so working broker sessions are unaffected', async () => {
    const channel = makeChannel('broker-token');

    await channel.start([] as any);
    expect(wsInstances).toHaveLength(1);
    expect(wsInstances[0].url).toContain('token=broker-token');

    wsInstances[0].emit('open');
    expect(JSON.parse(wsInstances[0].sent[0])).toMatchObject({
      type: 'auth',
      token: 'broker-token',
    });
  });

  it('falls back to AgentTokenManager when the broker token is absent', async () => {
    const channel = makeChannel('');

    await channel.start([] as any);
    await vi.waitFor(() => expect(wsInstances).toHaveLength(1));
    expect(wsInstances[0].url).toContain('token=agent-token-from-cache');
  });

  it('retries once with AgentTokenManager when the broker WebSocket handshake is rejected', async () => {
    const channel = makeChannel('broker-token');

    await channel.start([] as any);
    expect(wsInstances[0].url).toContain('token=broker-token');

    wsInstances[0].emit('error', new Error('Unexpected server response: 403'));
    wsInstances[0].emit('close', 1006, Buffer.from(''));

    await vi.waitFor(() => expect(wsInstances).toHaveLength(2));
    expect(wsInstances[1].url).toContain('token=agent-token-from-cache');
  });

  it('does not schedule a duplicate reconnect when auth_error fallback wins before old close', async () => {
    const channel = makeChannel('broker-token');

    await channel.start([] as any);
    expect(wsInstances[0].url).toContain('token=broker-token');

    wsInstances[0].emit('message', Buffer.from(JSON.stringify({
      type: 'auth_error',
      message: '401 broker token rejected',
    })));

    await vi.waitFor(() => expect(wsInstances).toHaveLength(2));
    expect(wsInstances[1].url).toContain('token=agent-token-from-cache');

    wsInstances[0].emit('close', 1006, Buffer.from(''));

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(wsInstances).toHaveLength(2);
  });
});
