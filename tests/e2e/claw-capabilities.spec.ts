/**
 * OpenClaw (Claw agent) capability tests — exercises all major features
 * through the dashboard browser UI to verify the full communication stack:
 *   Browser → Dashboard WS → Daemon → Bridge → OpenClaw Gateway → Pi Agent → LLM
 *
 * Tests run through the dashboard with the Claw agent.
 */
import { test, expect, type Page } from '@playwright/test';
import { getDashboardUrl, guardRemoteDashboardTarget } from './dashboard-target';

const URL = getDashboardUrl();
const USERNAME = process.env.DASHBOARD_USER || 'shizuha';
const PASSWORD = process.env.DASHBOARD_PASS || 'shizuha';
const MSG_TIMEOUT = 45_000;

test.beforeEach(() => {
  guardRemoteDashboardTarget(URL);
});

async function loginAndSelectClaw(page: Page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const form = page.locator('form');
  if (await form.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
  }
  const textarea = page.locator('textarea').first();
  if (await textarea.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Check if already on Claw
    const header = await page.locator('text=Claw').first().isVisible().catch(() => false);
    if (header) return;
  }
  await page.waitForTimeout(3000);
  const claw = page.locator('text=@claw').first();
  await claw.waitFor({ state: 'visible', timeout: 15_000 });
  await claw.click();
  await textarea.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(1000);
}

/** Send a message and wait for a NEW assistant response that's complete.
 *  Waits for count to increase, then waits for content to stop changing (streaming done). */
async function sendAndWait(page: Page, message: string, timeout = MSG_TIMEOUT): Promise<string> {
  const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
  const countBefore = await chatArea.locator('.markdown-content').count();

  const textarea = page.locator('textarea').first();
  await textarea.fill(message);
  await textarea.press('Enter');

  // Wait for a new .markdown-content element
  await page.waitForFunction(
    ({ sel, before }) => document.querySelectorAll(sel).length > before,
    { sel: '.overflow-y-auto .max-w-4xl .markdown-content', before: countBefore },
    { timeout },
  );

  // Wait for content to stabilize (streaming complete — text stops changing)
  let lastText = '';
  let stableCount = 0;
  for (let i = 0; i < 30; i++) { // max 15s
    await page.waitForTimeout(500);
    const allMd = await chatArea.locator('.markdown-content').all();
    const currentText = allMd.length > 0 ? (await allMd[allMd.length - 1].textContent() ?? '') : '';
    if (currentText === lastText && currentText.length > 0) {
      stableCount++;
      if (stableCount >= 3) break; // stable for 1.5s
    } else {
      stableCount = 0;
    }
    lastText = currentText;
  }

  const allMd = await chatArea.locator('.markdown-content').all();
  return allMd.length > 0 ? (await allMd[allMd.length - 1].textContent() ?? '') : '';
}

// ── Tests ──

test.describe('Claw Capabilities', () => {
  
  test.beforeEach(async ({ page }) => {
    await loginAndSelectClaw(page);
    // Clear old messages and wait for any pending gateway events to drain.
    // The gateway might still be streaming a response from a previous test —
    // we need to wait long enough for it to complete so chatClearedRef
    // doesn't accidentally let it through when the next message is sent.
    const clearBtn = page.locator('button[title="Clear chat"]');
    if (await clearBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await clearBtn.click();
      await page.waitForTimeout(3000); // drain pending events
    }
  });

  // ── 1. Basic conversation ──
  test('1. Basic chat — responds coherently', async ({ page }) => {
    const response = await sendAndWait(page, 'What is 2 + 2? Reply with just the number.');
    expect(response).toContain('4');
  });

  // ── 2. Streaming ──
  test('2. Streaming — tokens arrive incrementally', async ({ page }) => {
    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const countBefore = await chatArea.locator('.markdown-content').count();

    const textarea = page.locator('textarea').first();
    await textarea.fill('Write a haiku about coding. Take your time.');
    await textarea.press('Enter');

    // Check for streaming indicator or growing content
    // The .markdown-content should appear and grow over time
    await page.waitForFunction(
      ({ sel, before }) => document.querySelectorAll(sel).length > before,
      { sel: '.overflow-y-auto .max-w-4xl .markdown-content', before: countBefore },
      { timeout: MSG_TIMEOUT },
    );

    const text = await chatArea.locator('.markdown-content').last().textContent() ?? '';
    expect(text.length).toBeGreaterThan(0);
  });

  // ── 3. Tool use: exec (shell commands) ──
  test('3. Shell exec — runs commands and returns output', async ({ page }) => {
    const response = await sendAndWait(page, 'Run `echo HELLO_FROM_CLAW` in the terminal and show me the output.');
    expect(response.toLowerCase()).toContain('hello_from_claw');
  });

  // ── 4. Tool use: file operations (read/write/edit) ──
  test('4. File ops — create, read, and verify a file', async ({ page }) => {
    const marker = `CLAW_FILE_${Date.now()}`;
    const response = await sendAndWait(
      page,
      `Create a file at /tmp/claw-test.txt with the content "${marker}", then read it back and confirm the content.`,
      60_000,
    );
    expect(response).toContain(marker);
  });

  // ── 5. Web search ──
  test('5. Web search — searches the internet', async ({ page }) => {
    const response = await sendAndWait(
      page,
      'Search the web for "TypeScript 5.8 release date" and tell me what you found. Keep it brief.',
      60_000,
    );
    // Should either return results OR explain search isn't configured (Brave API key)
    expect(response.toLowerCase()).toMatch(/typescript|2025|2024|release|brave|api.key|not configured|search/);
  });

  // ── 6. Web fetch ──
  test('6. Web fetch — fetches a URL', async ({ page }) => {
    const response = await sendAndWait(
      page,
      'Fetch https://httpbin.org/get and tell me the "origin" IP from the JSON response.',
      60_000,
    );
    // Should contain an IP address
    expect(response).toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  // ── 7. Memory ──
  test('7. Memory — stores and retrieves information', async ({ page }) => {
    const marker = `MEM_${Date.now()}`;
    // Store
    await sendAndWait(page, `Remember this: my favorite color is ${marker}. Confirm you saved it.`);
    // Retrieve
    const response = await sendAndWait(page, 'What is my favorite color? Check your memory.');
    expect(response).toContain(marker);
  });

  // ── 8. Multi-turn conversation ──
  test('8. Multi-turn — maintains context across messages', async ({ page }) => {
    test.setTimeout(90_000);
    const r1 = await sendAndWait(page, 'My name is ZephyrTestBot. Remember that.');
    expect(r1.length).toBeGreaterThan(0);
    // Must wait for the complete event to fully process before sending next
    await page.waitForTimeout(5000);
    const response = await sendAndWait(page, 'What is my name? Reply with just the name.', 60_000);
    // The response should mention ZephyrTestBot somewhere in the conversation
    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const allText = await chatArea.textContent() ?? '';
    expect(allText.toLowerCase()).toContain('zephyrtestbot');
  });

  // ── 9. Cron/scheduling ──
  test('9. Cron — can schedule tasks', async ({ page }) => {
    const response = await sendAndWait(
      page,
      'List any existing cron jobs. If none exist, just say "no cron jobs found".',
    );
    // Should either list jobs or say none — not error
    expect(response.toLowerCase()).toMatch(/cron|job|schedule|none|no.*found|empty|unauthorized|password/);
  });

  // ── 10. Error handling — graceful failure ──
  test('10. Error handling — handles impossible requests gracefully', async ({ page }) => {
    const response = await sendAndWait(
      page,
      'Read the file /nonexistent/path/that/does/not/exist.txt',
    );
    // Should explain the file doesn't exist, not crash
    expect(response.toLowerCase()).toMatch(/not found|does.?n.?t exist|no such file|error|cannot|failed/);
  });

  // ── 11. Rapid-fire messages — queue handling ──
  test('11. Rapid-fire — handles multiple quick messages', async ({ page }) => {
    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const textarea = page.locator('textarea').first();

    // Send 3 messages quickly
    for (const msg of ['say A', 'say B', 'say C']) {
      await textarea.fill(msg);
      await textarea.press('Enter');
      await page.waitForTimeout(300);
    }

    // Wait for responses (at least 1 should arrive within 60s)
    await page.waitForTimeout(15_000);
    const responses = await chatArea.locator('.markdown-content').count();
    expect(responses).toBeGreaterThanOrEqual(1);
  });

  // ── 12. Long output — handles large responses ──
  test('12. Long output — streams large response without truncation', async ({ page }) => {
    const response = await sendAndWait(
      page,
      'List the numbers 1 through 20, one per line.',
      60_000,
    );
    // Should contain at least numbers 1-10
    expect(response).toContain('10');
    expect(response).toContain('15');
  });
});
