import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __setAgentStateStoreForTest } from '../../src/daemon/agent-state-mirror.js';
import { readAgents, readDaemonState, readEnabledAgents, setAgentDesiredRuntimeState, writeAgents } from '../../src/daemon/state.js';
import {
  __getInMemoryDaemonStateForTest,
  __refreshEffectiveCapabilitiesForAgentIfStaleForTest,
  __refreshEffectiveCapabilitiesForAgentsConcurrentlyForTest,
  __refreshEffectiveCapabilitiesForAgentsForTest,
  __resetEffectiveCapabilityRefreshStateForTest,
  __setDiscoveredAgentsForTest,
  __setEffectiveCapabilityPlatformClientForTest,
  __setInMemoryDaemonStateForTest,
  createLocalAgentAtRuntime,
  deleteLocalAgentAtRuntime,
  harnessDriftAgeMs,
  orderRuntimeRollDrift,
  pruneHarnessDriftClock,
  resolveHarnessRollMaxStaleMs,
  resolveRuntimeChain,
  restrictRuntimeRollDriftForConvergence,
  consumesRuntimeRollNonIdleProbe,
  runtimeRollBusyGate,
  runtimeRollActionForDeployment,
  selectActionableRuntimeRollDrift,
  selectRuntimeRollDrift,
  shouldFocusRuntimeRollDrain,
  shouldUseCodexBroker,
  updateLocalAgentAtRuntime,
} from '../../src/daemon/manager.js';
import { getCodexBrokerToken } from '../../src/daemon/codex-broker.js';
import { shouldRejectHostCodexCredentialRoute } from '../../src/daemon/dashboard.js';
import { AgentStateStore } from '../../src/daemon/agent-state-store.js';
import type { AgentInfo } from '../../src/daemon/types.js';
import { K8S_RUNTIME_SPEC_REVISION, type K8sDeploymentState } from '../../src/daemon/k8s-backend.js';

describe('SCLI-331 — unavailable image-drift recovery', () => {
  const state = (over: Partial<K8sDeploymentState>): K8sDeploymentState => ({
    agentId: 'agent-1',
    username: 'one',
    name: 'agent-one',
    replicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
    currentImage: 'runtime:current',
    currentBrokerImage: 'broker:old',
    ...over,
  });

  it('selects only the drifted fully-unavailable deployment for repair', () => {
    const unavailable = state({ readyReplicas: 0, availableReplicas: 0 });
    const healthyDrift = state({ agentId: 'agent-2', username: 'two', name: 'agent-two' });

    expect(restrictRuntimeRollDriftForConvergence(
      [unavailable, healthyDrift],
      [unavailable, healthyDrift],
    )).toEqual([unavailable]);
  });

  it('does NOT block a roll when an unrelated on-desired deployment is converging (hibernation wake)', () => {
    // agent-3 is converging but NOT in the drift set (already on the desired
    // image, e.g. an on-demand reconciler wake). That is not a harness roll in
    // flight, so it must not starve the roller.
    const healthyDrift = state({ agentId: 'agent-2', username: 'two', name: 'agent-two' });
    const hibernationWake = state({
      agentId: 'agent-3', username: 'three', name: 'agent-three', readyReplicas: 0, availableReplicas: 0,
    });

    expect(restrictRuntimeRollDriftForConvergence([healthyDrift], [healthyDrift, hibernationWake]))
      .toEqual([healthyDrift]);
  });

  it('blocks a NEW roll while a drifted deployment is still converging (real roll in flight)', () => {
    // agent-3 is BOTH drifted (in the drift set) and converging → a harness
    // roll is genuinely in flight, so no new roll starts; only the
    // fully-unavailable roll target is returned (maxUnavailable=1 preserved).
    const healthyDrift = state({ agentId: 'agent-2', username: 'two', name: 'agent-two' });
    const rollInFlight = state({
      agentId: 'agent-3', username: 'three', name: 'agent-three', readyReplicas: 0, availableReplicas: 0,
    });

    expect(restrictRuntimeRollDriftForConvergence(
      [healthyDrift, rollInFlight],
      [healthyDrift, rollInFlight],
    )).toEqual([rollInFlight]);
  });

  it('leaves the normal drift order intact when the fleet is converged', () => {
    const first = state({});
    const second = state({ agentId: 'agent-2', username: 'two', name: 'agent-two' });
    expect(restrictRuntimeRollDriftForConvergence([first, second], [first, second])).toEqual([first, second]);
  });

  it('paces an unstamped pod-contract revision through the runtime roll lane', () => {
    const current = state({
      currentImage: 'runtime:desired',
      currentBrokerImage: 'broker:desired',
    });
    const stamped = state({
      agentId: 'agent-2',
      username: 'two',
      name: 'agent-two',
      currentImage: 'runtime:desired',
      currentBrokerImage: 'broker:desired',
      runtimeSpecRevision: K8S_RUNTIME_SPEC_REVISION,
    });

    expect(selectRuntimeRollDrift([current, stamped], 'runtime:desired', 'broker:desired')).toEqual([current]);
  });

  it('paces a stale workspace init image through the runtime roll lane', () => {
    const staleInit = state({
      currentImage: 'runtime:desired',
      currentWorkspaceInitImage: 'runtime:old',
      currentBrokerImage: 'broker:desired',
      runtimeSpecRevision: K8S_RUNTIME_SPEC_REVISION,
    });

    expect(selectRuntimeRollDrift([staleInit], 'runtime:desired', 'broker:desired'))
      .toEqual([staleInit]);
  });

  it('prioritizes agent-runtime image drift over broker-only drift', () => {
    const brokerOnly = state({
      agentId: 'agent-a',
      username: 'a',
      name: 'agent-a',
      currentImage: 'runtime:desired',
    });
    const imageDrift = state({
      agentId: 'agent-z',
      username: 'z',
      name: 'agent-z',
      currentImage: 'runtime:old',
      currentBrokerImage: 'broker:desired',
    });

    expect(orderRuntimeRollDrift(
      [brokerOnly, imageDrift],
      'runtime:desired',
      new Map([[brokerOnly.agentId, 10_000], [imageDrift.agentId, 1_000]]),
    )).toEqual([imageDrift, brokerOnly]);
  });

  it('stages a disabled replicas=0 template without authorizing a restart', () => {
    const stopped = state({ replicas: 0, readyReplicas: 0, availableReplicas: 0 });
    const disabled = new Set([stopped.agentId]);

    expect(runtimeRollActionForDeployment(stopped, new Set(), disabled)).toBe('stage-stopped');
    expect(runtimeRollActionForDeployment(
      { ...stopped, replicas: 1 },
      new Set(),
      disabled,
    )).toBeUndefined();
  });

  it('does not let an unavailable disabled workload deadlock stopped-template convergence', () => {
    const stopped = state({
      agentId: 'agent-stopped',
      username: 'stopped',
      name: 'agent-stopped',
      replicas: 0,
      readyReplicas: 0,
      availableReplicas: 0,
    });
    const disabledUnavailable = state({
      agentId: 'agent-disabled',
      username: 'disabled',
      name: 'agent-disabled',
      replicas: 1,
      readyReplicas: 0,
      availableReplicas: 0,
    });
    const disabled = new Set([disabledUnavailable.agentId]);
    const enabled = new Set<string>();

    const actionable = selectActionableRuntimeRollDrift(
      [stopped, disabledUnavailable],
      enabled,
      disabled,
    );

    expect(actionable).toEqual([stopped]);
    expect(restrictRuntimeRollDriftForConvergence(
      actionable,
      [stopped, disabledUnavailable],
    )).toEqual([stopped]);
  });

  it('keeps enabled running agents on the paced restart path', () => {
    const running = state({});
    expect(runtimeRollActionForDeployment(running, new Set([running.agentId]), new Set()))
      .toBe('restart-running');
  });

  it('fails closed when the just-in-time bridge probe is busy or unavailable', async () => {
    await expect(runtimeRollBusyGate(false, async () => ({
      busy: true,
      protocol: 'drain-v1',
    }))).resolves.toEqual({
      allow: false,
      reason: 'bridge-busy',
      protocol: 'drain-v1',
    });
    await expect(runtimeRollBusyGate(false, async () => {
      throw new Error('kubectl exec timed out');
    })).resolves.toEqual({
      allow: false,
      reason: 'probe-failed',
      detail: 'kubectl exec timed out',
    });
  });

  it('allows double-observed drain-idle rolls and fails closed on kubectl transport loss', async () => {
    const drainIdle = vi.fn(async () => ({
      busy: false,
      protocol: 'drain-v1',
    } as const));
    await expect(runtimeRollBusyGate(false, drainIdle, 0)).resolves.toEqual({
      allow: true,
      reason: 'bridge-idle',
      protocol: 'drain-v1',
    });
    expect(drainIdle).toHaveBeenCalledTimes(2);
    const probe = vi.fn(async () => {
      throw new Error('harness_roll_bridge_unreachable: unavailable pod cannot be exec-probed');
    });
    await expect(runtimeRollBusyGate(true, probe)).resolves.toEqual({
      allow: false,
      reason: 'probe-failed',
      detail: 'harness_roll_bridge_unreachable: unavailable pod cannot be exec-probed',
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('requires a stable drain-v2 admission fence across both observations', async () => {
    const stable = vi.fn(async () => ({
      busy: false,
      protocol: 'drain-v2' as const,
      fenceVersion: 23,
    }));
    await expect(runtimeRollBusyGate(false, stable, 0)).resolves.toEqual({
      allow: true,
      reason: 'bridge-idle',
      protocol: 'drain-v2',
    });
    expect(stable).toHaveBeenCalledTimes(2);

    const changed = vi.fn()
      .mockResolvedValueOnce({ busy: false, protocol: 'drain-v2' as const, fenceVersion: 23 })
      .mockResolvedValueOnce({ busy: false, protocol: 'drain-v2' as const, fenceVersion: 24 });
    await expect(runtimeRollBusyGate(false, changed, 0)).resolves.toMatchObject({
      allow: false,
      reason: 'bridge-busy',
      protocol: 'drain-v2',
    });
  });

  it('repairs a false-positive Ready pod only after two bridge-local refusals', async () => {
    const absent = vi.fn(async () => {
      throw new Error('harness_roll_bridge_absent: curl connection refused');
    });
    await expect(runtimeRollBusyGate(false, absent, 0)).resolves.toEqual({
      allow: true,
      reason: 'bridge-absent-repair',
    });
    expect(absent).toHaveBeenCalledTimes(2);

    const recovered = vi.fn()
      .mockRejectedValueOnce(new Error('harness_roll_bridge_absent: curl connection refused'))
      .mockResolvedValueOnce({ busy: false, protocol: 'legacy-health' as const });
    await expect(runtimeRollBusyGate(true, recovered, 0)).resolves.toEqual({
      allow: false,
      reason: 'bridge-busy',
      detail: 'bridge recovered while confirming local absence',
    });
  });

  it('fails closed on a reachable but malformed drain response even when readiness is zero', async () => {
    await expect(runtimeRollBusyGate(true, async () => {
      throw new Error('harness_roll_drain_invalid_response: request fence mismatch');
    })).resolves.toEqual({
      allow: false,
      reason: 'probe-failed',
      detail: 'harness_roll_drain_invalid_response: request fence mismatch',
    });
  });

  it('does not bypass an active bridge merely because the Deployment is unready', async () => {
    await expect(runtimeRollBusyGate(true, async () => ({
      busy: true,
      protocol: 'drain-v1',
    }))).resolves.toEqual({
      allow: false,
      reason: 'bridge-busy',
      protocol: 'drain-v1',
    });
  });

  it('requires two quiet legacy observations before using the compatibility path', async () => {
    const stable = vi.fn(async () => ({
      busy: false,
      protocol: 'legacy-health' as const,
    }));
    await expect(runtimeRollBusyGate(false, stable, 0)).resolves.toEqual({
      allow: true,
      reason: 'bridge-idle',
      protocol: 'legacy-health',
    });
    expect(stable).toHaveBeenCalledTimes(2);

    const changed = vi.fn()
      .mockResolvedValueOnce({ busy: false, protocol: 'legacy-health' as const })
      .mockResolvedValueOnce({ busy: true, protocol: 'legacy-health' as const });
    await expect(runtimeRollBusyGate(false, changed, 0)).resolves.toMatchObject({
      allow: false,
      reason: 'bridge-busy',
      protocol: 'legacy-health',
    });
  });

  it('preserves a drain-v1 reservation while scanning for another proven-idle agent', () => {
    expect(shouldFocusRuntimeRollDrain('drain-v1')).toBe(false);
    expect(shouldFocusRuntimeRollDrain('drain-v2')).toBe(false);
    expect(shouldFocusRuntimeRollDrain('drain-v1', true)).toBe(false);
    expect(shouldFocusRuntimeRollDrain('legacy-health')).toBe(false);
    expect(shouldFocusRuntimeRollDrain(undefined)).toBe(true);
  });

  it('does not let queued-work preflight starve a later drainable bridge', async () => {
    const queuedPreflight = await runtimeRollBusyGate(false, async () => ({
      busy: true,
      protocol: 'drain-v1' as const,
    }));
    expect(queuedPreflight).toEqual({
      allow: false,
      reason: 'bridge-busy',
      protocol: 'drain-v1',
    });
    expect(consumesRuntimeRollNonIdleProbe(queuedPreflight)).toBe(false);

    const armedDrain = await runtimeRollBusyGate(false, async () => ({
      busy: true,
      protocol: 'drain-v1' as const,
      drainReserved: true,
    }));
    expect(armedDrain).toEqual({
      allow: false,
      reason: 'bridge-busy',
      protocol: 'drain-v1',
      drainReserved: true,
    });
    expect(consumesRuntimeRollNonIdleProbe(armedDrain)).toBe(true);
    expect(consumesRuntimeRollNonIdleProbe({
      allow: false,
      reason: 'bridge-busy',
      protocol: 'legacy-health',
    })).toBe(true);
  });
});

describe('SCLI-331 tail-completion — harness drift clock', () => {
  it('does not let a short live override force-roll active turns before stuck-turn recovery', () => {
    expect(resolveHarnessRollMaxStaleMs('60')).toBe(60 * 60_000);
    expect(resolveHarnessRollMaxStaleMs('1800')).toBe(60 * 60_000);
    expect(resolveHarnessRollMaxStaleMs('7200')).toBe(120 * 60_000);
  });

  it('preserves the explicit zero kill-switch and fails malformed values safe', () => {
    expect(resolveHarnessRollMaxStaleMs('0')).toBe(0);
    expect(resolveHarnessRollMaxStaleMs('not-a-number')).toBe(60 * 60_000);
    expect(resolveHarnessRollMaxStaleMs('-1')).toBe(60 * 60_000);
  });

  it('starts at 0 on first observation then reports elapsed drift', () => {
    pruneHarnessDriftClock('img:zzz'); // clear any prior-target entries
    const t0 = 1_000_000;
    // First sighting of this (agent, desired) pair anchors the clock at 0.
    expect(harnessDriftAgeMs('agent-stale', 'img:zzz', t0)).toBe(0);
    // A later tick reports the elapsed time since first sighting.
    expect(harnessDriftAgeMs('agent-stale', 'img:zzz', t0 + 1800_000)).toBe(1800_000);
  });

  it('restarts the clock when the desired target moves (no premature force-roll)', () => {
    const t0 = 2_000_000;
    expect(harnessDriftAgeMs('agent-x', 'img:a', t0)).toBe(0);
    expect(harnessDriftAgeMs('agent-x', 'img:a', t0 + 600_000)).toBe(600_000);
    // Desired advances to img:b — pruning drops the img:a entry, so img:b
    // is a fresh 0 (an agent isn't force-rolled for a target it just acquired).
    pruneHarnessDriftClock('img:b');
    expect(harnessDriftAgeMs('agent-x', 'img:b', t0 + 600_000)).toBe(0);
    // img:a's clock is gone.
    expect(harnessDriftAgeMs('agent-x', 'img:a', t0 + 600_000)).toBe(0);
  });
});

describe('PLAT-1062 P4a-2 — runtime update fail-closed persistence', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  const baseAgent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
    id: 'agent-1',
    name: 'tester',
    username: 'tester',
    email: 'tester@shizuha.com',
    role: 'Engineer',
    executionMethod: 'claude_code_server',
    modelOverrides: { claude_code_server: 'claude-sonnet-4-6' },
    modelFallbacks: [{ method: 'claude_code_server', model: 'claude-sonnet-4-6' }],
    status: 'active',
    ...over,
  } as AgentInfo);

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-manager-update-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
    __setAgentStateStoreForTest(undefined);
  });

  afterEach(() => {
    __setAgentStateStoreForTest(undefined);
    __setDiscoveredAgentsForTest([]);
    __setInMemoryDaemonStateForTest(null);
    __setEffectiveCapabilityPlatformClientForTest(null);
    __resetEffectiveCapabilityRefreshStateForTest();
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('does not mutate discoveredAgents when the store-owned update cannot persist', () => {
    const liveAgent = baseAgent();
    writeAgents([baseAgent()]);
    __setDiscoveredAgentsForTest([liveAgent]);
    // Null store simulates the P4a-2 authoritative store being unavailable. Store-owned
    // updates must fail closed before touching the live in-memory runtime row.
    __setAgentStateStoreForTest(null);

    const result = updateLocalAgentAtRuntime('agent-1', {
      model_overrides: { claude_code_server: 'claude-opus-4-8' },
      skills: ['new-skill'],
    });

    expect(result.ok).toBe(false);
    expect(liveAgent.modelOverrides).toEqual({ claude_code_server: 'claude-sonnet-4-6' });
    expect(liveAgent.skills).toBeUndefined();
    expect(readAgents()[0]!.modelOverrides).toEqual({ claude_code_server: 'claude-sonnet-4-6' });
  });

  it('uses Hive primary model ahead of stale fallback-chain entries', () => {
    const chain = resolveRuntimeChain(baseAgent({
      executionMethod: 'shizuha',
      model: 'cortex/DeepSeek-V4-Flash',
      modelFallbacks: [{ method: 'shizuha', model: 'cortex/Qwen3.6-27B-NVFP4' }],
      modelOverrides: {},
    }));

    expect(chain[0]).toEqual({ method: 'shizuha', model: 'cortex/DeepSeek-V4-Flash' });
    expect(chain[1]).toEqual({ method: 'shizuha', model: 'cortex/Qwen3.6-27B-NVFP4' });
  });

  it('renders Hive reasoning effort from the atomic model override when the fallback chain is empty', () => {
    const chain = resolveRuntimeChain(baseAgent({
      executionMethod: 'codex_app_server',
      model: 'gpt-5.6-sol',
      modelFallbacks: [],
      modelOverrides: {
        codex_app_server: 'gpt-5.6-sol',
        codex_app_server_reasoning_effort: 'high',
      },
    }));

    expect(chain).toEqual([{
      method: 'codex_app_server',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      thinkingLevel: undefined,
    }]);
  });

  it('lets Hive reasoning effort override a stale same-model fallback value', () => {
    const chain = resolveRuntimeChain(baseAgent({
      executionMethod: 'codex_app_server',
      model: 'gpt-5.6-sol',
      modelFallbacks: [{ method: 'codex_app_server', model: 'gpt-5.6-sol', reasoningEffort: 'low' }],
      modelOverrides: {
        codex_app_server: 'gpt-5.6-sol',
        codex_app_server_reasoning_effort: 'high',
      },
    }));

    expect(chain[0]).toMatchObject({
      method: 'codex_app_server',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
  });

  it('applies Hive model and reasoning as one primary with no hidden chain', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    const liveAgent = baseAgent({
      executionMethod: 'codex_app_server',
      model: 'gpt-5.6-sol',
      modelOverrides: { codex_app_server: 'gpt-5.6-sol', codex_app_server_reasoning_effort: 'high' },
      modelFallbacks: [{ method: 'codex_app_server', model: 'gpt-5.6-sol' }],
    });
    writeAgents([liveAgent]);
    __setDiscoveredAgentsForTest([liveAgent]);

    const result = updateLocalAgentAtRuntime('agent-1', {
      model: 'gpt-5.6-terra',
      reasoning_effort: 'medium',
      model_fallbacks: [],
    });

    expect(result).toEqual({ ok: true });
    expect(liveAgent.model).toBe('gpt-5.6-terra');
    expect(liveAgent.modelFallbacks).toEqual([]);
    expect(liveAgent.modelOverrides).toMatchObject({
      codex_app_server: 'gpt-5.6-terra',
      codex_app_server_reasoning_effort: 'medium',
    });
    store.close();
  });

  it('does not create a live runtime agent when the store is unavailable', () => {
    __setAgentStateStoreForTest(null);

    expect(() => createLocalAgentAtRuntime({
      name: 'newbie',
      username: 'newbie',
      email: 'newbie@shizuha.com',
      executionMethod: 'claude_code_server',
    })).toThrow(/AgentStateStore unavailable/);

    expect(readAgents()).toEqual([]);
  });

  it('creates a local runtime agent stopped until an explicit enable flips desired state', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    __setInMemoryDaemonStateForTest({
      pid: 123,
      startedAt: '2026-07-03T00:00:00.000Z',
      platformUrl: 'https://platform.test',
      agents: [],
    });

    const agent = createLocalAgentAtRuntime({
      name: 'newbie',
      username: 'newbie',
      email: 'newbie@shizuha.com',
      executionMethod: 'claude_code_server',
    });

    const row = store.getAgent(agent.id)!;
    expect(row.desired_enabled).toBe(0);
    expect(row.operator_disabled).toBe(0);
    expect(readEnabledAgents().has(agent.id)).toBe(false);
    expect(__getInMemoryDaemonStateForTest()?.agents.find((a) => a.agentId === agent.id)?.enabled).toBe(false);
    expect(readDaemonState()?.agents.find((a) => a.agentId === agent.id)?.enabled).toBe(false);
    expect(readAgents().find((a) => a.id === agent.id)?.username).toBe('newbie');
    store.close();
  });

  it('restart enable path rekeys a username-matched store row before writing desired state', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    const oldId = 'local-jun-mr53slts';
    const newId = 'f670991c-1432-51d2-99f2-627b6d3ce777';
    store.createAgent('seed', { id: oldId, username: 'jun', name: 'Jun' });
    store.recordObservation(oldId, {
      observed_state: 'stopped',
      runtime_kind: 'docker',
      container_or_pod: 'shizuha-agent-jun',
    });
    writeAgents([baseAgent({ id: newId, username: 'jun', name: 'Jun' })]);

    const first = setAgentDesiredRuntimeState(newId, true, { actor: 'restartAgent' });
    const second = setAgentDesiredRuntimeState(newId, true, { actor: 'restartAgent' });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(store.getAgent(oldId)).toBeUndefined();
    expect(store.getAgent(newId)).toMatchObject({ username: 'jun', desired_enabled: 1, operator_disabled: 0 });
    expect(store.getObservation(newId)).toMatchObject({ container_or_pod: 'shizuha-agent-jun' });
    expect(readEnabledAgents().has(newId)).toBe(true);
    store.close();
  });

  it('does not delete runtime memory or JSON when the store delete cannot persist', () => {
    const liveAgent = baseAgent();
    writeAgents([baseAgent()]);
    __setDiscoveredAgentsForTest([liveAgent]);
    __setAgentStateStoreForTest(null);

    const result = deleteLocalAgentAtRuntime('agent-1');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('AgentStateStore unavailable');
    expect(readAgents()[0]?.id).toBe('agent-1');
  });

  it('circuit-breaks the 42-agent capability backstop after two consecutive Hive dependency failures', async () => {
    const agents = Array.from({ length: 42 }, (_, index) => baseAgent({
      id: `agent-${index + 1}`,
      name: `agent-${index + 1}`,
      username: `agent-${index + 1}`,
      email: `agent-${index + 1}@shizuha.com`,
    }));
    const getEffectiveCapabilities = vi.fn().mockRejectedValue(new Error('Hive 503'));
    __setEffectiveCapabilityPlatformClientForTest({ getEffectiveCapabilities });

    const first = await __refreshEffectiveCapabilitiesForAgentsForTest(agents);
    const whileOpen = await __refreshEffectiveCapabilitiesForAgentsForTest(agents);

    expect(first).toEqual({ changed: [], circuitOpen: true });
    expect(whileOpen).toEqual({ changed: [], circuitOpen: true });
    expect(getEffectiveCapabilities).toHaveBeenCalledTimes(2);
  });

  it('isolates one periodic capability timeout and continues unrelated agents', async () => {
    const agents = Array.from({ length: 3 }, (_, index) => baseAgent({
      id: `agent-${index + 1}`,
      name: `agent-${index + 1}`,
      username: `agent-${index + 1}`,
      email: `agent-${index + 1}@shizuha.com`,
    }));
    const payload = {
      catalog_version: 1,
      capabilities: ['engineering'],
      source_teams: ['engineering'],
      skills: ['engineering-core'],
      enabled_mcp_servers: ['pulse'],
    };
    const getEffectiveCapabilities = vi.fn()
      .mockRejectedValueOnce(new Error('one request timed out'))
      .mockResolvedValue(payload);
    __setEffectiveCapabilityPlatformClientForTest({ getEffectiveCapabilities });

    const first = await __refreshEffectiveCapabilitiesForAgentsForTest(agents);
    const immediateRetry = await __refreshEffectiveCapabilitiesForAgentsForTest(agents);

    expect(first).toEqual({ changed: ['agent-2', 'agent-3'], circuitOpen: false });
    expect(immediateRetry).toEqual({ changed: [], circuitOpen: false });
    expect(getEffectiveCapabilities).toHaveBeenCalledTimes(5);
    expect(getEffectiveCapabilities.mock.calls.map(([agentId]) => agentId)).toEqual([
      'agent-1', 'agent-2', 'agent-3', 'agent-2', 'agent-3',
    ]);
  });

  it('coalesces an overlapping capability backstop instead of starting another fleet sweep', async () => {
    const agents = [baseAgent({ id: 'agent-1' }), baseAgent({ id: 'agent-2', username: 'two' })];
    let releaseFirst!: (value: unknown) => void;
    const firstResponse = new Promise<unknown>((resolve) => { releaseFirst = resolve; });
    const payload = {
      catalog_version: 1,
      capabilities: ['engineering'],
      source_teams: ['engineering'],
      skills: ['engineering-core'],
      enabled_mcp_servers: ['pulse'],
    };
    const getEffectiveCapabilities = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(payload);
    __setEffectiveCapabilityPlatformClientForTest({ getEffectiveCapabilities });

    const first = __refreshEffectiveCapabilitiesForAgentsForTest(agents);
    await vi.waitFor(() => expect(getEffectiveCapabilities).toHaveBeenCalledTimes(1));
    const overlap = await __refreshEffectiveCapabilitiesForAgentsForTest(agents);
    releaseFirst(payload);
    const completed = await first;

    expect(overlap).toEqual({ changed: [], circuitOpen: false });
    expect(completed.changed).toEqual(['agent-1', 'agent-2']);
    expect(getEffectiveCapabilities).toHaveBeenCalledTimes(2);
  });

  it('bounds parallel pre-start Hive capability fetches without serializing agent starts', async () => {
    const agents = Array.from({ length: 12 }, (_, index) => baseAgent({
      id: `agent-${index + 1}`,
      name: `agent-${index + 1}`,
      username: `agent-${index + 1}`,
    }));
    const payload = {
      catalog_version: 1,
      capabilities: ['engineering'],
      source_teams: ['engineering'],
      skills: ['engineering-core'],
      enabled_mcp_servers: ['pulse'],
    };
    let active = 0;
    let maxActive = 0;
    const getEffectiveCapabilities = vi.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return payload;
    });
    __setEffectiveCapabilityPlatformClientForTest({ getEffectiveCapabilities });

    await __refreshEffectiveCapabilitiesForAgentsConcurrentlyForTest(agents);

    expect(getEffectiveCapabilities).toHaveBeenCalledTimes(12);
    expect(maxActive).toBe(4);
  });

  it('cancels queued pre-start capability fetches after the first dependency failure', async () => {
    const agents = Array.from({ length: 42 }, (_, index) => baseAgent({
      id: `agent-${index + 1}`,
      name: `agent-${index + 1}`,
      username: `agent-${index + 1}`,
    }));
    const getEffectiveCapabilities = vi.fn().mockRejectedValue(new Error('Hive unavailable'));
    __setEffectiveCapabilityPlatformClientForTest({ getEffectiveCapabilities });

    await __refreshEffectiveCapabilitiesForAgentsConcurrentlyForTest(agents);

    // Only the already-admitted slots may reach Hive. Every queued operation
    // observes the circuit after admission and returns without another request.
    expect(getEffectiveCapabilities.mock.calls.length).toBeGreaterThan(0);
    expect(getEffectiveCapabilities.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('reuses a just-refreshed startup overlay instead of fetching it again per agent', async () => {
    const agent = baseAgent();
    const payload = {
      catalog_version: 1,
      capabilities: ['engineering'],
      source_teams: ['engineering'],
      skills: ['engineering-core'],
      enabled_mcp_servers: ['pulse'],
    };
    const getEffectiveCapabilities = vi.fn().mockResolvedValue(payload);
    __setEffectiveCapabilityPlatformClientForTest({ getEffectiveCapabilities });

    await __refreshEffectiveCapabilitiesForAgentsForTest([agent], 'startup');
    const changed = await __refreshEffectiveCapabilitiesForAgentIfStaleForTest(agent);

    expect(changed).toBe(false);
    expect(getEffectiveCapabilities).toHaveBeenCalledTimes(1);
  });

  it('checks the healthy k8s no-op before resolving platform credentials', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/daemon/manager.ts'), 'utf8');
    const start = source.indexOf('async function startAgentProcess(');
    const noOp = source.indexOf('skipping credential resolution and re-apply', start);
    const accountResolution = source.indexOf('account provisioning check:', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(noOp).toBeGreaterThan(start);
    expect(accountResolution).toBeGreaterThan(noOp);
    expect(source.slice(start, noOp)).toContain('!live?.duplicateEnvMetadata');
  });

  it('arms rollout suppression after duplicate env repair mutates the pod template', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/daemon/manager.ts'), 'utf8');
    const sweep = source.indexOf('for (const deployment of k8sDeploymentStates)');
    const repair = source.indexOf('repairAgentK8sDuplicateEnvMetadata(agent);', sweep);
    const arm = source.indexOf('noteK8sDaemonApply(agent.id);', repair);
    const markRepaired = source.indexOf('deployment.duplicateEnvMetadata = false;', repair);

    expect(sweep).toBeGreaterThanOrEqual(0);
    expect(repair).toBeGreaterThan(sweep);
    expect(arm).toBeGreaterThan(repair);
    expect(arm).toBeLessThan(markRepaired);
  });
});

describe('HIVE-586 — Hive is the sole Codex refresh authority', () => {
  const originalEnv = {
    home: process.env['HOME'],
    url: process.env['MCP_AUTH_PROXY_COORDINATOR_URL'],
    token: process.env['MCP_AUTH_PROXY_COORDINATOR_TOKEN'],
    tokenFile: process.env['MCP_AUTH_PROXY_COORDINATOR_TOKEN_FILE'],
  };
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-586-'));
    process.env['HOME'] = tmpHome;
    process.env['MCP_AUTH_PROXY_COORDINATOR_URL'] = 'http://hive.test/hive/api/v1/coordinator/model-token';
    delete process.env['MCP_AUTH_PROXY_COORDINATOR_TOKEN'];
    delete process.env['MCP_AUTH_PROXY_COORDINATOR_TOKEN_FILE'];
    const tokenDir = path.join(tmpHome, '.shizuha', 'mcp-auth-proxy');
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(path.join(tokenDir, 'coordinator-token.txt'), 'coordinator-bearer\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries({
      HOME: originalEnv.home,
      MCP_AUTH_PROXY_COORDINATOR_URL: originalEnv.url,
      MCP_AUTH_PROXY_COORDINATOR_TOKEN: originalEnv.token,
      MCP_AUTH_PROXY_COORDINATOR_TOKEN_FILE: originalEnv.tokenFile,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('leases OpenAI access from Hive without reading host credentials.json', async () => {
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'credentials.json'), '{not-json');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ token: 'leased-access', label: 'org-openai' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(getCodexBrokerToken()).resolves.toBe('leased-access');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://hive.test/hive/api/v1/coordinator/model-token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer coordinator-bearer' }),
        body: JSON.stringify({ provider: 'openai' }),
      }),
    );
  });

  it('extracts only the access token from Hive structured OpenAI leases', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({
        token: JSON.stringify({
          access_token: 'leased-access-only',
          refresh_token: 'must-never-reach-the-legacy-client',
          account_id: 'acct-1',
        }),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(getCodexBrokerToken()).resolves.toBe('leased-access-only');
  });

  it('fails closed when Hive coordinator configuration is absent', async () => {
    delete process.env['MCP_AUTH_PROXY_COORDINATOR_URL'];
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(getCodexBrokerToken()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only injects the daemon broker URL for coordinator-backed Codex bridges', () => {
    expect(shouldUseCodexBroker(true, true)).toBe(true);
    expect(shouldUseCodexBroker(true, false)).toBe(false);
    expect(shouldUseCodexBroker(false, true)).toBe(false);
  });

  it('blocks every host Codex credential route before poisoned local state can be used', () => {
    fs.writeFileSync(path.join(tmpHome, '.shizuha', 'credentials.json'), JSON.stringify({
      codex: { accounts: [{ email: 'poison@host.invalid', refreshToken: 'poison-refresh' }] },
    }));

    for (const route of [
      '/v1/providers/codex/accounts',
      '/v1/providers/codex/accounts/poison%40host.invalid',
      '/v1/providers/codex/accounts/refresh',
      '/v1/providers/codex/accounts/reorder',
      '/v1/providers/codex/accounts/test',
      '/v1/providers/codex/device-auth/start',
      '/v1/providers/codex/device-auth/poll/session',
    ]) {
      expect(shouldRejectHostCodexCredentialRoute(route)).toBe(true);
    }
    expect(shouldRejectHostCodexCredentialRoute('/v1/codex/token')).toBe(false);

    delete process.env['MCP_AUTH_PROXY_COORDINATOR_URL'];
    expect(shouldRejectHostCodexCredentialRoute('/v1/providers/codex/accounts')).toBe(false);
  });
});
