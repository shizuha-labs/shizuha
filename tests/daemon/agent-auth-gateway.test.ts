import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadOrCreateAgentKeypair, signMessage } from '../../src/crypto/identity.js';
import { buildAgentGatewayChallengePayload, type AgentGatewayChallenge } from '../../src/auth/agent-gateway.js';

interface AgentFixture {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  status: 'active';
  mcpServers: [];
  personalityTraits: Record<string, string>;
  skills: string[];
}

describe('agent auth against dashboard gateway', () => {
  let tempHome: string;
  let dashboardProc: ChildProcess;
  let port: number;
  let baseUrl: string;
  let initiator: AgentFixture;
  let target: AgentFixture;
  let stderrRef: { value: string };

  beforeAll(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-agent-gateway-'));
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    initiator = makeAgent('agent-ryo', 'Ryo', 'ryo');
    target = makeAgent('agent-kai', 'Kai', 'kai');

    ensureWorkspace(tempHome, initiator.username);
    ensureWorkspace(tempHome, target.username);
    loadOrCreateAgentKeypair(path.join(tempHome, '.shizuha', 'workspaces', initiator.username));

    const scriptPath = path.join(tempHome, 'dashboard-fixture.ts');
    fs.writeFileSync(scriptPath, `
import { startDashboard } from ${JSON.stringify(path.join(process.cwd(), 'src/daemon/dashboard.ts'))};

const agents = ${JSON.stringify([initiator, target], null, 2)};
(async () => {
  await startDashboard({
    port: ${port},
    host: '127.0.0.1',
    platformUrl: 'http://127.0.0.1:65535',
    accessToken: '',
    agents,
  });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
    `.trimStart(), 'utf-8');

    dashboardProc = spawn(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), [scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    stderrRef = { value: '' };
    dashboardProc.stderr?.on('data', (chunk: Buffer) => {
      stderrRef.value += chunk.toString();
    });

    await waitForHealth(baseUrl, stderrRef, dashboardProc);
  }, 30_000);

  afterAll(() => {
    if (dashboardProc && dashboardProc.exitCode === null) {
      dashboardProc.kill('SIGTERM');
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('allows agent-scoped bearer auth on gateway endpoints', async () => {
    const challengeResp = await fetch(`${baseUrl}/v1/agent-auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: initiator.username }),
    });
    expect(challengeResp.status).toBe(200);
    const challenge = await challengeResp.json() as AgentGatewayChallenge;

    const keypair = loadOrCreateAgentKeypair(path.join(tempHome, '.shizuha', 'workspaces', initiator.username));
    const timestamp = Date.now();
    const signature = signMessage(
      buildAgentGatewayChallengePayload(challenge),
      timestamp,
      keypair.privateKeyPem || keypair.privateKey,
    );

    const tokenResp = await fetch(`${baseUrl}/v1/agent-auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: initiator.username,
        challenge_id: challenge.challengeId,
        timestamp,
        signature,
      }),
    });
    expect(tokenResp.status).toBe(200);
    const tokenData = await tokenResp.json() as { token: string };
    expect(typeof tokenData.token).toBe('string');

    const agentsResp = await fetch(`${baseUrl}/v1/agents`, {
      headers: { 'Authorization': `Bearer ${tokenData.token}` },
    });
    expect(agentsResp.status).toBe(200);
    const agentsData = await agentsResp.json() as { agents: Array<{ username: string }> };
    expect(agentsData.agents.map((agent) => agent.username)).toContain(initiator.username);
    expect(agentsData.agents.map((agent) => agent.username)).toContain(target.username);

    const askResp = await fetch(`${baseUrl}/v1/agents/${target.username}/ask`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'ping', timeout: 1000 }),
    });
    expect(askResp.status).toBe(503);
    const askData = await askResp.json() as { error: string };
    expect(askData.error).toMatch(/not running/i);
  });

  it('rejects invalid signed agent authentication at the gateway', async () => {
    const challengeResp = await fetch(`${baseUrl}/v1/agent-auth/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: initiator.username }),
    });
    expect(challengeResp.status).toBe(200);
    const challenge = await challengeResp.json() as AgentGatewayChallenge;

    const wrongKeypair = loadOrCreateAgentKeypair(path.join(tempHome, '.shizuha', 'workspaces', target.username));
    const timestamp = Date.now();
    const signature = signMessage(
      buildAgentGatewayChallengePayload(challenge),
      timestamp,
      wrongKeypair.privateKeyPem || wrongKeypair.privateKey,
    );

    const tokenResp = await fetch(`${baseUrl}/v1/agent-auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: initiator.username,
        challenge_id: challenge.challengeId,
        timestamp,
        signature,
      }),
    });
    expect(tokenResp.status).toBe(401);
  });
});

function makeAgent(id: string, name: string, username: string): AgentFixture {
  return {
    id,
    name,
    username,
    email: `${username}@shizuha.com`,
    role: 'engineer',
    status: 'active',
    mcpServers: [],
    personalityTraits: {},
    skills: [],
  };
}

function ensureWorkspace(home: string, username: string): void {
  fs.mkdirSync(path.join(home, '.shizuha', 'workspaces', username), { recursive: true });
}

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
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
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
