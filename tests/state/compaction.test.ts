import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compactMessages,
  CompactionCapacityError,
  CompactionQualityError,
  extractTaskAnchor,
} from '../../src/state/compaction.js';
import { estimateTokens } from '../../src/prompt/context.js';
import { countTokens } from '../../src/utils/tokens.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';
import type { Message, ContentBlock } from '../../src/agent/types.js';

let provider: MockProvider;

beforeEach(() => {
  provider = new MockProvider();
});

it('preserves a long original task anchor without deterministic clipping', () => {
  const task = `anchor-head ${'exact instruction '.repeat(500)} anchor-tail`;
  expect(extractTaskAnchor([{ role: 'user', content: task }])).toBe(task);
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

  it('PLAT-4189: bounds the retained recent tail so compaction actually compresses (5-10x)', async () => {
    // A conversation whose most-recent messages are large — without a tail
    // budget these would be kept verbatim and defeat compaction.
    const messages = makeLargeConversation(60);
    const rawTokens = estimateTokens(messages);
    const adjusted = Math.ceil(rawTokens * SAFETY_FACTOR);
    const maxTokens = Math.floor(adjusted / 0.95);
    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Summary of the 60-message conversation.')));
    const result = await compactMessages(messages, provider, 'test-model', maxTokens, {
      overheadTokens: 0,
    });
    expect(result.compacted).toBe(true);
    // Post-compaction size must be a small fraction of the input (>=3x compression),
    // not merely under the window.
    const compactedTokens = estimateTokens(result.messages);
    expect(compactedTokens).toBeLessThan(estimateTokens(messages) / 3);
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

describe('compactMessages — output budget + progress', () => {
  function maxTokensToTrigger(messages: Message[], model: string): number {
    // Use a generous safety multiplier so the compaction always fires regardless
    // of the model's safety factor, while keeping maxTokens*0.3 well above 20K so
    // the provider-aware cap (not the proportional floor) is what's reported.
    const raw = estimateTokens(messages);
    return Math.max(80000, Math.floor(Math.ceil(raw * 1.35) / 0.95));
  }

  it('caps output budget at 2048 for slow local (cortex/) models', async () => {
    const messages = makeLargeConversation(80);
    const maxTokens = maxTokensToTrigger(messages, 'cortex/GLM-4.7');
    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Local model summary.')));

    const budgets: number[] = [];
    const result = await compactMessages(messages, provider, 'cortex/GLM-4.7', maxTokens, {
      onProgress: (p) => budgets.push(p.budget),
    });
    expect(result.compacted).toBe(true);
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every((b) => b === 2048)).toBe(true);
  });

  it('keeps the compaction request itself below the context window for cortex models', async () => {
    const messages: Message[] = Array.from({ length: 90 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${JSON.stringify({
        output: 'dense-json-log-value '.repeat(900),
        path: `/tmp/generated/${i}.json`,
        status: 'ok',
      })}`,
      timestamp: Date.now() + i,
    }));

    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Oversized cortex transcript summary.')));

    for (let pass = 0; pass < 6; pass++) {
      provider.queueResponse(ResponseBuilder.textOnly(longSummary(`Hierarchical pass ${pass}.`)));
    }
    const result = await compactMessages(messages, provider, 'cortex/Qwen3.6-35B-A3B-NVFP4', 262144, {
      force: true,
    });

    expect(result.compacted).toBe(true);
    expect(provider.callCount).toBeGreaterThan(1);
    for (let call = 0; call < provider.callCount; call++) {
      const compactionPrompt = provider.capturedMessages[call]?.[0]?.content;
      expect(typeof compactionPrompt).toBe('string');
      const promptTokens = countTokens(compactionPrompt as string, 'cortex/Qwen3.6-35B-A3B-NVFP4');
      expect(promptTokens).toBeLessThan(150000);
      expect(provider.capturedOptions[call]?.maxTokens).toBe(2048);
    }
  });

  it('skips a futile retry when a local model saturates the budget in reasoning only', async () => {
    const messages: Message[] = Array.from({ length: 24 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: i === 22
        ? 'Latest user request: continue the production investigation without losing state.'
        : `Message ${i}: ${'important state '.repeat(120)}`,
      timestamp: Date.now() + i,
    }));
    provider.queueResponse([
      { type: 'reasoning_text', text: 'private analysis '.repeat(300) },
      { type: 'usage', inputTokens: 31_086, outputTokens: 2048 },
      { type: 'stop_reason', reason: 'max_tokens' },
      { type: 'done' },
    ]);

    // Forced compaction never dead-ends on quality — it resolves via the
    // fallback ladder — but the futile retry must still be skipped.
    const result = await compactMessages(messages, provider, 'cortex/DeepSeek-V4-Flash', 524288, {
      force: true,
    });
    expect(result.compacted).toBe(true);
    expect(provider.callCount).toBe(1);
    expect(provider.capturedOptions[0]?.maxTokens).toBe(2048);
  });

  it('fails closed on a junk summary when compaction is optional (no force)', async () => {
    const messages = makeLargeConversation(80);
    const maxTokens = maxTokensToTrigger(messages, 'cortex/Qwen3.6-35B-A3B-NVFP4');

    provider.queueResponse(
      ResponseBuilder.textOnly('OK'),
      ResponseBuilder.textOnly('OK'),
    );

    const before = structuredClone(messages);
    await expect(compactMessages(messages, provider, 'cortex/Qwen3.6-35B-A3B-NVFP4', maxTokens))
      .rejects.toBeInstanceOf(CompactionQualityError);
    expect(messages).toEqual(before);
  });

  it('forced compaction with a junk summary resolves via the task-anchor fallback', async () => {
    const messages: Message[] = Array.from({ length: 24 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: i === 22
        ? 'Latest user request: fix SCLI resume context exhaustion permanently.'
        : `Message ${i}: ${'important state '.repeat(120)}`,
      timestamp: Date.now() + i,
    }));

    provider.queueResponse(
      ResponseBuilder.textOnly('OK'),
      ResponseBuilder.textOnly('OK'),
    );

    const result = await compactMessages(messages, provider, 'cortex/Qwen3.6-35B-A3B-NVFP4', 262144, {
      force: true,
    });

    expect(provider.callCount).toBe(2);
    expect(provider.capturedOptions[0]?.maxTokens).toBe(2048);
    expect(provider.capturedOptions[1]?.maxTokens).toBe(1024);
    expect(result.compacted).toBe(true);
    const summaryText = result.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(summaryText).toContain('fix SCLI resume context exhaustion permanently');
  });

  it('keeps the 20000 budget for cloud models', async () => {
    const messages = makeLargeConversation(80);
    const maxTokens = maxTokensToTrigger(messages, 'claude-sonnet-4-6');
    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Cloud model summary.')));

    const budgets: number[] = [];
    const result = await compactMessages(messages, provider, 'claude-sonnet-4-6', maxTokens, {
      onProgress: (p) => budgets.push(p.budget),
    });
    expect(result.compacted).toBe(true);
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every((b) => b === 20000)).toBe(true);
  });

  it('reports streaming progress with non-decreasing output token counts', async () => {
    const messages = makeLargeConversation(80);
    const maxTokens = maxTokensToTrigger(messages, 'cortex/GLM-4.7');
    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Progress summary.')));

    const seen: number[] = [];
    await compactMessages(messages, provider, 'cortex/GLM-4.7', maxTokens, {
      onProgress: (p) => seen.push(p.outputTokens),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]!).toBeGreaterThan(0);
    // monotonic non-decreasing (accumulated char count / 4)
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
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
  it('keeps the selected recent suffix byte-identical after compaction', async () => {
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
    const preserved = result.messages.slice(2);
    const originalSuffix = messages.slice(messages.length - preserved.length);
    expect(preserved).toEqual(originalSuffix);
    for (let index = 0; index < preserved.length; index++) {
      expect(preserved[index]).toBe(originalSuffix[index]);
    }
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

  it('fails closed when forced compaction would enlarge a short conversation', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'word '.repeat(50) },
      { role: 'assistant', content: 'word '.repeat(50) },
      { role: 'user', content: 'word '.repeat(50) },
    ];
    const before = structuredClone(messages);

    provider.queueResponse(
      ResponseBuilder.textOnly(longSummary('Short conversation.')),
    );

    // force: true triggers compaction regardless of size; 200K budget leaves room
    // for summary + all recent messages, so nothing is dropped.
    await expect(compactMessages(messages, provider, 'test-model', 200000, { force: true }))
      .rejects.toBeInstanceOf(CompactionCapacityError);
    expect(messages).toEqual(before);
  });

  it('replaces image data with placeholder in summarization', async () => {
    const longText = 'word '.repeat(2000);
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      if (i === 0) {
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

// ── SCLI-18: compaction integrity tests ──────────────────────────────────────

describe('compactMessages — force (mid-turn peak, SCLI-18)', () => {
  it('compacts when force=true even below threshold', async () => {
    const messages: Message[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${index}: ${'meaningful context '.repeat(100)}`,
    }));
    const maxTokens = 100_000; // way above any threshold

    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Forced compaction summary.')));
    const result = await compactMessages(messages, provider, 'test-model', maxTokens, { force: true });

    expect(result.compacted).toBe(true);
    provider.assertCallCount(1);
  });

  it('force=false + below threshold returns unchanged', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const result = await compactMessages(messages, provider, 'test-model', 100_000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    provider.assertCallCount(0);
  });
});

describe('compactMessages — hierarchical semantic prefixes (SCLI-18)', () => {
  it('covers head, middle, and tail without eliding the middle of a compaction request', async () => {
    const longText = 'word '.repeat(800);
    const messages: Message[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `sentinel-${i}: ${longText}`,
      timestamp: Date.now() + i,
    }));
    const maxTokens = 12_000;
    // A preserved long original/current instruction can require more than eight
    // small-window passes. Every pass must reduce tokens; no arbitrary pass cap
    // may force a deterministic trim of the remaining history.
    for (let pass = 0; pass < 40; pass++) {
      provider.queueResponse(ResponseBuilder.textOnly(longSummary(`Semantic pass ${pass}.`)));
    }
    const result = await compactMessages(messages, provider, 'test-model', maxTokens, { force: true });

    expect(result.compacted).toBe(true);
    expect(provider.callCount).toBeGreaterThan(8);
    const allMaintenanceInputs = provider.capturedMessages
      .map((call) => String(call[0]?.content ?? ''))
      .join('\n');
    expect(allMaintenanceInputs).toContain('sentinel-0');
    expect(allMaintenanceInputs).toContain('sentinel-15');
    expect(allMaintenanceInputs).not.toContain('middle context omitted');
    expect(result.messages.at(-1)).toBe(messages.at(-1));
    expect(String(result.messages.at(-1)?.content)).toContain('sentinel-29');
  });

  it('fails before calling the provider when one oldest message cannot fit', async () => {
    const messages: Message[] = [
      { role: 'user', content: `oversized-oldest: ${'word '.repeat(3_000)}` },
      { role: 'user', content: 'newest request remains intact' },
    ];
    const before = structuredClone(messages);
    await expect(compactMessages(messages, provider, 'test-model', 1_500, { force: true }))
      .rejects.toBeInstanceOf(CompactionCapacityError);
    expect(provider.callCount).toBe(0);
    expect(messages).toEqual(before);
  });

  it('injects plan context exactly once across hierarchical semantic passes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-compaction-plan-'));
    const planFilePath = path.join(tempDir, 'plan.md');
    fs.writeFileSync(planFilePath, '# Durable plan\n- Preserve this once.\n');
    try {
      const messages: Message[] = Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `plan-pass-${index}: ${'word '.repeat(800)}`,
      }));
      for (let pass = 0; pass < 8; pass++) {
        provider.queueResponse(ResponseBuilder.textOnly(longSummary(`Plan semantic pass ${pass}.`)));
      }

      const result = await compactMessages(messages, provider, 'test-model', 12_000, {
        force: true,
        planFilePath,
      });

      expect(provider.callCount).toBeGreaterThan(1);
      const planMessages = result.messages.filter((message) => (
        typeof message.content === 'string'
        && message.content.startsWith('[System] A plan file exists from plan mode at:')
      ));
      expect(planMessages).toHaveLength(1);
      expect(planMessages[0]?.content).toContain('Preserve this once.');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('compactMessages — summary fidelity (SCLI-18)', () => {
  it('summary prompt references all 9 required sections', async () => {
    const messages = makeLargeConversation(6);
    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Fidelity test summary.')));

    await compactMessages(messages, provider, 'test-model', estimateTokens(messages) + 10000, { force: true });

    const sentContent = provider.capturedMessages[0]![0]!.content as string;
    // Verify the 9 COMPACTION_PROMPT sections are present in the sent prompt
    const requiredSections = [
      'Primary Request',
      'Key Technical Concepts',
      'Files and Code',
      'Errors and Fixes',
      'Problem Solving',
      'All User Messages',
      'Pending Tasks',
      'Current Work',
      'Next Step',
    ];
    for (const section of requiredSections) {
      expect(sentContent, `Missing section: "${section}"`).toContain(section);
    }
  });

  it('result starts with [Conversation Summary] and includes acknowledged assistant message', async () => {
    const messages = makeLargeConversation(6);
    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Fidelity test.')));

    const result = await compactMessages(messages, provider, 'test-model', estimateTokens(messages) + 10000, { force: true });
    expect(result.compacted).toBe(true);
    const summaryMsg = result.messages[0];
    expect(summaryMsg?.role).toBe('user');
    expect(summaryMsg?.content).toContain('Conversation Summary');
    const ackMsg = result.messages[1];
    expect(ackMsg?.role).toBe('assistant');
  });
});

describe('compactMessages — resume fidelity (SCLI-18)', () => {
  it('agent resumed on compacted history uses the summary content', async () => {
    // Simulate: large conversation gets compacted, then a new turn is added.
    // The agent resumes on the compacted messages — verify the summary is in context.
    const longText = 'word '.repeat(2000);
    const originalMessages: Message[] = [
      { role: 'user', content: `Task: write a function. ${longText}` },
      { role: 'assistant', content: `Here is the function: ${longText}` },
      { role: 'user', content: `Now add error handling. ${longText}` },
      { role: 'assistant', content: `Added error handling: ${longText}` },
    ];
    const tokens = estimateTokens(originalMessages);
    const maxTokens = tokens + 20000;

    const summaryContent = 'Task: write a function with error handling. Status: done.';
    provider.queueResponse(ResponseBuilder.textOnly(longSummary(summaryContent)));

    const result = await compactMessages(originalMessages, provider, 'test-model', maxTokens, { force: true });
    expect(result.compacted).toBe(true);

    // Add a new user message on top of the compacted history
    const resumedMessages: Message[] = [
      ...result.messages,
      { role: 'user', content: 'What did we just implement?' },
    ];

    // The summary content should be accessible in the resumed conversation
    const summaryMsgContent = resumedMessages[0]!.content as string;
    expect(summaryMsgContent).toContain('[Conversation Summary]');
    // The summary text we generated should be in there
    expect(summaryMsgContent).toContain(summaryContent);
  });

  it('tool-use pair in recent messages is preserved intact after compaction', async () => {
    const longText = 'word '.repeat(2000);
    const messages: Message[] = [
      ...makeLargeConversation(4),
      // Tool use + result pair (must stay together)
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc1', name: 'bash', input: { cmd: 'ls' } },
        ] as ContentBlock[],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'tc1', content: 'file1.ts file2.ts' },
        ] as ContentBlock[],
      },
    ];
    const tokens = estimateTokens(messages);
    const maxTokens = tokens + 10000;

    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Tool pair test.')));
    const result = await compactMessages(messages, provider, 'test-model', maxTokens, {
      force: true,
      allowNonReducing: true,
    });

    expect(result.compacted).toBe(true);
    // The tool_use and tool_result should both be in the recent section
    const recent = result.messages.slice(2); // skip summary + ack
    const toolUseMsg = recent.find((m) =>
      Array.isArray(m.content) && (m.content as ContentBlock[]).some((b) => b.type === 'tool_use')
    );
    const toolResultMsg = recent.find((m) =>
      Array.isArray(m.content) && (m.content as ContentBlock[]).some((b) => b.type === 'tool_result')
    );
    expect(toolUseMsg).toBeDefined();
    expect(toolResultMsg).toBeDefined();
  });
});

describe('compactMessages — reasoning encryptedContent uses [thinking] placeholder', () => {
  it('reasoning block with only encryptedContent is replaced with [thinking] in compaction input', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            id: 'r1',
            encryptedContent: 'OPAQUE_BINARY_DATA',
          } as ContentBlock,
          { type: 'text', text: 'Answer.' } as ContentBlock,
        ],
      },
      { role: 'user', content: 'word '.repeat(2000) },
      { role: 'assistant', content: 'word '.repeat(2000) },
      { role: 'user', content: 'word '.repeat(2000) },
    ];
    const tokens = estimateTokens(messages);
    const maxTokens = tokens + 10000;

    provider.queueResponse(ResponseBuilder.textOnly(longSummary('Encrypted reasoning summary.')));
    await compactMessages(messages, provider, 'test-model', maxTokens, { force: true });

    const sentContent = provider.capturedMessages[0]![0]!.content as string;
    expect(sentContent).toContain('[thinking]');
    expect(sentContent).not.toContain('OPAQUE_BINARY_DATA');
  });
});

describe('forced compaction accepts short-but-real summaries (shizuha5 2026-08-10)', () => {
  it('accepts a terse non-degenerate summary under force instead of dead-ending the session', async () => {
    const { MockProvider: MP } = await import('../helpers/mock-provider.js');
    const provider = new MP();
    const messages: Message[] = Array.from({ length: 24 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${'important state '.repeat(120)}`,
      timestamp: Date.now() + i,
    }));
    // ~120 tokens: short of the 10%/200 quality bar but clearly a real summary
    // — a resume that hard-fails here leaves the session unresumable.
    const terse = 'The agent worked on SCLI resume context exhaustion: '
      + 'investigated compaction failures, fixed the deadline scaling, and '
      + 'verified fleet health across three DeepSeek lanes. '.repeat(3)
      + 'Next step: monitor the DSpark A/B and convert i7-a if results hold.';
    provider.queueResponse(
      ResponseBuilder.textOnly(terse),
      ResponseBuilder.textOnly(terse),
    );
    const result = await compactMessages(messages, provider, 'cortex/Qwen3.6-35B-A3B-NVFP4', 262144, {
      force: true,
    });
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('strips echoed serialized tool blocks under force and keeps the real prose', async () => {
    const { MockProvider: MP } = await import('../helpers/mock-provider.js');
    const provider = new MP();
    const messages: Message[] = Array.from({ length: 24 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${'important state '.repeat(120)}`,
      timestamp: Date.now() + i,
    }));
    const prose = 'The agent investigated the compaction pipeline end to end: '
      + 'reproduced the resume failure, scaled the TUI deadline with prompt size, '
      + 'retired the fleet-wide serializer per the operator ruling, and verified '
      + 'all three DeepSeek lanes healthy on the live Backends page. '.repeat(6)
      + 'Next: watch the DSpark A/B for several days before converting another lane.';
    const echoed = `${prose}\n\n`
      + '[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"kubectl get pods"}}]\n'
      + '[{"type":"tool_result","tool_use_id":"toolu_1","content":"3 pods Running"}]\n';
    provider.queueResponse(ResponseBuilder.textOnly(echoed));

    const result = await compactMessages(messages, provider, 'cortex/Qwen3.6-35B-A3B-NVFP4', 262144, {
      force: true,
    });
    expect(result.compacted).toBe(true);
    const envelope = result.messages[0]!.content as string;
    expect(envelope).toContain('investigated the compaction pipeline');
    expect(envelope).not.toContain('"tool_use_id"');
    expect(envelope).not.toContain('[{"type"');
  });
});
