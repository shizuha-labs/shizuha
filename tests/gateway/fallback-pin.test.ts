import { afterEach, describe, expect, it, vi } from 'vitest';

// Warmups are retired by default (operator 2026-08-07); these tests exercise
// the preserved managed-Grok fallback prewarm behind the escape hatch.
process.env.SHIZUHA_PREWARM_ENABLE = '1';
import { AgentProcess, modelFallbacksEnv } from '../../src/gateway/agent-process.js';
import type { Message } from '../../src/agent/types.js';
import { messagesToChat, toolDefinitionsForProvider } from '../../src/agent/turn.js';
import {
  buildProviderPrefixSnapshot,
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

type FallbackHarness = AgentProcess & {
  modelFallbacks: Array<{ method: string; model: string }>;
  pinnedFallbackIndex: number;
  pinnedFallbackAt: number;
  retryConfiguredPrimaryIfDue: (
    normalizeModelName: (model: string) => string,
    now?: number,
  ) => boolean;
  alignPinnedFallbackIndexWithActiveModel: (
    activeModel: string,
    normalizeModelName: (model: string) => string,
  ) => boolean;
  toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  messages: Message[];
  model: string;
  provider: { name: string };
  systemPrompt: string;
  maxContextTokens: number;
  cortexWarmPrefixProofs: Map<string, ProviderPrefixSnapshot>;
  providerReg: {
    resolve: (model: string) => any;
    get?: (provider: string) => { name: string } | undefined;
  };
  prewarmManagedGrokFallbackPrefix: (
    activeModel: string,
    reason: 'restart' | 'ready_work' | 'post_compaction' | 'soft_drain_rehome',
  ) => Promise<boolean>;
  executeTurnWithFallback: (
    executeTurn: (...args: any[]) => Promise<unknown>,
    activeModel: string,
    activeProvider: { name: string },
    useFallbackChain: boolean,
    toolContext: unknown,
    msg: { source: string },
    channel: unknown,
    forceHeartbeatQueueTool?: boolean,
    requestKind?: string,
    onCortexRehomeRequired?: () => void,
  ) => Promise<unknown>;
};

const normalizeModelName = (model: string) => model;

function makeHarness(): FallbackHarness {
  return new AgentProcess({
    channels: [],
    model: 'DeepSeek-V4-Flash',
    cwd: '/tmp',
    permissionMode: 'autonomous',
  }) as unknown as FallbackHarness;
}

afterEach(() => {
  delete process.env['SHIZUHA_COLD_FALLBACK_MAX_PROMPT_TOKENS'];
  delete process.env['SHIZUHA_TRANSIENT_PRIMARY_RETRIES'];
  delete process.env['SHIZUHA_FALLBACK_WARM_PROOF_MAX_AGE_MS'];
  delete process.env['SHIZUHA_FALLBACK_PRIMARY_RETRY_MS'];
  delete process.env['SHIZUHA_PREWARM_MIN_TOKENS'];
});

describe('AgentProcess fallback pin alignment', () => {
  // RETIRED 2026-08-06 (operator: "completely remove the concept of model
  // fallbacks ... only one agent-model is allowed"). These two cases used to
  // pin env ACCEPTANCE — legacy-vs-canonical precedence. Both env names are now
  // deliberately ignored so a stale live template (kumo carried a grok→DeepSeek
  // chain for months, undeletable via strategic-merge patch) cannot reintroduce
  // multi-model behaviour behind Hive's back. Full coverage lives in
  // tests/gateway/model-fallbacks-retired.test.ts.
  it('ignores both fallback env names, legacy and canonical', () => {
    const legacy = JSON.stringify([
      { method: 'shizuha', model: 'grok-4.5' },
      { method: 'shizuha', model: 'DeepSeek-V4-Flash' },
    ]);

    expect(modelFallbacksEnv({ MODEL_FALLBACKS: legacy } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(modelFallbacksEnv({
      SHIZUHA_MODEL_FALLBACKS: '[{"model":"canonical"}]',
      MODEL_FALLBACKS: '[{"model":"legacy"}]',
    } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('moves a stale Codex pin to the healthy cross-method active model', () => {
    const agent = makeHarness();
    agent.modelFallbacks = [
      { method: 'codex_app_server', model: 'gpt-5.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.pinnedFallbackIndex = 0;

    const changed = agent.alignPinnedFallbackIndexWithActiveModel('DeepSeek-V4-Flash', normalizeModelName);

    expect(changed).toBe(true);
    expect(agent.pinnedFallbackIndex).toBe(1);
  });

  it('leaves an already-aligned fallback pin unchanged', () => {
    const agent = makeHarness();
    agent.modelFallbacks = [
      { method: 'codex_app_server', model: 'gpt-5.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.pinnedFallbackIndex = 1;

    const changed = agent.alignPinnedFallbackIndexWithActiveModel('DeepSeek-V4-Flash', normalizeModelName);

    expect(changed).toBe(false);
    expect(agent.pinnedFallbackIndex).toBe(1);
  });

  it('does not reset the pin for an active model outside the fallback chain', () => {
    const agent = makeHarness();
    agent.modelFallbacks = [
      { method: 'codex_app_server', model: 'gpt-5.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.pinnedFallbackIndex = 1;

    const changed = agent.alignPinnedFallbackIndexWithActiveModel('manual-test-model', normalizeModelName);

    expect(changed).toBe(false);
    expect(agent.pinnedFallbackIndex).toBe(1);
  });

  it('retries the configured primary after a bounded fallback cooldown', () => {
    process.env['SHIZUHA_FALLBACK_PRIMARY_RETRY_MS'] = '30000';
    const agent = makeHarness();
    const grokProvider = { name: 'cortex-grok' };
    agent.modelFallbacks = [
      { method: 'shizuha/cortex', model: 'grok-4.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.model = 'DeepSeek-V4-Flash';
    agent.provider = { name: 'cortex' };
    agent.providerReg = { resolve: (model) => model === 'grok-4.5' ? grokProvider : { name: 'cortex' } };
    agent.pinnedFallbackIndex = 1;
    agent.pinnedFallbackAt = 1_000;

    expect(agent.retryConfiguredPrimaryIfDue(normalizeModelName, 30_999)).toBe(false);
    expect(agent.pinnedFallbackIndex).toBe(1);

    expect(agent.retryConfiguredPrimaryIfDue(normalizeModelName, 31_000)).toBe(true);
    expect(agent.pinnedFallbackIndex).toBe(0);
    expect(agent.pinnedFallbackAt).toBe(0);
    expect(agent.model).toBe('grok-4.5');
    expect(agent.provider).toBe(grokProvider);
  });

  it('forces the Pulse alert inbox before the task queue on a Cortex heartbeat', async () => {
    const agent = makeHarness();
    agent.toolDefs = [{
      name: 'mcp__shizuha-pulse__pulse_get_my_alerts',
      description: 'Get the current agent alert inbox',
      inputSchema: { type: 'object', properties: {} },
    }];
    const executeTurn = vi.fn(async (...args: any[]) => args[20]);

    const choice = await agent.executeTurnWithFallback(
      executeTurn,
      'DeepSeek-V4-Flash',
      { name: 'cortex' },
      false,
      {},
      { source: 'heartbeat' },
      {},
      true,
    );

    expect(choice).toEqual({
      type: 'function',
      function: { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
    });
  });

  it('keeps non-Cortex turns on automatic tool selection', async () => {
    const agent = makeHarness();
    agent.toolDefs = [{
      name: 'mcp__shizuha-pulse__pulse_get_my_tasks',
      description: 'Get the current agent queue',
      inputSchema: { type: 'object', properties: {} },
    }];
    const executeTurn = vi.fn(async (...args: any[]) => args[20]);

    const choice = await agent.executeTurnWithFallback(
      executeTurn,
      'gpt-5.5',
      { name: 'codex' },
      false,
      {},
      { source: 'heartbeat' },
      {},
      true,
    );

    expect(choice).toBeUndefined();
  });

  it('forwards the one-shot post-compaction tag to the provider turn', async () => {
    const agent = makeHarness();
    const executeTurn = vi.fn(async (...args: any[]) => args[19]);

    const continuity = await agent.executeTurnWithFallback(
      executeTurn,
      'DeepSeek-V4-Flash',
      { name: 'cortex' },
      false,
      {},
      { source: 'user' },
      {},
      false,
      'post_compaction',
    );

    expect(continuity).toMatchObject({
      requestKind: 'post_compaction',
    });
  });

  it('surfaces a rehome signal only after that exact provider attempt succeeds', async () => {
    const agent = makeHarness();
    const required = vi.fn();
    const executeTurn = vi.fn(async (...args: any[]) => {
      args[19].onCortexRehomeRequired();
      return { ok: true };
    });

    await agent.executeTurnWithFallback(
      executeTurn,
      'DeepSeek-V4-Flash',
      { name: 'cortex' },
      false,
      {},
      { source: 'user' },
      {},
      false,
      undefined,
      required,
    );

    expect(required).toHaveBeenCalledTimes(1);
  });

  it('does not leak a failed attempt rehome signal onto a healthy fallback', async () => {
    const agent = makeHarness();
    agent.modelFallbacks = [
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash-fallback' },
    ];
    agent.pinnedFallbackIndex = 0;
    agent.providerReg = { resolve: () => ({ name: 'cortex' }) };
    const required = vi.fn();
    const executeTurn = vi.fn(async (...args: any[]) => {
      if (executeTurn.mock.calls.length === 1) {
        args[19].onCortexRehomeRequired();
        throw new Error('primary stream failed after headers');
      }
      return { ok: true };
    });

    await agent.executeTurnWithFallback(
      executeTurn,
      'DeepSeek-V4-Flash',
      { name: 'cortex' },
      true,
      {},
      { source: 'user', threadId: 'thread' },
      { sendEvent: vi.fn() },
      false,
      undefined,
      required,
    );

    expect(executeTurn).toHaveBeenCalledTimes(2);
    expect(required).not.toHaveBeenCalled();
  });

  it('blocks a huge unproven cold DeepSeek fallback after retrying transient Grok once', async () => {
    process.env['SHIZUHA_COLD_FALLBACK_MAX_PROMPT_TOKENS'] = '1000';
    const agent = makeHarness();
    agent.model = 'grok-4.5';
    agent.provider = { name: 'cortex' };
    agent.messages = [{ role: 'user', content: 'x'.repeat(20_000) }];
    agent.modelFallbacks = [
      { method: 'shizuha/cortex', model: 'grok-4.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.pinnedFallbackIndex = 0;
    agent.providerReg = { resolve: () => ({ name: 'cortex' }) };
    const sendEvent = vi.fn();
    const executeTurn = vi.fn(async (...args: any[]) => {
      if (args[2] === 'grok-4.5') {
        throw Object.assign(new Error('Cortex stream error: Provider upstream stream failed'), {
          retryable: true,
          code: 'provider_error',
        });
      }
      return { ok: true };
    });

    await expect(agent.executeTurnWithFallback(
      executeTurn,
      'grok-4.5',
      { name: 'cortex' },
      true,
      {},
      { source: 'user', threadId: 'thread' },
      { sendEvent },
    )).rejects.toThrow('Provider upstream stream failed');

    expect(executeTurn.mock.calls.map((call) => call[2])).toEqual(['grok-4.5', 'grok-4.5']);
    expect(sendEvent).not.toHaveBeenCalledWith('thread', expect.objectContaining({ type: 'model_fallback' }));
    expect(agent.pinnedFallbackIndex).toBe(0);
    expect(agent.model).toBe('grok-4.5');
    expect(agent.provider).toEqual({ name: 'cortex' });
  });

  it('uses the 8192-token operator ceiling by default for unproven cold fallback', async () => {
    const agent = makeHarness();
    agent.model = 'grok-4.5';
    agent.provider = { name: 'cortex' };
    agent.messages = [{ role: 'user', content: 'x'.repeat(50_000) }];
    agent.modelFallbacks = [
      { method: 'shizuha/cortex', model: 'grok-4.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.pinnedFallbackIndex = 0;
    agent.providerReg = { resolve: () => ({ name: 'cortex' }) };
    const executeTurn = vi.fn(async (...args: any[]) => {
      if (args[2] === 'grok-4.5') {
        throw Object.assign(new Error('Provider upstream stream failed'), { retryable: true });
      }
      return { ok: true };
    });

    await expect(agent.executeTurnWithFallback(
      executeTurn,
      'grok-4.5',
      agent.provider,
      true,
      {},
      { source: 'user', threadId: 'thread-default-cap' },
      { sendEvent: vi.fn() },
    )).rejects.toThrow('Provider upstream stream failed');

    expect(executeTurn.mock.calls.map((call) => call[2])).toEqual(['grok-4.5', 'grok-4.5']);
    expect(agent.pinnedFallbackIndex).toBe(0);
    expect(agent.model).toBe('grok-4.5');
  });

  it('permits a huge cross-provider fallback only with fresh append-compatible warm proof', async () => {
    process.env['SHIZUHA_COLD_FALLBACK_MAX_PROMPT_TOKENS'] = '1000';
    const agent = makeHarness();
    const deepSeekProvider = { name: 'cortex' };
    agent.messages = [{ role: 'user', content: 'x'.repeat(20_000) }];
    agent.modelFallbacks = [
      { method: 'shizuha/cortex', model: 'grok-4.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.pinnedFallbackIndex = 0;
    agent.providerReg = { resolve: () => deepSeekProvider };
    agent.cortexWarmPrefixProofs.set('DeepSeek-V4-Flash', buildProviderPrefixSnapshot({
      model: 'DeepSeek-V4-Flash',
      contextWindow: agent.maxContextTokens,
      systemPrompt: agent.systemPrompt,
      tools: toolDefinitionsForProvider(agent.toolDefs, deepSeekProvider as any),
      chatMessages: messagesToChat(agent.messages),
    }));
    const executeTurn = vi.fn(async (...args: any[]) => {
      if (args[2] === 'grok-4.5') {
        throw Object.assign(new Error('Cortex stream error: Provider upstream stream failed'), {
          retryable: true,
        });
      }
      return { ok: true };
    });

    await expect(agent.executeTurnWithFallback(
      executeTurn,
      'grok-4.5',
      { name: 'cortex' },
      true,
      {},
      { source: 'user', threadId: 'thread' },
      { sendEvent: vi.fn() },
    )).resolves.toEqual({ ok: true });

    expect(executeTurn.mock.calls.map((call) => call[2])).toEqual([
      'grok-4.5',
      'grok-4.5',
      'DeepSeek-V4-Flash',
    ]);
    expect(agent.pinnedFallbackIndex).toBe(1);
  });

  it('prewarms one configured local fallback for managed Grok and then fails over warm', async () => {
    process.env['SHIZUHA_COLD_FALLBACK_MAX_PROMPT_TOKENS'] = '1000';
    process.env['SHIZUHA_PREWARM_MIN_TOKENS'] = '1000';
    const agent = makeHarness();
    agent.messages = [{ role: 'user', content: 'restored work '.repeat(4_000) }];
    agent.systemPrompt = 'stable managed Grok prompt';
    agent.toolDefs = [];
    agent.maxContextTokens = 524_288;
    agent.modelFallbacks = [
      { method: 'shizuha/cortex', model: 'grok-4.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
      { method: 'shizuha/cortex', model: 'Qwen3-Coder-Next' },
    ];
    agent.pinnedFallbackIndex = 0;
    const warmModels: string[] = [];
    const localProvider = {
      name: 'cortex',
      async *chat(_messages: unknown, options: { model: string }) {
        warmModels.push(options.model);
        yield { type: 'done' };
      },
    };
    agent.providerReg = { resolve: () => localProvider };

    await expect(agent.prewarmManagedGrokFallbackPrefix(
      'grok-4.5',
      'restart',
    )).resolves.toBe(true);

    // DeepSeek's hybrid APC intentionally receives two serial warm passes;
    // the next configured local fallback is not warmed, bounding maintenance.
    expect(warmModels).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Flash']);
    expect(agent.cortexWarmPrefixProofs.has('DeepSeek-V4-Flash')).toBe(true);
    expect(agent.cortexWarmPrefixProofs.has('Qwen3-Coder-Next')).toBe(false);

    const executeTurn = vi.fn(async (...args: any[]) => {
      if (args[2] === 'grok-4.5') {
        throw Object.assign(new Error('provider pool dry'), {
          code: 'provider_pool_dry',
          retryable: true,
        });
      }
      return { ok: true };
    });

    await expect(agent.executeTurnWithFallback(
      executeTurn,
      'grok-4.5',
      { name: 'cortex' },
      true,
      {},
      { source: 'user', threadId: 'thread' },
      { sendEvent: vi.fn() },
    )).resolves.toEqual({ ok: true });

    expect(executeTurn.mock.calls.map((call) => call[2])).toEqual([
      'grok-4.5',
      'grok-4.5',
      'DeepSeek-V4-Flash',
    ]);
    expect(agent.pinnedFallbackIndex).toBe(1);
  });

  it('re-establishes a missing fallback proof on demand before a large Grok failover', async () => {
    process.env['SHIZUHA_COLD_FALLBACK_MAX_PROMPT_TOKENS'] = '1000';
    process.env['SHIZUHA_PREWARM_MIN_TOKENS'] = '1000';
    const agent = makeHarness();
    agent.messages = [{ role: 'user', content: 'durable session '.repeat(4_000) }];
    agent.systemPrompt = 'stable managed Grok prompt';
    agent.toolDefs = [];
    agent.maxContextTokens = 524_288;
    agent.modelFallbacks = [
      { method: 'shizuha/cortex', model: 'grok-4.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.pinnedFallbackIndex = 0;
    const warmModels: string[] = [];
    agent.providerReg = {
      resolve: () => ({
        name: 'cortex',
        async *chat(_messages: unknown, options: { model: string }) {
          warmModels.push(options.model);
          yield { type: 'done' };
        },
      }),
    };
    const executeTurn = vi.fn(async (...args: any[]) => {
      if (args[2] === 'grok-4.5') {
        throw Object.assign(new Error('provider pool dry'), {
          code: 'provider_pool_dry',
          retryable: true,
        });
      }
      return { ok: true };
    });

    await expect(agent.executeTurnWithFallback(
      executeTurn,
      'grok-4.5',
      { name: 'cortex' },
      true,
      {},
      { source: 'user', threadId: 'thread' },
      { sendEvent: vi.fn() },
    )).resolves.toEqual({ ok: true });

    expect(warmModels).toEqual(['DeepSeek-V4-Flash', 'DeepSeek-V4-Flash']);
    expect(executeTurn.mock.calls.map((call) => call[2])).toEqual([
      'grok-4.5',
      'grok-4.5',
      'DeepSeek-V4-Flash',
    ]);
    expect(agent.pinnedFallbackIndex).toBe(1);
  });

  it('keeps ordinary small-history fallback behavior', async () => {
    process.env['SHIZUHA_COLD_FALLBACK_MAX_PROMPT_TOKENS'] = '1000';
    const agent = makeHarness();
    agent.messages = [{ role: 'user', content: 'small request' }];
    agent.modelFallbacks = [
      { method: 'shizuha/cortex', model: 'grok-4.5' },
      { method: 'shizuha/cortex', model: 'DeepSeek-V4-Flash' },
    ];
    agent.pinnedFallbackIndex = 0;
    agent.providerReg = { resolve: () => ({ name: 'cortex' }) };
    const executeTurn = vi.fn(async (...args: any[]) => {
      if (args[2] === 'grok-4.5') {
        throw Object.assign(new Error('temporary upstream stream failed'), { retryable: true });
      }
      return { ok: true };
    });

    await expect(agent.executeTurnWithFallback(
      executeTurn,
      'grok-4.5',
      { name: 'cortex' },
      true,
      {},
      { source: 'user', threadId: 'thread' },
      { sendEvent: vi.fn() },
    )).resolves.toEqual({ ok: true });

    expect(executeTurn.mock.calls.map((call) => call[2])).toEqual([
      'grok-4.5',
      'grok-4.5',
      'DeepSeek-V4-Flash',
    ]);
  });
});
