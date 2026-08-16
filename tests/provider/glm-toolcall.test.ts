import { describe, it, expect } from 'vitest';
import { extractGlmToolCalls } from '../../src/provider/vllm.js';

// GLM-4.7 emits tool calls in its native format
//   <tool_call>NAME<arg_key>K</arg_key><arg_value>V</arg_value>...</tool_call>
// The vLLM glm47 parser sometimes leaks these as raw tokens instead of OpenAI
// tool_calls; extractGlmToolCalls recovers them client-side so the scaffold can
// still dispatch the real tool. These tests pin that recovery.

describe('extractGlmToolCalls', () => {
  it('returns no calls and unchanged text when there is no tool_call markup', () => {
    const r = extractGlmToolCalls('just a normal answer');
    expect(r.calls).toEqual([]);
    expect(r.clean).toBe('just a normal answer');
  });

  it('extracts a tool call with no arguments', () => {
    const r = extractGlmToolCalls('<tool_call>mcp__shizuha-pulse__pulse_list_workflows</tool_call>');
    expect(r.calls).toEqual([{ name: 'mcp__shizuha-pulse__pulse_list_workflows', args: {} }]);
    expect(r.clean).toBe('');
  });

  it('extracts name + typed arguments (JSON-parsed values)', () => {
    const text =
      '<tool_call>mcp__shizuha-pulse__pulse_create_task' +
      '<arg_key>title</arg_key><arg_value>"Fix bug"</arg_value>' +
      '<arg_key>priority</arg_key><arg_value>"high"</arg_value>' +
      '<arg_key>count</arg_key><arg_value>3</arg_value>' +
      '</tool_call>';
    const r = extractGlmToolCalls(text);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.name).toBe('mcp__shizuha-pulse__pulse_create_task');
    expect(r.calls[0]!.args).toEqual({ title: 'Fix bug', priority: 'high', count: 3 });
  });

  it('keeps a non-JSON arg value as a raw string', () => {
    const text = '<tool_call>x<arg_key>q</arg_key><arg_value>not json</arg_value></tool_call>';
    const r = extractGlmToolCalls(text);
    expect(r.calls[0]!.args).toEqual({ q: 'not json' });
  });

  it('extracts multiple tool calls and strips them from clean text', () => {
    const text =
      'thinking...\n<tool_call>a</tool_call>\nmore\n<tool_call>b<arg_key>k</arg_key><arg_value>1</arg_value></tool_call>';
    const r = extractGlmToolCalls(text);
    expect(r.calls.map((c) => c.name)).toEqual(['a', 'b']);
    expect(r.calls[1]!.args).toEqual({ k: 1 });
    expect(r.clean).not.toContain('<tool_call>');
  });
});
