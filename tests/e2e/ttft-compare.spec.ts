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
    await cl.click(); await page.waitForTimeout(1000);
  }
}

test('TTFT comparison — same prompt across agents', async ({ page }) => {
  test.setTimeout(600_000);
  await login(page);

  // Discover agents
  const entries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const agents: { username: string; name: string }[] = [];
  for (let i = 0; i < await entries.count(); i++) {
    const text = await entries.nth(i).textContent() ?? '';
    const m = text.match(/@(\w+)/);
    if (m) agents.push({ username: m[1], name: text.replace(/@.*/, '').trim() });
  }

  const PROMPTS = [
    { label: 'Simple greeting', text: 'Hi, how are you?' },
    { label: 'Quick math', text: 'What is 7 * 8?' },
    { label: 'Short task', text: 'List 3 programming languages.' },
  ];

  const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
  const results: { agent: string; prompt: string; ttftMs: number }[] = [];

  for (const ag of agents) {
    try {
      await selectAgent(page, ag.username);
    } catch {
      for (const p of PROMPTS) results.push({ agent: ag.username, prompt: p.label, ttftMs: -1 });
      continue;
    }

    for (const p of PROMPTS) {
      // Clear between prompts
      const cl = page.locator('button[title="Clear chat"]');
      if (await cl.isVisible({ timeout: 1000 }).catch(() => false)) {
        await cl.click(); await page.waitForTimeout(1000);
      }

      const countBefore = await chatArea.locator('.markdown-content').count();
      const textarea = page.locator('textarea').first();
      const start = Date.now();
      await textarea.fill(p.text);
      await textarea.press('Enter');

      try {
        await page.waitForFunction(
          ({ sel, before }) => document.querySelectorAll(sel).length > before,
          { sel: '.overflow-y-auto .max-w-4xl .markdown-content', before: countBefore },
          { timeout: 90_000 },
        );
        results.push({ agent: ag.username, prompt: p.label, ttftMs: Date.now() - start });
      } catch {
        results.push({ agent: ag.username, prompt: p.label, ttftMs: -1 });
      }

      await page.waitForTimeout(3000); // let response complete
    }
  }

  // Report
  const agentNames = [...new Set(results.map(r => r.agent))];
  const promptLabels = [...new Set(results.map(r => r.prompt))];

  console.log('\n╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                    TTFT COMPARISON — SAME PROMPTS                      ║');
  console.log('╠═══════════════════╦══════════════════╦══════════════╦══════════════════╣');
  console.log('║ Agent             ║ Simple greeting  ║ Quick math   ║ Short task       ║');
  console.log('╠═══════════════════╬══════════════════╬══════════════╬══════════════════╣');

  for (const a of agentNames) {
    const vals = promptLabels.map(p => {
      const r = results.find(x => x.agent === a && x.prompt === p);
      if (!r || r.ttftMs < 0) return '  TIMEOUT'.padStart(16);
      return `${(r.ttftMs / 1000).toFixed(1)}s`.padStart(16);
    });
    console.log(`║ ${a.padEnd(17)} ║${vals[0]}║${vals[1]}║${vals[2]}║`);
  }

  console.log('╚═══════════════════╩══════════════════╩══════════════╩══════════════════╝');

  // Summary by agent
  console.log('\n=== Average TTFT per agent ===');
  for (const a of agentNames) {
    const valid = results.filter(r => r.agent === a && r.ttftMs > 0);
    if (valid.length === 0) { console.log(`  ${a}: ALL TIMEOUT`); continue; }
    const avg = valid.reduce((s, r) => s + r.ttftMs, 0) / valid.length;
    const min = Math.min(...valid.map(r => r.ttftMs));
    const max = Math.max(...valid.map(r => r.ttftMs));
    console.log(`  ${a}: avg=${(avg/1000).toFixed(1)}s  min=${(min/1000).toFixed(1)}s  max=${(max/1000).toFixed(1)}s  (${valid.length}/${PROMPTS.length} responded)`);
  }
  console.log('');

  expect(results.some(r => r.ttftMs > 0)).toBe(true);
});
