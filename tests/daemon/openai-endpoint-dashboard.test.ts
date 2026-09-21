import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

describe('dashboard OpenAI-compatible endpoint (SCLI-595)', () => {
  let tempHome: string;
  let dashboardProc: ChildProcess;
  let baseUrl: string;

  beforeAll(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-595-dash-'));
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    const scriptPath = path.join(tempHome, 'dashboard-fixture.ts');
    fs.writeFileSync(scriptPath, `
import { startDashboard } from ${JSON.stringify(path.join(process.cwd(), 'src/daemon/dashboard.ts'))};
(async () => {
  await startDashboard({
    port: ${port},
    host: '127.0.0.1',
    platformUrl: 'http://127.0.0.1:65535',
    accessToken: '',
    agents: [],
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
    `.trimStart(), 'utf-8');

    dashboardProc = spawn(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: tempHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderrRef = { value: '' };
    dashboardProc.stderr?.on('data', (chunk: Buffer) => {
      stderrRef.value += chunk.toString();
    });
    await waitForHealth(baseUrl, stderrRef, dashboardProc);
  }, 30_000);

  afterAll(() => {
    if (dashboardProc && dashboardProc.exitCode === null) dashboardProc.kill('SIGTERM');
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('saves a URL-only local endpoint without a Shizuha login or API key', async () => {
    const put = await fetch(`${baseUrl}/v1/providers/openai`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'http://127.0.0.1:11434',
        defaultModel: 'llama3.2',
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const settings = await fetch(`${baseUrl}/v1/settings`);
    expect(settings.status).toBe(200);
    const body = await settings.json() as {
      identity: { loggedIn: boolean };
      providers: {
        openai: {
          configured: boolean;
          keyPrefix: string | null;
          baseUrl: string | null;
          defaultModel: string | null;
        };
      };
    };
    expect(body.identity.loggedIn).toBe(false);
    const usage = await fetch(`${baseUrl}/v1/cortex/usage`);
    expect(usage.status).toBe(200);
    const usageBody = await usage.json() as { configured: boolean; reason?: string };
    expect(usageBody.configured).toBe(false);
    expect(usageBody.reason).toBe('sign_in');
    expect(body.providers.openai).toEqual({
      configured: true,
      keyPrefix: null,
      baseUrl: 'http://127.0.0.1:11434/v1',
      defaultModel: 'llama3.2',
    });
  });
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to allocate a free port'));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on('error', reject);
  });
}

async function waitForHealth(baseUrl: string, stderrRef: { value: string }, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError = stderrRef.value;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Dashboard fixture exited early: ${stderrRef.value || lastError}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `Health returned ${response.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Dashboard fixture did not become healthy: ${stderrRef.value || lastError}`);
}
