import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolDefinition } from '../../src/tools/types.js';
import { AgentProcess, retainDeclaredMcpToolsOnRefresh } from '../../src/gateway/agent-process.js';
import { authoredCustomInstructions, DEFERRED_TOOL_INSTRUCTIONS } from '../../src/prompt/authored-instructions.js';
import { buildSystemPrompt, DYNAMIC_BOUNDARY_MARKER } from '../../src/prompt/builder.js';

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
    pendingAuthoredInstructionsRefresh: false,
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

  it('pins the persisted head when the tool NAME set shrinks (MCP still connecting)', () => {
    // agent-kei 2026-09-04: Hive liveness bounce → pulse/wiki/admin 90s
    // timeout → missing MCP tools looked like a capability change and the
    // pin adopted a fresh 149k-token head at 0% cache. A shrink is NOT
    // compaction; keep the previous tools[] until the next compaction.
    const { harness, saved } = makeHarness();
    const pinnedPrompt = 'old prompt';
    const pinnedDefs = [tool('read_file'), tool('mcp__shizuha-pulse__pulse_get_my_tasks')];
    harness.store.loadProviderPrefixHead = vi.fn(() => ({
      createdAt: 1,
      model: 'DeepSeek-V4-Flash',
      systemPrompt: pinnedPrompt,
      toolDefs: JSON.stringify(pinnedDefs),
    }));
    harness.toolDefs = [tool('read_file')];
    const freshPrompt = harness.systemPrompt;
    const freshDefs = harness.toolDefs;
    runPin(harness);
    expect(harness.systemPrompt).toBe(pinnedPrompt);
    expect(harness.toolDefs).toEqual(pinnedDefs);
    expect(harness.pendingPromptRefresh).toEqual({ systemPrompt: freshPrompt, toolDefs: freshDefs });
    expect(saved).toHaveLength(0);
  });

  it('pins the persisted head when the tool NAME set grows (ToolSearch/JIT)', () => {
    const { harness, saved } = makeHarness();
    const pinnedPrompt = 'old prompt';
    const pinnedDefs = [tool('read_file')];
    harness.store.loadProviderPrefixHead = vi.fn(() => ({
      createdAt: 1,
      model: 'DeepSeek-V4-Flash',
      systemPrompt: pinnedPrompt,
      toolDefs: JSON.stringify(pinnedDefs),
    }));
    harness.toolDefs = [tool('read_file'), tool('mcp__shizuha-admin__admin_consume_kubernetes_jit')];
    runPin(harness);
    expect(harness.systemPrompt).toBe(pinnedPrompt);
    expect(harness.toolDefs).toEqual(pinnedDefs);
    expect(harness.pendingPromptRefresh).not.toBeNull();
    expect(saved).toHaveLength(0);
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

describe('authored instructions refresh at semantic compaction', () => {
  const prompt = (authored: string, catalog = '', tail = 'working directory') => [
    'Base policy',
    ...(authored || catalog ? [`## Custom Instructions\n\n${authored}${catalog}`] : []),
    DYNAMIC_BOUNDARY_MARKER, `## Working Directory\n${tail}`,
  ].join('\n\n---\n\n');

  it.each([['old instructions', 'new instructions'], ['', 'new instructions'], ['old instructions', '']])(
    'pins changed instructions until compaction: %s to %s', (before, after) => {
      const { harness, saved } = makeHarness({ systemPrompt: prompt(after) });
      harness.store.loadProviderPrefixHead = vi.fn(() => ({
        createdAt: 1, model: harness.model,
        systemPrompt: prompt(before), toolDefs: JSON.stringify(harness.toolDefs),
      }));
      runPin(harness);
      expect(harness.pendingAuthoredInstructionsRefresh).toBe(true);
      expect(harness.systemPrompt).toBe(prompt(before));
      expect(saved).toHaveLength(0);
      runAdopt(harness, 'pre_turn_semantic_compaction');
      expect(harness.systemPrompt).toBe(prompt(after));
      expect(harness.pendingAuthoredInstructionsRefresh).toBe(false);
      harness.store.loadProviderPrefixHead = vi.fn(() => ({ createdAt: 2, ...saved[0]!.head }));
      runPin(harness);
      expect(harness.pendingAuthoredInstructionsRefresh).toBe(false);
    },
  );

  it.each(['unchanged authored instructions', ''])('ignores catalog and volatile drift with %s', (authored) => {
    const { harness } = makeHarness({ systemPrompt: prompt(authored, `${DEFERRED_TOOL_INSTRUCTIONS}\n\nAvailable sources:\n- **wiki**: Docs`, 'new directory') });
    harness.store.loadProviderPrefixHead = vi.fn(() => ({
      createdAt: 1, model: harness.model,
      systemPrompt: prompt(authored, `${DEFERRED_TOOL_INSTRUCTIONS}\n\nAvailable sources:\n- **pulse**: Tasks`),
      toolDefs: JSON.stringify(harness.toolDefs),
    }));
    runPin(harness);
    expect(harness.pendingPromptRefresh).not.toBeNull();
    expect(harness.pendingAuthoredInstructionsRefresh).toBe(false);
  });

  it('preserves authored headings and separators rather than hashing their generated-looking section name', () => {
    const authored = 'First rule\n\n---\n\nNested section\n\n## More Tools (via ToolSearch)\nMy own tool policy';
    expect(authoredCustomInstructions(prompt(authored, DEFERRED_TOOL_INSTRUCTIONS))).toBe(authored);
    expect(authoredCustomInstructions(prompt(authored))).toBe(authored);
    expect(authoredCustomInstructions(prompt(`${authored}${DEFERRED_TOOL_INSTRUCTIONS}\nThis is authored, not the generated suffix`)))
      .toBe(`${authored}${DEFERRED_TOOL_INSTRUCTIONS}\nThis is authored, not the generated suffix`);
  });

  it('recognizes authored instructions from the real full system prompt builder', async () => {
    const authored = 'Use message_user to deliver replies.\n\n---\n\n## More Tools\nPreserve this authored section.';
    const composed = await buildSystemPrompt({
      cwd: '/nonexistent/atlas-authored-instructions-test', tools: [],
      customPrompt: `${authored}${DEFERRED_TOOL_INSTRUCTIONS}\n\nAvailable sources:\n- **connect**: Messaging`,
    });
    expect(authoredCustomInstructions(composed)).toBe(authored);
    const withoutCustom = await buildSystemPrompt({ cwd: '/nonexistent/atlas-authored-instructions-test', tools: [] });
    expect(authoredCustomInstructions(withoutCustom)).toBe('');
  });
});

describe('retainDeclaredMcpToolsOnRefresh', () => {
  const defs = [
    tool('read_file'),
    tool('mcp__shizuha-pulse__pulse_get_my_tasks'),
    tool('mcp__shizuha-admin__admin_list_teams'),
  ];

  it('freezes tools[] on append-only models even when MCP names disappeared', () => {
    const live = new Set(['read_file', 'mcp__shizuha-pulse__pulse_get_my_tasks']);
    const result = retainDeclaredMcpToolsOnRefresh(defs, live, true);
    expect(result.toolDefs).toBe(defs);
    expect(result.removed).toBe(0);
  });

  it('drops evicted MCP tools on hosted/compat models', () => {
    const live = new Set(['read_file', 'mcp__shizuha-pulse__pulse_get_my_tasks']);
    const result = retainDeclaredMcpToolsOnRefresh(defs, live, false);
    expect(result.toolDefs.map((d) => d.name)).toEqual([
      'read_file',
      'mcp__shizuha-pulse__pulse_get_my_tasks',
    ]);
    expect(result.removed).toBe(1);
  });
});
