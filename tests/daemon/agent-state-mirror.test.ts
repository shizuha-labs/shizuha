/**
 * PLAT-1062 P4a — agent-state mirror unit tests.
 * Covers: store-owned field filtering, adopt-on-unknown-agent, ordering of
 * successive patches, and best-effort failure swallowing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentStateStore } from '../../src/daemon/agent-state-store.js';
import {
  mirrorAgentPatch,
  __setAgentStateStoreForTest,
} from '../../src/daemon/agent-state-mirror.js';
import type { AgentInfo } from '../../src/daemon/types.js';

function mkAgent(id: string, username: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id, name: username, username, email: `${username}@shizuha.com`, role: 'Engineer',
    status: 'active', runtimeEnvironment: 'container', skills: ['a'],
    mcpServers: [], personalityTraits: {},
    ...extra,
  } as AgentInfo;
}

describe('agent-state-mirror — mirrorAgentPatch', () => {
  let s: AgentStateStore;

  beforeEach(() => {
    s = new AgentStateStore(':memory:');
    __setAgentStateStoreForTest(s);
  });

  afterEach(() => {
    __setAgentStateStoreForTest(undefined);
    s.close();
  });

  it('mirrors a store-owned field patch into an existing row', () => {
    s.createAgent('test', { id: 'a1', username: 'jun', name: 'Jun' });
    mirrorAgentPatch('test', 'a1', { model: 'claude-sonnet-4-6' }, mkAgent('a1', 'jun', { model: 'claude-sonnet-4-6' }));
    expect(s.getAgent('a1')!.model).toBe('claude-sonnet-4-6');
    expect(s.getAgent('a1')!.version).toBe(2);
  });

  it('ignores JSON-owned updates (status/credentials) — no store write', () => {
    s.createAgent('test', { id: 'a1', username: 'jun', name: 'Jun' });
    mirrorAgentPatch('test', 'a1',
      { status: 'paused', credentials: [{ type: 'github' }] } as unknown as Partial<AgentInfo>,
      mkAgent('a1', 'jun'));
    expect(s.getAgent('a1')!.version).toBe(1); // untouched
  });

  it('adopts an agent that predates the store using the post-merge row', () => {
    mirrorAgentPatch('test', 'a2', { model: 'gpt-5.3-codex' },
      mkAgent('a2', 'rei', { model: 'gpt-5.3-codex', role: 'Reviewer' }));
    const row = s.getAgent('a2');
    expect(row).toBeDefined();
    expect(row!.model).toBe('gpt-5.3-codex');
    expect(row!.role).toBe('Reviewer');
    expect(row!.username).toBe('rei');
    // active agents adopt as desired-enabled
    expect(row!.desired_enabled).toBe(1);
  });

  it('adopts a disabled agent as not desired-enabled', () => {
    mirrorAgentPatch('test', 'a3', { model: 'x' },
      mkAgent('a3', 'kei', { model: 'x', status: 'disabled' }));
    expect(s.getAgent('a3')!.desired_enabled).toBe(0);
  });

  it('applies successive patches in call order', () => {
    s.createAgent('test', { id: 'a1', username: 'jun', name: 'Jun' });
    mirrorAgentPatch('test', 'a1', { model: 'first' }, mkAgent('a1', 'jun', { model: 'first' }));
    mirrorAgentPatch('test', 'a1', { model: 'second' }, mkAgent('a1', 'jun', { model: 'second' }));
    expect(s.getAgent('a1')!.model).toBe('second');
    expect(s.getAgent('a1')!.version).toBe(3);
  });

  it('swallows store failures — never throws into the mutator', () => {
    s.close(); // closed DB → every store call throws internally
    expect(() => mirrorAgentPatch('test', 'a1', { model: 'x' }, mkAgent('a1', 'jun'))).not.toThrow();
    s = new AgentStateStore(':memory:'); // for afterEach close
    __setAgentStateStoreForTest(s);
  });

  it('is a no-op when the store is unavailable (null singleton)', () => {
    __setAgentStateStoreForTest(null);
    expect(() => mirrorAgentPatch('test', 'a1', { model: 'x' }, mkAgent('a1', 'jun'))).not.toThrow();
  });
});
