import { describe, expect, it } from 'vitest';

import { shouldAnimateReasoningSummary } from '../../src/tui/components/MessageBlock.js';
import {
  ACTIVE_SPINNER_LIMIT_MS,
  derivePhase,
  resolveIndicatorPresentation,
  SLOW_SPINNER_INTERVAL_MS,
} from '../../src/tui/components/ThinkingIndicator.js';

describe('TUI activity indicator lifecycle', () => {
  it('never leaves completed reasoning summaries animated', () => {
    expect(shouldAnimateReasoningSummary(false, true)).toBe(false);
    expect(shouldAnimateReasoningSummary(false, false)).toBe(false);
    expect(shouldAnimateReasoningSummary(true, true)).toBe(true);
  });

  it('does not mistake narrated intent for a real tool execution', () => {
    expect(derivePhase('Searching the cluster for endpoints...')).toBe('thinking');
    expect(derivePhase('Let me run kubectl now...')).toBe('thinking');
    expect(derivePhase('Running bash...')).toBe('tool');
  });

  it('keeps an animated Responding phase visible while text streams', () => {
    const phase = derivePhase('Thinking...', true);
    expect(phase).toBe('responding');
    expect(derivePhase(null, true)).toBe('responding');

    const presentation = resolveIndicatorPresentation(phase, 'Thinking...', 0);
    expect(presentation.displayLabel).toBe('Responding');
    expect(presentation.animate).toBe(true);
    expect(presentation.spinnerIntervalMs).toBeLessThan(SLOW_SPINNER_INTERVAL_MS);
  });

  it('NEVER stops animating — it slows down instead', () => {
    // Operator 2026-08-05, on a 6m40s turn:
    //
    //   maybe cortex is processing the request here but we see no animation
    //   which is bad UX
    //
    // This test previously asserted `animate === false` past the threshold.
    // Freezing the spinner is exactly what made a healthy long Cortex call
    // indistinguishable from a hung session: the glyph dropped to a static
    // fallback and nothing on screen moved for minutes.
    const before = resolveIndicatorPresentation(
      'thinking', 'Let me check the service configuration...', ACTIVE_SPINNER_LIMIT_MS - 1,
    );
    const stalled = resolveIndicatorPresentation(
      'thinking', 'Let me check the service configuration...', ACTIVE_SPINNER_LIMIT_MS,
    );

    expect(before.animate).toBe(true);
    expect(stalled.animate, 'a long turn must still show it is alive').toBe(true);
    // The CPU concern the old freeze protected against is real, so the tick
    // slows — it does not stop. 1s rides the re-render the elapsed timer is
    // already doing every second anyway.
    expect(stalled.spinnerIntervalMs).toBeGreaterThan(before.spinnerIntervalMs);
    expect(stalled.spinnerIntervalMs).toBe(SLOW_SPINNER_INTERVAL_MS);
  });

  it('reads like a product, not an internal detail', () => {
    // "No tool call yet · Esc to cancel" described a model-internals condition
    // in wording that reads like an error. A waiting user needs: still working,
    // for how long, and how to stop.
    const stalled = resolveIndicatorPresentation(
      'thinking', 'Let me check the service configuration...', ACTIVE_SPINNER_LIMIT_MS,
    );
    expect(stalled.displayLabel).not.toContain('No tool call yet');
    expect(stalled.displayLabel).toContain('Esc to interrupt');
    // The phase label survives, so the line still says WHAT it is doing.
    expect(stalled.displayLabel).toContain('Let me check the service configuration');
    expect(stalled.color).toBe('yellow');
  });

  it('keeps the plain label before the threshold', () => {
    const before = resolveIndicatorPresentation('thinking', 'Thinking', 0);
    expect(before.displayLabel).toBe('Thinking');
    expect(before.displayLabel).not.toContain('Esc');
  });

  it('animates a running tool at full speed', () => {
    const tool = resolveIndicatorPresentation('tool', 'Running bash', 0);
    expect(tool.animate).toBe(true);
    expect(tool.spinnerIntervalMs).toBeLessThan(SLOW_SPINNER_INTERVAL_MS);
  });
});
