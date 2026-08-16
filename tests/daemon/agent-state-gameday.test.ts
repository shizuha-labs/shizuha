/**
 * PLAT-1062 P5 game-day probes.
 *
 * These tests pin the acceptance scenarios from the PLAT-1061 HLD after the P1–P4
 * implementation slices landed: serialized toggles, daemon restart persistence,
 * desired-enabled recovery, operator-disabled fail-closed stop, orphan
 * adoption/cleanup classification, and JSON-export rollback safety.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentStateStore } from '../../src/daemon/agent-state-store.js';
import { AgentStateReconciler, type AgentRuntimeController, type AgentRuntimeOrphan } from '../../src/daemon/agent-state-reconciler.js';
import type { AgentInfo } from '../../src/daemon/types.js';

const mkAgent = (id: string, username: string): AgentInfo => ({
  id,
  username,
  name: username,
  email: `${username}@shizuha.com`,
  role: 'Engineer',
  status: 'active',
  runtimeEnvironment: 'container',
  mcpServers: [],
  personalityTraits: {},
  skills: [],
});

describe('PLAT-1062 P5 — agent-state game-day probes', () => {
  it('serializes dashboard/MCP/CLI toggle intents with monotonic versions and no lost update', () => {
    const store = new AgentStateStore(':memory:');
    const row = store.createAgent('bootstrap', { id: 'agent-1', username: 'nagi', name: 'Nagi' });

    store.setDesiredEnabled('dashboard', row.id, true);
    store.setDesiredEnabled('mcp-toggle', row.id, false);
    const final = store.setDesiredEnabled('cli', row.id, true);

    expect(final.version).toBe(4);
    expect(final.desired_enabled).toBe(1);
    expect(store.listEvents(row.id).map((event) => event.event_type)).toEqual([
      'created', 'enabled', 'disabled', 'enabled',
    ]);
    store.close();
  });

  it('survives a daemon restart with desired state, observations, and audit events intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plat1062-gameday-'));
    const dbPath = path.join(dir, 'agent-state.sqlite');
    try {
      const first = new AgentStateStore(dbPath);
      first.createAgent('bootstrap', { id: 'agent-1', username: 'nagi', name: 'Nagi', desiredEnabled: true });
      first.recordObservation('agent-1', { observed_state: 'running', runtime_kind: 'docker', container_or_pod: 'shizuha-agent-nagi' });
      first.close();

      const afterRestart = new AgentStateStore(dbPath);
      expect(afterRestart.getAgent('agent-1')!.desired_enabled).toBe(1);
      expect(afterRestart.getObservation('agent-1')!.observed_state).toBe('running');
      expect(afterRestart.listEvents('agent-1').map((event) => event.event_type)).toContain('created');
      afterRestart.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a killed desired-enabled agent by starting it and recording convergence evidence', async () => {
    const store = new AgentStateStore(':memory:');
    store.createAgent('bootstrap', { id: 'agent-1', username: 'nagi', name: 'Nagi', desiredEnabled: true });
    const started: string[] = [];
    const controller: AgentRuntimeController = {
      observe: () => ({ observed_state: 'missing', runtime_kind: 'docker' }),
      start: (row) => {
        started.push(row.id);
        return { observed_state: 'running', runtime_kind: 'docker', container_or_pod: `shizuha-agent-${row.username}` };
      },
    };

    const report = await new AgentStateReconciler(store, controller, { mode: 'enforce', driftAlertCycles: 1 }).reconcileOnce();

    expect(started).toEqual(['agent-1']);
    expect(report.decisions[0]).toMatchObject({ action: 'start', acted: true, alerting: true });
    expect(store.getObservation('agent-1')!.observed_state).toBe('running');
    expect(store.listEvents('agent-1').map((event) => event.event_type)).toContain('started');
    store.close();
  });

  it('stops an operator-disabled running agent even when desired_enabled remains true', async () => {
    const store = new AgentStateStore(':memory:');
    store.createAgent('bootstrap', { id: 'agent-1', username: 'nagi', name: 'Nagi', desiredEnabled: true });
    store.setOperatorDisabled('operator', 'agent-1', true, 'game-day kill switch');
    const stopped: Array<{ id: string; reason: string }> = [];
    const controller: AgentRuntimeController = {
      observe: () => ({ observed_state: 'running', runtime_kind: 'docker', container_or_pod: 'shizuha-agent-nagi' }),
      stop: (row, reason) => {
        stopped.push({ id: row.id, reason });
        return { observed_state: 'stopped', runtime_kind: 'docker' };
      },
    };

    const report = await new AgentStateReconciler(store, controller, { mode: 'enforce' }).reconcileOnce();

    expect(store.getAgent('agent-1')!.desired_enabled).toBe(1);
    expect(store.getAgent('agent-1')!.operator_disabled).toBe(1);
    expect(stopped).toEqual([{ id: 'agent-1', reason: 'operator-disabled fail-closed' }]);
    expect(report.decisions[0]).toMatchObject({ desiredState: 'stopped', action: 'stop', acted: true });
    store.close();
  });

  it('adopts only verified same-daemon orphans and stops unknown/cross-daemon runtime objects', async () => {
    const store = new AgentStateStore(':memory:');
    const orphans: AgentRuntimeOrphan[] = [
      {
        runtimeId: 'pod-adopt', username: 'adoptme', observed_state: 'running', runtime_kind: 'k8s',
        ownership: 'owned_by_this_daemon', adoptionSpec: { id: 'agent-adopted', username: 'adoptme', name: 'Adopt Me', desiredEnabled: true },
      },
      { runtimeId: 'pod-unknown', username: 'unknown', observed_state: 'running', runtime_kind: 'k8s', ownership: 'unknown' },
      { runtimeId: 'pod-other', username: 'other', observed_state: 'running', runtime_kind: 'k8s', ownership: 'owned_by_other_daemon' },
    ];
    const stopped: string[] = [];
    const controller: AgentRuntimeController = {
      observe: () => ({ observed_state: 'missing', runtime_kind: 'k8s' }),
      listOrphans: () => orphans,
      stopOrphan: (orphan) => { stopped.push(orphan.runtimeId); },
    };

    const report = await new AgentStateReconciler(store, controller, { mode: 'enforce' }).reconcileOnce();

    expect(store.getAgent('agent-adopted')!.username).toBe('adoptme');
    expect(store.getObservation('agent-adopted')!.observed_state).toBe('running');
    expect(stopped.sort()).toEqual(['pod-other', 'pod-unknown']);
    expect(report.decisions.map((decision) => [decision.username, decision.action, decision.acted])).toEqual([
      ['adoptme', 'adopt', true],
      ['unknown', 'stop', true],
      ['other', 'stop', true],
    ]);
    store.close();
  });

  it('rollback export preserves secrets/keypair while retaining operator-disabled kill-switch evidence', () => {
    const store = new AgentStateStore(':memory:');
    const existing = {
      ...mkAgent('agent-1', 'nagi'),
      credentials: [{
        id: 'cred-1', grantId: 'grant-1', label: 'Pulse', scope: 'pulse' as const,
        credentialData: { token: 'keep-secret' }, injectAsEnv: true,
        envMapping: { token: 'PULSE_TOKEN' }, isActive: true,
      }],
      keypair: { publicKey: 'pub', privateKey: 'priv' },
    };

    store.importFromJson([existing], new Set(['agent-1']), new Set(['agent-1']));
    const exported = store.exportToJson()[0]!;
    const rollbackAgentsJson = store.exportMergedAgentsJson([existing])[0]!;

    expect(exported.desiredEnabled).toBe(false);
    expect(exported.operatorDisabled).toBe(true);
    expect(rollbackAgentsJson.credentials).toEqual(existing.credentials);
    expect(rollbackAgentsJson.keypair).toEqual(existing.keypair);
    expect(store.isEffectivelyEnabled('agent-1')).toBe(false);
    store.close();
  });
});
