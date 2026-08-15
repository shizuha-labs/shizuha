import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeConnectClientMessageId,
  sendConnectDm,
} from '../../src/platform/connect-dm.js';

describe('Connect DM client message IDs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves valid UUIDs and deterministically normalizes readable idempotency keys', () => {
    const valid = '6b7ec86f-c66f-44cb-a93d-22c55a832735';
    expect(normalizeConnectClientMessageId(valid)).toBe(valid);

    const readable = 'scli-195-Kumo-1784210762153';
    const normalized = normalizeConnectClientMessageId(readable);
    expect(normalized).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(normalizeConnectClientMessageId(readable)).toBe(normalized);
  });

  it('sends only a valid UUID to Connect when a caller supplies a readable key', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message_id: 'message-1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendConnectDm({
      recipientUsername: 'ryo',
      content: 'guard tripped',
      clientMessageId: 'scli-195-Kumo-1784210762153',
      platformUrl: 'https://connect.example.test',
      token: 'test-token',
    });

    expect(result.ok).toBe(true);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.client_message_id).toBe(normalizeConnectClientMessageId('scli-195-Kumo-1784210762153'));
  });
});
