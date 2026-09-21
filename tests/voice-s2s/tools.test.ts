import { describe, expect, it } from 'vitest';
import {
  advertiseVoiceS2STools,
  clipVoiceToolOutput,
  resolveVoiceS2SToolName,
  selectVoiceS2STools,
  shortVoiceToolName,
} from '../../src/voice-s2s/tools.js';

describe('voice S2S tool mapping', () => {
  it('shortens unique MCP names for the realtime function list', () => {
    expect(shortVoiceToolName('mcp__shizuha-pulse__pulse_get_my_tasks')).toBe('pulse_get_my_tasks');
    expect(shortVoiceToolName('bash')).toBe('bash');
  });

  it('keeps Pulse/wiki/hive/bash from the live registry and drops the rest', () => {
    const selected = selectVoiceS2STools([
      { name: 'bash', description: 'shell', inputSchema: { type: 'object', properties: {} } },
      { name: 'mcp__shizuha-pulse__pulse_get_my_tasks', description: 'queue', inputSchema: { type: 'object', properties: {} } },
      { name: 'mcp__shizuha-wiki__wiki_search_pages', description: 'wiki', inputSchema: { type: 'object', properties: {} } },
      { name: 'mcp__shizuha-hive__hive_get_agent_roster', description: 'roster', inputSchema: { type: 'object', properties: {} } },
      { name: 'apply_patch', description: 'edit', inputSchema: { type: 'object', properties: {} } },
    ], { profile: 'lean' });
    expect(selected.map((tool) => tool.name).sort()).toEqual([
      'bash',
      'hive_get_agent_roster',
      'pulse_get_my_tasks',
      'wiki_search_pages',
    ]);
    expect(advertiseVoiceS2STools(selected).every((tool) => tool.type === 'function')).toBe(true);
    expect(selectVoiceS2STools(selected, { profile: 'lean' }).map((tool) => tool.name)).toEqual(selected.map((tool) => tool.name));
  });

  it('keeps the coding Live floor on Desktop and drops Pulse/Wiki', () => {
    const selected = selectVoiceS2STools([
      { name: 'bash', description: 'shell', inputSchema: { type: 'object', properties: {} } },
      { name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } },
      { name: 'write', description: 'write', inputSchema: { type: 'object', properties: {} } },
      { name: 'edit', description: 'edit', inputSchema: { type: 'object', properties: {} } },
      { name: 'glob', description: 'glob', inputSchema: { type: 'object', properties: {} } },
      { name: 'grep', description: 'grep', inputSchema: { type: 'object', properties: {} } },
      { name: 'web_fetch', description: 'fetch', inputSchema: { type: 'object', properties: {} } },
      { name: 'mcp__shizuha-pulse__pulse_get_my_tasks', description: 'queue', inputSchema: { type: 'object', properties: {} } },
      { name: 'apply_patch', description: 'patch', inputSchema: { type: 'object', properties: {} } },
    ], { profile: 'code' });
    expect(selected.map((tool) => tool.name).sort()).toEqual([
      'bash',
      'edit',
      'glob',
      'grep',
      'read',
      'web_fetch',
      'write',
    ]);
  });

  it('resolves a short Live name back to the registry name', () => {
    const available = [
      'bash',
      'mcp__shizuha-pulse__pulse_get_user_tasks',
      'mcp__shizuha-wiki__wiki_get_page',
    ];
    expect(resolveVoiceS2SToolName(available, 'pulse_get_user_tasks'))
      .toBe('mcp__shizuha-pulse__pulse_get_user_tasks');
    expect(resolveVoiceS2SToolName(available, 'bash')).toBe('bash');
    expect(resolveVoiceS2SToolName(available, 'not_a_tool')).toBeNull();
  });

  it('clips huge tool payloads so spoken turns stay short', () => {
    expect(clipVoiceToolOutput('ok')).toBe('ok');
    expect(clipVoiceToolOutput('x'.repeat(9000)).endsWith('…(truncated)')).toBe(true);
  });
});
