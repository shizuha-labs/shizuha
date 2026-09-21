import { expect, it, vi } from 'vitest';
import { compactMessages, CompactionCapacityError, CompactionQualityError } from '../../src/state/compaction.js';
import type { Message } from '../../src/agent/types.js';
import type { StreamChunk } from '../../src/provider/types.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

function conversation(): Message[] {
  return Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `Entry ${index}: ${'Historical code, test evidence, exact paths and pending work. '.repeat(200)}`,
    timestamp: index,
  }));
}

const beginning = '<summary>1. Primary request: repair the gateway. '
  + 'The investigation preserved the source, command results, and failed test evidence. '.repeat(80);
const ending = '\n7. Pending Tasks: qualify the deployed source.\n8. Current Work: the release is under review.\n9. Next Step: run the gateway check.</summary>';

it.each(['max_tokens', 'length'])('continues %s output before replacing any history', async (reason) => {
  const provider = new MockProvider();
  const messages = conversation();
  const original = structuredClone(messages);
  provider.queueResponse([
    { type: 'text', text: beginning },
    { type: 'stop_reason', reason },
    { type: 'done' },
  ], ResponseBuilder.textOnly(ending));
  const result = await compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, {
    force: true, sessionId: 'compaction-owner',
  });
  expect(provider.callCount).toBe(2);
  expect(provider.capturedMessages[1]).toEqual([
    ...provider.capturedMessages[0],
    { role: 'assistant', content: beginning },
    { role: 'user', content: expect.stringContaining('Continue the unfinished semantic summary') },
  ]);
  expect(provider.capturedOptions[1]).toEqual(provider.capturedOptions[0]);
  expect(provider.capturedOptions[1].maxTokens).toBe(8192);
  expect(provider.capturedOptions[1].sessionId).toBe('compaction-owner');
  expect(result.messages[0].content).toContain('Pending Tasks: qualify');
  expect(result.messages[0].content).toContain('investigation preserved');
  expect(result.messages.at(-1)).toEqual(messages.at(-1));
  expect(messages).toEqual(original);
});

it('accumulates authoritative final_text across multiple unfinished segments', async () => {
  const provider = new MockProvider();
  const middle = '\n4. Errors: the test was fixed.\n5. Progress: the original request remains pending.';
  const segment = (text: string, reason: string): StreamChunk[] => [
    { type: 'text', text: 'provisional stream' },
    { type: 'final_text', text },
    { type: 'stop_reason', reason },
    { type: 'done' },
  ];
  provider.queueResponse(segment(beginning, 'max_tokens'), segment(middle, 'max_tokens'), segment(ending, 'end_turn'));
  const result = await compactMessages(conversation(), provider, 'cortex/GLM-5.3-Flash', 500000, { force: true });
  expect(provider.callCount).toBe(3);
  expect(result.messages[0].content).toContain(beginning.slice('<summary>'.length) + middle + ending.slice(0, -'</summary>'.length));
  expect(result.messages[0].content).not.toContain('provisional stream');
});

it('continues an unfinished simpler retry with the original retry budget', async () => {
  const provider = new MockProvider();
  provider.queueResponse(ResponseBuilder.empty(), ResponseBuilder.truncated(beginning), ResponseBuilder.textOnly(ending));
  const result = await compactMessages(conversation(), provider, 'cortex/GLM-5.3-Flash', 500000, { force: true });
  expect(result.compacted).toBe(true);
  expect(provider.capturedOptions.map(options => options.maxTokens)).toEqual([8192, 4096, 4096]);
  expect(provider.capturedOptions[2]).toEqual(provider.capturedOptions[1]);
  expect(result.messages[0].content).toContain('Pending Tasks: qualify');
});

it.each(['empty', 'repeated'])('keeps a usable first segment when continuation is %s', async (shape) => {
  const provider = new MockProvider();
  const messages = conversation();
  const original = structuredClone(messages);
  provider.queueResponse(ResponseBuilder.truncated(beginning), ResponseBuilder.textOnly(
    shape === 'empty' ? '' : beginning,
  ));
  const result = await compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, { force: true });
  expect(result.compacted).toBe(true);
  expect(provider.callCount).toBe(2);
  expect(String(result.messages[0]?.content)).toContain('Primary request: repair the gateway');
  expect(messages).toEqual(original);
});

it('rejects a continuation stall when the first segment was empty', async () => {
  const provider = new MockProvider();
  const messages = conversation();
  const original = structuredClone(messages);
  provider.queueResponse(ResponseBuilder.truncated(''), ResponseBuilder.textOnly(''));
  await expect(compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, { force: true }))
    .rejects.toBeInstanceOf(CompactionQualityError);
  expect(messages).toEqual(original);
});

it('accepts a completed semantic continuation without requiring optional closing markup', async () => {
  const provider = new MockProvider();
  provider.queueResponse(ResponseBuilder.truncated(beginning), ResponseBuilder.textOnly(ending.replace('</summary>', '')));
  const result = await compactMessages(conversation(), provider, 'cortex/GLM-5.3-Flash', 500000, { force: true });
  expect(provider.callCount).toBe(2);
  expect(result.messages[0].content).toContain('Current Work: the release is under review.');
  expect(result.messages[0].content).not.toContain('<summary>');
});

it.each(['missing', 'stall_salvage', 'network_error'])('rejects a %s terminal result instead of treating partial output as complete', async (reason) => {
  const provider = new MockProvider();
  const messages = conversation();
  const original = structuredClone(messages);
  const chunks: StreamChunk[] = [{ type: 'text', text: ending }];
  if (reason !== 'missing') chunks.push({ type: 'stop_reason', reason }, { type: 'done' });
  provider.queueResponse(ResponseBuilder.truncated(beginning), chunks);
  await expect(compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, { force: true }))
    .rejects.toBeInstanceOf(CompactionQualityError);
  expect(provider.callCount).toBe(2);
  expect(messages).toEqual(original);
});

it('preserves providers whose authoritative completion event is done without a stop reason', async () => {
  const provider = new MockProvider();
  provider.queueResponse([{ type: 'text', text: beginning + ending }, { type: 'done' }]);
  const result = await compactMessages(conversation(), provider, 'cortex/GLM-5.3-Flash', 500000, { force: true });
  expect(result.compacted).toBe(true);
  expect(provider.callCount).toBe(1);
});

it('preserves the exact provider failure from a continuation instead of committing a partial summary', async () => {
  const provider = new MockProvider();
  const messages = conversation();
  const original = structuredClone(messages);
  const failure = Object.assign(new Error('upstream unavailable'), { status: 503, retryAfterMs: 1300 });
  const chat = provider.chat.bind(provider);
  provider.queueResponse(ResponseBuilder.truncated(beginning));
  provider.chat = async function* (input, options) {
    if (provider.callCount) throw failure;
    yield* chat(input, options);
  };
  const observed = vi.fn();
  await expect(compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, {
    force: true, onProviderError: observed,
  })).rejects.toBe(failure);
  expect(observed).toHaveBeenCalledExactlyOnceWith(failure);
  expect(messages).toEqual(original);
});

it('honors cancellation between segments without dispatching another request', async () => {
  const provider = new MockProvider();
  const messages = conversation();
  const original = structuredClone(messages);
  const controller = new AbortController();
  const reason = new Error('operator cancelled');
  provider.chat = async function* () {
    yield { type: 'text', text: beginning };
    yield { type: 'stop_reason', reason: 'max_tokens' };
    controller.abort(reason);
    yield { type: 'done' };
  };
  const observed = vi.fn();
  await expect(compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, {
    force: true, abortSignal: controller.signal, onProviderError: observed,
  })).rejects.toBe(reason);
  expect(observed).not.toHaveBeenCalled();
  expect(messages).toEqual(original);
});

it('rejects an unfinished summary that cannot reduce the selected source instead of continuing indefinitely', async () => {
  const provider = new MockProvider();
  const messages = conversation();
  const original = structuredClone(messages);
  provider.queueResponse(ResponseBuilder.truncated('Summary evidence and current work. '.repeat(18000)));
  await expect(compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, { force: true }))
    .rejects.toBeInstanceOf(CompactionCapacityError);
  expect(provider.callCount).toBe(1);
  expect(messages).toEqual(original);
});

it('does not mistake quoted summary markup for an unfinished response envelope', async () => {
  const provider = new MockProvider();
  const prose = 'The parser regression tested literal `<summary>` text in a code fixture. '
    + 'The investigation retained all original inputs and requires release verification. '.repeat(80);
  provider.queueResponse(ResponseBuilder.textOnly(prose));
  const result = await compactMessages(conversation(), provider, 'cortex/GLM-5.3-Flash', 500000, { force: true });
  expect(result.messages[0].content).toContain(prose);
  expect(provider.callCount).toBe(1);
});

it('does not promote provisional streamed text when the provider replaces it with empty final_text', async () => {
  const provider = new MockProvider();
  provider.queueResponse([
    { type: 'text', text: beginning + ending },
    { type: 'final_text', text: '' },
    { type: 'stop_reason', reason: 'end_turn' },
    { type: 'done' },
  ], ResponseBuilder.textOnly(beginning + ending));
  const result = await compactMessages(conversation(), provider, 'cortex/GLM-5.3-Flash', 500000, { force: true });
  expect(provider.callCount).toBe(2);
  expect(result.compacted).toBe(true);
});
