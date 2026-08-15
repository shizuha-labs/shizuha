import type { ToolCall } from './types.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
    .join(',')}}`;
}

export function toolCallSignature(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((tc) => `${tc.name}:${stableStringify(tc.input ?? {})}`)
    .sort()
    .join('|');
}

/** True when Zod/schema rejected missing required tool fields (empty input {}). */
export function isEmptyToolArgsError(errorContent: string | undefined | null): boolean {
  return /invalid_type|Required|received.?undefined/i.test(String(errorContent ?? ''));
}

/** True when every tool call has no meaningful input (all `{}` / empty). */
export function toolCallsHaveEmptyArgs(toolCalls: ToolCall[]): boolean {
  if (toolCalls.length === 0) return false;
  return toolCalls.every((tc) => {
    const input = tc.input;
    if (input == null) return true;
    if (typeof input !== 'object') return false;
    return Object.keys(input as object).length === 0;
  });
}

export type RepeatedToolLoopAction = 'none' | 'nudge' | 'stop';

export interface RepeatedToolLoopVerdict {
  action: RepeatedToolLoopAction;
  /** Kind of loop — drives copy + whether hard-stop is allowed. */
  kind: 'none' | 'success_repeat' | 'error_repeat' | 'empty_args';
  /** Updated consecutive count after this turn (0 if not tracking). */
  count: number;
  /** Updated previous signature after this turn. */
  previousSignature: string | null;
}

/**
 * Turn-level identical tool-call loop policy (TUI + gateway agent loop).
 *
 * False-positive rules (operator 2026-07-22):
 * - **Never hard-stop on successful identical calls.** Polling (`kubectl get`,
 *   re-read after write) and deliberate re-checks are legitimate. Soft-nudge only.
 * - **Ignore text-only turns** (no tool calls) — empty signature must not count.
 * - **Hard-stop only when the same call keeps FAILING** (or empty-args schema
 *   reject). That is the real runaway we saw with Spark empty tool inputs.
 *
 * Thresholds (defaults match historical nudge/stop for the failing path):
 * - empty_args / error_repeat: nudge @ 2, stop @ 6 (empty_args stop @ 4 — schema
 *   bugs never self-heal by retry)
 * - success_repeat: nudge @ 3 only, never stop
 */
export function evaluateRepeatedToolLoop(opts: {
  toolCalls: ToolCall[];
  previousSignature: string | null;
  previousCount: number;
  hadError: boolean;
  errorContent?: string | null;
  /** Nudge threshold for failing repeats (default 2). */
  errorNudgeAt?: number;
  /** Hard-stop for failing repeats (default 6). */
  errorStopAt?: number;
  /** Hard-stop for empty-args schema rejects (default 4). */
  emptyArgsStopAt?: number;
  /** Soft-nudge for successful identical calls (default 3). Never stops. */
  successNudgeAt?: number;
}): RepeatedToolLoopVerdict {
  const {
    toolCalls,
    previousSignature,
    previousCount,
    hadError,
    errorContent,
    errorNudgeAt = 2,
    errorStopAt = 6,
    emptyArgsStopAt = 4,
    successNudgeAt = 3,
  } = opts;

  // Text-only / no tools: do not track. Avoids "" signatures stacking.
  if (!toolCalls.length) {
    return { action: 'none', kind: 'none', count: 0, previousSignature: null };
  }

  const sig = toolCallSignature(toolCalls);
  const count = sig === previousSignature ? previousCount + 1 : 1;
  const nextPrev = sig;

  const emptyArgs =
    hadError
    && (isEmptyToolArgsError(errorContent) || toolCallsHaveEmptyArgs(toolCalls));

  if (emptyArgs) {
    if (count >= emptyArgsStopAt) {
      return { action: 'stop', kind: 'empty_args', count, previousSignature: nextPrev };
    }
    if (count >= errorNudgeAt) {
      return { action: 'nudge', kind: 'empty_args', count, previousSignature: nextPrev };
    }
    return { action: 'none', kind: 'empty_args', count, previousSignature: nextPrev };
  }

  if (hadError) {
    if (count >= errorStopAt) {
      return { action: 'stop', kind: 'error_repeat', count, previousSignature: nextPrev };
    }
    if (count >= errorNudgeAt) {
      return { action: 'nudge', kind: 'error_repeat', count, previousSignature: nextPrev };
    }
    return { action: 'none', kind: 'error_repeat', count, previousSignature: nextPrev };
  }

  // Successful identical calls: soft nudge only — never hard-stop (polling, re-check).
  if (count >= successNudgeAt) {
    return { action: 'nudge', kind: 'success_repeat', count, previousSignature: nextPrev };
  }
  return { action: 'none', kind: 'success_repeat', count, previousSignature: nextPrev };
}

// ── Error-streak detection (task-agnostic struggle signal) ──
// The byte-identical loop-guard (toolCallSignature) only catches a model repeating
// the SAME call. It misses diffuse flailing: many DIFFERENT calls that keep FAILING
// (observed live: a GLM run hit "no such file", "container restarting", "no cat in
// distroless", … across 30+ distinct commands and never recovered — it even
// destabilised prod).
//
// IMPORTANT: absence of file edits is NOT a struggle signal — read-only/exploratory
// tasks (research, review, QA, "investigate and report") legitimately make no edits.
// The honest, task-agnostic signal of a run going wrong is repeated tool ERRORS
// (plus stalls and identical repeats, handled elsewhere). We count consecutive turns
// whose tool results error out, and inject a forcing-function nudge to make the model
// diagnose the root cause instead of retrying variations that keep failing.

export function turnHadToolError(results: ReadonlyArray<{ isError?: boolean }> | undefined): boolean {
  return !!results && results.some((r) => r?.isError === true);
}

/**
 * PLAT-216: Cross-turn no-progress guard.
 *
 * Tracks the union of all tool-call signatures seen across turns (session-wide).
 * A turn is "no progress" when every tool call in it was already seen in a prior turn.
 * After `threshold` consecutive no-progress turns, `record()` returns 'stuck'.
 *
 * Text-only turns (toolCalls.length === 0) are not a loop signal — they reset the
 * counter. Empty arrays occur on normal completion turns and must not trigger the guard.
 */
export class NoProgressGuard {
  private readonly seenSigs = new Set<string>();
  private noProgressTurns = 0;
  readonly threshold: number;

  constructor(threshold = 5) {
    this.threshold = threshold;
  }

  record(toolCalls: ToolCall[]): 'ok' | 'stuck' {
    if (toolCalls.length === 0) {
      this.noProgressTurns = 0;
      return 'ok';
    }
    let allSeen = true;
    for (const tc of toolCalls) {
      const sig = toolCallSignature([tc]);
      if (!this.seenSigs.has(sig)) {
        allSeen = false;
        this.seenSigs.add(sig);
      }
    }
    if (allSeen) {
      this.noProgressTurns++;
    } else {
      this.noProgressTurns = 0;
    }
    return this.noProgressTurns >= this.threshold ? 'stuck' : 'ok';
  }

  get turnsWithoutProgress(): number {
    return this.noProgressTurns;
  }
}

