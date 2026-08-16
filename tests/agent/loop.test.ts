import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { AgentConfig, Message } from '../../src/agent/types.js';
import type { AgentEvent } from '../../src/events/types.js';
import type { ToolHandler, ToolResult, ToolContext } from '../../src/tools/types.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

// ── Mocks ──
// Mock heavy dependencies so runAgent() uses our MockProvider and avoids real I/O

const mockProvider = new MockProvider();
const storeHarness = vi.hoisted(() => ({
  sessions: new Map<string, {
    id: string;
    model: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    messages: Message[];
    totalInputTokens: number;
    totalOutputTokens: number;
    turnCount: number;
  }>(),
  replaceMessages: vi.fn(),
}));

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    agent: {
      defaultModel: 'test-model',
      cwd: '/tmp',
      maxTurns: 10,
      maxContextTokens: 200000,
      temperature: 0,
      maxOutputTokens: 16384,
    },
    permissions: { mode: 'autonomous', rules: [] },
    mcp: { servers: [] },
    providers: {},
    skills: { trustProjectSkills: false },
    sandbox: { mode: 'unrestricted', writablePaths: [], networkAccess: false, protectedPaths: ['.git'] },
  }),
}));

vi.mock('../../src/provider/registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    resolve: () => mockProvider,
    resolveWithModel: (m: string) => ({ provider: mockProvider, resolvedModel: m }),
    resolveAutoModel: () => 'test-model',
    hasCloudProvider: () => true,
  })),
  isCortexModelId: () => false,
}));

vi.mock('../../src/prompt/builder.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('Test system prompt.'),
}));

vi.mock('../../src/state/store.js', () => {
  return {
    StateStore: vi.fn().mockImplementation(() => ({
      createSession: (_model: string, _cwd: string) => {
        const id = 'test-session-id';
        const session = { id, model: _model, cwd: _cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [], totalInputTokens: 0, totalOutputTokens: 0, turnCount: 0 };
        storeHarness.sessions.set(id, session);
        return session;
      },
      loadSession: (id: string) => storeHarness.sessions.get(id) ?? null,
      appendMessage: () => {},
      updateTokens: () => {},
      replaceMessages: storeHarness.replaceMessages,
      close: () => {},
    })),
  };
});

vi.mock('../../src/tools/mcp/manager.js', () => ({
  MCPManager: vi.fn().mockImplementation(() => ({
    connectAll: vi.fn().mockResolvedValue(undefined),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
    failedServers: [],
  })),
}));

vi.mock('../../src/tools/mcp/bridge.js', () => ({
  registerMCPTools: vi.fn().mockResolvedValue(0),
}));

// Import after mocks are set up
const { runAgent, isContextOverflowError } = await import('../../src/agent/loop.js');
const { userVisibleProviderFailure, providerFailureTerminalMessage, providerFailureDedupeKey } = await import('../../src/gateway/agent-process.js');

// ── Helpers ──

async function collectEvents(config: Partial<AgentConfig> = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const fullConfig: AgentConfig = {
    model: 'test-model',
    cwd: '/tmp',
    maxTurns: 10,
    permissionMode: 'autonomous',
    ...config,
  };
  for await (const event of runAgent(fullConfig)) {
    events.push(event);
  }
  return events;
}

function findEvent<T extends AgentEvent>(events: AgentEvent[], type: string): T | undefined {
  return events.find((e) => e.type === type) as T | undefined;
}

function findEvents(events: AgentEvent[], type: string): AgentEvent[] {
  return events.filter((e) => e.type === type);
}

function seedCompressibleSession(id: string): string {
  const messages: Message[] = Array.from({ length: 50 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `History ${index}: ${'word '.repeat(1_500)}`,
    timestamp: Date.now() + index,
  }));
  storeHarness.sessions.set(id, {
    id,
    model: 'test-model',
    cwd: '/tmp',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  });
  return id;
}

// ── Tests ──

beforeEach(() => {
  mockProvider.reset();
  storeHarness.sessions.clear();
  storeHarness.replaceMessages.mockClear();
});

describe('runAgent — basic lifecycle', () => {
  it('yields session_start, turn_start, turn_complete, complete events', async () => {
    mockProvider.queueResponse(ResponseBuilder.textOnly('Hello!'));
    const events = await collectEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain('session_start');
    expect(types).toContain('turn_start');
    expect(types).toContain('turn_complete');
    expect(types).toContain('complete');
  });

  it('text-only response stops after 1 turn', async () => {
    mockProvider.queueResponse(ResponseBuilder.textOnly('Done.'));
    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(1);
  });

  it('complete event has correct token counts', async () => {
    mockProvider.queueResponse(ResponseBuilder.textOnly('reply', { input: 150, output: 75 }));
    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalInputTokens: number; totalOutputTokens: number }>(events, 'complete');
    expect(complete?.totalInputTokens).toBe(150);
    expect(complete?.totalOutputTokens).toBe(75);
  });

  it('session_start includes sessionId', async () => {
    mockProvider.queueResponse(ResponseBuilder.textOnly('hi'));
    const events = await collectEvents();
    const start = findEvent<{ type: 'session_start'; sessionId: string }>(events, 'session_start');
    expect(start?.sessionId).toBeTruthy();
  });
});

describe('runAgent — multi-turn with tool calls', () => {
  it('tool call triggers another turn', async () => {
    // Turn 1: LLM makes a tool call → turn 2: LLM responds with text
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('Let me check...', [{ id: 'tc1', name: 'read', input: { file_path: '/tmp/test.txt' } }]),
    );
    mockProvider.queueResponse(ResponseBuilder.textOnly('All done!'));

    const events = await collectEvents();
    const turnStarts = findEvents(events, 'turn_start');
    expect(turnStarts.length).toBe(2);
  });

  it('turn 2 sees tool_result in messages', async () => {
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'read', input: { file_path: '/tmp/x' } }]),
    );
    mockProvider.queueResponse(ResponseBuilder.textOnly('Got it.'));

    await collectEvents();
    // The second call should have tool_result in messages
    expect(mockProvider.capturedMessages.length).toBe(2);
    const secondCallMsgs = mockProvider.capturedMessages[1]!;
    const hasToolResult = secondCallMsgs.some((m) => {
      if (typeof m.content === 'string') return false;
      return (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result');
    });
    expect(hasToolResult).toBe(true);
  });

  it('stops when LLM returns text-only after tool calls', async () => {
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'glob', input: { pattern: '*.ts' } }]),
    );
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc2', name: 'glob', input: { pattern: '*.js' } }]),
    );
    mockProvider.queueResponse(ResponseBuilder.textOnly('Found everything.'));

    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(3);
  });

  it('respects maxTurns limit', async () => {
    // Queue 5 tool call responses, but limit to 3 turns
    for (let i = 0; i < 5; i++) {
      mockProvider.queueResponse(
        ResponseBuilder.withToolCalls('', [{ id: `tc${i}`, name: 'read', input: { file_path: '/tmp/x' } }]),
      );
    }
    const events = await collectEvents({ maxTurns: 3 });
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(3);
  });
});

describe('runAgent — background task notification continuation', () => {
  it('waits once in production order and injects terminal output before the repair turn', async () => {
    // Real caller sequence from run1080/result16598:
    // launch background pytest -> model emits wait-only text -> task completes ->
    // executeTurn collects the terminal reminder on the next provider call.
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [{
        id: 'bg-test',
        name: 'bash',
        input: {
          command: "sleep 0.05; printf '22 passed, 1 failed\\n'",
          timeout: 1000,
          run_in_background: true,
        },
      }]),
    );
    mockProvider.queueResponse(ResponseBuilder.textOnly('Let me wait for the test results:'));
    mockProvider.queueResponse(ResponseBuilder.textOnly('I found the failing stress test and repaired it.'));

    const events = await collectEvents({ maxTurns: 10 });

    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(3);
    expect(mockProvider.callCount).toBe(3);
    const notificationTurn = mockProvider.capturedMessages[2]!;
    const reminder = notificationTurn.find((message) =>
      Array.isArray(message.content)
      && message.content.some((block) =>
        block.type === 'text'
        && block.text.includes('<system-reminder>Background task')
        && block.text.includes('has completed')
        && block.text.includes('22 passed, 1 failed')),
    );
    expect(reminder).toBeDefined();
  });

  it('external cancellation interrupts a pending background wait promptly', async () => {
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [{
        id: 'bg-stuck',
        name: 'bash',
        input: {
          command: 'sleep 2',
          timeout: 1000,
          run_in_background: true,
        },
      }]),
    );
    mockProvider.queueResponse(ResponseBuilder.textOnly('Waiting on the test suite.'));

    const abort = new AbortController();
    const startedAt = Date.now();
    const collecting = collectEvents({ maxTurns: 10, abortSignal: abort.signal });
    setTimeout(() => abort.abort(), 100);

    const events = await collecting;
    expect(Date.now() - startedAt).toBeLessThan(750);
    expect(findEvent(events, 'complete')).toBeDefined();
    expect(mockProvider.callCount).toBe(2);
  });
});

describe('runAgent — repeated identical tool call (loop guard)', () => {
  it('nudges correctively instead of hard-stopping at 3, and only backstops at 6', async () => {
    // Same FAILING call (read of a missing file → isError) emitted many times —
    // mimics the model re-running `docker compose up` from the wrong directory.
    for (let i = 0; i < 8; i++) {
      mockProvider.queueResponse(
        ResponseBuilder.withToolCalls('', [
          { id: `tc${i}`, name: 'read', input: { file_path: '/tmp/nope-loopguard-xyz-123.txt' } },
        ]),
      );
    }
    const events = await collectEvents();

    // Regression: the old guard hard-stopped at 3 turns. The repeated call must
    // now run past 3 and only stop at the generous runaway backstop
    // (REPEATED_TOOL_CALL_STOP_AT = 6) — totalTurns counts each turn that ran.
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBeGreaterThan(3);
    expect(complete?.totalTurns).toBeLessThanOrEqual(6);

    // An error-aware corrective nudge must have been injected (not the old
    // "answer directly from the result" which is useless for a failing command).
    const nudged = mockProvider.capturedMessages.flat().some(
      (m) => typeof m.content === 'string' && /different approach|keeps FAILING/i.test(m.content),
    );
    expect(nudged).toBe(true);
  });
});

describe('runAgent — incomplete model turns', () => {
  it('treats max_tokens as an explicit incomplete terminal without replay', async () => {
    mockProvider.queueResponse(ResponseBuilder.truncated('Partial but visible response.'));

    const events = await collectEvents({ model: 'DeepSeek-V4-Flash' });
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    const error = findEvent<{ type: 'error'; error: string }>(events, 'error');
    expect(complete?.totalTurns).toBe(1);
    expect(mockProvider.callCount).toBe(1);
    expect(error?.error).toContain('output-token limit');
  });

  it('applies the same fail-closed rule to Claude', async () => {
    mockProvider.queueResponse(ResponseBuilder.truncated('partial output...'));
    mockProvider.queueResponse(ResponseBuilder.textOnly('must not be consumed'));
    const events = await collectEvents({ model: 'claude-sonnet-4-6' });
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(1);
    expect(mockProvider.callCount).toBe(1);
  });

  it('continues an autonomous thinking-only max_tokens turn so the model can tool-call', async () => {
    mockProvider.queueResponse([
      { type: 'reasoning' as const, id: 'r-think', rawContent: 'planning the chess engine in hidden reasoning' },
      { type: 'usage' as const, inputTokens: 10_000, outputTokens: 16_384 },
      { type: 'stop_reason' as const, reason: 'max_tokens' },
      { type: 'done' as const },
    ]);
    mockProvider.queueResponse(ResponseBuilder.textOnly('Here is the implementation plan as visible text.'));

    const events = await collectEvents({ model: 'Qwen3.8-27B-Q4', permissionMode: 'autonomous' });
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    const error = findEvent<{ type: 'error'; error: string }>(events, 'error');
    expect(error).toBeUndefined();
    expect(complete?.totalTurns).toBe(2);
    expect(mockProvider.callCount).toBe(2);
    const secondCallMsgs = mockProvider.capturedMessages[1]!;
    expect(secondCallMsgs.some(
      (m) => typeof m.content === 'string' && m.content.includes('Continue. Use your tools'),
    )).toBe(true);
  });

  it('continues autonomous max_tokens even when reasoning leaked into visible text', async () => {
    mockProvider.queueResponse([
      { type: 'reasoning' as const, id: 'r-leak', rawContent: 'hidden plan' },
      { type: 'text' as const, text: 'I will now write chess_engine.py after more thought.' },
      { type: 'usage' as const, inputTokens: 10_000, outputTokens: 16_384 },
      { type: 'stop_reason' as const, reason: 'max_tokens' },
      { type: 'done' as const },
    ]);
    mockProvider.queueResponse(ResponseBuilder.textOnly('Wrote the files.'));

    const events = await collectEvents({ model: 'Qwen3.8-27B-Q4', permissionMode: 'autonomous' });
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    const error = findEvent<{ type: 'error'; error: string }>(events, 'error');
    expect(error).toBeUndefined();
    expect(complete?.totalTurns).toBe(2);
    expect(mockProvider.callCount).toBe(2);
  });
});

describe('runAgent — error handling', () => {
  it('provider error yields error event + complete', async () => {
    // No response queued → MockProvider will throw
    const events = await collectEvents();
    const errorEvt = findEvent<{ type: 'error'; error: string }>(events, 'error');
    expect(errorEvt).toBeDefined();
    expect(errorEvt!.error).toContain('no response queued');
    // Should still get complete event
    const complete = findEvent<{ type: 'complete' }>(events, 'complete');
    expect(complete).toBeDefined();
  });
});

describe('runAgent — PLAT-216 no-progress guard', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['AGENT_NO_PROGRESS_TURNS'];
    // Use threshold=3 so tests run in fewer turns
    process.env['AGENT_NO_PROGRESS_TURNS'] = '3';
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['AGENT_NO_PROGRESS_TURNS'];
    } else {
      process.env['AGENT_NO_PROGRESS_TURNS'] = savedEnv;
    }
  });

  it('emits StuckEvent when agent alternates between already-seen tool calls', async () => {
    // Turn 1: [A, B] — new calls, added to seenSigs
    // Turn 2: [C, D] — new calls, added to seenSigs
    // Turn 3: [A, B] — all seen → noProgressTurns=1
    // Turn 4: [C, D] — all seen → noProgressTurns=2
    // Turn 5: [A, B] — all seen → noProgressTurns=3 ≥ threshold → inject stuckNotice, stuckCleanupPending=true
    // Turn 6: cleanup (text-only) → stuckCleanupPending check fires → StuckEvent
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [
        { id: 'tc1', name: 'read', input: { file_path: '/a.ts' } },
        { id: 'tc2', name: 'read', input: { file_path: '/b.ts' } },
      ]),
    );
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [
        { id: 'tc3', name: 'read', input: { file_path: '/c.ts' } },
        { id: 'tc4', name: 'read', input: { file_path: '/d.ts' } },
      ]),
    );
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [
        { id: 'tc5', name: 'read', input: { file_path: '/a.ts' } },
        { id: 'tc6', name: 'read', input: { file_path: '/b.ts' } },
      ]),
    );
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [
        { id: 'tc7', name: 'read', input: { file_path: '/c.ts' } },
        { id: 'tc8', name: 'read', input: { file_path: '/d.ts' } },
      ]),
    );
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [
        { id: 'tc9', name: 'read', input: { file_path: '/a.ts' } },
        { id: 'tc10', name: 'read', input: { file_path: '/b.ts' } },
      ]),
    );
    // Cleanup turn: agent responds to stuck notice with text
    mockProvider.queueResponse(ResponseBuilder.textOnly('I cannot proceed — the files are missing.'));

    const events = await collectEvents({ maxTurns: 20 });

    const stuck = findEvent<{ type: 'stuck'; turnsWithoutProgress: number; threshold: number }>(events, 'stuck');
    expect(stuck).toBeDefined();
    expect(stuck!.turnsWithoutProgress).toBe(3);
    expect(stuck!.threshold).toBe(3);
  });

  it('does NOT emit StuckEvent when each turn makes new tool calls', async () => {
    // 5 turns, each with a unique file path → always new signatures
    for (let i = 0; i < 5; i++) {
      mockProvider.queueResponse(
        ResponseBuilder.withToolCalls('', [{ id: `tc${i}`, name: 'read', input: { file_path: `/unique-${i}.ts` } }]),
      );
    }
    mockProvider.queueResponse(ResponseBuilder.textOnly('All done!'));

    const events = await collectEvents({ maxTurns: 20 });

    const stuck = findEvent(events, 'stuck');
    expect(stuck).toBeUndefined();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(6);
  });

  it('does NOT emit StuckEvent for text-only turns (reset counter)', async () => {
    // Turn 1: tool call A (new)
    // Turn 2: tool call A (seen, noProgressTurns=1)
    // Turn 3: text-only → counter resets to 0
    // Guard should not fire
    const tc = { id: 'tc1', name: 'read', input: { file_path: '/x.ts' } };
    mockProvider.queueResponse(ResponseBuilder.withToolCalls('', [tc]));
    mockProvider.queueResponse(ResponseBuilder.withToolCalls('', [{ ...tc, id: 'tc2' }]));
    mockProvider.queueResponse(ResponseBuilder.textOnly('Done.'));

    const events = await collectEvents({ maxTurns: 10 });

    expect(findEvent(events, 'stuck')).toBeUndefined();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(3);
  });

  it('guard disabled when AGENT_NO_PROGRESS_TURNS=0', async () => {
    process.env['AGENT_NO_PROGRESS_TURNS'] = '0';
    // Even if all calls repeat, no StuckEvent
    const tc = { id: 'tc1', name: 'read', input: { file_path: '/x.ts' } };
    for (let i = 0; i < 5; i++) {
      mockProvider.queueResponse(ResponseBuilder.withToolCalls('', [{ ...tc, id: `tc${i}` }]));
    }
    mockProvider.queueResponse(ResponseBuilder.textOnly('Done.'));

    const events = await collectEvents({ maxTurns: 20 });
    expect(findEvent(events, 'stuck')).toBeUndefined();
  });
});

describe('runAgent — compaction trigger', () => {
  it('compacts a completed tool subturn semantically before the next provider call', async () => {
    const sessionId = seedCompressibleSession('post-tool-semantic-compaction');
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls(
        '',
        [{ id: 'tc1', name: 'read', input: { file_path: '/tmp/x' } }],
        { input: 160_000, output: 100 },
      ),
    );
    mockProvider.queueResponse(ResponseBuilder.textOnly('Compaction summary of the conversation. '.repeat(30)));
    mockProvider.queueResponse(ResponseBuilder.textOnly('After compaction.'));

    const events = await collectEvents({ sessionId, maxContextTokens: 200_000 });
    const complete = findEvent<{ type: 'complete' }>(events, 'complete');
    expect(complete).toBeDefined();
    // LLM-based compaction (operator 2026-08-08) inserts one summary request
    // between the interactive turns — no lossy local projection.
    expect(mockProvider.callCount).toBe(3);
    expect(mockProvider.capturedOptions[2]?.requestKind).toBe('post_compaction');
    expect(mockProvider.capturedMessages[2]?.[0]?.content).toContain('[Conversation Summary]');
    expect(storeHarness.replaceMessages).toHaveBeenCalledTimes(1);
  });

  it('persists semantic compaction after a text-only final subturn', async () => {
    const sessionId = seedCompressibleSession('post-text-semantic-compaction');
    mockProvider.queueResponse(ResponseBuilder.textOnly(
      'Final answer.',
      { input: 160_000, output: 50 },
    ));
    mockProvider.queueResponse(ResponseBuilder.textOnly('Compaction summary of the conversation. '.repeat(30)));

    const events = await collectEvents({ sessionId, maxContextTokens: 200_000 });

    expect(findEvent<{ type: 'complete' }>(events, 'complete')).toBeDefined();
    // LLM-based compaction (operator 2026-08-08) adds one summary request.
    expect(mockProvider.callCount).toBe(2);
    expect(storeHarness.replaceMessages).toHaveBeenCalledTimes(1);
    const persisted = storeHarness.replaceMessages.mock.calls[0]?.[1] as Message[];
    expect(persisted[0]?.content).toContain('[Conversation Summary]');
    expect(persisted.some((message) => message.content === 'Final answer.')).toBe(true);
  });

  it('compacts resumed history semantically before the first provider call', async () => {
    const sessionId = 'oversized-resumed-session';
    const longText = 'word '.repeat(2_000);
    const messages: Message[] = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: longText,
      timestamp: Date.now(),
    }));
    storeHarness.sessions.set(sessionId, {
      id: sessionId,
      model: 'test-model',
      cwd: '/tmp',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
    });
    mockProvider.queueResponse(ResponseBuilder.textOnly('Compaction summary of the conversation. '.repeat(30)));
    mockProvider.queueResponse(ResponseBuilder.textOnly('Resumed safely.'));

    const events = await collectEvents({ sessionId, maxContextTokens: 200_000 });

    expect(findEvent<{ type: 'complete' }>(events, 'complete')).toBeDefined();
    // LLM-based compaction (operator 2026-08-08): the resumed over-threshold
    // history is summarized first, then the interactive turn runs.
    expect(mockProvider.callCount).toBe(2);
    expect(mockProvider.capturedOptions[1]?.requestKind).toBe('post_compaction');
    expect(mockProvider.capturedMessages[1]?.[0]?.content).toContain('[Conversation Summary]');
    expect(storeHarness.replaceMessages).toHaveBeenCalledTimes(1);
  });

  it('recovers one provider overflow with a semantic summary call', async () => {
    const sessionId = seedCompressibleSession('overflow-semantic-compaction');
    mockProvider.queueResponse(ResponseBuilder.textOnly('Compaction summary of the conversation. '.repeat(30)));
    mockProvider.queueResponse(ResponseBuilder.textOnly('Recovered after overflow.'));
    const overflow = Object.assign(new Error('prompt is too long: 220000 tokens'), { status: 400 });
    const chatSpy = vi.spyOn(mockProvider, 'chat').mockImplementationOnce(async function* () {
      throw overflow;
    });

    try {
      const events = await collectEvents({ sessionId, maxContextTokens: 200_000 });

      expect(findEvent(events, 'error')).toBeUndefined();
      expect(chatSpy).toHaveBeenCalledTimes(3);
      // LLM-based compaction (operator 2026-08-08): the overflow recovery makes
      // one summary request, then the interactive retry succeeds.
      expect(mockProvider.callCount).toBe(2);
      expect(mockProvider.capturedOptions[1]?.requestKind).toBe('post_compaction');
      expect(mockProvider.capturedMessages[1]?.[0]?.content).toContain('[Conversation Summary]');
      expect(storeHarness.replaceMessages).toHaveBeenCalledTimes(1);
    } finally {
      chatSpy.mockRestore();
    }
  });

  it('fails loud on a second overflow instead of destructively dropping history', async () => {
    const sessionId = seedCompressibleSession('second-overflow-semantic-compaction');
    const overflow = Object.assign(new Error('prompt is too long: 220000 tokens'), { status: 400 });
    // LLM-based compaction (operator 2026-08-08): the overflow recovery makes a
    // summary request (call 2) that must succeed; the two interactive turns
    // (calls 1 and 3) overflow, so the second overflow fails loud.
    mockProvider.queueResponse(ResponseBuilder.textOnly('Compaction summary of the conversation. '.repeat(30)));
    const originalChat = mockProvider.chat.bind(mockProvider);
    let call = 0;
    const chatSpy = vi.spyOn(mockProvider, 'chat').mockImplementation(async function* (...args: Parameters<typeof mockProvider.chat>) {
      call++;
      if (call === 1 || call === 3) throw overflow;
      yield* originalChat(...args);
    });

    try {
      const events = await collectEvents({ sessionId, maxContextTokens: 200_000 });

      expect(findEvent<{ type: 'error'; error: string }>(events, 'error')?.error)
        .toContain('prompt is too long');
      expect(chatSpy).toHaveBeenCalledTimes(3);
      // One LLM compaction rewrite only; the former tail-truncation fallback
      // would have performed another lossy replace before retrying again.
      expect(storeHarness.replaceMessages).toHaveBeenCalledTimes(1);
    } finally {
      chatSpy.mockRestore();
    }
  });
});

// ── SCLI-9 guard tests ────────────────────────────────────────────────────────

describe('runAgent — SCLI-9 silent generation guard (a)', () => {
  it('retries after 0-output-token response and stops after MAX_SILENT_GENERATION_RECOVERY', async () => {
    // Two silent responses followed by a text response
    mockProvider.queueResponse(ResponseBuilder.empty());  // outputTokens=0 → retry
    mockProvider.queueResponse(ResponseBuilder.empty());  // outputTokens=0 → final attempt
    mockProvider.queueResponse(ResponseBuilder.textOnly('Finally a response'));

    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    // Loop ran 3 turns: 2 silent retries + 1 real response
    expect(complete?.totalTurns).toBe(3);
    // The retry message was injected as a user message (provider called 3 times)
    expect(mockProvider.callCount).toBe(3);
    // Second call should include the retry nudge in its messages
    const secondCallMsgs = mockProvider.capturedMessages[1]!;
    const hasRetryNudge = secondCallMsgs.some((m) =>
      typeof m.content === 'string' && m.content.includes('Please respond'),
    );
    expect(hasRetryNudge).toBe(true);
  });

  it('stops without retrying when silent generation exhausted (MAX_SILENT_GENERATION_RECOVERY=2)', async () => {
    // 3 silent responses — guard allows 2 retries then gives up
    mockProvider.queueResponse(ResponseBuilder.empty());
    mockProvider.queueResponse(ResponseBuilder.empty());
    mockProvider.queueResponse(ResponseBuilder.empty());  // third: guard exhausted, loop breaks
    // (no text response queued — loop must stop on its own)
    mockProvider.queueResponse(ResponseBuilder.textOnly('should not reach this'));

    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    // MAX_SILENT_GENERATION_RECOVERY=2: retries turn 1→2, 2→3; on turn 3 count is exhausted → break
    expect(complete?.totalTurns).toBe(3);
    expect(mockProvider.callCount).toBe(3);
  });
});

describe('runAgent — SCLI-9 reasoning-channel surfacing guard (b)', () => {
  it('surfaces rawContent reasoning for thinking-capable models when no text content and breaks', async () => {
    // Reasoning-only: no text chunk, one reasoning block with rawContent
    mockProvider.queueResponse([
      { type: 'reasoning' as const, id: 'r1', rawContent: 'My reasoning chain here.' },
      { type: 'usage' as const, inputTokens: 100, outputTokens: 50 },
      { type: 'stop_reason' as const, reason: 'end_turn' },
      { type: 'done' as const },
    ]);

    const events = await collectEvents({ model: 'DeepSeek-R1' });
    const contentEvents = findEvents(events, 'content') as Array<{ type: 'content'; text: string }>;
    expect(contentEvents.some((e) => e.text.includes('reasoning chain'))).toBe(true);
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(1);
  });

  it('surfaces summary text reasoning for thinking-capable models when rawContent absent and breaks', async () => {
    mockProvider.queueResponse([
      { type: 'reasoning' as const, id: 'r2', summary: [{ text: 'Step 1.' }, { text: 'Step 2.' }] },
      { type: 'usage' as const, inputTokens: 100, outputTokens: 40 },
      { type: 'stop_reason' as const, reason: 'end_turn' },
      { type: 'done' as const },
    ]);

    const events = await collectEvents({ model: 'DeepSeek-R1' });
    const contentEvents = findEvents(events, 'content') as Array<{ type: 'content'; text: string }>;
    expect(contentEvents.some((e) => e.text.includes('Step 1') && e.text.includes('Step 2'))).toBe(true);
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(1);
  });

  it('surfaces reasoning-only output for thinking-capable DeepSeek-V4-Flash', async () => {
    mockProvider.queueResponse([
      { type: 'reasoning' as const, id: 'r3', rawContent: 'stale hidden prompt should not leak' },
      { type: 'usage' as const, inputTokens: 100, outputTokens: 50 },
      { type: 'stop_reason' as const, reason: 'end_turn' },
      { type: 'done' as const },
    ]);

    const events = await collectEvents({ model: 'DeepSeek-V4-Flash' });
    const contentEvents = findEvents(events, 'content') as Array<{ type: 'content'; text: string }>;
    expect(contentEvents.some((e) => e.text.includes('stale hidden prompt'))).toBe(true);
    expect(mockProvider.callCount).toBe(1);
  });
});

describe('runAgent — SCLI-9 thinking-only re-prompt guard (c)', () => {
  it('re-prompts when response is only <think>...</think> content (no actionable text)', async () => {
    // Turn 1: all content is inside <think> blocks — stripped content is empty
    mockProvider.queueResponse(ResponseBuilder.textOnly('<think>I should analyze this carefully.</think>'));
    // Turn 2: model provides a real answer after re-prompt
    mockProvider.queueResponse(ResponseBuilder.textOnly('Here is the actual answer.'));

    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    // Two turns: thinking-only re-prompt, then real answer
    expect(complete?.totalTurns).toBe(2);
    // Second call should include the continue nudge
    const secondCallMsgs = mockProvider.capturedMessages[1]!;
    const hasContinueNudge = secondCallMsgs.some((m) =>
      typeof m.content === 'string' && m.content.includes('Continue'),
    );
    expect(hasContinueNudge).toBe(true);
  });

  it('talk one-shot seats do not re-prompt thinking-only or run a second model call', async () => {
    const savedUser = process.env['AGENT_USERNAME'];
    const savedTalk = process.env['SHIZUHA_TALK_MINIMAL_PROMPT'];
    process.env['AGENT_USERNAME'] = 'yuna';
    process.env['SHIZUHA_TALK_MINIMAL_PROMPT'] = '1';
    try {
      mockProvider.queueResponse(ResponseBuilder.textOnly('<think>I should analyze this carefully.</think>'));
      mockProvider.queueResponse(ResponseBuilder.textOnly('should not reach'));
      const events = await collectEvents();
      const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
      expect(complete?.totalTurns).toBe(1);
      expect(mockProvider.callCount).toBe(1);
    } finally {
      if (savedUser === undefined) delete process.env['AGENT_USERNAME'];
      else process.env['AGENT_USERNAME'] = savedUser;
      if (savedTalk === undefined) delete process.env['SHIZUHA_TALK_MINIMAL_PROMPT'];
      else process.env['SHIZUHA_TALK_MINIMAL_PROMPT'] = savedTalk;
    }
  });

  it('stops after MAX_THINKING_ONLY_RECOVERY re-prompts (default 3)', async () => {
    // 4 thinking-only responses — guard allows 3 re-prompts then breaks
    for (let i = 0; i < 4; i++) {
      mockProvider.queueResponse(ResponseBuilder.textOnly('<think>still thinking...</think>'));
    }
    mockProvider.queueResponse(ResponseBuilder.textOnly('should not reach'));

    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    // turns: 1 (thinking) + 3 re-prompts (thinking) = 4 total, then break on 4th
    expect(complete?.totalTurns).toBe(4);
    expect(mockProvider.callCount).toBe(4);
  });
});

// ── SCLI-218: context-overflow classification (compact + retry once) ──

describe('isContextOverflowError', () => {
  it('recognizes the structured cortex/auto contract by error code', () => {
    expect(isContextOverflowError(429, 'context_too_large_for_capacity', 'top rung saturated')).toBe(true);
  });

  it('recognizes the structured contract embedded in the message body', () => {
    expect(isContextOverflowError(503, undefined,
      '{"error":{"code":"context_too_large_for_capacity","context_floor":131072}}')).toBe(true);
  });

  it("recognizes today's Cortex/vLLM exhaustion string (SCLI-206 shape)", () => {
    expect(isContextOverflowError(400, undefined,
      'Cortex/vLLM: context window exhausted — served max_model_len=262144 tokens, ' +
      'prompt≈1496180 tokens, only 1 output token remains after guard band (floor: 512).')).toBe(true);
  });

  it('recognizes classic provider overflow strings with no status', () => {
    expect(isContextOverflowError(undefined, undefined, 'prompt is too long: 210000 tokens')).toBe(true);
    expect(isContextOverflowError(400, undefined, 'This request would exceed the context limit')).toBe(true);
  });

  it('does not classify unrelated errors or non-400 statuses as overflow', () => {
    expect(isContextOverflowError(500, undefined, 'internal server error')).toBe(false);
    expect(isContextOverflowError(429, undefined, 'rate limited, slow down')).toBe(false);
    expect(isContextOverflowError(400, undefined, 'invalid tool schema')).toBe(false);
  });
});

describe('userVisibleProviderFailure (KOT-83)', () => {
  it('keeps context exhaustion actionable without exposing provider details', () => {
    const message = userVisibleProviderFailure(
      'Cortex/vLLM: context window exhausted — served max_model_len=262144 tokens',
    );
    expect(message).toContain('conversation is too long');
    expect(message).toContain('Start a new conversation');
    expect(message).not.toMatch(/Cortex|vLLM|262144|\[Provider error\]/);
  });

  it('maps timeouts and raw upstream bodies to stable retry copy', () => {
    const message = userVisibleProviderFailure(
      'vLLM no first chunk: no events for 630s; upstream={"error":"socket reset"}',
    );
    expect(message).toBe(
      'I could not complete that response because the AI service is temporarily unavailable. Please retry.',
    );
    expect(message).not.toMatch(/vLLM|630|socket|\[Provider error\]/);
  });

  it('creates a typed terminal ANDON without repeating the generic fallback copy', () => {
    const message = providerFailureTerminalMessage(
      'vLLM stream error: utf-8 codec cannot encode surrogate',
    );
    expect(message).toContain('🔴 ANDON');
    expect(message).toContain('Stopping this turn terminally');
    expect(message).not.toContain('Please retry');
    expect(message).not.toContain('AI service is temporarily unavailable');
    expect(message).not.toMatch(/vLLM|surrogate|utf-8/);
  });

  it('dedupes repeated provider failures per connect thread and error signature', () => {
    const msg = { channelId: 'connect', threadId: 'thread-1', userName: 'zen' };
    const first = providerFailureDedupeKey(msg, 'Provider down\nagain');
    const equivalent = providerFailureDedupeKey(msg, 'provider   down again');
    const differentThread = providerFailureDedupeKey({ ...msg, threadId: 'thread-2' }, 'provider down again');
    expect(first).toBe(equivalent);
    expect(first).not.toBe(differentThread);
  });
});
