/**
 * Official DeepSeek chat-completions wire helpers.
 *
 * Ported from deepseek-ai/deepseek-harness `packages/llm/llm-deepseek`
 * (serialize.ts + thinking_mode.mdx), MIT. Not a Cordis adapter drop-in —
 * SCLI keeps VLlmProvider (DSML hold, Cortex affinity, GLM/Qwen).
 *
 * https://api-docs.deepseek.com/guides/thinking_mode/ requires every prior
 * assistant reasoning_content when the request carries tools, including
 * turns without tool calls. VLlmProvider resolves that request-level policy
 * before this helper; tool-call-turns remains its tool-free fallback.
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
