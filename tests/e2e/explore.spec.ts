/**
 * Exploratory E2E Test — plays with the dashboard like a real user.
 * Each test does something unique and reports what it found.
 * NOT a pass/fail suite — it's a bug finder that logs observations.
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = process.env['DASHBOARD_URL'] || 'http://localhost:8015';
const USER = 'shizuha';
const PASS = 'shizuha';

// Agent names to cycle through
const AGENTS = ['Shizuha', 'Sora', 'Kai', 'Yuki', 'Zen', 'Claw', 'Akira', 'Tomo'];

// Random prompts for variety
const PROMPTS = [
  'What is 7 * 8?',
  'Tell me a one-line joke',
  'Remember this: my favorite color is blue',
  'What do you remember about my preferences?',
  'search_skills(query="docker")',
  'Use the greet tool to say hello to Alice in Spanish',
  'Schedule a reminder: remind me to stretch in 25 seconds',
  'List all your scheduled jobs',
  'What tools do you have access to?',
  'Write a haiku about coding',
  'What is the current date and time?',
  'Create a simple counter app using canvas_render with format app',
  'memory(action="list")',
  'Use memory_index_search to find anything about "kubernetes"',
  'message_agent(target="sora", message="ping from test")',
  'What agents can you communicate with? Use list_agents.',
  'Generate a simple SVG circle using canvas_render',
  'search_skills(query="weather forecast")',
  'Use the browser tool to navigate to https://example.com and get the page text',
  'Summarize what you know about this conversation so far',
];

async function login(page: Page) {
  await page.goto(BASE);
  await page.waitForTimeout(1500);
  const signIn = page.locator('button:has-text("Sign in")');
  if (await signIn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.locator('input').first().fill(USER);
    await page.locator('input[type="password"]').fill(PASS);
    await signIn.click();
    await page.waitForTimeout(3000);
  }
}

async function selectAgent(page: Page, name: string): Promise<boolean> {
  // Look for agent name in the page and click it
  const el = page.locator(`text="${name}"`).first();
  if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
    await el.click();
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

async function sendMessage(page: Page, msg: string): Promise<void> {
  const textarea = page.locator('textarea').first();
  if (!await textarea.isVisible({ timeout: 3000 }).catch(() => false)) return;
  await textarea.fill(msg);
  await textarea.press('Enter');
}

async function waitForResponse(page: Page, maxWaitMs = 45000): Promise<string> {
  // Wait for streaming to finish (stop button disappears)
  const start = Date.now();
  await page.waitForTimeout(3000); // Initial wait for response to start

  // Poll until no more content changes
  let lastLen = 0;
  let stableCount = 0;
  while (Date.now() - start < maxWaitMs) {
    const bodyLen = (await page.textContent('body'))?.length ?? 0;
    if (bodyLen === lastLen) {
      stableCount++;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
      lastLen = bodyLen;
    }
    await page.waitForTimeout(2000);
  }

  // Get the latest visible text
  const body = await page.textContent('body') ?? '';
  return body;
}

async function screenshot(page: Page, label: string) {
  try {
    await page.screenshot({ path: `/tmp/explore-${label}-${Date.now()}.png`, fullPage: true });
  } catch { /* ignore */ }
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function uniquePrompt(): string {
  const base = pick(PROMPTS);
  return base + ` [test-${Date.now().toString(36)}]`;
}

// ═══════════════════════════════════════════
// Exploration Sessions
// ═══════════════════════════════════════════

test.describe.configure({ mode: 'serial' }); // Run sequentially — we're exploring state

test.describe('Exploration Session', () => {
  test('E1: Login and chat with Sora', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Sora');
    await sendMessage(page, 'What is 15 + 27? Just the number.');
    const body = await waitForResponse(page);
    expect(body).toContain('42');
    await screenshot(page, 'e1-sora-math');
  });

  test('E2: Switch to Kai, send message, switch back', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);

    // Chat with Sora first
    await selectAgent(page, 'Sora');
    await sendMessage(page, 'Remember: E2 test marker ALPHA');
    await waitForResponse(page);

    // Switch to Kai
    await selectAgent(page, 'Kai');
    await page.waitForTimeout(1000);
    await sendMessage(page, 'Say exactly: KAI_RESPONSE_OK');
    await waitForResponse(page);

    // Switch back to Sora — should see previous messages
    await selectAgent(page, 'Sora');
    await page.waitForTimeout(2000);
    const body = await page.textContent('body') ?? '';
    // Sora's previous messages should be restored from localStorage
    await screenshot(page, 'e2-switch-back');
    // The previous "Remember: E2 test marker" should still be visible
    expect(body.length).toBeGreaterThan(100);
  });

  test('E3: Schedule cron and verify it fires', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Zen');
    await sendMessage(page, 'Schedule a job: remind me to drink water in 20 seconds');
    await waitForResponse(page);
    await screenshot(page, 'e3-cron-scheduled');

    // Wait for the cron to fire (~20s + up to 15s tick)
    await page.waitForTimeout(40000);
    await screenshot(page, 'e3-cron-fired');

    const body = await page.textContent('body') ?? '';
    // Should see the reminder (proactive message)
    const hasReminder = body.toLowerCase().includes('water') || body.toLowerCase().includes('reminder') || body.includes('⏰');
    test.info().annotations.push({ type: 'cron_fired', description: String(hasReminder) });
  });

  test('E4: Clear chat and verify clean state', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Sora');

    // Send a message first
    await sendMessage(page, 'Say MARKER_BEFORE_CLEAR');
    await waitForResponse(page);

    // Clear chat via command palette (Ctrl+Shift+P or Cmd+K)
    await page.keyboard.press('Control+Shift+p');
    await page.waitForTimeout(500);
    const clearBtn = page.locator('text="Clear"').first();
    if (await clearBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await clearBtn.click();
      await page.waitForTimeout(1000);
    } else {
      await page.keyboard.press('Escape');
      // Try alternative: look for clear button
      const altClear = page.locator('[title*="lear" i]').first();
      if (await altClear.isVisible({ timeout: 1000 }).catch(() => false)) {
        await altClear.click();
        await page.waitForTimeout(1000);
      }
    }

    await screenshot(page, 'e4-after-clear');
    const body = await page.textContent('body') ?? '';
    const markerGone = !body.includes('MARKER_BEFORE_CLEAR');
    test.info().annotations.push({ type: 'clear_worked', description: String(markerGone) });
  });

  test('E5: Test memory across restart (store → verify recall)', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Tomo');
    const marker = `MEMTEST_${Date.now().toString(36)}`;
    await sendMessage(page, `Remember this permanently: "${marker}"`);
    await waitForResponse(page);

    // Now ask about it
    await sendMessage(page, `What do you remember about "${marker.slice(0, 10)}"?`);
    const body = await waitForResponse(page);
    const recalled = body.includes(marker) || body.toLowerCase().includes('remember');
    test.info().annotations.push({ type: 'memory_recall', description: String(recalled) });
    await screenshot(page, 'e5-memory');
  });

  test('E6: Rapid agent switching (stress test state isolation)', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);

    // Rapidly switch between agents
    for (const name of ['Sora', 'Kai', 'Yuki', 'Zen', 'Sora', 'Kai']) {
      await selectAgent(page, name);
      await page.waitForTimeout(800);
    }

    // Should still be stable — send a message
    await selectAgent(page, 'Sora');
    await page.waitForTimeout(1000);
    await sendMessage(page, 'Are you Sora? Reply yes or no.');
    const body = await waitForResponse(page);
    await screenshot(page, 'e6-rapid-switch');
    // Page should be stable, no crashes
    expect(body.length).toBeGreaterThan(50);
  });

  test('E7: Skill search and use', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Sora');
    await sendMessage(page, 'Search for skills about "smart home lights"');
    const body = await waitForResponse(page);
    const found = body.toLowerCase().includes('hue') || body.toLowerCase().includes('philips') || body.toLowerCase().includes('skill');
    test.info().annotations.push({ type: 'skill_found', description: String(found) });
    await screenshot(page, 'e7-skills');
  });

  test('E8: Plugin tool (greet) across different agents', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);

    for (const name of ['Sora', 'Kai']) {
      await selectAgent(page, name);
      await page.waitForTimeout(1000);
      await sendMessage(page, `Use the greet tool to say hello to ${name} in Japanese`);
      await waitForResponse(page);
      await screenshot(page, `e8-plugin-${name.toLowerCase()}`);
    }
  });

  test('E9: Canvas render (static SVG)', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Sora');
    await sendMessage(page, 'Use canvas_render to create a simple SVG: a blue circle with radius 40 on a white background, 200x200');
    await waitForResponse(page);
    await screenshot(page, 'e9-canvas-svg');

    // Check if SVG rendered (look for <svg> or <circle> in DOM)
    const hasSvg = await page.locator('svg, circle, [class*="canvas"]').count();
    test.info().annotations.push({ type: 'svg_rendered', description: String(hasSvg > 0) });
  });

  test('E10: Inter-agent messaging', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Sora');
    await sendMessage(page, 'Send a message to Kai saying "Hello from Sora test E10"');
    const body = await waitForResponse(page);
    await screenshot(page, 'e10-interagent');
    test.info().annotations.push({ type: 'interagent', description: body.slice(0, 200) });
  });

  test('E11: Check no streaming cursor stuck', async ({ page }) => {
    test.setTimeout(60000);
    await login(page);
    await selectAgent(page, 'Zen');
    await sendMessage(page, 'Say "hello world"');
    await waitForResponse(page, 20000);

    // After response, stop button should NOT be visible
    await page.waitForTimeout(3000);
    const stopBtn = page.locator('button[title*="top" i]');
    const stopVisible = await stopBtn.isVisible({ timeout: 2000 }).catch(() => false);
    test.info().annotations.push({ type: 'stop_button_stuck', description: String(stopVisible) });
    if (stopVisible) {
      await screenshot(page, 'e11-BUG-stop-button-stuck');
    }
    expect(stopVisible).toBeFalsy();
  });

  test('E12: Verify proactive message does not cause streaming cursor', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    await selectAgent(page, 'Zen');
    await sendMessage(page, 'Remind me to smile in 20 seconds');
    await waitForResponse(page);

    // Wait for cron to fire
    await page.waitForTimeout(40000);

    // Check: stop button should NOT be visible after proactive message
    const stopBtn = page.locator('button[title*="top" i]');
    const stuck = await stopBtn.isVisible({ timeout: 2000 }).catch(() => false);
    await screenshot(page, 'e12-proactive-cursor');
    test.info().annotations.push({ type: 'proactive_cursor_stuck', description: String(stuck) });
  });
});
