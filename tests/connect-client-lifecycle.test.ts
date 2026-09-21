import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const broker = vi.hoisted(() => ({ expected: false, fetch: vi.fn() }));
const sockets = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock('../src/auth/broker-token.js', () => ({
  brokerExpected: () => broker.expected,
  brokerPresent: () => broker.expected,
  fetchBrokerToken: broker.fetch,
}));

vi.mock('ws', () => ({
  default: class extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    close = vi.fn(() => { this.readyState = 2; });

    constructor(readonly url: string) {
      super();
      sockets.instances.push(this);
    }

    send(value: string): void { this.sent.push(value); }
  },
}));

import { ConnectClient } from '../src/connect-client/index.js';
import { ConnectChannel } from '../src/gateway/channels/connect.js';
import { RuntimeRollDrainLease } from '../src/shared/runtime-roll-drain.js';
import type { Inbox } from '../src/gateway/types.js';

type FakeSocket = EventEmitter & {
  readyState: number;
  url: string;
  sent: string[];
  close: ReturnType<typeof vi.fn>;
};

function socketAt(index: number): FakeSocket {
  return sockets.instances[index] as FakeSocket;
}

function openSocket(socket: FakeSocket): void {
  socket.readyState = 1;
  socket.emit('open');
}

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('ConnectClient lifecycle owns one connection', () => {
  const clients: ConnectClient[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.stubEnv('AGENT_ACCESS_TOKEN', '');
    broker.expected = false;
    broker.fetch.mockReset();
    sockets.instances.length = 0;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function client(config: ConstructorParameters<typeof ConnectClient>[0] = {}): ConnectClient {
    const instance = new ConnectClient({ wsUrl: 'ws://connect.example/agent/', token: 'initial-token', ...config });
    clients.push(instance);
    return instance;
  }

  it('repeated start is idempotent during connecting and after open', async () => {
    const instance = client();
    await Promise.all([instance.start(), instance.start()]);
    expect(sockets.instances).toHaveLength(1);
    openSocket(socketAt(0));
    await instance.start();
    expect(sockets.instances).toHaveLength(1);
  });

  it('the actual busy-drain expiry caller does not open an unfenced channel again', async () => {
    const channel = new ConnectChannel({ type: 'connect', url: 'ws://connect.example/agent/', token: 'initial-token' });
    const lease = new RuntimeRollDrainLease(() => channel.resumeRuntimeRollIngress());
    try {
      await channel.start({} as Inbox);
      openSocket(socketAt(0));
      for (const attempt of [1, 2, 3]) {
        lease.arm({ requestId: `busy-drain-${attempt}`, targetImage: 'same-image', leaseMs: 5_000 });
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(sockets.instances).toHaveLength(1);
      expect(socketAt(0).close).not.toHaveBeenCalled();
    } finally {
      lease.dispose();
      await channel.stop();
    }
  });

  it('repeated start shares the pending startup authentication', async () => {
    broker.expected = true;
    const pending = deferred<{ accessToken: string }>();
    broker.fetch.mockReturnValue(pending.promise);
    const instance = client({ token: '' });
    const initial = instance.start();
    const repeated = instance.start();
    expect(broker.fetch).toHaveBeenCalledTimes(1);
    pending.resolve({ accessToken: 'current-token' });
    await Promise.all([initial, repeated]);
    expect(sockets.instances).toHaveLength(1);
  });

  it('an onOpen callback that stops the client cannot leave a ping timer behind', async () => {
    const instance = client({ onOpen: () => instance.stop() });
    await instance.start();
    openSocket(socketAt(0));
    expect(vi.getTimerCount()).toBe(0);
    expect(instance.connected).toBe(false);
  });

  it('late events from a stopped socket cannot alter its successor', async () => {
    const onOpen = vi.fn();
    const instance = client({ onOpen });
    await instance.start();
    const retired = socketAt(0);
    instance.stop();
    await instance.start();
    const current = socketAt(1);
    openSocket(current);
    openSocket(retired);
    retired.emit('error', new Error('Unexpected server response: 502'));
    retired.emit('close', 4401);
    retired.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(instance.connected).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(sockets.instances).toHaveLength(2);
    expect(instance.sendTelemetry({ observation: 'current' })).toBe(true);
    expect(current.sent.map((value) => JSON.parse(value).type)).toEqual([
      'agent.processing_ack_capability', 'agent.telemetry',
    ]);
  });

  it('retires asynchronous startup authentication across stop and restart', async () => {
    broker.expected = true;
    const previous = deferred<{ accessToken: string }>();
    broker.fetch.mockReturnValueOnce(previous.promise).mockResolvedValueOnce({ accessToken: 'current-token' });
    const instance = client({ token: '' });
    const oldStart = instance.start();
    instance.stop();
    await instance.start();
    previous.resolve({ accessToken: 'retired-token' });
    await oldStart;
    expect(sockets.instances).toHaveLength(1);
    expect(new URL(socketAt(0).url).searchParams.get('token')).toBe('current-token');
    openSocket(socketAt(0));
    socketAt(0).emit('close', 1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(new URL(socketAt(1).url).searchParams.get('token')).toBe('current-token');
  });

  it('fences an already-fired reconnect authentication callback after a restart', async () => {
    broker.expected = true;
    const previous = deferred<{ accessToken: string }>();
    broker.fetch.mockReturnValueOnce(previous.promise).mockResolvedValueOnce({ accessToken: 'current-token' });
    const instance = client();
    await instance.start();
    openSocket(socketAt(0));
    socketAt(0).emit('close', 4401);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(broker.fetch).toHaveBeenCalledTimes(1);
    instance.stop();
    await instance.start();
    previous.resolve({ accessToken: 'retired-token' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.instances).toHaveLength(2);
    expect(new URL(socketAt(1).url).searchParams.get('token')).toBe('current-token');
  });

  it('retired password-response bodies cannot replace the successor token', async () => {
    vi.stubEnv('AGENT_USERNAME', 'test-agent');
    vi.stubEnv('AGENT_PASSWORD', 'test-password');
    vi.stubEnv('SHIZUHA_PLATFORM_URL', 'http://platform.example');
    const previous = deferred<{ access: string }>();
    const oldBody = vi.fn(() => previous.promise);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: oldBody })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access: 'current-token' }) }));
    try {
      const instance = client({ token: '' });
      const oldStart = instance.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(oldBody).toHaveBeenCalledOnce();
      instance.stop();
      await instance.start();
      previous.resolve({ access: 'retired-token' });
      await oldStart;
      expect(sockets.instances).toHaveLength(1);
      openSocket(socketAt(0));
      socketAt(0).emit('close', 1006);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(new URL(socketAt(1).url).searchParams.get('token')).toBe('current-token');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('only the current socket close arms a single reconnect timer', async () => {
    const instance = client();
    await instance.start();
    const retired = socketAt(0);
    openSocket(retired);
    retired.emit('close', 1006);
    retired.emit('close', 1006);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets.instances).toHaveLength(2);
    openSocket(socketAt(1));
    retired.emit('close', 1006);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(instance.connected).toBe(true);
    expect(sockets.instances).toHaveLength(2);
  });

  it('a stopped broker retry cannot reopen or rearm authentication', async () => {
    broker.expected = true;
    const pending = deferred<null>();
    broker.fetch.mockResolvedValueOnce(null).mockReturnValueOnce(pending.promise);
    const instance = client({ token: '' });
    await instance.start();
    await vi.advanceTimersByTimeAsync(1_000);
    instance.stop();
    pending.resolve(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.instances).toHaveLength(0);
    expect(broker.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
