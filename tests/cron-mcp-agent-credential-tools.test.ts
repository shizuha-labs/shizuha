import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUpdateAgentSshKeysShimGrant,
  buildCredentialBrokerEnvelope,
  handleAgentCredentialTool,
  handleUpdateAgentSshKeysShim,
  isLegacySshKeysDisable,
  UPDATE_AGENT_SSH_KEYS_DEPRECATION_REMOVAL_DATE,
} from '../src/daemon/agent-credential-broker-tools.js';
import {
  AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
  AGENT_CREDENTIAL_GRANT_SOCKET_ENV,
  AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV,
  AGENT_CREDENTIAL_GRANT_SOCKET_HOST_ENV,
  AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
  AGENT_CREDENTIAL_REQUEST_SOCKET_ENV,
  AGENT_CREDENTIAL_REQUEST_SOCKET_HOST_ENV,
  AGENT_CREDENTIAL_SOCKET_DIR,
  defaultAgentCredentialBrokerDir,
  filterAgentCredentialBrokerExtraDockerArgs,
  filterAgentCredentialBrokerExtraVolumes,
  planAgentCredentialBrokerSockets,
  resolveAgentCredentialBrokerReservedHostPaths,
  scrubAgentCredentialBrokerReservedEnv,
} from '../src/daemon/agent-credential.js';
import type { AgentInfo } from '../src/daemon/types.js';

const tempDirs: string[] = [];
const originalDockerHost = process.env.DOCKER_HOST;
const originalDockerContext = process.env.DOCKER_CONTEXT;
const originalPath = process.env.PATH;
const originalCredentialBrokerDir = process.env.SHIZUHA_CREDENTIAL_BROKER_DIR;
const originalCredentialAgentSocketDir = process.env.SHIZUHA_CREDENTIAL_AGENT_SOCKET_DIR;
const originalRequestSocketHost = process.env.SHIZUHA_CREDENTIAL_REQUEST_SOCKET_HOST;
const originalGrantSocketHost = process.env.SHIZUHA_CREDENTIAL_GRANT_SOCKET_HOST;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (originalDockerHost === undefined) {
    delete process.env.DOCKER_HOST;
  } else {
    process.env.DOCKER_HOST = originalDockerHost;
  }
  if (originalDockerContext === undefined) {
    delete process.env.DOCKER_CONTEXT;
  } else {
    process.env.DOCKER_CONTEXT = originalDockerContext;
  }
  if (originalCredentialBrokerDir === undefined) {
    delete process.env.SHIZUHA_CREDENTIAL_BROKER_DIR;
  } else {
    process.env.SHIZUHA_CREDENTIAL_BROKER_DIR = originalCredentialBrokerDir;
  }
  if (originalCredentialAgentSocketDir === undefined) {
    delete process.env.SHIZUHA_CREDENTIAL_AGENT_SOCKET_DIR;
  } else {
    process.env.SHIZUHA_CREDENTIAL_AGENT_SOCKET_DIR = originalCredentialAgentSocketDir;
  }
  if (originalRequestSocketHost === undefined) {
    delete process.env.SHIZUHA_CREDENTIAL_REQUEST_SOCKET_HOST;
  } else {
    process.env.SHIZUHA_CREDENTIAL_REQUEST_SOCKET_HOST = originalRequestSocketHost;
  }
  if (originalGrantSocketHost === undefined) {
    delete process.env.SHIZUHA_CREDENTIAL_GRANT_SOCKET_HOST;
  } else {
    process.env.SHIZUHA_CREDENTIAL_GRANT_SOCKET_HOST = originalGrantSocketHost;
  }
  process.env.PATH = originalPath;
});

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-1',
    name: 'Ryo',
    username: 'ryo',
    email: 'ryo@shizuha.com',
    role: 'Engineer',
    status: 'active',
    mcpServers: [],
    personalityTraits: {},
    skills: [],
    ...overrides,
  };
}

async function withBroker<T>(handler: (socketPath: string, seen: unknown[]) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-broker-'));
  tempDirs.push(dir);
  const socketPath = path.join(dir, 'broker.sock');
  const seen: unknown[] = [];
  const server = net.createServer((socket) => {
    let raw = '';
    socket.on('data', (chunk) => { raw += chunk.toString('utf8'); });
    socket.on('end', () => {});
    socket.on('data', () => {
      if (!raw.includes('\n')) return;
      seen.push(JSON.parse(raw.trim()));
      socket.end(JSON.stringify({ ok: true, received: seen.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    return await handler(socketPath, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withBrokerResponse<T>(response: unknown, handler: (socketPath: string, seen: unknown[]) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-broker-'));
  tempDirs.push(dir);
  const socketPath = path.join(dir, 'broker.sock');
  const seen: unknown[] = [];
  const server = net.createServer((socket) => {
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (!raw.includes('\n')) return;
      seen.push(JSON.parse(raw.trim()));
      socket.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    return await handler(socketPath, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('AgentCredential broker tools', () => {
  it('builds broker envelopes without spoofable actor authority', () => {
    const envelope = buildCredentialBrokerEnvelope('request_credential', { scope: 'github' }, {
      AGENT_ID: 'agent-1',
      AGENT_USERNAME: 'ryo',
      AGENT_EMAIL: 'ryo@shizuha.com',
      AGENT_ORG_ROLE: 'engineering',
      AGENT_IS_SUPERUSER: 'true',
    } as NodeJS.ProcessEnv);

    expect(envelope).toEqual({ action: 'request_credential', request: { scope: 'github' } });
    expect(envelope).not.toHaveProperty('actor');
    expect(envelope).not.toHaveProperty('client_hint');
  });

  it('routes request/list/revoke calls over the request socket', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = {
        AGENT_ID: 'agent-1',
        AGENT_USERNAME: 'ryo',
        SHIZUHA_CREDENTIAL_REQUEST_SOCKET: socketPath,
      } as NodeJS.ProcessEnv;

      const result = await handleAgentCredentialTool('agent_request_credential', { scope: 'github', reason: 'needed for PR authoring' }, { env });

      expect(JSON.parse(result)).toEqual({ ok: true, received: 1 });
      expect(seen[0]).toMatchObject({
        action: 'request_credential',
        request: { scope: 'github', reason: 'needed for PR authoring' },
      });
      expect(seen[0]).not.toHaveProperty('actor');
    });
  });

  it('routes audit mode to the grant socket instead of authorizing from env', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = {
        AGENT_ID: 'agent-1',
        AGENT_USERNAME: 'ryo',
        SHIZUHA_CREDENTIAL_REQUEST_SOCKET: '/unused/request.sock',
        SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath,
      } as NodeJS.ProcessEnv;

      await handleAgentCredentialTool('agent_list_credentials', { agent: 'akira', mode: 'audit', reason: 'inventory' }, { env });

      expect(seen[0]).toMatchObject({ action: 'list_credentials', request: { agent: 'akira', mode: 'audit', reason: 'inventory' } });
      expect(seen[0]).not.toHaveProperty('actor');
    });
  });

  it('requires payload break-glass reason before routing to the broker', async () => {
    const env = { AGENT_ID: 'agent-1', AGENT_USERNAME: 'akira', AGENT_ORG_ROLE: 'security-lead' } as NodeJS.ProcessEnv;

    await expect(handleAgentCredentialTool('agent_list_credentials', { agent: 'ryo', mode: 'payload' }, { env }))
      .rejects.toThrow(/reason is required/);
  });

  it('routes payload mode with distinct break-glass audit logging and no actor authority', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = {
        AGENT_ID: 'agent-2',
        AGENT_USERNAME: 'ren',
        AGENT_ORG_ROLE: 'security',
        SHIZUHA_CREDENTIAL_REQUEST_SOCKET: '/unused/request.sock',
        SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath,
      } as NodeJS.ProcessEnv;

      await handleAgentCredentialTool('agent_list_credentials', { agent: 'ryo', mode: 'payload', reason: 'credential compromise drill' }, { env });

      expect(seen[0]).toMatchObject({
        action: 'list_credentials',
        request: { agent: 'ryo', mode: 'payload', reason: 'credential compromise drill' },
      });
      expect(seen[0]).not.toHaveProperty('actor');
    });
  });

  it('fails closed without an explicitly exposed grant socket env var', async () => {
    const env = { AGENT_USERNAME: 'ryo' } as NodeJS.ProcessEnv;

    await expect(handleAgentCredentialTool('agent_grant_credential', { grantee: 'kai', scope: 'github', payload: { token: 'redacted' } }, { env }))
      .rejects.toThrow(/SHIZUHA_CREDENTIAL_GRANT_SOCKET is not set/);
  });

  it('routes grant requests through the grant socket without env-derived authorization', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = { AGENT_USERNAME: 'ryo', AGENT_ORG_ROLE: 'engineering', SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath } as NodeJS.ProcessEnv;

      await handleAgentCredentialTool('agent_grant_credential', { grantee: 'kai', scope: 'github', payload: { token: 'redacted' } }, { env });

      expect(seen[0]).toMatchObject({
        action: 'grant_credential',
        request: { grantee: 'kai', scope: 'github', payload: { token: 'redacted' } },
      });
      expect(seen[0]).not.toHaveProperty('actor');
    });
  });
  it('routes revoke over the grant socket when one is exposed', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = {
        AGENT_USERNAME: 'ryo',
        SHIZUHA_CREDENTIAL_REQUEST_SOCKET: '/unused/request.sock',
        SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath,
      } as NodeJS.ProcessEnv;

      await handleAgentCredentialTool('agent_revoke_credential', { grant_id: 'grant-1', reason: 'rotate' }, { env });

      expect(seen[0]).toMatchObject({
        action: 'revoke_credential',
        request: { grant_id: 'grant-1', reason: 'rotate' },
      });
    });
  });

  it('routes credential audit queries through the grant socket', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = {
        AGENT_USERNAME: 'ren',
        SHIZUHA_CREDENTIAL_REQUEST_SOCKET: '/unused/request.sock',
        SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath,
      } as NodeJS.ProcessEnv;

      await handleAgentCredentialTool('agent_query_credential_audit', {
        grantor: 'alice@shizuha.com',
        grantee: 'bob',
        scope: 'github',
        from: '2026-06-05T00:00:00.000Z',
        to: '2026-06-05T23:59:59.000Z',
        limit: 25,
      }, { env });

      expect(seen[0]).toMatchObject({
        action: 'query_audit',
        request: {
          grantor: 'alice@shizuha.com',
          grantee: 'bob',
          scope: 'github',
          from: '2026-06-05T00:00:00.000Z',
          to: '2026-06-05T23:59:59.000Z',
          limit: 25,
        },
      });
      expect(seen[0]).not.toHaveProperty('actor');
    });
  });

  it('builds the deprecated update_agent.ssh_keys shim as a fleet-ssh grant', () => {
    expect(UPDATE_AGENT_SSH_KEYS_DEPRECATION_REMOVAL_DATE).toBe('2026-07-05');

    const grant = buildUpdateAgentSshKeysShimGrant(' kai ', {
      enabled: true,
      sshDir: '/home/user/.ssh',
      keyFiles: ['id_ed25519'],
      remoteUser: 'phoenix',
    });

    expect(grant).toEqual({
      grantee: 'kai',
      scope: 'fleet-ssh',
      payload: {
        enabled: true,
        sshDir: '/home/user/.ssh',
        keyFiles: ['id_ed25519'],
        remoteUser: 'phoenix',
      },
      injectAsEnv: false,
    });
  });

  it('keeps non-enabled legacy ssh_keys requests on the daemon revoke/no-grant path', () => {
    expect(isLegacySshKeysDisable({ enabled: false })).toBe(true);
    expect(isLegacySshKeysDisable({ enabled: 0 })).toBe(true);
    expect(isLegacySshKeysDisable({ keyFiles: [] })).toBe(true);
    expect(isLegacySshKeysDisable(null)).toBe(true);
    expect(isLegacySshKeysDisable('disabled')).toBe(true);
    expect(isLegacySshKeysDisable({ enabled: true })).toBe(false);
    expect(isLegacySshKeysDisable({ enabled: 1 })).toBe(false);
  });

  it('preserves envMapping and deferred restart hints in grant broker envelopes', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = { AGENT_USERNAME: 'ryo', SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath } as NodeJS.ProcessEnv;

      await handleAgentCredentialTool('agent_grant_credential', {
        grantee: 'ryo',
        scope: 'github',
        payload: { token: 'redacted' },
        envMapping: { token: 'GITHUB_TOKEN' },
        deferInjectableRestart: true,
      }, { env });

      expect(seen[0]).toMatchObject({
        action: 'grant_credential',
        request: {
          grantee: 'ryo',
          scope: 'github',
          payload: { token: 'redacted' },
          envMapping: { token: 'GITHUB_TOKEN' },
          deferInjectableRestart: true,
        },
      });
    });
  });

  it('rejects non-string envMapping values before sending grant envelopes', async () => {
    await withBroker(async (socketPath) => {
      const env = { AGENT_USERNAME: 'ryo', SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath } as NodeJS.ProcessEnv;

      await expect(handleAgentCredentialTool('agent_grant_credential', {
        grantee: 'ryo',
        scope: 'github',
        payload: { token: 'redacted' },
        envMapping: { token: 123 },
      }, { env })).rejects.toThrow('envMapping.token must be a non-empty string');
    });
  });

  it('routes deprecated update_agent.ssh_keys through the grant broker', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = { AGENT_USERNAME: 'ryo', SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath } as NodeJS.ProcessEnv;

      await handleUpdateAgentSshKeysShim('kai', { enabled: true, keyFiles: ['id_ed25519'] }, { env });

      expect(seen[0]).toMatchObject({
        action: 'grant_credential',
        request: {
          grantee: 'kai',
          scope: 'fleet-ssh',
          payload: { enabled: true, keyFiles: ['id_ed25519'] },
          injectAsEnv: false,
        },
      });
      expect(seen[0]).not.toHaveProperty('actor');
    });
  });

  it('fails deprecated update_agent.ssh_keys when the broker rejects the grant', async () => {
    await withBrokerResponse({ ok: false, error: 'Caller ryo is not authorized to grant fleet-ssh' }, async (socketPath) => {
      const env = { AGENT_USERNAME: 'ryo', SHIZUHA_CREDENTIAL_GRANT_SOCKET: socketPath } as NodeJS.ProcessEnv;

      await expect(
        handleUpdateAgentSshKeysShim('kai', { enabled: true, keyFiles: ['id_ed25519'] }, { env }),
      ).rejects.toThrow('Caller ryo is not authorized to grant fleet-ssh');
    });
  });

  // PLAT-1167: regression tests for env propagation fix and upsert_self_credential
  it('routes agent_upsert_self_credential over the request socket without grant authority', async () => {
    await withBroker(async (socketPath, seen) => {
      const env = {
        AGENT_USERNAME: 'nori',
        SHIZUHA_CREDENTIAL_REQUEST_SOCKET: socketPath,
      } as NodeJS.ProcessEnv;

      const result = await handleAgentCredentialTool('agent_upsert_self_credential', {
        service: 'hackernews',
        payload: { HN_USERNAME: 'nori_hn', HN_PASSWORD: 'redacted' },
        label: 'Hacker News',
      }, { env });

      expect(JSON.parse(result)).toMatchObject({ ok: true, received: 1 });
      expect(seen[0]).toMatchObject({
        action: 'upsert_self_credential',
        request: {
          service: 'hackernews',
          payload: { HN_USERNAME: 'nori_hn', HN_PASSWORD: 'redacted' },
          label: 'Hacker News',
        },
      });
      // Broker identity must not come from env (PLAT-1167 contract: UDS-derived)
      expect(seen[0]).not.toHaveProperty('actor');
      expect((seen[0] as Record<string, unknown>)['request']).not.toHaveProperty('grantee');
    });
  });

  it('uses container socket path fallback when SHIZUHA_CREDENTIAL_REQUEST_SOCKET is absent', () => {
    // Verify that the requestSocketPath function prefers the container socket
    // over the tmpdir when the env var is not set — the live socket check is
    // exercised at runtime but we verify the code path is present.
    const toolsSrc = fs.readFileSync(path.join(process.cwd(), 'src/daemon/agent-credential-broker-tools.ts'), 'utf8');
    expect(toolsSrc).toContain('AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER');
    expect(toolsSrc).toContain('isSocketPath(AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER)');
    // Must check container path before falling back to tmpdir
    const containerIdx = toolsSrc.indexOf('isSocketPath(AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER)');
    const tmpdirIdx = toolsSrc.indexOf('defaultAgentCredentialBrokerDir()');
    expect(containerIdx).toBeGreaterThan(-1);
    expect(tmpdirIdx).toBeGreaterThan(containerIdx);
  });

});

describe('AgentCredential broker socket mount planning', () => {
  function buildLaunchEnv(agent: AgentInfo): Record<string, string> {
    const customEnv = scrubAgentCredentialBrokerReservedEnv(agent.env ?? {});
    const brokerPlan = planAgentCredentialBrokerSockets(agent, {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });
    return { ...customEnv, ...brokerPlan.env };
  }

  it('defaults host mounts to daemon-created per-agent sockets for container identity binding', () => {
    const agent = makeAgent({ id: 'agent-default', username: 'ryo' });
    const plan = planAgentCredentialBrokerSockets(agent, { socketExists: () => true });

    expect(plan.mounts[0]).toMatchObject({
      hostPath: path.join(defaultAgentCredentialBrokerDir(), 'agents', 'agent-default', 'request.sock'),
      containerPath: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
    });
  });

  it('ignores shared host socket env overrides for container launch plans', () => {
    process.env[AGENT_CREDENTIAL_REQUEST_SOCKET_HOST_ENV] = '/shared/request.sock';
    process.env[AGENT_CREDENTIAL_GRANT_SOCKET_HOST_ENV] = '/shared/grant.sock';

    const agent = makeAgent({ id: 'agent-env', username: 'ryo', credentialGrantScopes: ['github'] });
    const plan = planAgentCredentialBrokerSockets(agent, { socketExists: () => true });

    expect(plan.mounts.map((mount) => mount.hostPath)).toEqual([
      path.join(defaultAgentCredentialBrokerDir(), 'agents', 'agent-env', 'request.sock'),
      path.join(defaultAgentCredentialBrokerDir(), 'agents', 'agent-env', 'grant.sock'),
    ]);
  });

  it('withholds broker sockets from bare-metal agents by default', () => {
    const plan = planAgentCredentialBrokerSockets(makeAgent({ runtimeEnvironment: 'bare_metal', credentialGrantScopes: ['github'] }), { socketExists: () => true });

    expect(plan.mounts).toEqual([]);
    expect(plan.env).toEqual({});
  });

  it('injects shared host broker socket env for explicitly UID-bound bare-metal grant agents', () => {
    const plan = planAgentCredentialBrokerSockets(makeAgent({
      runtimeEnvironment: 'bare_metal',
      credentialBrokerPeerUid: 4242,
      credentialGrantScopes: ['github'],
    }), {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });

    expect(plan.mounts).toEqual([]);
    expect(plan.grantScopes).toEqual(['github']);
    expect(plan.env).toMatchObject({
      [AGENT_CREDENTIAL_REQUEST_SOCKET_ENV]: '/host/request.sock',
      [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: '/host/grant.sock',
      [AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV]: 'github',
    });
  });

  it('honors configured per-agent socket directories in container launch plans', () => {
    process.env.SHIZUHA_CREDENTIAL_AGENT_SOCKET_DIR = '/custom/broker/agents';

    const plan = planAgentCredentialBrokerSockets(makeAgent({ id: 'agent-custom', username: 'ryo' }), { socketExists: () => true });

    expect(plan.mounts[0]).toMatchObject({
      hostPath: '/custom/broker/agents/agent-custom/request.sock',
      containerPath: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
    });
  });

  it('mounts request socket for every agent but withholds grant socket without grant scopes', () => {
    const plan = planAgentCredentialBrokerSockets(makeAgent(), {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });

    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]).toMatchObject({ hostPath: '/host/request.sock', containerPath: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER });
    expect(plan.env).toEqual({ SHIZUHA_CREDENTIAL_REQUEST_SOCKET: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER });
  });

  it('does not mount grant socket from mutable custom env alone', () => {
    const plan = planAgentCredentialBrokerSockets(makeAgent({ env: { SHIZUHA_CREDENTIAL_GRANT_SCOPES: 'github,npm' } }), {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });

    expect(plan.grantScopes).toEqual([]);
    expect(plan.mounts.map((mount) => mount.containerPath)).toEqual([AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER]);
    expect(plan.env).not.toHaveProperty('SHIZUHA_CREDENTIAL_GRANT_SOCKET');
    expect(plan.env).not.toHaveProperty('SHIZUHA_CREDENTIAL_GRANT_SCOPES');
  });

  it('mounts grant socket for service-scoped custom grant authority', () => {
    const plan = planAgentCredentialBrokerSockets(makeAgent({ credentialCustomGrantServices: ['forgejo'] }), {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });

    expect(plan.grantScopes).toEqual([]);
    expect(plan.mounts.map((mount) => mount.containerPath)).toEqual([
      AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
      AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
    ]);
    expect(plan.env).toMatchObject({
      [AGENT_CREDENTIAL_REQUEST_SOCKET_ENV]: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
      [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
      SHIZUHA_CREDENTIAL_CUSTOM_GRANT_SERVICES: 'forgejo',
    });
    expect(plan.env).not.toHaveProperty(AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV);
  });

  it('mounts grant socket only when platform permission record has grant scopes', () => {
    const plan = planAgentCredentialBrokerSockets(makeAgent({ credentialGrantScopes: ['github', 'npm'] }), {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });

    expect(plan.grantScopes).toEqual(['github', 'npm']);
    expect(plan.mounts.map((mount) => mount.containerPath)).toEqual([
      AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
      AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
    ]);
    expect(plan.env).toMatchObject({
      SHIZUHA_CREDENTIAL_REQUEST_SOCKET: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
      SHIZUHA_CREDENTIAL_GRANT_SOCKET: AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
      SHIZUHA_CREDENTIAL_GRANT_SCOPES: 'github,npm',
    });
  });

  it('exposes grant socket for payload-read-only agents without granting write scopes', () => {
    const plan = planAgentCredentialBrokerSockets(makeAgent({ credentialPayloadReadScopes: ['github'] }), {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });

    expect(plan.grantScopes).toEqual([]);
    expect(plan.mounts.map((mount) => mount.containerPath)).toEqual([
      AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
      AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
    ]);
    expect(plan.env).toMatchObject({
      [AGENT_CREDENTIAL_REQUEST_SOCKET_ENV]: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
      [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
    });
    expect(plan.env).not.toHaveProperty(AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV);
  });

  it('exposes grant socket for metadata-audit agents without granting write scopes', () => {
    const plan = planAgentCredentialBrokerSockets(makeAgent({ credentialAuditRoles: ['metadata-audit'] }), {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });

    expect(plan.grantScopes).toEqual([]);
    expect(plan.mounts.map((mount) => mount.containerPath)).toEqual([
      AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
      AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
    ]);
    expect(plan.env).toHaveProperty(AGENT_CREDENTIAL_GRANT_SOCKET_ENV, AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER);
    expect(plan.env).not.toHaveProperty(AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV);
  });

  it('scrubs daemon-managed broker env from mutable custom env before launch', () => {
    const scrubbed = scrubAgentCredentialBrokerReservedEnv({
      SAFE_ENV: 'kept',
      [AGENT_CREDENTIAL_REQUEST_SOCKET_ENV]: '/tmp/agent-request.sock',
      [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: '/run/shizuha/agent-credentials/grant.sock',
      [AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV]: 'github,npm',
    });

    expect(scrubbed).toEqual({ SAFE_ENV: 'kept' });
  });

  it('does not let custom env supply grant socket or grant scopes without platform permission', () => {
    const launchEnv = buildLaunchEnv(makeAgent({
      env: {
        SAFE_ENV: 'kept',
        [AGENT_CREDENTIAL_REQUEST_SOCKET_ENV]: '/tmp/agent-request.sock',
        [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: '/run/shizuha/agent-credentials/grant.sock',
        [AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV]: 'github,npm',
      },
    }));

    expect(launchEnv).toMatchObject({
      SAFE_ENV: 'kept',
      [AGENT_CREDENTIAL_REQUEST_SOCKET_ENV]: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
    });
    expect(launchEnv).not.toHaveProperty(AGENT_CREDENTIAL_GRANT_SOCKET_ENV);
    expect(launchEnv).not.toHaveProperty(AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV);
  });

  it('injects grant socket env only from valid platform grant permission', () => {
    const launchEnv = buildLaunchEnv(makeAgent({
      credentialGrantScopes: ['github'],
      env: {
        [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: '/tmp/agent-controlled-grant.sock',
        [AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV]: 'npm',
      },
    }));

    expect(launchEnv).toMatchObject({
      [AGENT_CREDENTIAL_REQUEST_SOCKET_ENV]: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
      [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
      [AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV]: 'github',
    });
  });

  it('filters extra volumes that could expose broker sockets', () => {
    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
      { host: '/run/shizuha/agent-credentials/grant.sock', container: '/tmp/grant.sock', mode: 'ro' },
      { host: '/run', container: '/tmp/run', mode: 'ro' },
      { host: '/', container: '/tmp/root', mode: 'ro' },
      { host: '/srv/other', container: AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER, mode: 'ro' },
      { host: '/srv/other', container: AGENT_CREDENTIAL_SOCKET_DIR, mode: 'ro' },
      { host: '/run/shizuha/agent-credentials/../agent-credentials/grant.sock', container: '/tmp/traversal.sock', mode: 'ro' },
      { host: '/tmp/custom-grant.sock', container: '/tmp/custom-grant.sock', mode: 'ro' },
    ], { reservedHostPaths: ['/tmp/custom-grant.sock'] });

    expect(volumes).toEqual([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
  });

  it('filters extra volumes that could expose Docker daemon sockets', () => {
    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
      { host: '/var/run/docker.sock', container: '/tmp/docker.sock', mode: 'ro' },
      { host: '/run/docker.sock', container: '/tmp/run-docker.sock', mode: 'ro' },
      { host: '/var/run/../run/docker.sock', container: '/tmp/traversal-docker.sock', mode: 'ro' },
      { host: '/srv/other.sock', container: '/var/run/docker.sock', mode: 'ro' },
      { host: '/srv/other.sock', container: '/run/docker.sock', mode: 'ro' },
    ]);

    expect(volumes).toEqual([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
  });

  it('filters extra volumes whose existing host paths resolve to broker sockets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-broker-paths-'));
    tempDirs.push(dir);
    const brokerDir = path.join(dir, 'broker');
    fs.mkdirSync(brokerDir);
    const grantSocketPath = path.join(brokerDir, 'grant.sock');
    fs.writeFileSync(grantSocketPath, '');
    const symlinkPath = path.join(dir, 'grant-link.sock');
    fs.symlinkSync(grantSocketPath, symlinkPath);

    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: path.join(brokerDir, '..', 'broker', 'grant.sock'), container: '/tmp/traversal.sock', mode: 'ro' },
      { host: symlinkPath, container: '/tmp/link.sock', mode: 'ro' },
      { host: path.join(dir, 'safe.sock'), container: '/tmp/safe.sock', mode: 'ro' },
    ], { reservedHostPaths: [grantSocketPath] });

    expect(volumes).toEqual([
      { host: path.join(dir, 'safe.sock'), container: '/tmp/safe.sock', mode: 'ro' },
    ]);
  });

  it('filters extra docker args that could expose broker sockets or reserved env', () => {
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '--security-opt', 'seccomp=unconfined',
      '-e', `${AGENT_CREDENTIAL_GRANT_SOCKET_ENV}=${AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER}`,
      '--env', `${AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV}=github`,
      `--env=${AGENT_CREDENTIAL_REQUEST_SOCKET_ENV}=${AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER}`,
      `-e=${AGENT_CREDENTIAL_GRANT_SOCKET_ENV}=${AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER}`,
      '-eSAFE_ENV=kept',
      '-e=SAFE_EQUALS_ENV=kept',
      '--env-file', '/workspace/agent.env',
      '--volumes-from', 'shizuha-agent-scoped',
      '--volumes-from=shizuha-agent-scoped',
      '-v', `/run/shizuha:${AGENT_CREDENTIAL_SOCKET_DIR}:ro`,
      `-v=${AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER}:/tmp/grant.sock:ro`,
      `--volume=/srv/data:/workspace/data:ro`,
      '-v=/srv/safe-short:/workspace/safe-short:ro',
      '--mount', 'type=bind,source=/tmp/custom-grant.sock,target=/workspace/custom.sock,readonly',
      '--mount=type=bind,source=/srv/safe,target=/workspace/safe,readonly',
    ], { reservedHostPaths: ['/tmp/custom-grant.sock'] });

    expect(args).toEqual([
      '--security-opt', 'seccomp=unconfined',
      '-eSAFE_ENV=kept',
      '-e=SAFE_EQUALS_ENV=kept',
      '--volume=/srv/data:/workspace/data:ro',
      '-v=/srv/safe-short:/workspace/safe-short:ro',
      '--mount=type=bind,source=/srv/safe,target=/workspace/safe,readonly',
    ]);
  });

  it('filters extra docker args that could expose Docker daemon sockets', () => {
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '--security-opt', 'seccomp=unconfined',
      '-v', '/var/run/docker.sock:/tmp/docker.sock:ro',
      '--volume', '/run/docker.sock:/tmp/run-docker.sock:ro',
      '-v=/var/run/../run/docker.sock:/tmp/traversal-docker.sock:ro',
      '--volume=/srv/other.sock:/var/run/docker.sock:ro',
      '--mount', 'type=bind,source=/var/run/docker.sock,target=/tmp/docker.sock,readonly',
      '--mount=type=bind,source=/run/docker.sock,target=/tmp/run-docker.sock,readonly',
      '--mount=type=bind,source=/srv/other.sock,target=/run/docker.sock,readonly',
      '--mount=type=bind,SOURCE=/var/run/docker.sock,TARGET=/tmp/upper-docker.sock,readonly',
      '--mount=type=bind,source=/srv/safe,source=/run/shizuha/agent-credentials/grant.sock,target=/tmp/grant.sock,readonly',
      '--mount=type=bind,source=/srv/safe,target=/workspace/safe,TARGET=/run/docker.sock,readonly',
      '--volume=/srv/data:/workspace/data:ro',
    ]);

    expect(args).toEqual([
      '--security-opt', 'seccomp=unconfined',
      '--volume=/srv/data:/workspace/data:ro',
    ]);
  });

  it('filters host and container PID namespace options from extra docker args', () => {
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '--security-opt', 'seccomp=unconfined',
      '--pid=host',
      '--pid', 'host',
      '--pid=container:agent-with-grant-socket',
      '--pid', 'container:agent-with-grant-socket',
      '--PID=host',
      '--memory', '512m',
    ]);

    expect(args).toEqual([
      '--security-opt', 'seccomp=unconfined',
      '--memory', '512m',
    ]);
  });

  it('filters procfs mounts from extra volumes and docker args', () => {
    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/proc', container: '/host/proc', mode: 'ro' },
      { host: '/proc/1/root/run/shizuha/agent-credentials', container: '/workspace/proc-root', mode: 'ro' },
      { host: '/srv/data', container: '/proc/agent-view', mode: 'ro' },
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '-v', '/proc:/host/proc:ro',
      '--volume', '/proc/1/root/run/shizuha/agent-credentials:/workspace/proc-root:ro',
      '-v=/proc/../proc/1/root/var/run/docker.sock:/workspace/docker-root:ro',
      '--volume=/srv/data:/proc/agent-view:ro',
      '--mount', 'type=bind,source=/proc,target=/host/proc,readonly',
      '--mount=type=bind,source=/proc/1/root/run/shizuha/agent-credentials,target=/workspace/proc-root,readonly',
      '--mount=type=bind,source=/srv/data,target=/proc/agent-view,readonly',
      '--mount=type=volume,source=proc,target=/workspace/proc,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/proc',
      '--mount=type=volume,source=proc-root,target=/workspace/proc-root,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/proc/1/root/run/shizuha/agent-credentials',
      '--volume=/srv/data:/workspace/data:ro',
    ]);

    expect(volumes).toEqual([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    expect(args).toEqual([
      '--volume=/srv/data:/workspace/data:ro',
    ]);
  });

  it('filters named docker volumes and relative bind sources', () => {
    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '../../run/shizuha/agent-credentials', container: '/tmp/broker', mode: 'ro' },
      { host: '../var/run/docker.sock', container: '/tmp/docker.sock', mode: 'ro' },
      { host: 'named-volume', container: '/tmp/named', mode: 'ro' },
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '-v', 'broker:/tmp/broker:ro',
      '--volume', '../../run/shizuha/agent-credentials:/tmp/broker:ro',
      '-v=../../var/run/docker.sock:/tmp/docker.sock:ro',
      '--mount=type=bind,source=../../run/shizuha/agent-credentials,target=/tmp/broker,readonly',
      '--mount=type=bind,source=/srv/data,target=/workspace/safe,volume-opt=device=../../var/run/docker.sock',
      '--mount=type=volume,source=safe,target=/workspace/safe',
      '--mount=type=bind,source=/srv/data,target=/workspace/safe,readonly',
      '--volume=/srv/data:/workspace/data:ro',
    ]);

    expect(volumes).toEqual([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    expect(args).toEqual([
      '--mount=type=bind,source=/srv/data,target=/workspace/safe,readonly',
      '--volume=/srv/data:/workspace/data:ro',
    ]);
  });

  it('reserves the dynamic per-agent broker socket directory', () => {
    process.env.SHIZUHA_CREDENTIAL_BROKER_DIR = '/run/user/1000/shizuha/broker';

    const reservedPaths = resolveAgentCredentialBrokerReservedHostPaths();
    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/run/user/1000/shizuha/broker/agents/kai/grant.sock', container: '/tmp/kai-grant.sock', mode: 'ro' },
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ], { reservedHostPaths: reservedPaths });
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '-v', '/run/user/1000/shizuha/broker/agents/kai/grant.sock:/tmp/kai-grant.sock:ro',
      '--volume=/srv/data:/workspace/data:ro',
    ], { reservedHostPaths: reservedPaths });

    expect(reservedPaths).toContain('/run/user/1000/shizuha/broker/agents');
    expect(volumes).toEqual([{ host: '/srv/data', container: '/workspace/data', mode: 'ro' }]);
    expect(args).toEqual(['--volume=/srv/data:/workspace/data:ro']);
  });

  it('reserves active non-default Docker Unix socket from DOCKER_HOST', () => {
    process.env.DOCKER_HOST = 'unix:///run/user/1000/docker.sock';

    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/run/user/1000/docker.sock', container: '/tmp/rootless-docker.sock', mode: 'ro' },
      { host: '/run/user/1000/../1000/docker.sock', container: '/tmp/rootless-traversal.sock', mode: 'ro' },
      { host: '/srv/other.sock', container: '/run/user/1000/docker.sock', mode: 'ro' },
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '-v', '/run/user/1000/docker.sock:/tmp/rootless-docker.sock:ro',
      '--volume=/run/user/1000/../1000/docker.sock:/tmp/rootless-traversal.sock:ro',
      '--mount=type=bind,source=/run/user/1000/docker.sock,target=/tmp/rootless-docker.sock,readonly',
      '--mount=type=bind,source=/srv/other.sock,target=/run/user/1000/docker.sock,readonly',
      '--volume=/srv/data:/workspace/data:ro',
    ]);

    expect(resolveAgentCredentialBrokerReservedHostPaths()).toContain('/run/user/1000/docker.sock');
    expect(volumes).toEqual([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    expect(args).toEqual([
      '--volume=/srv/data:/workspace/data:ro',
    ]);
  });

  it('reserves active non-default Docker Unix socket from current Docker context', () => {
    delete process.env.DOCKER_HOST;
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-bin-'));
    tempDirs.push(binDir);
    const dockerPath = path.join(binDir, 'docker');
    fs.writeFileSync(
      dockerPath,
      `#!/bin/sh\nprintf '%s\\n' '[{\"Endpoints\":{\"docker\":{\"Host\":\"unix:///run/user/1000/docker.sock\"}}}]'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;

    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/run/user/1000/docker.sock', container: '/tmp/context-docker.sock', mode: 'ro' },
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '--mount=type=bind,source=/run/user/1000/docker.sock,target=/tmp/context-docker.sock,readonly',
      '--volume=/srv/data:/workspace/data:ro',
    ]);

    expect(resolveAgentCredentialBrokerReservedHostPaths()).toContain('/run/user/1000/docker.sock');
    expect(volumes).toEqual([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    expect(args).toEqual([
      '--volume=/srv/data:/workspace/data:ro',
    ]);
  });

  it('reserves Docker context socket when DOCKER_CONTEXT overrides DOCKER_HOST', () => {
    process.env.DOCKER_HOST = 'unix:///run/user/1000/docker-host.sock';
    process.env.DOCKER_CONTEXT = 'rootless-context';
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-bin-'));
    tempDirs.push(binDir);
    const dockerPath = path.join(binDir, 'docker');
    fs.writeFileSync(
      dockerPath,
      `#!/bin/sh\nprintf '%s\\n' '[{\"Endpoints\":{\"docker\":{\"Host\":\"unix:///run/user/1001/docker-context.sock\"}}}]'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;

    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/run/user/1000/docker-host.sock', container: '/tmp/docker-host.sock', mode: 'ro' },
      { host: '/run/user/1001/docker-context.sock', container: '/tmp/docker-context.sock', mode: 'ro' },
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '--mount=type=bind,source=/run/user/1001/docker-context.sock,target=/tmp/docker-context.sock,readonly',
      '--volume=/srv/data:/workspace/data:ro',
    ]);

    const reservedPaths = resolveAgentCredentialBrokerReservedHostPaths();
    expect(reservedPaths).toContain('/run/user/1000/docker-host.sock');
    expect(reservedPaths).toContain('/run/user/1001/docker-context.sock');
    expect(volumes).toEqual([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    expect(args).toEqual([
      '--volume=/srv/data:/workspace/data:ro',
    ]);
  });

  it('reserves Docker context socket from resolved docker binary when docker is absent from PATH', () => {
    process.env.DOCKER_CONTEXT = 'rootless-context';
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-path-'));
    tempDirs.push(process.env.PATH);
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolved-docker-bin-'));
    tempDirs.push(binDir);
    const dockerPath = path.join(binDir, 'docker');
    fs.writeFileSync(
      dockerPath,
      `#!/bin/sh\nprintf '%s\\n' '[{\"Endpoints\":{\"docker\":{\"Host\":\"unix:///run/user/1002/resolved-context.sock\"}}}]'\n`,
      { mode: 0o755 },
    );

    const reservedPaths = resolveAgentCredentialBrokerReservedHostPaths({ dockerPath });
    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/run/user/1002/resolved-context.sock', container: '/tmp/resolved-context.sock', mode: 'ro' },
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ], { reservedHostPaths: reservedPaths });
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '--mount=type=bind,source=/run/user/1002/resolved-context.sock,target=/tmp/resolved-context.sock,readonly',
      '--volume=/srv/data:/workspace/data:ro',
    ], { reservedHostPaths: reservedPaths });

    expect(reservedPaths).toContain('/run/user/1002/resolved-context.sock');
    expect(volumes).toEqual([
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ]);
    expect(args).toEqual([
      '--volume=/srv/data:/workspace/data:ro',
    ]);
  });

  it('filters local volume bind mounts whose device exposes broker or Docker sockets', () => {
    process.env.DOCKER_HOST = 'unix:///run/user/1000/docker.sock';

    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '--mount=type=volume,source=broker,target=/tmp/broker,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/run/shizuha/agent-credentials',
      '--mount=type=volume,source=docker,target=/tmp/docker,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/var/run',
      '--mount=type=volume,source=rootless-docker,target=/tmp/rootless,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/run/user/1000',
      '--mount=type=volume,source=safe,target=/workspace/safe,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/srv/data',
      '--mount=type=bind,source=/srv/data,target=/workspace/safe,readonly',
    ]);

    expect(args).toEqual([
      '--mount=type=bind,source=/srv/data,target=/workspace/safe,readonly',
    ]);
  });

  it('filters quoted docker mount specs that can hide reserved local-volume devices', () => {
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '--mount=type=volume,source=broker,target=/tmp/broker,volume-driver=local,"volume-opt=device=/run/shizuha/agent-credentials"',
      '--mount=type=volume,source=docker,target=/tmp/docker,volume-driver=local,"volume-opt=device=/var/run/docker.sock"',
      '--mount=type=volume,source=proc,target=/tmp/proc,volume-driver=local,"volume-opt=device=/proc"',
      '--mount=type=volume,source=escaped,target=/tmp/escaped,volume-driver=local,volume-opt=device=/srv/data\\,with-comma',
      '--mount=type=volume,source=safe,target=/workspace/safe,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/srv/data',
      '--mount=type=bind,source=/srv/data,target=/workspace/safe,readonly',
    ]);

    expect(args).toEqual([
      '--mount=type=bind,source=/srv/data,target=/workspace/safe,readonly',
    ]);
  });

  it('filters bundled docker short options that can hide env or volume payloads', () => {
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '-it',
      '-iv/var/run/docker.sock:/tmp/docker.sock:ro',
      `-ie${AGENT_CREDENTIAL_GRANT_SOCKET_ENV}=${AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER}`,
      '-v/srv/data:/workspace/data:ro',
      '-eSAFE_ENV=kept',
      '--memory', '512m',
    ]);

    expect(args).toEqual([
      '-it',
      '-v/srv/data:/workspace/data:ro',
      '-eSAFE_ENV=kept',
      '--memory', '512m',
    ]);
  });

  it('keeps broker-plan env and mounts when valid platform permission exists even if extras are filtered', () => {
    const agent = makeAgent({
      credentialGrantScopes: ['github'],
      env: {
        [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: '/tmp/agent-controlled-grant.sock',
      },
    });
    const plan = planAgentCredentialBrokerSockets(agent, {
      requestSocketHostPath: '/host/request.sock',
      grantSocketHostPath: '/host/grant.sock',
      socketExists: () => true,
    });
    const launchEnv = { ...scrubAgentCredentialBrokerReservedEnv(agent.env ?? {}), ...plan.env };
    const extraArgs = filterAgentCredentialBrokerExtraDockerArgs([
      '-e', `${AGENT_CREDENTIAL_GRANT_SOCKET_ENV}=/tmp/agent-controlled-grant.sock`,
      '-v', `/host/grant.sock:${AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER}:ro`,
    ], { reservedHostPaths: plan.mounts.map((mount) => mount.hostPath) });

    expect(launchEnv).toMatchObject({
      [AGENT_CREDENTIAL_GRANT_SOCKET_ENV]: AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
      [AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV]: 'github',
    });
    expect(plan.mounts.map((mount) => mount.containerPath)).toContain(AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER);
    expect(extraArgs).toEqual([]);
  });

  it('reserves configured grant host path even when current agent has no grant permission', () => {
    const reservedHostPaths = resolveAgentCredentialBrokerReservedHostPaths({
      requestSocketHostPath: '/custom/request.sock',
      grantSocketHostPath: '/custom/grant.sock',
    });
    const plan = planAgentCredentialBrokerSockets(makeAgent(), {
      requestSocketHostPath: '/custom/request.sock',
      grantSocketHostPath: '/custom/grant.sock',
      socketExists: () => true,
    });
    const volumes = filterAgentCredentialBrokerExtraVolumes([
      { host: '/custom/grant.sock', container: '/tmp/grant.sock', mode: 'ro' },
      { host: '/srv/data', container: '/workspace/data', mode: 'ro' },
    ], { reservedHostPaths });
    const args = filterAgentCredentialBrokerExtraDockerArgs([
      '-v', `/custom/grant.sock:${AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER}:ro`,
      '--volume=/srv/data:/workspace/data:ro',
    ], { reservedHostPaths });

    expect(plan.env).not.toHaveProperty(AGENT_CREDENTIAL_GRANT_SOCKET_ENV);
    expect(plan.mounts.map((mount) => mount.hostPath)).not.toContain('/custom/grant.sock');
    expect(volumes).toEqual([{ host: '/srv/data', container: '/workspace/data', mode: 'ro' }]);
    expect(args).toEqual(['--volume=/srv/data:/workspace/data:ro']);
  });
});
