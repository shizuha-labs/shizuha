import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

import {
  ConnectClient,
  classifyConnectNonMessageEvent,
  classifyConnectReplyObligation,
  classifyConnectTurnSuppression,
  connectSocketUrl,
  parseConnectInboundMessageEvent,
  shouldAcceptMissedMessageReplay,
} from '../src/connect-client/index.js';
import { metricsRegistry } from '../src/metrics/registry.js';

function jwtWithExp(exp: number): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ exp })}.sig`;
}

describe('ConnectClient authentication', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('falls back when daemon-provisioned AGENT_ACCESS_TOKEN is expired', async () => {
    const access = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    process.env['AGENT_ACCESS_TOKEN'] = jwtWithExp(Math.floor(Date.now() / 1000) - 60);
    process.env['AGENT_USERNAME'] = 'ni';
    process.env['AGENT_PASSWORD'] = 'password';
    process.env['SHIZUHA_PLATFORM_URL'] = 'http://platform.example';
    delete process.env['MCP_AUTH_PROXY_SOCKET'];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ access }),
    })));

    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws' });
    await (client as unknown as { selfAuthenticate: () => Promise<void> }).selfAuthenticate();

    expect((client as unknown as { token: string }).token).toBe(access);
  });

  it('uses daemon-provisioned AGENT_ACCESS_TOKEN before password login', async () => {
    process.env['AGENT_ACCESS_TOKEN'] = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    process.env['AGENT_USERNAME'] = 'ni';
    process.env['AGENT_PASSWORD'] = 'password-that-must-not-be-used';
    process.env['SHIZUHA_PLATFORM_URL'] = 'http://platform.example';
    delete process.env['MCP_AUTH_PROXY_SOCKET'];

    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws' });
    await (client as unknown as { selfAuthenticate: () => Promise<void> }).selfAuthenticate();

    expect((client as unknown as { token: string }).token).toBe(process.env['AGENT_ACCESS_TOKEN']);
  });
});

describe('ConnectClient processing acknowledgement', () => {
  it('advertises the contract in the opening handshake before replay starts', () => {
    expect(connectSocketUrl('wss://connect.example/ws?source=agent', 'token+/='))
      .toBe('wss://connect.example/ws?source=agent&token=token%2B%2F%3D&processing_ack=1');
  });

  it('sends a distinct processing ack rather than treating socket delivery as completion', () => {
    const send = vi.fn();
    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws', token: 'token' }) as any;
    client.ws = { readyState: 1, send, close: vi.fn() };

    expect(client.ackMessageProcessed('message-1')).toBe(true);
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: 'agent.message_processed',
      message_id: 'message-1',
    }));
  });
});

// SCLI-201: the per-agent shizuha-id login fallback (used when broker /token is
// unavailable) must back off on 429 and honor Retry-After — never a self-inflicted
// rate-limit loop / same-error-streak.
describe('ConnectClient id-login 429 backoff (SCLI-201)', () => {
  const originalEnv = { ...process.env };

  function loginFallbackEnv(): void {
    delete process.env['AGENT_ACCESS_TOKEN'];
    delete process.env['MCP_AUTH_PROXY_SOCKET'];
    delete process.env['MCP_AUTH_PROXY_COORDINATOR_URL'];
    process.env['AGENT_USERNAME'] = 'nova';
    process.env['AGENT_PASSWORD'] = 'canon-pw';
    process.env['SHIZUHA_PLATFORM_URL'] = 'http://platform.example';
  }

  const resp429 = (retryAfter?: string) => ({
    ok: false,
    status: 429,
    headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
    json: async () => ({}),
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('honors Retry-After and sets a rate-limit window on a 429 (no token, one fail-loud)', async () => {
    loginFallbackEnv();
    const fetchSpy = vi.fn(async () => resp429('60'));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws' }) as any;
    const before = Date.now();
    await client.selfAuthenticate();

    expect(client.token).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(client.authFailureStreak).toBe(1);
    // Retry-After: 60 → window ~ now + 60s (>= the min floor).
    expect(client.authRateLimitedUntil).toBeGreaterThanOrEqual(before + 59_000);
  });

  it('does NOT hit /auth/login while inside the rate-limit window (login skipped)', async () => {
    loginFallbackEnv();
    const fetchSpy = vi.fn(async () => resp429('60'));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws' }) as any;
    client.authRateLimitedUntil = Date.now() + 60_000; // already rate-limited

    await client.selfAuthenticate();
    expect(fetchSpy).not.toHaveBeenCalled(); // must back off, not hammer
  });

  it('floors the backoff to LOGIN_429_MIN_BACKOFF when Retry-After is absent', async () => {
    loginFallbackEnv();
    vi.stubGlobal('fetch', vi.fn(async () => resp429(undefined)));

    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws' }) as any;
    const before = Date.now();
    await client.selfAuthenticate();
    // No header → at least the 30s min floor.
    expect(client.authRateLimitedUntil).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('recovers: a successful login after backoff clears the streak + window', async () => {
    loginFallbackEnv();
    const access = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tokens: { access } }) })));

    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws' }) as any;
    client.authFailureStreak = 3;      // simulate a prior 429 streak
    client.authRateLimitedUntil = 0;   // window already cleared

    await client.selfAuthenticate();
    expect(client.token).toBe(access);
    expect(client.authFailureStreak).toBe(0);
    expect(client.authRateLimitedUntil).toBe(0);
  });

  it('scheduleAuthRetry waits out the 429 window even beyond the normal backoff cap', () => {
    loginFallbackEnv();
    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws' }) as any;
    client.running = true;
    client.authRateLimitedUntil = Date.now() + 120_000; // 120s > RECONNECT_MAX_MS (30s)

    let scheduledDelay = -1;
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((_fn: any, ms?: number) => {
      scheduledDelay = ms ?? 0;
      return 0 as any;
    }) as any);

    client.scheduleAuthRetry();
    setTimeoutSpy.mockRestore();
    // Honors the ~120s window (jitter floor 0.75×), not the 30s cap.
    expect(scheduledDelay).toBeGreaterThanOrEqual(90_000);
  });
});

// SCLI-220: Connect auth failures can arrive as WebSocket close codes (4401)
// after the socket opened. Those must keep exponential backoff and force a fresh
// token instead of resetting to a 1s reconnect loop.
describe('ConnectClient auth-close reconnect backoff (SCLI-220)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureScheduledDelay(): { getDelay: () => number } {
    let scheduledDelay = -1;
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // exact jitter multiplier: 1.0
    vi.spyOn(global, 'setTimeout').mockImplementation(((_fn: any, ms?: number) => {
      scheduledDelay = ms ?? 0;
      return 0 as any;
    }) as any);
    return { getDelay: () => scheduledDelay };
  }

  it('preserves reconnect attempt and forces token refresh on a stable 4401 close', () => {
    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws', token: 'stale-token' }) as any;
    client.running = true;
    client.connectedAt = Date.now() - 31_000; // normally stable enough to reset
    client.reconnectAttempt = 2;
    client.forceTokenRefresh = false;
    const scheduled = captureScheduledDelay();

    client.handleSocketClose(4401);

    expect(client.forceTokenRefresh).toBe(true);
    expect(client.token).toBe('');
    expect(client.reconnectAttempt).toBe(3);
    expect(scheduled.getDelay()).toBe(4_000);
  });

  it('still resets reconnect attempt after a stable non-auth close', () => {
    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws', token: 'valid-token' }) as any;
    client.running = true;
    client.connectedAt = Date.now() - 31_000;
    client.reconnectAttempt = 2;
    client.forceTokenRefresh = false;
    const scheduled = captureScheduledDelay();

    client.handleSocketClose(1006);

    expect(client.forceTokenRefresh).toBe(false);
    expect(client.token).toBe('valid-token');
    expect(client.reconnectAttempt).toBe(1);
    expect(scheduled.getDelay()).toBe(1_000);
  });

  it('caps auth-refresh reconnect backoff at five minutes, not the normal 30s cap', () => {
    const client = new ConnectClient({ wsUrl: 'ws://connect.example/ws', token: 'stale-token' }) as any;
    client.running = true;
    client.forceTokenRefresh = true;
    client.reconnectAttempt = 20;
    const scheduled = captureScheduledDelay();

    client.scheduleReconnect();

    expect(scheduled.getDelay()).toBe(5 * 60_000);
  });
});


describe('parseConnectInboundMessageEvent', () => {
  it('parses missed_message replay frames using message.conversation_id', () => {
    const parsed = parseConnectInboundMessageEvent({
      type: 'missed_message',
      message: {
        id: 'msg-1',
        conversation_id: 'conv-1',
        content: 'please reply exactly `pong`',
        sender_id: 14,
        sender_username: 'ryo',
        sender_name: 'Ryo',
        created_at: '2026-07-01T07:00:00Z',
        conversation_type: 'direct',
        sender_same_org: true,
      },
    }, '');

    expect(parsed).toEqual({
      conversationId: 'conv-1',
      content: '[ryo] please reply exactly `pong`',
      senderId: '14',
      senderName: 'ryo',
      messageId: 'msg-1',
      createdAt: '2026-07-01T07:00:00Z',
      conversationType: 'direct',
      senderSameOrg: true,
    });
  });

  it('parses live new_message frames using top-level conversation_id', () => {
    const parsed = parseConnectInboundMessageEvent({
      type: 'new_message',
      conversation_id: 'conv-live',
      message: {
        id: 'msg-2',
        content: 'hello',
        sender_id: 88,
        sender_email: 'ichi@shizuha.com',
        sender_name: 'Ichi',
      },
    });

    expect(parsed?.conversationId).toBe('conv-live');
    expect(parsed?.content).toBe('[ichi] hello');
    expect(parsed?.senderName).toBe('ichi');
    expect(parsed?.conversationType).toBe('unknown');
    expect(parsed?.senderSameOrg).toBe('unknown');
  });

  it('drops self echoes before starting an agent turn', () => {
    const parsed = parseConnectInboundMessageEvent({
      type: 'missed_message',
      message: {
        id: 'self-msg',
        conversation_id: 'conv-1',
        content: 'my own outbound',
        sender_id: 14,
        sender_username: 'ryo',
      },
    }, '14');

    expect(parsed).toBeNull();
  });
});

describe('Connect ingress turn suppression (CON-223)', () => {
  it.each([
    ['[shizuha] Please inspect the logs.', 'required'],
    ['[shizuha] Is this done?', 'required'],
    ['[shizuha] Can you review this? Details below.', 'required'],
    ['[shizuha] Is this done? Thanks.', 'required'],
    ['[shizuha] Is this done?\nThanks.', 'required'],
    ['[shizuha] reply exactly `pong`', 'required'],
    ['[shizuha] Deployment is green.', 'optional'],
    ['[shizuha] Confirmed. PR #317 is with Revi; no further action.', 'optional'],
  ])('classifies reply obligation for %s', (content, obligation) => {
    expect(classifyConnectReplyObligation(content)).toBe(obligation);
  });
  it.each([
    ['[mio] Acknowledged.', 'ack_only'],
    ['[mio] Thanks', 'ack_only'],
    ['[mio] Closed', 'ack_only'],
    ['[mio] Understood.', 'ack_only'],
    ['[mio] Noted; no further action.', 'ack_only'],
    ['[aoi] No change.', 'ack_only'],
    ['[aoi] No gate-state change', 'ack_only'],
    ['[aoi] Response path ended.', 'ack_only'],
    ['[aoi] Stopped', 'ack_only'],
    ['[aoi] Loop ended.', 'ack_only'],
    ['[aoi] \u200B\u2063', 'ack_only'],
    ['\u200B\u2063', 'ack_only'],
    ['[san] no reply needed', 'no_reply_requested'],
    ['[san] Bridge-mandated reply only; CON-222 tracks this loop.', 'no_reply_requested'],
    ['[san] 👍', 'reaction_only'],
    ['[san] ✅ 🙏', 'reaction_only'],
    ['[san] thread closed', 'thread_close'],
  ])('suppresses %s as %s', (content, reason) => {
    expect(classifyConnectTurnSuppression(content)).toBe(reason);
  });

  it.each([
    '[mio] Thanks, please deploy the reviewed fix.',
    '[san] Acknowledged. New blocker: the health endpoint is 503.',
    '[kai] Closed the old PR; please review the replacement.',
    '[mio] 👍 Please continue with HIVE-708.',
    '[mio] Is this done?',
    '[aoi] No change: PR head advanced; please re-review.',
    '[aoi] No gate-state change because the validator returned 500; investigate.',
    '[aoi] \u200BPlease investigate the changed gate.\u2063',
  ])('delivers mixed or actionable text: %s', (content) => {
    expect(classifyConnectTurnSuppression(content)).toBeNull();
  });

  it('classifies reaction and terminal thread events before message parsing', () => {
    expect(classifyConnectNonMessageEvent('reaction_added')).toBe('reaction_only');
    expect(classifyConnectNonMessageEvent('reaction_removed')).toBe('reaction_only');
    expect(classifyConnectNonMessageEvent('reaction')).toBe('reaction_only');
    expect(classifyConnectNonMessageEvent('message_reaction')).toBe('reaction_only');
    expect(classifyConnectNonMessageEvent('conversation_closed')).toBe('thread_close');
    expect(classifyConnectNonMessageEvent('thread_closed')).toBe('thread_close');
    expect(classifyConnectNonMessageEvent('new_message')).toBeNull();
  });

  it('deduplicates message IDs before a second agent-turn delivery', () => {
    const onMessage = vi.fn();
    const client = new ConnectClient({ onMessage }) as any;
    const frame = {
      type: 'new_message',
      conversation_id: 'conv-live',
      message: {
        id: 'same-id',
        content: 'Please verify the live deployment.',
        sender_id: 88,
        sender_username: 'mio',
        conversation_type: 'direct',
        sender_same_org: true,
      },
    };

    client.handleMessage(frame);
    client.handleMessage(frame);

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('consumes acknowledgments before the bridge onMessage callback', () => {
    const onMessage = vi.fn();
    const client = new ConnectClient({ onMessage }) as any;
    client.handleMessage({
      type: 'new_message',
      conversation_id: 'conv-live',
      message: {
        id: 'ack-id',
        content: 'Acknowledged.',
        sender_id: 88,
        sender_username: 'mio',
        conversation_type: 'direct',
        sender_same_org: true,
      },
    });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['external', false],
    ['unknown', undefined],
  ])('fails open %s-org direct acknowledgments once as optional', (_label, senderSameOrg) => {
    const onMessage = vi.fn();
    const client = new ConnectClient({ onMessage }) as any;
    client.handleMessage({
      type: 'new_message',
      conversation_id: `conv-${_label}`,
      message: {
        id: `ack-${_label}`,
        content: 'Acknowledged.',
        sender_id: 88,
        sender_username: 'external',
        conversation_type: 'direct',
        ...(senderSameOrg === undefined ? {} : { sender_same_org: senderSameOrg }),
      },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[6]).toBe('optional');
  });

  it('replays the recorded direct closure loop with only informative control delivered', () => {
    const onMessage = vi.fn();
    const client = new ConnectClient({ onMessage }) as any;
    for (const [id, content] of [
      ['chain-1', 'Confirmed. PLAT-4215’s successor handoff is complete and fully aligned across both publication surfaces and Pulse provenance.'],
      ['chain-2', 'Acknowledged.'],
      ['chain-3', 'No further acknowledgment is needed on PLAT-4215 unless its recorded head or evidence changes.'],
      ['chain-4', 'Acknowledged.'],
    ]) {
      client.handleMessage({
        type: 'new_message', conversation_id: '5161627c-a145-4010-85d3-f338fb1884a9',
        message: { id, content, sender_id: 88, sender_username: 'aoi', conversation_type: 'direct', sender_same_org: true },
      });
    }
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls.map((call) => [call[1], call[6]])).toEqual([
      ['[aoi] Confirmed. PLAT-4215’s successor handoff is complete and fully aligned across both publication surfaces and Pulse provenance.', 'optional'],
      ['[aoi] No further acknowledgment is needed on PLAT-4215 unless its recorded head or evidence changes.', 'optional'],
    ]);
  });

  it.each([
    ['direct', 'Deployment is green.', 'optional'],
    ['direct', 'Please inspect the logs.', 'required'],
    // Group is content-based too (inject-once): plain ack is optional, not forced required.
    ['group', 'Acknowledged.', 'optional'],
    ['group', 'Please inspect the logs.', 'required'],
    ['invalid', 'Acknowledged.', 'optional'],
  ])('delivers %s content once with %s reply obligation', (conversationType, content, obligation) => {
    const onMessage = vi.fn();
    const client = new ConnectClient({ onMessage }) as any;
    client.handleMessage({
      type: 'new_message', conversation_id: `conv-${conversationType}-${obligation}`,
      message: { id: `id-${conversationType}-${obligation}`, content, sender_id: 88, sender_username: 'mio', conversation_type: conversationType, sender_same_org: conversationType === 'direct' },
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[6]).toBe(obligation);
  });

  it('exports bounded delivered and suppressed ingress metrics', async () => {
    const onMessage = vi.fn();
    const client = new ConnectClient({ onMessage }) as any;
    client.handleMessage({
      type: 'new_message', conversation_id: 'metrics-conv',
      message: { id: 'metrics-ack', content: 'Thanks', sender_id: 88, sender_username: 'mio', conversation_type: 'direct', sender_same_org: true },
    });
    client.handleMessage({
      type: 'new_message', conversation_id: 'metrics-conv',
      message: { id: 'metrics-action', content: 'Please inspect the logs.', sender_id: 88, sender_username: 'mio' },
    });

    const metrics = await metricsRegistry.getSingleMetricAsString('shizuha_connect_ingress_events_total');
    expect(metrics).toContain('channel="direct",decision="suppressed",reason="ack_only"');
    expect(metrics).toContain('channel="unknown",decision="delivered",reason="actionable"');
    const turns = await metricsRegistry.getSingleMetricAsString('shizuha_connect_turns_total');
    expect(turns).toContain('channel="unknown",reply_obligation="optional"');
  });
});

describe('shouldAcceptMissedMessageReplay', () => {
  const now = Date.parse('2026-07-01T08:00:00Z');

  it('accepts fresh missed-message replays under the cap', () => {
    expect(shouldAcceptMissedMessageReplay(
      { createdAt: '2026-07-01T07:30:00Z' },
      4,
      now,
      5,
      24,
    )).toEqual({ ok: true });
  });

  it('rejects missed-message replays once the per-connection cap is reached', () => {
    expect(shouldAcceptMissedMessageReplay(
      { createdAt: '2026-07-01T07:30:00Z' },
      5,
      now,
      5,
      24,
    )).toEqual({ ok: false, reason: 'replay_cap' });
  });

  it('rejects stale missed-message replays older than the age window', () => {
    expect(shouldAcceptMissedMessageReplay(
      { createdAt: '2026-06-29T07:30:00Z' },
      0,
      now,
      5,
      24,
    )).toEqual({ ok: false, reason: 'replay_too_old' });
  });
});
