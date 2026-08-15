/**
 * SCLI-22: TTFT rolling watchdog unit tests.
 *
 * Verifies the warning-once-per-episode logic in loop.ts:
 *   - Window not full → no warn
 *   - Avg > threshold, window full → exactly one WarningEvent per episode
 *   - Recovery (avg drops) → flag resets, next episode re-emits
 *   - NaN env var (TTFT_WATCHDOG_WINDOW=abc) → falls back to default (5)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig, Message } from '../../src/agent/types.js';
import type { AgentEvent } from '../../src/events/types.js';
import type { WarningEvent } from '../../src/events/types.js';
import { MockProvider, ResponseBuilder } from '../helpers/mock-provider.js';

// ── PerfTimer mock — lets each test inject specific ttftMs values ──
vi.mock('../../src/utils/perf-metrics.js', () => ({
  PerfTimer: vi.fn(),
  formatPerfStatus: vi.fn().mockReturnValue(''),
  ttftWarnThresholdMs: vi.fn().mockReturnValue(8000),
}));

import * as perfMod from '../../src/utils/perf-metrics.js';

// ── All other heavy-dependency mocks (same as loop.test.ts) ──
const mockProvider = new MockProvider();

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    agent: { defaultModel: 'test-model', cwd: '/tmp', maxTurns: 20, maxContextTokens: 200000, temperature: 0, maxOutputTokens: 16384 },
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

const { runAgent } = await import('../../src/agent/loop.js');

// ── Helpers ──

function makeFakePerfTimer(ttftMs: number | null) {
  return {
    markFirstChunk: vi.fn(),
    finish: vi.fn().mockReturnValue({
      ttftMs,
      provider: 'mock',
      model: 'test-model',
      decodeTokensPerSec: null,
      cacheHitRate: null,
    }),
    snapshot: vi.fn().mockReturnValue({}),
  };
}

async function collectWithTtft(ttftValues: (number | null)[]): Promise<AgentEvent[]> {
  // Use tool-call responses for all but the last turn so the loop continues.
  // The loop exits when the LLM returns text with no tool calls (last response).
  // Unknown tool 'noop' produces a tool_result error which is fine — loop still
  // sees toolCalls.length > 0 and queues another turn.
  for (let i = 0; i < ttftValues.length - 1; i++) {
    // Unique input per turn so toolCallSignature differs each turn and the
    // repeated-call guard (REPEATED_TOOL_CALL_STOP_AT=6) never fires.
    mockProvider.queueResponse(
      ResponseBuilder.withToolCalls('...', [{ id: `tc${i}`, name: 'noop', input: { _turn: i } }]),
    );
  }
  mockProvider.queueResponse(ResponseBuilder.textOnly('done'));

  // Wire PerfTimer to return ttftValues in order (one PerfTimer instance per turn).
  let callIdx = 0;
  vi.mocked(perfMod.PerfTimer).mockImplementation(
    () => makeFakePerfTimer(ttftValues[callIdx++ % ttftValues.length]!) as any,
  );

  const config: AgentConfig = {
    model: 'test-model',
    cwd: '/tmp',
    maxTurns: ttftValues.length + 2,
    permissionMode: 'autonomous',
  };

  const events: AgentEvent[] = [];
  for await (const ev of runAgent(config)) {
    events.push(ev);
  }
  return events;
}

function warnings(events: AgentEvent[]): WarningEvent[] {
  return events.filter((e): e is WarningEvent => e.type === 'warning' && (e as WarningEvent).code === 'ttft_degraded');
}

// ── Tests ──

beforeEach(() => {
  mockProvider.reset();
  // Restore default env (3-turn window; 8000ms threshold via mocked ttftWarnThresholdMs)
  delete process.env['TTFT_WATCHDOG_WINDOW'];
  delete process.env['TTFT_WARN_THRESHOLD_MS'];
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env['TTFT_WATCHDOG_WINDOW'];
  delete process.env['TTFT_WARN_THRESHOLD_MS'];
});

describe('SCLI-22 TTFT watchdog', () => {
  it('no warning when window is not full (WINDOW_SIZE-1 slow turns)', async () => {
    // Window default = 5. Queue 4 slow turns (9000ms) — window never fills, no warn.
    process.env['TTFT_WARN_THRESHOLD_MS'] = '8000';
    process.env['TTFT_WATCHDOG_WINDOW'] = '5';
    const events = await collectWithTtft([9000, 9000, 9000, 9000]);
    expect(warnings(events)).toHaveLength(0);
  });

  it('emits exactly one warning per degradation episode (not one per turn)', async () => {
    // Window = 3, threshold = 8000. 5 slow turns — should warn exactly once.
    process.env['TTFT_WARN_THRESHOLD_MS'] = '8000';
    process.env['TTFT_WATCHDOG_WINDOW'] = '3';
    const events = await collectWithTtft([9000, 9000, 9000, 9000, 9000]);
    const w = warnings(events);
    expect(w).toHaveLength(1);
    expect(w[0]!.code).toBe('ttft_degraded');
    expect(w[0]!.message).toContain('TTFT');
  });

  it('resets degraded flag on recovery so next episode re-emits', async () => {
    // 3-turn window, threshold 8000ms.
    // Episode 1: 3 slow turns → warn once.
    // Recovery: 3 fast turns → flag clears (no additional warn).
    // Episode 2: 3 slow turns → warn again.
    process.env['TTFT_WARN_THRESHOLD_MS'] = '8000';
    process.env['TTFT_WATCHDOG_WINDOW'] = '3';
    const events = await collectWithTtft([
      9000, 9000, 9000,   // episode 1 — warn
      100,  100,  100,    // recovery
      9000, 9000, 9000,   // episode 2 — warn again
    ]);
    expect(warnings(events)).toHaveLength(2);
  });

  it('NaN env var (TTFT_WATCHDOG_WINDOW=abc) falls back to default (5)', async () => {
    // If the env var is invalid, _parseEnvInt returns the default 5.
    // 4 slow turns with default window=5 → no warning (window never fills).
    process.env['TTFT_WATCHDOG_WINDOW'] = 'abc';
    process.env['TTFT_WARN_THRESHOLD_MS'] = '8000';
    const events = await collectWithTtft([9000, 9000, 9000, 9000]);
    expect(warnings(events)).toHaveLength(0);
  });
});
