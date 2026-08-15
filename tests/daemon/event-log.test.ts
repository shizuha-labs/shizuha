import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventLog, isDurableEvent } from '../../src/daemon/event-log.js';

describe('EventLog', () => {
  let tmpDir: string;
  let dbPath: string;
  let log: EventLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-eventlog-test-'));
    dbPath = path.join(tmpDir, 'test-events.db');
    log = new EventLog(dbPath);
  });

  afterEach(() => {
    log.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('append', () => {
    it('returns a monotonically increasing sequence number', () => {
      const seq1 = log.append('agent-1', { type: 'content', data: { delta: 'hello' } });
      const seq2 = log.append('agent-1', { type: 'content', data: { delta: ' world' } });
      const seq3 = log.append('agent-1', { type: 'complete', data: {} });
      expect(seq1).toBeLessThan(seq2);
      expect(seq2).toBeLessThan(seq3);
    });

    it('assigns globally unique sequence numbers across agents', () => {
      const seq1 = log.append('agent-1', { type: 'content', data: { delta: 'a' } });
      const seq2 = log.append('agent-2', { type: 'content', data: { delta: 'b' } });
      const seq3 = log.append('agent-1', { type: 'content', data: { delta: 'c' } });
      expect(seq2).toBeGreaterThan(seq1);
      expect(seq3).toBeGreaterThan(seq2);
    });

    it('persists arbitrary event JSON', () => {
      const event = {
        type: 'tool_start',
        agent_id: 'agent-1',
        data: { tool: 'bash', input: 'ls -la', tool_call_id: 'tc-123' },
      };
      log.append('agent-1', event);
      const replayed = log.replay('agent-1', 0);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]!.event).toEqual(event);
    });

    it('preserves request_id on durable user_message events', () => {
      const event = {
        type: 'user_message',
        agent_id: 'agent-1',
        request_id: 'user-1234-abcd',
        data: {
          content: 'hello from kotlin',
          message_id: 'msg-1',
          request_id: 'user-1234-abcd',
        },
      };

      log.append('agent-1', event);

      const replayed = log.replay('agent-1', 0);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]!.event).toEqual(event);
      expect(replayed[0]!.event.request_id).toBe('user-1234-abcd');
      expect((replayed[0]!.event.data as Record<string, unknown>).request_id).toBe('user-1234-abcd');
    });
  });

  describe('replay', () => {
    it('returns empty array when no events exist', () => {
      expect(log.replay('agent-1', 0)).toEqual([]);
    });

    it('replays all events after cursor 0', () => {
      log.append('agent-1', { type: 'content', data: { delta: 'a' } });
      log.append('agent-1', { type: 'content', data: { delta: 'b' } });
      log.append('agent-1', { type: 'complete', data: {} });

      const events = log.replay('agent-1', 0);
      expect(events).toHaveLength(3);
      expect(events[0]!.event.type).toBe('content');
      expect(events[2]!.event.type).toBe('complete');
    });

    it('replays only events after the given cursor', () => {
      const seq1 = log.append('agent-1', { type: 'content', data: { delta: 'a' } });
      log.append('agent-1', { type: 'content', data: { delta: 'b' } });
      log.append('agent-1', { type: 'complete', data: {} });

      const events = log.replay('agent-1', seq1);
      expect(events).toHaveLength(2);
      expect((events[0]!.event.data as Record<string, unknown>).delta).toBe('b');
    });

    it('returns empty if cursor is at the latest seq', () => {
      const seq1 = log.append('agent-1', { type: 'content', data: { delta: 'a' } });
      const seq2 = log.append('agent-1', { type: 'complete', data: {} });
      expect(log.replay('agent-1', seq2)).toEqual([]);
      // But replaying after seq1 should still return 1 event
      expect(log.replay('agent-1', seq1)).toHaveLength(1);
    });

    it('scopes replay to the requested agent', () => {
      log.append('agent-1', { type: 'content', data: { delta: 'from agent-1' } });
      log.append('agent-2', { type: 'content', data: { delta: 'from agent-2' } });
      log.append('agent-1', { type: 'complete', data: {} });

      const agent1Events = log.replay('agent-1', 0);
      expect(agent1Events).toHaveLength(2);
      expect(agent1Events.every((e) => {
        const d = e.event.data as Record<string, unknown> | undefined;
        return e.event.type === 'complete' || (d?.delta as string)?.includes('agent-1');
      })).toBe(true);

      const agent2Events = log.replay('agent-2', 0);
      expect(agent2Events).toHaveLength(1);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        log.append('agent-1', { type: 'content', data: { delta: `chunk-${i}` } });
      }

      const events = log.replay('agent-1', 0, 5);
      expect(events).toHaveLength(5);
      expect((events[0]!.event.data as Record<string, unknown>).delta).toBe('chunk-0');
      expect((events[4]!.event.data as Record<string, unknown>).delta).toBe('chunk-4');
    });

    it('each replayed event carries its seq number', () => {
      const seq1 = log.append('agent-1', { type: 'content', data: { delta: 'a' } });
      const seq2 = log.append('agent-1', { type: 'complete', data: {} });

      const events = log.replay('agent-1', 0);
      expect(events[0]!.seq).toBe(seq1);
      expect(events[1]!.seq).toBe(seq2);
    });
  });

  describe('latestSeq', () => {
    it('returns 0 for unknown agent', () => {
      expect(log.latestSeq('agent-x')).toBe(0);
    });

    it('returns the seq of the most recent event', () => {
      log.append('agent-1', { type: 'content', data: { delta: 'a' } });
      const seq2 = log.append('agent-1', { type: 'complete', data: {} });
      expect(log.latestSeq('agent-1')).toBe(seq2);
    });

    it('is scoped to the requested agent', () => {
      log.append('agent-1', { type: 'content', data: { delta: 'a' } });
      const seq2 = log.append('agent-2', { type: 'content', data: { delta: 'b' } });
      log.append('agent-1', { type: 'complete', data: {} });

      // agent-2 only has one event
      expect(log.latestSeq('agent-2')).toBe(seq2);
    });
  });

  describe('reap', () => {
    it('removes events older than the retention period', async () => {
      log.append('agent-1', { type: 'content', data: { delta: 'old' } });

      // Wait 10ms so the event's timestamp is strictly in the past
      await new Promise((r) => setTimeout(r, 10));

      const deleted = log.reap(0);
      expect(deleted).toBe(1);
      expect(log.replay('agent-1', 0)).toEqual([]);
    });

    it('keeps recent events', () => {
      log.append('agent-1', { type: 'content', data: { delta: 'recent' } });

      // Reap with 1 hour retention → nothing deleted (just created)
      const deleted = log.reap(60 * 60 * 1000);
      expect(deleted).toBe(0);
      expect(log.replay('agent-1', 0)).toHaveLength(1);
    });

    it('removes events across all agents', async () => {
      log.append('agent-1', { type: 'content', data: {} });
      log.append('agent-2', { type: 'content', data: {} });
      log.append('agent-3', { type: 'content', data: {} });

      // Wait 10ms so all events have timestamps strictly in the past
      await new Promise((r) => setTimeout(r, 10));

      const deleted = log.reap(0);
      expect(deleted).toBe(3);
    });
  });

  describe('persistence', () => {
    it('survives close and reopen', () => {
      log.append('agent-1', { type: 'content', data: { delta: 'hello' } });
      const seq2 = log.append('agent-1', { type: 'complete', data: {} });
      log.close();

      // Reopen
      const log2 = new EventLog(dbPath);
      const events = log2.replay('agent-1', 0);
      expect(events).toHaveLength(2);
      expect(log2.latestSeq('agent-1')).toBe(seq2);
      log2.close();

      // Re-assign so afterEach doesn't fail
      log = new EventLog(dbPath);
    });
  });

  describe('concurrent agents — realistic scenario', () => {
    it('handles interleaved events from multiple agents', () => {
      // Simulate two agents processing simultaneously
      log.append('sora', { type: 'content', agent_id: 'sora', data: { delta: 'Designing ' } });
      log.append('kai', { type: 'tool_start', agent_id: 'kai', data: { tool: 'bash' } });
      log.append('sora', { type: 'content', agent_id: 'sora', data: { delta: 'the API...' } });
      log.append('kai', { type: 'tool_complete', agent_id: 'kai', data: { tool: 'bash' } });
      log.append('sora', { type: 'complete', agent_id: 'sora', data: {} });
      log.append('kai', { type: 'content', agent_id: 'kai', data: { delta: 'Done!' } });
      log.append('kai', { type: 'complete', agent_id: 'kai', data: {} });

      // Client watching sora should only see sora's events
      const soraEvents = log.replay('sora', 0);
      expect(soraEvents).toHaveLength(3);
      expect(soraEvents.every((e) => (e.event.agent_id as string) === 'sora')).toBe(true);

      // Client watching kai should only see kai's events
      const kaiEvents = log.replay('kai', 0);
      expect(kaiEvents).toHaveLength(4);
    });

    it('supports cursor-based catch-up after disconnect', () => {
      // Agent starts responding
      const seq1 = log.append('sora', { type: 'content', data: { delta: 'Part 1. ' } });
      log.append('sora', { type: 'content', data: { delta: 'Part 2. ' } });

      // Client disconnects after seeing seq1
      // ... time passes, more events arrive ...
      log.append('sora', { type: 'content', data: { delta: 'Part 3. ' } });
      log.append('sora', { type: 'complete', data: {} });

      // Client reconnects with cursor = seq1
      const missed = log.replay('sora', seq1);
      expect(missed).toHaveLength(3); // Part 2, Part 3, complete
      expect((missed[0]!.event.data as Record<string, unknown>).delta).toBe('Part 2. ');
    });
  });
});

describe('isDurableEvent', () => {
  it('returns true for content events', () => {
    expect(isDurableEvent({ type: 'content', data: { delta: 'hi' } })).toBe(true);
  });

  it('returns true for tool_start', () => {
    expect(isDurableEvent({ type: 'tool_start', data: { tool: 'bash' } })).toBe(true);
  });

  it('returns true for tool_complete', () => {
    expect(isDurableEvent({ type: 'tool_complete', data: { tool: 'bash' } })).toBe(true);
  });

  it('returns true for complete', () => {
    expect(isDurableEvent({ type: 'complete', data: {} })).toBe(true);
  });

  it('returns true for error', () => {
    expect(isDurableEvent({ type: 'error', data: { message: 'fail' } })).toBe(true);
  });

  it('returns true for session_start', () => {
    expect(isDurableEvent({ type: 'session_start' })).toBe(true);
  });

  it('returns true for user_message', () => {
    expect(isDurableEvent({ type: 'user_message' })).toBe(true);
  });

  it('returns true for proactive_message', () => {
    expect(isDurableEvent({ type: 'proactive_message' })).toBe(true);
  });

  it('returns false for thinking events', () => {
    expect(isDurableEvent({ type: 'thinking' })).toBe(false);
  });

  it('returns false for reasoning events', () => {
    expect(isDurableEvent({ type: 'reasoning' })).toBe(false);
  });

  it('returns false for transport and agent status events', () => {
    expect(isDurableEvent({ type: 'transport_status' })).toBe(false);
    expect(isDurableEvent({ type: 'agent_status' })).toBe(false);
  });

  it('returns false for pong events', () => {
    expect(isDurableEvent({ type: 'pong' })).toBe(false);
  });

  it('returns false for ping events', () => {
    expect(isDurableEvent({ type: 'ping' })).toBe(false);
  });

  it('returns false for message_ack events', () => {
    expect(isDurableEvent({ type: 'message_ack' })).toBe(false);
  });

  it('returns false for relay_ack events', () => {
    expect(isDurableEvent({ type: 'relay_ack' })).toBe(false);
  });

  it('returns false for busy events', () => {
    expect(isDurableEvent({ type: 'busy' })).toBe(false);
  });

  it('returns false for auth events', () => {
    expect(isDurableEvent({ type: 'auth_required' })).toBe(false);
    expect(isDurableEvent({ type: 'auth_device_code' })).toBe(false);
    expect(isDurableEvent({ type: 'auth_complete' })).toBe(false);
  });
});
