import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildAgentGatewayChallengePayload, DEFAULT_AGENT_GATEWAY_SCOPES } from '../../src/auth/agent-gateway.js';
import {
  exchangeAgentGatewayChallenge,
  issueAgentGatewayChallenge,
  revokeAgentGatewayTokens,
  validateAgentGatewayToken,
} from '../../src/daemon/agent-auth.js';
import type { AgentInfo } from '../../src/daemon/types.js';
import { loadOrCreateAgentKeypair, signMessage } from '../../src/crypto/identity.js';

// Env vars that leak the host agent's identity into fixtures and break
// hermeticity (SCLI-11): loadOrCreateAgentKeypair falls back to AGENT_USERNAME
// when no explicit username is passed, so on an agent container the kai/zen
// fixture keypairs land under the HOST agent's identity dir and the reader
// can't find them. Clear for the duration of each test.
const LEAKY_ENV = ['AGENT_USERNAME', 'AGENT_PASSWORD', 'PLATFORM_PULSE_CONNECTED', 'SHIZUHA_HOME'] as const;

describe('agent gateway auth', () => {
  let originalHome: string | undefined;
  let tempHome: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-agent-auth-'));
    process.env['HOME'] = tempHome;
    savedEnv = {};
    for (const k of LEAKY_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    for (const k of LEAKY_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function makeAgent(id: string, username: string): AgentInfo {
    return {
      id,
      name: username[0]!.toUpperCase() + username.slice(1),
      username,
      email: `${username}@shizuha.com`,
      role: 'engineer',
      status: 'active',
      mcpServers: [],
      personalityTraits: {},
      skills: [],
    };
  }

  function workspaceDir(username: string): string {
    const dir = path.join(tempHome, '.shizuha', 'workspaces', username);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('issues a valid short-lived bearer token after a signed challenge', () => {
    const agent = makeAgent('agent-1', 'ryo');
    const keypair = loadOrCreateAgentKeypair(workspaceDir(agent.username));

    const challenge = issueAgentGatewayChallenge(agent);
    const timestamp = Date.now();
    const signature = signMessage(
      buildAgentGatewayChallengePayload(challenge),
      timestamp,
      keypair.privateKeyPem || keypair.privateKey,
    );

    const issued = exchangeAgentGatewayChallenge(agent, challenge.challengeId, timestamp, signature);
    expect(issued.scopes).toEqual(DEFAULT_AGENT_GATEWAY_SCOPES);

    const validated = validateAgentGatewayToken(issued.token);
    expect(validated.valid).toBe(true);
    if (!validated.valid) throw new Error('expected a valid token');
    expect(validated.agentId).toBe(agent.id);
    expect(validated.agentUsername).toBe(agent.username);
    expect(validated.scopes).toEqual(DEFAULT_AGENT_GATEWAY_SCOPES);
  });

  it('rejects signatures from the wrong private key', () => {
    const agent = makeAgent('agent-2', 'kai');
    const otherAgent = makeAgent('agent-3', 'sora');
    loadOrCreateAgentKeypair(workspaceDir(agent.username));
    const otherKeypair = loadOrCreateAgentKeypair(workspaceDir(otherAgent.username));

    const challenge = issueAgentGatewayChallenge(agent);
    const timestamp = Date.now();
    const signature = signMessage(
      buildAgentGatewayChallengePayload(challenge),
      timestamp,
      otherKeypair.privateKeyPem || otherKeypair.privateKey,
    );

    expect(() => exchangeAgentGatewayChallenge(agent, challenge.challengeId, timestamp, signature))
      .toThrow(/Invalid agent auth signature/);
  });

  it('revokes agent bearer tokens cleanly', () => {
    const agent = makeAgent('agent-4', 'zen');
    const keypair = loadOrCreateAgentKeypair(workspaceDir(agent.username));

    const challenge = issueAgentGatewayChallenge(agent);
    const timestamp = Date.now();
    const signature = signMessage(
      buildAgentGatewayChallengePayload(challenge),
      timestamp,
      keypair.privateKeyPem || keypair.privateKey,
    );

    const issued = exchangeAgentGatewayChallenge(agent, challenge.challengeId, timestamp, signature);
    expect(validateAgentGatewayToken(issued.token).valid).toBe(true);

    revokeAgentGatewayTokens(agent.id);
    expect(validateAgentGatewayToken(issued.token).valid).toBe(false);
  });
});

// PLAT-920: regression tests for loadAgentPublicKey inline-key short-circuit.
// The k3s rt-fleet daemon runs as uid=1000 and cannot read root-owned keypair
// files; the fix reads agent.keypair.publicKey from agents.json first.
describe('loadAgentPublicKey inline-key short-circuit (PLAT-920)', () => {
  let originalHome: string | undefined;
  let originalShizuhaHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    originalShizuhaHome = process.env['SHIZUHA_HOME'];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-920-keypair-'));
    process.env['HOME'] = tempHome;
    delete process.env['SHIZUHA_HOME'];
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    if (originalShizuhaHome === undefined) delete process.env['SHIZUHA_HOME'];
    else process.env['SHIZUHA_HOME'] = originalShizuhaHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function makeAgentKeypair(
    id: string,
    username: string,
    keypair?: { publicKey: string; privateKey?: string } | false | null,
  ): AgentInfo {
    return {
      id,
      name: username[0]!.toUpperCase() + username.slice(1),
      username,
      email: `${username}@shizuha.com`,
      role: 'engineer',
      status: 'active',
      mcpServers: [],
      personalityTraits: {},
      skills: [],
      keypair,
    };
  }

  it('uses inline keypair.publicKey without touching the filesystem', () => {
    // Generate a real keypair in a separate temp dir (not the agent identity path).
    const genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-920-keygen-'));
    const kp = loadOrCreateAgentKeypair(genDir);
    fs.rmSync(genDir, { recursive: true, force: true });

    // Agent has inline keypair — no file at ~/.shizuha/agents/atlas/identity/.
    const agent = makeAgentKeypair('a-inline', 'atlas', { publicKey: kp.publicKey });

    const challenge = issueAgentGatewayChallenge(agent);
    expect(challenge.challengeId).toBeTruthy();

    // Full round-trip with the matching private key confirms the inline key was used.
    const timestamp = Date.now();
    const sig = signMessage(
      buildAgentGatewayChallengePayload(challenge),
      timestamp,
      kp.privateKeyPem || kp.privateKey,
    );
    const issued = exchangeAgentGatewayChallenge(agent, challenge.challengeId, timestamp, sig);
    expect(validateAgentGatewayToken(issued.token).valid).toBe(true);
  });

  it('falls through to filesystem when keypair is false and no file exists → throws', () => {
    const agent = makeAgentKeypair('a-false', 'balthazar', false);
    expect(() => issueAgentGatewayChallenge(agent)).toThrow(/has no registered public key/);
  });

  it('falls through to filesystem when keypair is null and no file exists → throws', () => {
    const agent = makeAgentKeypair('a-null', 'colt', null);
    expect(() => issueAgentGatewayChallenge(agent)).toThrow(/has no registered public key/);
  });

  it('falls through to filesystem when keypair is false and keypair file exists → succeeds', () => {
    const genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-920-kp2-'));
    const kp = loadOrCreateAgentKeypair(genDir);
    fs.rmSync(genDir, { recursive: true, force: true });

    const identityDir = path.join(tempHome, '.shizuha', 'agents', 'danya', 'identity');
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(identityDir, 'agent-keypair.json'),
      JSON.stringify({ publicKey: kp.publicKey }),
    );

    // keypair=false → inline check skipped → filesystem fallback → file found → succeeds.
    const agent = makeAgentKeypair('a-fs-false', 'danya', false);
    const challenge = issueAgentGatewayChallenge(agent);
    expect(challenge.challengeId).toBeTruthy();
  });
});


// PLAT-1186: non-root agent containers must not route control auth identity
// through /root. The daemon launches containers with HOME=/home/agent and must
// set SHIZUHA_HOME to that same writable home so getAgentGatewayToken() signs
// with the mounted per-agent keypair instead of attempting mkdir under /root.
describe('agent-control identity path for non-root containers (PLAT-1186)', () => {
  let originalHome: string | undefined;
  let originalShizuhaHome: string | undefined;
  let tempRoot: string;
  let tempAgentHome: string;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    originalShizuhaHome = process.env['SHIZUHA_HOME'];
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-1186-root-'));
    tempAgentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-1186-agent-home-'));
    process.env['HOME'] = tempRoot;
    process.env['SHIZUHA_HOME'] = tempAgentHome;
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    if (originalShizuhaHome === undefined) delete process.env['SHIZUHA_HOME'];
    else process.env['SHIZUHA_HOME'] = originalShizuhaHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(tempAgentHome, { recursive: true, force: true });
  });

  it('writes agent keypairs under SHIZUHA_HOME rather than HOME', () => {
    loadOrCreateAgentKeypair(path.join(tempRoot, 'workspace'), 'san');

    expect(fs.existsSync(path.join(
      tempAgentHome,
      '.shizuha',
      'agents',
      'san',
      'identity',
      'agent-keypair.json',
    ))).toBe(true);
    expect(fs.existsSync(path.join(
      tempRoot,
      '.shizuha',
      'agents',
      'san',
      'identity',
      'agent-keypair.json',
    ))).toBe(false);
  });

  it('daemon container launch pins SHIZUHA_HOME to /home/agent, not /root', () => {
    const managerSource = fs.readFileSync(path.join(process.cwd(), 'src/daemon/manager.ts'), 'utf-8');
    expect(managerSource).toContain("dockerEnv('HOME', '/home/agent')");
    expect(managerSource).toContain("dockerEnv('SHIZUHA_HOME', '/home/agent')");
    expect(managerSource).toContain(':/home/agent/.shizuha/agents/${agent.username}');
    expect(managerSource).not.toContain("dockerEnv('SHIZUHA_HOME', '/root')");
  });
});
