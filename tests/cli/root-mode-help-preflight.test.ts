// SCLI-580 regression: root `--mode` must reject invalid/blank values even when
// combined with `--help` in either order — commander's built-in help used to
// exit 0 before the root action ran, masking an invalid permission mode as
// success.
//
// Drives the BUILT CLI (dist/shizuha.js) so the regression exercises the actual
// public boundary. Requires the node bundle; CI builds it before the suite.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'shizuha.js');

const VALID_MODES = ['plan', 'supervised', 'autonomous'];
const INVALID_MODES = [
  'definitely-invalid',
  'Autonomous', // case variant
  'PLAN',
  'plan\n', // embedded newline
];

function runRoot(args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli580-'));
  return spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TERM: 'dumb',
      SHIZUHA_DISABLE_TELEMETRY: '1',
    },
    encoding: 'utf8',
    timeout: 20000,
  });
}

describe('root --mode preflight with --help (SCLI-580)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`node bundle missing at ${CLI}; run 'npm run build:node'`);
    }
  });

  it('rejects invalid --mode combined with --help (mode first)', () => {
    for (const bad of INVALID_MODES) {
      const r = runRoot(['--mode', bad, '--help']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Invalid --mode');
      expect(r.stderr).toContain(bad.trim());
      expect(r.stderr).not.toMatch(/TypeError|stack|node:internal/i);
    }
  });

  it('rejects invalid --mode combined with --help (help first)', () => {
    for (const bad of INVALID_MODES) {
      const r = runRoot(['--help', '--mode', bad]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Invalid --mode');
      expect(r.stderr).not.toMatch(/TypeError|stack|node:internal/i);
    }
  });

  it('rejects blank/whitespace --mode combined with --help', () => {
    for (const blank of ['', '   ', '\t', '\n']) {
      const r = runRoot(['--mode', blank, '--help']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Invalid --mode');
    }
  });

  it('rejects equals-form invalid --mode combined with --help', () => {
    const r = runRoot(['--mode=definitely-invalid', '--help']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid --mode');
  });

  it('accepts documented modes combined with --help (exit 0, help shown)', () => {
    for (const mode of VALID_MODES) {
      const r = runRoot(['--mode', mode, '--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage: shizuha');
    }
  });

  it('accepts --help alone (no mode) and subcommand help without regression', () => {
    const rootHelp = runRoot(['--help']);
    expect(rootHelp.status).toBe(0);
    expect(rootHelp.stdout).toContain('Usage: shizuha');

    const execHelp = runRoot(['exec', '--help']);
    expect(execHelp.status).toBe(0);
    expect(execHelp.stdout).toContain('Usage: shizuha exec');
  });

  it('still rejects unknown options and missing --mode value cleanly', () => {
    const unknown = runRoot(['--unknown-opt']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unknown option '--unknown-opt'");
    expect(unknown.stderr).not.toMatch(/TypeError|stack|node:internal/i);

    const missing = runRoot(['--mode']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("option '--mode <mode>' argument missing");
  });
});
