import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateStore, type ToolAttemptIdentity } from '../../src/state/store.js';
import type { Message } from '../../src/agent/types.js';

let directory: string;
let store: StateStore;
let identity: ToolAttemptIdentity;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'tool-attempts-'));
  store = new StateStore(path.join(directory, 'state.db'));
  store.createSessionWithId('session', 'model', directory);
  identity = { sessionId: 'session', generation: 'turn-1', ownerId: 'owner-1', inboundMessageId: 'inbound', executionId: 'thread', sessionEpoch: 0 };
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true }); });
const outcome = (toolUseId = 'call') => ({ toolUseId, content: 'actual result', durationMs: 17 });
const pair = (): Message[] => [
  { id: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'write', input: { path: 'receipt' } }], timestamp: 1 },
  { id: 'results', role: 'user', content: [{ type: 'tool_result', ...outcome() }], timestamp: 2 },
];

describe('durable tool attempts', () => {
  it('uses FULL WAL commits for checkpoints without changing ordinary session durability', () => {
    expect((store as any).db.pragma('journal_mode', { simple: true })).toBe('wal');
    const original = (store as any).ensureToolTurn.bind(store);
    vi.spyOn(store as any, 'ensureToolTurn').mockImplementation((...args: unknown[]) => {
      expect((store as any).db.pragma('synchronous', { simple: true })).toBe(2);
      return original(...args);
    });
    const previous = (store as any).db.pragma('synchronous', { simple: true });
    store.beginToolAttempt(identity, 'call', 'write', {}, 1);
    store.completeToolAttempt(identity, 'call', 1, outcome());
    expect((store as any).db.pragma('synchronous', { simple: true })).toBe(previous);
    expect(() => (store as any).db.transaction(() => store.beginToolAttempt(identity, 'nested', 'write', {}, 1))()).toThrow('own its commit boundary');
  });
  it('binds exact input, inbound, owner, session epoch and individual retries', () => {
    store.beginToolAttempt(identity, 'call', 'write', { path: 'receipt' }, 1);
    expect(() => store.beginToolAttempt(identity, 'call', 'write', {}, 1)).toThrow();
    expect(() => store.completeToolAttempt({ ...identity, ownerId: 'other' }, 'call', 1, outcome())).toThrow();
    expect(() => store.completeToolAttempt({ ...identity, inboundMessageId: 'other' }, 'call', 1, outcome())).toThrow();
    expect(() => store.completeToolAttempt({ ...identity, sessionEpoch: 1 }, 'call', 1, outcome())).toThrow();
    store.completeToolAttempt(identity, 'call', 1, { ...outcome(), isError: true });
    store.beginToolAttempt(identity, 'call', 'write', { path: 'receipt' }, 2);
    store.completeToolAttempt(identity, 'call', 2, outcome());
    store.completeToolAttempt(identity, 'call', 2, outcome());
    expect(() => store.completeToolAttempt(identity, 'call', 2, { ...outcome(), content: 'different' })).toThrow();
    const recovered = store.recoverToolTurns('session', 'owner-2', 0);
    expect(JSON.stringify(recovered)).toContain('receipt');
    expect(recovered[1]!.content).toHaveLength(1);
    expect(recovered[1]!.content).toEqual([expect.objectContaining({ content: expect.stringContaining('earlier attempts may also have produced side effects.\nactual result'), isError: undefined })]);
  });

  it('recovers completed batch members and honest unknown outcomes across two reopen cycles', () => {
    for (const cycle of [1, 2]) {
      const current = { ...identity, generation: `turn-${cycle}`, ownerId: `owner-${cycle}` };
      store.beginToolAttempt(current, `done-${cycle}`, 'write', { cycle }, 1);
      store.completeToolAttempt(current, `done-${cycle}`, 1, outcome(`done-${cycle}`));
      store.beginToolAttempt(current, `pending-${cycle}`, 'write', { cycle }, 1);
      store.close();
      store = new StateStore(path.join(directory, 'state.db'));
      const recovered = store.recoverToolTurns('session', `owner-${cycle + 1}`, 0);
      expect(recovered).toHaveLength(2);
      expect(recovered[1]!.content).toEqual([
        expect.objectContaining({ toolUseId: `done-${cycle}`, content: 'actual result' }),
        expect.objectContaining({ toolUseId: `pending-${cycle}`, isError: true, content: expect.stringContaining('Outcome is unknown; side effects may have occurred') }),
      ]);
      expect(store.recoverToolTurns('session', `owner-${cycle + 1}`, 0)).toEqual([]);
      expect(() => store.completeToolAttempt(current, `pending-${cycle}`, 1, outcome(`pending-${cycle}`))).toThrow();
    }
    expect(store.loadSession('session')!.messages).toHaveLength(4);
  });

  it('atomically finalizes results/history and rolls back both on append failure', () => {
    store.beginToolAttempt(identity, 'call', 'write', { path: 'receipt' }, 1);
    store.completeToolAttempt(identity, 'call', 1, outcome());
    const original = store.appendMessage.bind(store);
    const append = vi.spyOn(store, 'appendMessage').mockImplementation((session, message) => {
      original(session, message);
      if (message.role === 'user') throw new Error('simulated commit failure');
    });
    expect(() => store.finalizeToolTurn(identity, pair())).toThrow('simulated commit failure');
    expect(store.loadSession('session')!.messages).toEqual([]);
    append.mockRestore();
    expect(store.finalizeToolTurn(identity, pair())).toHaveLength(2);
    expect(store.finalizeToolTurn(identity, pair())).toEqual([]);
    expect(store.recoverToolTurns('session', 'new-owner', 0)).toEqual([]);
    expect(store.loadSession('session')!.messages).toHaveLength(2);
  });

  it('does not lose executed streamed calls omitted by a truncated provider response', () => {
    store.beginToolAttempt(identity, 'call', 'read', { path: 'receipt' }, 1);
    const persisted = store.finalizeToolTurn(identity, [{ role: 'assistant', content: 'partial', timestamp: 1 }]);
    expect(persisted).toHaveLength(3);
    expect(JSON.stringify(persisted)).toContain('Outcome is unknown');
    expect(() => store.completeToolAttempt(identity, 'call', 1, outcome())).toThrow();
  });

  it('does not recover into a different epoch or resurrect a deleted session', () => {
    store.beginToolAttempt(identity, 'call', 'write', {}, 1);
    expect(store.recoverToolTurns('session', 'owner-2', 1)).toEqual([]);
    store.deleteSession('session');
    store.createSessionWithId('session', 'model', directory);
    expect(store.recoverToolTurns('session', 'owner-2', 0)).toEqual([]);
  });

  it('keeps the existing oversized-image persistence contract during recovery', () => {
    store.beginToolAttempt(identity, 'call', 'read', {}, 1);
    store.completeToolAttempt(identity, 'call', 1, { ...outcome(), image: { base64: 'x'.repeat(128 * 1024 + 1), mediaType: 'image/png' } });
    const recovered = store.recoverToolTurns('session', 'new-owner', 0);
    expect(recovered[1]!.content).toEqual([expect.objectContaining({ content: expect.stringContaining('Image omitted from session history') })]);
    expect(JSON.stringify(recovered)).not.toContain('"base64"');
  });

  it('reuses only exact prior-inbound heartbeat receipts, never a new inbound or provider intent', () => {
    const heartbeat = { ...identity, generation: 'heartbeat:receipt' };
    store.beginToolAttempt(heartbeat, 'call', 'work', {}, 1);
    store.completeToolAttempt(heartbeat, 'call', 1, outcome());
    store.finalizeToolTurn(heartbeat, []);
    const successor = { ...identity, ownerId: 'new-owner' };
    expect(store.recoveredHeartbeatTool(successor, 'work', {})).toEqual(outcome());
    expect(store.recoveredHeartbeatTool(identity, 'work', {})).toBeNull();
    for (const changed of [{ inboundMessageId: 'new' }, { executionId: 'new' }, { sessionEpoch: 1 }]) {
      expect(store.recoveredHeartbeatTool({ ...successor, ...changed }, 'work', {})).toBeNull();
    }
    expect(store.recoveredHeartbeatTool(successor, 'other', {})).toBeNull();
    expect(store.recoveredHeartbeatTool(successor, 'work', { other: true })).toBeNull();
  });
});
