import { describe, it, expect } from 'vitest';
import { LoopDetector } from '../../src/agent/loop-detector.js';

// SCLI-6xx (mio 2026-09-19, live): probe/text oscillation defeated the
// trailing-probe break — the detector nudged forever while context grew
// ~1K tokens per cycle. Three consecutive nudges without an intervening
// write must now escalate to break; a write resets the escalation.

function probeCall(i: number) {
  return { name: 'bash', input: { command: `python3 -c "print(${i})"` } };
}
function writeCall() {
  return { name: 'write', input: { file_path: '/tmp/x.txt', content: 'x' } };
}

describe('probe-loop nudge-forever guard (SCLI-6xx)', () => {
  it('escalates to break after 3 consecutive nudge cycles', () => {
    const d = new LoopDetector();
    const outcomes: string[] = [];
    // Simulate the live oscillation: probes reach the warning threshold,
    // then a mixed turn (text + one probe) keeps the streak below break.
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 5; i++) outcomes.push(d.record(probeCall(round * 10 + i).name, probeCall(round * 10 + i).input));
    }
    // Nudges 1 and 2 are probe-warnings; the third consecutive nudge breaks.
    const warnings = outcomes.filter((o) => o === 'probe-warning').length;
    const breaks = outcomes.filter((o) => o === 'break').length;
    expect(warnings).toBe(2);
    expect(breaks).toBeGreaterThanOrEqual(1);
  });

  it('a write resets the escalation counter', () => {
    const d = new LoopDetector();
    for (let i = 0; i < 5; i++) d.record('bash', probeCall(i).input);   // nudge 1
    d.record('write', writeCall().input);                               // write resets streak
    // After the write the trailing streak restarts; keep bursts short so the
    // original trailing-probe break (>=8) never fires and only the nudge
    // escalation is under test.
    for (let i = 0; i < 5; i++) d.record('bash', probeCall(10 + i).input); // nudge 1 (post-reset)
    const nudge2 = d.record('bash', probeCall(20).input);                  // nudge 2 (streak 6)
    expect(nudge2).toBe('probe-warning');
    // The third post-reset nudge escalates to break — the write bought the
    // agent exactly 2 more nudge cycles, not an unlimited pass.
    const nudge3 = d.record('bash', probeCall(21).input);
    expect(nudge3).toBe('break');
  });
});
