import { describe, it, expect } from 'vitest';
import { expensiveTurnGuardNotifyUsername } from '../../src/agent/expensive-turn-guard.js';

/**
 * SCLI-345 notification routing. Production recovery is exercised through the
 * real AgentProcess path in scli347-generation-recovery.test.ts; this file must
 * not mirror that path with deterministic history projection helpers.
 */
describe('SCLI-345 expensive-turn notify fallback', () => {
  it('uses AGENT_TEAM when present', () => {
    expect(expensiveTurnGuardNotifyUsername({ AGENT_TEAM: 'devops' } as any)).toBe('ichi');
  });

  it('falls back to AGENT_EFFECTIVE_CAPABILITY_SOURCE_TEAMS when AGENT_TEAM absent', () => {
    expect(expensiveTurnGuardNotifyUsername({
      AGENT_EFFECTIVE_CAPABILITY_SOURCE_TEAMS: 'security,engineering',
    } as any)).toBe('akira');
  });

  it('defaults to ryo when no team metadata is present', () => {
    expect(expensiveTurnGuardNotifyUsername({} as any)).toBe('ryo');
  });

  it('falls back to a different cluster manager when the team lead is self', () => {
    expect(expensiveTurnGuardNotifyUsername({
      AGENT_USERNAME: 'zen',
      AGENT_TEAM: 'qa',
    } as any)).toBe('ryo');
    expect(expensiveTurnGuardNotifyUsername({
      AGENT_USERNAME: 'ryo',
    } as any)).toBe('aoi');
  });

  it('honors explicit notify username over team maps', () => {
    expect(expensiveTurnGuardNotifyUsername({
      SHIZUHA_EXPENSIVE_TURN_NOTIFY_USERNAME: 'aoi',
      AGENT_TEAM: 'engineering',
    } as any)).toBe('aoi');
  });
});
