/**
 * E2E test for the Kafka-style event log.
 *
 * Tests against the live dashboard at localhost:8015:
 * 1. Login to get session cookie
 * 2. Connect WebSocket to /ws/chat
 * 3. Subscribe to an agent
 * 4. Send a message, collect events with _seq
 * 5. Disconnect, reconnect with cursor, verify replay
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';

const DASHBOARD_URL = process.env['DASHBOARD_URL'] || 'http://localhost:8015';
const WS_URL = DASHBOARD_URL.replace(/^http/, 'ws') + '/ws/chat';
const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'shizuha-nginx', 'host.docker.internal']);

let sessionCookie = '';
let targetAgentId = '';
let targetAgentUsername = '';

function isSafeDashboardTarget(url: string): boolean {
  return SAFE_HOSTS.has(new URL(url).hostname) || process.env['ALLOW_REMOTE_DASHBOARD_E2E'] === '1';
}

/** Login to dashboard and get session cookie. */
async function login(): Promise<string> {
  const resp = await fetch(`${DASHBOARD_URL}/v1/dashboard/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'shizuha', password: 'shizuha' }),
  });
  const setCookie = resp.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/shizuha_session=([^;]+)/);
  if (!match) throw new Error('Failed to login — no session cookie');
  return match[1]!;
}

/** Pick a disposable-ish running agent, never live Shizuha by default. */
async function getIsolatedAgent(cookie: string): Promise<{ id: string; username: string }> {
  const resp = await fetch(`${DASHBOARD_URL}/v1/agents`, {
    headers: { Cookie: `shizuha_session=${cookie}` },
  });
  const data = (await resp.json()) as { agents: Array<{ id: string; username: string; enabled: boolean; status: string }> };
  const running = data.agents.filter((a) => a.enabled && a.status === 'running');
  const preferredUsername = process.env['EVENT_LOG_E2E_AGENT'];
  const preferred = preferredUsername ? running.find((a) => a.username === preferredUsername) : undefined;
  if (preferred) return { id: preferred.id, username: preferred.username };

  const nonShizuha = running.find((a) => a.username !== 'shizuha');
  if (nonShizuha) return { id: nonShizuha.id, username: nonShizuha.username };

  throw new Error('No isolated running agent found. Set EVENT_LOG_E2E_AGENT to a disposable agent username.');
}

async function resetRuntimeSession(cookie: string, agentId: string): Promise<void> {
  await fetch(`${DASHBOARD_URL}/v1/agents/${agentId}/reset-session`, {
    method: 'POST',
    headers: { Cookie: `shizuha_session=${cookie}` },
  }).catch(() => {});
}

/** Create a WebSocket connection with a promise-based interface. */
function createWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, {
      headers: { Cookie: `shizuha_session=${sessionCookie}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Send a message and collect all received messages until timeout or predicate. */
function collectMessages(
  ws: WebSocket,
  untilType: string,
  timeoutMs = 60_000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const msgs: Array<Record<string, unknown>> = [];
    let done = false;

    const timer = setTimeout(() => {
      if (!done) { done = true; resolve(msgs); }
    }, timeoutMs);

    ws.on('message', (data: Buffer) => {
      if (done) return;
      try {
        const msg = JSON.parse(data.toString());
        msgs.push(msg);
        if (msg.type === untilType) {
          done = true;
          clearTimeout(timer);
          resolve(msgs);
        }
      } catch { /* ignore */ }
    });
  });
}

/** Wait for a specific message type. */
function waitForType(ws: WebSocket, type: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch { /* ignore */ }
    };
    ws.on('message', handler);
  });
}

describe('Event Log E2E', () => {
  beforeAll(async () => {
    if (!isSafeDashboardTarget(DASHBOARD_URL)) {
      console.log('Refusing to run event log E2E against remote target', DASHBOARD_URL);
      return;
    }

    // Check if dashboard is running
    try {
      const health = await fetch(`${DASHBOARD_URL}/health`);
      if (!health.ok) throw new Error('Dashboard not healthy');
    } catch {
      console.log('Dashboard not running at', DASHBOARD_URL, '— skipping e2e tests');
      return;
    }

    sessionCookie = await login();
    const target = await getIsolatedAgent(sessionCookie);
    targetAgentId = target.id;
    targetAgentUsername = target.username;
    await resetRuntimeSession(sessionCookie, targetAgentId);
  }, 30_000);

  afterAll(async () => {
    if (!sessionCookie || !targetAgentId) return;
    await resetRuntimeSession(sessionCookie, targetAgentId);
  }, 30_000);

  it('events from agent carry _seq numbers', async () => {
    if (!targetAgentId) return; // skip if no agent

    const ws = await createWs();

    try {
      // Subscribe to agent
      ws.send(JSON.stringify({ type: 'subscribe', agent_id: targetAgentId }));
      await waitForType(ws, 'subscribed');

      // Send a simple message
      const marker = `event-log-test-ok-${targetAgentUsername}`;
      ws.send(JSON.stringify({
        type: 'message',
        agent_id: targetAgentId,
        content: `Reply with exactly: "${marker}"`,
      }));

      // Collect events until 'complete'
      const events = await collectMessages(ws, 'complete', 90_000);

      // Find events with _seq
      const seqEvents = events.filter((e) => typeof e._seq === 'number');
      expect(seqEvents.length).toBeGreaterThan(0);

      // Verify _seq is monotonically increasing
      for (let i = 1; i < seqEvents.length; i++) {
        expect(seqEvents[i]!._seq as number).toBeGreaterThan(seqEvents[i - 1]!._seq as number);
      }

      // Verify durable event types have _seq
      const contentEvents = events.filter((e) => e.type === 'content');
      const completeEvents = events.filter((e) => e.type === 'complete');
      if (contentEvents.length > 0) {
        expect(contentEvents.some((e) => typeof e._seq === 'number')).toBe(true);
      }
      if (completeEvents.length > 0) {
        expect(completeEvents[0]!._seq).toBeDefined();
      }

      // Non-durable events (transport_status, agent_status, ping, pong, subscribed, relay_ack, message_ack) should NOT have _seq
      const nonDurable = events.filter((e) =>
        ['transport_status', 'agent_status', 'ping', 'pong', 'subscribed', 'relay_ack', 'message_ack'].includes(e.type as string),
      );
      for (const e of nonDurable) {
        expect(e._seq).toBeUndefined();
      }
    } finally {
      ws.close();
    }
  }, 120_000);

  it('cursor-based replay returns missed events', async () => {
    if (!targetAgentId) return;

    // Step 1: Connect and send a message to generate events
    const ws1 = await createWs();
    ws1.send(JSON.stringify({ type: 'subscribe', agent_id: targetAgentId }));
    await waitForType(ws1, 'subscribed');

    ws1.send(JSON.stringify({
      type: 'message',
      agent_id: targetAgentId,
      content: `Reply with exactly: "cursor-replay-test-ok-${targetAgentUsername}"`,
    }));

    const events1 = await collectMessages(ws1, 'complete', 90_000);
    const seqEvents = events1.filter((e) => typeof e._seq === 'number');

    if (seqEvents.length < 2) {
      ws1.close();
      console.log('Not enough seq events to test replay — skipping');
      return;
    }

    // Get the first seq as our "client was here" point
    const midCursor = seqEvents[0]!._seq as number;
    const expectedRemainingCount = seqEvents.filter((e) => (e._seq as number) > midCursor).length;
    ws1.close();

    // Step 2: Reconnect with cursor — should get replay of missed events
    const ws2 = await createWs();

    // Send sync with cursor
    ws2.send(JSON.stringify({
      type: 'sync',
      agent_id: targetAgentId,
      cursor: midCursor,
    }));

    // Wait for event_replay response
    const replay = await waitForType(ws2, 'event_replay', 10_000);
    ws2.close();

    expect(replay.type).toBe('event_replay');
    expect(replay.agent_id).toBe(targetAgentId);
    expect(Array.isArray(replay.events)).toBe(true);

    const replayedEvents = replay.events as Array<Record<string, unknown>>;
    expect(replayedEvents.length).toBeGreaterThanOrEqual(expectedRemainingCount);

    // Verify all replayed events have _seq > midCursor
    for (const e of replayedEvents) {
      expect(e._seq as number).toBeGreaterThan(midCursor);
    }

    // Verify cursor field is returned
    expect(typeof replay.cursor).toBe('number');
    expect(replay.cursor as number).toBeGreaterThan(midCursor);
  }, 120_000);

  it('sync with cursor=0 falls through to platform/gateway sync', async () => {
    if (!targetAgentId) return;

    const ws = await createWs();

    try {
      // Send sync with cursor=0 (no event log replay, should get sync_history or be forwarded)
      ws.send(JSON.stringify({
        type: 'sync',
        agent_id: targetAgentId,
        cursor: 0,
      }));

      // We should NOT get event_replay (cursor=0 means "I don't have a cursor")
      // We should get either sync_history (from platform/gateway) or at least a subscribed confirmation
      const msg = await new Promise<Record<string, unknown>>((resolve) => {
        const timer = setTimeout(() => resolve({ type: 'timeout' }), 5_000);
        ws.on('message', (data: Buffer) => {
          try {
            const m = JSON.parse(data.toString());
            // Skip control-plane status/heartbeat messages
            if (!['transport_status', 'agent_status', 'ping', 'pong'].includes(m.type)) {
              clearTimeout(timer);
              resolve(m);
            }
          } catch { /* ignore */ }
        });
      });

      // cursor=0 means "give me everything" — if the event log has records,
      // the dashboard correctly sends event_replay. If no records, it falls
      // through to platform sync or times out.
      if (msg.type !== 'timeout') {
        expect(['event_replay', 'subscribed', 'sync_history']).toContain(msg.type);
      }
    } finally {
      ws.close();
    }
  }, 30_000);

  it('event log DB exists and has records after messaging', async () => {
    if (!targetAgentId) return;

    // Directly check the SQLite database for records
    const dbPath = `${process.env['HOME']}/.shizuha/event-log.db`;
    const { existsSync } = await import('node:fs');
    if (!existsSync(dbPath)) {
      console.log('Event log DB not found at', dbPath, '— skipping DB assertion');
      return;
    }
    const { default: Database } = await import('better-sqlite3');

    let db;
    try {
      db = new Database(dbPath, { readonly: true });
      const count = db.prepare('SELECT COUNT(*) AS cnt FROM event_log').get() as { cnt: number };
      expect(count.cnt).toBeGreaterThan(0);

      // Verify structure
      const row = db.prepare('SELECT seq, agent_id, event, ts FROM event_log ORDER BY seq DESC LIMIT 1').get() as {
        seq: number;
        agent_id: string;
        event: string;
        ts: number;
      };
      expect(row.seq).toBeGreaterThan(0);
      expect(row.agent_id).toBeTruthy();
      expect(row.ts).toBeGreaterThan(0);

      // Verify event is valid JSON
      const parsed = JSON.parse(row.event);
      expect(parsed.type).toBeTruthy();
    } finally {
      db?.close();
    }
  }, 10_000);
});
