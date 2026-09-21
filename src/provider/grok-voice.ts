// @ts-ignore — this repo does not ship @types/ws (same as connect-client)
import WebSocket from 'ws';
import type { ToolDefinition } from '../tools/types.js';
import type {
  ChatContentBlock,
  ChatMessage,
  ChatOptions,
  ChatToolResultBlock,
  ChatToolUseBlock,
  LLMProvider,
  StreamChunk,
} from './types.js';

/**
 * Grok Voice Think Fast — Speech-to-Speech realtime adapter for SCLI.
 *
 * This is NOT Grok Build and NOT chat/completions. Official contract:
 *   wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0
 *   https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
 *
 * Tools on the same session:
 *   - function (client-side JSON schema) — SCLI maps ToolDefinition here so
 *     executeTurn's existing tool_use_* loop is unchanged
 *   - mcp / web_search / x_search / file_search — executed by xAI server-side
 *
 * Text Pulse/Connect turns use input_text + turn_detection=null. Live audio
 * uses the same provider over the agent gateway WS `/v1/voice/realtime`
 * (`cli/src/voice-s2s`) so Pulse/Wiki/Hive/bash stay on this SCLI process.
 */

export const GROK_VOICE_UPSTREAM_MODEL = 'grok-voice-think-fast-2.0';
export const GROK_VOICE_LATEST_ALIAS = 'grok-voice-latest';
export const GROK_VOICE_REALTIME_URL = 'wss://api.x.ai/v1/realtime';
export const GROK_VOICE_CONTEXT_WINDOW = 128_000;

const PREFIX_RE = /^(cortex\/)+|(^xai\/)|(^xai:)/i;

export function isGrokVoiceOmniModel(model: string): boolean {
  if (!model) return false;
  return stripGrokVoicePrefix(model).startsWith('grok-voice');
}

export function stripGrokVoicePrefix(model: string): string {
  let bare = model.trim();
  // Repeat so cortex/xai/grok-voice-* collapses to grok-voice-*.
  for (let i = 0; i < 4; i++) {
    const next = bare.replace(PREFIX_RE, '');
    if (next === bare) break;
    bare = next;
  }
  return bare.toLowerCase();
}

export function normalizeGrokVoiceModel(model: string): string {
  const bare = stripGrokVoicePrefix(model);
  if (bare === 'grok-voice' || bare === GROK_VOICE_LATEST_ALIAS) {
    return GROK_VOICE_UPSTREAM_MODEL;
  }
  return bare || GROK_VOICE_UPSTREAM_MODEL;
}

export interface RealtimeFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * xAI realtime function tools are implicitly strict. A Zod `.default()` field
 * (ToolSearch.max_results) is omitted from `required` and keeps `default` —
 * session.update then fails with
 * `Rejected invalid tool parameter schema for: ToolSearch` (Hina 2026-09-16,
 * 10 consecutive heartbeat errors, Hive Runtime unhealthy).
 */
export function sanitizeRealtimeParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value === null || typeof value !== 'object') return value;
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(src)) {
      if (key === '$schema' || key === '$defs' || key === 'definitions' || key === 'default') continue;
      // xAI rejects boolean schemas (`true`/`false`). `additionalProperties: false`
      // is implied (docs: defaults to false) and is the live ToolSearch 400 on
      // grok-voice realtime (Hina gen 45, 2026-09-16) — vercel/ai#14678.
      if (key === 'additionalProperties' && nested === false) continue;
      if (
        key === 'minimum' || key === 'maximum'
        || key === 'exclusiveMinimum' || key === 'exclusiveMaximum'
        || key === 'multipleOf'
      ) continue;
      out[key] = strip(nested);
    }
    if (out.type === 'integer') out.type = 'number';
    if (out.type === 'object' && out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
      const props = Object.keys(out.properties as Record<string, unknown>);
      if (props.length) out.required = props;
    }
    return out;
  };
  const cleaned = strip(schema);
  if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    return cleaned as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

/** xAI reserves `tool_search` (Hermes #95003). ToolSearch collides on realtime. */
const REALTIME_TOOL_NAME_ALIASES: Record<string, string> = {
  ToolSearch: 'search_deferred_tools',
};
const REALTIME_TOOL_NAME_LOCAL: Record<string, string> = Object.fromEntries(
  Object.entries(REALTIME_TOOL_NAME_ALIASES).map(([local, wire]) => [wire, local]),
);

export function realtimeFunctionName(name: string): string {
  return REALTIME_TOOL_NAME_ALIASES[name] || name;
}

export function localFunctionName(name: string): string {
  return REALTIME_TOOL_NAME_LOCAL[name] || name;
}

export function toolsToRealtimeFunctions(tools?: ToolDefinition[]): RealtimeFunctionTool[] {
  return (tools ?? []).map((tool) => ({
    type: 'function' as const,
    name: realtimeFunctionName(tool.name),
    description: tool.description || tool.name,
    parameters: sanitizeRealtimeParameters(
      (tool.inputSchema && typeof tool.inputSchema === 'object')
        ? tool.inputSchema as Record<string, unknown>
        : { type: 'object', properties: {} },
    ),
  }));
}

export interface RealtimeConversationItem {
  type: 'message' | 'function_call' | 'function_call_output';
  role?: 'user' | 'assistant' | 'system';
  content?: Array<{ type: 'input_text' | 'output_text'; text: string }>;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

function textFromBlocks(content: string | ChatContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function toolUses(content: string | ChatContentBlock[]): ChatToolUseBlock[] {
  if (typeof content === 'string') return [];
  return content.filter((block): block is ChatToolUseBlock => block.type === 'tool_use');
}

function toolResults(content: string | ChatContentBlock[]): ChatToolResultBlock[] {
  if (typeof content === 'string') return [];
  return content.filter((block): block is ChatToolResultBlock => block.type === 'tool_result');
}

export function extractSystemInstructions(messages: ChatMessage[], fallback?: string): string {
  const fromMessages = messages
    .filter((msg) => msg.role === 'system')
    .map((msg) => textFromBlocks(msg.content).trim())
    .filter(Boolean);
  if (fromMessages.length) return fromMessages.join('\n\n');
  return (fallback ?? '').trim();
}

export function messagesToRealtimeItems(messages: ChatMessage[]): RealtimeConversationItem[] {
  const items: RealtimeConversationItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'tool') {
      const callId = msg.toolCallId?.trim();
      if (!callId) continue;
      items.push({
        type: 'function_call_output',
        call_id: callId,
        output: textFromBlocks(msg.content),
      });
      continue;
    }
    if (msg.role === 'assistant') {
      for (const call of toolUses(msg.content)) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        });
      }
      const text = textFromBlocks(msg.content).trim();
      if (text) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      continue;
    }
    const text = textFromBlocks(msg.content).trim();
    for (const result of toolResults(msg.content)) {
      items.push({
        type: 'function_call_output',
        call_id: result.toolUseId,
        output: result.content,
      });
    }
    if (text) {
      items.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      });
    }
  }
  return items;
}

export function trailingToolResults(messages: ChatMessage[]): Array<{ callId: string; output: string }> {
  const out: Array<{ callId: string; output: string }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'tool') {
      const callId = msg.toolCallId?.trim();
      if (callId) out.push({ callId, output: textFromBlocks(msg.content) });
      continue;
    }
    if (msg.role === 'user') {
      const results = toolResults(msg.content);
      if (results.length && !textFromBlocks(msg.content).trim()) {
        for (const result of results) out.push({ callId: result.toolUseId, output: result.content });
        continue;
      }
    }
    break;
  }
  return out.reverse();
}

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

interface OpenCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

export class RealtimeTurnAccumulator {
  finished = false;
  error: Error | null = null;
  private calls = new Map<string, OpenCall>();
  private inputTokens = 0;
  private outputTokens = 0;

  apply(event: RealtimeEvent): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    const type = String(event.type || '');
    if (type === 'error' || type === 'response.error') {
      const err = event.error && typeof event.error === 'object'
        ? event.error as { message?: unknown; code?: unknown }
        : event;
      const message = String(
        (err as { message?: unknown }).message
        || event.message
        || 'Grok Voice realtime error',
      );
      this.error = new Error(message);
      this.finished = true;
      return chunks;
    }
    if (
      type === 'response.output_text.delta'
      || type === 'response.text.delta'
      || type === 'response.audio_transcript.delta'
      || type === 'response.output_audio_transcript.delta'
    ) {
      const text = String(event.delta ?? event.text ?? '');
      if (text) chunks.push({ type: 'text', text });
      return chunks;
    }
    if (
      type === 'response.output_text.done'
      || type === 'response.audio_transcript.done'
      || type === 'response.output_audio_transcript.done'
    ) {
      const text = String(event.transcript ?? event.text ?? '');
      if (text) chunks.push({ type: 'final_text', text });
      return chunks;
    }
    if (type === 'response.function_call_arguments.delta') {
      const call = this.ensureCall(event);
      const delta = String(event.delta ?? '');
      if (!call.started) {
        call.started = true;
        chunks.push({ type: 'tool_use_start', id: call.id, name: call.name });
      }
      if (delta) {
        call.args += delta;
        chunks.push({ type: 'tool_use_delta', id: call.id, input: delta });
      }
      return chunks;
    }
    if (type === 'response.function_call_arguments.done') {
      const call = this.ensureCall(event);
      const raw = event.arguments != null ? String(event.arguments) : call.args;
      call.args = raw;
      if (!call.started) {
        call.started = true;
        chunks.push({ type: 'tool_use_start', id: call.id, name: call.name });
        if (raw) chunks.push({ type: 'tool_use_delta', id: call.id, input: raw });
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch {
        parsed = { _raw: raw };
      }
      chunks.push({ type: 'tool_use_end', id: call.id, input: parsed });
      return chunks;
    }
    if (type === 'response.done' || type === 'response.completed') {
      const usage = (event.response && typeof event.response === 'object')
        ? (event.response as { usage?: Record<string, unknown> }).usage
        : (event.usage as Record<string, unknown> | undefined);
      if (usage) {
        this.inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
        this.outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
      }
      if (this.inputTokens || this.outputTokens) {
        chunks.push({
          type: 'usage',
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
        });
      }
      chunks.push({ type: 'done' });
      this.finished = true;
    }
    return chunks;
  }

  pendingCallIds(): string[] {
    return [...this.calls.keys()];
  }

  private ensureCall(event: RealtimeEvent): OpenCall {
    const id = String(event.call_id ?? event.id ?? `voice-fn-${this.calls.size + 1}`);
    const existing = this.calls.get(id);
    if (existing) {
      if (!existing.name && event.name) existing.name = localFunctionName(String(event.name));
      return existing;
    }
    const created: OpenCall = {
      id,
      name: localFunctionName(String(event.name ?? 'unknown')),
      args: '',
      started: false,
    };
    this.calls.set(id, created);
    return created;
  }
}

export interface RealtimeTransport {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onOpen(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export type ConnectRealtime = (url: string, headers: Record<string, string>) => Promise<RealtimeTransport>;

export interface GrokVoiceAuth {
  token: string;
  url: string;
  model: string;
}

export const GROK_VOICE_CREDITS_MESSAGE =
  'Grok Voice is out of credits on the xAI subscription. Add credits at grok.com or attach a funded xAI API key in Cortex.';

export class GrokVoiceAuthError extends Error {
  readonly code: string;
  constructor(message: string, code = 'mint_failed') {
    super(message);
    this.name = 'GrokVoiceAuthError';
    this.code = code;
  }
}

/** True when this process can mint a Grok Voice realtime session. */
export function grokVoiceAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const xai = (env['XAI_API_KEY'] ?? '').trim();
  if (xai && isUsableGrokVoiceBearer(xai)) return true;
  const cortex = (
    env['CORTEX_API_KEY']
    ?? env['CORTEX_OAUTH_TOKEN']
    ?? ''
  ).trim();
  return Boolean(cortex);
}

export function isUsableGrokVoiceBearer(token: string): boolean {
  const value = (token || '').trim();
  if (!value) return false;
  // xAI realtime rejects Grok OAuth access JWTs (HTTP 403 on WS upgrade).
  if (value.startsWith('eyJ')) return false;
  return true;
}

export function classifyGrokVoiceFailure(err: unknown): { message: string; code: string } {
  if (err instanceof GrokVoiceAuthError) {
    return { message: err.message, code: err.code };
  }
  const raw = err instanceof Error ? err.message : String(err || '');
  const lowered = raw.toLowerCase();
  if (
    lowered.includes('out of credits')
    || lowered.includes('grok subscription')
    || lowered.includes('(402)')
    || lowered.includes('unexpected server response: 403')
  ) {
    return { message: GROK_VOICE_CREDITS_MESSAGE, code: 'out_of_credits' };
  }
  if (lowered.includes('(401)') || lowered.includes('(403)')) {
    return { message: raw || GROK_VOICE_CREDITS_MESSAGE, code: 'voice_auth' };
  }
  return { message: raw || 'Grok Voice session failed.', code: 'mint_failed' };
}

export async function resolveGrokVoiceAuth(opts: {
  model: string;
  cortexBaseUrl?: string;
  cortexToken?: string;
  xaiApiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<GrokVoiceAuth> {
  const model = normalizeGrokVoiceModel(opts.model);
  const xai = (opts.xaiApiKey ?? process.env['XAI_API_KEY'] ?? '').trim();
  if (xai) {
    if (!isUsableGrokVoiceBearer(xai)) {
      throw new GrokVoiceAuthError(GROK_VOICE_CREDITS_MESSAGE, 'out_of_credits');
    }
    return { token: xai, url: GROK_VOICE_REALTIME_URL, model };
  }
  const cortexToken = (
    opts.cortexToken
    ?? process.env['CORTEX_API_KEY']
    ?? process.env['CORTEX_OAUTH_TOKEN']
    ?? ''
  ).trim();
  const cortexBase = (
    opts.cortexBaseUrl
    ?? process.env['CORTEX_BASE_URL']
    ?? 'https://cortex.shizuha.com'
  ).replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!cortexToken) {
    throw new GrokVoiceAuthError(
      'Grok Voice Think Fast needs XAI_API_KEY or a Cortex token to mint a realtime session.',
      'voice_auth',
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resp = await fetchImpl(`${cortexBase}/v1/audio/realtime/stream-session`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cortexToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model }),
  });
  const body = await resp.text();
  if (!resp.ok) {
    let detail = mintErrorDetail(body);
    throw classifyGrokVoiceMintStatus(resp.status, detail);
  }
  let parsed: { access_token?: string; upstream_url?: string; model?: string } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new GrokVoiceAuthError('Cortex realtime session mint returned non-JSON', 'mint_failed');
  }
  const token = (parsed.access_token || '').trim();
  if (!token) throw new GrokVoiceAuthError('Cortex realtime session mint returned no access_token', 'mint_failed');
  if (!isUsableGrokVoiceBearer(token)) {
    throw new GrokVoiceAuthError(GROK_VOICE_CREDITS_MESSAGE, 'out_of_credits');
  }
  return {
    token,
    url: (parsed.upstream_url || GROK_VOICE_REALTIME_URL).trim(),
    model: normalizeGrokVoiceModel(parsed.model || model),
  };
}

function mintErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown };
    const err = parsed.error;
    if (typeof err === 'string' && err.trim()) return err.slice(0, 300);
    if (err && typeof err === 'object') {
      const rec = err as Record<string, unknown>;
      const nested = rec.message ?? rec.detail ?? rec.error;
      if (typeof nested === 'string' && nested.trim()) return nested.slice(0, 300);
      return JSON.stringify(err).slice(0, 300);
    }
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.slice(0, 300);
    }
  } catch { /* keep raw body */ }
  return body.slice(0, 300);
}

function classifyGrokVoiceMintStatus(status: number, detail: string): GrokVoiceAuthError {
  const classified = classifyGrokVoiceFailure(
    new Error(`Cortex realtime session mint failed (${status}): ${detail}`),
  );
  if (status === 402 || classified.code === 'out_of_credits') {
    return new GrokVoiceAuthError(GROK_VOICE_CREDITS_MESSAGE, 'out_of_credits');
  }
  return new GrokVoiceAuthError(classified.message, classified.code);
}

export function nodeRealtimeConnect(url: string, headers: Record<string, string>): Promise<RealtimeTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const transport: RealtimeTransport = {
      send: (data) => ws.send(data),
      close: () => {
        try { ws.close(); } catch { /* already closed */ }
      },
      onMessage: (cb) => {
        ws.on('message', (raw: unknown) => {
          if (typeof raw === 'string') cb(raw);
          else if (Buffer.isBuffer(raw)) cb(raw.toString('utf8'));
          else cb(String(raw));
        });
      },
      onOpen: (cb) => { ws.on('open', cb); },
      onError: (cb) => {
        ws.on('error', (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))));
      },
      onClose: (cb) => {
        ws.on('close', (code: number, reason: Buffer | string) => cb(code, String(reason)));
      },
    };
    const onEarlyError = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
    ws.once('error', onEarlyError);
    ws.once('open', () => {
      ws.off('error', onEarlyError);
      resolve(transport);
    });
  });
}

interface LiveSession {
  key: string;
  model: string;
  transport: RealtimeTransport;
  pendingCallIds: Set<string>;
}

function sendJson(transport: RealtimeTransport, payload: unknown): void {
  transport.send(JSON.stringify(payload));
}

function waitFor(
  transport: RealtimeTransport,
  pred: (event: RealtimeEvent) => boolean,
  timeoutMs: number,
  label: string,
  abort?: AbortSignal,
): Promise<RealtimeEvent> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for ${label}`))), timeoutMs);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new Error('Aborted')));
    transport.onMessage((raw) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(raw) as RealtimeEvent;
      } catch {
        return;
      }
      if (event.type === 'error' || event.type === 'response.error') {
        const message = String((event.error as { message?: string } | undefined)?.message || event.message || label);
        finish(() => reject(new Error(message)));
        return;
      }
      if (pred(event)) finish(() => resolve(event));
    });
    abort?.addEventListener('abort', onAbort, { once: true });
    if (abort?.aborted) onAbort();
  });
}

export class GrokVoiceProvider implements LLMProvider {
  name = 'grok-voice';
  supportsTools = true;
  maxContextWindow = GROK_VOICE_CONTEXT_WINDOW;

  private live: LiveSession | undefined;
  private readonly connectFn: ConnectRealtime;
  private readonly resolveAuthFn: (model: string) => Promise<GrokVoiceAuth>;

  constructor(opts?: {
    connect?: ConnectRealtime;
    resolveAuth?: (model: string) => Promise<GrokVoiceAuth>;
  }) {
    this.connectFn = opts?.connect ?? nodeRealtimeConnect;
    this.resolveAuthFn = opts?.resolveAuth ?? ((model) => resolveGrokVoiceAuth({ model }));
  }

  contextWindowFor(_model: string): number {
    return GROK_VOICE_CONTEXT_WINDOW;
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const model = normalizeGrokVoiceModel(options.model);
    const sessionKey = options.sessionId || 'default';
    const followUp = trailingToolResults(messages);
    const canReuse = Boolean(
      this.live
      && this.live.key === sessionKey
      && this.live.model === model
      && followUp.length
      && followUp.every((item) => this.live!.pendingCallIds.has(item.callId)),
    );

    if (!canReuse) {
      this.closeLive();
      const auth = await this.resolveAuthFn(model);
      const url = `${auth.url.replace(/\?.*$/, '')}?model=${encodeURIComponent(auth.model)}`;
      const transport = await this.connectFn(url, { Authorization: `Bearer ${auth.token}` });
      const sessionReady = collectUntil(
        transport,
        (event) => event.type === 'session.updated',
        15_000,
        'session.updated',
        options.abortSignal,
      );
      sendJson(transport, {
        type: 'session.update',
        session: {
          instructions: extractSystemInstructions(messages, options.systemPrompt),
          voice: process.env['GROK_VOICE_NAME'] || 'eve',
          turn_detection: null,
          tools: toolsToRealtimeFunctions(options.tools),
          reasoning: {
            effort: (options.thinkingLevel === 'off' || options.reasoningEffort === 'none') ? 'none' : 'high',
          },
        },
      });
      await sessionReady;
      for (const item of messagesToRealtimeItems(messages)) {
        sendJson(transport, { type: 'conversation.item.create', item });
      }
      sendJson(transport, { type: 'response.create' });
      this.live = { key: sessionKey, model, transport, pendingCallIds: new Set() };
    } else {
      for (const item of followUp) {
        sendJson(this.live!.transport, {
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: item.callId, output: item.output },
        });
      }
      sendJson(this.live!.transport, { type: 'response.create' });
    }

    const acc = new RealtimeTurnAccumulator();
    try {
      for await (const event of iterateEvents(this.live!.transport, options.abortSignal)) {
        for (const chunk of acc.apply(event)) {
          if (chunk.type === 'tool_use_end') {
            this.live?.pendingCallIds.add(chunk.id);
          }
          yield chunk;
        }
        if (acc.error) throw acc.error;
        if (acc.finished) break;
      }
    } catch (err) {
      this.closeLive();
      throw err;
    }
    if (acc.pendingCallIds().length === 0) {
      // Text-only turn: keep the socket for the next user turn on this session.
      this.live!.pendingCallIds.clear();
    }
  }

  closeLive(): void {
    try { this.live?.transport.close(); } catch { /* ignore */ }
    this.live = undefined;
  }
}

async function* iterateEvents(
  transport: RealtimeTransport,
  abort?: AbortSignal,
): AsyncGenerator<RealtimeEvent> {
  const queue: RealtimeEvent[] = [];
  let wake: (() => void) | undefined;
  let closed: Error | undefined;
  transport.onMessage((raw) => {
    try {
      queue.push(JSON.parse(raw) as RealtimeEvent);
      wake?.();
    } catch {
      // ignore binary audio frames
    }
  });
  transport.onError((err) => {
    closed = err;
    wake?.();
  });
  transport.onClose((code, reason) => {
    closed = new Error(`Realtime socket closed (${code}): ${reason}`);
    wake?.();
  });
  const onAbort = () => {
    closed = new Error('Aborted');
    wake?.();
  };
  abort?.addEventListener('abort', onAbort);
  try {
    while (true) {
      if (abort?.aborted) throw new Error('Aborted');
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (closed) throw closed;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    abort?.removeEventListener('abort', onAbort);
  }
}

function collectUntil(
  transport: RealtimeTransport,
  pred: (event: RealtimeEvent) => boolean,
  timeoutMs: number,
  label: string,
  abort?: AbortSignal,
): Promise<RealtimeEvent> {
  return waitFor(transport, pred, timeoutMs, label, abort);
}
