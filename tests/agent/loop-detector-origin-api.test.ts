import { describe, it, expect } from 'vitest';
import { LoopDetector, isOriginApiReadProbe } from '../../src/agent/loop-detector.js';

// PLAT-9038: python3 -c that only parses an origin API read must not count
// as a stuck-coding probe. A bare one-liner, or one that also writes a file,
// still does.

const API = 'python3 -c "import json,urllib.request; urllib.request.urlopen(\'https://git.shizuha.com/api/v1/repos/shizuha-labs/pulse/pulls/1\')"';

describe('origin-API reads are not probe loops (PLAT-9038)', () => {
  it('recognises an origin read and rejects a mutating command', () => {
    expect(isOriginApiReadProbe(API)).toBe(true);
    expect(isOriginApiReadProbe('python3 -c "print(1)"')).toBe(false);
    expect(isOriginApiReadProbe(`${API} > /tmp/out.json`)).toBe(false);
  });

  it('five origin-API parses do not warn', () => {
    const d = new LoopDetector();
    let last = 'ok';
    for (let i = 0; i < 8; i++) last = d.record('bash', { command: `${API} # ${i}` });
    expect(last).toBe('ok');
  });

  it('five bare python3 -c calls still warn', () => {
    const d = new LoopDetector();
    let last = 'ok';
    for (let i = 0; i < 5; i++) last = d.record('bash', { command: `python3 -c "print(${i})"` });
    expect(last).toBe('probe-warning');
  });
});
