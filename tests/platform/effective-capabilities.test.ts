import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../src/daemon/types.js';
import {
  agentEffectiveCapabilityEnv,
  applyEffectiveCapabilitiesToAgent,
  parseAgentEffectiveMcpServicesFromEnv,
  signEffectiveCapabilitiesPayload,
} from '../../src/platform/effective-capabilities.js';

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    username: 'testagent',
    email: 'testagent@agents.shizuha.io',
    role: 'Engineer',
    status: 'active',
    mcpServers: [],
    personalityTraits: {},
    skills: ['legacy-skill'],
    ...overrides,
  };
}

const now = new Date('2026-07-01T00:00:00.000Z');

describe('Hive effective capability runtime adapter', () => {
  it('applies Hive-computed multi-team union to skills, eager skills, MCP, credential scopes, and diagnostics', () => {
    const secret = 'test-secret';
    const payload: Record<string, unknown> = {
      catalog_version: 7,
      computed_at: '2026-07-01T00:00:00.000Z',
      expires_at: '2026-07-01T00:05:00.000Z',
      capabilities: ['engineering', 'docs', 'devops'],
      source_teams: ['engineering', 'documentation'],
      skills: ['backend', 'debugging', 'google-drive-public-links'],
      eager_skills: ['safe-operations'],
      enabled_mcp_servers: [{ slug: 'pulse' }, { slug: 'wiki' }, { slug: 'drive' }],
      runtime_flags: { capability_generation: 'gen-7' },
      credential_grant_scopes: ['github'],
      credential_custom_grant_services: ['Forgejo'],
    };
    payload.signature = signEffectiveCapabilitiesPayload(payload, secret);

    const result = applyEffectiveCapabilitiesToAgent(agent(), payload, { now, hmacSecret: secret });

    expect(result.report.applied).toBe(true);
    expect(result.report.changed).toBe(true);
    expect(result.agent.skills).toEqual(['backend', 'debugging', 'google-drive-public-links']);
    expect(result.agent.eagerSkills).toEqual(['safe-operations']);
    expect(result.agent.mcpServers.map((s) => s.slug)).toEqual(['pulse', 'wiki', 'drive']);
    expect(result.agent.credentialGrantScopes).toEqual(['github']);
    expect(result.agent.credentialCustomGrantServices).toEqual(['forgejo']);
    expect(result.agent.effectiveCapabilities?.sourceTeams).toEqual(['engineering', 'documentation']);
    expect(agentEffectiveCapabilityEnv(result.agent)).toMatchObject({
      AGENT_EFFECTIVE_CAPABILITIES: 'engineering,docs,devops',
      AGENT_EFFECTIVE_CAPABILITY_SOURCE_TEAMS: 'engineering,documentation',
      AGENT_EFFECTIVE_MCP_SERVICES: 'pulse,wiki,drive',
      AGENT_EFFECTIVE_CAPABILITY_CATALOG_VERSION: '7',
    });
  });

  it('normalizes Hive role-qualified credential scopes (github:review / github:merge) to the base grant instead of dropping them (PLAT-3998)', () => {
    const secret = 'test-secret';
    const payload: Record<string, unknown> = {
      catalog_version: 8,
      computed_at: '2026-07-01T00:00:00.000Z',
      expires_at: '2026-07-01T00:05:00.000Z',
      capabilities: ['review', 'merge'],
      source_teams: ['review', 'merge'],
      skills: ['revi-reviewer'],
      enabled_mcp_servers: ['pulse'],
      credential_grant_scopes: ['github:review', 'github:merge', 'github', 'bogus', 'bogus:review'],
    };
    payload.signature = signEffectiveCapabilitiesPayload(payload, secret);

    const result = applyEffectiveCapabilitiesToAgent(agent(), payload, { now, hmacSecret: secret });

    expect(result.report.applied).toBe(true);
    // Qualified scopes collapse onto the base grant and dedupe; unknown bases still drop.
    expect(result.agent.credentialGrantScopes).toEqual(['github']);
    const codes = result.agent.effectiveCapabilities?.diagnostics.map((d) => d.code) ?? [];
    expect(codes.filter((c) => c === 'qualified_credential_scope')).toHaveLength(2);
    expect(codes.filter((c) => c === 'unknown_credential_scope')).toHaveLength(2);
  });

  it('revokes removed team capability effects on the next valid refresh instead of unioning with legacy fields', () => {
    const first = applyEffectiveCapabilitiesToAgent(agent({ skills: ['legacy-devops'] }), {
      catalog_version: 10,
      expires_at: '2026-07-01T00:05:00.000Z',
      capabilities: ['devops', 'docs'],
      source_teams: ['devops', 'documentation'],
      skills: ['kubernetes', 'google-drive-public-links'],
      enabled_mcp_servers: ['pulse', 'wiki', 'drive'],
      signature: 'signed-v1',
    }, { now }).agent;

    const second = applyEffectiveCapabilitiesToAgent(first, {
      catalog_version: 11,
      expires_at: '2026-07-01T00:05:00.000Z',
      capabilities: ['devops'],
      source_teams: ['devops'],
      skills: ['kubernetes'],
      enabled_mcp_servers: ['pulse', 'wiki'],
      signature: 'signed-v2',
    }, { now });

    expect(second.report.applied).toBe(true);
    expect(second.report.changed).toBe(true);
    expect(second.agent.skills).toEqual(['kubernetes']);
    expect(second.agent.mcpServers.map((s) => s.slug)).toEqual(['pulse', 'wiki']);
  });

  it('fails closed for sensitive credential-scope additions from unsigned Hive payloads', () => {
    const result = applyEffectiveCapabilitiesToAgent(agent(), {
      catalog_version: 3,
      expires_at: '2026-07-01T00:05:00.000Z',
      capabilities: ['devops'],
      source_teams: ['devops'],
      skills: ['kubernetes'],
      enabled_mcp_servers: ['pulse', 'cron'],
      credential_grant_scopes: ['kubeconfig'],
      credential_custom_grant_services: ['forgejo'],
    }, { now });

    expect(result.report.applied).toBe(true);
    // cron is no longer in SENSITIVE_MCP_SERVERS (PLAT-5106) — it carries
    // browser/media/scheduling tools alongside remote_exec, and classifying
    // the whole server as sensitive withheld all browser MCP tools from
    // unsigned Hive payloads. remote_exec is gated by SSH key availability.
    expect(result.agent.mcpServers.map((s) => s.slug)).toEqual(['pulse', 'cron']);
    expect(result.agent.credentialGrantScopes).toEqual([]);
    expect(result.agent.credentialCustomGrantServices).toEqual([]);
    expect(result.agent.effectiveCapabilities?.diagnostics.map((d) => d.code)).not.toContain('withheld_sensitive_mcp_unsigned');
    expect(result.agent.effectiveCapabilities?.diagnostics.map((d) => d.code)).toContain('withheld_credential_scopes_unsigned');
    expect(result.agent.effectiveCapabilities?.diagnostics.map((d) => d.code)).toContain('withheld_custom_credential_services_unsigned');
  });

  it('accepts active handle-only materializations only from a signed payload and scrubs them on revoke', () => {
    const secret = 'test-secret';
    const payload: Record<string, unknown> = {
      source_teams: ['qa', 'review'],
      source_team_memberships: [
        { organization_slug: 'shizuha', team_slug: 'qa' },
        { organization_slug: 'shizuha', team_slug: 'review' },
      ],
      capabilities: ['qa', 'review'],
      skills: [],
      enabled_mcp_servers: [],
      team_credential_eligible_teams: ['qa'],
      team_credential_eligible_memberships: [
        { organization_slug: 'shizuha', team_slug: 'qa' },
      ],
      credential_materializations: [
        {
          grant_id: '11111111-1111-1111-1111-111111111111',
          scope: 'team',
          organization_slug: 'shizuha',
          team_slug: 'qa',
          provider: 'generic-env',
          purpose: 'QA_ISOLATION_A_USERNAME',
          secret_ref: 'k8s-secret://shizuha-fleet/qa-isolation-fixtures#QA_ISOLATION_A_USERNAME',
          is_active: true,
        },
        {
          grant_id: '22222222-2222-2222-2222-222222222222',
          scope: 'team',
          organization_slug: 'shizuha',
          team_slug: 'review',
          provider: 'generic-env',
          purpose: 'REVIEW_ADMIN_TOKEN',
          secret_ref: 'k8s-secret://shizuha-fleet/review-secrets#REVIEW_ADMIN_TOKEN',
          is_active: true,
        },
      ],
    };
    payload.signature = signEffectiveCapabilitiesPayload(payload, secret);

    const applied = applyEffectiveCapabilitiesToAgent(agent(), payload, { now, hmacSecret: secret });
    expect(applied.report.applied).toBe(true);
    expect(applied.agent.effectiveCapabilities?.teamCredentialEligibleTeams).toEqual(['qa']);
    expect(applied.agent.effectiveCapabilities?.teamCredentialEligibleMemberships).toEqual([
      { organizationSlug: 'shizuha', teamSlug: 'qa' },
    ]);
    expect(applied.agent.effectiveCapabilities?.credentialMaterializations).toHaveLength(1);

    const unsigned = { ...payload };
    delete unsigned.signature;
    const withheld = applyEffectiveCapabilitiesToAgent(agent(), unsigned, { now, hmacSecret: secret });
    expect(withheld.report.applied).toBe(true);
    expect(withheld.agent.effectiveCapabilities?.teamCredentialEligibleTeams).toEqual([]);
    expect(withheld.agent.effectiveCapabilities?.teamCredentialEligibleMemberships).toEqual([]);
    expect(withheld.agent.effectiveCapabilities?.credentialMaterializations).toEqual([]);
    expect(withheld.agent.effectiveCapabilities?.diagnostics.map((d) => d.code)).toContain('withheld_credential_materializations_unsigned');

    const revoked = { ...payload, credential_materializations: [] };
    revoked.signature = signEffectiveCapabilitiesPayload(revoked, secret);
    const scrubbed = applyEffectiveCapabilitiesToAgent(applied.agent, revoked, { now, hmacSecret: secret });
    expect(scrubbed.agent.effectiveCapabilities?.credentialMaterializations).toEqual([]);
    expect(scrubbed.report.changed).toBe(true);

    const customerQaOnly = {
      ...payload,
      // Preserve the flattened team slug to prove it cannot authorize a
      // platform-internal descriptor after the org-qualified row changes.
      source_team_memberships: [{ organization_slug: 'customer-x', team_slug: 'qa' }],
    };
    customerQaOnly.signature = signEffectiveCapabilitiesPayload(customerQaOnly, secret);
    const collisionScrub = applyEffectiveCapabilitiesToAgent(applied.agent, customerQaOnly, { now, hmacSecret: secret });
    expect(collisionScrub.agent.effectiveCapabilities?.sourceTeams).toContain('qa');
    expect(collisionScrub.agent.effectiveCapabilities?.credentialMaterializations).toEqual([]);
    expect(collisionScrub.report.changed).toBe(true);
  });

  it('does not trust a mere signature field for sensitive MCP or credential scopes', () => {
    const result = applyEffectiveCapabilitiesToAgent(agent(), {
      catalog_version: 4,
      expires_at: '2026-07-01T00:05:00.000Z',
      capabilities: ['devops'],
      source_teams: ['devops'],
      skills: ['kubernetes'],
      enabled_mcp_servers: ['pulse', 'cron'],
      credential_grant_scopes: ['github'],
      credential_custom_grant_services: ['forgejo'],
      signature: 'bogus-present-but-unverified',
    }, { now });

    expect(result.report.applied).toBe(true);
    // PLAT-5106: cron is no longer sensitive, so a bogus signature still lets
    // it through. Credential scopes remain gated on verified trust.
    expect(result.agent.mcpServers.map((s) => s.slug)).toEqual(['pulse', 'cron']);
    expect(result.agent.credentialGrantScopes).toEqual([]);
    expect(result.agent.credentialCustomGrantServices).toEqual([]);
    expect(result.agent.effectiveCapabilities?.trustedForSensitive).toBe(false);
  });

  it('revokes credential grant scopes when Hive returns an empty effective set', () => {
    const result = applyEffectiveCapabilitiesToAgent(agent({
      credentialGrantScopes: ['github', 'kubeconfig'],
    }), {
      catalog_version: 12,
      expires_at: '2026-07-01T00:05:00.000Z',
      capabilities: ['engineering'],
      source_teams: ['engineering'],
      skills: ['coding'],
      enabled_mcp_servers: ['pulse'],
      credential_grant_scopes: [],
      signature: 'migration-shadow-signature',
    }, { now, trustUnsignedForSensitive: true });

    expect(result.report.applied).toBe(true);
    expect(result.agent.credentialGrantScopes).toEqual([]);
  });

  it('rejects malformed or stale payloads and keeps the previous runtime config', () => {
    const legacy = agent({ skills: ['coding'], mcpServers: [{ name: 'pulse', slug: 'pulse', command: '', args: [], env: {}, transportType: 'stdio' }] });

    const malformed = applyEffectiveCapabilitiesToAgent(legacy, {
      catalog_version: 1,
      expires_at: '2026-07-01T00:05:00.000Z',
      skills: 'not-an-array',
      enabled_mcp_servers: ['wiki'],
    }, { now });
    expect(malformed.report.applied).toBe(false);
    expect(malformed.agent.skills).toEqual(['coding']);
    expect(malformed.agent.mcpServers.map((s) => s.slug)).toEqual(['pulse']);

    const stale = applyEffectiveCapabilitiesToAgent(legacy, {
      catalog_version: 1,
      expires_at: '2026-06-30T23:59:00.000Z',
      skills: ['new'],
      enabled_mcp_servers: ['wiki'],
    }, { now });
    expect(stale.report.applied).toBe(false);
    expect(stale.agent.skills).toEqual(['coding']);
  });

  it('verifies HMAC-signed payloads when a secret is configured', () => {
    const secret = 'test-secret';
    const payload: Record<string, unknown> = {
      catalog_version: 2,
      expires_at: '2026-07-01T00:05:00.000Z',
      capabilities: ['docs'],
      source_teams: ['documentation'],
      skills: ['google-drive-public-links'],
      enabled_mcp_servers: ['drive'],
    };
    payload.signature = signEffectiveCapabilitiesPayload(payload, secret);

    const good = applyEffectiveCapabilitiesToAgent(agent(), payload, { now, hmacSecret: secret, strictSignatures: true });
    expect(good.report.applied).toBe(true);
    expect(good.agent.effectiveCapabilities?.signatureVerified).toBe(true);

    const bad = applyEffectiveCapabilitiesToAgent(agent(), { ...payload, signature: '00'.repeat(32) }, { now, hmacSecret: secret, strictSignatures: true });
    expect(bad.report.applied).toBe(false);
    expect(bad.report.diagnostics.map((d) => d.code)).toContain('bad_signature');
  });

  it('lets bridges prefer the daemon-provided effective MCP allow-list env over role matrix fallback', () => {
    expect(parseAgentEffectiveMcpServicesFromEnv({ AGENT_EFFECTIVE_MCP_SERVICES: 'pulse,wiki,drive' } as NodeJS.ProcessEnv))
      .toEqual(['pulse', 'wiki', 'drive']);
    expect(parseAgentEffectiveMcpServicesFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
