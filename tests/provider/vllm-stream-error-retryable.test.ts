import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { ChatMessage, StreamChunk } from '../../src/provider/types.js';
import {
  isTransientProviderFailure,
  sleepMs,
  TRANSIENT_RETRY_MAX_DELAY_MS,
  transientRetryDelayMs,
} from '../../src/provider/transient-errors.js';

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

async function throwFromStreamError(error: Record<string, unknown>): Promise<Error & { retryable?: boolean; code?: string }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.3-codex-spark', max_model_len: 272000 }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ error })}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const provider = new VLlmProvider(`http://127.0.0.1:${port}`, 8192, 'key', 'cortex');
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    try {
      await collect(provider.chat(messages, { model: 'gpt-5.3-codex-spark' }));
      throw new Error('expected stream error');
    } catch (err) {
      return err as Error & { retryable?: boolean; code?: string };
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
  }
}

describe('transient provider failure classification', () => {
  it('treats OpenAI server_error as transient', () => {
    expect(isTransientProviderFailure({
      message: 'An error occurred while processing your request. … help.openai.com …',
      code: 'server_error',
    })).toBe(true);
  });

  it('does not treat context_length_exceeded as transient', () => {
    expect(isTransientProviderFailure({
      message: 'Your input exceeds the context window of this model.',
      code: 'context_length_exceeded',
    })).toBe(false);
  });

  it('does not treat HTTP 401 as transient (operator 2026-07-23)', () => {
    expect(isTransientProviderFailure({
      message: 'vLLM error 401: {"error":{"message":"Unauthorized"}}',
      status: 401,
    })).toBe(false);
    expect(isTransientProviderFailure({
      message: 'vLLM error 401: Authentication credentials were not provided.',
      status: 401,
    })).toBe(false);
    expect(isTransientProviderFailure({
      message: 'Cortex error 401: {"detail":"Malformed JWT header","code":"token_not_valid"}',
      status: 401,
    })).toBe(false);
  });
});

describe('indefinite transient retry backoff', () => {
  it('grows exponentially then caps', () => {
    // rand=0.5 → multiplier 1.0 (0.75 + 0.5*0.5)
    const mid = () => 0.5;
    expect(transientRetryDelayMs(0, mid)).toBe(1_000);
    expect(transientRetryDelayMs(1, mid)).toBe(2_000);
    expect(transientRetryDelayMs(2, mid)).toBe(4_000);
    expect(transientRetryDelayMs(10, mid)).toBe(TRANSIENT_RETRY_MAX_DELAY_MS);
    expect(transientRetryDelayMs(100, mid)).toBe(TRANSIENT_RETRY_MAX_DELAY_MS);
  });

  it('applies jitter within [0.75, 1.25] of base', () => {
    expect(transientRetryDelayMs(0, () => 0)).toBe(750);
    expect(transientRetryDelayMs(0, () => 0.5)).toBe(1_000);
    expect(transientRetryDelayMs(0, () => 1)).toBe(1_250);
  });

  it('sleepMs aborts promptly when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleepMs(60_000, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('VLlmProvider Cortex SSE stream error retryability', () => {
  it('marks Provider upstream stream timed out as retryable', async () => {
    const caught = await throwFromStreamError({
      message: 'Provider upstream stream timed out',
      type: 'timeout_error',
      retryable: true,
    });
    expect(caught.message).toMatch(/upstream stream timed out/i);
    expect(caught.retryable).toBe(true);
  });

  it('marks OpenAI server_error as retryable even without retryable flag', async () => {
    const caught = await throwFromStreamError({
      message:
        'An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID c86ba872-604e-4679-b62a-cf87d1a50fe3 in your message.',
      code: 'server_error',
    });
    expect(caught.message).toMatch(/server_error|error occurred while processing/i);
    expect(caught.retryable).toBe(true);
    expect(caught.code).toBe('server_error');
  });
});
