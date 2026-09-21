import { describe, expect, it } from 'vitest';
import { computeRuntimeReconcilePlan } from '../../src/daemon/state.js';
import type { AgentInfo } from '../../src/daemon/types.js';

type Status = AgentInfo['status'];
function statuses(entries: Record<string, Status>): Map<string, Status> {
  return new Map(Object.entries(entries));
}

describe('PLAT-5560 disable/enable authority boundary (production-order regression)', () => {
  it('an enabled+active k8s Deployment stays out of toStop across a churn window AND after convergence (two production-order cycles)', () => {
    // Cycle 1: mid-rollout — Deployment exists but ready=0 (config-hash
    // Recreate flapping exactly like the pre-#111 Reika window).
    const churnPlan = computeRuntimeReconcilePlan(
      [{ agentId: 'reika', backend: 'k8s', replicas: 1, readyReplicas: 0, configHash: 'old' }],
      new Set(['reika']),
      statuses({ reika: 'active' }),
      new Set(['reika']),
      new Map([['reika', 'old']]),
    );
    expect(churnPlan.toStop).toEqual([]); // never scheduled for disableAndStopAgent
    expect(churnPlan.toStopLocal).toEqual([]);
    expect(churnPlan.toStopK8s).toEqual([]);
    expect(churnPlan.toStartK8s).toEqual([]); // PLAT-3982: no re-apply churn on a merely-unready Deployment
    expect(churnPlan.toRefreshK8s).toEqual([]); // unhealthy -> kubelet converges; no refresh re-apply

    // Cycle 2: converged — ready=1, available=1, hash matches desired.
    const convergedPlan = computeRuntimeReconcilePlan(
      [{ agentId: 'reika', backend: 'k8s', replicas: 1, readyReplicas: 1, configHash: 'old' }],
      new Set(['reika']),
      statuses({ reika: 'active' }),
      new Set(['reika']),
      new Map([['reika', 'old']]),
    );
    expect(convergedPlan).toEqual({
      toStop: [], toStopLocal: [], toStopK8s: [], unsupportedRollback: [], toRestoreK8s: [], toStartK8s: [], toRefreshK8s: [],
    });
  });

  it('only a two-source zombie-stop (not-enabled AND config status disabled) reaches the durable disable writer', () => {
    // One source alone must never disqualify an active seat: k8s backend running
    // and config still 'active', enabled-set gap on a busy fleet. The
    // empty-enabled-set guard / single-source disagreement must not stop it.
    const singleSource = computeRuntimeReconcilePlan(
      [
        { agentId: 'peer', backend: 'k8s', replicas: 1, readyReplicas: 1 },
        { agentId: 'reika', backend: 'k8s', replicas: 1, readyReplicas: 1 },
      ],
      new Set(['peer']), // enabled-set lost reika (e.g. daemon restart / JSON desync)
      statuses({ peer: 'active', reika: 'active' }), // …but config still says active
      new Set(['peer', 'reika']),
    );
    expect(singleSource.toStop).toEqual([]); // not a zombie-stop: config is active

    // Two-source agreement (the ONLY bucket that reaches disableAndStopAgent):
    // not in enabled-set AND config status 'disabled'.
    const twoSource = computeRuntimeReconcilePlan(
      [
        { agentId: 'peer', backend: 'k8s', replicas: 1, readyReplicas: 1 },
        { agentId: 'reika', backend: 'k8s', replicas: 1, readyReplicas: 1 },
      ],
      new Set(['peer']),
      statuses({ peer: 'active', reika: 'disabled' }),
      new Set(['peer', 'reika']),
    );
    expect(twoSource.toStop).toEqual(['reika']); // -> reconcile calls disableAndStopAgent(reika)
    expect(twoSource.toStopLocal).toEqual([]);
    expect(twoSource.toStopK8s).toEqual([]);
  });

  it('disableAndStopAgent is the reconcile stop-path author, and only the operator override revive clears the kill-switch', () => {
    // The durable disable write (desired_enabled=0 + operator_disabled=1
    // kill-switch) is reachable ONLY from the toStop bucket computed here.
    // A plain enable refuses (SCLI-110 one-way latch); only an explicit
    // operator Start with overrideKillSwitch revives. This pins the boundary
    // so a rollout/convergence flap can never plan an enabled+active seat
    // into the toStop bucket.
    const plan = computeRuntimeReconcilePlan(
      [
        { agentId: 'peer', backend: 'k8s', replicas: 1, readyReplicas: 1 },
        { agentId: 'reika', backend: 'k8s', replicas: 1, readyReplicas: 1 },
      ],
      new Set(['peer']),
      statuses({ peer: 'active', reika: 'disabled' }),
      new Set(['peer', 'reika']),
    );
    // Only the two-source-disabled seat is planned for stop; the healthy peer
    // is untouched. This is the sole path to disableAndStopAgent.
    expect(plan.toStop).toEqual(['reika']);
    expect(plan.toStopLocal).toEqual([]);
    expect(plan.toStopK8s).toEqual([]);
  });
});
