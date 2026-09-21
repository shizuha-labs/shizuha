import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VLlmProvider, payloadForPromptTokenEstimate, countVisionImageParts } from '../../src/provider/vllm.js';
import type { ChatMessage, StreamChunk } from '../../src/provider/types.js';
import { countTokens } from '../../src/utils/tokens.js';

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

type Captured = { body?: string; affinityHeader?: string };

async function withCaptureServer(
  fn: (baseUrl: string, captured: Captured) => Promise<void>,
  opts: { maxModelLen?: number; modelId?: string } = {},
): Promise<void> {
  const captured: Captured = {};
  const modelId = opts.modelId ?? 'DeepSeek-V4-Flash';
  const maxModelLen = opts.maxModelLen ?? 262144;
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: modelId, max_model_len: maxModelLen }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      captured.affinityHeader = req.headers['x-cortex-session-id'] as string | undefined;
      const parts: Buffer[] = [];
      req.on('data', (chunk) => parts.push(Buffer.from(chunk)));
      req.on('end', () => {
        captured.body = Buffer.concat(parts).toString('utf8');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse({
          id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'DeepSeek-V4-Flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok 😀' }, finish_reason: null }],
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
    await fn(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

afterEach(() => {
  delete process.env['VLLM_AFFINITY_SESSION_ID'];
  delete process.env['VLLM_REASONING_EFFORT'];
  delete process.env['VLLM_REQUEST_KIND'];
});

describe('VLlmProvider UTF-8 payload sanitization', () => {
  it('replaces lone UTF-16 surrogates before POSTing while preserving valid emoji pairs', async () => {
    await withCaptureServer(async (baseUrl, captured) => {
      const provider = new VLlmProvider(baseUrl, 262144);
      const messages: ChatMessage[] = [
        { role: 'user', content: 'valid emoji 😀 plus broken high \ud83d and broken low \udc00' },
      ];

      const chunks = await collect(provider.chat(messages, { model: 'DeepSeek-V4-Flash', maxTokens: 16 }));

      expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text.includes('ok'))).toBe(true);
      expect(captured.body).toBeTruthy();
      expect(captured.body).not.toContain('\\ud83d');
      expect(captured.body).not.toContain('\\udc00');
      expect(captured.body).toContain('😀');
      expect(captured.body).toContain('�');
    });
  });

  it('uses an admitted routing cohort without changing the local session', async () => {
    process.env['VLLM_AFFINITY_SESSION_ID'] = 'benchboard:deepseek-v4-flash:ga-0731';
    await withCaptureServer(async (baseUrl, captured) => {
      const provider = new VLlmProvider(baseUrl, 262144, undefined, 'cortex');
      const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

      await collect(provider.chat(messages, {
        model: 'DeepSeek-V4-Flash',
        maxTokens: 16,
        sessionId: 'local-task-session-that-must-not-route',
        // The gateway's scaffold default must not override the authoritative
        // GA agentic profile.
        temperature: 0,
        thinkingLevel: 'on',
        reasoningEffort: 'high',
      }));

      const body = JSON.parse(captured.body ?? '{}') as Record<string, unknown>;
      expect(body['session_id']).toBe('benchboard:deepseek-v4-flash:ga-0731');
      expect(body['user']).toBe('benchboard:deepseek-v4-flash:ga-0731');
      // SCLI-451: sampling omitted — the serving engine's pinned recipe rules.
      expect(body['temperature']).toBeUndefined();
      expect(body['top_p']).toBeUndefined();
      expect(body['repetition_detection']).toEqual({
        max_pattern_size: 20,
        min_pattern_size: 3,
        min_count: 4,
      });
      expect(body['chat_template_kwargs']).toMatchObject({
        enable_thinking: true,
        thinking: true,
        reasoning_effort: 'high',
      });
      // SCLI-696 (re-land of SCLI-584): DeepSeek ids ALSO carry the official
      // top-level wire (api.deepseek.com spelling) — chat_template_kwargs stays
      // the vLLM spelling; the official object is scoped to DeepSeek ids only
      // (the 2026-08-14 garble was sending it to vLLM generally).
      expect(body['thinking']).toEqual({ type: 'enabled' });
      expect(body['reasoning_effort']).toBe('high');
      expect(captured.affinityHeader).toBe('benchboard:deepseek-v4-flash:ga-0731');
    });
  });

  it('GLM-5.3-Flash agentic turns use the model-card 1.0/0.95 even if the TUI scaffold is 0', async () => {
    await withCaptureServer(async (baseUrl, captured) => {
      const provider = new VLlmProvider(baseUrl, 500000, undefined, 'cortex');
      await collect(provider.chat([{ role: 'user', content: 'hi' }], {
        model: 'GLM-5.3-Flash',
        maxTokens: 16,
        sessionId: 'e81682dd-greedy-control',
        temperature: 0,
        thinkingLevel: 'on',
      }));
      const body = JSON.parse(captured.body ?? '{}') as Record<string, unknown>;
      expect(body['temperature']).toBe(1.0);
      expect(body['top_p']).toBe(0.95);
      expect(body['repetition_detection']).toEqual({
        max_pattern_size: 20,
        min_pattern_size: 3,
        min_count: 4,
      });
    });
  });

  it('lets an explicit DeepSeek reasoningEffort override the profile default', async () => {
    await withCaptureServer(async (baseUrl, captured) => {
      const provider = new VLlmProvider(baseUrl, 524288, undefined, 'cortex');
      await collect(provider.chat([{ role: 'user', content: 'hi' }], {
        model: 'DeepSeek-V4-Flash',
        maxTokens: 16,
        thinkingLevel: 'on',
        reasoningEffort: 'max',
      }));
      const body = JSON.parse(captured.body ?? '{}') as Record<string, any>;
      expect(body.chat_template_kwargs.reasoning_effort).toBe('max');
      // SCLI-696: official top-level wire mirrors the resolved effort — explicit
      // 'max' override passes through unmapped (DeepSeek knows high|max).
      expect(body.thinking).toEqual({ type: 'enabled' });
      expect(body.reasoning_effort).toBe('max');
    });
  });

  it('keeps DeepSeek maintenance compaction deterministic', async () => {
    await withCaptureServer(async (baseUrl, captured) => {
      const provider = new VLlmProvider(baseUrl, 524288, undefined, 'cortex');
      await collect(provider.chat([{ role: 'user', content: 'Summarize.' }], {
        model: 'DeepSeek-V4-Flash',
        maxTokens: 32,
        temperature: 0,
        thinkingLevel: 'off',
        reasoningEffort: 'high',
        requestKind: 'maintenance',
      }));

      const body = JSON.parse(captured.body ?? '{}') as Record<string, any>;
      expect(body.temperature).toBe(0);
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('repetition_detection');
      expect(body.chat_template_kwargs).not.toHaveProperty('reasoning_effort');
    });
  });

  it('keeps the real compaction request kind deterministic and disables forced thinking', async () => {
    await withCaptureServer(async (baseUrl, captured) => {
      const provider = new VLlmProvider(baseUrl, 524288, undefined, 'cortex');
      await collect(provider.chat([{ role: 'user', content: 'Summarize.' }], {
        model: 'DeepSeek-V4-Flash',
        maxTokens: 2048,
        temperature: 0,
        thinkingLevel: 'off',
        reasoningEffort: 'high',
        requestKind: 'compaction',
      }));

      const body = JSON.parse(captured.body ?? '{}') as Record<string, any>;
      expect(body.temperature).toBe(0);
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('repetition_detection');
      expect(body.chat_template_kwargs).toMatchObject({
        enable_thinking: false,
        thinking: false,
      });
      expect(body.chat_template_kwargs).not.toHaveProperty('reasoning_effort');
      // SCLI-696: the official wire still DECLARES thinking state on compaction
      // (disabled — deterministic maintenance), but never an effort.
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.metadata?.request_kind).toBe('compaction');
    });
  });

  it('tags dedicated benchmark runtimes without overriding explicit maintenance', async () => {
    process.env['VLLM_REQUEST_KIND'] = 'benchmark';
    await withCaptureServer(async (baseUrl, captured) => {
      const provider = new VLlmProvider(baseUrl, 524288);
      await collect(provider.chat([{ role: 'user', content: 'Solve.' }], {
        model: 'DeepSeek-V4-Flash',
        maxTokens: 16,
        sessionId: 'unique-benchmark-cell-session',
      }));

      let body = JSON.parse(captured.body ?? '{}') as Record<string, any>;
      expect(body.metadata?.request_kind).toBe('benchmark');
      expect(body.session_id).toBe('unique-benchmark-cell-session');
      expect(body.user).toBe('unique-benchmark-cell-session');
      expect(captured.affinityHeader).toBe('unique-benchmark-cell-session');

      await collect(provider.chat([{ role: 'user', content: 'Compact.' }], {
        model: 'DeepSeek-V4-Flash',
        maxTokens: 16,
        requestKind: 'maintenance',
      }));
      body = JSON.parse(captured.body ?? '{}') as Record<string, any>;
      expect(body.metadata?.request_kind).toBe('maintenance');
    });
  });
});

describe('vLLM prompt token estimate ignores screenshot data-URIs', () => {
  it('does not count base64 image bytes as prompt text tokens', () => {
    const huge = 'A'.repeat(80_000);
    const messages = [{
      role: 'tool' as const,
      tool_call_id: 't1',
      content: [
        { type: 'text' as const, text: 'Screenshot captured.' },
        { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${huge}` } },
      ],
    }];
    const redacted = payloadForPromptTokenEstimate(messages);
    const raw = JSON.stringify(messages);
    const slim = JSON.stringify(redacted);
    expect(countVisionImageParts(messages)).toBe(1);
    expect(slim.length).toBeLessThan(raw.length / 10);
    expect(slim).toContain('data:image/png;base64,AA==');
    expect(slim).not.toContain(huge);
  });

  it('sends a screenshot that would overflow JSON.stringify-as-text against a 8k window', async () => {
    // Production order for shizuha2 e81682dd 2026-09-19: compaction's
    // estimateTokens counted 3 screenshots at IMAGE_TOKEN_ESTIMATE each
    // (~446k, under 500k). VLlmProvider then JSON.stringified the data-URIs
    // (~64k extra) and threw CONTEXT_WINDOW_TOO_SMALL at prompt≈523191.
    const huge = 'A'.repeat(80_000);
    await withCaptureServer(async (baseUrl, captured) => {
      const provider = new VLlmProvider(baseUrl, 8_192, undefined, 'cortex');
      const messages: ChatMessage[] = [{
        role: 'user',
        content: [{
          type: 'tool_result',
          toolUseId: 'shot-e81682dd',
          content: 'Screenshot captured.',
          image: { base64: huge, mediaType: 'image/png' },
        }],
      }];
      expect(countTokens(JSON.stringify(messages), 'GLM-5.3-Flash')).toBeGreaterThan(8_192);
      const chunks = await collect(provider.chat(messages, {
        model: 'GLM-5.3-Flash',
        maxTokens: 1024,
        sessionId: 'e81682dd-screenshot-preflight',
      }));
      expect(chunks.some((chunk) => chunk.type === 'status' && String((chunk as { message?: string }).message ?? '').includes('context window exhausted'))).toBe(false);
      expect(chunks.some((chunk) => chunk.type === 'text' && chunk.text.includes('ok'))).toBe(true);
      expect(captured.body).toContain(huge);
      expect(captured.body).toContain('data:image/png;base64,');
    }, { maxModelLen: 8_192, modelId: 'GLM-5.3-Flash' });
  });
});
