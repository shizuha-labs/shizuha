import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentProcess, classifyRecoveryFeed } from '../../src/gateway/agent-process.js';
import { Inbox } from '../../src/gateway/inbox.js';
import { ExpensiveTurnGuard } from '../../src/agent/expensive-turn-guard.js';
import { StateStore } from '../../src/state/store.js';
import { estimatePromptTokenBudget } from '../../src/agent/heartbeat-hygiene.js';
import { recordHeartbeatQueueDrainTurn } from '../../src/daemon/heartbeat-outcome.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PermissionEngine } from '../../src/permissions/engine.js';
import { AgentEventEmitter } from '../../src/events/emitter.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';
import type { Message } from '../../src/agent/types.js';
import type { Channel, InboundMessage } from '../../src/gateway/types.js';
import type { ChatMessage, ChatOptions, StreamChunk } from '../../src/provider/types.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

class TimeoutCompactionProvider {
  name = 'timeout-compaction';
  supportsTools = true;
  maxContextWindow = 262_144;
  calls = 0;

  async *chat(_messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    this.calls += 1;
    await new Promise<void>((resolve, reject) => {
      if (options.abortSignal?.aborted) {
        reject(options.abortSignal.reason);
        return;
      }
      options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true });
    });
    if (false) yield { type: 'done' };
  }
}

function channel(id = 'ch-1'): Channel {
  return {
    id,
    type: 'http',
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendEvent: vi.fn(async () => {}),
    sendComplete: vi.fn(),
    onMessage: vi.fn(),
  } as unknown as Channel;
}

function inbound(id: string, source: InboundMessage['source'], content: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id,
    channelId: 'ch-1',
    channelType: 'http',
    threadId: `thread-${id}`,
    userId: source === 'user' ? 'human-1' : 'system',
    userName: source === 'user' ? 'Hritik' : 'system',
    content,
    timestamp: Date.now(),
    source,
    ...overrides,
  };
}

function bloatedMessages(count = 185): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `old-generation-${index} ${'x'.repeat(1400)}`,
    timestamp: Date.now() + index,
  }));
}

function compactionProvider(): MockProvider {
  const provider = new MockProvider();
  provider.queueResponse(ResponseBuilder.textOnly(
    Array.from({ length: 240 }, (_, index) => `preserved-summary-${index}`).join(' '),
    { input: 90_000, output: 480 },
  ));
  return provider;
}

describe('SCLI-347 fenced-generation expensive-turn recovery', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli347-'));
    store = new StateStore(path.join(dir, 'state.db'));
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function wiredAgent(sessionId: string, provider: TimeoutCompactionProvider | MockProvider): any {
    const agent = new AgentProcess({
      channels: [],
      model: 'cortex/DeepSeek-V4-Flash',
      cwd: dir,
      permissionMode: 'autonomous',
      agentId: 'jun-s347',
      agentName: 'jun-s347',
    }) as any;
    agent.store = store;
    agent.sessionId = sessionId;
    agent.messages = [...(store.loadSession(sessionId)?.messages ?? [])];
    agent.systemPrompt = 'You are a test agent.';
    agent.toolDefs = [];
    agent.maxContextTokens = 32_000;
    agent.provider = provider;
    agent.providerReg = {
      resolve: () => provider,
      resolveWithModel: () => ({ provider, model: agent.model }),
      get: () => provider,
    };
    agent.modelFallbacks = [];
    agent.pinnedFallbackIndex = 0;
    agent.inbox = new Inbox();
    agent.channels = new Map([['ch-1', channel()]]);
    agent.expensiveTurnGuard = new ExpensiveTurnGuard({
      enabled: true,
      windowMs: 60_000,
      minTurns: 2,
      minPromptTokens: 1_000,
      minPromptOutputRatio: 10,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      notifyCooldownMs: 60_000,
    });
    agent.notifyExpensiveTurnGuard = vi.fn(async () => {});
    agent.notifyExpensiveTurnRecoveryOutcome = vi.fn(async () => {});
    agent.running = true;
    return agent;
  }

  it('compacts through the provider, rotates the head, then verifies Pulse progress before replay', async () => {
    const sessionId = 'agent-session-jun-s347';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    for (const message of bloatedMessages(60)) store.appendMessage(sessionId, message);
    const provider = compactionProvider();
    const agent = wiredAgent(sessionId, provider);

    agent.inbox.push(inbound('hb-1', 'heartbeat', '[HEARTBEAT] sync'));
    agent.inbox.push(inbound('hb-2', 'heartbeat', '[HEARTBEAT] sync'));
    agent.inbox.push(inbound('human-1', 'user', 'Please preserve this message.', {
      channelType: 'connect',
      userId: 'hritik',
    }));

    const now = Date.now();
    const decision = await agent.runExpensiveTurnGuardProductionSequence([
      { now, inputTokens: 900_000, outputTokens: 10, toolCallCount: 0, source: 'heartbeat' },
      { now: now + 100, inputTokens: 900_000, outputTokens: 10, toolCallCount: 0, source: 'heartbeat' },
    ], agent.model);
    expect(decision.action).toBe('pause');
    expect(provider.callCount).toBe(1);

    const recovery = store.loadExpensiveTurnRecovery(sessionId)!;
    expect(recovery.state).toBe('recovery_pending');
    expect(recovery.fencedGeneration).toBe(0);
    expect(recovery.targetGeneration).toBe(1);
    expect(recovery.compactionOutcome).toBe('semantic_compaction_succeeded');
    expect(recovery.counters).toMatchObject({ preserved: 2, coalesced: 1, dropped: 0, deferred: 2, replayed: 0 });

    const rotated = store.loadSession(sessionId)!.messages;
    expect(rotated.length).toBeGreaterThan(2);
    expect(String(rotated[0]!.content)).toContain('[System Recovery Capsule]');
    expect(rotated.some((message) => String(message.content).includes('[Conversation Summary]'))).toBe(true);
    expect(rotated.some((message) => String(message.content).includes('old-generation-59'))).toBe(true);
    const budget = estimatePromptTokenBudget({
      messages: rotated,
      systemPrompt: agent.systemPrompt,
      toolDefs: [],
      model: agent.model,
    });
    expect(budget.promptTokenEstimate).toBeLessThanOrEqual(16_000);

    const bootstrap = agent.inbox.queued()[0]!;
    expect(bootstrap.metadata?.['expensiveTurnRecoveryEpisodeId']).toBe(recovery.episodeId);
    agent.executeTurns = vi.fn(async () => {
      recordHeartbeatQueueDrainTurn('jun-s347', {
        toolCalls: [
          { name: 'mcp__shizuha_pulse__pulse_get_my_alerts', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_get_my_tasks', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_add_comment', input: { task_id: 'SCLI-347' } },
        ],
        toolResults: [
          { content: 'No active assigned alerts.', isError: false },
          { content: 'Found 1 task(s) — 1 actionable\n- SCLI-347', isError: false },
          { content: 'Comment added', isError: false },
        ],
      });
    });
    // SCLI-415: replay is now paced from the LIVE guard thresholds. This
    // harness injects minTurns=2/windowMs=60s, which correctly derives a
    // full-window gap between rows (with minTurns=2 any two replay turns in a
    // window would trip the guard). That is right in production but longer
    // than this test's budget, and pacing is not what this test covers — it is
    // covered by scli415-replay-pacing.test.ts. Shrink the window so the
    // derived spacing is milliseconds; the guard has already tripped above, so
    // this only affects release pacing.
    agent.expensiveTurnGuard = new ExpensiveTurnGuard({
      enabled: true,
      windowMs: 10,
      minTurns: 2,
      minPromptTokens: 1_000,
      minPromptOutputRatio: 10,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      notifyCooldownMs: 60_000,
    });
    await agent.processInboxMessage(await agent.inbox.next());

    const verified = store.loadExpensiveTurnRecovery(sessionId)!;
    expect(verified.state).toBe('verified');
    expect(verified.lastOutcome).toBe('worked_task');
    expect(verified.counters.replayed).toBe(0);
    // SCLI-415: exactly ONE row is handed over per release. Asserting both rows
    // here previously encoded the bulk-release defect: marking the whole FIFO
    // `releasing` and pushing it at once is what let a verified episode place
    // >= minTurns high-prompt turns in one guard window and re-trip SCLI-195.
    // `human-1` is released only after `hb-1` is durably acknowledged, so the
    // next `inbox.next()` below blocks until the pump hands it over.
    expect(agent.inbox.queued().map((message: InboundMessage) => message.id)).toEqual(['hb-1']);
    agent.executeTurns = vi.fn(async () => {});
    await agent.processInboxMessage(await agent.inbox.next());
    await agent.processInboxMessage(await agent.inbox.next());
    // Both rows still replay, in order — the end state is unchanged by pacing.
    expect(store.loadExpensiveTurnRecovery(sessionId)!.counters.replayed).toBe(2);
    expect(store.loadSession(sessionId)!.messages.some((message) => String(message.content).includes('[Conversation Summary]'))).toBe(true);
  }, 10_000);

  it('coalesces only typed duplicate heartbeats and never prose-matches human messages', () => {
    const feed = classifyRecoveryFeed([
      inbound('h1', 'user', '[HEARTBEAT] this is human-authored prose'),
      inbound('s1', 'heartbeat', 'same'),
      inbound('s2', 'heartbeat', 'same'),
      inbound('a1', 'inter-agent', 'action', { channelType: 'connect' }),
    ]);
    expect(feed.deferred.map((entry) => entry.message.id)).toEqual(['h1', 's1', 'a1']);
    expect(feed.unresolvedHumanMessageIds).toEqual(['h1', 'a1']);
    expect(feed.counters.coalesced).toBe(1);
    expect(feed.counters.dropped).toBe(0);
  });

  it('atomically preserves feed drained by a second guard while recovery is pending', async () => {
    const sessionId = 'agent-session-reentry-feed';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    for (const message of bloatedMessages(60)) store.appendMessage(sessionId, message);
    const provider = compactionProvider();
    const agent = wiredAgent(sessionId, provider);
    const firstNow = Date.now();

    const firstDecision = await agent.runExpensiveTurnGuardProductionSequence([
      { now: firstNow, inputTokens: 900_000, outputTokens: 10, toolCallCount: 0, source: 'heartbeat' },
      { now: firstNow + 100, inputTokens: 900_000, outputTokens: 10, toolCallCount: 0, source: 'heartbeat' },
    ], agent.model);
    expect(firstDecision.action).toBe('pause');
    const firstEpisode = store.loadExpensiveTurnRecovery(sessionId)!;
    expect(firstEpisode.state).toBe('recovery_pending');
    agent.inbox.drain(); // recovery heartbeat is now admitted and running

    const queuedHuman = inbound('human-during-recovery', 'user', 'Do not lose this re-entry message.', {
      channelType: 'connect',
      userId: 'hritik',
    });
    agent.inbox.push(queuedHuman);
    agent.expensiveTurnGuard.reset();
    const secondNow = firstNow + 10_000;
    const secondDecision = await agent.runExpensiveTurnGuardProductionSequence([
      { now: secondNow, inputTokens: 910_000, outputTokens: 10, toolCallCount: 0, source: 'heartbeat' },
      { now: secondNow + 100, inputTokens: 910_000, outputTokens: 10, toolCallCount: 0, source: 'heartbeat' },
    ], agent.model);

    expect(secondDecision.action).toBe('pause');
    const authoritative = store.loadExpensiveTurnRecovery(sessionId)!;
    expect(authoritative.episodeId).toBe(firstEpisode.episodeId);
    expect(authoritative.activeGeneration).toBe(firstEpisode.activeGeneration);
    expect(store.listDeferredRecoveryMessages(sessionId, authoritative.episodeId)
      .map((item) => item.messageId)).toContain(queuedHuman.id);
    expect(authoritative.counters).toMatchObject({ preserved: 1, deferred: 1 });
    expect(provider.callCount).toBe(1);
  }, 10_000);

  it('executes an admitted current-message tool exactly once across guard recovery', async () => {
    const sessionId = 'agent-session-current-message-handoff';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    const provider = new MockProvider();
    // Tool-only turn: high prompt tokens are fine when the model is calling tools.
    // (SCLI-195 no longer force-pauses productive tool work for "tiny text".)
    provider.queueResponse(ResponseBuilder.withToolCalls('', [
      { id: 'tc-non-idempotent', name: 'non_idempotent_write', input: {} },
    ], { input: 200_000, output: 1 }));
    // End the loop after tools so processMessage returns with the tool executed once.
    // Substantive text so this completion is not a sterile high-prefill spin.
    provider.queueResponse(ResponseBuilder.textOnly('wrote ok', { input: 5_000, output: 80 }));
    const agent = wiredAgent(sessionId, provider);
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 'non_idempotent_write',
      description: 'increments a counter exactly once',
      parameters: z.object({}),
      riskLevel: 'low',
      async execute() {
        executions += 1;
        return { toolUseId: 'tc-non-idempotent', content: `write-${executions}` };
      },
    });
    agent.toolRegistry = registry;
    agent.toolDefs = registry.definitions();
    agent.permissions = new PermissionEngine('autonomous');
    agent.emitter = new AgentEventEmitter();
    agent.expensiveTurnGuard = new ExpensiveTurnGuard({
      enabled: true,
      windowMs: 60_000,
      minTurns: 1,
      minPromptTokens: 1_000,
      minPromptOutputRatio: 10,
      minProductiveOutputTokens: 32,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      notifyCooldownMs: 60_000,
      coldTtftMs: 15_000,
    });
    agent.auditLogger = {
      logBefore: vi.fn(() => 'audit-current-message'),
      logAfter: vi.fn(),
      logError: vi.fn(),
    };
    const current = inbound('current-human-tool-turn', 'user', 'Perform the write once.', {
      channelType: 'connect',
      userId: 'hritik',
    });

    await agent.processMessage(current);

    expect(executions).toBe(1);
    expect(agent.auditLogger.logAfter).toHaveBeenCalledWith(
      'audit-current-message',
      'jun-s347',
      'non_idempotent_write',
      'write-1',
      0,
    );
    // Tool turns must not open recovery by themselves.
    expect(store.loadExpensiveTurnRecovery(sessionId)).toBeNull();

    // Sterile high-prefill spin (no tools) still force-pauses. Pass the already
    // admitted current message so recovery acknowledges it and never re-runs tools.
    const sterile = agent.expensiveTurnGuard.record({
      now: Date.now(),
      inputTokens: 200_000,
      outputTokens: 1,
      toolCallCount: 0,
    });
    expect(sterile.action).toBe('pause');
    await (agent as any).applyExpensiveTurnPauseBranch(sterile, agent.model, current);

    const recovery = store.loadExpensiveTurnRecovery(sessionId)!;
    expect(recovery.state).toBe('recovery_pending');
    expect(store.listDeferredRecoveryMessages(sessionId, recovery.episodeId)
      .map((item) => item.messageId)).not.toContain(current.id);
    const capsule = String(store.loadSession(sessionId)!.messages[0]!.content);
    expect(capsule).toContain(`\"lastAcknowledgedMessageId\":\"${current.id}\"`);
    expect(capsule).not.toContain(`\"unresolvedHumanMessageIds\":[\"${current.id}\"]`);

    agent.executeTurns = vi.fn(async () => {
      recordHeartbeatQueueDrainTurn('jun-s347', {
        toolCalls: [
          { name: 'mcp__shizuha_pulse__pulse_get_my_alerts', input: {} },
          { name: 'mcp__shizuha_pulse__pulse_get_my_tasks', input: {} },
        ],
        toolResults: [
          { content: 'No active assigned alerts.', isError: false },
          { content: 'No actionable tasks found', isError: false },
        ],
      });
    });
    await agent.processInboxMessage(await agent.inbox.next());

    expect(store.loadExpensiveTurnRecovery(sessionId)!.state).toBe('verified');
    expect(agent.inbox.queued().map((message: InboundMessage) => message.id)).not.toContain(current.id);
    expect(executions).toBe(1);
  }, 10_000);

  it('repairs a crash after the durable fence with one semantic successor and never creates a second episode', async () => {
    const sessionId = 'agent-session-crash';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    for (const message of bloatedMessages(120)) store.appendMessage(sessionId, message);
    const counters = { preserved: 0, coalesced: 0, dropped: 0, deferred: 0, replayed: 0 };
    const begun = store.beginExpensiveTurnRecovery(sessionId, 'episode-crash', 120, 99_000, [], counters);
    expect(begun.state).toBe('guard_tripped');

    const provider = compactionProvider();
    const agent = wiredAgent(sessionId, provider);
    await agent.resumeExpensiveTurnRecoveryAtStartup();
    const repaired = store.loadExpensiveTurnRecovery(sessionId)!;
    expect(repaired.state).toBe('recovery_pending');
    expect(repaired.episodeId).toBe('episode-crash');
    expect(repaired.activeGeneration).toBe(1);
    expect(repaired.compactionOutcome).toBe('semantic_compaction_succeeded_after_restart');
    expect(provider.callCount).toBe(1);
    expect(store.loadSession(sessionId)!.messages.some((message) => (
      String(message.content).includes('[Conversation Summary]')
    ))).toBe(true);

    const restarted = wiredAgent(sessionId, new TimeoutCompactionProvider());
    await restarted.resumeExpensiveTurnRecoveryAtStartup();
    const afterRestart = store.loadExpensiveTurnRecovery(sessionId)!;
    expect(afterRestart.episodeId).toBe('episode-crash');
    expect(afterRestart.activeGeneration).toBe(1);
  });

  it('releases unacknowledged input after a crash between verified state and inbox enqueue', async () => {
    const sessionId = 'agent-session-verified-before-enqueue';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    const message = inbound('human-before-enqueue', 'user', 'Preserve across verified crash.', {
      channelType: 'connect',
      userId: 'hritik',
    });
    const begun = store.beginExpensiveTurnRecovery(
      sessionId,
      'episode-verified-before-enqueue',
      185,
      141_498,
      [{ messageId: message.id, messageClass: 'human', payload: JSON.stringify(message) }],
      { preserved: 1, coalesced: 0, dropped: 0, deferred: 1, replayed: 0 },
    );
    store.commitExpensiveTurnSuccessor(
      sessionId,
      begun.episodeId,
      [{ role: 'user', content: 'capsule', timestamp: Date.now() }],
      'clean_successor_created_timeout',
    );
    store.recordExpensiveTurnRecoveryAttempt(sessionId, begun.episodeId, 'queue_empty', 'verified');

    store.close();
    store = new StateStore(path.join(dir, 'state.db'));
    const restarted = wiredAgent(sessionId, new TimeoutCompactionProvider());
    restarted.executeTurns = vi.fn(async () => {});
    await restarted.resumeExpensiveTurnRecoveryAtStartup();

    expect(restarted.inbox.queued().map((entry: InboundMessage) => entry.id)).toEqual([message.id]);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.counters.replayed).toBe(0);
    await restarted.processInboxMessage(await restarted.inbox.next());
    expect(store.listDeferredRecoveryMessages(sessionId, begun.episodeId)).toEqual([]);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.counters.replayed).toBe(1);
  });

  it('re-enqueues a releasing row after a crash between inbox enqueue and per-message ack', async () => {
    const sessionId = 'agent-session-enqueue-before-ack';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    const message = inbound('connect-before-ack', 'inter-agent', 'Preserve across ack crash.', {
      channelType: 'connect',
      userId: 'kai',
    });
    const begun = store.beginExpensiveTurnRecovery(
      sessionId,
      'episode-enqueue-before-ack',
      185,
      141_498,
      [{ messageId: message.id, messageClass: 'connect_actionable', payload: JSON.stringify(message) }],
      { preserved: 1, coalesced: 0, dropped: 0, deferred: 1, replayed: 0 },
    );
    store.commitExpensiveTurnSuccessor(
      sessionId,
      begun.episodeId,
      [{ role: 'user', content: 'capsule', timestamp: Date.now() }],
      'clean_successor_created_timeout',
    );
    store.recordExpensiveTurnRecoveryAttempt(sessionId, begun.episodeId, 'worked_task', 'verified');

    const firstProcess = wiredAgent(sessionId, new TimeoutCompactionProvider());
    await firstProcess.resumeExpensiveTurnRecoveryAtStartup();
    expect(firstProcess.inbox.queued().map((entry: InboundMessage) => entry.id)).toEqual([message.id]);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.counters.replayed).toBe(0);

    store.close();
    store = new StateStore(path.join(dir, 'state.db'));
    const restarted = wiredAgent(sessionId, new TimeoutCompactionProvider());
    restarted.executeTurns = vi.fn(async () => {});
    await restarted.resumeExpensiveTurnRecoveryAtStartup();
    expect(restarted.inbox.queued().map((entry: InboundMessage) => entry.id)).toEqual([message.id]);

    await restarted.processInboxMessage(await restarted.inbox.next());
    expect(store.listDeferredRecoveryMessages(sessionId, begun.episodeId)).toEqual([]);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.counters.replayed).toBe(1);
  });

  it('never acknowledges an invalid deferred payload as replayed', async () => {
    const sessionId = 'agent-session-invalid-deferred';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    const begun = store.beginExpensiveTurnRecovery(
      sessionId,
      'episode-invalid-deferred',
      185,
      141_498,
      [{ messageId: 'human-corrupt', messageClass: 'human', payload: '{not-json' }],
      { preserved: 1, coalesced: 0, dropped: 0, deferred: 1, replayed: 0 },
    );
    store.commitExpensiveTurnSuccessor(
      sessionId,
      begun.episodeId,
      [{ role: 'user', content: 'capsule', timestamp: Date.now() }],
      'clean_successor_created_timeout',
    );
    store.recordExpensiveTurnRecoveryAttempt(sessionId, begun.episodeId, 'queue_empty', 'verified');

    const restarted = wiredAgent(sessionId, new TimeoutCompactionProvider());
    await restarted.resumeExpensiveTurnRecoveryAtStartup();

    expect(restarted.inbox.depth).toBe(0);
    expect(store.listDeferredRecoveryMessages(sessionId, begun.episodeId).map((item) => item.messageId)).toEqual(['human-corrupt']);
    expect(store.loadExpensiveTurnRecovery(sessionId)!.counters.replayed).toBe(0);
  });

  it('stops after two recovery turns that make no progress and schedules no third expensive attempt', async () => {
    const sessionId = 'agent-session-exhaust';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    const state = store.beginExpensiveTurnRecovery(
      sessionId,
      'episode-exhaust',
      185,
      141_498,
      [],
      { preserved: 0, coalesced: 0, dropped: 0, deferred: 0, replayed: 0 },
    );
    store.commitExpensiveTurnSuccessor(sessionId, state.episodeId, [{ role: 'user', content: 'capsule', timestamp: Date.now() }], 'clean_successor_created_timeout');
    const agent = wiredAgent(sessionId, new TimeoutCompactionProvider());

    await agent.finishExpensiveTurnRecoveryBootstrap(state.episodeId, 'ready_no_progress');
    expect(store.loadExpensiveTurnRecovery(sessionId)!.attempts).toBe(1);
    expect(agent.inbox.depth).toBe(1);
    agent.inbox.drain();

    await agent.finishExpensiveTurnRecoveryBootstrap(state.episodeId, 'ready_no_progress');
    const exhausted = store.loadExpensiveTurnRecovery(sessionId)!;
    expect(exhausted.state).toBe('exhausted');
    expect(exhausted.attempts).toBe(2);
    expect(agent.inbox.depth).toBe(0);
  });
});
