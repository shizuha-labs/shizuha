import type { AgentInfo } from './types.js';

export interface FleetAgentSsot {
  model?: string;
  executionMethod?: string;
  modelFallbacks?: Array<{ method: string; model: string }>;
  modelOverrides?: Record<string, string>;
  reasoningEffort?: string;
}

export interface RuntimeSsotRefreshResult {
  timedOut: boolean;
  refreshed: number;
  failedAgentIds: string[];
  driftedAgentIds: string[];
}

export type FleetAgentFetcher = (
  agentId: string,
  signal: AbortSignal,
) => Promise<FleetAgentSsot | null>;

/**
 * Copy Hive-owned runtime state from the daemon's canonical in-memory row onto
 * a freshly read local-store row.
 *
 * The local store is a durability fallback, not a second runtime authority.
 * Reconcile and pre-start both re-read it, so failing to restore this overlay
 * makes every pass rediscover the same Hive drift and can alternate pod
 * templates between stale and current capability/model state.
 */
export function applyRuntimeAuthorityOverlay(
  target: AgentInfo,
  source: Pick<AgentInfo,
    | 'model'
    | 'executionMethod'
    | 'modelFallbacks'
    | 'modelOverrides'
    | 'effectiveCapabilities'
    | 'skills'
    | 'eagerSkills'
    | 'mcpServers'
    | 'credentialGrantScopes'
    | 'credentialCustomGrantServices'
  >,
): void {
  target.model = source.model;
  target.executionMethod = source.executionMethod;
  target.modelFallbacks = source.modelFallbacks;
  target.modelOverrides = source.modelOverrides;
  if (source.effectiveCapabilities?.source === 'hive') {
    target.effectiveCapabilities = source.effectiveCapabilities;
    target.skills = source.skills;
    target.eagerSkills = source.eagerSkills;
    target.mcpServers = source.mcpServers;
    target.credentialGrantScopes = source.credentialGrantScopes;
    target.credentialCustomGrantServices = source.credentialCustomGrantServices;
  }
}

export function createSingleFlight<T>(
  work: () => Promise<T>,
  onOverlap?: () => void,
): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  let trailingRequested = false;

  const drain = async (): Promise<T> => {
    let result!: T;
    let firstFailure: unknown;
    let failed = false;
    do {
      trailingRequested = false;
      try {
        result = await work();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
        }
      }
    } while (trailingRequested);
    // A later successful trailing pass must not erase an earlier failure from
    // the shared single-flight batch. Drain every requested wake, then retain
    // the original fail-loud contract for every caller sharing this promise.
    if (failed) throw firstFailure;
    return result;
  };

  return () => {
    if (inFlight) {
      // A scheduler tick is edge-triggered state, not a duplicate read. Keep
      // exactly one trailing pass so a wake that arrives during long-running
      // work is observed after the current snapshot settles. Further overlap
      // still coalesces without allowing concurrent work.
      if (!trailingRequested) {
        trailingRequested = true;
        onOverlap?.();
      }
      return inFlight;
    }
    inFlight = drain().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * The daemon-link is the event-driven runtime-config path. The per-agent HTTP
 * refresh is only a missed-frame backstop, so bursty lifecycle/image events
 * must not turn it into a 42-request sweep per event.
 */
export function runtimeSsotBackstopDue(
  lastAttemptAtMs: number,
  nowMs = Date.now(),
  intervalMs = 60_000,
): boolean {
  return lastAttemptAtMs <= 0 || nowMs - lastAttemptAtMs >= Math.max(1_000, intervalMs);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Refresh the canonical desired objects before reconcile planning.
 *
 * The shared abort signal closes the mutation boundary: once the aggregate
 * deadline fires, late responses are discarded, every worker is awaited, and
 * only then may the caller hash/plan/render the desired graph.
 */
export async function refreshRuntimeSsot(
  desiredAgents: AgentInfo[],
  runtimeAgentById: Map<string, AgentInfo>,
  fetchFleetAgent: FleetAgentFetcher,
  options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<RuntimeSsotRefreshResult> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, desiredAgents.length || 1));
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('SSOT aggregate timeout')), timeoutMs);
  timer.unref?.();
  let cursor = 0;
  let refreshed = 0;
  const failedAgentIds: string[] = [];
  const driftedAgentIds: string[] = [];

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const desired = desiredAgents[cursor++];
      if (!desired) return;
      let fleetAgent: FleetAgentSsot | null;
      try {
        fleetAgent = await fetchFleetAgent(desired.id, controller.signal);
      } catch {
        failedAgentIds.push(desired.id);
        continue;
      }
      // A fetch may resolve concurrently with the deadline. Never mutate the
      // graph after cancellation, even if the transport returns a late value.
      if (controller.signal.aborted || !fleetAgent) continue;
      refreshed += 1;
      let drifted = false;
      if (fleetAgent.model && fleetAgent.model !== desired.model) {
        desired.model = fleetAgent.model;
        drifted = true;
      }
      if (fleetAgent.executionMethod && fleetAgent.executionMethod !== desired.executionMethod) {
        desired.executionMethod = fleetAgent.executionMethod;
        drifted = true;
      }
      if (fleetAgent.modelFallbacks && !sameJson(fleetAgent.modelFallbacks, desired.modelFallbacks)) {
        desired.modelFallbacks = fleetAgent.modelFallbacks;
        drifted = true;
      }
      if (fleetAgent.modelOverrides) {
        const canonicalOverrides = { ...fleetAgent.modelOverrides };
        const method = fleetAgent.executionMethod || desired.executionMethod || '';
        if (fleetAgent.reasoningEffort !== undefined && method) {
          const effortKey = `${method}_reasoning_effort`;
          const effort = fleetAgent.reasoningEffort.trim();
          if (effort) canonicalOverrides[effortKey] = effort;
          else delete canonicalOverrides[effortKey];
        } else if (fleetAgent.reasoningEffort === undefined) {
          // Rolling compatibility with a Hive runtime-lane endpoint that
          // predates its visible reasoning_effort field. Hidden model
          // overrides still come from Hive, but preserve the daemon's derived
          // effort companion until the upgraded endpoint can author it.
          for (const [key, value] of Object.entries(desired.modelOverrides ?? {})) {
            if (key.endsWith('_reasoning_effort')) canonicalOverrides[key] = value;
          }
        }
        if (!sameJson(canonicalOverrides, desired.modelOverrides)) {
          desired.modelOverrides = canonicalOverrides;
          drifted = true;
        }
      }
      const runtime = runtimeAgentById.get(desired.id);
      if (runtime) {
        runtime.model = desired.model;
        runtime.executionMethod = desired.executionMethod;
        runtime.modelFallbacks = desired.modelFallbacks;
        runtime.modelOverrides = desired.modelOverrides;
      }
      if (drifted) driftedAgentIds.push(desired.id);
    }
  };

  try {
    await Promise.allSettled(Array.from({ length: concurrency }, () => worker()));
  } finally {
    clearTimeout(timer);
  }
  return { timedOut: controller.signal.aborted, refreshed, failedAgentIds, driftedAgentIds };
}
