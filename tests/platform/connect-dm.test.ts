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

  it('posts an in-thread reply when conversationId is set', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/connect/api/conversations/conv-abc/messages/');
      return {
        ok: true,
        status: 201,
        headers: { get: () => null },
        text: async () => JSON.stringify({ id: 'm2', content: 'looking at AT-91 now' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendConnectDm({
      conversationId: 'conv-abc',
      recipientEmail: 'hothritik1@gmail.com',
      content: 'looking at AT-91 now',
      platformUrl: 'https://connect.example.test',
      token: 'test-token',
    });

    expect(result.ok).toBe(true);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toEqual({
      content: 'looking at AT-91 now',
      client_message_id: expect.any(String),
    });
    expect(body.recipient_email).toBeUndefined();
  });
});

describe('isAckOnlyMessage', () => {
  it('rejects the forged voice-prompt pong token and keeps real replies', async () => {
    const { isAckOnlyMessage } = await import('../../src/tools/builtin/message-user.js');
    expect(isAckOnlyMessage('pong')).toBe(true);
    expect(isAckOnlyMessage('Pong.')).toBe(true);
    expect(isAckOnlyMessage('pong sent')).toBe(true);
    expect(isAckOnlyMessage('Replied.')).toBe(true);
    expect(isAckOnlyMessage('Test message')).toBe(true);
    expect(isAckOnlyMessage('Test message — please confirm you can see this.')).toBe(true);
    expect(isAckOnlyMessage("I'm stuck in a loop. Let me break out of it.")).toBe(true);
    expect(isAckOnlyMessage("I'm here — what would you like me to do?")).toBe(true);
    expect(isAckOnlyMessage('CON-98 pong')).toBe(false);
    expect(isAckOnlyMessage('looking at AT-91 now')).toBe(false);
    expect(isAckOnlyMessage("I'm stuck in a loop on CTX-528 GPU folio hang")).toBe(false);
  });
});
