/**
 * SCLI-519: slash-command message routing policy.
 *
 * Multi-line slash output (e.g. /doctor diagnostics) must be routed to the
 * transcript viewport (never overwritten by the persistent header), while
 * single-line notices stay in the transient status slot.
 */
import { describe, it, expect } from 'vitest';
import { slashMessageKind } from '../../src/tui/utils/slashDisplay.js';

describe('slashMessageKind (SCLI-519)', () => {
  it('routes multi-line output to the transcript', () => {
    expect(slashMessageKind('Results:\n- Cortex model: ok\n- SQLite: ok')).toBe('transcript');
  });

  it('routes single-line notices to the status slot', () => {
    expect(slashMessageKind('Model set to DeepSeek-V4-Flash')).toBe('status');
  });

  it('treats empty/null as status', () => {
    expect(slashMessageKind('')).toBe('status');
    expect(slashMessageKind(null)).toBe('status');
    expect(slashMessageKind(undefined)).toBe('status');
  });

  it('routes a trailing-newline block to the transcript', () => {
    expect(slashMessageKind('Fix: Model not available (model_not_found).\n')).toBe('transcript');
  });
});
