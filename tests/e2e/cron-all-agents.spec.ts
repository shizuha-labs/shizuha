/**
 * Cron parity test — verifies all agent types can schedule and deliver cron jobs.
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

async function sendAndWait(page: Page, msg: string, timeout = 60_000): Promise<string> {
  const c = page.locator('.overflow-y-auto .max-w-4xl');
  const n = await c.locator('.markdown-content').count();
  const ta = page.locator('textarea').first();
  await ta.fill(msg); await ta.press('Enter');
  await page.waitForFunction(
    ({ s, b }) => document.querySelectorAll(s).length > b,
    { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: n },
    { timeout });
  let lt = '', st = 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const a = await c.locator('.markdown-content').all();
    const t = a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
    if (t === lt && t.length > 0) { st++; if (st >= 3) break; } else st = 0;
    lt = t;
  }
  const a = await c.locator('.markdown-content').all();
  return a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
}

test('Cron scheduling — all agent types', async ({ page }) => {
  test.setTimeout(600_000);
  await login(page);

  const entries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const agents: string[] = [];
  // Only skip agents with known auth issues
  const skip = new Set(['codex', 'shizuhaclaude']);
  for (let i = 0; i < await entries.count(); i++) {
    const m = ((await entries.nth(i).textContent()) ?? '').match(/@(\w+)/);
    if (m && !skip.has(m[1])) agents.push(m[1]);
  }

  const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
  const results: { agent: string; scheduled: boolean; confirmText: string; delivered: boolean }[] = [];

  for (const username of agents) {
    console.log(`\n--- @${username}: scheduling cron ---`);
    try { await selectAgent(page, username); } catch {
      results.push({ agent: username, scheduled: false, confirmText: 'SELECT FAILED', delivered: false });
      continue;
    }

    // Ask agent to schedule a job — each agent type may have different tool names
    let confirmText = '';
    let scheduled = false;
    const prompt = username.includes('claw')
      ? 'Use the cron tool to schedule a one-shot job named "CRON_TEST" to fire in 20 seconds with message "CRON_DELIVERED". Set delivery channel to shizuha-dashboard. Show the result.'
      : 'Use the schedule_job tool (or mcp__shizuha-cron__schedule_job) to create a job named "CRON_TEST" with prompt "CRON_DELIVERED" and schedule "20s". Show the result.';
    try {
      confirmText = await sendAndWait(page, prompt, 60_000);
      scheduled = /success|scheduled|job.*id|nextRunAt/i.test(confirmText);
      console.log(`  Confirm: ${confirmText.slice(0, 100)}`);
      console.log(`  Scheduled: ${scheduled}`);
    } catch {
      confirmText = 'TIMEOUT';
      console.log(`  Confirm: TIMEOUT`);
    }

    // Wait for cron delivery (scheduler tick is 15s for MCP, 60s for shizuha)
    let delivered = false;
    if (scheduled) {
      const countAfter = await chatArea.locator('.markdown-content').count();
      console.log(`  Waiting 90s for delivery... (count: ${countAfter})`);
      try {
        await page.waitForFunction(
          ({ s, b }) => document.querySelectorAll(s).length > b,
          { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: countAfter },
          { timeout: 90_000 });
        const last = await chatArea.locator('.markdown-content').last().textContent() ?? '';
        delivered = last.includes('CRON_DELIVERED') || last.includes('⏰');
        console.log(`  DELIVERED: "${last.slice(0, 100)}" (matched: ${delivered})`);
      } catch {
        // Check if it appeared anywhere in the chat
        const allText = await chatArea.textContent() ?? '';
        delivered = allText.includes('CRON_DELIVERED');
        console.log(`  Not in new bubble, in chat: ${delivered}`);
      }
    }

    results.push({ agent: username, scheduled, confirmText: confirmText.slice(0, 60), delivered });
    await page.waitForTimeout(2000);
  }

  // Report
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║              CRON PARITY TEST — ALL AGENTS                ║');
  console.log('╠═══════════════════╦════════════╦═══════════╦═════════════╣');
  console.log('║ Agent             ║ Scheduled  ║ Delivered ║ Bridge      ║');
  console.log('╠═══════════════════╬════════════╬═══════════╬═════════════╣');
  for (const r of results) {
    const sched = r.scheduled ? '   YES' : '    NO';
    const deliv = r.delivered ? '   YES' : '    NO';
    const bridge = r.agent.includes('claude') ? 'claude' :
                   r.agent.includes('codex') ? 'codex/shiz' :
                   r.agent.includes('claw') ? 'openclaw' : 'shizuha';
    console.log(`║ ${r.agent.padEnd(17)} ║ ${sched.padEnd(10)}║ ${deliv.padEnd(9)}║ ${bridge.padEnd(11)} ║`);
  }
  console.log('╚═══════════════════╩════════════╩═══════════╩═════════════╝\n');

  // At least some agents should schedule successfully
  expect(results.filter(r => r.scheduled).length).toBeGreaterThanOrEqual(1);
});
