import { afterEach, expect, it, vi } from 'vitest';
import { compactMessages } from '../../src/state/compaction.js';
import { VLlmProvider } from '../../src/provider/vllm.js';
import { OllamaProvider } from '../../src/provider/ollama.js';

afterEach(() => vi.unstubAllGlobals());

it('preserves the actual Ollama native done contract across consecutive compactions', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const summary = '<summary>The original request is to repair and qualify the gateway. '
    + 'The investigation preserved the source, exact errors, test results, and pending release work. '.repeat(80)
    + 'Current work remains release qualification; no deployment is claimed.</summary>';
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, initialization?: RequestInit) => {
    requests.push(JSON.parse(initialization!.body as string));
    return new Response(JSON.stringify({
      message: { role: 'assistant', content: summary }, done: true, done_reason: 'stop',
      prompt_eval_count: 12000, eval_count: 1400,
    }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
  }));
  const provider = new OllamaProvider('http://compaction-ollama.invalid');
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: 'user' as const, content: `Entry ${index}: ${'Historical result. '.repeat(1000)}`, timestamp: index,
  }));
  const original = structuredClone(messages);
  for (const attempt of [0, 1]) {
    const result = await compactMessages(messages, provider, 'ollama/qwen3', 500000, { force: true });
    expect(result.compacted).toBe(true);
    expect(result.messages[0].content).toContain('Current work remains release qualification');
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(requests).toHaveLength(attempt + 1);
    expect(requests[attempt].options).toMatchObject({ num_predict: 8192 });
    expect(requests[attempt].tools).toBeUndefined();
    expect(messages).toEqual(original);
  }
});

it('runs the real provider context guard again before dispatching a continuation', async () => {
  let posts = 0;
  const fetch = vi.fn(async (_input: unknown, initialization?: RequestInit) => {
    if (!initialization?.body) return Response.json({ data: [{ id: 'GLM-5.3-Flash', max_model_len: 4096 }] });
    posts++;
    const content = '<summary>' + 'The change preserved evidence and unresolved work. '.repeat(105);
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'length' }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetch);
  const provider = new VLlmProvider('http://compaction-guard.invalid', 4096, '', 'cortex');
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? 'assistant' as const : 'user' as const,
    content: `Entry ${index}: ${'Historical result. '.repeat(150)}`,
    timestamp: index,
  }));
  const original = structuredClone(messages);
  const observed = vi.fn();
  await expect(compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 4096, {
    force: true, onProviderError: observed,
  })).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_TOO_SMALL' });
  expect(posts).toBe(1);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(messages).toEqual(original);
});

it('does not accept the local provider done event when native continuation finish_reason is absent', async () => {
  let posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, initialization?: RequestInit) => {
    if (!initialization?.body) return Response.json({ data: [{ id: 'GLM-5.3-Flash', max_model_len: 500000 }] });
    posts++;
    const content = posts === 1 ? '<summary>' + 'The investigation preserved code, tests, exact errors and pending work. '.repeat(80)
      : 'The current release still needs review and live verification.</summary>';
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content }, ...(posts === 1 ? { finish_reason: 'length' } : {}) }] })
      + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }));
  const provider = new VLlmProvider('http://compaction-guard.invalid', 500000, '', 'cortex');
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: 'user' as const, content: `Entry ${index}: ${'Historical result. '.repeat(1000)}`, timestamp: index,
  }));
  const original = structuredClone(messages);
  await expect(compactMessages(messages, provider, 'cortex/GLM-5.3-Flash', 500000, { force: true }))
    .rejects.toMatchObject({ code: 'COMPACTION_QUALITY_FAILED' });
  expect(posts).toBe(2);
  expect(messages).toEqual(original);
});
