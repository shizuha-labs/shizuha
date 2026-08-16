import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolDefinition } from '../../src/tools/types.js';
import { AgentProcess } from '../../src/gateway/agent-process.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// PLAT-4189 resume pin: a gateway restart re-composes the system prompt from
// volatile inputs (git status, memory, skill catalog) and re-discovers tools —
// so the provider payload head diverged at token 0 across every harness roll,
// cold-rebuilding warm multi-100K KV caches (agent-hiro/tora 2026-08-08).
// The pin re-adopts the byte-exact head the previous process last sent and
// defers the fresh composition to the next compaction.

const tool = (name: string, description = 'd'): ToolDefinition => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
});

function makeHarness(overrides: Record<string, unknown> = {}) {
  const saved: Array<{ sessionId: string; head: { model: string; systemPrompt: string; toolDefs: string } }> = [];
  const harness = {
    config: { agentId: 'a1', agentName: 'TestAgent' },
    model: 'DeepSeek-V4-Flash',
    sessionId: 'agent-session-a1',
    systemPrompt: 'fresh prompt\n\n---\n\n## Git Context\nBranch: main\nStatus:\nM new.ts',
    toolDefs: [tool('read_file'), tool('bash')],
    pendingPromptRefresh: null as null | { systemPrompt: string; toolDefs: ToolDefinition[] },
    store: {
      loadProviderPrefixHead: vi.fn(() => null as null | { createdAt: number; model: string; systemPrompt: string; toolDefs: string }),
      saveProviderPrefixHead: vi.fn((sessionId: string, head: { model: string; systemPrompt: string; toolDefs: string }) => {
        saved.push({ sessionId, head });
      }),
    },
    ...overrides,
  };
  return { harness, saved };
}

const runPin = (harness: unknown) =>
  (AgentProcess.prototype as unknown as { applyResumePromptPin: () => void })
    .applyResumePromptPin.call(harness);
const runAdopt = (harness: unknown, reason: string) =>
  (AgentProcess.prototype as unknown as { adoptPendingPromptRefresh: (reason: string) => void })
    .adoptPendingPromptRefresh.call(harness, reason);

describe('resume prompt pin (PLAT-4189)', () => {
  beforeEach(() => {
    delete process.env['SHIZUHA_RESUME_PROMPT_PIN'];
  });

  it('saves the fresh head on first run (no persisted head)', () => {
    const { harness, saved } = makeHarness();
    runPin(harness);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.head.systemPrompt).toBe(harness.systemPrompt);
    expect(harness.pendingPromptRefresh).toBeNull();
  });

  it('is a no-op on a byte-stable resume', () => {
    const { harness, saved } = makeHarness();
    harness.store.loadProviderPrefixHead = vi.fn(() => ({
      createdAt: 1,
      model: 'DeepSeek-V4-Flash',
      systemPrompt: harness.systemPrompt,
      toolDefs: JSON.stringify(harness.toolDefs),
    }));
    runPin(harness);
    expect(saved).toHaveLength(0);
    expect(harness.pendingPromptRefresh).toBeNull();
  });

  it('pins the persisted head when only volatile prompt bytes drifted (same tool names)', () => {
    const { harness, saved } = makeHarness();
    const pinnedPrompt = 'old prompt\n\n---\n\n## Git Context\nBranch: main\nStatus:\nM old.ts';
    const pinnedDefs = [tool('read_file', 'older description'), tool('bash')];
    harness.store.loadProviderPrefixHead = vi.fn(() => ({
      createdAt: 1,
      model: 'DeepSeek-V4-Flash',
      systemPrompt: pinnedPrompt,
      toolDefs: JSON.stringify(pinnedDefs),
    }));
    const freshPrompt = harness.systemPrompt;
    const freshDefs = harness.toolDefs;
    runPin(harness);
    expect(harness.systemPrompt).toBe(pinnedPrompt);
    expect(harness.toolDefs).toEqual(pinnedDefs);
    expect(harness.pendingPromptRefresh).toEqual({ systemPrompt: freshPrompt, toolDefs: freshDefs });
    expect(saved).toHaveLength(0); // head unchanged until refresh adopted
  });

  it('adopts the fresh head when the tool NAME set changed (real capability change)', () => {
    const { harness, saved } = makeHarness();
    harness.store.loadProviderPrefixHead = vi.fn(() => ({
      createdAt: 1,
      model: 'DeepSeek-V4-Flash',
      systemPrompt: 'old prompt',
      toolDefs: JSON.stringify([tool('read_file')]),
    }));
    const freshPrompt = harness.systemPrompt;
    runPin(harness);
    expect(harness.systemPrompt).toBe(freshPrompt);
    expect(harness.pendingPromptRefresh).toBeNull();
    expect(saved).toHaveLength(1);
  });

  it('adopts fresh on model change', () => {
    const { harness, saved } = makeHarness();
    harness.store.loadProviderPrefixHead = vi.fn(() => ({
      createdAt: 1,
      model: 'other-model',
      systemPrompt: 'old prompt',
      toolDefs: JSON.stringify(harness.toolDefs),
    }));
    runPin(harness);
    expect(harness.pendingPromptRefresh).toBeNull();
    expect(saved).toHaveLength(1);
  });

  it('is disabled by SHIZUHA_RESUME_PROMPT_PIN=0', () => {
    process.env['SHIZUHA_RESUME_PROMPT_PIN'] = '0';
    const { harness, saved } = makeHarness();
    harness.store.loadProviderPrefixHead = vi.fn(() => ({
      createdAt: 1,
      model: 'DeepSeek-V4-Flash',
      systemPrompt: 'old prompt',
      toolDefs: JSON.stringify(harness.toolDefs),
    }));
    runPin(harness);
    expect(harness.store.loadProviderPrefixHead).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('adoptPendingPromptRefresh swaps in the deferred composition and persists the new head', () => {
    const { harness, saved } = makeHarness();
    const freshDefs = [tool('read_file'), tool('bash')];
    harness.pendingPromptRefresh = { systemPrompt: 'deferred fresh prompt', toolDefs: freshDefs };
    runAdopt(harness, 'post_turn_compaction');
    expect(harness.systemPrompt).toBe('deferred fresh prompt');
    expect(harness.toolDefs).toEqual(freshDefs);
    expect(harness.pendingPromptRefresh).toBeNull();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.head.systemPrompt).toBe('deferred fresh prompt');
  });

  it('adoptPendingPromptRefresh is a no-op with nothing pending', () => {
    const { harness, saved } = makeHarness();
    const before = harness.systemPrompt;
    runAdopt(harness, 'post_turn_compaction');
    expect(harness.systemPrompt).toBe(before);
    expect(saved).toHaveLength(0);
  });
});
