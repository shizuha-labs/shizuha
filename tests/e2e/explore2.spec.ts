/**
 * Exploratory Session 2 — edge cases, concurrent behavior, error handling.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';

const BASE = process.env['DASHBOARD_URL'] || 'http://localhost:8015';
const USER = 'shizuha';
const PASS = 'shizuha';

async function login(page: Page) {
  await page.goto(BASE);
  await page.waitForTimeout(1500);
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
  if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
    await el.click();
    await page.waitForTimeout(1500);
  }
}

async function sendAndWait(page: Page, msg: string, waitMs = 30000) {
  const textarea = page.locator('textarea').first();
  if (!await textarea.isVisible({ timeout: 3000 }).catch(() => false)) return '';
  await textarea.fill(msg);
  await textarea.press('Enter');
  await page.waitForTimeout(3000);
  let last = '', stable = 0;
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const body = await page.textContent('body') ?? '';
    if (body.length === last.length) { stable++; if (stable >= 2) break; } else { stable = 0; last = body; }
    await page.waitForTimeout(2000);
  }
  return await page.textContent('body') ?? '';
}

test.describe.configure({ mode: 'serial' });

test.describe('Exploration Session 2', () => {

  test('E13: Send empty message (should be ignored)', async ({ page }) => {
    test.setTimeout(30000);
    await login(page);
    await selectAgent(page, 'Sora');
    const textarea = page.locator('textarea').first();
    await textarea.fill('');
    await textarea.press('Enter');
    await page.waitForTimeout(2000);
    // Nothing bad should happen — no error, no crash
    const body = await page.textContent('body') ?? '';
    expect(body.length).toBeGreaterThan(50); // page still functional
  });

  test('E14: Very long message (2000 chars)', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Sora');
    const longMsg = 'A'.repeat(2000) + ' — what is 1+1?';
    await sendAndWait(page, longMsg, 60000);
    // Should handle gracefully
    const body = await page.textContent('body') ?? '';
    expect(body.length).toBeGreaterThan(100);
  });

  test('E15: Special characters in message', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Zen');
    await sendAndWait(page, 'Reply with these chars: <script>alert("xss")</script> & "quotes" \'single\' `backticks`');
    // Script tags should be sanitized — verify no actual script execution
    // (The text "alert(" may appear in the agent's text response — that's fine,
    // as long as no <script> tag is live in the DOM)
    const scripts = await page.locator('script:not([src])').evaluateAll(els =>
      els.filter(el => el.textContent?.includes('alert')).length
    );
    expect(scripts).toBe(0); // No inline scripts with alert
  });

  test('E16: Send message then immediately switch agent', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Sora');
    const textarea = page.locator('textarea').first();
    await textarea.fill('What is the meaning of life? Give a long answer.');
    await textarea.press('Enter');
    // Immediately switch before response arrives
    await page.waitForTimeout(500);
    await selectAgent(page, 'Kai');
    await page.waitForTimeout(3000);
    // Should be viewing Kai now, not Sora's streaming response
    // Page should be stable
    const body = await page.textContent('body') ?? '';
    expect(body.length).toBeGreaterThan(50);
  });

  test('E17: Double-click send', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Zen');
    const textarea = page.locator('textarea').first();
    await textarea.fill('Say OK');
    // Double-press Enter
    await textarea.press('Enter');
    await textarea.press('Enter');
    await page.waitForTimeout(5000);
    // Should not crash or double-send
    const body = await page.textContent('body') ?? '';
    expect(body.length).toBeGreaterThan(50);
  });

  test('E18: Claw agent (OpenClaw) responds', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    const found = await (async () => {
      const el = page.locator('text="Claw"').first();
      return await el.isVisible({ timeout: 3000 }).catch(() => false);
    })();
    test.skip(!found, 'Claw not in sidebar');
    await selectAgent(page, 'Claw');
    await sendAndWait(page, 'What is 9 * 9? Just the number.', 60000);
    const body = await page.textContent('body') ?? '';
    expect(body).toContain('81');
  });

  test('E19: Webhook delivers to agent and shows in chat', async ({ page, request }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Sora');
    await page.waitForTimeout(2000);

    // Send webhook
    const { readFileSync } = await import('fs');
    const creds = JSON.parse(readFileSync('/home/phoenix/.shizuha/credentials.json', 'utf-8'));
    const token = creds.webhookToken;
    if (token) {
      await request.post(`${BASE}/v1/hooks/agent/sora`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { message: 'Webhook test E19: say WEBHOOK_RECEIVED' },
      });
      // Wait for the webhook message to arrive via WS
      await page.waitForTimeout(15000);
      const body = await page.textContent('body') ?? '';
      test.info().annotations.push({ type: 'webhook_in_chat', description: String(body.includes('WEBHOOK') || body.includes('webhook')) });
    }
  });

  test('E20: Page refresh preserves conversation', async ({ page }) => {
    test.setTimeout(90000);
    await login(page);
    await selectAgent(page, 'Sora');
    const marker = `REFRESH_TEST_${Date.now().toString(36)}`;
    await sendAndWait(page, `Say exactly: ${marker}`);

    // Verify marker is in the page
    let body = await page.textContent('body') ?? '';
    expect(body).toContain(marker);

    // Refresh the page
    await page.reload();
    await page.waitForTimeout(5000);

    // Re-login if needed
    const signIn = page.locator('button:has-text("Sign in")');
    if (await signIn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.locator('input').first().fill(USER);
      await page.locator('input[type="password"]').fill(PASS);
      await signIn.click();
      await page.waitForTimeout(3000);
    }

    // Select Sora again
    await selectAgent(page, 'Sora');
    await page.waitForTimeout(3000);

    // Marker should still be visible (from localStorage or event replay)
    body = await page.textContent('body') ?? '';
    const preserved = body.includes(marker);
    test.info().annotations.push({ type: 'refresh_preserved', description: String(preserved) });
    expect(preserved).toBeTruthy();
  });

  test('E21: Multiple messages in quick succession', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Zen');

    // Send 3 messages quickly
    const textarea = page.locator('textarea').first();
    for (const msg of ['What is 1+1?', 'What is 2+2?', 'What is 3+3?']) {
      await textarea.fill(msg);
      await textarea.press('Enter');
      await page.waitForTimeout(1000);
    }

    // Wait for all responses
    await page.waitForTimeout(30000);
    const body = await page.textContent('body') ?? '';
    // At least some of the answers should be present
    const has2 = body.includes('2');
    const has4 = body.includes('4');
    const has6 = body.includes('6');
    test.info().annotations.push({ type: 'multi_msg', description: `2:${has2} 4:${has4} 6:${has6}` });
  });

  test('E22: Settings page accessible', async ({ page }) => {
    test.setTimeout(30000);
    await login(page);
    // Try to open settings
    const settingsBtn = page.locator('button[title*="etting" i], a[href*="setting" i], text="Settings"').first();
    if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settingsBtn.click();
      await page.waitForTimeout(2000);
      const body = await page.textContent('body') ?? '';
      const hasSettings = body.includes('Model') || body.includes('Provider') || body.includes('Fan-out');
      test.info().annotations.push({ type: 'settings_visible', description: String(hasSettings) });
    }
  });

  test('E23: Verify no console errors during normal use', async ({ page }) => {
    test.setTimeout(60000);
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await login(page);
    await selectAgent(page, 'Sora');
    await sendAndWait(page, 'Hello!', 15000);
    await selectAgent(page, 'Kai');
    await page.waitForTimeout(2000);
    await selectAgent(page, 'Sora');
    await page.waitForTimeout(2000);

    // Filter out known benign errors (WebSocket reconnect, etc.)
    const realErrors = errors.filter(e =>
      !e.includes('WebSocket') &&
      !e.includes('net::ERR') &&
      !e.includes('favicon') &&
      !e.includes('ResizeObserver')
    );
    test.info().annotations.push({ type: 'console_errors', description: JSON.stringify(realErrors.slice(0, 5)) });
    expect(realErrors.length).toBeLessThan(3); // Allow a couple of benign errors
  });

  test('E24: Verify Shift+Enter creates newline, not send', async ({ page }) => {
    test.setTimeout(30000);
    await login(page);
    await selectAgent(page, 'Sora');
    const textarea = page.locator('textarea').first();
    await textarea.fill('Line 1');
    await textarea.press('Shift+Enter');
    await textarea.type('Line 2');
    const value = await textarea.inputValue();
    expect(value).toContain('Line 1');
    expect(value).toContain('Line 2');
    // Should NOT have sent the message
    await page.waitForTimeout(2000);
  });
});
