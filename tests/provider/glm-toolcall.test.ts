import { describe, it, expect } from 'vitest';
import {
  extractGlmToolCalls,
  glmStreamedToolCallDeltasAreReal,
  GLM_OBSERVATION_TOKEN_ID,
  GLM_USER_EOS_TOKEN_ID,
  isGlmObservationStopToken,
  isGlmUserEosStopToken,
  classifyGlmToolsOfferedMiss,
  shouldTreatGlmStopAsDroppedToolCall,
  shouldSalvageGlmObservationNonStream,
  capGlmObservationSalvageMaxTokens,
  GLM_OBSERVATION_SALVAGE_MAX_TOKENS,
  collectGlmNonStreamToolCalls,
  filterSalvagedGlmToolCalls,
} from '../../src/provider/vllm.js';

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

  it('copies model-synthesized mash names verbatim — salvage is not an OpenAI-facade reassembly', () => {
    // Live salvage class: GLM mashed mcp__ + hyphenated server + short verb
    // because prompts taught both vocabularies. extractGlmToolCalls must not
    // "fix" that string; the origin fix is announce-exact / return-exact.
    const mash = 'mcp__shizuha-pulse-pulse-get-my-work';
    const r = extractGlmToolCalls(`<tool_call>${mash}</tool_call>`);
    expect(r.calls).toEqual([{ name: mash, args: {} }]);
  });

  it('extracts an unclosed tool_call that stopped on <|observation|>', () => {
    const r = extractGlmToolCalls(
      '<tool_call>mcp__shizuha-hive__hive_list_fleet_agents<|observation|>',
    );
    expect(r.calls).toEqual([{ name: 'mcp__shizuha-hive__hive_list_fleet_agents', args: {} }]);
  });

  it('discards salvaged pulse_get_my_work after prefetch, keeps other tools', () => {
    const { kept, discarded } = filterSalvagedGlmToolCalls(
      [
        { name: 'mcp__shizuha-pulse__pulse_get_my_work', args: {} },
        { name: 'mcp__shizuha-hive__hive_list_fleet_agents', args: {} },
      ],
      true,
    );
    expect(discarded).toEqual(['mcp__shizuha-pulse__pulse_get_my_work']);
    expect(kept.map((c) => c.name)).toEqual(['mcp__shizuha-hive__hive_list_fleet_agents']);
    expect(filterSalvagedGlmToolCalls(
      [{ name: 'mcp__shizuha-pulse__pulse_get_my_work', args: {} }],
      false,
    ).kept).toHaveLength(1);
  });

  it('extracts the live hive_list_fleet_agents zero-arg shape', () => {
    const r = extractGlmToolCalls(
      'Now pulling both vantages.\n<tool_call>mcp__shizuha-hive__hive_list_fleet_agents</tool_call>',
    );
    expect(r.calls).toEqual([{ name: 'mcp__shizuha-hive__hive_list_fleet_agents', args: {} }]);
  });

  it('does not treat empty streamed tool_calls arrays as real (vLLM #44104 / #44326)', () => {
    expect(glmStreamedToolCallDeltasAreReal(undefined)).toBe(false);
    expect(glmStreamedToolCallDeltasAreReal([])).toBe(false);
    expect(glmStreamedToolCallDeltasAreReal([{ function: { name: '', arguments: '' } }])).toBe(false);
    expect(glmStreamedToolCallDeltasAreReal([{ id: 'c1', function: { name: 'hive_list_fleet_agents', arguments: '' } }])).toBe(true);
  });

  it('treats GLM <|observation|> (154829) as a dropped tool turn, not a finished answer', () => {
    // Live shizuha1 2026-09-11: finish_reason=stop, stop_reason=154829, 15 eaten
    // tokens, empty tool_calls. vLLM-ascend #8327: the same token remaps to
    // tool_calls when the parser succeeds. vLLM #44326: non-stream parses
    // zero-arg inline calls that streaming drops. Do not disable streaming.
    expect(isGlmObservationStopToken(GLM_OBSERVATION_TOKEN_ID)).toBe(true);
    expect(isGlmObservationStopToken('154829')).toBe(true);
    expect(isGlmObservationStopToken(154820)).toBe(false); // <|endoftext|>
    expect(shouldTreatGlmStopAsDroppedToolCall({
      finishReason: 'stop',
      stopReasonTokenId: 154829,
      eatenTokens: 15,
      hasParsedTools: false,
      toolsOffered: true,
      isGlm: true,
    })).toBe(true);
    expect(shouldTreatGlmStopAsDroppedToolCall({
      finishReason: 'stop',
      stopReasonTokenId: 154820,
      eatenTokens: 15,
      hasParsedTools: false,
      toolsOffered: true,
      isGlm: true,
    })).toBe(true); // eaten-token fallback
    expect(shouldTreatGlmStopAsDroppedToolCall({
      finishReason: 'stop',
      stopReasonTokenId: 154820,
      eatenTokens: 2,
      hasParsedTools: false,
      toolsOffered: true,
      isGlm: true,
    })).toBe(false); // real conversational EOS
    expect(shouldTreatGlmStopAsDroppedToolCall({
      finishReason: 'stop',
      stopReasonTokenId: 154829,
      eatenTokens: 15,
      hasParsedTools: true,
      toolsOffered: true,
      isGlm: true,
    })).toBe(false);
    expect(shouldTreatGlmStopAsDroppedToolCall({
      finishReason: 'tool_calls',
      stopReasonTokenId: 154829,
      eatenTokens: 0,
      hasParsedTools: false,
      toolsOffered: true,
      isGlm: true,
    })).toBe(false);
  });

  it('does not fire a second generation for English-only observation stops', () => {
    expect(shouldSalvageGlmObservationNonStream({
      droppedObservation: true,
      accContentLen: 800,
      accReasoningLen: 200,
      eatenTokens: 0,
      hasToolMarkup: false,
    })).toBe(false);
    expect(shouldSalvageGlmObservationNonStream({
      droppedObservation: true,
      accContentLen: 0,
      accReasoningLen: 0,
      eatenTokens: 278,
      hasToolMarkup: false,
    })).toBe(true);
    expect(shouldSalvageGlmObservationNonStream({
      droppedObservation: true,
      accContentLen: 40,
      eatenTokens: 0,
      hasToolMarkup: true,
    })).toBe(true);
    // Saki 2026-09-13: English intent + 24 eaten, overlay recover=0.
    expect(shouldSalvageGlmObservationNonStream({
      droppedObservation: true,
      accContentLen: 255,
      accReasoningLen: 1164,
      eatenTokens: 24,
      hasToolMarkup: false,
    })).toBe(false);
    expect(capGlmObservationSalvageMaxTokens(32768)).toBe(GLM_OBSERVATION_SALVAGE_MAX_TOKENS);
    expect(capGlmObservationSalvageMaxTokens(64)).toBe(64);
  });

  it('splits repetition / <|user|> wrap-up from observation-drop dumps', () => {
    expect(isGlmUserEosStopToken(GLM_USER_EOS_TOKEN_ID)).toBe(true);
    expect(isGlmUserEosStopToken(154829)).toBe(false);
    expect(classifyGlmToolsOfferedMiss({
      finishReason: 'repetition',
      stopReasonTokenId: 'repetition_detected',
      eatenTokens: 0,
    })).toBe('repetition');
    expect(classifyGlmToolsOfferedMiss({
      finishReason: 'stop',
      stopReasonTokenId: 154827,
      eatenTokens: 0,
    })).toBe('user_eos');
    expect(classifyGlmToolsOfferedMiss({
      finishReason: 'length',
      eatenTokens: 0,
    })).toBe('length');
    expect(classifyGlmToolsOfferedMiss({
      finishReason: 'stop',
      stopReasonTokenId: 154829,
      eatenTokens: 24,
    })).toBe('observation_drop');
    expect(shouldTreatGlmStopAsDroppedToolCall({
      finishReason: 'repetition',
      stopReasonTokenId: 'repetition_detected',
      eatenTokens: 0,
      hasParsedTools: false,
      toolsOffered: true,
      isGlm: true,
    })).toBe(false);
    expect(shouldTreatGlmStopAsDroppedToolCall({
      finishReason: 'stop',
      stopReasonTokenId: 154827,
      eatenTokens: 0,
      hasParsedTools: false,
      toolsOffered: true,
      isGlm: true,
    })).toBe(false);
  });

  it('collects non-stream salvage tool_calls including leaked XML (vLLM #44326)', () => {
    const fromApi = collectGlmNonStreamToolCalls({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_1',
            function: { name: 'mcp__shizuha-hive__hive_list_fleet_agents', arguments: '{}' },
          }],
        },
      }],
    });
    expect(fromApi).toEqual([{
      id: 'call_1',
      name: 'mcp__shizuha-hive__hive_list_fleet_agents',
      args: {},
    }]);
    const fromXml = collectGlmNonStreamToolCalls({
      choices: [{
        message: {
          content: '<tool_call>mcp__shizuha-hive__hive_list_fleet_agents</tool_call>',
          tool_calls: [],
        },
      }],
    });
    expect(fromXml).toHaveLength(1);
    expect(fromXml[0]!.name).toBe('mcp__shizuha-hive__hive_list_fleet_agents');
    expect(fromXml[0]!.args).toEqual({});
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

// SCLI-6xx (operator 2026-09-18): a stream whose tool_calls deltas are ALL
// empty skeletons (index-only — vLLM variant shape) while the server claims
// finish_reason=tool_calls. The realness gate correctly rejects the skeletons
// (nothing to build); the skeleton-delta salvage must then recover the
// server-claimed call via one non-stream re-request of the SAME prompt
// (prefix-cached). Before the fix the turn died with an unfulfilled
// tool_calls claim → model retry loop.
describe('skeleton-delta salvage (SCLI-6xx)', () => {
  it('salvages a server-claimed tool call from all-skeleton deltas', async () => {
    const skeletonPayload = [
      { delta: { tool_calls: [{ index: 0 }] }, finish_reason: null },
      { delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '' } }] }, finish_reason: null },
      { delta: {}, finish_reason: 'tool_calls' },
    ].map((c) => `data: ${JSON.stringify({ choices: [c] })}\n\n`).join('') + 'data: [DONE]\n\n';
    const nonStream = {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_sk', type: 'function', function: { name: 'glm_probe', arguments: '{"q":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.stream === false) return Response.json(nonStream);
      return new Response(skeletonPayload, { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { VLlmProvider } = await import('../../src/provider/vllm.js');
    const provider = new VLlmProvider('http://localhost:8081', 500000);
    const options = {
      model: 'GLM-5.3-Flash',
      tools: [{ name: 'glm_probe', description: 'probe', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
    } as never;
    const toolUses: Array<{ name?: string; input?: unknown }> = [];
    let stop = '';
    for await (const c of provider.chat([{ role: 'user', content: 'probe' }] as never, options)) {
      if (c.type === 'tool_use_start') toolUses.push({ name: (c as { name?: string }).name });
      if (c.type === 'tool_use_end') toolUses.push({ input: (c as { input?: unknown }).input });
      if (c.type === 'stop_reason') stop = String((c as { reason?: string }).reason);
    }
    // The skeleton stream yielded nothing; the salvage recovered the call.
    expect(toolUses).toEqual([{ name: 'glm_probe' }, { input: { q: 'x' } }]);
    expect(stop).toBe('tool_calls');
    // Exactly one non-stream salvage of the same request.
    const nonStreamCalls = fetchMock.mock.calls.filter(([, init]) => {
      try { return JSON.parse(String((init as RequestInit).body)).stream === false; } catch { return false; }
    });
    expect(nonStreamCalls).toHaveLength(1);
  });
});
