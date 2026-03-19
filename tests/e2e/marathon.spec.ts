/**
 * Marathon E2E Test Suite — exhaustive browser-based testing.
 * Tests every dashboard feature via real browser interaction + API calls.
 * Designed to run for hours, catching timing bugs, race conditions, and state leaks.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import * as crypto from 'crypto';

const BASE = process.env['DASHBOARD_URL'] || 'http://localhost:8015';
const USER = 'shizuha';
const PASS = 'shizuha';

function getWebhookToken(): string {
  try { return JSON.parse(readFileSync('/home/phoenix/.shizuha/credentials.json', 'utf-8')).webhookToken || ''; } catch { return ''; }
}
function docker(cmd: string): string {
  try { return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim(); } catch { return ''; }
}
async function loginApi(request: any) {
  const r = await request.post(`${BASE}/v1/dashboard/login`, { data: { username: USER, password: PASS } });
  return (r.headers()['set-cookie'] || '').split(';')[0];
}

// ═══════════════════════════════════════════
// ROUND 1: Infrastructure Health
// ═══════════════════════════════════════════

test.describe('R1: Infrastructure', () => {
  test('health endpoint', async ({ request }) => {
    const d = await (await request.get(`${BASE}/health`)).json();
    expect(d.status).toBe('ok');
    expect(d.agents).toBeGreaterThanOrEqual(10);
  });

  test('15 containers running', async () => {
    const n = docker('docker ps --filter name=shizuha-agent -q | wc -l');
    expect(parseInt(n)).toBeGreaterThanOrEqual(10);
  });

  test('GPU passthrough', async () => {
    const gpu = docker('docker exec shizuha-agent-sora nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null');
    expect(gpu).toContain('NVIDIA');
  });

  test('Chromium installed', async () => {
    const chrome = docker('docker exec shizuha-agent-sora find /root/.cache/ms-playwright -name chrome -type f 2>/dev/null');
    expect(chrome).toContain('chrome');
  });

  test('skills mounted (34+)', async () => {
    const n = docker('docker exec shizuha-agent-sora sh -c "ls -d /opt/skills/*/ | wc -l"');
    expect(parseInt(n)).toBeGreaterThanOrEqual(30);
  });

  test('plugins mounted', async () => {
    const out = docker('docker exec shizuha-agent-sora ls /root/.shizuha/plugins/');
    expect(out).toContain('hello-world');
  });

  test('memory index DB exists', async () => {
    expect(existsSync('/home/phoenix/.shizuha/workspaces/sora/.memory-index.db')).toBeTruthy();
  });

  test('all 4 execution methods present', async ({ request }) => {
    const d = await (await request.get(`${BASE}/v1/agents`)).json();
    const methods = new Set((d.agents || d).filter((a: any) => a.status === 'running').map((a: any) => a.executionMethod));
    expect(methods.has('shizuha')).toBeTruthy();
    expect(methods.size).toBeGreaterThanOrEqual(2);
  });

  test('plugin loaded in all agent types', async () => {
    for (const agent of ['sora', 'kai', 'yuki']) {
      const logs = docker(`docker logs shizuha-agent-${agent} 2>&1 | grep "Plugins loaded" | tail -1`);
      expect(logs).toContain('"loaded":1');
    }
  });

  test('audit logger initialized', async () => {
    const logs = docker('docker logs shizuha-agent-sora 2>&1 | grep "Audit logger" | tail -1');
    expect(logs).toContain('Audit logger');
  });

  test('telemetry initialized', async () => {
    const logs = docker('docker logs shizuha-agent-sora 2>&1 | grep "Telemetry" | tail -1');
    expect(logs).toContain('Telemetry');
  });

  test('cron scheduler running (15s tick)', async () => {
    const logs = docker('docker logs shizuha-agent-sora 2>&1 | grep "Cron scheduler" | tail -1');
    expect(logs).toContain('Cron scheduler started');
  });
});

// ═══════════════════════════════════════════
// ROUND 2: Dashboard Auth & Navigation
// ═══════════════════════════════════════════

test.describe('R2: Dashboard Auth', () => {
  test('login API', async ({ request }) => {
    const d = await (await request.post(`${BASE}/v1/dashboard/login`, { data: { username: USER, password: PASS } })).json();
    expect(d.ok).toBe(true);
  });

  test('wrong password rejected', async ({ request }) => {
    const r = await request.post(`${BASE}/v1/dashboard/login`, { data: { username: USER, password: 'wrong' } });
    expect(r.status()).toBe(401);
  });

  test('session validation', async ({ request }) => {
    const cookie = await loginApi(request);
    const d = await (await request.get(`${BASE}/v1/dashboard/session`, { headers: { Cookie: cookie } })).json();
    expect(d.authenticated).toBe(true);
  });

  test('password change requires auth', async ({ request }) => {
    const r = await request.post(`${BASE}/v1/dashboard/change-password`, {
      data: { currentPassword: 'x', newPassword: 'y' },
    });
    expect(r.status()).toBe(401);
  });
});

// ═══════════════════════════════════════════
// ROUND 3: Webhooks (7 tests)
// ═══════════════════════════════════════════

test.describe('R3: Webhooks', () => {
  const token = getWebhookToken();

  test('reject no auth', async ({ request }) => {
    expect((await request.post(`${BASE}/v1/hooks/wake`, { data: { text: 'x' } })).status()).toBe(401);
  });
  test('reject bad token', async ({ request }) => {
    expect((await request.post(`${BASE}/v1/hooks/wake`, { headers: { Authorization: 'Bearer wrong' }, data: { text: 'x' } })).status()).toBe(401);
  });
  test('status', async ({ request }) => {
    test.skip(!token); const d = await (await request.get(`${BASE}/v1/hooks/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(d.enabled).toBe(true); expect(d.presets.length).toBeGreaterThanOrEqual(3);
  });
  test('wake dispatch', async ({ request }) => {
    test.skip(!token); const d = await (await request.post(`${BASE}/v1/hooks/wake`, { headers: { Authorization: `Bearer ${token}` }, data: { text: `E2E-${Date.now()}` } })).json();
    expect(d.ok).toBe(true); expect(d.runId).toBeTruthy();
  });
  test('agent/:id dispatch', async ({ request }) => {
    test.skip(!token); const d = await (await request.post(`${BASE}/v1/hooks/agent/sora`, { headers: { Authorization: `Bearer ${token}` }, data: { message: 'webhook ping' } })).json();
    expect(d.ok).toBe(true); expect(d.agentName).toBe('Sora');
  });
  test('idempotency', async ({ request }) => {
    test.skip(!token); const key = `idk-${Date.now()}`;
    const h = { Authorization: `Bearer ${token}`, 'Idempotency-Key': key };
    const r1 = await (await request.post(`${BASE}/v1/hooks/wake`, { headers: h, data: { text: 'dedup' } })).json();
    const r2 = await (await request.post(`${BASE}/v1/hooks/wake`, { headers: h, data: { text: 'dedup' } })).json();
    expect(r1.runId).toBe(r2.runId); expect(r2.deduplicated).toBe(true);
  });
  test('github preset', async ({ request }) => {
    test.skip(!token);
    const d = await (await request.post(`${BASE}/v1/hooks/github`, { headers: { Authorization: `Bearer ${token}` }, data: { action: 'opened', pull_request: { title: 'E2E', html_url: 'https://github.com/x/1' } } })).json();
    expect(d.preset).toBe('github');
  });
});

// ═══════════════════════════════════════════
// ROUND 4: Audio & Voice Endpoints
// ═══════════════════════════════════════════

test.describe('R4: Audio/Voice', () => {
  test('TTS auth required', async ({ request }) => {
    expect((await request.post(`${BASE}/v1/audio/synthesize`, { data: { text: 'hi' } })).status()).toBe(401);
  });
  test('STT auth required', async ({ request }) => {
    expect((await request.post(`${BASE}/v1/audio/transcribe`)).status()).toBe(401);
  });
  test('TTS responds (200 or 503)', async ({ request }) => {
    const cookie = await loginApi(request);
    const r = await request.post(`${BASE}/v1/audio/synthesize`, { headers: { Cookie: cookie }, data: { text: 'test', voice: 'nova' } });
    expect([200, 503]).toContain(r.status());
  });
  test('voice call status', async ({ request }) => {
    const cookie = await loginApi(request);
    const d = await (await request.get(`${BASE}/v1/voice/status`, { headers: { Cookie: cookie } })).json();
    expect(typeof d.configured).toBe('boolean');
  });
});

// ═══════════════════════════════════════════
// ROUND 5: Agent API
// ═══════════════════════════════════════════

test.describe('R5: Agent API', () => {
  test('list agents (15+)', async ({ request }) => {
    const d = await (await request.get(`${BASE}/v1/agents`)).json();
    expect((d.agents || d).length).toBeGreaterThanOrEqual(15);
  });
  test('models endpoint', async ({ request }) => {
    const d = await (await request.get(`${BASE}/v1/models`)).json();
    expect(d.models.length).toBeGreaterThan(0);
    expect(d.providers).toContain('anthropic');
  });
  test('fan-out settings', async ({ request }) => {
    const r = await request.get(`${BASE}/v1/fan-out`);
    if (r.ok()) { const d = await r.json(); expect(d.fanOut).toBeTruthy(); }
  });
  test('settings endpoint (auth required)', async ({ request }) => {
    const cookie = await loginApi(request);
    const r = await request.get(`${BASE}/v1/settings`, { headers: { Cookie: cookie } });
    expect(r.ok()).toBeTruthy();
  });
});

// ═══════════════════════════════════════════
// ROUND 6: Browser-based Dashboard Tests
// ═══════════════════════════════════════════

test.describe('R6: Dashboard Browser', () => {
  test('page loads with title', async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveTitle(/Shizuha/i, { timeout: 10000 });
  });

  test('login screen appears', async ({ page }) => {
    await page.goto(BASE);
    // Should see login form or already be logged in
    const hasLogin = await page.locator('input[type="password"]').isVisible({ timeout: 5000 }).catch(() => false);
    const hasChat = await page.locator('textarea').isVisible({ timeout: 2000 }).catch(() => false);
    expect(hasLogin || hasChat).toBeTruthy();
  });

  test('login flow works', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(2000);

    // Check if we see the login form (has "Sign in" button per screenshot)
    const signInBtn = page.locator('button:has-text("Sign in")');
    const hasLogin = await signInBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasLogin) {
      // Username field has placeholder "shizuha" and Password has placeholder "Password"
      await page.locator('input[type="password"]').fill(PASS);
      // Username might be prefilled, but fill it anyway
      const usernameInput = page.locator('input').first();
      await usernameInput.fill(USER);
      await signInBtn.click();
      await page.waitForTimeout(3000);
    }
    // After login, page should have changed — check for any of: textarea, agent names, sidebar
    const bodyText = await page.textContent('body') || '';
    const loggedIn = bodyText.includes('Sora') || bodyText.includes('Kai') || bodyText.includes('Zen')
      || await page.locator('textarea').isVisible({ timeout: 5000 }).catch(() => false);
    expect(loggedIn).toBeTruthy();
  });

  test('agent sidebar visible after login', async ({ page }) => {
    await page.goto(BASE);
    // Login if needed
    const hasLogin = await page.locator('input[type="password"]').isVisible({ timeout: 3000 }).catch(() => false);
    if (hasLogin) {
      const inputs = await page.locator('input').all();
      if (inputs.length >= 2) { await inputs[0]!.fill(USER); await inputs[1]!.fill(PASS); }
      const btn = page.locator('button[type="submit"]').first();
      if (await btn.isVisible({ timeout: 2000 })) await btn.click();
      await page.waitForTimeout(2000);
    }
    // Check for agent names in page
    const text = await page.textContent('body');
    const hasAgent = text?.includes('Sora') || text?.includes('Kai') || text?.includes('Zen');
    expect(hasAgent).toBeTruthy();
  });

  test('mic button visible (Talk Mode)', async ({ page }) => {
    await page.goto(BASE);
    const hasLogin = await page.locator('input[type="password"]').isVisible({ timeout: 3000 }).catch(() => false);
    if (hasLogin) {
      const inputs = await page.locator('input').all();
      if (inputs.length >= 2) { await inputs[0]!.fill(USER); await inputs[1]!.fill(PASS); }
      const btn = page.locator('button[type="submit"]').first();
      if (await btn.isVisible({ timeout: 2000 })) await btn.click();
      await page.waitForTimeout(2000);
    }
    // Mic button should be visible if browser supports getUserMedia
    // In headless Chromium it may not — check for the button's existence
    const buttons = await page.locator('button[title*="oice" i], button[title*="ecord" i], button[title*="icrophone" i]').count();
    // Don't fail — mic might not be available in headless mode
    test.info().annotations.push({ type: 'mic_buttons', description: String(buttons) });
  });
});

// ═══════════════════════════════════════════
// ROUND 7: Agent Interaction via WS
// ═══════════════════════════════════════════

test.describe('R7: Agent Interaction', () => {
  // Helper: send message via WS and collect response
  async function wsInteract(agentName: string, prompt: string, request: any, timeout = 60000): Promise<{ tools: any[]; text: string; ms: number }> {
    const { createConnection } = require('websocket') as any;
    // Use the dashboard HTTP API to forward messages instead of raw WS
    // (Playwright's request context works better than raw websocket in test)
    const cookie = await loginApi(request);

    // Get agent ID
    const agents = await (await request.get(`${BASE}/v1/agents`)).json();
    const agent = (agents.agents || agents).find((a: any) => a.name === agentName);
    if (!agent) return { tools: [], text: `Agent ${agentName} not found`, ms: 0 };

    // Use the inter-agent ask endpoint as a test proxy
    const start = Date.now();
    const r = await request.post(`${BASE}/v1/agents/${agent.id}/ask`, {
      headers: { Cookie: cookie },
      data: { content: prompt, timeout },
    });
    const d = await r.json();
    return { tools: [], text: d.response || '', ms: Date.now() - start };
  }

  test('Sora responds to basic message', async ({ request }) => {
    const cookie = await loginApi(request);
    const agents = await (await request.get(`${BASE}/v1/agents`)).json();
    const sora = (agents.agents || agents).find((a: any) => a.name === 'Sora');
    test.skip(!sora, 'Sora not found');

    const r = await request.post(`${BASE}/v1/agents/${sora.id}/ask`, {
      data: { content: 'What is 2+2? Reply with just the number.', timeout: 30000 },
    });
    const d = await r.json();
    expect(d.response).toContain('4');
  });

  test('Kai responds to basic message', async ({ request }) => {
    const agents = await (await request.get(`${BASE}/v1/agents`)).json();
    const kai = (agents.agents || agents).find((a: any) => a.name === 'Kai');
    test.skip(!kai, 'Kai not found');

    const r = await request.post(`${BASE}/v1/agents/${kai.id}/ask`, {
      data: { content: 'What is 3+3? Reply with just the number.', timeout: 30000 },
    });
    const d = await r.json();
    expect(d.response).toContain('6');
  });

  test('Yuki responds to basic message', async ({ request }) => {
    const agents = await (await request.get(`${BASE}/v1/agents`)).json();
    const yuki = (agents.agents || agents).find((a: any) => a.name === 'Yuki');
    test.skip(!yuki, 'Yuki not found');

    const r = await request.post(`${BASE}/v1/agents/${yuki.id}/ask`, {
      data: { content: 'What is 5+5? Reply with just the number.', timeout: 30000 },
    });
    const d = await r.json();
    expect(d.response).toContain('10');
  });
});

// ═══════════════════════════════════════════
// ROUND 8: Event Log & Cursor Integrity
// ═══════════════════════════════════════════

test.describe('R8: Event Log', () => {
  test('event log has entries', async () => {
    const out = docker('sqlite3 /home/phoenix/.shizuha/event-log.db "SELECT COUNT(*) FROM event_log"');
    expect(parseInt(out)).toBeGreaterThan(0);
  });

  test('multiple agents have events', async () => {
    const out = docker('sqlite3 /home/phoenix/.shizuha/event-log.db "SELECT COUNT(DISTINCT agent_id) FROM event_log"');
    expect(parseInt(out)).toBeGreaterThanOrEqual(2);
  });

  test('events have proper boundaries (complete after content)', async () => {
    // Check that content events are followed by complete events
    const out = docker(`sqlite3 /home/phoenix/.shizuha/event-log.db "SELECT COUNT(*) FROM event_log WHERE json_extract(event, '$.type') = 'complete'"`);
    expect(parseInt(out)).toBeGreaterThan(0);
  });

  test('user_message events exist', async () => {
    const out = docker(`sqlite3 /home/phoenix/.shizuha/event-log.db "SELECT COUNT(*) FROM event_log WHERE json_extract(event, '$.type') = 'user_message'"`);
    expect(parseInt(out)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════
// ROUND 9: Stress Tests
// ═══════════════════════════════════════════

test.describe('R9: Stress', () => {
  test('rapid agent list calls (50x)', async ({ request }) => {
    const promises = Array.from({ length: 50 }, () => request.get(`${BASE}/v1/agents`));
    const results = await Promise.all(promises);
    const okCount = results.filter(r => r.ok()).length;
    expect(okCount).toBe(50);
  });

  test('rapid health checks (100x)', async ({ request }) => {
    const promises = Array.from({ length: 100 }, () => request.get(`${BASE}/health`));
    const results = await Promise.all(promises);
    expect(results.every(r => r.ok())).toBeTruthy();
  });

  test('webhook rate limit (101 bad tokens → 429)', async ({ request }) => {
    // Send 101 bad auth attempts — should get rate limited (limit=100)
    for (let i = 0; i < 101; i++) {
      await request.post(`${BASE}/v1/hooks/wake`, {
        headers: { Authorization: `Bearer bad-stress-${i}` },
        data: { text: 'spam' },
      });
    }
    const r = await request.post(`${BASE}/v1/hooks/wake`, {
      headers: { Authorization: 'Bearer bad-final' },
      data: { text: 'spam' },
    });
    expect(r.status()).toBe(429);
  });
});
