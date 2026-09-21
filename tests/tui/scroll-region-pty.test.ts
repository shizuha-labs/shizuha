/**
 * PLAT-7382 regression: wheel events with mouse reporting ON must scroll the
 * conversation viewport via DECSTBM scroll-region mechanics — the exact byte
 * sequences (region set + SU/SD + region reset, DECSC/DECRC-wrapped) on a
 * REAL PTY, and the gating (mouse off / no geometry → no sequences, the
 * beta#330 behavior unchanged).
 *
 * The PTY half mirrors tests/tui/mouse-pty.test.ts (SCLI-479): `script`
 * allocates a real PTY and captures the raw bytes. Requires: `script`
 * (util-linux).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  buildScrollRegionSequence,
  shouldUseScrollRegion,
} from '../../src/tui/utils/scrollRegion.js';

const projectDir = path.resolve(import.meta.dirname!, '../..');

describe('scroll-region sequence builder', () => {
  it('emits DECSC + DECSTBM set + SU + reset + DECRC for wheel-down', () => {
    // Wheel-down (delta=+3): content moves up, revealing lower lines → SU 3.
    expect(buildScrollRegionSequence({ top: 5, bottom: 40, lines: 3 })).toBe(
      '\x1b7\x1b[5;40r\x1b[3S\x1b[r\x1b8',
    );
  });

  it('emits SD for wheel-up (negative lines)', () => {
    // Wheel-up (delta=-3): content moves down, revealing earlier lines → SD 3.
    expect(buildScrollRegionSequence({ top: 5, bottom: 40, lines: -3 })).toBe(
      '\x1b7\x1b[5;40r\x1b[3T\x1b[r\x1b8',
    );
  });

  it('refuses invalid geometry and zero/no-op scrolls (fail-open to the internal scroll)', () => {
    expect(buildScrollRegionSequence({ top: 0, bottom: 40, lines: 3 })).toBe('');
    expect(buildScrollRegionSequence({ top: 10, bottom: 5, lines: 3 })).toBe('');
    expect(buildScrollRegionSequence({ top: 5, bottom: 40, lines: 0 })).toBe('');
    expect(
      buildScrollRegionSequence({ top: NaN, bottom: 40, lines: 3 }),
    ).toBe('');
  });
});

describe('scroll-region gating', () => {
  it('never uses DECSTBM for the wheel (blank-canvas / overscroll regression)', () => {
    expect(shouldUseScrollRegion(false, { top: 5, bottom: 40 })).toBe(false);
    expect(shouldUseScrollRegion(undefined, { top: 5, bottom: 40 })).toBe(false);
    expect(shouldUseScrollRegion(true, { top: 5, bottom: 40 })).toBe(false);
    expect(shouldUseScrollRegion(true, null)).toBe(false);
  });
});

// --- PTY-level: the sequences must reach a real terminal ---

function hasScript(): boolean {
  try {
    execFileSync('script', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const runSuite = hasScript();
const ptyDescribe = runSuite ? describe : describe.skip;

function runInPty(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plat7382-pty-'));
  const scriptPath = path.join(tmp, 'probe.mts');
  const payload = `
import { buildScrollRegionSequence } from '${projectDir}/src/tui/utils/scrollRegion.ts';
process.stdout.write('__BEGIN__\\n');
process.stdout.write(buildScrollRegionSequence({ top: 3, bottom: 30, lines: 3 }));
process.stdout.write('__MID__\\n');
process.stdout.write(buildScrollRegionSequence({ top: 3, bottom: 30, lines: -3 }));
process.stdout.write('__END__\\n');
`;
  fs.writeFileSync(scriptPath, payload, 'utf-8');
  const typescript = path.join(tmp, 'typescript');
  try {
    execFileSync(
      'script',
      ['-qec', `npx tsx ${scriptPath}`, typescript],
      { cwd: projectDir, timeout: 60_000, stdio: 'ignore' },
    );
  } catch {
    return '';
  }
  return fs.readFileSync(typescript, 'utf-8');
}

ptyDescribe('scroll-region sequences on a real PTY', () => {
  it('writes the exact DECSTBM scroll bytes to the terminal', () => {
    const captured = runInPty();
    expect(captured).toContain('__BEGIN__');
    expect(captured).toContain('__END__');
    // The wheel-down sequence between the markers.
    expect(captured).toContain('\x1b7\x1b[3;30r\x1b[3S\x1b[r\x1b8');
    // The wheel-up sequence between the markers.
    expect(captured).toContain('\x1b7\x1b[3;30r\x1b[3T\x1b[r\x1b8');
  });
});
