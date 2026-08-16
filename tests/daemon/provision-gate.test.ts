import { describe, it, expect } from 'vitest';
import {
  decideProvision,
  ProvisionOpStore,
  buildIdentityEvent,
  buildStateDelta,
} from '../../src/daemon/provision-gate.js';
import type { AgentIdentity } from '../../src/daemon/agent-identity.js';

// HIVE-247 §5.2 — the provision gate hard-rejects EXPLICIT §4.2 (a)-(d) violations
// before materialize, stays lenient-on-unknown for rollout safety, and is
// idempotent on op_id so a retried provision never double-materializes.

const base: AgentIdentity = { userId: 42, isStaff: false, isSuperuser: false };

describe('decideProvision (HIVE-247)', () => {
  it('admits a canonical, active, account_type=agent identity', () => {
    const d = decideProvision({ username: 'kai' }, { ...base, isActive: true, accountType: 'agent' });
    expect(d.admit).toBe(true);
    expect(d.httpStatus).toBe(201); // admit is a creation -> 201, same fresh + replay (P3)
    expect(d.reasons).toEqual([]);
  });

  it('rejects (403) when there is no canonical Shizuha-ID (userId<=0)', () => {
    const d = decideProvision({ username: 'orphan' }, { ...base, userId: 0 });
    expect(d.admit).toBe(false);
    expect(d.httpStatus).toBe(403);
    expect(d.reasons).toContain('no-canonical-shizuha-id');
  });

  it('rejects (403) an explicitly inactive identity', () => {
    const d = decideProvision({ username: 'gone' }, { ...base, isActive: false });
    expect(d.admit).toBe(false);
    expect(d.reasons).toContain('inactive');
  });

  it('rejects (403) an explicit non-agent account_type (e.g. human)', () => {
    const d = decideProvision({ username: 'person' }, { ...base, accountType: 'human' });
    expect(d.admit).toBe(false);
    expect(d.reasons).toContain('account_type=human');
  });

  it('LENIENT-ON-UNKNOWN: undefined account_type/is_active still admit (rollout safety)', () => {
    // Pre-phase-1 ID-API: account_type/is_active absent -> must NOT hard-reject.
    const d = decideProvision({ username: 'rollout' }, { ...base });
    expect(d.admit).toBe(true);
    expect(d.httpStatus).toBe(201);
  });
});

describe('ProvisionOpStore idempotency (HIVE-247)', () => {
  it('returns undefined for an unseen op_id, then replays the recorded decision as duplicate', () => {
    const store = new ProvisionOpStore();
    expect(store.get('op-1')).toBeUndefined();
    const decision = decideProvision({ username: 'kai' }, { ...base, accountType: 'agent' });
    store.record('op-1', decision);
    const replay = store.get('op-1');
    expect(replay).toBeDefined();
    expect(replay!.admit).toBe(true);
    expect(replay!.duplicate).toBe(true); // a retry is flagged, not re-materialized
  });

  it('P2: an admit replay returns the materialized agent_id (Hive recovers it after losing the 201)', () => {
    const store = new ProvisionOpStore();
    const decision = decideProvision({ username: 'kai' }, { ...base, accountType: 'agent' });
    decision.agentId = 'local-kai-abc'; // route sets this after createLocalAgentAtRuntime
    store.record('op-5', decision);
    const replay = store.get('op-5');
    expect(replay!.admit).toBe(true);
    expect(replay!.duplicate).toBe(true);
    expect(replay!.httpStatus).toBe(201);          // P3: matches the fresh 201, not 200
    expect(replay!.agentId).toBe('local-kai-abc');  // P2: agent_id survives the replay
  });

  it('replays a rejection too (a retried bad provision stays rejected, never materializes)', () => {
    const store = new ProvisionOpStore();
    const reject = decideProvision({ username: 'gone' }, { ...base, isActive: false });
    store.record('op-2', reject);
    const replay = store.get('op-2');
    expect(replay!.admit).toBe(false);
    expect(replay!.httpStatus).toBe(403);
    expect(replay!.duplicate).toBe(true);
  });

  it('expires entries past TTL (injected clock) and reaps them', () => {
    let t = 1000;
    const store = new ProvisionOpStore(100, () => t);
    store.record('op-3', decideProvision({ username: 'kai' }, base));
    t = 1150; // > ttl
    expect(store.get('op-3')).toBeUndefined();
    store.record('op-4', decideProvision({ username: 'kai' }, base));
    t = 2000;
    expect(store.reap()).toBe(1);
    expect(store.size).toBe(0);
  });
});

describe('event builders (HIVE-247)', () => {
  it('buildIdentityEvent reflects admit/reject outcome + reasons', () => {
    const admit = buildIdentityEvent('kai', decideProvision({ username: 'kai' }, { ...base, accountType: 'agent' }), 'op-1', 111);
    expect(admit).toMatchObject({ type: 'identity_event', outcome: 'admitted', username: 'kai', reasons: [], opId: 'op-1', ts: 111 });
    const reject = buildIdentityEvent('gone', decideProvision({ username: 'gone' }, { ...base, isActive: false }), 'op-2', 222);
    expect(reject.outcome).toBe('rejected');
    expect(reject.reasons).toContain('inactive');
  });

  it('buildStateDelta marks an added agent', () => {
    expect(buildStateDelta('local-kai-abc', 'kai', 'op-1', 333)).toEqual({
      type: 'state_delta', op: 'added', agentId: 'local-kai-abc', username: 'kai', opId: 'op-1', ts: 333,
    });
  });
});
