/**
 * Reminder test — asks each agent to remind/respond after a delay.
 * Tests whether agents can deliver proactive messages back to the dashboard.
 */
import { test, expect, type Page } from '@playwright/test';
import { getDashboardUrl, guardRemoteDashboardTarget } from './dashboard-target';

const URL = getDashboardUrl();
const U = process.env.DASHBOARD_USER || 'shizuha';
const P = process.env.DASHBOARD_PASS || 'shizuha';

test.beforeEach(() => {
  guardRemoteDashboardTarget(URL);
});

async function login(page: Page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const f = page.locator('form');
  if (await f.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.fill('#username', U); await page.fill('#password', P);
    await page.click('button[type="submit"]'); await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
}

async function selectAgent(page: Page, username: string) {
  const e = page.locator(`text=@${username}`).first();
  await e.waitFor({ state: 'visible', timeout: 10_000 });
  await e.click();
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
  const cl = page.locator('button[title="Clear chat"]');
  if (await cl.isVisible({ timeout: 1500 }).catch(() => false)) {
    await cl.click(); await page.waitForTimeout(2000);
  }
}

test('Reminder/delayed response — all agents', async ({ page }) => {
  test.setTimeout(600_000);
  await login(page);

  const entries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const agents: string[] = [];
  const skip = new Set(['codex', 'shizuhaclaude']);
  for (let i = 0; i < await entries.count(); i++) {
    const m = ((await entries.nth(i).textContent()) ?? '').match(/@(\w+)/);
    if (m && !skip.has(m[1])) agents.push(m[1]);
  }

  const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
  const results: { agent: string; confirmed: boolean; confirmText: string; reminderArrived: boolean; reminderText: string }[] = [];

  for (const username of agents) {
    console.log(`\n--- Testing @${username} ---`);
    try {
      await selectAgent(page, username);
    } catch {
      results.push({ agent: username, confirmed: false, confirmText: 'FAILED TO SELECT', reminderArrived: false, reminderText: '' });
      continue;
    }

    // Ask for a reminder in 10 seconds
    const countBefore = await chatArea.locator('.markdown-content').count();
    const ta = page.locator('textarea').first();
    await ta.fill('I need you to respond to me exactly 10 seconds from now with the word PING. First confirm you understand, then after 10 seconds send PING.');
    await ta.press('Enter');

    // Wait for confirmation response
    let confirmed = false;
    let confirmText = '';
    try {
      await page.waitForFunction(
        ({ s, b }) => document.querySelectorAll(s).length > b,
        { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: countBefore },
        { timeout: 45_000 });

      // Wait for text to stabilize
      let lt = '', st = 0;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        const a = await chatArea.locator('.markdown-content').all();
        const t = a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
        if (t === lt && t.length > 0) { st++; if (st >= 3) break; } else st = 0;
        lt = t;
      }

      const a = await chatArea.locator('.markdown-content').all();
      confirmText = a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
      confirmed = confirmText.length > 0;
      console.log(`  Confirmation: "${confirmText.slice(0, 100)}"`);
    } catch {
      confirmText = 'TIMEOUT';
      console.log(`  Confirmation: TIMEOUT`);
    }

    // Now wait 20s for the delayed PING to arrive
    const countAfterConfirm = await chatArea.locator('.markdown-content').count();
    let reminderArrived = false;
    let reminderText = '';

    console.log(`  Waiting 20s for delayed PING... (count: ${countAfterConfirm})`);
    try {
      await page.waitForFunction(
        ({ s, b }) => document.querySelectorAll(s).length > b,
        { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: countAfterConfirm },
        { timeout: 25_000 });
      const a = await chatArea.locator('.markdown-content').all();
      reminderText = a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
      reminderArrived = true;
      console.log(`  DELAYED RESPONSE ARRIVED: "${reminderText.slice(0, 100)}"`);
    } catch {
      console.log(`  No delayed response within 20s`);
    }

    results.push({ agent: username, confirmed, confirmText: confirmText.slice(0, 80), reminderArrived, reminderText: reminderText.slice(0, 80) });
  }

  // Report
  console.log('\n╔════════════════════════════════════════════════════════════════════╗');
  console.log('║           DELAYED RESPONSE TEST — ALL AGENTS                     ║');
  console.log('╠═══════════════════╦════════════╦═══════════════╦═════════════════╣');
  console.log('║ Agent             ║ Confirmed  ║ Delayed Reply ║ Notes           ║');
  console.log('╠═══════════════════╬════════════╬═══════════════╬═════════════════╣');

  for (const r of results) {
    const conf = r.confirmed ? '    YES' : '     NO';
    const delayed = r.reminderArrived ? '      YES' : '       NO';
    const notes = r.reminderArrived ? 'proactive works' : (r.confirmed ? 'no proactive' : 'broken');
    console.log(`║ ${r.agent.padEnd(17)} ║ ${conf.padEnd(10)}║ ${delayed.padEnd(13)}║ ${notes.padEnd(15)} ║`);
  }

  console.log('╚═══════════════════╩════════════╩═══════════════╩═════════════════╝\n');

  // At least some agents should confirm
  expect(results.filter(r => r.confirmed).length).toBeGreaterThanOrEqual(2);
});
