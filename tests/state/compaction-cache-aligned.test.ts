import { afterEach, describe, expect, it, vi } from 'vitest';
import { compactMessages } from '../../src/state/compaction.js';
import {
  cacheAlignedCompactionEligible,
  clearWireRequest,
  recordWireRequest,
  selectCacheAlignedSource,
} from '../../src/state/compaction-wire-snapshot.js';
import { VLlmProvider } from '../../src/provider/vllm.js';
import type { Message } from '../../src/agent/types.js';
import type { ChatMessage } from '../../src/provider/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SUMMARY = '<summary>The original request is to repair the gateway cache path. '
  + 'Files, exact errors, decisions and test results were preserved in detail. '.repeat(80)
  + 'Current work: release qualification is pending; nothing is deployed.</summary>';

function history(count = 12): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' as const : 'user' as const,
    content: `Entry ${index}: ${'Historical result with file paths and errors. '.repeat(400)}`,
    timestamp: index,
  }));
}

function wire(messages: Message[]): ChatMessage[] {
  return messages.map((message) => ({ role: message.role as ChatMessage['role'], content: message.content as string }));
}

function stubCortex(responses: Array<'summary' | 'tool_calls'>) {
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (!init?.body) return Response.json({ data: [{ id: 'grok-4.7', max_model_len: 500000 }, { id: 'GLM-5.3-Flash', max_model_len: 500000 }] });
    bodies.push(JSON.parse(init.body as string));
    const kind = responses[bodies.length - 1] ?? 'summary';
    const chunk = kind === 'summary'
      ? { choices: [{ delta: { content: SUMMARY }, finish_reason: 'stop' }] }
      : { choices: [{ delta: { content: '' }, finish_reason: 'tool_calls' }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  }));
  return bodies;
}

function systemText(body: Record<string, any>): string {
  const first = body.messages?.[0];
  if (first?.role !== 'system') return '';
  return typeof first.content === 'string' ? first.content : JSON.stringify(first.content);
}

describe('CTX-5382 cache-aligned compaction', () => {
  it('is on for Grok on xai/cortex by default, off elsewhere, and env-switchable', () => {
    expect(cacheAlignedCompactionEligible('cortex', 'cortex/grok-4.7', {})).toBe(true);
    expect(cacheAlignedCompactionEligible('xai', 'grok-4.7', {})).toBe(true);
    expect(cacheAlignedCompactionEligible('cortex', 'cortex/GLM-5.3-Flash', {})).toBe(false);
    expect(cacheAlignedCompactionEligible('vllm', 'grok-4.7', {})).toBe(false);
    expect(cacheAlignedCompactionEligible('xai', 'grok-4.7', { SHIZUHA_COMPACTION_CACHE_ALIGNED: '0' })).toBe(false);
    expect(cacheAlignedCompactionEligible('cortex', 'cortex/GLM-5.3-Flash', { SHIZUHA_COMPACTION_CACHE_ALIGNED: '1' })).toBe(true);
  });

  it('only reuses a fresh same-model snapshot that covers the summarized prefix verbatim', () => {
    const provider = new VLlmProvider('http://aligned.invalid', 500000, '', 'cortex');
    const messages = history(6);
    const at = 1_000_000;
    recordWireRequest(provider, {
      model: 'cortex/grok-4.7', systemPrompt: 'SYS', tools: undefined,
      chatMessages: wire(messages), sourceMessages: messages.slice(0, 4), sessionId: 's1', at,
    });
    // value-equal clones (gateway structuredClone) still match
    expect(selectCacheAlignedSource(provider, 'cortex/grok-4.7', structuredClone(messages), 4, at + 1000)).not.toBeNull();
    // prefix extends past what the last request covered
    expect(selectCacheAlignedSource(provider, 'cortex/grok-4.7', messages, 5, at + 1000)).toBeNull();
    // stale (provider cache TTL)
    expect(selectCacheAlignedSource(provider, 'cortex/grok-4.7', messages, 4, at + 15 * 60_000)).toBeNull();
    // different model
    expect(selectCacheAlignedSource(provider, 'cortex/grok-4.8', messages, 4, at + 1000)).toBeNull();
    // mutated history
    const mutated = structuredClone(messages);
    mutated[1]!.content = 'rewritten';
    expect(selectCacheAlignedSource(provider, 'cortex/grok-4.7', mutated, 4, at + 1000)).toBeNull();
    clearWireRequest(provider);
    expect(selectCacheAlignedSource(provider, 'cortex/grok-4.7', messages, 4, at + 1000)).toBeNull();
  });

  it('re-sends the cached wire prefix + one appended instruction, with the same session key', async () => {
    const bodies = stubCortex(['summary']);
    const provider = new VLlmProvider('http://aligned.invalid', 500000, '', 'cortex');
    const messages = history();
    recordWireRequest(provider, {
      model: 'cortex/grok-4.7', systemPrompt: 'AGENT SYSTEM PROMPT', tools: undefined,
      chatMessages: wire(messages), sourceMessages: messages.slice(), sessionId: 'agent-session-1', at: Date.now(),
    });
    const result = await compactMessages(structuredClone(messages), provider, 'cortex/grok-4.7', 500000, { force: true });
    expect(result.compacted).toBe(true);
    expect(JSON.stringify(result.messages[0]!.content)).toContain('release qualification is pending');
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(systemText(body)).toContain('AGENT SYSTEM PROMPT');
    expect(systemText(body)).not.toContain('archived conversation');
    const convo = body.messages.filter((m: any) => m.role !== 'system');
    // Byte-identical prefix: every original wire message, in order, then ONE user instruction.
    expect(convo).toHaveLength(messages.length + 1);
    for (let index = 0; index < messages.length; index++) {
      expect(JSON.stringify(convo[index].content)).toContain(`Entry ${index}:`);
    }
    expect(JSON.stringify(convo.at(-1).content)).toContain('<compaction-request>');
    expect(body.user).toBe('agent-session-1');
    clearWireRequest(provider);
  });

  it('falls back to the legacy request when the aligned call does not produce a summary', async () => {
    const bodies = stubCortex(['tool_calls', 'tool_calls', 'summary']);
    const provider = new VLlmProvider('http://aligned.invalid', 500000, '', 'cortex');
    const messages = history();
    recordWireRequest(provider, {
      model: 'cortex/grok-4.7', systemPrompt: 'AGENT SYSTEM PROMPT', tools: undefined,
      chatMessages: wire(messages), sourceMessages: messages.slice(), sessionId: 'agent-session-2', at: Date.now(),
    });
    const result = await compactMessages(structuredClone(messages), provider, 'cortex/grok-4.7', 500000, { force: true });
    expect(result.compacted).toBe(true);
    // The aligned attempt (possibly retried once by the provider) precedes ONE legacy request.
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.slice(0, -1).every((body) => systemText(body).includes('AGENT SYSTEM PROMPT'))).toBe(true);
    expect(systemText(bodies.at(-1)!)).toContain('archived conversation');
    clearWireRequest(provider);
  });

  it('keeps the legacy request shape for non-Grok models', async () => {
    const bodies = stubCortex(['summary']);
    const provider = new VLlmProvider('http://aligned.invalid', 500000, '', 'cortex');
    const messages = history();
    recordWireRequest(provider, {
      model: 'cortex/GLM-5.3-Flash', systemPrompt: 'AGENT SYSTEM PROMPT', tools: undefined,
      chatMessages: wire(messages), sourceMessages: messages.slice(), sessionId: 'agent-session-3', at: Date.now(),
    });
    await compactMessages(structuredClone(messages), provider, 'cortex/GLM-5.3-Flash', 500000, { force: true });
    expect(bodies).toHaveLength(1);
    expect(systemText(bodies[0]!)).toContain('archived conversation');
  });
});
