/**
 * SCLI-410 e2e — real CLI subprocess boundary.
 *
 * Unit coverage lives in `tests/cli/exec-channel.test.ts`; this file proves the
 * contract at the actual `dist/shizuha.js` process boundary for the FAILURE
 * path (deterministic without a live model: an unresolvable provider aborts the
 * run before any network call). Success-path byte-empty stderr was verified live
 * with a real model (see the SCLI-410 task); the success channel behaviour is
 * pinned deterministically by the unit suite.
 *
 * Failure-preservation contract under test:
 *  - root `shizuha -p` and `shizuha exec -p` each exit nonzero;
 *  - stderr is non-empty and carries a user-actionable diagnostic
 *    (NOT raw pino telemetry and NOT model reasoning);
 *  - the logger's default file sink keeps raw telemetry OFF stderr.
 *
 * Plus a source-level guard: both index.ts entrypoints route through ONE shared
 * `writeExecEvent` binding imported from src/cli/exec-channel.js — a future
 * re-split into two independent quiet paths fails this test.
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
const INDEX = path.join(projectDir, 'src', 'index.ts');
// SCLI-384 fail-closed prefix. An unprefixed id is treated as a default-provider
// model and can hang on a network turn — the slash form is what aborts before
// any request (see ProviderRegistry unknown-prefix throw).
const UNRESOLVABLE_MODEL = 'scli410-no-such-provider-xyz/unused';

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], home: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec('node', [CLI, ...args], {
      cwd: projectDir,
      env: { ...process.env, HOME: home, FORCE_COLOR: '0', SHIZUHA_LOG_LEVEL: 'info' },
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

function isPinoJson(line: string): boolean {
  // pino JSON records carry level/pid/hostname fields and a "msg" — the raw
  // telemetry that must NEVER reach default stderr.
  try {
    const obj = JSON.parse(line);
    return typeof obj === 'object' && obj !== null && 'pid' in obj && 'msg' in obj;
  } catch {
    return false;
  }
}

describe('SCLI-410 quiet stderr (failure-preservation at the process boundary)', () => {
  let emptyHome: string;

  beforeAll(() => {
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli410-e2e-'));
  });

  const failureMatrix = [
    ['root -p', ['-p', 'Return exactly MARKER_ABC', '--model', UNRESOLVABLE_MODEL]],
    ['exec -p', ['exec', '-p', 'Return exactly MARKER_ABC', '--model', UNRESOLVABLE_MODEL]],
    ['root -p --json', ['-p', 'Return exactly MARKER_ABC', '--model', UNRESOLVABLE_MODEL, '--json']],
    ['exec -p --json', ['exec', '-p', 'Return exactly MARKER_ABC', '--model', UNRESOLVABLE_MODEL, '--json']],
  ] as const;

  describe.skipIf(!fs.existsSync(CLI))('built CLI', () => {
    for (const [label, args] of failureMatrix) {
      it(`${label} fails with nonzero exit + actionable stderr, no raw telemetry`, async () => {
        const r = await runCli([...args], emptyHome);

        // Failure-preservation: nonzero exit + non-empty stderr.
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr.length).toBeGreaterThan(0);

        // Stderr is a user-actionable diagnostic, not raw logger JSON.
        const lines = r.stderr.split('\n');
        expect(lines.some((l) => isPinoJson(l) || l.includes('"pid":') || l.includes('"level":'))).toBe(false);
        // ... and not model reasoning.
        expect(r.stderr).not.toContain('\x1b[2m');
        // The diagnostic names the failing model — actionable.
        expect(r.stderr.toLowerCase()).toContain('error');
        expect(r.stderr).toContain(UNRESOLVABLE_MODEL);
      });
    }
  });

  it('index.ts routes BOTH -p and exec through ONE shared writeExecEvent binding', () => {
    const src = fs.readFileSync(INDEX, 'utf8');
    // Single import of the shared contract.
    expect(src).toMatch(/import\s*\{[^}]*\bwriteExecEvent\b[^}]*\}\s*from\s*'\.\/cli\/exec-channel\.js'/);
    // writeExecEvent must never be redeclared locally (a re-split fails this).
    expect(src.match(/^function writeExecEvent\b/gm) ?? []).toHaveLength(0);
    // Both the root -p loop and the exec loop call that shared binding.
    const callSites = src.match(/writeExecEvent\(event, isJSON, acc\)/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
    // One imported binding name used in both entrypoints.
    expect(src.match(/import\s*\{[^}]*\bwriteExecEvent\b/g)).toHaveLength(1);
  });
});
