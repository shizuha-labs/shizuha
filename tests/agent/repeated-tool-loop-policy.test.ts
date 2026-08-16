import { describe, it, expect } from 'vitest';
import {
  evaluateRepeatedToolLoop,
  isEmptyToolArgsError,
  toolCallSignature,
  toolCallsHaveEmptyArgs,
} from '../../src/agent/tool-loop-guard.js';
import type { ToolCall } from '../../src/agent/types.js';

function tc(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: `id-${name}`, name, input };
}

function runSeries(
  turns: Array<{ tools: ToolCall[]; hadError: boolean; errorContent?: string }>,
) {
  let prev: string | null = null;
  let count = 0;
  const verdicts = [];
  for (const turn of turns) {
    const v = evaluateRepeatedToolLoop({
      toolCalls: turn.tools,
      previousSignature: prev,
      previousCount: count,
      hadError: turn.hadError,
      errorContent: turn.errorContent,
    });
    prev = v.previousSignature;
    count = v.count;
    verdicts.push(v);
  }
  return verdicts;
}

describe('evaluateRepeatedToolLoop — false-positive policy', () => {
  it('does not track text-only turns (empty toolCalls)', () => {
    const v = evaluateRepeatedToolLoop({
      toolCalls: [],
      previousSignature: 'bash:{}',
      previousCount: 5,
      hadError: false,
    });
    expect(v).toEqual({ action: 'none', kind: 'none', count: 0, previousSignature: null });
  });

  it('never hard-stops on successful identical calls (polling / re-check OK)', () => {
    const tools = [tc('bash', { command: 'kubectl get pods' })];
    const turns = Array.from({ length: 12 }, () => ({ tools, hadError: false }));
    const verdicts = runSeries(turns);
    // Soft nudge only after successNudgeAt (3)
    expect(verdicts[0]!.action).toBe('none');
    expect(verdicts[1]!.action).toBe('none');
    expect(verdicts[2]!.action).toBe('nudge');
    expect(verdicts[2]!.kind).toBe('success_repeat');
    // Still only nudge at turn 12 — never stop
    expect(verdicts[11]!.action).toBe('nudge');
    expect(verdicts[11]!.kind).toBe('success_repeat');
    expect(verdicts.every((v) => v.action !== 'stop')).toBe(true);
  });

  it('hard-stops after repeated FAILING identical calls', () => {
    const tools = [tc('read', { file_path: '/tmp/missing' })];
    const turns = Array.from({ length: 6 }, () => ({
      tools,
      hadError: true,
      errorContent: 'ENOENT: no such file',
    }));
    const verdicts = runSeries(turns);
    expect(verdicts[0]!.action).toBe('none');
    expect(verdicts[1]!.action).toBe('nudge');
    expect(verdicts[1]!.kind).toBe('error_repeat');
    expect(verdicts[5]!.action).toBe('stop');
    expect(verdicts[5]!.kind).toBe('error_repeat');
  });

  it('stops empty-args schema loops earlier (true positive, not cwd noise)', () => {
    const tools = [tc('bash', {})];
    const turns = Array.from({ length: 4 }, () => ({
      tools,
      hadError: true,
      errorContent: 'Tool error: [ { "code": "invalid_type", "path": ["command"], "message": "Required" } ]',
    }));
    const verdicts = runSeries(turns);
    expect(verdicts[1]!.action).toBe('nudge');
    expect(verdicts[1]!.kind).toBe('empty_args');
    expect(verdicts[3]!.action).toBe('stop');
    expect(verdicts[3]!.kind).toBe('empty_args');
  });

  it('different inputs never accumulate a streak', () => {
    const verdicts = runSeries([
      { tools: [tc('read', { file_path: '/a' })], hadError: false },
      { tools: [tc('read', { file_path: '/b' })], hadError: false },
      { tools: [tc('read', { file_path: '/c' })], hadError: false },
      { tools: [tc('read', { file_path: '/d' })], hadError: false },
      { tools: [tc('read', { file_path: '/e' })], hadError: false },
    ]);
    expect(verdicts.every((v) => v.action === 'none' && v.count === 1)).toBe(true);
  });

  it('interleaving a different call resets the success streak', () => {
    const verdicts = runSeries([
      { tools: [tc('bash', { command: 'ls' })], hadError: false },
      { tools: [tc('bash', { command: 'ls' })], hadError: false },
      { tools: [tc('bash', { command: 'pwd' })], hadError: false }, // reset
      { tools: [tc('bash', { command: 'ls' })], hadError: false },
      { tools: [tc('bash', { command: 'ls' })], hadError: false },
    ]);
    expect(verdicts[1]!.count).toBe(2);
    expect(verdicts[2]!.count).toBe(1);
    expect(verdicts[4]!.count).toBe(2);
    expect(verdicts.every((v) => v.action !== 'stop')).toBe(true);
  });
});

describe('helpers', () => {
  it('isEmptyToolArgsError detects Zod-style schema rejects', () => {
    expect(isEmptyToolArgsError('invalid_type path command Required')).toBe(true);
    expect(isEmptyToolArgsError('ENOENT no such file')).toBe(false);
  });

  it('toolCallsHaveEmptyArgs detects all-empty inputs', () => {
    expect(toolCallsHaveEmptyArgs([tc('bash', {})])).toBe(true);
    expect(toolCallsHaveEmptyArgs([tc('bash', { command: 'echo hi' })])).toBe(false);
  });

  it('toolCallSignature is stable under key order', () => {
    const a = toolCallSignature([tc('read', { b: 1, a: 2 })]);
    const b = toolCallSignature([tc('read', { a: 2, b: 1 })]);
    expect(a).toBe(b);
  });
});
