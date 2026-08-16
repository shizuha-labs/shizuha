import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const k8sMocks = vi.hoisted(() => ({
  getAgentK8sDeploymentState: vi.fn(),
  stopAgentK8s: vi.fn(),
}));

vi.mock('../../src/daemon/k8s-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/k8s-backend.js')>();
  return {
    ...actual,
    getAgentK8sDeploymentState: k8sMocks.getAgentK8sDeploymentState,
    stopAgentK8s: k8sMocks.stopAgentK8s,
  };
});

import { __setAgentStateStoreForTest } from '../../src/daemon/agent-state-mirror.js';
import { AgentStateStore } from '../../src/daemon/agent-state-store.js';
import {
  __getInMemoryDaemonStateForTest,
  __setDiscoveredAgentsForTest,
  __setInMemoryDaemonStateForTest,
  disableAndStopAgent,
} from '../../src/daemon/manager.js';
import { writeAgents } from '../../src/daemon/state.js';
import type { AgentInfo } from '../../src/daemon/types.js';

describe('disableAndStopAgent persisted-roster fallback', () => {
  let tmpHome: string;
  let previousHome: string | undefined;
  let store: AgentStateStore;

  const agent = (): AgentInfo => ({
    id: 'agent-ichi',
    name: 'Ichi',
    username: 'ichi',
    email: 'ichi@shizuha.com',
    role: 'DevOps Engineer',
    status: 'active',
    runtimeEnvironment: 'container',
    executionMethod: 'codex_app_server',
    model: 'gpt-5.6-sol',
    modelFallbacks: [],
    modelOverrides: {},
    mcpServers: [],
    personalityTraits: {},
    skills: [],
  });

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-disable-stop-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });

    const configured = agent();
    writeAgents([configured]);
    store = new AgentStateStore(':memory:');
    store.createAgent('test', {
      id: configured.id,
      username: configured.username,
      email: configured.email,
      name: configured.name,
      role: configured.role,
      runtimeEnvironment: configured.runtimeEnvironment,
      executionMethod: configured.executionMethod,
      model: configured.model,
      modelFallbacks: configured.modelFallbacks,
      modelOverrides: configured.modelOverrides,
    });
    __setAgentStateStoreForTest(store);
    __setInMemoryDaemonStateForTest({
      pid: 123,
      startedAt: '2026-07-26T00:00:00.000Z',
      platformUrl: 'https://platform.test',
      agents: [{
        agentId: configured.id,
        agentName: configured.name,
        tokenPrefix: 'test',
        status: 'running',
        enabled: true,
        startedAt: '2026-07-26T00:00:00.000Z',
      }],
    });
    k8sMocks.stopAgentK8s.mockReset();
    k8sMocks.getAgentK8sDeploymentState.mockReset();
    k8sMocks.getAgentK8sDeploymentState.mockReturnValue({
      agentId: configured.id,
      username: configured.username,
      name: `agent-${configured.username}`,
      replicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
    });
  });

  afterEach(() => {
    __setDiscoveredAgentsForTest([]);
    __setInMemoryDaemonStateForTest(null);
    __setAgentStateStoreForTest(undefined);
    store.close();
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('scales an observed stale k3s backend down when discovery omitted it and desired placement is container', () => {
    __setDiscoveredAgentsForTest([]);

    const result = disableAndStopAgent('agent-ichi');

    expect(result).toEqual({ ok: true });
    expect(k8sMocks.stopAgentK8s).toHaveBeenCalledTimes(1);
    expect(k8sMocks.stopAgentK8s).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-ichi',
        username: 'ichi',
        runtimeEnvironment: 'k8s',
      }),
    );
    expect(store.getAgent('agent-ichi')).toMatchObject({
      desired_enabled: 0,
      operator_disabled: 1,
    });
    expect(__getInMemoryDaemonStateForTest()?.agents[0]).toMatchObject({
      status: 'stopped',
      enabled: false,
    });
  });
});
