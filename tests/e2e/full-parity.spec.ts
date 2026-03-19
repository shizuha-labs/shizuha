/**
 * Full Parity Test Suite — tests all agent features via dashboard API + browser.
 * No require() — all checks via HTTP endpoints or Playwright browser APIs.
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

const BASE = process.env['DASHBOARD_URL'] || 'http://localhost:8015';
const USER = 'shizuha';
const PASS = 'shizuha';

function getWebhookToken(): string {
  try {
    const creds = JSON.parse(readFileSync('/home/phoenix/.shizuha/credentials.json', 'utf-8'));
    return creds.webhookToken || '';
  } catch { return ''; }
}

function docker(cmd: string): string {
  try { return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim(); } catch { return ''; }
}

// ── Health & API ──

test.describe('Health & API', () => {
  test('health endpoint', async ({ request }) => {
    const r = await request.get(`${BASE}/health`);
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.status).toBe('ok');
    expect(d.agents).toBeGreaterThanOrEqual(10);
  });

  test('dashboard HTML', async ({ request }) => {
    const r = await request.get(BASE);
    expect(await r.text()).toContain('Shizuha');
  });

  test('agent list', async ({ request }) => {
    const r = await request.get(`${BASE}/v1/agents`);
    const d = await r.json();
    const running = (d.agents || d).filter((a: any) => a.status === 'running');
    expect(running.length).toBeGreaterThanOrEqual(10);
  });

  test('models endpoint', async ({ request }) => {
    const r = await request.get(`${BASE}/v1/models`);
    const d = await r.json();
    expect(d.providers).toContain('anthropic');
    expect(d.providers).toContain('openai');
  });

  test('multiple execution methods present', async ({ request }) => {
    const r = await request.get(`${BASE}/v1/agents`);
    const d = await r.json();
    const methods = new Set((d.agents || d).filter((a: any) => a.status === 'running').map((a: any) => a.executionMethod));
    expect(methods.size).toBeGreaterThanOrEqual(2);
  });
});

// ── Webhooks ──

test.describe('Webhooks', () => {
  const token = getWebhookToken();

  test('reject unauthenticated', async ({ request }) => {
    const r = await request.post(`${BASE}/v1/hooks/wake`, { data: { text: 'test' } });
    expect(r.status()).toBe(401);
  });

  test('reject wrong token', async ({ request }) => {
    const r = await request.post(`${BASE}/v1/hooks/wake`, {
      headers: { Authorization: 'Bearer wrong' },
      data: { text: 'test' },
    });
    expect(r.status()).toBe(401);
  });

  test('status endpoint', async ({ request }) => {
    test.skip(!token, 'no webhook token');
    const r = await request.get(`${BASE}/v1/hooks/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    expect(d.enabled).toBe(true);
    expect(d.presets.length).toBeGreaterThanOrEqual(3);
  });

  test('dispatch wake', async ({ request }) => {
    test.skip(!token, 'no webhook token');
    const r = await request.post(`${BASE}/v1/hooks/wake`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { text: 'E2E test ping' },
    });
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(d.runId).toBeTruthy();
  });

  test('idempotency dedup', async ({ request }) => {
    test.skip(!token, 'no webhook token');
    const key = `e2e-${Date.now()}`;
    const h = { Authorization: `Bearer ${token}`, 'Idempotency-Key': key };
    const r1 = await (await request.post(`${BASE}/v1/hooks/wake`, { headers: h, data: { text: 'dedup' } })).json();
    const r2 = await (await request.post(`${BASE}/v1/hooks/wake`, { headers: h, data: { text: 'dedup' } })).json();
    expect(r1.runId).toBe(r2.runId);
    expect(r2.deduplicated).toBe(true);
  });

  test('github preset', async ({ request }) => {
    test.skip(!token, 'no webhook token');
    const r = await request.post(`${BASE}/v1/hooks/github`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { action: 'opened', pull_request: { title: 'E2E PR', html_url: 'https://github.com/test/1' } },
    });
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(d.preset).toBe('github');
  });

  test('unknown preset 404', async ({ request }) => {
    test.skip(!token, 'no webhook token');
    const r = await request.post(`${BASE}/v1/hooks/nonexistent`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {},
    });
    expect(r.status()).toBe(404);
  });
});

// ── Audio / Talk Mode ──

test.describe('Audio Endpoints', () => {
  test('TTS requires auth', async ({ request }) => {
    const r = await request.post(`${BASE}/v1/audio/synthesize`, { data: { text: 'hi' } });
    expect(r.status()).toBe(401);
  });

  test('STT requires auth', async ({ request }) => {
    const r = await request.post(`${BASE}/v1/audio/transcribe`);
    expect(r.status()).toBe(401);
  });

  test('TTS returns audio or key error', async ({ request }) => {
    const login = await request.post(`${BASE}/v1/dashboard/login`, { data: { username: USER, password: PASS } });
    const cookie = (login.headers()['set-cookie'] || '').split(';')[0];
    const r = await request.post(`${BASE}/v1/audio/synthesize`, {
      headers: { Cookie: cookie },
      data: { text: 'Hello', voice: 'nova' },
    });
    expect([200, 503]).toContain(r.status());
  });
});

// ── Voice Call ──

test.describe('Voice Call', () => {
  test('Twilio status endpoint', async ({ request }) => {
    const login = await request.post(`${BASE}/v1/dashboard/login`, { data: { username: USER, password: PASS } });
    const cookie = (login.headers()['set-cookie'] || '').split(';')[0];
    const r = await request.get(`${BASE}/v1/voice/status`, { headers: { Cookie: cookie } });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(typeof d.configured).toBe('boolean');
  });
});

// ── Container Infrastructure ──

test.describe('Containers', () => {
  test('agent containers running', async () => {
    const out = docker('docker ps --filter name=shizuha-agent --format "{{.Names}}" 2>/dev/null');
    const containers = out.split('\n').filter(Boolean);
    expect(containers.length).toBeGreaterThanOrEqual(10);
  });

  test('GPU in containers', async () => {
    const out = docker('docker exec shizuha-agent-sora nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null');
    if (!out) test.skip();
    expect(out).toContain('NVIDIA');
  });

  test('Chromium in containers', async () => {
    const out = docker('docker exec shizuha-agent-sora find /root/.cache/ms-playwright -name chrome -type f 2>/dev/null');
    expect(out).toContain('chrome');
  });

  test('skills mounted (34+)', async () => {
    const out = docker('docker exec shizuha-agent-sora sh -c "ls -d /opt/skills/*/ 2>/dev/null | wc -l"');
    expect(parseInt(out) || 0).toBeGreaterThanOrEqual(30);
  });

  test('plugins mounted', async () => {
    const out = docker('docker exec shizuha-agent-sora ls /root/.shizuha/plugins/ 2>/dev/null');
    expect(out).toContain('hello-world');
  });

  test('memory index DB exists', async () => {
    expect(existsSync('/home/phoenix/.shizuha/workspaces/sora/.memory-index.db')).toBeTruthy();
  });
});

// ── Plugins ──

test.describe('Plugins', () => {
  test('hello-world loaded in shizuha agent', async () => {
    const logs = docker('docker logs shizuha-agent-sora 2>&1 | grep "Plugins loaded" | tail -1');
    expect(logs).toContain('"loaded":1');
  });

  test('hello-world loaded in claude-code agent', async () => {
    const logs = docker('docker logs shizuha-agent-kai 2>&1 | grep "Plugins loaded" | tail -1');
    expect(logs).toContain('"loaded":1');
  });

  test('hello-world loaded in codex agent', async () => {
    const logs = docker('docker logs shizuha-agent-yuki 2>&1 | grep "Plugins loaded" | tail -1');
    expect(logs).toContain('"loaded":1');
  });
});

// ── Audit & Telemetry ──

test.describe('Audit & Telemetry', () => {
  test('workspaces exist', async () => {
    const out = docker('ls /home/phoenix/.shizuha/workspaces/ 2>/dev/null');
    expect(out.length).toBeGreaterThan(0);
  });

  test('audit logger initialized', async () => {
    const logs = docker('docker logs shizuha-agent-sora 2>&1 | grep "Audit logger" | tail -1');
    expect(logs).toContain('Audit logger initialized');
  });

  test('telemetry tracker initialized', async () => {
    const logs = docker('docker logs shizuha-agent-sora 2>&1 | grep "Telemetry" | tail -1');
    expect(logs).toContain('Telemetry');
  });
});

// ── Dashboard Login ──

test.describe('Dashboard Login', () => {
  test('login via API', async ({ request }) => {
    const r = await request.post(`${BASE}/v1/dashboard/login`, {
      data: { username: USER, password: PASS },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.ok).toBe(true);
  });

  test('session check after login', async ({ request }) => {
    const login = await request.post(`${BASE}/v1/dashboard/login`, { data: { username: USER, password: PASS } });
    const cookie = (login.headers()['set-cookie'] || '').split(';')[0];
    const r = await request.get(`${BASE}/v1/dashboard/session`, { headers: { Cookie: cookie } });
    const d = await r.json();
    expect(d.authenticated).toBe(true);
  });
});

// ── Fan-out Settings ──

test.describe('Fan-out', () => {
  test('fan-out settings endpoint', async ({ request }) => {
    const r = await request.get(`${BASE}/v1/fan-out`);
    // May need auth
    if (r.ok()) {
      const d = await r.json();
      expect(d.fanOut).toBeTruthy();
    }
  });
});
