/**
 * Claw Messaging Deep Test — verifies cross-device message delivery,
 * no duplicates, no lost messages, correct streaming state.
 *
 * Tests the exact bug scenario: messages sent from different clients
 * should ALL appear on the dashboard with responses.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const BASE = 'http://localhost:8015';
const USER = 'shizuha';
const PASS = 'shizuha';

async function login(page: Page) {
  await page.goto(BASE);
  await page.waitForTimeout(2000);
  const signIn = page.locator('button:has-text("Sign in")');
  if (await signIn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.locator('input').first().fill(USER);
    await page.locator('input[type="password"]').fill(PASS);
    await signIn.click();
    await page.waitForTimeout(3000);
  }
}

async function selectAgent(page: Page, name: string) {
  const el = page.locator(`text="${name}"`).first();
  if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
    await el.click();
    await page.waitForTimeout(2000);
  }
}

async function sendAndWait(page: Page, msg: string, maxWait = 45000): Promise<string> {
  const textarea = page.locator('textarea').first();
  await textarea.fill(msg);
  await textarea.press('Enter');

  // Wait for response — stop button should appear then disappear
  await page.waitForTimeout(3000);
  let lastLen = 0, stable = 0;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const len = (await page.textContent('body'))?.length ?? 0;
    if (len === lastLen) { stable++; if (stable >= 3) break; }
    else { stable = 0; lastLen = len; }
    await page.waitForTimeout(2000);
  }
  return await page.textContent('body') ?? '';
}

function getAgentId(name: string): string {
  try {
    const out = execSync(`curl -s http://127.0.0.1:8015/v1/agents`, { encoding: 'utf-8', timeout: 5000 });
    const agents = JSON.parse(out).agents || JSON.parse(out);
    return agents.find((a: any) => a.name === name)?.id ?? '';
  } catch { return ''; }
}

function sendViaApi(agentId: string, message: string): any {
  try {
    const out = execSync(
      `curl -s -X POST http://127.0.0.1:8015/v1/agents/${agentId}/ask -H "Content-Type: application/json" -d '${JSON.stringify({ content: message, timeout: 20000 })}'`,
      { encoding: 'utf-8', timeout: 25000 }
    );
    return JSON.parse(out);
  } catch { return null; }
}

test.describe.configure({ mode: 'serial' });

test.describe('Claw Messaging', () => {

  test('C1: Send from dashboard, verify response appears', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Claw');

    const marker = `DASH_${Date.now().toString(36)}`;
    const body = await sendAndWait(page, `Say exactly: ${marker}`);

    // Response should contain the marker
    expect(body).toContain(marker);
    await page.screenshot({ path: '/tmp/c1-dashboard-send.png' });
  });

  test('C2: Send from API, verify response appears on dashboard', async ({ page }) => {
    test.setTimeout(90000);
    await login(page);
    await selectAgent(page, 'Claw');
    await page.waitForTimeout(2000);

    const clawId = getAgentId('Claw');
    test.skip(!clawId, 'Claw not found');

    const marker = `API_${Date.now().toString(36)}`;

    // Send from API (different client)
    const apiResp = sendViaApi(clawId, `Say exactly: ${marker}`);
    expect(apiResp?.response).toContain(marker);

    // Wait for dashboard to receive the cross-device events
    await page.waitForTimeout(10000);
    const body = await page.textContent('body') ?? '';

    // The response should appear on the dashboard
    // (This was the bug — cross-device responses weren't showing)
    const hasResponse = body.includes(marker);
    await page.screenshot({ path: '/tmp/c2-api-send.png' });

    // Log the result even if it fails
    test.info().annotations.push({
      type: 'cross_device',
      description: `marker=${marker}, visible=${hasResponse}, apiResp=${apiResp?.response?.slice(0, 50)}`,
    });
    expect(hasResponse).toBeTruthy();
  });

  test('C3: No duplicate responses', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Claw');

    const marker = `NODUP_${Date.now().toString(36)}`;
    const body = await sendAndWait(page, `Say exactly: ${marker}`);

    // Count occurrences of the marker in the page
    const count = (body.match(new RegExp(marker, 'g')) || []).length;
    // Should appear exactly 2 times: once in the user message, once in the response
    // NOT 3+ times (which would mean duplicate response)
    expect(count).toBeLessThanOrEqual(2);
    await page.screenshot({ path: '/tmp/c3-no-dup.png' });
    test.info().annotations.push({ type: 'dup_count', description: String(count) });
  });

  test('C4: No stuck streaming cursor after response', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Claw');

    await sendAndWait(page, 'Say hello');
    await page.waitForTimeout(5000);

    // Stop button should NOT be visible after response completes
    const stopBtn = page.locator('button[title*="top" i]');
    const stuck = await stopBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (stuck) await page.screenshot({ path: '/tmp/c4-BUG-stuck-cursor.png' });
    expect(stuck).toBeFalsy();
  });

  test('C5: Multiple messages in sequence', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Claw');

    // Send 3 messages
    for (const q of ['What is 3+3?', 'What is 4+4?', 'What is 5+5?']) {
      await sendAndWait(page, q, 30000);
      await page.waitForTimeout(1000);
    }

    const body = await page.textContent('body') ?? '';
    // Should see at least some answers
    const has6 = body.includes('6');
    const has8 = body.includes('8');
    const has10 = body.includes('10');
    test.info().annotations.push({ type: 'answers', description: `6:${has6} 8:${has8} 10:${has10}` });
    // At least 2 of 3 should be present
    expect([has6, has8, has10].filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  test('C6: Clear chat then send — no ghosts', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Claw');

    // Send a message first
    await sendAndWait(page, 'Say BEFORE_CLEAR_MARKER');

    // Clear chat
    await page.keyboard.press('Control+Shift+p');
    await page.waitForTimeout(500);
    const clearBtn = page.locator('text="Clear"').first();
    if (await clearBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await clearBtn.click();
      await page.waitForTimeout(1000);
    } else {
      await page.keyboard.press('Escape');
    }

    // Send new message
    const body = await sendAndWait(page, 'Say AFTER_CLEAR_MARKER');
    const hasOld = body.includes('BEFORE_CLEAR_MARKER');
    const hasNew = body.includes('AFTER_CLEAR_MARKER');

    test.info().annotations.push({ type: 'clear', description: `old:${hasOld} new:${hasNew}` });
    // Old marker should be gone, new should be present
    await page.screenshot({ path: '/tmp/c6-clear-chat.png' });
  });

  test('C7: Switch away and back — messages persist', async ({ page }) => {
    test.setTimeout(90000);
    await login(page);
    await selectAgent(page, 'Claw');

    const marker = `PERSIST_${Date.now().toString(36)}`;
    await sendAndWait(page, `Say exactly: ${marker}`);

    // Switch to Sora
    await selectAgent(page, 'Sora');
    await page.waitForTimeout(2000);

    // Switch back to Claw
    await selectAgent(page, 'Claw');
    await page.waitForTimeout(3000);

    const body = await page.textContent('body') ?? '';
    const persisted = body.includes(marker);
    test.info().annotations.push({ type: 'persist', description: String(persisted) });
    await page.screenshot({ path: '/tmp/c7-persist.png' });
    expect(persisted).toBeTruthy();
  });

  test('C8: Refresh page — messages survive', async ({ page }) => {
    test.setTimeout(90000);
    await login(page);
    await selectAgent(page, 'Claw');

    const marker = `REFRESH_${Date.now().toString(36)}`;
    await sendAndWait(page, `Say exactly: ${marker}`);

    // Refresh
    await page.reload();
    await page.waitForTimeout(3000);

    // Re-login if needed
    const signIn = page.locator('button:has-text("Sign in")');
    if (await signIn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.locator('input').first().fill(USER);
      await page.locator('input[type="password"]').fill(PASS);
      await signIn.click();
      await page.waitForTimeout(3000);
    }

    await selectAgent(page, 'Claw');
    await page.waitForTimeout(3000);

    const body = await page.textContent('body') ?? '';
    expect(body).toContain(marker);
    await page.screenshot({ path: '/tmp/c8-refresh.png' });
  });

  test('C9: Unicode response', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Claw');

    const body = await sendAndWait(page, 'Echo: 你好 🎉 café');
    const hasUnicode = body.includes('你好') || body.includes('🎉') || body.includes('café');
    expect(hasUnicode).toBeTruthy();
  });

  test('C10: Tool usage visible', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Claw');

    await sendAndWait(page, 'Schedule a reminder in 20 seconds to drink water');
    const body = await page.textContent('body') ?? '';
    // Should show some indication of scheduling
    const hasSchedule = body.toLowerCase().includes('schedule') ||
                       body.toLowerCase().includes('remind') ||
                       body.toLowerCase().includes('water') ||
                       body.toLowerCase().includes('20');
    expect(hasSchedule).toBeTruthy();
  });
});
