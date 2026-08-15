import { describe, expect, it } from 'vitest';
import { loopDetectorSchema, configSchema } from '../../src/config/schema.js';

/** SCLI-20(c): TOML-configurable loop-detector thresholds + validation. */

describe('loopDetectorSchema', () => {
  it('applies sensible defaults when empty', () => {
    expect(loopDetectorSchema.parse({})).toEqual({
      warningThreshold: 3,
      breakThreshold: 5,
      probeLoopWarning: 5,
      probeLoopBreak: 8,
    });
  });

  it('accepts a full valid override', () => {
    const parsed = loopDetectorSchema.parse({
      warningThreshold: 2,
      breakThreshold: 4,
      probeLoopWarning: 3,
      probeLoopBreak: 6,
    });
    expect(parsed.breakThreshold).toBe(4);
    expect(parsed.probeLoopBreak).toBe(6);
  });

  it('allows break == warning (equal is fine)', () => {
    expect(() => loopDetectorSchema.parse({ warningThreshold: 5, breakThreshold: 5 })).not.toThrow();
  });

  it('rejects breakThreshold < warningThreshold', () => {
    expect(() => loopDetectorSchema.parse({ warningThreshold: 5, breakThreshold: 3 }))
      .toThrow(/breakThreshold.*must be >=.*warningThreshold/);
  });

  it('rejects probeLoopBreak < probeLoopWarning', () => {
    expect(() => loopDetectorSchema.parse({ probeLoopWarning: 8, probeLoopBreak: 4 }))
      .toThrow(/probeLoopBreak.*must be >=.*probeLoopWarning/);
  });

  it('rejects non-positive thresholds', () => {
    expect(() => loopDetectorSchema.parse({ warningThreshold: 0 })).toThrow();
    expect(() => loopDetectorSchema.parse({ breakThreshold: -1 })).toThrow();
  });

  it('rejects non-integer thresholds', () => {
    expect(() => loopDetectorSchema.parse({ warningThreshold: 2.5 })).toThrow();
  });
});

describe('configSchema integration', () => {
  it('provides loopDetector defaults when the section is omitted', () => {
    const cfg = configSchema.parse({});
    expect(cfg.loopDetector).toEqual({
      warningThreshold: 3,
      breakThreshold: 5,
      probeLoopWarning: 5,
      probeLoopBreak: 8,
    });
  });

  it('parses a [loopDetector] override nested in full config', () => {
    const cfg = configSchema.parse({ loopDetector: { warningThreshold: 2, breakThreshold: 10 } });
    expect(cfg.loopDetector.warningThreshold).toBe(2);
    expect(cfg.loopDetector.breakThreshold).toBe(10);
    expect(cfg.loopDetector.probeLoopWarning).toBe(5);  // default preserved
  });

  it('rejects an invalid [loopDetector] override at the config level', () => {
    expect(() => configSchema.parse({ loopDetector: { warningThreshold: 9, breakThreshold: 2 } })).toThrow();
  });
});
