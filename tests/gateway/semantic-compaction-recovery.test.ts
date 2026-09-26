import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentProcess, shouldResetFruitlessHeartbeatSession, gatewayHealthFromRecentErrors } from '../../src/gateway/agent-process.js';
import type { Channel, InboundMessage } from '../../src/gateway/types.js';
import type { Message } from '../../src/agent/types.js';
import type { ChatMessage, ChatOptions, StreamChunk } from '../../src/provider/types.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { StateStore } from '../../src/state/store.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { clearHeartbeatQueueDrainOutcomesForTests, getHeartbeatQueueDrainOutcome, formatHeartbeatQueueDrainOutcomeLogLine, ingestHeartbeatQueueDrainOutcomeLogLine, recordHeartbeatQueueDrainOutcome } from '../../src/shared/heartbeat-outcome.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/platform/pulse-self-availability.js', () => ({ markPulseSelfAvailability: vi.fn(async () => {}) }));

const agents = new Map<any, string>();
const ALERTS = 'mcp__shizuha-pulse__pulse_get_my_alerts';
const TASKS = 'mcp__shizuha-pulse__pulse_get_my_tasks';
// Exact observed output class: a short first response followed by serialized
// blocks whose removal leaves only the seven-character role label. The live
// retry's raw string was not retained, so this is a synthetic causal fixture.
const echoed = '[user]:\n' + JSON.stringify([{ type: 'tool_result', toolUseId: 'receipt-7', content: 'receipt '.repeat(900) }]);
const goodSummary = '<summary>Task ABC-7 requires preserving verified deployment receipts and resuming the pending investigation. '
  + Array.from({ length: 20 }, (_, i) => `Receipt ${i} records a completed read, its result, and the remaining validation for the assigned deployment. `).join('')
  + 'The operator has requested no lifecycle changes. Continue only the pending verification and retain the current instruction.</summary>';

beforeEach(() => {
  clearHeartbeatQueueDrainOutcomesForTests();
  vi.stubEnv('SHIZUHA_PREWARM_ENABLE', '0');
  vi.stubEnv('SHIZUHA_TALK_SUPPRESS_TOOLS', '0');
});
afterEach(async () => {
  for (const [agent, cwd] of agents) { await agent.stop(); rmSync(cwd, { recursive: true, force: true }); }
  agents.clear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearHeartbeatQueueDrainOutcomesForTests();
});

function harness(resumeCwd?: string) {
  const cwd = resumeCwd ?? mkdtempSync(path.join(tmpdir(), 'gateway-semantic-'));
  const agent = new AgentProcess({ channels: [], model: 'GLM-5.3-Flash', cwd, permissionMode: 'autonomous', agentId: path.basename(cwd) }) as any;
  agents.set(agent, cwd);
  const provider = new MockProvider(); provider.name = 'cortex';
  // PLAT-9194 band: the 0.40 floor can require more hierarchical summary
  // passes than a test explicitly queues. A dry queue falls back to the good
  // summary instead of surfacing a bogus COMPACTION_PROVIDER_FAILED — tests
  // that exercise provider failure override chat or use fail() (whose queued
  // responses are consumed BEFORE any fallback).
  const dryFallback = ResponseBuilder.textOnly(goodSummary);
  const baseChat = provider.chat.bind(provider);
  provider.chat = async function* (messages: ChatMessage[], options: ChatOptions) {
    (provider as unknown as { responses: StreamChunk[][]; callIndex: number }).responses.push(dryFallback);
    yield* baseChat(messages, options);
  };
  const registry = new ToolRegistry();
  const calls: string[] = [];
  const toolResults: string[] = [];
  for (const name of [ALERTS, TASKS, 'read_receipt']) registry.register({
    name, description: name, parameters: z.object({}), readOnly: true, riskLevel: 'low',
    async execute() { calls.push(name); return { toolUseId: '', content: toolResults.shift() ?? 'No tasks found.' }; },
  });
  const events: any[] = [];
  const channel: Channel = {
    id: 'test', type: 'connect', start: vi.fn(), stop: vi.fn(),
    sendEvent: async (_threadId, event) => { events.push(event); },
    sendComplete: vi.fn(), ackProcessed: vi.fn(async () => true), sendTelemetry: vi.fn(),
  };
  Object.assign(agent, {
    provider, toolRegistry: registry, toolDefs: registry.definitions(),
    permissions: new PermissionEngine('autonomous'), emitter: new AgentEventEmitter(),
    store: new StateStore(path.join(cwd, 'state.db')),
    maxContextTokens: 32_000, maxOutputTokens: 4096,
    systemPrompt: 'Use the supplied tools for assigned work.',
  });
  agent.bindStoreWirePrefixInvalidation();
  agent.registerChannel(channel); agent.loadEternalSession();
  const append = (m: Message) => { agent.messages.push(m); agent.store.appendMessage(agent.sessionId, m); };
  const seed = () => {
    for (let i = 0; i < 32; i++) append({
      id: `prior-${i}`, role: i % 2 ? 'assistant' : 'user',
      content: i === 0 ? 'Task ABC-7: retain every verified receipt; investigate without lifecycle changes.'
        : `Receipt ${i}: ${'verified deployment evidence '.repeat(260)}`, timestamp: 1000 + i,
    });
    const wire: ChatMessage[] = [{ role: 'system', content: 'Frozen original provider head.' }, { role: 'user', content: 'Frozen receipt prefix.' }];
    agent.captureProviderWirePayload(wire, agent.messages.length);
  };
  const inbound = (id = 'pending-7', source: InboundMessage['source'] = 'heartbeat'): InboundMessage => ({
    id, channelId: channel.id, channelType: channel.type, threadId: id, userId: 'system',
    content: 'Continue ABC-7 and keep its verified deployment receipt.', source, timestamp: 2000,
  });
  const history = () => agent.store.loadSession(agent.sessionId)!.messages as Message[];
  return { agent, provider, channel, events, calls, toolResults, append, seed, inbound, history, cwd };
}
function fail(h: ReturnType<typeof harness>) { h.provider.queueResponse(ResponseBuilder.textOnly('OK'), ResponseBuilder.textOnly(echoed)); }
function succeed(h: ReturnType<typeof harness>) {
  // PLAT-9194 band: the seeded history needs TWO hierarchical passes to reach
  // the 0.40 floor — queue both summaries, then the post-compaction turn.
  h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary),
    ResponseBuilder.textOnly(goodSummary),
    ResponseBuilder.withToolCalls('', [{ id: 'alerts', name: ALERTS, input: {} }]),
    ResponseBuilder.withToolCalls('', [{ id: 'tasks', name: TASKS, input: {} }]),
    ResponseBuilder.textOnly('The queue is empty.'));
}

// PLAT-9194: a failed attempt can leave its queued failure responses
// unconsumed (the tighter-budget quality retry does not fire on every path).
// A subsequent valid retry must not eat them as summaries — drop anything the
// failed attempt did not consume, without touching callIndex/capture state.
function drainUnconsumed(h: ReturnType<typeof harness>) {
  const p = h.provider as unknown as { responses: unknown[]; callIndex: number };
  p.responses.length = Math.min(p.responses.length, p.callIndex);
}

describe('gateway semantic compaction transaction', () => {
  it('uses a validated semantic checkpoint for authored changes even when the tiny history cannot shrink', async () => {
    const h = harness();
    h.append({ id: 'tiny-prior', role: 'user', content: 'Investigate ABC-7 without lifecycle changes.', timestamp: 1000 });
    h.append({ id: 'tiny-answer', role: 'assistant', content: 'The receipt is preserved.', timestamp: 1001 });
    const freshPrompt = '## Custom Instructions\n\nSend concise replies through message_user.';
    h.agent.pendingPromptRefresh = { systemPrompt: freshPrompt, toolDefs: h.agent.toolDefs };
    h.agent.pendingAuthoredInstructionsRefresh = true;
    h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary), ResponseBuilder.textOnly('Delivered.'));
    await h.agent.processInboxMessage({ ...h.inbound('tiny-latest'), source: undefined });
    expect(h.provider.capturedOptions.map((options) => options.requestKind)).toEqual(['compaction', undefined]);
    expect(h.agent.systemPrompt).toBe(freshPrompt);
    expect(h.agent.pendingAuthoredInstructionsRefresh).toBe(false);
    expect(h.history().some((message) => message.id === 'tiny-latest')).toBe(true);
    expect(h.channel.ackProcessed).toHaveBeenCalledWith('tiny-latest');
  });

  it('adopts changed authored instructions before a low-context user turn and stays stable on the next turn', async () => {
    const h = harness(); h.seed();
    h.agent.maxContextTokens = 1_000_000;
    h.provider.maxContextWindow = 1_000_000;
    const oldPrompt = '## Custom Instructions\n\nOld delivery contract';
    const freshPrompt = '## Custom Instructions\n\nDeliver the answer through message_user';
    h.agent.systemPrompt = oldPrompt;
    h.agent.pendingPromptRefresh = { systemPrompt: freshPrompt, toolDefs: h.agent.toolDefs };
    h.agent.pendingAuthoredInstructionsRefresh = true;
    const prewarm = vi.spyOn(h.agent, 'prewarmPrefixCache').mockResolvedValue(true);
    h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary), ResponseBuilder.textOnly('First answer'));
    await h.agent.processInboxMessage({ ...h.inbound('authored-first'), source: undefined });
    expect(h.provider.capturedOptions.map((options) => options.requestKind)).toEqual(['compaction', undefined]);
    expect(h.provider.capturedOptions[1]?.systemPrompt).toBe(freshPrompt);
    expect(h.agent.systemPrompt).toBe(freshPrompt);
    expect(h.agent.pendingAuthoredInstructionsRefresh).toBe(false);
    expect(h.agent.pendingPromptRefresh).toBeNull();
    expect(h.agent.store.loadProviderPrefixHead(h.agent.sessionId)?.systemPrompt).toBe(freshPrompt);
    expect(prewarm).toHaveBeenCalledWith(expect.anything(), expect.anything(), { reason: 'post_compaction' });
    expect(h.history().some((message) => message.id === 'authored-first')).toBe(true);
    drainUnconsumed(h);
    h.provider.queueResponse(ResponseBuilder.textOnly('Second answer'));
    await h.agent.processInboxMessage({ ...h.inbound('authored-second'), source: undefined });
    expect(h.provider.capturedOptions.filter((options) => options.requestKind === 'compaction')).toHaveLength(1);
    expect(h.provider.capturedOptions.at(-1)?.systemPrompt).toBe(freshPrompt);
  });

  it.each(['provider', 'quality', 'persistence'])('retains authored refresh and old head after %s failure, then applies it on retry', async (failure) => {
    const h = harness(); h.seed();
    const oldPrompt = h.agent.systemPrompt;
    const freshPrompt = '## Custom Instructions\n\nUpdated delivery contract';
    h.agent.pendingPromptRefresh = { systemPrompt: freshPrompt, toolDefs: h.agent.toolDefs };
    h.agent.pendingAuthoredInstructionsRefresh = true;
    const before = h.history();
    const originalChat = h.provider.chat.bind(h.provider);
    if (failure === 'provider') {
      h.provider.chat = async function* () { throw new Error('provider unavailable'); };
    } else if (failure === 'quality') {
      fail(h);
    } else {
      h.agent.store.db.exec("CREATE TRIGGER reject_custom_compaction BEFORE INSERT ON messages WHEN new.content LIKE '[Conversation Summary]%' BEGIN SELECT RAISE(ABORT, 'fixture persistence denied'); END");
      h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary));
    }
    await h.agent.processInboxMessage(h.inbound('authored-retry'));
    expect(h.agent.systemPrompt).toBe(oldPrompt);
    expect(h.agent.pendingPromptRefresh?.systemPrompt).toBe(freshPrompt);
    expect(h.agent.pendingAuthoredInstructionsRefresh).toBe(true);
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
    h.provider.chat = originalChat;
    if (failure === 'persistence') h.agent.store.db.exec('DROP TRIGGER reject_custom_compaction');
    drainUnconsumed(h);
    succeed(h);
    await h.agent.processInboxMessage(h.inbound('authored-retry'));
    expect(h.agent.systemPrompt).toBe(freshPrompt);
    expect(h.agent.pendingAuthoredInstructionsRefresh).toBe(false);
    expect(h.history().filter((message) => message.id === 'authored-retry')).toHaveLength(1);
  });

  it('preserves the exact active and canonical transcript, frozen prefix and unacknowledged input on quality failure', async () => {
    const h = harness(); h.seed(); fail(h);
    const before = h.history(); const wire = structuredClone(h.agent.providerWirePrefix);
    const replace = vi.spyOn(h.agent.store, 'replaceMessages');
    await h.agent.processInboxMessage(h.inbound());
    expect(h.provider.callCount).toBe(2);
    expect(h.provider.capturedOptions.map((o) => [o.requestKind, o.sessionId, o.maxTokens])).toEqual([
      ['compaction', h.agent.sessionId, 2048], ['compaction', h.agent.sessionId, 1024],
    ]);
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.history()).toHaveLength(before.length + 1);
    expect(h.agent.messages).toEqual(h.history());
    expect(h.agent.store.loadTranscriptMessages(h.agent.sessionId)).toEqual(h.history());
    expect(replace).not.toHaveBeenCalled();
    expect(h.agent.providerWirePrefix).toEqual(wire);
    expect(h.agent.store.loadWirePrefix(h.agent.sessionId)?.sourceCount).toBe(wire.sourceCount);
    expect(h.calls).toEqual([]);
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
    expect(h.channel.sendComplete).not.toHaveBeenCalled();
    expect(h.agent.store.inboundProcessingCompleted(h.agent.sessionId, h.inbound().id)).toBe(false);
    expect(h.events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ code: 'COMPACTION_QUALITY_FAILED', recoverable: true, terminal: false })]);
    expect(h.events.some((e) => e.type === 'complete')).toBe(false);
    expect(h.agent.buildTelemetry().health).toMatchObject({ ok: false, provider_unavailable: false });
    expect(h.agent.buildTelemetry().heartbeat).toMatchObject({ outcome: 'needs_help', needs_help: true, incomplete_reason: 'semantic_compaction_failed' });
    const outcome = getHeartbeatQueueDrainOutcome(path.basename(h.cwd));
    expect(outcome).toMatchObject({ outcome: 'needs_help', incompleteReason: 'semantic_compaction_failed' });
    expect(shouldResetFruitlessHeartbeatSession({ ...outcome, consecutiveReadyNoProgressHeartbeats: 100 })).toBe(false);
    const log = formatHeartbeatQueueDrainOutcomeLogLine(outcome!);
    clearHeartbeatQueueDrainOutcomesForTests();
    const ingested = ingestHeartbeatQueueDrainOutcomeLogLine(log);
    expect(ingested).toEqual(outcome);
    expect(shouldResetFruitlessHeartbeatSession({ ...ingested, readyTaskCount: 5, consecutiveReadyNoProgressHeartbeats: 100 })).toBe(false);
    expect(JSON.stringify(h.history())).not.toMatch(/Summary unavailable|full context|\[Conversation Summary\]/);
  });

  it('does not commit a valid first hierarchical pass when the next pass fails quality', async () => {
    const h = harness(); h.seed(); h.agent.maxContextTokens = 12_000;
    h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary)); fail(h);
    const before = h.history(); const wire = structuredClone(h.agent.providerWirePrefix);
    const replace = vi.spyOn(h.agent.store, 'replaceMessages');
    await h.agent.processInboxMessage(h.inbound());
    expect(h.provider.callCount).toBe(3);
    expect(String(h.provider.capturedMessages[1]?.[0]?.content)).toContain('Receipt 19 records');
    expect(replace).not.toHaveBeenCalled();
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.history()).toHaveLength(before.length + 1);
    expect(h.agent.messages).toEqual(h.history());
    expect(h.agent.store.loadTranscriptMessages(h.agent.sessionId)).toEqual(h.history());
    expect(h.agent.providerWirePrefix).toEqual(wire);
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'network', message: 'Cannot connect to Cortex: ECONNREFUSED', code: 'ECONNREFUSED', status: undefined },
    { label: 'authentication', message: 'Cortex HTTP 401 Unauthorized: expired signature', code: 'AUTHENTICATION_FAILED', status: 401 },
  ])('retains the real $label error at the first provider boundary', async ({ message, code, status }) => {
    const h = harness(); h.seed();
    const cause = Object.assign(new Error(message), { code, status });
    h.provider.chat = async function* (): AsyncGenerator<StreamChunk> { throw cause; };
    const before = h.history(); const wire = structuredClone(h.agent.providerWirePrefix);
    await h.agent.processInboxMessage(h.inbound());
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.history()).toHaveLength(before.length + 1);
    expect(h.agent.messages).toEqual(h.history());
    expect(h.agent.providerWirePrefix).toEqual(wire);
    expect(h.agent.recentErrors).toEqual([message]);
    expect(h.agent.buildTelemetry().health).toMatchObject({
      ...gatewayHealthFromRecentErrors([message]),
      compaction_failure: { category: 'provider', code: 'COMPACTION_PROVIDER_FAILED', cause_code: code, ...(status ? { status } : {}) },
    });
    expect(getHeartbeatQueueDrainOutcome(path.basename(h.cwd))).toBeUndefined();
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
    expect(h.events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({
      code: 'COMPACTION_PROVIDER_FAILED', category: 'provider', cause_code: code, error: message, terminal: false,
    })]);
  });

  it('does not reclassify retry HTTP401 as quality failure after a short first summary', async () => {
    const h = harness(); h.seed();
    h.provider.queueResponse(ResponseBuilder.textOnly('OK'));
    const original = h.provider.chat.bind(h.provider); let attempts = 0;
    h.provider.chat = async function* (messages: ChatMessage[], options: ChatOptions) {
      if (++attempts === 2) throw Object.assign(new Error('Cortex HTTP 401 Unauthorized'), { status: 401, code: 'AUTHENTICATION_FAILED' });
      yield* original(messages, options);
    };
    const before = h.history();
    await h.agent.processInboxMessage(h.inbound());
    expect(attempts).toBe(2);
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.history()).toHaveLength(before.length + 1);
    expect(h.agent.buildTelemetry().health.compaction_failure).toEqual({ category: 'provider', code: 'COMPACTION_PROVIDER_FAILED', cause_code: 'AUTHENTICATION_FAILED', status: 401 });
    expect(h.agent.recentErrors).toEqual(['Cortex HTTP 401 Unauthorized']);
    expect(getHeartbeatQueueDrainOutcome(path.basename(h.cwd))).toBeUndefined();
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
  });

  it('rolls back SQLite and both wire prefixes on failure, then invalidates once on successful retry after reopen', async () => {
    const h = harness(); h.seed();
    h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary));
    h.agent.store.db.exec("CREATE TRIGGER reject_compaction_insert BEFORE INSERT ON messages WHEN new.content LIKE '[Conversation Summary]%' BEGIN SELECT RAISE(ABORT, 'fixture persistence denied'); END");
    const before = h.history();
    const wire = structuredClone(h.agent.providerWirePrefix);
    const persistedWire = h.agent.store.loadWirePrefix(h.agent.sessionId);
    await h.agent.processInboxMessage(h.inbound());
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.history()).toHaveLength(before.length + 1);
    expect(h.agent.messages).toEqual(h.history());
    expect(h.agent.store.loadTranscriptMessages(h.agent.sessionId)).toEqual(h.history());
    expect(h.agent.providerWirePrefix).toEqual(wire);
    expect(h.agent.store.loadWirePrefix(h.agent.sessionId)).toEqual(persistedWire);
    expect(h.agent.buildTelemetry().health.compaction_failure).toMatchObject({ category: 'persistence', code: 'COMPACTION_PERSISTENCE_FAILED' });
    expect(getHeartbeatQueueDrainOutcome(path.basename(h.cwd))).toBeUndefined();
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
    const preserved = h.history();
    await h.agent.stop(); agents.delete(h.agent);
    const next = harness(h.cwd);
    expect(next.history()).toEqual(preserved);
    expect(next.agent.providerWirePrefix).toEqual(wire);
    expect(next.agent.store.loadWirePrefix(next.agent.sessionId)).toEqual(persistedWire);
    next.agent.store.db.exec('DROP TRIGGER reject_compaction_insert');
    const clear = vi.spyOn(next.agent.store, 'clearWirePrefix');
    let currentWire = next.agent.providerWirePrefix; let invalidations = 0;
    Object.defineProperty(next.agent, 'providerWirePrefix', {
      configurable: true, get: () => currentWire,
      set: (value) => { if (value === null) invalidations++; currentWire = value; },
    });
    succeed(next); await next.agent.processInboxMessage(next.inbound());
    expect(next.agent.recentErrors).toEqual([]);
    expect(clear).toHaveBeenCalledOnce();
    expect(invalidations).toBe(1);
    expect(next.agent.providerWirePrefix).not.toEqual(wire);
    expect(next.agent.buildTelemetry().health.compaction_failure).toBeUndefined();
    expect(next.channel.ackProcessed).toHaveBeenCalledOnce();
    for (const message of preserved) expect(next.agent.store.loadTranscriptMessages(next.agent.sessionId)).toContainEqual(message);
  });

  it('classifies an invalid transcript projection separately from model summary quality', async () => {
    const h = harness(); h.seed();
    h.append({ role: 'assistant', content: '', timestamp: 1500 });
    h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary));
    const before = h.history();
    await h.agent.processInboxMessage(h.inbound());
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.history()).toHaveLength(before.length + 1);
    expect(h.agent.buildTelemetry().health.compaction_failure).toMatchObject({ category: 'validation', code: 'COMPACTION_VALIDATION_FAILED' });
    expect(getHeartbeatQueueDrainOutcome(path.basename(h.cwd))).toBeUndefined();
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
  });

  it('classifies an impossible prefix capacity separately without requesting a summary', async () => {
    const h = harness(); h.agent.maxContextTokens = 1500;
    h.append({ role: 'user', content: 'Oldest receipt: ' + 'evidence '.repeat(10_000), timestamp: 1000 });
    const before = h.history();
    await h.agent.processInboxMessage(h.inbound());
    expect(h.provider.callCount).toBe(0);
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.history()).toHaveLength(before.length + 1);
    expect(h.agent.buildTelemetry().health.compaction_failure).toMatchObject({ category: 'capacity', code: 'COMPACTION_CAPACITY_FAILED' });
    expect(getHeartbeatQueueDrainOutcome(path.basename(h.cwd))).toBeUndefined();
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
  });

  it('keeps the preserved transcript through the actual next-heartbeat reset gate before a valid retry', async () => {
    const h = harness(); h.seed();
    for (let i = 0; i < 2; i++) recordHeartbeatQueueDrainOutcome(path.basename(h.cwd), { readyTaskCount: 5 });
    fail(h); await h.agent.processInboxMessage(h.inbound());
    const outcome = getHeartbeatQueueDrainOutcome(path.basename(h.cwd))!;
    expect(shouldResetFruitlessHeartbeatSession({ ...outcome, incompleteReason: undefined })).toBe(true);
    const preserved = h.history(); const wire = structuredClone(h.agent.providerWirePrefix);
    const generation = h.agent.sessionGeneration;
    const replace = vi.spyOn(h.agent.store, 'replaceMessages');
    vi.useFakeTimers();
    Object.assign(h.agent, { running: true, firstHeartbeatPending: false, nextHeartbeatDueAt: 0, lastActivityAt: 0 });
    h.agent.hasReadyPulseWorkForIdleHeartbeat = vi.fn().mockResolvedValue({ ready: true });
    h.agent.startIdleHeartbeat();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.agent.inbox.depth).toBe(1);
    expect(replace).not.toHaveBeenCalled();
    expect(h.agent.sessionGeneration).toBe(generation);
    expect(h.history()).toEqual(preserved);
    expect(h.agent.providerWirePrefix).toEqual(wire);
    clearInterval(h.agent.idleHeartbeatTimer); h.agent.idleHeartbeatTimer = null;
    vi.useRealTimers();
    const next = await h.agent.inbox.next();
    drainUnconsumed(h);
    succeed(h); await h.agent.processInboxMessage(next);
    expect(h.calls).toEqual([ALERTS, TASKS]);
    expect(replace).toHaveBeenCalledOnce(); // only the validated provider-backed rewrite
    expect(getHeartbeatQueueDrainOutcome(path.basename(h.cwd))?.incompleteReason).toBeUndefined();
    expect(h.agent.store.inboundProcessingCompleted(h.agent.sessionId, h.inbound().id)).toBe(false);
    const archive = h.agent.store.loadTranscriptMessages(h.agent.sessionId);
    for (const message of preserved) expect(archive).toContainEqual(message);
  });

  it('reopens SQLite and retries the same pending input without duplicate user rows or omitted history', async () => {
    const first = harness(); first.seed(); fail(first);
    await first.agent.processInboxMessage(first.inbound());
    const preserved = first.history(); const wire = structuredClone(first.agent.providerWirePrefix);
    await first.agent.stop(); agents.delete(first.agent);
    const next = harness(first.cwd);
    expect(next.history()).toEqual(preserved);
    expect(next.agent.providerWirePrefix).toEqual(wire);
    succeed(next);
    await next.agent.processInboxMessage(next.inbound());
    expect(next.agent.recentErrors).toEqual([]);
    expect(next.provider.capturedOptions[0]?.requestKind).toBe('compaction');
    expect(next.provider.capturedMessages[0]).toEqual(first.provider.capturedMessages[0]);
    expect(next.calls).toEqual([ALERTS, TASKS]);
    expect(next.channel.ackProcessed).toHaveBeenCalledOnce();
    expect(next.agent.store.inboundProcessingCompleted(next.agent.sessionId, next.inbound().id)).toBe(true);
    expect(next.history().filter((m) => m.id === next.inbound().id)).toHaveLength(1);
    expect(next.history()[0]?.content).toContain('[Conversation Summary]');
    expect(next.history().some((m) => String(m.content).includes('validated summary'))).toBe(true);
    const archive = next.agent.store.loadTranscriptMessages(next.agent.sessionId);
    for (const message of preserved) expect(archive).toContainEqual(message);
    expect(archive.filter((m: Message) => m.id === next.inbound().id)).toHaveLength(1);
    expect(getHeartbeatQueueDrainOutcome(path.basename(next.cwd))?.incompleteReason).toBeUndefined();
  });

  it.each([false, true])('rejects a late valid summary after an appended input (generation changed=%s)', async (changeGeneration) => {
    const h = harness(); h.seed();
    const late: Message = { id: 'new-arrival', role: 'user', content: 'New instruction: preserve the pending receipt and wait for approval.', timestamp: 3000 };
    h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary));
    const originalChat = h.provider.chat.bind(h.provider);
    h.provider.chat = async function* (messages: ChatMessage[], options: ChatOptions) {
      h.append(late); if (changeGeneration) h.agent.sessionGeneration++;
      yield* originalChat(messages, options);
    };
    const before = h.history(); const wire = structuredClone(h.agent.providerWirePrefix);
    await h.agent.processInboxMessage(h.inbound());
    expect(h.provider.callCount).toBe(1);
    expect(h.history().slice(0, before.length)).toEqual(before);
    expect(h.history().at(-1)).toEqual(late);
    expect(h.history()).toHaveLength(before.length + 2);
    expect(h.agent.messages).toEqual(h.history());
    expect(h.agent.providerWirePrefix).toEqual(wire);
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
    expect(h.agent.recentErrors).toEqual([]);
  });

  it('discards old-generation maintenance through the real outer inbox loop before serving the queued successor', async () => {
    vi.stubEnv('SHIZUHA_IDLE_HEARTBEAT_DISABLED', '1');
    const h = harness(); h.seed();
    h.provider.queueResponse(ResponseBuilder.textOnly(goodSummary), ResponseBuilder.textOnly(goodSummary),
      ResponseBuilder.textOnly('Receipt ABC-7 confirms build42 passed verification.'));
    const original = h.provider.chat.bind(h.provider);
    let release!: () => void; let entered!: () => void; let first = true;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    h.provider.chat = async function* (messages: ChatMessage[], options: ChatOptions) {
      if (first) { first = false; entered(); await wait; }
      yield* original(messages, options);
    };
    const sentHook = vi.fn(async () => {});
    h.agent.hookEngine = { hasHooks: (name: string) => name === 'MessageSent', runHooks: sentHook };
    h.channel.sendComplete = vi.fn((threadId) => { if (threadId === 'successor') h.agent.running = false; });
    h.agent.inbox.push(h.inbound('old-generation', 'user'));
    const loop = h.agent.start();
    await ready;
    h.agent.sessionGeneration++;
    h.agent.inbox.push(h.inbound('successor', 'user'));
    vi.mocked(h.channel.sendTelemetry!).mockClear();
    release(); await loop;
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
    expect(h.agent.recentErrors).toEqual([]);
    expect(h.channel.ackProcessed).toHaveBeenCalledExactlyOnceWith('successor');
    expect(h.channel.sendComplete).toHaveBeenCalledExactlyOnceWith('successor');
    expect(sentHook).toHaveBeenCalledOnce();
    expect(h.agent.store.inboundProcessingCompleted(h.agent.sessionId, 'old-generation')).toBe(false);
    expect(h.agent.store.inboundProcessingCompleted(h.agent.sessionId, 'successor')).toBe(true);
    for (const [telemetry] of vi.mocked(h.channel.sendTelemetry!).mock.calls) {
      expect((telemetry as any).health.recent_errors).toEqual([]);
      expect((telemetry as any).health.compaction_failure).toBeUndefined();
    }
    expect(h.agent.store.loadTranscriptMessages(h.agent.sessionId).filter((m: Message) => m.id === 'old-generation')).toHaveLength(1);
  });

  it('propagates stop abort into maintenance and preserves SQLite even if the provider returns late', async () => {
    const h = harness(); h.seed();
    let release!: () => void; let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    const wait = new Promise<void>((r) => { release = r; });
    let signal: AbortSignal | undefined;
    h.provider.chat = async function* (_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
      signal = options.abortSignal; started(); await wait;
      yield* ResponseBuilder.textOnly(goodSummary);
    };
    const pending = h.agent.processInboxMessage(h.inbound());
    await ready;
    const preserved = h.history();
    await h.agent.stop(); agents.delete(h.agent);
    const aborted = signal?.aborted;
    release(); await pending;
    expect(aborted).toBe(true);
    const next = harness(h.cwd);
    expect(next.history()).toEqual(preserved);
    expect(next.agent.store.loadTranscriptMessages(next.agent.sessionId)).toEqual(preserved);
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
    expect(h.channel.sendComplete).not.toHaveBeenCalled();
    expect(h.events.filter((e) => e.type === 'error')).toEqual([]);
    expect(h.agent.recentErrors).toEqual([]);
  });

  it('retains real tool receipts when post-turn compaction fails and never acknowledges the incomplete input', async () => {
    const h = harness();
    h.append({ id: 'initial', role: 'user', content: 'Read the deployment receipt before deciding the next action.', timestamp: 1000 });
    h.toolResults.push('durable-receipt-42 ' + 'verified evidence '.repeat(1000));
    h.provider.queueResponse(ResponseBuilder.withToolCalls('', [{ id: 'read-42', name: 'read_receipt', input: {} }], { input: 30_000, output: 100 }));
    fail(h);
    await h.agent.processInboxMessage(h.inbound('pending-tool', 'user'));
    expect(h.calls).toEqual(['read_receipt']);
    expect(h.provider.callCount).toBe(3);
    expect(h.provider.capturedOptions.map((o) => o.requestKind)).toEqual([undefined, 'compaction', 'compaction']);
    expect(JSON.stringify(h.history())).toContain('durable-receipt-42');
    expect(h.agent.messages).toEqual(h.history());
    expect(h.agent.store.loadTranscriptMessages(h.agent.sessionId)).toEqual(h.history());
    expect(h.channel.ackProcessed).not.toHaveBeenCalled();
    expect(h.events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ code: 'COMPACTION_QUALITY_FAILED' })]);
  });
});
