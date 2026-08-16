import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VLlmProvider } from '../../src/provider/vllm.js';

const servers: Server[] = [];

async function modelServer(
  body: () => unknown,
  onRequest?: () => void,
): Promise<string> {
  const server = createServer((req, res) => {
    onRequest?.();
    if (req.url !== '/v1/models') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body()));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

describe('VLlmProvider live model discovery', () => {
  it('does not misread max_completion_tokens as a context window', async () => {
    const baseUrl = await modelServer(() => ({
      data: [{
        id: 'custom-model',
        top_provider: { max_completion_tokens: 4096 },
      }],
    }));
    const provider = new VLlmProvider(baseUrl, 131_072);

    expect(await provider.getServedModel('custom-model', { forceRefresh: true }))
      .toBe('custom-model');
    expect(provider.maxContextWindow).toBe(131_072);
  });

  it('never borrows data[0] metadata when the requested model is absent', async () => {
    const baseUrl = await modelServer(() => ({
      data: [{ id: 'model-a', max_model_len: 8192 }],
    }));
    const provider = new VLlmProvider(baseUrl, 131_072);

    expect(await provider.getServedModel('model-b', { forceRefresh: true }))
      .toBeUndefined();
    expect(provider.maxContextWindow).toBe(131_072);
  });

  it('force-refreshes deployment metadata while ordinary calls use a short cache', async () => {
    let contextWindow = 8192;
    let requests = 0;
    const baseUrl = await modelServer(
      () => ({ data: [{ id: 'model-a', max_model_len: contextWindow }] }),
      () => { requests++; },
    );
    const provider = new VLlmProvider(baseUrl, 131_072);

    expect(await provider.getServedModel('model-a')).toBe('model-a');
    expect(provider.maxContextWindow).toBe(8192);
    contextWindow = 16_384;
    expect(await provider.getServedModel('model-a')).toBe('model-a');
    expect(provider.maxContextWindow).toBe(8192);
    expect(requests).toBe(1);

    expect(await provider.getServedModel('model-a', { forceRefresh: true }))
      .toBe('model-a');
    expect(provider.maxContextWindow).toBe(16_384);
    expect(requests).toBe(2);
  });
});
