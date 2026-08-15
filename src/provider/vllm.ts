/**
 * vLLM provider — talks to a vLLM server via its OpenAI-compatible API.
 *
 * vLLM exposes POST /v1/chat/completions with SSE streaming.
 * This provider converts Shizuha messages to OpenAI format and streams back.
 *
 * Used for on-device inference on DGX Spark / GPU servers running quantized models
 * (e.g., Qwen3.5-122B-A10B-NVFP4, MiniMax M2.5).
 *
 * Env vars:
 *   VLLM_BASE_URL        — server URL (default: http://localhost:8000)
 *   VLLM_CONTEXT_WINDOW  — max context tokens (default: 131072)
 *   VLLM_API_KEY         — optional API key for authenticated vLLM servers
 *   VLLM_STREAM_WITH_TOOLS=0 — legacy GLM-only guard for older streamed tool parsers
 *   VLLM_FORCE_NONSTREAM_TOOLS=1 — disable streamed tool-call turns for all models
 */

import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { holdDsmlStreamDelta, stripDsmlMarkup } from '../agent/dsml-salvage.js';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { logger } from '../utils/logger.js';
import { getModelProfile, resolveReasoningEffortForRequest, shouldEnableThinkingForRequest } from './model-profile.js';
import { shouldPassBackReasoning } from './deepseek-wire.js';
import { countTokens } from '../utils/tokens.js';
import { getSafetyFactor } from '../prompt/context.js';
import { resolveModelContextWindow } from './context-window.js';
import { isTransientProviderFailure } from './transient-errors.js';
import { providerTimeouts, recordScliInferenceTelemetry, recordPromptPrefixDivergence } from '../metrics/registry.js';
import { PromptPrefixGuard, promptPrefixGuardEnabled, type PromptPrefixPart } from '../telemetry/prompt-prefix-guard.js';

import type { ModelProfile } from './model-profile.js';
import { cortexClientHeaders } from './cortex-client-identity.js';
import {
  cortexAdvertisedStreamTimeoutMs,
  requestAwareToolStreamTimeoutMs,
} from './stream-timeout.js';

// Custom undici dispatcher for vLLM streams: disable the default 5-minute
// bodyTimeout that kills long-running thinking responses (MiniMax M2.7
// generates 5+ minutes of <think> tokens on hard tasks).
const vllmDispatcher = new Agent({
  bodyTimeout: 0,        // unlimited — rely on our stream stall timer instead
  // Non-streaming tool-call turns do not receive headers until vLLM finishes
  // the whole completion, so keep this above the provider-level response timer.
  // Raised 600s→1800s (2026-06-11): under a concurrency spike GLM TTFT can
  // exceed 10min while queued in vLLM; the old 600s cap fired → undici aborted
  // → the provider retried → re-prefilled the 90k prompt → made contention WORSE
  // (retry storm). Every downstream hop already waits far longer (cortex gunicorn
  // --timeout 7200, cortex→vLLM httpx read=None), so this was the only premature
  // cut-point. Match the non-streaming response budget by default so a long
  // GLM tool turn does not hit undici's header timer before our own watchdog.
  // 30min+ lets a legitimately-slow prefill complete instead of storming;
  // genuinely dead streams are still caught fast by the stream-stall timer (post-headers).
  headersTimeout: parseInt(
    process.env['VLLM_HEADERS_TIMEOUT_MS']
      || process.env['VLLM_NONSTREAM_RESPONSE_TIMEOUT_MS']
      || '1800000',
    10,
  ),
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

// PLAT-4189 follow-up: one guard shared across provider instances — sessions
// are keyed by baseUrl + sessionId, so multi-provider processes can't collide.
const vllmPromptPrefixGuard = new PromptPrefixGuard();


function firstHeader(headers: Headers | undefined, names: string[]): string | undefined {
  if (!headers) return undefined;
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

function cortexBackendHint(headers: Headers | undefined, fallbackBaseUrl: string): { id?: string; baseUrl?: string; pod?: string; node?: string; hint?: string } | undefined {
  const id = firstHeader(headers, ['x-cortex-backend-id', 'x-cortex-backend', 'x-backend-id']);
  const baseUrl = firstHeader(headers, ['x-cortex-backend-url', 'x-cortex-upstream', 'x-upstream-url']) ?? fallbackBaseUrl;
  const pod = firstHeader(headers, ['x-cortex-pod', 'x-backend-pod', 'x-pod-name']);
  const node = firstHeader(headers, ['x-cortex-node', 'x-backend-node', 'x-node-name']);
  const hint = firstHeader(headers, ['x-cortex-route', 'x-cortex-backend-hint', 'x-route-hint']);
  if (!id && !baseUrl && !pod && !node && !hint) return undefined;
  return { id, baseUrl, pod, node, hint };
}

function classifyVllmError(message: string, status?: number): string {
  const msg = message.toLowerCase();
  if (msg.includes('no first chunk')) return 'no_first_chunk';
  if (msg.includes('non-streaming response timeout')) return 'nonstream_response_timeout';
  if (msg.includes('stream stalled')) return 'stream_stall';
  if (status === 429) return 'rate_limited';
  if (msg.includes('model_leased') || msg.includes('leased to another')) return 'model_leased';
  if (status && status >= 500) return 'provider_5xx';
  if (msg.includes('econnreset') || msg.includes('socket hang up') || msg.includes('other side closed')) return 'connection_reset';
  if (msg.includes('etimedout') || msg.includes('timeout')) return 'timeout';
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('eai_again')) return 'connect_error';
  return 'provider_error';
}

/** Cortex agent→model exclusivity lease (503 type/code model_leased* / not_hive_eligible). */
export function isModelLeasedBody(body: unknown, bodyText = ''): boolean {
  const code = providerErrorCode(body).toLowerCase();
  if (
    code === 'model_leased'
    || code === 'model_leased_to_other'
    || code === 'not_hive_eligible'
  ) return true;
  const type = (() => {
    if (!body || typeof body !== 'object') return '';
    const root = body as Record<string, unknown>;
    const err = root['error'];
    if (err && typeof err === 'object') {
      const t = (err as Record<string, unknown>)['type'];
      if (typeof t === 'string') return t.toLowerCase();
    }
    const t = root['type'];
    return typeof t === 'string' ? t.toLowerCase() : '';
  })();
  if (type === 'model_leased') return true;
  return /model_leased_to_other|model_leased|not_hive_eligible|"type"\s*:\s*"model_leased"|leased to another agent|not marked them eligible/i.test(bodyText);
}

/** Delay for a leased-out model: honor Retry-After, floor 60s, cap 15min. */
export function modelLeasedRetryMs(
  headers: Headers,
  attempt: number,
  rand: () => number = Math.random,
): number {
  const headerMs = retryAfterHeaderMs(headers);
  // Floor 60s: Cortex default Retry-After is 60; never thrash faster than that.
  const BASE = 60_000;
  const MAX = 900_000; // 15 min ≈ min-hold; next sprint is often free by then
  const exp = Math.min(BASE * Math.pow(2, Math.max(0, attempt)), MAX);
  const base = Math.max(headerMs ?? BASE, BASE);
  const delay = Math.min(Math.max(base, exp), MAX);
  const r = Math.min(1, Math.max(0, rand()));
  return Math.round(delay * (0.9 + r * 0.2)); // ±10% jitter (narrow — long waits)
}

function parseTimeoutMs(envName: string, defaultMs: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

function retryAfterHeaderMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const delta = Number(raw);
  if (Number.isFinite(delta) && delta > 0) return Math.max(1, Math.round(delta * 1000));
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(1, when - Date.now());
  return undefined;
}

function providerErrorCode(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const root = body as Record<string, unknown>;
  const err = root['error'];
  const candidates: unknown[] = [root['code'], root['reason'], root['type']];
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    candidates.push(e['code'], e['reason'], e['type']);
  }
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

function providerErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const root = body as Record<string, unknown>;
  const err = root['error'];
  if (err && typeof err === 'object') {
    const m = (err as Record<string, unknown>)['message'];
    if (typeof m === 'string') return m;
  }
  const m = root['message'];
  return typeof m === 'string' ? m : '';
}

function providerPoolDryRetryMs(body: unknown, headers: Headers): number {
  const headerMs = retryAfterHeaderMs(headers);
  if (headerMs !== undefined) return headerMs;
  if (body && typeof body === 'object') {
    const root = body as Record<string, unknown>;
    const err = root['error'];
    const candidates: unknown[] = [root['retry_after'], root['retryAfter'], root['retry_after_seconds'], root['cooldown_seconds']];
    const msCandidates: unknown[] = [root['retry_after_ms'], root['retryAfterMs'], root['retryInMs'], root['cooldown_ms']];
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>;
      candidates.push(e['retry_after'], e['retryAfter'], e['retry_after_seconds'], e['cooldown_seconds']);
      msCandidates.push(e['retry_after_ms'], e['retryAfterMs'], e['retryInMs'], e['cooldown_ms']);
    }
    for (const c of msCandidates) {
      const n = typeof c === 'number' ? c : (typeof c === 'string' ? Number(c) : NaN);
      if (Number.isFinite(n) && n > 0) return Math.max(1, Math.round(n));
    }
    for (const c of candidates) {
      const n = typeof c === 'number' ? c : (typeof c === 'string' ? Number(c) : NaN);
      if (Number.isFinite(n) && n > 0) return Math.max(1, Math.round(n * 1000));
    }
  }
  return 60_000;
}

interface VLlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{type: string; text: string}>;
  reasoning_content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface SSEChoice {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
    reasoning?: string | null;
    /** SCLI-24: DeepSeek R1 / vLLM thinking models emit reasoning here (plain text). */
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason: string | null;
}

interface SSEChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: SSEChoice[] | null;  // null/missing when speculative decoding sends usage-only chunks
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_read_tokens?: number };
    input_tokens_details?: { cached_tokens?: number; cache_read_tokens?: number };
    cache_read_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
    retryable?: boolean;
  };
}

function cacheReadTokensFromUsage(usage: {
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_read_tokens?: number };
  input_tokens_details?: { cached_tokens?: number; cache_read_tokens?: number };
  cache_read_tokens?: number;
  cache_read_input_tokens?: number;
} | null | undefined): number | undefined {
  if (!usage) return undefined;
  for (const details of [usage.prompt_tokens_details, usage.input_tokens_details]) {
    const cached = details?.cached_tokens ?? details?.cache_read_tokens;
    if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) return cached;
  }
  const top = usage.cache_read_input_tokens ?? usage.cache_read_tokens;
  if (typeof top === 'number' && Number.isFinite(top) && top >= 0) return top;
  return undefined;
}

interface VLlmModelEntry {
  id: string;
  max_model_len?: number;
  context_length?: number;
  max_context_length?: number;
  context_window?: number;
  contextWindow?: number;
  top_provider?: {
    max_completion_tokens?: number;
    context_length?: number;
  };
  /**
   * SCLI-218 / CTX-302 contract: virtual-alias metadata (e.g. cortex/auto).
   * `ladder` lists the concrete rungs auto may serve with their windows;
   * `context_floor` is the smallest rung window — the conservative compaction
   * target that guarantees the session fits EVERY rung. Optional and tolerated
   * absent (the server half ships via CTX-353).
   */
  extras?: {
    ladder?: Array<{ model?: string; context_window?: number }>;
    context_floor?: number;
  };
}

function normalizeModelId(model?: string): string {
  return (model ?? '').replace(/^vllm\//i, '').replace(/^cortex\//i, '').toLowerCase();
}

function contextWindowFromModelEntry(entry: VLlmModelEntry): number | undefined {
  const candidates = [
    entry.max_model_len,
    entry.max_context_length,
    entry.context_length,
    entry.context_window,
    entry.contextWindow,
    entry.top_provider?.context_length,
  ];
  return candidates.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function replaceInvalidUtf16Surrogates(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += value.slice(i, i + 2);
        i++;
      } else {
        out += '\uFFFD';
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      out += '\uFFFD';
      continue;
    }
    out += value.charAt(i);
  }
  return out;
}

function sanitizeOpenAiPayloadForUtf8<T>(value: T): T {
  if (typeof value === 'string') {
    return replaceInvalidUtf16Surrogates(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeOpenAiPayloadForUtf8(item)) as T;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      sanitized[key] = sanitizeOpenAiPayloadForUtf8(item);
    }
    return sanitized as T;
  }
  return value;
}

function toVLlmMessages(messages: ChatMessage[], systemPrompt?: string, profile?: ModelProfile): VLlmMessage[] {
  const useArrayFormat = profile?.userMessageFormat === 'array';
  const formatContent = (text: string): string | Array<{type: string; text: string}> =>
    useArrayFormat ? [{ type: 'text', text }] : text;
  // Heal historical DSML leaks (2026-08-10): assistant turns recorded before
  // the salvage hook can carry literal DSML wire markup. Feeding it back
  // teaches the model that text-form tool markup is acceptable output and the
  // session degrades further — strip it from the outbound payload. The stored
  // transcript is untouched.
  const healAssistantText = (text: string): string => stripDsmlMarkup(text);
  const result: VLlmMessage[] = [];
  if (systemPrompt) result.push({ role: 'system', content: systemPrompt });

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (typeof msg.content === 'string') {
      result.push({
        role: msg.role as VLlmMessage['role'],
        content: msg.role === 'assistant' ? healAssistantText(msg.content) : msg.content,
      });
      continue;
    }

    const blocks = msg.content as ChatContentBlock[];

    if (msg.role === 'assistant') {
      const textParts = blocks
        .filter((b) => b.type === 'text')
        .map((b) => healAssistantText((b as { text: string }).text));
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const reasoningParts = blocks
        .filter((b) => b.type === 'reasoning')
        .map((b) => (b as { rawContent?: string }).rawContent)
        .filter((text): text is string => Boolean(text));

      const vMsg: VLlmMessage = {
        role: 'assistant',
        content: textParts.join('\n') || '',
      };
      // Official DeepSeek rule (dsh-llm-deepseek serialize.ts): pass CoT
      // back only on tool-call turns. Plain turns drop it — hosted API
      // ignores it; self-hosted templates may render it and prime "Let me…".
      if (
        reasoningParts.length > 0
        && shouldPassBackReasoning(profile?.reasoningPassback, toolUses.length > 0)
      ) {
        vMsg.reasoning_content = reasoningParts.join('');
      }
      if (toolUses.length > 0) {
        const toolAliases = profile?.toolNameAliases ?? {};
        vMsg.tool_calls = toolUses.map((tc) => ({
          id: (tc as { id: string }).id,
          type: 'function' as const,
          function: {
            name: toolAliases[(tc as { name: string }).name] ?? (tc as { name: string }).name,
            arguments: JSON.stringify((tc as { input: Record<string, unknown> }).input),
          },
        }));
      }
      result.push(vMsg);
    } else if (msg.role === 'user') {
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const textParts = blocks.filter((b) => b.type === 'text');

      for (const tr of toolResults) {
        const r = tr as { toolUseId: string; content: string; isError?: boolean; image?: { base64: string; mediaType: string } };
        if (r.image && profile?.supportsVision) {
          // Vision: auto-downscale images for local VL models.
          // Anthropic handles this server-side, but for vLLM/local models we must do it ourselves.
          // A 1920x1080 PNG = ~1.5MB base64 = ~92K tokens. After JPEG q50 downscale = ~100KB = ~6K tokens.
          let imageB64 = r.image.base64;
          let imageMime = r.image.mediaType;
          const rawSizeKB = Math.round(imageB64.length * 0.75 / 1024); // base64 → raw bytes → KB

          if (rawSizeKB > 100) {
            // Image > 100KB — downscale via CDP re-capture as JPEG
            // This is a scaffold-level optimization: tools send full-quality images,
            // the provider layer automatically downscales for models with limited context.
            try {
              const { execSync } = require('node:child_process');
              // Use CDP to re-capture at lower quality (if Chrome is running)
              const targetsRaw = execSync('curl -sf http://127.0.0.1:9222/json 2>/dev/null', { encoding: 'utf-8', timeout: 2000 });
              const targets = JSON.parse(targetsRaw) as Array<{ type: string; webSocketDebuggerUrl: string }>;
              const page = targets.find((t) => t.type === 'page');
              if (page?.webSocketDebuggerUrl) {
                // Re-capture as JPEG quality 50 via CDP
                const cdpResult = execSync(
                  `python3 -c "
import asyncio, websockets, json, base64
async def cap():
    async with websockets.connect('${page.webSocketDebuggerUrl}') as ws:
        await ws.send(json.dumps({'id':1,'method':'Page.captureScreenshot','params':{'format':'jpeg','quality':50}}))
        resp = json.loads(await ws.recv())
        if 'result' in resp and 'data' in resp['result']:
            print(resp['result']['data'])
asyncio.run(cap())
" 2>/dev/null`,
                  { encoding: 'utf-8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
                ).trim();
                if (cdpResult.length > 100) {
                  imageB64 = cdpResult;
                  imageMime = 'image/jpeg';
                  const newSizeKB = Math.round(cdpResult.length * 0.75 / 1024);
                  logger.info({ originalKB: rawSizeKB, downscaledKB: newSizeKB }, 'vLLM: auto-downscaled screenshot for vision');
                }
              }
            } catch {
              // CDP re-capture failed — use original image (may cause context overflow)
              logger.warn({ sizeKB: rawSizeKB }, 'vLLM: could not downscale image — using original');
            }
          }

          result.push({
            role: 'tool',
            content: [
              { type: 'text', text: r.content },
              { type: 'image_url', image_url: { url: `data:${imageMime};base64,${imageB64}` } },
            ] as unknown as string,
            tool_call_id: r.toolUseId,
          });
        } else if (r.image) {
          // SCLI-63: served model is text-only (no vision) — substitute the image
          // with a textual placeholder so the turn doesn't fail with vLLM 400
          // ("not a multimodal model"). Keep the tool result's own text (often the
          // screenshot path/description) and tell the model to use non-visual tools.
          const note = `\n\n[Image not sent: the served model (${profile?.displayName ?? 'this model'}) is text-only and cannot accept images. A ${r.image.mediaType} screenshot was captured but omitted. Rely on the textual tool output above; inspect content with non-visual tools (read the DOM/HTML, file contents, or logs).]`;
          result.push({ role: 'tool', content: `${(r.content || '').trim()}${note}`, tool_call_id: r.toolUseId });
        } else {
          result.push({ role: 'tool', content: r.content, tool_call_id: r.toolUseId });
        }
      }
      if (textParts.length > 0) {
        result.push({
          role: 'user',
          content: textParts.map((b) => (b as { text: string }).text).join('\n'),
        });
      }
    } else {
      const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      if (text) result.push({ role: msg.role as VLlmMessage['role'], content: text });
    }
  }
  return result;
}

/**
 * Recover GLM-style tool calls leaked as raw tokens in text (content or reasoning),
 * a vLLM glm47 tool-parser bug seen with GLM-4.7 (esp. thinking OFF). Format:
 *   <tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value>...</tool_call>
 * Returns the text with the tokens stripped + the extracted calls.
 */
export function extractGlmToolCalls(text: string): { clean: string; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  if (!text || !text.includes('<tool_call>')) return { clean: text, calls };
  const tcRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let mm: RegExpExecArray | null;
  while ((mm = tcRe.exec(text)) !== null) {
    const inner = mm[1] ?? '';
    const name = (inner.match(/^\s*([^<\s][^<]*?)\s*(?=<arg_key>|$)/)?.[1] ?? '').trim();
    const args: Record<string, unknown> = {};
    const argRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
    let aa: RegExpExecArray | null;
    while ((aa = argRe.exec(inner)) !== null) {
      const k = (aa[1] ?? '').trim();
      const vRaw = aa[2] ?? '';
      let v: unknown = vRaw;
      try { v = JSON.parse(vRaw); } catch { v = vRaw; }
      args[k] = v;
    }
    if (name) calls.push({ name, args });
  }
  return { clean: text.replace(tcRe, '').trim(), calls };
}

/**
 * Recover a tool call whose arguments vLLM served un-parseable.
 *
 * GLM emits calls as `<tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value></tool_call>`.
 * When vLLM's glm47 parser loses sync it can hand us a *mangled* call: the tool
 * name fused with its first argument (`write_file_path/workspace/solver.py`) and
 * an `arguments` string that is not JSON at all — a Python triple-quoted blob
 * (`{"content": """...`) or bare source (`{"content": import pytest\n...`).
 * The old behaviour fell back to `input: {}`, so the write never happened and
 * the agent burned a turn on a tool error. On the impossible tier those wasted
 * turns are what pushed runs into the cap.
 *
 * Salvage, in order of trust:
 *   1. the tool name, by splitting a fused name on a known tool prefix;
 *   2. `arg_key`/`arg_value` pairs, tolerating a missing OPENING tag — the
 *      leaked text characteristically starts mid-pair (`file_path</arg_key>…`);
 *   3. a single-key object whose value never got quoted properly.
 *
 * Returns null when nothing trustworthy is recoverable — the caller then keeps
 * its existing `{}` behaviour rather than inventing arguments.
 */
export function salvageGlmToolCall(
  rawName: string,
  rawArgs: string,
  accContent: string,
  knownTools: string[],
): { name: string; args: Record<string, unknown> } | null {
  const name = repairFusedToolName(rawName, knownTools);
  if (!name) return null;

  const args: Record<string, unknown> = {};
  // Orphan-tolerant: the key is whatever sits immediately before </arg_key>,
  // even if <arg_key> itself was swallowed by the upstream parser.
  // Key class excludes '.' deliberately: the leaked text runs prose straight
  // into the key (`...then the tests.file_path</arg_key>`), and allowing dots
  // made the match swallow the sentence as part of the argument name.
  const pairRe = /([A-Za-z_][\w-]*)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
  for (const source of [rawArgs, accContent]) {
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(source ?? '')) !== null) {
      const key = (m[1] ?? '').trim();
      const raw = m[2] ?? '';
      if (!key || key in args) continue;
      let value: unknown = raw;
      try { value = JSON.parse(raw); } catch { value = raw; }
      args[key] = value;
    }
    pairRe.lastIndex = 0;
  }

  if (Object.keys(args).length === 0) {
    const lenient = lenientSingleKeyObject(rawArgs);
    if (lenient) Object.assign(args, lenient);
  }

  return Object.keys(args).length > 0 ? { name, args } : null;
}

/**
 * `write_file_path/workspace/solver.py` -> `write`.
 * Longest known-tool prefix wins so `write` never shadows `write_memory`.
 */
export function repairFusedToolName(rawName: string, knownTools: string[]): string | null {
  const candidate = (rawName ?? '').trim();
  if (!candidate) return null;
  if (knownTools.includes(candidate)) return candidate;
  let best: string | null = null;
  for (const tool of knownTools) {
    if (!candidate.startsWith(tool)) continue;
    if (best === null || tool.length > best.length) best = tool;
  }
  return best;
}

/**
 * `{"content": """def f(): ...}` / `{"content": import pytest ...}` -> {content: "..."}.
 * Only ever applied to args that already failed JSON.parse.
 */
function lenientSingleKeyObject(raw: string): Record<string, unknown> | null {
  const m = (raw ?? '').match(/^\s*\{\s*"([\w.$-]+)"\s*:\s*([\s\S]*?)\s*\}\s*$/);
  if (!m) return null;
  const key = m[1];
  if (!key) return null;
  let value = m[2] ?? '';
  // Peel Python triple quotes (possibly unterminated) then a stray edge quote.
  value = value.replace(/^(?:'''|""")/, '').replace(/(?:'''|""")$/, '');
  value = value.replace(/^"/, '').replace(/"$/, '');
  if (!value.trim()) return null;
  return { [key]: value };
}

/**
 * Split / strip GLM thinking markup that leaked into message content.
 *
 * With thinking ON, vLLM sometimes still puts reasoning in `content` as:
 *   - well-formed `<think>…</think>`
 *   - orphan close: `thinking text</think>visible answer`
 *   - bare tags: `</think>answer` or `answer</think>`
 * Streaming path parses open/close tags; the non-stream tool path (GLM default)
 * must do the same or the TUI shows thinking as user-visible text (2026-07-25).
 */
export function splitThinkMarkup(text: string): { reasoning: string; content: string } {
  if (!text) return { reasoning: '', content: '' };
  let reasoningParts: string[] = [];
  let work = text;

  // Well-formed blocks
  work = work.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, body: string) => {
    if (body.trim()) reasoningParts.push(body.trim());
    return '';
  });
  // Orphan open to end of string
  work = work.replace(/<think>([\s\S]*)$/i, (_m, body: string) => {
    if (body.trim()) reasoningParts.push(body.trim());
    return '';
  });
  // Orphan close(s): text before each </think> is reasoning; after last close is content.
  // GLM often streams `</think>answer` with no open tag (thinking already in reasoning_content).
  while (/<\/think>/i.test(work)) {
    const m = work.match(/^([\s\S]*?)<\/think>\s*/i);
    if (!m) break;
    if ((m[1] ?? '').trim()) reasoningParts.push((m[1] ?? '').trim());
    work = work.slice(m[0].length);
  }
  // Any leftover bare tags
  work = work.replace(/<\/?think>/gi, '');
  return {
    reasoning: reasoningParts.join('\n').trim(),
    content: work.replace(/^\s+/, ''),
  };
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * Incremental stream parser for think tags in content deltas.
 * Handles well-formed blocks AND orphan `</think>` (GLM stream common case).
 * Returns pieces to emit + carry buffer for partial tags at chunk boundaries.
 */
export function consumeThinkStreamDelta(
  delta: string,
  inThinkBlock: boolean,
  carry = '',
): {
  inThinkBlock: boolean;
  carry: string;
  reasoning: string[];
  text: string[];
} {
  let remaining = carry + (delta || '');
  const reasoning: string[] = [];
  const text: string[] = [];
  let thinking = inThinkBlock;

  // Hold back a trailing partial tag so `</th` + `ink>` across chunks still strips.
  const holdPartialTag = (s: string): { emit: string; hold: string } => {
    const lt = s.lastIndexOf('<');
    if (lt < 0) return { emit: s, hold: '' };
    const tail = s.slice(lt);
    if (
      THINK_OPEN.startsWith(tail)
      || THINK_CLOSE.startsWith(tail)
      || '</think>'.toLowerCase().startsWith(tail.toLowerCase())
      || '<think>'.toLowerCase().startsWith(tail.toLowerCase())
    ) {
      return { emit: s.slice(0, lt), hold: tail };
    }
    return { emit: s, hold: '' };
  };

  while (remaining.length > 0) {
    if (thinking) {
      const closeIdx = remaining.toLowerCase().indexOf(THINK_CLOSE);
      if (closeIdx >= 0) {
        const body = remaining.slice(0, closeIdx);
        if (body) reasoning.push(body);
        thinking = false;
        remaining = remaining.slice(closeIdx + THINK_CLOSE.length).replace(/^\s*\n?/, '');
      } else {
        const { emit, hold } = holdPartialTag(remaining);
        if (emit) reasoning.push(emit);
        remaining = '';
        return { inThinkBlock: thinking, carry: hold, reasoning, text };
      }
    } else {
      const lower = remaining.toLowerCase();
      const openIdx = lower.indexOf(THINK_OPEN);
      const closeIdx = lower.indexOf(THINK_CLOSE);
      // Orphan close without open — drop the tag; text before it is reasoning
      // only when we already had think context, else it's usually empty prefix.
      if (closeIdx >= 0 && (openIdx < 0 || closeIdx < openIdx)) {
        const before = remaining.slice(0, closeIdx);
        if (before) reasoning.push(before);
        remaining = remaining.slice(closeIdx + THINK_CLOSE.length).replace(/^\s*\n?/, '');
        continue;
      }
      if (openIdx >= 0) {
        const before = remaining.slice(0, openIdx);
        if (before) text.push(before);
        thinking = true;
        remaining = remaining.slice(openIdx + THINK_OPEN.length);
      } else {
        const { emit, hold } = holdPartialTag(remaining);
        if (emit) text.push(emit);
        remaining = '';
        return { inThinkBlock: thinking, carry: hold, reasoning, text };
      }
    }
  }
  return { inThinkBlock: thinking, carry: '', reasoning, text };
}

function describeFetchError(err: unknown): string {
  const error = err as Error & { cause?: { code?: string; message?: string; name?: string } };
  const parts = [error.message || String(err)];
  const causeCode = error.cause?.code;
  const causeMessage = error.cause?.message;
  if (causeCode && !parts[0]!.includes(causeCode)) parts.push(causeCode);
  if (causeMessage && !parts.some((part) => part.includes(causeMessage))) parts.push(causeMessage);
  return parts.filter(Boolean).join(': ');
}

export class VLlmProvider implements LLMProvider {
  name = 'vllm';
  supportsTools = true;
  maxContextWindow: number;
  private baseUrl: string;
  /**
   * Static key or resolver. Cortex must use a resolver: Shizuha login JWTs are
   * short-lived (~1h) and get refreshed into auth.json by startShizuhaAuthAutoRefresh,
   * but a frozen constructor key kept serving the expired JWT (401 Signature has
   * expired) after earlier turns worked (operator 2026-07-23).
   */
  private apiKeyOrResolver: string | (() => string | undefined) | undefined;
  /**
   * Optional force-refresh callback. When set, called on 401 "Signature has
   * expired" to force a token refresh (the server-side RS256 signing key may
   * have rotated, making a valid-`exp` JWT's signature invalid). The returned
   * token replaces the resolver's next value. Used by the Cortex provider.
   */
  private forceRefreshKey?: () => Promise<string | undefined>;
  private logLabel = 'vLLM';
  /** Cached model name from /v1/models — avoids needing to know the served-model-name upfront. */
  private _servedModel: string | undefined;
  private _servedModelCache = new Map<string, {
    id: string;
    maxContextWindow?: number;
    fetchedAt: number;
  }>();
  // SCLI-218: per-model-id windows/floors for EVERY entry the backend lists —
  // needed when a virtual alias (cortex/auto) serves a different concrete model
  // per response and the loop re-resolves its compaction window for that rung.
  private _windowByModelId = new Map<string, number>();
  private _contextFloorByModelId = new Map<string, number>();
  // Adaptive tokenizer calibration (2026-07-07): tiktoken × the static safety
  // factor (1.45 for local models) is a WORST-case prior. Near-full windows it
  // falsely trips the pre-flight guard — observed live: guard computed
  // prompt≈265,620 on a 262,144 window and killed the turn while the backend's
  // own usage.prompt_tokens showed ~91% used. The server reports the REAL
  // count every response; track observed real/tiktoken and prefer it.
  private _rawPromptEstimateLast?: number;
  private _tokenizerRatioEwma?: number;

  constructor(
    baseUrl?: string,
    contextWindow?: number,
    apiKey?: string | (() => string | undefined),
    providerName = 'vllm',
    forceRefreshKey?: () => Promise<string | undefined>,
  ) {
    this.name = providerName;
    this.logLabel = providerName === 'cortex' ? 'Cortex' : 'vLLM';
    // SCLI-112: also strip a trailing `/v1` — we append `/v1/models` and
    // `/v1/chat/completions` ourselves, so a base of `…/v1` would double-path
    // to `/v1/v1/…` → 404. Mirrors the cortex provider's normalization.
    this.baseUrl = (baseUrl ?? process.env['VLLM_BASE_URL'] ?? 'http://localhost:8000')
      .replace(/\/+$/, '').replace(/\/v1$/, '');
    this.maxContextWindow = contextWindow
      ?? (process.env['VLLM_CONTEXT_WINDOW'] ? parseInt(process.env['VLLM_CONTEXT_WINDOW'], 10) : undefined)
      ?? 131072; // Will be auto-corrected by getServedModel() on first call
    this.apiKeyOrResolver = apiKey ?? process.env['VLLM_API_KEY'];
    this.forceRefreshKey = forceRefreshKey;
  }

  /** Resolve auth for this request (re-reads JWT/API key when a resolver is set). */
  private resolveApiKey(): string | undefined {
    const v = this.apiKeyOrResolver;
    if (typeof v === 'function') {
      try {
        return v() || undefined;
      } catch {
        return undefined;
      }
    }
    return v || undefined;
  }
  /** Effective safety factor: observed real/tiktoken ratio (EWMA, +5% headroom)
   *  once calibrated; the static per-family prior until then. Bounded so a
   *  noisy sample can neither drop below exact-count nor run away. */
  private _calibratedSafetyFactor(model: string): number {
    const prior = getSafetyFactor(model);
    const ewma = this._tokenizerRatioEwma;
    if (ewma == null) return prior;
    return Math.min(Math.max(ewma * 1.05, 1.0), Math.max(prior, 1.6));
  }

  /** Feed a response's real usage.prompt_tokens back into the calibration. */
  private _recordPromptUsage(actualPromptTokens?: number): void {
    const raw = this._rawPromptEstimateLast;
    if (!actualPromptTokens || actualPromptTokens <= 0 || !raw || raw <= 0) return;
    const ratio = Math.min(Math.max(actualPromptTokens / raw, 0.5), 2.0);
    this._tokenizerRatioEwma = this._tokenizerRatioEwma == null
      ? ratio
      : 0.7 * this._tokenizerRatioEwma + 0.3 * ratio;
  }


  /**
   * Discover the model name and context window from vLLM (caches on first call).
   * `preferredModel` lets a multi-model endpoint (e.g. the cortex gateway lists GLM-4.7,
   * Qwen3.6-27B, ...) resolve the window for the model THIS agent actually uses, instead
   * of blindly taking data[0] (which inherited GLM's 131K for Qwen agents — 2026-06-09).
   */
  async getServedModel(
    preferredModel?: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<string | undefined> {
    const cacheKey = normalizeModelId(preferredModel) || '__default__';
    const cached = this._servedModelCache.get(cacheKey);
    const cacheTtlMs = Math.max(
      0,
      Number.parseInt(process.env['VLLM_MODEL_DISCOVERY_CACHE_TTL_MS'] ?? '30000', 10) || 30_000,
    );
    if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt <= cacheTtlMs) {
      this._servedModel = cached.id;
      if (cached.maxContextWindow) this.maxContextWindow = cached.maxContextWindow;
      return cached.id;
    }
    try {
      const headers: Record<string, string> = {};
      const apiKey = this.resolveApiKey();
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const hostOverride = process.env['VLLM_HOST_HEADER'];
      if (hostOverride) headers['Host'] = hostOverride;
      const discoveryTimeoutMs = Math.max(
        250,
        Number.parseInt(process.env['VLLM_MODEL_DISCOVERY_TIMEOUT_MS'] ?? '3000', 10) || 3000,
      );
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(discoveryTimeoutMs),
      });
      if (!res.ok) {
        logger.warn({ status: res.status, model: preferredModel },
          `${this.logLabel}: /v1/models discovery failed`);
        return undefined;
      }
      const json = (await res.json()) as { data: VLlmModelEntry[] };
      if (json.data?.length) {
        this._windowByModelId.clear();
        this._contextFloorByModelId.clear();
        // SCLI-218: index EVERY listed model's window + auto-ladder metadata,
        // not just the matched entry — a cortex/auto session can be served by
        // any rung and the loop needs that rung's window mid-session.
        for (const m of json.data) {
          const w = contextWindowFromModelEntry(m);
          if (w) this._windowByModelId.set(normalizeModelId(m.id), w);
          const ladderWindows = (m.extras?.ladder ?? [])
            .map((r) => r.context_window)
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
          for (const rung of m.extras?.ladder ?? []) {
            if (rung.model && typeof rung.context_window === 'number' && rung.context_window > 0) {
              this._windowByModelId.set(normalizeModelId(rung.model), rung.context_window);
            }
          }
          const floor = m.extras?.context_floor
            ?? (ladderWindows.length ? Math.min(...ladderWindows) : undefined);
          if (typeof floor === 'number' && floor > 0) {
            this._contextFloorByModelId.set(normalizeModelId(m.id), floor);
          }
        }
        // A requested model must match exactly. Choosing data[0] for a missing
        // model silently imports another deployment's context window and can
        // destructively trim a resumable transcript. Only an unqualified,
        // single-model endpoint may use its sole entry.
        const want = normalizeModelId(preferredModel);
        const entry =
          (want && json.data.find((m) => normalizeModelId(m.id) === want))
          || (!want && json.data.length === 1 ? json.data[0] : undefined);
        if (!entry) {
          logger.warn({
            requestedModel: preferredModel,
            advertisedModels: json.data.map((m) => m.id),
          }, `${this.logLabel}: requested model missing from /v1/models`);
          return undefined;
        }
        this._servedModel = entry.id;
        // Auto-discover context window from vLLM server — overrides env var/default
        // This prevents mismatch between --max-model-len in vLLM and agent's compaction threshold
        const serverMaxLen = contextWindowFromModelEntry(entry);
        if (serverMaxLen && serverMaxLen > 0) {
          if (this.maxContextWindow !== serverMaxLen) {
            logger.info({ previous: this.maxContextWindow, discovered: serverMaxLen },
              `${this.logLabel}: auto-corrected maxContextWindow from /v1/models`);
          }
          this.maxContextWindow = serverMaxLen;
          // The served max_model_len is ground truth. A native profile may be
          // larger than the current deployment cap (for example a 1M-capable
          // model served at 256K), so that is not a profile bug. Only warn when
          // the static profile is smaller than the backend actually serves.
          try {
            const prof = getModelProfile(this._servedModel);
            if (prof.nativeContextWindow && prof.nativeContextWindow < serverMaxLen) {
              logger.warn({ model: this._servedModel, profileNativeContext: prof.nativeContextWindow, served: serverMaxLen },
                `${this.logLabel}: model-profile nativeContextWindow is smaller than served max_model_len — served value used`);
            }
          } catch { /* profile lookup best-effort */ }
        }
        this._servedModelCache.set(cacheKey, {
          id: entry.id,
          maxContextWindow: serverMaxLen,
          fetchedAt: Date.now(),
        });
        logger.debug(`${this.logLabel}: discovered model=${this._servedModel}, maxContextWindow=${this.maxContextWindow}`);
        return entry.id;
      }
    } catch (err) {
      logger.debug({ err, model: preferredModel }, `${this.logLabel}: /v1/models discovery unavailable`);
    }
    return undefined;
  }

  /**
   * SCLI-81/SCLI-218: per-model window resolvable without a chat() call.
   * Prefers the discovered per-model-id index (covers auto-ladder rungs the
   * session may switch to mid-flight); falls back to the matched-model
   * maxContextWindow discovery behavior.
   */
  contextWindowFor(model: string): number {
    const discovered = this._windowByModelId.get(normalizeModelId(model));
    if (discovered && discovered > 0) return discovered;
    // Before /v1/models discovery (or when Cortex omits context_window), do NOT
    // force the generic 131072 constructor floor onto known large-window models
    // (gpt-5.3-codex-spark is 272k). Prefer the static defaults table.
    const fromDefaults = resolveModelContextWindow(normalizeModelId(model) || model);
    if (fromDefaults > 0 && fromDefaults > this.maxContextWindow) return fromDefaults;
    return this.maxContextWindow;
  }

  /**
   * SCLI-218: conservative compaction target for a (virtual) model — the
   * backend-advertised `extras.context_floor` (or min ladder rung window).
   * Undefined until the CTX-353 server contract ships extras, or for concrete
   * models with no ladder.
   */
  contextFloorFor(model: string): number | undefined {
    return this._contextFloorByModelId.get(normalizeModelId(model));
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    // Use the model from options, falling back to auto-discovered served model
    let model = options.model;
    if (model.startsWith('vllm/')) model = model.slice(5);
    if (model.startsWith('cortex/')) model = model.slice(7);
    const served = await this.getServedModel(model);
    if (!model || model === 'vllm') {
      if (served) model = served;
    }

    const profile = getModelProfile(model);
    const aliases = profile.toolNameAliases ?? {};
    const reverseAliases: Record<string, string> = {};
    for (const [from, to] of Object.entries(aliases)) reverseAliases[to] = from;
    // Every name this turn could legitimately call — used to un-fuse a tool name
    // that vLLM's glm47 parser welded to its first argument (see salvageGlmToolCall).
    const knownToolNames: string[] = [
      ...(options.tools ?? []).map((t) => t.name),
      ...Object.keys(aliases),
      ...Object.keys(reverseAliases),
    ].filter(Boolean);

    let vMessages = toVLlmMessages(messages, options.systemPrompt, profile);

    // Apply user message format (array vs string) per model profile
    if (profile.userMessageFormat === 'array') {
      vMessages = vMessages.map((m) => {
        if (m.role === 'user' && typeof m.content === 'string') {
          return { ...m, content: [{ type: 'text', text: m.content }] };
        }
        return m;
      });
    }

    // Conversation priming — inject context + assistant ack before first user message
    if (profile.conversationPriming && vMessages.length >= 2) {
      const sysIdx = vMessages.findIndex((m) => m.role === 'system');
      const userIdx = vMessages.findIndex((m) => m.role === 'user');
      if (sysIdx >= 0 && userIdx > sysIdx) {
        const contextMsg: VLlmMessage = {
          role: 'user',
          content: profile.userMessageFormat === 'array'
            ? [{ type: 'text', text: `Working directory: ${process.cwd()}\nOS: ${process.platform}` }]
            : `Working directory: ${process.cwd()}\nOS: ${process.platform}`,
        };
        const ackMsg: VLlmMessage = { role: 'assistant', content: 'Understood.' };
        vMessages.splice(userIdx, 0, contextMsg, ackMsg);
      }
    }

    // Load exact tool definitions from file if model was trained on specific schemas
    let tools: Array<Record<string, unknown>> | undefined;
    if (profile.toolDefinitionsFile) {
      try {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const bundlePath = fs.realpathSync(new URL(import.meta.url).pathname);
        const bundleDir = path.dirname(bundlePath);
        const candidates = [
          path.join(bundleDir, '..', 'src', 'prompt', profile.toolDefinitionsFile),
          path.join(bundleDir, profile.toolDefinitionsFile),
          path.join(process.cwd(), 'src', 'prompt', profile.toolDefinitionsFile),
          path.join(process.cwd(), profile.toolDefinitionsFile),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            tools = JSON.parse(fs.readFileSync(p, 'utf-8'));
            logger.info({ path: p, count: tools?.length }, 'Loaded model-specific tool definitions');
            break;
          }
        }
        if (!tools) logger.warn({ file: profile.toolDefinitionsFile, candidates }, 'Tool definitions file not found');
      } catch {
        // Fall through to auto-generated tools
      }
    }
    // Fallback: auto-generate from registry with name aliases
    if (!tools) {
      tools = options.tools?.map((t) => ({
        type: 'function',
        function: {
          name: aliases[t.name] ?? t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    // Also cap max_tokens to match what the model expects.
    const maxTokensCap = profile.recommendedMaxOutputTokens;
    const requestedMaxTokens = options.maxTokens ?? profile.recommendedMaxOutputTokens;
    const rawPromptEstimate =
      countTokens(JSON.stringify(vMessages), model)
      + (tools?.length ? countTokens(JSON.stringify(tools), model) : 0);
    this._rawPromptEstimateLast = rawPromptEstimate;
    const promptTokenEstimate = Math.ceil(rawPromptEstimate * this._calibratedSafetyFactor(model));
    const CONTEXT_GUARD_TOKENS = 256;
    const remainingForOutput = Math.max(1, this.maxContextWindow - promptTokenEstimate - CONTEXT_GUARD_TOKENS);
    let maxTokens = Math.min(requestedMaxTokens, maxTokensCap, remainingForOutput);
    // Interactive TUI + GLM/thinking models: originally clamped to 8192 because
    // at ~20 tok/s a 16-24k output held a max_concurrent=1 backend exclusively
    // for 15-20 minutes and client aborts didn't cancel the server job
    // (operator 2026-07-25). The fleet has since moved to mc=3/5/7 lanes at
    // ~47 tok/s with same-session takeover, so the old premise is gone — while
    // the 8192 clamp actively BROKE big content turns: thinking tokens share
    // max_tokens, so DeepSeek at effort=max truncated large Write tool calls
    // mid-JSON and the turn failed as incomplete 'max_tokens' (2026-08-09).
    // Default now matches the model profile ceiling; the env hatch remains.
    const interactiveTuiEarly = process.env['SHIZUHA_INTERACTIVE_TUI'] === '1';
    const INTERACTIVE_THINKING_MAX_OUT = parseInt(process.env['VLLM_INTERACTIVE_THINKING_MAX_TOKENS'] || '32768', 10);
    if (
      interactiveTuiEarly
      && (model.toLowerCase().includes('glm') || profile.defaultThinkingOn === true)
      && Number.isFinite(INTERACTIVE_THINKING_MAX_OUT)
      && INTERACTIVE_THINKING_MAX_OUT > 0
      && maxTokens > INTERACTIVE_THINKING_MAX_OUT
    ) {
      logger.info({
        requestedMaxTokens: maxTokens,
        clampedMaxTokens: INTERACTIVE_THINKING_MAX_OUT,
        model,
      }, `${this.logLabel}: clamped max_tokens for interactive thinking model`);
      maxTokens = INTERACTIVE_THINKING_MAX_OUT;
    }
    if (maxTokens < requestedMaxTokens) {
      logger.info({
        requestedMaxTokens,
        clampedMaxTokens: maxTokens,
        promptTokenEstimate,
        maxContextWindow: this.maxContextWindow,
      }, `${this.logLabel}: clamped max_tokens to fit prompt within context window`);
    }

    // SCLI-72: Pre-flight context-window guard.
    // Guard on the post-guard-band output budget (remainingForOutput), not raw
    // contextRemaining. Raw contextRemaining can exceed 512 while the actual
    // deliverable output budget (after subtracting CONTEXT_GUARD_TOKENS) is below
    // the floor — e.g. contextRemaining=600, CONTEXT_GUARD_TOKENS=256 →
    // remainingForOutput=344 < 512. Intentionally low-output configs (e.g.
    // maxOutputTokens=200 with a small prompt) don't trip this because their
    // remainingForOutput is large; the guard only fires when the context window
    // itself is the binding constraint.
    const MIN_USABLE_OUTPUT_TOKENS = 512;
    const contextRemaining = this.maxContextWindow - promptTokenEstimate;
    if (remainingForOutput < MIN_USABLE_OUTPUT_TOKENS) {
      const _label = this.baseUrl.includes('cortex') || model.toLowerCase().includes('glm')
        ? 'Cortex/vLLM' : 'vLLM';
      const ctxMsg =
        `${_label}: context window exhausted — ` +
        `served max_model_len=${this.maxContextWindow} tokens, ` +
        `prompt≈${promptTokenEstimate} tokens, ` +
        `only ${remainingForOutput} output tokens remain after guard band (floor: ${MIN_USABLE_OUTPUT_TOKENS}). ` +
        `Compaction did not reduce context sufficiently. ` +
        `Backend needs a larger max_model_len or a fallback backend must be configured.`;
      yield {
        type: 'status',
        level: 'warning',
        provider: _label,
        code: 'context_window_too_small',
        message: ctxMsg,
      };
      const err = new Error(ctxMsg);
      (err as NodeJS.ErrnoException).code = 'CONTEXT_WINDOW_TOO_SMALL';
      throw err;
    }

    // GLM tool-call arguments are not reliable in streamed deltas on current vLLM.
    // Keep the legacy VLLM_STREAM_WITH_TOOLS=0 guard scoped to GLM only: native
    // DeepSeek/Qwen/OpenAI-compatible tool calls must keep streaming so the TUI
    // receives first-token progress instead of buffering the whole tool turn.
    const streamWithToolsEnv = process.env['VLLM_STREAM_WITH_TOOLS'];
    const hasTools = Boolean(tools && tools.length);
    const isGlmModel = model.toLowerCase().includes('glm');
    // GLM glm47 tool parser historically corrupted streamed args (esp. thinking OFF).
    // With thinking ON (SCLI-54 / defaultThinkingOn) structured tool_calls are reliable;
    // non-stream + thinking can take minutes (no bytes until the full completion), which
    // the interactive 120s budget treats as ETIMEDOUT → infinite "first-token stall" retries
    // (shizuha1 GLM-5.2-QuantTrio-256K, operator 2026-07-25). Stream when thinking is on.
    const glmThinkingOn = isGlmModel && shouldEnableThinkingForRequest(model, options.thinkingLevel);
    const forceNonStreamTools = process.env['VLLM_FORCE_NONSTREAM_TOOLS'] === '1';
    const streamWithTools = forceNonStreamTools
      ? false
      : streamWithToolsEnv != null
        ? (streamWithToolsEnv !== '0' || !isGlmModel)
        : (!isGlmModel || glmThinkingOn);
    const useStream = !hasTools || streamWithTools;
    // A dedicated runtime (for example, a Benchboard child pod) may classify
    // every ordinary turn without changing each agent-loop call site. An
    // explicit per-call kind remains authoritative for compaction/warmup.
    const routedRequestKind = options.requestKind
      ?? process.env['VLLM_REQUEST_KIND']?.trim()
      ?? '';
    // Compaction is a deterministic maintenance request, not an agentic turn.
    // DeepSeek-V4-Flash normally forces thinking + max reasoning effort because
    // that is required for reliable tool calls. Compaction has no tools. Letting
    // the agentic profile win here made the model spend the entire output budget
    // in reasoning_content, leaving content empty and triggering a second equally
    // expensive compaction request (live Nagi: 8k tokens / 328s per pass).
    const isCompactionRequest = routedRequestKind === 'compaction';
    const isDeterministicMaintenanceRequest =
      routedRequestKind === 'maintenance' || isCompactionRequest;
    // Native vLLM repetition termination is the first line of defence against
    // open-model text degeneration. Scope it to our managed Cortex runtime,
    // whose request schema is known to support this extension; sending it to an
    // arbitrary third-party vLLM endpoint could otherwise fail the whole turn.
    //
    // Live 2026-08-08: DeepSeek-V4-Flash repeated short "Let me ..." patterns
    // for the entire 8K interactive output budget in multiple 300K+ sessions.
    // Ending after four repeated 3-20-token n-grams limits the bad turn before
    // it can pollute the transcript or consume another full generation.
    const useManagedDeepSeekRepetitionDetection =
      this.name === 'cortex'
      && !isDeterministicMaintenanceRequest
      && normalizeModelId(model).toLowerCase().includes('deepseek-v4-flash');
    const thinkingEnabledForRequest = isCompactionRequest
      ? false
      : shouldEnableThinkingForRequest(model, options.thinkingLevel);
    const body: Record<string, unknown> = {
      model,
      messages: vMessages,
      stream: useStream,
      // Model-card sampling wins for ordinary agentic turns. The gateway's
      // global scaffold default is temperature=0, so caller-first precedence
      // silently defeated model profiles. Maintenance compaction remains on
      // the caller's deterministic temperature and does not inherit agentic
      // reasoning effort.
      // SCLI-451 (operator 2026-08-11): "we control scli — let cortex decide
      // temperature." Precedence for agentic requests:
      //   profile value set  -> send it;
      //   profile EXPLICIT null -> OMIT SAMPLING ENTIRELY (server decides —
      //     the engines pin the model-correct recipe via
      //     --override-generation-config; tuning becomes a server-side
      //     change, no harness roll, no client drift). The old code fell
      //     through to the caller's scaffold temperature (0 = greedy = the
      //     documented DSV4 repetition-loop regime).
      //   profile silent (undefined) -> caller's explicit value, else omit.
      // Deterministic maintenance (compaction) keeps the caller's 0.
      ...(isDeterministicMaintenanceRequest
        ? (options.temperature != null ? { temperature: options.temperature } : {})
        : profile.defaultTemperature != null
          ? { temperature: profile.defaultTemperature }
          : 'defaultTemperature' in profile && profile.defaultTemperature === null
            ? {}
            : options.temperature != null ? { temperature: options.temperature }
            : {}),
      ...(!isDeterministicMaintenanceRequest && profile.defaultTopP != null
        ? { top_p: profile.defaultTopP }
        : {}),
      ...(useManagedDeepSeekRepetitionDetection ? {
        repetition_detection: {
          max_pattern_size: 20,
          min_pattern_size: 3,
          min_count: 4,
        },
      } : {}),
      // Clamp max_tokens using a token estimate plus a small guard band.
      max_tokens: maxTokens,
      // Request usage stats in the stream (vLLM extension); only valid when streaming
      ...(useStream ? { stream_options: { include_usage: true } } : {}),
      // Per-model thinking config: disable thinking unless explicitly requested via /think on
      // Models like Qwen3.5 dump "Thinking Process:" into content when thinking is enabled,
      // which leaks into user-visible output. Only enable when user wants it.
      ...(profile.supportsThinking || profile.disableThinkingExplicitly ? {
        chat_template_kwargs: {
          // SCLI-54 / GLM-5.2: glm47 tool-parser is only reliable with thinking ON.
          // defaultThinkingOn models FORCE thinking — user/settings "off" must not
          // win (2026-07-25: think:off produced raw `<tool_call>…</arg_value>` text
          // instead of structured tool_calls on GLM-5.2-QuantTrio-256K).
          enable_thinking: thinkingEnabledForRequest,
          // DeepSeek V4 DSpark chat templates use `thinking`, while Qwen-family
          // templates use `enable_thinking`. Send both so a non-thinking profile
          // cannot leak reasoning_content when the backend default is thinking=true.
          thinking: thinkingEnabledForRequest,
          // Reasoning effort precedence: env override > the agent's configured
          // reasoningEffort > thinkingLevel==='high' → 'high'. Honoring
          // options.reasoningEffort is what lets fleet agents run
          // shizuha_reasoning_effort=low against a backend whose serving
          // default is high — without it, EVERY agent turn (heartbeats
          // included) generated a long high-effort thought before the first
          // visible token (~35-55s of 'TTFT' that was actually thinking;
          // CTX-389 aftermath, 2026-07-06). GLM-5.2 note still applies: its
          // template only knows high|max, so don't route low/medium agents to
          // GLM (GLM is not currently served).
          ...(isDeterministicMaintenanceRequest
            ? {}
            : (() => {
                const effort = resolveReasoningEffortForRequest(model, {
                  reasoningEffort: options.reasoningEffort,
                  thinkingLevel: options.thinkingLevel,
                });
                return effort ? { reasoning_effort: effort } : {};
              })()),
        },
      } : {}),
    };
    // xAI Grok Chat Completions expects top-level reasoning_effort (Grok Build
    // --reasoning-effort). chat_template_kwargs alone is a vLLM convention and is
    // ignored by api.x.ai / Cortex xai-grok. Mirror the same effort at top-level
    // whenever we resolved one for a Grok model id.
    {
      const resolvedEffort = resolveReasoningEffortForRequest(model, {
        reasoningEffort: options.reasoningEffort,
        thinkingLevel: options.thinkingLevel,
      });
      const modelId = String(options.model || model || '').toLowerCase();
      if (resolvedEffort && (modelId.includes('grok') || modelId.includes('xai/'))) {
        body['reasoning_effort'] = resolvedEffort;
      }
      // Do not send official-API top-level thinking:{type:enabled} to vLLM.
      // chat_template_kwargs.thinking/reasoning_effort is the vLLM spelling;
      // the extra object coincided with garbled 19k first turns (2026-08-14).
    }
    if (tools?.length) {
      body['tools'] = tools;
      if (options.toolChoice) {
        body['tool_choice'] = typeof options.toolChoice === 'string'
          ? options.toolChoice
          : {
              ...options.toolChoice,
              function: {
                ...options.toolChoice.function,
                name: aliases[options.toolChoice.function.name] ?? options.toolChoice.function.name,
              },
            };
      }
      // Allow the model to emit multiple tool calls per assistant message when the profile
      // permits. Critical for multi-image vision tasks: serial reads cause Qwen3_5
      // multimodal sampling to degenerate after ~5 sequential image-laden tool_results.
      if (profile.supportsParallelToolCalls) body['parallel_tool_calls'] = true;
    }
    if (options.stopSequences?.length) body['stop'] = options.stopSequences;

    // CTX-292 / SCLI-190: send an explicit per-conversation routing key so Cortex's
    // `_request_affinity_key()` pins this session to its prefix/KV-warm replica instead
    // of hashing prefix material (which cold-prefills on any prompt-head edit). We key on
    // `session.id` (conversation-stable, the correct routing granularity — a per-agent key
    // would collapse all of one agent's conversations onto one replica and hotspot it).
    // `session_id` is what the affinity key prefers; `user` mirrors openai.ts and the
    // OpenAI-standard fallback. A capacity controller may deliberately provide
    // VLLM_AFFINITY_SESSION_ID to keep sequential background work on one admitted
    // home while local state continues to use its real session id. Guarded on
    // presence → no change when absent (no regression).
    const affinitySessionId = process.env['VLLM_AFFINITY_SESSION_ID']?.trim() || options.sessionId;
    if (affinitySessionId) {
      body['session_id'] = affinitySessionId;
      body['user'] = affinitySessionId;
    }
    // 2026-07-14: tag maintenance calls (compaction) so Cortex records their TTFT
    // under a SEPARATE metric stage (compaction_ttft; never interactive stream_ttft).
    // A ~281k-token compaction prefill legitimately takes minutes and must not
    // pollute the interactive TTFT SLO. Prefer requestKind='compaction' (not
    // legacy 'bulk'). Guarded on presence.
    if (routedRequestKind) {
      body['metadata'] = { ...((body['metadata'] as Record<string, unknown>) ?? {}), request_kind: routedRequestKind };
    }
    if (options.cortexRehome) {
      body['metadata'] = {
        ...((body['metadata'] as Record<string, unknown>) ?? {}),
        cortex_rehome: options.cortexRehome,
      };
    }

    // PLAT-4189 follow-up: byte-level prompt-prefix continuity guard. The vLLM
    // prefix cache only reuses KV for EXACT prefix extensions; a single mutated
    // byte before the append point re-prefills the whole session (20-84s at
    // 50-130k tokens). Fingerprint the canonical payload per session and WARN
    // with the first divergent chunk + owning part whenever a request is not an
    // append-only extension of the previous one. Expected divergences are
    // compaction/trim turns only. Fail-open; disable: SHIZUHA_PROMPT_PREFIX_GUARD=0.
    if (options.sessionId && promptPrefixGuardEnabled()) {
      try {
        const parts: PromptPrefixPart[] = [
          { label: 'model', partClass: 'model', content: model },
          { label: 'tools', partClass: 'tools', content: tools?.length ? JSON.stringify(tools) : '' },
          ...vMessages.map((m, i): PromptPrefixPart => ({
            label: `message[${i}] role=${m.role}`,
            partClass: m.role === 'system' ? 'system' : 'message',
            content: JSON.stringify(m),
          })),
        ];
        const guardKey = `${this.baseUrl}|${options.sessionId}`;
        const observation = vllmPromptPrefixGuard.observe(guardKey, parts);
        if (observation.status === 'divergent') {
          recordPromptPrefixDivergence(this.name, model, observation.divergentPartClass ?? 'unknown');
          logger.warn({
            sessionId: options.sessionId,
            model,
            ...observation,
          }, `${this.logLabel}: prompt prefix DIVERGED from this session's previous request — vLLM will re-prefill from the divergent offset (expected only on compaction/trim turns)`);
        } else {
          logger.debug({
            sessionId: options.sessionId,
            model,
            status: observation.status,
            totalChars: observation.totalChars,
          }, `${this.logLabel}: prompt prefix continuity ok`);
        }
      } catch { /* guard is diagnostics-only — never affect the request */ }
    }

    // Debug: dump request body when VLLM_DEBUG_REQUESTS is set
    const requestBody = JSON.stringify(sanitizeOpenAiPayloadForUtf8(body));
    if (process.env['VLLM_DEBUG_REQUESTS']) {
      const fs = await import('node:fs');
      const debugFile = `/tmp/vllm-request-${Date.now()}.json`;
      fs.writeFileSync(debugFile, requestBody);
      logger.info({ debugFile, msgCount: (body['messages'] as unknown[]).length, maxTokens: body['max_tokens'] }, 'vLLM request dumped');
    }

    // Stream stall timer — bound connection/header establishment and direct
    // vLLM streams. Once Cortex has accepted a streaming response it owns the
    // model-liveness contract: its SSE comments keep the transport observable,
    // and it eventually emits a terminal chunk/error. SCLI must not put a
    // second token-rate/wall-clock deadline around that accepted request.
    const interactiveTui = process.env['SHIZUHA_INTERACTIVE_TUI'] === '1';
    // Fleet/gateway turns are user-visible production requests even though they
    // do not run inside the local TUI. Treat every ordinary, unclassified turn
    // as latency-sensitive; only explicitly tagged maintenance and benchmark
    // work may consume the long batch retry budget. Live Nova evidence
    // (2026-08-02): the old non-TUI default hid 14 Cortex admission timeouts
    // inside one turn and produced a real 109.8s first-output wait.
    const latencySensitiveRequest = interactiveTui
      || (!isDeterministicMaintenanceRequest && routedRequestKind !== 'benchmark');
    // ChatGPT Codex / Spark (external OAuth) is far slower + flakier than local
    // vLLM: 80–100k agent prompts routinely need 30–90s TTFT and sometimes hang
    // until Cortex's upstream timeout. A tight first-token budget aborts a still-
    // alive request, then indefinite session retries re-send the full prompt and
    // look like "errors that never stop" (operator 2026-07-24).
    const isRemoteCodex = /codex-spark|gpt-5\.3-codex|gpt-5\.5|gpt-5\.4|gpt-5\.6/i.test(options.model)
      || this.name === 'cortex' && /codex|spark/i.test(options.model);
    // GLM + thinking: generation ~20 tok/s; large cold prefills can be tens of
    // minutes of silence before the first SSE byte (no tokens during prefill).
    // Aborting mid-prefill + indefinite retry re-sends the full 70k prompt and
    // never yields an answer (operator 2026-07-25: "even if it takes this long
    // we should at least have some answer").
    const isSlowThinkingModel = isGlmModel || profile.defaultThinkingOn === true;
    const defaultStreamStallMs = interactiveTui
      ? (isRemoteCodex ? 180_000 : isSlowThinkingModel ? 300_000 : 90_000)
      : 930_000;
    const configuredStreamStallMs = parseTimeoutMs(
      'VLLM_STREAM_STALL_MS',
      // After first token: allow long think gaps, but not infinite silence.
      // Headless agents wait out Cortex's own 900s inter-token watchdog rather
      // than hanging up first (operator 2026-08-06: agent-kei's 170K cold
      // prefill turn was abandoned client-side while the server was still
      // decoding — "maybe in scli we are giving up way too fast").
      defaultStreamStallMs,
    );
    const rawStreamStallOverride = process.env['VLLM_STREAM_STALL_MS']?.trim();
    const hasExplicitStreamStallOverride = rawStreamStallOverride != null
      && rawStreamStallOverride !== ''
      && Number.isFinite(Number(rawStreamStallOverride))
      && Number(rawStreamStallOverride) > 0;
    let streamStallMs = hasExplicitStreamStallOverride
      ? configuredStreamStallMs
      : requestAwareToolStreamTimeoutMs({
          baseMs: configuredStreamStallMs,
          maxTokens,
          hasTools,
          toolChoice: body['tool_choice'],
        });
    // Floor first-token wait: small prompts still fail in a few minutes if dead.
    // Large prompts scale up via PREFILL_FLOOR_TPS below (not this floor alone).
    const FIRST_TOKEN_TIMEOUT_MS = parseTimeoutMs(
      'VLLM_FIRST_TOKEN_TIMEOUT_MS',
      // Headless floor 900s (operator 2026-08-07: "wait 15 mins minimum
      // before disconnecting"): the adaptive budget underestimated a cold
      // 111K prefill (assumed warmth -> ~325s) and aborted it seconds from
      // completion (agent-kei), wasting the whole prefill AND leaving an
      // orphan stream holding an admission slot server-side.
      interactiveTui
        ? (isRemoteCodex ? 240_000 : isSlowThinkingModel ? 600_000 : 120_000)
        : (isRemoteCodex ? 240_000 : 900_000),
    );
    const NONSTREAM_RESPONSE_TIMEOUT_MS = parseTimeoutMs(
      'VLLM_NONSTREAM_RESPONSE_TIMEOUT_MS',
      interactiveTui
        ? (isRemoteCodex ? 300_000 : isSlowThinkingModel ? 1_800_000 : 120_000)
        : 1_800_000,
    );
    const REQUEST_STATUS_INTERVAL_MS = parseTimeoutMs('VLLM_REQUEST_STATUS_INTERVAL_MS', interactiveTui ? 5_000 : 15_000);
    // PLAT-507: After finish_reason vLLM+GLM keeps the HTTP body open without ever
    // sending [DONE], causing the reader.read() loop to block for up to STREAM_STALL_MS
    // (10 min) before the stall timer fires. Switch to a short drain window instead:
    // if [DONE] doesn't arrive within FINISH_DRAIN_MS after finish_reason, treat the
    // stream as complete and exit cleanly. Default 5 s is generous for a usage chunk.
    const FINISH_DRAIN_MS = parseInt(process.env['VLLM_FINISH_DRAIN_MS'] || '5000', 10);
    // Adaptive first-token budget: scale with prompt size at a CONSERVATIVE floor
    // prefill rate. GLM cold 70k often needs many minutes (and Cortex must not
    // cut the stream earlier — see CORTEX_STREAM_INTER_TOKEN_TIMEOUT_SECONDS).
    // Remote Codex / GLM thinking: ~25–40 tok/s worst-case planning floor.
    // Generic local: 150 tok/s planning floor (was killing 70k GLM at ~8 min).
    const PREFILL_FLOOR_TPS = parseTimeoutMs(
      'VLLM_PREFILL_FLOOR_TPS',
      isRemoteCodex || isSlowThinkingModel ? 25 : 150,
    );
    // Cap: allow up to ~30 min for huge cold prefills in interactive TUI (user
    // wants an answer eventually, not compact-as-workaround).
    const FIRST_TOKEN_MAX_MS = parseTimeoutMs(
      'VLLM_FIRST_TOKEN_MAX_MS',
      // Headless: a 170K+ cold prefill queued behind concurrent decodes can
      // legitimately take 12+ minutes on the DSpark TP4 lanes; abandoning at
      // 15 min wasted the whole prefill (operator 2026-08-06: wait at least
      // 15 min). The adaptive budget below still finishes small prompts fast.
      interactiveTui
        ? (isRemoteCodex || isSlowThinkingModel ? 1_800_000 : 600_000)
        : 1_800_000,
    );
    const firstTokenBudgetMs = Math.min(
      FIRST_TOKEN_MAX_MS,
      Math.max(FIRST_TOKEN_TIMEOUT_MS, Math.ceil((promptTokenEstimate / PREFILL_FLOOR_TPS) * 1000) + 60_000),
    );
    const stallController = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let gotFirstChunk = false;
    let cortexStreamingResponseAccepted = false;
    // PLAT-507: set after finish_reason — arms the short drain timeout in resetStallTimer.
    let sawFinishReason = false;
    // Set when the drain timer expires cleanly (distinct from a mid-response stall).
    let finishDrainCompleted = false;
    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const resetStallTimer = () => {
      clearStallTimer();
      // Cortex is authoritative after it accepts the streaming request. This is
      // deliberately independent of whether a tool parser has emitted its first
      // data frame: DeepSeek can decode an entire first tool call while Cortex
      // sends only comment heartbeats. Keep the caller's AbortSignal active, and
      // re-arm only for the short post-finish drain below.
      if (cortexStreamingResponseAccepted && !sawFinishReason) return;
      // PLAT-507: use a short drain window after finish_reason so a non-closing
      // vLLM/GLM connection doesn't block for the full STREAM_STALL_MS.
      const ms = sawFinishReason
        ? FINISH_DRAIN_MS
        : gotFirstChunk
          ? streamStallMs
          : useStream
            ? firstTokenBudgetMs
            : Math.max(NONSTREAM_RESPONSE_TIMEOUT_MS, firstTokenBudgetMs);
      stallTimer = setTimeout(() => {
        const reason = sawFinishReason
          ? 'finish drain timeout'
          : gotFirstChunk
            ? 'stream stalled'
            : useStream
              ? 'no first chunk'
              : 'non-streaming response timeout';
        stallController.abort(new Error(`vLLM ${reason}: no events for ${Math.round(ms / 1000)}s`));
      }, ms);
    };
    // Combine caller's abort + our stall abort
    const combinedSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, stallController.signal])
      : stallController.signal;

    let response: Response;
    // Retry transient connection errors (fetch failed / ECONNREFUSED / ECONNRESET / socket).
    // vLLM sometimes drops sockets transiently mid-bench; one retry pattern matches
    // Claude Code / OpenAI SDK behavior. 10 attempts × exponential backoff (1s base, 60s cap).
    const MAX_CONN_RETRIES = parseTimeoutMs('VLLM_CONN_RETRIES', interactiveTui ? 2 : 10);
    let connAttempt = 0;
    // A 429 from cortex/vLLM is *capacity backpressure* ("at capacity (N concurrent)"),
    // not a hard error — the request will succeed once a slot frees. Retry persistently
    // rather than failing the task: ~20 attempts × exp backoff capped at 30s ≈ up to ~10min
    // of waiting out a busy backend. Production turns must fail visibly after a
    // bounded wait so the gateway can release the turn and Cortex saturation is
    // not mislabeled as model TTFT. Explicit maintenance/benchmark requests keep
    // the long batch budget. Tunable via VLLM_429_RETRIES when deliberately needed.
    const MAX_429_RETRIES = parseTimeoutMs('VLLM_429_RETRIES', latencySensitiveRequest ? 2 : 20);
    const BASE_429_DELAY_MS = 2_000;
    const MAX_429_DELAY_MS = 30_000;
    let rateAttempt = 0;
    // A 5xx from cortex/vLLM (non-maintenance 503, 500, 502, 504) is *transient*: the
    // backend is overloaded, restarting, or briefly unavailable — NOT a permanent error.
    // Operator directive 2026-06-23: retry ANY provider 5xx with exponential backoff
    // rather than failing the task; the provider will be back at some point and the
    // request will succeed. (4xx — bad request/auth/model-not-found — still throws.)
    // ~40 attempts × exp backoff capped at 30s ≈ up to ~18min of riding out a sick
    // backend. Tunable via VLLM_5XX_RETRIES. Maintenance-503 is handled separately
    // (terminal + pause-till-heartbeat) and never enters this loop.
    const MAX_5XX_RETRIES = parseTimeoutMs('VLLM_5XX_RETRIES', interactiveTui ? 2 : 40);
    const BASE_5XX_DELAY_MS = 2_000;
    const MAX_5XX_DELAY_MS = 30_000;
    let serverErrAttempt = 0;
    // model_leased (another agent holds the exclusivity sprint): NOT a sick
    // backend — hammering 5xx backoff (2–30s × 40) just storms Cortex. Long
    // waits (60s floor / Retry-After / up to 15min) until the lease free or we
    // give up and let the heartbeat re-enter (Rui 2026-07-28).
    const MAX_LEASE_RETRIES = parseTimeoutMs('VLLM_LEASE_RETRIES', interactiveTui ? 1 : 20);
    let leaseAttempt = 0;
    let errBodyText: string | undefined;
    // Client-side endpoint failover (free, no Cloudflare): on a connection-class
    // failure to the primary base URL, rotate to a backup (e.g. the cloud relay
    // central, or a peer node's NodePort) for the next attempt — and back. Set
    // VLLM_FALLBACK_BASE_URLS=comma,separated,urls. Unset → endpoints=[primary],
    // identical to prior behavior.
    const fallbackBaseUrls = (process.env['VLLM_FALLBACK_BASE_URLS'] || '')
      .split(',').map((s) => s.trim().replace(/\/+$/, '').replace(/\/v1$/, '')).filter(Boolean);
    const endpoints = [this.baseUrl, ...fallbackBaseUrls];
    let epIdx = 0;
    let activeBaseUrl = endpoints[0] ?? this.baseUrl;
    const lowerModel = options.model.toLowerCase();
    const providerLabel = this.baseUrl.includes('cortex') || lowerModel.includes('glm')
      ? 'Cortex/vLLM'
      : 'vLLM';
    let endpointLabel = this.baseUrl;
    try {
      const parsed = new URL(this.baseUrl);
      endpointLabel = parsed.host;
    } catch {
      // Keep raw baseUrl for non-URL local values.
    }

    const traceId = randomUUID();
    const requestId = `scli-${traceId.slice(0, 8)}`;
    const spanId = traceId.replace(/-/g, '').slice(0, 16);
    const lifecycle: { requestStart: number; headersReceived?: number; firstChunk?: number; firstToken?: number; completion?: number; abort?: number } = {
      requestStart: Date.now(),
    };
    let telemetryEmitted = false;
    let responseHeaders: Headers | undefined;
    let lastAttemptStartedAt = lifecycle.requestStart;
    const admissionAttempts: Array<{ requestId?: string; status: number; waitMs: number; retryInMs: number }> = [];
    const noteFirstChunk = () => { lifecycle.firstChunk ??= Date.now(); };
    const noteFirstToken = () => {
      noteFirstChunk();
      lifecycle.firstToken ??= Date.now();
    };
    const emitInferenceTelemetry = (args: {
      outcome: 'success' | 'error' | 'timeout' | 'aborted';
      timeoutPhase?: 'connect' | 'headers' | 'first_chunk' | 'mid_stream_stall' | 'finalization' | 'none';
      errorClass?: string;
      upstreamStatus?: number;
      upstreamCode?: string | number;
      upstreamMessage?: string;
      retryCount?: number;
      inputTokens?: number;
      outputTokens?: number;
    }): StreamChunk => {
      const timestamp = Date.now();
      if (args.outcome === 'success') lifecycle.completion ??= timestamp;
      else lifecycle.abort ??= timestamp;
      const event = {
        type: 'inference_telemetry' as const,
        traceId,
        requestId,
        spanId,
        sessionId: options.sessionId,
        agentId: process.env['AGENT_ID'] || process.env['AGENT_NAME'],
        runtimeId: process.env['SHIZUHA_RUNTIME_ID'] || process.env['HOSTNAME'],
        provider: 'vllm',
        harness: providerLabel,
        requestedModel: options.model,
        resolvedModel: model,
        upstreamRequestId: firstHeader(responseHeaders, [
          'x-cortex-upstream-request-id',
          'x-cortex-request-id',
          'x-request-id',
        ]),
        admissionAttempts: admissionAttempts.length > 0 ? [...admissionAttempts] : undefined,
        backend: cortexBackendHint(responseHeaders, activeBaseUrl),
        lifecycle: { ...lifecycle },
        timeoutPhase: args.timeoutPhase ?? 'none',
        errorClass: args.errorClass ?? 'none',
        upstreamStatus: args.upstreamStatus,
        upstreamCode: args.upstreamCode,
        upstreamMessage: args.upstreamMessage,
        retryCount: args.retryCount ?? (connAttempt + rateAttempt + serverErrAttempt),
        outcome: args.outcome,
        inputTokens: args.inputTokens ?? promptTokenEstimate,
        outputTokens: args.outputTokens ?? 0,
        thinkingMode: options.thinkingLevel ?? 'default',
        toolMode: hasTools,
        maxTokens,
        timestamp,
      };
      recordScliInferenceTelemetry({
        provider: event.provider,
        model: event.resolvedModel,
        outcome: event.outcome,
        errorClass: event.errorClass,
        timeoutPhase: event.timeoutPhase,
        firstChunkMs: event.lifecycle.firstChunk ? event.lifecycle.firstChunk - event.lifecycle.requestStart : null,
        firstTokenMs: event.lifecycle.firstToken ? event.lifecycle.firstToken - event.lifecycle.requestStart : null,
      });
      telemetryEmitted = true;
      return event;
    };

    yield {
      type: 'status',
      level: 'info',
      provider: providerLabel,
      code: 'request_start',
      traceId,
      requestId,
      sessionId: options.sessionId,
      waitPhase: 'headers',
      elapsedMs: 0,
      timeoutMs: useStream ? firstTokenBudgetMs : Math.max(NONSTREAM_RESPONSE_TIMEOUT_MS, firstTokenBudgetMs),
      message: 'Waiting for model response...',
    };
    // Cap signature-expiry auth refresh to one attempt per chat() call so a
    // permanently broken refresh path cannot spin forever.
    let authRefreshAttempted = false;
    // eslint-disable-next-line no-constant-condition
    rateRetry: while (true) {
    // Re-build headers each rateRetry so force-refresh / API-key fallback is
    // picked up after a 401 Signature-has-expired (headers used to live outside
    // this loop — continue rateRetry kept sending the dead JWT).
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    {
      const apiKey = this.resolveApiKey();
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const affinitySessionId = process.env['VLLM_AFFINITY_SESSION_ID']?.trim() || options.sessionId;
      if (affinitySessionId) headers['X-Cortex-Session-Id'] = affinitySessionId;
      // WHICH PROCESS is calling. Identity and session were already on the
      // wire, but nothing said what PROGRAM made the request — a long-lived
      // session running under the operator's own JWT could not be attributed
      // to a process without walking /proc, and even then inconclusively
      // (operator 2026-08-06). Descriptive only; Cortex stores it as a label.
      Object.assign(headers, cortexClientHeaders());
      const hostOverride = process.env['VLLM_HOST_HEADER'];
      if (hostOverride) headers['Host'] = hostOverride;
    }
    connAttempt = 0;
    errBodyText = undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        resetStallTimer();
        const requestStartedAt = Date.now();
        lastAttemptStartedAt = requestStartedAt;
        let settled = false;
        let fetchedResponse: Response | undefined;
        const fetchResult = fetch(`${activeBaseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: requestBody,
          signal: combinedSignal,
          // @ts-expect-error — node fetch supports undici dispatcher option
          dispatcher: vllmDispatcher,
        }).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        while (!settled) {
          const result = await Promise.race([
            fetchResult,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), REQUEST_STATUS_INTERVAL_MS)),
          ]);
          if (result) {
            if ('error' in result) throw result.error;
            fetchedResponse = result.value;
            break;
          }
          const elapsedMs = Date.now() - requestStartedAt;
          // SCLI-388: surface budget + recovery once past a soft threshold so the
          // TUI is not stuck on a passive "Waiting…" line for minutes.
          const headerBudgetMs = useStream
            ? firstTokenBudgetMs
            : Math.max(NONSTREAM_RESPONSE_TIMEOUT_MS, firstTokenBudgetMs);
          const softStallMs = parseTimeoutMs(
            'VLLM_SOFT_STALL_MS',
            interactiveTui ? 300_000 : 60_000,
          );
          const pastSoft = elapsedMs >= softStallMs;
          const budgetLabel = `${Math.round(elapsedMs / 1000)}s / ${Math.round(headerBudgetMs / 1000)}s budget`;
          const recoveryHint = pastSoft
            ? ' · Esc to cancel · /model to switch'
            : '';
          yield {
            type: 'status',
            level: pastSoft ? 'warning' : 'info',
            provider: providerLabel,
            code: 'request_wait',
            traceId,
            requestId,
            sessionId: options.sessionId,
            waitPhase: 'headers',
            elapsedMs,
            timeoutMs: headerBudgetMs,
            message: pastSoft
              ? `Waiting for model response (${budgetLabel})${recoveryHint}`
              : 'Waiting for model response...',
          };
        }
        if (!fetchedResponse) {
          const result = await fetchResult;
          if ('error' in result) throw result.error;
          fetchedResponse = result.value;
        }
        response = fetchedResponse;
        responseHeaders = response.headers;
        if (!hasExplicitStreamStallOverride) {
          const advertisedTimeoutMs = cortexAdvertisedStreamTimeoutMs(responseHeaders);
          if (advertisedTimeoutMs != null) {
            streamStallMs = Math.max(streamStallMs, advertisedTimeoutMs);
          }
        }
        lifecycle.headersReceived ??= Date.now();
        if (connAttempt > 0) {
          yield {
            type: 'status',
            level: 'info',
            provider: providerLabel,
            code: 'connection_recovered',
            traceId,
            requestId,
            sessionId: options.sessionId,
            waitPhase: 'first_chunk',
            message: 'Connection recovered; waiting for model response...',
          };
        }
        break;
      } catch (err) {
        clearStallTimer();
        const msg = describeFetchError(err);
        // Stall abort during fetch phase (no response headers yet) — emit the SCLI-22
        // watchdog signal so StruggleAnalyzer detects STALL. The stream-phase stall
        // (gotFirstChunk) is handled in the reader.read() catch below.
        const isFirstResponseTimeout = msg.includes('vLLM no first chunk')
          || msg.includes('vLLM non-streaming response timeout');
        if (isFirstResponseTimeout) {
          if (msg.includes('vLLM non-streaming response timeout')) {
            // CTX-123: counter for Prometheus → PrometheusRule → Alertmanager → Pulse incident pipeline.
            providerTimeouts.inc({ reason: 'nonstream_timeout' });
          }
          (err as { retryable?: boolean }).retryable = true;
          if (!(err as NodeJS.ErrnoException).code) (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
          yield {
            type: 'status' as const,
            code: 'stall_timeout',
            message: `${msg} [trace ${requestId}]`,
            level: 'warning' as const,
            provider: this.name,
            traceId,
            requestId,
            sessionId: options.sessionId,
            waitPhase: 'first_chunk',
            elapsedMs: Date.now() - lifecycle.requestStart,
            timeoutMs: msg.includes('non-streaming')
              ? Math.max(NONSTREAM_RESPONSE_TIMEOUT_MS, firstTokenBudgetMs)
              : firstTokenBudgetMs,
          };
          yield emitInferenceTelemetry({
            outcome: 'timeout',
            timeoutPhase: msg.includes('non-streaming') ? 'first_chunk' : 'first_chunk',
            errorClass: classifyVllmError(msg),
            upstreamMessage: msg,
          });
          throw err;
        }
        const isConnErr =
          msg.includes('fetch failed') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ECONNRESET') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('EAI_AGAIN') ||
          msg.includes('socket hang up') ||
          msg.includes('other side closed');
        if (!isConnErr) throw err;
        connAttempt++;
        if (connAttempt >= MAX_CONN_RETRIES) {
          const exhaustedError = new Error(
            `Cannot connect to vLLM at ${this.baseUrl} after ${connAttempt} retries.\n` +
            `Last error: ${msg}`,
          ) as Error & { code?: string; retryable?: boolean };
          // Long-lived interactive/fleet sessions deliberately retry transient
          // provider outages indefinitely at the session layer. Short-lived
          // benchmark jobs need the opposite behavior: release their scarce
          // task slot after the configured connection attempts are exhausted.
          // Opt-in only so the resilient default remains unchanged.
          if (process.env['VLLM_CONNECT_FAILURE_MODE'] === 'terminal') {
            exhaustedError.code = 'provider_endpoint_unavailable';
            exhaustedError.retryable = false;
          }
          throw exhaustedError;
        }
        const backoffMs = Math.min(60_000, 1000 * 2 ** (connAttempt - 1)) +
          Math.floor(Math.random() * 500);
        logger.warn(
          { attempt: connAttempt, maxRetries: MAX_CONN_RETRIES, backoffMs, err: msg },
          'vLLM connection error — retrying',
        );
        yield {
          type: 'status',
          level: 'warning',
          provider: providerLabel,
          code: 'connection_retry',
          attempt: connAttempt,
          maxAttempts: MAX_CONN_RETRIES,
          retryInMs: backoffMs,
          traceId,
          requestId,
          sessionId: options.sessionId,
          waitPhase: 'retry_backoff',
          message: `${providerLabel} request failed (${endpointLabel}): ${msg}. Retry ${connAttempt}/${MAX_CONN_RETRIES} in ${Math.round(backoffMs / 1000)}s...`,
        };
        // Rotate to the next configured endpoint (primary ↔ backup) so a downed
        // primary fails over without DNS/Cloudflare. No-op when no fallbacks set.
        if (endpoints.length > 1) {
          epIdx = (epIdx + 1) % endpoints.length;
          activeBaseUrl = endpoints[epIdx] ?? this.baseUrl;
          logger.warn({ activeBaseUrl }, 'vLLM endpoint failover — switching base URL');
        }
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }

    if (!response.ok) {
      // CTX-154: maintenance mode. Cortex returns HTTP 503 with
      // {error:{type:"maintenance"}} (and a Retry-After) when the operator has
      // taken this model offline. This is NOT capacity backpressure — do NOT enter
      // the 429 retry loop and do NOT retry within the turn. Surface a clear
      // provider_status, honor Retry-After, and throw a TERMINAL error tagged
      // maintenance:true so the session loop ends the turn cleanly. The agent's
      // normal heartbeat/inbox cycle re-attempts later — the desired behavior
      // (avoids a fleet-wide retry storm against a backend being maintained).
      if (response.status === 503) {
        const bodyText = await response.text();
        let parsedBody: unknown = undefined;
        let isMaintenance = false;
        let maintMsg = '';
        try {
          parsedBody = JSON.parse(bodyText);
          const code = providerErrorCode(parsedBody);
          if (code === 'maintenance') {
            isMaintenance = true;
            maintMsg = providerErrorMessage(parsedBody);
          }
        } catch { /* not JSON — fall through to generic 503 handling below */ }
        if (providerErrorCode(parsedBody) === 'provider_pool_dry' || /provider_pool_dry/i.test(bodyText)) {
          const retryInMs = providerPoolDryRetryMs(parsedBody, response.headers);
          const detail = providerErrorMessage(parsedBody) || `no healthy provider token is available for model ${options.model}`;
          logger.warn({ model: options.model, retryInMs, detail }, 'vLLM provider pool dry — pausing turn until provider cooldown expires (no retry)');
          yield {
            type: 'status',
            level: 'warning',
            provider: providerLabel,
            code: 'provider_pool_dry',
            retryInMs,
            message: `${detail} — provider pool dry; retry after ${Math.ceil(retryInMs / 1000)}s`,
          };
          throw Object.assign(
            new Error(`provider_pool_dry: ${detail}; retry_after_seconds=${Math.ceil(retryInMs / 1000)}; body=${bodyText}`),
            { status: 503, providerPoolDry: true, retryInMs },
          );
        }
        if (isMaintenance) {
          const retryInMs = retryAfterHeaderMs(response.headers) ?? 300_000;
          const detail = maintMsg || `model ${options.model} in maintenance`;
          logger.warn({ model: options.model, retryInMs, detail }, 'vLLM model in maintenance — pausing turn until next heartbeat (no retry)');
          yield {
            type: 'status',
            level: 'warning',
            provider: providerLabel,
            code: 'maintenance',
            retryInMs,
            message: `${detail} — pausing until next heartbeat`,
          };
          throw Object.assign(
            new Error(`model in maintenance: ${detail}`),
            { status: 503, maintenance: true, retryInMs },
          );
        }
        // Agent→model exclusivity lease: another principal holds this model.
        // Long backoff (not 5xx storm). After MAX_LEASE_RETRIES, end the turn
        // so heartbeat re-enters when the sprint may have flipped.
        if (isModelLeasedBody(parsedBody, bodyText)) {
          const detail = providerErrorMessage(parsedBody)
            || `model ${options.model} is leased to another agent`;
          if (leaseAttempt >= MAX_LEASE_RETRIES) {
            const retryInMs = modelLeasedRetryMs(response.headers, leaseAttempt);
            logger.warn(
              { model: options.model, leaseAttempt, detail },
              'vLLM model leased — lease retries exhausted; ending turn for long pause',
            );
            yield {
              type: 'status',
              level: 'warning',
              provider: providerLabel,
              code: 'model_leased',
              retryInMs,
              message: `${detail} — waiting for next sprint (retry after ~${Math.ceil(retryInMs / 1000)}s)`,
            };
            throw Object.assign(
              new Error(`model_leased: ${detail}`),
              { status: 503, modelLeased: true, retryInMs },
            );
          }
          const delayMsLease = modelLeasedRetryMs(response.headers, leaseAttempt);
          leaseAttempt++;
          logger.warn(
            {
              model: options.model,
              leaseAttempt,
              maxRetries: MAX_LEASE_RETRIES,
              delayMs: Math.round(delayMsLease),
              detail,
            },
            'vLLM model leased to another agent — long backoff (not 5xx hammer)',
          );
          yield {
            type: 'status',
            level: 'warning',
            provider: providerLabel,
            code: 'model_leased_retry',
            attempt: leaseAttempt,
            maxAttempts: MAX_LEASE_RETRIES,
            retryInMs: Math.round(delayMsLease),
            message: `${detail}. Waiting for lease release — retry ${leaseAttempt}/${MAX_LEASE_RETRIES} in ${Math.round(delayMsLease / 1000)}s...`,
          };
          await new Promise((r) => setTimeout(r, delayMsLease));
          continue rateRetry;
        }
        // non-maintenance / non-lease 503 — transient overload (backend busy/restarting), NOT
        // permanent. Stash the body and fall through to the unified 5xx retry below.
        errBodyText = bodyText;
      }
      // 401 auth error — one force-refresh + retry when possible. Cortex can
      // reject a JWT whose `exp` still looks valid if the RS256 signing key
      // rotated (or we held a stale JWT). forceRefreshKey rewrites auth.json;
      // continue rateRetry rebuilds headers via resolveApiKey().
      if (response.status === 401 && this.forceRefreshKey && !authRefreshAttempted) {
        const bodyText = await response.text().catch(() => '');
        const isSignatureExpired = /signature has expired|token_not_valid/i.test(bodyText);
        if (isSignatureExpired) {
          authRefreshAttempted = true;
          logger.warn(`${this.logLabel} 401 Signature has expired — forcing token refresh and retry`);
          yield {
            type: 'status',
            level: 'warning',
            provider: providerLabel,
            code: 'auth_refresh_retry',
            message: `${providerLabel} auth token expired (signature rotated). Refreshing and retrying...`,
          };
          const freshToken = await this.forceRefreshKey();
          if (freshToken) {
            // forceRefresh rewrote auth.json; the next rateRetry rebuilds
            // headers via resolveApiKey() which re-reads that file. If the
            // resolver is a static string, pin the fresh token so retry works.
            if (typeof this.apiKeyOrResolver !== 'function') {
              this.apiKeyOrResolver = freshToken;
            }
            logger.info(`${this.logLabel}: token refreshed, retrying request`);
            await new Promise((r) => setTimeout(r, 500));
            continue rateRetry;
          }
          logger.warn(`${this.logLabel}: force-refresh returned no token — falling through to error`);
        }
        throw Object.assign(
          new Error(`vLLM error ${response.status}: ${bodyText}`),
          { status: response.status },
        );
      }
      if (response.status === 429) {
        if (rateAttempt >= MAX_429_RETRIES) {
          throw Object.assign(
            new Error(`vLLM rate limited (429) after ${MAX_429_RETRIES} retries: ${await response.text()}`),
            { status: 429 },
          );
        }
        const retryAfterHeader = response.headers.get('retry-after');
        let delayMs: number;
        if (retryAfterHeader && !isNaN(Number(retryAfterHeader))) {
          delayMs = Math.min(Number(retryAfterHeader) * 1000, MAX_429_DELAY_MS);
        } else {
          delayMs = Math.min(BASE_429_DELAY_MS * Math.pow(2, rateAttempt), MAX_429_DELAY_MS);
          delayMs *= 0.75 + Math.random() * 0.5; // ±25% jitter
        }
        rateAttempt++;
        const upstreamRequestId = firstHeader(response.headers, [
          'x-cortex-upstream-request-id',
          'x-cortex-request-id',
          'x-request-id',
        ]);
        const attemptWaitMs = Math.max(0, Date.now() - lastAttemptStartedAt);
        admissionAttempts.push({
          ...(upstreamRequestId ? { requestId: upstreamRequestId } : {}),
          status: response.status,
          waitMs: attemptWaitMs,
          retryInMs: Math.round(delayMs),
        });
        logger.warn({ rateAttempt, delayMs: Math.round(delayMs) }, 'vLLM 429 rate limited, retrying with backoff');
        yield {
          type: 'status',
          level: 'warning',
          provider: providerLabel,
          code: 'rate_limit_retry',
          attempt: rateAttempt,
          maxAttempts: MAX_429_RETRIES,
          retryInMs: Math.round(delayMs),
          upstreamRequestId,
          attemptWaitMs,
          message: `${providerLabel} rate limited (429). Retry ${rateAttempt}/${MAX_429_RETRIES} in ${Math.round(delayMs / 1000)}s...`,
        };
        await new Promise((r) => setTimeout(r, delayMs));
        continue rateRetry;
      }
      // 5xx server errors (500/502/504, and non-maintenance 503) are transient: the
      // backend is overloaded/restarting/briefly down and WILL recover. Retry with
      // exponential backoff rather than failing the task (operator directive 2026-06-23).
      // 4xx (bad request / auth / model-not-found) is permanent → falls through to throw.
      // model_leased must never enter this path (handled above on 503).
      if (response.status >= 500) {
        const detail = errBodyText ?? await response.text().catch(() => '');
        // Defensive: if body was not consumed in the 503 branch, still long-backoff.
        if (isModelLeasedBody(undefined, detail) || /model_leased|leased to another agent/i.test(detail)) {
          if (leaseAttempt >= MAX_LEASE_RETRIES) {
            throw Object.assign(
              new Error(`model_leased after ${MAX_LEASE_RETRIES} long-backoff retries: ${detail}`),
              { status: 503, modelLeased: true },
            );
          }
          const delayMsLease = modelLeasedRetryMs(new Headers(), leaseAttempt);
          leaseAttempt++;
          logger.warn(
            { leaseAttempt, maxRetries: MAX_LEASE_RETRIES, delayMs: Math.round(delayMsLease) },
            'vLLM model leased (5xx path) — long backoff',
          );
          yield {
            type: 'status',
            level: 'warning',
            provider: providerLabel,
            code: 'model_leased_retry',
            attempt: leaseAttempt,
            maxAttempts: MAX_LEASE_RETRIES,
            retryInMs: Math.round(delayMsLease),
            message: `Model leased to another agent. Long wait ${leaseAttempt}/${MAX_LEASE_RETRIES} (${Math.round(delayMsLease / 1000)}s)...`,
          };
          await new Promise((r) => setTimeout(r, delayMsLease));
          continue rateRetry;
        }
        // Cortex sends an accurate Retry-After on its admission guards (e.g.
        // `latency tail guard: no safe cold-prefill lane` → 5s). Blind
        // exponential backoff ignored it and could idle a full MAX_5XX_DELAY_MS
        // after the lane had already freed, and the hint was then dropped from
        // the thrown error so the session loop repeated the mistake.
        const serverRetryAfterMs = retryAfterHeaderMs(response.headers) ?? null;
        if (serverErrAttempt >= MAX_5XX_RETRIES) {
          throw Object.assign(
            new Error(`vLLM error ${response.status} after ${MAX_5XX_RETRIES} retries: ${detail}`),
            { status: response.status, ...(serverRetryAfterMs ? { retryAfterMs: serverRetryAfterMs } : {}) },
          );
        }
        const expDelayMs5 = Math.min(BASE_5XX_DELAY_MS * Math.pow(2, serverErrAttempt), MAX_5XX_DELAY_MS)
          * (0.75 + Math.random() * 0.5); // ±25% jitter
        // Honor the server hint, but never below the in-provider base delay and
        // never above the exponential we would otherwise have waited.
        const delayMs5 = serverRetryAfterMs
          ? Math.min(Math.max(serverRetryAfterMs, BASE_5XX_DELAY_MS), MAX_5XX_DELAY_MS)
          : expDelayMs5;
        serverErrAttempt++;
        logger.warn(
          {
            status: response.status, serverErrAttempt, maxRetries: MAX_5XX_RETRIES,
            delayMs: Math.round(delayMs5), serverRetryAfterMs,
          },
          serverRetryAfterMs
            ? 'vLLM 5xx server error — retrying on server Retry-After'
            : 'vLLM 5xx server error — retrying with backoff',
        );
        yield {
          type: 'status',
          level: 'warning',
          provider: providerLabel,
          code: 'server_error_retry',
          attempt: serverErrAttempt,
          maxAttempts: MAX_5XX_RETRIES,
          retryInMs: Math.round(delayMs5),
          message: `${providerLabel} server error ${response.status} (${endpointLabel}). Retry ${serverErrAttempt}/${MAX_5XX_RETRIES} in ${Math.round(delayMs5 / 1000)}s...`,
        };
        await new Promise((r) => setTimeout(r, delayMs5));
        continue rateRetry;
      }
      {
        const tailRetryAfterMs = retryAfterHeaderMs(response.headers) ?? null;
        throw Object.assign(
          new Error(`vLLM error ${response.status}: ${await response.text()}`),
          { status: response.status, ...(tailRetryAfterMs ? { retryAfterMs: tailRetryAfterMs } : {}) },
        );
      }
    }
    break; // response.ok — exit rateRetry loop
    } // end rateRetry: while (true)

    const cortexRehome = response.headers.get('x-cortex-rehome')?.trim().toLowerCase();
    if (cortexRehome === 'required') {
      options.onCortexRehomeRequired?.();
    }
    // An accepted header is only an admission signal. The caller still drains
    // this generator to normal successful completion before it promotes the
    // alternate route. Missing acceptance is terminal and deliberately outside
    // the provider retry loops: repeating a full-context maintenance prefill
    // would waste WAN/GPU capacity without a changed routing contract.
    if (options.cortexRehome === 'soft-drain' && cortexRehome !== 'accepted') {
      throw Object.assign(
        new Error(`Cortex soft-drain rehome was not accepted (x-cortex-rehome=${cortexRehome ?? 'missing'})`),
        { code: 'cortex_rehome_not_accepted', retryable: false },
      );
    }

    if (useStream && this.name === 'cortex') {
      cortexStreamingResponseAccepted = true;
      clearStallTimer();
    }

    // ── Non-streaming branch (tool-bearing turns) ──
    // Reliable tool_call parsing: vLLM's tool parsers only work correctly non-streamed.
    // Parse the single JSON response and emit the same event sequence the streaming path would.
    if (!useStream) {
      let data: {
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number; cache_read_tokens?: number };
          input_tokens_details?: { cached_tokens?: number; cache_read_tokens?: number };
          cache_read_tokens?: number;
          cache_read_input_tokens?: number;
        };
        model?: string;
      };
      try {
        data = await response.json() as typeof data;
      } finally {
        clearStallTimer();
      }
      // SCLI-218: surface the concrete served model (differs from the requested
      // model for virtual aliases like cortex/auto).
      if (data.model) {
        const knownWindow = this._windowByModelId.get(normalizeModelId(data.model));
        yield { type: 'served_model', model: data.model, ...(knownWindow ? { contextWindow: knownWindow } : {}) };
      }
      const choice = data.choices?.[0];
      const m = choice?.message;
      const serverToolCalls = m?.tool_calls ?? [];
      let textOut = m?.content ?? '';
      let reasoningOut = m?.reasoning_content ?? m?.reasoning ?? '';
      if (textOut || reasoningOut || serverToolCalls.length > 0) noteFirstToken();
      else noteFirstChunk();
      // GLM-4.7 leaks tool calls as raw <tool_call> tokens in content OR reasoning
      // (vLLM glm47 parser bug — esp. with thinking OFF). ALWAYS recover from BOTH and
      // strip the tokens — SCLI-41: the glm47 parser may ALSO return a server tool_call
      // SHELL with EMPTY `arguments` while the real args live only in these raw tokens.
      // We use the recovered calls to (a) fill empty-args server tool_calls by name, and
      // (b) emit any calls the server missed entirely.
      const recovered: Array<{ name: string; args: Record<string, unknown> }> = [];
      {
        const c = extractGlmToolCalls(textOut); textOut = c.clean; recovered.push(...c.calls);
        const r = extractGlmToolCalls(reasoningOut); reasoningOut = r.clean; recovered.push(...r.calls);
      }
      // Non-stream GLM tool turns: strip thinking markup leaked into content.
      {
        const split = splitThinkMarkup(textOut);
        if (split.reasoning) {
          reasoningOut = reasoningOut
            ? `${reasoningOut}\n${split.reasoning}`
            : split.reasoning;
        }
        textOut = split.content;
        const splitR = splitThinkMarkup(reasoningOut);
        // reasoning field shouldn't contain tags either
        reasoningOut = [splitR.reasoning, splitR.content].filter(Boolean).join('\n').trim();
      }
      const usedRecovered = new Set<number>();
      if (reasoningOut) yield { type: 'reasoning_text', text: reasoningOut };
      if (textOut) yield { type: 'text', text: textOut };
      for (const tc of serverToolCalls) {
        const id = tc.id ?? `vllm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // SCLI-54: vLLM's glm47 tool-parser can leak XML tag fragments into the
        // function name (e.g. `pulse_get_task</arg_value>`), producing a name that
        // matches no registered tool → dispatch fails → model retries the identical
        // malformed call → loop-guard breaks at 5 → repeats forever (observed wedging
        // yuki, 0 productive work). Strip any `<...>`/`</...>` fragment before lookup.
        const rawName = (tc.function?.name ?? '').replace(/<\/?[a-z0-9_]+>/gi, '').trim();
        const name = reverseAliases[rawName] ?? rawName;
        if (name) yield { type: 'tool_use_start', id, name };
        let parsedInput: Record<string, unknown> = {};
        try { parsedInput = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty */ }
        // SCLI-41: glm47 can emit a tool_call with empty args while the real args are in
        // the raw <tool_call> tokens — recover them by name match (first unused match).
        if (Object.keys(parsedInput).length === 0) {
          const idx = recovered.findIndex((g, i) =>
            !usedRecovered.has(i) &&
            (reverseAliases[g.name] ?? g.name) === name &&
            Object.keys(g.args).length > 0);
          if (idx >= 0) { parsedInput = recovered[idx]!.args; usedRecovered.add(idx); }
        }
        yield { type: 'tool_use_end', id, input: parsedInput };
      }
      // Emit any recovered calls the server didn't report at all (the legacy
      // serverToolCalls.length===0 path); skip ones already consumed to fill empties.
      for (let i = 0; i < recovered.length; i++) {
        if (usedRecovered.has(i)) continue;
        const gc = recovered[i];
        if (!gc) continue;
        const id = `vllm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const name = reverseAliases[gc.name] ?? gc.name;
        yield { type: 'tool_use_start', id, name };
        yield { type: 'tool_use_end', id, input: gc.args };
      }
      const fr = choice?.finish_reason;
      // If we recovered GLM tool calls the server missed entirely, signal tool_calls so the
      // agent loop runs them (otherwise it'd treat the turn as a final text answer). Calls
      // recovered only to FILL empty server-tool-call args don't need this (the server
      // already signalled tool_calls).
      const unconsumedRecovered = recovered.length - usedRecovered.size;
      const effReason = unconsumedRecovered > 0 ? 'tool_calls' : (fr === 'length' ? 'max_tokens' : (fr ?? 'stop'));
      yield { type: 'stop_reason', reason: effReason };
      const finalInputTokens = data.usage?.prompt_tokens ?? promptTokenEstimate;
      this._recordPromptUsage(data.usage?.prompt_tokens);
      const finalOutputTokens = data.usage?.completion_tokens ?? 0;
      const cacheReadInputTokens = cacheReadTokensFromUsage(data.usage);
      if (data.usage?.prompt_tokens || data.usage?.completion_tokens) {
        if (cacheReadInputTokens != null && finalInputTokens > 0) {
          logger.info({
            promptTokens: finalInputTokens,
            cachedTokens: cacheReadInputTokens,
            cacheHitRatio: Number((cacheReadInputTokens / finalInputTokens).toFixed(4)),
          }, 'provider cache read');
        }
        yield {
          type: 'usage',
          inputTokens: finalInputTokens,
          outputTokens: finalOutputTokens,
          providerPromptEstimate: promptTokenEstimate,
          ...(cacheReadInputTokens != null ? { cacheReadInputTokens } : {}),
        };
      }
      yield emitInferenceTelemetry({ outcome: 'success', inputTokens: finalInputTokens, outputTokens: finalOutputTokens });
      yield { type: 'done' };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body from vLLM');

    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cacheReadInputTokens: number | undefined;
    let reasoningContent = ''; // SCLI-24: accumulate reasoning_content across chunks
    let inThinkBlock = false;
    let thinkCarry = ''; // partial <think>/</think> across SSE chunk boundaries
    let dsmlCarry = ''; // CTX-645: partial DSML / invoke start across SSE chunks
    let servedModelEmitted = false; // SCLI-218: one served_model event per response

    // Track streaming tool calls (may arrive across multiple SSE chunks)
    const toolCallBuilders = new Map<number, { id: string; name: string; args: string }>();

    // Bulletproof tool-call recovery for the STREAMING path. GLM-4.7 sometimes
    // emits a tool call as raw `<tool_call>…<arg_key>…` markup INSIDE its thinking
    // block (or content) instead of as OpenAI tool_call deltas. The deepseek_r1/
    // glm reasoning parser then swallows it into reasoning_content and the tool
    // parser never sees it → the call is lost and the model stalls. We accumulate
    // reasoning + content and, at finalization, if the server produced NO proper
    // tool_calls, recover any leaked `<tool_call>` markup (same logic the
    // non-streaming branch uses). Text still streams live for UX.
    let accReasoning = '';
    let accContent = '';
    let sawStreamedToolCall = false;
    let toolCallsFinalized = false;
    let recoveredLeakedToolCall = false;
    const buildRecoveredToolEvents = (): StreamChunk[] => {
      if (toolCallsFinalized) return [];
      toolCallsFinalized = true;
      if (sawStreamedToolCall) return []; // server gave real tool calls — trust them
      const combined = `${accReasoning}\n${accContent}`;
      if (!combined.includes('<tool_call>')) return [];
      const { calls } = extractGlmToolCalls(combined);
      if (calls.length === 0) return [];
      recoveredLeakedToolCall = true;
      logger.warn({ recovered: calls.length }, 'vLLM streaming: recovered tool call(s) leaked into reasoning/content markup');
      const events: StreamChunk[] = [];
      for (const gc of calls) {
        const id = `vllm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const name = reverseAliases[gc.name] ?? gc.name;
        events.push({ type: 'tool_use_start', id, name });
        events.push({ type: 'tool_use_end', id, input: gc.args });
      }
      return events;
    };

    const hasPartialModelOutput = () =>
      accReasoning.length > 0
      || accContent.length > 0
      || toolCallBuilders.size > 0
      || completionTokens > 0;
    let stallRecovered = false;
    streamReadLoop: while (true) {
      let readResult: Awaited<ReturnType<typeof reader.read>>;
      try {
        readResult = await reader.read();
      } catch (err) {
        // Caller cancellation (TUI Esc / harness abort) is an intentional
        // terminal boundary, not a retryable stream failure. Preserve the
        // caller's reason and do not emit misleading recovery/stall events.
        if (options.abortSignal?.aborted) {
          clearStallTimer();
          throw options.abortSignal.reason instanceof Error
            ? options.abortSignal.reason
            : err;
        }
        const msg = (err as Error).message ?? String(err);
        // PLAT-507: finish drain timeout — the server never sent [DONE] after finish_reason.
        // This is the GLM/vLLM keep-alive-without-closing bug. Treat it as a clean stream
        // end (stop_reason was already yielded; don't emit stall_timeout noise).
        const isFinishDrain = sawFinishReason && msg.includes('vLLM finish drain timeout');
        if (isFinishDrain) {
          logger.debug({ ms: FINISH_DRAIN_MS }, 'vLLM finish drain timeout — stream closed cleanly');
          finishDrainCompleted = true;
          break;
        }
        const isStall = msg.includes('vLLM stream stalled') || msg.includes('vLLM no first chunk');
        if (isStall) {
          // Signal the SCLI-22 watchdog stall so StruggleAnalyzer can fire STALL
          // without needing its own idle timer (drives off provider_status instead).
          yield {
            type: 'status' as const,
            code: 'stall_timeout',
            message: `${msg} [trace ${requestId}]`,
            level: 'warning' as const,
            provider: this.name,
          };
          if (!telemetryEmitted) {
            yield emitInferenceTelemetry({
              outcome: 'timeout',
              timeoutPhase: gotFirstChunk ? 'mid_stream_stall' : 'first_chunk',
              errorClass: classifyVllmError(msg),
              upstreamMessage: msg,
              outputTokens: completionTokens,
            });
          }
          if (gotFirstChunk) {
            // Operator 2026-08-10 (shizuha2) + 2026-08-15 (shizuha1): a mid-response
            // drop after tokens have arrived must RETRY. Cortex same-session
            // supersede cancels the abandoned upstream, so replay is safe.
            // Fail-closed salvage here stranded shizuha1: 348 tokens + a completed
            // tool call were discarded and the TUI sat on a red banner.
            logger.warn({ msg, completionTokens, hadToolCalls: toolCallBuilders.size > 0 },
              `${this.logLabel} mid-response stall — replaying the turn (supersede protects upstream)`);
            yield {
              type: 'status' as const,
              level: 'warning' as const,
              provider: providerLabel,
              code: 'stream_interrupted_retrying',
              message: `${providerLabel} dropped mid-response after ${completionTokens} tokens (${msg}); retrying the turn automatically`,
            };
            const retryErr = Object.assign(
              new Error(`${this.logLabel} mid-response transport drop: ${msg}`),
              { retryable: true, code: 'ECONNRESET' },
            );
            clearStallTimer();
            throw retryErr;
          }
        } else {
          // SCLI-88 / 2026-08-10: a NON-stall read error mid-stream (undici
          // `terminated`, RST, proxy reset) is a retryable transport drop.
          // Cortex supersedes the abandoned request on replay. Do not fail
          // closed — that is what produced the shizuha1 red banner.
          if (hasPartialModelOutput()) {
            logger.warn({ msg, completionTokens }, `${this.logLabel} stream dropped after partial output — replaying the turn (supersede protects upstream)`);
            yield {
              type: 'status' as const,
              level: 'warning' as const,
              provider: providerLabel,
              code: 'stream_interrupted_retrying',
              message: `${providerLabel} stream dropped after partial output (${msg}); retrying the turn automatically`,
            };
            if (!telemetryEmitted) {
              yield emitInferenceTelemetry({
                outcome: 'error',
                timeoutPhase: 'mid_stream_stall',
                errorClass: classifyVllmError(msg),
                upstreamMessage: msg,
                outputTokens: completionTokens,
              });
            }
            (err as { retryable?: boolean }).retryable = true;
            if (!(err as NodeJS.ErrnoException).code) (err as NodeJS.ErrnoException).code = 'ECONNRESET';
            clearStallTimer();
            throw err;
          }
          (err as { retryable?: boolean }).retryable = true;
          if (!(err as NodeJS.ErrnoException).code) (err as NodeJS.ErrnoException).code = 'ECONNRESET';
          logger.warn({ msg, gotFirstChunk, completionTokens }, `${this.logLabel} stream dropped mid-response — marking retryable`);
          yield {
            type: 'status' as const,
            level: 'warning' as const,
            provider: providerLabel,
            code: 'stream_interrupted',
            message: `${providerLabel} stream dropped${gotFirstChunk ? ' mid-response' : ''} (${msg}) — retrying turn`,
          };
        }
        clearStallTimer();
        throw err;
      }
      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // SSE format: "data: {...}" or "data: [DONE]"
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          gotFirstChunk = true;
          resetStallTimer();
          // Flush any pending tool calls
          for (const [, tc] of toolCallBuilders) {
            let parsedInput: Record<string, unknown> = {};
            try { parsedInput = JSON.parse(tc.args || '{}'); } catch { /* empty */ }
            yield { type: 'tool_use_end', id: tc.id, input: parsedInput };
          }
          toolCallBuilders.clear();
          // Recover leaked-markup tool calls if no finish_reason chunk already did.
          const recovered = buildRecoveredToolEvents();
          if (recovered.length > 0) {
            yield* recovered;
            yield { type: 'stop_reason', reason: 'tool_calls' };
          }

          // SCLI-24: emit a reasoning block if the model produced reasoning_content.
          // This lets the loop surface the reasoning if there was no text output.
          if (reasoningContent.trim()) {
            yield {
              type: 'reasoning',
              id: `r1_${Date.now()}`,
              rawContent: reasoningContent.trim(),
            };
          }

          const finalInputTokens = promptTokens || promptTokenEstimate;
          if (finalInputTokens || completionTokens) {
            if (cacheReadInputTokens != null && finalInputTokens > 0) {
              logger.info({
                promptTokens: finalInputTokens,
                cachedTokens: cacheReadInputTokens,
                cacheHitRatio: Number((cacheReadInputTokens / finalInputTokens).toFixed(4)),
              }, 'provider cache read');
            }
            yield {
              type: 'usage',
              inputTokens: finalInputTokens,
              outputTokens: completionTokens,
              providerPromptEstimate: promptTokenEstimate,
              ...(cacheReadInputTokens != null ? { cacheReadInputTokens } : {}),
            };
          }
          if (!telemetryEmitted) {
            yield emitInferenceTelemetry({ outcome: 'success', inputTokens: finalInputTokens, outputTokens: completionTokens });
          }
          yield { type: 'done' };
          clearStallTimer();
          return;
        }

        let chunk: SSEChunk;
        try {
          chunk = JSON.parse(payload) as SSEChunk;
        } catch {
          continue;
        }
        gotFirstChunk = true;
        noteFirstChunk();
        resetStallTimer();

        // SCLI-218: surface the concrete served model once per response — for a
        // virtual alias (cortex/auto) it differs from the requested model, and
        // the loop re-resolves its compaction window when it changes.
        if (!servedModelEmitted && chunk.model) {
          servedModelEmitted = true;
          const knownWindow = this._windowByModelId.get(normalizeModelId(chunk.model));
          yield { type: 'served_model', model: chunk.model, ...(knownWindow ? { contextWindow: knownWindow } : {}) };
        }

        if (chunk.error) {
          // Use this.logLabel so Cortex-backed sessions don't say "vLLM stream
          // error" (misleading — Cortex may route to Codex/xAI/vLLM backends).
          // Propagate structured code + retryable so the TUI can auto-compact on
          // context_length_exceeded and auto-retry on intermittent OpenAI
          // server_error / timeouts without killing the turn.
          const errMsg = chunk.error.message ?? 'unknown error';
          const errType = (chunk.error as { type?: string }).type ?? '';
          const rawCode = chunk.error.code != null ? String(chunk.error.code) : '';
          const errCodeSuffix = rawCode ? ` (code: ${rawCode})` : '';
          const explicitRetryable = (chunk.error as { retryable?: boolean }).retryable;
          const looksContext =
            /context_length|context window|maximum context|input exceeds|prompt is too long|too many tokens/i.test(
              `${errMsg} ${errType} ${rawCode}`,
            );
          const looksTransient = isTransientProviderFailure({
            message: errMsg,
            code: rawCode,
            type: errType,
            retryable: explicitRetryable,
          });
          const err = new Error(`${this.logLabel} stream error: ${errMsg}${errCodeSuffix}`) as Error & {
            retryable?: boolean;
            code?: string;
          };
          if (rawCode) err.code = rawCode;
          if (looksContext) {
            err.code = err.code || 'context_length_exceeded';
            // Overflow is not "transient network" — session recovers via compact/reset.
          } else if (looksTransient) {
            err.retryable = true;
            // Keep original code when present (server_error) for cooldown/telemetry.
            if (!err.code || err.code === 'unknown') err.code = 'ETIMEDOUT';
          }
          if (looksTransient && hasPartialModelOutput()) {
            // Operator ruling 2026-08-10 (shizuha2, EngineCore 500 mid-turn):
            // a transient engine failure after partial output must NOT end
            // the turn — SCLI retries with backoff and the turn replays.
            // This refusal predates server-side same-session supersede:
            // Cortex now CANCELS the abandoned upstream stream the moment the
            // replayed request arrives (verified live: session_superseded_by_
            // new_turn), so automatic replay no longer risks a doubled
            // upstream. The partial text is discarded (the turn re-streams);
            // routing naturally lands the retry on a healthy sibling once
            // health polls bench the dying backend.
            logger.warn(
              { errMsg, errType, rawCode, completionTokens },
              `${this.logLabel} transient SSE error after partial output — replaying the turn (supersede protects upstream)`,
            );
            err.retryable = true;
            if (!err.code || err.code === 'unknown') err.code = 'ETIMEDOUT';
            yield {
              type: 'status' as const,
              level: 'warning' as const,
              provider: providerLabel,
              code: 'stream_interrupted_retrying',
              message: `${providerLabel} dropped the stream after partial output (${errMsg}); retrying the turn automatically`,
            };
            if (!telemetryEmitted) {
              yield emitInferenceTelemetry({
                outcome: 'error',
                timeoutPhase: 'mid_stream_stall',
                errorClass: classifyVllmError(`${errMsg} ${errType}`, response.status),
                upstreamCode: rawCode,
                upstreamMessage: errMsg,
                outputTokens: completionTokens,
              });
            }
            try { await reader.cancel(); } catch { /* response already ended */ }
            throw err;
          }
          throw err;
        }

        // Usage info (from stream_options.include_usage or final chunk)
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
          this._recordPromptUsage(chunk.usage.prompt_tokens);
          cacheReadInputTokens = cacheReadTokensFromUsage(chunk.usage) ?? cacheReadInputTokens;
        }

        // Guard: speculative decoding / usage-only chunks may have no choices
        if (!chunk.choices?.length) continue;
        for (const choice of chunk.choices) {
          // SCLI-24: reasoning_content (DeepSeek R1, vLLM thinking models) arrives
          // in a separate delta field. Accumulate into reasoningContent for the end-of-stream
          // reasoning block (SCLI-9 surfacing) and stream immediately as reasoning_text.
          // Also handle the `reasoning` field (some vLLM builds use this instead).
          const reasoning = choice.delta.reasoning ?? choice.delta.reasoning_content;
          if (reasoning) {
            noteFirstToken();
            accReasoning += reasoning;
            yield { type: 'reasoning_text', text: reasoning };
          }
          if (choice.delta.reasoning_content) {
            reasoningContent += choice.delta.reasoning_content;
          }

          // Text content — parse <think>...</think> tags as reasoning blocks.
          // Also strips orphan </think> (GLM stream often emits `</think>pong`
          // with no open tag — was leaking into the TUI transcript).
          if (choice.delta.content) {
            noteFirstToken();
            accContent += choice.delta.content;
            const held = holdDsmlStreamDelta(choice.delta.content, dsmlCarry);
            dsmlCarry = held.carry;
            const parsed = consumeThinkStreamDelta(held.text, inThinkBlock, thinkCarry);
            inThinkBlock = parsed.inThinkBlock;
            thinkCarry = parsed.carry;
            for (const r of parsed.reasoning) {
              if (r) yield { type: 'reasoning_text', text: r };
            }
            for (const t of parsed.text) {
              if (t) yield { type: 'text', text: t };
            }
          }

          // Tool calls (streamed incrementally)
          if (choice.delta.tool_calls) {
            noteFirstToken();
            sawStreamedToolCall = true;
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallBuilders.has(idx)) {
                const id = tc.id ?? `vllm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                // SCLI-54: glm47 parser leaks XML tag fragments (e.g. `pulse_get_task</arg_value>`)
                // into the streamed function name → no tool matches → loop-break churn. Strip them.
                const rawName = (tc.function?.name ?? '').replace(/<\/?[a-z0-9_]+>/gi, '').trim();
                // Reverse-alias: map model's tool name back to shizuha's registry name
                const name = reverseAliases[rawName] ?? rawName;
                toolCallBuilders.set(idx, { id, name, args: '' });
                if (name) {
                  yield { type: 'tool_use_start', id, name };
                }
              }
              const builder = toolCallBuilders.get(idx)!;
              // PLAT-507: GLM sometimes sends name only on a later delta (first chunk has
              // id but empty name). If we missed tool_use_start, emit it now.
              if (!builder.name && tc.function?.name) {
                const rawName = tc.function.name.replace(/<\/?[a-z0-9_]+>/gi, '').trim();
                const resolvedName = reverseAliases[rawName] ?? rawName;
                if (resolvedName) {
                  builder.name = resolvedName;
                  yield { type: 'tool_use_start', id: builder.id, name: resolvedName };
                }
              }
              if (tc.function?.arguments) {
                builder.args += tc.function.arguments;
                yield { type: 'tool_use_delta', id: builder.id, input: tc.function.arguments };
              }
            }
          }

          // Stop reason
          if (choice.finish_reason) {
            if (dsmlCarry) {
              const flushedDsml = holdDsmlStreamDelta('', dsmlCarry, true);
              dsmlCarry = '';
              if (flushedDsml.text) {
                const parsed = consumeThinkStreamDelta(flushedDsml.text, inThinkBlock, thinkCarry);
                inThinkBlock = parsed.inThinkBlock;
                thinkCarry = parsed.carry;
                for (const r of parsed.reasoning) {
                  if (r) yield { type: 'reasoning_text', text: r };
                }
                for (const t of parsed.text) {
                  if (t) yield { type: 'text', text: t };
                }
              }
            }
            // Flush any partial think-tag carry as visible text (should be rare).
            if (thinkCarry) {
              const flushed = consumeThinkStreamDelta('', inThinkBlock, thinkCarry + (inThinkBlock ? THINK_CLOSE : ''));
              inThinkBlock = false;
              thinkCarry = '';
              for (const r of flushed.reasoning) {
                if (r) yield { type: 'reasoning_text', text: r };
              }
              for (const t of flushed.text) {
                // Drop pure incomplete tag garbage
                if (t && !/^<\/?t?h?i?n?k?>?$/i.test(t.trim())) yield { type: 'text', text: t };
              }
            }
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
              for (const [, tc] of toolCallBuilders) {
                let parsedInput: Record<string, unknown> = {};
                let parseOk = true;
                try { parsedInput = JSON.parse(tc.args || '{}'); } catch { parseOk = false; }
                // SCLI-57: when a tool call's args fail to parse (the corruption that loops
                // GLM agents), FREEZE the exact reproducible case — the full request body that
                // produced it + the corrupt args + accumulated content/reasoning — to a repro
                // file. Replaying request.json against vLLM reproduces it deterministically.
                if (!parseOk && (tc.args || '').trim()) {
                  // SCLI-57b (PLAT-4186 fallout, ni 2026-07-12): under FORCED named
                  // tool_choice (Cortex heartbeats force pulse_get_my_alerts first), vLLM does
                  // not grammar-constrain the args — whatever text the model emits is
                  // served verbatim as `arguments`. DSV4 on long sessions then emits
                  // either (a) its native DSML markup re-invoking the SAME forced tool
                  // with no args, or (b) a short prose line. Both are semantically an
                  // argument-less call, so the `{}` fallback below is exactly right —
                  // don't warn-spam or freeze a repro for these known-benign shapes.
                  // Fleet evidence: ~490 frozen repros across 18 DSV4 agents, all the
                  // forced heartbeat tool, onset within hours of PLAT-4186 landing.
                  const argsText = tc.args;
                  // Before writing this off as corrupt, try to recover the real
                  // call. A mangled glm47 parse is a HARNESS defect, not a model
                  // error — failing it costs the agent a turn it cannot afford.
                  const salvaged = salvageGlmToolCall(
                    tc.name, argsText, accContent, knownToolNames,
                  );
                  if (salvaged) {
                    logger.warn(
                      { from: tc.name, to: salvaged.name, keys: Object.keys(salvaged.args) },
                      'SCLI-57c: salvaged a mangled GLM tool call instead of dropping it',
                    );
                    if (salvaged.name !== tc.name) {
                      yield { type: 'tool_use_start', id: tc.id, name: salvaged.name };
                    }
                    yield { type: 'tool_use_end', id: tc.id, input: salvaged.args };
                    continue;
                  }
                  const benignSelfInvoke = argsText.includes(`invoke name="${tc.name}"`);
                  const benignProse = !argsText.includes('{') && !argsText.includes('<');
                  if (benignSelfInvoke || benignProse) {
                    logger.debug({ tool: tc.name, shape: benignSelfInvoke ? 'dsml-self-invoke' : 'prose' },
                      'SCLI-57b: unparseable forced-tool args of a known-benign shape — using {}');
                  } else {
                    try {
                      const fs = await import('node:fs');
                      const dir = '/workspace/.shizuha-repro';
                      fs.mkdirSync(dir, { recursive: true });
                      // SCLI-57b: bound the repro dir — each dump can be ~500KB and a
                      // recurring corruption used to freeze EVERY occurrence (54 files /
                      // ~25MB on one agent in a day). Keep at most 3 repros per tool;
                      // the first few instances carry all the diagnostic value.
                      const toolSlug = tc.name.replace(/[^a-z0-9_]/gi, '_');
                      const existing = fs.readdirSync(dir).filter((f) => f.startsWith(`corrupt-${toolSlug}-`));
                      if (existing.length < 3) {
                        fs.writeFileSync(`${dir}/corrupt-${toolSlug}-${Date.now()}.json`,
                          JSON.stringify({ tool: tc.name, corruptArgs: tc.args, accContent, accReasoning, request: JSON.parse(requestBody) }, null, 2));
                        logger.warn({ tool: tc.name, corruptArgs: (tc.args || '').slice(0, 160) }, 'SCLI-57: FROZE corrupt-arg repro case (request + output)');
                      } else {
                        logger.warn({ tool: tc.name, corruptArgs: (tc.args || '').slice(0, 160) }, 'SCLI-57: corrupt args (repro cap reached, not re-freezing)');
                      }
                    } catch (e) { logger.warn({ err: (e as Error).message }, 'SCLI-57 repro dump failed'); }
                  }
                }
                yield { type: 'tool_use_end', id: tc.id, input: parsedInput };
              }
              toolCallBuilders.clear();
              // Recover any tool call that leaked into reasoning/content markup.
              yield* buildRecoveredToolEvents();
            }

            // If we recovered a leaked tool call, the turn must be treated as a
            // tool-call turn so the agent loop runs it (not a final text answer).
            const reason = recoveredLeakedToolCall
              ? 'tool_calls'
              : choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason;
            yield { type: 'stop_reason', reason };
            // PLAT-507: arm short drain window. Some vLLM/GLM deployments keep the
            // HTTP body open indefinitely after finish_reason without sending [DONE].
            // resetStallTimer() will now use FINISH_DRAIN_MS instead of STREAM_STALL_MS.
            sawFinishReason = true;
            resetStallTimer();
          }
        }
      }
    }

    // Stream ended without [DONE] — flush remaining
    for (const [, tc] of toolCallBuilders) {
      let parsedInput: Record<string, unknown> = {};
      try { parsedInput = JSON.parse(tc.args || '{}'); } catch { /* empty */ }
      yield { type: 'tool_use_end', id: tc.id, input: parsedInput };
    }
    // Last-chance leaked-markup recovery (no [DONE]/finish_reason seen).
    if (!stallRecovered) {
      const recovered = buildRecoveredToolEvents();
      if (recovered.length > 0) {
        yield* recovered;
        yield { type: 'stop_reason', reason: 'tool_calls' };
      }
    }

    // Clean up stall timer on successful stream completion
    clearStallTimer();

    if (stallRecovered) {
      // A salvaged half-turn must be DISTINGUISHABLE from a genuine model stop.
      //
      // This used to yield reason 'stop', betting that "the agent loop's
      // thinking-only / no-tool-call recovery will re-prompt if the model
      // produced nothing actionable". That bet lost on 2026-08-05 (tmux
      // shizuha1): a DeepSeek turn streamed ~700 tokens in the first minute,
      // the chunk stream then went silent for STREAM_STALL_MS while the server
      // kept decoding (Cortex later logged the request as client_disconnect at
      // 1037 completion tokens), the salvage saved the partial text as a
      // completed turn — and the recovery it relied on refused to classify a
      // 2,720-char narration as progress-only (the old 700-char cliff). Result:
      // an interactive session idle for ~55 minutes on a half-turn, with the
      // operator concluding the process had died.
      //
      // The classifier cliff is fixed separately; this makes every session loop
      // independent of text classification entirely: an incomplete turn announces
      // itself and fails closed instead of being replayed.
      yield { type: 'stop_reason', reason: 'stall_salvage' };
    }
    // PLAT-507: finishDrainCompleted — stop_reason was already yielded before the
    // drain timer fired; no synthetic stop_reason needed here.

    const finalInputTokens = promptTokens || promptTokenEstimate;
    if (finalInputTokens || completionTokens) {
      if (cacheReadInputTokens != null && finalInputTokens > 0) {
        logger.info({
          promptTokens: finalInputTokens,
          cachedTokens: cacheReadInputTokens,
          cacheHitRatio: Number((cacheReadInputTokens / finalInputTokens).toFixed(4)),
        }, 'provider cache read');
      }
      yield {
        type: 'usage',
        inputTokens: finalInputTokens,
        outputTokens: completionTokens,
        providerPromptEstimate: promptTokenEstimate,
        ...(cacheReadInputTokens != null ? { cacheReadInputTokens } : {}),
      };
    }
    if (!telemetryEmitted) {
      yield emitInferenceTelemetry({ outcome: 'success', inputTokens: finalInputTokens, outputTokens: completionTokens });
    }
    yield { type: 'done' };
  }
}
