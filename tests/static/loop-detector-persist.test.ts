import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/gateway/agent-process.ts'),
  'utf8',
);

describe('gateway LoopDetector lifetime (revi same-tool ABAB)', () => {
  it('does not construct a fresh LoopDetector per processMessage', () => {
    expect(source).not.toMatch(/const loopDetector = new LoopDetector/);
    expect(source).toContain('const loopDetector = this.loopDetector');
  });

  it('resets the detector on non-heartbeat messages only', () => {
    expect(source).toMatch(/if \(msg\.source !== 'heartbeat'\) \{\s*this\.loopDetector\.reset\(\);/s);
  });

  it('does not prefetch, inject, or continue a heartbeat after the model stops', () => {
    expect(source).not.toContain('Heartbeat prefetch — harness called pulse_get_my_work');
    expect(source).not.toContain('Heartbeat alerts-then-narration — injected pulse_get_my_work snapshot');
    expect(source).not.toContain('Heartbeat tasks-then-narration — injected pulse_get_task for first ready item');
    expect(source).not.toContain('Heartbeat alerts-only loop — injected pulse_get_my_work snapshot');
    expect(source).not.toContain('Heartbeat loop-break — injected pulse_get_my_work instead of aborting');
    expect(source).not.toContain('Incomplete tool turn — retrying without rejected narration');
    expect(source).toContain('No tools → the turn is over');
  });

  it('branches loop-break copy on listing vs get_task (Ryo/Hiro gen36)', () => {
    expect(source).toContain('heartbeatLoopBreakMessage(brokeOnTool)');
    expect(source).not.toMatch(/Do not pulse_get_task the same keys again/);
  });
});
