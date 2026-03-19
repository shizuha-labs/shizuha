/**
 * Dashboard Resilience Tests — real-life scenarios stressing the browser↔agent stack.
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
  if (await e.isVisible({ timeout: 5000 }).catch(() => false)) {
    await e.click();
    await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(500);
  }
}

async function send(page: Page, msg: string, t = 45_000): Promise<string> {
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

async function agent(page: Page): Promise<string> {
  const e = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const skip = new Set(['codex', 'shizuhaclaude']);
  for (let i = 0; i < await e.count(); i++) {
    const m = ((await e.nth(i).textContent()) ?? '').match(/@(\w+)/);
    if (m && !skip.has(m[1])) return m[1];
  }
  return 'shizuha';
}

test.describe('Dashboard Resilience', () => {
  test('1. WS drop → reconnect → messages work', async ({ page }) => {
    test.setTimeout(60_000); await login(page);
    await pick(page, await agent(page));
    expect((await send(page, 'say: BEFORE')).length).toBeGreaterThan(0);
    await page.evaluate(() => { (window as any).__shizuhaWs?.close(); });
    await page.waitForTimeout(6000);
    expect((await send(page, 'say: AFTER')).length).toBeGreaterThan(0);
  });

  test('2. 5x rapid WS drops — recovers', async ({ page }) => {
    test.setTimeout(60_000); await login(page);
    await pick(page, await agent(page));
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => { (window as any).__shizuhaWs?.close(); });
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(8000);
    expect((await send(page, 'say: SURVIVED')).length).toBeGreaterThan(0);
  });

  test('3. Page refresh — no crash', async ({ page }) => {
    test.setTimeout(60_000); await login(page);
    await pick(page, await agent(page));
    await send(page, 'say hi');
    await page.reload({ waitUntil: 'networkidle' }); await login(page);
    const err: string[] = []; page.on('pageerror', e => err.push(e.message));
    await page.waitForTimeout(2000);
    expect(err.length).toBe(0);
    expect(await page.locator('textarea').first().isVisible({ timeout: 10_000 })).toBe(true);
  });

  test('4. Switch agent mid-stream — stable', async ({ page }) => {
    test.setTimeout(60_000); await login(page);
    const e = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
    const skip = new Set(['codex', 'shizuhaclaude']);
    const w: string[] = [];
    for (let i = 0; i < await e.count(); i++) {
      const m = ((await e.nth(i).textContent()) ?? '').match(/@(\w+)/);
      if (m && !skip.has(m[1])) w.push(m[1]);
    }
    if (w.length < 2) test.skip(true, 'Need 2 agents');
    await pick(page, w[0]);
    const ta = page.locator('textarea').first();
    await ta.fill('Write a 200 word essay.'); await ta.press('Enter');
    await page.waitForTimeout(1500);
    await pick(page, w[1]);
    await page.waitForTimeout(2000);
    expect(await ta.isVisible()).toBe(true);
  });

  test('5. Network offline → online — reconnects', async ({ page, context }) => {
    test.setTimeout(60_000); await login(page);
    await pick(page, await agent(page));
    await context.setOffline(true); await page.waitForTimeout(3000);
    await context.setOffline(false); await page.waitForTimeout(8000);
    expect((await send(page, 'say: ONLINE')).length).toBeGreaterThan(0);
  });

  test('6. Empty messages rejected', async ({ page }) => {
    test.setTimeout(30_000); await login(page);
    await pick(page, await agent(page));
    const c = page.locator('.overflow-y-auto .max-w-4xl');
    const n = await c.locator('.markdown-content').count();
    const ta = page.locator('textarea').first();
    await ta.fill(''); await ta.press('Enter'); await page.waitForTimeout(500);
    await ta.fill('   '); await ta.press('Enter'); await page.waitForTimeout(500);
    expect(await c.locator('.markdown-content').count()).toBe(n);
  });

  test('7. Two tabs fan-out', async ({ page, browser }) => {
    test.setTimeout(90_000); await login(page);
    const a = await agent(page); await pick(page, a);
    const cl = page.locator('button[title="Clear chat"]');
    if (await cl.isVisible({ timeout: 1500 }).catch(() => false)) {
      await cl.click(); await page.waitForTimeout(1000);
    }
    const ctx2 = await browser.newContext({ storageState: await page.context().storageState() });
    const p2 = await ctx2.newPage();
    await p2.goto(URL, { waitUntil: 'networkidle' }); await p2.waitForTimeout(3000);
    await pick(p2, a); await p2.waitForTimeout(2000);
    await send(page, `say: FANOUT_${Date.now()}`);
    await p2.waitForTimeout(5000);
    expect((await p2.locator('.overflow-y-auto .max-w-4xl').textContent() ?? '').length).toBeGreaterThan(0);
    await ctx2.close();
  });

  test('8. Keyboard shortcuts — no crash', async ({ page }) => {
    test.setTimeout(30_000); await login(page);
    await pick(page, await agent(page));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page.keyboard.press('Control+f'); await page.waitForTimeout(200);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    const ta = page.locator('textarea').first();
    expect(await ta.isVisible()).toBe(true);
    await ta.fill('test'); expect(await ta.inputValue()).toBe('test');
  });

  test('9. Send right after load — no race', async ({ page }) => {
    test.setTimeout(60_000); await login(page);
    await pick(page, await agent(page));
    await page.reload({ waitUntil: 'networkidle' }); await login(page);
    const ta = page.locator('textarea').first();
    await ta.waitFor({ state: 'visible', timeout: 15_000 });
    await ta.fill('say: FAST'); await ta.press('Enter');
    const r = page.locator('.overflow-y-auto .max-w-4xl .markdown-content');
    await r.first().waitFor({ state: 'visible', timeout: 30_000 });
    expect((await r.first().textContent() ?? '').length).toBeGreaterThan(0);
  });

  test('10. Health endpoint always up', async ({ page }) => {
    test.setTimeout(20_000); await login(page);
    const h = await page.request.get(`${URL}/health`);
    expect(h.ok()).toBe(true);
    expect((await h.json()).agents).toBeGreaterThanOrEqual(1);
    const err: string[] = []; page.on('pageerror', e => err.push(e.message));
    await page.waitForTimeout(2000); expect(err.length).toBe(0);
  });

  test('11. Back/forward navigation — SPA survives', async ({ page }) => {
    test.setTimeout(20_000); await login(page);
    await page.goBack().catch(() => {}); await page.waitForTimeout(1000);
    await page.goForward().catch(() => {}); await page.waitForTimeout(1000);
    expect((await page.locator('body').textContent() ?? '').length).toBeGreaterThan(0);
  });

  test('12. Long message input', async ({ page }) => {
    test.setTimeout(60_000); await login(page);
    await pick(page, await agent(page));
    const r = await send(page, 'X'.repeat(1500) + '. How many Xs? Just the number.', 60_000);
    expect(r.length).toBeGreaterThan(0); expect(r).toMatch(/\d/);
  });

  test('13. Fresh session immediately replays existing history', async ({ browser, request }) => {
    test.setTimeout(90_000);

    const marker = `REPLAY_BOOT_${Date.now()}`;
    const ask = await request.post(`${URL}/v1/agents/shizuha/ask`, {
      data: { content: `Say exactly: ${marker}`, timeout: 60_000 },
    });
    expect(ask.ok()).toBe(true);
    const askBody = await ask.json() as { response?: string };
    expect(askBody.response).toContain(marker);

    const context = await browser.newContext({ baseURL: URL });
    const page = await context.newPage();
    const loginRes = await context.request.post('/v1/dashboard/login', {
      data: { username: U, password: P },
    });
    expect(loginRes.ok()).toBe(true);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('text=@shizuha').first().click();

    const transcript = page.locator('.overflow-y-auto .max-w-4xl').last();
    await expect(transcript).toContainText(marker, { timeout: 20_000 });
    await expect(page.locator('text=Interactive Coding Agent')).toHaveCount(0);

    await context.close();
  });
});
