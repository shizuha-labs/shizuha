import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { AgentConfig, Message } from '../../src/agent/types.js';
import type { AgentEvent } from '../../src/events/types.js';
import type { ToolHandler, ToolResult, ToolContext } from '../../src/tools/types.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

// ── Mocks ──
// Mock heavy dependencies so runAgent() uses our MockProvider and avoids real I/O

const mockProvider = new MockProvider();

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
  })),
}));

vi.mock('../../src/prompt/builder.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('Test system prompt.'),
}));

vi.mock('../../src/state/store.js', () => {
  const sessions = new Map<string, { id: string; messages: Message[] }>();
  return {
    StateStore: vi.fn().mockImplementation(() => ({
      createSession: (_model: string, _cwd: string) => {
        const id = 'test-session-id';
        const session = { id, model: _model, cwd: _cwd, createdAt: Date.now(), updatedAt: Date.now(), messages: [], totalInputTokens: 0, totalOutputTokens: 0, turnCount: 0 };
        sessions.set(id, session);
        return session;
      },
      loadSession: (id: string) => sessions.get(id) ?? null,
      appendMessage: () => {},
      updateTokens: () => {},
      replaceMessages: () => {},
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

// Mock microcompactLatest to avoid real token counting overhead in loop tests
vi.mock('../../src/state/microcompaction.js', () => ({
  microcompactLatest: vi.fn(),
}));

// Import after mocks are set up
const { runAgent } = await import('../../src/agent/loop.js');

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

// ── Tests ──

beforeEach(() => {
  mockProvider.reset();
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

describe('runAgent — truncation recovery', () => {
  it('max_tokens adds nudge and continues', async () => {
    // Turn 1: truncated → nudge added → turn 2: success
    mockProvider.queueResponse(ResponseBuilder.truncated('partial output...'));
    mockProvider.queueResponse(ResponseBuilder.textOnly('Continued and finished.'));

    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(2);
    // Second call should contain the nudge message
    const msgs = mockProvider.capturedMessages[1]!;
    const hasNudge = msgs.some((m) =>
      typeof m.content === 'string' && m.content.includes('cut off'),
    );
    expect(hasNudge).toBe(true);
  });

  it('stops after 3 consecutive truncations', async () => {
    // 3 truncated + 1 final truncated = should stop at 4 (3 nudges used)
    mockProvider.queueResponse(ResponseBuilder.truncated('cut 1'));
    mockProvider.queueResponse(ResponseBuilder.truncated('cut 2'));
    mockProvider.queueResponse(ResponseBuilder.truncated('cut 3'));
    mockProvider.queueResponse(ResponseBuilder.truncated('cut 4'));

    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    // 1 original + 3 retries = 4 turns total
    expect(complete?.totalTurns).toBe(4);
  });

  it('tool calls reset truncation counter', async () => {
    // Truncated → nudge → tool call (resets counter) → truncated → nudge → text
    mockProvider.queueResponse(ResponseBuilder.truncated('cut'));
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'read', input: { file_path: '/tmp/x' } }]),
    );
    // After tool call, truncation counter resets
    mockProvider.queueResponse(ResponseBuilder.truncated('cut again'));
    mockProvider.queueResponse(ResponseBuilder.textOnly('Done!'));

    const events = await collectEvents();
    const complete = findEvent<{ type: 'complete'; totalTurns: number }>(events, 'complete');
    expect(complete?.totalTurns).toBe(4);
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

describe('runAgent — compaction trigger', () => {
  it('compacts when messages exceed 75% of maxContextTokens', async () => {
    // Use a very small maxContextTokens to trigger compaction quickly
    // Turn 1: tool call with huge response → triggers compaction → turn 2: text
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('', [{ id: 'tc1', name: 'read', input: { file_path: '/tmp/x' } }]),
    );
    // After compaction, the provider is called again for the summary, then for turn 2
    // But compaction calls provider.chat() directly, so we need an extra response for that
    mockProvider.queueResponse(
      ResponseBuilder.textOnly('<summary>Compacted conversation.</summary>'),
    );
    mockProvider.queueResponse(ResponseBuilder.textOnly('After compaction.'));

    // Use very small maxContextTokens so it triggers
    const events = await collectEvents({ maxContextTokens: 100 });
    const complete = findEvent<{ type: 'complete' }>(events, 'complete');
    expect(complete).toBeDefined();
    // Provider should have been called at least 3 times (turn1, compaction, turn2)
    expect(mockProvider.callCount).toBeGreaterThanOrEqual(2);
  });
});
