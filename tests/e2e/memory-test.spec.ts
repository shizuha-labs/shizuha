/**
 * Memory parity test — store and recall across agent types.
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

test('Memory store + recall — all agent types', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  const entries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const skip = new Set(['codex', 'shizuhaclaude', 'shizuhaengineer']);
  const agents: string[] = [];
  for (let i = 0; i < await entries.count(); i++) {
    const m = ((await entries.nth(i).textContent()) ?? '').match(/@(\w+)/);
    if (m && !skip.has(m[1])) agents.push(m[1]);
  }

  const marker = `MEM_TEST_${Date.now()}`;
  const results: { agent: string; stored: boolean; recalled: boolean }[] = [];

  for (const username of agents) {
    console.log(`\n--- @${username}: memory test ---`);
    try { await selectAgent(page, username); } catch {
      results.push({ agent: username, stored: false, recalled: false });
      continue;
    }

    // Store a unique memory
    let stored = false;
    try {
      const r = await sendAndWait(page,
        `Remember this fact: "${marker}_${username}" is my secret code. Use the memory tool to store it.`,
        45_000);
      stored = /stored|added|saved|success|remember/i.test(r);
      console.log(`  Stored: ${stored} — "${r.slice(0, 80)}"`);
    } catch {
      console.log(`  Store: TIMEOUT`);
    }

    // Extra wait then recall
    await page.waitForTimeout(3000);

    let recalled = false;
    if (stored) {
      try {
        const r = await sendAndWait(page,
          `What is my secret code? Search your memory for it.`,
          45_000);
        recalled = r.includes(marker) || r.includes('secret code');
        console.log(`  Recalled: ${recalled} — "${r.slice(0, 80)}"`);
      } catch {
        console.log(`  Recall: TIMEOUT`);
      }
    }

    results.push({ agent: username, stored, recalled });
    await page.waitForTimeout(2000);
  }

  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║          MEMORY PARITY TEST                       ║');
  console.log('╠═══════════════════╦══════════╦═══════════╦════════╣');
  console.log('║ Agent             ║ Stored   ║ Recalled  ║ Bridge ║');
  console.log('╠═══════════════════╬══════════╬═══════════╬════════╣');
  for (const r of results) {
    const s = r.stored ? '  YES' : '   NO';
    const rc = r.recalled ? '   YES' : '    NO';
    const b = r.agent.includes('claude') ? 'claude' :
              r.agent.includes('codex') ? 'shiz/cx' :
              r.agent.includes('claw') ? 'openclaw' : 'shizuha';
    console.log(`║ ${r.agent.padEnd(17)} ║ ${s.padEnd(8)}║ ${rc.padEnd(9)}║ ${b.padEnd(6)} ║`);
  }
  console.log('╚═══════════════════╩══════════╩═══════════╩════════╝\n');

  expect(results.filter(r => r.stored).length).toBeGreaterThanOrEqual(1);
});
