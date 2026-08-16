import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __setAgentStateStoreForTest } from '../../src/daemon/agent-state-mirror.js';
import { AgentStateStore } from '../../src/daemon/agent-state-store.js';
import {
  readDisabledAgents,
  readEnabledAgents,
  setAgentDesiredRuntimeState,
  writeAgents,
} from '../../src/daemon/state.js';
import type { AgentInfo } from '../../src/daemon/types.js';

describe('PLAT-1062 P4b — runtime desired-state writes use AgentStateStore', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  const baseAgent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
    id: 'agent-1',
    name: 'tester',
    username: 'tester',
    email: 'tester@shizuha.com',
    role: 'Engineer',
    executionMethod: 'claude_code_server',
    status: 'disabled',
    mcpServers: [],
    personalityTraits: {},
    skills: [],
    ...over,
  } as AgentInfo);

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-desired-state-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
    __setAgentStateStoreForTest(undefined);
  });

  afterEach(() => {
    __setAgentStateStoreForTest(undefined);
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes enable intent to SQLite before mirroring enabled-agents.json', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    writeAgents([baseAgent()]);

    const result = setAgentDesiredRuntimeState('agent-1', true, { actor: 'test-enable' });

    expect(result.ok).toBe(true);
    const row = store.getAgent('agent-1')!;
    expect(row.desired_enabled).toBe(1);
    expect(row.operator_disabled).toBe(0);
    expect(readEnabledAgents().has('agent-1')).toBe(true);
    expect(readDisabledAgents().has('agent-1')).toBe(false);
    expect(store.listEvents('agent-1').map((e) => e.event_type)).toContain('enabled');
    store.close();
  });

  it('refuses a plain enable when the operator kill-switch is set', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    writeAgents([baseAgent()]);
    expect(setAgentDesiredRuntimeState('agent-1', false, { actor: 'test-disable' }).ok).toBe(true);

    const result = setAgentDesiredRuntimeState('agent-1', true, { actor: 'test-enable' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('operator-disabled');
    const row = store.getAgent('agent-1')!;
    expect(row.desired_enabled).toBe(0);
    expect(row.operator_disabled).toBe(1);
    expect(readEnabledAgents().has('agent-1')).toBe(false);
    expect(readDisabledAgents().has('agent-1')).toBe(true);
    store.close();
  });

  it('explicit override clears the kill-switch in SQLite and compat files', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    writeAgents([baseAgent()]);
    expect(setAgentDesiredRuntimeState('agent-1', false, { actor: 'test-disable' }).ok).toBe(true);

    const result = setAgentDesiredRuntimeState('agent-1', true, {
      actor: 'test-override-enable',
      overrideKillSwitch: true,
    });

    expect(result.ok).toBe(true);
    const row = store.getAgent('agent-1')!;
    expect(row.desired_enabled).toBe(1);
    expect(row.operator_disabled).toBe(0);
    expect(readEnabledAgents().has('agent-1')).toBe(true);
    expect(readDisabledAgents().has('agent-1')).toBe(false);
    store.close();
  });

  it('does not mirror enabled state when the authoritative store is unavailable', () => {
    __setAgentStateStoreForTest(null);
    writeAgents([baseAgent()]);

    const result = setAgentDesiredRuntimeState('agent-1', true, { actor: 'test-enable' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('AgentStateStore unavailable');
    expect(readEnabledAgents().has('agent-1')).toBe(false);
    expect(readDisabledAgents().has('agent-1')).toBe(false);
  });
});
