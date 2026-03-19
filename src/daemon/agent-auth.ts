import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentInfo } from './types.js';
import {
  DEFAULT_AGENT_GATEWAY_SCOPES,
  type AgentGatewayChallenge,
  type AgentGatewayScope,
  buildAgentGatewayChallengePayload,
} from '../auth/agent-gateway.js';
import { verifySignature } from '../crypto/identity.js';

const AGENT_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const AGENT_TOKEN_TTL_MS = 15 * 60 * 1000;

interface ChallengeRecord extends AgentGatewayChallenge {
  publicKey: string;
}

interface AgentAccessTokenRecord {
  agentId: string;
  agentName: string;
  agentUsername: string;
  scopes: AgentGatewayScope[];
  createdAt: number;
  expiresAt: number;
}

const challenges = new Map<string, ChallengeRecord>();
const accessTokens = new Map<string, AgentAccessTokenRecord>();

function cleanupExpired(): void {
  const now = Date.now();
  for (const [challengeId, challenge] of challenges.entries()) {
    if (challenge.expiresAt <= now) challenges.delete(challengeId);
  }
  for (const [tokenHash, token] of accessTokens.entries()) {
    if (token.expiresAt <= now) accessTokens.delete(tokenHash);
  }
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function agentIdentityPath(agent: AgentInfo): string {
  return path.join(process.env['HOME'] ?? os.homedir(), '.shizuha', 'workspaces', agent.username, '.identity', 'agent-keypair.json');
}

function loadAgentPublicKey(agent: AgentInfo): string {
  const keypairPath = agentIdentityPath(agent);
  try {
    const raw = fs.readFileSync(keypairPath, 'utf-8');
    const parsed = JSON.parse(raw) as { publicKey?: string };
    if (parsed.publicKey) return parsed.publicKey;
  } catch {
    // Fall through to the error below.
  }
  throw new Error(`Agent "${agent.username}" has no registered public key`);
}

export function issueAgentGatewayChallenge(agent: AgentInfo): AgentGatewayChallenge {
  cleanupExpired();
  const issuedAt = Date.now();
  const challenge: ChallengeRecord = {
    challengeId: crypto.randomUUID(),
    nonce: crypto.randomBytes(32).toString('base64url'),
    issuedAt,
    expiresAt: issuedAt + AGENT_CHALLENGE_TTL_MS,
    agentId: agent.id,
    agentUsername: agent.username,
    publicKey: loadAgentPublicKey(agent),
  };
  challenges.set(challenge.challengeId, challenge);
  return {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    agentId: challenge.agentId,
    agentUsername: challenge.agentUsername,
  };
}

export function exchangeAgentGatewayChallenge(
  agent: AgentInfo,
  challengeId: string,
  timestamp: number,
  signature: string,
): { token: string; expiresAt: number; scopes: AgentGatewayScope[] } {
  cleanupExpired();
  const challenge = challenges.get(challengeId);
  challenges.delete(challengeId);

  if (!challenge) throw new Error('Agent auth challenge not found or expired');
  if (challenge.agentId !== agent.id) throw new Error('Agent auth challenge belongs to a different agent');
  if (!Number.isFinite(timestamp) || !signature) throw new Error('Invalid agent auth signature payload');

  const payload = buildAgentGatewayChallengePayload(challenge);
  const verified = verifySignature(payload, timestamp, challenge.publicKey, signature);
  if (!verified) throw new Error('Invalid agent auth signature');

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + AGENT_TOKEN_TTL_MS;
  accessTokens.set(tokenHash(token), {
    agentId: agent.id,
    agentName: agent.name,
    agentUsername: agent.username,
    scopes: [...DEFAULT_AGENT_GATEWAY_SCOPES],
    createdAt: Date.now(),
    expiresAt,
  });
  return {
    token,
    expiresAt,
    scopes: [...DEFAULT_AGENT_GATEWAY_SCOPES],
  };
}

export function validateAgentGatewayToken(token: string):
{ valid: false } | ({ valid: true } & AgentAccessTokenRecord) {
  cleanupExpired();
  const record = accessTokens.get(tokenHash(token));
  if (!record) return { valid: false };
  return { valid: true, ...record };
}

export function hasAgentGatewayScope(scopes: AgentGatewayScope[], required: AgentGatewayScope): boolean {
  return scopes.includes(required);
}

export function revokeAgentGatewayTokens(agentId: string): void {
  for (const [hash, token] of accessTokens.entries()) {
    if (token.agentId === agentId) accessTokens.delete(hash);
  }
}
