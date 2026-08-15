/**
 * Daemon state persistence — tracks running agent processes.
 * State stored at ~/.shizuha/daemon.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { DaemonState, DaemonAgentState } from './types.js';
import {
  agentInfoPatchToStorePatch,
  agentInfoToCreateSpec,
  applyAgentPatchToStore,
  getAgentStateStore,
  mirrorAgentPatch,
} from './agent-state-mirror.js';
import { cmdlineLooksLikeShizuhaDaemon } from '../shared/is-daemon-running.js';

export { cmdlineLooksLikeShizuhaDaemon };

function daemonStatePath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'daemon.json');
}

// SCLI-434: never open a FIFO/socket/dir/symlink as JSON — readFileSync on a
// FIFO blocks until a writer appears (wedged `down`/`status`). Classify with
// non-following lstat first; only a regular file is opened.
export type DaemonStateObjectKind =
  | 'missing'
  | 'regular'
  | 'fifo'
  | 'socket'
  | 'directory'
  | 'symlink'
  | 'device'
  | 'unreadable';

export function classifyStateObject(filePath: string): DaemonStateObjectKind {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (st.isFile()) return 'regular';
  if (st.isFIFO()) return 'fifo';
  if (st.isSocket()) return 'socket';
  if (st.isDirectory()) return 'directory';
  if (st.isSymbolicLink()) return 'symlink';
  return 'device';
}

function readJsonRegularFile<T>(filePath: string): T | null {
  if (classifyStateObject(filePath) !== 'regular') return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function readDaemonState(): DaemonState | null {
  return readJsonRegularFile<DaemonState>(daemonStatePath());
}

export function writeDaemonState(state: DaemonState): void {
  const dir = path.dirname(daemonStatePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = daemonStatePath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export function clearDaemonState(): void {
  try {
    fs.rmSync(daemonStatePath(), { force: true });
  } catch {
    // ignore
  }
}

export function updateAgentState(
  agentId: string,
  update: Partial<DaemonAgentState>,
): void {
  const state = readDaemonState();
  if (!state) return;

  const idx = state.agents.findIndex((a) => a.agentId === agentId);
  if (idx >= 0) {
    state.agents[idx] = { ...state.agents[idx]!, ...update };
  }
  writeDaemonState(state);
}

// ── Persisted enabled-agents state (survives daemon restarts) ──

function enabledAgentsPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'enabled-agents.json');
}

/** Read the set of agent IDs the user has enabled. */
export function readEnabledAgents(): Set<string> {
  const arr = readJsonRegularFile<string[]>(enabledAgentsPath());
  return new Set(Array.isArray(arr) ? arr : []);
}

/** Persist the set of enabled agent IDs. */
export function writeEnabledAgents(agentIds: Set<string>): void {
  const dir = path.dirname(enabledAgentsPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = enabledAgentsPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify([...agentIds], null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// ── Persisted EXPLICITLY-DISABLED state (SCLI-110) ──
// Authoritative kill-switch: agents the operator explicitly stopped. Honored
// across reconcile / restart / cliFilter and overrides enabled-agents.json, so a
// stopped agent STAYS stopped until explicitly re-enabled. Distinct from "absent
// from enabled-agents.json" (which any start path could silently re-add).

function disabledAgentsPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'disabled-agents.json');
}

/** Read the set of agent IDs the operator has explicitly disabled (stopped). */
export function readDisabledAgents(): Set<string> {
  const arr = readJsonRegularFile<string[]>(disabledAgentsPath());
  return new Set(Array.isArray(arr) ? arr : []);
}

/** Persist the explicitly-disabled set. */
export function writeDisabledAgents(agentIds: Set<string>): void {
  const dir = path.dirname(disabledAgentsPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = disabledAgentsPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify([...agentIds], null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export interface AgentDesiredRuntimeStateResult {
  ok: boolean;
  error?: string;
}

export interface AgentPersistenceResult {
  ok: boolean;
  error?: string;
}

/**
 * PLAT-1062 P4b: persist runtime enable/disable intent through the
 * AgentStateStore first, then mirror the legacy enabled/disabled JSON files.
 * MCP/CLI/dashboard toggles must not mutate runtime memory or compat files when
 * the authoritative SQLite store is unavailable or refuses the kill-switch.
 */
export function setAgentDesiredRuntimeState(
  agentId: string,
  enabled: boolean,
  opts: { actor?: string; overrideKillSwitch?: boolean } = {},
): AgentDesiredRuntimeStateResult {
  const actor = opts.actor ?? 'setAgentDesiredRuntimeState';
  const agents = readAgents();
  const agent = agents.find((a) => a.id === agentId || a.username === agentId);
  if (!agent) return { ok: false, error: 'Agent not found' };

  const store = getAgentStateStore();
  if (!store) return { ok: false, error: 'AgentStateStore unavailable' };

  try {
    ensureAgentStoreSeeded(agents);
    const current = store.getAgent(agent.id);
    if (!current) return { ok: false, error: 'AgentStateStore row missing after seed' };

    if (enabled) {
      if (current.operator_disabled === 1 && !opts.overrideKillSwitch) {
        return { ok: false, error: 'agent is operator-disabled (kill-switch active); not started' };
      }
      const row = store.setDesiredEnabled(actor, agent.id, true, { overrideKillSwitch: opts.overrideKillSwitch });
      if (row.operator_disabled === 1) {
        return { ok: false, error: 'agent is operator-disabled (kill-switch active); not started' };
      }
    } else {
      store.setDesiredEnabled(actor, agent.id, false);
      store.setOperatorDisabled(actor, agent.id, true, 'operator-kill-switch');
    }
  } catch (err) {
    warnAgentStateCutover(`runtime desired-state write failed for ${agent.id}; refusing compat file write`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const enabledIds = readEnabledAgents();
  const disabledIds = readDisabledAgents();
  if (enabled) {
    enabledIds.add(agent.id);
    disabledIds.delete(agent.id);
    disabledIds.delete(agent.username);
  } else {
    enabledIds.delete(agent.id);
    enabledIds.delete(agent.username);
    disabledIds.add(agent.id);
  }
  writeEnabledAgents(enabledIds);
  writeDisabledAgents(disabledIds);
  return { ok: true };
}

// ── Failover chains ──

function failoverChainsPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'failover-chains.json');
}

export function readFailoverChains(): import('./types.js').FailoverChain[] {
  const chains = readJsonRegularFile<import('./types.js').FailoverChain[]>(failoverChainsPath());
  return Array.isArray(chains) ? chains : [];
}

export function writeFailoverChains(chains: import('./types.js').FailoverChain[]): void {
  const dir = path.dirname(failoverChainsPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${failoverChainsPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(chains, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, failoverChainsPath());
}

export function getFailoverChain(id: string): import('./types.js').FailoverChain | null {
  return readFailoverChains().find(c => c.id === id) ?? null;
}

export function upsertFailoverChain(chain: import('./types.js').FailoverChain): void {
  const chains = readFailoverChains();
  const idx = chains.findIndex(c => c.id === chain.id);
  if (idx >= 0) chains[idx] = chain; else chains.push(chain);
  writeFailoverChains(chains);
}

export function deleteFailoverChain(id: string): boolean {
  const chains = readFailoverChains();
  const filtered = chains.filter(c => c.id !== id);
  if (filtered.length === chains.length) return false;
  writeFailoverChains(filtered);
  return true;
}

// ── Persisted agents — single source of truth for all agents on this machine ──

function agentsPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents.json');
}

/** Read all persisted agents. */
function readAgentsJson(): import('./types.js').AgentInfo[] {
  const agents = readJsonRegularFile<import('./types.js').AgentInfo[]>(agentsPath());
  return Array.isArray(agents) ? agents : [];
}

function writeAgentsJson(agents: import('./types.js').AgentInfo[]): void {
  const dir = path.dirname(agentsPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filePath = agentsPath();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(agents, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function warnAgentStateCutover(msg: string, err: unknown): void {
  console.warn(`[agent-state-cutover] ${msg}: ${err instanceof Error ? err.message : String(err)}`);
}

function ensureAgentStoreSeeded(existingAgents: import('./types.js').AgentInfo[]): void {
  const store = getAgentStateStore();
  if (!store || existingAgents.length === 0) return;
  const missing = existingAgents.some((agent) => !store.getAgent(agent.id));
  if (!missing) return;
  const normalizedAgents = existingAgents.map((agent) => {
    const username = agent.username ?? agent.name ?? agent.id;
    return {
      ...agent,
      username,
      email: agent.email ?? '',
      name: agent.name ?? username,
      role: agent.role ?? null,
      status: agent.status ?? 'disabled',
      mcpServers: agent.mcpServers ?? [],
      personalityTraits: agent.personalityTraits ?? {},
      skills: agent.skills ?? [],
    } as import('./types.js').AgentInfo;
  });
  // P4a-2 cutover bootstrap: import only missing agents and desired/operator
  // flags. Existing rows keep their store-owned config so P4a mirrors remain
  // authoritative; agents.json continues to preserve secrets/keypairs/status.
  store.importFromJson(normalizedAgents, readEnabledAgents(), readDisabledAgents(), 'readAgents-cutover');
}

function deriveAgentsFromStore(existingAgents: import('./types.js').AgentInfo[]): import('./types.js').AgentInfo[] {
  const store = getAgentStateStore();
  if (!store) return existingAgents;
  try {
    ensureAgentStoreSeeded(existingAgents);
    return store.exportMergedAgentsJson(existingAgents);
  } catch (err) {
    warnAgentStateCutover('falling back to agents.json after store read/export failed', err);
    return existingAgents;
  }
}

/** Read all persisted agents. P4a-2: store-owned fields come from AgentStateStore. */
export function readAgents(): import('./types.js').AgentInfo[] {
  return deriveAgentsFromStore(readAgentsJson());
}

/** Write the full agent list (atomic). P4a-2: agents.json is derived from the store. */
export function writeAgents(agents: import('./types.js').AgentInfo[]): void {
  writeAgentsJson(deriveAgentsFromStore(agents));
}

/**
 * Normalize local agent IDs (e.g. "local-claw-mmt756wx") to deterministic UUIDs.
 * Called at startup to ensure all agents have UUID-format IDs for platform compatibility.
 * Also updates the enabled-agents set to match.
 */
export function normalizeAgentIds(): { updated: number } {
  const agents = readAgents();
  const enabled = readEnabledAgents();
  let updated = 0;
  let prunedEnabled = 0;

  for (const agent of agents) {
    // Check if ID is not a valid UUID (36 chars with dashes)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent.id);
    if (!isUuid) {
      // Generate deterministic UUID from the local ID (same algorithm as platform sync)
      const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const newId = crypto.createHash('sha1')
        .update(Buffer.from(DNS_NAMESPACE.replace(/-/g, ''), 'hex'))
        .update(`shizuha-agent:${agent.id}`)
        .digest('hex');
      // Format as UUID v5 (set version=5 and variant=RFC4122)
      const uuid = [
        newId.slice(0, 8),
        newId.slice(8, 12),
        '5' + newId.slice(13, 16),  // version 5
        ((parseInt(newId.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + newId.slice(18, 20),
        newId.slice(20, 32),
      ].join('-');

      const oldId = agent.id;
      // Update enabled set
      if (enabled.has(oldId)) {
        enabled.delete(oldId);
        enabled.add(uuid);
      }
      agent.id = uuid;
      updated++;
      console.log(`[state] Normalized agent ID: ${oldId} → ${uuid} (${agent.username})`);
    }
  }

  const validIds = new Set(agents.map((agent) => agent.id));
  for (const id of [...enabled]) {
    if (!validIds.has(id)) {
      enabled.delete(id);
      prunedEnabled++;
      console.log(`[state] Pruned stale enabled agent ID: ${id}`);
    }
  }

  if (updated > 0) {
    writeAgents(agents);
  }
  if (updated > 0 || prunedEnabled > 0) {
    writeEnabledAgents(enabled);
  }
  return { updated };
}

/**
 * Add an agent and persist.
 *
 * PLAT-1062 P4c: create must commit to the AgentStateStore before agents.json
 * or live daemon memory can see the row. If the store is unavailable or refuses
 * the create, fail closed and leave JSON untouched.
 */
export function addAgent(
  agent: import('./types.js').AgentInfo,
  opts: { desiredEnabled?: boolean; operatorDisabled?: boolean } = {},
): AgentPersistenceResult {
  const agents = readAgents();
  const store = getAgentStateStore();
  if (!store) {
    return { ok: false, error: 'AgentStateStore unavailable' };
  }
  try {
    store.createAgent('addAgent', agentInfoToCreateSpec(agent, opts));
  } catch (err) {
    warnAgentStateCutover(`store create failed for ${agent.id}; refusing JSON create`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  agents.push(agent);
  writeAgents(agents);
  return { ok: true };
}

/** Remove an agent by ID and persist. Returns true if removed.
 *
 * PLAT-1062 P4c: delete must remove the authoritative store row before JSON,
 * enabled/disabled compat files, or live daemon memory are mutated.
 */
export function removeAgent(agentId: string): AgentPersistenceResult {
  const agents = readAgents();
  const filtered = agents.filter((a) => a.id !== agentId);
  if (filtered.length === agents.length) return { ok: false, error: 'Agent not found' };
  const store = getAgentStateStore();
  if (!store) {
    return { ok: false, error: 'AgentStateStore unavailable' };
  }
  try {
    store.deleteAgent('removeAgent', agentId);
  } catch (err) {
    warnAgentStateCutover(`store delete failed for ${agentId}; refusing JSON delete`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  writeAgents(filtered);
  return { ok: true };
}

/** Update an agent by ID and persist. Returns true if found. */
/**
 * HIVE-195: keep the runtime-launched model in sync with the configured model.
 *
 * The live runtime launches its primary model from the modelFallbacks entry for
 * the primary execution method (manager.ts resolveRuntimeChain →
 * resolveDeclaredPrimaryStep prefers that inline entry over modelOverrides). So a
 * config that sets modelOverrides[method]=opus but leaves the primary
 * modelFallbacks entry at sonnet silently launches sonnet — the "Hive says opus,
 * agent runs sonnet" drift. This re-asserts the configured override onto the
 * primary method's modelFallbacks step so that ANY caller (Hive PATCH, the
 * dropdown, the API, Connect-WS) is consistent and no caller can forget the
 * runtime field. Later modelFallbacks entries (real failover) are left untouched.
 *
 * Only the FIRST entry matching the primary method is synced — that is the entry
 * the runtime resolves as the declared primary step.
 */
function syncPrimaryModelFallback(
  agent: import('./types.js').AgentInfo,
): import('./types.js').AgentInfo {
  const method = agent.executionMethod ?? agent.modelFallbacks?.[0]?.method;
  if (!method) return agent;
  const desired = agent.modelOverrides?.[method];
  if (!desired) return agent;

  const fallbacks = agent.modelFallbacks ? agent.modelFallbacks.map((f) => ({ ...f })) : [];
  const primaryIdx = fallbacks.findIndex((f) => f.method === method);
  if (primaryIdx >= 0) {
    if (fallbacks[primaryIdx]!.model === desired) return agent; // already consistent
    fallbacks[primaryIdx] = { ...fallbacks[primaryIdx]!, model: desired };
  } else {
    // No inline entry for the primary method yet — prepend one so the runtime
    // launches the configured model (later entries remain as failover).
    fallbacks.unshift({ method, model: desired });
  }
  return { ...agent, modelFallbacks: fallbacks };
}

export function updateAgentConfig(agentId: string, updates: Partial<import('./types.js').AgentInfo>): boolean {
  const agents = readAgents();
  const idx = agents.findIndex((a) => a.id === agentId);
  if (idx < 0) return false;
  let merged = { ...agents[idx]!, ...updates };
  let storeUpdates = updates;
  // HIVE-195: when a model-config field is touched, keep the runtime-launched
  // model (the primary method's modelFallbacks entry) consistent with the
  // configured override. Gated so credential/status-only updates don't reshape
  // the failover chain.
  if (
    'model' in updates ||
    'modelOverrides' in updates ||
    'modelFallbacks' in updates ||
    'executionMethod' in updates
  ) {
    // An explicit empty chain is Hive's visible declaration that this agent has
    // no fallback policy. Preserve it exactly; rebuilding a one-step chain from
    // modelOverrides makes hidden runtime state disagree with Hive.
    const explicitlyNoFallbacks = 'modelFallbacks' in updates
      && Array.isArray(updates.modelFallbacks)
      && updates.modelFallbacks.length === 0;
    if (!explicitlyNoFallbacks) merged = syncPrimaryModelFallback(merged);
    storeUpdates = { ...updates, modelFallbacks: merged.modelFallbacks };
  }
  agents[idx] = merged;
  const storePatch = agentInfoPatchToStorePatch(storeUpdates);
  if (Object.keys(storePatch).length > 0) {
    const store = getAgentStateStore();
    if (!store) return false;
    try {
      applyAgentPatchToStore(store, 'updateAgentConfig', agentId, storeUpdates, merged);
    } catch (err) {
      warnAgentStateCutover(`store update failed for ${agentId}; refusing split-brain JSON write`, err);
      return false;
    }
  }
  writeAgents(agents);
  // JSON-owned-only updates (credentials/status/keypair) still bypass the store,
  // but keep the P4a mirror call as a no-op/filter guard so future store-owned
  // fields added to STORE_OWNED_FIELDS remain visible in tests.
  if (Object.keys(storePatch).length === 0) {
    mirrorAgentPatch('updateAgentConfig', agentId, storeUpdates, merged);
  }
  return true;
}

/**
 * @deprecated Sync is one-way (runtime → platform). Platform never pushes agents to runtime.
 * Kept for reference but no longer called.
 */
export function mergeRemoteAgents(_remoteAgents: import('./types.js').AgentInfo[]): {
  added: number;
  conflicts: Array<{ username: string; localId: string; remoteId: string }>;
} {
  // No-op: sync is one-way (runtime → platform only).
  // Platform is the aggregation layer across all runtimes.
  return { added: 0, conflicts: [] };
}



export interface ContainerReconcilePlan {
  toStop: string[];
  skipReason?: string;
}

/**
 * SCLI-149 safety planner for disabled runtime cleanup. Stop only when two
 * durable desired-state sources agree: the runtime id is absent from
 * enabled-agents.json AND agents.json status is disabled. Empty enabled-set is
 * treated as a likely read/bootstrap failure, and large stop waves trip a
 * circuit breaker instead of mass-killing the fleet.
 */
export function computeContainersToStop(
  runningIds: string[],
  enabledSet: Set<string>,
  statusById: Map<string, import('./types.js').AgentInfo['status']>,
): ContainerReconcilePlan {
  if (runningIds.length > 0 && enabledSet.size === 0) {
    return { toStop: [], skipReason: 'empty-enabled-set' };
  }

  const toStop = runningIds.filter(
    (id) => !enabledSet.has(id) && statusById.get(id) === 'disabled',
  );

  if (runningIds.length >= 4 && toStop.length / runningIds.length > 0.5) {
    return { toStop: [], skipReason: `circuit-breaker:${toStop.length}/${runningIds.length}` };
  }

  return { toStop };
}

export interface RuntimeActualState {
  agentId: string;
  backend: 'local' | 'k8s';
  /** Desired replicas observed from k8s Deployment spec. Local processes should use 1. */
  replicas?: number;
  /** Ready replicas observed from k8s Deployment status. */
  readyReplicas?: number;
  /** PLAT-3625: live MCP/capability config hash annotation (k8s backend only). */
  configHash?: string;
  /** True when live k8s credential objects/env drift from the roster credential source. */
  credentialDrift?: boolean;
}

export interface RuntimeReconcilePlan {
  /** Disabled-but-running runtime ids to stop, protected by SCLI-149 guards. */
  toStop: string[];
  /** Desired k8s-native agents currently running under the daemon-local backend. */
  toStopLocal: string[];
  /** Non-k8s/unsupported agents that still have a k8s Deployment running. */
  toStopK8s: string[];
  /** k8s->local rollbacks that cannot be auto-started by this reconcile pass. */
  unsupportedRollback: string[];
  /** Active k8s->local rollbacks whose only known backend was already scaled to zero. */
  toRestoreK8s: string[];
  /** Desired-enabled k8s-native agent ids that should be re-applied through spawnAgentK8s(). */
  toStartK8s: string[];
  /**
   * PLAT-3625: HEALTHY k8s agents whose live MCP/capability config-hash
   * annotation differs from the desired hash — re-apply so grants (e.g. a
   * newly enabled MCP service) propagate into pod env + `.mcp.json` without
   * manual patching. Deployments with NO live annotation are excluded
   * (avoids a fleet-wide restart storm on first rollout of the feature).
   */
  toRefreshK8s: string[];
  skipReason?: string;
}

/**
 * Compute daemon runtime reconcile actions across both daemon-local children and
 * k8s-native Deployments. Disabled stops deliberately reuse computeContainersToStop()
 * so SCLI-149's two-source agreement, empty-enabled-set guard, and mass-stop
 * circuit breaker apply to the COMBINED actual-state set, not just childProcesses.
 */
export function computeRuntimeReconcilePlan(
  actual: RuntimeActualState[],
  enabledSet: Set<string>,
  statusById: Map<string, import('./types.js').AgentInfo['status']>,
  k8sAgentIds: Set<string>,
  /** PLAT-3625: desired MCP/capability config hash per k8s agent id. */
  desiredConfigHashById?: Map<string, string>,
): RuntimeReconcilePlan {
  const runningIds = actual
    .filter((a) => (a.backend === 'local') || ((a.replicas ?? 0) > 0 || (a.readyReplicas ?? 0) > 0))
    .map((a) => a.agentId);
  const { toStop, skipReason } = computeContainersToStop(runningIds, enabledSet, statusById);
  if (skipReason) return { toStop: [], toStopLocal: [], toStopK8s: [], unsupportedRollback: [], toRestoreK8s: [], toStartK8s: [], toRefreshK8s: [], skipReason };

  const disabledStop = new Set(toStop);
  const localRunning = new Set(
    actual.filter((a) => a.backend === 'local').map((a) => a.agentId),
  );
  const k8sRunning = new Set(
    actual
      .filter((a) => a.backend === 'k8s' && ((a.replicas ?? 0) > 0 || (a.readyReplicas ?? 0) > 0))
      .map((a) => a.agentId),
  );
  const toStopLocal = [...localRunning].filter((id) => !disabledStop.has(id) && k8sAgentIds.has(id));
  const staleK8s = [...k8sRunning].filter((id) => !disabledStop.has(id) && !k8sAgentIds.has(id));
  const unsupportedRollback = staleK8s.filter(
    (id) => enabledSet.has(id) && statusById.get(id) === 'active' && !localRunning.has(id),
  );
  const toRestoreK8s = actual
    .filter((state) => state.backend === 'k8s'
      && (state.replicas ?? 0) === 0
      && (state.readyReplicas ?? 0) === 0
      && enabledSet.has(state.agentId)
      && statusById.get(state.agentId) === 'active'
      && !k8sAgentIds.has(state.agentId)
      && !localRunning.has(state.agentId))
    .map((state) => state.agentId);
  // Never turn a healthy active agent fully offline just to make placement
  // metadata converge. Keep its only live backend until a replacement local
  // runtime exists; disabled agents still flow through `toStop` and scale down.
  const unsupportedRollbackSet = new Set(unsupportedRollback);
  const toStopK8s = staleK8s.filter((id) => !unsupportedRollbackSet.has(id));

  const existingK8s = new Set(
    actual
      .filter((a) => a.backend === 'k8s' && ((a.replicas ?? 0) > 0 || (a.readyReplicas ?? 0) > 0))
      .map((a) => a.agentId),
  );
  const healthyK8s = new Set(
    actual
      .filter((a) => a.backend === 'k8s' && (a.replicas ?? 0) > 0 && (a.readyReplicas ?? 0) > 0 && !a.credentialDrift)
      .map((a) => a.agentId),
  );
  // PLAT-1254: an existing k8s Deployment observed with GitHub credential drift
  // (stale/unwired GITHUB_TOKEN Secret) cannot self-heal — kubelet only converges
  // replica health, never re-wires a Secret. It needs a spawnAgentK8s re-apply
  // (manager.ts consumes these from toStartK8s and re-renders the Secret). Track
  // them so the PLAT-3982 anti-churn guard below does not swallow the re-apply.
  const driftedK8s = new Set(
    actual
      .filter((a) => a.backend === 'k8s' && ((a.replicas ?? 0) > 0 || (a.readyReplicas ?? 0) > 0) && a.credentialDrift)
      .map((a) => a.agentId),
  );
  const toStartK8s = [...k8sAgentIds].filter(
    (id) => enabledSet.has(id)
      && statusById.get(id) === 'active'
      // PLAT-3982: an existing but temporarily unready Deployment is kubelet's
      // job to converge. Re-applying it every reconcile tick restarts the pod,
      // races Longhorn RWO attach, and can keep a single-agent Deployment
      // permanently unavailable. Only start/re-apply when the Deployment is
      // missing (or has no replicas observed), not merely unhealthy — EXCEPT for
      // credential drift, which kubelet cannot fix and which needs a re-apply.
      && (!existingK8s.has(id) || driftedK8s.has(id))
      // SCLI-235: a desired k8s runtime with a daemon-local child must converge
      // in two phases. Starting k8s while the local child is still observed can
      // leave a docker+k8s twin window; stop local first, then start k8s on a
      // later tick after the child exit has been observed.
      && !localRunning.has(id),
  );

  // PLAT-3625: healthy k8s agents whose live config-hash annotation differs
  // from the desired hash. Both hashes must be PRESENT — a missing live
  // annotation (legacy pre-feature Deployment) is not treated as drift so the
  // first rollout of hash stamping cannot bounce the whole fleet at once.
  const liveHashById = new Map(
    actual
      .filter((a) => a.backend === 'k8s' && a.configHash)
      .map((a) => [a.agentId, a.configHash as string]),
  );
  const toRefreshK8s = desiredConfigHashById
    ? [...k8sAgentIds].filter((id) => {
        if (!enabledSet.has(id) || statusById.get(id) !== 'active') return false;
        if (!healthyK8s.has(id) || localRunning.has(id)) return false; // unhealthy → kubelet/alerts converge; do not reapply every tick
        const desired = desiredConfigHashById.get(id);
        const live = liveHashById.get(id);
        return Boolean(desired && live && desired !== live);
      })
    : [];

  return { toStop, toStopLocal, toStopK8s, unsupportedRollback, toRestoreK8s, toStartK8s, toRefreshK8s };
}

/**
 * Check if the daemon process is actually alive (by PID).
 * Also validates the process is actually a shizuha daemon (not a PID-reused process).
 * Cleans up stale state automatically.
 */
export function isDaemonRunning(): boolean {
  // Check PID lock file first (authoritative)
  const lockPid = readPidLock();
  if (lockPid && isShizuhaDaemonProcess(lockPid)) return true;

  // Fallback to daemon.json state
  const state = readDaemonState();
  if (!state) return false;

  if (!isShizuhaDaemonProcess(state.pid)) {
    // Stale PID — process is dead or is a different process
    clearDaemonState();
    return false;
  }
  return true;
}

function isAncestorPid(pid: number): boolean {
  try {
    let current = process.pid;
    const seen = new Set<number>();
    while (current > 1 && !seen.has(current)) {
      seen.add(current);
      const stat = fs.readFileSync(`/proc/${current}/stat`, 'utf-8');
      const after = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const ppid = Number(after[1]);
      if (!Number.isInteger(ppid) || ppid <= 0) break;
      if (ppid === pid) return true;
      current = ppid;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Verify a PID belongs to a shizuha daemon process (not a reused PID).
 * Reads /proc/{pid}/cmdline on Linux to confirm it's `node ... shizuha.js up`.
 */
export function isShizuhaDaemonProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (pid === process.pid) return true;
  if (isAncestorPid(pid)) return false;

  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return cmdlineLooksLikeShizuhaDaemon(cmdline);
  } catch {
    // /proc not available (macOS, etc.) — fall back to PID-only check
    return true;
  }
}

// ── PID lock file (PostgreSQL/VNC-style) ──
//
// Prevents multiple daemon instances from running concurrently.
// The lock file at ~/.shizuha/daemon.pid contains the PID and is held
// open with an exclusive flock. Any new daemon startup will:
// 1. Check if the lock is held by a live process → kill it
// 2. Acquire the lock exclusively
// 3. Write its own PID
// On exit, the lock fd is released automatically by the OS.

let lockFd: number | null = null;

function pidLockPath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'daemon.pid');
}

/** Read the PID from the lock file (does NOT check if alive). */
export function readPidLock(): number | null {
  if (classifyStateObject(pidLockPath()) !== 'regular') return null;
  try {
    const content = fs.readFileSync(pidLockPath(), 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Acquire the daemon PID lock. Kills any existing daemon first.
 * Must be called once at daemon startup. The lock is held for the
 * lifetime of this process (OS releases flock on exit/crash).
 */
export function acquirePidLock(): void {
  const lockPath = pidLockPath();
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Check for existing daemon and kill it
  const existingPid = readPidLock();
  if (existingPid && existingPid > 1 && existingPid !== process.pid) {
    if (isShizuhaDaemonProcess(existingPid)) {
      console.log(`[daemon] Killing existing daemon (PID ${existingPid})...`);
      try {
        process.kill(existingPid, 'SIGTERM');
        // Wait briefly for it to exit
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try { process.kill(existingPid, 0); } catch { break; }
          const { execSync } = require('node:child_process');
          execSync('sleep 0.2', { stdio: 'ignore' });
        }
        // Force kill if still alive
        try {
          process.kill(existingPid, 0);
          console.log(`[daemon] Force-killing old daemon (PID ${existingPid})...`);
          process.kill(existingPid, 'SIGKILL');
        } catch { /* already dead */ }
      } catch { /* not running */ }
    }
  }

  // Also check daemon.json state for a different PID (e.g., installed vs dev binary)
  const state = readDaemonState();
  if (state && state.pid > 1 && state.pid !== process.pid && state.pid !== existingPid) {
    if (isShizuhaDaemonProcess(state.pid)) {
      console.log(`[daemon] Killing stale daemon from state (PID ${state.pid})...`);
      try { process.kill(state.pid, 'SIGTERM'); } catch { /* ignore */ }
      try {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { process.kill(state.pid, 0); } catch { break; }
          const { execSync } = require('node:child_process');
          execSync('sleep 0.2', { stdio: 'ignore' });
        }
        try { process.kill(state.pid, 'SIGKILL'); } catch { /* dead */ }
      } catch { /* dead */ }
    }
  }

  // Write our PID and hold the file open
  fs.writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o644 });
  lockFd = fs.openSync(lockPath, 'r');

  // Register cleanup on exit
  const cleanup = () => {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch { /* ignore */ }
      lockFd = null;
    }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });

  console.log(`[daemon] PID lock acquired (${lockPath}, PID ${process.pid})`);
}

/**
 * Release the PID lock (normally not needed — OS does it on exit).
 */
export function releasePidLock(): void {
  if (lockFd !== null) {
    try { fs.closeSync(lockFd); } catch { /* ignore */ }
    lockFd = null;
  }
  try { fs.rmSync(pidLockPath(), { force: true }); } catch { /* ignore */ }
}
