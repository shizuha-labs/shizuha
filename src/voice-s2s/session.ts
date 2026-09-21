// @ts-ignore — this repo does not ship @types/ws (same as grok-voice)
import WebSocket from 'ws';
import {
  isGrokVoiceOmniModel,
  normalizeGrokVoiceModel,
  resolveGrokVoiceAuth,
  GROK_VOICE_REALTIME_URL,
  type GrokVoiceAuth,
  type RealtimeEvent,
} from '../provider/grok-voice.js';
import type { ToolDefinition } from '../tools/types.js';
import { logger } from '../utils/logger.js';
import {
  advertiseVoiceS2STools,
  clipVoiceToolOutput,
  resolveVoiceS2SToolName,
  type VoiceS2SProfile,
} from './tools.js';

export interface VoiceS2SHost {
  model: string;
  instructions: string;
  tools: ToolDefinition[];
  profile?: VoiceS2SProfile;
  executeTool(name: string, input: Record<string, unknown>): Promise<string>;
}

export interface VoiceS2SClient {
  sendJson(payload: unknown): void;
  sendBytes(buf: Buffer): void;
}

export interface VoiceS2SStart {
  sampleRate: number;
  history?: Array<{ role?: string; text?: string }>;
  conversationId?: string;
}

export const VOICE_S2S_SPOKEN_SUFFIX = [
  'You are in a live speech-to-speech call on the SCLI realtime path.',
  'Keep replies short and spoken-friendly. Never read tool_call markup aloud.',
  'If the last user line is one word or unclear, ask them to repeat — do not guess.',
  'When they ask whether you can run a tool, actually call it and say the result.',
  'Use your Pulse, Wiki, Hive, and bash tools when the caller asks about tasks,',
  'company knowledge, the fleet, or anything you would look up on a text turn.',
].join(' ');

export const VOICE_S2S_CODE_SUFFIX = [
  'You are in a live speech-to-speech coding call on the SCLI realtime path (Shizuha Desktop).',
  'Keep replies short and spoken-friendly. Never read diffs, patches, or tool markup aloud.',
  'If the last user line is one word or unclear, ask them to repeat — do not guess.',
  'When they ask you to change code, actually use your file tools, then summarize what you did.',
  'Ask before destructive commands (rm, force-push, drop, overwrite of unrelated files).',
].join(' ');

export function voiceS2SSpokenSuffix(profile?: VoiceS2SProfile): string {
  return profile === 'code' ? VOICE_S2S_CODE_SUFFIX : VOICE_S2S_SPOKEN_SUFFIX;
}

export function isOurVoiceSessionUpdated(event: RealtimeEvent): boolean {
  if (event.type !== 'session.updated') return false;
  const session = (event.session && typeof event.session === 'object')
    ? event.session as { instructions?: unknown; tools?: unknown }
    : {};
  const instructions = String(session.instructions || '');
  if (instructions.includes('SCLI realtime path')) return true;
  const tools = Array.isArray(session.tools) ? session.tools : [];
  const names = tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return '';
    const row = tool as { name?: unknown; type?: unknown };
    return String(row.name || row.type || '');
  });
  return names.includes('bash') || names.some((name) => name.startsWith('pulse_'));
}

export function voiceS2SHistoryContext(history?: Array<{ role?: string; text?: string }>): string {
  if (!Array.isArray(history) || history.length === 0) return '';
  const lines: string[] = [];
  let prev = '';
  for (const item of history.slice(-12)) {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const role = String(item?.role || '') === 'assistant' ? 'Assistant' : 'User';
    const line = `${role}: ${text.slice(0, 400)}`;
    const norm = line.toLowerCase();
    if (prev && (norm === prev || (norm.length >= 12 && (prev.includes(norm) || norm.includes(prev))))) {
      continue;
    }
    prev = norm;
    lines.push(line);
  }
  if (!lines.length) return '';
  return `\n\nRecent chat (context only — do not read it back unless asked):\n${lines.join('\n')}`;
}

export function voiceS2SSessionUpdate(
  instructions: string,
  tools: ToolDefinition[],
  sampleRate: number,
): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      instructions,
      voice: process.env['GROK_VOICE_NAME'] || 'eve',
      turn_detection: {
        type: 'server_vad',
        threshold: 0.85,
        silence_duration_ms: 900,
        prefix_padding_ms: 400,
      },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: sampleRate },
          transport: 'binary',
          transcription: {
            keyterms: [
              'Hina', 'Ena', 'Yuna', 'Aya', 'Pulse', 'Connect', 'Hive',
              'bash', 'wiki', 'seats', 'queue',
              'Desktop', 'repo', 'file', 'edit',
            ],
          },
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          transport: 'json',
        },
      },
      tools: [
        { type: 'web_search' },
        // Native web_search already covers that capability. A second
        // function tool with the same name makes xAI accept session.update
        // then stall the first spoken response.
        ...advertiseVoiceS2STools(tools).filter((tool) => tool.name !== 'web_search'),
      ],
      reasoning: { effort: 'none' },
      resumption: { enabled: true },
    },
  };
}

interface BinaryRealtime {
  send(data: string | Buffer): void;
  close(): void;
  onJson(cb: (event: RealtimeEvent) => void): void;
  onBinary(cb: (buf: Buffer) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export function connectBinaryRealtime(
  url: string,
  headers: Record<string, string>,
): Promise<BinaryRealtime> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const transport: BinaryRealtime = {
      send: (data) => ws.send(data),
      close: () => { try { ws.close(); } catch { /* already closed */ } },
      onJson: (cb) => {
        ws.on('message', (raw: unknown) => {
          if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
          const text = typeof raw === 'string' ? raw : raw.toString('utf8');
          if (Buffer.isBuffer(raw) && raw.length >= 2 && raw[0] !== 0x7b) return;
          if (!text.startsWith('{')) return;
          try { cb(JSON.parse(text) as RealtimeEvent); } catch { /* ignore */ }
        });
      },
      onBinary: (cb) => {
        ws.on('message', (raw: unknown) => {
          if (!Buffer.isBuffer(raw)) return;
          if (raw.length >= 1 && raw[0] === 0x7b) return;
          cb(raw);
        });
      },
      onError: (cb) => {
        ws.on('error', (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))));
      },
      onClose: (cb) => {
        ws.on('close', (code: number, reason: Buffer | string) => cb(code, String(reason)));
      },
    };
    const onEarly = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
    ws.once('error', onEarly);
    ws.once('open', () => {
      ws.off('error', onEarly);
      resolve(transport);
    });
  });
}

export class GrokVoiceS2SSession {
  private upstream: BinaryRealtime | undefined;
  private closed = false;
  private readonly pending = new Set<string>();

  constructor(
    private readonly host: VoiceS2SHost,
    private readonly client: VoiceS2SClient,
    private readonly start: VoiceS2SStart,
    private readonly deps?: {
      connect?: typeof connectBinaryRealtime;
      resolveAuth?: (model: string) => Promise<GrokVoiceAuth>;
    },
  ) {}

  async startSession(): Promise<void> {
    if (!isGrokVoiceOmniModel(this.host.model)) {
      throw new Error('SCLI speech-to-speech requires a grok-voice model');
    }
    const model = normalizeGrokVoiceModel(this.host.model);
    const auth = await (this.deps?.resolveAuth ?? ((m: string) => resolveGrokVoiceAuth({ model: m })))(model);
    const url = `${auth.url.replace(/\?.*$/, '')}?model=${encodeURIComponent(auth.model)}`;
    const connect = this.deps?.connect ?? connectBinaryRealtime;
    const transport = await connect(url, { Authorization: `Bearer ${auth.token}` });
    this.upstream = transport;

    const instructions = [
      this.host.instructions.trim(),
      voiceS2SSpokenSuffix(this.host.profile),
      voiceS2SHistoryContext(this.start.history),
    ].filter(Boolean).join('\n');

    const sessionReady = waitForJson(transport, isOurVoiceSessionUpdated, 15_000);
    transport.send(JSON.stringify(voiceS2SSessionUpdate(
      instructions,
      this.host.tools,
      this.start.sampleRate || 24_000,
    )));
    await sessionReady;

    transport.onJson((event) => { void this.onUpstreamJson(event); });
    transport.onBinary((buf) => this.client.sendBytes(buf));
    transport.onError((err) => {
      this.client.sendJson({ type: 'error', message: err.message });
      this.close();
    });
    transport.onClose(() => this.close());

    this.client.sendJson({
      type: 'ready',
      provider: 'grok',
      via: 'scli',
      model: auth.model,
      transport: 's2s',
      tools: advertiseVoiceS2STools(this.host.tools).map((tool) => tool.name),
    });
  }

  handleClientData(data: Buffer | string): void {
    if (this.closed || !this.upstream) return;
    if (Buffer.isBuffer(data)) {
      this.upstream.send(data);
      return;
    }
    let event: { type?: string; enabled?: boolean };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      return;
    }
    const type = String(event.type || '');
    if (type === 'ping') return;
    if (type === 'mic') {
      if (event.enabled === false) {
        this.upstream.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
      }
      return;
    }
    if (
      type === 'input_audio_buffer.clear'
      || type === 'response.cancel'
      || type === 'response.create'
    ) {
      this.upstream.send(JSON.stringify({ type }));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.upstream?.close(); } catch { /* ignore */ }
    this.upstream = undefined;
  }

  private async onUpstreamJson(event: RealtimeEvent): Promise<void> {
    const type = String(event.type || '');
    if (type === 'response.function_call_arguments.done') {
      await this.runFunctionCall(event);
      return;
    }
    if (type === 'response.function_call_arguments.delta') return;
    // Home treats `{ type: 'error' }` as a dead Live socket and reconnects.
    // xAI emits that for a bad turn/tool, not a dead session — keep the
    // SCLI socket and surface the payload as debug so traces still see it.
    if (type === 'error' || type === 'response.error') {
      const message = String(
        (event.error as { message?: string } | undefined)?.message || event.message || 'realtime error',
      );
      logger.warn({ type, message }, 'SCLI voice remapped xAI error');
      this.client.sendJson({ type: 'debug.upstream_error', message, raw_type: type });
      return;
    }
    if (type === 'response.function_call_arguments.done' || type === 'response.created' || type === 'response.done') {
      logger.info({ type, name: event.name, call_id: event.call_id }, 'SCLI voice upstream');
    }
    this.client.sendJson(event);
  }

  private async runFunctionCall(event: RealtimeEvent): Promise<void> {
    const callId = String(event.call_id ?? event.id ?? '');
    const requested = String(event.name ?? '');
    if (!callId || this.pending.has(callId)) return;
    this.pending.add(callId);
    const available = this.host.tools.map((tool) => tool.name);
    const resolved = resolveVoiceS2SToolName(available, requested);
    let output: string;
    try {
      const raw = event.arguments != null ? String(event.arguments) : '{}';
      let parsed: Record<string, unknown> = {};
      try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch {
        parsed = { _raw: raw };
      }
      if (!resolved) {
        output = `${requested} is not on this SCLI voice session. Available: ${available.join(', ')}`;
      } else {
        output = clipVoiceToolOutput(await this.host.executeTool(resolved, parsed));
      }
    } catch (err) {
      output = `Tool ${requested} failed: ${(err as Error).message}`;
    }
    logger.warn({ name: resolved || requested, callId, chars: output.length }, 'SCLI voice tool');
    this.client.sendJson({
      type: 'debug.tool',
      name: resolved || requested,
      call_id: callId,
      chars: output.length,
    });
    this.upstream?.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    }));
    this.upstream?.send(JSON.stringify({ type: 'response.create' }));
    this.pending.delete(callId);
  }
}

function waitForJson(
  transport: BinaryRealtime,
  pred: (event: RealtimeEvent) => boolean,
  timeoutMs: number,
): Promise<RealtimeEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settle(() => reject(new Error('Timed out waiting for session.updated')));
    }, timeoutMs);
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    transport.onJson((event) => {
      if (event.type === 'error' || event.type === 'response.error') {
        const message = String((event.error as { message?: string } | undefined)?.message || event.message || 'realtime error');
        settle(() => reject(new Error(message)));
        return;
      }
      if (pred(event)) settle(() => resolve(event));
    });
  });
}

export { GROK_VOICE_REALTIME_URL };
