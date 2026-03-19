import { describe, it, expect, beforeEach } from 'vitest';
import { compactMessages } from '../../src/state/compaction.js';
import { estimateTokens } from '../../src/prompt/context.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';
import type { Message, ContentBlock } from '../../src/agent/types.js';

let provider: MockProvider;

beforeEach(() => {
  provider = new MockProvider();
});

/** Create a conversation with enough tokens to exceed threshold */
function makeLargeConversation(messageCount: number): Message[] {
  const longText = 'word '.repeat(2000); // ~2000 tokens per message
  return Array.from({ length: messageCount }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i}: ${longText}`,
    timestamp: Date.now() + i,
  }));
}

/** Generate a mock summary long enough to pass the compaction quality gate (>= 200 tokens) */
function longSummary(core: string): string {
  // Pad with enough text to reliably exceed MIN_SUMMARY_TOKENS (200).
  // Using 'word ' repeated 250 times ≈ 250 tokens, well above the threshold.
  return `<summary>${core}\n\n${'word '.repeat(250)}</summary>`;
}

describe('compactMessages — threshold', () => {
  // compactMessages applies a 1.35x tiktoken safety factor internally.
  // Effective check: ceil(rawTokens * 1.35) > maxTokens * 0.90
  const SAFETY_FACTOR = 1.35;
  const THRESHOLD = 0.90;

  it('returns unchanged when below effective threshold', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'short message' },
      { role: 'assistant', content: 'short reply' },
    ];
    const result = await compactMessages(messages, provider, 'test-model', 200000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages); // same reference
  });

  it('compacts when above effective threshold', async () => {
    const messages = makeLargeConversation(100);
    const rawTokens = estimateTokens(messages);
    // Set maxTokens so adjusted tokens (raw * 1.35) exceed 90% threshold
    const adjusted = Math.ceil(rawTokens * SAFETY_FACTOR);
    const maxTokens = Math.floor(adjusted / 0.95); // adjusted is ~95% of max → above 90%

    // Queue a summary response (long enough to pass quality gate)
    provider.queueResponse(
      ResponseBuilder.textOnly(longSummary('Conversation about testing with 100 messages.')),
    );

    const result = await compactMessages(messages, provider, 'test-model', maxTokens);
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('does not compact when adjusted tokens are at boundary', async () => {
    const messages: Message[] = [{ role: 'user', content: 'test' }];
    const rawTokens = estimateTokens(messages);
    // Set maxTokens so ceil(rawTokens * 1.35) === maxTokens * 0.90
    const adjusted = Math.ceil(rawTokens * SAFETY_FACTOR);
    const maxTokens = Math.ceil(adjusted / THRESHOLD);
    const result = await compactMessages(messages, provider, 'test-model', maxTokens);
    expect(result.compacted).toBe(false);
  });
});

describe('compactMessages — summary format', () => {
  it('compacted result starts with [Conversation Summary]', async () => {
    const messages = makeLargeConversation(60);
    const tokens = estimateTokens(messages);
    const maxTokens = Math.floor(Math.ceil(tokens * 1.35) / 0.95);

    provider.queueResponse(
      ResponseBuilder.textOnly(longSummary('This is the summary content.')),
    );

    const result = await compactMessages(messages, provider, 'test-model', maxTokens);
    expect(result.compacted).toBe(true);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toContain('[Conversation Summary]');
    expect(result.messages[0]!.content).toContain('This is the summary content.');
  });

  it('followed by assistant acknowledgment', async () => {
    const messages = makeLargeConversation(60);
    const tokens = estimateTokens(messages);
    const maxTokens = Math.floor(Math.ceil(tokens * 1.35) / 0.95);

    provider.queueResponse(
      ResponseBuilder.textOnly(longSummary('Summary here.')),
    );

    const result = await compactMessages(messages, provider, 'test-model', maxTokens);
    expect(result.messages[1]!.role).toBe('assistant');
    expect(result.messages[1]!.content).toContain('context');
  });

  it('extracts content from <summary> tags', async () => {
    const messages = makeLargeConversation(60);
    const tokens = estimateTokens(messages);
    const maxTokens = Math.floor(Math.ceil(tokens * 1.35) / 0.95);

    provider.queueResponse(
      ResponseBuilder.textOnly('<analysis>Some analysis</analysis>\n' + longSummary('Extracted summary.')),
    );

    const result = await compactMessages(messages, provider, 'test-model', maxTokens);
    const summaryMsg = result.messages[0]!.content as string;
    expect(summaryMsg).toContain('Extracted summary.');
    expect(summaryMsg).not.toContain('<analysis>');
  });
});

describe('compactMessages — recent message preservation', () => {
  it('keeps last 4 messages after compaction', async () => {
    const messages = makeLargeConversation(20);
    const tokens = estimateTokens(messages);
    const maxTokens = Math.floor(Math.ceil(tokens * 1.35) / 0.95);

    provider.queueResponse(
      ResponseBuilder.textOnly(longSummary('Summary of first 16 messages.')),
    );

    const result = await compactMessages(messages, provider, 'test-model', maxTokens);
    expect(result.compacted).toBe(true);
    // summary + ack + recent messages
    // Recent should include the last few messages from original
    const lastOriginal = messages[messages.length - 1]!;
    const lastCompacted = result.messages[result.messages.length - 1]!;
    expect(lastCompacted.content).toBe(lastOriginal.content);
  });

  it('does not split tool_use/tool_result pairs', async () => {
    const longText = 'word '.repeat(2000);
    const messages: Message[] = [];
    // Build a conversation with tool_use/tool_result pairs
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `User ${i}: ${longText}` });
      messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: `Thinking ${i}: ${longText}` },
          { type: 'tool_use', id: `tc${i}`, name: 'read', input: { file_path: `/tmp/file${i}` } },
        ],
      });
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: `tc${i}`, content: `Result ${i}: ${longText}` },
        ],
      });
    }

    const tokens = estimateTokens(messages);
    const maxTokens = Math.floor(Math.ceil(tokens * 1.35) / 0.95);

    provider.queueResponse(
      ResponseBuilder.textOnly(longSummary('Summary of tool interactions.')),
    );

    const result = await compactMessages(messages, provider, 'test-model', maxTokens);
    expect(result.compacted).toBe(true);

    // Check that we don't start with a tool_result message in the recent section
    // (after summary + ack, the first recent msg should not be an orphaned tool_result)
    const recentMessages = result.messages.slice(2); // skip summary + ack
    if (recentMessages.length > 0) {
      const first = recentMessages[0]!;
      if (Array.isArray(first.content)) {
        const blocks = first.content as ContentBlock[];
        const hasToolResult = blocks.some((b) => b.type === 'tool_result');
        if (hasToolResult) {
          // If it's a tool_result, the preceding message (assistant with tool_use) should also be in recent
          const prevIdx = result.messages.indexOf(first) - 1;
          expect(prevIdx).toBeGreaterThanOrEqual(2); // after summary + ack
          const prev = result.messages[prevIdx];
          if (prev && Array.isArray(prev.content)) {
            expect((prev.content as ContentBlock[]).some((b) => b.type === 'tool_use')).toBe(true);
          }
        }
      }
    }
  });

  it('preserves short conversations entirely', async () => {
    // Only 3 messages — keepFrom would go to 0
    const messages: Message[] = [
      { role: 'user', content: 'word '.repeat(5000) },
      { role: 'assistant', content: 'word '.repeat(5000) },
      { role: 'user', content: 'word '.repeat(5000) },
    ];
    const tokens = estimateTokens(messages);
    const maxTokens = Math.floor(Math.ceil(tokens * 1.35) / 0.95);

    provider.queueResponse(
      ResponseBuilder.textOnly(longSummary('Short conversation.')),
    );

    const result = await compactMessages(messages, provider, 'test-model', maxTokens);
    if (result.compacted) {
      // All original messages should appear in the recent section
      const recent = result.messages.slice(2);
      expect(recent.length).toBe(3);
    }
  });

  it('replaces image data with placeholder in summarization', async () => {
    const longText = 'word '.repeat(2000);
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      if (i === 5) {
        // Add image tool result
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'tc-img',
              content: 'Screenshot of the page',
              image: { base64: 'AAAA'.repeat(10000), mediaType: 'image/png' as const },
            },
          ],
        });
      } else {
        messages.push({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `Message ${i}: ${longText}`,
        });
      }
    }

    const tokens = estimateTokens(messages);
    // Use a large maxTokens so conversation truncation doesn't drop the image message.
    // This test is about image placeholder behavior, not truncation.
    const maxTokens = tokens + 50000;

    provider.queueResponse(
      ResponseBuilder.textOnly(longSummary('Summary with image reference.')),
    );

    const result = await compactMessages(messages, provider, 'test-model', maxTokens, { force: true });
    expect(result.compacted).toBe(true);
    // The conversation text sent to LLM should NOT contain raw base64
    provider.assertCallCount(1);
    const sentContent = provider.capturedMessages[0]![0]!.content as string;
    expect(sentContent).not.toContain('AAAA'.repeat(100));
    expect(sentContent).toContain('image data omitted');
  });
});
