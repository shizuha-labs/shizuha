import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { AuditLogger } from '../security/audit.js';
import { AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER, AGENT_CREDENTIAL_SCOPES, assertAgentCredentialScope, defaultAgentCredentialBrokerDir } from './agent-credential.js';
import type { AgentCredentialScope } from './types.js';

export const CREDENTIAL_REQUEST_SOCKET_ENV = 'SHIZUHA_CREDENTIAL_REQUEST_SOCKET';
export const CREDENTIAL_GRANT_SOCKET_ENV = 'SHIZUHA_CREDENTIAL_GRANT_SOCKET';
export const UPDATE_AGENT_SSH_KEYS_DEPRECATION_REMOVAL_DATE = '2026-07-05';

const BROKER_TIMEOUT_MS = 5_000;

export const AGENT_CREDENTIAL_TOOLS = [
  {
    name: 'agent_request_credential',
    description:
      'Request access to a credential scope through the AgentCredential broker socket. ' +
      'This never writes credential rows directly; it sends a durable request to the broker for approval/granting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', enum: [...AGENT_CREDENTIAL_SCOPES], description: 'Credential scope being requested.' },
        reason: { type: 'string', description: 'Why this credential is needed. Required for auditability.' },
        expiry: { type: 'string', description: 'Optional requested ISO-8601 expiry for the grant.' },
      },
      required: ['scope', 'reason'],
    },
  },
  {
    name: 'agent_grant_credential',
    description:
      'Grant a credential to another agent through the grant broker socket. ' +
      `Only available when ${CREDENTIAL_GRANT_SOCKET_ENV} is mounted. The broker authorizes caller/scope from UDS transport identity and ACLs.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        grantee: { type: 'string', description: 'Agent username, email, or ID receiving the grant.' },
        scope: { type: 'string', enum: [...AGENT_CREDENTIAL_SCOPES], description: 'Credential scope to grant.' },
        payload: { type: 'object', description: 'Opaque credential payload for the broker to encrypt/store.' },
        service: { type: 'string', description: 'Required when scope=custom; service allowlist key such as forgejo.' },
        label: { type: 'string', description: 'Optional human-readable credential label.' },
        expiry: { type: 'string', description: 'Optional ISO-8601 expiry for the grant.' },
        envMapping: { type: 'object', description: 'Optional credentialData key → environment variable mapping to preserve on replacement grants.' },
      },
      required: ['grantee', 'scope', 'payload'],
    },
  },
  {
    name: 'agent_list_credentials',
    description:
      'List AgentCredential grants through broker sockets. ' +
      'mode=metadata is self-service metadata over the request socket. mode=audit uses the grant socket for cross-agent metadata audit. ' +
      'mode=payload is a distinct break-glass grant-socket path requiring a reason and separate audit logging. The broker enforces self/audit/payload authorization from UDS identity, not env.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string', description: 'Agent username/email/ID. Defaults to self for metadata mode.' },
        mode: { type: 'string', enum: ['metadata', 'audit', 'payload'], description: 'Read mode. payload is security-lead break-glass only.' },
        reason: { type: 'string', description: 'Required for payload break-glass, recommended for audit mode.' },
      },
    },
  },
  {
    name: 'agent_revoke_credential',
    description:
      'Revoke an AgentCredential grant through broker sockets. ' +
      'Self-revoke uses the request socket; cross-agent revoke uses the grant socket when exposed. The broker enforces ownership/role rules; this client only routes the signed request and records intent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        grant_id: { type: 'string', description: 'Credential grant UUID/ID to revoke.' },
        reason: { type: 'string', description: 'Revocation reason for audit trail.' },
      },
      required: ['grant_id', 'reason'],
    },
  },
  {
    name: 'agent_upsert_self_credential',
    description:
      'Persist a custom/social-media credential for THIS agent over the request socket (self-service, PLAT-1167). ' +
      'Scope is always "custom"; use service to distinguish credentials (e.g. "hackernews", "x-twitter"). ' +
      'Does NOT require a grant socket and cannot target other agents. ' +
      'Replaces any existing active custom credential for the same service. ' +
      'Never include secret payload values in Pulse comments or logs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        service: { type: 'string', description: 'Arbitrary service name (e.g. "hackernews", "x-twitter"). Max 128 chars.' },
        payload: { type: 'object', description: 'Credential data (key→value). Values are encrypted at rest; never log them.' },
        label: { type: 'string', description: 'Optional human-readable label.' },
        expiry: { type: 'string', description: 'Optional ISO-8601 expiry.' },
        envMapping: { type: 'object', description: 'Optional credentialData key → env var name mapping.' },
      },
      required: ['service', 'payload'],
    },
  },
  {
    name: 'agent_query_credential_audit',
    description:
      'Query the append-only AgentCredential audit stream through the grant broker socket. ' +
      'Authorization is broker-enforced from UDS identity/audit roles; supports grantor, grantee, scope, and ISO time range filters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        grantor: { type: 'string', description: 'Grantor actor ID/email/username filter.' },
        grantee: { type: 'string', description: 'Grantee agent ID/email/username filter.' },
        scope: { type: 'string', enum: [...AGENT_CREDENTIAL_SCOPES], description: 'Credential scope filter.' },
        from: { type: 'string', description: 'Inclusive ISO timestamp lower bound.' },
        to: { type: 'string', description: 'Inclusive ISO timestamp upper bound.' },
        limit: { type: 'number', description: 'Maximum events to return (1-1000).' },
      },
    },
  },
];

export interface AgentCredentialToolContext {
  env?: NodeJS.ProcessEnv;
  auditLogger?: AuditLogger;
  workspaceAgent?: string;
}

export interface LegacySshKeysShimGrant {
  grantee: string;
  scope: 'fleet-ssh';
  payload: Record<string, unknown>;
  injectAsEnv: false;
}

export interface BrokerEnvelope {
  action:
    | 'request_credential'
    | 'grant_credential'
    | 'upsert_self_credential'
    | 'list_credentials'
    | 'revoke_credential'
    | 'deny_request'
    | 'expire_requests'
    | 'query_audit';
  /**
   * Authority is intentionally absent from the client envelope. The broker must
   * derive caller identity/role from the Unix socket transport (SO_PEERCRED /
   * socket ACL), never from spoofable request parameters or environment.
   */
  request: Record<string, unknown>;
}

function envValue(env: NodeJS.ProcessEnv, name: string, fallback = ''): string {
  return env[name] || fallback;
}

function requireScope(value: unknown): AgentCredentialScope {
  return assertAgentCredentialScope(value);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalStringMap(value: unknown, key: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const objectValue = assertJsonObject(value, key);
  const map: Record<string, string> = {};
  for (const [mapKey, mapValue] of Object.entries(objectValue)) {
    if (typeof mapValue !== 'string' || mapValue.trim() === '') {
      throw new Error(`${key}.${mapKey} must be a non-empty string`);
    }
    map[mapKey] = mapValue;
  }
  return map;
}

function isSocketPath(sockPath: string): boolean {
  try { return fs.statSync(sockPath).isSocket(); } catch { return false; }
}

function requestSocketPath(env: NodeJS.ProcessEnv): string {
  const configured = envValue(env, CREDENTIAL_REQUEST_SOCKET_ENV).trim();
  if (configured) return configured;
  // Prefer the container-standard path if present before falling back to tmpdir (PLAT-1167).
  if (isSocketPath(AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER)) return AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER;
  return path.join(defaultAgentCredentialBrokerDir(), 'request.sock');
}

function grantSocketPath(env: NodeJS.ProcessEnv): string {
  const socketPath = envValue(env, CREDENTIAL_GRANT_SOCKET_ENV).trim();
  if (!socketPath) {
    throw new Error(`${CREDENTIAL_GRANT_SOCKET_ENV} is not set; grant socket was not exposed for this agent`);
  }
  return socketPath;
}

function optionalGrantSocketPath(env: NodeJS.ProcessEnv): string | undefined {
  return envValue(env, CREDENTIAL_GRANT_SOCKET_ENV).trim() || undefined;
}

function assertJsonObject(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function buildUpdateAgentSshKeysShimGrant(
  grantee: unknown,
  sshKeys: unknown,
): LegacySshKeysShimGrant {
  if (typeof grantee !== 'string' || grantee.trim() === '') {
    throw new Error('target is required for deprecated update_agent.ssh_keys shim');
  }
  const payload = assertJsonObject(sshKeys, 'ssh_keys');
  return { grantee: grantee.trim(), scope: 'fleet-ssh', payload, injectAsEnv: false };
}

export function isLegacySshKeysDisable(sshKeys: unknown): boolean {
  return !sshKeys ||
    typeof sshKeys !== 'object' ||
    Array.isArray(sshKeys) ||
    !(sshKeys as { enabled?: unknown }).enabled;
}

export async function handleUpdateAgentSshKeysShim(
  grantee: unknown,
  sshKeys: unknown,
  context: AgentCredentialToolContext = {},
): Promise<string> {
  const grant = buildUpdateAgentSshKeysShimGrant(grantee, sshKeys);
  return handleAgentCredentialTool('agent_grant_credential', { ...grant }, context);
}

export function buildCredentialBrokerEnvelope(
  action: BrokerEnvelope['action'],
  request: Record<string, unknown>,
  _env: NodeJS.ProcessEnv = process.env,
): BrokerEnvelope {
  return { action, request };
}

export function requestCredentialBroker(
  socketPath: string,
  envelope: BrokerEnvelope,
  timeoutMs = BROKER_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    let raw = '';
    const timer = setTimeout(() => {
      finish(new Error(`Credential broker timed out via ${socketPath}`));
      socket.destroy();
    }, timeoutMs);

    function finish(err?: Error, value?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    }

    socket.on('connect', () => {
      socket.write(JSON.stringify(envelope) + '\n');
    });
    socket.on('data', (chunk) => { raw += chunk.toString('utf8'); });
    socket.on('end', () => {
      try {
        finish(undefined, raw.trim() ? JSON.parse(raw) : {});
      } catch (err) {
        finish(new Error(`Credential broker returned invalid JSON: ${(err as Error).message}`));
      }
    });
    socket.on('error', (err) => finish(err));
  });
}

function formatBrokerResult(result: unknown): string {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const objectResult = result as Record<string, unknown>;
    if (objectResult.ok === false) {
      const message = typeof objectResult.error === 'string' && objectResult.error.trim()
        ? objectResult.error.trim()
        : 'Credential broker request failed';
      throw new Error(message);
    }
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

export async function handleAgentCredentialTool(
  name: string,
  args: Record<string, unknown>,
  context: AgentCredentialToolContext = {},
): Promise<string> {
  const env = context.env ?? process.env;

  if (name === 'agent_request_credential') {
    const scope = requireScope(args.scope);
    const reason = requireString(args, 'reason');
    const result = await requestCredentialBroker(
      requestSocketPath(env),
      buildCredentialBrokerEnvelope('request_credential', { scope, reason, expiry: args.expiry }, env),
    );
    return formatBrokerResult(result);
  }

  if (name === 'agent_grant_credential') {
    const scope = requireScope(args.scope);
    const payload = assertJsonObject(args.payload, 'payload');
    const envMapping = optionalStringMap(args.envMapping, 'envMapping');
    const result = await requestCredentialBroker(
      grantSocketPath(env),
      buildCredentialBrokerEnvelope('grant_credential', {
        grantee: requireString(args, 'grantee'),
        scope,
        payload,
        service: args.service,
        label: args.label,
        expiry: args.expiry,
        injectAsEnv: args.injectAsEnv,
        ...(envMapping ? { envMapping } : {}),
        deferInjectableRestart: args.deferInjectableRestart,
      }, env),
    );
    return formatBrokerResult(result);
  }

  if (name === 'agent_list_credentials') {
    const mode = (args.mode as string | undefined) ?? 'metadata';
    if (!['metadata', 'audit', 'payload'].includes(mode)) {
      throw new Error('mode must be metadata, audit, or payload');
    }
    const target = args.agent as string | undefined;
    if (mode === 'payload') {
      // Payload mode is intentionally only syntax-gated here. Authorization is
      // broker-enforced from UDS transport identity/ACL; env-derived role values
      // are spoofable and must not make an authority decision in this client.
      const reason = requireString(args, 'reason');
      const auditId = context.auditLogger?.logBefore(
        env['AGENT_USERNAME'] ?? context.workspaceAgent ?? 'unknown',
        'agent_list_credentials:payload_break_glass',
        { agent: target ?? env['AGENT_USERNAME'], mode, reason },
      );
      const started = Date.now();
      try {
        const result = await requestCredentialBroker(
          grantSocketPath(env),
          buildCredentialBrokerEnvelope('list_credentials', { agent: target, mode, reason }, env),
        );
        if (auditId) context.auditLogger?.logAfter(auditId, env['AGENT_USERNAME'] ?? 'unknown', 'agent_list_credentials:payload_break_glass', 'broker response returned', Date.now() - started);
        return formatBrokerResult(result);
      } catch (err) {
        if (auditId) context.auditLogger?.logError(auditId, env['AGENT_USERNAME'] ?? 'unknown', 'agent_list_credentials:payload_break_glass', (err as Error).message, Date.now() - started);
        throw err;
      }
    }

    const result = await requestCredentialBroker(
      mode === 'audit' ? grantSocketPath(env) : requestSocketPath(env),
      buildCredentialBrokerEnvelope('list_credentials', { agent: target, mode, reason: args.reason }, env),
    );
    return formatBrokerResult(result);
  }

  if (name === 'agent_revoke_credential') {
    const result = await requestCredentialBroker(
      optionalGrantSocketPath(env) ?? requestSocketPath(env),
      buildCredentialBrokerEnvelope('revoke_credential', {
        grant_id: requireString(args, 'grant_id'),
        reason: requireString(args, 'reason'),
        deferInjectableRestart: args.deferInjectableRestart,
      }, env),
    );
    return formatBrokerResult(result);
  }

  if (name === 'agent_upsert_self_credential') {
    const service = requireString(args, 'service');
    const payload = assertJsonObject(args.payload, 'payload');
    const envMapping = optionalStringMap(args.envMapping, 'envMapping');
    const result = await requestCredentialBroker(
      requestSocketPath(env),
      buildCredentialBrokerEnvelope('upsert_self_credential', {
        service,
        payload,
        label: args.label,
        expiry: args.expiry,
        ...(envMapping ? { envMapping } : {}),
      }, env),
    );
    return formatBrokerResult(result);
  }

  if (name === 'agent_query_credential_audit') {
    const request: Record<string, unknown> = {};
    for (const key of ['grantor', 'grantee', 'from', 'to'] as const) {
      if (typeof args[key] === 'string' && args[key].trim()) request[key] = args[key].trim();
    }
    if (args.scope !== undefined) request.scope = requireScope(args.scope);
    if (args.limit !== undefined) request.limit = args.limit;
    const result = await requestCredentialBroker(
      grantSocketPath(env),
      buildCredentialBrokerEnvelope('query_audit', request, env),
    );
    return formatBrokerResult(result);
  }

  throw new Error(`Unknown AgentCredential tool: ${name}`);
}
