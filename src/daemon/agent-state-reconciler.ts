/**
 * AgentStateReconciler — PLAT-1062 P3 (HLD PLAT-1061 / epic PLAT-706).
 *
 * Additive reconcile engine for the AgentStateStore desired-state DB. Runtime
 * adapters observe actual child/Docker/k8s state and, when enforcement is
 * enabled, converge actual state toward desired state. The daemon hot path wires
 * the concrete adapter in a later slice; this module keeps the policy and audit
 * rules testable now.
 */
import type { AgentObservation, AgentRow, AgentStateStore, CreateAgentSpec, RuntimeKind } from './agent-state-store.js';

export type AgentReconcileMode = 'observe' | 'dry-run' | 'enforce';
export type AgentReconcileAction = 'none' | 'start' | 'stop' | 'adopt';

export interface AgentRuntimeController {
  /** Return the current actual runtime state for a desired agent row. */
  observe(row: AgentRow): Promise<AgentObservation> | AgentObservation;
  /** List runtime objects that do not have a matching desired-state row. */
  listOrphans?(): Promise<AgentRuntimeOrphan[]> | AgentRuntimeOrphan[];
  /** Start/materialize a desired-enabled agent. Only called in enforce mode. */
  start?(row: AgentRow): Promise<AgentObservation | void> | AgentObservation | void;
  /** Stop a desired-disabled/operator-disabled running agent. Only called in enforce mode. */
  stop?(row: AgentRow, reason: string): Promise<AgentObservation | void> | AgentObservation | void;
  /** Stop an orphan runtime object with no desired-state row. Only called in enforce mode. */
  stopOrphan?(orphan: AgentRuntimeOrphan, reason: string): Promise<void> | void;
}

export type AgentRuntimeOrphanOwnership = 'owned_by_this_daemon' | 'owned_by_other_daemon' | 'unknown';

export interface AgentRuntimeOrphan {
  /** Stable runtime object id/name used for reporting and stopOrphan. */
  runtimeId: string;
  username?: string | null;
  observed_state: string;
  runtime_kind: RuntimeKind;
  container_or_pod?: string | null;
  pid?: number | null;
  ownership: AgentRuntimeOrphanOwnership;
  /**
   * Controller-provided adoption spec after validating daemon/Hive ownership
   * metadata. Absence means fail closed: report/stop the orphan, never invent a
   * desired row from a stale runtime object.
   */
  adoptionSpec?: CreateAgentSpec | null;
}

export interface AgentStateReconcilerOptions {
  mode?: AgentReconcileMode;
  actor?: string;
  /** Number of consecutive drift cycles before the report marks the agent alertable. */
  driftAlertCycles?: number;
  /** Optional hook for Prometheus/event bridges without coupling this module to a registry. */
  onDriftMetric?: (sample: AgentDriftMetricSample) => void;
}

export interface AgentDriftMetricSample {
  agentId: string;
  username: string;
  desiredState: 'running' | 'stopped';
  observedState: string;
  consecutiveCycles: number;
  alerting: boolean;
}

export interface AgentReconcileDecision {
  agentId: string;
  username: string;
  orphan?: boolean;
  desiredState: 'running' | 'stopped';
  observedState: string;
  action: AgentReconcileAction;
  reason: string | null;
  driftCycles: number;
  alerting: boolean;
  acted: boolean;
}

export interface AgentReconcileReport {
  mode: AgentReconcileMode;
  checked: number;
  drifted: number;
  actions: number;
  decisions: AgentReconcileDecision[];
  alerts: AgentReconcileDecision[];
}

const RUNNING_STATES = new Set(['running', 'starting', 'healthy', 'ready']);
const STOPPED_STATES = new Set(['stopped', 'disabled', 'exited', 'not_found', 'missing', 'none']);

function normalizeObservedState(state: string): string {
  return state.trim().toLowerCase().replace(/\s+/g, '_');
}

export function isRuntimeRunning(state: string): boolean {
  const normalized = normalizeObservedState(state);
  if (RUNNING_STATES.has(normalized)) return true;
  return false;
}

export function isRuntimePresent(state: string): boolean {
  const normalized = normalizeObservedState(state);
  if (STOPPED_STATES.has(normalized)) return false;
  // Unknown-but-present states (for example CrashLoopBackOff/Error) are not
  // healthy enough to satisfy desired=running, but they ARE actual runtime
  // objects that must be stopped when desired/operator-disabled says stopped.
  return true;
}

export class AgentStateReconciler {
  private readonly mode: AgentReconcileMode;
  private readonly actor: string;
  private readonly driftAlertCycles: number;
  private readonly onDriftMetric?: (sample: AgentDriftMetricSample) => void;
  private readonly driftCyclesByAgent = new Map<string, number>();

  constructor(
    private readonly store: AgentStateStore,
    private readonly controller: AgentRuntimeController,
    opts: AgentStateReconcilerOptions = {},
  ) {
    this.mode = opts.mode ?? 'observe';
    this.actor = opts.actor ?? 'agent-state-reconciler';
    this.driftAlertCycles = Math.max(1, opts.driftAlertCycles ?? 3);
    this.onDriftMetric = opts.onDriftMetric;
  }

  async reconcileOnce(): Promise<AgentReconcileReport> {
    const decisions: AgentReconcileDecision[] = [];

    for (const row of this.store.listAgents()) {
      const firstObservation = await this.controller.observe(row);
      this.store.recordObservation(row.id, firstObservation);

      const desiredState = row.desired_enabled === 1 && row.operator_disabled === 0 ? 'running' : 'stopped';
      const observedMatchesDesired = desiredState === 'running'
        ? isRuntimeRunning(firstObservation.observed_state)
        : !isRuntimePresent(firstObservation.observed_state);

      let action: AgentReconcileAction = 'none';
      let reason: string | null = null;
      let acted = false;

      if (!observedMatchesDesired) {
        if (desiredState === 'running') {
          action = 'start';
          reason = 'desired-enabled runtime missing/unhealthy';
        } else {
          action = 'stop';
          reason = row.operator_disabled === 1 ? 'operator-disabled fail-closed' : 'desired-disabled runtime still running';
        }

        const cycles = (this.driftCyclesByAgent.get(row.id) ?? 0) + 1;
        this.driftCyclesByAgent.set(row.id, cycles);
        const alerting = cycles >= this.driftAlertCycles;
        this.store.recordStateEvent(row.id, 'drift', this.actor, reason, {
          desiredState,
          observedState: firstObservation.observed_state,
          driftCycles: cycles,
          mode: this.mode,
          alerting,
        });

        if (this.mode === 'enforce') {
          const postActionObservation = await this.applyAction(row, action, reason);
          acted = true;
          if (postActionObservation) {
            this.store.recordObservation(row.id, postActionObservation);
          }
          this.store.recordStateEvent(row.id, action === 'start' ? 'started' : 'stopped', this.actor, reason, {
            desiredState,
            previousObservedState: firstObservation.observed_state,
            observedState: postActionObservation?.observed_state ?? null,
          });
        }

        const decision: AgentReconcileDecision = {
          agentId: row.id,
          username: row.username,
          desiredState,
          observedState: firstObservation.observed_state,
          action,
          reason,
          driftCycles: cycles,
          alerting,
          acted,
        };
        decisions.push(decision);
        this.onDriftMetric?.({
          agentId: row.id,
          username: row.username,
          desiredState,
          observedState: firstObservation.observed_state,
          consecutiveCycles: cycles,
          alerting,
        });
        continue;
      }

      this.driftCyclesByAgent.set(row.id, 0);
      this.store.recordStateEvent(row.id, 'reconciled', this.actor, null, {
        desiredState,
        observedState: firstObservation.observed_state,
        mode: this.mode,
      });
      decisions.push({
        agentId: row.id,
        username: row.username,
        desiredState,
        observedState: firstObservation.observed_state,
        action,
        reason,
        driftCycles: 0,
        alerting: false,
        acted,
      });
      this.onDriftMetric?.({
        agentId: row.id,
        username: row.username,
        desiredState,
        observedState: firstObservation.observed_state,
        consecutiveCycles: 0,
        alerting: false,
      });
    }

    const orphanDecisions = await this.reconcileOrphans();
    decisions.push(...orphanDecisions);

    const drifted = decisions.filter((d) => d.driftCycles > 0).length;
    const actions = decisions.filter((d) => d.acted).length;
    return {
      mode: this.mode,
      checked: decisions.length,
      drifted,
      actions,
      decisions,
      alerts: decisions.filter((d) => d.alerting),
    };
  }

  private async reconcileOrphans(): Promise<AgentReconcileDecision[]> {
    if (!this.controller.listOrphans) return [];

    const orphans = await this.controller.listOrphans();
    const decisions: AgentReconcileDecision[] = [];

    for (const orphan of orphans) {
      const adoptable = orphan.ownership === 'owned_by_this_daemon' && !!orphan.adoptionSpec;
      const action: AgentReconcileAction = adoptable ? 'adopt' : 'stop';
      const reason = adoptable
        ? 'orphan runtime has verified daemon ownership metadata; adopting into desired-state store'
        : orphan.ownership === 'owned_by_other_daemon'
          ? 'orphan runtime belongs to another daemon/control plane'
          : 'orphan runtime lacks verified ownership metadata';
      let acted = false;
      let agentId = orphan.runtimeId;
      let username = orphan.username ?? orphan.runtimeId;

      if (this.mode === 'enforce') {
        if (action === 'adopt') {
          const adopted = this.store.createAgent(this.actor, orphan.adoptionSpec!);
          agentId = adopted.id;
          username = adopted.username;
          this.store.recordObservation(adopted.id, {
            observed_state: orphan.observed_state,
            runtime_kind: orphan.runtime_kind,
            container_or_pod: orphan.container_or_pod ?? null,
            pid: orphan.pid ?? null,
          });
          acted = true;
        } else if (isRuntimePresent(orphan.observed_state)) {
          if (!this.controller.stopOrphan) throw new Error('AgentStateReconciler enforce mode requires controller.stopOrphan for orphan cleanup');
          await this.controller.stopOrphan(orphan, reason);
          acted = true;
        }
      }

      const decision: AgentReconcileDecision = {
        agentId,
        username,
        orphan: true,
        desiredState: adoptable ? (orphan.adoptionSpec!.desiredEnabled ? 'running' : 'stopped') : 'stopped',
        observedState: orphan.observed_state,
        action,
        reason,
        driftCycles: 1,
        alerting: false,
        acted,
      };
      decisions.push(decision);
      this.onDriftMetric?.({
        agentId,
        username,
        desiredState: decision.desiredState,
        observedState: orphan.observed_state,
        consecutiveCycles: 1,
        alerting: false,
      });
    }

    return decisions;
  }

  private async applyAction(row: AgentRow, action: AgentReconcileAction, reason: string): Promise<AgentObservation | void> {
    if (action === 'start') {
      if (!this.controller.start) throw new Error('AgentStateReconciler enforce mode requires controller.start');
      return await this.controller.start(row);
    }
    if (action === 'stop') {
      if (!this.controller.stop) throw new Error('AgentStateReconciler enforce mode requires controller.stop');
      return await this.controller.stop(row, reason);
    }
    return undefined;
  }
}
