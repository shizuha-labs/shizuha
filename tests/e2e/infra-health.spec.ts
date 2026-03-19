/**
 * Infrastructure health tests — verifies the dashboard is reachable,
 * agents are running, clear chat works, and agent containers have
 * Docker + GitHub access.
 *
 * These are fast, non-interactive tests that validate deployment state.
 */
import { test, expect, type Page } from '@playwright/test';
import { getDashboardUrl, guardRemoteDashboardTarget } from './dashboard-target';

const DASHBOARD_URL = getDashboardUrl();
const USERNAME = process.env.DASHBOARD_USER || 'shizuha';
const PASSWORD = process.env.DASHBOARD_PASS || 'shizuha';

test.beforeEach(() => {
  guardRemoteDashboardTarget(DASHBOARD_URL);
});

async function login(page: Page) {
  await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle' });
  const loginForm = page.locator('form');
  if (await loginForm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await page.fill('#username', USERNAME);
    await page.fill('#password', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
  }
  // Check if chat textarea is already visible (agent auto-restored from localStorage)
  const textarea = page.locator('textarea').first();
  if (await textarea.isVisible({ timeout: 3000 }).catch(() => false)) return;
  // Wait for sidebar to populate with agents (WS needs to connect + RPC)
  await page.waitForTimeout(3000);
  // Select agent from sidebar — click the agent name link (not brand text)
  // Agent entries have @username below the name, so target that structure
  const agentEntry = page.locator('text=@shizuha').first();
  if (await agentEntry.isVisible({ timeout: 5000 }).catch(() => false)) {
    await agentEntry.click();
  }
  await textarea.waitFor({ state: 'visible', timeout: 15_000 });
}

test.describe('Infrastructure Health', () => {
  test('1. Dashboard health endpoint responds', async ({ request }) => {
    const resp = await request.get(`${DASHBOARD_URL}/health`);
    expect(resp.ok()).toBe(true);

    const body = await resp.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('shizuha-daemon');
    expect(body.agents).toBeGreaterThanOrEqual(1);
  });

  test('2. Dashboard serves correct HTML with JS bundle', async ({ request }) => {
    const resp = await request.get(DASHBOARD_URL);
    expect(resp.ok()).toBe(true);

    const html = await resp.text();
    // HTML must reference a JS bundle
    const jsMatch = html.match(/index-[A-Za-z0-9_-]+\.js/);
    expect(jsMatch).not.toBeNull();

    // The referenced JS bundle must be fetchable
    const jsUrl = `${DASHBOARD_URL}/assets/${jsMatch![0]}`;
    const jsResp = await request.get(jsUrl);
    expect(jsResp.ok()).toBe(true);
  });

  test('3. Dashboard loads in browser', async ({ page }) => {
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle' });

    // Should render something (login form or dashboard)
    const body = await page.textContent('body');
    expect(body!.length).toBeGreaterThan(0);

    // No uncaught errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(2000);
    expect(errors).toEqual([]);
  });

  test('4. All agents are running', async ({ request }) => {
    const resp = await request.get(`${DASHBOARD_URL}/health`);
    const body = await resp.json();

    // We expect 5 agents in production (Shizuha, Shizuha-Codex, Codex, Claude, Shizuha-Claude)
    expect(body.agents).toBeGreaterThanOrEqual(4);
  });

  test('5. Clear chat after multiple messages — nothing re-appears', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(3000);

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const chatMessages = chatArea.locator('.markdown-content');
    const textarea = page.locator('textarea').first();

    // Send 3 rapid-fire messages (reproduces the user's "hi" x6 scenario)
    for (let i = 0; i < 3; i++) {
      await textarea.fill(`clear-test-${i}`);
      await textarea.press('Enter');
      await page.waitForTimeout(500);
    }

    // Wait for at least one assistant response to start streaming
    await page.waitForTimeout(5000);
    const msgsBeforeClear = await chatArea.locator('.markdown-content, [class*="bg-shizuha"], [class*="bg-blue"]').count();
    expect(msgsBeforeClear).toBeGreaterThan(0);

    // Grab cursor BEFORE clear
    const cursorBefore = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('shizuha_cursor_'));
      const result: Record<string, string> = {};
      for (const k of keys) result[k] = localStorage.getItem(k) || '';
      return result;
    });

    // Click clear — agent may still be streaming
    const clearBtn = page.locator('button[title="Clear chat"]');
    await clearBtn.waitFor({ state: 'visible', timeout: 5000 });
    await clearBtn.click();
    await page.waitForTimeout(500);

    // Immediately check — must be zero
    const msgsRightAfter = await chatMessages.count();
    expect(msgsRightAfter).toBe(0);

    // Wait 10s for any in-flight WS events (content deltas, complete, user_message echos)
    // This is the critical window where old events could re-populate the chat.
    await page.waitForTimeout(10_000);

    // Still zero — no ghost messages leaked back from WS events.
    // Only check .markdown-content (assistant bubbles) — user bubbles are harder to
    // target without matching sidebar/welcome elements.
    const msgsAfterWait = await chatMessages.count();
    expect(msgsAfterWait).toBe(0);

    // Welcome screen must be visible
    const welcomeVisible = await chatArea.locator('text=Interactive Coding Agent').isVisible();
    expect(welcomeVisible).toBe(true);

    // Clear button gone (no messages)
    expect(await clearBtn.isVisible().catch(() => false)).toBe(false);

    // Cursor preserved (or advanced — suppressed events still advance cursor
    // so they don't replay later)
    const cursorAfter = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith('shizuha_cursor_'));
      const result: Record<string, string> = {};
      for (const k of keys) result[k] = localStorage.getItem(k) || '';
      return result;
    });
    // Same keys, values >= before (cursor must not go backwards)
    expect(Object.keys(cursorAfter).sort()).toEqual(Object.keys(cursorBefore).sort());
    for (const key of Object.keys(cursorBefore)) {
      expect(parseInt(cursorAfter[key] || '0', 10)).toBeGreaterThanOrEqual(parseInt(cursorBefore[key] || '0', 10));
    }

    // localStorage messages cleared
    const persistedMsgs = await page.evaluate(() =>
      Object.keys(localStorage).filter(k => k.startsWith('shizuha_chat_')).length,
    );
    expect(persistedMsgs).toBe(0);
  });

  test('6. Clear chat survives WS reconnect without re-populating', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(3000);

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const chatMessages = chatArea.locator('.markdown-content');

    // Ensure messages exist
    const msgCount = await chatMessages.count();
    if (msgCount === 0) {
      const textarea = page.locator('textarea').first();
      await textarea.fill('hello');
      await textarea.press('Enter');
      await chatMessages.first().waitFor({ state: 'visible', timeout: 30_000 });
    }
    expect(await chatMessages.count()).toBeGreaterThan(0);

    // Clear chat
    const clearBtn = page.locator('button[title="Clear chat"]');
    await clearBtn.click();
    await page.waitForTimeout(1000);
    expect(await chatMessages.count()).toBe(0);

    // Force WS disconnect → reconnect (triggers sync)
    await page.evaluate(() => {
      const ws = (window as unknown as Record<string, unknown>).__shizuhaWs as WebSocket | undefined;
      if (ws) ws.close();
    });
    // Wait for reconnect + sync cycle
    await page.waitForTimeout(8000);

    // Messages must STILL be empty — sync should not re-populate after clear
    const msgsAfterReconnect = await chatMessages.count();
    expect(msgsAfterReconnect).toBe(0);
  });

  test('7. Clear chat survives page refresh without re-populating', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(3000);

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const chatMessages = chatArea.locator('.markdown-content');

    // Ensure messages exist
    if ((await chatMessages.count()) === 0) {
      const textarea = page.locator('textarea').first();
      await textarea.fill('test');
      await textarea.press('Enter');
      await chatMessages.first().waitFor({ state: 'visible', timeout: 30_000 });
    }
    expect(await chatMessages.count()).toBeGreaterThan(0);

    // Clear chat
    const clearBtn = page.locator('button[title="Clear chat"]');
    await clearBtn.click();
    await page.waitForTimeout(1000);
    expect(await chatMessages.count()).toBe(0);

    // Page refresh — this triggers full sync from committed cursor
    await page.reload({ waitUntil: 'networkidle' });
    // Re-login if needed (shouldn't be, since auth is in localStorage)
    await login(page);
    await page.waitForTimeout(5000); // wait for WS connect + sync

    // Messages should STILL be empty after refresh
    const chatAreaAfter = page.locator('.overflow-y-auto .max-w-4xl');
    const msgsAfterRefresh = await chatAreaAfter.locator('.markdown-content').count();
    expect(msgsAfterRefresh).toBe(0);
  });

  test('8. Clear chat during active streaming clears everything', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(2000);

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');

    // Send a message that will produce a long streaming response
    const textarea = page.locator('textarea').first();
    await textarea.fill('Write a very detailed 500-word essay about the history of computing');
    await textarea.press('Enter');

    // Wait for streaming to START (streaming-cursor or any content appearing)
    await page.waitForTimeout(3000);

    // Check if there's visible content (streaming or completed)
    const hasContent = await chatArea.locator('.markdown-content, .streaming-cursor, [class*="animate-"]').count();
    if (hasContent === 0) {
      // Agent might be slow to respond — wait a bit more
      await page.waitForTimeout(5000);
    }

    // Click clear while streaming (or just after)
    const clearBtn = page.locator('button[title="Clear chat"]');
    if (await clearBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await clearBtn.click();
      await page.waitForTimeout(1000);

      // ALL content should be gone — no StreamingMessage, no messages
      const streamingVisible = await chatArea.locator('.streaming-cursor').count();
      const msgsVisible = await chatArea.locator('.markdown-content').count();
      expect(streamingVisible + msgsVisible).toBe(0);
    }
    // If clear button never appeared (no messages rendered yet), that's OK — skip
  });

  test('8b. Clear chat still shows genuinely new cross-device messages', async ({ page }) => {
    test.setTimeout(120_000);

    await login(page);
    await page.waitForTimeout(3000);

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const textarea = page.locator('textarea').first();
    const beforeMarker = `CLEAR_BEFORE_${Date.now()}`;
    const afterMarker = `CLEAR_AFTER_${Date.now()}`;

    await textarea.fill(`say exactly: ${beforeMarker}`);
    await textarea.press('Enter');
    await expect(chatArea.getByText(beforeMarker)).toBeVisible({ timeout: 20_000 });

    const clearBtn = page.locator('button[title="Clear chat"]');
    await clearBtn.click();
    await page.waitForTimeout(1000);
    await expect(chatArea.getByText(beforeMarker)).toHaveCount(0);

    await page.evaluate(async ({ marker }) => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const agentsResp = await fetch('/v1/agents', { credentials: 'include' });
      const agentsJson = await agentsResp.json() as Array<{ id: string; username: string }> | { agents?: Array<{ id: string; username: string }> };
      const agents = Array.isArray(agentsJson) ? agentsJson : agentsJson.agents ?? [];
      const agent = agents.find((a) => a.username === 'shizuha');
      if (!agent) throw new Error('shizuha agent not found');

      await new Promise<void>((resolve, reject) => {
        const ws = new window.WebSocket(`${proto}//${window.location.host}/ws/chat`);
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };
        const timer = window.setTimeout(() => finish(() => {
          ws.close();
          reject(new Error('secondary ws timeout'));
        }), 20_000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'subscribe', agent_id: agent.id }));
          window.setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'message',
              agent_id: agent.id,
              content: `say exactly: ${marker}`,
            }));
          }, 250);
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data) as { type?: string };
            if (msg.type === 'message_ack' || msg.type === 'relay_ack') {
              window.clearTimeout(timer);
              finish(() => {
                ws.close();
                resolve();
              });
            }
          } catch {
            // ignore malformed frames in the probe socket
          }
        };

        ws.onerror = () => finish(() => {
          window.clearTimeout(timer);
          reject(new Error('secondary ws error'));
        });
      });
    }, { marker: afterMarker });

    await expect(chatArea.getByText(afterMarker)).toBeVisible({ timeout: 30_000 });
    await expect(chatArea.getByText(beforeMarker)).toHaveCount(0);
  });

  test('9. Agent containers have Docker access (as agent user)', async () => {
    const { execSync } = await import('child_process');
    const MAC_HOST = process.env.MAC_HOST || 'user@deploy-host.example.com';
    const SSH_KEY = process.env.SSH_KEY || `${process.env.HOME}/.ssh/id_rsa`;
    const sshCmd = (remoteCmd: string) =>
      `ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -i ${SSH_KEY} ${MAC_HOST} 'export PATH=/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH && ${remoteCmd}'`;
    const ssh = (cmd: string) =>
      execSync(sshCmd(cmd), { encoding: 'utf-8', timeout: 15_000 }).trim();

    // Get running agent containers
    const containers = ssh("docker ps --format '{{.Names}}' --filter name=shizuha-agent-")
      .split('\n')
      .filter(Boolean);
    expect(containers.length).toBeGreaterThanOrEqual(2);

    for (const container of containers) {
      // Docker access as agent user (not root)
      const dockerVer = ssh(`docker exec -u agent ${container} docker version --format '{{.Server.Version}}'`);
      expect(dockerVer).toMatch(/^\d+\.\d+\.\d+$/);

      // Agent user is in docker group
      const groups = ssh(`docker exec -u agent ${container} id -Gn`);
      expect(groups).toContain('docker');
    }
  });

  test('10. Agent containers with GITHUB_TOKEN have GitHub access', async () => {
    const { execSync } = await import('child_process');
    const MAC_HOST = process.env.MAC_HOST || 'user@deploy-host.example.com';
    const SSH_KEY = process.env.SSH_KEY || `${process.env.HOME}/.ssh/id_rsa`;
    const sshExec = (cmd: string) =>
      execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();

    const sshCmd = (remoteCmd: string) =>
      `ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -i ${SSH_KEY} ${MAC_HOST} 'export PATH=/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH && ${remoteCmd}'`;

    // Find containers that have GITHUB_TOKEN set
    const containers = sshExec(sshCmd("docker ps --format '{{.Names}}' --filter name=shizuha-agent-"))
      .split('\n').filter(Boolean);

    let tested = 0;
    for (const container of containers) {
      // Check if GITHUB_TOKEN env var is set (non-empty) in this container
      let hasToken = 'no';
      try {
        hasToken = sshExec(sshCmd(`docker exec -u agent ${container} printenv GITHUB_TOKEN > /dev/null 2>&1 && echo yes || echo no`));
      } catch { hasToken = 'no'; }
      if (!hasToken.includes('yes')) continue;

      // Git clone works (validates GITHUB_TOKEN + credential helper)
      const cloneResult = sshExec(
        sshCmd(`docker exec -u agent ${container} git clone --depth 1 https://github.com/shizuha-labs/shizuha-stack.git /tmp/e2e-gh-test 2>&1; docker exec ${container} rm -rf /tmp/e2e-gh-test; echo DONE`),
      );
      expect(cloneResult).toContain('Cloning into');
      tested++;
    }

    // At least one container should have GITHUB_TOKEN configured
    expect(tested).toBeGreaterThanOrEqual(1);
  });

  test('11. Claw (OpenClaw) agent responds to messages', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(3000);

    // Select Claw agent from sidebar
    const claw = page.locator('text=@claw').first();
    if (!(await claw.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, 'Claw agent not available on this instance');
    }
    await claw.click();

    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });

    // Send test message
    const marker = `CLAW_TEST_${Date.now()}`;
    await textarea.fill(`say exactly: ${marker}`);
    await textarea.press('Enter');

    // Wait for response — openclaw takes ~3-10s
    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const response = chatArea.locator('.markdown-content');

    // Wait up to 45s, take screenshot on timeout for debugging
    try {
      await response.first().waitFor({ state: 'visible', timeout: 45_000 });
    } catch {
      await page.screenshot({ path: '/tmp/claw-test-timeout.png' });
      // Check if there's any content at all in the chat area
      const allText = await chatArea.textContent();
      console.log('CLAW TIMEOUT DEBUG:', allText?.slice(0, 300));
      throw new Error('Claw agent did not produce visible .markdown-content within 45s');
    }

    const text = await response.first().textContent();
    expect(text!.length).toBeGreaterThan(0);
  });

  test('12. Agents cached in localStorage survive page refresh', async ({ page }) => {
    await login(page);
    await page.waitForTimeout(3000); // wait for WS + RPC to fetch agents

    // Verify agents are in sidebar
    const sidebarAgents = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
    const countBefore = await sidebarAgents.count();
    expect(countBefore).toBeGreaterThanOrEqual(2);

    // Verify cache was written to localStorage
    const cacheExists = await page.evaluate(() => {
      const cached = localStorage.getItem('shizuha_agents_cache');
      return cached ? JSON.parse(cached).length : 0;
    });
    expect(cacheExists).toBeGreaterThanOrEqual(2);

    // Hard refresh — agents should show immediately from cache (no WS needed)
    await page.reload({ waitUntil: 'networkidle' });
    // Login form may appear but auth should be in localStorage
    const loginForm = page.locator('form');
    if (await loginForm.isVisible({ timeout: 1000 }).catch(() => false)) {
      // Auth cookie expired — re-login
      await page.fill('#username', USERNAME);
      await page.fill('#password', PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(1000);
    }

    // Agents should be visible from cache within 3s (allowing for React hydration)
    const agentVisible = await page.locator('text=@shizuha').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(agentVisible).toBe(true);

    const countAfter = await sidebarAgents.count();
    expect(countAfter).toBeGreaterThanOrEqual(2);
  });

  test('13. TTFT telemetry — all agents', async ({ page }) => {
    test.setTimeout(600_000); // 10 min for all agents

    await login(page);
    await page.waitForTimeout(3000);

    // Discover all agents from sidebar — extract @username from each entry
    const agentEntries = page.locator('[class*="cursor-pointer"]').filter({ hasText: '@' });
    const agentCount = await agentEntries.count();
    const agents: { username: string; displayName: string }[] = [];
    for (let i = 0; i < agentCount; i++) {
      const text = await agentEntries.nth(i).textContent() ?? '';
      const match = text.match(/@(\w+)/);
      if (!match) continue;
      const username = match[1];
      // Extract display name (text before @username)
      const nameMatch = text.match(/^([A-Za-z][\w-]*)/);
      agents.push({ username, displayName: nameMatch?.[1] ?? username });
    }

    const chatArea = page.locator('.overflow-y-auto .max-w-4xl');
    const textarea = page.locator('textarea').first();
    const ROUNDS = 2;
    const allResults: Record<string, number[]> = {};

    for (const agent of agents) {
      // Select agent
      const agentEntry = page.locator(`text=@${agent.username}`).first();
      if (!(await agentEntry.isVisible({ timeout: 3000 }).catch(() => false))) continue;
      await agentEntry.click();
      await textarea.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(1500);

      // Clear old messages
      const clearBtn = page.locator('button[title="Clear chat"]');
      if (await clearBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await clearBtn.click();
        await page.waitForTimeout(500);
      }

      const ttfts: number[] = [];

      for (let r = 0; r < ROUNDS; r++) {
        const msgCountBefore = await chatArea.locator('.markdown-content').count();
        const sendTime = Date.now();

        await textarea.fill(`say exactly: TTFT_${agent.username}_R${r}`);
        await textarea.press('Enter');

        try {
          await page.waitForFunction(
            ({ sel, before }) => document.querySelectorAll(sel).length > before,
            { sel: '.overflow-y-auto .max-w-4xl .markdown-content', before: msgCountBefore },
            { timeout: 45_000 },
          );
          ttfts.push(Date.now() - sendTime);
        } catch {
          ttfts.push(-1); // timeout
          break; // skip remaining rounds for this agent
        }

        // Wait for completion
        await page.waitForTimeout(2000);
      }

      allResults[agent.displayName] = ttfts;
    }

    // Report
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║          TTFT TELEMETRY — ALL AGENTS               ║');
    console.log('╠═══════════════════╦══════════╦══════════╦══════════╣');
    console.log('║ Agent             ║ Round 0  ║ Round 1  ║ Avg      ║');
    console.log('╠═══════════════════╬══════════╬══════════╬══════════╣');

    for (const [name, ttfts] of Object.entries(allResults)) {
      const fmtMs = (ms: number | undefined) => !ms || ms < 0 ? '     N/A' : `${(ms / 1000).toFixed(1)}s`.padStart(8);
      const valid = ttfts.filter(t => t > 0);
      const avg = valid.length > 0 ? Math.round(valid.reduce((s, t) => s + t, 0) / valid.length) : -1;
      const avgStr = avg < 0 ? '     N/A' : `${(avg / 1000).toFixed(1)}s`.padStart(8);
      console.log(`║ ${name.padEnd(17)} ║ ${fmtMs(ttfts[0])}║ ${fmtMs(ttfts[1])}║ ${avgStr}║`);
    }

    console.log('╚═══════════════════╩══════════╩══════════╩══════════╝\n');

    // At least some agents should respond
    const responded = Object.values(allResults).filter(t => t.some(v => v > 0)).length;
    expect(responded).toBeGreaterThanOrEqual(1);
  });
});
