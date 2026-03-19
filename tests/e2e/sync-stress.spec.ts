/**
 * Stress test for WebSocket sync/dedup system.
 *
 * Tests the two-cursor Kafka-style dedup against a live dashboard.
 * Exercises: reconnects, replays, agent switches, concurrent messages,
 * and verifies no duplicates or content loss.
 */

import { test, expect, Page } from '@playwright/test';
import { getDashboardUrl, guardRemoteDashboardTarget } from './dashboard-target';

const BASE_URL = getDashboardUrl();
const TIMEOUT = 20_000;
const USERNAME = 'shizuha';
const PASSWORD = 'shizuha';

test.beforeEach(() => {
  guardRemoteDashboardTarget(BASE_URL);
});

// ── WS Interceptor Script (injected BEFORE page loads) ──

const WS_INTERCEPTOR_SCRIPT = `
  const origWs = window.WebSocket;
  const tracker = { sockets: [], received: [], sent: [] };
  window.__wsTracker = tracker;
  window.__wsConnected = false;

  window.WebSocket = function(url, protocols) {
    const ws = new origWs(url, protocols);
    tracker.sockets.push(ws);
    window.__shizuhaWs = ws;

    ws.addEventListener('open', () => { window.__wsConnected = true; });
    ws.addEventListener('close', () => { window.__wsConnected = false; });

    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
      try { tracker.sent.push(JSON.parse(data)); } catch {}
      return origSend(data);
    };
    ws.addEventListener('message', (evt) => {
      try { tracker.received.push(JSON.parse(evt.data)); } catch {}
    });
    return ws;
  };
  window.WebSocket.CONNECTING = origWs.CONNECTING;
  window.WebSocket.OPEN = origWs.OPEN;
  window.WebSocket.CLOSING = origWs.CLOSING;
  window.WebSocket.CLOSED = origWs.CLOSED;
  window.WebSocket.prototype = origWs.prototype;
`;

// ── Helpers ──

/** Navigate to dashboard, inject WS interceptor, and log in */
async function loginAndSetup(page: Page) {
  // Inject WS interceptor BEFORE navigation so it captures the initial connection
  await page.addInitScript({ content: WS_INTERCEPTOR_SCRIPT });

  await page.goto(BASE_URL);
  await page.waitForTimeout(1000);

  // Check if we're on the login page
  const usernameInput = page.locator('#username');
  const isLoginPage = await usernameInput.isVisible({ timeout: 3000 }).catch(() => false);

  if (isLoginPage) {
    await usernameInput.fill(USERNAME);
    await page.locator('#password').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    // Wait for login to complete and dashboard to load
    await page.waitForTimeout(3000);
  }
}

/** Wait for WS to be connected */
async function waitForWsConnected(page: Page) {
  await page.waitForFunction(() => (window as any).__wsConnected === true, { timeout: TIMEOUT }).catch(() => {});
  await page.waitForTimeout(1500);
}

/** Select the first agent in the sidebar by clicking the first button with agent-like content */
async function selectFirstAgent(page: Page): Promise<string | null> {
  // Agents are rendered as buttons in the sidebar with @username text
  const agentButtons = page.locator('button:has(span:text("@"))');
  const count = await agentButtons.count();
  if (count === 0) {
    console.log('No agent buttons found');
    await page.screenshot({ path: '/tmp/stress-no-agents.png' });
    return null;
  }

  await agentButtons.first().click();
  await page.waitForTimeout(2000);

  // Find the agent ID from localStorage keys
  return getActiveAgentId(page);
}

/** Select an agent by index */
async function selectAgentByIndex(page: Page, index: number): Promise<string | null> {
  const agentButtons = page.locator('button:has(span:text("@"))');
  const count = await agentButtons.count();
  if (count <= index) return null;

  await agentButtons.nth(index).click();
  await page.waitForTimeout(2000);
  return getActiveAgentId(page);
}

/** Get agent count in sidebar */
async function getAgentCount(page: Page): Promise<number> {
  return page.locator('button:has(span:text("@"))').count();
}

/** Get the currently active agent ID from localStorage keys */
async function getActiveAgentId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // Find the most recently written shizuha_chat_ key
    const ids: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('shizuha_chat_')) {
        ids.push(key.replace('shizuha_chat_', ''));
      }
    }
    return ids.length > 0 ? ids[ids.length - 1]! : null;
  });
}

/** Get persisted messages for an agent */
async function getPersistedMessages(page: Page, agentId: string): Promise<any[]> {
  return page.evaluate((aid) => {
    try {
      const raw = localStorage.getItem(`shizuha_chat_${aid}`);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }, agentId);
}

/** Get the committed cursor for an agent */
async function getCommittedCursor(page: Page, agentId: string): Promise<number> {
  return page.evaluate((aid) => {
    const raw = localStorage.getItem(`shizuha_cursor_${aid}`);
    return raw ? parseInt(raw, 10) || 0 : 0;
  }, agentId);
}

/** Count user messages with specific content */
async function countUserMessages(page: Page, agentId: string, content: string): Promise<number> {
  return page.evaluate(({ aid, text }) => {
    try {
      const raw = localStorage.getItem(`shizuha_chat_${aid}`);
      if (!raw) return 0;
      const msgs = JSON.parse(raw);
      return msgs.filter((m: any) => m.role === 'user' && m.content === text).length;
    } catch { return 0; }
  }, { aid: agentId, text: content });
}

/** Force-close all tracked WebSocket connections */
async function closeAllWs(page: Page) {
  await page.evaluate(() => {
    const t = (window as any).__wsTracker;
    if (t) {
      for (const ws of t.sockets) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }
    }
  });
}

/** Wait for WS to reconnect after forced close */
async function waitForReconnect(page: Page) {
  await page.waitForFunction(() => (window as any).__wsConnected === true, { timeout: TIMEOUT });
  await page.waitForTimeout(1500);
}

/** Get WS tracker stats */
async function getWsStats(page: Page) {
  return page.evaluate(() => {
    const t = (window as any).__wsTracker;
    if (!t) return { sent: 0, received: 0, syncs: 0, replays: 0 };
    return {
      sent: t.sent.length,
      received: t.received.length,
      syncs: t.sent.filter((m: any) => m.type === 'sync').length,
      replays: t.received.filter((m: any) => m.type === 'event_replay').length,
    };
  });
}

/** Send a chat message via the textarea */
async function sendMessage(page: Page, text: string) {
  const textarea = page.locator('textarea').first();
  await textarea.fill(text);
  await textarea.press('Enter');
}

// ── Tests ──

test.describe('Sync/Dedup Stress Tests', () => {
  test.setTimeout(120_000);

  test('1. Dashboard loads, login works, WS connects', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    // Verify health endpoint
    const health = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/health`);
      return r.json();
    }, BASE_URL);
    expect(health.status).toBe('ok');
    expect(health.agents).toBeGreaterThan(0);

    // Verify WS is connected
    const connected = await page.evaluate(() => (window as any).__wsConnected);
    expect(connected).toBe(true);

    // Verify agents are visible
    const agentCount = await getAgentCount(page);
    expect(agentCount).toBeGreaterThan(0);

    console.log(`Dashboard OK: ${health.agents} agents, ${agentCount} in sidebar, WS connected`);
  });

  test('2. Single message — no duplicates after send', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    const agentId = await selectFirstAgent(page);
    if (!agentId) { test.skip(); return; }

    const testMsg = `stress-single-${Date.now()}`;
    await sendMessage(page, testMsg);
    await page.waitForTimeout(5000); // Wait for send + response

    const count = await countUserMessages(page, agentId, testMsg);
    console.log(`Message "${testMsg.slice(0, 20)}..." count: ${count}`);
    expect(count).toBe(1);
  });

  test('3. WS disconnect + reconnect — no duplicate user messages', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    const agentId = await selectFirstAgent(page);
    if (!agentId) { test.skip(); return; }

    // Send a message
    const testMsg = `reconnect-${Date.now()}`;
    await sendMessage(page, testMsg);
    await page.waitForTimeout(5000);

    const beforeCount = await countUserMessages(page, agentId, testMsg);
    console.log(`Before disconnect: ${beforeCount} instances`);
    expect(beforeCount).toBe(1);

    // Force disconnect
    await closeAllWs(page);
    console.log('WS disconnected');
    await page.waitForTimeout(1000);

    // Wait for auto-reconnect + sync replay
    await waitForReconnect(page);
    console.log('WS reconnected');
    await page.waitForTimeout(3000);

    // Verify no duplicates
    const afterCount = await countUserMessages(page, agentId, testMsg);
    console.log(`After reconnect: ${afterCount} instances`);
    expect(afterCount).toBe(1);

    // Cursor should exist and be > 0
    const cursor = await getCommittedCursor(page, agentId);
    console.log(`Committed cursor: ${cursor}`);
    expect(cursor).toBeGreaterThan(0);
  });

  test('4. Rapid reconnect cycle — 5x disconnect/reconnect', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    const agentId = await selectFirstAgent(page);
    if (!agentId) { test.skip(); return; }

    // Send a message and wait for response
    const testMsg = `rapid-${Date.now()}`;
    await sendMessage(page, testMsg);
    await page.waitForTimeout(8000);

    const beforeMsgs = await getPersistedMessages(page, agentId);
    const beforeAssistantMsgs = beforeMsgs.filter((m: any) => m.role === 'assistant');
    const beforeUniqueContents = new Set(beforeAssistantMsgs.map((m: any) => m.content));
    const beforeDuplicateCount = beforeAssistantMsgs.length - beforeUniqueContents.size;
    console.log(
      `Before reconnects: ${beforeAssistantMsgs.length} assistant (${beforeUniqueContents.size} unique, ${beforeDuplicateCount} duplicate contents)`,
    );

    // 5 rapid disconnect/reconnect cycles
    for (let i = 0; i < 5; i++) {
      await closeAllWs(page);
      await page.waitForTimeout(500);
      await waitForReconnect(page);
      await page.waitForTimeout(1500);
      console.log(`Cycle ${i + 1}/5 complete`);
    }

    // Verify no duplicates
    const userCount = await countUserMessages(page, agentId, testMsg);
    const msgs = await getPersistedMessages(page, agentId);
    const assistantMsgs = msgs.filter((m: any) => m.role === 'assistant');
    const uniqueContents = new Set(assistantMsgs.map((m: any) => m.content));
    const duplicateCount = assistantMsgs.length - uniqueContents.size;

    console.log(
      `After 5 reconnects: ${userCount} user msgs, ${assistantMsgs.length} assistant (${uniqueContents.size} unique, ${duplicateCount} duplicate contents)`,
    );
    expect(userCount).toBe(1);
    expect(duplicateCount).toBeLessThanOrEqual(beforeDuplicateCount + 1);
  });

  test('5. Page refresh — messages survive and no duplicates', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    const agentId = await selectFirstAgent(page);
    if (!agentId) { test.skip(); return; }

    // Send message and wait for response
    const testMsg = `refresh-${Date.now()}`;
    await sendMessage(page, testMsg);
    await page.waitForTimeout(8000);

    const beforeMsgs = await getPersistedMessages(page, agentId);
    const beforeCount = beforeMsgs.length;
    console.log(`Before refresh: ${beforeCount} messages`);

    // Reload page (addInitScript persists across reloads)
    await page.reload();
    await page.waitForTimeout(3000);

    // May need to re-login after refresh (session cookie vs localStorage)
    const needsLogin = await page.locator('#username').isVisible({ timeout: 2000 }).catch(() => false);
    if (needsLogin) {
      await page.locator('#username').fill(USERNAME);
      await page.locator('#password').fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3000);
    }

    await waitForWsConnected(page);

    // Re-select the same agent
    await selectFirstAgent(page);
    await page.waitForTimeout(3000);

    const afterMsgs = await getPersistedMessages(page, agentId);
    const afterUserCount = afterMsgs.filter((m: any) => m.role === 'user' && m.content === testMsg).length;

    console.log(`After refresh: ${afterMsgs.length} messages, ${afterUserCount} instances of test msg`);
    expect(afterMsgs.length).toBeGreaterThanOrEqual(beforeCount - 2);
    expect(afterUserCount).toBe(1);
  });

  test('6. Agent switch — no cross-contamination', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    const agentCount = await getAgentCount(page);
    if (agentCount < 2) { console.log(`Need 2+ agents, found ${agentCount}`); test.skip(); return; }

    // Select first agent and send message
    const agent1Id = await selectAgentByIndex(page, 0);
    if (!agent1Id) { test.skip(); return; }

    const msg1 = `agent1-${Date.now()}`;
    await sendMessage(page, msg1);
    await page.waitForTimeout(3000);

    // Select second agent and send message
    const agent2Id = await selectAgentByIndex(page, 1);
    if (!agent2Id || agent2Id === agent1Id) {
      console.log('Could not get distinct second agent');
      test.skip();
      return;
    }

    const msg2 = `agent2-${Date.now()}`;
    await sendMessage(page, msg2);
    await page.waitForTimeout(3000);

    // Verify no cross-contamination
    const agent1Msgs = await getPersistedMessages(page, agent1Id);
    const agent2Msgs = await getPersistedMessages(page, agent2Id);

    const agent1HasMsg2 = agent1Msgs.some((m: any) => m.content === msg2);
    const agent2HasMsg1 = agent2Msgs.some((m: any) => m.content === msg1);

    console.log(`Cross-check: agent1 has msg2=${agent1HasMsg2}, agent2 has msg1=${agent2HasMsg1}`);
    expect(agent1HasMsg2).toBe(false);
    expect(agent2HasMsg1).toBe(false);

    // Switch back to agent1 — messages should still be there
    await selectAgentByIndex(page, 0);
    await page.waitForTimeout(3000);

    const agent1After = await getPersistedMessages(page, agent1Id);
    expect(agent1After.some((m: any) => m.content === msg1)).toBe(true);
  });

  test('7. Multiple messages rapid-fire — all preserved, no dupes', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    const agentId = await selectFirstAgent(page);
    if (!agentId) { test.skip(); return; }

    const messages = Array.from({ length: 5 }, (_, i) => `rapid-fire-${i}-${Date.now()}`);

    // Send 5 messages rapidly
    for (const msg of messages) {
      await sendMessage(page, msg);
      await page.waitForTimeout(500);
    }

    // Wait for processing
    await page.waitForTimeout(10000);

    // Verify each message appears exactly once
    for (const msg of messages) {
      const count = await countUserMessages(page, agentId, msg);
      console.log(`"${msg.slice(0, 25)}...": ${count}`);
      expect(count).toBe(1);
    }
  });

  test('8. Cursor monotonicity — cursor never goes backwards', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    const agentId = await selectFirstAgent(page);
    if (!agentId) { test.skip(); return; }

    const cursors: number[] = [];
    const cursor1 = await getCommittedCursor(page, agentId);
    cursors.push(cursor1);

    // Send message + wait for response (completes → cursor advances)
    await sendMessage(page, `cursor-test-${Date.now()}`);
    await page.waitForTimeout(8000);

    const cursor2 = await getCommittedCursor(page, agentId);
    cursors.push(cursor2);

    // Disconnect + reconnect
    await closeAllWs(page);
    await page.waitForTimeout(1000);
    await waitForReconnect(page);
    await page.waitForTimeout(3000);

    const cursor3 = await getCommittedCursor(page, agentId);
    cursors.push(cursor3);

    console.log(`Cursor progression: ${cursors.join(' → ')}`);

    // Cursor must never decrease
    for (let i = 1; i < cursors.length; i++) {
      expect(cursors[i]!).toBeGreaterThanOrEqual(cursors[i - 1]!);
    }
  });

  test('9. Sync count — exactly 1 sync per reconnect', async ({ page }) => {
    await loginAndSetup(page);
    await waitForWsConnected(page);

    await selectFirstAgent(page);
    await page.waitForTimeout(2000);

    // Clear tracker
    await page.evaluate(() => {
      const t = (window as any).__wsTracker;
      if (t) { t.sent = []; t.received = []; }
    });

    // Force disconnect + reconnect
    await closeAllWs(page);
    await page.waitForTimeout(500);
    await waitForReconnect(page);
    await page.waitForTimeout(2000);

    const stats = await getWsStats(page);
    console.log(`After 1 reconnect: ${stats.syncs} syncs, ${stats.replays} replays`);

    // Should have 1 sync (2 acceptable if multiple WS objects reconnect)
    expect(stats.syncs).toBeGreaterThanOrEqual(1);
    expect(stats.syncs).toBeLessThanOrEqual(2);
  });

  test('10. Full replay dedup — cursor reset to 0, no duplicates', async ({ page }) => {
    // Capture console logs for debugging
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[sync]')) consoleLogs.push(text);
    });

    await loginAndSetup(page);
    await waitForWsConnected(page);

    const agentId = await selectFirstAgent(page);
    if (!agentId) { test.skip(); return; }

    // Send a message and wait for full response
    const testMsg = `replay-dedup-${Date.now()}`;
    await sendMessage(page, testMsg);
    await page.waitForTimeout(8000);

    const before = await getPersistedMessages(page, agentId);
    const beforeLen = before.length;
    console.log(`Agent: ${agentId}, before: ${beforeLen} msgs`);

    // Log session cursor state before reset
    const preResetState = await page.evaluate((aid) => {
      const committed = localStorage.getItem(`shizuha_cursor_${aid}`);
      return { committed };
    }, agentId);
    console.log(`Pre-reset: committedCursor=${preResetState.committed}`);

    // Clear debug log
    await page.evaluate(() => localStorage.setItem('_sync_debug', ''));

    // Reset committed cursor to 0 → forces full event replay on next sync
    await page.evaluate((aid) => {
      localStorage.setItem(`shizuha_cursor_${aid}`, '0');
    }, agentId);

    // Disconnect + reconnect → sync sends cursor=0 → server replays everything
    await closeAllWs(page);
    await page.waitForTimeout(500);
    await waitForReconnect(page);
    await page.waitForTimeout(5000);

    // Read debug log
    const syncDebug = await page.evaluate(() => localStorage.getItem('_sync_debug') || '');
    console.log(`Sync debug:${syncDebug || '(empty)'}`);

    // Check WS tracker for what was received
    const wsReceived = await page.evaluate(() => {
      const t = (window as any).__wsTracker;
      if (!t) return { total: 0, typeCounts: {}, replays: [] as any[] };
      const types = t.received.map((m: any) => m.type).filter(Boolean);
      const typeCounts: Record<string, number> = {};
      types.forEach((type: string) => { typeCounts[type] = (typeCounts[type] || 0) + 1; });
      // Get event_replay details
      const replays = t.received
        .filter((m: any) => m.type === 'event_replay')
        .map((m: any) => ({
          agent_id: m.agent_id,
          eventCount: Array.isArray(m.events) ? m.events.length : 0,
          cursor: m.cursor,
          firstSeq: Array.isArray(m.events) && m.events.length > 0 ? m.events[0]._seq : null,
        }));
      return { total: t.received.length, typeCounts, replays };
    });
    console.log(`WS received: total=${wsReceived.total} types=${JSON.stringify(wsReceived.typeCounts)}`);
    for (const r of wsReceived.replays) {
      console.log(`  replay: agent=${r.agent_id} events=${r.eventCount} cursor=${r.cursor} firstSeq=${r.firstSeq}`);
    }

    // Also check: did handleWsMessage run at all? Check via a side effect
    const debugCheck = await page.evaluate(() => ({
      syncDebug: localStorage.getItem('_sync_debug') || '',
      allKeys: Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)),
    }));
    console.log(`localStorage keys: ${debugCheck.allKeys.filter(k => k?.startsWith('shizuha_') || k?.startsWith('_sync')).join(', ')}`);

    // Print captured sync logs
    for (const log of consoleLogs) {
      console.log(`  BROWSER: ${log}`);
    }

    const after = await getPersistedMessages(page, agentId);
    const afterUserCount = after.filter((m: any) => m.role === 'user' && m.content === testMsg).length;

    console.log(`Before: ${beforeLen} msgs. After full replay: ${after.length} msgs. Test msg: ${afterUserCount}x`);

    expect(afterUserCount).toBe(1);
    expect(after.length).toBeLessThanOrEqual(beforeLen + 2);
  });
});
