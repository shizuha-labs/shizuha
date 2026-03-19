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
    await page.fill('#username', 'shizuha');
    await page.fill('#password', 'shizuha');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
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

test('Delayed shell task — Claude, Shizuha, Claw', async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
  const agents = ['claudeagent', 'shizuhacodexagent', 'clawAgent'];
  const skip = new Set(['codex', 'shizuhaclaude', 'shizuhaengineer']);
  
  // Get actual available agents
  const entries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const available: string[] = [];
  for (let i = 0; i < await entries.count(); i++) {
    const m = ((await entries.nth(i).textContent()) ?? '').match(/@(\w+)/);
    if (m && !skip.has(m[1])) available.push(m[1]);
  }

  const results: { agent: string; approach: string; gotOutput: boolean; outputText: string; totalTime: number }[] = [];

  for (const username of available) {
    console.log(`\n=== @${username} ===`);
    try { await selectAgent(page, username); } catch { continue; }

    const countBefore = await chatArea.locator('.markdown-content').count();
    const ta = page.locator('textarea').first();
    const start = Date.now();

    // Ask for a delayed shell command — all agents can run bash
    await ta.fill('Run this exact command: sleep 10 && echo "DELAYED_HELLO_FROM_$(whoami)" — show me the output when done');
    await ta.press('Enter');

    // Wait up to 60s for any response containing DELAYED_HELLO
    let gotOutput = false;
    let outputText = '';

    try {
      // First wait for any response to appear
      await page.waitForFunction(
        ({ s, b }) => document.querySelectorAll(s).length > b,
        { s: '.overflow-y-auto .max-w-4xl .markdown-content', b: countBefore },
        { timeout: 60_000 });

      // Now wait for the full output to contain DELAYED_HELLO (the sleep 10 + echo)
      for (let i = 0; i < 40; i++) { // up to 20s more
        await page.waitForTimeout(500);
        const allText = await chatArea.textContent() ?? '';
        if (allText.includes('DELAYED_HELLO')) {
          gotOutput = true;
          // Get the last response
          const a = await chatArea.locator('.markdown-content').all();
          outputText = a.length > 0 ? (await a[a.length - 1].textContent() ?? '') : allText;
          break;
        }
      }

      if (!gotOutput) {
        // Check full chat area for any DELAYED_HELLO
        const fullText = await chatArea.textContent() ?? '';
        if (fullText.includes('DELAYED_HELLO')) {
          gotOutput = true;
          outputText = 'Found in chat area';
        }
      }
    } catch {
      // timeout
    }

    const elapsed = Date.now() - start;
    const approach = gotOutput && elapsed > 10_000 ? 'ran sleep+echo' : gotOutput ? 'fast response' : 'no output';
    console.log(`  Result: ${gotOutput ? 'GOT OUTPUT' : 'NO OUTPUT'} in ${(elapsed/1000).toFixed(1)}s`);
    if (gotOutput) console.log(`  Output: "${outputText.slice(0, 120)}"`);
    
    results.push({ agent: username, approach, gotOutput, outputText: outputText.slice(0, 100), totalTime: elapsed });

    // Wait for completion before next agent
    await page.waitForTimeout(3000);
  }

  // Report
  console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║        DELAYED SHELL TASK — sleep 10 && echo DELAYED_HELLO           ║');
  console.log('╠═══════════════════╦══════════╦══════════╦════════════════════════════╣');
  console.log('║ Agent             ║ Got it?  ║ Time     ║ Output                     ║');
  console.log('╠═══════════════════╬══════════╬══════════╬════════════════════════════╣');

  for (const r of results) {
    const got = r.gotOutput ? '   YES' : '    NO';
    const time = `${(r.totalTime/1000).toFixed(1)}s`.padStart(7);
    const out = r.outputText.slice(0, 26).padEnd(26);
    console.log(`║ ${r.agent.padEnd(17)} ║ ${got.padEnd(8)}║ ${time} ║ ${out} ║`);
  }

  console.log('╚═══════════════════╩══════════╩══════════╩════════════════════════════╝\n');

  expect(results.filter(r => r.gotOutput).length).toBeGreaterThanOrEqual(1);
});
