// SCLI-520 regression: `pulse help list surplus` must reject the surplus
// operand instead of silently printing `pulse list` help and exiting 0.
// Drives the BUILT CLI (dist/shizuha.js) so the test runs through the public
// CLI parser boundary, not a private helper.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli520-home-'));
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, TMPDIR: home },
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('pulse help operand contract (SCLI-520)', () => {
  it('runs against the built CLI (public parser boundary)', () => {
    if (!fs.existsSync(CLI)) {
      // CI builds dist before the suite; skip with a clear message if absent.
      expect.fail(`node bundle missing at ${CLI}; run 'npm run build:node'`);
    }
    expect(fs.existsSync(CLI)).toBe(true);
  });

  it('rejects a surplus operand after a resolved help target', () => {
    const r = runCli(['pulse', 'help', 'list', 'surplus']);
    expect(r.status).not.toBe(0);
    // Specific unexpected-argument diagnostic, not a bare help page.
    expect(r.stderr).toMatch(/too many arguments for 'help'/i);
    expect(r.stderr).toMatch(/surplus|Expected 1 argument/i);
  });

  it('rejects two-or-more surplus operands', () => {
    const r = runCli(['pulse', 'help', 'list', 'a', 'b']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/too many arguments for 'help'/i);
  });

  it('keeps `pulse help list` a valid exit-0 control', () => {
    const r = runCli(['pulse', 'help', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: shizuha pulse list/i);
  });

  it('keeps bare `pulse help` exit 0', () => {
    const r = runCli(['pulse', 'help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage:/i);
  });

  it('keeps `pulse list --help` and `pulse --help` exit 0', () => {
    expect(runCli(['pulse', 'list', '--help']).status).toBe(0);
    expect(runCli(['pulse', '--help']).status).toBe(0);
  });

  it('stays fail-closed for explicit-empty and whitespace-only targets', () => {
    for (const target of ['', ' ', '\t', 'list ', ' list']) {
      const r = runCli(['pulse', 'help', target]);
      expect(r.status).not.toBe(0);
    }
  });

  it('rejects an unknown help target', () => {
    const r = runCli(['pulse', 'help', 'definitely-not-a-command']);
    expect(r.status).not.toBe(0);
  });
});
