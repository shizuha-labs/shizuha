import { describe, it, expect, vi } from 'vitest';
import {
  GrokVoiceProvider,
  GROK_VOICE_REALTIME_URL,
  GROK_VOICE_UPSTREAM_MODEL,
  isGrokVoiceOmniModel,
  messagesToRealtimeItems,
  normalizeGrokVoiceModel,
  RealtimeTurnAccumulator,
  classifyGrokVoiceFailure,
  GROK_VOICE_CREDITS_MESSAGE,
  isUsableGrokVoiceBearer,
  resolveGrokVoiceAuth,
  trailingToolResults,
  toolsToRealtimeFunctions,
  type RealtimeEvent,
  type RealtimeTransport,
} from '../../src/provider/grok-voice.js';
import { getModelProfile } from '../../src/provider/model-profile.js';
import { ProviderRegistry, isCortexModelId } from '../../src/provider/registry.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

const mockConfig = {
  agent: { defaultModel: 'codex-mini-latest', maxTurns: 0, maxContextTokens: 128000, temperature: 0, maxOutputTokens: 16384, cwd: '/tmp' },
  providers: { ollama: { baseUrl: 'http://localhost:11434' } },
  permissions: { mode: 'supervised', rules: [] },
  mcp: { servers: [] },
  skills: { trustProjectSkills: false },
  logging: { level: 'info' },
} as ShizuhaConfig;

class ScriptedTransport implements RealtimeTransport {
  sent: Array<Record<string, unknown>> = [];
  private messages: Array<(data: string) => void> = [];
  auto?: (sent: Record<string, unknown>, emit: (event: RealtimeEvent) => void) => void;

  send(data: string): void {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(parsed);
    queueMicrotask(() => this.auto?.(parsed, (event) => this.emit(event)));
  }
  close(): void {}
  onMessage(cb: (data: string) => void): void { this.messages.push(cb); }
  onOpen(): void {}
  onError(): void {}
  onClose(): void {}
  emit(event: RealtimeEvent): void {
    const raw = JSON.stringify(event);
    for (const cb of this.messages) cb(raw);
  }
}

describe('Grok Voice model classification', () => {
  it('recognizes official aliases and Cortex/xAI prefixes', () => {
    for (const id of [
      'grok-voice-think-fast-2.0',
      'grok-voice-latest',
      'cortex/grok-voice-think-fast-2.0',
      'cortex/grok-voice-latest',
      'xai:grok-voice-think-fast-2.0',
      'xai/grok-voice-latest',
      'cortex/xai/grok-voice-think-fast-2.0',
    ]) {
      expect(isGrokVoiceOmniModel(id)).toBe(true);
    }
    expect(isGrokVoiceOmniModel('grok-4.6')).toBe(false);
    expect(isGrokVoiceOmniModel('cortex/grok-4.6')).toBe(false);
    expect(isGrokVoiceOmniModel('xai/grok-4.5')).toBe(false);
  });

  it('pins grok-voice-latest to think-fast-2.0', () => {
    expect(normalizeGrokVoiceModel('grok-voice-latest')).toBe(GROK_VOICE_UPSTREAM_MODEL);
    expect(normalizeGrokVoiceModel('cortex/grok-voice-latest')).toBe(GROK_VOICE_UPSTREAM_MODEL);
    expect(normalizeGrokVoiceModel('cortex/grok-voice-think-fast-2.0')).toBe(GROK_VOICE_UPSTREAM_MODEL);
  });

  it('is excluded from Cortex chat/completions routing', () => {
    expect(isCortexModelId('grok-voice-think-fast-2.0')).toBe(false);
    expect(isCortexModelId('cortex/grok-voice-think-fast-2.0')).toBe(false);
    expect(isCortexModelId('grok-4.6')).toBe(true);
    expect(isCortexModelId('cortex/grok-4.6')).toBe(true);
  });
});

describe('Grok Voice registry routing', () => {
  it('routes every voice spelling to the grok-voice provider, not cortex/xai', () => {
    const registry = new ProviderRegistry(mockConfig);
    expect(registry.list()).toContain('grok-voice');
    for (const id of [
      'grok-voice-think-fast-2.0',
      'cortex/grok-voice-think-fast-2.0',
      'grok-voice-latest',
      'xai:grok-voice-think-fast-2.0',
      'xai/grok-voice-latest',
    ]) {
      const resolved = registry.resolveWithModel(id);
      expect(resolved.provider.name).toBe('grok-voice');
      expect(resolved.resolvedModel).toBe(GROK_VOICE_UPSTREAM_MODEL);
    }
    expect(registry.resolveWithModel('grok-4.6').provider.name).toBe('cortex');
  });
});

describe('Grok Voice tool + history mapping', () => {
  it('maps SCLI ToolDefinition to realtime function tools', () => {
    const tools = toolsToRealtimeFunctions([
      { name: 'bash', description: 'Run a shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    ]);
    expect(tools).toEqual([{
      type: 'function',
      name: 'bash',
      description: 'Run a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }]);
  });

  it('makes optional ToolSearch fields strict so xAI realtime accepts the schema', () => {
    const tools = toolsToRealtimeFunctions([
      {
        name: 'ToolSearch',
        description: 'Search deferred tools',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'keywords' },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              default: 3,
              description: 'cap',
            },
          },
          required: ['query'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
        },
      },
    ]);
    expect(tools[0]?.name).toBe('search_deferred_tools');
    expect(tools[0]?.parameters).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords' },
        max_results: {
          type: 'number',
          description: 'cap',
        },
      },
      required: ['query', 'max_results'],
    });
    expect(tools[0]?.parameters).not.toHaveProperty('additionalProperties');
  });

  it('replays user/assistant text and function call + output items', () => {
    const items = messagesToRealtimeItems([
      { role: 'system', content: 'You are Hina.' },
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      { role: 'tool', content: 'README.md', toolCallId: 'c1' },
    ]);
    expect(items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
      { type: 'function_call_output', call_id: 'c1', output: 'README.md' },
    ]);
  });

  it('collects trailing tool results for the same-session follow-up', () => {
    expect(trailingToolResults([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1' },
      { role: 'tool', content: 'also', toolCallId: 'c2' },
    ])).toEqual([
      { callId: 'c1', output: 'ok' },
      { callId: 'c2', output: 'also' },
    ]);
  });
});

describe('RealtimeTurnAccumulator', () => {
  it('maps transcript deltas and function_call_arguments.done onto StreamChunk', () => {
    const acc = new RealtimeTurnAccumulator();
    expect(acc.apply({ type: 'response.output_text.delta', delta: 'Hello' })).toEqual([
      { type: 'text', text: 'Hello' },
    ]);
    const start = acc.apply({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'bash',
      arguments: '{"command":"pwd"}',
    });
    expect(start[0]).toEqual({ type: 'tool_use_start', id: 'c1', name: 'bash' });
    expect(start.at(-1)).toEqual({ type: 'tool_use_end', id: 'c1', input: { command: 'pwd' } });
    const done = acc.apply({ type: 'response.done', usage: { input_tokens: 11, output_tokens: 4 } });
    expect(done).toEqual([
      { type: 'usage', inputTokens: 11, outputTokens: 4 },
      { type: 'done' },
    ]);
    expect(acc.finished).toBe(true);
  });

  it('surfaces realtime error events', () => {
    const acc = new RealtimeTurnAccumulator();
    acc.apply({ type: 'error', error: { message: 'model_not_found' } });
    expect(acc.finished).toBe(true);
    expect(acc.error?.message).toMatch(/model_not_found/);
  });
});

describe('resolveGrokVoiceAuth', () => {
  it('prefers XAI_API_KEY and never hits Cortex', async () => {
    const fetchImpl = vi.fn();
    const auth = await resolveGrokVoiceAuth({
      model: 'cortex/grok-voice-latest',
      xaiApiKey: 'xai-direct',
      cortexToken: 'sk-cortex-unused',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(auth).toEqual({
      token: 'xai-direct',
      url: GROK_VOICE_REALTIME_URL,
      model: GROK_VOICE_UPSTREAM_MODEL,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('mints a Cortex realtime session when there is no XAI_API_KEY', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'eph-1',
        upstream_url: GROK_VOICE_REALTIME_URL,
        model: GROK_VOICE_UPSTREAM_MODEL,
      }),
    }));
    const auth = await resolveGrokVoiceAuth({
      model: 'grok-voice-think-fast-2.0',
      cortexBaseUrl: 'https://cortex.example/v1',
      cortexToken: 'sk-cortex-agent',
      xaiApiKey: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(auth.token).toBe('eph-1');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://cortex.example/v1/audio/realtime/stream-session');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-cortex-agent' });
  });

  it('fails loud on Cortex 402 credits instead of handing a JWT to xAI', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({
        error: 'Grok Voice is out of credits on the xAI subscription. Add credits at grok.com or attach a funded xAI API key in Cortex.',
      }),
    }));
    await expect(resolveGrokVoiceAuth({
      model: 'grok-voice-think-fast-2.0',
      cortexBaseUrl: 'https://cortex.example',
      cortexToken: 'sk-cortex-agent',
      xaiApiKey: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({
      name: 'GrokVoiceAuthError',
      code: 'out_of_credits',
      message: GROK_VOICE_CREDITS_MESSAGE,
    });
  });

  it('does not stringify a DRF error object as [object Object]', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({
        error: { message: 'Grok Voice realtime mint failed (503).', type: 'server_error' },
      }),
    }));
    await expect(resolveGrokVoiceAuth({
      model: 'grok-voice-think-fast-2.0',
      cortexToken: 'sk-cortex-agent',
      xaiApiKey: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({
      name: 'GrokVoiceAuthError',
      code: 'mint_failed',
      message: expect.stringContaining('Grok Voice realtime mint failed (503).'),
    });
  });

  it('rejects a minted OAuth JWT so Live cannot 403-loop', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'eyJhbGciOiJIUzI1NiJ9.e30.sig' }),
    }));
    await expect(resolveGrokVoiceAuth({
      model: 'grok-voice-think-fast-2.0',
      cortexToken: 'sk-cortex-agent',
      xaiApiKey: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: 'out_of_credits' });
    expect(isUsableGrokVoiceBearer('eyJhbGciOiJIUzI1NiJ9.e30.sig')).toBe(false);
    expect(isUsableGrokVoiceBearer('xai-funded')).toBe(true);
    expect(classifyGrokVoiceFailure(new Error('Unexpected server response: 403')).code).toBe('out_of_credits');
  });

  it('mints from CORTEX_API_KEY when callers omit cortexToken (Live S2S)', async () => {
    const prevKey = process.env['CORTEX_API_KEY'];
    const prevBase = process.env['CORTEX_BASE_URL'];
    process.env['CORTEX_API_KEY'] = 'sk-cortex-env';
    process.env['CORTEX_BASE_URL'] = 'http://shizuha-cortex.shizuha-cortex.svc.cluster.local:8040';
    try {
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'eph-env' }),
      }));
      const auth = await resolveGrokVoiceAuth({
        model: 'cortex/grok-voice-think-fast-2.0',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(auth.token).toBe('eph-env');
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(String(url)).toContain('/v1/audio/realtime/stream-session');
      expect(String(url)).toContain('shizuha-cortex');
      expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-cortex-env' });
    } finally {
      if (prevKey === undefined) delete process.env['CORTEX_API_KEY'];
      else process.env['CORTEX_API_KEY'] = prevKey;
      if (prevBase === undefined) delete process.env['CORTEX_BASE_URL'];
      else process.env['CORTEX_BASE_URL'] = prevBase;
    }
  });
});

describe('GrokVoiceProvider.chat', () => {
  it('sends a text turn over realtime and yields StreamChunks executeTurn already understands', async () => {
    const transport = new ScriptedTransport();
    transport.auto = (sent, emit) => {
      if (sent.type === 'session.update') emit({ type: 'session.updated' });
      if (sent.type === 'response.create') {
        emit({ type: 'response.output_text.delta', delta: 'Hi there' });
        emit({ type: 'response.done' });
      }
    };
    const provider = new GrokVoiceProvider({
      connect: async () => transport,
      resolveAuth: async () => ({ token: 't', url: GROK_VOICE_REALTIME_URL, model: GROK_VOICE_UPSTREAM_MODEL }),
    });
    const chunks = [];
    for await (const chunk of provider.chat(
      [{ role: 'user', content: 'hello' }],
      {
        model: 'cortex/grok-voice-think-fast-2.0',
        systemPrompt: 'You are Hina.',
        tools: [{ name: 'bash', description: 'shell', inputSchema: { type: 'object', properties: {} } }],
      },
    )) {
      chunks.push(chunk);
    }
    expect(transport.sent[0]).toMatchObject({
      type: 'session.update',
      session: {
        instructions: 'You are Hina.',
        turn_detection: null,
        tools: [{ type: 'function', name: 'bash' }],
      },
    });
    expect(transport.sent).toEqual(expect.arrayContaining([
      { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
      { type: 'response.create' },
    ]));
    expect(chunks).toEqual([
      { type: 'text', text: 'Hi there' },
      { type: 'done' },
    ]);
  });

  it('reuses the live session for function_call_output so SCLI tool loops work', async () => {
    const transport = new ScriptedTransport();
    let connects = 0;
    let creates = 0;
    transport.auto = (sent, emit) => {
      if (sent.type === 'session.update') emit({ type: 'session.updated' });
      if (sent.type === 'response.create') {
        creates += 1;
        if (creates === 1) {
          emit({
            type: 'response.function_call_arguments.done',
            call_id: 'c1',
            name: 'bash',
            arguments: '{"command":"ls"}',
          });
          emit({ type: 'response.done' });
        } else {
          emit({ type: 'response.output_text.delta', delta: 'README.md' });
          emit({ type: 'response.done' });
        }
      }
    };
    const provider = new GrokVoiceProvider({
      connect: async () => {
        connects += 1;
        return transport;
      },
      resolveAuth: async () => ({ token: 't', url: GROK_VOICE_REALTIME_URL, model: GROK_VOICE_UPSTREAM_MODEL }),
    });
    const first = [];
    for await (const chunk of provider.chat(
      [{ role: 'user', content: 'list files' }],
      { model: GROK_VOICE_UPSTREAM_MODEL, sessionId: 'sess-1', tools: [{ name: 'bash', description: 'shell', inputSchema: {} }] },
    )) first.push(chunk);
    expect(first.some((c) => c.type === 'tool_use_end' && c.id === 'c1')).toBe(true);

    const second = [];
    for await (const chunk of provider.chat(
      [
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } }] },
        { role: 'tool', content: 'README.md', toolCallId: 'c1' },
      ],
      { model: GROK_VOICE_UPSTREAM_MODEL, sessionId: 'sess-1' },
    )) second.push(chunk);

    expect(connects).toBe(1);
    expect(transport.sent).toEqual(expect.arrayContaining([
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: 'c1', output: 'README.md' },
      },
    ]));
    expect(second).toEqual([
      { type: 'text', text: 'README.md' },
      { type: 'done' },
    ]);
  });
});

describe('Grok Voice model profile', () => {
  it('does not inherit the SuperGrok 500K chat profile', () => {
    const voice = getModelProfile('cortex/grok-voice-think-fast-2.0');
    expect(voice.displayName).toBe('Grok Voice Think Fast');
    expect(voice.nativeContextWindow).toBe(128000);
    expect(getModelProfile('grok-4.6').nativeContextWindow).toBe(500000);
  });
});
