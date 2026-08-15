import { afterEach, describe, expect, it } from 'vitest';
import { SkillRegistry } from '../../src/skills/registry.js';
import {
  LEAN_CONVERSATIONAL_MCP,
  LEAN_CONVERSATIONAL_MCP_TOOL_NAMES,
  isLeanConversationalEnv,
  leanConversationalSkillNames,
} from '../../src/platform/lean-conversational.js';
import { addExplicitlyMentionedMcpTools } from '../../src/gateway/agent-process.js';

describe('lean conversational seats', () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const key of ['SHIZUHA_LEAN_MCP', 'AGENT_TEAM', 'AGENT_USERNAME', 'AGENT_SKILLS']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  });

  function stash(key: string) {
    if (!(key in saved)) saved[key] = process.env[key];
  }

  it('detects CEO Office seats from env', () => {
    stash('SHIZUHA_LEAN_MCP');
    stash('AGENT_TEAM');
    stash('AGENT_USERNAME');
    delete process.env['SHIZUHA_LEAN_MCP'];
    delete process.env['AGENT_TEAM'];
    delete process.env['AGENT_USERNAME'];
    expect(isLeanConversationalEnv({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isLeanConversationalEnv({ SHIZUHA_LEAN_MCP: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isLeanConversationalEnv({ AGENT_TEAM: 'ceo-office' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isLeanConversationalEnv({ AGENT_USERNAME: 'hina' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isLeanConversationalEnv({ AGENT_USERNAME: 'yuna' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('keeps the skill catalog to the lean set', () => {
    const registry = new SkillRegistry();
    const stub = (name: string, description: string) => ({
      name,
      description,
      contentPath: `/tmp/${name}`,
      skillRoot: `/tmp/${name}`,
      source: 'project' as const,
      userInvocable: false,
      disableModelInvocation: false,
    });
    registry.registerAll([
      stub('personal-assistant', 'PA'),
      stub('kubernetes', 'k8s'),
      stub('skill-loader', 'load'),
    ]);
    const catalog = registry.buildCatalog(undefined, undefined, leanConversationalSkillNames({} as NodeJS.ProcessEnv));
    expect(catalog).toContain('personal-assistant');
    expect(catalog).toContain('skill-loader');
    expect(catalog).not.toContain('kubernetes');
    expect(LEAN_CONVERSATIONAL_MCP).toEqual(['pulse', 'connect', 'wiki']);
  });

  it('declares a stable Pulse work head so SuperGrok can actually work', () => {
    const names = [...LEAN_CONVERSATIONAL_MCP_TOOL_NAMES];
    expect(names).toContain('mcp__shizuha-pulse__pulse_get_my_tasks');
    expect(names).toContain('mcp__shizuha-pulse__pulse_get_my_alerts');
    expect(names).toContain('mcp__shizuha-pulse__pulse_get_task');
    expect(names).toContain('mcp__shizuha-pulse__pulse_execute_transition');
    expect(names).toContain('mcp__shizuha-connect__message_user');
    expect(names.some((name) => name.includes('__admin') || name.includes('__id') || name.includes('__scs'))).toBe(false);
    expect(names).toEqual([...names].sort());
  });

  it('does not rewrite the tool head when a heartbeat names Pulse tools already in the lean set', () => {
    // Production sequence: lean setup activates LEAN_CONVERSATIONAL_MCP_TOOL_NAMES,
    // then a later heartbeat message mentions pulse_get_my_alerts/tasks.
    // Those names must be a no-op so SuperGrok tools[] stays byte-stable.
    const active = LEAN_CONVERSATIONAL_MCP_TOOL_NAMES.map((name) => ({ name }));
    const all = [
      ...active,
      { name: 'mcp__shizuha-pulse__pulse_stats' },
      { name: 'mcp__shizuha-admin__admin_list_teams' },
    ];
    const mentioned = [
      'mcp__shizuha-pulse__pulse_get_my_alerts',
      'mcp__shizuha-pulse__pulse_get_my_tasks',
    ];
    const first = addExplicitlyMentionedMcpTools(active, all, mentioned);
    const second = addExplicitlyMentionedMcpTools(first.toolDefs, all, mentioned);
    expect(first.added).toEqual([]);
    expect(second.added).toEqual([]);
    expect(first.toolDefs.map((d) => d.name)).toEqual(active.map((d) => d.name));
    expect(second.toolDefs.map((d) => d.name)).toEqual(first.toolDefs.map((d) => d.name));
  });
});
