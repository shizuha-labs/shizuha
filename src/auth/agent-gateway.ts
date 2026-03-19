import * as http from 'node:http';
import { loadOrCreateAgentKeypair, signMessage } from '../crypto/identity.js';

export type AgentGatewayScope = 'agents:list' | 'agents:message' | 'agents:control';

export const DEFAULT_AGENT_GATEWAY_SCOPES: AgentGatewayScope[] = [
  'agents:list',
  'agents:message',
  'agents:control',
];

export interface AgentGatewayChallenge {
  challengeId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  agentId: string;
  agentUsername: string;
}

interface CachedAgentGatewayToken {
  token: string;
  expiresAt: number;
}

const DAEMON_PORT = parseInt(process.env['DAEMON_PORT'] || '8015', 10);
const DAEMON_HOST = process.env['DAEMON_HOST'] || '127.0.0.1';
const AGENT_ID = process.env['AGENT_ID'] || '';
const AGENT_USERNAME = process.env['AGENT_USERNAME'] || '';
const WORKSPACE_DIR = process.env['WORKSPACE'] || process.cwd();
const TOKEN_REFRESH_SKEW_MS = 30_000;

let cachedToken: CachedAgentGatewayToken | null = null;

function requestJson(
  method: string,
  urlPath: string,
  body: unknown,
  headers: Record<string, string>,
  timeout: number,
): Promise<{ statusCode: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: DAEMON_HOST,
      port: DAEMON_PORT,
      path: urlPath,
      method,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        } : {}),
        ...headers,
      },
      timeout,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode ?? 0,
            data: raw ? JSON.parse(raw) : {},
          });
        } catch (err) {
          reject(new Error(`Invalid JSON from daemon: ${(err as Error).message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout calling ${urlPath}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function requireAgentIdentity(): { agentIdOrUsername: string; agentUsername: string } {
  const agentIdOrUsername = AGENT_ID || AGENT_USERNAME;
  if (!agentIdOrUsername || !AGENT_USERNAME) {
    throw new Error('Agent gateway auth requires AGENT_USERNAME and an agent identity');
  }
  return { agentIdOrUsername, agentUsername: AGENT_USERNAME };
}

export function buildAgentGatewayChallengePayload(challenge: AgentGatewayChallenge): string {
  return [
    'shizuha-agent-auth-v1',
    challenge.challengeId,
    challenge.nonce,
    challenge.agentId,
    challenge.agentUsername,
  ].join('\n');
}

export function invalidateAgentGatewayToken(): void {
  cachedToken = null;
}

async function mintAgentGatewayToken(): Promise<CachedAgentGatewayToken> {
  const { agentIdOrUsername } = requireAgentIdentity();
  const challengeResp = await requestJson(
    'POST',
    '/v1/agent-auth/challenge',
    { agent_id: agentIdOrUsername },
    {},
    5000,
  );
  if (challengeResp.statusCode !== 200) {
    const error = (challengeResp.data as Record<string, unknown>)?.error;
    throw new Error(typeof error === 'string' ? error : 'Failed to create agent auth challenge');
  }

  const challenge = challengeResp.data as AgentGatewayChallenge;
  const keypair = loadOrCreateAgentKeypair(WORKSPACE_DIR);
  const payload = buildAgentGatewayChallengePayload(challenge);
  const timestamp = Date.now();
  const privateKeyPem = keypair.privateKeyPem || keypair.privateKey;
  const signature = signMessage(payload, timestamp, privateKeyPem);

  const tokenResp = await requestJson(
    'POST',
    '/v1/agent-auth/token',
    {
      agent_id: agentIdOrUsername,
      challenge_id: challenge.challengeId,
      timestamp,
      signature,
    },
    {},
    5000,
  );
  if (tokenResp.statusCode !== 200) {
    const error = (tokenResp.data as Record<string, unknown>)?.error;
    throw new Error(typeof error === 'string' ? error : 'Failed to exchange agent auth challenge');
  }

  const data = tokenResp.data as Record<string, unknown>;
  const token = data.token;
  const expiresAt = data.expiresAt;
  if (typeof token !== 'string' || typeof expiresAt !== 'number') {
    throw new Error('Daemon returned an invalid agent access token response');
  }

  cachedToken = { token, expiresAt };
  return cachedToken;
}

export async function getAgentGatewayToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) {
    return cachedToken.token;
  }
  const fresh = await mintAgentGatewayToken();
  return fresh.token;
}

export async function requestAgentGatewayJson(
  method: string,
  urlPath: string,
  body: unknown,
  timeout = 5000,
): Promise<{ statusCode: number; data: unknown }> {
  let attemptedRefresh = false;
  while (true) {
    const token = await getAgentGatewayToken();
    const response = await requestJson(
      method,
      urlPath,
      body,
      { 'Authorization': `Bearer ${token}` },
      timeout,
    );
    if (response.statusCode !== 401 || attemptedRefresh) return response;
    attemptedRefresh = true;
    invalidateAgentGatewayToken();
  }
}
