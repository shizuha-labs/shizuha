import { afterEach, describe, expect, it, vi } from 'vitest';

// Warmups are retired by default (operator 2026-08-07); these tests exercise
// the preserved mechanism behind the escape hatch.
process.env.SHIZUHA_PREWARM_ENABLE = '1';

import type { Message } from '../../src/agent/types.js';
import type { ChatMessage, ChatOptions, LLMProvider, StreamChunk } from '../../src/provider/types.js';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import {
  buildProviderPrefixSnapshot,
  compareProviderPrefixSnapshots,
  type ProviderPrefixSnapshot,
} from '../../src/telemetry/provider-prefix-continuity.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

interface PrewarmHarness {
  messages: Message[];
  model: string;
  provider: LLMProvider;
  systemPrompt: string;
  toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  maxContextTokens: number;
  sessionId: string | null;
  lastProviderPrefixSnapshot: ProviderPrefixSnapshot | null;
  cortexFirstTurnPrewarmPending: boolean;
  lastCortexPrewarmAt: number;
  prewarmPrefixCache: (
    model: string,
    provider: LLMProvider,
    options: { reason: 'restart' | 'ready_work' | 'post_compaction' | 'soft_drain_rehome'; rehomeIntent?: boolean },
  ) => Promise<boolean>;
  refreshStaleFirstTurnPrewarmBeforeWork: () => Promise<boolean>;
  buildTelemetry: () => Record<string, any>;
}

function makeHarness(): PrewarmHarness {
  const agent = new AgentProcess({
    agentId: 'post-compaction-prewarm-test',
    channels: [],
    model: 'DeepSeek-V4-Flash',
    cwd: '/tmp',
    permissionMode: 'autonomous',
  }) as unknown as PrewarmHarness;
  agent.messages = [
    { role: 'user', content: 'Compacted summary and current objective.' },
    { role: 'assistant', content: 'I will continue from the compacted state.' },
  ];
  agent.systemPrompt = 'stable system prompt';
  agent.toolDefs = [{
    name: 'inspect_state',
    description: 'Inspect state',
    inputSchema: { type: 'object', properties: {} },
  }];
  agent.maxContextTokens = 524_288;
  agent.sessionId = 'agent-session-nami';
  return agent;
}

function recordingProvider(calls: Array<{ messages: ChatMessage[]; options: ChatOptions }>): LLMProvider {
  return {
    name: 'cortex',
    supportsTools: true,
    maxContextWindow: 524_288,
    async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
      calls.push({ messages, options });
      yield { type: 'done' };
    },
  };
}

afterEach(() => {
  delete process.env['SHIZUHA_PREWARM_MIN_TOKENS'];
  delete process.env['SHIZUHA_PREWARM_FRESHNESS_MS'];
  vi.useRealTimers();
});

describe('AgentProcess post-compaction Cortex prewarm', () => {
  it('warms the exact compacted prefix below the restart floor before the first interactive append', async () => {
    process.env['SHIZUHA_PREWARM_MIN_TOKENS'] = '100000';
    const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
    const agent = makeHarness();

    await expect(agent.prewarmPrefixCache(
      'DeepSeek-V4-Flash',
      recordingProvider(calls),
      { reason: 'post_compaction' },
    )).resolves.toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.options).toMatchObject({
      model: 'DeepSeek-V4-Flash',
      systemPrompt: 'stable system prompt',
      maxTokens: 1,
      requestKind: 'warmup',
      sessionId: 'agent-session-nami',
    });
    expect(calls[0]?.messages).toEqual([
      { role: 'user', content: 'Compacted summary and current objective.' },
      { role: 'assistant', content: 'I will continue from the compacted state.' },
    ]);
    expect(calls[0]?.options.tools?.map((tool) => tool.name)).toEqual(['inspect_state']);
    expect(calls[1]).toEqual(calls[0]);

    const firstInteractive = buildProviderPrefixSnapshot({
      model: 'DeepSeek-V4-Flash',
      contextWindow: 524_288,
      systemPrompt: 'stable system prompt',
      tools: calls[0]?.options.tools ?? [],
      chatMessages: [
        ...(calls[0]?.messages ?? []),
        { role: 'user', content: 'Resume the task.' },
      ],
    });
    const continuity = compareProviderPrefixSnapshots(
      agent.lastProviderPrefixSnapshot,
      firstInteractive,
    );
    expect(continuity).toMatchObject({ appendOnly: true, cacheBreaking: false });
  });

  it('does not send maintenance completions to a non-Cortex provider', async () => {
    const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
    const provider = { ...recordingProvider(calls), name: 'openai' };

    await expect(makeHarness().prewarmPrefixCache(
      'DeepSeek-V4-Flash',
      provider,
      { reason: 'post_compaction' },
    )).resolves.toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('adds the explicit soft-drain rehome intent to an out-of-band warmup', async () => {
    process.env['SHIZUHA_PREWARM_MIN_TOKENS'] = '100000';
    const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
    const agent = makeHarness();

    await expect(agent.prewarmPrefixCache(
      'DeepSeek-V4-Flash',
      recordingProvider(calls),
      { reason: 'soft_drain_rehome', rehomeIntent: true },
    )).resolves.toBe(true);

    expect(calls[0]?.options).toMatchObject({
      requestKind: 'warmup',
      cortexRehome: 'soft-drain',
      sessionId: 'agent-session-nami',
    });
  });

  it('fails soft while surfacing a bounded gateway-health error', async () => {
    const provider: LLMProvider = {
      name: 'cortex',
      supportsTools: true,
      maxContextWindow: 524_288,
      async *chat(): AsyncGenerator<StreamChunk> {
        throw new Error('synthetic warmup timeout');
      },
    };
    const agent = makeHarness();

    await expect(agent.prewarmPrefixCache(
      'DeepSeek-V4-Flash',
      provider,
      { reason: 'post_compaction' },
    )).resolves.toBe(false);

    expect(agent.buildTelemetry().health).toMatchObject({
      ok: false,
      consecutive_error_turns: 1,
      recent_errors: [expect.stringContaining(
        'cortex_prefix_prewarm_failed reason=post_compaction: synthetic warmup timeout',
      )],
    });
  });

  it('refreshes an exact startup prewarm when first work arrives after its freshness lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T03:00:00Z'));
    process.env['SHIZUHA_PREWARM_MIN_TOKENS'] = '1000';
    process.env['SHIZUHA_PREWARM_FRESHNESS_MS'] = '5000';
    const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
    const provider = recordingProvider(calls);
    const agent = makeHarness();
    agent.provider = provider;
    agent.messages.push({ role: 'user', content: 'restored context '.repeat(2_000) });

    await expect(agent.prewarmPrefixCache(
      'DeepSeek-V4-Flash',
      provider,
      { reason: 'restart' },
    )).resolves.toBe(true);
    expect(agent.cortexFirstTurnPrewarmPending).toBe(true);
    expect(calls).toHaveLength(2);

    vi.advanceTimersByTime(6_000);
    await expect(agent.refreshStaleFirstTurnPrewarmBeforeWork()).resolves.toBe(true);

    expect(calls).toHaveLength(4);
    expect(calls[2]?.options).toMatchObject({ requestKind: 'warmup' });
    expect(agent.lastCortexPrewarmAt).toBe(Date.now());
  });

  it('does not duplicate a still-fresh startup prewarm on first work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T03:00:00Z'));
    process.env['SHIZUHA_PREWARM_MIN_TOKENS'] = '1000';
    process.env['SHIZUHA_PREWARM_FRESHNESS_MS'] = '5000';
    const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
    const provider = recordingProvider(calls);
    const agent = makeHarness();
    agent.provider = provider;
    agent.messages.push({ role: 'user', content: 'restored context '.repeat(2_000) });

    await agent.prewarmPrefixCache('DeepSeek-V4-Flash', provider, { reason: 'restart' });
    vi.advanceTimersByTime(4_000);
    await expect(agent.refreshStaleFirstTurnPrewarmBeforeWork()).resolves.toBe(true);

    expect(calls).toHaveLength(2);
  });
});
