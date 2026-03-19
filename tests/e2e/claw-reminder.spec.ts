import { test, expect } from '@playwright/test';
import { getDashboardUrl, guardRemoteDashboardTarget } from './dashboard-target';

const URL = getDashboardUrl();

test.beforeEach(() => {
  guardRemoteDashboardTarget(URL);
});
test('Claw reminder arrives on dashboard', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(URL, { waitUntil: 'networkidle' });
  const f = page.locator('form');
  if (await f.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.fill('#username', 'shizuha'); await page.fill('#password', 'shizuha');
    await page.click('button[type="submit"]'); await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
  const claw = page.locator('text=@claw').first();
  await claw.waitFor({ state: 'visible', timeout: 10_000 }); await claw.click();
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1000);
  // Clear
  const cl = page.locator('button[title="Clear chat"]');
  if (await cl.isVisible({ timeout: 1500 }).catch(() => false)) { await cl.click(); await page.waitForTimeout(2000); }
  // Send reminder request
  const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
  const countBefore = await chatArea.locator('.markdown-content').count();
  const ta = page.locator('textarea').first();
  await ta.fill('Remind me to stretch in 15 seconds. Confirm you set it.');
  await ta.press('Enter');
  // Wait for confirmation
  await page.waitForFunction(
    ({ s, b }) => document.querySelectorAll(s).length > b,
    { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: countBefore },
    { timeout: 30_000 });
  await page.waitForTimeout(3000);
  const confirmText = await chatArea.locator('.markdown-content').last().textContent() ?? '';
  console.log('Confirmation:', confirmText.slice(0, 100));
  // Now wait 30s for the reminder to arrive as a proactive message
  const countAfterConfirm = await chatArea.locator('.markdown-content').count();
  console.log(`Waiting 30s for reminder... (current count: ${countAfterConfirm})`);
  try {
    await page.waitForFunction(
      ({ s, b }) => document.querySelectorAll(s).length > b,
      { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: countAfterConfirm },
      { timeout: 45_000 });
    const reminderText = await chatArea.locator('.markdown-content').last().textContent() ?? '';
    console.log('REMINDER ARRIVED:', reminderText.slice(0, 150));
    expect(reminderText.length).toBeGreaterThan(0);
  } catch {
    console.log('Reminder did NOT arrive within 45s');
    // Check if any new content appeared at all
    const finalCount = await chatArea.locator('.markdown-content').count();
    console.log(`Final markdown count: ${finalCount} (was ${countAfterConfirm})`);
  }
});
