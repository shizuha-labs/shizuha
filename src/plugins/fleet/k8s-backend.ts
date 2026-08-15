/**
 * k3s-native agent backend.
 *
 * The daemon is the single writer for per-agent k8s Deployments in shizuha-fleet:
 * enable/start applies the Deployment, disable/stop scales it to zero, and the
 * daemon reconcile loop repairs drift. Hive/control-plane code should send intent
 * to the daemon rather than patching these objects directly.
 *
 * Requirements for the k8s-mode daemon pod: `kubectl` on PATH + a ServiceAccount
 * with RBAC to manage deployments/secrets/pvcs in the fleet namespace.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import { agentEffectiveCapabilityEnv } from '../../platform/effective-capabilities.js';
import type { AgentInfo } from '../../daemon/types.js';
import { HEARTBEAT_OUTCOME_LOG_PREFIX } from '../../daemon/heartbeat-outcome.js';
import { isAgentCredentialGrantCurrentlyActive, normalizeAgentCredential } from '../../daemon/agent-credential.js';
import {
  RUNTIME_COMMAND_BY_EXECUTION_METHOD,
  runtimeCommandForExecutionMethod,
} from '../../daemon/runtime-lane-methods.js';
import {
  canonicalRuntimeImage,
  desiredRuntimeRelease,
  loadDesiredRuntimeReleaseDocument,
  runtimeReleaseDocumentFingerprint,
  sameRuntimeRelease,
  RUNTIME_RELEASE_DIGEST_ANNOTATION,
  RUNTIME_RELEASE_GENERATION_ANNOTATION,
  validateRuntimeReleaseProjections,
  type DesiredRuntimeRelease,
} from '../../daemon/runtime-release.js';

const execFileAsync = promisify(execFile);

const K8S_NS = process.env['SHIZUHA_FLEET_NAMESPACE'] ?? 'shizuha-fleet';
// Let k3s place agent pods across the Ready GB10 pool. Set SHIZUHA_FLEET_NODE_SELECTOR
// only for a deliberate break-glass pin; the default must not concentrate the fleet on
// one node or tolerate unrelated NoSchedule taints.
const K8S_NODE_SELECTOR = process.env['SHIZUHA_FLEET_NODE_SELECTOR'] || '';
const AGENT_IMAGE = process.env['SHIZUHA_AGENT_RUNTIME_IMAGE']
  ?? 'localhost:30500/shizuha-agent-runtime:fleetcurrent-20260708-contextfit';
const BROKER_IMAGE = process.env['SHIZUHA_BROKER_IMAGE']
  ?? 'localhost:30500/mcp-auth-proxy:src-1e39eb82917a';
const PLATFORM_URL = process.env['SHIZUHA_PLATFORM_SVC_URL'] ?? 'http://shizuha-nginx.shizuha.svc.cluster.local';
const ID_BASE_URL = PLATFORM_URL; // password-mint path /id/api/auth/login/ is nginx-routed (NOT shizuha-id direct)
const COORDINATOR_URL = process.env['SHIZUHA_COORDINATOR_MODEL_TOKEN_URL']
  ?? 'http://hive.shizuha-hive.svc.cluster.local:8030/hive/api/v1/coordinator/model-token';
const BROKER_TOKEN_SECRET = process.env['SHIZUHA_BROKER_TOKEN_SECRET'] ?? 'hive-coordinator-broker-token';
const KUBECTL_BIN = process.env['KUBECTL_BIN']
  || ['/usr/local/bin/kubectl', '/usr/bin/kubectl', '/snap/bin/kubectl']
    .find((candidate) => fs.existsSync(candidate))
  || 'kubectl';
const GITHUB_AUTH_PROBE_REPO = process.env['SHIZUHA_GITHUB_AUTH_PROBE_REPO'] ?? 'shizuha-labs/shizuha-beta';
const GITHUB_AUTH_PROBE_TIMEOUT_MS = Math.max(1_000, Number(process.env['SHIZUHA_GITHUB_AUTH_PROBE_TIMEOUT_MS'] ?? '20000'));
const GITHUB_AUTH_PROBE_MAX_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env['SHIZUHA_GITHUB_AUTH_PROBE_MAX_ATTEMPTS'] ?? '2')));
const GITHUB_AUTH_PROBE_RETRY_DELAY_MS = Math.max(0, Number(process.env['SHIZUHA_GITHUB_AUTH_PROBE_RETRY_DELAY_MS'] ?? '750'));
const RUNTIME_LANE_PROBE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env['SHIZUHA_RUNTIME_LANE_PROBE_TIMEOUT_MS'] ?? '10000'),
);
const HARNESS_ROLL_BUSY_PROBE_TIMEOUT_MS = (() => {
  const configured = Number(process.env['SHIZUHA_HARNESS_ROLL_BUSY_PROBE_TIMEOUT_MS'] ?? '8000');
  return Number.isFinite(configured)
    ? Math.min(15_000, Math.max(1_000, configured))
    : 8_000;
})();
interface RuntimeRollLeaseBackoff {
  until: number;
  /** True only when the bridge endpoint actually armed a drain lease. */
  reserved: boolean;
}

const runtimeRollLegacyLeaseBackoffUntil = new Map<string, RuntimeRollLeaseBackoff>();
const LEGACY_DRAIN_BACKLOG_GRACE_MS = 5_000;


export interface K8sSpawnOpts {
  command: 'claude-bridge' | 'codex-bridge' | 'openclaw-bridge' | 'gateway' | string;
  model: string;
  effort?: string;
  contextPrompt: string;
  password: string;
  githubToken?: string;
  /** SCLI-331: force this exact agent-runtime image. The idle-gated harness
   * roller passes desiredAgentImage() to roll one agent; ordinary applies
   * leave this unset so spawnAgentK8s PRESERVES the agent's current live image
   * (harness upgrades never ride a config change or a daemon restart). */
  imageOverride?: string;
  /** Force this exact credential-broker sidecar image. The same idle-gated
   * roller used for harness updates passes this only after the agent is quiet;
   * ordinary config applies preserve the live broker image. */
  brokerImageOverride?: string;
  /** Authoritative release stamped by the idle-gated roller. */
  runtimeRelease?: DesiredRuntimeRelease;
  /** Files materialized from the daemon-owned fleet-ssh grant for host-plane agents. */
  fleetSshFiles?: Record<string, string>;
}

export interface K8sDeploymentState {
  /** Agent id if known from the daemon's agent list; otherwise the username parsed from deploy/agent-<username>. */
  agentId: string;
  username: string;
  name: string;
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  generation?: number;
  observedGeneration?: number;
  updatedReplicas?: number;
  /** PLAT-4958: `.status.conditions[type=Progressing].reason`. Kubernetes sets
   * `ReplicaSetUpdated` while a rollout is mid-flight and `NewReplicaSetAvailable`
   * once it has settled, which is the only field that distinguishes "new pod is
   * still starting" from "pod is broken" — the replica counts are identical in
   * both cases (`replicas=1, updated=1, ready=0, available=0`). */
  progressingReason?: string;
  /** PLAT-4958: `.status.conditions[type=Progressing].lastUpdateTime`, epoch ms.
   * Bounds how long the rollout suppression may last — see
   * K8S_ROLLOUT_SUPPRESS_WINDOW_MS. Without it the suppression would silently
   * inherit `progressDeadlineSeconds` (600s on every agent Deployment). */
  progressingUpdatedAtMs?: number;
  /** SCLI-331: live image of the `agent` container, for idle-gated per-agent
   * harness rolls (empty string when unreadable). */
  currentImage?: string;
  /** Optimistic-concurrency token from the exact Deployment GET. */
  resourceVersion?: string;
  /** Live image of the workspace-permissions init container when that optional
   * legacy/modern pod-contract member exists. If present it must advance with
   * the agent container; absence is preserved by release-only CAS mutation. */
  currentWorkspaceInitImage?: string;
  /** Live image of the `broker` sidecar, for idle-gated credential-broker
   * upgrades. Keeping this separate prevents a broker fix from bouncing the
   * entire fleet or riding an unrelated config apply. */
  currentBrokerImage?: string;
  runtimeReleaseGeneration?: number;
  runtimeReleaseDigest?: string;
  /** PLAT-3625: live MCP/capability config hash annotation, when stamped. */
  configHash?: string;
  /** Stable pod-contract revision. Changes roll through the same idle-gated,
   * bounded path as image updates instead of bouncing the fleet. */
  runtimeSpecRevision?: string;
  /** Client-side apply metadata or the live pod template contains duplicate
   * env names. This must be repaired before the boot-idempotency fast path can
   * treat the Deployment as converged. */
  duplicateEnvMetadata?: boolean;
  /** True when the roster says this agent should receive GITHUB_TOKEN. */
  githubCredentialExpected?: boolean;
  /** True when the agent container's GITHUB_TOKEN env points at <user>-agent-creds/GITHUB_TOKEN. */
  githubTokenEnvWired?: boolean;
  /** True when the live <user>-agent-creds Secret contains a non-empty GITHUB_TOKEN data key. */
  githubTokenSecretPresent?: boolean;
  /** Source-of-truth credential grant exists, but live Deployment/Secret would not inject it. */
  githubCredentialDrift?: boolean;
}

export interface K8sRuntimeLaneProbe {
  generation: number;
  digest: string;
  brokerReady: boolean;
  runtime: Record<string, unknown>;
}

export interface K8sRuntimeRollBridgePreparation {
  busy: boolean;
  protocol: 'drain-v1' | 'drain-v2' | 'legacy-health';
  fenceVersion?: number;
  /** A live drain request reserved this bridge's next persisted boundary. */
  drainReserved?: boolean;
}

export interface K8sLegacyGatewayCheckpoint {
  sessionId: string;
  toolResultAt: number;
}

type K8sEnvEntry = { name?: string; [key: string]: unknown };
type K8sPodContainer = { env?: K8sEnvEntry[]; [key: string]: unknown };

function dedupeK8sEnv(entries: K8sEnvEntry[] | undefined): { entries: K8sEnvEntry[]; changed: boolean } {
  const ordered: K8sEnvEntry[] = [];
  const indexByName = new Map<string, number>();
  let changed = false;
  for (const entry of entries ?? []) {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (!name || !indexByName.has(name)) {
      if (name) indexByName.set(name, ordered.length);
      ordered.push(entry);
      continue;
    }
    ordered[indexByName.get(name)!] = entry;
    changed = true;
  }
  return { entries: ordered, changed };
}

function normalizePodSpecEnv(podSpec: Record<string, unknown> | undefined): boolean {
  let changed = false;
  for (const field of ['containers', 'initContainers'] as const) {
    const containers = podSpec?.[field];
    if (!Array.isArray(containers)) continue;
    for (const container of containers as K8sPodContainer[]) {
      const normalized = dedupeK8sEnv(container.env);
      if (!normalized.changed) continue;
      container.env = normalized.entries;
      changed = true;
    }
  }
  return changed;
}

export function normalizeAgentDeploymentEnvMetadata(raw: string): {
  document: Record<string, unknown>;
  changed: boolean;
} {
  const document = JSON.parse(raw) as Record<string, unknown>;
  const spec = document['spec'] as Record<string, unknown> | undefined;
  const template = spec?.['template'] as Record<string, unknown> | undefined;
  const podSpec = template?.['spec'] as Record<string, unknown> | undefined;
  return { document, changed: normalizePodSpecEnv(podSpec) };
}

function duplicateEnvMetadataInDeployment(document: Record<string, unknown>): boolean {
  const spec = structuredClone(document['spec']) as Record<string, unknown> | undefined;
  const template = spec?.['template'] as Record<string, unknown> | undefined;
  const podSpec = template?.['spec'] as Record<string, unknown> | undefined;
  if (normalizePodSpecEnv(podSpec)) return true;
  const metadata = document['metadata'] as Record<string, unknown> | undefined;
  const annotations = metadata?.['annotations'] as Record<string, unknown> | undefined;
  const lastApplied = annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
  if (typeof lastApplied !== 'string' || !lastApplied) return false;
  try {
    return normalizeAgentDeploymentEnvMetadata(lastApplied).changed;
  } catch {
    return false;
  }
}

/** Repair duplicate env-list keys left by an older renderer in both the live
 * pod template and kubectl's client-side-apply baseline. JSON Patch avoids the
 * strategic-merge `$setElementOrder` path that the invalid list would poison;
 * the resourceVersion test makes a concurrent controller write fail safely and
 * retry on the next reconcile tick. */
export function repairAgentK8sDuplicateEnvMetadata(agent: AgentInfo): boolean {
  const raw = kubectl(['get', '-n', K8S_NS, `deployment/agent-${agent.username}`, '-o', 'json']);
  const live = JSON.parse(raw) as Record<string, unknown>;
  const metadata = live['metadata'] as Record<string, unknown> | undefined;
  const resourceVersion = metadata?.['resourceVersion'];
  if (typeof resourceVersion !== 'string' || !resourceVersion) {
    throw new Error(`agent-${agent.username}: Deployment resourceVersion is missing`);
  }

  const operations: Array<Record<string, unknown>> = [
    { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
  ];
  const spec = live['spec'] as Record<string, unknown> | undefined;
  const template = spec?.['template'] as Record<string, unknown> | undefined;
  const podSpec = template?.['spec'] as Record<string, unknown> | undefined;
  for (const field of ['containers', 'initContainers'] as const) {
    const containers = podSpec?.[field];
    if (!Array.isArray(containers)) continue;
    containers.forEach((container, index) => {
      const normalized = dedupeK8sEnv((container as K8sPodContainer).env);
      if (!normalized.changed) return;
      operations.push({
        op: 'replace',
        path: `/spec/template/spec/${field}/${index}/env`,
        value: normalized.entries,
      });
    });
  }

  const annotations = metadata?.['annotations'] as Record<string, unknown> | undefined;
  const lastApplied = annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
  if (typeof lastApplied === 'string' && lastApplied) {
    try {
      const normalized = normalizeAgentDeploymentEnvMetadata(lastApplied);
      if (normalized.changed) {
        operations.push({
          op: 'replace',
          path: '/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration',
          value: JSON.stringify(normalized.document),
        });
      }
    } catch (err) {
      throw new Error(
        `agent-${agent.username}: cannot parse kubectl last-applied configuration: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (operations.length === 1) return false;
  kubectl([
    'patch', '-n', K8S_NS, `deployment/agent-${agent.username}`,
    '--type=json', '-p', JSON.stringify(operations),
  ]);
  console.log(`[daemon] ${agent.name}: repaired duplicate k8s env metadata before reconcile`);
  return true;
}

export type K8sGitHubCredentialProbeReason =
  | 'ok'
  | 'credential_unwired'
  | 'deployment_unready'
  | 'github_token_empty'
  | 'github_api_failed'
  | 'github_upstream_unavailable'
  | 'probe_transport_failed'
  | 'probe_error';

export interface K8sGitHubCredentialProbeResult {
  agentId: string;
  username: string;
  team: string;
  ownerGroup: string;
  expected: boolean;
  ok: boolean;
  reason: K8sGitHubCredentialProbeReason;
  checkedAt: string;
  identity?: string;
  probeRepo?: string;
  detail?: string;
}

export function isK8sAgent(agent: AgentInfo | undefined): boolean {
  // Prefer per-agent runtimeEnvironment; also honor fleet-daemon env so a
  // mis-tagged bare_metal/container row cannot dual-spawn as a host process
  // when the control plane is the k3s rt-fleet daemon.
  const fleetK8s =
    (process.env['SHIZUHA_RUNTIME_BACKEND'] ?? '') === 'k8s'
    || (process.env['SHIZUHA_DAEMON_RUNTIME'] ?? '') === 'k8s';
  return !!agent && (agent.runtimeEnvironment === 'k8s' || fleetK8s);
}

function agentMcpSlugs(agent: AgentInfo): string[] {
  const explicit = (agent.mcpServers ?? []).map((server) => server.slug || server.name).filter(Boolean);
  const effective = agent.effectiveCapabilities?.source === 'hive' ? agent.effectiveCapabilities.mcpServers : [];
  return [...explicit, ...effective];
}

/**
 * PLAT-3625: capability/MCP env the agent container needs so the in-pod
 * bridges compose `.mcp.json` from the SAME grants the daemon knows about.
 * The bridges treat AGENT_EFFECTIVE_MCP_SERVICES as the authoritative
 * allow-list (SCLI-44/SCLI-64 prune path); without it a pod falls back to the
 * static role matrix and silently misses newly granted services (BKS-48: nao
 * had books in rt-fleet source config but not in the running pod).
 */
export function agentMcpEnv(agent: AgentInfo): Record<string, string> {
  const env = { ...agentEffectiveCapabilityEnv(agent) };
  const slugs = [...new Set(agentMcpSlugs(agent).map((s) => s.toLowerCase()))].sort();
  if (slugs.length > 0) {
    // Union of Hive effective grants + explicit agents.json mcpServers — the
    // pod must serve BOTH, so the allow-list env carries the union. When the
    // agent has neither, the key stays absent and the in-pod role-matrix
    // fallback keeps working as before.
    env['AGENT_EFFECTIVE_MCP_SERVICES'] = slugs.join(',');
  }
  return env;
}

/**
 * PLAT-3625: Deployment annotation carrying a stable hash of the MCP/
 * capability config the pod materializes at boot. The runtime-reconcile loop
 * re-applies a HEALTHY Deployment whose live annotation differs from the
 * desired hash, so capability grants propagate without per-agent manual
 * patching. A MISSING live annotation is deliberately NOT drift: bouncing
 * every legacy pod at once on first rollout of this feature would be a
 * fleet-wide restart storm — legacy pods get stamped on their next natural
 * re-apply instead.
 */
export const MCP_CONFIG_HASH_ANNOTATION = 'shizuha.io/mcp-config-hash';
export const K8S_RUNTIME_SPEC_REVISION_ANNOTATION = 'shizuha.io/runtime-spec-revision';
// Bump whenever the narrow runtime-template roller's owned contract changes.
// The roller uses this revision to refresh already-running and scaled-to-zero
// Deployments without requiring a full credential reprovision. In particular,
// Runtime pod wiring is manifest state (not part of the runtime image), so
// command/args, projected control-plane surfaces, and other pod-spec contracts
// must advance with this revision or an image-only rollout can leave stale
// behavior behind indefinitely.
export const K8S_RUNTIME_SPEC_REVISION = 'inline-failover-v6-privileged-kubeconfig-v1';

// Package-cache routes are part of the narrow runtime-template contract so
// existing pods converge without a full credential reprovision. APT_CACHE_URL
// is deliberately an explicit hint: child containers opt in by writing their
// own apt proxy config instead of inheriting a process-wide HTTP proxy.
const K8S_PACKAGE_CACHE_ENV = {
  APT_CACHE_URL: 'http://apt-cache.registry.svc.cluster.local:3142',
  NPM_CONFIG_REGISTRY: 'http://npm-cache.registry.svc.cluster.local:4873/',
  PIP_INDEX_URL: 'http://pip-cache.registry.svc.cluster.local/simple/',
  PIP_TRUSTED_HOST: 'pip-cache.registry.svc.cluster.local',
  UV_DEFAULT_INDEX: 'http://pip-cache.registry.svc.cluster.local/simple/',
  UV_INDEX_URL: 'http://pip-cache.registry.svc.cluster.local/simple/',
  UV_INSECURE_HOST: 'pip-cache.registry.svc.cluster.local',
};

const K8S_MODEL_POLICY_ANNOTATION = 'shizuha.io/model-policy';
const K8S_PRIMARY_MODEL_ANNOTATION = 'shizuha.io/primary-model';
const K8S_EXECUTION_METHOD_ANNOTATION = 'shizuha.io/execution-method';
const K8S_REASONING_EFFORT_ANNOTATION = 'shizuha.io/reasoning-effort';
const K8S_MODEL_POLICY = 'hive-sot-v1';

function k8sModelCompatibilityState(
  agent: AgentInfo,
  primaryModel = agent.model ?? agent.modelFallbacks?.[0]?.model ?? '',
  primaryEffort?: string,
): {
  model: string;
  method: string;
  effort: string;
  fallbacks: string;
  overrides: string;
} {
  const method = agent.executionMethod ?? agent.modelFallbacks?.[0]?.method ?? '';
  const explicitAgentEffort = (agent as AgentInfo & { reasoningEffort?: string }).reasoningEffort;
  const effort = primaryEffort
    ?? agent.modelFallbacks?.[0]?.reasoningEffort
    ?? agent.modelFallbacks?.[0]?.thinkingLevel
    ?? (method ? agent.modelOverrides?.[`${method}_reasoning_effort`] : undefined)
    ?? explicitAgentEffort
    ?? '';
  return {
    model: primaryModel,
    method,
    effort,
    fallbacks: stableStringify(agent.modelFallbacks ?? []),
    overrides: stableStringify(agent.modelOverrides ?? {}),
  };
}

export function agentPlatformEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // SEARCH_BASE_URL is daemon-owned platform configuration, not an agent
  // credential. K8s-native pods do not inherit the daemon process env, so the
  // backend must render this explicitly into the agent container template.
  const searchUrl = process.env['SEARCH_BASE_URL'];
  if (searchUrl) env['SEARCH_BASE_URL'] = searchUrl;
  // Heartbeat context budgets are platform tuning the gateway reads from its
  // OWN env — forward from the daemon env so the fleet manifest value actually
  // reaches agent pods. Without this, agents silently ran the cli defaults
  // (30k soft < ~48k fixed prompt overhead → bounded-context reset every
  // heartbeat → zero prefix-cache reuse → a full fresh prefill per heartbeat →
  // DeepSeek DP decode starvation, 2026-07-06). Being in platformEnv also puts
  // them in the drift hash, so a budget change rolls the fleet automatically.
  for (const k of [
    // Prefer *fraction* knobs (of announced max_model_len). Absolute token pins
    // are legacy and only apply when the window is unknown or BUDGET_MODE=absolute.
    'SHIZUHA_HEARTBEAT_CONTEXT_SOFT_FRACTION',
    'SHIZUHA_HEARTBEAT_CONTEXT_HARD_FRACTION',
    'SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS',
    'SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS',
    'SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE',
    'SHIZUHA_HEARTBEAT_PERSIST_TRIM_FRACTION',
    'SHIZUHA_HEARTBEAT_PERSIST_TRIM_TARGET_FRACTION',
    'SHIZUHA_CORTEX_COMPACTION_TRIGGER_FRACTION',
    'SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS',
  ]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

/**
 * Non-secret agent-store env knobs that must reach k8s-native pods.
 *
 * Hive/runtime PATCH stores per-agent tuning on `agent.env`, but the k8s
 * manifest historically only forwarded MCP grants + daemon platform env —
 * so SCLI-195 expensive-turn thresholds, idle-heartbeat intervals, etc. sat
 * in agents.json while pods kept defaults (false-pause storms under large
 * MCP context, 2026-07-09). Allow-list only SHIZUHA_* operational knobs;
 * credentials stay on secretKeyRef paths.
 *
 * Note: `SHIZUHA_EXPENSIVE_TURN_PROMPT_TOKENS` contains "TOKEN" and is
 * redacted by daemon-link sanitizeEnv for export, but it is NOT a secret —
 * it is a numeric threshold and must be rendered into the pod.
 */
export const AGENT_TUNING_ENV_KEYS = [
  'SHIZUHA_IDLE_HEARTBEAT_MS',
  'SHIZUHA_EXPENSIVE_TURN_GUARD_DISABLED',
  'SHIZUHA_EXPENSIVE_TURN_WINDOW_MS',
  'SHIZUHA_EXPENSIVE_TURN_MIN_TURNS',
  'SHIZUHA_EXPENSIVE_TURN_PROMPT_TOKENS',
  'SHIZUHA_EXPENSIVE_TURN_PROMPT_OUTPUT_RATIO',
  'SHIZUHA_EXPENSIVE_TURN_BACKOFF_MS',
  'SHIZUHA_EXPENSIVE_TURN_MAX_BACKOFF_MS',
  'SHIZUHA_EXPENSIVE_TURN_NOTIFY_COOLDOWN_MS',
  'SHIZUHA_EXPENSIVE_TURN_NOTIFY_USERNAME',
  'SHIZUHA_CORTEX_COMPACTION_TRIGGER_TOKENS',
  'SHIZUHA_CORTEX_COMPACTION_TRIGGER_FRACTION',
  'SHIZUHA_HEARTBEAT_CONTEXT_SOFT_FRACTION',
  'SHIZUHA_HEARTBEAT_CONTEXT_HARD_FRACTION',
  'SHIZUHA_HEARTBEAT_CONTEXT_BUDGET_MODE',
  'SHIZUHA_HEARTBEAT_PERSIST_TRIM_FRACTION',
  'SHIZUHA_HEARTBEAT_PERSIST_TRIM_TARGET_FRACTION',
  'VLLM_STREAM_WITH_TOOLS',
  'PLAYWRIGHT_BROWSERS_PATH',
  // PLAT-4238: NON-SECRET github identity pointer (e.g. 'sara2574'). Selects
  // which shared team-identity Secret the pod's GITHUB_TOKEN references.
  // Including it here also folds it into the config-drift hash, so an identity
  // change re-renders the Deployment.
  'GITHUB_IDENTITY',
] as const;

/**
 * PLAT-4238: the agent's assigned GitHub identity (team-based: read-only teams →
 * sara2574, write teams → kai2574), set by Hive as non-secret agent env. Strictly
 * validated — it becomes a k8s Secret NAME in the rendered manifest, so anything
 * not slug-shaped is ignored (fail-closed to the legacy agent-creds path).
 */
export function githubIdentityFor(agent: AgentInfo): string | undefined {
  const raw = String(agent.env?.['GITHUB_IDENTITY'] ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  return /^[a-z0-9][a-z0-9-]{0,30}$/.test(raw) ? raw : undefined;
}

export function agentTuningEnv(agent: AgentInfo): Record<string, string> {
  const env: Record<string, string> = {};
  const src = agent.env ?? {};
  for (const k of AGENT_TUNING_ENV_KEYS) {
    const v = src[k];
    if (v != null && String(v).trim() !== '') env[k] = String(v);
  }
  // Prefer agent-store heartbeat budgets when set; daemon platformEnv is the
  // fleet-wide fallback and is merged later (agent wins on conflict).
  for (const k of ['SHIZUHA_HEARTBEAT_CONTEXT_SOFT_TOKENS', 'SHIZUHA_HEARTBEAT_CONTEXT_HARD_TOKENS'] as const) {
    const v = src[k];
    if (v != null && String(v).trim() !== '') env[k] = String(v);
  }
  return env;
}

export interface K8sTeamSecretBinding {
  name: string;
  secretName: string;
  keys: string[];
}

const K8S_TEAM_SECRET_BINDING_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const K8S_TEAM_SECRET_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const K8S_SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Resolve only active, handle-only bindings from a signed HiveCredential read model. */
export function k8sTeamSecretBindingsForAgent(agent: AgentInfo): K8sTeamSecretBinding[] {
  const effective = agent.effectiveCapabilities;
  if (
    effective?.source !== 'hive'
    || effective.signatureVerified !== true
    || effective.trustedForSensitive !== true
    || effective.stale === true
  ) return [];
  const sourceMemberships = new Set((effective.sourceTeamMemberships ?? []).map((row) =>
    `${String(row.organizationSlug).trim().toLowerCase()}/${String(row.teamSlug).trim().toLowerCase()}`
  ));
  const eligibleMemberships = new Set((effective.teamCredentialEligibleMemberships ?? []).map((row) =>
    `${String(row.organizationSlug).trim().toLowerCase()}/${String(row.teamSlug).trim().toLowerCase()}`
  ));
  const selected = new Map<string, { secretName: string; keys: Set<string> }>();
  for (const descriptor of effective.credentialMaterializations ?? []) {
    if (descriptor.isActive !== true) continue;
    if (
      descriptor.scope !== 'team'
      || !descriptor.organizationSlug
      || !descriptor.teamSlug
      || !sourceMemberships.has(`${descriptor.organizationSlug}/${descriptor.teamSlug}`)
      || !eligibleMemberships.has(`${descriptor.organizationSlug}/${descriptor.teamSlug}`)
    ) continue;
    // Other providers/handle schemes are materialized by their owning broker
    // path.  This backend owns only generic-env files backed by a same-namespace
    // Kubernetes Secret.
    if (descriptor.provider !== 'generic-env' || !descriptor.secretRef.startsWith('k8s-secret://')) continue;
    let handle: URL;
    try {
      handle = new URL(descriptor.secretRef);
    } catch {
      throw new Error(`Hive credential materialization ${descriptor.grantId} has an invalid secret_ref handle`);
    }
    const namespace = handle.hostname;
    const secretName = handle.pathname.replace(/^\//, '');
    const key = decodeURIComponent(handle.hash.replace(/^#/, ''));
    if (handle.protocol !== 'k8s-secret:' || namespace !== K8S_NS || handle.search || secretName.includes('/')) {
      throw new Error(`Hive credential materialization ${descriptor.grantId} must reference a Secret in namespace ${K8S_NS}`);
    }
    if (!K8S_TEAM_SECRET_NAME_RE.test(secretName) || !K8S_SECRET_KEY_RE.test(key) || key.endsWith('_FILE')) {
      throw new Error(`Hive credential materialization ${descriptor.grantId} has an invalid Secret name/key`);
    }
    if (descriptor.purpose !== key) {
      throw new Error(`Hive credential materialization ${descriptor.grantId} must bind generic-env purpose to its exact Secret key`);
    }
    const bindingName = secretName.length <= 32
      ? secretName
      : `cred-${createHash('sha256').update(secretName).digest('hex').slice(0, 12)}`;
    if (!K8S_TEAM_SECRET_BINDING_NAME_RE.test(bindingName)) {
      throw new Error(`Hive credential materialization ${descriptor.grantId} produced an invalid binding name`);
    }
    const binding = selected.get(bindingName) ?? { secretName, keys: new Set<string>() };
    if (binding.secretName !== secretName) {
      throw new Error(`Hive credential materializations collide on binding name ${bindingName}`);
    }
    binding.keys.add(key);
    selected.set(bindingName, binding);
  }
  const resolved = [...selected.entries()].map(([name, binding]) => ({
    name,
    secretName: binding.secretName,
    keys: [...binding.keys].sort(),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const fileEnvOwners = new Map<string, string>();
  for (const binding of resolved) {
    for (const key of binding.keys) {
      const envName = `${key}_FILE`;
      const prior = fileEnvOwners.get(envName);
      if (prior && prior !== binding.name) {
        throw new Error(`Conflicting team Secret key ${key} in bindings ${prior} and ${binding.name}`);
      }
      fileEnvOwners.set(envName, binding.name);
    }
  }
  return resolved;
}

/**
 * Merge env layers without emitting duplicate Kubernetes list-map keys.
 *
 * The first appearance of a key fixes its position while later layers replace
 * only its value. This keeps the rendered manifest stable across reconciles
 * while preserving the intended precedence (defaults < platform < agent).
 */
export function mergeOrderedUniqueEnv(
  ...layers: ReadonlyArray<Readonly<Record<string, string>>>
): Array<[string, string]> {
  const merged = new Map<string, string>();
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer)) {
      merged.set(name, value);
    }
  }
  return [...merged.entries()];
}

/**
 * Deterministic serialization for the PLAT-3625 drift hash: object keys sorted
 * recursively, ARRAY order preserved (fallback chains are order-sensitive).
 * Two payloads that differ only in property ORDER MUST hash identically.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

function normalizedStringSet(values: readonly unknown[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

/**
 * PLAT-4546: versioned schema for the explicit semantic drift-hash contract.
 *
 * Increment this only when a reviewed runtime-behaviour input is deliberately
 * added or removed. Rendered diagnostics/telemetry are intentionally absent:
 * they explain the effective state but must never become a second authority.
 */
export const MCP_CONFIG_HASH_SCHEMA_VERSION = 2;

export type AgentResolvedRuntimeHashInputs = Pick<
  K8sSpawnOpts,
  'command' | 'model' | 'effort' | 'contextPrompt'
>;

// The manager resolves bridge/model/prompt composition before every k8s start.
// Keep that exact resolved authority for steady-state reconcile hashes; falling
// back to stored fields is only for the first observation before a render.
const resolvedRuntimeHashInputs = new Map<string, AgentResolvedRuntimeHashInputs>();

export function computeAgentMcpConfigHash(
  agent: AgentInfo,
  resolvedRuntime?: AgentResolvedRuntimeHashInputs,
): string {
  const effective = agent.effectiveCapabilities?.source === 'hive'
    ? agent.effectiveCapabilities
    : undefined;
  // A valid Hive effective-capability payload is the runtime access authority.
  // Do not union stale persisted skills/grants back into that overlay: the
  // reconcile planner reads the persisted row while the renderer refreshes the
  // Hive overlay, and letting both widen access made ordinary agents alternate
  // between privileged and unprivileged hashes indefinitely.
  const effectiveSkills = effective ? effective.skills : agent.skills;
  const effectiveEagerSkills = effective ? effective.eagerSkills : agent.eagerSkills;
  const effectiveCredentialGrantScopes = effective
    ? effective.credentialGrantScopes
    : agent.credentialGrantScopes;
  const effectiveCredentialCustomGrantServices = effective
    ? effective.credentialCustomGrantServices
    : agent.credentialCustomGrantServices;
  const teamSecretBindings = k8sTeamSecretBindingsForAgent(agent);
  if (resolvedRuntime) resolvedRuntimeHashInputs.set(agent.id, { ...resolvedRuntime });
  const runtime = resolvedRuntime ?? resolvedRuntimeHashInputs.get(agent.id) ?? {
    command: agent.executionMethod ?? '',
    model: agent.model ?? '',
    effort: undefined,
    contextPrompt: agent.contextPrompt ?? '',
    runtimeLaneGeneration: agent.runtimeLaneGeneration ?? null,
    runtimeLaneDigest: agent.runtimeLaneDigest ?? '',
  };

  // Explicit ALLOWLIST of inputs that change effective runtime behaviour.
  // Do not replace this with "all rendered env except ...": Hive diagnostics,
  // source timestamps, catalog transport metadata, and explanation text are
  // rendered for observability but are non-authoritative. Any diagnostic that
  // implies a real access change must first update one of the effective fields
  // below. Set-semantic arrays are normalized; fallback order is preserved.
  const semanticInputs = {
    schemaVersion: MCP_CONFIG_HASH_SCHEMA_VERSION,
    access: {
      mcpServices: normalizedStringSet(agentMcpSlugs(agent).map((slug) => slug.toLowerCase())),
      capabilities: normalizedStringSet(effective?.capabilities),
      sourceTeams: normalizedStringSet(effective?.sourceTeams),
      skills: normalizedStringSet(effectiveSkills),
      eagerSkills: normalizedStringSet(effectiveEagerSkills),
      credentialGrantScopes: normalizedStringSet(effectiveCredentialGrantScopes),
      credentialCustomGrantServices: normalizedStringSet(effectiveCredentialCustomGrantServices),
      credentialPayloadReadScopes: normalizedStringSet(agent.credentialPayloadReadScopes),
      credentialBrokerPeerUid: agent.credentialBrokerPeerUid ?? null,
    },
    runtimeFlags: effective?.runtimeFlags ?? {},
    runtimeChain: {
      command: runtime.command,
      model: runtime.model,
      effort: runtime.effort ?? '',
      modelFallbacks: agent.modelFallbacks ?? [],
      modelOverrides: agent.modelOverrides ?? {},
      failoverChainId: agent.failoverChainId ?? '',
      contextPromptDigest: createHash('sha256').update(runtime.contextPrompt).digest('hex'),
      runtimeLaneGeneration: agent.runtimeLaneGeneration ?? null,
      runtimeLaneDigest: agent.runtimeLaneDigest ?? '',
    },
    // Hash the mutable platform+tuning layer exactly as rendered. Agent tuning
    // wins, so a shadowed platform default cannot create false drift. Static
    // package-cache routes converge through K8S_RUNTIME_SPEC_REVISION instead.
    effectivePlatformEnv: { ...agentPlatformEnv(), ...agentTuningEnv(agent) },
    // Separate schema marker keeps the global v2 hash stable: only agents that
    // actually receive a team Secret roll when this additive projection lands.
    ...(teamSecretBindings.length > 0 ? {
      teamSecretProjection: { schemaVersion: 1, bindings: teamSecretBindings },
    } : {}),
  };
  const stable = stableStringify(semanticInputs);
  return createHash('sha1').update(stable).digest('hex').slice(0, 16);
}

/**
 * K8s-native fleet pods are the preferred runtime for agents, including
 * privileged DevOps agents. The pod contract includes the broker/DinD sidecars
 * and the same effective-capability env used by the daemon, so privilege is
 * controlled by Hive grants rather than by forcing agents back onto host Docker.
 */
export function explainK8sUnsupportedRuntime(agent: AgentInfo | undefined): string | null {
  if (!agent) return 'missing agent';
  return null;
}

/**
 * A privileged pod is selected from the durable capability contract, never
 * from a username allow-list.  This keeps ordinary agent pods on the namespace
 * default ServiceAccount while giving DevOps/kubeconfig holders an auditable,
 * per-agent Kubernetes identity.
 */
export function isPrivilegedK8sAgent(agent: AgentInfo | undefined): boolean {
  if (!agent) return false;
  const effective = agent.effectiveCapabilities?.source === 'hive'
    ? agent.effectiveCapabilities
    : undefined;
  const skills = new Set(effective ? effective.skills : (agent.skills ?? []));
  const capabilities = new Set(effective?.capabilities ?? []);
  const credentialScopes = new Set(
    effective ? effective.credentialGrantScopes : (agent.credentialGrantScopes ?? []),
  );
  return skills.has('devops')
    || capabilities.has('devops')
    || capabilities.has('needs:kubeconfig')
    || capabilities.has('needs:host-exec')
    || credentialScopes.has('kubeconfig');
}

/**
 * One effective-capability predicate owns the host-access contract.  The
 * manager must not stage/fail-close SSH using a narrower legacy skills check
 * than the backend uses to select a privileged pod.
 */
export function requiresFleetSshForK8sAgent(agent: AgentInfo | undefined): boolean {
  return isPrivilegedK8sAgent(agent) || !!agent?.sshKeys?.enabled;
}

export function missingRequiredFleetSshReason(
  agent: AgentInfo | undefined,
  fleetSshFiles: Record<string, string> | undefined,
): string | null {
  if (!requiresFleetSshForK8sAgent(agent)) return null;
  return fleetSshFiles && Object.keys(fleetSshFiles).length > 0
    ? null
    : 'effective privileged/host-exec capability requires an active fleet-ssh grant with staged key files';
}

function privilegedServiceAccountName(agent: AgentInfo): string {
  return `agent-${agent.username}-ops`;
}

function renderFleetSshStringData(files: Record<string, string>): string {
  const entries = Object.entries(files)
    .filter(([name, value]) => /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..' && value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([name, value]) => `  ${name}: ${yamlEscape(value)}`).join('\n');
}

export function shouldSpawnK8sAgent(agent: AgentInfo | undefined): boolean {
  return isK8sAgent(agent) && !explainK8sUnsupportedRuntime(agent);
}

function yamlEscape(s: string): string {
  // single-line scalar via JSON quoting (valid YAML), for env values
  return JSON.stringify(s ?? '');
}

/**
 * hostNetwork fleet daemon pods often fail plain `kubectl` in-cluster discovery
 * (client falls back to http://localhost:8080 → connection refused), which makes
 * Hive agent Live activity forever stale (session JSONL fallback from days ago).
 * Build an explicit SA kubeconfig when the projected token is present so live-tail
 * + github probes use the ServiceAccount path reliably.
 */
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const SA_KUBECONFIG_PATH =
  process.env['SHIZUHA_INCLUSTER_KUBECONFIG']
  || '/tmp/shizuha-runtime-incluster.kubeconfig';

let saKubeconfigReady = false;

function ensureServiceAccountKubeconfig(): string | undefined {
  if (saKubeconfigReady && fs.existsSync(SA_KUBECONFIG_PATH)) return SA_KUBECONFIG_PATH;
  try {
    if (!fs.existsSync(SA_TOKEN_PATH) || !fs.existsSync(SA_CA_PATH)) return undefined;
    const host = process.env['KUBERNETES_SERVICE_HOST'];
    const port = process.env['KUBERNETES_SERVICE_PORT'] || '443';
    if (!host) return undefined;
    const token = fs.readFileSync(SA_TOKEN_PATH, 'utf-8').trim();
    const ca = fs.readFileSync(SA_CA_PATH, 'utf-8');
    if (!token || !ca) return undefined;
    const caB64 = Buffer.from(ca, 'utf-8').toString('base64');
    const server = `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
    const yaml = `apiVersion: v1
kind: Config
clusters:
- name: in-cluster
  cluster:
    server: ${server}
    certificate-authority-data: ${caB64}
users:
- name: service-account
  user:
    token: ${token}
contexts:
- name: in-cluster
  context:
    cluster: in-cluster
    user: service-account
current-context: in-cluster
`;
    fs.writeFileSync(SA_KUBECONFIG_PATH, yaml, { mode: 0o600 });
    saKubeconfigReady = true;
    return SA_KUBECONFIG_PATH;
  } catch {
    return undefined;
  }
}

function kubectlEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const saConfig = ensureServiceAccountKubeconfig();
  if (saConfig) {
    env['KUBECONFIG'] = saConfig;
  }
  return env;
}

function kubectl(args: string[], stdin?: string): string {
  return execFileSync(KUBECTL_BIN, args, {
    input: stdin,
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: kubectlEnv(),
  });
}

/** Async kubectl for long-running control-plane ops (rollout restart/status). */
async function kubectlAsync(args: string[], _stdin?: string, timeoutMs = 60_000): Promise<string> {
  // execFileAsync does not accept `input`; restart/status paths need no stdin.
  const { stdout } = await execFileAsync(KUBECTL_BIN, args, {
    encoding: 'utf-8' as const,
    timeout: Math.max(1_000, timeoutMs),
    maxBuffer: 8 * 1024 * 1024,
    env: kubectlEnv(),
  });
  return typeof stdout === 'string' ? stdout : String(stdout ?? '');
}

function canonicalK8sResource(kind: string): string {
  switch (kind) {
    case 'deploy':
      return 'deployment';
    case 'deploys':
      return 'deployments';
    case 'pvc':
      return 'persistentvolumeclaim';
    case 'pvcs':
      return 'persistentvolumeclaims';
    default:
      return kind;
  }
}

function isKubectlDiscoveryOrValidationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('failed to download openapi')
    || message.includes('the server is currently unable to handle the request')
    || message.includes("the server doesn't have a resource type")
    || message.includes('unable to retrieve the complete list of server APIs')
    || message.includes('could not get apiVersions from Kubernetes')
  );
}

/** Host/control-plane kubectl failure — not an agent fault. */
export type K8sObserveKind = 'auth' | 'unreachable' | 'unknown';

export class K8sObserveError extends Error {
  readonly kind: K8sObserveKind;
  constructor(kind: K8sObserveKind, message: string) {
    super(message);
    this.name = 'K8sObserveError';
    this.kind = kind;
  }
}

export function classifyKubectlFailure(err: unknown): 'auth' | 'unreachable' | 'not_found' | 'other' {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes('you must be logged in to the server')
    || lower.includes('the server has asked for the client to provide credentials')
    || lower.includes('error: unauthorized')
  ) {
    return 'auth';
  }
  if (
    lower.includes("couldn't get current server api group list")
    || lower.includes('connection refused')
    || lower.includes('i/o timeout')
    || lower.includes('no such host')
    || isKubectlDiscoveryOrValidationError(err)
  ) {
    return 'unreachable';
  }
  if (lower.includes('(notfound)') || lower.includes('not found')) {
    return 'not_found';
  }
  return 'other';
}

export function isK8sControlPlaneUnreadable(err: unknown): boolean {
  const kind = classifyKubectlFailure(err);
  return kind === 'auth' || kind === 'unreachable';
}

/** Short operator-safe line. Never include kubectl argv or memcache dumps. */
export function operatorFacingK8sError(err: unknown): string {
  const kind = classifyKubectlFailure(err);
  if (kind === 'auth') {
    return 'cluster API rejected fleet-daemon credentials (not an agent fault)';
  }
  if (kind === 'unreachable') {
    return 'cluster API unreachable from fleet daemon (not an agent fault)';
  }
  const message = err instanceof Error ? err.message : String(err);
  const first = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.includes('memcache.go') && !line.startsWith('E0'))
    ?? 'k8s operation failed';
  return first.replace(/^command failed:\s*/i, '').slice(0, 160);
}

function kubectlApplyManifest(args: string[], manifest: string): string {
  try {
    return kubectl(args, manifest);
  } catch (err) {
    if (!isKubectlDiscoveryOrValidationError(err) || args.includes('--validate=false')) {
      throw err;
    }
    console.warn(
      `[daemon] kubectl ${args.join(' ')} hit transient discovery/validation failure; retrying with --validate=false: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return kubectl([...args, '--validate=false'], manifest);
  }
}

function resourceExists(kind: string, name: string): boolean {
  try {
    return kubectl([
      'get', '-n', K8S_NS, canonicalK8sResource(kind), name, '-o', 'name',
    ]).trim().length > 0;
  } catch {
    return false;
  }
}

const DEFAULT_WORKSPACE_PVC_SIZE = '10Gi';

function workspacePvcSize(): string {
  return process.env['SHIZUHA_FLEET_WORKSPACE_SIZE']?.trim() || DEFAULT_WORKSPACE_PVC_SIZE;
}

function storageQuantityBytes(quantity: string): bigint {
  const match = quantity.trim().match(/^(\d+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) {
    throw new Error(`unsupported Kubernetes storage quantity: ${quantity}`);
  }
  const value = BigInt(match[1]!);
  const unit = match[2] ?? '';
  const multipliers: Record<string, bigint> = {
    '': 1n, K: 1_000n, M: 1_000_000n, G: 1_000_000_000n, T: 1_000_000_000_000n,
    Ki: 1_024n, Mi: 1_048_576n, Gi: 1_073_741_824n, Ti: 1_099_511_627_776n,
  };
  return value * multipliers[unit]!;
}

/** Converge an existing workspace PVC upward to the fleet baseline.
 *
 * Existing PVCs are omitted from the apply manifest so immutable fields and
 * historical StorageClass values remain intact. That omission used to skip
 * capacity reconciliation forever, leaving migrated 5Gi workspaces to fill.
 * PVCs cannot shrink, so patch only when desired capacity is strictly larger.
 */
function ensureWorkspacePvcCapacity(name: string): void {
  const desired = workspacePvcSize();
  const current = kubectl([
    'get', '-n', K8S_NS, 'persistentvolumeclaim', name,
    '-o', 'jsonpath={.spec.resources.requests.storage}',
  ]).trim();
  if (!current) {
    throw new Error(`${name}: existing workspace PVC has no requested storage quantity`);
  }
  if (storageQuantityBytes(desired) <= storageQuantityBytes(current)) {
    return;
  }
  const patch = JSON.stringify({ spec: { resources: { requests: { storage: desired } } } });
  kubectl(['patch', '-n', K8S_NS, 'persistentvolumeclaim', name, '--type=merge', '-p', patch]);
  console.log(`[daemon] ${name}: expanded workspace PVC ${current} -> ${desired}`);
}

/**
 * Remove only the exact daemon-owned per-agent object after a capability-class
 * downgrade.  `kubectl apply` never prunes omitted documents, while broad
 * `--prune` would risk unrelated fleet resources.  Refuse deletion unless the
 * live ownership labels match the agent Deployment contract.
 */
function deleteOwnedAgentResource(kind: string, name: string, agent: AgentInfo, namespaced: boolean): void {
  const target = `${kind}/${name}`;
  const scope = namespaced ? ['-n', K8S_NS] : [];
  // `--ignore-not-found` makes absence explicit without also swallowing
  // Forbidden, transport failures, or API outages. A capability downgrade is
  // a privilege-revocation path, so every non-NotFound lookup failure must stop
  // reconciliation rather than silently leaving stale privileged objects live.
  const raw = kubectl(['get', ...scope, target, '--ignore-not-found=true', '-o', 'json']);
  if (!raw.trim()) return;
  try {
    const parsed = JSON.parse(raw) as { metadata?: { labels?: Record<string, string> } };
    const labels = parsed.metadata?.labels ?? {};
    if (labels['app'] !== `agent-${agent.username}` || labels['shizuha.io/runtime'] !== 'k3s-native') {
      console.warn(`[daemon] ${agent.name}: refusing to delete unowned downgrade object ${target}`);
      return;
    }
  } catch {
    console.warn(`[daemon] ${agent.name}: refusing to delete downgrade object ${target}; live metadata was not valid JSON`);
    return;
  }
  kubectl(['delete', ...scope, target, '--ignore-not-found=true']);
}

function kubectlProbe(args: string[]): string {
  return execFileSync(KUBECTL_BIN, args, {
    encoding: 'utf-8',
    timeout: GITHUB_AUTH_PROBE_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    env: kubectlEnv(),
  });
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isKubectlTransportProbeFailure(err: unknown, detail: string): boolean {
  const e = err as { code?: string; signal?: string; killed?: boolean; message?: string };
  const text = `${detail} ${e.message ?? ''}`.toLowerCase();
  return e.code === 'ETIMEDOUT'
    || e.signal === 'SIGTERM'
    || e.killed === true
    || text.includes('spawnsync')
    || text.includes('etimedout')
    || text.includes('timed out')
    || text.includes('internal error occurred: error sending request')
    || /:10250\/exec(?:\/|\?|\s|$)/.test(text)
    || (text.includes('oci runtime exec failed') && (
      text.includes('error executing setns process')
      || /failed to open \/proc\/\d+\/ns\//.test(text)
      || text.includes('failed to sync with stage-1')
    ))
    || text.includes('unable to upgrade connection')
    || text.includes('container not found')
    || text.includes('pods/exec')
    || text.includes('error from server (forbidden)')
    || text.includes('couldn\'t get current server api group list')
    || text.includes('localhost:8080')
    || text.includes('connect: connection refused')
    || text.includes('i/o timeout')
    || text.includes('context deadline exceeded')
    || text.includes('client.timeout')
    || text.includes('no such host');
}

function isGitHubCredentialRejection(detail: string): boolean {
  return /\bhttp(?:\/[0-9.]+)?[\s:]+(?:401|403)\b/i.test(detail)
    || /\bbad credentials\b/i.test(detail);
}

function isGitHubUpstreamProbeFailure(detail: string): boolean {
  if (/\bhttp(?:\/[0-9.]+)?[\s:]+5\d{2}\b/i.test(detail)) return true;
  if (/content-type:\s*text\/html/i.test(detail)) return true;
  if (/<!doctype\s+html|<html\b/i.test(detail)) return true;
  if (/invalid character .*<.*looking for beginning of value/i.test(detail)) return true;
  if (/unexpected end of json|invalid json|failed to decode json|looking for beginning of value/i.test(detail)) return true;
  if (/\b(?:bad gateway|service unavailable|gateway timeout)\b/i.test(detail)) return true;

  const githubTarget = /(?:api\.)?github\.com/i.test(detail);
  const networkFailure = /could not resolve host|no such host|i\/o timeout|timed out|client\.timeout|context deadline exceeded|connection refused|tls handshake timeout|network is unreachable/i.test(detail);
  return githubTarget && networkFailure;
}

function githubProbeFailureReason(err: unknown, detail: string): K8sGitHubCredentialProbeReason {
  if (detail.includes('GITHUB_TOKEN_EMPTY')) return 'github_token_empty';
  if (isGitHubCredentialRejection(detail)) return 'github_api_failed';
  if (isGitHubUpstreamProbeFailure(detail)) return 'github_upstream_unavailable';
  if (isKubectlTransportProbeFailure(err, detail)) return 'probe_transport_failed';
  return 'github_api_failed';
}

function kubectlGithubAuthProbe(args: string[]): string {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GITHUB_AUTH_PROBE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return kubectlProbe(args);
    } catch (err) {
      lastErr = err;
      const detail = sanitizeProbeDetail(err);
      const reason = githubProbeFailureReason(err, detail);
      if (reason !== 'probe_transport_failed' && reason !== 'github_upstream_unavailable') throw err;
      if (attempt >= GITHUB_AUTH_PROBE_MAX_ATTEMPTS) break;
      sleepSync(GITHUB_AUTH_PROBE_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function usableSecretValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (['null', 'undefined', 'none'].includes(trimmed.toLowerCase())) return undefined;
  if (/^\*+$/.test(trimmed)) return undefined;
  return value;
}

function sanitizeProbeDetail(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const output = [e.stderr, e.stdout]
    .map((part) => Buffer.isBuffer(part) ? part.toString('utf-8') : (part ?? ''))
    .filter(Boolean)
    .join(' ');
  // Prefer process output over Error.message: execFileSync's message echoes the
  // full argv, which includes the probe script text and can falsely match
  // sentinel strings such as GITHUB_TOKEN_EMPTY even when gh failed for another
  // reason.
  const raw = (output || e.message || '')
    .replace(/gh[pousr]_[A-Za-z0-9_=-]{8,}/g, '<redacted-token>');
  // PLAT-4778 (revi #313): an exhausted-retry ANDON/detail MUST surface the named
  // diagnostics (HTTP status, content-type, x-github-request-id) even when the raw
  // `gh api --include` header block is longer than the 500-char body cap — a real
  // GitHub header block is ~875 bytes with `x-github-request-id` near byte 819, so
  // a blind truncation drops exactly the field the contract requires. Extract the
  // named fields from the untruncated header lines FIRST, then append the truncated
  // body for context so the request id is never lost.
  const pick = (re: RegExp): string => {
    const m = raw.match(re);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  };
  const diagnostics = [
    pick(/HTTP\/[0-9.]+\s+[0-9]{3}[^\r\n]*/i),   // status line (gh --include)
    pick(/^[ \t]*status:[ \t]*[0-9]{3}[^\r\n]*/im),
    pick(/content-type:[ \t]*[^\r\n]+/i),
    pick(/x-github-request-id:[ \t]*[^\r\n]+/i),
  ].filter(Boolean);
  const body = raw
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  const head = diagnostics.join(' | ');
  return head ? (body ? `${head} :: ${body}` : head) : body;
}

export interface K8sAgentSessionTail {
  file: string;
  lines: string[];
}

export interface K8sAgentSessionTailUnavailable {
  reason: 'not_k8s_agent' | 'deployment_unavailable' | 'deployment_not_ready' | 'exec_failed' | 'no_session_file';
  message: string;
  detail?: string;
}

export interface K8sAgentSessionTailStatus {
  tail: K8sAgentSessionTail | null;
  unavailable?: K8sAgentSessionTailUnavailable;
}

interface K8sSessionTailCacheEntry {
  expiresAt: number;
  maxLines: number;
  result?: K8sAgentSessionTailStatus;
  promise?: Promise<K8sAgentSessionTailStatus>;
}

const K8S_SESSION_TAIL_CACHE_TTL_MS = Math.max(0, Number(process.env['SHIZUHA_K8S_SESSION_TAIL_CACHE_TTL_MS'] ?? '5000'));
const K8S_SESSION_TAIL_TIMEOUT_MS = Math.max(500, Number(process.env['SHIZUHA_K8S_SESSION_TAIL_TIMEOUT_MS'] ?? '2000'));
const K8S_KUBECTL_REQUEST_TIMEOUT = process.env['SHIZUHA_KUBECTL_REQUEST_TIMEOUT'] ?? '2s';
const k8sSessionTailCache = new Map<string, K8sSessionTailCacheEntry>();

// SCLI-330: background last-activity probe for k8s-native agents. Local child
// agents feed the daemon's lastActivityMap from stdout parsing, but pod agents
// have no stdout stream into the daemon — their dashboard lastActiveAt (and
// Hive's Agents page, which mirrors it) froze at pre-migration values while the
// pod worked. On each fleet-list serve, agents whose probe is older than the
// interval get ONE cheap kubectl-exec `stat` of their newest activity file
// (same newest-wins candidate set as the session tail); the mtime is the last
// activity. Fire-and-forget, rate-limited per agent, bounded by the in-flight
// set — no polling sweep, piggybacks on demand that already exists. Keep the
// default comfortably below Hive's five-minute stop grace: a five-minute probe
// interval can race the reconcile boundary and make continuously active agents
// look exactly five minutes idle.
const K8S_LAST_ACTIVITY_PROBE_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env['SHIZUHA_K8S_LAST_ACTIVITY_PROBE_INTERVAL_MS'] ?? 2 * 60_000),
);
const k8sLastActivityProbeAt = new Map<string, number>();
const k8sLastActivityProbeInflight = new Set<string>();

export function scheduleK8sLastActivityProbe(
  agent: AgentInfo,
  note: (agentId: string, ts: string) => void,
): void {
  if (!isK8sAgent(agent)) return;
  const key = agent.id || agent.username;
  const now = Date.now();
  if (k8sLastActivityProbeInflight.has(key)) return;
  if ((k8sLastActivityProbeAt.get(key) ?? 0) + K8S_LAST_ACTIVITY_PROBE_INTERVAL_MS > now) return;
  k8sLastActivityProbeInflight.add(key);
  k8sLastActivityProbeAt.set(key, now);
  void (async () => {
    try {
      const script =
        'f=$(ls -1t /home/agent/.claude/projects/*/*.jsonl /home/agent/.claude/projects/*.jsonl ' +
        '/home/agent/.shizuha/.audit-log.jsonl /home/agent/.shizuha/.telemetry.jsonl 2>/dev/null | head -1); ' +
        'if [ -n "$f" ]; then stat -c %Y "$f"; fi';
      const { stdout } = await execFileAsync(
        KUBECTL_BIN,
        ['--request-timeout=' + K8S_KUBECTL_REQUEST_TIMEOUT, 'exec', '-n', K8S_NS, `deployment/agent-${agent.username}`, '-c', 'agent', '--', 'sh', '-c', script],
        { encoding: 'utf-8', timeout: K8S_SESSION_TAIL_TIMEOUT_MS, env: kubectlEnv() },
      );
      const epoch = Number(stdout.trim());
      if (Number.isFinite(epoch) && epoch > 0) {
        note(agent.id, new Date(epoch * 1000).toISOString());
      }
    } catch {
      // pod unreachable/not ready — leave the current value; next interval retries
    } finally {
      k8sLastActivityProbeInflight.delete(key);
    }
  })();
}

function parseK8sSessionTail(out: string): K8sAgentSessionTail | null {
  const nl = out.indexOf('\n');
  if (nl <= 0) return null;
  const file = out.slice(0, nl).trim();
  if (!file.endsWith('.jsonl')) return null;
  return { file, lines: out.slice(nl + 1).split('\n') };
}

async function getK8sAgentDeploymentReadiness(agent: AgentInfo): Promise<K8sAgentSessionTailUnavailable | null> {
  try {
    const { stdout } = await execFileAsync(
      KUBECTL_BIN,
      ['--request-timeout=' + K8S_KUBECTL_REQUEST_TIMEOUT, 'get', '-n', K8S_NS, `deployment/agent-${agent.username}`, '-o', 'json'],
      { encoding: 'utf-8', timeout: K8S_SESSION_TAIL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: kubectlEnv() },
    );
    const deployment = JSON.parse(stdout);
    const desired = Number(deployment?.spec?.replicas ?? 1);
    const ready = Number(deployment?.status?.readyReplicas ?? 0);
    const available = Number(deployment?.status?.availableReplicas ?? 0);
    if (desired <= 0 || ready <= 0 || available <= 0) {
      return {
        reason: 'deployment_not_ready',
        message: `live-tail unavailable: deploy/agent-${agent.username} is not ready (desired=${desired}, ready=${ready}, available=${available}); served from fallback`,
      };
    }
    return null;
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    return {
      reason: 'deployment_unavailable',
      message: `live-tail unavailable: deploy/agent-${agent.username} is absent or unreachable; served from fallback`,
      detail: String(e.stderr || e.stdout || e.message || '').slice(0, 500),
    };
  }
}

/** Tail the newest Claude session JSONL inside a k8s-native agent's pod (HIVE-303).
 * The live session lives on the pod PVC (/home/agent/.claude), not on host
 * paths, so the activity endpoint must read it via kubectl exec. Returns null
 * when the agent is not k8s-native or the pod is unreachable (scaled to zero,
 * crash-looping, exec timeout) — callers fall back to host/telemetry sources.
 *
 * HIVE-305: this is async and short-TTL cached so dashboard polling cannot block
 * the daemon event loop or spawn one kubectl exec per poll. */
export async function readK8sAgentSessionTailStatus(
  agent: AgentInfo,
  maxLines = 2000,
): Promise<K8sAgentSessionTailStatus> {
  if (!isK8sAgent(agent)) {
    return { tail: null, unavailable: { reason: 'not_k8s_agent', message: 'live-tail unavailable: agent is not k8s-native; served from fallback' } };
  }
  const requestedLines = Math.max(1, Math.floor(maxLines));
  const cacheKey = agent.id || agent.username;
  const now = Date.now();
  const cached = k8sSessionTailCache.get(cacheKey);
  if (cached && cached.expiresAt > now && cached.maxLines >= requestedLines) {
    if (cached.promise) return cached.promise;
    return cached.result ?? { tail: null };
  }

  // NEWEST candidate wins across Claude session JSONL AND SCLI/gateway audit
  // + telemetry. Claude-first preference served multi-day-stale pre-migration
  // .claude/projects leftovers from the PVC for scli-method agents whose
  // fresh activity lives in .shizuha/.audit-log.jsonl (jun 2026-07-10: a
  // Jul-6 claude session shadowed a minutes-old audit log).
  const script =
    'f=$(ls -1t /home/agent/.claude/projects/*/*.jsonl /home/agent/.claude/projects/*.jsonl ' +
    '/home/agent/.shizuha/.audit-log.jsonl /home/agent/.shizuha/.telemetry.jsonl 2>/dev/null | head -1); ' +
    `if [ -n "$f" ]; then echo "$f"; tail -n ${requestedLines} "$f"; fi`;
  const promise = (async (): Promise<K8sAgentSessionTailStatus> => {
    const readinessError = await getK8sAgentDeploymentReadiness(agent);
    if (readinessError) return { tail: null, unavailable: readinessError };

    try {
      const { stdout } = await execFileAsync(
        KUBECTL_BIN,
        // Must target the agent container — default first container is dind.
        ['--request-timeout=' + K8S_KUBECTL_REQUEST_TIMEOUT, 'exec', '-n', K8S_NS, `deployment/agent-${agent.username}`, '-c', 'agent', '--', 'sh', '-c', script],
        { encoding: 'utf-8', timeout: K8S_SESSION_TAIL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: kubectlEnv() },
      );
      const tail = parseK8sSessionTail(stdout);
      if (tail) return { tail };
      return {
        tail: null,
        unavailable: {
          reason: 'no_session_file',
          message: `live-tail unavailable: deploy/agent-${agent.username} has no readable session JSONL; served from fallback`,
        },
      };
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      return {
        tail: null,
        unavailable: {
          reason: 'exec_failed',
          message: `live-tail unavailable: kubectl exec for deploy/agent-${agent.username} failed fast; served from fallback`,
          detail: String(e.stderr || e.stdout || e.message || '').slice(0, 500),
        },
      };
    }
  })();

  if (K8S_SESSION_TAIL_CACHE_TTL_MS > 0) {
    k8sSessionTailCache.set(cacheKey, {
      expiresAt: now + K8S_SESSION_TAIL_CACHE_TTL_MS,
      maxLines: requestedLines,
      promise,
    });
  }

  const result = await promise;
  if (K8S_SESSION_TAIL_CACHE_TTL_MS > 0) {
    k8sSessionTailCache.set(cacheKey, {
      expiresAt: Date.now() + K8S_SESSION_TAIL_CACHE_TTL_MS,
      maxLines: requestedLines,
      result,
    });
  }
  return result;
}

export async function readK8sAgentSessionTail(
  agent: AgentInfo,
  maxLines = 2000,
): Promise<K8sAgentSessionTail | null> {
  return (await readK8sAgentSessionTailStatus(agent, maxLines)).tail;
}

/**
 * PLAT-5075 (PLAT-5041 Phase A): the selector a NEW agent Deployment is born
 * with.
 *
 * Canonical per Hive HLD `84b482e6` §4/§7: `shizuha.io/agent=<username>`. It
 * had been `app=agent-<username>` (Shape B) since `shizuha-beta` `83b1084`,
 * where selector adoption and complete pod labels were coupled and only the
 * latter landed — so every daemon-created Deployment joined the unpoliced set
 * that PLAT-5041 tracks.
 *
 * This is the containment: new provisioning cannot expand that set. It applies
 * ONLY to the absent-Deployment path. `deploymentSelectorLabels` still returns
 * the live `.spec.selector.matchLabels` whenever the Deployment exists, so an
 * existing Shape A *or* Shape B object keeps its immutable selector and its
 * pod template unchanged, and nothing rolls from this change.
 *
 * ⚠️ Both `.spec.selector.matchLabels` and `.spec.template.metadata.labels`
 * derive from this one return value (`:1589` / `:1592` via `podLabels`), so
 * they cannot diverge — a new Deployment whose selector carries the label but
 * whose pods do not would never become Ready.
 *
 * Phase B (bulk relabel of existing objects) is deliberately NOT here.
 */
function defaultSelectorLabels(agent: AgentInfo): Record<string, string> {
  return { 'shizuha.io/agent': agent.username };
}

function yamlFlowMap(labels: Record<string, string>): string {
  return `{ ${Object.entries(labels).map(([k, v]) => `${k}: ${yamlEscape(v)}`).join(', ')} }`;
}

/**
 * Did this `kubectl get` fail because the object genuinely does not exist?
 *
 * PLAT-5075 (@reika, review P2). `kubectl()` is `execFileSync`, which throws on
 * ANY non-zero exit — NotFound, an RBAC denial, a 60s timeout, an API-server
 * blip. Only the first of those means "absent"; the rest mean "we could not
 * find out", and those are not the same answer.
 */
function isDeploymentNotFound(err: unknown): boolean {
  const parts = [
    (err as { stderr?: unknown } | null)?.stderr,
    (err as { stdout?: unknown } | null)?.stdout,
    (err as { message?: unknown } | null)?.message,
  ];
  return parts.some((part) => /NotFound|not found/i.test(String(part ?? '')));
}

function deploymentSelectorLabels(agent: AgentInfo): Record<string, string> {
  let raw: string | null = null;
  try {
    raw = kubectl(['get', '-n', K8S_NS, `deployment/agent-${agent.username}`, '-o', 'json']);
  } catch (err) {
    // PLAT-5075 (@reika P2): fall through to the canonical selector ONLY on a
    // genuine not-found. A bare `catch` here used to be harmless because the
    // fallback was `app=agent-<u>` — the very selector existing Deployments
    // already carry — so a transient read failure re-rendered what was already
    // there and the apply was a no-op.
    //
    // Changing the fallback to `shizuha.io/agent` changed what that catch
    // COSTS: the same transient failure against an existing Shape-B Deployment
    // would now render a DIFFERENT `.spec.selector`, which is immutable, and
    // this phase's own invariant is that it must not mutate one. It fails
    // loudly (the API server rejects the change) rather than corrupting
    // anything, but a confusing failed respawn during an API blip is not a
    // cost this containment should introduce.
    //
    // Rethrowing means "we could not determine the current selector" aborts
    // the spawn instead of guessing — the safe direction when the guess is
    // written to an immutable field.
    if (!isDeploymentNotFound(err)) throw err;
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { spec?: { selector?: { matchLabels?: Record<string, string> } } };
      const labels = parsed.spec?.selector?.matchLabels;
      if (labels && Object.keys(labels).length > 0) return labels;
    } catch {
      // Deliberately NOT an abort. A get that SUCCEEDS but carries no
      // `matchLabels` already falls through to the canonical selector below, so
      // a body we cannot parse is treated identically — "no usable existing
      // selector", not "could not reach the API". Only the kubectl invocation
      // itself failing is ambiguous enough to warrant aborting the spawn, which
      // keeps this containment's behaviour change to exactly that case.
    }
  }
  return defaultSelectorLabels(agent);
}

function renderNodePlacement(): string {
  if (!K8S_NODE_SELECTOR) return '';
  const [key, value = ''] = K8S_NODE_SELECTOR.split('=');
  return `      nodeSelector: { ${key}: ${yamlEscape(value)} }\n`;
}

type AgentContainerResourceSpec = {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
};

function agentContainerResourceSpec(command: string): AgentContainerResourceSpec {
  // Bridge agents (claude/codex/openclaw) hold a whole CLI subprocess + its
  // session state → 8Gi. SCLI-248 raised these but left EVERYTHING else at 2Gi,
  // and the shizuha-gateway/cortex agents (nagi et al.) OOMKilled at 2Gi under
  // real workloads (large prompts + tool state). Gateway agents get 6Gi; the
  // 2Gi floor is only for genuinely tiny sidecars, which don't route here.
  const bridgeCommands = new Set(['claude-bridge', 'codex-bridge', 'openclaw-bridge']);
  if (bridgeCommands.has(command)) {
    return {
      requests: { cpu: '100m', memory: '512Mi' },
      limits: { cpu: '2', memory: '12Gi' },
    };
  }
  // gateway / shizuha (cortex) and any other agent runtime command.
  return {
    requests: { cpu: '100m', memory: '512Mi' },
    limits: { cpu: '2', memory: '8Gi' },
  };
}

function agentContainerResources(command: string): string {
  const resources = agentContainerResourceSpec(command);
  return `requests: { cpu: ${resources.requests.cpu}, memory: ${resources.requests.memory} }, ` +
    `limits: { cpu: "${resources.limits.cpu}", memory: ${resources.limits.memory} }`;
}

/**
 * The V8 old-space ceiling an agent should run with, derived from its pod limit.
 *
 * Node caps its own heap near 4GB by default no matter how much memory it can
 * see, so most of an agent's pod limit was simply unreachable by the JS heap:
 * a 6Gi gateway pod could only ever use ~4GB of it, and an agent that grew past
 * that died with
 *
 *   FATAL ERROR: Ineffective mark-compacts near heap limit
 *   JavaScript heap out of memory
 *
 * rather than being OOMKilled — a crash that looks like a restart, not like a
 * memory limit. The interactive TUI hit exactly this on 2026-08-05 on a host
 * with 512GB of RAM, which is what makes the failure so confusing: host memory
 * is irrelevant to the ceiling.
 *
 * Measured, not assumed: `v8.setFlagsFromString('--max-old-space-size=...')`
 * does NOT move the limit after startup (4144MB -> 4144MB); only NODE_OPTIONS
 * does (8240MB). So it has to be rendered into the pod env.
 *
 * Sized to ~75% of the limit, leaving room for V8 external memory, native
 * buffers and RSS overhead — the heap ceiling must stay BELOW the cgroup limit
 * so a runaway agent hits a recoverable JS heap error instead of a SIGKILL that
 * loses its session.
 */
export function agentNodeHeapMb(command: string): number {
  const limit = agentContainerResourceSpec(command).limits.memory;
  const gib = Number.parseFloat(limit.replace(/Gi$/, ''));
  if (!Number.isFinite(gib) || gib <= 0) return 4096;
  return Math.floor((gib * 1024) * 0.75);
}

// HIVE-553: the step-selection script is shipped BASE64-ENCODED on a single
// line. It must never be embedded as a bash heredoc: heredoc bodies (and the
// terminator) sit at column 0, which terminates the 14-space YAML block scalar
// carrying this entrypoint and breaks `kubectl apply` for every re-render
// ("yaml: could not find expected ':'"). Keep every rendered line indented.
const K8S_STEP_SELECT_SCRIPT = `const chainRaw = process.env.SHIZUHA_MODEL_FALLBACKS || '[]';
let chain = [];
try { const parsed = JSON.parse(chainRaw); if (Array.isArray(parsed)) chain = parsed; } catch {}
const idx = Number(process.argv[2] || 0);
const primary = {
  method: process.env.SHIZUHA_K8S_PRIMARY_METHOD || '',
  command: process.env.SHIZUHA_K8S_PRIMARY_COMMAND || 'gateway',
  model: process.env.SHIZUHA_K8S_PRIMARY_MODEL || '',
  reasoningEffort: process.env.SHIZUHA_K8S_PRIMARY_EFFORT || '',
};
const step = chain[idx] || primary;
const commandByMethod = ${JSON.stringify(RUNTIME_COMMAND_BY_EXECUTION_METHOD)};
const command = commandByMethod[step.method] || step.command || primary.command || 'gateway';
console.log([command, step.model || '', step.reasoningEffort || ''].join('\t'));`;

export function renderK8sInlineFailoverEntrypoint(
  contextPromptPath: string,
  options: { failoverIndexFile?: string; runtimeEntrypoint?: string; initialBackoffSeconds?: number } = {},
): string {
  const stepSelectB64 = Buffer.from(K8S_STEP_SELECT_SCRIPT, 'utf8').toString('base64');
  const failoverIndexFile = options.failoverIndexFile ?? '/run/shizuha/mcp-auth-proxy/failover-index';
  const runtimeEntrypoint = options.runtimeEntrypoint ?? '/usr/local/bin/agent-runtime-entrypoint.sh';
  const initialBackoffSeconds = Math.max(1, options.initialBackoffSeconds ?? 60);
  return `              until curl -fsS --unix-socket /run/shizuha/mcp-auth-proxy/proxy.sock http://localhost/readyz >/dev/null 2>&1; do
                echo "waiting-for-broker-readyz"; sleep 1; done

              # PLAT-4112 Guard 3: persist failover_index across container restarts
              # so a fail-closed throw advances the chain instead of looping step 0.
              # broker-sock is an emptyDir mounted in both broker and agent;
              # this survives agent-container restarts within the Pod.
              FAILOVER_INDEX_FILE=${JSON.stringify(failoverIndexFile)}
              if [ -f "$FAILOVER_INDEX_FILE" ]; then
                failover_index="$(cat "$FAILOVER_INDEX_FILE" 2>/dev/null || echo 0)"
                case "$failover_index" in
                  ''|*[!0-9]*) failover_index=0 ;;
                esac
                echo "k8s-inline-failover restored failover_index=\${failover_index} from \${FAILOVER_INDEX_FILE}"
              else
                failover_index=0
              fi
              failover_backoff=${initialBackoffSeconds}
              while true; do
                step="$(printf '%s' '${stepSelectB64}' | base64 -d | node - "$failover_index")"
                IFS=$'\t' read -r runtime_command runtime_model runtime_effort <<< "$step"
                # PLAT-4112 Guard 3: refuse impossible model/method combos.
                # gateway/shizuha steps with claude/gpt models crashloop because
                # the gateway has no broker-token auth path for those models.
                if { [ "$runtime_command" = "gateway" ] || [ "$runtime_command" = "shizuha" ]; } && \
                   { [ "\${runtime_model#claude-}" != "$runtime_model" ] || [ "\${runtime_model#gpt-}" != "$runtime_model" ]; }; then
                  echo "k8s-inline-failover MISCONFIG step=\${failover_index} command=\${runtime_command} model=\${runtime_model} — impossible combo; skipping to next step"
                  chain_len="$(node -e 'try { const c = JSON.parse(process.env.SHIZUHA_MODEL_FALLBACKS || "[]"); console.log(Array.isArray(c) && c.length ? c.length : 1); } catch { console.log(1); }')"
                  failover_index=$((failover_index + 1))
                  if [ "$failover_index" -ge "$chain_len" ]; then
                    failover_index=0
                    echo "k8s-inline-failover all steps invalid; backing off \${failover_backoff}s"
                    sleep "$failover_backoff"
                  fi
                  printf '%s' "$failover_index" > "$FAILOVER_INDEX_FILE"
                  continue
                fi
                marker_key="$(printf '%s-%s' "$runtime_command" "$runtime_model" | tr -c 'A-Za-z0-9_.-' '_')"
                export SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER="/home/agent/.shizuha/.provider-unavailable-\${marker_key}"
                export SHIZUHA_CLAUDE_PROVIDER_UNAVAILABLE_MARKER="/home/agent/.shizuha/.provider-unavailable-\${marker_key}"
                runtime_args=("$runtime_command" --agent-id "$AGENT_ID" --agent-name "$AGENT_NAME" --agent-username "$AGENT_USERNAME" --port 8080)
                [ -n "$runtime_model" ] && runtime_args+=(--model "$runtime_model")
                [ -n "$runtime_effort" ] && runtime_args+=(--effort "$runtime_effort")
                runtime_args+=(--cwd /home/agent/.shizuha --context-prompt-file ${contextPromptPath})

                echo "k8s-inline-failover step=\${failover_index} command=\${runtime_command} model=\${runtime_model:-none}"
                set +e
                # The failover loop is PID 1, so this per-attempt tini is a
                # child. Register it as a subreaper explicitly; otherwise every
                # agent logs the warning and orphaned tool subprocesses are not
                # re-parented/reaped during a long-lived bridge session.
                /usr/bin/tini -s -- ${JSON.stringify(runtimeEntrypoint)} "\${runtime_args[@]}"
                code=$?
                set -e

                # 42 is the explicit cross-method failover contract. Provider
                # quota/token-pool exhaustion can also surface as a regular
                # bridge exit after the bridge has already marked itself
                # unavailable. Codex uses 43 for its explicit no-fallback
                # exhaustion path, but an in-flight turn can race that timer
                # and make Node exit 1 instead. Treat both bridge families as
                # provider-unavailable and advance/back off in-pod; do not let
                # Kubernetes CrashLoop the agent just because every upstream
                # account is out of quota.
                should_failover=0
                if [ "$code" -eq 42 ]; then
                  should_failover=1
                elif [ "$runtime_command" = "codex-bridge" ] && { [ "$code" -eq 1 ] || [ "$code" -eq 43 ]; }; then
                  echo "k8s-inline-failover provider-unavailable command=\${runtime_command} code=\${code}; advancing/backing off without container crash"
                  should_failover=1
                elif [ "$runtime_command" = "claude-bridge" ] && { [ "$code" -eq 1 ] || [ "$code" -eq 143 ]; }; then
                  echo "k8s-inline-failover provider-unavailable command=\${runtime_command} code=\${code}; advancing/backing off without container crash"
                  should_failover=1
                fi
                if [ "$should_failover" -ne 1 ]; then
                  exit "$code"
                fi

                chain_len="$(node -e 'try { const c = JSON.parse(process.env.SHIZUHA_MODEL_FALLBACKS || "[]"); console.log(Array.isArray(c) && c.length ? c.length : 1); } catch { console.log(1); }')"
                failover_index=$((failover_index + 1))
                if [ "$failover_index" -ge "$chain_len" ]; then
                  echo "k8s-inline-failover exhausted \${chain_len} step(s); retrying from primary after \${failover_backoff}s"
                  sleep "$failover_backoff"
                  if [ "$failover_backoff" -lt 600 ]; then failover_backoff=$((failover_backoff * 2)); fi
                  if [ "$failover_backoff" -gt 600 ]; then failover_backoff=600; fi
                  failover_index=0
                else
                  failover_backoff=${initialBackoffSeconds}
                fi
                printf '%s' "$failover_index" > "$FAILOVER_INDEX_FILE"
              done`;
}

/** Render the per-agent Deployment + Secret + PVC manifest (multi-doc YAML). */
// SCLI-331: the reviewed DesiredRuntimeRelease document is authoritative.
// Deployment env and Hive/registry are projections only; any disagreement
// fails closed before the roller mutates an agent.
const HIVE_RUNTIME_IMAGE_URL = process.env['SHIZUHA_HIVE_RUNTIME_IMAGE_URL']
  ?? 'http://hive.shizuha-hive.svc.cluster.local:8030/hive/api/v1/fleet/runtime-image';
const RUNTIME_RELEASE_PATH = process.env['SHIZUHA_DESIRED_RUNTIME_RELEASE_PATH']
  ?? '/etc/shizuha/runtime-release/desired.json';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');
let hiveDesiredBrokerImage = '';

export async function resolveRuntimeImageDigest(imageRef: string): Promise<string> {
  const at = imageRef.lastIndexOf('@');
  if (at >= 0) return imageRef.slice(at + 1);
  const slash = imageRef.indexOf('/');
  const lastSlash = imageRef.lastIndexOf('/');
  const colon = imageRef.lastIndexOf(':');
  if (slash <= 0 || colon <= lastSlash) throw new Error(`invalid tagged image projection: ${imageRef}`);
  const host = imageRef.slice(0, slash);
  const repository = imageRef.slice(slash + 1, colon);
  const tag = imageRef.slice(colon + 1);
  const scheme = host.startsWith('localhost:') || host.startsWith('127.') ? 'http' : 'https';
  const { stdout } = await execFileAsync(
    'curl',
    ['-fsSI', '--max-time', '8', '-H', `Accept: ${MANIFEST_ACCEPT}`, `${scheme}://${host}/v2/${repository}/manifests/${tag}`],
    { encoding: 'utf-8', timeout: 10_000 },
  );
  const match = stdout.match(/^docker-content-digest:\s*(sha256:[0-9a-f]{64})\s*$/im);
  if (!match) throw new Error(`registry did not return Docker-Content-Digest for ${imageRef}`);
  return match[1]!;
}

export interface ValidatedRuntimeReleaseResult {
  release?: DesiredRuntimeRelease;
  documentFingerprint?: string;
  issues: string[];
}

/** Read and validate the authoritative record plus BOTH projections.  This is
 * intentionally re-run immediately before each mutation; no last-good cache
 * may turn stale state into rollback authority. */
export async function readValidatedRuntimeRelease(): Promise<ValidatedRuntimeReleaseResult> {
  try {
    const initialDocument = loadDesiredRuntimeReleaseDocument(RUNTIME_RELEASE_PATH);
    const initialRelease = desiredRuntimeRelease(initialDocument);
    const initialFingerprint = runtimeReleaseDocumentFingerprint(initialDocument);
    const deploymentTag = AGENT_IMAGE;
    const deploymentGenerationRaw = process.env['SHIZUHA_AGENT_RUNTIME_RELEASE_GENERATION'];
    if (!deploymentGenerationRaw) throw new Error('deployment projection omitted generation');
    const deploymentGeneration = Number(deploymentGenerationRaw);
    if (!Number.isSafeInteger(deploymentGeneration) || deploymentGeneration <= 0) {
      throw new Error(`deployment projection has invalid generation ${deploymentGenerationRaw}`);
    }
    const deploymentDigest = await resolveRuntimeImageDigest(deploymentTag);
    const { stdout } = await execFileAsync(
      'curl',
      ['-fsS', '--max-time', '8', HIVE_RUNTIME_IMAGE_URL],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const hive = JSON.parse(stdout) as { image?: string; generation?: number; image_digest?: string };
    const registryTag = String(hive.image ?? '').trim();
    if (!registryTag) throw new Error('Hive runtime-image projection omitted image');
    if (!Number.isSafeInteger(hive.generation) || Number(hive.generation) <= 0) {
      throw new Error('Hive runtime-image projection omitted a valid generation');
    }
    const registryDigest = String(hive.image_digest ?? '').trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(registryDigest)) {
      throw new Error('Hive runtime-image projection omitted a valid immutable digest');
    }
    // The registry and Hive reads above are awaited external projections.  A
    // reviewed-history update during either await must invalidate this authority
    // read instead of returning the stale in-memory document loaded beforehand.
    const finalDocument = loadDesiredRuntimeReleaseDocument(RUNTIME_RELEASE_PATH);
    const release = desiredRuntimeRelease(finalDocument);
    const finalFingerprint = runtimeReleaseDocumentFingerprint(finalDocument);
    if (
      finalFingerprint !== initialFingerprint
      || !sameRuntimeRelease(release, initialRelease)
    ) {
      throw new Error('desired runtime release authority changed during projection validation');
    }
    const issues = validateRuntimeReleaseProjections(
      release,
      { generation: deploymentGeneration, display_tag: deploymentTag, image_digest: deploymentDigest },
      { generation: Number(hive.generation), display_tag: registryTag, image_digest: registryDigest },
    );
    return issues.length
      ? { issues }
      : { release, documentFingerprint: finalFingerprint, issues: [] };
  } catch (err) {
    return { issues: [err instanceof Error ? err.message : String(err)] };
  }
}


/** Refresh the independently paced credential-broker target. Runtime-image
 * intent is never cached here; it comes only from DesiredRuntimeRelease. */
export async function refreshHiveDesiredImage(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-fsS', '--max-time', '8', HIVE_RUNTIME_IMAGE_URL],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const parsed = JSON.parse(stdout) as { broker_image?: string };
    const brokerImage = (parsed?.broker_image ?? '').trim();
    if (
      brokerImage
      && brokerImage.includes('mcp-auth-proxy')
      && brokerImage !== hiveDesiredBrokerImage
    ) {
      console.log(`[daemon][harness] Hive desired credential-broker image: ${brokerImage}`);
      hiveDesiredBrokerImage = brokerImage;
    }
  } catch {
    // Hive unreachable / endpoint absent → keep last-good broker target.
  }
}

/** Desired credential-broker image for new agents and the idle-gated sidecar
 * roller. Hive is authoritative once its runtime-target endpoint has answered;
 * the daemon env remains a bootstrap fallback during a Hive outage. */
export function desiredBrokerImage(): string {
  return hiveDesiredBrokerImage || BROKER_IMAGE;
}

export function renderAgentManifest(
  agent: AgentInfo,
  opts: K8sSpawnOpts,
  selectorLabels = defaultSelectorLabels(agent),
  renderOpts: {
    includeWorkspacePvc?: boolean;
    imageOverride?: string;
    brokerImageOverride?: string;
    runtimeRelease?: Pick<DesiredRuntimeRelease, 'generation' | 'image_digest'>;
  } = {},
): string {
  const u = agent.username;
  const name = `agent-${u}`;
  const includeWorkspacePvc = renderOpts.includeWorkspacePvc ?? true;
  // SCLI-331: when the idle-gated roller defers an agent's harness upgrade
  // (the agent is busy), it re-renders with the agent's CURRENT live image so
  // re-applying config drift doesn't drag in a mid-turn image roll. Absent an
  // override, use the fleet's desired image.
  const effectiveImage = renderOpts.imageOverride || AGENT_IMAGE;
  const effectiveBrokerImage = renderOpts.brokerImageOverride || BROKER_IMAGE;
  const runtimeReleaseAnnotations = renderOpts.runtimeRelease
    ? `, ${RUNTIME_RELEASE_GENERATION_ANNOTATION}: ${yamlEscape(String(renderOpts.runtimeRelease.generation))}, ${RUNTIME_RELEASE_DIGEST_ANNOTATION}: ${yamlEscape(renderOpts.runtimeRelease.image_digest)}`
    : '';
  // PLAT-3625: MCP/capability env + drift-detection hash for this render.
  const mcpEnv = agentMcpEnv(agent);
  const mcpConfigHash = computeAgentMcpConfigHash(agent, {
    command: opts.command,
    model: opts.model,
    effort: opts.effort,
    contextPrompt: opts.contextPrompt,
  });
  const modelCompatibility = k8sModelCompatibilityState(agent, opts.model, opts.effort);
  const mcpEnvYaml = Object.entries(mcpEnv)
    .map(([k, v]) => `
            - { name: ${k}, value: ${yamlEscape(v)} }`)
    .join('');
  // Cache routes are platform defaults, not parallel env entries. Hive/agent
  // tuning remains authoritative on collision, which prevents duplicate env
  // keys (strategic-merge rejects duplicate list-map names) while preserving
  // a cache-by-default contract for agents without explicit tuning.
  // Let the agent's JS heap actually use the pod memory it was given. Without
  // this Node stops near 4GB regardless of the cgroup limit, so most of a 8Gi
  // (or 12Gi bridge) pod was unreachable and a heavy agent died with a fatal
  // heap error instead of using its RAM. Operator 2026-08-05: "tbh we should
  // give our agents plenty of ram to work with".
  //
  // Placed FIRST so agentTuningEnv/agentPlatformEnv still win on collision —
  // an explicit operator NODE_OPTIONS remains authoritative.
  const heapEnv: Record<string, string> = {
    NODE_OPTIONS: `--max-old-space-size=${agentNodeHeapMb(opts.command)}`,
  };
  const platformEnvYaml = mergeOrderedUniqueEnv(
    heapEnv,
    K8S_PACKAGE_CACHE_ENV,
    agentPlatformEnv(),
    agentTuningEnv(agent),
  )
    .map(([k, v]) => `
            - { name: ${k}, value: ${yamlEscape(v)} }`)
    .join('');
  const contextPromptPath = '/run/shizuha/agent-context/CONTEXT_PROMPT';
  const inlineFailoverEntrypoint = renderK8sInlineFailoverEntrypoint(contextPromptPath);
  const privileged = isPrivilegedK8sAgent(agent);
  const serviceAccountName = privileged ? privilegedServiceAccountName(agent) : undefined;
  const fleetSshStringData = renderFleetSshStringData(opts.fleetSshFiles ?? {});
  const hasFleetSsh = privileged && fleetSshStringData.length > 0;
  const teamSecretBindings = k8sTeamSecretBindingsForAgent(agent);
  const teamSecretVolumesYaml = teamSecretBindings.map((binding) => `
        - name: team-secret-${binding.name}
          secret: { secretName: ${yamlEscape(binding.secretName)}, optional: true, defaultMode: 0400 }`).join('');
  const teamSecretMountsYaml = teamSecretBindings.map((binding) => `
            - { name: team-secret-${binding.name}, mountPath: /run/shizuha/team-creds/${binding.name}, readOnly: true }`).join('');
  const teamSecretFileEnvYaml = teamSecretBindings.flatMap((binding) =>
    binding.keys.map((key) => `
            - { name: ${key}_FILE, value: ${yamlEscape(`/run/shizuha/team-creds/${binding.name}/${key}`)} }`)
  ).join('');
  const deploymentLabels = { ...selectorLabels, 'shizuha.io/task': 'k3s-fleet', 'shizuha.io/runtime': 'k3s-native' };
  const podLabels = { ...selectorLabels, 'shizuha.io/runtime': 'k3s-native' };
  const reconcileStamp = new Date().toISOString();
  // Context prompts can exceed the kernel env+argv limit. Mount as a Secret file
  // and pass only the path through argv; the agent runtime reads the full prompt
  // after startup.
  return `
apiVersion: v1
kind: Secret
metadata:
  name: ${u}-agent-creds
  namespace: ${K8S_NS}
  labels: { app: ${name}, shizuha.io/runtime: k3s-native }
type: Opaque
stringData:
  AGENT_PASSWORD: ${yamlEscape(opts.password)}
  GITHUB_TOKEN: ${yamlEscape(opts.githubToken ?? '')}
  CONTEXT_PROMPT: ${yamlEscape(opts.contextPrompt)}
${hasFleetSsh ? `---
apiVersion: v1
kind: Secret
metadata:
  name: ${u}-fleet-ssh
  namespace: ${K8S_NS}
  labels: { app: ${name}, shizuha.io/runtime: k3s-native, shizuha.io/credential-scope: fleet-ssh }
type: Opaque
stringData:
${fleetSshStringData}
` : ''}${privileged ? `---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${serviceAccountName}
  namespace: ${K8S_NS}
  labels: { app: ${name}, shizuha.io/runtime: k3s-native, shizuha.io/capability-class: privileged }
automountServiceAccountToken: true
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${serviceAccountName}
  labels: { app: ${name}, shizuha.io/runtime: k3s-native, shizuha.io/capability-class: privileged }
subjects:
  - { kind: ServiceAccount, name: ${serviceAccountName}, namespace: ${K8S_NS} }
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: shizuha-fleet-agent-ops
` : ''}
${includeWorkspacePvc ? `---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${u}-workspace
  namespace: ${K8S_NS}
  labels: { app: ${name}, shizuha.io/runtime: k3s-native }
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${process.env['SHIZUHA_FLEET_STORAGE_CLASS'] ?? 'longhorn'}
  resources: { requests: { storage: ${workspacePvcSize()} } }
` : ''}---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${K8S_NS}
  labels: ${yamlFlowMap(deploymentLabels)}
  # daemon-reconciled-at is metadata-only (audit). NEVER put a fresh timestamp on
  # the pod template — that forced Recreate on every kubectl apply even when the
  # config hash was unchanged (fleet thrash 2026-07-09).
  annotations: { ${MCP_CONFIG_HASH_ANNOTATION}: ${yamlEscape(mcpConfigHash)}, ${K8S_RUNTIME_SPEC_REVISION_ANNOTATION}: ${yamlEscape(K8S_RUNTIME_SPEC_REVISION)}, ${K8S_MODEL_POLICY_ANNOTATION}: ${yamlEscape(K8S_MODEL_POLICY)}, ${K8S_PRIMARY_MODEL_ANNOTATION}: ${yamlEscape(modelCompatibility.model)}, ${K8S_EXECUTION_METHOD_ANNOTATION}: ${yamlEscape(modelCompatibility.method)}, ${K8S_REASONING_EFFORT_ANNOTATION}: ${yamlEscape(modelCompatibility.effort)}, shizuha.io/daemon-reconciled-at: ${yamlEscape(reconcileStamp)}${runtimeReleaseAnnotations} }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: ${yamlFlowMap(selectorLabels)} }
  template:
    metadata:
      labels: ${yamlFlowMap(podLabels)}
      # PLAT-3625: hash in the POD template too, so an MCP/capability change
      # rolls the pod (Recreate) even when no other template field changed —
      # the bridge recomposes .mcp.json from env at boot.
      # Only the stable config hash — no volatile timestamps.
      annotations: { ${MCP_CONFIG_HASH_ANNOTATION}: ${yamlEscape(mcpConfigHash)}, ${K8S_RUNTIME_SPEC_REVISION_ANNOTATION}: ${yamlEscape(K8S_RUNTIME_SPEC_REVISION)}${runtimeReleaseAnnotations} }
    spec:
${renderNodePlacement()}      tolerations: []
      # Always own this field explicitly. Omitting it when a privileged agent is
      # demoted lets an older agent-*-ops value survive kubectl apply; deleting
      # that ServiceAccount then leaves the Deployment permanently unschedulable.
      serviceAccountName: ${serviceAccountName ?? 'default'}
      automountServiceAccountToken: ${privileged ? 'true' : 'false'}
      securityContext: { fsGroup: 1000, fsGroupChangePolicy: OnRootMismatch }
      volumes:
        - { name: workspace, persistentVolumeClaim: { claimName: ${u}-workspace } }
        - { name: broker-sock, emptyDir: {} }
        - { name: docker-graph, emptyDir: {} }
        - { name: docker-run, emptyDir: {} }
        - { name: docker-bin, emptyDir: {} }
        - { name: context-prompt, secret: { secretName: ${u}-agent-creds, defaultMode: 0400 } }
        # PLAT-4146: mount the full agent-creds Secret so the runtime can read
        # credentials at use-time (file-first, env fallback). k8s Secret volume
        # mounts hot-update (~1min kubelet sync), so a Secret rotation propagates
        # to a running agent with zero restart.
        - { name: agent-creds, secret: { secretName: ${u}-agent-creds, defaultMode: 0400 } }
${teamSecretVolumesYaml}
${hasFleetSsh ? `        - { name: fleet-ssh-secret, secret: { secretName: ${u}-fleet-ssh, defaultMode: 0400 } }
        - { name: fleet-ssh-home, emptyDir: {} }
` : ''}${privileged ? `        # Materialized on every pod start. The config references the rotating
        # projected token instead of copying token bytes into the workspace PVC.
        - { name: kubeconfig-home, emptyDir: {} }
` : ''}      initContainers:
        - name: docker-cli
          image: docker:27-cli
          command: ["sh","-c","cp /usr/local/bin/docker /docker-bin/docker && chmod 0755 /docker-bin/docker"]
          volumeMounts: [{ name: docker-bin, mountPath: /docker-bin }]
        - name: workspace-permissions
          image: ${effectiveImage}
          command: ["sh","-c","mkdir -p /home/agent/.shizuha/work /home/agent/.shizuha/claude-sessions /home/agent/.shizuha/codex-home && chown 1000:1000 /home/agent/.shizuha /home/agent/.shizuha/work /home/agent/.shizuha/claude-sessions /home/agent/.shizuha/codex-home"]
          # This init MUST run as root to chown the workspace PVC. runAsNonRoot:false
          # is required so it is not rejected when the pod-level securityContext sets
          # runAsNonRoot:true (BRW-12/PLAT-422 hardening) — else kubelet fails the pod
          # with CreateContainerConfigError and it restart-loops (nagi/san, 2026-07-12).
          securityContext: { runAsUser: 0, runAsGroup: 0, runAsNonRoot: false }
          volumeMounts: [{ name: workspace, mountPath: /home/agent/.shizuha }]
${hasFleetSsh ? `        - name: fleet-ssh-materialize
          image: ${AGENT_IMAGE}
          command: ["bash","-lc"]
          args:
            - |
              set -euo pipefail
              install -d -m 0700 -o 1000 -g 1000 /ssh-home
              cp -a /ssh-secret/. /ssh-home/
              chown -R 1000:1000 /ssh-home
              find /ssh-home -type f -exec chmod 0600 {} +
              for f in /ssh-home/*.pub /ssh-home/known_hosts /ssh-home/config; do
                [ ! -e "$f" ] || chmod 0644 "$f"
              done
          # MUST include runAsNonRoot:false like workspace-permissions/dind above:
          # this init runs as root (0700 dir + chown of the SSH home), so under the
          # pod-level runAsNonRoot:true hardening (BRW-12/PLAT-422) the kubelet
          # rejects it with CreateContainerConfigError and the pod restart-loops
          # (san, 2026-07-16) unless we explicitly opt this container out.
          securityContext: { runAsUser: 0, runAsGroup: 0, runAsNonRoot: false }
          volumeMounts:
            - { name: fleet-ssh-secret, mountPath: /ssh-secret, readOnly: true }
            - { name: fleet-ssh-home, mountPath: /ssh-home }
` : ''}${privileged ? `        - name: kubeconfig-materialize
          image: ${effectiveImage}
          command: ["bash","-lc"]
          args:
            - |
              set -euo pipefail
              : "\${KUBERNETES_SERVICE_HOST:?missing Kubernetes service host}"
              port="\${KUBERNETES_SERVICE_PORT_HTTPS:-\${KUBERNETES_SERVICE_PORT:-443}}"
              install -d -m 0700 -o 1000 -g 1000 /kube-home
              cat > /kube-home/config <<EOF
              apiVersion: v1
              kind: Config
              clusters:
              - name: in-cluster
                cluster:
                  server: https://\${KUBERNETES_SERVICE_HOST}:\${port}
                  certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
              users:
              - name: service-account
                user:
                  tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
              contexts:
              - name: in-cluster
                context:
                  cluster: in-cluster
                  user: service-account
              current-context: in-cluster
              EOF
              chown 1000:1000 /kube-home/config
              chmod 0600 /kube-home/config
          securityContext: { runAsUser: 0, runAsGroup: 0, runAsNonRoot: false }
          volumeMounts:
            - { name: kubeconfig-home, mountPath: /kube-home }
` : ''}      containers:
        - name: dind
          image: docker:27-dind
          command: ["dockerd"]
          # Agent Docker builds pull public base layers through the shared
          # registry mirror. Keep graph state ephemeral so it cannot consume
          # the agent's bounded workspace PVC.
          args: ["--host=unix:///var/run/docker.sock","--group=1000","--registry-mirror=http://mirror-dockerhub.registry.svc.cluster.local:5000"]
          env: [{ name: DOCKER_TLS_CERTDIR, value: "" }]
          # dockerd must run as root; runAsUser:0 + runAsNonRoot:false override any
          # pod-level runAsNonRoot:true so dockerd doesn't die (exitCode 1) under the
          # non-root pod default (BRW-12/PLAT-422). Paired with the workspace-permissions fix.
          securityContext: { privileged: true, runAsUser: 0, runAsGroup: 0, runAsNonRoot: false }
          volumeMounts:
            - { name: docker-graph, mountPath: /var/lib/docker }
            - { name: docker-run, mountPath: /var/run }
          resources: { requests: { cpu: 250m, memory: 512Mi }, limits: { cpu: "2", memory: 4Gi } }
        - name: broker
          image: ${effectiveBrokerImage}
          env:
            - { name: AGENT_USERNAME, value: ${yamlEscape(u)} }
            - { name: AGENT_PASSWORD, valueFrom: { secretKeyRef: { name: ${u}-agent-creds, key: AGENT_PASSWORD } } }
            - { name: MCP_AUTH_PROXY_ID_BASE_URL, value: ${yamlEscape(ID_BASE_URL)} }
            - { name: MCP_AUTH_PROXY_SOCKET, value: "/run/shizuha/mcp-auth-proxy/proxy.sock" }
            - { name: MCP_AUTH_PROXY_EXPECTED_AGENT_UID, value: "1000" }
            - { name: MCP_AUTH_PROXY_COORDINATOR_URL, value: ${yamlEscape(COORDINATOR_URL)} }
            - { name: MCP_AUTH_PROXY_COORDINATOR_TOKEN, valueFrom: { secretKeyRef: { name: ${BROKER_TOKEN_SECRET}, key: token } } }
            - { name: SHIZUHA_PLATFORM_URL, value: ${yamlEscape(PLATFORM_URL)} }
            - { name: BACKEND_URL, value: ${yamlEscape(PLATFORM_URL)} }
          volumeMounts: [{ name: broker-sock, mountPath: /run/shizuha/mcp-auth-proxy }]
          readinessProbe:
            exec: { command: ["/mcp-auth-proxy", "healthcheck", "--socket", "/run/shizuha/mcp-auth-proxy/proxy.sock", "--ready", "--timeout", "2s"] }
            periodSeconds: 5
            failureThreshold: 1
          livenessProbe:
            exec: { command: ["/mcp-auth-proxy", "healthcheck", "--socket", "/run/shizuha/mcp-auth-proxy/proxy.sock", "--timeout", "2s"] }
            periodSeconds: 15
            failureThreshold: 4
          resources: { requests: { cpu: 25m, memory: 64Mi }, limits: { cpu: 250m, memory: 256Mi } }
        - name: agent
          image: ${effectiveImage}
          ports:
            - { name: metrics, containerPort: 9103, protocol: TCP }
          command: ["bash","-lc"]
          args:
            - |
${inlineFailoverEntrypoint}
          env:
            - { name: AGENT_ID, value: ${yamlEscape(agent.id)} }
            - { name: AGENT_USERNAME, value: ${yamlEscape(u)} }
            # PLAT-3995: the agent's OWN shizuha-id password (its personal
            # credential, not a privileged one). The runtime's self-login path
            # (AgentTokenManager / mcp client getValidMcpAccessToken) and
            # authenticated live QA (SPA /id/login as itself — the same way a
            # human logs in) both require it; it was wired only into the broker
            # container, which dammed every authenticated user-facing QA task.
            - { name: AGENT_PASSWORD, valueFrom: { secretKeyRef: { name: ${u}-agent-creds, key: AGENT_PASSWORD } } }
            - { name: AGENT_NAME, value: ${yamlEscape(agent.name)} }
            - { name: AGENT_EMAIL, value: ${yamlEscape(agent.email)} }
            - { name: AGENT_ROLE, value: ${yamlEscape(agent.role ?? '')} }${mcpEnvYaml}
            - { name: SHIZUHA_K8S_INLINE_FAILOVER, value: "1" }
            - { name: SHIZUHA_K8S_PRIMARY_COMMAND, value: ${yamlEscape(opts.command)} }
            - { name: SHIZUHA_K8S_PRIMARY_MODEL, value: ${yamlEscape(opts.model)} }
            - { name: SHIZUHA_K8S_PRIMARY_EFFORT, value: ${yamlEscape(opts.effort ?? '')} }
            - { name: SHIZUHA_K8S_PRIMARY_METHOD, value: ${yamlEscape(modelCompatibility.method)} }
            - { name: SHIZUHA_RUNTIME_LANE_GENERATION, value: ${yamlEscape(String(agent.runtimeLaneGeneration ?? ''))} }
            - { name: SHIZUHA_RUNTIME_LANE_DIGEST, value: ${yamlEscape(agent.runtimeLaneDigest ?? '')} }
            # Compatibility fields are explicitly owned by the reconciler.
            # Omitting them let legacy kubectl-set values survive forever even
            # while the actual inline-failover command used Hive's new model.
            - { name: MODEL, value: ${yamlEscape(modelCompatibility.model)} }
            - { name: REASONING_EFFORT, value: ${yamlEscape(modelCompatibility.effort)} }
            - { name: EXECUTION_METHOD, value: ${yamlEscape(modelCompatibility.method)} }
            - { name: MODEL_OVERRIDES, value: ${yamlEscape(modelCompatibility.overrides)} }
            # NO MODEL_FALLBACKS / SHIZUHA_MODEL_FALLBACKS — one agent, one
            # model (operator 2026-08-06: "completely remove the concept of
            # model fallbacks ... only one agent-model is allowed"). These were
            # rendered UNCONDITIONALLY here, so every daemon apply re-added a
            # chain to all 42 daemon-managed agents even after Hive's SoT
            # normalized model_fallbacks to []. Omitting them lets the apply's
            # 3-way merge DELETE the surviving values.
            - { name: SHIZUHA_PLATFORM_URL, value: ${yamlEscape(PLATFORM_URL)} }
            - { name: BACKEND_URL, value: ${yamlEscape(PLATFORM_URL)} }${platformEnvYaml}
            - { name: MCP_AUTH_PROXY_SOCKET, value: "/run/shizuha/mcp-auth-proxy/proxy.sock" }
            - { name: CLAUDE_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN, value: "1" }
            - { name: CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN, value: "1" }
            # Operator 2026-07-10 / 2026-07-28: each agent uses ITS OWN cortex key
            # (minted per identity, name=agent-<username>, traffic_class=own_fleet)
            # so Cortex usage/leases/billing attribute to agent-<username> — NEVER
            # the shared agents-fleet-own-fleet blob. Do NOT mount cortex-fleet-key
            # as CORTEX_API_KEY or SHARED_FALLBACK: missing per-agent key must fail
            # loud (mint into <user>-agent-creds) rather than silently coalesce.
            - { name: OPENAI_API_KEY, valueFrom: { secretKeyRef: { name: ${u}-agent-creds, key: CORTEX_API_KEY, optional: true } } }
            - { name: VLLM_API_KEY, valueFrom: { secretKeyRef: { name: ${u}-agent-creds, key: CORTEX_API_KEY, optional: true } } }
            - { name: CORTEX_API_KEY, valueFrom: { secretKeyRef: { name: ${u}-agent-creds, key: CORTEX_API_KEY, optional: true } } }
            - { name: DOCKER_HOST, value: "unix:///var/run/docker.sock" }
            # PLAT-4238: team-based GitHub identity. When Hive assigns a GITHUB_IDENTITY
            # (non-secret pointer, e.g. sara2574 read-only / kai2574 write), the pod
            # references the shared TEAM-identity Secret directly — no token bytes flow
            # through the roster/agent-creds, and rotating an identity = updating ONE
            # Secret. Legacy (no identity): per-agent broker-grant copy in agent-creds.
            - { name: GITHUB_TOKEN, valueFrom: { secretKeyRef: { name: ${githubIdentityFor(agent) ? `${githubIdentityFor(agent)}-github-token` : `${u}-agent-creds`}, key: GITHUB_TOKEN, optional: true } } }
            # ORIG-18: Shizuha Origin (Forgejo) is the primary source-control host.
            # Per-agent Forgejo token rides in <user>-agent-creds (write-scoped for
            # write-team agents, read for the rest). Rendered HERE so daemon
            # re-renders never drop it again (the ORIG-15 hand-patched env was lost
            # on every re-render — 28 agents were missing it by 2026-07-15).
            - { name: FORGEJO_TOKEN, valueFrom: { secretKeyRef: { name: ${u}-agent-creds, key: FORGEJO_TOKEN, optional: true } } }
            - { name: ORIGIN_TOKEN, valueFrom: { secretKeyRef: { name: ${u}-agent-creds, key: FORGEJO_TOKEN, optional: true } } }
${teamSecretFileEnvYaml}
${privileged ? `            - { name: KUBECONFIG, value: "/home/agent/.kube/config" }
` : ''}          volumeMounts:
            - { name: workspace, mountPath: /home/agent/.shizuha }
            # /workspace MUST persist: agent pods restart by design on token
            # rotation (exit 143), and without this mount every restart wiped
            # all cloned repos + unpushed commits (jun lost the finished
            # SCLI-204 branches on a pod roll, 2026-07-04). Same PVC, subPath
            # so repo checkouts do not clutter the .shizuha config tree.
            - { name: workspace, mountPath: /workspace, subPath: work }
            # Session state must survive restarts too: /home/agent/.claude and
            # /home/agent/.codex were ephemeral, so every rotation broke session
            # resume ("No conversation found with session ID") and dropped all
            # conversation context (docker agents host-mounted both).
            - { name: workspace, mountPath: /home/agent/.claude, subPath: claude-sessions }
            - { name: workspace, mountPath: /home/agent/.codex, subPath: codex-home }
            - { name: broker-sock, mountPath: /run/shizuha/mcp-auth-proxy }
            - { name: context-prompt, mountPath: /run/shizuha/agent-context, readOnly: true }
            # PLAT-4146: agent-creds volume mount for hot-reloadable credentials.
            # k8s Secret volume mounts hot-update (~1min kubelet sync), so a
            # Secret rotation propagates to a running agent with zero restart.
            - { name: agent-creds, mountPath: /run/shizuha/agent-creds, readOnly: true }
${teamSecretMountsYaml}
            - { name: docker-bin, mountPath: /usr/local/bin/docker, subPath: docker }
            - { name: docker-run, mountPath: /var/run }
${hasFleetSsh ? `            - { name: fleet-ssh-home, mountPath: /home/agent/.ssh, readOnly: true }
` : ''}${privileged ? `            - { name: kubeconfig-home, mountPath: /home/agent/.kube, readOnly: true }
` : ''}          resources: { ${agentContainerResources(opts.command)} }
`;
}

/** Create/refresh the agent's k8s objects (idempotent kubectl apply). */
export function spawnAgentK8s(agent: AgentInfo, opts: K8sSpawnOpts): void {
  const workspacePvcName = `${agent.username}-workspace`;
  const includeWorkspacePvc = !resourceExists('pvc', workspacePvcName);
  // SCLI-331: decouple harness upgrades from every other apply. Unless the
  // idle-gated roller explicitly forces the desired image, PRESERVE the agent's
  // current live image — a config-drift re-apply or a daemon restart must not
  // roll 46 agents' harness at once. New agents (no live deployment) fall
  // through to the desired image inside renderAgentManifest.
  let imageOverride = opts.imageOverride;
  let brokerImageOverride = opts.brokerImageOverride;
  let runtimeRelease: Pick<DesiredRuntimeRelease, 'generation' | 'image_digest'> | undefined = opts.runtimeRelease;
  if (!imageOverride || !brokerImageOverride) {
    const live = getAgentK8sDeploymentState(agent);
    if (live?.duplicateEnvMetadata) {
      repairAgentK8sDuplicateEnvMetadata(agent);
    }
    const liveImage = live?.currentImage;
    if (!imageOverride && liveImage) imageOverride = liveImage;
    const liveBrokerImage = live?.currentBrokerImage;
    if (!brokerImageOverride && liveBrokerImage) brokerImageOverride = liveBrokerImage;
    if (!runtimeRelease && live?.runtimeReleaseGeneration && live.runtimeReleaseDigest) {
      // Preserve roller-owned authority stamps during ordinary config applies.
      runtimeRelease = {
        generation: live.runtimeReleaseGeneration,
        image_digest: live.runtimeReleaseDigest,
      };
    }
  }
  let githubToken = usableSecretValue(opts.githubToken) ?? githubTokenFromAgentEnv(agent);
  if (!githubToken && agentExpectsGitHubToken(agent)) {
    // A transient Hive/daemon refresh must never turn a healthy pod's Secret
    // into GITHUB_TOKEN="".  Prefer the durable AgentCredential; if that read
    // is temporarily incomplete, preserve the live last-known-good Secret and
    // fail closed when neither source has a value.
    githubToken = existingAgentSecretValue(agent.username, 'GITHUB_TOKEN');
    // ORIG-18/PLAT-4238/PLAT-4683: team-identity agents get GITHUB_TOKEN from
    // the SHARED `<identity>-github-token` Secret via secretKeyRef, not their
    // own creds — so a HIBERNATED agent (own-secret token empty by design) was
    // wrongly refused a wake. The shared identity Secret is the live source;
    // resolve from it before failing closed. Still fail closed when even the
    // shared Secret is empty (a genuinely broken identity credential).
    const identity = githubIdentityFor(agent);
    if (!githubToken && identity) {
      githubToken = existingSharedGithubIdentityToken(identity);
    }
    if (!githubToken) {
      throw new Error(
        `agent-${agent.username}: active GitHub capability has no durable credential or live Secret value; ` +
          'refusing to apply an empty GITHUB_TOKEN',
      );
    }
  }
  const manifest = renderAgentManifest(
    agent,
    { ...opts, githubToken },
    deploymentSelectorLabels(agent),
    {
      includeWorkspacePvc,
      ...(imageOverride ? { imageOverride } : {}),
      ...(brokerImageOverride ? { brokerImageOverride } : {}),
      ...(runtimeRelease ? { runtimeRelease } : {}),
    },
  );
  // HIVE-553: validate the rendered manifest client-side BEFORE the live
  // apply. A render bug must fail loud with the agent named — never reach the
  // cluster, never leave a half-applied object set.
  try {
    kubectlApplyManifest(['apply', '--dry-run=client', '-n', K8S_NS, '-f', '-'], manifest);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `agent-${agent.username}: rendered k8s manifest failed client-side validation; ` +
        `fix the manifest template (renderAgentManifest), the live apply was NOT attempted: ${detail}`,
    );
  }
  if (!includeWorkspacePvc) {
    ensureWorkspacePvcCapacity(workspacePvcName);
  }
  kubectlApplyManifest(['apply', '-n', K8S_NS, '-f', '-'], manifest);
  // Apply does not remove objects omitted from the desired manifest. Revoke
  // stale capability-class credentials/RBAC explicitly, by exact owned name.
  if (!isPrivilegedK8sAgent(agent)) {
    deleteOwnedAgentResource('clusterrolebinding', privilegedServiceAccountName(agent), agent, false);
    deleteOwnedAgentResource('serviceaccount', privilegedServiceAccountName(agent), agent, true);
  }
  if (!requiresFleetSshForK8sAgent(agent)) {
    deleteOwnedAgentResource('secret', `${agent.username}-fleet-ssh`, agent, true);
  }
  console.log(`[daemon] ${agent.name}: applied k3s-native Deployment agent-${agent.username} (ns ${K8S_NS}, placement=${K8S_NODE_SELECTOR || 'scheduler'})`);
}

function deploymentStateFromJson(raw: string, agent: AgentInfo): K8sDeploymentState {
  const parsed = JSON.parse(raw) as {
    metadata?: { annotations?: Record<string, string>; generation?: number; resourceVersion?: string };
    spec?: { replicas?: number; template?: { spec?: {
      containers?: Array<{ name?: string; image?: string }>;
      initContainers?: Array<{ name?: string; image?: string }>;
    } } };
    status?: { observedGeneration?: number; updatedReplicas?: number; readyReplicas?: number; availableReplicas?: number };
  };
  // SCLI-331: the agent container's live image drives the roller's image-preserve
  // decision — without it, every apply would fall through to the desired image
  // and roll on any config change.
  const currentImage = (parsed.spec?.template?.spec?.containers ?? []).find((c) => c.name === 'agent')?.image ?? '';
  const currentBrokerImage = (parsed.spec?.template?.spec?.containers ?? []).find((c) => c.name === 'broker')?.image ?? '';
  const currentWorkspaceInitImage = (parsed.spec?.template?.spec?.initContainers ?? [])
    .find((c) => c.name === 'workspace-permissions')?.image ?? '';
  // SCLI-331: the live config-hash annotation powers the boot-idempotency skip
  // in startAgentProcess. Missing it here made getAgentK8sDeploymentState always
  // return configHash=undefined, so the skip never fired.
  const configHash = parsed.metadata?.annotations?.[MCP_CONFIG_HASH_ANNOTATION];
  const runtimeSpecRevision = parsed.metadata?.annotations?.[K8S_RUNTIME_SPEC_REVISION_ANNOTATION];
  const runtimeReleaseGenerationRaw = parsed.metadata?.annotations?.[RUNTIME_RELEASE_GENERATION_ANNOTATION];
  const runtimeReleaseGeneration = runtimeReleaseGenerationRaw ? Number(runtimeReleaseGenerationRaw) : undefined;
  const runtimeReleaseDigest = parsed.metadata?.annotations?.[RUNTIME_RELEASE_DIGEST_ANNOTATION];
  const duplicateEnvMetadata = duplicateEnvMetadataInDeployment(parsed as unknown as Record<string, unknown>);
  return {
    agentId: agent.id,
    username: agent.username,
    name: `agent-${agent.username}`,
    replicas: parsed.spec?.replicas ?? 0,
    readyReplicas: parsed.status?.readyReplicas ?? 0,
    availableReplicas: parsed.status?.availableReplicas ?? 0,
    ...(parsed.metadata?.generation !== undefined ? { generation: parsed.metadata.generation } : {}),
    ...(parsed.status?.observedGeneration !== undefined
      ? { observedGeneration: parsed.status.observedGeneration }
      : {}),
    ...(parsed.status?.updatedReplicas !== undefined ? { updatedReplicas: parsed.status.updatedReplicas } : {}),
    ...(currentImage ? { currentImage } : {}),
    ...(parsed.metadata?.resourceVersion ? { resourceVersion: parsed.metadata.resourceVersion } : {}),
    ...(currentWorkspaceInitImage ? { currentWorkspaceInitImage } : {}),
    ...(currentBrokerImage ? { currentBrokerImage } : {}),
    ...(configHash ? { configHash } : {}),
    ...(runtimeSpecRevision ? { runtimeSpecRevision } : {}),
    ...(Number.isSafeInteger(runtimeReleaseGeneration) ? { runtimeReleaseGeneration } : {}),
    ...(runtimeReleaseDigest ? { runtimeReleaseDigest } : {}),
    ...(duplicateEnvMetadata ? { duplicateEnvMetadata: true } : {}),
  };
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Atomically apply only reviewed runtime-release fields to one Deployment. */
export function rollAgentK8sRuntimeRelease(
  agent: AgentInfo,
  expected: K8sDeploymentState,
  release: Pick<DesiredRuntimeRelease, 'generation' | 'image_digest' | 'display_tag'>,
): void {
  if (!expected.resourceVersion) {
    throw new Error(`agent-${agent.username}: runtime release CAS requires metadata.resourceVersion`);
  }
  if (!expected.currentImage) {
    throw new Error(`agent-${agent.username}: runtime release CAS requires the observed agent image`);
  }
  const deployment = `deployment/agent-${agent.username}`;
  const raw = kubectl(['get', '-n', K8S_NS, deployment, '-o', 'json']);
  const parsed = JSON.parse(raw) as {
    metadata?: { resourceVersion?: string; annotations?: Record<string, string> };
    spec?: { template?: { metadata?: { annotations?: Record<string, string> }; spec?: {
      containers?: Array<{ name?: string; image?: string }>;
      initContainers?: Array<{ name?: string; image?: string }>;
    } } };
  };
  if (parsed.metadata?.resourceVersion !== expected.resourceVersion) {
    throw new Error(
      `agent-${agent.username}: runtime release CAS conflict before mutation ` +
      `(expected resourceVersion ${expected.resourceVersion}, got ${parsed.metadata?.resourceVersion ?? '<missing>'})`,
    );
  }
  const containers = parsed.spec?.template?.spec?.containers ?? [];
  const agentIndex = containers.findIndex((container) => container.name === 'agent');
  if (agentIndex < 0 || containers[agentIndex]?.image !== expected.currentImage) {
    throw new Error(`agent-${agent.username}: runtime release CAS observed image changed before mutation`);
  }
  const initContainers = parsed.spec?.template?.spec?.initContainers ?? [];
  const workspaceInitIndex = initContainers.findIndex((container) => container.name === 'workspace-permissions');
  const workspaceInitImage = workspaceInitIndex >= 0 ? initContainers[workspaceInitIndex]?.image : undefined;
  if (workspaceInitIndex >= 0 && !workspaceInitImage) {
    throw new Error(`agent-${agent.username}: runtime release CAS found workspace-permissions without an image`);
  }
  const metadataAnnotations = parsed.metadata?.annotations;
  const templateAnnotations = parsed.spec?.template?.metadata?.annotations;
  if (!metadataAnnotations || !templateAnnotations) {
    throw new Error(`agent-${agent.username}: runtime release CAS requires Deployment and pod-template annotations maps`);
  }
  const generationPath = jsonPointerSegment(RUNTIME_RELEASE_GENERATION_ANNOTATION);
  const digestPath = jsonPointerSegment(RUNTIME_RELEASE_DIGEST_ANNOTATION);
  const patch: Array<Record<string, unknown>> = [
    { op: 'test', path: '/metadata/resourceVersion', value: expected.resourceVersion },
    { op: 'test', path: `/spec/template/spec/containers/${agentIndex}/image`, value: expected.currentImage },
  ];
  if (workspaceInitIndex >= 0) {
    patch.push({
      op: 'test',
      path: `/spec/template/spec/initContainers/${workspaceInitIndex}/image`,
      value: workspaceInitImage,
    });
  }
  if (expected.runtimeReleaseGeneration != null) {
    patch.push({
      op: 'test',
      path: `/metadata/annotations/${generationPath}`,
      value: String(expected.runtimeReleaseGeneration),
    });
  }
  if (expected.runtimeReleaseDigest) {
    patch.push({
      op: 'test',
      path: `/metadata/annotations/${digestPath}`,
      value: expected.runtimeReleaseDigest,
    });
  }
  const image = canonicalRuntimeImage(release);
  patch.push(
    { op: 'add', path: `/metadata/annotations/${generationPath}`, value: String(release.generation) },
    { op: 'add', path: `/metadata/annotations/${digestPath}`, value: release.image_digest },
    { op: 'add', path: `/spec/template/metadata/annotations/${generationPath}`, value: String(release.generation) },
    { op: 'add', path: `/spec/template/metadata/annotations/${digestPath}`, value: release.image_digest },
    { op: 'replace', path: `/spec/template/spec/containers/${agentIndex}/image`, value: image },
  );
  if (workspaceInitIndex >= 0) {
    patch.push({
      op: 'replace',
      path: `/spec/template/spec/initContainers/${workspaceInitIndex}/image`,
      value: image,
    });
  }
  kubectl(['patch', '-n', K8S_NS, deployment, '--type=json', '-p', JSON.stringify(patch)]);
  console.log(
    `[daemon] ${agent.name}: atomically applied runtime release generation ${release.generation} ` +
    `to agent-${agent.username} (resourceVersion=${expected.resourceVersion})`,
  );
}

export function getAgentK8sDeploymentState(agent: AgentInfo): K8sDeploymentState | null {
  try {
    return deploymentStateFromJson(
      kubectl(['get', '-n', K8S_NS, `deployment/agent-${agent.username}`, '-o', 'json']),
      agent,
    );
  } catch {
    return null;
  }
}

/** Async Deployment existence/state preflight — does not block the event loop. */
export async function getAgentK8sDeploymentStateAsync(
  agent: AgentInfo,
): Promise<K8sDeploymentState | null> {
  try {
    const json = await kubectlAsync([
      'get', '-n', K8S_NS, `deployment/agent-${agent.username}`, '-o', 'json',
    ], undefined, 15_000);
    return deploymentStateFromJson(json, agent);
  } catch {
    return null;
  }
}

/**
 * Read the exact RuntimeLane fence rendered into the pod plus the broker and
 * harness/provider health surfaces from inside the agent container. Deployment
 * Ready alone is insufficient: a bridge can stay alive while unauthenticated or
 * provider-quota backed off.
 */
export async function probeAgentK8sRuntimeLane(agent: AgentInfo): Promise<K8sRuntimeLaneProbe> {
  if (!isK8sAgent(agent)) throw new Error('runtime_lane_probe_requires_k8s_agent');
  const script = [
    'printf "%s\\n%s\\n" "$SHIZUHA_RUNTIME_LANE_GENERATION" "$SHIZUHA_RUNTIME_LANE_DIGEST"',
    'if curl -fsS --max-time 3 --unix-socket /run/shizuha/mcp-auth-proxy/proxy.sock http://localhost/readyz >/dev/null; then echo 1; else echo 0; fi',
    'curl -fsS --max-time 5 http://127.0.0.1:8080/health',
  ].join('; ');
  const { stdout } = await execFileAsync(
    KUBECTL_BIN,
    [
      `--request-timeout=${K8S_KUBECTL_REQUEST_TIMEOUT}`,
      'exec', '-n', K8S_NS, `deployment/agent-${agent.username}`,
      '-c', 'agent', '--', 'sh', '-c', script,
    ],
    {
      encoding: 'utf8',
      timeout: RUNTIME_LANE_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: kubectlEnv(),
    },
  );
  const [generationRaw = '', digestRaw = '', brokerRaw = '', ...runtimeLines] = stdout.split('\n');
  const generation = Number(generationRaw.trim());
  const digest = digestRaw.trim().toLowerCase();
  if (!Number.isInteger(generation) || generation <= 0 || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('runtime_lane_probe_missing_exact_fence');
  }
  let runtime: Record<string, unknown>;
  try {
    const parsed = JSON.parse(runtimeLines.join('\n').trim()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('runtime health payload is not an object');
    }
    runtime = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`runtime_lane_probe_invalid_health: ${(error as Error).message}`);
  }
  return {
    generation,
    digest,
    brokerReady: brokerRaw.trim() === '1',
    runtime,
  };
}

/**
 * Read the bridge's live busy latch immediately before a running harness roll.
 * Session/activity timestamps can remain unchanged throughout a long-running
 * tool subprocess, so they are only a coarse scheduling hint — never final
 * evidence that interrupting the pod is safe.
 *
 * Callers must fail closed on every rejection. In particular, a successful
 * HTTP response without a strict boolean `busy` field is not proof of idleness.
 */
async function readAgentK8sBridgeActivity(
  agent: AgentInfo,
): Promise<{ busy: boolean; queueDepth: number | null }> {
  if (!isK8sAgent(agent)) throw new Error('harness_roll_busy_probe_requires_k8s_agent');
  const { stdout } = await execFileAsync(
    KUBECTL_BIN,
    [
      `--request-timeout=${K8S_KUBECTL_REQUEST_TIMEOUT}`,
      'exec', '-n', K8S_NS, `deployment/agent-${agent.username}`,
      '-c', 'agent', '--', 'sh', '-c',
      'curl -fsS --max-time 3 http://127.0.0.1:8080/health',
    ],
    {
      encoding: 'utf8',
      timeout: HARNESS_ROLL_BUSY_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      env: kubectlEnv(),
    },
  );
  let health: unknown;
  try {
    health = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`harness_roll_busy_probe_invalid_health: ${(error as Error).message}`);
  }
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    throw new Error('harness_roll_busy_probe_invalid_health: payload is not an object');
  }
  const busy = (health as Record<string, unknown>)['busy'];
  if (typeof busy !== 'boolean') {
    throw new Error('harness_roll_busy_probe_invalid_health: busy is not a boolean');
  }
  const rawQueueDepth = (health as Record<string, unknown>)['queueDepth'];
  const queueDepth = Number.isSafeInteger(rawQueueDepth) && (rawQueueDepth as number) >= 0
    ? rawQueueDepth as number
    : null;
  return { busy, queueDepth };
}

export async function probeAgentK8sBridgeBusy(agent: AgentInfo): Promise<boolean> {
  return (await readAgentK8sBridgeActivity(agent)).busy;
}

/**
 * Read the newest structured heartbeat result from a k8s-native gateway.
 *
 * Native agent stdout is not a child stream of the host daemon, so the normal
 * manager stdout ingestion path never sees these records. Keep this recovery
 * probe tightly bounded: it is only consumed after a stale legacy bridge has
 * already failed the live busy fence, and any kubectl/log ambiguity returns no
 * evidence so the rollout remains fail closed.
 */
export async function readLatestAgentK8sHeartbeatOutcomeLogLine(
  agent: AgentInfo,
): Promise<string | undefined> {
  if (!isK8sAgent(agent)) return undefined;
  try {
    const { stdout } = await execFileAsync(
      KUBECTL_BIN,
      [
        `--request-timeout=${K8S_KUBECTL_REQUEST_TIMEOUT}`,
        'logs', '-n', K8S_NS, `deployment/agent-${agent.username}`,
        '-c', 'agent', '--since=15m', '--tail=2048',
      ],
      {
        encoding: 'utf8',
        timeout: HARNESS_ROLL_BUSY_PROBE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: kubectlEnv(),
      },
    );
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i]?.includes(HEARTBEAT_OUTCOME_LOG_PREFIX)) return lines[i];
    }
  } catch {
    // Missing pod, log transport failure, timeout, and oversized output are all
    // "no evidence". The manager retains the live bridge fence in every case.
  }
  return undefined;
}

/**
 * Read only checkpoint metadata from a legacy gateway's local session API.
 *
 * The script deliberately emits neither prompts nor tool output.  A tool result
 * appended after its side effect is the compatibility proof consumed by the
 * runtime roller when the old bridge cannot implement drain-v1 itself.
 */
export async function readLatestAgentK8sLegacyGatewayCheckpoint(
  agent: AgentInfo,
): Promise<K8sLegacyGatewayCheckpoint | undefined> {
  if (!isK8sAgent(agent)) return undefined;
  const script = `
const base = await (await fetch('http://127.0.0.1:8080/v1/sessions')).json();
const sessionId = String(base?.sessions?.[0]?.id ?? '');
if (!sessionId) process.exit(2);
const detail = await (await fetch('http://127.0.0.1:8080/v1/sessions/' + encodeURIComponent(sessionId))).json();
const messages = Array.isArray(detail?.messages) ? detail.messages : [];
let toolResultAt = 0;
for (const message of messages) {
  let content = message?.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { /* ordinary user text */ }
  }
  if (message?.role !== 'user' || !Array.isArray(content)) continue;
  if (!content.some((part) => part && part.type === 'tool_result')) continue;
  const timestamp = Number(message?.timestamp);
  if (Number.isFinite(timestamp)) toolResultAt = Math.max(toolResultAt, timestamp);
}
process.stdout.write(JSON.stringify({ sessionId, toolResultAt }));
`.trim();
  try {
    const { stdout } = await execFileAsync(
      KUBECTL_BIN,
      [
        `--request-timeout=${K8S_KUBECTL_REQUEST_TIMEOUT}`,
        'exec', '-n', K8S_NS, `deployment/agent-${agent.username}`,
        '-c', 'agent', '--', 'node', '--input-type=module', '-e', script,
      ],
      {
        encoding: 'utf8',
        timeout: HARNESS_ROLL_BUSY_PROBE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        env: kubectlEnv(),
      },
    );
    const parsed = JSON.parse(stdout.trim()) as Partial<K8sLegacyGatewayCheckpoint>;
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId
      || !Number.isFinite(parsed.toolResultAt)) return undefined;
    return { sessionId: parsed.sessionId, toolResultAt: Number(parsed.toolResultAt) };
  } catch {
    // Any endpoint/schema/transport ambiguity is no checkpoint evidence.
    return undefined;
  }
}

/**
 * Ask a bridge to reserve its next safe turn boundary for a runtime roll.
 *
 * Drain-v1 bridges latch ingress/autonomous scheduling before reporting
 * `ready`, closing the race between an idle health read and the pod-template
 * update. Older bridges fall back to the strict live busy latch; the manager
 * applies a second idle observation before using that compatibility path.
 */
export async function prepareAgentK8sBridgeForRuntimeRoll(
  agent: AgentInfo,
  targetImage: string,
): Promise<K8sRuntimeRollBridgePreparation> {
  if (!isK8sAgent(agent)) throw new Error('harness_roll_drain_requires_k8s_agent');
  const normalizedTarget = targetImage.trim();
  if (!normalizedTarget) throw new Error('harness_roll_drain_requires_target_image');
  const leaseBackoffKey = `${agent.id}\0${normalizedTarget}`;
  const leaseBackoff = runtimeRollLegacyLeaseBackoffUntil.get(leaseBackoffKey);
  const leaseBackoffUntil = leaseBackoff?.until ?? 0;
  if (leaseBackoffUntil > Date.now()) {
    return {
      busy: true,
      protocol: 'drain-v1',
      ...(leaseBackoff?.reserved ? { drainReserved: true } : {}),
    };
  }
  if (leaseBackoffUntil > 0) {
    try {
      const activity = await readAgentK8sBridgeActivity(agent);
      if (activity.busy || activity.queueDepth !== 0) {
        runtimeRollLegacyLeaseBackoffUntil.set(leaseBackoffKey, {
          until: Date.now() + 15_000,
          // The prior lease has expired. This is only a queued-work backoff,
          // not permission to skip a different bridge that can drain now.
          reserved: false,
        });
        return { busy: true, protocol: 'drain-v1' };
      }
    } catch (error) {
      runtimeRollLegacyLeaseBackoffUntil.set(leaseBackoffKey, {
        until: Date.now() + 15_000,
        reserved: false,
      });
      throw error;
    }
    runtimeRollLegacyLeaseBackoffUntil.delete(leaseBackoffKey);
  } else {
    // A controller restart loses the in-memory lease backoff above. Never arm
    // a new drain over an already-queued bridge even when that history is
    // gone: drain-v1 parks the first dequeued row at the boundary and renewing
    // its lease can reduce progress to one turn per controller lifetime. This
    // preflight is also the correct prerequisite for drain-v2, whose ingress
    // fence prevents new admissions but does not make pre-existing in-memory
    // rows replaceable. If an older bridge omits queueDepth, preserve the
    // endpoint compatibility path below; every ambiguous endpoint/transport
    // result still fails closed there.
    try {
      const activity = await readAgentK8sBridgeActivity(agent);
      if (activity.queueDepth !== null && activity.queueDepth > 0) {
        runtimeRollLegacyLeaseBackoffUntil.set(leaseBackoffKey, {
          until: Date.now() + 15_000,
          reserved: false,
        });
        return { busy: true, protocol: 'drain-v1' };
      }
    } catch {
      // Compatibility probe only. The authoritative drain call below retains
      // the existing typed bridge-absent/unreachable failure behavior.
    }
  }
  const requestId = createHash('sha256')
    .update(`${agent.id}\0${normalizedTarget}`)
    .digest('hex')
    .slice(0, 32);
  const body = JSON.stringify({
    requestId,
    targetImage: normalizedTarget,
    leaseMs: 60_000,
  });
  const command = [
    'curl -sS --max-time 3',
    '-X POST',
    '-H "Content-Type: application/json"',
    `--data-binary ${shellQuote(body)}`,
    "-w '\\n__SHIZUHA_HTTP_STATUS__:%{http_code}'",
    'http://127.0.0.1:8080/v1/runtime/rollout-drain',
  ].join(' ');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      KUBECTL_BIN,
      [
        `--request-timeout=${K8S_KUBECTL_REQUEST_TIMEOUT}`,
        'exec', '-n', K8S_NS, `deployment/agent-${agent.username}`,
        '-c', 'agent', '--', 'sh', '-c', command,
      ],
      {
        encoding: 'utf8',
        timeout: HARNESS_ROLL_BUSY_PROBE_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        env: kubectlEnv(),
      },
    ));
  } catch (error) {
    const failure = error as Error & { code?: string | number; stderr?: string };
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    // A local curl refusal proves kubectl reached the agent container but the
    // bridge process is not listening. Keep this distinct from kubectl/API
    // transport failures: the manager may confirm a stable bridge absence and
    // repair a false-positive Ready pod, but must never turn a control-plane
    // timeout into permission to interrupt an active agent.
    if (
      Number(failure.code) === 7
      && /curl:\s*\(7\)\s*Failed to connect to 127\.0\.0\.1 port 8080\b/.test(stderr)
    ) {
      throw new Error(`harness_roll_bridge_absent: ${failure.message}`);
    }
    throw new Error(
      `harness_roll_bridge_unreachable: ${failure.message || String(error)}`,
    );
  }
  const marker = '\n__SHIZUHA_HTTP_STATUS__:';
  const markerAt = stdout.lastIndexOf(marker);
  if (markerAt < 0) {
    throw new Error('harness_roll_drain_invalid_response: missing HTTP status');
  }
  const status = Number.parseInt(stdout.slice(markerAt + marker.length).trim(), 10);
  const payload = stdout.slice(0, markerAt).trim();
  if (status === 404 || status === 405) {
    let busy: boolean;
    try {
      busy = await probeAgentK8sBridgeBusy(agent);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.startsWith('harness_roll_busy_probe_invalid_health:')) throw error;
      throw new Error(
        `harness_roll_bridge_unreachable: ${detail}`,
      );
    }
    return {
      busy,
      protocol: 'legacy-health',
    };
  }
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new Error(`harness_roll_drain_http_${Number.isFinite(status) ? status : 'invalid'}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error(`harness_roll_drain_invalid_response: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('harness_roll_drain_invalid_response: payload is not an object');
  }
  const response = parsed as Record<string, unknown>;
  if (
    (response['protocol'] !== 1 && response['protocol'] !== 2)
    || response['requestId'] !== requestId
    || response['targetImage'] !== normalizedTarget
  ) {
    throw new Error('harness_roll_drain_invalid_response: request fence mismatch');
  }
  const state = response['state'];
  if (state !== 'draining' && state !== 'ready') {
    throw new Error('harness_roll_drain_invalid_response: invalid state');
  }
  if (
    typeof response['busy'] !== 'boolean'
    || typeof response['acceptingTurns'] !== 'boolean'
    || !Number.isSafeInteger(response['pendingAcceptedTurns'])
    || (response['pendingAcceptedTurns'] as number) < 0
  ) {
    throw new Error('harness_roll_drain_invalid_response: incomplete readiness proof');
  }
  if (
    response['protocol'] === 2
    && (
      response['ingressFenced'] !== true
      || !Number.isSafeInteger(response['admissionVersion'])
      || (response['admissionVersion'] as number) < 0
    )
  ) {
    throw new Error('harness_roll_drain_invalid_response: incomplete ingress fence');
  }
  // Drain-v1 does not prove that a queued row is replayable. In particular,
  // Connect's transport delivery receipt is written when the WebSocket frame
  // is sent, before the gateway processes the row. A pod replacement with any
  // accepted rows can therefore lose work. Fail closed until a protocol that
  // carries a durable processing acknowledgement and ingress fence is live.
  if (
    state === 'ready'
    && (
      response['busy'] !== false
      || response['acceptingTurns'] !== false
      || response['pendingAcceptedTurns'] !== 0
    )
  ) {
    if (
      response['protocol'] === 1
      && response['busy'] === false
      && response['acceptingTurns'] === false
      && (response['pendingAcceptedTurns'] as number) > 0
    ) {
      // Do not immediately probe this same drain-v1 lease again: calling the
      // endpoint renews it, which can park its retained backlog forever. Let
      // the bounded bridge lease expire, add one event-loop grace window for
      // dequeue, then retry. The row is never authorized for replacement.
      const now = Date.now();
      const reportedLeaseUntil = typeof response['leaseUntil'] === 'number'
        && Number.isFinite(response['leaseUntil'])
        ? response['leaseUntil']
        : now;
      const leaseUntil = Math.min(now + 120_000, Math.max(now, reportedLeaseUntil));
      runtimeRollLegacyLeaseBackoffUntil.set(leaseBackoffKey, {
        until: Math.max(
          now + LEGACY_DRAIN_BACKLOG_GRACE_MS,
          leaseUntil + LEGACY_DRAIN_BACKLOG_GRACE_MS,
        ),
        reserved: true,
      });
      return { busy: true, protocol: 'drain-v1', drainReserved: true };
    }
    throw new Error('harness_roll_drain_invalid_response: contradictory ready state');
  }
  return {
    busy: state !== 'ready',
    protocol: response['protocol'] === 2 ? 'drain-v2' : 'drain-v1',
    ...(state === 'draining' ? { drainReserved: true } : {}),
    ...(response['protocol'] === 2
      ? { fenceVersion: response['admissionVersion'] as number }
      : {}),
  };
}

/** Update only a Deployment's runtime pod-template fields. This narrowly-scoped
 * strategic patch never includes spec.replicas and verifies the result. */
function updateAgentK8sRuntimeTemplate(
  agent: AgentInfo,
  agentImage: string,
  brokerImage?: string,
  expectedState: 'stopped' | 'running' = 'stopped',
): void {
  const targetAgentImage = agentImage.trim();
  if (!targetAgentImage) throw new Error(`agent-${agent.username}: refusing an empty runtime image`);

  const before = getAgentK8sDeploymentState(agent);
  if (!before) throw new Error(`agent-${agent.username}: cannot update runtime image; Deployment is missing`);
  if (expectedState === 'stopped' && before.replicas !== 0) {
    throw new Error(
      `agent-${agent.username}: refusing stopped-template stage at replicas=${before.replicas}; use the idle-gated running-agent roller`,
    );
  }
  if (expectedState === 'running' && before.replicas === 0) {
    throw new Error(
      `agent-${agent.username}: refusing running-template roll at replicas=0; use the stopped-template stage`,
    );
  }

  const containers: Array<{
    name: string;
    image: string;
    command?: string[];
    args?: string[];
    env?: Array<{ name: string; value: string }>;
    resources?: AgentContainerResourceSpec;
  }> = [
    {
      name: 'agent',
      image: targetAgentImage,
      command: ['bash', '-lc'],
      // The failover supervisor is rendered into the Deployment template, not
      // loaded from the image. Always converge it alongside the image/revision
      // so renderer fixes cannot be stranded on otherwise-healthy agents.
      args: [renderK8sInlineFailoverEntrypoint('/run/shizuha/agent-context/CONTEXT_PROMPT')],
    },
  ];
  const targetBrokerImage = brokerImage?.trim();
  if (targetBrokerImage) containers.push({ name: 'broker', image: targetBrokerImage });
  const modelCompatibility = k8sModelCompatibilityState(agent);
  containers[0]!.resources = agentContainerResourceSpec(
    runtimeCommandForExecutionMethod(modelCompatibility.method),
  );
  containers[0]!.env = [
    { name: 'MODEL', value: modelCompatibility.model },
    { name: 'REASONING_EFFORT', value: modelCompatibility.effort },
    { name: 'EXECUTION_METHOD', value: modelCompatibility.method },
    { name: 'MODEL_FALLBACKS', value: modelCompatibility.fallbacks },
    { name: 'MODEL_OVERRIDES', value: modelCompatibility.overrides },
    ...Object.entries(K8S_PACKAGE_CACHE_ENV).map(([name, value]) => ({ name, value })),
  ];
  const patch = JSON.stringify({
    metadata: {
      annotations: {
        [K8S_RUNTIME_SPEC_REVISION_ANNOTATION]: K8S_RUNTIME_SPEC_REVISION,
        [K8S_MODEL_POLICY_ANNOTATION]: K8S_MODEL_POLICY,
        [K8S_PRIMARY_MODEL_ANNOTATION]: modelCompatibility.model,
        [K8S_EXECUTION_METHOD_ANNOTATION]: modelCompatibility.method,
        [K8S_REASONING_EFFORT_ANNOTATION]: modelCompatibility.effort,
      },
    },
    spec: {
      template: {
        metadata: {
          annotations: { [K8S_RUNTIME_SPEC_REVISION_ANNOTATION]: K8S_RUNTIME_SPEC_REVISION },
        },
        spec: {
          containers,
          initContainers: [{ name: 'workspace-permissions', image: targetAgentImage }],
        },
      },
    },
  });
  kubectl([
    'patch', '-n', K8S_NS, `deployment/agent-${agent.username}`,
    '--type=strategic', '-p', patch,
  ]);

  const after = getAgentK8sDeploymentState(agent);
  if (!after) throw new Error(`agent-${agent.username}: Deployment disappeared after runtime-template update`);
  if (after.currentImage !== targetAgentImage) {
    throw new Error(
      `agent-${agent.username}: runtime-template update did not converge agent image ` +
        `(wanted ${targetAgentImage}, got ${after.currentImage ?? 'missing'})`,
    );
  }
  if (after.currentWorkspaceInitImage !== targetAgentImage) {
    throw new Error(
      `agent-${agent.username}: runtime-template update did not converge workspace init image ` +
        `(wanted ${targetAgentImage}, got ${after.currentWorkspaceInitImage ?? 'missing'})`,
    );
  }
  if (targetBrokerImage && after.currentBrokerImage !== targetBrokerImage) {
    throw new Error(
      `agent-${agent.username}: runtime-template update did not converge broker image ` +
        `(wanted ${targetBrokerImage}, got ${after.currentBrokerImage ?? 'missing'})`,
    );
  }
  if (after.runtimeSpecRevision !== K8S_RUNTIME_SPEC_REVISION) {
    throw new Error(
      `agent-${agent.username}: runtime-template update did not stamp revision ${K8S_RUNTIME_SPEC_REVISION}`,
    );
  }
  // A concurrent Start/Stop may legitimately change replicas while the patch
  // is in flight. We never write replicas, so do not countermand that intent.
  console.log(
    `[daemon][runtime-roll] updated ${expectedState} agent-${agent.username} template ` +
      `at ${targetAgentImage} (replicas ${before.replicas} -> ${after.replicas})`,
  );
}

export function stageStoppedAgentK8sRuntime(
  agent: AgentInfo,
  agentImage: string,
  brokerImage?: string,
): void {
  updateAgentK8sRuntimeTemplate(agent, agentImage, brokerImage, 'stopped');
}

/** Roll only a running Deployment's pod template. Unlike spawnAgentK8s this
 * does not re-render credentials, fleet-SSH, capabilities, or replicas, so an
 * unrelated provisioning defect cannot starve a harness update. */
export function rollRunningAgentK8sRuntime(
  agent: AgentInfo,
  agentImage: string,
  brokerImage?: string,
): void {
  updateAgentK8sRuntimeTemplate(agent, agentImage, brokerImage, 'running');
}


function githubTokenFromAgentEnv(agent: AgentInfo): string | undefined {
  const envToken = usableSecretValue(agent.env?.['GITHUB_TOKEN']);
  if (envToken) return envToken;

  for (const cred of agent.credentials ?? []) {
    let normalizedCred = cred;
    try {
      normalizedCred = normalizeAgentCredential(cred, agent);
    } catch {
      continue;
    }
    if (normalizedCred.scope !== 'github') continue;
    if (!normalizedCred.injectAsEnv || !isAgentCredentialGrantCurrentlyActive(normalizedCred)) continue;

    if (normalizedCred.envMapping) {
      for (const [dataKey, envName] of Object.entries(normalizedCred.envMapping)) {
        const token = usableSecretValue(normalizedCred.credentialData[dataKey]);
        if (envName === 'GITHUB_TOKEN' && token) {
          return token;
        }
      }
      continue;
    }

    for (const [key, value] of Object.entries(normalizedCred.credentialData)) {
      const token = usableSecretValue(value);
      if (key.toUpperCase() === 'GITHUB_TOKEN' && token) return token;
    }
  }
  return undefined;
}

function hasActiveGithubCredentialGrant(agent: AgentInfo): boolean {
  for (const cred of agent.credentials ?? []) {
    let normalizedCred = cred;
    try {
      normalizedCred = normalizeAgentCredential(cred, agent);
    } catch {
      continue;
    }
    if (normalizedCred.scope !== 'github') continue;
    if (!isAgentCredentialGrantCurrentlyActive(normalizedCred)) continue;

    if (normalizedCred.injectAsEnv !== true) continue;

    if (normalizedCred.envMapping) {
      for (const envName of Object.values(normalizedCred.envMapping)) {
        if (envName === 'GITHUB_TOKEN') return true;
      }
      continue;
    }

    const hasGithubTokenKey = Object.keys(normalizedCred.credentialData ?? {}).some((key) => key.toUpperCase() === 'GITHUB_TOKEN');
    if (hasGithubTokenKey) return true;
  }

  return false;
}

function agentExpectsGitHubToken(agent: AgentInfo | undefined): boolean {
  if (!agent) return false;
  const grantedScopes = [
    ...(agent.credentialGrantScopes ?? []),
    ...(agent.effectiveCapabilities?.credentialGrantScopes ?? []),
  ];
  return !!githubIdentityFor(agent)
    || hasActiveGithubCredentialGrant(agent)
    || !!githubTokenFromAgentEnv(agent)
    || grantedScopes.some((scope) => scope === 'github' || String(scope).startsWith('github:'));
}

function existingAgentSecretValue(username: string, key: string): string | undefined {
  try {
    const raw = kubectl(['get', '-n', K8S_NS, `secret/${username}-agent-creds`, '-o', 'json']);
    const parsed = JSON.parse(raw) as { data?: Record<string, string> };
    const encoded = parsed.data?.[key];
    if (!encoded) return undefined;
    return usableSecretValue(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** GITHUB_TOKEN from the shared `<identity>-github-token` Secret (PLAT-4238
 * team identity). This is where a team-identity agent's token actually lives —
 * the agent's own creds Secret is empty by design — so the wake pre-flight must
 * read it here for a hibernated agent. Returns undefined if absent/empty. */
function existingSharedGithubIdentityToken(identity: string): string | undefined {
  try {
    const raw = kubectl(['get', '-n', K8S_NS, `secret/${identity}-github-token`, '-o', 'json']);
    const parsed = JSON.parse(raw) as { data?: Record<string, string> };
    const encoded = parsed.data?.['GITHUB_TOKEN'];
    if (!encoded) return undefined;
    return usableSecretValue(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

function agentDeploymentHasGithubEnvRef(item: { spec?: { template?: { spec?: { containers?: Array<{ name?: string; env?: Array<Record<string, any>> }> } } } }, expectedSecretName: string): boolean {
  const containers = item.spec?.template?.spec?.containers ?? [];
  const agentContainer = containers.find((container) => container.name === 'agent');
  const env = agentContainer?.env ?? [];
  return env.some((entry) => (
    entry?.name === 'GITHUB_TOKEN'
    && entry?.valueFrom?.secretKeyRef?.name === expectedSecretName
    && entry?.valueFrom?.secretKeyRef?.key === 'GITHUB_TOKEN'
  ));
}

interface K8sSecretInventory {
  available: boolean;
  dataByName: Map<string, Record<string, string>>;
}

function listK8sSecretDataByName(): K8sSecretInventory {
  try {
    // Do not fetch Secret payloads. Besides unnecessarily moving sensitive
    // bytes through the daemon, a full `-o json` inventory can exceed
    // execFileSync's buffer (observed ENOBUFS in rt-fleet) and turn a healthy
    // fleet into an "unknown inventory" on every reconcile tick. The template
    // emits only the name and whether the one key relevant to this check exists.
    const presenceTemplate = '{{range .items}}{{.metadata.name}}{{"\\t"}}{{if index .data "GITHUB_TOKEN"}}1{{end}}{{"\\n"}}{{end}}';
    const raw = kubectl([
      'get', '-n', K8S_NS, 'secrets', '-o', `go-template=${presenceTemplate}`,
    ]);
    const dataByName = new Map<string, Record<string, string>>();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [name, githubTokenPresent] = line.split('\t', 2);
      if (!name) continue;
      dataByName.set(name, githubTokenPresent === '1' ? { GITHUB_TOKEN: 'present' } : {});
    }
    return {
      available: true,
      dataByName,
    };
  } catch (err) {
    // An unreadable inventory is UNKNOWN, not an empty inventory. Treating a
    // transient API/RBAC failure as "every Secret is missing" marks the whole
    // fleet credential-drifted and makes runtime-reconcile Recreate healthy
    // Deployments on every tick. The executable in-pod GitHub probe remains
    // the health authority; a later successful inventory pass can still repair
    // a genuinely absent Secret.
    console.warn(
      '[daemon] unable to inventory k8s agent Secrets; suppressing Secret-presence drift until a later observation: ' +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { available: false, dataByName: new Map() };
  }
}

/** PLAT-4958: the `Progressing` condition, when present. */
function progressingConditionOf(
  conditions?: Array<{ type?: string; status?: string; reason?: string; lastUpdateTime?: string }>,
): { reason?: string; lastUpdateTime?: string } | undefined {
  return (conditions ?? []).find((c) => c.type === 'Progressing');
}

/**
 * PLAT-4958 (review, aoi): how long the rollout suppression may last.
 *
 * Kubernetes keeps `Progressing.reason = ReplicaSetUpdated` for the whole
 * rollout, flipping to `ProgressDeadlineExceeded` only after
 * `progressDeadlineSeconds` — which is **600s on all 51 agent Deployments**.
 * Suppressing for the entire condition lifetime would therefore make a
 * genuinely broken new pod (CrashLoopBackOff, bad image, failed startup)
 * silent for up to ten minutes, trading a false-positive burst for a
 * real-outage blind spot.
 *
 * Bound it explicitly instead of inheriting that number. A healthy agent pod
 * reaches Ready in seconds (measured 2026-07-21: sandbox created 08:50:05,
 * pid1 08:50:08), and the observed race window was ~6s wide, so 120s is ~20x
 * the demonstrated need while cutting the blind window to a fifth of the
 * deadline. Past this, a still-unready Deployment pages as before.
 */
export const K8S_ROLLOUT_SUPPRESS_WINDOW_MS = 120_000;

/**
 * PLAT-5120: authoritative, daemon-owned rollout intent for Recreate applies.
 *
 * Kubernetes condition state is not a reliable discriminator during an
 * ordinary daemon re-apply (for example an MCP/capability hash refresh): a
 * single-replica Recreate Deployment can already report the new generation as
 * observed and `Progressing=NewReplicaSetAvailable` while its replacement pod
 * is still starting.  The daemon knows that it just applied that Deployment,
 * so retain that fact for the same bounded window as the controller-derived
 * rollout guard.  This is intentionally process-local and fail-loud after a
 * daemon restart; stale state can never buy more than the fixed window.
 */
const k8sDaemonApplyStartedAtByAgentId = new Map<string, number>();

export function noteK8sDaemonApply(agentId: string, startedAtMs: number = Date.now()): void {
  k8sDaemonApplyStartedAtByAgentId.set(agentId, startedAtMs);
}

export function k8sDaemonApplyInProgress(
  agentId: string,
  nowMs: number = Date.now(),
): boolean {
  const startedAtMs = k8sDaemonApplyStartedAtByAgentId.get(agentId);
  if (startedAtMs === undefined) return false;
  const ageMs = nowMs - startedAtMs;
  if (ageMs >= 0 && ageMs < K8S_ROLLOUT_SUPPRESS_WINDOW_MS) return true;
  k8sDaemonApplyStartedAtByAgentId.delete(agentId);
  return false;
}

/**
 * PLAT-4958: is this Deployment mid-rollout right now?
 *
 * A Deployment that has just been retargeted reports
 * `replicas=1, updatedReplicas=1, readyReplicas=0, availableReplicas=0` for the
 * few seconds between new-ReplicaSet creation and the new pod passing its
 * readiness gate. Those counts are IDENTICAL to a genuinely broken pod, so the
 * counts alone cannot tell the two apart — which is why the GitHub-auth probe
 * paged eight healthy agents in a single burst on 2026-07-21 (8/8 of them had a
 * ReplicaSet created in the preceding six seconds; no agent that was not rolling
 * alerted, and no agent that was rolling escaped).
 *
 * Kubernetes does distinguish them, via the `Progressing` condition:
 *   ReplicaSetUpdated       -> rollout in flight
 *   NewReplicaSetAvailable  -> rollout settled
 *   ProgressDeadlineExceeded-> rollout stuck (NOT suppressed here — a stuck
 *                              rollout is a real fault and must stay visible)
 *
 * `observedGeneration < generation` covers the narrower window where the spec
 * has been written but the Deployment controller has not observed it yet.
 *
 * The `ReplicaSetUpdated` branch is TIME-BOUNDED by
 * K8S_ROLLOUT_SUPPRESS_WINDOW_MS: a rollout that has been "in flight" longer
 * than that is not a race, it is a stuck or failing pod, and it pages.
 * Without the bound this guard would inherit `progressDeadlineSeconds` (600s)
 * as its blind window.
 */
export function k8sDeploymentRolloutInProgress(
  state: K8sDeploymentState | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!state) return false;
  if (
    state.generation !== undefined
    && state.observedGeneration !== undefined
    && state.observedGeneration < state.generation
  ) return true;
  if (state.progressingReason !== 'ReplicaSetUpdated') return false;
  // Missing/unparseable timestamp: fail CLOSED (do not suppress). An unknown
  // rollout age must not buy unlimited silence.
  if (state.progressingUpdatedAtMs === undefined) return false;
  return (nowMs - state.progressingUpdatedAtMs) < K8S_ROLLOUT_SUPPRESS_WINDOW_MS;
}

/** List k3s-native agent Deployments and map deploy/agent-<username> back to agent ids where possible.
 *
 * Runtime reconciliation opts into non-k8s desired agents so stale Deployments
 * remain observable long enough to scale them down. Other callers retain the
 * desired-k8s-only view used for harness convergence and credential probes.
 */
export function listK8sAgentDeployments(
  agents: AgentInfo[],
  options: { includeNonK8sDesired?: boolean } = {},
): K8sDeploymentState[] {
  let raw: string;
  try {
    raw = kubectl(['get', '-n', K8S_NS, 'deployments', '-o', 'json']);
  } catch (err) {
    // An unreadable control plane is NOT "zero Deployments". Returning []
    // made every desired-enabled agent look missing, then spawn painted
    // Hive Failed with the raw kubectl credential dump (2026-08-14 devops).
    throw new K8sObserveError(
      classifyKubectlFailure(err) === 'auth' ? 'auth' : 'unreachable',
      operatorFacingK8sError(err),
    );
  }
  const parsed = JSON.parse(raw) as { items?: Array<{
    metadata?: { name?: string; annotations?: Record<string, string>; generation?: number };
    spec?: { replicas?: number; template?: { spec?: {
      containers?: Array<{ name?: string; image?: string; env?: Array<Record<string, any>> }>;
      initContainers?: Array<{ name?: string; image?: string; env?: Array<Record<string, any>> }>;
    } } };
    status?: {
      observedGeneration?: number; updatedReplicas?: number; readyReplicas?: number; availableReplicas?: number;
      conditions?: Array<{ type?: string; status?: string; reason?: string; lastUpdateTime?: string }>;
    };
  }> };
  const byUsername = new Map(agents.map((a) => [a.username, a]));
  const agentsExpectingGithub = new Set(agents.filter(agentExpectsGitHubToken).map((a) => a.username));
  const secretInventory = agentsExpectingGithub.size > 0
    ? listK8sSecretDataByName()
    : { available: true, dataByName: new Map<string, Record<string, string>>() };

  return (parsed.items ?? []).flatMap((item) => {
    const name = item.metadata?.name ?? '';
    if (!name.startsWith('agent-')) return [];
    const username = name.slice('agent-'.length);
    const agent = byUsername.get(username);
    // SCLI-331 autonomy: only k8s-managed agents in the desired roster participate
    // in image convergence / harness-roll evidence. Orphan Deployments (no roster
    // agent) and bare_metal leftovers (e.g. abandoned agent-fumi) must not block
    // noteConvergedAgentRuntimeImage — that was the forever-"rolling" UI hang.
    if (!agent) return [];
    if (
      !options.includeNonK8sDesired
      && agent.runtimeEnvironment
      && agent.runtimeEnvironment !== 'k8s'
    ) return [];
    const configHash = item.metadata?.annotations?.[MCP_CONFIG_HASH_ANNOTATION];
    const runtimeSpecRevision = item.metadata?.annotations?.[K8S_RUNTIME_SPEC_REVISION_ANNOTATION];
    const runtimeReleaseGenerationRaw = item.metadata?.annotations?.[RUNTIME_RELEASE_GENERATION_ANNOTATION];
    const runtimeReleaseGeneration = runtimeReleaseGenerationRaw ? Number(runtimeReleaseGenerationRaw) : undefined;
    const runtimeReleaseDigest = item.metadata?.annotations?.[RUNTIME_RELEASE_DIGEST_ANNOTATION];
    const duplicateEnvMetadata = duplicateEnvMetadataInDeployment(item as unknown as Record<string, unknown>);
    const agentContainer = (item.spec?.template?.spec?.containers ?? []).find((c) => c.name === 'agent');
    const brokerContainer = (item.spec?.template?.spec?.containers ?? []).find((c) => c.name === 'broker');
    const currentImage = (agentContainer as { image?: string } | undefined)?.image ?? '';
    const currentBrokerImage = (brokerContainer as { image?: string } | undefined)?.image ?? '';
    const currentWorkspaceInitImage = (item.spec?.template?.spec?.initContainers ?? [])
      .find((container) => container.name === 'workspace-permissions')?.image ?? '';
    const state: K8sDeploymentState = {
      agentId: agent?.id ?? username,
      username,
      name,
      replicas: item.spec?.replicas ?? 0,
      readyReplicas: item.status?.readyReplicas ?? 0,
      availableReplicas: item.status?.availableReplicas ?? 0,
      ...(item.metadata?.generation !== undefined ? { generation: item.metadata.generation } : {}),
      ...(item.status?.observedGeneration !== undefined
        ? { observedGeneration: item.status.observedGeneration }
        : {}),
      ...(item.status?.updatedReplicas !== undefined ? { updatedReplicas: item.status.updatedReplicas } : {}),
      ...(() => {
        const cond = progressingConditionOf(item.status?.conditions);
        const at = cond?.lastUpdateTime ? Date.parse(cond.lastUpdateTime) : NaN;
        return {
          ...(cond?.reason !== undefined ? { progressingReason: cond.reason } : {}),
          ...(Number.isFinite(at) ? { progressingUpdatedAtMs: at } : {}),
        };
      })(),
      ...(currentImage ? { currentImage } : {}),
      ...(currentWorkspaceInitImage ? { currentWorkspaceInitImage } : {}),
      ...(currentBrokerImage ? { currentBrokerImage } : {}),
      ...(configHash ? { configHash } : {}),
      ...(runtimeSpecRevision ? { runtimeSpecRevision } : {}),
      ...(Number.isSafeInteger(runtimeReleaseGeneration) ? { runtimeReleaseGeneration } : {}),
      ...(runtimeReleaseDigest ? { runtimeReleaseDigest } : {}),
      ...(duplicateEnvMetadata ? { duplicateEnvMetadata: true } : {}),
    };

    if (agentExpectsGitHubToken(agent)) {
      // PLAT-4238: identity-assigned agents are healthy when GITHUB_TOKEN refs the
      // TEAM-identity Secret (<identity>-github-token); legacy agents when it refs
      // <user>-agent-creds. Check the ref + data key of the EXPECTED secret so an
      // identity flip shows as drift (repair re-renders) while a converged identity
      // wiring does NOT loop the reconciler.
      const identity = agent ? githubIdentityFor(agent) : undefined;
      const expectedSecret = identity ? `${identity}-github-token` : `${username}-agent-creds`;
      const githubTokenEnvWired = agentDeploymentHasGithubEnvRef(item, expectedSecret);
      const githubTokenSecretPresent = secretInventory.available
        ? !!secretInventory.dataByName.get(expectedSecret)?.['GITHUB_TOKEN']
        : undefined;
      state.githubCredentialExpected = true;
      state.githubTokenEnvWired = githubTokenEnvWired;
      if (githubTokenSecretPresent !== undefined) {
        state.githubTokenSecretPresent = githubTokenSecretPresent;
      }
      state.githubCredentialDrift = !githubTokenEnvWired
        || (secretInventory.available && !githubTokenSecretPresent);
    }

    return [state];
  });
}

function probeFailure(
  agent: AgentInfo,
  reason: K8sGitHubCredentialProbeReason,
  detail?: string,
): K8sGitHubCredentialProbeResult {
  const team = agent.team || 'unknown';
  return {
    agentId: agent.id,
    username: agent.username,
    team,
    ownerGroup: team,
    expected: true,
    ok: false,
    reason,
    checkedAt: new Date().toISOString(),
    probeRepo: GITHUB_AUTH_PROBE_REPO || undefined,
    detail,
  };
}

function probeOk(agent: AgentInfo, identity: string): K8sGitHubCredentialProbeResult {
  const team = agent.team || 'unknown';
  return {
    agentId: agent.id,
    username: agent.username,
    team,
    ownerGroup: team,
    expected: true,
    ok: true,
    reason: 'ok',
    checkedAt: new Date().toISOString(),
    identity,
    probeRepo: GITHUB_AUTH_PROBE_REPO || undefined,
  };
}

function githubProbeScript(): string {
  const repoProbe = GITHUB_AUTH_PROBE_REPO
    ? `repo_response="$(gh api ${shellQuote(`repos/${GITHUB_AUTH_PROBE_REPO}`)} --include --jq '.full_name' 2>&1)" || { printf '%s\\n' "$repo_response" >&2; exit 1; }\n`
    : '';
  return [
    'set -euo pipefail',
    'if [ -z "${GITHUB_TOKEN:-}" ]; then echo "GITHUB_TOKEN_EMPTY" >&2; exit 42; fi',
    'user_response="$(gh api user --include --jq .login 2>&1)" || { printf \'%s\\n\' "$user_response" >&2; exit 1; }',
    'login="$(printf \'%s\\n\' "$user_response" | tail -n 1 | tr -d \'\\r\')"',
    repoProbe.trimEnd(),
    'printf "%s" "$login"',
  ].filter(Boolean).join('\n');
}

/**
 * PLAT-3170 / PLAT-1254 fail-loud invariant:
 * a k8s-native runtime with an active GitHub grant is healthy only if the
 * running agent container has a non-empty GITHUB_TOKEN and the token can call
 * GitHub (`gh api user`) plus the configured private repo probe. Merely seeing
 * non-empty Secret data is insufficient: stale/invalid/wrong-scope tokens must
 * be visible as a GitHub-auth outage, with per-agent labels for alert routing.
 */
export function probeK8sGithubCredentialHealth(
  agents: AgentInfo[],
  deploymentStates = listK8sAgentDeployments(agents),
  enabledIds?: Set<string>,
): K8sGitHubCredentialProbeResult[] {
  const statesByUsername = new Map(deploymentStates.map((state) => [state.username, state]));
  return agents.filter((agent) =>
    shouldSpawnK8sAgent(agent)
    && agentExpectsGitHubToken(agent)
    // PLAT-4027: only probe agents the runtime reconcile actually keeps a k8s
    // Deployment running for. `shouldSpawnK8sAgent` is merely the "eligible for
    // k8s" set; the reconcile ADDITIONALLY requires enabled + status==='active'
    // before it starts/keeps a Deployment (state.ts computeRuntimeReconcilePlan
    // -> toStartK8s). Without mirroring that gate the probe pages
    // deployment_unready/"Deployment not found" for eligible-but-disabled/paused
    // agents that legitimately have no Deployment (akira, misaki), re-paging
    // cluster managers every 6h. When `enabledIds` is omitted, keep the
    // un-scoped behaviour (callers/tests that pre-scope their agent list).
    && (enabledIds === undefined || (enabledIds.has(agent.id) && agent.status === 'active'))
    // PLAT-4958: do not probe an agent whose Deployment is mid-rollout. For the
    // seconds between new-ReplicaSet creation and the new pod becoming Ready the
    // Deployment reports ready=0/available=0, which trips the `deployment_unready`
    // early return below and pages the cluster manager with a GitHub-credential
    // ANDON for an agent that is merely restarting. Measured 2026-07-21: one
    // alert burst of 8 agents, 8/8 with a ReplicaSet created in the preceding 6
    // seconds, zero functional impairment. A STUCK rollout is deliberately NOT
    // suppressed (ProgressDeadlineExceeded is not treated as in-progress), and
    // convergence/roll monitoring owns that signal separately.
    && !k8sDaemonApplyInProgress(agent.id)
    && !k8sDeploymentRolloutInProgress(statesByUsername.get(agent.username))
  ).map((agent) => {
    const state = statesByUsername.get(agent.username);
    if (!state || state.replicas <= 0 || state.readyReplicas <= 0 || state.availableReplicas <= 0) {
      return probeFailure(agent, 'deployment_unready', state
        ? [
            `replicas=${state.replicas}`,
            `ready=${state.readyReplicas}`,
            `available=${state.availableReplicas}`,
            `generation=${state.generation ?? 'unknown'}`,
            `observedGeneration=${state.observedGeneration ?? 'unknown'}`,
            `progressingReason=${state.progressingReason ?? 'unknown'}`,
            `progressingUpdatedAtMs=${state.progressingUpdatedAtMs ?? 'unknown'}`,
          ].join(', ')
        : `Deployment not found (inventory=${deploymentStates.length}/${agents.length})`);
    }
    // PLAT-4045 / PLAT-4038: secret/env inventory is a reconcile hint, not
    // the health authority. `listK8sSecretDataByName()` can be empty when the
    // daemon/probe cannot list Secrets (RBAC/transient kubectl failure), and a
    // Secret can be present while the token is stale/invalid. The executable
    // invariant is the runtime path agents actually use: non-empty
    // GITHUB_TOKEN plus `gh api user`/repo access inside the running pod. Keep
    // githubCredentialDrift for runtime-reconcile repair, but never page
    // credential_unwired before the authoritative exec probe has run.
    try {
      const out = kubectlGithubAuthProbe([
        'exec',
        '-n', K8S_NS,
        `deployment/agent-${agent.username}`,
        '-c', 'agent',
        '--',
        // bash, not sh: the probe script uses `set -o pipefail`, which the
        // Ubuntu agent image's /bin/sh (dash) rejects before any check runs.
        'bash',
        '-lc',
        githubProbeScript(),
      ]).trim();
      return probeOk(agent, out || 'unknown');
    } catch (err) {
      const detail = sanitizeProbeDetail(err);
      const reason = githubProbeFailureReason(err, detail);
      return probeFailure(agent, reason, detail || 'kubectl exec/gh probe failed');
    }
  });
}

/** Stop a k3s-native agent (scale its Deployment to 0) and verify the desired state converged. */
export function stopAgentK8s(agent: AgentInfo, timeoutMs = 30_000): void {
  const before = getAgentK8sDeploymentState(agent);
  if (!before) {
    console.log(`[daemon] ${agent.name}: k3s-native Deployment agent-${agent.username} already absent (desired stopped)`);
    return;
  }

  kubectl(['scale', '-n', K8S_NS, `deployment/agent-${agent.username}`, '--replicas=0']);

  const deadline = Date.now() + timeoutMs;
  let last: K8sDeploymentState | null = null;
  do {
    last = getAgentK8sDeploymentState(agent);
    if (!last || (last.replicas === 0 && last.readyReplicas === 0 && last.availableReplicas === 0)) {
      console.log(`[daemon] ${agent.name}: scaled k3s-native Deployment to 0`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  } while (Date.now() < deadline);

  throw new Error(
    `k8s Deployment agent-${agent.username} did not converge to replicas=0` +
    (last ? ` (replicas=${last.replicas}, ready=${last.readyReplicas}, available=${last.availableReplicas})` : ''),
  );
}

/**
 * Restore an existing k3s-native Deployment that was prematurely scaled down
 * during a k8s-to-local handoff. This deliberately preserves the last known
 * working pod template; it does not rewrite Hive's desired runtime placement.
 */
export function restoreAgentK8s(agent: AgentInfo, timeoutMs = 10_000): void {
  const before = getAgentK8sDeploymentState(agent);
  if (!before) {
    throw new Error(`k8s Deployment agent-${agent.username} is absent; cannot restore the previous backend`);
  }
  if (before.replicas > 0) {
    console.log(`[daemon] ${agent.name}: k3s-native Deployment is already scaled above 0`);
    return;
  }

  kubectl(['scale', '-n', K8S_NS, `deployment/agent-${agent.username}`, '--replicas=1']);

  const deadline = Date.now() + timeoutMs;
  let last: K8sDeploymentState | null = null;
  do {
    last = getAgentK8sDeploymentState(agent);
    if (last && last.replicas === 1) {
      console.log(`[daemon] ${agent.name}: restored previous k3s-native Deployment to 1 while local handoff is unavailable`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  } while (Date.now() < deadline);

  throw new Error(
    `k8s Deployment agent-${agent.username} did not accept replicas=1` +
    (last ? ` (replicas=${last.replicas}, ready=${last.readyReplicas}, available=${last.availableReplicas})` : ''),
  );
}

/**
 * Python run in the agent container to archive + clear the PVC sqlite.
 * Must stay aligned with SESSION_SCOPED_RESET_TABLES in manager.ts.
 * Archives first (VACUUM INTO) so the old transcript remains queryable.
 * Session id is injected via SESSION_ID — do not append it as a shell argv
 * after the heredoc (that never reaches Python).
 */
function k8sSessionResetShell(sessionId: string): string {
  return `SESSION_ID=${JSON.stringify(sessionId)} python3 - <<'PY'
import json, os, sqlite3
from datetime import datetime, timezone
sid = os.environ["SESSION_ID"]
dbs = [
    "/home/agent/.shizuha/.shizuha-state.db",
    "/home/agent/.shizuha/.codex-state.db",
]
tables = [
    ("messages_fts", "session_id"),
    ("messages", "session_id"),
    ("session_message_transcript", "session_id"),
    ("session_interrupt_checkpoints", "session_id"),
    ("session_wire_prefix", "session_id"),
    ("session_provider_prefix_snapshots", "session_id"),
    ("session_provider_prefix_heads", "session_id"),
    ("session_context_token_anchors", "session_id"),
    ("session_inbound_processing", "session_id"),
    ("session_recovery_heads", "session_id"),
    ("session_recovery_deferred", "session_id"),
    ("sessions", "id"),
]
arch_dir = "/home/agent/.shizuha/archived-sessions"
os.makedirs(arch_dir, exist_ok=True)
ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
report = {"session_id": sid, "archived": [], "deleted": {}}
for db in dbs:
    if not os.path.exists(db):
        continue
    arch = os.path.join(arch_dir, f"{os.path.basename(db)}-{sid}-{ts}.db")
    try:
        src = sqlite3.connect(db)
        src.execute("VACUUM INTO ?", (arch,))
        src.close()
        report["archived"].append(arch)
    except Exception as exc:
        report.setdefault("archive_errors", []).append(f"{db}: {exc}")
    con = sqlite3.connect(db)
    for table, col in tables:
        exists = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?",
            (table,),
        ).fetchone()
        if not exists:
            continue
        cur = con.execute(f"DELETE FROM {table} WHERE {col}=?", (sid,))
        report["deleted"][f"{os.path.basename(db)}:{table}"] = cur.rowcount
    con.commit()
    con.close()
claude = "/home/agent/.shizuha/.claude-session-id"
if os.path.exists(claude):
    os.remove(claude)
    report["removed_claude_session_id"] = True
# Hive Live activity tails these JSONL files. Leaving the doomed 294k-empty
# turns in place makes a fresh session still look queue-blind.
rotated_logs = []
for name in (".telemetry.jsonl", ".audit-log.jsonl"):
    src = os.path.join("/home/agent/.shizuha", name)
    if os.path.exists(src) and os.path.getsize(src) > 0:
        dest = os.path.join(arch_dir, f"{name}-{sid}-{ts}")
        os.replace(src, dest)
        open(src, "a").close()
        rotated_logs.append(dest)
if rotated_logs:
    report["rotated_logs"] = rotated_logs
print(json.dumps(report))
PY`;
}

export interface K8sSessionResetResult {
  ok: boolean;
  error?: string;
  archived?: string[];
  deleted?: Record<string, number>;
}

/**
 * Reset a k3s-native agent's PVC session, then SIGKILL-recycle the pod so
 * the gateway cannot flush the poisoned transcript back on a graceful stop.
 * Host `~/.shizuha/workspaces/<user>` is the wrong file for these agents.
 */
export async function resetK8sAgentRuntimeSession(
  agent: AgentInfo,
  timeoutMs = 120_000,
): Promise<K8sSessionResetResult> {
  if (!isK8sAgent(agent)) {
    return { ok: false, error: `Agent ${agent.username} is not k8s-native` };
  }
  const sessionId = `agent-session-${agent.id}`;
  const procTimeoutMs = Math.max(timeoutMs, 60_000);
  let stdout = '';
  try {
    const result = await execFileAsync(
      KUBECTL_BIN,
      [
        `--request-timeout=${Math.max(5, Math.ceil(procTimeoutMs / 1000))}s`,
        'exec', '-n', K8S_NS, `deployment/agent-${agent.username}`,
        '-c', 'agent', '--', 'sh', '-c', k8sSessionResetShell(sessionId),
      ],
      { encoding: 'utf-8', timeout: procTimeoutMs, maxBuffer: 8 * 1024 * 1024, env: kubectlEnv() },
    );
    stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '');
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    return {
      ok: false,
      error: `k8s session reset exec failed for agent-${agent.username}: ${String(e.stderr || e.stdout || e.message || '').slice(0, 500)}`,
    };
  }

  let parsed: { archived?: string[]; deleted?: Record<string, number> } = {};
  try {
    const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{}';
    parsed = JSON.parse(line) as { archived?: string[]; deleted?: Record<string, number> };
  } catch {
    parsed = {};
  }

  try {
    await kubectlAsync([
      'delete', 'pod', '-n', K8S_NS,
      '-l', `app=agent-${agent.username}`,
      '--force', '--grace-period=0',
    ], undefined, procTimeoutMs);
    await kubectlAsync([
      'rollout', 'status', '-n', K8S_NS, `deployment/agent-${agent.username}`,
      `--timeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
    ], undefined, procTimeoutMs);
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    return {
      ok: false,
      error: `session rows cleared but pod recycle failed for agent-${agent.username}: ${String(e.stderr || e.stdout || e.message || '').slice(0, 500)}`,
      archived: parsed.archived,
      deleted: parsed.deleted,
    };
  }

  console.log(`[daemon] ${agent.name}: reset k8s PVC session ${sessionId}`);
  return { ok: true, archived: parsed.archived, deleted: parsed.deleted };
}

/** Restart exactly one k3s-native agent without changing its enabled/paused state. */
export async function restartAgentK8s(agent: AgentInfo, timeoutMs = 120_000): Promise<void> {
  if (!isK8sAgent(agent)) {
    throw new Error(`Agent ${agent.username} is not k8s-native`);
  }

  const deployment = `deployment/agent-${agent.username}`;
  if (!(await getAgentK8sDeploymentStateAsync(agent))) {
    throw new Error(`k8s Deployment agent-${agent.username} does not exist`);
  }

  // Keep lifecycle ownership in the daemon/control plane. `rollout restart`
  // changes only this Deployment's pod-template restart annotation: it does not
  // toggle the agent, scale the fleet daemon, or touch sibling agents.
  // Async kubectl so a multi-minute rollout cannot freeze the daemon event loop
  // (PLS-505 revi P1) — including the existence preflight.
  const procTimeoutMs = Math.max(timeoutMs + 5_000, 65_000);
  await kubectlAsync(['rollout', 'restart', '-n', K8S_NS, deployment], undefined, procTimeoutMs);
  await kubectlAsync([
    'rollout', 'status', '-n', K8S_NS, deployment,
    `--timeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
  ], undefined, procTimeoutMs);
  console.log(`[daemon] ${agent.name}: restarted k3s-native Deployment agent-${agent.username}`);
}

/** Permanently remove every per-agent k3s object owned by the daemon. */
export function deleteAgentK8s(agent: AgentInfo): void {
  const username = agent.username;
  kubectl([
    'delete', '-n', K8S_NS,
    `deployment/agent-${username}`,
    `service/agent-${username}`,
    `persistentvolumeclaim/${username}-workspace`,
    `secret/${username}-agent-creds`,
    '--ignore-not-found=true',
    '--wait=true',
  ]);

  if (getAgentK8sDeploymentState(agent)) {
    throw new Error(`k8s Deployment agent-${username} still exists after permanent delete`);
  }
  console.log(`[daemon] ${agent.name}: deleted k3s-native workload and per-agent storage`);
}
