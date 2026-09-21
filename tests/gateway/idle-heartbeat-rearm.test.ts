import { describe, expect, it } from 'vitest';
import {
  shouldFastRearmIdleHeartbeat,
  FAST_REARM_NO_PROGRESS_LIMIT,
} from '../../src/gateway/agent-process.js';

describe('shouldFastRearmIdleHeartbeat', () => {
  it('does not re-arm protocol-only empty queue checks (alerts+tasks)', () => {
    // This is the Nova failure mode: totalToolCalls was ≥2 every empty beat.
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 0,
      progressEventCount: 0,
      forwardedEventCount: 0,
    })).toBe(false);
  });

  it('re-arms while ready work remains — operator directive 2026-09-15 (continuous work-seeking)', () => {
    // The Kumo/banto spin class is prevented by the no-progress cap and the
    // loop-break fallback, NOT by refusing to re-arm on ready work.
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 3,
      progressEventCount: 0,
      forwardedEventCount: 0,
    })).toBe(true);
  });

  it('never re-arms on progress either — next beat is the idle cadence', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 0,
      progressEventCount: 1,
      forwardedEventCount: 0,
    })).toBe(false);
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 0,
      progressEventCount: 0,
      forwardedEventCount: 2,
    })).toBe(false);
  });

  it('never re-arms after a loop-guard break (SCLI-60)', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: true,
      readyTaskCount: 5,
      progressEventCount: 1,
      forwardedEventCount: 1,
    })).toBe(false);
  });
});

describe('a permanently stuck agent stops spinning', () => {
  // banto, 2026-08-05: 2 ready tasks it could not action (they ask for
  // operator/CA-held tax evidence), 49 consecutive heartbeats at
  // progressEventCount 0. Because `ready > 0` it re-armed every ~60s against a
  // configured 900s cadence — each cycle a real model call (TTFT 162.6s
  // measured). A safety net for draining a queue had become a spin loop.
  it('does not re-arm even while the agent is working — cadence is the successor', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 2,
      progressEventCount: 1,
      consecutiveReadyNoProgressHeartbeats: 99,
    })).toBe(false);
  });

  it('re-arms through the first fruitless cycles — the cap (3) is what stops the spin', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 2,
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: FAST_REARM_NO_PROGRESS_LIMIT - 1,
    })).toBe(true);
  });

  it('stops re-arming once it is clearly not progressing', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 2,
      progressEventCount: 0,
      forwardedEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: FAST_REARM_NO_PROGRESS_LIMIT,
    }), 'banto burned a turn a minute for 49 cycles doing nothing').toBe(false);
  });

  it('stays stopped as the count grows', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 2,
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 49,
    })).toBe(false);
  });

  it('does not re-arm on forwarding either', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 1,
      progressEventCount: 0,
      forwardedEventCount: 1,
      consecutiveReadyNoProgressHeartbeats: 49,
    })).toBe(false);
  });
});

describe('the heartbeat nudge does not cattle-prod the model', () => {
  it('is a short stop-or-work prompt, not a never-stop lecture', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname!, '../../src/gateway/agent-process.ts'), 'utf-8',
    );
    expect(src).toContain("import { HEARTBEAT_TRIGGER } from '../agent-base-instructions.js'");
    expect(src).toContain('return HEARTBEAT_TRIGGER');
    expect(src).not.toMatch(/Never stop while you still have a ready task/i);
    expect(src).not.toMatch(/Do not end this turn silent/i);
    expect(src).not.toContain('const IDLE_HEARTBEAT_NUDGE');
  });
});
