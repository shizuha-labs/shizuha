import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentInfo, AgentCredential, AgentCredentialAuditRole, AgentCredentialScope } from './types.js';

export const AGENT_CREDENTIAL_SCOPES = [
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
] as const satisfies readonly AgentCredentialScope[];

export const AGENT_CREDENTIAL_RESERVED_SCOPE = 'reserved' as const;

export const AGENT_CREDENTIAL_AUDIT_ROLES = [
  'metadata-audit',
  'security-lead',
] as const satisfies readonly AgentCredentialAuditRole[];

interface TrustedCredentialSeedIdentity {
  email: string;
  platformUserId: number;
}

const PLATFORM_GRANT_AGENT_IDENTITIES = new Map<string, TrustedCredentialSeedIdentity>([
  ['kai', { email: 'kai@shizuha.com', platformUserId: 13 }],
  ['ryo', { email: 'ryo@shizuha.com', platformUserId: 14 }],
  ['ichi', { email: 'ichi@shizuha.com', platformUserId: 88 }],
  ['ni', { email: 'ni@shizuha.com', platformUserId: 89 }],
]);
const SECURITY_METADATA_AUDIT_AGENT_IDENTITIES = new Map<string, TrustedCredentialSeedIdentity>([
  ['akira', { email: 'akira@shizuha.com', platformUserId: 17 }],
  ['ren', { email: 'ren@shizuha.com', platformUserId: 18 }],
]);
const ADR_BOOTSTRAP_GRANT_SCOPES = ['fleet-ssh', 'kubeconfig'] as const satisfies readonly AgentCredentialScope[];
const SECURITY_METADATA_AUDIT_ROLES = ['metadata-audit'] as const satisfies readonly AgentCredentialAuditRole[];
export const AGENT_CREDENTIAL_PERMISSION_SEED_VERSION = 'adr-plat-001-s10';

const ALLOWED_SCOPE_SET = new Set<string>(AGENT_CREDENTIAL_SCOPES);
const ALLOWED_AUDIT_ROLE_SET = new Set<string>(AGENT_CREDENTIAL_AUDIT_ROLES);

/** SQL fragment for stores that persist AgentCredential rows. */
export const AGENT_CREDENTIAL_SCOPE_CHECK_SQL =
  `scope IN (${AGENT_CREDENTIAL_SCOPES.map((s) => `'${s}'`).join(', ')}) AND scope <> '${AGENT_CREDENTIAL_RESERVED_SCOPE}'`;

export const DOGFOOD_PHOENIX_FLEET_SSH_USERNAMES = ['kai', 'ichi', 'ni'] as const;

const DOGFOOD_PHOENIX_FLEET_SSH_USERNAME_SET = new Set<string>(DOGFOOD_PHOENIX_FLEET_SSH_USERNAMES);
const DOGFOOD_PHOENIX_MIGRATION_TASK = 'PLAT-111';

interface FleetSshCredentialGrantOptions {
  credentialData?: Record<string, string>;
}

export function isAgentCredentialScope(value: unknown): value is AgentCredentialScope {
  return typeof value === 'string' && ALLOWED_SCOPE_SET.has(value);
}

export function assertAgentCredentialScope(value: unknown): AgentCredentialScope {
  if (value === AGENT_CREDENTIAL_RESERVED_SCOPE) {
    throw new Error('AgentCredential scope "reserved" is a sentinel and cannot be instantiated');
  }
  if (!isAgentCredentialScope(value)) {
    throw new Error(`Unknown AgentCredential scope: ${String(value)}`);
  }
  return value;
}

export function assertAgentCredentialAuditRole(value: unknown): AgentCredentialAuditRole {
  if (!ALLOWED_AUDIT_ROLE_SET.has(String(value))) {
    throw new Error(`Unknown AgentCredential audit role: ${String(value)}`);
  }
  return value as AgentCredentialAuditRole;
}

function stableGrantId(agentId: string, scope: AgentCredentialScope, label: string): string {
  const hash = crypto.createHash('sha1')
    .update(`agent-credential:${agentId}:${scope}:${label}`)
    .digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '5' + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-');
}

function deriveGrantorId(agent: AgentInfo): string {
  return agent.email || agent.username || agent.id;
}

function isDogfoodPhoenixFleetSshAgent(agent: AgentInfo): boolean {
  return DOGFOOD_PHOENIX_FLEET_SSH_USERNAME_SET.has(agent.username.toLowerCase());
}

function isPhoenixFleetSshMountData(data: { sshDir?: string; remoteUser?: string } | undefined): boolean {
  return data?.sshDir === '/home/phoenix/.ssh' && data?.remoteUser === 'phoenix';
}

function dogfoodPhoenixCredentialData(agent: AgentInfo, migratedAt: string): Record<string, string> {
  return {
    auditMigrationTask: DOGFOOD_PHOENIX_MIGRATION_TASK,
    auditMigrationKind: 'record-only-dogfood',
    auditMigrationSubject: 'phoenix-mounted-fleet-ssh',
    auditMigrationAgent: agent.username,
    auditMigratedAt: migratedAt,
    auditMigrationNote: 'Retro-migrated existing phoenix-mounted fleet SSH grant; no key material issued, rotated, logged, or copied.',
  };
}

function preserveLegacyCustomServiceLabel(label: string, legacyService: string | undefined): string {
  if (!legacyService || isAgentCredentialScope(legacyService)) return label;
  if (label === legacyService || label.endsWith(`(${legacyService})`)) return label;
  return `${label} (${legacyService})`;
}

function normalizeCredentialScope(credential: AgentCredential): AgentCredentialScope {
  const legacyService = (credential as unknown as { service?: unknown }).service;
  if (credential.scope !== undefined) {
    return assertAgentCredentialScope(credential.scope);
  }
  if (legacyService === AGENT_CREDENTIAL_RESERVED_SCOPE) {
    return assertAgentCredentialScope(legacyService);
  }
  if (typeof legacyService === 'string' && !isAgentCredentialScope(legacyService)) {
    return 'custom';
  }
  return assertAgentCredentialScope(legacyService);
}

export function normalizeAgentCredential(credential: AgentCredential, agent: AgentInfo): AgentCredential {
  const legacyService = (credential as unknown as { service?: unknown }).service;
  const scope = normalizeCredentialScope(credential);
  const label = preserveLegacyCustomServiceLabel(credential.label, typeof legacyService === 'string' ? legacyService : undefined);
  const grantId = credential.grantId ?? credential.id ?? stableGrantId(agent.id, scope, label);
  return {
    ...credential,
    id: grantId,
    grantId,
    grantorId: credential.grantorId ?? deriveGrantorId(agent),
    scope,
    service: scope,
    label,
    expiresAt: credential.expiresAt ?? null,
  };
}

export function isAgentCredentialGrantCurrentlyActive(
  credential: Pick<AgentCredential, 'isActive' | 'expiresAt'>,
  now = Date.now(),
): boolean {
  if (!credential.isActive) return false;
  if (credential.expiresAt == null || credential.expiresAt === '') return true;
  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function createFleetSshCredentialGrant(
  agent: AgentInfo,
  options: FleetSshCredentialGrantOptions = {},
): AgentCredential | null {
  if (!agent.sshKeys?.enabled) return null;
  const scope: AgentCredentialScope = 'fleet-ssh';
  const label = 'Fleet SSH key mount grant';
  const grantId = stableGrantId(agent.id, scope, label);
  return {
    id: grantId,
    grantId,
    grantorId: deriveGrantorId(agent),
    scope,
    service: scope,
    label,
    credentialData: {
      sshDir: agent.sshKeys.sshDir ?? '~/.ssh',
      keyFiles: JSON.stringify(agent.sshKeys.keyFiles ?? []),
      remoteUser: agent.sshKeys.remoteUser ?? '',
      ...(options.credentialData ?? {}),
    },
    injectAsEnv: false,
    isActive: true,
    expiresAt: null,
  };
}

/**
 * Skill that marks an agent as "host-plane": it needs SSH+sudo to the cluster
 * nodes to do its job (DevOps). Host-plane agents must ALWAYS receive a fleet-ssh
 * grant so their key mount is applied on every container create.
 */
const HOST_PLANE_SKILL = 'devops';

export function isHostPlaneAgent(agent: AgentInfo): boolean {
  return (agent.skills ?? []).includes(HOST_PLANE_SKILL);
}

/**
 * The canonical fleet-ssh source for a host-plane agent: the per-agent store,
 * which is bind-mounted into the rt-fleet daemon pod (hostPath ~/.shizuha) and
 * therefore visible + persistent across fleet rolls. Always used for host-plane
 * grants so the key mount never depends on the invisible-in-pod legacy ~/.ssh.
 */
export function hostPlaneFleetSshSourceDir(agent: AgentInfo): string {
  return `~/.shizuha/ssh-keys/${agent.username}`;
}

/**
 * PLAT-194: derive a fleet-ssh grant for a host-plane agent purely from ROLE,
 * independent of the legacy `sshKeys.enabled` flag. A codex->Claude fleet roll
 * dropped `sshKeys.enabled` (and any persisted grant) for ichi, so the normal
 * grant chain resolved null and the SSH mount was silently skipped -> keyless
 * (PLAT-177). This grant sources from the per-agent store
 * `~/.shizuha/ssh-keys/<agent>`, which IS mounted into the rt-fleet daemon pod
 * and persists across rolls (the staging path also self-heals to it). It is
 * idempotent: the grantId is stable, so it coexists with / dedupes against a
 * real legacy-sshKeys grant if one later appears.
 */
export function createHostPlaneFleetSshCredentialGrant(agent: AgentInfo): AgentCredential {
  const scope: AgentCredentialScope = 'fleet-ssh';
  const label = 'Fleet SSH key mount grant';
  const grantId = stableGrantId(agent.id, scope, label);
  return {
    id: grantId,
    grantId,
    grantorId: deriveGrantorId(agent),
    scope,
    service: scope,
    label,
    credentialData: {
      sshDir: hostPlaneFleetSshSourceDir(agent),
      keyFiles: JSON.stringify(agent.sshKeys?.keyFiles ?? []),
      remoteUser: agent.sshKeys?.remoteUser ?? '',
    },
    injectAsEnv: false,
    isActive: true,
    expiresAt: null,
  };
}

export interface AgentCredentialMigrationResult {
  agents: AgentInfo[];
  insertedFleetSshGrants: number;
  dogfoodPhoenixFleetSshGrants: number;
  normalizedCredentials: number;
  refusedCredentials: number;
  seededGrantPermissions: number;
  seededAuditRoles: number;
  seededPermissionBaselines: number;
}

export interface AgentCredentialMigrationOptions {
  /** Platform-verified Shizuha ID agent identities, keyed by local agent record id. */
  trustedPlatformIdentities?: ReadonlyMap<string, TrustedCredentialSeedIdentity & { username: string }>;
  /**
   * True only after an authenticated platform identity source was successfully
   * consulted. Without this, trusted username/email candidates are left
   * untouched so startup normalization cannot destructively strip already
   * approved bootstrap grants during the pre-verification migration pass.
   */
  trustedPlatformIdentitiesAuthoritative?: boolean;
  migratedAt?: string;
}

export interface AgentCredentialReadRefusal {
  credentialId: string;
  scope: unknown;
  reason: string;
}

export interface ActiveAgentCredentialRead {
  credentials: AgentCredential[];
  refusals: AgentCredentialReadRefusal[];
}

export interface FleetSshCredentialGrant {
  grantId: string;
  sshDir?: string;
  keyFiles?: string[];
  remoteUser?: string;
}

export interface FleetSshCredentialRead {
  grant: FleetSshCredentialGrant | null;
  refusals: AgentCredentialReadRefusal[];
}

function credentialIdForReadRefusal(credential: AgentCredential): string {
  return credential.grantId ?? credential.id ?? '<unknown>';
}

function scopeForReadRefusal(credential: AgentCredential): unknown {
  return credential.scope ?? (credential as unknown as { service?: unknown }).service;
}

function parseCredentialKeyFiles(value: unknown): { keyFiles?: string[]; error?: string } {
  if (value == null || value === '') return {};

  const validateArray = (candidate: unknown): { keyFiles?: string[]; error?: string } => {
    if (!Array.isArray(candidate)) {
      return { error: 'fleet-ssh credentialData.keyFiles must be an array of file names when present' };
    }
    if (!candidate.every((entry) => typeof entry === 'string' && entry.length > 0)) {
      return { error: 'fleet-ssh credentialData.keyFiles contains non-string or empty entries' };
    }
    return { keyFiles: candidate };
  };

  if (Array.isArray(value)) {
    return validateArray(value);
  }
  if (typeof value !== 'string') {
    return { error: 'fleet-ssh credentialData.keyFiles must be a JSON array string or string array when present' };
  }
  try {
    const parsed = JSON.parse(value);
    return validateArray(parsed);
  } catch {
    return { error: 'fleet-ssh credentialData.keyFiles is not valid JSON' };
  }
}

/**
 * Read active AgentCredential grants with read-side scope validation.
 *
 * This is intentionally separate from the one-shot migration: daemon grant
 * staging must re-validate persisted scopes on every read so a corrupted,
 * reserved, or future/unknown scope cannot silently fall through into a
 * derivation path.
 */
export function readActiveAgentCredentialGrants(agent: AgentInfo): ActiveAgentCredentialRead {
  const credentials: AgentCredential[] = [];
  const refusals: AgentCredentialReadRefusal[] = [];

  for (const credential of agent.credentials ?? []) {
    let normalized: AgentCredential;
    try {
      normalized = normalizeAgentCredential(credential, agent);
    } catch (err) {
      refusals.push({
        credentialId: credentialIdForReadRefusal(credential),
        scope: scopeForReadRefusal(credential),
        reason: (err as Error).message,
      });
      continue;
    }
    if (isAgentCredentialGrantCurrentlyActive(normalized)) credentials.push(normalized);
  }

  return { credentials, refusals };
}

export function resolveFleetSshCredentialGrant(agent: AgentInfo): FleetSshCredentialRead {
  const { credentials, refusals } = readActiveAgentCredentialGrants(agent);
  const credential = credentials.find((candidate) => candidate.scope === 'fleet-ssh');
  // Fail closed for the whole staging read: a corrupted/reserved/future scope
  // anywhere in this agent's credential set means the daemon cannot prove the
  // grant set is safe to derive from, so it must not stage even a valid-looking
  // fleet-ssh grant from the same read.
  if (refusals.length > 0) return { grant: null, refusals };
  if (!credential) return { grant: null, refusals };

  const keyFileParse = parseCredentialKeyFiles(credential.credentialData.keyFiles);
  if (keyFileParse.error) {
    return {
      grant: null,
      refusals: [{
        credentialId: credential.grantId ?? credential.id,
        scope: credential.scope,
        reason: keyFileParse.error,
      }],
    };
  }

  return {
    grant: {
      grantId: credential.grantId ?? credential.id,
      sshDir: credential.credentialData.sshDir || undefined,
      keyFiles: keyFileParse.keyFiles,
      remoteUser: credential.credentialData.remoteUser || undefined,
    },
    refusals,
  };
}

function isFleetSshCredentialLike(credential: AgentCredential): boolean {
  const rawScope = credential.scope ?? (credential as unknown as { service?: unknown }).service;
  return rawScope === 'fleet-ssh';
}

/**
 * Bridge the legacy runtime `ssh_keys` update surface into the new
 * AgentCredential source of truth.
 *
 * The daemon no longer stages directly from `agent.sshKeys`. This helper is
 * used only at legacy config mutation/enable boundaries to materialize (or
 * remove) the corresponding fleet-ssh grant before the normal read-side
 * validation/staging path runs.
 */
export function reconcileFleetSshCredentialGrantFromLegacySshKeys(
  agent: AgentInfo,
  sshKeys: AgentInfo['sshKeys'],
): AgentCredential[] | undefined {
  const retainedCredentials = (agent.credentials ?? []).filter((credential) => !isFleetSshCredentialLike(credential));
  const fleetGrant = createFleetSshCredentialGrant({ ...agent, sshKeys });
  const reconciled = fleetGrant ? [...retainedCredentials, fleetGrant] : retainedCredentials;
  return reconciled.length > 0 ? reconciled : undefined;
}

export function materializeMissingFleetSshCredentialGrantFromLegacySshKeys(agent: AgentInfo): AgentCredential[] | undefined {
  const credentials = agent.credentials ?? [];
  const hostPlane = isHostPlaneAgent(agent);
  // Only an ACTIVE fleet-ssh grant counts as "existing". Never resurrect an
  // inactive/revoked/expired one — the daemon read path intentionally filters
  // those, and reviving it here would silently undo a security revocation.
  const activeFleetSsh = credentials.find(
    (c) => isFleetSshCredentialLike(c) && isAgentCredentialGrantCurrentlyActive(c),
  );

  if (activeFleetSsh) {
    // PLAT-194: a host-plane grant MUST source from the mounted per-agent store
    // (a pre-roll ~/.ssh source is invisible inside the rt-fleet pod, which would
    // start the agent keyless). Re-point by changing ONLY sshDir — preserve the
    // grant's keyFiles/remoteUser/isActive/expiresAt/grantId so a custom key list
    // or remote user (and the active/expiry state) survives the migration.
    if (hostPlane && activeFleetSsh.credentialData.sshDir !== hostPlaneFleetSshSourceDir(agent)) {
      // Re-point IN PLACE - preserve array order/position. resolveFleetSshCredentialGrant
      // selects the FIRST active fleet-ssh grant, so the re-pointed grant must stay where
      // the selected one was; appending it would let a broker-appended sibling grant win
      // the resolve and stage from the wrong source. Other fleet-ssh creds are preserved.
      const repointed: AgentCredential = {
        ...activeFleetSsh,
        credentialData: {
          ...activeFleetSsh.credentialData,
          sshDir: hostPlaneFleetSshSourceDir(agent),
        },
      };
      return credentials.map((c) => (c === activeFleetSsh ? repointed : c));
    }
    return agent.credentials; // already has a usable, correctly-sourced grant (idempotent)
  }

  // A fleet-ssh grant exists but is inactive/revoked/expired -> respect that state;
  // do NOT materialize a replacement (the read path skips it -> host-plane fail-loud).
  if (credentials.some(isFleetSshCredentialLike)) return agent.credentials;

  // No fleet-ssh grant at all. Host-plane (DevOps) agents get a store-sourced grant
  // by ROLE FIRST — before the legacy ~/.ssh bridge — so even the very first start
  // (e.g. enabled-from-disabled with sshKeys.enabled) uses the mounted source, not
  // the invisible-in-pod ~/.ssh.
  if (hostPlane) {
    return [...credentials, createHostPlaneFleetSshCredentialGrant(agent)];
  }
  // Legacy bridge: materialize from `sshKeys` when the operator enabled it.
  if (agent.sshKeys?.enabled) {
    return reconcileFleetSshCredentialGrantFromLegacySshKeys(agent, agent.sshKeys);
  }
  return agent.credentials;
}

export function shouldPersistAgentCredentialMigration(result: AgentCredentialMigrationResult): boolean {
  return result.insertedFleetSshGrants > 0 ||
    result.dogfoodPhoenixFleetSshGrants > 0 ||
    result.normalizedCredentials > 0 ||
    result.refusedCredentials > 0 ||
    result.seededGrantPermissions > 0 ||
    result.seededAuditRoles > 0 ||
    result.seededPermissionBaselines > 0;
}

function sameStringSet(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  if ((actual ?? []).length !== expected.length) return false;
  const actualSet = new Set(actual ?? []);
  return expected.every((value) => actualSet.has(value));
}

function breakGlassAuditRoles(agent: AgentInfo): AgentCredentialAuditRole[] {
  return (agent.credentialAuditRoles ?? []).filter((role) => role === 'security-lead');
}

function seedManagedAuditRoles(agent: AgentInfo): AgentCredentialAuditRole[] {
  return (agent.credentialAuditRoles ?? []).filter((role) => role !== 'security-lead');
}

function matchesTrustedAgentIdentity(
  agent: AgentInfo,
  trustedIdentities: ReadonlyMap<string, TrustedCredentialSeedIdentity>,
  options: AgentCredentialMigrationOptions,
): boolean {
  const trusted = trustedIdentities.get(agent.username);
  const verified = options.trustedPlatformIdentities?.get(agent.id);
  return trusted?.email === agent.email &&
    trusted.platformUserId === verified?.platformUserId &&
    trusted.email === verified.email &&
    agent.username === verified.username;
}

function isUnverifiedTrustedSeedCandidate(agent: AgentInfo, options: AgentCredentialMigrationOptions): boolean {
  if (options.trustedPlatformIdentitiesAuthoritative !== true) return false;
  const trusted = PLATFORM_GRANT_AGENT_IDENTITIES.get(agent.username) ?? SECURITY_METADATA_AUDIT_AGENT_IDENTITIES.get(agent.username);
  const verified = options.trustedPlatformIdentities?.get(agent.id);
  return trusted?.email === agent.email &&
    (
      trusted.platformUserId !== verified?.platformUserId ||
      trusted.email !== verified.email ||
      agent.username !== verified.username
    );
}

function isTrustedSeedCandidate(agent: AgentInfo): boolean {
  return (
    PLATFORM_GRANT_AGENT_IDENTITIES.get(agent.username) ??
    SECURITY_METADATA_AUDIT_AGENT_IDENTITIES.get(agent.username)
  )?.email === agent.email;
}

function hasValidNonAuthoritativeSeedBaseline(agent: AgentInfo): boolean {
  if (agent.credentialPermissionSeedVersion !== AGENT_CREDENTIAL_PERMISSION_SEED_VERSION) return false;
  const grantScopes = agent.credentialGrantScopes ?? [];
  const auditRoles = seedManagedAuditRoles(agent);
  if (PLATFORM_GRANT_AGENT_IDENTITIES.get(agent.username)?.email === agent.email) {
    return sameStringSet(grantScopes, ADR_BOOTSTRAP_GRANT_SCOPES) && auditRoles.length === 0;
  }
  if (SECURITY_METADATA_AUDIT_AGENT_IDENTITIES.get(agent.username)?.email === agent.email) {
    return grantScopes.length === 0 && sameStringSet(auditRoles, SECURITY_METADATA_AUDIT_ROLES);
  }
  return false;
}

function isPlatformGrantAgent(agent: AgentInfo, options: AgentCredentialMigrationOptions): boolean {
  return matchesTrustedAgentIdentity(agent, PLATFORM_GRANT_AGENT_IDENTITIES, options);
}

function isSecurityMetadataAuditAgent(agent: AgentInfo, options: AgentCredentialMigrationOptions): boolean {
  return matchesTrustedAgentIdentity(agent, SECURITY_METADATA_AUDIT_AGENT_IDENTITIES, options);
}

function seedAgentCredentialPermissionRoles(agent: AgentInfo, options: AgentCredentialMigrationOptions): {
  agent: AgentInfo;
  seededGrantPermissions: number;
  seededAuditRoles: number;
  seededPermissionBaselines: number;
} {
  if (
    isTrustedSeedCandidate(agent) &&
    !isPlatformGrantAgent(agent, options) &&
    !isSecurityMetadataAuditAgent(agent, options) &&
    options.trustedPlatformIdentitiesAuthoritative !== true
  ) {
    if (hasValidNonAuthoritativeSeedBaseline(agent)) {
      return { agent, seededGrantPermissions: 0, seededAuditRoles: 0, seededPermissionBaselines: 0 };
    }
    const hadGrantScopes = (agent.credentialGrantScopes ?? []).length > 0;
    const retainedBreakGlassAuditRoles = agent.credentialPermissionSeedVersion === AGENT_CREDENTIAL_PERMISSION_SEED_VERSION
      ? breakGlassAuditRoles(agent)
      : [];
    const hadAuditRoles = seedManagedAuditRoles(agent).length > 0 ||
      ((agent.credentialAuditRoles ?? []).length > retainedBreakGlassAuditRoles.length);
    const hadSeedVersion = agent.credentialPermissionSeedVersion !== undefined;
    if (!hadGrantScopes && !hadAuditRoles && !hadSeedVersion) {
      return { agent, seededGrantPermissions: 0, seededAuditRoles: 0, seededPermissionBaselines: 0 };
    }
    return {
      agent: {
        ...agent,
        credentialGrantScopes: undefined,
        credentialAuditRoles: retainedBreakGlassAuditRoles.length > 0 ? retainedBreakGlassAuditRoles : undefined,
        credentialPermissionSeedVersion: undefined,
      },
      seededGrantPermissions: hadGrantScopes ? 1 : 0,
      seededAuditRoles: hadAuditRoles ? 1 : 0,
      seededPermissionBaselines: hadSeedVersion ? 1 : 0,
    };
  }

  if (isUnverifiedTrustedSeedCandidate(agent, options)) {
    const hadGrantScopes = (agent.credentialGrantScopes ?? []).length > 0;
    const retainedBreakGlassAuditRoles = agent.credentialPermissionSeedVersion === AGENT_CREDENTIAL_PERMISSION_SEED_VERSION
      ? breakGlassAuditRoles(agent)
      : [];
    const hadAuditRoles = seedManagedAuditRoles(agent).length > 0 ||
      ((agent.credentialAuditRoles ?? []).length > retainedBreakGlassAuditRoles.length);
    const hadSeedVersion = agent.credentialPermissionSeedVersion !== undefined;
    return {
      agent: {
        ...agent,
        credentialGrantScopes: undefined,
        credentialAuditRoles: retainedBreakGlassAuditRoles.length > 0 ? retainedBreakGlassAuditRoles : undefined,
        credentialPermissionSeedVersion: undefined,
      },
      seededGrantPermissions: hadGrantScopes ? 1 : 0,
      seededAuditRoles: hadAuditRoles ? 1 : 0,
      seededPermissionBaselines: hadSeedVersion ? 1 : 0,
    };
  }

  if (isPlatformGrantAgent(agent, options)) {
    const retainedBreakGlassAuditRoles = agent.credentialPermissionSeedVersion === AGENT_CREDENTIAL_PERMISSION_SEED_VERSION
      ? breakGlassAuditRoles(agent)
      : [];
    return {
      agent: {
        ...agent,
        credentialGrantScopes: [...ADR_BOOTSTRAP_GRANT_SCOPES],
        credentialAuditRoles: retainedBreakGlassAuditRoles.length > 0 ? retainedBreakGlassAuditRoles : undefined,
        credentialPermissionSeedVersion: AGENT_CREDENTIAL_PERMISSION_SEED_VERSION,
      },
      seededGrantPermissions: sameStringSet(agent.credentialGrantScopes, ADR_BOOTSTRAP_GRANT_SCOPES) ? 0 : 1,
      seededAuditRoles: sameStringSet(agent.credentialAuditRoles, retainedBreakGlassAuditRoles) ? 0 : 1,
      seededPermissionBaselines: agent.credentialPermissionSeedVersion === AGENT_CREDENTIAL_PERMISSION_SEED_VERSION ? 0 : 1,
    };
  }

  if (isSecurityMetadataAuditAgent(agent, options)) {
    const hasGrantScopes = (agent.credentialGrantScopes ?? []).length > 0;
    const retainedBreakGlassAuditRoles = agent.credentialPermissionSeedVersion === AGENT_CREDENTIAL_PERMISSION_SEED_VERSION
      ? breakGlassAuditRoles(agent)
      : [];
    const nextAuditRoles = [...SECURITY_METADATA_AUDIT_ROLES, ...retainedBreakGlassAuditRoles];
    return {
      agent: {
        ...agent,
        credentialGrantScopes: undefined,
        credentialAuditRoles: nextAuditRoles,
        credentialPermissionSeedVersion: AGENT_CREDENTIAL_PERMISSION_SEED_VERSION,
      },
      seededGrantPermissions: hasGrantScopes ? 1 : 0,
      seededAuditRoles: sameStringSet(agent.credentialAuditRoles, nextAuditRoles) ? 0 : 1,
      seededPermissionBaselines: agent.credentialPermissionSeedVersion === AGENT_CREDENTIAL_PERMISSION_SEED_VERSION ? 0 : 1,
    };
  }

  if (agent.credentialPermissionSeedVersion === AGENT_CREDENTIAL_PERMISSION_SEED_VERSION) {
    const hadGrantScopes = (agent.credentialGrantScopes ?? []).length > 0;
    const retainedBreakGlassAuditRoles = breakGlassAuditRoles(agent);
    const hadSeedManagedAuditRoles = seedManagedAuditRoles(agent).length > 0;
    if (!hadGrantScopes && !hadSeedManagedAuditRoles) {
      return { agent, seededGrantPermissions: 0, seededAuditRoles: 0, seededPermissionBaselines: 0 };
    }
    return {
      agent: {
        ...agent,
        credentialGrantScopes: undefined,
        credentialAuditRoles: retainedBreakGlassAuditRoles.length > 0 ? retainedBreakGlassAuditRoles : undefined,
        credentialPermissionSeedVersion: AGENT_CREDENTIAL_PERMISSION_SEED_VERSION,
      },
      seededGrantPermissions: hadGrantScopes ? 1 : 0,
      seededAuditRoles: hadSeedManagedAuditRoles ? 1 : 0,
      seededPermissionBaselines: 0,
    };
  }

  const hadGrantScopes = (agent.credentialGrantScopes ?? []).length > 0;
  const hadAuditRoles = (agent.credentialAuditRoles ?? []).length > 0;
  const retainedBreakGlassAuditRoles = breakGlassAuditRoles(agent);
  return {
    agent: {
      ...agent,
      credentialGrantScopes: undefined,
      credentialAuditRoles: retainedBreakGlassAuditRoles.length > 0 ? retainedBreakGlassAuditRoles : undefined,
      credentialPermissionSeedVersion: AGENT_CREDENTIAL_PERMISSION_SEED_VERSION,
    },
    seededGrantPermissions: hadGrantScopes ? 1 : 0,
    seededAuditRoles: hadAuditRoles && retainedBreakGlassAuditRoles.length !== (agent.credentialAuditRoles ?? []).length ? 1 : 0,
    seededPermissionBaselines: 1,
  };
}

export function assertAgentCredentialPermissionSeedInvariants(
  agents: AgentInfo[],
  options: AgentCredentialMigrationOptions = {},
): void {
  for (const agent of agents) {
    const auditRoles = agent.credentialAuditRoles ?? [];
    const nonBreakGlassAuditRoles = seedManagedAuditRoles(agent);
    const grantScopes = agent.credentialGrantScopes ?? [];
    for (const role of auditRoles) assertAgentCredentialAuditRole(role);
    for (const scope of grantScopes) assertAgentCredentialScope(scope);

    if (isPlatformGrantAgent(agent, options)) {
      if (!sameStringSet(grantScopes, ADR_BOOTSTRAP_GRANT_SCOPES) || nonBreakGlassAuditRoles.length > 0) {
        throw new Error(`AgentCredential bootstrap invariant violated: ${agent.username} must grant only fleet-ssh,kubeconfig`);
      }
      continue;
    }
    if (isSecurityMetadataAuditAgent(agent, options)) {
      if (!sameStringSet(nonBreakGlassAuditRoles, SECURITY_METADATA_AUDIT_ROLES) || grantScopes.length > 0) {
        throw new Error(`AgentCredential bootstrap invariant violated: ${agent.username} must have metadata-audit only`);
      }
      continue;
    }
    if (
      isTrustedSeedCandidate(agent) &&
      options.trustedPlatformIdentitiesAuthoritative !== true
    ) {
      if (!hasValidNonAuthoritativeSeedBaseline(agent) && (grantScopes.length > 0 || nonBreakGlassAuditRoles.length > 0)) {
        throw new Error(`AgentCredential bootstrap invariant violated: unverified trusted candidate ${agent.username} must not retain unexpected grant or audit authority`);
      }
      continue;
    }
    if (grantScopes.length > 0) {
      throw new Error(`AgentCredential bootstrap invariant violated: ${agent.username} must not have credential grant scopes`);
    }
    if (nonBreakGlassAuditRoles.length > 0) {
      throw new Error(`AgentCredential bootstrap invariant violated: ${agent.username} must not have credential audit roles`);
    }
  }
}

function ensureDogfoodPhoenixFleetSshMetadata(
  credential: AgentCredential,
  agent: AgentInfo,
  migratedAt: string,
): { credential: AgentCredential; changed: boolean } {
  if (!isDogfoodPhoenixFleetSshAgent(agent) || !isFleetSshCredentialLike(credential)) {
    return { credential, changed: false };
  }

  if (!isPhoenixFleetSshMountData(credential.credentialData)) {
    return { credential, changed: false };
  }

  const metadata = dogfoodPhoenixCredentialData(
    agent,
    credential.credentialData.auditMigratedAt || migratedAt,
  );
  const credentialData = { ...credential.credentialData };
  let changed = false;
  for (const [key, value] of Object.entries(metadata)) {
    if (credentialData[key] !== value) {
      credentialData[key] = value;
      changed = true;
    }
  }
  if (!changed) return { credential, changed: false };
  return { credential: { ...credential, credentialData }, changed: true };
}

export function migrateAgentCredentialGrants(
  agents: AgentInfo[],
  enabledAgentIds: Set<string>,
  options: AgentCredentialMigrationOptions = {},
): AgentCredentialMigrationResult {
  let insertedFleetSshGrants = 0;
  let dogfoodPhoenixFleetSshGrants = 0;
  let normalizedCredentials = 0;
  let refusedCredentials = 0;
  let seededGrantPermissions = 0;
  let seededAuditRoles = 0;
  let seededPermissionBaselines = 0;
  const migratedAt = options.migratedAt ?? new Date().toISOString();

  const migratedAgents = agents.map((agent) => {
    const next: AgentInfo = { ...agent };
    const before = next.credentials ?? [];
    const normalized: AgentCredential[] = [];
    for (const credential of before) {
      let migrated: AgentCredential;
      try {
        migrated = normalizeAgentCredential(credential, next);
      } catch {
        // Fail closed: invalid/reserved persisted credentials must not remain
        // in agents.json after the source-of-truth migration.
        refusedCredentials++;
        continue;
      }
      if (
        migrated.grantId !== credential.grantId ||
        migrated.scope !== credential.scope ||
        migrated.grantorId !== credential.grantorId ||
        migrated.expiresAt !== credential.expiresAt
      ) {
        normalizedCredentials++;
      }

      const dogfoodResult = ensureDogfoodPhoenixFleetSshMetadata(migrated, next, migratedAt);
      if (dogfoodResult.changed) {
        migrated = dogfoodResult.credential;
        dogfoodPhoenixFleetSshGrants++;
      }
      normalized.push(migrated);
    }

    if (enabledAgentIds.has(next.id)) {
      const dogfoodCredentialData = isDogfoodPhoenixFleetSshAgent(next) && isPhoenixFleetSshMountData(next.sshKeys)
        ? dogfoodPhoenixCredentialData(next, migratedAt)
        : undefined;
      const fleetGrant = createFleetSshCredentialGrant(next, { credentialData: dogfoodCredentialData });
      if (fleetGrant && !normalized.some((credential) => credential.scope === 'fleet-ssh')) {
        normalized.push(fleetGrant);
        insertedFleetSshGrants++;
        if (dogfoodCredentialData) dogfoodPhoenixFleetSshGrants++;
      }
    }

    if (before.length > 0 || normalized.length > 0) {
      next.credentials = normalized;
    }
    const seeded = seedAgentCredentialPermissionRoles(next, options);
    seededGrantPermissions += seeded.seededGrantPermissions;
    seededAuditRoles += seeded.seededAuditRoles;
    seededPermissionBaselines += seeded.seededPermissionBaselines;
    return seeded.agent;
  });

  // Enforce the ADR bootstrap trust-root invariants on every daemon migration
  // pass, not only on the first seed. A pre-marked baseline must not let a
  // stale or manually edited `security-lead` assignment survive bootstrap.
  assertAgentCredentialPermissionSeedInvariants(migratedAgents, options);

  return {
    agents: migratedAgents,
    insertedFleetSshGrants,
    dogfoodPhoenixFleetSshGrants,
    normalizedCredentials,
    refusedCredentials,
    seededGrantPermissions,
    seededAuditRoles,
    seededPermissionBaselines,
  };
}

// ── AgentCredential broker socket mounts (PLAT-103) ─────────────────────────

export const AGENT_CREDENTIAL_REQUEST_SOCKET_HOST_ENV = 'SHIZUHA_CREDENTIAL_REQUEST_SOCKET_HOST';
export const AGENT_CREDENTIAL_GRANT_SOCKET_HOST_ENV = 'SHIZUHA_CREDENTIAL_GRANT_SOCKET_HOST';
export const AGENT_CREDENTIAL_REQUEST_SOCKET_ENV = 'SHIZUHA_CREDENTIAL_REQUEST_SOCKET';
export const AGENT_CREDENTIAL_GRANT_SOCKET_ENV = 'SHIZUHA_CREDENTIAL_GRANT_SOCKET';
export const AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER = '/run/shizuha/broker/request.sock';
export const AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER = '/run/shizuha/broker/grant.sock';
export const AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV = 'SHIZUHA_CREDENTIAL_GRANT_SCOPES';
export const AGENT_CREDENTIAL_SOCKET_DIR = '/run/shizuha/broker';
export const AGENT_CREDENTIAL_AGENT_SOCKET_DIR = `${AGENT_CREDENTIAL_SOCKET_DIR}/agents`;
export const AGENT_CREDENTIAL_BROKER_RESERVED_ENV_NAMES = [
  AGENT_CREDENTIAL_REQUEST_SOCKET_ENV,
  AGENT_CREDENTIAL_GRANT_SOCKET_ENV,
  AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV,
] as const;

const DEFAULT_AGENT_CREDENTIAL_REQUEST_SOCKET_HOST = '/run/shizuha/broker/request.sock';
const DEFAULT_AGENT_CREDENTIAL_GRANT_SOCKET_HOST = '/run/shizuha/broker/grant.sock';
const AGENT_CREDENTIAL_BROKER_RESERVED_ENV_SET = new Set<string>(AGENT_CREDENTIAL_BROKER_RESERVED_ENV_NAMES);
const LEGACY_AGENT_CREDENTIAL_SOCKET_DIR = '/run/shizuha/agent-credentials';
const AGENT_CREDENTIAL_BROKER_CONTAINER_PATHS = [
  AGENT_CREDENTIAL_SOCKET_DIR,
  LEGACY_AGENT_CREDENTIAL_SOCKET_DIR,
  AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
  AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
  '/proc',
  '/var/run/docker.sock',
  '/run/docker.sock',
] as const;
const AGENT_CREDENTIAL_BROKER_DEFAULT_HOST_PATHS = [
  AGENT_CREDENTIAL_SOCKET_DIR,
  AGENT_CREDENTIAL_AGENT_SOCKET_DIR,
  LEGACY_AGENT_CREDENTIAL_SOCKET_DIR,
  DEFAULT_AGENT_CREDENTIAL_REQUEST_SOCKET_HOST,
  DEFAULT_AGENT_CREDENTIAL_GRANT_SOCKET_HOST,
  `${LEGACY_AGENT_CREDENTIAL_SOCKET_DIR}/request.sock`,
  `${LEGACY_AGENT_CREDENTIAL_SOCKET_DIR}/grant.sock`,
  '/proc',
  '/var/run/docker.sock',
  '/run/docker.sock',
] as const;

export interface AgentCredentialBrokerSocketMount {
  hostPath: string;
  containerPath: string;
  envName: string;
  envValue: string;
}

export interface AgentCredentialBrokerSocketPlan {
  mounts: AgentCredentialBrokerSocketMount[];
  env: Record<string, string>;
  grantScopes: AgentCredentialScope[];
}

export interface AgentCredentialExtraVolume {
  host: string;
  container: string;
  mode?: string;
}

function safeAgentSocketSegment(agent: Pick<AgentInfo, 'id' | 'username'>): string {
  const raw = (agent.id || agent.username).trim();
  return raw.replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown-agent';
}

export function agentCredentialBrokerHostSocketPath(
  agent: Pick<AgentInfo, 'id' | 'username'>,
  kind: 'request' | 'grant',
  agentSocketDir = process.env['SHIZUHA_CREDENTIAL_AGENT_SOCKET_DIR'] ?? path.join(defaultAgentCredentialBrokerDir(), 'agents'),
): string {
  return path.join(agentSocketDir, safeAgentSocketSegment(agent), `${kind}.sock`);
}

export function defaultAgentCredentialBrokerDir(): string {
  const configured = process.env['SHIZUHA_CREDENTIAL_BROKER_DIR']?.trim();
  if (configured) return configured;
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return path.join(runtimeDir, 'shizuha', 'broker');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `shizuha-${uid}`, 'broker');
}

export function resolveCredentialGrantScopes(agent: AgentInfo): AgentCredentialScope[] {
  const seen = new Set<AgentCredentialScope>();
  for (const rawScope of agent.credentialGrantScopes ?? []) {
    seen.add(assertAgentCredentialScope(rawScope));
  }
  return [...seen];
}

export function normalizeCredentialCustomService(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('custom credential grant service must be a non-empty string');
  }
  const service = value.trim().toLowerCase();
  if (service === '*') return service;
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(service)) {
    throw new Error(`Invalid custom credential grant service: ${String(value)}`);
  }
  return service;
}

export function resolveCredentialCustomGrantServices(agent: AgentInfo): string[] {
  const seen = new Set<string>();
  for (const rawService of agent.credentialCustomGrantServices ?? []) {
    seen.add(normalizeCredentialCustomService(rawService));
  }
  return [...seen];
}

export function resolveCredentialAuditRoles(agent: AgentInfo): AgentCredentialAuditRole[] {
  const seen = new Set<AgentCredentialAuditRole>();
  for (const rawRole of agent.credentialAuditRoles ?? []) {
    seen.add(assertAgentCredentialAuditRole(rawRole));
  }
  return [...seen];
}

export function resolveCredentialPayloadReadScopes(agent: AgentInfo): Array<AgentCredentialScope | '*'> {
  const seen = new Set<AgentCredentialScope | '*'>();
  if (resolveCredentialAuditRoles(agent).includes('security-lead')) seen.add('*');
  for (const rawScope of agent.credentialPayloadReadScopes ?? []) {
    if (rawScope === '*') {
      seen.add('*');
    } else {
      seen.add(assertAgentCredentialScope(rawScope));
    }
  }
  return [...seen];
}

function runtimeUsesContainerSocketNamespace(agent: AgentInfo): boolean {
  return agent.runtimeEnvironment !== 'bare_metal';
}

export function scrubAgentCredentialBrokerReservedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (AGENT_CREDENTIAL_BROKER_RESERVED_ENV_SET.has(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

export function resolveAgentCredentialInjectedEnvNames(agent: AgentInfo): Set<string> {
  const names = new Set<string>();
  for (const credential of agent.credentials ?? []) {
    let normalized: AgentCredential;
    try {
      normalized = normalizeAgentCredential(credential, agent);
    } catch {
      continue;
    }
    if (!isAgentCredentialGrantCurrentlyActive(normalized) || !normalized.injectAsEnv) continue;
    if (normalized.envMapping) {
      for (const envName of Object.values(normalized.envMapping)) {
        if (typeof envName === 'string' && envName.trim()) names.add(envName);
      }
      continue;
    }
    for (const key of Object.keys(normalized.credentialData)) {
      if (key.trim()) names.add(key.toUpperCase());
    }
  }
  return names;
}

export function scrubAgentRuntimeEnvForCredentialInjection(
  agent: AgentInfo,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const credentialEnvNames = resolveAgentCredentialInjectedEnvNames(agent);
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (AGENT_CREDENTIAL_BROKER_RESERVED_ENV_SET.has(key)) continue;
    if (credentialEnvNames.has(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

function normalizedSocketPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  const normalized = path.posix.normalize(trimmed).replace(/\/+$/, '');
  return normalized || '/';
}

function pathOverlapsReserved(candidate: string, reservedPath: string): boolean {
  const normalizedCandidate = normalizedSocketPath(candidate);
  const normalizedReserved = normalizedSocketPath(reservedPath);
  if (normalizedCandidate === '/' || normalizedReserved === '/') return true;
  return normalizedCandidate === normalizedReserved ||
    normalizedCandidate.startsWith(`${normalizedReserved}/`) ||
    normalizedReserved.startsWith(`${normalizedCandidate}/`);
}

export function isAgentCredentialBrokerReservedEnvName(name: string): boolean {
  return AGENT_CREDENTIAL_BROKER_RESERVED_ENV_SET.has(name);
}

export function isAgentCredentialBrokerReservedPath(
  candidate: string | undefined,
  options: { reservedHostPaths?: string[] } = {},
): boolean {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/')) return false;
  const reservedPaths = [
    ...AGENT_CREDENTIAL_BROKER_CONTAINER_PATHS,
    ...AGENT_CREDENTIAL_BROKER_DEFAULT_HOST_PATHS,
    ...activeDockerUnixSocketPaths(),
    ...(options.reservedHostPaths ?? []),
  ];
  return reservedPaths.some((reservedPath) => pathOverlapsReserved(trimmed, reservedPath));
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizedSocketPath))];
}

function hostPathCandidates(candidate: string): string[] {
  const normalized = normalizedSocketPath(candidate);
  const candidates = [normalized];
  try {
    if (fs.existsSync(normalized)) {
      candidates.push(fs.realpathSync(normalized));
    }
  } catch {
    // If realpath fails, the lexical normalized path is still checked below.
  }
  return uniquePaths(candidates);
}

function resolvedBrokerHostPathCandidates(paths: string[]): string[] {
  return uniquePaths(paths.flatMap(hostPathCandidates));
}

function dockerUnixSocketPath(dockerHost: string | undefined): string[] {
  if (!dockerHost?.startsWith('unix://')) return [];
  const rawPath = dockerHost.slice('unix://'.length).split('?')[0]?.trim();
  if (!rawPath?.startsWith('/')) return [];
  try {
    return [decodeURIComponent(rawPath)];
  } catch {
    return [rawPath];
  }
}

function currentDockerContextHost(dockerPath = 'docker'): string | undefined {
  if (process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT) return undefined;
  const args = ['context', 'inspect'];
  if (process.env.DOCKER_CONTEXT) args.push(process.env.DOCKER_CONTEXT);
  try {
    const raw = execFileSync(dockerPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    const contexts = JSON.parse(raw) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
    return contexts[0]?.Endpoints?.docker?.Host;
  } catch {
    return undefined;
  }
}

function activeDockerUnixSocketPaths(options: { dockerPath?: string } = {}): string[] {
  return uniquePaths([
    ...dockerUnixSocketPath(process.env.DOCKER_HOST),
    ...dockerUnixSocketPath(currentDockerContextHost(options.dockerPath)),
  ]);
}

export function resolveAgentCredentialBrokerReservedHostPaths(
  options: {
    requestSocketHostPath?: string;
    grantSocketHostPath?: string;
    dockerPath?: string;
  } = {},
): string[] {
  const brokerDir = defaultAgentCredentialBrokerDir();
  const requestSocketHostPath = options.requestSocketHostPath ?? process.env[AGENT_CREDENTIAL_REQUEST_SOCKET_HOST_ENV] ?? path.join(brokerDir, 'request.sock');
  const grantSocketHostPath = options.grantSocketHostPath ?? process.env[AGENT_CREDENTIAL_GRANT_SOCKET_HOST_ENV] ?? path.join(brokerDir, 'grant.sock');
  const agentSocketDir = process.env['SHIZUHA_CREDENTIAL_AGENT_SOCKET_DIR'] ?? path.join(brokerDir, 'agents');
  return uniquePaths([
    ...AGENT_CREDENTIAL_BROKER_DEFAULT_HOST_PATHS,
    ...activeDockerUnixSocketPaths({ dockerPath: options.dockerPath }),
    requestSocketHostPath,
    grantSocketHostPath,
    agentSocketDir,
  ]);
}

export function isAgentCredentialBrokerReservedHostPath(
  candidate: string | undefined,
  options: { reservedHostPaths?: string[] } = {},
): boolean {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/')) return true;
  const candidatePaths = hostPathCandidates(trimmed);
  const reservedPaths = resolvedBrokerHostPathCandidates([
    ...resolveAgentCredentialBrokerReservedHostPaths(),
    ...(options.reservedHostPaths ?? []),
  ]);
  return candidatePaths.some((candidatePath) =>
    reservedPaths.some((reservedPath) => pathOverlapsReserved(candidatePath, reservedPath))
  );
}

export function filterAgentCredentialBrokerExtraVolumes(
  volumes: AgentCredentialExtraVolume[] | undefined,
  options: { reservedHostPaths?: string[] } = {},
): AgentCredentialExtraVolume[] {
  return (volumes ?? []).filter((volume) =>
    !isAgentCredentialBrokerReservedHostPath(volume.host, options) &&
    !isAgentCredentialBrokerReservedPath(volume.container, options)
  );
}

function dockerEnvNameFromAssignment(value: string | undefined): string | null {
  if (!value) return null;
  const equalsIndex = value.indexOf('=');
  const name = (equalsIndex === -1 ? value : value.slice(0, equalsIndex)).trim();
  return name || null;
}

function isReservedDockerEnvAssignment(value: string | undefined): boolean {
  const envName = dockerEnvNameFromAssignment(value);
  return envName ? isAgentCredentialBrokerReservedEnvName(envName) : false;
}

function isReservedDockerVolumeSpec(value: string | undefined, options: { reservedHostPaths?: string[] }): boolean {
  if (!value) return false;
  const [hostPath, containerPath] = value.split(':');
  return isAgentCredentialBrokerReservedHostPath(hostPath, options) ||
    isAgentCredentialBrokerReservedPath(containerPath, options);
}

function dockerMountValues(spec: string, keys: string[]): string[] {
  const values: string[] = [];
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  for (const part of spec.split(',')) {
    const [rawKey, ...rawValue] = part.split('=');
    const key = rawKey?.trim().toLowerCase();
    if (key && keySet.has(key)) values.push(rawValue.join('=').trim());
  }
  return values;
}

function isReservedDockerMountSpec(value: string | undefined, options: { reservedHostPaths?: string[] }): boolean {
  if (!value) return false;
  if (/["'\\]/.test(value)) return true;
  const types = dockerMountValues(value, ['type']);
  if (types.some((type) => type.toLowerCase() === 'volume')) return true;
  const sources = dockerMountValues(value, ['source', 'src']);
  const targets = dockerMountValues(value, ['target', 'destination', 'dst']);
  const localVolumeDevices = dockerMountValues(value, ['volume-opt'])
    .map((option) => option.split('='))
    .filter(([key]) => key?.trim().toLowerCase() === 'device')
    .map(([, ...rawValue]) => rawValue.join('=').trim());
  return sources.some((source) => isAgentCredentialBrokerReservedHostPath(source, options)) ||
    targets.some((target) => isAgentCredentialBrokerReservedPath(target, options)) ||
    localVolumeDevices.some((device) => isAgentCredentialBrokerReservedHostPath(device, options));
}

function compactShortOptionPayload(arg: string, option: '-e' | '-v'): string {
  const payload = arg.slice(option.length);
  return payload.startsWith('=') ? payload.slice(1) : payload;
}

function hasBundledDockerEnvOrVolumeShortOption(arg: string): boolean {
  if (!arg.startsWith('-') || arg.startsWith('--') || arg.length <= 2) return false;
  if (arg.startsWith('-e') || arg.startsWith('-v')) return false;
  return /[ev]/.test(arg.slice(1));
}

export function filterAgentCredentialBrokerExtraDockerArgs(
  args: string[] | undefined,
  options: { reservedHostPaths?: string[] } = {},
): string[] {
  const sourceArgs = args ?? [];
  const filtered: string[] = [];
  for (let i = 0; i < sourceArgs.length; i++) {
    const arg = sourceArgs[i]!;
    const next = sourceArgs[i + 1];

    if (arg === '-e' || arg === '--env') {
      if (isReservedDockerEnvAssignment(next)) {
        i++;
        continue;
      }
      filtered.push(arg);
      if (next !== undefined) filtered.push(next);
      i++;
      continue;
    }
    if (arg.startsWith('--env=')) {
      if (!isReservedDockerEnvAssignment(arg.slice('--env='.length))) filtered.push(arg);
      continue;
    }
    if (arg.startsWith('-e') && arg.length > 2) {
      if (!isReservedDockerEnvAssignment(compactShortOptionPayload(arg, '-e'))) filtered.push(arg);
      continue;
    }
    if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      if (arg === '--env-file') i++;
      continue;
    }
    if (arg === '--volumes-from') {
      i++;
      continue;
    }
    if (arg.startsWith('--volumes-from=')) {
      continue;
    }
    if (arg === '--pid') {
      i++;
      continue;
    }
    if (arg.toLowerCase().startsWith('--pid=')) {
      continue;
    }

    if (arg === '-v' || arg === '--volume') {
      if (isReservedDockerVolumeSpec(next, options)) {
        i++;
        continue;
      }
      filtered.push(arg);
      if (next !== undefined) filtered.push(next);
      i++;
      continue;
    }
    if (arg.startsWith('--volume=')) {
      if (!isReservedDockerVolumeSpec(arg.slice('--volume='.length), options)) filtered.push(arg);
      continue;
    }
    if (arg.startsWith('-v') && arg.length > 2) {
      if (!isReservedDockerVolumeSpec(compactShortOptionPayload(arg, '-v'), options)) filtered.push(arg);
      continue;
    }

    if (arg === '--mount') {
      if (isReservedDockerMountSpec(next, options)) {
        i++;
        continue;
      }
      filtered.push(arg);
      if (next !== undefined) filtered.push(next);
      i++;
      continue;
    }
    if (arg.startsWith('--mount=')) {
      if (!isReservedDockerMountSpec(arg.slice('--mount='.length), options)) filtered.push(arg);
      continue;
    }
    if (hasBundledDockerEnvOrVolumeShortOption(arg)) {
      continue;
    }

    filtered.push(arg);
  }
  return filtered;
}

export function planAgentCredentialBrokerSockets(
  agent: AgentInfo,
  options: {
    requestSocketHostPath?: string;
    grantSocketHostPath?: string;
    socketExists?: (path: string) => boolean;
  } = {},
): AgentCredentialBrokerSocketPlan {
  const useAgentBoundSocket = runtimeUsesContainerSocketNamespace(agent);
  if (!useAgentBoundSocket && typeof agent.credentialBrokerPeerUid !== 'number') {
    return { mounts: [], env: {}, grantScopes: [] };
  }
  const brokerDir = defaultAgentCredentialBrokerDir();
  const requestSocketHostPath = options.requestSocketHostPath ??
    (useAgentBoundSocket
      ? agentCredentialBrokerHostSocketPath(agent, 'request')
      : (process.env[AGENT_CREDENTIAL_REQUEST_SOCKET_HOST_ENV] ?? path.join(brokerDir, 'request.sock')));
  const grantSocketHostPath = options.grantSocketHostPath ??
    (useAgentBoundSocket
      ? agentCredentialBrokerHostSocketPath(agent, 'grant')
      : (process.env[AGENT_CREDENTIAL_GRANT_SOCKET_HOST_ENV] ?? path.join(brokerDir, 'grant.sock')));
  const socketExists = options.socketExists ?? (() => true);
  const mounts: AgentCredentialBrokerSocketMount[] = [];
  const env: Record<string, string> = {};

  if (socketExists(requestSocketHostPath)) {
    const requestSocketEnvValue = useAgentBoundSocket
      ? AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER
      : requestSocketHostPath;
    if (useAgentBoundSocket) {
      mounts.push({
        hostPath: requestSocketHostPath,
        containerPath: AGENT_CREDENTIAL_REQUEST_SOCKET_CONTAINER,
        envName: AGENT_CREDENTIAL_REQUEST_SOCKET_ENV,
        envValue: requestSocketEnvValue,
      });
    }
    env[AGENT_CREDENTIAL_REQUEST_SOCKET_ENV] = requestSocketEnvValue;
  }

  const grantScopes = resolveCredentialGrantScopes(agent);
  const customGrantServices = resolveCredentialCustomGrantServices(agent);
  const payloadReadScopes = resolveCredentialPayloadReadScopes(agent);
  const auditRoles = resolveCredentialAuditRoles(agent);
  if (grantScopes.length > 0) {
    env[AGENT_CREDENTIAL_GRANT_SCOPES_HINT_ENV] = grantScopes.join(',');
  }
  if (customGrantServices.length > 0) {
    env.SHIZUHA_CREDENTIAL_CUSTOM_GRANT_SERVICES = customGrantServices.join(',');
  }
  if (grantScopes.length > 0 || customGrantServices.length > 0 || payloadReadScopes.length > 0 || auditRoles.length > 0) {
    if (socketExists(grantSocketHostPath)) {
      const grantSocketEnvValue = useAgentBoundSocket
        ? AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER
        : grantSocketHostPath;
      if (useAgentBoundSocket) {
        mounts.push({
          hostPath: grantSocketHostPath,
          containerPath: AGENT_CREDENTIAL_GRANT_SOCKET_CONTAINER,
          envName: AGENT_CREDENTIAL_GRANT_SOCKET_ENV,
          envValue: grantSocketEnvValue,
        });
      }
      env[AGENT_CREDENTIAL_GRANT_SOCKET_ENV] = grantSocketEnvValue;
    }
  }

  return { mounts, env, grantScopes };
}
