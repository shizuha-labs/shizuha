import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { VLlmProvider } from '../../src/provider/vllm.js';

async function budget(model: string, window: number, repeats: number, catalog: object[] = []) {
  const posted: any[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: catalog })); return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    posted.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"accepted"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let failure: Error | undefined;
  const chunks: any[] = [];
  try {
    const provider = new VLlmProvider(`http://127.0.0.1:${(server.address() as any).port}`, window, 'fixture', 'cortex');
    try {
      for await (const chunk of provider.chat([{ role: 'user', content: 'witness '.repeat(repeats) }],
        { model, maxTokens: 8192 })) chunks.push(chunk);
    } catch (err) { failure = err as Error; }
    return { posted, failure, chunks };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('per-model wire context budget', () => {
  it('sends a known 500k model prompt when the unavailable catalog cannot advertise it', async () => {
    const result = await budget('grok-4.7', 131072, 120000);
    expect(result.failure).toBeUndefined();
    expect(result.posted).toHaveLength(1);
    expect(result.posted[0]).toMatchObject({ model: 'grok-4.7', max_tokens: 8192 });
    expect(result.chunks.some(c => c.type === 'text' && c.text === 'accepted')).toBe(true);
  });

  it.each([64000, 131072])('preserves an unknown model conservative window %i', async window => {
    const result = await budget('unknown-budget-fixture', window, 120000);
    expect(result.posted).toHaveLength(0);
    expect(result.failure?.message).toContain(`served max_model_len=${window}`);
  });

  it('respects a real smaller discovered window for a known larger model', async () => {
    const result = await budget('grok-4.7', 500000, 120000, [{ id: 'grok-4.7', max_model_len: 65536 }]);
    expect(result.posted).toHaveLength(0);
    expect(result.failure?.message).toContain('served max_model_len=65536');
  });

  it('does not inflate a known model budget from an unrelated larger global window', async () => {
    const result = await budget('grok-4.7', 1000000, 350000);
    expect(result.posted).toHaveLength(0);
    expect(result.failure?.message).toContain('served max_model_len=500000');
  });

  it('still clamps output to the remaining discovered per-model budget', async () => {
    const result = await budget('grok-4.7', 500000, 2100, [{ id: 'grok-4.7', max_model_len: 4096 }]);
    expect(result.failure).toBeUndefined();
    expect(result.posted).toHaveLength(1);
    expect(result.posted[0].max_tokens).toBeGreaterThanOrEqual(512);
    expect(result.posted[0].max_tokens).toBeLessThan(8192);
    expect(result.posted[0].max_tokens).toBeLessThan(4096);
  });
});
