import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { ChatMessage, StreamChunk } from '../../src/provider/types.js';
import { retryAfterMsFromError } from '../../src/provider/transient-errors.js';

/**
 * Cortex sends an accurate Retry-After on its admission guards — the
 * latency-tail guard ("no safe cold-prefill lane") sends 5s because the lane
 * frees on that timescale. The provider dropped the header entirely, so the
 * session loop fell back to a blind exponential and could idle a full minute
 * after the backend was ready (shizuha1, 2026-08-03).
 */
async function requestAgainst(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Error & { status?: number; retryAfterMs?: number }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'DeepSeek-V4-Flash', max_model_len: 524288 }] }));
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const provider = new VLlmProvider(`http://127.0.0.1:${port}`, 8192, 'key', 'cortex');
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    try {
      const chunks: StreamChunk[] = [];
      for await (const c of provider.chat(messages, { model: 'DeepSeek-V4-Flash' })) chunks.push(c);
      throw new Error('expected the request to fail');
    } catch (err) {
      return err as Error & { status?: number; retryAfterMs?: number };
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
  }
}

describe('vLLM/Cortex Retry-After plumbing', () => {
  // The in-provider 5xx loop defaults to 40 attempts (30s cap) for non-TUI
  // callers; these tests assert what the THROWN error carries, so collapse the
  // loop to one retry instead of waiting out the real backoff. Note `0` is NOT
  // usable here: parseTimeoutMs only accepts values > 0 and silently falls back
  // to the 40-attempt default otherwise.
  const previous = process.env['VLLM_5XX_RETRIES'];
  beforeAll(() => { process.env['VLLM_5XX_RETRIES'] = '1'; });
  afterAll(() => {
    if (previous === undefined) delete process.env['VLLM_5XX_RETRIES'];
    else process.env['VLLM_5XX_RETRIES'] = previous;
  });

  it('attaches the latency-tail guard Retry-After to the thrown error', async () => {
    const err = await requestAgainst((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify({
        error: {
          message: 'latency tail guard: no safe cold-prefill lane',
          type: 'latency_tail_guard',
          code: 'no_safe_cold_prefill_lane',
        },
      }));
    });
    expect(err.status).toBe(503);
    expect(retryAfterMsFromError(err)).toBe(5_000);
  }, 120_000);

  it('leaves the hint absent when the server does not send one', async () => {
    const err = await requestAgainst((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'overloaded', type: 'overloaded_error' } }));
    });
    expect(err.status).toBe(503);
    expect(retryAfterMsFromError(err)).toBeNull();
  }, 120_000);

  it('parses an HTTP-date Retry-After, not just delta-seconds', async () => {
    const err = await requestAgainst((_req, res) => {
      res.writeHead(503, {
        'content-type': 'application/json',
        // Kept short: the provider really sleeps this long before throwing, so a
        // 30s value would add 30s of dead wall-clock to every CI run.
        'retry-after': new Date(Date.now() + 8_000).toUTCString(),
      });
      res.end(JSON.stringify({ error: { message: 'overloaded' } }));
    });
    const ms = retryAfterMsFromError(err);
    expect(ms).not.toBeNull();
    // HTTP-date has second granularity, so allow slack on the round trip.
    expect(ms!).toBeGreaterThan(4_000);
    expect(ms!).toBeLessThanOrEqual(9_000);
  }, 120_000);
});
