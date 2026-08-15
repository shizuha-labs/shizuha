import { describe, expect, it } from 'vitest';
import {
  buildProviderPrefixSnapshot,
  compareProviderPrefixSnapshots,
  providerPrefixContinuityLogFields,
  providerPrefixContinuityLogMessage,
} from '../../src/telemetry/provider-prefix-continuity.js';
import type { ChatMessage } from '../../src/provider/types.js';
import type { ToolDefinition } from '../../src/tools/types.js';

const tools: ToolDefinition[] = [{
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}];

function snapshot(messages: ChatMessage[], overrides: { systemPrompt?: string; tools?: ToolDefinition[]; model?: string; contextWindow?: number } = {}) {
  return buildProviderPrefixSnapshot({
    model: overrides.model ?? 'DeepSeek-V4-Flash',
    contextWindow: overrides.contextWindow ?? 262144,
    systemPrompt: overrides.systemPrompt ?? 'You are Shizuha.',
    tools: overrides.tools ?? tools,
    chatMessages: messages,
    createdAt: 123,
  });
}

describe('provider prefix continuity', () => {
  it('persists provider payload prefix metadata', () => {
    const fp = snapshot([{ role: 'user', content: 'hi' }]);
    expect(fp.model).toBe('DeepSeek-V4-Flash');
    expect(fp.contextWindow).toBe(262144);
    expect(fp.systemPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fp.toolSchemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fp.systemToolPrefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fp.canonicalMessagePrefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fp.totalMessageCount).toBe(1);
    expect(fp.chatMessageCount).toBe(1);
  });

  it('treats an appended transcript as cache-continuity preserving and logs the stable prior prefix hash', () => {
    const prev = snapshot([{ role: 'user', content: 'hi' }]);
    const next = snapshot([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'continue' },
    ]);

    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.appendOnly).toBe(true);
    expect(result.cacheBreaking).toBe(false);
    expect(result.reasons).toEqual(['append-only']);
    expect(result.currentPriorMessagePrefixHash).toBe(prev.canonicalMessagePrefixHash);
    expect(providerPrefixContinuityLogFields(result)).toMatchObject({
      append_only: true,
      stable_prior_prefix_hash: prev.canonicalMessagePrefixHash,
      previous_prefix_hash: prev.canonicalMessagePrefixHash,
    });
    expect(providerPrefixContinuityLogMessage(result)).toContain('append_only=true');
    expect(providerPrefixContinuityLogMessage(result)).toContain(prev.canonicalMessagePrefixHash);
  });

  it('classifies compaction payload rewrites as explicit cache breaks', () => {
    const prev = snapshot([
      { role: 'user', content: 'original request' },
      { role: 'assistant', content: 'partial answer' },
    ]);
    const next = snapshot([
      { role: 'user', content: '[Conversation Summary]\ncompacted' },
      { role: 'assistant', content: 'ready' },
      { role: 'user', content: 'continue' },
    ]);

    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.cacheBreaking).toBe(true);
    expect(result.appendOnly).toBe(false);
    expect(result.primaryReason).toBe('compaction');
    expect(result.reasons).toContain('compaction');
    expect(result.firstMessageMismatchIndex).toBe(0);
    expect(providerPrefixContinuityLogMessage(result)).toContain('append_only=false reason=compaction');
  });

  it('treats loop-guard stop messages as append-only cache-preserving events', () => {
    const prev = snapshot([
      { role: 'user', content: 'check CTX-331 comments' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"pulse_update_task"}' } }] },
      { role: 'tool', tool_call_id: 'tool-1', content: 'Pulse API rejected reason_category' },
    ]);
    const next = snapshot([
      { role: 'user', content: 'check CTX-331 comments' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"pulse_update_task"}' } }] },
      { role: 'tool', tool_call_id: 'tool-1', content: 'Pulse API rejected reason_category' },
      { role: 'assistant', content: 'Stopped: `bash` was called 6 times with identical input. The result is already in the transcript.' },
    ]);

    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.appendOnly).toBe(true);
    expect(result.cacheBreaking).toBe(false);
    expect(result.reasons).toEqual(['append-only']);
  });

  it('detects prompt-head rewrites from compaction, trimming, or sanitization', () => {
    const prev = snapshot([
      { role: 'user', content: 'original request' },
      { role: 'assistant', content: 'partial answer' },
    ]);
    const next = snapshot([
      { role: 'user', content: '[Conversation Summary]\ncompacted' },
      { role: 'assistant', content: 'ready' },
      { role: 'user', content: 'continue' },
    ]);

    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.cacheBreaking).toBe(true);
    expect(result.appendOnly).toBe(false);
    expect(result.primaryReason).toBe('compaction');
    expect(result.reasons).toContain('compaction');
    expect(result.firstMessageMismatchIndex).toBe(0);
    expect(providerPrefixContinuityLogMessage(result)).toContain('append_only=false reason=compaction');
  });

  it('classifies emergency trims as explicit cache breaks', () => {
    const prev = snapshot([
      { role: 'user', content: 'original request' },
      { role: 'assistant', content: 'partial answer' },
      { role: 'user', content: 'more detail' },
    ]);
    const next = snapshot([
      { role: 'user', content: '[System Notice] Context budget reset dropped 2 older persisted message(s).' },
      { role: 'user', content: 'more detail' },
    ]);

    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.cacheBreaking).toBe(true);
    expect(result.primaryReason).toBe('emergency-trim');
    expect(result.reasons).toContain('emergency-trim');
  });

  it('classifies sanitized or reordered messages when provider message hashes are rewritten without known markers', () => {
    const prev = snapshot([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    const next = snapshot([
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'c' },
    ]);

    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.cacheBreaking).toBe(true);
    expect(result.primaryReason).toBe('sanitized-or-reordered-messages');
    expect(result.reasons).toContain('sanitized-or-reordered-messages');
  });

  it('detects system, tool, and model changes separately', () => {
    const prev = snapshot([{ role: 'user', content: 'hi' }]);
    const next = buildProviderPrefixSnapshot({
      model: 'Qwen3.6-35B-A3B-NVFP4',
      contextWindow: 131072,
      systemPrompt: 'You are Shizuha with new instructions.',
      tools: [],
      chatMessages: [{ role: 'user', content: 'hi' }],
      createdAt: 124,
    });

    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.cacheBreaking).toBe(true);
    expect(result.reasons).toContain('model-changed');
    expect(result.reasons).toContain('system-prompt-changed');
    expect(result.reasons).toContain('tool-schema-changed');
    expect(result.removedTools).toEqual(['read_file']);
  });

  it('names the exact system-prompt section that diverged (PLAT-4189 restart forensics)', () => {
    const base = '# Base prompt\nstatic head'
      + '\n\n---\n\n## Custom Instructions\n\nbe good'
      + '\n\n---\n\n## Git Context\nBranch: main\nStatus:\nM file.ts'
      + '\n\n---\n\n## Available Tools\n\n- **read_file**: Read a file';
    const drifted = base.replace('M file.ts', 'M other.ts\nM third.ts');
    const prev = snapshot([{ role: 'user', content: 'hi' }], { systemPrompt: base });
    const next = snapshot([{ role: 'user', content: 'hi' }], { systemPrompt: drifted });

    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.cacheBreaking).toBe(true);
    expect(result.reasons).toContain('system-prompt-changed');
    expect(result.changedSystemPromptSections).toEqual(['## Git Context']);
    expect(providerPrefixContinuityLogFields(result)).toMatchObject({
      changed_system_prompt_sections: ['## Git Context'],
    });
  });

  it('labels added and removed trailing sections', () => {
    const prev = snapshot([{ role: 'user', content: 'hi' }], {
      systemPrompt: 'head\n\n---\n\n## Skill Catalog\n\nx',
    });
    const next = snapshot([{ role: 'user', content: 'hi' }], {
      systemPrompt: 'head\n\n---\n\n## Skill Catalog\n\nx\n\n---\n\n## Project Memory\n\ny',
    });
    const result = compareProviderPrefixSnapshots(prev, next);
    expect(result.changedSystemPromptSections).toEqual(['added: ## Project Memory']);
  });
});
