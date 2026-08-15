import { describe, expect, it } from 'vitest';

import {
  ActivityPhaseTracker,
  applyAgentEventToPhase,
  buildActivityTelemetry,
} from '../../src/telemetry/activity-phase.js';

describe('ActivityPhaseTracker', () => {
  it('starts idle and reports working only after a live phase', () => {
    let clock = 1_000;
    const tracker = new ActivityPhaseTracker({ now: () => clock });
    expect(tracker.snapshot().state).toBe('idle');
    expect(tracker.snapshot().phase).toBe('idle');

    clock = 1_500;
    expect(tracker.markThinking()).toBe(true);
    const thinking = tracker.snapshot();
    expect(thinking.state).toBe('working');
    expect(thinking.phase).toBe('thinking');
    expect(thinking.phase_for_ms).toBe(0);

    clock = 2_500;
    expect(tracker.markResponding()).toBe(true);
    const responding = tracker.snapshot();
    expect(responding.phase).toBe('responding');
    expect(responding.seconds_24h.thinking).toBe(1);
  });

  it('keeps tool phase while more than one tool is in flight', () => {
    const tracker = new ActivityPhaseTracker();
    tracker.markTool('bash');
    tracker.markTool('read');
    expect(tracker.current).toBe('tool');
    expect(tracker.snapshot().tool_name).toBe('read');
    expect(tracker.endTool()).toBe(false);
    expect(tracker.current).toBe('tool');
    expect(tracker.endTool()).toBe(true);
    expect(tracker.current).toBe('thinking');
    expect(tracker.snapshot().tool_name).toBeNull();
  });

  it('maps harness events onto the four operator phases', () => {
    const tracker = new ActivityPhaseTracker();
    applyAgentEventToPhase(tracker, { type: 'turn_start' });
    expect(tracker.current).toBe('thinking');
    applyAgentEventToPhase(tracker, { type: 'content' });
    expect(tracker.current).toBe('responding');
    applyAgentEventToPhase(tracker, { type: 'tool_start', toolName: 'grep' });
    expect(tracker.snapshot().tool_name).toBe('grep');
    applyAgentEventToPhase(tracker, { type: 'tool_complete' });
    expect(tracker.current).toBe('thinking');
    applyAgentEventToPhase(tracker, { type: 'complete' });
    expect(tracker.current).toBe('idle');
  });

  it('reconciles a busy latch without a first event as thinking', () => {
    const tracker = new ActivityPhaseTracker();
    const snap = buildActivityTelemetry(tracker, { busy: true, queueDepth: 2 });
    expect(snap.state).toBe('working');
    expect(snap.phase).toBe('thinking');
    expect(snap.queue_depth).toBe(2);

    const idle = buildActivityTelemetry(tracker, { busy: false, queueDepth: 0 });
    expect(idle.state).toBe('idle');
    expect(idle.phase).toBe('idle');
  });
});
