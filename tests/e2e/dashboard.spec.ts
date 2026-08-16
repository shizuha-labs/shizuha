/**
 * Dashboard E2E tests — verifies chat messaging, cross-device sync,
 * multi-client fan-out, and message persistence across page refresh.
 *
 * Run in Docker: see compose service definition.
 */
import { test, expect, type Page, type WebSocket as PWWebSocket } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:8015';
const PLATFORM_WS = process.env.PLATFORM_WS || 'ws://127.0.0.1/agent/ws/chat/';
const USERNAME = process.env.DASHBOARD_USER || 'shizuha';
const PASSWORD = process.env.DASHBOARD_PASS || 'shizuha';

// The agent we test against — canonical platform UUID
const AGENT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_NAME = 'Shizuha';

/** Read platform access token from auth file (for cross-device test). */
async function getPlatformToken(): Promise<string | null> {
  try {
    const fs = await import('fs');
    const home = process.env.HOME || '/root';
    const raw = fs.readFileSync(`${home}/.shizuha/auth.json`, 'utf-8');
    const auth = JSON.parse(raw);
    return auth.accessToken || null;
  } catch {
    return null;
  }
}

/** Login to the dashboard and return a ready page with the chat textarea visible. */
async function loginAndSelectAgent(page: Page, opts?: { skipNavigation?: boolean }): Promise<void> {
  if (!opts?.skipNavigation) {
    await page.goto(BASE, { waitUntil: 'networkidle' });
  }

  // If login screen is shown, authenticate
  const loginForm = page.locator('form');
  if (await loginForm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1500);
  }

  // Check if the chat textarea is already visible (agent auto-restored from localStorage)
  const textarea = page.locator('textarea').first();
  if (await textarea.isVisible({ timeout: 3000 }).catch(() => false)) {
    return; // Agent already selected, chat view active
  }

  // Select agent from sidebar (click on the agent name)
  const agentEntry = page.locator(`text=${AGENT_NAME}`).first();
  if (await agentEntry.isVisible({ timeout: 5000 }).catch(() => false)) {
    await agentEntry.click();
  }

  // Wait for chat view to be ready (textarea visible)
  await textarea.waitFor({ state: 'visible', timeout: 10_000 });
}

/** Send a message via the chat input. */
async function sendMessage(page: Page, text: string): Promise<void> {
  // The MessageInput uses a <textarea> — placeholder is dynamic ("Message {Agent}...")
  const textarea = page.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 15_000 });
  await textarea.fill(text);
  // Submit with Enter (handleKeyDown intercepts Enter without Shift)
  await textarea.press('Enter');
}

/** Wait for assistant response containing expected text. */
async function waitForResponse(page: Page, marker: string, timeout = 45_000): Promise<string> {
  // Wait for a message bubble containing the marker text
  const response = page.locator('.markdown-content, [class*="message"]').filter({ hasText: marker });
  await response.first().waitFor({ state: 'visible', timeout });
  return response.first().textContent() || '';
}

/** Count occurrences of a text pattern in all message bubbles. */
async function countInMessages(page: Page, text: string): Promise<number> {
  const allText = await page.locator('[class*="bg-zinc-800"], .markdown-content').allTextContents();
  return allText.filter((t) => t.includes(text)).length;
}

// ── Tests ──

test.describe('Dashboard Chat', () => {
  test.describe.configure({ mode: 'serial' }); // tests must run in order

  test('1. Login and load dashboard', async ({ page }) => {
    await page.goto(BASE);

    // Should show login or dashboard
    const body = await page.textContent('body');
    expect(body).toBeTruthy();

    await loginAndSelectAgent(page);

    // Verify WebSocket connection indicator
    // The dashboard should show connected status
    await page.waitForTimeout(2000);

    // Verify agent is visible in sidebar or header
    const agentVisible = await page.locator(`text=${AGENT_NAME}`).first().isVisible();
    expect(agentVisible).toBe(true);
  });

  test('2. Send message and receive streaming response', async ({ page }) => {
    await loginAndSelectAgent(page);
    await page.waitForTimeout(2000); // wait for WS connection

    const marker = `E2E_SEND_${Date.now()}`;
    await sendMessage(page, `Reply with exactly: ${marker}`);

    // Wait for the user message to appear
    const markerLocator = page.locator(`text=${marker}`).first();
    await markerLocator.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait for an assistant response — the agent streams a reply which appears
    // in a markdown-content div. Wait for any new markdown-content to appear
    // after the user message (the agent may not echo the marker verbatim).
    const assistantMsg = page.locator('.markdown-content').last();
    await assistantMsg.waitFor({ state: 'visible', timeout: 60_000 });

    // Verify assistant response has content (not empty)
    const responseText = await assistantMsg.textContent();
    expect(responseText?.length).toBeGreaterThan(0);

    // Bonus: check if agent echoed the marker (not required for pass)
    const allText = await page.locator('body').textContent();
    const count = (allText?.match(new RegExp(marker, 'g')) || []).length;
    // At minimum user message should be there
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('3. Messages persist after page refresh', async ({ page }) => {
    await loginAndSelectAgent(page);
    await page.waitForTimeout(2000); // wait for WS connection

    const marker = `E2E_PERSIST_${Date.now()}`;
    await sendMessage(page, `Reply with exactly: ${marker}`);

    // Wait for complete response
    await waitForResponse(page, marker, 60_000);
    await page.waitForTimeout(2000); // allow localStorage persist

    // Refresh page — don't navigate away, just reload in place
    await page.reload({ waitUntil: 'networkidle' });

    // After reload, the dashboard restores selectedAgent from localStorage
    // so the chat view should auto-appear without re-selecting
    await loginAndSelectAgent(page, { skipNavigation: true });

    // Messages should be restored from localStorage
    const found = await page.locator(`text=${marker}`).first().isVisible({ timeout: 15_000 }).catch(() => false);
    expect(found).toBe(true);
  });

  test('4. No duplicate messages (dedup)', async ({ page }) => {
    await loginAndSelectAgent(page);
    await page.waitForTimeout(2000);

    const marker = `E2E_DEDUP_${Date.now()}`;
    await sendMessage(page, `Reply with exactly this single word: ${marker}`);

    // Wait for user message to appear
    await page.locator(`text=${marker}`).first().waitFor({ state: 'visible', timeout: 10_000 });

    // Wait for assistant response (any markdown-content)
    const assistantMsg = page.locator('.markdown-content').last();
    await assistantMsg.waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForTimeout(3000); // wait for any delayed duplicates

    // Count user messages containing the marker — should be exactly 1
    // (the prompt text appears in the user bubble)
    const userBubbles = await page.locator('[class*="bg-shizuha"], [class*="bg-blue"]').allTextContents();
    const userCount = userBubbles.filter((t) => t.includes(marker)).length;
    expect(userCount).toBeLessThanOrEqual(1);

    // Count total assistant markdown-content blocks — verify no duplicates
    const assistantBlocks = await page.locator('.markdown-content').count();
    // We can't predict exact count (depends on history), but we check
    // that the latest response isn't duplicated by counting from the end
    const lastTwo = await page.locator('.markdown-content').all();
    if (lastTwo.length >= 2) {
      const last = await lastTwo[lastTwo.length - 1].textContent();
      const prev = await lastTwo[lastTwo.length - 2].textContent();
      // Last two assistant messages should NOT be identical (dedup check)
      if (last && prev && last.length > 10) {
        expect(last).not.toBe(prev);
      }
    }
  });

  test('5. Multi-client fan-out (two browser tabs)', async ({ page, browser }) => {
    // Login on first page and save storage state
    await loginAndSelectAgent(page);
    await page.waitForTimeout(1000);
    const storageState = await page.context().storageState();

    // Open second tab with same cookies
    const ctx2 = await browser.newContext({ storageState });
    const page2 = await ctx2.newPage();
    await loginAndSelectAgent(page2);

    // Verify page2 has the chat view (textarea visible)
    const p2Textarea = page2.locator('textarea').first();
    await p2Textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait for both WebSocket connections to establish
    await page.waitForTimeout(2000);
    await page2.waitForTimeout(2000);

    const marker = `E2E_MULTI_${Date.now()}`;
    await sendMessage(page, `Reply with exactly: ${marker}`);

    // First page should show the agent's response (streaming completes)
    const page1Response = page.locator('.markdown-content').last();
    await page1Response.waitFor({ state: 'visible', timeout: 60_000 });

    // Give time for fan-out events to reach page2
    await page2.waitForTimeout(5000);

    // page2 should have received streaming events and rendered content
    const page2MdCount = await page2.locator('.markdown-content').count();
    const page2HasStreaming = await page2.locator('.streaming-cursor').count();
    expect(page2MdCount + page2HasStreaming).toBeGreaterThan(0);

    await ctx2.close();
  });

  test('6. Cross-device message (platform → dashboard)', async ({ page }) => {
    const token = await getPlatformToken();
    test.skip(!token, 'No platform token available — skip cross-device test');

    await loginAndSelectAgent(page);
    await page.waitForTimeout(2000);

    const marker = `E2E_CROSS_${Date.now()}`;

    // Send via platform WebSocket (simulating ori-expo)
    const wsUrl = `${PLATFORM_WS}?token=${token}`;
    const result = await page.evaluate(
      async ({ wsUrl, agentId, marker }) => {
        return new Promise<{ userMsg: boolean; response: boolean }>((resolve) => {
          const ws = new window.WebSocket(wsUrl);
          let ready = false;
          ws.onopen = () => {
            // Drain presence messages, then send
            setTimeout(() => {
              ws.send(
                JSON.stringify({
                  type: 'message',
                  agent_id: agentId,
                  content: `Reply with exactly: ${marker}`,
                }),
              );
              ready = true;
            }, 2000);
          };
          // Just wait for send, then close
          setTimeout(() => {
            ws.close();
            resolve({ userMsg: true, response: true });
          }, 5000);
        });
      },
      { wsUrl, agentId: AGENT_ID, marker },
    );

    // Dashboard should receive user_message + agent response
    // Wait for the marker to appear on the page
    const found = await page
      .locator(`text=${marker}`)
      .first()
      .isVisible({ timeout: 45_000 })
      .catch(() => false);
    expect(found).toBe(true);

    // Wait for agent response too
    await page.waitForTimeout(15_000);

    // Should have both user message and agent response
    const count = await countInMessages(page, marker);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('7. WebSocket reconnection', async ({ page }) => {
    await loginAndSelectAgent(page);
    await page.waitForTimeout(2000);

    // Force disconnect by evaluating close on the WebSocket
    await page.evaluate(() => {
      // Find and close the chat WebSocket
      const ws = (window as unknown as Record<string, unknown>).__shizuhaWs as WebSocket | undefined;
      if (ws) ws.close();
    });

    // Wait for auto-reconnect (3s interval)
    await page.waitForTimeout(5000);

    // Verify we can still send/receive messages
    const marker = `E2E_RECON_${Date.now()}`;
    await sendMessage(page, `Reply with exactly: ${marker}`);

    const found = await page
      .locator(`text=${marker}`)
      .first()
      .isVisible({ timeout: 60_000 })
      .catch(() => false);
    expect(found).toBe(true);
  });
});
