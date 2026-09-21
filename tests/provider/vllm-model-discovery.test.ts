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

  it('keeps last-known metadata when a force-refresh times out (shizuha1 2026-09-21)', async () => {
    const originalTimeout = process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'];
    process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'] = '80';
    const server = createServer((req, res) => {
      if (req.url !== '/v1/models') {
        res.writeHead(404).end();
        return;
      }
      if ((server as unknown as { hang?: boolean }).hang) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        data: [{ id: 'cortex/GLM-5.3-Flash', max_model_len: 500_000 }],
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = new VLlmProvider(`http://127.0.0.1:${port}`, 131_072);
      expect(await provider.getServedModel('cortex/GLM-5.3-Flash')).toBe('cortex/GLM-5.3-Flash');
      expect(provider.maxContextWindow).toBe(500_000);

      (server as unknown as { hang?: boolean }).hang = true;
      expect(await provider.getServedModel('cortex/GLM-5.3-Flash', { forceRefresh: true }))
        .toBe('cortex/GLM-5.3-Flash');
      expect(provider.maxContextWindow).toBe(500_000);
    } finally {
      if (originalTimeout == null) delete process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'];
      else process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'] = originalTimeout;
    }
  });

  it('keeps last-known metadata when /v1/models returns 5xx, but not when the model is gone', async () => {
    let mode: 'ok' | 'fail' | 'retired' = 'ok';
    const server = createServer((req, res) => {
      if (req.url !== '/v1/models') {
        res.writeHead(404).end();
        return;
      }
      if (mode === 'fail') {
        res.writeHead(503).end('unavailable');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(
        mode === 'retired'
          ? { data: [{ id: 'other-model', max_model_len: 8192 }] }
          : { data: [{ id: 'GLM-5.3-Flash', max_model_len: 500_000 }] },
      ));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const provider = new VLlmProvider(`http://127.0.0.1:${port}`, 131_072);

    expect(await provider.getServedModel('GLM-5.3-Flash')).toBe('GLM-5.3-Flash');
    expect(provider.maxContextWindow).toBe(500_000);

    mode = 'fail';
    expect(await provider.getServedModel('GLM-5.3-Flash', { forceRefresh: true }))
      .toBe('GLM-5.3-Flash');
    expect(provider.maxContextWindow).toBe(500_000);

    mode = 'retired';
    expect(await provider.getServedModel('GLM-5.3-Flash', { forceRefresh: true }))
      .toBeUndefined();
    // Do not import the other model's window.
    expect(provider.maxContextWindow).toBe(500_000);
  });
});
