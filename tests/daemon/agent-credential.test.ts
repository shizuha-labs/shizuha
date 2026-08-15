import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCredential, AgentInfo } from '../../src/daemon/types.js';
import {
  AGENT_CREDENTIAL_SCOPE_CHECK_SQL,
  assertAgentCredentialPermissionSeedInvariants,
  assertAgentCredentialScope,
  createHostPlaneFleetSshCredentialGrant,
  hostPlaneFleetSshSourceDir,
  isAgentCredentialGrantCurrentlyActive,
  isHostPlaneAgent,
  materializeMissingFleetSshCredentialGrantFromLegacySshKeys,
  migrateAgentCredentialGrants,
  normalizeAgentCredential,
  reconcileFleetSshCredentialGrantFromLegacySshKeys,
  resolveFleetSshCredentialGrant,
  resolveAgentCredentialInjectedEnvNames,
  scrubAgentRuntimeEnvForCredentialInjection,
  shouldPersistAgentCredentialMigration,
} from '../../src/daemon/agent-credential.js';
import {
  __prefetchAllIdentitiesForTest,
  __setDiscoveredAgentsForTest,
  applyFirstRunCredentialPermissionSeed,
  buildTrustedCredentialSeedIdentitiesFromPlatformRoster,
  credentialSeedVerificationPlatformUrl,
  fetchAuthenticatedHiveAgentIdentityRoster,
  fetchAuthenticatedPlatformUsers,
  fetchInternalAgentIdentityUsers,
  getCachedAgentIdentity,
  injectAgentCredentialEnvValue,
  mergeMigratedAgentsIntoStoredRoster,
  resolveAgentPassword,
  __resetAgentPasswordCacheForTest,
} from '../../src/daemon/manager.js';

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Kai',
    username: 'kai',
    email: 'kai@shizuha.com',
    role: 'Engineer',
    status: 'active',
    mcpServers: [],
    personalityTraits: {},
    skills: [],
    ...overrides,
  };
}


describe('SCLI-236 credential env precedence', () => {
  it('scrubs runtime env keys that are injected by active AgentCredential grants', () => {
    const agent = makeAgent({
      env: { GITHUB_TOKEN: '****', SAFE_RUNTIME_FLAG: '1' },
      credentials: [{
        id: 'github-grant',
        scope: 'github',
        label: 'GitHub PAT',
        credentialData: { token: 'ghp_from_grant' },
        envMapping: { token: 'GITHUB_TOKEN' },
        injectAsEnv: true,
        isActive: true,
      }],
    });

    expect([...resolveAgentCredentialInjectedEnvNames(agent)]).toContain('GITHUB_TOKEN');
    expect(scrubAgentRuntimeEnvForCredentialInjection(agent, agent.env!)).toEqual({ SAFE_RUNTIME_FLAG: '1' });
  });

  it('leaves non-credential runtime env keys intact and ignores inactive grants', () => {
    const agent = makeAgent({
      env: { GITHUB_TOKEN: 'runtime-token', SAFE_RUNTIME_FLAG: '1' },
      credentials: [{
        id: 'inactive-github-grant',
        scope: 'github',
        label: 'GitHub PAT',
        credentialData: { token: 'ghp_revoked' },
        envMapping: { token: 'GITHUB_TOKEN' },
        injectAsEnv: true,
        isActive: false,
      }],
    });

    expect(scrubAgentRuntimeEnvForCredentialInjection(agent, agent.env!)).toEqual({
      GITHUB_TOKEN: 'runtime-token',
      SAFE_RUNTIME_FLAG: '1',
    });
  });

  it('wires the daemon env assembly through credential-aware runtime scrubbing', () => {
    const managerSource = fs.readFileSync(path.resolve('src/daemon/manager.ts'), 'utf-8');
    expect(managerSource).toContain(
      'const runtimeEnv = scrubAgentRuntimeEnvForCredentialInjection(agent, resolveAgentRuntimeEnv(agent, runtime));',
    );
    expect(managerSource).toContain("githubToken: launchCredentialEnv['GITHUB_TOKEN'] ?? runtimeEnv['GITHUB_TOKEN']");
    expect(managerSource).toContain(`AGENT_PASSWORD: resolveAgentPassword(agent),
      ...runtimeEnv,
      ...launchCredentialEnv,`);
  });
});

describe('PLAT-194 host-plane fleet-ssh grant by role', () => {
  it('keys host-plane off the devops skill', () => {
    expect(isHostPlaneAgent(makeAgent({ skills: ['coding', 'devops'] }))).toBe(true);
    expect(isHostPlaneAgent(makeAgent({ skills: ['coding'] }))).toBe(false);
  });

  it('materializes a store-sourced fleet-ssh grant for a host-plane agent without sshKeys.enabled', () => {
    const agent = makeAgent({ skills: ['coding', 'devops'] }); // no sshKeys at all (post-roll)
    const creds = materializeMissingFleetSshCredentialGrantFromLegacySshKeys(agent);
    const fleet = (creds ?? []).find((c) => c.scope === 'fleet-ssh');
    expect(fleet).toBeDefined();
    expect(fleet?.credentialData.sshDir).toBe(`~/.shizuha/ssh-keys/${agent.username}`);
    const read = resolveFleetSshCredentialGrant({ ...agent, credentials: creds });
    expect(read.grant?.sshDir).toBe(`~/.shizuha/ssh-keys/${agent.username}`);
  });

  it('does NOT materialize a grant for a non-host-plane agent without sshKeys', () => {
    const agent = makeAgent({ skills: ['coding'] });
    const creds = materializeMissingFleetSshCredentialGrantFromLegacySshKeys(agent);
    expect((creds ?? []).some((c) => c.scope === 'fleet-ssh')).toBe(false);
  });

  it('re-points a stale ~/.ssh-sourced host-plane grant to the mounted per-agent store', () => {
    const base = makeAgent({ skills: ['devops'] });
    const stale = createHostPlaneFleetSshCredentialGrant(base);
    stale.credentialData.sshDir = '~/.ssh'; // pre-roll grant pointing at the invisible-in-pod source
    const creds = materializeMissingFleetSshCredentialGrantFromLegacySshKeys({ ...base, credentials: [stale] });
    const fleet = (creds ?? []).filter((c) => c.scope === 'fleet-ssh');
    expect(fleet).toHaveLength(1);
    expect(fleet[0]?.credentialData.sshDir).toBe(hostPlaneFleetSshSourceDir(base));
  });

  it('preserves remoteUser/keyFiles when re-pointing (changes only sshDir)', () => {
    const base = makeAgent({ skills: ['devops'] });
    const stale = createHostPlaneFleetSshCredentialGrant(base);
    stale.credentialData.sshDir = '~/.ssh';
    stale.credentialData.remoteUser = 'phoenix';
    stale.credentialData.keyFiles = JSON.stringify(['id_ed25519_custom']);
    const creds = materializeMissingFleetSshCredentialGrantFromLegacySshKeys({ ...base, credentials: [stale] });
    const fleet = (creds ?? []).find((c) => c.scope === 'fleet-ssh');
    expect(fleet?.credentialData.sshDir).toBe(hostPlaneFleetSshSourceDir(base));
    expect(fleet?.credentialData.remoteUser).toBe('phoenix');
    expect(fleet?.credentialData.keyFiles).toBe(JSON.stringify(['id_ed25519_custom']));
  });

  it('does NOT revive an inactive/revoked host-plane fleet-ssh grant', () => {
    const base = makeAgent({ skills: ['devops'] });
    const revoked = createHostPlaneFleetSshCredentialGrant(base);
    revoked.credentialData.sshDir = '~/.ssh';
    revoked.isActive = false; // operator revoked it
    const creds = materializeMissingFleetSshCredentialGrantFromLegacySshKeys({ ...base, credentials: [revoked] });
    const active = (creds ?? []).filter((c) => c.scope === 'fleet-ssh' && c.isActive);
    expect(active).toHaveLength(0); // revocation respected — not resurrected
  });

  it('prioritizes the store-sourced host-plane grant over the legacy ~/.ssh bridge', () => {
    const agent = makeAgent({
      skills: ['devops'],
      sshKeys: { enabled: true, sshDir: '/home/agent/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'agent' },
    });
    const creds = materializeMissingFleetSshCredentialGrantFromLegacySshKeys(agent);
    const fleet = (creds ?? []).find((c) => c.scope === 'fleet-ssh');
    expect(fleet?.credentialData.sshDir).toBe(hostPlaneFleetSshSourceDir(agent)); // store, not /home/agent/.ssh
  });
});

describe('AgentCredential schema migration', () => {
  const trustedPlatformUserIds = new Map([
    ['11111111-1111-4111-8111-111111111111', { username: 'kai', email: 'kai@shizuha.com', platformUserId: 13 }],
    ['ryo-id', { username: 'ryo', email: 'ryo@shizuha.com', platformUserId: 14 }],
    ['ichi-id', { username: 'ichi', email: 'ichi@shizuha.com', platformUserId: 88 }],
    ['ni-id', { username: 'ni', email: 'ni@shizuha.com', platformUserId: 89 }],
    ['akira-id', { username: 'akira', email: 'akira@shizuha.com', platformUserId: 17 }],
    ['ren-id', { username: 'ren', email: 'ren@shizuha.com', platformUserId: 18 }],
  ]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes legacy service credentials into scoped grants', () => {
    const agent = makeAgent({
      credentials: [{
        id: 'legacy-github',
        service: 'github',
        label: 'GitHub PAT',
        credentialData: { token: 'ghp_example' },
        injectAsEnv: true,
        isActive: true,
      }],
    });

    const normalized = normalizeAgentCredential(agent.credentials![0]!, agent);

    expect(normalized.scope).toBe('github');
    expect(normalized.service).toBe('github');
    expect(normalized.grantId).toBe('legacy-github');
    expect(normalized.grantorId).toBe('kai@shizuha.com');
    expect(normalized.expiresAt).toBeNull();
  });

  it('inserts one fleet-ssh grant for currently enabled agents with sshKeys enabled', () => {
    const agents = [
      makeAgent({
        id: 'enabled-agent',
        sshKeys: { enabled: true, sshDir: '/home/agent/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'agent' },
      }),
      makeAgent({ id: 'disabled-agent', username: 'ryo', email: 'ryo@shizuha.com', sshKeys: { enabled: true } }),
    ];

    const result = migrateAgentCredentialGrants(agents, new Set(['enabled-agent']));

    expect(result.insertedFleetSshGrants).toBe(1);
    expect(result.refusedCredentials).toBe(0);
    expect(result.agents[0]!.credentials).toHaveLength(1);
    expect(result.agents[0]!.credentials![0]).toMatchObject({
      scope: 'fleet-ssh',
      service: 'fleet-ssh',
      grantorId: 'kai@shizuha.com',
      injectAsEnv: false,
      isActive: true,
      expiresAt: null,
    });
    expect(result.agents[0]!.credentials![0]!.credentialData.keyFiles).toBe('["id_ed25519"]');
    expect(result.agents[1]!.credentials).toBeUndefined();
  });

  it('marks Kai/Ichi/Ni phoenix fleet SSH grants as record-only dogfood migrations', () => {
    const agents = [
      makeAgent({
        id: 'kai-agent',
        username: 'kai',
        email: 'kai@shizuha.com',
        sshKeys: { enabled: true, sshDir: '/home/user/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'phoenix' },
      }),
      makeAgent({
        id: 'ichi-agent',
        username: 'ichi',
        email: 'ichi@shizuha.com',
        sshKeys: { enabled: true, sshDir: '/home/user/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'phoenix' },
      }),
      makeAgent({
        id: 'ryo-agent',
        username: 'ryo',
        email: 'ryo@shizuha.com',
        sshKeys: { enabled: true, sshDir: '/home/user/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'phoenix' },
      }),
    ];

    const result = migrateAgentCredentialGrants(
      agents,
      new Set(['kai-agent', 'ichi-agent', 'ryo-agent']),
      { migratedAt: '2026-06-05T00:00:00.000Z' },
    );

    expect(result.insertedFleetSshGrants).toBe(3);
    expect(result.dogfoodPhoenixFleetSshGrants).toBe(2);
    expect(result.agents[0]!.credentials![0]!.credentialData).toMatchObject({
      sshDir: '/home/user/.ssh',
      keyFiles: '["id_ed25519"]',
      remoteUser: 'phoenix',
      auditMigrationTask: 'PLAT-111',
      auditMigrationKind: 'record-only-dogfood',
      auditMigrationSubject: 'phoenix-mounted-fleet-ssh',
      auditMigrationAgent: 'kai',
      auditMigratedAt: '2026-06-05T00:00:00.000Z',
    });
    expect(result.agents[1]!.credentials![0]!.credentialData.auditMigrationAgent).toBe('ichi');
    expect(result.agents[2]!.credentials![0]!.credentialData.auditMigrationTask).toBeUndefined();
    expect(Object.keys(result.agents[0]!.credentials![0]!.credentialData)).not.toContain('privateKey');
  });

  it('does not dogfood-mark Kai/Ichi/Ni fleet SSH grants that are not phoenix-mounted', () => {
    const result = migrateAgentCredentialGrants(
      [makeAgent({
        id: 'kai-agent',
        username: 'kai',
        email: 'kai@shizuha.com',
        sshKeys: { enabled: true, sshDir: '/home/kai/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'kai' },
      })],
      new Set(['kai-agent']),
      { migratedAt: '2026-06-05T00:00:00.000Z' },
    );

    expect(result.insertedFleetSshGrants).toBe(1);
    expect(result.dogfoodPhoenixFleetSshGrants).toBe(0);
    expect(result.agents[0]!.credentials![0]!.credentialData.auditMigrationTask).toBeUndefined();
  });

  it('retro-marks existing Kai/Ichi/Ni fleet SSH grants without duplicating or rotating them', () => {
    const agent = makeAgent({
      id: 'ni-agent',
      username: 'ni',
      email: 'ni@shizuha.com',
      sshKeys: { enabled: true, sshDir: '/home/user/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'phoenix' },
      credentials: [{
        id: 'existing-fleet-grant',
        grantId: 'existing-fleet-grant',
        grantorId: 'ni@shizuha.com',
        scope: 'fleet-ssh',
        service: 'fleet-ssh',
        label: 'Fleet SSH',
        credentialData: {
          sshDir: '/home/user/.ssh',
          keyFiles: JSON.stringify(['id_ed25519']),
          remoteUser: 'phoenix',
        },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      }],
    });

    const result = migrateAgentCredentialGrants(
      [agent],
      new Set(['ni-agent']),
      { migratedAt: '2026-06-05T00:00:00.000Z' },
    );

    expect(result.insertedFleetSshGrants).toBe(0);
    expect(result.dogfoodPhoenixFleetSshGrants).toBe(1);
    expect(result.agents[0]!.credentials).toHaveLength(1);
    expect(result.agents[0]!.credentials![0]).toMatchObject({
      id: 'existing-fleet-grant',
      grantId: 'existing-fleet-grant',
      credentialData: {
        sshDir: '/home/user/.ssh',
        keyFiles: JSON.stringify(['id_ed25519']),
        remoteUser: 'phoenix',
        auditMigrationTask: 'PLAT-111',
        auditMigrationKind: 'record-only-dogfood',
        auditMigrationAgent: 'ni',
      },
    });
    expect(shouldPersistAgentCredentialMigration(result)).toBe(true);
  });

  it('preserves an existing dogfood migration timestamp on subsequent daemon migrations', () => {
    const agent = makeAgent({
      id: 'kai-agent',
      username: 'kai',
      email: 'kai@shizuha.com',
      sshKeys: { enabled: true, sshDir: '/home/user/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'phoenix' },
      credentials: [{
        id: 'existing-fleet-grant',
        grantId: 'existing-fleet-grant',
        grantorId: 'kai@shizuha.com',
        scope: 'fleet-ssh',
        service: 'fleet-ssh',
        label: 'Fleet SSH',
        credentialData: {
          sshDir: '/home/user/.ssh',
          keyFiles: JSON.stringify(['id_ed25519']),
          remoteUser: 'phoenix',
          auditMigrationTask: 'PLAT-111',
          auditMigrationKind: 'record-only-dogfood',
          auditMigrationSubject: 'phoenix-mounted-fleet-ssh',
          auditMigrationAgent: 'kai',
          auditMigratedAt: '2026-06-05T00:00:00.000Z',
          auditMigrationNote: 'Retro-migrated existing phoenix-mounted fleet SSH grant; no key material issued, rotated, logged, or copied.',
        },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      }],
    });

    const result = migrateAgentCredentialGrants(
      [agent],
      new Set(['kai-agent']),
      { migratedAt: '2026-06-06T00:00:00.000Z' },
    );

    expect(result.dogfoodPhoenixFleetSshGrants).toBe(0);
    expect(result.agents[0]!.credentials![0]!.credentialData.auditMigratedAt).toBe('2026-06-05T00:00:00.000Z');
    expect(shouldPersistAgentCredentialMigration(result)).toBe(false);
  });

  it('does not dogfood-mark an existing non-phoenix grant from stale legacy sshKeys data', () => {
    const agent = makeAgent({
      id: 'kai-agent',
      username: 'kai',
      email: 'kai@shizuha.com',
      sshKeys: { enabled: true, sshDir: '/home/user/.ssh', keyFiles: ['id_ed25519'], remoteUser: 'phoenix' },
      credentials: [{
        id: 'existing-non-phoenix-grant',
        grantId: 'existing-non-phoenix-grant',
        grantorId: 'kai@shizuha.com',
        scope: 'fleet-ssh',
        service: 'fleet-ssh',
        label: 'Fleet SSH',
        credentialData: {
          sshDir: '/home/kai/.ssh',
          keyFiles: JSON.stringify(['id_ed25519']),
          remoteUser: 'kai',
        },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      }],
    });

    const result = migrateAgentCredentialGrants(
      [agent],
      new Set(['kai-agent']),
      { migratedAt: '2026-06-05T00:00:00.000Z' },
    );

    expect(result.insertedFleetSshGrants).toBe(0);
    expect(result.dogfoodPhoenixFleetSshGrants).toBe(0);
    expect(result.agents[0]!.credentials).toHaveLength(1);
    expect(result.agents[0]!.credentials![0]!.credentialData).toMatchObject({
      sshDir: '/home/kai/.ssh',
      remoteUser: 'kai',
    });
    expect(result.agents[0]!.credentials![0]!.credentialData.auditMigrationTask).toBeUndefined();
  });

  it('refuses the reserved sentinel and unknown scopes', () => {
    expect(() => assertAgentCredentialScope('reserved')).toThrow(/sentinel/);
    expect(() => assertAgentCredentialScope('not-a-scope')).toThrow(/Unknown AgentCredential scope/);
  });

  it('drops invalid persisted credentials during migration', () => {
    const agents = [makeAgent({
      credentials: [
        {
          id: 'reserved-grant',
          scope: 'reserved',
          service: 'reserved',
          label: 'Reserved sentinel should not persist',
          credentialData: { token: 'unused' },
          injectAsEnv: true,
          isActive: true,
        } as unknown as AgentCredential,
        {
          id: 'bad-grant',
          scope: 'not-a-scope',
          service: 'not-a-scope',
          label: 'Unknown scope should not persist',
          credentialData: { token: 'unused' },
          injectAsEnv: true,
          isActive: true,
        } as unknown as AgentCredential,
        {
          id: 'valid-github',
          scope: 'github',
          label: 'Valid credential remains',
          credentialData: { token: 'ghp_example' },
          injectAsEnv: true,
          isActive: true,
        },
      ],
    })];

    const result = migrateAgentCredentialGrants(agents, new Set());

    expect(result.refusedCredentials).toBe(2);
    expect(result.agents[0]!.credentials).toHaveLength(1);
    expect(result.agents[0]!.credentials![0]!.scope).toBe('github');
    expect(result.agents[0]!.credentials!.some((credential) => credential.scope === 'reserved')).toBe(false);
    expect(result.agents[0]!.credentials!.some((credential) => (credential as unknown as { scope?: string }).scope === 'not-a-scope')).toBe(false);
  });

  it('persists migration results when credentials are only refused', () => {
    const result = migrateAgentCredentialGrants([makeAgent({
      credentials: [{
        id: 'reserved-only',
        scope: 'reserved',
        service: 'reserved',
        label: 'Reserved only',
        credentialData: { token: 'unused' },
        injectAsEnv: true,
        isActive: true,
      } as unknown as AgentCredential],
    })], new Set());

    expect(result.insertedFleetSshGrants).toBe(0);
    expect(result.normalizedCredentials).toBe(0);
    expect(result.refusedCredentials).toBe(1);
    expect(result.agents[0]!.credentials).toHaveLength(0);
    expect(shouldPersistAgentCredentialMigration(result)).toBe(true);
  });

  it('resolves Shizuha ID passwords from scope-only grants', () => {
    const agent = makeAgent({
      env: { AGENT_PASSWORD: 'env-fallback' },
      credentials: [{
        id: 'shizuha-id-password',
        grantId: 'shizuha-id-password',
        grantorId: 'kai@shizuha.com',
        scope: 'shizuha-id',
        label: 'Shizuha ID password',
        credentialData: { password: 'scoped-password' },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      }],
    });

    expect(resolveAgentPassword(agent)).toBe('scoped-password');
  });

  it('skips a corrupt short env AGENT_PASSWORD and falls through to the canonical password store', () => {
    const oldHome = process.env['HOME'];
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli213-agent-pw-'));
    try {
      process.env['HOME'] = tempHome;
      fs.mkdirSync(path.join(tempHome, '.shizuha'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.shizuha', 'agent-passwords.json'),
        JSON.stringify({ kai: 'canonical-password' }),
      );
      __resetAgentPasswordCacheForTest();

      const agent = makeAgent({ env: { AGENT_PASSWORD: 'bad' } });

      expect(resolveAgentPassword(agent)).toBe('canonical-password');
    } finally {
      if (oldHome === undefined) delete process.env['HOME']; else process.env['HOME'] = oldHome;
      __resetAgentPasswordCacheForTest();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });


  it('does not let a short shizuha-id env mapping overwrite the resolved canonical AGENT_PASSWORD', () => {
    const oldHome = process.env['HOME'];
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli213-scoped-pw-'));
    try {
      process.env['HOME'] = tempHome;
      fs.mkdirSync(path.join(tempHome, '.shizuha'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.shizuha', 'agent-passwords.json'),
        JSON.stringify({ kai: 'canonical-password' }),
      );
      __resetAgentPasswordCacheForTest();

      const agent = makeAgent({
        credentials: [{
          id: 'short-shizuha-id-password',
          grantId: 'short-shizuha-id-password',
          grantorId: 'kai@shizuha.com',
          scope: 'shizuha-id',
          label: 'Short Shizuha ID password',
          credentialData: { password: 'bad' },
          envMapping: { password: 'AGENT_PASSWORD' },
          injectAsEnv: true,
          isActive: true,
          expiresAt: null,
        }],
      });
      const credentialEnv: Record<string, string> = { AGENT_PASSWORD: resolveAgentPassword(agent) };

      injectAgentCredentialEnvValue(
        agent,
        credentialEnv,
        'AGENT_PASSWORD',
        agent.credentials![0]!.credentialData.password,
        'test shizuha-id credential password -> AGENT_PASSWORD',
      );

      expect(credentialEnv['AGENT_PASSWORD']).toBe('canonical-password');
    } finally {
      if (oldHome === undefined) delete process.env['HOME']; else process.env['HOME'] = oldHome;
      __resetAgentPasswordCacheForTest();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('migrates legacy arbitrary service-only credentials into custom grants', () => {
    const agent = makeAgent({
      credentials: [{
        id: 'legacy-x-twitter',
        service: 'x-twitter',
        label: 'X API',
        credentialData: { token: 'x-token' },
        injectAsEnv: true,
        isActive: true,
      } as unknown as AgentCredential],
    });

    const result = migrateAgentCredentialGrants([agent], new Set());

    expect(result.refusedCredentials).toBe(0);
    expect(result.normalizedCredentials).toBe(1);
    expect(result.agents[0]!.credentials).toHaveLength(1);
    expect(result.agents[0]!.credentials![0]).toMatchObject({
      id: 'legacy-x-twitter',
      grantId: 'legacy-x-twitter',
      scope: 'custom',
      service: 'custom',
      label: 'X API (x-twitter)',
      credentialData: { token: 'x-token' },
    });
  });

  it('still refuses reserved and explicit unknown scoped credentials', () => {
    const result = migrateAgentCredentialGrants([makeAgent({
      credentials: [
        {
          id: 'legacy-reserved-service',
          service: 'reserved',
          label: 'Reserved legacy service should not migrate to custom',
          credentialData: { token: 'unused' },
          injectAsEnv: true,
          isActive: true,
        } as unknown as AgentCredential,
        {
          id: 'explicit-unknown-scope',
          scope: 'x-twitter',
          service: 'x-twitter',
          label: 'Explicit unknown scope should fail closed',
          credentialData: { token: 'unused' },
          injectAsEnv: true,
          isActive: true,
        } as unknown as AgentCredential,
      ],
    })], new Set());

    expect(result.refusedCredentials).toBe(2);
    expect(result.agents[0]!.credentials).toHaveLength(0);
    expect(shouldPersistAgentCredentialMigration(result)).toBe(true);
  });

  it('exports a DB check fragment that excludes reserved and unknown scopes', () => {
    expect(AGENT_CREDENTIAL_SCOPE_CHECK_SQL).toContain("scope IN ('fleet-ssh'");
    expect(AGENT_CREDENTIAL_SCOPE_CHECK_SQL).toContain("'kubeconfig'");
    expect(AGENT_CREDENTIAL_SCOPE_CHECK_SQL).toContain("scope <> 'reserved'");
  });

  it('seeds ADR-approved grant scopes for platform agents and metadata-audit only for security agents', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({ id: '11111111-1111-4111-8111-111111111111', username: 'kai', email: 'kai@shizuha.com', credentialGrantScopes: ['github'] }),
      makeAgent({ id: 'ryo-id', username: 'ryo', email: 'ryo@shizuha.com' }),
      makeAgent({ id: 'ichi-id', username: 'ichi', email: 'ichi@shizuha.com' }),
      makeAgent({ id: 'ni-id', username: 'ni', email: 'ni@shizuha.com' }),
      makeAgent({
        id: 'akira-id',
        username: 'akira',
        email: 'akira@shizuha.com',
        credentialGrantScopes: ['fleet-ssh'],
        credentialAuditRoles: ['security-lead'],
      }),
      makeAgent({ id: 'ren-id', username: 'ren', email: 'ren@shizuha.com' }),
      makeAgent({
        username: 'sora',
        email: 'sora@shizuha.com',
        credentialGrantScopes: ['github'],
        credentialAuditRoles: ['metadata-audit'],
      }),
    ], new Set(), { trustedPlatformIdentities: trustedPlatformUserIds });

    const byUsername = new Map(result.agents.map((agent) => [agent.username, agent]));

    for (const username of ['kai', 'ryo', 'ichi', 'ni']) {
      expect(byUsername.get(username)!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
      expect(byUsername.get(username)!.credentialAuditRoles).toBeUndefined();
    }

    for (const username of ['akira', 'ren']) {
      expect(byUsername.get(username)!.credentialGrantScopes).toBeUndefined();
      expect(byUsername.get(username)!.credentialAuditRoles).toEqual(['metadata-audit']);
    }

    expect(byUsername.get('sora')!.credentialGrantScopes).toBeUndefined();
    expect(byUsername.get('sora')!.credentialAuditRoles).toBeUndefined();
    expect(result.seededGrantPermissions).toBe(6);
    expect(result.seededAuditRoles).toBe(3);
    expect(shouldPersistAgentCredentialMigration(result)).toBe(true);
  });

  it('allows explicit break-glass security-lead audit assignments after bootstrap', () => {
    expect(() => assertAgentCredentialPermissionSeedInvariants([
      makeAgent({
        username: 'sora',
        credentialAuditRoles: ['security-lead'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ])).not.toThrow();
  });

  it('does not re-run the bootstrap seed after a safe permission baseline is marked', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: 'ren-id',
        username: 'ren',
        email: 'ren@shizuha.com',
        credentialAuditRoles: ['metadata-audit'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ], new Set(), { trustedPlatformIdentities: trustedPlatformUserIds });

    expect(result.seededPermissionBaselines).toBe(0);
    expect(result.seededAuditRoles).toBe(0);
    expect(result.agents[0]!.credentialAuditRoles).toEqual(['metadata-audit']);
    expect(shouldPersistAgentCredentialMigration(result)).toBe(false);
  });

  it('preserves explicit break-glass security-lead assignments after the permission baseline is marked', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: 'ren-id',
        username: 'ren',
        email: 'ren@shizuha.com',
        credentialAuditRoles: ['metadata-audit', 'security-lead'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ], new Set(), { trustedPlatformIdentities: trustedPlatformUserIds });

    expect(result.agents[0]!.credentialAuditRoles).toEqual(['metadata-audit', 'security-lead']);
    expect(result.seededAuditRoles).toBe(0);
    expect(shouldPersistAgentCredentialMigration(result)).toBe(false);
  });

  it('cleans stale grant scopes on non-platform agents after the permission baseline is marked', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        username: 'sora',
        credentialGrantScopes: ['github'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ], new Set());

    expect(result.agents[0]!.credentialGrantScopes).toBeUndefined();
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBe('adr-plat-001-s10');
    expect(result.seededGrantPermissions).toBe(1);
    expect(shouldPersistAgentCredentialMigration(result)).toBe(true);
  });

  it('preserves explicit break-glass security-lead on first seed for non-bootstrap agents', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        username: 'sora',
        email: 'sora@shizuha.com',
        credentialAuditRoles: ['security-lead'],
      }),
    ], new Set());

    expect(result.agents[0]!.credentialGrantScopes).toBeUndefined();
    expect(result.agents[0]!.credentialAuditRoles).toEqual(['security-lead']);
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBe('adr-plat-001-s10');
    expect(result.seededAuditRoles).toBe(0);
    expect(result.seededPermissionBaselines).toBe(1);
  });

  it('does not seed grant authority for a spoofed platform username without the trusted email tuple', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        username: 'kai',
        email: 'not-kai@example.com',
      }),
    ], new Set());

    expect(result.agents[0]!.credentialGrantScopes).toBeUndefined();
    expect(result.agents[0]!.credentialAuditRoles).toBeUndefined();
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBe('adr-plat-001-s10');
  });

  it('does not seed grant authority for an imported agent spoofing the platform username and email without trusted user id', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: '11111111-1111-4111-8111-111111111111',
        username: 'kai',
        email: 'kai@shizuha.com',
      }),
    ], new Set());

    expect(result.agents[0]!.credentialGrantScopes).toBeUndefined();
    expect(result.agents[0]!.credentialAuditRoles).toBeUndefined();
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBeUndefined();
  });

  it('preserves an exact already-seeded bootstrap baseline during non-authoritative pre-verification migration', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: '11111111-1111-4111-8111-111111111111',
        username: 'kai',
        email: 'kai@shizuha.com',
        credentialGrantScopes: ['fleet-ssh', 'kubeconfig'],
        credentialCustomGrantServices: ['forgejo'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
      makeAgent({
        id: 'ren-id',
        username: 'ren',
        email: 'ren@shizuha.com',
        credentialAuditRoles: ['metadata-audit'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ], new Set());

    expect(result.agents[0]!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBe('adr-plat-001-s10');
    expect(result.agents[1]!.credentialAuditRoles).toEqual(['metadata-audit']);
    expect(result.agents[1]!.credentialPermissionSeedVersion).toBe('adr-plat-001-s10');
    expect(result.seededGrantPermissions).toBe(0);
    expect(result.seededAuditRoles).toBe(0);
    expect(shouldPersistAgentCredentialMigration(result)).toBe(false);
  });

  it('strips unexpected trusted-candidate authority during non-authoritative pre-verification migration', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: '11111111-1111-4111-8111-111111111111',
        username: 'kai',
        email: 'kai@shizuha.com',
        credentialGrantScopes: ['fleet-ssh', 'vault-token'],
        credentialAuditRoles: ['metadata-audit'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ], new Set());

    expect(result.agents[0]!.credentialGrantScopes).toBeUndefined();
    expect(result.agents[0]!.credentialAuditRoles).toBeUndefined();
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBeUndefined();
    expect(result.seededGrantPermissions).toBe(1);
    expect(result.seededAuditRoles).toBe(1);
    expect(shouldPersistAgentCredentialMigration(result)).toBe(true);
  });

  it('cleans stale grants after a seeded platform agent no longer matches the trusted allowlist', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: 'former-kai-record',
        username: 'sora',
        email: 'sora@shizuha.com',
        credentialGrantScopes: ['fleet-ssh', 'kubeconfig'],
        credentialAuditRoles: ['security-lead'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ], new Set());

    expect(result.agents[0]!.credentialGrantScopes).toBeUndefined();
    expect(result.agents[0]!.credentialAuditRoles).toEqual(['security-lead']);
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBe('adr-plat-001-s10');
    expect(result.seededGrantPermissions).toBe(1);
    expect(result.seededAuditRoles).toBe(0);
  });

  it('clears unverified bootstrap grants after an authoritative platform roster result', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: 'imported-kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
        credentialGrantScopes: ['fleet-ssh', 'kubeconfig'],
        credentialCustomGrantServices: ['forgejo'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ], new Set(), {
      trustedPlatformIdentities: new Map(),
      trustedPlatformIdentitiesAuthoritative: true,
    });

    expect(result.agents[0]!.credentialGrantScopes).toBeUndefined();
    expect(result.agents[0]!.credentialAuditRoles).toBeUndefined();
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBeUndefined();
    expect(result.seededGrantPermissions).toBe(1);
    expect(result.seededPermissionBaselines).toBe(1);
  });

  it('reseeds a previously baselined agent after its platform identity is verified', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: 'kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
      makeAgent({
        id: 'ren-record',
        username: 'ren',
        email: 'ren@shizuha.com',
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ], new Set(), {
      trustedPlatformIdentities: new Map([
        ['kai-record', { username: 'kai', email: 'kai@shizuha.com', platformUserId: 13 }],
        ['ren-record', { username: 'ren', email: 'ren@shizuha.com', platformUserId: 18 }],
      ]),
      trustedPlatformIdentitiesAuthoritative: true,
    });

    const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
    expect(byId.get('kai-record')!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
    expect(byId.get('ren-record')!.credentialAuditRoles).toEqual(['metadata-audit']);
    expect(result.seededGrantPermissions).toBe(1);
    expect(result.seededAuditRoles).toBe(1);
  });

  it('binds trusted seed identity to a specific agent record when duplicate username/email records exist', () => {
    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: 'real-kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
      }),
      makeAgent({
        id: 'duplicate-kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
      }),
    ], new Set(), {
      trustedPlatformIdentities: new Map([
        ['real-kai-record', { username: 'kai', email: 'kai@shizuha.com', platformUserId: 13 }],
      ]),
    });

    const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
    expect(byId.get('real-kai-record')!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
    expect(byId.get('duplicate-kai-record')!.credentialGrantScopes).toBeUndefined();
    expect(byId.get('duplicate-kai-record')!.credentialPermissionSeedVersion).toBeUndefined();
  });

  it('derives trusted seed identities only from authenticated platform roster records', () => {
    const trusted = buildTrustedCredentialSeedIdentitiesFromPlatformRoster(
      [
        makeAgent({
          id: 'platform-kai-record',
          username: 'kai',
          email: 'kai@shizuha.com',
        }),
        makeAgent({
          id: 'imported-kai-record',
          username: 'kai',
          email: 'kai@shizuha.com',
        }),
      ],
      [{
        id: 'platform-kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
        status: 'active',
        user_id: 13,
      }],
      [{ id: 13, username: 'kai', email: 'kai@shizuha.com' }],
    );

    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: 'platform-kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
      }),
      makeAgent({
        id: 'imported-kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
      }),
    ], new Set(), { trustedPlatformIdentities: trusted });

    const byId = new Map(result.agents.map((agent) => [agent.id, agent]));
    expect(byId.get('platform-kai-record')!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
    expect(byId.get('imported-kai-record')!.credentialGrantScopes).toBeUndefined();
    expect(byId.get('imported-kai-record')!.credentialPermissionSeedVersion).toBeUndefined();
  });

  it('fetches all platform users before authoritative S10 seed matching', async () => {
    const firstPageUsers = Array.from({ length: 200 }, (_, index) => ({
      id: 1000 + index,
      username: `user-${index}`,
      email: `user-${index}@shizuha.com`,
    }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: firstPageUsers,
        next: '/id/api/auth/users/all/?limit=200&offset=200',
      }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: [{ id: 13, username: 'kai', email: 'kai@shizuha.com' }],
        next: null,
      }),
    } as Response);

    const users = await fetchAuthenticatedPlatformUsers('https://platform.example', 'admin-token');
    const trusted = buildTrustedCredentialSeedIdentitiesFromPlatformRoster(
      [makeAgent({ id: 'kai-platform-record', username: 'kai', email: 'kai@shizuha.com' })],
      [{ id: 'kai-platform-record', username: 'kai', email: 'kai@shizuha.com', status: 'active', user_id: 13 }],
      users.users,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://platform.example/id/api/auth/users/all/?limit=200&offset=0');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://platform.example/id/api/auth/users/all/?limit=200&offset=200');
    expect(users.authoritative).toBe(true);
    expect(users.users).toHaveLength(201);
    expect(trusted.get('kai-platform-record')).toEqual({ username: 'kai', email: 'kai@shizuha.com', platformUserId: 13 });
  });

  it('hydrates canonical identities from the scoped in-cluster agent inventory', async () => {
    const previousToken = process.env.FLEET_PROVISIONER_TOKEN;
    process.env.FLEET_PROVISIONER_TOKEN = 'scoped-fleet-token';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 1,
        agents: [{
          user_id: 13,
          username: 'kai',
          email: 'kai@shizuha.com',
          account_type: 'agent',
          is_active: true,
          is_staff: false,
          is_superuser: false,
          agent_runtime_id: 'runtime-kai',
        }],
      }),
    } as Response);

    try {
      const result = await fetchInternalAgentIdentityUsers(
        'http://shizuha-id.shizuha.svc.cluster.local:8001/',
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'http://shizuha-id.shizuha.svc.cluster.local:8001/api/internal/agents/',
        expect.objectContaining({
          headers: { 'X-Fleet-Provisioner-Token': 'scoped-fleet-token' },
        }),
      );
      expect(result).toEqual({
        authoritative: true,
        users: [{
          id: 13,
          username: 'kai',
          email: 'kai@shizuha.com',
          is_staff: false,
          is_superuser: false,
          is_active: true,
          profile: { account_type: 'agent', agent_runtime_id: 'runtime-kai' },
        }],
      });
    } finally {
      if (previousToken === undefined) delete process.env.FLEET_PROVISIONER_TOKEN;
      else process.env.FLEET_PROVISIONER_TOKEN = previousToken;
    }
  });

  it('fails closed when the internal agent inventory is incomplete or ambiguous', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 2,
        agents: [{
          user_id: 13,
          username: 'kai',
          email: 'kai@shizuha.com',
          account_type: 'agent',
          is_active: true,
        }],
      }),
    } as Response);

    await expect(fetchInternalAgentIdentityUsers('http://id.internal')).resolves.toEqual({
      authoritative: false,
      users: [],
    });
  });

  it('prefers the internal identity inventory over the cross-service staff users API', async () => {
    const previousHome = process.env.HOME;
    const previousInternalUrl = process.env.SHIZUHA_ID_INTERNAL_URL;
    const previousDaemonId = process.env.SHIZUHA_DAEMON_ID;
    const previousDaemonToken = process.env.SHIZUHA_DAEMON_LINK_TOKEN;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-auth-'));
    process.env.HOME = tempHome;
    process.env.SHIZUHA_ID_INTERNAL_URL = 'http://id.internal:8001';
    process.env.SHIZUHA_DAEMON_ID = 'runtime-fleet';
    process.env.SHIZUHA_DAEMON_LINK_TOKEN = 'daemon-link-token';
    __setDiscoveredAgentsForTest([
      makeAgent({ id: 'kai-platform-record', username: 'kai', email: 'kai@shizuha.com' }),
    ]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 1,
        agents: [{
          user_id: 13,
          username: 'kai',
          email: 'kai@shizuha.com',
          account_type: 'agent',
          is_active: true,
          is_staff: false,
          is_superuser: false,
          agent_runtime_id: 'runtime-kai',
        }],
      }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ members: [{ user_id: 13, role: 'member' }] }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 1,
        agents: [{
          id: 'kai-platform-record',
          username: 'kai',
          status: 'running',
          user_id: 13,
        }],
      }),
    } as Response);

    try {
      const result = await __prefetchAllIdentitiesForTest(
        'https://platform.example',
        'daemon-token',
      );

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'http://id.internal:8001/api/internal/agents/',
        'https://platform.example/admin/api/organizations/shizuha/members/',
        'https://platform.example/hive/api/v1/fleet/daemon/identity-roster/',
      ]);
      expect(fetchMock.mock.calls[2]![1]).toMatchObject({
        headers: {
          'X-Hive-Daemon-Id': 'runtime-fleet',
          'X-Hive-Daemon-Token': 'daemon-link-token',
        },
      });
      expect(result.authoritative).toBe(true);
      expect(result.identities.get('kai-platform-record')?.platformUserId).toBe(13);
      expect(getCachedAgentIdentity('kai')).toMatchObject({
        userId: 13,
        isStaff: false,
        isSuperuser: false,
        isActive: true,
        accountType: 'agent',
        agentRuntimeId: 'runtime-kai',
        orgRole: 'member',
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousInternalUrl === undefined) delete process.env.SHIZUHA_ID_INTERNAL_URL;
      else process.env.SHIZUHA_ID_INTERNAL_URL = previousInternalUrl;
      if (previousDaemonId === undefined) delete process.env.SHIZUHA_DAEMON_ID;
      else process.env.SHIZUHA_DAEMON_ID = previousDaemonId;
      if (previousDaemonToken === undefined) delete process.env.SHIZUHA_DAEMON_LINK_TOKEN;
      else process.env.SHIZUHA_DAEMON_LINK_TOKEN = previousDaemonToken;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('fetches the complete authenticated Hive roster before marking S10 identity source authoritative', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 2,
        agents: [
          { id: 'not-kai', username: 'sora', status: 'stopped', user_id: 16 },
          { id: 'kai-platform-record', username: 'kai', status: 'running', user_id: 13 },
        ],
      }),
    } as Response);

    const roster = await fetchAuthenticatedHiveAgentIdentityRoster(
      'http://platform.example',
      'runtime-fleet',
      'daemon-token',
    );
    const trusted = buildTrustedCredentialSeedIdentitiesFromPlatformRoster(
      [makeAgent({ id: 'kai-platform-record', username: 'kai', email: 'kai@shizuha.com' })],
      roster.agents,
      [{ id: 13, username: 'kai', email: 'kai@shizuha.com' }],
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://platform.example/hive/api/v1/fleet/daemon/identity-roster/');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: {
        'X-Hive-Daemon-Id': 'runtime-fleet',
        'X-Hive-Daemon-Token': 'daemon-token',
      },
    });
    expect(roster.authoritative).toBe(true);
    expect(roster.agents).toHaveLength(2);
    expect(trusted.get('kai-platform-record')).toEqual({ username: 'kai', email: 'kai@shizuha.com', platformUserId: 13 });
  });

  it('marks malformed or incomplete Hive roster payloads non-authoritative', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 2,
        agents: [{ id: 'kai-platform-record', username: 'kai', status: 'running', user_id: 13 }],
      }),
    } as Response);

    const roster = await fetchAuthenticatedHiveAgentIdentityRoster(
      'https://platform.example',
      'runtime-fleet',
      'daemon-token',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(roster.authoritative).toBe(false);
    expect(roster.agents).toHaveLength(0);
  });

  it('marks malformed authenticated platform user pages non-authoritative', async () => {
    for (const malformedPage of [
      [{ id: 13, username: 'kai', email: 'kai@shizuha.com' }],
      { count: 1, next: null },
      { users: { id: 13, username: 'kai', email: 'kai@shizuha.com' } },
      { results: { id: 13, username: 'kai', email: 'kai@shizuha.com' } },
    ]) {
      vi.restoreAllMocks();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => malformedPage,
      } as Response);

      const users = await fetchAuthenticatedPlatformUsers('https://platform.example', 'admin-token');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(users.authoritative).toBe(false);
      expect(users.users).toHaveLength(0);
    }
  });

  it('fails closed on duplicate Hive roster identities', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 2,
        agents: [
          { id: 'kai-platform-record', username: 'kai', status: 'running', user_id: 13 },
          { id: 'kai-platform-record', username: 'shadow-kai', status: 'running', user_id: 14 },
        ],
      }),
    } as Response);

    const roster = await fetchAuthenticatedHiveAgentIdentityRoster(
      'https://platform.example',
      'runtime-fleet',
      'daemon-token',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(roster.authoritative).toBe(false);
    expect(roster.agents).toHaveLength(0);
  });

  it('marks synthetic user pagination non-authoritative when offsets stop yielding new users despite count', async () => {
    const firstPageUsers = Array.from({ length: 200 }, (_, index) => ({
      id: 1000 + index,
      username: `user-${index}`,
      email: `user-${index}@shizuha.com`,
    }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: firstPageUsers,
        count: 201,
      }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: firstPageUsers,
        count: 201,
      }),
    } as Response);

    const users = await fetchAuthenticatedPlatformUsers('https://platform.example', 'admin-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://platform.example/id/api/auth/users/all/?limit=200&offset=200');
    expect(users.authoritative).toBe(false);
    expect(users.users).toHaveLength(200);
  });

  it('preserves users fetched before a later paginated users API failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: [{ id: 13, username: 'kai', email: 'kai@shizuha.com' }],
        next: '/id/api/auth/users/all/?limit=200&offset=200',
      }),
    } as Response).mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
    } as Response);

    const users = await fetchAuthenticatedPlatformUsers('https://platform.example', 'admin-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(users.authoritative).toBe(false);
    expect(users.users).toEqual([{ id: 13, username: 'kai', email: 'kai@shizuha.com' }]);
  });

  it('treats an empty synthetic user page as authoritative EOF for exact page-size results without count', async () => {
    const firstPageUsers = Array.from({ length: 200 }, (_, index) => ({
      id: 1000 + index,
      username: `user-${index}`,
      email: `user-${index}@shizuha.com`,
    }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: firstPageUsers,
      }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: [],
      }),
    } as Response);

    const users = await fetchAuthenticatedPlatformUsers('https://platform.example', 'admin-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://platform.example/id/api/auth/users/all/?limit=200&offset=200');
    expect(users.authoritative).toBe(true);
    expect(users.users).toHaveLength(200);
  });

  it('populates the normal identity cache from fetched users even when S10 seed trust is non-authoritative', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-auth-'));
    fs.mkdirSync(path.join(tempHome, '.shizuha'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, '.shizuha', 'auth.json'), JSON.stringify({ accessToken: 'admin-token' }));
    process.env.HOME = tempHome;
    __setDiscoveredAgentsForTest([
      makeAgent({ id: 'kai-platform-record', username: 'kai', email: 'kai@shizuha.com' }),
    ]);

    const firstPageUsers = Array.from({ length: 200 }, (_, index) => ({
      id: 1000 + index,
      username: `user-${index}`,
      email: `user-${index}@shizuha.com`,
    }));
    firstPageUsers[0] = { id: 13, username: 'kai', email: 'kai@shizuha.com' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: firstPageUsers,
        count: 201,
      }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: firstPageUsers,
        count: 201,
      }),
    } as Response);

    const prefetch = await __prefetchAllIdentitiesForTest('https://platform.example');

    expect(prefetch.authoritative).toBe(false);
    expect(prefetch.identities.size).toBe(0);
    expect(getCachedAgentIdentity('kai')).toEqual({
      userId: 13,
      isStaff: false,
      isSuperuser: false,
      orgRole: undefined,
      isActive: undefined,
      accountType: undefined,
      agentRuntimeId: null,
    });

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('uses independent daemon-link credentials for authoritative S10 seed prefetch', async () => {
    const previousHome = process.env.HOME;
    const previousDaemonId = process.env.SHIZUHA_DAEMON_ID;
    const previousDaemonToken = process.env.SHIZUHA_DAEMON_LINK_TOKEN;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-auth-'));
    process.env.HOME = tempHome;
    process.env.SHIZUHA_DAEMON_ID = 'runtime-fleet';
    process.env.SHIZUHA_DAEMON_LINK_TOKEN = 'daemon-link-token';
    __setDiscoveredAgentsForTest([
      makeAgent({ id: 'kai-platform-record', username: 'kai', email: 'kai@shizuha.com' }),
    ]);

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: [{ id: 13, username: 'kai', email: 'kai@shizuha.com' }],
        next: null,
      }),
    } as Response).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        count: 1,
        agents: [{ id: 'kai-platform-record', username: 'kai', status: 'running', user_id: 13 }],
      }),
    } as Response);

    const prefetch = await __prefetchAllIdentitiesForTest('https://platform.example', 'daemon-token');

    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: 'Bearer daemon-token' },
    });
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({
      headers: {
        'X-Hive-Daemon-Id': 'runtime-fleet',
        'X-Hive-Daemon-Token': 'daemon-link-token',
      },
    });
    expect(prefetch.authoritative).toBe(true);
    expect(prefetch.identities.get('kai-platform-record')).toEqual({
      username: 'kai',
      email: 'kai@shizuha.com',
      platformUserId: 13,
    });
    expect(getCachedAgentIdentity('kai')?.userId).toBe(13);

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousDaemonId === undefined) delete process.env.SHIZUHA_DAEMON_ID;
    else process.env.SHIZUHA_DAEMON_ID = previousDaemonId;
    if (previousDaemonToken === undefined) delete process.env.SHIZUHA_DAEMON_LINK_TOKEN;
    else process.env.SHIZUHA_DAEMON_LINK_TOKEN = previousDaemonToken;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('populates the normal identity cache from partial users when later pagination fails', async () => {
    const previousHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-auth-'));
    process.env.HOME = tempHome;
    __setDiscoveredAgentsForTest([
      makeAgent({ id: 'kai-platform-record', username: 'kai', email: 'kai@shizuha.com' }),
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: [{ id: 13, username: 'kai', email: 'kai@shizuha.com' }],
        next: '/id/api/auth/users/all/?limit=200&offset=200',
      }),
    } as Response).mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
    } as Response);

    const prefetch = await __prefetchAllIdentitiesForTest('https://platform.example', 'daemon-token');

    expect(prefetch.authoritative).toBe(false);
    expect(prefetch.identities.size).toBe(0);
    expect(getCachedAgentIdentity('kai')?.userId).toBe(13);

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('does not return trusted S10 seed identities from a non-authoritative roster fetch', async () => {
    const previousHome = process.env.HOME;
    const previousDaemonId = process.env.SHIZUHA_DAEMON_ID;
    const previousDaemonToken = process.env.SHIZUHA_DAEMON_LINK_TOKEN;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-auth-'));
    fs.mkdirSync(path.join(tempHome, '.shizuha'), { recursive: true });
    fs.writeFileSync(path.join(tempHome, '.shizuha', 'auth.json'), JSON.stringify({ accessToken: 'admin-token' }));
    process.env.HOME = tempHome;
    process.env.SHIZUHA_DAEMON_ID = 'runtime-fleet';
    process.env.SHIZUHA_DAEMON_LINK_TOKEN = 'daemon-link-token';
    __setDiscoveredAgentsForTest([
      makeAgent({ id: 'kai-platform-record', username: 'kai', email: 'kai@shizuha.com' }),
    ]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        users: [{ id: 13, username: 'kai', email: 'kai@shizuha.com' }],
        next: null,
      }),
    } as Response).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    } as Response).mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as Response);

    const prefetch = await __prefetchAllIdentitiesForTest('https://platform.example');

    expect(prefetch.authoritative).toBe(false);
    expect(prefetch.identities.size).toBe(0);
    expect(getCachedAgentIdentity('kai')?.userId).toBe(13);

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousDaemonId === undefined) delete process.env.SHIZUHA_DAEMON_ID;
    else process.env.SHIZUHA_DAEMON_ID = previousDaemonId;
    if (previousDaemonToken === undefined) delete process.env.SHIZUHA_DAEMON_LINK_TOKEN;
    else process.env.SHIZUHA_DAEMON_LINK_TOKEN = previousDaemonToken;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('preserves HTTPS for authenticated S10 credential-seed verification', async () => {
    expect(credentialSeedVerificationPlatformUrl('https://platform.example/')).toBe('https://platform.example');
    expect(credentialSeedVerificationPlatformUrl('https://platform.example/agent/api/')).toBe('https://platform.example');
    expect(credentialSeedVerificationPlatformUrl('http://shizuha.com/')).toBe('http://shizuha.com');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ count: 0, agents: [] }),
    } as Response);

    await fetchAuthenticatedHiveAgentIdentityRoster(
      credentialSeedVerificationPlatformUrl('https://platform.example/'),
      'runtime-fleet',
      'daemon-token',
    );

    expect(fetchMock.mock.calls[0]![0]).toBe('https://platform.example/hive/api/v1/fleet/daemon/identity-roster/');
  });

  it('merges a migrated filtered daemon subset back into the full stored roster', () => {
    const stored = [
      makeAgent({ id: 'kai-record', username: 'kai', email: 'kai@shizuha.com' }),
      makeAgent({ id: 'ryo-record', username: 'ryo', email: 'ryo@shizuha.com' }),
      makeAgent({ id: 'sora-record', username: 'sora', email: 'sora@shizuha.com' }),
    ];
    const migratedSubset = [
      makeAgent({
        id: 'kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
        credentialGrantScopes: ['fleet-ssh', 'kubeconfig'],
        credentialCustomGrantServices: ['forgejo'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ];

    const merged = mergeMigratedAgentsIntoStoredRoster(stored, migratedSubset);
    const byId = new Map(merged.map((agent) => [agent.id, agent]));

    expect(merged.map((agent) => agent.id)).toEqual(['kai-record', 'ryo-record', 'sora-record']);
    expect(byId.get('kai-record')!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
    expect(byId.get('kai-record')!.credentialCustomGrantServices).toEqual(['forgejo']);
    expect(byId.get('ryo-record')!.username).toBe('ryo');
    expect(byId.get('sora-record')!.username).toBe('sora');
  });

  it('persists only credential migration fields when merging a runtime-mutated daemon subset', () => {
    const stored = [
      makeAgent({ id: 'kai-record', username: 'kai', email: 'kai@shizuha.com', localPort: 8001 }),
      makeAgent({ id: 'sora-record', username: 'sora', email: 'sora@shizuha.com', localPort: 8002 }),
    ];
    const migratedSubset = [
      makeAgent({
        id: 'kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
        localPort: 8080,
        credentialGrantScopes: ['fleet-ssh', 'kubeconfig'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ];

    const merged = mergeMigratedAgentsIntoStoredRoster(stored, migratedSubset);
    const byId = new Map(merged.map((agent) => [agent.id, agent]));

    expect(byId.get('kai-record')!.localPort).toBe(8001);
    expect(byId.get('kai-record')!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
    expect(byId.get('sora-record')!.localPort).toBe(8002);
  });

  it('does not merge filtered credential grants into duplicate agent ids with different identities', () => {
    const stored = [
      makeAgent({ id: 'duplicate-id', username: 'kai', email: 'kai@shizuha.com' }),
      makeAgent({ id: 'duplicate-id', username: 'sora', email: 'sora@shizuha.com' }),
    ];
    const migratedSubset = [
      makeAgent({
        id: 'duplicate-id',
        username: 'kai',
        email: 'kai@shizuha.com',
        credentialGrantScopes: ['fleet-ssh', 'kubeconfig'],
        credentialPermissionSeedVersion: 'adr-plat-001-s10',
      }),
    ];

    const merged = mergeMigratedAgentsIntoStoredRoster(stored, migratedSubset);
    const byUsername = new Map(merged.map((agent) => [agent.username, agent]));

    expect(byUsername.get('kai')!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
    expect(byUsername.get('sora')!.credentialGrantScopes).toBeUndefined();
    expect(byUsername.get('sora')!.credentialPermissionSeedVersion).toBeUndefined();
  });

  it('does not authorize S10 seeding from public internal runtime claims without authenticated roster evidence', () => {
    const publicInternalRuntimeClaim = {
      exists: true,
      user_id: 13,
      email: 'kai@shizuha.com',
      account_type: 'agent',
      agent_runtime_id: 'runtime-12345',
      is_active: true,
    };
    const trusted = buildTrustedCredentialSeedIdentitiesFromPlatformRoster(
      [makeAgent({
        id: 'imported-kai-record',
        username: 'kai',
        email: publicInternalRuntimeClaim.email,
      })],
      [],
      [{ id: publicInternalRuntimeClaim.user_id, username: 'kai', email: publicInternalRuntimeClaim.email }],
    );

    const result = migrateAgentCredentialGrants([
      makeAgent({
        id: 'imported-kai-record',
        username: 'kai',
        email: 'kai@shizuha.com',
      }),
    ], new Set(), { trustedPlatformIdentities: trusted });

    expect(trusted.size).toBe(0);
    expect(result.agents[0]!.credentialGrantScopes).toBeUndefined();
    expect(result.agents[0]!.credentialAuditRoles).toBeUndefined();
    expect(result.agents[0]!.credentialPermissionSeedVersion).toBeUndefined();
  });

  it('applies credential permission baselines during fresh first-run bootstrap', () => {
    const agents = applyFirstRunCredentialPermissionSeed([
      makeAgent({ id: '11111111-1111-4111-8111-111111111111', username: 'kai', email: 'kai@shizuha.com' }),
      makeAgent({ id: 'ren-id', username: 'ren', email: 'ren@shizuha.com' }),
      makeAgent({ username: 'sora', email: 'sora@shizuha.com', credentialGrantScopes: ['github'] }),
    ], { trustedPlatformIdentities: trustedPlatformUserIds });
    const byUsername = new Map(agents.map((agent) => [agent.username, agent]));

    expect(byUsername.get('kai')!.credentialGrantScopes).toEqual(['fleet-ssh', 'kubeconfig']);
    expect(byUsername.get('ren')!.credentialAuditRoles).toEqual(['metadata-audit']);
    expect(byUsername.get('sora')!.credentialGrantScopes).toBeUndefined();
    expect(agents.every((agent) => agent.credentialPermissionSeedVersion === 'adr-plat-001-s10')).toBe(true);
  });

  it('resolves fleet SSH staging data from AgentCredential rows, not sshKeys', () => {
    const agent = makeAgent({
      credentials: [{
        id: 'fleet-grant',
        grantId: 'fleet-grant',
        grantorId: 'security-lead',
        scope: 'fleet-ssh',
        service: 'fleet-ssh',
        label: 'Fleet SSH',
        credentialData: {
          sshDir: '/srv/shizuha/.ssh',
          keyFiles: JSON.stringify(['id_ed25519', 'known_hosts']),
          remoteUser: 'agent',
        },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      }],
      sshKeys: { enabled: false },
    });

    const result = resolveFleetSshCredentialGrant(agent);

    expect(result.refusals).toEqual([]);
    expect(result.grant).toEqual({
      grantId: 'fleet-grant',
      sshDir: '/srv/shizuha/.ssh',
      keyFiles: ['id_ed25519', 'known_hosts'],
      remoteUser: 'agent',
    });
  });

  it('refuses unknown scopes during read-side staging and never falls back to legacy sshKeys', () => {
    const agent = makeAgent({
      credentials: [{
        id: 'bad-scope',
        grantId: 'bad-scope',
        grantorId: 'security-lead',
        scope: 'future-scope',
        service: 'future-scope',
        label: 'Unexpected future scope',
        credentialData: { sshDir: '/srv/shizuha/.ssh' },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      } as unknown as AgentCredential],
      sshKeys: { enabled: true, sshDir: '/legacy/.ssh', keyFiles: ['id_rsa'], remoteUser: 'legacy' },
    });

    const result = resolveFleetSshCredentialGrant(agent);

    expect(result.grant).toBeNull();
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({
      credentialId: 'bad-scope',
      scope: 'future-scope',
    });
  });

  it('blocks fleet SSH staging when any same-agent credential read has an unknown scope', () => {
    const agent = makeAgent({
      credentials: [
        {
          id: 'fleet-grant',
          grantId: 'fleet-grant',
          grantorId: 'security-lead',
          scope: 'fleet-ssh',
          service: 'fleet-ssh',
          label: 'Fleet SSH',
          credentialData: {
            sshDir: '/srv/shizuha/.ssh',
            keyFiles: JSON.stringify(['id_ed25519']),
          },
          injectAsEnv: false,
          isActive: true,
          expiresAt: null,
        },
        {
          id: 'future-scope',
          grantId: 'future-scope',
          grantorId: 'security-lead',
          scope: 'future-scope',
          service: 'future-scope',
          label: 'Future scope',
          credentialData: { token: 'unused' },
          injectAsEnv: false,
          isActive: true,
          expiresAt: null,
        } as unknown as AgentCredential,
      ],
    });

    const result = resolveFleetSshCredentialGrant(agent);

    expect(result.grant).toBeNull();
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({
      credentialId: 'future-scope',
      scope: 'future-scope',
    });
  });

  it.each([
    ['JSON string', JSON.stringify('id_ed25519')],
    ['JSON object', JSON.stringify({ file: 'id_ed25519' })],
    ['invalid JSON string', 'id_ed25519'],
    ['array with an empty entry', JSON.stringify(['id_ed25519', ''])],
  ])('refuses malformed fleet SSH keyFiles without widening to default mounts: %s', (_label, keyFiles) => {
    const agent = makeAgent({
      credentials: [{
        id: 'fleet-grant',
        grantId: 'fleet-grant',
        grantorId: 'security-lead',
        scope: 'fleet-ssh',
        service: 'fleet-ssh',
        label: 'Fleet SSH',
        credentialData: {
          sshDir: '/srv/shizuha/.ssh',
          keyFiles,
        },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      }],
    });

    const result = resolveFleetSshCredentialGrant(agent);

    expect(result.grant).toBeNull();
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]!.credentialId).toBe('fleet-grant');
    expect(result.refusals[0]!.scope).toBe('fleet-ssh');
    expect(result.refusals[0]!.reason).toContain('keyFiles');
  });

  it('still treats absent or empty fleet SSH keyFiles as default-key-set requests', () => {
    const agents = [
      makeAgent({
        id: 'absent-keyfiles',
        credentials: [{
          id: 'fleet-grant-absent',
          grantId: 'fleet-grant-absent',
          grantorId: 'security-lead',
          scope: 'fleet-ssh',
          service: 'fleet-ssh',
          label: 'Fleet SSH',
          credentialData: { sshDir: '/srv/shizuha/.ssh' },
          injectAsEnv: false,
          isActive: true,
          expiresAt: null,
        }],
      }),
      makeAgent({
        id: 'empty-keyfiles',
        credentials: [{
          id: 'fleet-grant-empty',
          grantId: 'fleet-grant-empty',
          grantorId: 'security-lead',
          scope: 'fleet-ssh',
          service: 'fleet-ssh',
          label: 'Fleet SSH',
          credentialData: { sshDir: '/srv/shizuha/.ssh', keyFiles: '' },
          injectAsEnv: false,
          isActive: true,
          expiresAt: null,
        }],
      }),
    ];

    for (const agent of agents) {
      const result = resolveFleetSshCredentialGrant(agent);
      expect(result.refusals).toEqual([]);
      expect(result.grant).toMatchObject({ sshDir: '/srv/shizuha/.ssh', keyFiles: undefined });
    }
  });

  it('treats expired active-looking grants as inactive on daemon read paths', () => {
    const agent = makeAgent({
      credentials: [{
        id: 'expired-fleet-grant',
        grantId: 'expired-fleet-grant',
        grantorId: 'security-lead',
        scope: 'fleet-ssh',
        service: 'fleet-ssh',
        label: 'Fleet SSH',
        credentialData: { sshDir: '/srv/shizuha/.ssh' },
        injectAsEnv: false,
        isActive: true,
        expiresAt: '2000-01-01T00:00:00.000Z',
      }],
    });

    expect(isAgentCredentialGrantCurrentlyActive(agent.credentials![0]!)).toBe(false);
    expect(resolveFleetSshCredentialGrant(agent).grant).toBeNull();
  });

  it('reconciles legacy runtime sshKeys updates into a fleet SSH AgentCredential grant', () => {
    const agent = makeAgent({
      credentials: [{
        id: 'github-grant',
        grantId: 'github-grant',
        grantorId: 'security-lead',
        scope: 'github',
        service: 'github',
        label: 'GitHub',
        credentialData: { token: 'ghp_example' },
        injectAsEnv: true,
        isActive: true,
        expiresAt: null,
      }],
    });

    const credentials = reconcileFleetSshCredentialGrantFromLegacySshKeys(agent, {
      enabled: true,
      sshDir: '/srv/shizuha/.ssh',
      keyFiles: ['id_ed25519'],
      remoteUser: 'agent',
    });

    expect(credentials).toHaveLength(2);
    expect(credentials!.find((credential) => credential.scope === 'github')).toBeTruthy();
    expect(credentials!.find((credential) => credential.scope === 'fleet-ssh')).toMatchObject({
      scope: 'fleet-ssh',
      service: 'fleet-ssh',
      credentialData: {
        sshDir: '/srv/shizuha/.ssh',
        keyFiles: JSON.stringify(['id_ed25519']),
        remoteUser: 'agent',
      },
      injectAsEnv: false,
      isActive: true,
    });
  });

  it('updates an existing legacy fleet SSH grant instead of duplicating it', () => {
    const agent = makeAgent({
      credentials: [{
        id: 'old-fleet-grant',
        grantId: 'old-fleet-grant',
        grantorId: 'security-lead',
        scope: 'fleet-ssh',
        service: 'fleet-ssh',
        label: 'Fleet SSH',
        credentialData: { sshDir: '/old/.ssh', keyFiles: JSON.stringify(['id_rsa']) },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      }],
    });

    const credentials = reconcileFleetSshCredentialGrantFromLegacySshKeys(agent, {
      enabled: true,
      sshDir: '/new/.ssh',
      keyFiles: ['id_ed25519', 'known_hosts'],
    });

    const fleetGrants = credentials!.filter((credential) => credential.scope === 'fleet-ssh');
    expect(fleetGrants).toHaveLength(1);
    expect(fleetGrants[0]!.credentialData).toMatchObject({
      sshDir: '/new/.ssh',
      keyFiles: JSON.stringify(['id_ed25519', 'known_hosts']),
    });
  });

  it('removes the fleet SSH AgentCredential when legacy runtime sshKeys are disabled', () => {
    const agent = makeAgent({
      credentials: [
        {
          id: 'fleet-grant',
          grantId: 'fleet-grant',
          grantorId: 'security-lead',
          scope: 'fleet-ssh',
          service: 'fleet-ssh',
          label: 'Fleet SSH',
          credentialData: { sshDir: '/srv/shizuha/.ssh' },
          injectAsEnv: false,
          isActive: true,
          expiresAt: null,
        },
        {
          id: 'github-grant',
          grantId: 'github-grant',
          grantorId: 'security-lead',
          scope: 'github',
          service: 'github',
          label: 'GitHub',
          credentialData: { token: 'ghp_example' },
          injectAsEnv: true,
          isActive: true,
          expiresAt: null,
        },
      ],
    });

    const credentials = reconcileFleetSshCredentialGrantFromLegacySshKeys(agent, { enabled: false });

    expect(credentials).toHaveLength(1);
    expect(credentials!.some((credential) => credential.scope === 'fleet-ssh')).toBe(false);
    expect(credentials![0]!.scope).toBe('github');
  });

  it('preserves existing fleet SSH AgentCredential during enable-time compatibility when legacy sshKeys are disabled', () => {
    const agent = makeAgent({
      sshKeys: { enabled: false },
      credentials: [{
        id: 'fleet-grant',
        grantId: 'fleet-grant',
        grantorId: 'security-lead',
        scope: 'fleet-ssh',
        service: 'fleet-ssh',
        label: 'Fleet SSH',
        credentialData: { sshDir: '/agentcredential/.ssh', keyFiles: JSON.stringify(['id_ed25519']) },
        injectAsEnv: false,
        isActive: true,
        expiresAt: null,
      }],
    });

    const credentials = materializeMissingFleetSshCredentialGrantFromLegacySshKeys(agent);

    expect(credentials).toHaveLength(1);
    expect(credentials![0]).toMatchObject({
      grantId: 'fleet-grant',
      scope: 'fleet-ssh',
      credentialData: { sshDir: '/agentcredential/.ssh' },
    });
  });

  it('materializes a missing fleet SSH AgentCredential during enable-time compatibility for enabled legacy sshKeys', () => {
    const agent = makeAgent({
      sshKeys: { enabled: true, sshDir: '/legacy/.ssh', keyFiles: ['id_ed25519'] },
    });

    const credentials = materializeMissingFleetSshCredentialGrantFromLegacySshKeys(agent);

    expect(credentials).toHaveLength(1);
    expect(credentials![0]).toMatchObject({
      scope: 'fleet-ssh',
      credentialData: {
        sshDir: '/legacy/.ssh',
        keyFiles: JSON.stringify(['id_ed25519']),
      },
    });
  });
});

describe('AgentCredential broker authority guards', () => {
  const managerSource = fs.readFileSync(path.join(process.cwd(), 'src/daemon/manager.ts'), 'utf8');

  it('rejects generic direct credential replacement through agent updates', () => {
    expect(managerSource).toContain("if ('credentials' in updates)");
    expect(managerSource).toContain('AgentCredential grants are broker-managed');
    expect(managerSource).not.toContain("if (updates.credentials != null) agent.credentials = updates.credentials");
    expect(managerSource.indexOf("if ('credentials' in updates)")).toBeLessThan(managerSource.indexOf('if (updates.name != null)'));
  });

  it('rejects legacy ssh_keys changes through generic agent updates', () => {
    expect(managerSource).toContain("if ('ssh_keys' in updates)");
    expect(managerSource).toContain('ssh_keys is broker-managed');
    expect(managerSource).not.toContain('agent.credentials = reconcileFleetSshCredentialGrantFromLegacySshKeys(agent, agent.sshKeys)');
    expect(managerSource.indexOf("if ('ssh_keys' in updates)")).toBeLessThan(managerSource.indexOf('if (updates.name != null)'));
  });

  it('merges broker writes into the full persisted roster instead of truncating filtered daemon agents', () => {
    expect(managerSource).toContain('const latestAllAgents = readAgents()');
    expect(managerSource).toContain('const mergedAgents = latestAllAgents.map');
    expect(managerSource).toContain('writeAgents(mergedAgents)');
  });
});

describe('PLAT-194 re-point preserves sibling fleet-ssh grants', () => {
  it('retains other fleet-ssh credentials when re-pointing one', () => {
    const base = makeAgent({ skills: ['devops'] });
    const stale = createHostPlaneFleetSshCredentialGrant(base);
    stale.credentialData.sshDir = '~/.ssh';
    const other = createHostPlaneFleetSshCredentialGrant(base);
    other.id = 'other-grant'; other.grantId = 'other-grant';
    other.credentialData.sshDir = `~/.shizuha/ssh-keys/${base.username}-extra`;
    const creds = materializeMissingFleetSshCredentialGrantFromLegacySshKeys({ ...base, credentials: [stale, other] });
    const fleet = (creds ?? []).filter((c) => c.scope === 'fleet-ssh');
    expect(fleet.length).toBe(2);
    // re-pointed (store-sourced) grant must remain FIRST so resolve selects it, not the sibling
    expect((creds ?? []).find((c) => c.scope === 'fleet-ssh')?.credentialData.sshDir)
      .toBe(hostPlaneFleetSshSourceDir(base));
  });
});
