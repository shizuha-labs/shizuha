/**
 * PLAT-1062 P1 — AgentStateStore unit tests.
 * Covers: version bump + audit trail, optimistic concurrency, INV-5
 * operator-disabled precedence, and the JSON migration conflict resolution.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentStateStore, StaleVersionError, UnknownAgentError } from '../../src/daemon/agent-state-store.js';
import { AgentStateReconciler } from '../../src/daemon/agent-state-reconciler.js';
import type { AgentInfo } from '../../src/daemon/types.js';

function store(): AgentStateStore {
  return new AgentStateStore(':memory:');
}

function mkAgent(id: string, username: string): AgentInfo {
  return {
    id, name: username, username, email: `${username}@shizuha.com`, role: 'Engineer',
    status: 'active', runtimeEnvironment: 'container', skills: ['a', 'b'],
    mcpServers: [], personalityTraits: {},
  } as AgentInfo;
}

describe('AgentStateStore — create + audit', () => {
  let s: AgentStateStore;
  beforeEach(() => { s = store(); });

  it('createAgent persists row at version 1 with a created event', () => {
    const row = s.createAgent('tester', { username: 'jun', name: 'Jun', skills: ['x'] });
    expect(row.version).toBe(1);
    expect(row.desired_enabled).toBe(0);
    expect(row.operator_disabled).toBe(0);
    expect(JSON.parse(row.skills_json)).toEqual(['x']);
    const events = s.listEvents(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]!['event_type']).toBe('created');
    expect(events[0]!['desired_version']).toBe(1);
  });

  it('listAgents / getByUsername return committed rows', () => {
    s.createAgent('t', { username: 'a', name: 'A' });
    s.createAgent('t', { username: 'b', name: 'B' });
    expect(s.listAgents().map((r) => r.username)).toEqual(['a', 'b']);
    expect(s.getByUsername('b')!.name).toBe('B');
  });
});

describe('AgentStateStore — mutations bump version + emit events', () => {
  let s: AgentStateStore;
  let id: string;
  beforeEach(() => { s = store(); id = s.createAgent('t', { username: 'jun', name: 'Jun' }).id; });

  it('updateAgent bumps version and records changed fields', () => {
    const r = s.updateAgent('t', id, { model: 'cortex/glm', team: 'eng' });
    expect(r.version).toBe(2);
    expect(r.model).toBe('cortex/glm');
    expect(r.team).toBe('eng');
    const last = s.listEvents(id).at(-1)!;
    expect(last['event_type']).toBe('updated');
    expect(JSON.parse(String(last['payload_json'])).fields.sort()).toEqual(['model', 'team']);
  });

  it('sequential toggles serialize — version increments monotonically, no lost update', () => {
    s.setDesiredEnabled('t', id, true);
    s.setDesiredEnabled('t', id, false);
    const r = s.setDesiredEnabled('t', id, true);
    expect(r.version).toBe(4); // create(1) + 3 toggles
    expect(r.desired_enabled).toBe(1);
    expect(s.listEvents(id).map((e) => e['event_type'])).toEqual(['created', 'enabled', 'disabled', 'enabled']);
  });

  it('optimistic concurrency: stale expectedVersion throws StaleVersionError', () => {
    s.updateAgent('t', id, { name: 'Jun2' }); // -> v2
    expect(() => s.updateAgent('t', id, { name: 'Jun3' }, 1)).toThrow(StaleVersionError);
    // correct version succeeds
    expect(s.updateAgent('t', id, { name: 'Jun3' }, 2).name).toBe('Jun3');
  });

  it('unknown agent mutations throw UnknownAgentError', () => {
    expect(() => s.updateAgent('t', 'nope', { name: 'x' })).toThrow(UnknownAgentError);
    expect(() => s.setOperatorDisabled('t', 'nope', true)).toThrow(UnknownAgentError);
  });
});

describe('AgentStateStore — INV-5 operator-disabled precedence', () => {
  let s: AgentStateStore;
  let id: string;
  beforeEach(() => { s = store(); id = s.createAgent('t', { username: 'jun', name: 'Jun' }).id; });

  it('operator-disabled agent is never effectively-enabled, even when desired_enabled=1', () => {
    s.setDesiredEnabled('t', id, true);
    expect(s.isEffectivelyEnabled(id)).toBe(true);
    s.setOperatorDisabled('op', id, true, 'abuse');
    expect(s.getAgent(id)!.desired_enabled).toBe(1); // user intent preserved
    expect(s.isEffectivelyEnabled(id)).toBe(false);  // but kill-switch wins
  });

  it('plain setDesiredEnabled(true) does NOT clear an operator kill-switch', () => {
    s.setOperatorDisabled('op', id, true);
    s.setDesiredEnabled('user', id, true);
    expect(s.getAgent(id)!.operator_disabled).toBe(1);
    expect(s.isEffectivelyEnabled(id)).toBe(false);
  });

  it('overrideKillSwitch clears operator_disabled and re-enables', () => {
    s.setOperatorDisabled('op', id, true);
    const r = s.setDesiredEnabled('op', id, true, { overrideKillSwitch: true });
    expect(r.operator_disabled).toBe(0);
    expect(s.isEffectivelyEnabled(id)).toBe(true);
  });
});

describe('AgentStateStore — JSON migration import/export', () => {
  let s: AgentStateStore;
  beforeEach(() => { s = store(); });

  it('imports agents.json; operator-disabled wins over enabled on conflict', () => {
    const agents = [
      { ...mkAgent('id-a', 'alice'), model: 'cortex/glm' },
      mkAgent('id-b', 'bob'),
      mkAgent('id-c', 'carol'),
    ];
    const enabled = new Set(['id-a', 'id-b']);
    const disabled = new Set(['id-b']); // bob is both enabled AND operator-disabled -> disabled wins
    const { imported, orphanFlags } = s.importFromJson(agents, enabled, disabled);
    expect(imported).toBe(3);
    expect(orphanFlags).toEqual([]);
    expect(s.isEffectivelyEnabled('id-a')).toBe(true);
    expect(s.getAgent('id-a')!.model).toBe('cortex/glm');
    expect(s.getAgent('id-b')!.operator_disabled).toBe(1);
    expect(s.isEffectivelyEnabled('id-b')).toBe(false);
    expect(s.isEffectivelyEnabled('id-c')).toBe(false); // not in enabled set
  });

  it('reports flags that reference no known agent as orphans', () => {
    const { orphanFlags } = s.importFromJson([mkAgent('id-a', 'alice')], new Set(['ghost']), new Set());
    expect(orphanFlags).toContain('ghost');
  });

  it('is idempotent — re-import does not duplicate rows', () => {
    const agents = [mkAgent('id-a', 'alice')];
    s.importFromJson(agents, new Set(['id-a']), new Set());
    s.importFromJson(agents, new Set(['id-a']), new Set());
    expect(s.listAgents()).toHaveLength(1);
    expect(s.isEffectivelyEnabled('id-a')).toBe(true);
  });

  it('rekeys username-matched rows when agents.json changes the agent id', () => {
    const oldId = 'local-lina-mr53slts';
    const newId = 'f670991c-1432-51d2-99f2-627b6d3ce777';
    s.createAgent('seed', { id: oldId, username: 'lina', name: 'Lina', desiredEnabled: true });
    s.recordObservation(oldId, {
      observed_state: 'running',
      runtime_kind: 'docker',
      container_or_pod: 'shizuha-agent-lina',
    });

    const result = s.importFromJson(
      [mkAgent(newId, 'lina')],
      new Set([newId]),
      new Set(),
      'readAgents-cutover',
    );

    expect(result.imported).toBe(1);
    expect(s.getAgent(oldId)).toBeUndefined();
    expect(s.getAgent(newId)).toMatchObject({ username: 'lina', desired_enabled: 1, operator_disabled: 0 });
    expect(s.getByUsername('lina')!.id).toBe(newId);
    expect(s.getObservation(newId)).toMatchObject({
      observed_state: 'running',
      runtime_kind: 'docker',
      container_or_pod: 'shizuha-agent-lina',
    });
    expect(s.getObservation(oldId)).toBeUndefined();
    expect(s.listEvents(newId).map((event) => event['event_type'])).toEqual(['created', 'updated']);
    expect(JSON.parse(String(s.listEvents(newId).at(-1)!['payload_json']))).toMatchObject({
      previousId: oldId,
      username: 'lina',
    });
    expect(s.exportMergedAgentsJson([mkAgent(newId, 'lina')])[0]!.id).toBe(newId);
  });

  it('exportMergedAgentsJson overlays DB fields but preserves agents.json secrets, keypair, and status', () => {
    const existing = {
      ...mkAgent('id-a', 'alice'),
      status: 'paused' as const,
      model: 'old-model',
      modelFallbacks: [{ method: 'claude_code_server', model: 'old-model' }],
      modelOverrides: { claude_code_server: 'old-model' },
      env: { OLD_ENV: '1' },
      credentials: [{
        id: 'cred-1', grantId: 'grant-1', label: 'GitHub', scope: 'github' as const,
        credentialData: { token: 'secret-token' }, injectAsEnv: true,
        envMapping: { token: 'GITHUB_TOKEN' }, isActive: true,
      }],
      keypair: { publicKey: 'pub', privateKey: 'priv' },
      mcpServers: [{ name: 'Pulse', slug: 'pulse', command: 'pulse', args: [], env: {}, transportType: 'stdio' }],
      personalityTraits: { style: 'careful' },
    };

    s.createAgent('t', {
      id: 'id-a', username: 'alice', name: 'Alice Updated', email: 'alice2@shizuha.com',
      role: 'Senior Engineer', team: 'platform', runtimeEnvironment: 'k8s', executionMethod: 'codex_app_server',
      model: 'gpt-5.5', modelFallbacks: [{ method: 'codex_app_server', model: 'gpt-5.5' }],
      modelOverrides: { codex_app_server: 'gpt-5.5' }, skills: ['new-skill'], env: { NEW_ENV: '2' },
      resourceLimits: { memory: '2g' }, desiredEnabled: true,
    });

    const [merged] = s.exportMergedAgentsJson([existing]);
    expect(merged!.name).toBe('Alice Updated');
    expect(merged!.email).toBe('alice2@shizuha.com');
    expect(merged!.role).toBe('Senior Engineer');
    expect(merged!.team).toBe('platform');
    expect(merged!.runtimeEnvironment).toBe('k8s');
    expect(merged!.executionMethod).toBe('codex_app_server');
    expect(merged!.model).toBe('gpt-5.5');
    expect(merged!.modelFallbacks).toEqual([{ method: 'codex_app_server', model: 'gpt-5.5' }]);
    expect(merged!.modelOverrides).toEqual({ codex_app_server: 'gpt-5.5' });
    expect(merged!.skills).toEqual(['new-skill']);
    expect(merged!.env).toEqual({ NEW_ENV: '2' });
    expect(merged!.resourceLimits).toEqual({ memory: '2g' });

    expect(merged!.status).toBe('paused');
    expect(merged!.credentials).toEqual(existing.credentials);
    expect(merged!.keypair).toEqual(existing.keypair);
    expect(merged!.mcpServers).toEqual(existing.mcpServers);
    expect(merged!.personalityTraits).toEqual(existing.personalityTraits);
  });


  it('exportMergedAgentsJson preserves existing agents absent from the DB and appends DB-only agents', () => {
    const existingOnly = {
      ...mkAgent('id-existing-only', 'existing-only'),
      credentials: [{
        id: 'cred-existing', grantId: 'grant-existing', label: 'GitHub', scope: 'github' as const,
        credentialData: { token: 'keep-me' }, injectAsEnv: true,
        envMapping: { token: 'GITHUB_TOKEN' }, isActive: true,
      }],
      keypair: { publicKey: 'existing-pub', privateKey: 'existing-priv' },
    };
    const matched = {
      ...mkAgent('id-matched', 'matched'),
      credentials: [{
        id: 'cred-matched', grantId: 'grant-matched', label: 'Pulse', scope: 'pulse' as const,
        credentialData: { token: 'matched-secret' }, injectAsEnv: true,
        envMapping: { token: 'PULSE_TOKEN' }, isActive: true,
      }],
      keypair: { publicKey: 'matched-pub', privateKey: 'matched-priv' },
    };

    s.createAgent('t', { id: 'id-matched', username: 'matched', name: 'Matched Updated', skills: ['db-skill'] });
    s.createAgent('t', { id: 'id-db-only', username: 'db-only', name: 'DB Only', skills: ['new'] });

    const merged = s.exportMergedAgentsJson([existingOnly, matched]);

    expect(merged.map((agent) => agent.id)).toEqual(['id-existing-only', 'id-matched', 'id-db-only']);
    expect(merged[0]).toEqual(existingOnly);
    expect(merged[0]!.credentials).toEqual(existingOnly.credentials);
    expect(merged[0]!.keypair).toEqual(existingOnly.keypair);
    expect(merged[1]!.name).toBe('Matched Updated');
    expect(merged[1]!.credentials).toEqual(matched.credentials);
    expect(merged[1]!.keypair).toEqual(matched.keypair);
    expect(merged[2]).toMatchObject({ id: 'id-db-only', username: 'db-only', name: 'DB Only', status: 'disabled' });
  });

  it('exportToJson round-trips core fields + desired/operator flags', () => {
    s.createAgent('t', { id: 'id-a', username: 'alice', name: 'Alice', model: 'cortex/glm', skills: ['s1'], desiredEnabled: true });
    s.setOperatorDisabled('op', 'id-a', true);
    const out = s.exportToJson();
    expect(out).toHaveLength(1);
    expect(out[0]!.username).toBe('alice');
    expect(out[0]!.skills).toEqual(['s1']);
    expect(out[0]!.model).toBe('cortex/glm');
    expect(out[0]!.desiredEnabled).toBe(true);
    expect(out[0]!.operatorDisabled).toBe(true);
  });
});

describe('AgentStateStore — observations + delete cascade', () => {
  let s: AgentStateStore;
  let id: string;
  beforeEach(() => { s = store(); id = s.createAgent('t', { username: 'jun', name: 'Jun' }).id; });

  it('recordObservation upserts the actual-state row', () => {
    s.recordObservation(id, { observed_state: 'running', runtime_kind: 'docker', container_or_pod: 'shizuha-agent-jun', pid: 123 });
    s.recordObservation(id, { observed_state: 'stopped', runtime_kind: 'docker' });
    // second call updates, not duplicates (PK = agent_id)
    expect(s.isEffectivelyEnabled(id)).toBe(false);
  });

  it('deleteAgent removes the row + emits a deleted event and cascades observations', () => {
    s.recordObservation(id, { observed_state: 'running', runtime_kind: 'docker' });
    s.deleteAgent('t', id);
    expect(s.getAgent(id)).toBeUndefined();
    expect(s.listEvents(id).at(-1)!['event_type']).toBe('deleted');
  });
});

describe('AgentStateReconciler — P3 observe/enforce loop', () => {
  let s: AgentStateStore;
  beforeEach(() => { s = store(); });

  it('observe mode records drift but does not mutate actual runtime', async () => {
    const row = s.createAgent('t', { id: 'id-a', username: 'alice', name: 'Alice', desiredEnabled: true });
    const starts: string[] = [];
    const samples: unknown[] = [];
    const reconciler = new AgentStateReconciler(s, {
      observe: () => ({ observed_state: 'stopped', runtime_kind: 'docker' }),
      start: (agent) => {
        starts.push(agent.id);
        return { observed_state: 'running', runtime_kind: 'docker' };
      },
    }, { mode: 'observe', driftAlertCycles: 2, onDriftMetric: (sample) => samples.push(sample) });

    const first = await reconciler.reconcileOnce();
    const second = await reconciler.reconcileOnce();

    expect(first).toMatchObject({ checked: 1, drifted: 1, actions: 0 });
    expect(second.alerts).toHaveLength(1);
    expect(starts).toEqual([]);
    expect(samples).toHaveLength(2);
    expect(s.getObservation(row.id)!.observed_state).toBe('stopped');
    expect(s.listEvents(row.id).map((e) => e['event_type'])).toEqual(['created', 'drift', 'drift']);
  });

  it('enforce mode starts a desired-enabled missing runtime and records audit events', async () => {
    const row = s.createAgent('t', { id: 'id-a', username: 'alice', name: 'Alice', desiredEnabled: true });
    const actions: string[] = [];
    const reconciler = new AgentStateReconciler(s, {
      observe: () => ({ observed_state: 'not_found', runtime_kind: 'docker' }),
      start: (agent) => {
        actions.push(`start:${agent.username}`);
        return { observed_state: 'running', runtime_kind: 'docker', container_or_pod: `shizuha-agent-${agent.username}` };
      },
    }, { mode: 'enforce' });

    const report = await reconciler.reconcileOnce();

    expect(report).toMatchObject({ checked: 1, drifted: 1, actions: 1 });
    expect(report.decisions[0]).toMatchObject({ action: 'start', acted: true, reason: 'desired-enabled runtime missing/unhealthy' });
    expect(actions).toEqual(['start:alice']);
    expect(s.getObservation(row.id)).toMatchObject({ observed_state: 'running', container_or_pod: 'shizuha-agent-alice' });
    expect(s.listEvents(row.id).map((e) => e['event_type'])).toEqual(['created', 'drift', 'started']);
  });

  it('enforce mode stops operator-disabled runtimes fail-closed', async () => {
    const row = s.createAgent('t', { id: 'id-a', username: 'alice', name: 'Alice', desiredEnabled: true, operatorDisabled: true });
    const stops: Array<{ username: string; reason: string }> = [];
    const reconciler = new AgentStateReconciler(s, {
      observe: () => ({ observed_state: 'running', runtime_kind: 'k8s', container_or_pod: 'alice-pod' }),
      stop: (agent, reason) => {
        stops.push({ username: agent.username, reason });
        return { observed_state: 'stopped', runtime_kind: 'k8s' };
      },
    }, { mode: 'enforce' });

    const report = await reconciler.reconcileOnce();

    expect(report.decisions[0]).toMatchObject({ desiredState: 'stopped', action: 'stop', acted: true, reason: 'operator-disabled fail-closed' });
    expect(stops).toEqual([{ username: 'alice', reason: 'operator-disabled fail-closed' }]);
    expect(s.isEffectivelyEnabled(row.id)).toBe(false);
    expect(s.getObservation(row.id)!.observed_state).toBe('stopped');
  });

  it('treats crash/error states as drift for desired-enabled agents', async () => {
    s.createAgent('t', { id: 'id-a', username: 'alice', name: 'Alice', desiredEnabled: true });
    const reconciler = new AgentStateReconciler(s, {
      observe: () => ({ observed_state: 'CrashLoopBackOff', runtime_kind: 'k8s', container_or_pod: 'alice-pod' }),
      start: () => ({ observed_state: 'running', runtime_kind: 'k8s', container_or_pod: 'alice-pod' }),
    }, { mode: 'enforce' });

    const report = await reconciler.reconcileOnce();

    expect(report.decisions[0]).toMatchObject({ desiredState: 'running', action: 'start', acted: true });
    expect(report.drifted).toBe(1);
  });

  it('matching actual state resets drift cycles and records reconciled', async () => {
    const row = s.createAgent('t', { id: 'id-a', username: 'alice', name: 'Alice', desiredEnabled: true });
    const states = ['stopped', 'running'];
    const reconciler = new AgentStateReconciler(s, {
      observe: () => ({ observed_state: states.shift() ?? 'running', runtime_kind: 'docker' }),
    }, { mode: 'observe' });

    await reconciler.reconcileOnce();
    const report = await reconciler.reconcileOnce();

    expect(report.decisions[0]).toMatchObject({ action: 'none', driftCycles: 0, alerting: false });
    expect(s.getObservation(row.id)!.observed_state).toBe('running');
    expect(s.listEvents(row.id).map((e) => e['event_type'])).toEqual(['created', 'drift', 'reconciled']);
  });

  it('observe mode reports adoptable orphans without mutating desired state', async () => {
    const reconciler = new AgentStateReconciler(s, {
      observe: () => ({ observed_state: 'not_found', runtime_kind: 'docker' }),
      listOrphans: () => [{
        runtimeId: 'runtime-alice',
        username: 'alice',
        observed_state: 'running',
        runtime_kind: 'docker',
        container_or_pod: 'shizuha-agent-alice',
        ownership: 'owned_by_this_daemon',
        adoptionSpec: {
          id: 'id-alice',
          username: 'alice',
          name: 'Alice',
          runtimeEnvironment: 'container',
          desiredEnabled: true,
        },
      }],
    }, { mode: 'observe' });

    const report = await reconciler.reconcileOnce();

    expect(report).toMatchObject({ checked: 1, drifted: 1, actions: 0 });
    expect(report.decisions[0]).toMatchObject({
      orphan: true,
      agentId: 'runtime-alice',
      username: 'alice',
      action: 'adopt',
      acted: false,
      desiredState: 'running',
    });
    expect(s.listAgents()).toEqual([]);
  });

  it('enforce mode adopts only orphans with verified ownership metadata and an adoption spec', async () => {
    const stops: string[] = [];
    const reconciler = new AgentStateReconciler(s, {
      observe: () => ({ observed_state: 'not_found', runtime_kind: 'docker' }),
      listOrphans: () => [{
        runtimeId: 'runtime-alice',
        username: 'alice',
        observed_state: 'running',
        runtime_kind: 'docker',
        container_or_pod: 'shizuha-agent-alice',
        ownership: 'owned_by_this_daemon',
        adoptionSpec: {
          id: 'id-alice',
          username: 'alice',
          name: 'Alice',
          runtimeEnvironment: 'container',
          desiredEnabled: true,
          skills: ['engineering-core'],
        },
      }],
      stopOrphan: (orphan) => { stops.push(orphan.runtimeId); },
    }, { mode: 'enforce' });

    const report = await reconciler.reconcileOnce();

    expect(report).toMatchObject({ checked: 1, drifted: 1, actions: 1 });
    expect(report.decisions[0]).toMatchObject({
      orphan: true,
      agentId: 'id-alice',
      username: 'alice',
      action: 'adopt',
      acted: true,
      desiredState: 'running',
    });
    expect(stops).toEqual([]);
    expect(s.getAgent('id-alice')).toMatchObject({ username: 'alice', desired_enabled: 1 });
    expect(s.getObservation('id-alice')).toMatchObject({
      observed_state: 'running',
      runtime_kind: 'docker',
      container_or_pod: 'shizuha-agent-alice',
    });
    expect(s.listEvents('id-alice').map((e) => e['event_type'])).toEqual(['created']);
  });

  it('enforce mode stops unknown or cross-daemon orphans instead of inventing desired rows', async () => {
    const stopped: Array<{ runtimeId: string; reason: string }> = [];
    const reconciler = new AgentStateReconciler(s, {
      observe: () => ({ observed_state: 'not_found', runtime_kind: 'docker' }),
      listOrphans: () => [
        {
          runtimeId: 'runtime-unknown',
          username: 'unknown',
          observed_state: 'running',
          runtime_kind: 'docker',
          ownership: 'unknown',
        },
        {
          runtimeId: 'runtime-other',
          username: 'other',
          observed_state: 'CrashLoopBackOff',
          runtime_kind: 'k8s',
          container_or_pod: 'other-pod',
          ownership: 'owned_by_other_daemon',
        },
        {
          runtimeId: 'runtime-no-spec',
          username: 'no-spec',
          observed_state: 'running',
          runtime_kind: 'docker',
          ownership: 'owned_by_this_daemon',
        },
      ],
      stopOrphan: (orphan, reason) => {
        stopped.push({ runtimeId: orphan.runtimeId, reason });
      },
    }, { mode: 'enforce' });

    const report = await reconciler.reconcileOnce();

    expect(report).toMatchObject({ checked: 3, drifted: 3, actions: 3 });
    expect(report.decisions.map((d) => [d.agentId, d.action, d.acted])).toEqual([
      ['runtime-unknown', 'stop', true],
      ['runtime-other', 'stop', true],
      ['runtime-no-spec', 'stop', true],
    ]);
    expect(stopped).toEqual([
      { runtimeId: 'runtime-unknown', reason: 'orphan runtime lacks verified ownership metadata' },
      { runtimeId: 'runtime-other', reason: 'orphan runtime belongs to another daemon/control plane' },
      { runtimeId: 'runtime-no-spec', reason: 'orphan runtime lacks verified ownership metadata' },
    ]);
    expect(s.listAgents()).toEqual([]);
  });
});
