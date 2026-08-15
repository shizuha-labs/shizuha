import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import {
  LOCAL_CORE_PROTOCOL_VERSION,
  LocalCoreClient,
  parseCoreStreamEvent,
  parseHealthResponse,
  parseProviderConfigState,
  signLocalCoreServerProof,
  StructuredCoreError,
} from '../src/local-core-protocol.js';

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected TCP address');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

describe('local core protocol', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses the required health response shape', () => {
    const health = parseHealthResponse({
      version: '0.1.0',
      protocol_version: LOCAL_CORE_PROTOCOL_VERSION,
      auth_status: 'local',
      available_providers: ['cortex'],
      capabilities: { sessions: true },
    });

    expect(health.protocol_version).toBe(LOCAL_CORE_PROTOCOL_VERSION);
    expect(health.available_providers).toEqual(['cortex']);
    expect(() => parseHealthResponse({ version: '0.1.0' })).toThrow(/protocol_version/);
  });

  it('reports protocol mismatches as upgrade-required instead of silently degrading', async () => {
    const client = new LocalCoreClient({
      endpoint: 'http://local.test',
      expectedProtocolVersion: LOCAL_CORE_PROTOCOL_VERSION,
      fetchImpl: (async () => new Response(JSON.stringify({
        version: '0.1.0',
        protocol_version: 'older-protocol',
        auth_status: 'local',
        available_providers: [],
        capabilities: {},
      }), { status: 200 })) as typeof fetch,
    });

    await expect(client.connect()).resolves.toMatchObject({
      kind: 'upgrade_required',
      expected: LOCAL_CORE_PROTOCOL_VERSION,
      actual: 'older-protocol',
    });
  });

  it('rejects a rogue first loopback binder before any provider-secret request', async () => {
    let providerConfigRequests = 0;
    const client = new LocalCoreClient({
      endpoint: 'http://127.0.0.1:8015',
      capability: 'r'.repeat(43),
      fetchImpl: (async (url: string) => {
        if (url.endsWith('/config/providers')) providerConfigRequests += 1;
        return new Response(JSON.stringify({
          version: '0.1.0',
          protocol_version: LOCAL_CORE_PROTOCOL_VERSION,
          auth_status: 'local',
          available_providers: [],
          capabilities: {},
          // Deliberately no valid server_proof: a port owner is not identity.
        }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.connect()).resolves.toMatchObject({ kind: 'permanent_error' });
    expect(providerConfigRequests).toBe(0);
  });

  it('proves the genuine core before adding per-request capability MACs', async () => {
    const capability = 'g'.repeat(43);
    let authenticated = false;
    const client = new LocalCoreClient({
      endpoint: 'http://local.test',
      capability,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (url.endsWith('/health')) {
          const nonce = headers.get('x-shizuha-local-core-nonce')!;
          return new Response(JSON.stringify({
            version: '0.1.0', protocol_version: LOCAL_CORE_PROTOCOL_VERSION,
            auth_status: 'authenticated', available_providers: [], capabilities: {},
            server_proof: await signLocalCoreServerProof(capability, nonce),
          }), { status: 200 });
        }
        authenticated = /^[0-9a-f]{64}$/.test(headers.get('x-shizuha-local-core-auth') || '')
          && !!headers.get('x-shizuha-local-core-nonce');
        return new Response(JSON.stringify({ providers: [], capabilities: {} }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.connect()).resolves.toMatchObject({ kind: 'connected' });
    await client.getProviderConfig();
    expect(authenticated).toBe(true);
  });

  it('retries unavailable core connections before returning not-connected', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = new LocalCoreClient({
      endpoint: 'http://local.test',
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNREFUSED');
        return new Response(JSON.stringify({
          version: '0.1.0',
          protocol_version: LOCAL_CORE_PROTOCOL_VERSION,
          auth_status: 'local',
          available_providers: [],
          capabilities: { sessions: true },
        }), { status: 200 });
      }) as typeof fetch,
    });

    const pending = client.connectWithRetry(3, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ kind: 'connected' });
    expect(calls).toBe(3);
  });

  it('activates against a stub local core health + session API', async () => {
    const seen: { deleted?: string; workspace?: string } = {};
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          version: '0.1.0',
          protocol_version: LOCAL_CORE_PROTOCOL_VERSION,
          auth_status: 'local',
          available_providers: ['cortex'],
          capabilities: { sessions: true },
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/sessions') {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => {
          seen.workspace = JSON.parse(body).workspace_root_uri;
          res.statusCode = 201;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            session_id: 'session-1',
            workspace_root_uri: seen.workspace,
            protocol_version: LOCAL_CORE_PROTOCOL_VERSION,
            resumed: false,
          }));
        });
        return;
      }
      if (req.method === 'DELETE' && req.url === '/sessions/session-1') {
        seen.deleted = 'session-1';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'missing', retryable: false }));
    });
    const endpoint = await listen(server);
    try {
      const client = new LocalCoreClient({ endpoint });
      await expect(client.connect()).resolves.toMatchObject({ kind: 'connected' });
      await expect(client.createSession('file:///workspace/example')).resolves.toMatchObject({
        session_id: 'session-1',
        workspace_root_uri: 'file:///workspace/example',
        resumed: false,
      });
      await client.deleteSession('session-1');
      expect(seen.workspace).toBe('file:///workspace/example');
      expect(seen.deleted).toBe('session-1');
    } finally {
      await close(server);
    }
  });


  it('submits messages through the implemented streaming query endpoint and forwards runtime secret refs', async () => {
    const seen: { message?: unknown; cancelled?: boolean } = {};
    const events: unknown[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/query/stream') {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => {
          seen.message = JSON.parse(body);
          res.statusCode = 200;
          res.setHeader('content-type', 'text/event-stream');
          res.end('event: content\ndata: {"type":"content","text":"hi"}\n\nevent: complete\ndata: {"type":"complete","totalTurns":1}\n\n');
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/sessions/session-1/cancel') {
        seen.cancelled = true;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'missing', retryable: false }));
    });
    const endpoint = await listen(server);
    try {
      const client = new LocalCoreClient({ endpoint });
      await client.submitMessage('session-1', {
        content: 'hello',
        model: 'glm',
        provider: 'cortex',
        provider_secret_values: { 'vscode:secret.cortex': 'sk-runtime' },
        context_attachments: [],
      }, (event) => events.push(event));
      await expect(client.cancelRun('session-1')).resolves.toMatchObject({ ok: true, status: 'cancelled' });
      expect(seen.message).toEqual({
        prompt: 'hello',
        sessionId: 'session-1',
        extension_mode: true,
        permissionMode: 'plan',
        model: 'glm',
        provider: 'cortex',
        provider_secret_values: { 'vscode:secret.cortex': 'sk-runtime' },
      });
      expect(events).toEqual([{ type: 'token', text: 'hi' }, { type: 'done' }]);
      expect(seen.cancelled).toBe(true);
    } finally {
      await close(server);
    }
  });



  it('returns explicit cancellation acknowledgements and structured cancel errors', async () => {
    const ok = new LocalCoreClient({
      endpoint: 'http://local.test',
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, status: 'cancelling', message: 'cancel accepted', request_id: 'req-cancel' }), { status: 202 })) as typeof fetch,
    });
    await expect(ok.cancelRun('session-2')).resolves.toEqual({
      ok: true,
      status: 'cancelling',
      message: 'cancel accepted',
      request_id: 'req-cancel',
    });

    const rejected = new LocalCoreClient({
      endpoint: 'http://local.test',
      fetchImpl: (async () => new Response(JSON.stringify({ code: 'CANCEL_REJECTED', message: 'not running', retryable: false, request_id: 'req-nope' }), { status: 409 })) as typeof fetch,
    });
    await expect(rejected.cancelRun('session-3')).rejects.toMatchObject({
      code: 'CANCEL_REJECTED',
      retryable: false,
      requestId: 'req-nope',
      status: 409,
    });
  });


  it('round-trips provider/model configuration through the local core config API', async () => {
    const seen: { config?: unknown } = {};
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/config/providers') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          default_model: 'glm-4.5',
          providers: [{ provider: 'cortex', model: 'glm-4.5', base_url: 'https://cortex.shizuha.com/v1', has_api_key: true }],
          capabilities: { config_api: true, config_scope: 'session-scoped', secret_ref_resolution: 'vscode-secret-ref-extension-mediated-followup' },
        }));
        return;
      }
      if (req.method === 'PUT' && req.url === '/config/providers/default') {
        let body = '';
        req.on('data', (chunk) => { body += String(chunk); });
        req.on('end', () => {
          seen.config = JSON.parse(body);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            default_provider: 'openai-compatible',
            default_model: 'gpt-oss-120b',
            providers: [
              { provider: 'cortex', model: 'glm-4.5', base_url: 'https://cortex.shizuha.com/v1', has_api_key: true },
              { provider: 'openai-compatible', model: 'gpt-oss-120b', base_url: 'http://127.0.0.1:8080/v1', api_key_secret_ref: 'vscode:shizuha.provider.openai-compatible.gpt-oss-120b.apiKey', has_api_key: true },
            ],
            capabilities: { config_api: true, config_scope: 'session-scoped', secret_ref_resolution: 'vscode-secret-ref-extension-mediated-followup' },
          }));
        });
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'missing', retryable: false }));
    });
    const endpoint = await listen(server);
    try {
      const client = new LocalCoreClient({ endpoint });
      await expect(client.getProviderConfig()).resolves.toMatchObject({
        default_model: 'glm-4.5',
        providers: [{ provider: 'cortex', model: 'glm-4.5' }],
        capabilities: { config_scope: 'session-scoped' },
      });
      const updated = await client.setProviderConfig({
        provider: 'openai-compatible',
        model: 'gpt-oss-120b',
        base_url: 'http://127.0.0.1:8080/v1',
        api_key_secret_ref: 'vscode:shizuha.provider.openai-compatible.gpt-oss-120b.apiKey',
      });
      expect(updated).toMatchObject({
        default_provider: 'openai-compatible',
        default_model: 'gpt-oss-120b',
        providers: [{ provider: 'cortex' }, { provider: 'openai-compatible', has_api_key: true }],
        capabilities: { secret_ref_resolution: 'vscode-secret-ref-extension-mediated-followup' },
      });
      expect(seen.config).toEqual({
        provider: 'openai-compatible',
        model: 'gpt-oss-120b',
        base_url: 'http://127.0.0.1:8080/v1',
        api_key_secret_ref: 'vscode:shizuha.provider.openai-compatible.gpt-oss-120b.apiKey',
      });
      expect(JSON.stringify(seen.config)).not.toContain('sk-');
    } finally {
      await close(server);
    }
  });

  it('parses Cortex and Anthropic provider config shapes without secret values', () => {
    const parsed = parseProviderConfigState({
      default_provider: 'anthropic',
      default_model: 'claude-sonnet-4-6',
      providers: [
        { provider: 'cortex', model: 'glm-4.5', base_url: 'https://cortex.shizuha.com/v1', has_api_key: true },
        { provider: 'anthropic', model: 'claude-sonnet-4-6', api_key_secret_ref: 'vscode:shizuha.provider.anthropic.claude-sonnet-4-6.apiKey', has_api_key: true },
      ],
      capabilities: { config_api: true },
    });
    expect(parsed.providers.map((provider) => provider.provider)).toEqual(['cortex', 'anthropic']);
    expect(JSON.stringify(parsed)).not.toContain('sk-ant');
  });

  it('parses local core stream events used by the chat webview', () => {
    expect(parseCoreStreamEvent('{"type":"token","text":"hi"}')).toEqual({ type: 'token', text: 'hi' });
    expect(parseCoreStreamEvent({ type: 'tool_result', id: 't1', name: 'grep', payload: { ok: true } })).toEqual({
      type: 'tool_result',
      id: 't1',
      name: 'grep',
      content: { ok: true },
    });
    expect(parseCoreStreamEvent({ type: 'error', code: 'RATE_LIMIT', message: 'slow down', retryable: true })).toEqual({
      type: 'error',
      error: { code: 'RATE_LIMIT', message: 'slow down', retryable: true, details: undefined, request_id: undefined },
    });
    expect(parseCoreStreamEvent({ type: 'done' })).toEqual({ type: 'done' });
  });

  it('surfaces structured non-retryable core errors', async () => {
    const client = new LocalCoreClient({
      endpoint: 'http://local.test',
      fetchImpl: (async () => new Response(JSON.stringify({
        code: 'BAD_WORKSPACE',
        message: 'Workspace is invalid',
        retryable: false,
        request_id: 'req-1',
      }), { status: 400 })) as typeof fetch,
    });

    await expect(client.health()).rejects.toMatchObject({
      code: 'BAD_WORKSPACE',
      retryable: false,
      requestId: 'req-1',
    } satisfies Partial<StructuredCoreError>);
    await expect(client.connect()).resolves.toMatchObject({ kind: 'permanent_error' });
  });

  it('parses diff_proposed events from SSE rows', () => {
    const event = parseCoreStreamEvent({ type: 'diff_proposed', diff: { file_path: '/tmp/test.ts', original_content: 'a', proposed_content: 'b', description: 'Update', language: 'typescript' } });
    expect(event).toEqual({
      type: 'diff_proposed',
      diff: { file_path: '/tmp/test.ts', original_content: 'a', proposed_content: 'b', description: 'Update', language: 'typescript', unsupported: false, unsupported_reason: undefined },
    });
  });

  it('parses diff_proposed with unsupported flag', () => {
    const event = parseCoreStreamEvent({ type: 'diff_proposed', diff: { file_path: '/tmp/large.bin', proposed_content: '', unsupported: true, unsupported_reason: 'Binary file.' } });
    expect(event).toEqual({
      type: 'diff_proposed',
      diff: { file_path: '/tmp/large.bin', proposed_content: '', unsupported: true, unsupported_reason: 'Binary file.', original_content: undefined, description: undefined, language: undefined },
    });
  });

  it('parses diff_proposed with flat row (no nested diff key)', () => {
    const event = parseCoreStreamEvent({ type: 'diff_proposed', file_path: '/tmp/test.ts', proposed_content: 'new content' });
    expect(event).toEqual({
      type: 'diff_proposed',
      diff: { file_path: '/tmp/test.ts', proposed_content: 'new content', original_content: undefined, description: undefined, language: undefined, unsupported: false, unsupported_reason: undefined },
    });
  });

  it('applies diff via LocalCoreClient', async () => {
    const client = new LocalCoreClient({
      endpoint: 'http://local.test',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        expect(url).toBe('http://local.test/sessions/session-1/diffs/apply');
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ file_path: '/tmp/test.ts', action: 'accepted' });
        return new Response(JSON.stringify({ ok: true, file_path: '/tmp/test.ts', action: 'accepted' }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await client.applyDiff('session-1', '/tmp/test.ts', 'accepted');
    expect(result).toMatchObject({ ok: true, file_path: '/tmp/test.ts', action: 'accepted' });
  });
});
