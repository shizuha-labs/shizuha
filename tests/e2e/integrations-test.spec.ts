/**
 * Integration skills test — verify GitHub, Notion, Trello, Spotify guides are available.
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

async function pick(page: Page, u: string) {
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

async function send(page: Page, msg: string, t = 60_000): Promise<string> {
  const c = page.locator('.overflow-y-auto .max-w-4xl');
  const n = await c.locator('.markdown-content').count();
  const ta = page.locator('textarea').first();
  await ta.fill(msg); await ta.press('Enter');
  await page.waitForFunction(
    ({ s, b }) => document.querySelectorAll(s).length > b,
    { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: n }, { timeout: t });
  let lt = '', st = 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const a = await c.locator('.markdown-content').all();
    const tx = a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
    if (tx === lt && tx.length > 0) { st++; if (st >= 3) break; } else st = 0;
    lt = tx;
  }
  const a = await c.locator('.markdown-content').all();
  return a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
}

test('Integration skills available across agents', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  const agents = ['shizuhacodex', 'claw'];
  const integrations = ['github', 'notion', 'trello', 'spotify'];
  const results: { agent: string; integration: string; available: boolean }[] = [];

  for (const agent of agents) {
    await pick(page, agent);

    for (const integ of integrations) {
      try {
        const r = await send(page,
          `Do you know how to use ${integ}? Show me one example command or API call.`,
          30_000);
        const available = r.length > 20 && !/don't know|not available|cannot/i.test(r);
        console.log(`@${agent} ${integ}: ${available ? 'YES' : 'NO'} — "${r.slice(0, 60)}"`);
        results.push({ agent, integration: integ, available });
      } catch {
        results.push({ agent, integration: integ, available: false });
      }
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);
  }

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║         INTEGRATION SKILLS AVAILABILITY               ║');
  console.log('╠═══════════════════╦══════════╦══════════╦════════════╣');
  console.log('║ Integration       ║ Shiz-Cdx ║ Claw     ║ Status     ║');
  console.log('╠═══════════════════╬══════════╬══════════╬════════════╣');
  for (const integ of integrations) {
    const s = results.find(r => r.agent === 'shizuhacodex' && r.integration === integ);
    const c = results.find(r => r.agent === 'claw' && r.integration === integ);
    console.log(`║ ${integ.padEnd(17)} ║ ${(s?.available ? '  YES' : '   NO').padEnd(8)}║ ${(c?.available ? '  YES' : '   NO').padEnd(8)}║ ${(s?.available || c?.available ? 'available' : 'missing').padEnd(10)} ║`);
  }
  console.log('╚═══════════════════╩══════════╩══════════╩════════════╝\n');

  expect(results.filter(r => r.available).length).toBeGreaterThanOrEqual(4);
});
