import { describe, expect, it } from 'vitest';
import {
  incompleteTurnError,
  MAX_THINKING_ONLY_RECOVERY,
  shouldContinueAutonomousMaxTokens,
} from '../../src/agent/incomplete-turn.js';

describe('shouldContinueAutonomousMaxTokens', () => {
  const base = {
    stopReason: 'max_tokens' as const,
    permissionMode: 'autonomous',
    reasoningText: 'plan the chess engine',
    recoveryCount: 0,
  };

  it('continues autonomous max_tokens when a reasoning block exists', () => {
    expect(shouldContinueAutonomousMaxTokens(base)).toBe(true);
  });

  it('continues even when reasoning leaked into visible text (no empty-visible gate)', () => {
    expect(shouldContinueAutonomousMaxTokens({
      ...base,
      reasoningText: 'hidden plan I will now write chess_engine.py after more thought.',
    })).toBe(true);
  });

  it('does not continue without a reasoning block', () => {
    expect(shouldContinueAutonomousMaxTokens({ ...base, reasoningText: '' })).toBe(false);
    expect(shouldContinueAutonomousMaxTokens({ ...base, reasoningText: '   ' })).toBe(false);
  });

  it('does not continue in plan or supervised modes', () => {
    expect(shouldContinueAutonomousMaxTokens({ ...base, permissionMode: 'plan' })).toBe(false);
    expect(shouldContinueAutonomousMaxTokens({ ...base, permissionMode: 'supervised' })).toBe(false);
  });

  it('does not continue for stall_salvage or other stop reasons', () => {
    expect(shouldContinueAutonomousMaxTokens({ ...base, stopReason: 'stall_salvage' })).toBe(false);
    expect(shouldContinueAutonomousMaxTokens({ ...base, stopReason: 'end_turn' })).toBe(false);
  });

  it('continues llama.cpp stop after a long reasoning turn', () => {
    expect(shouldContinueAutonomousMaxTokens({
      ...base,
      stopReason: 'stop',
      outputTokens: 16_384,
    })).toBe(true);
    expect(shouldContinueAutonomousMaxTokens({
      ...base,
      stopReason: 'stop',
      outputTokens: 200,
    })).toBe(false);
  });

  it('stops after MAX_THINKING_ONLY_RECOVERY continues', () => {
    expect(shouldContinueAutonomousMaxTokens({
      ...base,
      recoveryCount: MAX_THINKING_ONLY_RECOVERY,
    })).toBe(false);
    expect(shouldContinueAutonomousMaxTokens({
      ...base,
      recoveryCount: MAX_THINKING_ONLY_RECOVERY - 1,
    })).toBe(true);
  });

  it('does not lecture the model to Continue', () => {
    expect(incompleteTurnError('max_tokens')).toMatch(/output-token limit/);
  });
});
