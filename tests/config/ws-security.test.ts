/**
 * PLAT-4652 — ws security regressions.
 *
 * Exercises the public WebSocket client/server boundary for:
 * - GHSA-58qx-3vcg-4xpx: TypedArray close reasons must not expose bytes
 *   outside the initialized view.
 * - GHSA-96hv-2xvq-fx4p: tiny message fragments and socket chunks must be
 *   bounded and terminate with policy code 1008.
 */
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);

async function listen(server: WebSocketServer): Promise<number> {
  if (server.address()) return (server.address() as { port: number }).port;
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function close(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function open(client: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
}

async function closeEvent(client: WebSocket): Promise<[number, Buffer]> {
  return await new Promise<[number, Buffer]>((resolve, reject) => {
    client.once('close', (code, reason) => resolve([code, reason]));
    client.once('error', reject);
  });
}

describe('ws security regression (PLAT-4652)', () => {
  it('sends only the initialized Uint8Array close-reason view', async () => {
    const server = new WebSocketServer({ port: 0 });
    const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}`);

    server.once('connection', (peer) => {
      const backing = Buffer.alloc(12, 0x73);
      backing.set(Buffer.from('ok!'), 4);
      const reason = new Uint8Array(backing.buffer, backing.byteOffset + 4, 3);
      peer.close(1000, reason);
    });

    try {
      const [code, reason] = await closeEvent(client);
      expect(code).toBe(1000);
      expect(reason).toEqual(Buffer.from('ok!'));
      expect(reason).toHaveLength(3);
    } finally {
      client.terminate();
      await close(server);
    }
  });

  it('terminates a peer that exceeds the configured fragment bound', async () => {
    const server = new WebSocketServer({ port: 0, maxFragments: 2 });
    const port = await listen(server);
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    server.on('connection', (peer) => peer.on('error', () => undefined));

    try {
      await open(client);
      const closed = closeEvent(client);
      client.send(Buffer.from('a'), { fin: false });
      client.send(Buffer.from('b'), { fin: false });
      client.send(Buffer.from('c'), { fin: false });
      const [code] = await closed;
      expect(code).toBe(1008);
    } finally {
      client.terminate();
      await close(server);
    }
  });

  it('bounds retained receiver chunks for a partial tiny-frame payload', async () => {
    // This is the upstream receiver boundary that holds socket data chunks.
    // The public WebSocketServer path above separately proves the resulting
    // policy-close behavior for excessive message fragments.
    const wsRoot = dirname(require.resolve('ws'));
    const Receiver = require(join(wsRoot, 'lib/receiver.js')) as new (options: {
      maxBufferedChunks: number;
    }) => Writable;
    const receiver = new Receiver({ maxBufferedChunks: 2 });
    const error = once(receiver, 'error') as Promise<
      [Error & { code?: string }]
    >;

    receiver.write(Buffer.from([0x82, 0x05]));
    receiver.write(Buffer.from([0x61]));
    receiver.write(Buffer.from([0x62]));
    receiver.write(Buffer.from([0x63]));

    const [failure] = await error;
    expect(failure).toBeInstanceOf(RangeError);
    expect(failure.code).toBe('WS_ERR_TOO_MANY_BUFFERED_PARTS');
    expect(failure.message).toBe('Too many buffered chunks');
  });
});
