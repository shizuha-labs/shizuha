import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// SCLI-6xx regression (operator 2026-09-18): the SCLI activity log must be
// mirrorable to stdout (stamped src:"scli") so the fleet's alloy/Loki pipeline
// captures it permanently. The in-pod shizuha.log lives in an emptyDir and
// dies at hibernation — the agent-log-inspection line-by-line doctrine needs
// evidence for hibernated seats too. Gated by SCLI_LOG_STDOUT_MIRROR=1; local
// TUI sessions (no env) must NOT write log lines to stdout.

// Runs a child node process that creates the default logger with a temp HOME,
// emits one log record, and prints captured stdout as the result JSON.
function runLogger(mirror: boolean): { stdout: string; fileLine: string | null } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-log-mirror-'));
  const script = `
    process.env.HOME = ${JSON.stringify(home)};
    process.env.SCLI_LOG_STDOUT_MIRROR = ${mirror ? "'1'" : "''"};
    const { createDefaultLogger } = await import('${path.resolve('src/utils/logger.ts')}');
    const logger = createDefaultLogger('info');
    logger.info({ event: 'mirror-probe', k: 'v' }, 'probe message');
    await new Promise(r => setTimeout(r, 150));
    process.stdout.write('\\nMIRROR-DONE');
  `;
  const stdout = execFileSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, HOME: home },
  });
  const logFile = path.join(home, '.config', 'shizuha', 'logs', 'shizuha.log');
  const fileLine = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').pop() ?? null
    : null;
  return { stdout, fileLine };
}

describe('SCLI log stdout mirror (SCLI-6xx)', () => {
  it('mirrors log lines to stdout stamped src:"scli" when enabled', () => {
    const { stdout, fileLine } = runLogger(true);
    expect(stdout).toContain('MIRROR-DONE');
    const mirrored = stdout.split('\n').find((l) => l.startsWith('{') && l.includes('mirror-probe'));
    expect(mirrored).toBeTruthy();
    const parsed = JSON.parse(mirrored!);
    expect(parsed.src).toBe('scli');
    expect(parsed.msg).toBe('probe message');
    // The file copy is the source of truth — unchanged shape (no src stamp needed there).
    expect(fileLine).toBeTruthy();
    expect(JSON.parse(fileLine!).msg).toBe('probe message');
  });

  it('does not write log lines to stdout when the mirror is off (local TUI safety)', () => {
    const { stdout } = runLogger(false);
    expect(stdout).toContain('MIRROR-DONE');
    expect(stdout.includes('mirror-probe')).toBe(false);
  });
});
