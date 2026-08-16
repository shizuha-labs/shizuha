import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addAgent, removeAgent, updateAgentConfig, readAgents, writeAgents } from '../../src/daemon/state.js';
import { AgentStateStore } from '../../src/daemon/agent-state-store.js';
import { __setAgentStateStoreForTest } from '../../src/daemon/agent-state-mirror.js';
import type { AgentInfo } from '../../src/daemon/types.js';

// HIVE-195: updateAgentConfig must keep the runtime-launched model (the primary
// method's modelFallbacks entry) in sync with the configured modelOverrides, so
// "Hive says opus, agent runs sonnet" drift can't happen.
describe('HIVE-195 — updateAgentConfig primary-model sync', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  const baseAgent = (over: Partial<AgentInfo> = {}): AgentInfo =>
    ({
      id: 'agent-1',
      name: 'tester',
      executionMethod: 'claude_code_server',
      modelOverrides: { claude_code_server: 'claude-sonnet-4-6' },
      modelFallbacks: [
        { method: 'claude_code_server', model: 'claude-sonnet-4-6' },
        { method: 'codex_app_server', model: 'gpt-5.5' },
      ],
      ...over,
    }) as AgentInfo;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-modelsync-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
    __setAgentStateStoreForTest(undefined);
    fs.mkdirSync(path.join(tmpHome, '.shizuha'), { recursive: true });
  });

  afterEach(() => {
    __setAgentStateStoreForTest(undefined);
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('syncs the primary modelFallbacks entry when modelOverrides changes', () => {
    writeAgents([baseAgent()]);

    const ok = updateAgentConfig('agent-1', {
      modelOverrides: { claude_code_server: 'claude-opus-4-8' },
    });
    expect(ok).toBe(true);

    const agent = readAgents()[0]!;
    // Primary entry now tracks the configured model …
    expect(agent.modelFallbacks?.[0]).toEqual({
      method: 'claude_code_server',
      model: 'claude-opus-4-8',
    });
    // … later failover entries are untouched.
    expect(agent.modelFallbacks?.[1]).toEqual({
      method: 'codex_app_server',
      model: 'gpt-5.5',
    });
  });

  it('prepends a primary entry when none exists for the method', () => {
    writeAgents([baseAgent({ modelFallbacks: [{ method: 'codex_app_server', model: 'gpt-5.5' }] })]);

    updateAgentConfig('agent-1', {
      modelOverrides: { claude_code_server: 'claude-opus-4-8' },
    });

    const agent = readAgents()[0]!;
    expect(agent.modelFallbacks?.[0]).toEqual({
      method: 'claude_code_server',
      model: 'claude-opus-4-8',
    });
    expect(agent.modelFallbacks?.length).toBe(2);
  });

  it('preserves an explicitly empty Hive-authored fallback chain', () => {
    writeAgents([baseAgent()]);

    const ok = updateAgentConfig('agent-1', {
      model: 'claude-opus-4-8',
      modelOverrides: { claude_code_server: 'claude-opus-4-8' },
      modelFallbacks: [],
    });

    expect(ok).toBe(true);
    const agent = readAgents()[0]!;
    expect(agent.model).toBe('claude-opus-4-8');
    expect(agent.modelOverrides?.claude_code_server).toBe('claude-opus-4-8');
    expect(agent.modelFallbacks).toEqual([]);
  });

  it('does NOT reshape the chain on a non-model update (e.g. credentials)', () => {
    // Pre-existing intentional drift; a credentials-only update must not touch it.
    const drifted = baseAgent({
      modelOverrides: { claude_code_server: 'claude-opus-4-8' },
      modelFallbacks: [{ method: 'claude_code_server', model: 'claude-sonnet-4-6' }],
    });
    writeAgents([drifted]);

    updateAgentConfig('agent-1', { credentials: { ANTHROPIC_API_KEY: 'x' } } as Partial<AgentInfo>);

    const agent = readAgents()[0]!;
    expect(agent.modelFallbacks?.[0]?.model).toBe('claude-sonnet-4-6'); // untouched
  });

  it('is idempotent / no-op when already consistent', () => {
    writeAgents([baseAgent()]);
    updateAgentConfig('agent-1', { modelOverrides: { claude_code_server: 'claude-sonnet-4-6' } });
    const agent = readAgents()[0]!;
    expect(agent.modelFallbacks?.[0]?.model).toBe('claude-sonnet-4-6');
    expect(agent.modelFallbacks?.length).toBe(2);
  });

  it('preserves reasoningEffort/thinkingLevel on the synced primary entry', () => {
    writeAgents([
      baseAgent({
        modelFallbacks: [
          { method: 'claude_code_server', model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
        ],
      }),
    ]);

    updateAgentConfig('agent-1', { modelOverrides: { claude_code_server: 'claude-opus-4-8' } });

    const agent = readAgents()[0]!;
    expect(agent.modelFallbacks?.[0]).toEqual({
      method: 'claude_code_server',
      model: 'claude-opus-4-8',
      thinkingLevel: 'high',
    });
  });

  it('PLAT-1062 P4a-2: readAgents overlays store-owned fields but preserves JSON-owned secrets and status', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    const jsonAgent = baseAgent({
      username: 'tester',
      email: 'tester@shizuha.com',
      role: 'Engineer',
      status: 'paused',
      model: 'json-model',
      credentials: [{
        id: 'cred-1',
        label: 'GitHub',
        credentialData: { token: 'secret' },
        injectAsEnv: true,
        isActive: true,
      }],
    });
    writeAgents([jsonAgent]);
    store.updateAgent('test', 'agent-1', { model: 'store-model', skills: ['store-skill'] });

    const agent = readAgents()[0]!;

    expect(agent.model).toBe('store-model');
    expect(agent.skills).toEqual(['store-skill']);
    expect(agent.status).toBe('paused');
    expect(agent.credentials?.[0]?.credentialData).toEqual({ token: 'secret' });
    store.close();
  });



  it('PLAT-1062 P4c: addAgent fails closed when the store is unavailable', () => {
    const store = new AgentStateStore(':memory:');
    store.close();
    __setAgentStateStoreForTest(store);

    const result = addAgent(baseAgent({ id: 'agent-2', username: 'newbie', email: 'newbie@shizuha.com' }));

    expect(result.ok).toBe(false);
    const agent = readAgents().find((a) => a.id === 'agent-2');
    expect(agent).toBeUndefined();
  });

  it('PLAT-1062 P4c: addAgent creates the store row before exporting agents.json', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);

    const result = addAgent(baseAgent({ id: 'agent-2', username: 'newbie', email: 'newbie@shizuha.com' }));

    expect(result.ok).toBe(true);
    expect(store.getAgent('agent-2')?.username).toBe('newbie');
    const disk = JSON.parse(fs.readFileSync(path.join(tmpHome, '.shizuha', 'agents.json'), 'utf-8')) as AgentInfo[];
    expect(disk.find((a) => a.id === 'agent-2')?.username).toBe('newbie');
    store.close();
  });

  it('PLAT-1062 P4c: removeAgent fails closed when the store delete fails', () => {
    writeAgents([baseAgent({ username: 'tester', email: 'tester@shizuha.com', role: 'Engineer' })]);
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    // readAgents seeds the row, then closing the DB simulates an unavailable
    // authoritative store for the delete transaction.
    expect(readAgents()[0]?.id).toBe('agent-1');
    store.close();

    const result = removeAgent('agent-1');

    expect(result.ok).toBe(false);
    expect(readAgents()[0]?.id).toBe('agent-1');
  });

  it('PLAT-1062 P4c: removeAgent deletes the store row before exporting agents.json', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    writeAgents([baseAgent({ username: 'tester', email: 'tester@shizuha.com', role: 'Engineer' })]);
    expect(store.getAgent('agent-1')).toBeTruthy();

    const result = removeAgent('agent-1');

    expect(result.ok).toBe(true);
    expect(store.getAgent('agent-1')).toBeUndefined();
    expect(readAgents()).toEqual([]);
    store.close();
  });

  it('PLAT-1062 P4a-2: updateAgentConfig writes store before deriving agents.json', () => {
    const store = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(store);
    writeAgents([baseAgent({ username: 'tester', email: 'tester@shizuha.com', role: 'Engineer', status: 'active' })]);

    const ok = updateAgentConfig('agent-1', {
      modelOverrides: { claude_code_server: 'claude-opus-4-8' },
    });

    expect(ok).toBe(true);
    const fromStore = store.getAgent('agent-1')!;
    expect(JSON.parse(fromStore.model_overrides_json!)).toEqual({ claude_code_server: 'claude-opus-4-8' });
    expect(JSON.parse(fromStore.model_fallbacks_json!)[0]).toEqual({
      method: 'claude_code_server',
      model: 'claude-opus-4-8',
    });
    const disk = JSON.parse(fs.readFileSync(path.join(tmpHome, '.shizuha', 'agents.json'), 'utf-8')) as AgentInfo[];
    expect(disk[0]!.modelOverrides).toEqual({ claude_code_server: 'claude-opus-4-8' });
    expect(disk[0]!.modelFallbacks?.[0]?.model).toBe('claude-opus-4-8');
    store.close();
  });
});
