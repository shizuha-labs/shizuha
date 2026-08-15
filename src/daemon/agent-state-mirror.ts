/**
 * PLAT-1062 P4a — additive dual-write mirror into the AgentStateStore.
 *
 * The SQLite WAL store (P1) + merge-preserve export seam (P2, #245) + reconcile
 * engine (P3, #246) are all merged but had ZERO live call sites. This module is
 * the first live wiring: every mutation that goes through state.ts
 * `updateAgentConfig` is mirrored into the store, best-effort, AFTER the
 * agents.json write.
 *
 * Deliberately additive (zero behavior change):
 *  - agents.json stays the read/write source of truth for the daemon;
 *  - the store receives only the STORE-OWNED operational fields (never
 *    credentials[], keypair, or status — those remain JSON-owned per rei's
 *    B-path decision on the task);
 *  - any store failure is logged and swallowed — a broken/locked DB must never
 *    fail a live agent mutation.
 *
 * The follow-up cutover slice (P4a-2) flips reads to the store and derives
 * agents.json via exportMergedAgentsJson(); that PR carries the §10 Security
 * Review + architect gate. This one establishes the wiring and keeps the store
 * continuously current so the cutover has real data to verify against.
 */
import fs from 'fs';
import path from 'path';
import { AgentStateStore, UnknownAgentError, type CreateAgentSpec } from './agent-state-store.js';
import type { AgentInfo } from './types.js';

/** Fields the AgentStateStore is authoritative-in-waiting for (HLD §4). */
export const STORE_OWNED_FIELDS = [
  'username', 'email', 'name', 'role', 'team',
  'runtimeEnvironment', 'executionMethod',
  'model', 'modelFallbacks', 'modelOverrides',
  'skills', 'env', 'resourceLimits',
] as const;

let storeSingleton: AgentStateStore | null | undefined;
let storeSingletonPath: string | null = null;
let lastWarnAt = 0;

function storePath(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha', 'agent-state.db');
}

function warnThrottled(msg: string, err: unknown): void {
  // One warning per minute — a wedged DB must not spam the daemon log on
  // every config write.
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(`[agent-state-mirror] ${msg}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Open (or reuse) the daemon's store. Returns null when unavailable. */
export function getAgentStateStore(): AgentStateStore | null {
  const currentPath = storePath();
  if (storeSingleton !== undefined && (storeSingletonPath === currentPath || storeSingletonPath === '__test__')) {
    return storeSingleton;
  }
  if (storeSingleton && storeSingletonPath !== currentPath) {
    try { storeSingleton.close(); } catch { /* ignore stale test/process singleton close */ }
    storeSingleton = undefined;
    storeSingletonPath = null;
  }
  try {
    const dir = path.dirname(currentPath);
    fs.mkdirSync(dir, { recursive: true });
    storeSingleton = new AgentStateStore(currentPath);
    storeSingletonPath = currentPath;
  } catch (err) {
    warnThrottled('failed to open agent-state store', err);
    storeSingleton = null;
    storeSingletonPath = currentPath;
  }
  return storeSingleton;
}

/** Test seam: reset the singleton (and optionally inject a store). */
export function __setAgentStateStoreForTest(store: AgentStateStore | null | undefined): void {
  storeSingleton = store;
  storeSingletonPath = store === undefined ? null : '__test__';
}

export function agentInfoPatchToStorePatch(updates: Partial<AgentInfo>): Partial<CreateAgentSpec> {
  const patch: Partial<CreateAgentSpec> = {};
  for (const field of STORE_OWNED_FIELDS) {
    if (field in updates) {
      (patch as Record<string, unknown>)[field] = (updates as Record<string, unknown>)[field];
    }
  }
  return patch;
}

export interface AgentInfoToCreateSpecOptions {
  desiredEnabled?: boolean;
  operatorDisabled?: boolean;
}

export function agentInfoToCreateSpec(agent: AgentInfo, opts: AgentInfoToCreateSpecOptions = {}): CreateAgentSpec {
  const username = agent.username ?? agent.name ?? agent.id;
  return {
    id: agent.id,
    username,
    email: agent.email ?? '',
    name: agent.name ?? username,
    role: agent.role ?? null,
    team: agent.team ?? null,
    runtimeEnvironment: agent.runtimeEnvironment ?? 'container',
    executionMethod: agent.executionMethod ?? null,
    model: agent.model ?? null,
    modelFallbacks: agent.modelFallbacks,
    modelOverrides: agent.modelOverrides,
    skills: agent.skills ?? [],
    env: agent.env ?? null,
    resourceLimits: agent.resourceLimits,
    desiredEnabled: opts.desiredEnabled ?? agent.status !== 'disabled',
    operatorDisabled: opts.operatorDisabled ?? false,
  };
}

export function applyAgentPatchToStore(
  store: AgentStateStore,
  actor: string,
  agentId: string,
  updates: Partial<AgentInfo>,
  mergedRow: AgentInfo,
): boolean {
  const patch = agentInfoPatchToStorePatch(updates);
  if (Object.keys(patch).length === 0) return false;
  try {
    store.updateAgent(actor, agentId, patch);
  } catch (err) {
    if (!(err instanceof UnknownAgentError)) throw err;
    // Agent predates the store — adopt the full current row, which already
    // includes the patch (mergedRow is post-merge).
    store.createAgent(actor, agentInfoToCreateSpec(mergedRow));
  }
  return true;
}

/**
 * Mirror a config mutation into the store, best-effort. Called by
 * state.ts `updateAgentConfig` AFTER the agents.json write succeeds.
 *
 * `mergedRow` is the post-merge AgentInfo (used to seed the store row when the
 * agent predates the store — adopt-then-patch instead of failing).
 */
export function mirrorAgentPatch(actor: string, agentId: string, updates: Partial<AgentInfo>, mergedRow: AgentInfo): void {
  const patch = agentInfoPatchToStorePatch(updates);
  if (Object.keys(patch).length === 0) return; // status/credential-only update — JSON-owned
  const store = getAgentStateStore();
  if (!store) return;
  try {
    applyAgentPatchToStore(store, actor, agentId, updates, mergedRow);
  } catch (err) {
    warnThrottled(`failed to mirror patch for agent ${agentId}`, err);
  }
}
