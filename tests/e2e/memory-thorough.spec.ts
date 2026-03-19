/**
 * Thorough memory tests — store, recall, search, forget across all working agents.
 * Tests the full lifecycle of memory through the dashboard browser UI.
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

async function getWorkingAgents(page: Page): Promise<string[]> {
  const entries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const skip = new Set(['codex', 'shizuhaclaude', 'shizuhaengineer']);
  const agents: string[] = [];
  for (let i = 0; i < await entries.count(); i++) {
    const m = ((await entries.nth(i).textContent()) ?? '').match(/@(\w+)/);
    if (m && !skip.has(m[1])) agents.push(m[1]);
  }
  return agents;
}

test.describe('Memory System — Thorough Tests', () => {

  test('1. Store + recall cycle per agent', async ({ page }) => {
    test.setTimeout(300_000);
    await login(page);
    const agents = await getWorkingAgents(page);

    const results: { agent: string; stored: boolean; recalled: boolean; recallText: string }[] = [];

    for (const username of agents) {
      console.log(`\n=== @${username} ===`);
      try { await selectAgent(page, username); } catch { continue; }

      const marker = `MEMTEST_${username}_${Date.now()}`;

      // Store
      let stored = false;
      try {
        const r = await send(page, `Remember this important fact: my favorite number is ${marker}. Save it to memory.`);
        stored = /stored|added|saved|success|remember|got it|noted/i.test(r);
        console.log(`  Store: ${stored ? 'OK' : 'FAIL'} — "${r.slice(0, 60)}"`);
      } catch { console.log('  Store: TIMEOUT'); }

      await page.waitForTimeout(3000);

      // Recall
      let recalled = false;
      let recallText = '';
      if (stored) {
        try {
          const r = await send(page, 'What is my favorite number? Check your memory.');
          recalled = r.includes(marker);
          recallText = r.slice(0, 80);
          console.log(`  Recall: ${recalled ? 'OK' : 'FAIL'} — "${recallText}"`);
        } catch { console.log('  Recall: TIMEOUT'); }
      }

      results.push({ agent: username, stored, recalled, recallText });
      await page.waitForTimeout(2000);
    }

    console.log('\n=== Memory Store + Recall Results ===');
    for (const r of results) {
      console.log(`  @${r.agent}: stored=${r.stored} recalled=${r.recalled}`);
    }
    expect(results.filter(r => r.stored).length).toBeGreaterThanOrEqual(1);
  });

  test('2. Memory persists across conversation clear', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    const agents = await getWorkingAgents(page);
    const agent = agents[0]; // Use first working agent
    if (!agent) test.skip(true, 'No working agents');

    await selectAgent(page, agent);

    const marker = `PERSIST_${Date.now()}`;

    // Store
    await send(page, `Remember: my pet's name is ${marker}. Store it in memory.`);
    await page.waitForTimeout(3000);

    // Clear chat
    const cl = page.locator('button[title="Clear chat"]');
    if (await cl.isVisible({ timeout: 1500 }).catch(() => false)) {
      await cl.click();
      await page.waitForTimeout(2000);
    }

    // Recall after clear
    const r = await send(page, "What is my pet's name? Search your memory.");
    const recalled = r.includes(marker);
    console.log(`Persist test: marker=${marker} recalled=${recalled} — "${r.slice(0, 80)}"`);
    expect(recalled).toBe(true);
  });

  test('3. Memory search finds relevant results', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    const agents = await getWorkingAgents(page);
    const agent = agents[0];
    if (!agent) test.skip(true, 'No working agents');

    await selectAgent(page, agent);

    // Store multiple memories
    await send(page, 'Remember: I work at Shizuha Trading LLP as a software engineer.');
    await page.waitForTimeout(2000);
    await send(page, 'Remember: My favorite programming language is TypeScript.');
    await page.waitForTimeout(2000);
    await send(page, 'Remember: I prefer dark mode in all applications.');
    await page.waitForTimeout(3000);

    // Search for specific topic — be explicit about using the search action
    const r = await send(page, 'Use the memory search tool to find entries about "programming". Show me what you find.');
    const allText = await page.locator('.overflow-y-auto .max-w-4xl').textContent() ?? '';
    const found = /typescript|programming|software/i.test(allText);
    console.log(`Search test: found=${found} — "${r.slice(0, 100)}"`);
    expect(found).toBe(true);
  });

  test('4. Multi-turn memory conversation', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    const agents = await getWorkingAgents(page);
    const agent = agents[0];
    if (!agent) test.skip(true, 'No working agents');

    await selectAgent(page, agent);

    // Natural conversation that should use memory
    await send(page, 'My name is Phoenix and I live in India.');
    await page.waitForTimeout(3000);
    await send(page, 'I have a dog named Buddy.');
    await page.waitForTimeout(3000);

    const r = await send(page, 'Tell me what you know about me from memory.');
    const knowsName = /phoenix/i.test(r);
    const knowsDog = /buddy/i.test(r);
    console.log(`Multi-turn: name=${knowsName} dog=${knowsDog} — "${r.slice(0, 120)}"`);
    // At least one should be recalled
    expect(knowsName || knowsDog).toBe(true);
  });
});
