/**
 * Hive effective-capability runtime adapter.
 *
 * Hive owns the capability catalog + TeamRoster-derived union. The daemon only
 * consumes the resolved read model, validates that it is safe to apply, and
 * materializes it into the legacy AgentInfo fields that bridges already use
 * (skills/eager skills/MCP allow-list/credential scopes/runtime flags).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  AgentCredentialScope,
  AgentInfo,
  HiveCredentialMaterialization,
  HiveOrganizationTeamMembership,
} from '../daemon/types.js';

export type EffectiveCapabilitySource = 'hive' | 'legacy';

export interface EffectiveCapabilityDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  capability?: string;
  mcpServer?: string;
}

export interface AgentEffectiveCapabilities {
  source: EffectiveCapabilitySource;
  capabilities: string[];
  skills: string[];
  eagerSkills: string[];
  mcpServers: string[];
  sourceTeams: string[];
  sourceTeamMemberships?: HiveOrganizationTeamMembership[];
  credentialGrantScopes: AgentCredentialScope[];
  credentialCustomGrantServices: string[];
  teamCredentialEligibleTeams?: string[];
  teamCredentialEligibleMemberships?: HiveOrganizationTeamMembership[];
  credentialMaterializations?: HiveCredentialMaterialization[];
  runtimeFlags: Record<string, unknown>;
  diagnostics: EffectiveCapabilityDiagnostic[];
  catalogVersion?: string | number;
  computedAt?: string;
  expiresAt?: string;
  definitionHashes?: Record<string, string>;
  sourceAttribution?: Record<string, unknown>;
  migrationAllowlistVersion?: string | number;
  signature?: string;
  signatureVerified?: boolean;
  trustedForSensitive?: boolean;
  stale?: boolean;
  appliedAt: string;
}

export interface EffectiveCapabilityApplyReport {
  applied: boolean;
  reason: string;
  diagnostics: EffectiveCapabilityDiagnostic[];
  oldFingerprint: string;
  newFingerprint: string;
  changed: boolean;
  sourceTeams: string[];
  capabilities: string[];
  mcpServers: string[];
}

type UnknownRecord = Record<string, unknown>;

const SENSITIVE_MCP_SERVERS = new Set<string>([
  // host exec / agent lifecycle / credential broker surface.
  // 'cron' was removed (PLAT-5106): it carries browser/media/scheduling tools
  // alongside remote_exec, and classifying the whole server as sensitive
  // withheld all browser MCP tools from unsigned Hive payloads. remote_exec
  // is already gated by SSH key availability at runtime.
]);

const KNOWN_CREDENTIAL_SCOPES = new Set<AgentCredentialScope>([
  'fleet-ssh',
  'kubeconfig',
  'vault-token',
  'shizuha-id',
  'github',
  'gitlab',
  'aws',
  'npm',
  'docker',
  'custom',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unique(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stringList(value: unknown, field: string, diagnostics: EffectiveCapabilityDiagnostic[]): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    diagnostics.push({ severity: 'error', code: 'invalid_list', message: `${field} must be an array` });
    return [];
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      strings.push(item);
      continue;
    }
    if (isRecord(item)) {
      const slug = item['slug'] ?? item['name'] ?? item['id'];
      if (typeof slug === 'string') {
        strings.push(slug);
        continue;
      }
    }
    diagnostics.push({ severity: 'error', code: 'invalid_list_item', message: `${field} contains a non-string/non-slug entry` });
  }
  return unique(strings);
}

function getPayloadField(payload: UnknownRecord, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(payload, name)) return payload[name];
  }
  return undefined;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeSignature(signature: unknown): string | undefined {
  if (typeof signature !== 'string') return undefined;
  const trimmed = signature.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('hmac_sha256:') ? trimmed.slice('hmac_sha256:'.length) : trimmed;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutSignature(payload: UnknownRecord): UnknownRecord {
  const copy: UnknownRecord = { ...payload };
  delete copy['signature'];
  return copy;
}

export function signEffectiveCapabilitiesPayload(payload: UnknownRecord, secret: string): string {
  return createHmac('sha256', secret).update(stableJson(withoutSignature(payload))).digest('hex');
}

export function verifyEffectiveCapabilitiesSignature(payload: UnknownRecord, secret: string): boolean {
  const provided = normalizeSignature(payload['signature']);
  if (!provided) return false;
  const expected = signEffectiveCapabilitiesPayload(payload, secret);
  const providedBuf = Buffer.from(provided, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (providedBuf.length !== expectedBuf.length || providedBuf.length === 0) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function normalizeCredentialScopes(value: unknown, diagnostics: EffectiveCapabilityDiagnostic[]): AgentCredentialScope[] {
  const raw = stringList(value, 'credentialGrantScopes', diagnostics);
  const scopes: AgentCredentialScope[] = [];
  for (const scope of raw) {
    if (KNOWN_CREDENTIAL_SCOPES.has(scope as AgentCredentialScope)) {
      scopes.push(scope as AgentCredentialScope);
      continue;
    }
    // Hive emits role-qualified scopes ("github:review", "github:merge" — the
    // PLAT-1282 review/merge grant model). The runtime provisions the base
    // credential; the qualifier is Hive-side routing metadata. Recognize
    // "<base>:<qualifier>" instead of dropping the grant — dropped grants left
    // *-agent-creds unpopulated on every Hive regen (PLAT-3998).
    const base = scope.split(':', 1)[0];
    if (base && base !== scope && KNOWN_CREDENTIAL_SCOPES.has(base as AgentCredentialScope)) {
      diagnostics.push({
        severity: 'info',
        code: 'qualified_credential_scope',
        message: `Normalized qualified credential grant scope ${scope} -> ${base}`,
      });
      scopes.push(base as AgentCredentialScope);
      continue;
    }
    diagnostics.push({ severity: 'warning', code: 'unknown_credential_scope', message: `Ignoring unknown credential grant scope: ${scope}` });
  }
  return unique(scopes) as AgentCredentialScope[];
}

function normalizeCredentialCustomGrantServices(value: unknown, diagnostics: EffectiveCapabilityDiagnostic[]): string[] {
  const raw = stringList(value, 'credentialCustomGrantServices', diagnostics);
  const services: string[] = [];
  for (const service of raw) {
    const normalized = service.trim().toLowerCase();
    if (normalized === '*' || /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(normalized)) {
      services.push(normalized);
    } else {
      diagnostics.push({
        severity: 'warning',
        code: 'invalid_custom_credential_service',
        message: `Ignoring invalid custom credential grant service: ${service}`,
      });
    }
  }
  return unique(services);
}

function normalizeCredentialMaterializations(
  value: unknown,
  diagnostics: EffectiveCapabilityDiagnostic[],
): HiveCredentialMaterialization[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 128) {
    diagnostics.push({ severity: 'error', code: 'invalid_credential_materializations', message: 'credential_materializations must be an array of at most 128 entries' });
    return [];
  }
  const normalized: HiveCredentialMaterialization[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      diagnostics.push({ severity: 'error', code: 'invalid_credential_materialization', message: `credential_materializations[${index}] must be an object` });
      continue;
    }
    const grantId = String(getPayloadField(item, 'grant_id', 'grantId') ?? '').trim();
    const scope = String(item['scope'] ?? '').trim();
    const organizationSlug = String(getPayloadField(item, 'organization_slug', 'organizationSlug') ?? '').trim().toLowerCase();
    const teamSlug = String(getPayloadField(item, 'team_slug', 'teamSlug') ?? '').trim().toLowerCase();
    const provider = String(item['provider'] ?? '').trim().toLowerCase();
    const purpose = String(item['purpose'] ?? '').trim();
    const secretRef = String(getPayloadField(item, 'secret_ref', 'secretRef') ?? '').trim();
    const isActive = getPayloadField(item, 'is_active', 'isActive');
    let handle: URL;
    try {
      handle = new URL(secretRef);
    } catch {
      diagnostics.push({ severity: 'error', code: 'invalid_credential_secret_ref', message: `credential_materializations[${index}] has an invalid secret_ref handle` });
      continue;
    }
    if (
      !grantId || !/^[a-z0-9-]{1,128}$/i.test(grantId)
      || (scope !== 'agent' && scope !== 'team')
      || (scope === 'team' && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(organizationSlug))
      || (scope === 'team' && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(teamSlug))
      || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(provider)
      || !purpose || purpose.length > 100
      || !['broker:', 'vault:', 'k8s-secret:'].includes(handle.protocol)
      || !handle.hostname
      || isActive !== true
    ) {
      diagnostics.push({ severity: 'error', code: 'invalid_credential_materialization', message: `credential_materializations[${index}] violates the active handle-only descriptor contract` });
      continue;
    }
    if (seen.has(grantId)) {
      diagnostics.push({ severity: 'error', code: 'duplicate_credential_materialization', message: `credential_materializations repeats grant ${grantId}` });
      continue;
    }
    seen.add(grantId);
    normalized.push({
      grantId,
      scope,
      ...(scope === 'team' ? { organizationSlug, teamSlug } : {}),
      provider,
      purpose,
      secretRef,
      isActive: true,
    });
  }
  return normalized.sort((a, b) => a.grantId.localeCompare(b.grantId));
}

function normalizeOrganizationTeamMemberships(
  value: unknown,
  field: string,
  diagnostics: EffectiveCapabilityDiagnostic[],
): HiveOrganizationTeamMembership[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 256) {
    diagnostics.push({ severity: 'error', code: 'invalid_organization_team_memberships', message: `${field} must be an array of at most 256 entries` });
    return [];
  }
  const normalized = new Map<string, HiveOrganizationTeamMembership>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      diagnostics.push({ severity: 'error', code: 'invalid_organization_team_membership', message: `${field}[${index}] must be an object` });
      continue;
    }
    const organizationSlug = String(getPayloadField(item, 'organization_slug', 'organizationSlug') ?? '').trim().toLowerCase();
    const teamSlug = String(getPayloadField(item, 'team_slug', 'teamSlug') ?? '').trim().toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(organizationSlug)
      || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(teamSlug)
    ) {
      diagnostics.push({ severity: 'error', code: 'invalid_organization_team_membership', message: `${field}[${index}] must contain canonical organization_slug and team_slug` });
      continue;
    }
    normalized.set(`${organizationSlug}/${teamSlug}`, { organizationSlug, teamSlug });
  }
  return [...normalized.values()].sort((a, b) =>
    `${a.organizationSlug}/${a.teamSlug}`.localeCompare(`${b.organizationSlug}/${b.teamSlug}`)
  );
}

function normalizeRuntimeFlags(value: unknown, diagnostics: EffectiveCapabilityDiagnostic[]): Record<string, unknown> {
  if (value == null) return {};
  if (!isRecord(value)) {
    diagnostics.push({ severity: 'error', code: 'invalid_runtime_flags', message: 'runtimeFlags must be an object' });
    return {};
  }
  return { ...value };
}

function normalizeDiagnostics(value: unknown): EffectiveCapabilityDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): EffectiveCapabilityDiagnostic[] => {
    if (!isRecord(item)) return [];
    const severity = item['severity'];
    const code = typeof item['code'] === 'string' ? item['code'] : 'hive_diagnostic';
    const message = typeof item['message'] === 'string' ? item['message'] : JSON.stringify(item);
    return [{
      severity: severity === 'error' || severity === 'warning' || severity === 'info' ? severity : 'info',
      code,
      message,
      ...(typeof item['capability'] === 'string' ? { capability: item['capability'] } : {}),
      ...(typeof item['mcpServer'] === 'string' ? { mcpServer: item['mcpServer'] } : {}),
      ...(typeof item['mcp_server'] === 'string' ? { mcpServer: item['mcp_server'] } : {}),
    }];
  });
}

function serverObject(slug: string): AgentInfo['mcpServers'][number] {
  return {
    name: slug,
    slug,
    command: '',
    args: [],
    env: {},
    transportType: 'stdio',
  };
}

export function effectiveCapabilitiesFingerprint(effective: AgentEffectiveCapabilities | undefined): string {
  if (!effective || effective.source !== 'hive') return 'legacy';
  return stableJson({
    capabilities: effective.capabilities,
    skills: effective.skills,
    eagerSkills: effective.eagerSkills,
    mcpServers: effective.mcpServers,
    credentialGrantScopes: effective.credentialGrantScopes,
    credentialCustomGrantServices: effective.credentialCustomGrantServices,
    teamCredentialEligibleTeams: effective.teamCredentialEligibleTeams,
    credentialMaterializations: effective.credentialMaterializations,
    runtimeFlags: effective.runtimeFlags,
    catalogVersion: effective.catalogVersion,
    definitionHashes: effective.definitionHashes,
    sourceTeams: effective.sourceTeams,
    sourceTeamMemberships: effective.sourceTeamMemberships,
    teamCredentialEligibleMemberships: effective.teamCredentialEligibleMemberships,
  });
}

export interface ApplyEffectiveCapabilitiesOptions {
  now?: Date;
  /** Require a valid HMAC signature for any Hive payload at all. Mostly for tests / future hard cutover. */
  strictSignatures?: boolean;
  /** Require a signed/trusted payload before materializing sensitive MCP or credential grant scopes. Default true. */
  requireTrustedForSensitive?: boolean;
  /** HMAC secret. Defaults to SHIZUHA_HIVE_CAPABILITY_HMAC_SECRET when present. */
  hmacSecret?: string;
  /** Allow unsigned payloads to grant sensitive effects during an explicitly audited migration. Default false. */
  trustUnsignedForSensitive?: boolean;
}

export function normalizeEffectiveCapabilitiesPayload(
  payloadValue: unknown,
  options: ApplyEffectiveCapabilitiesOptions = {},
): { effective?: AgentEffectiveCapabilities; diagnostics: EffectiveCapabilityDiagnostic[]; fatal: boolean } {
  const diagnostics: EffectiveCapabilityDiagnostic[] = [];
  if (!isRecord(payloadValue)) {
    return {
      fatal: true,
      diagnostics: [{ severity: 'error', code: 'invalid_payload', message: 'effective_capabilities payload must be an object' }],
    };
  }

  const payload = payloadValue;
  const now = options.now ?? new Date();
  const hmacSecret = options.hmacSecret ?? process.env['SHIZUHA_HIVE_CAPABILITY_HMAC_SECRET'] ?? '';
  const signature = typeof payload['signature'] === 'string' ? payload['signature'] : undefined;
  const signatureVerified = hmacSecret ? verifyEffectiveCapabilitiesSignature(payload, hmacSecret) : false;
  const hasSignature = !!normalizeSignature(signature);
  if (hmacSecret && hasSignature && !signatureVerified) {
    diagnostics.push({ severity: 'error', code: 'bad_signature', message: 'Hive effective capability signature did not verify' });
  }
  if (options.strictSignatures && !signatureVerified) {
    diagnostics.push({ severity: 'error', code: 'signature_required', message: 'Hive effective capability payload is unsigned or unverifiable' });
  }

  const computedAt = getPayloadField(payload, 'computed_at', 'computedAt');
  const expiresAt = getPayloadField(payload, 'expires_at', 'expiresAt');
  const expires = parseDate(expiresAt);
  const stale = !!(expires && expires.getTime() <= now.getTime());
  if (stale) diagnostics.push({ severity: 'error', code: 'stale_payload', message: `Hive effective capability payload expired at ${expires!.toISOString()}` });

  const capabilities = stringList(getPayloadField(payload, 'capabilities'), 'capabilities', diagnostics);
  const skills = stringList(getPayloadField(payload, 'skills'), 'skills', diagnostics);
  const eagerSkills = stringList(getPayloadField(payload, 'eagerSkills', 'eager_skills'), 'eagerSkills', diagnostics);
  const mcpServers = stringList(
    getPayloadField(payload, 'enabled_mcp_servers', 'enabledMcpServers', 'mcp_servers', 'mcpServers'),
    'enabled_mcp_servers',
    diagnostics,
  );
  const sourceTeams = stringList(getPayloadField(payload, 'source_teams', 'sourceTeams'), 'source_teams', diagnostics);
  const sourceTeamMemberships = normalizeOrganizationTeamMemberships(
    getPayloadField(payload, 'source_team_memberships', 'sourceTeamMemberships'),
    'source_team_memberships',
    diagnostics,
  );
  const credentialGrantScopes = normalizeCredentialScopes(
    getPayloadField(payload, 'credentialGrantScopes', 'credential_grant_scopes'),
    diagnostics,
  );
  const credentialCustomGrantServices = normalizeCredentialCustomGrantServices(
    getPayloadField(payload, 'credentialCustomGrantServices', 'credential_custom_grant_services', 'customCredentialGrantServices', 'custom_credential_grant_services'),
    diagnostics,
  );
  const teamCredentialEligibleTeams = stringList(
    getPayloadField(payload, 'teamCredentialEligibleTeams', 'team_credential_eligible_teams'),
    'team_credential_eligible_teams',
    diagnostics,
  ).map((team) => team.trim().toLowerCase());
  const teamCredentialEligibleMemberships = normalizeOrganizationTeamMemberships(
    getPayloadField(payload, 'teamCredentialEligibleMemberships', 'team_credential_eligible_memberships'),
    'team_credential_eligible_memberships',
    diagnostics,
  );
  let credentialMaterializations = normalizeCredentialMaterializations(
    getPayloadField(payload, 'credentialMaterializations', 'credential_materializations'),
    diagnostics,
  );
  const sourceMembershipSet = new Set(sourceTeamMemberships.map((row) => `${row.organizationSlug}/${row.teamSlug}`));
  const eligibleMembershipSet = new Set(teamCredentialEligibleMemberships.map((row) => `${row.organizationSlug}/${row.teamSlug}`));
  const unauthorizedTeamMaterializations = credentialMaterializations.filter((descriptor) =>
    descriptor.scope === 'team'
    && (
      !descriptor.organizationSlug
      || !descriptor.teamSlug
      || !sourceMembershipSet.has(`${descriptor.organizationSlug}/${descriptor.teamSlug}`)
      || !eligibleMembershipSet.has(`${descriptor.organizationSlug}/${descriptor.teamSlug}`)
    )
  );
  if (unauthorizedTeamMaterializations.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'withheld_ineligible_team_credential_materializations',
      message: 'Withheld team credential materializations without both current organization-qualified membership and explicit seat eligibility',
    });
    credentialMaterializations = credentialMaterializations.filter((descriptor) =>
      descriptor.scope !== 'team'
      || (
        !!descriptor.organizationSlug
        && !!descriptor.teamSlug
        && sourceMembershipSet.has(`${descriptor.organizationSlug}/${descriptor.teamSlug}`)
        && eligibleMembershipSet.has(`${descriptor.organizationSlug}/${descriptor.teamSlug}`)
      )
    );
  }
  const runtimeFlags = normalizeRuntimeFlags(getPayloadField(payload, 'runtimeFlags', 'runtime_flags'), diagnostics);
  diagnostics.push(...normalizeDiagnostics(getPayloadField(payload, 'diagnostics')));

  const sourceAttribution = getPayloadField(payload, 'sourceAttribution', 'source_attribution');
  const definitionHashes = getPayloadField(payload, 'definitionHashes', 'definition_hashes');
  const migrationAllowlistVersion = getPayloadField(payload, 'migrationAllowlistVersion', 'migration_allowlist_version');
  const catalogVersion = getPayloadField(payload, 'catalogVersion', 'catalog_version');

  const sourceAttributionRecord = isRecord(sourceAttribution) ? sourceAttribution : undefined;
  const definitionHashesRecord = isRecord(definitionHashes)
    ? Object.fromEntries(Object.entries(definitionHashes).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    : undefined;

  const trustUnsignedForSensitive = options.trustUnsignedForSensitive
    ?? process.env['SHIZUHA_HIVE_CAPABILITIES_TRUST_UNSIGNED'] === '1';
  const trustedForSensitive = signatureVerified || trustUnsignedForSensitive;
  const requireTrustedForSensitive = options.requireTrustedForSensitive ?? true;

  let finalMcpServers = mcpServers;
  let finalCredentialGrantScopes = credentialGrantScopes;
  let finalCredentialCustomGrantServices = credentialCustomGrantServices;
  let finalTeamCredentialEligibleTeams = teamCredentialEligibleTeams;
  let finalTeamCredentialEligibleMemberships = teamCredentialEligibleMemberships;
  let finalCredentialMaterializations = credentialMaterializations;
  if (requireTrustedForSensitive && !trustedForSensitive) {
    const safeServers = finalMcpServers.filter((server) => !SENSITIVE_MCP_SERVERS.has(server));
    const withheld = finalMcpServers.filter((server) => SENSITIVE_MCP_SERVERS.has(server));
    if (withheld.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'withheld_sensitive_mcp_unsigned',
        message: `Withheld sensitive MCP server(s) from unsigned/untrusted Hive payload: ${withheld.join(', ')}`,
      });
    }
    finalMcpServers = safeServers;
    if (finalCredentialGrantScopes.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'withheld_credential_scopes_unsigned',
        message: `Withheld credential grant scope(s) from unsigned/untrusted Hive payload: ${finalCredentialGrantScopes.join(', ')}`,
      });
      finalCredentialGrantScopes = [];
    }
    if (finalCredentialCustomGrantServices.length > 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'withheld_custom_credential_services_unsigned',
        message: `Withheld custom credential grant service(s) from unsigned/untrusted Hive payload: ${finalCredentialCustomGrantServices.join(', ')}`,
      });
      finalCredentialCustomGrantServices = [];
    }
    if (
      finalCredentialMaterializations.length > 0
      || finalTeamCredentialEligibleTeams.length > 0
      || finalTeamCredentialEligibleMemberships.length > 0
    ) {
      diagnostics.push({
        severity: 'warning',
        code: 'withheld_credential_materializations_unsigned',
        message: 'Withheld Hive credential materializations from an unsigned/untrusted payload',
      });
      finalCredentialMaterializations = [];
      finalTeamCredentialEligibleTeams = [];
      finalTeamCredentialEligibleMemberships = [];
    }
  }

  const fatal = diagnostics.some((d) => d.severity === 'error') || stale;
  if (fatal) return { fatal, diagnostics };

  return {
    fatal: false,
    diagnostics,
    effective: {
      source: 'hive',
      capabilities,
      skills,
      eagerSkills,
      mcpServers: finalMcpServers,
      sourceTeams,
      sourceTeamMemberships,
      credentialGrantScopes: finalCredentialGrantScopes,
      credentialCustomGrantServices: finalCredentialCustomGrantServices,
      teamCredentialEligibleTeams: finalTeamCredentialEligibleTeams,
      teamCredentialEligibleMemberships: finalTeamCredentialEligibleMemberships,
      credentialMaterializations: finalCredentialMaterializations,
      runtimeFlags,
      diagnostics,
      ...(typeof catalogVersion === 'string' || typeof catalogVersion === 'number' ? { catalogVersion } : {}),
      ...(typeof computedAt === 'string' ? { computedAt } : {}),
      ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
      ...(definitionHashesRecord ? { definitionHashes: definitionHashesRecord } : {}),
      ...(sourceAttributionRecord ? { sourceAttribution: sourceAttributionRecord } : {}),
      ...(typeof migrationAllowlistVersion === 'string' || typeof migrationAllowlistVersion === 'number' ? { migrationAllowlistVersion } : {}),
      ...(signature ? { signature } : {}),
      signatureVerified,
      trustedForSensitive,
      stale,
      appliedAt: now.toISOString(),
    },
  };
}

export function applyEffectiveCapabilitiesToAgent(
  agent: AgentInfo,
  payloadValue: unknown,
  options: ApplyEffectiveCapabilitiesOptions = {},
): { agent: AgentInfo; report: EffectiveCapabilityApplyReport } {
  const oldFingerprint = effectiveCapabilitiesFingerprint(agent.effectiveCapabilities);
  const normalized = normalizeEffectiveCapabilitiesPayload(payloadValue, options);
  if (!normalized.effective || normalized.fatal) {
    const newFingerprint = oldFingerprint;
    return {
      agent,
      report: {
        applied: false,
        reason: normalized.diagnostics.map((d) => d.code).join(',') || 'invalid_payload',
        diagnostics: normalized.diagnostics,
        oldFingerprint,
        newFingerprint,
        changed: false,
        sourceTeams: [],
        capabilities: [],
        mcpServers: [],
      },
    };
  }

  const effective = normalized.effective;
  const next: AgentInfo = {
    ...agent,
    // Hive read-model is authoritative for governed runtime effects whenever it is valid.
    skills: effective.skills,
    eagerSkills: effective.eagerSkills,
    mcpServers: effective.mcpServers.map(serverObject),
    credentialGrantScopes: effective.credentialGrantScopes,
    credentialCustomGrantServices: effective.credentialCustomGrantServices,
    effectiveCapabilities: effective,
  };

  const newFingerprint = effectiveCapabilitiesFingerprint(next.effectiveCapabilities);
  return {
    agent: next,
    report: {
      applied: true,
      reason: 'applied_hive_effective_capabilities',
      diagnostics: normalized.diagnostics,
      oldFingerprint,
      newFingerprint,
      changed: oldFingerprint !== newFingerprint,
      sourceTeams: effective.sourceTeams,
      capabilities: effective.capabilities,
      mcpServers: effective.mcpServers,
    },
  };
}

export function agentEffectiveCapabilityEnv(agent: AgentInfo): Record<string, string> {
  const effective = agent.effectiveCapabilities;
  if (!effective || effective.source !== 'hive') return {};
  const env: Record<string, string> = {
    AGENT_EFFECTIVE_CAPABILITIES: effective.capabilities.join(','),
    AGENT_EFFECTIVE_CAPABILITY_SOURCE_TEAMS: effective.sourceTeams.join(','),
    AGENT_EFFECTIVE_MCP_SERVICES: effective.mcpServers.join(','),
    AGENT_EFFECTIVE_CAPABILITY_DIAGNOSTICS: JSON.stringify(effective.diagnostics),
  };
  if (Object.keys(effective.runtimeFlags).length > 0) {
    env['AGENT_EFFECTIVE_RUNTIME_FLAGS'] = JSON.stringify(effective.runtimeFlags);
  }
  if (effective.catalogVersion !== undefined) env['AGENT_EFFECTIVE_CAPABILITY_CATALOG_VERSION'] = String(effective.catalogVersion);
  // PLAT-5531: appliedAt is a Hive refresh timestamp that changes every cycle.
  // Rendering it into the pod template env creates perpetual config-drift churn
  // because the semantic hash (computeAgentMcpConfigHash) intentionally excludes
  // volatile timestamps — the pod template changes but the hash doesn't, so the
  // daemon Recreates on every reconcile. appliedAt is diagnostic telemetry only;
  // it belongs in diagnostics JSON, not in pod env. Exclude it here.
  // if (effective.appliedAt) env['AGENT_EFFECTIVE_CAPABILITY_APPLIED_AT'] = effective.appliedAt;
  return env;
}

export function parseAgentEffectiveMcpServicesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env['AGENT_EFFECTIVE_MCP_SERVICES'];
  if (raw == null) return null;
  return unique(raw.split(',').map((s) => s.trim()));
}

export function summarizeEffectiveCapabilities(effective: AgentEffectiveCapabilities | undefined): string {
  if (!effective || effective.source !== 'hive') return 'legacy fallback';
  const teams = effective.sourceTeams.length ? effective.sourceTeams.join(',') : 'none';
  const caps = effective.capabilities.length ? effective.capabilities.join(',') : 'none';
  const mcp = effective.mcpServers.length ? effective.mcpServers.join(',') : 'none';
  const diag = effective.diagnostics.filter((d) => d.severity !== 'info').map((d) => `${d.code}:${d.message}`).join('; ') || 'none';
  return `hive catalog=${effective.catalogVersion ?? 'unknown'} teams=${teams} capabilities=${caps} mcp=${mcp} diagnostics=${diag}`;
}
