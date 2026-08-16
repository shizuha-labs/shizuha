import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/agent/types.js';
import type { AgentEvent } from '../../src/events/types.js';
import type { ChatMessage, ChatOptions, LLMProvider, StreamChunk } from '../../src/provider/types.js';
import { AgentSession } from '../../src/tui/session.js';

type SessionHarness = {
  sessionId: string;
  messages: Message[];
  provider: LLMProvider;
  _model: string;
  store: { replaceMessages: ReturnType<typeof vi.fn> };
  effectiveMaxContextTokens: (provider: LLMProvider) => number;
  upsertInterruptCheckpoint: ReturnType<typeof vi.fn>;
  runCompactionWithHeartbeat: (
    fn: (...args: never[]) => Promise<{ messages: Message[]; compacted: boolean }>,
    provider: LLMProvider,
    maxContextTokens: number,
    options: { force?: boolean; abortSignal?: AbortSignal } | undefined,
    phase: 'manual',
  ) => Promise<{ messages: Message[]; compacted: boolean }>;
};

function longSummary(): string {
  return `Manual compaction summary. ${'preserved context '.repeat(260)}`;
}

function sourceMessages(): Message[] {
  return Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index}: ${'small context '.repeat(20)}`,
    timestamp: Date.now() + index,
  }));
}

function prepareSession(provider: LLMProvider): {
  session: AgentSession;
  harness: SessionHarness;
  replaceMessages: ReturnType<typeof vi.fn>;
} {
  const session = new AgentSession();
  const replaceMessages = vi.fn();
  const harness = session as unknown as SessionHarness;
  harness.sessionId = 'manual-compaction-contract';
  harness.messages = sourceMessages();
  harness.provider = provider;
  harness._model = 'cortex/DeepSeek-V4-Flash';
  harness.store = { replaceMessages };
  harness.effectiveMaxContextTokens = () => 524_288;
  harness.upsertInterruptCheckpoint = vi.fn();
  return { session, harness, replaceMessages };
}

describe('manual /compact contract', () => {
  const originalDeadline = process.env['SHIZUHA_COMPACTION_DEADLINE_MS'];
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    if (originalDeadline == null) delete process.env['SHIZUHA_COMPACTION_DEADLINE_MS'];
    else process.env['SHIZUHA_COMPACTION_DEADLINE_MS'] = originalDeadline;
    await Promise.all(sessions.splice(0).map((session) => session.destroy()));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits past the automatic maintenance deadline and compacts below threshold', async () => {
    process.env['SHIZUHA_COMPACTION_DEADLINE_MS'] = '5';
    const capturedOptions: ChatOptions[] = [];
    const provider: LLMProvider = {
      name: 'delayed-manual-provider',
      supportsTools: true,
      maxContextWindow: 524_288,
      contextWindowFor: () => 524_288,
      chat: async function* (_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
        capturedOptions.push(options);
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield { type: 'text', text: longSummary() };
        yield { type: 'usage', inputTokens: 10_000, outputTokens: 300 };
        yield { type: 'done' };
      },
    };
    const { session, harness, replaceMessages } = prepareSession(provider);
    sessions.push(session);
    const events: AgentEvent[] = [];
    session.on('agent_event', (event: AgentEvent) => events.push(event));

    const result = await session.compact('preserve the current production investigation');

    expect(result.compacted).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.requestKind).toBe('compaction');
    expect(capturedOptions[0]?.sessionId).toBe('manual-compaction-contract');
    expect(capturedOptions[0]?.abortSignal?.aborted).toBe(false);
    expect(String(harness.messages[0]?.content)).toContain('[Conversation Summary]');
    expect(replaceMessages).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'provider_status'
      && event.code === 'compaction_manual_deadline')).toBe(false);
    expect(events.some((event) => event.type === 'provider_status'
      && event.code === 'compaction_manual_skipped')).toBe(false);
  });

  it('treats a non-rewrite result from forced manual compaction as an invariant failure', async () => {
    const provider = {
      name: 'manual-invariant-provider',
      supportsTools: true,
      maxContextWindow: 524_288,
      chat: async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'done' };
      },
    } satisfies LLMProvider;
    const { session, harness } = prepareSession(provider);
    sessions.push(session);
    const events: AgentEvent[] = [];
    session.on('agent_event', (event: AgentEvent) => events.push(event));

    await expect(harness.runCompactionWithHeartbeat(
      async () => ({ messages: harness.messages, compacted: false }),
      provider,
      524_288,
      { force: true },
      'manual',
    )).rejects.toThrow('Manual compaction returned without rewriting the context');

    expect(events.some((event) => event.type === 'provider_status'
      && event.code === 'compaction_manual_skipped')).toBe(false);
  });

  it('retries transient serialization failures until the explicit operation succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const provider: LLMProvider = {
      name: 'serialized-manual-provider',
      supportsTools: true,
      maxContextWindow: 524_288,
      contextWindowFor: () => 524_288,
      chat: async function* (): AsyncGenerator<StreamChunk> {
        calls++;
        if (calls === 1) {
          throw Object.assign(
            new Error('vLLM error 503: compaction serialized; retry shortly'),
            { status: 503, retryAfterMs: 1 },
          );
        }
        yield { type: 'text', text: longSummary() };
        yield { type: 'usage', inputTokens: 10_000, outputTokens: 300 };
        yield { type: 'done' };
      },
    };
    const { session, replaceMessages } = prepareSession(provider);
    sessions.push(session);
    const events: AgentEvent[] = [];
    session.on('agent_event', (event: AgentEvent) => events.push(event));

    const pending = session.compact();
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.compacted).toBe(true);
    expect(calls).toBe(2);
    expect(replaceMessages).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'provider_status',
      code: 'compaction_manual_retry',
    }));
  });

  it('lets the user interrupt a long manual compaction without changing persisted context', async () => {
    let providerSignal: AbortSignal | undefined;
    const provider: LLMProvider = {
      name: 'cancellable-manual-provider',
      supportsTools: true,
      maxContextWindow: 524_288,
      contextWindowFor: () => 524_288,
      chat: async function* (_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
        providerSignal = options.abortSignal;
        await new Promise<void>((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => {
            reject(options.abortSignal?.reason ?? new Error('Aborted'));
          }, { once: true });
        });
      },
    };
    const { session, harness, replaceMessages } = prepareSession(provider);
    sessions.push(session);
    const before = structuredClone(harness.messages);

    const pending = session.compact();
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    session.interrupt();

    await expect(pending).rejects.toThrow('Manual compaction interrupted');
    expect(providerSignal?.aborted).toBe(true);
    expect(harness.messages).toEqual(before);
    expect(replaceMessages).not.toHaveBeenCalled();
  });
});

describe('automatic compaction deadline scales with prompt size (2026-08-09 fleet incident)', () => {
  it('source computes a prompt-scaled deadline with 90s floor and 900s cap', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/tui/session.ts', 'utf-8');
    // The flat 90s default aborted every 361K-session compaction attempt and
    // the retry loop threw a fresh mega cold prefill at the fleet every ~90s.
    expect(src).not.toContain("SHIZUHA_COMPACTION_DEADLINE_MS'] || '90000'");
    const idx = src.indexOf('const scaledDeadlineMs');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 400);
    expect(block).toContain('900_000');
    expect(block).toContain('90_000');
    expect(block).toContain('promptTokensForDeadline');
  });
});
