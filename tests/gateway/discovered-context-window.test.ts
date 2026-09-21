import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import type { Channel, InboundMessage } from '../../src/gateway/types.js';
import type { ChatMessage, ChatOptions, StreamChunk } from '../../src/provider/types.js';
import { VLlmProvider } from '../../src/provider/vllm.js';
import { resolveEffectiveContextWindow } from '../../src/provider/context-window.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { StateStore } from '../../src/state/store.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ResponseBuilder } from '../helpers/mock-provider.js';
import * as context from '../../src/prompt/context.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/platform/pulse-self-availability.js', () => ({ markPulseSelfAvailability: vi.fn(async () => {}) }));

const agents = new Map<any, string>();
const defaultModel = 'DeepSeek-V4-Flash-Vision-Metal';
const catalogs = new Map<string, Array<{ id: string; max_model_len: number }>>();
let discoveryRequests: string[] = [];

beforeEach(() => {
  vi.stubEnv('SHIZUHA_PREWARM_ENABLE', '0');
  vi.stubEnv('SHIZUHA_TALK_SUPPRESS_TOOLS', '0');
  vi.stubEnv('SHIZUHA_TRANSIENT_PRIMARY_RETRIES', '0');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.endsWith('/v1/models')) throw new Error(`Unexpected network request: ${url}`);
    discoveryRequests.push(url);
    return Response.json({ data: catalogs.get(new URL(url).origin) ?? [] });
  }));
});

afterEach(async () => {
  for (const [agent, cwd] of agents) {
    await agent.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
  agents.clear();
  catalogs.clear();
  discoveryRequests = [];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function harness(options: { configured?: number; initialWindow?: number; model?: string } = {}) {
  const model = options.model ?? defaultModel;
  const endpoint = 'http://primary.invalid';
  catalogs.set(endpoint, options.initialWindow
    ? [{ id: `cortex/${model}`, max_model_len: options.initialWindow }]
    : [{ id: 'cortex/GLM-5.3-Flash', max_model_len: 500000 }]);
  const provider = new VLlmProvider(endpoint, undefined, 'fixture', 'cortex');
  await provider.getServedModel(model);
  const cwd = mkdtempSync(path.join(tmpdir(), 'gateway-discovery-'));
  const agent = new AgentProcess({ channels: [], model, cwd, permissionMode: 'autonomous', agentId: path.basename(cwd) }) as any;
  agents.set(agent, cwd);
  const registry = new ToolRegistry();
  const channel: Channel = {
    id: 'test', type: 'http', start: vi.fn(), stop: vi.fn(), sendEvent: vi.fn(async () => {}),
    sendComplete: vi.fn(), ackProcessed: vi.fn(async () => true), sendTelemetry: vi.fn(),
  };
  Object.assign(agent, {
    provider, toolRegistry: registry, toolDefs: registry.definitions(),
    permissions: new PermissionEngine('autonomous'), emitter: new AgentEventEmitter(),
    store: new StateStore(path.join(cwd, 'state.db')),
    maxContextTokens: resolveEffectiveContextWindow(model, provider, options.configured),
    configuredMaxContextTokens: options.configured,
    contextWindowSource: { model, provider }, maxOutputTokens: 4096,
    systemPrompt: 'Preserve the verified receipt and report the concrete result.',
  });
  agent.bindStoreWirePrefixInvalidation();
  agent.registerChannel(channel);
  agent.loadEternalSession();
  const calls: Array<{ provider: string; messages: ChatMessage[]; options: ChatOptions; window: number }> = [];
  const attachChat = (target: VLlmProvider, fail = false) => vi.spyOn(target, 'chat').mockImplementation(async function* (messages, chatOptions): AsyncGenerator<StreamChunk> {
    calls.push({ provider: target.name, messages: structuredClone(messages), options: chatOptions, window: agent.maxContextTokens });
    if (fail) throw new Error('Primary model unavailable');
    await target.getServedModel(chatOptions.model);
    if (chatOptions.requestKind === 'compaction') throw new Error('Unexpected semantic compaction in context fixture');
    yield* ResponseBuilder.textOnly('The deployment receipt is verified and the recorded source identity is unchanged.');
  });
  attachChat(provider);
  const inbound = (id: string, messageModel?: string): InboundMessage => ({
    id, channelId: channel.id, channelType: channel.type, threadId: id, userId: 'operator',
    content: 'Report the verified receipt without changing its source.', source: 'user', timestamp: Date.now(),
    ...(messageModel ? { model: messageModel } : {}),
  });
  const discover = async (window: number, discoveredModel = model) => {
    catalogs.set(endpoint, [{ id: `cortex/${discoveredModel}`, max_model_len: window }]);
    await provider.getServedModel(discoveredModel, { forceRefresh: true });
  };
  return { agent, provider, channel, calls, inbound, discover, attachChat, endpoint, model };
}

describe('gateway consumes positively discovered model context', () => {
  it('refreshes failed startup discovery after an ordinary turn and preserves the next request history', async () => {
    const runtime = await harness();
    expect(runtime.agent.maxContextTokens).toBe(131072);
    catalogs.set(runtime.endpoint, [{ id: `cortex/${defaultModel}`, max_model_len: 1048576 }]);
    await runtime.agent.processInboxMessage(runtime.inbound('first'));
    expect(runtime.provider.maxContextWindow).toBe(1048576);
    const history = structuredClone(runtime.agent.messages);
    const wirePrefix = structuredClone(runtime.agent.providerWirePrefix);
    const replace = vi.spyOn(runtime.agent.store, 'replaceMessages');
    runtime.agent.lastReportedPromptTokens = 180000;
    const requestsBefore = discoveryRequests.length;
    await runtime.agent.processInboxMessage(runtime.inbound('second'));
    expect(runtime.agent.maxContextTokens).toBe(1048576);
    expect(runtime.calls.map((call) => call.options.requestKind)).toEqual([undefined, undefined]);
    expect(runtime.calls.map((call) => call.options.maxTokens)).toEqual([4096, 4096]);
    expect(runtime.agent.messages.slice(0, history.length)).toEqual(history);
    expect(runtime.agent.providerWirePrefix.messages.slice(0, wirePrefix.messages.length)).toEqual(wirePrefix.messages);
    expect(replace).not.toHaveBeenCalled();
    expect(discoveryRequests).toHaveLength(requestsBefore);
  });

  it('recovers the context consumer after discovery succeeds inside a failed compaction without replacing history', async () => {
    const runtime = await harness();
    runtime.agent.lastReportedPromptTokens = 180000;
    catalogs.set(runtime.endpoint, [{ id: `cortex/${defaultModel}`, max_model_len: 1048576 }]);
    const replace = vi.spyOn(runtime.agent.store, 'replaceMessages');
    await runtime.agent.processInboxMessage(runtime.inbound('failed-compaction'));
    expect(runtime.calls[0]!.options.requestKind).toBe('compaction');
    expect(runtime.provider.maxContextWindow).toBe(1048576);
    const retained = structuredClone(runtime.agent.messages);
    await runtime.agent.processInboxMessage(runtime.inbound('next-ordinary-attempt'));
    expect(runtime.calls.at(-1)!.options.requestKind).toBeUndefined();
    expect(runtime.agent.maxContextTokens).toBe(1048576);
    expect(runtime.agent.messages.slice(0, retained.length)).toEqual(retained);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does not import another advertised model window after unavailable startup discovery', async () => {
    const runtime = await harness();
    await runtime.discover(1048576, 'Different-Model');
    await runtime.agent.processInboxMessage(runtime.inbound('missing'));
    expect(runtime.provider.maxContextWindow).toBe(1048576);
    expect(runtime.agent.maxContextTokens).toBe(131072);
    expect(runtime.calls).toHaveLength(1);
  });

  it('uses a lower positive served window even when it equals the generic constructor floor', async () => {
    const runtime = await harness({ model: 'DeepSeek-V4-Flash', initialWindow: 1048576 });
    await runtime.agent.processInboxMessage(runtime.inbound('high'));
    await runtime.discover(131072);
    await runtime.agent.processInboxMessage(runtime.inbound('lower'));
    expect(runtime.calls.map((call) => call.window)).toEqual([1048576, 131072]);
    expect(runtime.agent.maxContextTokens).toBe(131072);
  });

  it('keeps the explicit configured cap separate across low, high and lower discoveries', async () => {
    const runtime = await harness({ configured: 200000, initialWindow: 98000 });
    await runtime.agent.processInboxMessage(runtime.inbound('low'));
    await runtime.discover(1048576);
    await runtime.agent.processInboxMessage(runtime.inbound('high'));
    await runtime.discover(131072);
    await runtime.agent.processInboxMessage(runtime.inbound('lower'));
    expect(runtime.calls.map((call) => call.window)).toEqual([98000, 200000, 131072]);
    expect(runtime.agent.configuredMaxContextTokens).toBe(200000);
  });

  it('resolves each actual message model without reusing the previous model discovery', async () => {
    const runtime = await harness({ initialWindow: 1048576 });
    await runtime.agent.processInboxMessage(runtime.inbound('known'));
    await runtime.agent.processInboxMessage(runtime.inbound('unknown', 'Unknown-Model'));
    await runtime.agent.processInboxMessage(runtime.inbound('known-again'));
    expect(runtime.calls.map((call) => call.window)).toEqual([1048576, 128000, 1048576]);
  });

  it('uses the exact fallback provider and re-arms the original primary without leaking either window', async () => {
    const runtime = await harness({ initialWindow: 1048576 });
    const fallback = new VLlmProvider('http://fallback.invalid', undefined, 'fixture', 'cortex');
    catalogs.set('http://fallback.invalid', [{ id: 'Fallback-Model', max_model_len: 98000 }]);
    await fallback.getServedModel('Fallback-Model');
    runtime.attachChat(fallback);
    runtime.attachChat(runtime.provider, true);
    runtime.agent.modelFallbacks = [
      { method: 'shizuha', model: defaultModel, provider: 'primary' },
      { method: 'shizuha', model: 'Fallback-Model', provider: 'secondary' },
    ];
    runtime.agent.providerReg = {
      get: (name: string) => name === 'primary' ? runtime.provider : fallback,
      resolve: () => runtime.provider,
    };
    const compactionChecks = vi.spyOn(context, 'needsCompaction');
    await runtime.agent.processInboxMessage(runtime.inbound('fallback'));
    expect(runtime.agent.pinnedFallbackIndex).toBe(1);
    expect(runtime.agent.model).toBe('Fallback-Model');
    expect(runtime.agent.provider).toBe(fallback);
    expect(runtime.agent.modelMaxTokens()).toBe(98000);
    expect(runtime.agent.maxContextTokens).toBe(98000);
    expect(runtime.agent.contextWindowSource.provider).toBe(fallback);
    expect(compactionChecks.mock.calls.filter((call) => call[2] === 'Fallback-Model').map((call) => call[1])).toEqual([98000]);
    runtime.agent.pinnedFallbackAt = Date.now() - 600000;
    runtime.attachChat(runtime.provider);
    await runtime.agent.processInboxMessage(runtime.inbound('primary-again'));
    expect(runtime.agent.pinnedFallbackIndex).toBe(0);
    expect(runtime.agent.model).toBe(defaultModel);
    expect(runtime.agent.provider).toBe(runtime.provider);
    expect(runtime.agent.modelMaxTokens()).toBe(1048576);
    expect(runtime.agent.maxContextTokens).toBe(1048576);
    expect(runtime.calls.map((call) => call.window)).toEqual([1048576, 98000, 1048576]);
  });
});
