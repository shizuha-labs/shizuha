import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../src/web/lib/types.js';
import {
  buildReplayBatchKey,
  resolveAssistantTurnId,
  upsertAssistantMessage,
} from '../../src/web/lib/chat-sync.js';

function assistant(id: string, content: string, createdAt: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    status: 'complete',
    createdAt,
  };
}

describe('chat replay identity helpers', () => {
  it('prefers assistant message_id over execution_id when both exist', () => {
    expect(resolveAssistantTurnId({
      type: 'session_start',
      execution_id: 'exec-1',
      data: { message_id: 'msg-1' },
    })).toBe('msg-1');
  });

  it('falls back to execution_id when no assistant message_id exists', () => {
    expect(resolveAssistantTurnId({
      type: 'content',
      execution_id: 'exec-42',
      data: { delta: '42' },
    })).toBe('exec-42');
  });

  it('uses seq range for replay dedup instead of cursor plus event count', () => {
    const first = buildReplayBatchKey({
      agent_id: 'agent-1',
      cursor: 200,
      first_seq: 101,
      last_seq: 200,
      events: [{ _seq: 101 }, { _seq: 200 }],
    });
    const second = buildReplayBatchKey({
      agent_id: 'agent-1',
      cursor: 200,
      first_seq: 151,
      last_seq: 200,
      events: [{ _seq: 151 }, { _seq: 200 }],
    });
    expect(first).not.toBe(second);
  });

  it('keeps repeated identical assistant content when turn ids differ', () => {
    const before = [assistant('exec-early', '42', '2026-03-17T05:17:10.000Z')];
    const after = upsertAssistantMessage(
      before,
      assistant('exec-late', '42', '2026-03-17T09:17:51.000Z'),
      true,
    );

    expect(after).toHaveLength(2);
    expect(after.map((m) => m.id)).toEqual(['exec-early', 'exec-late']);
  });

  it('replaces the existing assistant bubble when the turn id matches', () => {
    const before = [assistant('exec-42', '4', '2026-03-17T09:17:50.000Z')];
    const after = upsertAssistantMessage(
      before,
      assistant('exec-42', '42', '2026-03-17T09:17:51.000Z'),
      true,
    );

    expect(after).toHaveLength(1);
    expect(after[0]?.content).toBe('42');
  });
});
