import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VLlmProvider } from '../../src/provider/vllm.js';
import { renderMetrics } from '../../src/metrics/registry.js';
import type { StreamChunk } from '../../src/provider/types.js';

const ENV_KEYS = [
  'SHIZUHA_INTERACTIVE_TUI',
  'VLLM_FIRST_TOKEN_TIMEOUT_MS',
  'VLLM_FIRST_TOKEN_MAX_MS',
  'VLLM_REQUEST_STATUS_INTERVAL_MS',
  'VLLM_SOFT_STALL_MS',
  'VLLM_CONN_RETRIES',
  'VLLM_429_RETRIES',
  'VLLM_5XX_RETRIES',
] as const;

describe('vLLM interactive timeout behavior', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
  });

  it('fails a TUI stream that never yields first headers with a bounded timeout status', async () => {
    process.env['SHIZUHA_INTERACTIVE_TUI'] = '1';
    process.env['VLLM_FIRST_TOKEN_TIMEOUT_MS'] = '80';
    process.env['VLLM_FIRST_TOKEN_MAX_MS'] = '80';
    process.env['VLLM_REQUEST_STATUS_INTERVAL_MS'] = '20';

    globalThis.fetch = vi.fn(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 4096 }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (requestUrl.endsWith('/v1/chat/completions')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'));
          });
        });
      }

      throw new Error(`unexpected URL ${requestUrl}`);
    }) as typeof globalThis.fetch;

    const provider = new VLlmProvider('http://vllm.test', 4096);
    const statuses: Extract<StreamChunk, { type: 'status' }>[] = [];
    let thrown: unknown;

    try {
      for await (const chunk of provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'DeepSeek-V4-Flash', maxTokens: 8 },
      )) {
        if (chunk.type === 'status') statuses.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }

    const requestStart = statuses.find((status) => status.code === 'request_start');
    expect(requestStart?.message).toBe('Waiting for model response...');
    expect(requestStart?.message).not.toMatch(/trace|headers|first chunk|streaming|cortex\.shizuha\.com|vllm\.test/i);
    expect(statuses.some((status) => status.requestId?.startsWith('scli-'))).toBe(true);
    expect(statuses.some((status) => status.code === 'request_wait' && status.waitPhase === 'headers' && typeof status.elapsedMs === 'number')).toBe(true);
    expect(statuses.filter((status) => status.code === 'request_wait')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'info', message: 'Waiting for model response...' }),
      ]),
    );
    expect(statuses.filter((status) => status.code === 'request_wait').every(
      (status) => !/Esc to cancel|\/model to switch|budget/i.test(status.message),
    )).toBe(true);
    expect(statuses.some((status) => status.code === 'stall_timeout' && status.waitPhase === 'first_chunk' && status.requestId?.startsWith('scli-'))).toBe(true);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('vLLM no first chunk');
  });

  it('SCLI-388: soft-stall request_wait includes budget + recovery after threshold', async () => {
    process.env['SHIZUHA_INTERACTIVE_TUI'] = '1';
    process.env['VLLM_FIRST_TOKEN_TIMEOUT_MS'] = '200';
    process.env['VLLM_FIRST_TOKEN_MAX_MS'] = '200';
    process.env['VLLM_REQUEST_STATUS_INTERVAL_MS'] = '40';
    process.env['VLLM_SOFT_STALL_MS'] = '50';

    globalThis.fetch = vi.fn(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 4096 }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (requestUrl.endsWith('/v1/chat/completions')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'));
          });
        });
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    }) as typeof globalThis.fetch;

    const provider = new VLlmProvider('http://vllm.test', 4096);
    const waits: Extract<StreamChunk, { type: 'status' }>[] = [];
    try {
      for await (const chunk of provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'DeepSeek-V4-Flash', maxTokens: 8 },
      )) {
        if (chunk.type === 'status' && chunk.code === 'request_wait') waits.push(chunk);
      }
    } catch {
      // expected timeout
    }

    const soft = waits.find((w) => (w.elapsedMs ?? 0) >= 50);
    expect(soft).toBeDefined();
    expect(soft!.level).toBe('warning');
    expect(typeof soft!.timeoutMs).toBe('number');
    expect(soft!.message).toMatch(/budget/i);
    expect(soft!.message).toMatch(/Esc to cancel/i);
    expect(soft!.message).toMatch(/\/model/i);
  });

  it('emits structured telemetry and Prometheus metrics for no-first-chunk timeouts', async () => {
    process.env['SHIZUHA_INTERACTIVE_TUI'] = '1';
    process.env['VLLM_FIRST_TOKEN_TIMEOUT_MS'] = '80';
    process.env['VLLM_FIRST_TOKEN_MAX_MS'] = '80';
    process.env['VLLM_REQUEST_STATUS_INTERVAL_MS'] = '20';

    let completionInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 4096 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (requestUrl.endsWith('/v1/chat/completions')) {
        completionInit = init;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'));
          });
        });
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    }) as typeof globalThis.fetch;

    const provider = new VLlmProvider('http://vllm.test', 4096);
    const telemetry: Extract<StreamChunk, { type: 'inference_telemetry' }>[] = [];

    await expect((async () => {
      for await (const chunk of provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'DeepSeek-V4-Flash', maxTokens: 8, sessionId: 'sess-plat-3121' },
      )) {
        if (chunk.type === 'inference_telemetry') telemetry.push(chunk);
      }
    })()).rejects.toThrow(/no first chunk/);

    expect(completionInit).toBeTruthy();
    expect((completionInit?.headers as Record<string, string>)['X-Cortex-Session-Id']).toBe('sess-plat-3121');
    const body = JSON.parse(String(completionInit?.body));
    expect(body.session_id).toBe('sess-plat-3121');
    expect(body.user).toBe('sess-plat-3121');

    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      outcome: 'timeout',
      timeoutPhase: 'first_chunk',
      errorClass: 'no_first_chunk',
      provider: 'vllm',
      requestedModel: 'DeepSeek-V4-Flash',
      resolvedModel: 'DeepSeek-V4-Flash',
      sessionId: 'sess-plat-3121',
      toolMode: false,
    });
    expect(telemetry[0]?.traceId).toMatch(/[0-9a-f-]{36}/);
    expect(telemetry[0]?.requestId).toMatch(/^scli-[0-9a-f]{8}$/);

    const metrics = await renderMetrics();
    expect(metrics).toContain('scli_inference_requests_total{provider="vllm",model="deepseek-v4-flash",outcome="timeout",error_class="no_first_chunk"}');
    expect(metrics).toContain('scli_inference_stream_stalls_total{provider="vllm",model="deepseek-v4-flash",phase="first_chunk"}');
    expect(metrics).toContain('scli_inference_errors_total{provider="vllm",model="deepseek-v4-flash",error_class="no_first_chunk"}');
  });

  it('bounds Cortex admission retries for an ordinary fleet/gateway turn', async () => {
    let completionAttempts = 0;
    globalThis.fetch = vi.fn(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 4096 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (requestUrl.endsWith('/v1/chat/completions')) {
        completionAttempts++;
        return new Response(JSON.stringify({
          error: { type: 'admission_timeout', message: 'interactive admission wait budget exhausted' },
        }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '0',
            'x-request-id': `admission-${completionAttempts}`,
          },
        });
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    }) as typeof globalThis.fetch;

    const provider = new VLlmProvider('http://cortex.test', 4096);
    const statuses: Extract<StreamChunk, { type: 'status' }>[] = [];
    await expect((async () => {
      for await (const chunk of provider.chat(
        [{ role: 'user', content: 'check production work' }],
        { model: 'DeepSeek-V4-Flash', maxTokens: 8, sessionId: 'agent-session-nova' },
      )) {
        if (chunk.type === 'status') statuses.push(chunk);
      }
    })()).rejects.toMatchObject({ status: 429 });

    // Initial admission plus two bounded retries. The old gateway default made
    // 21 attempts and could hide minutes of saturation inside a single TTFT.
    expect(completionAttempts).toBe(3);
    expect(statuses.filter((status) => status.code === 'rate_limit_retry')).toEqual([
      expect.objectContaining({ upstreamRequestId: 'admission-1', attemptWaitMs: expect.any(Number) }),
      expect.objectContaining({ upstreamRequestId: 'admission-2', attemptWaitMs: expect.any(Number) }),
    ]);
  });

  it('correlates client lifecycle telemetry with the final accepted Cortex request', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 4096 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (requestUrl.endsWith('/v1/chat/completions')) {
        return new Response([
          'data: {"id":"chatcmpl-1","model":"DeepSeek-V4-Flash","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-1","model":"DeepSeek-V4-Flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n'), {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'x-request-id': 'cortex-request-3016ec51b207',
          },
        });
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    }) as typeof globalThis.fetch;

    const provider = new VLlmProvider('http://cortex.test', 4096);
    const telemetry: Extract<StreamChunk, { type: 'inference_telemetry' }>[] = [];
    for await (const chunk of provider.chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'DeepSeek-V4-Flash', maxTokens: 8, sessionId: 'agent-session-nova' },
    )) {
      if (chunk.type === 'inference_telemetry') telemetry.push(chunk);
    }

    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      outcome: 'success',
      upstreamRequestId: 'cortex-request-3016ec51b207',
    });
  });
});
