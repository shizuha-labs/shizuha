export type IncompleteTurnStopReason = 'stall_salvage' | 'max_tokens';

export function incompleteTurnError(stopReason: string | undefined): string | null {
  if (stopReason === 'stall_salvage') {
    return 'The model stream ended after a mid-response transport stall. Partial output was preserved, but automatic replay did not recover the turn.';
  }
  if (stopReason === 'max_tokens') {
    return 'The model exhausted its output-token limit. Partial output was preserved, but the turn is incomplete and no tool call or successful completion was inferred from truncated output.';
  }
  return null;
}
