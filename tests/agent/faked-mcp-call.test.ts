import { describe, expect, it } from 'vitest';
import { detectFakedMcpToolCall } from '../../src/agent/turn.js';
import type { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolCall } from '../../src/agent/types.js';

/**
 * SCLI-20(b): coverage for detectFakedMcpToolCall — the guard that catches a
 * model echoing/printing an MCP tool name through bash instead of issuing a
 * real tool call. It must catch the bare echo while never misfiring on
 * legitimate shell work that happens to mention a tool name.
 */

const MCP_TOOLS = [
  'mcp__shizuha-pulse__pulse_list_workflows',
  'mcp__shizuha-pulse__pulse_get_task',
  'mcp__shizuha-wiki__wiki_search_pages',
];

// Minimal registry stub — detectFakedMcpToolCall only calls .list() and reads .name.
function makeRegistry(toolNames: string[]): ToolRegistry {
  return {
    list: () => toolNames.map((name) => ({ name })),
  } as unknown as ToolRegistry;
}

function bashCall(command: string, name = 'bash'): ToolCall {
  return { id: 't1', name, input: { command } };
}

describe('detectFakedMcpToolCall', () => {
  const registry = makeRegistry(MCP_TOOLS);

  it('catches a bare echo of a full MCP tool name', () => {
    expect(detectFakedMcpToolCall(bashCall('echo "mcp__shizuha-pulse__pulse_list_workflows"'), registry))
      .toBe('mcp__shizuha-pulse__pulse_list_workflows');
  });

  it('catches an unquoted echo of a full MCP tool name', () => {
    expect(detectFakedMcpToolCall(bashCall('echo mcp__shizuha-wiki__wiki_search_pages'), registry))
      .toBe('mcp__shizuha-wiki__wiki_search_pages');
  });

  it('catches a printf of a full MCP tool name', () => {
    expect(detectFakedMcpToolCall(bashCall('printf "mcp__shizuha-pulse__pulse_get_task"'), registry))
      .toBe('mcp__shizuha-pulse__pulse_get_task');
  });

  it('catches a bare-suffix mention ("Need to call <suffix>")', () => {
    expect(detectFakedMcpToolCall(bashCall('echo "Need to call pulse_list_workflows"'), registry))
      .toBe('mcp__shizuha-pulse__pulse_list_workflows');
  });

  it('reads the command from the `cmd` alias when `command` is absent', () => {
    const tc: ToolCall = { id: 't1', name: 'shell', input: { cmd: 'echo pulse_get_task' } };
    expect(detectFakedMcpToolCall(tc, registry)).toBe('mcp__shizuha-pulse__pulse_get_task');
  });

  it('ignores piped commands (real shell work)', () => {
    expect(detectFakedMcpToolCall(bashCall('echo "pulse_list_workflows" | grep pulse'), registry)).toBeNull();
  });

  it('ignores command substitution', () => {
    expect(detectFakedMcpToolCall(bashCall('echo $(pulse_list_workflows)'), registry)).toBeNull();
  });

  it('ignores chained / redirected commands', () => {
    expect(detectFakedMcpToolCall(bashCall('echo pulse_get_task && ls'), registry)).toBeNull();
    expect(detectFakedMcpToolCall(bashCall('echo pulse_get_task > /tmp/x'), registry)).toBeNull();
    expect(detectFakedMcpToolCall(bashCall('echo pulse_get_task; whoami'), registry)).toBeNull();
  });

  it('ignores echoes that do not mention any known tool', () => {
    expect(detectFakedMcpToolCall(bashCall('echo "hello world"'), registry)).toBeNull();
    expect(detectFakedMcpToolCall(bashCall('echo mcp__shizuha-pulse__pulse_does_not_exist'), registry)).toBeNull();
  });

  it('does not fire on non-bash/shell tools', () => {
    const tc: ToolCall = { id: 't1', name: 'write', input: { command: 'echo pulse_get_task' } };
    expect(detectFakedMcpToolCall(tc, registry)).toBeNull();
  });

  it('does not fire on a non-echo bash command', () => {
    expect(detectFakedMcpToolCall(bashCall('ls pulse_get_task'), registry)).toBeNull();
  });

  it('does not match short suffixes (<6 chars) to avoid false positives', () => {
    const reg = makeRegistry(['mcp__svc__go']);
    expect(detectFakedMcpToolCall(bashCall('echo "go now"'), reg)).toBeNull();
  });

  it('returns null when there are no MCP tools registered', () => {
    const reg = makeRegistry(['bash', 'read', 'write']);
    expect(detectFakedMcpToolCall(bashCall('echo pulse_list_workflows'), reg)).toBeNull();
  });

  it('returns null for an empty command', () => {
    expect(detectFakedMcpToolCall(bashCall(''), registry)).toBeNull();
  });
});
