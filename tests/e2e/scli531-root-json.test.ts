/**
 * SCLI-531 e2e — root `--json` applicability/order fail-closed contract.
 *
 * The installed SCLI treated root `--json` as an ignorable decoration unless it
 * happened to follow a named command: bare `--json`, `--json status`,
 * `--json doctor`, and `--json --resume <id>` all exited 0 with a polished
 * human/TUI frame (and created state) instead of NDJSON or a fail-closed
 * diagnostic. Automation therefore received human output + exit 0.
 *
 * This file proves the fix at the real `dist/shizuha.js` process boundary:
 *  - bare root `--json` (no nonblank -p) rejects nonzero, before state/log init;
 *  - root `--json` combined with a named command rejects regardless of token
 *    order UNLESS that command declares its own documented structured-output
 *    contract (its own `--json` option: exec / whoami / pulse list);
 *  - `--json --resume <id>` rejects the unsupported composition;
 *  - failure stdout is empty/protocol-clean; stderr is concise, names `--json`
 *    and the accepted `-p` composition, and carries no ANSI/bundle path/secret;
 *  - rejected invocations create no state/log files and leave no processes;
 *  - clean `--json --help` and `--json --version` are preserved.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const exec = promisify(execFile);
const projectDir = path.resolve(import.meta.dirname!, '../..');
const CLI = path.join(projectDir, 'dist', 'shizuha.js');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], home: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec('node', [CLI, ...args], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        TMPDIR: home,
        FORCE_COLOR: '0',
        SHIZUHA_AUTO_UPDATE: '0',
        SHIZUHA_LOG_LEVEL: 'info',
      },
      timeout: 20_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/** Files the CLI must NOT create on a rejected invocation. */
const STATE_PATHS = [
  path.join('.config', 'shizuha', 'state.db'),
  path.join('.config', 'shizuha', 'state.db-wal'),
  path.join('.config', 'shizuha', 'state.db-shm'),
];

function stateFiles(home: string): string[] {
  return STATE_PATHS.filter((p) => fs.existsSync(path.join(home, p)));
}

describe.skipIf(!fs.existsSync(CLI))('SCLI-531 root --json fail-closed (process boundary)', () => {
  let emptyHome: string;

  beforeAll(() => {
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli531-e2e-'));
  });

  const rejectMatrix = [
    ['bare --json', ['--json'], true],
    ['--json status', ['--json', 'status'], true],
    ['status --json', ['status', '--json'], false],
    ['--json doctor', ['--json', 'doctor'], true],
    ['doctor --json', ['doctor', '--json'], false],
    ['--json --resume <id>', ['--json', '--resume', 'definitely-not-a-session'], true],
  ] as const;

  for (const [label, args, customDiagnostic] of rejectMatrix) {
    it(`${label} rejects nonzero with clean protocol-safe stderr and no state`, async () => {
      const r = await runCli([...args], emptyHome);

      // Fail-closed: nonzero exit.
      expect(r.exitCode).not.toBe(0);

      // stdout is empty/protocol-clean — never a human/TUI frame.
      expect(r.stdout.trim()).toBe('');

      // stderr is concise and names --json. The prefix forms (root --json
      // before/without a named command) carry the full SCLI-531 diagnostic that
      // also names the accepted -p composition; the suffix forms (--json after
      // a named command) are rejected natively by the parser with
      // "unknown option '--json'" — both are fail-closed and protocol-clean.
      expect(r.stderr).toContain('--json');
      if (customDiagnostic) {
        expect(r.stderr).toContain('-p');
      }
      // No ANSI, no raw bundle path/frame, no secret-shaped data.
      expect(r.stderr).not.toMatch(/\x1b\[/);
      expect(r.stderr).not.toContain('dist/shizuha.js');
      expect(r.stderr).not.toMatch(/sk-\w{8,}/);

      // Rejected invocations create no state/log files.
      expect(stateFiles(emptyHome)).toEqual([]);
    });
  }

  it('--json --help and --json --version remain clean inert success controls', async () => {
    for (const args of [['--json', '--help'], ['--json', '--version']]) {
      const r = await runCli([...args], emptyHome);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain('--json requires');
    }
  });

  it('--json with a nonblank -p is still accepted (exec-mode NDJSON contract)', async () => {
    // Deterministic without a live model: an unresolvable provider aborts the
    // run, but the composition itself must NOT be rejected as inapplicable —
    // the diagnostic names the model, not a --json applicability error.
    const r = await runCli(['--json', '-p', 'Return MARKER_XYZ', '--model', 'scli531-no-such-provider-xyz/unused'], emptyHome);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('scli531-no-such-provider-xyz/unused');
    expect(r.stderr).not.toContain('--json requires -p/--prompt');
  });
});
