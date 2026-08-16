export type IncompleteTurnStopReason = 'stall_salvage' | 'max_tokens';

export const MAX_THINKING_ONLY_RECOVERY = 3;

export const AUTONOMOUS_MAX_TOKENS_CONTINUE_PROMPT =
  'Continue. Use your tools to implement the solution.';

export function incompleteTurnError(stopReason: string | undefined): string | null {
  if (stopReason === 'stall_salvage') {
    return 'The model stream ended after a mid-response transport stall. Partial output was preserved, but automatic replay did not recover the turn.';
  }
  if (stopReason === 'max_tokens') {
    return 'The model exhausted its output-token limit. Partial output was preserved, but the turn is incomplete and no tool call or successful completion was inferred from truncated output.';
  }
  return null;
}

/**
 * Autonomous coding: a length-capped turn with no tool call is not a finished
 * answer. Qwen streams reasoning_text into the visible buffer, so an
 * empty-visible gate never matches. Continue whenever a reasoning block exists.
 * Visible-text-only truncation in interactive/plan modes stays fail-closed.
 */
export function shouldContinueAutonomousMaxTokens(args: {
  stopReason: string | undefined;
  permissionMode: string | undefined;
  reasoningText: string;
  recoveryCount: number;
  maxRecovery?: number;
  outputTokens?: number;
}): boolean {
  const maxRecovery = args.maxRecovery ?? MAX_THINKING_ONLY_RECOVERY;
  const outputTokens = args.outputTokens ?? 0;
  // llama.cpp/Cortex often emit finish_reason=stop instead of length after a
  // 16k think. Treat a long no-tool stop as the same output cap.
  const lengthCapped = args.stopReason === 'max_tokens'
    || (args.stopReason === 'stop' && outputTokens >= 12_000);
  return lengthCapped
    && args.permissionMode === 'autonomous'
    && args.recoveryCount < maxRecovery
    && args.reasoningText.trim().length > 0;
}
