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

interface JsonResponse {
  statusCode: number;
  data: unknown;
}

// PLAT-7611: the people-ops primitives (list_agents/resume_agent/pause_agent)
// must target the port the local gateway ACTUALLY listens on. Every managed
// agent runtime — container (k8s per-agent Deployment) and bare-metal alike —
// is started with an explicit `--port 8080` (daemon/manager.ts
// CONTAINER_INTERNAL_PORT = 8080), so 8080 is the canonical in-pod endpoint.
// The old 8015 default predated the container-port unification and left fleet
// seats with no listener on 8015 (ECONNREFUSED on every people-ops call).
// Dev runs that start `shizuha up` without --port still bind 8015; set
// DAEMON_PORT=8015 explicitly in that environment.
export function daemonEndpoint(): { host: string; port: number } {
  return {
    host: process.env['DAEMON_HOST'] || '127.0.0.1',
    port: parseInt(process.env['DAEMON_PORT'] || '8080', 10),
  };
}

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
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const endpoint = daemonEndpoint();
    const req = http.request({
      hostname: endpoint.host,
      port: endpoint.port,
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
        } catch {
          resolve({
            statusCode: res.statusCode ?? 0,
            data: { raw },
          });
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

function responseErrorText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
  if (typeof record.raw === 'string' && record.raw.trim()) {
    return record.raw.replace(/\s+/g, ' ').trim().slice(0, 180);
  }
  return null;
}

export function formatAgentGatewayHttpError(
  phase: 'create' | 'exchange',
  response: JsonResponse,
): string {
  const action = phase === 'create' ? 'create agent auth challenge' : 'exchange agent auth challenge';
  const detail = responseErrorText(response.data);
  if (detail) return `Failed to ${action}: daemon returned HTTP ${response.statusCode}: ${detail}`;
  const hint = response.statusCode >= 500
    ? ' (check the runtime manager/control proxy health before seat recovery)'
    : '';
  return `Failed to ${action}: daemon returned HTTP ${response.statusCode}${hint}`;
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
    throw new Error(formatAgentGatewayHttpError('create', challengeResp));
  }

  const challenge = challengeResp.data as AgentGatewayChallenge;
  const keypair = loadOrCreateAgentKeypair(WORKSPACE_DIR, AGENT_USERNAME);
  const payload = buildAgentGatewayChallengePayload(challenge);
  const timestamp = Date.now();
  const privateKeyPem = keypair.privateKeyPem;
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
    throw new Error(formatAgentGatewayHttpError('exchange', tokenResp));
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
