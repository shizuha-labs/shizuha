/**
 * Daemon manager — orchestrates agent gateway processes.
 *
 * `shizuha up` flow:
 * 1. Authenticate with platform (read ~/.shizuha/auth.json)
 * 2. Discover agents via platform API
 * 3. Fork a detached daemon process that runs in background
 * 4. Parent prints summary and exits immediately
 *
 * Agents are discovered but NOT auto-started. They start on demand when:
 * - User sends a chat message to an agent (auto-activate)
 * - User explicitly enables an agent via the dashboard settings toggle
 *
 * Multi-device conflict resolution (WhatsApp "Use Here" model):
 * When a new runner connects for an agent that already has a runner,
 * the platform sends auth_pending. The new runner must explicitly choose
 * to evict (auth_confirm:evict) or run locally (auth_confirm:use_local).
 * No auto-eviction — requires user confirmation via the daemon/dashboard.
 */

import { spawn, execFile, execSync, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import {
  computeAgentMcpConfigHash,
  explainK8sUnsupportedRuntime,
  isK8sAgent,
  isPrivilegedK8sAgent,
  missingRequiredFleetSshReason,
  listK8sAgentDeployments,
  isK8sControlPlaneUnreadable,
  operatorFacingK8sError,
  noteK8sDaemonApply,
  probeK8sGithubCredentialHealth,
  prepareAgentK8sBridgeForRuntimeRoll,
  readLatestAgentK8sHeartbeatOutcomeLogLine,
  readLatestAgentK8sLegacyGatewayCheckpoint,
  probeAgentK8sRuntimeLane,
  scheduleK8sLastActivityProbe,
  requiresFleetSshForK8sAgent,
  shouldSpawnK8sAgent,
  spawnAgentK8s,
  stageStoppedAgentK8sRuntime,
  rollRunningAgentK8sRuntime,
  desiredBrokerImage,
  refreshHiveDesiredImage,
  readValidatedRuntimeRelease,
  resolveRuntimeImageDigest,
  rollAgentK8sRuntimeRelease,
  getAgentK8sDeploymentState,
  getAgentK8sDeploymentStateAsync,
  repairAgentK8sDuplicateEnvMetadata,
  K8S_RUNTIME_SPEC_REVISION,
  type K8sDeploymentState,
  stopAgentK8s,
  restoreAgentK8s,
  restartAgentK8s,
  deleteAgentK8s,
  type K8sGitHubCredentialProbeResult,
} from './k8s-backend.js';
import {
  canonicalRuntimeImage,
  executeRuntimeReleaseMutationBoundary,
  planRuntimeRelease,
  sameRuntimeRelease,
} from './runtime-release.js';
import { runtimeLaneHealthFromProbe } from './runtime-lane-health.js';
import { launchConcurrentlyWithIoYield } from './startup-scheduler.js';
import { launchBareMetalChild } from './bare-metal-workspace.js';
import { type AgentIdentity, validateAgentIdentity } from './agent-identity.js';
import * as dns from 'node:dns';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { repairBareMetalRuntimeWorkspace } from './workspace-writable-repair.js';
import { logger } from '../utils/logger.js';
import { discoverClaudeTokens, getActiveClaudeToken, probeStaleClaudeCooldowns, readCodexAccounts } from '../config/credentials.js';
import { readProviderConfigValue } from '../config/provider-env.js';
import { isCortexModelId } from '../provider/registry.js';
import { buildBridgeIdentityPrompt } from '../prompt/bridge-identity.js';
import { agentEffectiveCapabilityEnv, applyEffectiveCapabilitiesToAgent, summarizeEffectiveCapabilities } from '../platform/effective-capabilities.js';
import { loadOrCreateAgentKeypair } from '../crypto/identity.js';
import { listSkillNames, readSkillByName } from '../skills/frontmatter.js';
import { skillMatchesAudience } from '../skills/registry.js';
import { setupPeriodicRunReviewer } from '../telemetry/run-reviewer.js';
import { startAgentHealthServer } from '../metrics/health-server.js';
import {
  applyRuntimeAuthorityOverlay,
  createSingleFlight,
  refreshRuntimeSsot,
  runtimeSsotBackstopDue,
} from './runtime-ssot-refresh.js';
import {
  setAgentIdentityOk,
  setReconcileMode,
  recordReconcileCycle,
  recordReconcileStartFailure,
  recordReconcileRepairBackoff,
  recordReconcileRepairDeferral,
  clearReconcileRepairBackoff,
  setRuntimeRollDeferralStartTimestamp,
  clearRuntimeRollDeferralStartTimestamp,
  recordK8sGithubAuthProbe,
  recordK8sGithubAuthAndonSendFailure,
  recordRuntimeSsotRefresh,
} from '../metrics/registry.js';
import { PlatformClient } from './platform-client.js';
import { startDashboard, startDashboardTcpProxy } from './dashboard.js';
import {
  buildDaemonLinkClientFromEnv,
  type DaemonLinkClient,
  type DaemonLinkRuntimeLaneContext,
} from './daemon-link-client.js';
import { fleetConvergedToImage, noteConvergedAgentRuntimeImage, noteDominantAgentRuntimeImage } from './harness-versions.js';
import { createMirroredCredentialBrokerStore, startCredentialBroker, type CredentialBrokerHandle, type CredentialBrokerStore, type CredentialGrantCircuitBreakerAlert } from './credential-broker.js';
import { buildCredentialBrokerNetworkListener } from './credential-broker-network-listener.js';
import { JwksTokenVerifier } from './jwks-token-verifier.js';
import { createCredentialAuditLogger, credentialAuditLogPath, queryCredentialAuditLog } from './credential-audit.js';
import { stageFleetSshCredentialGrant } from './fleet-ssh-staging.js';
import { watchFleetSshCredentialStores } from './fleet-ssh-watch.js';
import {
  readDaemonState,
  writeDaemonState,
  clearDaemonState,
  isDaemonRunning,
  isShizuhaDaemonProcess,
  readEnabledAgents,
  writeEnabledAgents,
  readDisabledAgents,
  writeDisabledAgents,
  setAgentDesiredRuntimeState,
  readAgents,
  writeAgents,
  addAgent,
  removeAgent,
  updateAgentConfig,
  computeRuntimeReconcilePlan,
  acquirePidLock,
  getFailoverChain,
} from './state.js';
import {
  migrateAgentCredentialGrants,
  filterAgentCredentialBrokerExtraDockerArgs,
  filterAgentCredentialBrokerExtraVolumes,
  materializeMissingFleetSshCredentialGrantFromLegacySshKeys,
  isHostPlaneAgent,
  isAgentCredentialGrantCurrentlyActive,
  normalizeAgentCredential,
  planAgentCredentialBrokerSockets,
  resolveFleetSshCredentialGrant,
  resolveAgentCredentialBrokerReservedHostPaths,
  scrubAgentCredentialBrokerReservedEnv,
  scrubAgentRuntimeEnvForCredentialInjection,
  shouldPersistAgentCredentialMigration,
} from './agent-credential.js';
import type { AgentCredentialReadRefusal } from './agent-credential.js';
import type {
  AgentInfo,
  DaemonConfig,
  DaemonState,
  DaemonAgentState,
} from './types.js';
import { revokeAgentGatewayTokens } from './agent-auth.js';
import { readAgentCredential } from '../auth/credential-resolver.js';
import { seedHeartbeatTemplate } from './heartbeat-template.js';
import {
  getHeartbeatQueueDrainOutcome,
  ingestHeartbeatQueueDrainOutcomeLogLine,
} from './heartbeat-outcome.js';
import { legacyHeartbeatRollRecoveryAllowed } from './legacy-heartbeat-roll-recovery.js';
import { legacyGatewayCheckpointRecoveryAllowed } from './legacy-gateway-checkpoint.js';
import {
  harnessRollStatePath,
  readHarnessRollState,
  writeHarnessRollState,
} from './harness-roll-state.js';
import {
  RuntimeRollDeferralTracker,
  resolveRuntimeRollDeferAlertMs,
} from './runtime-roll-deferral.js';
import { startHttpsProxy, stopHttpsProxy, getHttpsProxyPort } from './https-proxy.js';
import {
  clearAutoAndonRateLimit,
  observeAutoAndonLine,
  recordAutoAndonFired,
  recordAutoAndonSendFailed,
  resolveClusterManagerUsername,
  sendAutoAndonToClusterManager,
} from './auto-andon.js';
import { sendAgentAccountReconcileFailureAndon } from './account-reconcile-andon.js';
import { sendConnectDm } from '../platform/connect-dm.js';
import { RuntimeReconcileRepairBackoff, type RuntimeRepairAction } from './runtime-reconcile-backoff.js';

const PROVIDER_QUOTA_EXIT_RE = /\b429\b|rate.?limit|quota|usage limit|hit your limit|resets at|too many requests/i;
const PROVIDER_QUOTA_STATUS_MESSAGE = 'offline: provider quota/rate limit; retrying on heartbeat';

// HIVE-248 (ADR-0004 ph5): declarative per-team backend policy to prevent executionMethod drift.
// Keys are team slugs (agent.team); value holds the desired backend config for every agent on that team.
// The file is operator/coordinator-only (~/.shizuha/ is not writable by container agents).
type TeamBackendPolicy = Record<string, { executionMethod?: string }>;

/** Read the per-team backend policy file. No-op (empty map) if the file is absent or malformed. */
function readTeamBackendPolicy(shizuhaHome: string): TeamBackendPolicy {
  const policyPath = path.join(shizuhaHome, '.shizuha', 'team-backend-policy.json');
  try {
    return JSON.parse(fs.readFileSync(policyPath, 'utf-8')) as TeamBackendPolicy;
  } catch {
    return {};
  }
}

/** Load global TUI settings from ~/.shizuha/settings.json (reasoningEffort, thinkingLevel, etc.) */
function loadGlobalSettings(): { reasoningEffort?: string; thinkingLevel?: string; registryMirrors?: string[]; insecureRegistries?: string[]; autoSkillSync?: boolean } {
  try {
    const settingsPath = path.join(process.env['HOME'] ?? '~', '.shizuha', 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      reasoningEffort: parsed.reasoningEffort as string | undefined,
      thinkingLevel: parsed.thinkingLevel as string | undefined,
      registryMirrors: parsed.registryMirrors as string[] | undefined,
      insecureRegistries: parsed.insecureRegistries as string[] | undefined,
      autoSkillSync: parsed.autoSkillSync as boolean | undefined,
    };
  } catch {
    return {};
  }
}

/** Auto skill-sync is ON by default; only an explicit `false` disables it. */
export function isAutoSkillSyncEnabled(): boolean {
  return loadGlobalSettings().autoSkillSync !== false;
}

function isBridgePromptDebugEnabled(): boolean {
  return process.env['SHIZUHA_DEBUG_BRIDGE_PROMPTS'] === '1';
}

function expandDaemonHomePath(value: string): string {
  if (value === '~') return process.env['HOME'] ?? '~';
  if (value.startsWith('~/')) return path.join(process.env['HOME'] ?? '~', value.slice(2));
  return value;
}

function emitAgentCredentialScopeAlert(agent: AgentInfo, refusal: AgentCredentialReadRefusal): void {
  const scope = String(refusal.scope ?? '<missing>');
  const alertKey = `agentcredential-scope:${agent.id}:${refusal.credentialId}:${scope}`;
  logger.error(
    {
      agentId: agent.id,
      agentUsername: agent.username,
      credentialId: refusal.credentialId,
      scope,
      reason: refusal.reason,
    },
    'Refusing AgentCredential read with unknown/reserved scope',
  );
  console.error(
    `[daemon][ALERT][PLAT-105] ${agent.username}: refused AgentCredential ${refusal.credentialId} ` +
    `with unknown/reserved scope "${scope}" while staging grants`,
  );

  // Best-effort local Pulse alert. Never include credential payload material.
  void import('../pulse/local-store.js')
    .then(({ LocalPulseStore }) => {
      const pulseDb = path.join(process.env['HOME'] ?? '~', '.shizuha', 'pulse-local.db');
      const store = new LocalPulseStore(pulseDb);
      store.fireAlert({
        title: `AgentCredential scope refused for ${agent.username}`,
        description: `Daemon refused AgentCredential ${refusal.credentialId} with unknown/reserved scope "${scope}" while staging grants.`,
        item_type: 'alert.security.agentcredential_scope_refused',
        severity: 'critical',
        source: 'shizuha-daemon',
        source_id: alertKey,
        labels: ['PLAT-105', 'agentcredential', 'scope-validation'],
        payload: {
          agent_id: agent.id,
          agent_username: agent.username,
          credential_id: refusal.credentialId,
          scope,
          reason: refusal.reason,
        },
        created_by: 'shizuha-daemon',
      });
    })
    .catch((err) => {
      logger.warn({ agentId: agent.id, credentialId: refusal.credentialId, err }, 'Failed to emit local AgentCredential scope alert');
    });
}

function emitCredentialGrantCircuitBreakerAlert(alert: CredentialGrantCircuitBreakerAlert): void {
  const alertKey = `agentcredential-grant-circuit:${alert.side}:${alert.key}`;
  const alertIncidentKey = `${alertKey}:${alert.at}`;
  logger.error(alert, 'Credential grant circuit breaker opened');
  console.error(
    `[daemon][ALERT][PLAT-108] Credential grant circuit breaker opened for ${alert.side} ${alert.key}: ` +
    `${alert.grantsInWindow}/${alert.windowMinutes}min (threshold ${alert.threshold})`,
  );

  // Best-effort local Pulse alert. Never include credential payload material.
  void import('../pulse/local-store.js')
    .then(({ LocalPulseStore }) => {
      const pulseDb = path.join(process.env['HOME'] ?? '~', '.shizuha', 'pulse-local.db');
      const store = new LocalPulseStore(pulseDb);
      try {
        store.fireAlert({
          title: `Credential grant circuit breaker opened for ${alert.side} ${alert.key}`,
          description: `Broker blocked new credential grants after ${alert.grantsInWindow} grant_issued events in ${alert.windowMinutes} minutes (threshold ${alert.threshold}).`,
          item_type: 'alert.security.credential_grant_circuit_breaker',
          severity: 'critical',
          source: 'shizuha-daemon',
          source_id: alertIncidentKey,
          labels: ['PLAT-108', 'agentcredential', 'rate-limit', 'circuit-breaker'],
          payload: {
            side: alert.side,
            key: alert.key,
            grantor_id: alert.grantorId,
            grantor_agent_id: alert.grantorAgentId,
            grantor_username: alert.grantorUsername,
            grantee_id: alert.granteeId,
            grantee_username: alert.granteeUsername,
            scope: alert.scope,
            grants_in_window: alert.grantsInWindow,
            window_minutes: alert.windowMinutes,
            threshold: alert.threshold,
            at: alert.at,
          },
          created_by: 'shizuha-daemon',
        });
      } finally {
        store.close();
      }
    })
    .catch((err) => {
      logger.warn({ alert, err }, 'Failed to emit local credential grant circuit breaker alert');
    });
}

function summarizePromptForLog(prompt: string | null | undefined): Record<string, unknown> {
  const trimmed = prompt?.trim() ?? '';
  return {
    present: trimmed.length > 0,
    length: trimmed.length,
    hasIdentityHeader: trimmed.includes('## Shizuha Agent Identity'),
    firstLine: trimmed.split('\n')[0] ?? '',
  };
}

/** Resolve the full path to the docker binary. Caches result. */
let _dockerPath: string | null = null;
function resolveDockerPath(): string {
  if (_dockerPath) return _dockerPath;
  const candidates = [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    '/usr/bin/docker',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { _dockerPath = p; return p; }
  }
  // Try PATH (works when PATH is properly set)
  try {
    const result = execSync('which docker', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result) { _dockerPath = result; return result; }
  } catch { /* not found */ }
  return 'docker'; // fallback to bare name
}

function getAgentWorkspaceDir(agent: AgentInfo): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'workspaces', agent.username);
}

const DEFAULT_CONTAINER_AGENT_UID = 1000;
const DEFAULT_CONTAINER_AGENT_GID = 1000;

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function currentGid(): number | null {
  return typeof process.getgid === 'function' ? process.getgid() : null;
}

function containerAgentUid(): number {
  const uid = currentUid();
  return uid != null && uid !== 0 ? uid : DEFAULT_CONTAINER_AGENT_UID;
}

function containerAgentGid(): number {
  const uid = currentUid();
  const gid = currentGid();
  return uid != null && uid !== 0 && gid != null ? gid : DEFAULT_CONTAINER_AGENT_GID;
}

function ensureContainerAgentOwner(targetPath: string): void {
  const st = fs.statSync(targetPath);
  const targetUid = containerAgentUid();
  const targetGid = containerAgentGid();
  // Bind mounts preserve numeric host ownership inside the container. For
  // non-root daemons, the container entrypoint remaps the agent user to the
  // daemon's host UID/GID, so private host ACLs still work without world perms.
  if (st.uid === targetUid) return;
  if (currentUid() === 0) {
    fs.chownSync(targetPath, targetUid, targetGid);
  }
}

function ensurePrivateDir(dir: string, containerAgentOwned = false): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (containerAgentOwned) ensureContainerAgentOwner(dir);
  // mkdir's mode is ignored for existing directories; chmod closes stale
  // world/group-readable session directories left by older daemon versions.
  fs.chmodSync(dir, 0o700);
}

function ensurePrivateFileForContainerAgent(filePath: string): void {
  ensureContainerAgentOwner(filePath);
  fs.chmodSync(filePath, 0o600);
}


type PrivateDockerEnvPlan = {
  envFile: string | null;
  privateEnvJsonFile: string | null;
  privateEnvJsonContainerPath: string | null;
  privateKeys: Set<string>;
};

const PRIVATE_ENV_JSON_KEY = 'SHIZUHA_PRIVATE_ENV_JSON';

function sweepStalePrivateDockerEnvFiles(agentEnvDir: string): void {
  const currentPidPrefix = `${process.pid}-`;
  const maxCurrentProcessAgeMs = 10 * 60 * 1000;
  const now = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentEnvDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(env|json)$/.test(entry.name)) continue;
    const candidate = path.join(agentEnvDir, entry.name);
    try {
      const st = fs.statSync(candidate);
      const staleFromPreviousDaemon = !entry.name.startsWith(currentPidPrefix);
      const staleCurrentProcessFile = now - st.mtimeMs > maxCurrentProcessAgeMs;
      if (staleFromPreviousDaemon || staleCurrentProcessFile) {
        fs.unlinkSync(candidate);
      }
    } catch {
      // Best effort only: launch cleanup below also removes files created by
      // this attempt. Never log filenames because they identify private paths.
    }
  }
}

function sweepAllPrivateDockerEnvFiles(shizuhaHome: string): void {
  const envDir = path.join(shizuhaHome, '.shizuha', 'agent-env');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(envDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    sweepStalePrivateDockerEnvFiles(path.join(envDir, entry.name));
  }
}

const privateDockerEnvProcessCleanupFiles = new Set<string>();
let privateDockerEnvProcessCleanupInstalled = false;

function unlinkPrivateDockerEnvFile(privateFile: string): void {
  try { fs.unlinkSync(privateFile); } catch { /* absent/already cleaned */ }
}

function registerPrivateDockerEnvProcessCleanup(files: string[]): void {
  for (const file of files) privateDockerEnvProcessCleanupFiles.add(file);
  if (privateDockerEnvProcessCleanupInstalled) return;
  privateDockerEnvProcessCleanupInstalled = true;
  // A single process-exit hook avoids retaining one listener closure per agent
  // launch. Do not install signal handlers here: adding a SIGHUP/SIGTERM/SIGINT
  // listener changes Node's default termination/reload behavior. Daemon-start
  // stale sweeps cover hard exits that cannot run this best-effort hook.
  process.once('exit', () => {
    for (const privateFile of privateDockerEnvProcessCleanupFiles) {
      unlinkPrivateDockerEnvFile(privateFile);
    }
    privateDockerEnvProcessCleanupFiles.clear();
  });
}

function dockerContainerExists(dockerPath: string, containerName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(dockerPath, ['inspect', '-f', '{{.Id}}', containerName], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

function schedulePrivateDockerEnvCleanup(
  plan: PrivateDockerEnvPlan,
  child: ChildProcess,
  dockerPath: string,
  containerName: string,
): void {
  const files = [plan.envFile, plan.privateEnvJsonFile].filter((file): file is string => Boolean(file));
  if (!files.length) return;

  registerPrivateDockerEnvProcessCleanup(files);

  let cleaned = false;
  let inspectTimer: NodeJS.Timeout | null = null;
  let maxLifetimeTimer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (inspectTimer) clearInterval(inspectTimer);
    if (maxLifetimeTimer) clearTimeout(maxLifetimeTimer);
    child.off('exit', cleanup);
    child.off('error', cleanup);
    for (const privateFile of files) {
      unlinkPrivateDockerEnvFile(privateFile);
      privateDockerEnvProcessCleanupFiles.delete(privateFile);
    }
  };

  let inspectInFlight = false;
  const cleanupAfterContainerCreate = () => {
    if (cleaned || inspectInFlight) return;
    inspectInFlight = true;
    void dockerContainerExists(dockerPath, containerName)
      .then((exists) => { if (exists) cleanup(); })
      .finally(() => { inspectInFlight = false; });
  };

  // Keep the JSON bind-mount source until Docker has created the container. A
  // fixed short timer can fire during slow image pulls before Docker consumes
  // the mount, causing create failures or an empty directory at the source path.
  inspectTimer = setInterval(cleanupAfterContainerCreate, 1000);
  inspectTimer.unref?.();
  // Bound same-process stale files too; daemon-start sweeps still handle crashes.
  maxLifetimeTimer = setTimeout(cleanup, 10 * 60 * 1000);
  maxLifetimeTimer.unref?.();
  child.once('exit', cleanup);
  child.once('error', cleanup);
  cleanupAfterContainerCreate();
}

function preparePrivateDockerEnv(shizuhaHome: string, agentUsername: string, env: Record<string, string | undefined>): PrivateDockerEnvPlan {
  const entries = Object.entries(env).filter(([, value]) => value != null);
  const privateKeys = new Set(entries.map(([key]) => key));
  if (!entries.length) return { envFile: null, privateEnvJsonFile: null, privateEnvJsonContainerPath: null, privateKeys };
  const envDir = path.join(shizuhaHome, '.shizuha', 'agent-env');
  ensurePrivateDir(envDir, true);
  const safeUsername = agentUsername.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const agentEnvDir = path.join(envDir, encodeURIComponent(agentUsername));
  ensurePrivateDir(agentEnvDir, true);
  sweepStalePrivateDockerEnvFiles(agentEnvDir);
  const launchId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const privateEnvJson: Record<string, string> = {};
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (!key || /[=\0\r\n]/.test(key)) {
      throw new Error(`Invalid Docker environment key for ${agentUsername}: ${key}`);
    }
    const stringValue = String(value);
    if (/^[#\s]/.test(key) || /[\r\n]/.test(stringValue)) {
      // Docker env-files are line-oriented and cannot faithfully carry PEMs,
      // comment-like names, or other multiline payloads. Do not fall back to
      // `docker run -e KEY` with the value in the Docker CLI environment: the
      // non-detached docker client can stay alive for the full agent session and
      // host users can inspect that process environment. Instead, mount a
      // private JSON payload and let the Node bootstrap import it inside the
      // container before the main CLI reads process.env.
      privateEnvJson[key] = stringValue;
      continue;
    }
    // Keep explicit empty strings as `KEY=`. Some agents intentionally clear an
    // image/default env var; dropping the entry changes unset vs empty semantics.
    // Docker env-files accept names that are not shell identifiers (for example
    // names containing `.` or `-`), so only line-format-breaking keys are rejected.
    lines.push(`${key}=${stringValue}`);
  }
  let privateEnvJsonFile: string | null = null;
  let privateEnvJsonContainerPath: string | null = null;
  if (Object.keys(privateEnvJson).length) {
    privateEnvJsonFile = path.join(agentEnvDir, `${launchId}.json`);
    privateEnvJsonContainerPath = `/tmp/shizuha-private-env-${launchId}.json`;
    fs.writeFileSync(privateEnvJsonFile, JSON.stringify(privateEnvJson), { mode: 0o600 });
    ensurePrivateFileForContainerAgent(privateEnvJsonFile);
    lines.push(`${PRIVATE_ENV_JSON_KEY}=${privateEnvJsonContainerPath}`);
  }
  if (!lines.length) return { envFile: null, privateEnvJsonFile, privateEnvJsonContainerPath, privateKeys };
  // Remove the legacy stable file name used by the first PLAT-129 draft. Avoid
  // prefix-based cleanup: agents can start concurrently, and sanitized usernames
  // may overlap (for example `bob` and `bob-2`). New per-launch files live in an
  // exact per-agent directory and are removed by the launch that created them.
  try { fs.unlinkSync(path.join(envDir, `${safeUsername}.env`)); } catch { /* absent */ }
  const envFile = path.join(agentEnvDir, `${launchId}.env`);
  fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  ensurePrivateFileForContainerAgent(envFile);
  return { envFile, privateEnvJsonFile, privateEnvJsonContainerPath, privateKeys };

}

// ── Codex model validity guard (PLAT-394) ──

/**
 * Models confirmed working on the ChatGPT Codex backend (chatgpt.com/backend-api/codex).
 * Models NOT in this set return HTTP 400 "model not supported", which the bridge
 * swallows as a silent empty turn — the root cause of the PLAT-392 35-57h fleet outage.
 *
 * Currently invalid (400 on our ChatGPT account):
 *   gpt-5.5-codex, gpt-5-codex, gpt-5.3-codex, codex-mini-latest, gpt-5.5-codex-spark
 *
 * Update this set when the operator explicitly verifies a new model is functional.
 * gpt-5.3-codex-spark is valid but rate-capped (resets Jun 18 2026); gpt-5.5 is always safe.
 * gpt-5.6-sol (operator-verified 2026-07-10) is the current flagship — supports the
 * 'ultra' reasoning level (auto task delegation) on codex CLI >= 0.144.0.
 */
export const VALID_CODEX_MODELS = new Set<string>([
  'gpt-5.5',
  'gpt-5.6-sol',
  // gpt-5.6-luna / gpt-5.6-terra: operator-verified functional 2026-07-12
  // (sibling flagship variants used to spread the fleet across ChatGPT-backend
  // model lanes per team). Chains still terminate in CODEX_SAFE_FALLBACK.
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.3-codex-spark',
]);

/** The known-good safe fallback that MUST terminate every codex model chain. */
export const CODEX_SAFE_FALLBACK = 'gpt-5.5';

/**
 * Validate a proposed modelFallbacks + modelOverrides update for codex agents.
 * Returns null on success, or an error string describing why the update is rejected.
 *
 * Rules:
 * 1. Every codex_app_server model in fallbacks/overrides must be in VALID_CODEX_MODELS.
 * 2. If there are any codex_app_server steps, the last one must be CODEX_SAFE_FALLBACK.
 *    This ensures the chain always ends in a model that is guaranteed to work.
 */
export function validateCodexModelChain(
  fallbacks: Array<{ method: string; model: string }>,
  overrides?: Record<string, string>,
): string | null {
  for (const entry of fallbacks) {
    if (entry.method !== 'codex_app_server') continue;
    if (!VALID_CODEX_MODELS.has(entry.model)) {
      return (
        `Codex model "${entry.model}" is not in the valid model set ` +
        `[${[...VALID_CODEX_MODELS].join(', ')}]. Invalid codex models return HTTP 400 → ` +
        `silent empty turns (root cause of PLAT-392). ` +
        `Update VALID_CODEX_MODELS in daemon/manager.ts when a new model is verified working.`
      );
    }
  }
  if (overrides?.['codex_app_server'] && !VALID_CODEX_MODELS.has(overrides['codex_app_server'])) {
    return (
      `modelOverrides.codex_app_server "${overrides['codex_app_server']}" is not in the valid ` +
      `codex model set [${[...VALID_CODEX_MODELS].join(', ')}].`
    );
  }
  const codexSteps = fallbacks.filter((f) => f.method === 'codex_app_server');
  if (codexSteps.length > 0) {
    const last = codexSteps[codexSteps.length - 1]!;
    // Find the index of the last codex step in the full chain.
    let lastCodexIdx = -1;
    for (let i = fallbacks.length - 1; i >= 0; i--) {
      if (fallbacks[i]!.method === 'codex_app_server') { lastCodexIdx = i; break; }
    }
    // The chain is safe if:
    // (a) the last codex step is CODEX_SAFE_FALLBACK, OR
    // (b) there are non-codex steps after the last codex step — exit-42 advances
    //     to the next step, so a `codex/gpt-5.3-codex-spark → shizuha/Qwen3` chain
    //     is a valid recovery path that must not be rejected.
    const hasNonCodexTail = lastCodexIdx < fallbacks.length - 1;
    if (last.model !== CODEX_SAFE_FALLBACK && !hasNonCodexTail) {
      return (
        `Codex modelFallbacks chain must end in "${CODEX_SAFE_FALLBACK}" (the always-available ` +
        `safe fallback) or be followed by a non-Codex step for recovery. ` +
        `The last codex step is "${last.model}". ` +
        `Add { method: "codex_app_server", model: "${CODEX_SAFE_FALLBACK}" } as the final Codex ` +
        `step, or add a non-Codex fallback step after it.`
      );
    }
  }
  // P2 — RELAXED per operator directive 2026-07-13 ("I'm okay if one agent-model
  // pair is specified and works ... fallback chain not needed"). An override-only
  // Codex config that pins a model with NO fallback chain is now ACCEPTED, as long
  // as that model is in VALID_CODEX_MODELS (already enforced above). Rationale:
  //   • The whitelist is the real safety net — it's what prevents PLAT-392
  //     invalid-model 400s → silent empty turns. A whitelisted model is
  //     operator-verified working, so "no recovery path" is not a correctness risk.
  //   • Hive strips modelFallbacks under the 2026-07-11 no-within-agent-fallback
  //     policy (serializers.RuntimeAgentConfigSerializer.validate). So per-team
  //     single-model configs (gpt-5.6-sol / luna / terra) arrive here with
  //     codexSteps=[] and a non-safe override, and the old P2 check rejected them
  //     with "no recovery path" → config_result:failed → the daemon kept the
  //     agent's PREVIOUS model (frequently cortex/DeepSeek), i.e. the agent
  //     silently drifted back onto DeepSeek and ignored its assigned gpt model.
  //     Accepting the override lets the intended per-team model actually apply.
  // The prior recovery-path text is preserved in git history (PLAT-394 review).
  return null;
}

// ── Failover chain resolution ──
/** Per-agent failover step tracker (in memory, resets on daemon restart) */
const failoverStepIndices = new Map<string, number>();

// SCLI-107: when the WHOLE failover chain is exhausted (e.g. a transient
// provider-wide outage knocks out every step), the daemon used to mark the
// agent `error` and give up — turning a transient outage into a permanent,
// fleet-wide SPOF that needed a manual restart. Instead we re-queue a start
// with exponential back-off so the agent self-heals once the provider recovers.
// This per-agent attempt counter drives the back-off. It is cleared on genuine
// recovery (the agent spawns and survives FAILOVER_RECOVERY_GRACE_MS), so the
// ceiling is per-outage-cycle, NOT cumulative: a recover-then-fail-again agent
// restarts the back-off at the floor.
const failoverRequeueAttempts = new Map<string, number>();
const FAILOVER_REQUEUE_BASE_MS = 30 * 1000; // first retry after exhaustion
const FAILOVER_REQUEUE_MAX_MS = 10 * 60 * 1000; // per-cycle ceiling
const FAILOVER_RECOVERY_GRACE_MS = 60 * 1000; // alive this long ⇒ recovered

// Legacy root-running runtimes can leave a bare-metal agent's SQLite state
// readable but not writable by today's non-root controller. A failed repair is
// retried autonomously with bounded exponential backoff, rather than either
// burning CPU in a five-second child crash loop or requiring a manual restart.
const bareMetalStateRepairAttempts = new Map<string, number>();
const bareMetalStateRepairTimers = new Map<string, ReturnType<typeof setTimeout>>();
const BARE_METAL_STATE_REPAIR_BASE_MS = 30 * 1000;
const BARE_METAL_STATE_REPAIR_MAX_MS = 10 * 60 * 1000;

function resetBareMetalStateRepairRetry(agentId: string): void {
  bareMetalStateRepairAttempts.delete(agentId);
  const timer = bareMetalStateRepairTimers.get(agentId);
  if (timer) clearTimeout(timer);
  bareMetalStateRepairTimers.delete(agentId);
}

function scheduleBareMetalStateRepairRetry(
  agent: AgentInfo,
  config: DaemonConfig,
): number {
  const existing = bareMetalStateRepairTimers.get(agent.id);
  if (existing) {
    const attempts = bareMetalStateRepairAttempts.get(agent.id) ?? 1;
    return Math.min(
      BARE_METAL_STATE_REPAIR_BASE_MS * 2 ** (attempts - 1),
      BARE_METAL_STATE_REPAIR_MAX_MS,
    );
  }

  const attempts = (bareMetalStateRepairAttempts.get(agent.id) ?? 0) + 1;
  bareMetalStateRepairAttempts.set(agent.id, attempts);
  const delayMs = Math.min(
    BARE_METAL_STATE_REPAIR_BASE_MS * 2 ** (attempts - 1),
    BARE_METAL_STATE_REPAIR_MAX_MS,
  );
  const timer = setTimeout(() => {
    bareMetalStateRepairTimers.delete(agent.id);
    const currentState = inMemoryState?.agents.find((candidate) => candidate.agentId === agent.id);
    if (
      !shuttingDown
      && currentState?.enabled
      && readEnabledAgents().has(agent.id)
      && !childProcesses.has(agent.id)
    ) {
      void startAgentProcess(agent, tokenCache.get(agent.id) ?? '', config);
    }
  }, delayMs);
  timer.unref?.();
  bareMetalStateRepairTimers.set(agent.id, timer);
  return delayMs;
}

/** Reset the SCLI-107 back-off counter (call on genuine recovery). */
export function resetFailoverRequeue(agentId: string): void {
  failoverRequeueAttempts.delete(agentId);
}

/**
 * SCLI-107: bump the per-agent failover-exhaustion attempt counter and return
 * the next re-queue delay (exponential back-off, capped). The cap is per
 * outage-cycle, not cumulative — `resetFailoverRequeue` (called on genuine
 * recovery) sends the next exhaustion back to FAILOVER_REQUEUE_BASE_MS.
 */
export function nextFailoverRequeueDelayMs(agentId: string): number {
  const attempts = (failoverRequeueAttempts.get(agentId) ?? 0) + 1;
  failoverRequeueAttempts.set(agentId, attempts);
  return Math.min(
    FAILOVER_REQUEUE_BASE_MS * 2 ** (attempts - 1),
    FAILOVER_REQUEUE_MAX_MS,
  );
}

/**
 * Resolve the effective failover chain for an agent.
 * Priority: failoverChainId → modelFallbacks → 'default' chain → empty.
 */
export function resolveEffectiveChain(agent: import('./types.js').AgentInfo): import('./types.js').FailoverChainStep[] {
  // Named chain takes priority
  if (agent.failoverChainId) {
    const chain = getFailoverChain(agent.failoverChainId);
    if (chain) return chain.steps;
  }
  // Inline modelFallbacks (backward compat)
  if (agent.modelFallbacks?.length) {
    return agent.modelFallbacks.map(f => ({
      method: f.method,
      model: f.model,
      reasoningEffort: f.reasoningEffort,
      thinkingLevel: f.thinkingLevel,
    }));
  }
  // Default chain
  const defaultChain = getFailoverChain('default');
  if (defaultChain) return defaultChain.steps;
  return [];
}

function defaultModelForExecutionMethod(method: string): string {
  if (method === 'claude_code_server') return 'claude-opus-4-8';
  if (method === 'codex_app_server') return 'gpt-5.5';
  if (method === 'openclaw_bridge') return 'gpt-5.5';
  if (method === 'antigravity_server' || method === 'gemini_cli_server') return 'gemini-3.6-flash-high';
  // Grok Build / shizuha default is Cortex SuperGrok 4.6.
  if (method === 'grok_build') return 'cortex/grok-4.6';
  if (method === 'shizuha') return 'cortex/grok-4.6';
  return 'gpt-5.5';
}

/** Models accepted by the Grok Build harness (Cortex SuperGrok or Hive xAI lease). */
function isGrokBuildModel(model: string): boolean {
  const m = (model || '').toLowerCase();
  return (
    m.startsWith('grok-')
    || m.startsWith('cortex/grok-')
    || m.startsWith('xai/grok-')
    || m.startsWith('xai:grok-')
    || m.startsWith('cortex/xai/grok-')
  );
}

function resolveDeclaredPrimaryStep(agent: import('./types.js').AgentInfo): import('./types.js').FailoverChainStep | null {
  const method = agent.executionMethod ?? agent.modelFallbacks?.[0]?.method;
  if (!method) return null;

  const inline = agent.modelFallbacks?.find((entry) => entry.method === method);
  const override = agent.modelOverrides?.[method]
    || (method === 'shizuha' ? agent.modelOverrides?.['shizuha'] : undefined);
  const effortOverride = agent.modelOverrides?.[`${method}_reasoning_effort`];

  return {
    method,
    // Hive's normal runtime contract is a single agent-model pair. Legacy
    // fallback/override fields remain supported for advanced failover, but they
    // must not outrank Hive's primary model or stale one-step chains can pin a
    // pod to the old model after a reconnect/restart.
    model: agent.model || inline?.model || override || defaultModelForExecutionMethod(method),
    // Hive persists an atomic model+effort update in modelOverrides even when
    // it intentionally clears modelFallbacks. Ignoring this companion key made
    // the pod render SHIZUHA_K8S_PRIMARY_EFFORT="" and Codex silently ran low
    // effort while the Hive card said high (Jun, 2026-07-16).
    reasoningEffort: effortOverride || inline?.reasoningEffort,
    thinkingLevel: inline?.thinkingLevel,
  };
}

function sameFailoverStep(a: import('./types.js').FailoverChainStep, b: import('./types.js').FailoverChainStep): boolean {
  return a.method === b.method && a.model === b.model;
}

/**
 * Resolve the chain used by the live runtime.
 *
 * Agent identity owns the primary execution method. A named failover chain is
 * backup capacity, not a license to silently turn a Codex/local agent into a
 * Claude agent whenever the chain happens to start with Claude.
 */
export function resolveRuntimeChain(agent: import('./types.js').AgentInfo): import('./types.js').FailoverChainStep[] {
  const declaredPrimary = resolveDeclaredPrimaryStep(agent);
  const fallback = resolveEffectiveChain(agent);

  if (!declaredPrimary) return fallback;
  if (fallback.length === 0) return [declaredPrimary];
  if (sameFailoverStep(declaredPrimary, fallback[0]!)) {
    const first = fallback[0]!;
    // The desired primary is authoritative for model/effort. Keep any legacy
    // thinking-level metadata only when Hive did not provide a replacement.
    return [{
      ...first,
      ...declaredPrimary,
      reasoningEffort: declaredPrimary.reasoningEffort || first.reasoningEffort,
      thinkingLevel: declaredPrimary.thinkingLevel || first.thinkingLevel,
    }, ...fallback.slice(1)];
  }

  return [
    declaredPrimary,
    ...fallback.filter((step) => !sameFailoverStep(step, declaredPrimary)),
  ];
}

function resolveCurrentRuntimeStep(agent: import('./types.js').AgentInfo): import('./types.js').FailoverChainStep | undefined {
  const chain = resolveRuntimeChain(agent);
  if (chain.length === 0) return undefined;
  const idx = Math.min(getFailoverStepIndex(agent.id), chain.length - 1);
  return chain[idx];
}

/** Get the current failover step index for an agent */
export function getFailoverStepIndex(agentId: string): number {
  return failoverStepIndices.get(agentId) ?? 0;
}

/** Advance to the next failover step, returns the new step or null if exhausted */
export function advanceFailoverStep(agentId: string, chain: import('./types.js').FailoverChainStep[]): import('./types.js').FailoverChainStep | null {
  const current = failoverStepIndices.get(agentId) ?? 0;
  const next = current + 1;
  if (next >= chain.length) {
    // All steps exhausted — reset after cooldown
    setTimeout(() => {
      failoverStepIndices.delete(agentId);
      console.log(`[daemon] Failover cooldown expired for agent ${agentId} — resetting to step 0`);
    }, 10 * 60 * 1000);
    return null;
  }
  failoverStepIndices.set(agentId, next);
  return chain[next]!;
}

/** Reset failover index (e.g., on successful response) */
export function resetFailoverStep(agentId: string): void {
  failoverStepIndices.delete(agentId);
}

const AGENT_NETWORK = 'shizuha-agents';
// Agent traffic crosses flannel VXLAN (MTU 1450) to reach cluster services on
// other nodes. A bridge at Docker's default 1500 sends full-size frames that
// blackhole in the encap — small packets pass, bulk streams hang (KOT-38:
// adb handshake OK, screencap stalls; same class as BRW-26 browser MCP).
// Pin the network MTU under the VXLAN path; override via SHIZUHA_AGENT_NET_MTU.
const AGENT_NETWORK_MTU = process.env['SHIZUHA_AGENT_NET_MTU'] || '1450';

/**
 * Forward a Kubernetes pod's real DNS server into nested host-Docker agents.
 *
 * Docker's embedded 127.0.0.11 resolver can resolve container and public names,
 * but its upstreams come from the host daemon, not from the pod that launches
 * `docker run`.  A runtime-fleet daemon therefore resolved `*.svc.cluster.local`
 * through CoreDNS while every nested agent failed with ENOTFOUND.  Only inherit
 * resolver state when the daemon itself has Kubernetes search domains (or an
 * explicit override); ordinary workstation daemons keep Docker's defaults.
 */
export function resolveAgentDockerDnsArgs(
  resolvConf: string = (() => {
    try { return fs.readFileSync('/etc/resolv.conf', 'utf8'); } catch { return ''; }
  })(),
  override: string = process.env['SHIZUHA_AGENT_DNS'] || '',
): string[] {
  const lines = String(resolvConf || '').split(/\r?\n/);
  const searches = lines
    .map((line) => line.replace(/#.*/, '').trim().split(/\s+/))
    .filter((parts) => parts[0] === 'search')
    .flatMap((parts) => parts.slice(1))
    .filter(Boolean);
  const inKubernetes = searches.some((domain) => (
    domain === 'cluster.local' || domain.endsWith('.svc.cluster.local')
  ));
  const configured = override.split(/[\s,]+/).filter(Boolean);
  if (!configured.length && !inKubernetes) return [];

  const discovered = lines
    .map((line) => line.replace(/#.*/, '').trim().split(/\s+/))
    .filter((parts) => parts[0] === 'nameserver' && parts[1])
    .map((parts) => parts[1]!);
  const servers = [...new Set(configured.length ? configured : discovered)]
    .filter((server) => !server.startsWith('127.') && server !== '::1');
  if (!servers.length) return [];

  return [
    ...servers.flatMap((server) => ['--dns', server]),
    ...searches.flatMap((domain) => ['--dns-search', domain]),
  ];
}

/** Ensure the agent Docker network exists. User-defined networks get Docker's internal DNS. */
function ensureAgentNetwork(): string {
  try {
    execSync(`${resolveDockerPath()} network inspect ${AGENT_NETWORK} 2>/dev/null`, { stdio: 'ignore' });
    // MTU is baked at network creation; if an existing network lacks it, flag
    // loudly — fixing requires detaching containers + recreating the network.
    try {
      const mtu = execSync(
        `${resolveDockerPath()} network inspect ${AGENT_NETWORK} --format '{{index .Options "com.docker.network.driver.mtu"}}'`,
        { encoding: 'utf-8' },
      ).trim();
      if (!mtu || mtu === '<no value>') {
        console.warn(`[daemon] ${AGENT_NETWORK} network has NO mtu option (frames >1450 blackhole over VXLAN) — recreate it: stop agents, docker network rm ${AGENT_NETWORK}, restart daemon`);
      }
    } catch { /* inspect format best-effort */ }
  } catch {
    execSync(
      `${resolveDockerPath()} network create -o com.docker.network.driver.mtu=${AGENT_NETWORK_MTU} ${AGENT_NETWORK}`,
      { stdio: 'ignore' },
    );
  }
  return AGENT_NETWORK;
}

/** Resolve the host gateway IP for containers on the agent network.
 * Docker's `host-gateway` always maps to the default bridge gateway, which is wrong
 * when containers run on a custom network. We resolve the actual gateway IP. */
let _hostGateway: string | null = null;
function resolveHostGateway(): string {
  if (_hostGateway) return _hostGateway;
  try {
    const inspect = execSync(
      `${resolveDockerPath()} network inspect ${AGENT_NETWORK} --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'`,
      { encoding: 'utf-8' },
    ).trim();
    if (inspect && inspect !== '') {
      _hostGateway = inspect;
      return _hostGateway;
    }
  } catch { /* fall through */ }
  // Fallback to host-gateway (works on default bridge)
  _hostGateway = 'host-gateway';
  return _hostGateway;
}

/** Discover the platform URL for agent containers. Tries Tailscale FQDN first, falls back to hostname. */
let _platformUrl: string | null = null;
let daemonHttpPort = 8015;
type NormalizedRuntimeEnvironment = NonNullable<AgentInfo['runtimeEnvironment']>;

/**
 * Persist a new backend URL ("platform link"). When `url` is empty / loopback,
 * the daemon switches to local mode (mini-Connect serves chat). Otherwise
 * the URL points at a remote shizuha-connect / shizuha-id stack.
 *
 * Also resets the cached `_platformUrl` so subsequent reads see the change.
 */
export function setPlatformUrl(url: string): void {
  if (inMemoryState) {
    inMemoryState.platformUrl = url || 'http://localhost';
    try { writeDaemonState(inMemoryState); } catch { /* best-effort */ }
  }
  _platformUrl = null;
}

export function resolvePlatformUrl(): string {
  if (_platformUrl) return _platformUrl;
  // Check if we have a configured platform URL (non-localhost/non-loopback)
  if (inMemoryState?.platformUrl
      && inMemoryState.platformUrl !== 'http://localhost'
      && !inMemoryState.platformUrl.includes('127.0.0.1')) {
    _platformUrl = inMemoryState.platformUrl;
    return _platformUrl;
  }
  // Auto-detect via Tailscale FQDN
  try {
    const tsJson = execSync('tailscale status --self --json 2>/dev/null', { timeout: 3000, encoding: 'utf-8' });
    const fqdn = JSON.parse(tsJson)?.Self?.DNSName?.replace(/\.$/, '') ?? '';
    if (fqdn) {
      // Use HTTP for Tailscale (nginx serves HTTP on tailscale network)
      _platformUrl = `http://${fqdn}`;
      return _platformUrl;
    }
  } catch { /* not on Tailscale */ }
  // Fallback to hostname
  _platformUrl = `http://${os.hostname()}`;
  return _platformUrl;
}

function resolveDaemonHttpPort(): string {
  return String(daemonHttpPort);
}

function normalizeRuntimeEnvironment(
  runtime: string | undefined,
  fallback: NormalizedRuntimeEnvironment = 'bare_metal',
): NormalizedRuntimeEnvironment {
  if (!runtime) return fallback;
  if (runtime === 'local') return 'bare_metal';
  if (runtime === 'bare_metal' || runtime === 'container' || runtime === 'restricted_container' || runtime === 'sandbox' || runtime === 'k8s') {
    return runtime;
  }
  return fallback;
}

// CTX-16: detect raw vLLM NodePort URLs (e.g. http://gx10-1:31428/v1).
// Agents configured before the gateway was available may have CORTEX_BASE_URL
// pointing at a GB10 node's NodePort, bypassing usage metering and load balancing.
// The CORTEX_GATEWAY_BASE_URL daemon env override rewrites these to the cortex
// service URL without requiring per-agent config changes.
function isRawVllmNodePort(url: string): boolean {
  try {
    return /^gx10-\d+$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function normalizeLoopbackUrlForContainer(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]') {
      url.hostname = 'host.docker.internal';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return rawUrl.replace(/^http:\/\/localhost(?=[:/]|$)/, 'http://host.docker.internal')
      .replace(/^https:\/\/localhost(?=[:/]|$)/, 'https://host.docker.internal')
      .replace(/^http:\/\/127\.0\.0\.1(?=[:/]|$)/, 'http://host.docker.internal')
      .replace(/^https:\/\/127\.0\.0\.1(?=[:/]|$)/, 'https://host.docker.internal')
      .replace(/\/+$/, '');
  }
}

function inferProviderEnvValue(envName: string, providerName: string, configKey: string, agentId?: string): string | undefined {
  const candidates: string[] = [];
  const globalValue = process.env[envName]?.trim();
  if (globalValue) candidates.push(globalValue);
  const configValue = readProviderConfigValue(providerName, configKey);
  if (configValue) candidates.push(configValue);
  for (const agent of discoveredAgents) {
    if (agentId && agent.id === agentId) continue;
    const value = agent.env?.[envName]?.trim();
    if (value) candidates.push(value);
  }
  return candidates.find(Boolean);
}

function inferProviderBaseUrl(envName: string, providerName: string, agentId?: string): string | undefined {
  return inferProviderEnvValue(envName, providerName, 'baseUrl', agentId)?.replace(/\/+$/, '');
}

function resolveAgentRuntimeEnv(agent: AgentInfo, runtime: NormalizedRuntimeEnvironment): Record<string, string> {
  const env = { ...(agent.env ?? {}) };
  const usesVllm = (agent.modelFallbacks ?? []).some((entry) => entry.model.startsWith('vllm/'));
  const usesCortex = (agent.modelFallbacks ?? []).some((entry) => isCortexModelId(entry.model));

  if (usesVllm && !env['VLLM_BASE_URL']) {
    const inferred = inferProviderBaseUrl('VLLM_BASE_URL', 'vllm', agent.id);
    if (inferred) env['VLLM_BASE_URL'] = inferred;
  }
  if (usesVllm && !env['VLLM_API_KEY']) {
    const inferred = inferProviderEnvValue('VLLM_API_KEY', 'vllm', 'apiKey', agent.id);
    if (inferred) env['VLLM_API_KEY'] = inferred;
  }

  if (usesCortex && !env['CORTEX_BASE_URL']) {
    const inferred = inferProviderBaseUrl('CORTEX_BASE_URL', 'cortex', agent.id);
    if (inferred) env['CORTEX_BASE_URL'] = inferred;
  }
  if (usesCortex && !env['CORTEX_API_KEY']) {
    const inferred = inferProviderEnvValue('CORTEX_API_KEY', 'cortex', 'apiKey', agent.id);
    if (inferred) env['CORTEX_API_KEY'] = inferred;
  }

  if (runtime !== 'bare_metal' && env['VLLM_BASE_URL']) {
    env['VLLM_BASE_URL'] = normalizeLoopbackUrlForContainer(env['VLLM_BASE_URL']);
  }
  if (runtime !== 'bare_metal' && env['CORTEX_BASE_URL']) {
    env['CORTEX_BASE_URL'] = normalizeLoopbackUrlForContainer(env['CORTEX_BASE_URL']);
  }

  // CTX-16: if CORTEX_BASE_URL is a raw vLLM NodePort, override it with the
  // cortex gateway so all traffic is metered and load-balanced. The NodePort
  // stays reachable as a break-glass fallback but is never the default path.
  // Set CORTEX_GATEWAY_BASE_URL in the daemon env (e.g. http://shizuha-cortex:8040/v1).
  if (env['CORTEX_BASE_URL'] && isRawVllmNodePort(env['CORTEX_BASE_URL'])) {
    const gateway = process.env['CORTEX_GATEWAY_BASE_URL']?.trim().replace(/\/+$/, '');
    if (gateway) {
      env['CORTEX_BASE_URL'] = gateway;
    }
  }

  return env;
}

function getPrimaryExecutionMethod(agent: AgentInfo): string {
  return agent.executionMethod ?? agent.modelFallbacks?.[0]?.method ?? 'shizuha';
}

function isReadonlySqliteError(err: unknown): boolean {
  return /readonly database/i.test((err as Error)?.message ?? '');
}

/** Session-scoped tables that must die together on reset.
 *  Leaving `session_wire_prefix` / provider-prefix snapshots behind makes the
 *  next process resume replay the exact poisoned transcript (Saki 2026-08-14:
 *  979 messages / 294k tokens after a pod recycle). Keep this list aligned
 *  with `K8S_SESSION_RESET_SCRIPT` in k8s-backend.ts. */
export const SESSION_SCOPED_RESET_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'messages_fts', column: 'session_id' },
  { table: 'messages', column: 'session_id' },
  { table: 'session_message_transcript', column: 'session_id' },
  { table: 'session_interrupt_checkpoints', column: 'session_id' },
  { table: 'session_wire_prefix', column: 'session_id' },
  { table: 'session_provider_prefix_snapshots', column: 'session_id' },
  { table: 'session_provider_prefix_heads', column: 'session_id' },
  { table: 'session_context_token_anchors', column: 'session_id' },
  { table: 'session_inbound_processing', column: 'session_id' },
  { table: 'session_recovery_heads', column: 'session_id' },
  { table: 'session_recovery_deferred', column: 'session_id' },
  { table: 'sessions', column: 'id' },
];

export function resetSqliteSessionDatabase(dbPath: string, sessionId: string): void {
  if (!fs.existsSync(dbPath)) return;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    const sessionDb = db;
    const hasTable = (name: string): boolean =>
      !!sessionDb.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
    const tx = sessionDb.transaction(() => {
      for (const { table, column } of SESSION_SCOPED_RESET_TABLES) {
        if (!hasTable(table)) continue;
        sessionDb.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(sessionId);
      }
    });
    tx();
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    if (isReadonlySqliteError(err)) {
      removeSqliteDatabaseFiles(dbPath);
      return;
    }
    throw err;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function removeSqliteDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Check if Docker is available on this system. */
export function isDockerAvailable(): boolean {
  try {
    execSync(`${resolveDockerPath()} info`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Detect NVIDIA GPU (cached). */
let gpuDetected: boolean | null = null;
function hasNvidiaGpu(): boolean {
  if (gpuDetected !== null) return gpuDetected;
  try {
    execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { stdio: 'pipe', timeout: 3000 });
    // Also check nvidia-container-toolkit
    const runtimes = execSync(`${resolveDockerPath()} info --format "{{json .Runtimes}}"`, { timeout: 5000 }).toString();
    gpuDetected = runtimes.includes('nvidia');
    if (gpuDetected) console.log('[daemon] NVIDIA GPU detected — containers will use --gpus all');
    return gpuDetected;
  } catch {
    gpuDetected = false;
    return false;
  }
}

/** Check if the Sysbox runtime is installed. */
export function isSysboxAvailable(): boolean {
  try {
    const output = execSync(`${resolveDockerPath()} info --format "{{json .Runtimes}}"`, { timeout: 5000 }).toString();
    return output.includes('sysbox-runc');
  } catch {
    return false;
  }
}

/** Resolve DinD mode: privileged DinD (uses Docker's internal DNS which resolves Tailscale names). */
export function resolveDindMode(): [boolean, 'sysbox' | 'privileged' | 'none'] {
  if (!isDockerAvailable()) return [false, 'none'];
  // Always use privileged DinD — sysbox containers get DNS from host's legacy
  // resolv.conf instead of Docker's internal resolver (127.0.0.11), which breaks
  // Tailscale hostname resolution (s1.tail.shizuha.com) and causes network
  // isolation issues with internal services.
  return [true, 'privileged'];
}

/**
 * Default agent container image — Ubuntu 24.04 with Node.js 22, common dev tools,
 * and everything agents need (CA certs, git, Python, build-essential, etc.).
 * Built once per daemon lifetime, cached locally. Multi-arch (amd64 + arm64).
 */
const AGENT_IMAGE = 'shizuha-agent-runtime:latest';
const AGENT_IMAGE_VERSION = '4'; // Bump to force rebuild (v4: route npm/pip installs through Shizuha package caches)
const AGENT_DOCKERFILE = `
FROM ubuntu:24.04

ARG PACKAGE_CACHE_HOST=100.64.0.3
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_MAJOR=22
ENV NPM_CONFIG_REGISTRY=http://\${PACKAGE_CACHE_HOST}:30512/
ENV PIP_INDEX_URL=http://\${PACKAGE_CACHE_HOST}:30511/simple/
ENV PIP_TRUSTED_HOST=\${PACKAGE_CACHE_HOST}
RUN printf 'registry=http://%s:30512/\\n' "\${PACKAGE_CACHE_HOST}" > /etc/npmrc \\
  && printf '[global]\\nindex-url = http://%s:30511/simple/\\ntrusted-host = %s\\n' "\${PACKAGE_CACHE_HOST}" "\${PACKAGE_CACHE_HOST}" > /etc/pip.conf

# ── Layer 1: System packages + Node.js 22 ──
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates curl gnupg git openssh-client \\
    python3 python3-pip python3-venv python3-dev \\
    build-essential pkg-config \\
    jq wget unzip tar gzip bzip2 xz-utils \\
    ripgrep fd-find tree less file procps htop \\
    sqlite3 libsqlite3-dev \\
    libffi-dev libssl-dev \\
    sudo lsb-release software-properties-common \\
  && mkdir -p /etc/apt/keyrings \\
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \\
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_\${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \\
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/etc/apt/keyrings/gh.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \\
  && apt-get update && apt-get install -y --no-install-recommends nodejs gh \\
  && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Python packages ──
RUN pip3 install --no-cache-dir --break-system-packages --ignore-installed \\
    pytest pytest-timeout pytest-asyncio pytest-django \\
    django djangorestframework django-cors-headers \\
    flask requests httpx aiohttp websockets \\
    sqlalchemy aiosqlite redis celery \\
    pydantic beautifulsoup4 lxml cryptography \\
    black ruff mypy pylint \\
    pyyaml toml python-dotenv \\
    Pillow numpy pandas

# ── Layer 3: Node.js global tools ──
# Pin @openai/codex to 0.144.0 (gpt-5.6-sol + ultra effort): npm "latest" 0.118.0 mis-routed
# ChatGPT-account auth to wss://api.openai.com/v1/responses → 401 → empty turns.
# 0.144.x keeps chatgpt.com/backend-api/codex/responses routing (verified working).
RUN npm install -g @anthropic-ai/claude-code @openai/codex@0.144.0 openclaw \\
    typescript tsx prettier eslint

# ── Layer 4: Convenience aliases ──
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd 2>/dev/null || true \\
  && ln -sf /usr/bin/python3 /usr/local/bin/python 2>/dev/null || true

# Non-root agent user (UID 1000 may already be taken by ubuntu user)
RUN existing_user=$(getent passwd 1000 | cut -d: -f1) \\
  && if [ -n "$existing_user" ] && [ "$existing_user" != "agent" ]; then \\
       usermod -l agent -d /home/agent -m "$existing_user" \\
       && groupmod -n agent "$existing_user" 2>/dev/null || true; \\
     elif [ -z "$existing_user" ]; then \\
       useradd -m -s /bin/bash -u 1000 agent; \\
     fi \\
  && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/agent

WORKDIR /workspace
`.trim();

const DIND_IMAGE = 'shizuha-dind:latest';
const DIND_IMAGE_VERSION = '29'; // Bump to force rebuild (v29: Claude auth/quota unavailable telemetry)
const DIND_DOCKERFILE = `
FROM ubuntu:24.04

ARG PACKAGE_CACHE_HOST=100.64.0.3
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_MAJOR=22
ENV NPM_CONFIG_REGISTRY=http://\${PACKAGE_CACHE_HOST}:30512/
ENV PIP_INDEX_URL=http://\${PACKAGE_CACHE_HOST}:30511/simple/
ENV PIP_TRUSTED_HOST=\${PACKAGE_CACHE_HOST}
RUN printf 'registry=http://%s:30512/\\n' "\${PACKAGE_CACHE_HOST}" > /etc/npmrc \\
  && printf '[global]\\nindex-url = http://%s:30511/simple/\\ntrusted-host = %s\\n' "\${PACKAGE_CACHE_HOST}" "\${PACKAGE_CACHE_HOST}" > /etc/pip.conf

# ── Layer 1: System packages + Node.js + Docker ──
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates curl gnupg git openssh-client \\
    python3 python3-pip python3-venv python3-dev \\
    build-essential pkg-config \\
    jq wget unzip tar gzip bzip2 xz-utils \\
    ripgrep fd-find tree less file procps htop \\
    sqlite3 libsqlite3-dev \\
    libffi-dev libssl-dev \\
    sudo lsb-release software-properties-common \\
    tini \\
  && mkdir -p /etc/apt/keyrings \\
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \\
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_\${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \\
  && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \\
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/etc/apt/keyrings/gh.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \\
  && apt-get update && apt-get install -y --no-install-recommends \\
    nodejs gh docker-ce docker-ce-cli containerd.io docker-compose-plugin \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH=$(dpkg --print-architecture) \\
  && RUNC_ARCH=$([ "$ARCH" = "amd64" ] && echo "amd64" || echo "arm64") \\
  && curl -fsSL "https://github.com/opencontainers/runc/releases/download/v1.3.0/runc.\${RUNC_ARCH}" -o /usr/bin/runc \\
  && chmod +x /usr/bin/runc

# ── Layer 2: Python packages ──
RUN pip3 install --no-cache-dir --break-system-packages --ignore-installed \\
    pytest pytest-timeout pytest-asyncio pytest-django \\
    django djangorestframework django-cors-headers \\
    flask requests httpx aiohttp websockets \\
    sqlalchemy aiosqlite redis celery \\
    pydantic beautifulsoup4 lxml cryptography \\
    black ruff mypy pylint \\
    pyyaml toml python-dotenv \\
    Pillow numpy pandas \\
    "mcp[cli]>=1.0"

# ── Layer 3: Browser dependencies for CDP automation ──
# Playwright installs Chromium later. On amd64 we also add Google Chrome for
# stealthier browser sessions; on arm64 we skip it because Google's .deb is
# amd64-only.
RUN apt-get update && apt-get install -y --no-install-recommends \\
    fonts-liberation fonts-noto-color-emoji fonts-dejavu-core fonts-noto libsecret-1-0 \\
    libgbm1 libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 \\
    libxdamage1 libxrandr2 libcups2 libasound2t64 libpangocairo-1.0-0 \\
    libgtk-3-0 libxshmfence1 xvfb openbox fontconfig \\
  && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \\
       wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb \\
       && (dpkg -i /tmp/chrome.deb 2>/dev/null || apt-get install -f -y --no-install-recommends); \\
     else \\
       echo "Skipping Google Chrome install on $(dpkg --print-architecture)"; \\
     fi \\
  && rm -f /tmp/chrome.deb \\
  && fc-cache -f 2>/dev/null \\
  && rm -rf /var/lib/apt/lists/*

# ── Layer 4: Node.js global tools ──
# Pin @openai/codex to 0.144.0 (gpt-5.6-sol + ultra effort; see note): npm "latest" 0.118.0
# mis-routed ChatGPT auth to api.openai.com → 401 → empty turns. 0.144.x keeps backend-api routing.
RUN npm install -g @anthropic-ai/claude-code @openai/codex@0.144.0 openclaw \\
    typescript tsx prettier eslint playwright \\
  && npx playwright install chromium --with-deps 2>/dev/null || true \\
  && curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin \\
  && ln -sfn /usr/local/bin/agy /usr/local/bin/antigravity
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# ── Layer 4: Convenience aliases & config ──
RUN ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose 2>/dev/null || true \\
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd 2>/dev/null || true \\
  && ln -sf /usr/bin/python3 /usr/local/bin/python 2>/dev/null || true

# Non-root agent user (UID 1000 may already be taken by ubuntu user)
# Must be added to docker group so agent can access /var/run/docker.sock
RUN existing_user=$(getent passwd 1000 | cut -d: -f1) \\
  && if [ -n "$existing_user" ] && [ "$existing_user" != "agent" ]; then \\
       usermod -l agent -d /home/agent -m "$existing_user" \\
       && groupmod -n agent "$existing_user" 2>/dev/null || true; \\
     elif [ -z "$existing_user" ]; then \\
       useradd -m -s /bin/bash -u 1000 agent; \\
     fi \\
  && usermod -aG docker agent \\
  && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/agent

# ── Layer 5: BAKE the shizuha runtime dependency tree into the image ──
# Each container gets its OWN node_modules — NEVER a shared host bind-mount.
# A shared host node_modules is a single point of corruption: one bad
# \`npm install\` on the host (which partially wiped better-sqlite3 on
# 2026-06-17) instantly breaks EVERY agent + the host CLI. Baking the
# externals here (esbuild marks better-sqlite3/pino/ws/@modelcontextprotocol
# /sdk/openai/@anthropic-ai/sdk/tiktoken/playwright as external) makes each
# image immutable and self-contained. \`npm ci\` compiles native deps natively.
WORKDIR /opt/shizuha
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY entrypoint.sh /usr/local/bin/dind-entrypoint.sh
RUN chmod +x /usr/local/bin/dind-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/dind-entrypoint.sh"]
`.trim();

const DIND_ENTRYPOINT = `#!/bin/bash
set -euo pipefail

PACKAGE_CACHE_HOST="\${SHIZUHA_PACKAGE_CACHE_HOST:-\${PACKAGE_CACHE_HOST:-100.64.0.3}}"
printf 'registry=http://%s:30512/\\n' "$PACKAGE_CACHE_HOST" > /etc/npmrc 2>/dev/null || true
printf '[global]\\nindex-url = http://%s:30511/simple/\\ntrusted-host = %s\\n' "$PACKAGE_CACHE_HOST" "$PACKAGE_CACHE_HOST" > /etc/pip.conf 2>/dev/null || true
export NPM_CONFIG_REGISTRY="\${NPM_CONFIG_REGISTRY:-http://\${PACKAGE_CACHE_HOST}:30512/}"
export PIP_INDEX_URL="\${PIP_INDEX_URL:-http://\${PACKAGE_CACHE_HOST}:30511/simple/}"
export PIP_TRUSTED_HOST="\${PIP_TRUSTED_HOST:-$PACKAGE_CACHE_HOST}"

# Remap the in-container agent user to the host daemon UID/GID when the daemon
# is non-root. This lets bind-mounted auth/session paths stay private (0600/0700)
# on the host while remaining accessible to runuser -u agent inside the container.
TARGET_AGENT_UID="\${SHIZUHA_CONTAINER_AGENT_UID:-1000}"
TARGET_AGENT_GID="\${SHIZUHA_CONTAINER_AGENT_GID:-1000}"
CURRENT_AGENT_UID=$(id -u agent)
CURRENT_AGENT_GID=$(id -g agent)
if [ "$TARGET_AGENT_UID" != "$CURRENT_AGENT_UID" ] || [ "$TARGET_AGENT_GID" != "$CURRENT_AGENT_GID" ]; then
  if [ "$TARGET_AGENT_GID" != "$CURRENT_AGENT_GID" ]; then
    existing_group=$(getent group "$TARGET_AGENT_GID" | cut -d: -f1 || true)
    if [ -n "$existing_group" ] && [ "$existing_group" != "agent" ]; then
      usermod -g "$TARGET_AGENT_GID" agent
    else
      groupmod -g "$TARGET_AGENT_GID" agent
    fi
  fi
  if [ "$TARGET_AGENT_UID" != "$CURRENT_AGENT_UID" ]; then
    usermod -u "$TARGET_AGENT_UID" agent
  fi
  chown -R agent:$(id -gn agent) /home/agent 2>/dev/null || true
fi

# ── PLAT-1364: workspace cron dir must be writable by the runtime user ──
# The cron store writes /workspace/cron/jobs.json(.tmp). /workspace is a mounted
# volume; if /workspace/cron was created root-owned (a root-stage process, or a
# root-owned dir on the host volume), the uid-1000 "agent" process can read but
# not write it -> legacy cron jobs fail with EACCES on jobs.json.tmp (PLAT-1364).
# This entrypoint runs as root (before dropping to agent), so it can repair a
# root-owned dir. Unconditional + idempotent; runs every boot before cron MCP.
mkdir -p /workspace/cron 2>/dev/null || true
chown -R agent:$(id -gn agent) /workspace/cron 2>/dev/null || true

# ── Git identity & credential setup ──
# Configures git user, HTTPS credential helper, and gh CLI auth from env vars.
# AGENT_NAME, AGENT_EMAIL set by the daemon; GITHUB_TOKEN injected via credentials.
# Uses --system so config applies to ALL users (entrypoint runs as root, but
# the agent process runs as uid 1000 "agent" — --global would only set root's).
if [ -n "\${AGENT_NAME:-}" ]; then
  git config --system user.name "\${AGENT_NAME}"
  git config --system user.email "\${AGENT_EMAIL:-\${AGENT_USERNAME:-agent}@shizuha.com}"
  git config --system init.defaultBranch main
fi

# HTTPS credential helper: uses GITHUB_TOKEN for github.com, GITLAB_TOKEN for gitlab.com
if [ -n "\${GITHUB_TOKEN:-}" ]; then
  git config --system credential.https://github.com.helper '!f() { echo "username=x-access-token"; echo "password=\${GITHUB_TOKEN}"; }; f'
fi
if [ -n "\${GITLAB_TOKEN:-}" ]; then
  git config --system credential.https://gitlab.com.helper '!f() { echo "username=oauth2"; echo "password=\${GITLAB_TOKEN}"; }; f'
fi

# gh CLI auth (if gh is installed — pre-installed in DinD image)
if command -v gh &>/dev/null && [ -n "\${GITHUB_TOKEN:-}" ]; then
  echo "\${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
fi

# Start Docker daemon in the background if DinD is enabled
if [ "\${DIND_ENABLED:-1}" = "1" ]; then
  # Clean stale state from previous container runs. Overlay2 check directories
  # and metacopy test dirs become read-only artifacts when containers are killed
  # ungracefully, causing "read-only file system" errors on next dockerd start.
  rm -f /var/run/docker.pid /var/run/docker.sock 2>/dev/null || true
  rm -rf /var/lib/docker/network 2>/dev/null || true
  rm -rf /var/lib/docker/check-overlayfs-support* 2>/dev/null || true
  rm -rf /var/lib/docker/metacopy-check* 2>/dev/null || true

  # Write daemon config — merge registry mirrors from host settings.json if available
  # Settings are mounted at /root/.shizuha/settings.json (read-only from host)
  # Changes in dashboard settings take effect on next agent container restart
  mkdir -p /etc/docker
  if command -v python3 &>/dev/null && [ -f /root/.shizuha/settings.json ]; then
    python3 -c "
import json
base = {'log-driver':'json-file','log-opts':{'max-size':'10m','max-file':'3'},'live-restore':True,'userland-proxy':False,'storage-driver':'overlay2'}
try:
    with open('/root/.shizuha/settings.json') as f:
        s = json.load(f)
    if s.get('registryMirrors'): base['registry-mirrors'] = s['registryMirrors']
    if s.get('insecureRegistries'): base['insecure-registries'] = s['insecureRegistries']
except: pass
with open('/etc/docker/daemon.json','w') as f:
    json.dump(base, f)
" 2>/dev/null
  else
    cat > /etc/docker/daemon.json <<'DJSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true,
  "userland-proxy": false,
  "storage-driver": "overlay2"
}
DJSON
  fi

  echo "[dind] Starting Docker daemon..."
  dockerd > /tmp/dockerd.log 2>&1 &
  DOCKER_PID=$!

  # Wait for daemon (max 30s)
  waited=0
  while [ $waited -lt 30 ]; do
    if docker info > /dev/null 2>&1; then
      echo "[dind] Docker daemon ready after \${waited}s"
      break
    fi
    if ! kill -0 $DOCKER_PID 2>/dev/null; then
      echo "[dind] WARNING: dockerd exited (attempt 1). Cleaning state and retrying..."
      rm -rf /var/lib/docker/network /var/lib/docker/buildkit 2>/dev/null || true
      rm -rf /var/lib/docker/check-overlayfs-support* /var/lib/docker/metacopy-check* 2>/dev/null || true
      rm -f /var/run/docker.pid /var/run/docker.sock 2>/dev/null || true
      dockerd > /tmp/dockerd.log 2>&1 &
      DOCKER_PID=$!
      sleep 2
      if docker info > /dev/null 2>&1; then
        echo "[dind] Docker daemon ready (after cleanup retry)"
      else
        echo "[dind] WARNING: dockerd still failing. Log:"
        tail -10 /tmp/dockerd.log 2>/dev/null || true
        echo "[dind] Continuing without Docker..."
      fi
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if [ $waited -ge 30 ]; then
    echo "[dind] WARNING: Docker not ready in 30s, continuing without it"
  fi
fi

# Start Xvfb virtual display if Google Chrome is installed (for browser automation).
# This runs BEFORE the agent process so browser(mode="human") can reuse the existing display.
if command -v google-chrome-stable &>/dev/null && command -v Xvfb &>/dev/null; then
  export DISPLAY=:99
  if ! pgrep -x Xvfb >/dev/null 2>&1; then
    Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp +extension GLX +extension RANDR &>/dev/null &
    sleep 1
    if command -v openbox &>/dev/null; then
      openbox --sm-disable &>/dev/null &
    fi
    echo "[dind] Xvfb started on :99"
  fi
fi

# ── Claude Code session directory fixup ──
# The session dir (/home/agent/.claude/) is bind-mounted from the host.
# Claude Code expects .claude.json at $HOME/.claude.json (NOT inside .claude/).
# Symlink it if it exists in the mounted dir but not in $HOME.
CLAUDE_DIR="/home/agent/.claude"
CLAUDE_JSON="/home/agent/.claude.json"
if [ ! -f "$CLAUDE_JSON" ] && [ -f "$CLAUDE_DIR/.claude.json" ]; then
  ln -sf "$CLAUDE_DIR/.claude.json" "$CLAUDE_JSON"
fi
# Also ensure the agent user owns the claude dir (bare_metal → container migration)
chown -R agent:agent "$CLAUDE_DIR" 2>/dev/null || true
chown agent:agent "$CLAUDE_JSON" 2>/dev/null || true

# ── Claude Code version reporting ──
# Tool versions are baked into the image. Boot-time npm/update work is expensive
# and can keep new agents from becoming healthy, so refresh by rebuilding the
# image instead. Emergency online update remains opt-in for break-glass use.
if [ "\${SHIZUHA_CLAUDE_UPDATE_ON_BOOT:-0}" = "1" ] && command -v claude &>/dev/null; then
  ( timeout 90 claude update >/dev/null 2>&1 \
    || timeout 90 npm install -g @anthropic-ai/claude-code@latest >/dev/null 2>&1 ) || true
fi
if command -v claude &>/dev/null; then
  echo "[entrypoint] claude-code version: $(claude --version 2>/dev/null || echo unknown) (agent=\${AGENT_USERNAME:-unknown})"
fi

# Exec the command via tini (zombie reaper). On privileged DinD, Docker's --init
# already provides tini as PID 1; in that case /usr/bin/tini detects it's not PID 1
# and execs directly. On Sysbox (which has its own init), tini still reaps orphans
# from the bridge's subprocess tree (codex exec → docker-compose → containerd-shim).
exec /usr/bin/tini -- "$@"
`.trim();

const NON_DIND_ENTRYPOINT_CONTAINER = '/usr/local/bin/shizuha-agent-entrypoint.sh';
const NON_DIND_ENTRYPOINT = `#!/bin/bash
set -euo pipefail

PACKAGE_CACHE_HOST="\${SHIZUHA_PACKAGE_CACHE_HOST:-\${PACKAGE_CACHE_HOST:-100.64.0.3}}"
if [ "$(id -u)" = "0" ]; then
  printf 'registry=http://%s:30512/\\n' "$PACKAGE_CACHE_HOST" > /etc/npmrc 2>/dev/null || true
  printf '[global]\\nindex-url = http://%s:30511/simple/\\ntrusted-host = %s\\n' "$PACKAGE_CACHE_HOST" "$PACKAGE_CACHE_HOST" > /etc/pip.conf 2>/dev/null || true
fi
export NPM_CONFIG_REGISTRY="\${NPM_CONFIG_REGISTRY:-http://\${PACKAGE_CACHE_HOST}:30512/}"
export PIP_INDEX_URL="\${PIP_INDEX_URL:-http://\${PACKAGE_CACHE_HOST}:30511/simple/}"
export PIP_TRUSTED_HOST="\${PIP_TRUSTED_HOST:-$PACKAGE_CACHE_HOST}"

# Lightweight equivalent of the DinD entrypoint's agent UID/GID remap for
# restricted_container/sandbox/plain-agent images. Those paths do not run the
# DinD entrypoint, but PLAT-86 mounts Codex/Gemini homes as private 0700/0600
# host-owned paths. Recreate the agent passwd entry with the host daemon's
# numeric IDs so runuser -u agent can still traverse those private mounts
# without making token/session files world-readable.
if [ "$(id -u)" = "0" ]; then
  TARGET_AGENT_UID="\${SHIZUHA_CONTAINER_AGENT_UID:-1000}"
  TARGET_AGENT_GID="\${SHIZUHA_CONTAINER_AGENT_GID:-1000}"

  if ! getent group "$TARGET_AGENT_GID" >/dev/null 2>&1; then
    sed -i '/^agent:/d' /etc/group 2>/dev/null || true
    echo "agent:x:$TARGET_AGENT_GID:" >> /etc/group
  fi

  sed -i '/^agent:/d' /etc/passwd 2>/dev/null || true
  echo "agent:x:$TARGET_AGENT_UID:$TARGET_AGENT_GID:Shizuha Agent:/home/agent:/bin/bash" >> /etc/passwd
  if [ -w /etc/shadow ]; then
    sed -i '/^agent:/d' /etc/shadow 2>/dev/null || true
    echo 'agent:*:19000:0:99999:7:::' >> /etc/shadow
  fi
  mkdir -p /home/agent
  chmod 755 /home/agent 2>/dev/null || true
fi

exec "$@"
`.trim();

function ensureNonDindEntrypointScript(shizuhaHome: string): string {
  const scriptDir = path.join(shizuhaHome, '.shizuha', 'runtime');
  fs.mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(scriptDir, 'shizuha-agent-entrypoint.sh');
  fs.writeFileSync(scriptPath, NON_DIND_ENTRYPOINT + '\n', { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  return scriptPath;
}

/** Resolve hostnames to IPv4 and return --add-host docker args.
 * Rust HTTP clients (Codex CLI) don't fall back from IPv6 to IPv4,
 * so we pin DNS via /etc/hosts in the container. */
function resolveHostsIPv4(hostnames: string[]): string[] {
  const args: string[] = [];
  for (const hostname of hostnames) {
    try {
      const result = execSync(`dig +short A ${hostname} 2>/dev/null || getent ahostsv4 ${hostname} 2>/dev/null | head -1 | awk '{print $1}'`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      const ip = result.split('\n').find((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line.trim()));
      if (ip) {
        args.push('--add-host', `${hostname}:${ip.trim()}`);
      }
    } catch {
      // DNS resolution failed — skip, container will use its own resolver
    }
  }
  return args;
}


/** Find a reachable IPv4 for github.com by probing HTTPS/TLS connectivity.
 * GitHub's anycast fleet has intermittent reachability from certain network
 * paths; some IPs get TCP RST mid-transfer. Probes DNS result plus known
 * fallbacks via a full HTTPS request and pins the container /etc/hosts to
 * the first responsive IP, avoiding mid-clone resets. */
/** Find reachable IPv4s for GitHub's two distinct IP pools and pin them via
 * container /etc/hosts. GitHub runs separate anycast fleets for git operations
 * (github.com + codeload.github.com) and for API/GraphQL (api.github.com);
 * an IP that serves one may return 301 or RST for the other, so both pools
 * need independent probes (PLAT-399). */
function resolveGitHubHostOverride(): string[] {
  // Separate fallback pools — the two fleets use disjoint IP ranges.
  const GIT_FALLBACK_IPS = ['140.82.112.4', '140.82.113.4', '20.200.245.247', '20.207.73.84'];
  const API_FALLBACK_IPS = ['140.82.114.5', '140.82.116.5', '140.82.112.5', '140.82.113.5'];

  function resolveHostIps(hostname: string): string[] {
    try {
      const out = execSync(
        `dig +short A ${hostname} 2>/dev/null || getent ahostsv4 ${hostname} 2>/dev/null | head -1 | awk '{print $1}'`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      return out.split('\n').filter((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()));
    } catch { return []; }
  }

  function probeIp(hostname: string, path: string, ip: string, expectCode?: string): boolean {
    try {
      const code = execSync(
        `curl --connect-timeout 3 --max-time 5 -s -o /dev/null -w '%{http_code}' --resolve '${hostname}:443:${ip.trim()}' https://${hostname}${path}`,
        { encoding: 'utf-8', timeout: 8000 },
      ).trim();
      return expectCode ? code === expectCode : (!!code && code !== '000');
    } catch { return false; }
  }

  const addHosts: string[] = [];

  // Pass 1 — git clone / codeload path (github.com + codeload.github.com)
  for (const ip of [...resolveHostIps('github.com'), ...GIT_FALLBACK_IPS]) {
    if (probeIp('github.com', '/', ip)) {
      addHosts.push('--add-host', `github.com:${ip.trim()}`, '--add-host', `codeload.github.com:${ip.trim()}`);
      break;
    }
  }

  // Pass 2 — gh CLI / GraphQL / REST API path (api.github.com)
  // Uses /zen as a lightweight 200-OK probe; this pool has a separate IP range
  // from the git/web fleet — a single probe cannot cover both (PLAT-399).
  for (const ip of [...resolveHostIps('api.github.com'), ...API_FALLBACK_IPS]) {
    if (probeIp('api.github.com', '/zen', ip, '200')) {
      addHosts.push('--add-host', `api.github.com:${ip.trim()}`);
      break;
    }
  }

  return addHosts; // may be empty if both pools unreachable; container falls back to DNS
}

/** Cache agent image build result so we only attempt once per daemon lifetime. */
let agentImageResult: boolean | null = null;


/** Ensure the shizuha-agent-runtime image is built. Returns true if available. */
export function ensureAgentImage(): boolean {
  if (agentImageResult !== null) return agentImageResult;
  const versionLabel = `shizuha.agent.version=${AGENT_IMAGE_VERSION}`;
  try {
    const inspectOut = execSync(
      `${resolveDockerPath()} image inspect --format '{{index .Config.Labels "shizuha.agent.version"}}' ${AGENT_IMAGE} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (inspectOut === AGENT_IMAGE_VERSION) { agentImageResult = true; return true; }
    console.log(`[daemon] Agent image version mismatch (have: ${inspectOut || 'none'}, want: ${AGENT_IMAGE_VERSION}). Rebuilding...`);
  } catch {
    // Image doesn't exist
  }

  console.log('[daemon] Building shizuha-agent-runtime image (this may take 5-10 min on first run)...');
  const buildDir = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agent-build');
  fs.mkdirSync(buildDir, { recursive: true });
  const dockerfile = AGENT_DOCKERFILE + `\nLABEL shizuha.agent.version="${AGENT_IMAGE_VERSION}"`;
  fs.writeFileSync(path.join(buildDir, 'Dockerfile'), dockerfile);
  try {
    const buildEnv = { ...process.env };
    const packageCacheHost = buildEnv['SHIZUHA_PACKAGE_CACHE_HOST'] ?? buildEnv['PACKAGE_CACHE_HOST'] ?? '100.64.0.3';
    if (process.platform === 'darwin') {
      const extraPaths = [
        '/Applications/Docker.app/Contents/Resources/bin',
        '/usr/local/bin', '/opt/homebrew/bin',
        path.join(process.env['HOME'] ?? '', '.docker/bin'),
      ];
      buildEnv['PATH'] = [...extraPaths, buildEnv['PATH'] ?? ''].join(':');
    }
    execSync(resolveDockerPath() + ' build --build-arg PACKAGE_CACHE_HOST=' + packageCacheHost + ' -t ' + AGENT_IMAGE + ' ' + buildDir, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 900_000, // 15 min (larger image)
      env: buildEnv,
    });
    console.log('[daemon] shizuha-agent-runtime image built successfully');
    agentImageResult = true;
    return true;
  } catch (err) {
    console.error('[daemon] Failed to build agent image: ' + (err as Error).message);
    console.log('[daemon] Falling back to node:22 (full Debian) image');
    agentImageResult = false;
    return false;
  }
}

/** Cache DinD build result so we only attempt once per daemon lifetime. */
let dindBuildResult: boolean | null = null;

/** Ensure the shizuha-dind Docker image is built. Returns true if available. */
export function ensureDindImage(): boolean {
  if (dindBuildResult !== null) return dindBuildResult;
  // Use a version label to detect when the Dockerfile changes and needs rebuild
  const versionLabel = `shizuha.dind.version=${DIND_IMAGE_VERSION}`;
  try {
    // Check if image exists WITH the correct version label
    const inspectOut = execSync(
      `${resolveDockerPath()} image inspect --format '{{index .Config.Labels "shizuha.dind.version"}}' ${DIND_IMAGE} 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (inspectOut === DIND_IMAGE_VERSION) { dindBuildResult = true; return true; }
    // Image exists but version mismatch — rebuild
    console.log(`[daemon] DinD image version mismatch (have: ${inspectOut || 'none'}, want: ${DIND_IMAGE_VERSION}). Rebuilding...`);
  } catch {
    // Image doesn't exist at all
  }

  // Build the image
  console.log('[daemon] Building shizuha-dind image (this may take 2-5 min on first run)...');
  const buildDir = path.join(process.env['HOME'] ?? '~', '.shizuha', 'dind-build');
  fs.mkdirSync(buildDir, { recursive: true });
  // Append version label to Dockerfile
  const dockerfile = DIND_DOCKERFILE + `\nLABEL shizuha.dind.version="${DIND_IMAGE_VERSION}"`;
  fs.writeFileSync(path.join(buildDir, 'Dockerfile'), dockerfile);
  fs.writeFileSync(path.join(buildDir, 'entrypoint.sh'), DIND_ENTRYPOINT);
  // Copy package manifests into the build context so the image can BAKE its
  // own node_modules (v24+). Root = parent of the dist/ dir holding shizuha.js.
  try {
    const shizuhaRootForBuild = path.dirname(path.dirname(fs.realpathSync(process.argv[1]!)));
    for (const f of ['package.json', 'package-lock.json']) {
      const src = path.join(shizuhaRootForBuild, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(buildDir, f));
      else console.error(`[daemon] WARNING: ${f} not found at ${src} — DinD node_modules bake will fail`);
    }
  } catch (err) {
    console.error('[daemon] Failed to stage package manifests for DinD build: ' + (err as Error).message);
  }
  try {
    // On macOS, Docker Desktop's credential helpers live outside the default
    // PATH (which is minimal under launchd). Extend PATH so docker build can
    // find docker-credential-desktop/osxkeychain when resolving base images.
    const buildEnv = { ...process.env };
    const packageCacheHost = buildEnv['SHIZUHA_PACKAGE_CACHE_HOST'] ?? buildEnv['PACKAGE_CACHE_HOST'] ?? '100.64.0.3';
    if (process.platform === 'darwin') {
      const extraPaths = [
        '/Applications/Docker.app/Contents/Resources/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(process.env['HOME'] ?? '', '.docker/bin'),
      ];
      buildEnv['PATH'] = [...extraPaths, buildEnv['PATH'] ?? ''].join(':');
    }
    execSync(resolveDockerPath() + ' build --build-arg PACKAGE_CACHE_HOST=' + packageCacheHost + ' -t ' + DIND_IMAGE + ' ' + buildDir, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000, // 10 min (larger image now)
      env: buildEnv,
    });
    console.log('[daemon] shizuha-dind image built successfully');
    dindBuildResult = true;
    return true;
  } catch (err) {
    console.error('[daemon] Failed to build shizuha-dind image: ' + (err as Error).message);
    dindBuildResult = false;
    return false;
  }
}

/** Seed agents for first-run — written to agents.json once, then user owns it */
function seedDefaultAgents(): AgentInfo[] {
  const runtime = isDockerAvailable() ? 'container' : 'bare_metal';
  return [
    {
      id: 'local-claude',
      name: 'Claude',
      username: 'claude',
      email: 'claude@local',
      role: 'engineer',
      status: 'active',
      localPort: 8018,
      executionMethod: 'claude_code_server',
      runtimeEnvironment: runtime as AgentInfo['runtimeEnvironment'],
      modelFallbacks: [
        { method: 'claude_code_server', model: 'claude-opus-4-7', thinkingLevel: 'on', reasoningEffort: 'max' },
      ],
      mcpServers: [],
      personalityTraits: { style: 'thorough' },
      skills: ['coding', 'debugging', 'architecture', 'review'],
    },
    {
      id: 'local-shizuha',
      name: 'Shizuha',
      username: 'shizuha',
      email: 'shizuha@local',
      role: 'engineer',
      status: 'active',
      localPort: 8017,
      executionMethod: 'shizuha',
      runtimeEnvironment: runtime as AgentInfo['runtimeEnvironment'],
      modelFallbacks: [
        { method: 'shizuha', model: 'gpt-5.5', reasoningEffort: 'xhigh' },
      ],
      mcpServers: [],
      personalityTraits: { style: 'pragmatic' },
      skills: ['coding', 'debugging', 'devops'],
    },
    {
      id: 'local-codex',
      name: 'Codex',
      username: 'codex',
      email: 'codex@local',
      role: 'engineer',
      status: 'active',
      localPort: 8019,
      executionMethod: 'codex_app_server',
      runtimeEnvironment: runtime as AgentInfo['runtimeEnvironment'],
      modelFallbacks: [
        { method: 'codex_app_server', model: 'gpt-5.5', reasoningEffort: 'xhigh' },
      ],
      mcpServers: [],
      personalityTraits: { style: 'pragmatic' },
      skills: ['coding', 'debugging', 'devops', 'testing'],
    },
    {
      id: 'local-claw',
      name: 'Claw',
      username: 'claw',
      email: 'claw@local',
      role: 'engineer',
      status: 'active',
      localPort: 8020,
      executionMethod: 'openclaw_bridge',
      runtimeEnvironment: runtime as AgentInfo['runtimeEnvironment'],
      modelFallbacks: [
        { method: 'openclaw_bridge', model: 'gpt-5.5', reasoningEffort: 'high' },
      ],
      mcpServers: [],
      personalityTraits: { style: 'resourceful' },
      skills: ['coding', 'debugging', 'devops'],
    },
  ];
}

export function applyFirstRunCredentialPermissionSeed(
  agents: AgentInfo[],
  options: Parameters<typeof migrateAgentCredentialGrants>[2] = {},
): AgentInfo[] {
  return migrateAgentCredentialGrants(agents, new Set(), options).agents;
}

/** Token cache for agents (stored in memory, persisted for respawn) */
const tokenCache = new Map<string, string>();

/** Shizuha ID identity cache — maps agent username → {user_id, is_staff, is_superuser, …} */
const identityCache = new Map<string, AgentIdentity>();

interface PlatformUserRecord {
  id: number;
  email: string;
  username: string;
  is_staff?: boolean;
  is_superuser?: boolean;
  // ADR-0004 phase 1 fields (read by phase-2 identity-guarantee). Older ID-API
  // builds omit profile/is_active → treated as "unknown" (lenient), never a hard fail.
  is_active?: boolean;
  profile?: {
    account_type?: string;
    agent_runtime_id?: string | null;
  } | null;
}

interface InternalAgentIdentityRecord {
  user_id: number;
  username: string;
  email: string;
  account_type: string;
  is_active: boolean;
  is_staff?: boolean;
  is_superuser?: boolean;
  agent_runtime_id?: string | null;
}

interface PlatformAgentRosterRecord {
  id: string;
  username: string;
  email?: string;
  status?: string;
  user_id?: number | null;
}

export interface TrustedCredentialSeedIdentity {
  username: string;
  email: string;
  platformUserId: number;
}

export interface CredentialSeedIdentityPrefetch {
  identities: Map<string, TrustedCredentialSeedIdentity>;
  authoritative: boolean;
}


function platformPaginatedUrl(platformUrl: string, pathAndQuery: string): string {
  return `${platformUrl}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
}

function platformNextUrl(platformUrl: string, next: string | null | undefined): string | null {
  if (!next) return null;
  const platformOrigin = new URL(platformUrl).origin;
  const resolved = new URL(next, platformOrigin);
  if (resolved.origin !== platformOrigin) {
    throw new Error(`off-origin pagination URL ${resolved.origin}`);
  }
  return resolved.toString();
}

/**
 * Build the S10 seed allowlist from authenticated platform roster data only.
 *
 * Local `agents.json` is intentionally not a source of trust: it only selects
 * which already-authenticated platform agent record (same immutable platform
 * record id + username + email) this daemon has locally. Public/internal
 * runtime claim endpoints are deliberately excluded because they are mutable
 * by the agent reconnect path and cannot authorize grant-socket permissions.
 */
export function buildTrustedCredentialSeedIdentitiesFromPlatformRoster(
  localAgents: readonly AgentInfo[],
  platformAgents: readonly PlatformAgentRosterRecord[],
  users: readonly PlatformUserRecord[],
): Map<string, TrustedCredentialSeedIdentity> {
  const trusted = new Map<string, TrustedCredentialSeedIdentity>();
  const userByUsername = new Map(users.map((user) => [user.username, user]));
  const userByEmail = new Map(users.map((user) => [user.email, user]));
  const platformAgentById = new Map<string, PlatformAgentRosterRecord>();
  const platformAgentIdCounts = new Map<string, number>();
  const localAgentIdCounts = new Map<string, number>();

  for (const agent of platformAgents) {
    platformAgentIdCounts.set(agent.id, (platformAgentIdCounts.get(agent.id) ?? 0) + 1);
    if (!platformAgentById.has(agent.id)) {
      platformAgentById.set(agent.id, agent);
    }
  }
  for (const agent of localAgents) {
    localAgentIdCounts.set(agent.id, (localAgentIdCounts.get(agent.id) ?? 0) + 1);
  }

  for (const agent of localAgents) {
    if ((localAgentIdCounts.get(agent.id) ?? 0) !== 1) continue;
    if ((platformAgentIdCounts.get(agent.id) ?? 0) !== 1) continue;

    const platformAgent = platformAgentById.get(agent.id);
    if (!platformAgent) continue;
    if (
      platformAgent.status !== undefined
      && !['active', 'pending', 'provisioning', 'running', 'stopped'].includes(platformAgent.status)
    ) continue;
    if (platformAgent.username !== agent.username) continue;
    if (platformAgent.email !== undefined && platformAgent.email !== agent.email) continue;

    const user = userByUsername.get(agent.username)
      ?? userByEmail.get(agent.email ?? `${agent.username}@shizuha.com`);
    if (!user) continue;
    if (user.username !== agent.username || user.email !== agent.email) continue;
    if (platformAgent.user_id !== undefined && platformAgent.user_id !== null && platformAgent.user_id !== user.id) continue;

    trusted.set(agent.id, {
      username: agent.username,
      email: agent.email,
      platformUserId: user.id,
    });
  }

  return trusted;
}

export function mergeMigratedAgentsIntoStoredRoster(
  storedAgents: readonly AgentInfo[],
  migratedAgents: readonly AgentInfo[],
): AgentInfo[] {
  const migrationKey = (agent: AgentInfo): string => `${agent.id}\0${agent.username}\0${agent.email ?? ''}`;
  const migratedByKey = new Map(migratedAgents.map((agent) => [migrationKey(agent), agent]));
  const seen = new Set<string>();
  const merged = storedAgents.map((agent) => {
    const key = migrationKey(agent);
    seen.add(key);
    const migrated = migratedByKey.get(key);
    if (!migrated) return agent;
    return {
      ...agent,
      credentials: migrated.credentials,
      credentialGrantScopes: migrated.credentialGrantScopes,
      credentialCustomGrantServices: migrated.credentialCustomGrantServices,
      credentialAuditRoles: migrated.credentialAuditRoles,
      credentialPermissionSeedVersion: migrated.credentialPermissionSeedVersion,
    };
  });
  for (const agent of migratedAgents) {
    if (!seen.has(migrationKey(agent))) {
      merged.push(agent);
    }
  }
  return merged;
}

export async function fetchAuthenticatedHiveAgentIdentityRoster(
  platformUrl: string,
  daemonId: string,
  daemonToken: string,
): Promise<{ agents: PlatformAgentRosterRecord[]; authoritative: boolean }> {
  const normalizedDaemonId = daemonId.trim();
  const normalizedDaemonToken = daemonToken.trim();
  if (!normalizedDaemonId || !normalizedDaemonToken) {
    return { agents: [], authoritative: false };
  }

  const response = await fetch(`${platformUrl}/hive/api/v1/fleet/daemon/identity-roster/`, {
    headers: {
      'X-Hive-Daemon-Id': normalizedDaemonId,
      'X-Hive-Daemon-Token': normalizedDaemonToken,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    console.warn(`[daemon] Identity prefetch: Hive identity roster returned ${response.status}; skipping S10 seed trust`);
    return { agents: [], authoritative: false };
  }

  const data = await response.json() as {
    count?: number;
    agents?: PlatformAgentRosterRecord[];
  };
  if (!data || !Array.isArray(data.agents) || data.count !== data.agents.length) {
    console.warn('[daemon] Identity prefetch: Hive identity roster returned a malformed/incomplete payload; skipping S10 seed trust');
    return { agents: [], authoritative: false };
  }

  const seenIds = new Set<string>();
  const seenUsernames = new Set<string>();
  for (const agent of data.agents) {
    if (
      !agent
      || typeof agent.id !== 'string'
      || !agent.id
      || typeof agent.username !== 'string'
      || !agent.username
      || (agent.status !== undefined && typeof agent.status !== 'string')
      || (agent.user_id !== undefined && agent.user_id !== null && !Number.isSafeInteger(agent.user_id))
      || seenIds.has(agent.id)
      || seenUsernames.has(agent.username)
    ) {
      console.warn('[daemon] Identity prefetch: Hive identity roster failed identity validation; skipping S10 seed trust');
      return { agents: [], authoritative: false };
    }
    seenIds.add(agent.id);
    seenUsernames.add(agent.username);
  }
  return { agents: data.agents, authoritative: true };
}

export async function fetchAuthenticatedPlatformUsers(
  platformUrl: string,
  adminToken: string,
): Promise<{ users: PlatformUserRecord[]; authoritative: boolean }> {
  const users: PlatformUserRecord[] = [];
  const seenUserIds = new Set<number>();
  const visitedUrls = new Set<string>();
  const pageLimit = 200;
  let offset = 0;
  let usedSyntheticOffset = false;
  let nextUrl: string | null = platformPaginatedUrl(platformUrl, `/id/api/auth/users/all/?limit=${pageLimit}&offset=${offset}`);

  while (nextUrl) {
    if (visitedUrls.has(nextUrl)) {
      console.warn('[daemon] Identity prefetch: users API pagination loop detected; skipping authoritative S10 seed trust');
      return { users, authoritative: false };
    }
    visitedUrls.add(nextUrl);

    const usersResp = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!usersResp.ok) {
      console.warn(`[daemon] Identity prefetch: users API returned ${usersResp.status}`);
      return { users, authoritative: false };
    }
    const usersData = await usersResp.json() as {
      users?: PlatformUserRecord[];
      results?: PlatformUserRecord[];
      next?: string | null;
      count?: number;
    };
    if (
      !usersData
      || Array.isArray(usersData)
      || (usersData.users === undefined && usersData.results === undefined)
      || (usersData.users !== undefined && !Array.isArray(usersData.users))
      || (usersData.results !== undefined && !Array.isArray(usersData.results))
    ) {
      console.warn('[daemon] Identity prefetch: users API returned malformed page; skipping authoritative S10 seed trust');
      return { users, authoritative: false };
    }
    const pageUsers = usersData.users ?? usersData.results ?? [];
    let newUsers = 0;
    for (const user of pageUsers) {
      if (seenUserIds.has(user.id)) continue;
      seenUserIds.add(user.id);
      users.push(user);
      newUsers++;
    }

    let explicitNext: string | null;
    try {
      explicitNext = platformNextUrl(platformUrl, usersData.next);
    } catch (e) {
      console.warn(`[daemon] Identity prefetch: users API returned unsafe pagination URL: ${(e as Error).message}; skipping authoritative S10 seed trust`);
      return { users, authoritative: false };
    }
    if (explicitNext) {
      nextUrl = explicitNext;
      continue;
    }
    if (usersData.next === null) {
      nextUrl = null;
      continue;
    }

    const count = typeof usersData.count === 'number' ? usersData.count : undefined;
    if (usedSyntheticOffset && newUsers === 0) {
      if (pageUsers.length === 0 && count === undefined) {
        nextUrl = null;
        continue;
      }
      console.warn('[daemon] Identity prefetch: users API ignored pagination offset; skipping authoritative S10 seed trust');
      return { users, authoritative: false };
    }
    if (count !== undefined && users.length < count) {
      offset += pageLimit;
      usedSyntheticOffset = true;
      nextUrl = platformPaginatedUrl(platformUrl, `/id/api/auth/users/all/?limit=${pageLimit}&offset=${offset}`);
      continue;
    }
    if (count === undefined && pageUsers.length >= pageLimit) {
      offset += pageLimit;
      usedSyntheticOffset = true;
      nextUrl = platformPaginatedUrl(platformUrl, `/id/api/auth/users/all/?limit=${pageLimit}&offset=${offset}`);
      continue;
    }
    nextUrl = null;
  }
  return { users, authoritative: true };
}

/**
 * Fetch canonical agent identities from shizuha-id's in-cluster inventory.
 *
 * The runtime controller already has a direct, network-scoped ID service path.
 * Using it avoids coupling startup to a human/staff JWT from another service's
 * auth domain.  This inventory is identity data only; S10 grant seeding still
 * requires the separately authenticated Agent-plane roster cross-check below.
 */
export async function fetchInternalAgentIdentityUsers(
  idInternalUrl: string,
): Promise<{ users: PlatformUserRecord[]; authoritative: boolean }> {
  const idBase = idInternalUrl.trim().replace(/\/+$/, '');
  if (!idBase) return { users: [], authoritative: false };

  try {
    const token = (process.env['FLEET_PROVISIONER_TOKEN'] ?? '').trim();
    const response = await fetch(`${idBase}/api/internal/agents/`, {
      headers: token ? { 'X-Fleet-Provisioner-Token': token } : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.warn(`[daemon] Identity prefetch: internal agent inventory returned ${response.status}`);
      return { users: [], authoritative: false };
    }
    const data = await response.json() as {
      count?: number;
      agents?: InternalAgentIdentityRecord[];
    };
    if (!data || !Array.isArray(data.agents) || data.count !== data.agents.length) {
      console.warn('[daemon] Identity prefetch: internal agent inventory returned a malformed/incomplete payload');
      return { users: [], authoritative: false };
    }

    const seenIds = new Set<number>();
    const seenUsernames = new Set<string>();
    const users: PlatformUserRecord[] = [];
    for (const agent of data.agents) {
      if (
        !Number.isSafeInteger(agent.user_id)
        || agent.user_id <= 0
        || typeof agent.username !== 'string'
        || !agent.username
        || typeof agent.email !== 'string'
        || !agent.email
        || agent.account_type !== 'agent'
        || typeof agent.is_active !== 'boolean'
        || seenIds.has(agent.user_id)
        || seenUsernames.has(agent.username)
      ) {
        console.warn('[daemon] Identity prefetch: internal agent inventory failed identity validation');
        return { users: [], authoritative: false };
      }
      seenIds.add(agent.user_id);
      seenUsernames.add(agent.username);
      users.push({
        id: agent.user_id,
        username: agent.username,
        email: agent.email,
        is_staff: agent.is_staff ?? false,
        is_superuser: agent.is_superuser ?? false,
        is_active: agent.is_active,
        profile: {
          account_type: agent.account_type,
          agent_runtime_id: agent.agent_runtime_id ?? null,
        },
      });
    }
    return { users, authoritative: true };
  } catch (e) {
    console.warn(`[daemon] Identity prefetch: internal agent inventory failed: ${(e as Error).message}`);
    return { users: [], authoritative: false };
  }
}

export function credentialSeedVerificationPlatformUrl(platformUrl = resolvePlatformUrl()): string {
  // Preserve the configured scheme for authenticated S10 trust-root lookups.
  // HTTPS platform links must not be downgraded to plaintext; explicitly HTTP
  // local/Tailscale endpoints remain HTTP because that is what operators
  // configured or what resolvePlatformUrl auto-detected. PlatformClient also
  // accepts /agent/api-prefixed URLs; seed verification needs the origin so it
  // can call both ID and Agent APIs without building /agent/api/id/api paths.
  return platformUrl
    .replace(/\/+$/, '')
    .replace(/\/(?:agent|id|admin)\/api$/, '');
}

/**
 * Pre-fetch user identities/org memberships and authenticated platform agent
 * roster entries.
 *
 * Called once at daemon startup, populates identityCache for all agents.
 */
async function prefetchAllIdentities(
  platformUrlOverride?: string,
  daemonAccessToken?: string,
): Promise<CredentialSeedIdentityPrefetch> {
  let verifiedCredentialSeedIdentities = new Map<string, TrustedCredentialSeedIdentity>();
  let credentialSeedIdentitySourceAuthoritative = false;
  try {
    const platformUrl = credentialSeedVerificationPlatformUrl(platformUrlOverride);
    const authFile = path.join(process.env['HOME'] ?? '/root', '.shizuha', 'auth.json');
    let adminToken = daemonAccessToken || process.env['SHIZUHA_ACCESS_TOKEN'] || '';
    if (fs.existsSync(authFile)) {
      const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      adminToken = adminToken || auth.accessToken || '';
    }
    const internalIdUrl = (process.env['SHIZUHA_ID_INTERNAL_URL'] ?? '').trim();
    let users = internalIdUrl
      ? await fetchInternalAgentIdentityUsers(internalIdUrl)
      : { users: [] as PlatformUserRecord[], authoritative: false };
    if (!users.authoritative) {
      if (!adminToken) {
        console.warn('[daemon] No admin token and no authoritative internal ID inventory — skipping identity prefetch');
        return { identities: verifiedCredentialSeedIdentities, authoritative: credentialSeedIdentitySourceAuthoritative };
      }
      users = await fetchAuthenticatedPlatformUsers(platformUrl, adminToken);
    }
    const allUsers = users.users;
    // Index users by both username and email for flexible matching
    const userByUsername = new Map(allUsers.map(u => [u.username, u]));
    const userByEmail = new Map(allUsers.map(u => [u.email, u]));

    // One call: fetch all org members
    let orgMembers = new Map<number, string>(); // user_id → role
    try {
      if (!adminToken) throw new Error('no daemon admin token');
      const orgResp = await fetch(`${platformUrl}/admin/api/organizations/shizuha/members/`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: AbortSignal.timeout(15000),
      });
      if (orgResp.ok) {
        const orgData = await orgResp.json() as { members?: Array<{ user_id: number; role: string }> };
        orgMembers = new Map((orgData.members ?? []).map(m => [m.user_id, m.role]));
      }
    } catch { /* org lookup optional */ }

    const daemonId = (process.env['SHIZUHA_DAEMON_ID'] ?? '').trim();
    const daemonToken = (process.env['SHIZUHA_DAEMON_LINK_TOKEN'] ?? '').trim();
    if (users.authoritative && daemonId && daemonToken) {
      let platformAgents: PlatformAgentRosterRecord[] = [];
      try {
        const roster = await fetchAuthenticatedHiveAgentIdentityRoster(platformUrl, daemonId, daemonToken);
        platformAgents = roster.agents;
        credentialSeedIdentitySourceAuthoritative = roster.authoritative;
      } catch (e) {
        console.warn(`[daemon] Identity prefetch: Hive identity roster failed: ${(e as Error).message}; skipping S10 seed trust`);
      }

      if (credentialSeedIdentitySourceAuthoritative) {
        verifiedCredentialSeedIdentities = buildTrustedCredentialSeedIdentitiesFromPlatformRoster(
          discoveredAgents,
          platformAgents,
          allUsers,
        );
      }
    } else if (!users.authoritative) {
      console.warn('[daemon] Identity prefetch: users API was non-authoritative; identity cache will use fetched users but S10 seed trust stays disabled');
    } else {
      console.warn('[daemon] Identity prefetch: no daemon-link credential; identity cache hydrated but S10 seed trust stays disabled');
    }

    // Populate cache for all discovered agents — match by username first, then email
    let resolved = 0;
    for (const agent of discoveredAgents) {
      const user = userByUsername.get(agent.username)
        || userByEmail.get(agent.email ?? `${agent.username}@shizuha.com`);
      if (user?.id) {
        const identity: AgentIdentity = {
          userId: user.id,
          isStaff: user.is_staff ?? false,
          isSuperuser: user.is_superuser ?? false,
          orgRole: orgMembers.get(user.id),
          accountType: user.profile?.account_type,
          isActive: user.is_active,
          agentRuntimeId: user.profile?.agent_runtime_id ?? null,
        };
        identityCache.set(agent.username, identity);
        resolved++;
      }
    }
    console.log(
      `[daemon] Identity prefetch: resolved ${resolved}/${discoveredAgents.length} agents ` +
      `(${allUsers.length} users, ${orgMembers.size} org members, ` +
      `${verifiedCredentialSeedIdentities.size} S10 trusted platform roster matches, ` +
      `S10 source authoritative=${credentialSeedIdentitySourceAuthoritative})`,
    );
  } catch (e) {
    console.warn(`[daemon] Identity prefetch failed: ${(e as Error).message}`);
  }
  return {
    identities: verifiedCredentialSeedIdentities,
    authoritative: credentialSeedIdentitySourceAuthoritative,
  };
}

/** Resolve an agent's Shizuha ID identity from cache (populated by prefetchAllIdentities). */
export async function resolveAgentIdentity(agent: { username: string; email?: string | null }): Promise<AgentIdentity> {
  return identityCache.get(agent.username) ?? { userId: 0, isStaff: false, isSuperuser: false };
}

/**
 * Cache-or-LIVE identity resolution for the HIVE-247 top-down provision gate.
 *
 * The identity cache is prefetched at daemon startup for agents that are
 * already DISCOVERED, so a top-down provision of a brand-new username always
 * missed (userId 0 → 'no-canonical-shizuha-id' → 403) even when the account
 * exists — Hive creates the ID account moments before calling provision. On a
 * cache miss, look the account up live via the same authoritative users API
 * the prefetch uses, and populate the cache on success. Failures fall back to
 * the cache/empty identity — the gate stays fail-closed on explicit violations
 * and lenient-on-unknown exactly as before.
 */
export async function resolveAgentIdentityLive(agent: { username: string; email?: string | null }): Promise<AgentIdentity> {
  const cached = identityCache.get(agent.username);
  if (cached?.userId) return cached;
  // Primary: the scoped in-cluster by-username lookup (the same service-to-
  // service contract shizuha-connect uses). Needs NO admin token — the daemon's
  // admin-token family can be revoked outright (SCLI-205 'family dead',
  // canary-observed 2026-07-13) while this path stays healthy. Must hit the
  // DIRECT service base: via nginx the internal-API ingress guard 404s
  // (SHIZUHA_ID_INTERNAL_URL convention).
  try {
    const idBase = (process.env['SHIZUHA_ID_INTERNAL_URL']
      || 'http://shizuha-id.shizuha.svc.cluster.local:8001').replace(/\/+$/, '');
    const r = await fetch(
      `${idBase}/api/internal/users/by-username/?username=${encodeURIComponent(agent.username)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (r.ok) {
      const u = await r.json() as {
        id?: number; is_staff?: boolean; is_superuser?: boolean; is_active?: boolean;
        account_type?: string; profile?: { account_type?: string; agent_runtime_id?: string | null };
      };
      if (u?.id) {
        const identity: AgentIdentity = {
          userId: u.id,
          isStaff: u.is_staff ?? false,
          isSuperuser: u.is_superuser ?? false,
          accountType: u.account_type ?? u.profile?.account_type,
          isActive: u.is_active,
          agentRuntimeId: u.profile?.agent_runtime_id ?? null,
        };
        identityCache.set(agent.username, identity);
        return identity;
      }
    } else if (r.status !== 404) {
      console.warn(`[daemon] scoped identity lookup for ${agent.username} returned ${r.status}`);
    }
    // 404 = genuinely no such account → fall through (admin path may still see
    // it if the scoped view lags; otherwise the gate rejects correctly).
  } catch (e) {
    console.warn(`[daemon] scoped identity lookup failed for ${agent.username}: ${(e as Error).message}`);
  }
  try {
    const platformUrl = credentialSeedVerificationPlatformUrl();
    if (!platformUrl) return cached ?? { userId: 0, isStaff: false, isSuperuser: false };
    // PLAT-881: never read auth.json verbatim — the admin token silently ages
    // out (or is REVOKED while still parsing as unexpired, SCLI-202). Use the
    // refreshing reader; on an empty/unauthorized first lookup, force-refresh
    // once (mints from the surviving refresh token) and retry.
    const { refreshDaemonAdminToken } = require('./agent-accounts.js') as typeof import('./agent-accounts.js');
    let adminToken = process.env['SHIZUHA_ACCESS_TOKEN']
      || (await refreshDaemonAdminToken({ platformUrl }))
      || '';
    if (!adminToken) return cached ?? { userId: 0, isStaff: false, isSuperuser: false };

    const wantEmail = agent.email ?? `${agent.username}@shizuha.com`;
    const lookup = async (token: string) => {
      const users = await fetchAuthenticatedPlatformUsers(platformUrl, token);
      return {
        empty: users.users.length === 0,
        user: users.users.find((u) => u.username === agent.username)
          ?? users.users.find((u) => u.email === wantEmail),
      };
    };
    let result = await lookup(adminToken);
    if (result.empty && !process.env['SHIZUHA_ACCESS_TOKEN']) {
      const forced = await refreshDaemonAdminToken({ platformUrl, force: true });
      if (forced && forced !== adminToken) {
        adminToken = forced;
        result = await lookup(adminToken);
      }
    }
    const user = result.user;
    if (user?.id) {
      const identity: AgentIdentity = {
        userId: user.id,
        isStaff: user.is_staff ?? false,
        isSuperuser: user.is_superuser ?? false,
        accountType: user.profile?.account_type,
        isActive: user.is_active,
        agentRuntimeId: user.profile?.agent_runtime_id ?? null,
      };
      identityCache.set(agent.username, identity);
      return identity;
    }
  } catch (e) {
    console.warn(`[daemon] live identity lookup failed for ${agent.username}: ${(e as Error).message}`);
  }
  return cached ?? { userId: 0, isStaff: false, isSuperuser: false };
}

/** Emit a structured, greppable identity-health line for an agent (scraped from daemon logs). */
function logAgentIdentityHealth(agentName: string, username: string, identity: AgentIdentity): boolean {
  const { ok, reasons } = validateAgentIdentity({ username }, identity);
  // shizuha_agent_identity_ok — greppable metric line (1=healthy, 0=violates the invariant)
  console.log(
    `[daemon] shizuha_agent_identity_ok agent="${agentName}" username="${username}" ` +
    `ok=${ok ? 1 : 0} account_type="${identity.accountType ?? 'unknown'}" ` +
    `active=${identity.isActive ?? 'unknown'} runtime_id="${identity.agentRuntimeId ?? ''}"` +
    (ok ? '' : ` reasons="${reasons.join(',')}"`),
  );
  // HIVE-249: also emit as a Prometheus gauge so Alertmanager can alert on identity violations.
  setAgentIdentityOk(agentName, ok);
  if (!ok) {
    console.warn(`[daemon] ⚠ IDENTITY-GUARANTEE violated for ${agentName} (${username}): ${reasons.join(', ')} — spawning anyway (ADR-0004 flag mode)`);
  }
  return ok;
}

/**
 * HIVE-248 (ADR-0004 ph5): reconcile every discovered agent's executionMethod against the
 * declarative per-team backend policy. Same flag+repair pattern as the ph2 identity-guarantee:
 * detects drift (current executionMethod ≠ desired) and repairs via updateLocalAgentAtRuntime
 * which persists agents.json and restarts the affected agent. Only runs inside the daemon
 * process — never exposed as an agent tool (gateway isolation keeps fleet agents out).
 * Re-reads the policy file on each call so operator edits take effect without a daemon restart.
 */
function reconcileTeamBackends(policy: TeamBackendPolicy): void {
  if (Object.keys(policy).length === 0) return;
  for (const agent of discoveredAgents) {
    if (!agent.team) continue;
    const desired = policy[agent.team];
    if (!desired?.executionMethod) continue;
    if (agent.executionMethod === desired.executionMethod) continue;
    console.log(
      `[daemon] backend-reconcile: repairing ${agent.name} (${agent.username}) ` +
      `team=${agent.team} executionMethod: ${agent.executionMethod ?? 'unset'} → ${desired.executionMethod}`,
    );
    const result = updateLocalAgentAtRuntime(agent.id, { execution_method: desired.executionMethod });
    if (!result.ok) {
      console.warn(`[daemon] backend-reconcile: repair failed for ${agent.name}: ${result.error ?? 'unknown'}`);
    }
  }
}

/**
 * Synchronous identity lookup for callers that just need the cached user_id.
 * Returns undefined when the agent hasn't been resolved yet (e.g., during
 * startup before prefetchAllIdentities completes).
 */
export function getCachedAgentIdentity(username: string): AgentIdentity | undefined {
  return identityCache.get(username);
}

/** Get the cached runner token for an agent */
export function getRunnerToken(agentId: string): string | undefined {
  return tokenCache.get(agentId);
}

/** Running child processes indexed by agent ID */
const childProcesses = new Map<string, ChildProcess>();

/**
 * PLAT-160 — wedge watchdog.
 *
 * Some bridge failure modes loop forever WITHOUT exiting: the 2026-06-08 fleet
 * outage had ~18 Spark/codex agents stuck in `codex_core::session::turn ERROR
 * "Failed to run pre-sampling compact"` retrying every ~2-3s for ~5.5h —
 * process Up, zero work, so the exit-based auto-restart never fired. Detect
 * known wedge signatures in the child's output stream and force-restart: agent
 * start resets the bridge session DB, so the restarted bridge opens a fresh,
 * compactable session (the mitigation that recovered 18/18 on 2026-06-08).
 *
 * A signature must repeat WEDGE_THRESHOLD times inside WEDGE_WINDOW_MS to
 * trigger — a one-off compaction error that then succeeds never trips it
 * (the loop fires ~20-30x per minute when truly wedged).
 */
const WEDGE_PATTERNS = ['Failed to run pre-sampling compact'];
const WEDGE_THRESHOLD = 10;
const WEDGE_WINDOW_MS = 5 * 60_000;
const WEDGE_SIGKILL_AFTER_MS = 10_000;
const K8S_GITHUB_AUTH_PROBE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env['SHIZUHA_K8S_GITHUB_AUTH_PROBE_INTERVAL_MS'] ?? 5 * 60_000),
);
const K8S_GITHUB_AUTH_ANDON_RATE_LIMIT_MS = Math.max(
  60_000,
  Number(process.env['SHIZUHA_K8S_GITHUB_AUTH_ANDON_RATE_LIMIT_MS'] ?? 6 * 60 * 60_000),
);
let lastK8sGithubAuthProbeAt = 0;
const lastK8sGithubAuthAndonByAgentReason = new Map<string, number>();
/** Last activity timestamp per agent (in-memory only — ephemeral telemetry) */
const lastActivityMap = new Map<string, string>();
const lastActivityDeltaSentAt = new Map<string, number>();
const activityDeltaMinIntervalRaw = Number(
  process.env['SHIZUHA_ACTIVITY_DELTA_MIN_INTERVAL_MS'] ?? '5000',
);
const ACTIVITY_DELTA_MIN_INTERVAL_MS = Number.isFinite(activityDeltaMinIntervalRaw)
  ? Math.max(1_000, activityDeltaMinIntervalRaw)
  : 5_000;

/** Get last activity timestamp for an agent */
export function getAgentLastActivity(agentId: string): string | undefined {
  return lastActivityMap.get(agentId);
}

/**
 * Correlate Hive's RuntimeLane acknowledgement with the workload rendered from
 * the just-persisted agent config.  For k8s agents the config-hash annotation,
 * Deployment observedGeneration, updated replica and ready/available replicas
 * must all converge before the daemon runs an in-pod probe.  That probe must
 * report the exact applied fence plus broker, harness, auth, provider, quota,
 * and backoff readiness before the daemon can claim the RuntimeLane healthy.
 */
async function probeAppliedRuntimeLaneHealth(
  agentId: string,
  runtimeLane: DaemonLinkRuntimeLaneContext,
) {
  const timeoutMs = Math.max(
    10_000,
    Number(process.env['SHIZUHA_RUNTIME_LANE_HEALTH_TIMEOUT_MS'] ?? 120_000),
  );
  const deadline = Date.now() + timeoutMs;
  let lastError = 'runtime lane did not become ready before timeout';
  while (Date.now() < deadline) {
    const agent = discoveredAgents.find((candidate) => candidate.id === agentId || candidate.username === agentId);
    if (!agent) throw new Error('runtime lane agent disappeared after durable apply');
    const runtimeState = inMemoryState?.agents.find((candidate) => candidate.agentId === agent.id);
    if (runtimeState?.status === 'error') {
      return {
        apply_status: 'failed' as const,
        workload_ready: false,
        container_ready: false,
        harness_ready: false,
        provider_health: {
          available: false,
          quota_ok: !PROVIDER_QUOTA_EXIT_RE.test(runtimeState.error ?? ''),
          in_backoff: PROVIDER_QUOTA_EXIT_RE.test(runtimeState.error ?? ''),
        },
        error: runtimeState.error || 'runtime startup failed',
      };
    }
    if (isK8sAgent(agent)) {
      const desiredHash = computeAgentMcpConfigHash(agent);
      const live = await getAgentK8sDeploymentStateAsync(agent);
      const generationObserved = Boolean(
        live?.generation !== undefined
        && live.observedGeneration !== undefined
        && live.observedGeneration >= live.generation,
      );
      const exactConfig = live?.configHash === desiredHash;
      const workloadReady = Boolean(
        exactConfig
        && generationObserved
        && (live?.replicas ?? 0) > 0
        && (live?.updatedReplicas ?? 0) >= (live?.replicas ?? 1),
      );
      const containerReady = Boolean(
        workloadReady
        && (live?.readyReplicas ?? 0) >= (live?.replicas ?? 1)
        && (live?.availableReplicas ?? 0) >= (live?.replicas ?? 1),
      );
      if (containerReady) {
        try {
          const probe = await probeAgentK8sRuntimeLane(agent);
          const health = runtimeLaneHealthFromProbe(runtimeLane, probe, workloadReady, containerReady);
          if (health.apply_status === 'ok') return health;
          lastError = health.error ?? 'in-pod RuntimeLane health is not ready';
        } catch (error) {
          lastError = `in-pod RuntimeLane probe failed: ${(error as Error).message}`;
        }
      } else {
        lastError = !exactConfig
          ? 'deployment has not observed the admitted runtime config'
          : !generationObserved
            ? 'deployment generation has not converged'
            : 'runtime or broker container is not ready/available';
      }
    } else {
      lastError = 'exact RuntimeLane health probe is unsupported for non-k8s runtime';
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return {
    apply_status: 'failed' as const,
    workload_ready: false,
    container_ready: false,
    harness_ready: false,
    provider_health: { available: false, quota_ok: false, in_backoff: false },
    error: lastError,
  };
}

/**
 * Newest-wins external activity feed for agents whose work the daemon does NOT
 * see on a child stdout stream — k8s-native pods (SCLI-330). Local children
 * feed lastActivityMap from stdout parsing; k8s agents had NO writer, so
 * dashboard lastActiveAt (and Hive's Agents page, which mirrors it) froze at
 * whatever predated the pod migration while the pod worked (ichi 2026-07-11:
 * 5h stale mid-incident-response). Callers pass timestamps parsed from the
 * pod-session tail; older-than-current values are ignored.
 */
export function noteAgentActivity(agentId: string, ts: string): void {
  if (!ts || Number.isNaN(Date.parse(ts))) return;
  const prev = lastActivityMap.get(agentId);
  if (prev && Date.parse(prev) >= Date.parse(ts)) return;
  lastActivityMap.set(agentId, ts);
  // Activity is much noisier than runtime-state changes. Publish a bounded,
  // newest-wins delta so Hive's WS cache stays truthful mid-turn without
  // flooding the daemon link. If disconnected, the next state frame carries
  // the current map value and no truth is lost.
  const now = Date.now();
  const lastSentAt = lastActivityDeltaSentAt.get(agentId) ?? 0;
  if (now - lastSentAt >= ACTIVITY_DELTA_MIN_INTERVAL_MS
      && daemonLinkClient?.sendAgentDelta(agentId, 'activity')) {
    lastActivityDeltaSentAt.set(agentId, now);
  }
}

/** PLAT-962: agents currently in PLAT-879 token-pool backoff (supervised wait, not crash-loop) */
const tokenPoolBackoffSet = new Set<string>();

/** PLAT-962: true if the agent bridge is waiting for token-pool capacity (PLAT-879 backoff) */
export function isAgentInTokenPoolBackoff(agentId: string): boolean {
  return tokenPoolBackoffSet.has(agentId);
}

/** Activity event for the agent activity log */
export interface ActivityEvent {
  ts: string;
  type:
    | 'tool_start'
    | 'tool_output'
    | 'tool_complete'
    | 'turn_complete'
    | 'message_received'
    | 'message_sent'
    | 'reasoning'
    | 'telemetry'
    | 'error'
    | 'session_start';
  tool?: string;
  detail?: string;
  stream?: string;
}

/** Ring buffer of recent activity events per agent (last 200 events, in-memory) */
const activityLog = new Map<string, ActivityEvent[]>();
const MAX_ACTIVITY_EVENTS = 200;

/** Append an activity event for an agent */
export function logActivity(agentId: string, event: ActivityEvent): void {
  let events = activityLog.get(agentId);
  if (!events) {
    events = [];
    activityLog.set(agentId, events);
  }
  events.push(event);
  if (events.length > MAX_ACTIVITY_EVENTS) {
    events.splice(0, events.length - MAX_ACTIVITY_EVENTS);
  }
}

/** Get recent activity for an agent */
export function getAgentActivity(agentId: string, limit = 50): ActivityEvent[] {
  const events = activityLog.get(agentId) ?? [];
  return events.slice(-limit);
}

/** A host runtime may replace itself only when no child is starting and every
 * running child has crossed the same conservative quiet window used by the
 * image roller. Container/pod daemons are excluded by update-check itself. */
export function daemonIsIdleForSelfUpdate(now = Date.now()): boolean {
  if (shuttingDown || !inMemoryState) return false;
  return inMemoryState.agents.every((agent) => {
    if (agent.status === 'starting') return false;
    if (agent.status !== 'running') return true;
    return agentIsIdleForRoll(agent.agentId, now);
  });
}

export function logCodexRpcActivity(agentId: string, line: string, ts: string): void {
  if (!line.includes('[codex-rpc]')) return;
  noteAgentActivity(agentId, ts);

  const field = (key: string): string => {
    const m = line.match(new RegExp(`${key}=("(?:\\\\.|[^"])*"|\\S*)`));
    if (!m?.[1]) return '';
    const raw = m[1];
    if (raw.startsWith('"')) {
      try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
    }
    return raw;
  };

  const method = line.match(/\[codex-rpc\]\s+(\S+)/)?.[1] ?? '';
  const itemType = field('item\\.type');
  const server = field('server');
  const tool = field('tool');
  const status = field('status');
  const duration = field('durationMs');
  const command = field('command');
  const output = field('output');
  const stream = field('stream');
  const normalizedStatus = status.toLowerCase().replace(/[_.-]/g, '');
  const isCommandOutput = method.includes('commandExecution/outputDelta')
    || method.includes('command_execution/output_delta')
    || (!!output && itemType === 'commandExecution');

  const isTurnStarted = method === 'codex/turn-started' || method === 'turn/started';
  const isTurnCompleted = method === 'turn/completed' || method === 'codex/turn-completed';
  const isItemStarted = method === 'item/started'
    || (!!itemType && ['started', 'starting', 'inprogress', 'running'].includes(normalizedStatus));
  const isItemCompleted = method === 'item/completed'
    || (!!itemType && ['completed', 'complete', 'succeeded', 'success', 'failed', 'error', 'cancelled', 'canceled'].includes(normalizedStatus));

  if (isTurnStarted) {
    logActivity(agentId, { ts, type: 'session_start', detail: 'Turn started' });
    return;
  }

  if (isTurnCompleted) {
    logActivity(agentId, { ts, type: 'turn_complete', detail: 'Turn completed' });
    return;
  }

  if (isCommandOutput) {
    logActivity(agentId, {
      ts,
      type: 'tool_output',
      tool: 'commandExecution',
      detail: output,
      stream: stream || 'stdout',
    });
    return;
  }

  if (isItemStarted) {
    if (itemType === 'mcpToolCall') {
      logActivity(agentId, {
        ts,
        type: 'tool_start',
        tool: tool || server || 'mcp',
        detail: server ? `${server}:${tool || 'tool'}` : undefined,
      });
    } else if (itemType === 'commandExecution') {
      logActivity(agentId, {
        ts,
        type: 'tool_start',
        tool: 'commandExecution',
        detail: command || undefined,
      });
    } else if (itemType === 'agentMessage') {
      logActivity(agentId, { ts, type: 'message_sent', detail: 'Assistant response started' });
    }
    return;
  }

  if (isItemCompleted) {
    if (itemType === 'mcpToolCall') {
      logActivity(agentId, {
        ts,
        type: 'tool_complete',
        tool: tool || server || 'mcp',
        detail: [status, duration ? `${duration}ms` : ''].filter(Boolean).join(' '),
      });
    } else if (itemType === 'commandExecution') {
      logActivity(agentId, {
        ts,
        type: 'tool_complete',
        tool: 'commandExecution',
        detail: [status, duration ? `${duration}ms` : '', command].filter(Boolean).join(' '),
      });
    } else if (itemType === 'agentMessage') {
      logActivity(agentId, { ts, type: 'message_sent', detail: 'Assistant response completed' });
    }
  }
}

/** Cache of agent passwords loaded from ~/.shizuha/agent-passwords.json */
let agentPasswordCache: Record<string, string> | null = null;
const MIN_AGENT_PASSWORD_LENGTH = 8;

function isUsableAgentPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_AGENT_PASSWORD_LENGTH;
}

function warnInvalidAgentPassword(agent: Pick<AgentInfo, 'username'>, source: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  logger.warn(
    { agent: agent.username, source, length: typeof value === 'string' ? value.length : undefined },
    'Agent password source is invalid; falling through to the next canonical source',
  );
}

export function injectAgentCredentialEnvValue(
  agent: Pick<AgentInfo, 'username'>,
  credentialEnv: Record<string, string>,
  envName: string,
  value: unknown,
  source: string,
): void {
  if (!value) return;
  if (envName === 'AGENT_PASSWORD' && !isUsableAgentPassword(value)) {
    warnInvalidAgentPassword(agent, source, value);
    return;
  }
  credentialEnv[envName] = String(value);
}

function readAgentPasswordCache(): Record<string, string> {
  if (!agentPasswordCache) {
    const pwFile = path.join(process.env['HOME'] ?? '/root', '.shizuha', 'agent-passwords.json');
    try {
      if (fs.existsSync(pwFile)) {
        const parsed = JSON.parse(fs.readFileSync(pwFile, 'utf-8'));
        agentPasswordCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, string>
          : {};
      } else {
        agentPasswordCache = {};
      }
    } catch { agentPasswordCache = {}; }
  }
  return agentPasswordCache;
}

export function __resetAgentPasswordCacheForTest(): void {
  agentPasswordCache = null;
}

/** Resolve agent password for Shizuha ID self-authentication */
function findActiveShizuhaIdCredential(agent: AgentInfo) {
  return agent.credentials?.find(c => (c.scope ?? c.service) === 'shizuha-id' && c.isActive);
}

/** Resolve agent password for Shizuha ID self-authentication */
export function resolveAgentPassword(agent: AgentInfo): string {
  // 1. Check agent credentials for an active Shizuha ID scoped grant. `scope`
  // is the source-of-truth after PLAT-99; `service` is a legacy fallback.
  const idCred = findActiveShizuhaIdCredential(agent);
  const scopedPassword = idCred?.credentialData?.password;
  if (isUsableAgentPassword(scopedPassword)) return scopedPassword;
  warnInvalidAgentPassword(agent, 'shizuha-id credential', scopedPassword);

  // 2. Check agent's custom env. SCLI-213: an env override shorter than
  // shizuha-id's minimum password length is corrupt local state, not an
  // authoritative credential; skip it so the canonical store can self-heal.
  const envPassword = agent.env?.['AGENT_PASSWORD'];
  if (isUsableAgentPassword(envPassword)) return envPassword;
  warnInvalidAgentPassword(agent, 'agent env AGENT_PASSWORD', envPassword);

  // 3. Read from agent-passwords.json (generated during onboarding)
  const cachedPassword = readAgentPasswordCache()[agent.username];
  if (isUsableAgentPassword(cachedPassword)) return cachedPassword;
  warnInvalidAgentPassword(agent, 'agent-passwords.json', cachedPassword);
  return '';
}

/**
 * PLAT-558 single-write: persist the agent password to #2, the broker-scoped
 * shizuha-id credential grant, and return a rollback that restores the exact
 * previous credential list. This is daemon-internal provisioning state, not the
 * public dashboard credential CRUD path (which remains broker-managed/closed).
 */
async function persistCanonicalAgentPassword(agent: AgentInfo, password: string): Promise<() => void> {
  const previous = structuredClone(agent.credentials ?? []);
  const next = structuredClone(agent.credentials ?? []);
  const existing = next.find(c => (c.scope ?? c.service) === 'shizuha-id' && c.isActive);
  const nowLabel = 'shizuha-id';
  if (existing) {
    existing.scope = 'shizuha-id';
    existing.service = 'shizuha-id';
    existing.label = existing.label || nowLabel;
    existing.credentialData = { ...(existing.credentialData ?? {}), password };
    existing.injectAsEnv = true;
    existing.envMapping = { ...(existing.envMapping ?? {}), password: 'AGENT_PASSWORD' };
    existing.isActive = true;
  } else {
    const grantId = `${agent.id}-shizuha-id`;
    next.push({
      id: grantId,
      grantId,
      grantorId: 'daemon-agent-provisioner',
      scope: 'shizuha-id',
      service: 'shizuha-id',
      label: nowLabel,
      credentialData: { password },
      injectAsEnv: true,
      envMapping: { password: 'AGENT_PASSWORD' },
      isActive: true,
    });
  }
  agent.credentials = next;
  if (!updateAgentConfig(agent.id, { credentials: next })) {
    agent.credentials = previous;
    throw new Error('failed to persist canonical shizuha-id credential');
  }
  refreshCredentialBrokerAgentSockets();
  return () => {
    agent.credentials = previous;
    if (!updateAgentConfig(agent.id, { credentials: previous })) {
      throw new Error('failed to rollback canonical shizuha-id credential');
    }
    refreshCredentialBrokerAgentSockets();
  };
}

/** Whether the daemon is shutting down */
let shuttingDown = false;

/** In-memory daemon state — single source of truth (avoids file race conditions) */
let inMemoryState: DaemonState | null = null;

/** Discovered agents — available for on-demand start */
let discoveredAgents: AgentInfo[] = [];

/** Credential broker socket server handle, used to refresh per-agent sockets after runtime config changes. */
let credentialBrokerHandle: CredentialBrokerHandle | null = null;

/** Hive↔daemon desired-state WebSocket. Inert until daemon-link env credentials are configured. */
let daemonLinkClient: DaemonLinkClient | null = null;

export function __setDiscoveredAgentsForTest(agents: AgentInfo[]): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setDiscoveredAgentsForTest is test-only');
  }
  discoveredAgents = agents;
  identityCache.clear();
}

export function __setInMemoryDaemonStateForTest(state: DaemonState | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setInMemoryDaemonStateForTest is test-only');
  }
  inMemoryState = state;
}

export function __getInMemoryDaemonStateForTest(): DaemonState | null {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__getInMemoryDaemonStateForTest is test-only');
  }
  return inMemoryState;
}

export async function __prefetchAllIdentitiesForTest(
  platformUrlOverride?: string,
  daemonAccessToken?: string,
): Promise<CredentialSeedIdentityPrefetch> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__prefetchAllIdentitiesForTest is test-only');
  }
  return prefetchAllIdentities(platformUrlOverride, daemonAccessToken);
}

/** Daemon config — needed for starting agents later */
let daemonConfig: DaemonConfig | null = null;

type RuntimeUpdateAgentStarter = (
  agent: AgentInfo,
  token: string,
  config: DaemonConfig,
) => Promise<string | undefined>;

// Keep runtime-update scheduling independently testable without invoking the
// real k8s renderer/apply path. The production default remains the single
// authoritative start path below; tests may replace only this call boundary.
let runtimeUpdateAgentStarter: RuntimeUpdateAgentStarter = startAgentProcess;

export function __setRuntimeUpdateK8sReconcileForTest(
  config: DaemonConfig | null,
  starter?: RuntimeUpdateAgentStarter,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setRuntimeUpdateK8sReconcileForTest is test-only');
  }
  daemonConfig = config;
  runtimeUpdateAgentStarter = starter ?? startAgentProcess;
}

/** Platform client — for token management */
let platformClient: PlatformClient | null = null;

type EffectiveCapabilityRefreshResult = { changed: boolean; dependencyFailed: boolean };
let effectiveCapabilityRefreshPass: Promise<Set<string>> | null = null;
let effectiveCapabilityRefreshCircuitOpenUntilMs = 0;
const effectiveCapabilityLastSuccessMs = new Map<string, number>();
const effectiveCapabilityFailureBackoffUntilMs = new Map<string, number>();
const EFFECTIVE_CAPABILITY_PERIODIC_FAILURE_THRESHOLD = 2;
const configuredEffectiveCapabilityRefreshConcurrency = Number(
  process.env['SHIZUHA_HIVE_CAPABILITY_REFRESH_CONCURRENCY'] ?? 4,
);
const EFFECTIVE_CAPABILITY_REFRESH_CONCURRENCY =
  Number.isFinite(configuredEffectiveCapabilityRefreshConcurrency)
    ? Math.max(1, Math.floor(configuredEffectiveCapabilityRefreshConcurrency))
    : 4;
let effectiveCapabilityRefreshActive = 0;
const effectiveCapabilityRefreshWaiters: Array<() => void> = [];

async function withEffectiveCapabilityRefreshSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (effectiveCapabilityRefreshActive < EFFECTIVE_CAPABILITY_REFRESH_CONCURRENCY) {
    effectiveCapabilityRefreshActive += 1;
  } else {
    await new Promise<void>((resolve) => effectiveCapabilityRefreshWaiters.push(resolve));
  }
  try {
    return await operation();
  } finally {
    const next = effectiveCapabilityRefreshWaiters.shift();
    if (next) next();
    else effectiveCapabilityRefreshActive -= 1;
  }
}

export function __setEffectiveCapabilityPlatformClientForTest(
  client: Pick<PlatformClient, 'getEffectiveCapabilities'> | null,
): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('__setEffectiveCapabilityPlatformClientForTest is test-only');
  platformClient = client as PlatformClient | null;
}

export function __resetEffectiveCapabilityRefreshStateForTest(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('__resetEffectiveCapabilityRefreshStateForTest is test-only');
  effectiveCapabilityRefreshPass = null;
  effectiveCapabilityRefreshCircuitOpenUntilMs = 0;
  effectiveCapabilityLastSuccessMs.clear();
  effectiveCapabilityFailureBackoffUntilMs.clear();
}

export async function __refreshEffectiveCapabilitiesForAgentIfStaleForTest(
  agent: AgentInfo,
  reason = 'pre-start',
): Promise<boolean> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__refreshEffectiveCapabilitiesForAgentIfStaleForTest is test-only');
  }
  return refreshEffectiveCapabilitiesForAgentIfStale(agent, reason);
}

export async function __refreshEffectiveCapabilitiesForAgentsForTest(
  agents: AgentInfo[],
  reason = 'periodic-refresh',
): Promise<{ changed: string[]; circuitOpen: boolean }> {
  if (process.env.NODE_ENV !== 'test') throw new Error('__refreshEffectiveCapabilitiesForAgentsForTest is test-only');
  const changed = await refreshEffectiveCapabilitiesForAgents(agents, reason);
  return {
    changed: [...changed],
    circuitOpen: Date.now() < effectiveCapabilityRefreshCircuitOpenUntilMs,
  };
}

export async function __refreshEffectiveCapabilitiesForAgentsConcurrentlyForTest(
  agents: AgentInfo[],
  reason = 'pre-start',
): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__refreshEffectiveCapabilitiesForAgentsConcurrentlyForTest is test-only');
  }
  await Promise.all(agents.map((agent) => refreshEffectiveCapabilitiesForAgentResult(agent, reason)));
}

function mutateAgentInPlace(target: AgentInfo, source: AgentInfo): void {
  for (const key of Object.keys(target) as Array<keyof AgentInfo>) {
    if (!(key in source)) delete target[key];
  }
  Object.assign(target, source);
}

async function refreshEffectiveCapabilitiesForAgentResult(
  agent: AgentInfo,
  reason: string,
  openSharedCircuitOnFailure = true,
): Promise<EffectiveCapabilityRefreshResult> {
  if (!platformClient || process.env['SHIZUHA_HIVE_CAPABILITIES_DISABLE'] === '1') {
    return { changed: false, dependencyFailed: false };
  }
  let payload: unknown | null = null;
  try {
    // Hive resolves runtime agents by daemon agent ID, not username (see
    // getEffectiveCapabilities doc — the username form 404s "Agent not found").
    const client = platformClient;
    payload = await withEffectiveCapabilityRefreshSlot(async () => {
      // A request may have waited behind another startup probe. Re-check the
      // shared dependency circuit after acquiring a slot so the first Hive
      // timeout cancels the queued fleet fan-out instead of merely limiting
      // how many doomed requests run at once.
      if (Date.now() < effectiveCapabilityRefreshCircuitOpenUntilMs) return null;
      try {
        return await client.getEffectiveCapabilities(agent.id);
      } catch (err) {
        if (openSharedCircuitOnFailure) {
          const cooldownMs = Math.max(
            10_000,
            Number(process.env['SHIZUHA_HIVE_CAPABILITY_CIRCUIT_COOLDOWN_MS'] ?? 60_000),
          );
          effectiveCapabilityRefreshCircuitOpenUntilMs = Date.now() + cooldownMs;
        }
        throw err;
      }
    });
  } catch (err) {
    console.warn(
      `[daemon] ${agent.name}: Hive effective capabilities refresh failed (${reason}): ` +
      `${(err as Error).message}; keeping legacy/last-valid runtime config ` +
      `(refresh_concurrency=${EFFECTIVE_CAPABILITY_REFRESH_CONCURRENCY}, queued=${effectiveCapabilityRefreshWaiters.length})`,
    );
    return { changed: false, dependencyFailed: true };
  }
  if (!payload) return { changed: false, dependencyFailed: false };
  const applied = applyEffectiveCapabilitiesToAgent(agent, payload);
  if (!applied.report.applied) {
    console.warn(
      `[daemon] ${agent.name}: Hive effective capabilities ignored (${reason}) ` +
      `reason=${applied.report.reason} diagnostics=${JSON.stringify(applied.report.diagnostics)}`,
    );
    return { changed: false, dependencyFailed: false };
  }
  effectiveCapabilityLastSuccessMs.set(agent.id, Date.now());
  mutateAgentInPlace(agent, applied.agent);
  if (applied.report.changed) {
    console.log(`[daemon] ${agent.name}: applied Hive effective capabilities (${reason}): ${summarizeEffectiveCapabilities(agent.effectiveCapabilities)}`);
    onAgentStateChange?.(agent.id);
  } else {
    console.log(`[daemon] ${agent.name}: Hive effective capabilities unchanged (${reason}): ${summarizeEffectiveCapabilities(agent.effectiveCapabilities)}`);
  }
  return { changed: applied.report.changed, dependencyFailed: false };
}

async function refreshEffectiveCapabilitiesForAgent(agent: AgentInfo, reason: string): Promise<boolean> {
  return (await refreshEffectiveCapabilitiesForAgentResult(agent, reason)).changed;
}

async function refreshEffectiveCapabilitiesForAgentIfStale(
  agent: AgentInfo,
  reason: string,
): Promise<boolean> {
  const configuredFreshMs = Number(
    process.env['SHIZUHA_HIVE_CAPABILITY_REFRESH_FRESH_MS'] ?? 60_000,
  );
  const freshMs = Number.isFinite(configuredFreshMs) ? Math.max(0, configuredFreshMs) : 60_000;
  const lastSuccess = effectiveCapabilityLastSuccessMs.get(agent.id) ?? 0;
  const ageMs = lastSuccess > 0 ? Date.now() - lastSuccess : Number.POSITIVE_INFINITY;
  if (ageMs <= freshMs) {
    console.log(
      `[daemon] ${agent.name}: using fresh Hive effective capabilities (${reason}, age_ms=${ageMs})`,
    );
    return false;
  }
  return refreshEffectiveCapabilitiesForAgent(agent, reason);
}

async function refreshEffectiveCapabilitiesForAgents(agents: AgentInfo[], reason: string): Promise<Set<string>> {
  const changed = new Set<string>();
  if (!platformClient || process.env['SHIZUHA_HIVE_CAPABILITIES_DISABLE'] === '1') return changed;

  // HIVE-619: the historical 60s full-fleet scan could overlap itself. During
  // the Redis/LAN outage that multiplied abandoned 5s requests and kept both
  // Daphne replicas in cancellation cleanup. Hive daemon-link config frames are
  // the primary state-change path; this scan is only a single-flight repair
  // backstop, so an overlap is safely coalesced into the pass already running.
  if (effectiveCapabilityRefreshPass) {
    console.warn(`[daemon] Hive effective capabilities ${reason} skipped: reconciliation already in flight`);
    return changed;
  }

  const now = Date.now();
  if (reason === 'periodic-refresh' && now < effectiveCapabilityRefreshCircuitOpenUntilMs) {
    console.warn(
      `[daemon] Hive effective capabilities periodic refresh skipped: dependency circuit open for ` +
      `${effectiveCapabilityRefreshCircuitOpenUntilMs - now}ms`,
    );
    return changed;
  }

  const pass = (async () => {
    let consecutiveDependencyFailures = 0;
    let openedSharedCircuit = false;
    for (const agent of agents) {
      const now = Date.now();
      if (
        reason === 'periodic-refresh'
        && now < (effectiveCapabilityFailureBackoffUntilMs.get(agent.id) ?? 0)
      ) {
        continue;
      }
      // Startup/pre-start fan-out retains the first-failure shared circuit: a
      // real Hive outage must not multiply into 42 doomed requests. The slow
      // periodic repair pass is different: isolate one agent/request timeout,
      // then require two consecutive failures before classifying the shared
      // dependency as unavailable.
      const result = await refreshEffectiveCapabilitiesForAgentResult(
        agent,
        reason,
        reason !== 'periodic-refresh',
      );
      if (result.changed) changed.add(agent.id);
      if (result.dependencyFailed) {
        const cooldownMs = Math.max(
          10_000,
          Number(process.env['SHIZUHA_HIVE_CAPABILITY_CIRCUIT_COOLDOWN_MS'] ?? 60_000),
        );
        effectiveCapabilityFailureBackoffUntilMs.set(agent.id, Date.now() + cooldownMs);
        consecutiveDependencyFailures += 1;
        if (consecutiveDependencyFailures >= EFFECTIVE_CAPABILITY_PERIODIC_FAILURE_THRESHOLD) {
          effectiveCapabilityRefreshCircuitOpenUntilMs = Date.now() + cooldownMs;
          openedSharedCircuit = true;
          console.warn(
            `[daemon] Hive effective capabilities ${reason}: ` +
            `${consecutiveDependencyFailures} consecutive dependency failures; ` +
            `opening ${cooldownMs}ms circuit and stopping fleet fan-out`,
          );
          break;
        }
        console.warn(
          `[daemon] Hive effective capabilities ${reason}: isolated dependency failure for ` +
          `${agent.name}; continuing unrelated agents with per-agent backoff`,
        );
        continue;
      }
      consecutiveDependencyFailures = 0;
      effectiveCapabilityFailureBackoffUntilMs.delete(agent.id);
    }
    if (!openedSharedCircuit) effectiveCapabilityRefreshCircuitOpenUntilMs = 0;
    return changed;
  })();

  effectiveCapabilityRefreshPass = pass;
  try {
    return await pass;
  } finally {
    effectiveCapabilityRefreshPass = null;
  }
}

function startEffectiveCapabilityRefreshLoop(agents: AgentInfo[]): void {
  if (!platformClient || process.env['SHIZUHA_HIVE_CAPABILITIES_DISABLE'] === '1') return;
  // Capability/team writes already push the recomputed overlay immediately over
  // daemon-link. Keep a slow reconciliation backstop only for missed/external
  // roster events; never make a 42-agent minute scan the primary mechanism.
  const intervalMs = Math.max(
    60_000,
    Number(process.env['SHIZUHA_HIVE_CAPABILITY_REFRESH_MS'] ?? 5 * 60_000),
  );
  const timer = setInterval(() => {
    void (async () => {
      const changed = await refreshEffectiveCapabilitiesForAgents(agents, 'periodic-refresh');
      for (const agentId of changed) {
        const state = inMemoryState?.agents.find((a) => a.agentId === agentId);
        if (state?.enabled && (state.status === 'running' || state.status === 'starting')) {
          const agent = agents.find((a) => a.id === agentId);
          if (agent && shouldSpawnK8sAgent(agent)) {
            const desiredHash = computeAgentMcpConfigHash(agent);
            const live = await getAgentK8sDeploymentStateAsync(agent);
            if (live?.configHash === desiredHash) {
              console.log(
                `[daemon] ${agentId}: refreshed Hive runtime capabilities but k8s pod config hash is unchanged (${desiredHash}); ` +
                'skipping restart',
              );
              continue;
            }
          }
          console.log(`[daemon] ${agentId}: restarting to apply refreshed Hive runtime capabilities`);
          restartAgent(agentId);
        }
      }
    })().catch((err) => console.warn(`[daemon] Hive effective capabilities periodic refresh failed: ${(err as Error).message}`));
  }, intervalMs);
  timer.unref();
}

/** Callback for agent state changes — set by the dashboard to push updates to WS clients. */
let onAgentStateChange: ((agentId: string) => void) | null = null;

/** Register a callback for agent state changes (called by dashboard). */
export function setAgentStateChangeListener(cb: (agentId: string) => void): void {
  onAgentStateChange = cb;
}

export async function refreshCredentialBrokerAgentSockets(): Promise<void> {
  try {
    await credentialBrokerHandle?.refreshAgentSockets();
  } catch (err) {
    console.warn(`[daemon] Credential broker socket refresh failed: ${(err as Error).message}`);
  }
}

/**
 * Mini-Connect auth bridge — set by the dashboard so the manager can upsert
 * each agent into the daemon's local mini-Connect store at spawn time.
 *
 * Decoupled via a setter (rather than direct import) because manager.ts is
 * loaded before dashboard.ts initializes the auth service.
 */
interface MiniConnectAuthBridge {
  ensureAgentUser(opts: {
    username: string;
    agentId: string;
    email?: string;
    displayName?: string;
    password?: string;
  }): unknown;
}
let miniConnectAuth: MiniConnectAuthBridge | null = null;
export function setMiniConnectAuth(auth: MiniConnectAuthBridge | null): void {
  miniConnectAuth = auth;
}

/**
 * Resolve the Backend URL agent containers should use for chat (mini-Connect
 * lives on the daemon; real Connect lives on the platform when linked).
 *
 * Order of preference:
 *   1. `SHIZUHA_BACKEND_URL` env (operator override)
 *   2. The platform URL from `resolvePlatformUrl()` IF linked (non-localhost)
 *   3. Daemon's own URL via host.docker.internal (so containers reach mini-Connect)
 *
 * Containers always need a URL reachable from inside Docker. `host.docker.internal`
 * is added to /etc/hosts via `--add-host` (see container args), and the daemon
 * starts a TCP-only Docker-gateway bridge for the daemon-only path while keeping
 * the browser dashboard bound to loopback by default.
 */
export function resolveBackendUrl(): string {
  const override = process.env['SHIZUHA_BACKEND_URL'];
  if (override) return override.replace(/\/+$/, '');
  // Linked → use real platform URL (skips daemon proxy entirely).
  if (inMemoryState?.platformUrl
      && inMemoryState.platformUrl !== 'http://localhost'
      && !inMemoryState.platformUrl.includes('127.0.0.1')) {
    return inMemoryState.platformUrl.replace(/\/+$/, '');
  }
  // Default: point at daemon's mini-Connect via the container-side host alias.
  return `http://host.docker.internal:${resolveDaemonHttpPort()}`;
}

/** Update an agent's state in memory and persist to disk */
function updateAgentInMemory(agentId: string, update: Partial<DaemonAgentState>): void {
  if (!inMemoryState) return;
  const idx = inMemoryState.agents.findIndex((a) => a.agentId === agentId);
  if (idx >= 0) {
    inMemoryState.agents[idx] = { ...inMemoryState.agents[idx]!, ...update };
  }
  writeDaemonState(inMemoryState);
  // Notify dashboard so it can push the update to WS clients
  onAgentStateChange?.(agentId);
  daemonLinkClient?.sendAgentDelta(agentId, 'runtime_state');
}

/** Log file path */
function daemonLogPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'daemon.log');
}

/** Directory for per-agent claude-bridge persistent logs (mounted into containers). */
function bridgeLogDir(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'bridge-logs');
}

export function resolveDashboardHost(): string {
  const configured = process.env['SHIZUHA_DASHBOARD_HOST']?.trim();
  if (configured) return configured;
  if (process.env['SHIZUHA_DASHBOARD_REMOTE'] === '1') return '0.0.0.0';
  // Keep the default local-only while matching the CLI/tests that advertise
  // http://localhost:8015. Binding 127.0.0.1 only can break on systems where
  // localhost resolves to ::1 first.
  return 'localhost';
}

function isConcreteBindHost(host: string | null | undefined): host is string {
  if (!host) return false;
  return host !== 'host-gateway' && host !== '0.0.0.0' && host !== '::';
}

export function resolveBareMetalDaemonHost(): string {
  const host = resolveDashboardHost();
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function resolveBareMetalBackendUrl(backendUrl = resolveBackendUrl()): string {
  if (!backendUrl.includes('host.docker.internal')) return backendUrl;
  return `http://${hostForUrl(resolveBareMetalDaemonHost())}:${resolveDaemonHttpPort()}`;
}

export function resolveBareMetalCodexBrokerUrl(): string {
  return `http://${hostForUrl(resolveBareMetalDaemonHost())}:${resolveDaemonHttpPort()}/v1/codex/token`;
}

export function resolveContainerCodexBrokerUrl(): string {
  return `http://host.docker.internal:${resolveDaemonHttpPort()}/v1/codex/token`;
}

/** HIVE-586: only coordinator-backed runtimes use the daemon token endpoint. */
export function shouldUseCodexBroker(useCodexBridge: boolean, coordinatorConfigured: boolean): boolean {
  return useCodexBridge && coordinatorConfigured;
}

export function resolveDashboardBindHosts(options: { containerMode?: boolean; hostGateway?: string | null } = {}): string[] {
  const primary = resolveDashboardHost();
  const hosts = [primary];

  // Explicit remote/custom binding is an operator decision; do not add another
  // daemon listener behind their back. The safe default keeps browser access on
  // loopback and, for container agents, adds only the Docker bridge gateway IP.
  const explicit = Boolean(process.env['SHIZUHA_DASHBOARD_HOST']?.trim())
    || process.env['SHIZUHA_DASHBOARD_REMOTE'] === '1';
  if (!explicit && options.containerMode && isConcreteBindHost(options.hostGateway) && options.hostGateway !== primary) {
    hosts.push(options.hostGateway);
  }

  return hosts;
}

export interface DashboardListenerPlan {
  /** Full daemon dashboard runtime binds here exactly once. */
  primaryHost: string;
  /** TCP-only bind aliases that forward to primaryHost without duplicating runtime side effects. */
  proxyHosts: string[];
}

export function resolveDashboardListenerPlan(options: { containerMode?: boolean; hostGateway?: string | null } = {}): DashboardListenerPlan {
  const [primaryHost, ...proxyHosts] = resolveDashboardBindHosts(options);
  return {
    primaryHost: primaryHost ?? '127.0.0.1',
    proxyHosts,
  };
}

function resolveContainerDashboardHost(containerMode: boolean): string | null {
  if (!containerMode || !isDockerAvailable()) return null;
  try {
    ensureAgentNetwork();
    return resolveHostGateway();
  } catch {
    return null;
  }
}

/**
 * Start the daemon — discovers agents, forks background process, exits.
 */
/**
 * Boot-phase health listeners (2026-08-11 rt-fleet liveness-kill storm).
 *
 * The dashboard — and with it /health — used to bind LAST in startDaemon,
 * after credential migration, platform sync, identity prefetch, and per-agent
 * capability refreshes. Boot time therefore scaled with fleet size and
 * upstream latency (~2-3 min at 42 agents), while the pod's startup probe
 * budget was 120s: any node slowdown pushed boot past the budget, kubelet
 * killed the container MID-BOOT, and every retry started colder — a
 * self-sustaining CrashLoopBackOff (29 kills) that shrank Hive's lifecycle
 * inventory each cycle. Liveness must mean "process alive", not "fleet fully
 * discovered": these placeholders answer /health 200 within milliseconds of
 * exec and /ready 503 until the real dashboard (which serves /ready 200)
 * takes the ports over.
 */
let bootHealthListeners: { close: () => void } | null = null;

function startBootHealthListeners(ports: number[]): { close: () => void } {
  const servers: import('node:http').Server[] = [];
  for (const port of ports) {
    try {
      const server = http.createServer((req, res) => {
        if ((req.url || '').split('?')[0] === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'starting', service: 'shizuha-daemon' }));
          return;
        }
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'daemon is booting; APIs not yet available' }));
      });
      server.on('error', () => { /* port busy (old instance draining) — real bind will report */ });
      server.listen(port, '0.0.0.0');
      server.unref();
      servers.push(server);
    } catch { /* never let boot-health block boot */ }
  }
  return {
    close: () => {
      for (const server of servers) {
        try { server.close(); } catch { /* already closed */ }
      }
    },
  };
}

export async function startDaemon(
  config: DaemonConfig,
  accessToken: string,
): Promise<void> {
  bootHealthListeners = startBootHealthListeners([8015, 8016]);
  // Host binary installs update themselves only after every child session is
  // idle. Container/pod installs are immutable and rejected by update-check.
  try {
    const { startUpdateChecker } = await import('./update-check.js');
    startUpdateChecker({
      log: (m) => console.log(m),
      isIdle: () => daemonIsIdleForSelfUpdate(),
    });
  } catch { /* updater must never affect the daemon */ }

  // Safety check — caller (shizuha up) should have already stopped any
  // existing daemon, but guard against direct programmatic calls.
  if (process.env['SHIZUHA_DAEMON'] !== '1' && isDaemonRunning()) {
    console.log('Stopping existing daemon...');
    stopDaemon();
  }

  // ── Sync bundled integration skills into ~/.shizuha/skills/ ──
  // Idempotent symlink refresh; runs every startup so adding a new bundled
  // skill in the shizuha repo is immediately visible to agents.
  if (process.env['SHIZUHA_IMMUTABLE_SKILLS'] !== '1') {
    syncBundledSkills();
  }

  // ── Auto skill-sync loop ──
  // Keep ~/.shizuha/skills current with upstream (shizuha-labs/skills) so merged
  // skill changes reach the fleet with no human step. Agents pick up the change
  // live: Claude Code via its skillChangeDetector watching the symlinked
  // /opt/skills, Codex via cron-MCP search over the same bind mount.
  if (process.env['SHIZUHA_IMMUTABLE_SKILLS'] !== '1') {
    startSkillSyncLoop();
  }

  // ── Load agents: local file is source of truth, platform sync appends new ones ──

  // Normalize local IDs to UUIDs (for platform compatibility)
  const { normalizeAgentIds } = await import('./state.js');
  const { updated: normalizedCount } = normalizeAgentIds();
  if (normalizedCount > 0) {
    console.log(`[daemon] Normalized ${normalizedCount} local agent ID(s) to UUIDs`);
  }

  const credentialMigration = migrateAgentCredentialGrants(readAgents(), readEnabledAgents());
  if (credentialMigration.refusedCredentials > 0) {
    console.warn(
      `[daemon] Refused ${credentialMigration.refusedCredentials} AgentCredential record(s) with unknown/reserved scope during migration`,
    );
  }
  if (shouldPersistAgentCredentialMigration(credentialMigration)) {
    writeAgents(credentialMigration.agents);
    console.log(
      `[daemon] Migrated agent credentials: inserted ${credentialMigration.insertedFleetSshGrants} fleet SSH grant(s), ` +
      `dogfooded ${credentialMigration.dogfoodPhoenixFleetSshGrants} phoenix fleet SSH grant(s), ` +
      `normalized ${credentialMigration.normalizedCredentials} credential(s), ` +
      `refused ${credentialMigration.refusedCredentials} credential(s), ` +
      `seeded ${credentialMigration.seededGrantPermissions} grant permission record(s), ` +
      `seeded ${credentialMigration.seededAuditRoles} audit role record(s), ` +
      `marked ${credentialMigration.seededPermissionBaselines} permission baseline(s)`,
    );
  }

  let agents: AgentInfo[] = readAgents();

  // First run: seed with default agents and auto-enable them.
  // PLAT-4235 P2: per-user fleet daemons (SHIZUHA_DAEMON_OWNER_SUBJECT set) must
  // start with an EMPTY roster — Hive is the SoT for what they manage; the
  // developer-workstation seed (local claude/shizuha/codex/claw) would otherwise
  // report junk agents on first connect (and stamp owner-scoped FleetAgent rows).
  const skipFirstRunSeed = !!(process.env.SHIZUHA_DAEMON_OWNER_SUBJECT || '').trim()
    || process.env.SHIZUHA_SKIP_FIRST_RUN_SEED === '1';
  if (agents.length === 0 && !skipFirstRunSeed) {
    agents = applyFirstRunCredentialPermissionSeed(seedDefaultAgents());
    writeAgents(agents);

    // Auto-enable all seeded agents so they're immediately startable from dashboard
    const enabled = readEnabledAgents();
    for (const agent of agents) {
      enabled.add(agent.id);
    }
    writeEnabledAgents(enabled);

    console.log(`First run — created ${agents.length} default agents (${agents.map(a => a.name).join(', ')}).`);
  }

  agents = agents.map((agent) => ({
    ...agent,
    runtimeEnvironment: normalizeRuntimeEnvironment(
      agent.runtimeEnvironment,
      isDockerAvailable() ? 'container' : 'bare_metal',
    ),
  }));

  // If linked to platform, connect for WS relay (sync is one-way: runtime → platform)
  if (accessToken) {
    console.log(`Linked to ${config.platformUrl} — will push agent sync after startup.`);
  } else {
    console.log('No platform login — using local agents.');
  }

  // Filter agents if specific ones requested
  if (config.agentFilter.length > 0 && agents.length > 0) {
    const filter = config.agentFilter.map((f) => f.toLowerCase());
    agents = agents.filter(
      (a) =>
        filter.includes(a.name.toLowerCase()) ||
        filter.includes(a.username.toLowerCase()) ||
        filter.includes(a.id),
    );

    if (agents.length === 0) {
      console.error(
        `No agents match filter: ${config.agentFilter.join(', ')}`,
      );
      process.exit(1);
    }
  }

  // If we're the forked daemon process or --foreground, run directly
  if (process.env['SHIZUHA_DAEMON'] === '1' || config.foreground) {
    await runDaemon(config, accessToken, agents);
    return;
  }

  // ---- Foreground: fork the daemon and exit ----

  if (agents.length > 0) {
    console.log(`Found ${agents.length} agent(s):`);
    for (const agent of agents) {
      const agentDir = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents', agent.username);
      const configSource = fs.existsSync(path.join(agentDir, 'agent.toml')) ? 'local' : 'platform';
      console.log(`  ${agent.name} (${agent.username}) — config: ${configSource}`);
    }
  } else {
    console.log('No agents discovered. Dashboard will start in standalone mode.');
  }
  console.log('');

  // Ensure log directory exists
  const logDir = path.dirname(daemonLogPath());
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  }

  // Open log file for daemon stdout/stderr
  const logFd = fs.openSync(daemonLogPath(), 'a');

  // Fork a detached daemon process
  const shizuhaJs = process.argv[1]!;
  const daemonArgs = process.argv.slice(2); // pass same args
  const daemon = spawn(process.execPath, [shizuhaJs, ...daemonArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ignore'],
    env: {
      ...process.env,
      SHIZUHA_DAEMON: '1',
      SHIZUHA_ACCESS_TOKEN: accessToken,
    },
  });

  // Write preliminary state so `shizuha status` works immediately
  // Agents default to disabled (not started) unless explicitly filtered
  const autoEnable = config.agentFilter.length > 0;
  const daemonState: DaemonState = {
    pid: daemon.pid!,
    startedAt: new Date().toISOString(),
    platformUrl: config.platformUrl,
    agents: agents.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      tokenPrefix: '',
      status: autoEnable ? 'starting' as const : 'stopped' as const,
      enabled: autoEnable,
      startedAt: new Date().toISOString(),
    })),
  };
  writeDaemonState(daemonState);

  // Detach — daemon continues after parent exits
  daemon.unref();
  fs.closeSync(logFd);

  console.log(`Daemon started (PID ${daemon.pid})`);
  console.log(`  Logs: ${daemonLogPath()}`);
  console.log(`  Dashboard: http://localhost:8015/`);
  console.log('');
  console.log(`Use "shizuha status" to check status, "shizuha down" to stop.`);
}

/**
 * The actual daemon loop — runs in the detached background process.
 *
 * Agents are registered but only started if explicitly filtered via CLI
 * or enabled later via dashboard API.
 */
export async function settleDaemonStartupDependencies<Capabilities, RuntimeSsot, Identities>(
  dependencies: {
    effectiveCapabilities: () => Promise<Capabilities>;
    runtimeSsot: () => Promise<RuntimeSsot>;
    credentialIdentities: () => Promise<Identities>;
  },
): Promise<[Capabilities, RuntimeSsot, Identities]> {
  // Identity inventory is independent of the per-agent Hive reads, so overlap
  // it with the capability refresh. Keep runtime-SSOT after that refresh: both
  // paths fan out to Hive, and running them together would increase dependency
  // pressure precisely while Hive may itself be rolling. The runtime-fleet
  // listener cannot bind until these safety preflights settle, so this removes
  // safe serialization without creating a startup request burst.
  const effectiveCapabilities = dependencies.effectiveCapabilities();
  const credentialIdentities = dependencies.credentialIdentities();
  const [capabilities, identities] = await Promise.all([
    effectiveCapabilities,
    credentialIdentities,
  ]);
  const runtimeSsot = await dependencies.runtimeSsot();
  return [capabilities, runtimeSsot, identities];
}

async function runDaemon(
  config: DaemonConfig,
  accessToken: string,
  agents: AgentInfo[],
): Promise<void> {
  const client = new PlatformClient(config.platformUrl, accessToken);
  platformClient = client;
  daemonConfig = config;
  discoveredAgents = agents;
  // The runtime-fleet Deployment is intentionally single-replica/Recreate: it
  // owns host-local Docker state and fixed listener ports, so a second daemon
  // cannot safely overlap it. Keep the unavoidable listener gap bounded by
  // overlapping the independent identity prefetch with the Hive capability
  // sweep. Runtime-SSOT follows the capability sweep so the two per-agent Hive
  // reads cannot amplify dependency load during a Hive rollout. All preflights
  // still complete before credential migration, dashboard startup, or any
  // enabled agent launch.
  // Hive owns the runtime lane (model/method/fallbacks/overrides). Resolve it
  // before any enabled agent is started so a daemon/controller restart cannot
  // first render the stale local-store lane and then replace that pod template
  // on the initial lifecycle reconcile. The periodic reconcile remains the
  // disconnected-frame backstop after startup.
  const startupRuntimeById = new Map(agents.map((agent) => [agent.id, agent]));
  lastRuntimeSsotRefreshAttemptAt = Date.now();
  const [, startupSsotResult, verifiedCredentialSeedIdentities] = await settleDaemonStartupDependencies({
    effectiveCapabilities: () => refreshEffectiveCapabilitiesForAgents(agents, 'startup'),
    runtimeSsot: () => refreshRuntimeSsot(
      agents,
      startupRuntimeById,
      (agentId, signal) => client.getFleetAgent(agentId, signal),
      { concurrency: 4, timeoutMs: 10_000 },
    ),
    credentialIdentities: () => prefetchAllIdentities(config.platformUrl, accessToken),
  });
  const startupSsotTotalFailure = agents.length > 0
    && startupSsotResult.refreshed === 0
    && startupSsotResult.failedAgentIds.length === agents.length;
  recordRuntimeSsotRefresh(
    startupSsotTotalFailure,
    startupSsotResult.failedAgentIds.length,
  );
  if (startupSsotTotalFailure) {
    console.error(
      `[daemon] Startup SSOT refresh failed for all ${agents.length} agents; ` +
      'keeping the last-valid local runtime lane and retrying during reconcile',
    );
  } else {
    console.log(
      `[daemon] Startup SSOT refresh completed before agent start: ` +
      `refreshed=${startupSsotResult.refreshed} ` +
      `drifted=${startupSsotResult.driftedAgentIds.length} ` +
      `failed=${startupSsotResult.failedAgentIds.length}`,
    );
  }

  console.log(`[daemon] Starting (PID ${process.pid}), ${agents.length} agents discovered`);

  // Acquire exclusive PID lock — kills any existing daemon (installed or dev)
  acquirePidLock();

  // PLAT-129: per-launch env files are normally removed shortly after Docker
  // consumes them, but a daemon crash/restart can interrupt that timer. Sweep
  // all per-agent launch files on daemon start so disabled/deleted/non-relaunched
  // agents cannot retain token-bearing files indefinitely.
  sweepAllPrivateDockerEnvFiles(process.env['HOME'] ?? path.resolve(os.homedir()));

  // Start HTTPS CONNECT proxy for agent containers.
  // Rust HTTP clients (Codex CLI) fail with IPv6 DNS in Docker — this proxy
  // runs on the host (Node.js handles IPv4 fallback) and containers route
  // through it via HTTPS_PROXY env var.
  if (isDockerAvailable()) {
    try {
      const proxyPort = await startHttpsProxy();
      console.log(`[daemon] HTTPS proxy started on port ${proxyPort} (for container IPv6 workaround)`);
    } catch (err) {
      console.warn(`[daemon] Failed to start HTTPS proxy: ${(err as Error).message} — containers may have connectivity issues`);
    }
  }

  // All container agents use the same fixed internal port (8080). Each container has
  // its own Docker network IP, so there's no conflict. The daemon connects via
  // getContainerUrl() which resolves container IP + this fixed port.
  // Bare-metal agents still need unique ports on the host.
  const CONTAINER_INTERNAL_PORT = 8080;
  for (const agent of agents) {
    const runtime = normalizeRuntimeEnvironment(agent.runtimeEnvironment, 'container');
    if (runtime === 'bare_metal') {
      // Bare metal needs a unique host port
      if (!agent.localPort) {
        agent.localPort = nextLocalPort();
      } else if (!isPortAvailable(agent.localPort)) {
        agent.localPort = nextLocalPort();
      }
    } else {
      // Container agents: fixed internal port, differentiated by IP
      agent.localPort = CONTAINER_INTERNAL_PORT;
    }
  }

  // Restore persisted enabled state, or use CLI filter for first-time setup.
  const persistedEnabled = readEnabledAgents();
  const cliFilter = config.agentFilter.length > 0;
  // SCLI-110: explicitly-stopped agents stay stopped across restart/reconcile,
  // overriding cliFilter and enabled-agents.json.
  const disabledAgents = readDisabledAgents();

  // Pre-fetch identities and apply verified S10 seeding before dashboard startup.
  // This keeps dashboard/bridge handlers on the post-seed agent objects and,
  // when --agent filters are used, persists only the migrated subset back into
  // the full stored roster instead of truncating agents.json to the filter.
  const verifiedCredentialMigration = migrateAgentCredentialGrants(agents, persistedEnabled, {
    trustedPlatformIdentities: verifiedCredentialSeedIdentities.identities,
    trustedPlatformIdentitiesAuthoritative: verifiedCredentialSeedIdentities.authoritative,
  });
  if (shouldPersistAgentCredentialMigration(verifiedCredentialMigration)) {
    agents = verifiedCredentialMigration.agents;
    discoveredAgents = agents;
    writeAgents(mergeMigratedAgentsIntoStoredRoster(readAgents(), verifiedCredentialMigration.agents));
    console.log(
      `[daemon] Migrated verified agent credential permissions: ` +
      `seeded ${verifiedCredentialMigration.seededGrantPermissions} grant permission record(s), ` +
      `seeded ${verifiedCredentialMigration.seededAuditRoles} audit role record(s), ` +
      `marked ${verifiedCredentialMigration.seededPermissionBaselines} permission baseline(s)`,
    );
    // migrateAgentCredentialGrants preserves the already-refreshed effective
    // capability overlay. Re-fetching all agents here used to serialize a
    // second fleet-wide network sweep before :8016 could bind, adding 10-20s
    // of control-plane outage to every CI rollout without changing the result.
  }

  // Update state with our real PID (may differ from parent's estimate).
  const daemonState: DaemonState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    platformUrl: config.platformUrl,
    agents: agents.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      tokenPrefix: '',
      status: 'stopped' as const,
      enabled: (cliFilter || persistedEnabled.has(a.id)) && !disabledAgents.has(a.id),
      startedAt: new Date().toISOString(),
    })),
  };
  inMemoryState = daemonState;
  writeDaemonState(daemonState);

  const credentialAuditPath = credentialAuditLogPath();
  const recordCredentialAuditEvent = createCredentialAuditLogger(credentialAuditPath);

  const brokerStore: CredentialBrokerStore = createMirroredCredentialBrokerStore(
    () => discoveredAgents,
    (updatedAgents) => {
      agents.splice(0, agents.length, ...structuredClone(updatedAgents));
      discoveredAgents = agents;
    },
    (updatedAgents) => {
      const updatedById = new Map(updatedAgents.map((agent) => [agent.id, agent]));
      const latestAllAgents = readAgents();
      const mergedAgents = latestAllAgents.map((agent) => updatedById.get(agent.id) ?? agent);
      const existingIds = new Set(latestAllAgents.map((agent) => agent.id));
      for (const agent of updatedAgents) {
        if (!existingIds.has(agent.id)) mergedAgents.push(agent);
      }
      writeAgents(mergedAgents);
    },
  );
  try {
    credentialBrokerHandle = await startCredentialBroker({
      store: brokerStore,
      recordAuditEvent: recordCredentialAuditEvent,
      queryAuditEvents: (query) => queryCredentialAuditLog(credentialAuditPath, query),
      onCredentialGrantCircuitBreakerAlert: emitCredentialGrantCircuitBreakerAlert,
      onInjectableCredentialRevoked: (agent, credential) => {
        if (!childProcesses.has(agent.id)) return;
        console.warn(
          `[credential-broker] restarting ${agent.username || agent.id} after revoking injectable credential ${credential.grantId ?? credential.id}`,
        );
        restartAgent(agent.id);
      },
      onInjectableCredentialGranted: (agent, credential) => {
        if (!childProcesses.has(agent.id)) return;
        console.warn(
          `[credential-broker] restarting ${agent.username || agent.id} after granting injectable credential ${credential.grantId ?? credential.id}`,
        );
        restartAgent(agent.id);
      },
      logger: console,
    });
  } catch (err) {
    console.warn(`[daemon] Credential broker failed to start: ${(err as Error).message}`);
  }

  // PLAT-166 / ADR-PLAT-002 §5: optional cluster-internal JWT-authed network listener
  // — the pod-reachable twin of request.sock, routing into the SAME broker arbiter.
  // INERT unless fully configured (port + JWKS URL + issuer + audience all set), so it
  // lands safely ahead of any consumer (PR-B sidecar). Non-fatal on failure: the host
  // sockets keep serving. NetworkPolicy must scope the bind to sidecar pods.
  try {
    const port = Number.parseInt(process.env.SHIZUHA_CREDENTIAL_BROKER_NET_PORT ?? '', 10);
    const jwksUri = process.env.SHIZUHA_CREDENTIAL_BROKER_JWKS_URL;
    const issuer = process.env.SHIZUHA_CREDENTIAL_BROKER_JWT_ISSUER;
    const audience = process.env.SHIZUHA_CREDENTIAL_BROKER_JWT_AUDIENCE;
    if (Number.isFinite(port) && port > 0 && jwksUri && issuer && audience) {
      const maxTtlSeconds = Number.parseInt(process.env.SHIZUHA_CREDENTIAL_BROKER_MAX_TTL_SECONDS ?? '900', 10) || 900;
      const host = process.env.SHIZUHA_CREDENTIAL_BROKER_NET_HOST ?? '0.0.0.0';
      const app = buildCredentialBrokerNetworkListener({
        verifier: new JwksTokenVerifier({ jwksUri, issuer, audience }),
        options: {
          store: brokerStore,
          recordAuditEvent: recordCredentialAuditEvent,
          queryAuditEvents: (query) => queryCredentialAuditLog(credentialAuditPath, query),
          logger: console,
        },
        maxTtlSeconds,
        podIdentity: process.env.SHIZUHA_CREDENTIAL_BROKER_POD_ID ?? process.env.HOSTNAME,
      });
      await app.listen({ host, port });
      console.log(`[credential-broker] cluster-internal network listener on ${host}:${port} (maxTtl=${maxTtlSeconds}s)`);
    }
  } catch (err) {
    console.warn(`[credential-broker] network listener failed to start (host sockets unaffected): ${(err as Error).message}`);
  }

  // Start the dashboard server.
  // Primary port 8015 serves HTTPS when TLS is available, else HTTP.
  // When TLS is available, plain HTTP is exposed on 8016 for local agent calls.
  let tls: { cert: string; key: string } | undefined;
  try {
    const { ensureTlsCert } = await import('./tls.js');
    tls = ensureTlsCert();
  } catch {
    // TLS cert generation failed — HTTP only
  }
  daemonHttpPort = tls ? 8016 : 8015;
  const dashboardListenerPlan = resolveDashboardListenerPlan({
    containerMode: config.containerMode,
    hostGateway: resolveContainerDashboardHost(config.containerMode),
  });
  const dashboardHost = dashboardListenerPlan.primaryHost;
  let dashboardStarted = false;

  daemonLinkClient = buildDaemonLinkClientFromEnv(
    config.platformUrl,
    () => discoveredAgents,
    () => inMemoryState,
    (agentId, updates, runtimeLane) => updateLocalAgentAtRuntime(agentId, updates, runtimeLane),
    (agentId) => {
      const result = deleteLocalAgentAtRuntime(agentId);
      // Hive tombstones replay on reconnect until convergence. A replay after
      // the first successful removal is already converged, not an error.
      return !result.ok && result.error === 'Agent not found' ? { ok: true } : result;
    },
    getAgentLastActivity,
    probeAppliedRuntimeLaneHealth,
  );
  daemonLinkClient.start();

  // Yield the probe ports to the real dashboard. No restore on failure: a
  // daemon whose dashboard cannot bind IS dead — liveness failing then is the
  // correct outcome (kill + retry), not something to paper over.
  bootHealthListeners?.close();
  bootHealthListeners = null;
  try {
    await startDashboard({
      port: 8015,
      host: dashboardHost,
      platformUrl: config.platformUrl,
      accessToken,
      agents,
      tls,
      daemonLinkStatus: () => daemonLinkClient?.getStatus() ?? null,
    });
    dashboardStarted = true;
    console.log(`[daemon] Dashboard listening on ${dashboardHost}:8015 (${tls ? 'HTTPS' : 'HTTP'})${tls ? ' + :8016 (HTTP)' : ''}`);
  } catch (err) {
    console.error(`[daemon] Dashboard failed with TLS on ${dashboardHost}: ${(err as Error).message}`);
    if (tls) {
      // Retry without TLS — dashboard availability is more important than HTTPS
      console.log(`[daemon] Retrying dashboard on ${dashboardHost} without TLS (HTTP-only fallback)...`);
      const tlsForRetry = tls;
      tls = undefined;
      daemonHttpPort = 8015;
      try {
        await startDashboard({
          port: 8015,
          host: dashboardHost,
          platformUrl: config.platformUrl,
          accessToken,
          agents,
          daemonLinkStatus: () => daemonLinkClient?.getStatus() ?? null,
        });
        dashboardStarted = true;
        console.log(`[daemon] Dashboard listening on ${dashboardHost}:8015 (HTTP, TLS fallback)`);
      } catch (retryErr) {
        console.error(`[daemon] Dashboard failed even without TLS on ${dashboardHost}: ${(retryErr as Error).message}`);
      }
      tls = tlsForRetry;
    }
  }

  if (dashboardStarted) {
    for (const proxyHost of dashboardListenerPlan.proxyHosts) {
      try {
        await startDashboardTcpProxy({
          listenHost: proxyHost,
          port: Number(resolveDaemonHttpPort()),
          targetHost: dashboardHost,
          // Match the proxy target to the daemon HTTP port. When TLS is
          // enabled, :8015 is HTTPS and :8016 is the local HTTP listener used
          // by container agents; forwarding the Docker-bridge HTTP proxy to
          // :8015 makes every broker call fail with 502.
          targetPort: Number(resolveDaemonHttpPort()),
        });
        console.log(`[daemon] Dashboard container bridge listening on ${proxyHost}:${resolveDaemonHttpPort()} -> ${dashboardHost}:${resolveDaemonHttpPort()}`);
      } catch (err) {
        console.error(`[daemon] Dashboard container bridge failed on ${proxyHost}:${resolveDaemonHttpPort()}: ${(err as Error).message}`);
      }
    }
  }

  // Auto-start agents that are enabled (from persisted state or CLI filter).
  // Bring the dashboard up first so clients see a live daemon immediately
  // during restart, even while runtimes are still booting.
  const toStart = daemonState.agents.filter((a) => a.enabled);
  console.log(`[daemon] Starting ${toStart.length} enabled agents in parallel: ${toStart.map(a => a.agentName).join(', ')}`);
  await launchConcurrentlyWithIoYield(toStart, async (agentState) => {
    const agent = agents.find((a) => a.id === agentState.agentId);
    if (!agent) {
      console.warn(`[daemon] Agent ${agentState.agentName} (${agentState.agentId}) not found in discovered agents — skipping`);
      return;
    }
    console.log(`[daemon] Starting ${agent.name} (${agent.id.slice(0,8)}..., port=${agent.localPort}, runtime=${normalizeRuntimeEnvironment(agent.runtimeEnvironment, 'container')})`);
    const result = await enableAndStartAgent(agent.id);
    if (!result.ok) {
      console.error(`[daemon] ${agent.name}: FAILED to start — ${result.error}`);
    }
  });

  const fleetSshCredentialWatch = watchFleetSshCredentialStores({
    sshRootDir: path.join(process.env['HOME'] ?? path.resolve(os.homedir()), '.shizuha', 'ssh-keys'),
    onCredentialReady: (username) => {
      const agent = readAgents().find((candidate) => candidate.username === username);
      if (!agent || !requiresFleetSshForK8sAgent(agent)) return;
      const clearedAction = runtimeReconcileRepairBackoff.clear(agent.id);
      if (!clearedAction) return;
      clearReconcileRepairBackoff(agent.username, clearedAction);
      console.log(
        `[daemon] ${agent.name}: fleet-ssh material became ready; ` +
        'cleared runtime repair backoff and scheduled immediate reconcile.',
      );
      setTimeout(() => void scheduleRuntimeLifecycleReconcile(), 0).unref?.();
    },
  });

  // Graceful shutdown
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[daemon] Shutting down...');
    daemonLinkClient?.stop();
    fleetSshCredentialWatch.close();
    // Runner proxies removed 2026-04-20 — shizuha-agent's /ws/runner/ retired.
    stopAllAgents();
    stopHttpsProxy();
    clearDaemonState();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const enabledCount = toStart.length;
  console.log(`[daemon] Running. ${agents.length} agents discovered, ${enabledCount} enabled.`);

  // Start runner proxies now that all agents have tokens
  const startProxiesFn = (globalThis as any).__startRunnerProxies;
  if (typeof startProxiesFn === 'function') {
    startProxiesFn().catch((err: Error) => console.warn('[daemon] Runner proxy startup error:', err.message));
  }

  // Resume desired-state enforcement immediately. Waiting for the generic
  // heartbeat added a full minute to every controller restart and interrupted
  // active harness rolls after a source deployment.
  setTimeout(() => void scheduleRuntimeLifecycleReconcile(), 0).unref?.();

  // Heartbeat
  setInterval(() => {
    const running = Array.from(childProcesses.entries()).filter(
      ([, cp]) => !cp.killed && cp.exitCode === null,
    );
    logger.debug({ running: running.length, total: agents.length }, 'Daemon heartbeat');
    // SCLI-149/HIVE-262: reconcile disabled local children and k8s-native Deployments.
    void scheduleRuntimeLifecycleReconcile();
  }, 60_000);

  // PLAT-1309: the runtime reconcile is ENFORCE — it actually stops zombies and
  // re-applies desired-enabled agents (there is no observe/dry-run branch above).
  // Publish the mode as a gauge so it is confirmable off-host on /metrics.
  setReconcileMode('enforce');

  // PLAT-1193 (3rd recurrence, 2026-07-04): periodically re-verify cooled claude
  // tokens. In broker topology the pick-path probe never fires, so stale/overshot
  // cooldown stamps silently squeezed the pool (fleet painted Unavailable while
  // probes would return 200). All probe bounds live inside; a genuinely-throttled
  // token is simply re-cooled by its next real 429. Run once shortly after start
  // (stale stamps from before a restart clear within a minute), then every 10m.
  const staleCooldownTimer = setInterval(() => {
    try { probeStaleClaudeCooldowns(); } catch (err) {
      console.warn(`[daemon] stale-cooldown probe pass failed: ${(err as Error).message}`);
    }
  }, 10 * 60_000);
  staleCooldownTimer.unref?.();
  const staleCooldownKick = setTimeout(() => {
    try { probeStaleClaudeCooldowns(); } catch (err) {
      console.warn(`[daemon] startup stale-cooldown probe failed: ${(err as Error).message}`);
    }
  }, 45_000);
  staleCooldownKick.unref?.();

  // PLAT-588: start agent-health exporter on :9888. Reads enabled-agents.json
  // and agents.json on every scrape so enable/disable changes propagate within
  // 1 gather cycle without a daemon restart.
  startAgentHealthServer(() => {
    const enabledIds = readEnabledAgents();
    return readAgents().map((a) => {
      const proc = childProcesses.get(a.id);
      return {
        username: a.username,
        enabled: enabledIds.has(a.id),
        running: !!proc && !proc.killed && proc.exitCode === null,
        capacityUnavailable: tokenPoolBackoffSet.has(a.id),
      };
    });
  });

  // SCLI-35: register the fleet-level periodic run-reviewer (systemic-pattern
  // digest over scli-33 struggle bugs). The daemon is the single fleet-wide
  // process, so it runs here once rather than per-agent. Self-resolves its
  // Pulse base URL + token from env and self-guards on a missing
  // PULSE_SERVICE_TOKEN (no-op when the daemon isn't linked to platform Pulse);
  // its interval is unref'd so it never holds the process open.
  setupPeriodicRunReviewer();

  // HIVE-248 (ADR-0004 ph5): declarative per-team backend reconcile loop.
  // Initial pass at startup, then every 5 minutes — re-reads the policy file
  // each time so operator edits take effect without a daemon restart.
  const _shizuhaHome = process.env['HOME'] ?? path.resolve(os.homedir());
  reconcileTeamBackends(readTeamBackendPolicy(_shizuhaHome));
  const backendReconcileTimer = setInterval(
    () => reconcileTeamBackends(readTeamBackendPolicy(_shizuhaHome)),
    5 * 60_000,
  );
  backendReconcileTimer.unref(); // don't hold the process open if only this timer remains

  // PLAT-1092: Hive effective capabilities are a daemon-applied desired-state
  // read model. Periodic refresh lets team capability changes revoke/add skills
  // and MCP access without hand-editing agents.json or restarting the daemon.
  startEffectiveCapabilityRefreshLoop(agents);
}


export function k8sGithubAuthAndonContent(agent: AgentInfo, result: K8sGitHubCredentialProbeResult, manager: string): string {
  const transportFailure = result.reason === 'probe_transport_failed';
  const upstreamFailure = result.reason === 'github_upstream_unavailable';
  // PLAT-4958: `deployment_unready` is an EARLY RETURN in
  // probeK8sGithubCredentialHealth() -- it fires on replica counts alone
  // (replicas/ready/available <= 0) and returns BEFORE the in-pod
  // `gh api user` + repo probe runs. Rendering the credential invariant here
  // asserted a check that never executed, and sent ten responders to verify a
  // GitHub token the probe had not touched. Same class as the two UNKNOWN
  // branches below, and the same rule the sibling comment states:
  // never page a credential verdict before the authoritative exec probe runs.
  //
  // NOT EVALUATED vs UNKNOWN (aoi/shion, PLAT-4958): the two branches below use
  // UNKNOWN because the probe RAN and could not reach a verdict (exec transport
  // died / GitHub was unavailable). Here the probe NEVER RAN at all, which is a
  // different epistemic state and deserves different wording: UNKNOWN merely
  // declines to assert, and still invites a responder to go and check the
  // credential -- which is the exact harm this fix exists to stop.
  const deploymentUnready = result.reason === 'deployment_unready';
  return [
    transportFailure
      ? '## 🔴 ANDON — k8s GitHub auth probe transport failed'
      : upstreamFailure
        ? '## 🔴 ANDON — GitHub API upstream unavailable'
      : deploymentUnready
        ? '## 🔴 ANDON — k8s agent Deployment not ready (credential probe did NOT run)'
      : '## 🔴 ANDON — k8s GitHub auth probe failed',
    `- Agent: ${agent.name} (@${agent.username})`,
    `- Team: ${agent.team || 'unknown'} → manager @${manager}`,
    `- Runtime: deploy/agent-${agent.username} in shizuha-fleet`,
    `- Reason: ${result.reason}`,
    result.detail ? `- Detail: ${result.detail}` : null,
    transportFailure
      ? `- Probe: kubectl exec transport failed before the in-pod GitHub checks could complete${result.probeRepo ? ` (intended repo probe: ${result.probeRepo})` : ''}`
      : upstreamFailure
        ? `- Probe: GitHub API returned an upstream/availability failure after bounded retries${result.probeRepo ? ` (repo probe: ${result.probeRepo})` : ''}`
      : deploymentUnready
        ? '- Probe: NOT RUN — the Deployment reported no ready/available replica, so the probe returned before the in-pod GitHub checks'
      : `- Probe: GITHUB_TOKEN non-empty + gh api user${result.probeRepo ? ` + repo access ${result.probeRepo}` : ''}`,
    '',
    transportFailure
      ? 'Invariant status: UNKNOWN — this is a daemon/kubectl exec transport failure, not proof of a bad GitHub token. Check rt-fleet kubectl/API-server/container targeting before repairing credentials. Runtime reconcile continues separately; this page is rate-limited per agent/reason.'
      : upstreamFailure
        ? 'Invariant status: UNKNOWN — GitHub/API is unavailable; this is not proof of a bad token. Do not repair or rotate credentials from this signal. Runtime reconcile continues separately; this page is rate-limited per agent/reason.'
      : deploymentUnready
        ? 'Invariant status: NOT EVALUATED — the GitHub credential probe did NOT run. This page reports a Kubernetes readiness/replica condition only and is NOT evidence about the runtime token, in either direction. Do NOT repair, rotate or re-materialize credentials from this signal, and do NOT open a credential investigation on the strength of this page. Investigate why the Deployment has no ready replica (readinessProbe path/thresholds, pod events, image pull). Runtime reconcile continues separately; this page is rate-limited per agent/reason.'
      : 'Invariant: every k8s-native agent with an active GitHub grant must have a live runtime token that authenticates, not merely a non-empty Secret. Runtime reconcile continues separately; this page is rate-limited per agent/reason.',
  ].filter(Boolean).join('\n');
}

function maybeSendK8sGithubAuthAndon(agent: AgentInfo, result: K8sGitHubCredentialProbeResult): void {
  const key = `${agent.id}:${result.reason}`;
  const now = Date.now();
  const lastSent = lastK8sGithubAuthAndonByAgentReason.get(key);
  if (lastSent !== undefined && now - lastSent < K8S_GITHUB_AUTH_ANDON_RATE_LIMIT_MS) return;
  lastK8sGithubAuthAndonByAgentReason.set(key, now);

  const manager = resolveClusterManagerUsername(agent.team);
  const platformUrl = daemonConfig?.platformUrl || process.env['SHIZUHA_PLATFORM_URL'] || process.env['BACKEND_URL'] || '';
  void sendConnectDm({
    recipientUsername: manager,
    content: k8sGithubAuthAndonContent(agent, result, manager),
    platformUrl,
    sender: {
      username: agent.username,
      email: agent.email || `${agent.username}@agents.shizuha.io`,
      agentId: agent.id,
      isAgent: true,
    },
    senderPassword: resolveAgentPassword(agent),
    timeoutMs: 10_000,
  }).then((sendResult) => {
    if (sendResult.ok) return;
    lastK8sGithubAuthAndonByAgentReason.delete(key);
    recordK8sGithubAuthAndonSendFailure();
    console.error(
      `[daemon] k8s GitHub auth ANDON DM failed for ${agent.username}: ` +
      `${sendResult.error || `status ${sendResult.status ?? 'unknown'}`}`,
    );
  }).catch((err) => {
    // Clear the rate-limit on send failure so the next reconcile can retry;
    // expose the notifier failure as its own metric per PLAT-1254.
    lastK8sGithubAuthAndonByAgentReason.delete(key);
    recordK8sGithubAuthAndonSendFailure();
    console.error(`[daemon] k8s GitHub auth ANDON DM failed for ${agent.username}: ${(err as Error).message}`);
  });
}

function maybeProbeK8sGithubAuth(agents: AgentInfo[], k8sDeploymentStates: ReturnType<typeof listK8sAgentDeployments>, enabledIds: Set<string>): void {
  const now = Date.now();
  if (now - lastK8sGithubAuthProbeAt < K8S_GITHUB_AUTH_PROBE_INTERVAL_MS) return;
  lastK8sGithubAuthProbeAt = now;

  const results = probeK8sGithubCredentialHealth(agents, k8sDeploymentStates, enabledIds);
  if (results.length === 0) return;
  recordK8sGithubAuthProbe(results);
  for (const result of results) {
    if (result.ok) continue;
    const agent = agents.find((a) => a.id === result.agentId);
    if (!agent) continue;
    console.error(
      `[daemon][ALERT][PLAT-3170] ${agent.username}: k8s GitHub auth probe failed ` +
      `(reason=${result.reason}, team=${agent.team || 'unknown'}, owner_group=${result.ownerGroup})` +
      (result.detail ? ` detail=${result.detail}` : ''),
    );
    maybeSendK8sGithubAuthAndon(agent, result);
  }
}

/**
 * SCLI-149/HIVE-262: periodic runtime lifecycle reconcile. Stops disabled local
 * children and k8s-native Deployments, and re-applies desired-enabled k8s agents
 * that have no healthy Deployment. The pure planner keeps SCLI-149's two-source
 * agreement, empty-set guard, and mass-stop circuit breaker across both backends.
 */
// SCLI-331: idle-gated, bounded harness/runtime-image roller. Makes the
// daemon behave like a k8s operator — agents are independent workload pods that
// upgrade one at a time when idle, instead of the whole fleet bouncing on a
// daemon restart or an image-env bump. Sessions survive (PVC-backed workspace).
const HARNESS_ROLL_ENABLED =
  (process.env['SHIZUHA_HARNESS_AUTO_ROLL'] ?? 'true').toLowerCase() !== 'false';
const HARNESS_ROLL_IDLE_MS = Math.max(
  15_000,
  Number(process.env['SHIZUHA_HARNESS_ROLL_IDLE_SECONDS'] ?? '30') * 1000,
);
// PLAT-4211: minimum wall-clock spacing between harness rolls. The anyConverging
// gate alone under-serializes (a Recreate briefly shows replicas=0, so the next
// tick doesn't see the rolling agent as "converging" and fires again) — 40 agents
// flipped in ~4min on the 20260711d roll, and the simultaneous re-auth herd drove
// the platform-db CNPG primary to its max_connections ceiling (cascading 500s on
// id/pulse/hive). An explicit floor spaces the re-auth load so a fleet-wide harness
// bump rolls gently instead of storming. Sessions survive on the PVC either way.
const HARNESS_ROLL_MIN_INTERVAL_MS = Math.max(
  0,
  Number(process.env['SHIZUHA_HARNESS_ROLL_MIN_INTERVAL_SECONDS'] ?? '15') * 1000,
);
export function resolveHarnessRollBusyRecheckMs(rawSeconds: unknown): number {
  const seconds = rawSeconds === undefined || rawSeconds === '' ? 15 : Number(rawSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return 15_000;
  return Math.min(60_000, Math.max(5_000, seconds * 1000));
}
const HARNESS_ROLL_BUSY_RECHECK_MS = resolveHarnessRollBusyRecheckMs(
  process.env['SHIZUHA_HARNESS_ROLL_BUSY_RECHECK_SECONDS'],
);
// Keep the proven 4-starts/minute PLAT-4211 re-auth ceiling while allowing
// readiness waits to overlap. A 15s start floor plus a four-pod window turns
// the former ~50s-per-agent serialization into bounded, rate-safe convergence.
const HARNESS_ROLL_MAX_IN_FLIGHT = Math.min(
  4,
  Math.max(1, Number(process.env['SHIZUHA_HARNESS_ROLL_MAX_IN_FLIGHT'] ?? '4') || 4),
);
let lastHarnessRollAt = 0;
let lastRuntimeReleaseIssueLogAt = 0;
let lastValidatedRuntimeImage: string | undefined;
let harnessRollWakeTimer: ReturnType<typeof setTimeout> | null = null;
const harnessRollInFlightAgentIds = new Set<string>();
let loadedHarnessRollStateForImage: string | null = null;

// Reconcile also wakes at the faster harness-roll cadence. Keep each agent's
// failing repair independent so one broken grant cannot create an auth/apply
// hot loop or block healthy agents. A changed desired hash is a new work key
// and bypasses this delay immediately.
const runtimeReconcileRepairBackoff = new RuntimeReconcileRepairBackoff();

export function harnessRollWakeDelayMs(
  now: number,
  previousRollAt: number,
  minimumIntervalMs: number,
): number {
  return Math.max(1_000, minimumIntervalMs - Math.max(0, now - previousRollAt));
}

export function harnessRollInFlightReady(
  agentId: string,
  deploymentStates: K8sDeploymentState[],
): boolean {
  const state = deploymentStates.find((deployment) => deployment.agentId === agentId);
  return Boolean(
    state
    && state.replicas > 0
    && state.generation !== undefined
    && state.observedGeneration !== undefined
    && state.observedGeneration >= state.generation
    && (state.updatedReplicas ?? 0) >= state.replicas
    && state.readyReplicas >= state.replicas
    && state.availableReplicas >= state.replicas
  );
}

export function pendingHarnessRollAgentIds(
  agentIds: Iterable<string>,
  desiredAgentIds: Set<string>,
  deploymentStates: K8sDeploymentState[],
): string[] {
  return [...agentIds].filter((agentId) => (
    desiredAgentIds.has(agentId) && !harnessRollInFlightReady(agentId, deploymentStates)
  ));
}

export function harnessRollHasCapacity(inFlightCount: number, maximumInFlight: number): boolean {
  return inFlightCount < Math.max(1, maximumInFlight);
}

/** Wake the image operator at the cooldown boundary instead of waiting for the
 * generic 60s fleet heartbeat. The bounded window overlaps pod readiness while
 * lastHarnessRollAt keeps starts at 4 agents/minute, below the old 10/min herd. */
function scheduleHarnessRollWake(delayMs = HARNESS_ROLL_MIN_INTERVAL_MS): void {
  if (harnessRollWakeTimer) return;
  harnessRollWakeTimer = setTimeout(() => {
    harnessRollWakeTimer = null;
    void scheduleRuntimeLifecycleReconcile();
  }, Math.max(1_000, delayMs));
  harnessRollWakeTimer.unref?.();
}

// SCLI-331 tail-completion: activity-idle gating alone never converges a fleet
// where agents are continuously busy (27/53 "on the job" left 23 agents stuck
// on a 6h-stale harness on 2026-07-16). After this grace window, stale agents
// enter the live bridge drain/probe lane even without an activity-idle hint.
// The bridge fence remains authoritative and starts stay paced by
// HARNESS_ROLL_MIN_INTERVAL_MS, so no active turn is force-interrupted and the
// re-auth herd (PLAT-4211) cannot storm platform-db.
//
// A live override accidentally set this to 60 seconds on 2026-07-17. That
// defeated idle gating, killed active Codex/Claude turns, and triggered a
// synchronized paid heartbeat after every release. Keep force-stale as an
// eventual-recovery backstop, but never let configuration shorten it below the
// bridge's 45-minute stuck-turn recovery window. Healthy turns get a chance to
// finish; genuinely wedged turns are recovered before the roller's last resort.
const HARNESS_ROLL_FORCE_STALE_FLOOR_MS = 60 * 60_000;
export function resolveHarnessRollMaxStaleMs(rawSeconds: unknown): number {
  const seconds = rawSeconds === undefined || rawSeconds === ''
    ? HARNESS_ROLL_FORCE_STALE_FLOOR_MS / 1000
    : Number(rawSeconds);
  if (seconds === 0) return 0;
  if (!Number.isFinite(seconds) || seconds < 0) return HARNESS_ROLL_FORCE_STALE_FLOOR_MS;
  return Math.max(HARNESS_ROLL_FORCE_STALE_FLOOR_MS, seconds * 1000);
}
const HARNESS_ROLL_MAX_STALE_MS = resolveHarnessRollMaxStaleMs(
  process.env['SHIZUHA_HARNESS_ROLL_MAX_STALE_SECONDS'],
);
// Per-agent first-observed-drifted timestamp, target-fenced in memory as
// `${agentId}\0${desiredImage}`. Persisted unresolved-tail timestamps migrate
// across a monotonic desired-image supersession: changing the target must not
// buy a continuously busy old-image agent another full stale grace window.
// Successful convergence deletes the entry, so agents already on the previous
// target still receive a fresh clock when the next target arrives.
const harnessDriftSince = new Map<string, number>();

// PLAT-5335: preserve a real deferral clock, alert latch and /metrics series
// across successive actuator passes. The tracker can only observe/clear state;
// it never overrides runtimeRollBusyGate or authorizes a pod-template change.
const runtimeRollDeferrals = new RuntimeRollDeferralTracker(
  {
    set: setRuntimeRollDeferralStartTimestamp,
    clear: clearRuntimeRollDeferralStartTimestamp,
  },
  resolveRuntimeRollDeferAlertMs(process.env['SHIZUHA_HARNESS_ROLL_DEFER_ALERT_SECONDS']),
);

function harnessDriftKey(agentId: string, desired: string): string {
  return `${agentId}\0${desired}`;
}

function persistHarnessRollProgress(desiredImage: string): void {
  writeHarnessRollState(harnessRollStatePath(), {
    desiredImage,
    lastRollAt: lastHarnessRollAt,
    inFlightAgentIds: [...harnessRollInFlightAgentIds],
    driftSince: Object.fromEntries(harnessDriftSince),
    deferrals: runtimeRollDeferrals.snapshot(),
  });
}

function restoreHarnessRollProgress(desiredImage: string): void {
  if (loadedHarnessRollStateForImage === desiredImage) return;
  loadedHarnessRollStateForImage = desiredImage;
  harnessRollInFlightAgentIds.clear();
  harnessDriftSince.clear();
  runtimeRollDeferrals.restore({});
  lastHarnessRollAt = 0;
  const persisted = readHarnessRollState(harnessRollStatePath(), desiredImage);
  if (!persisted) {
    persistHarnessRollProgress(desiredImage);
    return;
  }
  lastHarnessRollAt = persisted.lastRollAt;
  for (const agentId of persisted.inFlightAgentIds) harnessRollInFlightAgentIds.add(agentId);
  for (const [key, since] of Object.entries(persisted.driftSince)) harnessDriftSince.set(key, since);
  runtimeRollDeferrals.restore(persisted.deferrals);
}

/** How long this agent has been drifted from `desired` (ms), 0 if first seen now. */
export function harnessDriftAgeMs(agentId: string, desired: string, now: number): number {
  const key = harnessDriftKey(agentId, desired);
  const seen = harnessDriftSince.get(key);
  if (seen === undefined) {
    harnessDriftSince.set(key, now);
    return 0;
  }
  return now - seen;
}

/** Drop drift-clock entries whose desired target is no longer current so the
 * map cannot grow unbounded across image bumps. */
export function pruneHarnessDriftClock(desired: string): void {
  for (const key of harnessDriftSince.keys()) {
    if (!key.endsWith(`\0${desired}`)) harnessDriftSince.delete(key);
  }
}

/** An agent is roll-safe when it has been quiet for HARNESS_ROLL_IDLE_MS. No
 * activity signal at all → treat as idle (a genuinely busy agent emits
 * codex-rpc / telemetry lines that feed lastActivityMap). */
function agentIsIdleForRoll(agentId: string, now: number): boolean {
  // PLAT-879 / PLAT-962: supervised wait on empty Anthropic pool is not productive
  // work. Treat capacity-limited bridges as roll-idle so they cannot pin an old
  // harness forever (Hiro 2026-07-27: "active turn" deferred while PLAT-879 looping).
  if (tokenPoolBackoffSet.has(agentId)) return true;
  const last = getAgentLastActivity(agentId);
  if (!last) return true;
  const ts = Date.parse(last);
  if (Number.isNaN(ts)) return true;
  return now - ts >= HARNESS_ROLL_IDLE_MS;
}

/** Preserve the bounded unavailable window while allowing the roller to repair
 * a drifted Deployment that is already fully unavailable. A blanket convergence
 * stop deadlocks recovery when a bad sidecar image is the reason ready=0.
 *
 * "Converging" must mean a HARNESS ROLL in flight — a still-drifted Deployment
 * that is not yet ready — NOT any Deployment that happens to be non-ready. The
 * on-demand reconciler wakes/stops agents continuously (hibernation), so an
 * unrelated wake (a Deployment already on the desired image, coming up) is
 * almost always converging; gating harness rolls on THAT starved the roller
 * and left 4 agents on a 6h-stale harness (2026-07-16). Only a converging
 * agent that is ITSELF image-drifted counts as a roll-in-flight. */
export function restrictRuntimeRollDriftForConvergence(
  drift: K8sDeploymentState[],
  deploymentStates: K8sDeploymentState[],
): K8sDeploymentState[] {
  const driftIds = new Set(drift.map((d) => d.agentId));
  const anyRollConverging = deploymentStates.some(
    (d) => d.replicas > 0 && d.readyReplicas < d.replicas && driftIds.has(d.agentId),
  );
  if (!anyRollConverging) return drift;
  return drift.filter((d) => d.replicas > 0 && d.readyReplicas === 0);
}

/** Image, broker, and pod-contract drift all share one paced rollout lane. */
export function selectRuntimeRollDrift(
  deploymentStates: K8sDeploymentState[],
  desiredImage: string,
  desiredBroker: string,
): K8sDeploymentState[] {
  return deploymentStates.filter((deployment) => (
    (deployment.currentImage && deployment.currentImage !== desiredImage)
    || (deployment.currentWorkspaceInitImage
      && deployment.currentWorkspaceInitImage !== desiredImage)
    || (desiredBroker && deployment.currentBrokerImage && deployment.currentBrokerImage !== desiredBroker)
    || deployment.runtimeSpecRevision !== K8S_RUNTIME_SPEC_REVISION
  ));
}

export function orderRuntimeRollDrift(
  drift: K8sDeploymentState[],
  desiredImage: string,
  driftAge: Map<string, number>,
): K8sDeploymentState[] {
  return [...drift].sort((a, b) => {
    const stoppedRank = (b.replicas === 0 ? 1 : 0) - (a.replicas === 0 ? 1 : 0);
    if (stoppedRank !== 0) return stoppedRank;
    const imageRank = (
      Number(Boolean(
        (b.currentImage && b.currentImage !== desiredImage)
        || (b.currentWorkspaceInitImage && b.currentWorkspaceInitImage !== desiredImage)
      ))
      - Number(Boolean(
        (a.currentImage && a.currentImage !== desiredImage)
        || (a.currentWorkspaceInitImage && a.currentWorkspaceInitImage !== desiredImage)
      ))
    );
    if (imageRank !== 0) return imageRank;
    return (driftAge.get(b.agentId) ?? 0) - (driftAge.get(a.agentId) ?? 0);
  });
}

export function shouldDeferK8sGithubProbeForHarnessRoll(
  deploymentStates: K8sDeploymentState[],
  desiredImage: string | undefined,
  desiredBroker: string | undefined,
  rollInFlight = false,
): boolean {
  return Boolean(
    rollInFlight
    || (desiredImage
      && selectRuntimeRollDrift(deploymentStates, desiredImage, desiredBroker ?? '').length > 0)
  );
}

export type RuntimeRollAction = 'stage-stopped' | 'restart-running';

export type RuntimeRollBusyGateResult =
  | {
      allow: true;
      reason: 'unavailable-repair' | 'bridge-absent-repair' | 'bridge-idle';
      protocol?: 'drain-v1' | 'drain-v2' | 'legacy-health';
    }
  | {
      allow: false;
      reason: 'bridge-busy' | 'probe-failed';
      protocol?: 'drain-v1' | 'drain-v2' | 'legacy-health';
      /** True only when the bridge actually armed a safe-boundary drain. */
      drainReserved?: boolean;
      detail?: string;
    };

/** A drain-v1 request reserves that bridge's next safe boundary, so repeatedly
 * focusing it is unnecessary and serializes the entire fleet behind one long
 * turn. Preserve the reservation, then keep scanning for a separately proven
 * idle agent. The caller prevents arming a second speculative stale drain in
 * the same pass; legacy bridges cannot reserve a boundary and also yield. */
export function shouldFocusRuntimeRollDrain(
  protocol: RuntimeRollBusyGateResult['protocol'],
  _stale = false,
): boolean {
  return protocol !== 'drain-v1' && protocol !== 'drain-v2' && protocol !== 'legacy-health';
}

/** Consume the one speculative non-idle slot only for a real reservation.
 *
 * A drain-v1 preflight can fail closed on queued rows before calling the drain
 * endpoint. Treating that as reserved lets the same backlog-heavy agent win
 * every pass and starve a later queue-zero bridge forever. Legacy-health has
 * no reservation contract, so retain its existing one-probe-per-pass bound.
 */
export function consumesRuntimeRollNonIdleProbe(
  result: RuntimeRollBusyGateResult,
): boolean {
  if (result.allow || result.reason !== 'bridge-busy') return false;
  if (result.protocol === 'legacy-health') return true;
  return (result.protocol === 'drain-v1' || result.protocol === 'drain-v2')
    && result.drainReserved === true;
}

/** Final fail-closed interruption gate for a running harness roll.
 *
 * The activity quiet window is only a scheduling hint: a bridge can spend
 * minutes inside one tool subprocess without emitting activity. Probe its live
 * busy latch immediately before changing the pod template. Readiness alone is
 * not permission to interrupt. A bridge-local connection refusal must remain
 * absent across a confirmation observation before a false-positive Ready pod
 * is repaired; kubectl/API transport failures always fail closed.
 */
export async function runtimeRollBusyGate(
  unavailable: boolean,
  prepare: () => Promise<{
    busy: boolean;
    protocol: 'drain-v1' | 'drain-v2' | 'legacy-health';
    fenceVersion?: number;
    drainReserved?: boolean;
  }>,
  legacyConfirmationDelayMs = 200,
): Promise<RuntimeRollBusyGateResult> {
  try {
    const first = await prepare();
    if (first.busy) {
      return {
        allow: false,
        reason: 'bridge-busy',
        protocol: first.protocol,
        ...(first.drainReserved ? { drainReserved: true } : {}),
      };
    }
    if (first.protocol === 'legacy-health' || first.protocol === 'drain-v1' || first.protocol === 'drain-v2') {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, legacyConfirmationDelayMs)));
      const confirmation = await prepare();
      if (
        confirmation.protocol !== first.protocol
        || confirmation.busy
        || (first.protocol === 'drain-v2' && confirmation.fenceVersion !== first.fenceVersion)
      ) {
        return {
          allow: false,
          reason: 'bridge-busy',
          protocol: confirmation.protocol,
          ...(confirmation.drainReserved ? { drainReserved: true } : {}),
          detail: `${first.protocol} idle boundary did not remain quiet across confirmation`,
        };
      }
    }
    return { allow: true, reason: 'bridge-idle', protocol: first.protocol };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.startsWith('harness_roll_bridge_absent:')) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, legacyConfirmationDelayMs)));
      try {
        // If the supervisor brought the bridge back between observations, do
        // not race its newly admitted turn. Defer and let the next tick apply
        // the normal drain-v1 or double-observed legacy idle protocol.
        await prepare();
        return {
          allow: false,
          reason: 'bridge-busy',
          detail: 'bridge recovered while confirming local absence',
        };
      } catch (confirmationError) {
        const confirmationDetail = confirmationError instanceof Error
          ? confirmationError.message
          : String(confirmationError);
        if (confirmationDetail.startsWith('harness_roll_bridge_absent:')) {
          return { allow: true, reason: 'bridge-absent-repair' };
        }
        return {
          allow: false,
          reason: 'probe-failed',
          detail: confirmationDetail,
        };
      }
    }
    return {
      allow: false,
      reason: 'probe-failed',
      detail,
    };
  }
}

/** Classify a drifted Deployment without weakening the operator kill-switch.
 * A stopped template may be updated in place, but only an enabled running
 * agent may enter the restart path. */
export function runtimeRollActionForDeployment(
  deployment: K8sDeploymentState,
  enabledSet: Set<string>,
  disabledSet: Set<string>,
): RuntimeRollAction | undefined {
  if (deployment.replicas === 0) return 'stage-stopped';
  if (disabledSet.has(deployment.agentId)) return undefined;
  const unavailable = deployment.readyReplicas === 0;
  if (!unavailable && !enabledSet.has(deployment.agentId)) return undefined;
  return 'restart-running';
}

export function selectActionableRuntimeRollDrift(
  drift: K8sDeploymentState[],
  enabledSet: Set<string>,
  disabledSet: Set<string>,
): K8sDeploymentState[] {
  return drift.filter((deployment) => (
    runtimeRollActionForDeployment(deployment, enabledSet, disabledSet) !== undefined
  ));
}

/** Start at most one drifted running agent per tick, bounded by both the
 * wall-clock re-auth rate and a small readiness window. Stopped agents re-image
 * first with zero disruption; busy agents are left until quiet or stale. */
async function reconcileHarnessImageRoll(
  desiredAgents: AgentInfo[],
  deploymentStates: K8sDeploymentState[],
  enabledSet: Set<string>,
): Promise<void> {
  if (!HARNESS_ROLL_ENABLED || !daemonConfig) return;

  // Runtime-image intent is the reviewed DesiredRuntimeRelease document. Hive
  // and the daemon Deployment are projections only; disagreement fails closed.
  const validated = await readValidatedRuntimeRelease();
  if (!validated.release || !validated.documentFingerprint) {
    lastValidatedRuntimeImage = undefined;
    const now = Date.now();
    if (now - lastRuntimeReleaseIssueLogAt >= 60_000) {
      lastRuntimeReleaseIssueLogAt = now;
      console.warn(`[daemon][harness-roll] release preflight failed closed: ${validated.issues.join('; ')}`);
    }
    return;
  }
  const release = validated.release;
  const documentFingerprint = validated.documentFingerprint;
  const desired = canonicalRuntimeImage(release);
  lastValidatedRuntimeImage = desired;

  // Broker rollout remains independently projected by Hive. Refreshing it does
  // not cache or authorize a runtime image.
  await refreshHiveDesiredImage();
  const desiredBroker = desiredBrokerImage();

  const plans = new Map<string, ReturnType<typeof planRuntimeRelease>>();
  const imageDigestCache = new Map<string, Promise<string | undefined>>();
  const resolveAppliedDigest = async (deployment: K8sDeploymentState): Promise<string | undefined> => {
    if (deployment.runtimeReleaseGeneration != null || deployment.runtimeReleaseDigest) return undefined;
    const image = deployment.currentImage;
    if (!image) return undefined;
    let pending = imageDigestCache.get(image);
    if (!pending) {
      pending = resolveRuntimeImageDigest(image).catch((err) => {
        console.warn(
          `[daemon][harness-roll] cannot resolve immutable digest for unannotated ${deployment.username} ` +
          `image ${image}: ${(err as Error).message}`,
        );
        return undefined;
      });
      imageDigestCache.set(image, pending);
    }
    return pending;
  };

  // Fleet-wide preflight precedes every mutation. Unknown legacy images are
  // quarantined locally; a newer/conflicting applied generation aborts all.
  for (const deployment of deploymentStates) {
    const currentImageDigest = await resolveAppliedDigest(deployment);
    const plan = planRuntimeRelease(release, {
      generation: deployment.runtimeReleaseGeneration,
      imageDigest: deployment.runtimeReleaseDigest,
      currentImage: deployment.currentImage,
      ...(currentImageDigest ? { currentImageDigest } : {}),
    });
    if (plan.action === 'abort') {
      console.warn(
        `[daemon][harness-roll] release ${release.generation} aborted before mutation: ` +
        `${deployment.username}: ${plan.reason}`,
      );
      return;
    }
    if (plan.action === 'quarantined') {
      console.warn(
        `[daemon][harness-roll] release ${release.generation} leaves ${deployment.username} fail-closed: ${plan.reason}`,
      );
    }
    plans.set(deployment.agentId, plan);
  }

  // PLAT-5589: quarantined seats are excluded from `allDrift` below, so they
  // never produce a deferral key and "all deferral series clear" is satisfied
  // BY the failure — a fully quarantined fleet is indistinguishable from a
  // converged one in that signal alone. Emit the census so convergence can be
  // read as (deferrals clear AND quarantined == 0).
  const quarantinedAgentIds = [...plans.entries()]
    .filter(([, plan]) => plan.action === 'quarantined')
    .map(([agentId]) => agentId);
  if (quarantinedAgentIds.length > 0) {
    console.warn(
      `[daemon][harness-roll] release ${release.generation} quarantine census: ` +
      `${quarantinedAgentIds.length}/${deploymentStates.length} deployments fail-closed`,
    );
  }

  restoreHarnessRollProgress(desired);
  const desiredAgentIds = new Set(desiredAgents.map((agent) => agent.id));
  const pendingInFlight = pendingHarnessRollAgentIds(
    harnessRollInFlightAgentIds,
    desiredAgentIds,
    deploymentStates,
  );
  if (
    pendingInFlight.length !== harnessRollInFlightAgentIds.size
    || pendingInFlight.some((agentId) => !harnessRollInFlightAgentIds.has(agentId))
  ) {
    harnessRollInFlightAgentIds.clear();
    for (const agentId of pendingInFlight) harnessRollInFlightAgentIds.add(agentId);
    persistHarnessRollProgress(desired);
  }

  if (
    [...plans.values()].every((plan) => plan.action === 'converged')
    && fleetConvergedToImage(deploymentStates, desired)
  ) {
    noteConvergedAgentRuntimeImage(desired);
  } else {
    // Not fully converged, but the reported baseline must still track what the
    // fleet predominantly runs — otherwise the harness UI shows "rolling"
    // forever between the many-builds-a-day and the paced roller (operator
    // 2026-08-06). The per-agent progress bar carries the remaining tail.
    noteDominantAgentRuntimeImage(deploymentStates);
  }
  const secondaryDriftIds = new Set(
    selectRuntimeRollDrift(deploymentStates, desired, desiredBroker)
      .map((deployment) => deployment.agentId),
  );
  const allDrift = deploymentStates.filter((deployment) => {
    const plan = plans.get(deployment.agentId);
    if (!plan || plan.action === 'quarantined' || plan.action === 'abort') return false;
    return plan.action === 'roll' || secondaryDriftIds.has(deployment.agentId);
  });
  const activeDeferralKeys = new Set(
    allDrift.map((deployment) => harnessDriftKey(deployment.agentId, desired)),
  );
  if (runtimeRollDeferrals.prune(activeDeferralKeys)) persistHarnessRollProgress(desired);
  let drift = allDrift
    .filter((deployment) => !harnessRollInFlightAgentIds.has(deployment.agentId));
  // Image-only convergence is enough to advance the harness report even when
  // broker/spec drift still needs paced rolls — report completion of the image
  // target separately so the UI is not stuck on "rolling" for sidecar churn.
  if (drift.length === 0) return;
  const disabledSet = readDisabledAgents();
  // A disabled replicas>0 Deployment is lifecycle drift, not a harness roll
  // candidate.  Exclude it before the convergence fence: otherwise one stale,
  // unavailable disabled workload is mistaken for a roll in flight and hides
  // every safe replicas=0 template update behind it forever.  The lifecycle
  // reconciler owns scaling that workload down; the harness lane must neither
  // restart it nor let it deadlock independently actionable convergence.
  drift = selectActionableRuntimeRollDrift(drift, enabledSet, disabledSet);
  if (drift.length === 0) return;
  // One-at-a-time: never begin a roll while ANY agent pod is still converging
  // (a fresh actionable roll in flight, or an actionable crashloop). If the
  // converging Deployment is itself fully unavailable AND image-drifted, it is
  // the only legal repair target; otherwise a rejected canary image deadlocks
  // its own recovery. Ineligible disabled workloads were removed above.
  drift = restrictRuntimeRollDriftForConvergence(drift, deploymentStates);
  if (drift.length === 0) return;
  const now = Date.now();
  pruneHarnessDriftClock(desired);
  const driftAge = new Map(drift.map((d) => [d.agentId, harnessDriftAgeMs(d.agentId, desired, now)]));
  persistHarnessRollProgress(desired);
  const agentById = new Map(desiredAgents.map((a) => [a.id, a]));
  // Stopped agents first (replicas 0 — re-image with no running turn to disturb),
  // then the STALEST drifted agents (so a ready update always finishes: the
  // longer a busy straggler waits, the higher its priority once force-eligible),
  // then idle enabled agents.
  const ordered = orderRuntimeRollDrift(drift, desired, driftAge);
  let drainReserved = false;
  for (const d of ordered) {
    const agent = agentById.get(d.agentId) ?? desiredAgents.find((a) => a.username === d.username);
    if (!agent) {
      const cleared = runtimeRollDeferrals.reconcilePass({
        kind: 'ineligible',
        key: harnessDriftKey(d.agentId, desired),
        agent: d.username,
      });
      if (cleared.changed) persistHarnessRollProgress(desired);
      continue;
    }
    const action = runtimeRollActionForDeployment(d, enabledSet, disabledSet);
    if (!action) {
      const cleared = runtimeRollDeferrals.reconcilePass({
        kind: 'ineligible',
        key: harnessDriftKey(d.agentId, desired),
        agent: d.username,
      });
      if (cleared.changed) persistHarnessRollProgress(desired);
      continue;
    }
    const stopped = action === 'stage-stopped';
    const unavailable = d.replicas > 0 && d.readyReplicas === 0;
    const runtimePlan = plans.get(d.agentId);
    if (!runtimePlan || runtimePlan.action === 'quarantined' || runtimePlan.action === 'abort') continue;
    const runtimeMutationRequired = runtimePlan.action === 'roll';
    const nextAgentImage = runtimeMutationRequired ? desired : (d.currentImage ?? desired);
    const nextBrokerImage = desiredBroker || d.currentBrokerImage;

    let rollReason = 'stopped';
    if (!stopped) {
      // PLAT-4211: only running-agent rolls need a wall-clock floor; they restart
      // a pod and re-auth. This backstops the anyConverging gate without slowing
      // harmless replicas=0 template updates.
      if (now - lastHarnessRollAt < HARNESS_ROLL_MIN_INTERVAL_MS) {
        scheduleHarnessRollWake(harnessRollWakeDelayMs(
          now,
          lastHarnessRollAt,
          HARNESS_ROLL_MIN_INTERVAL_MS,
        ));
        return;
      }
      if (!harnessRollHasCapacity(harnessRollInFlightAgentIds.size, HARNESS_ROLL_MAX_IN_FLIGHT)) {
        scheduleHarnessRollWake(5_000);
        return;
      }
      // SCLI-331 tail-completion: a stale straggler is probed even without the
      // coarse activity-idle hint, but the live bridge fence remains authoritative.
      const stale = HARNESS_ROLL_MAX_STALE_MS > 0
        && (driftAge.get(d.agentId) ?? 0) >= HARNESS_ROLL_MAX_STALE_MS;
      // Probe exactly one non-idle drifted bridge per pass even before the stale
      // deadline. Drain-v1 then reserves its next persisted model/tool boundary;
      // legacy-health gets bounded rechecks that can catch the gap between two
      // continuously queued executions. The old activity-only gate could never
      // converge Nagi because productive work kept refreshing activity forever.
      const coarseIdle = agentIsIdleForRoll(agent.id, now);
      // A STALE straggler is exempt from the one-non-idle-probe-per-pass bound.
      // The bound exists so one backlog-heavy bridge cannot eat the probe slot
      // every pass — but applying it to stale agents recreated the same
      // starvation positionally: Kai (continuously busy, first in iteration)
      // consumed the slot for days while Nagi sat 41h past the stale fence,
      // never probed, never rolled. The fence is the convergence guarantee;
      // stale agents are always probed (the busy gate stays authoritative).
      if (!unavailable && !coarseIdle && !stale && drainReserved) continue;
      // Capacity-limited bridges (PLAT-879) often leave Connect `busy=true` while
      // only sleeping on the token pool. The live busy latch would forever defer
      // the roll; skip the probe and treat them as idle for harness convergence.
      const capacityLimited = tokenPoolBackoffSet.has(agent.id);
      const busyGate: RuntimeRollBusyGateResult = capacityLimited
        ? { allow: true, reason: 'bridge-idle', protocol: 'legacy-health' }
        : await runtimeRollBusyGate(
          unavailable,
          () => prepareAgentK8sBridgeForRuntimeRoll(agent, nextAgentImage),
        );
      if (capacityLimited) {
        console.log(
          `[daemon][runtime-roll] ${agent.name}: PLAT-879 capacity-limited — ` +
          `skipping busy probe and rolling (not an active model turn)`,
        );
      }
      let heartbeatDeadlockRecovery = false;
      let legacyCheckpointRecovery = false;
      if (!busyGate.allow) {
        const deferral = runtimeRollDeferrals.reconcilePass({
          kind: 'deferred',
          key: harnessDriftKey(agent.id, desired),
          agent: agent.username,
          now,
          reason: busyGate.reason,
          protocol: busyGate.protocol,
        });
        // Log the state transition once; the persisted deferral metric and
        // one-shot alert carry ongoing observability. Emitting this every probe
        // flooded runtime-fleet logs every ~3s per busy agent without adding
        // information or advancing the rollout.
        if (deferral.changed) {
          console.warn(
            `[daemon][runtime-roll] deferring ${agent.name}: ` +
            (busyGate.reason === 'bridge-busy'
              ? 'bridge reports an active turn'
              : `live busy probe failed closed (${busyGate.detail ?? 'unknown error'})`),
          );
        }
        if (deferral.changed) persistHarnessRollProgress(desired);
        let heartbeatOutcome = getHeartbeatQueueDrainOutcome(agent.id);
        if (busyGate.protocol === 'legacy-health' && busyGate.reason === 'bridge-busy') {
          const checkpoint = await readLatestAgentK8sLegacyGatewayCheckpoint(agent);
          legacyCheckpointRecovery = legacyGatewayCheckpointRecoveryAllowed({
            desiredImage: desired,
            deferralElapsedMs: deferral.elapsedMs,
            checkpoint,
            now,
          });
          if (legacyCheckpointRecovery) {
            console.error(
              `[daemon][runtime-roll][RECOVERY] ${agent.name}: replacing legacy gateway at ` +
              `fresh persisted tool checkpoint after ${Math.round(deferral.elapsedMs / 60000)}m deferred; ` +
              `session=${checkpoint!.sessionId} checkpoint_at=${new Date(checkpoint!.toolResultAt).toISOString()}`,
            );
          }
        }
        if (!heartbeatOutcome
          && stale
          && busyGate.protocol === 'legacy-health'
          && busyGate.reason === 'bridge-busy') {
          const logLine = await readLatestAgentK8sHeartbeatOutcomeLogLine(agent);
          if (logLine) {
            heartbeatOutcome = ingestHeartbeatQueueDrainOutcomeLogLine(logLine, agent.id);
            if (heartbeatOutcome) daemonLinkClient?.sendAgentDelta(agent.id, 'heartbeat_outcome');
          }
        }
        heartbeatDeadlockRecovery = legacyHeartbeatRollRecoveryAllowed({
          stale,
          protocol: busyGate.protocol,
          reason: busyGate.reason,
          deferralElapsedMs: deferral.elapsedMs,
          outcome: heartbeatOutcome,
          now,
        });
        if (heartbeatDeadlockRecovery) {
          const outcome = heartbeatOutcome!;
          console.error(
            `[daemon][runtime-roll][RECOVERY] ${agent.name}: replacing stale legacy gateway after ` +
            `${Math.round(deferral.elapsedMs / 60000)}m deferred and ` +
            `${outcome.consecutiveReadyNoProgressHeartbeats} consecutive no-progress heartbeat(s); ` +
            `ready=${outcome.readyTaskCount} progress=${outcome.progressEventCount} ` +
            `forwarded=${outcome.forwardedEventCount} observed_at=${outcome.observedAt}`,
          );
        }
        if (deferral.shouldLogAlert && !heartbeatDeadlockRecovery && !legacyCheckpointRecovery) {
          console.error(
            `[daemon][runtime-roll][ALERT] ${agent.name} has been deferred for ` +
            `${Math.round(deferral.elapsedMs / 60000)}m against ${desired} ` +
            `(reason=${busyGate.reason}, protocol=${busyGate.protocol ?? 'unknown'}). ` +
            'NOT forcing a roll -- the live bridge fence remains authoritative. ' +
            'The agent is running stale code until it reaches an idle instant.',
          );
        }
        // Deliberately avoid the minute-aligned reconcile cadence that repeatedly
        // sampled old bridges inside their active heartbeat turn. Drain-v1 has
        // already reserved this bridge's next boundary; keep that reservation
        // armed while scanning other independently proven-idle bridges. Legacy
        // protocol cannot reserve a boundary, so it also yields. The actuator
        // still returns after one allowed roll.
        // Drain-v1 keeps the next safe boundary reserved. A bounded, non-minute-
        // aligned recheck avoids the previous hot poll while still converging
        // promptly after the active turn releases its fence.
        scheduleHarnessRollWake(HARNESS_ROLL_BUSY_RECHECK_MS + 379);
        if (!heartbeatDeadlockRecovery && !legacyCheckpointRecovery
          && consumesRuntimeRollNonIdleProbe(busyGate)) {
          drainReserved = true;
        }
        if (!heartbeatDeadlockRecovery && !legacyCheckpointRecovery) {
          if (!shouldFocusRuntimeRollDrain(busyGate.protocol, stale)) continue;
          return;
        }
      }
      const admitted = runtimeRollDeferrals.reconcilePass({
        kind: 'admitted',
        key: harnessDriftKey(agent.id, desired),
        agent: agent.username,
      });
      if (admitted.changed) persistHarnessRollProgress(desired);
      rollReason = legacyCheckpointRecovery
        ? 'legacy-persisted-tool-checkpoint-recovery'
        : heartbeatDeadlockRecovery
        ? 'legacy-heartbeat-deadlock-recovery'
        : busyGate.reason === 'bridge-absent-repair'
        ? 'bridge-absent-repair'
        : unavailable ? 'unavailable-repair'
          : stale ? `stale-live-fence ${Math.round((driftAge.get(d.agentId) ?? 0) / 1000)}s` : 'idle';
    }

    if (runtimeMutationRequired) {
      console.log(
        `[daemon][harness-roll] SCLI-331: candidate ${agent.name} ${d.currentImage} -> ${desired} ` +
        `(generation=${release.generation}, intent=${release.intent}, ${stopped ? 'stopped' : 'idle'})`,
      );
      const boundary = await executeRuntimeReleaseMutationBoundary(release, documentFingerprint, {
        readApplied: async () => {
          const fresh = await getAgentK8sDeploymentStateAsync(agent);
          return fresh ? {
            ...fresh,
            generation: fresh.runtimeReleaseGeneration,
            imageDigest: fresh.runtimeReleaseDigest,
          } : null;
        },
        resolveUnannotatedDigest: async (fresh) => {
          if (!fresh.currentImage) return undefined;
          return resolveRuntimeImageDigest(fresh.currentImage);
        },
        readAuthority: readValidatedRuntimeRelease,
        mutate: (fresh) => rollAgentK8sRuntimeRelease(agent, fresh, release),
      });
      if (boundary.action === 'mutated') {
        if (!stopped) {
          lastHarnessRollAt = now;
          harnessRollInFlightAgentIds.add(agent.id);
        }
        noteK8sDaemonApply(agent.id);
        harnessDriftSince.delete(harnessDriftKey(agent.id, desired));
        persistHarnessRollProgress(desired);
        scheduleHarnessRollWake();
      } else if (boundary.action !== 'converged') {
        console.warn(
          `[daemon][harness-roll] release ${release.generation} ${boundary.action} for ${agent.name}: ${boundary.reason}`,
        );
      }
      return; // exactly one reviewed runtime mutation per reconcile
    }

    // Broker/spec-only convergence must preserve the already-reviewed runtime
    // image. Re-read authority and the target after the busy gate so this path
    // cannot smuggle an outdated image during a concurrent promotion.
    const freshValidated = await readValidatedRuntimeRelease();
    if (
      !freshValidated.release
      || !sameRuntimeRelease(release, freshValidated.release)
      || freshValidated.documentFingerprint !== documentFingerprint
    ) {
      console.warn(`[daemon][harness-roll] release ${release.generation} invalidated before ${agent.name}; no mutation`);
      return;
    }
    const freshDeployment = await getAgentK8sDeploymentStateAsync(agent);
    if (!freshDeployment?.currentImage) return;
    const freshPlan = planRuntimeRelease(release, {
      generation: freshDeployment.runtimeReleaseGeneration,
      imageDigest: freshDeployment.runtimeReleaseDigest,
      currentImage: freshDeployment.currentImage,
    });
    if (freshPlan.action !== 'converged') {
      console.warn(
        `[daemon][harness-roll] release ${release.generation} no longer converged for ${agent.name}; deferring secondary drift`,
      );
      return;
    }

    if (stopped) {
      console.log(
        `[daemon][runtime-roll] staging stopped ${agent.name} with reviewed runtime ${freshDeployment.currentImage} ` +
        `and broker=${nextBrokerImage ?? 'unknown'}`,
      );
      stageStoppedAgentK8sRuntime(agent, freshDeployment.currentImage, nextBrokerImage);
      harnessDriftSince.delete(harnessDriftKey(agent.id, desired));
      continue;
    }

    console.log(
      `[daemon][runtime-roll] rolling ${agent.name} with reviewed runtime ${freshDeployment.currentImage} ` +
      `broker=${freshDeployment.currentBrokerImage ?? 'unknown'} -> ${nextBrokerImage ?? 'unknown'} (${rollReason})`,
    );
    lastHarnessRollAt = now;
    harnessRollInFlightAgentIds.add(agent.id);
    persistHarnessRollProgress(desired);
    try {
      rollRunningAgentK8sRuntime(agent, freshDeployment.currentImage, nextBrokerImage);
      noteK8sDaemonApply(agent.id);
      harnessDriftSince.delete(harnessDriftKey(agent.id, desired));
      persistHarnessRollProgress(desired);
    } catch (err) {
      harnessRollInFlightAgentIds.delete(agent.id);
      persistHarnessRollProgress(desired);
      console.warn(`[daemon][harness-roll] secondary roll threw for ${agent.name}: ${(err as Error).message}`);
    } finally {
      scheduleHarnessRollWake();
    }
    return;
  }
}


const scheduleRuntimeLifecycleReconcile = createSingleFlight(
  reconcileRuntimeLifecycle,
  () => {
    console.warn('[daemon] runtime lifecycle reconcile still in flight; queueing one trailing tick');
  },
);

const RUNTIME_SSOT_BACKSTOP_INTERVAL_MS = 60_000;
let lastRuntimeSsotRefreshAttemptAt = 0;

async function reconcileRuntimeLifecycle(): Promise<void> {
  const localActual = Array.from(childProcesses.keys()).map((agentId) => ({
    agentId,
    backend: 'local' as const,
    replicas: 1,
    readyReplicas: 1,
  }));
  // SCLI-235: agent-state.db is desired-state for runtime placement. Re-read it
  // on every reconcile tick so container↔k8s flips converge without a daemon restart.
  const desiredAgents = readAgents();
  // Hive runtime configuration and effective capabilities are runtime overlays,
  // not a second local-store authority. Preserve the latest in-memory overlay
  // when computing k8s drift; otherwise every reconcile compares Hive with the
  // same stale persisted row and alternates pod templates indefinitely.
  const runtimeAgentById = new Map(discoveredAgents.map((a) => [a.id, a]));
  for (const desired of desiredAgents) {
    const runtime = runtimeAgentById.get(desired.id);
    if (runtime) applyRuntimeAuthorityOverlay(desired, runtime);
  }
  // PLAT-4112 Guard 2: periodically re-read Hive FleetAgent SSOT.
  // Daemon-link config frames are the primary path for SSOT updates, but a
  // disconnected daemon-link or a missed frame leaves the in-memory agent
  // stale. This backstop queries Hive directly for model/method/fallbacks and
  // overlays any drift onto the in-memory agent. Lifecycle/image events can
  // arrive in bursts, so cadence-gate the 42-agent sweep independently of the
  // event-driven reconcile and share the reconcile single-flight above.
  const ssotRefreshNow = Date.now();
  if (
    platformClient
    && runtimeSsotBackstopDue(
      lastRuntimeSsotRefreshAttemptAt,
      ssotRefreshNow,
      RUNTIME_SSOT_BACKSTOP_INTERVAL_MS,
    )
  ) {
    lastRuntimeSsotRefreshAttemptAt = ssotRefreshNow;
    const ssotResult = await refreshRuntimeSsot(
      desiredAgents,
      runtimeAgentById,
      (agentId, signal) => platformClient!.getFleetAgent(agentId, signal),
      { concurrency: 4, timeoutMs: 10_000 },
    );
    const ssotTotalFailure = desiredAgents.length > 0
      && ssotResult.refreshed === 0
      && ssotResult.failedAgentIds.length === desiredAgents.length;
    recordRuntimeSsotRefresh(ssotTotalFailure, ssotResult.failedAgentIds.length);
    if (ssotTotalFailure) {
      console.error(
        `[daemon] SSOT refresh failed for all ${desiredAgents.length} agents; ` +
        'runtime graph may be stale and shizuha_reconcile_runtime_ssot_refresh_ok=0',
      );
    }
    for (const agentId of ssotResult.driftedAgentIds) {
      const desired = desiredAgents.find((agent) => agent.id === agentId);
      console.log(`[daemon] ${desired?.name ?? agentId}: SSOT drift detected and repaired (model/method/fallbacks) via reconcile backstop`);
    }
    if (ssotResult.timedOut) {
      console.warn('[daemon] SSOT aggregate timeout — all workers cancelled and settled; continuing with bounded partial data');
    }
  }
  const desiredAgentById = new Map(desiredAgents.map((a) => [a.id, a]));
  // Observe every known k8s Deployment, including stale workloads whose
  // desired placement has already moved back to container. Keep the existing
  // desired-k8s-only view for harness/image/credential consumers so an orphaned
  // old backend cannot block fleet image convergence.
  let observedK8sDeploymentStates: ReturnType<typeof listK8sAgentDeployments>;
  try {
    observedK8sDeploymentStates = listK8sAgentDeployments(
      desiredAgents,
      { includeNonK8sDesired: true },
    );
  } catch (err) {
    // PLAT-5276 / 2026-08-14 devops cards: a host kube-auth blip made
    // listK8sAgentDeployments return [] (or now throw), so every enabled
    // agent looked missing, spawn printed the raw kubectl dump onto Hive
    // as Failed / Needs help. Do not mutate or paint agents when observe fails.
    const facing = operatorFacingK8sError(err);
    console.error(
      `[daemon] runtime-reconcile: k8s observe failed — ${facing}; ` +
      'skipping start/stop/refresh (control-plane unreadability is not missing Deployments).',
    );
    recordReconcileCycle({
      driftCount: 0,
      repairsStop: 0,
      repairsStartK8s: 0,
      skipped: 'k8s-observe-unreadable',
    });
    return;
  }
  const desiredK8sAgentIds = new Set(
    desiredAgents.filter((a) => shouldSpawnK8sAgent(a)).map((a) => a.id),
  );
  const k8sDeploymentStates = observedK8sDeploymentStates.filter(
    (deployment) => desiredK8sAgentIds.has(deployment.agentId),
  );
  // An older renderer could write duplicate env names into either the live pod
  // template or kubectl's last-applied baseline. Strategic merge cannot repair
  // that shape because `$setElementOrder` itself becomes invalid. Sweep both
  // running and stopped Deployments through the JSON-Patch repair lane before
  // any healthy/config-hash fast path can hide the poison indefinitely.
  for (const deployment of k8sDeploymentStates) {
    if (!deployment.duplicateEnvMetadata) continue;
    const agent = desiredAgentById.get(deployment.agentId)
      ?? desiredAgents.find((candidate) => candidate.username === deployment.username);
    if (!agent) continue;
    try {
      repairAgentK8sDuplicateEnvMetadata(agent);
      noteK8sDaemonApply(agent.id);
      deployment.duplicateEnvMetadata = false;
    } catch (err) {
      console.warn(
        `[daemon] ${agent.name}: duplicate k8s env metadata repair deferred: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // PLAT-4027: read the enabled-set before the gh-auth probe so it can scope to
  // agents the reconcile actually keeps a Deployment running for (enabled +
  // status==='active'), instead of paging deployment_unready for
  // eligible-but-disabled/paused agents that legitimately have no Deployment.
  const enabledSet = readEnabledAgents();
  // SCLI-110 kill-switch, k8s plane (2026-07-11): the disabled set is
  // AUTHORITATIVE here too. The local-process path already refuses to start a
  // disabled agent (startAgentProcess guard), but this reconcile's toStartK8s
  // only consulted enabled-agents.json — an id present in BOTH files (e.g. a
  // hand-edited kill-switch, or a Hive sync/credential-migration flipping
  // status back to 'active') re-spawned explicitly-stopped agents' Deployments
  // on daemon boot. That silently revived the whole disabled claude cohort on
  // 2026-07-10 after a daemon restart, burning paused-account quota.
  for (const disabledId of readDisabledAgents()) enabledSet.delete(disabledId);
  // Credential/image recovery is an ENFORCE action and must run before the
  // diagnostic GitHub probe below. That probe shells into multiple agents and
  // can spend minutes in external TLS timeouts; putting it first starved broker
  // rotation even though the roll itself depends only on Kubernetes + Hive.
  // The release reconcile must finish its authority/projection read before we
  // decide whether the synchronous GitHub diagnostic may run.  Starting both
  // lanes concurrently leaves lastValidatedRuntimeImage undefined on a cold
  // daemon boot, so the diagnostic is incorrectly admitted while release
  // drift exists.  Its sequential kubectl exec/TLS probes then block Node's
  // event loop long enough for /health to miss three liveness probes and put
  // rt-fleet into CrashLoopBackOff.  Awaiting here does not block /health: the
  // release reads are async, and the outer lifecycle reconcile is already
  // single-flight.  It also prevents overlapping release operators.
  await reconcileHarnessImageRoll(desiredAgents, k8sDeploymentStates, enabledSet);
  const cachedRollImage = lastValidatedRuntimeImage;
  const deferGithubProbe = shouldDeferK8sGithubProbeForHarnessRoll(
    k8sDeploymentStates,
    cachedRollImage,
    desiredBrokerImage(),
    harnessRollInFlightAgentIds.size > 0,
  );
  // The probe shells into many pods synchronously and may spend minutes in
  // external TLS timeouts. Running it during an image roll starves the 5/15s
  // event timers and lets source promotions outrun convergence. Diagnostics
  // resume automatically on the first drift-free lifecycle tick.
  if (!deferGithubProbe) {
    maybeProbeK8sGithubAuth(desiredAgents, k8sDeploymentStates, enabledSet);
  }
  // PLAT-4490: keep the daemon→Hive activity clock live even when no operator
  // has the dashboard open. The probe is internally rate-limited and emits a
  // bounded activity delta through noteAgentActivity when the session mtime
  // advances.
  for (const agent of desiredAgents) {
    scheduleK8sLastActivityProbe(agent, noteAgentActivity);
  }
  const k8sActual = observedK8sDeploymentStates.map((d) => ({
    agentId: d.agentId,
    backend: 'k8s' as const,
    replicas: d.replicas,
    readyReplicas: d.readyReplicas,
    credentialDrift: d.githubCredentialDrift,
    ...(d.configHash ? { configHash: d.configHash } : {}),
  }));
  for (const deployment of k8sDeploymentStates) {
    if (deployment.replicas > 0 && deployment.readyReplicas > 0 && deployment.availableReplicas > 0) {
      const current = inMemoryState?.agents.find((a) => a.agentId === deployment.agentId);
      if (!current || (current.enabled && current.status === 'running')) continue;
      if (current.enabled) {
        updateAgentInMemory(deployment.agentId, {
          status: 'running',
          enabled: true,
          error: undefined,
        });
        continue;
      }
      // Deployment desired-state is the enablement authority for k8s-native
      // agents (availability truth chain). Hive can scale a Deployment up
      // directly (FleetAgentEnableView -> provisioner.start_agent) without
      // toggling this daemon, leaving the enabled-set stale; the ready pod
      // then serves while every daemon frame reports 'stopped', and Hive's
      // status mirror clobbers its own RUNNING row on the next snapshot
      // (agent-goro ran 2 days as an invisible zombie, 2026-08-08). Adopt the
      // observed Deployment for config-active agents instead of out-voting it.
      const agent = desiredAgentById.get(deployment.agentId);
      if (agent?.status !== 'active') continue;
      console.warn(
        `[daemon] runtime-reconcile: ${agent.name} has a ready k8s Deployment but the daemon ` +
        'enabled-set says disabled — adopting Deployment desired-state as enablement authority ' +
        '(Hive-direct start).',
      );
      const enabledNow = readEnabledAgents();
      enabledNow.add(deployment.agentId);
      writeEnabledAgents(enabledNow);
      const disabledNow = readDisabledAgents();
      if (disabledNow.delete(deployment.agentId)) writeDisabledAgents(disabledNow);
      enabledSet.add(deployment.agentId);
      updateAgentInMemory(deployment.agentId, {
        status: 'running',
        enabled: true,
        error: undefined,
      });
    }
  }
  const actual = [...localActual, ...k8sActual];

  const statusById = new Map(desiredAgents.map((a) => [a.id, a.status]));
  const k8sAgentIds = desiredK8sAgentIds;
  // PLAT-3625: desired MCP/capability hash per k8s agent — drift vs the live
  // Deployment annotation triggers a re-apply so grants reach the pod.
  const desiredConfigHashById = new Map(
    desiredAgents.filter((a) => k8sAgentIds.has(a.id)).map((a) => [a.id, computeAgentMcpConfigHash(a)]),
  );
  const { toStop, toStopLocal, toStopK8s, unsupportedRollback, toRestoreK8s, toStartK8s, toRefreshK8s, skipReason } = computeRuntimeReconcilePlan(actual, enabledSet, statusById, k8sAgentIds, desiredConfigHashById);

  if (skipReason) {
    console.warn(
      `[daemon] runtime-reconcile: skipped (${skipReason}) — ${actual.length} runtime(s) observed; no runtimes stopped/started (SCLI-149 safety guard).`,
    );
    // PLAT-1309: a safety-guard skip left any drift UNREPAIRED — record it so
    // persistent skips (a stuck circuit breaker) surface, not silently swallow.
    recordReconcileCycle({ driftCount: 0, repairsStop: 0, repairsStartK8s: 0, skipped: skipReason });
    return;
  }

  // PLAT-1309/INV-6: observe drift (agents needing repair) each non-skipped cycle;
  // it should fall back to 0 the next cycle once these repairs land.
  recordReconcileCycle({
    driftCount: toStop.length + toStopLocal.length + toStopK8s.length
      + unsupportedRollback.length + toRestoreK8s.length + toStartK8s.length + toRefreshK8s.length,
    repairsStop: toStop.length + toStopLocal.length + toStopK8s.length,
    repairsStartK8s: toRestoreK8s.length + toStartK8s.length,
    skipped: null,
  });

  for (const id of toStop) {
    const agent = desiredAgentById.get(id) ?? discoveredAgents.find((a) => a.id === id);
    console.warn(
      `[daemon] runtime-reconcile: ${agent?.name ?? id} is disabled (absent from enabled-agents.json + agents.json status=disabled) but its runtime is running — stopping the zombie (SCLI-149).`,
    );
    disableAndStopAgent(id);
  }

  for (const id of toStopLocal) {
    const agent = desiredAgentById.get(id) ?? discoveredAgents.find((a) => a.id === id);
    const child = childProcesses.get(id);
    console.warn(
      `[daemon] runtime-reconcile: ${agent?.name ?? id} desired runtime is k8s but daemon-local runtime is still running — stopping stale local runtime before k8s converge (SCLI-235).`,
    );
    if (child) {
      child.kill('SIGTERM');
      // Do NOT delete childProcesses here. The map is the daemon's observed
      // local-runtime state; keeping the child until its exit event prevents
      // the next reconcile tick from starting k8s while the local process is
      // still shutting down or wedged. The normal exit handler removes it.
      setTimeout(() => {
        if (childProcesses.get(id) === child && child.exitCode === null) child.kill('SIGKILL');
      }, 5000);
    }
  }

  for (const id of toStopK8s) {
    const agent = desiredAgentById.get(id) ?? discoveredAgents.find((a) => a.id === id);
    if (!agent) continue;
    console.warn(
      `[daemon] runtime-reconcile: ${agent.name} desired runtime is not k8s but a k8s Deployment is still running — scaling stale Deployment to 0 (SCLI-235).`,
    );
    try {
      stopAgentK8s({ ...agent, runtimeEnvironment: 'k8s' });
    } catch (err) {
      recordReconcileStartFailure();
      updateAgentInMemory(id, { status: 'error', error: `k8s stale-runtime stop failed: ${(err as Error).message}` });
    }
  }

  for (const id of unsupportedRollback) {
    const agent = desiredAgentById.get(id) ?? discoveredAgents.find((a) => a.id === id);
    const msg = "runtime reconcile deferred container rollback because the k8s Deployment is the agent's only live backend; automatic local start is not supported by the reconcile loop";
    console.error(`[daemon] runtime-reconcile: ${agent?.name ?? id}: ${msg} — preserving active work instead of creating downtime (SCLI-235 rollback guard).`);
    updateAgentInMemory(id, { status: 'error', error: msg });
  }

  for (const id of toRestoreK8s) {
    const agent = desiredAgentById.get(id) ?? discoveredAgents.find((a) => a.id === id);
    if (!agent) continue;
    console.warn(
      `[daemon] runtime-reconcile: ${agent.name} is active but its previous k8s backend was scaled to 0 before a local replacement existed — restoring the working backend (SCLI-235 rollback guard).`,
    );
    try {
      restoreAgentK8s({ ...agent, runtimeEnvironment: 'k8s' });
    } catch (err) {
      recordReconcileStartFailure();
      updateAgentInMemory(id, { status: 'error', error: `k8s rollback restore failed: ${(err as Error).message}` });
    }
  }

  const k8sDeploymentStateById = new Map(k8sDeploymentStates.map((state) => [state.agentId, state]));
  const activeK8sRepairIds = new Set([...toStartK8s, ...toRefreshK8s]);
  // If the Deployment converged through another event/controller, discard any
  // stale retry state now. Merely becoming temporarily unready is NOT
  // convergence: clearing the successful-apply settle latch on that edge made
  // the old Ready hash eligible for another apply as soon as the pod recovered.
  // Keep the latch until the observed hash is exact, or the agent is no longer
  // desired in this runtime lane.
  for (const agent of desiredAgents) {
    if (activeK8sRepairIds.has(agent.id)) continue;
    const stillDesiredK8s = k8sAgentIds.has(agent.id)
      && enabledSet.has(agent.id)
      && statusById.get(agent.id) === 'active';
    const live = k8sDeploymentStateById.get(agent.id);
    const desiredHash = desiredConfigHashById.get(agent.id);
    if (
      stillDesiredK8s
      && (!live || !desiredHash || live.configHash !== desiredHash)
    ) {
      continue;
    }
    const clearedAction = runtimeReconcileRepairBackoff.clear(agent.id);
    if (clearedAction) clearReconcileRepairBackoff(agent.username, clearedAction);
  }

  const attemptK8sRuntimeRepair = (
    agent: AgentInfo,
    action: RuntimeRepairAction,
    desiredRevision: string,
    attemptLog: string,
    errorPrefix: string,
  ): void => {
    if (!daemonConfig) return;
    const admission = runtimeReconcileRepairBackoff.tryBegin(agent.id, action, desiredRevision);
    if (admission.replacedAction) {
      clearReconcileRepairBackoff(agent.username, admission.replacedAction);
    }
    if (!admission.allowed) {
      recordReconcileRepairDeferral(action, admission.reason!);
      if (admission.shouldLog) {
        const detail = admission.reason === 'in_flight'
          ? 'an attempt is already in flight'
          : admission.reason === 'settling'
            ? `the successful apply is waiting up to ${Math.ceil(admission.retryAfterMs / 1000)}s for Deployment convergence`
            : `failure backoff has ${Math.ceil(admission.retryAfterMs / 1000)}s remaining (streak=${admission.failureCount})`;
        console.warn(`[daemon] runtime-reconcile: ${agent.name} ${action} deferred — ${detail}.`);
      }
      return;
    }
    if (admission.failureCount === 0) clearReconcileRepairBackoff(agent.username, action);

    console.warn(attemptLog);
    const failRepair = (message: string): void => {
      recordReconcileStartFailure();
      const scheduled = runtimeReconcileRepairBackoff.markFailed(agent.id, action, desiredRevision);
      if (!scheduled) {
        console.warn(`[daemon] runtime-reconcile: ignored stale ${action} failure for ${agent.name}; desired state changed while it was in flight.`);
        return;
      }
      recordReconcileRepairBackoff(agent.username, action, scheduled.failureCount, scheduled.nextRetryAt);
      const facing = operatorFacingK8sError(message);
      console.error(
        `[daemon] runtime-reconcile: ${agent.name} ${action} failed; retrying in ` +
        `${Math.ceil(scheduled.delayMs / 1000)}s (streak=${scheduled.failureCount}): ${facing}`,
      );
      // Host kube-auth / API discovery failures are not the agent's fault
      // and must never become Hive Failed + a raw kubectl dump.
      if (isK8sControlPlaneUnreadable(message)) {
        return;
      }
      updateAgentInMemory(agent.id, { status: 'error', error: `${errorPrefix}: ${facing}` });
    };

    void startAgentProcess(agent, tokenCache.get(agent.id) ?? '', daemonConfig).then((err) => {
      if (err) {
        failRepair(err);
        return;
      }
      if (runtimeReconcileRepairBackoff.markSucceeded(agent.id, action, desiredRevision)) {
        clearReconcileRepairBackoff(agent.username, action);
      }
    }).catch((err) => failRepair((err as Error).message));
  };

  for (const id of toStartK8s) {
    const agent = desiredAgentById.get(id) ?? discoveredAgents.find((a) => a.id === id);
    if (!agent || !daemonConfig) continue;
    const k8sState = k8sDeploymentStateById.get(id);
    const repairReason = k8sState?.githubCredentialDrift
      ? `has GitHub credential drift (envWired=${k8sState.githubTokenEnvWired}, secretPresent=${k8sState.githubTokenSecretPresent})`
      : 'has no healthy k8s Deployment';
    attemptK8sRuntimeRepair(
      agent,
      'start',
      `${desiredConfigHashById.get(id) ?? 'unhashed'}:${repairReason}`,
      `[daemon] runtime-reconcile: ${agent.name} is enabled but ${repairReason} — re-applying through daemon spawnAgentK8s path.`,
      'k8s reconcile start failed',
    );
  }

  // PLAT-3625: healthy Deployments whose MCP/capability config drifted from
  // desired — re-apply through the same spawn path. The manifest re-render
  // stamps the new hash + env; the pod-template annotation change rolls the
  // pod (Recreate), and the bridge recomposes .mcp.json from env at boot.
  for (const id of toRefreshK8s) {
    const agent = desiredAgentById.get(id) ?? discoveredAgents.find((a) => a.id === id);
    if (!agent || !daemonConfig) continue;
    const desiredRevision = desiredConfigHashById.get(id) ?? 'unhashed';
    attemptK8sRuntimeRepair(
      agent,
      'refresh',
      desiredRevision,
      `[daemon] runtime-reconcile: ${agent.name} MCP/capability config drifted from live Deployment ` +
      `(desired hash ${desiredRevision}) — re-applying so new grants reach the pod (PLAT-3625).`,
      'k8s config refresh failed',
    );
  }
}

/**
 * Enable and start a single agent's runtime.
 * Gets/creates runner token, starts gateway subprocess.
 * If already running, no-op.
 */
export async function enableAndStartAgent(
  agentId: string,
  opts: { overrideKillSwitch?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!inMemoryState || !daemonConfig) {
    return { ok: false, error: 'Daemon not initialized' };
  }

  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) {
    return { ok: false, error: 'Agent not found' };
  }

  // SCLI-110 (hardened): the kill-switch (disabled-agents.json) is AUTHORITATIVE.
  // ONLY an explicit operator un-stop (overrideKillSwitch — wired solely to the
  // Hive Start / dashboard toggle-on control) may clear it. Every other caller —
  // crash/wedge restart, /resume, startup auto-start, credential-broker restart,
  // health recovery, or a naive toggle-on from automation/a fleet agent — MUST
  // respect it. Previously enableAndStartAgent unconditionally cleared the switch,
  // so any of those paths silently revived an agent the operator had explicitly
  // stopped. Now an explicitly-stopped agent never comes back to life on its own.
  const disabledSet = readDisabledAgents();
  if (disabledSet.has(agentId) && !opts.overrideKillSwitch) {
    console.warn(
      `[daemon] enableAndStartAgent: REFUSING to start ${agent.username || agent.name || agentId} — operator-disabled (SCLI-110 kill-switch active); only an explicit operator Start clears it`,
    );
    return { ok: false, error: 'agent is operator-disabled (kill-switch active); not started' };
  }

  const desiredState = setAgentDesiredRuntimeState(agentId, true, {
    actor: 'enableAndStartAgent',
    overrideKillSwitch: opts.overrideKillSwitch,
  });
  if (!desiredState.ok) return desiredState;

  if (disabledSet.has(agentId) && opts.overrideKillSwitch) {
    console.log(
      `[daemon] enableAndStartAgent: explicit operator override cleared kill-switch for ${agent.username || agent.name || agentId}`,
    );
  }

  // Persisted config status is a one-way latch without this: pauseK8sAgent
  // writes { status: 'paused' } and no start path ever wrote it back, so a
  // toggled-on agent kept its pod running while the health exporter read the
  // stale 'paused' and emitted shizuha_agent_enabled=0 — Pulse availability
  // then never recovered and the seat stayed unroutable (mika, 2026-07-14).
  // An explicit enable restores the steady-state 'active'.
  if (agent.status === 'paused' || agent.status === 'disabled') {
    updateAgentConfig(agentId, { status: 'active' });
    agent.status = 'active';
  }

  // If already running, the toggle still had to pass through the AgentStateStore
  // seam above; after that, only refresh the in-memory desired flag.
  if (childProcesses.has(agentId)) {
    updateAgentInMemory(agentId, { enabled: true });
    return { ok: true };
  }

  // fleet-ssh grant materialization now happens in startAgentProcess (the common
  // start path) so restarts/respawns that bypass enableAndStartAgent also re-derive it.

  // Runner tokens (platformClient.ensureRunnerToken etc.) were used only by
  // the runner-proxy relay to shizuha-agent's /ws/runner/, which was retired
  // 2026-04-20. Agents now speak to Connect directly; no platform-side relay
  // token is needed. Keeping `platformRunnerToken` as an empty string so the
  // downstream updateAgentInMemory() call below continues to compile.
  const platformRunnerToken = '';

  updateAgentInMemory(agentId, {
    status: 'starting',
    enabled: true,
    tokenPrefix: 'local',
    startedAt: new Date().toISOString(),
    error: undefined,
  });

  // Desired enabled/operator-disabled state was persisted through
  // setAgentDesiredRuntimeState before mutating runtime memory.

  // Effective-capabilities refresh moved into startAgentProcess (after its
  // pre-start config rehydrate) so EVERY start path — not just this one —
  // launches with fresh persisted config + a fresh Hive overlay.
  const startError = await startAgentProcess(agent, platformRunnerToken, daemonConfig);
  if (startError) {
    return { ok: false, error: startError };
  }
  return { ok: true };
}

/**
 * Disable and stop a single agent's runtime.
 * Kills the gateway subprocess.
 */
export function disableAndStopAgent(agentId: string): { ok: boolean; error?: string } {
  if (!inMemoryState) {
    return { ok: false, error: 'Daemon not initialized' };
  }

  // The persisted roster is the lifecycle source of truth. A k3s agent can be
  // temporarily absent from discoveredAgents (for example after a provider
  // failure or partial discovery refresh) while its Deployment is still 1/1.
  // Returning success in that state persisted "stopped" without ever scaling
  // the workload down, so Hive rendered the agent stopped while it continued
  // consuming provider quota. Resolve the durable roster before acknowledging
  // the stop; discoveredAgents remains the preferred live object.
  const agent = discoveredAgents.find((a) => a.id === agentId || a.username === agentId)
    ?? readAgents().find((a) => a.id === agentId || a.username === agentId);

  // Persist disabled desired-state before touching the backend. PLAT-1062 P4b
  // routes MCP/CLI/dashboard stop through the AgentStateStore first, then mirrors
  // the legacy enabled/disabled JSON files. If the authoritative store is
  // unavailable, fail before mutating runtime memory or stopping the process.
  const desiredState = setAgentDesiredRuntimeState(agentId, false, { actor: 'disableAndStopAgent' });
  if (!desiredState.ok) return desiredState;

  revokeAgentGatewayTokens(agentId);

  updateAgentInMemory(agentId, {
    status: 'stopped',
    enabled: false,
    pid: undefined,
  });

  let stopError: string | undefined;

  const child = childProcesses.get(agentId);
  if (child) {
    child.kill('SIGTERM');
    childProcesses.delete(agentId);

    // Force kill after 5s
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 5000);
  }

  // Desired placement may already say "container" while a stale k3s backend
  // is still running. Stop the observed backend, not merely the desired one.
  const liveK8sDeployment = agent ? getAgentK8sDeploymentState(agent) : null;
  if (agent && (isK8sAgent(agent) || liveK8sDeployment)) {
    try {
      stopAgentK8s({ ...agent, runtimeEnvironment: 'k8s' });
    } catch (err) {
      stopError = (err as Error).message;
      updateAgentInMemory(agentId, { status: 'error', error: `k8s stop failed: ${stopError}` });
    }
  }

  console.log(`[daemon] ${agent?.name ?? agentId}: disabled${stopError ? ` (k8s stop failed: ${stopError})` : ''}`);

  if (stopError) return { ok: false, error: stopError };
  return { ok: true };
}

/** Resolve the AGENT_PASSWORD value rendered into the k8s Secret.
 *
 * The standard credential path resolves per-agent credentials into
 * `credentialEnv`/`launchCredentialEnv`; k8s apply must use that resolved value
 * instead of bypassing it with raw `agent.env`, or reconcile can render an empty
 * broker password for normal credential-backed agents.
 */
export function resolveK8sSpawnPassword(
  agent: AgentInfo,
  launchCredentialEnv: Record<string, string>,
): string {
  for (const candidate of [
    launchCredentialEnv['AGENT_PASSWORD'],
    // Full canonical chain: shizuha-id credential grant → agent env →
    // agent-passwords.json. Agents with no active grant in daemon state (e.g.
    // re-enabled parked agents) only have their password in the json store;
    // skipping the chain baked AGENT_PASSWORD='' into 6 agents' secrets and
    // left their brokers permanently unready (2026-07-10).
    resolveAgentPassword(agent),
    readAgentCredential('AGENT_PASSWORD'),
  ]) {
    if (isUsableAgentPassword(candidate)) return candidate;
  }
  return '';
}

/** Pause a k8s-native agent by persisting desired paused state and scaling it to 0. */
export function pauseK8sAgent(agentId: string): { ok: boolean; error?: string } {
  if (!inMemoryState) {
    return { ok: false, error: 'Daemon not initialized' };
  }

  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) return { ok: false, error: 'Agent not found' };
  if (!isK8sAgent(agent)) return { ok: false, error: 'Agent is not k8s-native' };

  // Persist paused desired-state before stopping. The enabled set remains true,
  // but runtime reconcile only re-applies active k8s agents, so it will not
  // immediately restart this paused Deployment.
  updateAgentConfig(agent.id, { status: 'paused' } as any);
  agent.status = 'paused';
  updateAgentInMemory(agent.id, { status: 'stopped', enabled: true, pid: undefined });

  try {
    stopAgentK8s(agent);
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    updateAgentInMemory(agent.id, { status: 'error', error: `k8s pause stop failed: ${message}` });
    return { ok: false, error: message };
  }
}

/**
 * Restart an agent by killing its process while keeping it enabled.
 * The exit handler's auto-restart logic will bring it back with updated config.
 */
export async function restartAgent(agentId: string): Promise<void> {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  const runtime = normalizeRuntimeEnvironment(agent?.runtimeEnvironment, 'bare_metal');

  if (agent && isK8sAgent(agent)) {
    await restartAgentK8s(agent);
  } else if (runtime === 'container' || runtime === 'restricted_container' || runtime === 'sandbox') {
    // For containers: `docker rm -f` is the reliable way to stop them.
    // Sending SIGTERM to the `docker run` process only forwards SIGTERM to PID 1
    // inside the container — if PID 1 catches it and hangs, the container stays alive.
    const containerName = `shizuha-agent-${agent?.username ?? agentId}`;
    try {
      execSync(`${resolveDockerPath()} rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore', timeout: 15_000 });
    } catch { /* ignore — container may already be gone */ }
    // Clear stale state immediately — don't wait for startAgentProcess
    containerIpCache.delete(agentId);
  } else {
    // Bare-metal: SIGTERM the process directly
    const child = childProcesses.get(agentId);
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }
  }
}

/**
 * Clear an agent's durable runtime session so the next start resumes from a fresh state.
 * This is intentionally narrow: remove only the runtime's session artifact, not the whole workspace.
 */
export function resetAgentRuntimeSession(agentId: string): { ok: boolean; error?: string } {
  const agent = discoveredAgents.find((a) => a.id === agentId || a.username === agentId);
  if (!agent) {
    return { ok: false, error: 'Agent not found' };
  }

  const workspaceDir = getAgentWorkspaceDir(agent);
  const method = getPrimaryExecutionMethod(agent);

  try {
    // Clear all known per-agent runtime state so reset remains correct even if
    // an agent changed execution methods over time.
    resetSqliteSessionDatabase(path.join(workspaceDir, '.shizuha-state.db'), `agent-session-${agent.id}`);
    resetSqliteSessionDatabase(path.join(workspaceDir, '.codex-state.db'), `codex-bridge-${agent.id}`);
    // OpenClaw state files may be owned by root inside the workspace even though
    // the workspace directory itself is writable by the daemon user. Removing the
    // per-agent database files is more reliable than mutating the live DB in place.
    removeSqliteDatabaseFiles(path.join(workspaceDir, '.openclaw-state.db'));
    fs.rmSync(path.join(workspaceDir, '.claude-session-id'), { force: true });

    switch (method) {
      case 'shizuha': {
        return { ok: true };
      }
      case 'codex_app_server': {
        return { ok: true };
      }
      case 'openclaw_bridge': {
        return { ok: true };
      }
      case 'claude_code_server': {
        return { ok: true };
      }
      default:
        return { ok: false, error: `Runtime session reset is not supported for method "${method}"` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Check if an agent runtime is currently running.
 */
export function isAgentRunning(agentId: string): boolean {
  const child = childProcesses.get(agentId);
  return !!child && !child.killed && child.exitCode === null;
}

/**
 * Get the local port for a local agent (if running).
 */
export function getLocalAgentPort(agentId: string): number | null {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) return null;
  return agent.localPort ?? null;
}

/** Cached container IP addresses (resolved once, refreshed on reconnect). */
const containerIpCache = new Map<string, string>();

/**
 * Get the WS URL for connecting to an agent's gateway.
 * - Container agents: connect via Docker network IP (no host port mapping needed)
 * - Bare metal agents: connect via 127.0.0.1:{port}
 */
export function getContainerUrl(agentId: string): string | null {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) return null;
  const runtime = normalizeRuntimeEnvironment(agent.runtimeEnvironment, 'bare_metal');

  // Bare metal: use agent's configured port on localhost
  if (runtime === 'bare_metal') {
    const port = agent.localPort ?? 8080;
    return `ws://127.0.0.1:${port}/ws/chat/`;
  }

  // Container: resolve IP via docker inspect (daemon runs on host, can't use Docker DNS).
  // Always do a fresh inspect — never use stale cached IPs.
  const containerPort = 8080;
  const containerName = `shizuha-agent-${agent.username}`;

  try {
    const ip = execSync(
      `${resolveDockerPath()} inspect ${containerName} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null`,
      { timeout: 3000, encoding: 'utf-8' },
    ).trim();
    if (ip) {
      return `ws://${ip}:${containerPort}/ws/chat/`;
    }
  } catch { /* container not running */ }

  return null;
}

/**
 * Sync bundled integration skills from the shizuha dist tree into the user's
 * ~/.shizuha/skills/ directory. Bundled skills live with shizuha source
 * (dist/skills/integrations/<name>/SKILL.md) and need to be visible to:
 *   - daemon-side: loadStarredSkills(), bridge-identity prompt builder,
 *     GET /v1/skills, installStarredSkillsForClaudeCode()
 *   - container-side: gateway/agent-process.ts + provider-native/native SCLI
 *     skill loading, which read from /opt/skills (bind mount of ~/.shizuha/skills/)
 *
 * Symlinks would be dangling inside containers because they'd point at
 * host-absolute paths, so we **copy** the files instead. To distinguish
 * bundled copies from user-authored skills, each bundled target carries a
 * `.shizuha-bundled` marker file. On startup:
 *
 *   - Missing target            → copy bundled content, write marker
 *   - Target has marker         → refresh from bundled (source of truth)
 *   - Target is regular dir     → leave alone (user-authored, never touch)
 *   - Target is symlink (legacy)→ delete and re-copy
 */
const BUNDLED_MARKER = '.shizuha-bundled';

function copySkillDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copySkillDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function syncBundledSkills(): void {
  const home = process.env['HOME'] ?? '/root';
  const userSkillsDir = path.join(home, '.shizuha', 'skills');

  // If the skills dir is a git working tree, the repo (shizuha-labs/skills) is
  // the canonical source — kept current by the skill-sync loop. Don't churn it
  // from the dist bundle: copySkillDir rewrites a timestamp `.shizuha-bundled`
  // marker on every boot, which dirties tracked files and would block the
  // ff-only auto-sync pull. Dist-seeding only matters for non-git/standalone
  // installs (where the repo isn't present to provide the integration skills).
  if (fs.existsSync(path.join(userSkillsDir, '.git'))) {
    return;
  }

  const shizuhaDistDir = path.dirname(process.argv[1] ?? __filename);
  const bundledDir = path.join(shizuhaDistDir, 'skills', 'integrations');

  if (!fs.existsSync(bundledDir)) {
    return; // running outside the bundled tree (e.g. dev with src-only)
  }

  try {
    fs.mkdirSync(userSkillsDir, { recursive: true });
  } catch (err) {
    console.warn(`[daemon] could not create ${userSkillsDir}: ${(err as Error).message}`);
    return;
  }

  let synced = 0;
  let skipped = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(bundledDir);
  } catch {
    return;
  }

  for (const name of entries) {
    const src = path.join(bundledDir, name);
    if (!fs.statSync(src).isDirectory()) continue;
    const dest = path.join(userSkillsDir, name);
    const marker = path.join(dest, BUNDLED_MARKER);

    let existing: fs.Stats | null = null;
    try { existing = fs.lstatSync(dest); } catch { /* doesn't exist */ }

    const refresh = () => {
      try {
        if (existing) removeDir(dest);
        copySkillDir(src, dest);
        fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
        synced++;
      } catch (err) {
        console.warn(`[daemon] failed to sync bundled skill ${name}: ${(err as Error).message}`);
      }
    };

    if (!existing) {
      refresh();
      continue;
    }

    if (existing.isSymbolicLink()) {
      // Legacy symlink from an earlier sync — replace with a copy
      try { fs.unlinkSync(dest); existing = null; } catch {}
      refresh();
      continue;
    }

    if (existing.isDirectory() && fs.existsSync(marker)) {
      // Previously synced bundle — refresh unconditionally (source of truth)
      refresh();
      continue;
    }

    // Regular directory without marker: user-authored, never touch
    skipped++;
  }

  if (synced > 0 || skipped > 0) {
    console.log(`[daemon] bundled skills sync: ${synced} copied, ${skipped} user-managed left untouched`);
  }
}

const SKILL_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Convergent skill-sync loop. Polls the skills git checkout against its upstream
 * and fast-forwards when behind, so merged skill changes converge onto the fleet
 * with no human step. Pull-based (no ingress) and self-healing (a missed tick is
 * caught by the next). Safety rails: only acts on a clean git working tree
 * (dirty-guard), only fast-forward (never merge/rebase/force), and only when
 * auto-sync is enabled (settings.json `autoSkillSync`, default on).
 *
 * Reload is the agents' own job: Claude Code hot-reloads via skillChangeDetector
 * watching the symlinked /opt/skills; Codex reads /opt/skills via cron-MCP search.
 */
function startSkillSyncLoop(): void {
  const home = process.env['HOME'] ?? '/root';
  const skillsDir = path.join(home, '.shizuha', 'skills');

  const tick = (): void => {
    try {
      if (!isAutoSkillSyncEnabled()) return;
      if (!fs.existsSync(path.join(skillsDir, '.git'))) return; // not a git checkout
      const git = (args: string): string =>
        execSync(`git -C "${skillsDir}" ${args}`, { encoding: 'utf-8', timeout: 30_000 }).trim();

      // Dirty-guard: never pull over local changes.
      if (git('status --porcelain')) {
        console.warn('[daemon] skill-sync: working tree dirty — skipping pull');
        return;
      }
      const branch = git('rev-parse --abbrev-ref HEAD') || 'master';
      const localSha = git('rev-parse HEAD');
      // Cheap delta check first — one tiny network call, no fetch unless changed.
      const remoteSha = git(`ls-remote origin ${branch}`).split(/\s+/)[0];
      if (!remoteSha || remoteSha === localSha) return; // up to date

      git('fetch --quiet origin');
      git(`merge --ff-only origin/${branch}`); // throws if not fast-forwardable → caught below
      const after = git('rev-parse HEAD');
      if (after !== localSha) {
        const changed = git(`diff --name-only ${localSha} ${after}`).split('\n').filter(Boolean);
        const skills = [...new Set(changed.map((f) => f.split('/')[0]))];
        console.log(`[daemon] skill-sync: ${branch} ${localSha.slice(0, 7)}→${after.slice(0, 7)} — updated: ${skills.join(', ')}`);
      }
    } catch (err) {
      console.warn(`[daemon] skill-sync error: ${(err as Error).message}`);
    }
  };

  setTimeout(tick, 30_000); // first pass shortly after startup
  setInterval(tick, SKILL_SYNC_INTERVAL_MS);
}

/**
 * Platform-universal skills: loaded for EVERY agent regardless of their
 * `agent.skills` array. Used for cross-cutting platform invariants like
 * "how messaging works on Connect" — things every agent must understand.
 *
 * Add a skill here only if it should be non-optional for all agents. Most
 * skills should stay in per-agent config where the agent owner decides.
 */
const PLATFORM_UNIVERSAL_SKILLS = [
  'connect-messaging',    // every agent sends/receives DMs → must know the protocol
  'heartbeat-protocol',   // every agent receives heartbeats → must know silence-is-default
  'pulse-core',           // every agent receives task assignments → must advance state per workflow (lean core; role depth in the role skills below)
  'skill-loader',         // LOAD relevant skills before acting; where to find them (folder/git/wiki) — every operating rule is a skill (critical, inlined; operator 2026-06-24)
  'web-search',           // web-search current external facts before major/current/jurisdictional decisions; default India/IST operator context (critical, inlined; operator 2026-06-25)
  'skill-builder',        // every agent can CREATE/modify/re-tier skills; prefer reference, keep static context lean; "update CLAUDE.md / change behavior" = author a skill (critical, inlined; operator 2026-06-24)
  'wiki-lifecycle',       // CONSULT the wiki before any non-trivial action (gather info first), DOCUMENT durable knowledge after — every agent, by default (critical, inlined; operator 2026-06-24)
  'budget-discipline',    // operator budget cap (1 agent/team; no capacity growth; never re-enable a disabled agent) — critical, body inlined for every agent
  'session-stamina',      // one continuous session — keep working the queue to full quality; "session depth" is never a reason to stop/defer/do-less (critical, inlined)
  'defer-exposed-token-rotation', // credential/token rotation (incl. exposed/leaked) is auto-deferred until system stable — never raise/file/escalate/block on it (critical, inlined)
];

/**
 * Load starred skills for an agent — skills whose full SKILL.md body should be
 * injected into the agent's system prompt (via --context-prompt) so they are
 * always in context. Works for ALL agent types (Claude, Gemini, Codex, etc.).
 *
 * A skill is "eager" if ANY of:
 *   - Its SKILL.md frontmatter declares `starred: true` or `critical: true`, OR
 *   - The agent's `eagerSkills` array lists its name (per-agent override), OR
 *   - It's in `PLATFORM_UNIVERSAL_SKILLS` (platform-wide invariant).
 *
 * PLAT-457 BUILD-1: discovery is frontmatter-driven. Candidate skills come
 * from the installed catalog plus explicit agent/platform names; `roles:`
 * filtering is applied through `skillMatchesAudience()` before injection.
 */
export function loadStarredSkills(
  agent: { name: string; role?: string | null; team?: string | null; skills?: string[]; eagerSkills?: string[] },
  opts?: { criticalOnly?: boolean },
): string | null {
  const configuredSkills = new Set(agent.skills ?? []);
  const eagerOverride = new Set(agent.eagerSkills ?? []);
  const candidateSkills = new Set<string>([
    ...listSkillNames(),
    ...configuredSkills,
    ...PLATFORM_UNIVERSAL_SKILLS,
    ...eagerOverride,
  ]);
  if (candidateSkills.size === 0) return null;

  const criticalOnly = !!opts?.criticalOnly;
  const starredContents: string[] = [];

  for (const skillName of [...candidateSkills].sort()) {
    const meta = readSkillByName(skillName);
    if (!meta) continue;
    if (!skillMatchesAudience(meta, agent.role, agent.team)) continue;
    const isPlatformUniversal = PLATFORM_UNIVERSAL_SKILLS.includes(skillName);
    const isExplicit = configuredSkills.has(skillName) || eagerOverride.has(skillName);
    const isEager = isPlatformUniversal || isExplicit || meta.starred || meta.critical;
    if (!isEager) continue;
    // Critical-only mode: filter out non-critical skills. Used by Claude
    // bridges where non-critical starred skills are served via the native
    // ~/.claude/skills/ mount (name + description visible inline, body
    // accessed via the provider-native skill loader). Critical skills bypass that and get their
    // body inlined into the agent's system prompt to guarantee the agent
    // has read them before acting.
    if (criticalOnly && !meta.critical) continue;
    starredContents.push(`## Starred Skill: ${skillName}\n\n${meta.body.trim()}`);
  }

  if (starredContents.length === 0) return null;
  return starredContents.join('\n\n---\n\n');
}

/**
 * Install starred skills into Claude Code's native skills directory (~/.claude/skills/).
 * Claude Code auto-discovers these: descriptions are always in system prompt context,
 * skills auto-invoke when relevant, and users can invoke via /skill-name.
 *
 * The host path ~/.shizuha/claude-sessions/<username>/skills/<name>/SKILL.md
 * maps to /home/agent/.claude/skills/<name>/SKILL.md inside the container.
 */
function installStarredSkillsForClaudeCode(agent: { name: string; username?: string; skills?: string[]; eagerSkills?: string[] }): void {
  if (!agent.username) return;

  const shizuhaHome = process.env['HOME'] ?? '/root';
  const skillsSource = path.join(shizuhaHome, '.shizuha', 'skills');
  const claudeSkillsDir = path.join(shizuhaHome, '.shizuha', 'claude-sessions', agent.username, 'skills');

  if (!fs.existsSync(skillsSource)) return;

  // Expose the FULL skill catalog to Claude Code's native skill system by making
  // ~/.claude/skills a SINGLE symlink to the bind-mounted /opt/skills directory.
  //
  // One whole-dir link (vs per-skill links) means the native view always equals
  // the live catalog: skills added, removed, or edited upstream appear with NO
  // per-agent relink and NO session restart — the auto-sync loop pulls into
  // /opt/skills and Claude Code's skillChangeDetector (watching this dir) picks
  // it up live. Body is read on demand; name+description menu is hot-reloaded.
  //
  // Safe because Claude Code only READS ~/.claude/skills — its own skill writes
  // go to a nonce-scoped temp dir and the project .claude/skills (verified in the
  // CC sources), and it uses O_NOFOLLOW, so it never writes through this symlink.
  //
  // Target is the IN-CONTAINER path `/opt/skills` (where ~/.shizuha/skills is
  // bind-mounted); the link is created host-side — dangling on the host but
  // resolving correctly inside the agent container.
  const CONTAINER_SKILLS_PATH = '/opt/skills';

  try {
    const lst = fs.lstatSync(claudeSkillsDir, { throwIfNoEntry: false });
    if (lst) {
      if (lst.isSymbolicLink()) {
        if (fs.readlinkSync(claudeSkillsDir) === CONTAINER_SKILLS_PATH) return; // already correct
        fs.unlinkSync(claudeSkillsDir);
      } else {
        // Previously a real dir (copies / per-skill symlinks) — replace it.
        fs.rmSync(claudeSkillsDir, { recursive: true, force: true });
      }
    }
    fs.mkdirSync(path.dirname(claudeSkillsDir), { recursive: true });
    fs.symlinkSync(CONTAINER_SKILLS_PATH, claudeSkillsDir);
    console.log(`[daemon] ${agent.name}: Claude Code native skills dir -> ${CONTAINER_SKILLS_PATH} (full live catalog)`);
  } catch (err) {
    console.warn(`[daemon] ${agent.name}: failed to link skills dir: ${(err as Error).message}`);
  }
}

export function clearContainerIpCache(agentId?: string): void {
  if (agentId) {
    containerIpCache.delete(agentId);
  } else {
    containerIpCache.clear();
  }
}

/**
 * Periodic account-reconcile retry (operator directive 2026-07-10).
 *
 * Spawning an agent WITHOUT platform credentials is deliberate — like a human
 * whose company ID server is down: he still comes to work (and might even be the
 * devops who fixes ID). The runtime mints its platform token ON DEMAND
 * (AgentTokenManager login with AGENT_USERNAME+AGENT_PASSWORD, proactive
 * pre-expiry + reactive-401), so once shizuha-id is back AND the account password
 * matches the injected secret, a RUNNING agent recovers with no restart.
 *
 * The one failure that does NOT self-heal is account<->secret password DRIFT
 * discovered while shizuha-id was unreachable at spawn: the account still holds
 * the old password, the agent's on-demand logins keep failing, and nothing
 * server-side retries — "resync on next spawn" could be days away. This loop
 * closes that: agents whose spawn-time ensureAgentAccount failed are retried
 * every few minutes; on success the account matches the injected secret and the
 * agent's next on-demand login just works.
 */
const pendingAccountReconciles = new Map<string, AgentInfo>();
let accountReconcileTimer: ReturnType<typeof setInterval> | null = null;
const ACCOUNT_RECONCILE_RETRY_MS = 5 * 60 * 1000;

function notePendingAccountReconcile(agent: AgentInfo): void {
  pendingAccountReconciles.set(agent.id, agent);
  if (!accountReconcileTimer) {
    accountReconcileTimer = setInterval(() => { void retryPendingAccountReconciles(); }, ACCOUNT_RECONCILE_RETRY_MS);
    accountReconcileTimer.unref?.();
  }
}

async function retryPendingAccountReconciles(): Promise<void> {
  if (!pendingAccountReconciles.size) return;
  const {
    ensureAgentAccount, isDaemonAdminFamilyDead, hasFleetProvisionerToken, refreshDaemonAdminToken,
  } = require('./agent-accounts.js') as typeof import('./agent-accounts.js');
  // SCLI-205: no live admin path AND no static fleet-provisioner token — retrying
  // would only 401-storm shizuha-id; keep the agents pending until a credential lands.
  if (isDaemonAdminFamilyDead() && !hasFleetProvisionerToken()) return;
  const platformUrl = resolvePlatformUrl();
  let daemonAdminToken = process.env['SHIZUHA_ACCESS_TOKEN'] || '';
  if (!daemonAdminToken) {
    try { daemonAdminToken = (await refreshDaemonAdminToken({ platformUrl })) || ''; } catch { /* fleet-provisioner path may still work */ }
  }
  for (const [agentId, agent] of [...pendingAccountReconciles]) {
    // Skip agents that no longer run under this daemon (removed/disabled since).
    if (!inMemoryState?.agents?.some((a) => a.agentId === agentId)) {
      pendingAccountReconciles.delete(agentId);
      continue;
    }
    try {
      const account = await ensureAgentAccount({
        agentUsername: agent.username,
        agentEmail: agent.email ?? `${agent.username}@agents.shizuha.io`,
        agentFirstName: agent.name,
        agentLastName: '(AI Agent)',
        agentRuntimeId: agent.id,
        platformUrl,
        adminToken: daemonAdminToken,
        canonicalPassword: resolveAgentPassword(agent),
        persistCanonicalPassword: (password: string) => persistCanonicalAgentPassword(agent, password),
        remintAdminToken: () => refreshDaemonAdminToken({ platformUrl, force: true }),
      });
      if (account) {
        pendingAccountReconciles.delete(agentId);
        console.log(`[daemon] ${agent.name}: account reconcile RECOVERED on periodic retry (user_id=${account.userId}) — runtime picks it up on its next on-demand login, no restart needed`);
      }
    } catch (err) {
      console.warn(`[daemon] ${agent.name}: periodic account reconcile retry failed (will retry): ${(err as Error).message}`);
    }
  }
}

/**
 * Start a single agent as a gateway subprocess.
 *
 * Config resolution:
 * - If the agent has a local ~/.shizuha/agents/{username}/agent.toml,
 *   the gateway loads all runtime config from there (model, thinking, etc.).
 *   Platform model_overrides are NOT passed — local config takes priority.
 * - If no local config exists, platform model_overrides are passed as --model
 *   fallback so the gateway has something to work with.
 * - Same logic for context_prompt vs CLAUDE.md.
 */
/** Returns error string if startup failed, undefined if successful */
async function startAgentProcess(
  agent: AgentInfo,
  token: string,
  config: DaemonConfig,
  startOpts: { imageOverride?: string; brokerImageOverride?: string } = {},
): Promise<string | undefined> {
  // SCLI-110 kill-switch: never start an explicitly-disabled agent, no matter
  // which path tries (exit-handler auto-restart, credential-broker, reconcile,
  // wedge force-restart). Only enableAndStartAgent (which clears the disabled
  // set first) may bring a stopped agent back.
  if (readDisabledAgents().has(agent.id)) {
    console.log(`[daemon] ${agent.name ?? agent.id}: start skipped — explicitly disabled (SCLI-110)`);
    return undefined;
  }

  // Pre-start config rehydrate (2026-07-02 handover finding #1): every start /
  // restart path (exit-handler auto-restart, restartAgent kill→respawn, boot
  // loop, failover, reconcile) routes through here, but callers pass AgentInfo
  // objects captured in closures or in a discoveredAgents array that a
  // dashboard/API PATCH may have since REPLACED — so a restart could relaunch
  // the agent with pre-PATCH model/method config until its container was
  // manually removed. Re-read the persisted roster and merge the row into the
  // SAME object (Object.assign — identity-preserving, so runtime-only fields
  // like effectiveCapabilities survive and every closure holding this
  // reference sees the fresh config). Also sync the discoveredAgents entry if
  // it is a different object for the same id. The pre-start effective-
  // capabilities refresh below then re-applies Hive runtime capabilities on
  // top of the fresh persisted base.
  try {
    const persisted = readAgents().find((a) => a.id === agent.id);
    if (persisted) {
      const roster = discoveredAgents.find((a) => a.id === agent.id);
      // Capture Hive's live overlay BEFORE either object is rehydrated from the
      // local store. `agent` and `roster` may be the same object, or a stale
      // closure may pass a distinct copy; both shapes must converge identically.
      const runtimeAuthority = roster ? {
        model: roster.model,
        executionMethod: roster.executionMethod,
        modelFallbacks: roster.modelFallbacks,
        modelOverrides: roster.modelOverrides,
        effectiveCapabilities: roster.effectiveCapabilities,
        skills: roster.skills,
        eagerSkills: roster.eagerSkills,
        mcpServers: roster.mcpServers,
        credentialGrantScopes: roster.credentialGrantScopes,
        credentialCustomGrantServices: roster.credentialCustomGrantServices,
      } : null;
      Object.assign(agent, persisted);
      if (roster && roster !== agent) Object.assign(roster, persisted);
      if (runtimeAuthority) {
        applyRuntimeAuthorityOverlay(agent, runtimeAuthority);
        if (roster && roster !== agent) applyRuntimeAuthorityOverlay(roster, runtimeAuthority);
      }
    }
  } catch (err) {
    console.warn(`[daemon] ${agent.name ?? agent.id}: pre-start config rehydrate failed: ${(err as Error).message}; starting with in-memory config`);
  }

  // Re-apply the Hive effective-capabilities overlay ON TOP of the fresh
  // persisted base — for every start path, not just enableAndStartAgent
  // (exit-handler auto-restarts and failover respawns previously launched
  // with whatever overlay the stale object happened to carry). Failure keeps
  // the legacy/persisted capability fields (documented fallback).
  await refreshEffectiveCapabilitiesForAgentIfStale(agent, 'pre-start');

  // Resolve symlinks so container mount paths match the real filesystem layout.
  // e.g. ~/.shizuha/lib/shizuha.js → /real/path/dist/shizuha.js
  const shizuhaJs = fs.realpathSync(process.argv[1]!);
  const agentDir = path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents', agent.username);
  const hasLocalConfig = fs.existsSync(path.join(agentDir, 'agent.toml'));
  const hasLocalClaudeMd = fs.existsSync(path.join(agentDir, 'CLAUDE.md'));

  // PLAT-966: Seed agent identity keypair to HOST filesystem before spawn.
  // claude-bridge agents never execute the gateway AgentProcess path where
  // loadOrCreateAgentKeypair is normally called. Without a HOST-side keypair,
  // agent-auth.ts:loadAgentPublicKey() throws "no registered public key" when
  // the agent calls restart_agent/reset_agent_session/pause_agent via gateway
  // auth. Seeding here (daemon runs on host with daemon's HOME) writes to the
  // exact path agent-auth.ts reads for challenge issuance.
  try {
    loadOrCreateAgentKeypair(agentDir, agent.username);
    const identityDir = path.join(agentDir, 'identity');
    ensurePrivateDir(agentDir, true);
    ensurePrivateDir(identityDir, true);
    const identityFile = path.join(identityDir, 'agent-keypair.json');
    if (fs.existsSync(identityFile)) ensurePrivateFileForContainerAgent(identityFile);
  } catch (err) {
    console.warn("[daemon] PLAT-966: Could not seed identity keypair for " + agent.name + ": " + (err as Error).message);
  }

  // Determine execution command based on the current runtime step. The agent's
  // declared executionMethod is primary; failoverChainId contributes backup
  // capacity and the in-memory failover index selects later steps after a bridge
  // exits with code 42.
  const runtimeChain = resolveRuntimeChain(agent);
  const resolvedPrimary = resolveCurrentRuntimeStep(agent);
  const primaryMethod = resolvedPrimary?.method ?? agent.executionMethod ?? agent.modelFallbacks?.[0]?.method ?? 'shizuha';

  // Model-method constraint: if a bridge-specific execution method is paired with an
  // incompatible model (e.g. gemini_cli_server + vllm/Qwen), fall back to the shizuha
  // gateway which supports all providers natively. We NEVER mutate the in-memory agent
  // object here — that would cause the dashboard to silently revert user config.
  const primaryModel = resolvedPrimary?.model ?? agent.modelFallbacks?.[0]?.model ?? '';
  let effectiveMethod = primaryMethod;
  const requestedClaudeBridge = primaryMethod === 'claude_code_server';
  const requestedCodexBridge = primaryMethod === 'codex_app_server';
  const requestedGeminiBridge = primaryMethod === 'gemini_cli_server';
  const requestedGrokBuild = primaryMethod === 'grok_build';

  if (requestedClaudeBridge && primaryModel && !primaryModel.startsWith('claude') && !primaryModel.startsWith('opus') && !primaryModel.startsWith('sonnet') && !primaryModel.startsWith('haiku')) {
    console.warn(`[daemon] ${agent.name}: claude_code_server requires a Claude model (got "${primaryModel}"). Falling back to shizuha gateway.`);
    effectiveMethod = 'shizuha';
  }
  if (requestedCodexBridge && primaryModel && !primaryModel.startsWith('gpt') && !primaryModel.startsWith('codex') && !primaryModel.startsWith('o3') && !primaryModel.startsWith('o4')) {
    console.warn(`[daemon] ${agent.name}: codex_app_server requires an OpenAI model (got "${primaryModel}"). Falling back to shizuha gateway.`);
    effectiveMethod = 'shizuha';
  }
  if (requestedGeminiBridge && primaryModel && primaryModel !== 'auto' && !primaryModel.startsWith('gemini')) {
    console.warn(`[daemon] ${agent.name}: gemini_cli_server requires a Gemini model (got "${primaryModel}"). Falling back to shizuha gateway.`);
    effectiveMethod = 'shizuha';
  }
  if (requestedGrokBuild && primaryModel && !isGrokBuildModel(primaryModel)) {
    console.warn(`[daemon] ${agent.name}: grok_build requires a Grok model (got "${primaryModel}"). Falling back to shizuha gateway.`);
    effectiveMethod = 'shizuha';
  }
  const useClaudeBridge = effectiveMethod === 'claude_code_server';
  const useCodexBridge = effectiveMethod === 'codex_app_server';
  const useOpenClawBridge = effectiveMethod === 'openclaw_bridge';
  const useGeminiBridge = effectiveMethod === 'gemini_cli_server';
  // grok_build runs the SCLI gateway against Cortex SuperGrok (Grok Build OIDC
  // on managed xai-grok). Native `grok` CLI bridge can replace this later.
  const useGrokBuild = effectiveMethod === 'grok_build';
  const bareMetalStateDatabase = useCodexBridge
    ? '.codex-state.db'
    : useOpenClawBridge
      ? '.openclaw-state.db'
      : !useClaudeBridge && !useGeminiBridge
        ? '.shizuha-state.db'
        : null;
  if (normalizeRuntimeEnvironment(agent.runtimeEnvironment, 'bare_metal') === 'bare_metal') {
    const workspace = getAgentWorkspaceDir(agent);
    try {
      const repair = await repairBareMetalRuntimeWorkspace(workspace, bareMetalStateDatabase);
      resetBareMetalStateRepairRetry(agent.id);
      if (repair.repairedPaths.length > 0) {
        console.warn(
          `[daemon] ${agent.name}: repaired legacy read-only runtime artifacts before launch: ` +
          repair.repairedPaths.join(', '),
        );
      }
      if (repair.retainedLegacyDirectories.length > 0) {
        console.warn(
          `[daemon] ${agent.name}: retained unreadable-owner recovery copies after rootless directory repair: ` +
          repair.retainedLegacyDirectories.map((entry) => path.basename(entry)).join(', '),
        );
      }
    } catch (error) {
      const delayMs = scheduleBareMetalStateRepairRetry(agent, config);
      const message =
        `bare-metal workspace preflight failed: ${(error as Error).message}; ` +
        `retrying autonomously in ${Math.round(delayMs / 1000)}s`;
      console.error(`[daemon] ${agent.name}: ${message}`);
      updateAgentInMemory(agent.id, { status: 'error', error: message });
      return message;
    }
  } else {
    resetBareMetalStateRepairRetry(agent.id);
  }
  const command = effectiveMethod === 'claude_code_server' ? 'claude-bridge'
    : effectiveMethod === 'codex_app_server' ? 'codex-bridge'
    : effectiveMethod === 'openclaw_bridge' ? 'openclaw-bridge'
    : effectiveMethod === 'gemini_cli_server' ? 'gemini-bridge'
    : 'gateway';

  // Container agents: all listen on 8080 (each has a unique Docker IP).
  // Bare metal agents: use localPort from config (they share the host network).
  const isBareMetalAgent = normalizeRuntimeEnvironment(agent.runtimeEnvironment, 'bare_metal') === 'bare_metal';
  const listenPort = isBareMetalAgent ? String(agent.localPort ?? 8080) : '8080';

  const args = [
    command,
    '--agent-id', agent.id,
    '--agent-name', agent.name,
    '--agent-username', agent.username,
    '--port', listenPort,
  ];

  // gateway-only flags (use effectiveMethod — may have been switched from bridge to gateway)
  // grok_build uses the gateway runtime (Cortex SuperGrok), not a native CLI bridge.
  const effectiveBridgeMode = effectiveMethod !== 'shizuha' && effectiveMethod !== 'grok_build';
  if (!effectiveBridgeMode) {
    args.push('--mode', 'autonomous');
  }

  // Platform relay is handled by the daemon's runner proxy — individual agent
  // containers do NOT connect to platform directly. This was the old per-agent
  // connection model; the unified daemon proxy replaced it.

  if (!hasLocalConfig) {
    // No local config — fall back to platform configuration.
    // Resolve the effective chain (failoverChainId > modelFallbacks > default)
    // so the --model arg matches whatever the runtime-env chain says, not a
    // stale modelFallbacks snapshot.
    const primaryStep = resolvedPrimary ?? runtimeChain[0];
    if (primaryStep?.model) {
      args.push('--model', primaryStep.model);
    } else if (agent.modelOverrides) {
      // Legacy: single execution_method + model_overrides map
      const modelOverride = (agent.executionMethod ? agent.modelOverrides[agent.executionMethod] : '')
        || agent.modelOverrides['shizuha']
        || '';
      if (modelOverride) {
        args.push('--model', modelOverride);
      }
    }

    // Reasoning effort: effective-chain primary → method override → global → grok_build default low
    const globalSettings = loadGlobalSettings();
    const methodEffortKey = primaryMethod ? `${primaryMethod}_reasoning_effort` : '';
    const methodEffort = methodEffortKey && agent.modelOverrides
      ? agent.modelOverrides[methodEffortKey]
      : undefined;
    const effort = primaryStep?.reasoningEffort
      ?? methodEffort
      ?? globalSettings.reasoningEffort
      ?? (useGrokBuild ? 'low' : undefined);
    if (effort) {
      args.push('--effort', effort);
    }

    // Thinking level: effective-chain primary → global settings → omit
    // Only relevant for claude-bridge and gateway (Codex doesn't have a thinking flag)
    if (!useCodexBridge) {
      const thinking = primaryStep?.thinkingLevel ?? globalSettings.thinkingLevel;
      if (thinking) {
        args.push('--thinking', thinking);
      }
    }
  }

  // Toolset: restrict available tools for agents that don't need the full set.
  // Critical for local VL models (vLLM) where 140+ tool schemas exceed context limits.
  const toolset = (agent as any).toolset as string | undefined;
  if (toolset && toolset !== 'full') {
    args.push('--toolset', toolset);
    console.log(`[daemon] ${agent.name}: toolset=${toolset}`);
  }

  let k8sContextPrompt = agent.contextPrompt ?? '';

  if (effectiveBridgeMode) {
    let bridgeCustomPrompt: string | null = null;
    let bridgePromptSource: 'local-claude-md' | 'agent-context' | 'none' = 'none';
    if (hasLocalClaudeMd) {
      try {
        bridgeCustomPrompt = fs.readFileSync(path.join(agentDir, 'CLAUDE.md'), 'utf-8');
        bridgePromptSource = 'local-claude-md';
      } catch (err) {
        console.warn(`[daemon] ${agent.name}: failed to read local CLAUDE.md for bridge prompt: ${(err as Error).message}`);
      }
    } else {
      bridgeCustomPrompt = agent.contextPrompt ?? null;
      if (bridgeCustomPrompt) bridgePromptSource = 'agent-context';
    }
    // Starred skills: inject into agent's system prompt so they're always in context.
    //
    // - Claude Code agents: copy ALL starred skills to ~/.claude/skills/ for
    //   native auto-discovery + slash commands. ADDITIONALLY, any skill
    //   tagged `critical: true` in its frontmatter also gets its body inlined
    //   into --context-prompt. Native mount gives the agent name+description
    //   for free; critical-only inline guarantees correctness-critical
    //   skills (workflow state machines, heartbeat handling, org-context
    //   discipline) are actually read before action, not just advertised.
    //   Non-critical starred skills stay cheap (no extra context tokens).
    //
    // - Non-Claude bridge agents (Gemini, Codex, OpenClaw): inline CRITICAL
    //   starred skills only. Non-critical starred skills remain listed in the
    //   bridge identity prompt as auto-discoverable/on-demand catalog entries,
    //   but their bodies are loaded only when the task needs them. SCLI-219
    //   makes `critical`, not `starred`, the base-budget inline bit.
    //
    // - Gateway agents (shizuha, local models): same CRITICAL-only inline floor.
    //   Non-critical starred skills are still skipped to preserve tight context
    //   windows while keeping workflow/messaging/heartbeat discipline available
    //   to every backend before action.
    if (useClaudeBridge) {
      installStarredSkillsForClaudeCode(agent);
      const criticalSkillContent = loadStarredSkills(agent, { criticalOnly: true });
      if (criticalSkillContent) {
        bridgeCustomPrompt = (bridgeCustomPrompt ?? '') + '\n\n' + criticalSkillContent;
        console.log(`[daemon] ${agent.name}: inlined critical starred skills into Claude context prompt`);
      }
    } else {
      // Non-Claude bridges (Gemini, Codex, OpenClaw) and gateway fallback:
      // inline only critical bodies; non-critical starred skills stay
      // discoverable via the Skills catalog and load on demand.
      const criticalSkillContent = loadStarredSkills(agent, { criticalOnly: true });
      if (criticalSkillContent) {
        bridgeCustomPrompt = (bridgeCustomPrompt ?? '') + '\n\n' + criticalSkillContent;
        console.log(`[daemon] ${agent.name}: inlined critical starred skills into context prompt`);
      }
    }

    const bridgeIdentityPrompt = buildBridgeIdentityPrompt(agent, bridgeCustomPrompt);
    k8sContextPrompt = bridgeIdentityPrompt;
    console.log(
      `[daemon] ${agent.name}: bridge prompt source=${bridgePromptSource} summary=${JSON.stringify(summarizePromptForLog(bridgeIdentityPrompt))}`,
    );
    if (isBridgePromptDebugEnabled()) {
      console.log(`[daemon] ${agent.name}: bridge prompt begin\n${bridgeIdentityPrompt}\n[daemon] ${agent.name}: bridge prompt end`);
    }
    // The combined bridge prompt (universal + role skills + identity) can exceed the
    // OS single-arg limit (MAX_ARG_STRLEN ~128KB) → spawn E2BIG → the agent can't
    // start. Was codex-only after the 2026-06-27 outage (~20 codex agents at ~140KB;
    // "claude agents were unaffected only because their smaller prompts fit") — that
    // assumption expired 2026-07-03: Nova/Aoi (dual architecture+merge context) hit
    // ~130KB and could not start. BOTH bridges now read --context-prompt-file.
    // Fallback to the arg only if the write fails.
    try {
      const agentWorkspace = getAgentWorkspaceDir(agent);
      fs.mkdirSync(agentWorkspace, { recursive: true });
      fs.writeFileSync(path.join(agentWorkspace, '.bridge-context-prompt'), bridgeIdentityPrompt, { mode: 0o600 });
      args.push('--context-prompt-file', '/workspace/.bridge-context-prompt');
    } catch (err) {
      console.warn(`[daemon] ${agent.name}: context-prompt file write failed, using arg (E2BIG risk >128KB): ${(err as Error).message}`);
      args.push('--context-prompt', bridgeIdentityPrompt);
    }

  } else {
    // Gateway agents (shizuha/local models): no bridge-identity prompt —
    // context is too precious for local models. But critical starred skills
    // (workflow/messaging/heartbeat) apply to every agent on the platform
    // regardless of backend, so inline just those on top of whatever
    // contextPrompt the agent already has. Non-critical starred skills are
    // still skipped here — they remain discoverable via native SCLI skill tools.
    const base = !hasLocalClaudeMd ? (agent.contextPrompt ?? '') : '';
    const criticalSkillContent = loadStarredSkills(agent, { criticalOnly: true });
    const combined = [base, criticalSkillContent].filter(Boolean).join('\n\n');
    if (combined) {
      if (criticalSkillContent) {
        console.log(`[daemon] ${agent.name}: inlined critical starred skills into gateway context prompt`);
      }
      k8sContextPrompt = combined;
      args.push('--context-prompt', combined);
    }
  }

  // SCLI-331 boot-idempotency stays before credential/account resolution, but
  // only after the exact command/model/effort/composed-prompt inputs are known.
  // Hashing stored AgentInfo earlier can reuse stale runtime inputs and suppress
  // a real semantic update (PLAT-4546); local prompt construction is cheap and
  // avoids the Hive/shizuha-id startup stampede without creating a second hash
  // authority.
  if (shouldSpawnK8sAgent(agent) && !startOpts.imageOverride && !startOpts.brokerImageOverride) {
    const live = await getAgentK8sDeploymentStateAsync(agent);
    const healthy = !!live && (live.replicas ?? 0) > 0 && (live.readyReplicas ?? 0) > 0;
    const desiredHash = computeAgentMcpConfigHash(agent, {
      command,
      model: primaryModel ?? '',
      effort: resolvedPrimary?.reasoningEffort ?? loadGlobalSettings().reasoningEffort,
      contextPrompt: k8sContextPrompt,
    });
    if (healthy && !live?.duplicateEnvMetadata && live?.configHash && live.configHash === desiredHash) {
      console.log(
        `[daemon] ${agent.name}: k8s Deployment already healthy + config-hash matches (${desiredHash}); ` +
        'skipping credential resolution and re-apply (SCLI-331 boot-idempotent)',
      );
      updateAgentInMemory(agent.id, { status: 'running', enabled: true, pid: undefined });
      return undefined;
    }
  }

  const requestedRuntime = normalizeRuntimeEnvironment(agent.runtimeEnvironment, 'bare_metal');
  const k8sUnsupportedReason = isK8sAgent(agent) ? explainK8sUnsupportedRuntime(agent) : null;
  let runtime = requestedRuntime;
  if (k8sUnsupportedReason) {
    runtime = 'container';
    console.warn(
      `[daemon] ${agent.name}: k8s-native runtime is incompatible with privileged effective capabilities — ` +
      `${k8sUnsupportedReason}; falling back to daemon-owned container runtime (PLAT-3366).`,
    );
    if (agent.runtimeEnvironment === 'k8s') {
      updateAgentConfig(agent.id, { runtimeEnvironment: 'container' });
      agent.runtimeEnvironment = 'container';
    }
    try {
      stopAgentK8s({ ...agent, runtimeEnvironment: 'k8s' });
    } catch (err) {
      const message = (err as Error).message;
      updateAgentInMemory(agent.id, { status: 'error', error: `k8s privileged-runtime fallback stop failed: ${message}` });
      return `k8s privileged-runtime fallback stop failed: ${message}`;
    }
  }
  console.log(`[daemon] Starting ${agent.name} (runtime: ${runtime})...`);

  // Build credential env vars from agent credentials
  const credentialEnv: Record<string, string> = {};

  // Inject platform service URLs from daemon environment
  const searchUrl = process.env['SEARCH_BASE_URL'];
  if (searchUrl) credentialEnv['SEARCH_BASE_URL'] = searchUrl;

  // Inject daemon's admin token so agents can obtain service tokens from Shizuha ID
  let daemonAdminToken = process.env['SHIZUHA_ACCESS_TOKEN'] || '';
  if (!daemonAdminToken) {
    // PLAT-881: read the daemon's own Shizuha ID token from auth.json, refreshing
    // it in place if it is expired/near-expiry. Previously this read auth.accessToken
    // verbatim with no expiry check, so the daemon's admin token silently aged out
    // (~7.5d on 2026-06-26) → approve/set-password reconcile 401'd → no agent could
    // provision an identity. refreshDaemonAdminToken refreshes + persists owner-scoped.
    try {
      const { refreshDaemonAdminToken } = require('./agent-accounts.js') as typeof import('./agent-accounts.js');
      const platformUrlForRefresh = resolvePlatformUrl();
      daemonAdminToken = (await refreshDaemonAdminToken({ platformUrl: platformUrlForRefresh })) || '';
    } catch { /* fall through to legacy read below */ }
    if (!daemonAdminToken) {
      // Fallback: legacy verbatim read (e.g. refresh path unavailable in headless dev).
      try {
        const authFile = path.join(process.env['HOME'] ?? '~', '.shizuha', 'auth.json');
        if (fs.existsSync(authFile)) {
          const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
          daemonAdminToken = auth.accessToken || '';
        }
      } catch { /* ignore */ }
    }
  }
  // SECURITY: do NOT inject DAEMON_ADMIN_TOKEN into agent containers. The admin
  // token can reset ANY user's password — giving it to every agent runtime is a
  // privilege-escalation risk. The DAEMON (trusted control plane) keeps it below
  // to provision/reconcile each agent's account; the runtime only ever gets its
  // OWN credential (AGENT_PASSWORD + AGENT_ACCESS_TOKEN). Drift recovery is
  // owner-scoped, not agent-self via admin.

  // Provision agent's own Shizuha ID account and obtain JWT
  const platformUrl = resolvePlatformUrl();
  console.log(`[daemon] ${agent.name}: account provisioning check: adminToken=${!!daemonAdminToken} platformUrl=${platformUrl}`);
  if (daemonAdminToken && platformUrl && platformUrl !== 'http://localhost' && !platformUrl.includes('127.0.0.1')) {
    try {
      const { ensureAgentAccount } = require('./agent-accounts.js') as typeof import('./agent-accounts.js');
      // (b) Harden provisioning: shizuha-id can be transiently unreachable at
      // spawn (e.g. mid cluster-restart). Retry with backoff so an id blip never
      // leaves the agent un-provisioned (no AGENT_USER_ID + drifted password) —
      // the exact failure that stranded the fleet on 2026-06-21.
      const { isDaemonAdminFamilyDead, hasFleetProvisionerToken } = require('./agent-accounts.js') as typeof import('./agent-accounts.js');
      let agentAccount = null;
      // SCLI-205: if an earlier spawn already found the admin token FAMILY dead
      // (refresh also revoked, unrecoverable via refresh), skip provisioning
      // entirely — every set-password would 401 and storm shizuha-id. Fail loud;
      // the agent uses its per-agent id-login fallback (SCLI-201) and provisioning
      // resumes automatically once a fresh admin credential lands (approach A).
      // PLAT-3997: only skip when the admin family is dead AND there is no static
      // fleet-provisioner token. With that token, reconciliation runs via the
      // least-privilege /provision-agent/ endpoint (a different auth path that
      // won't 401-storm shizuha-id), so it must still run — otherwise the k8s
      // Secret's AGENT_PASSWORD ships un-synced to the account → login drift.
      if (isDaemonAdminFamilyDead() && !hasFleetProvisionerToken()) {
        console.error(`[daemon] ${agent.name}: SKIP provisioning — daemon admin token family is dead (SCLI-205) and no fleet-provisioner token to reconcile via the static path; using id-login fallback until a fresh admin credential is provisioned`);
      } else
      for (let attempt = 1; attempt <= 5; attempt++) {
        agentAccount = await ensureAgentAccount({
          agentUsername: agent.username,
          agentEmail: agent.email ?? `${agent.username}@agents.shizuha.io`,
          agentFirstName: agent.name,
          agentLastName: '(AI Agent)',
          agentRuntimeId: agent.id,
          platformUrl,
          adminToken: daemonAdminToken,
          canonicalPassword: resolveAgentPassword(agent),
          persistCanonicalPassword: (password: string) => persistCanonicalAgentPassword(agent, password),
          // SCLI-202: if the daemon's admin access token is revoked mid-fleet
          // (an earlier set-password invalidated it), force-refresh it via the
          // surviving refresh token so approve/set-password self-heals and the
          // rest of the fleet still reconciles instead of cascade-failing.
          remintAdminToken: () => {
            const { refreshDaemonAdminToken } = require('./agent-accounts.js') as typeof import('./agent-accounts.js');
            return refreshDaemonAdminToken({ platformUrl, force: true });
          },
        });
        if (agentAccount) break;
        // SCLI-205: admin token family died mid-attempt (refresh also revoked) —
        // retrying just storms shizuha-id. Stop now; id-login fallback (SCLI-201)
        // carries the agent until a fresh admin credential is provisioned.
        // PLAT-3997: stop retrying only when there is also no fleet-provisioner
        // token — with it, the fleet endpoint reconciles via the static token and
        // is worth retrying (bounded backoff, no admin-JWT 401-storm).
        if (isDaemonAdminFamilyDead() && !hasFleetProvisionerToken()) {
          console.error(`[daemon] ${agent.name}: admin token family dead (SCLI-205) and no fleet-provisioner token — stopping provisioning retries; using id-login fallback`);
          break;
        }
        if (attempt < 5) {
          const delay = Math.min(2000 * attempt, 10000);
          console.warn(`[daemon] ${agent.name}: account provisioning attempt ${attempt} failed (shizuha-id unreachable?) — retry in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (!agentAccount) {
        console.error(`[daemon] ${agent.name}: ERROR account provisioning failed after retries — agent starts WITHOUT platform identity (deliberate: it can still work and even fix shizuha-id); periodic reconcile will repair the account so the runtime's on-demand login recovers without a restart.`);
        notePendingAccountReconcile(agent);
        void sendAgentAccountReconcileFailureAndon({
          agent,
          platformUrl,
          reason: 'account_provisioning_failed_after_retries',
          detail: 'ensureAgentAccount returned null after bounded startup retries; AGENT_ACCESS_TOKEN/AGENT_USER_ID will not be injected.',
        }).then((sendResult) => {
          if (sendResult.sent || sendResult.rateLimited) return;
          console.error(`[daemon] ${agent.name}: account reconcile ANDON DM failed: ${sendResult.error || 'unknown error'}`);
        });
      }
      if (agentAccount) {
        pendingAccountReconciles.delete(agent.id);
        credentialEnv['AGENT_ACCESS_TOKEN'] = agentAccount.accessToken;
        credentialEnv['AGENT_USER_ID'] = String(agentAccount.userId);
        // Pass the canonical broker-scoped shizuha-id credential so Connect can
        // authenticate. Do not re-read #1 agent-auth as an independent source;
        // PLAT-558 collapses container-side password consumers to #2.
        const resolvedPassword = resolveAgentPassword(agent);
        if (resolvedPassword) credentialEnv['AGENT_PASSWORD'] = resolvedPassword;
        console.log(`[daemon] ${agent.name}: platform account ready (user_id=${agentAccount.userId})`);
      }
    } catch (err) {
      console.error(`[daemon] ${agent.name}: agent account provisioning error:`, (err as Error).message, (err as Error).stack?.split('\n')[1]);
      notePendingAccountReconcile(agent);
      void sendAgentAccountReconcileFailureAndon({
        agent,
        platformUrl,
        reason: 'account_provisioning_exception',
        detail: (err as Error).message,
      }).then((sendResult) => {
        if (sendResult.sent || sendResult.rateLimited) return;
        console.error(`[daemon] ${agent.name}: account reconcile ANDON DM failed: ${sendResult.error || 'unknown error'}`);
      });
    }
  } else {
    console.log(`[daemon] ${agent.name}: skipping account provisioning (conditions not met)`);
  }

  if (agent.credentials?.length) {
    for (const cred of agent.credentials) {
      let normalizedCred = cred;
      try {
        normalizedCred = normalizeAgentCredential(cred, agent);
      } catch (err) {
        logger.warn(
          { agentId: agent.id, credentialId: cred.id, err },
          'Refusing AgentCredential with unknown or reserved scope',
        );
        continue;
      }
      if (!isAgentCredentialGrantCurrentlyActive(normalizedCred) || !normalizedCred.injectAsEnv) continue;
      if (normalizedCred.envMapping) {
        // Explicit mapping: credentialData key → env var name
        for (const [dataKey, envName] of Object.entries(normalizedCred.envMapping)) {
          const val = normalizedCred.credentialData[dataKey];
          injectAgentCredentialEnvValue(
            agent,
            credentialEnv,
            envName,
            val,
            `AgentCredential ${normalizedCred.scope ?? normalizedCred.service ?? normalizedCred.id}.${dataKey} -> ${envName}`,
          );
        }
      } else {
        // Default: inject credentialData keys as env vars directly (uppercased)
        for (const [key, val] of Object.entries(normalizedCred.credentialData)) {
          const envName = key.toUpperCase();
          injectAgentCredentialEnvValue(
            agent,
            credentialEnv,
            envName,
            val,
            `AgentCredential ${normalizedCred.scope ?? normalizedCred.service ?? normalizedCred.id}.${key} -> ${envName}`,
          );
        }
      }
    }
  }

  // For claude_code_server agents: inject Claude OAuth token so Claude Code inside
  // the container can authenticate. The container doesn't have access to ~/.claude/.credentials.json
  // because ~/.shizuha/claude-sessions/ is mounted over /home/agent/.claude/.
  // Only the runtime-selected Claude bridge needs the Claude OAuth token.
  //
  // HIVE-146: when a coordinator is configured (MCP_AUTH_PROXY_COORDINATOR_URL in daemon env),
  // the bridge fetches the model token from the broker UDS (GET /model-token) instead of a
  // baked env var — so we skip this injection and set the fail-closed flag instead.
  // Without a coordinator (headless dev), keep the existing static token path.
  const needsClaudeToken = useClaudeBridge;
  const coordinatorConfigured = !!process.env['MCP_AUTH_PROXY_COORDINATOR_URL'];
  const useHiveCodexBroker = shouldUseCodexBroker(useCodexBridge, coordinatorConfigured);
  if (needsClaudeToken && !credentialEnv['CLAUDE_CODE_OAUTH_TOKEN'] && !coordinatorConfigured) {
    try {
      // Build live-count map from in-memory agent state so the picker can
      // choose the least-loaded token instead of a random one (SCLI-77).
      const activeTokenCounts = new Map<string, number>();
      for (const a of inMemoryState?.agents ?? []) {
        if ((a.status === 'running' || a.status === 'starting') && a.oauthTokenLabel) {
          activeTokenCounts.set(a.oauthTokenLabel, (activeTokenCounts.get(a.oauthTokenLabel) ?? 0) + 1);
        }
      }
      const picked = getActiveClaudeToken(undefined, activeTokenCounts);
      if (picked) {
        credentialEnv['CLAUDE_CODE_OAUTH_TOKEN'] = picked.token;
        console.log(`[daemon] ${agent.name}: injecting Claude OAuth token (${picked.label})`);
        updateAgentInMemory(agent.id, { oauthTokenLabel: picked.label });
      } else {
        // No active token available — don't start the agent, mark as auth error
        // so the dashboard shows the token input card immediately
        console.warn(`[daemon] ${agent.name}: no active Claude OAuth token found — skipping start`);
        updateAgentInMemory(agent.id, {
          status: 'error',
          error: 'no active Claude OAuth token found',
        });
        return 'no active Claude OAuth token found';
      }
    } catch (e) {
      console.error(`[daemon] ${agent.name}: failed to discover Claude tokens: ${(e as Error).message}`);
    }
  } else if (needsClaudeToken && coordinatorConfigured) {
    // Broker mode: bridge fetches token from UDS; fail closed so it never falls back
    // to a stale baked token (ren P1 / HIVE-125).
    credentialEnv['CLAUDE_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'] = '1';
    console.log(`[daemon] ${agent.name}: coordinator configured — bridge will source model token from broker UDS (fail-closed)`);
  }

  if (useCodexBridge && coordinatorConfigured) {
    // Match Claude broker semantics: Codex must source OpenAI OAuth from the
    // coordinator pool and report rate-limit cooldowns against the leased entry.
    // Falling back to shared auth.json masks per-account quota exhaustion as
    // "Alive" while the agent cannot work.
    credentialEnv['CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'] = '1';
    console.log(`[daemon] ${agent.name}: coordinator configured — Codex bridge will source OpenAI token from broker UDS (fail-closed)`);
  }

  // Standalone/headless mode still uses the user's local Codex auth. In fleet
  // mode Hive is authoritative, so do not read or seed host credentials.
  const needsCodexAuth = useCodexBridge || useOpenClawBridge;
  if (needsCodexAuth && !coordinatorConfigured) {
    const home = process.env['HOME'] ?? '~';
    const codexAuthFile = path.join(home, '.codex', 'auth.json');
    const sharedAuthFile = path.join(home, '.shizuha', 'codex-auth', 'auth.json');
    let hasCodexAuth = fs.existsSync(codexAuthFile) || fs.existsSync(sharedAuthFile);

    // Seed ~/.codex/auth.json from credential store if it has a codex account
    if (!hasCodexAuth) {
      try {
        const accounts = readCodexAccounts();
        if (accounts.length > 0) {
          const account = accounts[0]!;
          const codexDir = path.join(home, '.codex');
          ensurePrivateDir(codexDir, true);
          const authData = {
            auth_mode: 'chatgpt' as const,
            tokens: {
              access_token: account.accessToken,
              refresh_token: account.refreshToken,
              account_id: account.accountId,
              ...(account.idToken ? { id_token: account.idToken } : {}),
            },
          };
          fs.writeFileSync(codexAuthFile, JSON.stringify(authData, null, 2), { mode: 0o600 });
          console.log(`[daemon] ${agent.name}: seeded ~/.codex/auth.json from credential store (${account.email})`);
          hasCodexAuth = true;
        }
      } catch { /* ignore — credential store may not have codex accounts */ }
    }

    if (!hasCodexAuth) {
      console.warn(`[daemon] ${agent.name}: no Codex auth found — skipping start (run: shizuha auth codex)`);
      updateAgentInMemory(agent.id, {
        status: 'error',
        error: 'Codex not authenticated. Run: shizuha auth codex',
      });
      return 'Codex not authenticated';
    }
  }

  // Bootstrap the agent into the daemon's mini-Connect (idempotent). When
  // BACKEND_URL points at the daemon, the agent will self-authenticate against
  // mini-id with these credentials. When BACKEND_URL points at the real
  // platform, this user just sits unused — harmless overhead.
  if (miniConnectAuth) {
    try {
      miniConnectAuth.ensureAgentUser({
        username: agent.username,
        agentId: agent.id,
        email: agent.email ?? `${agent.username}@shizuha.com`,
        displayName: agent.name,
        password: resolveAgentPassword(agent),
      });
    } catch (err) {
      logger.warn(
        { agent: agent.username, err: (err as Error).message },
        'Failed to bootstrap agent in mini-Connect (non-fatal — real Connect path still works)',
      );
    }
  }

  const runtimeEnv = scrubAgentRuntimeEnvForCredentialInjection(agent, resolveAgentRuntimeEnv(agent, runtime));
  const launchCredentialEnv = scrubAgentCredentialBrokerReservedEnv(credentialEnv);

  // P2 (k3s-native backend): instead of `docker run`, render+apply a per-agent
  // Deployment (broker sidecar + bridge + dind + workspace PVC) and let k8s own
  // the pod lifecycle. Do this after credential/account resolution so the k8s
  // Secret uses the same AGENT_PASSWORD/GITHUB_TOKEN values as container launches.
  if (shouldSpawnK8sAgent(agent)) {
    let fleetSshFiles: Record<string, string> | undefined;
    if (requiresFleetSshForK8sAgent(agent)) {
      // The Docker path stages this grant immediately before docker run.  K8s
      // pods need the same daemon-owned source material copied into a Secret;
      // otherwise a pod replacement silently loses host-plane access.
      const beforeFleetSshCreds = JSON.stringify(agent.credentials ?? null);
      agent.credentials = materializeMissingFleetSshCredentialGrantFromLegacySshKeys(agent);
      if (JSON.stringify(agent.credentials ?? null) !== beforeFleetSshCreds) {
        updateAgentConfig(agent.id, { credentials: agent.credentials });
      }

      const fleetSshRead = resolveFleetSshCredentialGrant(agent);
      for (const refusal of fleetSshRead.refusals) emitAgentCredentialScopeAlert(agent, refusal);
      const shizuhaHome = process.env['HOME'] ?? path.resolve(os.homedir());
      const fleetSshStage = fleetSshRead.grant
        ? stageFleetSshCredentialGrant({
            agent,
            grant: fleetSshRead.grant,
            shizuhaHome,
            recordAuditEvent: createCredentialAuditLogger(credentialAuditLogPath()),
            expandHomePath: expandDaemonHomePath,
          })
        : null;

      if (fleetSshStage) {
        fleetSshFiles = Object.fromEntries(
          fs.readdirSync(fleetSshStage.sshStageDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /^[A-Za-z0-9._-]+$/.test(entry.name))
            .map((entry) => [entry.name, fs.readFileSync(path.join(fleetSshStage.sshStageDir, entry.name), 'utf8')]),
        );
      }

      // Host-plane pods fail closed.  Starting a replacement without its SSH
      // Secret would recreate the exact PLAT-177/PLAT-3412 access outage.
      const missingFleetSsh = missingRequiredFleetSshReason(agent, fleetSshFiles);
      if (missingFleetSsh) {
        const reason = fleetSshRead.grant
          ? 'fleet-ssh grant resolved but staging found no key files (per-agent store empty/unmounted)'
          : `no fleet-ssh grant resolved: ${missingFleetSsh}`;
        logger.error(
          { agentId: agent.id, agentUsername: agent.username, scope: 'fleet-ssh', reason },
          'PLAT-3412: refusing to apply host-plane k8s pod without fleet-ssh material',
        );
        return `Host-plane k8s runtime requires fleet-ssh: ${reason}`;
      }
    }

    if (isPrivilegedK8sAgent(agent)) {
      console.log(`[daemon] ${agent.name}: rendering privileged k8s ServiceAccount/RBAC identity`);
    }
    spawnAgentK8s(agent, {
      command,
      model: primaryModel ?? '',
      effort: resolvedPrimary?.reasoningEffort ?? loadGlobalSettings().reasoningEffort,
      contextPrompt: k8sContextPrompt,
      password: resolveK8sSpawnPassword(agent, launchCredentialEnv),
      githubToken: launchCredentialEnv['GITHUB_TOKEN'] ?? runtimeEnv['GITHUB_TOKEN'],
      // SCLI-331: unset on ordinary applies (spawnAgentK8s preserves the live
      // image); the idle-gated roller passes the desired image to roll one agent.
      ...(startOpts.imageOverride ? { imageOverride: startOpts.imageOverride } : {}),
      ...(startOpts.brokerImageOverride ? { brokerImageOverride: startOpts.brokerImageOverride } : {}),
      fleetSshFiles,
    });
    // PLAT-5120: spawnAgentK8s has synchronously applied the Deployment.  Keep
    // this daemon-owned intent across the Recreate pod bootstrap window; the
    // controller's Progressing reason is not reliable for ordinary config
    // refreshes and otherwise the credential probe false-pages before exec.
    noteK8sDaemonApply(agent.id);
    updateAgentInMemory(agent.id, { status: 'running', enabled: true, pid: undefined });
    // startAgentProcess returns an ERROR string (undefined = success). The k8s
    // Deployment is applied + k8s owns the pod lifecycle — there is no host child
    // process for the daemon to track, so return success and skip the docker path.
    return undefined;
  }

  // Host-local process spawn is retired on k3s fleet hosts. If we reached this
  // branch (not isK8sAgent), refuse bare_metal/docker child spawn when the
  // retirement marker is present unless break-glass is set. Prevents dual-spawn
  // ghosts (e.g. Fumi host gateway under owner JWT) after accidental `shizuha up`.
  {
    const retiredMarker = path.join(process.env['HOME'] ?? os.homedir(), '.shizuha', 'LEGACY_LOCAL_DAEMON_RETIRED');
    const allowLocal = process.env['SHIZUHA_ALLOW_LOCAL_DAEMON'] === '1';
    if (fs.existsSync(retiredMarker) && !allowLocal) {
      const msg =
        `refusing host-local spawn for ${agent.name ?? agent.id} ` +
        `(runtime=${runtime}): local daemon retired; fleet agents are k3s-only. ` +
        `See ${retiredMarker}`;
      console.error(`[daemon] ${msg}`);
      updateAgentInMemory(agent.id, { status: 'error', error: msg });
      return msg;
    }
  }

  const credentialBrokerPlan = planAgentCredentialBrokerSockets(agent, {
    socketExists: (socketPath) => {
      try {
        return fs.statSync(socketPath).isSocket();
      } catch {
        return false;
      }
    },
  });
  const agentEnv: NodeJS.ProcessEnv = {
    ...scrubAgentCredentialBrokerReservedEnv(process.env),
    // Runner proxy in daemon handles platform relay — don't let agents connect directly
    SHIZUHA_AGENT_TOKEN: '',
    AGENT_ID: agent.id,
    AGENT_USERNAME: agent.username,
    // SCLI-44: role drives the runtime MCP-server allow-list (resolveAllowedServers).
    ...(agent.role ? { AGENT_ROLE: agent.role } : {}),
    // Capability tags (skills[]) ALSO drive the MCP allow-list — unioned with role
    // (operator 2026-06-24). Comma-joined; the bridge splits + passes to resolveAllowedServers.
    ...(agent.skills?.length ? { AGENT_SKILLS: agent.skills.join(',') } : {}),
    // PLAT-465: team drives role/team-targeted skill loading (buildCatalog).
    ...(agent.team ? { AGENT_TEAM: agent.team } : {}),
    DAEMON_HOST: resolveBareMetalDaemonHost(), // bare_metal — daemon is local
    // Plain HTTP daemon port: 8016 when TLS is enabled, else 8015.
    DAEMON_PORT: resolveDaemonHttpPort(),
    // Mirror BACKEND_URL into bare-metal agents too. For containers this is
    // injected into the docker run env list further down.
    BACKEND_URL: resolveBareMetalBackendUrl(),
    // SCLI-102: Codex broker mode. Bare-metal agents reach the daemon on its
    // local bind host; container agents get the Docker host alias below.
    ...(useHiveCodexBroker ? { CODEX_BROKER_URL: resolveBareMetalCodexBrokerUrl() } : {}),
    ...launchCredentialEnv,
    ...(() => {
      const chain = resolveRuntimeChain(agent);
      return chain.length ? { SHIZUHA_MODEL_FALLBACKS: JSON.stringify(chain) } : {};
    })(),
    // Inject custom env vars from agents.json (e.g., VLLM_BASE_URL for vLLM-backed agents).
    // AgentCredential broker env names are reserved and scrubbed above; they are
    // re-added only from the daemon's broker socket plan below.
    ...runtimeEnv,
    // PLAT-1092: Hive effective-capability diagnostics + authoritative MCP allow-list.
    // Apply after custom env so agents.json cannot spoof or widen the daemon-applied desired state.
    ...agentEffectiveCapabilityEnv(agent),
    ...credentialBrokerPlan.env,
  };

  let child: ChildProcess;

  if (runtime === 'container' || runtime === 'restricted_container' || runtime === 'sandbox') {
    // ── Container mode: spawn inside Docker ──
    const containerName = `shizuha-agent-${agent.username}`;
    const shizuhaDir = path.dirname(shizuhaJs); // dir containing shizuha.js
    const shizuhaRoot = path.dirname(shizuhaDir); // project root (parent of dist/)
    const shizuhaBundleDir = shizuhaDir;
    const shizuhaPackageJson = [
      path.join(shizuhaBundleDir, 'package.json'),
      path.join(shizuhaRoot, 'package.json'),
    ].find((candidate) => fs.existsSync(candidate));
    const shizuhaHome = process.env['HOME'] ?? path.resolve(os.homedir());
    const port = String(agent.localPort ?? 0);
    const containerShizuha = '/opt/shizuha';

    // Resolve the agent's Shizuha ID identity (for MCP token — real user_id, staff, superuser)
    const agentIdentity = await resolveAgentIdentity(agent);
    // ADR-0004 phase 2 — assert the identity-guarantee invariant at spawn (flag mode: log, don't block)
    logAgentIdentityHealth(agent.name, agent.username, agentIdentity);

    // ── Resolve Docker-in-Docker mode ──
    // Sysbox: best isolation (nested Docker with overlay2, no --privileged)
    // Privileged: DinD with --privileged (overlay2 works, less isolated)
    // None: no inner Docker daemon (Ubuntu agent image or node:22 fallback)
    const [dindEnabled, dindMode] = resolveDindMode();
    const useDind = dindEnabled && runtime === 'container'; // DinD only for standard container, not restricted/sandbox
    const hasDindImage = useDind ? ensureDindImage() : false;
    const useNonDindNumericUser = !(useDind && hasDindImage) && runtime === 'sandbox';

    // Image priority: DinD image > shizuha-agent-runtime (Ubuntu) > node:22 (Debian, fallback)
    // node:22 is the full Debian bookworm image (not slim) — includes ca-certificates, git, etc.
    let containerImage: string;
    if (hasDindImage) {
      containerImage = DIND_IMAGE;
    } else {
      const hasAgentImage = ensureAgentImage();
      containerImage = hasAgentImage ? AGENT_IMAGE : 'node:22';
    }

    if (useDind && hasDindImage) {
      console.log(`[daemon] ${agent.name}: DinD mode=${dindMode} (image=${containerImage})`);
    } else {
      console.log(`[daemon] ${agent.name}: image=${containerImage}`);
    }

    // Keep credential-bearing environment out of `docker run` argv. Docker
    // exposes argv to host process listings; `--env-file` shows only this
    // private file path while Docker still injects the variables into the
    // container environment.
    const privateDockerEnvPlan = preparePrivateDockerEnv(shizuhaHome, agent.username, {
      AGENT_PASSWORD: resolveAgentPassword(agent),
      ...runtimeEnv,
      ...launchCredentialEnv,
    });
    const dockerEnv = (key: string, value: string | number | boolean | undefined | null): string[] => (
      value == null || privateDockerEnvPlan.privateKeys.has(key) ? [] : ['-e', `${key}=${value}`]
    );
    const dockerEnvOverride = (key: string, value: string | number | boolean | undefined | null): string[] => {
      if (value == null) return [];
      return ['-e', `${key}=${value}`];
    };

    const dockerArgs = [
      'run', '--rm',
      '--name', containerName,
      // User-defined network gives Docker's internal DNS (127.0.0.11) which
      // resolves Tailscale hostnames, compose service names, and external domains.
      // Default bridge network doesn't get this — it uses host's legacy resolv.conf.
      '--network', ensureAgentNetwork(),
      // A daemon running in k3s has CoreDNS in its own resolv.conf, but nested
      // host-Docker containers do not inherit that upstream automatically.
      ...resolveAgentDockerDnsArgs(),
      '--add-host', `host.docker.internal:${resolveHostGateway()}`,
      // Disable IPv6 inside container — many Docker networks lack IPv6 connectivity
      // but DNS returns AAAA records first, causing Rust HTTP clients (e.g. Codex CLI)
      // to fail without falling back to IPv4.
      '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
      // Force chatgpt.com to resolve via IPv4 — the Codex CLI's Rust HTTP client
      // doesn't fall back from IPv6 to IPv4, so we pin the DNS via /etc/hosts.
      ...resolveHostsIPv4(['chatgpt.com', 'api.openai.com']),
      // Pin github.com to a reachable IP; probes candidates at startup (PLAT-399).
      ...resolveGitHubHostOverride(),
      // No host port publish — daemon connects via Docker network IP (getContainerUrl).
      // Eliminates port conflicts entirely on daemon restart.
      // Chrome needs large /dev/shm for shared memory (default 64MB causes crashes)
      '--shm-size', '2g',
      // Hard memory cap: a single agent running a heavy build/benchmark must not
      // be able to exhaust host RAM (2026-06-12 incident: ~130GB anon allocation
      // froze s1 before the kernel OOM killer could act — required a physical reset).
      '--memory', '24g',
      '--memory-swap', '24g',
      // Mount only the bundled binary directory. In dev layout this is
      // repo/dist/; in installed layout it is ~/.shizuha/lib/. The runtime
      // dependency tree (node_modules/) is BAKED INTO THE IMAGE (v24+), never
      // bind-mounted — each agent owns its own immutable deps. The dev source
      // tree (src/, docs/, design notes, .git, uncommitted work) never reaches
      // the container. esbuild marks pino/better-sqlite3/ws/@modelcontextprotocol
      // /sdk/openai/@anthropic-ai/sdk/etc as `external` (see esbuild.config.js);
      // those are provided by the image's baked /opt/shizuha/node_modules.
      //
      // Confidentiality + clarity guardrail — do NOT replace this with
      // `${shizuhaRoot}:${containerShizuha}:ro`, even "temporarily."
      // If new code needs to reach agents, rebuild dist/ and the existing
      // dist mount picks it up; do not widen the mount surface.
      '-v', `${shizuhaBundleDir}:${containerShizuha}/dist:ro`,
      // NOTE: node_modules is NO LONGER bind-mounted from the host. The DinD
      // image (v24+) bakes its own node_modules (npm ci, see DIND_DOCKERFILE).
      // A shared host node_modules was a single point of corruption — one bad
      // host `npm install` broke every agent at once (2026-06-17 better-sqlite3
      // incident). Each container now owns immutable deps; do NOT re-add the mount.
      ...(shizuhaPackageJson ? ['-v', `${shizuhaPackageJson}:${containerShizuha}/package.json:ro`] : []),
      ...(privateDockerEnvPlan.privateEnvJsonFile && privateDockerEnvPlan.privateEnvJsonContainerPath
        ? ['-v', `${privateDockerEnvPlan.privateEnvJsonFile}:${privateDockerEnvPlan.privateEnvJsonContainerPath}:ro`]
        : []),
      // Writable workspace
      '-v', `${shizuhaHome}/.shizuha/workspaces/${agent.username}:/workspace`,
      // Persistent Claude Code session storage (transcripts survive container restarts)
      '-v', `${shizuhaHome}/.shizuha/claude-sessions/${agent.username}:/home/agent/.claude`,
      // Mount agent config dir in both legacy (/root) and runtime HOME (/home/agent)
      // locations. Runtime code must use /home/agent (writable to uid 1000);
      // /root is retained only for legacy read-only consumers.
      ...(() => {
        try { fs.mkdirSync(agentDir, { recursive: true }); } catch { /* best-effort */ }
        return [
          '-v', `${agentDir}:/root/.shizuha/agents/${agent.username}`,
          '-v', `${agentDir}:/home/agent/.shizuha/agents/${agent.username}`,
        ];
      })(),
      // Mount skills repo for native provider/SCLI skill discovery (read-only)
      // Use /opt/skills (NOT /opt/shizuha/skills) to avoid conflict with :ro parent mount
      ...(fs.existsSync(path.join(shizuhaHome, '.shizuha', 'skills'))
        ? ['-v', `${shizuhaHome}/.shizuha/skills:/opt/skills:ro`] : []),
      // Mount agent templates repo for search_templates/use_template (read-only)
      ...(fs.existsSync(path.join(shizuhaHome, '.shizuha', 'templates'))
        ? ['-v', `${shizuhaHome}/.shizuha/templates:/opt/templates:ro`] : []),
      // Mount plugins directory (read-only — plugins can write to workspace, not plugin dir)
      ...(fs.existsSync(path.join(shizuhaHome, '.shizuha', 'plugins'))
        ? ['-v', `${shizuhaHome}/.shizuha/plugins:/root/.shizuha/plugins:ro`] : []),
      // Standalone/headless compatibility only. Coordinator-backed fleet agents
      // receive credentials through the broker and must never be able to read the
      // host credential store, even if bridge logic would ignore it.
      ...(!coordinatorConfigured && fs.existsSync(path.join(shizuhaHome, '.shizuha', 'credentials.json'))
        ? ['-v', `${shizuhaHome}/.shizuha/credentials.json:/root/.shizuha/credentials.json:ro`] : []),
      // Coordinator model-token broker socket. Claude uses this for Anthropic
      // OAuth tokens; Codex uses the same endpoint with provider=openai so
      // codex_app_server can draw a leased shared credential instead of a
      // per-container baked auth copy.
      ...(() => {
        if (!coordinatorConfigured || !(useClaudeBridge || useCodexBridge)) return [];
        const hostBrokerSocket = path.join(shizuhaHome, '.shizuha', 'mcp-auth-proxy', 'proxy.sock');
        if (!fs.existsSync(hostBrokerSocket)) return [];
        return ['-v', `${hostBrokerSocket}:/run/shizuha/mcp-auth-proxy/proxy.sock`];
      })(),
      // Mount settings.json — DinD entrypoint reads registryMirrors from it at startup
      ...(fs.existsSync(path.join(shizuhaHome, '.shizuha', 'settings.json'))
        ? ['-v', `${shizuhaHome}/.shizuha/settings.json:/root/.shizuha/settings.json:ro`] : []),
      // Persistent bridge log dir: bridge stdout/stderr are teed here so they
      // survive --rm container removal. Created eagerly so Docker binds the dir
      // with correct host ownership (not root-owned Docker tmpfs).
      '-v', `${bridgeLogDir()}:/var/log/shizuha/bridges`,
      // Codex home: coordinator mode is fully per-agent and contains only the
      // access-only broker cache. Standalone mode retains the legacy shared login
      // directory while keeping identity/transcript state per-agent.
      //
      // The shared `codex-auth/` dir is mounted at .codex so the single shared
      // auth.json refreshes in place — Codex rewrites auth.json via atomic
      // rename-replace, which only works when its *directory* is the bind mount
      // (a single-file auth.json mount breaks on rename: EXDEV / container-local
      // inode that never propagates). The read-before-refresh guard then prevents
      // token races across containers.
      //
      // On TOP of that we overlay per-agent mounts for the parts that must NOT be
      // shared. Docker resolves the more-specific destination, so these become
      // per-agent while auth.json stays shared:
      //   - config.toml  → carries THIS agent's Pulse/MCP JWT. A shared config.toml
      //     made every codex agent authenticate as whoever wrote it last (all as
      //     `aoi`), so heartbeats served one agent's queue to the whole fleet.
      //     Safe as a single-FILE mount: only our bridge writes it, in place
      //     (fs.writeFileSync, no rename), and Codex treats it as read-only.
      //   - sessions/ shell_snapshots/ log/ → private transcripts (PLAT-86:
      //     cross-container session-transcript exposure).
      ...(() => {
        // Per-agent CODEX_HOME parts (keyed by username, mode 0700).
        const agentCodexDir = path.join(shizuhaHome, '.shizuha', 'codex-home', agent.username);
        const perAgentSessions = path.join(agentCodexDir, 'sessions');
        const perAgentSnapshots = path.join(agentCodexDir, 'shell_snapshots');
        const perAgentLog = path.join(agentCodexDir, 'log');
        const perAgentConfig = path.join(agentCodexDir, 'config.toml');
        ensurePrivateDir(agentCodexDir, true);
        for (const d of [perAgentSessions, perAgentSnapshots, perAgentLog]) {
          ensurePrivateDir(d, true);
        }
        // A single-file bind mount requires the host file to pre-exist (else Docker
        // creates a directory). Seed EMPTY — never copy the shared config.toml: it
        // carries another agent's JWT, and a stale foreign token must never linger
        // in any per-agent file (that very leakage is the bug we're fixing, and it
        // would mislead audits). The codex bridge regenerates this with THIS agent's
        // JWT at startup before spawning codex; if it ever fails to, an empty config
        // means "no MCP tools" — a safe failure, vs. acting under the wrong identity.
        if (!fs.existsSync(perAgentConfig)) {
          fs.writeFileSync(perAgentConfig, '', { mode: 0o600 });
        }
        ensurePrivateFileForContainerAgent(perAgentConfig);
        if (coordinatorConfigured) {
          // Hive is the only credential authority. Mount no host/shared auth
          // directory; the bridge writes a short-lived access-only cache here.
          return ['-v', `${agentCodexDir}:/home/agent/.codex`];
        }

        // Standalone/headless compatibility: seed one shared login from the host.
        const sharedCodexDir = path.join(shizuhaHome, '.shizuha', 'codex-auth');
        const sharedAuthFile = path.join(sharedCodexDir, 'auth.json');
        const hostAuthFile = path.join(shizuhaHome, '.codex', 'auth.json');
        ensurePrivateDir(sharedCodexDir, true);
        if (!fs.existsSync(sharedAuthFile) || fs.statSync(sharedAuthFile).size === 0) {
          if (fs.existsSync(hostAuthFile)) {
            fs.copyFileSync(hostAuthFile, sharedAuthFile);
          }
        }
        if (!fs.existsSync(sharedAuthFile)) return [];
        ensurePrivateFileForContainerAgent(sharedAuthFile);
        return [
          '-v', `${sharedCodexDir}:/home/agent/.codex`,
          '-v', `${perAgentConfig}:/home/agent/.codex/config.toml`,
          '-v', `${perAgentSessions}:/home/agent/.codex/sessions`,
          '-v', `${perAgentSnapshots}:/home/agent/.codex/shell_snapshots`,
          '-v', `${perAgentLog}:/home/agent/.codex/log`,
        ];
      })(),
      // Per-agent Gemini home so any session/history state is not cross-readable
      // between agent containers (PLAT-86 — the host-global ~/.gemini was mounted
      // into every container). Shared login files (oauth_creds.json, and
      // google_accounts.json if present) are bind-mounted on top as single files so
      // all agents still share one Gemini login (CLI refreshes them in place).
      // Seed safe non-session settings.json into the per-agent home before launch
      // so existing auth selection/policy/enterprise Gemini settings survive the
      // isolation split while runtime session/history files remain per-agent.
      ...(() => {
        const hostGeminiDir = path.join(shizuhaHome, '.gemini');
        const sharedGeminiCreds = path.join(hostGeminiDir, 'oauth_creds.json');
        if (!fs.existsSync(sharedGeminiCreds)) return [];
        const perAgentGeminiDir = path.join(shizuhaHome, '.shizuha', 'gemini-sessions', agent.username);
        ensurePrivateDir(perAgentGeminiDir, true);
        const hostGeminiSettings = path.join(hostGeminiDir, 'settings.json');
        const perAgentGeminiSettings = path.join(perAgentGeminiDir, 'settings.json');
        if (fs.existsSync(hostGeminiSettings)) {
          fs.copyFileSync(hostGeminiSettings, perAgentGeminiSettings);
          ensurePrivateFileForContainerAgent(perAgentGeminiSettings);
        }
        const mounts = ['-v', `${perAgentGeminiDir}:/home/agent/.gemini`];
        for (const fn of ['oauth_creds.json', 'google_accounts.json']) {
          const src = path.join(hostGeminiDir, fn);
          if (fs.existsSync(src)) {
            ensurePrivateFileForContainerAgent(src);
            mounts.push('-v', `${src}:/home/agent/.gemini/${fn}`);
          }
        }
        return mounts;
      })(),
      // Working directory: /workspace is writable (mounted above); /opt/shizuha is :ro
      '-w', '/workspace',
      // Environment
      // Private env-file first: later explicit -e entries may override only
      // non-secret fixed values, never token payloads.
      ...(privateDockerEnvPlan.envFile ? ['--env-file', privateDockerEnvPlan.envFile] : []),
      // Runner proxy in daemon handles platform relay — don't let containers connect directly
      ...dockerEnv('SHIZUHA_AGENT_TOKEN', ''),
      ...dockerEnv('SHIZUHA_GATEWAY_LOCALHOST_BYPASS', '1'),
      ...dockerEnv('DIND_ENABLED', useDind && hasDindImage ? '1' : '0'),
      // Virtual display for browser automation (Xvfb started by entrypoint)
      ...dockerEnv('DISPLAY', ':99'),
      // Keep every bridge/CLI on the writable agent home. Without this, DinD
      // containers inherit image defaults such as HOME=/root; Codex then tries
      // to install system skills under an unwritable/non-agent home and logs
      // permission errors during every startup.
      ...dockerEnv('HOME', '/home/agent'),
      // PLAT-1186: bridge/control auth uses SHIZUHA_HOME to find the
      // daemon-seeded identity keypair. Container agents run as non-root, so
      // this must be the writable runtime home, not /root (which is not
      // traversable and caused EACCES before challenge exchange).
      ...dockerEnv('SHIZUHA_HOME', '/home/agent'),
      ...dockerEnv('USER', 'agent'),
      // Container agent UID/GID: non-root host daemons keep bind-mounted
      // auth/session files private on the host while the entrypoint remaps the
      // in-container agent user to the same numeric owner.
      ...dockerEnv('SHIZUHA_CONTAINER_AGENT_UID', containerAgentUid()),
      ...dockerEnv('SHIZUHA_CONTAINER_AGENT_GID', containerAgentGid()),
      // Agent identity for git config
      ...dockerEnv('AGENT_ID', agent.id),
      ...dockerEnv('AGENT_NAME', agent.name),
      ...dockerEnv('AGENT_EMAIL', agent.email ?? (agent.username + '@shizuha.com')),
      ...dockerEnv('AGENT_USERNAME', agent.username),
      // SCLI-44: role drives the runtime MCP-server allow-list (resolveAllowedServers).
      ...(agent.role ? dockerEnv('AGENT_ROLE', agent.role) : []),
      // Capability tags (skills[]) ALSO drive the MCP allow-list — unioned with role
      // (operator 2026-06-24). Comma-joined; the bridge splits + passes to resolveAllowedServers.
      ...(agent.skills?.length ? dockerEnv('AGENT_SKILLS', agent.skills.join(',')) : []),
      ...Object.entries(agentEffectiveCapabilityEnv(agent)).flatMap(([key, value]) => dockerEnv(key, value)),
      // PLAT-465: team drives role/team-targeted skill loading (buildCatalog).
      ...(agent.team ? dockerEnv('AGENT_TEAM', agent.team) : []),
      // Agent password for self-authentication is supplied via privateDockerEnvPlan
      // so it does not appear in host process argv.
      ...(agentIdentity.userId ? [
        ...dockerEnv('AGENT_USER_ID', agentIdentity.userId),
        ...dockerEnv('AGENT_IS_STAFF', agentIdentity.isStaff),
        ...dockerEnv('AGENT_IS_SUPERUSER', agentIdentity.isSuperuser),
        ...(agentIdentity.orgRole ? dockerEnv('AGENT_ORG_ROLE', agentIdentity.orgRole) : []),
      ] : []),
      ...dockerEnv('DAEMON_HOST', 'host.docker.internal'),
      ...dockerEnv('DAEMON_PORT', resolveDaemonHttpPort()),
      ...dockerEnv('SHIZUHA_PLATFORM_URL', resolvePlatformUrl()),
      // Unified Backend URL — points the agent at whichever Connect / id /
      // Pulse stack we want it to use. Default is the daemon's mini-Connect
      // (host.docker.internal:HTTP_PORT) so daemon-only mode works without
      // a real platform. ConnectClient prefers BACKEND_URL over the legacy
      // SHIZUHA_PLATFORM_URL.
      ...dockerEnv('BACKEND_URL', resolveBackendUrl()),
      ...dockerEnv('CODEX_BROKER_URL', useHiveCodexBroker ? resolveContainerCodexBrokerUrl() : undefined),
      // MCP OAuth migration allowlist (comma list or `*`). Forwarded from the
      // daemon env so cli-agent bridges know which platform MCP services to
      // migrate from a static bearer to Claude Code's native OAuth refresh
      // (see src/platform/mcp-oauth-seed.ts). Unset = no migration (safe
      // default); set on the daemon to roll out and `unset`+restart to revert.
      ...(process.env['SHIZUHA_MCP_OAUTH_SERVICES']
        ? dockerEnv('SHIZUHA_MCP_OAUTH_SERVICES', process.env['SHIZUHA_MCP_OAUTH_SERVICES'])
        : []),
      // No JWT_SECRET_KEY here on purpose — agents authenticate to platform
      // services through shizuha-id (login with AGENT_USERNAME/AGENT_PASSWORD)
      // and never sign their own tokens. The shared secret is platform-only.
      ...(() => {
        const chain = resolveEffectiveChain(agent);
        return chain.length ? dockerEnv('SHIZUHA_MODEL_FALLBACKS', JSON.stringify(chain)) : [];
      })(),
      // Credential env vars and per-agent runtime env are supplied via
      // privateDockerEnvPlan so token/API-key values do not appear in host
      // process argv. Runtime env keys intentionally override fixed defaults:
      // dockerEnv() skips any fixed key that is present in privateDockerEnvPlan.
      // Broker socket env names below are daemon-managed paths.
      // AgentCredential broker sockets (PLAT-103): request socket for all agents;
      // grant socket only when the agent has explicit grant scopes configured.
      ...Object.entries(credentialBrokerPlan.env).flatMap(([k, v]) => dockerEnv(k, v)),
      ...credentialBrokerPlan.mounts.flatMap((mount) => ['-v', `${mount.hostPath}:${mount.containerPath}`]),
      ...(coordinatorConfigured && (useClaudeBridge || useCodexBridge)
        ? dockerEnv('MCP_AUTH_PROXY_SOCKET', '/run/shizuha/mcp-auth-proxy/proxy.sock')
        : []),
      // HTTPS proxy — route container HTTPS traffic through host's Node.js proxy.
      // Solves IPv6 DNS issues: Rust HTTP clients (Codex CLI reqwest) fail when
      // Proxy disabled — DinD containers with sysbox have full network access.
      // The HTTPS proxy was causing issues with internal MCP server HTTP calls
      // (cron MCP → daemon at host.docker.internal:8016 was intercepted by proxy).
      // Containers can reach external APIs directly without proxy.
      ...(process.env['SHIZUHA_DEBUG_BRIDGE_PROMPTS']
        ? dockerEnv('SHIZUHA_DEBUG_BRIDGE_PROMPTS', process.env['SHIZUHA_DEBUG_BRIDGE_PROMPTS'])
        : []),
      // Bridge log persistence: tee bridge stdout/stderr to a named file outside
      // the --rm container so logs survive restart. Picked up by startClaudeBridge.
      ...dockerEnv('CLAUDE_BRIDGE_LOG_FILE', `/var/log/shizuha/bridges/bridge-${agent.username}.log`),
      // Registry mirrors: DinD entrypoint reads /root/.shizuha/settings.json at startup
      // and merges registryMirrors/insecureRegistries into /etc/docker/daemon.json.
      // settings.json is already mounted via credentials.json mount (same directory).
      // No env var needed — file-based config allows runtime changes via dashboard.
    ];

    // ── SSH key injection ──
    // Mounts host SSH keys into the agent container for remote host access.
    // Keys are copied (not bind-mounted) to a staging dir with correct permissions,
    // then mounted read-only into /home/agent/.ssh/.
    // PLAT-105 + PLAT-194: re-derive the fleet-ssh grant here in the COMMON start path
    // (every enable/restart/respawn routes through startAgentProcess), so a newly
    // host-plane (devops-skilled) or legacy-sshKeys agent always has its grant before
    // staging - restarts that bypass enableAndStartAgent are covered. Idempotent.
    if (isHostPlaneAgent(agent) || agent.sshKeys?.enabled) {
      const beforeFleetSshCreds = JSON.stringify(agent.credentials ?? null);
      agent.credentials = materializeMissingFleetSshCredentialGrantFromLegacySshKeys(agent);
      if (JSON.stringify(agent.credentials ?? null) !== beforeFleetSshCreds) {
        updateAgentConfig(agent.id, { credentials: agent.credentials });
      }
    }
    const fleetSshRead = resolveFleetSshCredentialGrant(agent);
    for (const refusal of fleetSshRead.refusals) {
      emitAgentCredentialScopeAlert(agent, refusal);
    }
    let fleetSshMounted = false;
    if (fleetSshRead.grant) {
      const fleetSshStage = stageFleetSshCredentialGrant({
          agent,
          grant: fleetSshRead.grant,
          shizuhaHome,
          recordAuditEvent: createCredentialAuditLogger(credentialAuditLogPath()),
          expandHomePath: expandDaemonHomePath,
        });
      if (fleetSshStage) {
        dockerArgs.push('-v', `${fleetSshStage.sshStageDir}:/home/agent/.ssh:ro`);
        if (fleetSshRead.grant.remoteUser) {
          dockerArgs.push(...dockerEnvOverride('SSH_USER', fleetSshRead.grant.remoteUser));
        }
        console.log(`[daemon] ${agent.name}: SSH keys mounted (${fleetSshStage.mounted} files from ${fleetSshStage.hostSshDir}; grant=${fleetSshRead.grant.grantId})`);
        fleetSshMounted = true;
      }
    }
    // PLAT-194 FAIL-LOUD: a host-plane (DevOps) agent must NEVER start silently
    // without its SSH mount — that exact silent-keyless start was the PLAT-177
    // outage. Surface it loudly (structured log + stderr) instead.
    if (!fleetSshMounted && isHostPlaneAgent(agent)) {
      const reason = fleetSshRead.grant
        ? 'fleet-ssh grant resolved but staging found no key files (per-agent store empty/unmounted)'
        : 'no fleet-ssh grant resolved for host-plane agent';
      logger.error(
        { agentId: agent.id, agentUsername: agent.username, scope: 'fleet-ssh', reason },
        'PLAT-194: host-plane agent starting WITHOUT SSH key mount — host access will be unavailable',
      );
      console.error(
        `[daemon][ALERT][PLAT-194] ${agent.name}: host-plane (DevOps) agent starting WITHOUT SSH key mount — ${reason}. ` +
        `Host access will be unavailable; recover via the DevOps host-key self-recovery runbook (PLAT-195).`,
      );
    }

    // ── DinD: Docker-in-Docker support ──
    if (useDind && hasDindImage) {
      if (dindMode === 'sysbox') {
        // Sysbox: true nested containers, no --privileged needed
        dockerArgs.push('--runtime=sysbox-runc');
      } else {
        // Privileged DinD: needed for dockerd inside the container
        dockerArgs.push('--privileged');
        // tini as init: reap zombie processes from codex exec → docker-compose → containerd-shim.
        // Without this, orphaned grandchildren reparent to PID 1 (Node.js) which doesn't
        // call waitpid() on processes it didn't spawn, causing zombie accumulation that
        // eventually stalls the event loop and kills the WS server.
        // Sysbox has its own init, so only add for privileged mode.
        dockerArgs.push('--init');
      }
      // Ephemeral Docker storage via tmpfs — gives clean overlay2 state on every start.
      // Bind mounts accumulated stale overlay2 check-overlayfs-support*/metacopy-check*
      // directories that could not be removed (read-only overlay work dirs), forcing
      // fallback to vfs which can't unpack images with /proc (Lchown permission denied).
      // tmpfs avoids this entirely: fresh overlay2 every time, images re-pulled as needed.
      dockerArgs.push('--tmpfs', '/var/lib/docker:exec');
    } else {
      if (useNonDindNumericUser) {
        // Sandbox containers run with a read-only root filesystem, so they cannot
        // rewrite /etc/passwd at entrypoint time. Run node directly as the host
        // daemon UID/GID instead; the bridge then treats itself as non-root and
        // avoids runuser while retaining access to private host-owned mounts.
        dockerArgs.push(
          '--user', `${containerAgentUid()}:${containerAgentGid()}`,
          ...dockerEnv('HOME', '/home/agent'),
          ...dockerEnv('USER', 'agent'),
          '--entrypoint', 'node',
        );
      } else {
        // No DinD: run a tiny remap entrypoint before node. restricted_container
        // and plain container fallback skip the DinD entrypoint, but the bridge
        // still drops to runuser -u agent; PLAT-86's private host-owned bind
        // mounts therefore require the in-container agent UID/GID to match the
        // host daemon UID/GID.
        const nonDindEntrypoint = ensureNonDindEntrypointScript(shizuhaHome);
        dockerArgs.push(
          '-v', `${nonDindEntrypoint}:${NON_DIND_ENTRYPOINT_CONTAINER}:ro`,
          '--entrypoint', NON_DIND_ENTRYPOINT_CONTAINER,
        );
      }
    }

    // ── Cross-platform native module support ──
    // When node_modules-linux/ exists alongside the bundle dir, it contains Linux ARM64
    // native binaries (ELF) compiled in a Docker container. Mount it over the host
    // node_modules (which may be macOS Mach-O) so containers get the correct binaries.
    // NOTE: Do NOT gate on process.platform here — esbuild tree-shakes that check
    // at build time when built on Linux, silently removing this whole block on macOS hosts.
    const linuxNmPath = path.join(shizuhaDir, 'node_modules-linux');
    if (fs.existsSync(linuxNmPath)) {
      const nmContainerPath = `${containerShizuha}/dist/node_modules`;
      dockerArgs.push('-v', `${linuxNmPath}:${nmContainerPath}:ro`);
    }

    // ── GPU passthrough for Chromium/browser and ML workloads ──
    // Detect NVIDIA GPU and mount into container for accelerated rendering.
    // Requires: nvidia-container-toolkit installed on host, `nvidia` Docker runtime.
    if (hasNvidiaGpu()) {
      dockerArgs.push('--gpus', 'all');
      dockerArgs.push('--device', '/dev/dri:/dev/dri');
      dockerArgs.push(...dockerEnv('NVIDIA_VISIBLE_DEVICES', 'all'));
      dockerArgs.push(...dockerEnv('NVIDIA_DRIVER_CAPABILITIES', 'compute,utility,graphics'));
    }

    // Ensure bridge log dir exists with proper permissions so Docker mounts it
    // as daemon-user-owned (not root-owned via Docker tmpfs creation).
    try {
      fs.mkdirSync(bridgeLogDir(), { recursive: true, mode: 0o700 });
    } catch { /* ignore — worst case the dir is created by Docker as root */ }

    // ── Per-agent extra volume mounts (from agent config) ──
    // Agents can declare extraVolumes: [{ host: "~/.shizuha/x-credentials.json", container: "/root/.shizuha/x-credentials.json", mode: "ro" }]
    const dockerPath = resolveDockerPath();
    const reservedCredentialBrokerHostPaths = [
      ...resolveAgentCredentialBrokerReservedHostPaths({ dockerPath }),
      ...(coordinatorConfigured ? [
        path.join(shizuhaHome, '.codex'),
        path.join(shizuhaHome, '.shizuha', 'codex-auth'),
        path.join(shizuhaHome, '.shizuha', 'credentials.json'),
        '/home/agent/.codex',
        '/root/.codex',
        '/home/agent/.shizuha/credentials.json',
        '/root/.shizuha/credentials.json',
      ] : []),
    ];
    const extraVolumes = filterAgentCredentialBrokerExtraVolumes(
      ((agent as any).extraVolumes as Array<{ host: string; container: string; mode?: string }> | undefined)
        ?.map((volume) => ({ ...volume, host: volume.host.replace(/^~/, shizuhaHome) })),
      { reservedHostPaths: reservedCredentialBrokerHostPaths },
    );
    if (extraVolumes.length > 0) {
      for (const vol of extraVolumes) {
        const hostPath = vol.host.replace(/^~/, shizuhaHome);
        if (fs.existsSync(hostPath)) {
          dockerArgs.push('-v', `${hostPath}:${vol.container}${vol.mode ? ':' + vol.mode : ''}`);
        }
      }
    }

    // ── Per-agent extra docker args (from agent config) ──
    // e.g. ["--security-opt", "seccomp=unconfined"] for Chrome stealth (non-root, no --no-sandbox)
    const extraDockerArgs = filterAgentCredentialBrokerExtraDockerArgs(
      (agent as any).extraDockerArgs as string[] | undefined,
      { reservedHostPaths: reservedCredentialBrokerHostPaths },
    );
    if (extraDockerArgs.length > 0) {
      dockerArgs.push(...extraDockerArgs);
    }

    // User-configured resource limits
    const limits = agent.resourceLimits;
    if (limits?.memory) dockerArgs.push('--memory', limits.memory);
    if (limits?.cpus) dockerArgs.push('--cpus', limits.cpus);
    if (limits?.pidsLimit) dockerArgs.push('--pids-limit', String(limits.pidsLimit));

    // Restricted container: add security constraints (no DinD)
    if (runtime === 'restricted_container') {
      dockerArgs.push('--cap-drop=ALL', '--security-opt=no-new-privileges');
      if (!limits?.pidsLimit) dockerArgs.push('--pids-limit=256');
    }
    // Sandbox: no network, read-only root fs (no DinD)
    if (runtime === 'sandbox') {
      dockerArgs.push(
        '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--network=none', '--read-only', '--tmpfs=/tmp:rw,noexec,nosuid,size=256m',
      );
      if (!limits?.pidsLimit) dockerArgs.push('--pids-limit=128');
    }

    // Defensive: collapse duplicate `-v` mounts by container target. The host-plane SSH
    // grant can be added twice — once by the credential broker (credentialBrokerPlan.mounts)
    // and once by the dedicated fleet-ssh stage — which makes docker reject the run with
    // "Duplicate mount point: /home/agent/.ssh" → exit 125 → crash loop (CTX-17). Keep the
    // first mount per target. Must run BEFORE the positional image/command are appended.
    {
      const deduped: string[] = [];
      const seenMountTargets = new Set<string>();
      for (let i = 0; i < dockerArgs.length; i++) {
        const arg = dockerArgs[i]!;
        const spec = dockerArgs[i + 1];
        if (arg === '-v' && spec !== undefined) {
          const target = spec.split(':')[1];
          if (target && seenMountTargets.has(target)) {
            console.log(`[daemon] ${agent.name}: dropped duplicate mount target ${target}`);
            i++; // skip the value too
            continue;
          }
          if (target) seenMountTargets.add(target);
          deduped.push(arg, spec);
          i++;
          continue;
        }
        deduped.push(arg);
      }
      dockerArgs.length = 0;
      dockerArgs.push(...deduped);
    }

    // Image + command — the bundle directory is always mounted at /opt/shizuha/dist,
    // regardless of whether the host is in dev layout (repo/dist) or installed
    // layout (~/.shizuha/lib). Do not derive /opt/shizuha/lib/shizuha.js here.
    const containerShizuhaJs = `${containerShizuha}/dist/${path.basename(shizuhaJs)}`;
    if (useDind && hasDindImage) {
      // DinD image: entrypoint is dind-entrypoint.sh, command is node + args
      dockerArgs.push(containerImage, 'node', containerShizuhaJs, ...args);
    } else if (useNonDindNumericUser) {
      // Sandbox path: --entrypoint node; command starts at the script path.
      dockerArgs.push(containerImage, containerShizuhaJs, ...args);
    } else {
      // Same-platform/plain image: remap entrypoint execs this node command.
      dockerArgs.push(containerImage, 'node', containerShizuhaJs, ...args);
    }

    if (effectiveBridgeMode) {
      console.log(
        `[daemon] ${agent.name}: bridge container launch image=${containerImage} summary=${JSON.stringify({
          useDind: useDind && hasDindImage,
          command,
          containerShizuhaJs,
          argv: (useDind && hasDindImage ? ['node', containerShizuhaJs, ...args] : [containerShizuhaJs, ...args]),
          contextPrompt: summarizePromptForLog(args[args.indexOf('--context-prompt') + 1]),
        })}`,
      );
    }

    // ── Container lifecycle: always fresh start ──
    // On daemon restart, always create fresh containers. Persistent state
    // (workspace, claude sessions, agent config) lives on mounted volumes
    // and survives container recreation. Fresh containers ensure env vars
    // (AGENT_USER_ID, AGENT_ACCESS_TOKEN, etc.) are always up to date.
    // Always fresh containers — kill any existing one from a previous daemon session.
    // Persistent state (workspace, claude sessions) lives on mounted volumes.
    const reusingContainer = false;
    try {
      execSync(`${resolveDockerPath()} rm -f ${containerName} 2>/dev/null`, { timeout: 10_000, stdio: 'ignore' });
    } catch { /* ignore — container may not exist */ }

    // Ensure workspace and claude session dirs exist
    const workspaceDir = path.join(shizuhaHome, '.shizuha', 'workspaces', agent.username);
    const claudeSessionDir = path.join(shizuhaHome, '.shizuha', 'claude-sessions', agent.username);
    fs.mkdirSync(workspaceDir, { recursive: true });
    ensurePrivateDir(claudeSessionDir, true);
    seedHeartbeatTemplate(workspaceDir);

    // Fresh start — always create a new container
    {
      containerIpCache.delete(agent.id);
      try {
        execSync(`${resolveDockerPath()} rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore' });
      } catch { /* ignore */ }
      // Small delay after rm to let Docker release the port
      try { execSync('sleep 1', { stdio: 'ignore' }); } catch { /* ignore */ }

      // CTX-17 (PLAT-194 fleet outage): defensively dedupe duplicate `-v` mount TARGETS
      // before `docker run`. A duplicate mount target (e.g. a legacy sshKeys path + the
      // fleet-ssh stage both → /home/agent/.ssh, or a custom volume / extraDockerArgs
      // re-adding a reserved target) makes docker fail with exit 125 "Duplicate mount
      // point", crash-looping the agent. The single fleet-ssh mount path above is correct;
      // this is belt-and-suspenders so no config path can re-introduce the crash. Keep the
      // FIRST occurrence per target (the intended mounts are pushed first), drop later dups
      // with a warning. Only inspects -v/--volume pairs; image/cmd/other flags pass through.
      const dedupedDockerArgs: string[] = [];
      const seenMountTargets = new Set<string>();
      for (let i = 0; i < dockerArgs.length; i++) {
        const arg = dockerArgs[i]!;
        if ((arg === '-v' || arg === '--volume') && i + 1 < dockerArgs.length) {
          const spec = dockerArgs[i + 1]!;
          const parts = spec.split(':');
          const target = parts.length >= 2 ? parts[1]! : spec; // host:container[:opts] → container target
          if (seenMountTargets.has(target)) {
            console.warn(`[daemon] ${agent.name}: dropping duplicate -v mount target ${target} (spec ${spec}) to avoid docker "Duplicate mount point" exit 125`);
            i++; // skip the spec value too
            continue;
          }
          seenMountTargets.add(target);
          dedupedDockerArgs.push(arg, spec);
          i++;
          continue;
        }
        dedupedDockerArgs.push(arg);
      }

      child = spawn(dockerPath, dedupedDockerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      schedulePrivateDockerEnvCleanup(privateDockerEnvPlan, child, dockerPath, containerName);
    }
  } else {
    // ── Bare metal: fork directly ──
    // SCLI-368: the persistent workspace can retain root-owned SQLite files
    // from an earlier container runtime. The lifecycle owner must repair and
    // verify the allow-listed StateStore boundary while the prior writer is
    // quiesced, before fork. A failed preflight returns without a child, so a
    // deterministic ownership/mount failure cannot become a six-second loop.
    const shizuhaHome = process.env['HOME'] ?? os.homedir();
    const bareMetalCwd = path.join(shizuhaHome, '.shizuha', 'workspaces', agent.username);
    try {
      const launch = launchBareMetalChild({
        workspaceDir: bareMetalCwd,
        shizuhaJs,
        args,
        env: agentEnv,
        beforeFork: () => {
          seedHeartbeatTemplate(bareMetalCwd);

          // Point Claude CLI at the agent's dedicated session store so each agent
          // has isolated conversation history (matches the container volume mount
          // at /home/agent/.claude/).
          const claudeSessionDir = path.join(shizuhaHome, '.shizuha', 'claude-sessions', agent.username);
          ensurePrivateDir(claudeSessionDir);
          agentEnv.CLAUDE_CONFIG_DIR = claudeSessionDir;
        },
      });
      const statePreflight = launch.preflight;
      if (statePreflight.repairedOwnership.length || statePreflight.repairedModes.length) {
        console.warn(
          `[daemon] ${agent.name}: repaired bare-metal SQLite state boundary ` +
          `(ownership=${statePreflight.repairedOwnership.length}, mode=${statePreflight.repairedModes.length})`,
        );
      }
      child = launch.child;
    } catch (error) {
      const message = `bare-metal launch failed before child registration: ${(error as Error).message}`;
      console.error(`[daemon] ${agent.name}: ${message}`);
      updateAgentInMemory(agent.id, { status: 'error', error: message });
      return message;
    }
  }

  childProcesses.set(agent.id, child);

  // PLAT-160 wedge watchdog: count wedge-signature hits in a rolling window;
  // on threshold, force-restart this child (exit handler brings it back with
  // a fresh session). Without this, a non-exiting retry loop is invisible to
  // the exit-based supervision and the agent is silently dead while "Up".
  let wedgeHits: number[] = [];
  let wedgeTripped = false;
  const maybeSendAutoAndon = (text: string, stream: 'stdout' | 'stderr'): void => {
    const signal = observeAutoAndonLine(agent.id, text, stream);
    if (!signal) return;
    console.warn(
      `  [${agent.name}] AUTO-ANDON detected (${signal.pattern}, count=${signal.count}) — notifying cluster manager`,
    );
    void sendAutoAndonToClusterManager({
      agent,
      config,
      signal,
      senderPassword: resolveAgentPassword(agent),
    }).then(() => {
      recordAutoAndonFired();
    }).catch((err) => {
      clearAutoAndonRateLimit(agent.id, signal);
      recordAutoAndonSendFailed();
      console.error(`  [${agent.name}] AUTO-ANDON manager DM failed (rate-limit cleared for retry): ${(err as Error).message}`);
    });
  };

  const checkWedge = (text: string): void => {
    if (wedgeTripped) return;
    // One buffered data event can carry several retry iterations — count
    // occurrences, not events, so detection latency doesn't depend on flushing.
    const occurrences = WEDGE_PATTERNS.reduce((n, p) => n + text.split(p).length - 1, 0);
    if (occurrences === 0) return;
    const now = Date.now();
    for (let i = 0; i < occurrences; i++) wedgeHits.push(now);
    wedgeHits = wedgeHits.filter((t) => now - t < WEDGE_WINDOW_MS);
    if (wedgeHits.length < WEDGE_THRESHOLD) return;
    wedgeTripped = true;
    console.error(
      `  [${agent.name}] WEDGE DETECTED — wedge signature x${wedgeHits.length} within ` +
      `${WEDGE_WINDOW_MS / 60_000}min; force-restarting for a fresh session (PLAT-160)`,
    );
    // Surface the wedge as an error state (not "running") so dashboards and
    // the availability sweep see the agent as unhealthy during the bounce.
    updateAgentInMemory(agent.id, {
      status: 'error',
      error: 'wedged: pre-sampling compaction retry loop — force-restarting (PLAT-160)',
    });
    child.kill('SIGTERM');
    // A wedged bridge may ignore SIGTERM mid-retry-loop — escalate to SIGKILL.
    setTimeout(() => {
      if (childProcesses.get(agent.id) === child) {
        console.error(`  [${agent.name}] wedge restart: SIGTERM ignored — sending SIGKILL`);
        child.kill('SIGKILL');
      }
    }, WEDGE_SIGKILL_AFTER_MS);
  };

  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      console.log(`  [${agent.name}] ${line}`);
      checkWedge(line);
      maybeSendAutoAndon(line, 'stdout');
      // PLAT-962: track token-pool backoff state for health exporter (capacity_unavailable metric)
      if (line.includes('[claude-bridge] PLAT-879:')) {
        if (line.includes('token pool recovered') || line.includes('token pool restored')) {
          tokenPoolBackoffSet.delete(agent.id);
        } else {
          tokenPoolBackoffSet.add(agent.id);
        }
      }
      // PLAT-4172: a heartbeat-outcome line just updated the agent's needs_help
      // state — push it to Hive immediately (the register frame only re-sends on
      // reconnect, and no other daemon-state change fires here), so a queue-blind
      // agent's needs_help escalation surfaces on /hive/agents within a heartbeat.
      if (ingestHeartbeatQueueDrainOutcomeLogLine(line, agent.id)) {
        daemonLinkClient?.sendAgentDelta(agent.id, 'heartbeat_outcome');
      }
      logCodexRpcActivity(agent.id, line, new Date().toISOString());
      // Parse bridge telemetry into activity events
      if (line.includes('[telemetry]')) {
        const now = new Date().toISOString();
        noteAgentActivity(agent.id, now);
        // Extract: tool_start: ToolName at=...
        const toolMatch = line.match(/tool_start:\s+(\S+)\s+at=/);
        if (toolMatch) {
          logActivity(agent.id, { ts: now, type: 'tool_start', tool: toolMatch[1] });
        }
        const turnMatch = line.match(/turn_complete:\s+turn=(\d+)/);
        if (turnMatch) {
          logActivity(agent.id, { ts: now, type: 'turn_complete', detail: `Turn ${turnMatch[1]} completed` });
        }
      }
    }
  });

  // Capture stderr to extract real error messages (e.g., "Codex not authenticated")
  let lastStderrLine = '';
  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      checkWedge(text);
      maybeSendAutoAndon(text, 'stderr');
      // Log only a truncated version to daemon log (avoid flooding with minified source)
      const logLines = text.split('\n').filter((l) => l.length < 500);
      if (logLines.length) console.error(`  [${agent.name}] ${logLines.join('\n  ')}`);

      // Extract clean error messages from stderr
      // Node.js prints source context before the error — skip long lines (minified bundles)
      for (const line of text.split('\n')) {
        if (line.length > 500) continue; // Skip minified source context lines
        // Match "Error: <message>" or "TypeError: <message>" etc.
        const errorMatch = line.match(/(?:^|\s)((?:\w+)?Error):\s*(.+)/);
        if (errorMatch) {
          lastStderrLine = (errorMatch[2] ?? '').replace(/\s+at\s+.*$/, '').trim();
          break;
        }
        // Known error keywords
        if (line.includes('not authenticated') || line.includes('not configured')) {
          lastStderrLine = line.trim();
          break;
        }
        if (PROVIDER_QUOTA_EXIT_RE.test(line)) {
          lastStderrLine = line.trim();
          break;
        }
      }
    }
  });

  child.on('exit', (code, signal) => {
    // Ignore exit events from stale child processes (a new one may have already
    // been spawned via enableAndStartAgent while this one was still stopping).
    const currentChild = childProcesses.get(agent.id);
    if (currentChild && currentChild !== child) {
      // A newer process is already tracked — this is a stale exit event.
      return;
    }
    childProcesses.delete(agent.id);
    tokenPoolBackoffSet.delete(agent.id); // PLAT-962: clear capacity state on any exit/restart

    if (shuttingDown) return;

    // Check if agent is still enabled (user may have toggled it off).
    // SCLI-110: re-read enabled-agents.json as the authoritative source each
    // cycle — in-memory state can be stale if another code path enabled the
    // agent in memory without a matching file update. Both checks must pass;
    // if they disagree, sync in-memory state to the file and don't restart.
    const agentState = inMemoryState?.agents.find((a) => a.agentId === agent.id);
    const persistedEnabledOnExit = readEnabledAgents();
    const persistedIsEnabled = persistedEnabledOnExit.has(agent.id);
    if (!agentState?.enabled || !persistedIsEnabled) {
      if (agentState?.enabled && !persistedIsEnabled) {
        // In-memory says enabled but file says disabled — file wins; sync.
        updateAgentInMemory(agent.id, { status: 'stopped', enabled: false, error: undefined });
      } else {
        updateAgentInMemory(agent.id, { status: 'stopped', error: undefined });
      }
      return;
    }

    // ── Cross-method failover (exit code 42) ──
    // The bridge signals that all tokens/models within its method are exhausted.
    // Advance to the next step in the failover chain that uses a different method.
    if (code === 42) {
      const chain = resolveRuntimeChain(agent);
      const nextStep = advanceFailoverStep(agent.id, chain);
      if (nextStep) {
        console.log(`[daemon] FAILOVER: ${agent.name} advancing to ${nextStep.method}/${nextStep.model}`);
        updateAgentInMemory(agent.id, { status: 'starting', error: `Failover: switching to ${nextStep.method}/${nextStep.model}` });
        setTimeout(() => {
          if (!shuttingDown && !childProcesses.has(agent.id) && readEnabledAgents().has(agent.id)) {
            void startAgentProcess(agent, tokenCache.get(agent.id) ?? '', config);
          }
        }, 2000);
      } else {
        // SCLI-107: every failover step failed — typically a transient,
        // provider-wide outage. Don't give up permanently (that made a transient
        // outage a fleet-wide SPOF needing a manual restart). Re-queue a start
        // with exponential back-off; resetFailoverStep() sends the retry back to
        // step 0 (the primary) since the provider may have recovered by then.
        const backoffMs = nextFailoverRequeueDelayMs(agent.id);
        const backoffSec = Math.round(backoffMs / 1000);
        console.error(
          `[daemon] FAILOVER EXHAUSTED: ${agent.name} — all chain steps tried. ` +
          `Re-queueing start in ${backoffSec}s.`,
        );
        updateAgentInMemory(agent.id, {
          status: 'error',
          error: `All failover chain steps exhausted — retrying in ${backoffSec}s`,
        });
        setTimeout(() => {
          const currentState = inMemoryState?.agents.find((a) => a.agentId === agent.id);
          if (!shuttingDown && currentState?.enabled && readEnabledAgents().has(agent.id) && !childProcesses.has(agent.id)) {
            resetFailoverStep(agent.id); // retry from the primary — provider may have recovered
            updateAgentInMemory(agent.id, { status: 'starting', error: 'Retrying after failover-chain exhaustion' });
            void startAgentProcess(agent, tokenCache.get(agent.id) ?? '', config);
          }
        }, backoffMs);
      }
      return;
    }

    if (code !== 0) {
      const errorMsg = lastStderrLine || `Exited with code ${code}`;
      const providerQuotaExit = PROVIDER_QUOTA_EXIT_RE.test(errorMsg);
      console.error(
        `  [${agent.name}] exited with code ${code} (signal: ${signal}): ${errorMsg}`,
      );
      updateAgentInMemory(agent.id, {
        status: providerQuotaExit ? 'offline' : 'error',
        error: providerQuotaExit ? PROVIDER_QUOTA_STATUS_MESSAGE : errorMsg,
      });

      // Don't auto-restart on auth errors — user needs to configure credentials
      if (errorMsg.includes('not authenticated') || errorMsg.includes('not configured')) {
        console.log(`  [${agent.name}] Auth required — skipping auto-restart`);
        return;
      }

      // SCLI-73: if the exit looks like Claude OAuth quota/rate-limit exhaustion,
      // cool THIS agent's current token before the auto-restart so
      // getActiveClaudeToken() skips it and picks the next active token (by
      // priority) instead of re-injecting the dead one. Root cause of the
      // 2026-06-11 fleet crash-loop (~33 recreations/5min): a quota-exhausted
      // cl3 exited non-zero with a rate-limit message (not "not authenticated"),
      // so the daemon kept restarting with the SAME uncooled priority-1 token.
      // This is the daemon-side safety net independent of whether the bridge
      // detected the 429 in-process; the picker's cooldownUntil expiry handles
      // auto-reactivation once the quota window resets.
      if (providerQuotaExit) {
        const tokenLabel = inMemoryState?.agents.find((a) => a.agentId === agent.id)?.oauthTokenLabel;
        if (tokenLabel) {
          try {
            const { reportTokenRateLimited } = require('../config/credentials.js');
            const persisted = reportTokenRateLimited(tokenLabel) as boolean;
            console.warn(
              `  [${agent.name}] exit looks rate-limited — cooled Claude token "${tokenLabel}" ` +
              `(persisted=${persisted}); next restart picks a fresh token`,
            );
          } catch (err) {
            console.error(`  [${agent.name}] failed to cool token "${tokenLabel}": ${(err as Error).message}`);
          }
        }
      }

      // Auto-restart after 5 seconds (only if still enabled and no newer process started)
      console.log(`  [${agent.name}] Restarting in 5s...`);
      setTimeout(() => {
        const currentState = inMemoryState?.agents.find((a) => a.agentId === agent.id);
        if (!shuttingDown && currentState?.enabled && readEnabledAgents().has(agent.id) && !childProcesses.has(agent.id)) {
          void startAgentProcess(agent, tokenCache.get(agent.id) ?? '', config);
        }
      }, 5000);
    } else {
      // Clean exit (code 0) — restart if still enabled. Agents should run 24/7.
      // Clean exits happen on SIGTERM (daemon restart), container OOM, or
      // gateway shutdown. The agent should always come back.
      updateAgentInMemory(agent.id, { status: 'stopped', error: undefined });
      console.log(`  [${agent.name}] Clean exit — restarting in 5s...`);
      setTimeout(() => {
        const currentState = inMemoryState?.agents.find((a) => a.agentId === agent.id);
        if (!shuttingDown && currentState?.enabled && readEnabledAgents().has(agent.id) && !childProcesses.has(agent.id)) {
          void startAgentProcess(agent, tokenCache.get(agent.id) ?? '', config);
        }
      }, 5000);
    }
  });

  child.on('spawn', () => {
    updateAgentInMemory(agent.id, {
      status: 'running',
      pid: child.pid,
      error: undefined,
    });
    console.log(`  [${agent.name}] running (PID ${child.pid})`);
    // SCLI-107: clear the failover back-off counter only on GENUINE recovery —
    // this exact child must still be the live process after the grace window.
    // Clearing on spawn alone would reset the back-off on every immediate
    // re-exit (each chain step spawns), defeating the exponential escalation;
    // requiring survival means a recover-then-fail-again cycle restarts at the
    // floor, while a real recovery (incl. failing over to a working step) resets.
    if (failoverRequeueAttempts.has(agent.id)) {
      setTimeout(() => {
        if (childProcesses.get(agent.id) === child) {
          resetFailoverRequeue(agent.id);
        }
      }, FAILOVER_RECOVERY_GRACE_MS);
    }
  });

  child.on('error', (err) => {
    console.error(`  [${agent.name}] spawn error: ${err.message}`);
    updateAgentInMemory(agent.id, {
      status: 'error',
      error: err.message,
    });
  });
}

/**
 * Stop all running agent processes.
 */
function stopAllAgents(): void {
  for (const [agentId, child] of childProcesses) {
    console.log(`  Stopping agent ${agentId} (PID ${child.pid})...`);
    child.kill('SIGTERM');
  }

  // Give processes 5 seconds to exit gracefully
  setTimeout(() => {
    for (const [agentId, child] of childProcesses) {
      if (!child.killed && child.exitCode === null) {
        console.log(`  Force-killing agent ${agentId} (PID ${child.pid})...`);
        child.kill('SIGKILL');
      }
    }
  }, 5000);
}

/**
 * Stop the daemon and all agents.
 * Checks both the PID lock file and daemon.json state to find running daemons.
 */
export function stopDaemon(): boolean {
  const { readPidLock, releasePidLock } = require('./state.js') as typeof import('./state.js');
  let killed = false;

  // Check PID lock file (authoritative — written by acquirePidLock)
  const lockPid = readPidLock();
  if (lockPid && isShizuhaDaemonProcess(lockPid)) {
    try {
      process.kill(lockPid, 'SIGTERM');
      console.log(`Sent shutdown signal to daemon (PID ${lockPid} from lock file).`);
      killed = true;
    } catch { /* not running */ }
  }

  // Also check daemon.json state (may have a different PID)
  const state = readDaemonState();
  if (state && state.pid !== lockPid) {
    if (isShizuhaDaemonProcess(state.pid)) {
      try {
        process.kill(state.pid, 'SIGTERM');
        console.log(`Sent shutdown signal to daemon (PID ${state.pid} from state).`);
        killed = true;
      } catch { /* not running */ }
    }
  }

  if (!killed) {
    console.log('No daemon is running.');
  }

  clearDaemonState();
  releasePidLock();
  return killed;
}

/**
 * Show daemon status.
 */
export async function showStatus(
  platformUrl?: string,
  accessToken?: string,
): Promise<void> {
  const state = readDaemonState();

  if (state) {
    let alive = false;
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch {
      // stale state
    }

    console.log(`Daemon: ${alive ? 'running' : 'not running (stale)'}`);
    console.log(`  PID: ${state.pid}`);
    console.log(`  Started: ${state.startedAt}`);
    console.log(`  Platform: ${state.platformUrl}`);
    console.log(`  Agents: ${state.agents.length}`);
    console.log(`  Logs: ${daemonLogPath()}`);
    console.log('');

    for (const agent of state.agents) {
      const statusIcon =
        agent.status === 'running'
          ? '+'
          : agent.status === 'error'
            ? 'x'
            : '-';
      const enabledTag = agent.enabled ? '' : ' [disabled]';
      console.log(
        `  [${statusIcon}] ${agent.agentName} (${agent.status})${enabledTag}${agent.pid ? ` PID ${agent.pid}` : ''}`,
      );
      if (agent.error) {
        console.log(`      Error: ${agent.error}`);
      }
    }
  } else {
    console.log('Daemon: not running');
  }

  // If we have platform access, also show connected runners
  if (platformUrl && accessToken) {
    // Platform runner-status view retired 2026-04-20 along with /ws/runner/.
  }
}

// ── Runtime agent CRUD (for dashboard) ──

/** Check if a port is available (not in use by another process). */
function isPortAvailable(port: number): boolean {
  try {
    // Use lsof/ss to check if port is in use — works synchronously
    if (process.platform === 'darwin') {
      execSync(`lsof -i :${port} -sTCP:LISTEN`, { stdio: 'ignore', timeout: 3000 });
      return false; // lsof succeeded = something is listening
    } else {
      execSync(`ss -tlnp sport = :${port} | grep -q LISTEN`, { stdio: 'ignore', timeout: 3000 });
      return false;
    }
  } catch {
    return true; // command failed = nothing listening = port available
  }
}

/** Find the next available local port for a new agent. */
function nextLocalPort(): number {
  const usedPorts = discoveredAgents
    .filter((a) => a.localPort)
    .map((a) => a.localPort!);
  let port = 8018; // 8017 is default local agent
  while (usedPorts.includes(port) || !isPortAvailable(port)) port++;
  return port;
}

/**
 * Create a new local agent at runtime. Persists to agents.json,
 * adds to in-memory state, and optionally starts it.
 */
export function createLocalAgentAtRuntime(info: {
  name: string;
  username: string;
  email?: string;
  role?: string;
  executionMethod?: string;
  runtimeEnvironment?: string;
  skills?: string[];
  personalityTraits?: Record<string, string>;
  modelFallbacks?: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string }>;
  modelOverrides?: Record<string, string>;
  contextPrompt?: string;
  extraDockerArgs?: string[];
  extraVolumes?: Array<{ host: string; container: string; mode?: string }>;
}): AgentInfo {
  const id = `local-${info.username}-${Date.now().toString(36)}`;
  const port = nextLocalPort();

  const agent: AgentInfo = {
    id,
    name: info.name,
    username: info.username,
    email: info.email || `${info.username}@local`,
    role: info.role || 'agent',
    status: 'active',
    localPort: port,
    executionMethod: info.executionMethod || 'shizuha',
    runtimeEnvironment: normalizeRuntimeEnvironment(
      info.runtimeEnvironment,
      isDockerAvailable() ? 'container' : 'bare_metal',
    ),
    modelFallbacks: info.modelFallbacks,
    modelOverrides: info.modelOverrides,
    mcpServers: [],
    personalityTraits: info.personalityTraits || {},
    skills: info.skills || [],
    ...(info.contextPrompt ? { contextPrompt: info.contextPrompt } : {}),
    ...(info.extraDockerArgs ? { extraDockerArgs: info.extraDockerArgs } : {}),
    ...(info.extraVolumes ? { extraVolumes: info.extraVolumes } : {}),
  } as AgentInfo;

  // Persist to the authoritative store before exposing the agent to daemon
  // memory, daemon.json, credential broker sockets, or any runtime start path.
  const addResult = addAgent(agent, { desiredEnabled: false, operatorDisabled: false });
  if (!addResult.ok) {
    throw new Error(addResult.error ?? 'Failed to persist agent to authoritative state store');
  }

  // Add to in-memory lists
  discoveredAgents.push(agent);

  // Add to daemon state (stopped by default)
  if (inMemoryState) {
    inMemoryState.agents.push({
      agentId: agent.id,
      agentName: agent.name,
      tokenPrefix: '',
      status: 'stopped',
      enabled: false,
      startedAt: new Date().toISOString(),
    });
    writeDaemonState(inMemoryState);
  }

  refreshCredentialBrokerAgentSockets();
  daemonLinkClient?.sendAgentDelta(agent.id, 'created');
  console.log(`[daemon] Created local agent: ${agent.name} (@${agent.username}) [${agent.id}]`);
  return agent;
}

/**
 * Delete a local agent at runtime. Stops it if running, removes from
 * in-memory state and agents.json.
 */
export function deleteLocalAgentAtRuntime(agentId: string): { ok: boolean; error?: string } {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) {
    return { ok: false, error: 'Agent not found' };
  }
  // The daemon owns k3s-native objects. Remove them while the full AgentInfo is
  // still available; otherwise deleting the desired-state row can orphan a
  // running Deployment that no later reconcile can map back to its storage.
  if (isK8sAgent(agent)) {
    try {
      deleteAgentK8s(agent);
    } catch (err) {
      return { ok: false, error: `Failed to delete k3s-native workload: ${(err as Error).message}` };
    }
  }
  // Remove from authoritative persistence before mutating runtime memory or
  // compat files. A failed store delete must not make the live daemon forget an
  // agent that still exists in the desired-state DB.
  const removeResult = removeAgent(agentId);
  if (!removeResult.ok) {
    return { ok: false, error: removeResult.error ?? 'Failed to remove agent from authoritative state store' };
  }

  // Stop if running
  const child = childProcesses.get(agentId);
  if (child && !child.killed) {
    child.kill('SIGTERM');
    childProcesses.delete(agentId);
  }

  // Remove from in-memory
  discoveredAgents = discoveredAgents.filter((a) => a.id !== agentId);
  if (inMemoryState) {
    inMemoryState.agents = inMemoryState.agents.filter((a) => a.agentId !== agentId);
    writeDaemonState(inMemoryState);
  }

  // Remove from enabled/disabled compat sets after the authoritative row is gone.
  const enabled = readEnabledAgents();
  const disabled = readDisabledAgents();
  enabled.delete(agentId);
  disabled.delete(agentId);
  disabled.delete(agent.username);
  writeEnabledAgents(enabled);
  writeDisabledAgents(disabled);

  refreshCredentialBrokerAgentSockets();
  daemonLinkClient?.sendAgentDeleted(agentId, agent.username);
  console.log(`[daemon] Deleted local agent: ${agent.name} (@${agent.username}) [${agentId}]`);
  return { ok: true };
}

/**
 * Map a model id to the execution method that can actually run it.
 * Mirrors the family checks in the k8s spawn path (claude_code_server requires
 * claude-*, codex_app_server requires gpt-*, etc.); everything else runs on the
 * provider-agnostic shizuha gateway.
 */
function executionMethodForModel(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.startsWith('opus') || m.startsWith('sonnet') || m.startsWith('haiku')) return 'claude_code_server';
  if (m.startsWith('gpt-5') || m.startsWith('gpt-oss') || m.startsWith('codex')) return 'codex_app_server';
  if (m.startsWith('gemini')) return 'gemini_cli_server';
  return 'shizuha';
}

/**
 * Update a local agent's configuration at runtime.
 */
export function updateLocalAgentAtRuntime(
  agentId: string,
  updates: Record<string, unknown>,
  runtimeLane?: DaemonLinkRuntimeLaneContext,
  opts: { rejectUnappliedFields?: boolean } = {},
): { ok: boolean; error?: string } {
  const agent = discoveredAgents.find((a) => a.id === agentId);
  if (!agent) {
    return { ok: false, error: 'Agent not found' };
  }
  if ('credentials' in updates) {
    return {
      ok: false,
      error: 'AgentCredential grants are broker-managed; use agent_grant_credential / agent_revoke_credential instead of direct agent updates',
    };
  }
  if ('ssh_keys' in updates) {
    return {
      ok: false,
      error: 'ssh_keys is broker-managed; use agent_grant_credential(scope="fleet-ssh") / agent_revoke_credential instead of direct agent updates',
    };
  }
  // HIVE-752 (Symptom 2): the REST control-proxy PATCH must not return a false
  // success for fields it silently drops. When the caller opts in
  // (rejectUnappliedFields), reject any field this endpoint does not apply
  // (e.g. `status`) with a 400 instead of 200-ing it away. Deliberately NOT
  // enabled for the daemon-link / WS config paths, which legitimately funnel
  // Hive-normalized frames (normalizeConfigUpdates + CONFIG_KEY_MAP) that may
  // pass through keys beyond this set — rejecting there would break config
  // delivery. The set mirrors exactly the fields applied below.
  if (opts.rejectUnappliedFields) {
    const RECOGNIZED_UPDATE_FIELDS = new Set([
      'credentials', 'ssh_keys', 'name', 'username', 'email', 'role',
      'execution_method', 'env', 'runtime_environment', 'skills', 'eager_skills',
      'enabled_mcp_server_ids', 'personality_traits', 'model_fallbacks',
      'model_overrides', 'reasoning_effort', 'model', 'failover_chain_id',
      'context_prompt', 'resource_limits', 'agent_memory', 'work_schedule',
      'token_budget', 'max_concurrent_tasks', 'allow_parallel_execution',
      'warm_pool_size', 'tier',
    ]);
    const unappliedFields = Object.keys(updates).filter((k) => !RECOGNIZED_UPDATE_FIELDS.has(k));
    if (unappliedFields.length > 0) {
      return {
        ok: false,
        error: `Unsupported field(s) not applied: ${unappliedFields.join(', ')}. This endpoint updates agent runtime config only; these fields would have been dropped silently.`,
      };
    }
  }

  // Validate runtime environment switch
  if (updates.runtime_environment != null) {
    const target = updates.runtime_environment as string;
    if ((target === 'container' || target === 'restricted_container' || target === 'sandbox') && !isDockerAvailable()) {
      return { ok: false, error: 'Docker is not installed or not accessible. Install Docker and ensure the current user has access before switching to container mode.' };
    }
  }

  // PLAT-394: fail-closed codex model validation at the runtime mutation
  // chokepoint. Every agent config write — REST PATCH, WS agents.update/create,
  // and any future caller — funnels through here, so validating at this single
  // point means an invalid codex model can NEVER be persisted even if a front
  // handler forgets to check (the on-host daemon PATCH bypass QA hit on
  // PLAT-394). An invalid codex model → HTTP 400 from the backend → silent
  // empty turns, the root cause of the PLAT-392 35-57h fleet outage.
  //
  // Only validate when a model/failover field is actually being changed, so an
  // unrelated edit (e.g. skills, schedule) is not rejected because the already
  // persisted config happens to be invalid — and a remediation that REPLACES a
  // bad chain with a valid one still passes (we validate the incoming value).
  if (updates.model_fallbacks !== undefined || updates.model_overrides !== undefined) {
    const newFallbacks = (updates.model_fallbacks ?? agent.modelFallbacks ?? []) as Array<{ method: string; model: string }>;
    const newOverrides = (updates.model_overrides ?? agent.modelOverrides ?? {}) as Record<string, string>;
    const modelErr = validateCodexModelChain(newFallbacks, newOverrides);
    if (modelErr) return { ok: false, error: modelErr };
  }
  if ('failover_chain_id' in updates && updates.failover_chain_id != null && updates.failover_chain_id !== '') {
    const namedChain = getFailoverChain(updates.failover_chain_id as string);
    if (namedChain) {
      const chainErr = validateCodexModelChain(namedChain.steps);
      if (chainErr) return { ok: false, error: `Named chain "${updates.failover_chain_id as string}": ${chainErr}` };
    }
  }

  // Build the proposed config without mutating the live in-memory row.
  // PLAT-1062 P4a-2: updateAgentConfig is now the store-owned fail-closed
  // persistence gate. Mutating discoveredAgents before checking that result lets
  // a locked/unavailable AgentStateStore take effect in the running daemon even
  // though the authoritative SQLite write refused it. Commit to memory only
  // after persistence succeeds, then refresh sockets/restart from that committed
  // state.
  const proposedAgent: AgentInfo = { ...agent };
  if (runtimeLane) {
    proposedAgent.runtimeLaneGeneration = runtimeLane.desiredGeneration;
    proposedAgent.runtimeLaneDigest = runtimeLane.runtimeLaneDigest;
  }
  if (updates.name != null) proposedAgent.name = updates.name as string;
  if (updates.username != null) proposedAgent.username = updates.username as string;
  if (updates.email != null) proposedAgent.email = updates.email as string;
  if (updates.role != null) proposedAgent.role = updates.role as string | null;
  if (updates.execution_method != null) proposedAgent.executionMethod = updates.execution_method as string;
  if ('env' in updates) {
    const rawEnv = updates.env;
    if (rawEnv == null) {
      proposedAgent.env = undefined;
    } else if (typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
      proposedAgent.env = Object.fromEntries(
        Object.entries(rawEnv as Record<string, unknown>)
          .filter(([key, value]) => key.trim().length > 0 && value != null && String(value).trim().length > 0)
          .map(([key, value]) => [key, String(value)])
      );
    } else {
      return { ok: false, error: 'env must be an object mapping env var names to string values' };
    }
  }
  if (updates.runtime_environment != null) {
    proposedAgent.runtimeEnvironment = normalizeRuntimeEnvironment(
      updates.runtime_environment as string,
      isDockerAvailable() ? 'container' : 'bare_metal',
    );
  }
  if (updates.skills != null) {
    if (!Array.isArray(updates.skills) || !updates.skills.every((s) => typeof s === 'string')) {
      return { ok: false, error: 'skills must be an array of strings' };
    }
    proposedAgent.skills = updates.skills as string[];
  }
  if (updates.eager_skills != null) {
    if (!Array.isArray(updates.eager_skills) || !updates.eager_skills.every((s) => typeof s === 'string')) {
      return { ok: false, error: 'eager_skills must be an array of strings' };
    }
    proposedAgent.eagerSkills = updates.eager_skills as string[];
  }
  if (updates.enabled_mcp_server_ids != null) {
    const raw = updates.enabled_mcp_server_ids;
    if (!Array.isArray(raw)) {
      return { ok: false, error: 'enabled_mcp_server_ids must be an array' };
    }
    const servers: AgentInfo['mcpServers'] = [];
    for (const entry of raw) {
      if (typeof entry === 'string') {
        servers.push({ name: entry, slug: entry, command: '', args: [], env: {}, transportType: 'stdio' });
      } else if (entry && typeof entry === 'object' && typeof (entry as { slug?: unknown }).slug === 'string') {
        const server = entry as Record<string, unknown>;
        servers.push({
          name: typeof server.name === 'string' ? server.name : server.slug as string,
          slug: server.slug as string,
          command: typeof server.command === 'string' ? server.command : '',
          args: Array.isArray(server.args) ? server.args : [],
          env: server.env && typeof server.env === 'object' && !Array.isArray(server.env)
            ? server.env as Record<string, string>
            : {},
          transportType: typeof server.transportType === 'string' ? server.transportType : 'stdio',
        });
      } else {
        return { ok: false, error: 'enabled_mcp_server_ids entries must be slugs or MCP server objects' };
      }
    }
    proposedAgent.mcpServers = servers;
  }
  if (updates.personality_traits != null) proposedAgent.personalityTraits = updates.personality_traits as Record<string, string>;
  if (updates.model_fallbacks != null) {
    proposedAgent.modelFallbacks = updates.model_fallbacks as AgentInfo['modelFallbacks'];
    // Keep display/primary model aligned with the Hive-authored chain head
    // (Agents UI SoT: convert harness/model via PATCH, not ad-hoc agents.json edits).
    const head = Array.isArray(updates.model_fallbacks)
      ? (updates.model_fallbacks as Array<{ method?: string; model?: string }>)[0]
      : undefined;
    if (head?.model) proposedAgent.model = head.model;
  }
  if (updates.model_overrides != null) proposedAgent.modelOverrides = updates.model_overrides as Record<string, string>;
  if ('reasoning_effort' in updates) {
    const method = String(updates.execution_method ?? proposedAgent.executionMethod ?? '').trim();
    if (!method) return { ok: false, error: 'reasoning_effort requires an execution method' };
    const key = `${method}_reasoning_effort`;
    proposedAgent.modelOverrides = { ...(proposedAgent.modelOverrides ?? {}) };
    const effort = String(updates.reasoning_effort ?? '').trim();
    if (effort) proposedAgent.modelOverrides[key] = effort;
    else delete proposedAgent.modelOverrides[key];
  }
  if (updates.model != null && typeof updates.model === 'string' && updates.model.trim()) {
    proposedAgent.model = updates.model.trim();
    const method = String(updates.execution_method ?? proposedAgent.executionMethod ?? '').trim();
    // A full Hive desired-config frame carries model_overrides explicitly,
    // including the canonical empty object. Respect that exact value. Adding a
    // method→model entry after applying the explicit field made every daemon
    // reconnect reintroduce hidden local state, so the next SSOT refresh
    // repaired the same fleet-wide drift again. Model-only UI mutations still
    // need the compatibility override synthesized below.
    if (method && updates.model_overrides === undefined) {
      proposedAgent.modelOverrides = { ...(proposedAgent.modelOverrides ?? {}), [method]: proposedAgent.model };
    }
    // A model-only push (the Hive UI model picker sends `model` without
    // `model_fallbacks`) must not leave the failover-chain head pointing at the
    // old model/method: k8s spawn derives the runtime command from the chain
    // head, so a stale head launches e.g. a plain gateway for a Claude model —
    // which has no broker-token auth path and crashloops (hiro, 2026-07-09).
    if (updates.model_fallbacks == null && Array.isArray(proposedAgent.modelFallbacks) && proposedAgent.modelFallbacks.length > 0) {
      const head = proposedAgent.modelFallbacks[0]!;
      if (head.model !== proposedAgent.model) {
        const method = executionMethodForModel(proposedAgent.model);
        proposedAgent.modelFallbacks = [
          method === head.method ? { ...head, model: proposedAgent.model } : { method, model: proposedAgent.model },
          ...proposedAgent.modelFallbacks.slice(1),
        ];
        if (updates.execution_method == null) proposedAgent.executionMethod = method;
      }
    }
  }
  if (updates.context_prompt != null) proposedAgent.contextPrompt = updates.context_prompt as string;
  if (updates.resource_limits != null) proposedAgent.resourceLimits = updates.resource_limits as AgentInfo['resourceLimits'];
  // Platform-aligned fields
  if (updates.agent_memory != null) proposedAgent.agentMemory = updates.agent_memory as string;
  if (updates.work_schedule != null) proposedAgent.workSchedule = updates.work_schedule as AgentInfo['workSchedule'];
  if (updates.token_budget != null) proposedAgent.tokenBudget = updates.token_budget as AgentInfo['tokenBudget'];
  if (updates.max_concurrent_tasks != null) proposedAgent.maxConcurrentTasks = updates.max_concurrent_tasks as number;
  if (updates.allow_parallel_execution != null) proposedAgent.allowParallelExecution = updates.allow_parallel_execution as boolean;
  if (updates.warm_pool_size != null) proposedAgent.warmPoolSize = updates.warm_pool_size as number;
  if (updates.tier != null) proposedAgent.tier = updates.tier as AgentInfo['tier'];
  if ('failover_chain_id' in updates) proposedAgent.failoverChainId = updates.failover_chain_id as string | undefined;

  // Snapshot pre-mutate values for restart decisions (mutateAgentInPlace is
  // in-place; comparing proposed vs agent after mutate would always look equal).
  const before = {
    runtimeEnvironment: agent.runtimeEnvironment,
    modelFallbacks: agent.modelFallbacks,
    modelOverrides: agent.modelOverrides,
    model: agent.model,
    executionMethod: agent.executionMethod,
    runtimeLaneGeneration: agent.runtimeLaneGeneration,
    runtimeLaneDigest: agent.runtimeLaneDigest,
    mcpServers: agent.mcpServers,
    skills: agent.skills,
    eagerSkills: agent.eagerSkills,
    contextPrompt: agent.contextPrompt,
    env: agent.env,
    sshKeys: (agent as { sshKeys?: unknown }).sshKeys,
  };

  // Persist before changing the live daemon object.
  if (!updateAgentConfig(agentId, proposedAgent)) {
    return { ok: false, error: 'Failed to persist agent config to authoritative state store' };
  }
  mutateAgentInPlace(agent, proposedAgent);
  refreshCredentialBrokerAgentSockets();
  daemonLinkClient?.sendAgentDelta(agentId, 'config');

  // Update daemon state name if changed
  if (inMemoryState && updates.name != null) {
    const ds = inMemoryState.agents.find((a) => a.agentId === agentId);
    if (ds) ds.agentName = updates.name as string;
    writeDaemonState(inMemoryState);
  }

  // Restart ONLY when runtime-affecting values actually changed.
  // Hive daemon-link reconnect pushes a full desired-config frame for every
  // agent (including runtime_environment) — treating key presence as change
  // re-applied the whole fleet on every seed/reconnect and Recreate-thrashed
  // pods (2026-07-09: 200 "runtime environment changed" re-applies / 2m).
  const stable = (v: unknown) => JSON.stringify(v ?? null);
  const runtimeChanged = updates.runtime_environment != null
    && proposedAgent.runtimeEnvironment !== before.runtimeEnvironment;
  const modelChainChanged = (updates.model_fallbacks != null
      && stable(proposedAgent.modelFallbacks) !== stable(before.modelFallbacks))
    || (updates.model_overrides != null
      && stable(proposedAgent.modelOverrides) !== stable(before.modelOverrides))
    || (updates.model != null
      && (proposedAgent.model ?? '') !== (before.model ?? ''));
  const reasoningChanged = 'reasoning_effort' in updates
    && stable(proposedAgent.modelOverrides) !== stable(before.modelOverrides);
  const methodChanged = updates.execution_method != null
    && proposedAgent.executionMethod !== before.executionMethod;
  const runtimeLaneFenceChanged = runtimeLane !== undefined
    && (proposedAgent.runtimeLaneGeneration !== before.runtimeLaneGeneration
      || proposedAgent.runtimeLaneDigest !== before.runtimeLaneDigest);
  const mcpChanged = updates.enabled_mcp_server_ids != null
    && stable(proposedAgent.mcpServers) !== stable(before.mcpServers);
  const skillsChanged = (updates.skills != null
      && stable(proposedAgent.skills) !== stable(before.skills))
    || (updates.eager_skills != null
      && stable(proposedAgent.eagerSkills) !== stable(before.eagerSkills));
  const promptChanged = updates.context_prompt != null
    && (proposedAgent.contextPrompt ?? '') !== (before.contextPrompt ?? '');
  const envChanged = 'env' in updates
    && stable(proposedAgent.env) !== stable(before.env);
  const sshChanged = updates.ssh_keys != null
    && stable((proposedAgent as { sshKeys?: unknown }).sshKeys) !== stable(before.sshKeys);
  const needsRestart = runtimeChanged || modelChainChanged || reasoningChanged || methodChanged
    || runtimeLaneFenceChanged || mcpChanged || skillsChanged || promptChanged || envChanged || sshChanged;

  if (needsRestart) {
    const reason = runtimeChanged ? 'runtime environment'
      : modelChainChanged ? 'model chain'
      : methodChanged ? 'execution method'
      : promptChanged ? 'context prompt'
      : 'execution settings';
    // k8s-native agents have no local child process — must re-apply the
    // Deployment so SHIZUHA_K8S_PRIMARY_* / MODEL_FALLBACKS env (and bridge
    // command) match the Hive-authored convert. Host/docker agents kill the
    // child and let the supervisor respawn.
    // startAgentProcess owns the effective runtime resolution and live-hash
    // comparison. Do not pre-compute the hash here from the stored AgentInfo:
    // that can reuse the previous resolved-runtime cache and suppress a real
    // context-prompt/execution-method change before the authoritative resolver
    // gets a chance to see it (PLAT-4546). An identical repeated update never
    // reaches this branch because needsRestart is based on actual mutation;
    // any effective no-op that does reach it converges inside startAgentProcess.
    if (shouldSpawnK8sAgent(agent) && daemonConfig) {
      console.log(`[daemon] ${reason} changed — reconciling k8s runtime for ${agent.name}...`);
      void runtimeUpdateAgentStarter(agent, tokenCache.get(agent.id) ?? '', daemonConfig).then((err) => {
        if (err) {
          console.warn(`[daemon] k8s re-apply after config change failed for ${agent.name}: ${err}`);
          updateAgentInMemory(agent.id, { status: 'error', error: `k8s re-apply after config change failed: ${err}` });
        }
      }).catch((err) => {
        console.warn(`[daemon] k8s re-apply after config change failed for ${agent.name}: ${(err as Error).message}`);
      });
    } else if (!shouldSpawnK8sAgent(agent)) {
      const child = childProcesses.get(agentId);
      if (child && !child.killed) {
        console.log(`[daemon] ${reason} changed — restarting ${agent.name}...`);
        const containerName = `shizuha-agent-${agent.username}`;
        try {
          execSync(`${resolveDockerPath()} rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore' });
        } catch { /* ignore */ }
        child.kill('SIGTERM');
        // The exit handler will auto-restart since the agent is still enabled
      }
    }
  }

  return { ok: true };
}
