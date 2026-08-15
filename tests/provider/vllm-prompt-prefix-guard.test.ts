import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { ChatMessage, StreamChunk } from '../../src/provider/types.js';
import { logger } from '../../src/utils/logger.js';

/**
 * PLAT-4189 follow-up: end-to-end wiring test for the provider-path prompt
 * prefix guard. Drives VLlmProvider.chat() against a stub vLLM server with a
 * stable sessionId and asserts the contract that keeps the vLLM prefix cache
 * warm:
 *  - two consecutive turns where turn 2 is a pure APPEND → no divergence WARN;
 *  - a turn whose HISTORY HEAD was rewritten → exactly one divergence WARN
 *    naming the mutated part.
 */

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function withStubVllm(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 262144 }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse({
          id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'DeepSeek-V4-Flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
        }));
        res.write(sse({
          id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'DeepSeek-V4-Flash',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
        }));
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<void> {
  for await (const _chunk of gen) { /* consume */ }
}

const history: ChatMessage[] = [
  { role: 'user', content: 'first user message with some session content' },
  { role: 'assistant', content: 'first assistant reply' },
  { role: 'user', content: 'second user message continuing the task' },
];

describe('VLlmProvider prompt prefix guard wiring', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn');
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  const divergenceWarns = () => warnSpy.mock.calls.filter((call) =>
    typeof call[1] === 'string' && (call[1] as string).includes('prompt prefix DIVERGED'));

  it('append-only consecutive turns emit no divergence; a head rewrite emits exactly one WARN naming the part', async () => {
    await withStubVllm(async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl);
      const sessionId = `guard-test-${Date.now()}`;
      const opts = { model: 'DeepSeek-V4-Flash', maxTokens: 128, sessionId };

      // Turn 1: baseline.
      await drain(provider.chat(history, opts));
      expect(divergenceWarns()).toHaveLength(0);

      // Turn 2: pure append (assistant + next user message) — must stay silent.
      const appended: ChatMessage[] = [
        ...history,
        { role: 'assistant', content: 'second assistant reply' },
        { role: 'user', content: 'third user message' },
      ];
      await drain(provider.chat(appended, opts));
      expect(divergenceWarns()).toHaveLength(0);

      // Turn 3: history HEAD rewritten (what compaction/trims used to do every
      // near-limit turn) — must WARN exactly once, attributing the first message.
      const mutated: ChatMessage[] = [
        { role: 'user', content: 'REWRITTEN head message (trim notice)' },
        ...appended.slice(1),
        { role: 'assistant', content: 'third assistant reply' },
      ];
      await drain(provider.chat(mutated, opts));
      const warns = divergenceWarns();
      expect(warns).toHaveLength(1);
      const fields = warns[0]![0] as Record<string, unknown>;
      expect(fields['status']).toBe('divergent');
      expect(String(fields['divergentPart'])).toContain('message[0]');

      // Turn 4: appending after the rewrite is clean again (single expected divergence).
      await drain(provider.chat([...mutated, { role: 'user', content: 'fourth user message' }], opts));
      expect(divergenceWarns()).toHaveLength(1);
    });
  });
});
