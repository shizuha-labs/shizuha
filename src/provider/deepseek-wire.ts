/**
 * Official DeepSeek chat-completions wire helpers.
 *
 * Ported from deepseek-ai/deepseek-harness `packages/llm/llm-deepseek`
 * (serialize.ts + thinking_mode.mdx), MIT. Not a Cordis adapter drop-in —
 * SCLI keeps VLlmProvider (DSML hold, Cortex affinity, GLM/Qwen).
 *
 * Reasoning passback (guides/thinking_mode § Tool Calls):
 *   - Tool-call assistant turns: reasoning_content MUST be replayed.
 *   - Tool-call-free turns: drop it. Hosted API ignores it; self-hosted
 *     templates may *render* it and contaminate long sessions ("Let me…").
 *
 * KV: omitting CoT on a finished non-tool turn only breaks prefix match
 * from that last assistant generation; earlier turns still hit if they
 * were also sent without CoT. Tool-round trips keep CoT so the in-flight
 * thought + cache stay aligned (and hosted DeepSeek 400s without it).
 */

export type DeepSeekReasoningPassback = 'always' | 'tool-call-turns';

export function shouldPassBackReasoning(
  policy: DeepSeekReasoningPassback | undefined,
  hasToolCalls: boolean,
): boolean {
  if (policy === 'tool-call-turns') return hasToolCalls;
  return true;
}

export function officialThinkingWire(options: {
  thinkingEnabled: boolean;
  effort?: string;
}): { thinking: { type: 'enabled' | 'disabled' }; reasoning_effort?: string } {
  if (!options.thinkingEnabled) {
    return { thinking: { type: 'disabled' } };
  }
  const effort = options.effort?.trim();
  // Official adapter never sends reasoning_effort: 'off'.
  if (!effort || effort === 'off' || effort === 'none') {
    return { thinking: { type: 'enabled' } };
  }
  return { thinking: { type: 'enabled' }, reasoning_effort: effort };
}

export function isDeepSeekV4Model(model: string | undefined): boolean {
  return (model ?? '').toLowerCase().includes('deepseek-v4');
}
