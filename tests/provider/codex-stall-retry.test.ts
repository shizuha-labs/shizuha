import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatOptions, StreamChunk } from '../../src/provider/types.js';

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
}));

vi.mock('openai', () => {
  class MockAPIError extends Error {
    status?: number;
    headers?: Record<string, string>;
  }
  class MockOpenAI {
    static APIError = MockAPIError;
    responses = {
      create: (...args: unknown[]) => createMock(...args),
    };
    constructor(_opts: unknown) {}
  }
  return { default: MockOpenAI };
});

import { CodexProvider } from '../../src/provider/codex.js';

function fakeAuth() {
  return [{
    authMode: 'chatgpt',
    email: 'test@example.com',
    accessToken: 'token',
    refreshToken: 'refresh',
    accountId: 'acct',
    authPath: '/tmp/auth.json',
  }];
}

function stalledStream(signal?: AbortSignal): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await new Promise<void>((_, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('stalled stream did not receive abort'));
            }, 2000);
            timeout.unref?.();

            if (!signal) return;
            if (signal.aborted) {
              clearTimeout(timeout);
              reject(signal.reason ?? new Error('aborted'));
              return;
            }
            signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(signal.reason ?? new Error('aborted'));
            }, { once: true });
          });
          return { done: true, value: undefined };
        },
      };
    },
  };
}

async function* successfulStream(): AsyncGenerator<unknown> {
  yield { type: 'response.output_text.delta', delta: 'ok' };
  yield {
    type: 'response.completed',
    response: { usage: { input_tokens: 11, output_tokens: 7 } },
  };
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

describe('CodexProvider stream stall handling', () => {
  const originalStreamTimeout = process.env['STREAM_TIMEOUT_MS'];
  const originalApiTimeout = process.env['API_TIMEOUT_MS'];
  const originalFirstTokenTimeout = process.env['FIRST_TOKEN_TIMEOUT_MS'];

  beforeEach(() => {
    createMock.mockReset();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env['STREAM_TIMEOUT_MS'] = originalStreamTimeout;
    process.env['API_TIMEOUT_MS'] = originalApiTimeout;
    process.env['FIRST_TOKEN_TIMEOUT_MS'] = originalFirstTokenTimeout;
  });

  it('retries after stalled stream and then succeeds', async () => {
    process.env['STREAM_TIMEOUT_MS'] = '200';
    process.env['FIRST_TOKEN_TIMEOUT_MS'] = '200';

    let callCount = 0;
    createMock.mockImplementation((_params: unknown, opts?: { signal?: AbortSignal }) => {
      callCount++;
      if (callCount === 1) return stalledStream(opts?.signal);
      return successfulStream();
    });

    const provider = new CodexProvider(fakeAuth());
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const options: ChatOptions = { model: 'gpt-5.3-codex' };

    const chunks = await collect(provider.chat(messages, options));

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(chunks.some((c) => c.type === 'text' && c.text === 'ok')).toBe(true);
    expect(chunks.some((c) => c.type === 'usage' && c.inputTokens === 11 && c.outputTokens === 7)).toBe(true);
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('does not retry when user aborts the turn', async () => {
    process.env['STREAM_TIMEOUT_MS'] = '5000';
    process.env['FIRST_TOKEN_TIMEOUT_MS'] = '5000';

    createMock.mockImplementation((_params: unknown, opts?: { signal?: AbortSignal }) => {
      return stalledStream(opts?.signal);
    });

    const provider = new CodexProvider(fakeAuth());
    const controller = new AbortController();
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const options: ChatOptions = { model: 'gpt-5.3-codex', abortSignal: controller.signal };

    const run = collect(provider.chat(messages, options));
    setTimeout(() => controller.abort(new Error('user interrupt')), 10);

    await expect(run).rejects.toThrow(/user interrupt|aborted/i);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('fails after bounded retries when stream keeps stalling', async () => {
    process.env['STREAM_TIMEOUT_MS'] = '200';
    process.env['FIRST_TOKEN_TIMEOUT_MS'] = '200';

    createMock.mockImplementation((_params: unknown, opts?: { signal?: AbortSignal }) => {
      return stalledStream(opts?.signal);
    });

    const provider = new CodexProvider(fakeAuth());
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const options: ChatOptions = { model: 'gpt-5.3-codex' };

    await expect(collect(provider.chat(messages, options))).rejects.toThrow(/no events/i);
    // MAX_RETRY_ATTEMPTS=5 -> initial try + 5 retries = 6 calls
    expect(createMock).toHaveBeenCalledTimes(6);
  });

  it('emits canonical final_text from completed assistant message items', async () => {
    async function* streamWithFinalMessage(): AsyncGenerator<unknown> {
      yield { type: 'response.output_text.delta', delta: 'draft ' };
      yield {
        type: 'response.output_item.done',
        item: {
          id: 'msg_123',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'clean final answer', annotations: [] },
          ],
        },
      };
      yield {
        type: 'response.completed',
        response: { usage: { input_tokens: 9, output_tokens: 4 } },
      };
    }

    createMock.mockImplementation(() => streamWithFinalMessage());

    const provider = new CodexProvider(fakeAuth());
    const chunks = await collect(provider.chat([{ role: 'user', content: 'hello' }], { model: 'gpt-5.3-codex-spark' }));

    expect(chunks.some((c) => c.type === 'text' && c.text === 'draft ')).toBe(true);
    expect(chunks.some((c) => c.type === 'final_text' && c.text === 'clean final answer')).toBe(true);
  });
});
