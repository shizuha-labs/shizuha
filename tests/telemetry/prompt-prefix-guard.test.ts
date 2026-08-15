import { describe, expect, it } from 'vitest';
import { PromptPrefixGuard, promptPrefixGuardEnabled, type PromptPrefixPart } from '../../src/telemetry/prompt-prefix-guard.js';

function parts(model: string, tools: string, messages: string[]): PromptPrefixPart[] {
  return [
    { label: 'model', partClass: 'model', content: model },
    { label: 'tools', partClass: 'tools', content: tools },
    ...messages.map((m, i): PromptPrefixPart => ({
      label: `message[${i}]`,
      partClass: i === 0 ? 'system' : 'message',
      content: m,
    })),
  ];
}

describe('PromptPrefixGuard', () => {
  it('reports first observation, then identical, then append', () => {
    const guard = new PromptPrefixGuard(64);
    const base = parts('m1', '[tools]', ['sys', 'hello', 'world']);
    expect(guard.observe('s1', base).status).toBe('first');
    expect(guard.observe('s1', base).status).toBe('identical');
    const appended = parts('m1', '[tools]', ['sys', 'hello', 'world', 'assistant-reply', 'tool-result']);
    expect(guard.observe('s1', appended).status).toBe('append');
  });

  it('append-only across chunk boundaries stays append (near-limit turn contract)', () => {
    // Small chunk size so the payload spans many chunks — simulates a
    // near-context-limit session where the serialized prompt is >> one chunk.
    const guard = new PromptPrefixGuard(128);
    const history = Array.from({ length: 50 }, (_, i) => `message number ${i} with some padding content`);
    expect(guard.observe('s1', parts('m', 'T', history)).status).toBe('first');
    // Two consecutive "turns", each appending an assistant + tool-result pair.
    const turn2 = [...history, 'assistant tool_call{...}', 'tool_result{...}'];
    const obs2 = guard.observe('s1', parts('m', 'T', turn2));
    expect(obs2.status).toBe('append');
    const turn3 = [...turn2, 'assistant final answer', 'user follow-up'];
    const obs3 = guard.observe('s1', parts('m', 'T', turn3));
    expect(obs3.status).toBe('append');
    expect(obs3.chunkCount).toBeGreaterThan(2);
  });

  it('detects a head mutation and attributes the owning part', () => {
    const guard = new PromptPrefixGuard(64);
    const history = Array.from({ length: 20 }, (_, i) => `message number ${i} with some padding content`);
    guard.observe('s1', parts('m', 'T', history));
    const mutated = [...history];
    mutated[0] = 'REWRITTEN system prompt content';
    const obs = guard.observe('s1', parts('m', 'T', mutated));
    expect(obs.status).toBe('divergent');
    expect(obs.firstDivergentChunk).toBe(0);
    expect(obs.divergentPartClass).toBe('system');
  });

  it('detects a mid-history mutation with the correct chunk index and message label', () => {
    const guard = new PromptPrefixGuard(64);
    const history = Array.from({ length: 30 }, (_, i) => `message number ${i} with some padding content`);
    guard.observe('s1', parts('m', 'T', history));
    const mutated = [...history];
    mutated[15] = 'message number 15 with EDITED padding content';
    const obs = guard.observe('s1', parts('m', 'T', mutated));
    expect(obs.status).toBe('divergent');
    expect(obs.firstDivergentChunk).toBeGreaterThan(0);
    // Per-part hashes give exact attribution to the edited message.
    expect(obs.divergentPart).toBe('message[15]');
    expect(obs.divergentPartClass).toBe('message');
  });

  it('detects tool-schema changes (mid-session MCP tool activation)', () => {
    const guard = new PromptPrefixGuard(64);
    const history = ['sys', 'hello'];
    guard.observe('s1', parts('m', '[{"name":"read"}]', history));
    const obs = guard.observe('s1', parts('m', '[{"name":"read"},{"name":"pulse_get_my_tasks"}]', history));
    expect(obs.status).toBe('divergent');
    expect(obs.divergentPartClass).toBe('tools');
  });

  it('detects truncation (history shrink)', () => {
    const guard = new PromptPrefixGuard(64);
    const history = Array.from({ length: 40 }, (_, i) => `message number ${i} with some padding content`);
    guard.observe('s1', parts('m', 'T', history));
    const obs = guard.observe('s1', parts('m', 'T', history.slice(0, 5)));
    expect(obs.status).toBe('divergent');
  });

  it('compaction-shaped turn is exactly one divergence, then appends are stable again', () => {
    const guard = new PromptPrefixGuard(64);
    const history = Array.from({ length: 30 }, (_, i) => `message number ${i} with some padding content`);
    guard.observe('s1', parts('m', 'T', history));
    // Compaction rewrites history to summary + tail: ONE expected divergence...
    const compacted = ['sys', '[Conversation Summary] ...', 'ack', history[28]!, history[29]!];
    expect(guard.observe('s1', parts('m', 'T', compacted)).status).toBe('divergent');
    // ...and the very next turns must be pure appends again.
    const next = [...compacted, 'assistant reply'];
    expect(guard.observe('s1', parts('m', 'T', next)).status).toBe('append');
    expect(guard.observe('s1', parts('m', 'T', [...next, 'tool result'])).status).toBe('append');
  });

  it('separates sessions and bounds tracked state (LRU)', () => {
    const guard = new PromptPrefixGuard(64, 2);
    guard.observe('a', parts('m', 'T', ['1']));
    guard.observe('b', parts('m', 'T', ['1']));
    guard.observe('c', parts('m', 'T', ['1'])); // evicts 'a' (capacity 2)
    expect(guard.observe('a', parts('m', 'T', ['1'])).status).toBe('first');
    // 'c' stayed resident through the re-observation of 'a' (which evicted 'b').
    expect(guard.observe('c', parts('m', 'T', ['1'])).status).toBe('identical');
  });

  it('moving bytes across part boundaries is NOT append-only (separator integrity)', () => {
    const guard = new PromptPrefixGuard(64);
    guard.observe('s1', parts('m', 'T', ['abc', 'def']));
    // Same concatenated bytes, different message split — must diverge.
    const obs = guard.observe('s1', parts('m', 'T', ['abcd', 'ef']));
    expect(obs.status).toBe('divergent');
  });

  it('env gate defaults ON and honors explicit off values', () => {
    expect(promptPrefixGuardEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(promptPrefixGuardEnabled({ SHIZUHA_PROMPT_PREFIX_GUARD: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(promptPrefixGuardEnabled({ SHIZUHA_PROMPT_PREFIX_GUARD: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(promptPrefixGuardEnabled({ SHIZUHA_PROMPT_PREFIX_GUARD: 'off' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(promptPrefixGuardEnabled({ SHIZUHA_PROMPT_PREFIX_GUARD: 'false' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});
