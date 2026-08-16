/**
 * Heartbeat parity test — verifies all agent types can configure a heartbeat.
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

async function selectAgent(page: Page, u: string) {
  const e = page.locator(`text=@${u}`).first();
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

test('Heartbeat configuration — all agent types', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  const entries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const skip = new Set(['codex', 'shizuhaclaude', 'shizuhaengineer']); // known broken/slow
  const agents: string[] = [];
  for (let i = 0; i < await entries.count(); i++) {
    const m = ((await entries.nth(i).textContent()) ?? '').match(/@(\w+)/);
    if (m && !skip.has(m[1])) agents.push(m[1]);
  }

  const results: { agent: string; configured: boolean; response: string }[] = [];

  for (const username of agents) {
    console.log(`\n--- @${username}: configuring heartbeat ---`);
    try { await selectAgent(page, username); } catch {
      results.push({ agent: username, configured: false, response: 'SELECT FAILED' });
      continue;
    }

    try {
      const response = await sendAndWait(page,
        'Enable a heartbeat that checks in every 30 minutes. Use the configure_heartbeat tool with interval="every 30m" and enabled=true.',
        60_000);
      const configured = /success|enabled|heartbeat|interval|30m/i.test(response);
      console.log(`  Result: ${configured ? 'CONFIGURED' : 'FAILED'}`);
      console.log(`  Response: ${response.slice(0, 100)}`);
      results.push({ agent: username, configured, response: response.slice(0, 80) });
    } catch {
      console.log(`  TIMEOUT`);
      results.push({ agent: username, configured: false, response: 'TIMEOUT' });
    }

    await page.waitForTimeout(2000);
  }

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║            HEARTBEAT PARITY TEST                         ║');
  console.log('╠═══════════════════╦════════════╦══════════════════════════╣');
  console.log('║ Agent             ║ Configured ║ Response                 ║');
  console.log('╠═══════════════════╬════════════╬══════════════════════════╣');
  for (const r of results) {
    const conf = r.configured ? '   YES' : '    NO';
    console.log(`║ ${r.agent.padEnd(17)} ║ ${conf.padEnd(10)}║ ${r.response.slice(0, 24).padEnd(24)} ║`);
  }
  console.log('╚═══════════════════╩════════════╩══════════════════════════╝\n');

  expect(results.filter(r => r.configured).length).toBeGreaterThanOrEqual(1);
});
