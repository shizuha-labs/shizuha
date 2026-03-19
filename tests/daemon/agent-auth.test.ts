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

describe('agent gateway auth', () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env['HOME'];
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-agent-auth-'));
    process.env['HOME'] = tempHome;
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
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
