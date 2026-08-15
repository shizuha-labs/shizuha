/**
 * SCLI-385: long-running tool cards must escalate to an actionable stall banner.
 *
 * Short tools stay spinner+timer only; past TOOL_STALL_THRESHOLD_MS the card
 * explains the delay and shows Esc to interrupt. Completing the tool clears
 * the running chrome entirely (no residual banner).
 */
import { describe, expect, it } from 'vitest';
import {
  resolveToolRunningPresentation,
  TOOL_STALL_THRESHOLD_MS,
} from '../../src/tui/components/ToolCall.js';
import { ACTIVE_SPINNER_LIMIT_MS } from '../../src/tui/components/ThinkingIndicator.js';

describe('resolveToolRunningPresentation (SCLI-385)', () => {
  it('shares the ThinkingIndicator long-run threshold', () => {
    expect(TOOL_STALL_THRESHOLD_MS).toBe(ACTIVE_SPINNER_LIMIT_MS);
    expect(TOOL_STALL_THRESHOLD_MS).toBe(30_000);
  });

  it('does not show a stall banner for short healthy work', () => {
    for (const ms of [0, 1_000, 15_000, TOOL_STALL_THRESHOLD_MS - 1]) {
      const p = resolveToolRunningPresentation(ms);
      expect(p.showStallBanner, `ms=${ms}`).toBe(false);
      expect(p.stallMessage).toBeNull();
    }
  });

  it('shows an actionable stall banner after the threshold', () => {
    for (const ms of [TOOL_STALL_THRESHOLD_MS, 45_000, 82_000, 120_000]) {
      const p = resolveToolRunningPresentation(ms);
      expect(p.showStallBanner, `ms=${ms}`).toBe(true);
      expect(p.stallMessage).toContain('Taking longer than expected');
      expect(p.stallMessage).toContain('Esc to interrupt');
    }
  });

  it('does not use scare-copy about missing tool calls', () => {
    const p = resolveToolRunningPresentation(90_000);
    expect(p.stallMessage?.toLowerCase()).not.toContain('no tool call');
    expect(p.stallMessage?.toLowerCase()).not.toContain('hung');
  });
});
