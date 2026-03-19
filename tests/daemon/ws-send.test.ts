import { describe, expect, it } from 'vitest';

import { sendJsonOverSocket, type JsonWritableSocket } from '../../src/daemon/ws-send.js';

class MockSocket implements JsonWritableSocket {
  sent: string[] = [];

  constructor(private readonly error?: Error) {}

  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.(this.error);
  }
}

describe('sendJsonOverSocket', () => {
  it('resolves only after the websocket write callback succeeds', async () => {
    const ws = new MockSocket();

    await expect(sendJsonOverSocket(ws, { type: 'message', content: 'hello' })).resolves.toBeUndefined();
    expect(ws.sent).toEqual([
      JSON.stringify({ type: 'message', content: 'hello' }),
    ]);
  });

  it('rejects when the websocket write callback reports an error', async () => {
    const ws = new MockSocket(new Error('write failed'));

    await expect(sendJsonOverSocket(ws, { type: 'message', content: 'hello' })).rejects.toThrow('write failed');
    expect(ws.sent).toEqual([
      JSON.stringify({ type: 'message', content: 'hello' }),
    ]);
  });
});
