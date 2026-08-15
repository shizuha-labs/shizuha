import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TUI_STALL_ESCALATION_MS,
  TUI_STALL_DISPLAY_STEP_MS,
  longWaitDisplayMs,
} from '../../src/tui/utils/stallDisplay.js';

describe('long provider wait display policy', () => {
  it('keeps ordinary cold starts quiet for the first five minutes', () => {
    expect(DEFAULT_TUI_STALL_ESCALATION_MS).toBe(300_000);
    expect(longWaitDisplayMs(30_000, DEFAULT_TUI_STALL_ESCALATION_MS)).toBe(0);
    expect(longWaitDisplayMs(120_000, DEFAULT_TUI_STALL_ESCALATION_MS)).toBe(0);
    expect(longWaitDisplayMs(299_999, DEFAULT_TUI_STALL_ESCALATION_MS)).toBe(0);
  });

  it('promotes at five minutes and updates only at minute boundaries', () => {
    expect(TUI_STALL_DISPLAY_STEP_MS).toBe(60_000);
    expect(longWaitDisplayMs(300_000, DEFAULT_TUI_STALL_ESCALATION_MS)).toBe(300_000);
    expect(longWaitDisplayMs(305_000, DEFAULT_TUI_STALL_ESCALATION_MS)).toBe(300_000);
    expect(longWaitDisplayMs(359_999, DEFAULT_TUI_STALL_ESCALATION_MS)).toBe(300_000);
    expect(longWaitDisplayMs(360_000, DEFAULT_TUI_STALL_ESCALATION_MS)).toBe(360_000);
  });

  it('honors lower explicit thresholds without restoring five-second repainting', () => {
    expect(longWaitDisplayMs(29_999, 30_000)).toBe(0);
    expect(longWaitDisplayMs(30_000, 30_000)).toBe(30_000);
    expect(longWaitDisplayMs(55_000, 30_000)).toBe(30_000);
    expect(longWaitDisplayMs(60_000, 30_000)).toBe(60_000);
  });
});
