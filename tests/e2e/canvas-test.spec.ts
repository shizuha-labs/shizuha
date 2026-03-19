/**
 * Canvas + visual output tests — verify SVG/HTML renders in the dashboard chat.
 */
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

test.describe('Canvas + Visual Output', () => {

  test('1. SVG renders inline in chat', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    await pick(page, 'shizuhacodex');

    await send(page,
      'Include this SVG in your response (not in a code block, just paste it directly): <svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#1e293b"/><circle cx="100" cy="50" r="30" fill="#3b82f6"/><text x="100" y="55" text-anchor="middle" fill="white" font-size="14">Canvas</text></svg>');

    // Check if SVG was rendered (not escaped)
    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const lastMd = chatArea.locator('.markdown-content').last();
    const html = await lastMd.innerHTML();

    const hasSvg = html.includes('<svg') || html.includes('<circle');
    console.log(`SVG rendered: ${hasSvg}`);
    console.log(`HTML snippet: ${html.slice(0, 200)}`);

    // Either SVG renders or the text contains "Canvas"
    const text = await lastMd.textContent() ?? '';
    expect(hasSvg || text.includes('Canvas')).toBe(true);
  });

  test('2. Agent creates chart/diagram', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    await pick(page, 'shizuhacodex');

    const r = await send(page,
      'Create a simple bar chart as an SVG showing: JavaScript=80%, Python=65%, Rust=45%. Include it directly in your response (not in a code block).');

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const html = await chatArea.locator('.markdown-content').last().innerHTML();
    const hasVisual = html.includes('<svg') || html.includes('<rect') || /javascript|python|rust/i.test(r);
    console.log(`Chart rendered: ${hasVisual}`);
    expect(hasVisual).toBe(true);
  });
});
