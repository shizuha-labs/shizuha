import { describe, it, expect } from 'vitest';
import { turnHadToolError } from '../../src/agent/tool-loop-guard.js';

// Regression for the GLM DERP flail: many DIFFERENT tool calls that keep FAILING
// ("no such file", "container restarting", "no cat in distroless", …), never
// recovering. The byte-identical loop-guard can't see it (calls differ); the
// consecutive-error-streak detector + forcing nudge does.
//
// CRITICAL: the trigger is repeated ERRORS, NOT absence of file edits. Read-only /
// exploratory tasks (research, review, QA, "investigate and report") legitimately
// make zero edits and must never be nudged for that.

describe('turnHadToolError', () => {
  it('true when any tool result in the turn errored', () => {
    expect(turnHadToolError([{ isError: true }])).toBe(true);
    expect(turnHadToolError([{ isError: false }, { isError: true }])).toBe(true);
  });

  it('false when all results succeeded (incl. read-only/exploratory turns)', () => {
    expect(turnHadToolError([{ isError: false }])).toBe(false);
    expect(turnHadToolError([{ isError: false }, { isError: false }])).toBe(false);
    expect(turnHadToolError([{}])).toBe(false); // no isError flag = success
  });

  it('false for an empty/absent result set (no false positives)', () => {
    expect(turnHadToolError([])).toBe(false);
    expect(turnHadToolError(undefined)).toBe(false);
  });
});

describe('error-streak (forcing-function trigger simulation)', () => {
  function streakOver(turns: Array<Array<{ isError?: boolean }>>): number {
    return turns.reduce((acc, t) => (turnHadToolError(t) ? acc + 1 : 0), 0);
  }

  it('a run of all-erroring turns accrues a streak (would hit NUDGE_AT=4)', () => {
    const turns = Array.from({ length: 5 }, () => [{ isError: true }]);
    expect(streakOver(turns)).toBe(5);
  });

  it('a SUCCESSFUL call resets the streak (recovery = progress)', () => {
    const turns = [[{ isError: true }], [{ isError: true }], [{ isError: false }], [{ isError: true }]];
    expect(streakOver(turns)).toBe(1);
  });

  it('a long read-only exploration with NO errors never triggers (the key fix)', () => {
    // 12 successful read-only turns, zero edits — must NOT accumulate any streak.
    const turns = Array.from({ length: 12 }, () => [{ isError: false }]);
    expect(streakOver(turns)).toBe(0);
  });
});
