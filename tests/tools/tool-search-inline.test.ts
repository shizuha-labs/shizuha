import { describe, it, expect } from 'vitest';
import {
  ToolSearchState,
  createToolSearchTool,
  modelNeedsInlineToolSchemas,
} from '../../src/tools/tool-search.js';
import type { DeferredToolInfo } from '../../src/tools/tool-search.js';
import type { ToolContext } from '../../src/tools/types.js';

const CTX = { cwd: '/tmp', sessionId: 's1' } as unknown as ToolContext;

const CATALOG: DeferredToolInfo[] = [
  {
    name: 'mcp__shizuha-pulse__pulse_list_workflows',
    description: 'List all Pulse workflows',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    serverName: 'shizuha-pulse',
  },
  {
    name: 'mcp__shizuha-pulse__pulse_create_task',
    description: 'Create a Pulse task',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    serverName: 'shizuha-pulse',
  },
];

function freshState(): ToolSearchState {
  const s = new ToolSearchState();
  s.setCatalog(CATALOG, [{ name: 'shizuha-pulse', description: 'tasks', toolCount: 2 }]);
  return s;
}

describe('modelNeedsInlineToolSchemas', () => {
  it('is true for self-hosted / OpenAI-compatible open models', () => {
    expect(modelNeedsInlineToolSchemas('cortex/GLM-4.7')).toBe(true);
    expect(modelNeedsInlineToolSchemas('vllm/GLM-4.7')).toBe(true);
    expect(modelNeedsInlineToolSchemas('ollama/qwen3.5')).toBe(true);
    expect(modelNeedsInlineToolSchemas('llamacpp/local')).toBe(true);
  });
  it('is false for hosted frontier providers (server-side expansion handles it)', () => {
    expect(modelNeedsInlineToolSchemas('claude-opus-4.6')).toBe(false);
    expect(modelNeedsInlineToolSchemas('gpt-5.5')).toBe(false);
    expect(modelNeedsInlineToolSchemas('')).toBe(false);
  });
});

describe('ToolSearch inline-schema mode (Codex-style)', () => {
  it('returns the full input JSON Schema inline when inlineSchemas is on', async () => {
    const state = freshState();
    const tool = createToolSearchTool(state, 5, { inlineSchemas: true });
    const res = await tool.execute({ query: 'pulse workflows', max_results: 3 }, CTX);
    expect(res.content).toContain('call one DIRECTLY by its exact name');
    expect(res.content).toContain('Input JSON Schema');
    expect(res.content).toContain('mcp__shizuha-pulse__pulse_list_workflows');
    // discovered marked so the tool is in the array next turn
    expect(state.getDiscovered().has('mcp__shizuha-pulse__pulse_list_workflows')).toBe(true);
  });

  it('returns the terse summary (no raw schema) when inlineSchemas is off', async () => {
    const state = freshState();
    const tool = createToolSearchTool(state, 5, { inlineSchemas: false });
    const res = await tool.execute({ query: 'pulse workflows', max_results: 3 }, CTX);
    expect(res.content).toContain('Call one of these discovered tools directly');
    expect(res.content).not.toContain('Input JSON Schema');
  });

  it('re-evaluates the inlineSchemas thunk per call (mid-session model switch)', async () => {
    const state = freshState();
    let inline = false;
    const tool = createToolSearchTool(state, 5, { inlineSchemas: () => inline });
    const off = await tool.execute({ query: 'pulse', max_results: 1 }, CTX);
    expect(off.content).not.toContain('Input JSON Schema');
    inline = true;
    const on = await tool.execute({ query: 'pulse', max_results: 1 }, CTX);
    expect(on.content).toContain('Input JSON Schema');
  });
});

describe('ToolSearchState.markDiscoveredFromHistory (resume re-derivation)', () => {
  it('re-marks a tool whose name appears in a prior ToolSearch result', () => {
    const state = freshState();
    expect(state.getDiscovered().size).toBe(0);
    const added = state.markDiscoveredFromHistory([
      { content: 'Found 1 tool: mcp__shizuha-pulse__pulse_list_workflows (shizuha-pulse)' },
    ]);
    expect(added).toBe(1);
    expect(state.getDiscovered().has('mcp__shizuha-pulse__pulse_list_workflows')).toBe(true);
  });

  it('re-marks a tool from a structured tool_use block in history', () => {
    const state = freshState();
    const added = state.markDiscoveredFromHistory([
      { content: [{ type: 'tool_use', name: 'mcp__shizuha-pulse__pulse_create_task', input: { title: 'x' } }] },
    ]);
    expect(added).toBe(1);
    expect(state.getDiscovered().has('mcp__shizuha-pulse__pulse_create_task')).toBe(true);
  });

  it('does not re-mark tools that are not in the catalog', () => {
    const state = freshState();
    const added = state.markDiscoveredFromHistory([
      { content: 'mentions mcp__other-service__do_thing which is unknown' },
    ]);
    expect(added).toBe(0);
    expect(state.getDiscovered().size).toBe(0);
  });

  it('is a no-op on an empty transcript', () => {
    const state = freshState();
    expect(state.markDiscoveredFromHistory([])).toBe(0);
  });
});
