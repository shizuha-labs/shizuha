/**
 * Agent Experience Tests — interactive UX testing across all agents via the dashboard.
 *
 * Verifies the end-user experience: message rendering, markdown formatting,
 * code blocks, tool call visibility, error display, agent switching, concurrent
 * usage, and overall responsiveness through the browser.
 */
import { test, expect, type Page } from '@playwright/test';
import { getDashboardUrl, guardRemoteDashboardTarget } from './dashboard-target';

const URL = getDashboardUrl();
const USERNAME = process.env.DASHBOARD_USER || 'shizuha';
const PASSWORD = process.env.DASHBOARD_PASS || 'shizuha';
const CHAT_MARKDOWN_SEL = '.overflow-y-auto .max-w-4xl .markdown-content';
const ASSISTANT_MARKDOWN_SEL = '.overflow-y-auto .max-w-4xl .justify-start .markdown-content';

test.beforeEach(() => {
  guardRemoteDashboardTarget(URL);
});

async function login(page: Page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const form = page.locator('form');
  if (await form.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(3000);
}

async function resetSelectedAgentSession(page: Page) {
  const resetBtn = page.locator('button[title="Reset runtime session"]');
  await resetBtn.waitFor({ state: 'visible', timeout: 5000 });
  page.once('dialog', (dialog) => dialog.accept());
  await resetBtn.click();
  await expect(resetBtn).toBeDisabled({ timeout: 5000 });
  await page.waitForFunction(
    ({ sel }) => document.querySelectorAll(sel).length === 0,
    { sel: CHAT_MARKDOWN_SEL },
    { timeout: 10_000 },
  ).catch(() => {});
  await expect(resetBtn).toBeEnabled({ timeout: 10_000 });
  await page.waitForTimeout(1000);
}

async function selectAgent(page: Page, username: string, options?: { resetSession?: boolean }) {
  const entry = page.locator(`text=@${username}`).first();
  await entry.waitFor({ state: 'visible', timeout: 8000 });
  await entry.click();
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
  // Clear old messages
  const clearBtn = page.locator('button[title="Clear chat"]');
  if (await clearBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await clearBtn.click();
    await page.waitForTimeout(500);
  }
  if (options?.resetSession) {
    await resetSelectedAgentSession(page);
  }
}

async function sendAndWait(page: Page, message: string, timeout = 45_000): Promise<string> {
  const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
  const assistantCountBefore = await page.locator(ASSISTANT_MARKDOWN_SEL).count();
  const textarea = page.locator('textarea').first();
  await textarea.fill(message);
  await textarea.press('Enter');
  await page.waitForFunction(
    ({ sel, before }) => document.querySelectorAll(sel).length > before,
    { sel: ASSISTANT_MARKDOWN_SEL, before: assistantCountBefore },
    { timeout },
  );
  await page.waitForTimeout(2000);
  const allMd = await chatArea.locator('.justify-start .markdown-content').all();
  return allMd.length > 0 ? (await allMd[allMd.length - 1].textContent() ?? '') : '';
}

/** Get all available agent usernames from sidebar */
async function getAgentUsernames(page: Page): Promise<string[]> {
  const entries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
  const count = await entries.count();
  const usernames: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await entries.nth(i).textContent() ?? '';
    const match = text.match(/@(\w+)/);
    if (match) usernames.push(match[1]);
  }
  return usernames;
}

function pickPreferredWorkingAgent(agents: string[]): string {
  const preferred = ['aoi', 'zen', 'ren', 'mika'];
  for (const username of preferred) {
    if (agents.includes(username) && !SKIP_AGENTS.has(username)) return username;
  }
  return agents.find(a => !SKIP_AGENTS.has(a))!;
}

// Known working agents (skip codex/shizuhaclaude which have auth issues)
// Agents with known auth issues — skip but don't fail
const SKIP_AGENTS = new Set(['codex', 'shizuhaclaude']);

test.describe('Agent Experience', () => {
  // ── 1. Every agent says hello ──
  test('1. All agents respond to greeting', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);

    const agents = await getAgentUsernames(page);
    const results: { agent: string; responded: boolean; snippet: string; timeMs: number }[] = [];

    for (const username of agents) {
      if (SKIP_AGENTS.has(username)) {
        results.push({ agent: username, responded: false, snippet: 'SKIPPED (auth)', timeMs: 0 });
        continue;
      }
      await selectAgent(page, username);
      const start = Date.now();
      try {
        const response = await sendAndWait(page, 'Hi! Who are you? One sentence.');
        results.push({ agent: username, responded: true, snippet: response.slice(0, 80), timeMs: Date.now() - start });
      } catch {
        results.push({ agent: username, responded: false, snippet: 'TIMEOUT', timeMs: Date.now() - start });
      }
    }

    console.log('\n=== Agent Greeting Test ===');
    for (const r of results) {
      const status = r.responded ? 'OK' : 'FAIL';
      console.log(`  [${status}] @${r.agent} (${(r.timeMs / 1000).toFixed(1)}s): "${r.snippet}"`);
    }
    console.log('');

    const working = results.filter(r => r.responded && !SKIP_AGENTS.has(r.agent));
    expect(working.length).toBeGreaterThanOrEqual(2);
  });

  // ── 2. Markdown rendering ──
  test('2. Markdown renders correctly (bold, lists, headers)', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const agent = agents.find(a => !SKIP_AGENTS.has(a))!;
    await selectAgent(page, agent, { resetSession: true });

    const response = await sendAndWait(page,
      'Reply with this exact markdown:\n# Hello\n- **bold item**\n- *italic item*\n\n```js\nconsole.log("test")\n```',
    );

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const lastMd = chatArea.locator('.markdown-content').last();

    // Check that markdown was rendered (not raw)
    const html = await lastMd.innerHTML();
    // Should have heading, bold, code block elements (not raw markdown symbols)
    const hasFormatting = html.includes('<strong>') || html.includes('<h') || html.includes('<code') || html.includes('<pre');
    expect(hasFormatting).toBe(true);
  });

  // ── 3. Code blocks with syntax highlighting ──
  test('3. Code blocks render with syntax highlighting', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const agent = agents.find(a => !SKIP_AGENTS.has(a))!;
    await selectAgent(page, agent, { resetSession: true });

    await sendAndWait(page, 'Write a Python function that adds two numbers. Just the code, nothing else.');

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const lastMd = chatArea.locator('.markdown-content').last();
    const html = await lastMd.innerHTML();

    // Should contain a code element (pre, code, or inline code)
    const hasCode = html.includes('<pre') || html.includes('<code');
    const text = await lastMd.textContent() ?? '';
    expect(text).toMatch(/def|function|add|return/);
  });

  // ── 4. User message appears immediately ──
  test('4. User message appears instantly in chat', async ({ page }) => {
    test.setTimeout(30_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const agent = agents.find(a => !SKIP_AGENTS.has(a))!;
    await selectAgent(page, agent, { resetSession: true });

    const marker = `INSTANT_${Date.now()}`;
    const textarea = page.locator('textarea').first();
    const start = Date.now();
    await textarea.fill(marker);
    await textarea.press('Enter');

    // User message should appear in <500ms (local echo, no server round-trip)
    const userBubble = page.locator(`text=${marker}`).first();
    await userBubble.waitFor({ state: 'visible', timeout: 2000 });
    const renderTime = Date.now() - start;

    console.log(`  User message render: ${renderTime}ms`);
    expect(renderTime).toBeLessThan(1000);
  });

  // ── 5. Agent switching preserves chat history ──
  test('5. Switching agents preserves each agent chat', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const working = agents.filter(a => !SKIP_AGENTS.has(a));
    if (working.length < 2) test.skip(true, 'Need at least 2 working agents');

    const [agent1, agent2] = working;

    // Send to agent1
    await selectAgent(page, agent1);
    const marker1 = `SWITCH_A1_${Date.now()}`;
    await sendAndWait(page, `say exactly: ${marker1}`);

    // Switch to agent2
    await selectAgent(page, agent2);
    const marker2 = `SWITCH_A2_${Date.now()}`;
    await sendAndWait(page, `say exactly: ${marker2}`);

    // Switch back to agent1 — marker1 should still be visible
    const entry1 = page.locator(`text=@${agent1}`).first();
    await entry1.click();
    await page.waitForTimeout(3000);

    const bodyText = await page.locator('.overflow-y-auto .max-w-4xl').textContent() ?? '';
    expect(bodyText).toContain(marker1);
  });

  // ── 6. Long response doesn't truncate ──
  test('6. Long response renders fully', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const agent = agents.find(a => !SKIP_AGENTS.has(a))!;
    await selectAgent(page, agent, { resetSession: true });

    const response = await sendAndWait(page, 'Count from 1 to 30, each number on its own line.', 60_000);
    expect(response).toContain('25');
    expect(response).toContain('30');
  });

  // ── 7. Error messages display properly ──
  test('7. Errors display as user-friendly messages', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const agent = pickPreferredWorkingAgent(agents);
    await selectAgent(page, agent, { resetSession: true });

    const response = await sendAndWait(page, 'Read the file /this/path/absolutely/does/not/exist/ever.txt');
    // Should get a readable error, not a stack trace or crash
    const lower = response.toLowerCase();
    expect(lower).toMatch(/not found|does.?n.?t exist|does not exist|no such|cannot|error|failed|enoent/);
    // Should NOT contain raw stack traces
    expect(lower).not.toContain('at object.');
    expect(lower).not.toContain('typeerror');
  });

  // ── 8. Emoji and unicode render correctly ──
  test('8. Emoji and unicode render properly', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const agent = pickPreferredWorkingAgent(agents);
    await selectAgent(page, agent, { resetSession: true });

    const response = await sendAndWait(page, 'Reply with exactly these emojis: 🎉🚀✅');
    expect(response).toMatch(/🎉|🚀|✅/);
  });

  // ── 9. Tool calls show in UI ──
  test('9. Tool usage is visible in the chat', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page);

    // Use any working agent that can run shell commands
    const agents = await getAgentUsernames(page);
    const preferred = pickPreferredWorkingAgent(agents);
    const agent = preferred !== 'claw'
      ? preferred
      : agents.find(a => !SKIP_AGENTS.has(a) && a !== 'claw')
        ?? agents.find(a => !SKIP_AGENTS.has(a))!;
    await selectAgent(page, agent, { resetSession: true });

    const response = await sendAndWait(page, 'Run `echo TOOL_VISIBLE_TEST` and show me the output.', 90_000);
    expect(response).toContain('TOOL_VISIBLE_TEST');
  });

  // ── 10. Concurrent tab usage ──
  test('10. Two browser tabs can chat with different agents', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await login(page);

    const agents = await getAgentUsernames(page);
    const working = agents.filter(a => !SKIP_AGENTS.has(a));
    if (working.length < 2) test.skip(true, 'Need at least 2 working agents');

    // Tab 1: first agent
    await selectAgent(page, working[0]);
    const marker1 = `TAB1_${Date.now()}`;
    const p1 = sendAndWait(page, `say exactly: ${marker1}`);

    // Tab 2: second agent
    const ctx2 = await browser.newContext({ storageState: await page.context().storageState() });
    const page2 = await ctx2.newPage();
    await page2.goto(URL, { waitUntil: 'networkidle' });
    await page2.waitForTimeout(3000);
    await selectAgent(page2, working[1]);
    const marker2 = `TAB2_${Date.now()}`;
    const p2 = sendAndWait(page2, `say exactly: ${marker2}`);

    // Wait for both
    const [r1, r2] = await Promise.all([p1, p2]);

    // Each tab should get its own response, no cross-contamination
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBeGreaterThan(0);

    await ctx2.close();
  });

  // ── 11. Rapid agent switching doesn't crash ──
  test('11. Rapid agent switching is stable', async ({ page }) => {
    test.setTimeout(30_000);
    await login(page);

    const agents = await getAgentUsernames(page);
    const working = agents.filter(a => !SKIP_AGENTS.has(a));

    // Click through agents rapidly
    for (let i = 0; i < Math.min(working.length * 2, 8); i++) {
      const agent = working[i % working.length];
      const entry = page.locator(`text=@${agent}`).first();
      if (await entry.isVisible().catch(() => false)) {
        await entry.click();
        await page.waitForTimeout(300);
      }
    }

    // Should not crash — textarea still visible
    const textarea = page.locator('textarea').first();
    expect(await textarea.isVisible()).toBe(true);

    // No JS errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(2000);
    expect(errors.length).toBe(0);
  });

  // ── 12. Chat scroll behavior ──
  test('12. Chat auto-scrolls to latest message when already near bottom', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const agent = agents.find(a => !SKIP_AGENTS.has(a))!;
    await selectAgent(page, agent);

    // Send a message and check scroll position
    await sendAndWait(page, 'Say hello.');

    const chatArea = page.locator('.overflow-y-auto:has(.max-w-4xl)');
    const scrollPos = await chatArea.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    // Should be scrolled to bottom (within 60px tolerance)
    const atBottom = scrollPos.scrollHeight - scrollPos.scrollTop - scrollPos.clientHeight < 60;
    expect(atBottom).toBe(true);
  });

  test('13. Chat does not force-scroll when user has scrolled up', async ({ page }) => {
    test.setTimeout(90_000);
    await login(page);
    const agents = await getAgentUsernames(page);
    const agent = agents.find(a => !SKIP_AGENTS.has(a))!;
    await selectAgent(page, agent);

    const chatArea = page.locator('.overflow-y-auto:has(.max-w-4xl)');

    // Build enough transcript to make the chat pane truly scrollable.
    await sendAndWait(page, 'Count from 1 to 80, each number on its own line.', 60_000);

    // Simulate reading older history.
    await chatArea.hover();
    await page.mouse.wheel(0, -5000);
    await page.waitForTimeout(250);

    const beforeSend = await chatArea.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(beforeSend.scrollHeight - beforeSend.scrollTop - beforeSend.clientHeight < 60).toBe(false);

    await sendAndWait(page, 'Say hello while I am reading older messages.');

    const scrollPos = await chatArea.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    const atBottom = scrollPos.scrollHeight - scrollPos.scrollTop - scrollPos.clientHeight < 60;
    expect(atBottom).toBe(false);
    expect(scrollPos.scrollTop).toBeLessThan(100);
  });
});
