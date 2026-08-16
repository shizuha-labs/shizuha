/**
 * Family co-activation on deferred-tool select (2026-07-14).
 *
 * Every mid-session tool activation rewrites the prompt-head tools array and
 * busts the vLLM prefix cache (~50-60s full re-prefill at 100K+ contexts).
 * Agents discover tool FAMILIES across consecutive turns (observed: agent-jun
 * activated wiki upload_attachment, then download_attachment, then
 * get_attachment on three successive turns = three 57s breaks). Selecting one
 * tool now co-activates its deferred same-server siblings sharing a
 * non-generic name token, so the family lands in ONE schema change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  toolSearchTool,
  setDeferredTools,
  setOnToolResolved,
} from '../../src/tools/builtin/tool-search.js';
import type { ToolDefinition, ToolContext } from '../../src/tools/types.js';

const ctx = {} as ToolContext;

function def(name: string): ToolDefinition {
  return { name, description: `tool ${name}`, parameters: { type: 'object', properties: {} } } as unknown as ToolDefinition;
}

function setup(names: string[]) {
  const tools = new Map<string, ToolDefinition>();
  const schemas = new Map<string, Record<string, unknown>>();
  for (const n of names) {
    tools.set(n, def(n));
    schemas.set(n, { description: `tool ${n}`, inputSchema: { type: 'object' } });
  }
  setDeferredTools(tools, schemas);
  const activated: string[] = [];
  setOnToolResolved((d: ToolDefinition) => activated.push(d.name));
  return activated;
}

describe('ToolSearch family co-activation', () => {
  beforeEach(() => {
    setOnToolResolved(() => {});
  });

  it('co-activates same-server siblings sharing a name token', async () => {
    const activated = setup([
      'mcp__shizuha-wiki__wiki_upload_attachment',
      'mcp__shizuha-wiki__wiki_download_attachment',
      'mcp__shizuha-wiki__wiki_get_attachment',
      'mcp__shizuha-wiki__wiki_create_page',        // no shared non-generic token
      'mcp__shizuha-pulse__pulse_get_attachment',   // different server
    ]);
    const res = await toolSearchTool.execute(
      { query: 'select:mcp__shizuha-wiki__wiki_upload_attachment' }, ctx);
    // selected tool + the two attachment siblings; NOT create_page, NOT other server
    expect(activated).toContain('mcp__shizuha-wiki__wiki_upload_attachment');
    expect(activated).toContain('mcp__shizuha-wiki__wiki_download_attachment');
    expect(activated).toContain('mcp__shizuha-wiki__wiki_get_attachment');
    expect(activated).not.toContain('mcp__shizuha-wiki__wiki_create_page');
    expect(activated).not.toContain('mcp__shizuha-pulse__pulse_get_attachment');
    // the model is told the family is already callable
    expect(String(res.content)).toContain('Also activated');
  });

  it('caps co-activation to bound the context cost', async () => {
    const family = Array.from({ length: 14 }, (_, i) => `mcp__books__books_voucher_step${i}`);
    const activated = setup(['mcp__books__books_voucher_main', ...family]);
    await toolSearchTool.execute({ query: 'select:mcp__books__books_voucher_main' }, ctx);
    // 1 selected + at most 8 co-activated
    expect(activated.length).toBeLessThanOrEqual(9);
    expect(activated[0]).toBe('mcp__books__books_voucher_main');
  });

  it('generic-only suffixes do not fan out', async () => {
    const activated = setup([
      'mcp__mail__get_all',      // suffix tokens all generic → no family
      'mcp__mail__list_all',
      'mcp__mail__send_email',
    ]);
    await toolSearchTool.execute({ query: 'select:mcp__mail__get_all' }, ctx);
    expect(activated).toEqual(['mcp__mail__get_all']);
  });

  it('keyword search explains immediate in-message activation', async () => {
    setup(['mcp__wiki__wiki_upload_attachment', 'mcp__wiki__wiki_download_attachment']);
    const res = await toolSearchTool.execute({ query: 'attachment' }, ctx);
    expect(String(res.content)).toContain('select:');
    // Append-only activation: selected tools are usable directly from the
    // returned schema — no prompt-head mutation, so no batching pressure.
    expect(String(res.content)).toContain('ACTIVE immediately');
  });
});
