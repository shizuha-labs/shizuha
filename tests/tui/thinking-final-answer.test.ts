import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/agent/types.js';
import {
  assistantTranscriptText,
  latestThinkingSnippet,
  messageToTranscriptContent,
  THINKING_SNIPPET_MAX_CHARS,
} from '../../src/tui/hooks/useAgentSession.js';

describe('TUI thinking vs final answer', () => {
  it('keeps live thinking to a short rolling snippet', () => {
    const long = 'The user is asking me what I think about this system. '.repeat(8);
    const snippet = latestThinkingSnippet(long);
    expect(snippet.length).toBeLessThanOrEqual(THINKING_SNIPPET_MAX_CHARS);
    expect(snippet).not.toContain('\n');
    expect(long.includes(snippet.slice(-20))).toBe(true);
  });

  it('never treats persisted reasoning as the visible assistant answer', () => {
    const message: Message = {
      role: 'assistant',
      content: [
        { type: 'reasoning', id: 'r1', rawContent: 'The user is asking me what I think about this system.' },
        { type: 'text', text: 'Load skills on demand and verify on the live system.' },
      ],
      timestamp: 1,
    };
    expect(messageToTranscriptContent(message)).toBe(
      'Load skills on demand and verify on the live system.',
    );
    expect(assistantTranscriptText([message])).toBe(
      'Load skills on demand and verify on the live system.',
    );
  });

  it('omits a reasoning-only turn from the visible transcript', () => {
    const message: Message = {
      role: 'assistant',
      content: [
        { type: 'reasoning', id: 'r1', rawContent: 'planning the reply in hidden reasoning' },
      ],
      timestamp: 1,
    };
    expect(messageToTranscriptContent(message)).toBe('');
    expect(assistantTranscriptText([message])).toBe('');
  });
});
