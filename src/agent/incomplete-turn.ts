export type IncompleteTurnStopReason = 'stall_salvage' | 'max_tokens';

export const MAX_THINKING_ONLY_RECOVERY = 3;

/** Length stops are a budget, not an end sentinel. Keep extending the same
 *  prefix until EOS / a finished tool call, or this many extensions. */
export const MAX_LENGTH_CONTINUATIONS = 8;

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
 * A length cap is not a terminal sentinel (`<|user|>`, a finished tool call,
 * or a normal EOS). shizuha2 e81682dd 2026-09-22 stopped mid-list because the
 * TUI treated finish_reason=length as a final failure. Continue from the
 * persisted prefix — no "please continue" lecture — while any partial
 * reasoning or visible text exists. Plan mode stays fail-closed. Transport
 * salvage is not a length cap and is not replayed.
 */
export function shouldContinueAutonomousMaxTokens(args: {
  stopReason: string | undefined;
  permissionMode: string | undefined;
  reasoningText: string;
  recoveryCount: number;
  maxRecovery?: number;
  outputTokens?: number;
  /** Visible answer text. A cut-off essay has no reasoning block. */
  assistantText?: string;
}): boolean {
  const maxRecovery = args.maxRecovery ?? MAX_LENGTH_CONTINUATIONS;
  const outputTokens = args.outputTokens ?? 0;
  // llama.cpp/Cortex often emit finish_reason=stop instead of length after a
  // 16k think. Treat a long no-tool stop as the same output cap.
  const lengthCapped = args.stopReason === 'max_tokens'
    || (args.stopReason === 'stop' && outputTokens >= 12_000);
  const hasPartial = args.reasoningText.trim().length > 0
    || (args.assistantText ?? '').trim().length > 0;
  return lengthCapped
    && args.permissionMode !== 'plan'
    && args.recoveryCount < maxRecovery
    && hasPartial;
}
