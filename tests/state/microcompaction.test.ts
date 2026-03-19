import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Message, ContentBlock, ToolResultContent } from '../../src/agent/types.js';

// Mock countTokens to avoid slow tiktoken encoding on huge strings
// The mock returns length/4 (roughly matching the chars-per-token fallback)
vi.mock('../../src/utils/tokens.js', () => ({
  countTokens: (text: string) => Math.ceil(text.length / 4),
}));

// Import after mock
const { microcompactMessage, microcompactLatest } = await import('../../src/state/microcompaction.js');

/** Create a string that exceeds the given token count (with our mock: 4 chars/token) */
function makeHugeContent(targetTokens: number): string {
  return 'x'.repeat(targetTokens * 4);
}

/** Create a tool_result message */
function makeToolResultMessage(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', toolUseId, content },
    ],
  };
}

describe('microcompactMessage', () => {
  it('returns 0 for string content messages', () => {
    const msg: Message = { role: 'user', content: 'hello' };
    expect(microcompactMessage(msg)).toBe(0);
  });

  it('does not compact small tool results (< 40K tokens)', () => {
    const msg = makeToolResultMessage('tc1', 'small result');
    const original = (msg.content as ContentBlock[])[0] as ToolResultContent;
    const originalContent = original.content;
    expect(microcompactMessage(msg)).toBe(0);
    expect(original.content).toBe(originalContent);
  });

  it('truncates large tool results (>= 40K tokens)', () => {
    const bigContent = makeHugeContent(50000);
    const msg = makeToolResultMessage('tc-big', bigContent);
    const result = microcompactMessage(msg);
    expect(result).toBe(1);
    const block = (msg.content as ContentBlock[])[0] as ToolResultContent;
    expect(block.content).toContain('[... truncated');
    expect(block.content.length).toBeLessThan(bigContent.length);
  });

  it('truncates multiple large tool results in one message', () => {
    const big1 = makeHugeContent(50000);
    const big2 = makeHugeContent(45000);
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'tc1', content: big1 },
        { type: 'tool_result', toolUseId: 'tc2', content: big2 },
      ],
    };
    const result = microcompactMessage(msg);
    expect(result).toBe(2);
    for (const block of msg.content as ContentBlock[]) {
      expect((block as ToolResultContent).content).toContain('[... truncated');
    }
  });

  it('does not affect non-tool_result blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Some long text that should not be truncated' },
        { type: 'tool_use', id: 'tc1', name: 'read', input: { file_path: '/tmp/test.txt' } },
      ],
    };
    expect(microcompactMessage(msg)).toBe(0);
  });
});

describe('microcompactLatest', () => {
  it('keeps last 3 tool results uncompacted', () => {
    const big = makeHugeContent(50000);
    const messages: Message[] = [
      makeToolResultMessage('tc1', big),
      makeToolResultMessage('tc2', big),
      makeToolResultMessage('tc3', big),
      makeToolResultMessage('tc4', big),
      makeToolResultMessage('tc5', big),
    ];
    microcompactLatest(messages);
    // Last 3 should be uncompacted
    const block5 = (messages[4]!.content as ContentBlock[])[0] as ToolResultContent;
    const block4 = (messages[3]!.content as ContentBlock[])[0] as ToolResultContent;
    const block3 = (messages[2]!.content as ContentBlock[])[0] as ToolResultContent;
    expect(block5.content).not.toContain('[... truncated');
    expect(block4.content).not.toContain('[... truncated');
    expect(block3.content).not.toContain('[... truncated');
    // First 2 should be compacted
    const block1 = (messages[0]!.content as ContentBlock[])[0] as ToolResultContent;
    const block2 = (messages[1]!.content as ContentBlock[])[0] as ToolResultContent;
    expect(block1.content).toContain('[... truncated');
    expect(block2.content).toContain('[... truncated');
  });

  it('does nothing if total savings < 20K tokens', () => {
    const small = 'small content';
    const messages: Message[] = [
      makeToolResultMessage('tc1', small),
      makeToolResultMessage('tc2', small),
      makeToolResultMessage('tc3', small),
      makeToolResultMessage('tc4', small),
    ];
    microcompactLatest(messages);
    for (const msg of messages) {
      const block = (msg.content as ContentBlock[])[0] as ToolResultContent;
      expect(block.content).toBe(small);
    }
  });

  it('skips already-compacted results (idempotent)', () => {
    const big = makeHugeContent(50000);
    const messages: Message[] = [
      makeToolResultMessage('tc1', big),
      makeToolResultMessage('tc2', big),
      makeToolResultMessage('tc3', big),
      makeToolResultMessage('tc4', big),
      makeToolResultMessage('tc5', big),
    ];
    // First pass
    microcompactLatest(messages);
    const block1After = (messages[0]!.content as ContentBlock[])[0] as ToolResultContent;
    const firstPassContent = block1After.content;
    expect(firstPassContent).toContain('[... truncated');

    // Second pass should be idempotent
    microcompactLatest(messages);
    expect(block1After.content).toBe(firstPassContent);
  });

  it('does nothing for empty messages array', () => {
    const messages: Message[] = [];
    microcompactLatest(messages);
    expect(messages).toHaveLength(0);
  });

  it('does nothing for messages with only string content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    microcompactLatest(messages);
    expect(messages[0]!.content).toBe('hello');
    expect(messages[1]!.content).toBe('world');
  });

  it('saves spill files to disk', () => {
    const big = makeHugeContent(50000);
    const messages: Message[] = [
      makeToolResultMessage('tc-spill-test-1', big),
      makeToolResultMessage('tc-spill-test-2', big),
      makeToolResultMessage('tc-spill-test-3', big),
      makeToolResultMessage('tc-spill-test-4', big),
      makeToolResultMessage('tc-spill-test-5', big),
    ];
    microcompactLatest(messages);
    const spillDir = path.join(os.tmpdir(), 'shizuha-microcompact');
    const spill1 = path.join(spillDir, 'tc-spill-test-1.txt');
    expect(fs.existsSync(spill1)).toBe(true);
    // Cleanup
    try { fs.unlinkSync(spill1); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(spillDir, 'tc-spill-test-2.txt')); } catch { /* ignore */ }
  });

  it('only compacts eligible results exceeding threshold', () => {
    const big = makeHugeContent(50000);
    const small = 'tiny content';
    const messages: Message[] = [
      makeToolResultMessage('tc1', big),    // eligible, will be compacted
      makeToolResultMessage('tc2', small),  // below threshold
      makeToolResultMessage('tc3', big),    // kept (last 3)
      makeToolResultMessage('tc4', big),    // kept (last 3)
      makeToolResultMessage('tc5', big),    // kept (last 3)
    ];
    microcompactLatest(messages);
    const block1 = (messages[0]!.content as ContentBlock[])[0] as ToolResultContent;
    const block2 = (messages[1]!.content as ContentBlock[])[0] as ToolResultContent;
    expect(block1.content).toContain('[... truncated');
    expect(block2.content).toBe(small);
  });
});
