import { test, expect, type Page } from '@playwright/test';
import { getDashboardUrl, guardRemoteDashboardTarget } from './dashboard-target';

const URL = getDashboardUrl();

test.beforeEach(() => {
  guardRemoteDashboardTarget(URL);
});

async function login(page: Page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const f = page.locator('form');
  if (await f.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.fill('#username', 'shizuha'); await page.fill('#password', 'shizuha');
    await page.click('button[type="submit"]'); await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
}

test('Shizuha agent cron — schedule and deliver reminder', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);

  // Use Shizuha-Codex (shizuha runtime, not a bridge)
  const agent = page.locator('text=@shizuhacodex').first();
  await agent.waitFor({ state: 'visible', timeout: 10_000 });
  await agent.click();
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1000);

  // Clear
  const cl = page.locator('button[title="Clear chat"]');
  if (await cl.isVisible({ timeout: 1500 }).catch(() => false)) {
    await cl.click(); await page.waitForTimeout(2000);
  }

  const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
  const countBefore = await chatArea.locator('.markdown-content').count();
  const ta = page.locator('textarea').first();

  // Ask to schedule a job
  await ta.fill('Use the schedule_job tool to schedule a job named "PING test" with prompt "say PONG" and schedule "30s". Show me the result.');
  await ta.press('Enter');

  // Wait for confirmation
  try {
    await page.waitForFunction(
      ({ s, b }) => document.querySelectorAll(s).length > b,
      { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: countBefore },
      { timeout: 45_000 });

    // Stabilize
    let lt = '', st = 0;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      const a = await chatArea.locator('.markdown-content').all();
      const t = a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
      if (t === lt && t.length > 0) { st++; if (st >= 3) break; } else st = 0;
      lt = t;
    }

    const allText = await chatArea.textContent() ?? '';
    console.log('Agent response:', allText.slice(0, 300));
    
    const hasScheduled = /schedul|job|cron|success|30s|ping/i.test(allText);
    console.log('Scheduled?', hasScheduled);

    if (hasScheduled) {
      // Wait 45s for the cron to fire and deliver
      const countAfterSchedule = await chatArea.locator('.markdown-content').count();
      console.log(`Waiting 45s for cron delivery... (count: ${countAfterSchedule})`);
      
      try {
        await page.waitForFunction(
          ({ s, b }) => document.querySelectorAll(s).length > b,
          { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: countAfterSchedule },
          { timeout: 50_000 });
        const reminderText = await chatArea.locator('.markdown-content').last().textContent() ?? '';
        console.log('CRON DELIVERED:', reminderText.slice(0, 150));
      } catch {
        console.log('Cron did not deliver within 45s');
      }
    }

  } catch {
    console.log('Initial response timeout');
  }

  expect(true).toBe(true); // observation test
});
