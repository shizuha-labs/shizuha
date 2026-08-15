import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/agent/types.js';
import { assistantTranscriptText, messagesToTranscript } from '../../src/tui/hooks/useAgentSession.js';

describe('resumed transcript conversion', () => {
  it('renders reasoning-only GLM answers from persisted rawContent', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            id: 'vllm_reasoning_1',
            rawContent: 'This answer was surfaced live from GLM reasoning.',
          },
        ],
        timestamp: 123,
      },
    ];

    expect(messagesToTranscript(messages)).toEqual([
      {
        id: 'resume-0-123',
        role: 'assistant',
        content: 'This answer was surfaced live from GLM reasoning.',
        timestamp: 123,
      },
    ]);
  });

  it('keeps assistant tool_use blocks hidden on resume', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'bash',
            input: { cmd: 'echo hidden' },
          },
        ],
        timestamp: 456,
      },
    ];

    expect(messagesToTranscript(messages)).toEqual([]);
  });

  it('rebuilds completed assistant text from persisted tool-cycle messages', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'No problem! The documentation already has the correct IP address (122.162.240.244).',
          },
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'bash',
            input: { command: 'grep -r "122.162.240.244" compose/derp' },
          },
        ],
        timestamp: 100,
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'tool_1',
            content: 'compose/derp/SETUP.md:Public IP: 122.162.240.244',
            isError: false,
          },
        ],
        timestamp: 101,
      },
      {
        role: 'assistant',
        content: 'Perfect! The IP address 122.162.240.244 is already correctly configured.',
        timestamp: 102,
      },
    ];

    const text = assistantTranscriptText(messages);
    expect(text).toContain('122.162.240.244');
    expect(text).not.toContain('122.162.240.24)');
    expect(text).not.toContain('compose/derp/SETUP.md');
  });

  it('keeps the complete resumed transcript instead of only a recent tail', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 140; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `entry-${i}`,
        timestamp: 1000 + i,
      });
    }

    const transcript = messagesToTranscript(messages);
    expect(transcript).toHaveLength(140);
    expect(transcript[0]?.content).toBe('entry-0');
    expect(transcript[139]?.content).toBe('entry-139');
  });
});
