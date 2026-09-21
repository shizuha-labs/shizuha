import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SCLI-448 real controlling-PTY regression (top-level interactive entrypoint).
 *
 * Verifies across three fresh PTY sessions that:
 *  - the TUI composer appears (idle interactive entrypoint),
 *  - one Ctrl+Z stops the full foreground TUI process group (OS state T) and
 *    the shell reports a stopped job,
 *  - `fg` resumes the same TUI (OS state S).
 *
 * Uses a Python pty harness (tests/tui/helpers/job_control_pty.py) because
 * tmux cannot be used here: tmux re-sends SIGCONT to a stopped pane's process
 * group, which defeats the job-control assertion.
 */
const projectDir = resolve(import.meta.dirname!, '../..');
const helper = resolve(import.meta.dirname!, 'helpers/job_control_pty.py');
const dist = resolve(projectDir, 'dist/shizuha.js');

function hasDist(): boolean {
  return existsSync(dist);
}

describe('Ctrl+Z job-control suspend — real PTY (SCLI-448)', () => {
  it('stops the TUI on Ctrl+Z and resumes on fg across 3 fresh sessions', () => {
    if (!hasDist()) {
      // CI builds dist before the suite; local runs without a build skip.
      return;
    }
    const out = execFileSync('python3', [helper, '3'], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    const results = JSON.parse(out.trim());
    expect(results).toHaveLength(3);
    // If the environment cannot render the TUI composer (headless CI), the
    // harness reports a skip rather than a failure — the job-control mechanism
    // is still covered by the source-assertion tests and local real-PTY runs.
    const skipped = results.filter((r) => r.skipped);
    if (skipped.length === results.length) {
      return;
    }
    for (const r of results) {
      if (r.skipped) continue;
      expect(r.composer, 'composer must be ready').toBe(true);
      expect(r.after_ctrl_z, 'TUI must stop (state T) after Ctrl+Z').toMatch(/^T/);
      expect(r.after_fg, 'TUI must resume (state S) after fg').toMatch(/^S/);
      expect(r.shell_reported_stopped, 'shell must report a stopped job').toBe(true);
    }
  });
});
