import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VLlmProvider } from '../../src/provider/vllm.js';
import type { StreamChunk } from '../../src/provider/types.js';

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function completionResponse(rehome?: 'required' | 'accepted'): Response {
  const headers: Record<string, string> = { 'content-type': 'text/event-stream' };
  if (rehome) headers['x-cortex-rehome'] = rehome;
  const body = [
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'DeepSeek-V4-Flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, { status: 200, headers });
}

describe('VLlmProvider Cortex soft-drain rehome contract', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('surfaces the required response signal from a successful real request', async () => {
    const required = vi.fn();
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 524_288 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return completionResponse('required');
    }) as typeof globalThis.fetch;

    const provider = new VLlmProvider('http://cortex.test', 524_288, undefined, 'cortex');
    await collect(provider.chat(
      [{ role: 'user', content: 'continue' }],
      {
        model: 'DeepSeek-V4-Flash',
        sessionId: 'agent-session-nami',
        onCortexRehomeRequired: required,
      },
    ));

    expect(required).toHaveBeenCalledTimes(1);
  });

  it('sends warmup plus soft-drain metadata and requires accepted before consuming success', async () => {
    let completionBody: Record<string, any> | undefined;
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 524_288 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      completionBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
      return completionResponse('accepted');
    }) as typeof globalThis.fetch;

    const provider = new VLlmProvider('http://cortex.test', 524_288, undefined, 'cortex');
    const chunks = await collect(provider.chat(
      [{ role: 'user', content: 'full current context' }],
      {
        model: 'DeepSeek-V4-Flash',
        sessionId: 'agent-session-nami',
        requestKind: 'warmup',
        cortexRehome: 'soft-drain',
        maxTokens: 1,
      },
    ));

    expect(completionBody?.['session_id']).toBe('agent-session-nami');
    expect(completionBody?.['metadata']).toEqual({
      request_kind: 'warmup',
      cortex_rehome: 'soft-drain',
    });
    expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true);
  });

  it('fails terminally without retrying a full prefix when acceptance is missing', async () => {
    let completionRequests = 0;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 524_288 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      completionRequests++;
      return completionResponse();
    }) as typeof globalThis.fetch;

    const provider = new VLlmProvider('http://cortex.test', 524_288, undefined, 'cortex');
    let thrown: unknown;
    try {
      await collect(provider.chat(
        [{ role: 'user', content: 'full current context' }],
        {
          model: 'DeepSeek-V4-Flash',
          sessionId: 'agent-session-nami',
          requestKind: 'warmup',
          cortexRehome: 'soft-drain',
          maxTokens: 1,
        },
      ));
    } catch (err) {
      thrown = err;
    }

    expect(completionRequests).toBe(1);
    expect(thrown).toMatchObject({
      code: 'cortex_rehome_not_accepted',
      retryable: false,
    });
  });
});
