import { describe, expect, it } from 'vitest';
import { GROK_VOICE_REALTIME_URL, type GrokVoiceAuth, type RealtimeEvent } from '../../src/provider/grok-voice.js';
import {
  GrokVoiceS2SSession,
  VOICE_S2S_SPOKEN_SUFFIX,
  isOurVoiceSessionUpdated,
  voiceS2SHistoryContext,
  voiceS2SSessionUpdate,
} from '../../src/voice-s2s/session.js';

class ScriptedBinary {
  sent: Array<string | Buffer> = [];
  private json: Array<(event: RealtimeEvent) => void> = [];
  auto?: (sent: string, emit: (event: RealtimeEvent) => void) => void;

  send(data: string | Buffer): void {
    this.sent.push(data);
    if (typeof data === 'string') {
      queueMicrotask(() => this.auto?.(data, (event) => this.emitJson(event)));
    }
  }
  close(): void {}
  onJson(cb: (event: RealtimeEvent) => void): void { this.json.push(cb); }
  onBinary(): void {}
  onError(): void {}
  onClose(): void {}
  emitJson(event: RealtimeEvent): void {
    for (const cb of this.json) cb(event);
  }
}

describe('voice S2S session contract', () => {
  it('puts SCLI tools on the realtime session, not Voice-proxy stubs', () => {
    const payload = voiceS2SSessionUpdate(
      'You are Hina.',
      [
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks', description: 'queue', inputSchema: { type: 'object', properties: {} } },
        { name: 'bash', description: 'shell', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
      ],
      24000,
    );
    const session = payload.session as {
      tools: Array<{ type: string; name?: string }>;
      turn_detection: { type: string };
      instructions: string;
    };
    const names = session.tools.map((tool) => tool.name || tool.type);
    expect(names.filter((name) => name === 'web_search')).toEqual(['web_search']);
    expect(names).toContain('pulse_get_my_tasks');
    expect(names).toContain('bash');
    expect(names).not.toContain('pulse_get_user_tasks');
    expect(session.tools.filter((tool) => tool.type === 'function' && tool.name === 'web_search')).toEqual([]);
    expect(session.turn_detection.type).toBe('server_vad');
    expect(session.instructions).toBe('You are Hina.');
    const audio = (payload.session as { audio?: { input?: { transcription?: { keyterms?: string[] } } } }).audio;
    expect(audio?.input?.transcription?.keyterms).toEqual(expect.arrayContaining(['Hina', 'Pulse', 'bash', 'seats']));
  });

  it('keeps prior turns in instructions so the socket stays audio', () => {
    const ctx = voiceS2SHistoryContext([
      { role: 'user', text: "What's on Pulse?" },
      { role: 'assistant', text: 'Checking.' },
    ]);
    expect(ctx).toContain("User: What's on Pulse?");
    expect(ctx).toContain('context only');
  });

  it('drops duplicate persist lines from spoken history', () => {
    const ctx = voiceS2SHistoryContext([
      { role: 'user', text: 'Can you hear me?' },
      { role: 'user', text: 'Can you hear me?' },
      { role: 'assistant', text: 'Yes, I can hear you.' },
      { role: 'assistant', text: 'Yes, I can hear you.' },
    ]);
    expect(ctx.match(/Can you hear me\?/g)).toHaveLength(1);
    expect(ctx.match(/Yes, I can hear you\./g)).toHaveLength(1);
  });

  it('executes function calls through the SCLI host and returns output on the same socket', async () => {
    const transport = new ScriptedBinary();
    transport.auto = (sent, emit) => {
      const parsed = JSON.parse(sent) as { type?: string };
      if (parsed.type === 'session.update') {
        emit({ type: 'session.updated', session: { instructions: VOICE_S2S_SPOKEN_SUFFIX } });
      }
    };
    const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
    const clientEvents: Array<Record<string, unknown>> = [];
    const session = new GrokVoiceS2SSession(
      {
        model: 'cortex/grok-voice-think-fast-2.0',
        instructions: 'You are Hina.',
        tools: [
          { name: 'mcp__shizuha-pulse__pulse_get_my_tasks', description: 'queue', inputSchema: { type: 'object', properties: {} } },
        ],
        executeTool: async (name, input) => {
          executed.push({ name, input });
          return 'PLS-1 inbox';
        },
      },
      {
        sendJson: (payload) => clientEvents.push(payload as Record<string, unknown>),
        sendBytes: () => {},
      },
      { sampleRate: 24000 },
      {
        connect: async () => transport,
        resolveAuth: async () => ({
          token: 't',
          url: GROK_VOICE_REALTIME_URL,
          model: 'grok-voice-think-fast-2.0',
        } satisfies GrokVoiceAuth),
      },
    );

    await session.startSession();
    expect(clientEvents[0]).toMatchObject({ type: 'ready', via: 'scli', transport: 's2s' });
    expect(String((transport.sent[0] as string))).toContain(VOICE_S2S_SPOKEN_SUFFIX);

    transport.emitJson({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'pulse_get_my_tasks',
      arguments: '{"limit":5}',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(executed).toEqual([{ name: 'mcp__shizuha-pulse__pulse_get_my_tasks', input: { limit: 5 } }]);
    const output = transport.sent.find((item) =>
      typeof item === 'string' && item.includes('function_call_output'),
    );
    expect(String(output)).toContain('PLS-1 inbox');
    expect(transport.sent.some((item) => typeof item === 'string' && item.includes('response.create'))).toBe(true);
    expect(clientEvents.some((event) => event.type === 'debug.tool')).toBe(true);
    session.close();
  });

  it('ignores the default session.updated until our config is echoed', async () => {
    const transport = new ScriptedBinary();
    let emit: ((event: RealtimeEvent) => void) | undefined;
    transport.auto = (sent, next) => {
      emit = next;
      const parsed = JSON.parse(sent) as { type?: string };
      if (parsed.type === 'session.update') {
        next({ type: 'session.updated', session: { voice: 'eve' } });
      }
    };
    const clientEvents: Array<Record<string, unknown>> = [];
    const session = new GrokVoiceS2SSession(
      {
        model: 'cortex/grok-voice-think-fast-2.0',
        instructions: 'You are Hina.',
        tools: [],
        executeTool: async () => '',
      },
      {
        sendJson: (payload) => clientEvents.push(payload as Record<string, unknown>),
        sendBytes: () => {},
      },
      { sampleRate: 24000 },
      {
        connect: async () => transport,
        resolveAuth: async () => ({
          token: 't',
          url: GROK_VOICE_REALTIME_URL,
          model: 'grok-voice-think-fast-2.0',
        } satisfies GrokVoiceAuth),
      },
    );
    const started = session.startSession();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clientEvents.some((event) => event.type === 'ready')).toBe(false);
    emit?.({
      type: 'session.updated',
      session: { instructions: `You are Hina.\n${VOICE_S2S_SPOKEN_SUFFIX}` },
    });
    await started;
    expect(clientEvents[0]).toMatchObject({ type: 'ready', via: 'scli' });
    expect(isOurVoiceSessionUpdated({ type: 'session.updated', session: { voice: 'eve' } })).toBe(false);
    session.close();
  });

  it('does not forward raw xAI error events as fatal Live errors', async () => {
    const transport = new ScriptedBinary();
    transport.auto = (sent, emit) => {
      const parsed = JSON.parse(sent) as { type?: string };
      if (parsed.type === 'session.update') {
        emit({ type: 'session.updated', session: { instructions: VOICE_S2S_SPOKEN_SUFFIX } });
      }
    };
    const clientEvents: Array<Record<string, unknown>> = [];
    const session = new GrokVoiceS2SSession(
      {
        model: 'cortex/grok-voice-think-fast-2.0',
        instructions: 'You are Hina.',
        tools: [],
        executeTool: async () => '',
      },
      {
        sendJson: (payload) => clientEvents.push(payload as Record<string, unknown>),
        sendBytes: () => {},
      },
      { sampleRate: 24000 },
      {
        connect: async () => transport,
        resolveAuth: async () => ({
          token: 't',
          url: GROK_VOICE_REALTIME_URL,
          model: 'grok-voice-think-fast-2.0',
        } satisfies GrokVoiceAuth),
      },
    );
    await session.startSession();
    transport.emitJson({ type: 'error', error: { message: 'tool schema rejected' } });
    expect(clientEvents.some((event) => event.type === 'error')).toBe(false);
    expect(clientEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'debug.upstream_error', message: 'tool schema rejected' }),
    ]));
    session.close();
  });
});
