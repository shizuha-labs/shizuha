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

  it('re-arms when ready work remains after the heartbeat', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 3,
      progressEventCount: 0,
      forwardedEventCount: 0,
    })).toBe(true);
  });

  it('re-arms when the heartbeat made progress or forwarded work', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 0,
      progressEventCount: 1,
      forwardedEventCount: 0,
    })).toBe(true);
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 0,
      progressEventCount: 0,
      forwardedEventCount: 2,
    })).toBe(true);
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
  it('still re-arms while the agent is actually working through its queue', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 2,
      progressEventCount: 1,
      consecutiveReadyNoProgressHeartbeats: 99,
    }), 'real progress must always re-arm — that is the whole point of the net').toBe(true);
  });

  it('re-arms for the first few fruitless cycles', () => {
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

  it('forwarding still counts as progress', () => {
    expect(shouldFastRearmIdleHeartbeat({
      sawLoopBreak: false,
      readyTaskCount: 1,
      progressEventCount: 0,
      forwardedEventCount: 1,
      consecutiveReadyNoProgressHeartbeats: 49,
    })).toBe(true);
  });
});

describe('the heartbeat nudge tells agents what to do with work they cannot action', () => {
  it('names reassign/transition and blocker-task as the required moves', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname!, '../../src/gateway/agent-process.ts'), 'utf-8',
    );
    const start = src.indexOf('const IDLE_HEARTBEAT_NUDGE');
    const nudge = src.slice(start, src.indexOf('const IDLE_HEARTBEAT_TERMINAL_STATUSES', start));
    // Covering only INVALID tasks left banto stalling on a VALID one it could
    // never do, which is exactly what needs_help then flagged.
    expect(nudge).toMatch(/reassign\/transition/i);
    expect(nudge).toMatch(/blocker task/i);
    expect(nudge).toMatch(/cannot action it yourself/i);
  });
});

describe('the nudge covers finished-your-part parking', () => {
  it('tells agents to hand off tasks whose next action belongs to another role', async () => {
    // rei (WIP cap 1) held one signed-off in_review item; the resolver denied
    // every new assignment (wip_capacity_denied load=1 cap=1) and the review
    // team's ~60-task queue could not distribute at all (2026-08-05).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname!, '../../src/gateway/agent-process.ts'), 'utf-8',
    );
    const start = src.indexOf('const IDLE_HEARTBEAT_NUDGE');
    const nudge = src.slice(start, src.indexOf('const IDLE_HEARTBEAT_TERMINAL_STATUSES', start));
    expect(nudge).toMatch(/YOUR part is done/i);
    expect(nudge).toMatch(/WIP slot/i);
  });
});
