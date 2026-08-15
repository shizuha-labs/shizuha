import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeRuntimeReconcilePlan } from '../../src/daemon/state.js';
import { computeAgentMcpConfigHash, renderAgentManifest } from '../../src/daemon/k8s-backend.js';
import {
  applyRuntimeAuthorityOverlay,
  createSingleFlight,
  refreshRuntimeSsot,
  runtimeSsotBackstopDue,
} from '../../src/daemon/runtime-ssot-refresh.js';
import type { AgentInfo } from '../../src/daemon/types.js';

type Status = AgentInfo['status'];
function statuses(entries: Record<string, Status>): Map<string, Status> {
  return new Map(Object.entries(entries));
}

describe('daemon runtime reconcile desired-state refresh', () => {
  it('re-reads readAgents inside reconcileRuntimeLifecycle before planning desired runtime backend', () => {
    const managerSource = fs.readFileSync(path.resolve('src/daemon/manager.ts'), 'utf-8');
    const reconcileBody = managerSource.slice(
      managerSource.indexOf('function reconcileRuntimeLifecycle()'),
      managerSource.indexOf('/**\n * Enable and start a single agent'),
    );

    expect(reconcileBody).toContain('const desiredAgents = readAgents()');
    expect(reconcileBody).toContain('{ includeNonK8sDesired: true }');
    expect(reconcileBody).toContain('const k8sDeploymentStates = observedK8sDeploymentStates.filter(');
    expect(reconcileBody).toContain('const k8sActual = observedK8sDeploymentStates.map(');
    expect(reconcileBody).toContain('new Map(desiredAgents.map((a) => [a.id, a.status]))');
    expect(reconcileBody).toContain('desiredAgents.filter((a) => shouldSpawnK8sAgent(a))');
    expect(reconcileBody).toContain('await refreshRuntimeSsot(');
    expect(reconcileBody).toContain('runtimeSsotBackstopDue(');
    expect(reconcileBody).toContain('applyRuntimeAuthorityOverlay(desired, runtime)');
    expect(reconcileBody).toContain('{ concurrency: 4, timeoutMs: 10_000 }');
    expect(reconcileBody).toContain('childProcesses.get(id) === child');
    expect(reconcileBody).not.toContain('childProcesses.delete(id);');
  });

  it('settles runtime-release authority before admitting the blocking GitHub diagnostic', () => {
    const managerSource = fs.readFileSync(path.resolve('src/daemon/manager.ts'), 'utf-8');
    const reconcileBody = managerSource.slice(
      managerSource.indexOf('async function reconcileRuntimeLifecycle()'),
      managerSource.indexOf('/**\n * Enable and start a single agent'),
    );
    const releaseReconcile = reconcileBody.indexOf(
      'await reconcileHarnessImageRoll(desiredAgents, k8sDeploymentStates, enabledSet)',
    );
    const deferralDecision = reconcileBody.indexOf(
      'const deferGithubProbe = shouldDeferK8sGithubProbeForHarnessRoll(',
    );
    const githubDiagnostic = reconcileBody.indexOf(
      'maybeProbeK8sGithubAuth(desiredAgents, k8sDeploymentStates, enabledSet)',
    );

    expect(releaseReconcile).toBeGreaterThan(-1);
    expect(deferralDecision).toBeGreaterThan(releaseReconcile);
    expect(githubDiagnostic).toBeGreaterThan(deferralDecision);
    expect(reconcileBody).not.toContain(
      'void reconcileHarnessImageRoll(desiredAgents, k8sDeploymentStates, enabledSet)',
    );
  });

  it('applies a method-only SSOT change to the canonical graph and schedules exactly one reapply', async () => {
    const desired: AgentInfo = {
      id: 'agent-hiro-id', name: 'hiro', username: 'hiro', email: 'hiro@shizuha.com',
      role: 'agent', status: 'active', runtimeEnvironment: 'k8s', mcpServers: [],
      personalityTraits: {}, skills: [], model: 'same-model', executionMethod: 'shizuha',
      modelFallbacks: [{ method: 'shizuha', model: 'same-model' }],
    };
    const oldHash = computeAgentMcpConfigHash(desired);
    const result = await refreshRuntimeSsot(
      [desired],
      new Map(),
      async () => ({
        model: 'same-model',
        executionMethod: 'claude_code_server',
        modelFallbacks: [{ method: 'claude_code_server', model: 'same-model' }],
      }),
    );
    const newHash = computeAgentMcpConfigHash(desired);
    const manifest = renderAgentManifest(desired, {
      command: 'claude-bridge', model: 'same-model', contextPrompt: 'ctx', password: 'pw',
    });

    expect(result.driftedAgentIds).toEqual(['agent-hiro-id']);
    expect(newHash).not.toBe(oldHash);
    expect(manifest).toContain('name: SHIZUHA_K8S_PRIMARY_METHOD, value: "claude_code_server"');
    expect(computeRuntimeReconcilePlan(
      [{ agentId: desired.id, backend: 'k8s', replicas: 1, readyReplicas: 1, configHash: oldHash }],
      new Set([desired.id]), statuses({ [desired.id]: 'active' }), new Set([desired.id]),
      new Map([[desired.id, newHash]]),
    ).toRefreshK8s).toEqual([desired.id]);
    expect(computeRuntimeReconcilePlan(
      [{ agentId: desired.id, backend: 'k8s', replicas: 1, readyReplicas: 1, configHash: newHash }],
      new Set([desired.id]), statuses({ [desired.id]: 'active' }), new Set([desired.id]),
      new Map([[desired.id, newHash]]),
    ).toRefreshK8s).toEqual([]);
  });

  it('preserves the canonical Hive overlay across local-store re-reads', async () => {
    const stale: AgentInfo = {
      id: 'agent-zen-id', name: 'Zen', username: 'zen', email: 'zen@shizuha.com',
      role: 'QA Engineer', status: 'active', runtimeEnvironment: 'k8s',
      mcpServers: [{ name: 'pulse', slug: 'pulse' } as never],
      personalityTraits: {}, skills: ['old-skill'], model: 'old-model',
      executionMethod: 'shizuha',
      modelFallbacks: [{ method: 'shizuha', model: 'old-model' }],
    };
    const runtime: AgentInfo = {
      ...structuredClone(stale),
      model: 'gpt-5.6-sol',
      executionMethod: 'codex_app_server',
      modelFallbacks: [{ method: 'codex_app_server', model: 'gpt-5.6-sol' }],
      modelOverrides: {},
      skills: ['qa-verification'],
      mcpServers: [{ name: 'pulse', slug: 'pulse' } as never, { name: 'wiki', slug: 'wiki' } as never],
      effectiveCapabilities: {
        source: 'hive', capabilities: ['qa'], skills: ['qa-verification'],
        eagerSkills: [], mcpServers: ['pulse', 'wiki'], sourceTeams: ['qa'],
        credentialGrantScopes: [], credentialCustomGrantServices: [],
        runtimeFlags: {}, diagnostics: [], catalogVersion: 10,
        appliedAt: '2026-07-28T22:00:00.000Z',
      },
    };

    applyRuntimeAuthorityOverlay(stale, runtime);
    const result = await refreshRuntimeSsot(
      [stale],
      new Map([[runtime.id, runtime]]),
      async () => ({
        model: 'gpt-5.6-sol',
        executionMethod: 'codex_app_server',
        modelFallbacks: [{ method: 'codex_app_server', model: 'gpt-5.6-sol' }],
        modelOverrides: {},
      }),
    );

    expect(result.driftedAgentIds).toEqual([]);
    expect(stale.effectiveCapabilities?.catalogVersion).toBe(10);
    expect(stale.skills).toEqual(['qa-verification']);
    expect(stale.mcpServers.map((server) => server.slug)).toEqual(['pulse', 'wiki']);
  });

  it('maps visible Hive reasoning effort into the daemon launch override without false drift', async () => {
    const desired: AgentInfo = {
      id: 'agent-reasoning-id', name: 'reasoning', username: 'reasoning',
      email: 'reasoning@shizuha.com', role: 'agent', status: 'active',
      runtimeEnvironment: 'k8s', mcpServers: [], personalityTraits: {}, skills: [],
      model: 'gpt-5.6-sol', executionMethod: 'codex_app_server',
      modelFallbacks: [],
      modelOverrides: { codex_app_server_reasoning_effort: 'high' },
    };

    const result = await refreshRuntimeSsot(
      [desired],
      new Map([[desired.id, desired]]),
      async () => ({
        model: 'gpt-5.6-sol',
        executionMethod: 'codex_app_server',
        modelFallbacks: [],
        modelOverrides: {},
        reasoningEffort: 'high',
      }),
    );

    expect(result.driftedAgentIds).toEqual([]);
    expect(desired.modelOverrides).toEqual({
      codex_app_server_reasoning_effort: 'high',
    });
  });

  it('preserves derived reasoning effort against a pre-upgrade Hive endpoint', async () => {
    const desired: AgentInfo = {
      id: 'agent-legacy-reasoning-id', name: 'legacy', username: 'legacy',
      email: 'legacy@shizuha.com', role: 'agent', status: 'active',
      runtimeEnvironment: 'k8s', mcpServers: [], personalityTraits: {}, skills: [],
      model: 'gpt-5.6-sol', executionMethod: 'codex_app_server',
      modelFallbacks: [],
      modelOverrides: {
        codex_app_server: 'gpt-5.6-sol',
        codex_app_server_reasoning_effort: 'high',
      },
    };

    const result = await refreshRuntimeSsot(
      [desired],
      new Map([[desired.id, desired]]),
      async () => ({
        model: 'gpt-5.6-sol',
        executionMethod: 'codex_app_server',
        modelFallbacks: [],
        modelOverrides: {},
      }),
    );

    expect(result.driftedAgentIds).toEqual(['agent-legacy-reasoning-id']);
    expect(desired.modelOverrides).toEqual({
      codex_app_server_reasoning_effort: 'high',
    });
  });

  it('captures the live runtime overlay before pre-start local rehydrate', () => {
    const managerSource = fs.readFileSync(path.resolve('src/daemon/manager.ts'), 'utf-8');
    const preStart = managerSource.slice(
      managerSource.indexOf('// Pre-start config rehydrate'),
      managerSource.indexOf('// Re-apply the Hive effective-capabilities overlay'),
    );
    expect(preStart.indexOf('const runtimeAuthority = roster ?')).toBeGreaterThan(-1);
    expect(preStart.indexOf('const runtimeAuthority = roster ?'))
      .toBeLessThan(preStart.indexOf('Object.assign(agent, persisted)'));
    expect(preStart).toContain('applyRuntimeAuthorityOverlay(agent, runtimeAuthority)');
    expect(preStart).toContain('applyRuntimeAuthorityOverlay(roster, runtimeAuthority)');
  });

  it('cancels and settles timed-out SSOT workers without allowing late graph mutation', async () => {
    const desired: AgentInfo = {
      id: 'agent-slow-id', name: 'slow', username: 'slow', email: 'slow@shizuha.com',
      role: 'agent', status: 'active', runtimeEnvironment: 'k8s', mcpServers: [],
      personalityTraits: {}, skills: [], model: 'cached', executionMethod: 'shizuha',
    };
    let activeFetches = 0;
    const result = await refreshRuntimeSsot(
      [desired], new Map(),
      async (_id, signal) => {
        activeFetches += 1;
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1_000);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason);
            }, { once: true });
          });
          return { model: 'late-value' };
        } finally {
          activeFetches -= 1;
        }
      },
      { concurrency: 1, timeoutMs: 20 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.failedAgentIds).toEqual(['agent-slow-id']);
    expect(activeFetches).toBe(0);
    expect(desired.model).toBe('cached');
    expect(result.driftedAgentIds).toEqual([]);
  });

  it('reports fleet-wide fetch failures instead of silently treating stale state as healthy', async () => {
    const desired = ['one', 'two'].map((id): AgentInfo => ({
      id, name: id, username: id, email: `${id}@shizuha.com`, role: 'agent',
      status: 'active', runtimeEnvironment: 'k8s', mcpServers: [],
      personalityTraits: {}, skills: [], model: 'cached', executionMethod: 'shizuha',
    }));

    const result = await refreshRuntimeSsot(
      desired,
      new Map(),
      async () => { throw new Error('Hive 403'); },
    );

    expect(result.refreshed).toBe(0);
    expect(result.failedAgentIds.sort()).toEqual(['one', 'two']);
    expect(desired.map((agent) => agent.model)).toEqual(['cached', 'cached']);
  });

  it('coalesces overlapping reconcile ticks without concurrent work', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const schedule = createSingleFlight(async () => {
      calls += 1;
      await gate;
    });

    const first = schedule();
    const second = schedule();
    expect(first).toBe(second);
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
  });

  it('runs one trailing lifecycle reconcile when a harness-roll recheck overlaps the active pass', async () => {
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstPassGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const schedule = createSingleFlight(async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) await firstPassGate;
      active -= 1;
    });

    // Production order: the lifecycle pass is still running when
    // scheduleHarnessRollWake fires its busy drain-v1 recheck. More event ticks
    // in the same window must coalesce, but the recheck itself must survive so
    // the next pass can re-arm the bridge's bounded drain lease.
    const initialPass = schedule();
    const busyRecheck = schedule();
    const eventBurst = schedule();
    expect(initialPass).toBe(busyRecheck);
    expect(initialPass).toBe(eventBurst);
    expect(calls).toBe(1);

    releaseFirst();
    await initialPass;

    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
  });

  it('retains the first lifecycle failure after an overlapping trailing pass succeeds', async () => {
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstPassGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const originalFailure = new Error('first lifecycle reconcile failed');
    const schedule = createSingleFlight(async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (calls === 1) {
          await firstPassGate;
          throw originalFailure;
        }
      } finally {
        active -= 1;
      }
    });

    // Production order: the active lifecycle pass receives a busy recheck,
    // fails, and the requested trailing pass still runs successfully. Every
    // overlapping caller shares one promise and must observe the first error.
    const initialPass = schedule();
    const busyRecheck = schedule();
    expect(initialPass).toBe(busyRecheck);
    expect(calls).toBe(1);

    releaseFirst();
    await expect(initialPass).rejects.toBe(originalFailure);

    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
  });

  it('schedules an immediate lifecycle reconcile before the 60-second heartbeat', () => {
    const managerSource = fs.readFileSync(path.resolve('src/daemon/manager.ts'), 'utf-8');
    const runningMarker = managerSource.indexOf("console.log(`[daemon] Running.");
    const immediateReconcile = managerSource.indexOf(
      'setTimeout(() => void scheduleRuntimeLifecycleReconcile(), 0)',
      runningMarker,
    );
    const heartbeat = managerSource.indexOf('// Heartbeat', runningMarker);

    expect(runningMarker).toBeGreaterThan(-1);
    expect(immediateReconcile).toBeGreaterThan(runningMarker);
    expect(immediateReconcile).toBeLessThan(heartbeat);
  });

  it('cadence-gates the HTTP SSOT backstop while daemon-link remains event-driven', () => {
    expect(runtimeSsotBackstopDue(0, 1_000, 60_000)).toBe(true);
    expect(runtimeSsotBackstopDue(1_000, 60_999, 60_000)).toBe(false);
    expect(runtimeSsotBackstopDue(1_000, 61_000, 60_000)).toBe(true);
  });

  it('refreshes Hive runtime authority before any enabled agent starts', () => {
    const managerSource = fs.readFileSync(path.resolve('src/daemon/manager.ts'), 'utf-8');
    const daemonBody = managerSource.slice(
      managerSource.indexOf('async function runDaemon('),
      managerSource.indexOf('// Graceful shutdown'),
    );
    const startupRefresh = daemonBody.indexOf('await settleDaemonStartupDependencies({');
    const startEnabledAgents = daemonBody.indexOf('// Auto-start agents that are enabled');

    expect(startupRefresh).toBeGreaterThan(-1);
    expect(startEnabledAgents).toBeGreaterThan(startupRefresh);
    expect(daemonBody).toContain('runtimeSsot: () => refreshRuntimeSsot(');
    expect(daemonBody).toContain(
      'Startup SSOT refresh completed before agent start',
    );
  });
});

describe('computeRuntimeReconcilePlan (local + k8s actual state)', () => {
  it('stops disabled k8s Deployments using the same two-source agreement as local containers', () => {
    const plan = computeRuntimeReconcilePlan(
      [
        { agentId: 'hana', backend: 'k8s', replicas: 1, readyReplicas: 1 },
        { agentId: 'kai', backend: 'local', replicas: 1, readyReplicas: 1 },
      ],
      new Set(['kai']),
      statuses({ hana: 'disabled', kai: 'active' }),
      new Set(['hana']),
    );

    expect(plan).toEqual({ toStop: ['hana'], toStopLocal: [], toStopK8s: [], unsupportedRollback: [], toRestoreK8s: [], toStartK8s: [], toRefreshK8s: [] });
  });

  it('does not stop k8s when only enabled-agents disagrees', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'hana', backend: 'k8s', replicas: 1, readyReplicas: 1 }],
      new Set<string>(),
      statuses({ hana: 'active' }),
      new Set(['hana']),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStartK8s).toEqual([]);
    expect(plan.toStopLocal).toEqual([]);
    expect(plan.toStopK8s).toEqual([]);
    expect(plan.unsupportedRollback).toEqual([]);
    expect(plan.skipReason).toBe('empty-enabled-set');
  });

  it('trips the mass-stop circuit breaker across local children and k8s Deployments together', () => {
    const actual = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((agentId, i) => ({
      agentId,
      backend: i % 2 ? 'k8s' as const : 'local' as const,
      replicas: 1,
      readyReplicas: 1,
    }));
    const plan = computeRuntimeReconcilePlan(
      actual,
      new Set(['a']),
      statuses({ a: 'active', b: 'disabled', c: 'disabled', d: 'disabled', e: 'disabled', f: 'disabled', g: 'disabled', h: 'disabled' }),
      new Set(['b', 'd', 'f', 'h']),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStartK8s).toEqual([]);
    expect(plan.toStopLocal).toEqual([]);
    expect(plan.toStopK8s).toEqual([]);
    expect(plan.unsupportedRollback).toEqual([]);
    expect(plan.skipReason).toBe('circuit-breaker:7/8');
  });

  it('starts missing desired-enabled k8s agents but does not churn existing unready Deployments', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'hana', backend: 'k8s', replicas: 1, readyReplicas: 0 }],
      new Set(['hana', 'ryo']),
      statuses({ hana: 'active', ryo: 'active' }),
      new Set(['hana', 'ryo']),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStartK8s).toEqual(['ryo']);
  });


  it('re-applies healthy k8s Deployments when credential drift is observed', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'hana', backend: 'k8s', replicas: 1, readyReplicas: 1, credentialDrift: true }],
      new Set(['hana']),
      statuses({ hana: 'active' }),
      new Set(['hana']),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStartK8s).toEqual(['hana']);
  });

  it('does not restart desired-paused k8s agents after pause scales them to zero', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'hana', backend: 'k8s', replicas: 0, readyReplicas: 0 }],
      new Set(['hana']),
      statuses({ hana: 'paused' }),
      new Set(['hana']),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStopLocal).toEqual([]);
    expect(plan.toStopK8s).toEqual([]);
    expect(plan.unsupportedRollback).toEqual([]);
    expect(plan.toStartK8s).toEqual([]);
  });

  it('observes a persisted container to k8s flip and stops local before starting k8s', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'cora', backend: 'local', replicas: 1, readyReplicas: 1 }],
      new Set(['cora']),
      statuses({ cora: 'active' }),
      new Set(['cora']),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStopLocal).toEqual(['cora']);
    expect(plan.toStopK8s).toEqual([]);
    expect(plan.unsupportedRollback).toEqual([]);
    expect(plan.toStartK8s).toEqual([]);
  });

  it('starts desired k8s on a later tick after the local runtime is gone', () => {
    const plan = computeRuntimeReconcilePlan(
      [],
      new Set(['cora']),
      statuses({ cora: 'active' }),
      new Set(['cora']),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStopLocal).toEqual([]);
    expect(plan.toStopK8s).toEqual([]);
    expect(plan.unsupportedRollback).toEqual([]);
    expect(plan.toStartK8s).toEqual(['cora']);
  });

  it('preserves an active k8s backend until the desired container replacement can start', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'san', backend: 'k8s', replicas: 1, readyReplicas: 1 }],
      new Set(['san']),
      statuses({ san: 'active' }),
      new Set<string>(),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStopLocal).toEqual([]);
    expect(plan.toStopK8s).toEqual([]);
    expect(plan.unsupportedRollback).toEqual(['san']);
    expect(plan.toStartK8s).toEqual([]);
  });

  it('restores an active rollback backend that was scaled down before a local replacement existed', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'ichi', backend: 'k8s', replicas: 0, readyReplicas: 0 }],
      new Set(['ichi']),
      statuses({ ichi: 'active' }),
      new Set<string>(),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStopLocal).toEqual([]);
    expect(plan.toStopK8s).toEqual([]);
    expect(plan.unsupportedRollback).toEqual([]);
    expect(plan.toRestoreK8s).toEqual(['ichi']);
    expect(plan.toStartK8s).toEqual([]);
  });

  it('never leaves docker and k8s twins for the same desired runtime', () => {
    const plan = computeRuntimeReconcilePlan(
      [
        { agentId: 'ichi', backend: 'local', replicas: 1, readyReplicas: 1 },
        { agentId: 'ichi', backend: 'k8s', replicas: 1, readyReplicas: 1 },
      ],
      new Set(['ichi']),
      statuses({ ichi: 'active' }),
      new Set(['ichi']),
    );

    expect(plan.toStop).toEqual([]);
    expect(plan.toStopLocal).toEqual(['ichi']);
    expect(plan.toStopK8s).toEqual([]);
    expect(plan.unsupportedRollback).toEqual([]);
    expect(plan.toStartK8s).toEqual([]);
  });
});

// ── PLAT-3625: config-hash drift refresh lane ──

describe('computeRuntimeReconcilePlan — toRefreshK8s (PLAT-3625)', () => {
  it('refreshes a HEALTHY k8s agent whose live config hash drifted from desired', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'nao', backend: 'k8s', replicas: 1, readyReplicas: 1, configHash: 'old111' }],
      new Set(['nao']),
      statuses({ nao: 'active' }),
      new Set(['nao']),
      new Map([['nao', 'new222']]),
    );
    expect(plan.toRefreshK8s).toEqual(['nao']);
    expect(plan.toStartK8s).toEqual([]);
  });

  it('does NOT treat a missing live annotation as drift (no fleet-wide bounce on first rollout)', () => {
    const plan = computeRuntimeReconcilePlan(
      [{ agentId: 'nao', backend: 'k8s', replicas: 1, readyReplicas: 1 }],
      new Set(['nao']),
      statuses({ nao: 'active' }),
      new Set(['nao']),
      new Map([['nao', 'new222']]),
    );
    expect(plan.toRefreshK8s).toEqual([]);
  });

  it('matching hashes, unhealthy deployments, and disabled agents are not refreshed', () => {
    const plan = computeRuntimeReconcilePlan(
      [
        { agentId: 'same', backend: 'k8s', replicas: 1, readyReplicas: 1, configHash: 'h1' },
        { agentId: 'down', backend: 'k8s', replicas: 1, readyReplicas: 0, configHash: 'old' },
        { agentId: 'off', backend: 'k8s', replicas: 1, readyReplicas: 1, configHash: 'old' },
      ],
      new Set(['same', 'down']),
      statuses({ same: 'active', down: 'active', off: 'disabled' }),
      new Set(['same', 'down', 'off']),
      new Map([['same', 'h1'], ['down', 'new'], ['off', 'new']]),
    );
    expect(plan.toRefreshK8s).toEqual([]);
    // the unhealthy one is left to kubelet/alerts; re-applying every tick causes churn.
    expect(plan.toStartK8s).toEqual([]);
  });
});

describe('deployment desired-state adoption (2026-08-08 goro zombie)', () => {
  it('adopts a ready Deployment for a config-active agent the enabled-set forgot', () => {
    const managerSource = fs.readFileSync(path.resolve('src/daemon/manager.ts'), 'utf-8');
    const adoptionBody = managerSource.slice(
      managerSource.indexOf('adopting Deployment desired-state as enablement authority') - 4000,
      managerSource.indexOf('adopting Deployment desired-state as enablement authority') + 2000,
    );
    // The pre-fix block only promoted agents that were ALREADY enabled; a
    // Hive-direct start (provisioner.start_agent) left enabled=false and the
    // ready pod was reported 'stopped' to Hive forever. The adoption must:
    // 1) persist the enabled-set so /v1/agents and daemon-link frames agree,
    expect(adoptionBody).toContain('enabledNow.add(deployment.agentId)');
    expect(adoptionBody).toContain('writeEnabledAgents(enabledNow)');
    // 2) clear any stale kill-switch file entry,
    expect(adoptionBody).toContain('disabledNow.delete(deployment.agentId)');
    // 3) include the agent in THIS tick's plan input so it is not double-planned,
    expect(adoptionBody).toContain('enabledSet.add(deployment.agentId)');
    // 4) only ever adopt config-active agents (never paused/disabled config),
    expect(adoptionBody).toContain("agent?.status !== 'active'");
    // 5) and update the observed runtime state to running.
    expect(adoptionBody).toContain("status: 'running'");
  });

  it('never adopts a Deployment for an agent whose config status is disabled', () => {
    // toStop (SCLI-149) remains the zombie-stop path for genuinely disabled
    // agents: plan keeps stopping a running runtime when config says disabled.
    const plan = computeRuntimeReconcilePlan(
      [
        { agentId: 'a1', backend: 'k8s', replicas: 1, readyReplicas: 1 },
        { agentId: 'a2', backend: 'k8s', replicas: 1, readyReplicas: 1 },
      ],
      new Set(['a2']),
      statuses({ a1: 'disabled', a2: 'active' }),
      new Set(['a1', 'a2']),
    );
    expect(plan.toStop).toEqual(['a1']);
  });
});
