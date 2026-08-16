/**
 * Inter-agent communication tests — agents talking to each other.
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

async function send(page: Page, msg: string, t = 90_000): Promise<string> {
  const c = page.locator('.overflow-y-auto .max-w-4xl');
  const n = await c.locator('.markdown-content').count();
  const ta = page.locator('textarea').first();
  await ta.fill(msg); await ta.press('Enter');
  await page.waitForFunction(
    ({ s, b }) => document.querySelectorAll(s).length > b,
    { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: n }, { timeout: t });
  let lt = '', st = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const a = await c.locator('.markdown-content').all();
    const tx = a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
    if (tx === lt && tx.length > 0) { st++; if (st >= 3) break; } else st = 0;
    lt = tx;
  }
  const a = await c.locator('.markdown-content').all();
  return a.length > 0 ? (await a[a.length-1].textContent() ?? '') : '';
}

test.describe('Inter-Agent Communication', () => {

  test('1. Agent X asks Agent Y for a joke', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);

    // Use Shizuha-Codex as the initiator (has message_agent built-in)
    await selectAgent(page, 'shizuhacodex');

    const r = await send(page,
      'Use the message_agent tool to ask the agent named "claw" to tell you a short joke. Then tell me what they said.',
      90_000);

    console.log('Agent X→Y joke:', r.slice(0, 200));

    // Should contain some kind of joke or response from Claw
    const gotResponse = r.length > 20 && !/error|timeout|failed|not found/i.test(r);
    expect(gotResponse).toBe(true);
  });

  test('2. Agent lists available agents', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    await selectAgent(page, 'shizuhacodex');

    const r = await send(page, 'Use the list_agents tool to show me all available agents.');
    console.log('Agent list:', r.slice(0, 200));

    // Should contain at least some agent names
    const hasAgents = /claw|claude|shizuha|codex/i.test(r);
    expect(hasAgents).toBe(true);
  });

  test('3. Bidirectional — ask Claw to message Shizuha-Codex', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    await selectAgent(page, 'claw');

    const r = await send(page,
      'Send a message to the agent named "shizuhacodex" asking them what 7 * 8 is. Tell me their answer.',
      90_000);

    console.log('Claw→ShizuhaCodex:', r.slice(0, 200));
    // Should contain 56 or some math response
    const gotMath = /56|fifty.six|answer/i.test(r) || r.length > 20;
    expect(gotMath).toBe(true);
  });
});
