import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { detectFakedMcpToolCall } from '../../src/agent/turn.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolHandler } from '../../src/tools/types.js';
import type { ToolCall } from '../../src/agent/types.js';

// Guards the "faked MCP tool call" interceptor: weaker open models (e.g. GLM-4.7)
// sometimes run `bash echo "<toolname>"` instead of emitting a real MCP tool call,
// then imitate that pattern until the loop-guard stops them. detectFakedMcpToolCall
// catches a PURE echo/printf of a known tool name so the loop can correct it.

function handler(name: string): ToolHandler {
  return {
    name,
    description: 'test',
    parameters: z.object({}),
    readOnly: true,
    riskLevel: 'low',
    execute: async () => ({ toolUseId: '', content: '' }),
  };
}

function registryWith(...names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  r.register({ ...handler('bash'), parameters: z.object({ command: z.string() }), riskLevel: 'high', readOnly: false });
  for (const n of names) r.register(handler(n));
  return r;
}

function bash(command: string): ToolCall {
  return { id: 't1', name: 'bash', input: { command } };
}

describe('detectFakedMcpToolCall', () => {
  const PULSE = 'mcp__shizuha-pulse__pulse_list_workflows';

  it('detects an echo of the full mcp__ tool name', () => {
    const r = registryWith(PULSE);
    expect(detectFakedMcpToolCall(bash(`echo "${PULSE}"`), r)).toBe(PULSE);
  });

  it('detects an echo of the bare tool suffix', () => {
    const r = registryWith(PULSE);
    expect(detectFakedMcpToolCall(bash('echo "Need to call pulse_list_workflows"'), r)).toBe(PULSE);
  });

  it('detects printf as well as echo', () => {
    const r = registryWith(PULSE);
    expect(detectFakedMcpToolCall(bash(`printf "${PULSE}"`), r)).toBe(PULSE);
  });

  it('returns null when the referenced tool is not registered', () => {
    const r = registryWith(); // no mcp tools registered
    expect(detectFakedMcpToolCall(bash(`echo "${PULSE}"`), r)).toBeNull();
  });

  it('does NOT fire on real shell work that happens to mention a tool name', () => {
    const r = registryWith(PULSE);
    // pipes / redirects / chaining / subshells = real work, never a faked call
    expect(detectFakedMcpToolCall(bash(`echo "${PULSE}" | grep pulse`), r)).toBeNull();
    expect(detectFakedMcpToolCall(bash(`echo "${PULSE}" > out.txt`), r)).toBeNull();
    expect(detectFakedMcpToolCall(bash(`echo "${PULSE}" && ls`), r)).toBeNull();
    expect(detectFakedMcpToolCall(bash(`echo $(${PULSE})`), r)).toBeNull();
  });

  it('does NOT fire on an unrelated echo', () => {
    const r = registryWith(PULSE);
    expect(detectFakedMcpToolCall(bash('echo "hello world"'), r)).toBeNull();
  });

  it('ignores non-bash tools', () => {
    const r = registryWith(PULSE);
    expect(detectFakedMcpToolCall({ id: 't1', name: 'read', input: { file_path: '/x' } }, r)).toBeNull();
  });

  it('ignores too-short suffixes to avoid false positives', () => {
    const r = registryWith('mcp__svc__go'); // suffix "go" is < 6 chars
    expect(detectFakedMcpToolCall(bash('echo "go run it"'), r)).toBeNull();
  });
});
