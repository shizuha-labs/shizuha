import { describe, expect, it } from 'vitest';
import { buildSyncHistoryMessages } from '../../src/state/sync-history.js';
import type { Message } from '../../src/agent/types.js';

describe('buildSyncHistoryMessages', () => {
  it('reuses stable message ids for plain user and assistant messages', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1000 },
      { id: 'assistant-1', executionId: 'exec-1', role: 'assistant', content: 'hi', timestamp: 2000 },
    ];

    expect(buildSyncHistoryMessages(messages)).toEqual([
      { id: 'user-1', role: 'user', content: 'hello', created_at: new Date(1000).toISOString() },
      { id: 'assistant-1', role: 'assistant', content: 'hi', created_at: new Date(2000).toISOString() },
    ]);
  });

  it('collapses multi-turn assistant rows that share the same message id', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'solve this', timestamp: 1000 },
      { id: 'assistant-1', executionId: 'exec-1', role: 'assistant', content: 'Planning', timestamp: 2000 },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tool-1', content: 'ok' }],
        timestamp: 2500,
      },
      { id: 'assistant-1', executionId: 'exec-1', role: 'assistant', content: 'Done', timestamp: 3000 },
    ];

    expect(buildSyncHistoryMessages(messages)).toEqual([
      { id: 'user-1', role: 'user', content: 'solve this', created_at: new Date(1000).toISOString() },
      { id: 'assistant-1', role: 'assistant', content: 'Planning\n\nDone', created_at: new Date(2000).toISOString() },
    ]);
  });

  it('extracts visible text from structured assistant content and skips tool-only entries', () => {
    const messages: Message[] = [
      {
        id: 'assistant-1',
        executionId: 'exec-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
        ],
        timestamp: 1000,
      },
      {
        id: 'assistant-1',
        executionId: 'exec-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Final answer' },
          { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
        ],
        timestamp: 2000,
      },
    ];

    expect(buildSyncHistoryMessages(messages)).toEqual([
      { id: 'assistant-1', role: 'assistant', content: 'Final answer', created_at: new Date(2000).toISOString() },
    ]);
  });
});
