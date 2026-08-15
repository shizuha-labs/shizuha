import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const staleHashMocks = vi.hoisted(() => ({
  computeAgentMcpConfigHash: vi.fn(() => 'cached-live-hash'),
  listK8sAgentDeployments: vi.fn(() => [{
    agentId: 'agent-1',
    username: 'tester',
    configHash: 'cached-live-hash',
  }]),
}));

vi.mock('../../src/daemon/k8s-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/k8s-backend.js')>();
  return {
    ...actual,
    computeAgentMcpConfigHash: staleHashMocks.computeAgentMcpConfigHash,
    listK8sAgentDeployments: staleHashMocks.listK8sAgentDeployments,
  };
});

import { __setAgentStateStoreForTest } from '../../src/daemon/agent-state-mirror.js';
import { readAgents, writeAgents } from '../../src/daemon/state.js';
import {
  __setDiscoveredAgentsForTest,
  __setRuntimeUpdateK8sReconcileForTest,
  updateLocalAgentAtRuntime,
} from '../../src/daemon/manager.js';
import { AgentStateStore } from '../../src/daemon/agent-state-store.js';
import type { AgentInfo, DaemonConfig } from '../../src/daemon/types.js';

describe('PLAT-4546 — runtime mutation delegates to fresh k8s resolution', () => {
  let tmpHome: string;
  let previousHome: string | undefined;
  let store: AgentStateStore;

  const daemonConfig: DaemonConfig = {
    platformUrl: 'https://platform.test',
    wsUrl: 'wss://platform.test/ws',
    containerMode: true,
    image: 'registry.test/shizuha:test',
    agentFilter: [],
  };

  const baseAgent = (): AgentInfo => ({
    id: 'agent-1',
    name: 'tester',
    username: 'tester',
    email: 'tester@shizuha.com',
    role: 'Engineer',
    executionMethod: 'shizuha',
    runtimeEnvironment: 'k8s',
    model: 'cortex/test-model',
    modelFallbacks: [{ method: 'shizuha', model: 'cortex/test-model' }],
    modelOverrides: {},
    contextPrompt: 'prompt-v1',
    status: 'active',
  } as AgentInfo);

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-4546-runtime-update-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    process.env['SHIZUHA_PROFILE'] = 'fleet';
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });

    const agent = baseAgent();
    writeAgents([agent]);
    store = new AgentStateStore(':memory:');
    store.createAgent('test', {
      id: agent.id,
      username: agent.username,
      email: agent.email,
      name: agent.name,
      role: agent.role,
      runtimeEnvironment: agent.runtimeEnvironment,
      executionMethod: agent.executionMethod,
      model: agent.model,
      modelFallbacks: agent.modelFallbacks,
      modelOverrides: agent.modelOverrides,
    });
    __setAgentStateStoreForTest(store);
    __setDiscoveredAgentsForTest([agent]);
    staleHashMocks.computeAgentMcpConfigHash.mockClear();
    staleHashMocks.listK8sAgentDeployments.mockClear();
  });

  afterEach(() => {
    __setRuntimeUpdateK8sReconcileForTest(null);
    __setDiscoveredAgentsForTest([]);
    __setAgentStateStoreForTest(undefined);
    store.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['SHIZUHA_PROFILE'];
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('applies context and method changes once, then converges on identical repeats', () => {
    const resolvedUpdates: Array<{ contextPrompt?: string; executionMethod?: string }> = [];
    const starter = vi.fn(async (agent: AgentInfo) => {
      resolvedUpdates.push({
        contextPrompt: agent.contextPrompt,
        executionMethod: agent.executionMethod,
      });
      return undefined;
    });
    __setRuntimeUpdateK8sReconcileForTest(daemonConfig, starter);

    expect(updateLocalAgentAtRuntime('agent-1', { context_prompt: 'prompt-v2' })).toEqual({ ok: true });
    expect(starter).toHaveBeenCalledTimes(1);
    expect(resolvedUpdates[0]).toEqual({ contextPrompt: 'prompt-v2', executionMethod: 'shizuha' });

    expect(updateLocalAgentAtRuntime('agent-1', { context_prompt: 'prompt-v2' })).toEqual({ ok: true });
    expect(starter).toHaveBeenCalledTimes(1);

    expect(updateLocalAgentAtRuntime('agent-1', { execution_method: 'grok_build' })).toEqual({ ok: true });
    expect(starter).toHaveBeenCalledTimes(2);
    expect(resolvedUpdates[1]).toEqual({ contextPrompt: 'prompt-v2', executionMethod: 'grok_build' });

    expect(updateLocalAgentAtRuntime('agent-1', { execution_method: 'grok_build' })).toEqual({ ok: true });
    expect(starter).toHaveBeenCalledTimes(2);

    // The stale caller-level hash short-circuit that caused the regression is
    // no longer consulted; startAgentProcess owns fresh resolution + live hash.
    expect(staleHashMocks.computeAgentMcpConfigHash).not.toHaveBeenCalled();
    expect(staleHashMocks.listK8sAgentDeployments).not.toHaveBeenCalled();
  });

  it('preserves explicit empty Hive model overrides in a full desired-config frame', () => {
    const agent = baseAgent();
    const starter = vi.fn(async () => undefined);
    __setRuntimeUpdateK8sReconcileForTest(daemonConfig, starter);

    expect(updateLocalAgentAtRuntime('agent-1', {
      execution_method: 'shizuha',
      model: 'cortex/test-model',
      model_fallbacks: [{ method: 'shizuha', model: 'cortex/test-model' }],
      model_overrides: {},
    })).toEqual({ ok: true });

    expect(agent.modelOverrides).toEqual({});
    expect(readAgents()[0]?.modelOverrides).toEqual({});
    expect(starter).not.toHaveBeenCalled();
  });
});
