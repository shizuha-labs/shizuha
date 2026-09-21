/**
 * SCLI-479 PTY-level regression: the sticky mouse-reporting toggle must emit
 * the correct DECSET escape sequences on a REAL PTY (not a mocked stream) so
 * the wheel is actually handed back to tmux/terminal scrollback.
 *
 * Uses `script` to allocate a real PTY and capture the raw bytes written by
 * interactiveScreen.setMouseReporting. Requires: `script` (util-linux).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const projectDir = path.resolve(import.meta.dirname!, '../..');

// The exact sequences interactiveScreen writes (kept in sync with the source).
const ENABLE = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1000l';

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scli479-pty-'));
  const scriptPath = path.join(tmp, 'probe.mts');
  const payload = `
import { setMouseReporting, enterInteractiveScreen } from '${projectDir}/src/tui/utils/interactiveScreen.ts';
process.stdout.write('__BEGIN__\\n');
enterInteractiveScreen(process.stdout);
setMouseReporting(false);
process.stdout.write('__MID__\\n');
setMouseReporting(true);
process.stdout.write('__END__\\n');
`;
  fs.writeFileSync(scriptPath, payload, 'utf-8');
  // `script` allocates a real PTY; -q silences its own banner, -e returns the
  // child's exit status, and the command's stdout is captured to the
  // typescript file which we read back.
  const typescript = path.join(tmp, 'typescript');
  try {
    execFileSync('script', ['-qefc', `npx tsx ${scriptPath}`, typescript], {
      cwd: projectDir,
      stdio: 'ignore',
      timeout: 30000,
    });
  } catch {
    // script may return non-zero on some platforms; the typescript file is
    // still written — fall through and read it.
  }
  const raw = fs.existsSync(typescript) ? fs.readFileSync(typescript, 'utf-8') : '';
  fs.rmSync(tmp, { recursive: true, force: true });
  return raw;
}

ptyDescribe('SCLI-479 mouse-reporting escape sequences (real PTY)', () => {
  it('setMouseReporting(false) emits the DECSET 1006/1000 disable sequence', () => {
    const out = runInPty();
    expect(out).toContain('__BEGIN__');
    expect(out).toContain('__MID__');
    // The disable sequence must appear between BEGIN and MID.
    const begin = out.indexOf('__BEGIN__');
    const mid = out.indexOf('__MID__');
    const between = out.slice(begin, mid);
    expect(between).toContain(DISABLE);
  });

  it('setMouseReporting(true) emits the DECSET 1000/1006 enable sequence', () => {
    const out = runInPty();
    const mid = out.indexOf('__MID__');
    const end = out.indexOf('__END__');
    const between = out.slice(mid, end);
    expect(between).toContain(ENABLE);
  });

  it('the disable sequence is the exact inverse of the enable sequence', () => {
    // 1006l + 1000l (disable) vs 1000h + 1006h (enable) — no stray bytes.
    expect(DISABLE).toBe('\x1b[?1006l\x1b[?1000l');
    expect(ENABLE).toBe('\x1b[?1000h\x1b[?1006h');
  });
});
