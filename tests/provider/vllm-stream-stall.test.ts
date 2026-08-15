import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { ChatMessage, StreamChunk } from '../../src/provider/types.js';

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

describe('VLlmProvider stream stall handling', () => {
  const originalStreamStall = process.env['VLLM_STREAM_STALL_MS'];
  const originalFirstToken = process.env['VLLM_FIRST_TOKEN_TIMEOUT_MS'];
  const originalFirstTokenMax = process.env['VLLM_FIRST_TOKEN_MAX_MS'];
  const originalPrefillFloor = process.env['VLLM_PREFILL_FLOOR_TPS'];
  const originalConnRetries = process.env['VLLM_CONN_RETRIES'];
  const originalDiscoveryTimeout = process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'];
  const originalFinishDrain = process.env['VLLM_FINISH_DRAIN_MS'];

  beforeEach(() => {
    process.env['VLLM_STREAM_STALL_MS'] = '120';
    process.env['VLLM_FIRST_TOKEN_TIMEOUT_MS'] = '120';
    process.env['VLLM_FIRST_TOKEN_MAX_MS'] = '120';
    process.env['VLLM_PREFILL_FLOOR_TPS'] = '1000000';
    process.env['VLLM_CONN_RETRIES'] = '1';
    process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'] = '3000';
    process.env['VLLM_FINISH_DRAIN_MS'] = '60';
  });

  afterEach(() => {
    process.env['VLLM_STREAM_STALL_MS'] = originalStreamStall;
    process.env['VLLM_FIRST_TOKEN_TIMEOUT_MS'] = originalFirstToken;
    process.env['VLLM_FIRST_TOKEN_MAX_MS'] = originalFirstTokenMax;
    process.env['VLLM_PREFILL_FLOOR_TPS'] = originalPrefillFloor;
    process.env['VLLM_CONN_RETRIES'] = originalConnRetries;
    process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'] = originalDiscoveryTimeout;
    process.env['VLLM_FINISH_DRAIN_MS'] = originalFinishDrain;
  });

  it('discovers the requested model context from Cortex/OpenRouter model metadata', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'Qwen3.6-27B', context_length: 131072 },
            { id: 'DeepSeek-V4-Flash', context_length: 1048576 },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192);

      await expect(provider.getServedModel('DeepSeek-V4-Flash')).resolves.toBe('DeepSeek-V4-Flash');
      expect(provider.maxContextWindow).toBe(1048576);
    });
  });

  it('treats Cortex max_model_len as source of truth over local constructor defaults', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            {
              id: 'DeepSeek-V4-Flash',
              max_model_len: 262144,
              context_length: 1048576,
              capabilities: { tools: true, streaming: true, json_mode: false },
              cortex: { max_concurrent: 15, quantization: 'nvfp4' },
            },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 1048576);

      await expect(provider.getServedModel('DeepSeek-V4-Flash')).resolves.toBe('DeepSeek-V4-Flash');
      expect(provider.maxContextWindow).toBe(262144);
    });
  });

  it('does not let one model discovery poison another model on a multi-model endpoint', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'Qwen3.6-27B', max_model_len: 131072 },
            { id: 'DeepSeek-V4-Flash', context_length: 1048576 },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192);

      await expect(provider.getServedModel('Qwen3.6-27B')).resolves.toBe('Qwen3.6-27B');
      expect(provider.maxContextWindow).toBe(131072);

      await expect(provider.getServedModel('DeepSeek-V4-Flash')).resolves.toBe('DeepSeek-V4-Flash');
      expect(provider.maxContextWindow).toBe(1048576);
    });
  });

  it('bounds model discovery so resume cannot hang on an unresponsive endpoint', async () => {
    process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'] = '50';
    await withServer((_req, _res) => {
      // Deliberately never respond. AbortSignal.timeout must release the caller.
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 131072);
      const startedAt = Date.now();

      await expect(provider.getServedModel('unknown-model')).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(1000);
    });
  });

  it('keeps both DeepSeek and Qwen thinking template flags enabled for DeepSeek V4 Flash by default', async () => {
    let requestBody: Record<string, unknown> | null = null;

    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash', context_length: 1048576 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          requestBody = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'close',
          });
          res.write(sseChunk({
            id: 'cmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'DeepSeek-V4-Flash',
            choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
          }));
          res.write(sseChunk({
            id: 'cmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'DeepSeek-V4-Flash',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }));
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192);
      const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
      await collect(provider.chat(messages, { model: 'vllm/DeepSeek-V4-Flash' }));

      expect(requestBody?.['chat_template_kwargs']).toMatchObject({
        enable_thinking: true,
        thinking: true,
      });
    });
  });

  it('keeps direct vLLM bounded when blank transport chunks contain no model progress', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const interval = setInterval(() => {
          res.write('\n');
        }, 20);
        req.on('close', () => clearInterval(interval));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192);
      const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
      await expect(collect(provider.chat(messages, { model: 'vllm/test-model' })))
        .rejects.toThrow(/no first chunk|aborted|abort/i);
    });
  });

  it('keeps Cortex connection/header establishment bounded before a stream is accepted', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        // Deliberately never send response headers. The accepted-stream contract
        // has not started, so SCLI's bounded establishment watchdog still owns it.
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192, undefined, 'cortex');
      await expect(collect(provider.chat(
        [{ role: 'user', content: 'wait for admission' }],
        { model: 'DeepSeek-V4-Flash', maxTokens: 8 },
      ))).rejects.toThrow(/no first chunk|aborted|abort/i);
    });
  });

  it('keeps an accepted Cortex stream alive through comment-only tool buffering beyond old client timers', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const heartbeats = setInterval(() => {
          res.write(': cortex upstream-wait\n\n');
        }, 20);
        setTimeout(() => {
          clearInterval(heartbeats);
          res.write(sseChunk({
            id: 'cmpl-buffered-tool',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'DeepSeek-V4-Flash',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call-buffered',
                  type: 'function',
                  function: { name: 'read', arguments: '{"path":"AGENTS.md"}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }));
          res.write('data: [DONE]\n\n');
          res.end();
        }, 320);
        req.on('close', () => clearInterval(heartbeats));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192, undefined, 'cortex');
      const startedAt = Date.now();
      const chunks = await collect(provider.chat(
        [{ role: 'user', content: 'read the instructions' }],
        {
          model: 'DeepSeek-V4-Flash',
          maxTokens: 8,
          tools: [{ name: 'read', description: 'read a file', inputSchema: { type: 'object' } }],
        },
      ));

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      // Transport heartbeats prove only that the Cortex relay is connected;
      // they must not masquerade as semantic/model progress in the agent layer.
      expect(chunks.some((chunk) => chunk.type === 'thinking')).toBe(false);
      expect(chunks.some((chunk) => chunk.type === 'tool_use_end')).toBe(true);
      expect(chunks.some((chunk) => chunk.type === 'status' && chunk.code === 'stall_timeout')).toBe(false);
      expect(chunks.at(-1)?.type).toBe('done');
    });
  });

  it('lets the caller abort an accepted Cortex stream during comment-only buffering', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const heartbeats = setInterval(() => {
          res.write(': cortex upstream-wait\n\n');
        }, 20);
        req.on('close', () => clearInterval(heartbeats));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192, undefined, 'cortex');
      const caller = new AbortController();
      const callerReason = new Error('caller requested cancel');
      const chunks: StreamChunk[] = [];
      const request = (async () => {
        for await (const chunk of provider.chat(
          [{ role: 'user', content: 'wait for the model' }],
          { model: 'DeepSeek-V4-Flash', maxTokens: 8, abortSignal: caller.signal },
        )) chunks.push(chunk);
      })();
      setTimeout(() => caller.abort(callerReason), 260);

      await expect(request).rejects.toThrow(/caller requested cancel|aborted|abort/i);
      expect(caller.signal.reason).toBe(callerReason);
      expect(chunks.some((chunk) => (
        chunk.type === 'status'
        && (chunk.code === 'stall_timeout' || chunk.code === 'stream_interrupted')
      ))).toBe(false);
    });
  });

  it('retains the short finish_reason drain for accepted Cortex streams', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(sseChunk({
          id: 'cmpl-finish-drain',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'DeepSeek-V4-Flash',
          choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
        }));
        const heartbeats = setInterval(() => {
          res.write(': cortex upstream-wait\n\n');
        }, 20);
        req.on('close', () => clearInterval(heartbeats));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192, undefined, 'cortex');
      const startedAt = Date.now();
      const chunks = await collect(provider.chat(
        [{ role: 'user', content: 'finish' }],
        { model: 'DeepSeek-V4-Flash', maxTokens: 8 },
      ));

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text === 'done')).toBe(true);
      expect(chunks.some((chunk) => chunk.type === 'stop_reason' && chunk.reason === 'stop')).toBe(true);
      expect(chunks.at(-1)?.type).toBe('done');
    });
  });

  it('keeps a stream alive when real SSE data chunks arrive before the stall timeout', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const parts = ['he', 'll', 'o'];
        parts.forEach((part, index) => {
          setTimeout(() => {
            res.write(sseChunk({
              id: 'cmpl-test',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'test-model',
              choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
            }));
          }, index * 40);
        });
        setTimeout(() => {
          res.write(sseChunk({
            id: 'cmpl-test',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
          }));
          res.write('data: [DONE]\n\n');
          res.end();
        }, 130);
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192);
      const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
      const chunks = await collect(provider.chat(messages, { model: 'vllm/test-model' }));

      expect(chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('hello');
      expect(chunks.some((c) => c.type === 'usage' && c.inputTokens === 3 && c.outputTokens === 3)).toBe(true);
      expect(chunks.at(-1)?.type).toBe('done');
    });
  });

  it('salvages partial text when a stream stalls after meaningful SSE data', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(sseChunk({
          id: 'cmpl-test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
        }));
        const interval = setInterval(() => {
          res.write('\n');
        }, 20);
        req.on('close', () => clearInterval(interval));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192);
      const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
      const chunks = await collect(provider.chat(messages, { model: 'vllm/test-model' }));

      expect(chunks.some((c) => c.type === 'text' && c.text === 'partial')).toBe(true);
      throw new Error('expected retryable throw after mid-response stall');
    }).catch((err: Error & { retryable?: boolean; code?: string }) => {
      // 2026-08-15 (shizuha1): mid-response silence after tokens must RETRY.
      // Fail-closed salvage discarded a completed tool call and sat on a red
      // banner. Cortex same-session supersede (2026-08-10) makes replay safe.
      expect(err.message).toMatch(/mid-response transport drop|stream stalled/);
      expect(err.retryable).toBe(true);
      expect(err.code).toBe('ECONNRESET');
    });
  });

  it('retries when the socket is terminated after partial output (shizuha1 2026-08-15)', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(sseChunk({
          id: 'cmpl-test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
        }));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192);
      await collect(provider.chat(
        [{ role: 'user', content: 'hello' }],
        { model: 'vllm/test-model' },
      ));
      throw new Error('expected retryable throw after socket destroy');
    }).catch((err: Error & { retryable?: boolean; code?: string }) => {
      expect(err.retryable).toBe(true);
      expect(String(err.code || err.message)).toMatch(/ECONNRESET|terminated|aborted|closed|destroy/i);
    });
  });

  it('replays the turn when Cortex errors after partial output (operator ruling 2026-08-10)', async () => {
    await withServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model', max_model_len: 8192 }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close',
        });
        res.write(sseChunk({
          id: 'cmpl-test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { content: 'partial output' }, finish_reason: null }],
        }));
        res.write(sseChunk({
          error: {
            message: 'Upstream stream stalled for 1144s with no chunks',
            type: 'timeout_error',
            retryable: true,
          },
        }));
        res.end();
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const provider = new VLlmProvider(baseUrl, 8192);
      const chunks = await collect(provider.chat(
        [{ role: 'user', content: 'hello' }],
        { model: 'vllm/test-model' },
      ));

      const provider2 = provider;
      void provider2;
      throw new Error('expected retryable throw');
    }).catch((err: Error & { retryable?: boolean }) => {
      // shizuha2 (EngineCore 500 mid-turn): partial output no longer ends the
      // turn with a salvaged fragment — the provider throws RETRYABLE and the
      // session loop replays with backoff; Cortex same-session supersede
      // cancels the abandoned upstream.
      expect(err.message).toContain('stream error');
      expect(err.retryable).toBe(true);
    });
  });
});
