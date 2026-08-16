import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentProcess } from '../../src/gateway/agent-process.js';
import { StateStore } from '../../src/state/store.js';
import type { Message } from '../../src/agent/types.js';
import { estimatePromptTokenBudget } from '../../src/agent/heartbeat-hygiene.js';
import { ExpensiveTurnGuard } from '../../src/agent/expensive-turn-guard.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';
import type { Channel, InboundMessage } from '../../src/gateway/types.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

/**
 * SCLI-345: production recovery after expensive-turn guard.
 * Cycle 1 uses real ExpensiveTurnGuard.record + production pause branch.
 * Cycle 2 drives real processMessage with a mocked provider (no synthetic
 * second-cycle helper).
 */
describe('SCLI-345 AgentProcess recovery', () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli345-ap-'));
    store = new StateStore(path.join(dir, 'state.db'));
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function bloated(n: number, pad = 5000): Message[] {
    const out: Message[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${i} ` + 'x'.repeat(pad),
        timestamp: Date.now() + i,
      });
    }
    return out;
  }

  function mockChannel(id = 'ch-1'): Channel {
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

  function wireAgent(sessionId: string, provider: MockProvider, maxCtx = 32_000): any {
    const agent = new AgentProcess({
      channels: [],
      model: 'cortex/DeepSeek-V4-Flash',
      cwd: dir,
      permissionMode: 'autonomous',
      agentId: 'jun-ap',
      agentName: 'jun-ap',
    }) as any;
    agent.store = store;
    agent.sessionId = sessionId;
    agent.messages = [...(store.loadSession(sessionId)?.messages ?? [])];
    agent.systemPrompt = 'You are a test agent.';
    agent.toolDefs = [];
    agent.maxContextTokens = maxCtx;
    agent.lastReportedPromptTokens = 0;
    agent.provider = provider;
    agent.providerReg = {
      resolve: () => provider,
      resolveWithModel: () => ({ provider, model: agent.model }),
      get: () => provider,
    };
    agent.expensiveTurnGuard = new ExpensiveTurnGuard({
      enabled: true,
      windowMs: 60_000,
      minTurns: 2,
      minPromptTokens: 1_000,
      minPromptOutputRatio: 10,
      baseBackoffMs: 50,
      maxBackoffMs: 100,
      notifyCooldownMs: 60_000,
    });
    agent.notifyExpensiveTurnGuard = vi.fn(async () => {});
    agent.notifyExpensiveTurnRecoveryOutcome = vi.fn(async () => {});
    agent.toolRegistry = { definitions: () => [], get: () => undefined, has: () => false };
    agent.emitter = { on: () => () => {}, emit: () => {}, off: () => {} };
    agent.modelFallbacks = [];
    agent.pinnedFallbackIndex = 0;
    agent.maxOutputTokensForMessage = () => 1024;
    agent.spanTracker = null;
    agent.hookEngine = null;
    agent.rateLimiter = null;
    agent.autoReplyEngine = null;
    agent.inbox = { busy: false, queued: () => [], next: async () => null };
    agent.channels = new Map([['ch-1', mockChannel('ch-1')]]);
    agent.running = true;
    return agent;
  }

  it('two production cycles: guard trip recovery then processMessage under-window', async () => {
    const sessionId = 'agent-session-jun-ap';
    store.createSessionWithId(sessionId, 'cortex/DeepSeek-V4-Flash', dir);
    for (const m of bloated(80, 5000)) store.appendMessage(sessionId, m);

    const recoveryTarget = Math.floor(32_000 * 0.5);
    const mock1 = new MockProvider();
    for (let pass = 0; pass < 8; pass++) {
      mock1.queueResponse(ResponseBuilder.textOnly(`Semantic recovery pass ${pass}. `.repeat(80)));
    }
    const agent1 = wireAgent(sessionId, mock1);
    const before = estimatePromptTokenBudget({
      messages: agent1.messages,
      systemPrompt: agent1.systemPrompt,
      toolDefs: [],
      model: agent1.model,
    });
    expect(before.promptTokenEstimate).toBeGreaterThan(recoveryTarget);

    const now = Date.now();
    const decision = await agent1.runExpensiveTurnGuardProductionSequence(
      [
        { now, inputTokens: 200_000, outputTokens: 10, toolCallCount: 0, source: 'heartbeat' },
        { now: now + 1_000, inputTokens: 200_000, outputTokens: 5, toolCallCount: 0, source: 'heartbeat' },
      ],
      agent1.model,
    );
    expect(decision.action).toBe('pause');

    // Fresh process (production reload)
    const mock2 = new MockProvider();
    mock2.queueResponse(ResponseBuilder.textOnly('recovered', { input: 3_000, output: 20 }));
    const agent2 = wireAgent(sessionId, mock2);
    const reloaded = estimatePromptTokenBudget({
      messages: agent2.messages,
      systemPrompt: agent2.systemPrompt,
      toolDefs: [],
      model: agent2.model,
    });
    expect(reloaded.promptTokenEstimate).toBeLessThanOrEqual(recoveryTarget);

    const heartbeat: InboundMessage = {
      id: 'hb-ap-1',
      channelId: 'ch-1',
      channelType: 'http',
      threadId: 'heartbeat-jun-ap',
      userId: 'heartbeat',
      userName: 'heartbeat',
      content: '[HEARTBEAT] drain queue',
      timestamp: Date.now(),
      source: 'heartbeat',
    };
    await agent2.processMessage(heartbeat);

    expect(mock2.capturedMessages.length).toBeGreaterThanOrEqual(1);
    const sent = mock2.capturedMessages[0]!;
    const sentAs: Message[] = sent.map((m, i) => ({
      role: m.role as any,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      timestamp: Date.now() + i,
    }));
    const providerEst = estimatePromptTokenBudget({
      messages: sentAs,
      systemPrompt: agent2.systemPrompt,
      toolDefs: [],
      model: agent2.model,
    });
    expect(providerEst.promptTokenEstimate).toBeLessThanOrEqual(recoveryTarget);
    expect(agent2.expensiveTurnGuard.remainingPauseMs()).toBe(0);
  }, 60_000);
});
