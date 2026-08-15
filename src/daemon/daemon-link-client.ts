/**
 * SCLI-199 / HIVE-235 DaemonLink client.
 *
 * The runtime daemon dials Hive's authenticated WebSocket, seeds Hive once from
 * the daemon's current desired state, then keeps Hive updated with deltas. Hive
 * can also send config frames back down; the daemon applies them through the
 * same local mutation gate used by the dashboard/API so AgentStateStore +
 * agents.json stay consistent.
 */
import * as crypto from 'node:crypto';
import * as os from 'node:os';
// @ts-ignore — ws has no declaration file in this repo (matches bridge modules).
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import type { AgentInfo, DaemonState } from './types.js';
import { harnessReport } from './harness-versions.js';
import { getHeartbeatQueueDrainOutcome } from './heartbeat-outcome.js';
import {
  readRuntimeLaneFences,
  runtimeLaneFenceStatePath,
  writeRuntimeLaneFences,
  type PersistedRuntimeLaneFence,
} from './runtime-lane-fence-state.js';

export type DaemonLinkApplyConfig = (
  agentId: string,
  updates: Record<string, unknown>,
  runtimeLane?: DaemonLinkRuntimeLaneContext,
) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;

export interface DaemonLinkRuntimeLaneContext {
  desiredGeneration: number;
  runtimeLaneDigest: string;
  runtimeLane: Record<string, unknown>;
}

export interface DaemonLinkRuntimeLaneHealth {
  apply_status: 'ok' | 'failed';
  workload_ready: boolean;
  container_ready: boolean;
  harness_ready: boolean;
  provider_health: {
    available: boolean;
    quota_ok: boolean;
    in_backoff: boolean;
  };
  error?: string;
}

export type DaemonLinkProbeRuntimeLaneHealth = (
  agentId: string,
  runtimeLane: DaemonLinkRuntimeLaneContext,
) => DaemonLinkRuntimeLaneHealth | Promise<DaemonLinkRuntimeLaneHealth>;

export type DaemonLinkDeleteAgent = (
  agentId: string,
) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;

export interface DaemonLinkClientOptions {
  platformUrl: string;
  url?: string;
  daemonId?: string;
  fleetId?: string;
  runtime?: string;
  token?: string;
  getAgents: () => AgentInfo[];
  getDaemonState?: () => DaemonState | null;
  /** Latest real turn/output activity observed by the daemon for an agent. */
  getLastActiveAt?: (agentId: string) => string | undefined;
  applyConfig?: DaemonLinkApplyConfig;
  /** Exact post-apply workload + harness/provider readiness for RuntimeLane. */
  probeRuntimeLaneHealth?: DaemonLinkProbeRuntimeLaneHealth;
  /** Apply Hive's durable desired-state tombstone to the local agent store. */
  deleteAgent?: DaemonLinkDeleteAgent;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Daemon→Hive heartbeat cadence. Hive marks DOWN after ~5 missed intervals. */
  heartbeatIntervalMs?: number;
  /** HIVE-600: harness/runtime image report, sent in the register frame. */
  getHarnessReport?: () => Record<string, unknown>;
  /** Durable highest-applied RuntimeLane fence. Null disables persistence in tests. */
  runtimeLaneFenceStatePath?: string | null;
}

type DaemonLinkFrame = Record<string, unknown> & { type?: string; seq?: number };
type SocketOwnershipGuard = () => boolean;

interface RuntimeLaneFence extends PersistedRuntimeLaneFence {
  generation: number;
  digest: string;
  changeId: string;
}

const ENV_DENYLIST = new Set([
  'AGENT_ID', 'AGENT_USERNAME', 'AGENT_NAME',
  'SHIZUHA_PLATFORM_URL', 'BACKEND_URL',
  'AGENT_PASSWORD', 'SHIZUHA_AGENT_TOKEN', 'VLLM_API_KEY',
  'VLLM_STREAM_WITH_TOOLS', 'MCP_AUTH_PROXY_SOCKET',
  'AGENT_ROLE', 'MODEL', 'REASONING_EFFORT', 'CONTEXT_PROMPT',
  'FAILOVER_CHAIN_ID', 'MODEL_FALLBACKS', 'MODEL_OVERRIDES', 'PERSONALITY_TRAITS',
]);

const SECRET_ENV_RE = /(?:TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API[_-]?KEY|ACCESS[_-]?KEY)/i;

const CONFIG_KEY_MAP: Record<string, string> = {
  executionMethod: 'execution_method',
  runtimeEnvironment: 'runtime_environment',
  resourceLimits: 'resource_limits',
  modelOverrides: 'model_overrides',
  modelFallbacks: 'model_fallbacks',
  personalityTraits: 'personality_traits',
  mcpServers: 'enabled_mcp_server_ids',
  enabledMcpServerIds: 'enabled_mcp_server_ids',
  contextPrompt: 'context_prompt',
  agentMemory: 'agent_memory',
  workSchedule: 'work_schedule',
  tokenBudget: 'token_budget',
  maxConcurrentTasks: 'max_concurrent_tasks',
  allowParallelExecution: 'allow_parallel_execution',
  warmPoolSize: 'warm_pool_size',
  failoverChainId: 'failover_chain_id',
  eagerSkills: 'eager_skills',
};

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
}

function sha256Hex(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function resolveDaemonLinkUrl(platformUrl: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const root = platformUrl.replace(/\/+$/, '')
    .replace(/\/(?:agent|id|admin|hive)\/api\/?$/, '')
    .replace(/\/hive\/?$/, '');
  const parsed = new URL(root || 'http://localhost');
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/v1/fleet/daemon-link';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function sanitizeEnv(env: Record<string, string> | undefined): { env: Record<string, string>; redacted: string[] } {
  const safe: Record<string, string> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!key || ENV_DENYLIST.has(key) || SECRET_ENV_RE.test(key)) {
      redacted.push(key);
      continue;
    }
    safe[key] = String(value);
  }
  return { env: safe, redacted: redacted.sort() };
}

function daemonStateForAgent(state: DaemonState | null | undefined, agentId: string) {
  return state?.agents.find((agent) => agent.agentId === agentId) ?? null;
}

function serializeAgentForDaemonLink(
  agent: AgentInfo,
  state: DaemonState | null | undefined,
  reason: string,
  lastActiveAt?: string,
): Record<string, unknown> {
  const runtimeState = daemonStateForAgent(state, agent.id);
  const enabled = runtimeState?.enabled ?? agent.status !== 'disabled';
  // PLAT-4172: surface the latest heartbeat-queue-drain outcome so a queue-blind
  // agent's needs_help escalation reaches Hive's Agents page (detection alone is
  // invisible to the operator — nova fired needs_help but /hive/agents showed 0).
  const heartbeatOutcome = getHeartbeatQueueDrainOutcome(agent.id);
  const needsHelp = heartbeatOutcome?.outcome === 'needs_help';
  const { env, redacted } = sanitizeEnv(agent.env);
  const config = {
    role: agent.role ?? '',
    execution_method: agent.executionMethod ?? '',
    runtime_environment: (
      (process.env['SHIZUHA_DAEMON_RUNTIME'] ?? '') === 'k8s'
      || (process.env['SHIZUHA_RUNTIME_BACKEND'] ?? '') === 'k8s'
    ) ? 'k8s' : (agent.runtimeEnvironment ?? ''),
    model: agent.model ?? '',
    model_fallbacks: agent.modelFallbacks ?? [],
    // Internal launch overrides are derived from Hive's visible model and
    // reasoning fields. Publishing them back would create a second, hidden
    // operator-facing configuration surface.
    model_overrides: {},
    reasoning_effort: agent.modelFallbacks?.[0]?.reasoningEffort
      ?? (agent.executionMethod ? agent.modelOverrides?.[`${agent.executionMethod}_reasoning_effort`] : '')
      ?? '',
    failover_chain_id: agent.failoverChainId ?? '',
    skills: agent.skills ?? [],
    eager_skills: agent.eagerSkills ?? [],
    enabled_mcp_server_ids: (agent.mcpServers ?? []).map((server) => server.slug || server.name).filter(Boolean),
    context_prompt: agent.contextPrompt ?? '',
    personality_traits: agent.personalityTraits ?? {},
    env,
    resource_limits: agent.resourceLimits ?? {},
    work_schedule: agent.workSchedule ?? {},
    token_budget: agent.tokenBudget ?? {},
    max_concurrent_tasks: agent.maxConcurrentTasks ?? null,
    allow_parallel_execution: agent.allowParallelExecution ?? false,
    warm_pool_size: agent.warmPoolSize ?? 0,
    tier: agent.tier ?? 'normal',
  };

  return {
    id: agent.id,
    agent_id: agent.id,
    child_id: agent.id,
    username: agent.username,
    agent_username: agent.username,
    email: agent.email,
    name: agent.name,
    display_name: agent.name,
    team: agent.team ?? '',
    status: runtimeState?.status ?? agent.status,
    status_message: runtimeState?.error ?? '',
    enabled,
    desired_enabled: enabled,
    runtime_state: runtimeState ? {
      status: runtimeState.status,
      enabled: runtimeState.enabled,
      pid: runtimeState.pid,
      container_id: runtimeState.containerId,
      container_name: runtimeState.containerName,
      error: runtimeState.error,
      started_at: runtimeState.startedAt,
      oauth_token_label: runtimeState.oauthTokenLabel,
    } : null,
    config,
    // PLAT-4172: heartbeat needs-help signal (queue-blind escalation) for Hive.
    needs_help: needsHelp,
    needs_help_reason: needsHelp ? (heartbeatOutcome?.reason ?? '') : '',
    heartbeat_outcome: heartbeatOutcome?.outcome ?? '',
    heartbeat_observed_at: heartbeatOutcome?.observedAt ?? '',
    // PLAT-4490: workload activity, not state-frame receipt time. Hive uses this
    // to keep a genuinely busy agent warm without letting periodic status/config
    // frames refresh the grace clock.
    last_active_at: lastActiveAt ?? null,
    env_redacted_keys: redacted,
    observed_config_hash: sha256Hex(config),
    observed_at: new Date().toISOString(),
    reason,
  };
}

function normalizeConfigUpdates(frame: DaemonLinkFrame): Record<string, unknown> {
  const raw = (
    frame.config
    ?? frame.updates
    ?? frame.desired_config
    ?? frame.data
    ?? {}
  ) as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    mapped[CONFIG_KEY_MAP[key] ?? key] = value;
  }
  delete mapped.id;
  delete mapped.agent_id;
  delete mapped.child_id;
  delete mapped.username;
  delete mapped.agent_username;
  // Hive fleet daemons (SHIZUHA_DAEMON_RUNTIME=k8s) only spawn k3s agent
  // Deployments. Coerce any bare_metal/host placement from legacy frames so
  // configure never re-opens dual-spawn on the daemon host.
  const fleetK8s =
    (process.env['SHIZUHA_DAEMON_RUNTIME'] ?? '') === 'k8s'
    || (process.env['SHIZUHA_RUNTIME_BACKEND'] ?? '') === 'k8s';
  if (fleetK8s) {
    mapped['runtime_environment'] = 'k8s';
  }
  return mapped;
}

function configFingerprintsForAppliedUpdates(
  frame: DaemonLinkFrame,
  updates: Record<string, unknown>,
): Record<string, string> {
  const raw = frame.config_fingerprints;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const fingerprints: Record<string, string> = {};
  for (const key of Object.keys(updates)) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) {
      fingerprints[key] = value.toLowerCase();
    }
  }
  return fingerprints;
}

function runtimeLaneFence(frame: DaemonLinkFrame): RuntimeLaneFence | null {
  const hasLane = frame.runtime_lane !== undefined
    || frame.runtime_lane_digest !== undefined
    || frame.desired_generation !== undefined;
  if (!hasLane) return null;
  const generation = Number(frame.desired_generation);
  const digest = String(frame.runtime_lane_digest ?? '').toLowerCase();
  const lane = frame.runtime_lane;
  if (!Number.isInteger(generation) || generation <= 0) {
    throw new Error('invalid_runtime_lane_generation');
  }
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) {
    throw new Error('missing_runtime_lane');
  }
  if (!/^[a-f0-9]{64}$/.test(digest) || sha256Hex(lane) !== digest) {
    throw new Error('runtime_lane_digest_mismatch');
  }
  return {
    generation,
    digest,
    changeId: String(frame.change_id ?? ''),
  };
}

export class DaemonLinkClient {
  private readonly options: Required<Pick<DaemonLinkClientOptions, 'reconnectBaseMs' | 'reconnectMaxMs' | 'heartbeatIntervalMs'>> & DaemonLinkClientOptions;
  private ws: WebSocket | null = null;
  /** Monotonic ownership fence for WebSocket callbacks. A superseded socket's
   * EventEmitter callbacks can arrive after its replacement is registered. */
  private socketGeneration = 0;
  private stopped = false;
  private connected = false;
  private seq = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private seedRequired = false;
  private lastStatus: 'disabled' | 'connecting' | 'connected' | 'degraded' | 'stopped' = 'stopped';
  private lastError = '';
  private lastConnectedAt = '';
  private lastFrameAt = '';
  /** Highest durably applied lane per agent. Health probes are fenced to it. */
  private readonly appliedRuntimeLanes: Map<string, RuntimeLaneFence>;

  constructor(options: DaemonLinkClientOptions) {
    this.options = {
      reconnectBaseMs: 5_000,
      reconnectMaxMs: 60_000,
      // Match hive/fleet/consumers.py _HEARTBEAT_INTERVAL_S=10 — must be daemon→Hive
      // frames (type=heartbeat). Acking Hive's heartbeats alone does not update
      // _last_daemon_hb, so without this loop the registry flips DOWN after ~50s.
      heartbeatIntervalMs: 10_000,
      ...options,
    };
    const fenceStatePath = options.runtimeLaneFenceStatePath === undefined
      ? runtimeLaneFenceStatePath()
      : options.runtimeLaneFenceStatePath;
    this.options.runtimeLaneFenceStatePath = fenceStatePath;
    this.appliedRuntimeLanes = readRuntimeLaneFences(fenceStatePath);
  }

  get isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  getStatus(): Record<string, unknown> {
    return {
      status: this.lastStatus,
      connected: this.isConnected,
      seedRequired: this.seedRequired,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      lastFrameAt: this.lastFrameAt,
    };
  }

  start(): boolean {
    if (this.stopped) this.stopped = false;
    if (!this.options.token?.trim()) {
      this.lastStatus = 'disabled';
      this.lastError = 'missing_daemon_link_token';
      logger.warn('DaemonLink disabled: SHIZUHA_DAEMON_LINK_TOKEN/FLEET_DAEMON_LINK_TOKEN is not configured');
      return false;
    }
    this.connect();
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.lastStatus = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeatLoop();
    const ws = this.ws;
    this.ws = null;
    this.socketGeneration += 1;
    this.closeSocketSafely(ws);
  }

  sendAgentDelta(agentId: string, reason = 'state_change'): boolean {
    const agent = this.options.getAgents().find((candidate) => candidate.id === agentId || candidate.username === agentId);
    if (!agent) return false;
    return this.sendJson({
      type: 'state_delta',
      seq: this.nextSeq(),
      child_id: agent.id,
      data: serializeAgentForDaemonLink(
        agent,
        this.options.getDaemonState?.(),
        reason,
        this.options.getLastActiveAt?.(agent.id),
      ),
    });
  }

  sendAgentDeleted(agentId: string, username?: string): boolean {
    return this.sendJson({
      type: 'state_delta',
      seq: this.nextSeq(),
      child_id: agentId,
      data: {
        id: agentId,
        agent_id: agentId,
        child_id: agentId,
        username,
        agent_username: username,
        deleted: true,
        enabled: false,
        desired_enabled: false,
        status: 'deleted',
        observed_at: new Date().toISOString(),
        reason: 'deleted',
      },
    });
  }

  sendSnapshot(reason = 'snapshot'): boolean {
    if (!this.isConnected) return false;
    const agents = this.options.getAgents();
    for (const agent of agents) {
      this.sendJson({
        type: 'state_snapshot',
        seq: this.nextSeq(),
        child_id: agent.id,
        data: serializeAgentForDaemonLink(
          agent,
          this.options.getDaemonState?.(),
          reason,
          this.options.getLastActiveAt?.(agent.id),
        ),
      });
    }
    return this.sendJson({
      type: 'state_snapshot_complete',
      seq: this.nextSeq(),
      child_count: agents.length,
    });
  }

  private connect(): void {
    if (this.stopped || !this.options.token?.trim()) return;
    const url = resolveDaemonLinkUrl(this.options.platformUrl, this.options.url);
    this.lastStatus = 'connecting';
    this.lastError = '';
    const previous = this.ws;
    const ws = new WebSocket(url);
    const generation = this.socketGeneration + 1;
    this.socketGeneration = generation;
    this.ws = ws;
    this.connected = false;
    this.stopHeartbeatLoop();
    this.closeSocketSafely(previous);

    ws.on('open', () => {
      if (!this.isCurrentSocket(ws, generation)) {
        this.closeSocketSafely(ws);
        return;
      }
      this.reconnectAttempts = 0;
      this.sendJson({
        type: 'register',
        seq: this.nextSeq(),
        daemon_id: this.options.daemonId || process.env.SHIZUHA_DAEMON_ID || os.hostname(),
        fleet_id: this.options.fleetId || process.env.SHIZUHA_FLEET_ID || `runtime-${process.pid}`,
        runtime: this.options.runtime || process.env.SHIZUHA_DAEMON_RUNTIME || 'docker',
        token: this.options.token,
        // PLAT-4235 P1: per-user fleet daemons. A per-user daemon declares the
        // Shizuha-ID user subject it serves (SHIZUHA_DAEMON_OWNER_SUBJECT); Hive
        // scopes agent binding to that owner (INV-OWNER-SCOPE). Omitted/blank on the
        // shared org/team daemon, which keeps managing owner-less org agents.
        owner_subject: process.env.SHIZUHA_DAEMON_OWNER_SUBJECT || undefined,
        owner_username: process.env.SHIZUHA_DAEMON_OWNER_USERNAME || undefined,
        // HIVE-600: report the agent-runtime image + daemon CLI hint so Hive can
        // track/upgrade fleet harness versions (versions resolved from image labels).
        harness_report: this.options.getHarnessReport?.() ?? undefined,
      });
    });

    ws.on('message', (raw: { toString(): string }) => {
      if (!this.isCurrentSocket(ws, generation)) return;
      let frame: DaemonLinkFrame;
      try {
        frame = JSON.parse(raw.toString()) as DaemonLinkFrame;
      } catch (err) {
        logger.warn({ err }, 'DaemonLink received non-JSON frame');
        return;
      }
      this.lastFrameAt = new Date().toISOString();
      const isCurrent = () => this.isCurrentSocket(ws, generation);
      void this.handleFrame(frame, isCurrent).catch((err) => {
        if (!this.isCurrentSocket(ws, generation)) return;
        this.lastStatus = 'degraded';
        this.lastError = (err as Error).message ?? String(err);
        logger.warn({ err, type: frame.type }, 'DaemonLink frame handling failed');
      });
    });

    ws.on('close', () => {
      if (!this.isCurrentSocket(ws, generation)) return;
      this.ws = null;
      this.connected = false;
      this.stopHeartbeatLoop();
      if (!this.stopped) {
        this.lastStatus = 'degraded';
        this.scheduleReconnect();
      }
    });
    ws.on('error', (err: { message?: string }) => {
      if (!this.isCurrentSocket(ws, generation)) return;
      this.lastStatus = 'degraded';
      this.lastError = err.message ?? String(err);
      logger.warn({ err: this.lastError }, 'DaemonLink WebSocket error');
    });
  }

  private isCurrentSocket(ws: WebSocket, generation: number): boolean {
    return !this.stopped && this.ws === ws && this.socketGeneration === generation;
  }

  private closeSocketSafely(ws: WebSocket | null): void {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
    try { ws.close(); } catch { /* stale/broken sockets are already unusable */ }
  }

  private startHeartbeatLoop(): void {
    this.stopHeartbeatLoop();
    const interval = Math.max(1_000, this.options.heartbeatIntervalMs);
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) return;
      this.sendJson({
        type: 'heartbeat',
        seq: this.nextSeq(),
        // The managed image changes after an idle-gated fleet roll without a
        // daemon reconnect. Carry the latest converged report on heartbeats so
        // Hive's Harness versions panel cannot remain pinned to startup state.
        harness_report: this.options.getHarnessReport?.() ?? undefined,
      });
    }, interval);
    this.heartbeatTimer.unref?.();
    // Immediate beat so Hive last_seen is fresh even if the next interval is delayed
    // by a busy event loop after a large config/snapshot batch.
    this.sendJson({
      type: 'heartbeat',
      seq: this.nextSeq(),
      harness_report: this.options.getHarnessReport?.() ?? undefined,
    });
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.options.reconnectBaseMs * (2 ** Math.max(0, this.reconnectAttempts - 1)),
      this.options.reconnectMaxMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async handleFrame(frame: DaemonLinkFrame, isCurrent: SocketOwnershipGuard): Promise<void> {
    if (!isCurrent()) return;
    switch (frame.type) {
      case 'register_ack':
        this.connected = true;
        this.lastStatus = 'connected';
        this.lastConnectedAt = new Date().toISOString();
        this.seedRequired = frame.seed_required === true;
        logger.info({ resumeFromSeq: frame.resume_from_seq, seedRequired: this.seedRequired }, 'DaemonLink registered with Hive');
        this.startHeartbeatLoop();
        if (this.seedRequired) {
          this.sendSnapshot('initial_seed');
        }
        break;
      case 'heartbeat':
        // Hive→daemon keepalive probe; ack it. Liveness for DaemonRegistry is driven by
        // the daemon→Hive heartbeat loop started on register_ack (HIVE-235).
        this.sendJson({ type: 'ack', seq: frame.seq ?? 0 });
        break;
      case 'request_snapshot':
        this.seedRequired = frame.seed_required === true;
        this.sendSnapshot(String(frame.reason || 'request_snapshot'));
        break;
      case 'config':
      case 'config_update':
      case 'apply_config':
      case 'agent_config':
        await this.handleConfigFrame(frame, isCurrent);
        break;
      case 'delete_agent':
      case 'agent_delete':
        await this.handleDeleteAgentFrame(frame, isCurrent);
        break;
      case 'close_reason':
        logger.warn({ code: frame.code, message: frame.message }, 'DaemonLink closed by Hive');
        break;
      default:
        logger.debug({ type: frame.type }, 'DaemonLink ignored unknown frame type');
        break;
    }
  }

  private async handleConfigFrame(frame: DaemonLinkFrame, isCurrent: SocketOwnershipGuard): Promise<void> {
    if (!isCurrent()) return;
    const agentId = String(frame.agent_id || frame.child_id || '');
    if (!agentId) {
      this.sendJson({
        type: 'config_result',
        seq: this.nextSeq(),
        ack_seq: frame.seq ?? 0,
        ok: false,
        error: 'agent_id/child_id is required',
      });
      return;
    }
    let laneFence: RuntimeLaneFence | null = null;
    try {
      laneFence = runtimeLaneFence(frame);
    } catch (err) {
      this.sendJson({
        type: 'config_result',
        seq: this.nextSeq(),
        ack_seq: frame.seq ?? 0,
        agent_id: agentId,
        ok: false,
        error: err instanceof Error ? err.message : 'invalid_runtime_lane_fence',
      });
      return;
    }
    const currentFence = this.appliedRuntimeLanes.get(agentId);
    if (laneFence && currentFence) {
      if (laneFence.generation < currentFence.generation
        || (laneFence.generation === currentFence.generation && laneFence.digest !== currentFence.digest)) {
        this.sendJson({
          type: 'config_result',
          seq: this.nextSeq(),
          ack_seq: frame.seq ?? 0,
          agent_id: agentId,
          desired_generation: laneFence.generation,
          runtime_lane_digest: laneFence.digest,
          ok: false,
          error: 'stale_or_conflicting_runtime_lane_generation',
        });
        return;
      }
    }
    const updates = normalizeConfigUpdates(frame);
    const configFingerprints = configFingerprintsForAppliedUpdates(frame, updates);
    const replay = Boolean(laneFence && currentFence
      && laneFence.generation === currentFence.generation
      && laneFence.digest === currentFence.digest);
    let result = replay
      ? { ok: true }
      : this.options.applyConfig
        ? await this.options.applyConfig(agentId, updates, laneFence && frame.runtime_lane
          ? {
            desiredGeneration: laneFence.generation,
            runtimeLaneDigest: laneFence.digest,
            runtimeLane: frame.runtime_lane as Record<string, unknown>,
          }
          : undefined)
        : { ok: false, error: 'daemon config apply callback is not configured' };
    // applyConfig is external and may resolve after this frame's socket was
    // superseded. Never let that stale continuation persist lane authority or
    // reply through the replacement connection.
    if (!isCurrent()) return;
    if (result.ok && laneFence && !replay) {
      const previousFence = this.appliedRuntimeLanes.get(agentId);
      this.appliedRuntimeLanes.set(agentId, laneFence);
      try {
        writeRuntimeLaneFences(this.options.runtimeLaneFenceStatePath ?? null, this.appliedRuntimeLanes);
      } catch (error) {
        if (previousFence) this.appliedRuntimeLanes.set(agentId, previousFence);
        else this.appliedRuntimeLanes.delete(agentId);
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.sendJson({
      type: 'config_result',
      seq: this.nextSeq(),
      ack_seq: frame.seq ?? 0,
      agent_id: agentId,
      ok: result.ok,
      error: result.error ?? '',
      ...(laneFence ? {
        change_id: laneFence.changeId,
        desired_generation: laneFence.generation,
        runtime_lane_digest: laneFence.digest,
      } : {}),
      // HIVE-597: acknowledge the exact Hive-authored values without echoing
      // any config or secret material. Hive supplied these opaque per-key
      // fingerprints and clears a key only if it still matches current desire.
      config_fingerprints: result.ok ? configFingerprints : {},
    });
    if (result.ok) {
      this.sendJson({ type: 'ack', seq: frame.seq ?? 0 });
      this.sendAgentDelta(agentId, 'config_applied');
      if (laneFence) {
        void this.emitRuntimeLaneHealth(
          agentId,
          laneFence,
          frame.runtime_lane as Record<string, unknown>,
          isCurrent,
        );
      }
    }
  }

  private async emitRuntimeLaneHealth(
    agentId: string,
    fence: RuntimeLaneFence,
    runtimeLane: Record<string, unknown>,
    isCurrent: SocketOwnershipGuard,
  ): Promise<void> {
    const probe = this.options.probeRuntimeLaneHealth;
    if (!probe) return;
    let health: DaemonLinkRuntimeLaneHealth;
    try {
      health = await probe(agentId, {
        desiredGeneration: fence.generation,
        runtimeLaneDigest: fence.digest,
        runtimeLane,
      });
    } catch (err) {
      health = {
        apply_status: 'failed',
        workload_ready: false,
        container_ready: false,
        harness_ready: false,
        provider_health: { available: false, quota_ok: false, in_backoff: false },
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!isCurrent()) return;
    const current = this.appliedRuntimeLanes.get(agentId);
    if (!current || current.generation !== fence.generation || current.digest !== fence.digest) return;
    this.sendJson({
      type: 'health_snapshot',
      seq: this.nextSeq(),
      snapshot_type: 'delta',
      agent_id: agentId,
      child_id: agentId,
      observed_generation: fence.generation,
      runtime_lane_digest: fence.digest,
      apply_status: health.apply_status,
      workload_ready: health.workload_ready,
      container_ready: health.container_ready,
      harness_ready: health.harness_ready,
      provider_health: health.provider_health,
      last_apply_error: health.error ?? '',
    });
  }

  private async handleDeleteAgentFrame(frame: DaemonLinkFrame, isCurrent: SocketOwnershipGuard): Promise<void> {
    if (!isCurrent()) return;
    const agentId = String(frame.agent_id || frame.child_id || '');
    if (!agentId) {
      this.sendJson({
        type: 'delete_result',
        seq: this.nextSeq(),
        ack_seq: frame.seq ?? 0,
        ok: false,
        error: 'agent_id/child_id is required',
      });
      return;
    }
    const result = this.options.deleteAgent
      ? await this.options.deleteAgent(agentId)
      : { ok: false, error: 'daemon delete callback is not configured' };
    // deleteAgent may complete after a reconnect; a stale A continuation must
    // not acknowledge or publish results over authoritative socket B.
    if (!isCurrent()) return;
    this.sendJson({
      type: 'delete_result',
      seq: this.nextSeq(),
      ack_seq: frame.seq ?? 0,
      agent_id: agentId,
      ok: result.ok,
      error: result.error ?? '',
    });
    if (result.ok) {
      this.sendJson({ type: 'ack', seq: frame.seq ?? 0 });
    }
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private sendJson(frame: DaemonLinkFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }
}

export function buildDaemonLinkClientFromEnv(
  platformUrl: string,
  getAgents: () => AgentInfo[],
  getDaemonState: () => DaemonState | null,
  applyConfig: DaemonLinkApplyConfig,
  deleteAgent: DaemonLinkDeleteAgent,
  getLastActiveAt?: (agentId: string) => string | undefined,
  probeRuntimeLaneHealth?: DaemonLinkProbeRuntimeLaneHealth,
): DaemonLinkClient {
  return new DaemonLinkClient({
    platformUrl,
    url: process.env.SHIZUHA_DAEMON_LINK_URL || process.env.FLEET_DAEMON_LINK_URL,
    daemonId: process.env.SHIZUHA_DAEMON_ID || process.env.FLEET_DAEMON_ID || os.hostname(),
    fleetId: process.env.SHIZUHA_FLEET_ID || process.env.FLEET_ID || `runtime-${process.pid}`,
    runtime: process.env.SHIZUHA_DAEMON_RUNTIME || process.env.FLEET_DAEMON_RUNTIME || 'docker',
    token: process.env.SHIZUHA_DAEMON_LINK_TOKEN || process.env.FLEET_DAEMON_LINK_TOKEN,
    getAgents,
    getDaemonState,
    getLastActiveAt,
    applyConfig,
    deleteAgent,
    probeRuntimeLaneHealth,
    getHarnessReport: () => harnessReport() as unknown as Record<string, unknown>,
  });
}
